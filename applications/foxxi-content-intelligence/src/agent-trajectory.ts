/**
 * Agent trajectory — the agentic-native record, emergent from Interego L1.
 *
 * xAPI is a retrospective, atomic, single-actor frame: a flat stream of
 * past-tense Asserted statements. That is a fine *projection* but a poor
 * *substrate* for agents. This module is the agentic-native layer; xAPI
 * and the IEEE P2997 LER are projections emitted off it.
 *
 * An agent's run is represented as a TRAJECTORY — a sequence of Context
 * Descriptors, each one a genuine L1 descriptor (Semiotic / Provenance /
 * Agent / Temporal facets), composed so the structure carries what xAPI
 * structurally cannot:
 *
 *   · MODAL — a step may be Hypothetical (an intention / plan),
 *     Asserted (executed), or Counterfactual (a rejected branch). An
 *     agent can record what it *intends* before it acts; the executed
 *     step `supersedes` the intention. xAPI is all Asserted past tense.
 *
 *   · POLY-GRANULAR (the PGSL principle) — every step carries a
 *     granularity (task ▸ subtask ▸ tool-call) and a parent link, so
 *     the trajectory is queryable at any zoom. xAPI is flat.
 *
 *   · COMPOSABLE — trajectories compose via the L1 algebra: `union`
 *     merges two agents' runs (delegation, multi-agent), `restriction`
 *     focuses a sub-run. Per-step descriptors merge with the substrate's
 *     own `union` operator.
 *
 * Projection to xAPI is deliberately LOSSY: only Asserted tool-call
 * steps become xAPI `performed` statements. Intentions, counterfactuals,
 * and the task hierarchy are retained ONLY in the native trajectory —
 * that asymmetry is the whole point.
 *
 * Layer: L3 vertical. Composes L1 primitives (ContextDescriptorData,
 * the seven facets, modal status, the composition algebra). It defines
 * NO new ontology term — an agent is just a cg:Agent whose pod holds a
 * modal, poly-granular, composable descriptor trajectory.
 */

import { union, type ContextDescriptorData, type IRI } from '../../../src/index.js';
import { PERFORMED_VERB, PERF_EXT } from './learner-record.js';

const FOXXI_VOCAB = 'https://vocab.foxximediums.com/activity#';

/** The poly-granular zoom axis (the PGSL principle). */
export type TrajectoryGranularity = 'task' | 'subtask' | 'tool-call';
/** Modal status of a step — L1 cg:modalStatus values. */
export type TrajectoryModalStatus = 'Hypothetical' | 'Asserted' | 'Counterfactual';

export interface TrajectoryStepInput {
  /** Modal status: Hypothetical = intention/plan, Asserted = executed,
   *  Counterfactual = a rejected alternative branch. */
  modalStatus: TrajectoryModalStatus;
  /** Poly-granular level. */
  granularity: TrajectoryGranularity;
  /** What the step does — a verb (a tool name, an action). */
  verb: string;
  objectId: string;
  objectName: string;
  /** Enclosing-granularity step id (the poly-granular tree). */
  parentId?: string;
  /** The step this one revises — plan ▸ revised plan ▸ executed action. */
  supersedesId?: string;
  /** Provenance — prior step ids this step depended on. */
  wasDerivedFrom?: string[];
  result?: { success?: boolean; quality?: number; note?: string };
  recordedAt?: string;
  /** A stable id; minted if omitted. */
  id?: string;
}

export interface TrajectoryStep extends Omit<TrajectoryStepInput, 'id'> {
  id: string;
  recordedAt: string;
  /** The genuine L1 Context Descriptor for this step — seven-facet
   *  structured, modal-statused. The trajectory IS a sequence of these. */
  descriptor: ContextDescriptorData;
}

export interface AgentTrajectory {
  agentDid: string;
  agentName?: string;
  createdAt: string;
  steps: TrajectoryStep[];
}

// ── Step + trajectory construction ──────────────────────────────────

let _stepCounter = 0;

/** Build a trajectory step + its genuine L1 Context Descriptor. */
export function buildStep(agentDid: string, input: TrajectoryStepInput): TrajectoryStep {
  const id = input.id ?? `urn:foxxi:trajectory-step:${slug(agentDid)}:${Date.now()}-${_stepCounter++}`;
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const graphIri = `urn:graph:${id}` as IRI;

  // The step as a real Context Descriptor — Semiotic carries the modal
  // status, Provenance the derivation + supersedes chain.
  const descriptor: ContextDescriptorData = {
    id: `${id}#descriptor` as IRI,
    describes: [graphIri],
    conformsTo: [`${FOXXI_VOCAB}TrajectoryStep` as IRI],
    facets: [
      { type: 'Temporal', validFrom: recordedAt },
      {
        type: 'Provenance',
        wasAttributedTo: agentDid as IRI,
        wasDerivedFrom: [
          ...(input.supersedesId ? [input.supersedesId as IRI] : []),
          ...((input.wasDerivedFrom ?? []) as IRI[]),
        ],
      },
      { type: 'Agent', assertingAgent: agentDid as IRI },
      { type: 'Semiotic', modalStatus: input.modalStatus },
    ],
  };

  return {
    id,
    modalStatus: input.modalStatus,
    granularity: input.granularity,
    verb: input.verb,
    objectId: input.objectId,
    objectName: input.objectName,
    parentId: input.parentId,
    supersedesId: input.supersedesId,
    wasDerivedFrom: input.wasDerivedFrom,
    result: input.result,
    recordedAt,
    descriptor,
  };
}

/** Build an agent trajectory from a list of step inputs. */
export function buildTrajectory(
  agentDid: string,
  agentName: string | undefined,
  stepInputs: readonly TrajectoryStepInput[],
): AgentTrajectory {
  return {
    agentDid,
    agentName,
    createdAt: new Date().toISOString(),
    steps: stepInputs.map(s => buildStep(agentDid, s)),
  };
}

// ── Poly-granular queries (the PGSL pullback principle) ─────────────

/** All steps at one granularity level. */
export function stepsAtGranularity(t: AgentTrajectory, level: TrajectoryGranularity): TrajectoryStep[] {
  return t.steps.filter(s => s.granularity === level);
}

/** Direct children (next granularity down) of a step. */
export function childrenOf(t: AgentTrajectory, parentId: string): TrajectoryStep[] {
  return t.steps.filter(s => s.parentId === parentId);
}

/** Counts per modal status + per granularity — a trajectory at a glance. */
export function trajectoryShape(t: AgentTrajectory): {
  byModalStatus: Record<TrajectoryModalStatus, number>;
  byGranularity: Record<TrajectoryGranularity, number>;
} {
  const byModalStatus: Record<TrajectoryModalStatus, number> = { Hypothetical: 0, Asserted: 0, Counterfactual: 0 };
  const byGranularity: Record<TrajectoryGranularity, number> = { task: 0, subtask: 0, 'tool-call': 0 };
  for (const s of t.steps) { byModalStatus[s.modalStatus]++; byGranularity[s.granularity]++; }
  return { byModalStatus, byGranularity };
}

// ── Composition (the L1 lattice, lifted to trajectories) ────────────

/**
 * Restriction (§3.4.3, lifted) — focus a sub-trajectory: keep only the
 * steps matching the predicate. Used to extract one task's sub-run.
 */
export function restrictTrajectory(
  t: AgentTrajectory,
  predicate: (s: TrajectoryStep) => boolean,
): AgentTrajectory {
  return { ...t, steps: t.steps.filter(predicate) };
}

/**
 * Union (§3.4.1, lifted) — compose two agents' trajectories into one
 * joint trajectory (delegation, multi-agent coordination). Disjoint
 * steps are merged; a step present in BOTH (same id — e.g. a delegation
 * handoff both agents recorded) has its descriptors merged with the
 * substrate's own `union` operator.
 */
export function composeTrajectories(a: AgentTrajectory, b: AgentTrajectory): AgentTrajectory {
  const byId = new Map<string, TrajectoryStep>();
  for (const s of a.steps) byId.set(s.id, s);
  for (const s of b.steps) {
    const existing = byId.get(s.id);
    if (existing) {
      // Shared step — merge the two L1 descriptors with the real operator.
      const merged = union(existing.descriptor, s.descriptor);
      byId.set(s.id, {
        ...existing,
        wasDerivedFrom: [...new Set([...(existing.wasDerivedFrom ?? []), ...(s.wasDerivedFrom ?? [])])],
        descriptor: { ...existing.descriptor, facets: merged.facets },
      });
    } else {
      byId.set(s.id, s);
    }
  }
  return {
    agentDid: `${a.agentDid}+${b.agentDid}`,
    agentName: [a.agentName, b.agentName].filter(Boolean).join(' + ') || undefined,
    createdAt: new Date().toISOString(),
    steps: [...byId.values()],
  };
}

// ── Projection to xAPI (deliberately lossy) ─────────────────────────

export interface TrajectoryXapiProjection {
  /** xAPI statements — only Asserted tool-call steps project. */
  statements: Array<Record<string, unknown>>;
  /** What xAPI structurally cannot hold, retained only in the native form. */
  retainedNativeOnly: {
    /** Hypothetical + Counterfactual steps — xAPI is Asserted-only. */
    modalStepsDropped: number;
    /** Asserted task/subtask steps — xAPI is flat, drops the hierarchy. */
    structuralStepsFlattened: number;
    total: number;
  };
}

/**
 * Project a trajectory down to xAPI. Only Asserted tool-call steps
 * become `performed` statements (which the ELR then reads as performance
 * records). Intentions, counterfactuals, and the task hierarchy stay in
 * the native trajectory — the projection loss is reported, not hidden.
 */
export function projectTrajectoryToXapi(
  t: AgentTrajectory,
  opts: { authoritativeSource: string },
): TrajectoryXapiProjection {
  const statements: Array<Record<string, unknown>> = [];
  let modalDropped = 0;
  let structuralFlattened = 0;

  for (const s of t.steps) {
    if (s.modalStatus !== 'Asserted') { modalDropped++; continue; }
    if (s.granularity !== 'tool-call') { structuralFlattened++; continue; }
    statements.push({
      version: '2.0.0',
      actor: { objectType: 'Agent', account: { homePage: opts.authoritativeSource, name: t.agentDid } },
      verb: { id: PERFORMED_VERB, display: { en: 'performed' } },
      object: {
        objectType: 'Activity',
        id: s.objectId,
        definition: { name: { en: s.objectName }, type: `${FOXXI_VOCAB}ProductionTask` },
      },
      result: {
        success: s.result?.success ?? true,
        ...(typeof s.result?.quality === 'number' ? { score: { scaled: s.result.quality } } : {}),
      },
      context: {
        extensions: {
          [PERF_EXT.observedBy]: t.agentDid,
          [PERF_EXT.contextKind]: 'production',
          [PERF_EXT.actorKind]: 'agent',
          [`${FOXXI_VOCAB}projectedFromTrajectoryStep`]: s.id,
        },
      },
      timestamp: s.recordedAt,
    });
  }

  return {
    statements,
    retainedNativeOnly: {
      modalStepsDropped: modalDropped,
      structuralStepsFlattened: structuralFlattened,
      total: modalDropped + structuralFlattened,
    },
  };
}

function slug(s: string): string {
  return s.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 60);
}
