/**
 * @module pgsl/infrastructure
 * @description Multi-agent infrastructure for PGSL: enclaves, checkpoints, CRDT sync.
 *
 * Three complementary subsystems:
 *
 *   5. Enclave Service   — DID-bound isolated execution environments.
 *      Agents get isolated PGSL instances. Actions in one enclave don't
 *      affect others until explicitly merged via composition operators.
 *
 *   6. Checkpoint/Recovery — Immutable state snapshots.
 *      Serialize PGSL state to a recoverable snapshot. Checkpoints are
 *      immutable — you create new ones, never modify old ones.
 *
 *   7. Real-time CRDT Sync — Conflict-free replicated data types.
 *      PGSL is a natural grow-only CRDT because atoms are content-addressed
 *      (same value = same URI), fragments are deterministic (same items =
 *      same URI), and you can only ADD, never modify or delete.
 *      Merging two PGSL instances is just union.
 *
 * Connects to:
 *   - lattice.ts: createPGSL, mintAtom, ingest, resolve, latticeStats
 *   - types.ts: PGSLInstance, NodeProvenance, Value
 *   - persistence.ts: progressive persistence for individual nodes
 */

import type { IRI } from '../model/types.js';
import type { PGSLInstance, NodeProvenance, Value } from './types.js';
import { createPGSL, mintAtom, ingest, latticeStats } from './lattice.js';
import { createHash } from 'node:crypto';

// ════════════════════════════════════════════════════════════
// §5  Enclave Service — DID-bound isolated execution environments
// ════════════════════════════════════════════════════════════

// ── Types ──────────────────────────────────────────────────

/** An isolated execution environment for an agent. */
export interface Enclave {
  readonly id: string;        // urn:enclave:{hash}
  readonly agentId: string;
  readonly agentDid?: string; // DID binding
  readonly pgsl: PGSLInstance;
  readonly createdAt: string;
  readonly parentId?: string; // forked from another enclave
  readonly status: 'active' | 'frozen' | 'merged' | 'abandoned';
}

/** Registry of all enclaves. */
export interface EnclaveRegistry {
  readonly enclaves: ReadonlyMap<string, Enclave>;
}

/** Report returned by {@link mergeEnclave}. */
export interface MergeReport {
  readonly sourceId: string;
  readonly targetId: string;
  readonly operator: 'union' | 'intersection';
  readonly atomsAdded: number;
  readonly fragmentsAdded: number;
  readonly atomsBefore: number;
  readonly fragmentsBefore: number;
}

// ── Registry Operations ────────────────────────────────────

/** Create an empty enclave registry. */
export function createEnclaveRegistry(): EnclaveRegistry {
  return { enclaves: new Map() };
}

/**
 * Create a new isolated enclave with a fresh PGSL instance.
 *
 * Each enclave gets its own PGSL lattice — mutations are local
 * until explicitly merged via {@link mergeEnclave}.
 */
export function createEnclave(
  registry: EnclaveRegistry,
  agentId: string,
  provenance: NodeProvenance,
  agentDid?: string,
): Enclave {
  const now = new Date().toISOString();
  const hash = createHash('sha256')
    .update(`enclave:${agentId}:${now}:${Math.random()}`)
    .digest('hex')
    .slice(0, 40);
  const id = `urn:enclave:${hash}`;

  const enclave: Enclave = {
    id,
    agentId,
    agentDid,
    pgsl: createPGSL(provenance),
    createdAt: now,
    status: 'active',
  };

  (registry.enclaves as Map<string, Enclave>).set(id, enclave);
  return enclave;
}

/**
 * Fork an enclave — deep-copy the PGSL state into a new enclave.
 *
 * The new enclave starts with the same atoms and fragments
 * but diverges from there. The parentId records lineage.
 */
export function forkEnclave(
  registry: EnclaveRegistry,
  sourceId: string,
  agentId: string,
): Enclave {
  const source = registry.enclaves.get(sourceId);
  if (!source) throw new Error(`Enclave not found: ${sourceId}`);

  const now = new Date().toISOString();
  const hash = createHash('sha256')
    .update(`enclave:fork:${sourceId}:${agentId}:${now}`)
    .digest('hex')
    .slice(0, 40);
  const id = `urn:enclave:${hash}`;

  // Deep-copy the PGSL state
  const forkedPgsl = createPGSL(source.pgsl.defaultProvenance);
  for (const [key, uri] of source.pgsl.atoms) {
    (forkedPgsl.atoms as Map<string, IRI>).set(key, uri);
  }
  for (const [key, uri] of source.pgsl.fragments) {
    (forkedPgsl.fragments as Map<string, IRI>).set(key, uri);
  }
  for (const [uri, node] of source.pgsl.nodes) {
    (forkedPgsl.nodes as Map<IRI, any>).set(uri, node);
  }

  const enclave: Enclave = {
    id,
    agentId,
    pgsl: forkedPgsl,
    createdAt: now,
    parentId: sourceId,
    status: 'active',
  };

  (registry.enclaves as Map<string, Enclave>).set(id, enclave);
  return enclave;
}

/** Look up an enclave by ID. */
export function getEnclave(registry: EnclaveRegistry, id: string): Enclave | undefined {
  return registry.enclaves.get(id);
}

/** List enclaves, optionally filtered by agent. */
export function listEnclaves(registry: EnclaveRegistry, agentId?: string): Enclave[] {
  const all = [...registry.enclaves.values()];
  if (!agentId) return all;
  return all.filter(e => e.agentId === agentId);
}

/**
 * Freeze an enclave — mark it read-only.
 *
 * Frozen enclaves cannot be mutated. Freeze before merge review
 * to ensure no concurrent writes during the merge window.
 */
export function freezeEnclave(registry: EnclaveRegistry, id: string): Enclave {
  const enclave = registry.enclaves.get(id);
  if (!enclave) throw new Error(`Enclave not found: ${id}`);
  if (enclave.status !== 'active') {
    throw new Error(`Cannot freeze enclave with status '${enclave.status}'`);
  }

  const frozen: Enclave = { ...enclave, status: 'frozen' };
  (registry.enclaves as Map<string, Enclave>).set(id, frozen);
  return frozen;
}

/**
 * Merge source enclave into target enclave using a composition operator.
 *
 * - 'union': copy all atoms and fragments from source into target (grow-only)
 * - 'intersection': keep only atoms/fragments that exist in both
 *
 * Returns a {@link MergeReport} describing what changed.
 * Marks the source as 'merged' afterward.
 */
export function mergeEnclave(
  registry: EnclaveRegistry,
  sourceId: string,
  targetId: string,
  operator: 'union' | 'intersection',
): MergeReport {
  const source = registry.enclaves.get(sourceId);
  const target = registry.enclaves.get(targetId);
  if (!source) throw new Error(`Source enclave not found: ${sourceId}`);
  if (!target) throw new Error(`Target enclave not found: ${targetId}`);
  if (target.status !== 'active') {
    throw new Error(`Target enclave must be active, got '${target.status}'`);
  }

  const statsBefore = latticeStats(target.pgsl);
  const atomsBefore = statsBefore.atoms;
  const fragmentsBefore = statsBefore.fragments;

  if (operator === 'union') {
    // Add all atoms from source into target
    for (const [key, uri] of source.pgsl.atoms) {
      (target.pgsl.atoms as Map<string, IRI>).set(key, uri);
    }
    for (const [key, uri] of source.pgsl.fragments) {
      (target.pgsl.fragments as Map<string, IRI>).set(key, uri);
    }
    for (const [uri, node] of source.pgsl.nodes) {
      (target.pgsl.nodes as Map<IRI, any>).set(uri, node);
    }
  } else {
    // Intersection: keep only what exists in both
    const targetAtoms = target.pgsl.atoms as Map<string, IRI>;
    for (const [key] of targetAtoms) {
      if (!source.pgsl.atoms.has(key)) {
        const uri = targetAtoms.get(key)!;
        targetAtoms.delete(key);
        (target.pgsl.nodes as Map<IRI, any>).delete(uri);
      }
    }
    const targetFragments = target.pgsl.fragments as Map<string, IRI>;
    for (const [key] of targetFragments) {
      if (!source.pgsl.fragments.has(key)) {
        const uri = targetFragments.get(key)!;
        targetFragments.delete(key);
        (target.pgsl.nodes as Map<IRI, any>).delete(uri);
      }
    }
  }

  // Mark source as merged
  const merged: Enclave = { ...source, status: 'merged' };
  (registry.enclaves as Map<string, Enclave>).set(sourceId, merged);

  const statsAfter = latticeStats(target.pgsl);

  return {
    sourceId,
    targetId,
    operator,
    atomsAdded: statsAfter.atoms - atomsBefore,
    fragmentsAdded: statsAfter.fragments - fragmentsBefore,
    atomsBefore,
    fragmentsBefore,
  };
}

/**
 * Abandon an enclave — mark it as abandoned.
 *
 * Abandoned enclaves are not deleted (audit trail) but cannot
 * be mutated or merged further.
 */
export function abandonEnclave(registry: EnclaveRegistry, id: string): Enclave {
  const enclave = registry.enclaves.get(id);
  if (!enclave) throw new Error(`Enclave not found: ${id}`);
  if (enclave.status === 'merged') {
    throw new Error(`Cannot abandon a merged enclave`);
  }

  const abandoned: Enclave = { ...enclave, status: 'abandoned' };
  (registry.enclaves as Map<string, Enclave>).set(id, abandoned);
  return abandoned;
}

/** Enclave statistics: total count, breakdown by status and by agent. */
export function enclaveStats(registry: EnclaveRegistry): {
  total: number;
  byStatus: Record<string, number>;
  byAgent: Record<string, number>;
} {
  const byStatus: Record<string, number> = {};
  const byAgent: Record<string, number> = {};

  for (const enclave of registry.enclaves.values()) {
    byStatus[enclave.status] = (byStatus[enclave.status] ?? 0) + 1;
    byAgent[enclave.agentId] = (byAgent[enclave.agentId] ?? 0) + 1;
  }

  return { total: registry.enclaves.size, byStatus, byAgent };
}

// ════════════════════════════════════════════════════════════
// §6  Checkpoint/Recovery — immutable state snapshots
// ════════════════════════════════════════════════════════════

// ── Types ──────────────────────────────────────────────────

/** Serialized PGSL state — all atoms and fragments as plain data. */
export interface CheckpointState {
  readonly atoms: ReadonlyArray<{
    key: string;
    uri: string;
    value: string | number | boolean;
    provenance: NodeProvenance;
  }>;
  readonly fragments: ReadonlyArray<{
    key: string;
    uri: string;
    level: number;
    height: number;
    items: string[];
    left?: string;
    right?: string;
    provenance: NodeProvenance;
  }>;
}

/** An immutable snapshot of PGSL state at a point in time. */
export interface Checkpoint {
  readonly id: string;           // urn:checkpoint:{hash}
  readonly enclaveId?: string;
  readonly agentId: string;
  readonly createdAt: string;
  readonly atomCount: number;
  readonly fragmentCount: number;
  readonly maxLevel: number;
  readonly state: CheckpointState;
  readonly contentHash: string;
  readonly label?: string;
}

/** Ordered store of immutable checkpoints. */
export interface CheckpointStore {
  readonly checkpoints: readonly Checkpoint[];
}

/** Result of comparing two checkpoints. */
export interface CheckpointDiff {
  readonly atomsAdded: string[];    // URIs in b but not a
  readonly atomsRemoved: string[];  // URIs in a but not b
  readonly fragmentsAdded: string[];
  readonly fragmentsRemoved: string[];
}

// ── Store Operations ───────────────────────────────────────

/** Create an empty checkpoint store. */
export function createCheckpointStore(): CheckpointStore {
  return { checkpoints: [] };
}

/**
 * Snapshot the current PGSL state into an immutable checkpoint.
 *
 * Serializes all atoms and fragments into plain data structures.
 * Computes a content hash over the serialized state for integrity
 * verification.
 */
export function createCheckpoint(
  store: CheckpointStore,
  pgsl: PGSLInstance,
  agentId: string,
  label?: string,
  enclaveId?: string,
): Checkpoint {
  // Serialize atoms
  const atoms: CheckpointState['atoms'][number][] = [];
  for (const [key, uri] of pgsl.atoms) {
    const node = pgsl.nodes.get(uri);
    if (!node || node.kind !== 'Atom') continue;
    atoms.push({
      key,
      uri,
      value: node.value,
      provenance: node.provenance,
    });
  }

  // Serialize fragments
  const fragments: CheckpointState['fragments'][number][] = [];
  for (const [key, uri] of pgsl.fragments) {
    const node = pgsl.nodes.get(uri);
    if (!node || node.kind !== 'Fragment') continue;
    fragments.push({
      key,
      uri,
      level: node.level,
      height: node.height,
      items: [...node.items],
      left: node.left,
      right: node.right,
      provenance: node.provenance,
    });
  }

  const state: CheckpointState = { atoms, fragments };

  // Compute content hash of the serialized state
  const serialized = JSON.stringify(state);
  const contentHash = createHash('sha256').update(serialized).digest('hex');

  // Compute stats
  const stats = latticeStats(pgsl);
  const now = new Date().toISOString();
  const idHash = createHash('sha256')
    .update(`checkpoint:${agentId}:${now}:${contentHash}`)
    .digest('hex')
    .slice(0, 40);

  const checkpoint: Checkpoint = {
    id: `urn:checkpoint:${idHash}`,
    enclaveId,
    agentId,
    createdAt: now,
    atomCount: stats.atoms,
    fragmentCount: stats.fragments,
    maxLevel: stats.maxLevel,
    state,
    contentHash,
    label,
  };

  (store.checkpoints as Checkpoint[]).push(checkpoint);
  return checkpoint;
}

/**
 * Rebuild a PGSL instance from a checkpoint.
 *
 * Reconstructs the full lattice by replaying all atoms and fragments
 * from the serialized state. The resulting instance is identical
 * to the original (content-addressing guarantees this).
 */
export function restoreCheckpoint(checkpoint: Checkpoint): PGSLInstance {
  // Use provenance from the first atom, or a default
  const firstAtom = checkpoint.state.atoms[0];
  const provenance: NodeProvenance = firstAtom
    ? firstAtom.provenance
    : {
        wasAttributedTo: `did:agent:${checkpoint.agentId}` as IRI,
        generatedAtTime: checkpoint.createdAt,
      };

  const pgsl = createPGSL(provenance);

  // Restore atoms
  for (const atom of checkpoint.state.atoms) {
    const atomNode = {
      kind: 'Atom' as const,
      uri: atom.uri as IRI,
      value: atom.value,
      level: 0 as const,
      provenance: atom.provenance,
    };
    (pgsl.atoms as Map<string, IRI>).set(atom.key, atom.uri as IRI);
    (pgsl.nodes as Map<IRI, any>).set(atom.uri as IRI, atomNode);
  }

  // Restore fragments
  for (const frag of checkpoint.state.fragments) {
    const fragNode = {
      kind: 'Fragment' as const,
      uri: frag.uri as IRI,
      level: frag.level,
      height: frag.height,
      items: frag.items.map(i => i as IRI),
      left: frag.left as IRI | undefined,
      right: frag.right as IRI | undefined,
      provenance: frag.provenance,
    };
    (pgsl.fragments as Map<string, IRI>).set(frag.key, frag.uri as IRI);
    (pgsl.nodes as Map<IRI, any>).set(frag.uri as IRI, fragNode);
  }

  return pgsl;
}

/** Look up a checkpoint by ID. */
export function getCheckpoint(store: CheckpointStore, id: string): Checkpoint | undefined {
  return store.checkpoints.find(c => c.id === id);
}

/**
 * List checkpoints, optionally filtered by agent and/or enclave.
 * Returns results sorted by creation time (oldest first).
 */
export function listCheckpoints(
  store: CheckpointStore,
  agentId?: string,
  enclaveId?: string,
): Checkpoint[] {
  let result = [...store.checkpoints];
  if (agentId) result = result.filter(c => c.agentId === agentId);
  if (enclaveId) result = result.filter(c => c.enclaveId === enclaveId);
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Compare two checkpoints: atoms and fragments added or removed.
 *
 * Useful for understanding what changed between two points in time
 * or between two agents' views of the lattice.
 */
export function diffCheckpoints(a: Checkpoint, b: Checkpoint): CheckpointDiff {
  const aAtomUris = new Set(a.state.atoms.map(x => x.uri));
  const bAtomUris = new Set(b.state.atoms.map(x => x.uri));
  const aFragUris = new Set(a.state.fragments.map(x => x.uri));
  const bFragUris = new Set(b.state.fragments.map(x => x.uri));

  return {
    atomsAdded: [...bAtomUris].filter(u => !aAtomUris.has(u)),
    atomsRemoved: [...aAtomUris].filter(u => !bAtomUris.has(u)),
    fragmentsAdded: [...bFragUris].filter(u => !aFragUris.has(u)),
    fragmentsRemoved: [...aFragUris].filter(u => !bFragUris.has(u)),
  };
}

/** Checkpoint statistics: total count and latest checkpoint per agent. */
export function checkpointStats(store: CheckpointStore): {
  total: number;
  latestPerAgent: Record<string, string>; // agentId → checkpoint ID
} {
  const latestPerAgent: Record<string, string> = {};

  // Checkpoints are appended in order, so last one per agent wins
  for (const cp of store.checkpoints) {
    latestPerAgent[cp.agentId] = cp.id;
  }

  return { total: store.checkpoints.length, latestPerAgent };
}

// ════════════════════════════════════════════════════════════
// §7  Real-time CRDT Sync
// ════════════════════════════════════════════════════════════

// ── Types ──────────────────────────────────────────────────

/** A vector clock for tracking causality across peers. */
export interface VectorClock {
  readonly entries: ReadonlyMap<string, number>; // agentId -> counter
}

/** A CRDT operation on the lattice. */
export interface CRDTOperation {
  readonly id: string;
  readonly type: 'mint-atom' | 'ingest-chain' | 'add-constraint';
  readonly agentId: string;
  readonly timestamp: string;
  readonly clock: VectorClock;
  readonly payload: any;
}

/** CRDT state for a shared lattice peer. */
export interface CRDTState {
  readonly peerId: string;
  readonly clock: VectorClock;
  readonly pendingOps: readonly CRDTOperation[];
  readonly appliedOps: ReadonlySet<string>; // op IDs already applied
}

/** Result of applying a CRDT operation. */
export interface ApplyResult {
  readonly state: CRDTState;
  readonly applied: boolean;
}

// ── Vector Clock Operations ────────────────────────────────

/** Create a fresh vector clock with no entries. */
function createVectorClock(): VectorClock {
  return { entries: new Map() };
}

/** Get the counter for a specific peer in a vector clock. */
function clockGet(clock: VectorClock, peerId: string): number {
  return clock.entries.get(peerId) ?? 0;
}

// ── CRDT State Operations ──────────────────────────────────

/** Initialize CRDT state for a new peer. */
export function createCRDTState(peerId: string): CRDTState {
  return {
    peerId,
    clock: createVectorClock(),
    pendingOps: [],
    appliedOps: new Set(),
  };
}

/**
 * Tick the local clock — increment this peer's counter.
 *
 * Called before creating a new operation. Ensures causal ordering:
 * each local operation gets a strictly increasing timestamp.
 */
export function incrementClock(state: CRDTState): CRDTState {
  const current = clockGet(state.clock, state.peerId);
  const newEntries = new Map(state.clock.entries);
  newEntries.set(state.peerId, current + 1);
  return { ...state, clock: { entries: newEntries } };
}

/**
 * Merge two vector clocks — point-wise maximum.
 *
 * The merge of two clocks captures "everything both peers have seen".
 * This is the join (least upper bound) in the partial order of clocks.
 */
export function mergeClock(a: VectorClock, b: VectorClock): VectorClock {
  const merged = new Map(a.entries);
  for (const [peerId, counter] of b.entries) {
    const existing = merged.get(peerId) ?? 0;
    merged.set(peerId, Math.max(existing, counter));
  }
  return { entries: merged };
}

/**
 * Causal ordering check: does clock a happen-before clock b?
 *
 * a happens-before b iff:
 *   - For all peers p: a[p] <= b[p]
 *   - There exists some peer p where a[p] < b[p]
 *
 * If neither a < b nor b < a, the events are concurrent.
 */
export function happensBefore(a: VectorClock, b: VectorClock): boolean {
  // Collect all peer IDs from both clocks
  const allPeers = new Set([...a.entries.keys(), ...b.entries.keys()]);

  let strictlyLess = false;
  for (const peer of allPeers) {
    const aVal = clockGet(a, peer);
    const bVal = clockGet(b, peer);
    if (aVal > bVal) return false; // a is not <= b for this peer
    if (aVal < bVal) strictlyLess = true;
  }

  return strictlyLess;
}

/**
 * Create a CRDT operation with the current vector clock.
 *
 * Increments the local clock, then creates an operation stamped
 * with the new clock value. The operation is added to pendingOps
 * for later broadcast.
 *
 * @param state - Current CRDT state (will be incremented)
 * @param type - Operation type
 * @param payload - Operation-specific data
 * @returns Tuple of [updatedState, operation]
 */
export function createOp(
  state: CRDTState,
  type: CRDTOperation['type'],
  payload: any,
): { state: CRDTState; op: CRDTOperation } {
  // Increment local clock
  const ticked = incrementClock(state);

  const now = new Date().toISOString();
  const opHash = createHash('sha256')
    .update(`op:${ticked.peerId}:${type}:${now}:${JSON.stringify(payload)}`)
    .digest('hex')
    .slice(0, 40);

  const op: CRDTOperation = {
    id: `urn:crdt:op:${opHash}`,
    type,
    agentId: ticked.peerId,
    timestamp: now,
    clock: ticked.clock,
    payload,
  };

  // Add to pending (not yet broadcast)
  const updatedState: CRDTState = {
    ...ticked,
    pendingOps: [...ticked.pendingOps, op],
    appliedOps: new Set([...ticked.appliedOps, op.id]),
  };

  return { state: updatedState, op };
}

/**
 * Apply a remote CRDT operation to the local PGSL instance.
 *
 * Idempotent: if the operation has already been applied, it is skipped.
 *
 * Since PGSL is add-only and content-addressed, there are no conflicts:
 *   - mint-atom: same value = same URI, so duplicate mints are no-ops
 *   - ingest-chain: same sequence = same fragments, so duplicate ingests are no-ops
 *   - add-constraint: constraints are additive
 *
 * The vector clock is merged to track causal progress.
 */
export function applyOp(
  state: CRDTState,
  pgsl: PGSLInstance,
  op: CRDTOperation,
): ApplyResult {
  // Already applied — skip (idempotent)
  if (state.appliedOps.has(op.id)) {
    return { state, applied: false };
  }

  // Apply the operation to the PGSL instance
  switch (op.type) {
    case 'mint-atom': {
      const { value, provenance } = op.payload as {
        value: Value;
        provenance?: NodeProvenance;
      };
      mintAtom(pgsl, value, provenance ?? pgsl.defaultProvenance);
      break;
    }
    case 'ingest-chain': {
      const { sequence, provenance } = op.payload as {
        sequence: readonly (Value | IRI)[];
        provenance?: NodeProvenance;
      };
      ingest(pgsl, sequence, provenance ?? pgsl.defaultProvenance);
      break;
    }
    case 'add-constraint': {
      // Constraints are extensible — payload is stored as-is.
      // The constraint system can interpret these later.
      // For now, this is a recognized op type that doesn't
      // modify the lattice directly.
      break;
    }
  }

  // Merge the remote clock into our local clock
  const mergedClock = mergeClock(state.clock, op.clock);

  const updatedState: CRDTState = {
    ...state,
    clock: mergedClock,
    appliedOps: new Set([...state.appliedOps, op.id]),
  };

  return { state: updatedState, applied: true };
}

/**
 * Get operations created locally but not yet broadcast to peers.
 *
 * These should be sent to other peers for replication.
 * After sending, call {@link markSynced} to clear them.
 */
export function getPendingOps(state: CRDTState): CRDTOperation[] {
  return [...state.pendingOps];
}

/**
 * Mark operations as synced — remove them from the pending queue.
 *
 * Called after successfully broadcasting operations to peers.
 * Only removes ops whose IDs are in the provided set.
 */
export function markSynced(state: CRDTState, opIds: readonly string[]): CRDTState {
  const syncedSet = new Set(opIds);
  return {
    ...state,
    pendingOps: state.pendingOps.filter(op => !syncedSet.has(op.id)),
  };
}

/** CRDT statistics: pending count, applied count, clock state. */
export function crdtStats(state: CRDTState): {
  peerId: string;
  pendingCount: number;
  appliedCount: number;
  clockEntries: Record<string, number>;
} {
  const clockEntries: Record<string, number> = {};
  for (const [peer, counter] of state.clock.entries) {
    clockEntries[peer] = counter;
  }

  return {
    peerId: state.peerId,
    pendingCount: state.pendingOps.length,
    appliedCount: state.appliedOps.size,
    clockEntries,
  };
}
