// One OODA tick: observe → orient → decide → act → verify → maybe-replan.
//
// Every primitive from the rev-195 work is exercised here exactly once.
// The controller calls runTick() in a loop (event-driven or budget-bounded);
// the inner steps are factored out so a smoke-test can exercise them
// without an LLM.

import { readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordTrajectoryStep, readMyTrajectory, readPeerTrajectory, pgslDecide } from './tools.mjs';
import { snapshotCalibration, calibrationDrivenReplan } from './profile.mjs';
import { runDeterministicTests } from './verifiers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Observe — read this agent's own recent trajectory and (when peers
 * are present) the peers' too. Returns a flat shape the orient/decide
 * stages can read.
 */
export async function observe({ agent, peers = [] }) {
  const myRecent = await readMyTrajectory({ agentId: agent.did, limit: 8 });
  const peerRecent = {};
  for (const peer of peers) {
    peerRecent[peer.label ?? peer.did] = await readPeerTrajectory({ peerAgentId: peer.did, limit: 5 });
  }
  return { myRecent, peerRecent };
}

/**
 * Orient — collapse observations into a structured situation.
 */
export function orient({ observations, task, workspace }) {
  const implPath = resolvePath(workspace, task.implementation_file.replace(/^workspace[\\/]/, ''));
  const implementationExists = existsSync(implPath);
  const lastVerbs = observations.myRecent
    .map(e => extractVerbObject(e))
    .filter(Boolean);
  const peerVerbCounts = {};
  for (const [peer, entries] of Object.entries(observations.peerRecent)) {
    peerVerbCounts[peer] = entries.map(extractVerbObject).filter(Boolean);
  }
  return {
    implementationExists,
    implementationPath: implPath,
    lastVerbs,
    peerVerbCounts,
    tickIndex: observations.myRecent.length,
  };
}

/**
 * Decide — substrate-honest: ask pgsl_decide for the next OODA strategy,
 * then map it onto a concrete plan {regime, cause, selectedIntervention,
 * nextAction}. The mapping is the demo-side narrative; the strategy
 * itself comes from the substrate.
 */
export async function decide({ agent, situation }) {
  const oodaDecision = await pgslDecide({ agentId: agent.did });
  // For the demo's "Knowable engineering work" framing:
  //   regime         = Knowable (we know what good looks like — tests pass)
  //   cause          = knowledgeSkill (the gap is implementation know-how)
  //   intervention   = chosen by strategy mapping
  const interventionByStrategy = {
    explore: 'reference',          // look up existing patterns first
    delegate: 'coaching',          // ask a peer (teaching signal)
    exploit: 'instruction',        // act on what's known — write the code
    abstain: 'no-intervention',    // pause; insufficient evidence
  };
  const strategy = oodaDecision?.strategy ?? 'exploit';
  const plan = {
    regime: 'Knowable',
    cause: 'knowledgeSkill',
    selectedIntervention: interventionByStrategy[strategy] ?? 'instruction',
    strategy,
    nextAction: actionForStrategy(strategy, situation),
    note: oodaDecision?.note,
  };
  return { plan, oodaDecision };
}

/**
 * Act — placeholder for the LLM call in one.mjs / collective.mjs.
 * In smoke-test mode this is replaced with a scripted action.
 *
 * The act() phase is the only one that calls Claude. Everything else
 * is pure orchestration over substrate primitives.
 */

/**
 * Verify — run the deterministic tests. Returns the verdict the
 * controller uses to decide whether to exit (PASS) or loop.
 */
export async function verify({ task, workspaceRoot }) {
  return runDeterministicTests({ task, workspaceRoot });
}

/**
 * Maybe-replan — Tier-3: when a sibling intervention has out-performed
 * the current selection by ≥15pts on a comparable cell, swap it in.
 * Returns the (possibly rewritten) plan.
 */
export async function maybeReplan({ plan }) {
  const snapshot = await snapshotCalibration();
  return calibrationDrivenReplan({ plan, snapshot });
}

/**
 * Record this tick's headline event into the agent's trajectory.
 * Called multiple times per tick — once for the plan, once for the
 * act, once for the verify verdict — so the trajectory is a complete
 * substrate-honest record of what the agent did and why.
 *
 * Threads the agent's wallet through to recordTrajectoryStep so the
 * rev-196 signed-request auth path lands the descriptor on the pod.
 */
export async function recordEvent({ agent, verb, objectName, modalStatus = 'Asserted', ...rest }) {
  return recordTrajectoryStep({
    agentId: agent.did,
    wallet: agent.wallet,
    verb, objectName, modalStatus,
    granularity: rest.granularity ?? 'subtask',
    sessionId: rest.sessionId,
    ...rest,
  });
}

// ── helpers ─────────────────────────────────────────────────────────

function extractVerbObject(entry) {
  // entry is a ManifestEntry; we'd need to dereference to get the
  // verb/object literals. For the demo we surface what the manifest
  // already mirrors (modalStatus, validFrom, supersedes count) so we
  // can reason about pace without an extra fetch per step.
  if (!entry?.descriptorUrl) return null;
  return {
    descriptorUrl: entry.descriptorUrl,
    modalStatus: entry.modalStatus,
    validFrom: entry.validFrom,
    cid: entry.cid,
  };
}

function actionForStrategy(strategy, situation) {
  if (!situation.implementationExists) {
    // No implementation yet — even an abstain ("not enough lattice
    // observation") shouldn't paralyse the agent: the first OBSERVATION
    // the lattice can build from is the act of writing. So we coerce
    // abstain/explore to implement when there's nothing to look at yet.
    if (strategy === 'explore') {
      return {
        kind: 'search-codebase',
        prompt:
          'Search the repository for existing reducer/counter helpers BEFORE writing anything. '
          + 'The task expects an existing pattern to be reused where possible. '
          + 'Once you find candidates, write the implementation using them.',
      };
    }
    if (strategy === 'delegate') {
      return { kind: 'await-peer', prompt: 'Wait for a peer to publish. Coaching intervention.' };
    }
    // abstain + exploit both → write the implementation now.
    return {
      kind: 'implement',
      prompt:
        'Write the implementation at the workspace path declared in the task. '
        + 'Keep it small; the tests are the spec.',
    };
  }
  // Implementation exists — improve / debug.
  return {
    kind: 'iterate',
    prompt:
      'An implementation already exists. Run the tests, read the failures (if any), and fix them. '
      + 'When all tests pass, do nothing further; the controller will detect the green verifier.',
  };
}
