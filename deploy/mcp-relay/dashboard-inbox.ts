/** The account dashboard has an identity bearer, not a relay OAuth access token. */
import type { RequestHandler } from 'express';
import { discoverPage, type FetchFn } from '@interego/solid';

export interface InboxEntry {
  readonly descriptorUrl: string;
  readonly describes: readonly string[];
  readonly validFrom?: string;
  readonly modalStatus?: string;
  readonly trustLevel?: string;
  readonly supersedes?: readonly string[];
}
export function inboxMetadata(pod: string, entries: readonly InboxEntry[], since: string, limit: number) {
  const recent = entries.filter(e => !e.validFrom || e.validFrom >= since)
    .sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? '')).slice(0, limit);
  return { pod, window: { since, sortedBy: 'validFrom-desc', limit }, count: recent.length, totalOnPod: entries.length,
    hint: recent.length === 0
      ? 'No descriptors in this window. Try a wider since window.'
      : 'Items with an unfamiliar publisher may have been shared with you. Your key determines which content you can decrypt.',
    events: recent.map(e => ({ descriptorUrl: e.descriptorUrl, graphIris: e.describes, validFrom: e.validFrom,
      modalStatus: e.modalStatus, trustLevel: e.trustLevel, supersedes: e.supersedes })) };
}
export interface DashboardIdentity {
  readonly authenticated: boolean;
  readonly userId?: string;
  readonly provisionalPlay?: unknown;
  readonly scope?: string;
}
export interface DashboardInboxOptions {
  readonly identityOrigin: string;
  readonly cssUrl: string;
  readonly verifyIdentity: (header: string) => Promise<DashboardIdentity>;
  readonly fetch: FetchFn;
  readonly now?: () => number;
  /** A smaller isolated-test deadline is allowed; the production ceiling cannot be increased. */
  readonly readTimeoutMs?: number;
}
export const DASHBOARD_INBOX_MAX_BYTES = 128 * 1024;
export const DASHBOARD_INBOX_MAX_READ_BYTES = 16 * 1024 * 1024;
const DAY = 86_400_000;
const OWNER = /^[A-Za-z0-9_-]{1,200}$/;
const READ_SCOPES = new Set(['ReadWrite', 'ReadOnly', 'DiscoverOnly']);

/** Installed after the general CORS middleware and before its headers are frozen. */
export function dashboardInboxCors(identityOrigin: string): RequestHandler {
  const origin = new URL(identityOrigin).origin;
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.vary('Origin');
    if (req.headers.origin !== origin) { res.status(403).json({ error: 'dashboard_required' }); return; }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Accept');
    if (req.method === 'OPTIONS') {
      const headers = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (req.headers['access-control-request-method'] !== 'GET' || headers.some(header => !['authorization', 'accept'].includes(header))) { res.status(403).end(); return; }
      res.status(204).end(); return;
    }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); res.status(405).end(); return; }
    next();
  };
}

function ownerPod(css: URL, userId: unknown): URL {
  if (typeof userId !== 'string' || !OWNER.test(userId)) throw new Error('Invalid account owner');
  const pod = new URL(userId + '/', css);
  if (pod.origin !== css.origin || pod.pathname !== css.pathname + userId + '/' || pod.search || pod.hash) throw new Error('Invalid account pod');
  return pod;
}
function windowFor(query: Record<string, unknown>, now: number): { since: string; limit: number } | null {
  if (Object.keys(query).some(key => key !== 'since' && key !== 'limit')) return null;
  const limit = query['limit'] === undefined ? 20 : typeof query['limit'] === 'string' && /^[1-9][0-9]?$/.test(query['limit']) ? Number(query['limit']) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return null;
  const since = query['since'] ?? new Date(now - 7 * DAY).toISOString();
  if (typeof since !== 'string' || since.length !== 24 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(since)) return null;
  const instant = Date.parse(since);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== since || instant > now || instant < now - 366 * DAY) return null;
  return { since, limit };
}

/** No OAuth fallback: this separate read route accepts only identity-verified account sessions. */
export function dashboardInboxHandler(options: DashboardInboxOptions): RequestHandler {
  const origin = new URL(options.identityOrigin).origin;
  const css = new URL(options.cssUrl);
  if (!['http:', 'https:'].includes(css.protocol) || css.username || css.password || css.search || css.hash || !css.pathname.endsWith('/')) throw new Error('Configure a canonical pod store URL.');
  const timeoutMs = options.readTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error('The inbox deadline must not exceed fifteen seconds.');
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.vary('Origin');
    if (req.headers.origin !== origin) { res.status(403).json({ error: 'dashboard_required', title: 'Open your signed-in Interego account page to read this inbox.' }); return; }
    res.setHeader('Access-Control-Allow-Origin', origin);
    const window = windowFor(req.query as Record<string, unknown>, options.now?.() ?? Date.now());
    if (!window) { res.status(400).json({ error: 'invalid_inbox_window', title: 'Choose a limit from 1 to 50 and a UTC since date within the last year. Pod addresses are chosen by your account.' }); return; }
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length > 16_384 || /\s/.test(authorization.slice(7))) {
      res.status(401).json({ error: 'identity_session_required', title: 'Sign into your existing Interego account to read its inbox.' }); return;
    }
    const lifetime = new AbortController();
    const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
    let consumed = 0;
    const cancel = () => { lifetime.abort(); for (const reader of readers) void reader.cancel().catch(() => {}); };
    const active = () => { if (lifetime.signal.aborted) throw new Error('Inbox read cancelled'); };
    req.once('aborted', cancel); res.once('close', cancel);
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { cancel(); reject(new Error('Inbox deadline reached')); }, timeoutMs); });
    const operation = (async () => {
      const auth = await options.verifyIdentity(authorization);
      active();
      if (!auth.authenticated || !auth.userId) { res.status(401).json({ error: 'identity_session_ended', title: 'Your account session ended. Sign in with your existing credential.' }); return; }
      if (auth.provisionalPlay || !OWNER.test(auth.userId) || !READ_SCOPES.has(auth.scope ?? '')) { res.status(403).json({ error: 'account_read_required', title: 'This inbox requires an existing account session with permission to read metadata.' }); return; }
      const pod = ownerPod(css, auth.userId);
      // The substrate follows manifest archive links. Every hop remains inside this exact
      // owner pod, uses GET only, and refuses redirects before the storage transport runs.
      const privateRead: FetchFn = async (url, init) => {
        active();
        const target = new URL(url);
        if (target.origin !== pod.origin || !target.pathname.startsWith(pod.pathname) || target.search || target.hash
          || target.username || target.password || /%(?:2e|2f|5c)/i.test(target.pathname)
          || init?.method && init.method !== 'GET') throw new Error('Inbox read left its owner pod');
        const read = { method: 'GET', headers: { Accept: 'text/turtle' }, redirect: 'manual', signal: lifetime.signal } as const;
        const result = await options.fetch(target.href, read);
        const stream = (result as { body?: ReadableStream<Uint8Array> | null }).body;
        active();
        if (result.status >= 300 && result.status < 400) { await stream?.cancel(); throw new Error('Inbox redirects are not followed'); }
        const reported = result.headers?.get('content-length');
        if (reported && /^\d+$/.test(reported) && Number(reported) > DASHBOARD_INBOX_MAX_READ_BYTES - consumed) {
          await stream?.cancel(); cancel(); throw new Error('Inbox index exceeded its byte budget');
        }
        // Fail closed if a transport cannot expose a bounded stream. Never call an
        // unbounded text() fallback on authenticated metadata supplied by storage.
        if (!stream) throw new Error('Inbox transport did not provide a bounded stream');
        const reader = stream.getReader(); readers.add(reader); const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const chunk = await reader.read(); active(); if (chunk.done) break;
            consumed += chunk.value.byteLength;
            if (consumed > DASHBOARD_INBOX_MAX_READ_BYTES) { cancel(); throw new Error('Inbox index exceeded its byte budget'); }
            chunks.push(chunk.value);
          }
        } finally { readers.delete(reader); await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        return { ok: result.ok, status: result.status, statusText: result.statusText, headers: result.headers,
          text: async () => text, json: async () => JSON.parse(text) as unknown };
      };
      const page = await discoverPage(pod.href, undefined, { fetch: privateRead, readWindow: 50_000, readBudgetBytes: DASHBOARD_INBOX_MAX_READ_BYTES });
      active();
      if (page.bounded) throw new Error('Inbox index exceeded its read budget');
      const body = inboxMetadata(pod.href, page.entries, window.since, window.limit);
      if (Buffer.byteLength(JSON.stringify(body)) > DASHBOARD_INBOX_MAX_BYTES) throw new Error('Inbox metadata exceeded its response budget');
      // Do not return private metadata to a session revoked while the pod was being read.
      const current = await options.verifyIdentity(authorization);
      active();
      if (!current.authenticated || current.userId !== auth.userId || current.provisionalPlay || !READ_SCOPES.has(current.scope ?? '')) {
        res.status(401).json({ error: 'identity_session_ended', title: 'Your account session ended while reading its inbox. Sign in with your existing credential.' }); return;
      }
      res.json(body);
    })();
    void Promise.race([operation, expired]).catch(() => { if (!res.headersSent && !res.destroyed) res.status(503).json({ error: 'inbox_unavailable', title: 'Your inbox could not be read right now. Your signed-in account and PC-key verification are separate; try the inbox again later.' }); })
      .finally(() => { clearTimeout(timer); req.removeListener('aborted', cancel); res.removeListener('close', cancel); cancel(); });
  };
}
