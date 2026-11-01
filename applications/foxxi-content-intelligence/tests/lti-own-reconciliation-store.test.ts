import { createHash, createHmac } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { canonicalJson, deriveEncryptionKeyPair, mintNodeId, openEncryptedEnvelope, type IRI } from '@interego/core';
import { NativeCommitStore, NATIVE_COMMIT_MEDIA_TYPE, createNativeByteArtifact, readNativeByteArtifact } from '@interego/pgsl';
import { createOwnLtiReconciliationStore, OWN_LTI_RECONCILIATION_HEAD, OWN_LTI_RECONCILIATION_LIMITS as L } from '../src/lti-own-reconciliation-store.js';
import type { OwnSubjectXapiAuthority } from '../src/own-subject-xapi-auth.js';

interface Entry { id: string; owner: string; value: string; attestation: string; }
interface RawLedger { schema: string; owner: string; pod: string; head: string; writtenAt: number;
  entries: Entry[]; entryDigests: string[]; ledgerDigest: string; ledgerMac: string; }
const sha = (bytes: string | Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

/** Actual native SDK encryption, CP resource receipts, strong CAS and readback.
 * Only HTTP storage is modeled in memory; this is not a live CSS/account test. */
function fixture() {
  const owner = 'did:web:identity.test:users:alice', pod = 'https://pod.test/alice/', head = pod + OWN_LTI_RECONCILIATION_HEAD;
  const privateKey = 'a'.repeat(64), ownerKey = deriveEncryptionKeyPair('b'.repeat(64), owner);
  const key = deriveEncryptionKeyPair(privateKey, 'urn:foxxi:lti-own-reconciliation-ledger:' + owner);
  const authority: OwnSubjectXapiAuthority = { ok: true, callerDid: 'did:web:identity.test:agents:session-alice', subjectDid: owner,
    podUrl: pod, ownerPublicKey: ownerKey.publicKey, payload: {} };
  let at = Date.parse('2026-11-01T02:00:00.000Z'), serial = 0, gets = 0;
  const rows = new Map<string, { bytes: Buffer; revision: string }>();
  const calls: Array<{ url: string; method: string; headers: Headers; redirect: RequestRedirect | undefined }> = [];
  const control = { weakEtag: false, badDigest: false, redirect: false, readUnavailable: false, loseAck: false,
    unavailableAfterPut: false, failPut: false, removeAfterGet: 0, beforePut: null as null | (() => Promise<void>),
    beforeValidate: null as null | (() => Promise<void>) };
  const sign = (entry: Omit<Entry, 'attestation'>) => createHmac('sha256', 'synthetic-test-attestation-key').update(canonicalJson(entry)).digest('hex');
  const entry = (value: string, id = sha(value).slice(7)): Entry => {
    const claim = { id, owner, value }; return { ...claim, attestation: sign(claim) };
  };
  const validateEntry = async (value: unknown) => {
    const before = control.beforeValidate; control.beforeValidate = null; await before?.();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const e = value as Entry;
    return e.owner === owner && typeof e.id === 'string' && typeof e.value === 'string'
      && e.attestation === sign({ id: e.id, owner: e.owner, value: e.value });
  };
  const transport: typeof fetch = async (input, init = {}) => {
    const url = String(input), method = init.method ?? 'GET', headers = new Headers(init.headers);
    calls.push({ url, method, headers, redirect: init.redirect });
    expect(url).toBe(head); // No manifests, immutable graph files, LMS or LRS writes.
    if (control.redirect) return new Response(null, { status: 302, headers: { Location: 'https://untrusted.test/resource' } });
    if (method === 'OPTIONS') return new Response(null, { status: 204,
      headers: { 'Accept-Put': NATIVE_COMMIT_MEDIA_TYPE, 'Interego-Native-Commit': '1' } });
    if (method === 'GET') {
      gets++;
      if (control.readUnavailable) return new Response(null, { status: 503 });
      const row = rows.get(url);
      const response = row ? new Response(new Uint8Array(row.bytes), { headers: {
        'Content-Type': 'application/json', ETag: (control.weakEtag ? 'W/' : '') + '"' + row.revision + '-json"',
        'Interego-Revision': row.revision, 'Interego-Body-Digest': control.badDigest ? sha('different') : sha(row.bytes),
      } }) : new Response(null, { status: 404 });
      if (control.removeAfterGet === gets) rows.delete(url);
      return response;
    }
    expect(method).toBe('PUT');
    await control.beforePut?.();
    const request = JSON.parse(String(init.body)) as { expectedRevision: string | null; bodyBase64: string };
    expect(headers.get('Content-Type')).toBe(NATIVE_COMMIT_MEDIA_TYPE);
    expect(headers.get(request.expectedRevision === null ? 'If-None-Match' : 'If-Match'))
      .toBe(request.expectedRevision === null ? '*' : '"' + request.expectedRevision + '"');
    const old = rows.get(url);
    if (request.expectedRevision === null ? old !== undefined : old?.revision !== request.expectedRevision) return new Response(null, { status: 412 });
    if (control.failPut) return new Response(null, { status: 503 });
    const bytes = Buffer.from(request.bodyBase64, 'base64'), revision = sha(url + ':' + (++serial) + ':' + sha(bytes));
    rows.set(url, { bytes, revision });
    if (control.unavailableAfterPut) control.readUnavailable = true;
    if (control.loseAck) { control.loseAck = false; throw Error('synthetic acknowledgement loss'); }
    const top = mintNodeId('atom', sha(bytes).slice(7, 47));
    return Response.json({ version: 1, status: 'committed', expectedRevision: request.expectedRevision, resource: url,
      revision, bodyDigest: sha(bytes), contentType: 'application/json', pod: 'css', path: url, size: bytes.length,
      updatedAt: at, topUri: top, opaqueUri: top }, { headers: { ETag: '"' + revision + '-json"' } });
  };
  const create = (readOnly = false) => createOwnLtiReconciliationStore<Entry>(authority,
    { privateKey, fetch: transport, readOnly, validateEntry, now: () => at });
  const native = new NativeCommitStore({ scope: { pod, owner: owner as IRI, headUrl: head,
    artifactContainer: pod + 'foxxi/lti-reconciliation/own/artifacts/' }, atomicCheckpoint: true,
    senderKeyPair: key, ownerPublicKey: ownerKey.publicKey, recipientPublicKeys: [ownerKey.publicKey, key.publicKey], fetch: transport });
  return { owner, ownerKey, key, head, authority, privateKey, transport, rows, calls, control, create, entry, sign, validateEntry,
    puts: () => calls.filter(c => c.method === 'PUT').length,
    advance(ms: number) { at += ms; },
    async mutate(change: (state: RawLedger) => void) {
      const selected = await native.readAtomicCheckpoint(), original = readNativeByteArtifact(selected.artifact!);
      const state = JSON.parse(gunzipSync(original.bytes).toString('utf8')) as RawLedger; change(state);
      await native.commitAtomicCheckpoint(selected.revision, createNativeByteArtifact({ owner: owner as IRI,
        contentType: original.contentType, bytes: gzipSync(Buffer.from(canonicalJson(state))) }));
    },
    async replacePayload(bytes: Uint8Array, contentType = 'application/vnd.interego.rolling-checkpoint+gzip') {
      const selected = await native.readAtomicCheckpoint();
      await native.commitAtomicCheckpoint(selected.revision, createNativeByteArtifact({ owner: owner as IRI, contentType, bytes }));
    },
  };
}

describe('private own-human LTI reconciliation ledger', () => {
  it('uses one encrypted scoped resource, preserves entries across restart, and exact retries make no write', async () => {
    const f = fixture(), first = f.entry('private audit observation'), initial = await f.create(true).read();
    expect(initial).toEqual({ revision: null, entries: [] }); expect(f.puts()).toBe(0);
    const result = await f.create().append(null, first);
    expect(result.revision).toMatch(/^sha256:[a-f0-9]{64}$/); expect(result.entries).toEqual([first]);
    expect(f.rows.size).toBe(1); expect(f.puts()).toBe(1);
    const ciphertext = f.rows.get(f.head)!.bytes;
    expect(ciphertext.includes(Buffer.from(first.value))).toBe(false);
    expect(openEncryptedEnvelope(JSON.parse(ciphertext.toString('utf8')), f.ownerKey)).toBeTruthy();
    expect(openEncryptedEnvelope(JSON.parse(ciphertext.toString('utf8')), f.key)).toBeTruthy();
    f.advance(366 * 24 * 3600000);
    const restarted = await f.create(true).read(); expect(restarted).toEqual(result);
    const count = f.puts(); expect(await f.create().append(null, first)).toEqual(result); expect(f.puts()).toBe(count);
    expect(f.calls.every(c => c.url === f.head)).toBe(true);
    expect(f.calls.filter(c => c.method === 'GET').every(c => c.headers.get('Cache-Control') === 'no-cache')).toBe(true);
    expect(f.calls.every(c => c.redirect === 'manual')).toBe(true);
    result.entries[0]!.value = 'caller mutation'; expect((await f.create(true).read()).entries).toEqual([first]);
  });

  it('requires stable key/native own authority and refuses read-only writes or invalid entries before transport', async () => {
    const f = fixture(), options = { privateKey: f.privateKey, fetch: f.transport, readOnly: false, validateEntry: f.validateEntry };
    expect(() => createOwnLtiReconciliationStore(f.authority, { ...options, privateKey: '' })).toThrow();
    expect(() => createOwnLtiReconciliationStore(f.authority, { ...options, privateKey: '0'.repeat(64) })).toThrow();
    expect(() => createOwnLtiReconciliationStore({ ...f.authority, subjectDid: 'did:ethr:unbound' }, options)).toThrow();
    expect(() => createOwnLtiReconciliationStore({ ...f.authority, podUrl: 'https://pod.test/bob/' }, options)).toThrow();
    expect(() => createOwnLtiReconciliationStore({ ...f.authority, podUrl: 'https://pod.test/alice/?choose=other' }, options)).toThrow();
    await expect(f.create(true).append(null, f.entry('readonly'))).rejects.toMatchObject({ status: 403 });
    await expect(f.create().append(null, { ...f.entry('bad'), attestation: 'forged' })).rejects.toMatchObject({ status: 400 });
    await expect(f.create().append(null, { ...f.entry('id'), id: 'not-a-digest' })).rejects.toMatchObject({ status: 400 });
    await expect(f.create().append('W/"weak"', f.entry('revision'))).rejects.toMatchObject({ status: 400 });
    expect(f.calls).toHaveLength(0);
  });

  it('revalidates every stored entry attestation before returning a valid native ledger', async () => {
    const f = fixture(), a = f.entry('verify first'), b = f.entry('verify second');
    const first = await f.create().append(null, a); await f.create().append(first.revision, b);
    const seen: string[] = [];
    const refuseSecond = createOwnLtiReconciliationStore<Entry>(f.authority, { privateKey: f.privateKey,
      fetch: f.transport, readOnly: true, validateEntry: async value => {
        const entry = value as Entry; seen.push(entry.id); return entry.id !== b.id && await f.validateEntry(value);
      } });
    const count = f.puts(); await expect(refuseSecond.read()).rejects.toMatchObject({ status: 503 });
    expect(seen).toEqual([a.id, b.id]); expect(f.puts()).toBe(count);
  });

  it('rejects changed content for an existing ID and new appends from stale revisions without rebasing', async () => {
    const f = fixture(), first = f.entry('first'), saved = await f.create().append(null, first), count = f.puts();
    await expect(f.create().append(saved.revision, f.entry('changed valid attestation', first.id))).rejects.toMatchObject({ status: 409 });
    await expect(f.create().append(null, f.entry('new from stale base'))).rejects.toMatchObject({ status: 409 });
    expect(f.puts()).toBe(count); expect((await f.create(true).read()).entries).toEqual([first]);
    const next = await f.create().append(saved.revision, f.entry('second'));
    expect(next.entries.map(e => e.value)).toEqual(['first', 'second']);
  });

  it('lets one real CAS racer win and preserves the other caller operation for an explicit fresh-base retry', async () => {
    const f = fixture(), first = f.entry('before race'), saved = await f.create().append(null, first);
    let arrived = 0, release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    f.control.beforePut = async () => { if (++arrived === 2) release(); await barrier; };
    const candidates = [f.entry('race a'), f.entry('race b')];
    const raced = await Promise.allSettled(candidates.map(e => f.create().append(saved.revision, e)));
    expect(raced.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter(r => r.status === 'rejected').map(r => r.reason.status)).toEqual([409]);
    f.control.beforePut = null;
    const read = await f.create(true).read(); expect(read.entries).toHaveLength(2); expect(read.entries[0]).toEqual(first);
    const losing = candidates.find(e => !read.entries.some(old => old.id === e.id))!;
    expect((await f.create().append(read.revision, losing)).entries).toHaveLength(3);
  });

  it('reconciles a lost acknowledgement only by actual readback, and leaves unavailable acknowledgement pending', async () => {
    const f = fixture(); f.control.loseAck = true;
    const first = f.entry('committed but acknowledgement lost'), confirmed = await f.create().append(null, first);
    expect(confirmed.entries).toEqual([first]); expect(f.puts()).toBe(1);
    f.control.unavailableAfterPut = true; const second = f.entry('unknown acknowledgement');
    await expect(f.create().append(confirmed.revision, second)).rejects.toMatchObject({ status: 503 });
    const count = f.puts(); expect(count).toBe(2);
    f.control.unavailableAfterPut = false; f.control.readUnavailable = false;
    const recovered = await f.create(true).read(); expect(recovered.entries).toEqual([first, second]);
    expect(await f.create().append(confirmed.revision, second)).toEqual(recovered); expect(f.puts()).toBe(count);
  });

  it('requires a separate fresh logical read even after the native SDK confirmed the write', async () => {
    const f = fixture(); f.control.removeAfterGet = 2; // initial GET, then SDK exact ciphertext readback.
    await expect(f.create().append(null, f.entry('do not manufacture success'))).rejects.toMatchObject({ status: 503 });
    expect(f.puts()).toBe(1); expect(f.rows.size).toBe(0);
  });

  it('refuses redirects, weak revisions, corrupt ciphertext metadata and failed writes without fallback resources', async () => {
    const f = fixture(), saved = await f.create().append(null, f.entry('preserved'));
    f.control.redirect = true; await expect(f.create(true).read()).rejects.toMatchObject({ status: 503 }); f.control.redirect = false;
    f.control.weakEtag = true; await expect(f.create(true).read()).rejects.toMatchObject({ status: 503 }); f.control.weakEtag = false;
    f.control.badDigest = true; await expect(f.create(true).read()).rejects.toMatchObject({ status: 503 }); f.control.badDigest = false;
    f.control.failPut = true; await expect(f.create().append(saved.revision, f.entry('uncommitted'))).rejects.toMatchObject({ status: 503 });
    f.control.failPut = false; expect((await f.create(true).read()).entries).toHaveLength(1);
    expect(new Set(f.calls.map(c => c.url))).toEqual(new Set([f.head]));
  });

  it('binds decryption to owner plus service recipients and never interprets another owner ledger as empty', async () => {
    const f = fixture(); await f.create().append(null, f.entry('owner scoped'));
    const foreignOwner = 'did:web:identity.test:users:bob', foreignKey = deriveEncryptionKeyPair('c'.repeat(64), foreignOwner);
    const foreign = createOwnLtiReconciliationStore<Entry>({ ...f.authority, subjectDid: foreignOwner,
      podUrl: 'https://pod.test/bob/', ownerPublicKey: foreignKey.publicKey },
    { privateKey: f.privateKey, readOnly: true, validateEntry: f.validateEntry, fetch: async (_input, init) => f.transport(f.head, init) });
    await expect(foreign.read()).rejects.toMatchObject({ status: 503 });
    const wrongKey = createOwnLtiReconciliationStore<Entry>(f.authority,
      { privateKey: 'd'.repeat(64), readOnly: true, validateEntry: f.validateEntry, fetch: f.transport });
    await expect(wrongKey.read()).rejects.toMatchObject({ status: 503 });
  });

  it('detects mutation or pruning of prior valid entries even if an attacker recomputes the unkeyed digest', async () => {
    for (const change of ['content', 'prune', 'reorder'] as const) {
      const f = fixture(), a = f.entry('first'), b = f.entry('second');
      const first = await f.create().append(null, a); await f.create().append(first.revision, b);
      await f.mutate(state => {
        if (change === 'content') state.entries[0] = f.entry('changed but separately valid', a.id);
        if (change === 'prune') state.entries.shift();
        if (change === 'reorder') state.entries.reverse();
        state.entryDigests = state.entries.map(e => sha(canonicalJson(e)).slice(7));
        const { ledgerDigest: _digest, ledgerMac: _mac, ...body } = state; state.ledgerDigest = sha(canonicalJson(body)).slice(7);
      });
      const count = f.puts();
      await expect(f.create(true).read()).rejects.toMatchObject({ status: 503 });
      await expect(f.create().append(null, f.entry('after corruption'))).rejects.toMatchObject({ status: 503 });
      expect(f.puts()).toBe(count);
    }
  });

  it('rejects wrong schemas/owner/resources, malformed gzip and decompression bombs without an empty fallback', async () => {
    for (const field of ['schema', 'owner', 'pod', 'head'] as const) {
      const f = fixture(); await f.create().append(null, f.entry('before malformed state'));
      await f.mutate(state => { state[field] = 'wrong'; });
      await expect(f.create(true).read()).rejects.toMatchObject({ status: 503 });
    }
    const f = fixture(); await f.create().append(null, f.entry('payload'));
    await f.replacePayload(Buffer.from('not gzip')); await expect(f.create(true).read()).rejects.toMatchObject({ status: 503 });
    await f.replacePayload(gzipSync(Buffer.from('x'.repeat(L.jsonBytes + 1))));
    await expect(f.create(true).read()).rejects.toMatchObject({ status: 503 });
  });

  it('detaches input before asynchronous attestation checks and refuses nonfinite/exotic data', async () => {
    const f = fixture(), original = f.entry('detached'), expected = structuredClone(original);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.control.beforeValidate = () => gate;
    const pending = f.create().append(null, original); original.value = 'late caller mutation'; release();
    expect((await pending).entries).toEqual([expected]);
    const count = f.puts();
    for (const extra of [NaN, Infinity, new Date(), undefined]) {
      const invalid = { ...f.entry('invalid json'), extra };
      await expect(f.create().append(null, invalid)).rejects.toMatchObject({ status: 400 });
    }
    const cyclic = { ...f.entry('cycle') } as Entry & { cycle?: unknown }; cyclic.cycle = cyclic;
    await expect(f.create().append(null, cyclic)).rejects.toMatchObject({ status: 400 });
    expect(f.puts()).toBe(count);
  });

  it('never prunes acknowledged entries at the 64-entry cap or when an individual entry exceeds capacity', async () => {
    const f = fixture(); let revision: string | null = null;
    for (let i = 0; i < L.entries; i++) { const next = await f.create().append(revision, f.entry('retained ' + i)); revision = next.revision; f.advance(1); }
    const before = await f.create(true).read(), count = f.puts(); expect(before.entries).toHaveLength(64);
    await expect(f.create().append(revision, f.entry('one too many'))).rejects.toMatchObject({ status: 413 });
    await expect(f.create().append(revision, f.entry('x'.repeat(L.entryJsonBytes)))).rejects.toMatchObject({ status: 413 });
    f.advance(2 * 365 * 24 * 3600000);
    expect(await f.create(true).read()).toEqual(before); expect(f.puts()).toBe(count);
  }, 60000);
});
