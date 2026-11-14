/**
 * How this world knows who claimed an agent invitation.
 *
 * The same rule the I2IDL-X workbench applies, composed from the same parts: the signed-request
 * envelope is recovered by Foxxi's `recoverSignedRequest` (the envelope the relay's
 * `sign_request` produces), and the trust decision is the shared
 * `makeDelegatedCallerVerifier`. A request an agent signed with its own key is that agent. A
 * request the relay signed for an agent is believed only when the agent's delegation, read from
 * the agent's OWN pod, verifies cryptographically and the request's signer is the key that
 * anchors it.
 *
 * The one thing that is configuration is where agents' own pods live: `podOrigin`. The pod is
 * derived from the agent id on that origin and never taken from the request, and every fetch
 * of it goes through Foxxi's SSRF guard, because it happens before the caller is authorized.
 * This file reads no environment; `src/server.ts` does and passes the origin in.
 */
import { makeWalletDelegationVerifier, ownPodSegment, type IRI } from '@interego/core';
import { readDelegationCredential, verifyAgentDelegation } from '@interego/solid';
import { recoverSignedRequest } from '../../foxxi-content-intelligence/src/auth.js';
import { assertSafeFetchTarget, guardedFetchFn } from '../../foxxi-content-intelligence/src/ssrf-guard.js';
import { makeDelegatedCallerVerifier, type VerifySignedCaller } from '../../_shared/agent-connection/index.js';
import { publicOrigin } from '../../_shared/http-guard/index.js';

export function interegoCallerVerifier(config: { readonly podOrigin: string }): VerifySignedCaller {
  // Checked once, at start: an origin and nothing else, over https.
  const origin = publicOrigin(config.podOrigin);
  const fetchFn = guardedFetchFn(globalThis.fetch) as never;
  return makeDelegatedCallerVerifier({
    recover: recoverSignedRequest,
    delegationPod: agentId => {
      const segment = ownPodSegment(agentId);
      return segment ? `${origin}/${segment}/` : undefined;
    },
    delegation: async (agentId, pod) => {
      await assertSafeFetchTarget(pod);
      const found = await verifyAgentDelegation(agentId as IRI, pod, { verifier: makeWalletDelegationVerifier(), fetch: fetchFn });
      if (!found.valid || found.trustLevel !== 'CryptographicallyVerified') {
        return { verified: false, reason: found.reason ?? found.trustLevel ?? 'unverified' };
      }
      const credential = await readDelegationCredential(pod, agentId as IRI, { fetch: fetchFn }).catch(() => null);
      const anchor = credential?.proof?.signerAddress;
      return { verified: true, ...(anchor ? { anchor } : {}) };
    },
  });
}
