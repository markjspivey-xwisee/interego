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
import { publish } from '@interego/solid';
import type { PerformanceSituation, Diagnosis } from '../src/performance-architecture.js';

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

/** Best-effort REAL publish of an agp artifact (Diagnosis / InterventionPlan) as a
 *  signed-authorship-free ContextDescriptor + minimal graph. Returns the descriptor
 *  URL on success, null on any failure (caller reports persisted:false). */
export async function publishAgpArtifact(args: {
  iri: IRI; typeIri: string; label: string; podUrl: string;
  author?: { id: string; kind: 'human' | 'agent'; role?: string };
  containerPath?: string; slug: string; fetchFn?: typeof fetch;
}): Promise<string | null> {
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
    const graphIri = `${args.iri}#graph` as IRI;
    const descriptor: ContextDescriptorData = { id: args.iri, describes: [graphIri], facets, conformsTo: [args.typeIri as IRI], version: 1 };
    const graphContent = `<${graphIri}> a <${args.typeIri}> ; <http://www.w3.org/2000/01/rdf-schema#label> ${JSON.stringify(args.label)} .\n`;
    const r = await publish(descriptor, graphContent, args.podUrl, {
      fetch: args.fetchFn ?? globalThis.fetch.bind(globalThis),
      containerPath: args.containerPath ?? 'agp/work-products/',
      descriptorSlug: args.slug,
      graphSlug: `${args.slug}-graph`,
    } as Parameters<typeof publish>[3]);
    return (r as { descriptorUrl?: string })?.descriptorUrl ?? null;
  } catch { return null; }
}

export { AGP };
