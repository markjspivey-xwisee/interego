/**
 * Browser-side rev-196 signed-request envelopes for the dashboard SPA.
 *
 * The self-sovereign /agent/* affordances (forwarding targets, inbound
 * credentials, content authoring) authenticate by SIGNATURE, not by the
 * session token. A dashboard user already has a deterministic wallet
 * (deriveUserWallet, the same one session-token.ts mints with), so the SPA
 * can sign requests as that user without a relay: it builds the rev-196
 * envelope { _signed_payload, _signature } the bridge's verifyDelegatedCaller
 * accepts on its DIRECT branch (agent_id embeds the signer's eth address).
 *
 * Wire-compatible with the bridge's recoverSignedRequest (src/auth.ts):
 * the signed payload is JSON.stringify({ agent_id, timestamp, ...args }) and
 * the signature is over `sha256:<hex(sha256(_signed_payload))>`. A fresh
 * timestamp each call stays inside the ±60s replay window.
 */

import { ethers } from 'ethers';
import { deriveUserWallet } from './session-token.js';

const enc = new TextEncoder();
const sha256Hex = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);

export interface SignedEnvelope { _signed_payload: string; _signature: string; }

/**
 * Sign `args` as the given user — DIRECT-branch envelope (agent_id = did:ethr:<addr>).
 * If opts.privateKey is set (a "connect wallet" session), signs with that REAL
 * key; otherwise derives the per-user demo wallet from userId + seed.
 */
export async function signAgentRequest(
  userId: string, args: Record<string, unknown>, opts?: { seed?: string; privateKey?: string },
): Promise<SignedEnvelope> {
  const wallet = opts?.privateKey ? new ethers.Wallet(opts.privateKey) : deriveUserWallet(userId, opts?.seed);
  const _signed_payload = JSON.stringify({ agent_id: `did:ethr:${wallet.address}`, timestamp: new Date().toISOString(), ...args });
  const _signature = await wallet.signMessage(`sha256:${sha256Hex(_signed_payload)}`);
  return { _signed_payload, _signature };
}

/** Sign + POST a self-sovereign affordance call to `${origin}/agent/<path>`. Returns parsed JSON. */
export async function callSignedAffordance<T = unknown>(
  origin: string, path: string, userId: string, args: Record<string, unknown>, opts?: { seed?: string; privateKey?: string },
): Promise<T> {
  const body = await signAgentRequest(userId, args, opts);
  const r = await fetch(`${origin}/agent/${path.replace(/^\/+/, '')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${r.status}`);
  return json as T;
}
