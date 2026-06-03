/**
 * @module pgsl/usage-semantics
 * @description Usage-based emergent semantics for PGSL retrieval.
 *
 * "Meaning is use" (Wittgenstein). "You shall know a word by the
 * company it keeps" (Firth).
 *
 * The PGSL lattice already tracks which atoms appear in which fragments.
 * This module mines that structure for emergent semantic relations:
 *
 *   1. Co-occurrence: atoms that appear in the same fragments are related
 *   2. Fragment profiles (Yoneda embedding): an atom IS its usage pattern
 *   3. Emergent synonyms: atoms with similar profiles mean the same thing
 *   4. Usage-based query expansion: expand atoms with co-occurring neighbors
 *
 * This is distributional semantics realized structurally in the lattice,
 * formalized via the Yoneda lemma from category theory:
 *   An atom a is characterized by Hom(-, a) — the set of all fragments
 *   containing a. Two atoms with isomorphic Hom-sets are semantically
 *   equivalent.
 *
 * The more sessions ingested, the richer the co-occurrence data,
 * the better the semantic relations — emergent, not trained.
 */

import type { IRI } from '../model/types.js';
import type { PGSLInstance } from './types.js';

// ═════════════════════════════════════════════════════════════
//  Co-occurrence Mining
// ═════════════════════════════════════════════════════════════

/** Co-occurrence entry: which atoms co-occur and how often */
export interface CoOccurrence {
  readonly atomA: string;
  readonly atomB: string;
  readonly count: number;         // number of fragments containing both
  readonly pmi: number;           // pointwise mutual information
}

/**
 * Build co-occurrence matrix from the PGSL lattice.
 * For each fragment, record which atom pairs co-occur.
 *
 * Returns a map: atom → Map<co-occurring atom, count>
 */
export function buildCoOccurrenceMatrix(pgsl: PGSLInstance): Map<string, Map<string, number>> {
  const matrix = new Map<string, Map<string, number>>();
  const atomCounts = new Map<string, number>(); // atom → total fragment count

  // For each fragment, find all atoms it contains
  for (const [uri, node] of pgsl.nodes) {
    if (node.kind !== 'Fragment') continue;

    // Extract atoms from this fragment
    const atoms = extractAtomsFromNode(pgsl, uri as IRI);
    if (atoms.length < 2) continue;

    // Record co-occurrences
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i]!;
      atomCounts.set(a, (atomCounts.get(a) ?? 0) + 1);

      if (!matrix.has(a)) matrix.set(a, new Map());
      const row = matrix.get(a)!;

      for (let j = i + 1; j < atoms.length; j++) {
        const b = atoms[j]!;
        row.set(b, (row.get(b) ?? 0) + 1);

        // Symmetric
        if (!matrix.has(b)) matrix.set(b, new Map());
        matrix.get(b)!.set(a, (matrix.get(b)!.get(a) ?? 0) + 1);
      }
    }
  }

  return matrix;
}

/**
 * Get the top-N co-occurring atoms for a given atom.
 * These are the atom's "semantic neighbors" based on usage.
 */
export function getCoOccurringAtoms(
  matrix: Map<string, Map<string, number>>,
  atom: string,
  topN: number = 10,
): { atom: string; count: number }[] {
  const row = matrix.get(atom);
  if (!row) return [];

  return [...row.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([a, count]) => ({ atom: a, count }));
}

// ═════════════════════════════════════════════════════════════
//  Fragment Profiles (Yoneda Embedding)
// ═════════════════════════════════════════════════════════════

/**
 * Compute the Yoneda embedding for an atom: the set of all fragments
 * containing it. This IS the atom's meaning in the categorical sense.
 *
 * Yoneda lemma: Nat(Hom(-, a), F) ≅ F(a)
 * An atom is fully characterized by its fragment profile.
 */
export function yonedaEmbedding(pgsl: PGSLInstance, atomValue: string): Set<string> {
  const fragments = new Set<string>();

  for (const [uri, node] of pgsl.nodes) {
    if (node.kind !== 'Fragment') continue;

    const atoms = extractAtomsFromNode(pgsl, uri as IRI);
    if (atoms.includes(atomValue)) {
      fragments.add(uri);
    }
  }

  return fragments;
}

/**
 * Compute Yoneda similarity between two atoms.
 * Jaccard index of their fragment profiles.
 *
 * If two atoms have the same fragment profile, they are semantically
 * identical (isomorphic in the presheaf category).
 */
export function yonedaSimilarity(
  pgsl: PGSLInstance,
  atomA: string,
  atomB: string,
): number {
  const profileA = yonedaEmbedding(pgsl, atomA);
  const profileB = yonedaEmbedding(pgsl, atomB);

  if (profileA.size === 0 && profileB.size === 0) return 0;

  let intersection = 0;
  for (const f of profileA) {
    if (profileB.has(f)) intersection++;
  }

  const union = profileA.size + profileB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ═════════════════════════════════════════════════════════════
//  Emergent Synonyms
// ═════════════════════════════════════════════════════════════

/**
 * Detect emergent synonyms: atoms with similar fragment profiles.
 * No dictionary needed — synonyms emerge from usage patterns.
 *
 * "issue" and "problem" are synonyms if they appear in the same
 * fragment contexts (same parent fragments, same co-occurring atoms).
 */
export function detectEmergentSynonyms(
  pgsl: PGSLInstance,
  minSimilarity: number = 0.3,
): Map<string, string[]> {
  const synonyms = new Map<string, string[]>();

  // Collect all atom values
  const atomValues: string[] = [];
  for (const [, node] of pgsl.nodes) {
    if (node.kind === 'Atom') atomValues.push(String(node.value));
  }

  // Compare all pairs (O(n²) but atoms are typically < 10K)
  // For large lattices, use locality-sensitive hashing
  for (let i = 0; i < atomValues.length && i < 1000; i++) {
    const a = atomValues[i]!;
    const group: string[] = [];

    for (let j = i + 1; j < atomValues.length && j < 1000; j++) {
      const b = atomValues[j]!;
      const sim = yonedaSimilarity(pgsl, a, b);
      if (sim >= minSimilarity) {
        group.push(b);
      }
    }

    if (group.length > 0) {
      synonyms.set(a, group);
    }
  }

  return synonyms;
}

// ═════════════════════════════════════════════════════════════
//  Usage-Based Query Expansion
// ═════════════════════════════════════════════════════════════

/**
 * Expand a set of query atoms with their co-occurring neighbors.
 * This bridges semantic gaps through USAGE, not dictionary lookup.
 *
 * "car" → expands to include "GPS", "engine", "service", "repair"
 * because they co-occur in the lattice's fragment structure.
 */
export function usageExpand(
  atoms: readonly string[],
  matrix: Map<string, Map<string, number>>,
  topN: number = 5,
  minCount: number = 2,
): string[] {
  const expanded = new Set<string>(atoms);

  for (const atom of atoms) {
    const neighbors = getCoOccurringAtoms(matrix, atom, topN);
    for (const n of neighbors) {
      if (n.count >= minCount) {
        expanded.add(n.atom);
      }
    }
  }

  return [...expanded];
}

/**
 * Usage-based semantic similarity between two texts.
 *
 * 1. Tokenize both texts to atoms
 * 2. Expand both atom sets with co-occurring neighbors from the lattice
 * 3. Compute Jaccard similarity of expanded sets
 *
 * This is distributional semantics realized structurally:
 * the more the lattice has seen, the better the expansion,
 * the better the similarity score.
 */
export function usageBasedSimilarity(
  textA: string,
  textB: string,
  matrix: Map<string, Map<string, number>>,
  expansionDepth: number = 5,
): { score: number; sharedExpanded: string[]; expansionA: number; expansionB: number } {
  const atomsA = tokenize(textA);
  const atomsB = tokenize(textB);

  const expandedA = new Set(usageExpand(atomsA, matrix, expansionDepth));
  const expandedB = new Set(usageExpand(atomsB, matrix, expansionDepth));

  const shared: string[] = [];
  for (const a of expandedA) {
    if (expandedB.has(a)) shared.push(a);
  }

  const union = expandedA.size + expandedB.size - shared.length;

  return {
    score: union > 0 ? shared.length / union : 0,
    sharedExpanded: shared,
    expansionA: expandedA.size,
    expansionB: expandedB.size,
  };
}

// ═════════════════════════════════════════════════════════════
//  Combined Retrieval: Ontological + Usage-Based
// ═════════════════════════════════════════════════════════════

/**
 * Hybrid retrieval combining ontological inference with usage-based expansion.
 *
 * 1. Ontological expansion (hand-coded IS-A, synonyms, CAUSES)
 * 2. Usage-based expansion (co-occurrence from the lattice)
 * 3. Combined scoring: α·ontological + β·usage-based
 */
export function hybridRetrieve(
  question: string,
  sessions: readonly string[],
  matrix: Map<string, Map<string, number>>,
  ontologicalExpand: (entities: readonly string[]) => string[],
): { bestIndex: number; score: number; method: string }[] {
  const qAtoms = tokenize(question);

  // Ontological expansion
  const ontoExpanded = new Set(ontologicalExpand(qAtoms));

  // Usage-based expansion
  const usageExp = new Set(usageExpand(qAtoms, matrix, 5, 1));

  // Combined expansion
  const combined = new Set([...ontoExpanded, ...usageExp]);

  const results: { bestIndex: number; score: number; method: string }[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const sAtoms = new Set(tokenize(sessions[i]!));

    // Ontological score
    let ontoOverlap = 0;
    for (const a of ontoExpanded) { if (sAtoms.has(a)) ontoOverlap++; }
    const ontoScore = ontoExpanded.size > 0 ? ontoOverlap / ontoExpanded.size : 0;

    // Usage score
    let usageOverlap = 0;
    for (const a of usageExp) { if (sAtoms.has(a)) usageOverlap++; }
    const usageScore = usageExp.size > 0 ? usageOverlap / usageExp.size : 0;

    // Combined score
    let combinedOverlap = 0;
    for (const a of combined) { if (sAtoms.has(a)) combinedOverlap++; }
    const combinedScore = combined.size > 0 ? combinedOverlap / combined.size : 0;

    // Take best of all three
    const best = Math.max(ontoScore, usageScore, combinedScore);
    const method = best === ontoScore ? 'ontological' :
                   best === usageScore ? 'usage' : 'combined';

    results.push({ bestIndex: i, score: best, method });
  }

  return results.sort((a, b) => b.score - a.score);
}

// ═════════════════════════════════════════════════════════════
//  Helpers
// ═════════════════════════════════════════════════════════════

function extractAtomsFromNode(pgsl: PGSLInstance, uri: IRI): string[] {
  const atoms: string[] = [];
  const node = pgsl.nodes.get(uri);
  if (!node) return atoms;

  if (node.kind === 'Atom') {
    atoms.push(String(node.value));
    return atoms;
  }

  const stack: IRI[] = [...node.items];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const n = pgsl.nodes.get(current);
    if (!n) continue;
    if (n.kind === 'Atom') {
      atoms.push(String(n.value));
    } else {
      stack.push(...n.items);
    }
  }

  return atoms;
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP.has(w));
}

const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'to', 'of', 'in', 'for', 'on', 'with', 'at',
  'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after',
  'but', 'and', 'or', 'if', 'that', 'this', 'it', 'its', 'my', 'me',
  'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they',
  'them', 'their', 'what', 'which', 'who', 'how', 'when', 'where', 'not',
  'no', 'so', 'up', 'out', 'just', 'about', 'than', 'very', 'also',
]);
