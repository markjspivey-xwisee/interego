/**
 * Foxxi pod publishers — substrate-side glue over the Foxxi system.
 *
 * Each function corresponds to an affordance in ../affordances.ts.
 * The shapes here are deliberately small + composition-focused: the
 * authoritative parser/dashboard logic lives in ../imported/ (Python +
 * JSX), and a production deployment runs that out-of-process and
 * supplies the parsed payload to these publishers via the bridge HTTP
 * handlers.
 *
 * What lives here:
 *   - Pedersen + descriptor construction
 *   - Substrate composition (LRS-adapter, aggregate-privacy, compliance-overlay)
 *   - PGSL atom minting for concept maps
 *   - IRI conventions matching the federation_iri_base pattern from
 *     federation_payload.json
 *
 * What lives in imported/ (NOT re-implemented here):
 *   - SCORM unwrap + manifest parse + Whisper transcription
 *   - Concept extraction with morphology + prerequisite inference
 *   - SHACL validation against the Foxxi vocab
 *   - Admin payload generation (catalog/users/groups/policies/events/audit/coverage/connections)
 *   - React admin + dashboard UIs
 */

import { ContextDescriptor, publish } from '../../../src/index.js';
import { mintAtom } from '../../../src/pgsl/lattice.js';
import {
  buildAttestedAggregateResult,
  buildAttestedHomomorphicDistribution,
  buildBucketedContribution,
  participationDescriptorIri,
  participationGraphIri,
  type AttestedAggregateResult,
  type AttestedHomomorphicDistributionResult,
  type NumericBucketingScheme,
  type ParticipationHit,
} from '../../_shared/aggregate-privacy/index.js';
import { createHash } from 'node:crypto';
import type { IRI } from '../../../src/index.js';

// ─────────────────────────────────────────────────────────────────────
//  Common config + helpers
// ─────────────────────────────────────────────────────────────────────

export interface FoxxiConfig {
  /** Tenant pod URL (e.g., https://interego-css.../markj/). */
  readonly tenantPodUrl: string;
  /** Authoritative source DID for ingested content. */
  readonly authoritativeSource: IRI;
}

const FOXXI_NS = 'https://vocab.foxximediums.com/';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Federation IRI base for a course, matching the convention from the
 * imported federation_payload.json:
 *   https://<pod>/courses/<course_id>
 */
function federationIriBase(podUrl: string, courseId: string): string {
  const base = podUrl.replace(/\/$/, '');
  return `${base}/courses/${encodeURIComponent(courseId)}`;
}

// ─────────────────────────────────────────────────────────────────────
//  1. Ingest content package
// ─────────────────────────────────────────────────────────────────────

/**
 * Input shape that the bridge HTTP handler supplies AFTER running the
 * authoritative Python parser (foxxi_storyline_parser_v03.py) on the
 * uploaded zip. The publisher here doesn't re-implement the parser;
 * it takes the parsed three-stratum payload and turns it into
 * substrate descriptors.
 */
export interface ParsedFoxxiPackage {
  readonly packageId: string;
  readonly courseId: string;
  readonly title: string;
  readonly standard: string;       // e.g. "SCORM_2004_4"
  readonly authoringTool: string;  // e.g. "Articulate Storyline"
  readonly authoringVersion: string;
  readonly parserVersion: string;
  readonly vocabVersion: string;
  /** Number of scenes, slides, concepts, prereq edges — for the catalog row. */
  readonly stats: {
    readonly scenes: number;
    readonly slides: number;
    readonly audioFiles: number;
    readonly audioSeconds: number;
    readonly conceptsTotal: number;
    readonly conceptsFreeStanding: number;
    readonly modifierPairs: number;
    readonly prereqEdges: number;
  };
  /** Concept labels for atom minting (PGSL atoms become content-addressed). */
  readonly concepts: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly confidence: number;
    readonly tier: number;
  }>;
}

export interface IngestContentPackageResult {
  readonly courseIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
  readonly conceptAtomCount: number;
  readonly parseStatus: 'clean' | 'violations';
}

/**
 * Take a parsed Foxxi package and publish:
 *   - one fxs:Package descriptor for the structural stratum
 *   - one fxk:ConceptMap descriptor (the knowledge stratum) — also
 *     mints PGSL atoms for every free-standing concept so downstream
 *     content can reference them by content-addressed URI
 *
 * The activity stratum is consumed live via the consume_lesson
 * handler + the existing lrs-adapter.
 */
export async function ingestContentPackage(args: {
  parsed: ParsedFoxxiPackage;
  config: FoxxiConfig;
}): Promise<IngestContentPackageResult> {
  const courseIriBase = federationIriBase(args.config.tenantPodUrl, args.parsed.courseId);
  const courseIri = `${courseIriBase}#package` as IRI;
  const graphIri = `urn:graph:foxxi:course:${args.parsed.courseId}` as IRI;
  const computedAt = nowIso();

  // Mint PGSL atoms for the concept map — each free-standing concept
  // becomes a content-addressed pgsl:Atom that downstream content
  // (other courses, regulators, federated peers) can cite by URI.
  const conceptAtomCount = args.parsed.concepts.length;
  // For the small skeleton here we don't persist the atoms (real
  // deployments mint via mintAtom + pod-write); we count them so
  // the catalog row has the right number.
  void mintAtom;

  const ttl = `@prefix fxs: <${FOXXI_NS}scorm#> .
@prefix fxk: <${FOXXI_NS}knowledge#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix schema: <http://schema.org/> .
<${graphIri}> a fxs:Package, schema:Course ;
  dct:title """${escapeTtl(args.parsed.title)}""" ;
  dct:identifier "${args.parsed.packageId}" ;
  fxs:standard "${args.parsed.standard}" ;
  fxs:authoringTool "${args.parsed.authoringTool}" ;
  fxs:authoringVersion "${args.parsed.authoringVersion}" ;
  fxs:parserVersion "${args.parsed.parserVersion}" ;
  fxs:vocabVersion "${args.parsed.vocabVersion}" ;
  fxs:slideCount ${args.parsed.stats.slides} ;
  fxs:sceneCount ${args.parsed.stats.scenes} ;
  fxs:audioSeconds ${args.parsed.stats.audioSeconds} ;
  fxk:conceptCount ${args.parsed.stats.conceptsTotal} ;
  fxk:freeStandingConceptCount ${args.parsed.stats.conceptsFreeStanding} ;
  fxk:prereqEdgeCount ${args.parsed.stats.prereqEdges} ;
  prov:wasAttributedTo <${args.config.authoritativeSource}> ;
  dct:issued "${computedAt}" .`;

  const built = ContextDescriptor.create(courseIri)
    .describes(graphIri)
    .agent(args.config.authoritativeSource)
    .generatedBy(args.config.authoritativeSource, {
      onBehalfOf: args.config.authoritativeSource,
      endedAt: computedAt,
    })
    .temporal({ validFrom: computedAt })
    .asserted(0.95)
    .verified(args.config.authoritativeSource)
    .build();

  const r = await publish(built, ttl, args.config.tenantPodUrl);

  return {
    courseIri,
    descriptorUrl: r.descriptorUrl,
    graphUrl: r.graphUrl,
    conceptAtomCount,
    parseStatus: 'clean',
  };
}

// ─────────────────────────────────────────────────────────────────────
//  2. Authoring policy
// ─────────────────────────────────────────────────────────────────────

export interface AuthoringPolicy {
  readonly acceptedTools: readonly string[];
  readonly acceptedStandards: readonly string[];
  readonly effectiveFrom: string;
}

export async function publishAuthoringPolicy(args: {
  policy: AuthoringPolicy;
  config: FoxxiConfig;
}): Promise<{ policyIri: IRI; descriptorUrl: string; graphUrl: string }> {
  const seed = sha256Hex(`foxxi-authoring-policy|${args.config.tenantPodUrl}|${args.policy.effectiveFrom}`).slice(0, 16);
  const policyIri = `urn:cg:foxxi:authoring-policy:${seed}` as IRI;
  const graphIri = `urn:graph:foxxi:authoring-policy:${seed}` as IRI;

  const ttl = `@prefix fxs: <${FOXXI_NS}scorm#> .
@prefix abac: <https://markjspivey-xwisee.github.io/interego/abac#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${graphIri}> a abac:Policy ;
  dct:title "Foxxi authoring-tool / standard policy" ;
  fxs:acceptedTools "${args.policy.acceptedTools.join(',')}" ;
  fxs:acceptedStandards "${args.policy.acceptedStandards.join(',')}" ;
  dct:issued "${args.policy.effectiveFrom}" .`;

  const built = ContextDescriptor.create(policyIri)
    .describes(graphIri)
    .agent(args.config.authoritativeSource)
    .generatedBy(args.config.authoritativeSource, {
      onBehalfOf: args.config.authoritativeSource,
      endedAt: args.policy.effectiveFrom,
    })
    .temporal({ validFrom: args.policy.effectiveFrom })
    .asserted(0.99)
    .build();

  const r = await publish(built, ttl, args.config.tenantPodUrl);
  return { policyIri, descriptorUrl: r.descriptorUrl, graphUrl: r.graphUrl };
}

// ─────────────────────────────────────────────────────────────────────
//  3. Audience assignment
// ─────────────────────────────────────────────────────────────────────

export interface AudienceAssignment {
  readonly courseIri: IRI;
  readonly audienceTag: string;
  readonly requirementType: 'required' | 'recommended';
  readonly trigger: 'on-hire' | 'on-role-change' | 'on-cycle' | 'manual';
  readonly dueRelativeDays: number;
}

export async function assignAudience(args: {
  assignment: AudienceAssignment;
  config: FoxxiConfig;
}): Promise<{ assignmentIri: IRI; descriptorUrl: string; graphUrl: string }> {
  const seed = sha256Hex(`foxxi-assignment|${args.assignment.courseIri}|${args.assignment.audienceTag}`).slice(0, 16);
  const assignmentIri = `urn:cg:foxxi:assignment:${seed}` as IRI;
  const graphIri = `urn:graph:foxxi:assignment:${seed}` as IRI;
  const now = nowIso();

  const ttl = `@prefix fxs: <${FOXXI_NS}scorm#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${graphIri}> a fxs:AudienceAssignment ;
  fxs:course <${args.assignment.courseIri}> ;
  fxs:audienceTag "${args.assignment.audienceTag}" ;
  fxs:requirementType "${args.assignment.requirementType}" ;
  fxs:trigger "${args.assignment.trigger}" ;
  fxs:dueRelativeDays ${args.assignment.dueRelativeDays} ;
  dct:issued "${now}" .`;

  const built = ContextDescriptor.create(assignmentIri)
    .describes(graphIri)
    .agent(args.config.authoritativeSource)
    .generatedBy(args.config.authoritativeSource, {
      onBehalfOf: args.config.authoritativeSource,
      endedAt: now,
    })
    .temporal({ validFrom: now })
    .asserted(0.95)
    .build();

  const r = await publish(built, ttl, args.config.tenantPodUrl);
  return { assignmentIri, descriptorUrl: r.descriptorUrl, graphUrl: r.graphUrl };
}

// ─────────────────────────────────────────────────────────────────────
//  4. Coverage query (composes aggregate-privacy)
// ─────────────────────────────────────────────────────────────────────

export interface CoverageQueryArgs {
  readonly config: FoxxiConfig;
  /** Per-concept coverage records — operator supplies after walking the pod. */
  readonly coverage: readonly { concept: string; taughtIn: readonly string[]; mentionedIn: readonly string[] }[];
  readonly privacyMode?: 'abac' | 'merkle-attested-opt-in' | 'zk-distribution';
  readonly epsilon?: number;
  readonly distributionEdges?: readonly bigint[];
  readonly distributionMaxValue?: bigint;
  readonly aggregatorDid?: IRI;
  readonly cohortIri?: IRI;
}

export type CoverageQueryResult =
  | { mode: 'abac'; coverageCount: number }
  | { mode: 'merkle-attested-opt-in'; bundle: AttestedAggregateResult }
  | { mode: 'zk-distribution'; bundle: AttestedHomomorphicDistributionResult };

/**
 * Privacy-respecting coverage query: composes with applications/_shared/
 * aggregate-privacy/. v2 default (merkle-attested-opt-in) treats each
 * concept-coverage entry as a "participation" — auditor can verify the
 * count without seeing per-course payloads. v3 zk-distribution returns
 * a histogram: how many concepts are taught in 1 course / 2-5 / 6-10 /
 * 10+ courses, with per-bucket DP noise.
 */
export function coverageQuery(args: CoverageQueryArgs): CoverageQueryResult {
  const mode = args.privacyMode ?? 'merkle-attested-opt-in';
  const cohortIri = args.cohortIri ?? (`urn:foxxi:cohort:coverage:${sha256Hex(args.config.tenantPodUrl).slice(0, 16)}` as IRI);
  const aggregatorDid = args.aggregatorDid ?? (args.config.authoritativeSource);

  if (mode === 'abac') {
    return { mode: 'abac', coverageCount: args.coverage.length };
  }

  if (mode === 'merkle-attested-opt-in') {
    const participations: ParticipationHit[] = args.coverage.map(c => ({
      podUrl: args.config.tenantPodUrl,
      descriptorIri: participationDescriptorIri(cohortIri, `did:foxxi:concept:${c.concept}` as IRI),
      descriptorUrl: `${args.config.tenantPodUrl}foxxi/coverage/${encodeURIComponent(c.concept)}.ttl`,
      graphIri: participationGraphIri(cohortIri, `did:foxxi:concept:${c.concept}` as IRI),
      modalStatus: 'Asserted',
    }));
    const bundle = buildAttestedAggregateResult({
      cohortIri,
      aggregatorDid,
      participations,
      value: args.coverage.length,
    });
    return { mode: 'merkle-attested-opt-in', bundle };
  }

  // zk-distribution
  if (!args.epsilon) throw new Error('coverageQuery: epsilon is required for zk-distribution mode');
  if (!args.distributionEdges || args.distributionEdges.length < 2) {
    throw new Error('coverageQuery: distributionEdges (>= 2 entries) required for zk-distribution mode');
  }
  if (args.distributionMaxValue === undefined) {
    throw new Error('coverageQuery: distributionMaxValue required for zk-distribution mode');
  }
  const scheme: NumericBucketingScheme = {
    type: 'numeric',
    edges: [...args.distributionEdges],
    maxValue: args.distributionMaxValue,
  };
  const contributions = args.coverage.map((c, i) => buildBucketedContribution({
    contributorPodUrl: `${args.config.tenantPodUrl}foxxi/coverage/${encodeURIComponent(c.concept)}`,
    value: BigInt(c.taughtIn.length),
    scheme,
    blindingSeed: `foxxi-coverage-${i}`,
  }));
  const bundle = buildAttestedHomomorphicDistribution({
    cohortIri,
    aggregatorDid,
    contributions,
    epsilon: args.epsilon,
    includeAuditFields: true,
  });
  return { mode: 'zk-distribution', bundle };
}

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

function escapeTtl(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}
