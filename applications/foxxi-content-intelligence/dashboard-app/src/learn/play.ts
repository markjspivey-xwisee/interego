/**
 * A composition played step by step, as foxxi.content_launch and foxxi.content_next answer: the
 * shapes the portal reads, and the few things it says about them. The bridge resolves, grades and
 * records; the portal shows what it was given and sends back what the learner put.
 */
import type { LearnerQuestion } from './answers.js';

/** A fragment as a step serves it (fragmentForLearner): its public form, questions numbered. */
export interface LearnerFragment {
  '@id': string;
  kind: string;
  level: string;
  competencies: string[];
  title?: string;
  /** Markdown, rendered here by the engine's own safe renderer. */
  body: string;
  questions?: LearnerQuestion[];
  audience?: 'human' | 'agent';
  suits?: string[];
  language?: string;
}

/** One step of a play: where it is, what it develops, why it was chosen, and the fragment. */
export interface StepView {
  step: number;
  of: number;
  competency: string;
  chosenBecause: string;
  /** Brought in by a missed check: another way in, or the check after it. */
  wayIn?: 'teaching' | 'check';
  fragment: LearnerFragment;
}

export interface PositionNote { competency: string; path: string[]; position: number; because: string }

/** What resolution said beside the steps. */
export interface ResolutionNotes {
  skipped?: PositionNote[];
  unmet?: PositionNote[];
  refused?: string[];
  trace?: string[];
  missing?: string[];
}

export type Launched = ResolutionNotes & {
  ok: true;
  composition: string;
  learnerKind: 'human' | 'agent';
} & (
  | { sessionId: string; registration: string; title: string; step: StepView; done?: undefined }
  | { done: true; nothingToPlay: true }
);

export interface Graded {
  correct: number;
  total: number;
  detail: Array<{ question: string; correct: boolean | null; explanation?: string }>;
}

export interface Stepped {
  ok: true;
  sessionId: string;
  done: boolean;
  keptEarlierAnswers?: true;
  graded?: Graded;
  summary?: { steps: number; graded: { correct: number; total: number } };
  step?: StepView;
}

/** A composition as its IRI dereferences: it holds no secret, so anyone may read it. */
export interface CompositionView {
  '@id': string;
  title: string;
  competency: string;
  positions: Array<{ competency: string; paradigm: string[] }>;
  description?: string;
}

/** What a step brought in by a missed check is called. */
export function wayInLabel(wayIn: StepView['wayIn']): string | undefined {
  return wayIn === 'teaching' ? 'Another way in' : wayIn === 'check' ? 'Another check' : undefined;
}

/** A competency IRI as a person reads it: the id it names. */
export function competencyLabel(iri: string): string {
  const id = /\/ns\/foxxi\/competency\/([^/?#]+)$/.exec(iri)?.[1] ?? /^urn:foxxi:competency:(.+)$/.exec(iri)?.[1];
  if (id) { try { return decodeURIComponent(id); } catch { return id; } }
  return iri.replace(/^.*[/#:]/, '') || iri;
}

/** Why a launch had nothing to play for this learner, in sentences. */
export function nothingToPlayBecause(notes: ResolutionNotes): string[] {
  const out: string[] = [];
  const skipped = notes.skipped?.length ?? 0;
  if (skipped) out.push(skipped === 1 ? 'One position was skipped: your record already shows what it teaches.' : `${skipped} positions were skipped: your record already shows what they teach.`);
  for (const u of notes.unmet ?? []) out.push(`Nothing it offers for ${competencyLabel(u.competency)} could be given to you: ${u.because}`);
  if (notes.missing?.length) out.push(`${notes.missing.length} of its pieces could not be reached on this bridge.`);
  if (notes.refused?.length) out.push(`${notes.refused.length} of its pieces did not match what their names promise, and were refused.`);
  if (!out.length) out.push('It resolved to no steps for you.');
  return out;
}

/** A score as a person reads it. */
export function scoreLine(g: { correct: number; total: number }): string {
  return g.total ? `${g.correct} of ${g.total} right` : 'Nothing here was graded';
}

/** A composition its caller made, as foxxi.content_mine lists it. */
export interface AuthoredComposition { iri: string; title?: string; at?: string; root?: true }
/** A composition its caller played, as foxxi.content_mine lists it. */
export interface PlayedComposition { iri: string; title?: string; at: string; finished: boolean; score?: { raw: number; max: number } }
export interface Mine { ok: true; authored: AuthoredComposition[]; played: PlayedComposition[] }
