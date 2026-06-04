/**
 * Foxxi credential issuer — real W3C Verifiable Credentials shaped as
 * Open Badges 3.0 + IMS CLR 2.0-compatible payloads, signed with the
 * substrate's existing Ed25519 + eddsa-jcs-2022 Data Integrity Proof
 * machinery, published to the learner's pod via the substrate's
 * publish() so the credential appears on the wallet side as a normal
 * pod descriptor.
 *
 * Composes:
 *   - applications/_shared/vc-jwt/data-integrity-jcs.ts (signing)
 *   - applications/_shared/vc-jwt/index.ts (did:key keypair derivation)
 *   - src/solid/client.ts publish() (pod write)
 *
 * No new crypto primitives. The Foxxi vertical only owns:
 *   - the achievement shape (course → completion criterion → cited slides)
 *   - the issuer identity binding (tenant operator's Ed25519 key,
 *     deterministically derived from FOXXI_ISSUER_KEY_SEED so a
 *     restart doesn't change the issuer DID)
 *   - the publish location (learner's pod, fxa:CourseCompletionCredential
 *     conformsTo tag for discovery)
 *
 * Standards reference:
 *   - W3C VC Data Model 2.0 (https://www.w3.org/TR/vc-data-model-2.0/)
 *   - W3C VC Data Integrity (https://www.w3.org/TR/vc-data-integrity/)
 *   - Open Badges 3.0 (https://www.imsglobal.org/spec/ob/v3p0/)
 *   - IMS CLR 2.0 (https://www.imsglobal.org/spec/clr/v2p0/)
 *   - IEEE 1484.20.1 RDCEO (proficiency level on competency assertions)
 */

import { ed25519 } from '@noble/curves/ed25519';
import {
  importDidKeyEd25519,
  type IssuerKeyPair,
} from '../../_shared/vc-jwt/index.js';
import {
  issueDataIntegrityProof,
  verifyDataIntegrityProof,
  type VerifiableCredentialJson,
} from '../../_shared/vc-jwt/data-integrity-jcs.js';
import {
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
import { createHash } from 'node:crypto';

const FXA = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';
const FXS = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';

export const CREDENTIAL_TYPES = {
  CourseCompletionCredential: `${FXA}CourseCompletionCredential` as IRI,
  CompetencyAssertion: `${FXA}CompetencyAssertion` as IRI,
} as const;

// W3C VC + Open Badges 3.0 contexts.
const OB3_CONTEXTS: readonly string[] = [
  'https://www.w3.org/ns/credentials/v2',
  'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json',
];

const CLR_CONTEXTS: readonly string[] = [
  'https://www.w3.org/ns/credentials/v2',
  'https://purl.imsglobal.org/spec/clr/v2p0/context-2.0.1.json',
];

// ── Issuer keypair (deterministic) ────────────────────────────

/**
 * Derive the tenant's issuer Ed25519 keypair from a seed. Same seed →
 * same did:key. The keypair signs every credential the tenant issues.
 * Operator rotates by changing the seed (which rotates the DID — needs
 * an explicit successor descriptor on the pod to maintain continuity).
 */
export async function deriveTenantIssuer(seed: string): Promise<IssuerKeyPair> {
  const priv = createHash('sha256').update(`foxxi-issuer-ed25519:${seed}`).digest();
  // Take 32 bytes as the Ed25519 secret seed.
  return importDidKeyEd25519(new Uint8Array(priv));
}

// ── OB3-shaped course-completion credential ──────────────────

export interface CourseCompletionSubject {
  /** Learner's stable DID (used as credentialSubject.id). For Foxxi demos this is the learner's WebID; production uses did:key / did:web. */
  learnerDid: string;
  learnerName?: string;
  /** Course identifier used by the tenant (e.g. `golf-explained`). */
  courseId: string;
  courseTitle: string;
  courseDescription?: string;
  /** Optional achievement IRI (defaults to a tenant-derived URN). */
  achievementId?: string;
  /** Free-text statement of the completion criterion (becomes Achievement.criteria.narrative). */
  criterionNarrative?: string;
  /** Optional skills / competencies the achievement attests. Each entry becomes an Achievement.alignment item. */
  alignedSkills?: ReadonlyArray<{
    targetCode: string;
    targetName: string;
    targetFramework?: string;
    targetFrameworkUrl?: string;
    proficiencyLevel?: 'Novice' | 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert';
  }>;
  /** Optional supporting evidence (e.g. cited slides from a Q&A turn). */
  evidence?: ReadonlyArray<{
    type: 'fxa:CitedSlide' | 'fxa:Assessment' | 'fxa:LearningExperience' | string;
    id: string;
    narrative?: string;
  }>;
  /** IRIs of the raw xAPI experience records (statement descriptors /
   *  statement-query URLs) this completion was derived from. They become
   *  `prov:wasDerivedFrom` on the credential descriptor AND
   *  `fxa:LearningExperience` evidence on the VC — so an auditor can walk
   *  from the credential back to the proctored events that earned it. */
  derivedFromExperiences?: readonly string[];
  /** Optional issuance/expiry control. */
  validFrom?: string;
  validUntil?: string;
}

export interface IssueCompletionArgs {
  subject: CourseCompletionSubject;
  /** Tenant DID used as the OB3 Profile id (often did:web:<tenant>). The issuer DID on the VC itself is the did:key derived from issuerSeed; both are reported on the VC. */
  tenantProfileDid: string;
  tenantProfileName: string;
  issuerSeed: string;
}

/**
 * Build the unsigned VC JSON. Public so callers can review/inspect
 * before signing (the substrate's signOrThrow pattern).
 */
export function buildCourseCompletionVc(args: IssueCompletionArgs, issuerDid: string): VerifiableCredentialJson {
  const now = new Date();
  const validFrom = args.subject.validFrom ?? now.toISOString();
  const achievementId = args.subject.achievementId
    ?? `urn:foxxi:achievement:${slugTenant(args.tenantProfileDid)}:${args.subject.courseId}`;

  const credentialId = `urn:foxxi:credential:${slugTenant(args.tenantProfileDid)}:${args.subject.courseId}:${args.subject.learnerDid.replace(/[^a-zA-Z0-9]/g, '-')}:${now.getTime()}`;

  const subject: Record<string, unknown> = {
    id: args.subject.learnerDid,
    type: ['AchievementSubject'],
    achievement: {
      id: achievementId,
      type: ['Achievement'],
      name: args.subject.courseTitle,
      ...(args.subject.courseDescription ? { description: args.subject.courseDescription } : {}),
      criteria: {
        narrative: args.subject.criterionNarrative
          ?? `Completed the ${args.subject.courseTitle} module within the tenant's Foxxi-tracked content.`,
      },
      ...(args.subject.alignedSkills && args.subject.alignedSkills.length > 0
        ? {
            alignment: args.subject.alignedSkills.map(s => ({
              type: ['Alignment'],
              targetCode: s.targetCode,
              targetName: s.targetName,
              ...(s.targetFramework ? { targetFramework: s.targetFramework } : {}),
              ...(s.targetFrameworkUrl ? { targetUrl: s.targetFrameworkUrl } : {}),
            })),
          }
        : {}),
    },
    ...(args.subject.learnerName ? { name: args.subject.learnerName } : {}),
  };

  // Evidence — explicit caller-supplied entries plus one
  // fxa:LearningExperience per derived-from xAPI experience, so the
  // earned-by-this-evidence chain is visible inside the VC itself.
  const evidenceEntries: Array<Record<string, unknown>> = [];
  for (const e of args.subject.evidence ?? []) {
    evidenceEntries.push({ id: e.id, type: [e.type], ...(e.narrative ? { narrative: e.narrative } : {}) });
  }
  for (const x of args.subject.derivedFromExperiences ?? []) {
    evidenceEntries.push({ id: x, type: ['fxa:LearningExperience'], narrative: 'Raw xAPI experience this completion was derived from.' });
  }
  if (evidenceEntries.length > 0) {
    (subject as Record<string, unknown>).evidence = evidenceEntries;
  }

  return {
    '@context': OB3_CONTEXTS,
    id: credentialId,
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
    issuer: issuerDid, // did:key (required to match issuer.did by substrate)
    validFrom,
    ...(args.subject.validUntil ? { validUntil: args.subject.validUntil } : {}),
    credentialSubject: subject,
  };
}

/**
 * Issue a signed Open Badges 3.0 credential for course completion +
 * publish it to the learner's pod. Returns the signed VC + publish
 * result.
 */
export async function issueCourseCompletionCredential(
  args: IssueCompletionArgs & {
    /** Learner's pod root URL where the credential will be published. */
    learnerPodUrl: string;
    /** Authenticated fetch (for cross-tenant publishes; falls back to anon). */
    fetch?: FetchFn;
  },
): Promise<{ vc: VerifiableCredentialJson; publishResult: PublishResult }> {
  const issuer = await deriveTenantIssuer(args.issuerSeed);
  const unsigned = buildCourseCompletionVc(args, issuer.did);
  const signed = issueDataIntegrityProof(unsigned, issuer);

  // Sanity-check round-trip: verify our own signature so a misconfigured
  // issuer never leaves the bridge silently.
  const verify = verifyDataIntegrityProof(signed);
  if (!verify.verified) {
    throw new Error(`issued credential failed self-verification: ${verify.reason}`);
  }

  // Publish to learner pod as a foxxi credential descriptor.
  const graphIri = `urn:foxxi:wallet:${slugTenant(args.tenantProfileDid)}:${args.subject.courseId}:${slugDid(args.subject.learnerDid)}:${Date.now()}` as IRI;
  const slug = `cred-${args.subject.courseId}-${slugDid(args.subject.learnerDid)}-${Date.now()}`;
  const descriptor = credentialDescriptorFor({
    graphIri,
    issuerDid: issuer.did,
    learnerDid: args.subject.learnerDid,
    derivedFrom: (args.subject.derivedFromExperiences ?? []).map(x => x as IRI),
  });
  const graphContent = wrapCredentialAsGraph(graphIri, signed);

  const publishResult = await publish(descriptor, graphContent, args.learnerPodUrl, {
    fetch: args.fetch,
    containerPath: 'foxxi-wallet/',
    descriptorSlug: slug,
    graphSlug: `${slug}-graph`,
  });

  return { vc: signed, publishResult };
}

function credentialDescriptorFor(args: {
  graphIri: IRI;
  issuerDid: string;
  learnerDid: string;
  /** xAPI experience IRIs this credential was derived from. */
  derivedFrom?: readonly IRI[];
}): ContextDescriptorData {
  const now = new Date().toISOString();
  return {
    id: `${args.graphIri}#descriptor` as IRI,
    describes: [args.graphIri],
    conformsTo: [CREDENTIAL_TYPES.CourseCompletionCredential],
    facets: [
      { type: 'Temporal', validFrom: now },
      {
        type: 'Provenance',
        wasAttributedTo: args.issuerDid as IRI,
        // prov:wasDerivedFrom the raw xAPI experiences — an auditor walks
        // from the credential back to the events that earned it.
        ...(args.derivedFrom && args.derivedFrom.length > 0
          ? { wasDerivedFrom: args.derivedFrom }
          : {}),
      },
      { type: 'Agent', assertingAgent: { identity: args.issuerDid as IRI } },
      { type: 'Semiotic', modalStatus: 'Asserted' },
    ],
  };
}

function wrapCredentialAsGraph(graphIri: IRI, signed: VerifiableCredentialJson): string {
  // Embed the signed VC JSON as a base64 literal inside a triple; same
  // pattern the tenant-publisher uses. Verifiers parse the literal,
  // run verifyDataIntegrityProof on the recovered JSON, and check
  // the issuer's did:key matches what the descriptor advertised.
  const json = JSON.stringify(signed);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  return `<${graphIri}> a <${CREDENTIAL_TYPES.CourseCompletionCredential}> ;
    <http://www.w3.org/ns/prov#wasAttributedTo> <${signed.issuer}> ;
    <http://purl.org/dc/terms/identifier> "${signed.id ?? ''}" ;
    <${FXS}bundleJson> "${b64}"^^<http://www.w3.org/2001/XMLSchema#base64Binary> .
`;
}

function slugTenant(did: string): string {
  return did.replace(/^did:/, '').replace(/[^a-zA-Z0-9.-]/g, '-');
}

function slugDid(did: string): string {
  // Stable slug from a DID/WebID for use in IRIs + filenames.
  return did.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 80);
}

// ── Public verify helper for client / regulator audit ────────

export function verifyCredentialJson(signed: VerifiableCredentialJson) {
  return verifyDataIntegrityProof(signed);
}
