/**
 * Regression test for FIX 7 — verify_agent envelope.
 *
 * Both MCP shims (the stdio server under `mcp-server/` and the HTTP
 * relay under `deploy/mcp-relay/`) wrap `verifyAgentDelegation` in a
 * shared response envelope (`buildVerifyAgentEnvelope`). Downstream
 * clients branch on `delegationChain != null` rather than parsing the
 * `trustLevel` string — this test pins that contract.
 *
 * Before this fix the stdio shim ran the registry-only path
 * (`verifier:` omitted) and emitted a multi-line text summary, so
 * `chainLength`, `trustLevel`, and `delegationChain` were not
 * observable to MCP clients at all — exactly the gap diagnosed
 * against the live relay deployment.
 */

import { describe, it, expect } from 'vitest';
import {
  addAuthorizedAgent,
  createDelegationCredential,
  createOwnerProfile,
  createSignedDelegationCredential,
  verifyDelegation,
} from '@interego/core';
import { buildVerifyAgentEnvelope } from '@interego/solid';
import type {
  AgentDelegationCredential,
  AuthorizedAgentData,
  DelegationSigner,
  DelegationVerification,
  DelegationVerifier,
  IRI,
} from '@interego/core';

const OWNER = 'https://pod.example/alice/profile#me' as IRI;
const POD = 'https://pod.example/alice/' as IRI;
const OWNER_ADDRESS = '0xowner000000000000000000000000000000000001';
const PARENT_ADDRESS = '0xparent00000000000000000000000000000000002';

function makeToySigner(address: string): DelegationSigner {
  return async (canonicalPayload: string) => ({
    signature: `${address}|${canonicalPayload.length}|${canonicalPayload.slice(0, 32)}`,
    signerAddress: address,
    verificationMethod: `did:ethr:${address}` as IRI,
  });
}

const toyVerifier: DelegationVerifier = async (canonicalPayload, proof) => {
  const parts = proof.proofValue.split('|');
  if (parts.length !== 3) return false;
  const [recoveredAddress, length, prefix] = parts;
  if (recoveredAddress?.toLowerCase() !== proof.signerAddress.toLowerCase()) return false;
  if (parseInt(length ?? '-1', 10) !== canonicalPayload.length) return false;
  if (prefix !== canonicalPayload.slice(0, 32)) return false;
  return true;
};

function agent(overrides: Partial<AuthorizedAgentData> = {}): AuthorizedAgentData {
  return {
    agentId: 'urn:agent:claude' as IRI,
    delegatedBy: OWNER,
    scope: 'ReadWrite',
    validFrom: '2020-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildVerifyAgentEnvelope — verify_agent response shape', () => {
  it('returns chainLength>=1 + delegationChain.anchored=true for a signed + registered agent', async () => {
    const owner = createOwnerProfile(OWNER, 'Alice', [agent()]);
    const cred = await createSignedDelegationCredential(
      owner,
      owner.authorizedAgents[0]!,
      POD,
      makeToySigner(OWNER_ADDRESS),
    );
    const result = await verifyDelegation('urn:agent:claude' as IRI, POD, async () => owner, {
      fetchCredential: async () => cred,
      verifier: toyVerifier,
    });
    const envelope = buildVerifyAgentEnvelope(result);

    expect(envelope.verified).toBe(true);
    expect(envelope.valid).toBe(true);
    expect(envelope.trustLevel).toBe('CryptographicallyVerified');
    expect(envelope.chainLength).toBeGreaterThanOrEqual(1);
    expect(envelope.delegationChain).not.toBeNull();
    expect(envelope.delegationChain?.anchored).toBe(true);
    expect(envelope.delegationChain?.length).toBe(envelope.chainLength);
    expect(envelope.delegationChain?.owner).toBe(OWNER);
    expect(envelope.delegationChain?.agent).toBe('urn:agent:claude');
    expect(envelope.reason).toBeNull();
  });

  it('reports chainLength=2 + length=2 on a verified sub-delegation chain', async () => {
    const PARENT = 'urn:agent:parent' as IRI;
    const CHILD = 'urn:agent:child' as IRI;
    const parentAgent: AuthorizedAgentData = {
      agentId: PARENT, delegatedBy: OWNER, scope: 'ReadWrite', validFrom: '2020-01-01T00:00:00Z',
    };
    const childAgent: AuthorizedAgentData = {
      agentId: CHILD, delegatedBy: PARENT, scope: 'ReadWrite', validFrom: '2020-01-01T00:00:00Z',
    };
    const owner = createOwnerProfile(OWNER, 'Alice', [parentAgent, childAgent]);
    const parentCred = await createSignedDelegationCredential(owner, parentAgent, POD, makeToySigner(OWNER_ADDRESS));
    const childCred = await createSignedDelegationCredential(owner, childAgent, POD, makeToySigner(PARENT_ADDRESS));

    const result = await verifyDelegation(CHILD, POD, async () => owner, {
      fetchCredential: async (_url, aid) => (aid === CHILD ? childCred : parentCred),
      verifier: toyVerifier,
    });
    const envelope = buildVerifyAgentEnvelope(result);

    expect(envelope.verified).toBe(true);
    expect(envelope.chainLength).toBe(2);
    expect(envelope.delegationChain).not.toBeNull();
    expect(envelope.delegationChain?.length).toBe(2);
    expect(envelope.trustLevel).toBe('CryptographicallyVerified');
  });

  it('returns delegationChain=null + trustLevel=SelfAsserted when no verifier is supplied (registry-only path)', async () => {
    const owner = createOwnerProfile(OWNER, 'Alice', [agent()]);
    // Registry-only mode — exactly what the stdio shim USED to do before
    // this fix. Trust must fall back to SelfAsserted, and `delegationChain`
    // must be null so clients don't mistake registry membership for a
    // cryptographically anchored delegation.
    const result = await verifyDelegation('urn:agent:claude' as IRI, POD, async () => owner);
    const envelope = buildVerifyAgentEnvelope(result);

    expect(envelope.verified).toBe(true);
    expect(envelope.trustLevel).toBe('SelfAsserted');
    expect(envelope.delegationChain).toBeNull();
    expect(envelope.chainLength).toBeGreaterThanOrEqual(1); // registry hit still has length 1
  });

  it('returns delegationChain=null + reason set when the credential is unsigned (signature path skipped)', async () => {
    const owner = createOwnerProfile(OWNER, 'Alice', [agent()]);
    const unsigned = createDelegationCredential(owner, owner.authorizedAgents[0]!, POD);
    const result = await verifyDelegation('urn:agent:claude' as IRI, POD, async () => owner, {
      fetchCredential: async () => unsigned,
      verifier: toyVerifier,
    });
    const envelope = buildVerifyAgentEnvelope(result);

    expect(envelope.verified).toBe(false);
    expect(envelope.valid).toBe(false);
    expect(envelope.delegationChain).toBeNull();
    expect(envelope.reason).toMatch(/unsigned/);
  });

  it('returns delegationChain=null + reason set when the credential is missing on the pod', async () => {
    const owner = createOwnerProfile(OWNER, 'Alice', [agent()]);
    const result = await verifyDelegation('urn:agent:claude' as IRI, POD, async () => owner, {
      fetchCredential: async () => null,
      verifier: toyVerifier,
    });
    const envelope = buildVerifyAgentEnvelope(result);

    expect(envelope.verified).toBe(false);
    expect(envelope.delegationChain).toBeNull();
    expect(envelope.reason).toMatch(/No signed delegation credential/);
  });

  it('returns delegationChain=null + reason set when the chain signature is tampered', async () => {
    const owner = createOwnerProfile(OWNER, 'Alice', [agent()]);
    const cred = await createSignedDelegationCredential(owner, owner.authorizedAgents[0]!, POD, makeToySigner(OWNER_ADDRESS));
    const tampered: AgentDelegationCredential = {
      ...cred,
      proof: { ...cred.proof!, proofValue: '0xdeadbeef|0|garbage' },
    };
    const result = await verifyDelegation('urn:agent:claude' as IRI, POD, async () => owner, {
      fetchCredential: async () => tampered,
      verifier: toyVerifier,
    });
    const envelope = buildVerifyAgentEnvelope(result);

    expect(envelope.verified).toBe(false);
    expect(envelope.delegationChain).toBeNull();
    expect(envelope.trustLevel).toBe('SelfAsserted');
    expect(envelope.reason).toMatch(/invalid signature/);
  });

  it('returns chainLength=0 + verified=false + delegationChain=null when the agent is absent from the registry', async () => {
    const owner = createOwnerProfile(OWNER, 'Alice', [agent()]);
    const result = await verifyDelegation('urn:agent:ghost' as IRI, POD, async () => owner);
    const envelope = buildVerifyAgentEnvelope(result);

    expect(envelope.verified).toBe(false);
    expect(envelope.chainLength).toBe(0);
    expect(envelope.delegationChain).toBeNull();
    expect(envelope.reason).toMatch(/not listed/);
  });

  it('preserves raw fields (valid/owner/agent/scope) alongside the new envelope keys for back-compat', async () => {
    const owner = createOwnerProfile(OWNER, 'Alice', [agent()]);
    const cred = await createSignedDelegationCredential(owner, owner.authorizedAgents[0]!, POD, makeToySigner(OWNER_ADDRESS));
    const result: DelegationVerification = await verifyDelegation('urn:agent:claude' as IRI, POD, async () => owner, {
      fetchCredential: async () => cred,
      verifier: toyVerifier,
    });
    const envelope = buildVerifyAgentEnvelope(result);

    // The raw DelegationVerification keys must still be reachable so the
    // v0.4 wire shape (`valid`, `owner`, `agent`, `scope`) keeps working
    // even as new clients move to the `verified` + `delegationChain` keys.
    expect(envelope.valid).toBe(result.valid);
    expect(envelope.owner).toBe(result.owner);
    expect(envelope.agent).toBe(result.agent);
    expect(envelope.scope).toBe(result.scope);
  });
});

describe('buildVerifyAgentEnvelope — the verdict names the pod it is about', () => {
  // ★ WHY A VERDICT WITHOUT A SUBJECT IS THE WHOLE DEFECT AND NOT A COSMETIC GAP.
  // `verify_agent` read `pod_url` and ignored `pod_name`, while the relay's /mcp
  // dispatcher auto-filled `pod_url` with the CALLER'S OWN pod. So asking about someone
  // else's pod returned `verified: true, CryptographicallyVerified` about your own
  // (measured live). The envelope carried no field naming the pod, so the answer to the
  // question asked and the answer to a different question were byte-identical documents
  // — there was nothing in the response for a caller to check. `get_current_head` had
  // the SAME selector bug and it was visible in one call, because that tool named its
  // subject. Naming the subject is what makes an authority answer falsifiable.
  const anyResult = { valid: false, agent: 'urn:agent:claude' as IRI, reason: 'nope' };

  it('carries the subject pod under both spellings when one is supplied', () => {
    const envelope = buildVerifyAgentEnvelope(anyResult, POD);
    expect(envelope.subject_pod_url).toBe(POD);
    expect(envelope.subjectPodUrl).toBe(POD);
  });

  it('a positive verdict names its subject too — the case where it matters most', async () => {
    const owner = createOwnerProfile(OWNER, 'Alice', [agent()]);
    const cred = await createSignedDelegationCredential(
      owner, owner.authorizedAgents[0]!, POD, makeToySigner(OWNER_ADDRESS));
    const result = await verifyDelegation('urn:agent:claude' as IRI, POD, async () => owner, {
      fetchCredential: async () => cred, verifier: toyVerifier,
    });
    const envelope = buildVerifyAgentEnvelope(result, POD);
    expect(envelope.verified).toBe(true);
    expect(envelope.subject_pod_url).toBe(POD);
  });

  it('two verdicts about DIFFERENT pods are distinguishable documents', () => {
    const mine = buildVerifyAgentEnvelope(anyResult, POD);
    const theirs = buildVerifyAgentEnvelope(anyResult, 'https://pod.example/bee/');
    // Before the subject existed these serialized identically, which is exactly why the
    // wrong answer was indistinguishable from the right one.
    expect(JSON.stringify(mine)).not.toBe(JSON.stringify(theirs));
    expect(mine.subject_pod_url).not.toBe(theirs.subject_pod_url);
  });

  it('is explicitly null — never absent — when no subject was resolved', () => {
    const envelope = buildVerifyAgentEnvelope(anyResult);
    expect(envelope.subject_pod_url).toBeNull();
    expect('subject_pod_url' in envelope).toBe(true);
  });
});

describe('buildVerifyAgentEnvelope — chain rejected after registry revocation', () => {
  it('downgrades to SelfAsserted-with-reason when the signed VC is intact but the agent was revoked on the registry', async () => {
    const ownerActive = createOwnerProfile(OWNER, 'Alice', [agent()]);
    const cred = await createSignedDelegationCredential(ownerActive, ownerActive.authorizedAgents[0]!, POD, makeToySigner(OWNER_ADDRESS));
    const ownerRevoked = addAuthorizedAgent(createOwnerProfile(OWNER, 'Alice'), agent({ revoked: true }));

    const result = await verifyDelegation('urn:agent:claude' as IRI, POD, async () => ownerRevoked, {
      fetchCredential: async () => cred,
      verifier: toyVerifier,
    });
    const envelope = buildVerifyAgentEnvelope(result);

    expect(envelope.verified).toBe(false);
    expect(envelope.delegationChain).toBeNull();
    expect(envelope.reason).toMatch(/revoked/);
  });
});
