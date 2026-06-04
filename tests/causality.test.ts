/**
 * Tests for Pearl's Causal Reasoning Engine
 *
 * Covers:
 *   - SCM construction and validation
 *   - DAG operations (topological sort, ancestors, descendants)
 *   - do-calculus (graph surgery / mutilated graphs)
 *   - d-separation (Bayes-Ball algorithm)
 *   - Counterfactual evaluation (twin-network method)
 *   - Backdoor criterion
 *   - Front-door criterion
 *   - CausalFacet on ContextDescriptor (builder, serialization, validation)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ancestors,
  buildSCM,
  causalPaths,
  children,
  ContextDescriptor,
  descendants,
  doIntervention,
  evaluateCounterfactual,
  findBackdoorSet,
  hasCycle,
  intersection,
  isDSeparated,
  parents,
  satisfiesBackdoorCriterion,
  satisfiesFrontDoorCriterion,
  scmSummary,
  toJsonLdString,
  topologicalSort,
  toTurtle,
  union,
  validate,
} from '@interego/core';
import {
  resetComposedIdCounter,
} from '@interego/core';
import type {
  CausalEdge,
  CausalVariable,
  IRI,
  StructuralCausalModel,
} from '@interego/core';

// ── Helper: Classic confounded SCM ──────────────────────────
// X ← U → Y, X → Y (U is an unobserved confounder)
function confoundedSCM(): StructuralCausalModel {
  return buildSCM(
    'urn:scm:confounded' as IRI,
    [
      { name: 'U', exogenous: true },
      { name: 'X' },
      { name: 'Y' },
    ],
    [
      { from: 'U', to: 'X' },
      { from: 'U', to: 'Y' },
      { from: 'X', to: 'Y' },
    ],
    'Confounded X→Y',
  );
}

// ── Helper: Front-door SCM ──────────────────────────────────
// U → X, U → Y, X → M → Y (M is a mediator)
function frontDoorSCM(): StructuralCausalModel {
  return buildSCM(
    'urn:scm:frontdoor' as IRI,
    [
      { name: 'U', exogenous: true },
      { name: 'X' },
      { name: 'M' },
      { name: 'Y' },
    ],
    [
      { from: 'U', to: 'X' },
      { from: 'U', to: 'Y' },
      { from: 'X', to: 'M' },
      { from: 'M', to: 'Y' },
    ],
    'Front-door SCM',
  );
}

// ── Helper: Software architecture SCM ───────────────────────
function archSCM(): StructuralCausalModel {
  return buildSCM(
    'urn:scm:architecture' as IRI,
    [
      { name: 'deploymentStrategy', mechanism: 'monolith vs microservices' },
      { name: 'teamSize', exogenous: true },
      { name: 'latency', mechanism: 'f(deploymentStrategy, teamSize)' },
      { name: 'availability', mechanism: 'f(deploymentStrategy)' },
      { name: 'userSatisfaction', mechanism: 'f(latency, availability)' },
    ],
    [
      { from: 'deploymentStrategy', to: 'latency', mechanism: 'service boundaries add overhead' },
      { from: 'deploymentStrategy', to: 'availability', mechanism: 'independent scaling' },
      { from: 'teamSize', to: 'latency', mechanism: 'coordination overhead' },
      { from: 'latency', to: 'userSatisfaction', mechanism: 'response time perception' },
      { from: 'availability', to: 'userSatisfaction', mechanism: 'uptime expectations' },
    ],
    'Software Architecture Decisions',
  );
}

// ═════════════════════════════════════════════════════════════
//  SCM Construction
// ═════════════════════════════════════════════════════════════

describe('SCM Construction', () => {
  it('builds a valid SCM', () => {
    const scm = archSCM();
    expect(scm.variables).toHaveLength(5);
    expect(scm.edges).toHaveLength(5);
    expect(scm.label).toBe('Software Architecture Decisions');
  });

  it('rejects unknown variable in edge', () => {
    expect(() => buildSCM(
      'urn:scm:bad' as IRI,
      [{ name: 'X' }],
      [{ from: 'X', to: 'Z' }],
    )).toThrow('unknown variable "Z"');
  });

  it('rejects self-loops', () => {
    expect(() => buildSCM(
      'urn:scm:loop' as IRI,
      [{ name: 'X' }],
      [{ from: 'X', to: 'X' }],
    )).toThrow('Self-loop');
  });

  it('rejects cycles', () => {
    expect(() => buildSCM(
      'urn:scm:cycle' as IRI,
      [{ name: 'X' }, { name: 'Y' }],
      [{ from: 'X', to: 'Y' }, { from: 'Y', to: 'X' }],
    )).toThrow('cycle');
  });
});

// ═════════════════════════════════════════════════════════════
//  DAG Operations
// ═════════════════════════════════════════════════════════════

describe('DAG Operations', () => {
  it('topological sort respects causal order', () => {
    const scm = archSCM();
    const order = topologicalSort(scm);
    const idx = (v: string) => order.indexOf(v);

    // Causes must come before effects
    expect(idx('deploymentStrategy')).toBeLessThan(idx('latency'));
    expect(idx('deploymentStrategy')).toBeLessThan(idx('availability'));
    expect(idx('latency')).toBeLessThan(idx('userSatisfaction'));
    expect(idx('availability')).toBeLessThan(idx('userSatisfaction'));
  });

  it('ancestors of userSatisfaction includes all non-exogenous ancestors', () => {
    const scm = archSCM();
    const anc = ancestors(scm, 'userSatisfaction');
    expect(anc.has('latency')).toBe(true);
    expect(anc.has('availability')).toBe(true);
    expect(anc.has('deploymentStrategy')).toBe(true);
    expect(anc.has('teamSize')).toBe(true);
  });

  it('descendants of deploymentStrategy', () => {
    const scm = archSCM();
    const desc = descendants(scm, 'deploymentStrategy');
    expect(desc.has('latency')).toBe(true);
    expect(desc.has('availability')).toBe(true);
    expect(desc.has('userSatisfaction')).toBe(true);
    expect(desc.has('teamSize')).toBe(false);
  });

  it('parents and children', () => {
    const scm = archSCM();
    expect(parents(scm, 'latency')).toContain('deploymentStrategy');
    expect(parents(scm, 'latency')).toContain('teamSize');
    expect(children(scm, 'deploymentStrategy')).toContain('latency');
    expect(children(scm, 'deploymentStrategy')).toContain('availability');
  });
});

// ═════════════════════════════════════════════════════════════
//  do-Calculus (Graph Surgery)
// ═════════════════════════════════════════════════════════════

describe('do-Calculus', () => {
  it('do(deploymentStrategy=microservices) removes incoming edges', () => {
    const scm = archSCM();
    const mutilated = doIntervention(scm, [
      { variable: 'deploymentStrategy', value: 'microservices' },
    ]);

    // Original has no incoming edges to deploymentStrategy anyway,
    // but the variable should be marked exogenous
    const ds = mutilated.variables.find(v => v.name === 'deploymentStrategy')!;
    expect(ds.exogenous).toBe(true);
    expect(ds.mechanism).toContain('do(');
  });

  it('do(X) in confounded model removes U→X edge', () => {
    const scm = confoundedSCM();
    const mutilated = doIntervention(scm, [
      { variable: 'X', value: '1' },
    ]);

    // U→X should be gone, but U→Y and X→Y should remain
    expect(mutilated.edges.some(e => e.from === 'U' && e.to === 'X')).toBe(false);
    expect(mutilated.edges.some(e => e.from === 'U' && e.to === 'Y')).toBe(true);
    expect(mutilated.edges.some(e => e.from === 'X' && e.to === 'Y')).toBe(true);
  });

  it('rejects intervention on unknown variable', () => {
    const scm = archSCM();
    expect(() => doIntervention(scm, [
      { variable: 'nonexistent', value: '42' },
    ])).toThrow('unknown variable');
  });
});

// ═════════════════════════════════════════════════════════════
//  d-Separation
// ═════════════════════════════════════════════════════════════

describe('d-Separation', () => {
  it('X and Y are NOT d-separated given empty set (confounded)', () => {
    const scm = confoundedSCM();
    // X and Y share confounder U and direct edge
    expect(isDSeparated(scm, 'X', 'Y', new Set())).toBe(false);
  });

  it('in a chain A→B→C, A⊥C|B', () => {
    const chain = buildSCM(
      'urn:scm:chain' as IRI,
      [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }],
    );
    expect(isDSeparated(chain, 'A', 'C', new Set(['B']))).toBe(true);
    expect(isDSeparated(chain, 'A', 'C', new Set())).toBe(false);
  });

  it('collider: A→C←B, A⊥B (not conditioning on C)', () => {
    const collider = buildSCM(
      'urn:scm:collider' as IRI,
      [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      [{ from: 'A', to: 'C' }, { from: 'B', to: 'C' }],
    );
    // A and B are d-separated when NOT conditioning on the collider
    expect(isDSeparated(collider, 'A', 'B', new Set())).toBe(true);
    // Conditioning on collider opens the path
    expect(isDSeparated(collider, 'A', 'B', new Set(['C']))).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
//  Causal Paths
// ═════════════════════════════════════════════════════════════

describe('Causal Paths', () => {
  it('finds all directed paths', () => {
    const scm = archSCM();
    const paths = causalPaths(scm, 'deploymentStrategy', 'userSatisfaction');
    // Two paths: via latency and via availability
    expect(paths.length).toBe(2);
    expect(paths.some(p => p.includes('latency'))).toBe(true);
    expect(paths.some(p => p.includes('availability'))).toBe(true);
  });

  it('returns empty for no path', () => {
    const scm = archSCM();
    const paths = causalPaths(scm, 'userSatisfaction', 'deploymentStrategy');
    expect(paths).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════
//  Counterfactual Evaluation
// ═════════════════════════════════════════════════════════════

describe('Counterfactual Evaluation', () => {
  it('evaluates "what if deployment was microservices?"', () => {
    const scm = archSCM();
    const result = evaluateCounterfactual(scm, {
      target: 'userSatisfaction',
      intervention: { variable: 'deploymentStrategy', value: 'microservices' },
      evidence: { deploymentStrategy: 'monolith', latency: 'high' },
    });

    expect(result.targetAffected).toBe(true);
    expect(result.affectedVariables).toContain('deploymentStrategy');
    expect(result.affectedVariables).toContain('latency');
    expect(result.affectedVariables).toContain('availability');
    expect(result.affectedVariables).toContain('userSatisfaction');
    expect(result.unchangedVariables).toContain('teamSize');
    expect(result.factualPaths.length).toBeGreaterThan(0);
    expect(result.counterfactualPaths.length).toBeGreaterThan(0);
  });

  it('rejects unknown target', () => {
    const scm = archSCM();
    expect(() => evaluateCounterfactual(scm, {
      target: 'nonexistent',
      intervention: { variable: 'deploymentStrategy', value: 'x' },
      evidence: {},
    })).toThrow('not in SCM');
  });
});

// ═════════════════════════════════════════════════════════════
//  Backdoor Criterion
// ═════════════════════════════════════════════════════════════

describe('Backdoor Criterion', () => {
  it('empty set does NOT satisfy backdoor when confounded', () => {
    const scm = confoundedSCM();
    expect(satisfiesBackdoorCriterion(scm, 'X', 'Y', new Set())).toBe(false);
  });

  it('{U} satisfies backdoor criterion for X→Y with confounder U', () => {
    const scm = confoundedSCM();
    expect(satisfiesBackdoorCriterion(scm, 'X', 'Y', new Set(['U']))).toBe(true);
  });

  it('findBackdoorSet returns {U} for confounded model', () => {
    const scm = confoundedSCM();
    const set = findBackdoorSet(scm, 'X', 'Y');
    expect(set).not.toBeNull();
    expect(set!.has('U')).toBe(true);
  });

  it('findBackdoorSet returns empty set when no confounding', () => {
    const simple = buildSCM(
      'urn:scm:simple' as IRI,
      [{ name: 'X' }, { name: 'Y' }],
      [{ from: 'X', to: 'Y' }],
    );
    const set = findBackdoorSet(simple, 'X', 'Y');
    expect(set).not.toBeNull();
    expect(set!.size).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════
//  Front-Door Criterion
// ═════════════════════════════════════════════════════════════

describe('Front-Door Criterion', () => {
  it('{M} satisfies front-door for X→Y via mediator M', () => {
    const scm = frontDoorSCM();
    expect(satisfiesFrontDoorCriterion(scm, 'X', 'Y', new Set(['M']))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════
//  CausalFacet on ContextDescriptor
// ═════════════════════════════════════════════════════════════

describe('CausalFacet Builder', () => {
  beforeEach(() => resetComposedIdCounter());

  it('builds observation descriptor', () => {
    const desc = ContextDescriptor.create('urn:cg:obs' as IRI)
      .describes('urn:graph:arch-obs' as IRI)
      .temporal({ validFrom: '2026-03-20T00:00:00Z' })
      .observation('urn:scm:architecture' as IRI)
      .build();

    const causal = desc.facets.find(f => f.type === 'Causal');
    expect(causal).toBeDefined();
    expect(causal!.type).toBe('Causal');
    if (causal!.type === 'Causal') {
      expect(causal!.causalRole).toBe('Observation');
      expect(causal!.causalModel).toBe('urn:scm:architecture');
    }
  });

  it('builds intervention descriptor', () => {
    const desc = ContextDescriptor.create('urn:cg:int' as IRI)
      .describes('urn:graph:arch-int' as IRI)
      .temporal({ validFrom: '2026-03-20T00:00:00Z' })
      .intervention(
        [{ variable: 'deploymentStrategy', value: 'microservices' }],
        'urn:cg:obs' as IRI,
      )
      .build();

    const causal = desc.facets.find(f => f.type === 'Causal');
    expect(causal).toBeDefined();
    if (causal!.type === 'Causal') {
      expect(causal!.causalRole).toBe('Intervention');
      expect(causal!.interventions).toHaveLength(1);
      expect(causal!.parentObservation).toBe('urn:cg:obs');
    }
  });

  it('builds counterfactual descriptor', () => {
    const desc = ContextDescriptor.create('urn:cg:cf' as IRI)
      .describes('urn:graph:arch-cf' as IRI)
      .temporal({ validFrom: '2026-03-20T00:00:00Z' })
      .counterfactual(
        {
          target: 'userSatisfaction',
          intervention: { variable: 'deploymentStrategy', value: 'microservices' },
          evidence: { deploymentStrategy: 'monolith', latency: 'high' },
        },
        'urn:cg:obs' as IRI,
        'urn:cg:int' as IRI,
      )
      .build();

    const causal = desc.facets.find(f => f.type === 'Causal');
    expect(causal).toBeDefined();
    if (causal!.type === 'Causal') {
      expect(causal!.causalRole).toBe('Counterfactual');
      expect(causal!.counterfactualQuery!.target).toBe('userSatisfaction');
      expect(causal!.parentObservation).toBe('urn:cg:obs');
      expect(causal!.parentIntervention).toBe('urn:cg:int');
    }
  });

  it('rejects invalid causalConfidence', () => {
    expect(() =>
      ContextDescriptor.create('urn:cg:bad' as IRI)
        .describes('urn:graph:x' as IRI)
        .causal({ causalRole: 'Observation', causalConfidence: 1.5 })
        .build()
    ).toThrow('causalConfidence');
  });
});

// ═════════════════════════════════════════════════════════════
//  CausalFacet Serialization
// ═════════════════════════════════════════════════════════════

describe('CausalFacet Serialization', () => {
  it('serializes observation to Turtle', () => {
    const desc = ContextDescriptor.create('urn:cg:obs' as IRI)
      .describes('urn:graph:obs' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .observation('urn:scm:test' as IRI)
      .build();

    const turtle = toTurtle(desc);
    expect(turtle).toContain('cg:CausalFacet');
    expect(turtle).toContain('cg:causalRole cg:Observation');
    expect(turtle).toContain('cg:causalModel <urn:scm:test>');
  });

  it('serializes intervention with do-operator to Turtle', () => {
    const desc = ContextDescriptor.create('urn:cg:int' as IRI)
      .describes('urn:graph:int' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .intervention(
        [{ variable: 'X', value: '1' }],
        'urn:cg:obs' as IRI,
      )
      .build();

    const turtle = toTurtle(desc);
    expect(turtle).toContain('cg:Intervention');
    expect(turtle).toContain('cg:intervenes');
    expect(turtle).toContain('cg:parentObservation');
  });

  it('serializes inline SCM to Turtle', () => {
    const scm = buildSCM(
      'urn:scm:inline' as IRI,
      [{ name: 'X' }, { name: 'Y' }],
      [{ from: 'X', to: 'Y', mechanism: 'direct cause' }],
      'Inline SCM',
    );
    const desc = ContextDescriptor.create('urn:cg:scm' as IRI)
      .describes('urn:graph:scm' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .observation(scm)
      .build();

    const turtle = toTurtle(desc);
    expect(turtle).toContain('cg:StructuralCausalModel');
    expect(turtle).toContain('cg:CausalVariable');
    expect(turtle).toContain('cg:CausalEdge');
  });

  it('serializes to JSON-LD', () => {
    const desc = ContextDescriptor.create('urn:cg:obs' as IRI)
      .describes('urn:graph:obs' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .observation('urn:scm:test' as IRI)
      .build();

    const jsonld = toJsonLdString(desc, { pretty: true });
    expect(jsonld).toContain('cg:CausalFacet');
    expect(jsonld).toContain('cg:Observation');
  });
});

// ═════════════════════════════════════════════════════════════
//  CausalFacet Validation
// ═════════════════════════════════════════════════════════════

describe('CausalFacet Validation', () => {
  it('validates observation descriptor', () => {
    const desc = ContextDescriptor.create('urn:cg:obs' as IRI)
      .describes('urn:graph:obs' as IRI)
      .observation('urn:scm:test' as IRI)
      .build();
    expect(validate(desc).conforms).toBe(true);
  });

  it('rejects intervention without interventions array', () => {
    const desc = {
      id: 'urn:cg:bad' as IRI,
      describes: ['urn:graph:x' as IRI],
      facets: [{ type: 'Causal' as const, causalRole: 'Intervention' as const }],
    };
    const result = validate(desc);
    expect(result.conforms).toBe(false);
    expect(result.violations.some(v => v.message.includes('intervention'))).toBe(true);
  });

  it('rejects counterfactual without query', () => {
    const desc = {
      id: 'urn:cg:bad' as IRI,
      describes: ['urn:graph:x' as IRI],
      facets: [{ type: 'Causal' as const, causalRole: 'Counterfactual' as const }],
    };
    const result = validate(desc);
    expect(result.conforms).toBe(false);
    expect(result.violations.some(v => v.message.includes('counterfactual'))).toBe(true);
  });

  it('rejects invalid causal role', () => {
    const desc = {
      id: 'urn:cg:bad' as IRI,
      describes: ['urn:graph:x' as IRI],
      facets: [{ type: 'Causal' as const, causalRole: 'Invalid' as never }],
    };
    const result = validate(desc);
    expect(result.conforms).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
//  CausalFacet Composition
// ═════════════════════════════════════════════════════════════

describe('CausalFacet Composition', () => {
  beforeEach(() => resetComposedIdCounter());

  it('union preserves both causal facets', () => {
    const obs = ContextDescriptor.create('urn:cg:obs' as IRI)
      .describes('urn:graph:g' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .observation('urn:scm:test' as IRI)
      .build();

    const int = ContextDescriptor.create('urn:cg:int' as IRI)
      .describes('urn:graph:g' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .intervention(
        [{ variable: 'X', value: '1' }],
        'urn:cg:obs' as IRI,
      )
      .build();

    const composed = union(obs, int);
    const causalFacets = composed.facets.filter(f => f.type === 'Causal');
    expect(causalFacets).toHaveLength(2);
  });

  it('intersection retains shared causal sign-instances only', () => {
    // Causal facets are preserve-all, so intersection takes the lattice
    // meet at the sign-instance level (facetFingerprint equality).
    // Disjoint observations (urn:scm:a vs urn:scm:b) drop out so that
    // A ∧ B ≤ A still holds.
    const d1 = ContextDescriptor.create('urn:cg:d1' as IRI)
      .describes('urn:graph:g' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .observation('urn:scm:a' as IRI)
      .build();

    const d2 = ContextDescriptor.create('urn:cg:d2' as IRI)
      .describes('urn:graph:g' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .observation('urn:scm:b' as IRI)
      .build();

    const composed = intersection(d1, d2);
    const causalFacets = composed.facets.filter(f => f.type === 'Causal');
    expect(causalFacets).toHaveLength(0);

    // Sanity: when the two operands DO share a causal sign-instance the
    // shared one survives (and only the shared one).
    const d3 = ContextDescriptor.create('urn:cg:d3' as IRI)
      .describes('urn:graph:g' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .observation('urn:scm:shared' as IRI)
      .build();

    const d4 = ContextDescriptor.create('urn:cg:d4' as IRI)
      .describes('urn:graph:g' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .observation('urn:scm:shared' as IRI)
      .build();

    const composedShared = intersection(d3, d4);
    const sharedCausal = composedShared.facets.filter(f => f.type === 'Causal');
    expect(sharedCausal).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════
//  SCM Summary
// ═════════════════════════════════════════════════════════════

describe('SCM Summary', () => {
  it('produces readable summary', () => {
    const scm = archSCM();
    const summary = scmSummary(scm);
    expect(summary).toContain('Software Architecture Decisions');
    expect(summary).toContain('Variables: 5');
    expect(summary).toContain('Edges: 5');
    expect(summary).toContain('deploymentStrategy');
    expect(summary).toContain('userSatisfaction');
  });
});
