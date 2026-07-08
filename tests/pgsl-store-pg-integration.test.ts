/**
 * REAL PostgreSQL integration — proves the ENTIRE PGSL store stack (content-
 * addressed compose, structural indexes, atom-granular ABAC projection, LDP CRUD,
 * mutable control-plane, durable rehydrate) runs UNCHANGED over the Postgres
 * FdbLike adapter. This is the budget-fitting managed backend (vs AKS+FDB).
 *
 * Skipped unless PGSL_PG_IT=1 (set by the CI job that stands up a Postgres service
 * container). node-postgres is pure JS, so no native build is needed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  openPgStore,
  openStore,
  publicAtomAddress,
  CodecRegistry,
  rdfCodec,
  LdpStore,
  clearancePdp,
  projectHolonFor,
  CLASSIFICATION,
  type FdbLike,
  type StoredNode,
} from '../packages/pgsl-store/src/index.js';

const RUN = process.env.PGSL_PG_IT === '1';
const ns = `${Date.now()}`;
const atom = (v: string): StoredNode => ({ uri: publicAtomAddress(`${ns}:${v}`), kind: 'atom', level: 0, value: v });

describe.skipIf(!RUN)('pgsl-store: FULL stack over REAL PostgreSQL', () => {
  let fdb: FdbLike;
  beforeAll(async () => {
    fdb = await openPgStore({ table: 'pgsl_kv' });
  });
  afterAll(async () => { await fdb?.close(); });

  it('compose + structural queries + durable rehydrate over Postgres', async () => {
    const store = openStore(fdb);
    const a = atom('alpha');
    const b = atom('beta');
    const frag: StoredNode = { uri: `urn:pgsl:fragment:${'a'.repeat(39)}0`, kind: 'fragment', level: 1, items: [a.uri, b.uri] };
    const res = await store.compose([a, b, frag], { pod: `https://pod/${ns}/`, resource: 'g/f' });
    expect(res.created).toBe(3);
    expect(await store.fragmentItems(frag.uri)).toEqual([a.uri, b.uri]);
    expect(await store.resolveResource(`https://pod/${ns}/`, 'g/f')).toEqual(frag);

    // Reconnect (new pool) -> rehydrate bodies from Postgres.
    const fdb2 = await openPgStore({ table: 'pgsl_kv' });
    try {
      const s2 = openStore(fdb2);
      expect(await s2.resolve(a.uri)).toEqual(a);
    } finally {
      await fdb2.close();
    }
  });

  it('idempotent compose over Postgres (content-addressed set-if-absent)', async () => {
    const store = openStore(fdb);
    const slice = [atom('p'), atom('q')];
    const first = await store.putMany(slice);
    expect(first.created + first.dedup).toBe(2);
    const second = await store.putMany(slice);
    expect(second).toEqual({ created: 0, dedup: 2 });
  });

  it('atom-granular ABAC projection over Postgres (same holon, different bytes)', async () => {
    const store = openStore(fdb);
    const name = atom('Ada');
    const ssn = atom('123-45-6789');
    const frag: StoredNode = { uri: `urn:pgsl:fragment:${'b'.repeat(39)}0`, kind: 'fragment', level: 1, items: [name.uri, ssn.uri] };
    await store.compose([name, ssn, frag], { pod: `https://pod/${ns}/`, resource: 'g/person' });
    await store.putAtomAttributes(frag.uri, ssn.uri, { classification: CLASSIFICATION.secret });

    const high = await projectHolonFor(store, frag.uri, clearancePdp(CLASSIFICATION.secret));
    const low = await projectHolonFor(store, frag.uri, clearancePdp(CLASSIFICATION.internal));
    expect(high.partial).toBe(false);
    expect(low.partial).toBe(true);
    expect(low.items.find((i) => i.uri === ssn.uri)!.redacted).toBe(true);
    expect(low.items.map((i) => i.uri)).toEqual(high.items.map((i) => i.uri)); // structure intact
  });

  it('mutable control-plane UPDATE/DELETE over Postgres', async () => {
    const store = openStore(fdb);
    const id = `acct-${ns}`;
    await store.cpSet('accounts', id, { v: 1 });
    await store.cpSet('accounts', id, { v: 2 });
    expect(await store.cpGet<{ v: number }>('accounts', id)).toEqual({ v: 2 });
    await store.cpDelete('accounts', id);
    expect(await store.cpGet('accounts', id)).toBeNull();
  });

  it('LDP resource CRUD over Postgres (byte-faithful)', async () => {
    const ldp = new LdpStore(openStore(fdb), new CodecRegistry().register(rdfCodec));
    const turtle = '@prefix ex: <http://ex/> .\nex:s ex:p "exact" .\n';
    await ldp.writeResource(`pod-${ns}`, 'ctx/doc.ttl', new TextEncoder().encode(turtle), 'text/turtle');
    const got = await ldp.readResource(`pod-${ns}`, 'ctx/doc.ttl');
    expect(new TextDecoder().decode(got!.bytes)).toBe(turtle);
  });
});
