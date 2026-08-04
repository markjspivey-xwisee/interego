/**
 * The in-memory LRS bound must be on the TOTAL, not on either axis alone.
 *
 * ★ WHY. Two rounds each capped one axis and the caps did not compose:
 *     round-36  InMemoryStatementStore.MAX = 50_000 statements PER TENANT
 *     round-38  TenantPartition.MAX        = 20_000 tenant partitions
 * What exhausts the heap is the PRODUCT — 1e9 resident statements. Measured against
 * these exact classes a statement costs ~845 B, so the bridge's 3072 MiB heap is gone
 * at ~3.8 M: 262x below what the caps allow. 20_000 tenants x 191 statements OOMs with
 * the per-tenant cap untouched; 77 tenants x 50_000 OOMs with the tenant cap untouched.
 * Neither guard could reach its own threshold, which is why a foxxi-bridge OOM has only
 * ever surfaced as an unrelated-looking boot failure.
 *
 * These tests pin a SMALL budget rather than allocating a real heap's worth, and every
 * one restores the budget and clears the registry afterwards: vitest runs every file in
 * ONE globalThis here, so a leaked registration would make an unrelated file's evictions
 * depend on run order.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStatementStore,
  FileStatementStore,
  InMemoryStatementStore,
  residentStatementBudget,
  residentStatementCount,
  setResidentStatementBudget,
  resetResidentBudgetRegistryForTest,
  type StatementStore,
  type StoredStatement,
} from '../src/statement-store.js';
import { TenantPartition, type TenantId } from '../src/tenant-context.js';

const ORIGINAL_BUDGET = residentStatementBudget();

afterEach(() => {
  setResidentStatementBudget(ORIGINAL_BUDGET);
  resetResidentBudgetRegistryForTest();
});

const rec = (id: string): StoredStatement => ({
  id,
  statement: { id, actor: { objectType: 'Agent' }, verb: { id: 'http://x/v' }, object: { id: 'http://x/o' } },
  stored: new Date(0).toISOString(),
  voided: false,
} as StoredStatement);

const disposeOf = (s: StatementStore): void => { (s as { dispose?: () => void }).dispose?.(); };

describe('the in-memory LRS budget is process-wide', () => {
  it('bounds the TOTAL across tenants, each of which is far under the old per-store cap', async () => {
    // 50 tenants x 100 statements = 5_000. Every store is 500x below the old 50_000 cap
    // and the partition is 400x below the old 20_000 cap, so the old code evicted NOTHING.
    resetResidentBudgetRegistryForTest();
    setResidentStatementBudget(1_000);
    const stores = new TenantPartition<StatementStore>(
      () => createStatementStore('memory'),
      (s) => disposeOf(s),
    );
    const held: StatementStore[] = [];
    for (let t = 0; t < 50; t++) {
      const s = stores.for(`lens:budget-test-${t}` as TenantId);
      held.push(s);
      for (let i = 0; i < 100; i++) await s.put(rec(`urn:uuid:t${t}-s${i}`));
    }
    // The counter AND the stores themselves — a counter alone would be satisfied by a
    // bug that decrements without deleting.
    let summed = 0;
    for (const s of held) summed += await s.count();
    expect(residentStatementCount()).toBeLessThanOrEqual(1_000);
    expect(summed, 'the STORES must be bounded, not just the counter').toBeLessThanOrEqual(1_000);
    for (const s of held) disposeOf(s);
  });

  it('dispose() returns the budget the partition was holding', async () => {
    resetResidentBudgetRegistryForTest();
    setResidentStatementBudget(1_000);
    const keep = new InMemoryStatementStore();
    const drop = new InMemoryStatementStore();
    for (let i = 0; i < 100; i++) await keep.put(rec(`urn:uuid:keep-${i}`));
    for (let i = 0; i < 100; i++) await drop.put(rec(`urn:uuid:drop-${i}`));
    expect(residentStatementCount()).toBe(200);
    drop.dispose();
    // Without dispose() the budget keeps charging every later write for statements that
    // nothing can read again, and the bridge evicts live tenants to make room for ghosts.
    await keep.put(rec('urn:uuid:keep-after-dispose'));
    expect(residentStatementCount()).toBe(101);
    expect(await keep.get('urn:uuid:keep-0'), 'nothing live may be evicted to pay for a dropped partition').not.toBeNull();
    keep.dispose();
  });

  it('says how close it is to dropping records', async () => {
    // A silently-evicting evidence store is the part a relying party cannot detect: an
    // evicted statement and a fabricated one both answer 404 at rawDataLocation.
    resetResidentBudgetRegistryForTest();
    const s = createStatementStore('memory');
    expect(s.backendDescription()).toMatch(/statements resident process-wide/);
    disposeOf(s);
  });

  it('the FILE backend snapshot is never evicted out from under its own file', async () => {
    resetResidentBudgetRegistryForTest();
    setResidentStatementBudget(1);
    const dir = mkdtempSync(join(tmpdir(), 'foxxi-lrs-budget-'));
    try {
      const file = new FileStatementStore(dir);
      for (let i = 0; i < 10; i++) await file.put(rec(`urn:uuid:file-${i}`));
      // The JSONL file still holds statement 0; if the in-memory read snapshot were
      // budgeted, get() would answer null for durable data.
      expect(await file.get('urn:uuid:file-0')).not.toBeNull();
      expect(await file.count()).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
