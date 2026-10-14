import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { Wallet } from 'ethers';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, openEncryptedEnvelope, createEncryptedEnvelope } from '@interego/core';
import { recoverSignedRequest } from '../src/auth.js';
import { attachWorkbenchRoutes, WorkbenchDocuments, workbenchUserId, workbenchEncryptionKeypair, validateWorkbenchDocument, type WorkbenchConfig } from '../src/i2idlx-workbench.js';

const alice = Wallet.createRandom(), bob = Wallet.createRandom();
const actor = (w: typeof alice) => 'did:ethr:' + w.address;
const id = (w: typeof alice) => 'eth-' + w.address.toLowerCase().slice(2, 14);
const pod = (w: typeof alice) => 'https://pod.example/' + id(w) + '/';
const ownerKeys = new Map([[actor(alice), generateKeyPair()], [actor(bob), generateKeyPair()]]);
const base = 'https://bridge.example';
const shared = 'https://pod.example/georgio/';
const ballot = { v: { 'mapping:one': { vote: 'for', note: 'Fixture only.', at: 1 } } };
async function sign(w: typeof alice, args: Record<string, unknown>) {
  const _signed_payload = JSON.stringify({ ...args, agent_id: actor(w), timestamp: new Date().toISOString() });
  const hash = createHash('sha256').update(_signed_payload).digest('hex');
  return { _signed_payload, _signature: await w.signMessage('sha256:' + hash) };
}
const put = (w: typeof alice, path: string, document: unknown, expected_etag = '', owner_encryption_key: string | undefined = ownerKeys.get(actor(w))!.publicKey) =>
  sign(w, { i2idlx_operation: 'write', bridge_audience: base, doc_path: path, document, expected_etag, ...(owner_encryption_key ? { owner_encryption_key } : {}) });
function fixture() {
  const files = new Map<string, { body: string; etag: string }>();
  const requests: { url: string; method: string; body?: string; headers: Headers }[] = [];
  let revision = 0, noEtag = false, unreadable = false, conflict = false, loseAck = false;
  const bridge = generateKeyPair(), owner = ownerKeys.get(actor(alice))!;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET', headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    requests.push({ url, method, body, headers });
    if (url === pod(alice) || url === pod(bob) || url === shared) return new Response(null, { status: 200 });
    const prev = files.get(url);
    if (method === 'PUT') {
      if (conflict && url.endsWith('.json')) { conflict = false; return new Response('', { status: 412 }); }
      if ((headers.get('If-None-Match') === '*' && prev) || (headers.has('If-Match') && headers.get('If-Match') !== prev?.etag)) return new Response('', { status: 412 });
      files.set(url, { body: body!, etag: '"' + (++revision) + '"' });
      if (loseAck && url.endsWith('.json')) { loseAck = false; throw new Error('Fixture: acknowledgement lost after commit'); }
      return new Response('', { status: 201 });
    }
    if (unreadable) return new Response('', { status: 500 });
    return prev ? new Response(method === 'HEAD' ? null : prev.body, { headers: noEtag ? {} : { ETag: prev.etag } }) : new Response('', { status: 404 });
  };
  const config: WorkbenchConfig = {
    baseUrl: base, sharedPodUrl: shared, participantIds: [id(alice), id(bob)], editorDids: [actor(alice)],
    fetch: fetcher, ownPod: who => who === actor(alice) ? pod(alice) : who === actor(bob) ? pod(bob) : (() => { throw new Error('Unknown test actor'); })(),
    verifyCaller: async body => {
      const r = recoverSignedRequest(body);
      if (!r.ok) return { ok: false, status: 401, error: r.reason };
      if (r.agentId !== 'did:ethr:' + r.signer || ![actor(alice), actor(bob)].includes(r.agentId)) return { ok: false, status: 403, error: 'Signer does not own the fixture account.' };
      return { ok: true, callerDid: r.agentId, payload: r.payload };
    },
    verifyAuthor: async (who, signer) => who === 'did:ethr:' + signer && [actor(alice), actor(bob)].includes(who),
    encryptionKeypair: () => bridge,
  };
  const documents = new WorkbenchDocuments(config);
  return { files, requests, config, documents, bridge, owner, noEtag: () => { noEtag = true; }, unreadable: () => { unreadable = true; }, conflict: () => { conflict = true; }, loseAck: () => { loseAck = true; } };
}
describe('I2IDL-X pod-backed workbench security', () => {
  it('derives account ids only from canonical own pods and refuses shared fallback/path steering', () => {
    expect(workbenchUserId(pod(alice))).toBe(id(alice));
    for (const value of [shared, 'https://pod.example/', pod(alice) + 'another/', pod(alice) + '?x=1', pod(alice).replace('https:', 'http:')]) expect(() => workbenchUserId(value)).toThrow();
    expect(workbenchEncryptionKeypair(undefined)).toBeNull();
    expect(workbenchEncryptionKeypair('public-demo-seed')).toBeNull();
  });
  it('retains the exact author signature, stores on the shared pod and verifies readback before durable', async () => {
    const f = fixture(), path = 'ballots/' + id(alice), proof = await put(alice, path, ballot);
    const result = await f.documents.write(proof);
    expect(result).toMatchObject({ ok: true, durable: true, exists: true, data: ballot });
    expect(result.resource_url.startsWith(shared)).toBe(true);
    const ciphertext = JSON.parse(f.files.get(result.resource_url)!.body);
    const written = JSON.parse(openEncryptedEnvelope(ciphertext, f.bridge)!);
    expect(f.files.get(result.resource_url)!.body).not.toContain('Fixture only.');
    expect(written.proof).toEqual(proof);
    expect(written.actor).toBe(actor(alice));
    expect(written.owner).toBe(id(alice));
    const request = f.requests.find(r => r.method === 'PUT' && r.url.endsWith('.json'))!;
    expect(request.headers.get('If-None-Match')).toBe('*');
    expect((await new WorkbenchDocuments(f.config).read(path, actor(alice))).data).toEqual(ballot);
  });
  it('refuses cross-account ballots and private workspace writes before any pod write', async () => {
    const f = fixture();
    await expect(f.documents.write(await put(bob, 'ballots/' + id(alice), ballot))).rejects.toThrow('only their own');
    await expect(f.documents.write(await put(bob, 'data/users/' + id(alice) + '/workspace', { packs: [], stars: [] }))).rejects.toThrow('only their own');
    expect(f.requests.some(r => r.method === 'PUT')).toBe(false);
    await expect(f.documents.read('data/users/' + id(alice) + '/workspace', actor(bob))).rejects.toThrow('another account');
  });
  it('ignores claimed owner/editor flags and requires exact server-configured editor DID', async () => {
    const f = fixture();
    await expect(f.documents.write(await sign(bob, { i2idlx_operation: 'write', bridge_audience: base, doc_path: 'settings/policy', document: { quorum: 1 }, expected_etag: '', canEdit: true, user_id: id(alice) }))).rejects.toThrow('configured verified editor');
    const policy = await f.documents.write(await put(alice, 'settings/policy', { quorum: 3 }));
    expect(policy.data).toEqual({ quorum: 3 });
  });
  it('refuses absent shared configuration, unknown accounts, unsigned and session-key documents', async () => {
    const f = fixture();
    const closed = new WorkbenchDocuments({ ...f.config, participantIds: [] });
    await expect(closed.write(await put(alice, 'notes/' + id(alice), { n: {} }))).rejects.toThrow('not admitted');
    const absent = new WorkbenchDocuments({ ...f.config, sharedPodUrl: undefined });
    await expect(absent.collection('notes')).rejects.toThrow('not configured');
    await expect(f.documents.write({ document: ballot })).rejects.toThrow('signed request');
    await expect(f.documents.write({ ...await put(alice, 'ballots/' + id(alice), ballot), _session: {} })).rejects.toThrow('session-key');
  });
  it('rejects a valid signature replayed to another bridge audience or another operation', async () => {
    const f = fixture();
    await expect(f.documents.write(await sign(alice, { i2idlx_operation: 'write', bridge_audience: 'https://evil.example', doc_path: 'ballots/' + id(alice), document: ballot, expected_etag: '' }))).rejects.toThrow('bound');
    await expect(f.documents.write(await sign(alice, { i2idlx_operation: 'read', bridge_audience: base, doc_path: 'ballots/' + id(alice), document: ballot, expected_etag: '' }))).rejects.toThrow('bound');
  });
  it('does not let stale devices overwrite an intervening vote', async () => {
    const f = fixture(), path = 'ballots/' + id(alice);
    const first = await f.documents.write(await put(alice, path, ballot));
    const next = { v: { 'mapping:one': { vote: 'against', note: '', at: 2 } } };
    await f.documents.write(await put(alice, path, next, first.etag!));
    await expect(f.documents.write(await put(alice, path, ballot, first.etag!))).rejects.toThrow('another device');
    expect((await f.documents.read(path, actor(alice))).data).toEqual(next);
  });
  it('propagates conditional storage conflicts and refuses existing documents without an ETag', async () => {
    const f = fixture(), path = 'ballots/' + id(alice);
    f.conflict();
    await expect(f.documents.write(await put(alice, path, ballot))).rejects.toThrow('conflicted');
    await f.documents.write(await put(alice, path, ballot));
    f.noEtag();
    await expect(f.documents.write(await put(alice, path, ballot, '"1"'))).rejects.toThrow('no ETag');
  });
  it('does not convert unreadable or forged documents into empty shared state', async () => {
    const f = fixture(), path = 'ballots/' + id(alice);
    const saved = await f.documents.write(await put(alice, path, ballot));
    const file = f.files.get(saved.resource_url)!;
    const tampered = JSON.parse(openEncryptedEnvelope(JSON.parse(file.body), f.bridge)!); tampered.document.v['mapping:one'].vote = 'against';
    file.body = JSON.stringify(createEncryptedEnvelope(JSON.stringify(tampered), [f.owner.publicKey, f.bridge.publicKey], generateKeyPair()));
    await expect(f.documents.read(path, actor(alice))).rejects.toThrow('verification');
    f.unreadable();
    await expect(f.documents.collection('ballots', actor(alice))).rejects.toThrow('unavailable');
  });
  it('keeps an authentic historical record readable after the request replay window', async () => {
    const f = fixture(), path = 'ballots/' + id(alice);
    await f.documents.write(await put(alice, path, ballot));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
    try { expect((await f.documents.read(path, actor(alice))).data).toEqual(ballot); }
    finally { clock.mockRestore(); }
  });
  it('rechecks historical author delegation instead of trusting a storage location', async () => {
    const f = fixture(), path = 'ballots/' + id(alice);
    await f.documents.write(await put(alice, path, ballot));
    const revoked = new WorkbenchDocuments({ ...f.config, verifyAuthor: async () => false });
    await expect(revoked.read(path, actor(alice))).rejects.toThrow('verification');
  });
  it('stores only ciphertext on the own pod and wraps the private workspace key to its owner', async () => {
    const f = fixture(), path = 'data/users/' + id(alice) + '/workspace';
    const data = { packs: [{ id: 'my-private-pack', title: 'Private fixture' }], stars: ['learning-record-store-lrs'], recents: [] };
    const result = await f.documents.write(await put(alice, path, data, '', f.owner.publicKey));
    expect(result.resource_url.startsWith(pod(alice))).toBe(true);
    const wire = f.files.get(result.resource_url)!.body;
    expect(wire).not.toContain('my-private-pack');
    const envelope = JSON.parse(wire);
    expect(JSON.parse(openEncryptedEnvelope(envelope, f.owner)!).document).toEqual(data);
    expect(openEncryptedEnvelope(envelope, generateKeyPair())).toBeNull();
    expect((await f.documents.read(path, actor(alice))).data).toEqual(data);
  });
  it('ignores substituted unsigned pod keys and requires an author-signed owner binding', async () => {
    const f = fixture(), path = 'data/users/' + id(alice) + '/workspace';
    const attacker = generateKeyPair();
    f.files.set(pod(alice) + 'keys/encryption.json', { body: JSON.stringify({ algorithm: attacker.algorithm, publicKey: attacker.publicKey }), etag: '"1"' });
    await expect(f.documents.write(await put(alice, path, { packs: [], stars: [] }, '', ''))).rejects.toThrow('author-signed owner encryption');
    const saved = await f.documents.write(await put(alice, path, { packs: [], stars: [] }, '', f.owner.publicKey));
    const wire = JSON.parse(f.files.get(saved.resource_url)!.body);
    expect(wire.wrappedKeys.some((w: { recipientPublicKey: string }) => w.recipientPublicKey === attacker.publicKey)).toBe(false);
    expect(openEncryptedEnvelope(wire, attacker)).toBeNull();
    expect(openEncryptedEnvelope(wire, f.owner)).not.toBeNull();
    wire.wrappedKeys = wire.wrappedKeys.filter((w: { recipientPublicKey: string }) => w.recipientPublicKey !== f.owner.publicKey);
    f.files.get(saved.resource_url)!.body = JSON.stringify(wire);
    await expect(f.documents.read(path, actor(alice))).rejects.toThrow('owner recipient');
  });
  it('encrypts shared records and requires admitted caller identity for every shared read', async () => {
    const f = fixture(), path = 'ballots/' + id(alice);
    const saved = await f.documents.write(await put(alice, path, ballot));
    const envelope = JSON.parse(f.files.get(saved.resource_url)!.body);
    expect(openEncryptedEnvelope(envelope, f.owner)).not.toBeNull();
    await expect(f.documents.read(path)).rejects.toThrow('participant identity');
    const noMember = new WorkbenchDocuments({ ...f.config, participantIds: [id(alice)] });
    await expect(noMember.read(path, actor(bob))).rejects.toThrow('not admitted');
    await expect(noMember.collection('ballots', actor(bob))).rejects.toThrow('not admitted');
    const missingKeys = new WorkbenchDocuments({ ...f.config, encryptionKeypair: () => null });
    await expect(missingKeys.collection('ballots', actor(alice))).rejects.toThrow('stable encryption');
    const missingMembers = new WorkbenchDocuments({ ...f.config, participantIds: [] });
    await expect(missingMembers.collection('ballots', actor(alice))).rejects.toThrow('admitted accounts');
  });
  it('refuses invalid owner bindings and plaintext or bridge-only fallback', async () => {
    const f = fixture(), path = 'data/users/' + id(alice) + '/workspace';
    await expect(f.documents.write(await put(alice, path, { packs: [], stars: [] }, '', 'unsigned-pod-key'))).rejects.toThrow('author-signed owner encryption');
    const withoutBridge = new WorkbenchDocuments({ ...f.config, encryptionKeypair: () => null });
    await expect(withoutBridge.write(await put(alice, path, { packs: [], stars: [] }, '', f.owner.publicKey))).rejects.toThrow('stable bridge');
    expect(f.requests.some(r => r.method === 'PUT' && r.url.endsWith('.json'))).toBe(false);
  });
  it('refuses unsafe document shapes instead of changing a signed body', () => {
    for (const value of [{ quorum: 0 }, { quorum: 2, canEdit: true }, { quorum: 1001 }]) expect(() => validateWorkbenchDocument('settings/policy', value)).toThrow();
    expect(() => validateWorkbenchDocument('notes/' + id(alice), { n: { a: { c: 'concept', text: 'x'.repeat(2001), at: 1 } } })).toThrow();
    expect(() => validateWorkbenchDocument('../notes/' + id(alice), { n: {} })).toThrow();
  });
  it('round-trips large signed encrypted documents within the admitted byte limits', async () => {
    const f = fixture(), path = 'notes/' + id(alice);
    // JSON escaping plus retained signed-payload duplication exceeds the old 2 MB envelope cap.
    const document = { n: Object.fromEntries(Array.from({ length: 400 }, (_, i) =>
      ['note-' + i, { c: 'concept', text: String.fromCharCode(0).repeat(350), at: 1 }])) };
    const proof = await put(alice, path, document);
    expect(Buffer.byteLength(JSON.stringify(document), 'utf8')).toBeLessThan(1_000_000);
    expect(Buffer.byteLength(proof._signed_payload, 'utf8')).toBeLessThan(1_100_000);
    const saved = await f.documents.write(proof);
    const wire = f.files.get(saved.resource_url)!.body;
    expect(Buffer.byteLength(wire, 'utf8')).toBeGreaterThan(2_000_000);
    expect(Buffer.byteLength(wire, 'utf8')).toBeLessThan(6_000_000);
    expect((await f.documents.read(path, actor(alice))).data).toEqual(document);
  });
  it('bounds signed payloads by UTF-8 bytes rather than UTF-16 code units before transport', async () => {
    const f = fixture();
    const proof = await sign(alice, { i2idlx_operation: 'write', bridge_audience: base,
      doc_path: 'ballots/' + id(alice), document: ballot, expected_etag: '', extra: '😀'.repeat(280000) });
    expect(proof._signed_payload.length).toBeLessThan(1_100_000);
    expect(Buffer.byteLength(proof._signed_payload, 'utf8')).toBeGreaterThan(1_100_000);
    await expect(f.documents.write(proof)).rejects.toThrow('Signed request too large');
    expect(f.requests.length).toBe(0);
  });
  it('does not claim completion after a write acknowledgement is lost', async () => {
    const f = fixture(), path = 'ballots/' + id(alice); f.loseAck();
    await expect(f.documents.write(await put(alice, path, ballot))).rejects.toThrow('acknowledgement lost');
    expect((await f.documents.read(path, actor(alice))).data).toEqual(ballot);
  });
});
describe('I2IDL-X live route contract (local fixture only)', () => {
  it('consumes a server-issued nonce, derives identity, and never advertises project-paid inference', async () => {
    const f = fixture(), app = express(); app.use(express.json());
    attachWorkbenchRoutes(app, f.config);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const local = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    try {
      const capabilities = await (await fetch(local + '/i2idlx/capabilities')).json();
      expect(capabilities.ai.project_paid).toBe(false);
      expect(capabilities._affordances.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['urn:iep:action:foxxi:i2idlx-ask', 'urn:iep:action:foxxi:i2idlx-orchestrate']));
      const challenge = await (await fetch(local + '/i2idlx/challenge')).json();
      const signed = await sign(alice, { i2idlx_operation: 'session', bridge_audience: base, nonce: challenge.nonce, user_id: 'victim', canEdit: true });
      const call = () => fetch(local + '/i2idlx/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed) });
      const first = await call(); expect(first.status).toBe(200); expect((await first.json()).me.id).toBe(id(alice));
      expect((await call()).status).toBe(401);
      const unsigned = await fetch(local + '/i2idlx/api/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc_path: 'ballots/' + id(alice), document: ballot }) });
      expect(unsigned.status).toBe(401);
      const nonceLess = await sign(bob, { i2idlx_operation: 'session', bridge_audience: base });
      expect((await fetch(local + '/i2idlx/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nonceLess) })).status).toBe(401);
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  });
});
