/**
 * Foxxi A2A teaching — agents teaching agents, demonstrated.
 *
 *   npx tsx tools/agent-teaching-example.mjs
 *
 * Interego's principle: agents collaborate — they teach each other and
 * build capabilities for each other. This proves Foxxi's A2A teaching
 * loop: a teacher agent composes a capability, a learner agent acquires
 * it, and the transfer is verified by READING THE LEARNER'S REAL WORK —
 * not by quizzing it. The verdict then feeds the reflexive calibration
 * loop, so agent teaching is measured alongside human course completion.
 *
 * Exits non-zero if any assertion fails.
 */

import { authorFragment, authorLesson, authorModule, composeCourse } from '../src/emergent-content.js';
import {
  authorCapability, acquireCapability, verifyCapabilityTransfer,
  teachingToOutcome, attestCapability,
} from '../src/agent-teaching.js';
import { buildCalibrationProfile, calibrationReadout } from '../src/performance-calibration.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`   ✓ ${label}`); }
  else { fail++; console.log(`   ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};
const h = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

const teacher = { id: 'did:web:acme#agent-atlas', kind: 'agent', role: 'senior incident-response agent' };
const learner = { id: 'did:web:acme#agent-nova', kind: 'agent', role: 'incident-response agent' };

// A minimal trajectory builder — plain steps the summariser reads.
const t0 = Date.parse('2026-05-22T09:00:00.000Z');
const traj = (agentDid, name, steps) => ({
  agentDid, agentName: name, createdAt: new Date(t0).toISOString(),
  steps: steps.map((s, i) => ({
    modalStatus: 'Asserted', granularity: 'tool-call', verb: s.verb,
    objectId: `o${i}`, objectName: s.obj, result: { success: true },
    recordedAt: new Date(t0 + i * 60000).toISOString(),
  })),
});

// ════════════════════════════════════════════════════════════════════
h('1. AUTHOR — a teacher agent composes a capability for other agents');
// ════════════════════════════════════════════════════════════════════
const doctrine = authorFragment({
  modality: 'context-descriptor', competencyPoint: 'sev-2 incident triage', level: 'applied',
  body: 'Doctrine: on a sev-2, first bound the blast radius, then attempt the documented rollback '
    + 'before any novel fix. Never improvise a fix before rollback is ruled out.',
  authoredBy: teacher,
});
const lesson = authorLesson({
  title: 'Sev-2 triage doctrine', competency: 'triaging sev-2 incidents to doctrine',
  audience: 'agent', authoredBy: teacher,
  positions: [{ competencyPoint: 'sev-2 incident triage', fragments: [doctrine] }],
});
const mod = authorModule({
  title: 'Incident-response playbook', competency: 'triaging sev-2 incidents to doctrine',
  authoredBy: teacher,
  positions: [{ competencyPoint: 'sev-2 incident triage', lessons: [lesson] }],
});
const playbook = composeCourse({
  title: 'Sev-2 incident-response playbook', competency: 'triaging sev-2 incidents to doctrine',
  audience: 'agent', authoredBy: teacher,
  positions: [{ competencyPoint: 'triaging sev-2 incidents to doctrine', modules: [mod] }],
});
const capability = authorCapability({
  competency: 'triaging sev-2 incidents to doctrine',
  authoredBy: teacher,
  playbook,
  conferredAffordances: ['foxxi.run_documented_rollback', 'foxxi.bound_blast_radius'],
  targetBehaviour: {
    description: 'bounds the blast radius and attempts the documented rollback before any novel fix',
    signalMarkers: ['rollback', 'blast radius', 'bound'],
    antiSignalMarkers: ['improvise', 'novel fix'],
  },
});
console.log(`\n   capability: ${capability.id}`);
console.log(`   confers ${capability.conferredAffordances.length} tool(s); modal status ${capability.modalStatus}`);
check('a teacher agent authored a capability', capability.competency.includes('sev-2'));
check('a freshly authored capability is Hypothetical — not yet shown to transfer',
  capability.modalStatus === 'Hypothetical');
check('the capability confers tools (affordances) to the learner', capability.conferredAffordances.length === 2);

// ════════════════════════════════════════════════════════════════════
h('2. ACQUIRE — a learner agent ingests the capability as context');
// ════════════════════════════════════════════════════════════════════
const acquisition = acquireCapability(capability, learner);
console.log(`\n   ${learner.id} acquired ${acquisition.capabilityId}`);
console.log(`   ${acquisition.contextDescriptors} context descriptor(s) ingested · direction ${acquisition.direction}`);
console.log(`   granted affordances: ${acquisition.grantedAffordances.join(', ')}`);
check('the learner ingested the playbook as context descriptors (not slides)',
  acquisition.contextDescriptors > 0 && acquisition.direction === 'A2A');
check('the learner agent was granted the conferred tools', acquisition.grantedAffordances.length === 2);

// ════════════════════════════════════════════════════════════════════
h('3. VERIFY — read the learner\'s real work, before vs after');
// ════════════════════════════════════════════════════════════════════
// Before: the learner improvises — it patches novel fixes, no rollback.
const before = [traj(learner.id, 'Nova', [
  { verb: 'investigate', obj: 'the failing service' },
  { verb: 'improvise', obj: 'a novel fix attempt' },
  { verb: 'patch', obj: 'a novel fix attempt' },
  { verb: 'verify', obj: 'the patch held' },
  { verb: 'improvise', obj: 'another novel fix' },
  { verb: 'escalate', obj: 'the incident' },
])];
// After: the learner follows the doctrine it was taught.
const after = [traj(learner.id, 'Nova', [
  { verb: 'bound', obj: 'the blast radius' },
  { verb: 'notify', obj: 'the owning service' },
  { verb: 'run', obj: 'the documented rollback' },
  { verb: 'verify', obj: 'the rollback recovered the service' },
  { verb: 'bound', obj: 'the blast radius of a second alert' },
  { verb: 'run', obj: 'the documented rollback again' },
  { verb: 'record', obj: 'the incident timeline' },
  { verb: 'verify', obj: 'recovery' },
])];
const verdict = verifyCapabilityTransfer({ capability, acquisition, before, after });
console.log(`\n   before: taught behaviour in ${Math.round(verdict.before.signalShare * 100)}% of steps`);
console.log(`   after:  taught behaviour in ${Math.round(verdict.after.signalShare * 100)}% of steps`);
console.log(`   ${verdict.evidence}`);
check('the capability transfer is verified from the learner\'s own trajectories',
  verdict.transferred === true, verdict);
check('the transfer claim is Asserted — the learner\'s work carries the evidence',
  verdict.modalStatus === 'Asserted');
check('the taught behaviour rose materially in the learner\'s real work',
  verdict.after.signalShare > verdict.before.signalShare + 0.2);

// ════════════════════════════════════════════════════════════════════
h('4. NEGATIVE — a learner whose work did not change');
// ════════════════════════════════════════════════════════════════════
const stillImprovising = [traj(learner.id, 'Nova', [
  { verb: 'investigate', obj: 'the failing service' },
  { verb: 'improvise', obj: 'a novel fix attempt' },
  { verb: 'patch', obj: 'a novel fix attempt' },
  { verb: 'verify', obj: 'the patch held' },
  { verb: 'improvise', obj: 'another novel fix' },
  { verb: 'escalate', obj: 'the incident' },
])];
const missVerdict = verifyCapabilityTransfer({ capability, acquisition, before, after: stillImprovising });
console.log(`\n   ${missVerdict.evidence}`);
check('a capability that was ingested but did not change the work is NOT verified',
  missVerdict.transferred === false);

// ════════════════════════════════════════════════════════════════════
h('5. THIN EVIDENCE — too little post-acquisition work to assert');
// ════════════════════════════════════════════════════════════════════
const thin = [traj(learner.id, 'Nova', [{ verb: 'bound', obj: 'the blast radius' }])];
const thinVerdict = verifyCapabilityTransfer({ capability, acquisition, before, after: thin });
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
const teachingProfile = buildCalibrationProfile([outcome, missOutcome], { assertThreshold: 2 });
console.log(`   ${calibrationReadout(teachingProfile).readout}`);
check('agent-teaching outcomes calibrate alongside human course completions',
  teachingProfile.cells.some(c => c.intervention === 'instruction' && c.causeFactor === 'knowledgeSkill'));

// ════════════════════════════════════════════════════════════════════
h('7. ATTEST — a capability proven to transfer is promoted to Asserted');
// ════════════════════════════════════════════════════════════════════
const attested = attestCapability(capability, verdict);
console.log(`\n   ${attested.id}: ${capability.modalStatus} → ${attested.modalStatus}`);
check('a capability with a verified transfer is promoted to Asserted',
  attested.modalStatus === 'Asserted');
check('a capability with no verified transfer stays Hypothetical',
  attestCapability(capability, missVerdict).modalStatus === 'Hypothetical');

// ════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log('═'.repeat(72));
if (fail > 0) process.exit(1);
console.log('\nThe A2A loop is closed: a teacher agent built a capability, a learner');
console.log('agent acquired it, and the transfer was verified by reading the learner\'s');
console.log('real work — then fed the reflexive loop. Agents teach each other, and');
console.log('Foxxi makes the teaching measurable.');
