// Cool test: Emergent shared policy from independent pods.
//
// Three pods (Alice, Bob, Carol) each independently publish an
// access policy with the same shape but a different numeric
// threshold. No coordination. Over a stream of access requests,
// each pod votes Allowed/Denied per its own threshold. From
// the observed verdicts alone — not from the policies — the
// system discovers:
//
//   1. The *consensus threshold* — the value that best reproduces
//      the majority vote across all pods.
//   2. The *behavioral equivalence class* — pairs of pods whose
//      verdicts agree on > X% of subjects, hence whose policies
//      are functionally equivalent even though their numeric
//      thresholds differ.
//
// The emergent shared policy IS the mode / median / behavioral
// consensus — a first-class descriptor derivable from the
// observed decision stream, not declared in advance. If the
// individual pods drift, the emergent policy re-derives.
//
// Principles exercised:
//   - Policies are linked data (publishable, queryable, aggregable)
//   - Federated-by-default: no central coordinator sets the "real" policy
//   - Usage-based emergence: the shared policy is learned from behavior
//   - Pullback at the policy layer (consensus threshold = lattice meet
//     over the thresholds that reproduce the majority vote)

import {
  evaluateAbac,
  resolveAttributes,
} from '../dist/index.js';

const ACTION = 'urn:action:read-sensitive';
const SUBJECTS_COUNT = 40;

console.log('=== Emergent shared policy from independent pods ===\n');

// ── Three independent policies ──────────────────────────────

const policies = [
  { pod: 'Alice', threshold: 0.75 },
  { pod: 'Bob',   threshold: 0.85 },
  { pod: 'Carol', threshold: 0.80 },
];

console.log('Independent pod policies:');
for (const p of policies) {
  console.log(`   ${p.pod.padEnd(6)}  pod-policy:  'allow if amta:codeQuality ≥ ${p.threshold.toFixed(2)}'`);
}
console.log('   (No coordination. No shared registry. Each pod published its own.)\n');

// Make ABAC artifacts per pod.
function makePolicyFor(pod, threshold) {
  const shapeIri = `urn:shape:QualifiedReader-${pod}`;
  const policyIri = `urn:policy:pod:${pod}/qualified-reader`;
  return {
    policy: {
      id: policyIri,
      policyPredicateShape: shapeIri,
      governedAction: ACTION,
      deonticMode: 'Permit',
    },
    predicate: {
      iri: shapeIri,
      constraints: [{ path: 'amta:codeQuality', minCount: 1, minInclusive: threshold }],
    },
  };
}

const perPod = policies.map(p => ({ ...p, ...makePolicyFor(p.pod, p.threshold) }));

// ── Generate a stream of subjects with varied codeQuality ──

function pseudoRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
const rng = pseudoRandom(42);

const subjects = Array.from({ length: SUBJECTS_COUNT }, (_, i) => {
  // Uniform over [0.50, 1.00] — spans all pods' thresholds.
  const codeQuality = 0.50 + rng() * 0.50;
  return {
    id: `urn:agent:subject-${i}`,
    codeQuality,
  };
});

// ── Each pod evaluates every subject against its own policy ──

function evaluateForPod(pod, subject) {
  const graph = resolveAttributes(subject.id, [{
    id: `urn:desc:self-${subject.id}`,
    describes: [subject.id],
    facets: [{
      type: 'Trust', trustLevel: 'PeerAttested', issuer: 'urn:agent:oracle',
      amtaAxes: { codeQuality: subject.codeQuality },
    }],
  }]);
  const decision = evaluateAbac([pod.policy], new Map([[pod.predicate.iri, pod.predicate]]), {
    subject: subject.id, subjectAttributes: graph,
    resource: 'urn:resource:test', action: ACTION, now: new Date().toISOString(),
  });
  return decision.verdict;
}

// verdicts[subjectIndex] = { Alice: 'Allowed'|..., Bob: ..., Carol: ... }
const verdicts = subjects.map(s => {
  const row = { subjectId: s.id, codeQuality: s.codeQuality };
  for (const p of perPod) row[p.pod] = evaluateForPod(p, s);
  return row;
});

// ── Summary: per-pod Allowed rate ───────────────────────────

console.log('Per-pod Allowed rate over 40 subjects:');
for (const p of perPod) {
  const allowed = verdicts.filter(v => v[p.pod] === 'Allowed').length;
  console.log(`   ${p.pod.padEnd(6)}  ${allowed}/${SUBJECTS_COUNT} allowed (threshold ${p.threshold.toFixed(2)})`);
}
console.log('');

// ── Emergent consensus: majority vote per subject ──────────

function majority(row) {
  const a = [row.Alice, row.Bob, row.Carol].filter(v => v === 'Allowed').length;
  return a >= 2 ? 'Allowed' : 'Indeterminate';
}
for (const v of verdicts) v.majority = majority(v);

console.log('Majority-vote consensus per subject (≥ 2 of 3 pods Allowed):');
const majorityAllowed = verdicts.filter(v => v.majority === 'Allowed').length;
console.log(`   ${majorityAllowed}/${SUBJECTS_COUNT} subjects reach majority Allowed.\n`);

// ── Discover the emergent threshold ─────────────────────────

// For each candidate threshold in [0.5, 1.0], compute how many
// subjects' majority verdicts this threshold would reproduce.
// The threshold with the best agreement is the emergent consensus.
const candidateThresholds = [];
for (let t = 0.50; t <= 1.0001; t += 0.01) candidateThresholds.push(Number(t.toFixed(2)));

let bestThreshold = null;
let bestAgreement = -1;
for (const t of candidateThresholds) {
  let agree = 0;
  for (const v of verdicts) {
    const wouldAllow = v.codeQuality >= t ? 'Allowed' : 'Indeterminate';
    if (wouldAllow === v.majority) agree++;
  }
  if (agree > bestAgreement) { bestAgreement = agree; bestThreshold = t; }
}

console.log('── Emergent consensus threshold ──');
console.log(`   Best-fit threshold: ${bestThreshold.toFixed(2)}`);
console.log(`     matches majority verdict on ${bestAgreement}/${SUBJECTS_COUNT} subjects (${((bestAgreement / SUBJECTS_COUNT) * 100).toFixed(1)}%)`);
console.log(`   Alice's own:        ${policies[0].threshold.toFixed(2)}`);
console.log(`   Bob's own:          ${policies[1].threshold.toFixed(2)}`);
console.log(`   Carol's own:        ${policies[2].threshold.toFixed(2)}`);
console.log(`   Median of inputs:   ${[...policies].sort((a, b) => a.threshold - b.threshold)[1].threshold.toFixed(2)}`);
console.log('');
console.log('   The emergent threshold was discovered from verdict behavior');
console.log('   alone, with no pod having to publish a "shared" policy.\n');

// ── Behavioral equivalence classes ──────────────────────────

function agreementRate(podA, podB) {
  let a = 0;
  for (const v of verdicts) if (v[podA] === v[podB]) a++;
  return a / SUBJECTS_COUNT;
}

console.log('── Behavioral agreement between independent pod policies ──');
const pairs = [['Alice', 'Bob'], ['Alice', 'Carol'], ['Bob', 'Carol']];
for (const [a, b] of pairs) {
  const rate = agreementRate(a, b);
  console.log(`   ${a.padEnd(6)} ↔ ${b.padEnd(6)}  agreement: ${(rate * 100).toFixed(1)}%`);
}
console.log('');
console.log('   Pods whose thresholds differ still agree on most subjects —');
console.log('   their policies are *behaviorally close* even where they are');
console.log('   numerically distinct. Behavioral equivalence is a first-class');
console.log('   observable at the policy layer.\n');

// ── Emergent shared policy as a derivable descriptor ───────

const emergentPolicy = {
  id: `urn:policy:emergent/${ACTION.split(':').at(-1)}`,
  policyPredicateShape: `urn:shape:Emergent-${ACTION.split(':').at(-1)}`,
  governedAction: ACTION,
  deonticMode: 'Permit',
  _derivation: {
    method: 'majority-vote-threshold',
    evaluatedSubjects: SUBJECTS_COUNT,
    inputs: policies.map(p => ({ pod: p.pod, threshold: p.threshold })),
    emergentThreshold: bestThreshold,
    agreementWithMajority: bestAgreement / SUBJECTS_COUNT,
  },
};

console.log('── Emergent policy as a derivable descriptor ──');
console.log(`   id:         ${emergentPolicy.id}`);
console.log(`   predicate:  'amta:codeQuality ≥ ${bestThreshold.toFixed(2)}'`);
console.log(`   derivation: majority-vote-threshold over ${SUBJECTS_COUNT} observed subjects`);
console.log(`   provenance: derived from [${policies.map(p => p.pod).join(', ')}], no pod designed this.\n`);

console.log('── Observed ──');
console.log('   Three pods independently published policies with different');
console.log('   numeric thresholds. No coordination layer. No shared schema.');
console.log('');
console.log('   From the observed verdict stream alone, the system recovered:');
console.log(`     - a single emergent threshold (${bestThreshold.toFixed(2)}) that best`);
console.log(`       reproduces the majority vote,`);
console.log('     - behavioral agreement rates between every pair of pods,');
console.log('     - an emergent policy descriptor that no pod authored but that');
console.log('       all three would functionally accept on most decisions.');
console.log('');
console.log('   This is the pullback of the three policies at the behavioral');
console.log('   layer: the same pattern as demo-emergent-mediator.mjs but');
console.log('   applied to access control. Federation without central authority');
console.log('   naturally produces emergent consensus when observers agree.');
