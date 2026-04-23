/**
 * @module abac/attribute-resolver
 * @description Builds a subject's AttributeGraph by federating
 *   attributes from multiple sources: the subject's own descriptor,
 *   cited attestations, and reachable trust signals.
 *
 *   The resolver is a pure function over `(subject, availableFacets)`
 *   at this layer; in a production deployment it would additionally
 *   fetch cross-pod attestations via `src/solid/discovery.ts`. The
 *   evaluation contract is the same either way: return an
 *   `AttributeGraph` or fail.
 */

import type { IRI, ContextFacetData, ContextDescriptorData } from '../model/types.js';
import type { AttributeGraph } from './types.js';

/**
 * Build a subject's AttributeGraph from a pool of descriptors.
 * Every facet of every descriptor that is attributed to the subject
 * (either via AgentFacet or as the descriptor's `describes` IRI)
 * contributes to the graph. Each facet carries its source descriptor
 * so evaluator rules can inspect provenance if needed.
 *
 * This is the in-memory, non-federated form. For the cross-pod form,
 * pass descriptors fetched via `src/solid/discovery.ts`'s
 * `resolveIdentifier`.
 */
export function resolveAttributes(
  subject: IRI,
  descriptors: readonly ContextDescriptorData[],
): AttributeGraph {
  const facets: ContextFacetData[] = [];
  const sources = new Map<ContextFacetData, IRI>();

  for (const d of descriptors) {
    // A descriptor contributes to the subject's graph if either:
    //   (a) it describes the subject directly, or
    //   (b) it attributes any of its facets to the subject via
    //       an AgentFacet with assertingAgent === subject.
    const describesSubject = d.describes.includes(subject);
    const attributedToSubject = d.facets.some(
      f => f.type === 'Agent' && agentIdentity(f) === subject,
    );
    if (!describesSubject && !attributedToSubject) continue;
    for (const f of d.facets) {
      facets.push(f);
      sources.set(f, d.id);
    }
  }

  return { subject, facets, sources };
}

function agentIdentity(f: ContextFacetData): IRI | null {
  if (f.type !== 'Agent') return null;
  const agent = (f as { assertingAgent?: { agentIdentity?: IRI } }).assertingAgent;
  return agent?.agentIdentity ?? null;
}

/**
 * Extract a value from the attribute graph given a mini-SHACL-style
 * path. Supports predicates on every facet type the evaluator
 * understands: cg:modalStatus, cg:epistemicConfidence, cg:trustLevel,
 * cg:validFrom, cg:validUntil, cg:issuer, AMTA attestation axes, etc.
 *
 * Returns all matching values across the graph — property paths are
 * many-valued under RDF semantics.
 */
export function extractAttribute(graph: AttributeGraph, path: string): unknown[] {
  const out: unknown[] = [];
  for (const f of graph.facets) {
    // Semiotic
    if (path === 'cg:modalStatus' && f.type === 'Semiotic') out.push(f.modalStatus);
    if (path === 'cg:epistemicConfidence' && f.type === 'Semiotic') out.push(f.epistemicConfidence);
    if (path === 'cg:groundTruth' && f.type === 'Semiotic') out.push(f.groundTruth);
    if (path === 'cg:interpretationFrame' && f.type === 'Semiotic') out.push((f as { interpretationFrame?: string }).interpretationFrame);
    // Trust
    if (path === 'cg:trustLevel' && f.type === 'Trust') out.push(f.trustLevel);
    if (path === 'cg:issuer' && f.type === 'Trust') out.push(f.issuer);
    // Temporal
    if (path === 'cg:validFrom' && f.type === 'Temporal') out.push(f.validFrom);
    if (path === 'cg:validUntil' && f.type === 'Temporal') out.push(f.validUntil);
    // Agent
    if (path === 'cg:agentIdentity' && f.type === 'Agent') {
      const a = (f as { assertingAgent?: { agentIdentity?: string } }).assertingAgent;
      if (a?.agentIdentity) out.push(a.agentIdentity);
    }
    if (path === 'cg:onBehalfOf' && f.type === 'Agent') {
      const o = (f as { onBehalfOf?: string }).onBehalfOf;
      if (o) out.push(o);
    }
    // Federation
    if (path === 'cg:origin' && f.type === 'Federation') out.push(f.origin);
    if (path === 'cg:storageEndpoint' && f.type === 'Federation') out.push(f.storageEndpoint);
    // AMTA-style attestation axis (e.g. amta:competence, amta:honesty).
    // Exposed on Trust facets that carry amta attributes as extensions.
    if (path.startsWith('amta:') && f.type === 'Trust') {
      const axes = (f as { amtaAxes?: Record<string, number> }).amtaAxes;
      const axisName = path.slice('amta:'.length);
      if (axes && axisName in axes) out.push(axes[axisName]);
    }
  }
  return out.filter(v => v !== undefined && v !== null);
}
