/**
 * Foxxi Context Companion — chat over a user's networked context.
 *
 * The whole point of Interego is that a user's context is networked: one
 * substrate holds their assigned courses, the content fragments those
 * courses are composed from, the job aids, and their xAPI activity. So a
 * user — human OR agent — should never have to know which surface to
 * call. They should be able to just ask:
 *
 *   "do I have any courses assigned to me?"   → the assignment surface
 *   "what does this concept mean?"            → grounded in the content
 *   "how do I handle X?"                      → grounded in the job aids
 *   "what's my progress?"                     → the live LRS
 *
 * This module is that single front door. `POST /content/ask` takes a
 * natural-language question, classifies its intent, assembles the asker's
 * networked context from the substrate's own surfaces (the published-course
 * registry, the job-aid registry, the live LRS), and answers — with
 * **sourced** answers: every claim about content quotes the verbatim
 * fragment it came from and carries the descriptor IRI + the
 * course › module › lesson provenance trail. It never confabulates: a
 * question nothing in the networked context covers gets an honest
 * no-match, exactly the discipline `course-qa.ts` borrows from LPC's
 * grounded-answer.
 *
 * The answer is identical whether a human or an agent asks — the asker's
 * kind is recorded, not branched on. That symmetry is the same one
 * `emergent-content.ts` relies on: humans and agents are the same kind of
 * user of the same substrate.
 *
 * Layer: L3 vertical. Composes the substrate (the published-content
 * registries, the LRS, the emergent-content Course shape); no L1/L2/L3
 * ontology change.
 */

import type { Express, Request, Response } from 'express';
import { tenantIdOf, type TenantId } from './tenant-context.js';
import { _publishedCourses, _publishedJobAids } from './content-delivery.js';
import { listStoredStatements } from './xapi-lrs.js';
import { flattenCourse } from './content-package.js';
import type { Course } from './emergent-content.js';

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
  | 'procedure'    // "how do I X?" — answered from job aids
  | 'catalog'      // "what courses are available?"
  | 'general';     // fall back to a content search

/** One cited source backing an answer — auditable, click-through-able. */
export interface GroundedSource {
  kind: 'course-fragment' | 'job-aid' | 'assignment' | 'progress' | 'course';
  /** The descriptor IRI / id the answer is drawn from. */
  id: string;
  /** Readable provenance: course › module › lesson, or the course title. */
  locator: string;
  /** Who authored / asserted it, when known. */
  authoredBy?: string;
  /** The verbatim excerpt the answer cites. */
  excerpt: string;
}

export interface ContextAnswer {
  intent: ContextIntent;
  question: string;
  asker: { id: string; kind: AskerKind };
  /** The conversational answer — readable on its own, citations inline. */
  answer: string;
  /** True iff the answer is backed by ≥1 source. An honest no-match is false. */
  grounded: boolean;
  sources: GroundedSource[];
  /** Follow-up prompts / topics actually present in the networked context. */
  suggestions: string[];
}

// ── The networked context — what the substrate knows about this user ──

export interface ContextFragment {
  id: string;
  modality: string;
  competencyPoint: string;
  level: string;
  body: string;
  authoredBy?: string;
}
export interface ContextLesson {
  lessonId: string;
  moduleTitle: string;
  lessonTitle: string;
  fragments: ContextFragment[];
}
export interface ContextCourse {
  courseId: string;
  title: string;
  competency: string;
  authoredBy?: string;
  lessons: ContextLesson[];
}
export interface ContextJobAid {
  id: string;
  competencyPoint: string;
  triggerContext: string;
  body: string;
  authoredBy?: string;
}
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
  courses: ContextCourse[];
  jobAids: ContextJobAid[];
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

// ─────────────────────────────────────────────────────────────────────
//  Term-overlap retrieval — the same honesty discipline as course-qa.ts
// ─────────────────────────────────────────────────────────────────────

const STOP = new Set(
  ('a an and any are about as at be by can do does for from has have how i if in into is it its '
   + 'me my of on or our should so that the their them then there these this to up was we were '
   + 'what when where which who will with you your com mean means explain define tell show give '
   + 'course courses lesson content please').split(/\s+/),
);

/** The distinct, content-bearing terms of a string. */
function terms(s: string): string[] {
  return [...new Set(
    (s.toLowerCase().match(/[a-z0-9][a-z0-9'$-]*/g) ?? [])
      .map(t => t.replace(/'s$/, '').replace(/[$]/g, ''))
      .filter(t => t.length >= 3 && !STOP.has(t)),
  )];
}

interface Atom {
  source: GroundedSource;
  /** Full searchable text (competency point + body). */
  haystack: string;
  competencyPoint: string;
  modality: string;
}

/** Flatten the networked context's content into searchable grounding atoms. */
function contentAtoms(ctx: NetworkedContext): Atom[] {
  const atoms: Atom[] = [];
  for (const course of ctx.courses) {
    for (const lesson of course.lessons) {
      for (const f of lesson.fragments) {
        atoms.push({
          source: {
            kind: 'course-fragment',
            id: f.id,
            locator: `${course.title} › ${lesson.moduleTitle} › ${lesson.lessonTitle}`,
            ...(f.authoredBy ? { authoredBy: f.authoredBy } : {}),
            excerpt: f.body,
          },
          haystack: `${f.competencyPoint} ${f.body}`.toLowerCase(),
          competencyPoint: f.competencyPoint,
          modality: f.modality,
        });
      }
    }
  }
  for (const aid of ctx.jobAids) {
    atoms.push({
      source: {
        kind: 'job-aid',
        id: aid.id,
        locator: `Job aid — ${aid.competencyPoint} (surfaced: ${aid.triggerContext})`,
        ...(aid.authoredBy ? { authoredBy: aid.authoredBy } : {}),
        excerpt: aid.body,
      },
      haystack: `${aid.competencyPoint} ${aid.triggerContext} ${aid.body}`.toLowerCase(),
      competencyPoint: aid.competencyPoint,
      modality: 'job-aid',
    });
  }
  return atoms;
}

interface ScoredAtom { atom: Atom; score: number; matched: number; }

/** Score every atom against the query; return the matches, best first. */
function retrieve(qTerms: string[], atoms: Atom[], intent: ContextIntent): ScoredAtom[] {
  if (qTerms.length === 0) return [];
  const scored: ScoredAtom[] = [];
  for (const atom of atoms) {
    const cp = atom.competencyPoint.toLowerCase();
    let score = 0, matched = 0;
    for (const t of qTerms) {
      if (cp.includes(t)) { score += 2; matched++; }
      else if (atom.haystack.includes(t)) { score += 1; matched++; }
    }
    if (matched === 0) continue;
    // Intent-aware nudge — a procedure question prefers a job aid; a
    // concept question prefers a told concept.
    if (intent === 'procedure' && atom.modality === 'job-aid') score += 1.5;
    if (intent === 'concept' && (atom.modality === 'concept' || atom.modality === 'reference')) score += 1;
    scored.push({ atom, score, matched });
  }
  return scored.sort((a, b) => b.score - a.score || b.matched - a.matched);
}

// ─────────────────────────────────────────────────────────────────────
//  Answer composition
// ─────────────────────────────────────────────────────────────────────

/** "1 course" / "3 courses" / "1 is" / "2 are" — count + pluralised noun. */
const plural = (n: number, s: string, p = `${s}s`): string => `${n} ${n === 1 ? s : p}`;

/** Topic phrase for a question — its content terms, or a fallback. */
function topicOf(question: string): string {
  const t = terms(question);
  return t.length > 0 ? t.join(' ') : question.trim().replace(/[?.!]+$/, '');
}

function answerContent(
  intent: ContextIntent, question: string, ctx: NetworkedContext,
): { answer: string; grounded: boolean; sources: GroundedSource[] } {
  const qTerms = terms(question);
  const hits = retrieve(qTerms, contentAtoms(ctx), intent).slice(0, 3);
  const topic = topicOf(question);

  if (hits.length === 0) {
    const covered = [...new Set(ctx.courses.flatMap(c =>
      c.lessons.flatMap(l => l.fragments.map(f => f.competencyPoint))))];
    const lead = `I couldn't find anything in your content about "${topic}". `
      + `Nothing in the published courses or job aids covers it — so I won't guess.`;
    const hint = covered.length > 0
      ? ` What the content does cover: ${covered.slice(0, 6).join('; ')}.`
      : ` There is no published content in your context yet.`;
    return { answer: lead + hint, grounded: false, sources: [] };
  }

  const leadIn = intent === 'procedure'
    ? `Here's the guidance for that, from your content:`
    : intent === 'concept'
      ? `Here's what your content says about "${hits[0]!.atom.competencyPoint}":`
      : `From your content:`;
  const body = hits.map(h =>
    `• "${h.atom.source.excerpt}"\n  — ${h.atom.modality} · ${h.atom.source.locator}`).join('\n\n');
  return {
    answer: `${leadIn}\n\n${body}`,
    grounded: true,
    sources: hits.map(h => h.atom.source),
  };
}

function answerAssignments(ctx: NetworkedContext): { answer: string; grounded: boolean; sources: GroundedSource[]; suggestions: string[] } {
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
    const lead = `You don't have any courses assigned to you right now.`;
    const more = available.length > 0
      ? ` ${plural(available.length, 'course')} ${available.length === 1 ? 'is' : 'are'} `
        + `available you could start: ${available.map(c => c.courseTitle).join('; ')}.`
      : ` There is no published course in your context yet.`;
    return { answer: lead + more, grounded: assigned.length > 0, sources, suggestions: available.map(c => `Start "${c.courseTitle}"`) };
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
    grounded: true,
    sources,
    suggestions: assigned.filter(e => e.status !== 'completed').map(e => `Resume "${e.courseTitle}"`),
  };
}

function answerProgress(ctx: NetworkedContext): { answer: string; grounded: boolean; sources: GroundedSource[] } {
  const completed = ctx.enrollments.filter(e => e.status === 'completed');
  if (ctx.activity.length === 0 && completed.length === 0) {
    return {
      answer: `I don't see any completed or in-progress training for you yet. `
        + `Once you launch a course, every step you take is recorded in your learning record — ask me again then.`,
      grounded: false,
      sources: [],
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

function answerCatalog(ctx: NetworkedContext): { answer: string; grounded: boolean; sources: GroundedSource[] } {
  if (ctx.courses.length === 0 && ctx.jobAids.length === 0) {
    return { answer: `There is no published content in your context yet.`, grounded: false, sources: [] };
  }
  const courseLines = ctx.courses.map(c =>
    `• ${c.title} — ${c.competency} (${plural(c.lessons.length, 'lesson')})`).join('\n');
  const aidNote = ctx.jobAids.length > 0
    ? `\n\nThere ${ctx.jobAids.length === 1 ? 'is' : 'are'} also ${plural(ctx.jobAids.length, 'job aid')} `
      + `for in-the-flow support: ${ctx.jobAids.map(a => a.competencyPoint).join('; ')}.`
    : '';
  return {
    answer: `There ${ctx.courses.length === 1 ? 'is' : 'are'} ${plural(ctx.courses.length, 'course')} available:\n\n${courseLines}${aidNote}`,
    grounded: ctx.courses.length > 0 || ctx.jobAids.length > 0,
    sources: ctx.courses.map(c => ({
      kind: 'course' as const, id: c.courseId, locator: c.title, excerpt: c.competency,
    })),
  };
}

/** Topics genuinely present in the networked context — for follow-ups. */
function contextSuggestions(ctx: NetworkedContext): string[] {
  const out: string[] = [];
  const cps = [...new Set(ctx.courses.flatMap(c =>
    c.lessons.flatMap(l => l.fragments.map(f => f.competencyPoint))))];
  for (const cp of cps.slice(0, 3)) out.push(`What does "${cp}" mean?`);
  for (const aid of ctx.jobAids.slice(0, 1)) out.push(`How do I handle ${aid.triggerContext}?`);
  out.push('Do I have any courses assigned to me?', "What's my progress?");
  return out.slice(0, 5);
}

/**
 * Answer a natural-language question over an already-assembled networked
 * context. Pure + deterministic — the route assembles the context; this
 * routes by intent and composes a sourced answer.
 */
export function answerContextQuestion(input: {
  asker: { id: string; kind: AskerKind };
  question: string;
  context: NetworkedContext;
}): ContextAnswer {
  const { asker, question, context } = input;
  const intent = classifyContextIntent(question);
  let part: { answer: string; grounded: boolean; sources: GroundedSource[]; suggestions?: string[] };
  switch (intent) {
    case 'assignments': part = answerAssignments(context); break;
    case 'progress': part = answerProgress(context); break;
    case 'catalog': part = answerCatalog(context); break;
    case 'procedure':
    case 'concept':
    case 'general':
    default: part = answerContent(intent, question, context); break;
  }
  return {
    intent,
    question,
    asker,
    answer: part.answer,
    grounded: part.grounded,
    sources: part.sources,
    suggestions: part.suggestions ?? contextSuggestions(context),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Networked-context assembly — from the substrate's live surfaces
// ─────────────────────────────────────────────────────────────────────

/** Flatten a published emergent Course into the chat's content shape. */
function courseToContextCourse(course: Course): ContextCourse {
  const lessons: ContextLesson[] = flattenCourse(course).map(fl => ({
    lessonId: fl.lesson.id,
    moduleTitle: fl.moduleTitle,
    lessonTitle: fl.lesson.title,
    fragments: fl.fragments.map(f => ({
      id: f.id,
      modality: f.modality,
      competencyPoint: f.competencyPoint,
      level: f.level,
      body: f.body,
      authoredBy: `${f.authoredBy.kind} ${f.authoredBy.id}`,
    })),
  }));
  return {
    courseId: course.id,
    title: course.title,
    competency: course.competency,
    authoredBy: `${course.authoredBy.kind} ${course.authoredBy.id}`,
    lessons,
  };
}

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
function engagementEnrollments(courses: ContextCourse[], activity: ContextActivity[]): ContextEnrollment[] {
  return courses.map(c => {
    const lessonIds = new Set(c.lessons.map(l => l.lessonId));
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
   * Optional — resolve the learner's policy-driven assignments (the
   * enrollment surface). When absent, assignments are engagement-derived
   * from what the learner has actually launched on the LMS.
   */
  resolveAssignments?: (learner: string, tenant: TenantId) => Promise<ContextEnrollment[] | undefined>;
}

/** Assemble a learner's networked context from the substrate's surfaces. */
export async function assembleNetworkedContext(
  learner: string, tenant: TenantId, config: ContextChatConfig,
): Promise<NetworkedContext> {
  const courses: ContextCourse[] = [];
  for (const pub of _publishedCourses().values()) {
    if (pub.tenant === tenant) courses.push(courseToContextCourse(pub.course));
  }
  const jobAids: ContextJobAid[] = [];
  for (const aid of _publishedJobAids().values()) {
    if (aid.tenant === tenant) {
      jobAids.push({ id: aid.id, competencyPoint: aid.competencyPoint, triggerContext: aid.triggerContext, body: aid.body });
    }
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

      let context: NetworkedContext;
      try {
        context = await assembleNetworkedContext(learner, tenant, config);
      } catch (e) {
        res.status(500).json({ error: `could not assemble networked context: ${(e as Error).message}` });
        return;
      }
      const answer = answerContextQuestion({ asker, question, context });

      // Instrument the ask into the LRS — the chat itself joins the
      // networked context's trace graph.
      let instrumented = false;
      if (config.emitStatement) {
        config.emitStatement({
          actor: {
            objectType: 'Agent',
            account: { homePage: config.authoritativeSource, name: asker.id },
          },
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
          context: {
            extensions: {
              [`${base}/ns/foxxi#contextKind`]: 'context-chat',
            },
          },
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
        note: 'One front door over the networked context: the intent was '
          + `classified as "${answer.intent}" and answered from the substrate's own surfaces. `
          + (answer.grounded
            ? 'Every claim is sourced — see sources[] for the descriptor IRIs + provenance.'
            : 'No source covered the question — answered honestly rather than confabulating.'),
      });
    })().catch((e: unknown) => {
      if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
    });
  });
}
