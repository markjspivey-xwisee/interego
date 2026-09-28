/**
 * A session key for a wallet-extension session (src/session-key.ts says what a bridge takes).
 *
 * A request signed in a wallet extension was one approval in the wallet. Where a bridge takes
 * session keys for this page, the tab makes a key and the wallet approves one grant for it: an
 * EIP-4361 message naming this page, the bridge, the key, and an hour at most. The tab then signs
 * that bridge's requests with the key until the grant is nearly spent, and asks again.
 *
 * The key lives in this tab's memory only. A reload or a sign-out forgets it, and nothing else can
 * sign with it. A bridge that does not publish a policy for this page (an older one, or one this
 * page is not a dashboard of) is signed for by the wallet, request by request, as before.
 */
import { ethers } from 'ethers';
import { originOf, sessionKeyMessage, type SessionKeyGrant } from '../../../src/session-key.js';
import type { MessageSigner } from './session-token.js';

/** What a bridge says it takes, as its /.well-known/foxxi-session-key answers. */
export interface SessionKeyPolicyDoc { audience: string; domains: string[]; maxTtlSeconds: number }

/** A key this tab signs with, and the grant that lets it. */
export interface Session { key: MessageSigner; grant: SessionKeyGrant }

/** How long a grant is asked for, unless the bridge allows less. */
const GRANT_MS = 60 * 60 * 1000;
/** A grant this close to its end is renewed rather than used. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

const policies = new Map<string, Promise<SessionKeyPolicyDoc | null>>();
const sessions = new Map<string, Session>();
const asking = new Map<string, Promise<Session | null>>();
/** Moves on at every sign-out: a grant asked for before it is not kept after it. */
let generation = 0;

/** Where this page is: the EIP-4361 domain a wallet checks the grant against. */
function pageHost(): string | undefined {
  return (globalThis as { location?: { host?: string } }).location?.host || undefined;
}

/**
 * What the bridge at `audience` takes from this page, read once per page. Null when it publishes no
 * policy, names another audience, or does not list this page's host.
 */
export function sessionKeyPolicyAt(audience: string, host: string | undefined = pageHost(), fetchImpl: typeof fetch = globalThis.fetch): Promise<SessionKeyPolicyDoc | null> {
  const k = `${audience} ${host ?? ''}`;
  let p = policies.get(k);
  if (!p) {
    p = (async () => {
      if (!host) return null;
      try {
        const r = await fetchImpl(`${audience}/.well-known/foxxi-session-key`, { headers: { Accept: 'application/json' } });
        if (!r.ok) return null;
        const doc = await r.json() as Partial<SessionKeyPolicyDoc>;
        const ok = doc.audience === audience && Array.isArray(doc.domains) && doc.domains.includes(host.toLowerCase())
          && typeof doc.maxTtlSeconds === 'number' && doc.maxTtlSeconds > 0;
        return ok ? { audience, domains: doc.domains!, maxTtlSeconds: doc.maxTtlSeconds! } : null;
      } catch { return null; }
    })();
    policies.set(k, p);
  }
  return p;
}

/**
 * A session for `wallet` on the bridge at `audience`: the one this tab holds while it has more than
 * a few minutes left, or a new one the wallet grants, asked once however many requests wait for it.
 * Null when the bridge takes no session keys from this page: the wallet then signs each request.
 */
export async function sessionFor(wallet: MessageSigner, audienceUrl: string, opts: { now?: () => number; host?: string; fetchImpl?: typeof fetch } = {}): Promise<Session | null> {
  const audience = originOf(audienceUrl);
  if (!audience) return null;
  const now = opts.now ?? Date.now;
  const k = `${wallet.address.toLowerCase()} ${audience}`;
  const held = sessions.get(k);
  if (held && Date.parse(held.grant.expiresAt) - now() > RENEW_BEFORE_MS) return held;
  const pending = asking.get(k);
  if (pending) return pending;
  const asked = generation;
  const ask = (async (): Promise<Session | null> => {
    const host = opts.host ?? pageHost();
    const policy = await sessionKeyPolicyAt(audience, host, opts.fetchImpl);
    if (!policy || !host) return null;
    const key = ethers.Wallet.createRandom();
    const at = now();
    const body = {
      domain: host.toLowerCase(), actor: ethers.getAddress(wallet.address), key: key.address, audience,
      issuedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + Math.min(GRANT_MS, policy.maxTtlSeconds * 1000)).toISOString(),
      nonce: ethers.hexlify(ethers.randomBytes(16)).slice(2),
    };
    const grant: SessionKeyGrant = { ...body, signature: await wallet.signMessage(sessionKeyMessage(body)) };
    // Signed out while the wallet was asking (Codex, on #545): the grant is not kept for anyone.
    if (asked !== generation) return null;
    const session = { key, grant };
    sessions.set(k, session);
    return session;
  })();
  asking.set(k, ask);
  try { return await ask; } finally { if (asking.get(k) === ask) asking.delete(k); }
}

/** Whether `address` holds a session with time left on some bridge: its reads need not wait for a click. */
export function holdsSession(address: string, now: number = Date.now()): boolean {
  const who = `${address.toLowerCase()} `;
  for (const [k, s] of sessions) if (k.startsWith(who) && Date.parse(s.grant.expiresAt) - now > RENEW_BEFORE_MS) return true;
  return false;
}

/** Forget every session key this tab holds, and every policy it read: on sign-out. */
export function forgetSessionKeys(): void {
  generation++;
  sessions.clear();
  policies.clear();
  asking.clear();
}
