/** Returning-user login at a trusted sibling RP. No enrollment or bearer crosses the RP. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

export interface ReturningPasskeyProof {
  userId: string; epoch: number;
  credential: { method: 'passkey'; id: string; publicKey: string; rpId: string; rpOrigin: string };
}
export interface ReturningPasskeyLoginDeps {
  identityOrigin: string; relayOrigin?: string; limiter: RequestHandler; pollLimiter?: RequestHandler;
  verify(response: AuthenticationResponseJSON, challenge: string, rpOrigin: string): Promise<ReturningPasskeyProof>;
  issue(proof: ReturningPasskeyProof, active: () => boolean): Promise<Record<string, unknown>>;
  now?: () => number;
}
export class ReturningPasskeyLoginError extends Error {
  constructor(readonly status = 401, readonly code = 'passkey_login_ended') {
    super('This sign-in could not be confirmed. Return to your account page and use your existing passkey again.');
  }
}
export const RETURNING_PASSKEY_COOKIE = '__Host-interego-passkey-login';
const TTL = 120_000, TOKEN = /^[A-Za-z0-9_-]{43}$/;
const random = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = () => new ReturningPasskeyLoginError();
function body(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new ReturningPasskeyLoginError(400, 'invalid_passkey_login');
  return value as Record<string, unknown>;
}
function capability(value: unknown, prefix: string) {
  const match = typeof value === 'string' && new RegExp('^' + prefix + ':([A-Za-z0-9_-]{43})\\.([A-Za-z0-9_-]{43})$').exec(value);
  if (!match) throw fail(); return { id: match[1]!, hash: hash(match[2]!) };
}
function cookie(req: Request): string | undefined {
  const header = req.headers.cookie; if (typeof header !== 'string' || header.length > 8192) return;
  const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(RETURNING_PASSKEY_COOKIE + '='));
  if (matches.length !== 1) return; const value = matches[0]!.slice(RETURNING_PASSKEY_COOKIE.length + 1);
  return TOKEN.test(value) ? hash(value) : undefined;
}
/** Conservative sibling configuration; the browser must also prove same-site and send its Strict cookie. */
export function returningPasskeyRelay(identityOrigin: string, relayOrigin?: string): string | undefined {
  try {
    const identity = new URL(identityOrigin), relay = new URL(relayOrigin!);
    if (identity.origin !== identityOrigin || relay.origin !== relayOrigin || identity.origin === relay.origin
      || identity.username || identity.password || relay.username || relay.password) return;
    const loopback = identity.protocol === 'http:' && relay.protocol === 'http:' && identity.hostname === '127.0.0.1' && relay.hostname === identity.hostname;
    if (loopback) return relay.origin;
    if (identity.protocol !== 'https:' || relay.protocol !== 'https:' || identity.port || relay.port) return;
    const parent = identity.hostname.split('.').slice(1).join('.');
    if (parent.split('.').length < 2 || relay.hostname.split('.').slice(1).join('.') !== parent) return;
    return relay.origin;
  } catch { return; }
}
type Login = { id: string; browserHash: string; receiptHash: string; challenge: string; expiresAt: number; rpHash?: string; completionHash?: string;
  phase: 'waiting' | 'claimed' | 'verifying' | 'verified' | 'issuing' | 'ended'; proof?: ReturningPasskeyProof };

export function mountReturningPasskeyLogin(app: Express, deps: ReturningPasskeyLoginDeps): void {
  const origin = new URL(deps.identityOrigin).origin, relay = returningPasskeyRelay(origin, deps.relayOrigin), now = deps.now ?? Date.now;
  const entries = new Map<string, Login>();
  const active = (entry: Login) => entries.get(entry.id) === entry && entry.expiresAt > now() && entry.phase !== 'ended';
  const end = (entry: Login) => { entry.phase = 'ended'; entry.proof = undefined; entries.delete(entry.id); };
  const prune = () => { for (const entry of entries.values()) if (!active(entry)) end(entry); };
  const setCookie = (res: Response, value: string) => res.append('Set-Cookie', `${RETURNING_PASSKEY_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${value ? 120 : 0}`);
  const browser = (req: Request) => {
    if (!relay || req.headers.origin !== origin || req.headers.authorization || !['same-origin', undefined].includes(req.headers['sec-fetch-site'] as string | undefined)) throw fail();
    if (req.headers.cookie?.split(';').some(part => part.trim().startsWith(RETURNING_PASSKEY_COOKIE + '=')) && !cookie(req)) throw fail();
  };
  const rp = (req: Request, res: Response) => {
    if (!relay || req.headers.origin !== relay || req.headers.authorization || req.headers['sec-fetch-site'] !== 'same-site') throw fail();
    // Only these assertion endpoints accept credentialed CORS. No owner bearer is ever returned here.
    res.setHeader('Access-Control-Allow-Origin', relay); res.setHeader('Access-Control-Allow-Credentials', 'true'); res.vary('Origin');
  };
  const owned = (req: Request, cap: { id: string; hash: string }, kind: 'rpHash' | 'completionHash' | 'receiptHash') => {
    const entry = entries.get(cap.id), browserHash = cookie(req);
    if (!entry || !active(entry) || !browserHash || !same(entry.browserHash, browserHash) || !entry[kind] || !same(entry[kind]!, cap.hash)) throw fail();
    return entry;
  };
  const route = (path: string, handler: (req: Request, res: Response) => Promise<void>, polling = false) => app.post('/local-identity/login/' + path, polling ? deps.pollLimiter ?? deps.limiter : deps.limiter, (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    void handler(req, res).catch(error => {
      if (res.headersSent) return; const known = error instanceof ReturningPasskeyLoginError;
      res.status(known ? error.status : 503).json({ error: known ? error.code : 'passkey_login_unavailable', message: fail().message });
    });
  });
  for (const path of ['context', 'complete']) app.options('/local-identity/login/' + path, (req, res) => {
    const headers = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
    if (!relay || req.headers.origin !== relay || req.headers['access-control-request-method'] !== 'POST' || headers.some(value => !['content-type', 'accept'].includes(value))) { res.status(403).end(); return; }
    res.setHeader('Access-Control-Allow-Origin', relay); res.setHeader('Access-Control-Allow-Credentials', 'true'); res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept'); res.vary('Origin'); res.status(204).end();
  });
  route('start', async (req, res) => {
    browser(req); body(req.body, []); prune();
    const previous = cookie(req); if (previous) for (const entry of entries.values()) if (same(entry.browserHash, previous)) end(entry);
    if (entries.size >= 256) throw new ReturningPasskeyLoginError(429, 'passkey_login_busy');
    const id = random(), browserSecret = random(), rpSecret = random(), receipt = random();
    const entry: Login = { id, browserHash: hash(browserSecret), rpHash: hash(rpSecret), receiptHash: hash(receipt), challenge: random(), expiresAt: now() + TTL, phase: 'waiting' };
    entries.set(id, entry); setCookie(res, browserSecret);
    res.json({ version: 1, identityOrigin: origin, expiresAt: new Date(entry.expiresAt).toISOString(),
      authorizationUrl: `${relay}/local-identity/sign-in#interego-login:v1:${id}.${rpSecret}`, receipt: `interego-login-receipt:v1:${id}.${receipt}` });
  });
  route('context', async (req, res) => {
    rp(req, res); const input = body(req.body, ['loginCode']); const entry = owned(req, capability(input['loginCode'], 'interego-login:v1'), 'rpHash');
    if (entry.phase !== 'waiting') throw fail(); entry.phase = 'claimed'; entry.rpHash = undefined;
    const secret = random(); entry.completionHash = hash(secret);
    res.json({ version: 1, purpose: 'returning-passkey-login', identityOrigin: origin, loginId: entry.id, expiresAt: new Date(entry.expiresAt).toISOString(),
      options: { challenge: entry.challenge, rpId: new URL(relay!).hostname, allowCredentials: [], userVerification: 'required', timeout: TTL },
      completionCode: `interego-login-result:v1:${entry.id}.${secret}` });
  });
  route('complete', async (req, res) => {
    rp(req, res); const input = body(req.body, ['completionCode', 'response']); const entry = owned(req, capability(input['completionCode'], 'interego-login-result:v1'), 'completionHash');
    if (entry.phase !== 'claimed') throw fail(); entry.phase = 'verifying'; entry.completionHash = undefined;
    try {
      const proof = await deps.verify(input['response'] as AuthenticationResponseJSON, entry.challenge, relay!);
      if (!active(entry) || entry.phase !== 'verifying') throw fail(); entry.proof = proof; entry.phase = 'verified'; res.json({ verified: true });
    } catch (error) { end(entry); throw error; }
  });
  route('result', async (req, res) => {
    browser(req); const input = body(req.body, ['receipt']); const entry = owned(req, capability(input['receipt'], 'interego-login-receipt:v1'), 'receiptHash');
    if (entry.phase === 'issuing') throw fail();
    if (entry.phase !== 'verified' || !entry.proof) { res.json({ state: 'waiting' }); return; }
    entry.phase = 'issuing';
    try {
      const result = await deps.issue(entry.proof, () => active(entry) && entry.phase === 'issuing');
      if (!active(entry) || entry.phase !== 'issuing') throw fail(); end(entry); setCookie(res, ''); res.json({ state: 'signed-in', ...result });
    } catch (error) { end(entry); throw error; }
  }, true);
  route('cancel', async (req, res) => {
    browser(req); const input = body(req.body, ['receipt']); const entry = owned(req, capability(input['receipt'], 'interego-login-receipt:v1'), 'receiptHash');
    end(entry); setCookie(res, ''); res.json({ cancelled: true });
  }, true);
}
