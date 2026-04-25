/**
 * Passport tests — capability passport, persistent agent biography.
 */

import { describe, it, expect } from 'vitest';
import type { IRI } from '../src/model/types.js';
import {
  createPassport,
  recordLifeEvent,
  stateValue,
  registerOn,
  migrateInfrastructure,
  demonstratedCapabilities,
  activeValues,
  passportToDescriptor,
  passportSummary,
  type LifeEvent,
} from '../src/passport/index.js';

const ALICE = 'urn:agent:alice' as IRI;
const POD = 'https://pod.example/alice/';

describe('passport — basic ops', () => {
  it('creates a fresh passport', () => {
    const p = createPassport({ agentIdentity: ALICE, currentPod: POD });
    expect(p.agentIdentity).toBe(ALICE);
    expect(p.version).toBe(1);
    expect(p.lifeEvents).toHaveLength(0);
  });

  it('records life events + bumps version', () => {
    let p = createPassport({ agentIdentity: ALICE, currentPod: POD });
    const event: LifeEvent = {
      id: 'urn:event:1' as IRI,
      kind: 'capability-acquisition',
      at: '2026-04-24T12:00:00Z',
      description: 'first code review',
      evidence: ['urn:desc:review-1' as IRI],
      details: { capability: 'code:Review' },
    };
    p = recordLifeEvent(p, event);
    expect(p.version).toBe(2);
    expect(p.lifeEvents).toHaveLength(1);
  });

  it('demonstratedCapabilities returns earliest evidence per capability', () => {
    let p = createPassport({ agentIdentity: ALICE, currentPod: POD });
    p = recordLifeEvent(p, {
      id: 'urn:e:1' as IRI, kind: 'capability-acquisition',
      at: '2026-04-24T12:00:00Z', description: 'first review',
      evidence: ['urn:d:1' as IRI], details: { capability: 'code:Review' },
    });
    p = recordLifeEvent(p, {
      id: 'urn:e:2' as IRI, kind: 'capability-acquisition',
      at: '2026-04-25T12:00:00Z', description: 'another review',
      evidence: ['urn:d:2' as IRI], details: { capability: 'code:Review' },
    });
    const caps = demonstratedCapabilities(p);
    expect(caps['code:Review']?.id).toBe('urn:e:1'); // earliest
  });
});

describe('passport — values', () => {
  it('records stated values + reports active set', () => {
    let p = createPassport({ agentIdentity: ALICE, currentPod: POD });
    p = stateValue(p, {
      statement: 'always cite sources',
      assertedAt: '2026-04-24T12:00:00Z',
    });
    p = stateValue(p, {
      statement: 'refuse off-topic requests',
      assertedAt: '2026-04-24T12:00:00Z',
    });
    expect(activeValues(p)).toHaveLength(2);
  });

  it('retracted values drop out of active', () => {
    let p = createPassport({ agentIdentity: ALICE, currentPod: POD });
    p = stateValue(p, {
      statement: 'never escalate',
      assertedAt: '2026-04-24T12:00:00Z',
      retractedAt: '2026-04-24T13:00:00Z',
      retractionReason: 'reconsidered',
    });
    expect(activeValues(p, '2026-04-24T14:00:00Z')).toHaveLength(0);
    // Before retraction, it was active
    expect(activeValues(p, '2026-04-24T12:30:00Z')).toHaveLength(1);
  });
});

describe('passport — registry tracking', () => {
  it('registerOn deduplicates', () => {
    let p = createPassport({ agentIdentity: ALICE, currentPod: POD });
    p = registerOn(p, 'urn:registry:r1' as IRI);
    p = registerOn(p, 'urn:registry:r2' as IRI);
    p = registerOn(p, 'urn:registry:r1' as IRI); // dup
    expect(p.registeredOn).toHaveLength(2);
  });
});

describe('passport — infrastructure migration', () => {
  it('records migration as a LifeEvent + updates currentPod', () => {
    let p = createPassport({ agentIdentity: ALICE, currentPod: POD });
    p = migrateInfrastructure(p, {
      newPod: 'https://newpod.example/alice/',
      newInfrastructure: 'openclaw-v0.5.0',
      at: '2026-04-25T10:00:00Z',
    });
    expect(p.currentPod).toBe('https://newpod.example/alice/');
    expect(p.lifeEvents).toHaveLength(1);
    expect(p.lifeEvents[0]?.kind).toBe('infrastructure-migration');
    expect(p.previousIdentities).toHaveLength(0); // identity didn't change
  });

  it('migrating to a new identity preserves the old one', () => {
    let p = createPassport({ agentIdentity: ALICE, currentPod: POD });
    p = migrateInfrastructure(p, {
      newPod: 'https://new.example/',
      newInfrastructure: 'rebrand',
      newAgentIdentity: 'did:web:alice.new.id' as IRI,
    });
    expect(p.agentIdentity).toBe('did:web:alice.new.id');
    expect(p.previousIdentities).toContain(ALICE);
  });
});

describe('passport — descriptor + summary', () => {
  it('passportToDescriptor produces a 6-facet ContextDescriptor', () => {
    const p = createPassport({ agentIdentity: ALICE, currentPod: POD });
    const desc = passportToDescriptor(p);
    expect(desc.facets).toHaveLength(6);
    expect(desc.describes).toContain(ALICE);
  });

  it('passportSummary aggregates state for at-a-glance audit', () => {
    let p = createPassport({ agentIdentity: ALICE, currentPod: POD });
    p = recordLifeEvent(p, {
      id: 'urn:e:1' as IRI, kind: 'capability-acquisition',
      at: '2026-04-24T12:00:00Z', description: 'x',
      evidence: [], details: { capability: 'cap-1' },
    });
    p = stateValue(p, { statement: 'v', assertedAt: '2026-04-24T12:00:00Z' });
    p = registerOn(p, 'urn:registry:r1' as IRI);
    const s = passportSummary(p);
    expect(s.totalLifeEvents).toBe(1);
    expect(s.eventBreakdown['capability-acquisition']).toBe(1);
    expect(s.activeValues).toBe(1);
    expect(s.registeredOnCount).toBe(1);
    expect(s.demonstratedCapabilitiesCount).toBe(1);
  });
});
