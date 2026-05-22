/**
 * Foxxi A2A teaching — closing the loop for agents.
 *
 * One of Interego's first principles is that agents collaborate: they
 * share context, teach each other, and build capabilities and tools for
 * each other. Foxxi is the performance layer over that — and a
 * performance layer for agents cannot work the way it does for humans.
 *
 * The human closed loop: contextualize a situation → compose a course →
 * a cmi5 package → a human completes it in a browser → xAPI in the LRS →
 * evaluate. An agent does not "complete a course". A capable agent
 * teaches a less capable one by composing a playbook the learner
 * ingests as context — and the only honest verification is to watch the
 * learner agent's real work change. You do not quiz an agent; you read
 * its trajectories.
 *
 * This module closes the loop for the A2A directionality:
 *   · authorCapability — a teacher agent composes a Capability: a
 *     playbook (a Course with an agent audience) plus the affordances
 *     ("tools") it confers, and a behaviour signature describing what
 *     the learner's work should look like once it has the capability.
 *   · acquireCapability — a learner agent ingests it. The playbook
 *     fragments are delivered as context descriptors it merges into its
 *     working context (composes emergent-content `forAudience`); the
 *     conferred affordances become callable. The acquisition is recorded
 *     — the seed of a capability passport.
 *   · verifyCapabilityTransfer — the heart. The learner agent's
 *     trajectories before and after acquisition are read (composes
 *     agent-trajectory.ts); the capability is verified iff the taught
 *     behaviour now genuinely appears in the learner's real work.
 *   · teachingToOutcome — the verdict flows into the reflexive
 *     calibration loop (performance-calibration.ts): A2A teaching of a
 *     capability is instruction for a Knowable knowledge/skill cause, so
 *     its outcomes calibrate the system's recommendations alongside
 *     human course completions.
 *
 * A Capability is a typed artifact — discoverable and federated, so an
 * agent in one pod can acquire a capability an agent in another pod
 * built. Agents build capabilities, and tools, for each other; Foxxi
 * makes the building measurable.
 *
 * Layer: L3 vertical. Composes the substrate; no L1/L2/L3 ontology
 * change. Domain terms are `foxxi:`-namespaced (see foxxi-vocab.ts).
 */

import { personalize, forAudience, type Course, type Performer } from './emergent-content.js';
import type { AgentTrajectory } from './agent-trajectory.js';
import type { OutcomeRecord } from './performance-calibration.js';

// ── The behaviour signature ─────────────────────────────────────────

/**
 * What a capability is meant to instil — the signature the learner
 * agent's trajectories should exhibit once it genuinely has the
 * capability. This is how transfer is verified without quizzing: the
 * learner's real work either shows the behaviour, or it does not.
 */
export interface BehaviourSignature {
  description: string;
  /** Verbs / object-name markers in a trajectory step that indicate the
   *  capability is being exercised. Matched case-insensitively. */
  signalMarkers: string[];
  /** A trajectory step whose verb or object matches one of these is
   *  evidence the OLD (uncorrected) behaviour is still happening. */
  antiSignalMarkers?: string[];
}

// ── The capability ──────────────────────────────────────────────────

export interface AgentCapability {
  id: string;
  competency: string;
  /** The teacher agent that authored it. */
  authoredBy: Performer;
  /** The playbook — a Course with an agent audience. */
  playbook: Course;
  /** The tools the capability confers — affordance ids the learner
   *  agent gains the right to invoke once it acquires the capability. */
  conferredAffordances: string[];
  /** What the learner's work should look like once it has this. */
  targetBehaviour: BehaviourSignature;
  /** A freshly authored capability is Hypothetical — it has not yet been
   *  shown to transfer. It is promoted to Asserted once a verified
   *  transfer is on record. */
  modalStatus: 'Hypothetical' | 'Asserted';
}

export interface AuthorCapabilityInput {
  competency: string;
  /** The teacher — must be an agent (A2A). */
  authoredBy: Performer;
  /** The playbook the teacher composed (a Course, agent audience). */
  playbook: Course;
  targetBehaviour: BehaviourSignature;
  conferredAffordances?: string[];
}

/** A teacher agent authors a capability for other agents to acquire. */
export function authorCapability(input: AuthorCapabilityInput): AgentCapability {
  if (input.authoredBy.kind !== 'agent') {
    throw new Error('a Capability is authored agent-to-agent — authoredBy must be an agent');
  }
  const slug = input.competency.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return {
    id: `urn:foxxi:capability:${slug || 'capability'}`,
    competency: input.competency,
    authoredBy: input.authoredBy,
    playbook: input.playbook,
    conferredAffordances: input.conferredAffordances ?? [],
    targetBehaviour: input.targetBehaviour,
    modalStatus: 'Hypothetical',
  };
}

// ── Acquisition ─────────────────────────────────────────────────────

export interface AcquisitionRecord {
  capabilityId: string;
  competency: string;
  /** The learner agent. */
  learner: Performer;
  acquiredAt: string;
  /** The playbook fragments delivered as context descriptors the learner
   *  merges into its working context (not slides — an agent ingests
   *  context). */
  contextDescriptors: number;
  /** The affordances the learner agent may now invoke. */
  grantedAffordances: string[];
  /** The directionality — always A2A for a capability. */
  direction: string;
}

/**
 * A learner agent acquires a capability. The playbook is resolved for
 * the learner (the composition algebra) and rendered for an agent
 * audience — each fragment a context descriptor it ingests. The
 * conferred affordances become callable.
 */
export function acquireCapability(capability: AgentCapability, learner: Performer): AcquisitionRecord {
  if (learner.kind !== 'agent') {
    throw new Error('a Capability is acquired agent-to-agent — the learner must be an agent');
  }
  const resolved = personalize(capability.playbook, learner, {});
  const rendering = forAudience(resolved, capability.authoredBy);
  return {
    capabilityId: capability.id,
    competency: capability.competency,
    learner,
    acquiredAt: new Date().toISOString(),
    contextDescriptors: rendering.agentDelivery?.contextDescriptors ?? 0,
    grantedAffordances: [...capability.conferredAffordances],
    direction: rendering.direction,
  };
}

// ── Transfer verification — read the learner's real work ────────────

interface TrajectorySummary {
  trajectories: number;
  steps: number;
  /** Steps exercising the taught behaviour, as a share of all steps. */
  signalShare: number;
  /** Steps still showing the old behaviour, as a share of all steps. */
  antiSignalShare: number;
}

function summarise(trajectories: readonly AgentTrajectory[], sig: BehaviourSignature): TrajectorySummary {
  const markers = sig.signalMarkers.map(m => m.toLowerCase());
  const anti = (sig.antiSignalMarkers ?? []).map(m => m.toLowerCase());
  let steps = 0;
  let signal = 0;
  let antiSignal = 0;
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
  capabilityId: string;
  learner: string;
  /** Did the taught capability genuinely appear in the learner's work? */
  transferred: boolean;
  before: TrajectorySummary;
  after: TrajectorySummary;
  /** A modal status for the transfer claim: Asserted when the learner's
   *  own trajectories carry the evidence; Hypothetical when there is too
   *  little post-acquisition work to read. */
  modalStatus: 'Hypothetical' | 'Asserted';
  evidence: string;
}

/**
 * Verify that a capability transferred — by reading the learner agent's
 * trajectories before and after it acquired the capability. The learner
 * is never quizzed: the capability is verified iff the taught behaviour
 * now genuinely shows up in its real work, and the old behaviour has
 * receded.
 */
export function verifyCapabilityTransfer(input: {
  capability: AgentCapability;
  acquisition: AcquisitionRecord;
  before: readonly AgentTrajectory[];
  after: readonly AgentTrajectory[];
}): TransferVerdict {
  const sig = input.capability.targetBehaviour;
  const before = summarise(input.before, sig);
  const after = summarise(input.after, sig);

  // Too little post-acquisition work to read — the claim cannot be Asserted.
  const enoughEvidence = after.steps >= 4;

  // The capability transferred iff the taught behaviour is now materially
  // present AND it rose from where it was AND the old behaviour receded.
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
        + `${pct(before.signalShare)}) — not a clear transfer. The playbook was ingested but the work `
        + `did not change; re-contextualize before re-teaching.`;

  return {
    capabilityId: input.capability.id,
    learner: input.acquisition.learner.id,
    transferred,
    before,
    after,
    modalStatus: enoughEvidence ? 'Asserted' : 'Hypothetical',
    evidence,
  };
}

// ── Feeding the reflexive calibration loop ──────────────────────────

/**
 * Distil an A2A teaching outcome into a calibration OutcomeRecord. An
 * agent lacking a documented capability is a genuine Knowable-regime
 * knowledge/skill cause; a playbook is instruction, authored A2A. So
 * teaching outcomes calibrate the system's recommendations alongside
 * human course completions — the reflexive loop spans humans and agents.
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

/** Promote a capability to Asserted once a verified transfer is on record. */
export function attestCapability(capability: AgentCapability, verdict: TransferVerdict): AgentCapability {
  if (verdict.transferred && verdict.modalStatus === 'Asserted' && capability.modalStatus === 'Hypothetical') {
    return { ...capability, modalStatus: 'Asserted' };
  }
  return capability;
}
