import { createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { deriveEncryptionKeyPair, mintNodeId, type IRI } from '@interego/core';
import { NativeCommitStore, NATIVE_COMMIT_MEDIA_TYPE, createNativeByteArtifact, readNativeByteArtifact } from '@interego/pgsl';
import { createLearningRepository } from '../src/i2idlx-learning-repository.js';
import { emptyLearningState } from '../src/i2idlx-learning-connections.js';

const sha = (bytes: string | Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const BASE = 'https://workbench.example', POD = 'https://store.example/service/', KEY = 'a'.repeat(64);
function scope(baseUrl = BASE) {
  const base = new URL(baseUrl), partition = createHash('sha256').update(base.origin).digest('hex').slice(0, 32);
  return { owner: new URL('/i2idlx/learning/service', base).href as IRI, pod: POD,
    headUrl: POD + 'foxxi/learning-connections/' + partition + '/checkpoint',
    artifactContainer: POD + 'foxxi/learning-connections/' + partition + '/artifacts/' };
}
// Real SDK encryption/provenance/scope/CAS. HTTP is isolated; no live pod credentials.
function fixture() {
  let serial = 0;
  const rows = new Map<string, { bytes: Buffer; revision: string }>();
  const control = { status: 0, putStatus: 0, corrupt: false, corruptDigest: false, missingMetadata: false,
    nativeCapability: true, loseWriteReply: false, failReadAfterLostReply: false, readUnavailable: false };
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const transport = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? 'GET', headers = new Headers(init.headers);
    calls.push({ url, method, ...(method === 'PUT' ? { body: String(init.body) } : {}) });
    expect(init.redirect).toBe('manual');
    if (control.status) return new Response(null, { status: control.status });
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: control.nativeCapability
      ? { 'Accept-Put': NATIVE_COMMIT_MEDIA_TYPE, 'Interego-Native-Commit': '1' } : { 'Accept-Put': 'application/octet-stream' } });
    if (method === 'GET') {
      if (control.readUnavailable) return new Response(null, { status: 503 });
      const row = rows.get(url); if (!row) return new Response(null, { status: 404 });
      const bytes = control.corrupt ? Buffer.from('corrupt ciphertext') : row.bytes;
      return new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': 'application/json', ETag: '"' + row.revision + '-json"',
        ...(!control.missingMetadata ? { 'Interego-Revision': row.revision, 'Interego-Body-Digest': control.corruptDigest ? sha('wrong') : sha(bytes) } : {}) } });
    }
    expect(method).toBe('PUT'); expect(headers.get('Content-Type')).toBe(NATIVE_COMMIT_MEDIA_TYPE);
    const request = JSON.parse(String(init.body)), old = rows.get(url);
    expect(Object.keys(request).sort()).toEqual(['bodyBase64', 'contentType', 'expectedRevision', 'version']);
    expect(request.version).toBe(1); expect(request.contentType).toBe('application/json');
    expect(headers.get(request.expectedRevision === null ? 'If-None-Match' : 'If-Match')).toBe(request.expectedRevision === null ? '*' : '"' + request.expectedRevision + '"');
    if (request.expectedRevision === null && old || request.expectedRevision !== null && old?.revision !== request.expectedRevision) return new Response(null, { status: 412 });
    if (control.putStatus) return new Response(null, { status: control.putStatus });
    const bytes = Buffer.from(request.bodyBase64, 'base64'), revision = sha(url + ':' + (++serial) + ':' + sha(bytes)); rows.set(url, { bytes, revision });
    if (control.loseWriteReply) { control.loseWriteReply = false; control.readUnavailable = control.failReadAfterLostReply; throw new Error('Lost acknowledgement'); }
    const id = mintNodeId('atom', sha(bytes).slice(7, 47));
    return Response.json({ version: 1, status: 'committed', expectedRevision: request.expectedRevision, resource: url, revision, bodyDigest: sha(bytes),
      contentType: 'application/json', pod: 'css', path: url, size: bytes.length, updatedAt: Date.parse('2026-11-07T12:00:00.000Z'), topUri: id, opaqueUri: id },
    { headers: { ETag: '"' + revision + '-json"' } });
  }) as typeof fetch;
  const make = (privateKey = KEY, baseUrl = BASE) => createLearningRepository({ baseUrl, podUrl: POD, privateKey, fetch: transport });
  const native = (baseUrl = BASE, extraRecipient = false) => {
    const key = deriveEncryptionKeyPair(KEY, 'urn:foxxi:i2idlx-learning-connections:v1:' + new URL(baseUrl).origin);
    return new NativeCommitStore({ scope: scope(baseUrl), atomicCheckpoint: true, senderKeyPair: key, ownerPublicKey: key.publicKey,
      recipientPublicKeys: [key.publicKey, ...(extraRecipient ? [deriveEncryptionKeyPair('c'.repeat(64), 'outsider').publicKey] : [])], fetch: transport });
  };
  return { control, calls, make, rows, native, bytes: () => rows.get(scope().headUrl)?.bytes,
    async mutate(change: (payload: Record<string, unknown>) => void) {
      const store = native(), checkpoint = await store.readAtomicCheckpoint(), original = readNativeByteArtifact(checkpoint.artifact!);
      const value = JSON.parse(gunzipSync(original.bytes).toString('utf8')) as Record<string, unknown>; change(value);
      await store.commitAtomicCheckpoint(checkpoint.revision, createNativeByteArtifact({ owner: scope().owner,
        contentType: original.contentType, bytes: gzipSync(Buffer.from(JSON.stringify(value))) }));
    } };
}
function state() {
  const value = emptyLearningState();
  value.connectors.push({ id: 'a'.repeat(32), owner: 'did:web:identity.example:users:admin', label: 'Synthetic institution',
    provider: 'scorm-cloud', authorization: 'Basic ' + Buffer.from('synthetic-app:FIXTURE-CREDENTIAL').toString('base64'),
    joinCode: 'b'.repeat(48), policy: { allowAiContent: true, allowAiProgress: true }, revision: 'c'.repeat(32),
    status: 'active', createdAt: '2026-11-07T12:00:00.000Z' });
  return value;
}

describe('encrypted learning connector checkpoint', () => {
  it('stores one native ciphertext resource for only the service recipient and survives a cold restart', async () => {
    const f = fixture(), repo = f.make();
    expect(await repo.read()).toEqual({ revision: null, state: emptyLearningState() }); await repo.write(null, state());
    const reopened = await f.make().read(); expect(reopened.state).toEqual(state()); expect(reopened.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    const wire = f.bytes()!.toString('utf8');
    for (const secret of ['FIXTURE-CREDENTIAL', 'Synthetic institution', 'identity.example', 'synthetic-app', 'authorization']) expect(wire).not.toContain(secret);
    const key = deriveEncryptionKeyPair(KEY, 'urn:foxxi:i2idlx-learning-connections:v1:' + BASE);
    expect(JSON.parse(wire).wrappedKeys.map((entry: { recipientPublicKey: string }) => entry.recipientPublicKey)).toEqual([key.publicKey]);
    expect(new Set(f.calls.map(c => c.url))).toEqual(new Set([scope().headUrl])); expect(f.rows.size).toBe(1);
  });
  it('refuses stale CAS and permits exactly one concurrent update without replacing the winner', async () => {
    const f = fixture(); await f.make().write(null, state());
    await expect(f.make().write(null, emptyLearningState())).rejects.toMatchObject({ status: 409, code: 'learning_store_conflict' });
    const checkpoint = await f.make().read(), first = state(), second = state(); first.connectors[0]!.label = 'First'; second.connectors[0]!.label = 'Second';
    const results = await Promise.allSettled([f.make().write(checkpoint.revision, first), f.make().write(checkpoint.revision, second)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'learning_store_conflict' } });
    expect(['First', 'Second']).toContain((await f.make().read()).state.connectors[0]!.label);
  });
  it.each([401, 403, 429, 500, 503])('does not turn storage HTTP%s into an empty authority registry', async status => {
    const f = fixture(); f.control.status = status;
    await expect(f.make().read()).rejects.toMatchObject({ status: 503, code: 'learning_store_unavailable' });
    expect(f.calls.some(c => c.method === 'PUT')).toBe(false);
  });
  it('requires native commit support and never falls back to ordinary PUT', async () => {
    const f = fixture(); f.control.nativeCapability = false;
    await expect(f.make().write(null, state())).rejects.toMatchObject({ code: 'learning_store_unconfirmed' });
    expect(f.calls.map(c => c.method)).toEqual(['OPTIONS']); expect(f.rows.size).toBe(0);
  });
  it.each(['corrupt', 'corruptDigest', 'missingMetadata'] as const)('rejects %s without resetting or repairing the checkpoint', async corruption => {
    const f = fixture(); await f.make().write(null, state()); const writes = f.calls.filter(call => call.method === 'PUT').length;
    f.control[corruption] = true; await expect(f.make().read()).rejects.toMatchObject({ code: 'learning_store_unavailable' });
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(writes);
  });
  it('refuses wrong keys and an envelope with an unauthorized extra recipient', async () => {
    const f = fixture(); await f.make().write(null, state());
    await expect(f.make('b'.repeat(64)).read()).rejects.toMatchObject({ code: 'learning_store_unavailable' });
    const checkpoint = await f.native().readAtomicCheckpoint();
    await f.native(BASE, true).commitAtomicCheckpoint(checkpoint.revision, createNativeByteArtifact({ owner: scope().owner,
      contentType: 'application/vnd.interego.rolling-checkpoint+gzip', bytes: readNativeByteArtifact(checkpoint.artifact!).bytes }));
    await expect(f.make().read()).rejects.toMatchObject({ code: 'learning_store_unavailable' });
  });
  it('partitions service origins and refuses ciphertext copied between partitions', async () => {
    const f = fixture(), other = 'https://another-workbench.example'; await f.make().write(null, state());
    expect(await f.make(KEY, other).read()).toEqual({ revision: null, state: emptyLearningState() });
    await f.make(KEY, other).write(null, emptyLearningState()); expect(f.rows.size).toBe(2); expect((await f.make().read()).state).toEqual(state());
    const original = f.rows.get(scope().headUrl)!; f.rows.set(scope(other).headUrl, { bytes: Buffer.from(original.bytes), revision: sha('copied ciphertext') });
    await expect(f.make(KEY, other).read()).rejects.toMatchObject({ code: 'learning_store_unavailable' });
  });
  it.each(['format', 'owner', 'pod', 'head'] as const)('refuses an authentic encrypted payload with corrupt %s binding', async field => {
    const f = fixture(); await f.make().write(null, state()); await f.mutate(payload => { payload[field] = 'foreign'; });
    await expect(f.make().read()).rejects.toMatchObject({ code: 'learning_store_unavailable' });
  });
  it('refuses persisted authority containing unexpected course bodies or progress', async () => {
    const f = fixture(); await f.make().write(null, state());
    await f.mutate(payload => { payload.state = { ...state(), course_bodies: ['not retained here'], progress: [{ score: 99 }] }; });
    await expect(f.make().read()).rejects.toMatchObject({ code: 'learning_store_unavailable' });
  });
  it('reconciles a lost committed acknowledgement by reading exact ciphertext without another write', async () => {
    const f = fixture(); f.control.loseWriteReply = true; await f.make().write(null, state());
    expect((await f.make().read()).state).toEqual(state()); expect(f.calls.filter(c => c.method === 'PUT')).toHaveLength(1);
  });
  it('reports unreadable lost-ack outcome as unconfirmed and preserves it for later reconciliation', async () => {
    const f = fixture(); f.control.loseWriteReply = true; f.control.failReadAfterLostReply = true;
    await expect(f.make().write(null, state())).rejects.toMatchObject({ code: 'learning_store_unconfirmed' });
    expect(f.calls.filter(c => c.method === 'PUT')).toHaveLength(1); f.control.readUnavailable = false;
    expect((await f.make().read()).state).toEqual(state());
  });
  it.each([401, 403, 503])('preserves the old checkpoint after a refused PUT%s', async status => {
    const f = fixture(); await f.make().write(null, state()); const original = await f.make().read(); f.control.putStatus = status;
    await expect(f.make().write(original.revision, emptyLearningState())).rejects.toMatchObject({ code: 'learning_store_unconfirmed' });
    expect((await f.make().read()).state).toEqual(state());
  });
  it('rejects invalid configuration and invalid state before contacting storage', async () => {
    const f = fixture(); expect(() => f.make('not-a-key')).toThrow(); expect(() => f.make(KEY, 'http://localhost:6080')).toThrow();
    await expect(f.make().write(null, { ...emptyLearningState(), version: 2 } as never)).rejects.toMatchObject({ code: 'learning_store_unavailable' });
    expect(f.calls).toHaveLength(0);
  });
  it('rejects incompressible metadata over its gzip budget before contacting native storage', async () => {
    const f = fixture(), value = emptyLearningState();
    value.connectors = Array.from({ length: 8 }, (_, index) => ({ ...state().connectors[0]!, id: index.toString(16).padStart(32, '0'),
      joinCode: index.toString(16).padStart(48, '0'), lti: { public_metadata: randomBytes(48000).toString('base64') } }));
    await expect(f.make().write(null, value)).rejects.toMatchObject({ status: 413, code: 'learning_store_capacity' });
    expect(f.calls).toHaveLength(0);
  });
});
