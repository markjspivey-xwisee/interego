/**
 * Foxxi Enterprise Learner Record (ELR) assembler — IEEE P2997.
 *
 * IEEE P2997 "Standard for Enterprise Learner Record" (LTSC, ADL-chaired)
 * defines an ELR data model that "preserves data ownership by providing
 * indications to where raw learner data is stored" and tracks a subject's
 * path through organisations, learning experiences, demonstrated
 * competencies, conferred credentials, and EMPLOYMENT HISTORY.
 *
 * This module COMPOSES that aggregate from substrate primitives — it
 * invents no new credential, xAPI, or competency machinery:
 *
 *   experiences  ← Foxxi-as-LRS xAPI statements (training / learning).
 *   performance  ← Foxxi-as-LRS xAPI `performed` statements (on-the-job
 *                  production work — the P2997 "employment history" leg).
 *   credentials  ← the subject's pod wallet, via exportClr().
 *   competencies ← three provenance-distinct sources, ranked:
 *                    · performance — proven by successful production work
 *                      (Asserted; the strongest basis — it SUPERSEDES a
 *                      training-only inference for the same competency).
 *                    · credential  — alignments on verified credentials
 *                      (Asserted).
 *                    · inferred    — predicted from a passed/completed
 *                      experience alone (Hypothetical — iep:modalStatus
 *                      keeps the prediction honest).
 *   provenance   ← P2997's hallmark: every entry points back to where its
 *                  raw record lives.
 *
 * ACTOR-AGNOSTIC. The subject is a `iep:Agent` identified by a DID — it
 * may be a human learner/performer OR an AI agent learning + exercising
 * tools. `subjectKind` records which; the data shape is identical. An
 * agent's ELR is its capability record; a human's is their learner +
 * employment record. Same machinery.
 *
 * Pure read. No writes.
 */

import { exportClr, type ClrEnvelope } from './clr.js';
import { competencyIri } from './competency-identity.js';
import type { StoredStatement } from './statement-store.js';
import { FOXXI_NS } from './foxxi-vocab.js';
import { evaluateProficiency, LER_NS } from './ler-tla-vocab.js';

const ELR_CONTEXT = [
  'https://www.w3.org/ns/credentials/v2',
  'https://standards.ieee.org/ieee/2997/', // IEEE P2997 ELR
] as const;

const ADL = 'http://adlnet.gov/expapi/verbs/';
const FOXXI_VOCAB = FOXXI_NS;
/** Verbs that imply the subject demonstrated something (→ inferred competency). */
const MASTERY_VERBS = new Set([`${ADL}passed`, `${ADL}completed`, `${ADL}mastered`]);
/** The verb a `performed` production-work statement carries. */
export const PERFORMED_VERB = `${FOXXI_VOCAB}performed`;
/** Structural modal verbs (GAP 5): an Asserted descriptor PERFORMED work; a
 *  Hypothetical one records an INTENDED act (a plan/intention); a Counterfactual
 *  one a CONSIDERED act (a road not taken). These name the MODAL MODE — honestly
 *  derived from iep:ModalStatusEnum, never a fabricated domain verb — and match the
 *  Foxxi xAPI Profile's structural verb concepts. */
export const INTENDED_VERB = `${FOXXI_VOCAB}verbs/intended`;
export const CONSIDERED_VERB = `${FOXXI_VOCAB}verbs/considered`;
/** Agent-declared ACTIVITY verbs — the teacher/issuer's OWN work is real activity
 *  and is recorded with an EXPRESSIVE verb (not a `performed` monoculture) so a
 *  teacher's record reflects what they DID. These name the act, not a learned
 *  competency, so they project as experiences (no manufactured competency for the
 *  author). Declared in the Foxxi xAPI Profile + dereferenceable. */
export const AUTHORED_VERB = `${FOXXI_VOCAB}verbs/authored`;
export const CREDENTIALED_VERB = `${FOXXI_VOCAB}verbs/credentialed`;
/** Context-extension IRIs the record_performance handler stamps. */
export const PERF_EXT = {
  observedBy: `${FOXXI_VOCAB}observedBy`,
  costUsd: `${FOXXI_VOCAB}costUsd`,
  contextKind: `${FOXXI_VOCAB}contextKind`,
  actorKind: `${FOXXI_VOCAB}actorKind`,
} as const;

// ── ELR data model ──────────────────────────────────────────────────

export type ElrModalStatus = 'Asserted' | 'Hypothetical';
export type ElrSubjectKind = 'human' | 'agent';
export type CompetencyBasis = 'performance' | 'credential' | 'inferred';

/** P2997: an organisation in the subject's path. */
export interface ElrOrganization {
  id: string;
  role: 'credential-issuer' | 'lrs-authority' | 'tenant';
}

/** A learning experience — projected from one training xAPI statement. */
export interface ElrExperience {
  id: string;
  verb: string;
  verbDisplay: string;
  activityId: string;
  activityName?: string;
  timestamp: string;
  /** xAPI Statements are committed claims — always Asserted. */
  modalStatus: 'Asserted';
  rawDataLocation: string;
}

/** A performance record — on-the-job production work (P2997 employment
 *  history). Projected from one xAPI `performed` statement. */
export interface ElrPerformanceRecord {
  id: string;
  taskId: string;
  taskName: string;
  /** Semantic activity type (the descriptor's conformsTo IRI, carried by the
   *  mesh projector as object.definition.type) — the basis for competency
   *  aggregation, NOT the instance leaf token. */
  taskType?: string;
  /** Asserted task outcome. `undefined` = the source asserted NO result (the
   *  common case for a context descriptor) — which is NOT a failure. Only an
   *  explicit `false` means an asserted failure. */
  success?: boolean;
  /** Outcome quality 0..1, when scored. */
  quality?: number;
  durationIso?: string;
  costUsd?: number;
  timestamp: string;
  /** Observed production fact. */
  modalStatus: 'Asserted';
  /** DID of the observer/evaluator who attested this (provenance). */
  observedBy?: string;
  rawDataLocation: string;
}

/** A demonstrated or inferred competency. */
export interface ElrCompetency {
  id: string;
  label: string;
  modalStatus: ElrModalStatus;
  /** Which evidence class this competency rests on (strongest available). */
  basis: CompetencyBasis;
  framework?: string;
  /** RDF type — this node IS a ler:CompetencyAssertion (validatable against the
   *  published /ns/ieee-ler shape). */
  assertionType: string;
  /** A distinct per-assertion IRI (subject+competency) — so two learners' assertions
   *  about the same competency are NOT the same node. */
  assertionId: string;
  /** The SUBJECT the assertion is about (the learner/agent DID) — distinct from the
   *  asserting agent. A subjectless assertion is not a standalone claim. */
  subject: string;
  /** ler:aboutCompetency — the dereferenceable competency definition IRI. */
  aboutCompetency: string;
  /** ler:atProficiency — a dereferenceable tla:Level / ler:ProficiencyLevel IRI
   *  drawn from the published proficiency framework (never a bare band string). */
  proficiencyLevel: string;
  proficiencyLabel: string;
  proficiencyRank: number;
  /** tla:confidence — Wilson-lower-bound confidence in the success rate, 0..1. */
  confidence: number;
  /** The published tla:RollupRule IRI that produced level + confidence. */
  rolledUpBy: string;
  /** iep:assertingAgent — the tenant/bridge issuer making this assertion. */
  assertingAgent: string;
  /** ler:supportedByEvidence — dereferenceable evidence IRIs. Alias of `evidence`. */
  evidence: string[];
  /** Quantified evidence across classes. */
  evidenceSummary: {
    trainingCompletions: number;
    performanceExecutions: number;
    performanceSuccessRate?: number;
    performanceAvgQuality?: number;
  };
  /** Set when performance evidence supersedes a weaker training-only
   *  inference — the data-informed feedback loop. */
  supersedes?: string;
}

/** A conferred credential — thin projection of a wallet entry. */
export interface ElrCredential {
  id: string;
  achievementName?: string;
  issuer: string;
  verified: boolean;
  rawDataLocation: string;
}

/** P2997: an indication of where a class of raw data is stored. */
export interface ElrRawDataLocation {
  kind: 'subject-pod' | 'lrs' | 'credential-descriptor';
  location: string;
  description: string;
}

export interface EnterpriseLearnerRecord {
  '@context': readonly string[];
  type: readonly string[];
  id: string;
  conformsTo: string;
  /** human learner/performer OR AI agent. The data shape is identical. */
  subjectKind: ElrSubjectKind;
  learner: { did: string; name?: string };
  assembledAt: string;
  organizationPath: ElrOrganization[];
  experiences: ElrExperience[];
  performanceRecords: ElrPerformanceRecord[];
  competencies: ElrCompetency[];
  credentials: ElrCredential[];
  provenance: { rawDataLocations: ElrRawDataLocation[] };
  summary: {
    experienceCount: number;
    performanceCount: number;
    performanceSuccessRate?: number;
    credentialCount: number;
    verifiedCredentialCount: number;
    competencyCount: number;
    assertedCompetencies: number;
    inferredCompetencies: number;
    performanceVerifiedCompetencies: number;
  };
}

export interface AssembleElrConfig {
  learnerDid: string;
  learnerName?: string;
  learnerPodUrl: string;
  /** human (default) or agent. */
  subjectKind?: ElrSubjectKind;
  tenantDid: string;
  lrsEndpoint: string;
  /** The subject's xAPI statements (caller pulls them from the LRS). */
  statements: readonly StoredStatement[];
  fetch?: typeof globalThis.fetch;
}

// ── Assembler ───────────────────────────────────────────────────────

export async function assembleEnterpriseLearnerRecord(
  config: AssembleElrConfig,
): Promise<EnterpriseLearnerRecord> {
  const subjectKind: ElrSubjectKind = config.subjectKind ?? 'human';

  // 1. Credentials — reuse the existing CLR composer (discover + verify).
  let clr: ClrEnvelope | null = null;
  try {
    clr = await exportClr({
      learnerPodUrl: config.learnerPodUrl,
      learnerDid: config.learnerDid,
      fetch: config.fetch,
    });
  } catch {
    clr = null; // pod unreachable / empty — ELR still assembles from LRS
  }

  // 2. Split the xAPI statements: `performed` → on-the-job performance;
  //    everything else → learning experiences.
  const experiences: ElrExperience[] = [];
  const performanceRecords: ElrPerformanceRecord[] = [];
  for (const rec of config.statements) {
    if (rec.voided) continue;
    const s = rec.statement;
    // A credential-wallet descriptor is an accomplishment artifact already surfaced
    // via the CLR (step 4) — it is NOT a performance event or a learning experience.
    // Skip it on BOTH legs so it is represented exactly once (as a credential), with
    // no double-count and no envelope-class competency inferred from it.
    const objType = (s.object as { definition?: { type?: string } } | undefined)?.definition?.type;
    if (isCredentialEnvelope(objType)) continue;
    if (isProductionPerformance(s)) {
      performanceRecords.push(projectPerformance(rec, config.lrsEndpoint));
    } else {
      experiences.push(projectExperience(rec, config.lrsEndpoint));
    }
  }

  // 3. Competencies — merge three provenance-distinct sources, keyed by a
  //    normalised label so performance evidence can supersede a weaker
  //    training inference for the same competency.
  const competencies = buildCompetencies(clr, experiences, performanceRecords, config.tenantDid, config.learnerDid, config.learnerPodUrl);

  // 4. Credentials projection.
  const credentials: ElrCredential[] = (clr?.credentialEntries ?? []).map(e => {
    const subj = e.credential.credentialSubject as { achievement?: { name?: string } };
    return {
      id: e.credential.id ?? e.sourceDescriptor,
      achievementName: subj.achievement?.name,
      issuer: typeof e.credential.issuer === 'string' ? e.credential.issuer : '',
      verified: e.verified,
      rawDataLocation: e.sourceDescriptor,
    };
  });

  // 5. Organisation path.
  const orgs = new Map<string, ElrOrganization>();
  orgs.set(config.tenantDid, { id: config.tenantDid, role: 'tenant' });
  for (const c of credentials) {
    if (c.issuer && !orgs.has(c.issuer)) orgs.set(c.issuer, { id: c.issuer, role: 'credential-issuer' });
  }
  if (!orgs.has(config.lrsEndpoint)) {
    orgs.set(config.lrsEndpoint, { id: config.lrsEndpoint, role: 'lrs-authority' });
  }

  // 6. Provenance — P2997 raw-data-location indications.
  const rawDataLocations: ElrRawDataLocation[] = [
    { kind: 'subject-pod', location: config.learnerPodUrl, description: 'Subject-owned pod — credentials + competency assertions (the authoritative wallet).' },
    { kind: 'lrs', location: `${config.lrsEndpoint}/xapi/statements`, description: 'Foxxi-as-LRS — raw xAPI experience + performance statements.' },
  ];
  for (const c of credentials) {
    rawDataLocations.push({ kind: 'credential-descriptor', location: c.rawDataLocation, description: `Pod descriptor for credential ${c.achievementName ?? c.id}.` });
  }

  const perfSuccess = performanceRecords.filter(p => p.success === true).length;
  // Only records that asserted an outcome count toward the rate — result-less
  // context descriptors are "no outcome asserted", not failures.
  const perfAssessed = performanceRecords.filter(p => p.success !== undefined).length;

  return {
    '@context': ELR_CONTEXT,
    type: ['VerifiablePresentation', 'EnterpriseLearnerRecord'],
    // Dereferenceable URL id (everything-is-a-URL): the subject's own pod is the
    // authoritative home of the record, so the ELR is a fragment on it.
    id: `${config.learnerPodUrl.replace(/\/+$/, '')}/#enterprise-learner-record`,
    conformsTo: 'IEEE P2997 — Enterprise Learner Record (data model, Part 1)',
    subjectKind,
    learner: { did: config.learnerDid, name: config.learnerName },
    assembledAt: new Date().toISOString(),
    organizationPath: [...orgs.values()],
    experiences,
    performanceRecords,
    competencies,
    credentials,
    provenance: { rawDataLocations },
    summary: {
      experienceCount: experiences.length,
      performanceCount: performanceRecords.length,
      performanceSuccessRate: perfAssessed > 0
        ? round2(perfSuccess / perfAssessed) : undefined,
      credentialCount: credentials.length,
      verifiedCredentialCount: credentials.filter(c => c.verified).length,
      competencyCount: competencies.length,
      assertedCompetencies: competencies.filter(c => c.modalStatus === 'Asserted').length,
      inferredCompetencies: competencies.filter(c => c.modalStatus === 'Hypothetical').length,
      performanceVerifiedCompetencies: competencies.filter(c => c.basis === 'performance').length,
    },
  };
}

// ── Projection helpers ──────────────────────────────────────────────

/** P2997 §5.3 raw-data-location IRI for a statement. Prefer the AUTHORITATIVE,
 *  durable source — the subject's own pod descriptor (cited by the projector as
 *  the `substrateDescriptorIri` extension) — over the derived LRS view, which for
 *  a virtualized lens tenant is an ephemeral re-projectable cache. This makes the
 *  pointer holder-owned + restart-durable (it resolves to the agent's pod, the
 *  system of record), and only falls back to the LRS statement URL when no
 *  substrate descriptor is present (e.g. a natively-recorded course statement). */
const SUBSTRATE_DESCRIPTOR_EXT = `${FOXXI_VOCAB}substrateDescriptorIri`;
function rawDataLocationFor(rec: StoredStatement, lrsEndpoint: string): string {
  const ext = (rec.statement.context as { extensions?: Record<string, unknown> } | undefined)?.extensions ?? {};
  const src = ext[SUBSTRATE_DESCRIPTOR_EXT];
  return (typeof src === 'string' && src) ? src : `${lrsEndpoint}/xapi/statements?statementId=${rec.id}`;
}

function projectExperience(rec: StoredStatement, lrsEndpoint: string): ElrExperience {
  const s = rec.statement;
  const verb = s.verb as { id?: string; display?: Record<string, string> } | undefined;
  const obj = s.object as { id?: string; definition?: { name?: Record<string, string> } } | undefined;
  return {
    id: rec.id,
    verb: verb?.id ?? '',
    verbDisplay: pickLang(verb?.display) ?? verb?.id?.split('/').pop() ?? 'observed',
    activityId: obj?.id ?? '',
    activityName: pickLang(obj?.definition?.name),
    timestamp: (s.timestamp as string | undefined) ?? rec.stored,
    modalStatus: 'Asserted',
    rawDataLocation: rawDataLocationFor(rec, lrsEndpoint),
  };
}

/** Is this statement an on-the-job PRODUCTION performance (the P2997 employment
 *  leg), rather than a learning experience? Keys on the `contextKind=production`
 *  extension the record_performance handler stamps — so it works with a MOM
 *  outcome verb (completed/passed/mastered/scored) — and dual-reads the legacy
 *  `foxxi#performed` verb for statements written before the MOM-verb migration. */
const CONTEXT_KIND_EXT = PERF_EXT.contextKind;
function isProductionPerformance(s: StoredStatement['statement']): boolean {
  const ext = (s.context as { extensions?: Record<string, unknown> } | undefined)?.extensions ?? {};
  if (ext[CONTEXT_KIND_EXT] === 'production') return true;
  const verb = s.verb as { id?: string } | undefined;
  return verb?.id === PERFORMED_VERB;
}

function projectPerformance(rec: StoredStatement, lrsEndpoint: string): ElrPerformanceRecord {
  const s = rec.statement;
  const obj = s.object as { id?: string; definition?: { name?: Record<string, string>; type?: string } } | undefined;
  const result = s.result as { success?: boolean; score?: { scaled?: number }; duration?: string } | undefined;
  const ext = (s.context as { extensions?: Record<string, unknown> } | undefined)?.extensions ?? {};
  const cost = ext[PERF_EXT.costUsd];
  return {
    id: rec.id,
    taskId: obj?.id ?? '',
    taskName: pickLang(obj?.definition?.name) ?? obj?.id?.split(/[#/]/).pop() ?? obj?.id ?? 'task',
    taskType: obj?.definition?.type,
    // No result asserted ⇒ success undefined (NOT false). Fabricating `false`
    // marked every result-less context descriptor as a failed performance,
    // dragging the success rate to 0 and pinning every competency Hypothetical.
    success: result?.success,
    quality: typeof result?.score?.scaled === 'number' ? result.score.scaled : undefined,
    durationIso: result?.duration,
    costUsd: typeof cost === 'number' ? cost : undefined,
    timestamp: (s.timestamp as string | undefined) ?? rec.stored,
    modalStatus: 'Asserted',
    observedBy: typeof ext[PERF_EXT.observedBy] === 'string' ? ext[PERF_EXT.observedBy] as string : undefined,
    rawDataLocation: rawDataLocationFor(rec, lrsEndpoint),
  };
}

// ── Competency synthesis ────────────────────────────────────────────

interface CompetencyDraft {
  label: string;
  framework?: string;
  credentialEvidence: string[];
  trainingEvidence: string[];
  performanceEvidence: string[];
  performanceSuccess: number;
  /** Executions that carried an ASSERTED outcome (success true or false) — the
   *  denominator for the success rate, so result-less executions don't read 0%. */
  performanceAssessed: number;
  performanceQualitySum: number;
  performanceQualityCount: number;
}

/** A semantic type IRI's local name is a meaningful label (e.g. cg#Finding →
 *  "Finding", urn:iep:type:ttt:Move → "Move") — UNLIKE an instance graph_iri's
 *  leaf token (…:g4:move:1 → "1"), which is what the competency builder used to
 *  key off, producing junk labels and cross-instance collapse. */
function typeLocalName(typeIri: string): string {
  const afterSlashHash = typeIri.split(/[#/]/).pop() ?? typeIri;
  const local = afterSlashHash.includes(':') ? afterSlashHash.split(':').pop()! : afterSlashHash;
  return local || typeIri;
}

/** PROTOCOL-ENVELOPE types are NOT skills. A competency keyed off a cg facet
 *  (Temporal, Provenance, …) , an authorship/proof shape (SignedAuthorship), or
 *  the AssertedContext fallback presents proof-block metadata as skill inference
 *  — johnny's category-error finding (the same activity splits across buckets by
 *  which facet its descriptor carried). The mesh projector reads ONLY the protocol
 *  envelope, so when the activity type is one of these it has no domain signal and
 *  must emit NOTHING rather than manufacture a facet-competency. A genuine domain
 *  activity type (iep:Finding, ttt:Move, a substrate-verification activity, …) keyed
 *  via richer conformsTo/object.definition.type at the PUBLISHING layer passes. */
// Protocol-envelope FACETS/proofs + GENERIC fallback task types — none of these
// names a domain skill, so none may key a competency. AssertedContext is the mesh
// fallback; ProductionTask is the generic type record_performance stamps (the real
// skill there is the caller's task_name, not this wrapper).
const PROTOCOL_ENVELOPE_TYPE_LOCALNAMES: ReadonlySet<string> = new Set([
  'AssertedContext', 'ProductionTask', 'SignedAuthorship', 'Affordance',
  'Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation', 'Structural',
  'TemporalFacet', 'ProvenanceFacet', 'AgentFacet', 'SemioticFacet', 'TrustFacet', 'FederationFacet', 'StructuralFacet',
]);
export function isDomainActivityType(typeIri?: string): boolean {
  if (!typeIri) return false;
  const local = typeLocalName(typeIri);
  if (PROTOCOL_ENVELOPE_TYPE_LOCALNAMES.has(local)) return false;
  if (isCredentialEnvelope(typeIri)) return false;
  if (/Facet$/.test(local)) return false;
  return true;
}

/** A held credential is an ACCOMPLISHMENT-grained artifact (surfaced via the CLR
 *  and rolling up to a basis=credential competency), NOT a performance EVENT. Its
 *  wallet-envelope descriptor (foxxi#CourseCompletionCredential / OpenBadgeCredential
 *  / WalletEnvelope / *Credential) must never be re-projected as a performanceRecord
 *  — that double-counts across the P2997 event-vs-accomplishment layers and infers a
 *  spurious competency from the envelope class (johnny's
 *  f-foxxi-competency-credential-envelope-type). */
const CREDENTIAL_ENVELOPE_LOCALNAMES: ReadonlySet<string> = new Set([
  'CourseCompletionCredential', 'OpenBadgeCredential', 'AchievementCredential',
  'VerifiableCredential', 'WalletEnvelope', 'CompetencyAssertion',
]);
function isCredentialEnvelope(typeIri?: string): boolean {
  if (!typeIri) return false;
  const local = typeLocalName(typeIri);
  return CREDENTIAL_ENVELOPE_LOCALNAMES.has(local) || /Credential$/.test(local);
}

function buildCompetencies(
  clr: ClrEnvelope | null,
  experiences: readonly ElrExperience[],
  performance: readonly ElrPerformanceRecord[],
  assertingAgentDid: string,
  subjectDid: string,
  subjectPodUrl: string,
): ElrCompetency[] {
  const drafts = new Map<string, CompetencyDraft>();
  const draft = (label: string): CompetencyDraft => {
    const key = label.toLowerCase().trim();
    let d = drafts.get(key);
    if (!d) {
      d = { label, credentialEvidence: [], trainingEvidence: [], performanceEvidence: [], performanceSuccess: 0, performanceAssessed: 0, performanceQualitySum: 0, performanceQualityCount: 0 };
      drafts.set(key, d);
    }
    return d;
  };

  // Credentialed competencies — alignments on verified credentials.
  for (const entry of clr?.credentialEntries ?? []) {
    if (!entry.verified) continue;
    const subj = entry.credential.credentialSubject as {
      achievement?: { alignment?: Array<{ targetCode?: string; targetName?: string; targetFramework?: string }> };
    };
    for (const a of subj.achievement?.alignment ?? []) {
      const label = a.targetName ?? a.targetCode;
      if (!label) continue;
      const d = draft(label);
      d.credentialEvidence.push(entry.credential.id ?? entry.sourceDescriptor);
      if (a.targetFramework) d.framework = a.targetFramework;
    }
  }

  // Inferred competencies — mastery-verb training experiences.
  for (const exp of experiences) {
    if (!MASTERY_VERBS.has(exp.verb)) continue;
    const label = exp.activityName ?? exp.activityId.split(/[#/]/).pop() ?? exp.activityId;
    if (!label) continue;
    // Evidence is the DEREFERENCEABLE raw-data location (pod descriptor / LRS URL),
    // not the bare statement UUID — so ler:supportedByEvidence resolves.
    draft(label).trainingEvidence.push(exp.rawDataLocation);
  }

  // Performance-verified competencies — production `performed` records. The skill
  // identity is, in priority order: a genuine DOMAIN activity type (aggregates
  // same-type executions across instances) → else, for a DELIBERATELY-asserted
  // performance (record_performance: an explicit task_name + asserted success),
  // the task_name (the skill the caller named). A result-less record whose only
  // type is a protocol-envelope facet/generic fallback (an auto-projected context
  // descriptor) declares no skill → NO competency (johnny's category-error
  // finding: don't manufacture facet-as-skill). The instance leaf is evidence-only.
  for (const p of performance) {
    const domainTyped = isDomainActivityType(p.taskType);
    if (!domainTyped && p.success === undefined) continue;
    const d = draft(domainTyped ? typeLocalName(p.taskType!) : p.taskName);
    d.performanceEvidence.push(p.rawDataLocation);
    if (p.success === true) d.performanceSuccess += 1;
    if (p.success !== undefined) d.performanceAssessed += 1;
    if (typeof p.quality === 'number') { d.performanceQualitySum += p.quality; d.performanceQualityCount += 1; }
  }

  // Resolve each draft to a single competency at its strongest basis.
  const out: ElrCompetency[] = [];
  for (const d of drafts.values()) {
    const perfExec = d.performanceEvidence.length;
    const hasPerf = perfExec > 0 && d.performanceSuccess > 0;
    const hasCred = d.credentialEvidence.length > 0;
    const hasTraining = d.trainingEvidence.length > 0;

    const basis: CompetencyBasis = hasPerf ? 'performance' : hasCred ? 'credential' : 'inferred';
    const modalStatus: ElrModalStatus = (hasPerf || hasCred) ? 'Asserted' : 'Hypothetical';
    // Success rate is over ASSESSED executions (those with an asserted outcome),
    // not all executions — so result-less production records don't read as 0%.
    const successRate = d.performanceAssessed > 0 ? round2(d.performanceSuccess / d.performanceAssessed) : undefined;
    const avgQuality = d.performanceQualityCount > 0
      ? round2(d.performanceQualitySum / d.performanceQualityCount) : undefined;

    // Performance evidence supersedes a training-only inference.
    let supersedes: string | undefined;
    if (hasPerf && hasTraining && !hasCred) {
      supersedes = `training-inferred competency — superseded by ${d.performanceSuccess}/${d.performanceAssessed} successful production executions`;
    }

    // Run the PUBLISHED roll-up rule (tla:PerformanceProficiencyRollupRule): map
    // the evidence to a dereferenceable proficiency level + a Wilson-lower-bound
    // confidence. No hardcoded band, no "1 success = top level" — the level and
    // the confidence together carry the sample-size honesty.
    const prof = evaluateProficiency({
      basis,
      executions: d.performanceAssessed,
      successes: d.performanceSuccess,
      avgQuality,
      credentialCount: d.credentialEvidence.length,
    });
    const competencyDefIri = competencyIri(d.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48));
    const evidence = [...new Set([...d.performanceEvidence, ...d.credentialEvidence, ...d.trainingEvidence])];

    out.push({
      id: competencyDefIri,
      label: hasPerf ? `Demonstrated: ${d.label}` : hasCred ? d.label : `Inferred: ${d.label}`,
      modalStatus,
      basis,
      framework: d.framework,
      // A real ler:CompetencyAssertion node — validatable against /ns/ieee-ler.
      assertionType: `${LER_NS}CompetencyAssertion`,
      // A distinct per-assertion IRI (subject pod + competency slug) so two subjects'
      // assertions about the same competency are different nodes; subject is the learner.
      assertionId: `${subjectPodUrl.replace(/\/+$/, '')}/#assertion-${d.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`,
      subject: subjectDid,
      aboutCompetency: competencyDefIri,
      proficiencyLevel: prof.levelIri,
      proficiencyLabel: prof.levelLabel,
      proficiencyRank: prof.rank,
      confidence: prof.confidence,
      rolledUpBy: prof.ruleIri,
      assertingAgent: assertingAgentDid,
      evidence,
      evidenceSummary: {
        trainingCompletions: d.trainingEvidence.length,
        performanceExecutions: perfExec,
        performanceSuccessRate: successRate,
        performanceAvgQuality: avgQuality,
      },
      supersedes,
    });
  }
  return out;
}

function pickLang(m: Record<string, string> | undefined): string | undefined {
  if (!m) return undefined;
  return m['en'] ?? m['en-US'] ?? Object.values(m)[0];
}
function round2(n: number): number { return Math.round(n * 100) / 100; }
