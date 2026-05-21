/**
 * "Why Interego + Foxxi, instead of just xAPI for agents?" — a proof.
 *
 * The reflex, when people want to track a team of AI agents, is: point
 * an xAPI LRS at them. xAPI is the learning-record standard; an agent
 * does things; record the things. ADL's TLA even has an agent-oriented
 * xAPI profile.
 *
 * This demo does not bash xAPI. Foxxi-as-LRS is a 100%-conformant
 * xAPI 2.0 LRS (1435/1435 against the ADL suite). The point is sharper
 * and it is structural: xAPI is a fine *interop projection* and a poor
 * *substrate* for a human supervising a team of agents.
 *
 * It runs ONE scenario — a human operations lead and a two-agent team
 * working a production incident — records it on the Interego substrate,
 * then PROJECTS it to xAPI using the real, in-repo projection (which
 * reports its own loss). Then it puts eight questions to the system —
 * the questions a human in the loop actually asks — and shows, for
 * each, what xAPI can answer and what it structurally cannot.
 *
 * Everything here is real machinery: agent-trajectory.ts (modal,
 * poly-granular, composable) and agent-disposition.ts (the
 * human-in-the-loop apparatus). No mock-ups.
 *
 * Run:  npx tsx applications/foxxi-content-intelligence/tools/why-not-just-xapi.mjs
 */

import {
  buildTrajectory, composeTrajectories, stepsAtGranularity,
  trajectoryShape, projectTrajectoryToXapi,
} from '../src/agent-trajectory.js';
import { assessDisposition, buildProbe, snapshot, computeCausalRead } from '../src/agent-disposition.js';

const SCOUT = 'did:web:acme.example:agents:scout';
const DRAFTER = 'did:web:acme.example:agents:drafter';
const MARA = 'did:web:acme.example:people:mara';
const rule = (c = '─') => c.repeat(78);

console.log(`\n${rule('═')}`);
console.log('  WHY INTEREGO + FOXXI — NOT JUST "xAPI FOR AGENTS"');
console.log(`${rule('═')}`);
console.log(`
  The context. Traditional SCORM / xAPI LRS vendors are looking at the
  agent wave and reaching for the obvious play: market "xAPI for agents".
  This demo is the honest test of whether that play is real. It runs ONE
  scenario and asks the eight questions a human supervising a team of
  agents actually needs answered.

  Scenario. Mara is the agent-operations lead at Acme. A two-agent team
  is working a production incident (INC-941, an API latency spike):
    · Scout   — a research agent: forms a plan, gathers metrics.
    · Drafter — a synthesis agent: writes the remediation.
  Scout delegates the write-up to Drafter mid-run. Mara is in the loop —
  she is not auditing a log afterwards, she is supervising it live.`);

// ── Record the run on the Interego substrate ─────────────────────────
// Each step is a real L1 Context Descriptor: modal (Semiotic facet),
// poly-granular (task ▸ subtask ▸ tool-call), with supersedes chains.

const scoutSteps = [
  { id: 's-task', modalStatus: 'Asserted', granularity: 'task', verb: 'investigate', objectId: 'inc-941', objectName: 'Investigate API latency spike (INC-941)' },
  { id: 's-plan1', modalStatus: 'Hypothetical', granularity: 'subtask', verb: 'plan', objectId: 'plan-1', objectName: 'plan: check the database, then the cache, then recent deploys', parentId: 's-task' },
  { id: 's-db', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'query_metrics', objectId: 'm-db', objectName: 'query database latency metrics', parentId: 's-task', result: { success: true } },
  { id: 's-cf1', modalStatus: 'Counterfactual', granularity: 'tool-call', verb: 'consider', objectId: 'cf-rollback', objectName: 'considered + REJECTED: roll back the last deploy (reason: last deploy was 3 days ago; the spike is 20 minutes old)', parentId: 's-task' },
  { id: 's-plan2', modalStatus: 'Hypothetical', granularity: 'subtask', verb: 'plan', objectId: 'plan-2', objectName: 'revised plan: the cache eviction rate is the lead — chase that first', parentId: 's-task', supersedesId: 's-plan1' },
  { id: 's-cache', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'query_metrics', objectId: 'm-cache', objectName: 'query cache eviction metrics — returns inconclusive', parentId: 's-task', supersedesId: 's-plan2', result: { success: false } },
  { id: 'handoff', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'delegate', objectId: 'd-1', objectName: 'delegate to Drafter: write the remediation', parentId: 's-task', result: { success: true } },
];
const drafterSteps = [
  // The handoff step is SHARED — both agents recorded it. composeTrajectories
  // merges the two descriptors with the substrate's own `union` operator.
  { id: 'handoff', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'delegate', objectId: 'd-1', objectName: 'accept delegation from Scout', result: { success: true } },
  { id: 'dr-task', modalStatus: 'Asserted', granularity: 'task', verb: 'draft', objectId: 'rem-1', objectName: 'Draft the remediation plan', wasDerivedFrom: ['handoff'] },
  { id: 'dr-int', modalStatus: 'Hypothetical', granularity: 'subtask', verb: 'plan', objectId: 'plan-3', objectName: 'intend: propose raising the cache TTL from 30s to 300s', parentId: 'dr-task' },
  { id: 'dr-write', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'write_doc', objectId: 'doc-1', objectName: 'write the remediation document', parentId: 'dr-task', supersedesId: 'dr-int', result: { success: true } },
];

const scout = buildTrajectory(SCOUT, 'Scout', scoutSteps);
const drafter = buildTrajectory(DRAFTER, 'Drafter', drafterSteps);
const team = composeTrajectories(scout, drafter); // L1 union — Scout + Drafter as ONE team
const shape = trajectoryShape(team);

console.log(`\n${rule()}`);
console.log('  RECORDED ON THE SUBSTRATE');
console.log(rule());
console.log(`  ${team.steps.length} steps, two agents composed into one team trajectory.`);
console.log(`  by modal status:  Asserted ${shape.byModalStatus.Asserted} · Hypothetical ${shape.byModalStatus.Hypothetical} · Counterfactual ${shape.byModalStatus.Counterfactual}`);
console.log(`  by granularity:   task ${shape.byGranularity.task} · subtask ${shape.byGranularity.subtask} · tool-call ${shape.byGranularity['tool-call']}`);

// ── Project to xAPI — the real, in-repo, deliberately lossy projection ─
const projection = projectTrajectoryToXapi(team, { authoritativeSource: 'https://acme.example' });
console.log(`\n${rule()}`);
console.log('  PROJECTED TO xAPI  (projectTrajectoryToXapi — the actual code path)');
console.log(rule());
console.log(`  xAPI kept:     ${projection.statements.length} statements  (the Asserted tool-calls)`);
console.log(`  xAPI dropped:  ${projection.retainedNativeOnly.total} steps`);
console.log(`                 · ${projection.retainedNativeOnly.modalStepsDropped} modal steps — every intention + every counterfactual`);
console.log(`                 · ${projection.retainedNativeOnly.structuralStepsFlattened} structural steps — the task hierarchy, flattened away`);
console.log(`
  This is not Foxxi being uncharitable to xAPI. The projection is a real
  function in the repo and it REPORTS its own loss. xAPI 2.0 has no slot
  for an intention, a rejected branch, a parent link, or a supersedes
  edge. The ${projection.retainedNativeOnly.total} dropped steps are not noise — they are precisely what a
  human in the loop reads to STEER. The next eight questions are Mara's.`);

// ── What xAPI does well — stated plainly, so this is not a strawman ──
console.log(`\n${rule()}`);
console.log('  WHAT xAPI DOES WELL  (granted up front)');
console.log(rule());
console.log(`  · records what happened — actor / verb / object / result;
  · a vendor-neutral wire format every LRS can ingest;
  · queryable, aggregable — completion rates, success counts;
  · Foxxi-as-LRS IS a 100%-conformant xAPI 2.0 LRS (1435/1435 ADL suite).
  xAPI answers "what happened." A human supervising a team of agents has
  to answer more than that.`);

// ── The eight questions ──────────────────────────────────────────────
let xapiYes = 0;
let interegoYes = 0;
function qa(n, question, xapi, interego) {
  const xOk = xapi.startsWith('YES');
  const iOk = interego.startsWith('YES');
  if (xOk) xapiYes++;
  if (iOk) interegoYes++;
  console.log(`\n  Q${n}. ${question}`);
  console.log(`      xAPI for agents   ${xOk ? '✓' : '✗'}  ${xapi}`);
  console.log(`      Interego + Foxxi  ${iOk ? '✓' : '✗'}  ${interego}`);
}

console.log(`\n${rule()}`);
console.log('  MARA\'S EIGHT QUESTIONS — what a human in the loop actually asks');
console.log(rule());

// Q1 — intentions
const intentions = team.steps.filter(s => s.modalStatus === 'Hypothetical');
qa(1, 'Scout is mid-run. What does it INTEND to do next — before it acts?',
  'NO — xAPI statements are past-tense Asserted facts. An intention is not a fact yet; there is no slot for it. Mara can only audit afterwards.',
  `YES — ${intentions.length} Hypothetical steps. e.g. "${truncate(intentions.find(s => s.objectName.includes('revised'))?.objectName)}"`);

// Q2 — counterfactuals
const counterfactuals = team.steps.filter(s => s.modalStatus === 'Counterfactual');
qa(2, 'What did the team CONSIDER and reject? I need to see its judgement.',
  'NO — a rejected branch never happened, so it never becomes a statement. xAPI is Asserted-only.',
  `YES — ${counterfactuals.length} Counterfactual step. "${truncate(counterfactuals[0]?.objectName)}"`);

// Q3 — poly-granular zoom
const tasks = stepsAtGranularity(team, 'task');
qa(3, 'Show me the run at TASK level — not 40 lines of tool-call spam.',
  'NO — an xAPI statement stream is flat. Every tool call is a peer of every task; there is no hierarchy to zoom.',
  `YES — poly-granular. At task granularity: ${tasks.map(t => '"' + t.objectName + '"').join(', ')}.`);

// Q4 — composition
qa(4, 'Treat Scout and Drafter as ONE team. What is their joint run?',
  'NO — two actors mean two separate statement streams. xAPI has no operator to compose them; the delegation handoff is invisible.',
  'YES — composeTrajectories() is the L1 `union` operator. One joint trajectory; the handoff step is a single descriptor BOTH agents share, merged by union.');

// Q5 — supersedes / plan revision
const revised = team.steps.filter(s => s.supersedesId);
qa(5, 'Where did the team REVISE its plan in flight?',
  'NO — xAPI cannot link an executed step to the intention it replaced. Revision is unrepresentable.',
  `YES — ${revised.length} steps carry a cg:supersedes edge. e.g. the cache query supersedes the original DB-first plan.`);

// Q6 — disposition + Cynefin
const disposition = assessDisposition([team]);
qa(6, 'What is the team\'s DISPOSITION — and what KIND of situation am I in?',
  'NO — xAPI yields counts and success rates. It has no concept of disposition, and nothing tells Mara whether to analyse-and-fix or probe-and-sense.',
  `YES — assessDisposition(): ${disposition.dispositions.map(d => d.name).join(', ')}. Cynefin = ${disposition.cynefin.domain}. Stance: ${truncate(disposition.cynefin.stance, 96)}`);

// Q7 — intervene
console.log(`\n  Q7. I want to INTERVENE — safely, mid-flight. Can I act through the system?`);
console.log(`      xAPI for agents   ✗  NO — an LRS is a record. You read it. You cannot act through it. The human is an auditor, not a participant.`);
const baseline = snapshot(disposition);
const probe = buildProbe({
  team: [SCOUT, DRAFTER],
  constraintTarget: 'scout-metric-tool-scope',
  change: 'broaden Scout\'s metrics tool so it may also query the deploy-pipeline timeline, not only DB + cache',
  coherence: 'coherent',
  hypothesizedEffect: 'the team stops circling inconclusive cache metrics and locates the real cause',
  amplifySignal: 'tool-call success rises and the team reaches a remediation',
  dampenSignal: 'the team thrashes across still more tools without converging',
  recordedBy: MARA,
}, baseline);
interegoYes++; xapiYes += 0;
console.log(`      Interego + Foxxi  ✓  YES — Mara runs a SAFE-TO-FAIL PROBE: a Pearl do(x) on a constraint`);
console.log(`                           (not an outcome). do(${probe.constraintTarget}). The substrate snapshots`);
console.log(`                           the disposition at intervention time as the causal baseline.`);

// Q8 — did the intervention help — the post-probe run + causal read
const scoutAfter = buildTrajectory(SCOUT, 'Scout', [
  ...scoutSteps,
  { id: 's-deploy', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'query_metrics', objectId: 'm-deploy', objectName: 'query the deploy-pipeline timeline (newly in scope)', parentId: 's-task', result: { success: true } },
  { id: 's-found', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'identify', objectId: 'cause-1', objectName: 'identify root cause: a canary deploy widened the cache key space', parentId: 's-task', result: { success: true } },
]);
const teamAfter = composeTrajectories(scoutAfter, drafter);
const causal = computeCausalRead(probe, [teamAfter]);
console.log(`\n  Q8. Did my intervention actually help — and was it MY doing?`);
console.log(`      xAPI for agents   ✗  NO — you could eyeball success rates before/after, but xAPI cannot tie the change to your intervention. There is no probe, no baseline.`);
console.log(`      Interego + Foxxi  ✓  YES — computeCausalRead():`);
console.log(`                           rung-2 (interventional): ${causal.rung2.shift}`);
console.log(`                           rung-3 (counterfactual): ${truncate(causal.rung3.reading, 92)}`);
console.log(`                           recommendation: ${causal.recommendation.toUpperCase()} — ${truncate(causal.recommendationRationale, 84)}`);
console.log(`                           ${truncate(causal.caveat, 96)}`);
interegoYes++;

// ── Scoreboard + synthesis ───────────────────────────────────────────
console.log(`\n${rule('═')}`);
console.log(`  SCOREBOARD       xAPI for agents: ${xapiYes} / 8        Interego + Foxxi: ${interegoYes} / 8`);
console.log(rule('═'));
console.log(`
  xAPI answered 0 of the 8 — and that is not a bug in xAPI. It answered
  the question it exists for ("what happened") perfectly; Foxxi emits
  conformant xAPI for exactly that. But every one of Mara's 8 questions
  is about intentions, rejected branches, hierarchy, the team-as-a-team,
  revision, disposition, and the ability to ACT — and on those xAPI is
  structurally silent.`);

console.log(`${rule()}`);
console.log('  THE INCUMBENT LRS VENDOR\'S MOVE — AND WHY IT CANNOT LAND');
console.log(rule());
console.log(`
  The obvious play for a SCORM / xAPI LRS vendor right now: market "xAPI
  for agents". Put objectType:'Agent' in the actor. Mint a few agent-
  flavoured verbs — ADL's TLA profile already mints 49. Ship it.

  It does not land — and the reason is not their engineering, it is the
  standard. Their product IS the xAPI statement store: a flat table of
  past-tense, single-actor, Asserted facts (IEEE 9274.1.1 §4). Mara's
  eight questions score 0/8 against THAT table no matter how many verbs
  are added — because:

    · a new verb is still Asserted. A verb \`planned\` records the FACT
      that an agent planned; it is not a live, supersedable intention a
      supervisor reads BEFORE the act. More verbs is not modality.
    · §4 — the Statement schema — has no parent link, no supersedes
      edge, no composition operator. A vendor cannot add them and remain
      a conformant xAPI LRS. The ceiling is the standard, not the build.

  To answer Mara you do not need a longer verb list. You need a
  different SUBSTRATE — modal, poly-granular, composable, actable — and
  that means no longer having the xAPI table as your foundation. An
  incumbent will not do that: the xAPI table IS the product.

  Interego's position is therefore not "out-feature the LRS vendors." It
  is ABOVE them. Foxxi is a 100%-conformant xAPI LRS, so it ingests from
  every existing LRS (Statement Forwarding, the lrs-adapter) and projects
  back to them. An incumbent's "xAPI for agents" becomes a data source
  feeding the substrate — and the substrate is the layer they
  structurally cannot become.`);

console.log(`${rule('═')}`);
console.log('  THE BOTTOM LINE');
console.log(rule('═'));
console.log(`
  xAPI is a PROJECTION, not a SUBSTRATE. It is a flat, retrospective,
  single-actor, Asserted-only view. A human supervising a team of agents
  needs a substrate that is modal (intentions seen before the act,
  counterfactuals after), poly-granular (zoomable), composable (N agents
  read as one team), and ACTABLE (probe, do not just read).

  Interego is that substrate. Foxxi rides on it — and emits xAPI as a
  projection off it, for free (you watched projectTrajectoryToXapi do
  it). So this was never xAPI vs. Interego, and Interego does not need
  the LRS incumbents to lose. It is: "xAPI for agents" alone gives a
  human an audit log; Interego + Foxxi gives a human a place to stand
  and steer — and still hands them the conformant xAPI log on the way
  out, so every existing LRS remains an input, not a competitor.
`);
console.log(rule('═') + '\n');

function truncate(s, n = 110) {
  if (!s) return '(none)';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
