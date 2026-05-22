/**
 * Foxxi Performance Calibration — the reflexive loop, demonstrated.
 *
 *   npx tsx tools/performance-calibration-example.mjs
 *
 * The Performance Architecture contextualizes a situation and routes it
 * to a method. This proves the loop the system closes on its OWN
 * judgment: every intervention outcome is recorded, rolled into a
 * calibration profile, and used to annotate the next plan with its
 * track record — and that evidence federates across organizations.
 *
 * Exits non-zero if any assertion fails.
 */

import { diagnose, recommendInterventions, evaluateIntervention } from '../src/performance-architecture.js';
import {
  buildCalibrationProfile, expandOutcomeCorpus, calibrate, recordOutcome,
  composeCalibrationProfiles, federationView, calibrationReadout,
} from '../src/performance-calibration.js';
import { SAMPLE_OUTCOMES, SAMPLE_PEER_OUTCOMES } from '../src/sample-outcomes.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`   ✓ ${label}`); }
  else { fail++; console.log(`   ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};
const h = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);
const pct = (x) => `${Math.round(x * 100)}%`;

// ════════════════════════════════════════════════════════════════════
h('1. BUILD — roll a corpus of recorded outcomes into a calibration profile');
// ════════════════════════════════════════════════════════════════════
const tenant = buildCalibrationProfile(expandOutcomeCorpus(SAMPLE_OUTCOMES));
console.log(`\n   ${tenant.totalSamples} outcomes → ${tenant.cells.length} calibration cells`);
const instr = tenant.cells.find(c => c.causeFactor === 'knowledgeSkill' && c.intervention === 'instruction');
const jobAid = tenant.cells.find(c => c.causeFactor === 'knowledgeSkill' && c.intervention === 'performance-support');
console.log(`   instruction for a knowledge/skill cause: closes ${pct(instr.closureRate)} of ${instr.samples}`);
console.log(`   job aid for the SAME cause:               closes ${pct(jobAid.closureRate)} of ${jobAid.samples}`);
check('the profile is built from the corpus', tenant.totalSamples === 437, tenant.totalSamples);
check('instruction-for-knowledge/skill has enough samples to Assert', instr.modalStatus === 'Asserted');
check('the recorded evidence: instruction closes the gap less than half the time',
  instr.closureRate < 0.5, instr.closureRate);
check('the system knows its most informative miss — re-diagnosed as incentives',
  instr.commonReDiagnosis?.cause === 'incentives', instr.commonReDiagnosis);
check('the same cause routed to a job aid closes far more reliably',
  jobAid.closureRate > instr.closureRate + 0.25, { instr: instr.closureRate, jobAid: jobAid.closureRate });

// ════════════════════════════════════════════════════════════════════
h('2. MODAL STATUS — a thin cell does not get to Assert a rate');
// ════════════════════════════════════════════════════════════════════
const practice = tenant.cells.find(c => c.intervention === 'practice');
console.log(`\n   practice cell: ${practice.samples} samples → ${practice.modalStatus}`);
check('a cell below the assert threshold stays Hypothetical', practice.modalStatus === 'Hypothetical');

// ════════════════════════════════════════════════════════════════════
h('3. CALIBRATE — a fresh plan carries its own track record');
// ════════════════════════════════════════════════════════════════════
const situation = {
  id: 'urn:foxxi:situation:calibration-demo',
  performer: { id: 'did:web:acme#rep', kind: 'human', role: 'support rep' },
  workContext: 'resolving customer refund disputes',
  competency: 'resolving refund disputes within policy',
  observed: 'over-escalates disputes a rep may resolve',
  frequency: 'continuous', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
};
const dg = diagnose({
  situation, exemplary: 'resolves in-policy disputes on first contact',
  couldPerformUnderIdealConditions: false,
  factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'cannot recall the decision tree' } },
});
const pl = recommendInterventions({ diagnosis: dg, situation });
const note = calibrate(dg, pl, tenant);
console.log(`\n   fresh plan: ${pl.selected.map(o => o.type).join(', ')}`);
console.log(`   calibration verdict: ${note.verdict}`);
console.log(`   ${note.message}`);
check('the fresh instruction plan is flagged poorly-supported by the evidence',
  note.verdict === 'poorly-supported', note.verdict);
check('the calibration note states the real closure rate', /4[0-9]%/.test(note.message), note.message);
check('the calibration note names the common re-diagnosis', /incentives/i.test(note.message));

// An Emergent plan — calibration declines to grade what names no cause.
const emSituation = { ...situation, id: 'urn:foxxi:situation:em', performer: { id: 'a', kind: 'agent' }, domain: 'Emergent' };
const emNote = calibrate(diagnose({ situation: emSituation }), recommendInterventions({ diagnosis: diagnose({ situation: emSituation }), situation: emSituation }), tenant);
check('calibration declines to grade a regime that names no cause', emNote.verdict === 'untested', emNote.verdict);

// ════════════════════════════════════════════════════════════════════
h('4. RECORD — distil a completed evaluation back into evidence');
// ════════════════════════════════════════════════════════════════════
const evaluation = evaluateIntervention({
  plan: pl, situation,
  capability: { assessed: true, passed: true, note: 'passed the assessment' },
  transfer: { transferred: false, evidence: 'no change in the LRS work signal' },
  newObserved: situation.observed,
});
const rec = recordOutcome(dg, pl, evaluation, { reDiagnosedCause: 'incentives' });
console.log(`\n   evaluation verdict: ${evaluation.verdict} → recorded outcome: ${rec.intervention}/${rec.causeFactor}/${rec.verdict}`);
check('a completed evaluation distils into an outcome record', rec !== null && rec.verdict === 'no-change', rec);
check('the outcome record carries the cause and intervention', rec.causeFactor === 'knowledgeSkill' && rec.intervention === 'instruction');

// ════════════════════════════════════════════════════════════════════
h('5. FEDERATE — one organization\'s evidence calibrates another\'s');
// ════════════════════════════════════════════════════════════════════
const peer = buildCalibrationProfile(expandOutcomeCorpus(SAMPLE_PEER_OUTCOMES));
const federated = composeCalibrationProfiles([tenant, peer]);
const practiceFed = federated.cells.find(c => c.intervention === 'practice');
console.log(`\n   tenant alone: ${tenant.totalSamples} outcomes, ${tenant.sources} source`);
console.log(`   federated:    ${federated.totalSamples} outcomes, ${federated.sources} sources`);
console.log(`   the thin practice cell: ${practice.samples} (tenant) + ${practiceFed.samples - practice.samples} (peer) = ${practiceFed.samples} → ${practiceFed.modalStatus}`);
check('the federated profile pools both sources', federated.sources === 2);
check('the federated profile holds more evidence than either alone',
  federated.totalSamples > tenant.totalSamples, federated.totalSamples);
check('a cell Hypothetical for one org alone becomes Asserted once federated',
  practiceFed.modalStatus === 'Asserted', practiceFed.samples);

// ════════════════════════════════════════════════════════════════════
h('6. PRIVACY — only aggregate cells above the k-threshold may federate');
// ════════════════════════════════════════════════════════════════════
const shareable = federationView(tenant);
console.log(`\n   tenant has ${tenant.cells.length} cells; ${shareable.cells.length} are above the k-anonymity threshold`);
check('federationView withholds every cell below the k threshold',
  shareable.cells.every(c => c.samples >= tenant.federationKThreshold));
check('the thin practice cell is withheld from federation', !shareable.cells.some(c => c.intervention === 'practice'));

// ════════════════════════════════════════════════════════════════════
h('7. READOUT — the management read of the system\'s own accuracy');
// ════════════════════════════════════════════════════════════════════
const ro = calibrationReadout(tenant);
console.log(`\n   ${ro.readout}`);
check('the readout names instruction as the weakest recommendation',
  ro.weakest?.intervention === 'instruction', ro.weakest);

// ════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log('═'.repeat(72));
if (fail > 0) process.exit(1);
console.log('\nThe loop is closed on the system\'s own judgment: every outcome is');
console.log('recorded, the profile says how often each recommendation actually');
console.log('works, a fresh plan carries that track record, and the evidence');
console.log('federates — one organization\'s lesson calibrates the next.');
