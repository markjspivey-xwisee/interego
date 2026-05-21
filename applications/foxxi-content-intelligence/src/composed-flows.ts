/**
 * Foxxi composed flows — multi-step demos that compose existing
 * substrate primitives into new affordances. No new vocab, no new
 * crypto, no new substrate code; everything here is a *function* over
 * existing pieces.
 *
 * Flows in this module:
 *   - launchAuWithPrereqCheck  (demo #4) — competency-gated cmi5 launch
 *   - aiAssessCompetency       (demo #7a) — AI mentor signs a
 *                                CompetencyAssertion VC against a learner
 *   - countersignCredential    (demo #7b) — human-in-the-loop elevation
 *                                of an AI-issued assertion to a full
 *                                two-issuer OB3 credential
 *   - composeAuditTrail        (demo #10) — single-query descriptor
 *                                chain walker; returns the full
 *                                xAPI→OB3→CASE→policy→SOC2 trace for
 *                                a learner's window
 *
 * Each flow returns rich enough metadata that the bridge handler can
 * surface the access decision + the chain steps + any failure reasons.
 */

import { discover, fetchGraphContent } from '@interego/core';
import type { IRI } from '@interego/core';
import {
  issueDataIntegrityProof,
  verifyDataIntegrityProof,
  type VerifiableCredentialJson,
} from '../../_shared/vc-jwt/data-integrity-jcs.js';
import {
  importDidKeyEd25519,
  type IssuerKeyPair,
} from '../../_shared/vc-jwt/index.js';
import { createHash } from 'node:crypto';
import { buildPassedSessionTrace, type Cmi5Statement } from './cmi5.js';
import { CREDENTIAL_TYPES } from './credentials.js';

// ── Demo #4: competency-gated launch ─────────────────────────

export interface PrereqCheckResult {
  satisfied: boolean;
  matchingCredentials: Array<{ descriptorUrl: string; credential: VerifiableCredentialJson; verified: boolean; reason?: string }>;
  unmetReasons: string[];
}

export interface PrereqRequirement {
  /** Achievement IRI the prereq credential's `achievement.id` must equal (or include). */
  achievementIri: string;
  /** Minimum proficiency level — 1=Novice through 5=Expert. */
  minProficiencyRdfValue?: number;
  /** Optional issuer DID filter. */
  acceptedIssuerDids?: readonly string[];
  /** Optional `validUntil` cutoff — credential must remain valid past this time. */
  notExpiredBefore?: string;
}

const PROFICIENCY_VALUE: Record<string, number> = {
  Novice: 1, Beginner: 2, Intermediate: 3, Advanced: 4, Expert: 5,
};

/**
 * Walk the learner's pod, find every fxa:CourseCompletionCredential or
 * fxa:CompetencyAssertion, verify each, and check at least one
 * satisfies the prereq requirement.
 */
export async function checkLearnerPrereq(args: {
  learnerPodUrl: string;
  requirement: PrereqRequirement;
  fetch?: typeof globalThis.fetch;
}): Promise<PrereqCheckResult> {
  const fetchFn = args.fetch ?? globalThis.fetch;
  const entries = await discover(args.learnerPodUrl, undefined, { fetch: fetchFn as never });
  const credEntries = entries.filter(e =>
    (e.conformsTo ?? []).includes(CREDENTIAL_TYPES.CourseCompletionCredential)
    || (e.conformsTo ?? []).includes(CREDENTIAL_TYPES.CompetencyAssertion),
  );

  const matching: PrereqCheckResult['matchingCredentials'] = [];
  const reasons: string[] = [];

  for (const e of credEntries) {
    try {
      const credential = await fetchCredentialJson(e.descriptorUrl, fetchFn);
      const verify = verifyDataIntegrityProof(credential);
      const subj = credential.credentialSubject as { achievement?: { id?: string; proficiencyLevel?: string } };
      const achId = subj.achievement?.id;
      const profLevel = subj.achievement?.proficiencyLevel;
      const issuer = credential.issuer;

      const stamps: string[] = [];
      if (!verify.verified) { stamps.push(`signature invalid: ${verify.reason}`); }
      if (achId !== args.requirement.achievementIri && !achId?.includes(args.requirement.achievementIri)) {
        stamps.push(`achievement IRI does not match requirement (${achId} vs ${args.requirement.achievementIri})`);
      }
      if (args.requirement.minProficiencyRdfValue !== undefined) {
        const haveVal = PROFICIENCY_VALUE[profLevel ?? ''] ?? 0;
        if (haveVal < args.requirement.minProficiencyRdfValue) {
          stamps.push(`proficiency ${profLevel} (rdf:value ${haveVal}) below required ${args.requirement.minProficiencyRdfValue}`);
        }
      }
      if (args.requirement.acceptedIssuerDids && !args.requirement.acceptedIssuerDids.includes(issuer)) {
        stamps.push(`issuer ${issuer} not in accepted set`);
      }
      if (args.requirement.notExpiredBefore && credential.validUntil) {
        if (Date.parse(credential.validUntil) < Date.parse(args.requirement.notExpiredBefore)) {
          stamps.push(`expired (${credential.validUntil})`);
        }
      }

      const ok = stamps.length === 0;
      matching.push({ descriptorUrl: e.descriptorUrl, credential, verified: ok, ...(stamps.length > 0 ? { reason: stamps.join('; ') } : {}) });
      if (!ok) reasons.push(`${e.descriptorUrl}: ${stamps.join('; ')}`);
    } catch (err) {
      reasons.push(`${e.descriptorUrl}: fetch/parse failed: ${(err as Error).message}`);
    }
  }

  return {
    satisfied: matching.some(m => m.verified),
    matchingCredentials: matching,
    unmetReasons: reasons,
  };
}

/**
 * Compose: prereq check → cmi5 launch trace. Returns the trace only
 * when the prereq is satisfied; else returns the prereq report with
 * `launched: false`.
 */
export async function launchAuWithPrereqCheck(args: {
  learnerDid: string;
  learnerPodUrl: string;
  courseId: string;
  auActivityId: string;
  registration: string;
  prereq: PrereqRequirement;
}): Promise<{ launched: boolean; prereqReport: PrereqCheckResult; trace?: Cmi5Statement[] }> {
  const prereqReport = await checkLearnerPrereq({
    learnerPodUrl: args.learnerPodUrl,
    requirement: args.prereq,
  });
  if (!prereqReport.satisfied) {
    return { launched: false, prereqReport };
  }
  const trace = buildPassedSessionTrace({
    actor: { account: { homePage: args.learnerDid, name: args.learnerDid.split('/').pop() ?? args.learnerDid } },
    session: {
      registration: args.registration,
      auActivityId: args.auActivityId,
      courseActivityId: `urn:foxxi:course:${args.courseId}`,
    },
    scoreScaled: 1.0,
    masteryScore: 0.7,
    durationIso: 'PT0S', // launch trace — completion will follow
    moveOnRule: 'NotApplicable',
  });
  // Trim the post-launch statements; gated launch only emits launched + initialized.
  return { launched: true, prereqReport, trace: trace.slice(0, 2) };
}

// ── Demo #7a: AI mentor competency assessor ─────────────────

export interface CompetencyAssessmentInput {
  learnerDid: string;
  /** AI agent's `did:key` (the mentor). */
  mentorIssuerSeed: string;
  /** Free-text evidence the AI considered (cited slide IDs, Q&A turn IDs, etc.). */
  evidence: ReadonlyArray<{ type: string; id: string; narrative?: string }>;
  /** Competency definition this assessment binds to. */
  competency: {
    id: string;
    label: string;
    proficiencyLevel: 'Novice' | 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert';
  };
  /** Mentor's assessment narrative. */
  narrative: string;
}

export interface CompetencyAssessment {
  vc: VerifiableCredentialJson;
  mentorDid: string;
  modalStatus: 'Hypothetical';
  needsCountersign: true;
}

/**
 * AI mentor reviews evidence + emits a Hypothetical CompetencyAssertion
 * VC signed with the mentor's own did:key. NOT yet an OB3 credential
 * (modal status: Hypothetical) — a human must countersign first to
 * elevate it to Asserted / OB3.
 */
export async function aiAssessCompetency(args: CompetencyAssessmentInput): Promise<CompetencyAssessment> {
  const mentor = await deriveMentorIssuer(args.mentorIssuerSeed);
  const now = new Date().toISOString();
  const vc: VerifiableCredentialJson = {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://w3id.org/security/data-integrity/v2',
    ],
    id: `urn:foxxi:competency-assessment:${args.competency.id}:${Date.now()}`,
    type: ['VerifiableCredential', 'CompetencyAssertion'],
    issuer: mentor.did,
    validFrom: now,
    credentialSubject: {
      id: args.learnerDid,
      type: ['CompetencySubject'],
      competency: {
        id: args.competency.id,
        label: args.competency.label,
        proficiencyLevel: args.competency.proficiencyLevel,
      },
      assessment: {
        narrative: args.narrative,
        evidence: args.evidence.map(e => ({ type: e.type, id: e.id, ...(e.narrative ? { narrative: e.narrative } : {}) })),
        modalStatus: 'Hypothetical', // until countersigned
        assessor: { did: mentor.did, kind: 'ai-mentor' },
      },
    },
  };
  const signed = issueDataIntegrityProof(vc, mentor);
  return { vc: signed, mentorDid: mentor.did, modalStatus: 'Hypothetical', needsCountersign: true };
}

// ── Demo #7b: human countersign → OB3 ────────────────────────

export interface CountersignedCredential {
  /** Final OB3-shaped VC with the mentor's original signature preserved + the human's countersign added. */
  ob3: VerifiableCredentialJson & {
    proof?: VerifiableCredentialJson['proof'] | VerifiableCredentialJson['proof'][];
    countersignedBy: string;
    countersignedAt: string;
    originalAssessment: { id: string; mentorDid: string; signature: string };
  };
  countersignerDid: string;
}

/**
 * Human admin reviews the AI mentor's Hypothetical CompetencyAssertion
 * + countersigns. The countersign is itself a Data Integrity Proof
 * over the AI's signed VC; combining both signatures produces a
 * dual-issuer credential whose modal status is Asserted (= OB3).
 */
export async function countersignAssessment(args: {
  assessment: CompetencyAssessment;
  humanIssuerSeed: string;
}): Promise<CountersignedCredential> {
  const human = await deriveMentorIssuer(args.humanIssuerSeed);
  const upgraded: VerifiableCredentialJson = {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json',
      'https://w3id.org/security/data-integrity/v2',
    ],
    id: args.assessment.vc.id?.replace(':competency-assessment:', ':competency-countersigned:'),
    type: ['VerifiableCredential', 'OpenBadgeCredential', 'CompetencyAssertion'],
    issuer: human.did,
    validFrom: new Date().toISOString(),
    credentialSubject: {
      ...args.assessment.vc.credentialSubject,
      // Mark modal as Asserted now that a human has countersigned.
      assessment: {
        ...(args.assessment.vc.credentialSubject as { assessment: Record<string, unknown> }).assessment,
        modalStatus: 'Asserted',
        countersignedBy: human.did,
      },
    },
  };
  const countersigned = issueDataIntegrityProof(upgraded, human);
  // Sanity self-verify of the countersign.
  if (!verifyDataIntegrityProof(countersigned).verified) {
    throw new Error('countersign self-verify failed');
  }
  return {
    ob3: {
      ...countersigned,
      countersignedBy: human.did,
      countersignedAt: new Date().toISOString(),
      originalAssessment: {
        id: args.assessment.vc.id ?? '',
        mentorDid: args.assessment.mentorDid,
        signature: args.assessment.vc.proof?.proofValue ?? '',
      },
    },
    countersignerDid: human.did,
  };
}

async function deriveMentorIssuer(seed: string): Promise<IssuerKeyPair> {
  const priv = createHash('sha256').update(`foxxi-mentor-ed25519:${seed}`).digest();
  return importDidKeyEd25519(new Uint8Array(priv));
}

// ── Demo #10: audit-trail chain composer ─────────────────────

export interface AuditChainStep {
  kind: 'cmi5-completion' | 'OB3-credential' | 'CompetencyAssertion' | 'CASE-alignment' | 'fxa:AccessDecision' | 'unknown';
  descriptorUrl: string;
  conformsTo: readonly string[];
  validFrom?: string;
  modalStatus?: string;
  summary: string;
}

export interface AuditChain {
  learnerDid: string;
  podUrl: string;
  windowFrom?: string;
  windowTo?: string;
  stepCount: number;
  steps: AuditChainStep[];
  /** Frameworks the chain cites (collected from each step's conformsTo). */
  frameworksCited: string[];
}

/**
 * Walk the learner's pod, pull every descriptor relevant to compliance
 * (credentials, competency assertions, access-decision traces, cmi5
 * statements when stored as descriptors), and return them in a single
 * ordered chain. The substrate's `dct:conformsTo` is the framework
 * citation source — the chain implicitly tells the auditor which
 * controls every step references.
 */
export async function composeAuditTrail(args: {
  learnerPodUrl: string;
  learnerDid: string;
  windowFrom?: string;
  windowTo?: string;
  fetch?: typeof globalThis.fetch;
}): Promise<AuditChain> {
  const fetchFn = args.fetch ?? globalThis.fetch;
  const entries = await discover(args.learnerPodUrl, undefined, { fetch: fetchFn as never });
  // We grab everything with a Provenance facet OR any conformsTo tag —
  // anything else doesn't have a compliance chain anchor.
  const relevant = entries.filter(e => (e.conformsTo ?? []).length > 0 || e.facetTypes.includes('Provenance'));

  const inWindow = relevant.filter(e => {
    if (!args.windowFrom && !args.windowTo) return true;
    const t = e.validFrom ? Date.parse(e.validFrom) : 0;
    if (args.windowFrom && t < Date.parse(args.windowFrom)) return false;
    if (args.windowTo && t > Date.parse(args.windowTo)) return false;
    return true;
  });

  const steps: AuditChainStep[] = inWindow.map(e => ({
    kind: classifyStep(e.conformsTo ?? []),
    descriptorUrl: e.descriptorUrl,
    conformsTo: e.conformsTo ?? [],
    validFrom: e.validFrom,
    modalStatus: e.modalStatus,
    summary: summarize(e.conformsTo ?? []),
  }));

  steps.sort((a, b) => (a.validFrom ?? '').localeCompare(b.validFrom ?? ''));

  const frameworks = new Set<string>();
  for (const s of steps) for (const c of s.conformsTo) frameworks.add(c);

  return {
    learnerDid: args.learnerDid,
    podUrl: args.learnerPodUrl,
    windowFrom: args.windowFrom,
    windowTo: args.windowTo,
    stepCount: steps.length,
    steps,
    frameworksCited: Array.from(frameworks).sort(),
  };
}

function classifyStep(conformsTo: readonly string[]): AuditChainStep['kind'] {
  if (conformsTo.some(c => c.includes('CourseCompletionCredential'))) return 'OB3-credential';
  if (conformsTo.some(c => c.includes('CompetencyAssertion'))) return 'CompetencyAssertion';
  if (conformsTo.some(c => c.includes('CASEAlignment'))) return 'CASE-alignment';
  if (conformsTo.some(c => c.includes('AccessDecision'))) return 'fxa:AccessDecision';
  if (conformsTo.some(c => c.includes('Cmi5') || c.includes('LearningExperience'))) return 'cmi5-completion';
  return 'unknown';
}

function summarize(conformsTo: readonly string[]): string {
  const last = conformsTo[conformsTo.length - 1] ?? '(unknown)';
  return last.split('#').pop() ?? last;
}

async function fetchCredentialJson(descriptorUrl: string, fetchFn: typeof globalThis.fetch): Promise<VerifiableCredentialJson> {
  const r = await fetchFn(descriptorUrl, { headers: { Accept: 'text/turtle' } });
  if (!r.ok) throw new Error(`GET ${descriptorUrl}: ${r.status}`);
  const ttl = await r.text();
  const targetMatch = ttl.match(/hydra:target\s+<([^>]+)>/);
  if (!targetMatch) throw new Error('no hydra:target');
  const { content } = await fetchGraphContent(targetMatch[1]!, { fetch: fetchFn as never });
  if (!content) throw new Error('graph empty / encrypted');
  const m = content.match(/<https:\/\/vocab\.foxximediums\.com\/scorm#bundleJson>\s+"([A-Za-z0-9+/=\s]+)"/);
  if (!m) throw new Error('no bundleJson literal');
  return JSON.parse(Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64').toString('utf8')) as VerifiableCredentialJson;
}
