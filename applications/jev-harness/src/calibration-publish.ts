/**
 * Calibration on the pod, and what the harness says about itself because of it.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * The calibration view — per judgment kind: samples, hit rates, Brier, agreement; navigation
 * with memory against without — lived only behind GET /jev-harness/calibration: a number
 * whoever asks gets, held by whichever container is answering. Publishing it as a descriptor
 * makes it evidence: signed, attributed to the delegate on behalf of the owner, superseding the
 * previous view under one graph IRI per repository so the chain IS the calibration history, and
 * readable by any agent deciding how far to trust a harness verdict (the gated auto-merge reads
 * it). The attestation is the same evidence in the vocabulary trust decisions use: an
 * amta:Attestation the harness issues about itself — direction Self, a claim rather than a
 * second opinion — with each axis a measured rate and amta:fromExecution naming the calibration
 * descriptor it was computed from. It is issued only when a cell has reached its sample floor:
 * a rating on nothing is not a rating.
 *
 * Pure: payloads in Turtle out. The service publishes them (service.ts publishCalibration).
 */

import { attributionLines, controlLines, dateTime, dbl, documentHeadLines, int, iri, lit, type Control } from '../../_shared/judgment-kit/index.js';
import { actionIri, payloadPrefixes, type PublishContext } from './descriptor.js';
import { round } from './judgments/common.js';
import type { CalibrationCell, CalibrationView, MemoryCell } from './store.js';

export const AMTA = 'https://markjspivey-xwisee.github.io/interego/ns/amta#';
export const CALIBRATION_GRAPH_PREFIX = 'urn:graph:jev-harness:calibration:';
export const ATTESTATION_GRAPH_PREFIX = 'urn:graph:jev-harness:attestation:';

/** One graph per repository: its name as a slug. */
export function repoSlug(repoName: string): string {
  return repoName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'repository';
}
export const calibrationGraphIri = (repoName: string): string => `${CALIBRATION_GRAPH_PREFIX}${repoSlug(repoName)}`;
export const attestationGraphIri = (repoName: string): string => `${ATTESTATION_GRAPH_PREFIX}${repoSlug(repoName)}`;

/** What decides whether the view is worth publishing again: everything but the timestamp. */
export function calibrationFingerprint(view: CalibrationView): string {
  return JSON.stringify({ minSamples: view.minSamples, cells: view.cells, memory: view.memory, adviceBuckets: view.adviceBuckets });
}

const rate = (v: number | null): string => (v === null ? 'n/a' : String(v));

export function calibrationProse(view: CalibrationView, repoName: string): string {
  const lines = [
    `# Calibration: ${repoName}`,
    '',
    `Computed ${view.computedAt}; a cell is Asserted from ${view.minSamples} samples.`,
    '',
    '| Kind | Samples (live) | Status | hit@1 | hit@3 | Brier | Agreement |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...view.cells.map((c) => `| ${c.kind} | ${c.samples} (${c.liveSamples}) | ${c.status} | ${rate(c.hitAt1)} | ${rate(c.hitAt3)} | ${rate(c.brier)} | ${Object.entries(c.agreement).map(([k, n]) => `${k} ${n}`).join(', ') || '—'} |`),
    '',
    `Navigation with precedents applied: ${view.memory.applied.samples} sample(s), hit@1 ${rate(view.memory.applied.hitAt1)}, Brier ${rate(view.memory.applied.brier)}; without: ${view.memory.none.samples}, hit@1 ${rate(view.memory.none.hitAt1)}, Brier ${rate(view.memory.none.brier)}.`,
  ];
  return lines.join('\n');
}

function cellNode(P: (l: string) => string, c: MemoryCell): string {
  const props = [`${P('samples')} ${int(c.samples)}`];
  if (c.hitAt1 !== null) props.push(`${P('hitAt1Rate')} ${dbl(c.hitAt1)}`);
  if (c.hitAt3 !== null) props.push(`${P('hitAt3Rate')} ${dbl(c.hitAt3)}`);
  if (c.brier !== null) props.push(`${P('brier')} ${dbl(c.brier)}`);
  return `[ ${props.join(' ; ')} ]`;
}

/** The read control the calibration affords: the live view, from the bridge that published it. */
export function calibrationControls(ctx: PublishContext, repoName: string): Control[] {
  return [{
    id: `urn:control:jev-harness:calibration:${repoSlug(repoName)}:read`,
    name: 'calibration',
    title: 'Read the live calibration view',
    action: actionIri('calibration'),
    method: 'GET',
    target: `${ctx.controlBase ?? ctx.base}/jev-harness/calibration`,
    returns: `${ctx.ns}Calibration`,
    scopeNote: 'The view this descriptor was computed from, as it stands now; this descriptor is the snapshot the chain keeps.',
    declarative: false,
  }];
}

/** The calibration view as a payload graph: one jvh:Calibration with a cell per kind, the memory split and the advice buckets. */
export function calibrationPayload(view: CalibrationView, ctx: PublishContext, repoName: string): string {
  const S = iri(`urn:jev-harness:calibration:${repoSlug(repoName)}`);
  const P = (local: string): string => `jvh:${local}`;
  const lines: string[] = [
    ...documentHeadLines(S, { types: [P('Calibration')], title: `Calibration: ${repoName}`, prose: calibrationProse(view, repoName) }),
    `${S} ${P('repository')} ${lit(repoName)} .`,
    `${S} ${P('minSamples')} ${int(view.minSamples)} .`,
    `${S} ${P('computedAt')} ${dateTime(view.computedAt)} .`,
  ];
  for (const c of view.cells) {
    const props = [
      `${P('judgmentKind')} ${lit(c.kind)}`,
      `${P('samples')} ${int(c.samples)}`,
      `${P('liveSamples')} ${int(c.liveSamples)}`,
      `${P('cellStatus')} ${lit(c.status)}`,
    ];
    if (c.hitAt1 !== null) props.push(`${P('hitAt1Rate')} ${dbl(c.hitAt1)}`);
    if (c.hitAt3 !== null) props.push(`${P('hitAt3Rate')} ${dbl(c.hitAt3)}`);
    if (c.brier !== null) props.push(`${P('brier')} ${dbl(c.brier)}`);
    for (const [k, n] of Object.entries(c.agreement)) props.push(`${P('agreementCount')} [ ${P('agreement')} ${lit(k)} ; ${P('samples')} ${int(n)} ]`);
    lines.push(`${S} ${P('cell')} [ ${props.join(' ; ')} ] .`);
  }
  lines.push(`${S} ${P('memory')} [ ${P('memoryApplied')} ${cellNode(P, view.memory.applied)} ; ${P('memoryNone')} ${cellNode(P, view.memory.none)} ] .`);
  for (const b of view.adviceBuckets) {
    if (b.samples === 0) continue;
    const props = [`${P('bucketFrom')} ${dbl(b.from)}`, `${P('samples')} ${int(b.samples)}`, `${P('bucketSource')} ${lit(b.source)}`];
    if (b.hitAt1 !== null) props.push(`${P('hitAt1Rate')} ${dbl(b.hitAt1)}`);
    if (b.hitAt3 !== null) props.push(`${P('hitAt3Rate')} ${dbl(b.hitAt3)}`);
    lines.push(`${S} ${P('adviceBucket')} [ ${props.join(' ; ')} ] .`);
  }
  lines.push(...attributionLines(S, ctx.agentId, view.computedAt));
  lines.push(...controlLines(S, calibrationControls(ctx, repoName), P));
  return `${payloadPrefixes(ctx)}\n\n${lines.join('\n')}\n`;
}

export interface AttestationAxes {
  /** Navigation hit@3: the ability to put the right place among three. */
  readonly competence?: number;
  /** Review-verdict agreement with the human decision. */
  readonly accuracy?: number;
  /** Test selection covering the tests that failed. */
  readonly relevance?: number;
  /** How faithfully navigation's probabilities report what happened: 1 − mean Brier. */
  readonly honesty?: number;
  readonly samples: number;
  readonly kinds: readonly string[];
}

const asserted = (view: CalibrationView, kind: string): CalibrationCell | undefined =>
  view.cells.find((c) => c.kind === kind && c.status === 'Asserted');

/** The axes the calibration supports, from Asserted cells only; undefined when none is. */
export function attestationAxes(view: CalibrationView): AttestationAxes | undefined {
  const nav = asserted(view, 'navigation');
  const gate = asserted(view, 'review-verdict');
  const sel = asserted(view, 'test-selection');
  const axes: Record<string, number> = {};
  const kinds: string[] = [];
  let samples = 0;
  if (nav) {
    kinds.push('navigation');
    samples += nav.samples;
    if (nav.hitAt3 !== null) axes['competence'] = nav.hitAt3;
    if (nav.brier !== null) axes['honesty'] = round(1 - nav.brier);
  }
  if (gate) {
    kinds.push('review-verdict');
    samples += gate.samples;
    const total = Object.values(gate.agreement).reduce((a, b) => a + b, 0);
    if (total > 0) axes['accuracy'] = round((gate.agreement['agree'] ?? 0) / total);
  }
  if (sel) {
    kinds.push('test-selection');
    samples += sel.samples;
    if (sel.hitAt1 !== null) axes['relevance'] = sel.hitAt1;
  }
  if (kinds.length === 0 || Object.keys(axes).length === 0) return undefined;
  return { ...axes, samples, kinds };
}

const ACTION_FOR_KIND: Record<string, string> = { navigation: 'navigate', 'review-verdict': 'review-gate', 'test-selection': 'select-tests' };

/**
 * The harness's self-attestation, or undefined when no cell has reached the floor. Grounded in
 * the calibration descriptor when its URL is known, else in the calibration graph IRI.
 */
export function attestationPayload(view: CalibrationView, ctx: PublishContext, repoName: string, opts: { readonly calibrationDescriptorUrl?: string; readonly attestedAt?: string } = {}): string | undefined {
  const axes = attestationAxes(view);
  if (!axes) return undefined;
  const at = opts.attestedAt ?? view.computedAt;
  const S = iri(`urn:jev-harness:attestation:${repoSlug(repoName)}`);
  const P = (local: string): string => `jvh:${local}`;
  const rated = (['competence', 'accuracy', 'relevance', 'honesty'] as const).filter((a) => axes[a] !== undefined);
  const prose = [
    `# Self-attestation: the jev-harness agent on ${repoName}`,
    '',
    `Issued ${at} from ${axes.samples} outcome(s) across ${axes.kinds.join(', ')}. Direction Self: a claim grounded in the calibration descriptor, not a second opinion.`,
    '',
    '| Axis | Rating | From |',
    '| --- | --- | --- |',
    ...rated.map((a) => `| ${a} | ${axes[a]} | ${a === 'competence' ? 'navigation hit@3' : a === 'accuracy' ? 'review-verdict agreement' : a === 'relevance' ? 'test-selection coverage' : '1 − navigation Brier'} |`),
    '| recency | 1 | issued now |',
  ].join('\n');
  const lines: string[] = [
    ...documentHeadLines(S, { types: ['amta:Attestation'], title: `Self-attestation: jev-harness on ${repoName}`, prose }),
    `${S} amta:attestor ${iri(ctx.agentId)} .`,
    `${S} amta:subject ${iri(ctx.agentId)} .`,
    `${S} amta:direction ${lit('Self')} .`,
    `${S} amta:attestedAt ${dateTime(at)} .`,
    `${S} amta:recency ${dbl(1)} .`,
    ...rated.map((a) => `${S} amta:${a} ${dbl(axes[a] as number)} .`),
    ...axes.kinds.map((k) => `${S} amta:attestsTo ${iri(actionIri(ACTION_FOR_KIND[k] ?? k))} .`),
    `${S} amta:fromExecution ${iri(opts.calibrationDescriptorUrl ?? calibrationGraphIri(repoName))} .`,
    `${S} ${P('repository')} ${lit(repoName)} .`,
    `${S} ${P('samples')} ${int(axes.samples)} .`,
    ...attributionLines(S, ctx.agentId, at),
  ];
  return `${payloadPrefixes(ctx)}\n@prefix amta: ${iri(AMTA)} .\n\n${lines.join('\n')}\n`;
}

// ── A peer's word ────────────────────────────────────────────────────────────────────────────

export const PEER_AXES = ['accuracy', 'competence', 'relevance', 'honesty'] as const;
export type PeerAxis = (typeof PEER_AXES)[number];

export interface PeerAttestationInput {
  /** The DID or WebID that will publish the attestation: a person, or the session agent acting for one. */
  readonly attestor: string;
  /** The descriptor URL the attestation is grounded in, an outcome the attestor decided on; the calibration when absent. */
  readonly about?: string;
  /** Why, in a sentence. */
  readonly note?: string;
  /** The attestor's own ratings, 0..1; the calibration's for any axis not given. */
  readonly axes?: Partial<Record<PeerAxis, number>>;
}

export interface AttestationDraft {
  readonly graphIri: string;
  readonly content: string;
  readonly attestor: string;
  readonly axes: Partial<Record<PeerAxis, number>>;
  readonly groundedIn: string;
}

const attestorSlug = (attestor: string): string => attestor.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

/** The graph a peer's attestation lives under: beside the self-attestation, one per attestor, so a newer word from the same attestor supersedes the older. */
export const peerAttestationGraphIri = (repoName: string, attestor: string): string => `${attestationGraphIri(repoName)}:peer:${attestorSlug(attestor)}`;

/**
 * An attestation drafted for SOMEONE ELSE to publish: direction Peer, the attestor's ratings
 * where given and the calibration's where not, grounded in the outcome they decided on or in
 * the calibration descriptor. The harness never publishes it (a second voice has to be another
 * key), and the reputation reader weighs it as PeerAttested the moment it lands on the pod.
 */
export function peerAttestationPayload(view: CalibrationView, ctx: PublishContext, repoName: string, input: PeerAttestationInput, opts: { readonly calibrationDescriptorUrl?: string; readonly attestedAt?: string } = {}): AttestationDraft {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input.attestor)) throw new Error('attestor must be an absolute IRI: a did: or a WebID');
  const derived = attestationAxes(view);
  const axes: Partial<Record<PeerAxis, number>> = {};
  for (const axis of PEER_AXES) {
    const given = input.axes?.[axis];
    if (given !== undefined) {
      if (!(typeof given === 'number' && given >= 0 && given <= 1)) throw new Error(`${axis} must be a number from 0 to 1`);
      axes[axis] = given;
    } else if (derived?.[axis] !== undefined) {
      axes[axis] = derived[axis];
    }
  }
  const rated = PEER_AXES.filter((a) => axes[a] !== undefined);
  if (rated.length === 0) throw new Error('nothing to attest: give at least one of accuracy, competence, relevance or honesty, or wait until a calibration cell reaches its floor');
  const at = opts.attestedAt ?? new Date().toISOString();
  const groundedIn = input.about ?? opts.calibrationDescriptorUrl ?? calibrationGraphIri(repoName);
  const graphIri = peerAttestationGraphIri(repoName, input.attestor);
  const S = iri(`urn:jev-harness:attestation:${repoSlug(repoName)}:peer:${attestorSlug(input.attestor)}`);
  const P = (local: string): string => `jvh:${local}`;
  const own = rated.filter((a) => input.axes?.[a] !== undefined);
  const fromCalibration = rated.filter((a) => !own.includes(a));
  const summary = own.length > 0
    ? `the attestor rated ${own.join(', ')}` + (fromCalibration.length > 0 ? `; the calibration supplied ${fromCalibration.join(', ')}` : '')
    : 'the attestor let the calibration supply every rating';
  const prose = [
    `# A peer's attestation: ${input.attestor} on the jev-harness agent (${repoName})`,
    '',
    `Drafted by the harness at ${at} for the attestor to publish. Direction Peer: ${summary}. Grounded in ${groundedIn}.`,
    ...(input.note ? ['', input.note] : []),
    '',
    '| Axis | Rating | From |',
    '| --- | --- | --- |',
    ...rated.map((a) => `| ${a} | ${axes[a]} | ${own.includes(a) ? 'the attestor' : 'the calibration'} |`),
    '| recency | 1 | issued now |',
  ].join('\n');
  const lines: string[] = [
    ...documentHeadLines(S, { types: ['amta:Attestation'], title: `Peer attestation: ${input.attestor} on jev-harness (${repoName})`, prose }),
    `${S} amta:attestor ${iri(input.attestor)} .`,
    `${S} amta:subject ${iri(ctx.agentId)} .`,
    `${S} amta:direction ${lit('Peer')} .`,
    `${S} amta:attestedAt ${dateTime(at)} .`,
    `${S} amta:recency ${dbl(1)} .`,
    ...rated.map((a) => `${S} amta:${a} ${dbl(axes[a] as number)} .`),
    ...(derived?.kinds ?? []).map((k) => `${S} amta:attestsTo ${iri(actionIri(ACTION_FOR_KIND[k] ?? k))} .`),
    `${S} amta:fromExecution ${iri(groundedIn)} .`,
    `${S} ${P('repository')} ${lit(repoName)} .`,
    `${S} ${P('draftedBy')} ${iri(ctx.agentId)} .`,
    ...(derived ? [`${S} ${P('samples')} ${int(derived.samples)} .`] : []),
    ...attributionLines(S, input.attestor, at),
  ];
  const content = `${payloadPrefixes(ctx)}\n@prefix amta: ${iri(AMTA)} .\n\n${lines.join('\n')}\n`;
  return { graphIri, content, attestor: input.attestor, axes, groundedIn };
}
