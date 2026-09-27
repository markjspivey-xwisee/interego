/**
 * A fragment: one piece of teaching or support, the unit every composition is built from.
 *
 * A course is not stored here as a package of pages. It is a composition (compositions.ts)
 * whose positions hold fragments by reference, and each learner gets that composition resolved
 * from their own record. So a fragment is where content lives, and it is shaped for that.
 *
 * ★ ITS IDENTITY IS ITS CONTENT. The IRI is `<authority>/ns/foxxi/fragment/<sha256>`, hashed
 * over the fragment's canonical JSON with competencies named by their ids, not by this
 * deployment's URLs. So the same content is the same fragment wherever it was authored, a copy
 * fetched from any pod is checked by hashing it, and nobody can change what a learner is shown
 * under an IRI they already hold. Who published a fragment is a claim about it (an `authored`
 * statement), not part of it. A revision is a new fragment, and the evidence gathered on the old
 * one stays with the old IRI.
 *
 * ★ ONE SOURCE, TWO READERS. The body is Markdown (course-markdown.ts): an agent reads it as it
 * is, and a person reads it rendered. Questions take the xAPI interaction types
 * (course-questions.ts) and are stored with verifiers, never with answers. A fragment with a
 * graded question also carries a random blinding value (`blind`), kept with the stored form and
 * never served, that goes into every salt and commitment. So the same quiz authored twice is two
 * fragments, each with its own grading secret, while a stored form sent back keeps its IRI. A
 * fragment with nothing graded carries no such value and is the same fragment wherever it is
 * authored.
 *
 * ★ ITS PUBLIC FORM CAN BE CHECKED WITHOUT ITS VERIFIERS. The hash does not take a question as it
 * is stored: it takes the question's public view (what a learner sees) and a commitment, the hash
 * of the stored question with its salt, verifiers and explanation. So a fragment can be served to
 * anyone in its public form (publicFragment), and anyone can check that form against its IRI
 * (publicFragmentIsIntact), while the salt that would let a learner try each option against a
 * verifier stays with whoever grades. The grader checks the stored question against its
 * commitment in turn.
 *
 * ★ ITS KIND SAYS WHAT FORM IT TAKES, NOT WHEN TO USE IT. FRAGMENT_KINDS lists the forms (a
 * concept, a worked example, a job aid, a probe, …) and what each may ask. Which forms suit a
 * situation is a theory of performance, and that theory lives above this standards vertical: the
 * performance practice publishes, per intervention, the forms that deliver it, and hands
 * resolution an admission (compositions.ts). The dependency runs that way only.
 *
 * Layer: L3 vertical. `foxxi:` terms only; no protocol-ontology change.
 */
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson } from '@interego/core';
import { competencyIdOf, competencyIri, competencyIriForTerm, isCompetencyIri } from './competency-identity.js';
import { courseMarkdownHtml } from './course-markdown.js';
import { authorQuestion, questionForLearner, QuestionError } from './course-questions.js';
import type { CognitiveLevel, FragmentModality } from './emergent-content.js';
import type { ScormAssessmentQuestion } from './scorm-assessment.js';
import { COGNITIVE_LEVELS, FRAGMENT_KIND_LIST, type QuestionPolicy } from './fragment-kinds.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The naming authority that serves fragments and compositions. Env-overridable, like course and competency ids. */
export const CONTENT_ID_BASE: string =
  (process.env.FOXXI_CONTENT_ID_BASE ?? process.env.BRIDGE_DEPLOYMENT_URL ?? 'https://foxxi-bridge.interego.xwisee.com')
    .replace(/\/+$/, '');

/** Content an author sent that cannot be stored as it is; the message says what to fix. */
export class ContentError extends Error {}

export type FragmentKind = FragmentModality;

export type { QuestionPolicy } from './fragment-kinds.js';

export interface FragmentKindDefinition {
  kind: FragmentKind;
  label: string;
  questions: QuestionPolicy;
  definition: string;
}

/**
 * Every form a fragment can take, and what each may ask. The bridge publishes it as it is. The list
 * lives in fragment-kinds.ts, which imports nothing, so the dashboard's author tools offer the very
 * same one; typed here, each of its kinds must be one of this engine's.
 */
export const FRAGMENT_KINDS: readonly FragmentKindDefinition[] = FRAGMENT_KIND_LIST;

const KIND_INDEX = new Map(FRAGMENT_KINDS.map(k => [k.kind, k]));
const LEVELS: readonly CognitiveLevel[] = COGNITIVE_LEVELS;

/** The definition of a fragment kind. */
export function fragmentKind(kind: string): FragmentKindDefinition | undefined {
  return KIND_INDEX.get(kind as FragmentKind);
}

/** Size limits on a fragment. */
export const FRAGMENT_LIMITS = { body: 20_000, title: 200, questions: 40, competencies: 10, suits: 10, suit: 60, language: 35 } as const;

export interface Fragment {
  /** `<authority>/ns/foxxi/fragment/<sha256 of the content>`. */
  '@id': string;
  kind: FragmentKind;
  level: CognitiveLevel;
  /** Competency IRIs, in order of id (a set). */
  competencies: string[];
  title?: string;
  /** Markdown. */
  body: string;
  /** Stored form: verifiers, never answers. */
  questions?: ScormAssessmentQuestion[];
  /** Set when a fragment is for one kind of learner only. */
  audience?: 'human' | 'agent';
  /** Dispositions this fragment suits, as the author tags them. */
  suits?: string[];
  /** BCP 47 language tag. */
  language?: string;
  /**
   * A random 256-bit value, as hex, kept with the stored form and never served. Present when a
   * question is graded; it goes into each question's salt and commitment, so nobody holding the
   * public form can rebuild a stored question for each answer they might try and see which one's
   * commitment matches.
   */
  blind?: string;
}

const FRAGMENT_PATH = '/ns/foxxi/fragment/';
const COMPOSITION_PATH = '/ns/foxxi/composition/';

/** A fragment's IRI from its content hash. */
export function fragmentIri(hash: string): string { return `${CONTENT_ID_BASE}${FRAGMENT_PATH}${hash}`; }
/** A composition's IRI from its content hash. */
export function compositionIri(hash: string): string { return `${CONTENT_ID_BASE}${COMPOSITION_PATH}${hash}`; }

/** The content hash in a fragment or composition IRI, on any authority, or null. */
export function contentRefOf(iri: unknown): { type: 'fragment' | 'composition'; hash: string } | null {
  if (typeof iri !== 'string') return null;
  const m = /^https?:\/\/[^/?#]+\/ns\/foxxi\/(fragment|composition)\/([0-9a-f]{64})$/.exec(iri);
  return m ? { type: m[1] as 'fragment' | 'composition', hash: m[2]! } : null;
}

/** Whether two IRIs name the same content, whichever authority minted them. */
export function sameContent(a: string, b: string): boolean {
  const ra = contentRefOf(a), rb = contentRefOf(b);
  return !!ra && !!rb && ra.type === rb.type && ra.hash === rb.hash;
}

/**
 * A competency as an author may name it: a competency IRI, the IRI of a term another authority
 * publishes, or a slug such as `refund-authority`. Returns the competency IRI.
 */
export function competencyRef(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ContentError(`${what} must name a competency`);
  const v = value.trim();
  if (isCompetencyIri(v)) {
    const id = competencyIdOf(v);
    if (!id) throw new ContentError(`${what} is a competency IRI with no id`);
    return competencyIri(id);
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/.test(v) && v.length <= 500) return competencyIriForTerm(v);
  if (/^[a-z0-9][a-z0-9-]{0,80}$/i.test(v)) return competencyIri(v.toLowerCase());
  throw new ContentError(`${what} must be a competency IRI, a term IRI, or a slug such as refund-authority`);
}

/** The id a competency IRI stands for, so a content hash does not depend on this deployment's host. */
function competencyKey(iri: string): string {
  return competencyIdOf(iri) ?? iri;
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ContentError(`${what} must be a non-empty string`);
  if (value.length > max) throw new ContentError(`${what} is longer than ${max} characters`);
  return value;
}

/**
 * A question's commitment: the hash of its stored form (salt, verifiers and explanation included)
 * and the fragment's blinding value when it has one. Without that value, a graded question with a
 * few options would be an oracle: its salt comes from public fields, so the stored form for each
 * answer could be rebuilt and hashed until one matched.
 */
export function questionCommitment(q: ScormAssessmentQuestion, blind?: string): string {
  return sha256(canonicalJson(blind ? { blind, question: q } : q));
}

/** What anyone may see of a question: its words, its type, what to choose from, whether it is graded, and its commitment. */
export interface PublicQuestion {
  question: string;
  type: string;
  input?: ScormAssessmentQuestion['input'];
  graded: boolean;
  commitment: string;
}

/** A fragment in the form anyone may be served: each question as its public view and commitment. */
export interface PublicFragment extends Omit<Fragment, 'questions' | 'blind'> {
  questions?: PublicQuestion[];
}

function publicQuestion(q: ScormAssessmentQuestion, blind: string | undefined): PublicQuestion {
  const { index: _index, ...view } = questionForLearner(q, 0);
  return { ...view, commitment: questionCommitment(q, blind) };
}

function toPublic(content: Omit<Fragment, '@id'>): Omit<PublicFragment, '@id'> {
  const { questions, blind, ...rest } = content;
  return { ...rest, ...(questions?.length ? { questions: questions.map(q => publicQuestion(q, blind)) } : {}) };
}

/** What a fragment's hash is taken over: its public form, with competencies by id. */
function hashedForm(f: Omit<PublicFragment, '@id'>): Record<string, unknown> {
  return { ...f, competencies: f.competencies.map(competencyKey) };
}

/**
 * A fragment from what an author sent: checked, its competencies normalized, its questions
 * turned into their stored form, and its IRI computed from the result.
 *
 * Sent: `{ kind, level?, competencies (or competency), title?, body, questions?, audience?,
 * suits?, language? }`. Questions are written as course-questions.ts takes them; a question
 * already in stored form is kept as it is.
 */
export function fragmentFrom(raw: unknown): Fragment {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ContentError('a fragment must be an object');
  const r = raw as Record<string, unknown>;
  const def = typeof r.kind === 'string' ? fragmentKind(r.kind) : undefined;
  if (!def) throw new ContentError(`kind must be one of ${FRAGMENT_KINDS.map(k => k.kind).join(', ')}`);
  const level = r.level === undefined ? 'working' : r.level;
  if (!LEVELS.includes(level as CognitiveLevel)) throw new ContentError(`level must be one of ${LEVELS.join(', ')}`);
  const named = r.competencies !== undefined ? r.competencies : r.competency !== undefined ? [r.competency] : undefined;
  if (!Array.isArray(named) || named.length === 0) throw new ContentError('a fragment names the competencies it develops: competencies: [ … ]');
  if (named.length > FRAGMENT_LIMITS.competencies) throw new ContentError(`a fragment names at most ${FRAGMENT_LIMITS.competencies} competencies`);
  const competencies = [...new Map(named.map((c, i) => {
    const iri = competencyRef(c, `competencies[${i}]`);
    return [competencyKey(iri), iri] as const;
  })).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, iri]) => iri);
  const body = text(r.body, 'body', FRAGMENT_LIMITS.body);
  const title = r.title === undefined ? undefined : text(r.title, 'title', FRAGMENT_LIMITS.title).trim();
  if (r.audience !== undefined && r.audience !== 'human' && r.audience !== 'agent') throw new ContentError('audience is human or agent; leave it out for both');
  const audience = r.audience as 'human' | 'agent' | undefined;
  let suits: string[] | undefined;
  if (r.suits !== undefined) {
    if (!Array.isArray(r.suits) || r.suits.length > FRAGMENT_LIMITS.suits) throw new ContentError(`suits is a list of at most ${FRAGMENT_LIMITS.suits} tags`);
    suits = [...new Set(r.suits.map((s, i) => text(s, `suits[${i}]`, FRAGMENT_LIMITS.suit).trim()))].sort();
    if (!suits.length) suits = undefined;
  }
  const language = r.language === undefined ? undefined : text(r.language, 'language', FRAGMENT_LIMITS.language).trim();
  if (language !== undefined && !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(language)) throw new ContentError('language must be a BCP 47 tag such as en or pt-BR');

  // Questions: salted from the fragment's content and a random blinding value, so neither a salt
  // nor a commitment can be rebuilt from the public form. A stored form sent back carries its
  // value, and so keeps its IRI. A fragment with no graded question keeps no value at all, and is
  // the same fragment wherever it is authored.
  const asked = r.questions === undefined ? [] : r.questions;
  if (!Array.isArray(asked)) throw new ContentError('questions must be an array');
  if (asked.length > FRAGMENT_LIMITS.questions) throw new ContentError(`a fragment has at most ${FRAGMENT_LIMITS.questions} questions`);
  if (r.blind !== undefined && (typeof r.blind !== 'string' || !/^[0-9a-f]{64}$/.test(r.blind))) throw new ContentError('blind is the 64 hex characters a stored fragment carries');
  const blind = (r.blind as string | undefined) ?? randomBytes(32).toString('hex');
  const seed = sha256(canonicalJson({ kind: def.kind, level, competencies: competencies.map(competencyKey), title, body, blind }));
  const questions = asked.map((q, i) => {
    try { return authorQuestion(q, `${seed}\n${i}`); }
    catch (e) { throw e instanceof QuestionError ? new ContentError(`question ${i + 1}: ${e.message}`) : e; }
  });
  if (def.questions === 'required' && !questions.some(q => q.answerHash)) {
    throw new ContentError(`a ${def.kind} measures, so it needs at least one graded question`);
  }
  if (def.questions === 'ungraded-only') {
    const graded = questions.findIndex(q => q.answerHash);
    if (graded >= 0) throw new ContentError(`question ${graded + 1}: a ${def.kind} is not graded; record what happened with likert or long-fill-in questions`);
  }

  const content: Omit<Fragment, '@id'> = {
    kind: def.kind, level: level as CognitiveLevel, competencies, body,
    ...(title ? { title } : {}),
    ...(questions.length ? { questions } : {}),
    ...(audience ? { audience } : {}),
    ...(suits ? { suits } : {}),
    ...(language ? { language } : {}),
    ...(questions.some(q => q.answerHash) ? { blind } : {}),
  };
  return { '@id': fragmentIri(sha256(canonicalJson(hashedForm(toPublic(content))))), ...content };
}

/**
 * Whether a fragment in its stored form is what its IRI says it is. Anything read back from a pod,
 * a cache or another bridge is checked with this before it is used.
 */
export function fragmentIsIntact(f: Fragment): boolean {
  const ref = contentRefOf(f['@id']);
  if (!ref || ref.type !== 'fragment') return false;
  const { '@id': _id, ...content } = f;
  return sha256(canonicalJson(hashedForm(toPublic(content)))) === ref.hash;
}

/** A fragment in the form anyone may be served: no salt, verifier or explanation, and still checkable against its IRI. */
export function publicFragment(f: Fragment): PublicFragment {
  const { '@id': id, ...content } = f;
  return { '@id': id, ...toPublic(content) };
}

/** Whether a fragment in its public form is what its IRI says it is. */
export function publicFragmentIsIntact(p: PublicFragment): boolean {
  const ref = contentRefOf(p?.['@id']);
  if (!ref || ref.type !== 'fragment' || !Array.isArray(p.competencies)) return false;
  if (p.questions !== undefined && (!Array.isArray(p.questions) || p.questions.some(q => typeof q?.commitment !== 'string'))) return false;
  const { '@id': _id, ...content } = p;
  return sha256(canonicalJson(hashedForm(content))) === ref.hash;
}

/** A fragment as a learner (a person or an agent) receives it: its public form, the Markdown rendered, and each question numbered. */
export function fragmentForLearner(f: Fragment): Record<string, unknown> {
  const p = publicFragment(f);
  return {
    ...p,
    bodyHtml: courseMarkdownHtml(f.body),
    ...(p.questions?.length ? { questions: p.questions.map((q, i) => ({ index: i, ...q })) } : {}),
  };
}
