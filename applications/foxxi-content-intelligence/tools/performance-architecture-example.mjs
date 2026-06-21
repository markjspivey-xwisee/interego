/**
 * Foxxi Performance Architecture — end-to-end demonstration.
 *
 *   npx tsx tools/performance-architecture-example.mjs
 *
 * Proves the whole system: a performance SITUATION is contextualized —
 * its work regime is read — and the regime's method (NOT a content
 * assumption) decides the intervention. Content is composed only when
 * it is the answer, across all four directionalities, and (for the
 * Knowable regime) the loop closes back to performance.
 *
 * Idealising an exemplary state and closing a gap to it is the method
 * of one regime only — Knowable. The other regimes never name a gap.
 *
 * Seven scenarios:
 *   A  a Knowable situation, environmental cause — the system refuses a course
 *   B  a Knowable situation, rare task — an in-the-flow job aid beats a course
 *   C  a Knowable situation, real frequent skill gap — emergent course
 *      composition + the same course personalised two ways (H2H)
 *   D  an agent authors a playbook for another agent (A2A)
 *   E  the scaffold from a plan — honestly empty when no content is due
 *   F  the Emergent regime — no gap; instruction is ruled out, probes instead
 *   G  the Knowable evaluation loop + the performance-management portfolio
 *
 * Exits non-zero if any assertion fails.
 */

import {
  diagnose, recommendInterventions, evaluateIntervention, rollUpPortfolio,
} from '../src/performance-architecture.js';
import {
  authorFragment, authorLesson, authorModule, composeCourse,
  personalize, forAudience, authorJobAid, scaffoldFromPlan, courseToCmi5Outline,
} from '../src/emergent-content.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`   ✓ ${label}`); }
  else { fail++; console.log(`   ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};
const h = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

// The contextualizing/authoring agent — a performance consultant.
const consultant = { id: 'did:web:acme#agent-consultant', kind: 'agent', role: 'performance consultant' };

// ════════════════════════════════════════════════════════════════════
h('SCENARIO A — a Knowable situation, environmental cause. No course.');
// ════════════════════════════════════════════════════════════════════
const situationA = {
  id: 'urn:foxxi:situation:escalation',
  performer: { id: 'did:web:acme#rep-jordan', kind: 'human', role: 'support rep' },
  workContext: 'handling customer support tickets',
  competency: 'escalating out-of-scope tickets to specialists',
  observed: 'closes out-of-scope tickets unresolved instead of escalating',
  frequency: 'frequent', criticality: 'high', modalStatus: 'Asserted',
  provenance: 'manager observation + LRS statements', domain: 'Knowable',
};
// Exemplary performance is established only because this contextualized
// into the Knowable regime — there, and only there, a gap is named.
const exemplaryA = 'escalates within SLA whenever a ticket needs a specialist';
const diagA = diagnose({
  situation: situationA,
  exemplary: exemplaryA,
  couldPerformUnderIdealConditions: true, // the discriminating question: they COULD — so not a skill gap
  factorEvidence: {
    incentives: { adequate: false, evidence: 'reps are measured on tickets-closed-per-hour; an escalation counts against that number — the incentive punishes the wanted behaviour.' },
  },
});
const planA = recommendInterventions({ diagnosis: diagA, situation: situationA, author: consultant });
console.log(`\n   regime: ${diagA.domain}, method: ${diagA.method}, skill deficiency = ${diagA.skillDeficiency}`);
console.log(`   root cause: ${diagA.rootCauses.join('; ')}`);
console.log(`   ${planA.summary}`);
for (const o of planA.selected) console.log(`     • selected: ${o.type}`);
const ruledA = planA.paradigm.find(o => o.type === 'instruction');
console.log(`     • instruction ruled out: ${ruledA.ruledOutBecause}`);
check('A: discriminating question → not a skill deficiency', diagA.skillDeficiency === false);
check('A: content is NOT warranted', planA.contentWarranted === false);
check('A: environmental-fix is selected', planA.selected.some(o => o.type === 'environmental-fix'));
check('A: instruction is ruled out', !planA.selected.some(o => o.type === 'instruction'));

// ════════════════════════════════════════════════════════════════════
h('SCENARIO B — a Knowable situation, rare task. A job aid beats a course.');
// ════════════════════════════════════════════════════════════════════
const situationB = {
  id: 'urn:foxxi:situation:annual-filing',
  performer: { id: 'did:web:acme#analyst-pat', kind: 'human', role: 'finance analyst' },
  workContext: 'the annual regulatory compliance filing',
  competency: 'completing the Form X annual filing correctly',
  observed: 'omitted schedule 3 and mis-tagged two line items',
  frequency: 'rare', criticality: 'safety-critical', modalStatus: 'Asserted',
  provenance: 'external audit finding', domain: 'Knowable',
};
const exemplaryB = 'files Form X with every schedule complete and correct';
const diagB = diagnose({
  situation: situationB,
  exemplary: exemplaryB,
  couldPerformUnderIdealConditions: false, // a genuine skill/knowledge gap
  factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'the analyst has never been shown the schedule-3 procedure.' } },
});
const planB = recommendInterventions({ diagnosis: diagB, situation: situationB, author: consultant });
console.log(`\n   diagnosis: skill deficiency = ${diagB.skillDeficiency}, frequency = ${situationB.frequency}`);
console.log(`   ${planB.summary}`);
for (const o of planB.selected) console.log(`     • selected: ${o.type} — ${o.rationale}`);
const ruledB = planB.paradigm.find(o => o.type === 'instruction');
console.log(`     • instruction ruled out: ${ruledB.ruledOutBecause}`);
const supportB = authorJobAid({
  competencyPoint: 'Form X — schedule 3',
  body: 'Schedule 3 checklist: (1) reconcile inter-company balances; (2) tag each line with the 2-digit class code; (3) attach the FX worksheet. Common miss: line items 4a/4b need the class code, not the legacy tag.',
  authoredBy: consultant,
  triggerContext: 'opening the Form X filing workspace',
});
console.log(`\n   authored job aid (A2H, in the flow): ${supportB.fragment.id}`);
console.log(`   delivery: ${supportB.delivery} — surfaced when ${supportB.affordance.surfacedWhen}`);
check('B: a real skill deficiency was found', diagB.skillDeficiency === true);
check('B: performance-support is selected (not instruction)', planB.selected.some(o => o.type === 'performance-support'));
check('B: instruction is ruled out for a rare task', !planB.selected.some(o => o.type === 'instruction'));
check('B: the job aid is affordance-triggered, not scheduled', supportB.delivery === 'affordance-triggered');

// ════════════════════════════════════════════════════════════════════
h('SCENARIO C — a Knowable situation, real frequent skill gap. Emergent');
console.log('             course composition, then personalised two ways (H2H).');
// ════════════════════════════════════════════════════════════════════
const situationC = {
  id: 'urn:foxxi:situation:refund-disputes',
  performer: { id: 'did:web:acme#rep-sam', kind: 'human', role: 'support rep' },
  workContext: 'resolving customer refund disputes',
  competency: 'resolving refund disputes within policy on first contact',
  observed: 'escalates 60% of disputes that policy permits a rep to resolve',
  frequency: 'continuous', criticality: 'moderate', modalStatus: 'Asserted',
  provenance: 'LRS statements + QA review', domain: 'Knowable',
};
const exemplaryC = 'resolves in-policy disputes on first contact without escalating';
// A human SME will author the content, so the plan is recommended with
// the SME as the author — the directionality the content is authored in.
const sme = { id: 'did:web:acme#sme-lee', kind: 'human', role: 'refund-policy SME' };
const diagC = diagnose({
  situation: situationC,
  exemplary: exemplaryC,
  couldPerformUnderIdealConditions: false,
  factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'reps cannot recall the refund-policy decision tree and resolution authority limits.' } },
});
const planC = recommendInterventions({ diagnosis: diagC, situation: situationC, author: sme });
console.log(`\n   ${planC.summary}`);
check('C: instruction is selected', planC.selected.some(o => o.type === 'instruction'));
check('C: content IS warranted', planC.contentWarranted === true);
// A position with a TWO-cell paradigm: the same point told as a concept
// OR as a worked example. personalize() collapses it per disposition.
const conceptThresholds = authorFragment({
  modality: 'concept', competencyPoint: 'refund authority thresholds', level: 'foundational',
  body: 'A rep may authorise refunds up to $500; $500–$2000 needs a lead; over $2000 needs finance.',
  authoredBy: sme,
});
const exampleThresholds = authorFragment({
  modality: 'worked-example', competencyPoint: 'refund authority thresholds', level: 'working',
  body: 'Worked example: a $420 dispute → the rep resolves it directly. A $1,300 dispute → route to a lead. Walk through both tickets end to end.',
  authoredBy: sme, suitsDisposition: 'prefers-worked-examples',
});
const decisionTree = authorFragment({
  modality: 'concept', competencyPoint: 'refund decision tree', level: 'applied',
  body: 'Decision tree: is the item returned? → is it within the window? → is the reason covered? → apply the threshold rule.',
  authoredBy: sme,
});
const exampleTree = authorFragment({
  modality: 'worked-example', competencyPoint: 'refund decision tree', level: 'applied',
  body: 'Worked example: a returned, in-window, covered-reason $90 dispute — walk every branch of the tree on this real ticket and resolve it.',
  authoredBy: sme, suitsDisposition: 'prefers-worked-examples',
});
const lessonThresholds = authorLesson({
  title: 'Refund authority thresholds', competency: situationC.competency, audience: 'human', authoredBy: sme,
  positions: [{ competencyPoint: 'refund authority thresholds', fragments: [conceptThresholds, exampleThresholds] }],
});
const lessonTree = authorLesson({
  title: 'Walking the refund decision tree', competency: situationC.competency, audience: 'human', authoredBy: sme,
  positions: [{ competencyPoint: 'refund decision tree', fragments: [decisionTree, exampleTree] }],
});
const moduleCore = authorModule({
  title: 'Resolving refund disputes', competency: situationC.competency, authoredBy: sme,
  positions: [
    { competencyPoint: 'refund authority thresholds', lessons: [lessonThresholds] },
    { competencyPoint: 'refund decision tree', lessons: [lessonTree] },
  ],
});
const courseC = composeCourse({
  title: 'Refund dispute resolution', competency: situationC.competency, audience: 'human', authoredBy: sme,
  positions: [{ competencyPoint: 'resolving refund disputes', modules: [moduleCore] }],
});
console.log(`\n   composed course: "${courseC.title}" — a syntagm of ${courseC.syntagm.length} module position(s)`);

// Personalise for two performers from the IDENTICAL course.
const resolvedSam = personalize(courseC, situationC.performer, {});
const resolvedRobin = personalize(courseC,
  { id: 'did:web:acme#rep-robin', kind: 'human', role: 'support rep' },
  { masteredCompetencyPoints: ['refund authority thresholds'], dispositionPreference: 'prefers-worked-examples' });
console.log(`\n   Sam (novice)      → ${resolvedSam.lessons.length} lessons, ${resolvedSam.lessons.reduce((n, l) => n + l.fragments.length, 0)} fragments`);
console.log(`   Robin (partial)   → ${resolvedRobin.lessons.length} lessons, ${resolvedRobin.lessons.reduce((n, l) => n + l.fragments.length, 0)} fragments`);
console.log('   Robin\'s composition trace (restriction + override):');
for (const t of resolvedRobin.compositionTrace.filter(x => x.includes('restriction') || x.includes('override'))) {
  console.log(`     · ${t}`);
}
const renderC = forAudience(resolvedSam, sme);
console.log(`\n   directionality: ${renderC.direction} — ${renderC.directionMeaning}`);
const cmi5C = courseToCmi5Outline(courseC);
console.log(`   composes into cmi5: ${cmi5C.blocks.length} block(s), ${cmi5C.blocks.reduce((n, b) => n + b.aus.length, 0)} AU(s) — launchable into any cmi5 LMS`);
check('C: the same course resolves to different sizes per performer',
  resolvedSam.lessons.length !== resolvedRobin.lessons.length);
check('C: restriction dropped Robin\'s mastered position',
  resolvedRobin.compositionTrace.some(t => t.includes('restriction') && t.includes('refund authority thresholds')));
check('C: override picked Robin\'s worked-example paradigm cell',
  resolvedRobin.compositionTrace.some(t => t.includes('override → cell suiting disposition "prefers-worked-examples"')));
check('C: directionality is H2H', renderC.direction === 'H2H');
check('C: emergent course projects onto a cmi5 outline', cmi5C.blocks.length === 1 && cmi5C.blocks[0].aus.length === 2);

// ════════════════════════════════════════════════════════════════════
h('SCENARIO D — an agent authors a playbook for another agent (A2A).');
// ════════════════════════════════════════════════════════════════════
const seniorAgent = { id: 'did:web:acme#agent-atlas', kind: 'agent', role: 'senior incident-response agent' };
const juniorAgent = { id: 'did:web:acme#agent-nova', kind: 'agent', role: 'incident-response agent' };
const doctrineTriage = authorFragment({
  modality: 'context-descriptor', competencyPoint: 'sev-2 incident triage', level: 'applied',
  body: 'Doctrine: on a sev-2, first bound the blast radius, then notify the owning service, then attempt the documented rollback before any novel fix. Never improvise a fix before rollback is ruled out.',
  authoredBy: seniorAgent,
});
const playbookLesson = authorLesson({
  title: 'Sev-2 triage doctrine', competency: 'resolving sev-2 incidents', audience: 'agent', authoredBy: seniorAgent,
  positions: [{ competencyPoint: 'sev-2 incident triage', fragments: [doctrineTriage] }],
});
const playbookModule = authorModule({
  title: 'Incident-response playbook', competency: 'resolving sev-2 incidents', authoredBy: seniorAgent,
  positions: [{ competencyPoint: 'sev-2 incident triage', lessons: [playbookLesson] }],
});
const playbook = composeCourse({
  title: 'Sev-2 incident-response playbook', competency: 'resolving sev-2 incidents',
  audience: 'agent', authoredBy: seniorAgent,
  positions: [{ competencyPoint: 'resolving sev-2 incidents', modules: [playbookModule] }],
});
const resolvedPlaybook = personalize(playbook, juniorAgent, {});
const renderD = forAudience(resolvedPlaybook, seniorAgent);
console.log(`\n   directionality: ${renderD.direction} — ${renderD.directionMeaning}`);
console.log(`   delivery: ${renderD.agentDelivery.contextDescriptors} context descriptor(s) — ${renderD.agentDelivery.ingestionNote}`);
check('D: directionality is A2A', renderD.direction === 'A2A');
check('D: an agent audience gets context descriptors, not slides', !!renderD.agentDelivery && !renderD.humanDelivery);

// ════════════════════════════════════════════════════════════════════
h('SCENARIO E — scaffolding content from a plan (honestly empty when due).');
// ════════════════════════════════════════════════════════════════════
const scaffoldA = scaffoldFromPlan(planA, situationA.competency);
const scaffoldB = scaffoldFromPlan(planB, situationB.competency);
const scaffoldC = scaffoldFromPlan(planC, situationC.competency);
console.log(`\n   plan A (environmental): ${scaffoldA.note}`);
console.log(`   plan B (job aid):      ${scaffoldB.toAuthor.map(t => t.affordance).join(', ')} — direction ${scaffoldB.direction}`);
console.log(`   plan C (instruction):  ${scaffoldC.toAuthor.map(t => t.affordance).join(', ')} — direction ${scaffoldC.direction}`);
check('E: scaffold for the environmental plan is empty', scaffoldA.toAuthor.length === 0);
check('E: scaffold for the instruction plan calls compose_course',
  scaffoldC.toAuthor.some(t => t.affordance === 'foxxi.compose_course'));

// ════════════════════════════════════════════════════════════════════
h('SCENARIO F — the Emergent regime. No gap; instruction ruled out, probe.');
// ════════════════════════════════════════════════════════════════════
// A minimal agent trajectory — assessDisposition reads the steps directly.
const t0 = '2026-05-21T10:00:00.000Z';
const ts = (m) => new Date(Date.parse(t0) + m * 60000).toISOString();
const teamTrajectory = [{
  agentDid: 'did:web:acme#agent-scout', agentName: 'Scout', createdAt: t0,
  steps: [
    { modalStatus: 'Asserted', granularity: 'tool-call', verb: 'search', objectId: 'o1', objectName: 'search integration logs', result: { success: true }, recordedAt: ts(1) },
    { modalStatus: 'Hypothetical', granularity: 'task', verb: 'plan', objectId: 'o2', objectName: 'plan a remediation', recordedAt: ts(2) },
    { modalStatus: 'Counterfactual', granularity: 'subtask', verb: 'consider', objectId: 'o3', objectName: 'alternative: brute-force replay', recordedAt: ts(3) },
    { modalStatus: 'Counterfactual', granularity: 'subtask', verb: 'consider', objectId: 'o4', objectName: 'alternative: escalate to a human', recordedAt: ts(4) },
    { modalStatus: 'Asserted', granularity: 'tool-call', verb: 'call', objectId: 'o5', objectName: 'call the partner API', result: { success: false }, recordedAt: ts(5), id: 'step-5' },
    { modalStatus: 'Asserted', granularity: 'subtask', verb: 'revise', objectId: 'o6', objectName: 'revise the remediation plan', recordedAt: ts(6), supersedesId: 'step-5' },
    { modalStatus: 'Asserted', granularity: 'tool-call', verb: 'call', objectId: 'o7', objectName: 'retry with backoff', result: { success: true }, recordedAt: ts(7) },
    { modalStatus: 'Asserted', granularity: 'tool-call', verb: 'verify', objectId: 'o8', objectName: 'verify the integration', result: { success: true }, recordedAt: ts(8) },
  ],
}];
const situationF = {
  id: 'urn:foxxi:situation:novel-integration-failures',
  performer: { id: 'did:web:acme#agent-scout', kind: 'agent', role: 'integration agent' },
  workContext: 'resolving novel third-party integration failures',
  competency: 'resolving novel integration failures',
  observed: 'resolution is inconsistent across novel failures',
  frequency: 'occasional', criticality: 'high', modalStatus: 'Hypothetical',
  provenance: 'agent trajectory analysis',
};
// No exemplary is supplied — the work is Emergent, so no exemplary state
// exists to idealise and no gap is named.
const diagF = diagnose({ situation: situationF, trajectories: teamTrajectory });
const planF = recommendInterventions({ diagnosis: diagF, situation: situationF, author: consultant });
console.log(`\n   diagnosis: domain = ${diagF.domain}, method = ${diagF.method}`);
console.log(`   disposition: ${diagF.disposition?.vector ?? 'n/a'}`);
console.log(`   caveat: ${diagF.caveat}`);
console.log(`   ${planF.summary}`);
for (const o of planF.selected) console.log(`     • selected: ${o.type}`);
check('F: the Emergent regime was detected from the trajectory', diagF.domain === 'Emergent');
check('F: the method is a dispositional read, not gap analysis', diagF.method === 'dispositional-read');
check('F: instruction is NOT selected in the Emergent regime', !planF.selected.some(o => o.type === 'instruction'));
check('F: a probe is selected instead', planF.selected.some(o => o.type === 'probe'));
check('F: content is not warranted', planF.contentWarranted === false);

// ════════════════════════════════════════════════════════════════════
h('SCENARIO G — the Knowable evaluation loop + the portfolio read.');
// ════════════════════════════════════════════════════════════════════
const evalC = evaluateIntervention({
  plan: planC, situation: situationC,
  response: { favourable: true, note: 'reps rated the course relevant to live disputes' },
  capability: { assessed: true, passed: true, note: 'all reps passed the decision-tree assessment' },
  transfer: { transferred: true, evidence: 'LRS shows first-contact resolution on 14 of the next 16 in-policy disputes' },
  newObserved: exemplaryC,
});
console.log(`\n   intervention evaluation (four-level evaluation → iep:supersedes):`);
console.log(`     capability : ${evalC.levels.capability.passed ? 'passed' : 'failed'}`);
console.log(`     transfer   : ${evalC.levels.transfer.transferred ? 'transferred to real work' : 'did not transfer'}`);
console.log(`     outcome    : gap ${evalC.levels.outcome.gapClosed ? 'CLOSED' : 'open'}`);
console.log(`     verdict      : ${evalC.verdict} — supersedes observed-state "${evalC.supersedes}"`);
console.log(`     next action  : ${evalC.nextAction}`);
check('G: the evaluation verdict is "closed"', evalC.verdict === 'closed');
check('G: the evaluation supersedes the old observed-state', evalC.supersedes === situationC.observed);

const portfolio = rollUpPortfolio([
  { situation: situationA, plan: planA },
  { situation: situationB, plan: planB },
  { situation: situationC, plan: planC, evaluation: evalC },
  { situation: situationF, plan: planF },
]);
console.log(`\n   performance portfolio (the management read):`);
console.log(`     intervention mix : ${JSON.stringify(portfolio.interventionMix)}`);
console.log(`     content vs not   : ${portfolio.contentVsNonContent.content} content, ${portfolio.contentVsNonContent.nonContent} non-content`);
console.log(`     ${portfolio.readout}`);
check('G: the portfolio routed situations to BOTH content and non-content',
  portfolio.contentVsNonContent.content > 0 && portfolio.contentVsNonContent.nonContent > 0);

// ════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log('═'.repeat(72));
if (fail > 0) process.exit(1);
console.log('\nThe system is performance-driven: each situation was contextualized,');
console.log('its regime decided the method, content was composed only when it was');
console.log('the answer, and (in the Knowable regime) the loop closed back to');
console.log('performance. Authoring used the same tools for humans and agents.');
