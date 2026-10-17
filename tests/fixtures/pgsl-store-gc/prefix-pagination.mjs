import assert from 'node:assert/strict';
const { readerFromFdb, readerFromPg, hex } = await import(process.argv[2]);
const { cpKey, subspaceRange, nodeKey } = await import(process.argv[3]);
const { InMemoryFdb } = await import(process.argv[4]);
const doc = cpKey('ldp css', 'https://gate.example/u/record.ttl');
const acl = cpKey('ldp css', 'https://gate.example/u/record.ttl.acl');
const trig = cpKey('ldp css', 'https://gate.example/u/record.trig');
const trigAcl = cpKey('ldp css', 'https://gate.example/u/record.trig.acl');
const node = nodeKey({ kind: 'atom', hash: new Uint8Array(20).fill(255) });
const rows = [doc, acl, trig, trigAcl, Uint8Array.from([...doc, 0]),
  Uint8Array.from([...doc, 0, 255]), node, Uint8Array.from([...node, 0]),
  Uint8Array.from([...node, 255])].map(k => ({ k: Buffer.from(k), v: Buffer.from('value:' + hex(k)) }))
  .sort((a, b) => Buffer.compare(a.k, b.k));
const fdb = new InMemoryFdb();
await fdb.transact(async txn => { for (const row of rows) txn.set(row.k, row.v); });
const pg = {
  async query(sql, params) {
    assert(sql.includes('WHERE k >= $1 AND k < $2 ORDER BY k LIMIT $3'));
    const [from, end, limit] = params;
    return { rows: rows.filter(r => Buffer.compare(r.k, from) >= 0 && Buffer.compare(r.k, end) < 0).slice(0, limit) };
  },
};
for (const pageSize of [1, 2, 3]) {
  for (const reader of [readerFromFdb(fdb, pageSize), readerFromPg(pg, 'pgsl_kv', pageSize)]) {
    for (const tag of ['C', 'N']) {
      const { begin, end } = subspaceRange(tag);
      const expected = rows.filter(r => Buffer.compare(r.k, begin) >= 0 && Buffer.compare(r.k, end) < 0)
        .map(r => [hex(r.k), hex(r.v)]);
      const actual = [];
      await reader.scan(begin, end, (k, v) => actual.push([hex(k), hex(v)]));
      assert.deepEqual(actual, expected, `${tag} page size ${pageSize}`);
    }
  }
}
process.stdout.write('Both readers preserve prefix extensions, zero bytes, ACLs and range bounds across page sizes 1/2/3\n');
