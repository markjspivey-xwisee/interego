/**
 * Foxxi course Q&A — grounded retrieval over a course's transcripts +
 * extracted concepts.
 *
 * Honest substrate composition: wraps the Foxxi-parsed course content
 * as a UserWallet shape for the existing groundedAnswer machinery from
 * applications/learner-performer-companion/src/grounded-answer.ts.
 *
 * The promise this delivers is the actual user-facing claim of the
 * vertical: a learner enrolled in a course by their L&D admin can
 * ask "what is reactive current?" and get a verbatim-cited answer
 * drawn from the course's narration transcripts + extracted concepts.
 * Honest no-match returns null — never confabulates.
 *
 * The same honesty discipline as LPC's grounded-answer:
 *   - Cite verbatim — quote the actual transcript segment / concept label
 *   - Cite by IRI — caller can click through to the source descriptor
 *   - Content-hash verify — tampered atoms refuse to cite
 *   - Honest no-match — if no atom overlaps the question, return null
 */

import { createHash } from 'node:crypto';
import {
  groundedAnswer,
  type CitedAnswer,
  type GroundingAtom,
  type UserWallet,
  type TrainingContentRecord,
} from '../../learner-performer-companion/src/grounded-answer.js';
import type { IRI } from '../../../src/index.js';

// ─────────────────────────────────────────────────────────────────────
//  Foxxi course-content shape (what the parser emits + the wallet wants)
// ─────────────────────────────────────────────────────────────────────

export interface FoxxiCourseContent {
  /** Course IRI (federation_iri_base#package — matches publisher.ts). */
  readonly courseIri: IRI;
  /** Display title (e.g., "Lesson 3: Inverter Controls"). */
  readonly title: string;
  /** Authoritative source DID. */
  readonly authoritativeSource: IRI;
  /**
   * Per-audio-file transcripts, indexed by audio resource path (the
   * shape `imported/transcripts.json` ships). Used as grounding atoms.
   */
  readonly transcripts: Readonly<Record<string, { duration: number; language: string; text: string }>>;
  /**
   * Extracted concepts — used as supplementary grounding atoms so
   * concept-shaped questions ("what is X?") can resolve even when the
   * exact phrase isn't in any transcript.
   */
  readonly concepts: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly confidence: number;
    readonly tier: number;
    readonly taught_in_slides?: readonly string[];
  }>;
}

// ─────────────────────────────────────────────────────────────────────
//  Wallet adapter
// ─────────────────────────────────────────────────────────────────────

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Wrap a FoxxiCourseContent as a TrainingContentRecord (per
 * grounded-answer's UserWallet shape). Each transcript segment becomes
 * a grounding atom; each tier-1 / tier-2 concept becomes a concept
 * atom too (concept label + bag of slides it appears in).
 */
export function courseContentAsTrainingRecord(course: FoxxiCourseContent): TrainingContentRecord {
  const atoms: GroundingAtom[] = [];

  // Transcript atoms (the actual narration content — primary grounding).
  for (const [audioPath, t] of Object.entries(course.transcripts)) {
    const value = t.text.trim();
    if (!value) continue;
    const contentHash = sha256Hex(value);
    const iri = `${course.courseIri}#transcript:${encodeURIComponent(audioPath)}` as IRI;
    atoms.push({ iri, value, contentHash });
  }

  // Concept atoms (label + tier-1/2 only; tier-3 are noisy single-occurrences).
  for (const c of course.concepts) {
    if (c.tier > 2) continue;
    const value = `Concept: ${c.label}${c.taught_in_slides && c.taught_in_slides.length > 0
      ? ` (taught in ${c.taught_in_slides.length} slide${c.taught_in_slides.length === 1 ? '' : 's'})`
      : ''}`;
    const contentHash = sha256Hex(value);
    const iri = `${course.courseIri}#concept:${c.id}` as IRI;
    atoms.push({ iri, value, contentHash });
  }

  return {
    iri: course.courseIri,
    name: course.title,
    authoritativeSource: course.authoritativeSource,
    atoms,
  };
}

/**
 * Build a UserWallet containing a single Foxxi course's content. The
 * learner DID is the wallet owner; the course is the only training
 * content in the wallet. Credentials / performance records / learning
 * experiences are empty (this is a content Q&A, not a wallet Q&A).
 */
export function walletForCourse(args: {
  learnerDid: IRI;
  course: FoxxiCourseContent;
}): UserWallet {
  return {
    userDid: args.learnerDid,
    trainingContent: [courseContentAsTrainingRecord(args.course)],
    credentials: [],
    performanceRecords: [],
    learningExperiences: [],
  };
}

// ─────────────────────────────────────────────────────────────────────
//  The actual ask function
// ─────────────────────────────────────────────────────────────────────

export interface AskCourseQuestionArgs {
  readonly learnerDid: IRI;
  readonly course: FoxxiCourseContent;
  readonly question: string;
}

export interface AskCourseQuestionResult {
  /** True iff at least one citation was found above the overlap threshold. */
  readonly grounded: boolean;
  /** Cited answer (verbatim transcript / concept snippets) when grounded; null when no overlap. */
  readonly answer: CitedAnswer | null;
}

/**
 * Ask a question about the course. Returns a grounded answer (with
 * verbatim transcript citations + IRIs) when the question overlaps
 * any grounding atom; honest null when no overlap.
 *
 * The substrate composition: this delegates entirely to LPC's
 * groundedAnswer, with the Foxxi course content wrapped as a wallet.
 * That gives:
 *   - the same honesty discipline (no confabulation)
 *   - the same content-hash tamper detection
 *   - the same atom-IRI citation shape (auditor can click through)
 *   - the same minimum overlap threshold (MIN_OVERLAP_SCORE)
 *
 * No re-implementation; pure composition.
 */
export function askCourseQuestion(args: AskCourseQuestionArgs): AskCourseQuestionResult {
  const wallet = walletForCourse({ learnerDid: args.learnerDid, course: args.course });
  const answer = groundedAnswer(args.question, wallet);
  return { grounded: answer !== null, answer };
}
