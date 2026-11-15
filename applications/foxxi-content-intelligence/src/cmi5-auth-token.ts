/**
 * The auth-token a cmi5 launch hands its assignable unit, as a credential that carries its own proof.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * The token was a random string, and what it stood for (which tenant, which registration, which
 * session) was a row in a table held in the process. The launches themselves are kept on the pod
 * and read back at startup; that table was not. So every deploy of the bridge ended every practice
 * in progress: the launch came back, and the credential that says "this browser is that launch"
 * did not. The unit's next statement was answered 401, mid-conversation. On 2026-11-15 two deploys
 * within five minutes did that twice to one learner.
 *
 * So the token now says what it is for and is signed by the bridge: the tenant, the registration,
 * the session and when it stops being good, under an HMAC keyed by a secret only the bridge holds.
 * Nothing is stored for it, so a restart has nothing to lose. A process started with the same
 * secret reads the tokens the last one minted.
 *
 * It proves only that this bridge minted it for that session. Whether the launch still exists,
 * whose it is, and whether the session is still open are read from the launch record every time,
 * exactly as before: a token whose launch has been forgotten is good for nothing.
 *
 * What still ends a session at a restart: a bridge started with no secret (the key is then random
 * for the life of the process); a secret changed between the two processes, which ends every token
 * minted under the old one; and a launch that had not reached the pod when the process stopped.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a token is bound to. */
export interface Cmi5AuthTokenBinding {
  readonly tenant: string;
  readonly registration: string;
  readonly sessionId: string;
}

/** A session is one sitting. A token outlives a deploy, not the day after. */
export const CMI5_AUTH_TOKEN_TTL_MS = 24 * 60 * 60_000;

const PREFIX = 'cmi5v1.';
const MAX_TOKEN_LENGTH = 2048;

const mac = (body: string, key: Buffer): Buffer => createHmac('sha256', key).update(`foxxi-cmi5-auth-token\n${body}`).digest();

/** A token for one session of one launch, good until `expiresAt` (epoch milliseconds). */
export function mintCmi5AuthToken(binding: Cmi5AuthTokenBinding, key: Buffer, expiresAt: number): string {
  const body = Buffer.from(JSON.stringify({ t: binding.tenant, r: binding.registration, s: binding.sessionId, x: expiresAt }), 'utf8').toString('base64url');
  return `${PREFIX}${body}.${mac(body, key).toString('base64url')}`;
}

/**
 * What a token is bound to, or null: for a string that is not one of these tokens, one signed
 * under another key, one altered after it was signed, and one past its time.
 */
export function readCmi5AuthToken(token: string, key: Buffer, now: number): Cmi5AuthTokenBinding | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !token.startsWith(PREFIX)) return null;
  const parts = token.slice(PREFIX.length).split('.');
  if (parts.length !== 2) return null;
  const [body, carried] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(carried)) return null;
  const expected = mac(body, key);
  const given = Buffer.from(carried, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p['t'] !== 'string' || typeof p['r'] !== 'string' || typeof p['s'] !== 'string' || typeof p['x'] !== 'number') return null;
  if (!p['t'] || !p['r'] || !p['s'] || !Number.isFinite(p['x']) || p['x'] <= now) return null;
  return { tenant: p['t'], registration: p['r'], sessionId: p['s'] };
}
