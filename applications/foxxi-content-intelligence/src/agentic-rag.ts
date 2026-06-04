/**
 * Agentic RAG over a federation of Foxxi course graphs.
 *
 * Ports the retrieval logic from the original
 * imported/foxxi_dashboard_v03.jsx (function buildGraphContext) to
 * TypeScript and wires it through Interego:
 *
 *   1. **Concept-graph retrieval** — match question tokens against
 *      concept labels across every loaded course (federation), score
 *      by overlap + free-standing bonus, pick the top K seeds.
 *   2. **Prereq + modifier-of edge expansion** — for each seed
 *      concept, walk one hop within its home course's graph
 *      (modifier-of relations + prereq edges). The result is a
 *      concept neighborhood that the LLM context will reference.
 *   3. **Round-robin slide allocation** — bucket slides by source
 *      course, pick round-robin to keep peer-course slides in the
 *      cited set even when the primary course matches more.
 *   4. **LLM synthesis** — optional. When FOXXI_LLM_API_KEY (or
 *      ANTHROPIC_API_KEY) is set, the substrate calls the Anthropic
 *      messages API with the retrieved context as the system prompt
 *      + the question + history as the user turn. Without a key,
 *      `synthesizedAnswer` is null and the caller receives the
 *      retrieval scaffold alone (still useful — IRI-citable
 *      transcripts the dashboard can render verbatim).
 *   5. **Interego trace** — every step of the agent loop is emitted
 *      as a descriptor blueprint (caller publishes them to the pod
 *      via the standard publish() flow). Modal-status discipline:
 *        - the question                → fxa:LearnerQuestionEvent  Asserted
 *        - the retrieval activity      → fxa:RetrievalActivity    Hypothetical
 *        - the LLM completion           → fxa:LlmCompletion         Hypothetical
 *        - the cited answer             → fxa:CitedAnswer           Asserted
 *          (cg:supersedes-chains back through the Hypothetical
 *          retrieval + completion descriptors, so the auditor walks
 *          the whole agent trace from the final answer)
 *
 * The retrieval surface is the published Foxxi course graphs (fxk:
 * ConceptMap + fxs:Slide descriptors). The agent's "tools" are
 * Interego affordances (search concepts, expand neighborhood, fetch
 * transcript). The reasoning trace is itself an Interego artifact
 * with proper modal status and supersedes chains. That is what
 * "agentic RAG utilizing Interego entirely" means here.
 */

import { createHash } from 'node:crypto';
import {
  withTransientRetry,
} from '@interego/core';
import type {
  IRI,
} from '@interego/core';
import type { FoxxiCourseContent } from './course-qa.js';

// ─────────────────────────────────────────────────────────────────────
//  Shapes
// ─────────────────────────────────────────────────────────────────────

/**
 * A course as it arrives from the parser (matches the structure of
 * federation_payload.json + dashboard_data.json) — extended slightly
 * for the agentic retrieval pipeline.
 */
export interface FoxxiAgenticCourse {
  /** Course IRI (federation_iri_base#package — matches publisher.ts). */
  readonly courseIri: IRI;
  /** Display title. */
  readonly title: string;
  /** Short label for citations (e.g. "Golf Explained"). */
  readonly courseLabel: string;
  /** Stable course id. */
  readonly courseId: string;
  readonly authoritativeSource: IRI;
  readonly concepts: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly confidence: number;
    readonly tier: number;
    readonly is_free_standing?: boolean;
    readonly taught_in_slides: readonly string[];
    readonly total_freq?: number;
  }>;
  readonly slides: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly sequence_index: number;
    readonly concept_ids: readonly string[];
    readonly transcript_combined: string;
  }>;
  readonly modifier_pairs: ReadonlyArray<{ modifier: string; target: string }>;
  readonly prereq_edges: ReadonlyArray<{ from: string; to: string; confidence?: number }>;
}

export interface SeedConcept {
  readonly course: FoxxiAgenticCourse;
  readonly conceptId: string;
  readonly conceptLabel: string;
  readonly score: number;
}

export interface CitedSlide {
  readonly course: FoxxiAgenticCourse;
  readonly slideId: string;
  readonly slideTitle: string;
  readonly sequenceIndex: number;
  readonly transcriptCombined: string;
  readonly conceptIds: readonly string[];
}

export interface ExpandedConcept {
  readonly course: FoxxiAgenticCourse;
  readonly conceptId: string;
  readonly conceptLabel: string;
}

export interface RetrievalContext {
  readonly seedConcepts: readonly SeedConcept[];
  readonly expandedConcepts: readonly ExpandedConcept[];
  readonly citedSlides: readonly CitedSlide[];
  readonly retrievalKind: 'graph' | 'fallback';
  readonly contributingCourseIds: readonly string[];
}

export interface AgentTraceDescriptor {
  readonly iri: IRI;
  readonly graphIri: IRI;
  readonly type: 'fxa:LearnerQuestionEvent' | 'fxa:RetrievalActivity' | 'fxa:LlmCompletion' | 'fxa:CitedAnswer';
  readonly modalStatus: 'Asserted' | 'Hypothetical';
  /** prov:wasDerivedFrom IRIs of upstream trace descriptors. */
  readonly wasDerivedFrom: readonly IRI[];
  /** cg:supersedes IRI (for the final Asserted answer superseding its Hypothetical drafts). */
  readonly supersedes?: IRI;
  /** Body payload for the descriptor's named graph. */
  readonly body: Record<string, unknown>;
  /** ISO timestamp. */
  readonly recordedAt: string;
}

export type LlmKeySource =
  | 'none'             // no key supplied; retrieval scaffold only
  | 'bridge-env'       // key from FOXXI_LLM_API_KEY / ANTHROPIC_API_KEY env on the bridge
  | 'per-request-byok' // key supplied per-request (BYOK from the dashboard / MCP client)
  | 'mcp-client';      // call originated from foxxi.retrieve_course_context — caller IS the LLM

export interface AgenticRagResult {
  readonly retrieval: RetrievalContext;
  /** Null when no LLM was called (mcp-client / none modes). */
  readonly synthesizedAnswer: string | null;
  /** Provenance: which LLM (or "no-llm"). */
  readonly llmModel: string;
  /** Which key source powered the LLM (or "none" / "mcp-client"). Recorded on the trace. */
  readonly llmKeySource: LlmKeySource;
  /** Interego descriptor trace — caller publishes via publish(). */
  readonly trace: readonly AgentTraceDescriptor[];
}

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function isFreeStanding(c: { is_free_standing?: boolean; tier: number }): boolean {
  // Per the parser, tier-1/2 concepts are typically free-standing.
  // Honor the explicit flag when present.
  return c.is_free_standing ?? (c.tier <= 2);
}

// ─────────────────────────────────────────────────────────────────────
//  Retrieval — concept-graph + edge expansion + round-robin slides
// ─────────────────────────────────────────────────────────────────────

function findRelevantConcepts(question: string, courses: readonly FoxxiAgenticCourse[], topK = 8): SeedConcept[] {
  const q = question.toLowerCase();
  const qTokens = q.split(/\W+/).filter(t => t.length >= 4);
  if (qTokens.length === 0) return [];

  const scored: SeedConcept[] = [];
  for (const course of courses) {
    for (const c of course.concepts) {
      let score = 0;
      const lower = c.label.toLowerCase();
      for (const t of qTokens) {
        if (lower === t) score += 5;
        else if (lower.includes(t)) score += 2;
        else if (t.includes(lower) && lower.length >= 4) score += 1;
      }
      if (!isFreeStanding(c)) score *= 0.5;
      if (score > 0) {
        scored.push({ course, conceptId: c.id, conceptLabel: c.label, score });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function expandConceptNeighborhood(
  seeded: readonly SeedConcept[],
  depth = 1,
): { concepts: ExpandedConcept[]; citedSlideCandidates: CitedSlide[] } {
  const expanded: ExpandedConcept[] = seeded.map(s => ({
    course: s.course, conceptId: s.conceptId, conceptLabel: s.conceptLabel,
  }));
  const seen = new Set(seeded.map(s => `${s.course.courseId}:${s.conceptId}`));

  const enqueue = (course: FoxxiAgenticCourse, conceptId: string) => {
    const k = `${course.courseId}:${conceptId}`;
    if (seen.has(k)) return;
    const c = course.concepts.find(x => x.id === conceptId);
    if (!c) return;
    seen.add(k);
    expanded.push({ course, conceptId: c.id, conceptLabel: c.label });
  };

  if (depth >= 1) {
    for (const { course, conceptId } of seeded) {
      // modifier-of: things this concept modifies, and what modifies it
      for (const p of course.modifier_pairs) {
        if (p.target === conceptId) enqueue(course, p.modifier);
        if (p.modifier === conceptId) enqueue(course, p.target);
      }
      // prereq edges: prerequisites pointing INTO this concept
      for (const e of course.prereq_edges) {
        if (e.to === conceptId) enqueue(course, e.from);
      }
    }
  }

  // Gather slides from every expanded concept's taught_in_slides.
  const citedSlideCandidates: CitedSlide[] = [];
  for (const ec of expanded) {
    const c = ec.course.concepts.find(x => x.id === ec.conceptId);
    if (!c) continue;
    for (const sid of c.taught_in_slides) {
      const slide = ec.course.slides.find(s => s.id === sid);
      if (slide) {
        citedSlideCandidates.push({
          course: ec.course,
          slideId: slide.id,
          slideTitle: slide.title,
          sequenceIndex: slide.sequence_index,
          transcriptCombined: slide.transcript_combined,
          conceptIds: slide.concept_ids,
        });
      }
    }
  }
  return { concepts: expanded, citedSlideCandidates };
}

function allocateCitedSlides(
  primaryCourseId: string,
  candidates: readonly CitedSlide[],
  cap = 5,
): CitedSlide[] {
  const buckets = new Map<string, CitedSlide[]>();
  const seen = new Set<string>();
  for (const item of candidates) {
    const k = `${item.course.courseId}:${item.slideId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const list = buckets.get(item.course.courseId) ?? [];
    list.push(item);
    buckets.set(item.course.courseId, list);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  }
  const orderedCourseIds = [...buckets.keys()].sort((a, b) => {
    if (a === primaryCourseId) return -1;
    if (b === primaryCourseId) return 1;
    return a.localeCompare(b);
  });
  const out: CitedSlide[] = [];
  let round = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let picked = false;
    for (const cid of orderedCourseIds) {
      const bucket = buckets.get(cid);
      if (bucket && bucket.length > round) {
        out.push(bucket[round]!);
        picked = true;
        if (out.length >= cap) return out;
      }
    }
    if (!picked) break;
    round++;
  }
  return out;
}

export function buildGraphContext(args: {
  question: string;
  primary: FoxxiAgenticCourse;
  federation?: readonly FoxxiAgenticCourse[];
  seedK?: number;
  expandDepth?: number;
  slideCap?: number;
}): RetrievalContext {
  const allCourses = [args.primary, ...(args.federation ?? [])];
  const seedConcepts = findRelevantConcepts(args.question, allCourses, args.seedK ?? 6);
  const { concepts: expanded, citedSlideCandidates } = expandConceptNeighborhood(seedConcepts, args.expandDepth ?? 1);
  let citedSlides = allocateCitedSlides(args.primary.courseId, citedSlideCandidates, args.slideCap ?? 5);

  // Fallback: when no concepts matched, surface the first 3 narrated
  // slides of the primary course so the LLM has SOMETHING to ground in.
  if (citedSlides.length === 0) {
    citedSlides = args.primary.slides
      .filter(s => (s.transcript_combined ?? '').length > 50)
      .slice(0, 3)
      .map(s => ({
        course: args.primary,
        slideId: s.id,
        slideTitle: s.title,
        sequenceIndex: s.sequence_index,
        transcriptCombined: s.transcript_combined,
        conceptIds: s.concept_ids,
      }));
  }

  const contributingCourseIds = [...new Set(seedConcepts.map(s => s.course.courseId))];
  return {
    seedConcepts,
    expandedConcepts: expanded.slice(0, 16),
    citedSlides,
    retrievalKind: seedConcepts.length > 0 ? 'graph' : 'fallback',
    contributingCourseIds,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Prompt assembly + LLM call
// ─────────────────────────────────────────────────────────────────────

function buildSystemPrompt(args: {
  question: string;
  primary: FoxxiAgenticCourse;
  federation: readonly FoxxiAgenticCourse[];
  ctx: RetrievalContext;
}): string {
  const peerCourses = args.ctx.contributingCourseIds.filter(c => c !== args.primary.courseId);
  let federationStatus: string;
  if (args.ctx.seedConcepts.length === 0) {
    federationStatus = `No matching concepts found in any loaded course graph (primary: ${args.primary.courseLabel}, peers: ${args.federation.map(f => f.courseLabel).join(', ') || 'none'}). Falling back to first slides of the primary course.`;
  } else if (peerCourses.length > 0) {
    const peerNames = args.federation.filter(f => peerCourses.includes(f.courseId)).map(f => f.courseLabel).join(', ');
    federationStatus = `Drew on federation peer course(s): ${peerNames}. Cite peer-course slides with their course label so the user knows where the answer comes from.`;
  } else {
    federationStatus = `All matches from primary course (${args.primary.courseLabel}).`;
  }

  const slideBlocks = args.ctx.citedSlides.map(cs => {
    const coursePrefix = cs.course.courseId === args.primary.courseId ? '' : `[${cs.course.courseLabel}] `;
    const slideConcepts = cs.conceptIds
      .map(id => cs.course.concepts.find(c => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c && isFreeStanding(c))
      .slice(0, 6)
      .map(c => c.label)
      .join(', ');
    return [
      `${coursePrefix}[Slide §${cs.sequenceIndex + 1}: ${cs.slideTitle}] (course: ${cs.course.courseLabel}, id: ${cs.slideId})`,
      slideConcepts ? `  Free-standing concepts: ${slideConcepts}` : '',
      cs.transcriptCombined ? `  Transcript: ${cs.transcriptCombined}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const conceptList = args.ctx.expandedConcepts
    .map(ec => ec.course.courseId === args.primary.courseId
      ? ec.conceptLabel
      : `${ec.conceptLabel} (${ec.course.courseLabel})`)
    .join('; ');

  return `You are a tutor with access to a federation of Foxxi-parsed course graphs.

Primary course: "${args.primary.title}" — ${args.primary.slides.length} slides, ${args.primary.concepts.length} concepts.
${args.federation.length > 0 ? `Federation peers loaded: ${args.federation.map(f => `"${f.title}" (${f.slides.length} slides)`).join(', ')}.` : 'No federation peers loaded.'}

Your knowledge is strictly limited to the course content retrieved below — do not invent material that isn't there.

Retrieval (${args.ctx.retrievalKind}):
  ${args.ctx.seedConcepts.length} seed concept(s) matched: ${args.ctx.seedConcepts.map(s => s.course.courseId === args.primary.courseId ? s.conceptLabel : `${s.conceptLabel} [${s.course.courseLabel}]`).join(', ') || '(none)'}
  Expanded to ${args.ctx.expandedConcepts.length} related concepts and ${args.ctx.citedSlides.length} cited slide(s).

Federation status: ${federationStatus}

Concepts in retrieved neighborhood: ${conceptList}.

Cited slide content:
─────────────────────────────────────────
${slideBlocks}
─────────────────────────────────────────

When citing a slide that comes from a federation peer, prefix with the course label, e.g. [Golf Fundamentals (stub)]. When citing a primary-course slide just use the slide title in brackets, e.g. [Voltage Control]. Answer in plain prose, 2-4 short paragraphs unless depth is requested. If the retrieved material doesn't address the question, say so honestly rather than inventing.`;
}

interface AnthropicMessage { role: 'user' | 'assistant'; content: string }

async function callAnthropic(args: {
  apiKey: string;
  model: string;
  system: string;
  messages: AnthropicMessage[];
  maxTokens?: number;
}): Promise<string> {
  // Transient-network retry (5xx / ECONNRESET / "fetch failed") via the
  // substrate's shared wrapper. 4xx (auth/quota) surfaces immediately —
  // isTransientNetworkError() treats only durable-blip signals as retryable.
  const data = await withTransientRetry<{ content?: { type: string; text?: string }[]; error?: { message: string } }>(async () => {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': args.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: args.model,
        max_tokens: args.maxTokens ?? 1000,
        system: args.system,
        messages: args.messages,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API ${resp.status}: ${text.slice(0, 300)}`);
    }
    return await resp.json() as { content?: { type: string; text?: string }[]; error?: { message: string } };
  });
  if (data.error) throw new Error(`Anthropic error: ${data.error.message}`);
  return (data.content ?? [])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text!)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────
//  Interego trace descriptors
// ─────────────────────────────────────────────────────────────────────

function emitTrace(args: {
  question: string;
  learnerDid: IRI;
  course: FoxxiAgenticCourse;
  retrieval: RetrievalContext;
  llmModel: string;
  llmKeySource: LlmKeySource;
  synthesizedAnswer: string | null;
}): AgentTraceDescriptor[] {
  const traceId = sha256Hex(`${args.learnerDid}|${args.course.courseIri}|${args.question}|${nowIso()}`).slice(0, 16);
  const at = nowIso();

  const qIri = `urn:cg:foxxi:trace:question:${traceId}` as IRI;
  const qGraph = `urn:graph:foxxi:trace:question:${traceId}` as IRI;
  const question: AgentTraceDescriptor = {
    iri: qIri,
    graphIri: qGraph,
    type: 'fxa:LearnerQuestionEvent',
    modalStatus: 'Asserted',
    wasDerivedFrom: [],
    body: {
      learnerDid: args.learnerDid,
      courseIri: args.course.courseIri,
      questionText: args.question,
    },
    recordedAt: at,
  };

  const rIri = `urn:cg:foxxi:trace:retrieval:${traceId}` as IRI;
  const rGraph = `urn:graph:foxxi:trace:retrieval:${traceId}` as IRI;
  const retrieval: AgentTraceDescriptor = {
    iri: rIri,
    graphIri: rGraph,
    type: 'fxa:RetrievalActivity',
    modalStatus: 'Hypothetical',
    wasDerivedFrom: [qIri],
    body: {
      retrievalKind: args.retrieval.retrievalKind,
      seedConcepts: args.retrieval.seedConcepts.map(s => ({ courseId: s.course.courseId, conceptId: s.conceptId, label: s.conceptLabel, score: s.score })),
      expandedConceptCount: args.retrieval.expandedConcepts.length,
      citedSlideIds: args.retrieval.citedSlides.map(c => `${c.course.courseId}:${c.slideId}`),
      contributingCourseIds: args.retrieval.contributingCourseIds,
    },
    recordedAt: at,
  };

  const traceList: AgentTraceDescriptor[] = [question, retrieval];

  if (args.synthesizedAnswer !== null) {
    const lIri = `urn:cg:foxxi:trace:llm:${traceId}` as IRI;
    const lGraph = `urn:graph:foxxi:trace:llm:${traceId}` as IRI;
    const llm: AgentTraceDescriptor = {
      iri: lIri,
      graphIri: lGraph,
      type: 'fxa:LlmCompletion',
      modalStatus: 'Hypothetical',
      wasDerivedFrom: [rIri],
      body: { model: args.llmModel, keySource: args.llmKeySource, responseText: args.synthesizedAnswer },
      recordedAt: at,
    };
    traceList.push(llm);

    const aIri = `urn:cg:foxxi:trace:answer:${traceId}` as IRI;
    const aGraph = `urn:graph:foxxi:trace:answer:${traceId}` as IRI;
    const answer: AgentTraceDescriptor = {
      iri: aIri,
      graphIri: aGraph,
      type: 'fxa:CitedAnswer',
      modalStatus: 'Asserted',
      wasDerivedFrom: [lIri, rIri, qIri],
      supersedes: lIri,
      body: {
        responseText: args.synthesizedAnswer,
        citedSlideIds: args.retrieval.citedSlides.map(c => `${c.course.courseId}:${c.slideId}`),
        contributingCourseIds: args.retrieval.contributingCourseIds,
      },
      recordedAt: at,
    };
    traceList.push(answer);
  }

  return traceList;
}

// ─────────────────────────────────────────────────────────────────────
//  Public entry point
// ─────────────────────────────────────────────────────────────────────

export interface AskAgenticRagArgs {
  readonly question: string;
  readonly learnerDid: IRI;
  readonly primary: FoxxiAgenticCourse;
  readonly federation?: readonly FoxxiAgenticCourse[];
  readonly history?: readonly { role: 'user' | 'assistant'; content: string }[];
  /** Override LLM model (default: claude-opus-4-7). */
  readonly llmModel?: string;
  /** If supplied, used to call the Anthropic API. Without it, retrieval-only result. */
  readonly llmApiKey?: string;
  /** Which source the key came from (for honest provenance recording). */
  readonly llmKeySource?: LlmKeySource;
}

export async function askAgenticRag(args: AskAgenticRagArgs): Promise<AgenticRagResult> {
  const federation = args.federation ?? [];
  const ctx = buildGraphContext({ question: args.question, primary: args.primary, federation });
  const llmModel = args.llmModel ?? 'claude-opus-4-7';
  let synthesizedAnswer: string | null = null;
  const llmKeySource: LlmKeySource = args.llmApiKey ? (args.llmKeySource ?? 'bridge-env') : 'none';
  if (args.llmApiKey) {
    const system = buildSystemPrompt({ question: args.question, primary: args.primary, federation, ctx });
    const messages: AnthropicMessage[] = [
      ...(args.history ?? []).map(m => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: args.question },
    ];
    try {
      synthesizedAnswer = await callAnthropic({ apiKey: args.llmApiKey, model: llmModel, system, messages });
    } catch (err) {
      // Honest reporting: if the LLM fails, return retrieval-only with an error note.
      synthesizedAnswer = `(LLM call failed: ${(err as Error).message}) — retrieval scaffold above is intact; render slides as verbatim citations.`;
    }
  }
  const effectiveModel = args.llmApiKey ? llmModel : 'no-llm';
  const trace = emitTrace({
    question: args.question,
    learnerDid: args.learnerDid,
    course: args.primary,
    retrieval: ctx,
    llmModel: effectiveModel,
    llmKeySource,
    synthesizedAnswer,
  });
  return { retrieval: ctx, synthesizedAnswer, llmModel: effectiveModel, llmKeySource, trace };
}

/**
 * MCP-client-as-LLM path: pure retrieval, no synthesis. Designed for
 * the case where the user's agent (Claude.ai connector, Claude Desktop,
 * Claude Code, Cursor, Codex, etc.) IS the LLM and uses the user's
 * existing subscription. The MCP client receives the retrieval scaffold
 * + a 2-step Interego trace (question Asserted + retrieval Hypothetical)
 * and is expected to (a) synthesize the answer in its own context using
 * the cited slide transcripts as grounding, and (b) optionally publish
 * its own fxa:CitedAnswer descriptor back to the tenant pod to close
 * out the trace with a final Asserted answer that supersedes the
 * retrieval Hypothetical.
 *
 * Net effect: NO API key on the bridge OR the dashboard. The user's
 * subscription pays. Substrate-pure — same primitives as the LLM-
 * augmented path, just without the centralised LLM call.
 */
export interface RetrieveCourseContextArgs {
  readonly question: string;
  readonly learnerDid: IRI;
  readonly primary: FoxxiAgenticCourse;
  readonly federation?: readonly FoxxiAgenticCourse[];
}

export function retrieveCourseContext(args: RetrieveCourseContextArgs): AgenticRagResult {
  const federation = args.federation ?? [];
  const ctx = buildGraphContext({ question: args.question, primary: args.primary, federation });
  const trace = emitTrace({
    question: args.question,
    learnerDid: args.learnerDid,
    course: args.primary,
    retrieval: ctx,
    llmModel: 'mcp-client-as-llm',
    llmKeySource: 'mcp-client',
    synthesizedAnswer: null,
  });
  return {
    retrieval: ctx,
    synthesizedAnswer: null,
    llmModel: 'mcp-client-as-llm',
    llmKeySource: 'mcp-client',
    trace,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Adapter: turn a FoxxiCourseContent + dashboard payload into the
//  agentic-course shape (so the bridge handler can accept the same
//  payload the prior dashboard's federation_payload.json provided).
// ─────────────────────────────────────────────────────────────────────

export interface FoxxiAgenticPayload {
  readonly packageMeta: {
    readonly course_id: string;
    readonly course_label: string;
    readonly title: string;
    readonly federation_iri_base: string;
  };
  readonly concepts: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly confidence: number;
    readonly tier?: number;
    readonly is_free_standing?: boolean;
    readonly taught_in_slides: readonly string[];
    readonly total_freq?: number;
  }>;
  readonly slides: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly sequence_index: number;
    readonly concept_ids?: readonly string[];
    readonly transcript_combined?: string;
  }>;
  readonly modifier_pairs?: ReadonlyArray<{ modifier: string; target: string }>;
  readonly prereq_edges?: ReadonlyArray<{ from: string; to: string; confidence?: number }>;
}

export function payloadToAgenticCourse(p: FoxxiAgenticPayload, authoritativeSource: IRI): FoxxiAgenticCourse {
  return {
    courseIri: `${p.packageMeta.federation_iri_base}#package` as IRI,
    title: p.packageMeta.title,
    courseLabel: p.packageMeta.course_label,
    courseId: p.packageMeta.course_id,
    authoritativeSource,
    concepts: p.concepts.map(c => ({
      id: c.id,
      label: c.label,
      confidence: c.confidence,
      tier: c.tier ?? 3,
      is_free_standing: c.is_free_standing,
      taught_in_slides: c.taught_in_slides,
      total_freq: c.total_freq,
    })),
    slides: p.slides.map(s => ({
      id: s.id,
      title: s.title,
      sequence_index: s.sequence_index,
      concept_ids: s.concept_ids ?? [],
      transcript_combined: s.transcript_combined ?? '',
    })),
    modifier_pairs: p.modifier_pairs ?? [],
    prereq_edges: p.prereq_edges ?? [],
  };
}

/**
 * Adapter from the simpler FoxxiCourseContent shape (transcripts +
 * concepts, no slides) used by the existing course-qa.ts. Builds an
 * agentic course with one synthetic slide per transcript so the
 * agentic-rag pipeline can run on the same content.
 */
export function courseContentToAgenticCourse(c: FoxxiCourseContent, courseLabel: string): FoxxiAgenticCourse {
  const slides = Object.entries(c.transcripts).map(([path, t], i) => ({
    id: `synthetic:${path}`,
    title: `Audio segment ${i + 1}`,
    sequence_index: i,
    concept_ids: [] as string[],
    transcript_combined: t.text,
  }));
  // Map each concept to the slides whose transcript contains the concept label.
  const concepts = c.concepts.map(co => {
    const lower = co.label.toLowerCase();
    const taughtIn = slides
      .filter(s => s.transcript_combined.toLowerCase().includes(lower))
      .map(s => s.id);
    return {
      id: co.id,
      label: co.label,
      confidence: co.confidence,
      tier: co.tier,
      taught_in_slides: (co.taught_in_slides && co.taught_in_slides.length > 0) ? co.taught_in_slides : taughtIn,
    };
  });
  // Reverse: tell each slide which concepts it teaches.
  const slidesWithConcepts = slides.map(s => ({
    ...s,
    concept_ids: concepts.filter(co => co.taught_in_slides.includes(s.id)).map(co => co.id),
  }));
  return {
    courseIri: c.courseIri,
    title: c.title,
    courseLabel: c.title.replace(/:.*/, '').trim(),
    courseId: c.courseIri.split('/').pop()?.replace(/#.*/, '') ?? 'unknown',
    authoritativeSource: c.authoritativeSource,
    concepts,
    slides: slidesWithConcepts,
    modifier_pairs: [],
    prereq_edges: [],
  };
}
