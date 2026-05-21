/**
 * Agent evaluation cohort + cross-pod delegation — Gap 2.
 *
 * The motivating case: an enterprise where several teams independently
 * build competing agents / harnesses, and nobody can settle on how to
 * evaluate one against another, or whether to converge on one.
 *
 * An EvaluationCohort is a named, shared evaluation: a decision question,
 * an optional shared task set, and a roster of candidate agents. Each
 * candidate is an agent identified by its own DID — which may live on a
 * different team's pod. Bringing such an agent in is exactly a cross-pod
 * delegation: a team REQUESTS enrollment of its agent; the evaluation
 * owner ACCEPTS it. That request → accept handshake is the delegation
 * grant — the one Interego had no turnkey flow for.
 *
 * Each accepted candidate accumulates RUNS (agentic-native trajectories,
 * fed by agent-run-ingest.ts). The portfolio read (agent-portfolio.ts)
 * then compares the roster.
 *
 * This module is the in-memory registry + its pure mutators. The runs'
 * xAPI statements persist in Foxxi-as-LRS independently; the cohort
 * roster is sized for demo workloads (swap for a store at scale, the
 * same way the LRS state stores are).
 *
 * Layer: L3 vertical. No new ontology term.
 */

import type { AgentTrajectory } from './agent-trajectory.js';
import type { HarnessMeta } from './agent-run-ingest.js';

export type { HarnessMeta };

/** A candidate's place in the cohort. `requested` → `accepted` is the
 *  cross-pod delegation grant; `declined` / `withdrawn` are terminal. */
export type EnrollmentStatus = 'requested' | 'accepted' | 'declined' | 'withdrawn';

export interface EvaluationTask {
  id: string;
  name: string;
  description?: string;
}

/** One completed run by a candidate — the trajectory plus its outcome. */
export interface CandidateRun {
  /** The agentic-native trajectory (source of truth for disposition reads). */
  trajectory: AgentTrajectory;
  success: boolean;
  quality?: number;
  costUsd?: number;
  durationIso?: string;
  recordedAt: string;
}

export interface EvaluationCandidate {
  candidateId: string;
  /** The candidate agent's DID — may resolve to any team's pod. */
  agentDid: string;
  agentName: string;
  /** The team that owns / submitted this candidate. */
  team: string;
  /** The harness / runtime the agent is built on. */
  harness?: HarnessMeta;
  /** Pod the candidate agent's records live on, when cross-pod. */
  podUrl?: string;
  status: EnrollmentStatus;
  requestedBy: string;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  /** The candidate's accumulated runs (one entry per completed run). */
  runs: CandidateRun[];
}

export interface AgentEvaluation {
  id: string;
  name: string;
  /** The decision the cohort exists to inform. */
  decisionQuestion: string;
  /** Optional shared task set — apples-to-apples comparison. */
  taskSet: EvaluationTask[];
  openedBy: string;
  openedAt: string;
}

export interface EvaluationState {
  evaluation: AgentEvaluation;
  candidates: EvaluationCandidate[];
}

export interface OpenEvaluationInput {
  name: string;
  decisionQuestion: string;
  taskSet?: Array<{ name: string; id?: string; description?: string }>;
  openedBy: string;
}

export interface EnrollmentRequestInput {
  agentDid: string;
  agentName: string;
  team: string;
  harness?: HarnessMeta;
  podUrl?: string;
  requestedBy: string;
}

type Result<T> = T | { error: string };

/**
 * The in-memory cohort registry. One instance per bridge process; the
 * runs' xAPI evidence is durable in the LRS regardless.
 */
export class EvaluationRegistry {
  private readonly evaluations = new Map<string, EvaluationState>();
  private seq = 0;

  /** Open a new evaluation cohort. */
  open(input: OpenEvaluationInput): AgentEvaluation {
    const id = `urn:foxxi:evaluation:${Date.now()}-${this.seq++}`;
    const taskSet: EvaluationTask[] = (input.taskSet ?? []).map((t, i) => ({
      id: t.id ?? `${id}:task-${i}`,
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
    }));
    const evaluation: AgentEvaluation = {
      id,
      name: input.name,
      decisionQuestion: input.decisionQuestion,
      taskSet,
      openedBy: input.openedBy,
      openedAt: new Date().toISOString(),
    };
    this.evaluations.set(id, { evaluation, candidates: [] });
    return evaluation;
  }

  /**
   * A team requests enrollment of its agent into the cohort. The agent's
   * DID may live on a different pod — this is the cross-pod side. The
   * candidate starts `requested`; it is not yet in the comparison.
   */
  requestEnrollment(evaluationId: string, input: EnrollmentRequestInput): Result<EvaluationCandidate> {
    const state = this.evaluations.get(evaluationId);
    if (!state) return { error: `no evaluation ${evaluationId}` };
    if (!input.agentDid || !input.team) return { error: 'agentDid and team are required' };
    const existing = state.candidates.find(
      c => c.agentDid === input.agentDid && c.status !== 'declined' && c.status !== 'withdrawn',
    );
    if (existing) return { error: `agent ${input.agentDid} is already a candidate (${existing.status})` };
    const candidate: EvaluationCandidate = {
      candidateId: `${evaluationId}:candidate-${state.candidates.length}`,
      agentDid: input.agentDid,
      agentName: input.agentName || input.agentDid,
      team: input.team,
      ...(input.harness ? { harness: input.harness } : {}),
      ...(input.podUrl ? { podUrl: input.podUrl } : {}),
      status: 'requested',
      requestedBy: input.requestedBy,
      requestedAt: new Date().toISOString(),
      runs: [],
    };
    state.candidates.push(candidate);
    return candidate;
  }

  /**
   * The evaluation owner accepts or declines a requested candidate.
   * Accepting it is the delegation grant — the candidate agent is now
   * a managed member of the cohort.
   */
  decide(
    evaluationId: string,
    candidateId: string,
    decision: 'accept' | 'decline',
    decidedBy: string,
  ): Result<EvaluationCandidate> {
    const state = this.evaluations.get(evaluationId);
    if (!state) return { error: `no evaluation ${evaluationId}` };
    const candidate = state.candidates.find(c => c.candidateId === candidateId);
    if (!candidate) return { error: `no candidate ${candidateId}` };
    if (candidate.status !== 'requested') {
      return { error: `candidate ${candidateId} is ${candidate.status}, not awaiting a decision` };
    }
    candidate.status = decision === 'accept' ? 'accepted' : 'declined';
    candidate.decidedBy = decidedBy;
    candidate.decidedAt = new Date().toISOString();
    return candidate;
  }

  /** Append a completed run to an accepted candidate. */
  addRun(evaluationId: string, candidateId: string, run: CandidateRun): Result<EvaluationCandidate> {
    const state = this.evaluations.get(evaluationId);
    if (!state) return { error: `no evaluation ${evaluationId}` };
    const candidate = state.candidates.find(c => c.candidateId === candidateId);
    if (!candidate) return { error: `no candidate ${candidateId}` };
    if (candidate.status !== 'accepted') {
      return { error: `candidate ${candidateId} is ${candidate.status} — accept it before recording runs` };
    }
    candidate.runs.push(run);
    return candidate;
  }

  /** Resolve a candidate by its agent DID (any status). */
  findCandidateByAgent(evaluationId: string, agentDid: string): EvaluationCandidate | undefined {
    return this.evaluations.get(evaluationId)?.candidates.find(c => c.agentDid === agentDid);
  }

  get(evaluationId: string): EvaluationState | undefined {
    return this.evaluations.get(evaluationId);
  }

  list(): AgentEvaluation[] {
    return [...this.evaluations.values()].map(s => s.evaluation);
  }
}
