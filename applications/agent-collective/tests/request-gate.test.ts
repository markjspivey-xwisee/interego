/**
 * Agent Collective — receiver-side admission gate.
 *
 * Real ECDSA throughout: owner-signed delegation VCs minted with
 * `makeWalletDelegationSigner` and checked with `makeWalletDelegationVerifier`, over the
 * real `verifyDelegation` chain walk. The point of this file is the REFUSALS — the
 * README documented a permission gate that no test had ever made say no.
 */

import { describe, it, expect } from 'vitest';
import {
  createOwnerProfile,
  createSignedDelegationCredential,
  importWallet,
  makeWalletDelegationSigner,
  makeWalletDelegationVerifier,
  removeAuthorizedAgent,
} from '@interego/core';
import type {
  AgentDelegationCredential,
  AuthorizedAgentData,
  IRI,
  OwnerProfileData,
} from '@interego/core';
import {
  admitAgentRequest,
  type CapabilityAdvertisement,
  type InboundAgentRequest,
} from '../src/request-gate.js';

const MARK_OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const MARK        = 'https://pod.example/mark/profile#me' as IRI;
const MARK_POD    = 'https://pod.example/mark/';
const MARK_AGENT  = 'did:key:agent-mark' as IRI;
const DAVID       = 'https://pod.example/david/profile#me' as IRI;
const DAVID_AGENT = 'did:key:agent-david' as IRI;

const SHARE_SYNTHESIS = 'urn:iep:affordance:share-tone-synthesis' as IRI;
const RUN_ARBITRARY   = 'urn:iep:affordance:run-arbitrary-code' as IRI;

const davidAdvertises: CapabilityAdvertisement = {
  advertisingAgent: DAVID_AGENT,
  advertisedAffordance: [SHARE_SYNTHESIS],
  requiresDelegationFrom: MARK,
  requiresAttestationsFromRequester: 1,
};

function markAgentRecord(o: Partial<AuthorizedAgentData> = {}): AuthorizedAgentData {
  return { agentId: MARK_AGENT, delegatedBy: MARK, scope: 'ReadWrite', validFrom: '2020-01-01T00:00:00Z', ...o } as AuthorizedAgentData;
}

async function markCredential(rec: AuthorizedAgentData): Promise<AgentDelegationCredential> {
  const wallet = importWallet(MARK_OWNER_KEY, 'human', 'mark');
  return createSignedDelegationCredential(
    createOwnerProfile(MARK, 'Mark', [rec]), rec, MARK_POD as IRI,
    makeWalletDelegationSigner(wallet),
  );
}

function request(o: Partial<InboundAgentRequest> = {}, credentialId?: IRI): InboundAgentRequest {
  return {
    threadId: 'thread-2026-04-27-001',
    fromAgent: MARK_AGENT,
    toAgent: DAVID_AGENT,
    targetAffordance: SHARE_SYNTHESIS,
    withinDelegation: credentialId ?? ('urn:unset' as IRI),
    ...o,
  };
}

async function gate(o: {
  rec?: AuthorizedAgentData;
  profile?: OwnerProfileData;
  req?: Partial<InboundAgentRequest>;
  ad?: CapabilityAdvertisement;
  requiredVerbs?: readonly string[];
  attestations?: number;
  citeWrong?: boolean;
}) {
  const rec = o.rec ?? markAgentRecord();
  const credential = await markCredential(rec);
  const profile = o.profile ?? createOwnerProfile(MARK, 'Mark', [rec]);
  return admitAgentRequest({
    request: request(o.req, o.citeWrong ? ('urn:iep:delegation:some-other' as IRI) : credential.id),
    advertisement: o.ad ?? davidAdvertises,
    senderPodUrl: MARK_POD,
    fetchProfile: async () => profile,
    fetchCredential: async () => credential,
    verifier: makeWalletDelegationVerifier(),
    requiredVerbs: o.requiredVerbs ?? ['publish'],
    requesterAttestations: o.attestations ?? 3,
  });
}

describe('agent-collective — receiver-side admission gate', () => {
  it('admits the honest request', async () => {
    const r = await gate({});
    expect(r).toEqual({ admitted: true, reason: 'admitted on thread thread-2026-04-27-001' });
  });

  it('refuses an unadvertised affordance', async () => {
    const r = await gate({ req: { targetAffordance: RUN_ARBITRARY } });
    expect(r.refusal).toBe('not-advertised');
  });

  it('refuses a request addressed to another agent', async () => {
    const r = await gate({ req: { toAgent: 'did:key:agent-eve' as IRI } });
    expect(r.refusal).toBe('wrong-receiver');
  });

  it('refuses a revoked delegation', async () => {
    const rec = markAgentRecord();
    const revoked = removeAuthorizedAgent(createOwnerProfile(MARK, 'Mark', [rec]), MARK_AGENT);
    const r = await gate({ rec, profile: revoked });
    expect(r.refusal).toBe('delegation-invalid');
    expect(r.reason).toContain('revoked');
  });

  it('refuses when the request cites a credential that is not the one authorizing it', async () => {
    const r = await gate({ citeWrong: true });
    expect(r.refusal).toBe('delegation-not-cited');
  });

  // ★ THE ESCALATION THIS GATE EXISTS TO REFUSE. The owner signed DiscoverOnly
  // (credentialSubject.scope === ["discover"]); the pod's PLAINTEXT registry says
  // ReadWrite. `verifyDelegation` returns {"valid":true,"scope":"ReadWrite",
  // "trustLevel":"CryptographicallyVerified"} — measured. A gate reading that field
  // admits a publish the owner never signed. Reading the signed array refuses it.
  it('refuses a verb the owner never signed — registry scope is NOT the signed scope', async () => {
    const signedRec  = markAgentRecord({ scope: 'DiscoverOnly' });
    const credential = await markCredential(signedRec);
    const tamperedRegistry = createOwnerProfile(MARK, 'Mark', [markAgentRecord({ scope: 'ReadWrite' })]);
    const r = await admitAgentRequest({
      request: request({}, credential.id),
      advertisement: davidAdvertises,
      senderPodUrl: MARK_POD,
      fetchProfile: async () => tamperedRegistry,
      fetchCredential: async () => credential,
      verifier: makeWalletDelegationVerifier(),
      requiredVerbs: ['publish'],
      requesterAttestations: 3,
    });
    expect(r.refusal).toBe('verb-not-signed');
    expect(r.reason).toContain('signed scope [discover]');
  });

  it('refuses an under-attested requester', async () => {
    const r = await gate({ attestations: 0 });
    expect(r.refusal).toBe('insufficient-attestations');
  });

  it('refuses a credential delegated by the wrong owner', async () => {
    const rec = markAgentRecord({ agentId: DAVID_AGENT, delegatedBy: DAVID });
    const credential = await markCredential(rec);
    const r = await admitAgentRequest({
      request: request({ fromAgent: DAVID_AGENT }, credential.id),
      advertisement: davidAdvertises,
      senderPodUrl: MARK_POD,
      fetchProfile: async () => createOwnerProfile(DAVID, 'David', [rec]),
      fetchCredential: async () => credential,
      verifier: makeWalletDelegationVerifier(),
      requiredVerbs: ['publish'],
      requesterAttestations: 3,
    });
    expect(r.refusal).toBe('wrong-delegating-owner');
  });
});
