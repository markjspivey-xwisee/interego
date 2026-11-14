/**
 * A verifier for an Interego-signed caller, with every dependency passed in.
 *
 * The broker's driver route needs to know who signed a request before it believes anything in
 * it. This is the rule the I2IDL-X workbench applies, written once so another bridge does not
 * have to restate it:
 *
 *   DIRECT     the agent id embeds the address that signed the request. The signer is the actor.
 *   DELEGATED  someone signed on the agent's behalf (a relay's `sign_request`). Then the agent's
 *              delegation, read from the agent's OWN pod, must be cryptographically verified, and
 *              the request's signer must be the key that anchors that delegation.
 *
 * The pod a delegation is read from is derived from the agent id by the bridge, never taken
 * from the request: honouring a caller-named pod would let a caller point the read at a pod of
 * their choosing. What recovers a signature, where pods live and how a delegation is read are
 * the bridge's, so this file imports nothing at runtime.
 */
import type { VerifySignedCaller } from './http.js';

export interface DelegatedCallerDeps {
  /** Parse the signed envelope, enforce its replay window and recover the signer. Makes no trust decision. */
  recover(body: unknown): { ok: true; signer: string; agentId: string; payload: Record<string, unknown> } | { ok: false; reason: string };
  /** The agent's own pod, or undefined when this deployment can not name one for it. */
  delegationPod(agentId: string): string | undefined;
  /**
   * Read and verify the agent's delegation on that pod. `anchor` is the address of the key that
   * signed the delegation. A read that fails is a rejection, not an exception to swallow.
   */
  delegation(agentId: string, pod: string): Promise<{ verified: boolean; anchor?: string; reason?: string }>;
}

export function makeDelegatedCallerVerifier(deps: DelegatedCallerDeps): VerifySignedCaller {
  return async body => {
    const rec = deps.recover(body);
    if (!rec.ok) return { ok: false, status: 401, error: `agent signature required: ${rec.reason}` };
    const claimed = rec.agentId.toLowerCase().match(/0x[0-9a-f]{40}/)?.[0];
    if (claimed && claimed === rec.signer.toLowerCase()) {
      return { ok: true, callerDid: `did:ethr:${rec.signer}`, payload: rec.payload };
    }
    const pod = deps.delegationPod(rec.agentId);
    if (!pod) return { ok: false, status: 401, error: 'this deployment can not name a pod for that agent' };
    let found: { verified: boolean; anchor?: string; reason?: string };
    try { found = await deps.delegation(rec.agentId, pod); }
    catch { return { ok: false, status: 401, error: 'delegation verification failed' }; }
    if (!found.verified) return { ok: false, status: 401, error: `agent has no cryptographically verified delegation: ${found.reason ?? 'unverified'}` };
    if (!found.anchor || found.anchor.toLowerCase() !== rec.signer.toLowerCase()) {
      return { ok: false, status: 401, error: 'request signer is not the delegation anchor key' };
    }
    return { ok: true, callerDid: rec.agentId, payload: rec.payload };
  };
}
