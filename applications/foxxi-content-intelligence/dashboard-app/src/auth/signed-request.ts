/**
 * Browser-side rev-196 signed-request envelopes for the dashboard SPA.
 *
 * The self-sovereign /agent/* affordances (forwarding targets, inbound
 * credentials, content authoring and play) authenticate by SIGNATURE, not by the
 * session token. Every dashboard session has a signer (auth/signer.ts): its
 * deterministic demo wallet, a connected key, or a wallet extension. So the SPA
 * signs requests as that user without a relay: it builds the rev-196 envelope
 * { _signed_payload, _signature } the bridge's verifyDelegatedCaller accepts on
 * its DIRECT branch (agent_id embeds the signer's eth address).
 *
 * Wire-compatible with the bridge's recoverSignedRequest (src/auth.ts):
 * the signed payload is JSON.stringify({ agent_id, timestamp, ...args }) and
 * the signature is over `sha256:<hex(sha256(_signed_payload))>`. A fresh
 * timestamp each call stays inside the ±60s replay window.
 */

import { ethers } from 'ethers';
import { deriveUserWallet, type MessageSigner } from './session-token.js';

const enc = new TextEncoder();
const sha256Hex = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);

export interface SignedEnvelope { _signed_payload: string; _signature: string; }

/** Sign `args` as `signer` — the DIRECT-branch envelope (agent_id = did:ethr:<its address>). */
export async function signAgentRequestAs(signer: MessageSigner, args: Record<string, unknown>, now: Date = new Date()): Promise<SignedEnvelope> {
  const _signed_payload = JSON.stringify({ agent_id: `did:ethr:${signer.address}`, timestamp: now.toISOString(), ...args });
  const _signature = await signer.signMessage(`sha256:${sha256Hex(_signed_payload)}`);
  return { _signed_payload, _signature };
}

/**
 * Sign `args` as the given user. If opts.privateKey is set (a "connect wallet"
 * session), signs with that REAL key; otherwise derives the per-user demo wallet
 * from userId + seed.
 */
export async function signAgentRequest(
  userId: string, args: Record<string, unknown>, opts?: { seed?: string; privateKey?: string },
): Promise<SignedEnvelope> {
  return signAgentRequestAs(opts?.privateKey ? new ethers.Wallet(opts.privateKey) : deriveUserWallet(userId, opts?.seed), args);
}

/**
 * Sign + POST an affordance call to its own URL, as an entry point publishes it
 * (`_affordances[].href`). Returns the parsed JSON. A refusal throws with the
 * bridge's own words, and carries its status and body for the caller to read.
 */
export async function postSigned<T = unknown>(href: string, signer: MessageSigner, args: Record<string, unknown>): Promise<T> {
  const body = await signAgentRequestAs(signer, args);
  const r = await fetch(href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new AffordanceRefusal(r.status, json);
  return json as T;
}

/** A signed affordance call the bridge refused: its status, and what it said. */
export class AffordanceRefusal extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    const said = (body as { error?: unknown } | null)?.error;
    super(typeof said === 'string' ? said : `HTTP ${status}`);
  }
}

/** Sign + POST a self-sovereign affordance call to `${origin}/agent/<path>` as `signer`. Returns parsed JSON. */
export async function callSignedAffordanceAs<T = unknown>(origin: string, path: string, signer: MessageSigner, args: Record<string, unknown>): Promise<T> {
  return postSigned<T>(`${origin}/agent/${path.replace(/^\/+/, '')}`, signer, args);
}

/** Sign + POST a self-sovereign affordance call to `${origin}/agent/<path>`. Returns parsed JSON. */
export async function callSignedAffordance<T = unknown>(
  origin: string, path: string, userId: string, args: Record<string, unknown>, opts?: { seed?: string; privateKey?: string },
): Promise<T> {
  return callSignedAffordanceAs<T>(origin, path, opts?.privateKey ? new ethers.Wallet(opts.privateKey) : deriveUserWallet(userId, opts?.seed), args);
}
