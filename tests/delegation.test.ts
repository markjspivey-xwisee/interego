/**
 * Tests for src/model/delegation.ts — the owner/agent delegation model.
 *
 * verifyDelegation is the authorization gate (registry membership +
 * revocation + temporal validity); a regression here is a security
 * hole. These functions shipped with no direct test coverage —
 * federation.test.ts exercises only the Turtle round-trip.
 */

import { describe, it, expect } from 'vitest';
import {
  addAuthorizedAgent,
  canonicalCredentialPayload,
  createDelegationCredential,
  createSignedDelegationCredential,
  createOwnerProfile,
  delegationCredentialToJsonLd,
  parseDelegationCredential,
  removeAuthorizedAgent,
  verifyDelegation,
} from '@interego/core';
import type {
  AgentDelegationCredential,
  AuthorizedAgentData,
  DelegationSigner,
  DelegationVerifier,
  IRI,
  OwnerProfileData,
} from '@interego/core';

const OWNER = 'https://pod.example/alice/profile#me' as IRI;
const POD = 'https://pod.example/alice/' as IRI;

function agent(overrides: Partial<AuthorizedAgentData> = {}): AuthorizedAgentData {
  return {
    agentId: 'urn:agent:claude' as IRI,
    delegatedBy: OWNER,
    scope: 'ReadWrite',
    validFrom: '2020-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('createOwnerProfile', () => {
  it('creates a profile with a frozen, empty agent list by default', () => {
    const p = createOwnerProfile(OWNER, 'Alice');
    expect(p.webId).toBe(OWNER);
    expect(p.name).toBe('Alice');
    expect(p.authorizedAgents).toHaveLength(0);
    expect(Object.isFrozen(p.authorizedAgents)).toBe(true);
  });
  it('accepts an initial agent list', () => {
    const p = createOwnerProfile(OWNER, 'Alice', [agent()]);
    expect(p.authorizedAgents).toHaveLength(1);
  });
});

describe('addAuthorizedAgent', () => {
  it('appends an agent and leaves the original profile unmutated', () => {
    const p0 = createOwnerProfile(OWNER, 'Alice');
    const p1 = addAuthorizedAgent(p0, agent());
    expect(p0.authorizedAgents).toHaveLength(0);
    expect(p1.authorizedAgents).toHaveLength(1);
  });
  it('throws when the same agent is added twice while still active', () => {
    const p1 = addAuthorizedAgent(createOwnerProfile(OWNER), agent());
    expect(() => addAuthorizedAgent(p1, agent())).toThrow(/already authorized/);
  });
  it('allows re-adding an agent whose prior delegation was revoked', () => {
    let p = addAuthorizedAgent(createOwnerProfile(OWNER), agent());
    p = removeAuthorizedAgent(p, 'urn:agent:claude' as IRI);
    expect(() => addAuthorizedAgent(p, agent())).not.toThrow();
  });
});

describe('removeAuthorizedAgent', () => {
  it('marks the matching agent revoked without dropping it', () => {
    const p1 = addAuthorizedAgent(createOwnerProfile(OWNER), agent());
    const p2 = removeAuthorizedAgent(p1, 'urn:agent:claude' as IRI);
    expect(p2.authorizedAgents).toHaveLength(1);
    expect(p2.authorizedAgents[0]?.revoked).toBe(true);
  });
  it('is a no-op for an unknown agent id', () => {
    const p1 = addAuthorizedAgent(createOwnerProfile(OWNER), agent());
    const p2 = removeAuthorizedAgent(p1, 'urn:agent:nobody' as IRI);
    expect(p2.authorizedAgents[0]?.revoked).toBeUndefined();
  });
});

describe('createDelegationCredential', () => {
  const owner = createOwnerProfile(OWNER, 'Alice');

  it('maps each scope to the right action set', () => {
    const cases: Array<[AuthorizedAgentData['scope'], string[]]> = [
      ['ReadWrite', ['publish', 'discover', 'subscribe']],
      ['ReadOnly', ['discover', 'subscribe']],
      ['PublishOnly', ['publish']],
      ['DiscoverOnly', ['discover']],
    ];
    for (const [scope, expected] of cases) {
      const cred = createDelegationCredential(owner, agent({ scope }), POD);
      expect(cred.credentialSubject.scope).toEqual(expected);
    }
  });

  it('builds a VC with issuer, subject, and a pod-scoped credential id', () => {
    const cred = createDelegationCredential(owner, agent(), POD);
    expect(cred.type).toContain('VerifiableCredential');
    expect(cred.type).toContain('AgentDelegation');
    expect(cred.issuer).toBe(OWNER);
    expect(cred.credentialSubject.id).toBe('urn:agent:claude');
    expect(cred.credentialSubject.pod).toBe(POD);
    expect(cred.id.startsWith(POD)).toBe(true);
    expect(cred.id.endsWith('.jsonld')).toBe(true);
  });

  it('carries the agent expiry onto the credential', () => {
    const cred = createDelegationCredential(owner, agent({ validUntil: '2030-01-01T00:00:00Z' }), POD);
    expect(cred.expirationDate).toBe('2030-01-01T00:00:00Z');
  });
});

describe('delegationCredentialToJsonLd', () => {
  const owner = createOwnerProfile(OWNER, 'Alice');

  it('emits valid JSON-LD with the W3C VC context', () => {
    const cred = createDelegationCredential(owner, agent(), POD);
    const doc = JSON.parse(delegationCredentialToJsonLd(cred));
    expect(doc['@context']).toContain('https://www.w3.org/2018/credentials/v1');
    expect(doc.issuer).toBe(OWNER);
    expect(doc.credentialSubject.id).toBe('urn:agent:claude');
    expect(doc.credentialSubject.scope).toEqual(['publish', 'discover', 'subscribe']);
  });

  it('omits expirationDate when the agent has no expiry', () => {
    const cred = createDelegationCredential(owner, agent(), POD);
    const doc = JSON.parse(delegationCredentialToJsonLd(cred));
    expect('expirationDate' in doc).toBe(false);
  });

  it('includes expirationDate when the agent has one', () => {
    const cred = createDelegationCredential(owner, agent({ validUntil: '2030-01-01T00:00:00Z' }), POD);
    const doc = JSON.parse(delegationCredentialToJsonLd(cred));
    expect(doc.expirationDate).toBe('2030-01-01T00:00:00Z');
  });
});

describe('verifyDelegation', () => {
  const profileWith = (a: AuthorizedAgentData): OwnerProfileData =>
    createOwnerProfile(OWNER, 'Alice', [a]);
  const fetcher = (p: OwnerProfileData | null) => async () => p;

  it('accepts an active, in-window agent and reports its scope', async () => {
    const r = await verifyDelegation('urn:agent:claude' as IRI, POD, fetcher(profileWith(agent())));
    expect(r.valid).toBe(true);
    expect(r.owner).toBe(OWNER);
    expect(r.scope).toBe('ReadWrite');
  });

  it('rejects when no profile / registry is found on the pod', async () => {
    const r = await verifyDelegation('urn:agent:claude' as IRI, POD, fetcher(null));
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/No agent registry/);
  });

  it('rejects an agent absent from the registry', async () => {
    const r = await verifyDelegation('urn:agent:ghost' as IRI, POD, fetcher(profileWith(agent())));
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not listed/);
  });

  it('rejects a revoked delegation', async () => {
    const r = await verifyDelegation('urn:agent:claude' as IRI, POD, fetcher(profileWith(agent({ revoked: true }))));
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/revoked/);
  });

  it('rejects a delegation that has not started yet', async () => {
    const r = await verifyDelegation(
      'urn:agent:claude' as IRI, POD,
      fetcher(profileWith(agent({ validFrom: '2999-01-01T00:00:00Z' }))),
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not yet valid/);
  });

  it('rejects an expired delegation', async () => {
    const r = await verifyDelegation(
      'urn:agent:claude' as IRI, POD,
      fetcher(profileWith(agent({ validUntil: '2000-01-01T00:00:00Z' }))),
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });

  it('reports trustLevel=SelfAsserted when no verifier is supplied', async () => {
    const r = await verifyDelegation('urn:agent:claude' as IRI, POD, fetcher(profileWith(agent())));
    expect(r.valid).toBe(true);
    expect(r.trustLevel).toBe('SelfAsserted');
    expect(r.chainLength).toBe(1);
  });
});

// ── Signed VC chain ──────────────────────────────────────────
//
// The chain-walking path is the actual security boundary: registry
// membership alone is not a cryptographic claim. These tests confirm
// (a) signed credentials round-trip through canonicalize/sign/verify
// without losing fidelity, (b) tampering with the credential body or
// the proof invalidates verification, (c) revoking the agent on the
// registry kills the verification even when the signed VC is intact,
// and (d) a sub-delegation chain (owner -> agent A -> agent B) walks
// up to the pod owner and produces chainLength=2.

const OWNER_ADDRESS = '0xowner000000000000000000000000000000000001';
const PARENT_ADDRESS = '0xparent00000000000000000000000000000000002';

/** Toy signer — returns a deterministic "signature" tag derived from
 *  the payload + the signer address. Verifier below recovers by
 *  splitting the tag; tampering with the payload breaks the recovery. */
function makeToySigner(address: string): DelegationSigner {
  return async (canonicalPayload: string) => {
    const signature = `${address}|${canonicalPayload.length}|${canonicalPayload.slice(0, 32)}`;
    return {
      signature,
      signerAddress: address,
      verificationMethod: `did:ethr:${address}` as IRI,
    };
  };
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

describe('createSignedDelegationCredential', () => {
  const owner = createOwnerProfile(OWNER, 'Alice');

  it('attaches a Data-Integrity-shaped proof block to the credential', async () => {
    const cred = await createSignedDelegationCredential(owner, agent(), POD, makeToySigner(OWNER_ADDRESS));
    expect(cred.proof).toBeDefined();
    expect(cred.proof?.type).toBe('EcdsaSecp256k1Signature2019');
    expect(cred.proof?.proofPurpose).toBe('assertionMethod');
    expect(cred.proof?.signerAddress).toBe(OWNER_ADDRESS);
    expect(cred.proof?.verificationMethod).toBe(`did:ethr:${OWNER_ADDRESS}`);
  });

  it('produces a canonical payload that round-trips byte-for-byte', async () => {
    const cred = await createSignedDelegationCredential(owner, agent(), POD, makeToySigner(OWNER_ADDRESS));
    const canonical = canonicalCredentialPayload(cred);
    // Re-parsing the JSON-LD form must yield a credential whose canonical
    // payload is identical to the original — otherwise verification
    // would fail on any round-trip through the pod.
    const jsonLd = delegationCredentialToJsonLd(cred);
    const reparsed = parseDelegationCredential(jsonLd);
    expect(canonicalCredentialPayload(reparsed)).toBe(canonical);
  });

  it('survives a verify-after-sign round-trip', async () => {
    const cred = await createSignedDelegationCredential(owner, agent(), POD, makeToySigner(OWNER_ADDRESS));
    const ok = await toyVerifier(canonicalCredentialPayload(cred), cred.proof!);
    expect(ok).toBe(true);
  });

  it('rejects verification when the credential body is tampered', async () => {
    const cred = await createSignedDelegationCredential(owner, agent(), POD, makeToySigner(OWNER_ADDRESS));
    const tampered: AgentDelegationCredential = {
      ...cred,
      credentialSubject: {
        ...cred.credentialSubject,
        // attacker tries to elevate scope post-signing
        scope: ['publish', 'discover', 'subscribe', 'revoke-everyone'],
      },
    };
    const ok = await toyVerifier(canonicalCredentialPayload(tampered), cred.proof!);
    expect(ok).toBe(false);
  });

  it('rejects verification when the proof.signerAddress is swapped', async () => {
    const cred = await createSignedDelegationCredential(owner, agent(), POD, makeToySigner(OWNER_ADDRESS));
    const swapped = {
      ...cred.proof!,
      signerAddress: '0ximposter000000000000000000000000000000beef',
    };
    const ok = await toyVerifier(canonicalCredentialPayload(cred), swapped);
    expect(ok).toBe(false);
  });
});

describe('verifyDelegation (chain mode)', () => {
  it('upgrades the trust label to CryptographicallyVerified when the signed VC verifies', async () => {
    const owner = createOwnerProfile(OWNER, 'Alice', [agent()]);
    const cred = await createSignedDelegationCredential(owner, owner.authorizedAgents[0]!, POD, makeToySigner(OWNER_ADDRESS));
    const r = await verifyDelegation('urn:agent:claude' as IRI, POD, async () => owner, {
      fetchCredential: async () => cred,
      verifier: toyVerifier,
    });
    expect(r.valid).toBe(true);
    expect(r.trustLevel).toBe('CryptographicallyVerified');
    expect(r.chainLength).toBe(1);
  });

  it('refuses to upgrade when the credential is unsigned', async () => {
    const owner = createOwnerProfile(OWNER, 'Alice', [agent()]);
    const unsigned = createDelegationCredential(owner, owner.authorizedAgents[0]!, POD);
    const r = await verifyDelegation('urn:agent:claude' as IRI, POD, async () => owner, {
      fetchCredential: async () => unsigned,
      verifier: toyVerifier,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/unsigned/);
  });

  it('refuses to upgrade when the credential is missing on the pod', async () => {
    const owner = createOwnerProfile(OWNER, 'Alice', [agent()]);
    const r = await verifyDelegation('urn:agent:claude' as IRI, POD, async () => owner, {
      fetchCredential: async () => null,
      verifier: toyVerifier,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/No signed delegation credential/);
  });

  it('rejects a verified credential after the agent is revoked on the registry', async () => {
    const ownerActive = createOwnerProfile(OWNER, 'Alice', [agent()]);
    const cred = await createSignedDelegationCredential(ownerActive, ownerActive.authorizedAgents[0]!, POD, makeToySigner(OWNER_ADDRESS));
    const ownerRevoked = removeAuthorizedAgent(ownerActive, 'urn:agent:claude' as IRI);
    const r = await verifyDelegation('urn:agent:claude' as IRI, POD, async () => ownerRevoked, {
      fetchCredential: async () => cred,
      verifier: toyVerifier,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/revoked/);
  });

  it('rejects a tampered signature', async () => {
    const owner = createOwnerProfile(OWNER, 'Alice', [agent()]);
    const cred = await createSignedDelegationCredential(owner, owner.authorizedAgents[0]!, POD, makeToySigner(OWNER_ADDRESS));
    const tampered: AgentDelegationCredential = {
      ...cred,
      proof: { ...cred.proof!, proofValue: '0xdeadbeef|0|garbage' },
    };
    const r = await verifyDelegation('urn:agent:claude' as IRI, POD, async () => owner, {
      fetchCredential: async () => tampered,
      verifier: toyVerifier,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/invalid signature/);
  });

  it('walks a sub-delegation chain and reports chainLength=2', async () => {
    // Owner authorizes parent agent; parent agent re-delegates to a child agent.
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
    const r = await verifyDelegation(CHILD, POD, async () => owner, {
      fetchCredential: async (_url, aid) => (aid === CHILD ? childCred : parentCred),
      verifier: toyVerifier,
    });
    expect(r.valid).toBe(true);
    expect(r.trustLevel).toBe('CryptographicallyVerified');
    expect(r.chainLength).toBe(2);
  });

  it('aborts the walk if the sub-delegating parent has been revoked', async () => {
    const PARENT = 'urn:agent:parent' as IRI;
    const CHILD = 'urn:agent:child' as IRI;
    const parentAgent: AuthorizedAgentData = {
      agentId: PARENT, delegatedBy: OWNER, scope: 'ReadWrite', validFrom: '2020-01-01T00:00:00Z', revoked: true,
    };
    const childAgent: AuthorizedAgentData = {
      agentId: CHILD, delegatedBy: PARENT, scope: 'ReadWrite', validFrom: '2020-01-01T00:00:00Z',
    };
    const owner = createOwnerProfile(OWNER, 'Alice', [parentAgent, childAgent]);
    const parentCred = await createSignedDelegationCredential(owner, parentAgent, POD, makeToySigner(OWNER_ADDRESS));
    const childCred = await createSignedDelegationCredential(owner, childAgent, POD, makeToySigner(PARENT_ADDRESS));
    const r = await verifyDelegation(CHILD, POD, async () => owner, {
      fetchCredential: async (_url, aid) => (aid === CHILD ? childCred : parentCred),
      verifier: toyVerifier,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/revoked/);
  });
});
