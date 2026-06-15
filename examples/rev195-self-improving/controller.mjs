// Controller — Cherny's "I write loops, not prompts."
//
// Holds the goal and the budget. Each tick: observe (read trajectory),
// orient (collapse to situation), decide (pgsl_decide picks strategy),
// act (Claude Code SDK with MCP tools), verify (deterministic tests),
// maybe-replan (calibrationDrivenReplan). Exit on green verifier or
// budget exhaust.
//
// The act() phase is the only place Claude is called. Everything else
// is pure substrate-orchestration.

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observe, orient, decide, verify, maybeReplan, recordEvent } from './tick.mjs';
import { recordTrajectoryStep, subscribePodEvents, podUrlForAgent } from './tools.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Run the loop for one agent. The actImpl is supplied by the caller
 * (one.mjs hands in the Claude Code SDK driver; smoke-test mode hands
 * in a scripted version that just writes the implementation directly).
 *
 * Returns the final outcome: { verdict, ticks, replanned, descriptors }.
 */
export async function runLoop({
  agent,            // { did, label, wallet? }
  task,             // parsed task.json
  workspaceRoot,    // absolute path to the demo dir
  maxTicks,         // hard cap
  peers = [],       // peer agents to subscribe to (collective mode)
  actImpl,          // async ({ agent, plan, situation, task, workspaceRoot, peerSources }) => actEvent
  log = console.log,
  sseEnabled = true,
  signal,           // optional AbortSignal
}) {
  const sessionId = `rev195-${agent.label}-${new Date().toISOString().slice(0, 16)}`;
  log(`[controller] agent=${agent.label} did=${agent.did} sessionId=${sessionId}`);
  log(`[controller] maxTicks=${maxTicks} peers=${peers.length} workspaceRoot=${workspaceRoot}`);

  // Wire SSE-driven wake when peers are present (multi-agent mode).
  // Each peer's pod gets a subscription so this agent ticks the moment
  // any of them publishes. Belt-and-suspenders: we ALSO tick on a
  // generous timer so a missed SSE doesn't freeze us.
  const abortController = new AbortController();
  if (signal) {
    signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }
  const sseTriggers = [];
  if (sseEnabled && peers.length > 0) {
    for (const peer of peers) {
      const peerPod = podUrlForAgent(peer.did);
      log(`[controller] subscribing to peer ${peer.label} pod=${peerPod}`);
      (async () => {
        try {
          for await (const ev of subscribePodEvents({ podUrl: peerPod, signal: abortController.signal })) {
            sseTriggers.push({ kind: ev.kind, peer: peer.label, at: ev.at });
          }
        } catch (err) { /* ignore — SSE is best-effort */ }
      })();
    }
  }

  const descriptors = [];
  let replannedAtLeastOnce = false;

  for (let tick = 1; tick <= maxTicks; tick++) {
    if (abortController.signal.aborted) {
      log(`[tick ${tick}] aborted`);
      break;
    }
    log(`\n[tick ${tick}] ───────────────────────────────────────────`);

    // 1. OBSERVE
    const observations = await observe({ agent, peers });
    log(`[tick ${tick}] observe: ${observations.myRecent.length} of my steps; peers=[${Object.keys(observations.peerRecent).join(',')}]`);

    // 2. ORIENT
    const situation = orient({ observations, task, workspace: resolvePath(workspaceRoot, task.workspace) });
    log(`[tick ${tick}] orient: implementationExists=${situation.implementationExists}`);

    // 3. DECIDE — substrate-honest: ask pgsl_decide.
    // Tolerate transient rate-limits / outages: fall back to a default
    // {strategy:'exploit'} plan so the loop keeps making progress.
    let plan, oodaDecision;
    try {
      ({ plan, oodaDecision } = await decide({ agent, situation }));
    } catch (err) {
      log(`[tick ${tick}] decide failed (${err.message}); defaulting to strategy=exploit`);
      plan = {
        regime: 'Knowable', cause: 'knowledgeSkill', selectedIntervention: 'instruction',
        strategy: 'exploit',
        nextAction: situation.implementationExists
          ? { kind: 'iterate', prompt: 'Tests not green yet — read failures and patch.' }
          : { kind: 'implement', prompt: 'Write the implementation.' },
        note: 'decide() failed; default plan',
      };
      oodaDecision = null;
    }
    log(`[tick ${tick}] decide: strategy=${plan.strategy} → intervention=${plan.selectedIntervention} (nextAction=${plan.nextAction.kind})`);

    // 4. MAYBE-REPLAN — Tier-3 calibrationDrivenReplan.
    const replanResult = await maybeReplan({ plan });
    const finalPlan = replanResult.plan;
    if (replanResult.replanned) {
      replannedAtLeastOnce = true;
      log(`[tick ${tick}] [REPLAN] ${replanResult.swappedOut} → ${replanResult.swappedIn}: ${replanResult.reasoning}`);
      await recordEvent({
        agent, sessionId,
        verb: 'replan',
        objectName: `${replanResult.swappedOut} to ${replanResult.swappedIn}`,
        granularity: 'task',
        modalStatus: 'Asserted',
        resultNote: replanResult.reasoning,
      });
    }

    // Record the plan itself as a Hypothetical trajectory step (the
    // intent BEFORE acting). The act result, if any, supersedes this
    // with an Asserted step.
    const planStep = await recordEvent({
      agent, sessionId,
      verb: 'planning',
      objectName: finalPlan.nextAction.kind,
      granularity: 'task',
      modalStatus: 'Hypothetical',
      resultNote: finalPlan.nextAction.prompt?.slice(0, 200),
    });
    if (planStep.descriptorUrl) descriptors.push(planStep.descriptorUrl);

    // 5. ACT — supplied by caller (Claude SDK or scripted).
    let actResult = { ok: true, summary: 'no-op (abstain or pause)', acted: false };
    if (finalPlan.nextAction.kind !== 'pause' && finalPlan.nextAction.kind !== 'await-peer') {
      try {
        const peerSources = collectPeerSources({ peers, task, workspaceRoot });
        actResult = await actImpl({ agent, plan: finalPlan, situation, task, workspaceRoot, peerSources, tick });
        log(`[tick ${tick}] act: ${actResult.ok ? 'OK' : 'FAIL'} verb=${actResult.verb ?? 'n/a'} obj=${actResult.objectName ?? 'n/a'}`);
      } catch (err) {
        log(`[tick ${tick}] act threw: ${err.message}`);
        actResult = { ok: false, error: err.message, acted: true };
      }
    } else {
      log(`[tick ${tick}] act: skipped (${finalPlan.nextAction.kind})`);
    }

    // Asserted execution step supersedes the Hypothetical plan.
    if (actResult.acted) {
      const actStep = await recordEvent({
        agent, sessionId,
        verb: actResult.verb ?? 'acted',
        objectName: actResult.objectName ?? finalPlan.nextAction.kind,
        granularity: 'tool-call',
        modalStatus: actResult.ok ? 'Asserted' : 'Counterfactual',
        supersedesStepId: planStep.stepId,
        resultSuccess: actResult.ok,
        resultNote: actResult.summary?.slice(0, 200),
      });
      if (actStep.descriptorUrl) descriptors.push(actStep.descriptorUrl);
    }

    // 6. VERIFY — deterministic tests.
    const verdict = await verify({ task, workspaceRoot });
    log(`[tick ${tick}] verify: ${verdict.pass ? 'PASS' : 'FAIL'} (${verdict.durationMs}ms)`);
    if (verdict.pass) {
      await recordEvent({
        agent, sessionId,
        verb: 'verified',
        objectName: 'tests green',
        granularity: 'task',
        modalStatus: 'Asserted',
        resultSuccess: true,
        resultNote: verdict.stdout?.split('\n').slice(0, 6).join(' | '),
      });
      log(`[controller] GREEN at tick ${tick} — exiting loop`);
      return {
        verdict: 'pass', ticks: tick, replanned: replannedAtLeastOnce,
        descriptors, sseTriggers, sessionId,
      };
    }

    // Politeness throttle between ticks — keeps pgsl_decide / discover
    // / record_trajectory_step calls from rate-limiting under multi-agent
    // concurrency. Longer when the agent paused (no work to do).
    const pauseMs = finalPlan.nextAction.kind === 'pause' ? 1_000 : 300;
    await new Promise(r => setTimeout(r, pauseMs));
  }

  log(`[controller] budget exhausted at tick ${maxTicks}`);
  return {
    verdict: 'budget-exhausted', ticks: maxTicks, replanned: replannedAtLeastOnce,
    descriptors, sseTriggers, sessionId,
  };
}

function collectPeerSources({ peers, task, workspaceRoot }) {
  // For the collective demo, peers share the same workspace by
  // design — they each work in a subfolder. Return the peer's
  // implementation source if it exists.
  const out = {};
  for (const peer of peers) {
    const peerWorkspace = resolvePath(workspaceRoot, peer.workspaceSubdir ?? '.');
    const implPath = resolvePath(peerWorkspace, task.implementation_file.replace(/^workspace[\\/]/, ''));
    if (existsSync(implPath)) {
      try { out[peer.label] = readFileSync(implPath, 'utf8'); } catch { /* ignore */ }
    }
  }
  return out;
}
