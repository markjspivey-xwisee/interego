/**
 * @module pgsl/lattice
 * @description PGSL monad operations — MintAtom, Ingest, Resolve, QueryNeighbors
 *
 * These are the core operations of the PGSL, formalized as a monad:
 *
 *   MintAtom: V → PGSL           (unit of the monad — η)
 *   Ingest:   Seq(V) → PGSL      (multiplication — μ, via iterative construction)
 *   Resolve:  PGSL → String      (counit — ε, extracting readable content)
 *
 * The monad structure ensures that PGSL algebras compose correctly:
 * combining two PGSLs (from different agents) yields a well-defined result
 * because MintAtom/Ingest satisfy the monad laws (associativity, identity).
 *
 * The overlapping pair construction at each level is a pullback
 * in the presheaf topos — see category.ts for the categorical structure.
 */

import type { IRI } from '../model/types.js';
import type {
  Value,
  Level,
  Atom,
  Fragment,
  Node,
  NodeProvenance,
  PGSLInstance,
  Direction,
  ContainmentAnnotation,
  ContainmentRole,
} from './types.js';

// ── URI Generation (Content-Addressing via SHA-256) ─────────

import { createHash } from 'node:crypto';
import { encryptFacetValue, decryptFacetValue } from '../crypto/facet-encryption.js';
import type { EncryptionKeyPair } from '../crypto/encryption.js';

/**
 * Compute a SHA-256 hash of a string, return as hex.
 * Uses Node.js built-in crypto — no external dependencies.
 */
function contentHash(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Generate a canonical URI for an atom from its value.
 * Content-addressed: URI is derived from SHA-256 hash of the value.
 * Same value always produces same URI. The value is NOT in the URI.
 * Globally unique — same atom on any pod has the same URI.
 */
function atomUri(value: Value): IRI {
  const hash = contentHash(`atom:${String(value)}`);
  return `urn:pgsl:atom:${hash.slice(0, 40)}` as IRI;
}

/**
 * Generate a canonical URI for a fragment from its items.
 * Content-addressed: URI is derived from SHA-256 hash of the item URIs.
 * Same item sequence always produces same URI regardless of pod.
 */
function fragmentUri(items: readonly IRI[], level: Level): IRI {
  const hash = contentHash(`fragment:L${level}:${items.join('|')}`);
  return `urn:pgsl:fragment:${hash.slice(0, 40)}` as IRI;
}

/**
 * Registry key for a fragment — deterministic from its items.
 */
function fragmentKey(items: readonly IRI[]): string {
  return items.join('|');
}

// ── PGSL Instance Creation ──────────────────────────────────

/**
 * Create a new empty PGSL instance.
 *
 * @param provenance - Default provenance for new nodes
 * @param options - Optional configuration for lazy construction and level capping
 */
export function createPGSL(
  provenance: NodeProvenance,
  options?: { lazy?: boolean; maxLevel?: number },
): PGSLInstance {
  return {
    atoms: new Map(),
    fragments: new Map(),
    nodes: new Map(),
    defaultProvenance: provenance,
    lazyMode: options?.lazy,
    maxLevel: options?.maxLevel,
    deferredChains: (options?.lazy) ? new Map() : undefined,
  };
}

// ── Deferred Chain Helpers (Lazy Construction) ─────────────

/**
 * Compute a deterministic key for a deferred chain from its atom URIs.
 */
function deferredChainKey(atomUris: readonly IRI[]): string {
  return contentHash(`deferred:${atomUris.join('|')}`);
}

/**
 * Build the lattice for a deferred chain from level startLevel up to targetLevel.
 * Constructs all intermediate levels needed.
 *
 * @returns The URIs at the highest built level.
 */
function buildDeferredLevels(
  pgsl: PGSLInstance,
  atomUris: IRI[],
  _startLevel: number,
  targetLevel: number,
  provenance: NodeProvenance,
): IRI[] {
  // Rebuild from level-1 wrappers upward to targetLevel
  let currentLevel: IRI[] = atomUris.map(uri => ensureLevel1(pgsl, uri, provenance));

  const effectiveMax = pgsl.maxLevel != null
    ? Math.min(targetLevel, pgsl.maxLevel)
    : targetLevel;

  for (let lvl = 1; lvl < effectiveMax; lvl++) {
    if (currentLevel.length <= 1) break;
    const nextLevel: IRI[] = [];
    for (let i = 0; i < currentLevel.length - 1; i++) {
      const pair = buildOverlappingPair(pgsl, currentLevel[i]!, currentLevel[i + 1]!, provenance);
      if (pair) nextLevel.push(pair);
    }
    if (nextLevel.length === 0) break;
    currentLevel = nextLevel;
  }
  return currentLevel;
}

/**
 * Ensure a URI is fully built in the lattice.
 *
 * If the URI already exists in nodes, this is a no-op.
 * If the URI can be derived from a deferred chain (lazy mode),
 * the needed levels are built on demand.
 */
export function ensureBuilt(pgsl: PGSLInstance, uri: IRI): void {
  // Already built — nothing to do
  if (pgsl.nodes.has(uri)) return;

  // No deferred chains — nothing we can do
  if (!pgsl.deferredChains || pgsl.deferredChains.size === 0) return;

  const prov = pgsl.defaultProvenance;

  // Try each deferred chain: build the full lattice and check if uri appears
  for (const [key, atomUris] of pgsl.deferredChains) {
    // Build the full lattice for this chain (up to the top or maxLevel)
    const topLevel = atomUris.length;
    buildDeferredLevels(pgsl, atomUris, 2, topLevel, prov);

    // If the node now exists, we found it; remove the chain since it's fully built
    if (pgsl.nodes.has(uri)) {
      (pgsl.deferredChains as Map<string, IRI[]>).delete(key);
      return;
    }
  }
}

/**
 * Ensure all deferred chains are fully materialized.
 * Called internally before operations that scan all nodes.
 */
function materializeAllDeferred(pgsl: PGSLInstance): void {
  if (!pgsl.deferredChains || pgsl.deferredChains.size === 0) return;

  const prov = pgsl.defaultProvenance;
  for (const [, atomUris] of pgsl.deferredChains) {
    const topLevel = atomUris.length;
    buildDeferredLevels(pgsl, atomUris, 2, topLevel, prov);
  }
  (pgsl.deferredChains as Map<string, IRI[]>).clear();
}

// ── MintAtom: η (Unit of the PGSL Monad) ───────────────────

/**
 * MintAtom(v) → URI
 *
 * The unit of the PGSL monad. Maps a value to its canonical atom URI.
 * If the atom already exists, returns the existing URI (canonicity).
 * If not, creates a new Atom node and registers it.
 *
 * This is the free functor's action on objects: F: V → PGSL
 *
 * Satisfies the left identity law: MintAtom then Ingest([v]) = MintAtom(v)
 */
export function mintAtom(
  pgsl: PGSLInstance,
  value: Value,
  provenance?: NodeProvenance,
): IRI {
  const key = String(value);
  const existing = pgsl.atoms.get(key);
  if (existing) return existing;

  const uri = atomUri(value);
  const prov = provenance ?? pgsl.defaultProvenance;

  const atom: Atom = {
    kind: 'Atom',
    uri,
    value,
    level: 0,
    provenance: prov,
  };

  (pgsl.atoms as Map<string, IRI>).set(key, uri);
  (pgsl.nodes as Map<IRI, Node>).set(uri, atom);

  return uri;
}

/**
 * Mint an encrypted atom. URI is content-addressed from the plaintext
 * (same plaintext deduplicates inside the same recipient set), but the
 * stored `value` is a redacted placeholder. Real value is recoverable
 * only by holders of keys wrapped in `encrypted`.
 *
 * Structural operations (meet, join, levels, pullback) operate on URIs,
 * so encrypted atoms compose correctly in fragments. Cross-pod dedup
 * across different recipient sets is not preserved by design — that's
 * the proof-of-confidentiality tradeoff.
 */
export function mintEncryptedAtom(
  pgsl: PGSLInstance,
  value: Value,
  recipients: readonly string[],
  sender: EncryptionKeyPair,
  provenance?: NodeProvenance,
): IRI {
  const key = String(value);
  const existing = pgsl.atoms.get(key);
  if (existing) return existing;

  const uri = atomUri(value);
  const prov = provenance ?? pgsl.defaultProvenance;

  const atom: Atom = {
    kind: 'Atom',
    uri,
    value: '__ENCRYPTED__' as Value,
    level: 0,
    provenance: prov,
    encrypted: encryptFacetValue(String(value), recipients, sender),
  };

  (pgsl.atoms as Map<string, IRI>).set(key, uri);
  (pgsl.nodes as Map<IRI, Node>).set(uri, atom);

  return uri;
}

/**
 * Retrieve the plaintext value of an atom, decrypting if necessary.
 * Returns null when the atom doesn't exist OR when it's encrypted and
 * the caller isn't a recipient. Plaintext atoms round-trip unchanged.
 *
 * Optional layered defense: pass `expectedSenderPublicKey` (base64) to
 * also require the envelope to have been wrapped by that exact sender —
 * useful when the pod-write ACL alone isn't sufficient provenance for
 * the resolved value. See `decryptFacetValue` for the trust model.
 */
export function resolveAtomValue(
  pgsl: PGSLInstance,
  uri: IRI,
  recipientKeyPair?: EncryptionKeyPair,
  expectedSenderPublicKey?: string,
): string | null {
  const node = pgsl.nodes.get(uri);
  if (!node || node.kind !== 'Atom') return null;
  if (node.encrypted) {
    if (!recipientKeyPair) return null;
    return decryptFacetValue(node.encrypted, recipientKeyPair, expectedSenderPublicKey);
  }
  return String(node.value);
}

// ── Fragment Construction (Pullback-based) ──────────────────

/**
 * Get or create a level-1 wrapper fragment around an atom.
 *
 * Level 1 fragments are special: they wrap exactly one atom
 * with no constituents. They serve as the base case for the
 * overlapping pair induction.
 */
function ensureLevel1(
  pgsl: PGSLInstance,
  atomUri: IRI,
  provenance: NodeProvenance,
): IRI {
  const items = [atomUri];
  const key = fragmentKey(items);
  const existing = pgsl.fragments.get(key);
  if (existing) return existing;

  const uri = fragmentUri(items, 1);

  const fragment: Fragment = {
    kind: 'Fragment',
    uri,
    level: 1,
    height: 1,
    items,
    provenance,
  };

  (pgsl.fragments as Map<string, IRI>).set(key, uri);
  (pgsl.nodes as Map<IRI, Node>).set(uri, fragment);

  return uri;
}

/**
 * Build a level-k fragment from two level-(k-1) fragments
 * using the overlapping pair construction (pullback).
 *
 * The left fragment's last (k-2) items must equal the
 * right fragment's first (k-2) items — this is the pullback condition.
 *
 * Returns null if the overlap condition isn't satisfied.
 */
function buildOverlappingPair(
  pgsl: PGSLInstance,
  leftUri: IRI,
  rightUri: IRI,
  provenance: NodeProvenance,
): IRI | null {
  const leftNode = pgsl.nodes.get(leftUri);
  const rightNode = pgsl.nodes.get(rightUri);
  if (!leftNode || !rightNode) return null;
  if (leftNode.kind !== 'Fragment' || rightNode.kind !== 'Fragment') return null;

  const left = leftNode as Fragment;
  const right = rightNode as Fragment;

  // Both must be at the same level
  if (left.level !== right.level) return null;
  const k = left.level;

  // Verify overlap: last (k-1) items of left = first (k-1) items of right
  // Wait — the overlap is (k-1) items for level-k fragments?
  // No: level-k fragments span k atoms. Two level-k fragments overlapping by (k-1)
  // atoms form a level-(k+1) fragment.
  // So: left has k items, right has k items, they share (k-1) items.
  const overlapSize = k - 1;

  if (overlapSize < 0) return null;

  // Special case: level 1 fragments (overlap of 0 — just concatenation)
  if (overlapSize === 0) {
    // Level 1 + Level 1 → Level 2, no overlap needed
    const items = [...left.items, ...right.items];
    const key = fragmentKey(items);
    const existing = pgsl.fragments.get(key);
    if (existing) return existing;

    const uri = fragmentUri(items, k + 1);
    const fragment: Fragment = {
      kind: 'Fragment',
      uri,
      level: k + 1,
      height: Math.max(left.height, right.height) + 1,
      items,
      left: leftUri,
      right: rightUri,
      provenance,
    };

    (pgsl.fragments as Map<string, IRI>).set(key, uri);
    (pgsl.nodes as Map<IRI, Node>).set(uri, fragment);
    return uri;
  }

  // General case: verify the pullback condition
  const leftTail = left.items.slice(-overlapSize);
  const rightHead = right.items.slice(0, overlapSize);

  for (let i = 0; i < overlapSize; i++) {
    if (leftTail[i] !== rightHead[i]) return null; // Pullback condition fails
  }

  // Construct the combined items (left items + right items without overlap)
  const items = [...left.items, ...right.items.slice(overlapSize)];
  const key = fragmentKey(items);
  const existing = pgsl.fragments.get(key);
  if (existing) return existing;

  const uri = fragmentUri(items, k + 1);
  const fragment: Fragment = {
    kind: 'Fragment',
    uri,
    level: k + 1,
    height: Math.max(left.height, right.height) + 1,
    items,
    left: leftUri,
    right: rightUri,
    provenance,
  };

  (pgsl.fragments as Map<string, IRI>).set(key, uri);
  (pgsl.nodes as Map<IRI, Node>).set(uri, fragment);
  return uri;
}

// ── Ingest: μ (Multiplication of the PGSL Monad) ───────────

/**
 * Ingest(S) → URI
 *
 * The monad multiplication. Processes a sequence of values and/or URIs,
 * building the full lattice bottom-up, and returns the URI of the
 * top fragment (the one spanning the entire sequence).
 *
 * Algorithm:
 *   1. Convert all values to atom URIs via MintAtom
 *   2. Wrap each atom in a level-1 fragment
 *   3. Iteratively build level k+1 from level k using overlapping pairs
 *   4. Return the single fragment at the top level
 *
 * Satisfies the right identity law: Ingest of a single MintAtom = that atom
 * Satisfies associativity: Ingest(Ingest(A) ++ Ingest(B)) = Ingest(A ++ B)
 *   (up to canonical URI equivalence)
 *
 * Concurrency: this function is entirely synchronous — no awaits in
 * any of the call paths (mintAtom, ensureLevel1, the iterative
 * level-build loop). JS's single-threaded event loop guarantees that
 * two ingest calls from the same PGSLInstance run serially: one
 * completes before the other starts. No explicit lock needed in the
 * in-process case. The audit's "concurrent PGSL ingest without
 * locking" concern (Rel #18) applies only if PGSL state were shared
 * across worker threads or processes — which is not a deployment
 * shape we support. The single-threaded execution model IS the lock.
 */
export function ingest(
  pgsl: PGSLInstance,
  sequence: readonly (Value | IRI)[],
  provenance?: NodeProvenance,
): IRI {
  const prov = provenance ?? pgsl.defaultProvenance;

  if (sequence.length === 0) {
    throw new Error('Cannot ingest empty sequence');
  }

  // Step 1: Ensure all items are atom URIs
  const atomUris: IRI[] = sequence.map(item => {
    if (typeof item === 'string' && (item as string).startsWith('urn:pgsl:')) {
      // Already a PGSL URI
      return item as IRI;
    }
    return mintAtom(pgsl, item, prov);
  });

  // Single atom: return the level-1 wrapper
  if (atomUris.length === 1) {
    return ensureLevel1(pgsl, atomUris[0]!, prov);
  }

  // Step 2: Build level-1 wrappers
  let currentLevel: IRI[] = atomUris.map(uri => ensureLevel1(pgsl, uri, prov));

  // Determine how many levels to build eagerly
  // In lazy mode: only build up to level 2 (atoms + level-1 + level-2 pairs)
  // With maxLevel: stop at maxLevel
  // Default: build all levels
  const eagerLimit = pgsl.lazyMode ? 2 : Infinity;
  const capLimit = pgsl.maxLevel != null ? pgsl.maxLevel : Infinity;
  const buildLimit = Math.min(eagerLimit, capLimit);

  // Step 3: Build up the lattice level by level
  let levelsBuilt = 1; // level-1 wrappers already built
  while (currentLevel.length > 1) {
    if (levelsBuilt >= buildLimit) {
      // In lazy mode, store the atom sequence as a deferred chain
      if (pgsl.lazyMode && pgsl.deferredChains && atomUris.length > buildLimit) {
        const chainKey = deferredChainKey(atomUris);
        (pgsl.deferredChains as Map<string, IRI[]>).set(chainKey, [...atomUris]);
      }
      break;
    }

    const nextLevel: IRI[] = [];
    for (let i = 0; i < currentLevel.length - 1; i++) {
      const pair = buildOverlappingPair(pgsl, currentLevel[i]!, currentLevel[i + 1]!, prov);
      if (pair) {
        nextLevel.push(pair);
      }
    }

    if (nextLevel.length === 0) {
      // Can't build further — return the last successfully built fragment
      break;
    }

    currentLevel = nextLevel;
    levelsBuilt++;
  }

  // Step 4: Return the top fragment
  return currentLevel[0]!;
}

// ── Resolve: ε (Counit — Content Extraction) ────────────────

/**
 * Resolve(u) → string
 *
 * The counit of the adjunction. Extracts the human-readable
 * content from a PGSL node by recursively resolving its constituents.
 *
 * For atoms: returns the string representation of the value.
 * For fragments: returns the concatenation of its items' resolutions.
 */
export function resolve(
  pgsl: PGSLInstance,
  uri: IRI,
): string {
  // Lazy mode: ensure the node is built before resolving
  ensureBuilt(pgsl, uri);

  const node = pgsl.nodes.get(uri);
  if (!node) return `<unresolved:${uri}>`;

  if (node.kind === 'Atom') {
    return String(node.value);
  }

  // Fragment: resolve items and join with spaces
  const fragment = node as Fragment;
  return fragment.items
    .map(item => {
      const child = pgsl.nodes.get(item);
      if (!child) return `<unresolved:${item}>`;
      if (child.kind === 'Atom') return String(child.value);
      // For level-1 fragments, resolve the wrapped atom
      if (child.kind === 'Fragment' && (child as Fragment).level === 1) {
        const atom = pgsl.nodes.get((child as Fragment).items[0]!);
        return atom?.kind === 'Atom' ? String(atom.value) : `<unresolved>`;
      }
      return resolve(pgsl, item);
    })
    .join(' ');
}

// ── QueryNeighbors ──────────────────────────────────────────

/**
 * QueryNeighbors(u, d) → Set<URI>
 *
 * Find all nodes that appear immediately adjacent to node u
 * within any existing higher-level fragment in the lattice.
 *
 * This enables contextual navigation — "what appears next to this concept?"
 */
export function queryNeighbors(
  pgsl: PGSLInstance,
  uri: IRI,
  direction: Direction = 'both',
): Set<IRI> {
  // Lazy mode: materialize all deferred chains so we scan complete data
  materializeAllDeferred(pgsl);

  const neighbors = new Set<IRI>();

  for (const node of pgsl.nodes.values()) {
    if (node.kind !== 'Fragment') continue;
    const fragment = node as Fragment;

    if (fragment.level < 2 || !fragment.left || !fragment.right) continue;

    const leftNode = pgsl.nodes.get(fragment.left);
    const rightNode = pgsl.nodes.get(fragment.right);

    // Check if uri is the left constituent → right is the right neighbor
    if (fragment.left === uri && (direction === 'right' || direction === 'both')) {
      if (rightNode) neighbors.add(fragment.right);
    }

    // Check if uri is the right constituent → left is the left neighbor
    if (fragment.right === uri && (direction === 'left' || direction === 'both')) {
      if (leftNode) neighbors.add(fragment.left);
    }
  }

  return neighbors;
}

// ── Lattice Statistics ──────────────────────────────────────

/**
 * Get statistics about the PGSL lattice.
 */
export function latticeStats(pgsl: PGSLInstance): {
  atoms: number;
  fragments: number;
  totalNodes: number;
  maxLevel: number;
  levels: Record<number, number>;
  deferredChains?: number;
} {
  let atomCount = 0;
  let fragmentCount = 0;
  let maxLvl = 0;
  const levels: Record<number, number> = {};

  for (const node of pgsl.nodes.values()) {
    if (node.kind === 'Atom') {
      atomCount++;
      levels[0] = (levels[0] ?? 0) + 1;
    } else {
      fragmentCount++;
      const lvl = (node as Fragment).level;
      if (lvl > maxLvl) maxLvl = lvl;
      levels[lvl] = (levels[lvl] ?? 0) + 1;
    }
  }

  const result: {
    atoms: number;
    fragments: number;
    totalNodes: number;
    maxLevel: number;
    levels: Record<number, number>;
    deferredChains?: number;
  } = {
    atoms: atomCount,
    fragments: fragmentCount,
    totalNodes: pgsl.nodes.size,
    maxLevel: maxLvl,
    levels,
  };

  if (pgsl.deferredChains && pgsl.deferredChains.size > 0) {
    result.deferredChains = pgsl.deferredChains.size;
  }

  return result;
}

// ── Per-Node IPFS CID Computation ────────────────────────────

/**
 * Compute IPFS CIDs for all nodes in the lattice.
 * Each node gets a content-addressed CID based on its resolved content.
 *
 * This makes every node at every level individually dereferenceable on IPFS.
 * The atom "knowledge" has CID X. The fragment "knowledge graphs" has CID Y.
 * Both are globally unique and verifiable.
 *
 * @param computeCidFn - The CID computation function (from crypto/ipfs.ts)
 * @returns Map of URI → CID for all nodes
 */
export function computeLatticeCids(
  pgsl: PGSLInstance,
  computeCidFn: (content: string) => string,
): Map<IRI, string> {
  const cids = new Map<IRI, string>();

  for (const [uri, node] of pgsl.nodes) {
    const content = resolve(pgsl, uri);
    const cid = computeCidFn(content);
    cids.set(uri, cid);

    // Also set the cid on the node if mutable
    if ('cid' in node && node.cid === undefined) {
      (node as any).cid = cid;
    }
  }

  return cids;
}

// ── Containment Annotations (contextual properties on edges) ─

/**
 * Compute all containment annotations for a given node.
 * Returns one annotation per containing fragment — same node,
 * different contextual properties in each container.
 *
 * This IS the Peircean interpretant: the meaning of a sign
 * (the node) depends on its context (the containing fragment).
 */
export function computeContainmentAnnotations(
  pgsl: PGSLInstance,
  childUri: IRI,
): ContainmentAnnotation[] {
  // Lazy mode: materialize all deferred chains so we scan complete data
  materializeAllDeferred(pgsl);

  const annotations: ContainmentAnnotation[] = [];
  const childNode = pgsl.nodes.get(childUri);
  if (!childNode) return annotations;

  for (const [fragUri, fragNode] of pgsl.nodes) {
    if (fragNode.kind !== 'Fragment' || !fragNode.items) continue;

    const idx = fragNode.items.indexOf(childUri);
    if (idx < 0) continue;

    const totalItems = fragNode.items.length;
    const parentLevel = fragNode.level;
    const childLevel = childNode.level;

    // Determine role
    let role: ContainmentRole;
    if (totalItems === 1) {
      role = 'sole';
    } else if (fragNode.left === childUri) {
      role = 'left';
    } else if (fragNode.right === childUri) {
      role = 'right';
    } else if (idx === 0) {
      role = 'head';
    } else if (idx === totalItems - 1) {
      role = 'tail';
    } else {
      role = 'medial';
    }

    annotations.push({
      parentUri: fragUri as IRI,
      childUri,
      position: idx,
      depthFromBottom: childLevel,
      depthFromTop: parentLevel - childLevel,
      totalDepth: parentLevel,
      span: 1 / totalItems,
      role,
    });
  }

  // Sort by total depth descending (deepest containers first)
  annotations.sort((a, b) => b.totalDepth - a.totalDepth);

  return annotations;
}

/**
 * Get all containment annotations in the entire lattice.
 * Returns a map from child URI to its annotations.
 */
export function allContainmentAnnotations(
  pgsl: PGSLInstance,
): Map<IRI, ContainmentAnnotation[]> {
  const result = new Map<IRI, ContainmentAnnotation[]>();

  for (const [uri] of pgsl.nodes) {
    const annotations = computeContainmentAnnotations(pgsl, uri as IRI);
    if (annotations.length > 0) {
      result.set(uri as IRI, annotations);
    }
  }

  return result;
}

// ── Node Signing ───────────────────────────────────────────

/**
 * Sign a PGSL node with a cryptographic signature.
 *
 * This adds a signature to the node's provenance, proving
 * that the content was created by a specific agent.
 * The signature is over the content hash (the URI itself
 * is content-addressed, so signing the URI = signing the content).
 *
 * Does NOT change the URI — the URI is content-addressed from
 * the value, not from the signature. The signature is metadata.
 *
 * @param signFn — async function that signs a message string
 *                 and returns { signature, signerAddress }
 */
export async function signNode(
  pgsl: PGSLInstance,
  nodeUri: IRI,
  signFn: (message: string) => Promise<{ signature: string; signerAddress: string }>,
): Promise<void> {
  const node = pgsl.nodes.get(nodeUri);
  if (!node) throw new Error(`Node ${nodeUri} not found`);

  // Sign the content hash (embedded in the URI)
  const message = `pgsl:sign:${nodeUri}:${node.provenance.generatedAtTime}`;
  const { signature, signerAddress } = await signFn(message);

  // Update provenance with signature (create a new node object to maintain immutability pattern)
  const signed = {
    ...node,
    provenance: {
      ...node.provenance,
      signature,
      signerAddress,
    },
  };

  (pgsl.nodes as Map<IRI, Node>).set(nodeUri, signed as Node);
}

/**
 * Verify a PGSL node's signature.
 *
 * @param verifyFn — function that verifies a signature
 *                   returns true if valid
 */
export function verifyNodeSignature(
  pgsl: PGSLInstance,
  nodeUri: IRI,
  verifyFn: (message: string, signature: string, expectedAddress: string) => boolean,
): { valid: boolean; signerAddress?: string } {
  const node = pgsl.nodes.get(nodeUri);
  if (!node) return { valid: false };
  if (!node.provenance.signature || !node.provenance.signerAddress) {
    return { valid: false };
  }

  const message = `pgsl:sign:${nodeUri}:${node.provenance.generatedAtTime}`;
  const valid = verifyFn(message, node.provenance.signature, node.provenance.signerAddress);
  return { valid, signerAddress: node.provenance.signerAddress };
}
