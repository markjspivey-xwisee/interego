import { describe, expect, it } from 'vitest';
import { acquireCollectorLock } from '../packages/pgsl-store/src/gc.js';

/** PostgreSQL's session advisory lock contract, including same-session counts. */
function fixture() {
  const held = new Map<string, { owner: symbol; count: number }>();
  function session() {
    const owner = Symbol('database connection'), calls: string[] = [];
    return { calls, async query(sql: string, params: unknown[] = []) {
      calls.push(sql); const key = String(params[0]), prior = held.get(key);
      if (sql.startsWith('SELECT pg_try_advisory_lock(')) {
        const acquired = !prior || prior.owner === owner;
        if (acquired) held.set(key, { owner, count: (prior?.count ?? 0) + 1 });
        return { rows: [{ acquired }] };
      }
      if (sql.startsWith('SELECT pg_advisory_unlock(')) {
        const released = prior?.owner === owner;
        if (released && prior) { if (prior.count === 1) held.delete(key); else held.set(key, { owner, count: prior.count - 1 }); }
        return { rows: [{ released }] };
      }
      throw new Error('Unexpected lock fixture SQL');
    } };
  }
  return { session };
}

describe('collector session serialization', () => {
  it('rejects a second collector until the original session releases, including case aliases of the same SQL table', async () => {
    const f = fixture(), first = f.session(), second = f.session();
    const release = await acquireCollectorLock(first, 'PGSL_KV');
    await expect(acquireCollectorLock(second, 'pgsl_kv')).rejects.toThrow('refusing concurrent collector');
    await release(); await release();
    expect(first.calls.filter(sql => sql.startsWith('SELECT pg_advisory_unlock('))).toHaveLength(1);
    const secondRelease = await acquireCollectorLock(second, 'pgsl_kv'); await secondRelease();
  });

  it('keeps a CLI outer lock while its nested rebuild acquires and releases the same session key', async () => {
    const f = fixture(), cli = f.session(), competitor = f.session();
    const outer = await acquireCollectorLock(cli, 'pgsl_kv');
    const inner = await acquireCollectorLock(cli, 'pgsl_kv');
    await inner();
    await expect(acquireCollectorLock(competitor, 'pgsl_kv')).rejects.toThrow('refusing concurrent collector');
    await outer(); const release = await acquireCollectorLock(competitor, 'pgsl_kv'); await release();
  });

  it('does not serialize distinct table scopes and rejects malformed SQL identifiers before querying', async () => {
    const f = fixture(), first = f.session(), second = f.session();
    const release = await acquireCollectorLock(first, 'pgsl_kv');
    const other = await acquireCollectorLock(second, 'another_store'); await other(); await release();
    const empty = f.session();
    for (const table of ['', 'a.b', 'pgsl_kv; DROP TABLE pgsl_kv', 'a-b']) await expect(acquireCollectorLock(empty, table)).rejects.toThrow('invalid collector table name');
    expect(empty.calls).toHaveLength(0);
  });
});
