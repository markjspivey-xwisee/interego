/**
 * foxxi-content-intelligence bridge — opinionated MCP-named-tool
 * surface over the Foxxi vertical.
 *
 * Generic agents don't need this — they can discover + invoke this
 * vertical's affordances via the protocol's cg:Affordance manifest at
 * GET /affordances. The bridge is just an ergonomic accelerant for
 * clients that prefer named MCP tools.
 *
 * Run:
 *   PORT=6080 BRIDGE_DEPLOYMENT_URL=http://localhost:6080 \
 *     FOXXI_TENANT_POD_URL=https://your-pod.example/markj/ \
 *     FOXXI_AUTHORITATIVE_SOURCE=did:web:your-tenant.example \
 *     npx tsx server.ts
 *
 * Audience split (per docs/DEPLOYMENT-SPLIT.md):
 *   FOXXI_AUDIENCE=learner   → expose foxxiAffordances only
 *   FOXXI_AUDIENCE=admin     → expose foxxiAdminAffordances only
 *   FOXXI_AUDIENCE=both      → expose both (default)
 */

import { randomUUID } from 'node:crypto';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { foxxiAffordances, foxxiAdminAffordances } from '../affordances.js';
import {
  ingestContentPackage,
  publishAuthoringPolicy,
  assignAudience,
  coverageQuery,
  type AuthoringPolicy,
  type AudienceAssignment,
  type ParsedFoxxiPackage,
  type CoverageQueryArgs,
} from '../src/publisher.js';
import {
  discoverAssignedCourses,
  type FoxxiAdminPayload,
} from '../src/enrollment.js';
import {
  askCourseQuestion,
  type FoxxiCourseContent,
} from '../src/course-qa.js';
import {
  askAgenticRag,
  retrieveCourseContext,
  payloadToAgenticCourse,
  courseContentToAgenticCourse,
  type FoxxiAgenticPayload,
} from '../src/agentic-rag.js';
import {
  fetchAdminPayload,
  fetchCoursePackage,
} from '../src/tenant-fetcher.js';
import {
  issueCourseCompletionCredential,
  type CourseCompletionSubject,
} from '../src/credentials.js';
import { exportClr } from '../src/clr.js';
import { envelopeToClr1 } from '../src/clr-1.js';
import { assembleEnterpriseLearnerRecord, PERFORMED_VERB, PERF_EXT } from '../src/learner-record.js';
import { proveCompetency } from '../src/competency-proof.js';
import {
  buildTrajectory, trajectoryShape, projectTrajectoryToXapi,
  type AgentTrajectory, type TrajectoryStepInput,
} from '../src/agent-trajectory.js';
import {
  assessDisposition, buildProbe, computeCausalRead, snapshot,
  type PerformanceProbe, type ProbeCoherence,
} from '../src/agent-disposition.js';
import { ingestExternalRun, type ExternalRunInput, type ToolCallInput, type HarnessMeta } from '../src/agent-run-ingest.js';
import { EvaluationRegistry, type CandidateRun } from '../src/agent-evaluation.js';
import { comparePortfolio, type CandidateEvidence } from '../src/agent-portfolio.js';

/** Agentic-native trajectory store — the source of truth (modal +
 *  poly-granular), keyed by agent DID. xAPI statements are projected
 *  off it into the LRS; the native form here keeps what xAPI drops. */
const agentTrajectories = new Map<string, AgentTrajectory>();
const AGENT_TRAJECTORY_MAX = 5_000;

/** Performance-probe store — safe-to-fail do(x) interventions, keyed by
 *  team key (sorted agent DIDs). A team accumulates a probe portfolio. */
const performanceProbes = new Map<string, PerformanceProbe[]>();
const teamKey = (dids: readonly string[]): string => [...dids].sort().join('|');

/** Agent-evaluation cohort registry — competing agents/harnesses brought
 *  together for a head-to-head portfolio read. Cross-pod: a candidate's
 *  DID may live on another team's pod. In-memory (demo-sized); the runs'
 *  xAPI evidence persists durably in Foxxi-as-LRS regardless. */
const evaluationRegistry = new EvaluationRegistry();
import { frameworkToCase, type FoxxiSkillFramework } from '../src/case-exporter.js';
import { buildPassedSessionTrace } from '../src/cmi5.js';
import { pushFrameworkToCass } from '../src/cass-connector.js';
import { resolveDid } from '../../../src/solid/did-resolver.js';
import { queryFederatedStatements, type FederatedLrsEndpoint } from '../../lrs-adapter/src/experience-index.js';
import {
  issueBbsCompletionCredential,
  deriveCompletionPresentation,
  verifyCompletionPresentation,
  type BbsIssuedCredential,
  type CredentialPresentation,
} from '../src/bbs-credentials.js';
import {
  launchAuWithPrereqCheck,
  aiAssessCompetency,
  countersignAssessment,
  composeAuditTrail,
  type CompetencyAssessment,
} from '../src/composed-flows.js';
import {
  serializeAlignment,
  resolveAlignment,
  type FrameworkAlignment,
  type SerializedAlignment,
  type AlignmentRelation,
} from '../src/framework-alignment.js';
import { gatherCohortQA, summarizeCohort, type CohortIntelligence } from '../src/cohort-intel.js';
import {
  bootstrapTenant,
  deriveAdaptivePolicy,
  scheduleSpacedRepetition,
  discoverFrameworkRegistry,
  rankTutorsForCompetency,
  type TutorAgentProfile,
  composeDpia,
  buildManagerTeamView,
  uploadScormPackage,
  buildTenantDidDocument,
  backupTenantPod,
} from '../src/composed-extensions.js';
import {
  listScormCloudCourses,
  scormCloudToCatalogEntries,
  createScormCloudRegistration,
  type ScormCloudConfig,
} from '../src/scorm-cloud.js';
import {
  recordCall,
  recordRateLimit,
  recordAuthFailure,
  recordBbsProof,
  recordVcIssued,
  renderMetrics,
  metricsJson,
} from '../src/observability.js';
import {
  designAbExperiment,
  estimateConceptDifficulty,
  analyzeLearningCurve,
  calibrateMasteryThreshold,
  frameworkGapAnalysis,
} from '../src/learning-engineering.js';
import { verifySessionToken, buildAddressMap, type SessionToken } from '../src/auth.js';
import {
  resolveCallerContext,
  emitAccessDecision,
  type CallerContext,
} from '../src/policy.js';
import { deriveAdminKeyPair } from '../src/tenant-publisher.js';
import { attachXapiLrsRoutes, listStoredStatements, storeStatementInternal } from '../src/xapi-lrs.js';
import { attachLti13Routes } from '../src/lti13.js';
import { attachOneRosterRoutes } from '../src/oneroster.js';
import { attachOpenApiRoutes } from '../src/openapi-spec.js';
import { renderVocabJsonLd, renderVocabTurtle, renderTermJsonLd } from '../src/foxxi-vocab.js';
import { renderSemOntologyJsonLd, renderSemOntologyTurtle, renderSemTermJsonLd } from '../src/ler-tla-vocab.js';
import { emitAffordanceStatement } from '../src/xapi-instrumentation.js';
import { attachXapiAdminRoutes } from '../src/xapi-admin.js';
import { attachOauthTokenRoute } from '../src/xapi-oauth.js';
import { attachHypermediaRoutes } from '../src/hypermedia-resources.js';
import type { IRI } from '../../../src/index.js';

const tenantPodUrl = process.env.FOXXI_TENANT_POD_URL ?? '';
const authoritativeSource = (process.env.FOXXI_AUTHORITATIVE_SOURCE ?? 'did:web:foxxi.example') as IRI;
const adminWebId = process.env.FOXXI_ADMIN_WEB_ID ?? '';
const adminKeySeed = process.env.FOXXI_ADMIN_KEY_SEED ?? '';
const issuerKeySeed = process.env.FOXXI_ISSUER_KEY_SEED ?? '';
const tenantProfileDid = process.env.FOXXI_TENANT_PROFILE_DID ?? authoritativeSource;
const tenantProfileName = process.env.FOXXI_TENANT_PROFILE_NAME ?? 'Acme Training Co L&D';
const walletSeed = process.env.FOXXI_WALLET_SEED;
const requireAuth = (process.env.FOXXI_REQUIRE_AUTH ?? 'true').toLowerCase() !== 'false';

// Learning Engineer role — comma-separated list of WebIDs that get the
// learning-engineer role. LE = cohort + content analytics read-only.
const learningEngineerWebIds = new Set(
  (process.env.FOXXI_LEARNING_ENGINEER_WEB_IDS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean),
);

if (!adminKeySeed) {
  console.warn('[foxxi-bridge] WARNING: FOXXI_ADMIN_KEY_SEED is unset — admin sections cannot be decrypted; learner queries will fail. Set FOXXI_ADMIN_KEY_SEED to the same seed used at publish time.');
}
if (!adminWebId) {
  console.warn('[foxxi-bridge] WARNING: FOXXI_ADMIN_WEB_ID is unset — role resolution can never elevate any caller to admin role.');
}
if (!issuerKeySeed) {
  console.warn('[foxxi-bridge] WARNING: FOXXI_ISSUER_KEY_SEED is unset — foxxi.issue_completion_credential will fail; set this to the tenant\'s persistent issuer-key seed (different from FOXXI_ADMIN_KEY_SEED).');
}

const adminKeyPair = adminKeySeed ? deriveAdminKeyPair(adminKeySeed) : undefined;

// ── Per-IP rate limiting (LLM-call protection) ──────────────────────────
//
// The agentic ask handler calls Anthropic with the bridge's own API key,
// so unauthenticated visitors hitting the microsite could in principle
// run up the operator's bill. A simple fixed-window per-IP cap protects
// against casual abuse without bringing in a separate service.

const RL_AGENTIC_WINDOW_MS = 5 * 60 * 1000; // 5 min
const RL_AGENTIC_MAX = parseInt(process.env.FOXXI_AGENTIC_RATE_LIMIT_PER_IP ?? '10', 10);
const agenticRateLimit = new Map<string, { count: number; resetAt: number }>();

function checkAgenticRateLimit(clientIp: string): { ok: true; remaining: number } | { ok: false; resetAt: number; retryAfterSeconds: number } {
  const now = Date.now();
  let entry = agenticRateLimit.get(clientIp);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RL_AGENTIC_WINDOW_MS };
    agenticRateLimit.set(clientIp, entry);
  }
  entry.count++;
  // Prune occasionally to stop the map from growing unboundedly.
  if (agenticRateLimit.size > 5000) {
    for (const [k, v] of agenticRateLimit.entries()) {
      if (v.resetAt < now) agenticRateLimit.delete(k);
    }
  }
  if (entry.count > RL_AGENTIC_MAX) {
    return { ok: false, resetAt: entry.resetAt, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { ok: true, remaining: RL_AGENTIC_MAX - entry.count };
}

function fetcherConfig() {
  return {
    podUrl: tenantPodUrl,
    authoritativeSource,
    adminKeyPair,
  };
}

function configOrThrow(args: Record<string, unknown>): { tenantPodUrl: string; authoritativeSource: IRI } {
  const pod = (args.tenant_pod_url as string) || tenantPodUrl;
  if (!pod) throw new Error('foxxi bridge: tenant_pod_url required (or set FOXXI_TENANT_POD_URL).');
  return { tenantPodUrl: pod, authoritativeSource };
}

async function autoFetchAdmin(args: Record<string, unknown>): Promise<FoxxiAdminPayload | null> {
  const podUrl = (args.tenant_pod_url as string) || tenantPodUrl;
  if (!podUrl) return null;
  try {
    return await fetchAdminPayload({ ...fetcherConfig(), podUrl }) as FoxxiAdminPayload;
  } catch (err) {
    console.error('[foxxi-bridge] autoFetchAdmin failed:', (err as Error).message);
    return null;
  }
}

async function autoFetchCourse(args: Record<string, unknown>, courseId: string): Promise<FoxxiAgenticPayload | null> {
  const podUrl = (args.tenant_pod_url as string) || tenantPodUrl;
  if (!podUrl) return null;
  try {
    return await fetchCoursePackage(courseId, { ...fetcherConfig(), podUrl }) as FoxxiAgenticPayload;
  } catch (err) {
    console.error('[foxxi-bridge] autoFetchCourse failed:', (err as Error).message);
    return null;
  }
}

/**
 * Resolve the caller's identity + role for a given request. Returns null
 * if auth is required and the token is missing/invalid (the handler
 * surfaces the 401-equivalent in its response).
 *
 * The address-map is built from the published tenant directory's
 * wallet_address fields, which were attached at publish time via the
 * same deterministic-derivation function the dashboard uses to sign.
 */
async function resolveCaller(args: Record<string, unknown>): Promise<{ ctx: CallerContext; admin: FoxxiAdminPayload } | { error: string }> {
  const admin = await autoFetchAdmin(args);
  if (!admin) return { error: 'tenant pod is not seeded or cannot be decrypted; auth resolution requires the directory' };

  const token = (args.__caller_token as string | undefined);
  if (!token) {
    if (!requireAuth) {
      // Anonymous mode for dev — synthesize an admin caller. Production
      // should always run with FOXXI_REQUIRE_AUTH=true.
      return {
        ctx: { webId: adminWebId, userId: 'anonymous', role: 'admin', directReports: new Set() },
        admin,
      };
    }
    return { error: 'missing session token — pass Authorization: Bearer <token>' };
  }

  const addressMap = buildAddressMap((admin.users as Array<{ user_id: string; web_id: string; wallet_address?: string }>) ?? []);
  const verified = verifySessionToken(token, addressMap);
  if (!verified.ok) return { error: `auth: ${verified.reason}` };

  const ctx = resolveCallerContext({
    callerWebId: verified.callerDid,
    callerUserId: verified.callerUserId,
    users: admin.users,
    adminWebId,
    learningEngineerWebIds,
  });
  return { ctx, admin };
}

// ── Handlers ───────────────────────────────────────────────────────────

const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  // ── Learner-side ────────────────────────────────────────────────────
  'foxxi.discover_assigned_courses': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx, admin } = resolved;

    // AuthZ: caller can only ask about themselves, their direct reports, or any if admin.
    const requestedLearnerDid = args.learner_did as string;
    if (ctx.role !== 'admin' && requestedLearnerDid !== ctx.webId) {
      const targetUser = admin.users.find(u => u.web_id === requestedLearnerDid);
      const isDirectReport = !!(targetUser && ctx.directReports.has(targetUser.user_id));
      if (!isDirectReport) {
        const trace = emitAccessDecision({ ctx, tool: 'foxxi.discover_assigned_courses', decision: 'deny', appliedPolicies: ['learner-self', 'manager-direct-reports'] });
        return { error: `forbidden — caller ${ctx.webId} (role: ${ctx.role}) cannot query enrollments for ${requestedLearnerDid}`, accessDecision: trace };
      }
    }

    // discoverAssignedCourses already returns ONLY the queried learner's
    // enrollments — no further response filtering needed for this tool.
    const result = discoverAssignedCourses({
      admin,
      learnerWebId: requestedLearnerDid,
      audienceTagsOverride: args.audience_tags as readonly string[] | undefined,
    });
    const trace = emitAccessDecision({
      ctx,
      tool: 'foxxi.discover_assigned_courses',
      decision: 'allow',
      appliedPolicies: [ctx.role === 'admin' ? 'admin-full-access' : ctx.role === 'manager' ? 'manager-direct-reports' : 'learner-self'],
    });
    return { ...result, accessDecision: trace };
  },

  'foxxi.consume_lesson': async (args) => {
    // Real implementation streams the parsed lesson + emits xAPI via lrs-adapter.
    return { consumed: false, note: 'stub: bridge handler not yet wired; compose with applications/lrs-adapter/' };
  },

  'foxxi.ask_course_question': async (args) => {
    if (!args.course_content) {
      return {
        note: 'stub: pass args.course_content (FoxxiCourseContent — transcripts + concepts). Real bridge fetches from tenant pod via published fxs/fxk descriptors.',
      };
    }
    return askCourseQuestion({
      learnerDid: args.learner_did as IRI,
      course: args.course_content as FoxxiCourseContent,
      question: args.question as string,
    });
  },

  'foxxi.ask_course_question_agentic': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;

    // Per-IP rate limit — protects the operator's Anthropic bill when
    // this handler uses the bridge-side env key. Caller's BYOK path is
    // exempt (they pay their own bill).
    const byokPresent = !!(args.llm_api_key as string | undefined)?.trim();
    if (!byokPresent && process.env.FOXXI_LLM_API_KEY) {
      const ip = (args.__client_ip as string | undefined) ?? 'unknown';
      const rl = checkAgenticRateLimit(ip);
      if (!rl.ok) {
        return {
          error: `rate limit exceeded — ${RL_AGENTIC_MAX} agentic ask calls per ${Math.round(RL_AGENTIC_WINDOW_MS / 60000)} min per IP. Retry in ${rl.retryAfterSeconds}s, or supply your own key via llm_api_key (BYOK is rate-limit-exempt).`,
          retryAfterSeconds: rl.retryAfterSeconds,
        };
      }
    }

    let primaryPayload = args.primary as FoxxiAgenticPayload | undefined;
    if (!primaryPayload && !args.course_content && args.course_id) {
      primaryPayload = await autoFetchCourse(args, args.course_id as string) ?? undefined;
    }
    if (!primaryPayload && !args.course_content) {
      return {
        note: 'No course payload available. Supply args.primary (FoxxiAgenticPayload) inline, OR pass args.course_id and seed the tenant pod via tools/publish-tenant.ts so the bridge can discover it via cg:discover() filtered on dct:conformsTo=fxa:CoursePackageBundle.',
        podUrl: (args.tenant_pod_url as string) || tenantPodUrl,
      };
    }

    // Use the authenticated learner's webId on the trace, ignoring any
    // spoofed learner_did in args. The substrate primitive accepts a
    // learner_did arg for offline-sample-mode flexibility; in
    // authenticated mode the bridge always uses the verified caller.
    args.learner_did = ctx.webId;
    const primary = primaryPayload
      ? payloadToAgenticCourse(primaryPayload, (args.authoritative_source as IRI) ?? authoritativeSource)
      : courseContentToAgenticCourse(args.course_content as FoxxiCourseContent, 'Course');
    const federation = (args.federation as FoxxiAgenticPayload[] | undefined ?? []).map(p =>
      payloadToAgenticCourse(p, (args.authoritative_source as IRI) ?? 'did:web:foxxi.example' as IRI),
    );
    // LLM key precedence: per-request BYOK > server-side env.
    // BYOK is used transiently for the one LLM call — bridge does not
    // persist or log it. Caller (browser dashboard / MCP client / SDK)
    // is responsible for transport security (TLS to the bridge).
    const byokKey = (args.llm_api_key as string | undefined)?.trim();
    const envKey = (process.env.FOXXI_LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY)?.trim();
    const llmApiKey = byokKey || envKey;
    const llmKeySource = byokKey ? 'per-request-byok' as const
      : envKey ? 'bridge-env' as const
      : undefined;
    return askAgenticRag({
      question: args.question as string,
      learnerDid: args.learner_did as IRI,
      primary,
      federation,
      history: args.history as { role: 'user' | 'assistant'; content: string }[] | undefined,
      llmModel: args.llm_model as string | undefined,
      llmApiKey,
      llmKeySource,
    });
  },

  'foxxi.retrieve_course_context': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    args.learner_did = ctx.webId; // bind to authenticated identity

    let primaryPayload = args.primary as FoxxiAgenticPayload | undefined;
    if (!primaryPayload && args.course_id) {
      primaryPayload = await autoFetchCourse(args, args.course_id as string) ?? undefined;
    }
    if (!primaryPayload) {
      return { note: 'No course payload available. Supply args.primary or args.course_id (with pod seeded).' };
    }
    const primary = payloadToAgenticCourse(primaryPayload, (args.authoritative_source as IRI) ?? authoritativeSource);
    const federation = (args.federation as FoxxiAgenticPayload[] | undefined ?? []).map(p =>
      payloadToAgenticCourse(p, (args.authoritative_source as IRI) ?? authoritativeSource),
    );
    return retrieveCourseContext({
      question: args.question as string,
      learnerDid: args.learner_did as IRI,
      primary,
      federation,
    });
  },

  'foxxi.explore_concept_map': async (args) => {
    // Real implementation fetches fxk: descriptors + builds nav graph.
    return { concepts: [], edges: [], note: 'stub: bridge handler not yet wired; pulls the published concept map artifact' };
  },

  // ── Admin-side ───────────────────────────────────────────────────────
  'foxxi.ingest_content_package': async (args) => {
    const config = configOrThrow(args);
    // The real parse runs the Python parser (imported/foxxi_storyline_parser_v03.py)
    // out-of-process. The bridge handler accepts the ALREADY-parsed payload
    // here for the substrate composition step. Stub returns a placeholder.
    if (!args.parsed) {
      return {
        note: 'stub: supply args.parsed (ParsedFoxxiPackage) — production wiring runs the Python parser on args.zip_base64 then calls this',
      };
    }
    return ingestContentPackage({
      parsed: args.parsed as ParsedFoxxiPackage,
      config,
    });
  },

  'foxxi.publish_authoring_policy': async (args) => {
    const config = configOrThrow(args);
    const policy: AuthoringPolicy = {
      acceptedTools: (args.accepted_tools as string[]) ?? [],
      acceptedStandards: (args.accepted_standards as string[]) ?? [],
      effectiveFrom: (args.effective_from as string) ?? new Date().toISOString(),
    };
    return publishAuthoringPolicy({ policy, config });
  },

  'foxxi.connect_lms': async (args) => {
    // Skeleton: composes with src/connectors/ in the real wiring.
    void args;
    return { note: 'stub: bridge handler not yet wired to src/connectors/ — affordance is discoverable' };
  },

  'foxxi.assign_audience': async (args) => {
    const config = configOrThrow(args);
    const assignment: AudienceAssignment = {
      courseIri: args.course_iri as IRI,
      audienceTag: args.audience_tag as string,
      requirementType: (args.requirement_type as 'required' | 'recommended') ?? 'recommended',
      trigger: (args.trigger as 'on-hire' | 'on-role-change' | 'on-cycle' | 'manual') ?? 'manual',
      dueRelativeDays: (args.due_relative_days as number) ?? 30,
    };
    return assignAudience({ assignment, config });
  },

  'foxxi.coverage_query': async (args) => {
    const config = configOrThrow(args);
    const q: CoverageQueryArgs = {
      config,
      coverage: (args.coverage as CoverageQueryArgs['coverage']) ?? [],
      privacyMode: args.privacy_mode as CoverageQueryArgs['privacyMode'],
      epsilon: args.epsilon as number | undefined,
      distributionEdges: args.distribution_edges
        ? (args.distribution_edges as string[]).map(BigInt)
        : undefined,
      distributionMaxValue: args.distribution_max_value
        ? BigInt(args.distribution_max_value as string)
        : undefined,
    };
    return coverageQuery(q);
  },

  'foxxi.publish_concept_map': async (args) => {
    // Skeleton: would re-publish the fxk: stratum graph with explicit share_with.
    void args;
    return { note: 'stub: bridge handler not yet wired to re-publish the fxk stratum with share_with' };
  },

  'foxxi.publish_compliance_evidence': async (args) => {
    // Skeleton: composes with integrations/compliance-overlay/ + src/ops/.
    void args;
    return { note: 'stub: bridge handler not yet wired to compliance-overlay — wire via recordAgentAction' };
  },

  // ── Credentialing (ADL TLA / IEEE LERS / 1EdTech CLR 2.0) ────────────

  'foxxi.issue_completion_credential': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'admin') {
      const trace = emitAccessDecision({ ctx, tool: 'foxxi.issue_completion_credential', decision: 'deny', appliedPolicies: ['admin-full-access'] });
      return { error: `forbidden — only admins can issue completion credentials (caller role: ${ctx.role})`, accessDecision: trace };
    }
    if (!issuerKeySeed) {
      return { error: 'bridge is not configured to issue credentials — FOXXI_ISSUER_KEY_SEED is unset' };
    }
    const learnerPodUrl = (args.learner_pod_url as string) || tenantPodUrl;
    const subject: CourseCompletionSubject = {
      learnerDid: args.learner_did as string,
      learnerName: args.learner_name as string | undefined,
      courseId: args.course_id as string,
      courseTitle: args.course_title as string,
      courseDescription: args.course_description as string | undefined,
      criterionNarrative: args.criterion_narrative as string | undefined,
      alignedSkills: args.aligned_skills as CourseCompletionSubject['alignedSkills'],
      evidence: args.evidence as CourseCompletionSubject['evidence'],
      derivedFromExperiences: args.derived_from_experiences as readonly string[] | undefined,
    };
    const result = await issueCourseCompletionCredential({
      subject,
      tenantProfileDid,
      tenantProfileName,
      issuerSeed: issuerKeySeed,
      learnerPodUrl,
    });
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.issue_completion_credential', decision: 'allow', appliedPolicies: ['admin-full-access'] });
    return {
      issuerDid: result.vc.issuer,
      credentialId: result.vc.id,
      descriptorUrl: result.publishResult.descriptorUrl,
      graphUrl: result.publishResult.graphUrl,
      vc: result.vc,
      accessDecision: trace,
    };
  },

  'foxxi.export_clr': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const requestedLearnerDid = args.learner_did as string;
    if (ctx.role !== 'admin' && requestedLearnerDid !== ctx.webId) {
      const trace = emitAccessDecision({ ctx, tool: 'foxxi.export_clr', decision: 'deny', appliedPolicies: ['learner-self'] });
      return { error: `forbidden — non-admins can only export their own CLR`, accessDecision: trace };
    }
    const learnerPodUrl = (args.learner_pod_url as string) || tenantPodUrl;
    const envelope = await exportClr({
      learnerPodUrl,
      learnerDid: requestedLearnerDid,
    });
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.export_clr', decision: 'allow', appliedPolicies: [ctx.role === 'admin' ? 'admin-full-access' : 'learner-self'] });
    return { ...envelope, accessDecision: trace };
  },

  'foxxi.assemble_learner_record': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const requestedLearnerDid = (args.learner_did as string) || ctx.webId;
    const subjectKind: 'human' | 'agent' = (args.actor_kind as string) === 'agent' ? 'agent' : 'human';
    // Human records are private (self/admin only). Agent capability
    // records are discoverable — like the public agent registry — so any
    // authenticated caller may assemble one.
    if (subjectKind === 'human' && ctx.role !== 'admin' && requestedLearnerDid !== ctx.webId) {
      const trace = emitAccessDecision({ ctx, tool: 'foxxi.assemble_learner_record', decision: 'deny', appliedPolicies: ['learner-self'] });
      return { error: 'forbidden — non-admins can only assemble their own human learner record', accessDecision: trace };
    }
    // Pull the subject's xAPI experiences + performance records from Foxxi-as-LRS.
    const allStatements = await listStoredStatements();
    const learnerStatements = allStatements.filter(rec => {
      const a = rec.statement.actor as { account?: { name?: string; homePage?: string }; mbox?: string } | undefined;
      return a?.account?.name === requestedLearnerDid
        || a?.account?.homePage === requestedLearnerDid
        || a?.mbox === requestedLearnerDid;
    });
    const elr = await assembleEnterpriseLearnerRecord({
      learnerDid: requestedLearnerDid,
      learnerName: args.learner_name as string | undefined,
      learnerPodUrl: (args.learner_pod_url as string) || tenantPodUrl,
      subjectKind,
      tenantDid: tenantProfileDid,
      lrsEndpoint: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080',
      statements: learnerStatements,
    });
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.assemble_learner_record', decision: 'allow', appliedPolicies: [subjectKind === 'agent' ? 'agent-capability-public' : ctx.role === 'admin' ? 'admin-full-access' : 'learner-self'] });
    return { ...elr, accessDecision: trace };
  },

  'foxxi.record_performance': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const performerDid = (args.actor_did as string) || ctx.webId;
    const taskName = args.task_name as string;
    if (!taskName || !taskName.trim()) return { error: 'task_name is required' };
    if (typeof args.success !== 'boolean') return { error: 'success (boolean) is required' };
    const taskId = (args.task_id as string)
      || `urn:foxxi:task:${taskName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`;
    const actorKind: 'human' | 'agent' = (args.actor_kind as string) === 'agent' ? 'agent' : 'human';
    const quality = typeof args.quality === 'number' ? args.quality : undefined;
    // The performer is the xAPI actor; the authenticated caller is the
    // attesting observer (provenance). Any authenticated caller may
    // record a performance event — the observer is on the record.
    const statement: Record<string, unknown> = {
      id: randomUUID(),
      version: '2.0.0',
      actor: { objectType: 'Agent', account: { homePage: authoritativeSource, name: performerDid } },
      verb: { id: PERFORMED_VERB, display: { en: 'performed' } },
      object: {
        objectType: 'Activity',
        id: taskId,
        definition: {
          name: { en: taskName },
          type: 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#ProductionTask',
        },
      },
      result: {
        success: args.success,
        ...(quality !== undefined ? { score: { scaled: quality } } : {}),
        ...(args.duration_iso ? { duration: args.duration_iso as string } : {}),
      },
      context: {
        extensions: {
          [PERF_EXT.observedBy]: ctx.webId,
          [PERF_EXT.contextKind]: 'production',
          [PERF_EXT.actorKind]: actorKind,
          ...(typeof args.cost_usd === 'number' ? { [PERF_EXT.costUsd]: args.cost_usd } : {}),
        },
      },
      timestamp: new Date().toISOString(),
    };
    const statementId = storeStatementInternal(statement);
    return {
      recorded: true,
      statementId,
      performer: performerDid,
      observer: ctx.webId,
      taskId,
      taskName,
      actorKind,
      success: args.success as boolean,
    };
  },

  'foxxi.record_agent_trajectory': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const agentDid = args.agent_did as string;
    if (!agentDid) return { error: 'agent_did is required' };
    const rawSteps = args.steps as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      return { error: 'steps (non-empty array) is required' };
    }
    // Map the caller's snake_case step inputs to the native shape.
    const stepInputs: TrajectoryStepInput[] = rawSteps.map(s => ({
      id: s.id as string | undefined,
      modalStatus: (s.modal_status as TrajectoryStepInput['modalStatus']) ?? 'Asserted',
      granularity: (s.granularity as TrajectoryStepInput['granularity']) ?? 'tool-call',
      verb: (s.verb as string) ?? 'acted',
      objectId: (s.object_id as string) ?? `urn:foxxi:trajectory-object:${Date.now()}`,
      objectName: (s.object_name as string) ?? 'step',
      parentId: s.parent_id as string | undefined,
      supersedesId: s.supersedes_id as string | undefined,
      wasDerivedFrom: s.was_derived_from as string[] | undefined,
      result: s.result as TrajectoryStepInput['result'],
    }));
    const trajectory = buildTrajectory(agentDid, args.agent_name as string | undefined, stepInputs);

    // The native trajectory is the source of truth.
    if (agentTrajectories.size >= AGENT_TRAJECTORY_MAX && !agentTrajectories.has(agentDid)) {
      const oldest = agentTrajectories.keys().next().value;
      if (oldest) agentTrajectories.delete(oldest);
    }
    agentTrajectories.set(agentDid, trajectory);

    // Project the Asserted tool-call steps down to xAPI `performed`
    // statements — the deliberately lossy interop view.
    const projection = projectTrajectoryToXapi(trajectory, { authoritativeSource });
    for (const stmt of projection.statements) {
      storeStatementInternal({ id: randomUUID(), ...stmt });
    }
    const shape = trajectoryShape(trajectory);
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.record_agent_trajectory', decision: 'allow', appliedPolicies: ['agent-trajectory-public'] });
    return {
      recorded: true,
      agentDid,
      stepCount: trajectory.steps.length,
      byModalStatus: shape.byModalStatus,
      byGranularity: shape.byGranularity,
      projectedToXapi: projection.statements.length,
      retainedNativeOnly: projection.retainedNativeOnly,
      note: 'Native trajectory stored as source of truth; only Asserted tool-call steps projected to xAPI. Intentions, counterfactuals + task hierarchy are retained natively only.',
      accessDecision: trace,
    };
  },

  'foxxi.get_agent_trajectory': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const agentDid = args.agent_did as string;
    if (!agentDid) return { error: 'agent_did is required' };
    const trajectory = agentTrajectories.get(agentDid);
    if (!trajectory) return { error: `no trajectory recorded for ${agentDid}` };
    const projection = projectTrajectoryToXapi(trajectory, { authoritativeSource });
    const shape = trajectoryShape(trajectory);
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.get_agent_trajectory', decision: 'allow', appliedPolicies: ['agent-trajectory-public'] });
    return {
      agentDid: trajectory.agentDid,
      agentName: trajectory.agentName,
      createdAt: trajectory.createdAt,
      stepCount: trajectory.steps.length,
      byModalStatus: shape.byModalStatus,
      byGranularity: shape.byGranularity,
      steps: trajectory.steps.map(s => ({
        id: s.id,
        modalStatus: s.modalStatus,
        granularity: s.granularity,
        verb: s.verb,
        object: { id: s.objectId, name: s.objectName },
        parentId: s.parentId,
        supersedesId: s.supersedesId,
        result: s.result,
        recordedAt: s.recordedAt,
      })),
      xapiProjection: {
        statementsProjected: projection.statements.length,
        retainedNativeOnly: projection.retainedNativeOnly,
      },
      accessDecision: trace,
    };
  },

  'foxxi.assess_agent_disposition': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const agentDids = args.agent_dids as string[] | undefined;
    if (!Array.isArray(agentDids) || agentDids.length === 0) {
      return { error: 'agent_dids (non-empty array) is required' };
    }
    const trajectories = agentDids
      .map(d => agentTrajectories.get(d))
      .filter((t): t is AgentTrajectory => !!t);
    if (trajectories.length === 0) {
      return { error: 'no recorded trajectories for any agent in the team — record_agent_trajectory first' };
    }
    const disposition = assessDisposition(trajectories);
    // If the team has a probe portfolio, fold in the rung-2/rung-3 causal read.
    const probes = performanceProbes.get(teamKey(agentDids)) ?? [];
    const causalReads = probes.map(p => computeCausalRead(p, trajectories));
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.assess_agent_disposition', decision: 'allow', appliedPolicies: ['agent-performance-consultant'] });
    return {
      disposition,
      probeCount: probes.length,
      causalReads,
      consultantNote: 'Agent Performance Technology: a dispositional read, not a gap analysis. No ideal future state, no score-vs-exemplary. Steer by the vector; nudge constraints with safe-to-fail probes.',
      accessDecision: trace,
    };
  },

  'foxxi.run_performance_probe': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const agentDids = args.agent_dids as string[] | undefined;
    if (!Array.isArray(agentDids) || agentDids.length === 0) {
      return { error: 'agent_dids (non-empty array) is required' };
    }
    for (const f of ['constraint_target', 'change', 'coherence', 'hypothesized_effect', 'amplify_signal', 'dampen_signal']) {
      if (!args[f] || typeof args[f] !== 'string') return { error: `${f} (string) is required` };
    }
    const coherence = args.coherence as string;
    if (!['coherent', 'oblique', 'contradictory'].includes(coherence)) {
      return { error: 'coherence must be one of: coherent | oblique | contradictory' };
    }
    const trajectories = agentDids
      .map(d => agentTrajectories.get(d))
      .filter((t): t is AgentTrajectory => !!t);
    if (trajectories.length === 0) {
      return { error: 'no recorded trajectories for the team — record_agent_trajectory before probing' };
    }
    // Snapshot the disposition at do(x) time — the Pearl rung-2 baseline.
    const preDisposition = snapshot(assessDisposition(trajectories));
    const probe = buildProbe({
      team: agentDids,
      constraintTarget: args.constraint_target as string,
      change: args.change as string,
      coherence: coherence as ProbeCoherence,
      hypothesizedEffect: args.hypothesized_effect as string,
      amplifySignal: args.amplify_signal as string,
      dampenSignal: args.dampen_signal as string,
      recordedBy: ctx.webId,
    }, preDisposition);
    const key = teamKey(agentDids);
    const list = performanceProbes.get(key) ?? [];
    list.push(probe);
    performanceProbes.set(key, list);
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.run_performance_probe', decision: 'allow', appliedPolicies: ['agent-performance-consultant'] });
    return {
      recorded: true,
      probe,
      note: 'Safe-to-fail probe recorded as a Pearl do(x) intervention; the team disposition was snapshotted as the causal baseline. Re-assess the team to read the rung-2/rung-3 causal effect. A safe-to-fail probe is allowed — expected, even — to fail cheaply.',
      accessDecision: trace,
    };
  },

  // ── Multi-team agent / harness evaluation ─────────────────────────

  'foxxi.record_external_agent_run': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const agentDid = args.agent_did as string;
    if (!agentDid) return { error: 'agent_did is required' };
    const taskName = args.task_name as string;
    if (!taskName || !taskName.trim()) return { error: 'task_name is required' };
    if (typeof args.success !== 'boolean') return { error: 'success (boolean) is required' };
    const rawToolCalls = args.tool_calls as Array<Record<string, unknown>> | undefined;
    const rawSteps = args.steps as Array<Record<string, unknown>> | undefined;
    if ((!Array.isArray(rawToolCalls) || rawToolCalls.length === 0)
      && (!Array.isArray(rawSteps) || rawSteps.length === 0)) {
      return { error: 'provide tool_calls (simple form) or steps (rich modal form)' };
    }
    const runInput: ExternalRunInput = {
      agentDid,
      agentName: args.agent_name as string | undefined,
      task: {
        id: args.task_id as string | undefined,
        name: taskName,
        description: args.task_description as string | undefined,
      },
      outcome: {
        success: args.success as boolean,
        quality: typeof args.quality === 'number' ? args.quality as number : undefined,
        durationIso: args.duration_iso as string | undefined,
        costUsd: typeof args.cost_usd === 'number' ? args.cost_usd as number : undefined,
      },
      observedBy: ctx.webId,
      evaluationId: args.evaluation_id as string | undefined,
      candidateId: args.candidate_id as string | undefined,
      harness: args.harness && typeof args.harness === 'object' ? args.harness as HarnessMeta : undefined,
    };
    if (Array.isArray(rawSteps) && rawSteps.length > 0) {
      runInput.steps = rawSteps.map(s => ({
        id: s.id as string | undefined,
        modalStatus: (s.modal_status as TrajectoryStepInput['modalStatus']) ?? 'Asserted',
        granularity: (s.granularity as TrajectoryStepInput['granularity']) ?? 'tool-call',
        verb: (s.verb as string) ?? 'acted',
        objectId: (s.object_id as string) ?? `urn:foxxi:run-object:${Date.now()}`,
        objectName: (s.object_name as string) ?? 'step',
        parentId: s.parent_id as string | undefined,
        supersedesId: s.supersedes_id as string | undefined,
        wasDerivedFrom: s.was_derived_from as string[] | undefined,
        result: s.result as TrajectoryStepInput['result'],
      }));
    } else {
      runInput.toolCalls = (rawToolCalls ?? []).map((tc): ToolCallInput => ({
        tool: (tc.tool as string) ?? 'tool',
        objectName: tc.object_name as string | undefined,
        objectId: tc.object_id as string | undefined,
        success: typeof tc.success === 'boolean' ? tc.success as boolean : undefined,
        quality: typeof tc.quality === 'number' ? tc.quality as number : undefined,
        note: tc.note as string | undefined,
      }));
    }
    const ingested = ingestExternalRun(runInput);
    for (const stmt of ingested.statements) storeStatementInternal({ id: randomUUID(), ...stmt });
    if (agentTrajectories.size >= AGENT_TRAJECTORY_MAX && !agentTrajectories.has(agentDid)) {
      const oldest = agentTrajectories.keys().next().value;
      if (oldest) agentTrajectories.delete(oldest);
    }
    agentTrajectories.set(agentDid, ingested.trajectory);
    let boundTo: string | null = null;
    if (runInput.evaluationId) {
      const candidate = runInput.candidateId
        ? evaluationRegistry.get(runInput.evaluationId)?.candidates.find(c => c.candidateId === runInput.candidateId)
        : evaluationRegistry.findCandidateByAgent(runInput.evaluationId, agentDid);
      if (!candidate) {
        return { error: `agent ${agentDid} is not a candidate of ${runInput.evaluationId} — request + accept enrollment first` };
      }
      const run: CandidateRun = {
        trajectory: ingested.trajectory,
        success: runInput.outcome.success,
        quality: runInput.outcome.quality,
        costUsd: runInput.outcome.costUsd,
        durationIso: runInput.outcome.durationIso,
        recordedAt: new Date().toISOString(),
      };
      const added = evaluationRegistry.addRun(runInput.evaluationId, candidate.candidateId, run);
      if ('error' in added) return { error: added.error };
      boundTo = `${runInput.evaluationId} / ${candidate.candidateId}`;
    }
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.record_external_agent_run', decision: 'allow', appliedPolicies: ['external-agent-run-ingest'] });
    return {
      recorded: true,
      agentDid,
      ...ingested.summary,
      boundToEvaluation: boundTo,
      note: 'External run normalised into an agentic-native trajectory + xAPI performed statements — now visible to disposition assessment, the ELR, and (if bound) the evaluation portfolio read.',
      accessDecision: trace,
    };
  },

  'foxxi.open_agent_evaluation': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const name = args.name as string;
    const decisionQuestion = args.decision_question as string;
    if (!name || !name.trim()) return { error: 'name is required' };
    if (!decisionQuestion || !decisionQuestion.trim()) return { error: 'decision_question is required' };
    const rawTasks = args.task_set as Array<Record<string, unknown> | string> | undefined;
    const taskSet = Array.isArray(rawTasks)
      ? rawTasks.map(t => typeof t === 'string'
        ? { name: t }
        : { name: (t.name as string) ?? 'task', id: t.id as string | undefined, description: t.description as string | undefined })
      : undefined;
    const ev = evaluationRegistry.open({ name, decisionQuestion, taskSet, openedBy: ctx.webId });
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.open_agent_evaluation', decision: 'allow', appliedPolicies: ['agent-evaluation-owner'] });
    return { opened: true, evaluationId: ev.id, evaluation: ev, accessDecision: trace };
  },

  'foxxi.request_evaluation_enrollment': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const evaluationId = args.evaluation_id as string;
    const agentDid = args.agent_did as string;
    const team = args.team as string;
    if (!evaluationId || !agentDid || !team) return { error: 'evaluation_id, agent_did and team are required' };
    const c = evaluationRegistry.requestEnrollment(evaluationId, {
      agentDid,
      agentName: (args.agent_name as string) || agentDid,
      team,
      harness: args.harness && typeof args.harness === 'object' ? args.harness as HarnessMeta : undefined,
      podUrl: args.pod_url as string | undefined,
      requestedBy: ctx.webId,
    });
    if ('error' in c) return { error: c.error };
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.request_evaluation_enrollment', decision: 'allow', appliedPolicies: ['cross-pod-delegation-request'] });
    return {
      requested: true, candidateId: c.candidateId, status: c.status,
      note: 'Enrollment requested. A candidate agent is a cross-pod delegate — its DID may live on another team\'s pod; the evaluation owner must accept it (foxxi.decide_evaluation_candidate) before it joins the comparison.',
      accessDecision: trace,
    };
  },

  'foxxi.decide_evaluation_candidate': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const evaluationId = args.evaluation_id as string;
    const candidateId = args.candidate_id as string;
    const decision = args.decision as string;
    if (!evaluationId || !candidateId) return { error: 'evaluation_id and candidate_id are required' };
    if (decision !== 'accept' && decision !== 'decline') return { error: 'decision must be accept | decline' };
    const c = evaluationRegistry.decide(evaluationId, candidateId, decision, ctx.webId);
    if ('error' in c) return { error: c.error };
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.decide_evaluation_candidate', decision: 'allow', appliedPolicies: ['agent-evaluation-owner'] });
    return {
      decided: true, candidateId: c.candidateId, status: c.status, agentDid: c.agentDid,
      note: decision === 'accept'
        ? 'Candidate accepted — the cross-pod delegation grant. It can now record runs into the cohort.'
        : 'Candidate declined.',
      accessDecision: trace,
    };
  },

  'foxxi.get_agent_evaluation': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const evaluationId = args.evaluation_id as string;
    if (!evaluationId) return { error: 'evaluation_id is required' };
    const state = evaluationRegistry.get(evaluationId);
    if (!state) return { error: `no evaluation ${evaluationId}` };
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.get_agent_evaluation', decision: 'allow', appliedPolicies: ['agent-evaluation-owner'] });
    return {
      evaluation: state.evaluation,
      candidates: state.candidates.map(c => ({
        candidateId: c.candidateId, agentDid: c.agentDid, agentName: c.agentName,
        team: c.team, harness: c.harness, status: c.status, runCount: c.runs.length,
      })),
      accessDecision: trace,
    };
  },

  'foxxi.compare_agent_evaluation': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const evaluationId = args.evaluation_id as string;
    if (!evaluationId) return { error: 'evaluation_id is required' };
    const state = evaluationRegistry.get(evaluationId);
    if (!state) return { error: `no evaluation ${evaluationId}` };
    const accepted = state.candidates.filter(c => c.status === 'accepted');
    if (accepted.length === 0) {
      return { error: 'no accepted candidates — request, accept, and record runs for at least two candidates first' };
    }
    const evidence: CandidateEvidence[] = accepted.map(c => ({
      candidateId: c.candidateId,
      agentName: c.agentName,
      team: c.team,
      harness: c.harness,
      runs: c.runs,
    }));
    const read = comparePortfolio(state.evaluation, evidence);
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.compare_agent_evaluation', decision: 'allow', appliedPolicies: ['agent-evaluation-owner'] });
    return { ...read, accessDecision: trace };
  },

  'foxxi.emit_cmi5_session': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    // AuthZ: caller is the learner OR an admin acting on their behalf.
    const learnerDid = (args.learner_did as string) || ctx.webId;
    if (ctx.role !== 'admin' && learnerDid !== ctx.webId) {
      return { error: `forbidden — caller cannot emit cmi5 statements on behalf of ${learnerDid}` };
    }
    const trace = buildPassedSessionTrace({
      actor: { mbox: `mailto:${learnerDid.split('/').pop()}@${authoritativeSource}`, name: ctx.webId, account: { homePage: learnerDid, name: ctx.userId } },
      session: {
        registration: args.registration as string,
        sessionId: args.registration as string,
        publisherId: tenantProfileDid,
        auActivityId: args.au_activity_id as string,
        courseActivityId: `urn:foxxi:course:${args.course_id as string}`,
      },
      scoreScaled: (args.score_scaled as number) ?? 1.0,
      masteryScore: (args.mastery_score as number) ?? 0.7,
      durationIso: (args.duration_iso as string) ?? 'PT5M',
      moveOnRule: (args.move_on_rule as 'Passed' | 'Completed' | 'CompletedAndPassed' | 'CompletedOrPassed' | 'NotApplicable') ?? 'CompletedAndPassed',
    });
    return { statements: trace, count: trace.length };
  },

  'foxxi.resolve_did': async (args) => {
    const did = args.did as string;
    return resolveDid(did);
  },

  'foxxi.query_experience_index': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'admin') {
      return { error: 'forbidden — federated xAPI queries are admin-only (per learner privacy policy)' };
    }
    const endpoints = (args.endpoints as Array<{ label: string; endpoint: string; username: string; password: string }>).map<FederatedLrsEndpoint>(e => ({
      label: e.label,
      config: { endpoint: e.endpoint, auth: { username: e.username, password: e.password } },
    }));
    const filter = (args.filter as Record<string, unknown>) ?? {};
    return queryFederatedStatements(endpoints, filter);
  },

  'foxxi.push_to_cass': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx, admin } = resolved;
    if (ctx.role !== 'admin') {
      return { error: 'forbidden — only admins can push frameworks to CaSS' };
    }
    // Synthesize a framework from the tenant catalog (same as export_case_framework).
    const audienceTags = new Set<string>();
    for (const c of admin.catalog ?? []) for (const t of c.audience_tags ?? []) audienceTags.add(t);
    const framework: FoxxiSkillFramework = {
      id: (args.framework_id as string) || `urn:foxxi:framework:${tenantProfileDid.replace(/^did:/, '')}:audience-taxonomy`,
      title: 'Acme Training Co audience-tag competency taxonomy',
      publisher: tenantProfileName,
      skills: Array.from(audienceTags).map(tag => ({
        id: `urn:foxxi:skill:${tag}`, label: tag,
        statement: `Demonstrated competence in tasks gated to the "${tag}" audience tag.`,
        framework: 'audience-taxonomy',
      })),
    };
    const caseDoc = frameworkToCase(framework);
    return pushFrameworkToCass(caseDoc, {
      endpoint: args.cass_endpoint as string,
      bearer: args.cass_bearer as string | undefined,
    });
  },

  'foxxi.export_clr_v1': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const requestedLearnerDid = args.learner_did as string;
    if (ctx.role !== 'admin' && requestedLearnerDid !== ctx.webId) {
      return { error: 'forbidden — non-admins can only export their own CLR' };
    }
    const envelope = await exportClr({
      learnerPodUrl: (args.learner_pod_url as string) || tenantPodUrl,
      learnerDid: requestedLearnerDid,
    });
    return envelopeToClr1(envelope);
  },

  'foxxi.export_case_framework': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx, admin } = resolved;
    if (ctx.role !== 'admin') {
      const trace = emitAccessDecision({ ctx, tool: 'foxxi.export_case_framework', decision: 'deny', appliedPolicies: ['admin-full-access'] });
      return { error: `forbidden — only admins can export the competency framework`, accessDecision: trace };
    }
    // For the demo, synthesize a framework from the tenant's catalog
    // audience-tag taxonomy. Real deployments would pull from a
    // published fxk:SkillFramework descriptor and its fxk:Skill entries.
    const audienceTags = new Set<string>();
    for (const c of admin.catalog ?? []) {
      for (const t of c.audience_tags ?? []) audienceTags.add(t);
    }
    const framework: FoxxiSkillFramework = {
      id: (args.framework_id as string) || `urn:foxxi:framework:${tenantProfileDid.replace(/^did:/, '')}:audience-taxonomy`,
      title: 'Acme Training Co audience-tag competency taxonomy',
      description: 'Synthesised from the tenant\'s catalog audience-tag set; one CFItem per audience-tag, with the catalog\'s aggregated skill density as the abbreviated statement.',
      publisher: tenantProfileName,
      caseFrameworkRef: args.case_framework_ref as string | undefined,
      skills: Array.from(audienceTags).map(tag => ({
        id: `urn:foxxi:skill:${tag}`,
        label: tag,
        statement: `Demonstrated competence in tasks gated to the "${tag}" audience tag.`,
        framework: 'audience-taxonomy',
      })),
    };
    const caseDoc = frameworkToCase(framework);
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.export_case_framework', decision: 'allow', appliedPolicies: ['admin-full-access'] });
    return { caseDoc, accessDecision: trace };
  },

  // ─── "Crazy" demo handlers ──────────────────────────────────────────

  'foxxi.issue_bbs_credential': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'admin') return { error: `forbidden — only admins can issue BBS+ credentials` };
    if (!issuerKeySeed) return { error: 'FOXXI_ISSUER_KEY_SEED unset' };
    const issued = await issueBbsCompletionCredential({
      subject: {
        learnerDid: args.learner_did as string,
        courseId: args.course_id as string,
        courseTitle: args.course_title as string,
        scoreScaled: args.score_scaled as number,
        proficiencyLevel: args.proficiency_level as 'Novice' | 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert',
        alignedSkills: (args.aligned_skills as Array<{ targetCode: string; targetName: string; proficiencyLevel?: string }>) ?? [],
      },
      tenantProfileName,
      issuerSeed: issuerKeySeed,
    });
    return {
      issuerDid: issued.issuerDid,
      credential: issued.credential,
      // Serialize the byte fields so they round-trip through JSON-RPC.
      signature_b64: Buffer.from(issued.signature).toString('base64'),
      issuerPublicKey_b64: Buffer.from(issued.issuerPublicKey).toString('base64'),
      messages_b64: issued.messages.map(m => Buffer.from(m).toString('base64')),
      claimIndex: issued.claimIndex,
    };
  },

  'foxxi.derive_bbs_presentation': async (args) => {
    const i = args.issued as {
      credential: Record<string, unknown>;
      signature_b64: string;
      issuerPublicKey_b64: string;
      messages_b64: string[];
      claimIndex: Array<{ index: number; path: string; displayValue: string }>;
      issuerDid: string;
    };
    const issued: BbsIssuedCredential = {
      credential: i.credential,
      signature: new Uint8Array(Buffer.from(i.signature_b64, 'base64')),
      issuerPublicKey: new Uint8Array(Buffer.from(i.issuerPublicKey_b64, 'base64')),
      issuerPublicKeyMultibase: '',
      messages: i.messages_b64.map(b => new Uint8Array(Buffer.from(b, 'base64'))),
      claimIndex: i.claimIndex,
      issuerDid: i.issuerDid,
    };
    const presentationHeader = args.presentation_header
      ? new TextEncoder().encode(args.presentation_header as string)
      : undefined;
    const p = await deriveCompletionPresentation({
      issued,
      revealPaths: args.reveal_paths as string[],
      presentationHeader,
    });
    return {
      proof_b64: Buffer.from(p.proof).toString('base64'),
      disclosedIndexes: p.disclosedIndexes,
      disclosedMessages_b64: p.disclosedMessages.map(d => ({
        index: d.index,
        message_b64: Buffer.from(d.message).toString('base64'),
        displayValue: d.displayValue,
      })),
      issuerPublicKey_b64: Buffer.from(p.issuerPublicKey).toString('base64'),
      issuerDid: p.issuerDid,
      presentationHeader_b64: presentationHeader ? Buffer.from(presentationHeader).toString('base64') : undefined,
    };
  },

  'foxxi.verify_bbs_presentation': async (args) => {
    const p = args.presentation as {
      proof_b64: string;
      disclosedIndexes: number[];
      disclosedMessages_b64: Array<{ index: number; message_b64: string; displayValue: string }>;
      issuerPublicKey_b64: string;
      issuerDid: string;
      presentationHeader_b64?: string;
    };
    const presentation: CredentialPresentation = {
      proof: new Uint8Array(Buffer.from(p.proof_b64, 'base64')),
      disclosedIndexes: p.disclosedIndexes,
      disclosedMessages: p.disclosedMessages_b64.map(d => ({
        index: d.index,
        message: new Uint8Array(Buffer.from(d.message_b64, 'base64')),
        displayValue: d.displayValue,
      })),
      issuerPublicKey: new Uint8Array(Buffer.from(p.issuerPublicKey_b64, 'base64')),
      issuerDid: p.issuerDid,
      presentationHeader: p.presentationHeader_b64
        ? new Uint8Array(Buffer.from(p.presentationHeader_b64, 'base64'))
        : undefined,
    };
    return verifyCompletionPresentation({ presentation });
  },

  'foxxi.prove_competency': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const learnerDid = (args.learner_did as string) || ctx.webId;
    if (ctx.role !== 'admin' && learnerDid !== ctx.webId) {
      const trace = emitAccessDecision({ ctx, tool: 'foxxi.prove_competency', decision: 'deny', appliedPolicies: ['learner-self'] });
      return { error: 'forbidden — non-admins can only prove their own competencies', accessDecision: trace };
    }
    if (!issuerKeySeed) {
      return { error: 'bridge is not configured to issue credentials — FOXXI_ISSUER_KEY_SEED is unset' };
    }
    const proof = await proveCompetency({
      learnerDid,
      learnerName: args.learner_name as string | undefined,
      competencyName: args.competency_name as string,
      courseId: args.course_id as string | undefined,
      scoreScaled: args.score_scaled as number | undefined,
      proficiencyLevel: args.proficiency_level as 'Novice' | 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert' | undefined,
      tenantProfileName,
      issuerSeed: issuerKeySeed,
      revealPaths: args.reveal_paths as string[] | undefined,
      presentationContext: args.presentation_context as string | undefined,
    });
    const trace = emitAccessDecision({ ctx, tool: 'foxxi.prove_competency', decision: 'allow', appliedPolicies: [ctx.role === 'admin' ? 'admin-full-access' : 'learner-self'] });
    return { ...proof, accessDecision: trace };
  },

  'foxxi.launch_au_with_prereq_check': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const learnerDid = (args.learner_did as string) || ctx.webId;
    if (ctx.role !== 'admin' && learnerDid !== ctx.webId) {
      return { error: 'forbidden — caller cannot launch on behalf of another learner' };
    }
    return launchAuWithPrereqCheck({
      learnerDid,
      learnerPodUrl: (args.learner_pod_url as string) || tenantPodUrl,
      courseId: args.course_id as string,
      auActivityId: args.au_activity_id as string,
      registration: args.registration as string,
      prereq: {
        achievementIri: args.prereq_achievement_iri as string,
        minProficiencyRdfValue: args.prereq_min_proficiency_rdf_value as number | undefined,
        acceptedIssuerDids: args.prereq_accepted_issuer_dids as readonly string[] | undefined,
      },
    });
  },

  'foxxi.ai_assess_competency': async (args) => {
    return aiAssessCompetency({
      learnerDid: args.learner_did as string,
      mentorIssuerSeed: args.mentor_seed as string,
      competency: args.competency as { id: string; label: string; proficiencyLevel: 'Novice' | 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert' },
      evidence: args.evidence as Array<{ type: string; id: string; narrative?: string }>,
      narrative: args.narrative as string,
    });
  },

  'foxxi.countersign_assessment': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'admin') return { error: 'forbidden — only admins can countersign assessments' };
    return countersignAssessment({
      assessment: args.assessment as CompetencyAssessment,
      humanIssuerSeed: args.human_seed as string,
    });
  },

  'foxxi.audit_compliance_trail': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'admin') return { error: 'forbidden — audit trails are admin-only' };
    return composeAuditTrail({
      learnerDid: args.learner_did as string,
      learnerPodUrl: (args.learner_pod_url as string) || tenantPodUrl,
      windowFrom: args.window_from as string | undefined,
      windowTo: args.window_to as string | undefined,
    });
  },

  'foxxi.declare_framework_alignment': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'admin') return { error: 'forbidden — only admins can declare framework alignments' };
    const alignment: FrameworkAlignment = {
      ownItemIri: args.own_item_iri as string,
      ownItemLabel: args.own_item_label as string,
      otherItemIri: args.other_item_iri as string,
      otherFrameworkIri: args.other_framework_iri as string,
      otherTenantDid: args.other_tenant_did as string | undefined,
      relation: args.relation as AlignmentRelation,
      rationale: args.rationale as string | undefined,
    };
    return serializeAlignment(alignment);
  },

  'foxxi.resolve_aligned_competency': async (args) => {
    return resolveAlignment({
      heldCompetencyIri: args.held_competency_iri as string,
      requiredCompetencyIri: args.required_competency_iri as string,
      alignments: args.alignments as SerializedAlignment[],
    });
  },

  'foxxi.cohort_concept_intelligence': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'admin') return { error: 'forbidden — cohort analytics are admin-only' };
    const entries = await gatherCohortQA({
      learnerPodUrls: args.learner_pod_urls as string[],
      windowFrom: args.window_from as string | undefined,
      windowTo: args.window_to as string | undefined,
    });
    return summarizeCohort(entries);
  },

  'foxxi.register_self_sovereign_learner': async (args) => {
    // No admin gate — the whole point is letting a learner register themselves with their own pod + DID.
    // Audit-record on the bridge that a registration was attempted; the actual descriptor write happens
    // on the caller's pod with their credentials (we just emit the registration payload they can publish).
    const descriptor = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['fxa:SelfSovereignLearner'],
      id: `urn:foxxi:self-sovereign-learner:${(args.learner_did as string).replace(/[^a-zA-Z0-9]/g, '-')}`,
      learnerDid: args.learner_did,
      learnerPodUrl: args.learner_pod_url,
      displayName: args.display_name,
      isAgent: args.is_agent ?? false,
      registeredAt: new Date().toISOString(),
      tenant: tenantProfileDid,
    };
    return { descriptor, note: 'Self-sovereign learner registration payload. Publish this to your own pod via publish_context to make it discoverable; thereafter any tenant can call foxxi.discover_assigned_courses with your did as learner_did.' };
  },

  // ─── Wave-of-13 handlers ────────────────────────────────────────────

  'foxxi.bootstrap_tenant': async (args) => {
    return bootstrapTenant({
      tenantSlug: args.tenant_slug as string,
      tenantDid: args.tenant_did as string,
      tenantDisplayName: args.tenant_display_name as string,
      adminWebId: args.admin_web_id as string,
      adminName: args.admin_name as string,
      podUrl: args.pod_url as string,
    });
  },

  'foxxi.scorm_cloud_pull': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'admin') return { error: 'forbidden — admin only' };
    const appId = process.env.FOXXI_SCORM_CLOUD_APP_ID;
    const secretKey = process.env.FOXXI_SCORM_CLOUD_SECRET_KEY;
    if (!appId || !secretKey) {
      return { error: 'SCORM Cloud credentials not configured. Set FOXXI_SCORM_CLOUD_APP_ID + FOXXI_SCORM_CLOUD_SECRET_KEY on the bridge.' };
    }
    const config: ScormCloudConfig = { appId, secretKey };
    try {
      const list = await listScormCloudCourses(config);
      const catalogEntries = scormCloudToCatalogEntries(list.courses);
      return {
        coursesPulled: list.courses.length,
        catalogEntries,
        more: list.more,
      };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },

  'foxxi.scorm_cloud_register': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'admin') return { error: 'forbidden — admin only' };
    const appId = process.env.FOXXI_SCORM_CLOUD_APP_ID;
    const secretKey = process.env.FOXXI_SCORM_CLOUD_SECRET_KEY;
    if (!appId || !secretKey) return { error: 'SCORM Cloud credentials not configured.' };
    return createScormCloudRegistration({
      registrationId: args.registration_id as string,
      courseId: args.course_id as string,
      learner: {
        id: args.learner_id as string,
        firstName: args.learner_first_name as string | undefined,
        lastName: args.learner_last_name as string | undefined,
        email: args.learner_email as string | undefined,
      },
    }, { appId, secretKey });
  },

  'foxxi.upload_scorm_package': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    return uploadScormPackage({
      tenantPodUrl: tenantPodUrl,
      zipBase64: args.zip_base64 as string,
      hintedTitle: args.hinted_title as string | undefined,
      uploaderDid: ctx.webId,
    });
  },

  'foxxi.derive_adaptive_policy': async (args) => {
    return deriveAdaptivePolicy(
      args.cohort_intel as CohortIntelligence,
      args.threshold_pct as number | undefined,
    );
  },

  'foxxi.schedule_spaced_repetition': async (args) => {
    return scheduleSpacedRepetition({
      learnerDid: args.learner_did as string,
      completedConcepts: args.completed_concepts as Array<{ conceptId: string; completedAt: string }>,
      prereqEdges: args.prereq_edges as Array<{ from: string; to: string }>,
    });
  },

  'foxxi.discover_framework_registry': async (args) => {
    return discoverFrameworkRegistry({
      podUrls: args.pod_urls as string[],
    });
  },

  'foxxi.register_tutor_agent': async (args) => {
    // No admin gate — agents register themselves with their own DID.
    const profile = {
      agentDid: args.agent_did,
      displayName: args.display_name,
      specialties: args.specialties,
      description: args.description,
      poweredBy: args.powered_by,
      contactEndpoint: args.contact_endpoint,
      registeredAt: new Date().toISOString(),
    };
    return { descriptor: { '@type': ['fxa:TutorAgentProfile'], ...profile }, note: 'Publish this descriptor to your own pod via publish_context to make it discoverable by foxxi.find_tutor_for_competency.' };
  },

  'foxxi.find_tutor_for_competency': async (args) => {
    const counterMap = new Map(Object.entries((args.countersign_counts as Record<string, number>) ?? {}));
    return rankTutorsForCompetency({
      candidates: args.candidate_profiles as TutorAgentProfile[],
      requiredCompetencyIri: args.required_competency_iri as string,
      requiredLevel: args.required_level as 'Novice' | 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert' | undefined,
      countersignCounts: counterMap,
    });
  },

  'foxxi.generate_dpia': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'admin') return { error: 'forbidden — DPIA generation is admin-only' };
    const chain = await composeAuditTrail({
      learnerDid: args.learner_did as string,
      learnerPodUrl: (args.learner_pod_url as string) || tenantPodUrl,
      windowFrom: args.window_from as string | undefined,
      windowTo: args.window_to as string | undefined,
    });
    return composeDpia(chain);
  },

  'foxxi.manager_team_view': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'manager' && ctx.role !== 'admin') return { error: 'forbidden — manager or admin role required' };
    return buildManagerTeamView({
      managerWebId: args.manager_web_id as string,
      reportPodUrls: args.report_pods as Array<{ webId: string; name?: string; podUrl: string }>,
    });
  },

  'foxxi.build_did_web_document': async (args) => {
    return buildTenantDidDocument({
      tenantDid: args.tenant_did as string,
      issuerPublicKeyMultibase: args.issuer_public_key_multibase as string,
      bridgeEndpoint: args.bridge_endpoint as string,
    });
  },

  'foxxi.backup_tenant_pod': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'admin') return { error: 'forbidden — backup is admin-only' };
    return backupTenantPod({ podUrl: tenantPodUrl });
  },

  // ─── Learning-engineer handlers ────────────────────────────────────

  'foxxi.le_design_ab_experiment': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'learning-engineer' && ctx.role !== 'admin') {
      return { error: 'forbidden — learning-engineer or admin role required' };
    }
    return designAbExperiment({
      variantA: args.variant_a as { courseId: string; courseTitle?: string },
      variantB: args.variant_b as { courseId: string; courseTitle?: string },
      primaryMetric: args.primary_metric as 'completion-rate' | 'mastery-score' | 'time-to-mastery' | 'retention-30-day' | 'downstream-prereq-pass-rate',
      minimumDetectableEffect: args.minimum_detectable_effect as number,
      alpha: args.alpha as number | undefined,
      power: args.power as number | undefined,
      randomization: args.randomization as 'simple' | 'stratified-by-audience-tag' | undefined,
      perWeekEnrolment: args.per_week_enrolment as number | undefined,
    });
  },

  'foxxi.le_estimate_concept_difficulty': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'learning-engineer' && ctx.role !== 'admin') {
      return { error: 'forbidden — learning-engineer or admin role required' };
    }
    // Fetch the course package for its concept + prereq graph.
    const courseId = args.course_id as string;
    const coursePayload = await autoFetchCourse(args, courseId);
    if (!coursePayload) {
      return { error: `course package not found on pod for course_id=${courseId}` };
    }
    const cp = coursePayload as unknown as { concepts?: Array<{ id: string; label?: string }>; prereq_edges?: Array<{ from: string; to: string }> };
    return estimateConceptDifficulty({
      concepts: (cp.concepts ?? []) as Array<{ id: string; label: string; confidence: number; tier: number }>,
      prereqEdges: (cp.prereq_edges ?? []),
      cohortIntel: args.cohort_intel as CohortIntelligence | undefined,
    });
  },

  'foxxi.le_analyze_learning_curve': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'learning-engineer' && ctx.role !== 'admin') {
      return { error: 'forbidden — learning-engineer or admin role required' };
    }
    return analyzeLearningCurve({
      conceptId: args.concept_id as string,
      conceptLabel: args.concept_label as string | undefined,
      attempts: args.attempts as Array<{ learnerId: string; attemptNumber: number; mastered: boolean }>,
    });
  },

  'foxxi.le_calibrate_mastery_threshold': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'learning-engineer' && ctx.role !== 'admin') {
      return { error: 'forbidden — learning-engineer or admin role required' };
    }
    return calibrateMasteryThreshold({
      records: args.records as Array<{ scoreScaled: number; downstreamSuccess: boolean }>,
      thresholdGrid: args.threshold_grid as number[] | undefined,
    });
  },

  'foxxi.le_framework_gap_analysis': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    if (ctx.role !== 'learning-engineer' && ctx.role !== 'admin') {
      return { error: 'forbidden — learning-engineer or admin role required' };
    }
    return frameworkGapAnalysis({
      frameworkSkills: args.framework_skills as Array<{ id: string; label?: string }>,
      courseConcepts: args.course_concepts as Array<{ id: string; label: string; confidence: number; tier: number }>,
      alignments: args.alignments as Array<{ skillId: string; conceptId: string }>,
    });
  },
};

// ── Audience split + bridge bootstrap ─────────────────────────────────

const audience = (process.env.FOXXI_AUDIENCE ?? 'both').toLowerCase();
let activeAffordances: typeof foxxiAffordances;
if (audience === 'learner') activeAffordances = foxxiAffordances;
else if (audience === 'admin') activeAffordances = foxxiAdminAffordances;
else activeAffordances = [...foxxiAffordances, ...foxxiAdminAffordances];

const PORT = parseInt(process.env.PORT ?? '6080', 10);

// Browser dashboard origin (default Vite dev server). Override with
// FOXXI_DASHBOARD_ORIGIN for production; "*" for open development. Multiple
// browser surfaces (dashboard + microsite) supply a comma-separated list;
// the middleware below echoes back the request's Origin if it's in the
// allow-list (single Access-Control-Allow-Origin per CORS spec).
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(
  (process.env.FOXXI_DASHBOARD_ORIGIN ?? 'http://localhost:5173,http://localhost:5174')
    .split(',').map(s => s.trim()).filter(Boolean),
);

// Instrumentation wrapper — every handler call timed + recorded; specific
// failure modes (rate limit, auth) routed to dedicated counters. No
// behavior change beyond /metrics visibility.
const instrumentedHandlers = Object.fromEntries(
  Object.entries(handlers).map(([name, fn]) => [
    name,
    async (args: Record<string, unknown>) => {
      const t0 = Date.now();
      let isError = false;
      try {
        const result = await fn(args);
        if (result && typeof result === 'object' && 'error' in result) {
          isError = true;
          const errStr = String((result as { error: unknown }).error);
          if (errStr.includes('rate limit')) recordRateLimit();
          if (errStr.startsWith('auth:') || errStr.includes('session token') || errStr.includes('not in tenant directory')) recordAuthFailure();
        }
        if (name === 'foxxi.derive_bbs_presentation' && result && typeof result === 'object' && 'proof_b64' in (result as Record<string, unknown>)) recordBbsProof();
        if ((name === 'foxxi.issue_completion_credential' || name === 'foxxi.issue_bbs_credential') && result && typeof result === 'object' && !(('error' in result))) recordVcIssued();
        return result;
      } catch (err) {
        isError = true;
        throw err;
      } finally {
        recordCall(name, Date.now() - t0, isError);
        // Granular xAPI emission — every affordance call lands as a
        // statement in Foxxi-as-LRS so the LRS-admin dashboard sees the
        // same activity stream the substrate sees on the pod side.
        try {
          const callerCtx: { webId?: string; userId?: string; role?: string; audienceTags?: readonly string[] } = {};
          // Cheap derivation — args.__caller_token already validated by
          // resolveCaller paths inside the handler; here we just peek at
          // the bearer's `sub` claim for the actor identity. No second
          // sig check needed since the handler either succeeded (token
          // was valid) or returned an error we tagged as such.
          const bearerToken = args.__caller_token as string | undefined;
          if (bearerToken) {
            try {
              // Token is base64url-encoded JSON; decode without verifying
              // for instrumentation purposes (the handler already verified).
              const padded = bearerToken.replace(/-/g, '+').replace(/_/g, '/');
              const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { sub?: string };
              callerCtx.webId = decoded.sub;
              callerCtx.role = decoded.sub && learningEngineerWebIds.has(decoded.sub) ? 'learning-engineer'
                : (decoded.sub === adminWebId ? 'admin' : 'learner');
            } catch { /* ignore */ }
          }
          emitAffordanceStatement({
            toolName: name,
            caller: callerCtx,
            args,
            result: undefined,
            duration: Date.now() - t0,
            isError,
            selfBaseUrl: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080',
          });
        } catch (xapiErr) {
          // Instrumentation must never block the handler's response.
          // eslint-disable-next-line no-console
          console.warn('[xapi-instrumentation]', (xapiErr as Error).message);
        }
      }
    },
  ]),
);

const app = createVerticalBridge({
  verticalName: 'foxxi-content-intelligence',
  affordances: activeAffordances,
  handlers: instrumentedHandlers,
  defaultPodUrl: tenantPodUrl,
  middleware: (a) => {
    // CORS for the browser dashboard. The vertical owns its CORS
    // policy; the substrate-side vertical-bridge factory stays
    // CORS-agnostic so other deployments (server-to-server, MCP
    // clients) aren't forced to specify an origin.
    a.use((req, res, next) => {
      const origin = req.headers.origin;
      if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Experience-API-Version, If-Match, If-None-Match');
      res.setHeader('Access-Control-Expose-Headers', 'ETag, Last-Modified, X-Experience-API-Version, X-Experience-API-Consistent-Through');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    });

    // Observability — /metrics in Prometheus text format, /metrics.json
    // as structured JSON for operator dashboards. No auth (it's
    // operator infrastructure); consider IP-restricting via the
    // ingress's allowed-IP-ranges in production.
    a.get('/metrics', (_req, res) => {
      res.type('text/plain; version=0.0.4');
      res.send(renderMetrics());
    });
    a.get('/metrics.json', (_req, res) => {
      res.json(metricsJson());
    });

    // Inbound xAPI LRS surface — Foxxi can BE an LRS that external
    // systems (LMSes, mobile apps, simulators, tutoring agents, other
    // LRSes via Statement Forwarding) write to. Each accepted Statement
    // joins the substrate's trace graph via the same provenance and
    // modal-status machinery the rest of the affordances use.
    //
    // Mounted BEFORE the auth middleware below so xAPI's own
    // Basic/Bearer gate handles authentication on /xapi/* (the lower
    // middleware is MCP-tools/call-shaped and doesn't apply to xAPI
    // resources).
    attachXapiLrsRoutes(a, {
      podUrl: tenantPodUrl,
      tenantDid: authoritativeSource,
      basicAuthPairs: process.env.FOXXI_LRS_BASIC_AUTH_PAIRS ?? '',
      forwardingTargets: process.env.FOXXI_LRS_FORWARDING_TARGETS ?? '',
      selfBaseUrl: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080',
    });

    // LTI 1.3 Advantage Tool Provider — JWKS / OIDC login / launch /
    // deep linking / AGS / NRPS. Lets any 1EdTech-compliant LMS launch
    // Foxxi as a Tool. Platforms registered via FOXXI_LTI_PLATFORMS env
    // (comma-separated `issuer||client_id||deployment_id||jwks_url||
    // auth_login_url||auth_token_url`).
    attachLti13Routes(a, {
      selfBaseUrl: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080',
      tenantDid: authoritativeSource,
      keySeed: process.env.FOXXI_LTI_KEY_SEED ?? `${authoritativeSource}-lti-2026-05`,
      dashboardUrl: process.env.FOXXI_DASHBOARD_URL ?? (process.env.FOXXI_DASHBOARD_ORIGIN?.split(',')[0] ?? 'http://localhost:5173'),
      platformsConfig: process.env.FOXXI_LTI_PLATFORMS ?? '',
    });

    // OneRoster 1.2 — SIS / HR roster sync. Both a producer (Foxxi
    // exposes its roster) and a consumer (`POST /oneroster/v1p2/import`
    // for CSV bundle ingest).
    attachOneRosterRoutes(a, { tenantDid: authoritativeSource });

    // OpenAPI 3.1 — machine-readable contract for non-MCP integrators
    // (bizdev / partner-eng teams who want a typed SDK). Served at
    // /openapi.json + Swagger UI at /docs.
    attachOpenApiRoutes(a, { selfBaseUrl: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080', affordances: activeAffordances });

    // ── Foxxi vocabulary — dereferenceable RESTful linked data ───────
    // Every foxxi term IRI (`<bridge>/ns/foxxi#<name>`) resolves here.
    // A hash IRI dereferences to the whole document; each term is also
    // its own resource at /ns/foxxi/term/<name> with HATEOAS _links.
    // Content-negotiated: JSON-LD by default, Turtle on Accept.
    a.get('/ns/foxxi', (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if ((req.headers.accept ?? '').includes('text/turtle')) {
        res.type('text/turtle').send(renderVocabTurtle());
      } else {
        res.type('application/ld+json').send(JSON.stringify(renderVocabJsonLd(), null, 2));
      }
    });
    // Term names carry at most one `/` (e.g. `verbs/affordance-invoked`),
    // so two plain routes cover every term — no wildcard, no optional
    // param (path-to-regexp version-portable).
    const sendTerm = (name: string, res: import('express').Response): void => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.type('application/ld+json').send(JSON.stringify(renderTermJsonLd(name), null, 2));
    };
    a.get('/ns/foxxi/term/:a/:b', (req, res) => sendTerm(`${req.params.a}/${req.params.b}`, res));
    a.get('/ns/foxxi/term/:a', (req, res) => sendTerm(req.params.a, res));

    // ── IEEE-LER + ADL-TLA emergent composable semantic layer ────────
    // Two scoped ontologies the bridge serves as dereferenceable linked
    // data — content-negotiated Turtle / JSON-LD. Every ler:/tla: term
    // IRI resolves; composed/view/role terms carry cg:constructedFrom
    // triples naming the substrate primitives they emerge from.
    for (const [path, fam] of [['/ns/ieee-ler', 'ler'], ['/ns/adl-tla', 'tla']] as const) {
      a.get(path, (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if ((req.headers.accept ?? '').includes('text/turtle')) {
          res.type('text/turtle').send(renderSemOntologyTurtle(fam));
        } else {
          res.type('application/ld+json').send(JSON.stringify(renderSemOntologyJsonLd(fam), null, 2));
        }
      });
      const sendSemTerm = (name: string, res: import('express').Response): void => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.type('application/ld+json').send(JSON.stringify(renderSemTermJsonLd(fam, name), null, 2));
      };
      a.get(`${path}/term/:a/:b`, (req, res) => sendSemTerm(`${req.params.a}/${req.params.b}`, res));
      a.get(`${path}/term/:a`, (req, res) => sendSemTerm(req.params.a, res));
    }

    // LRS-admin dashboard endpoints — gated by admin or learning-engineer
    // role. The dashboard's new "xAPI / LRS" tab calls these to render
    // the statement browser, aggregates, conformance, and config views.
    attachXapiAdminRoutes(a, {
      adminWebId,
      learningEngineerWebIds,
      selfBaseUrl: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080',
      basicAuthPairs: process.env.FOXXI_LRS_BASIC_AUTH_PAIRS ?? '',
      forwardingTargets: process.env.FOXXI_LRS_FORWARDING_TARGETS ?? '',
    });

    // OAuth 2.0 client_credentials token endpoint — for partner-eng SDKs
    // and non-MCP clients that prefer canonical OAuth bearer over the
    // dashboard's wallet-signed session tokens. Tokens signed with the
    // same ES256 keypair as LTI 1.3 so partners can verify against the
    // published JWKS at /lti/.well-known/jwks.json.
    attachOauthTokenRoute(a, {
      selfBaseUrl: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080',
      privateKeyPem: process.env.FOXXI_LTI_PRIVATE_KEY_PEM,
      clientsConfig: process.env.FOXXI_LRS_OAUTH_CLIENTS ?? '',
      tokenTtlSec: 3600,
    });

    // Foxxi hypermedia resource endpoints — REST + HATEOAS surface.
    // Each /api/foxxi/v1/<collection>[/<opaque-id>] returns a resource
    // envelope with _links + _affordances + _embedded (where applicable)
    // so clients navigate by following links rather than knowing URL
    // patterns. Opaque ids are UUID v5 derived from substrate slugs;
    // no business identifiers leak into URLs.
    attachHypermediaRoutes(a, {
      selfBaseUrl: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080',
      affordances: activeAffordances,
      scormPlayerBaseUrl: process.env.FOXXI_SCORM_PLAYER_BASE
        ?? 'https://interego-foxxi-scorm-player.livelysky-8b81abb0.eastus.azurecontainerapps.io',
    });

    // Auth middleware: extract Authorization: Bearer <session-token> and
    // inject the raw token into the JSON-RPC params.arguments as
    // __caller_token. Also inject __client_ip (extracted from
    // x-forwarded-for, the canonical proxy header Azure Container Apps
    // populates) so individual handlers can apply per-IP rate limits.
    a.use((req, _res, next) => {
      // Per-IP injection — Azure Container Apps puts the original
      // client IP in x-forwarded-for; fall back to req.ip for local dev.
      const xff = req.headers['x-forwarded-for'];
      const clientIp = typeof xff === 'string'
        ? xff.split(',')[0]!.trim()
        : Array.isArray(xff) ? xff[0] : req.ip ?? 'unknown';

      const header = req.headers['authorization'] ?? req.headers['Authorization'];
      const m = typeof header === 'string' && /^Bearer\s+(.+)$/i.exec(header);
      const token = m ? m[1].trim() : undefined;

      if (req.body && typeof req.body === 'object') {
        const body = req.body as { method?: string; params?: { arguments?: Record<string, unknown> } };
        if (body.method === 'tools/call' && body.params) {
          body.params.arguments = {
            ...(body.params.arguments ?? {}),
            __client_ip: clientIp,
            ...(token ? { __caller_token: token } : {}),
          };
        }
        const bodyRec = req.body as Record<string, unknown>;
        bodyRec.__client_ip = clientIp;
        if (token) bodyRec.__caller_token = token;
      }
      next();
    });
  },
});

app.listen(PORT, () => {
  console.log(`foxxi-content-intelligence bridge on http://localhost:${PORT}`);
  console.log(`  MCP endpoint:        http://localhost:${PORT}/mcp`);
  console.log(`  Affordance manifest: http://localhost:${PORT}/affordances`);
  console.log(`  Audience: ${audience} (${activeAffordances.length} affordances active; FOXXI_AUDIENCE=learner|admin|both)`);
});
