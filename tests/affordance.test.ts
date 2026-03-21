import { describe, it, expect, beforeEach } from 'vitest';
import {
  ContextDescriptor,
  computeAffordances,
  createAgentState,
  assimilateDescriptor,
  addDesire,
  commitToAffordance,
  createOODACycle,
  observe,
  orient,
  decide,
  act,
  evaluateSurprise,
  createStigmergicField,
  updateStigmergicField,
} from '../src/index.js';
import type { IRI, AgentProfile, Desire } from '../src/index.js';

// ── Test helpers ─────────────────────────────────────────────

const fullProfile: AgentProfile = {
  agentId: 'urn:agent:test:full' as IRI,
  ownerWebId: 'https://id.example.com/alice/profile#me' as IRI,
  delegationScope: 'ReadWrite',
  capabilities: ['discover', 'publish', 'compose', 'causal', 'pgsl', 'project', 'subscribe', 'verify', 'challenge', 'retract'],
  vocabularies: ['http://schema.org/' as IRI],
  trustPolicies: [
    { minTrustLevel: 'SelfAsserted', minConfidence: 0.5, requiredForAction: ['apply'] },
    { minTrustLevel: 'DelegatedTrust', minConfidence: 0.7, requiredForAction: ['forward'] },
  ],
  causalModels: [],
};

const readOnlyProfile: AgentProfile = {
  agentId: 'urn:agent:test:readonly' as IRI,
  delegationScope: 'ReadOnly',
  capabilities: ['discover', 'pgsl', 'subscribe'],
  vocabularies: [],
  trustPolicies: [],
  causalModels: [],
};

function buildAssertedDescriptor(confidence = 0.9): ReturnType<typeof ContextDescriptor.prototype.build> {
  return ContextDescriptor.create('urn:cg:test:asserted' as IRI)
    .describes('urn:graph:test:data' as IRI)
    .temporal({ validFrom: '2026-01-01T00:00:00Z' })
    .asserted(confidence)
    .selfAsserted('did:web:alice.example' as IRI)
    .federation({ origin: 'https://pod.example.com/alice/' as IRI, storageEndpoint: 'https://pod.example.com/alice/' as IRI, syncProtocol: 'SolidNotifications' })
    .version(1)
    .build();
}

function buildHypotheticalDescriptor(confidence = 0.5): ReturnType<typeof ContextDescriptor.prototype.build> {
  return ContextDescriptor.create('urn:cg:test:hypothetical' as IRI)
    .describes('urn:graph:test:hypothesis' as IRI)
    .temporal({ validFrom: '2026-01-01T00:00:00Z' })
    .semiotic({ modalStatus: 'Hypothetical', epistemicConfidence: confidence, groundTruth: false })
    .selfAsserted('did:web:bob.example' as IRI)
    .version(1)
    .build();
}

function buildRetractedDescriptor(): ReturnType<typeof ContextDescriptor.prototype.build> {
  return ContextDescriptor.create('urn:cg:test:retracted' as IRI)
    .describes('urn:graph:test:old' as IRI)
    .temporal({ validFrom: '2026-01-01T00:00:00Z' })
    .semiotic({ modalStatus: 'Retracted', epistemicConfidence: 0, groundTruth: false })
    .selfAsserted('did:web:alice.example' as IRI)
    .version(2)
    .build();
}

// ═════════════════════════════════════════════════════════════
//  Core Affordance Computation (Gibson + Norman)
// ═════════════════════════════════════════════════════════════

describe('Affordance Computation (Gibson + Norman)', () => {
  it('computes affordances for fully capable agent on asserted descriptor', () => {
    const desc = buildAssertedDescriptor(0.95);
    const result = computeAffordances(fullProfile, desc);

    expect(result.agent).toBe(fullProfile.agentId);
    expect(result.descriptor).toBe(desc.id);
    expect(result.affordances.length).toBeGreaterThan(0);

    // Asserted + high confidence + full capabilities → most actions afforded
    const available = result.affordances.filter(a => a.available);
    expect(available.length).toBeGreaterThanOrEqual(10);

    // 'read' should always be afforded
    const read = result.affordances.find(a => a.action === 'read');
    expect(read?.available).toBe(true);
  });

  it('blocks write actions for read-only agent (anti-affordance)', () => {
    const desc = buildAssertedDescriptor();
    const result = computeAffordances(readOnlyProfile, desc);

    // publish, compose, challenge, retract should be blocked
    const blocked = result.antiAffordances;
    const blockedActions = blocked.map(a => a.action);
    expect(blockedActions).toContain('compose');
    expect(blockedActions).toContain('challenge');
    expect(blockedActions).toContain('retract');
    expect(blockedActions).toContain('apply');

    // read should be available
    const read = result.affordances.find(a => a.action === 'read');
    expect(read?.available).toBe(true);
  });

  it('blocks "apply" for hypothetical descriptor with low confidence', () => {
    const desc = buildHypotheticalDescriptor(0.4);
    const result = computeAffordances(fullProfile, desc);

    const apply = result.affordances.find(a => a.action === 'apply');
    expect(apply?.available).toBe(false);

    // But 'compose' should still be available
    const compose = result.affordances.find(a => a.action === 'compose');
    expect(compose?.available).toBe(true);
  });

  it('blocks most actions for retracted descriptor', () => {
    const desc = buildRetractedDescriptor();
    const result = computeAffordances(fullProfile, desc);

    const apply = result.affordances.find(a => a.action === 'apply');
    expect(apply?.available).toBe(false);

    const forward = result.affordances.find(a => a.action === 'forward');
    expect(forward?.available).toBe(false);

    // read and ignore should still be available
    const read = result.affordances.find(a => a.action === 'read');
    expect(read?.available).toBe(true);
    const ignore = result.affordances.find(a => a.action === 'ignore');
    expect(ignore?.available).toBe(true);
  });

  it('extracts signifiers from facets', () => {
    const desc = buildAssertedDescriptor(0.95);
    const result = computeAffordances(fullProfile, desc);

    expect(result.signifiers.length).toBeGreaterThan(0);

    const semioticSignifier = result.signifiers.find(s => s.facetType === 'Semiotic');
    expect(semioticSignifier).toBeDefined();
    expect(semioticSignifier?.strength).toBe('strong'); // 0.95 > 0.8

    const trustSignifier = result.signifiers.find(s => s.facetType === 'Trust');
    expect(trustSignifier).toBeDefined();
  });

  it('enforces trust policy on forward action', () => {
    const desc = buildAssertedDescriptor(0.6);
    const result = computeAffordances(fullProfile, desc);

    // Trust policy requires DelegatedTrust for 'forward', but descriptor is SelfAsserted
    const forward = result.affordances.find(a => a.action === 'forward');
    expect(forward?.available).toBe(false);

    const antiForward = result.antiAffordances.find(a => a.action === 'forward');
    expect(antiForward?.blockedBy).toBe('trust');
  });

  it('includes SA levels (Endsley)', () => {
    const desc = buildAssertedDescriptor();
    const result = computeAffordances(fullProfile, desc);

    expect(result.saLevel.level1_perception.descriptorsDiscovered).toBe(1);
    expect(result.saLevel.level1_perception.facetTypesObserved.length).toBeGreaterThan(0);
    expect(result.saLevel.level2_comprehension.coherenceScore).toBeGreaterThan(0);
    expect(result.saLevel.level3_projection.projectionConfidence).toBeGreaterThan(0);
  });

  it('confidence reflects trust and epistemic factors', () => {
    const highConf = buildAssertedDescriptor(0.95);
    const lowConf = buildAssertedDescriptor(0.3);

    const highResult = computeAffordances(fullProfile, highConf);
    const lowResult = computeAffordances(fullProfile, lowConf);

    const highApply = highResult.affordances.find(a => a.action === 'read');
    const lowApply = lowResult.affordances.find(a => a.action === 'read');

    expect(highApply!.confidence).toBeGreaterThan(lowApply!.confidence);
  });
});

// ═════════════════════════════════════════════════════════════
//  Active Inference / Free Energy (Friston)
// ═════════════════════════════════════════════════════════════

describe('Active Inference (Friston)', () => {
  it('evaluates surprise for novel descriptor', () => {
    const state = createAgentState(fullProfile);
    const desc = buildAssertedDescriptor();

    const evaluation = evaluateSurprise(state, desc, fullProfile);

    expect(evaluation.descriptor).toBe(desc.id);
    expect(evaluation.surprise).toBeGreaterThanOrEqual(0);
    expect(evaluation.surprise).toBeLessThanOrEqual(1);
    expect(['accept', 'investigate', 'challenge', 'ignore']).toContain(evaluation.recommendedResponse);
  });

  it('low surprise for consistent descriptor → recommends accept', () => {
    const state = createAgentState(fullProfile);
    const desc = buildAssertedDescriptor(0.9);

    const evaluation = evaluateSurprise(state, desc, fullProfile);
    // No existing beliefs → low surprise
    expect(evaluation.recommendedResponse).toBe('accept');
  });

  it('higher surprise when conflicting beliefs exist', () => {
    let state = createAgentState(fullProfile);
    const desc1 = buildAssertedDescriptor(0.9);

    // Assimilate first descriptor
    const result1 = assimilateDescriptor(state, desc1, fullProfile);
    state = result1.state;

    // Now a conflicting descriptor (same graph, different confidence)
    const desc2 = ContextDescriptor.create('urn:cg:test:conflict' as IRI)
      .describes('urn:graph:test:data' as IRI) // same graph
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .asserted(0.3) // very different confidence
      .selfAsserted('did:web:mallory.example' as IRI)
      .version(1)
      .build();

    const eval2 = evaluateSurprise(state, desc2, fullProfile);
    expect(eval2.surprise).toBeGreaterThan(result1.evaluation.surprise);
  });
});

// ═════════════════════════════════════════════════════════════
//  BDI Agent State (Bratman)
// ═════════════════════════════════════════════════════════════

describe('BDI Agent State (Bratman)', () => {
  it('creates initial state with empty beliefs', () => {
    const state = createAgentState(fullProfile);
    expect(state.beliefs.size).toBe(0);
    expect(state.desires.length).toBe(0);
    expect(state.intentions.length).toBe(0);
  });

  it('assimilates descriptors into beliefs', () => {
    let state = createAgentState(fullProfile);
    const desc = buildAssertedDescriptor();

    const result = assimilateDescriptor(state, desc, fullProfile);
    state = result.state;

    expect(state.beliefs.size).toBe(1);
    expect(state.beliefs.has(desc.id)).toBe(true);
    expect(state.beliefs.get(desc.id)?.assimilated).toBe(true);
  });

  it('adds desires and commits affordances as intentions', () => {
    let state = createAgentState(fullProfile);

    const desire: Desire = {
      id: 'compose-everything',
      description: 'Compose all relevant context',
      priority: 0.8,
      satisfiedBy: ['compose'],
    };
    state = addDesire(state, desire);
    expect(state.desires.length).toBe(1);

    const desc = buildAssertedDescriptor();
    const affordances = computeAffordances(fullProfile, desc);
    const compose = affordances.affordances.find(a => a.action === 'compose' && a.available);

    state = commitToAffordance(state, compose!, 'compose-everything');
    expect(state.intentions.length).toBe(1);
    expect(state.intentions[0]?.action).toBe('compose');
    expect(state.intentions[0]?.desire).toBe('compose-everything');
  });

  it('drops intentions when descriptor is retracted', () => {
    let state = createAgentState(fullProfile);
    const desc = buildAssertedDescriptor();

    // Commit to composing
    const affordances = computeAffordances(fullProfile, desc);
    const compose = affordances.affordances.find(a => a.action === 'compose' && a.available)!;
    state = commitToAffordance(state, compose, 'use-context', [
      { condition: 'descriptor retracted or superseded', facetType: 'Semiotic' },
    ]);
    expect(state.intentions.length).toBe(1);

    // Now assimilate a retracted descriptor
    const retracted = buildRetractedDescriptor();
    const result = assimilateDescriptor(state, retracted, fullProfile);
    expect(result.state.intentions.length).toBe(0); // intention dropped
  });
});

// ═════════════════════════════════════════════════════════════
//  OODA Loop (Boyd)
// ═════════════════════════════════════════════════════════════

describe('OODA Loop (Boyd)', () => {
  it('creates cycle starting at observe', () => {
    const cycle = createOODACycle();
    expect(cycle.phase).toBe('observe');
  });

  it('transitions observe → orient', () => {
    let cycle = createOODACycle();
    const desc = buildAssertedDescriptor();
    cycle = observe(cycle, [desc]);
    expect(cycle.phase).toBe('orient');
    expect(cycle.observations.length).toBe(1);
  });

  it('orient builds affordance cache and trust evaluations', () => {
    let cycle = createOODACycle();
    const desc = buildAssertedDescriptor();
    const state = createAgentState(fullProfile);

    cycle = observe(cycle, [desc]);
    cycle = orient(cycle, fullProfile, state);

    expect(cycle.orientation.affordanceCache.size).toBe(1);
    expect(cycle.orientation.trustedSources.size).toBeGreaterThanOrEqual(0);
  });

  it('decide selects affordances matching desires', () => {
    let cycle = createOODACycle();
    const desc = buildAssertedDescriptor();
    const state = createAgentState(fullProfile);

    const desires: Desire[] = [{
      id: 'read-all',
      description: 'Read all context',
      priority: 0.9,
      satisfiedBy: ['read'],
    }];

    cycle = observe(cycle, [desc]);
    cycle = orient(cycle, fullProfile, state);
    cycle = decide(cycle, fullProfile, desires);

    expect(cycle.phase).toBe('act');
    expect(cycle.decisions.length).toBeGreaterThanOrEqual(1);
    expect(cycle.decisions[0]?.action).toBe('read');
  });

  it('act records completed action and loops back to observe', () => {
    let cycle = createOODACycle();
    cycle = act(cycle, 'read', 'urn:graph:test' as IRI, 'success', 'Read descriptor from pod');

    expect(cycle.phase).toBe('observe');
    expect(cycle.actions.length).toBe(1);
    expect(cycle.actions[0]?.outcome).toBe('success');
  });
});

// ═════════════════════════════════════════════════════════════
//  Stigmergic Field
// ═════════════════════════════════════════════════════════════

describe('Stigmergic Field', () => {
  it('creates empty field', () => {
    const field = createStigmergicField();
    expect(field.totalDescriptors).toBe(0);
    expect(field.totalAgents).toBe(0);
    expect(field.coherenceMetric).toBe(1.0);
  });

  it('updates field when pod state changes', () => {
    let field = createStigmergicField();
    const desc = buildAssertedDescriptor();

    field = updateStigmergicField(
      field,
      'https://pod.example.com/alice/' as IRI,
      [desc],
      ['urn:agent:test:full' as IRI],
    );

    expect(field.totalDescriptors).toBe(1);
    expect(field.totalAgents).toBe(1);
    expect(field.pods.size).toBe(1);

    const podState = field.pods.get('https://pod.example.com/alice/' as IRI);
    expect(podState?.descriptorCount).toBe(1);
    expect(podState?.trustDistribution.selfAsserted).toBe(1);
  });

  it('tracks multiple pods and computes coherence', () => {
    let field = createStigmergicField();
    const desc1 = buildAssertedDescriptor();
    const desc2 = buildHypotheticalDescriptor();

    field = updateStigmergicField(field, 'https://pod.example.com/alice/' as IRI, [desc1], ['urn:agent:a' as IRI]);
    field = updateStigmergicField(field, 'https://pod.example.com/bob/' as IRI, [desc2], ['urn:agent:b' as IRI]);

    expect(field.totalDescriptors).toBe(2);
    expect(field.totalAgents).toBe(2);
    expect(field.pods.size).toBe(2);
    // All self-asserted → coherence = 0
    expect(field.coherenceMetric).toBe(0);
  });
});
