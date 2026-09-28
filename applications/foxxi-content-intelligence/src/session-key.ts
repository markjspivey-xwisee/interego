/**
 * A session key: a key a wallet lets one browser tab sign this bridge's requests with, as the
 * wallet, for a while.
 *
 * ★ WHY. A signed request is signed by its actor's own key (the DIRECT branch). A person whose key
 * stays in a wallet extension approved every request in the wallet: every step they played,
 * every fragment they wrote, every read of their own work. Now the wallet approves one grant. The
 * tab makes a fresh key and keeps it in memory, and signs that tab's requests with it until the
 * grant expires.
 *
 * ★ THE GRANT IS A SIGN-IN WITH ETHEREUM MESSAGE (EIP-4361), so a wallet reads it as one and
 * checks it: the page asking must be the `domain` the message names. A bridge takes a grant only
 * from the domains it serves a dashboard on (FOXXI_DASHBOARD_ORIGIN). So a page elsewhere that
 * talks a person into signing one mints nothing this bridge takes, unless it names this bridge's
 * dashboard, which a wallet warns about. The key's address is in the message (its statement and
 * its one resource), and so are the bridge it is for (URI), when it was made and when it expires.
 *
 * ★ STATELESS, AND CLOSED ON ANY DOUBT. The bridge keeps no session. Each request carries its
 * grant (`_session`, beside the signed payload), and every check is made again:
 * - the grant's signature, by the wallet it names;
 * - this bridge as its audience, and an allowed domain;
 * - not expired, not made in the future, and no longer than the bridge allows;
 * - the request signed by the key it names, and made as the wallet itself: `agent_id` is the
 *   wallet's did:ethr. A session key never acts through a delegation.
 * A grant that fails any check refuses the request; it never falls back to reading the envelope as
 * signed some other way.
 *
 * Browser-safe (ethers only), so the dashboard builds the message with the same function.
 */
import { ethers } from 'ethers';

/** What a wallet grants: this key may sign requests on `audience` as `actor`, until `expiresAt`. */
export interface SessionKeyGrant {
  /** The host of the page that asked the wallet (EIP-4361 `domain`): a dashboard of this bridge. */
  domain: string;
  /** The wallet's address: who the key signs as. */
  actor: string;
  /** The session key's address. */
  key: string;
  /** The bridge's origin (EIP-4361 `URI`): the only bridge the key signs for. */
  audience: string;
  /** ISO 8601 instants. */
  issuedAt: string;
  expiresAt: string;
  /** At least eight letters and digits, fresh per grant. */
  nonce: string;
  /** The wallet's EIP-191 signature over sessionKeyMessage(grant). */
  signature: string;
}

/** What a bridge takes: its own origin, the dashboard hosts it serves, and how long a grant may run. */
export interface SessionKeyPolicy {
  audience: string;
  domains: ReadonlyArray<string>;
  maxTtlMs: number;
}

/** EIP-4361 asks for a chain; a grant is chain-independent, so it names mainnet. */
export const SESSION_KEY_CHAIN_ID = 1;
/** How far ahead of the bridge's clock a grant may say it was made. */
const CLOCK_SKEW_MS = 60_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/**
 * An EIP-4361 domain: an authority (a host, and a port if any) exactly as a page's `location.host`
 * gives it, IPv6 literals included (Codex, on #545: `[::1]:5173` was refused though the policy
 * published it). Parsed as a URL's authority, it must come back exactly as it went in: a URL parser
 * drops a line break or tab, and reads a path, query, fragment or user info out of the host, so a
 * domain carrying any of them comes back otherwise, and nothing can break the message's lines.
 */
function isAuthority(domain: string): boolean {
  if (!domain) return false;
  try { return new URL(`http://${domain}`).host === domain.toLowerCase(); } catch { return false; }
}
const NONCE = /^[A-Za-z0-9]{8,64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** An origin as the bridge compares it: scheme, host and port, lowercased, no path. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch { return null; }
}

/** The text the wallet signs: an EIP-4361 message, built from the grant's fields and nothing else. */
export function sessionKeyMessage(g: Omit<SessionKeyGrant, 'signature'>): string {
  const key = ethers.getAddress(g.key);
  return [
    `${g.domain} wants you to sign in with your Ethereum account:`,
    ethers.getAddress(g.actor),
    '',
    `Let this browser tab's session key ${key} sign Foxxi requests as you on ${g.audience} until ${g.expiresAt}. The key never leaves the tab.`,
    '',
    `URI: ${g.audience}`,
    'Version: 1',
    `Chain ID: ${SESSION_KEY_CHAIN_ID}`,
    `Nonce: ${g.nonce}`,
    `Issued At: ${g.issuedAt}`,
    `Expiration Time: ${g.expiresAt}`,
    'Resources:',
    `- urn:foxxi:session-key:${key}`,
  ].join('\n');
}

export type SessionKeyCheck =
  | { ok: true; actor: string; key: string }
  | { ok: false; reason: string };

/** Whether a grant lets its key sign as its actor on this bridge now: every check, in full, each time. */
export function checkSessionKeyGrant(grant: unknown, policy: SessionKeyPolicy, now: number = Date.now()): SessionKeyCheck {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return { ok: false, reason: 'the session grant is not an object' };
  const g = grant as Record<string, unknown>;
  for (const f of ['domain', 'actor', 'key', 'audience', 'issuedAt', 'expiresAt', 'nonce', 'signature'] as const) {
    if (typeof g[f] !== 'string') return { ok: false, reason: `the session grant has no ${f}` };
  }
  const s = g as unknown as SessionKeyGrant;
  if (!ADDRESS.test(s.actor) || !ADDRESS.test(s.key)) return { ok: false, reason: 'the session grant names an actor or key that is not an address' };
  if (!isAuthority(s.domain)) return { ok: false, reason: 'the session grant names no domain' };
  if (!NONCE.test(s.nonce)) return { ok: false, reason: 'the session grant nonce is not eight to sixty-four letters and digits' };
  if (!INSTANT.test(s.issuedAt) || !INSTANT.test(s.expiresAt)) return { ok: false, reason: 'the session grant times are not UTC instants' };
  const audience = originOf(s.audience);
  if (!audience || audience !== s.audience || audience !== originOf(policy.audience)) {
    return { ok: false, reason: `the session grant is for ${s.audience}, not this bridge (${policy.audience})` };
  }
  if (!policy.domains.includes(s.domain.toLowerCase())) {
    return { ok: false, reason: `the session grant was asked for on ${s.domain}, which is not a dashboard of this bridge` };
  }
  const issued = Date.parse(s.issuedAt);
  const expires = Date.parse(s.expiresAt);
  if (!(expires > now)) return { ok: false, reason: 'the session grant has expired' };
  if (issued > now + CLOCK_SKEW_MS) return { ok: false, reason: 'the session grant says it was made in the future' };
  if (!(expires > issued) || expires - issued > policy.maxTtlMs) {
    return { ok: false, reason: `the session grant runs longer than this bridge allows (${Math.round(policy.maxTtlMs / 60_000)} minutes)` };
  }
  let signer: string;
  try { signer = ethers.verifyMessage(sessionKeyMessage(s), s.signature); }
  catch (e) { return { ok: false, reason: `the session grant signature could not be read: ${(e as Error).message}` }; }
  if (signer.toLowerCase() !== s.actor.toLowerCase()) return { ok: false, reason: 'the session grant was not signed by the wallet it names' };
  return { ok: true, actor: ethers.getAddress(s.actor), key: ethers.getAddress(s.key) };
}

let policy: SessionKeyPolicy | null = null;

/** Set what this process takes (the bridge, at start), or null to take no session keys. None until set. */
export function acceptSessionKeys(p: SessionKeyPolicy | null): void {
  policy = p ? { audience: p.audience, domains: p.domains.map(d => d.toLowerCase()), maxTtlMs: p.maxTtlMs } : null;
}

/** What this process takes: null when it takes no session keys. */
export function sessionKeyPolicy(): SessionKeyPolicy | null { return policy; }

/** The policy a bridge serves on: its own origin, and the hosts of the dashboard origins it allows. */
export function sessionKeyPolicyFor(bridgeBaseUrl: string, dashboardOrigins: Iterable<string>, maxTtlMs: number): SessionKeyPolicy | null {
  const audience = originOf(bridgeBaseUrl);
  if (!audience) return null;
  const domains = [...dashboardOrigins].map(o => { try { return new URL(o).host.toLowerCase(); } catch { return ''; } }).filter(Boolean);
  return { audience, domains, maxTtlMs };
}
