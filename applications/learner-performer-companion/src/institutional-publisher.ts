/**
 * Institutional-side publisher for the learner-performer-companion vertical.
 *
 * Implements the four enterprise edtech professional affordances
 * declared in `affordances.ts → lpcEnterpriseAffordances`:
 *
 *   - publish_authoritative_content    : institution publishes
 *                                        lpc:TrainingContent to its OWN pod
 *   - issue_cohort_credential_template : signed VC template (Open Badges
 *                                        3.0 / IMS CLR 2.0 / IEEE LERS)
 *   - aggregate_cohort_query           : counts / distributions over a cohort
 *   - project_to_lrs                   : wrap lrs-adapter; honor consent
 *
 * Dual-audience design (docs/DUAL-AUDIENCE.md): these are the
 * institutional counterparts to the learner-side publishers in
 * pod-publisher.ts. Institutional content lives on the institution's
 * OWN pod (NOT the learner's); learners' agents discover via federation
 * and pull selectively via the existing learner-side affordances.
 *
 * Aggregate query (v1): same shape as OWM operator-publisher's
 * aggregate functions — returns counts derived from the descriptors
 * the institution's ABAC scope permits reading. Full ZK aggregate-
 * privacy (spec/AGGREGATE-PRIVACY.md) is a v2.
 */

import {
  ContextDescriptor, publish, discover,
} from '../../../src/index.js';
import type { IRI } from '../../../src/index.js';
import { projectDescriptorToLrs } from '../../lrs-adapter/src/pod-publisher.js';
import {
  gatherParticipations, buildAttestedAggregateResult,
  type AttestedAggregateResult,
} from '../../_shared/aggregate-privacy/index.js';
import { createHash } from 'node:crypto';

const LPC_NS = 'https://markjspivey-xwisee.github.io/interego/applications/learner-performer-companion/lpc#';

function nowIso(): string { return new Date().toISOString(); }
function sha16(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16); }
function escapeLit(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

export interface InstitutionCtx {
  /** Pod URL of the publishing institution. */
  readonly institutionPodUrl: string;
  /** DID of the institution's authoritative signing key. */
  readonly issuerDid: IRI;
}

// ── publish_authoritative_content ────────────────────────────────────

export interface PublishAuthoritativeContentArgs {
  /** Stable IRI naming the content (e.g., a SCORM activity or TLA LAP entry). */
  content_iri: string;
  /** Human-readable name. */
  title: string;
  /** Optional one-paragraph summary; surfaces to learners' agents. */
  description?: string;
  /** Optional list of learning-objective strings the content covers. */
  learning_objectives?: readonly string[];
  /** Optional ADL TLA LAP catalog metadata; opaque object surfaced verbatim. */
  tla_lap_metadata?: Record<string, unknown>;
  /** Optional content URL (where learners actually launch the content). */
  launch_url?: string;
  /** Optional content format (SCORM 1.2 / SCORM 2004 / cmi5 / pdf / video / tla-lap-entry). */
  format?: string;
}

export interface PublishAuthoritativeContentResult {
  readonly contentIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
  readonly issuerDid: IRI;
  readonly objectiveIris: readonly IRI[];
}

export async function publishAuthoritativeContent(
  args: PublishAuthoritativeContentArgs,
  ctx: InstitutionCtx,
): Promise<PublishAuthoritativeContentResult> {
  if (!args.content_iri) throw new Error('content_iri is required');
  if (!args.title?.trim()) throw new Error('title is required');

  const contentIri = args.content_iri as IRI;
  const graphIri = `urn:graph:lpc:authoritative-content:${sha16(contentIri)}` as IRI;

  const objectiveIris: IRI[] = (args.learning_objectives ?? []).map(
    (_, i) => `${contentIri}#objective-${i + 1}` as IRI,
  );

  const objectivesTtl = (args.learning_objectives ?? []).map((obj, i) => `
<${objectiveIris[i]}> a lpc:LearningObjective ;
  dct:description """${escapeLit(obj)}""" ;
  lpc:objectiveOf <${contentIri}> .`).join('');

  const tlaMetaTtl = args.tla_lap_metadata
    ? `\n<${contentIri}> lpc:tlaLapMetadata """${escapeLit(JSON.stringify(args.tla_lap_metadata))}""" .`
    : '';

  const ttl = `@prefix lpc: <${LPC_NS}> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
<${contentIri}> a lpc:TrainingContent ;
  dct:title "${escapeLit(args.title)}" ;
${args.description ? `  dct:description """${escapeLit(args.description)}""" ;\n` : ''}\
${args.format ? `  lpc:contentFormat "${escapeLit(args.format)}" ;\n` : ''}\
${args.launch_url ? `  lpc:launchUrl <${args.launch_url}> ;\n` : ''}\
  prov:wasAttributedTo <${ctx.issuerDid}> ;
  dct:issued "${nowIso()}" .${objectivesTtl}${tlaMetaTtl}`;

  const built = ContextDescriptor.create(contentIri)
    .describes(graphIri)
    .agent(ctx.issuerDid)
    .generatedBy(ctx.issuerDid, { onBehalfOf: ctx.issuerDid, endedAt: nowIso() })
    .temporal({ validFrom: nowIso() })
    .asserted(0.95)
    .verified(ctx.issuerDid)
    .build();

  const r = await publish(built, ttl, ctx.institutionPodUrl);
  return {
    contentIri,
    descriptorUrl: r.descriptorUrl,
    graphUrl: r.graphUrl,
    issuerDid: ctx.issuerDid,
    objectiveIris,
  };
}

// ── issue_cohort_credential_template ─────────────────────────────────

export interface IssueCohortCredentialTemplateArgs {
  cohort_iri: string;
  credential_format: 'open-badges-3.0' | 'ims-clr-2.0' | 'ieee-lers';
  /** W3C VC credentialSubject template; learner DID substituted on acceptance. */
  credential_subject_template: Record<string, unknown>;
  /** Optional achievement name (defaults from credential_subject_template.achievement.name). */
  achievement_name?: string;
}

export interface IssueCohortCredentialTemplateResult {
  readonly templateIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
  readonly cohortIri: string;
  readonly credentialFormat: string;
  readonly issuerDid: IRI;
}

export async function issueCohortCredentialTemplate(
  args: IssueCohortCredentialTemplateArgs,
  ctx: InstitutionCtx,
): Promise<IssueCohortCredentialTemplateResult> {
  if (!args.cohort_iri) throw new Error('cohort_iri is required');
  if (!args.credential_format) throw new Error('credential_format is required');
  if (!args.credential_subject_template || typeof args.credential_subject_template !== 'object') {
    throw new Error('credential_subject_template must be an object');
  }

  // Content-stable: same cohort + same template yields same templateIri,
  // so re-publishing updates supersedes the prior version via publish().
  const canon = JSON.stringify(args.credential_subject_template, Object.keys(args.credential_subject_template).sort());
  const templateIri = `urn:lpc:credential-template:${sha16(`${args.cohort_iri}|${args.credential_format}|${canon}`)}` as IRI;
  const graphIri = `urn:graph:lpc:credential-template:${sha16(`${args.cohort_iri}|${args.credential_format}`)}` as IRI;

  // Achievement name: prefer the explicit arg, otherwise dig out
  // credentialSubject.achievement.name (the common OB3/CLR shape).
  let achievementName = args.achievement_name;
  if (!achievementName) {
    const ach = (args.credential_subject_template['achievement'] ?? {}) as Record<string, unknown>;
    if (typeof ach['name'] === 'string') achievementName = ach['name'];
  }

  const ttl = `@prefix lpc: <${LPC_NS}> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
<${templateIri}> a lpc:CredentialTemplate ;
  lpc:cohort <${args.cohort_iri}> ;
  lpc:credentialFormat "${args.credential_format}" ;
${achievementName ? `  dct:title "${escapeLit(achievementName)}" ;\n` : ''}\
  lpc:credentialSubjectTemplate """${escapeLit(JSON.stringify(args.credential_subject_template))}""" ;
  prov:wasAttributedTo <${ctx.issuerDid}> ;
  dct:issued "${nowIso()}" .`;

  const built = ContextDescriptor.create(templateIri)
    .describes(graphIri)
    .agent(ctx.issuerDid)
    .generatedBy(ctx.issuerDid, { onBehalfOf: ctx.issuerDid, endedAt: nowIso() })
    .temporal({ validFrom: nowIso() })
    .asserted(0.95)
    .verified(ctx.issuerDid)
    .build();

  const r = await publish(built, ttl, ctx.institutionPodUrl);
  return {
    templateIri,
    descriptorUrl: r.descriptorUrl,
    graphUrl: r.graphUrl,
    cohortIri: args.cohort_iri,
    credentialFormat: args.credential_format,
    issuerDid: ctx.issuerDid,
  };
}

// ── aggregate_cohort_query ───────────────────────────────────────────

export interface AggregateCohortQueryArgs {
  cohort_iri: string;
  metric: 'completion-count' | 'score-distribution' | 'competency-threshold-met' | 'credential-coverage';
  predicate?: Record<string, unknown>;
  /** Pods to walk; the institution names the candidate set, but v2 filters down to those that have published a CohortParticipation descriptor. */
  learner_pods?: readonly string[];
  /**
   * Privacy mode. Default `'abac'` (v1: ABAC-bounded count over the
   * supplied learner_pods). When set to `'merkle-attested-opt-in'`
   * (v2): only learner pods that have published a signed
   * CohortParticipation descriptor for this cohort_iri are included,
   * and the response is an AttestedAggregateResult bundle with a
   * Merkle root + per-pod inclusion proofs that any auditor can
   * verify. Bilateral by construction — the learner opts IN; the
   * aggregator cannot inflate the count.
   */
  privacy_mode?: 'abac' | 'merkle-attested-opt-in';
}

export interface AggregateCohortQueryResult {
  readonly cohortIri: string;
  readonly metric: AggregateCohortQueryArgs['metric'];
  readonly value: number | Record<string, number>;
  readonly sampleSize: number;
  readonly privacyMode: 'abac' | 'merkle-attested-opt-in' | 'zk-aggregate';
  /** Present when privacyMode = 'merkle-attested-opt-in'. */
  readonly attestation?: AttestedAggregateResult;
}

export async function aggregateCohortQuery(
  args: AggregateCohortQueryArgs,
  ctx: InstitutionCtx,
): Promise<AggregateCohortQueryResult> {
  if (!args.cohort_iri) throw new Error('cohort_iri is required');
  if (!args.metric) throw new Error('metric is required');
  const mode = args.privacy_mode ?? 'abac';

  // v2 path: filter the candidate learner_pods down to those that
  // have explicitly opted in via a CohortParticipation descriptor.
  // The aggregator cannot include a pod that has not opted in; the
  // result bundle includes a Merkle root + per-pod inclusion proofs.
  let pods: readonly string[];
  let attestation: AttestedAggregateResult | undefined;
  if (mode === 'merkle-attested-opt-in') {
    const candidatePods = args.learner_pods ?? [];
    if (candidatePods.length === 0) {
      // No candidate pods supplied — opt-in mode with zero candidates
      // produces a zero-count Merkle attestation honestly.
      const empty = buildAttestedAggregateResult({
        cohortIri: args.cohort_iri as IRI,
        aggregatorDid: ctx.issuerDid,
        participations: [],
        value: 0,
      });
      return {
        cohortIri: args.cohort_iri,
        metric: args.metric,
        value: 0,
        sampleSize: 0,
        privacyMode: 'merkle-attested-opt-in',
        attestation: empty,
      };
    }
    const participations = await gatherParticipations(args.cohort_iri as IRI, candidatePods);
    pods = participations.map(p => p.podUrl);
    // We'll fill in `attestation` after computing the metric value
    // below so it carries the same `value` field as the top-level
    // result.
    attestation = buildAttestedAggregateResult({
      cohortIri: args.cohort_iri as IRI,
      aggregatorDid: ctx.issuerDid,
      participations,
      value: 0, // placeholder; replaced after metric computation
    });
  } else {
    // v1 ABAC path: walk every supplied pod (and the institution's
    // own). No opt-in filtering. Result is a count derived from
    // whatever descriptors the operator's ABAC scope permits reading.
    pods = [ctx.institutionPodUrl, ...(args.learner_pods ?? [])];
  }
  const all: Array<{ podUrl: string; entry: Awaited<ReturnType<typeof discover>>[number] }> = [];
  for (const podUrl of pods) {
    try {
      const entries = await discover(podUrl);
      for (const entry of entries) all.push({ podUrl, entry });
    } catch {
      // unreachable pod contributes nothing; aggregate explicitly says
      // "over consenting learners", so unreachable = non-consenting
    }
  }

  const cohortRelated = all.filter(({ entry }) =>
    entry.describes.some(d => d.includes(args.cohort_iri)) ||
    entry.descriptorUrl.includes(args.cohort_iri.replace(/[^a-zA-Z0-9-]/g, '-'))
  );

  let value: number | Record<string, number>;
  let sampleSize: number;
  switch (args.metric) {
    case 'completion-count': {
      const completions = cohortRelated.filter(({ entry }) =>
        entry.describes.some(d => d.startsWith('urn:lpc:learning-experience:'))
      );
      // Distinct learners (pod hosts) who have ANY completion in cohort scope.
      const learners = new Set<string>();
      for (const { podUrl } of completions) learners.add(podUrl);
      sampleSize = learners.size;
      value = sampleSize;
      break;
    }
    case 'credential-coverage': {
      const creds = cohortRelated.filter(({ entry }) =>
        entry.describes.some(d => d.startsWith('urn:lpc:credential:'))
      );
      const learners = new Set<string>();
      for (const { podUrl } of creds) learners.add(podUrl);
      sampleSize = learners.size;
      value = sampleSize;
      break;
    }
    case 'score-distribution': {
      // v1: bucket entries by their podUrl host; the score itself
      // lives in the graph payload (out of scope for manifest-level
      // aggregation). Returns count per learner-pod as a proxy. v2:
      // ZK range proofs over the actual score atoms.
      const counts: Record<string, number> = {};
      for (const { podUrl } of cohortRelated) {
        let host = podUrl;
        try { host = new URL(podUrl).host; } catch { /* fall through */ }
        counts[host] = (counts[host] ?? 0) + 1;
      }
      sampleSize = Object.keys(counts).length;
      value = counts;
      break;
    }
    case 'competency-threshold-met': {
      // v1: count distinct credentials in cohort scope (a credential
      // is evidence that a competency threshold was met). v2: ZK
      // range proof over performance-record scores against the
      // predicate threshold.
      const creds = cohortRelated.filter(({ entry }) =>
        entry.describes.some(d => d.startsWith('urn:lpc:credential:'))
      );
      const learners = new Set<string>();
      for (const { podUrl } of creds) learners.add(podUrl);
      sampleSize = learners.size;
      value = sampleSize;
      break;
    }
  }

  // Rebuild the attestation with the actual computed value so the
  // bundle's `value` matches the top-level result. (We had to compute
  // the metric to know `value`; the participations were already
  // gathered above.)
  if (mode === 'merkle-attested-opt-in' && attestation) {
    attestation = {
      ...attestation,
      value,
    };
  }

  return {
    cohortIri: args.cohort_iri,
    metric: args.metric,
    value,
    sampleSize,
    privacyMode: mode === 'merkle-attested-opt-in' ? 'merkle-attested-opt-in' : 'abac',
    ...(attestation ? { attestation } : {}),
  };
}

// ── project_to_lrs ───────────────────────────────────────────────────

export interface ProjectToLrsArgs {
  /** IRI of the lpc:LearningExperience descriptor to project. */
  descriptor_iri: string;
  /** LRS Statements endpoint (e.g. https://cloud.scorm.com/lrs/<APP>/sandbox/statements). */
  target_lrs_url: string;
  /** Basic auth username (xAPI activity-provider key). */
  lrs_username: string;
  /** Basic auth password (xAPI activity-provider secret). */
  lrs_password: string;
  /** IRI of a consent descriptor on the learner's pod authorizing this projection. */
  learner_consent_descriptor_iri: string;
  /** Pod URL hosting the learner's lpc:LearningExperience descriptor. */
  learner_pod_url: string;
  /** Learner's DID — used as the xAPI actor on the projected Statement. */
  learner_did: string;
  /** xAPI verb IRI (e.g. http://adlnet.gov/expapi/verbs/completed). */
  verb_id: string;
  /** xAPI object IRI (typically the lpc:TrainingContent IRI). */
  object_id: string;
  /** Optional verb display string. */
  verb_display?: string;
  /** Optional object name string. */
  object_name?: string;
  /** Modal status of the source descriptor; lrs-adapter skips Counterfactual unconditionally and Hypothetical without opt-in. */
  modal_status?: 'Asserted' | 'Hypothetical' | 'Counterfactual';
  /** If source is Hypothetical, set true to project anyway with audit-loud lossy markers. */
  allow_hypothetical?: boolean;
}

export interface ProjectToLrsResult {
  readonly descriptorIri: string;
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly statementId?: string;
  readonly lossy: boolean;
  readonly lossNotes: readonly string[];
  readonly xapiVersion: string;
  readonly consentDescriptor: string;
}

export async function projectToLrs(
  args: ProjectToLrsArgs,
  _ctx: InstitutionCtx,
): Promise<ProjectToLrsResult> {
  if (!args.descriptor_iri) throw new Error('descriptor_iri is required');
  if (!args.target_lrs_url) throw new Error('target_lrs_url is required');
  if (!args.lrs_username || !args.lrs_password) throw new Error('lrs_username + lrs_password are required');
  if (!args.learner_consent_descriptor_iri) throw new Error('learner_consent_descriptor_iri is required');
  if (!args.learner_pod_url) throw new Error('learner_pod_url is required');
  if (!args.learner_did) throw new Error('learner_did is required (xAPI actor)');
  if (!args.verb_id || !args.object_id) throw new Error('verb_id + object_id are required');

  // Honor the consent descriptor: it must exist on the learner's pod
  // and reference the descriptor being projected. v1 enforcement is
  // discovery-based — the consent descriptor MUST appear in the
  // learner's pod manifest. v2 should verify the consent descriptor's
  // signature against the learner's DID.
  const learnerEntries = await discover(args.learner_pod_url);
  const consent = learnerEntries.find(e =>
    e.descriptorUrl === args.learner_consent_descriptor_iri ||
    e.describes.includes(args.learner_consent_descriptor_iri as IRI)
  );
  if (!consent) {
    throw new Error(`No consent descriptor at ${args.learner_consent_descriptor_iri} on ${args.learner_pod_url} — refusing projection.`);
  }

  // Delegate to the existing lrs-adapter boundary translator. The
  // pod-config is the LEARNER's (the audit-skip path writes back to
  // the learner's pod, not the institution's, because the skip is
  // about the learner's descriptor).
  const result = await projectDescriptorToLrs(
    {
      endpoint: args.target_lrs_url,
      auth: { username: args.lrs_username, password: args.lrs_password },
    },
    {
      descriptorIri: args.descriptor_iri as IRI,
      actor: { objectType: 'Agent', account: { homePage: 'https://interego.example', name: args.learner_did } },
      verbId: args.verb_id,
      objectId: args.object_id,
      ...(args.verb_display !== undefined ? { verbDisplay: args.verb_display } : {}),
      ...(args.object_name !== undefined ? { objectName: args.object_name } : {}),
      ...(args.modal_status !== undefined ? { modalStatus: args.modal_status } : {}),
      ...(args.allow_hypothetical !== undefined ? { allowHypothetical: args.allow_hypothetical } : {}),
    },
    {
      podUrl: args.learner_pod_url,
      userDid: args.learner_did as IRI,
    },
  );

  return {
    descriptorIri: args.descriptor_iri,
    skipped: result.skipped,
    ...(result.skipReason !== undefined ? { skipReason: result.skipReason } : {}),
    ...(result.statementId !== undefined ? { statementId: result.statementId } : {}),
    lossy: result.lossy,
    lossNotes: result.lossNotes,
    xapiVersion: result.xapiVersion,
    consentDescriptor: args.learner_consent_descriptor_iri,
  };
}
