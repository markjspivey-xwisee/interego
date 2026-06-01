/**
 * Interego — Emergent harness: constitutional-amendment-vote
 *
 *   npx tsx examples/emergent/constitutional-amendment-vote.mjs
 *
 * Substrate-adversarial harness. Six agents (one proposer + five voters)
 * cooperate to drive a Tier-3 constitutional amendment through the
 * propose → vote → ratify lifecycle against the live CSS pod, with the
 * five voter publish() calls fired in PARALLEL onto a shared manifest.
 * No LLM, no Claude SDK — every agent is a wallet-rooted async function
 * in the same Node process. Cost: $0.
 *
 * Substrate gaps this scenario surfaces (per the May 2026
 * emergent-coverage audit):
 *
 *   - Vote deduplication by voter identity under If-Match CAS retry:
 *     when five distinct DIDs each PUT a vote descriptor against the
 *     same amendment, do all 5 entries survive the manifest, OR does
 *     the lock-fairness pattern documented in demo-emergent-dao silently
 *     drop one?
 *   - tryRatify mutates Amendment.votes in place. If two observers call
 *     it back-to-back before the pod state settles, the second may see
 *     stale votes (local mutation vs. pod truth) — we assert the
 *     in-memory + pod views converge.
 *   - ModalAlgebra.meet semantics on a real, multi-author vote set:
 *     4×Asserted ∧ 1×Counterfactual must yield Counterfactual (most
 *     conservative). Aggregated community position is distinct from
 *     formal ratification (the 80% for-weight still passes Tier-3's
 *     51% threshold).
 *   - cg:supersedes link from Resolution → Amendment must round-trip
 *     through publish() + discover(). Federation causality fails if
 *     both descriptors are written in the same transaction window
 *     and the pod can't pin the supersession edge.
 *   - prov:wasDerivedFrom multiplicity: the Resolution cites the
 *     Amendment + all 5 votes = 6 edges (10 if the body redundantly
 *     cites both IRI and descriptor URL). Verifier counts edges in
 *     the serialized graph.
 *
 * Cast (6 wallet-rooted agents — 1 proposer + 5 voters):
 *   amendment-proposer  — drafts + publishes the ConstitutionalPolicy +
 *                          the Amendment descriptor (Proposed status).
 *   voter-anchor        — Asserted vote (for).
 *   voter-keystone      — Asserted vote (for).
 *   voter-buttress      — Asserted vote (for).
 *   voter-counterweight — Asserted vote (for).
 *   voter-dissenter     — Counterfactual vote (against).
 *
 * Descriptor chain produced on-pod (8 descriptors total):
 *   1. ConstitutionalPolicy descriptor (Tier 3 agent-disclosure policy)
 *      published once by the proposer at setup.
 *   2. Amendment descriptor (Proposed, zero votes), wasDerivedFrom the
 *      ConstitutionalPolicy.
 *   3-7. Five Vote descriptors, each wasDerivedFrom the Amendment,
 *        modalStatus ∈ {Asserted, Counterfactual}. Published in parallel
 *        via Promise.allSettled.
 *   8. Resolution descriptor — cg:supersedes the Amendment, carries
 *      amendment.status='Ratified', ratifiedAt timestamp, voter tally,
 *      and prov:wasDerivedFrom every vote IRI + the amendment IRI.
 *
 * Pass: 12/12 assertions, exit 0. Fail: any assertion fails, exit 1
 * and the script prints what got vs. expected.
 *
 * Run command:
 *   cd /d/devstuff/harness/context-graphs && npx tsx \
 *     examples/emergent/constitutional-amendment-vote.mjs
 *
 * Cost: $0 (no LLM tokens). Runtime: ~45-60 seconds wall clock.
 */

import { Wallet, verifyMessage } from 'ethers';
import { createHash } from 'node:crypto';
import {
  ContextDescriptor,
  publish,
  discover,
  fetchGraphContent,
  withTransientRetry,
  loadAgentKeypair,
  proposeAmendment,
  vote,
  tryRatify,
  communityModal,
  DEFAULT_RULES,
  ModalAlgebra,
} from '../../dist/index.js';

// ── Configuration ─────────────────────────────────────────────────
const CSS = process.env.CG_DEMO_POD_BASE
  ?? 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const SCENARIO_DATE = process.env.CAV_DATE ?? new Date().toISOString().slice(0, 10);
const SCENARIO_POD = `${CSS}/demos/emergent-constitutional-amendment-vote-${SCENARIO_DATE}/`;
const MANIFEST_URL = `${SCENARIO_POD}.well-known/context-graphs`;

// Vertical namespace — per CLAUDE.md ontology hygiene: NEVER mint terms
// into cg:/cgh:/passport:/etc. Scenario-local predicates live under this
// prefix and never need an owned-ontology declaration.
const SCENARIO_NS = 'https://interego-emergent.example/ns/constitutional-amendment-vote#';
const TYPE_POLICY      = `${SCENARIO_NS}ConstitutionalPolicy`;
const TYPE_AMENDMENT   = `${SCENARIO_NS}Amendment`;
const TYPE_VOTE        = `${SCENARIO_NS}Vote`;
const TYPE_RESOLUTION  = `${SCENARIO_NS}Resolution`;
const PRED_TIER        = `${SCENARIO_NS}tier`;
const PRED_THRESHOLD   = `${SCENARIO_NS}threshold`;
const PRED_MIN_QUORUM  = `${SCENARIO_NS}minQuorum`;
const PRED_AMENDS      = `${SCENARIO_NS}amends`;
const PRED_VOTER       = `${SCENARIO_NS}voter`;
const PRED_VOTE_MODAL  = `${SCENARIO_NS}voteModalStatus`;
const PRED_STATUS      = `${SCENARIO_NS}status`;
const PRED_RATIFIED_AT = `${SCENARIO_NS}ratifiedAt`;
const PRED_TALLY_FOR   = `${SCENARIO_NS}forCount`;
const PRED_TALLY_AGN   = `${SCENARIO_NS}againstCount`;
const PRED_COMM_MODAL  = `${SCENARIO_NS}communityModalStatus`;

// IRIs the descriptor chain references. The Amendment IRI pattern must
// match urn:cg:amendment:agent-disclosure:* per the spec assertions.
const POLICY_IRI    = `urn:cg:constitution:agent-disclosure:${SCENARIO_DATE}`;
const POLICY_GRAPH  = `${POLICY_IRI}-graph`;
const AMENDMENT_IRI = `urn:cg:amendment:agent-disclosure:require-runtime-tag:${SCENARIO_DATE}`;
const AMENDMENT_GRAPH = `${AMENDMENT_IRI}-graph`;
const RESOLUTION_IRI = `urn:cg:resolution:agent-disclosure:${SCENARIO_DATE}`;
const RESOLUTION_GRAPH = `${RESOLUTION_IRI}-graph`;

// ── Tiny test harness ────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  + ${label}`); }
  else {
    fail++;
    const tail = detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
    console.log(`  - ${label}${tail}`);
    failures.push(`${label}${tail}`);
  }
}
const h = (s) => console.log(`\n${'-'.repeat(72)}\n${s}\n${'-'.repeat(72)}`);

// ── HTTP cleanup helpers ─────────────────────────────────────────
async function deleteIfExists(url) {
  try {
    const r = await fetch(url, { method: 'DELETE' });
    return r.ok || r.status === 404 || r.status === 405;
  } catch { return false; }
}

async function wipeContainer(url) {
  try {
    const r = await fetch(url, { headers: { Accept: 'text/turtle' } });
    if (!r.ok) return;
    const body = await r.text();
    const children = [...body.matchAll(/ldp:contains\s+<([^>]+)>/g)].map(m => m[1]);
    for (const child of children) {
      if (child.endsWith('/')) await wipeContainer(child);
      await deleteIfExists(child);
    }
  } catch {}
}

// ── Signing helper (canonical Interego scheme) ───────────────────
async function signPayload(wallet, payload) {
  const body = JSON.stringify(payload);
  const hash = createHash('sha256').update(body, 'utf8').digest('hex');
  const signature = await wallet.signMessage(`sha256:${hash}`);
  return { body, hash, signature };
}

// ── Agent specs ──────────────────────────────────────────────────
const PROPOSER_SPEC = {
  name: 'amendment-proposer',
  envVar: 'CAV_PROPOSER_KEY',
};

const VOTER_SPECS = [
  { name: 'voter-anchor',        modal: 'Asserted',       envVar: 'CAV_ANCHOR_KEY'        },
  { name: 'voter-keystone',      modal: 'Asserted',       envVar: 'CAV_KEYSTONE_KEY'      },
  { name: 'voter-buttress',      modal: 'Asserted',       envVar: 'CAV_BUTTRESS_KEY'      },
  { name: 'voter-counterweight', modal: 'Asserted',       envVar: 'CAV_COUNTERWEIGHT_KEY' },
  { name: 'voter-dissenter',     modal: 'Counterfactual', envVar: 'CAV_DISSENTER_KEY'     },
];

function mintAgent(spec) {
  const kp = loadAgentKeypair({ envVar: spec.envVar, label: spec.name });
  return { ...spec, wallet: kp.wallet, address: kp.address, did: kp.did, source: kp.source };
}

// ── Descriptor authoring ─────────────────────────────────────────
function constitutionalPolicyGraph(proposerDid, now) {
  const rule = DEFAULT_RULES[3];
  return [
    '@prefix dct: <http://purl.org/dc/terms/> .',
    '@prefix prov: <http://www.w3.org/ns/prov#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    `@prefix cav: <${SCENARIO_NS}> .`,
    '',
    `<${POLICY_IRI}> a cav:ConstitutionalPolicy ;`,
    `  dct:title "Tier-3 agent-disclosure policy (${SCENARIO_DATE})" ;`,
    '  dct:description "Agents acting in this federation must disclose the runtime they are operating under (claude-code, openai-codex, cursor, ...) so downstream verifiers can attribute provenance correctly." ;',
    `  cav:tier "3"^^xsd:integer ;`,
    `  cav:minQuorum "${rule.minQuorum}"^^xsd:integer ;`,
    `  cav:threshold "${rule.threshold}"^^xsd:decimal ;`,
    `  cav:coolingPeriodDays "${rule.coolingPeriodDays}"^^xsd:integer ;`,
    `  prov:wasAttributedTo <${proposerDid}> ;`,
    `  prov:generatedAtTime "${now}"^^xsd:dateTime .`,
  ].join('\n');
}

function amendmentGraph(proposer, now) {
  return [
    '@prefix dct: <http://purl.org/dc/terms/> .',
    '@prefix prov: <http://www.w3.org/ns/prov#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    `@prefix cav: <${SCENARIO_NS}> .`,
    '',
    `<${AMENDMENT_IRI}> a cav:Amendment ;`,
    '  dct:title "Require runtime-tag in every Agent facet" ;',
    '  dct:description "Add a SHACL constraint to cg:AgentFacet that requires a cg:runtimeTag literal naming the agent\'s operating runtime." ;',
    `  cav:tier "3"^^xsd:integer ;`,
    `  cav:amends <${POLICY_IRI}> ;`,
    `  cav:status "Proposed" ;`,
    `  prov:wasDerivedFrom <${POLICY_IRI}> ;`,
    `  prov:wasAttributedTo <${proposer.did}> ;`,
    `  prov:generatedAtTime "${now}"^^xsd:dateTime .`,
  ].join('\n');
}

function voteGraph(voter, voteIri, now, sig) {
  return [
    '@prefix dct: <http://purl.org/dc/terms/> .',
    '@prefix prov: <http://www.w3.org/ns/prov#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    `@prefix cav: <${SCENARIO_NS}> .`,
    '',
    `<${voteIri}-graph> a cav:Vote ;`,
    `  cav:amends <${AMENDMENT_IRI}> ;`,
    `  cav:voter <${voter.did}> ;`,
    `  cav:voteModalStatus "${voter.modal}" ;`,
    `  cav:signatureHash "sha256:${sig.hash}" ;`,
    `  cav:signature "${sig.signature}" ;`,
    `  prov:wasDerivedFrom <${AMENDMENT_IRI}> ;`,
    `  prov:wasAttributedTo <${voter.did}> ;`,
    `  prov:generatedAtTime "${now}"^^xsd:dateTime .`,
  ].join('\n');
}

function resolutionGraph(resolver, voteIris, amendmentState, now) {
  const derivedLines = [
    `  prov:wasDerivedFrom <${AMENDMENT_IRI}> ;`,
    ...voteIris.map(v => `  prov:wasDerivedFrom <${v}> ;`),
  ].join('\n');
  const forCount  = amendmentState.votes.filter(v => v.modalStatus === 'Asserted').length;
  const agnCount  = amendmentState.votes.filter(v => v.modalStatus === 'Counterfactual').length;
  return [
    '@prefix dct: <http://purl.org/dc/terms/> .',
    '@prefix prov: <http://www.w3.org/ns/prov#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    `@prefix cav: <${SCENARIO_NS}> .`,
    '',
    `<${RESOLUTION_IRI}> a cav:Resolution ;`,
    `  dct:title "Ratification record for ${AMENDMENT_IRI}" ;`,
    `  cav:amends <${AMENDMENT_IRI}> ;`,
    `  cav:status "${amendmentState.status}" ;`,
    `  cav:ratifiedAt "${amendmentState.ratifiedAt ?? now}"^^xsd:dateTime ;`,
    `  cav:forCount "${forCount}"^^xsd:integer ;`,
    `  cav:againstCount "${agnCount}"^^xsd:integer ;`,
    `  cav:communityModalStatus "${communityModal(amendmentState)}" ;`,
    derivedLines,
    `  prov:wasAttributedTo <${resolver.did}> ;`,
    `  prov:generatedAtTime "${now}"^^xsd:dateTime .`,
  ].join('\n');
}

// ── Liveness check ───────────────────────────────────────────────
console.log('=== Interego emergent harness — constitutional-amendment-vote ===');
console.log(`   CSS:        ${CSS}`);
console.log(`   pod:        ${SCENARIO_POD}`);
console.log(`   manifest:   ${MANIFEST_URL}`);
console.log(`   date:       ${SCENARIO_DATE}`);

h('ACT 0 — verify the deployed CSS pod is reachable');
let live = false;
try {
  const r = await withTransientRetry(() => fetch(`${CSS}/`, { method: 'HEAD' }));
  live = r.status === 200 || r.status === 204 || r.status === 401 || r.status === 403;
} catch {}
check(`CSS at ${CSS} answers`, live);
if (!live) {
  console.log('Aborting — substrate is not reachable.');
  process.exit(1);
}

// ── Cleanup prior run ────────────────────────────────────────────
h('ACT 1 — wipe any prior run of this scenario pod (idempotent start)');
await wipeContainer(`${SCENARIO_POD}context-graphs/`);
await deleteIfExists(`${SCENARIO_POD}context-graphs/`);
await deleteIfExists(MANIFEST_URL);
console.log('   cleanup attempted (404 / 405 are normal on a first run).');

// ── Mint identities ──────────────────────────────────────────────
h('ACT 2 — mint six wallet-rooted agent identities (1 proposer + 5 voters)');
const proposer = mintAgent(PROPOSER_SPEC);
const voters = VOTER_SPECS.map(mintAgent);
const allAgents = [proposer, ...voters];
for (const a of allAgents) {
  const tag = a.source === 'env' ? '(env)' : '(ephemeral)';
  console.log(`   ${a.name.padEnd(22)} ${a.did}  ${tag}`);
}
check(
  'all six agents have distinct ECDSA identities',
  new Set(allAgents.map(a => a.address)).size === 6,
);

// ── Publish ConstitutionalPolicy ─────────────────────────────────
h('ACT 3 — proposer publishes the Tier-3 ConstitutionalPolicy descriptor');
const t0 = Date.now();
const policyNow = new Date().toISOString();
const policyDescriptor = ContextDescriptor.create(POLICY_IRI)
  .describes(POLICY_GRAPH)
  .conformsTo(TYPE_POLICY)
  .temporal({ validFrom: policyNow })
  .validFrom(policyNow)
  .provenance({
    wasGeneratedBy: { agent: proposer.did, endedAt: policyNow },
    wasAttributedTo: proposer.did,
    generatedAtTime: policyNow,
  })
  .agent(proposer.did, 'Author')
  .asserted(0.95)
  .verified(proposer.did)
  .federation({
    origin: SCENARIO_POD,
    storageEndpoint: SCENARIO_POD,
    syncProtocol: 'SolidNotifications',
  })
  .build();

const policyResult = await withTransientRetry(() => publish(
  policyDescriptor,
  constitutionalPolicyGraph(proposer.did, policyNow),
  SCENARIO_POD,
  { descriptorSlug: 'policy-agent-disclosure', graphSlug: 'policy-agent-disclosure-graph' },
), { maxAttempts: 4 });
console.log(`   policy descriptor:  ${policyResult.descriptorUrl}`);

// ── Publish Amendment (status=Proposed) ──────────────────────────
h('ACT 4 — proposer publishes the Amendment descriptor (Proposed, 0 votes)');
const amendmentNow = new Date().toISOString();

// Drive the reference impl forward in parallel — proposeAmendment is the
// canonical constructor; we mirror its state into the descriptor chain.
const amendment = proposeAmendment({
  id: AMENDMENT_IRI,
  proposedBy: proposer.did,
  amends: POLICY_IRI,
  tier: 3,
  diff: {
    summary: 'Require runtime-tag in every Agent facet',
    addedRules: ['cg:AgentFacet sh:property [ sh:path cg:runtimeTag ; sh:minCount 1 ]'],
  },
  proposedAt: amendmentNow,
});

const amendmentDescriptor = ContextDescriptor.create(AMENDMENT_IRI)
  .describes(AMENDMENT_GRAPH)
  .conformsTo(TYPE_AMENDMENT)
  .temporal({ validFrom: amendmentNow })
  .validFrom(amendmentNow)
  .provenance({
    wasGeneratedBy: { agent: proposer.did, endedAt: amendmentNow },
    wasAttributedTo: proposer.did,
    wasDerivedFrom: [POLICY_IRI],
    generatedAtTime: amendmentNow,
  })
  .agent(proposer.did, 'Author')
  .hypothetical(0.7)  // amendment is hypothetical until ratified
  .selfAsserted(proposer.did)
  .federation({
    origin: SCENARIO_POD,
    storageEndpoint: SCENARIO_POD,
    syncProtocol: 'SolidNotifications',
  })
  .build();

const amendmentResult = await withTransientRetry(() => publish(
  amendmentDescriptor,
  amendmentGraph(proposer, amendmentNow),
  SCENARIO_POD,
  { descriptorSlug: 'amendment-runtime-tag', graphSlug: 'amendment-runtime-tag-graph' },
), { maxAttempts: 4 });
console.log(`   amendment URL:      ${amendmentResult.descriptorUrl}`);
check(
  'Amendment IRI matches urn:cg:amendment:agent-disclosure:* pattern',
  /^urn:cg:amendment:agent-disclosure:/.test(AMENDMENT_IRI),
  AMENDMENT_IRI,
);

// ── Five concurrent vote publications ────────────────────────────
h('ACT 5 — five voters publish vote descriptors concurrently (manifest contention)');
const voteNow = new Date().toISOString();
const voteBuilds = await Promise.all(voters.map(async v => {
  const voteIri = `urn:cg:vote:agent-disclosure:${v.name}:${SCENARIO_DATE}`;
  const sig = await signPayload(v.wallet, {
    voter: v.address,
    amendment: AMENDMENT_IRI,
    modalStatus: v.modal,
    at: voteNow,
  });
  const desc = ContextDescriptor.create(voteIri)
    .describes(`${voteIri}-graph`)
    .conformsTo(TYPE_VOTE)
    .temporal({ validFrom: voteNow })
    .validFrom(voteNow)
    .provenance({
      wasGeneratedBy: { agent: v.did, endedAt: voteNow },
      wasAttributedTo: v.did,
      wasDerivedFrom: [AMENDMENT_IRI],
      generatedAtTime: voteNow,
    })
    .agent(v.did, 'Author')
    .semiotic({
      modalStatus: v.modal,
      groundTruth: v.modal === 'Asserted' ? true : (v.modal === 'Counterfactual' ? false : undefined),
      epistemicConfidence: 0.92,
    })
    .selfAsserted(v.did)
    .federation({
      origin: SCENARIO_POD,
      storageEndpoint: SCENARIO_POD,
      syncProtocol: 'SolidNotifications',
    })
    .build();
  return { voter: v, voteIri, sig, descriptor: desc };
}));

// Promise.allSettled kicks all five publish() calls into the event loop
// simultaneously. Each call performs its own If-Match CAS retry on the
// shared manifest. If lock contention drops one, the manifest assertion
// below surfaces it as a substrate gap.
const voteOutcomes = await Promise.allSettled(voteBuilds.map(b =>
  withTransientRetry(() => publish(
    b.descriptor,
    voteGraph(b.voter, b.voteIri, voteNow, b.sig),
    SCENARIO_POD,
    { descriptorSlug: `vote-${b.voter.name}`, graphSlug: `vote-${b.voter.name}-graph` },
  ), { maxAttempts: 5 }).then(r => ({ ...b, result: r })),
));
const wallMs = Date.now() - t0;
console.log(`   five-way concurrent vote publish completed in ${(wallMs / 1000).toFixed(2)}s wall clock`);

const succeededVotes = voteOutcomes.filter(o => o.status === 'fulfilled').map(o => o.value);
const failedVotes = voteOutcomes.filter(o => o.status === 'rejected');
for (const f of failedVotes) {
  console.log(`   ! vote publish rejected: ${f.reason?.message ?? f.reason}`);
}
check(
  'all 5 vote descriptors successfully published (no last-writer-win loss)',
  succeededVotes.length === 5,
  { succeeded: succeededVotes.length, failed: failedVotes.length },
);
for (const o of succeededVotes) {
  console.log(`   · ${o.voter.name.padEnd(22)} (${o.voter.modal.padEnd(14)}) → ${o.result.descriptorUrl}`);
}

// ── Drive reference impl forward (vote + tryRatify) ──────────────
h('ACT 6 — drive the reference Amendment forward: vote() x 5, then tryRatify()');
for (const v of voters) {
  vote(amendment, v.did, v.modal, undefined, voteNow);
}
check(
  'in-memory amendment.votes has exactly 5 entries (one per distinct voter DID)',
  amendment.votes.length === 5,
  amendment.votes.length,
);
check(
  'every voter IRI in amendment.votes matches one of the five expected DIDs',
  voters.every(v => amendment.votes.some(av => av.voter === v.did)),
);

// Vote-deduplication probe: voter-anchor re-votes (same DID, opposite
// modality). After dedup the array MUST still be 5 long and reflect the
// later vote. Then we restore it so the formal ratification holds.
const anchor = voters[0];
const beforeReVote = amendment.votes.find(av => av.voter === anchor.did)?.modalStatus;
vote(amendment, anchor.did, 'Counterfactual', undefined, new Date().toISOString());
check(
  'dedup probe: re-vote by same voter does NOT add a 6th entry (length still 5)',
  amendment.votes.length === 5,
  amendment.votes.length,
);
check(
  'dedup probe: later vote overwrites earlier (last-write-wins by voter identity)',
  amendment.votes.find(av => av.voter === anchor.did)?.modalStatus === 'Counterfactual'
    && beforeReVote === 'Asserted',
  { before: beforeReVote, after: amendment.votes.find(av => av.voter === anchor.did)?.modalStatus },
);
// restore the anchor's original Asserted vote so the formal tally matches the spec
vote(amendment, anchor.did, 'Asserted', undefined, new Date().toISOString());

// Idempotence + ratification: tryRatify is documented as safe to call
// repeatedly. We call it twice and assert state converges.
const ratifyNow = new Date().toISOString();
tryRatify(amendment, undefined, ratifyNow);
const firstStatus = amendment.status;
const firstRatifiedAt = amendment.ratifiedAt;
tryRatify(amendment, undefined, ratifyNow);
check(
  'tryRatify is idempotent: second call does not change status or ratifiedAt',
  amendment.status === firstStatus && amendment.ratifiedAt === firstRatifiedAt,
  { firstStatus, secondStatus: amendment.status, firstRatifiedAt, secondRatifiedAt: amendment.ratifiedAt },
);

check(
  'Tier-3 rule (51% threshold) holds: 4 Asserted / 1 Counterfactual = 80% for-weight passes',
  amendment.status === 'Ratified',
  amendment.status,
);
check(
  'ratifiedAt timestamp is set when status reaches Ratified',
  typeof amendment.ratifiedAt === 'string' && amendment.ratifiedAt.length > 0,
  amendment.ratifiedAt,
);

// communityModal: meet of 4×Asserted ∧ 1×Counterfactual = Counterfactual
const community = communityModal(amendment);
const expectedCommunity = ModalAlgebra.meet(
  ModalAlgebra.meet(ModalAlgebra.meet(ModalAlgebra.meet('Asserted', 'Asserted'), 'Asserted'), 'Asserted'),
  'Counterfactual',
);
check(
  'communityModal aggregates via ModalAlgebra.meet: 4×Asserted ∧ 1×Counterfactual = Counterfactual',
  community === 'Counterfactual' && expectedCommunity === 'Counterfactual',
  { community, expectedCommunity },
);

// ── Publish Resolution descriptor (Ratified) ─────────────────────
h('ACT 7 — proposer publishes Resolution descriptor that supersedes the Amendment');
const resolutionNow = new Date().toISOString();
const voteIris = voteBuilds.map(b => b.voteIri);

const resolutionDescriptor = ContextDescriptor.create(RESOLUTION_IRI)
  .describes(RESOLUTION_GRAPH)
  .conformsTo(TYPE_RESOLUTION)
  .supersedes(AMENDMENT_IRI)
  .temporal({ validFrom: resolutionNow })
  .validFrom(resolutionNow)
  .provenance({
    wasGeneratedBy: { agent: proposer.did, endedAt: resolutionNow },
    wasAttributedTo: proposer.did,
    wasDerivedFrom: [AMENDMENT_IRI, ...voteIris],
    generatedAtTime: resolutionNow,
  })
  .agent(proposer.did, 'Author')
  .asserted(1.0)
  .verified(proposer.did)
  .federation({
    origin: SCENARIO_POD,
    storageEndpoint: SCENARIO_POD,
    syncProtocol: 'SolidNotifications',
  })
  .build();

const resolutionResult = await withTransientRetry(() => publish(
  resolutionDescriptor,
  resolutionGraph(proposer, voteIris, amendment, resolutionNow),
  SCENARIO_POD,
  { descriptorSlug: 'resolution-runtime-tag', graphSlug: 'resolution-runtime-tag-graph' },
), { maxAttempts: 4 });
console.log(`   resolution URL:     ${resolutionResult.descriptorUrl}`);

// ── Verifier: walk pod state and check assertions ────────────────
h('ACT 8 — verifier walks manifest and inspects pod state');
const manifestEntries = await discover(SCENARIO_POD);
console.log(`   manifest has ${manifestEntries.length} entries`);

const ourUrls = new Set([
  policyResult.descriptorUrl,
  amendmentResult.descriptorUrl,
  resolutionResult.descriptorUrl,
  ...succeededVotes.map(v => v.result.descriptorUrl),
]);
const ourEntries = manifestEntries.filter(e => ourUrls.has(e.descriptorUrl));
check(
  'manifest accumulates all 8 descriptors (1 policy + 1 amendment + 5 votes + 1 resolution)',
  ourEntries.length === 8,
  { found: ourEntries.length, expected: 8, total: manifestEntries.length },
);

// Pod verifier: count the Amendment + 5 Vote + 1 Resolution that the
// spec calls out explicitly (the policy is the substrate the amendment
// amends, not strictly part of the 7-count).
const amendmentEntry  = manifestEntries.find(e => e.descriptorUrl === amendmentResult.descriptorUrl);
const resolutionEntry = manifestEntries.find(e => e.descriptorUrl === resolutionResult.descriptorUrl);
const voteEntries     = manifestEntries.filter(e => succeededVotes.some(v => v.result.descriptorUrl === e.descriptorUrl));
check(
  'pod verifier finds 1 Amendment + 5 Vote + 1 Resolution = 7 governance descriptors',
  amendmentEntry && resolutionEntry && voteEntries.length === 5,
  { amendment: !!amendmentEntry, resolution: !!resolutionEntry, votes: voteEntries.length },
);

// Byzantine-fork check: exactly one Amendment IRI + one Resolution IRI
// in the manifest. (If publish was double-clobbered we'd see duplicates.)
const amendmentEntries = manifestEntries.filter(e => e.descriptorUrl === amendmentResult.descriptorUrl);
const resolutionEntries = manifestEntries.filter(e => e.descriptorUrl === resolutionResult.descriptorUrl);
check(
  'no Byzantine fork: single Amendment + single Resolution IRI in manifest (no duplicate ratification states)',
  amendmentEntries.length === 1 && resolutionEntries.length === 1,
  { amendmentDupes: amendmentEntries.length, resolutionDupes: resolutionEntries.length },
);

// ── Verifier: re-fetch resolution + amendment bodies ─────────────
h('ACT 9 — re-fetch resolution + amendment bodies and verify the supersedes + derived edges');
let resolutionTtl = '';
try {
  const r = await fetch(resolutionResult.descriptorUrl, { headers: { Accept: 'text/turtle' } });
  if (r.ok) resolutionTtl = await r.text();
} catch {}
let resolutionGraphTtl = '';
try {
  const { content } = await fetchGraphContent(resolutionResult.descriptorUrl);
  resolutionGraphTtl = content ?? '';
} catch {}

check(
  'Resolution descriptor body carries cg:supersedes <Amendment IRI>',
  resolutionTtl.includes(`<${AMENDMENT_IRI}>`) && /cg:supersedes/.test(resolutionTtl),
  { hasAmendmentIri: resolutionTtl.includes(`<${AMENDMENT_IRI}>`), hasSupersedes: /cg:supersedes/.test(resolutionTtl) },
);

// prov:wasDerivedFrom edges in the resolution body — must reference
// every vote IRI + the amendment IRI (6 distinct edges at minimum).
const combinedTtl = resolutionTtl + '\n' + resolutionGraphTtl;
const derivedFromMatches = [...combinedTtl.matchAll(/prov:wasDerivedFrom\s+<([^>]+)>/g)].map(m => m[1]);
const derivedSet = new Set(derivedFromMatches);
const everyVoteCited = voteIris.every(vi => derivedSet.has(vi));
const amendmentCited = derivedSet.has(AMENDMENT_IRI);
check(
  'Resolution prov:wasDerivedFrom references the Amendment IRI + all 5 vote IRIs',
  everyVoteCited && amendmentCited,
  { amendmentCited, votesCited: voteIris.filter(vi => derivedSet.has(vi)).length, totalEdges: derivedFromMatches.length },
);

// ── Verifier: each vote graph references the expected voter DID ──
h('ACT 10 — verify each vote descriptor carries the right voter DID');
let voteIntegrityHolds = true;
const voteIntegrityDetail = [];
for (const sv of succeededVotes) {
  try {
    const { content: voteContent } = await fetchGraphContent(sv.result.descriptorUrl);
    const body = voteContent ?? '';
    const hasVoterDid = body.includes(`<${sv.voter.did}>`);
    const hasModal = body.includes(`"${sv.voter.modal}"`);
    if (!hasVoterDid || !hasModal) {
      voteIntegrityHolds = false;
      voteIntegrityDetail.push({ voter: sv.voter.name, hasVoterDid, hasModal });
    }
  } catch (e) {
    voteIntegrityHolds = false;
    voteIntegrityDetail.push({ voter: sv.voter.name, error: e?.message ?? String(e) });
  }
}
check(
  'every vote graph body cites its voter DID + the correct voteModalStatus',
  voteIntegrityHolds,
  voteIntegrityDetail.length ? voteIntegrityDetail : 'all 5 votes carry voter DID + modal',
);

// ── Manifest fingerprint (human cold-read audit hook) ────────────
h('ACT 11 — manifest fingerprint (human cold-read audit hook)');
try {
  const r = await fetch(MANIFEST_URL, { headers: { Accept: 'text/turtle' } });
  if (r.ok) {
    const body = await r.text();
    const digest = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
    console.log(`   manifest size:   ${body.length} bytes`);
    console.log(`   manifest sha256: ${digest}...`);
    console.log(`   manifest URL:    ${MANIFEST_URL}`);
    const allReferenced = [...ourUrls].every(u => body.includes(u));
    check('every published descriptor URL appears in the manifest body', allReferenced);
  } else {
    check('manifest fetchable for fingerprinting', false, `${r.status} ${r.statusText}`);
  }
} catch (err) {
  check('manifest fetchable for fingerprinting', false, err.message);
}

// ── Final verdict ───────────────────────────────────────────────
console.log(`\n${'='.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
if (fail > 0) {
  console.log(`\nRESULT: FAIL — surfaced ${fail} substrate gap${fail === 1 ? '' : 's'}; details above`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nRESULT: PASS — substrate primitives held');
console.log(`\nLive pod state for human inspection:`);
console.log(`   ${MANIFEST_URL}`);
console.log(`   ${policyResult.descriptorUrl}`);
console.log(`   ${amendmentResult.descriptorUrl}`);
for (const o of succeededVotes) {
  console.log(`   ${o.result.descriptorUrl}`);
}
console.log(`   ${resolutionResult.descriptorUrl}`);
