/**
 * Records the bridge keeps are committed natively where the tenant's store is native.
 *
 * ★ WHY. docs/operations/native-learning-storage.md: a canonical record is an encrypted native
 * artifact published by one conditional head commit. The sealed pod records of 2026-11-26 were a
 * plain PUT per record: one writer, last write wins, no revision check. This holds the layer that
 * routes those records to the native store (src/kept-records.ts).
 *
 * Two tiers, as tests/native-lrs-store.test.ts has them. Here: the routing against a stand-in, and
 * the real native client, encryption, HAMT and resource CAS over a local engine with two database
 * instances standing for two bridge processes. The actual CSS and PostgreSQL engine, with a
 * storage process restart, is the case added to native-lrs-store.test.ts, which CI requires.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NativeCommitStore, NATIVE_COMMIT_MEDIA_TYPE, type NativeCommitScope } from '@interego/pgsl';
import { deriveEncryptionKeyPair, type IRI } from '@interego/core';
import { openStore, InMemoryFdb, CodecRegistry, LdpStore } from '../../../packages/pgsl-store/src/index.js';
import { NativeInteregoLrsDatabase } from '../src/native-lrs-store.js';
import { KeptRecords, type NativeResources } from '../src/kept-records.js';
import { SealedPodMap, type SealedFetch } from '../src/sealed-store.js';

type Rec = { who: string; steps: string[] };
const isRec = (v: unknown): v is Rec => !!v && typeof (v as Rec).who === 'string' && Array.isArray((v as Rec).steps);
const KEY = deriveEncryptionKeyPair('55'.repeat(32));
const BASE = 'https://pod.example/foxxi/foxxi-lattice/kept/things/';

function pod() {
  const bodies = new Map<string, string>();
  let failDelete = false;
  const fetch: SealedFetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'HEAD') return new Response(null, { status: 200 });
    if (method === 'GET') return bodies.has(url) ? new Response(bodies.get(url)!) : new Response('', { status: 404 });
    if (method === 'PUT') { bodies.set(url, String(init?.body ?? '')); return new Response('', { status: 201 }); }
    if (method === 'DELETE') { if (failDelete) return new Response('', { status: 500 }); bodies.delete(url); return new Response(null, { status: 204 }); }
    return new Response('', { status: 405 });
  };
  const records = () => [...bodies.keys()].filter(u => u.endsWith('.envelope.json'));
  return { bodies, fetch, records, failDeletes: (v: boolean) => { failDelete = v; } };
}
function fakeNative() {
  const held = new Map<string, unknown>();
  const fail = { get: false, put: false, del: false };
  const store: NativeResources = {
    async getResource<T>(kind: string, id: string) { if (fail.get) throw new Error('native head unreadable'); return (held.get(`${kind}/${id}`) ?? null) as T | null; },
    async putResource<T>(kind: string, id: string, value: T) { if (fail.put) throw new Error('commit refused'); held.set(`${kind}/${id}`, structuredClone(value)); },
    async deleteResource(kind: string, id: string) { if (fail.del) throw new Error('commit refused'); held.delete(`${kind}/${id}`); },
    async updateResource<T, R>(kind: string, id: string, mutate: (current: T | null) => { value: T | null; result: R }) {
      if (fail.put) throw new Error('commit refused');
      await hooks.beforeUpdate?.();
      const next = mutate((held.get(`${kind}/${id}`) ?? null) as T | null);
      if (next.value === null) held.delete(`${kind}/${id}`); else held.set(`${kind}/${id}`, structuredClone(next.value));
      return next.result;
    },
  };
  const hooks: { beforeUpdate?: () => Promise<void> | void } = {};
  return { held, fail, store, hooks };
}
function kept(p: ReturnType<typeof pod>, native: (ns: string) => NativeResources | null, sealedConfigured = true) {
  const sealed = new SealedPodMap<Rec>({ base: sealedConfigured ? BASE : '', key: KEY, fetch: p.fetch, valid: isRec });
  return { sealed, records: new KeptRecords<Rec>({ kind: 'foxxi-thing', sealed, native, valid: isRec }) };
}
const A: Rec = { who: 'did:ethr:0xaaa', steps: ['one'] };

describe('a tenant whose store is native', () => {
  it('has its record committed natively, and nothing written sealed', async () => {
    const p = pod(), n = fakeNative(), k = kept(p, () => n.store);
    expect(await k.records.put('t1', 'a', A)).toBe('kept');
    expect(n.held.get('foxxi-thing/a')).toEqual(A);
    expect(p.records()).toEqual([]);
    expect(await k.records.get('t1', 'a')).toEqual({ state: 'held', value: A });
    expect(k.records.mechanismFor('t1')).toBe('native-commit');
  });

  it('is told apart from one that has none: absent, and unreadable when the head cannot be read', async () => {
    const p = pod(), n = fakeNative(), k = kept(p, () => n.store);
    expect(await k.records.get('t1', 'none')).toEqual({ state: 'absent' });
    n.fail.get = true;
    expect(await k.records.get('t1', 'none')).toEqual({ state: 'unreadable' });
    n.fail.get = false;
    n.held.set('foxxi-thing/odd', { not: 'a record' });
    expect(await k.records.get('t1', 'odd')).toEqual({ state: 'unreadable' });
  });

  it('says failed when the commit is refused, and writes nothing sealed in its place', async () => {
    const p = pod(), n = fakeNative(), k = kept(p, () => n.store);
    n.fail.put = true;
    expect(await k.records.put('t1', 'a', A)).toBe('failed');
    expect(p.records()).toEqual([]);
  });

  it('brings across a record an earlier bridge kept sealed, once, and removes the sealed copy', async () => {
    const p = pod(), n = fakeNative(), k = kept(p, () => n.store);
    expect(await k.sealed.put('t1', 'a', A)).toBe('kept');
    expect(p.records()).toHaveLength(1);
    expect(await k.records.get('t1', 'a')).toEqual({ state: 'held', value: A });
    expect(n.held.get('foxxi-thing/a')).toEqual(A);
    expect(p.records()).toEqual([]);
  });

  it('still answers with the sealed record when it cannot be committed yet, and leaves it in place', async () => {
    const p = pod(), n = fakeNative(), k = kept(p, () => n.store);
    await k.sealed.put('t1', 'a', A);
    n.fail.put = true;
    expect(await k.records.get('t1', 'a')).toEqual({ state: 'held', value: A });
    expect(p.records()).toHaveLength(1);
    n.fail.put = false;
    await k.records.get('t1', 'a');
    expect(p.records()).toEqual([]);
  });

  it('does not let a sealed copy outlive the native record', async () => {
    const p = pod(), n = fakeNative(), k = kept(p, () => n.store);
    await k.sealed.put('t1', 'a', { who: 'old', steps: [] });
    // A write goes native and takes the sealed copy away...
    expect(await k.records.put('t1', 'a', A)).toBe('kept');
    expect(p.records()).toEqual([]);
    // ...so removing the record leaves nothing to be read back as it.
    expect(await k.records.remove('t1', 'a')).toBe('gone');
    expect(await k.records.get('t1', 'a')).toEqual({ state: 'absent' });
  });

  it('is gone only when neither place holds it', async () => {
    const p = pod(), n = fakeNative(), k = kept(p, () => n.store);
    await k.records.put('t1', 'a', A);
    n.fail.del = true;
    expect(await k.records.remove('t1', 'a')).toBe('failed');
    n.fail.del = false;
    await k.sealed.put('t1', 'b', A);
    p.failDeletes(true);
    expect(await k.records.remove('t1', 'b')).toBe('failed');
  });

  // ★ Review of #1011. The move was an unconditional write of the sealed value: a record another
  // bridge committed between this one's native read and its write was put back to the older value.
  it('does not put the sealed value over a native record written while it was being brought across', async () => {
    const p = pod(), n = fakeNative(), k = kept(p, () => n.store);
    await k.sealed.put('t1', 'a', { who: 'old', steps: ['sealed'] });
    const newer: Rec = { who: 'new', steps: ['committed by another bridge'] };
    n.hooks.beforeUpdate = () => { n.held.set('foxxi-thing/a', newer); };
    expect(await k.records.get('t1', 'a')).toEqual({ state: 'held', value: newer });
    expect(n.held.get('foxxi-thing/a')).toEqual(newer);
  });

  // ★ Review of #1011. The native record was removed first: with the sealed removal failing, the
  // next read brought the older sealed copy back as the record.
  it('keeps the native record until a sealed copy left behind has gone', async () => {
    const p = pod(), n = fakeNative(), k = kept(p, () => n.store);
    await k.sealed.put('t1', 'a', { who: 'old', steps: ['stale'] });
    p.failDeletes(true);
    expect(await k.records.put('t1', 'a', A)).toBe('kept');     // the cleanup after this write fails
    expect(p.records()).toHaveLength(1);
    expect(await k.records.remove('t1', 'a')).toBe('failed');
    expect(n.held.get('foxxi-thing/a')).toEqual(A);             // still the record
    expect(await k.records.get('t1', 'a')).toEqual({ state: 'held', value: A });
    p.failDeletes(false);
    expect(await k.records.remove('t1', 'a')).toBe('gone');
    expect(await k.records.get('t1', 'a')).toEqual({ state: 'absent' });
  });

  it('does not read an unreadable sealed copy as absent', async () => {
    const p = pod(), n = fakeNative(), k = kept(p, () => n.store);
    p.bodies.set(k.sealed.urlOf('t1', 'a'), 'not an envelope');
    expect(await k.records.get('t1', 'a')).toEqual({ state: 'unreadable' });
  });
});

describe('a tenant whose store is not native', () => {
  it('keeps its records sealed on the pod, as before', async () => {
    const p = pod(), n = fakeNative(), k = kept(p, (ns) => (ns === 'native' ? n.store : null));
    expect(await k.records.put('plain', 'a', A)).toBe('kept');
    expect(p.records()).toHaveLength(1);
    expect(n.held.size).toBe(0);
    expect(await k.records.get('plain', 'a')).toEqual({ state: 'held', value: A });
    expect(k.records.mechanismFor('plain')).toBe('sealed-pod-resource');
    expect(await k.records.remove('plain', 'a')).toBe('gone');
  });
  it('keeps nothing, and says so, with neither a native store nor a pod', async () => {
    const k = kept(pod(), () => null, false);
    expect(k.records.configuredFor('t')).toBe(false);
    expect(k.records.mechanismFor('t')).toBe('none');
    expect(await k.records.put('t', 'a', A)).toBe('unconfigured');
    expect(await k.records.get('t', 'a')).toEqual({ state: 'unconfigured' });
  });
});

describe('over the real native client and a local resource engine', () => {
  // The native encryption, HAMT proofs, resource CAS and PGSL engine run here. Only the
  // persistence driver and HTTP transport are local seams (as in native-lrs-store.test.ts).
  const owner = 'did:web:kept-records.test:service' as IRI;
  function engine() {
    const ldp = new LdpStore(openStore(new InMemoryFdb()), new CodecRegistry());
    const suffix = randomUUID();
    const scope: NativeCommitScope = { pod: 'https://pod.test/service/', headUrl: `https://pod.test/service/${suffix}/head`, artifactContainer: `https://pod.test/service/${suffix}/artifacts/`, owner };
    const bodies: string[] = [];
    const transport: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Accept-Put': NATIVE_COMMIT_MEDIA_TYPE, 'Interego-Native-Commit': '1' } });
      if (method === 'GET') {
        const result = await ldp.readResource('css', url);
        return result ? new Response(Buffer.from(result.bytes).toString('utf8'), { headers: {
          'Content-Type': result.contentType, ETag: '"' + result.revision + '-json"', 'Interego-Revision': result.revision, 'Interego-Body-Digest': result.bodyDigest } })
          : new Response(null, { status: 404 });
      }
      const command = JSON.parse(String(init?.body)) as { expectedRevision: string | null; bodyBase64: string; contentType: string };
      bodies.push(Buffer.from(command.bodyBase64, 'base64').toString('utf8'));
      const result = await ldp.commitResource('css', url, Buffer.from(command.bodyBase64, 'base64'), command.contentType, { expectedRevision: command.expectedRevision });
      if (result.status === 'conflict') return new Response(null, { status: 412 });
      return new Response(JSON.stringify({ ...result, version: 1, resource: url, expectedRevision: command.expectedRevision }), { headers: { 'Content-Type': 'application/json', ETag: '"' + result.revision + '-json"' } });
    };
    const keys = deriveEncryptionKeyPair('11'.repeat(32), owner);
    /** One bridge process: its own client and database over the shared engine. */
    const bridge = () => new NativeInteregoLrsDatabase({
      client: new NativeCommitStore({ scope, fetch: transport, senderKeyPair: keys, ownerPublicKey: keys.publicKey, recipientPublicKeys: [keys.publicKey] }),
      owner, scopeIdentity: JSON.stringify(scope), cursorSecret: 'synthetic-kept-records-cursor-secret-0001' });
    return { bridge, bodies };
  }
  const over = (db: NativeInteregoLrsDatabase) => kept(pod(), (ns) => db.forTenant(ns), false).records;

  it('a record one bridge commits is read by another, and is not on the wire in the clear', async () => {
    const e = engine(), one = over(e.bridge()), two = over(e.bridge());
    const secret: Rec = { who: 'did:ethr:0xLEARNER-MARKER', steps: ['a step that must not be readable at rest'] };
    expect(await one.put('tenant-a', 'did:ethr:0xLEARNER-MARKER', secret)).toBe('kept');
    expect(await two.get('tenant-a', 'did:ethr:0xLEARNER-MARKER')).toEqual({ state: 'held', value: secret });
    // Another tenant's namespace does not see it.
    expect(await two.get('tenant-b', 'did:ethr:0xLEARNER-MARKER')).toEqual({ state: 'absent' });
    expect(e.bodies.length).toBeGreaterThan(0);
    for (const b of e.bodies) { expect(b).not.toContain('LEARNER-MARKER'); expect(b).not.toContain('must not be readable'); }
  }, 60_000);

  it('two bridges writing different records at once both keep theirs', async () => {
    // The sealed store could not lose these either (one resource each). What it could not do is
    // publish them under one head with a revision check: here a conflict is retried, not lost.
    const e = engine(), one = over(e.bridge()), two = over(e.bridge());
    const results = await Promise.all([
      one.put('tenant-a', 'x', { who: 'x', steps: ['1'] }), two.put('tenant-a', 'y', { who: 'y', steps: ['1'] }),
      one.put('tenant-a', 'z', { who: 'z', steps: ['1'] }), two.put('tenant-a', 'w', { who: 'w', steps: ['1'] }),
    ]);
    expect(results).toEqual(['kept', 'kept', 'kept', 'kept']);
    const fresh = over(e.bridge());
    for (const id of ['x', 'y', 'z', 'w']) expect(await fresh.get('tenant-a', id)).toEqual({ state: 'held', value: { who: id, steps: ['1'] } });
  }, 60_000);

  it('a removed record is absent to every bridge', async () => {
    const e = engine(), one = over(e.bridge()), two = over(e.bridge());
    await one.put('tenant-a', 'gone', A);
    expect(await two.remove('tenant-a', 'gone')).toBe('gone');
    // Removing what is not there is not a failure.
    expect(await two.remove('tenant-a', 'never-was')).toBe('gone');
    expect(await one.get('tenant-a', 'gone')).toEqual({ state: 'absent' });
  }, 60_000);
});

describe('the bridge', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  it('keeps trajectories, probes, evaluations and attempts through this layer', () => {
    for (const [name, kind] of [['keptTrajectories', 'foxxi-trajectory'], ['keptProbes', 'foxxi-probes'], ['keptEvaluations', 'foxxi-evaluation'], ['keptScormPlays', 'foxxi-scorm-attempt']] as const) {
      expect(src).toMatch(new RegExp(`const ${name} = new KeptRecords<[^>]+>\\(\\{ kind: '${kind}', native: `));
    }
    // Nothing reaches a sealed map of these kinds except through the layer.
    // Seven since the sequencing sessions, their index and the cmi5 rollup joined them.
    expect(src.match(/new SealedPodMap</g)).toHaveLength(7);
    expect(src.match(/sealed: new SealedPodMap</g)).toHaveLength(7);
  });
  it('asks the tenant\'s own record store whether it is native', () => {
    expect(src).toContain('const nativeOfTenant = (ns: string) => nativeResourcesFor(ns as TenantId);');
    const lrs = readFileSync(new URL('../src/xapi-lrs.ts', import.meta.url), 'utf8');
    expect(lrs).toContain('return store instanceof NativeInteregoLrsStore ? store : null;');
  });
});
