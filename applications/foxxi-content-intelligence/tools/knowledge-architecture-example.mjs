/**
 * Foxxi Knowledge Architecture — end-to-end demonstration.
 *
 *   npx tsx tools/knowledge-architecture-example.mjs
 *
 * Proves the knowledge-management layer: of the knowledge a competent
 * performer draws on, only part can honestly become content; the work
 * regime decides the strategy; and the system is honest about the
 * residue a course cannot carry.
 *
 * Six scenarios:
 *   A  a mostly-codifiable competency — content can carry it
 *   B  a mostly-uncodifiable competency — a course would teach the wrong thing
 *   C  the same competency, Knowable regime vs Emergent regime
 *   D  knowledge assets — stock (codify) and flow (connect, narrate)
 *   E  knowledge-aware scaffolding — instruction warranted, but honest
 *      about how much of it a course can actually deliver
 *   F  the three knowledge principles, applied
 *
 * Exits non-zero if any assertion fails.
 */

import {
  decomposeCompetence, knowledgeStrategy, mapKnowledge,
  codifyKnowledge, connectKnowledge, narrateKnowledge,
  knowledgeAwareScaffold, KNOWLEDGE_PRINCIPLES,
} from '../src/knowledge-architecture.js';
import { diagnose, recommendInterventions } from '../src/performance-architecture.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`   ✓ ${label}`); }
  else { fail++; console.log(`   ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};
const h = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

// ════════════════════════════════════════════════════════════════════
h('SCENARIO A — a mostly-codifiable competency. Content can carry it.');
// ════════════════════════════════════════════════════════════════════
const decompA = decomposeCompetence({
  competency: 'completing the Form X annual filing',
  components: [
    { component: 'recorded', description: 'the Form X procedure document and the filing tool' },
    { component: 'recorded', description: 'the schedule-3 reference checklist' },
    { component: 'trained', description: 'reconciling inter-company balances' },
  ],
});
console.log(`\n   codifiable share: ${Math.round(decompA.codifiableShare * 100)}%`);
console.log(`   ${decompA.recommendation}`);
check('A: a recorded/trained competency is highly codifiable', decompA.codifiableShare >= 0.8);
check('A: no large uncodified residue', decompA.uncodifiedResidue.length <= 1);

// ════════════════════════════════════════════════════════════════════
h('SCENARIO B — a mostly-uncodifiable competency. A course teaches wrong.');
// ════════════════════════════════════════════════════════════════════
const decompB = decomposeCompetence({
  competency: 'de-escalating a volatile customer call',
  components: [
    { component: 'recorded', description: 'the refund-authority policy' },
    { component: 'judged', description: 'reading when to offer vs. when to listen' },
    { component: 'lived', description: 'pattern-recognition of which calls turn around and which do not' },
    { component: 'innate', description: 'natural calm under hostility' },
  ],
});
console.log(`\n   codifiable share: ${Math.round(decompB.codifiableShare * 100)}%`);
console.log(`   ${decompB.recommendation}`);
console.log(`   uncodified residue (${decompB.uncodifiedResidue.length}):`);
for (const r of decompB.uncodifiedResidue) console.log(`     · ${r.slice(0, 96)}`);
check('B: a judgement/experience competency is mostly uncodifiable', decompB.codifiableShare < 0.5);
check('B: the lived + innate components are flagged as residue',
  decompB.uncodifiedResidue.some(r => r.startsWith('lived')) && decompB.uncodifiedResidue.some(r => r.startsWith('innate')));

// ════════════════════════════════════════════════════════════════════
h('SCENARIO C — the SAME competency: Knowable regime vs Emergent regime.');
// ════════════════════════════════════════════════════════════════════
const components = [
  { component: 'recorded', description: 'the incident runbook' },
  { component: 'trained', description: 'running the documented rollback' },
  { component: 'judged', description: 'deciding when the runbook does not apply' },
];
const kmKnowable = mapKnowledge({ competency: 'resolving a sev-2 incident', regime: 'Knowable', components });
const kmEmergent = mapKnowledge({ competency: 'resolving a sev-2 incident', regime: 'Emergent', components });
console.log(`\n   Knowable regime → strategy: ${kmKnowable.strategy.strategy} (${kmKnowable.strategy.primaryMode})`);
console.log(`     to codify:  ${kmKnowable.toCodify.length} component(s)`);
console.log(`   Emergent regime → strategy: ${kmEmergent.strategy.strategy} (${kmEmergent.strategy.primaryMode})`);
console.log(`     to codify:  ${kmEmergent.toCodify.length} component(s)  ·  ${kmEmergent.note}`);
check('C: the Knowable regime codifies (knowledge as stock)',
  kmKnowable.strategy.primaryMode === 'stock' && kmKnowable.toCodify.length > 0);
check('C: the Emergent regime codifies nothing toward an ideal (knowledge as flow)',
  kmEmergent.strategy.primaryMode === 'flow' && kmEmergent.toCodify.length === 0);

// ════════════════════════════════════════════════════════════════════
h('SCENARIO D — knowledge assets: stock (codify) and flow (connect, narrate).');
// ════════════════════════════════════════════════════════════════════
const expert = { id: 'did:web:acme#analyst-pat', kind: 'human', role: 'finance analyst' };
const codified = codifyKnowledge({
  competency: 'Form X — schedule 3',
  body: 'Schedule 3: reconcile inter-company balances, tag each line with the 2-digit class code, attach the FX worksheet.',
  volunteeredBy: expert.id,
  uncodifiedResidue: 'which prior-year adjustments tend to recur — Pat recognises these on sight; the document cannot list them all.',
});
const connected = connectKnowledge({ competency: 'reading a volatile call', holder: expert });
const narrated = narrateKnowledge({
  competency: 'a sev-2 that the runbook did not fit',
  story: 'Last quarter the rollback made it worse; the agent paused, traced the dependency, and found the real cause was upstream.',
  volunteeredBy: 'did:web:acme#agent-atlas',
});
console.log(`\n   codified artefact : ${codified.kind} · codification level "${codified.codificationLevel}"`);
console.log(`     uncodified residue recorded: ${!!codified.uncodifiedResidue}`);
console.log(`   connection        : ${connected.kind} · ${connected.payload}`);
console.log(`   narrative         : ${narrated.kind} · codification level "${narrated.codificationLevel}"`);
check('D: a codified artefact must record its uncodified residue', !!codified.uncodifiedResidue);
check('D: every asset records who volunteered it',
  !!codified.volunteeredBy && !!connected.volunteeredBy && !!narrated.volunteeredBy);
check('D: a connection keeps the knowledge with its holder (flow, not stock)',
  connected.kind === 'connection' && connected.codificationLevel === 'uncodified');

// ════════════════════════════════════════════════════════════════════
h('SCENARIO E — knowledge-aware scaffolding: honest about a course\'s limits.');
// ════════════════════════════════════════════════════════════════════
const gapE = {
  id: 'urn:foxxi:gap:deescalation',
  performer: { id: 'did:web:acme#rep-sam', kind: 'human', role: 'support rep' },
  workContext: 'handling volatile customer calls',
  competency: 'de-escalating a volatile customer call',
  desired: 'de-escalates and resolves without a supervisor',
  observed: 'transfers most volatile calls to a supervisor',
  frequency: 'frequent', criticality: 'high', modalStatus: 'Asserted', domain: 'Knowable',
};
const diagE = diagnose({
  gap: gapE,
  couldPerformUnderIdealConditions: false,
  factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'the rep has not been taught de-escalation' } },
});
const planE = recommendInterventions({ diagnosis: diagE, gap: gapE });
const kmE = mapKnowledge({ competency: gapE.competency, regime: 'Knowable', components: decompB.components });
const scaffoldE = knowledgeAwareScaffold(planE, kmE);
console.log(`\n   diagnosis warranted instruction: ${scaffoldE.instructionWarranted}`);
console.log(`   codifiable share of the competency: ${Math.round(kmE.decomposition.codifiableShare * 100)}%`);
console.log(`   codification warning raised: ${scaffoldE.codificationWarning}`);
console.log(`   ${scaffoldE.note}`);
check('E: instruction was warranted by the diagnosis', scaffoldE.instructionWarranted === true);
check('E: but the scaffold WARNS the course will under-deliver', scaffoldE.codificationWarning === true);
check('E: the residue is routed to connection / coaching, not faked as content',
  scaffoldE.routeToConnectionOrCoaching.length > 0);

// ════════════════════════════════════════════════════════════════════
h('SCENARIO F — the three knowledge principles, applied to a map.');
// ════════════════════════════════════════════════════════════════════
console.log('');
for (const p of KNOWLEDGE_PRINCIPLES) console.log(`   · ${p.principle}`);
console.log('   applied:');
for (const a of kmKnowable.principlesApplied) console.log(`     → ${a.appliedAs}`);
check('F: three knowledge principles are declared', KNOWLEDGE_PRINCIPLES.length === 3);
check('F: every knowledge map records how each principle was honoured',
  kmKnowable.principlesApplied.length === 3);

// ════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log('═'.repeat(72));
if (fail > 0) process.exit(1);
console.log('\nKnowledge management is honest: only what can be codified becomes');
console.log('content; the rest is enabled as a flow — connection, narrative,');
console.log('apprenticeship — and the work regime decides which.');
