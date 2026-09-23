/**
 * A content judgment: a System One model answers one typed question about a unit of course
 * content, and the answer is published as a Hypothetical descriptor a person can confirm or
 * refute.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * Every intelligence Foxxi offered until 2026-09-21 was either a free-text completion
 * (foxxi.ask_course_question_agentic, an LLM answering in prose) or deterministic graph
 * topology (concept difficulty from prerequisite edges). Neither yields a typed answer with a
 * probability distribution that code can act on and that calibration can score. jev-harness
 * proved that shape for repositories; this is the same shape for content, through the shared
 * judgment kit (applications/_shared/judgment-kit): the same client, the same fake for tests,
 * the same viewer projection.
 *
 * Two questions, both narrow, both with the answers defined as concrete situations (the
 * System One guidance: instructions say what is judged, criteria define the answers):
 *
 *   evidence-level  a Score over how well the claim is supported by the context and evidence
 *                   supplied — an ordered scale from unsupported to corroborated
 *   work-regime     a Choice among Foxxi's own regimes (Evident, Knowable, Emergent,
 *                   Turbulent) for the work the content describes; the regime decides which
 *                   consulting and knowledge method is valid (see WorkRegime in foxxi-vocab.ts)
 *
 * Policy is code: which question is asked, what the answer means, what a person can do next.
 * The model supplies the semantic reading. Nothing here touches the network except the client.
 */

import { calibrationCell, choiceBrier, hmdDocument, type CalibrationCellSummary, type Control } from '../../_shared/judgment-kit/index.js';
import { estimateTokens, type ChoiceAnswer, type JevClient, type Question, type ScoreAnswer } from '../../_shared/judgment-kit/jev-client.js';
import { FOXXI_NS } from './foxxi-vocab.js';

export const CONTENT_JUDGMENT_KINDS = ['evidence-level', 'work-regime'] as const;
export type ContentJudgmentKind = (typeof CONTENT_JUDGMENT_KINDS)[number];

/** The evidence scale, in order: each level names a concrete situation a reader can recognise. */
export const EVIDENCE_LEVELS = [
  'unsupported',
  'asserted-only',
  'supported-by-context',
  'supported-by-cited-evidence',
  'corroborated',
] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

/**
 * ★ WHAT COUNTS AS CITED EVIDENCE, since the live run of 2026-09-23: an evidence item that only
 * names the passage the claim sits in (the claim's own slide, the section it is quoted from) is
 * the context under another name, not evidence beyond it. The first run scored "stay still while
 * another player takes their shot", cited with its own slide and nothing else, as
 * supported-by-cited-evidence; by the letter of the old wording that was right, and it made the
 * two middle levels indistinguishable whenever a caller cited the slide. Cited evidence is what
 * lies outside the passage: a rule, a source, a record, another slide.
 */
const EVIDENCE_CRITERIA: Record<EvidenceLevel, string> = {
  'unsupported': 'The context or the evidence contradicts the claim, or the claim is about something they do not cover at all. A claim the context corrects (the passage states it and then says otherwise) is unsupported, not asserted.',
  'asserted-only': 'The claim is stated in the context, and nothing in the context or the evidence backs it beyond the statement itself: no example, no mechanism, no derivation, no source outside the passage.',
  'supported-by-context': 'The context explains or demonstrates the claim (an example, a mechanism, a derivation), and any evidence item merely names the passage the claim sits in — its own slide or section — which is the context, not evidence beyond it.',
  'supported-by-cited-evidence': 'At least one evidence item from outside the passage — a rule, a source, a record, another slide — directly supports the claim, and the context is consistent with it.',
  'corroborated': 'Two or more independent evidence items from outside the passage support the claim and the context agrees with them.',
};

/** Foxxi's work regimes, as WorkRegime in foxxi-vocab.ts defines them. */
export const WORK_REGIMES = ['Evident', 'Knowable', 'Emergent', 'Turbulent'] as const;
export type WorkRegime = (typeof WORK_REGIMES)[number];

/**
 * ★ A PRACTICE IS NOT A REGIME, since the live run of 2026-09-23: the model answered Evident for
 * every claim phrased as a practice — "make friends on the course: conversation between shots,
 * compliments after good play" at 0.77, "relax and enjoy the round" at 0.70 — because the old
 * wording made "an established practice applies" sufficient. In the regimes as Foxxi defines
 * them (foxxi-vocab.ts, after Cynefin), what decides is whether following the practice DETERMINES
 * the result. When the result turns on how other people or the situation respond, no practice
 * determines it, and the work is Emergent however familiar the practice is.
 */
const REGIME_CRITERIA: Record<WorkRegime, string> = {
  Evident: 'Following an established practice determines the result: anyone doing the work gets the same outcome by doing the same steps, as with a calculation, a checklist, or a rule applied to known facts.',
  Knowable: 'Cause and effect hold, but which method gives the result takes expertise or analysis to find: the right method is investigated, then applied, and then it determines the result.',
  Emergent: 'No practice determines the result, because the result turns on how other people or the situation respond — making friends, changing someone\'s mind, enjoying oneself, finding what a group wants — and only becomes clear in retrospect: the valid method is to probe, sense what happens, and respond.',
  Turbulent: 'No stable relationship between act and outcome can be found while the situation lasts: the valid method is to act to stabilise first, then reassess.',
};

export interface EvidenceItem {
  readonly type: string;
  readonly id: string;
  readonly narrative?: string;
}

export interface ContentJudgmentInput {
  readonly judgmentKind: ContentJudgmentKind;
  /** The claim being judged, as it appears in or about the content. */
  readonly claimText: string;
  /** The passage the claim sits in (slide text, transcript, section), when the caller has it. */
  readonly context?: string;
  readonly evidence?: readonly EvidenceItem[];
  readonly courseIri?: string;
  readonly slideId?: string;
  readonly conceptIds?: readonly string[];
}

export interface ContentJudgment {
  readonly kind: 'content-judgment';
  readonly id: string;
  readonly graphIri: string;
  readonly createdAt: string;
  readonly model: string;
  /** The model's confidence in its answer (Choice: concentration of the distribution). */
  readonly confidence: number;
  readonly judgmentKind: ContentJudgmentKind;
  readonly claimText: string;
  /** The answer with the most probability: an evidence level or a work regime. */
  readonly answer: string;
  readonly probabilities: Record<string, number>;
  /** For a Score: the probability-weighted position on the scale, 0 to levels − 1. */
  readonly score?: number;
  readonly courseIri?: string;
  readonly slideId?: string;
  readonly conceptIds?: readonly string[];
  readonly evidenceCount: number;
  readonly usage: { readonly requests: number; readonly input_tokens: number; readonly output_tokens: number; readonly latencyMs: number };
  /** The agent that made this judgment: the bridge's own judge for its model's, the caller for a recorded one. Absent on judgments from before 2026-09-23: the bridge's own. */
  readonly judge?: string;
}

export const CONTENT_JUDGMENT_GRAPH_PREFIX = 'urn:graph:foxxi:content-judgment:';

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

const round = (n: number, places = 3): number => Math.round(n * 10 ** places) / 10 ** places;

/** The state the model sees: the smallest thing that answers the question. */
export function judgmentState(input: ContentJudgmentInput): Record<string, unknown> {
  return {
    claim: {
      text: input.claimText,
      ...(input.slideId ? { slideId: input.slideId } : {}),
      ...(input.conceptIds && input.conceptIds.length > 0 ? { conceptIds: [...input.conceptIds] } : {}),
    },
    ...(input.context ? { context: input.context.slice(0, 6000) } : {}),
    evidence: (input.evidence ?? []).slice(0, 20).map((e) => ({ type: e.type, id: e.id, ...(e.narrative ? { narrative: e.narrative.slice(0, 600) } : {}) })),
  };
}

/** The one question each kind asks. */
export function judgmentQuestion(kind: ContentJudgmentKind): Question {
  if (kind === 'evidence-level') {
    return {
      type: 'score',
      instructions: 'How well is `claim.text` supported by `context` and by the items in `evidence`? Judge only from what is supplied; do not use outside knowledge of whether the claim is true.',
      criteria: EVIDENCE_LEVELS.map((l) => EVIDENCE_CRITERIA[l]),
    };
  }
  return {
    type: 'choice',
    instructions: 'Which work regime does the work described by `claim.text` (with `context` and `evidence` for what the work is) fall in? Judge the relationship between doing the work and its results, not how hard the work is.',
    criteria: Object.fromEntries(WORK_REGIMES.map((r) => [r, REGIME_CRITERIA[r]])),
  };
}

export async function judgeContentClaim(jev: JevClient, input: ContentJudgmentInput): Promise<ContentJudgment> {
  if (!(CONTENT_JUDGMENT_KINDS as readonly string[]).includes(input.judgmentKind)) throw new Error(`judgment kind must be one of ${CONTENT_JUDGMENT_KINDS.join(', ')}`);
  if (input.claimText.trim().length < 8) throw new Error('the claim is too short to judge');
  const state = judgmentState(input);
  const r = await jev.systemOne(state, { judgment: judgmentQuestion(input.judgmentKind) });
  const a = r.answers['judgment'];
  if (!a) throw new Error('the model returned no answer for the judgment');
  let answer: string;
  let probabilities: Record<string, number>;
  let confidence: number;
  let score: number | undefined;
  if (input.judgmentKind === 'evidence-level') {
    const s = a as ScoreAnswer;
    // A Score's probabilities are keyed by level position or by the level's criterion text;
    // either way the scale is ours, so the keys are re-labelled with the level names.
    probabilities = {};
    for (const [key, p] of Object.entries(s.probabilities)) {
      const byIndex = EVIDENCE_LEVELS[Number(key)];
      const byText = EVIDENCE_LEVELS.find((l) => EVIDENCE_CRITERIA[l] === key || l === key);
      probabilities[byIndex ?? byText ?? key] = round(p);
    }
    const top = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0];
    answer = top?.[0] ?? EVIDENCE_LEVELS[Math.max(0, Math.min(EVIDENCE_LEVELS.length - 1, Math.round(s.score)))]!;
    confidence = round(s.confidence);
    score = round(s.score);
  } else {
    const c = a as ChoiceAnswer;
    probabilities = Object.fromEntries(Object.entries(c.probabilities).map(([k, p]) => [k, round(p)]));
    answer = c.choice;
    confidence = round(c.confidence);
  }
  const id = newId();
  return {
    kind: 'content-judgment',
    id,
    graphIri: `${CONTENT_JUDGMENT_GRAPH_PREFIX}${id}`,
    createdAt: new Date().toISOString(),
    model: r.model,
    confidence,
    judgmentKind: input.judgmentKind,
    claimText: input.claimText,
    answer,
    probabilities,
    ...(score !== undefined ? { score } : {}),
    ...(input.courseIri ? { courseIri: input.courseIri } : {}),
    ...(input.slideId ? { slideId: input.slideId } : {}),
    ...(input.conceptIds && input.conceptIds.length > 0 ? { conceptIds: [...input.conceptIds] } : {}),
    evidenceCount: input.evidence?.length ?? 0,
    usage: { requests: 1, input_tokens: r.usage.input_tokens || estimateTokens(state), output_tokens: r.usage.output_tokens, latencyMs: r.latencyMs },
  };
}

/**
 * What a person can do with the judgment. Both are declarative: Foxxi records confirmations
 * through its countersign path for competencies today, and a content outcome affordance is
 * the next increment; until then the control says exactly what to record and where.
 */
export function contentJudgmentControls(j: ContentJudgment): Control[] {
  const c = (name: string, title: string, args: unknown, note: string): Control => ({
    id: `urn:control:foxxi:content-judgment:${j.id}:${name}`,
    name,
    title,
    action: `urn:iep:action:foxxi:${name}`,
    method: 'POST',
    arguments: args,
    scopeNote: note,
    declarative: true,
  });
  const out: Control[] = [];
  if (j.judgmentKind === 'evidence-level' && (j.answer === 'unsupported' || j.answer === 'asserted-only')) {
    out.push(c('cite-evidence', 'Cite evidence for the claim or revise it', { judgment_iri: j.graphIri, claim: j.claimText, ...(j.slideId ? { slide_id: j.slideId } : {}) },
      `The model read the claim as ${j.answer} at confidence ${j.confidence}. Declarative: an author adds a source to the content or rewrites the claim; nothing is executed here.`));
  }
  if (j.judgmentKind === 'work-regime' && (j.answer === 'Emergent' || j.answer === 'Turbulent')) {
    out.push(c('choose-method-for-regime', `Apply the ${j.answer} regime's method`, { judgment_iri: j.graphIri, regime: j.answer },
      `Diagnosis follows the regime (see WorkRegime): ${j.answer === 'Emergent' ? 'probe, sense, respond' : 'stabilise first, then reassess'}. Declarative: the instructional designer chooses the method.`));
  }
  out.push(c('confirm-or-refute', 'Confirm or refute the answer', { judgment_iri: j.graphIri, judgment_kind: j.judgmentKind, answer: j.answer, alternatives: Object.keys(j.probabilities) },
    'A person records the answer they hold to be true; the record supersedes this Hypothetical judgment as Asserted and scores its calibration. Declarative until Foxxi ships the content-outcome affordance.'));
  return out;
}

/** What the model was told and what it answered, as prose the viewer renders. */
export function contentJudgmentProse(j: ContentJudgment): string {
  const lines = [
    `# Content judgment (${j.judgmentKind}): ${j.answer}`,
    '',
    `Model ${j.model}, confidence ${j.confidence}${j.score !== undefined ? `, scale position ${j.score} of ${EVIDENCE_LEVELS.length - 1}` : ''}, ${j.evidenceCount} evidence item(s)${j.slideId ? `, slide ${j.slideId}` : ''}.`,
    '',
    `Claim: ${j.claimText}`,
    '',
    '| Answer | Probability |',
    '| --- | --- |',
    ...Object.entries(j.probabilities).sort((x, y) => y[1] - x[1]).map(([k, p]) => `| ${k} | ${p} |`),
  ];
  return lines.join('\n');
}

/** The HyperMarkdown projection, through the shared kit. */
export function contentJudgmentMarkdown(j: ContentJudgment, controls: readonly Control[], base: string): string {
  return hmdDocument({
    url: `${base.replace(/\/$/, '')}/foxxi/judgments/${j.id}`,
    nsPrefix: 'foxxi',
    ns: FOXXI_NS,
    payloadType: 'ContentJudgment',
    state: 'hypothetical',
    graphIri: j.graphIri,
    prose: contentJudgmentProse(j),
    controls,
  });
}

// ── Outcomes and calibration ──────────────────────────────────────────────────────────
//
// A judgment is Hypothetical until a person says what is true. The outcome is that saying:
// Asserted, superseding the judgment on the pod, carrying whether the model had it and how
// far off its probabilities were. Calibration is computed over the outcomes on the pod, per
// question kind, with the same floor the harness uses.

export const CONTENT_JUDGMENT_TYPE = `${FOXXI_NS}ContentJudgment`;
export const CONTENT_JUDGMENT_OUTCOME_TYPE = `${FOXXI_NS}ContentJudgmentOutcome`;
export const CONTENT_JUDGMENT_MIN_SAMPLES = 5;

export interface ContentJudgmentOutcome {
  readonly kind: 'content-judgment-outcome';
  readonly judgmentId: string;
  /** The judgment entity on the pod (urn:foxxi:judgment:<uid>). */
  readonly judgmentIri: string;
  readonly judgmentKind: ContentJudgmentKind;
  /** What the model answered. */
  readonly answer: string;
  /** What the person holds to be true. */
  readonly confirmedAnswer: string;
  readonly hit: boolean;
  /** Multiclass Brier of the model's probabilities against the confirmed answer (0 best, 2 worst). */
  readonly brier: number;
  readonly confidence: number;
  readonly confirmedBy: string;
  /** Who confirmed: a person (the default, and every record before 2026-09-23) or an agent — a second model's reading, recorded as such. */
  readonly confirmedByKind?: 'human' | 'agent';
  readonly createdAt: string;
  readonly note?: string;
  /** The judge the outcome scores (the judgment's), so calibrations are per judge. */
  readonly judge?: string;
  /** When the confirmation is another judge's judgment of the same claim: that judgment's IRI. */
  readonly confirmedFrom?: string;
}

export function scoreContentJudgment(j: Pick<ContentJudgment, 'answer' | 'probabilities'>, confirmed: string): { hit: boolean; brier: number } {
  return { hit: j.answer === confirmed, brier: choiceBrier(j.probabilities, confirmed) };
}

/** The outcome a person's confirmation makes of a judgment; the answer must be one the judgment weighed. */
export function contentJudgmentOutcome(j: ContentJudgment, judgmentIri: string, confirmed: string, by: { readonly did: string; readonly kind?: 'human' | 'agent'; readonly note?: string; readonly from?: string }, now: Date = new Date()): ContentJudgmentOutcome {
  const alternatives = Object.keys(j.probabilities);
  if (!alternatives.includes(confirmed)) throw new Error(`the confirmed answer must be one of ${alternatives.join(', ')}`);
  const { hit, brier } = scoreContentJudgment(j, confirmed);
  return {
    kind: 'content-judgment-outcome', judgmentId: j.id, judgmentIri, judgmentKind: j.judgmentKind, answer: j.answer,
    confirmedAnswer: confirmed, hit, brier, confidence: j.confidence, confirmedBy: by.did, confirmedByKind: by.kind ?? 'human', createdAt: now.toISOString(),
    ...(by.note ? { note: by.note } : {}),
    ...(j.judge ? { judge: j.judge } : {}),
    ...(by.from ? { confirmedFrom: by.from } : {}),
  };
}

export interface RecordedJudgmentInput extends ContentJudgmentInput {
  /** The judge's answer: an evidence level or a work regime. */
  readonly answer: string;
  /** The judge's distribution over the alternatives; concentrated on the answer at `confidence` when absent. */
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly confidence?: number;
  /** The model the judge used, as it names it (a System One model, a reasoning model, a person's own name). */
  readonly model: string;
  /** The judging agent's identity. */
  readonly judge: string;
}

/**
 * A judgment an agent made itself and records: the same entity the bridge's model produces,
 * with the answer, the distribution and the model the agent declares, and the agent as judge.
 * The answer must be one of the kind's alternatives; the distribution is normalised and, when
 * absent, concentrated on the answer at the declared confidence (0.8 by default) with the rest
 * spread evenly, so a Brier score means the same thing for every judge.
 */
export function recordedContentJudgment(input: RecordedJudgmentInput, now: Date = new Date()): ContentJudgment {
  if (!(CONTENT_JUDGMENT_KINDS as readonly string[]).includes(input.judgmentKind)) throw new Error(`judgment kind must be one of ${CONTENT_JUDGMENT_KINDS.join(', ')}`);
  if (input.claimText.trim().length < 8) throw new Error('the claim is too short to judge');
  const alternatives: readonly string[] = input.judgmentKind === 'evidence-level' ? EVIDENCE_LEVELS : WORK_REGIMES;
  if (!alternatives.includes(input.answer)) throw new Error(`the answer must be one of ${alternatives.join(', ')}`);
  const declared = input.confidence !== undefined ? Math.min(1, Math.max(0, input.confidence)) : 0.8;
  let probabilities: Record<string, number>;
  if (input.probabilities && Object.keys(input.probabilities).length > 0) {
    const total = alternatives.reduce((n, a) => n + Math.max(0, input.probabilities?.[a] ?? 0), 0);
    if (total <= 0) throw new Error('the probabilities must put weight on at least one alternative');
    probabilities = Object.fromEntries(alternatives.map((a) => [a, Math.max(0, input.probabilities?.[a] ?? 0) / total]));
  } else {
    const rest = alternatives.length > 1 ? (1 - declared) / (alternatives.length - 1) : 0;
    // Not rounded: four thirds of 0.2 rounded to three places sum to 1.001, and a distribution is a distribution.
    probabilities = Object.fromEntries(alternatives.map((a) => [a, a === input.answer ? declared : rest]));
  }
  const confidence = input.confidence !== undefined ? round(declared) : round(probabilities[input.answer] ?? declared);
  const id = newId();
  return {
    kind: 'content-judgment',
    id,
    graphIri: `${CONTENT_JUDGMENT_GRAPH_PREFIX}${id}`,
    createdAt: now.toISOString(),
    model: input.model,
    confidence,
    judgmentKind: input.judgmentKind,
    claimText: input.claimText,
    answer: input.answer,
    probabilities,
    ...(input.judgmentKind === 'evidence-level' ? { score: round(EVIDENCE_LEVELS.reduce((sum, l, i) => sum + i * (probabilities[l] ?? 0), 0)) } : {}),
    ...(input.courseIri ? { courseIri: input.courseIri } : {}),
    ...(input.slideId ? { slideId: input.slideId } : {}),
    ...(input.conceptIds && input.conceptIds.length > 0 ? { conceptIds: [...input.conceptIds] } : {}),
    evidenceCount: (input.evidence ?? []).length,
    usage: { requests: 0, input_tokens: 0, output_tokens: 0, latencyMs: 0 },
    judge: input.judge,
  };
}
/** The JSON a Foxxi entity graph carries as foxxi:bundleJson, or undefined when it carries none. */
export function decodeBundleJson(graphTurtle: string): unknown {
  const m = graphTurtle.match(/foxxi:bundleJson\s+"([^"]+)"\^\^xsd:base64Binary/);
  if (!m) return undefined;
  try { return JSON.parse(Buffer.from(m[1]!, 'base64').toString('utf8')); } catch { return undefined; }
}

export function isContentJudgment(v: unknown): v is ContentJudgment {
  const j = v as Partial<ContentJudgment> | null;
  return typeof j === 'object' && j !== null && j.kind === 'content-judgment' && typeof j.id === 'string' && typeof j.answer === 'string'
    && typeof j.probabilities === 'object' && j.probabilities !== null && (CONTENT_JUDGMENT_KINDS as readonly string[]).includes(String(j.judgmentKind));
}

export function isContentJudgmentOutcome(v: unknown): v is ContentJudgmentOutcome {
  const o = v as Partial<ContentJudgmentOutcome> | null;
  return typeof o === 'object' && o !== null && o.kind === 'content-judgment-outcome' && typeof o.hit === 'boolean' && typeof o.brier === 'number'
    && (CONTENT_JUDGMENT_KINDS as readonly string[]).includes(String(o.judgmentKind));
}

/** A manifest entry as the pod's discover() lists it; only the fields read here are named. */
export interface EntityEntry {
  readonly descriptorUrl?: string;
  readonly describes?: readonly string[];
  readonly graph?: string;
  readonly graphUrl?: string;
  readonly conformsTo?: readonly string[];
}

/** The entry describing an entity IRI, if the pod lists one. */
export function findEntityEntry(entries: readonly EntityEntry[], entityIri: string): EntityEntry | undefined {
  return entries.find((e) => e.graph === entityIri || (e.describes ?? []).some((d) => String(d) === entityIri));
}

/** Where an entity's graph is served: what the manifest says, else the publisher's slug convention under foxxi/judgments/. */
export function entityGraphUrl(podUrl: string, entityIri: string, entry?: EntityEntry): string | undefined {
  if (entry?.graphUrl) return entry.graphUrl;
  const m = entityIri.match(/^urn:foxxi:([a-z-]+):([A-Za-z0-9-]+)$/);
  if (!m) return undefined;
  return `${podUrl.endsWith('/') ? podUrl : `${podUrl}/`}foxxi/judgments/${m[1]}-${m[2]}-graph.trig`;
}

export interface ContentCalibrationCell extends CalibrationCellSummary {
  readonly judgmentKind: ContentJudgmentKind;
  /** How many of the samples a person confirmed, and how many an agent did: the same measurement, but a reader weighs them differently. */
  readonly humanSamples: number;
  readonly agentSamples: number;
}

export interface ContentJudgmentCalibration {
  readonly cells: readonly ContentCalibrationCell[];
  readonly samples: number;
  readonly minSamples: number;
  readonly computedAt: string;
}

/** Per question kind: how often the model had the confirmed answer, and how far off its probabilities were. */
export function contentJudgmentCalibration(outcomes: readonly ContentJudgmentOutcome[], minSamples: number = CONTENT_JUDGMENT_MIN_SAMPLES, now: Date = new Date()): ContentJudgmentCalibration {
  const cells = CONTENT_JUDGMENT_KINDS.map((judgmentKind) => {
    const ofKind = outcomes.filter((o) => o.judgmentKind === judgmentKind);
    const agentSamples = ofKind.filter((o) => o.confirmedByKind === 'agent').length;
    return { judgmentKind, ...calibrationCell(ofKind, minSamples), humanSamples: ofKind.length - agentSamples, agentSamples };
  });
  return { cells, samples: outcomes.length, minSamples, computedAt: now.toISOString() };
}
