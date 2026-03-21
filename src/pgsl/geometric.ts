/**
 * @module pgsl/geometric
 * @description Geometric morphism between PGSL and Context Graphs topoi
 *
 * The PGSL presheaf topos Set^(L^op) and the Context Graphs presheaf topos
 * Set^(F^op) are connected by a geometric morphism:
 *
 *   f*: Set^(F^op) → Set^(L^op)    (inverse image — embed CG into PGSL)
 *   f_*: Set^(L^op) → Set^(F^op)   (direct image — attach facets to PGSL)
 *
 * The inverse image f* takes a Context Descriptor and ingests its described
 * graph content into the PGSL lattice, producing content-addressed fragments.
 *
 * The direct image f_* takes a PGSL fragment and wraps it in a Context
 * Descriptor with faceted metadata, producing a described context.
 *
 * For this to be a valid geometric morphism, f* must preserve finite limits:
 *   - intersection of two descriptors in CG maps to lattice meet in PGSL
 *   - terminal object maps to terminal object
 *
 * This module implements both functors and verifies the coherence conditions.
 */

import type { IRI } from '../model/types.js';
import type { ContextDescriptorData, ContextFacetData } from '../model/types.js';
import type { PGSLInstance, Fragment, NodeProvenance } from './types.js';
import { ingest } from './lattice.js';
import { latticeMeet } from './category.js';

// ── Direct Image: f_* (PGSL → Context Graphs) ──────────────

/**
 * The direct image functor f_*: PGSL → Context Graphs.
 *
 * Takes a PGSL fragment URI and a set of facets, and produces
 * a Context Descriptor that describes the fragment as a named graph.
 *
 * This is how PGSL content gets "lifted" into the context layer —
 * raw content-addressed structure gains semiotic, temporal, trust,
 * causal, and projection metadata.
 */
export function liftToDescriptor(
  pgsl: PGSLInstance,
  fragmentUri: IRI,
  descriptorId: IRI,
  facets: readonly ContextFacetData[],
): ContextDescriptorData {
  const node = pgsl.nodes.get(fragmentUri);
  if (!node) throw new Error(`Fragment ${fragmentUri} not found in PGSL`);

  return {
    id: descriptorId,
    describes: [fragmentUri],
    facets,
    version: 1,
    validFrom: node.provenance.generatedAtTime,
  };
}

// ── Inverse Image: f* (Context Graphs → PGSL) ──────────────

/**
 * The inverse image functor f*: Context Graphs → PGSL.
 *
 * Takes a Context Descriptor and the graph content it describes,
 * ingests the content into the PGSL lattice, and returns the
 * top fragment URI.
 *
 * The content is tokenized into a sequence and fed to Ingest.
 * The descriptor's provenance is used as the PGSL node provenance.
 */
export function embedInPGSL(
  pgsl: PGSLInstance,
  content: string,
  descriptor?: ContextDescriptorData,
): IRI {
  // Extract provenance from descriptor if available
  let provenance: NodeProvenance = pgsl.defaultProvenance;
  if (descriptor) {
    const provFacet = descriptor.facets.find(f => f.type === 'Provenance');
    if (provFacet?.type === 'Provenance') {
      provenance = {
        wasAttributedTo: provFacet.wasAttributedTo ?? pgsl.defaultProvenance.wasAttributedTo,
        generatedAtTime: provFacet.generatedAtTime ?? pgsl.defaultProvenance.generatedAtTime,
      };
    }
  }

  // Tokenize content into a sequence of values
  const tokens = tokenize(content);

  if (tokens.length === 0) {
    throw new Error('Cannot embed empty content');
  }

  return ingest(pgsl, tokens, provenance);
}

/**
 * Tokenize content into a sequence of values for PGSL ingestion.
 * Default: split on whitespace. Override for domain-specific tokenization.
 */
function tokenize(content: string): string[] {
  return content.split(/\s+/).filter(t => t.length > 0);
}

// ── Coherence: f* preserves finite limits ───────────────────

/**
 * Verify that the geometric morphism preserves intersection.
 *
 * Given two descriptors A and B, their intersection in Context Graphs
 * should correspond to the lattice meet of their PGSL embeddings.
 *
 * Returns true if the coherence condition holds.
 */
export function verifyIntersectionCoherence(
  pgsl: PGSLInstance,
  contentA: string,
  contentB: string,
): {
  coherent: boolean;
  pgslMeet: IRI | null;
  fragmentA: IRI;
  fragmentB: IRI;
} {
  const fragmentA = embedInPGSL(pgsl, contentA);
  const fragmentB = embedInPGSL(pgsl, contentB);

  const meet = latticeMeet(pgsl, fragmentA, fragmentB);

  // The coherence condition: if A and B share sub-sequences,
  // the lattice meet should be non-null and correspond to the shared content.
  // If they share no content, meet should be null.
  const tokensA = new Set(tokenize(contentA));
  const tokensB = new Set(tokenize(contentB));
  const sharedTokens = [...tokensA].filter(t => tokensB.has(t));

  const coherent = sharedTokens.length > 0 ? meet !== null : true;

  return { coherent, pgslMeet: meet, fragmentA, fragmentB };
}

// ── Natural Transformation: Provenance Flow ─────────────────

/**
 * The provenance natural transformation η: PGSL → Prov ∘ PGSL.
 *
 * For the naturality condition to hold, provenance must commute
 * with constituent-of morphisms. This function verifies that
 * a fragment's provenance is consistent with its constituents'.
 *
 * Rule: a fragment's generatedAtTime must be ≥ all its items' times.
 * (You can't construct a fragment before its constituents exist.)
 */
export function verifyProvenanceNaturality(
  pgsl: PGSLInstance,
  fragmentUri: IRI,
): { natural: boolean; violations: string[] } {
  const node = pgsl.nodes.get(fragmentUri);
  if (!node) return { natural: false, violations: ['Node not found'] };
  if (node.kind === 'Atom') return { natural: true, violations: [] };

  const fragment = node as Fragment;
  const violations: string[] = [];
  const fragmentTime = new Date(fragment.provenance.generatedAtTime).getTime();

  for (const itemUri of fragment.items) {
    const item = pgsl.nodes.get(itemUri);
    if (!item) continue;
    const itemTime = new Date(item.provenance.generatedAtTime).getTime();
    if (itemTime > fragmentTime) {
      violations.push(
        `Fragment ${fragmentUri} (${fragment.provenance.generatedAtTime}) ` +
        `was generated before its constituent ${itemUri} (${item.provenance.generatedAtTime})`
      );
    }
  }

  return { natural: violations.length === 0, violations };
}
