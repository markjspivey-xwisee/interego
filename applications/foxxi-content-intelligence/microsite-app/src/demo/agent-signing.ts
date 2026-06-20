/**
 * In-browser fresh-agent identity + rev-196 DIRECT signed-request calls.
 *
 * This is the EXACT signing the headless feasibility proof validated 13/13
 * (tools/demo-feasibility-proof.ts), ported to the browser. A fresh agent =
 * a random ECDSA wallet; the bridge's DIRECT branch recovers did:ethr:<addr>
 * from the signature and auto-provisions pod + registry + delegation VC. No
 * pre-registration, no OAuth, no human, no secret — true self-onboarding.
 */
import { ethers } from 'ethers';
import { BRIDGE_URL } from '../bridge-client.js';

const enc = new TextEncoder();
const sha256Hex = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);

export interface AgentWallet {
  wallet: ethers.HDNodeWallet;
  /** did:ethr:<LOWERCASE addr> — the recovery regex is lowercase-only. */
  did: string;
  address: string;
  /** The lens/pod label the bridge derives: eth-<first12hex>. */
  podLabel: string;
}

export function freshAgent(): AgentWallet {
  const wallet = ethers.Wallet.createRandom();
  const address = wallet.address.toLowerCase();
  return { wallet, did: `did:ethr:${address}`, address, podLabel: `eth-${address.slice(2, 14)}` };
}

export interface SignedEnvelope { _signature: string; _signed_payload: string; }

export async function signEnvelope(a: AgentWallet, args: Record<string, unknown>): Promise<SignedEnvelope> {
  const payload = { ...args, agent_id: a.did, timestamp: new Date().toISOString() };
  const _signed_payload = JSON.stringify(payload);
  const _signature = await a.wallet.signMessage(`sha256:${sha256Hex(_signed_payload)}`);
  return { _signature, _signed_payload };
}

export interface BridgeResult { ok: boolean; status: number; body: unknown; /** the rev-196 envelope sent (signed calls only) — for the protocol trace / evidence pack */ envelope?: SignedEnvelope; /** the bridge path called */ path?: string; }

/** POST a rev-196 signed envelope to a /agent/* endpoint (DIRECT branch). The
 *  returned result carries the exact envelope bytes so callers can show the raw
 *  signed payload + signature (the protocol trace) and recover the signer. */
export async function postSigned(path: string, a: AgentWallet, args: Record<string, unknown>): Promise<BridgeResult> {
  const env = await signEnvelope(a, args);
  const r = await doPost(path, env);
  return { ...r, envelope: env, path };
}

/** Recover the signer address from a rev-196 envelope — pure client-side crypto,
 *  zero trust in the bridge. Returns the lowercase 0x address, or null if invalid. */
export function recoverSigner(env: SignedEnvelope): string | null {
  try { return ethers.verifyMessage(`sha256:${sha256Hex(env._signed_payload)}`, env._signature).toLowerCase(); }
  catch { return null; }
}

/** Build the copy-paste curl recipe that reproduces a signed call from a shell. */
export function curlFor(path: string, env: SignedEnvelope): string {
  const body = JSON.stringify(env).replace(/'/g, `'\\''`);
  return `curl -sX POST '${BRIDGE_URL}${path}' \\\n  -H 'content-type: application/json' \\\n  -d '${body}'`;
}

/** POST an unsigned body (the open authoring surfaces, e.g. extend-standards). */
export async function postPlain(path: string, args: Record<string, unknown>): Promise<BridgeResult> {
  return doPost(path, args);
}

/** GET a bridge surface (guidance / affordances). */
export async function getBridge(path: string): Promise<BridgeResult> {
  try {
    const r = await fetch(`${BRIDGE_URL}${path}`, { headers: { Accept: 'application/ld+json, text/turtle' } });
    const body = await parseBody(r);
    return { ok: r.ok, status: r.status, body };
  } catch (err) { return { ok: false, status: 0, body: { error: (err as Error).message } }; }
}

async function doPost(path: string, body: unknown): Promise<BridgeResult> {
  try {
    const r = await fetch(`${BRIDGE_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: r.ok, status: r.status, body: await parseBody(r) };
  } catch (err) { return { ok: false, status: 0, body: { error: (err as Error).message } }; }
}

async function parseBody(r: Response): Promise<unknown> {
  const ct = r.headers.get('content-type') ?? '';
  if (ct.includes('json')) { try { return await r.json(); } catch { /* fall */ } }
  return await r.text().catch(() => null);
}
