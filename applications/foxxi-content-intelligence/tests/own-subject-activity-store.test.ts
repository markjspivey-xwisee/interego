import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { deriveEncryptionKeyPair, mintNodeId, type IRI } from '@interego/core';
import { NativeCommitStore, NATIVE_COMMIT_MEDIA_TYPE, createNativeByteArtifact, readNativeByteArtifact } from '@interego/pgsl';
import { createOwnSubjectActivityStore, OWN_SUBJECT_ACTIVITY_LIMITS as L } from '../src/own-subject-activity-store.js';
import type { OwnSubjectXapiAuthority } from '../src/own-subject-xapi-auth.js';

// Actual native SDK encryption, provenance, scope wrapper and CAS protocol.
// HTTP is an explicit isolated contract model, not a production CSS proof.
const sha = (bytes: any) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const owner = 'did:web:identity.test:users:alice', pod = 'https://pod.test/alice/';
  const privateKey = 'a'.repeat(64), ownerKey = deriveEncryptionKeyPair('b'.repeat(64), owner);
  const authority: OwnSubjectXapiAuthority = { ok: true, callerDid: 'did:web:identity.test:agents:alice', subjectDid: owner,
    podUrl: pod, ownerPublicKey: ownerKey.publicKey, payload: {} };
  let at = Date.parse('2026-10-17T12:00:00.000Z'), serial = 0;
  const rows = new Map<string, { bytes: Buffer; revision: string }>(), calls: Array<{ url: string; method: string }> = [];
  const control = { loseAck: false, corrupt: false, beforePut: null as null | (() => Promise<void>), failedPuts: false };
  const transport: typeof fetch = async (input, init = {}) => {
    const url = String(input), method = init.method ?? 'GET'; calls.push({ url, method });
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Accept-Put': NATIVE_COMMIT_MEDIA_TYPE, 'Interego-Native-Commit': '1' } });
    if (method === 'GET') {
      const row = rows.get(url);
      return row ? new Response(new Uint8Array(row.bytes), { headers: { 'Content-Type': 'application/json', ETag: '"' + row.revision + '-json"',
        'Interego-Revision': row.revision, 'Interego-Body-Digest': control.corrupt ? sha('wrong') : sha(row.bytes) } }) : new Response(null, { status: 404 });
    }
    expect(method).toBe('PUT'); expect(url).toBe(pod + 'foxxi/activity/own-subject/head');
    await control.beforePut?.();
    const request = JSON.parse(String(init.body)), old = rows.get(url);
    if ((request.expectedRevision === null && old) || (request.expectedRevision !== null && old?.revision !== request.expectedRevision)) return new Response(null, { status: 412 });
    if (control.failedPuts) return new Response(null, { status: 503 });
    const bytes = Buffer.from(request.bodyBase64, 'base64'), revision = sha(url + ':' + (++serial) + ':' + sha(bytes));
    rows.set(url, { bytes, revision });
    if (control.loseAck) { control.loseAck = false; throw Error('synthetic lost acknowledgement'); }
    const id = mintNodeId('atom', sha(bytes).slice(7, 47));
    return Response.json({ version: 1, status: 'committed', expectedRevision: request.expectedRevision, resource: url,
      revision, bodyDigest: sha(bytes), contentType: 'application/json', pod: 'css', path: url, size: bytes.length,
      updatedAt: at, topUri: id, opaqueUri: id }, { headers: { ETag: '"' + revision + '-json"' } });
  };
  const create = (readOnly = false) => createOwnSubjectActivityStore(authority, { privateKey, fetch: transport, readOnly, now: () => at, selfBaseUrl: 'https://actual-bridge.test' });
  const statement = (when = at, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), actor: { objectType: 'Agent', account: { homePage: 'https://identity.test', name: owner } },
    verb: { id: 'urn:test:performed' }, object: { objectType: 'Activity', id: 'urn:test:task' }, timestamp: new Date(when).toISOString(),
    context: { extensions: { 'urn:interego:gaming:activity:context': { bodyId: 'alice:companion:fixture', controllerKind: 'agent', controllerId: 'did:web:identity.test:agents:actual-agent' } } }, ...extra });
  const key = deriveEncryptionKeyPair(privateKey, 'urn:foxxi:personal-activity-window:' + owner);
  const native = new NativeCommitStore({ scope: { pod, owner: owner as IRI, headUrl: pod + 'foxxi/activity/own-subject/head', artifactContainer: pod + 'foxxi/activity/own-subject/artifacts/' },
    atomicCheckpoint: true, senderKeyPair: key, ownerPublicKey: ownerKey.publicKey, recipientPublicKeys: [ownerKey.publicKey, key.publicKey], fetch: transport });
  return { create, statement, rows, calls, control, authority, transport, now: () => at, advance(ms: number) { at += ms; }, puts: () => calls.filter(c => c.method === 'PUT').length,
    async mutate(change: (s: any) => void) {
      const checkpoint = await native.readAtomicCheckpoint();
      const original = readNativeByteArtifact(checkpoint.artifact!);
      const state = JSON.parse(gunzipSync(original.bytes).toString('utf8')); change(state);
      await native.commitAtomicCheckpoint(checkpoint.revision, createNativeByteArtifact({ owner: owner as IRI, contentType: original.contentType, bytes: gzipSync(Buffer.from(JSON.stringify(state))) }));
    } };
}

describe('bounded own-subject native activity primary', () => {
  it('uses one encrypted resource, real owner binding, immutable UUID replay and read-only zero writes', async () => {
    const f = fixture(), store = f.create(), s = f.statement();
    expect((await f.create(true).read({})).status).toBe(200); expect(f.puts()).toBe(0);
    const result = await store.write([s]); expect(result.status).toBe(200);
    expect(f.rows.size).toBe(1); expect(f.puts()).toBe(1);
    const saved = await f.create(true).read({ statementId: s.id });
    expect(saved.status).toBe(200); expect((saved.body as any).statement.authority.account.homePage).toBe('https://actual-bridge.test');
    expect((saved.body as any).statement.version).toBe('2.0.0');
    expect(f.rows.values().next().value!.bytes.includes(Buffer.from('urn:test:performed'))).toBe(false);
    f.advance(1000); expect((await f.create().write([s])).status).toBe(200); expect(f.puts()).toBe(1);
    expect((await store.write([{ ...s, object: { id: 'urn:changed' } }])).status).toBe(409); expect(f.puts()).toBe(1);
    expect((await f.create(true).write([f.statement()])).status).toBe(403); expect(f.puts()).toBe(1);
    const wrong = createOwnSubjectActivityStore({ ...f.authority, subjectDid: 'did:web:identity.test:users:bob' }, { privateKey: 'a'.repeat(64), fetch: f.transport, readOnly: true });
    await expect(wrong.read({})).rejects.toThrow();
    f.control.corrupt = true; await expect(store.read({})).rejects.toThrow(); expect(f.puts()).toBe(1);
  });
  it('rolls detail beyond 512 while retaining cumulative facts and replay receipts, then continues after an hour', async () => {
    const f = fixture(), store = f.create(); let first: any;
    for (let batch = 0; batch < 27; batch++) {
      const list = Array.from({ length: 20 }, () => f.statement()); first ??= list[0];
      expect((await store.write(list)).status).toBe(200); f.advance(1000);
    }
    const read = (await store.read({ limit: 200 })).body as any;
    expect(read.profile.total).toBe(540); expect(read.coverage.retainedCount).toBe(512); expect(read.coverage.prunedCount).toBe(28);
    expect(read.profile.byController).toEqual([{ id: 'did:web:identity.test:agents:actual-agent', count: 540 }]);
    expect((await store.read({ statementId: first.id })).status).toBe(410);
    const count = f.puts(); expect((await f.create().write([first])).status).toBe(200); expect(f.puts()).toBe(count);
    f.advance(L.retentionMs); expect((await store.write([first])).status).toBe(410); expect(f.puts()).toBe(count);
    expect((await store.write([f.statement()])).status).toBe(200);
    const next = (await f.create(true).read({})).body as any;
    expect(next.profile.total).toBe(541); expect(next.coverage.retainedCount).toBe(1); expect(f.rows.size).toBe(1);
    expect(f.rows.values().next().value!.bytes.length).toBeLessThanOrEqual(L.encryptedBytes);
  }, 60000);
  it('CAS races merge distinct observations, exact concurrent retries count once, and lost acknowledgement preserves original receipts', async () => {
    const f = fixture(), first = f.statement();
    const raced = await Promise.all([f.create().write([first]), f.create().write([first])]);
    expect(raced.map(r => r.status)).toEqual([200, 200]); expect(f.puts()).toBe(2);
    const pair = await Promise.all([f.create().write([f.statement()]), f.create().write([f.statement()])]);
    expect(pair.map(r => r.status)).toEqual([200, 200]);
    expect(((await f.create().read({})).body as any).profile.total).toBe(3);
    f.control.loseAck = true; const lost = f.statement(); expect((await f.create().write([lost])).status).toBe(200);
    // Actual SDK reconciles a committed PUT whose acknowledgement was lost.
    const count = f.puts(); expect((await f.create().write([lost])).status).toBe(200); expect(f.puts()).toBe(count);
    expect(((await f.create().read({})).body as any).profile.total).toBe(4);
  });
  it('persists its hourly encrypted-byte budget across cold instances and resumes when buckets expire', async () => {
    const f = fixture(); expect((await f.create().write([f.statement()])).status).toBe(200);
    await f.mutate(state => { state.budget = [{ minute: Math.floor(f.now() / 60000), bytes: L.writeBytesPerHour }]; });
    const count = f.puts(); expect((await f.create().write([f.statement()])).status).toBe(429); expect(f.puts()).toBe(count);
    f.advance(L.retentionMs + 60001); expect((await f.create().write([f.statement()])).status).toBe(200);
    expect(((await f.create().read({})).body as any).profile.total).toBe(2);
  });
  it('preserves unexpired UUID receipts at the admission cap and resumes rather than failing permanently', async () => {
    const f = fixture(), first = f.statement(); expect((await f.create().write([first])).status).toBe(200);
    await f.mutate(state => {
      const original = state.receipts[0];
      state.receipts = Array.from({ length: L.receipts }, (_, index) => index === 0 ? original
        : { ...original, id: randomUUID(), digest: sha('synthetic acknowledged observation ' + index).slice(7), sequence: index + 1 });
      state.sequence = state.profile.total = L.receipts; state.profile.detailsPruned = L.receipts - 1;
      for (const field of ['byVerb', 'byBody', 'byController']) state.profile[field][0].count = L.receipts;
    });
    const count = f.puts(); expect((await f.create().write([f.statement()])).status).toBe(429); expect(f.puts()).toBe(count);
    expect((await f.create().write([first])).status).toBe(200); expect(f.puts()).toBe(count);
    f.advance(L.retentionMs + 1); expect((await f.create().write([f.statement()])).status).toBe(200);
    expect(((await f.create().read({})).body as any).profile.total).toBe(L.receipts + 1); expect(f.rows.size).toBe(1);
  });
  it('keeps out-of-order observation coverage honest and binds cursors to head, filters and retention membership', async () => {
    const f = fixture(), older = f.statement(f.now() - L.retentionMs + 1000), newer = f.statement();
    expect((await f.create().write([newer, older, f.statement()])).status).toBe(200);
    const page = (await f.create().read({ limit: 1 })).body as any;
    expect(page.profile.firstAt).toBe(older.timestamp); expect(page.profile.lastAt).toBe(newer.timestamp); expect(page.coverage.retainedFrom).toBe(older.timestamp);
    expect((await f.create().read({ cursor: page.more, verb: 'urn:other' })).status).toBe(400);
    const next = await f.create().read({ cursor: page.more }); expect(next.status).toBe(200);
    f.advance(1001); expect((await f.create().read({ cursor: page.more })).status).toBe(409);
    const current = (await f.create().read({ limit: 1 })).body as any;
    expect((await f.create().write([f.statement()])).status).toBe(200);
    expect((await f.create().read({ cursor: current.more })).status).toBe(409);
  });
  it('rejects stale/future/foreign/oversize observations before storage and reports uncommitted write uncertainty without replacing it', async () => {
    const f = fixture();
    for (const s of [f.statement(f.now() - L.retentionMs), f.statement(f.now() + 6000), f.statement(f.now(), { actor: { account: { homePage: 'https://test', name: 'other' } } }),
      f.statement(f.now(), { result: { response: 'x'.repeat(17000) } })]) expect((await f.create().write([s])).status).toBeGreaterThanOrEqual(400);
    expect(f.calls.length).toBe(0);
    f.control.failedPuts = true; const value = f.statement(); expect((await f.create().write([value])).status).toBe(502);
    expect(f.puts()).toBe(1); expect(f.rows.size).toBe(0);
    expect((await f.create(true).read({ statementId: value.id })).status).toBe(404); expect(f.puts()).toBe(1);
  });
});
