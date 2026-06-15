/**
 * Browser-safe session-token minting for the Foxxi dashboard SPA.
 *
 * This is the BROWSER half of the bridge's session-token scheme (bridge:
 * src/auth.ts). The dashboard mints a real ECDSA-signed token by signing a
 * canonical message with the user's deterministic demo wallet; the bridge
 * VERIFIES it (the verify path stays server-side). Kept self-contained in the
 * SPA's own src/ so the bundle stays free of the bridge-only @interego/core
 * server kernel — the mint path needs only `ethers` + Web APIs (btoa,
 * TextEncoder), which run in the browser.
 *
 * Wire-compatible with the bridge verifier: identical canonical message,
 * deterministic wallet derivation, and base64url(JSON) token envelope. Keep
 * these in sync with bridge src/auth.ts (mintSessionToken / canonicalMessage /
 * deriveUserWallet / encodeToken / SessionToken).
 */

import { ethers } from 'ethers';

const DEFAULT_DEMO_SEED = 'foxxi-demo-acme-training-2026-05-17-v1';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const enc = new TextEncoder();

/** Isomorphic sha256 → 32-byte Uint8Array (ethers uses noble; browser-safe). */
function sha256Bytes(input: string): Uint8Array {
  return ethers.getBytes(ethers.sha256(enc.encode(input)));
}
function sha256Hex(input: string): string {
  return ethers.sha256(enc.encode(input)).slice(2); // strip 0x
}

export interface SessionToken {
  sub: string;
  iat: string;
  exp: string;
  nonce: string;
  address: string;
  sig: string;
}

export function deriveUserWallet(userId: string, seed: string = DEFAULT_DEMO_SEED): ethers.Wallet {
  return new ethers.Wallet(ethers.hexlify(sha256Bytes(`${seed}:${userId}`)));
}

/** Canonical message the user signs — binds the signature to subject + window. */
function canonicalMessage(t: Pick<SessionToken, 'sub' | 'iat' | 'exp' | 'nonce'>): string {
  return `Foxxi session\n  sub: ${t.sub}\n  iat: ${t.iat}\n  exp: ${t.exp}\n  nonce: ${t.nonce}`;
}

/** Browser-only base64url (btoa is always present in the SPA). */
function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function encodeToken(token: SessionToken): string {
  return base64urlEncode(enc.encode(JSON.stringify(token)));
}

/**
 * Issue a session token signed by the user's deterministic wallet. The bridge
 * does NOT mint tokens — it only verifies — so this runs entirely in the SPA.
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
  return encodeToken({ ...body, sig });
}
