import { FOXXI_NS } from './foxxi-vocab.js';
import { iesc } from './turtle-escape.js';
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
      const entries = await discover(podUrl, undefined, args.fetch ? { fetch: args.fetch as never } : undefined);
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
      const entries = await discover(r.podUrl, undefined, args.fetch ? { fetch: args.fetch as never } : undefined);
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
    const r = await fetchFn(descriptorUrl, { headers: { Accept: 'text/turtle' } });
    if (!r.ok) return null;
    const ttl = await r.text();
    const m = ttl.match(/hydra:target\s+<([^>]+)>/);
    if (!m) return null;
    const { content } = await fetchGraphContent(m[1]!, { fetch: fetchFn });
    if (!content) return null;
    const bm = content.match(/<[^>]*#bundleJson>\s+"([A-Za-z0-9+/=\s]+)"/);
    if (!bm) return null;
    return JSON.parse(Buffer.from(bm[1]!.replace(/\s+/g, ''), 'base64').toString('utf8')) as Record<string, unknown>;
  } catch { return null; }
}

// ── H. SCORM upload pipeline ─────────────────────────────────

export interface ScormUploadResult {
  status: 'queued' | 'parsed' | 'failed';
  packageId?: string;
  packageTitle?: string;
  descriptorUrl?: string;
  error?: string;
  note?: string;
}

/**
 * Accept a base64-encoded SCORM zip + queue it for the Python parser.
 * Since the parser runs out-of-process (Articulate Storyline parser is
 * Python), this affordance returns a "queued" status that the operator
 * polls. For now we ship a stub that records the package metadata as
 * a descriptor with parse_status=queued; the real parser-runner is a
 * separate Azure Function deploy.
 */
export async function uploadScormPackage(args: {
  tenantPodUrl: string;
  zipBase64: string;
  hintedTitle?: string;
  uploaderDid: string;
  fetch?: FetchFn;
}): Promise<ScormUploadResult> {
  // Light header inspection — read the first 512 bytes for a PK signature.
  const head = Buffer.from(args.zipBase64.slice(0, 1024), 'base64').slice(0, 4);
  if (head[0] !== 0x50 || head[1] !== 0x4B) {
    return { status: 'failed', error: 'Payload does not look like a zip file (no PK header).' };
  }
  const packageId = `scorm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const graphIri = `urn:foxxi:upload:${packageId}` as IRI;
  const descriptor: ContextDescriptorData = {
    id: `${graphIri}#descriptor` as IRI,
    describes: [graphIri],
    conformsTo: [`${FOXXI_NS}PackageUpload` as IRI],
    facets: [
      { type: 'Temporal', validFrom: new Date().toISOString() },
      { type: 'Provenance', wasAttributedTo: args.uploaderDid as IRI },
      { type: 'Semiotic', modalStatus: 'Hypothetical' }, // until parsed
    ],
  };
  const meta = {
    packageId,
    hintedTitle: args.hintedTitle,
    sizeBytes: Math.floor(args.zipBase64.length * 0.75),
    uploadedAt: new Date().toISOString(),
    uploaderDid: args.uploaderDid,
    status: 'queued',
  };
  const b64 = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64');
  const graph = `<${iesc(graphIri)}> a <${FOXXI_NS}PackageUpload> ;
    <http://www.w3.org/ns/prov#wasAttributedTo> <${iesc(args.uploaderDid)}> ;
    <${FOXXI_NS}bundleJson> "${b64}"^^<http://www.w3.org/2001/XMLSchema#base64Binary> .
`;
  const result = await publish(descriptor, graph, args.tenantPodUrl, {
    fetch: args.fetch,
    containerPath: 'foxxi-uploads/',
    descriptorSlug: packageId,
    graphSlug: `${packageId}-graph`,
  });
  return {
    status: 'queued',
    packageId,
    packageTitle: args.hintedTitle,
    descriptorUrl: result.descriptorUrl,
    note: 'Upload received + descriptor published with modalStatus:Hypothetical. The Python parser-runner (separate Azure Function) reads PackageUpload descriptors, parses the zip, then publishes the resulting fxs:Package + concept graph and sets modalStatus:Asserted via supersedes.',
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
  // Pull manifest first for record-keeping.
  let manifestText = '';
  try {
    const mr = await fetchFn(`${args.podUrl.replace(/\/$/, '')}/.well-known/context-graphs`);
    if (mr.ok) manifestText = await mr.text();
  } catch { /* */ }

  const entries = await discover(args.podUrl, undefined, args.fetch ? { fetch: args.fetch as never } : undefined);
  const backed: TenantBackupEntry[] = [];
  for (const e of entries) {
    try {
      const dr = await fetchFn(e.descriptorUrl, { headers: { Accept: 'text/turtle' } });
      const dt = dr.ok ? await dr.text() : '';
      let graphContent: string | undefined;
      let encrypted = false;
      const m = dt.match(/hydra:target\s+<([^>]+)>/);
      if (m) {
        try {
          const g = await fetchGraphContent(m[1]!, args.fetch ? { fetch: args.fetch as never } : undefined);
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
