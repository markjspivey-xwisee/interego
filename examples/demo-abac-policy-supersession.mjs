// Cool test: Policy versioning + verifiable-stale cache.
//
// A policy is a cg:AccessControlPolicy — a context descriptor like
// any other. That means it participates in the protocol's version
// machinery: cg:supersedes lets you replace an old version; every
// cached decision carries prov:wasDerivedFrom pointing to the
// specific policy version it was evaluated against.
//
// When policy v1 is superseded by v2, a cache entry from v1's era
// doesn't become silently wrong — it becomes *verifiably* stale:
// its provenance still names v1, and v2 is resolvable, so any
// consumer that cares can re-evaluate. Stale is a first-class
// state, not a hidden bug.
//
// This demo exercises:
//   - cg:supersedes between policy versions
//   - Cache entries carrying the version they were computed against
//   - Fresh evaluation using latest-non-superseded policy diverging
//     from the cache result
//   - Both answers being simultaneously correct at their version

import {
  evaluateAbac,
  resolveAttributes,
  createDecisionCache,
  defaultValidUntil,
} from '../dist/index.js';

const SUBJECT = 'urn:agent:alice';
const RESOURCE = 'urn:code:pr:42';
const ACTION = 'urn:action:code:merge';

const T0 = '2026-04-23T10:00:00Z';  // v1 published
const T1 = '2026-04-23T11:00:00Z';  // alice's first eval, cached
const T2 = '2026-04-23T12:00:00Z';  // v2 published, supersedes v1
const T3 = '2026-04-23T13:00:00Z';  // later eval — cache still valid

console.log('=== Policy supersession + verifiable-stale cache ===\n');

// ── Two policies: v1 lax, v2 strict ─────────────────────────

const qualityShapeV1 = {
  iri: 'urn:shape:QualifiedReviewer-v1',
  constraints: [{ path: 'amta:codeQuality', minCount: 1, minInclusive: 0.70 }],
};
const qualityShapeV2 = {
  iri: 'urn:shape:QualifiedReviewer-v2',
  constraints: [{ path: 'amta:codeQuality', minCount: 1, minInclusive: 0.90 }],
};

// Policies are descriptors. We carry the descriptor metadata
// inline here — in production these would be real
// cg:ContextDescriptor instances with temporal + provenance facets.
const policyV1 = {
  id: 'urn:policy:merge-gate#v1',
  policyPredicateShape: qualityShapeV1.iri,
  governedAction: ACTION,
  deonticMode: 'Permit',
  // Descriptor metadata:
  _version: 1,
  _publishedAt: T0,
  _supersedes: [],
};

const policyV2 = {
  id: 'urn:policy:merge-gate#v2',
  policyPredicateShape: qualityShapeV2.iri,
  governedAction: ACTION,
  deonticMode: 'Permit',
  _version: 2,
  _publishedAt: T2,
  _supersedes: [policyV1.id],  // cg:supersedes
};

function latestPolicies(policies, now) {
  // A policy is "in force" if it has been published (publishedAt ≤ now)
  // AND no other in-force policy supersedes it.
  const inForceByPublish = policies.filter(p => p._publishedAt <= now);
  const supersededIds = new Set();
  for (const p of inForceByPublish) {
    for (const sid of p._supersedes) supersededIds.add(sid);
  }
  return inForceByPublish.filter(p => !supersededIds.has(p.id));
}

// Alice's attestations
const aliceGraph = resolveAttributes(SUBJECT, [{
  id: 'urn:desc:bob->alice',
  describes: [SUBJECT],
  facets: [{
    type: 'Trust', trustLevel: 'PeerAttested', issuer: 'urn:agent:bob',
    amtaAxes: { codeQuality: 0.80 },  // clears v1 (≥ 0.70) but fails v2 (≥ 0.90)
  }],
}]);

// ── T0: only v1 exists ─────────────────────────────────────

console.log('── T0 (10:00) — policy v1 published ──');
console.log(`   ${policyV1.id}  predicate: codeQuality ≥ 0.70\n`);

// ── T1: Alice evaluates; cache the decision against v1 ──────

console.log('── T1 (11:00) — alice evaluates; decision cached ──');
const inForceAtT1 = latestPolicies([policyV1, policyV2], T1);
const predicatesAtT1 = new Map([
  [qualityShapeV1.iri, qualityShapeV1],
  [qualityShapeV2.iri, qualityShapeV2],
]);
const decisionT1 = evaluateAbac(inForceAtT1, predicatesAtT1, {
  subject: SUBJECT, subjectAttributes: aliceGraph,
  resource: RESOURCE, action: ACTION, now: T1,
});
console.log(`   in-force policies at T1: [${inForceAtT1.map(p => p.id).join(', ')}]`);
console.log(`   verdict: ${decisionT1.verdict} (alice codeQuality=0.80 ≥ 0.70)`);
console.log(`   matchedPolicies: [${decisionT1.matchedPolicies.join(', ')}]`);

const cache = createDecisionCache();
cache.set({
  subject: SUBJECT, resource: RESOURCE, action: ACTION,
  decision: {
    ...decisionT1,
    _evaluatedAgainstVersions: [policyV1.id],  // provenance of cache entry
  },
  issuer: 'urn:agent:evaluator',
  validUntil: defaultValidUntil(T1, 10800),  // 3h — cache still valid at T3
});
console.log(`   cache valid until: ${new Date(new Date(T1).getTime() + 10800000).toISOString()}\n`);

// ── T2: v2 published, supersedes v1 ────────────────────────

console.log('── T2 (12:00) — policy v2 published, supersedes v1 ──');
console.log(`   ${policyV2.id}  predicate: codeQuality ≥ 0.90  (supersedes ${policyV1.id})\n`);

// ── T3: later evaluation — cache HIT vs fresh evaluation ────

console.log('── T3 (13:00) — cache hit vs fresh re-evaluation ──\n');

// Path A: blindly trust the cache.
const cached = cache.get(SUBJECT, RESOURCE, ACTION, T3);
console.log('   Path A — blind cache use:');
console.log(`     cached verdict: ${cached?.verdict}`);
console.log(`     cached against: ${cached?._evaluatedAgainstVersions?.join(', ') ?? '(unknown)'}`);
console.log(`     still "correct" for the policy version cached against — but stale-by-version.\n`);

// Path B: fresh evaluation — uses latest non-superseded policy.
const inForceAtT3 = latestPolicies([policyV1, policyV2], T3);
const decisionT3 = evaluateAbac(inForceAtT3, predicatesAtT1, {
  subject: SUBJECT, subjectAttributes: aliceGraph,
  resource: RESOURCE, action: ACTION, now: T3,
});
console.log('   Path B — fresh re-evaluation (use latest policy):');
console.log(`     in-force at T3: [${inForceAtT3.map(p => p.id).join(', ')}]`);
console.log(`     verdict: ${decisionT3.verdict} (0.80 < 0.90)`);
console.log(`     matchedPolicies: [${decisionT3.matchedPolicies.join(', ') || '(none)'}]\n`);

// ── Cache-staleness detection via version provenance ───────

console.log('── Cache-staleness detection ──');
const cachedVersions = new Set(cached?._evaluatedAgainstVersions ?? []);
const currentVersions = new Set(inForceAtT3.map(p => p.id));
const staleByVersion = [...cachedVersions].some(v => !currentVersions.has(v));
console.log(`   cached-against: [${[...cachedVersions].join(', ')}]`);
console.log(`   in-force now:   [${[...currentVersions].join(', ')}]`);
console.log(`   stale-by-version? ${staleByVersion}`);
if (staleByVersion) {
  console.log('   → a caller with the current policy registry can *detect* that');
  console.log('     the cache entry references a superseded version and re-evaluate.');
  console.log('     The cache is not silently wrong; it is verifiably stale.');
}

console.log('\n── Observed ──');
console.log('   Both the T1 verdict (Allowed against v1) and the T3 verdict');
console.log('   (Indeterminate against v2) are simultaneously correct — at');
console.log('   their respective policy versions.');
console.log('');
console.log('   Because a policy is a descriptor, cg:supersedes provides a');
console.log('   first-class versioning axis. A cached decision carries which');
console.log('   version it was computed against; any consumer can detect');
console.log('   stale-by-version by comparing the cache\'s version set to the');
console.log('   current in-force set.');
console.log('');
console.log('   Most access-control systems silently serve stale cached');
console.log('   decisions until TTL expires. Ours makes staleness a property');
console.log('   of the decision record, not of the clock.');
