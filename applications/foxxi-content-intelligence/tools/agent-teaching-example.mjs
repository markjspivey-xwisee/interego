/**
 * Foxxi A2A teaching — the performance lens over ac:TeachingPackage.
 *
 *   npx tsx tools/agent-teaching-example.mjs
 *
 * Foxxi does NOT invent agent-to-agent teaching. agent-collective (ac:)
 * already establishes it: agents author tools and bundle them with
 * adp: practice into an ac:TeachingPackage, whose trust accrues through
 * amta:Attestation. This proves what Foxxi *adds* — the performance /
 * L&D dimension: given a reference to an ac:TeachingPackage, Foxxi
 * frames a learner agent's acquisition as an A2A instruction
 * intervention, verifies the transfer by READING THE LEARNER'S OWN
 * TRAJECTORIES, emits an amta:Attestation into ac:'s modal discipline,
 * and feeds the reflexive calibration loop.
 *
 * Exits non-zero if any assertion fails.
 */

import {
  frameTeachingIntervention, verifyCapabilityTransfer,
  transferAttestation, teachingToOutcome,
} from '../src/agent-teaching.js';
import { buildCalibrationProfile, calibrationReadout } from '../src/performance-calibration.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`   ✓ ${label}`); }
  else { fail++; console.log(`   ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};
const h = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

const teacher = { id: 'did:web:acme#agent-atlas', kind: 'agent' };
const learner = { id: 'did:web:acme#agent-nova', kind: 'agent' };

// A reference to an ac:TeachingPackage — authored by agent-collective's
// ac:bundleTeachingPackage (an ac:AgentTool artifact + adp: practice).
// Foxxi references it; it never redefines or re-authors it.
const pkg = {
  iri: 'urn:iep:teaching:sev2-triage-doctrine',
  artifactIri: 'urn:iep:tool:documented-rollback',
  competency: 'triaging sev-2 incidents to doctrine',
  olkeStage: 'Articulate',
  modalStatus: 'Hypothetical',
};
const targetBehaviour = {
  description: 'bounds the blast radius and runs the documented rollback before any novel fix',
  signalMarkers: ['rollback', 'blast radius', 'bound'],
  antiSignalMarkers: ['improvise', 'novel fix'],
};

const t0 = Date.parse('2026-05-22T09:00:00.000Z');
const traj = (steps) => ({
  agentDid: learner.id, agentName: 'Nova', createdAt: new Date(t0).toISOString(),
  steps: steps.map((s, i) => ({
    modalStatus: 'Asserted', granularity: 'tool-call', verb: s.verb,
    objectId: `o${i}`, objectName: s.obj, result: { success: true },
    recordedAt: new Date(t0 + i * 60000).toISOString(),
  })),
});

// ════════════════════════════════════════════════════════════════════
h('1. FRAME — read an ac:TeachingPackage acquisition in performance terms');
// ════════════════════════════════════════════════════════════════════
const intervention = frameTeachingIntervention(pkg, teacher, learner);
console.log(`\n   teaching package : ${intervention.teachingPackageIri}`);
console.log(`   performance frame: ${intervention.regime} regime · ${intervention.method} · `
  + `${intervention.intervention} · ${intervention.direction}`);
check('Foxxi frames acquiring a documented capability as a Knowable instruction intervention',
  intervention.regime === 'Knowable' && intervention.intervention === 'instruction');
check('the directionality is A2A', intervention.direction === 'A2A');
check('Foxxi references the ac:TeachingPackage — it does not re-author it',
  intervention.teachingPackageIri === pkg.iri);

// ════════════════════════════════════════════════════════════════════
h('2. VERIFY — read the learner\'s real work, before vs after');
// ════════════════════════════════════════════════════════════════════
const before = [traj([
  { verb: 'investigate', obj: 'the failing service' },
  { verb: 'improvise', obj: 'a novel fix attempt' },
  { verb: 'patch', obj: 'a novel fix attempt' },
  { verb: 'verify', obj: 'the patch held' },
  { verb: 'improvise', obj: 'another novel fix' },
  { verb: 'escalate', obj: 'the incident' },
])];
const after = [traj([
  { verb: 'bound', obj: 'the blast radius' },
  { verb: 'notify', obj: 'the owning service' },
  { verb: 'run', obj: 'the documented rollback' },
  { verb: 'verify', obj: 'the rollback recovered the service' },
  { verb: 'bound', obj: 'the blast radius of a second alert' },
  { verb: 'run', obj: 'the documented rollback again' },
  { verb: 'record', obj: 'the incident timeline' },
  { verb: 'verify', obj: 'recovery' },
])];
const verdict = verifyCapabilityTransfer({ package: pkg, targetBehaviour, learner, before, after });
console.log(`\n   before: taught behaviour in ${Math.round(verdict.before.signalShare * 100)}% of steps`);
console.log(`   after:  taught behaviour in ${Math.round(verdict.after.signalShare * 100)}% of steps`);
console.log(`   ${verdict.evidence}`);
check('the transfer is verified from the learner\'s own trajectories', verdict.transferred === true, verdict);
check('the transfer claim is Asserted — the learner\'s work carries the evidence',
  verdict.modalStatus === 'Asserted');

// ════════════════════════════════════════════════════════════════════
h('3. ATTEST — emit an amta:Attestation into ac:\'s modal discipline');
// ════════════════════════════════════════════════════════════════════
const attestation = transferAttestation(verdict);
console.log(`\n   amta:Attestation → attestsTo ${attestation.attestsTo}`);
console.log(`   axis ${attestation.axis} · rating ${attestation.rating.toFixed(2)} · contributed ${attestation.contributed}`);
check('a verified transfer emits an amta:Attestation on the teaching package',
  attestation.attestsTo === pkg.iri && attestation.axis === 'correctness');
check('Foxxi contributes the attestation rather than running its own modal flip',
  attestation.contributed === true);

// ════════════════════════════════════════════════════════════════════
h('4. NEGATIVE — a learner whose work did not change');
// ════════════════════════════════════════════════════════════════════
const missVerdict = verifyCapabilityTransfer({ package: pkg, targetBehaviour, learner, before, after: before });
console.log(`\n   ${missVerdict.evidence}`);
check('a package acquired but not exercised is NOT a verified transfer',
  missVerdict.transferred === false);
check('no contributed attestation when the work did not change',
  transferAttestation(missVerdict).contributed === false);

// ════════════════════════════════════════════════════════════════════
h('5. THIN EVIDENCE — too little post-acquisition work to assert');
// ════════════════════════════════════════════════════════════════════
const thinVerdict = verifyCapabilityTransfer({
  package: pkg, targetBehaviour, learner, before, after: [traj([{ verb: 'bound', obj: 'the blast radius' }])],
});
check('a transfer claim with too little evidence stays Hypothetical',
  thinVerdict.modalStatus === 'Hypothetical', thinVerdict.modalStatus);
check('a Hypothetical transfer is not yet fed to calibration', teachingToOutcome(thinVerdict) === null);

// ════════════════════════════════════════════════════════════════════
h('6. CALIBRATE — agent teaching feeds the reflexive loop');
// ════════════════════════════════════════════════════════════════════
const outcome = teachingToOutcome(verdict, 'acme');
const missOutcome = teachingToOutcome(missVerdict, 'acme');
console.log(`\n   verified transfer → outcome: ${outcome.intervention}/${outcome.causeFactor}/${outcome.verdict}`);
check('a verified A2A transfer distils into a calibration outcome record',
  outcome !== null && outcome.verdict === 'closed' && outcome.intervention === 'instruction');
check('A2A teaching is instruction for a Knowable knowledge/skill cause',
  outcome.regime === 'Knowable' && outcome.causeFactor === 'knowledgeSkill');
const profile = buildCalibrationProfile([outcome, missOutcome], { assertThreshold: 2 });
console.log(`   ${calibrationReadout(profile).readout}`);
check('agent-teaching outcomes calibrate alongside human course completions',
  profile.cells.some(c => c.intervention === 'instruction' && c.causeFactor === 'knowledgeSkill'));

// ════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log('═'.repeat(72));
if (fail > 0) process.exit(1);
console.log('\nFoxxi composes the agent-collective teaching foundation, not a parallel');
console.log('one: the unit is an ac:TeachingPackage; Foxxi adds the performance lens —');
console.log('frames it as an intervention, verifies transfer from the learner\'s');
console.log('trajectories, emits an amta:Attestation, and feeds the reflexive loop.');
