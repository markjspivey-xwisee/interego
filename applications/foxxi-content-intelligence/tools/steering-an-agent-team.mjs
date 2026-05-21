/**
 * Steering a team of agents — what Interego + Foxxi can DO.
 *
 * The companion demo (why-not-just-xapi.mjs) proves xAPI's ceiling. This
 * one proves the capability positively: it shows a human in the loop,
 * given the substrate, steering a team of agents to a materially better
 * OUTCOME — and it does so by running the SAME starting point twice.
 *
 *   Timeline A — the team runs unsupervised. Its plan executes as-is.
 *   Timeline B — the same team, same starting point, but a human is in
 *                the loop on Interego + Foxxi. She catches the plan
 *                while it is still an intention, reads the team, probes,
 *                and the team re-plans to a safer action.
 *
 * The proof is the delta between the two outcomes — and the fact that
 * every move the human makes in Timeline B is a named substrate
 * primitive doing real work. xAPI is barely mentioned; the point here
 * is not what xAPI lacks, it is what the substrate delivers.
 *
 * Honest scoping: the substrate machinery is real and exercised
 * (agent-trajectory.ts, agent-disposition.ts — no mock-ups). The
 * downtime figures are this scenario's defined outcomes for a database
 * RESTART vs. a live pool DRAIN. The claim is about the steering loop —
 * that the human could see, read, act, and confirm — not about magic
 * latency reduction.
 *
 * Run:  npx tsx applications/foxxi-content-intelligence/tools/steering-an-agent-team.mjs
 */

import {
  buildTrajectory, composeTrajectories, projectTrajectoryToXapi,
} from '../src/agent-trajectory.js';
import { assessDisposition, buildProbe, snapshot, computeCausalRead } from '../src/agent-disposition.js';

const SCOUT = 'did:web:acme.example:agents:scout';
const DRAFTER = 'did:web:acme.example:agents:drafter';
const MARA = 'did:web:acme.example:people:mara';
const rule = (c = '─') => c.repeat(78);
const wrap = (s, w = 72, p = '  ') => {
  const out = []; let line = '';
  for (const word of String(s).split(/\s+/)) {
    if ((line + ' ' + word).trim().length > w) { out.push(line.trim()); line = word; }
    else line += ' ' + word;
  }
  if (line.trim()) out.push(line.trim());
  return out.join('\n' + p);
};

console.log(`\n${rule('═')}`);
console.log('  STEERING A TEAM OF AGENTS — WHAT INTEREGO + FOXXI CAN DO');
console.log(rule('═'));
console.log(`
  This proves a capability by producing an outcome. The same agent team
  hits the same incident twice. Once with no human in the loop. Once
  with a human in the loop on Interego + Foxxi. Watch the outcomes
  diverge — and watch each thing the human does be a substrate primitive.`);

// ── The starting point — shared by both timelines ────────────────────
// The team has diagnosed an incident and FORMED a plan. The risky step
// is still a Hypothetical intention — it has not executed yet.
const diagnosis = [
  { id: 't1', modalStatus: 'Asserted', granularity: 'task', verb: 'remediate', objectId: 'inc-941', objectName: 'Investigate + remediate API latency spike (INC-941)' },
  { id: 'tc1', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'query_metrics', objectId: 'm-db', objectName: 'query DB latency — inconclusive', parentId: 't1', result: { success: false } },
  { id: 'tc2', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'query_metrics', objectId: 'm-cache', objectName: 'query cache stats — inconclusive', parentId: 't1', result: { success: false } },
  { id: 'tc3', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'check_logs', objectId: 'l-1', objectName: 'scan error logs — noisy, no clear signal', parentId: 't1', result: { success: false } },
  { id: 'tc4', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'query_metrics', objectId: 'm-pool', objectName: 'query connection pool — SATURATED (the lead)', parentId: 't1', result: { success: true } },
];
// The risky plan — recorded as an INTENTION, not yet an action.
const riskyIntent = {
  id: 'tc5', modalStatus: 'Hypothetical', granularity: 'tool-call', verb: 'restart_service',
  objectId: 'op-restart', objectName: 'restart the production database to clear the saturated pool', parentId: 't1',
};
const startingPoint = buildTrajectory(SCOUT, 'Scout', [...diagnosis, riskyIntent]);

console.log(`\n${rule()}`);
console.log('  THE STARTING POINT  (shared by both timelines)');
console.log(rule());
console.log(`  The team diagnosed the incident: a saturated connection pool.
  It has formed a plan. The plan's risky step is recorded as a
  Hypothetical INTENTION — still a plan, not yet a fact:

    [Hypothetical]  ${riskyIntent.objectName}

  A full database restart would clear the pool — and take the API down
  while it happens.`);

// ── Timeline A — unsupervised ────────────────────────────────────────
const teamA = buildTrajectory(SCOUT, 'Scout', [
  ...diagnosis,
  { ...riskyIntent, modalStatus: 'Asserted', result: { success: true } },
]);
const downtimeA = '4 min 12 s';
console.log(`\n${rule()}`);
console.log('  TIMELINE A — THE TEAM RUNS UNSUPERVISED');
console.log(rule());
console.log(`  No human in the loop. The intention becomes an action: the team
  executes the database restart. The pool clears.

    OUTCOME:  incident resolved
    DOWNTIME: ${downtimeA}  (full DB restart — customer-facing)
    BLAST RADIUS: high — every API consumer dropped during the restart`);

// ── Timeline B — human in the loop, on Interego + Foxxi ──────────────
console.log(`\n${rule()}`);
console.log('  TIMELINE B — A HUMAN IN THE LOOP, ON INTEREGO + FOXXI');
console.log(rule());
console.log('  Same team. Same starting point. Mara is supervising.\n');

// STEP 1 — she sees the plan before it runs (modal status).
const intent = startingPoint.steps.find(s => s.modalStatus === 'Hypothetical');
console.log('  STEP 1 — SHE SEES THE PLAN BEFORE IT RUNS.');
console.log('    ' + wrap(`Because the substrate is MODAL, the restart is visible as a Hypothetical step while it is still only an intention. On a flat audit log Mara would learn of the restart as a past fact — after the outage. Here she catches it with the action un-taken.`, 72, '    '));
console.log(`    → caught [Hypothetical]: "${intent.objectName}"\n`);

// STEP 2 — she reads the disposition (how to intervene).
const startDisposition = assessDisposition([startingPoint]);
console.log('  STEP 2 — SHE READS THE TEAM\'S DISPOSITION — TO KNOW HOW TO ACT.');
console.log(`    assessDisposition() →`);
console.log(`      dispositions: ${startDisposition.dispositions.map(d => d.name).join(', ')}`);
console.log(`      regime: ${startDisposition.regime.name}`);
console.log(`      stance:  ${wrap(startDisposition.regime.stance, 66, '               ')}`);
console.log('    ' + wrap(`This tells Mara two things. The team is execution-biased and committed — it will pull the biggest lever it found and will not self-correct. And the situation calls for a decisive but SAFE-TO-FAIL move — not an override.`, 72, '    '));

// STEP 3 — she intervenes by changing a constraint, not giving orders.
const probe = buildProbe({
  team: [SCOUT, DRAFTER],
  constraintTarget: 'connection-pool-operations',
  change: 'widen the pool-operations constraint: the pool supports a live drain + resize; a full service restart is not required to clear it',
  coherence: 'coherent',
  hypothesizedEffect: 'the team supersedes the restart with a zero-downtime drain',
  amplifySignal: 'the team reaches a remediation without taking the API down',
  dampenSignal: 'the team stalls or escalates blast radius further',
  recordedBy: MARA,
}, snapshot(startDisposition));
console.log(`\n  STEP 3 — SHE INTERVENES — BY CHANGING A CONSTRAINT, NOT GIVING ORDERS.`);
console.log('    ' + wrap(`buildProbe() — a safe-to-fail a deliberate change intervention. the change to ${probe.constraintTarget}: "${probe.change}". The substrate snapshots the disposition as the causal baseline. Mara did not command "do not restart" — she WIDENED what the team may do. The agents still choose.`, 72, '    '));

// STEP 4 — the team re-plans; the substrate shows the revision.
const scoutB = buildTrajectory(SCOUT, 'Scout', [
  ...diagnosis,
  // With the restart no longer the only lever, it becomes the road not taken.
  { ...riskyIntent, modalStatus: 'Counterfactual' },
  { id: 'tc6', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'drain_pool', objectId: 'op-drain', objectName: 'live-drain + resize the connection pool (no restart)', parentId: 't1', supersedesId: 'tc5', result: { success: true } },
  { id: 'tc7', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'verify', objectId: 'v-1', objectName: 'verify API latency back to baseline', parentId: 't1', result: { success: true } },
]);
const drafterB = buildTrajectory(DRAFTER, 'Drafter', [
  { id: 'dr1', modalStatus: 'Asserted', granularity: 'task', verb: 'draft', objectId: 'rem-1', objectName: 'Draft the incident remediation', wasDerivedFrom: ['tc6'] },
  { id: 'dr2', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'write_doc', objectId: 'doc-1', objectName: 'write remediation: live pool-drain, zero downtime', parentId: 'dr1', result: { success: true } },
]);
const teamB = composeTrajectories(scoutB, drafterB); // L1 union — Scout + Drafter as one team
const revised = teamB.steps.find(s => s.supersedesId);
console.log(`\n  STEP 4 — THE TEAM RE-PLANS. THE SUBSTRATE SHOWS THE REVISION.`);
console.log('    ' + wrap(`Given the widened constraint, the team supersedes its restart plan with a live pool-drain. composeTrajectories() folds Scout + Drafter into one team trajectory via the L1 union operator.`, 72, '    '));
console.log(`    → "${revised.objectName}"`);
console.log(`      carries cg:supersedes → the restart plan. The revision is`);
console.log(`      first-class and auditable; the restart is retained as the`);
console.log(`      Counterfactual road not taken.`);

// STEP 5 — she confirms her intervention is what did it.
const causal = computeCausalRead(probe, [teamB]);
console.log(`\n  STEP 5 — SHE CONFIRMS HER INTERVENTION IS WHAT DID IT.`);
console.log(`    computeCausalRead() →`);
console.log(`      interventional: ${causal.interventional.shift}`);
console.log(`      counterfactual: ${wrap(causal.counterfactual.reading, 64, '                               ')}`);
console.log(`      recommendation: ${causal.recommendation.toUpperCase()}`);

const downtimeB = '0 s';
console.log(`\n    OUTCOME:  incident resolved`);
console.log(`    DOWNTIME: ${downtimeB}  (live pool-drain — no restart)`);
console.log(`    BLAST RADIUS: low — no API consumer was dropped`);

// xAPI was emitted throughout — the substrate did not replace it.
const projection = projectTrajectoryToXapi(teamB, { authoritativeSource: 'https://acme.example' });
console.log(`\n    (Throughout, ${projection.statements.length} conformant xAPI \`performed\` statements were`);
console.log(`     projected to Foxxi-as-LRS — the auditors still get their record.)`);

// ── The proof ────────────────────────────────────────────────────────
console.log(`\n${rule('═')}`);
console.log('  THE PROOF');
console.log(rule('═'));
console.log(`
  Same team. Same starting point. Same incident resolved.

    Timeline A  (no human in the loop)        downtime ${downtimeA}   blast: high
    Timeline B  (human in the loop, substrate) downtime ${downtimeB}        blast: low

  The delta is a prevented customer-facing outage. It was produced by a
  human — and made possible, at every step, by a substrate primitive:

    she SAW the plan       ← modal status: Hypothetical, before Asserted
    she knew HOW to act    ← the disposition read: work-regime stance
    she ACTED on it        ← the safe-to-fail probe: a change to a constraint
    the team RE-PLANNED    ← the cg:supersedes chain
    she KNEW it worked     ← the causal read: interventional / counterfactual

  None of these is a feature bolted onto a log. Each is the substrate
  being modal, poly-granular, composable, and ACTABLE. That is what
  Interego + Foxxi can do: not record an agent team — let a human STEER
  one, to an outcome that would not otherwise have happened.
`);
console.log(rule('═') + '\n');
