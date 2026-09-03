import { FOXXI_NS } from './foxxi-vocab.js';
import { iesc } from './turtle-escape.js';
import { assertSafeFetchTarget, safeFetch, guardedFetchFn } from "./ssrf-guard.js";
import { competencyIri, competencyIdOf, sameCompetency } from './competency-identity.js';

/** Canonical competency key across schemes (urn↔URL) AND across id forms (a bare competency
 *  id, or an achievement id `urn:foxxi:achievement:<tenant>:<courseId>` that embeds one).
 *  Lets a learner's pre-migration (urn) and post-migration (URL) credentials for the SAME
 *  competency roll up to ONE row instead of double-counting. */
function competencyKeyOf(id: string): string {
  const direct = competencyIdOf(id);
  if (direct) return direct;
  const m = /^urn:foxxi:achievement:[^:]+:(.+)$/.exec(id);
  if (m) return competencyIdOf(m[1]!) ?? m[1]!;
  return id;
}
/**
 * Foxxi composed extensions — every "valuable for the vertical" capability
 * from the next-moves brainstorm, implemented as composition over the
 * substrate's existing primitives. Each function here is what a new
 * bridge affordance wraps. No new substrate code; no new L1/L2/L3
 * ontology terms.
 *
 * Sections (each ~one function family):
 *   A. Multi-tenant onboarding   — bootstrap a fresh tenant on a pod
 *   B. Adaptive sequencing       — generate moveOn policy descriptors
 *                                  from cohort intelligence
 *   C. Spaced repetition         — schedule reminder descriptors
 *                                  from prereq graph + completion times
 *   D. Public framework registry — discover CASE frameworks across pods
 *   E. AI tutor marketplace      — tutor agent registration + ranking
 *   F. DPIA composer             — Data Protection Impact Assessment
 *                                  generated from audit_compliance_trail
 *   G. Manager team view         — manager's direct-reports competency map
 *   H. SCORM upload pipeline     — parse + publish in one tool call
 *   I. did:web tenant document   — produce a publishable DID document
 *                                  for a tenant's web domain
 *   J. Tenant pod backup         — single-file dump of every descriptor
 */

import {
  discover,
  fetchGraphContent,
  publish,
  parseManifestArchiveUrls,
} from '@interego/solid';
import type {
  ContextDescriptorData,
  IRI,
} from '@interego/core';
import type {
  FetchFn,
} from '@interego/core';
import type {
  PublishResult,
} from '@interego/solid';
import { TENANT_TYPES } from './tenant-publisher.js';
import type { AuditChain } from './composed-flows.js';
import type { CohortIntelligence } from './cohort-intel.js';
// SCORM parsing, in-process. Every one of these is ALREADY resident in this bridge —
// server.ts imports scorm-fingerprint + course-graph directly, and adm-zip arrives via
// content-delivery.ts -> content-package.ts — so section H stops deferring to an
// out-of-process runner without adding one runtime dependency.
import AdmZip from 'adm-zip';
import { unwrapScormPackage, type ScormPackageFormat } from '../../_shared/scorm/index.js';
import { fingerprintAuthoringTool, type ScormStandardInfo } from './scorm-fingerprint.js';
import { manifestToAgenticCourse, type ManifestCourseResult } from './course-graph.js';
import { refuse } from '../../_shared/vertical-bridge/refusal.js';

// ── A. Multi-tenant onboarding ────────────────────────────────

export interface TenantBootstrapInput {
  tenantSlug: string;          // e.g. 'partnerco-training'
  tenantDid: string;           // e.g. 'did:web:partnerco-training.example'
  tenantDisplayName: string;   // e.g. 'PartnerCo Training L&D'
  adminWebId: string;          // first admin's webId
  adminName: string;
  podUrl: string;              // where the tenant's pod lives (must be writable)
}

export interface TenantBootstrapResult {
  tenant: { slug: string; did: string; displayName: string };
  admin: { webId: string; name: string };
  artifactsPublished: Array<{ kind: string; descriptorUrl: string }>;
  envVarsForBridge: Record<string, string>;
  nextSteps: string[];
}

/**
 * Bootstrap a fresh tenant: publish the tenant-metadata descriptor,
 * an empty initial directory, an empty initial catalog, and the admin's
 * identity stub. Returns the env vars the operator needs to set on the
 * bridge to switch over.
 */
export async function bootstrapTenant(
  args: TenantBootstrapInput & { fetch?: FetchFn },
): Promise<TenantBootstrapResult> {
  const fetchFn = args.fetch;
  const tenantMetadata = {
    slug: args.tenantSlug,
    did: args.tenantDid,
    displayName: args.tenantDisplayName,
    adminWebId: args.adminWebId,
    podUrl: args.podUrl,
    bootstrappedAt: new Date().toISOString(),
  };
  const tenantGraphIri = `urn:foxxi:tenant:${args.tenantSlug}:metadata` as IRI;
  const desc: ContextDescriptorData = {
    id: `${tenantGraphIri}#descriptor` as IRI,
    describes: [tenantGraphIri],
    conformsTo: [`${FOXXI_NS}TenantMetadata` as IRI],
    facets: [
      { type: 'Temporal', validFrom: new Date().toISOString() },
      { type: 'Provenance', wasAttributedTo: args.tenantDid as IRI },
      { type: 'Semiotic', modalStatus: 'Asserted' },
    ],
  };
  const b64 = Buffer.from(JSON.stringify(tenantMetadata), 'utf8').toString('base64');
  const graph = `<${iesc(tenantGraphIri)}> a <${FOXXI_NS}TenantMetadata> ;
    <http://www.w3.org/ns/prov#wasAttributedTo> <${iesc(args.tenantDid)}> ;
    <${FOXXI_NS}bundleJson> "${b64}"^^<http://www.w3.org/2001/XMLSchema#base64Binary> .
`;
  const result = await publish(desc, graph, args.podUrl, {
    fetch: fetchFn,
    containerPath: `foxxi-${args.tenantSlug}/`,
    descriptorSlug: 'tenant-metadata',
    graphSlug: 'tenant-metadata-graph',
  });

  return {
    tenant: { slug: args.tenantSlug, did: args.tenantDid, displayName: args.tenantDisplayName },
    admin: { webId: args.adminWebId, name: args.adminName },
    artifactsPublished: [{ kind: 'TenantMetadata', descriptorUrl: result.descriptorUrl }],
    envVarsForBridge: {
      FOXXI_TENANT_POD_URL: args.podUrl,
      FOXXI_AUTHORITATIVE_SOURCE: args.tenantDid,
      FOXXI_ADMIN_WEB_ID: args.adminWebId,
      FOXXI_TENANT_PROFILE_NAME: args.tenantDisplayName,
    },
    nextSteps: [
      'Set the env vars above on the bridge container app (az containerapp update --set-env-vars)',
      'Set FOXXI_ADMIN_KEY_SEED + FOXXI_ISSUER_KEY_SEED to fresh secrets (keep them in a secrets manager)',
      'Run tools/publish-tenant.ts against the new pod URL to seed catalog + directory + policies',
      `Optionally publish a did:web document at ${args.tenantDid.replace('did:web:', 'https://').replace(/:.*$/, '')}/.well-known/did.json so the issuer DID resolves`,
    ],
  };
}

// ── B. Adaptive sequencing — derive moveOn policies from cohort intel ──

export interface AdaptiveSequencingPolicy {
  policyId: string;
  // typeof: FOXXI_NS is a value, and this is type position. Keeps the original
  // literal-type constraint (conformsTo must be exactly this iri) instead of
  // widening to string.
  conformsTo: `${typeof FOXXI_NS}AdaptiveSequencingPolicy`;
  derivedFrom: 'fxa:CohortConceptIntelligence';
  cohortSize: number;
  reinforcementGates: Array<{
    conceptId: string;
    conceptLabel?: string;
    cohortStruggleRatePct: number;
    /** Recommended action: delay the learner's moveOn until they revisit this concept. */
    action: 'require-reread' | 'require-additional-question' | 'cohort-coaching-suggested';
    rationale: string;
  }>;
  generatedAt: string;
}

/**
 * Generate an adaptive-sequencing policy from cohort intelligence:
 * concepts the cohort struggles with become moveOn gates for the
 * downstream learner.
 */
export function deriveAdaptivePolicy(
  intel: CohortIntelligence,
  thresholdPct: number = 50,
): AdaptiveSequencingPolicy {
  return {
    policyId: `urn:foxxi:adaptive-policy:${Date.now()}`,
    conformsTo: `${FOXXI_NS}AdaptiveSequencingPolicy`,
    derivedFrom: 'fxa:CohortConceptIntelligence',
    cohortSize: intel.cohortSize,
    reinforcementGates: intel.reinforcementCandidates
      .filter(c => c.cohortCoveragePct >= thresholdPct)
      .map(c => ({
        conceptId: c.conceptId,
        conceptLabel: c.conceptLabel,
        cohortStruggleRatePct: c.cohortCoveragePct,
        action: c.cohortCoveragePct >= 75
          ? 'cohort-coaching-suggested'
          : c.cohortCoveragePct >= 60
            ? 'require-additional-question'
            : 'require-reread',
        rationale: `${c.learnerCount} of ${intel.cohortSize} cohort members (${c.cohortCoveragePct}%) asked questions touching this concept — material indicates struggle.`,
      })),
    generatedAt: new Date().toISOString(),
  };
}

// ── C. Spaced repetition — generate reminder descriptors ──────

export interface SpacedRepetitionScheduleInput {
  learnerDid: string;
  completedConcepts: ReadonlyArray<{ conceptId: string; completedAt: string }>;
  /** From the course's prereq graph — which concepts depend on which. */
  prereqEdges: ReadonlyArray<{ from: string; to: string }>;
}

export interface SpacedRepetitionItem {
  conceptId: string;
  reminderAt: string;
  intervalDays: number;
  reason: 'forgetting-curve' | 'prereq-of-upcoming' | 'high-foundation-value';
}

/**
 * Schedule spaced-repetition reminders for a learner based on the
 * Ebbinghaus forgetting curve (1, 7, 30 days) AND the prereq graph
 * (concepts that other concepts depend on get scheduled sooner so
 * the foundation stays fresh).
 */
export function scheduleSpacedRepetition(args: SpacedRepetitionScheduleInput): SpacedRepetitionItem[] {
  const FORGETTING_INTERVALS = [1, 7, 30];
  const items: SpacedRepetitionItem[] = [];

  // Concepts other things depend on get extra reminders.
  const dependedOnBy = new Map<string, Set<string>>();
  for (const e of args.prereqEdges) {
    if (!dependedOnBy.has(e.from)) dependedOnBy.set(e.from, new Set());
    dependedOnBy.get(e.from)!.add(e.to);
  }

  for (const completion of args.completedConcepts) {
    const completedMs = Date.parse(completion.completedAt);
    if (Number.isNaN(completedMs)) continue;
    const dependentCount = dependedOnBy.get(completion.conceptId)?.size ?? 0;
    for (const days of FORGETTING_INTERVALS) {
      items.push({
        conceptId: completion.conceptId,
        reminderAt: new Date(completedMs + days * 24 * 60 * 60 * 1000).toISOString(),
        intervalDays: days,
        reason: 'forgetting-curve',
      });
    }
    if (dependentCount >= 3) {
      // Add an early-week reminder for foundation concepts.
      items.push({
        conceptId: completion.conceptId,
        reminderAt: new Date(completedMs + 3 * 24 * 60 * 60 * 1000).toISOString(),
        intervalDays: 3,
        reason: 'high-foundation-value',
      });
    }
  }
  // Sort earliest-first for a clean list.
  items.sort((a, b) => a.reminderAt.localeCompare(b.reminderAt));
  return items;
}

// ── D. Public framework registry — multi-pod CASE discovery ────

export interface FrameworkRegistryEntry {
  podUrl: string;
  descriptorUrl: string;
  frameworkIri: string;
  conformsTo: string[];
  publisherDid?: string;
  validFrom?: string;
}

/**
 * Walk a list of tenant pods and return every fxs:CourseCatalog +
 * CASE-aligned framework descriptor across them. This is the
 * "federated discovery" layer that lets a tenant find another's
 * competency framework without a central registry.
 */
export async function discoverFrameworkRegistry(args: {
  podUrls: readonly string[];
  fetch?: FetchFn;
}): Promise<FrameworkRegistryEntry[]> {
  const out: FrameworkRegistryEntry[] = [];
  for (const podUrl of args.podUrls) {
    try {
      await assertSafeFetchTarget(podUrl); // SSRF: caller pod fetched via discover()
      const entries = await discover(podUrl, undefined, { fetch: guardedFetchFn(args.fetch) as never }); // re-guard manifest hop + redirects
      for (const e of entries) {
        const ct = e.conformsTo ?? [];
        if (ct.some(c => c.includes('SkillFramework') || c.includes('CourseCatalog') || c.includes('CASEAlignment'))) {
          out.push({
            podUrl,
            descriptorUrl: e.descriptorUrl,
            frameworkIri: e.describes[0] ?? e.descriptorUrl,
            conformsTo: [...ct],
            validFrom: e.validFrom,
          });
        }
      }
    } catch { /* skip pod */ }
  }
  return out;
}

// ── E. AI tutor marketplace ───────────────────────────────────

export interface TutorAgentProfile {
  agentDid: string;
  displayName: string;
  /** Self-attested specialty list (must align with a published framework). */
  specialties: ReadonlyArray<{ frameworkIri: string; competencyIri: string; selfRatedLevel: 'Novice' | 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert' }>;
  /** Optional bio / model details. */
  description?: string;
  poweredBy?: string;  // e.g. 'claude-opus-4-7'
  /** Endpoint where the tutor's MCP server lives (so learners can connect). */
  contactEndpoint?: string;
}

export interface RankedTutor extends TutorAgentProfile {
  /** Number of independent Asserted (human-countersigned) competency-assertion VCs that named this tutor as assessor. */
  countersignedAssertions: number;
  /** Match score 0..1 against the requested competency. */
  matchScore: number;
  /** Free-text rationale (composed). */
  rationale: string;
}

/**
 * Search a list of tutor profile descriptors for matches against a
 * requested competency. Ranks by (a) competency match score and
 * (b) number of independent human-countersigned assertions the tutor
 * has signed (a proxy for established teaching quality).
 */
export function rankTutorsForCompetency(args: {
  candidates: readonly TutorAgentProfile[];
  requiredCompetencyIri: string;
  requiredLevel?: 'Novice' | 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert';
  countersignCounts: ReadonlyMap<string, number>;
}): RankedTutor[] {
  const requiredLevelValue = args.requiredLevel ? { Novice: 1, Beginner: 2, Intermediate: 3, Advanced: 4, Expert: 5 }[args.requiredLevel] : 1;
  const ranked: RankedTutor[] = [];
  for (const c of args.candidates) {
    let bestSpecialty: TutorAgentProfile['specialties'][number] | undefined;
    for (const s of c.specialties) {
      if (sameCompetency(s.competencyIri, args.requiredCompetencyIri)) {
        const levelValue = { Novice: 1, Beginner: 2, Intermediate: 3, Advanced: 4, Expert: 5 }[s.selfRatedLevel];
        if (levelValue >= requiredLevelValue) {
          bestSpecialty = s;
          break;
        }
      }
    }
    if (!bestSpecialty) continue;
    const countersigns = args.countersignCounts.get(c.agentDid) ?? 0;
    const countersignBoost = Math.min(0.5, countersigns / 20);
    const matchScore = 0.5 + countersignBoost; // base 0.5 for exact-competency match
    ranked.push({
      ...c,
      countersignedAssertions: countersigns,
      matchScore,
      rationale: `Self-rated ${bestSpecialty.selfRatedLevel} on ${args.requiredCompetencyIri}; ${countersigns} independent human-countersigned competency assertions on record.`,
    });
  }
  ranked.sort((a, b) => b.matchScore - a.matchScore || b.countersignedAssertions - a.countersignedAssertions);
  return ranked;
}

// ── F. DPIA composer — wraps audit_compliance_trail for regulators ──

export interface DpiaReport {
  generatedAt: string;
  learnerDid: string;
  podUrl: string;
  window: { from?: string; to?: string };
  /** Risk-rated summary mappable to GDPR Art. 35 + EU AI Act §13. */
  summary: {
    totalDataPoints: number;
    automatedDecisions: number;
    aiAssistedAssessments: number;
    humanCountersigns: number;
    accessDecisionsRecorded: number;
    encryptedAtRest: number;
  };
  /** Framework citations rolled up from the audit chain. */
  frameworkControlsCited: string[];
  /** Per-data-category breakdown (GDPR Art. 35 §7.b). */
  dataCategories: Array<{ category: string; count: number; encrypted: boolean }>;
  /** Risk-ranked findings. */
  findings: Array<{ severity: 'info' | 'low' | 'medium' | 'high'; finding: string; mitigation: string }>;
}

/**
 * Compose a DPIA from an audit chain. The chain's `dct:conformsTo`
 * citations roll up into the controls list; descriptor kinds map to
 * GDPR data categories.
 */
export function composeDpia(chain: AuditChain): DpiaReport {
  const ctSet = new Set<string>();
  let automated = 0;
  let aiAssist = 0;
  let countersigns = 0;
  let access = 0;
  let encrypted = 0;
  const categories = new Map<string, { count: number; encrypted: boolean }>();
  for (const s of chain.steps) {
    for (const c of s.conformsTo) ctSet.add(c);
    if (s.kind === 'OB3-credential') {
      categories.set('credentialing', { count: (categories.get('credentialing')?.count ?? 0) + 1, encrypted: false });
    }
    if (s.kind === 'CompetencyAssertion') {
      categories.set('competency-assessment', { count: (categories.get('competency-assessment')?.count ?? 0) + 1, encrypted: false });
      aiAssist++;
    }
    if (s.kind === 'fxa:AccessDecision') { access++; }
    if (s.kind === 'cmi5-completion') {
      categories.set('learning-experience', { count: (categories.get('learning-experience')?.count ?? 0) + 1, encrypted: false });
      automated++;
    }
    if (s.modalStatus === 'Asserted' && s.kind === 'CompetencyAssertion') countersigns++;
    // Anything fetched from a `.envelope.jose.json` was encrypted at rest.
    if (s.descriptorUrl.includes('envelope.jose.json')) encrypted++;
  }
  const findings: DpiaReport['findings'] = [];
  if (aiAssist > 0 && countersigns < aiAssist) {
    findings.push({
      severity: 'high',
      finding: `${aiAssist - countersigns} AI-assisted competency assessment(s) lack a human countersign.`,
      mitigation: 'Configure the AI mentor flow to require human countersign before elevating to Asserted (already supported via foxxi.countersign_assessment).',
    });
  }
  if (access === 0 && chain.stepCount > 5) {
    findings.push({
      severity: 'medium',
      finding: 'No fxa:AccessDecision traces present despite substantial activity. ABAC pipeline may not be emitting traces.',
      mitigation: 'Verify resolveCaller() emits emitAccessDecision on every authed call.',
    });
  }
  if (encrypted === 0) {
    findings.push({
      severity: 'medium',
      finding: 'No admin-encrypted sections detected on the pod. PII may be readable by anonymous viewers.',
      mitigation: 'Re-run tools/publish-tenant.ts to enable E2EE on admin sections.',
    });
  }
  if (findings.length === 0) {
    findings.push({ severity: 'info', finding: 'No high-severity privacy gaps detected in the audit window.', mitigation: 'Continue regular DPIA reviews; check that new affordances also emit access decisions.' });
  }
  return {
    generatedAt: new Date().toISOString(),
    learnerDid: chain.learnerDid,
    podUrl: chain.podUrl,
    window: { from: chain.windowFrom, to: chain.windowTo },
    summary: {
      totalDataPoints: chain.stepCount,
      automatedDecisions: automated,
      aiAssistedAssessments: aiAssist,
      humanCountersigns: countersigns,
      accessDecisionsRecorded: access,
      encryptedAtRest: encrypted,
    },
    frameworkControlsCited: Array.from(ctSet).sort(),
    dataCategories: Array.from(categories.entries()).map(([category, v]) => ({ category, ...v })),
    findings,
  };
}

// ── G. Manager team view ─────────────────────────────────────

export interface ManagerTeamCompetencyView {
  managerWebId: string;
  reportCount: number;
  /** Per-report competency map. */
  reports: Array<{
    learnerWebId: string;
    learnerName?: string;
    credentialCount: number;
    competencies: Array<{ id: string; label?: string; proficiency?: string; issuedAt?: string }>;
  }>;
  /** Roll-up: skills the team has collectively + at what levels. */
  teamSkillCoverage: Array<{ competencyId: string; competencyLabel?: string; coveredBy: string[]; highestLevel: string }>;
}

/**
 * Given a list of direct-report pods, walk each + return a structured
 * view of the team's collective competency state. ABAC enforced
 * upstream (this is just the renderer).
 */
export async function buildManagerTeamView(args: {
  managerWebId: string;
  reportPodUrls: ReadonlyArray<{ webId: string; name?: string; podUrl: string }>;
  fetch?: FetchFn;
}): Promise<ManagerTeamCompetencyView> {
  const reports: ManagerTeamCompetencyView['reports'] = [];
  const teamMap = new Map<string, { label?: string; coveredBy: Set<string>; highestLevelValue: number; highestLevelLabel: string }>();
  const LEVEL_VALUE: Record<string, number> = { Novice: 1, Beginner: 2, Intermediate: 3, Advanced: 4, Expert: 5 };
  for (const r of args.reportPodUrls) {
    try {
      await assertSafeFetchTarget(r.podUrl); // SSRF: caller pod fetched via discover()
      const entries = await discover(r.podUrl, undefined, { fetch: guardedFetchFn(args.fetch) as never }); // re-guard manifest hop + redirects
      const credEntries = entries.filter(e =>
        (e.conformsTo ?? []).some(c => c.includes('CourseCompletionCredential') || c.includes('CompetencyAssertion')),
      );
      const competencies: ManagerTeamCompetencyView['reports'][number]['competencies'] = [];
      for (const e of credEntries) {
        try {
          const cred = await fetchVcFromEntry(e.descriptorUrl, args.fetch ?? (globalThis.fetch as unknown as FetchFn));
          if (!cred) continue;
          const subj = cred.credentialSubject as { achievement?: { id?: string; name?: string; proficiencyLevel?: string }; competency?: { id?: string; label?: string; proficiencyLevel?: string } };
          const cid = subj.achievement?.id ?? subj.competency?.id;
          const clabel = subj.achievement?.name ?? subj.competency?.label;
          const cprof = subj.achievement?.proficiencyLevel ?? subj.competency?.proficiencyLevel;
          if (!cid) continue;
          // Canonicalize so the same competency across schemes/forms rolls up once.
          const key = competencyKeyOf(cid);
          competencies.push({ id: competencyIri(key), label: clabel, proficiency: cprof, issuedAt: typeof cred.validFrom === 'string' ? cred.validFrom : undefined });
          // Team roll-up.
          let existing = teamMap.get(key);
          if (!existing) {
            existing = { label: clabel, coveredBy: new Set(), highestLevelValue: 0, highestLevelLabel: '—' };
            teamMap.set(key, existing);
          }
          existing.coveredBy.add(r.webId);
          const lv = LEVEL_VALUE[cprof ?? ''] ?? 0;
          if (lv > existing.highestLevelValue) {
            existing.highestLevelValue = lv;
            existing.highestLevelLabel = cprof ?? '—';
          }
        } catch { /* skip cred */ }
      }
      reports.push({ learnerWebId: r.webId, learnerName: r.name, credentialCount: credEntries.length, competencies });
    } catch { /* skip report */ }
  }
  const teamSkillCoverage: ManagerTeamCompetencyView['teamSkillCoverage'] = [];
  for (const [key, v] of teamMap.entries()) {
    teamSkillCoverage.push({ competencyId: competencyIri(key), competencyLabel: v.label, coveredBy: [...v.coveredBy], highestLevel: v.highestLevelLabel });
  }
  teamSkillCoverage.sort((a, b) => b.coveredBy.length - a.coveredBy.length);
  return {
    managerWebId: args.managerWebId,
    reportCount: args.reportPodUrls.length,
    reports,
    teamSkillCoverage,
  };
}

async function fetchVcFromEntry(descriptorUrl: string, fetchFn: FetchFn): Promise<Record<string, unknown> | null> {
  try {
    const r = await safeFetch(descriptorUrl, { headers: { Accept: 'text/turtle' } }, fetchFn as never); // 2nd-hop SSRF + redirect-safe
    if (!r.ok) return null;
    const ttl = await r.text();
    const m = ttl.match(/hydra:target\s+<([^>]+)>/);
    if (!m) return null;
    await assertSafeFetchTarget(m[1]!); // 2nd-hop SSRF
    const { content } = await fetchGraphContent(m[1]!, { fetch: guardedFetchFn(fetchFn) as never }); // graph hop: re-guard + redirect-safe
    if (!content) return null;
    const bm = content.match(/<[^>]*#bundleJson>\s+"([A-Za-z0-9+/=\s]+)"/);
    if (!bm) return null;
    return JSON.parse(Buffer.from(bm[1]!.replace(/\s+/g, ''), 'base64').toString('utf8')) as Record<string, unknown>;
  } catch { return null; }
}

// ── H. SCORM upload pipeline ─────────────────────────────────

export interface ScormParseResult {
  packageId: string;
  parsedAt: string;
  /** `identifier` on the manifest root — the publisher's own id for the package. */
  packageIdentifier: string;
  packageTitle: string;
  format: ScormPackageFormat;
  standard: ScormStandardInfo;
  authoringTool: {
    tool: string; toolId: string; vendor: string;
    confidence: number; version?: string; summary: string;
  };
  structure: ManifestCourseResult['structure'];
  resourceCount: number;
  launchable: string[];
}

export interface ScormUploadResult {
  /** No 'queued' member. There is no queue and no runner to drain one, and leaving
   *  the member in the union is how the old implementation stayed plausible: a caller
   *  reads 'queued' as "someone will finish this", and nobody would. */
  status: 'parsed' | 'failed';
  packageId?: string;
  packageTitle?: string;
  /** The Hypothetical fxs:PackageUpload receipt. Published whether or not the parse succeeds. */
  descriptorUrl?: string;
  /** The Asserted fxs:ParsedPackage that supersedes the receipt. Present only on 'parsed'. */
  parsedDescriptorUrl?: string;
  parsed?: ScormParseResult;
  error?: string;
  note?: string;
  /**
   * ★★ PRESENT WHEN THIS RESULT IS A DECLINE, AND IT HAD TO BE ADDED.
   *
   * `foxxi.upload_scorm_package`'s handler types its own authorization decline and then
   * returns `uploadScormPackage(...)` verbatim - so these three `status:'failed'` returns WERE
   * the HTTP response, and carried no `kind`. Executed against the real dispatcher, a rejected
   * upload answered HTTP 200 with isError=false: a caller branching on `res.ok` was told a
   * SCORM package had been accepted when nothing was asserted about it.
   *
   * `status: 'failed'` is kept because callers read it; it is simply not a thing any status
   * code is derived from.
   */
  kind?: 'refusal';
  'iep:refusalStatus'?: number;
  'iep:refusalReason'?: string;
  'iep:resolvedBy'?: Record<string, unknown>;
}

/** Base64 chars accepted. The bridge's own express body limit is 50mb, so a larger
 *  payload never came through that route — the cap is here because uploadScormPackage
 *  is a plain exported function and the route is not its only possible caller. */
const MAX_ZIP_BASE64_CHARS = 64 * 1024 * 1024;
/** A decompression bomb is a small zip whose central directory DECLARES an enormous
 *  expansion. The queued stub never inflated anything, so inflating is new surface and
 *  the guard ships with it. Real SCORM packages (HTML/JS/CSS/media) stay far under
 *  100:1; the declared sizes are read from the central directory, so a refused bomb
 *  costs zero inflated bytes. Without this, one admin-role upload OOMs a bridge shared
 *  across tenants — and a foxxi-bridge OOM surfaces as an unrelated error, never as
 *  "your upload was too big". */
const MAX_EXPANSION_RATIO = 100;
/** Floor, so a legitimately tiny package is never refused on ratio alone. */
const MIN_UNCOMPRESSED_BUDGET_BYTES = 8 * 1024 * 1024;
/** Absolute ceiling regardless of ratio. */
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

/** Total bytes the zip's central directory SAYS it will produce. Reads headers only —
 *  nothing is inflated, which is the whole point. Exported so the guard can be tested
 *  against a real bomb instead of a mock of one. */
export function declaredUncompressedBytes(zipBuffer: Buffer): number {
  let total = 0;
  for (const entry of new AdmZip(zipBuffer).getEntries()) {
    if (!entry.isDirectory) total += entry.header.size;
  }
  return total;
}

/** The inflation budget allowed to a zip of this compressed size. */
export function uncompressedBudget(zipBytes: number): number {
  return Math.min(
    MAX_UNCOMPRESSED_BYTES,
    Math.max(MIN_UNCOMPRESSED_BUDGET_BYTES, zipBytes * MAX_EXPANSION_RATIO),
  );
}

/**
 * Accept a base64-encoded SCORM / cmi5 zip, PARSE IT IN-PROCESS, and publish the result
 * as an Asserted descriptor that supersedes the upload receipt.
 *
 * ★ WHAT WAS WRONG. This function decoded four bytes of the zip to check for a PK
 * header, published a descriptor carrying the package's SIZE and `status: 'queued'`,
 * and deferred the parse to "a separate Azure Function deploy". That runner was never
 * written; NOTHING in this repo reads a fxs:PackageUpload descriptor; and the Azure host
 * it named is retired (probed: it answers nothing). Every upload therefore left a
 * permanently-Hypothetical record naming only its own byte count, and the iep:supersedes
 * promotion this affordance advertises to every agent that reads the manifest could not
 * happen. Measured on a real Storyline SCORM 2004 zip: the title, the standard, the two
 * SCOs and the authoring tool were all in the bytes and all discarded.
 *
 * ★ NOTHING OUT-OF-PROCESS IS NEEDED. unwrapScormPackage (adm-zip),
 * fingerprintAuthoringTool and manifestToAgenticCourse are in-repo, pure and
 * synchronous — the same three POST /agent/course/analyze already composes. That route
 * relies on the BROWSER to unzip (microsite CourseIntel.tsx, fflate); the unzip is the
 * only step it does not do, and unwrapScormPackage is that step.
 *
 * ★ TWO DESCRIPTORS, STILL. The Hypothetical receipt is published FIRST and kept even
 * when the parse fails — that is what makes a rejected upload auditable: bytes arrived,
 * nothing was asserted about them. Only a successful parse publishes the Asserted
 * fxs:ParsedPackage over the same graph with `supersedes` pointing at the receipt.
 */
export async function uploadScormPackage(args: {
  tenantPodUrl: string;
  zipBase64: string;
  hintedTitle?: string;
  uploaderDid: string;
  fetch?: FetchFn;
}): Promise<ScormUploadResult> {
  if (args.zipBase64.length > MAX_ZIP_BASE64_CHARS) {
    return { ...refuse(413,
      `Payload too large (${args.zipBase64.length} base64 chars; max ${MAX_ZIP_BASE64_CHARS}).`,
      'the upload exceeds the size this deployment accepts'), status: 'failed' };
  }
  // Light header inspection — read the first 512 bytes for a PK signature.
  const head = Buffer.from(args.zipBase64.slice(0, 1024), 'base64').slice(0, 4);
  if (head[0] !== 0x50 || head[1] !== 0x4B) {
    return { ...refuse(400,
      'Payload does not look like a zip file (no PK header).',
      'the bytes supplied are not a zip archive, so no SCORM package could be read'), status: 'failed' };
  }
  const zipBuffer = Buffer.from(args.zipBase64, 'base64');
  const packageId = `scorm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const graphIri = `urn:foxxi:upload:${packageId}` as IRI;
  const uploadedAt = new Date().toISOString();

  // 1) The receipt. Hypothetical: bytes arrived, nothing has been read out of them yet.
  const receiptDescriptor: ContextDescriptorData = {
    id: `${graphIri}#descriptor` as IRI,
    describes: [graphIri],
    conformsTo: [`${FOXXI_NS}PackageUpload` as IRI],
    facets: [
      { type: 'Temporal', validFrom: uploadedAt },
      { type: 'Provenance', wasAttributedTo: args.uploaderDid as IRI },
      { type: 'Semiotic', modalStatus: 'Hypothetical' }, // until parsed
    ],
  };
  const meta = {
    packageId,
    hintedTitle: args.hintedTitle,
    sizeBytes: zipBuffer.length,   // the DECODED size; the old field was a b64-length estimate
    uploadedAt,
    uploaderDid: args.uploaderDid,
    status: 'received',
  };
  const receiptB64 = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64');
  const receiptGraph = `<${iesc(graphIri)}> a <${FOXXI_NS}PackageUpload> ;
    <http://www.w3.org/ns/prov#wasAttributedTo> <${iesc(args.uploaderDid)}> ;
    <${FOXXI_NS}bundleJson> "${receiptB64}"^^<http://www.w3.org/2001/XMLSchema#base64Binary> .
`;
  const receipt = await publish(receiptDescriptor, receiptGraph, args.tenantPodUrl, {
    fetch: args.fetch,
    containerPath: 'foxxi-uploads/',
    descriptorSlug: packageId,
    graphSlug: `${packageId}-graph`,
  });

  // 2) The parse. In-process, synchronous, no runner.
  let parsed: ScormParseResult;
  try {
    const declared = declaredUncompressedBytes(zipBuffer);
    const budget = uncompressedBudget(zipBuffer.length);
    if (declared > budget) {
      throw new Error(`zip declares ${declared} uncompressed bytes against a budget of ${budget} — refused as a decompression bomb before inflating anything.`);
    }
    const pkg = unwrapScormPackage(zipBuffer);
    const fileList = ['imsmanifest.xml', ...pkg.resources.map(r => r.path)];
    const fileText: Record<string, string> = {};
    for (const r of pkg.resources) {
      if (typeof r.content === 'string') fileText[r.path] = r.content.slice(0, 4000);
    }
    const fingerprint = fingerprintAuthoringTool({ manifestXml: pkg.manifestRaw, fileList, fileContents: fileText });
    const built = manifestToAgenticCourse({
      manifestXml: pkg.manifestRaw, fileList, fileText,
      courseIri: graphIri, authoritativeSource: graphIri,
    });
    parsed = {
      packageId,
      parsedAt: new Date().toISOString(),
      packageIdentifier: pkg.identifier,
      // The manifest's own title wins. The uploader's hint is a fallback, never an override —
      // what the package SAYS it is outranks what the uploader typed.
      packageTitle: pkg.title !== 'untitled' ? pkg.title : (args.hintedTitle ?? pkg.title),
      format: pkg.format,
      standard: fingerprint.standard,
      authoringTool: {
        tool: fingerprint.tool, toolId: fingerprint.toolId, vendor: fingerprint.vendor,
        confidence: fingerprint.confidence, version: fingerprint.version, summary: fingerprint.summary,
      },
      structure: built.structure,
      resourceCount: pkg.resources.length,
      launchable: pkg.resources.filter(r => r.isLaunchable).map(r => r.path),
    };
  } catch (err) {
    // 422, not 400: the bytes ARE a zip (the PK check above passed) and this deployment is
    // healthy - what could not be processed is the SCORM package inside it. The receipt stays
    // Hypothetical on the pod, which is the honest record of exactly that.
    return {
      ...refuse(
        422,
        `SCORM parse failed: ${(err as Error).message}`,
        'the archive was readable but its SCORM manifest could not be parsed, so nothing was asserted about the package',
      ),
      status: 'failed',
      packageId,
      packageTitle: args.hintedTitle,
      descriptorUrl: receipt.descriptorUrl,
      note: 'The upload receipt is on the pod as a Hypothetical fxs:PackageUpload and stays that way. Nothing was asserted about the package because it could not be read.',
    };
  }

  // 3) The promotion. Same graph, Asserted, superseding the receipt.
  const parsedDescriptor: ContextDescriptorData = {
    id: `${graphIri}#parsed` as IRI,
    describes: [graphIri],
    conformsTo: [`${FOXXI_NS}ParsedPackage` as IRI],
    supersedes: [`${graphIri}#descriptor` as IRI],
    facets: [
      { type: 'Temporal', validFrom: parsed.parsedAt },
      { type: 'Provenance', wasAttributedTo: args.uploaderDid as IRI },
      { type: 'Semiotic', modalStatus: 'Asserted' },
    ],
  };
  const parsedB64 = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64');
  const parsedGraph = `<${iesc(graphIri)}> a <${FOXXI_NS}ParsedPackage> ;
    <http://www.w3.org/ns/prov#wasAttributedTo> <${iesc(args.uploaderDid)}> ;
    <${FOXXI_NS}bundleJson> "${parsedB64}"^^<http://www.w3.org/2001/XMLSchema#base64Binary> .
`;
  const promoted = await publish(parsedDescriptor, parsedGraph, args.tenantPodUrl, {
    fetch: args.fetch,
    containerPath: 'foxxi-uploads/',
    descriptorSlug: `${packageId}-parsed`,
    graphSlug: `${packageId}-parsed-graph`,
  });

  return {
    status: 'parsed',
    packageId,
    packageTitle: parsed.packageTitle,
    descriptorUrl: receipt.descriptorUrl,
    parsedDescriptorUrl: promoted.descriptorUrl,
    parsed,
    note: 'Parsed in-process — no external runner. The Asserted fxs:ParsedPackage descriptor supersedes the Hypothetical fxs:PackageUpload receipt over the same graph.',
  };
}

// ── I. did:web tenant document ─────────────────────────────────

export interface TenantDidDocument {
  '@context': string[];
  id: string;
  verificationMethod: Array<{
    id: string;
    type: 'Ed25519VerificationKey2020';
    controller: string;
    publicKeyMultibase: string;
  }>;
  authentication: string[];
  assertionMethod: string[];
  service: Array<{
    id: string;
    type: string;
    serviceEndpoint: string;
  }>;
}

/**
 * Produce a publishable did:web document for a tenant. Operator
 * uploads the JSON to the tenant domain's `.well-known/did.json`.
 * The tenant's issuer key (BBS+ + Ed25519) is exposed so any
 * verifier doing did:web resolution can verify credentials.
 */
export function buildTenantDidDocument(args: {
  tenantDid: string;        // did:web:tenant.example
  issuerPublicKeyMultibase: string;
  bridgeEndpoint: string;
}): TenantDidDocument {
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: args.tenantDid,
    verificationMethod: [{
      id: `${args.tenantDid}#issuer-ed25519`,
      type: 'Ed25519VerificationKey2020',
      controller: args.tenantDid,
      publicKeyMultibase: args.issuerPublicKeyMultibase,
    }],
    authentication: [`${args.tenantDid}#issuer-ed25519`],
    assertionMethod: [`${args.tenantDid}#issuer-ed25519`],
    service: [{
      id: `${args.tenantDid}#foxxi-bridge`,
      type: 'FoxxiBridge',
      serviceEndpoint: args.bridgeEndpoint,
    }],
  };
}

// ── J. Tenant pod backup ─────────────────────────────────────

export interface TenantBackupEntry {
  descriptorUrl: string;
  conformsTo: string[];
  validFrom?: string;
  descriptorTurtle: string;
  graphContent?: string;
  encrypted: boolean;
}

export interface TenantBackup {
  podUrl: string;
  backedUpAt: string;
  entries: TenantBackupEntry[];
  manifest: string;
}

/**
 * One-shot backup of every descriptor on the pod. Resulting JSON can
 * be re-imported via a (separate) restore tool. Encrypted graphs come
 * back as ciphertext; the operator restores them with the same admin
 * keypair.
 */
export async function backupTenantPod(args: {
  podUrl: string;
  fetch?: FetchFn;
}): Promise<TenantBackup> {
  const fetchFn = args.fetch ?? globalThis.fetch;
  // Guard the pod host BEFORE any fetch (manifest included) — parity with the
  // sibling readers (round-26 defense-in-depth; podUrl is admin-pinned here).
  await assertSafeFetchTarget(args.podUrl); // SSRF: caller pod fetched via discover()
  // Pull the index for record-keeping — ALL of it.
  //
  // ★ A BACKUP IS THE LAST PLACE A PARTIAL VIEW MAY GO UNLABELLED. A pod's manifest is
  // bounded: past a threshold its older rows live in write-once archive segments that the
  // hot document links, and reading only the hot document would put a plausible, valid,
  // SHORT manifest in a field called `manifest`. The restored data itself would be fine —
  // `entries` below comes from `discover()`, which unions the chain — but a future restore
  // tool that rebuilt an index from this field would truncate the pod it was recovering, and
  // would look right while doing it. Concatenating the chain keeps the field's name true.
  const manifestUrl = `${args.podUrl.replace(/\/$/, '')}/.well-known/context-graphs`;
  let manifestText = '';
  try {
    const mr = await safeFetch(manifestUrl, {}, fetchFn as never);
    if (mr.ok) {
      const hot = await mr.text();
      const parts = [hot];
      for (const seg of parseManifestArchiveUrls(hot, manifestUrl)) {
        try {
          const sr = await safeFetch(seg, {}, fetchFn as never);
          if (sr.ok) parts.push(await sr.text());
        } catch { /* an unreachable segment is reported by discover()'s own refusal below */ }
      }
      manifestText = parts.join('\n\n');
    }
  } catch { /* */ }

  const entries = await discover(args.podUrl, undefined, { fetch: guardedFetchFn(args.fetch) as never }); // re-guard manifest hop + redirects
  const backed: TenantBackupEntry[] = [];
  for (const e of entries) {
    try {
      const dr = await safeFetch(e.descriptorUrl, { headers: { Accept: 'text/turtle' } }, fetchFn as never); // 2nd-hop SSRF + redirect-safe
      const dt = dr.ok ? await dr.text() : '';
      let graphContent: string | undefined;
      let encrypted = false;
      const m = dt.match(/hydra:target\s+<([^>]+)>/);
      if (m) {
        try {
          const g = await fetchGraphContent(m[1]!, { fetch: guardedFetchFn(args.fetch) as never }); // graph hop: re-guard + redirect-safe
          encrypted = g.encrypted;
          if (g.content) graphContent = g.content;
        } catch { /* graph unreachable */ }
      }
      backed.push({
        descriptorUrl: e.descriptorUrl,
        conformsTo: [...(e.conformsTo ?? [])],
        validFrom: e.validFrom,
        descriptorTurtle: dt,
        graphContent,
        encrypted,
      });
    } catch { /* skip */ }
  }
  return {
    podUrl: args.podUrl,
    backedUpAt: new Date().toISOString(),
    entries: backed,
    manifest: manifestText,
  };
}
