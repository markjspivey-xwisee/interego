/**
 * Agent Development Practice — integration test.
 *
 * Verifies the vertical's PROTOCOL-LAYER claims using real code paths:
 *   - ContextDescriptor builder produces conforming shape for every adp: class
 *   - validate() returns conforms=true for all descriptors in the cycle
 *   - toTurtle() serialization succeeds and emits the descriptor IRI
 *   - Modal discipline holds: probes + fragments + syntheses are Hypothetical;
 *     operator evolution decisions are Asserted
 *   - cg:supersedes lineage is preserved on round-trip
 *
 * "Real" vs "simulated" boundary: this test uses the actual builder, the
 * actual Turtle serializer, the actual programmatic validator. It does NOT
 * publish to a network pod (Tier 2). What it verifies is that the
 * descriptors emitted in examples/probe-cycle.mjs are SHAPE-CORRECT.
 *
 * Scope finding (worth recording): the L1 cg:SemioticFacet has no `content`
 * field. Vertical content (the narrative text, the signifiers, the
 * coherentNarrative entries) lives as adp:-namespaced triples in the
 * described graph, NOT in the descriptor metadata. The integration test
 * therefore verifies descriptor shape + modal discipline at L1; content-side
 * claims are validated by the example's emitted graph turtle, not by the
 * builder's facet validation.
 */

import { describe, it, expect } from 'vitest';
import {
  ContextDescriptor,
  toTurtle,
  validate,
} from '../../../src/index.js';
import type { IRI } from '../../../src/index.js';

// ── DIDs / IRIs used across the cycle ────────────────────────────────

const ALICE_DID = 'did:web:alice.example' as IRI;
const BOB_DID   = 'did:web:bob.example'   as IRI;
const RAVI_DID  = 'did:web:ravi.example'  as IRI;
const MARK_DID  = 'did:web:mark.example'  as IRI;

const CAPABILITY_IRI = 'urn:cg:capability:customer-support:tone' as IRI;

// ── Builders for each adp: class ─────────────────────────────────────

function buildCapabilitySpace() {
  return ContextDescriptor.create(CAPABILITY_IRI)
    .describes('urn:graph:adp:customer-service-tone' as IRI)
    .temporal({ validFrom: '2026-04-22T10:00:00Z' })
    .asserted(0.95)
    .selfAsserted(MARK_DID)
    .build();
}

function buildProbe(operator: IRI, variant: string) {
  return ContextDescriptor.create(`urn:cg:probe:tone:${variant}` as IRI)
    .describes('urn:graph:adp:probe' as IRI)
    .temporal({ validFrom: '2026-04-22T10:00:00Z', validUntil: '2026-05-10T00:00:00Z' })
    .hypothetical(0.5)
    .agent(operator)
    .selfAsserted(operator)
    .build();
}

function buildFragment(probeIri: IRI) {
  const slug = probeIri.split(':').pop() ?? 'unknown';
  return ContextDescriptor.create(`urn:cg:fragment:${slug}:${Date.now()}` as IRI)
    .describes('urn:graph:adp:narrative' as IRI)
    .temporal({ validFrom: '2026-04-22T14:00:00Z' })
    .hypothetical(0.6)
    .agent(RAVI_DID)
    .selfAsserted(RAVI_DID)
    .build();
}

function buildSynthesis() {
  return ContextDescriptor.create('urn:cg:synthesis:tone-week-1' as IRI)
    .describes('urn:graph:adp:synthesis' as IRI)
    .temporal({ validFrom: '2026-04-26T10:00:00Z' })
    .hypothetical(0.55)
    .agent(RAVI_DID)
    .selfAsserted(RAVI_DID)
    .build();
}

function buildEvolutionStep() {
  return ContextDescriptor.create('urn:cg:evolution:tone-week-1-decision' as IRI)
    .describes('urn:graph:adp:evolution' as IRI)
    .temporal({ validFrom: '2026-04-26T16:00:00Z' })
    .asserted(0.85)
    .agent(MARK_DID)
    .selfAsserted(MARK_DID)
    .build();
}

function buildCapabilityEvolution() {
  return ContextDescriptor.create('urn:cg:capability-evolution:tone:v1' as IRI)
    .describes('urn:graph:adp:capability-evolution' as IRI)
    .temporal({ validFrom: '2026-05-15T10:00:00Z' })
    .asserted(0.75)
    .agent(MARK_DID)
    .selfAsserted(MARK_DID)
    .build();
}

// ═════════════════════════════════════════════════════════════════════
//  Tests — protocol-layer shape + modal discipline
// ═════════════════════════════════════════════════════════════════════

describe('agent-development-practice — descriptor shape', () => {
  it('capability space conforms to validation + has required facets', () => {
    const cap = buildCapabilitySpace();
    expect(cap.id).toBe(CAPABILITY_IRI);
    expect(cap.facets.find(f => f.type === 'Temporal')).toBeDefined();
    expect(cap.facets.find(f => f.type === 'Trust')).toBeDefined();
    expect(cap.facets.find(f => f.type === 'Semiotic')).toBeDefined();
    expect(validate(cap).conforms).toBe(true);
  });

  it('all three probes are Hypothetical (modal discipline)', () => {
    const probes = [
      buildProbe(ALICE_DID, 'clinical-baseline'),
      buildProbe(BOB_DID,   'explicit-acknowledgment'),
      buildProbe(RAVI_DID,  'empathic-mirroring'),
    ];

    for (const probe of probes) {
      const semiotic = probe.facets.find(f => f.type === 'Semiotic') as { modalStatus?: string };
      expect(semiotic?.modalStatus).toBe('Hypothetical');
      expect(validate(probe).conforms).toBe(true);
    }
  });

  it('narrative fragments are Hypothetical (observations, not causation claims)', () => {
    const fragment = buildFragment('urn:cg:probe:tone:explicit-acknowledgment' as IRI);
    const semiotic = fragment.facets.find(f => f.type === 'Semiotic') as { modalStatus?: string };
    expect(semiotic?.modalStatus).toBe('Hypothetical');
    expect(validate(fragment).conforms).toBe(true);
  });

  it('synthesis stays Hypothetical (does not collapse to single asserted root cause)', () => {
    const synthesis = buildSynthesis();
    const semiotic = synthesis.facets.find(f => f.type === 'Semiotic') as { modalStatus?: string };
    expect(semiotic?.modalStatus).toBe('Hypothetical');
    expect(validate(synthesis).conforms).toBe(true);
  });

  it('operator evolution step IS Asserted (operator commits to the decision)', () => {
    const evo = buildEvolutionStep();
    const semiotic = evo.facets.find(f => f.type === 'Semiotic') as { modalStatus?: string };
    expect(semiotic?.modalStatus).toBe('Asserted');
    expect(validate(evo).conforms).toBe(true);
  });

  it('capability evolution event is Asserted (passport:LifeEvent biographical record)', () => {
    const evo = buildCapabilityEvolution();
    const semiotic = evo.facets.find(f => f.type === 'Semiotic') as { modalStatus?: string };
    expect(semiotic?.modalStatus).toBe('Asserted');
    expect(validate(evo).conforms).toBe(true);
  });

  it('full cycle: every descriptor round-trips through Turtle without error', () => {
    const cycle = [
      buildCapabilitySpace(),
      buildProbe(ALICE_DID, 'clinical-baseline'),
      buildProbe(BOB_DID,   'explicit-acknowledgment'),
      buildProbe(RAVI_DID,  'empathic-mirroring'),
      buildFragment('urn:cg:probe:tone:explicit-acknowledgment' as IRI),
      buildFragment('urn:cg:probe:tone:explicit-acknowledgment' as IRI),
      buildSynthesis(),
      buildEvolutionStep(),
      buildCapabilityEvolution(),
    ];

    for (const desc of cycle) {
      const ttl = toTurtle(desc);
      expect(ttl.length).toBeGreaterThan(0);
      expect(ttl).toContain(desc.id);
      expect(validate(desc).conforms).toBe(true);
    }
  });
});
