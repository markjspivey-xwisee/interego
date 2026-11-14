/**
 * The shared shape of a revocable, optionally expiring record.
 *
 * SCORM dispatch and a personal cmi5 launch link are different promises, and each keeps its own
 * records. What they share is the withdrawal: a record is live, withdrawn, or expired, and two
 * copies of one record keep the earlier withdrawal and the tighter expiry. The per-address limiter
 * and the durable-read check live here for the same reason. A course or an actor is never named.
 */
import type { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

export interface Withdrawable {
  readonly expiresAt?: string;
  revokedAt?: string;
}

export type WithdrawalState = 'live' | 'revoked' | 'expired';

/** Live, withdrawn, or expired. Anything further (a launch limit, a satisfied activity) is the caller's. */
export function withdrawalState(record: Withdrawable, now: number): WithdrawalState {
  if (record.revokedAt) return 'revoked';
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return 'expired';
  return 'live';
}

/** The earlier of two instants, when either is set. */
export function earlierMark(a?: string, b?: string): string | undefined {
  return [a, b].filter((x): x is string => !!x).sort()[0];
}

/** The later of two instants, when either is set. */
export function laterMark(a?: string, b?: string): string | undefined {
  return [a, b].filter((x): x is string => !!x).sort().at(-1);
}

/** An expiry beats none, and the earlier of two expiries stands. */
export function tighterExpiry(a?: string, b?: string): string | undefined {
  if (a && b) return a < b ? a : b;
  return a ?? b;
}

/**
 * What a read of a durable JSON registry means for the next write. `loaded` and `absent` may be
 * followed by a write. `failed` may not: this process has not seen what the pod holds, and writing
 * its own copy over that resource would drop every record it missed.
 */
export type DurableRegistryRead = 'loaded' | 'absent' | 'failed';

export async function readDurableRegistry(
  fetchResource: () => Promise<{ status: number; json(): Promise<unknown> }>,
  load: (json: unknown) => void,
): Promise<DurableRegistryRead> {
  try {
    const response = await fetchResource();
    if (response.status === 404) return 'absent';
    if (response.status < 200 || response.status >= 300) return 'failed';
    load(await response.json());
    return 'loaded';
  } catch {
    return 'failed';
  }
}

/**
 * A per-address fixed window. Wider than an agent's limit where one organization's learners share
 * an address, and no model is called.
 */
export function perAddressLimiter(max: number, windowMs: number, now: () => number = Date.now): (ip: string) => { ok: true } | { ok: false; retryAfterSeconds: number } {
  const seen = new Map<string, { count: number; resetAt: number }>();
  return (ip) => {
    const t = now();
    let entry = seen.get(ip);
    if (!entry || t > entry.resetAt) { entry = { count: 0, resetAt: t + windowMs }; seen.set(ip, entry); }
    if (seen.size > 10_000) for (const [k, v] of seen) if (v.resetAt < t) seen.delete(k);
    return ++entry.count > max ? { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) } : { ok: true };
  };
}

/**
 * A route limit keyed on the client, not the proxy. The last forwarded hop is the address the
 * bridge already treats as the client; `req.ip` behind that proxy is one shared bucket.
 */
export function forwardedRateLimit(opts: { windowMs: number; limit: number; identifier: string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    identifier: opts.identifier,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'too_many_requests' },
    // ipKeyGenerator still folds an IPv6 client to its subnet. The address is the forwarded hop.
    keyGenerator: (req) => ipKeyGenerator(requestAddress(req), 56),
    validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  });
}

/**
 * Write a registry only after its current durable copy was read or confirmed absent. A failed
 * read returns false and does not PUT.
 */
export async function commitDurableRegistry(opts: {
  resource: string;
  fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  load: (json: unknown) => void;
  /** Called after a successful read, so the body includes what the pod already held. */
  body: () => string;
}): Promise<boolean> {
  const read = await readDurableRegistry(
    async () => {
      const response = await opts.fetch(opts.resource, { headers: { Accept: 'application/json' } });
      return { status: response.status, json: () => response.json() };
    },
    opts.load,
  );
  if (read === 'failed') return false;
  const container = opts.resource.replace(/[^/]+$/, '');
  await opts.fetch(container, { method: 'PUT', headers: { 'Content-Type': 'text/turtle', Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' }, body: '' }).catch(() => undefined);
  const written = await opts.fetch(opts.resource, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: opts.body() });
  return written.ok;
}

/** The client address the bridge already decided, else the last hop of x-forwarded-for. */
export function requestAddress(req: Request): string {
  const decorated = req.body && typeof req.body === 'object' ? (req.body as { __client_ip?: unknown }).__client_ip : undefined;
  if (typeof decorated === 'string' && decorated.trim()) return decorated.trim().slice(0, 200);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',').at(-1)!.trim().slice(0, 200);
  if (Array.isArray(xff) && xff.length) return String(xff.at(-1)).trim().slice(0, 200);
  return (req.ip ?? 'unknown').slice(0, 200);
}
