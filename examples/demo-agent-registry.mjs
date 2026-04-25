// Cool demo: Public agent attestation registry.
//
// "NPM for AI agents" — a public, federated index where anyone can
// register their agent's capabilities, accumulate reputation through
// peer attestations, and be discovered + reputation-checked by other
// users + agents.
//
// No central operator. Multiple registries can co-exist; an agent
// registered on registries A and B has aggregated cross-registry
// reputation. Each registry runs its own aggregation policy
// (different trust weights, different recency curves, different
// minimum-attestation thresholds).
//
// Built entirely on existing primitives:
//   - registry IS a cg:ContextDescriptor
//   - reputation INPUT is amta:Attestation descriptors
//   - aggregation policy IS a cg:AccessControlPolicy
//   - cross-registry citations USE prov:wasDerivedFrom

import {
  createRegistry,
  registerAgent,
  refreshReputation,
  queryEntries,
  federateLookup,
} from '../dist/index.js';

console.log('=== Public Agent Attestation Registry ===\n');
console.log('Two independently-operated registries. Same agent registered on both.');
console.log('Reputation aggregates across them with verifiable provenance.\n');

const NOW = '2026-04-24T12:00:00Z';

// ── Two registries with different policies ──────────────────

let codeRegistry = createRegistry({
  id: 'urn:registry:code-quality',
  description: 'Code-quality reviewers',
  // Default policy: HighAssurance=1.0, PeerAttested=0.5, SelfAsserted=0.0
});

let researchRegistry = createRegistry({
  id: 'urn:registry:research-peer-review',
  description: 'Research peer reviewers',
  policy: {
    // Stricter policy: only HighAssurance counts.
    trustWeights: { HighAssurance: 1.0, PeerAttested: 0.0, SelfAsserted: 0.0 },
    recencyHalfLifeDays: 60, // Research moves fast
    minContributingAttestations: 2, // Need at least 2 to score
    policyId: 'urn:registry:policy:research-strict-v1',
  },
});

console.log('Registry A (code-quality):');
console.log(`   id: ${codeRegistry.id}`);
console.log(`   policy: ${codeRegistry.policy.policyId}`);
console.log(`     trust weights: HighAssurance=1.0, PeerAttested=0.5, SelfAsserted=0`);
console.log(`     recency half-life: ${codeRegistry.policy.recencyHalfLifeDays} days\n`);

console.log('Registry B (research-peer-review):');
console.log(`   id: ${researchRegistry.id}`);
console.log(`   policy: ${researchRegistry.policy.policyId}`);
console.log(`     trust weights: HighAssurance=1.0, PeerAttested=0, SelfAsserted=0`);
console.log(`     recency half-life: ${researchRegistry.policy.recencyHalfLifeDays} days`);
console.log(`     min contributing attestations: ${researchRegistry.policy.minContributingAttestations}\n`);

// ── Alice registers on both ─────────────────────────────────

const ALICE = 'urn:agent:alice';
const POD = 'https://pod.example/alice/';

codeRegistry = registerAgent(codeRegistry, {
  agentIdentity: ALICE,
  agentPod: POD,
  capabilities: ['cg:canReviewCode', 'cg:canExtractCodeBlocks'],
  now: NOW,
});

researchRegistry = registerAgent(researchRegistry, {
  agentIdentity: ALICE,
  agentPod: POD,
  capabilities: ['cg:canReviewResearch', 'cg:canSummarize'],
  now: NOW,
});

console.log(`Alice registered on both registries.\n`);

// ── Attestations come in ────────────────────────────────────

const attestations = [
  {
    id: 'urn:att:bob->alice/code',
    issuer: 'urn:agent:bob',
    subject: ALICE,
    axes: { honesty: 0.9, competence: 0.85 },
    issuedAt: NOW,
    issuerTrustLevel: 'HighAssurance',
  },
  {
    id: 'urn:att:carol->alice/code',
    issuer: 'urn:agent:carol',
    subject: ALICE,
    axes: { honesty: 0.95, competence: 0.92 },
    issuedAt: NOW,
    issuerTrustLevel: 'PeerAttested',
  },
  {
    id: 'urn:att:dan->alice/research',
    issuer: 'urn:agent:dan',
    subject: ALICE,
    axes: { rigor: 0.92, originality: 0.85 },
    issuedAt: NOW,
    issuerTrustLevel: 'HighAssurance',
  },
  {
    id: 'urn:att:eve->alice/research',
    issuer: 'urn:agent:eve',
    subject: ALICE,
    axes: { rigor: 0.88, originality: 0.9 },
    issuedAt: NOW,
    issuerTrustLevel: 'HighAssurance',
  },
];

console.log(`${attestations.length} attestations available about alice.\n`);

// ── Refresh reputation on both registries ───────────────────

codeRegistry = refreshReputation(codeRegistry, ALICE, attestations, NOW);
researchRegistry = refreshReputation(researchRegistry, ALICE, attestations, NOW);

const codeEntry = codeRegistry.entries.get(ALICE);
const researchEntry = researchRegistry.entries.get(ALICE);

function renderEntry(label, entry) {
  console.log(`── ${label} ──`);
  console.log(`   reputation:       ${entry.reputation?.score.toFixed(3) ?? '(none)'}`);
  console.log(`   axes:             ${JSON.stringify(entry.reputation?.axes ?? {}, null, 0)}`);
  console.log(`   contributing:     ${entry.reputation?.contributingAttestations.length ?? 0} attestations`);
  console.log(`   policy:           ${entry.reputation?.policyHash ?? '(none)'}`);
  console.log(`   capabilities:     ${entry.capabilities.join(', ')}`);
  console.log();
}

renderEntry('alice on code-quality registry', codeEntry);
renderEntry('alice on research-peer-review registry', researchEntry);

console.log('Notice: same attestations, different reputation.');
console.log('  - code-quality counts both bob (HighAssurance) AND carol (PeerAttested at half weight)');
console.log('  - research-peer-review only counts dan + eve (both HighAssurance); ignores PeerAttested');
console.log('  - the SAME agent has different reputation surfaces in different communities,');
console.log('    each verifiable, each grounded in the same source attestations.\n');

// ── Cross-registry federated lookup ─────────────────────────

console.log('── Cross-registry federated lookup ──\n');
const fed = federateLookup(ALICE, [codeRegistry, researchRegistry]);
console.log(`Alice is listed in ${fed.listings.length} registries:`);
for (const l of fed.listings) {
  console.log(`   ${l.registry}  →  reputation ${l.entry.reputation?.score.toFixed(3) ?? '(none)'}`);
}
console.log(`\nFederated score (avg across listings): ${fed.federatedScore?.toFixed(3) ?? '(insufficient)'}`);
console.log();

// ── Capability-filtered query ───────────────────────────────

console.log('── Capability-filtered query ──\n');
console.log('"Find me agents on the code-quality registry who can review code AND have score ≥ 0.85":');
const matches = queryEntries(codeRegistry, {
  hasCapability: 'cg:canReviewCode',
  minScore: 0.85,
});
for (const m of matches) {
  console.log(`   ${m.agentIdentity}  (score: ${m.reputation?.score.toFixed(3)})`);
}

if (matches.length === 0) console.log('   (none matched)');

console.log('\n── What this demonstrates ──');
console.log('   A federated public agent registry built entirely from existing');
console.log('   primitives — registry IS a cg:ContextDescriptor; attestations ARE');
console.log('   amta:Attestation descriptors; aggregation policies ARE');
console.log('   cg:AccessControlPolicy.');
console.log('');
console.log('   No central operator. Multiple registries with different policies');
console.log('   coexist. The same agent has different reputation in different');
console.log('   communities, each verifiable from the source attestations.');
console.log('');
console.log('   This becomes the "NPM for AI agents" entry point — agents');
console.log('   discover each other, prove their capabilities, accumulate');
console.log('   portable reputation that follows them across frameworks.');
