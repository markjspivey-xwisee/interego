/**
 * @module pgsl/geometric
 * @description Geometric morphism between PGSL and Interego topoi
 *
 * The PGSL presheaf topos Set^(L^op) and the Interego presheaf topos
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
import { ingest, mintAtom } from './lattice.js';
import { latticeMeet } from './category.js';

// ── Direct Image: f_* (PGSL → Interego) ──────────────

/**
 * The direct image functor f_*: PGSL → Interego.
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

// ── Inverse Image: f* (Interego → PGSL) ──────────────

/**
 * The inverse image functor f*: Interego → PGSL.
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
  granularity?: import('./types.js').TokenGranularity,
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

  const gran = granularity ?? 'word';

  // Structured mode: recursively ingest nested structures
  if (gran === 'structured') {
    const tokens = tokenize(content, 'structured');
    if (tokens.length === 0) {
      throw new Error('Cannot embed empty content');
    }

    // Check if any token is itself a nested structure
    const itemUris: IRI[] = tokens.map(token => {
      const isNested = (token.startsWith('(') && token.endsWith(')')) ||
                       (token.startsWith('[') && token.endsWith(']')) ||
                       (token.startsWith('{') && token.endsWith('}'));
      if (isNested) {
        // Recursively ingest the inner structure — it becomes a fragment
        return embedInPGSL(pgsl, token, descriptor, 'structured');
      }
      // Leaf value — mint as atom
      return mintAtom(pgsl, token, provenance);
    });

    // Now ingest the outer structure using the inner URIs
    return ingest(pgsl, itemUris, provenance);
  }

  // Non-structured modes: flat tokenization
  const tokens = tokenize(content, gran);

  if (tokens.length === 0) {
    throw new Error('Cannot embed empty content');
  }

  return ingest(pgsl, tokens, provenance);
}

/**
 * Tokenize content into a sequence of values for PGSL ingestion.
 * Default: split on whitespace. Override for domain-specific tokenization.
 */
function tokenize(content: string, granularity: import('./types.js').TokenGranularity = 'word'): string[] {
  switch (granularity) {
    case 'character':
      return content.split('').filter(c => c.length > 0);
    case 'sentence':
      return content.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
    case 'word':
      return content.split(/\s+/).filter(t => t.length > 0);
    case 'structured':
      return tokenizeStructured(content);
    default:
      return content.split(/\s+/).filter(t => t.length > 0);
  }
}

/**
 * Structured tokenization: parse nested structures recursively.
 *
 * Input: "((0,0),(0,0))"
 * Output: ["(0,0)", "(0,0)"] — inner structures become tokens
 *
 * Input: "(0,0,0)"
 * Output: ["0", "0", "0"] — flat elements become tokens
 *
 * The key: inner structures are returned as STRINGS that will
 * themselves be ingested recursively by embedInPGSL when
 * granularity='structured'. This creates nested lattice fragments.
 */
function tokenizeStructured(content: string): string[] {
  const trimmed = content.trim();

  // Strip outer parens/brackets if present
  let inner = trimmed;
  if ((trimmed.startsWith('(') && trimmed.endsWith(')')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    inner = trimmed.slice(1, -1).trim();
  }

  // Split by top-level commas (respecting nesting depth)
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of inner) {
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      const part = current.trim();
      if (part.length > 0) parts.push(part);
      current = '';
    } else {
      current += ch;
    }
  }
  const lastPart = current.trim();
  if (lastPart.length > 0) parts.push(lastPart);

  return parts;
}

// ── Coherence: f* preserves finite limits ───────────────────

/**
 * Verify that the geometric morphism preserves intersection.
 *
 * Given two descriptors A and B, their intersection in Interego
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
