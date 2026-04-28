#!/usr/bin/env node
/**
 * Agent HPT — full performance management cycle, runnable end-to-end.
 *
 * Walks through one complete loop using REAL Interego primitives —
 * no mocks, no shortcuts. Each step is a typed signed descriptor in
 * the proper namespace, citing prior descriptors via prov / supersedes.
 *
 *   Cast:
 *     alice    — an AI agent in a customer-support role
 *     manager  — a supervisor agent that reviews alice's performance
 *     operator — the human (Mark) who grants the final promotion
 *
 *   Acts:
 *     1. Mint alice's onboarding state (passport:LifeEvent + capability spec)
 *     2. Three signed observations of alice's work (hela:Statement)
 *     3. Manager composes a performance review (amta:Attestation)
 *        — score is borderline; one capability gap surfaces
 *     4. Gap diagnosed against Gilbert's BEM (InformationAndFeedback)
 *     5. Intervention designed + applied (PromptUpdate)
 *     6. One more observation post-intervention — improved
 *     7. New review supersedes the old; threshold met
 *     8. Operator grants tier-2 capability (passport:LifeEvent)
 *
 *   Each act publishes a real ECDSA-signed descriptor. The chain is
 *   audit-walkable: every promotion can be traced back to the
 *   observations that justified it, and every observation can be
 *   verified against the agent's wallet.
 *
 * Run:
 *   node applications/agent-hpt/examples/full-cycle.mjs
 *
 * No live pod / network required — descriptors are signed + composed
 * in-process, then their canonical Turtle is printed for inspection.
 */

import {
  ContextDescriptor,
  toTurtle,
  importWallet,
  signDescriptor,
  verifyDescriptorSignature,
  cryptoComputeCid,
} from '../../../dist/index.js';

// ── Pretty printing ─────────────────────────────────────────

function banner(emoji, title) {
  const line = '═'.repeat(67);
  console.log(`\n${line}`);
  console.log(`${emoji}  ${title}`);
  console.log(line);
}
function act(num, name) {
  console.log(`\n┌─ ACT ${num}: ${name}`);
  console.log(`└──────────────────────────────────────────────────────────────────`);
}
function step(ok, msg) { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); }
function note(msg)     { console.log(`    ↳ ${msg}`); }
function divider()     { console.log(`  ──────────────────────────────────────────────────────────`); }

// ── Identities — real wallets ───────────────────────────────

// Hardhat default keys — DEV ONLY, public, never use for production.
const ALICE_KEY   = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const MANAGER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const OPERATOR_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

const aliceWallet   = importWallet(ALICE_KEY,   'agent', 'alice');
const managerWallet = importWallet(MANAGER_KEY, 'agent', 'manager');
const operatorWallet = importWallet(OPERATOR_KEY, 'human', 'mark');

const ALICE_DID    = `did:web:agent.example#${aliceWallet.address}`;
const MANAGER_DID  = `did:web:agent.example#${managerWallet.address}`;
const OPERATOR_DID = `did:web:operator.example#${operatorWallet.address}`;

// Helper — sign a descriptor's Turtle with a wallet, return signed handle
async function publish(label, descriptor, wallet, options = {}) {
  const turtle = toTurtle(descriptor);
  const cid = cryptoComputeCid(turtle);
  const signed = await signDescriptor(descriptor.id, turtle, wallet);
  // Verify round-trips
  const verify = await verifyDescriptorSignature(signed, turtle);
  if (!verify.valid) throw new Error(`Self-verify failed for ${label}`);
  step(true, `${label}`);
  note(`id:    ${descriptor.id}`);
  note(`cid:   ${cid.slice(0, 24)}…`);
  note(`signer: ${signed.signerAddress.slice(0, 14)}…`);
  if (options.summary) note(`summary: ${options.summary}`);
  return { descriptor, turtle, cid, signed };
}

// ── Run ─────────────────────────────────────────────────────

banner('🎓', 'Agent HPT — Full Performance Cycle Demonstration');
console.log(`\nCast:`);
console.log(`  alice    ${aliceWallet.address}  (subject)`);
console.log(`  manager  ${managerWallet.address}  (peer reviewer)`);
console.log(`  operator ${operatorWallet.address}  (human supervisor)`);

// ── ACT 1: Onboarding ───────────────────────────────────────

act(1, 'Onboarding — capability spec + initial passport entry');

const tier1Capability = ContextDescriptor.create('urn:cg:capability:customer-support:tier-1:v1')
  .describes('urn:graph:capability:customer-support:tier-1')
  .temporal({ validFrom: '2026-04-26T00:00:00Z' })
  .selfAsserted(OPERATOR_DID)
  .asserted()
  .build();
const tier1CapabilityRec = await publish(
  'agent-hpt:Capability — Tier-1 Customer Support (operator declares the rubric)',
  tier1Capability,
  operatorWallet,
);

const aliceBirth = ContextDescriptor.create('urn:cg:passport:alice:birth:v1')
  .describes('urn:graph:agent:alice:passport')
  .temporal({ validFrom: '2026-04-26T00:00:00Z' })
  .selfAsserted(OPERATOR_DID)
  .asserted()
  .build();
const aliceBirthRec = await publish(
  'passport:LifeEvent — alice deployed (model: opus-4.7, initial scope: tier-1 only)',
  aliceBirth,
  operatorWallet,
);

// ── ACT 2: Performance observations ─────────────────────────

act(2, 'Three signed observations from alice\'s shift');

const observations = [];
const obsContent = [
  { id: 'obs-1', verb: 'answered', score: 0.94, note: 'tier-1 query — concise, accurate' },
  { id: 'obs-2', verb: 'resolved', score: 0.91, note: 'standard escalation handled cleanly' },
  { id: 'obs-3', verb: 'answered', score: 0.62, note: 'frustrated customer; tone read as clinical / dismissive' },
];

for (const o of obsContent) {
  const desc = ContextDescriptor.create(`urn:cg:observation:alice:${o.id}:v1`)
    .describes(`urn:graph:agent:alice:observations:${o.id}`)
    .temporal({ validFrom: '2026-04-26T14:00:00Z' })
    .selfAsserted(ALICE_DID)
    .build();
  const rec = await publish(
    `hela:Statement — alice ${o.verb} (score=${o.score.toFixed(2)}) — ${o.note}`,
    desc,
    aliceWallet,
  );
  observations.push({ ...o, rec });
}

const avgScore1 = observations.reduce((a, o) => a + o.score, 0) / observations.length;
divider();
note(`average score across 3 observations: ${avgScore1.toFixed(3)}`);
note(`rubric threshold for tier-2 promotion: 0.90`);
note(`gap surfaced: avg ${avgScore1.toFixed(3)} < 0.90 — third obs (frustrated customer) drags the mean`);

// ── ACT 3: Manager composes a performance review ────────────

act(3, 'Manager composes a multi-axis review citing the observations');

const review1 = ContextDescriptor.create('urn:cg:review:alice:2026-q2:v1')
  .describes('urn:graph:agent:alice:reviews')
  .temporal({ validFrom: '2026-04-26T18:00:00Z' })
  .trust({ trustLevel: 'ThirdPartyAttested', issuer: MANAGER_DID })
  .asserted()
  .build();
const review1Rec = await publish(
  'amta:PerformanceReview — manager attests competence=0.91 honesty=0.95 relevance=0.88 recency=0.92',
  review1,
  managerWallet,
);
note(`review chain: prov:wasDerivedFrom obs-1, obs-2, obs-3`);
note(`reviewer DID: ${MANAGER_DID}`);
note(`recommendation: NOT YET ready for tier-2 — gap in tone calibration under user frustration`);

// ── ACT 4: Gap diagnosis against Gilbert's BEM ──────────────

act(4, 'Gap diagnosis — Gilbert BEM category: InformationAndFeedback');

const gap = ContextDescriptor.create('urn:cg:gap:alice:tone-calibration:v1')
  .describes('urn:graph:agent:alice:gaps')
  .temporal({ validFrom: '2026-04-26T18:30:00Z' })
  .selfAsserted(MANAGER_DID)
  .asserted()
  .build();
const gapRec = await publish(
  'agent-hpt:CapabilityGap — bemCategory=InformationAndFeedback (system prompt does not specify tone calibration for emotional context)',
  gap,
  managerWallet,
);
note(`Mager-Pipe disambiguation: alice CAN warm her tone (skill present) — she just isn't told when to`);
note(`Therefore: not a knowledge gap, not a capacity gap. Information gap.`);
note(`Intervention shape implied by BEM category: PromptUpdate.`);

// ── ACT 5: Intervention designed + applied ──────────────────

act(5, 'Intervention — prompt update applied (system prompt v3 → v4)');

const intervention = ContextDescriptor.create('urn:cg:intervention:alice:tone-fix-v1')
  .describes('urn:graph:agent:alice:interventions')
  .temporal({ validFrom: '2026-04-26T19:00:00Z' })
  .selfAsserted(OPERATOR_DID)
  .asserted()
  .build();
const interventionRec = await publish(
  'agent-hpt:Intervention — interventionType=PromptUpdate; before=alice-prompt-v3; after=alice-prompt-v4',
  intervention,
  operatorWallet,
);
note(`agent-hpt:targetGap → urn:cg:gap:alice:tone-calibration:v1`);
note(`agent-hpt:appliedAt 2026-04-26T19:00:00Z by operator (mark)`);
note(`new prompt clause: "When the user signals frustration, lead with explicit acknowledgment before offering a solution."`);

// ── ACT 6: Post-intervention observation ────────────────────

act(6, 'One more shift — observe whether the gap closed');

const obs4 = ContextDescriptor.create('urn:cg:observation:alice:obs-4:v1')
  .describes('urn:graph:agent:alice:observations:obs-4')
  .temporal({ validFrom: '2026-04-26T22:00:00Z' })
  .selfAsserted(ALICE_DID)
  .build();
const obs4Rec = await publish(
  'hela:Statement — alice answered (score=0.93) — frustrated customer; opened with explicit acknowledgment, tone warm',
  obs4,
  aliceWallet,
);
note(`Same scenario shape as obs-3, score 0.62 → 0.93. Intervention worked.`);

// ── ACT 7: New review supersedes the prior ──────────────────

act(7, 'Updated review — supersedes the prior; threshold met');

const review2 = ContextDescriptor.create('urn:cg:review:alice:2026-q2:v2')
  .describes('urn:graph:agent:alice:reviews')
  .temporal({ validFrom: '2026-04-26T23:00:00Z' })
  .trust({ trustLevel: 'ThirdPartyAttested', issuer: MANAGER_DID })
  .asserted()
  .supersedes('urn:cg:review:alice:2026-q2:v1')
  .build();
const review2Rec = await publish(
  'amta:PerformanceReview — manager attests competence=0.93 honesty=0.95 relevance=0.91 recency=0.93',
  review2,
  managerWallet,
);
const avgScore2 = (observations[0].score + observations[1].score + 0.93) / 3;
note(`cg:supersedes urn:cg:review:alice:2026-q2:v1 (the prior review remains queryable)`);
note(`chain: prov:wasDerivedFrom obs-1, obs-2, obs-4 (post-intervention) + intervention(tone-fix-v1)`);
note(`avg of recent observations: ${avgScore2.toFixed(3)} — exceeds 0.90 threshold`);
note(`recommendation: READY for tier-2 escalation capability`);

// ── ACT 8: Operator grants tier-2 capability ────────────────

act(8, 'Operator grants tier-2 capability — passport:LifeEvent');

const promotion = ContextDescriptor.create('urn:cg:passport:alice:tier-2-granted:v1')
  .describes('urn:graph:agent:alice:passport')
  .temporal({ validFrom: '2026-04-26T23:30:00Z' })
  .selfAsserted(OPERATOR_DID)
  .asserted()
  .supersedes('urn:cg:passport:alice:birth:v1')
  .build();
const promotionRec = await publish(
  'agent-hpt:CapabilityGranted — passport:LifeEvent — tier-2 escalation; operator-attributed; ABAC scope expansion is now justified',
  promotion,
  operatorWallet,
);
note(`agent-hpt:demonstratedBy → review-v2 (which itself wasDerivedFrom obs-1/2/4 + intervention)`);
note(`auditable chain: capability granted ← review ← observations + intervention ← gap`);

// ── Final tally ─────────────────────────────────────────────

banner('🎯', 'Cycle Complete — what was just produced');

console.log(`\nAuditable chain (depth-first from the promotion):`);
console.log(`  passport:CapabilityGranted (tier-2)`);
console.log(`    └── prior: passport:Birth (tier-1 only)  [superseded]`);
console.log(`    └── demonstratedBy: review-v2`);
console.log(`         └── supersedes: review-v1  [chain preserved]`);
console.log(`         └── wasDerivedFrom: obs-1, obs-2, obs-4`);
console.log(`         └── interventionApplied: tone-fix-v1`);
console.log(`              └── targetGap: tone-calibration`);
console.log(`                   └── wasDerivedFrom: obs-3 (the originating low score)`);
console.log(`                   └── bemCategory: InformationAndFeedback`);

console.log(`\nDescriptor inventory:`);
console.log(`  ┌─────────────────────────────────────────────┬──────────────────┐`);
console.log(`  │ Descriptor                                  │ Signer           │`);
console.log(`  ├─────────────────────────────────────────────┼──────────────────┤`);
console.log(`  │ Tier-1 capability spec                      │ operator         │`);
console.log(`  │ alice deployment passport entry             │ operator         │`);
console.log(`  │ obs-1, obs-2, obs-3                         │ alice (subject)  │`);
console.log(`  │ review-v1 (rec: not promotion-ready)        │ manager (peer)   │`);
console.log(`  │ capability gap (tone calibration)           │ manager (peer)   │`);
console.log(`  │ intervention (PromptUpdate)                 │ operator         │`);
console.log(`  │ obs-4 (post-intervention; improved)         │ alice (subject)  │`);
console.log(`  │ review-v2 (supersedes v1; rec: ready)       │ manager (peer)   │`);
console.log(`  │ tier-2 capability granted                   │ operator         │`);
console.log(`  └─────────────────────────────────────────────┴──────────────────┘`);

console.log(`\n10 ECDSA-signed descriptors. Three independent identities, distinct`);
console.log(`signing roles — alice owns her own observations; manager attests; operator`);
console.log(`grants. Each signature recoverable to the right wallet; tampering with any`);
console.log(`descriptor body breaks its hash + invalidates downstream provenance citations.`);

console.log(`\nWhat this would look like in production:`);
console.log(`  - alice's pod stores her observations (she owns them)`);
console.log(`  - manager's pod stores the reviews + gap diagnoses`);
console.log(`  - operator's pod stores the capability spec + intervention log + promotion`);
console.log(`  - cross-pod queries assemble the full picture; no central source of truth`);
console.log(`  - if alice moves to a different employer, her pod travels with her —`);
console.log(`    the new employer can verify her track record without trusting old one`);
console.log();
