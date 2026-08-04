/**
 * `policyToDeonticRules` — the ABAC → deontic-engine bridge named
 * `policyToDeonticRule` in the deferral note and never written.
 *
 * ★ WHY `predicateHolds` IS WIRED TO THE REAL `validateAgainstShape` + `resolveAttributes`
 * AND NOT TO A STUB. The whole defect this bridge closes is that an `AccessControlPolicyData`
 * carries no subject and no target — it applies exactly when the subject's federated
 * `AttributeGraph` satisfies `policyPredicateShape` — and nothing in the pgsl engine's
 * `PolicyContext` can reach that graph. A stub returning a constant stands in for the very
 * dependency under test and cannot express the failure: with `() => true` the Deny case below
 * flips to `allowed: false` and the test would report the bridge as working while a policy
 * governing nobody became a blanket deny.
 *
 * ★ BOTH PACKAGES EXPORT `PolicyContext` AND `evaluate`. They are DIFFERENT types with
 * different fields, so every import here is aliased.
 */
import { describe, it, expect } from 'vitest';
import type { AccessControlPolicyData, ContextDescriptorData, IRI } from '@interego/core';
import {
  resolveAttributes,
  validateAgainstShape,
  evaluate as abacEvaluate,
} from '@interego/abac';
import type {
  AmtaTrustFacetData,
  PolicyPredicateShape,
  PolicyContext as AbacPolicyContext,
} from '@interego/abac';
import {
  ObserverAAT,
  createPolicyEngine,
  addRule,
  evaluatePolicy,
  policyToDeonticRules,
} from '@interego/pgsl';
import type { PolicyContext as PgslPolicyContext } from '@interego/pgsl';

const ALICE = 'https://ex.org/alice' as IRI;
const MERGE = 'https://ex.org/action/merge' as IRI;
const NODE = 'https://ex.org/node/pr-1' as IRI;
const NOW = '2026-08-04T00:00:00.000Z';

const trustFacet: AmtaTrustFacetData = {
  type: 'Trust',
  trustLevel: 'CryptographicallyVerified',
  issuer: 'https://peer.example/agent' as IRI,
  amtaAxes: { codeQuality: 0.91 },
};

const descriptor: ContextDescriptorData = {
  id: 'https://ex.org/desc/alice' as IRI,
  describes: [ALICE],
  facets: [trustFacet],
};

const GRAPH = resolveAttributes(ALICE, [descriptor]);

/** alice's codeQuality is 0.91, so she SATISFIES this. */
const SHAPE_SAT: PolicyPredicateShape = {
  iri: 'https://ex.org/shape/competent' as IRI,
  constraints: [{ path: 'amta:codeQuality', minInclusive: 0.8 }],
};
/** ...and does NOT satisfy this. */
const SHAPE_UNSAT: PolicyPredicateShape = {
  iri: 'https://ex.org/shape/flawless' as IRI,
  constraints: [{ path: 'amta:codeQuality', minInclusive: 0.99 }],
};

const SHAPES = new Map<IRI, PolicyPredicateShape>([
  [SHAPE_SAT.iri, SHAPE_SAT],
  [SHAPE_UNSAT.iri, SHAPE_UNSAT],
]);

/**
 * The real satisfaction test, wired exactly as the doc comment on `DeonticBridgeOptions`
 * prescribes. This is the injected dependency; nothing about it is a double.
 */
const predicateHolds = (p: AccessControlPolicyData): boolean =>
  validateAgainstShape(GRAPH, SHAPES.get(p.policyPredicateShape)!).length === 0;

const pgslCtx: PgslPolicyContext = {
  agentId: ALICE,
  agentAAT: ObserverAAT,
  nodeUri: NODE,
  action: MERGE,
};

const abacCtx: AbacPolicyContext = {
  subject: ALICE,
  subjectAttributes: GRAPH,
  resource: NODE,
  action: MERGE,
  now: NOW,
};

function runPgsl(policies: readonly AccessControlPolicyData[]) {
  const engine = createPolicyEngine();
  for (const p of policies) {
    for (const rule of policyToDeonticRules(p, { predicateHolds })) addRule(engine, rule);
  }
  return evaluatePolicy(engine, pgslCtx);
}

const runAbac = (policies: readonly AccessControlPolicyData[]) =>
  abacEvaluate(policies, SHAPES, abacCtx);

describe('policyToDeonticRules — ABAC policy → deontic rules', () => {
  it('Permit whose predicate the subject satisfies applies and allows', () => {
    const permit: AccessControlPolicyData = {
      id: 'https://ex.org/p/permit-sat' as IRI,
      policyPredicateShape: SHAPE_SAT.iri,
      governedAction: MERGE,
      deonticMode: 'Permit',
    };
    const d = runPgsl([permit]);
    expect(d.allowed).toBe(true);
    expect(d.matchedRules).toEqual([permit.id]);
    expect(runAbac([permit]).verdict).toBe('Allowed');
  });

  it('Deny whose predicate the subject does NOT satisfy does not apply', () => {
    // ★ THE MEASURED DEFECT. Drop `policyPredicateShape` — which is all a one-argument
    // `policyToDeonticRule(policy)` could do — and the emitted rule has `subject: '*'` with
    // no condition, so it matches everything: `allowed` flips to false and `matchedRules`
    // gains the policy id. A policy that governed nobody becomes a blanket deny, while
    // @interego/abac correctly reports Indeterminate. Both halves are asserted so the
    // bridge is pinned to the OTHER engine's answer, not only to itself.
    const denyUnsat: AccessControlPolicyData = {
      id: 'https://ex.org/p/deny-unsat' as IRI,
      policyPredicateShape: SHAPE_UNSAT.iri,
      governedAction: MERGE,
      deonticMode: 'Deny',
    };
    const d = runPgsl([denyUnsat]);
    expect(d.matchedRules).toHaveLength(0);
    expect(d.allowed).toBe(true);
    expect(runAbac([denyUnsat]).verdict).toBe('Indeterminate');
  });

  it('Duty fans out to ONE RULE PER DUTY, so the duty IRIs survive', () => {
    // ★ WITHOUT THE FAN-OUT this collapses to `['Duty policy https://ex.org/p/duty']` — the
    // obligations an agent must discharge replaced by an unactionable sentence, with the
    // caller reporting success having discharged none. The engine's duty channel is
    // `rule.description` (one string per rule); ABAC's is `policy.duties` (an array).
    const duty: AccessControlPolicyData = {
      id: 'https://ex.org/p/duty' as IRI,
      policyPredicateShape: SHAPE_SAT.iri,
      governedAction: MERGE,
      deonticMode: 'Duty',
      duties: ['https://ex.org/duty/cite-provenance', 'https://ex.org/duty/notify-arbiter'],
    };
    const d = runPgsl([duty]);
    expect(d.duties).toEqual([
      'https://ex.org/duty/cite-provenance',
      'https://ex.org/duty/notify-arbiter',
    ]);
    // ...and the same list the other engine produces, not merely two strings.
    expect(d.duties).toEqual(runAbac([duty]).duties);
  });

  it('Duty with no duties still APPLIES and allows, rather than emitting nothing', () => {
    // Emitting nothing would hand the outcome to the engine's no-rule-matched default,
    // which is a different fact that happens to agree — and would stop agreeing the moment
    // a Deny rule joined the set.
    const bare: AccessControlPolicyData = {
      id: 'https://ex.org/p/duty-bare' as IRI,
      policyPredicateShape: SHAPE_SAT.iri,
      governedAction: MERGE,
      deonticMode: 'Duty',
    };
    const d = runPgsl([bare]);
    expect(d.allowed).toBe(true);
    expect(d.duties).toHaveLength(0);
    expect(d.matchedRules).toHaveLength(1);
  });
});
