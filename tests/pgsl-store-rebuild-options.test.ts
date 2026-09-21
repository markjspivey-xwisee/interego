/**
 * A rebuild keeps the table's storage parameters: LIKE ... INCLUDING ALL copies no relation
 * options, so without this the autovacuum tuning would vanish with every weekly rebuild.
 */
import { describe, expect, it } from 'vitest';
import { copyStorageParameters } from '../packages/pgsl-store/src/gc.js';

function fakeClient(heap: unknown, toast: unknown) {
  const sql: string[] = [];
  return {
    sql,
    async query(text: string) {
      sql.push(text);
      return { rows: text.startsWith('SELECT') ? [{ heap, toast }] : [] };
    },
  };
}

describe('storage parameters across a rebuild', () => {
  it('★ applies the heap options and the TOAST options to the new table, prefixed as Postgres wants them', async () => {
    const c = fakeClient(['autovacuum_vacuum_scale_factor=0.02', 'autovacuum_vacuum_threshold=5000'], ['autovacuum_vacuum_scale_factor=0.02']);
    const applied = await copyStorageParameters(c, 'pgsl_kv', 'pgsl_kv_live');
    expect(applied).toEqual(['autovacuum_vacuum_scale_factor=0.02', 'autovacuum_vacuum_threshold=5000', 'toast.autovacuum_vacuum_scale_factor=0.02']);
    expect(c.sql[1]).toBe('ALTER TABLE pgsl_kv_live SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_vacuum_threshold=5000)');
    expect(c.sql[2]).toBe('ALTER TABLE pgsl_kv_live SET (toast.autovacuum_vacuum_scale_factor=0.02)');
  });
  it('alters nothing when the table carries no options, and skips anything that is not name=value', async () => {
    const none = fakeClient(null, null);
    expect(await copyStorageParameters(none, 'pgsl_kv', 'pgsl_kv_live')).toEqual([]);
    expect(none.sql).toHaveLength(1);
    const lines: string[] = [];
    const odd = fakeClient(['fillfactor=90', 'evil=1; DROP TABLE x'], null);
    expect(await copyStorageParameters(odd, 'pgsl_kv', 'pgsl_kv_live', (l) => lines.push(l))).toEqual(['fillfactor=90']);
    expect(lines[0]).toContain('not carried over');
  });
});
