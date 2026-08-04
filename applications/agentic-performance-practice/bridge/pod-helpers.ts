/**
 * agp bridge — pod round-trip helpers for the REAL diagnose/plan handlers.
 *
 * Boundary discipline (audit finding): the engine lives canonically in
 * agp/src/performance-architecture.ts; this module composes it + @interego/solid
 * for persistence. It does NOT import from foxxi-content-intelligence — the
 * dependency arrow is foxxi → agp only (Foxxi re-exports the agp engine via its
 * shim). The coercers below are agp-native (minimal), not borrowed from Foxxi.
 *
 * Honesty contract: a handler returns a real engine result. It persists a
 * descriptor to a pod when a pod_url is configured (best-effort), and reports
 * persisted:false (descriptorUrl:null) when it cannot — never a fabricated URL.
 */
import { createHash } from 'node:crypto';
import { type IRI, type ContextDescriptorData, type ContextFacetData } from '@interego/core';
import { publish, PublishShapeViolationError } from '@interego/solid';
import { readShapesTurtle, AGP_SHAPES_NS } from '../src/ontology.js';
import type { PerformanceSituation, Diagnosis, InterventionPlan } from '../src/performance-architecture.js';

const AGP = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#';

/** Deterministic, idempotent IRI (same inputs → same IRI), so repeat calls
 *  don't mint a new node each time. */
export function deterministicIri(prefix: string, seed: string): IRI {
  return `urn:agp:${prefix}:${createHash('sha256').update(seed).digest('hex').slice(0, 16)}` as IRI;
}

/** Minimal coercion of an inline JSON object into a PerformanceSituation.
 *  Returns null if the required fields are absent (the handler then degrades). */
export function coerceSituation(raw: unknown): PerformanceSituation | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!s.id || !s.workContext || !s.competency || !s.observed) return null;
  const perf = (s.performer ?? {}) as Record<string, unknown>;
  const freq = ['continuous', 'frequent', 'occasional', 'rare'];
  const crit = ['low', 'moderate', 'high', 'safety-critical'];
  return {
    id: String(s.id),
    performer: { id: String(perf.id ?? 'urn:agp:performer:anon'), kind: perf.kind === 'human' ? 'human' : 'agent', role: perf.role ? String(perf.role) : undefined },
    workContext: String(s.workContext),
    competency: String(s.competency),
    observed: String(s.observed),
    frequency: (freq.includes(String(s.frequency)) ? s.frequency : 'occasional') as PerformanceSituation['frequency'],
    criticality: (crit.includes(String(s.criticality)) ? s.criticality : 'moderate') as PerformanceSituation['criticality'],
    modalStatus: (s.modalStatus === 'Asserted' || s.modalStatus === 'Counterfactual' ? s.modalStatus : 'Hypothetical') as PerformanceSituation['modalStatus'],
    provenance: String(s.provenance ?? 'inline'),
    ...(s.domain ? { domain: s.domain as PerformanceSituation['domain'] } : {}),
  };
}

/** Minimal coercion of an inline JSON object into a Diagnosis. */
export function coerceDiagnosis(raw: unknown): Diagnosis | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (!d.situationId || !d.method || !d.regimeSource) return null;
  return d as unknown as Diagnosis;
}

/** Minimal coercion of an inline JSON object into an InterventionPlan, for the
 *  evaluate-intervention path. Returns null when the two fields evaluateIntervention
 *  actually dereferences (`diagnosis`, `selected`) are absent — the handler then
 *  degrades honestly rather than crashing inside the engine. */
export function coercePlan(raw: unknown): InterventionPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!p.diagnosis || !Array.isArray(p.selected)) return null;
  return p as unknown as InterventionPlan;
}

/** Best-effort GET of an IRI as JSON from a pod (for the situation_iri/diagnosis_iri
 *  path). Returns null on any failure — the handler degrades to inline-only. */
export async function fetchJson(iri: string, podUrl?: string, fetchFn: typeof fetch = globalThis.fetch): Promise<unknown | null> {
  try {
    const url = iri.startsWith('http') ? iri : (podUrl ? new URL(iri.replace(/^urn:[^:]+:/, ''), podUrl).toString() : null);
    if (!url) return null;
    const r = await fetchFn(url, { headers: { accept: 'application/json, application/ld+json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** A domain triple the artifact MUST carry. agp-shapes.ttl makes these
 *  mandatory for six of the seven publishable classes; a publisher that
 *  cannot emit them can only emit invalid nodes. */
export interface AgpProperty {
  readonly predicate: string;
  readonly object: { readonly iri: string } | { readonly literal: string };
}

/**
 * ★ TURTLE INJECTION POSITION. situation_iri / capability_iri / affordance_iri /
 * requires_capability_iri are CALLER-SUPPLIED and land inside `<...>`. A value
 * containing `>` closes the term and everything after it parses as further
 * triples — a caller could add agp:composedOf to a capability it does not own.
 *
 * This is the RFC3987 IRIREF exclusion set: U+0000..U+0020 plus < > " { } | ^ `
 * and backslash. Anything outside it is REFUSED, never escaped — an
 * escaped-but-nonsense IRI is a silent wrong answer, and this repo has already
 * been bitten by Turtle injection in three separate positions.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_IRI_CHAR = /[\x00-\x20<>"{}|^`\\]/;

function iriTerm(iri: string): string {
  if (iri.length === 0 || UNSAFE_IRI_CHAR.test(iri)) {
    throw new Error(`publishAgpArtifact: refusing to serialize an unsafe IRI (Turtle injection position): ${JSON.stringify(iri).slice(0, 120)}`);
  }
  return `<${iri}>`;
}

/** Best-effort REAL publish of an agp artifact as a signed-authorship-free
 *  ContextDescriptor + a graph carrying the domain triples its class's SHACL
 *  shape requires. Returns the descriptor URL on success, null on a TRANSPORT
 *  failure (caller reports persisted:false). A shape violation is RE-THROWN. */
export async function publishAgpArtifact(args: {
  iri: IRI; typeIri: string; label: string; podUrl: string;
  author?: { id: string; kind: 'human' | 'agent'; role?: string };
  containerPath?: string; slug: string; fetchFn?: typeof fetch;
  /** Domain triples the class's SHACL shape requires. Omitting them is a
   *  defect, not a degradation — the gate below refuses the write. */
  properties?: ReadonlyArray<AgpProperty>;
}): Promise<string | null> {
  // Built OUTSIDE the try: an unsafe IRI is a caller defect and must throw,
  // not be reported as a pod outage.
  const graphIri = `${args.iri}#graph` as IRI;
  const triples = [
    `a ${iriTerm(args.typeIri)}`,
    `<http://www.w3.org/2000/01/rdf-schema#label> ${JSON.stringify(args.label)}`,
    ...(args.properties ?? []).map(p => `${iriTerm(p.predicate)} ${'iri' in p.object ? iriTerm(p.object.iri) : JSON.stringify(p.object.literal)}`),
  ];
  const graphContent = `${iriTerm(graphIri)} ${triples.join(' ;\n  ')} .\n`;
  try {
    const now = new Date().toISOString();
    const authorId = (args.author?.id ?? 'urn:agp:bridge:agent') as IRI;
    const facets: ContextFacetData[] = [
      { type: 'Temporal', validFrom: now },
      { type: 'Provenance', wasAttributedTo: authorId, generatedAtTime: now },
      { type: 'Agent', assertingAgent: { id: authorId, identity: authorId, isSoftwareAgent: (args.author?.kind ?? 'agent') === 'agent', ...(args.author?.role ? { label: args.author.role } : {}) } },
      { type: 'AccessControl', authorizations: [{ agentClass: 'http://xmlns.com/foaf/0.1/Agent' as IRI, mode: ['Read'] }] },
      { type: 'Semiotic', modalStatus: 'Asserted', groundTruth: true },
      { type: 'Trust', trustLevel: 'SelfAsserted', issuer: authorId },
    ] as ContextFacetData[];
    const descriptor: ContextDescriptorData = { id: args.iri, describes: [graphIri], facets, conformsTo: [args.typeIri as IRI], version: 1 };
    // ★ THE GATE THAT WAS NEVER ARMED. publish() has taken a conformsToShapes list
    // since the shape-gate work; this call never passed one, and this bridge writes
    // to the pod DIRECTLY rather than through the relay — so agp's own published
    // SHACL shapes were applied to agp's own writes zero times. MEASURED against
    // ontology/agp-shapes.ttl: the label-only graph this function used to emit fails
    // Diagnosis, PerformanceSituation, Capability, PerformanceAffordance,
    // Actualization and InterventionEvaluation, and agp.diagnose has been publishing
    // invalid agp:Diagnosis nodes for real.
    const r = await publish(descriptor, graphContent, args.podUrl, {
      fetch: args.fetchFn ?? globalThis.fetch.bind(globalThis),
      containerPath: args.containerPath ?? 'agp/work-products/',
      descriptorSlug: args.slug,
      graphSlug: `${args.slug}-graph`,
      conformsToShapes: [{ shapeIri: AGP_SHAPES_NS, shapeTurtle: readShapesTurtle() }],
    } as Parameters<typeof publish>[3]);
    return (r as { descriptorUrl?: string })?.descriptorUrl ?? null;
  } catch (err) {
    // A shape violation is a defect IN THIS BRIDGE, not a pod outage. Degrading it
    // to persisted:false is exactly how the invalid Diagnosis nodes stayed
    // invisible: a programming error and a network blip reported identically.
    // Only transport failures degrade.
    if (err instanceof PublishShapeViolationError) throw err;
    return null;
  }
}

export { AGP };
