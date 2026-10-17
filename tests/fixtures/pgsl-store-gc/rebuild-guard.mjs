import assert from 'node:assert/strict';

// Exercise the real collector and rebuild transaction against a deterministic
// PostgreSQL contract. Each SQL operation either reads the fixture's actual
// byte keys or copies them; an unexpected query fails the fixture.
const { rebuildTable, hex } = await import(process.argv[2]);
const { cpKey, nodeKey, lvKey, prKey } = await import(process.argv[3]);
const urn = 'urn:pgsl:atom:' + 'ab'.repeat(20);
const addr = { kind: 'atom', hash: Uint8Array.from(Buffer.from('ab'.repeat(20), 'hex')) };
const bytes = text => Buffer.from(text);
const row = (k, v) => ({ k: Buffer.from(k), v: bytes(v) });

function fixture({ missing = false, unreadable = false, omitCopy = false, shortInsertCount = false, wrongTableCount = false } = {}) {
  const entries = [row(cpKey('ldp css', 'https://pod.example/game/head'), JSON.stringify({ topUri: urn }))];
  if (!missing) entries.push(row(nodeKey(addr), unreadable ? '{invalid JSON' : JSON.stringify({ uri: urn, kind: 'atom', level: 0, value: 'retained' })),
    row(lvKey(0, addr), ''), row(prKey(addr, 2), '{}'));
  const source = new Map(entries.map(r => [hex(r.k), r])), queries = [], initial = [...source.keys()].sort();
  let destination = null, committed = false, rolledBack = false;
  const client = { async query(sql, params = []) {
    queries.push(sql);
    if (sql === 'BEGIN' || sql.startsWith('LOCK TABLE ')) return { rows: [], rowCount: null };
    if (sql === 'ROLLBACK') { rolledBack = true; destination = null; return { rows: [], rowCount: null }; }
    if (sql === 'COMMIT') { committed = true; return { rows: [], rowCount: null }; }
    if (sql.startsWith('SELECT k, v FROM pgsl_kv WHERE k >= ')) {
      const [begin, end, limit] = params;
      return { rows: [...source.values()].filter(r => Buffer.compare(r.k, begin) >= 0 && Buffer.compare(r.k, end) < 0)
        .sort((a, b) => Buffer.compare(a.k, b.k)).slice(0, limit), rowCount: null };
    }
    if (sql === 'SELECT k, v FROM pgsl_kv WHERE k = ANY($1::bytea[])') {
      return { rows: params[0].map(k => source.get(hex(k))).filter(Boolean), rowCount: null };
    }
    if (sql === 'CREATE TABLE pgsl_kv_live (LIKE pgsl_kv INCLUDING ALL)') {
      destination = new Map(); return { rows: [], rowCount: null };
    }
    if (sql.startsWith('SELECT c.reloptions AS heap')) return { rows: [{ heap: null, toast: null }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO pgsl_kv_live ')) {
      let copied = 0;
      for (const k of params[0]) {
        const key = hex(k), value = source.get(key);
        if (!value || destination.has(key) || (omitCopy && key === hex(lvKey(0, addr)))) continue;
        destination.set(key, value); copied++;
      }
      return { rows: [], rowCount: shortInsertCount && copied > 0 ? copied - 1 : copied };
    }
    if (sql === 'SELECT count(*)::bigint AS n FROM pgsl_kv_live') {
      return { rows: [{ n: String(destination.size - (wrongTableCount ? 1 : 0)) }], rowCount: 1 };
    }
    if (sql === 'ALTER TABLE pgsl_kv RENAME TO pgsl_kv_old_fixture' || sql === 'ALTER TABLE pgsl_kv_live RENAME TO pgsl_kv') return { rows: [], rowCount: null };
    throw new Error('Unexpected fixture SQL: ' + sql);
  } };
  return { client, queries, initial, source, get destination() { return destination; }, get committed() { return committed; }, get rolledBack() { return rolledBack; } };
}

for (const options of [{ missing: true }, { unreadable: true }]) {
  const f = fixture(options);
  await assert.rejects(rebuildTable(f.client, 'pgsl_kv', { suffixOld: 'old_fixture', batch: 2 }), /refusing to rebuild:.*dangling roots.*unreadable nodes/);
  assert.equal(f.queries[0], 'BEGIN');
  assert.ok(f.queries.includes('LOCK TABLE pgsl_kv IN ACCESS EXCLUSIVE MODE'));
  assert.equal(f.queries.at(-1), 'ROLLBACK'); assert.equal(f.rolledBack, true); assert.equal(f.committed, false);
  assert.ok(!f.queries.some(sql => /^(CREATE|INSERT|ALTER)/.test(sql)), 'uncertain topology cannot create or swap a replacement');
  assert.deepEqual([...f.source.keys()].sort(), f.initial);
}

for (const options of [{ omitCopy: true }, { shortInsertCount: true }, { wrongTableCount: true }]) {
  const f = fixture(options);
  await assert.rejects(rebuildTable(f.client, 'pgsl_kv', { suffixOld: 'old_fixture', batch: 2 }), /refusing to swap: expected 4 live keys, copied \d+, counted \d+/);
  assert.ok(f.queries.some(sql => sql.startsWith('CREATE TABLE ')));
  assert.ok(f.queries.some(sql => sql.startsWith('INSERT INTO ')));
  assert.equal(f.queries.at(-1), 'ROLLBACK'); assert.equal(f.rolledBack, true); assert.equal(f.committed, false);
  assert.ok(!f.queries.some(sql => sql.startsWith('ALTER TABLE ')), 'incomplete copy cannot rename either table');
  assert.deepEqual([...f.source.keys()].sort(), f.initial); assert.equal(f.destination, null);
}

const f = fixture();
assert.deepEqual(await rebuildTable(f.client, 'pgsl_kv', { suffixOld: 'old_fixture', batch: 2 }),
  { copied: 4, oldTable: 'pgsl_kv_old_fixture', newRows: 4 });
assert.deepEqual(f.queries.slice(-3), ['ALTER TABLE pgsl_kv RENAME TO pgsl_kv_old_fixture', 'ALTER TABLE pgsl_kv_live RENAME TO pgsl_kv', 'COMMIT']);
assert.equal(f.committed, true); assert.equal(f.rolledBack, false);
assert.deepEqual([...f.destination.keys()].sort(), f.initial);
process.stdout.write('rebuild guard fixtures passed: missing root, unreadable node, omitted row, insert-count mismatch, table-count mismatch, successful swap\n');
