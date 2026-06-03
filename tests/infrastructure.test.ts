/**
 * Tests for PGSL Infrastructure: Enclaves, Checkpoints, CRDT Sync
 *
 * Covers:
 *   - Enclave Service (create, fork, freeze, merge, abandon, stats)
 *   - Checkpoint/Recovery (create, restore, diff, list)
 *   - CRDT Sync (vector clocks, operations, sync protocol, stats)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPGSL,
  mintAtom,
  ingest,
  pgslResolve,
  latticeStats,
  embedInPGSL,
} from '@interego/core';
import type { IRI } from '@interego/core';
import type { PGSLInstance, NodeProvenance } from '@interego/core';
import {
  // Enclave
  createEnclaveRegistry,
  createEnclave,
  forkEnclave,
  getEnclave,
  listEnclaves,
  freezeEnclave,
  mergeEnclave,
  abandonEnclave,
  enclaveStats,
  // Checkpoint
  createCheckpointStore,
  createCheckpoint,
  restoreCheckpoint,
  getCheckpoint,
  listCheckpoints,
  diffCheckpoints,
  checkpointStats,
  // CRDT
  createCRDTState,
  incrementClock,
  mergeClock,
  happensBefore,
  createOp,
  applyOp,
  getPendingOps,
  markSynced,
  crdtStats,
} from '@interego/core';
import type {
  EnclaveRegistry,
  CheckpointStore,
  CRDTState,
  VectorClock,
} from '@interego/core';

const TEST_PROV: NodeProvenance = {
  wasAttributedTo: 'did:web:test.example' as IRI,
  generatedAtTime: '2026-04-01T00:00:00Z',
};

// ════════════════════════════════════════════════════════════
// Enclave Service
// ════════════════════════════════════════════════════════════

describe('Enclave Service', () => {
  let registry: EnclaveRegistry;

  beforeEach(() => {
    registry = createEnclaveRegistry();
  });

  describe('createEnclave', () => {
    it('creates enclave with a fresh PGSL instance', () => {
      const enc = createEnclave(registry, 'agent-1', TEST_PROV);
      const stats = latticeStats(enc.pgsl);
      expect(stats.atoms).toBe(0);
      expect(stats.fragments).toBe(0);
    });

    it('has a unique urn:enclave ID', () => {
      const a = createEnclave(registry, 'agent-1', TEST_PROV);
      const b = createEnclave(registry, 'agent-1', TEST_PROV);
      expect(a.id).toMatch(/^urn:enclave:/);
      expect(a.id).not.toBe(b.id);
    });

    it('status is active', () => {
      const enc = createEnclave(registry, 'agent-1', TEST_PROV);
      expect(enc.status).toBe('active');
    });

    it('records the agent ID', () => {
      const enc = createEnclave(registry, 'agent-42', TEST_PROV);
      expect(enc.agentId).toBe('agent-42');
    });

    it('optionally records an agent DID', () => {
      const enc = createEnclave(registry, 'agent-1', TEST_PROV, 'did:web:alice.example');
      expect(enc.agentDid).toBe('did:web:alice.example');
    });
  });

  describe('forkEnclave', () => {
    it('fork copies PGSL state (atoms and fragments)', () => {
      const src = createEnclave(registry, 'agent-1', TEST_PROV);
      mintAtom(src.pgsl, 'hello', TEST_PROV);
      mintAtom(src.pgsl, 'world', TEST_PROV);
      ingest(src.pgsl, ['hello', 'world'], TEST_PROV);

      const fork = forkEnclave(registry, src.id, 'agent-2');
      const srcStats = latticeStats(src.pgsl);
      const forkStats = latticeStats(fork.pgsl);
      expect(forkStats.atoms).toBe(srcStats.atoms);
      expect(forkStats.fragments).toBe(srcStats.fragments);
    });

    it('fork has a different ID from source', () => {
      const src = createEnclave(registry, 'agent-1', TEST_PROV);
      const fork = forkEnclave(registry, src.id, 'agent-2');
      expect(fork.id).not.toBe(src.id);
    });

    it('fork has parentId referencing source', () => {
      const src = createEnclave(registry, 'agent-1', TEST_PROV);
      const fork = forkEnclave(registry, src.id, 'agent-2');
      expect(fork.parentId).toBe(src.id);
    });

    it('modifications to fork do not affect source', () => {
      const src = createEnclave(registry, 'agent-1', TEST_PROV);
      mintAtom(src.pgsl, 'original', TEST_PROV);
      const srcStatsBefore = latticeStats(src.pgsl);

      const fork = forkEnclave(registry, src.id, 'agent-2');
      mintAtom(fork.pgsl, 'fork-only', TEST_PROV);

      const srcStatsAfter = latticeStats(src.pgsl);
      expect(srcStatsAfter.atoms).toBe(srcStatsBefore.atoms);
    });
  });

  describe('freezeEnclave', () => {
    it('status changes to frozen', () => {
      const enc = createEnclave(registry, 'agent-1', TEST_PROV);
      const frozen = freezeEnclave(registry, enc.id);
      expect(frozen.status).toBe('frozen');
    });

    it('cannot freeze a non-active enclave', () => {
      const enc = createEnclave(registry, 'agent-1', TEST_PROV);
      freezeEnclave(registry, enc.id);
      expect(() => freezeEnclave(registry, enc.id)).toThrow();
    });
  });

  describe('mergeEnclave', () => {
    it('union: all atoms from source appear in target', () => {
      const src = createEnclave(registry, 'agent-1', TEST_PROV);
      const tgt = createEnclave(registry, 'agent-2', TEST_PROV);
      mintAtom(src.pgsl, 'alpha', TEST_PROV);
      mintAtom(src.pgsl, 'beta', TEST_PROV);
      mintAtom(tgt.pgsl, 'gamma', TEST_PROV);

      mergeEnclave(registry, src.id, tgt.id, 'union');
      const stats = latticeStats(tgt.pgsl);
      expect(stats.atoms).toBe(3);
    });

    it('intersection: only shared atoms remain', () => {
      const src = createEnclave(registry, 'agent-1', TEST_PROV);
      const tgt = createEnclave(registry, 'agent-2', TEST_PROV);
      mintAtom(src.pgsl, 'shared', TEST_PROV);
      mintAtom(tgt.pgsl, 'shared', TEST_PROV);
      mintAtom(tgt.pgsl, 'target-only', TEST_PROV);

      mergeEnclave(registry, src.id, tgt.id, 'intersection');
      const stats = latticeStats(tgt.pgsl);
      expect(stats.atoms).toBe(1);
    });

    it('returns merge report with counts', () => {
      const src = createEnclave(registry, 'agent-1', TEST_PROV);
      const tgt = createEnclave(registry, 'agent-2', TEST_PROV);
      mintAtom(src.pgsl, 'new-atom', TEST_PROV);

      const report = mergeEnclave(registry, src.id, tgt.id, 'union');
      expect(report.sourceId).toBe(src.id);
      expect(report.targetId).toBe(tgt.id);
      expect(report.operator).toBe('union');
      expect(report.atomsAdded).toBe(1);
      expect(report.atomsBefore).toBe(0);
    });

    it('source is marked as merged afterward', () => {
      const src = createEnclave(registry, 'agent-1', TEST_PROV);
      const tgt = createEnclave(registry, 'agent-2', TEST_PROV);
      mergeEnclave(registry, src.id, tgt.id, 'union');
      const updated = getEnclave(registry, src.id);
      expect(updated?.status).toBe('merged');
    });
  });

  describe('abandonEnclave', () => {
    it('status changes to abandoned', () => {
      const enc = createEnclave(registry, 'agent-1', TEST_PROV);
      const abandoned = abandonEnclave(registry, enc.id);
      expect(abandoned.status).toBe('abandoned');
    });

    it('abandoned enclave still in registry (audit trail)', () => {
      const enc = createEnclave(registry, 'agent-1', TEST_PROV);
      abandonEnclave(registry, enc.id);
      const found = getEnclave(registry, enc.id);
      expect(found).toBeDefined();
      expect(found?.status).toBe('abandoned');
    });
  });

  describe('enclaveStats', () => {
    it('returns counts by status', () => {
      createEnclave(registry, 'agent-1', TEST_PROV);
      createEnclave(registry, 'agent-1', TEST_PROV);
      const enc3 = createEnclave(registry, 'agent-2', TEST_PROV);
      freezeEnclave(registry, enc3.id);

      const stats = enclaveStats(registry);
      expect(stats.total).toBe(3);
      expect(stats.byStatus['active']).toBe(2);
      expect(stats.byStatus['frozen']).toBe(1);
      expect(stats.byAgent['agent-1']).toBe(2);
      expect(stats.byAgent['agent-2']).toBe(1);
    });
  });
});

// ════════════════════════════════════════════════════════════
// Checkpoint/Recovery
// ════════════════════════════════════════════════════════════

describe('Checkpoint/Recovery', () => {
  let store: CheckpointStore;
  let pgsl: PGSLInstance;

  beforeEach(() => {
    store = createCheckpointStore();
    pgsl = createPGSL(TEST_PROV);
  });

  describe('createCheckpoint', () => {
    it('serializes atoms and fragments', () => {
      mintAtom(pgsl, 'hello', TEST_PROV);
      mintAtom(pgsl, 'world', TEST_PROV);
      ingest(pgsl, ['hello', 'world'], TEST_PROV);

      const cp = createCheckpoint(store, pgsl, 'agent-1');
      expect(cp.state.atoms.length).toBeGreaterThan(0);
      expect(cp.state.fragments.length).toBeGreaterThan(0);
    });

    it('has a content hash', () => {
      mintAtom(pgsl, 'data', TEST_PROV);
      const cp = createCheckpoint(store, pgsl, 'agent-1');
      expect(cp.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('atom count matches PGSL', () => {
      mintAtom(pgsl, 'a', TEST_PROV);
      mintAtom(pgsl, 'b', TEST_PROV);
      mintAtom(pgsl, 'c', TEST_PROV);
      const stats = latticeStats(pgsl);
      const cp = createCheckpoint(store, pgsl, 'agent-1');
      expect(cp.atomCount).toBe(stats.atoms);
    });

    it('fragment count matches PGSL', () => {
      ingest(pgsl, ['x', 'y', 'z'], TEST_PROV);
      const stats = latticeStats(pgsl);
      const cp = createCheckpoint(store, pgsl, 'agent-1');
      expect(cp.fragmentCount).toBe(stats.fragments);
    });
  });

  describe('restoreCheckpoint', () => {
    it('restored PGSL has same atom count', () => {
      mintAtom(pgsl, 'alpha', TEST_PROV);
      mintAtom(pgsl, 'beta', TEST_PROV);
      const cp = createCheckpoint(store, pgsl, 'agent-1');

      const restored = restoreCheckpoint(cp);
      expect(latticeStats(restored).atoms).toBe(latticeStats(pgsl).atoms);
    });

    it('restored PGSL has same fragment count', () => {
      ingest(pgsl, ['one', 'two', 'three'], TEST_PROV);
      const cp = createCheckpoint(store, pgsl, 'agent-1');

      const restored = restoreCheckpoint(cp);
      expect(latticeStats(restored).fragments).toBe(latticeStats(pgsl).fragments);
    });

    it('atom values match original', () => {
      const uri = mintAtom(pgsl, 'test-value', TEST_PROV);
      const cp = createCheckpoint(store, pgsl, 'agent-1');

      const restored = restoreCheckpoint(cp);
      const node = restored.nodes.get(uri);
      expect(node).toBeDefined();
      expect(node?.kind).toBe('Atom');
      if (node?.kind === 'Atom') {
        expect(node.value).toBe('test-value');
      }
    });

    it('resolve produces same text from restored PGSL', () => {
      const fragUri = ingest(pgsl, ['hello', 'world'], TEST_PROV);
      const originalText = pgslResolve(pgsl, fragUri);

      const cp = createCheckpoint(store, pgsl, 'agent-1');
      const restored = restoreCheckpoint(cp);
      const restoredText = pgslResolve(restored, fragUri);
      expect(restoredText).toBe(originalText);
    });
  });

  describe('diffCheckpoints', () => {
    it('empty diff when same state', () => {
      mintAtom(pgsl, 'same', TEST_PROV);
      const cp1 = createCheckpoint(store, pgsl, 'agent-1');
      const cp2 = createCheckpoint(store, pgsl, 'agent-1');

      const diff = diffCheckpoints(cp1, cp2);
      expect(diff.atomsAdded).toHaveLength(0);
      expect(diff.atomsRemoved).toHaveLength(0);
      expect(diff.fragmentsAdded).toHaveLength(0);
      expect(diff.fragmentsRemoved).toHaveLength(0);
    });

    it('shows added atoms when state grows', () => {
      mintAtom(pgsl, 'first', TEST_PROV);
      const cp1 = createCheckpoint(store, pgsl, 'agent-1');

      mintAtom(pgsl, 'second', TEST_PROV);
      const cp2 = createCheckpoint(store, pgsl, 'agent-1');

      const diff = diffCheckpoints(cp1, cp2);
      expect(diff.atomsAdded.length).toBe(1);
      expect(diff.atomsRemoved).toHaveLength(0);
    });

    it('shows added fragments', () => {
      const cp1 = createCheckpoint(store, pgsl, 'agent-1');

      ingest(pgsl, ['a', 'b'], TEST_PROV);
      const cp2 = createCheckpoint(store, pgsl, 'agent-1');

      const diff = diffCheckpoints(cp1, cp2);
      expect(diff.fragmentsAdded.length).toBeGreaterThan(0);
    });
  });

  describe('listCheckpoints', () => {
    it('returns all checkpoints', () => {
      createCheckpoint(store, pgsl, 'agent-1');
      createCheckpoint(store, pgsl, 'agent-2');
      createCheckpoint(store, pgsl, 'agent-1');

      const all = listCheckpoints(store);
      expect(all).toHaveLength(3);
    });

    it('filters by agentId', () => {
      createCheckpoint(store, pgsl, 'agent-1');
      createCheckpoint(store, pgsl, 'agent-2');
      createCheckpoint(store, pgsl, 'agent-1');

      const filtered = listCheckpoints(store, 'agent-1');
      expect(filtered).toHaveLength(2);
      expect(filtered.every(c => c.agentId === 'agent-1')).toBe(true);
    });

    it('sorted by creation time', () => {
      createCheckpoint(store, pgsl, 'agent-1');
      createCheckpoint(store, pgsl, 'agent-2');
      createCheckpoint(store, pgsl, 'agent-3');

      const all = listCheckpoints(store);
      for (let i = 1; i < all.length; i++) {
        expect(all[i].createdAt >= all[i - 1].createdAt).toBe(true);
      }
    });
  });
});

// ════════════════════════════════════════════════════════════
// CRDT Sync
// ════════════════════════════════════════════════════════════

describe('CRDT Sync', () => {
  describe('VectorClock', () => {
    it('incrementClock increases local counter', () => {
      let state = createCRDTState('peer-A');
      expect(state.clock.entries.get('peer-A') ?? 0).toBe(0);

      state = incrementClock(state);
      expect(state.clock.entries.get('peer-A')).toBe(1);

      state = incrementClock(state);
      expect(state.clock.entries.get('peer-A')).toBe(2);
    });

    it('mergeClock takes point-wise max', () => {
      const a: VectorClock = { entries: new Map([['p1', 3], ['p2', 1]]) };
      const b: VectorClock = { entries: new Map([['p1', 1], ['p2', 5], ['p3', 2]]) };

      const merged = mergeClock(a, b);
      expect(merged.entries.get('p1')).toBe(3);
      expect(merged.entries.get('p2')).toBe(5);
      expect(merged.entries.get('p3')).toBe(2);
    });

    it('happensBefore detects causal ordering', () => {
      const a: VectorClock = { entries: new Map([['p1', 1], ['p2', 0]]) };
      const b: VectorClock = { entries: new Map([['p1', 2], ['p2', 1]]) };

      expect(happensBefore(a, b)).toBe(true);
      expect(happensBefore(b, a)).toBe(false);
    });

    it('concurrent events: neither happens before the other', () => {
      const a: VectorClock = { entries: new Map([['p1', 2], ['p2', 1]]) };
      const b: VectorClock = { entries: new Map([['p1', 1], ['p2', 2]]) };

      expect(happensBefore(a, b)).toBe(false);
      expect(happensBefore(b, a)).toBe(false);
    });
  });

  describe('Operations', () => {
    let pgsl: PGSLInstance;

    beforeEach(() => {
      pgsl = createPGSL(TEST_PROV);
    });

    it('createOp stamps with current clock', () => {
      let state = createCRDTState('peer-A');
      const result = createOp(state, 'mint-atom', { value: 'hello' });
      // Clock should have been incremented to 1
      expect(result.op.clock.entries.get('peer-A')).toBe(1);
    });

    it('createOp adds to pending', () => {
      let state = createCRDTState('peer-A');
      const r1 = createOp(state, 'mint-atom', { value: 'a' });
      state = r1.state;
      const r2 = createOp(state, 'mint-atom', { value: 'b' });
      state = r2.state;

      const pending = getPendingOps(state);
      expect(pending).toHaveLength(2);
    });

    it('applyOp applies mint-atom to PGSL', () => {
      let state = createCRDTState('peer-A');
      const { state: sA, op } = createOp(state, 'mint-atom', {
        value: 'hello',
        provenance: TEST_PROV,
      });

      let stateB = createCRDTState('peer-B');
      const result = applyOp(stateB, pgsl, op);
      expect(result.applied).toBe(true);
      expect(latticeStats(pgsl).atoms).toBe(1);
    });

    it('applyOp applies ingest-chain to PGSL', () => {
      let state = createCRDTState('peer-A');
      const { state: sA, op } = createOp(state, 'ingest-chain', {
        sequence: ['hello', 'world'],
        provenance: TEST_PROV,
      });

      let stateB = createCRDTState('peer-B');
      const result = applyOp(stateB, pgsl, op);
      expect(result.applied).toBe(true);
      expect(latticeStats(pgsl).fragments).toBeGreaterThan(0);
    });

    it('applyOp is idempotent (skip if already applied)', () => {
      let state = createCRDTState('peer-A');
      const { op } = createOp(state, 'mint-atom', {
        value: 'once',
        provenance: TEST_PROV,
      });

      let stateB = createCRDTState('peer-B');
      const r1 = applyOp(stateB, pgsl, op);
      expect(r1.applied).toBe(true);

      const r2 = applyOp(r1.state, pgsl, op);
      expect(r2.applied).toBe(false);
    });

    it('applyOp merges clocks', () => {
      let stateA = createCRDTState('peer-A');
      const { state: updatedA, op } = createOp(stateA, 'mint-atom', {
        value: 'sync-test',
        provenance: TEST_PROV,
      });

      let stateB = createCRDTState('peer-B');
      stateB = incrementClock(stateB); // B has its own tick

      const result = applyOp(stateB, pgsl, op);
      // After merging, B's clock should include A's counter
      expect(result.state.clock.entries.get('peer-A')).toBe(1);
      // And retain B's own counter
      expect(result.state.clock.entries.get('peer-B')).toBe(1);
    });
  });

  describe('Sync', () => {
    it('getPendingOps returns unsynced ops', () => {
      let state = createCRDTState('peer-A');
      const r1 = createOp(state, 'mint-atom', { value: 'x' });
      state = r1.state;

      const pending = getPendingOps(state);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(r1.op.id);
    });

    it('markSynced clears pending', () => {
      let state = createCRDTState('peer-A');
      const r1 = createOp(state, 'mint-atom', { value: 'x' });
      state = r1.state;
      const r2 = createOp(state, 'mint-atom', { value: 'y' });
      state = r2.state;

      // Mark only first as synced
      state = markSynced(state, [r1.op.id]);
      expect(getPendingOps(state)).toHaveLength(1);
      expect(getPendingOps(state)[0].id).toBe(r2.op.id);

      // Mark second as synced
      state = markSynced(state, [r2.op.id]);
      expect(getPendingOps(state)).toHaveLength(0);
    });

    it('two peers can sync: A creates, B applies, both have same atoms', () => {
      const pgslA = createPGSL(TEST_PROV);
      const pgslB = createPGSL(TEST_PROV);

      let stateA = createCRDTState('peer-A');
      let stateB = createCRDTState('peer-B');

      // A mints two atoms
      const r1 = createOp(stateA, 'mint-atom', { value: 'alpha', provenance: TEST_PROV });
      stateA = r1.state;
      mintAtom(pgslA, 'alpha', TEST_PROV);

      const r2 = createOp(stateA, 'mint-atom', { value: 'beta', provenance: TEST_PROV });
      stateA = r2.state;
      mintAtom(pgslA, 'beta', TEST_PROV);

      // B receives A's ops
      const pending = getPendingOps(stateA);
      for (const op of pending) {
        const result = applyOp(stateB, pgslB, op);
        stateB = result.state;
      }

      // Both should have same atom count
      expect(latticeStats(pgslA).atoms).toBe(latticeStats(pgslB).atoms);
    });

    it('content-addressed: same value minted on both peers = same URI', () => {
      const pgslA = createPGSL(TEST_PROV);
      const pgslB = createPGSL(TEST_PROV);

      const uriA = mintAtom(pgslA, 'shared-value', TEST_PROV);
      const uriB = mintAtom(pgslB, 'shared-value', TEST_PROV);

      expect(uriA).toBe(uriB);
    });
  });

  describe('crdtStats', () => {
    it('reports pending/applied/clock counts', () => {
      let state = createCRDTState('peer-A');
      const r1 = createOp(state, 'mint-atom', { value: 'x' });
      state = r1.state;
      const r2 = createOp(state, 'mint-atom', { value: 'y' });
      state = r2.state;

      const stats = crdtStats(state);
      expect(stats.peerId).toBe('peer-A');
      expect(stats.pendingCount).toBe(2);
      expect(stats.appliedCount).toBe(2); // createOp marks ops as applied locally
      expect(stats.clockEntries['peer-A']).toBe(2);
    });
  });
});
