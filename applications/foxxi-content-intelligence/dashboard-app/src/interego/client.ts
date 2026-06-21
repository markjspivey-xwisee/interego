/**
 * Interego client for the Foxxi dashboard.
 *
 * Two transports:
 *
 *   1. **Bridge MCP (Path B)** — default. Calls
 *      `${VITE_FOXXI_BRIDGE_URL}/mcp` with JSON-RPC `tools/call`.
 *      The bridge composes the substrate's vertical-bridge factory +
 *      handlers in applications/foxxi-content-intelligence/src/.
 *
 *   2. **Offline sample fallback** — if the bridge is unreachable on
 *      first probe, the client switches to in-process sample data
 *      bundled at build time (the imported/ Acme Training Co tenant
 *      payload). Lets adopters click around without standing up the
 *      bridge.
 *
 * Path A (generic affordance walk via `discover_context`) is also
 * possible from this client — the bridge serves a iep:Affordance
 * manifest at GET /affordances — but Path B is simpler for a
 * dashboard's named-tool use case.
 */

import { SAMPLE_ADMIN_PAYLOAD, SAMPLE_LESSON_PAYLOADS } from '../sample/data.js';
import type { AdminPayload, CourseContent, EnrolledCourse } from '../types.js';

const BRIDGE_URL = (import.meta.env.VITE_FOXXI_BRIDGE_URL as string | undefined) ?? 'http://localhost:6080';

let probedTransport: 'bridge' | 'sample' | null = null;

async function probeBridge(): Promise<boolean> {
  try {
    const r = await fetch(`${BRIDGE_URL}/affordances`, {
      method: 'GET',
      headers: { Accept: 'text/turtle' },
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function transport(): Promise<'bridge' | 'sample'> {
  if (probedTransport === null) {
    probedTransport = (await probeBridge()) ? 'bridge' : 'sample';
    // eslint-disable-next-line no-console
    console.log(`[interego/client] transport=${probedTransport} (bridge=${BRIDGE_URL})`);
  }
  return probedTransport;
}

/**
 * Read the active session's bearer token from localStorage at call time.
 * Pulled per-call so token rotation (re-login, expiry) takes effect
 * immediately without needing to thread the session through every
 * client-side API.
 */
function readBearerToken(): string | undefined {
  try {
    const raw = localStorage.getItem('foxxi:session');
    if (!raw) return undefined;
    const s = JSON.parse(raw) as { bearerToken?: string };
    return s.bearerToken;
  } catch {
    return undefined;
  }
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const t = await transport();
  if (t === 'bridge') {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const bearer = readBearerToken();
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    const resp = await fetch(`${BRIDGE_URL}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    if (!resp.ok) throw new Error(`bridge ${name} failed: ${resp.status}`);
    const j: { result?: { content: [{ text: string }] }; error?: { message: string } } = await resp.json();
    if (j.error) throw new Error(`bridge ${name} error: ${j.error.message}`);
    if (!j.result) throw new Error(`bridge ${name}: no result`);
    const body = JSON.parse(j.result.content[0].text);
    // Bridge handlers signal handler-level errors by returning { error: "..." }
    // (e.g. caller-resolution failure, forbidden, missing args). Surface those
    // as thrown errors so callers' catch-blocks show a real message instead
    // of treating the error envelope as a valid result and crashing on missing
    // fields.
    if (body && typeof body === 'object' && typeof body.error === 'string') {
      throw new Error(`bridge ${name}: ${body.error}`);
    }
    return body as T;
  }
  // sample fallback — synthesize in-process
  return sampleHandle<T>(name, args);
}

// ─────────────────────────────────────────────────────────────────────
//  Offline sample fallback — synthesize the same call shapes
//  in-process so the dashboard works without the bridge running.
// ─────────────────────────────────────────────────────────────────────

function sampleHandle<T>(name: string, args: Record<string, unknown>): T {
  switch (name) {
    case 'foxxi.discover_assigned_courses': {
      const learnerWebId = String(args.learner_did);
      const admin = SAMPLE_ADMIN_PAYLOAD;
      const learner = admin.users.find(u => u.web_id === learnerWebId);
      if (!learner) return { learnerWebId, audienceTags: [], enrollments: [] } as unknown as T;
      const groups = admin.groups.filter(g => g.member_ids.includes(learner.user_id));
      const groupIds = new Set(groups.map(g => g.group_id));
      const enrollments: EnrolledCourse[] = [];
      for (const policy of admin.policies) {
        if (!policy.enabled) continue;
        if (!groupIds.has(policy.audience_group_id)) continue;
        const catEntry = admin.catalog.find(c => c.course_id === policy.course_id);
        if (!catEntry) continue;
        const ev = admin.events.find(e => e.user_id === learner.user_id && e.course_id === policy.course_id);
        enrollments.push({
          courseId: policy.course_id,
          courseTitle: policy.course_title,
          category: catEntry.category,
          requirementType: policy.requirement_type,
          policyId: policy.policy_id,
          assignedAt: ev?.assigned_at ?? policy.created_at,
          dueAt: ev?.due_at ?? '',
          status: (ev?.status as EnrolledCourse['status']) ?? 'pending',
          completedAt: ev?.completed_at ?? undefined,
        });
      }
      return {
        learnerWebId,
        learnerName: learner.name,
        audienceTags: learner.audience_tags,
        enrollments,
      } as unknown as T;
    }
    case 'foxxi.ask_course_question': {
      // Local stub: do simple keyword-overlap against the supplied
      // transcripts so the UI demonstrates the SHAPE of a grounded
      // response without re-implementing the substrate's groundedAnswer.
      // (When the bridge is up, the live verifier runs.)
      const course = args.course_content as CourseContent;
      const question = String(args.question).toLowerCase();
      const words = question.split(/\s+/).filter(w => w.length > 3);
      const citations = [];
      for (const [path, t] of Object.entries(course.transcripts)) {
        const text = t.text.toLowerCase();
        let overlap = 0;
        for (const w of words) if (text.includes(w)) overlap++;
        if (overlap >= Math.max(1, Math.floor(words.length / 3))) {
          citations.push({
            atomIri: `${course.courseIri}#transcript:${encodeURIComponent(path)}`,
            verbatimQuote: t.text,
            fromTrainingContent: course.courseIri,
            fromTrainingContentName: course.title,
          });
          if (citations.length >= 8) break;
        }
      }
      const grounded = citations.length > 0;
      return {
        grounded,
        answer: grounded
          ? { displayText: '(sample-mode citations from offline transcripts)', citations }
          : null,
      } as unknown as T;
    }
    case 'foxxi.retrieve_course_context':
    case 'foxxi.ask_course_question_agentic': {
      // Offline-mode synthesis of the agentic call so the dashboard
      // demonstrates the SHAPE without needing the bridge. Light
      // concept-overlap retrieval + no LLM synthesis (just the
      // scaffold + the 4-step descriptor trace).
      const primary = args.primary as AgenticCoursePayload;
      const federation = (args.federation as AgenticCoursePayload[] | undefined) ?? [];
      const allCourses = [primary, ...federation];
      const q = String(args.question).toLowerCase();
      const qTokens = q.split(/\W+/).filter(t => t.length >= 4);
      const seedConcepts: AgenticSeedConcept[] = [];
      for (const course of allCourses) {
        for (const c of course.concepts) {
          let score = 0;
          const lower = c.label.toLowerCase();
          for (const t of qTokens) {
            if (lower === t) score += 5;
            else if (lower.includes(t)) score += 2;
            else if (t.includes(lower) && lower.length >= 4) score += 1;
          }
          const freeStanding = c.is_free_standing ?? ((c.tier ?? 3) <= 2);
          if (!freeStanding) score *= 0.5;
          if (score > 0) {
            seedConcepts.push({
              course: { courseId: course.packageMeta.course_id, courseLabel: course.packageMeta.course_label },
              conceptId: c.id, conceptLabel: c.label, score,
            });
          }
        }
      }
      seedConcepts.sort((a, b) => b.score - a.score);
      const topSeeds = seedConcepts.slice(0, 6);
      const citedSlides: AgenticCitedSlide[] = [];
      const seenSlides = new Set<string>();
      for (const seed of topSeeds) {
        const course = allCourses.find(c => c.packageMeta.course_id === seed.course.courseId)!;
        const concept = course.concepts.find(c => c.id === seed.conceptId)!;
        for (const sid of concept.taught_in_slides) {
          const slide = course.slides.find(s => s.id === sid);
          if (!slide) continue;
          const key = `${course.packageMeta.course_id}:${sid}`;
          if (seenSlides.has(key)) continue;
          seenSlides.add(key);
          citedSlides.push({
            course: { courseId: course.packageMeta.course_id, courseLabel: course.packageMeta.course_label },
            slideId: slide.id, slideTitle: slide.title, sequenceIndex: slide.sequence_index,
            transcriptCombined: slide.transcript_combined ?? '',
            conceptIds: slide.concept_ids ?? [],
          });
          if (citedSlides.length >= 5) break;
        }
        if (citedSlides.length >= 5) break;
      }
      const traceTime = new Date().toISOString();
      const traceId = `sample-${Date.now()}`;
      const qIri = `urn:iep:foxxi:trace:question:${traceId}`;
      const rIri = `urn:iep:foxxi:trace:retrieval:${traceId}`;
      const trace: AgenticTraceStep[] = [
        {
          iri: qIri, graphIri: `urn:graph:${qIri}`,
          type: 'fxa:LearnerQuestionEvent', modalStatus: 'Asserted',
          wasDerivedFrom: [],
          body: { learnerDid: args.learner_did, questionText: args.question, courseIri: `${primary.packageMeta.federation_iri_base}#package` },
          recordedAt: traceTime,
        },
        {
          iri: rIri, graphIri: `urn:graph:${rIri}`,
          type: 'fxa:RetrievalActivity', modalStatus: 'Hypothetical',
          wasDerivedFrom: [qIri],
          body: {
            retrievalKind: topSeeds.length > 0 ? 'graph' : 'fallback',
            seedConcepts: topSeeds,
            citedSlideIds: citedSlides.map(c => `${c.course.courseId}:${c.slideId}`),
            contributingCourseIds: [...new Set(topSeeds.map(s => s.course.courseId))],
          },
          recordedAt: traceTime,
        },
      ];
      const sourceForSample: AgenticLlmKeySource = name === 'foxxi.retrieve_course_context'
        ? 'mcp-client'
        : 'none';
      return {
        retrieval: {
          seedConcepts: topSeeds,
          expandedConcepts: topSeeds.map(s => ({
            course: s.course, conceptId: s.conceptId, conceptLabel: s.conceptLabel,
          })),
          citedSlides,
          retrievalKind: topSeeds.length > 0 ? 'graph' : 'fallback',
          contributingCourseIds: [...new Set(topSeeds.map(s => s.course.courseId))],
        },
        synthesizedAnswer: null,
        llmModel: name === 'foxxi.retrieve_course_context' ? 'mcp-client-as-llm (offline sample)' : 'no-llm (offline sample mode)',
        llmKeySource: sourceForSample,
        trace,
      } as unknown as T;
    }
    case 'foxxi.coverage_query': {
      const coverage = (args.coverage as { concept: string; taughtIn: string[] }[]) ?? [];
      const mode = (args.privacy_mode as string) ?? 'merkle-attested-opt-in';
      if (mode === 'abac') return { mode: 'abac', coverageCount: coverage.length } as unknown as T;
      return {
        mode,
        bundle: {
          count: coverage.length,
          merkleRoot: '(sample-mode merkle root — bridge gives the real one)',
          cohortIri: 'urn:foxxi:cohort:sample',
        },
      } as unknown as T;
    }
    default:
      throw new Error(`sample mode does not implement ${name}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Public API — typed wrappers per affordance
// ─────────────────────────────────────────────────────────────────────

export interface DiscoverAssignedCoursesResult {
  learnerWebId: string;
  learnerName?: string;
  audienceTags: string[];
  enrollments: EnrolledCourse[];
}

export async function discoverAssignedCourses(args: {
  learnerWebId: string;
  tenantPodUrl: string;
  admin?: AdminPayload; // bridge accepts; sample uses bundled
}): Promise<DiscoverAssignedCoursesResult> {
  return callTool('foxxi.discover_assigned_courses', {
    learner_did: args.learnerWebId,
    tenant_pod_url: args.tenantPodUrl,
    admin: args.admin ?? SAMPLE_ADMIN_PAYLOAD,
  });
}

export interface AskCourseQuestionResult {
  grounded: boolean;
  answer: null | {
    displayText: string;
    citations: Array<{
      atomIri: string;
      verbatimQuote: string;
      fromTrainingContent: string;
      fromTrainingContentName: string;
    }>;
  };
}

export async function askCourseQuestion(args: {
  learnerDid: string;
  courseIri: string;
  question: string;
  courseContent: CourseContent;
}): Promise<AskCourseQuestionResult> {
  return callTool('foxxi.ask_course_question', {
    course_iri: args.courseIri,
    learner_did: args.learnerDid,
    question: args.question,
    course_content: args.courseContent,
  });
}

// ─────────────────────────────────────────────────────────────────────
//  Agentic RAG
// ─────────────────────────────────────────────────────────────────────

export interface AgenticTraceStep {
  iri: string;
  graphIri: string;
  type: 'fxa:LearnerQuestionEvent' | 'fxa:RetrievalActivity' | 'fxa:LlmCompletion' | 'fxa:CitedAnswer';
  modalStatus: 'Asserted' | 'Hypothetical';
  wasDerivedFrom: string[];
  supersedes?: string;
  body: Record<string, unknown>;
  recordedAt: string;
}

export interface AgenticSeedConcept {
  course: { courseId: string; courseLabel: string };
  conceptId: string;
  conceptLabel: string;
  score: number;
}

export interface AgenticCitedSlide {
  course: { courseId: string; courseLabel: string };
  slideId: string;
  slideTitle: string;
  sequenceIndex: number;
  transcriptCombined: string;
  conceptIds: string[];
}

export type AgenticLlmKeySource = 'none' | 'bridge-env' | 'per-request-byok' | 'mcp-client';

export interface AskAgenticResult {
  retrieval: {
    seedConcepts: AgenticSeedConcept[];
    expandedConcepts: { course: { courseId: string; courseLabel: string }; conceptId: string; conceptLabel: string }[];
    citedSlides: AgenticCitedSlide[];
    retrievalKind: 'graph' | 'fallback';
    contributingCourseIds: string[];
  };
  synthesizedAnswer: string | null;
  llmModel: string;
  llmKeySource?: AgenticLlmKeySource;
  trace: AgenticTraceStep[];
}

export type LlmCallMode = 'bridge-env' | 'byok';

export async function askCourseQuestionAgentic(args: {
  learnerDid: string;
  question: string;
  primary: AgenticCoursePayload;
  federation?: AgenticCoursePayload[];
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  mode?: LlmCallMode;          // default 'bridge-env'
  byokKey?: string;            // honored when mode === 'byok'
  llmModel?: string;
}): Promise<AskAgenticResult> {
  const mode = args.mode ?? 'bridge-env';
  const extra: Record<string, unknown> = {};
  if (mode === 'byok' && args.byokKey) extra.llm_api_key = args.byokKey;
  if (args.llmModel) extra.llm_model = args.llmModel;
  return callTool('foxxi.ask_course_question_agentic', {
    learner_did: args.learnerDid,
    question: args.question,
    primary: args.primary,
    federation: args.federation ?? [],
    history: args.history ?? [],
    ...extra,
  });
}

export interface AgenticCoursePayload {
  packageMeta: { course_id: string; course_label: string; title: string; federation_iri_base: string };
  concepts: Array<{ id: string; label: string; confidence: number; tier?: number; is_free_standing?: boolean; taught_in_slides: string[]; total_freq?: number }>;
  slides: Array<{ id: string; title: string; sequence_index: number; concept_ids?: string[]; transcript_combined?: string }>;
  modifier_pairs?: Array<{ modifier: string; target: string }>;
  prereq_edges?: Array<{ from: string; to: string; confidence?: number }>;
}

export interface CoverageQueryResult {
  mode: 'abac' | 'merkle-attested-opt-in' | 'zk-distribution';
  coverageCount?: number;
  bundle?: { count: number; merkleRoot?: string; cohortIri?: string; bucketSumCommitments?: unknown[] };
}

export async function coverageQuery(args: {
  tenantPodUrl: string;
  coverage: { concept: string; taughtIn: string[]; mentionedIn: string[] }[];
  privacyMode?: 'abac' | 'merkle-attested-opt-in' | 'zk-distribution';
  epsilon?: number;
  distributionEdges?: string[];
  distributionMaxValue?: string;
}): Promise<CoverageQueryResult> {
  return callTool('foxxi.coverage_query', {
    tenant_pod_url: args.tenantPodUrl,
    coverage: args.coverage,
    privacy_mode: args.privacyMode ?? 'merkle-attested-opt-in',
    epsilon: args.epsilon,
    distribution_edges: args.distributionEdges,
    distribution_max_value: args.distributionMaxValue,
  });
}

export function getCourseContent(courseId: string): CourseContent | undefined {
  return SAMPLE_LESSON_PAYLOADS[courseId];
}

export function getBridgeUrl(): string {
  return BRIDGE_URL;
}

export async function getTransport(): Promise<'bridge' | 'sample'> {
  return transport();
}

export function resetTransportProbe(): void {
  probedTransport = null;
}
