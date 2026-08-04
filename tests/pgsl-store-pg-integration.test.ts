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
import type { Engagement } from '@interego/agent-interop';

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

  // ★ THE ONE PROPERTY NO DOUBLE CAN CHECK. Everything else in this file would pass over
  // InMemoryFdb; these would not, because what is under test is an ISOLATION LEVEL — and
  // InMemoryFdb refuses the second write at either level, so it reports the guard as
  // working while production loses turns. The barrier below only ORDERS the calls the
  // real code makes against a real connection; it stands in for nothing.
  it('compareAndSet survives two OVERLAPPING transactions under READ COMMITTED', async () => {
    const enc = new TextEncoder(); const dec = new TextDecoder();
    const k = enc.encode(`cas:${ns}:overlap`);
    await fdb.transact(async (txn) => txn.compareAndSet(k, null, enc.encode('v0')));

    let open: () => void = () => {}; let arrived = 0;
    const gate = new Promise<void>((r) => { open = r; });
    const bothHaveRead = async (): Promise<void> => { if (++arrived === 2) open(); else await gate; };

    const race = (mine: string): Promise<boolean> => fdb.transact(async (txn) => {
      const seen = await txn.get(k);
      await bothHaveRead();               // neither has written yet — the losing interleave
      return txn.compareAndSet(k, seen ?? null, enc.encode(mine));
    });
    const [a, b] = await Promise.all([race('vA'), race('vB')]);

    // WHICH one lands is a race; that EXACTLY ONE does is the invariant. With the previous
    // unconditional `set` both landed and the loser's bytes were gone with no error.
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const final = await fdb.transact(async (txn) => txn.get(k));
    expect(dec.decode(final!)).toBe(a ? 'vA' : 'vB');
  });

  it('two concurrent creators of one absent key: exactly one lands', async () => {
    const enc = new TextEncoder();
    const k = enc.encode(`cas:${ns}:create`);
    let open: () => void = () => {}; let arrived = 0;
    const gate = new Promise<void>((r) => { open = r; });
    const bothHaveRead = async (): Promise<void> => { if (++arrived === 2) open(); else await gate; };
    const race = (mine: string): Promise<boolean> => fdb.transact(async (txn) => {
      await txn.get(k); await bothHaveRead();
      return txn.compareAndSet(k, null, enc.encode(mine));   // both saw: absent
    });
    // This is the `open` case in engagement-store: a minted id that must not overwrite a
    // stranger's row. `ON CONFLICT DO NOTHING` refuses the loser; DO UPDATE would not.
    expect((await Promise.all([race('A'), race('B')])).filter(Boolean)).toHaveLength(1);
  });

  it('ENGAGEMENT: an overlapped put is refused, not silently overwritten', async () => {
    // Imports the RELAY'S REAL store over the REAL adapter. This is the regression for the
    // defect: before the fix BOTH puts resolved and one turn vanished, with both callers
    // answered 200.
    const { engagementStoreOverFdb, ConcurrentModification } =
      await import('../deploy/mcp-relay/engagement-store.js');

    let open: () => void = () => {}; let arrived = 0; let armed = false;
    const gate = new Promise<void>((r) => { open = r; });
    const afterGet = async (): Promise<void> => {
      if (!armed) return;
      if (++arrived === 2) { armed = false; open(); } else await gate;
    };
    const ordered: FdbLike = {
      transact: (fn) => fdb.transact((txn) => fn({
        ...txn,
        get: async (key) => { const v = await txn.get(key); await afterGet(); return v; },
      })),
      close: () => fdb.close(),
    };

    const store = engagementStoreOverFdb(ordered);
    const id = `https://relay.test/engagements/${ns}-cas`;
    const rec = (turns: unknown[]): Engagement => ({
      id, state: 'working', openedBy: 'did:ethr:0xalice', turns,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as Engagement);

    await store.put(rec([]), null);
    const base = (await store.get(id))!.version;

    armed = true;
    const out = await Promise.allSettled([
      store.put(rec([{ who: 'A' }]), base),
      store.put(rec([{ who: 'B' }]), base),
    ]);
    const kept = out.filter((r) => r.status === 'fulfilled');
    const refused = out.filter((r) => r.status === 'rejected');
    expect(kept).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // Asserted by TYPE, not by "it rejected": a raw pg error escaping as a StoreFault is a
    // different bug and must not read as this one fixed.
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrentModification);
    // And the survivor's turn is really there — a refusal that also lost the winner's
    // write would satisfy the counts above and none of the point.
    expect((await store.get(id))!.record.turns).toHaveLength(1);
  });
});
