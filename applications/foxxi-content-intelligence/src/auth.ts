/**
 * Foxxi bridge auth — real ECDSA-signed session tokens.
 *
 * The dashboard mints a session token by signing a canonical message
 * with the user's deterministic demo wallet (derived from a fixed seed +
 * userId hash). The bridge verifies the signature recovers an address
 * present in the published tenant directory, then sets caller_did to
 * that user's webId.
 *
 * No mock auth. The signature path uses real secp256k1; the verification
 * path uses real ECDSA recover. The demo-ness is in the wallet
 * provisioning: per-user keys are deterministic from a known seed so the
 * dashboard can sign without persisting private keys to localStorage,
 * and the bridge's "trusted address set" is the published directory
 * itself.
 *
 * In production each user has a real wallet (Ethereum, WebAuthn-derived,
 * or did:key) — the bridge then verifies against their published
 * auth-methods.jsonld instead of the demo seed-derived map. The signing/
 * verification flow does not change.
 */

import { ethers } from 'ethers';

const DEFAULT_DEMO_SEED = 'foxxi-demo-acme-training-2026-05-17-v1';

const enc = new TextEncoder();

/** Isomorphic sha256 → 32-byte Uint8Array. Uses ethers (which uses noble) so works in browser + Node. */
function sha256Bytes(input: string): Uint8Array {
  const hex = ethers.sha256(enc.encode(input));
  return ethers.getBytes(hex);
}

function sha256Hex(input: string): string {
  return ethers.sha256(enc.encode(input)).slice(2); // strip 0x
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface SessionToken {
  /** Subject WebID — set by the dashboard at mint time, verified server-side. */
  sub: string;
  /** ISO timestamp the token was issued. */
  iat: string;
  /** ISO timestamp after which the token is invalid. */
  exp: string;
  /** Random nonce so two tokens for the same subject differ. */
  nonce: string;
  /** secp256k1 address that signed the token's canonical message. */
  address: string;
  /** Hex signature over the canonical message. */
  sig: string;
}

export function deriveUserWallet(userId: string, seed: string = DEFAULT_DEMO_SEED): ethers.Wallet {
  const h = sha256Bytes(`${seed}:${userId}`);
  return new ethers.Wallet(ethers.hexlify(h));
}

/**
 * True when `walletAddress` is the wallet the PUBLIC demo seed derives for `userId`.
 * Such a wallet is forgeable by anyone (the seed is public), so a trust boundary must
 * never accept a session token signed by it — even if a directory publisher baked it in
 * as an explicit `wallet_address`. Keeps `DEFAULT_DEMO_SEED` encapsulated here.
 */
export function isPublicDemoWallet(userId: string, walletAddress: string): boolean {
  try {
    return walletAddress.toLowerCase() === deriveUserWallet(userId, DEFAULT_DEMO_SEED).address.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Canonical message the user signs. Including `sub`, `iat`, `exp`, and
 * `nonce` binds the signature to a specific subject + time window so a
 * replayed signature can't be reused for a different user or beyond expiry.
 */
function canonicalMessage(t: Pick<SessionToken, 'sub' | 'iat' | 'exp' | 'nonce'>): string {
  return `Foxxi session\n  sub: ${t.sub}\n  iat: ${t.iat}\n  exp: ${t.exp}\n  nonce: ${t.nonce}`;
}

/**
 * Issue a session token signed by the user's deterministic wallet.
 * Runs anywhere a deterministic wallet can be derived (dashboard,
 * MCP client, CLI). The bridge does NOT mint tokens — it only verifies.
 */
export async function mintSessionToken(args: {
  userId: string;
  webId: string;
  seed?: string;
  ttlMs?: number;
}): Promise<string> {
  const wallet = deriveUserWallet(args.userId, args.seed);
  const now = new Date();
  const exp = new Date(now.getTime() + (args.ttlMs ?? TOKEN_TTL_MS));
  const nonce = sha256Hex(`${args.userId}:${now.getTime()}:${Math.random()}`).slice(0, 16);
  const body: Omit<SessionToken, 'sig'> = {
    sub: args.webId,
    iat: now.toISOString(),
    exp: exp.toISOString(),
    nonce,
    address: wallet.address,
  };
  const sig = await wallet.signMessage(canonicalMessage(body));
  const token: SessionToken = { ...body, sig };
  return encodeToken(token);
}

function utf8ToBytes(s: string): Uint8Array { return new TextEncoder().encode(s); }
function bytesToUtf8(b: Uint8Array): string { return new TextDecoder().decode(b); }

function base64urlEncode(bytes: Uint8Array): string {
  // Browser-friendly: use btoa via a binary string.
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa is available in browsers + modern Node.
  const b64 = typeof btoa !== 'undefined' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  if (typeof atob !== 'undefined') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function encodeToken(token: SessionToken): string {
  return base64urlEncode(utf8ToBytes(JSON.stringify(token)));
}

export function decodeToken(encoded: string): SessionToken | null {
  try {
    const json = bytesToUtf8(base64urlDecode(encoded));
    const t = JSON.parse(json);
    if (typeof t !== 'object' || t === null) return null;
    for (const k of ['sub', 'iat', 'exp', 'nonce', 'address', 'sig']) {
      if (typeof (t as Record<string, unknown>)[k] !== 'string') return null;
    }
    return t as SessionToken;
  } catch {
    return null;
  }
}

export type TokenVerifyResult =
  | { ok: true; token: SessionToken; callerDid: string; callerUserId: string }
  | { ok: false; reason: string };

/**
 * Verify a session token against a known address→webId map. Returns
 * the resolved caller identity on success. Pure: no I/O, no state.
 */
export function verifySessionToken(
  encoded: string,
  knownAddresses: ReadonlyMap<string, { webId: string; userId: string }>,
): TokenVerifyResult {
  const token = decodeToken(encoded);
  if (!token) return { ok: false, reason: 'malformed token' };

  // Time-window check
  const now = Date.now();
  const exp = Date.parse(token.exp);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'invalid exp' };
  if (now > exp) return { ok: false, reason: 'expired' };
  const iat = Date.parse(token.iat);
  if (!Number.isFinite(iat)) return { ok: false, reason: 'invalid iat' };
  if (iat > now + 60_000) return { ok: false, reason: 'iat in future' };

  // Recover signer address
  let recovered: string;
  try {
    recovered = ethers.verifyMessage(canonicalMessage(token), token.sig);
  } catch (err) {
    return { ok: false, reason: `signature recovery failed: ${(err as Error).message}` };
  }

  if (recovered.toLowerCase() !== token.address.toLowerCase()) {
    return { ok: false, reason: 'recovered address differs from claimed' };
  }

  // Address-to-subject mapping
  const known = knownAddresses.get(recovered.toLowerCase());
  if (!known) return { ok: false, reason: `address ${recovered} not in tenant directory` };

  // Token's claimed subject must match the directory mapping for the
  // recovered address — defends against "I have the right key but I'm
  // claiming someone else's webId."
  if (known.webId !== token.sub) {
    return { ok: false, reason: 'token sub does not match address mapping' };
  }

  return { ok: true, token, callerDid: known.webId, callerUserId: known.userId };
}

/**
 * Build the address→subject map from a published tenant directory.
 * The directory entries carry `wallet_address` (set by the publisher
 * via deriveUserWallet); the bridge uses this map to resolve each
 * incoming token to a known user.
 */
export function buildAddressMap(
  users: ReadonlyArray<{ user_id: string; web_id: string; wallet_address?: string }>,
): Map<string, { webId: string; userId: string }> {
  const map = new Map<string, { webId: string; userId: string }>();
  for (const u of users) {
    if (!u.wallet_address) continue;
    map.set(u.wallet_address.toLowerCase(), { webId: u.web_id, userId: u.user_id });
  }
  return map;
}

/**
 * Convenience: derive every user's wallet address from the demo seed and
 * inject `wallet_address` into the user records. Called by the publisher
 * before sending the directory to the pod so the bridge has the address
 * lookup it needs.
 */
export function attachDeterministicAddresses<U extends { user_id: string; wallet_address?: string }>(
  users: readonly U[],
  seed: string = DEFAULT_DEMO_SEED,
): Array<U & { wallet_address: string }> {
  return users.map(u => ({
    ...u,
    // Preserve a REAL member address if the directory already carries one (real
    // proof-of-possession); only fall back to the demo-seed derivation when
    // absent. This lets a tenant mix real-key learners with demo ones, and lets
    // a fully-real tenant (e.g. a self-sovereign app) skip the seed entirely.
    wallet_address: u.wallet_address ?? deriveUserWallet(u.user_id, seed).address,
  }));
}

// ── Substrate-native agent auth (rev-196 signed request) ──────────────────
//
// Foxxi is a composed vertical over Interego, not a tenant of the relay. A
// capability endpoint authenticates the calling AGENT directly by verifying
// the SAME ECDSA signed-request envelope the relay uses — no relay vouching
// secret, so the vertical composes over the substrate without coupling to it.
// The agent reaches the endpoint emergently (discover → dereference → act on a
// published iep:Affordance); the `act` body carries this envelope.
//
//   { _signature: '0x…', _signed_payload: JSON.stringify({ ...args,
//       agent_id: 'did:ethr:<addr>', timestamp: <ISO 8601> }) }
//
// The signer signs the canonical message `sha256:<hex(sha256(signedPayload))>`.
// Identity binds to the RECOVERED did:ethr, never to a caller-claimed agent_id,
// so a caller cannot sign with one wallet and claim another's identity.

// Replay window for signed requests. 60s is too tight for a relay sign→act
// round-trip on a large payload (sign, marshal, network, verify) — widened to
// 5 min by default and made env-tunable. Still bounded (replay protection).
const AGENT_SIG_REPLAY_WINDOW_MS = (() => {
  const v = Number(process.env.AGENT_SIG_REPLAY_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : 300_000;
})();

export type RecoveredSignedRequest =
  | { ok: true; signer: string; agentId: string; payload: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Pure: parse the rev-196 envelope, enforce the replay window, and recover the
 * signer. Makes NO trust decision — the caller decides DIRECT (the signer IS the
 * agent: agent_id embeds the recovered address) vs DELEGATED (the relay signed on
 * the agent's behalf: verify the agent's on-pod delegation VC and that the request
 * signer is its anchor key). I/O-free so it stays in this pure module.
 */
export function recoverSignedRequest(body: unknown): RecoveredSignedRequest {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body is not an object' };
  const b = body as Record<string, unknown>;
  const signature = typeof b._signature === 'string' ? b._signature : undefined;
  const signedPayload = typeof b._signed_payload === 'string' ? b._signed_payload : undefined;
  if (!signature || !signedPayload) {
    return { ok: false, reason: 'missing _signature or _signed_payload (rev-196 signed-request envelope expected)' };
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(signedPayload) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: `_signed_payload is not valid JSON: ${(err as Error).message}` };
  }
  const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : undefined;
  const timestamp = typeof payload.timestamp === 'string' ? payload.timestamp : undefined;
  if (!agentId) return { ok: false, reason: 'signed payload missing agent_id' };
  if (!timestamp) return { ok: false, reason: 'signed payload missing timestamp (ISO 8601 — replay protection)' };
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return { ok: false, reason: `timestamp is not a parseable instant: ${timestamp}` };
  if (Math.abs(Date.now() - t) > AGENT_SIG_REPLAY_WINDOW_MS) {
    return { ok: false, reason: `timestamp drift exceeds ±${AGENT_SIG_REPLAY_WINDOW_MS / 1000}s — replay protection` };
  }
  // Canonical message identical to the relay's: sha256:<hex(sha256(payload))>.
  const message = `sha256:${sha256Hex(signedPayload)}`;
  let recovered: string;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch (err) {
    return { ok: false, reason: `signature recovery threw: ${(err as Error).message}` };
  }
  return { ok: true, signer: recovered, agentId, payload };
}

export type AgentSignedResult =
  | { ok: true; callerDid: string; payload: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * DIRECT mode only: the signer IS the agent — agent_id embeds the recovered
 * address (a wallet-holding identity: the maintainer, an external eth wallet).
 * For relay-mediated agents that delegate signing, use recoverSignedRequest +
 * an on-pod delegation check (the bridge does this).
 */
export function verifyAgentSignedRequest(body: unknown): AgentSignedResult {
  const r = recoverSignedRequest(body);
  if (!r.ok) return { ok: false, reason: r.reason };
  const addrMatch = r.agentId.toLowerCase().match(/0x[0-9a-f]{40}/);
  if (!addrMatch) return { ok: false, reason: `agent_id ${r.agentId} embeds no Ethereum address — delegated signing required (no direct key)` };
  if (r.signer.toLowerCase() !== addrMatch[0]) {
    return { ok: false, reason: `signature recovered ${r.signer} but agent_id claimed ${addrMatch[0]}` };
  }
  return { ok: true, callerDid: `did:ethr:${r.signer}`, payload: r.payload };
}
