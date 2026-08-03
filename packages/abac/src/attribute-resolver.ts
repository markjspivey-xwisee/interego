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

import type { IRI, ContextFacetData, ContextDescriptorData } from '@interego/core';
import type { AttributeGraph, AmtaTrustFacetData } from './types.js';

/**
 * Filter an attribute graph down to facets whose source descriptor
 * satisfies a predicate. The predicate is a function from
 * `(facet, sourceDescriptorId, sourceIndex)` to boolean. Useful for
 * sybil-resistant evaluation: filter attestations to only those
 * whose issuers themselves meet a trust threshold, so a flood of
 * fake attestations from low-trust issuers has no effect on the
 * decision.
 *
 * The caller supplies the map from source-descriptor-IRI to that
 * descriptor (or whatever predicate semantics they want). This keeps
 * the resolver pure — knowing WHICH descriptors should count is a
 * policy question, not a resolver question.
 */
export function filterAttributeGraph(
  graph: AttributeGraph,
  predicate: (facet: ContextFacetData, sourceDescriptorId: IRI) => boolean,
): AttributeGraph {
  const keptFacets: ContextFacetData[] = [];
  const keptSources = new Map<ContextFacetData, IRI>();
  for (const f of graph.facets) {
    const src = graph.sources.get(f);
    if (!src) continue;
    if (predicate(f, src)) {
      keptFacets.push(f);
      keptSources.set(f, src);
    }
  }
  return { subject: graph.subject, facets: keptFacets, sources: keptSources };
}

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

/**
 * ★ `.identity`, NOT `.agentIdentity`, AND THE DIFFERENCE WAS A DEAD CLAUSE.
 *
 * `agentIdentity` is the RDF predicate name (`iep:agentIdentity`, which
 * `@interego/core`'s serializer emits FROM this field); the TypeScript
 * property on `AgentDescription` has always been `identity`. The inline
 * `as { assertingAgent?: { agentIdentity?: IRI } }` this replaces asserted
 * a shape core does not have, so the read was permanently `undefined` and
 * `resolveAttributes`' clause (b) — "or the descriptor attributes a facet
 * to the subject via an AgentFacet" — never once matched. Only clause (a),
 * `describes.includes(subject)`, has ever contributed anything. Nothing was
 * red because "no Agent facet" and "Agent facet read through the wrong
 * property name" both answer `null` here. The same typo sat in three places
 * in `@interego/core`'s affordance engine; all four are fixed together.
 *
 * ★ TURNING CLAUSE (b) BACK ON WIDENS WHAT REACHES A POLICY DECISION, so say
 * what that means rather than leaving it implicit. A descriptor now
 * contributes ALL of its facets to a subject's attribute graph merely
 * because that subject is its asserting agent — including facets about
 * something else entirely. An agent can therefore feed its own
 * `trustLevel: 'CryptographicallyVerified'` Trust facet into its own
 * attribute graph by publishing any descriptor it signs. That is not new in
 * kind (clause (a) already admits a self-published descriptor that
 * `describes` the subject) and it is the documented design, but it means
 * `resolveAttributes` is an AGGREGATOR, not an authorization boundary.
 * Callers making an access decision must pass the result through
 * `filterAttributeGraph` with an issuer predicate first — see the
 * sybil-resistance tests in `tests/abac.test.ts`, which are the whole point
 * of that function existing.
 */
function agentIdentity(f: ContextFacetData): IRI | null {
  if (f.type !== 'Agent') return null;
  return f.assertingAgent?.identity ?? null;
}

/**
 * Extract a value from the attribute graph given a mini-SHACL-style
 * path. Supports predicates on every facet type the evaluator
 * understands: iep:modalStatus, iep:epistemicConfidence, iep:trustLevel,
 * iep:validFrom, iep:validUntil, iep:issuer, AMTA attestation axes, etc.
 *
 * Returns all matching values across the graph — property paths are
 * many-valued under RDF semantics.
 */
export function extractAttribute(graph: AttributeGraph, path: string): unknown[] {
  const out: unknown[] = [];
  for (const f of graph.facets) {
    // Semiotic
    if (path === 'iep:modalStatus' && f.type === 'Semiotic') out.push(f.modalStatus);
    if (path === 'iep:epistemicConfidence' && f.type === 'Semiotic') out.push(f.epistemicConfidence);
    if (path === 'iep:groundTruth' && f.type === 'Semiotic') out.push(f.groundTruth);
    if (path === 'iep:interpretationFrame' && f.type === 'Semiotic') out.push((f as { interpretationFrame?: string }).interpretationFrame);
    // Trust
    if (path === 'iep:trustLevel' && f.type === 'Trust') out.push(f.trustLevel);
    if (path === 'iep:issuer' && f.type === 'Trust') out.push(f.issuer);
    // Temporal
    if (path === 'iep:validFrom' && f.type === 'Temporal') out.push(f.validFrom);
    if (path === 'iep:validUntil' && f.type === 'Temporal') out.push(f.validUntil);
    // Agent
    // Same wrong property name as `agentIdentity()` above, with a sharper edge: this path
    // returned [] for EVERY graph, so a `{ path: 'iep:agentIdentity', … }` constraint could
    // never be satisfied. On a Permit policy that fails closed; on a DENY policy it fails
    // OPEN — the deny simply never applied. Both directions now work.
    if (path === 'iep:agentIdentity' && f.type === 'Agent') {
      const id = f.assertingAgent?.identity;
      if (id) out.push(id);
    }
    if (path === 'iep:onBehalfOf' && f.type === 'Agent') {
      if (f.onBehalfOf) out.push(f.onBehalfOf);
    }
    // Federation
    if (path === 'iep:origin' && f.type === 'Federation') out.push(f.origin);
    if (path === 'iep:storageEndpoint' && f.type === 'Federation') out.push(f.storageEndpoint);
    // AMTA-style attestation axis (e.g. amta:competence, amta:honesty).
    // Exposed on Trust facets that carry amta attributes as extensions.
    // Typed through `AmtaTrustFacetData` rather than an inline `as { amtaAxes?: … }`
    // so the shape this reader expects is the same declaration a writer can import.
    // The anonymous cast it replaces left writers guessing: `tests/abac.test.ts`
    // reproduced the field by hand and cast the result, and nothing tied the two ends
    // together well enough for a rename here to break there.
    if (path.startsWith('amta:') && f.type === 'Trust') {
      const axes = (f as AmtaTrustFacetData).amtaAxes;
      const axisName = path.slice('amta:'.length);
      if (axes && axisName in axes) out.push(axes[axisName]);
    }
  }
  return out.filter(v => v !== undefined && v !== null);
}
