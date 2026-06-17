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
 *     FOXXI_TENANT_POD_URL=https://your-pod.example/foxxi/ \
 *     FOXXI_AUTHORITATIVE_SOURCE=did:web:your-tenant.example \
 *     npx tsx server.ts
 *
 * Audience split (per docs/DEPLOYMENT-SPLIT.md):
 *   FOXXI_AUDIENCE=learner   → expose foxxiAffordances only
 *   FOXXI_AUDIENCE=admin     → expose foxxiAdminAffordances only
 *   FOXXI_AUDIENCE=both      → expose both (default)
 */

import { randomUUID, createHash } from 'node:crypto';

// ── Pod-write auth: attach Authorization: Bearer on writes that target
// the configured tenant pod URL. The CSS deployment sits behind a
// write-gating reverse proxy (interego-css-gate) that rejects anonymous
// POST / PUT / PATCH / DELETE. Reads still go anonymously. Only writes
// to the tenant pod host get the bearer — outbound calls to other
// services (model APIs, federation peer reads, etc) are untouched so we
// don't leak the secret. Patch runs once at module load, before any
// publish() call captures globalThis.fetch. ───────────────────────
{
  const writeSecret = process.env.FOXXI_POD_WRITE_SECRET;
  const tenantPodUrl = process.env.FOXXI_TENANT_POD_URL ?? '';
  if (writeSecret && tenantPodUrl) {
    const tenantOrigin = (() => { try { return new URL(tenantPodUrl).origin; } catch { return ''; } })();
    const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (writeMethods.has(method) && tenantOrigin) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
        if (url && url.startsWith(tenantOrigin)) {
          const headers = new Headers(init?.headers ?? {});
          if (!headers.has('Authorization')) {
            headers.set('Authorization', `Bearer ${writeSecret}`);
            return originalFetch(input, { ...init, headers });
          }
        }
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;
    console.log(`[foxxi-bridge] pod-write auth installed (writes to ${tenantOrigin} carry Authorization header)`);
  }
}
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { affordancesManifestTurtle, type Affordance } from '../../_shared/affordance-mcp/index.js';
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
import {
  persistRecordedStatement,
  readDurableRecordedStatements,
  mergeStatementsById,
  persistScormCourse,
  loadScormCourse,
  NON_PROJECTABLE_LOCALNAMES,
} from '../src/durable-records.js';
import { envelopeToClr1 } from '../src/clr-1.js';
import { assembleEnterpriseLearnerRecord, PERFORMED_VERB, AUTHORED_VERB, CREDENTIALED_VERB, PERF_EXT } from '../src/learner-record.js';
import { recoverSignedRequest } from '../src/auth.js';
import { makeWalletDelegationVerifier } from '@interego/core';
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
import { projectMeshEntry, actorForPod, type MeshDiscoverEntry, type ProjectedMeshEvent } from '../src/mesh-event-projector.js';
import {
  forwardStatement as forwardToTargets,
  addForwardingTarget, listForwardingTargets,
  deleteForwardingTarget, inboundCredentials,
  exportForwardingConfig, importForwardingConfig,
  registerForwardingHydrator, markForwardingHydrated,
} from '../src/lrs-forwarding.js';
import { persistForwardingConfig, loadForwardingConfig } from '../src/forwarding-persist.js';
import { bridgeEncryptionKeypair } from '../src/foundation-holon-altitude.js';
import { EvaluationRegistry, type CandidateRun } from '../src/agent-evaluation.js';
import { comparePortfolio, type CandidateEvidence } from '../src/agent-portfolio.js';
import { TenantPartition, tenantIdOf, type TenantId } from '../src/tenant-context.js';

// ── Tenant-partitioned bridge stores ────────────────────────────────
// One Foxxi bridge can serve many tenants. Every in-memory store is
// partitioned by tenant (the tenant pod URL), so tenant A can never see
// tenant B's trajectories, probes, or evaluations.

/** Agentic-native trajectory store — keyed by agent DID, per tenant. */
const agentTrajectoriesByTenant = new TenantPartition<Map<string, AgentTrajectory>>(() => new Map());
const AGENT_TRAJECTORY_MAX = 5_000;

/** Performance-probe store — keyed by team key (sorted agent DIDs), per tenant. */
const performanceProbesByTenant = new TenantPartition<Map<string, PerformanceProbe[]>>(() => new Map());
const teamKey = (dids: readonly string[]): string => [...dids].sort().join('|');

/** Agent-evaluation cohort registry — one per tenant. */
const evaluationRegistryByTenant = new TenantPartition<EvaluationRegistry>(() => new EvaluationRegistry());

// ── Pod projection of the bridge-local agent/probe/eval state ────────
// Three coarse-grained snapshots — one per surface — published to the
// tenant pod on a debounced timer. The pod is the durable record across
// container restarts; the TenantPartition Maps remain the hot cache.
import {
  registerSnapshot as registerBridgeSnap,
  dirty as markBridgeDirty,
  loadLatestSnapshot as loadBridgeSnap,
  FOXXI_SNAPSHOT_TYPES as BRIDGE_SNAP_TYPES,
} from '../src/pod-snapshot-publisher.js';
interface TrajectorySnap { byTenant: Record<string, Array<[string, AgentTrajectory]>>; }
function collectTrajectorySnap(): TrajectorySnap {
  const out: Record<string, Array<[string, AgentTrajectory]>> = {};
  for (const t of agentTrajectoriesByTenant.tenants()) out[String(t)] = [...agentTrajectoriesByTenant.for(t).entries()];
  return { byTenant: out };
}
interface ProbeSnap { byTenant: Record<string, Array<[string, PerformanceProbe[]]>>; }
function collectProbeSnap(): ProbeSnap {
  const out: Record<string, Array<[string, PerformanceProbe[]]>> = {};
  for (const t of performanceProbesByTenant.tenants()) out[String(t)] = [...performanceProbesByTenant.for(t).entries()];
  return { byTenant: out };
}
// EvaluationRegistry exposes its state through registered probes/results;
// we serialize via JSON.stringify with a fallback that captures whatever
// the registry surfaces. (Full structural projection is a follow-up.)
interface EvalSnap { byTenant: Record<string, unknown>; }
function collectEvalSnap(): EvalSnap {
  const out: Record<string, unknown> = {};
  for (const t of evaluationRegistryByTenant.tenants()) {
    try { out[String(t)] = JSON.parse(JSON.stringify(evaluationRegistryByTenant.for(t))); }
    catch { /* skip */ }
  }
  return { byTenant: out };
}
registerBridgeSnap({ surface: 'foxxi-trajectories', typeIri: BRIDGE_SNAP_TYPES.AgentTrajectories, collect: collectTrajectorySnap });
registerBridgeSnap({ surface: 'foxxi-probes', typeIri: BRIDGE_SNAP_TYPES.PerformanceProbes, collect: collectProbeSnap });
registerBridgeSnap({ surface: 'foxxi-evals', typeIri: BRIDGE_SNAP_TYPES.Evaluations, collect: collectEvalSnap });

async function hydrateBridgeStateFromPod(): Promise<void> {
  const t = await loadBridgeSnap<TrajectorySnap>('foxxi-trajectories');
  if (t?.byTenant) for (const [tenant, entries] of Object.entries(t.byTenant)) {
    const m = agentTrajectoriesByTenant.for(tenant as TenantId);
    for (const [did, traj] of entries) m.set(did, traj);
  }
  const p = await loadBridgeSnap<ProbeSnap>('foxxi-probes');
  if (p?.byTenant) for (const [tenant, entries] of Object.entries(p.byTenant)) {
    const m = performanceProbesByTenant.for(tenant as TenantId);
    for (const [team, probes] of entries) m.set(team, probes);
  }
}
void hydrateBridgeStateFromPod();
// NOTE: there used to be a setInterval here that dirtied
// foxxi-trajectories / foxxi-probes / foxxi-evals every 30s as a
// belt-and-braces snapshot heartbeat. It was effectively a write storm
// against the tenant pod's manifest — 6+ PUTs/minute regardless of
// whether any surface state had actually changed, all serialized on
// the same manifest's HTTP lock. Manifest writes started timing out
// under contention (Azure ingress 504 "stream timeout"; CSS logged
// "Request error: aborted") and that masked descriptor writes from
// the agent-facing routes. Snapshots now fire only when real state
// changes (the surface modules call dirty() themselves on update),
// keeping the pod write-rate proportional to real activity.

/** Resolve the tenant of an affordance call from its `tenant_pod_url`
 *  argument (falling back to the bridge's configured default tenant). */
function callTenant(args: Record<string, unknown>): TenantId {
  return tenantIdOf((args.tenant_pod_url as string) || tenantPodUrl);
}
import { frameworkToCase, type FoxxiSkillFramework } from '../src/case-exporter.js';
import { buildPassedSessionTrace } from '../src/cmi5.js';
import { pushFrameworkToCass } from '../src/cass-connector.js';
import {
  discover,
  resolveDid,
  verifyAgentDelegation,
  readDelegationCredential,
  rebuildManifestFromPod,
  publishAgentEncryptionKey,
} from '@interego/solid';
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
import { attachXapiLrsRoutes, listStoredStatements, storeStatementInternal, getStatementStore } from '../src/xapi-lrs.js';
import type { StoredStatement } from '../src/statement-store.js';
import { attachCmi5LmsRoutes, cmi5BearerTenant, observeCmi5Statement } from '../src/cmi5-lms.js';
import { attachLti13Routes } from '../src/lti13.js';
import { attachOneRosterRoutes } from '../src/oneroster.js';
import {
  attachScormSequencingRoutes, parseManifest, createSession, processNavigation,
  commitTracking, sessionView, type SeqSession, type TrackingUpdate,
} from '../src/scorm-sequencing.js';
import { attachPerformanceRoutes } from '../src/performance-routes.js';
import { attachContentDeliveryRoutes } from '../src/content-delivery.js';
// Re-integration with the agentic-performance (agp:) layer: Foxxi surfaces the
// emergent, learnable standards-extension capability the agp layer affords by
// composing Foxxi's own standards. + the shared in-flow performance-support primitive.
import { proposeStandardsExtension, EXTEND_STANDARDS_GUIDANCE, type ExtensionKind as AgpExtensionKind } from '../../agentic-performance-practice/src/standards-extension.js';
import { attachGuidanceServing, type GuidedAffordanceEntry as FoxxiGuidedEntry } from '../../_shared/guided-affordance/index.js';
import { SAMPLE_COURSE, SAMPLE_JOB_AID } from '../src/sample-content.js';
import type { DeliveryChannel } from '../src/content-channels.js';
import type { ChannelWebhook } from '../src/content-transport.js';
import {
  attachContextChatRoutes, mergeDiscovered,
  type ContextEnrollment, type DiscoveredDescriptor, type CallerVerification,
} from '../src/context-chat.js';
import { attachOpenApiRoutes } from '../src/openapi-spec.js';
import { renderVocabJsonLd, renderVocabTurtle, renderTermJsonLd } from '../src/foxxi-vocab.js';
import { renderSemOntologyJsonLd, renderSemOntologyTurtle, renderSemTermJsonLd } from '../src/ler-tla-vocab.js';
import { emitAffordanceStatement } from '../src/xapi-instrumentation.js';
import { attachXapiAdminRoutes } from '../src/xapi-admin.js';
import { attachOauthTokenRoute } from '../src/xapi-oauth.js';
import { attachHypermediaRoutes } from '../src/hypermedia-resources.js';
import type {
  IRI,
} from '@interego/core';

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

// Sync snapshot of the published-directory users (with wallet_address) used
// to verify session-token signers on the synchronous express gates
// (operator-auth + the xapi-admin gate). Refreshed off autoFetchAdmin
// (itself 60s-cached); empty until first load, then last-good retained.
let directoryUsersCache: ReadonlyArray<{ user_id: string; web_id: string; wallet_address?: string }> = [];

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

/** Refresh the directory-users cache used by the synchronous session-token gates. */
async function refreshDirectoryCache(): Promise<void> {
  try {
    const a = await autoFetchAdmin({});
    if (a?.users) directoryUsersCache = a.users as typeof directoryUsersCache;
  } catch { /* keep last good snapshot */ }
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

// ── Interego substrate pass-through (federated) ─────────────────────
// The Context Companion's 'interego' scope reaches everything composed
// into the user's networked context, not just the Foxxi vertical. It
// discovers Context Descriptors via @interego/core's discover() — across
// the tenant pod AND every federation peer in FOXXI_FEDERATION_PODS,
// merged + deduped (mergeDiscovered). A discovered COURSE descriptor is
// additionally fetched in full from its origin pod (composing
// fetchCoursePackage + payloadToAgenticCourse) so the companion answers
// from its actual content. Cached briefly (manifests are stable).
const FEDERATION_PODS: string[] = (process.env.FOXXI_FEDERATION_PODS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
let interegoDiscoverCache: { at: number; entries: DiscoveredDescriptor[] } | null = null;
const INTEREGO_DISCOVER_TTL_MS = 60_000;
const INTEREGO_DEEP_FETCH_CAP = 8;

async function fetchInteregoDescriptors(): Promise<DiscoveredDescriptor[]> {
  if (!tenantPodUrl) return [];
  if (interegoDiscoverCache && Date.now() - interegoDiscoverCache.at < INTEREGO_DISCOVER_TTL_MS) {
    return interegoDiscoverCache.entries;
  }
  // The federated pod set — the tenant pod plus every configured peer.
  const pods = [...new Set([tenantPodUrl, ...FEDERATION_PODS])];
  const collected: DiscoveredDescriptor[] = [];
  let deepFetched = 0;
  for (const pod of pods) {
    let entries;
    try {
      entries = await discover(pod);
    } catch (err) {
      console.error(`[foxxi-bridge] discover(${pod}) failed:`, (err as Error).message);
      continue;
    }
    for (const e of entries) {
      const described = e.describes[0] ?? e.descriptorUrl;
      const tail = described.split(/[:/#]/).filter(Boolean).pop() ?? described;
      const label = tail.replace(/[-_]+/g, ' ').trim() || described;
      const summary = `Interego context descriptor "${label}" — published at ${e.descriptorUrl}`
        + `; describes ${e.describes.join(', ') || described}`
        + (e.facetTypes.length ? `; facets ${e.facetTypes.join('/')}` : '')
        + (e.conformsTo && e.conformsTo.length ? `; conforms to ${e.conformsTo.join(', ')}` : '')
        + (e.modalStatus ? `; modal status ${e.modalStatus}` : '')
        + (pod !== tenantPodUrl ? `; via federation peer ${pod}` : '') + '.';
      const descriptor: DiscoveredDescriptor = { descriptorUrl: e.descriptorUrl, label, summary, originPod: pod };

      // Deep pass-through: a discovered course package is fetched in full
      // from its origin pod so the companion answers from its content.
      const isCoursePackage = (e.conformsTo ?? []).some(c => c.split(/[#/]/).pop() === 'CoursePackageBundle');
      const courseIdMatch = e.describes.map(g => /:course:(.+)$/.exec(g)).find((m): m is RegExpExecArray => !!m);
      if (isCoursePackage && courseIdMatch && deepFetched < INTEREGO_DEEP_FETCH_CAP) {
        deepFetched++;
        try {
          const pkg = await fetchCoursePackage(courseIdMatch[1], { ...fetcherConfig(), podUrl: pod }) as FoxxiAgenticPayload;
          descriptor.course = payloadToAgenticCourse(pkg, authoritativeSource);
        } catch (err) {
          console.error(`[foxxi-bridge] deep-fetch of course "${courseIdMatch[1]}" from ${pod} failed:`, (err as Error).message);
        }
      }
      collected.push(descriptor);
    }
  }
  const merged = mergeDiscovered(collected);
  interegoDiscoverCache = { at: Date.now(), entries: merged };
  return merged;
}

// ── Agent-mesh projection (Interego collaboration → Foxxi LRS + disposition) ──
// The Interego agent-mesh — johnny (claude.ai), the maintainer (VS Code),
// boozer (ChatGPT) — publishing Findings, shipping Resolutions (cg:supersedes),
// teaching, notifying via LDN inboxes, recording OODA trajectory steps, and
// playing games is a live human/agent PERFORMANCE stream. Foxxi is a
// VIRTUALIZATION LENS over those self-sovereign agent pods, not a datastore that
// ingests them: the agent's pod is the source of truth, and Foxxi projects its
// descriptors into the xAPI/trajectory surfaces ON READ. The projected index is
// a DERIVED, rebuildable view keyed PER SOURCE POD/agent (`lens:<agent>`), held
// in-memory (never written back to the agent's pod), and re-derived from the
// agent's own pod every cycle. Idempotent by deterministic statement id, so the
// poll cycle (and the push path) never double-count. PULL = scheduled discover()
// over FOXXI_MESH_PODS. Each agent's `lens:<agent>` view IS their LRS scope; an
// admin reads it as a role-scoped view, the agent reads their own — no shared silo.
const MESH_PODS: string[] = (process.env.FOXXI_MESH_PODS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
/** Per-source-pod derived-view tenant key. The agent IS their LRS scope. */
function lensTenantFor(agent: string): TenantId { return ('lens:' + agent) as TenantId; }

/** Resolve the SUBJECT's OWN pod URL from their DID/WebID. Foxxi reads the
 *  subject's pod (their self-sovereign wallet + credentials + the source of
 *  their activity), NEVER the Foxxi tenant pod — so a learner/agent record is
 *  assembled from the holder's own pod. Explicit learner_pod_url wins; else
 *  derive from a Solid WebID (account root) or a did:ethr (the eth-<addr> pod on
 *  the same host as the tenant pod); falls back to the tenant pod only if
 *  nothing resolves. */
function resolveSubjectPodUrl(didOrWebId: string | undefined, explicit?: string): string {
  if (explicit) return explicit;
  const id = (didOrWebId ?? '').trim();
  if (!id) return tenantPodUrl;
  const tenantOrigin = (() => { try { return new URL(tenantPodUrl).origin; } catch { return ''; } })();
  // An agent pod id (u-pk-/u-did-/eth-) embedded in ANY identity form — a
  // did:web (…:agents:codex-u-pk-<id>), a bare id, or a WebID path — resolves to
  // that agent's OWN CSS pod. WITHOUT this, did:web/u-pk agents (e.g. a Codex
  // agent like boozer) fell through to the tenant pod, so their self-sovereign
  // records (performance, course completions, SCORM outcomes) misrouted to
  // …/foxxi/ instead of …/<id>/ — the writer-side analogue of the WebID
  // inbox-routing defect. Checked FIRST so an identity-service WebID
  // (…/users/<id>/profile) maps to <id>, not its first path segment ("users").
  const idm = id.match(/(u-pk-|u-did-|u-eth-|eth-)[0-9a-z]+/i);
  if (idm && tenantOrigin) return `${tenantOrigin}/${idm[0].toLowerCase()}/`;
  if (/^https?:\/\//.test(id)) {
    try {
      const u = new URL(id);
      const seg = u.pathname.split('/').filter(Boolean)[0];
      if (seg) return `${u.origin}/${seg}/`;
    } catch { /* fall through */ }
  }
  const m = /^did:ethr:(?:0x)?([0-9a-fA-F]{40})\b/.exec(id);
  if (m && tenantOrigin) return `${tenantOrigin}/eth-${m[1].slice(0, 12).toLowerCase()}/`;
  return tenantPodUrl;
}
const MESH_PROJECT_INTERVAL_MS = Number(process.env.FOXXI_MESH_PROJECT_INTERVAL_MS ?? 60_000);
// Config-injected pod-segment → friendly actor name map (NO application roster
// baked into the projector). Format: FOXXI_MESH_ACTOR_LABELS="seg=name,seg2=name2".
// Absent a mapping, the projector falls back to the pod segment (domain-agnostic).
const MESH_ACTOR_LABELS: Record<string, string> = Object.fromEntries(
  (process.env.FOXXI_MESH_ACTOR_LABELS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    .map(pair => pair.split('=').map(x => x.trim()))
    .filter((kv): kv is [string, string] => kv.length === 2 && !!kv[0] && !!kv[1]),
);
let meshProjectionRunning = false;

/** Land one projected mesh event into its agent's OWN derived-view tenant
 *  (`lens:<agent>`) — the PUSH path, single event, no batch contention. */
function landMeshEvent(ev: ProjectedMeshEvent): void {
  storeStatementInternal(ev.statement, lensTenantFor(ev.agent));
}

/** Land a batch into each event's per-agent `lens:<agent>` view (memory-backed
 *  derived index — no pod write, no manifest contention). Idempotent on the
 *  deterministic statement id, so re-projection each cycle is a true no-op. */
async function landMeshBatch(events: ProjectedMeshEvent[]): Promise<number> {
  let landed = 0;
  for (const ev of events) {
    const id = String((ev.statement as Record<string, unknown>).id);
    try {
      const store = getStatementStore(lensTenantFor(ev.agent));
      const storedAt = new Date().toISOString();
      await store.put({ id, statement: { ...ev.statement, stored: storedAt }, stored: storedAt, voided: false } as StoredStatement);
      landed++;
    } catch (err) {
      console.warn(`[foxxi-bridge][mesh] put failed for ${id} (${ev.mode}):`, (err as Error).message);
    }
  }
  return landed;
}

/** PULL cycle: discover every mesh pod, project, land sequentially, refresh trajectories. */
async function runMeshProjectionCycle(): Promise<{ pods: number; projected: number; agents: number }> {
  if (MESH_PODS.length === 0 || meshProjectionRunning) return { pods: 0, projected: 0, agents: 0 };
  meshProjectionRunning = true;
  const events: ProjectedMeshEvent[] = [];
  const stepsByAgent = new Map<string, TrajectoryStepInput[]>();
  try {
    for (const pod of MESH_PODS) {
      let entries;
      try { entries = await discover(pod); }
      catch (err) { console.error(`[foxxi-bridge][mesh] discover(${pod}) failed:`, (err as Error).message); continue; }
      for (const e of entries as unknown as MeshDiscoverEntry[]) {
        // Durable Foxxi artifacts (foxxi:RecordedPerformance = the agent's OWN
        // persisted xAPI Statements with result; foxxi:ScormCourse = authored
        // courses) are handled by their dedicated durable read paths, NOT the
        // domain-agnostic mesh projector — projecting them here would
        // double-count and mint a bogus competency keyed off the artifact type.
        if ((e.conformsTo ?? []).some(c => NON_PROJECTABLE_LOCALNAMES.has(c.split(/[#/]/).pop() ?? ''))) continue;
        const ev = projectMeshEntry(e, pod, MESH_ACTOR_LABELS);
        if (!ev) continue;
        events.push(ev);
        const list = stepsByAgent.get(ev.agent) ?? [];
        list.push(ev.step);
        stepsByAgent.set(ev.agent, list);
      }
    }
    const landed = await landMeshBatch(events);
    // Rebuild each agent's trajectory under ITS OWN `lens:<agent>` view so
    // agent-disposition / diagnose read each agent's mesh activity in its own
    // scope (not a shared silo).
    for (const [agent, steps] of stepsByAgent.entries()) {
      agentTrajectoriesByTenant.for(lensTenantFor(agent)).set(agent, buildTrajectory(agent, agent, steps));
    }
    if (events.length > 0) {
      console.log(`[foxxi-bridge][mesh] projected ${events.length} event(s) (landed ${landed}) from ${MESH_PODS.length} pod(s) across ${stepsByAgent.size} agent(s) -> per-agent lens:<agent> views`);
    }
    return { pods: MESH_PODS.length, projected: landed, agents: stepsByAgent.size };
  } finally {
    meshProjectionRunning = false;
  }
}

// ── Channel transport config ────────────────────────────────────────
// Each FOXXI_TRANSPORT_<CHANNEL> env var (a webhook URL, optionally
// `URL||AuthHeader`) wires a real outbound send for that channel — a
// Slack incoming webhook, an email/SMS provider HTTP API. Unset → the
// channel falls back to the Interego-native pod-descriptor publish.
function channelWebhooks(): Partial<Record<DeliveryChannel, ChannelWebhook>> {
  const out: Partial<Record<DeliveryChannel, ChannelWebhook>> = {};
  for (const ch of ['document', 'email', 'chat', 'sms'] as const) {
    const raw = process.env[`FOXXI_TRANSPORT_${ch.toUpperCase()}`]?.trim();
    if (!raw) continue;
    const [url, authHeader] = raw.split('||').map(s => s.trim());
    if (url) out[ch] = { url, ...(authHeader ? { authHeader } : {}) };
  }
  return out;
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

  const addressMap = buildAddressMap(admin.users ?? []);
  const verified = verifySessionToken(token, addressMap);
  if (!verified.ok) return { error: `auth: ${verified.reason}` };

  const ctx = resolveCallerContext({
    callerWebId: verified.callerDid,
    callerUserId: verified.callerUserId,
    users: admin.users as unknown as Parameters<typeof resolveCallerContext>[0]['users'],
    adminWebId,
    learningEngineerWebIds,
  });
  return { ctx, admin };
}

// ── Handlers ───────────────────────────────────────────────────────────

const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  // ── Emergent standards-extension (agp layer re-integrated) ──────────
  // Afforded by the agentic-performance layer composing Foxxi's standards;
  // surfaced here so it is a first-class Foxxi affordance + MCP tool + the
  // createVerticalBridge-registered POST /agent/extend-standards route.
  'foxxi.extend_standards': async (args) => proposeStandardsExtension({
    kind: String(args.kind) as AgpExtensionKind,
    name: String(args.name ?? ''),
    definition: String(args.definition ?? ''),
    label: args.label as string | undefined,
    extendsStandard: args.extends_standard as string | undefined,
    subClassOf: args.subclass_of as string | undefined,
    buildsCapability: args.builds_capability as string | undefined,
  }),
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
    // Read the holder's OWN self-sovereign pod wallet — never the Foxxi tenant pod.
    const learnerPodUrl = resolveSubjectPodUrl(requestedLearnerDid, args.learner_pod_url as string | undefined);
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
    // VIRTUALIZE over the SUBJECT'S OWN pod — Foxxi is a lens, not a store. Read
    // the subject's self-sovereign pod (wallet/credentials, via exportClr inside
    // assembleEnterpriseLearnerRecord) and their OWN derived LRS view
    // (lens:<agent>, already subject-scoped), never the Foxxi tenant pod/store.
    const subjectPodUrl = resolveSubjectPodUrl(requestedLearnerDid, args.learner_pod_url as string | undefined);
    const subjectLabel = actorForPod(subjectPodUrl, MESH_ACTOR_LABELS);
    // The lens is an in-memory derived view; the durable records on the
    // subject's OWN pod are the system of record. Union them (deduped by id) so
    // the ELR reflects everything the agent has performed — even across a bridge
    // restart that emptied the lens.
    const lensStatements = await listStoredStatements(lensTenantFor(subjectLabel));
    const durableStatements = await readDurableRecordedStatements({ podUrl: subjectPodUrl });
    const learnerStatements = mergeStatementsById(lensStatements, durableStatements);
    const elr = await assembleEnterpriseLearnerRecord({
      learnerDid: requestedLearnerDid,
      learnerName: args.learner_name as string | undefined,
      learnerPodUrl: subjectPodUrl,
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
          // A creator-declared DOMAIN activity type (e.g. urn:ttt:Move) makes this
          // a publishing-layer vocabulary act: the ELR projector aggregates a
          // competency by this type across instances. Absent one, it falls back to
          // the generic ProductionTask wrapper (the competency then keys off
          // task_name — the skill the caller explicitly named).
          type: (typeof args.activity_type === 'string' && args.activity_type.trim())
            ? args.activity_type.trim()
            : 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#ProductionTask',
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
    const statementId = storeStatementInternal(statement, callTenant(args));
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
    const agentTrajectories = agentTrajectoriesByTenant.for(callTenant(args));
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
      storeStatementInternal({ id: randomUUID(), ...stmt }, callTenant(args));
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
    const agentTrajectories = agentTrajectoriesByTenant.for(callTenant(args));
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
    const agentTrajectories = agentTrajectoriesByTenant.for(callTenant(args));
    const performanceProbes = performanceProbesByTenant.for(callTenant(args));
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
    // If the team has a probe portfolio, fold in the interventional + counterfactual causal read.
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
    const agentTrajectories = agentTrajectoriesByTenant.for(callTenant(args));
    const performanceProbes = performanceProbesByTenant.for(callTenant(args));
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
    // Snapshot the disposition before the change — the causal baseline.
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
      note: 'Safe-to-fail probe recorded as a deliberate, reversible change to a constraint; the team disposition was snapshotted as the causal baseline. Re-assess the team to read the interventional + counterfactual causal effect. A safe-to-fail probe is allowed — expected, even — to fail cheaply.',
      accessDecision: trace,
    };
  },

  // ── Multi-team agent / harness evaluation ─────────────────────────

  'foxxi.record_external_agent_run': async (args) => {
    const resolved = await resolveCaller(args);
    if ('error' in resolved) return { error: resolved.error };
    const { ctx } = resolved;
    const tenant = callTenant(args);
    const agentTrajectories = agentTrajectoriesByTenant.for(tenant);
    const evaluationRegistry = evaluationRegistryByTenant.for(tenant);
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
    for (const stmt of ingested.statements) storeStatementInternal({ id: randomUUID(), ...stmt }, tenant);
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
    const evaluationRegistry = evaluationRegistryByTenant.for(callTenant(args));
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
    const evaluationRegistry = evaluationRegistryByTenant.for(callTenant(args));
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
    const evaluationRegistry = evaluationRegistryByTenant.for(callTenant(args));
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
    const evaluationRegistry = evaluationRegistryByTenant.for(callTenant(args));
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
    const evaluationRegistry = evaluationRegistryByTenant.for(callTenant(args));
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
// FOXXI_DASHBOARD_ORIGIN for production. Multiple browser surfaces
// (dashboard + microsite) supply a comma-separated list; the middleware
// below echoes back the request's Origin if it's in the allow-list
// (single Access-Control-Allow-Origin per CORS spec).
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
      // A cmi5 launch's auth-token resolves to the launch's tenant.
      bearerTenantResolver: cmi5BearerTenant,
      // Per-user self-sovereign forwarding: a statement forwards to the
      // OWNER's lens targets, derived from the actor's identity. Only
      // recognizable self-sovereign identities map to an owner lens; generic
      // upstream account names return null and fall back to the caller tenant.
      ownerTenantOfStatement: (stmt) => {
        const name = (stmt?.actor as { account?: { name?: string } } | undefined)?.account?.name;
        if (typeof name !== 'string' || !name) return null;
        if (!/^did:(ethr|web|key):/.test(name) && !/(u-pk-|u-did-|u-eth-|eth-0x)/.test(name)) return null;
        return lensTenantFor(actorForPod(resolveSubjectPodUrl(name), MESH_ACTOR_LABELS));
      },
      // cmi5 moveOn orchestration — after each Statement is stored, the
      // LMS re-evaluates the AU's moveOn and auto-emits `satisfied`.
      onStatementStored: (stmt, tenant) => {
        void observeCmi5Statement(stmt, tenant, {
          statementsForRegistration: async (reg) =>
            (await getStatementStore(tenant).query({ registration: reg, limit: 500 }))
              .statements.map(r => r.statement),
          emit: (s) => { storeStatementInternal(s, tenant); },
        }).catch(() => undefined);
      },
    });

    // cmi5 LMS launch contract (IEEE 9274.2.1 §7–§8) — Foxxi-as-LMS can
    // LAUNCH content: it hands an Assignable Unit a conformant launch URL
    // + stages LaunchData, and mints the one-time fetch token the AU
    // exchanges for LRS auth (GET /cmi5/launch, POST /cmi5/fetch/:token).
    // Operator-auth for the L3 REST surfaces — honor ?tenant_pod_url only
    // for a SIGNATURE-VERIFIED admin/learning-engineer; pin everyone else to
    // the default tenant. loadUsers feeds verifySessionToken the published
    // directory's wallet_address map.
    const operatorAuth = { adminWebId, learningEngineerWebIds, loadUsers: () => directoryUsersCache };
    // Warm + periodically refresh the directory cache (everything is
    // initialized here) so the synchronous gates can verify signers.
    void refreshDirectoryCache();
    { const t = setInterval(() => void refreshDirectoryCache(), 5 * 60_000); (t as { unref?: () => void }).unref?.(); }

    attachCmi5LmsRoutes(a, {
      selfBaseUrl: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080',
      authoritativeSource,
      ...operatorAuth,
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
      ...operatorAuth,
    });

    // OneRoster 1.2 — SIS / HR roster sync. Both a producer (Foxxi
    // exposes its roster) and a consumer (`POST /oneroster/v1p2/import`
    // applies a CSV bundle into the tenant's imported roster overlay).
    attachOneRosterRoutes(a, { tenantDid: authoritativeSource, ...operatorAuth });

    // SCORM 2004 4th Ed. Sequencing & Navigation runtime — Foxxi-as-LMS
    // can ENFORCE sequencing (control modes, sequencing rules, limit
    // conditions, rollup) rather than merely transcribe it. Routes:
    // POST /scorm/sequencing/session, .../navigate, .../commit; GET .../:id.
    attachScormSequencingRoutes(a, {
      selfBaseUrl: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080',
    });

    // Foxxi Performance Architecture — the diagnosis → intervention
    // spine + the emergent-content authoring tools. A performance gap is
    // diagnosed (regime-routed: gap analysis for Evident/Knowable work,
    // dispositional probes for Emergent work); content is composed only when
    // the diagnosis says it is the answer. Routes: GET /performance,
    // POST /performance/plan, /content/compose-course, /content/personalize.
    attachPerformanceRoutes(a, {
      selfBaseUrl: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080',
      // Delegated-auth verifier → exposes the SIGNED, followable
      // contextualize-and-plan affordance so a mesh agent (one that can only
      // act on discovered affordances, not raw-POST) classifies a situation AS
      // ITSELF (sign_request → invoke_affordance), attributed to its DID.
      verifyDelegatedCaller,
      // Pod-publishing config. When set, the performance routes mint a
      // real cg:ContextDescriptor for every outcome / situation / teaching
      // package and write it (plus a TriG named-graph) to the tenant pod.
      // The bridge keeps its in-memory mirror for fast calibration reads;
      // the pod is the source of truth, and descriptors are dereferenceable
      // from the URLs the response's _affordances block carries.
      ...(tenantPodUrl ? {
        publishConfig: {
          podUrl: tenantPodUrl,
          authoritativeSource: authoritativeSource as IRI,
          containerPath: 'foxxi/work-products/',
        },
      } : {}),
    });

    // Content delivery — closes the loop. A composed course is generated
    // into a cmi5 package + a SCORM .zip, registered on the cmi5 LMS
    // (launchable, trackable), and its runnable AUs served; job aids are
    // published and channel-delivered (chat/email/SMS/document), every
    // delivery instrumented as an xAPI statement into the live LRS.
    attachContentDeliveryRoutes(a, {
      selfBaseUrl: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080',
      authoritativeSource,
      emitStatement: (stmt, tenant) => { storeStatementInternal(stmt, tenant); },
      // Channel transport — POST /content/deliver actually sends: a
      // configured per-channel webhook, else the Interego-native
      // pod-descriptor publish (the delivery becomes discoverable
      // substrate). The pod is the tenant pod.
      transport: {
        webhooks: channelWebhooks(),
        ...(tenantPodUrl ? { podUrl: tenantPodUrl } : {}),
      },
    });

    // Context Companion — the one conversational front door over a user's
    // networked context. POST /content/ask takes a natural-language
    // question from any human or agent user, classifies its intent, and
    // answers from the substrate's own surfaces: assignments, the
    // published content, the job aids, and the live LRS. Content
    // questions delegate to the vertical's existing agentic RAG
    // (concept-graph retrieval + LLM synthesis + the modal-statused
    // Interego trace), keyed off the same FOXXI_LLM_API_KEY and the same
    // per-IP rate limiter the agentic-ask MCP handler already uses.
    attachContextChatRoutes(a, {
      selfBaseUrl: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080',
      authoritativeSource,
      emitStatement: (stmt, tenant) => { storeStatementInternal(stmt, tenant); },
      llmApiKey: (process.env.FOXXI_LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY)?.trim(),
      checkLlmRateLimit: (clientIp) => {
        const rl = checkAgenticRateLimit(clientIp);
        return rl.ok ? { ok: true } : { ok: false, retryAfterSeconds: rl.retryAfterSeconds };
      },
      // Scope 'interego' — pass through to everything composed into the
      // user's networked context, via the substrate's discover().
      discoverInteregoContext: () => fetchInteregoDescriptors(),
      // Gate progress / assignment questions behind the same wallet-
      // signed session token the rest of the bridge verifies — a
      // learner's own record is PII; content questions stay open.
      verifyCaller: async (token): Promise<CallerVerification> => {
        if (!token) return { ok: false, reason: 'Pass Authorization: Bearer <session-token>.' };
        const admin = await autoFetchAdmin({});
        if (!admin) return { ok: false, reason: 'the tenant directory is unavailable for verification.' };
        const addressMap = buildAddressMap(admin.users ?? []);
        const verified = verifySessionToken(token, addressMap);
        if (!verified.ok) return { ok: false, reason: `the token was rejected (${verified.reason}).` };
        const ctx = resolveCallerContext({
          callerWebId: verified.callerDid,
          callerUserId: verified.callerUserId,
          users: admin.users as unknown as Parameters<typeof resolveCallerContext>[0]['users'],
          adminWebId,
          learningEngineerWebIds,
        });
        return { ok: true, webId: verified.callerDid, role: ctx.role };
      },
      resolveAssignments: async (learner): Promise<ContextEnrollment[] | undefined> => {
        const admin = await autoFetchAdmin({});
        if (!admin) return undefined;
        const resolved = discoverAssignedCourses({ admin, learnerWebId: learner });
        if (resolved.enrollments.length === 0) return undefined;
        return resolved.enrollments.map(e => ({
          courseId: e.courseId,
          courseTitle: e.courseTitle,
          status: e.status,
          requirementType: e.requirementType,
          ...(e.dueAt ? { dueAt: e.dueAt } : {}),
          source: 'policy' as const,
        }));
      },
    });

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
      loadUsers: () => directoryUsersCache,
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
      // Per-IP injection — Azure Container Apps appends the real client
      // IP as the LAST hop of x-forwarded-for. Taking the first hop would
      // let an attacker forge it via a client-supplied header and bypass
      // per-IP rate limits. Fall back to req.ip for local dev.
      const xff = req.headers['x-forwarded-for'];
      const clientIp = typeof xff === 'string'
        ? xff.split(',').at(-1)!.trim()
        : Array.isArray(xff) ? xff.at(-1)!.trim() : req.ip ?? 'unknown';

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

/**
 * Seed the demo course + job aid into the content store at startup, so
 * every demo works on a cold deploy with no setup ritual — the Context
 * Companion always has real content to answer from. Composes the same
 * affordances a real client would call; failure is non-fatal.
 */
async function seedDemoContent(): Promise<void> {
  const base = `http://localhost:${PORT}`;
  const postJson = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const composed = await postJson('/content/compose-course', SAMPLE_COURSE)
      .then(r => r.json()) as { course?: unknown };
    if (composed.course) await postJson('/content/publish-course', { course: composed.course });
    await postJson('/content/job-aid', SAMPLE_JOB_AID);
    console.log('[foxxi-bridge] seeded the demo course + job aid into the content store');
  } catch (e) {
    console.warn(`[foxxi-bridge] demo-content seed skipped: ${(e as Error).message}`);
  }
}

// SUBSTRATE-NATIVE REVIEW: a trusted relay brokers an agent reviewing its OWN
// Foxxi performance record. The relay authenticates the caller via THEIR
// substrate identity (their DID / connector — the identity they already use) and
// authenticates the calling AGENT directly — it verifies the agent's OWN rev-196
// signed-request envelope (the same one the relay uses) and binds identity to the
// recovered did:ethr. No relay vouching secret: Foxxi is a composed vertical, not a
// relay tenant, so it must not couple to the relay's trust. The agent reaches here
// emergently — discover → dereference → act on the published cg:Affordance — and the
// `act` body carries the signed envelope. The record is virtualized over the
// SUBJECT'S OWN pod — wallet/credentials via exportClr (CLR 2.0), xAPI from their own
// lens view, competencies composed by assembleEnterpriseLearnerRecord (IEEE P2997).
// Foxxi is the lens; the agent's pod is the record. Self-sovereign: the caller's own
// record is always allowed; a different subject is honored only for discoverable
// agent-capability records.
// Signed payload: { subject_did?, subject_pod_url?, subject_name?, actor_kind?,
//   include_clr?, agent_id: 'did:ethr:<addr>', timestamp: <ISO 8601> }.
// Self-describing capability affordance for the EMERGENT path. Served as a
// standalone followable turtle so the cg:Affordance lives in the resource body
// the affordance-follower actually reads — not buried in a named-graph payload
// (the gap that made a published-via-publish_context URN dereference to an empty
// affordance set). An agent dereferences this URL and `act`s the affordance; the
// follower POSTs the rev-196 signed envelope to hydra:target (/agent/review-record),
// which authenticates the agent's own signature. This is how Foxxi (a composed
// vertical) advertises a capability over Interego without a substrate-relay tool.
const REVIEW_RECORD_AFFORDANCE: Affordance = {
  action: 'urn:cg:action:foxxi:review-record' as Affordance['action'],
  toolName: 'review_foxxi_record',
  title: 'Review your Foxxi performance record',
  description: 'Review your IEEE P2997 Enterprise Learner Record + 1EdTech CLR 2.0 credential wallet, virtualized by Foxxi entirely over your OWN pod. Authenticate with a rev-196 signed-request envelope — Foxxi verifies your own signature and binds identity to the recovered did:ethr (no relay, no separate login). Defaults to your own record; pass subject_did for a discoverable agent-capability record.',
  method: 'POST',
  targetTemplate: '{base}/agent/review-record',
  mediaType: 'application/json',
  inputs: [
    { name: '_signed_payload', type: 'string', required: true, description: "JSON.stringify({ agent_id: 'did:ethr:<addr>', timestamp: <ISO 8601, within ±60s>, subject_did?, subject_pod_url?, subject_name?, actor_kind?, include_clr? })" },
    { name: '_signature', type: 'string', required: true, description: 'secp256k1 signature over the canonical message sha256:<hex(sha256(_signed_payload))>, signed with the wallet matching agent_id.' },
  ],
};

// GET the followable affordance turtle for the review-record capability.
app.get('/agent/review-record/affordance', (_req, res) => {
  const base = (process.env.BRIDGE_DEPLOYMENT_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
  res.type('text/turtle').send(
    affordancesManifestTurtle(
      `${base}/agent/review-record/affordance`,
      [REVIEW_RECORD_AFFORDANCE],
      base,
      {
        verticalLabel: 'Foxxi performance-record review',
        rdfsComment: 'Emergent capability over Interego: act this affordance with a rev-196 signed-request envelope as payload. Foxxi verifies your OWN signature (no relay tool, no relay vouching).',
      },
    ),
  );
});

app.post('/agent/review-record', async (req, res) => {
  try {
    // Recover the rev-196 signature (pure), then bind identity in one of two modes:
    //   DIRECT — the signer IS the agent (agent_id embeds the recovered address):
    //     a wallet-holding identity (the maintainer, an external eth wallet).
    //   DELEGATED — the relay signed on a relay-mediated agent's behalf (via the
    //     sign_request primitive, since the relay is single-signer and the agent
    //     has no key of its own). We verify the agent's delegation on their OWN pod
    //     is CryptographicallyVerified AND that the request signer is that
    //     credential's anchor key — so the relay can sign only for agents it has
    //     actually been delegated to, and the VC (read from the agent's pod, NOT
    //     the envelope) cannot be forged. No relay vouching secret either way.
    const rec = recoverSignedRequest(req.body);
    if (!rec.ok) {
      res.status(401).json({
        error: `agent signature required: ${rec.reason}`,
        hint: 'POST a rev-196 signed envelope { _signature, _signed_payload: JSON.stringify({ ...args, agent_id, timestamp }) }. Wallet-holding agents sign locally; relay-mediated agents get the envelope from the relay `sign_request` tool, then act the published cg:Affordance urn:interego:foxxi:capability:review_foxxi_record.',
      });
      return;
    }
    const p = rec.payload;
    const claimedAddr = rec.agentId.toLowerCase().match(/0x[0-9a-f]{40}/)?.[0];
    let callerDid: string;
    let authMode: 'direct' | 'delegated';
    if (claimedAddr && claimedAddr === rec.signer.toLowerCase()) {
      // DIRECT: the signer is the agent itself.
      callerDid = `did:ethr:${rec.signer}`;
      authMode = 'direct';
    } else {
      // DELEGATED: verify the agent's on-pod delegation + that the request signer
      // is its anchor key. verifyAgentDelegation reads the signed VC from the
      // agent's pod, checks registry membership/revocation, and walks the chain.
      const delegationPod = resolveSubjectPodUrl(rec.agentId, typeof p.subject_pod_url === 'string' ? p.subject_pod_url : undefined);
      let del;
      try {
        del = await verifyAgentDelegation(rec.agentId as unknown as IRI, delegationPod, { verifier: makeWalletDelegationVerifier() });
      } catch (err) {
        res.status(401).json({ error: `delegation verification failed for ${rec.agentId} on ${delegationPod}: ${(err as Error).message}` });
        return;
      }
      if (!del.valid || del.trustLevel !== 'CryptographicallyVerified') {
        res.status(401).json({ error: `agent ${rec.agentId} has no cryptographically-verified delegation on ${delegationPod}: ${del.reason ?? del.trustLevel ?? 'unverified'}` });
        return;
      }
      const vc = await readDelegationCredential(delegationPod, rec.agentId as unknown as IRI).catch(() => null);
      const anchor = vc?.proof?.signerAddress;
      if (!anchor || anchor.toLowerCase() !== rec.signer.toLowerCase()) {
        res.status(401).json({ error: `request signer ${rec.signer} is not the delegation anchor key${anchor ? ` (${anchor})` : ''} — only the key that anchors the agent's delegation may sign for them` });
        return;
      }
      callerDid = rec.agentId;
      authMode = 'delegated';
    }
    // Self-sovereign: default to the caller's OWN record. A different subject_did
    // is honored only because agent-capability records are discoverable.
    const subjectDid = (typeof p.subject_did === 'string' && p.subject_did.trim()) ? p.subject_did.trim() : callerDid;
    const isSelf = subjectDid === callerDid;
    // Virtualize over the SUBJECT'S OWN pod + their own lens view.
    const subjectPodUrl = resolveSubjectPodUrl(subjectDid, typeof p.subject_pod_url === 'string' ? p.subject_pod_url : undefined);
    const subjectLabel = actorForPod(subjectPodUrl, MESH_ACTOR_LABELS);
    const subjectKind: 'human' | 'agent' = (p.actor_kind as string) === 'human' ? 'human' : 'agent';
    // Union the in-memory lens with the subject's durable on-pod records (deduped
    // by id) — the pod is the system of record, the lens just a derived view.
    const lensStatements = await listStoredStatements(lensTenantFor(subjectLabel));
    const durableStatements = await readDurableRecordedStatements({ podUrl: subjectPodUrl });
    const statements = mergeStatementsById(lensStatements, durableStatements);
    const elr = await assembleEnterpriseLearnerRecord({
      learnerDid: subjectDid,
      learnerName: typeof p.subject_name === 'string' ? p.subject_name : undefined,
      learnerPodUrl: subjectPodUrl,
      subjectKind,
      tenantDid: tenantProfileDid,
      lrsEndpoint: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080',
      statements,
    });
    let clr: unknown;
    if (p.include_clr !== false) {
      try { clr = await exportClr({ learnerPodUrl: subjectPodUrl, learnerDid: subjectDid }); }
      catch (err) { clr = { error: `wallet read failed: ${(err as Error).message}` }; }
    }
    res.json({
      ok: true,
      reviewedAs: callerDid,
      authMode,
      self: isSelf,
      subject: { did: subjectDid, podUrl: subjectPodUrl, label: subjectLabel, kind: subjectKind, lensTenant: lensTenantFor(subjectLabel), statementCount: statements.length },
      elr,
      ...(clr !== undefined ? { clr } : {}),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── Creator-authority credential issuance ─────────────────────────────────
// A vertical-creator (e.g. johnny, who authored a TTT competency) issues an Open
// Badges 3.0 / W3C VC to an agent who demonstrated that competency. ISSUED BY the
// creator: a stable, platform-custodied per-creator issuer did:key derived from
// their own identity (a relay-mediated agent holds no signing key of its own, so
// the platform custodies a deterministic issuer identity bound to them — the same
// principle as descriptor authorship + sign_request). ALIGNED to the creator's
// competency, DELIVERED to the RECIPIENT's own pod wallet (their export_clr
// surfaces it). The creator is the authority for their own vertical's credentials,
// gated by the SAME verifiable-delegation auth as review-record — no tenant admin.
// Reach it by signing the request (sign_request) and acting the affordance below.
// Signed payload: { recipient_did, recipient_pod_url?, recipient_name?,
//   competency_name, competency_id?, competency_framework?, achievement_description?,
//   criterion?, evidence?, agent_id, timestamp }.
const ISSUE_CREDENTIAL_AFFORDANCE: Affordance = {
  action: 'urn:cg:action:foxxi:issue-credential' as Affordance['action'],
  toolName: 'issue_foxxi_credential',
  title: 'Issue a competency credential as the authority for your vertical',
  description: 'Issue an Open Badges 3.0 / W3C Verifiable Credential to an agent who demonstrated a competency you defined, as the AUTHORITY for your own vertical. The credential is issued by your stable, platform-custodied issuer identity (derived from your DID), aligned to your competency, and delivered to the recipient agent\'s OWN pod wallet — their CLR surfaces it. Gated by your verifiable delegation (no tenant admin). Reach it: sign_request the issuance args, then act this affordance with the envelope.',
  method: 'POST',
  targetTemplate: '{base}/agent/issue-credential',
  mediaType: 'application/json',
  inputs: [
    { name: '_signed_payload', type: 'string', required: true, description: "JSON.stringify({ agent_id, timestamp, recipient_did, recipient_pod_url?, recipient_name?, competency_name, competency_id?, competency_framework?, achievement_description?, criterion?, evidence? })" },
    { name: '_signature', type: 'string', required: true, description: 'secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id (use the relay sign_request tool).' },
  ],
};

app.get('/agent/issue-credential/affordance', (_req, res) => {
  const base = (process.env.BRIDGE_DEPLOYMENT_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
  res.type('text/turtle').send(
    affordancesManifestTurtle(`${base}/agent/issue-credential/affordance`, [ISSUE_CREDENTIAL_AFFORDANCE], base, {
      verticalLabel: 'Foxxi creator-authority credentialing',
      rdfsComment: 'Issue a competency credential as the authority for your own vertical, signed via your delegation, into the recipient\'s CLR wallet.',
    }),
  );
});

app.post('/agent/issue-credential', async (req, res) => {
  try {
    // SAME verifiable-delegation auth as /agent/review-record.
    const rec = recoverSignedRequest(req.body);
    if (!rec.ok) {
      res.status(401).json({ error: `agent signature required: ${rec.reason}`, hint: 'sign_request the issuance args, then act urn:cg:action:foxxi:issue-credential.' });
      return;
    }
    const p = rec.payload;
    const claimedAddr = rec.agentId.toLowerCase().match(/0x[0-9a-f]{40}/)?.[0];
    let callerDid: string;
    if (claimedAddr && claimedAddr === rec.signer.toLowerCase()) {
      callerDid = `did:ethr:${rec.signer}`;
    } else {
      const delegationPod = resolveSubjectPodUrl(rec.agentId, typeof p.subject_pod_url === 'string' ? p.subject_pod_url : undefined);
      let del;
      try {
        del = await verifyAgentDelegation(rec.agentId as unknown as IRI, delegationPod, { verifier: makeWalletDelegationVerifier() });
      } catch (err) {
        res.status(401).json({ error: `delegation verification failed for ${rec.agentId} on ${delegationPod}: ${(err as Error).message}` });
        return;
      }
      if (!del.valid || del.trustLevel !== 'CryptographicallyVerified') {
        res.status(401).json({ error: `agent ${rec.agentId} has no cryptographically-verified delegation on ${delegationPod}: ${del.reason ?? del.trustLevel ?? 'unverified'}` });
        return;
      }
      const vc = await readDelegationCredential(delegationPod, rec.agentId as unknown as IRI).catch(() => null);
      const anchor = vc?.proof?.signerAddress;
      if (!anchor || anchor.toLowerCase() !== rec.signer.toLowerCase()) {
        res.status(401).json({ error: `request signer ${rec.signer} is not the delegation anchor key${anchor ? ` (${anchor})` : ''}` });
        return;
      }
      callerDid = rec.agentId;
    }
    if (!issuerKeySeed) { res.status(503).json({ error: 'issuance not configured (FOXXI_ISSUER_KEY_SEED unset)' }); return; }
    const recipientDid = typeof p.recipient_did === 'string' ? p.recipient_did.trim() : '';
    if (!recipientDid) { res.status(400).json({ error: 'recipient_did required' }); return; }
    const competencyName = (typeof p.competency_name === 'string' && p.competency_name.trim()) ? p.competency_name.trim() : '';
    if (!competencyName) { res.status(400).json({ error: 'competency_name required' }); return; }
    const competencyId = (typeof p.competency_id === 'string' && p.competency_id.trim())
      ? p.competency_id.trim()
      : `urn:foxxi:competency:${competencyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`;
    const recipientPod = resolveSubjectPodUrl(recipientDid, typeof p.recipient_pod_url === 'string' ? p.recipient_pod_url : undefined);
    // Per-creator issuer identity: a stable did:key the platform custodies on the
    // creator's behalf, derived deterministically from their DID.
    const creatorIssuerSeed = `${issuerKeySeed}:creator:${callerDid}`;
    const subject: CourseCompletionSubject = {
      learnerDid: recipientDid,
      learnerName: typeof p.recipient_name === 'string' ? p.recipient_name : undefined,
      courseId: competencyId,
      courseTitle: competencyName,
      courseDescription: typeof p.achievement_description === 'string' ? p.achievement_description : undefined,
      criterionNarrative: (typeof p.criterion === 'string' && p.criterion)
        ? p.criterion
        : `Demonstrated "${competencyName}" — conferred by ${callerDid} as the authority for this competency.`,
      alignedSkills: [{
        targetCode: competencyId,
        targetName: competencyName,
        ...(typeof p.competency_framework === 'string' ? { targetFramework: p.competency_framework } : {}),
      }],
      evidence: Array.isArray(p.evidence) ? p.evidence as CourseCompletionSubject['evidence'] : undefined,
    };
    const result = await issueCourseCompletionCredential({
      subject, tenantProfileDid, tenantProfileName, issuerSeed: creatorIssuerSeed, learnerPodUrl: recipientPod,
    });
    // Record the ISSUER's own act (expressive `credentialed` verb) into their lens +
    // pod — the issuing authority's work is first-class activity, not invisible.
    const credentialedStatementId = emitAgentActivity({
      actorDid: callerDid, verbIri: CREDENTIALED_VERB, verbDisplay: 'credentialed',
      objectId: result.vc.id, objectName: `${competencyName} → ${recipientDid}`,
      objectType: 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#activities/credential',
      result: { completion: true, success: true },
    });
    res.json({
      ok: true,
      issuedBy: callerDid,
      issuerDid: result.vc.issuer,
      credentialId: result.vc.id,
      recipient: { did: recipientDid, podUrl: recipientPod },
      competency: { id: competencyId, name: competencyName },
      descriptorUrl: result.publishResult.descriptorUrl,
      ...(credentialedStatementId ? { credentialedStatementId } : {}),
      vc: result.vc,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── Independent capability verification (issuer-side) ─────────────────────
// An issuer does NOT credential on a learner's self-report alone. Before issuing,
// the issuer INDEPENDENTLY verifies the subject's claimed capability: (1) re-reads
// the subject's AUTHORITATIVE records (their OWN pod ∪ lens — not a convenience
// projection), (2) confirms an ENGINE-GRADED course completion exists (the SCORM SN
// runtime rolled up the score — the subject could not fabricate it), (3) confirms a
// domain-typed performance with asserted success is recorded on the subject's pod,
// flagging whether it is self-observed, and (4) validates the named extension
// conforms to the agp:StandardsExtension shape (reconstructed via the same standards
// composer). The verdict distinguishes independently-verified evidence from a
// self-attested outcome — so the credentialing decision rests on the parts that are
// tamper-evident (engine grading + shape conformance), not on the subject's word.
const VERIFY_EXTENSION_AFFORDANCE: Affordance = {
  action: 'urn:cg:action:foxxi:verify-extension' as Affordance['action'],
  toolName: 'verify_extension',
  title: 'Independently verify a subject extended a standard (before crediting)',
  description: 'Independently verify, from the SUBJECT\'s own authoritative pod records, that they (a) completed an engine-graded course and (b) recorded a domain-typed StandardsExtension performance, and that the named extension (c) conforms to the agp:StandardsExtension shape. Returns a verdict that separates independently-verified evidence from any self-attested outcome — the issuer\'s due diligence before issue-credential. Signed payload: { subject_did, name?, kind?, subject_pod_url? }. sign_request -> act.',
  method: 'POST',
  targetTemplate: '{base}/agent/verify-extension',
  mediaType: 'application/json',
  inputs: [
    { name: '_signed_payload', type: 'string', required: true, description: 'JSON.stringify({ agent_id, timestamp, subject_did, name?, kind? })' },
    { name: '_signature', type: 'string', required: true, description: 'sign_request signature' },
  ],
};
app.get('/agent/verify-extension/affordance', (_req, res) => {
  const base = (process.env.BRIDGE_DEPLOYMENT_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
  res.type('text/turtle').send(affordancesManifestTurtle(`${base}/agent/verify-extension/affordance`, [VERIFY_EXTENSION_AFFORDANCE], base, {
    verticalLabel: 'Foxxi issuer-side independent verification',
    rdfsComment: 'Independently verify a subject\'s claimed standards-extension capability from their own pod before issuing a credential.',
  }));
});
app.post('/agent/verify-extension', async (req, res) => {
  try {
    const auth = await verifyDelegatedCaller(req.body);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, hint: 'sign_request the args, then act urn:cg:action:foxxi:verify-extension.' }); return; }
    const p = auth.payload;
    const subjectDid = typeof p.subject_did === 'string' ? p.subject_did.trim() : '';
    if (!subjectDid) { res.status(400).json({ error: 'subject_did required' }); return; }
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    const kind = (typeof p.kind === 'string' ? p.kind : 'XapiContextExtension') as AgpExtensionKind;

    // 1. Re-read the SUBJECT'S OWN authoritative records (pod ∪ lens).
    const subjectPodUrl = resolveSubjectPodUrl(subjectDid, typeof p.subject_pod_url === 'string' ? p.subject_pod_url : undefined);
    const subjectLabel = actorForPod(subjectPodUrl, MESH_ACTOR_LABELS);
    const lensStatements = await listStoredStatements(lensTenantFor(subjectLabel));
    const durableStatements = await readDurableRecordedStatements({ podUrl: subjectPodUrl });
    const statements = mergeStatementsById(lensStatements, durableStatements);
    const stmtOf = (rec: unknown): Record<string, any> => ((rec as { statement?: unknown })?.statement ?? rec) as Record<string, any>;
    const verbOf = (rec: unknown): string => String(stmtOf(rec).verb?.id ?? '');

    // 2. Engine-graded completion (independent — the SN runtime produced the score).
    const completed = statements.some(s => verbOf(s).endsWith('/completed'));
    const passedRec = statements.find(s => verbOf(s).endsWith('/passed'));
    const independentlyGraded = completed && !!passedRec;
    const gradedScore = passedRec ? (stmtOf(passedRec).result?.score?.scaled ?? null) : null;

    // 3. Domain-typed performance with asserted success on the subject's own pod.
    const perf = statements.map(stmtOf).find(st =>
      String(st.verb?.id ?? '') === PERFORMED_VERB &&
      String(st.object?.definition?.type ?? '').endsWith('agp#StandardsExtension') &&
      st.result?.success === true);
    const performanceRecorded = !!perf;
    const performer = perf?.actor?.account?.name ?? null;
    const observedBy = perf?.context?.extensions?.[PERF_EXT.observedBy] ?? null;
    const selfAttestedPerformance = performanceRecorded && (!observedBy || observedBy === performer);

    // 4. Conformance — reconstruct the named extension + validate the shape.
    let shapeConformant: boolean | null = name ? false : null;
    let conformsTo: string | undefined; let iri: string | undefined;
    if (name) {
      try {
        const ext = proposeStandardsExtension({ kind, name, definition: (typeof p.definition === 'string' && p.definition) ? p.definition : `Conformance check for ${name}.` });
        const types = (ext.descriptor['@type'] as string[] | undefined) ?? [];
        shapeConformant = ext.ok && types.includes('agp:StandardsExtension') && typeof ext.descriptor['conformsTo'] === 'string';
        conformsTo = ext.descriptor['conformsTo'] as string; iri = ext.iri;
      } catch { shapeConformant = false; }
    }

    const verified = independentlyGraded && performanceRecorded && (name ? !!shapeConformant : true);
    const evidence = statements.map(stmtOf)
      .filter(st => ['/completed', '/passed'].some(v => String(st.verb?.id ?? '').endsWith(v)) || String(st.verb?.id ?? '') === PERFORMED_VERB)
      .map(st => st.id);
    res.json({
      ok: true,
      verifiedBy: auth.callerDid,
      subject: { did: subjectDid, podUrl: subjectPodUrl, statementCount: statements.length },
      verified,
      checks: { independentlyGraded, gradedScore, performanceRecorded, selfAttestedPerformance, shapeConformant },
      ...(iri ? { iri, conformsTo } : {}),
      evidence,
      note: independentlyGraded
        ? `Independently verified from ${subjectDid}'s own pod: engine-graded course completion${gradedScore != null ? ` (score ${gradedScore})` : ''}${performanceRecorded ? ' + a domain-typed StandardsExtension performance' : ''}${name ? ` + the '${name}' extension conforms to the agp:StandardsExtension shape` : ''}.${selfAttestedPerformance ? ' NOTE: the performance OUTCOME is self-attested by the subject; the credentialing decision rests on the tamper-evident engine grading + shape conformance.' : ''}`
        : `Could NOT independently confirm an engine-graded completion for ${subjectDid} — do not credential on self-report alone.`,
    });
  } catch (err) { res.status(500).json({ ok: false, error: (err as Error).message }); }
});

// Shared delegated-signature auth for agent-facing /agent/ endpoints — the answer
// to the "/foxxi session-token tools aren't agent-drivable" gap johnny found: a
// relay-mediated agent carries no foxxi session identity through the relay, but a
// delegated signature carries identity IN the signed payload (the SAME model
// review-record + issue-credential use). DIRECT: the signer IS the agent (agent_id
// embeds the recovered address). DELEGATED: the relay signed via sign_request — the
// agent's on-pod delegation must be CryptographicallyVerified AND the request signer
// must be its anchor key.
async function verifyDelegatedCaller(body: unknown):
  Promise<{ ok: true; callerDid: string; payload: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const rec = recoverSignedRequest(body);
  if (!rec.ok) return { ok: false, status: 401, error: `agent signature required: ${rec.reason}` };
  const p = rec.payload;
  const claimedAddr = rec.agentId.toLowerCase().match(/0x[0-9a-f]{40}/)?.[0];
  if (claimedAddr && claimedAddr === rec.signer.toLowerCase()) {
    return { ok: true, callerDid: `did:ethr:${rec.signer}`, payload: p };
  }
  const delegationPod = resolveSubjectPodUrl(rec.agentId, typeof p.subject_pod_url === 'string' ? p.subject_pod_url : undefined);
  let del;
  try {
    del = await verifyAgentDelegation(rec.agentId as unknown as IRI, delegationPod, { verifier: makeWalletDelegationVerifier() });
  } catch (err) {
    return { ok: false, status: 401, error: `delegation verification failed for ${rec.agentId} on ${delegationPod}: ${(err as Error).message}` };
  }
  if (!del.valid || del.trustLevel !== 'CryptographicallyVerified') {
    return { ok: false, status: 401, error: `agent ${rec.agentId} has no cryptographically-verified delegation on ${delegationPod}: ${del.reason ?? del.trustLevel ?? 'unverified'}` };
  }
  const vc = await readDelegationCredential(delegationPod, rec.agentId as unknown as IRI).catch(() => null);
  const anchor = vc?.proof?.signerAddress;
  if (!anchor || anchor.toLowerCase() !== rec.signer.toLowerCase()) {
    return { ok: false, status: 401, error: `request signer ${rec.signer} is not the delegation anchor key${anchor ? ` (${anchor})` : ''}` };
  }
  return { ok: true, callerDid: rec.agentId, payload: p };
}

// ── Agent-driven performance tracing (delegated auth) ──────────────────────
// The session-token foxxi.record_performance is NOT drivable by a relay-mediated
// agent (the relay forwards no foxxi session identity — johnny's finding). This is
// the same act, authenticated by the agent's OWN signature: record one production-
// work event AS yourself, into your OWN lens (append-only, durable across mesh pull
// cycles), where your ELR (review-record) reads it and the competency engine
// aggregates it (by activity_type domain type, else task_name; success=true is what
// promotes to performance-verified). Reach it via sign_request -> act.
// ── Agent-driven credential void (delegated auth) ──────────────────────────
// Cleanly remove a credential from your OWN wallet: deletes the credential
// resource + its graph AND rebuilds the pod discovery manifest from actual
// contents — so no stale entry (the verified=false CLR ghost a raw delete
// leaves) and the manifest is re-written with ABSOLUTE urls. The holder owns
// their wallet: you can only void a credential under YOUR pod. Closes the gap
// where /agent/void-credential 404'd (no agent-side void affordance existed).
const VOID_CREDENTIAL_AFFORDANCE: Affordance = {
  action: 'urn:cg:action:foxxi:void-credential-signed' as Affordance['action'],
  toolName: 'void_credential',
  title: 'Void (remove) a credential from your own wallet',
  description: 'Remove a credential you hold from your OWN pod wallet by its descriptor URL (the sourceDescriptor of a CLR entry returned by review-record). Deletes the credential resource + its graph AND rebuilds your pod manifest from actual contents, so no stale entry/ghost remains. You can only void credentials under your own pod. sign_request -> act.',
  method: 'POST',
  targetTemplate: '{base}/agent/void-credential',
  mediaType: 'application/json',
  inputs: [
    { name: '_signed_payload', type: 'string', required: true, description: 'JSON.stringify({ agent_id, timestamp, descriptor_url }) — descriptor_url = a CLR entry sourceDescriptor under your own pod.' },
    { name: '_signature', type: 'string', required: true, description: 'secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id.' },
  ],
};

app.get('/agent/void-credential/affordance', (_req, res) => {
  const base = (process.env.BRIDGE_DEPLOYMENT_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
  res.type('text/turtle').send(affordancesManifestTurtle(`${base}/agent/void-credential/affordance`, [VOID_CREDENTIAL_AFFORDANCE], base, {
    verticalLabel: 'Foxxi credential void',
    rdfsComment: 'Remove a credential from your own wallet + rebuild the manifest cleanly (no ghost).',
  }));
});

app.post('/agent/void-credential', async (req, res) => {
  try {
    const auth = await verifyDelegatedCaller(req.body);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, hint: 'sign_request the args, then act urn:cg:action:foxxi:void-credential-signed.' }); return; }
    const callerDid = auth.callerDid; const p = auth.payload;
    const descriptorUrl = typeof p.descriptor_url === 'string' ? p.descriptor_url.trim() : '';
    if (!descriptorUrl) { res.status(400).json({ error: 'descriptor_url required (a CLR entry sourceDescriptor under your own pod)' }); return; }
    const pod = resolveSubjectPodUrl(callerDid, typeof p.subject_pod_url === 'string' ? p.subject_pod_url : undefined);
    const origin = (() => { try { return new URL(pod).origin; } catch { return ''; } })();
    const podSeg = (() => { try { return new URL(pod).pathname.split('/').filter(Boolean)[0] ?? ''; } catch { return ''; } })();
    let descPath: string;
    try { descPath = new URL(descriptorUrl).pathname; } catch { res.status(400).json({ error: 'descriptor_url is not a valid URL' }); return; }
    // Security: the resource must sit directly under YOUR pod root. Reconstruct
    // the delete targets on your pod origin (where the bridge write secret is
    // honored) — never trust the descriptor_url's host.
    if (!podSeg || !descPath.startsWith(`/${podSeg}/`)) {
      res.status(403).json({ error: `descriptor_url must be under your own pod (/${podSeg}/) — you can only void your own credentials` }); return;
    }
    const descOnOrigin = `${origin}${descPath}`;
    // Resolve the credential's graph (hydra:target / dcat:accessURL) so we delete it too.
    let graphOnOrigin: string | undefined;
    try {
      const dt = await (await fetch(descOnOrigin, { headers: { Accept: 'text/turtle' } })).text();
      const gm = dt.match(/hydra:target\s+<([^>]+)>/) ?? dt.match(/dcat:accessURL\s+<([^>]+)>/);
      if (gm) { try { const gp = new URL(gm[1]).pathname; if (gp.startsWith(`/${podSeg}/`)) graphOnOrigin = `${origin}${gp}`; } catch { /* ignore */ } }
    } catch { /* descriptor may already be gone */ }
    const deletions: Record<string, number> = {};
    for (const u of [graphOnOrigin, descOnOrigin].filter(Boolean) as string[]) {
      try { deletions[u.replace(origin, '')] = (await fetch(u, { method: 'DELETE' })).status; }
      catch { deletions[u.replace(origin, '')] = -1; }
    }
    // Rebuild the manifest from actual pod contents — the deleted credential is
    // simply absent (no ghost), written with ABSOLUTE urls via PUT (not PATCH,
    // which CSS re-serializes relative).
    let manifest: { written: number; scanned: number } | undefined;
    try { const m = await rebuildManifestFromPod(pod); manifest = { written: m.written, scanned: m.scanned }; }
    catch (e) { console.warn('[void-credential] manifest rebuild failed:', (e as Error).message); }
    res.json({ ok: true, voidedBy: callerDid, descriptor: descriptorUrl, deletions, manifest: manifest ?? 'rebuild-failed' });
  } catch (err) { res.status(500).json({ ok: false, error: (err as Error).message }); }
});

const RECORD_PERFORMANCE_AFFORDANCE: Affordance = {
  action: 'urn:cg:action:foxxi:record-performance-signed' as Affordance['action'],
  toolName: 'record_foxxi_performance',
  title: 'Record a production-work performance event as yourself',
  description: 'Record one unit of on-the-job production work as an xAPI performed statement, into your OWN Foxxi lens, authenticated by your delegation (no foxxi session token needed — this is the agent-drivable counterpart of foxxi.record_performance). Declare an activity_type (a domain type you define, e.g. urn:ttt:Move) to aggregate same-type executions into one competency; else it keys off task_name. success=true on demonstrated work promotes the competency to performance-verified. Reach it: sign_request the args, then act this affordance.',
  method: 'POST',
  targetTemplate: '{base}/agent/record-performance',
  mediaType: 'application/json',
  inputs: [
    { name: '_signed_payload', type: 'string', required: true, description: "JSON.stringify({ agent_id, timestamp, task_name, success, activity_type?, task_id?, quality?, duration_iso?, actor_kind?, cost_usd?, recipients? }). recipients?: string[] of pod URLs or DIDs to ALSO wrap the encrypted canonical holon to (beyond you=owner + bridge), each resolved via its DURABLE <pod>/keys/encryption.json — for cross-seat owner-decrypt. Unresolved recipients are skipped (best-effort). The advertised cg:encryptedHolon link is gate-direct, so a named recipient can fetch + owner-decrypt from a foreign seat." },
    { name: '_signature', type: 'string', required: true, description: 'secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id (use the relay sign_request tool).' },
  ],
};

app.get('/agent/record-performance/affordance', (_req, res) => {
  const base = (process.env.BRIDGE_DEPLOYMENT_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
  res.type('text/turtle').send(
    affordancesManifestTurtle(`${base}/agent/record-performance/affordance`, [RECORD_PERFORMANCE_AFFORDANCE], base, {
      verticalLabel: 'Foxxi agent performance tracing',
      rdfsComment: 'Record a production-work performance event as yourself, into your own lens, via your delegation.',
    }),
  );
});

// ── Self-sovereign encryption-key publication (delegated auth) ─────────────
// Agents publish their OWN X25519 PUBLIC key so the bridge encrypts their
// canonical PGSL holons TO THEM (owner-readable), not just to the bridge. The
// agent generates + holds the private key; only the public key is published, to
// <pod>/keys/encryption.json. This is the agent-driven counterpart of the
// substrate publishAgentEncryptionKey — the unblock for self-sovereign per-agent
// holon encryption across the mesh.
const PUBLISH_ENCRYPTION_KEY_AFFORDANCE: Affordance = {
  action: 'urn:cg:action:foxxi:publish-encryption-key-signed' as Affordance['action'],
  toolName: 'publish_encryption_key',
  title: 'Publish your X25519 encryption public key (self-sovereign)',
  description: 'Publish YOUR X25519 public key to your OWN pod so the bridge encrypts your canonical PGSL holons TO YOU (not just to itself) — making your recorded performances/credentials owner-readable. You generate + hold the private key; only the public key is published (to <yourpod>/keys/encryption.json). Reach it: sign_request the args, then act this affordance.',
  method: 'POST',
  targetTemplate: '{base}/agent/publish-encryption-key',
  mediaType: 'application/json',
  inputs: [
    { name: '_signed_payload', type: 'string', required: true, description: "JSON.stringify({ agent_id, timestamp, public_key }) — public_key is your base64 X25519 (Curve25519) public key (algorithm X25519-XSalsa20-Poly1305)." },
    { name: '_signature', type: 'string', required: true, description: 'secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id.' },
  ],
};

app.get('/agent/publish-encryption-key/affordance', (_req, res) => {
  const base = (process.env.BRIDGE_DEPLOYMENT_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
  res.type('text/turtle').send(
    affordancesManifestTurtle(`${base}/agent/publish-encryption-key/affordance`, [PUBLISH_ENCRYPTION_KEY_AFFORDANCE], base, {
      verticalLabel: 'Foxxi self-sovereign encryption keys',
      rdfsComment: 'Publish your X25519 public key so your canonical holons are encrypted to you (owner-readable).',
    }),
  );
});

app.post('/agent/publish-encryption-key', async (req, res) => {
  try {
    const auth = await verifyDelegatedCaller(req.body);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, hint: 'sign_request the args, then act urn:cg:action:foxxi:publish-encryption-key-signed.' }); return; }
    const callerDid = auth.callerDid;
    const p = auth.payload;
    const publicKey = typeof p.public_key === 'string' ? p.public_key.trim() : '';
    if (!publicKey) { res.status(400).json({ error: 'public_key (base64 X25519) required' }); return; }
    // Self-sovereign: you publish YOUR OWN key to YOUR OWN pod. The private key
    // never leaves you; only the public key is written.
    const subjectPod = resolveSubjectPodUrl(callerDid, typeof p.subject_pod_url === 'string' ? p.subject_pod_url : undefined);
    // The bridge's globalThis.fetch is patched to carry the pod-write bearer for
    // tenant-origin writes, so this PUT to <pod>/keys/encryption.json is authed.
    const { url } = await publishAgentEncryptionKey(subjectPod, publicKey, {
      fetch: globalThis.fetch as any,
      publishedAt: new Date().toISOString(),
    });
    res.json({ ok: true, published: url, owner: callerDid, algorithm: 'X25519-XSalsa20-Poly1305' });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.post('/agent/record-performance', async (req, res) => {
  try {
    const auth = await verifyDelegatedCaller(req.body);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, hint: 'sign_request the args, then act urn:cg:action:foxxi:record-performance-signed.' }); return; }
    const callerDid = auth.callerDid;
    const p = auth.payload;
    const taskName = typeof p.task_name === 'string' ? p.task_name.trim() : '';
    if (!taskName) { res.status(400).json({ error: 'task_name required' }); return; }
    if (typeof p.success !== 'boolean') { res.status(400).json({ error: 'success (boolean) required' }); return; }
    // Self-sovereign: you record YOUR OWN performance — the performer + the lens are
    // the verified caller (recording for another agent would need their delegation).
    const subjectPod = resolveSubjectPodUrl(callerDid, typeof p.subject_pod_url === 'string' ? p.subject_pod_url : undefined);
    const label = actorForPod(subjectPod, MESH_ACTOR_LABELS);
    const taskId = (typeof p.task_id === 'string' && p.task_id.trim())
      ? p.task_id.trim()
      : `urn:foxxi:task:${taskName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`;
    const activityType = (typeof p.activity_type === 'string' && p.activity_type.trim())
      ? p.activity_type.trim()
      : 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#ProductionTask';
    const quality = typeof p.quality === 'number' ? p.quality : undefined;
    const statement: Record<string, unknown> = {
      id: randomUUID(),
      version: '2.0.0',
      actor: { objectType: 'Agent', account: { homePage: authoritativeSource, name: callerDid } },
      verb: { id: PERFORMED_VERB, display: { en: 'performed' } },
      object: { objectType: 'Activity', id: taskId, definition: { name: { en: taskName }, type: activityType } },
      result: {
        success: p.success,
        ...(quality !== undefined ? { score: { scaled: quality } } : {}),
        ...(typeof p.duration_iso === 'string' ? { duration: p.duration_iso } : {}),
      },
      context: { extensions: {
        [PERF_EXT.observedBy]: callerDid,
        [PERF_EXT.contextKind]: 'production',
        [PERF_EXT.actorKind]: (p.actor_kind === 'human' ? 'human' : 'agent'),
        ...(typeof p.cost_usd === 'number' ? { [PERF_EXT.costUsd]: p.cost_usd } : {}),
      } },
      timestamp: new Date().toISOString(),
    };
    const statementId = storeStatementInternal(statement, lensTenantFor(label));
    // Optional additional recipients for the encrypted canonical holon: pod URLs
    // or DIDs, each resolved to a pod whose DURABLE keys/encryption.json is also
    // wrapped — so named agents (e.g. maintainer + boozer) can owner-decrypt this
    // performance cross-seat. Unresolved recipients are skipped downstream.
    const recipientPods: string[] = Array.isArray(p.recipients)
      ? (p.recipients as unknown[])
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .map(x => x.trim())
          .map(x => /^https?:\/\//.test(x) ? x : resolveSubjectPodUrl(x))
      : [];
    // Durable + self-sovereign: persist to the performer's OWN pod (the lens is
    // a derived in-memory view; the pod is the system of record). Best-effort —
    // the in-memory record already succeeded, so a pod-write hiccup doesn't fail
    // the call; it just means this record re-derives only until the next write.
    void persistRecordedStatement({ podUrl: subjectPod, agentDid: callerDid, statement: { ...statement, id: statementId }, ...(recipientPods.length ? { recipientPods } : {}) })
      .catch(e => console.warn('[durable-record][record-performance]', (e as Error).message));
    // Forward to the performer's OWN downstream targets (no-op if they set none).
    forwardToTargets(lensTenantFor(label), { ...statement, id: statementId })
      .catch(e => console.warn('[foxxi-forward][record-performance]', (e as Error).message));
    res.json({ ok: true, recorded: true, statementId, performer: callerDid, taskId, taskName, activityType, success: p.success, durable: subjectPod, lensTenant: lensTenantFor(label) });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── Agent-driven course authoring + completion (delegated auth) ────────────
// Foxxi-as-LMS for self-sovereign agents. The session-token foxxi.ingest_content_
// package + foxxi.emit_cmi5_session are not agent-drivable (no forwarded foxxi
// identity — johnny's finding). These delegated counterparts let a creator AUTHOR a
// course to their OWN pod and a learner record a cmi5 COMPLETION into their OWN
// lens, both over the substrate via sign_request -> act — no foxxi MCP / session token.

const INGEST_COURSE_AFFORDANCE: Affordance = {
  action: 'urn:cg:action:foxxi:ingest-course-signed' as Affordance['action'],
  toolName: 'ingest_foxxi_course',
  title: 'Author + publish a course to your own pod (as yourself)',
  description: 'Author a Foxxi course (cmi5/SCORM-shaped: modules -> lessons -> fragments; assessment-item fragments are scored) and PUBLISH it to your OWN pod, authenticated by your delegation (no foxxi session token — the agent-drivable counterpart of foxxi.ingest_content_package). The signed payload carries { parsed: <ParsedFoxxiPackage = { courseId, title, modules:[{id,title,lessons:[{id,title,competency,fragments:[{modality,body,level}]}]}] }> }. Reach it: sign_request the args, then act this affordance.',
  method: 'POST', targetTemplate: '{base}/agent/ingest-course', mediaType: 'application/json',
  inputs: [
    { name: '_signed_payload', type: 'string', required: true, description: 'JSON.stringify({ agent_id, timestamp, parsed: <ParsedFoxxiPackage> })' },
    { name: '_signature', type: 'string', required: true, description: 'secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id (use sign_request).' },
  ],
};
app.get('/agent/ingest-course/affordance', (_req, res) => {
  const base = (process.env.BRIDGE_DEPLOYMENT_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
  res.type('text/turtle').send(affordancesManifestTurtle(`${base}/agent/ingest-course/affordance`, [INGEST_COURSE_AFFORDANCE], base, {
    verticalLabel: 'Foxxi creator course authoring', rdfsComment: 'Author + publish a course to your own pod, as yourself.',
  }));
});
app.post('/agent/ingest-course', async (req, res) => {
  try {
    const auth = await verifyDelegatedCaller(req.body);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, hint: 'sign_request the args, then act urn:cg:action:foxxi:ingest-course-signed.' }); return; }
    const callerDid = auth.callerDid; const p = auth.payload;
    const parsed = p.parsed;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { res.status(400).json({ error: 'parsed (ParsedFoxxiPackage: { courseId, title, modules }) required' }); return; }
    const authorPod = resolveSubjectPodUrl(callerDid, typeof p.subject_pod_url === 'string' ? p.subject_pod_url : undefined);
    const result = await ingestContentPackage({ parsed: parsed as ParsedFoxxiPackage, config: { tenantPodUrl: authorPod, authoritativeSource } });
    res.json({ ok: true, authoredBy: callerDid, authorPod, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

const RECORD_COURSE_COMPLETION_AFFORDANCE: Affordance = {
  action: 'urn:cg:action:foxxi:record-course-completion-signed' as Affordance['action'],
  toolName: 'record_foxxi_course_completion',
  title: 'Record a cmi5 course completion as yourself',
  description: 'Record completing + passing a course as cmi5 xAPI (launched/initialized/completed/passed/terminated) into your OWN lens, authenticated by your delegation (the agent-drivable counterpart of foxxi.emit_cmi5_session). A passed completion (score_scaled >= mastery_score) lands mastery-verb experiences -> an inferred competency in your ELR, which a later record-performance can supersede to performance-verified. Reach it: sign_request the args, then act this affordance.',
  method: 'POST', targetTemplate: '{base}/agent/record-course-completion', mediaType: 'application/json',
  inputs: [
    { name: '_signed_payload', type: 'string', required: true, description: 'JSON.stringify({ agent_id, timestamp, course_id, course_title?, score_scaled, mastery_score?, duration_iso? })' },
    { name: '_signature', type: 'string', required: true, description: 'secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id (use sign_request).' },
  ],
};
app.get('/agent/record-course-completion/affordance', (_req, res) => {
  const base = (process.env.BRIDGE_DEPLOYMENT_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
  res.type('text/turtle').send(affordancesManifestTurtle(`${base}/agent/record-course-completion/affordance`, [RECORD_COURSE_COMPLETION_AFFORDANCE], base, {
    verticalLabel: 'Foxxi learner course completion', rdfsComment: 'Record a cmi5 course completion as yourself, into your own lens.',
  }));
});
app.post('/agent/record-course-completion', async (req, res) => {
  try {
    const auth = await verifyDelegatedCaller(req.body);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, hint: 'sign_request the args, then act urn:cg:action:foxxi:record-course-completion-signed.' }); return; }
    const callerDid = auth.callerDid; const p = auth.payload;
    const courseId = typeof p.course_id === 'string' ? p.course_id.trim() : '';
    if (!courseId) { res.status(400).json({ error: 'course_id required' }); return; }
    const scoreScaled = typeof p.score_scaled === 'number' ? p.score_scaled : 1.0;
    const masteryScore = typeof p.mastery_score === 'number' ? p.mastery_score : 0.7;
    if (scoreScaled < masteryScore) { res.status(400).json({ error: `score_scaled ${scoreScaled} is below mastery_score ${masteryScore} — not a passed completion` }); return; }
    const subjectPod = resolveSubjectPodUrl(callerDid, typeof p.subject_pod_url === 'string' ? p.subject_pod_url : undefined);
    const label = actorForPod(subjectPod, MESH_ACTOR_LABELS);
    const registration = (typeof p.registration === 'string' && p.registration) ? p.registration : randomUUID();
    const courseActivityId = `urn:foxxi:course:${courseId}`;
    const trace = buildPassedSessionTrace({
      actor: { name: callerDid, account: { homePage: String(authoritativeSource), name: callerDid } },
      session: { registration, sessionId: registration, publisherId: String(tenantProfileDid), auActivityId: courseActivityId, courseActivityId },
      scoreScaled, masteryScore,
      durationIso: (typeof p.duration_iso === 'string' && p.duration_iso) ? p.duration_iso : 'PT10M',
      moveOnRule: 'CompletedAndPassed',
    });
    const statementIds: string[] = [];
    for (const stmt of trace) {
      const s = stmt as unknown as Record<string, unknown>;
      const withId = { ...s, id: (typeof s.id === 'string' && s.id) ? s.id : randomUUID() };
      statementIds.push(storeStatementInternal(withId, lensTenantFor(label)));
      // Durable + self-sovereign: persist each cmi5 statement to the learner's own pod.
      void persistRecordedStatement({ podUrl: subjectPod, agentDid: callerDid, statement: withId })
        .catch(e => console.warn('[durable-record][record-course-completion]', (e as Error).message));
      // Forward to the learner's OWN downstream targets (no-op if none set).
      forwardToTargets(lensTenantFor(label), withId)
        .catch(e => console.warn('[foxxi-forward][record-course-completion]', (e as Error).message));
    }
    res.json({ ok: true, completedBy: callerDid, courseId, courseActivityId, scoreScaled, masteryScore, passed: true, statementCount: statementIds.length, durable: subjectPod, lensTenant: lensTenantFor(label) });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── Self-sovereign forwarding (delegated auth) ─────────────────────────────
// Each user manages their OWN xAPI forwarding on their own lens, as themselves
// (the /agent/ingest-course pattern). Owner = the verified caller's DID -> their
// pod -> their lens; there is no subject_pod_url arg, so you can only manage your
// own. Outbound targets + inbound credentials are scoped to your lens, so a
// statement of yours only forwards to YOUR targets, and a credential of yours
// only lands forwarded-in statements in YOUR record.

// ── Durable per-user forwarding config (encrypted, own-pod) ─────────────────
// Persist each owner's targets + inbound credentials (which contain secrets) as
// an encrypted envelope on their OWN pod, and hydrate on demand so per-user
// forwarding survives a bridge restart. The envelope is wrapped to the bridge
// (so it can hydrate) + the owner (so it's theirs); secrets never hit the pod
// in clear.
async function hydrateOwnerForwarding(tenant: TenantId, ownerPod: string): Promise<void> {
  const kp = bridgeEncryptionKeypair();
  if (kp) {
    try { const blob = await loadForwardingConfig({ ownerPod, bridgeKp: kp }); if (blob) importForwardingConfig(tenant, blob); }
    catch (e) { console.warn('[foxxi-forward][hydrate]', (e as Error).message); }
  }
  markForwardingHydrated(tenant); // don't let the cold-start hydrator re-load + clobber
}
async function persistOwnerForwarding(tenant: TenantId, ownerPod: string): Promise<void> {
  const kp = bridgeEncryptionKeypair();
  if (!kp) return;
  try { await persistForwardingConfig({ ownerPod, blob: exportForwardingConfig(tenant), bridgeKp: kp }); }
  catch (e) { console.warn('[foxxi-forward][persist]', (e as Error).message); }
}
// Cold-start hydrator for the forward path (no affordance call yet this boot):
// reverse-derive the owner pod from the lens tenant and load their persisted
// config BEFORE the first forward, so a post-restart statement isn't dropped.
registerForwardingHydrator(async (tenant) => {
  if (!tenant.startsWith('lens:')) return;
  const kp = bridgeEncryptionKeypair(); if (!kp) return;
  let origin = ''; try { origin = new URL(tenantPodUrl).origin; } catch { return; }
  const ownerPod = `${origin}/${tenant.slice('lens:'.length)}/`;
  const blob = await loadForwardingConfig({ ownerPod, bridgeKp: kp });
  if (blob) importForwardingConfig(tenant, blob);
});

const FORWARDING_TARGETS_AFFORDANCE: Affordance = {
  action: 'urn:cg:action:foxxi:set-forwarding-targets-signed' as Affordance['action'],
  toolName: 'set_foxxi_forwarding_targets',
  title: 'Manage your own downstream xAPI forwarding targets',
  description: 'Set / list / remove the downstream LRS endpoints YOUR OWN xAPI statements are forwarded to (per-user Statement Forwarding). Owner = your verified delegation; targets are scoped to your own lens, so only your statements forward to them, never another user\'s. Reach it: sign_request the args, then act this affordance.',
  method: 'POST',
  targetTemplate: '{base}/agent/forwarding/targets',
  mediaType: 'application/json',
  inputs: [
    { name: '_signed_payload', type: 'string', required: true, description: "JSON.stringify({ agent_id, timestamp, targets?: [{ endpoint, credentials, label?, version?, enabled? }], delete?: string[] }). targets are added/updated (credentials = downstream LRS 'user:pass'); delete removes by id. Omit both to just list (downstream secrets are never echoed)." },
    { name: '_signature', type: 'string', required: true, description: 'secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id (use the relay sign_request tool).' },
  ],
};

app.get('/agent/forwarding/targets/affordance', (_req, res) => {
  const base = (process.env.BRIDGE_DEPLOYMENT_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
  res.type('text/turtle').send(
    affordancesManifestTurtle(`${base}/agent/forwarding/targets/affordance`, [FORWARDING_TARGETS_AFFORDANCE], base, {
      verticalLabel: 'Foxxi self-sovereign forwarding',
      rdfsComment: 'Manage your own downstream xAPI forwarding targets, as yourself.',
    }),
  );
});

app.post('/agent/forwarding/targets', async (req, res) => {
  try {
    const auth = await verifyDelegatedCaller(req.body);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, hint: 'sign_request the args, then act urn:cg:action:foxxi:set-forwarding-targets-signed.' }); return; }
    const callerDid = auth.callerDid;
    const p = auth.payload as { targets?: unknown; delete?: unknown };
    // Owner = verified caller (DID -> own pod -> own lens). No subject_pod_url:
    // you can only manage your OWN forwarding.
    const ownerPod = resolveSubjectPodUrl(callerDid);
    const ownerTenant = lensTenantFor(actorForPod(ownerPod, MESH_ACTOR_LABELS));
    // Load any persisted config FIRST so an add/delete doesn't clobber the rest.
    await hydrateOwnerForwarding(ownerTenant, ownerPod);
    let mutated = false;
    if (Array.isArray(p.targets)) {
      for (const t of p.targets as Array<Record<string, unknown>>) {
        if (!t || typeof t.endpoint !== 'string' || typeof t.credentials !== 'string' || !t.credentials.includes(':')) continue;
        addForwardingTarget(ownerTenant, {
          endpoint: t.endpoint, credentials: t.credentials,
          label: typeof t.label === 'string' ? t.label : undefined,
          version: typeof t.version === 'string' ? t.version : undefined,
          enabled: typeof t.enabled === 'boolean' ? t.enabled : undefined,
        });
        mutated = true;
      }
    }
    if (Array.isArray(p.delete)) {
      for (const id of p.delete as unknown[]) if (typeof id === 'string') { deleteForwardingTarget(ownerTenant, id); mutated = true; }
    }
    if (mutated) await persistOwnerForwarding(ownerTenant, ownerPod);
    res.json({ ok: true, owner: callerDid, ownerTenant, targets: listForwardingTargets(ownerTenant) });
  } catch (err) { res.status(500).json({ ok: false, error: (err as Error).message }); }
});

const INBOUND_CREDENTIALS_AFFORDANCE: Affordance = {
  action: 'urn:cg:action:foxxi:set-inbound-credentials-signed' as Affordance['action'],
  toolName: 'set_foxxi_inbound_credentials',
  title: 'Manage your own inbound forwarding credentials',
  description: 'Mint / list / revoke the Basic-auth credentials an upstream system uses to forward xAPI statements INTO your OWN lens. Owner = your verified delegation; credentials are scoped to your lens, so forwarded-in statements land in your record. Secrets are never echoed back. Reach it: sign_request the args, then act this affordance.',
  method: 'POST',
  targetTemplate: '{base}/agent/credentials',
  mediaType: 'application/json',
  inputs: [
    { name: '_signed_payload', type: 'string', required: true, description: "JSON.stringify({ agent_id, timestamp, credentials?: [{ principal, secret, label? }], revoke?: string[] }). credentials are added (the 'user:pass' an upstream presents on /xapi/statements); revoke removes by id. Omit both to just list (secrets never returned)." },
    { name: '_signature', type: 'string', required: true, description: 'secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id (use the relay sign_request tool).' },
  ],
};

app.get('/agent/credentials/affordance', (_req, res) => {
  const base = (process.env.BRIDGE_DEPLOYMENT_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
  res.type('text/turtle').send(
    affordancesManifestTurtle(`${base}/agent/credentials/affordance`, [INBOUND_CREDENTIALS_AFFORDANCE], base, {
      verticalLabel: 'Foxxi self-sovereign inbound forwarding',
      rdfsComment: 'Manage your own inbound forwarding credentials, as yourself.',
    }),
  );
});

app.post('/agent/credentials', async (req, res) => {
  try {
    const auth = await verifyDelegatedCaller(req.body);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, hint: 'sign_request the args, then act urn:cg:action:foxxi:set-inbound-credentials-signed.' }); return; }
    const callerDid = auth.callerDid;
    const p = auth.payload as { credentials?: unknown; revoke?: unknown };
    const ownerPod = resolveSubjectPodUrl(callerDid);
    const ownerTenant = lensTenantFor(actorForPod(ownerPod, MESH_ACTOR_LABELS));
    await hydrateOwnerForwarding(ownerTenant, ownerPod);
    let mutated = false;
    if (Array.isArray(p.credentials)) {
      for (const c of p.credentials as Array<Record<string, unknown>>) {
        if (!c || typeof c.principal !== 'string' || typeof c.secret !== 'string') continue;
        inboundCredentials.add({ principal: c.principal, secret: c.secret, tenant: String(ownerTenant), label: typeof c.label === 'string' ? c.label : undefined });
        mutated = true;
      }
    }
    // Scope every read/revoke to THIS owner's tenant — never touch another user's credentials.
    const mineIds = new Set(inboundCredentials.list().filter(c => c.tenant === String(ownerTenant)).map(c => c.id));
    if (Array.isArray(p.revoke)) {
      for (const id of p.revoke as unknown[]) if (typeof id === 'string' && mineIds.has(id)) { inboundCredentials.remove(id); mutated = true; }
    }
    if (mutated) await persistOwnerForwarding(ownerTenant, ownerPod);
    const mine = inboundCredentials.list().filter(c => c.tenant === String(ownerTenant));
    res.json({ ok: true, owner: callerDid, ownerTenant, credentials: mine });
  } catch (err) { res.status(500).json({ ok: false, error: (err as Error).message }); }
});

// ── Agentic SCORM RTE (delegated auth) ─────────────────────────────────────
// A REAL SCORM run for agents: a creator AUTHORS a course -> a conformant
// imsmanifest.xml -> the actual SCORM 2004 SN runtime (scorm-sequencing.ts) parses
// + sequences it; a learner LAUNCHES it and PLAYS each SCO (content + a graded
// assessment); the player GRADES the learner's answers against the package's
// correct answers (NOT self-reported), commitTracking()s cmi.* into the engine,
// and the engine's ROLLUP determines pass/complete -> emitted to the learner's
// lens/ELR. The agent plays the role a browser does, over the substrate. No foxxi MCP.
// Assessment answers are stored HASHED (sha256 of the normalized answer), never
// plaintext — the course is persisted to the author's world-readable pod, so the
// bridge grades by hash compare rather than leak the key.
interface AgentScormSco { id: string; title: string; body: string; assessment?: Array<{ question: string; answerHash: string }>; }
interface AgentScormCourse { courseId: string; title: string; masteryScore: number; scos: AgentScormSco[]; authoredBy: string; }
interface ScormPlay { seq: SeqSession; courseId: string; learnerDid: string; lens: TenantId; masteryScore: number; course: AgentScormCourse; }
const agentScormCourses = new Map<string, AgentScormCourse>();
const agentScormPlays = new Map<string, ScormPlay>();   // in-process per the SN engine's own session model

function scormXmlEsc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function scormSlug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x'; }
function buildAgentScormManifest(course: AgentScormCourse): string {
  const cs = scormSlug(course.courseId);
  const items = course.scos.map(s => `        <item identifier="ITEM-${scormSlug(s.id)}" identifierref="RES-${scormSlug(s.id)}"><title>${scormXmlEsc(s.title)}</title></item>`).join('\n');
  const resources = course.scos.map(s => `    <resource identifier="RES-${scormSlug(s.id)}" type="webcontent" adlcp:scormType="sco" href="sco-${scormSlug(s.id)}.html"><file href="sco-${scormSlug(s.id)}.html"/></resource>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST-${cs}" version="1.0" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" xmlns:imsss="http://www.imsglobal.org/xsd/imsss">
  <metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata>
  <organizations default="ORG-${cs}">
    <organization identifier="ORG-${cs}"><title>${scormXmlEsc(course.title)}</title>
      <imsss:sequencing><imsss:controlMode choice="true" flow="true"/><imsss:objectives><imsss:primaryObjective satisfiedByMeasure="true"><imsss:minNormalizedMeasure>${course.masteryScore}</imsss:minNormalizedMeasure></imsss:primaryObjective></imsss:objectives></imsss:sequencing>
${items}
    </organization>
  </organizations>
  <resources>
${resources}
  </resources>
</manifest>`;
}
function scoForActivity(course: AgentScormCourse, activityId: string | undefined): AgentScormSco | undefined {
  if (!activityId) return undefined;
  return course.scos.find(s => `ITEM-${scormSlug(s.id)}` === activityId);
}
function scoViewForLearner(sco: AgentScormSco | undefined): unknown {
  if (!sco) return null;
  return { id: sco.id, title: sco.title, body: sco.body, ...(sco.assessment?.length ? { assessment: sco.assessment.map((q, i) => ({ index: i, question: q.question })) } : {}) };
}
function normAns(s: string): string { return String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
function hashAnswer(s: string): string { return createHash('sha256').update(normAns(s)).digest('hex'); }
/** Record a first-class AGENT ACTIVITY (a teacher/author/issuer act) into the
 *  actor's OWN lens + durable pod, with an EXPRESSIVE verb. Unlike record-
 *  performance (verb=performed → ELR performance rollup), this carries a distinct
 *  verb (authored / credentialed) so the actor's record reflects the WORK they did
 *  — ending the 'performed' monoculture for the teacher side — without manufacturing
 *  a learned competency (these project as experiences, not performances). Best-effort
 *  side effect; returns the statement id (or null if the actor pod can't be resolved). */
function emitAgentActivity(args: {
  actorDid: string;
  verbIri: string; verbDisplay: string;
  objectId: string; objectName: string; objectType: string;
  result?: Record<string, unknown>;
  contextKind?: string;
}): string | null {
  try {
    const actorPod = resolveSubjectPodUrl(args.actorDid);
    const label = actorForPod(actorPod, MESH_ACTOR_LABELS);
    const lens = lensTenantFor(label);
    const statement: Record<string, unknown> = {
      id: randomUUID(), version: '2.0.0',
      actor: { objectType: 'Agent', account: { homePage: String(authoritativeSource), name: args.actorDid } },
      verb: { id: args.verbIri, display: { en: args.verbDisplay } },
      object: { objectType: 'Activity', id: args.objectId, definition: { name: { en: args.objectName }, type: args.objectType } },
      ...(args.result ? { result: args.result } : {}),
      context: { extensions: { [PERF_EXT.observedBy]: args.actorDid, [PERF_EXT.contextKind]: args.contextKind ?? 'production', [PERF_EXT.actorKind]: 'agent' } },
      timestamp: new Date().toISOString(),
    };
    const id = storeStatementInternal(statement, lens);
    void persistRecordedStatement({ podUrl: actorPod, agentDid: args.actorDid, statement: { ...statement, id } })
      .catch(e => console.warn('[durable-record][agent-activity]', (e as Error).message));
    forwardToTargets(lens, { ...statement, id }).catch(() => {});
    return id;
  } catch (e) { console.warn('[agent-activity]', (e as Error).message); return null; }
}

function emitScormCompletion(play: ScormPlay, course: AgentScormCourse, passed: boolean, score: number): string[] {
  const ADL = 'http://adlnet.gov/expapi/verbs/';
  const courseObj = { objectType: 'Activity', id: `urn:foxxi:course:${course.courseId}`, definition: { name: { en: course.title }, type: 'http://adlnet.gov/expapi/activities/course' } };
  const base = (verb: string, name: string, result: Record<string, unknown>): Record<string, unknown> => ({
    id: randomUUID(), version: '2.0.0',
    actor: { objectType: 'Agent', account: { homePage: String(authoritativeSource), name: play.learnerDid } },
    verb: { id: ADL + verb, display: { en: name } }, object: courseObj, result,
    context: { extensions: { [PERF_EXT.observedBy]: play.learnerDid, [PERF_EXT.contextKind]: 'training' } },
    timestamp: new Date().toISOString(),
  });
  const stmts: Array<Record<string, unknown>> = [ base('completed', 'completed', { completion: true }) ];
  stmts.push(passed
    ? base('passed', 'passed', { success: true, completion: true, score: { scaled: score } })
    : base('failed', 'failed', { success: false, completion: true, score: { scaled: score } }));
  const ids: string[] = [];
  // Durable + self-sovereign: the SCORM outcome belongs on the learner's OWN
  // pod, not just the in-memory lens view.
  const learnerPod = resolveSubjectPodUrl(play.learnerDid);
  for (const s of stmts) {
    ids.push(storeStatementInternal(s, play.lens));
    void persistRecordedStatement({ podUrl: learnerPod, agentDid: play.learnerDid, statement: s })
      .catch(e => console.warn('[durable-record][scorm-completion]', (e as Error).message));
  }
  return ids;
}

const SCORM_AFFORDANCES: Affordance[] = [
  { action: 'urn:cg:action:foxxi:scorm-author-signed' as Affordance['action'], toolName: 'scorm_author', title: 'Author a SCORM course (real conformant package)', method: 'POST', targetTemplate: '{base}/agent/scorm/author', mediaType: 'application/json',
    description: 'Author a SCORM 2004 course as yourself. The payload carries { course: { courseId, title, masteryScore?, scos:[{ id, title, body, assessment?:[{question,answer}] }] } }. Foxxi generates a CONFORMANT imsmanifest.xml and validates it parses on the real SCORM SN runtime. Agent-drivable, no foxxi MCP. sign_request -> act.',
    inputs: [ { name: '_signed_payload', type: 'string', required: true, description: 'JSON.stringify({ agent_id, timestamp, course })' }, { name: '_signature', type: 'string', required: true, description: 'sign_request signature' } ] },
  { action: 'urn:cg:action:foxxi:scorm-launch-signed' as Affordance['action'], toolName: 'scorm_launch', title: 'Launch a SCORM course (start an attempt on the SN engine)', method: 'POST', targetTemplate: '{base}/agent/scorm/launch', mediaType: 'application/json',
    description: 'Launch an authored SCORM course as yourself. The SN runtime parses the manifest, starts an attempt, and delivers the first SCO; you get its content + (assessment SCOs) the questions. Payload { course_id, author_did?, course_pod? } — the course is resolved from the in-memory catalog, else loaded from the author pod (author_did or course_pod; defaults to your own pod for a self-authored course), so it survives restarts and is launchable cross-agent. Then POST /agent/scorm/submit per SCO. sign_request -> act.',
    inputs: [ { name: '_signed_payload', type: 'string', required: true, description: 'JSON.stringify({ agent_id, timestamp, course_id, author_did?, course_pod? })' }, { name: '_signature', type: 'string', required: true, description: 'sign_request signature' } ] },
  { action: 'urn:cg:action:foxxi:scorm-submit-signed' as Affordance['action'], toolName: 'scorm_submit', title: 'Submit the current SCO + advance (graded, commit to SN engine)', method: 'POST', targetTemplate: '{base}/agent/scorm/submit', mediaType: 'application/json',
    description: 'Submit the current SCO. For an assessment SCO pass { answers:[...] } — the player GRADES them against the package answers, commitTracking()s cmi.completion/success/score into the SN engine, and advances (Continue). When the engine sequences to the end, its ROLLUP decides pass/complete and it is recorded to your ELR. Payload { session_id, answers? }. sign_request -> act.',
    inputs: [ { name: '_signed_payload', type: 'string', required: true, description: 'JSON.stringify({ agent_id, timestamp, session_id, answers? })' }, { name: '_signature', type: 'string', required: true, description: 'sign_request signature' } ] },
];
app.get('/agent/scorm/affordances', (_req, res) => {
  const base = (process.env.BRIDGE_DEPLOYMENT_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
  res.type('text/turtle').send(affordancesManifestTurtle(`${base}/agent/scorm/affordances`, SCORM_AFFORDANCES, base, {
    verticalLabel: 'Foxxi agentic SCORM RTE', rdfsComment: 'Author, launch, and play a real SCORM 2004 course as an agent — the SN runtime sequences + the engine rolls up the outcome.',
  }));
});

app.post('/agent/scorm/author', async (req, res) => {
  try {
    const auth = await verifyDelegatedCaller(req.body);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    const c = auth.payload.course as Partial<AgentScormCourse> | undefined;
    if (!c || typeof c !== 'object' || !c.courseId || !Array.isArray(c.scos) || c.scos.length === 0) {
      res.status(400).json({ error: 'course { courseId, title, masteryScore?, scos:[{ id, title, body, assessment? }] } required' }); return;
    }
    const course: AgentScormCourse = {
      courseId: String(c.courseId), title: String(c.title ?? c.courseId),
      masteryScore: typeof c.masteryScore === 'number' ? c.masteryScore : 0.7,
      scos: (c.scos as Array<{ id: unknown; title?: unknown; body?: unknown; assessment?: Array<{ question: unknown; answer?: unknown; answerHash?: unknown }> }>).map(s => ({
        id: String(s.id), title: String(s.title ?? s.id), body: String(s.body ?? ''),
        // Hash answers at author time — plaintext never touches the Map or the pod.
        // Accept an already-hashed answerHash (a course loaded from a pod re-authored).
        ...(Array.isArray(s.assessment) ? { assessment: s.assessment.map(q => ({
          question: String(q.question),
          answerHash: typeof q.answerHash === 'string' && q.answerHash ? q.answerHash : hashAnswer(String(q.answer ?? '')),
        })) } : {}),
      })),
      authoredBy: auth.callerDid,
    };
    try { parseManifest(buildAgentScormManifest(course)); }
    catch (e) { res.status(400).json({ error: `generated SCORM manifest did not parse on the SN runtime: ${(e as Error).message}` }); return; }
    agentScormCourses.set(course.courseId, course);
    // Persist to the author's OWN pod — a self-sovereign, addressable, durable
    // artifact (the Map is a cache; the pod is the system of record). Best-effort.
    const authorPod = resolveSubjectPodUrl(auth.callerDid, typeof auth.payload.subject_pod_url === 'string' ? auth.payload.subject_pod_url : undefined);
    let courseIri;
    try { courseIri = await persistScormCourse({ podUrl: authorPod, authorDid: auth.callerDid, courseId: course.courseId, course: course as unknown as Record<string, unknown> }); }
    catch (e) { console.warn('[durable-record][scorm-course]', (e as Error).message); }
    // Record the AUTHOR's own work as first-class activity (expressive verb) into
    // their lens + pod — so a teacher's record reflects what they built, not nothing.
    const authoredStatementId = emitAgentActivity({
      actorDid: auth.callerDid, verbIri: AUTHORED_VERB, verbDisplay: 'authored',
      objectId: courseIri ?? `urn:foxxi:course:${course.courseId}`, objectName: course.title,
      objectType: 'http://adlnet.gov/expapi/activities/course', result: { completion: true },
    });
    res.json({ ok: true, authoredBy: auth.callerDid, courseId: course.courseId, title: course.title, scoCount: course.scos.length, assessmentScos: course.scos.filter(s => s.assessment?.length).length, masteryScore: course.masteryScore, manifestValid: true, durable: authorPod, ...(courseIri ? { courseIri } : {}), ...(authoredStatementId ? { authoredStatementId } : {}) });
  } catch (err) { res.status(500).json({ ok: false, error: (err as Error).message }); }
});

app.post('/agent/scorm/launch', async (req, res) => {
  try {
    const auth = await verifyDelegatedCaller(req.body);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    const callerDid = auth.callerDid; const p = auth.payload;
    const courseId = typeof p.course_id === 'string' ? p.course_id : '';
    // Resolve the course: in-memory cache first, then the durable pod copy. A
    // learner can launch a course authored in a prior bridge lifetime or by
    // another agent — pass course_pod or author_did to point at the author's
    // pod; default to the caller's own pod (a self-authored course).
    let course = agentScormCourses.get(courseId);
    if (!course) {
      const coursePod = (typeof p.course_pod === 'string' && p.course_pod)
        ? p.course_pod
        : resolveSubjectPodUrl((typeof p.author_did === 'string' && p.author_did) ? p.author_did : callerDid,
            typeof p.subject_pod_url === 'string' ? p.subject_pod_url : undefined);
      const loaded = await loadScormCourse({ podUrl: coursePod, courseId }).catch(() => null);
      if (loaded) { course = loaded as unknown as AgentScormCourse; agentScormCourses.set(courseId, course); }
    }
    if (!course) { res.status(404).json({ error: `no authored SCORM course '${courseId}' found in the catalog or on the author's pod — author it via /agent/scorm/author, or pass author_did/course_pod` }); return; }
    let tree;
    try { tree = parseManifest(buildAgentScormManifest(course)); }
    catch (e) { res.status(500).json({ error: `manifest parse: ${(e as Error).message}` }); return; }
    const subjectPod = resolveSubjectPodUrl(callerDid, typeof p.subject_pod_url === 'string' ? p.subject_pod_url : undefined);
    const lens = lensTenantFor(actorForPod(subjectPod, MESH_ACTOR_LABELS));
    const seq = createSession(tenantIdOf(`scorm:${callerDid}`), tree);
    const nav = processNavigation(seq, 'start');
    if (!nav.ok || !nav.delivered) { res.status(409).json({ error: `SCORM start failed: ${nav.exception ?? nav.message ?? 'no SCO delivered'}` }); return; }
    agentScormPlays.set(seq.id, { seq, courseId, learnerDid: callerDid, lens, masteryScore: course.masteryScore, course });
    res.json({ ok: true, sessionId: seq.id, launchedBy: callerDid, course: { id: courseId, title: course.title }, sco: scoViewForLearner(scoForActivity(course, nav.delivered.activityId)), sequencingEnded: !!nav.sequencingEnded, instruction: 'Read the SCO; for an assessment SCO answer the questions; then POST /agent/scorm/submit { session_id, answers? }. Repeat until done:true.' });
  } catch (err) { res.status(500).json({ ok: false, error: (err as Error).message }); }
});

app.post('/agent/scorm/submit', async (req, res) => {
  try {
    const auth = await verifyDelegatedCaller(req.body);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    const callerDid = auth.callerDid; const p = auth.payload;
    const sessionId = typeof p.session_id === 'string' ? p.session_id : '';
    const play = agentScormPlays.get(sessionId);
    if (!play) { res.status(404).json({ error: 'no SCORM play session — launch first' }); return; }
    if (play.learnerDid !== callerDid) { res.status(403).json({ error: 'not your SCORM session' }); return; }
    const course = play.course;   // resolved at launch (cache or durable pod)
    if (!course) { res.status(410).json({ error: 'course no longer available' }); return; }
    const cur = play.seq.current;
    if (!cur) { res.status(409).json({ error: 'no current SCO to submit' }); return; }
    const sco = scoForActivity(course, cur.id);
    let update: TrackingUpdate = { completion: 'completed' };
    let graded: unknown;
    if (sco?.assessment?.length) {
      const answers = Array.isArray(p.answers) ? (p.answers as unknown[]).map(a => String(a)) : [];
      let correct = 0;
      const detail = sco.assessment.map((item, i) => {
        const raw = answers[i] ?? '';
        const got = normAns(raw);
        // Graded by hash compare — the plaintext key is never stored (the course
        // lives on a world-readable pod). Lenient: the full normalized answer OR any
        // salient token (>=4 chars) may match the key hash, so a semantically-correct
        // answer phrased differently ("the /guidance catalog" vs "/guidance") still
        // scores. Token hashing keeps the key off the pod (no plaintext compare).
        const candidates = new Set<string>();
        if (got.length > 0) candidates.add(hashAnswer(raw));
        for (const tok of got.split(' ')) if (tok.length >= 4) candidates.add(hashAnswer(tok));
        const ok = candidates.has(item.answerHash);
        if (ok) correct++;
        return { question: item.question, your: raw || null, correct: ok };
      });
      const score = correct / sco.assessment.length;
      const passed = score >= play.masteryScore;
      update = { completion: 'completed', success: passed ? 'passed' : 'failed', scoreScaled: score };
      graded = { score: Number(score.toFixed(3)), correct, total: sco.assessment.length, passed, detail };
    }
    commitTracking(play.seq, update);
    const nav = processNavigation(play.seq, 'continue');
    if (nav.ok && nav.delivered && !nav.sequencingEnded) {
      res.json({ ok: true, done: false, ...(graded ? { graded } : {}), sco: scoViewForLearner(scoForActivity(course, nav.delivered.activityId)) });
      return;
    }
    // Sequencing ended — the SN engine's ROLLUP on the root is the course outcome.
    const view = sessionView(play.seq) as { tree?: { tracking?: { completion?: string; success?: string; normalizedMeasure?: number } } };
    const root = view.tree?.tracking ?? {};
    const completed = root.completion === 'completed';
    const passed = root.success === 'satisfied';
    const score = typeof root.normalizedMeasure === 'number' ? root.normalizedMeasure : (passed ? 1 : 0);
    const statementIds = emitScormCompletion(play, course, passed, score);
    agentScormPlays.delete(sessionId);
    res.json({ ok: true, done: true, ...(graded ? { graded } : {}), course: { id: play.courseId, title: course.title }, completed, passed, score: Number(score.toFixed(3)), recordedStatements: statementIds.length, lens: play.lens, note: 'The SCORM 2004 SN runtime rolled up this outcome from your committed SCO tracking — recorded to your ELR.' });
  } catch (err) { res.status(500).json({ ok: false, error: (err as Error).message }); }
});

// PUSH path: a relay (or any observer) POSTs a single context-descriptor for
// low-latency projection. The PULL cycle is the durable backstop, and the
// deterministic statement id makes push+pull idempotent (no double-count). The
// projector reads ONLY the protocol envelope — never a domain term. Body:
// { descriptorUrl, describes?[]|graphIri?, conformsTo?[], modalStatus?,
// supersedes?[], trustLevel?, epistemicConfidence?, groundTruth?,
// generatedAtTime?, success?, scoreScaled?, actorKind?, contextKind?, verb?, originPod }.
// Trajectory/disposition refresh on the next
// PULL cycle; the push gives instant LRS + dashboard visibility.
app.post('/agent/mesh-event', (req, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const originPod = String(b.originPod ?? b.pod ?? '');
    const describes = Array.isArray(b.describes)
      ? (b.describes as string[])
      : (b.graphIri ? [String(b.graphIri)] : []);
    const entry: MeshDiscoverEntry = {
      descriptorUrl: String(b.descriptorUrl ?? b.graphIri ?? ''),
      describes,
      ...(Array.isArray(b.conformsTo) ? { conformsTo: b.conformsTo as string[] } : {}),
      ...(typeof b.modalStatus === 'string' ? { modalStatus: b.modalStatus } : {}),
      ...(Array.isArray(b.supersedes) ? { supersedes: b.supersedes as string[] } : {}),
      ...(typeof b.trustLevel === 'string' ? { trustLevel: b.trustLevel } : {}),
      ...(typeof b.epistemicConfidence === 'number' ? { epistemicConfidence: b.epistemicConfidence } : {}),
      ...(typeof b.groundTruth === 'boolean' ? { groundTruth: b.groundTruth } : {}),
      ...(typeof b.generatedAtTime === 'string' ? { generatedAtTime: b.generatedAtTime } : {}),
      // Optional task outcome — flows straight to xAPI result (honest; omitted when absent).
      ...(typeof b.success === 'boolean' ? { success: b.success } : {}),
      ...(typeof b.scoreScaled === 'number' ? { scoreScaled: b.scoreScaled } : {}),
      // Optional provenance/role envelope — direction (actorKind: human|agent) +
      // context (contextKind: production|training|support); defaults to agent/production.
      ...(typeof b.actorKind === 'string' ? { actorKind: b.actorKind } : {}),
      ...(typeof b.contextKind === 'string' ? { contextKind: b.contextKind } : {}),
      // Optional self-declared action verb (GAP 5) — relayed verbatim; absent → the
      // verb is derived from modal status (performed/intended/considered/voided).
      ...(typeof b.verb === 'string' ? { verb: b.verb } : {}),
    };
    if (!entry.descriptorUrl || !originPod) {
      res.status(400).json({ ok: false, error: 'descriptorUrl + originPod required' });
      return;
    }
    const ev = projectMeshEntry(entry, originPod, MESH_ACTOR_LABELS);
    if (!ev) { res.json({ ok: true, projected: false, reason: 'descriptor lacks a projectable envelope' }); return; }
    landMeshEvent(ev);
    res.json({ ok: true, projected: true, mode: ev.mode, agent: ev.agent, statementId: ev.statement.id, tenant: lensTenantFor(ev.agent) });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// The standards-extension capability is afforded by the agp layer, surfaced as the
// foxxi.extend_standards affordance + handler above — createVerticalBridge registers
// its POST /agent/extend-standards route + MCP tool from the affordance manifest.
// Performance support in the flow: the discoverable learnable-capability catalog.
const FOXXI_GUIDANCE: FoxxiGuidedEntry[] = [
  { action: 'urn:cg:action:foxxi:extend-standards', toolName: 'foxxi.extend_standards', guidance: EXTEND_STANDARDS_GUIDANCE },
];
attachGuidanceServing(app, '/guidance', FOXXI_GUIDANCE);

app.listen(PORT, () => {
  console.log(`foxxi-content-intelligence bridge on http://localhost:${PORT}`);
  console.log(`  MCP endpoint:        http://localhost:${PORT}/mcp`);
  console.log(`  Affordance manifest: http://localhost:${PORT}/affordances`);
  console.log(`  Standards extension: http://localhost:${PORT}/agent/extend-standards  |  Guidance: http://localhost:${PORT}/guidance`);
  console.log(`  Audience: ${audience} (${activeAffordances.length} affordances active; FOXXI_AUDIENCE=learner|admin|both)`);
  void seedDemoContent();
  // Agent-mesh projection: kick an initial cycle + schedule the poller.
  if (MESH_PODS.length > 0) {
    console.log(`[foxxi-bridge][mesh] virtualizing ${MESH_PODS.length} agent pod(s) every ${MESH_PROJECT_INTERVAL_MS}ms into per-agent lens:<agent> views (on-read, never written back to the agent pod); push at POST /agent/mesh-event`);
    void runMeshProjectionCycle().catch(e => console.error('[foxxi-bridge][mesh] initial cycle:', (e as Error).message));
    setInterval(() => {
      void runMeshProjectionCycle().catch(e => console.error('[foxxi-bridge][mesh] cycle:', (e as Error).message));
    }, MESH_PROJECT_INTERVAL_MS);
  } else {
    console.log(`[foxxi-bridge][mesh] no FOXXI_MESH_PODS configured — mesh projection idle (push endpoint still live at POST /agent/mesh-event)`);
  }
});
