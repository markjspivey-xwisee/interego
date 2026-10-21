import { describe, expect, it } from 'vitest';
import { InMemoryFdb, openStore, publicAtomAddress, type StoredNode } from '../packages/pgsl-store/src/index.js';
import { collectLive, hex, readerFromFdb, readerFromPg, type KvReader, type NodeTopology, type NodeTopologyRecord } from '../packages/pgsl-store/src/gc.js';
import { nodeAddrFromUrn } from '../packages/pgsl-store/src/addressing.js';
import { nodeKey, prKey } from '../packages/pgsl-store/src/keyspace.js';

const encoder = new TextEncoder();
const projectionFailure = 'refusing collection: PostgreSQL node topology could not be read';
const atom = (value: string): StoredNode => ({ uri: publicAtomAddress(value), kind: 'atom', level: 0, value,
  provenance: { note: 'private provenance does not belong in a traversal response'.repeat(256) } });

async function fixture() {
  const fdb = new InMemoryFdb();
  const store = openStore(fdb);
  const atoms = Array.from({ length: 70 }, (_, index) => atom(`${index}:` + 'opaque ciphertext payload;'.repeat(1024)));
  const left: StoredNode = { uri: 'urn:pgsl:fragment:' + 'a'.repeat(40), kind: 'fragment', level: 1,
    items: atoms.slice(0, 35).map(node => node.uri) };
  const right: StoredNode = { uri: 'urn:pgsl:fragment:' + 'b'.repeat(40), kind: 'fragment', level: 1,
    items: atoms.slice(35).map(node => node.uri) };
  const top: StoredNode = { uri: 'urn:pgsl:fragment:' + 'c'.repeat(40), kind: 'fragment', level: 2, left: left.uri, right: right.uri };
  const nodes = [...atoms, left, right, top];
  await store.compose(nodes, { pod: 'test-pod', resource: 'current' });
  await store.cpSet('ldp test-pod', 'current', { topUri: top.uri });
  const attributed = atom('rooted only by an attribute');
  await store.put(attributed);
  await store.putAtomAttributes('scope', attributed.uri, { classification: 0 });
  const pinned = atom('rooted only by a non-derived persistence tier');
  await store.put(pinned);
  await fdb.transact(async transaction => transaction.set(prKey(nodeAddrFromUrn(pinned.uri), 1), encoder.encode('pin')));
  const deleted = atom('stale overlay and unreachable payload');
  await store.compose([deleted], { pod: 'test-pod', resource: 'deleted' });
  await store.cpSet('ldp test-pod', 'deleted', { topUri: deleted.uri });
  await store.cpDelete('ldp test-pod', 'deleted');
  nodes.push(attributed, pinned, deleted);
  return { fdb, atoms, nodes };
}

function topology(node: StoredNode): NodeTopology {
  return { kind: node.kind, level: node.level,
    ...(node.kind === 'fragment' ? { items: node.items, left: node.left, right: node.right } : {}) };
}

function projectedFixture(fdb: InMemoryFdb, nodes: StoredNode[], unreadableKeys = new Set<string>()) {
  const raw = readerFromFdb(fdb, 3);
  const known = new Map(nodes.map(node => [hex(nodeKey(nodeAddrFromUrn(node.uri))), topology(node)]));
  const batches: number[] = [];
  let responseBytes = 0;
  const reader: KvReader = {
    scan: raw.scan,
    async getMany() { throw new Error('full node payloads must not be fetched when topology is available'); },
    async getManyTopology(keys) {
      batches.push(keys.length);
      const values = await raw.getMany(keys), projected = new Map<string, NodeTopologyRecord>();
      for (const [key, value] of values) {
        const row = { topology: unreadableKeys.has(key) ? null : known.get(key) ?? null, byteLength: value.length };
        responseBytes += encoder.encode(JSON.stringify(row)).length;
        projected.set(key, row);
      }
      return projected;
    },
  };
  return { reader, batches, responseBytes: () => responseBytes };
}

describe('pgsl collector topology traversal', () => {
  it('matches the complete-byte live set and original byte statistics without exporting atom payloads', async () => {
    const { fdb, nodes } = await fixture();
    const complete = await collectLive(readerFromFdb(fdb, 3));
    const projected = projectedFixture(fdb, nodes);
    const result = await collectLive(projected.reader);
    expect([...result.keys].sort()).toEqual([...complete.keys].sort());
    expect(result.stats).toEqual(complete.stats);
    expect(result.stats.liveNodeBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(result.stats.staleOverlays).toBe(1);
    expect(result.stats.danglingRoots).toEqual([]);
    expect(result.stats.unreadableNodes).toBe(0);
    expect(projected.batches.length).toBeGreaterThan(2);
    expect(Math.max(...projected.batches)).toBeLessThanOrEqual(32);
    expect(projected.responseBytes()).toBeLessThan(result.stats.liveNodeBytes / 20);
  });

  it('preserves missing-node and unreadable-node closure warnings rather than inventing an empty node', async () => {
    const { fdb, nodes, atoms } = await fixture();
    const missing = nodeKey(nodeAddrFromUrn(atoms[0]!.uri));
    const unreadable = nodeKey(nodeAddrFromUrn(atoms[1]!.uri));
    await fdb.transact(async transaction => {
      transaction.clear(missing);
      transaction.set(unreadable, encoder.encode('invalid JSON'));
    });
    const complete = await collectLive(readerFromFdb(fdb));
    const result = await collectLive(projectedFixture(fdb, nodes, new Set([hex(unreadable)])).reader);
    expect([...result.keys].sort()).toEqual([...complete.keys].sort());
    expect(result.stats).toEqual(complete.stats);
    expect(result.stats.danglingRoots).toEqual([atoms[0]!.uri]);
    expect(result.stats.unreadableNodes).toBe(1);
    expect(result.keys.has(hex(missing))).toBe(false);
    expect(result.keys.has(hex(unreadable))).toBe(true);
  });

  it('treats invalid UTF8 inside an otherwise valid JSON string as unreadable in both traversal paths', async () => {
    const { fdb, nodes, atoms } = await fixture();
    const key = nodeKey(nodeAddrFromUrn(atoms[0]!.uri));
    const bytes = Buffer.concat([Buffer.from('{"kind":"atom","level":0,"value":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    await fdb.transact(async transaction => transaction.set(key, bytes));
    const complete = await collectLive(readerFromFdb(fdb));
    const projected = await collectLive(projectedFixture(fdb, nodes, new Set([hex(key)])).reader);
    expect(complete.stats.unreadableNodes).toBe(1);
    expect(projected.stats).toEqual(complete.stats);
    expect([...projected.keys].sort()).toEqual([...complete.keys].sort());
    expect(projected.keys.has(hex(key))).toBe(true);
  });

  it('bounds PostgreSQL projection batches and retains exact original byte sizes', async () => {
    const batches: number[] = [];
    const reader = readerFromPg({ async query(_sql, params) {
      const keys = params?.[0] as Buffer[];
      batches.push(keys.length);
      return { rows: keys.map(k => ({ k, value_bytes: 4 * 1024 * 1024, needs_js_parse: false, topology: { kind: 'atom', level: 0 } })) };
    } });
    const keys = Array.from({ length: 65 }, (_, index) => encoder.encode(`node:${index}`));
    const result = await reader.getManyTopology!(keys);
    expect(batches).toEqual([32, 32, 1]);
    expect(result.size).toBe(65);
    expect(result.get(hex(keys[64]!))).toEqual({ topology: { kind: 'atom', level: 0 }, byteLength: 4 * 1024 * 1024 });
  });

  it('fetches only exceptional Unicode-escape rows and validates their original bytes in JavaScript', async () => {
    const normalKey = Buffer.from(nodeKey(nodeAddrFromUrn(publicAtomAddress('normal-large-node'))));
    for (const value of ['\u0000', '\ud800', 'literal \\u text']) {
      const uri = publicAtomAddress(value), escapedKey = Buffer.from(nodeKey(nodeAddrFromUrn(uri)));
      const bytes = Buffer.from(JSON.stringify({ uri, kind: 'atom', level: 0, value }));
      let rawReads = 0;
      const reader = readerFromPg({ async query(sql, params) {
        if (sql.includes('octet_length')) return { rows: [
          { k: normalKey, value_bytes: 8 * 1024 * 1024, needs_js_parse: false, topology: { kind: 'atom', level: 0 } },
          { k: escapedKey, value_bytes: bytes.length, needs_js_parse: true, topology: null },
        ] };
        rawReads += 1;
        expect(params?.[0]).toEqual([escapedKey]);
        return { rows: [{ k: escapedKey, v: bytes }] };
      } });
      const result = await reader.getManyTopology!([normalKey, escapedKey]);
      expect(result.size).toBe(2);
      expect(rawReads).toBe(1);
      expect(result.get(hex(escapedKey))).toEqual({ topology: { kind: 'atom', level: 0 }, byteLength: bytes.length });
      expect(result.get(hex(normalKey))?.byteLength).toBe(8 * 1024 * 1024);
    }
  });

  it('refuses malformed exceptional bytes, missing fallback rows and changed byte lengths', async () => {
    const key = Buffer.from('exceptional-node');
    for (const [stored, declaredLength] of [
      [Buffer.from('{"kind":"atom","value":"PRIVATE_INVALID_JSON",'), undefined],
      [Buffer.from([0xff, 0xfe]), undefined],
      [undefined, 12],
      [Buffer.from('{"kind":"atom","level":0}'), 12],
    ] as const) {
      const reader = readerFromPg({ async query(sql) {
        if (sql.includes('octet_length')) return { rows: [{ k: key, value_bytes: declaredLength ?? stored!.length,
          needs_js_parse: true, topology: null }] };
        return { rows: stored === undefined ? [] : [{ k: key, v: stored }] };
      } });
      await expect(reader.getManyTopology!([key])).rejects.toThrow(projectionFailure);
    }
  });

  it('scrubs PostgreSQL parse failures and refuses malformed byte-count projections', async () => {
    const privateSnippet = 'PRIVATE_PAYLOAD_MUST_NEVER_ESCAPE';
    const underlying = Object.assign(new Error(privateSnippet), { detail: privateSnippet, cause: privateSnippet });
    const throwing = readerFromPg({ async query() { throw underlying; } });
    const key = encoder.encode('node');
    const failure: unknown = await throwing.getManyTopology!([key]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(projectionFailure);
    expect((failure as Error).cause).toBeUndefined();
    expect((failure as Error).stack).not.toContain(privateSnippet);
    expect(JSON.stringify(failure)).not.toContain(privateSnippet);
    for (const size of [-1, 0.5, '1024', Number.MAX_SAFE_INTEGER + 1, undefined]) {
      const malformed = readerFromPg({ async query() {
        return { rows: [{ k: Buffer.from(key), value_bytes: size, needs_js_parse: false, topology: { kind: 'atom', level: 0 } }] };
      } });
      await expect(malformed.getManyTopology!([key])).rejects.toThrow(projectionFailure);
    }
  });
});
