/**
 * External-agent run ingest — Gap 1.
 *
 * The agentic-native trajectory layer + the IEEE P2997 ELR can only see
 * an agent that runs *through* Foxxi affordances (every call is
 * instrumented) or that records a trajectory itself. An external agent —
 * a Codex doing real coding work, an OpenClaw or Hermes agent, a custom
 * enterprise agent — that does its work elsewhere is invisible.
 *
 * This module is the one-call adapter that closes that gap. An external
 * agent (or whatever observes it) emits a single completed RUN; the
 * adapter normalises it into:
 *   · a genuine agentic-native trajectory (so disposition assessment +
 *     the portfolio read can see it), and
 *   · xAPI `performed` statements (so Foxxi-as-LRS + the ELR see it).
 *
 * Two input shapes, so an un-instrumented agent needs almost no code:
 *   · `toolCalls` — a flat list of tool invocations + a run outcome.
 *     The brother's Codex wires this in ~10 lines.
 *   · `steps`    — the full modal / poly-granular trajectory, for an
 *     agent that already tracks intentions + counterfactual branches.
 *
 * Pure: no I/O. The caller (the bridge handler) stores the results.
 *
 * Layer: L3 vertical. Composes agent-trajectory.ts; no new ontology term.
 */

import {
  buildTrajectory, projectTrajectoryToXapi,
  type AgentTrajectory, type TrajectoryStepInput,
} from './agent-trajectory.js';
import { PERFORMED_VERB, PERF_EXT } from './learner-record.js';

const FOXXI_VOCAB = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';

/** Foxxi context-extension IRIs that tie a run to an evaluation cohort. */
export const RUN_EXT = {
  evaluationId: `${FOXXI_VOCAB}evaluationId`,
  candidateId: `${FOXXI_VOCAB}candidateId`,
  harness: `${FOXXI_VOCAB}harness`,
} as const;

/** A harness / runtime an external agent is built on. */
export interface HarnessMeta {
  name?: string;
  version?: string;
  runtime?: string;
}

/** A single tool invocation in the simple run form. */
export interface ToolCallInput {
  /** The tool / action name (becomes the step verb). */
  tool: string;
  /** What the tool acted on; defaults to the tool name. */
  objectName?: string;
  objectId?: string;
  success?: boolean;
  quality?: number;
  note?: string;
}

/** A completed external-agent run, in either of the two input shapes. */
export interface ExternalRunInput {
  agentDid: string;
  agentName?: string;
  /** The task the run accomplished. */
  task: { id?: string; name: string; description?: string };
  /** Simple form — a flat list of tool calls. */
  toolCalls?: ToolCallInput[];
  /** Rich form — the full modal, poly-granular trajectory. */
  steps?: TrajectoryStepInput[];
  /** The run's overall outcome. */
  outcome: { success: boolean; quality?: number; durationIso?: string; costUsd?: number };
  /** DID of whoever observed/attested the run (defaults to the agent itself). */
  observedBy?: string;
  /** Optional evaluation-cohort binding (see agent-evaluation.ts). */
  evaluationId?: string;
  candidateId?: string;
  harness?: HarnessMeta;
}

export interface IngestedRun {
  /** The agentic-native trajectory — source of truth for disposition reads. */
  trajectory: AgentTrajectory;
  /** xAPI statements for Foxxi-as-LRS + the ELR. */
  statements: Array<Record<string, unknown>>;
  summary: {
    stepCount: number;
    toolCallCount: number;
    /** xAPI statements emitted: one task-level `performed` + the projected tool-calls. */
    statementCount: number;
  };
}

let _runCounter = 0;

/**
 * Normalise a completed external-agent run into a trajectory + xAPI
 * statements. The run becomes one task step with its tool-calls nested
 * beneath it (poly-granular); the task carries the run outcome.
 */
export function ingestExternalRun(input: ExternalRunInput): IngestedRun {
  const taskId = input.task.id
    ?? `urn:foxxi:run-task:${slug(input.agentDid)}:${Date.now()}-${_runCounter++}`;
  const observedBy = input.observedBy ?? input.agentDid;

  let stepInputs: TrajectoryStepInput[];
  if (Array.isArray(input.steps) && input.steps.length > 0) {
    // Rich form — the agent already speaks modal / poly-granular.
    stepInputs = input.steps;
  } else {
    // Simple form — synthesise a task step with the tool-calls nested.
    const taskStep: TrajectoryStepInput = {
      id: taskId,
      modalStatus: 'Asserted',
      granularity: 'task',
      verb: 'performed',
      objectId: taskId,
      objectName: input.task.name,
      result: {
        success: input.outcome.success,
        ...(typeof input.outcome.quality === 'number' ? { quality: input.outcome.quality } : {}),
        ...(input.task.description ? { note: input.task.description } : {}),
      },
    };
    const toolSteps: TrajectoryStepInput[] = (input.toolCalls ?? []).map((tc, i) => ({
      id: `${taskId}:tc-${i}`,
      modalStatus: 'Asserted' as const,
      granularity: 'tool-call' as const,
      verb: tc.tool,
      objectId: tc.objectId ?? `${taskId}:tool:${slug(tc.tool)}-${i}`,
      objectName: tc.objectName ?? tc.tool,
      parentId: taskId,
      result: {
        success: tc.success ?? true,
        ...(typeof tc.quality === 'number' ? { quality: tc.quality } : {}),
        ...(tc.note ? { note: tc.note } : {}),
      },
    }));
    stepInputs = [taskStep, ...toolSteps];
  }

  const trajectory = buildTrajectory(input.agentDid, input.agentName, stepInputs);
  const toolCallCount = trajectory.steps.filter(s => s.granularity === 'tool-call').length;

  // Context extensions stamped on every emitted statement.
  const runExtensions: Record<string, unknown> = {
    [PERF_EXT.observedBy]: observedBy,
    [PERF_EXT.contextKind]: 'production',
    [PERF_EXT.actorKind]: 'agent',
    ...(typeof input.outcome.costUsd === 'number' ? { [PERF_EXT.costUsd]: input.outcome.costUsd } : {}),
    ...(input.evaluationId ? { [RUN_EXT.evaluationId]: input.evaluationId } : {}),
    ...(input.candidateId ? { [RUN_EXT.candidateId]: input.candidateId } : {}),
    ...(input.harness ? { [RUN_EXT.harness]: harnessLabel(input.harness) } : {}),
  };

  // 1. The task-level `performed` statement — the ELR reads this as one
  //    performance record (carries the cost + outcome of the whole run).
  const taskStatement: Record<string, unknown> = {
    version: '2.0.0',
    actor: { objectType: 'Agent', account: { homePage: FOXXI_VOCAB, name: input.agentDid } },
    verb: { id: PERFORMED_VERB, display: { en: 'performed' } },
    object: {
      objectType: 'Activity',
      id: taskId,
      definition: {
        name: { en: input.task.name },
        type: `${FOXXI_VOCAB}ProductionTask`,
      },
    },
    result: {
      success: input.outcome.success,
      ...(typeof input.outcome.quality === 'number' ? { score: { scaled: input.outcome.quality } } : {}),
      ...(input.outcome.durationIso ? { duration: input.outcome.durationIso } : {}),
    },
    context: { extensions: { ...runExtensions } },
    timestamp: new Date().toISOString(),
  };

  // 2. The projected tool-call statements (deliberately lossy — only
  //    Asserted tool-calls), each tagged with the same run extensions.
  const projection = projectTrajectoryToXapi(trajectory, { authoritativeSource: FOXXI_VOCAB });
  for (const stmt of projection.statements) {
    const ctx = (stmt.context ?? {}) as { extensions?: Record<string, unknown> };
    stmt.context = { ...ctx, extensions: { ...(ctx.extensions ?? {}), ...runExtensions } };
  }

  const statements = [taskStatement, ...projection.statements];
  return {
    trajectory,
    statements,
    summary: {
      stepCount: trajectory.steps.length,
      toolCallCount,
      statementCount: statements.length,
    },
  };
}

function harnessLabel(h: HarnessMeta): string {
  return [h.name, h.version, h.runtime ? `(${h.runtime})` : ''].filter(Boolean).join(' ').trim() || 'unspecified';
}

function slug(s: string): string {
  return s.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 48);
}
