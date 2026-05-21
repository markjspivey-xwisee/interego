/**
 * Foxxi Context Companion — chat over a user's networked context.
 *
 * The whole point of Interego is that a user's context is networked: one
 * substrate holds their assigned courses, the content those courses are
 * composed from, the job aids, and their xAPI activity. So a user —
 * human OR agent — should never have to know which surface to call. They
 * should be able to just ask:
 *
 *   "do I have any courses assigned to me?"   → the assignment surface
 *   "what does this concept mean?"            → the content
 *   "how do I handle X?"                      → the content + job aids
 *   "what's my progress?"                     → the live LRS
 *
 * This module is that single front door — `POST /content/ask`. It does
 * NOT reinvent retrieval. It is composition glue:
 *
 *   · intent classification routes the question to a surface;
 *   · the networked context is assembled from the substrate's own
 *     surfaces — the published-course registry, the job-aid registry,
 *     the live LRS, and (when the pod is seeded) the enrollment surface;
 *   · content questions delegate to the vertical's existing **agentic
 *     RAG** (`agentic-rag.ts`) — concept-graph retrieval + prereq-edge
 *     expansion + LLM synthesis + the modal-statused Interego trace.
 *     With an LLM key (the bridge's `FOXXI_LLM_API_KEY`, or per-request
 *     BYOK) the answer is synthesised; without one it falls back to
 *     `retrieveCourseContext` — the retrieval scaffold the *calling
 *     agent's own subscription* synthesises from. Either way the answer
 *     is sourced: cited slides carry the descriptor id + provenance.
 *
 * The answer is the same whether a human or an agent asks — the asker's
 * kind is recorded, not branched on.
 *
 * Layer: L3 vertical. Composes the substrate + the existing Foxxi
 * modules (agentic-rag, content-delivery, the LRS); no L1/L2/L3
 * ontology change.
 */

import type { Express, Request, Response } from 'express';
import type { IRI } from '@interego/core';
import { tenantIdOf, type TenantId } from './tenant-context.js';
import { _publishedCourses, _publishedJobAids } from './content-delivery.js';
import { listStoredStatements } from './xapi-lrs.js';
import { flattenCourse } from './content-package.js';
import type { Course } from './emergent-content.js';
import {
  askAgenticRag, retrieveCourseContext, buildGraphContext,
  type FoxxiAgenticCourse, type RetrievalContext, type AgentTraceDescriptor, type LlmKeySource,
} from './agentic-rag.js';

const INTERACTED = 'http://adlnet.gov/expapi/verbs/interacted';

// ─────────────────────────────────────────────────────────────────────
//  Public shapes
// ─────────────────────────────────────────────────────────────────────

export type AskerKind = 'human' | 'agent';

/** What the question is asking for — drives which surface answers it. */
export type ContextIntent =
  | 'assignments'  // "do I have any courses assigned to me?"
  | 'progress'     // "what's my progress?" / "have I completed X?"
  | 'concept'      // "what does X mean?" / "explain X"
  | 'procedure'    // "how do I X?"
  | 'catalog'      // "what courses are available?"
  | 'general';     // any other content question

/** One cited source backing an answer — auditable, click-through-able. */
export interface GroundedSource {
  kind: 'course-fragment' | 'job-aid' | 'assignment' | 'progress' | 'course';
  /** The descriptor id the answer is drawn from. */
  id: string;
  /** Readable provenance: course › lesson, or the course title. */
  locator: string;
  /** The verbatim excerpt the answer cites. */
  excerpt: string;
}

export interface ContextAnswer {
  intent: ContextIntent;
  question: string;
  asker: { id: string; kind: AskerKind };
  /** The conversational answer. */
  answer: string;
  /** True iff the answer is backed by ≥1 source. An honest no-match is false. */
  grounded: boolean;
  sources: GroundedSource[];
  /** Follow-up prompts / topics actually present in the networked context. */
  suggestions: string[];
  /** For content answers — which LLM (or none) synthesised it. */
  llm?: { model: string; keySource: LlmKeySource };
  /** For content answers — the agentic-RAG modal-statused Interego trace. */
  trace?: readonly AgentTraceDescriptor[];
}

// ── The networked context — what the substrate knows about this user ──

export interface ContextEnrollment {
  courseId: string;
  courseTitle: string;
  status: 'pending' | 'completed' | 'overdue' | 'in-progress' | 'available';
  requirementType?: 'required' | 'recommended';
  dueAt?: string;
  /** Where the enrollment came from — a pushed policy, or engagement. */
  source: 'policy' | 'lms-engagement';
}
export interface ContextActivity {
  verb: string;
  objectName: string;
  objectId: string;
  timestamp?: string;
}
export interface NetworkedContext {
  learner: string;
  /** Published courses, as agentic-RAG course graphs (the shape the
   *  vertical's existing retrieval consumes). */
  courses: FoxxiAgenticCourse[];
  /** Job aids, each as a one-slide agentic-RAG course graph — so content
   *  retrieval federates over courses + job aids uniformly. */
  jobAids: FoxxiAgenticCourse[];
  enrollments: ContextEnrollment[];
  activity: ContextActivity[];
}

// ─────────────────────────────────────────────────────────────────────
//  Intent classification — deterministic, keyword-routed
// ─────────────────────────────────────────────────────────────────────

const INTENT_PATTERNS: Array<{ intent: ContextIntent; re: RegExp }> = [
  { intent: 'progress', re: /\b(my progress|progress|have i (completed|finished|passed|done)|did i (pass|complete|finish)|am i (done|finished)|how (am i doing|far am i)|completion status|my (score|record|results?|history))\b/ },
  { intent: 'assignments', re: /\b(assigned|enrolled|enrol|my courses|courses (for|assigned) (to )?me|courses do i|courses i (have|need)|what (training|courses)[\s\w]{0,24}(do i|i have|i need|assigned)|due|overdue|required (training|courses?))\b/ },
  { intent: 'catalog', re: /\b(catalog|catalogue|what courses (are|exist)|courses (are )?(available|there)|what can i (learn|take|study)|list[\s\w]{0,12}courses|browse)\b/ },
  { intent: 'procedure', re: /\b(how (do|can|should) i|how to|what (do|should) i do|steps (to|for)|procedure|walk me through)\b/ },
  { intent: 'concept', re: /\b(what (is|are|does)|what[\s\w]{0,10}mean|explain|define|definition|tell me about|meaning of|describe)\b/ },
];

/** Classify a question's intent. Deterministic — first pattern wins. */
export function classifyContextIntent(question: string): ContextIntent {
  const q = question.toLowerCase();
  for (const { intent, re } of INTENT_PATTERNS) if (re.test(q)) return intent;
  return 'general';
}

/** True iff this intent is a content question (answered by agentic RAG). */
function isContentIntent(intent: ContextIntent): boolean {
  return intent === 'concept' || intent === 'procedure' || intent === 'general';
}

// ─────────────────────────────────────────────────────────────────────
//  Adapters — the substrate's content shapes → the agentic-RAG shape
// ─────────────────────────────────────────────────────────────────────

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'x';
}
const conceptId = (competencyPoint: string): string => `urn:foxxi:concept:${slug(competencyPoint)}`;

/**
 * Adapt an emergent `Course` into the `FoxxiAgenticCourse` shape the
 * vertical's agentic RAG already consumes — each lesson becomes a slide
 * (its fragment bodies the transcript), each distinct competency point a
 * free-standing concept. This is the third such adapter, alongside
 * `payloadToAgenticCourse` + `courseContentToAgenticCourse`: same target
 * shape, a different source — composition, not reinvention.
 */
function emergentCourseToAgenticCourse(course: Course): FoxxiAgenticCourse {
  const flat = flattenCourse(course);
  const slides = flat.map((fl, i) => ({
    id: fl.lesson.id,
    title: fl.lesson.title,
    sequence_index: i,
    concept_ids: [...new Set(fl.fragments.map(f => conceptId(f.competencyPoint)))],
    transcript_combined: fl.fragments.map(f => `[${f.modality}] ${f.body}`).join('\n\n'),
  }));
  const cpLabels = new Map<string, string>();
  const cpSlides = new Map<string, string[]>();
  for (const fl of flat) {
    for (const f of fl.fragments) {
      const cid = conceptId(f.competencyPoint);
      cpLabels.set(cid, f.competencyPoint);
      const arr = cpSlides.get(cid) ?? [];
      if (!arr.includes(fl.lesson.id)) arr.push(fl.lesson.id);
      cpSlides.set(cid, arr);
    }
  }
  const concepts = [...cpLabels.entries()].map(([cid, label]) => ({
    id: cid, label, confidence: 1, tier: 1, is_free_standing: true,
    taught_in_slides: cpSlides.get(cid) ?? [],
  }));
  return {
    courseIri: course.id as IRI,
    title: course.title,
    courseLabel: course.title,
    courseId: course.id,
    authoritativeSource: `${course.authoredBy.kind}:${course.authoredBy.id}` as IRI,
    concepts,
    slides,
    modifier_pairs: [],
    prereq_edges: [],
  };
}

/** Adapt a published job aid into a one-slide agentic-RAG course graph. */
function jobAidToAgenticCourse(aid: { id: string; competencyPoint: string; triggerContext: string; body: string }): FoxxiAgenticCourse {
  const cid = conceptId(aid.competencyPoint);
  return {
    courseIri: aid.id as IRI,
    title: `Job aid — ${aid.competencyPoint}`,
    courseLabel: 'Job aid',
    courseId: aid.id,
    authoritativeSource: 'did:web:foxxi' as IRI,
    concepts: [{ id: cid, label: aid.competencyPoint, confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: [aid.id] }],
    slides: [{
      id: aid.id,
      title: `Job aid — ${aid.competencyPoint}`,
      sequence_index: 0,
      concept_ids: [cid],
      transcript_combined: `When ${aid.triggerContext}: ${aid.body}`,
    }],
    modifier_pairs: [],
    prereq_edges: [],
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Answer composition
// ─────────────────────────────────────────────────────────────────────

/** "1 course" / "3 courses" / "1 is" / "2 are" — count + pluralised noun. */
const plural = (n: number, s: string, p = `${s}s`): string => `${n} ${n === 1 ? s : p}`;

/** Map the agentic-RAG cited slides into the companion's source shape. */
function citedSlidesToSources(retrieval: RetrievalContext): GroundedSource[] {
  return retrieval.citedSlides.map(cs => ({
    kind: cs.course.courseId.startsWith('aid-') ? 'job-aid' as const : 'course-fragment' as const,
    id: cs.slideId,
    locator: `${cs.course.title} › ${cs.slideTitle}`,
    excerpt: cs.transcriptCombined,
  }));
}

/** The retrieval scaffold, rendered for an agent to synthesise from. */
function scaffold(retrieval: RetrievalContext): string {
  const blocks = retrieval.citedSlides.map(cs =>
    `• ${cs.course.title} › ${cs.slideTitle}\n  "${cs.transcriptCombined}"`).join('\n\n');
  return `From your content (sourced excerpts — synthesise your answer from these):\n\n${blocks}`;
}

function honestNoMatch(question: string, content: FoxxiAgenticCourse[]): string {
  const topic = question.trim().replace(/[?.!]+$/, '');
  const covered = [...new Set(content.flatMap(c => c.concepts.map(x => x.label)))];
  const hint = covered.length > 0
    ? ` What your content does cover: ${covered.slice(0, 6).join('; ')}.`
    : ` There is no published content in your context yet.`;
  return `I couldn't find anything in your content about "${topic}". `
    + `Nothing in the published courses or job aids covers it — so I won't guess.${hint}`;
}

interface LlmConfig { apiKey?: string; model?: string; keySource: LlmKeySource }

/**
 * Answer a content question by delegating to the vertical's existing
 * agentic RAG. With an LLM key the answer is synthesised; without one it
 * is the retrieval scaffold the calling agent synthesises from itself.
 */
async function answerContent(
  question: string, askerId: string, ctx: NetworkedContext, llm: LlmConfig,
): Promise<Pick<ContextAnswer, 'answer' | 'grounded' | 'sources' | 'llm' | 'trace'>> {
  const all = [...ctx.courses, ...ctx.jobAids];
  if (all.length === 0) {
    return { answer: honestNoMatch(question, all), grounded: false, sources: [] };
  }
  const primary = all[0]!;
  const federation = all.slice(1);

  // Honest no-match — short-circuit before spending an LLM call when no
  // concept in the networked context matches the question.
  const probe = buildGraphContext({ question, primary, federation });
  if (probe.seedConcepts.length === 0) {
    return { answer: honestNoMatch(question, all), grounded: false, sources: [] };
  }

  const result = llm.apiKey
    ? await askAgenticRag({
        question, learnerDid: askerId as IRI, primary, federation,
        llmApiKey: llm.apiKey, ...(llm.model ? { llmModel: llm.model } : {}), llmKeySource: llm.keySource,
      })
    : retrieveCourseContext({ question, learnerDid: askerId as IRI, primary, federation });

  const synthesised = result.synthesizedAnswer && !result.synthesizedAnswer.startsWith('(LLM call failed')
    ? result.synthesizedAnswer
    : null;
  return {
    answer: synthesised ?? scaffold(result.retrieval),
    grounded: true,
    sources: citedSlidesToSources(result.retrieval),
    llm: { model: result.llmModel, keySource: result.llmKeySource },
    trace: result.trace,
  };
}

function answerAssignments(ctx: NetworkedContext): Pick<ContextAnswer, 'answer' | 'grounded' | 'sources' | 'suggestions'> {
  const assigned = ctx.enrollments.filter(e => e.status !== 'available');
  const available = ctx.enrollments.filter(e => e.status === 'available');
  const sources: GroundedSource[] = ctx.enrollments.map(e => ({
    kind: 'assignment',
    id: e.courseId,
    locator: e.courseTitle,
    excerpt: `${e.requirementType ?? 'available'} · ${e.status}`
      + (e.dueAt ? ` · due ${e.dueAt}` : '') + ` · via ${e.source}`,
  }));

  if (assigned.length === 0) {
    const more = available.length > 0
      ? ` ${plural(available.length, 'course')} ${available.length === 1 ? 'is' : 'are'} `
        + `available you could start: ${available.map(c => c.courseTitle).join('; ')}.`
      : ` There is no published course in your context yet.`;
    return {
      answer: `You don't have any courses assigned to you right now.${more}`,
      grounded: false, sources,
      suggestions: available.map(c => `Start "${c.courseTitle}"`),
    };
  }

  const line = (e: ContextEnrollment): string =>
    `• ${e.courseTitle} — ${e.requirementType ?? 'available'}`
    + (e.dueAt ? `, due ${e.dueAt}` : '')
    + ` — ${e.status === 'completed' ? 'completed' : e.status === 'overdue' ? 'OVERDUE' : e.status === 'in-progress' ? 'in progress' : 'not started'}`;
  const required = assigned.filter(e => e.requirementType === 'required');
  const overdue = assigned.filter(e => e.status === 'overdue');
  const done = assigned.filter(e => e.status === 'completed');
  let summary = `You have ${plural(assigned.length, 'course')} in your learning:`;
  if (overdue.length > 0) summary += ` ${plural(overdue.length, 'is', 'are')} overdue.`;
  else if (required.length > 0) summary += ` ${plural(required.length, 'is', 'are')} required.`;
  if (done.length > 0) summary += ` You've completed ${done.length}.`;
  return {
    answer: `${summary}\n\n${assigned.map(line).join('\n')}`,
    grounded: true, sources,
    suggestions: assigned.filter(e => e.status !== 'completed').map(e => `Resume "${e.courseTitle}"`),
  };
}

function answerProgress(ctx: NetworkedContext): Pick<ContextAnswer, 'answer' | 'grounded' | 'sources'> {
  const completed = ctx.enrollments.filter(e => e.status === 'completed');
  if (ctx.activity.length === 0 && completed.length === 0) {
    return {
      answer: `I don't see any completed or in-progress training for you yet. `
        + `Once you launch a course, every step you take is recorded in your learning record — ask me again then.`,
      grounded: false, sources: [],
    };
  }
  const verbCounts = new Map<string, number>();
  for (const a of ctx.activity) verbCounts.set(a.verb, (verbCounts.get(a.verb) ?? 0) + 1);
  const verbSummary = [...verbCounts.entries()].map(([v, n]) => `${n}× ${v}`).join(', ');
  const recent = ctx.activity.slice(-5).reverse();
  const lead = completed.length > 0
    ? `You've completed ${plural(completed.length, 'course')} (${completed.map(c => c.courseTitle).join('; ')}). `
    : `You have training in progress. `;
  const body = recent.map(a =>
    `• ${a.verb} — ${a.objectName}${a.timestamp ? ` (${a.timestamp.slice(0, 10)})` : ''}`).join('\n');
  return {
    answer: `${lead}Your learning record holds ${plural(ctx.activity.length, 'statement')}`
      + `${verbSummary ? ` (${verbSummary})` : ''}. Most recent:\n\n${body}`,
    grounded: true,
    sources: recent.map(a => ({
      kind: 'progress' as const,
      id: a.objectId,
      locator: a.objectName,
      excerpt: `${a.verb}${a.timestamp ? ` on ${a.timestamp.slice(0, 10)}` : ''}`,
    })),
  };
}

function answerCatalog(ctx: NetworkedContext): Pick<ContextAnswer, 'answer' | 'grounded' | 'sources'> {
  if (ctx.courses.length === 0 && ctx.jobAids.length === 0) {
    return { answer: `There is no published content in your context yet.`, grounded: false, sources: [] };
  }
  const courseLines = ctx.courses.map(c =>
    `• ${c.title} — ${plural(c.slides.length, 'lesson')}`
    + (c.concepts.length > 0 ? `, covers: ${c.concepts.slice(0, 4).map(x => x.label).join('; ')}` : '')).join('\n');
  const aidNote = ctx.jobAids.length > 0
    ? `\n\nThere ${ctx.jobAids.length === 1 ? 'is' : 'are'} also ${plural(ctx.jobAids.length, 'job aid')} `
      + `for in-the-flow support: ${ctx.jobAids.map(a => a.concepts[0]?.label ?? a.title).join('; ')}.`
    : '';
  return {
    answer: `There ${ctx.courses.length === 1 ? 'is' : 'are'} ${plural(ctx.courses.length, 'course')} available:\n\n${courseLines}${aidNote}`,
    grounded: ctx.courses.length > 0 || ctx.jobAids.length > 0,
    sources: ctx.courses.map(c => ({
      kind: 'course' as const, id: c.courseId, locator: c.title,
      excerpt: `${c.slides.length} lesson(s); covers ${c.concepts.map(x => x.label).join(', ') || 'n/a'}`,
    })),
  };
}

/** Topics genuinely present in the networked context — for follow-ups. */
function contextSuggestions(ctx: NetworkedContext): string[] {
  const out: string[] = [];
  const cps = [...new Set(ctx.courses.flatMap(c => c.concepts.map(x => x.label)))];
  for (const cp of cps.slice(0, 3)) out.push(`What does "${cp}" mean?`);
  for (const aid of ctx.jobAids.slice(0, 1)) out.push(`How do I handle ${aid.concepts[0]?.label ?? 'this'}?`);
  out.push('Do I have any courses assigned to me?', "What's my progress?");
  return out.slice(0, 5);
}

/**
 * Answer a natural-language question over an already-assembled networked
 * context. Status questions (assignments / progress / catalog) are
 * answered from the substrate's surfaces directly; content questions
 * delegate to the vertical's agentic RAG.
 */
export async function answerContextQuestion(input: {
  asker: { id: string; kind: AskerKind };
  question: string;
  context: NetworkedContext;
  llm?: LlmConfig;
}): Promise<ContextAnswer> {
  const { asker, question, context } = input;
  const llm: LlmConfig = input.llm ?? { keySource: 'none' };
  const intent = classifyContextIntent(question);

  let part: Pick<ContextAnswer, 'answer' | 'grounded' | 'sources'>
    & Partial<Pick<ContextAnswer, 'suggestions' | 'llm' | 'trace'>>;
  if (intent === 'assignments') part = answerAssignments(context);
  else if (intent === 'progress') part = answerProgress(context);
  else if (intent === 'catalog') part = answerCatalog(context);
  else part = await answerContent(question, asker.id, context, llm);

  return {
    intent, question, asker,
    answer: part.answer,
    grounded: part.grounded,
    sources: part.sources,
    suggestions: part.suggestions ?? contextSuggestions(context),
    ...(part.llm ? { llm: part.llm } : {}),
    ...(part.trace ? { trace: part.trace } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Networked-context assembly — from the substrate's live surfaces
// ─────────────────────────────────────────────────────────────────────

/** Verb tail + object name + timestamp of an xAPI statement. */
function statementActivity(stmt: Record<string, unknown>): ContextActivity {
  const verb = ((stmt.verb as { id?: string } | undefined)?.id ?? '').split('/').pop() ?? 'acted';
  const obj = stmt.object as { id?: string; definition?: { name?: Record<string, string> } } | undefined;
  const name = obj?.definition?.name?.['en-US'] ?? obj?.definition?.name?.en ?? obj?.id ?? 'activity';
  return {
    verb,
    objectName: name,
    objectId: obj?.id ?? '',
    ...(typeof stmt.timestamp === 'string' ? { timestamp: stmt.timestamp } : {}),
  };
}

/** True iff an xAPI statement's actor is this learner. */
function isLearnerStatement(stmt: Record<string, unknown>, learner: string): boolean {
  const a = stmt.actor as { account?: { name?: string; homePage?: string }; mbox?: string } | undefined;
  return a?.account?.name === learner || a?.account?.homePage === learner || a?.mbox === learner;
}

/** What courses the learner has touched on the LMS — engagement-derived. */
function engagementEnrollments(courses: FoxxiAgenticCourse[], activity: ContextActivity[]): ContextEnrollment[] {
  return courses.map(c => {
    const lessonIds = new Set(c.slides.map(s => s.id));
    const touched = activity.filter(a => a.objectId === c.courseId || lessonIds.has(a.objectId));
    const courseSatisfied = activity.some(a => a.verb === 'satisfied' && a.objectId === c.courseId);
    const allLessonsDone = lessonIds.size > 0 && [...lessonIds].every(lid =>
      activity.some(a => a.objectId === lid && (a.verb === 'completed' || a.verb === 'passed')));
    const status: ContextEnrollment['status'] =
      courseSatisfied || allLessonsDone ? 'completed'
      : touched.length > 0 ? 'in-progress'
      : 'available';
    return { courseId: c.courseId, courseTitle: c.title, status, source: 'lms-engagement' as const };
  });
}

export interface ContextChatConfig {
  selfBaseUrl: string;
  /** The authoritative source — the xAPI Agent account homePage. */
  authoritativeSource: string;
  /** Persist a statement into the tenant LRS (instruments the ask). */
  emitStatement?: (statement: Record<string, unknown>, tenant: TenantId) => void;
  /**
   * Optional — resolve the learner's policy-driven assignments. When
   * absent, assignments are engagement-derived from what the learner has
   * actually launched on the LMS.
   */
  resolveAssignments?: (learner: string, tenant: TenantId) => Promise<ContextEnrollment[] | undefined>;
  /** LLM key for agentic-RAG synthesis (the bridge's FOXXI_LLM_API_KEY).
   *  Absent → content answers return the retrieval scaffold instead. */
  llmApiKey?: string;
  /** Override the agentic-RAG model. */
  llmModel?: string;
  /** Reuse the bridge's per-IP rate limiter for the LLM-synthesis path. */
  checkLlmRateLimit?: (clientIp: string) => { ok: boolean; retryAfterSeconds?: number };
}

/** Assemble a learner's networked context from the substrate's surfaces. */
export async function assembleNetworkedContext(
  learner: string, tenant: TenantId, config: ContextChatConfig,
): Promise<NetworkedContext> {
  const courses: FoxxiAgenticCourse[] = [];
  for (const pub of _publishedCourses().values()) {
    if (pub.tenant === tenant) courses.push(emergentCourseToAgenticCourse(pub.course));
  }
  const jobAids: FoxxiAgenticCourse[] = [];
  for (const aid of _publishedJobAids().values()) {
    if (aid.tenant === tenant) jobAids.push(jobAidToAgenticCourse(aid));
  }
  const stored = await listStoredStatements(tenant).catch(() => []);
  const activity = stored
    .filter(rec => isLearnerStatement(rec.statement, learner))
    .map(rec => statementActivity(rec.statement))
    .filter(a => !!a.objectId)
    .sort((x, y) => (x.timestamp ?? '').localeCompare(y.timestamp ?? ''));

  // Enrollments — policy-driven if a resolver is wired, else engagement.
  const policy = config.resolveAssignments
    ? await config.resolveAssignments(learner, tenant).catch(() => undefined)
    : undefined;
  const engagement = engagementEnrollments(courses, activity);
  let enrollments: ContextEnrollment[];
  if (policy && policy.length > 0) {
    const policyIds = new Set(policy.map(e => e.courseId));
    enrollments = [...policy, ...engagement.filter(e => !policyIds.has(e.courseId) && e.status !== 'available')];
  } else {
    enrollments = engagement;
  }
  return { learner, courses, jobAids, enrollments, activity };
}

// ─────────────────────────────────────────────────────────────────────
//  The route — the one conversational front door
// ─────────────────────────────────────────────────────────────────────

function clientIpOf(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return (xff.split(',')[0] ?? '').trim() || 'unknown';
  if (Array.isArray(xff)) return xff[0] ?? 'unknown';
  return req.ip ?? 'unknown';
}

/** Attach `POST /content/ask` — chat over the networked context. */
export function attachContextChatRoutes(app: Express, config: ContextChatConfig): void {
  const base = config.selfBaseUrl.replace(/\/+$/, '');

  app.post('/content/ask', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    void (async () => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const question = typeof b.question === 'string' ? b.question.trim() : '';
      if (!question) {
        res.status(400).json({ error: 'a "question" string is required' });
        return;
      }
      const askerIn = (b.asker ?? {}) as Record<string, unknown>;
      const learner = (typeof b.learner === 'string' && b.learner)
        || (typeof askerIn.id === 'string' && askerIn.id)
        || 'anonymous';
      const asker: { id: string; kind: AskerKind } = {
        id: (typeof askerIn.id === 'string' && askerIn.id) || learner,
        kind: askerIn.kind === 'agent' ? 'agent' : 'human',
      };
      const tenant = tenantIdOf(req.query.tenant_pod_url as string | undefined);
      const intent = classifyContextIntent(question);

      // LLM key precedence: per-request BYOK > the bridge's env key.
      const byok = typeof b.llm_api_key === 'string' ? b.llm_api_key.trim() : '';
      const llm: LlmConfig = byok
        ? { apiKey: byok, ...(config.llmModel ? { model: config.llmModel } : {}), keySource: 'per-request-byok' }
        : config.llmApiKey
          ? { apiKey: config.llmApiKey, ...(config.llmModel ? { model: config.llmModel } : {}), keySource: 'bridge-env' }
          : { keySource: 'none' };

      // Rate-limit the LLM-synthesis path when it runs on the bridge's
      // own key (BYOK callers pay their own bill, so are exempt).
      if (isContentIntent(intent) && !byok && config.llmApiKey && config.checkLlmRateLimit) {
        const rl = config.checkLlmRateLimit(clientIpOf(req));
        if (!rl.ok) {
          res.status(429).json({
            error: 'rate limit exceeded for the bridge-key LLM path — retry shortly, '
              + 'or supply your own key via llm_api_key (BYOK is exempt).',
            retryAfterSeconds: rl.retryAfterSeconds,
          });
          return;
        }
      }

      let context: NetworkedContext;
      try {
        context = await assembleNetworkedContext(learner, tenant, config);
      } catch (e) {
        res.status(500).json({ error: `could not assemble networked context: ${(e as Error).message}` });
        return;
      }
      const answer = await answerContextQuestion({ asker, question, context, llm });

      // Instrument the ask into the LRS — the chat joins the trace graph.
      let instrumented = false;
      if (config.emitStatement) {
        config.emitStatement({
          actor: { objectType: 'Agent', account: { homePage: config.authoritativeSource, name: asker.id } },
          verb: { id: INTERACTED, display: { 'en-US': 'interacted' } },
          object: {
            objectType: 'Activity',
            id: `${base}/content/ask`,
            definition: {
              name: { 'en-US': 'Foxxi Context Companion' },
              description: { 'en-US': 'Chat over a user\'s networked context — assignments, content, progress.' },
              type: 'http://adlnet.gov/expapi/activities/interaction',
            },
          },
          result: { response: question, success: answer.grounded },
          context: { extensions: { [`${base}/ns/foxxi#contextKind`]: 'context-chat' } },
          timestamp: new Date().toISOString(),
        }, tenant);
        instrumented = true;
      }

      res.json({
        ...answer,
        learner,
        instrumented,
        contextSummary: {
          courses: context.courses.length,
          jobAids: context.jobAids.length,
          enrollments: context.enrollments.length,
          activityStatements: context.activity.length,
        },
        note: `Intent classified as "${answer.intent}". `
          + (isContentIntent(answer.intent)
            ? `Answered by the vertical's agentic RAG (${answer.llm?.keySource ?? 'none'}); `
              + (answer.grounded
                ? 'cited slides + the modal-statused Interego trace are attached.'
                : 'no concept matched — answered honestly rather than confabulating.')
            : 'Answered from the substrate\'s assignment / LRS surfaces.'),
      });
    })().catch((e: unknown) => {
      if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
    });
  });
}
