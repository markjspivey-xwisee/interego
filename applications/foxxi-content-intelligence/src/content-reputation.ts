/**
 * Foxxi's content judgments earn a reputation the way the harness's judgments do: the
 * calibration the confirmed outcomes give (content-judgment.ts) becomes a Self amta-shaped
 * attestation by the judging agent about itself, published on the tenant pod as a
 * foxxi:ContentJudgmentAttestation entity, and every attestation about that agent on the pod is
 * aggregated by @interego/registry under a stated policy: a grounded self-attestation at a
 * quarter of a peer's word. A learning engineer's own attestation, published as a Peer, moves
 * the snapshot the moment it lands. Pure; the bridge reads and publishes.
 */
import { type Attestation, reputationOf, reputationPolicy } from '../../_shared/judgment-kit/attestations.js';
import type { ContentJudgmentCalibration } from './content-judgment.js';
import { FOXXI_NS } from './foxxi-vocab.js';

export const CONTENT_JUDGMENT_ATTESTATION_TYPE = `${FOXXI_NS}ContentJudgmentAttestation`;
export const CONTENT_REPUTATION_POLICY = reputationPolicy('urn:foxxi:policy:content-judgment-reputation-v1');

export type ContentAxis = 'accuracy' | 'competence' | 'honesty';

/** The JSON entity on the tenant pod: the amta axes as a Foxxi bundle carries them. */
export interface ContentJudgmentAttestation {
  readonly type: string;
  readonly attestor: string;
  readonly subject: string;
  readonly direction: 'Self' | 'Peer';
  readonly axes: Readonly<Partial<Record<ContentAxis, number>>>;
  readonly attestedAt: string;
  /** What grounds the ratings: the judgments container the outcomes live in, or what a peer names. */
  readonly fromExecution: string;
  readonly samples: number;
  readonly kinds: readonly string[];
  /** How many of the outcomes behind the ratings a person confirmed, and how many an agent did. */
  readonly confirmers?: { readonly human: number; readonly agent: number };
  readonly note?: string;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The axes the calibration supports, from Asserted cells only: accuracy is the evidence-level hit
 * rate, competence the work-regime hit rate, honesty one minus half the mean multiclass Brier
 * (0..2) over the Asserted cells. Undefined when no cell has reached its floor.
 */
export function contentAttestationAxes(cal: ContentJudgmentCalibration): { readonly axes: Partial<Record<ContentAxis, number>>; readonly samples: number; readonly kinds: string[]; readonly confirmers: { human: number; agent: number } } | undefined {
  const asserted = cal.cells.filter((c) => c.status === 'Asserted');
  if (asserted.length === 0) return undefined;
  const axes: Partial<Record<ContentAxis, number>> = {};
  const evidence = asserted.find((c) => c.judgmentKind === 'evidence-level');
  const regime = asserted.find((c) => c.judgmentKind === 'work-regime');
  if (evidence && evidence.hitRate !== null) axes.accuracy = round3(evidence.hitRate);
  if (regime && regime.hitRate !== null) axes.competence = round3(regime.hitRate);
  const briers = asserted.map((c) => c.meanBrier).filter((b): b is number => b !== null);
  if (briers.length > 0) axes.honesty = round3(1 - briers.reduce((a, b) => a + b, 0) / briers.length / 2);
  if (Object.keys(axes).length === 0) return undefined;
  return {
    axes,
    samples: asserted.reduce((n, c) => n + c.samples, 0),
    kinds: asserted.map((c) => c.judgmentKind),
    confirmers: { human: asserted.reduce((n, c) => n + (c.humanSamples ?? c.samples), 0), agent: asserted.reduce((n, c) => n + (c.agentSamples ?? 0), 0) },
  };
}

/** The attestation the calibration earns — Self when the attestor is the subject, Peer when it attests about another judge — or undefined when it earns none yet. */
export function contentJudgmentAttestation(cal: ContentJudgmentCalibration, agent: string, opts: { readonly fromExecution: string; readonly attestedAt?: string; readonly subject?: string }): ContentJudgmentAttestation | undefined {
  const derived = contentAttestationAxes(cal);
  if (!derived) return undefined;
  return {
    type: CONTENT_JUDGMENT_ATTESTATION_TYPE,
    attestor: agent,
    subject: opts.subject ?? agent,
    direction: opts.subject && opts.subject !== agent ? 'Peer' : 'Self',
    axes: derived.axes,
    attestedAt: opts.attestedAt ?? cal.computedAt,
    fromExecution: opts.fromExecution,
    samples: derived.samples,
    kinds: derived.kinds,
    confirmers: derived.confirmers,
  };
}

export function isContentJudgmentAttestation(v: unknown): v is ContentJudgmentAttestation {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o['type'] === CONTENT_JUDGMENT_ATTESTATION_TYPE && typeof o['attestor'] === 'string' && typeof o['subject'] === 'string'
    && (o['direction'] === 'Self' || o['direction'] === 'Peer') && !!o['axes'] && typeof o['axes'] === 'object'
    && typeof o['attestedAt'] === 'string' && typeof o['fromExecution'] === 'string';
}

/** The registry-facing record for an entity read off the pod; recency is 1 unless the entity rates it. */
export function attestationFromEntity(a: ContentJudgmentAttestation, descriptorUrl: string): Attestation {
  const axes: Record<string, number> = { ...a.axes };
  if (axes['recency'] === undefined) axes['recency'] = 1;
  return { descriptorUrl, attestor: a.attestor, subject: a.subject, direction: a.direction, axes, attestedAt: a.attestedAt, fromExecution: a.fromExecution, samples: a.samples };
}

/** The snapshot for the judging agent from every attestation about it, under the content policy. */
export function contentJudgmentReputation(agent: string, attestations: readonly Attestation[], now?: string) {
  return reputationOf(agent, attestations, CONTENT_REPUTATION_POLICY, now);
}
