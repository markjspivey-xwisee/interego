/**
 * @module pgsl/category
 * @description Level category L and presheaf structure for PGSL
 *
 * The PGSL forms a presheaf P: L^op → Set where:
 *   - Objects of L are levels (natural numbers)
 *   - Morphisms are constituent-of inclusions (level k → level k-1)
 *   - P(ℓ) = the set of all nodes at level ℓ
 *   - P(ℓ → ℓ-1) = the function mapping a fragment to its constituents
 *
 * The category Set^(L^op) is a topos, giving us:
 *   - Subobject classifier Ω (for "sub-fragment" relations)
 *   - Internal logic (containment, overlap as propositions)
 *   - Limits and colimits (pullbacks for overlapping pairs)
 *
 * This module provides the categorical API for navigating and
 * querying the PGSL structure.
 */

import type {
  IRI,
} from '../model/types.js';

import type {
  Level,
  Node,
  Fragment,
  PGSLInstance,
  ConstituentMorphism,
  PullbackSquare,
} from './types.js';

// ── Presheaf Fiber: P(ℓ) ────────────────────────────────────

/**
 * Get all nodes at a given level — the fiber P(ℓ) of the presheaf.
 */
export function fiber(pgsl: PGSLInstance, level: Level): Node[] {
  const result: Node[] = [];
  for (const node of pgsl.nodes.values()) {
    if (node.kind === 'Atom' && level === 0) result.push(node);
    if (node.kind === 'Fragment' && node.level === level) result.push(node);
  }
  return result;
}

/**
 * The maximum level in the lattice.
 */
export function maxLevel(pgsl: PGSLInstance): Level {
  let max = 0;
  for (const node of pgsl.nodes.values()) {
    if (node.kind === 'Fragment' && node.level > max) max = node.level;
  }
  return max;
}

// ── Restriction Maps: P(ℓ) → P(ℓ-1) ───────────────────────

/**
 * Get the constituent morphisms from a fragment — the restriction map
 * P(k) → P(k-1) applied to a specific node.
 *
 * For level 1: returns a single morphism to the wrapped atom.
 * For level k ≥ 2: returns left and right constituent morphisms.
 */
export function constituents(
  pgsl: PGSLInstance,
  uri: IRI,
): ConstituentMorphism[] {
  const node = pgsl.nodes.get(uri);
  if (!node || node.kind === 'Atom') return [];

  const fragment = node as Fragment;
  const morphisms: ConstituentMorphism[] = [];

  if (fragment.level === 1) {
    // Level 1: single constituent (the wrapped atom)
    if (fragment.items.length === 1) {
      morphisms.push({
        parent: uri,
        constituent: fragment.items[0]!,
        position: 'left',
        parentLevel: 1,
        constituentLevel: 0,
      });
    }
  } else if (fragment.left && fragment.right) {
    // Level k ≥ 2: overlapping pair
    morphisms.push({
      parent: uri,
      constituent: fragment.left,
      position: 'left',
      parentLevel: fragment.level,
      constituentLevel: fragment.level - 1,
    });
    morphisms.push({
      parent: uri,
      constituent: fragment.right,
      position: 'right',
      parentLevel: fragment.level,
      constituentLevel: fragment.level - 1,
    });
  }

  return morphisms;
}

// ── Pullback Extraction ─────────────────────────────────────

/**
 * Extract the pullback square for a fragment of level ≥ 2.
 *
 * The pullback encodes the overlapping pair construction:
 *
 *   apex (level k) ────→ right (level k-1)
 *       |                      |
 *       ↓                      ↓
 *   left (level k-1) ────→ overlap (level k-2)
 *
 * The overlap is the shared sub-sequence — the last (k-2) items
 * of left are identical to the first (k-2) items of right.
 *
 * Returns null for atoms and level-1 fragments (no pullback structure).
 */
export function pullbackSquare(
  pgsl: PGSLInstance,
  uri: IRI,
): PullbackSquare | null {
  const node = pgsl.nodes.get(uri);
  if (!node || node.kind === 'Atom') return null;

  const fragment = node as Fragment;
  if (fragment.level < 2 || !fragment.left || !fragment.right) return null;

  const leftNode = pgsl.nodes.get(fragment.left) as Fragment | undefined;
  const rightNode = pgsl.nodes.get(fragment.right) as Fragment | undefined;
  if (!leftNode || !rightNode) return null;

  // The overlap is the shared sub-sequence.
  // For level k, left and right are level k-1, each spanning k-1 atoms.
  // They overlap by k-2 atoms. The overlap fragment is at level k-2.
  const overlapSize = fragment.level - 2;

  if (overlapSize === 0) {
    // Level 2: the overlap is a single atom (level 0)
    // The last item of left = the first item of right
    const overlapUri = leftNode.items[leftNode.items.length - 1]!;
    return {
      apex: uri,
      left: fragment.left,
      right: fragment.right,
      overlap: overlapUri,
      level: fragment.level,
    };
  }

  // Level k ≥ 3: find the overlap fragment
  // The overlap items are the last (k-2) items of left = first (k-2) items of right
  const overlapItems = leftNode.items.slice(-(overlapSize));
  const overlapKey = overlapItems.join('|');

  // Look up the overlap fragment in the registry
  const overlapUri = pgsl.fragments.get(overlapKey);
  if (!overlapUri) return null;

  return {
    apex: uri,
    left: fragment.left,
    right: fragment.right,
    overlap: overlapUri,
    level: fragment.level,
  };
}

// ── Ancestor/Descendant Navigation ──────────────────────────

/**
 * Get all ancestors of a node — all fragments that contain this node
 * as a (transitive) constituent. Traverses UP the lattice.
 */
export function ancestorFragments(
  pgsl: PGSLInstance,
  uri: IRI,
): IRI[] {
  const result: IRI[] = [];
  for (const node of pgsl.nodes.values()) {
    if (node.kind === 'Fragment' && node.items.includes(uri)) {
      result.push(node.uri);
    }
  }
  // Transitively: also find ancestors of ancestors
  const transitive: Set<IRI> = new Set(result);
  const queue = [...result];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const node of pgsl.nodes.values()) {
      if (node.kind === 'Fragment' && node.items.includes(current) && !transitive.has(node.uri)) {
        transitive.add(node.uri);
        queue.push(node.uri);
      }
    }
  }
  return [...transitive];
}

/**
 * Get all descendant nodes — all nodes transitively contained
 * within this fragment. Traverses DOWN the lattice.
 */
export function descendantNodes(
  pgsl: PGSLInstance,
  uri: IRI,
): IRI[] {
  const node = pgsl.nodes.get(uri);
  if (!node || node.kind === 'Atom') return [];

  const fragment = node as Fragment;
  const result: Set<IRI> = new Set();

  function collect(itemUri: IRI): void {
    if (result.has(itemUri)) return;
    result.add(itemUri);
    const n = pgsl.nodes.get(itemUri);
    if (n?.kind === 'Fragment') {
      for (const item of (n as Fragment).items) {
        collect(item);
      }
    }
  }

  for (const item of fragment.items) {
    collect(item);
  }

  return [...result];
}

// ── Lattice Operations ──────────────────────────────────────

/**
 * Lattice meet (greatest lower bound) — find the largest shared
 * sub-fragment between two fragments.
 *
 * This is the categorical intersection in the presheaf topos.
 */
export function latticeMeet(
  pgsl: PGSLInstance,
  a: IRI,
  b: IRI,
): IRI | null {
  const nodeA = pgsl.nodes.get(a);
  const nodeB = pgsl.nodes.get(b);
  if (!nodeA || !nodeB) return null;

  const itemsA = nodeA.kind === 'Atom' ? [nodeA.uri] : (nodeA as Fragment).items;
  const itemsB = nodeB.kind === 'Atom' ? [nodeB.uri] : (nodeB as Fragment).items;

  // Find the longest common sub-sequence that exists as a fragment
  let bestMatch: IRI | null = null;
  let bestLength = 0;

  for (let i = 0; i < itemsA.length; i++) {
    for (let j = 0; j < itemsB.length; j++) {
      if (itemsA[i] === itemsB[j]) {
        // Found a matching position, extend it
        let len = 1;
        while (
          i + len < itemsA.length &&
          j + len < itemsB.length &&
          itemsA[i + len] === itemsB[j + len]
        ) {
          len++;
        }
        if (len > bestLength) {
          // Check if this sub-sequence exists as a fragment
          const subItems = itemsA.slice(i, i + len);
          const key = subItems.join('|');
          const fragUri = pgsl.fragments.get(key);
          if (fragUri) {
            bestMatch = fragUri;
            bestLength = len;
          }
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Check if node A is a sub-fragment of node B.
 *
 * In the presheaf topos, this is the subobject relation:
 * A ↪ B (monomorphism from A into B).
 */
export function isSubFragment(
  pgsl: PGSLInstance,
  a: IRI,
  b: IRI,
): boolean {
  if (a === b) return true;

  const nodeA = pgsl.nodes.get(a);
  const nodeB = pgsl.nodes.get(b);
  if (!nodeA || !nodeB) return false;

  const itemsA = nodeA.kind === 'Atom' ? [nodeA.uri] : (nodeA as Fragment).items;
  const itemsB = nodeB.kind === 'Atom' ? [nodeB.uri] : (nodeB as Fragment).items;

  // A is a sub-fragment of B if A's items appear as a contiguous sub-sequence of B's items
  if (itemsA.length > itemsB.length) return false;

  for (let i = 0; i <= itemsB.length - itemsA.length; i++) {
    let match = true;
    for (let j = 0; j < itemsA.length; j++) {
      if (itemsA[j] !== itemsB[i + j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }

  return false;
}
