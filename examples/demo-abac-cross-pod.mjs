// Demo: Attribute-based access control over federated attestations.
//
// Scenario (builds on code: domain + AMTA):
//   - Alice opens PR #42 on interego-core.
//   - The repo has an AccessControlPolicy: "merge PR only if the
//     approving reviewer has a code-quality reputation ≥ 0.8 on at
//     least TWO independent peer attestations, and the PR's TemporalFacet
//     validUntil is in the future."
//   - Two peer pods (Bob's and Carol's) have each issued AMTA-style
//     trust attestations about Alice on axis amta:codeQuality.
//   - The ABAC evaluator resolves Alice's attribute graph across
//     those attestations, evaluates the policy's SHACL predicate,
//     and emits a PolicyDecision.
//
// No central registry. No hand-written "merge gate" code. The
// decision is computed from L1 primitives (cg:AccessControlPolicy
// + facets) via the L2 evaluation pattern (abac:).
//
// Principles exercised:
//   - Policies as first-class linked data (cg:AccessControlPolicy)
//   - SHACL predicates as policy gates
//   - Cross-pod attribute resolution (peer attestations aggregate)
//   - Deny-overrides-Permit composition
//   - Audit trail as a context descriptor (decision = linked data)

import {
  evaluateAbac,
  resolveAttributes,
  extractAttribute,
  createDecisionCache,
  defaultValidUntil,
} from '../dist/index.js';

const NOW = '2026-04-23T12:00:00Z';
const ALICE = 'urn:agent:alice';
const RESOURCE_PR = 'urn:code:pr:42';
const ACTION_MERGE = 'urn:action:code:merge';

console.log('=== ABAC cross-pod demo ===\n');
console.log('Scenario: Alice wants to merge PR #42.');
console.log('The repo\'s policy: require ≥2 peer attestations of code-quality ≥ 0.8,');
console.log('                   AND the PR must still be within its validity window.\n');

// ── 1. Attribute sources: attestations from multiple pods ────

const aliceSelfDesc = {
  id: 'urn:desc:alice-self',
  describes: [ALICE],
  facets: [
    { type: 'Trust', trustLevel: 'SelfAsserted', issuer: ALICE },
    { type: 'Agent', assertingAgent: { agentIdentity: ALICE } },
  ],
};

const bobAttestation = {
  id: 'urn:desc:bob-attests-alice',
  describes: [ALICE],
  facets: [{
    type: 'Trust',
    trustLevel: 'PeerAttested',
    issuer: 'urn:agent:bob',
    amtaAxes: { codeQuality: 0.85, reviewerReliability: 0.9 },
  }],
};

const carolAttestation = {
  id: 'urn:desc:carol-attests-alice',
  describes: [ALICE],
  facets: [{
    type: 'Trust',
    trustLevel: 'PeerAttested',
    issuer: 'urn:agent:carol',
    amtaAxes: { codeQuality: 0.92, reviewerReliability: 0.88 },
  }],
};

const prTemporalDesc = {
  id: RESOURCE_PR,
  describes: [ALICE],     // attribute attached to subject for demo
  facets: [{
    type: 'Temporal',
    validFrom: '2026-04-20T00:00:00Z',
    validUntil: '2026-04-30T00:00:00Z',
  }],
};

console.log('Attribute sources:');
console.log(`   ${aliceSelfDesc.id}        (alice\'s self-assertion)`);
console.log(`   ${bobAttestation.id}     (bob\'s AMTA: codeQuality 0.85)`);
console.log(`   ${carolAttestation.id}   (carol\'s AMTA: codeQuality 0.92)`);
console.log(`   ${prTemporalDesc.id}                  (PR validity window)\n`);

// ── 2. Resolve subject's attribute graph across pods ────────

const graph = resolveAttributes(ALICE, [
  aliceSelfDesc, bobAttestation, carolAttestation, prTemporalDesc,
]);
console.log(`Resolved attribute graph: ${graph.facets.length} facets from ${new Set([...graph.sources.values()]).size} source(s).\n`);

const qualityScores = extractAttribute(graph, 'amta:codeQuality');
console.log(`  amta:codeQuality values:  [${qualityScores.join(', ')}]  (${qualityScores.length} attestations)`);
const validUntil = extractAttribute(graph, 'cg:validUntil');
console.log(`  cg:validUntil:            ${validUntil[0]}\n`);

// ── 3. Policy: require 2+ codeQuality ≥ 0.8 + validity window ─

const codeQualityShape = {
  iri: 'urn:shape:QualifiedReviewer',
  constraints: [
    { path: 'amta:codeQuality', minCount: 2, minInclusive: 0.8,
      message: 'need at least 2 peer attestations of codeQuality ≥ 0.8' },
    { path: 'cg:validUntil', minCount: 1,
      message: 'resource must have a validity window' },
  ],
};

const mergePermitPolicy = {
  id: 'urn:policy:permit-qualified-merge',
  policyPredicateShape: codeQualityShape.iri,
  governedAction: ACTION_MERGE,
  deonticMode: 'Permit',
};

console.log('Policy:');
console.log(`   id:         ${mergePermitPolicy.id}`);
console.log(`   action:     ${mergePermitPolicy.governedAction}`);
console.log(`   mode:       ${mergePermitPolicy.deonticMode}`);
console.log(`   predicate:  ${codeQualityShape.iri}`);
console.log('     - amta:codeQuality  ≥ 0.8  (minCount: 2)');
console.log('     - cg:validUntil     present\n');

// ── 4. Evaluate ─────────────────────────────────────────────

const context = {
  subject: ALICE,
  subjectAttributes: graph,
  resource: RESOURCE_PR,
  action: ACTION_MERGE,
  now: NOW,
};

const predicates = new Map([[codeQualityShape.iri, codeQualityShape]]);
const decision = evaluateAbac([mergePermitPolicy], predicates, context);

console.log('── Decision ──');
console.log(`   verdict:          ${decision.verdict}`);
console.log(`   reason:           ${decision.reason}`);
console.log(`   matchedPolicies:  [${decision.matchedPolicies.join(', ')}]`);
console.log(`   duties:           [${decision.duties.join(', ') || '(none)'}]`);
console.log(`   decidedAt:        ${decision.decidedAt}\n`);

// ── 5. Counterfactual: drop one attestation ─────────────────

console.log('── Counterfactual: what if only Bob had attested? ──');
const graphSingle = resolveAttributes(ALICE, [aliceSelfDesc, bobAttestation, prTemporalDesc]);
const singleContext = { ...context, subjectAttributes: graphSingle };
const singleDecision = evaluateAbac([mergePermitPolicy], predicates, singleContext);
console.log(`   codeQuality attestations: ${extractAttribute(graphSingle, 'amta:codeQuality').length}`);
console.log(`   verdict: ${singleDecision.verdict}`);
console.log(`   reason:  ${singleDecision.reason}\n`);

// ── 6. Deny-overrides-Permit composition ────────────────────

console.log('── Deny-overrides-Permit: add a Deny policy with broader predicate ──');
const anyLowTrustShape = {
  iri: 'urn:shape:AnyLowTrust',
  constraints: [
    { path: 'cg:trustLevel', minCount: 1, hasValue: 'SelfAsserted' },
  ],
};
const denyIfSelfAsserted = {
  id: 'urn:policy:deny-self-asserted-only',
  policyPredicateShape: anyLowTrustShape.iri,
  governedAction: ACTION_MERGE,
  deonticMode: 'Deny',
};

const composedPredicates = new Map([
  [codeQualityShape.iri, codeQualityShape],
  [anyLowTrustShape.iri, anyLowTrustShape],
]);
const composedDecision = evaluateAbac(
  [mergePermitPolicy, denyIfSelfAsserted],
  composedPredicates,
  context,
);
console.log(`   Permit policy matches (qualityScores ≥ 0.8 × 2), verdict would be Allowed.`);
console.log(`   Deny policy also matches (alice has a SelfAsserted Trust facet).`);
console.log(`   Composed verdict: ${composedDecision.verdict} — deny wins.`);
console.log(`   reason: ${composedDecision.reason}\n`);

// ── 7. Decision cache ───────────────────────────────────────

console.log('── Decision cache ──');
const cache = createDecisionCache();
cache.set({
  subject: ALICE,
  resource: RESOURCE_PR,
  action: ACTION_MERGE,
  decision,
  issuer: 'urn:agent:evaluator',
  validUntil: defaultValidUntil(NOW, 900),  // 15 min TTL
});
const cached = cache.get(ALICE, RESOURCE_PR, ACTION_MERGE, NOW);
console.log(`   cached? ${cached !== null}  (verdict=${cached?.verdict})`);
const laterButStillValid = '2026-04-23T12:10:00Z';
const stillValid = cache.get(ALICE, RESOURCE_PR, ACTION_MERGE, laterButStillValid);
console.log(`   still valid at +10 min?  ${stillValid !== null}`);
const wayLater = '2026-04-23T13:00:00Z';
const stale = cache.get(ALICE, RESOURCE_PR, ACTION_MERGE, wayLater);
console.log(`   stale at +60 min?        ${stale === null ? 'yes (returns null — re-evaluate)' : 'no'}\n`);

console.log('── Observed ──');
console.log('   The policy is a first-class descriptor (cg:AccessControlPolicy).');
console.log('   Its SHACL predicate is evaluated over an attribute graph that');
console.log('   was assembled from three different sources — alice\'s own pod,');
console.log('   bob\'s attestation, carol\'s attestation. The evaluator didn\'t');
console.log('   care which pod hosted which attestation; it just asked the');
console.log('   resolver for everything about alice.');
console.log('');
console.log('   Policies compose via deny-overrides-permit. The audit trail');
console.log('   of the decision is itself a linked-data artifact that could');
console.log('   be published + verified. Caching uses the trust-attestation');
console.log('   shape, so a stale cache entry is verifiably stale — not silent.');
