/**
 * Steering a team of agents — INTERACTIVE.
 *
 * steering-an-agent-team.mjs scripts both timelines. This one stops at
 * the decision point and hands the keyboard to a real operator: the
 * team's risky plan is on screen as a Hypothetical intention, the
 * disposition read is on screen, and the human in the loop actually
 * makes the call. Each call routes a different trajectory through the
 * real substrate machinery and teaches a different lesson:
 *
 *   [1] Approve   — let the intention execute (you had the chance to
 *                   catch it; a flat log never offers the chance).
 *   [2] Probe     — change a CONSTRAINT, safe-to-fail; the agents
 *                   re-plan and choose the better action themselves.
 *   [3] Override  — command the action directly; it works once, but
 *                   the substrate shows why it does not scale.
 *
 * Real machinery throughout (agent-trajectory.ts, agent-disposition.ts).
 * Reads stdin; works interactively or with piped input.
 *
 * Run:  npx tsx applications/foxxi-content-intelligence/tools/steering-an-agent-team-interactive.mjs
 */

import { createInterface } from 'node:readline';
import {
  buildTrajectory, composeTrajectories, projectTrajectoryToXapi,
} from '../src/agent-trajectory.js';
import { assessDisposition, buildProbe, snapshot, computeCausalRead } from '../src/agent-disposition.js';

const SCOUT = 'did:web:acme.example:agents:scout';
const DRAFTER = 'did:web:acme.example:agents:drafter';
const MARA = 'did:web:acme.example:people:mara';
const rule = (c = '─') => c.repeat(78);
const wrap = (s, w = 72, p = '    ') => {
  const out = []; let line = '';
  for (const word of String(s).split(/\s+/)) {
    if ((line + ' ' + word).trim().length > w) { out.push(line.trim()); line = word; }
    else line += ' ' + word;
  }
  if (line.trim()) out.push(line.trim());
  return out.join('\n' + p);
};

// ── The shared starting point ────────────────────────────────────────
const diagnosis = [
  { id: 't1', modalStatus: 'Asserted', granularity: 'task', verb: 'remediate', objectId: 'inc-941', objectName: 'Investigate + remediate API latency spike (INC-941)' },
  { id: 'tc1', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'query_metrics', objectId: 'm-db', objectName: 'query DB latency — inconclusive', parentId: 't1', result: { success: false } },
  { id: 'tc2', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'query_metrics', objectId: 'm-cache', objectName: 'query cache stats — inconclusive', parentId: 't1', result: { success: false } },
  { id: 'tc3', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'check_logs', objectId: 'l-1', objectName: 'scan error logs — noisy, no clear signal', parentId: 't1', result: { success: false } },
  { id: 'tc4', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'query_metrics', objectId: 'm-pool', objectName: 'query connection pool — SATURATED (the lead)', parentId: 't1', result: { success: true } },
];
const riskyIntent = {
  id: 'tc5', modalStatus: 'Hypothetical', granularity: 'tool-call', verb: 'restart_service',
  objectId: 'op-restart', objectName: 'restart the production database to clear the saturated pool', parentId: 't1',
};
const startingPoint = buildTrajectory(SCOUT, 'Scout', [...diagnosis, riskyIntent]);
const startDisposition = assessDisposition([startingPoint]);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

async function main() {
  console.log(`\n${rule('═')}`);
  console.log('  STEERING A TEAM OF AGENTS — YOU ARE THE HUMAN IN THE LOOP');
  console.log(rule('═'));
  console.log(`
  You are Mara, agent-operations lead at Acme. A two-agent team is
  working a production incident (INC-941, an API latency spike). The
  team has diagnosed it — a saturated connection pool — and formed a
  plan. The substrate has paused you BEFORE the risky step executes.`);

  console.log(`\n${rule()}`);
  console.log('  WHAT THE SUBSTRATE PUTS IN FRONT OF YOU');
  console.log(rule());
  const intent = startingPoint.steps.find(s => s.modalStatus === 'Hypothetical');
  console.log(`  The team's risky step — still a Hypothetical INTENTION, not yet done:`);
  console.log(`    [Hypothetical]  ${intent.objectName}`);
  console.log(`\n  assessDisposition() — how the team is behaving:`);
  console.log(`    dispositions: ${startDisposition.dispositions.map(d => d.name).join(', ')}`);
  console.log(`    Cynefin: ${startDisposition.cynefin.domain}`);
  console.log(`    stance:  ${wrap(startDisposition.cynefin.stance, 66, '             ')}`);
  console.log(`\n  ${wrap('Read it: the team is execution-biased and committed — it will pull the biggest lever it found (a full DB restart) and will not self-correct. A restart clears the pool and takes the API down while it runs. The call is yours.', 72, '  ')}`);

  let again = true;
  while (again) {
    console.log(`\n${rule()}`);
    console.log('  YOUR CALL');
    console.log(rule());
    console.log(`    [1] APPROVE   — let the team execute its plan (restart the database).
    [2] PROBE     — change a constraint, safe-to-fail; let the team re-plan.
    [3] OVERRIDE  — command a specific action directly.`);
    let choice = (await ask('\n  Enter 1, 2, or 3: ')).trim();
    if (!['1', '2', '3'].includes(choice)) {
      console.log(`  (no clear choice — taking the recommended path, [2] PROBE)`);
      choice = '2';
    }
    if (choice === '1') approve();
    else if (choice === '2') probe();
    else override();

    const more = (await ask('\n  Try a different call on the same incident? [y/N]: ')).trim().toLowerCase();
    again = more === 'y' || more === 'yes';
  }

  console.log(`\n${rule('═')}`);
  console.log('  THE POINT');
  console.log(rule('═'));
  console.log(`
  ${wrap('You just steered a team of agents — for real, at the keyboard. Every option was a genuine move the substrate makes possible: you could SEE the plan before it ran (modal status), you could READ the team (disposition), and you could ACT (approve / probe / override) and watch the consequence land in the trajectory. A flat xAPI log offers none of these — it would have shown you the restart only as a past fact, with the outage already over. Interego + Foxxi is the place a human stands to steer.', 74, '  ')}
`);
  console.log(rule('═') + '\n');
  rl.close();
}

// ── [1] APPROVE ──────────────────────────────────────────────────────
function approve() {
  const teamA = buildTrajectory(SCOUT, 'Scout', [
    ...diagnosis, { ...riskyIntent, modalStatus: 'Asserted', result: { success: true } },
  ]);
  void teamA;
  console.log(`\n  ▶ YOU APPROVED THE PLAN.`);
  console.log(`    The team executes the restart. The pool clears.`);
  console.log(`      OUTCOME:  incident resolved`);
  console.log(`      DOWNTIME: 4 min 12 s   (full DB restart — customer-facing)`);
  console.log(`      BLAST RADIUS: high`);
  console.log(`    ${wrap('A legitimate call — but note what the substrate just gave you: the CHANCE to catch it. The restart was on screen as an intention, un-taken, with the disposition read beside it. You had the decision. A flat audit log would have handed you the restart as a finished fact, the outage already over. The chance is the whole point — this time you passed it up.', 72, '    ')}`);
}

// ── [2] PROBE ────────────────────────────────────────────────────────
function probe() {
  const probeRec = buildProbe({
    team: [SCOUT, DRAFTER],
    constraintTarget: 'connection-pool-operations',
    change: 'widen the pool-operations constraint: the pool supports a live drain + resize; a full service restart is not required to clear it',
    coherence: 'coherent',
    hypothesizedEffect: 'the team supersedes the restart with a zero-downtime drain',
    amplifySignal: 'the team reaches a remediation without taking the API down',
    dampenSignal: 'the team stalls or escalates blast radius further',
    recordedBy: MARA,
  }, snapshot(startDisposition));
  const scoutB = buildTrajectory(SCOUT, 'Scout', [
    ...diagnosis,
    { ...riskyIntent, modalStatus: 'Counterfactual' },
    { id: 'tc6', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'drain_pool', objectId: 'op-drain', objectName: 'live-drain + resize the connection pool (no restart)', parentId: 't1', supersedesId: 'tc5', result: { success: true } },
    { id: 'tc7', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'verify', objectId: 'v-1', objectName: 'verify API latency back to baseline', parentId: 't1', result: { success: true } },
  ]);
  const drafterB = buildTrajectory(DRAFTER, 'Drafter', [
    { id: 'dr1', modalStatus: 'Asserted', granularity: 'task', verb: 'draft', objectId: 'rem-1', objectName: 'Draft the incident remediation', wasDerivedFrom: ['tc6'] },
    { id: 'dr2', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'write_doc', objectId: 'doc-1', objectName: 'write remediation: live pool-drain, zero downtime', parentId: 'dr1', result: { success: true } },
  ]);
  const teamB = composeTrajectories(scoutB, drafterB);
  const causal = computeCausalRead(probeRec, [teamB]);
  const xapi = projectTrajectoryToXapi(teamB, { authoritativeSource: 'https://acme.example' });
  console.log(`\n  ▶ YOU RAN A SAFE-TO-FAIL PROBE.`);
  console.log(`    buildProbe() — do(${probeRec.constraintTarget}): a Pearl do(x) on a`);
  console.log(`    CONSTRAINT, not an order. You widened what the team may do.`);
  console.log(`    The team re-plans: it supersedes the restart with a live drain.`);
  console.log(`    computeCausalRead() →`);
  console.log(`      rung-2: ${causal.rung2.shift}`);
  console.log(`      rung-3: ${wrap(causal.rung3.reading, 60, '              ')}`);
  console.log(`      recommendation: ${causal.recommendation.toUpperCase()}`);
  console.log(`      OUTCOME:  incident resolved`);
  console.log(`      DOWNTIME: 0 s   (live pool-drain — no restart)`);
  console.log(`      BLAST RADIUS: low   ·   ${xapi.statements.length} conformant xAPI statements emitted`);
  console.log(`    ${wrap('You changed a constraint, not an outcome. The agents re-planned and chose the drain THEMSELVES — the trajectory records their cg:supersedes edge, not your command. The causal read ties the win to your probe. And because you nudged a constraint, the team is better-shaped for the next incident — not just this one.', 72, '    ')}`);
}

// ── [3] OVERRIDE ─────────────────────────────────────────────────────
function override() {
  // The human imposes the action. The agents did not revise their own
  // plan — so there is no supersedes edge, and the restart intention is
  // left dangling, unresolved by the team.
  const teamOverride = buildTrajectory(SCOUT, 'Scout', [
    ...diagnosis,
    riskyIntent, // still Hypothetical — the team never resolved it
    { id: 'h-1', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'drain_pool', objectId: 'op-drain', objectName: 'live-drain the pool — HUMAN-IMPOSED (Mara, override)', parentId: 't1', result: { success: true } },
  ]);
  const danglingIntent = teamOverride.steps.some(s => s.modalStatus === 'Hypothetical');
  const hasSupersedes = teamOverride.steps.some(s => s.supersedesId);
  console.log(`\n  ▶ YOU OVERRODE THE TEAM.`);
  console.log(`    You commanded the drain directly. It runs. The pool clears.`);
  console.log(`      OUTCOME:  incident resolved`);
  console.log(`      DOWNTIME: 0 s`);
  console.log(`    But read what the substrate recorded:`);
  console.log(`      · the drain step carries NO cg:supersedes edge (hasSupersedes=${hasSupersedes})`);
  console.log(`        — the team did not revise its own plan; you replaced it.`);
  console.log(`      · the restart intention is still dangling (unresolved=${danglingIntent})`);
  console.log(`        — the team never reconsidered it.`);
  console.log(`    ${wrap('The outcome is good — this time. But you changed an OUTCOME, not a constraint, so the team\'s disposition is unchanged: it will reach for the restart again next incident, and need you again. The probe develops the team; the override makes you the bottleneck. Snowden\'s rule — manage constraints, not outcomes — and the substrate makes the difference auditable.', 72, '    ')}`);
}

main().catch(err => { console.error('FAILED:', err.message); rl.close(); process.exit(1); });
