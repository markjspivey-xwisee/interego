/**
 * @module pgsl/retrieval
 * @description PGSL-native structural retrieval.
 *
 * Retrieves candidates by actual shared structure in the lattice,
 * not statistical similarity. Three signals:
 *
 *   1. Atom overlap: shared canonical atoms between query and candidate
 *   2. Meet depth: level of the lattice meet (largest shared sub-sequence)
 *   3. Fragment containment: how many query fragments exist in the candidate
 *
 * This is deterministic, exact, compositional retrieval — no embeddings,
 * no approximation, no model weights. The score is a structural proof
 * of shared meaning.
 */

import type { IRI } from '../model/types.js';
import type { PGSLInstance } from './types.js';
import { latticeMeet } from './category.js';

// ═════════════════════════════════════════════════════════════
//  Types
// ═════════════════════════════════════════════════════════════

export interface RetrievalResult {
  readonly candidateUri: string;
  readonly score: number;
  readonly atomOverlap: number;       // shared atoms / query atoms
  readonly meetLevel: number;         // level of lattice meet (0 = no meet)
  readonly meetContent: string;       // resolved content of the meet
  readonly fragmentContainment: number; // query fragments found in candidate
  readonly sharedAtoms: readonly string[];  // the actual shared atom values
}

export interface RetrievalOptions {
  /** Maximum results (default: 10) */
  limit?: number;
  /** Weight for atom overlap signal (default: 0.4) */
  atomWeight?: number;
  /** Weight for meet depth signal (default: 0.35) */
  meetWeight?: number;
  /** Weight for fragment containment signal (default: 0.25) */
  fragmentWeight?: number;
  /** Minimum score threshold (default: 0.01) */
  minScore?: number;
}

// ═════════════════════════════════════════════════════════════
//  Core Retrieval
// ═════════════════════════════════════════════════════════════

/**
 * Retrieve candidates ranked by structural similarity to a query.
 *
 * @param pgsl - The PGSL lattice instance
 * @param queryUri - URI of the query fragment (must already be ingested)
 * @param candidateUris - URIs of candidate fragments to rank
 * @param options - Retrieval options (weights, limits)
 * @returns Ranked results with structural evidence
 */
export function structuralRetrieve(
  pgsl: PGSLInstance,
  queryUri: IRI,
  candidateUris: readonly IRI[],
  options: RetrievalOptions = {},
): RetrievalResult[] {
  const {
    limit = 10,
    atomWeight = 0.4,
    meetWeight = 0.35,
    fragmentWeight = 0.25,
    minScore = 0.01,
  } = options;

  // Extract query atoms
  const queryAtoms = extractAtoms(pgsl, queryUri);
  if (queryAtoms.size === 0) return [];

  // Extract query fragments at all levels
  const queryFragments = extractFragmentKeys(pgsl, queryUri);

  const results: RetrievalResult[] = [];

  for (const candidateUri of candidateUris) {
    // 1. Atom overlap
    const candidateAtoms = extractAtoms(pgsl, candidateUri);
    const sharedAtoms: string[] = [];
    for (const atom of queryAtoms) {
      if (candidateAtoms.has(atom)) sharedAtoms.push(atom);
    }
    const atomOverlap = queryAtoms.size > 0 ? sharedAtoms.length / queryAtoms.size : 0;

    // 2. Meet depth
    let meetLevel = 0;
    let meetContent = '';
    if (sharedAtoms.length >= 2) {
      // Only compute meet if there are at least 2 shared atoms
      const meetUri = latticeMeet(pgsl, queryUri, candidateUri);
      if (meetUri) {
        const meetNode = pgsl.nodes.get(meetUri);
        if (meetNode) {
          meetLevel = meetNode.kind === 'Fragment' ? meetNode.level : 1;
          meetContent = resolveContent(pgsl, meetUri);
        }
      }
    }

    // Normalize meet level
    const queryNode = pgsl.nodes.get(queryUri);
    const maxLevel = queryNode?.kind === 'Fragment' ? queryNode.level : 1;
    const normalizedMeet = maxLevel > 0 ? meetLevel / maxLevel : 0;

    // 3. Fragment containment
    const candidateFragments = extractFragmentKeys(pgsl, candidateUri);
    let containedCount = 0;
    for (const fk of queryFragments) {
      if (candidateFragments.has(fk)) containedCount++;
    }
    const fragmentContainment = queryFragments.size > 0 ? containedCount / queryFragments.size : 0;

    // Composite score
    const score = atomWeight * atomOverlap
      + meetWeight * normalizedMeet
      + fragmentWeight * fragmentContainment;

    if (score >= minScore) {
      results.push({
        candidateUri,
        score: Math.round(score * 10000) / 10000,
        atomOverlap: Math.round(atomOverlap * 1000) / 1000,
        meetLevel,
        meetContent,
        fragmentContainment: Math.round(fragmentContainment * 1000) / 1000,
        sharedAtoms,
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Quick retrieval using only atom overlap (fastest, no meet computation).
 * Use when you need speed over precision.
 */
export function atomRetrieve(
  pgsl: PGSLInstance,
  queryUri: IRI,
  candidateUris: readonly IRI[],
  limit = 10,
): RetrievalResult[] {
  const queryAtoms = extractAtoms(pgsl, queryUri);
  if (queryAtoms.size === 0) return [];

  const results: RetrievalResult[] = [];

  for (const candidateUri of candidateUris) {
    const candidateAtoms = extractAtoms(pgsl, candidateUri);
    const sharedAtoms: string[] = [];
    for (const atom of queryAtoms) {
      if (candidateAtoms.has(atom)) sharedAtoms.push(atom);
    }
    const atomOverlap = sharedAtoms.length / queryAtoms.size;

    if (atomOverlap > 0) {
      results.push({
        candidateUri,
        score: Math.round(atomOverlap * 10000) / 10000,
        atomOverlap: Math.round(atomOverlap * 1000) / 1000,
        meetLevel: 0,
        meetContent: '',
        fragmentContainment: 0,
        sharedAtoms,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ═════════════════════════════════════════════════════════════
//  Helpers
// ═════════════════════════════════════════════════════════════

/**
 * Extract all atom values reachable from a fragment.
 */
function extractAtoms(pgsl: PGSLInstance, uri: IRI): Set<string> {
  const atoms = new Set<string>();
  const node = pgsl.nodes.get(uri);
  if (!node) return atoms;

  if (node.kind === 'Atom') {
    atoms.add(String(node.value));
    return atoms;
  }

  // Fragment: walk all items recursively
  const stack: IRI[] = [...node.items];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const n = pgsl.nodes.get(current);
    if (!n) continue;

    if (n.kind === 'Atom') {
      atoms.add(String(n.value));
    } else {
      stack.push(...n.items);
    }
  }

  return atoms;
}

/**
 * Extract fragment keys (sorted atom sequences) at all levels.
 * Used for fragment containment check.
 */
function extractFragmentKeys(pgsl: PGSLInstance, uri: IRI): Set<string> {
  const keys = new Set<string>();
  const node = pgsl.nodes.get(uri);
  if (!node) return keys;

  if (node.kind === 'Atom') {
    keys.add(String(node.value));
    return keys;
  }

  // Collect all sub-fragment URIs
  const stack: IRI[] = [uri];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    keys.add(current); // The URI itself is a key

    const n = pgsl.nodes.get(current);
    if (!n || n.kind === 'Atom') continue;

    // Add constituents
    if (n.left) stack.push(n.left);
    if (n.right) stack.push(n.right);
    stack.push(...n.items);
  }

  return keys;
}

/**
 * Resolve a URI to its text content.
 */
function resolveContent(pgsl: PGSLInstance, uri: IRI): string {
  const node = pgsl.nodes.get(uri);
  if (!node) return '';
  if (node.kind === 'Atom') return String(node.value);

  // Resolve items left-to-right
  const parts: string[] = [];
  for (const item of node.items) {
    parts.push(resolveContent(pgsl, item));
  }
  return parts.join(' ');
}
