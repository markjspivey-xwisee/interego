/**
 * In-browser fresh self-sovereign agent + rev-196 signed envelopes — the EXACT
 * envelope the bridge recovers (`sha256:<hex(payload)>` signed by the wallet, with
 * the claimed agent_id bound to the recovered address). Bridge-agnostic.
 */
import { ethers } from 'ethers';

const enc = new TextEncoder();
const sha256Hex = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);

export interface AgentWallet { wallet: ethers.HDNodeWallet; did: string; address: string; }
export interface SignedEnvelope { _signature: string; _signed_payload: string; }

export function freshAgent(): AgentWallet {
  const wallet = ethers.Wallet.createRandom();
  const address = wallet.address.toLowerCase();
  return { wallet, did: `did:ethr:${address}`, address };
}

/** Sign { ...args, agent_id, timestamp } into a rev-196 envelope. */
export async function signEnvelope(a: AgentWallet, args: Record<string, unknown>): Promise<SignedEnvelope> {
  const payload = { ...args, agent_id: a.did, timestamp: new Date().toISOString() };
  const _signed_payload = JSON.stringify(payload);
  const _signature = await a.wallet.signMessage(`sha256:${sha256Hex(_signed_payload)}`);
  return { _signature, _signed_payload };
}
