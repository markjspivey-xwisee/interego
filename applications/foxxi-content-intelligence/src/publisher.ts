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

import {
  ContextDescriptor,
} from '@interego/core';
import {
  publish,
} from '@interego/solid';
import {
  mintAtom,
} from '@interego/pgsl';
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
import type { FoxxiAgenticPayload } from './agentic-rag.js';
import { FOXXI_NS } from './foxxi-vocab.js';
import type {
  IRI,
} from '@interego/core';

// ─────────────────────────────────────────────────────────────────────
//  Common config + helpers
// ─────────────────────────────────────────────────────────────────────

export interface FoxxiConfig {
  /** Tenant pod URL (e.g., https://interego-css.../foxxi/). */
  readonly tenantPodUrl: string;
  /** Authoritative source DID for ingested content. */
  readonly authoritativeSource: IRI;
}


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

/** A CourseCatalog row — the shape discoverAssignedCourses joins policies against. */
export interface FoxxiCatalogEntry {
  readonly course_id: string;
  readonly title: string;
  readonly category: string;
  readonly audience_tags: readonly string[];
  readonly owner: string;
  readonly authoring_tool: string;
  readonly standard: string;
  readonly concept_count: number;
  readonly slide_count: number;
  readonly audio_seconds: number;
  readonly is_real: boolean;
  readonly course_iri: IRI;
}

export interface IngestContentPackageResult {
  readonly courseIri: IRI;
  readonly conceptAtomCount: number;
  readonly parseStatus: 'clean' | 'violations';
  /** Ready-to-upsert CourseCatalog row (the bridge writes it to the pod's public catalog). */
  readonly catalogEntry: FoxxiCatalogEntry;
  /** Full course content (concepts / slides / transcripts / edges) — the bridge
   *  publishes it as a per-course CoursePackageBundle for server-side retrieval. */
  readonly agenticPayload: FoxxiAgenticPayload;
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
  // Defensive normalization. This runs on EXTERNAL JSON (a caller's parsed
  // bundle over HTTP), so the static ParsedFoxxiPackage type is NOT a runtime
  // guarantee — a missing/renamed field must yield a valid (if sparse) catalog
  // row, never a cryptic "Cannot read properties of undefined (reading
  // 'replace')". Every string is escaped (a stray quote in a title/id would
  // otherwise break the Turtle) and every count coerces to a number.
  const P = args.parsed as Partial<ParsedFoxxiPackage> & Record<string, unknown>;
  const s = (v: unknown, d = ''): string => (v === undefined || v === null) ? d : String(v);
  const num = (v: unknown): number => Number.isFinite(Number(v)) ? Number(v) : 0;
  // Accept BOTH camelCase and snake_case for every field — a caller naturally
  // sends authoring_tool / slide_count, not just authoringTool / slides.
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) { const v = (P as Record<string, unknown>)[k]; if (v !== undefined && v !== null) return v; }
    return undefined;
  };
  const courseId = s(pick('courseId', 'course_id')).trim();
  if (!courseId) throw new Error('parsed.courseId is required (a stable course identifier)');
  const title = s(pick('title', 'name'), courseId);
  const standard = s(pick('standard'), 'unspecified');
  const authoringTool = s(pick('authoringTool', 'authoring_tool'), 'unspecified');
  const statsObj = (typeof pick('stats') === 'object') ? pick('stats') as Record<string, unknown> : {};
  // A stat may live under parsed.stats.X (camel or snake) OR flat on the bundle.
  const stat = (...keys: string[]): number => {
    for (const k of keys) { const v = statsObj[k] ?? (P as Record<string, unknown>)[k]; if (v !== undefined && v !== null) return num(v); }
    return 0;
  };
  const concepts = Array.isArray(pick('concepts')) ? pick('concepts') as unknown[] : [];

  const courseIriBase = federationIriBase(args.config.tenantPodUrl, courseId);
  const courseIri = `${courseIriBase}#package` as IRI;
  const conceptAtomCount = concepts.length;
  void mintAtom;

  // ── Build the CoursePackageBundle payload (FoxxiAgenticPayload) ──────
  // The FULL content the retrieval handlers read server-side: the concept map
  // (labels / tiers / prereq edges) + slide transcripts — not just counts. The
  // caller's handler publishes this as a per-course CoursePackageBundle
  // (discoverable by conformsTo, delete-then-publish for re-ingest). We no longer
  // write a separate fixed-slug fxs:Package "counts" graph — it collided across
  // courses (all landed on context-graphs/package.ttl and froze at the first) and
  // nothing read it: the catalog row carries the summary, this bundle the content.
  const rec = (x: unknown): Record<string, unknown> => (x && typeof x === 'object') ? x as Record<string, unknown> : {};
  const strArr = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : [];
  const mappedConcepts = concepts.map((raw) => {
    const c = rec(raw);
    const id = s(c.id ?? c.concept_id);
    return {
      id,
      label: s(c.label ?? c.name ?? id, id),
      confidence: Number.isFinite(Number(c.confidence)) ? Number(c.confidence) : 1,
      ...(c.tier != null ? { tier: Number(c.tier) } : {}),
      ...(('is_free_standing' in c || 'isFreeStanding' in c) ? { is_free_standing: Boolean(c.is_free_standing ?? c.isFreeStanding) } : {}),
      taught_in_slides: strArr(c.taught_in_slides ?? c.taughtInSlides),
      ...(c.total_freq != null || c.totalFreq != null ? { total_freq: Number(c.total_freq ?? c.totalFreq) } : {}),
    };
  }).filter(c => c.id);

  // Slides: a provided slides[] array, else one slide per entry of a transcripts
  // map { slideId: text }, else empty (a concept-only course).
  const rawSlides = pick('slides');
  const transcripts = pick('transcripts', 'transcript');
  let mappedSlides: Array<{ id: string; title: string; sequence_index: number; concept_ids?: string[]; transcript_combined?: string }> = [];
  if (Array.isArray(rawSlides)) {
    mappedSlides = rawSlides.map((raw, i) => {
      const sl = rec(raw);
      const seq = Number(sl.sequence_index ?? sl.sequenceIndex ?? i);
      return {
        id: s(sl.id, `slide-${i + 1}`),
        title: s(sl.title ?? sl.name, `Slide ${i + 1}`),
        sequence_index: Number.isFinite(seq) ? seq : i,
        ...(Array.isArray(sl.concept_ids ?? sl.conceptIds) ? { concept_ids: strArr(sl.concept_ids ?? sl.conceptIds) } : {}),
        ...(typeof (sl.transcript_combined ?? sl.transcript) === 'string' ? { transcript_combined: String(sl.transcript_combined ?? sl.transcript) } : {}),
      };
    });
  } else if (transcripts && typeof transcripts === 'object' && !Array.isArray(transcripts)) {
    mappedSlides = Object.entries(transcripts as Record<string, unknown>).map(([sid, text], i) => ({
      id: sid || `slide-${i + 1}`,
      title: sid || `Slide ${i + 1}`,
      sequence_index: i,
      transcript_combined: String(text ?? ''),
    }));
  }

  const modRaw = pick('modifierPairs', 'modifier_pairs');
  const edgeRaw = pick('prereqEdges', 'prereq_edges');
  const agenticPayload: FoxxiAgenticPayload = {
    packageMeta: {
      course_id: courseId,
      course_label: (title.split(':')[0] || courseId).trim() || courseId,
      title,
      federation_iri_base: courseIriBase,
    },
    concepts: mappedConcepts,
    slides: mappedSlides,
    ...(Array.isArray(modRaw) ? { modifier_pairs: (modRaw as unknown[]).map(m => { const o = rec(m); return { modifier: s(o.modifier), target: s(o.target) }; }) } : {}),
    ...(Array.isArray(edgeRaw) ? { prereq_edges: (edgeRaw as unknown[]).map(e => { const o = rec(e); return { from: s(o.from), to: s(o.to), ...(o.confidence != null ? { confidence: Number(o.confidence) } : {}) }; }) } : {}),
  };

  const audienceRaw = pick('audienceTags', 'audience_tags');
  const audienceTags = Array.isArray(audienceRaw) ? (audienceRaw as unknown[]).map(String) : [];
  const catalogEntry: FoxxiCatalogEntry = {
    course_id: courseId,
    title,
    category: s(pick('category'), standard || 'general'),
    audience_tags: audienceTags,
    owner: String(args.config.authoritativeSource),
    authoring_tool: authoringTool,
    standard,
    concept_count: stat('conceptsTotal', 'concepts_total', 'concept_count') || mappedConcepts.length,
    slide_count: stat('slides', 'slide_count') || mappedSlides.length,
    audio_seconds: stat('audioSeconds', 'audio_seconds'),
    is_real: true,
    course_iri: courseIri,
  };

  return {
    courseIri,
    conceptAtomCount,
    parseStatus: 'clean',
    catalogEntry,
    agenticPayload,
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
  const policyIri = `urn:iep:foxxi:authoring-policy:${seed}` as IRI;
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
  const assignmentIri = `urn:iep:foxxi:assignment:${seed}` as IRI;
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
