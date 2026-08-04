/**
 * Receiver-side admission for an inbound `ac:AgentRequest` / `ac:ChimeIn`.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────
 *
 * The vertical's transport is `P2pClient.publishEncryptedShare` /
 * `queryEncryptedShares`, which move an opaque ciphertext to a recipient pubkey. They
 * cannot inspect an `ac:withinDelegation`, and must not — the payload is end-to-end
 * encrypted and the relay has no key. So there was no point in the shipped code between
 * "a blob arrived in David's inbox" and "David's agent acted on it", and the README
 * described the gate as though there were: `README.md` said "Every cross-agent action is
 * bounded by a `passport:DelegationCredential` … Agents cannot grant themselves new
 * permissions", and `examples/collective-flow.mjs` said "Acting outside delegation scope
 * is rejected on receiver side". Measured before this file: ZERO `.ts` in the vertical
 * mentioned `withinDelegation`, `advertisedAffordance` or `CapabilityAdvertisement`.
 *
 * This is that point. It is a pure function over data the receiver already holds, so it
 * is callable from a test — which is the difference between a documented control and an
 * enforced one.
 *
 * ── ★ WHY THE VERB CHECK READS THE CREDENTIAL AND NOT `verification.scope` ────
 *
 * The obvious implementation gates on `verifyDelegation(...).scope`. That field is read
 * from the pod's PLAINTEXT agent-registry Turtle — `verifyDelegationChain` returns
 * `profile.authorizedAgents.find(...)?.scope` and never compares it against the signed
 * `credentialSubject.scope` it just verified. Measured, real ECDSA, one owner wallet:
 *
 *     signed credentialSubject.scope : ["discover"]        (owner granted DiscoverOnly)
 *     registry Turtle says           : iep:scope iep:ReadWrite
 *     verifyDelegation returns       : {"valid":true,"scope":"ReadWrite",
 *                                       "trustLevel":"CryptographicallyVerified"}
 *
 * A gate keyed on that field grants `publish` on the strength of an unsigned file, and
 * reports the grant as cryptographically verified. `credentialSubject.scope` is covered
 * by `canonicalCredentialPayload`, so it is the only scope statement the owner actually
 * signed. That is the one this reads. (The core-level confusion is a separate item; this
 * file routes around it rather than pretending it is not there.)
 */

import { verifyDelegation } from '@interego/core';
import type {
  AgentDelegationCredential,
  DelegationVerifier,
  IRI,
  OwnerProfileData,
} from '@interego/core';

/** `ac:CapabilityAdvertisement` — what this agent will accept requests for. */
export interface CapabilityAdvertisement {
  readonly advertisingAgent: IRI;
  readonly advertisedAffordance: readonly IRI[];
  /** `ac:requiresDelegationFrom` — the human owner whose delegation the sender must carry. */
  readonly requiresDelegationFrom: IRI;
  readonly requiresAttestationsFromRequester: number;
}

/** The decrypted, parsed `ac:AgentRequest` — one inbox entry. */
export interface InboundAgentRequest {
  readonly threadId: string;
  readonly fromAgent: IRI;
  readonly toAgent: IRI;
  readonly targetAffordance: IRI;
  /** `ac:withinDelegation` — the credential the SENDER claims authorizes this. */
  readonly withinDelegation: IRI;
}

export type AdmissionRefusal =
  | 'wrong-receiver'
  | 'not-advertised'
  | 'delegation-invalid'
  | 'delegation-not-cited'
  | 'wrong-delegating-owner'
  | 'verb-not-signed'
  | 'insufficient-attestations';

export interface Admission {
  readonly admitted: boolean;
  readonly refusal?: AdmissionRefusal;
  readonly reason: string;
}

export interface AdmitArgs {
  readonly request: InboundAgentRequest;
  readonly advertisement: CapabilityAdvertisement;
  /** Pod the SENDER's owner publishes their agent registry + credentials to. */
  readonly senderPodUrl: string;
  readonly fetchProfile: (podUrl: string) => Promise<OwnerProfileData | null>;
  readonly fetchCredential: (podUrl: string, agentId: IRI) => Promise<AgentDelegationCredential | null>;
  readonly verifier: DelegationVerifier;
  /** ACL verbs this affordance needs — 'publish' / 'discover' / 'subscribe'. */
  readonly requiredVerbs: readonly string[];
  readonly requesterAttestations: number;
}

const refuse = (refusal: AdmissionRefusal, reason: string): Admission =>
  ({ admitted: false, refusal, reason });

/**
 * Decide one inbound request. Every refusal names WHICH gate refused, because a caller
 * that only learns "denied" cannot tell an unadvertised affordance from a revoked
 * delegation, and will retry the one that can never succeed.
 */
export async function admitAgentRequest(args: AdmitArgs): Promise<Admission> {
  const { request: req, advertisement: ad } = args;

  if (req.toAgent !== ad.advertisingAgent) {
    return refuse('wrong-receiver',
      `request addresses ${req.toAgent}; this advertisement is ${ad.advertisingAgent}'s`);
  }
  if (!ad.advertisedAffordance.includes(req.targetAffordance)) {
    return refuse('not-advertised',
      `${req.targetAffordance} is not in ${ad.advertisingAgent}'s ac:advertisedAffordance`);
  }

  const verified = await verifyDelegation(
    req.fromAgent, args.senderPodUrl, args.fetchProfile,
    { fetchCredential: args.fetchCredential, verifier: args.verifier },
  );
  if (!verified.valid) {
    return refuse('delegation-invalid', verified.reason ?? 'delegation did not verify');
  }

  const credential = await args.fetchCredential(args.senderPodUrl, req.fromAgent);
  if (!credential) {
    return refuse('delegation-invalid',
      `no delegation credential for ${req.fromAgent} on ${args.senderPodUrl}`);
  }
  // `ac:withinDelegation` is decoration unless the cited credential is the one that
  // actually authorizes the sender. Without this, a request may name any IRI it likes
  // and the audit row records a delegation that had nothing to do with the exchange.
  if (credential.id !== req.withinDelegation) {
    return refuse('delegation-not-cited',
      `request cites ${req.withinDelegation}; the credential that authorizes ${req.fromAgent} is ${credential.id}`);
  }
  if (credential.credentialSubject.delegatedBy !== ad.requiresDelegationFrom) {
    return refuse('wrong-delegating-owner',
      `credential is delegated by ${credential.credentialSubject.delegatedBy}; advertisement requires ${ad.requiresDelegationFrom}`);
  }

  // ★ THE SIGNED ARRAY, NOT `verified.scope` — see the header note for the measurement.
  const signedVerbs = credential.credentialSubject.scope;
  const missing = args.requiredVerbs.filter(v => !signedVerbs.includes(v));
  if (missing.length > 0) {
    return refuse('verb-not-signed',
      `owner ${credential.issuer} signed scope [${signedVerbs.join(', ')}]; this request needs [${missing.join(', ')}]`);
  }

  if (args.requesterAttestations < ad.requiresAttestationsFromRequester) {
    return refuse('insufficient-attestations',
      `requester has ${args.requesterAttestations} attestations; advertisement requires ${ad.requiresAttestationsFromRequester}`);
  }

  return { admitted: true, reason: `admitted on thread ${req.threadId}` };
}
