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
 *                      experience alone (Hypothetical — cg:modalStatus
 *                      keeps the prediction honest).
 *   provenance   ← P2997's hallmark: every entry points back to where its
 *                  raw record lives.
 *
 * ACTOR-AGNOSTIC. The subject is a `cg:Agent` identified by a DID — it
 * may be a human learner/performer OR an AI agent learning + exercising
 * tools. `subjectKind` records which; the data shape is identical. An
 * agent's ELR is its capability record; a human's is their learner +
 * employment record. Same machinery.
 *
 * Pure read. No writes.
 */

import { exportClr, type ClrEnvelope } from './clr.js';
import type { StoredStatement } from './statement-store.js';

const ELR_CONTEXT = [
  'https://www.w3.org/ns/credentials/v2',
  'https://standards.ieee.org/ieee/2997/', // IEEE P2997 ELR
] as const;

const ADL = 'http://adlnet.gov/expapi/verbs/';
const FOXXI_VOCAB = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';
/** Verbs that imply the subject demonstrated something (→ inferred competency). */
const MASTERY_VERBS = new Set([`${ADL}passed`, `${ADL}completed`, `${ADL}mastered`]);
/** The verb a `performed` production-work statement carries. */
export const PERFORMED_VERB = `${FOXXI_VOCAB}performed`;
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
  success: boolean;
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
  proficiencyLevel?: string;
  /** IRIs/ids of the experiences, performance records, or credential. */
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
    const verb = s.verb as { id?: string; display?: Record<string, string> } | undefined;
    if (verb?.id === PERFORMED_VERB) {
      performanceRecords.push(projectPerformance(rec, config.lrsEndpoint));
    } else {
      experiences.push(projectExperience(rec, config.lrsEndpoint));
    }
  }

  // 3. Competencies — merge three provenance-distinct sources, keyed by a
  //    normalised label so performance evidence can supersede a weaker
  //    training inference for the same competency.
  const competencies = buildCompetencies(clr, experiences, performanceRecords);

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

  const perfSuccess = performanceRecords.filter(p => p.success).length;

  return {
    '@context': ELR_CONTEXT,
    type: ['VerifiablePresentation', 'EnterpriseLearnerRecord'],
    id: `urn:foxxi:elr:${slugDid(config.learnerDid)}:${Date.now()}`,
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
      performanceSuccessRate: performanceRecords.length > 0
        ? round2(perfSuccess / performanceRecords.length) : undefined,
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
    rawDataLocation: `${lrsEndpoint}/xapi/statements?statementId=${rec.id}`,
  };
}

function projectPerformance(rec: StoredStatement, lrsEndpoint: string): ElrPerformanceRecord {
  const s = rec.statement;
  const obj = s.object as { id?: string; definition?: { name?: Record<string, string> } } | undefined;
  const result = s.result as { success?: boolean; score?: { scaled?: number }; duration?: string } | undefined;
  const ext = (s.context as { extensions?: Record<string, unknown> } | undefined)?.extensions ?? {};
  const cost = ext[PERF_EXT.costUsd];
  return {
    id: rec.id,
    taskId: obj?.id ?? '',
    taskName: pickLang(obj?.definition?.name) ?? obj?.id?.split(/[#/]/).pop() ?? obj?.id ?? 'task',
    success: result?.success ?? false,
    quality: typeof result?.score?.scaled === 'number' ? result.score.scaled : undefined,
    durationIso: result?.duration,
    costUsd: typeof cost === 'number' ? cost : undefined,
    timestamp: (s.timestamp as string | undefined) ?? rec.stored,
    modalStatus: 'Asserted',
    observedBy: typeof ext[PERF_EXT.observedBy] === 'string' ? ext[PERF_EXT.observedBy] as string : undefined,
    rawDataLocation: `${lrsEndpoint}/xapi/statements?statementId=${rec.id}`,
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
  performanceQualitySum: number;
  performanceQualityCount: number;
}

function buildCompetencies(
  clr: ClrEnvelope | null,
  experiences: readonly ElrExperience[],
  performance: readonly ElrPerformanceRecord[],
): ElrCompetency[] {
  const drafts = new Map<string, CompetencyDraft>();
  const draft = (label: string): CompetencyDraft => {
    const key = label.toLowerCase().trim();
    let d = drafts.get(key);
    if (!d) {
      d = { label, credentialEvidence: [], trainingEvidence: [], performanceEvidence: [], performanceSuccess: 0, performanceQualitySum: 0, performanceQualityCount: 0 };
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
    draft(label).trainingEvidence.push(exp.id);
  }

  // Performance-verified competencies — production `performed` records.
  for (const p of performance) {
    const d = draft(p.taskName);
    d.performanceEvidence.push(p.id);
    if (p.success) d.performanceSuccess += 1;
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
    const successRate = perfExec > 0 ? round2(d.performanceSuccess / perfExec) : undefined;
    const avgQuality = d.performanceQualityCount > 0
      ? round2(d.performanceQualitySum / d.performanceQualityCount) : undefined;

    // Performance evidence supersedes a training-only inference.
    let supersedes: string | undefined;
    if (hasPerf && hasTraining && !hasCred) {
      supersedes = `training-inferred competency — superseded by ${d.performanceSuccess}/${perfExec} successful production executions`;
    }

    out.push({
      id: `urn:foxxi:competency:${d.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`,
      label: hasPerf ? `Demonstrated: ${d.label}` : hasCred ? d.label : `Inferred: ${d.label}`,
      modalStatus,
      basis,
      framework: d.framework,
      evidence: [...d.performanceEvidence, ...d.credentialEvidence, ...d.trainingEvidence],
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
function slugDid(did: string): string {
  return did.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 80);
}
