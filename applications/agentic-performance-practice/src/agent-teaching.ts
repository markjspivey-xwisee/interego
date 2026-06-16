/**
 * Foxxi A2A teaching — the performance lens over an `ac:TeachingPackage`.
 *
 * Foxxi does NOT invent agent-to-agent teaching. The Interego substrate
 * and two sibling verticals already establish it, and this module
 * composes them rather than parallelling them:
 *
 *   · agent-collective (`ac:`) — agents author tools as first-class
 *     signed descriptors (`code:Commit` + `cg:Affordance`), and teach
 *     each other by bundling a tool with its practice context into an
 *     `ac:TeachingPackage`. A package's trust accrues through
 *     `amta:Attestation`s until `cg:modalStatus` flips to Asserted.
 *   · agent-development-practice (`adp:`) — the complexity-informed
 *     practice the package carries: narrative fragments, syntheses,
 *     constraints, capability-evolution events; probe-sense-respond.
 *   · the substrate — `cg:Affordance` (tools), `amta:Attestation`
 *     (trust), `cg:modalStatus` / `cg:supersedes`, the capability
 *     passport and the registry.
 *
 * What is taught, agent to agent, is an `ac:TeachingPackage`. This
 * module adds exactly ONE thing on top — the performance / L&D
 * dimension, which the foundation does not carry:
 *
 *   · frame the acquisition of a teaching package as a performance
 *     intervention — the A2A directionality, a Knowable knowledge/skill
 *     cause met with instruction;
 *   · verify the transfer by reading the LEARNER'S OWN TRAJECTORIES —
 *     the foundation transfers practice but does not check it against
 *     the learner's logged work. A verified transfer is emitted as an
 *     `amta:Attestation` (axis: correctness) — a new *kind* of evidence,
 *     observed behaviour rather than execution count, that flows into
 *     the SAME modal discipline `ac:` already uses. Foxxi runs no
 *     parallel modal flip;
 *   · feed the reflexive calibration loop (`performance-calibration.ts`).
 *
 * No competing vocabulary, no parallel teaching machinery. The unit is
 * `ac:TeachingPackage`; Foxxi decorates it with measurement.
 *
 * Layer: L3 vertical. Composes the substrate + the `ac:` / `adp:`
 * conventions; no L1/L2/L3 ontology change. Foxxi-added terms are
 * `foxxi:`-namespaced (see foxxi-vocab.ts).
 */

import type { Performer } from './performance-architecture.js';
import type { AgentTrajectory } from './agent-trajectory.js';
import type { OutcomeRecord } from './performance-calibration.js';

// ── The unit taught: a reference to an ac:TeachingPackage ────────────

export type OlkeStage = 'Tacit' | 'Articulate' | 'Collective' | 'Institutional';

/**
 * A reference to an agent-collective `ac:TeachingPackage` — the unit one
 * agent teaches another. agent-collective's `bundleTeachingPackage`
 * authors it (an `ac:AgentTool` artifact + `adp:` practice fragments);
 * Foxxi references it by IRI and never redefines its content.
 */
export interface TeachingPackageRef {
  /** The `ac:TeachingPackage` IRI. */
  iri: string;
  /** The `ac:AgentTool` artifact at its core — a `cg:Affordance`-bearing tool. */
  artifactIri: string;
  /** The competency the package transfers. */
  competency: string;
  /** OLKE maturity stage of the practice it carries. */
  olkeStage: OlkeStage;
  /** `cg:modalStatus` — Hypothetical until attested transfers promote it. */
  modalStatus: 'Hypothetical' | 'Asserted';
}

/**
 * The trajectory signature the transfer is verified against. This IS the
 * Foxxi addition: `ac:` / `adp:` transfer practice, but neither checks
 * the transfer against the learner's logged work. The signature names
 * what that work should look like once the capability is held.
 */
export interface BehaviourSignature {
  description: string;
  /** Verbs / object-name markers indicating the capability is exercised. */
  signalMarkers: string[];
  /** Markers indicating the OLD (uncorrected) behaviour persists. */
  antiSignalMarkers?: string[];
}

// ── Foxxi's framing: acquisition as a performance intervention ──────

export interface TeachingIntervention {
  teachingPackageIri: string;
  competency: string;
  teacher: Performer;
  learner: Performer;
  /** The performance reading of an agent acquiring a documented
   *  capability: a Knowable knowledge/skill cause met with instruction,
   *  authored A2A. (A team's *emergent* behaviour is a different,
   *  Emergent-regime matter — handled by the dispositional path, not
   *  here. This frame fits only a codifiable capability.) */
  regime: 'Knowable';
  method: 'gap-analysis';
  intervention: 'instruction';
  direction: 'A2A';
  note: string;
}

/**
 * Frame a learner agent's acquisition of a teaching package as a
 * performance intervention. This is Foxxi's lens — it does not author or
 * deliver the package (that is `ac:bundleTeachingPackage` and the
 * substrate's context-merge); it reads the acquisition in performance
 * terms so the outcome can be verified and calibrated.
 */
export function frameTeachingIntervention(
  pkg: TeachingPackageRef, teacher: Performer, learner: Performer,
): TeachingIntervention {
  if (teacher.kind !== 'agent' || learner.kind !== 'agent') {
    throw new Error('A2A teaching — both teacher and learner must be agents');
  }
  return {
    teachingPackageIri: pkg.iri,
    competency: pkg.competency,
    teacher,
    learner,
    regime: 'Knowable',
    method: 'gap-analysis',
    intervention: 'instruction',
    direction: 'A2A',
    note: 'An agent acquiring a documented ac:TeachingPackage is, in performance terms, instruction '
      + 'for a Knowable knowledge/skill cause — the A2A directionality. Transfer is verified from the '
      + 'learner\'s trajectories, not assumed from acquisition.',
  };
}

// ── Transfer verification — read the learner's real work ────────────

interface TrajectorySummary {
  trajectories: number;
  steps: number;
  signalShare: number;
  antiSignalShare: number;
}

function summarise(trajectories: readonly AgentTrajectory[], sig: BehaviourSignature): TrajectorySummary {
  const markers = sig.signalMarkers.map(m => m.toLowerCase());
  const anti = (sig.antiSignalMarkers ?? []).map(m => m.toLowerCase());
  let steps = 0, signal = 0, antiSignal = 0;
  for (const t of trajectories) {
    for (const s of t.steps) {
      steps++;
      const hay = `${s.verb ?? ''} ${s.objectName ?? ''}`.toLowerCase();
      if (markers.some(m => hay.includes(m))) signal++;
      if (anti.some(m => hay.includes(m))) antiSignal++;
    }
  }
  return {
    trajectories: trajectories.length,
    steps,
    signalShare: steps > 0 ? signal / steps : 0,
    antiSignalShare: steps > 0 ? antiSignal / steps : 0,
  };
}

export interface TransferVerdict {
  teachingPackageIri: string;
  learner: string;
  /** Did the taught capability genuinely appear in the learner's work? */
  transferred: boolean;
  before: TrajectorySummary;
  after: TrajectorySummary;
  /** `cg:modalStatus` for the transfer claim — Asserted when the
   *  learner's trajectories carry enough evidence to read. */
  modalStatus: 'Hypothetical' | 'Asserted';
  evidence: string;
}

/**
 * Verify that a teaching package transferred — by reading the learner
 * agent's trajectories before and after acquisition. The learner is
 * never quizzed: transfer holds iff the taught behaviour now genuinely
 * shows up in its real work, and the old behaviour has receded.
 */
export function verifyCapabilityTransfer(input: {
  package: TeachingPackageRef;
  targetBehaviour: BehaviourSignature;
  learner: Performer;
  before: readonly AgentTrajectory[];
  after: readonly AgentTrajectory[];
}): TransferVerdict {
  const before = summarise(input.before, input.targetBehaviour);
  const after = summarise(input.after, input.targetBehaviour);
  const enoughEvidence = after.steps >= 4;
  const rose = after.signalShare >= 0.5 && after.signalShare > before.signalShare + 0.2;
  const oldReceded = after.antiSignalShare <= before.antiSignalShare;
  const transferred = enoughEvidence && rose && oldReceded;

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const evidence = !enoughEvidence
    ? `Only ${after.steps} post-acquisition step(s) on record — not yet enough of the learner's work `
      + `to verify the transfer.`
    : transferred
      ? `The taught behaviour rose from ${pct(before.signalShare)} to ${pct(after.signalShare)} of the `
        + `learner's trajectory steps, and the old behaviour receded — the capability transferred.`
      : `The taught behaviour is at ${pct(after.signalShare)} of the learner's steps (from `
        + `${pct(before.signalShare)}) — not a clear transfer. The package was acquired but the work `
        + `did not change; re-contextualize before re-teaching.`;

  return {
    teachingPackageIri: input.package.iri,
    learner: input.learner.id,
    transferred,
    before,
    after,
    modalStatus: enoughEvidence ? 'Asserted' : 'Hypothetical',
    evidence,
  };
}

// ── Feeding the foundation: an amta:Attestation ─────────────────────

/**
 * An `amta:Attestation` emitted from a verified transfer. Foxxi does not
 * run its own modal flip — a verified transfer contributes an
 * attestation, of a *new kind* (observed behaviour in the learner's
 * trajectories, not an execution count), that flows into the SAME
 * attestation discipline `ac:` already uses to promote a teaching
 * package's `cg:modalStatus` to Asserted.
 */
export interface TransferAttestation {
  /** `amta:attestsTo` — the teaching package this attests to. */
  attestsTo: string;
  /** `amta:axis` — a verified transfer attests to the package's correctness. */
  axis: 'correctness';
  /** `amta:rating` — 0..1, the share of the learner's work now exercising it. */
  rating: number;
  /** The observed-behaviour evidence this attestation rests on. */
  fromObservation: string;
  /** `prov:wasAttributedTo` — the learner whose trajectories are the evidence. */
  attributedTo: string;
  recordedAt: string;
  /** Only an Asserted transfer yields an attestation worth contributing. */
  contributed: boolean;
}

/** Emit an `amta:Attestation` from a transfer verdict, for `ac:`'s modal discipline. */
export function transferAttestation(verdict: TransferVerdict): TransferAttestation {
  return {
    attestsTo: verdict.teachingPackageIri,
    axis: 'correctness',
    rating: verdict.after.signalShare,
    fromObservation: verdict.evidence,
    attributedTo: verdict.learner,
    recordedAt: new Date().toISOString(),
    contributed: verdict.transferred && verdict.modalStatus === 'Asserted',
  };
}

// ── Feeding the reflexive calibration loop ──────────────────────────

/**
 * Distil an A2A teaching outcome into a calibration `OutcomeRecord`. An
 * agent lacking a documented capability is a Knowable knowledge/skill
 * cause; an `ac:TeachingPackage` acquired A2A is instruction. So teaching
 * outcomes calibrate the system's recommendations alongside human course
 * completions — the reflexive loop spans humans and agents.
 */
export function teachingToOutcome(verdict: TransferVerdict, source?: string): OutcomeRecord | null {
  if (verdict.modalStatus !== 'Asserted') return null; // not yet evidence
  return {
    regime: 'Knowable',
    method: 'gap-analysis',
    causeFactor: 'knowledgeSkill',
    intervention: 'instruction',
    verdict: verdict.transferred ? 'closed' : 'no-change',
    ...(source ? { source } : {}),
  };
}
