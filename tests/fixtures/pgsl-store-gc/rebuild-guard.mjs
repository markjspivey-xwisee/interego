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

function fixture({ missing = false, unreadable = false, omitCopy = false, shortInsertCount = false, wrongTableCount = false, busy = false, lockTimeout = false,
  slowCopy = false, timeoutTopology = false, transactionTimeout = false } = {}) {
  const entries = [row(cpKey('ldp css', 'https://pod.example/game/head'), JSON.stringify({ topUri: urn }))];
  if (!missing) entries.push(row(nodeKey(addr), unreadable ? '{invalid JSON' : JSON.stringify({ uri: urn, kind: 'atom', level: 0, value: 'retained' })),
    row(lvKey(0, addr), ''), row(prKey(addr, 2), '{}'));
  const source = new Map(entries.map(r => [hex(r.k), r])), queries = [], initial = [...source.keys()].sort();
  let destination = null, committed = false, rolledBack = false;
  const client = { async query(sql, params = []) {
    queries.push(sql);
    if (sql.startsWith('SELECT pg_try_advisory_lock(')) return { rows: [{ acquired: !busy }], rowCount: 1 };
    if (sql.startsWith('SELECT pg_advisory_unlock(')) return { rows: [{ released: true }], rowCount: 1 };
    if (sql === "SELECT current_setting('transaction_timeout', true) AS transaction_timeout") return { rows: [{ transaction_timeout: transactionTimeout ? '0' : null }], rowCount: 1 };
    if (/^SET LOCAL (?:statement_timeout|transaction_timeout) = '\d+ms'$/.test(sql) || sql === "SET LOCAL idle_in_transaction_session_timeout = '1s'" || sql === 'BEGIN') return { rows: [], rowCount: null };
    if (sql.startsWith('LOCK TABLE ')) {
      if (lockTimeout) throw Object.assign(new Error('could not obtain lock on relation'), { code: '55P03' });
      return { rows: [], rowCount: null };
    }
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
    if (sql.startsWith('SELECT source.k, octet_length(source.v) AS value_bytes,')) {
      if (timeoutTopology) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      return { rows: params[0].map(k => source.get(hex(k))).filter(Boolean).map(r => {
        const node = JSON.parse(r.v.toString('utf8'));
        return { k: r.k, value_bytes: r.v.length, needs_js_parse: false,
          topology: { kind: node.kind, level: node.level, items: node.items ?? null, left: node.left ?? null, right: node.right ?? null } };
      }), rowCount: null };
    }
    if (sql === 'CREATE TABLE pgsl_kv_live (LIKE pgsl_kv INCLUDING ALL)') {
      destination = new Map(); return { rows: [], rowCount: null };
    }
    if (sql.startsWith('SELECT c.reloptions AS heap')) return { rows: [{ heap: null, toast: null }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO pgsl_kv_live ')) {
      if (slowCopy) await new Promise(resolve => setTimeout(resolve, 75));
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
  await assert.rejects(rebuildTable(f.client, 'pgsl_kv', { suffixOld: 'old_fixture', batch: 2 }), options.unreadable
    ? /^Error: refusing collection: PostgreSQL node topology could not be read$/
    : /refusing to rebuild:.*dangling roots.*unreadable nodes/);
  assert.ok(f.queries[0].startsWith('SELECT pg_try_advisory_lock(')); assert.ok(f.queries.includes('BEGIN'));
  assert.ok(f.queries.includes('LOCK TABLE pgsl_kv IN ACCESS EXCLUSIVE MODE NOWAIT'));
  assert.equal(f.queries.at(-2), 'ROLLBACK'); assert.ok(f.queries.at(-1).startsWith('SELECT pg_advisory_unlock(')); assert.equal(f.rolledBack, true); assert.equal(f.committed, false);
  assert.ok(!f.queries.some(sql => /^(CREATE|INSERT|ALTER)/.test(sql)), 'uncertain topology cannot create or swap a replacement');
  assert.deepEqual([...f.source.keys()].sort(), f.initial);
}

for (const options of [{ omitCopy: true }, { shortInsertCount: true }, { wrongTableCount: true }]) {
  const f = fixture(options);
  await assert.rejects(rebuildTable(f.client, 'pgsl_kv', { suffixOld: 'old_fixture', batch: 2 }), /refusing to swap: expected 4 live keys, copied \d+, counted \d+/);
  assert.ok(f.queries.some(sql => sql.startsWith('CREATE TABLE ')));
  assert.ok(f.queries.some(sql => sql.startsWith('INSERT INTO ')));
  assert.equal(f.queries.at(-2), 'ROLLBACK'); assert.ok(f.queries.at(-1).startsWith('SELECT pg_advisory_unlock(')); assert.equal(f.rolledBack, true); assert.equal(f.committed, false);
  assert.ok(!f.queries.some(sql => sql.startsWith('ALTER TABLE ')), 'incomplete copy cannot rename either table');
  assert.deepEqual([...f.source.keys()].sort(), f.initial); assert.equal(f.destination, null);
}

const f = fixture();
assert.deepEqual(await rebuildTable(f.client, 'pgsl_kv', { suffixOld: 'old_fixture', batch: 2 }),
  { copied: 4, oldTable: 'pgsl_kv_old_fixture', newRows: 4 });
assert.deepEqual(f.queries.filter(sql => !sql.startsWith('SET LOCAL ')).slice(-4, -1), ['ALTER TABLE pgsl_kv RENAME TO pgsl_kv_old_fixture', 'ALTER TABLE pgsl_kv_live RENAME TO pgsl_kv', 'COMMIT']);
assert.ok(f.queries.at(-1).startsWith('SELECT pg_advisory_unlock('));
assert.equal(f.committed, true); assert.equal(f.rolledBack, false);
assert.deepEqual([...f.destination.keys()].sort(), f.initial);
const busy = fixture({ busy: true });
await assert.rejects(rebuildTable(busy.client, 'pgsl_kv'), /refusing concurrent collector/);
assert.equal(busy.queries.length, 1, 'another collector must be refused before BEGIN or relation-name lock resolution');
assert.deepEqual([...busy.source.keys()].sort(), busy.initial);
const locked = fixture({ lockTimeout: true });
await assert.rejects(rebuildTable(locked.client, 'pgsl_kv'), /rebuild deferred: live table is busy/);
assert.ok(locked.queries.includes("SET LOCAL idle_in_transaction_session_timeout = '1s'"));
assert.equal(locked.rolledBack, true); assert.equal(locked.committed, false);
assert.ok(!locked.queries.some(sql => /^(CREATE|INSERT|ALTER)/.test(sql)));
assert.ok(locked.queries.at(-1).startsWith('SELECT pg_advisory_unlock('));
for (const options of [{ slowCopy: true }, { timeoutTopology: true }]) {
  const timed = fixture(options);
  await assert.rejects(rebuildTable(timed.client, 'pgsl_kv', { sqlWorkBudgetMs: 50, suffixOld: 'old_fixture', batch: 2 }),
    error => error.code === 'REBUILD_DEFERRED' && error.reason === 'sql-work-budget');
  assert.equal(timed.rolledBack, true); assert.equal(timed.committed, false); assert.equal(timed.destination, null);
  assert.deepEqual([...timed.source.keys()].sort(), timed.initial);
  assert.equal(timed.queries.at(-2), 'ROLLBACK', 'rollback must bypass the expired query wrapper');
  assert.ok(!timed.queries.some(sql => sql.startsWith('ALTER TABLE ')));
  const timeouts = timed.queries.filter(sql => sql.startsWith('SET LOCAL statement_timeout'));
  assert(timeouts.length > 2); assert(timeouts.every(sql => Number(sql.match(/'(\d+)ms'/)[1]) <= 50));
}
const newer = fixture({ transactionTimeout: true });
await rebuildTable(newer.client, 'pgsl_kv', { suffixOld: 'old_fixture' });
assert(newer.queries.some(sql => sql.startsWith('SET LOCAL transaction_timeout = ')));
const older = fixture(); await rebuildTable(older.client, 'pgsl_kv', { suffixOld: 'old_fixture' });
assert(!older.queries.some(sql => sql.startsWith('SET LOCAL transaction_timeout = ')));
for (const sql of older.queries) if (/^(LOCK TABLE|SELECT (?:k, v|source.k|c.reloptions|count\()|CREATE TABLE|INSERT INTO|ALTER TABLE|COMMIT)/.test(sql)) {
  assert(older.queries[older.queries.indexOf(sql) - 1].startsWith('SET LOCAL statement_timeout = '), 'each locked SQL query needs the remaining server timeout');
}
for (const sqlWorkBudgetMs of [0, -1, 5001, Infinity]) await assert.rejects(rebuildTable(fixture().client, 'pgsl_kv', { sqlWorkBudgetMs }), /SQL work budget/);
process.stdout.write('rebuild guard fixtures passed: exact closure/copy guards, bounded rollback, NOWAIT, remaining server timeouts and optional transaction backstop\n');
