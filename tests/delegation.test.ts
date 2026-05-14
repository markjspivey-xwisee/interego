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
  createOwnerProfile,
  addAuthorizedAgent,
  removeAuthorizedAgent,
  createDelegationCredential,
  delegationCredentialToJsonLd,
  verifyDelegation,
} from '../src/index.js';
import type { IRI, AuthorizedAgentData, OwnerProfileData } from '../src/index.js';

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
});
