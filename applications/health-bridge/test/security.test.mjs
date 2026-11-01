import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet } from 'ethers';
import { createEncryptedStore, createSecurity } from '../security.mjs';

const relay = Wallet.createRandom();
const other = Wallet.createRandom();
const identityHost = 'identity.example.test';
const userId = 'u-pk-0123456789ab';
const agentId = `did:web:${identityHost}:agents:health-test-${userId}`;
const principal = `did:web:${identityHost}:users:${userId}`;
const target = 'https://health.example.test';
const time = Date.parse('2026-10-31T18:00:00.000Z');
const nonce = () => randomBytes(24).toString('base64url');
const digest = text => createHash('sha256').update(text).digest('hex');
const payload = changes => ({ agent_id: agentId, subject_pod_url: `https://pod.example.test/${userId}/`, timestamp: new Date(time).toISOString(), nonce: nonce(), action: 'health:read', target, ...changes });
async function envelope(value, signer = relay) {
  const _signed_payload = JSON.stringify(value);
  return { _signed_payload, _signature: await signer.signMessage(`sha256:${digest(_signed_payload)}`) };
}
function memoryStore() {
  const values = new Map();
  return { async get(k) { return structuredClone(values.get(k) ?? null); }, async put(k, v) { values.set(k, structuredClone(v)); }, async remove(k) { values.delete(k); } };
}
function security(options = {}) {
  return createSecurity({ relayUrl: 'https://relay.example.test', identityHost, trustedRelayAddresses: [relay.address], targetOrigin: target, now: () => time, store: memoryStore(), fetch: async url => {
    assert.equal(url, `https://${identityHost}/agents/health-test-${userId}/did.json`);
    return Response.json({ id: agentId, controller: principal });
  }, ...options });
}

test('a genuine delegated envelope binds signed actor, action, destination and payload', async () => {
  const p = payload({ recordId: 'one-private-record' });
  const actor = await security().authenticateSigned(await envelope(p), 'health:read', target);
  assert.equal(actor.userId, userId); assert.equal(actor.principal, principal); assert.equal(actor.agentId, agentId);
  assert.equal(actor.podUrl, `https://pod.example.test/${userId}/`);
  assert.equal(actor.payload.recordId, 'one-private-record'); assert.deepEqual(actor.scopes, []);
});

test('foreign signer, changed signed bytes, wrong action and wrong target are refused', async () => {
  const valid = payload();
  await assert.rejects(security().authenticateSigned(await envelope(valid, other), 'health:read', target), { code: 'signed_relay_untrusted' });
  const altered = await envelope(valid); altered._signed_payload = JSON.stringify({ ...valid, recordId: 'someone-else' });
  await assert.rejects(security().authenticateSigned(altered, 'health:read', target), { code: 'signed_relay_untrusted' });
  await assert.rejects(security().authenticateSigned(await envelope(valid), 'health:delete', target), { code: 'signed_action_mismatch' });
  await assert.rejects(security().authenticateSigned(await envelope(payload({ target: 'https://other.example.test' })), 'health:read', target), { code: 'signed_target_mismatch' });
});

test('missing nonce, stale/future time and forged subject pod are refused', async () => {
  for (const [changes, code] of [
    [{ nonce: undefined }, 'signed_nonce_invalid'],
    [{ timestamp: new Date(time - 60_001).toISOString() }, 'signed_timestamp_stale'],
    [{ timestamp: new Date(time + 5_001).toISOString() }, 'signed_timestamp_stale'],
    [{ subject_pod_url: 'https://pod.example.test/u-pk-ffffffffffff/' }, 'signed_subject_pod_mismatch'],
  ]) await assert.rejects(security().authenticateSigned(await envelope(payload(changes)), 'health:read', target), { code });
});

test('DID document and canonical agent suffix must identify the same user', async () => {
  const s = security({ fetch: async () => Response.json({ id: agentId, controller: `did:web:${identityHost}:users:u-pk-ffffffffffff` }) });
  await assert.rejects(s.authenticateSigned(await envelope(payload()), 'health:read', target), { code: 'signed_agent_controller_mismatch' });
});

test('a nonce cannot replay, including concurrent calls and a new security instance', async () => {
  const store = memoryStore(), first = security({ store }), second = security({ store });
  const signed = await envelope(payload());
  const results = await Promise.allSettled([first.authenticateSigned(signed, 'health:read', target), second.authenticateSigned(signed, 'health:read', target)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'signed_request_replayed');
  await assert.rejects(security({ store }).authenticateSigned(signed, 'health:read', target), { code: 'signed_request_replayed' });
});

test('OAuth bearer authentication challenges the MCP resource without privileged introspection or identity-token exchange', async () => {
  const calls = [];
  const s = security({ fetch: async (url, options = {}) => {
    calls.push({ url, method: options.method });
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/mcp')) {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-test-token');
      assert.equal(options.headers.Accept, 'application/json, text/event-stream');
      assert.equal(options.headers['MCP-Protocol-Version'], '2025-11-25');
      const call = JSON.parse(options.body);
      assert.equal(call.method, 'tools/call'); assert.equal(call.params.name, 'sign_request');
      const data = call.params.arguments.payload;
      assert.equal(data.action, 'urn:interego:health:authenticate'); assert.equal(data.target, target);
      return Response.json({jsonrpc:'2.0',id:call.id,result:{content:[{type:'text',text:JSON.stringify(await envelope(payload(data)))}]}});
    }
    return Response.json({ id: agentId, controller: principal });
  } });
  const actor = await s.authenticateBearer('Bearer synthetic-test-token');
  assert.equal(actor.userId, userId); assert.deepEqual(actor.scopes, []);
  assert.deepEqual(calls.map(x => x.url), ['https://relay.example.test/mcp', `https://${identityHost}/agents/health-test-${userId}/did.json`]);
  await assert.rejects(s.authenticateBearer('Bearer test\r\nInjected: value'), { code: 'authentication_required' });
});

test('a reused relay envelope cannot answer a different bearer challenge', async () => {
  const recorded = await envelope(payload({ action: 'urn:interego:health:authenticate' }));
  const s = security({ fetch: async (url, options) => url.endsWith('/mcp') ? Response.json({jsonrpc:'2.0',id:JSON.parse(options.body).id,result:{structuredContent:recorded}}) : Response.json({ id: agentId, controller: principal }) });
  await assert.rejects(s.authenticateBearer('Bearer synthetic-test-token'), { code: 'authentication_challenge_mismatch' });
});

test('SSE authentication stops after its matching answer even when the relay leaves the stream open', async () => {
  let cancelled = false;
  const s = security({ fetch: async (url, options) => {
    if (!url.endsWith('/mcp')) return Response.json({id:agentId,controller:principal});
    const call=JSON.parse(options.body),signed=await envelope(payload(call.params.arguments.payload));
    return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode(': keepalive\r\n\r\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/progress'})+'\r\n\r\n'));
      controller.enqueue(new TextEncoder().encode('event: message\r\ndata: '+JSON.stringify({jsonrpc:'2.0',id:call.id,result:{content:[{type:'text',text:JSON.stringify(signed)}]}})+'\r\n\r\n'));
    },cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}});
  }});
  assert.equal((await s.authenticateBearer('Bearer synthetic-test-token')).principal,principal);
  assert.equal(cancelled,true);
});

test('MCP errors, mismatched response ids and oversized authentication responses never establish identity', async () => {
  for (const result of [
    call=>({jsonrpc:'2.0',id:'another-request',result:{structuredContent:{}}}),
    call=>({jsonrpc:'2.0',id:call.id,error:{code:-32603,message:'withheld upstream detail'}}),
    call=>({jsonrpc:'2.0',id:call.id,result:{isError:true,content:[{type:'text',text:'withheld upstream detail'}]}}),
    call=>({jsonrpc:'2.0',id:call.id,result:{content:[{type:'text',text:JSON.stringify({error:'insufficient_scope'})}]}}),
  ]) {
    const s=security({fetch:async (url,options)=>{assert.ok(url.endsWith('/mcp'));return Response.json(result(JSON.parse(options.body)));}});
    await assert.rejects(s.authenticateBearer('Bearer synthetic-test-token'),{code:'authentication_response_invalid'});
  }
  const s=security({fetch:async()=>new Response('x'.repeat(65537),{headers:{'Content-Type':'text/event-stream'}})});
  await assert.rejects(s.authenticateBearer('Bearer synthetic-test-token'),{code:'upstream_response_too_large'});
});

test('filesystem storage encrypts logical keys and values, detects tampering and owner/path swapping', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'health-secure-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createEncryptedStore({ keyHex: '01'.repeat(32), directory });
  const first = 'owner-A:Mayya-medical-record', second = 'owner-B:other-record';
  const secret = { refreshToken: 'synthetic-secret-not-for-plaintext-storage', observations: ['private-test-data'] };
  await store.put(first, secret); await store.put(second, { value: 2 });
  assert.deepEqual(await store.get(first), secret);
  const files = await readdir(directory); assert.equal(files.length, 2);
  for (const file of files) {
    assert.match(file, /^[0-9a-f]{64}\.json$/);
    const bytes = await readFile(join(directory, file), 'utf8');
    assert.ok(!bytes.includes('Mayya')); assert.ok(!bytes.includes(secret.refreshToken)); assert.ok(!bytes.includes('private-test-data'));
  }
  await writeFile(join(directory, `${digest(second)}.json`), await readFile(join(directory, `${digest(first)}.json`)));
  await assert.rejects(store.get(second), { code: 'storage_integrity_failure' });
  const file = join(directory, `${digest(first)}.json`), saved = JSON.parse(await readFile(file, 'utf8'));
  saved.tag = randomBytes(16).toString('base64'); await writeFile(file, JSON.stringify(saved));
  await assert.rejects(store.get(first), { code: 'storage_integrity_failure' });
});

test('encrypted update serializes concurrent replay-ledger changes and remove erases the record', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'health-secure-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const a = createEncryptedStore({ keyHex: '02'.repeat(32), directory }), b = createEncryptedStore({ keyHex: '02'.repeat(32), directory });
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).update('private-counter', value => (value ?? 0) + 1)));
  assert.equal(await a.get('private-counter'), 10); await a.remove('private-counter'); assert.equal(await b.get('private-counter'), null);
});

function solidFetch() {
  const records = new Map(); let version = 0;
  return async (url, options = {}) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-storage-credential');
    const old = records.get(url);
    if (!options.method || options.method === 'GET') return old ? new Response(old.body, { headers: { ETag: old.etag } }) : new Response(null, { status: 404 });
    if ((options.headers['If-None-Match'] === '*' && old) || (options.headers['If-Match'] && options.headers['If-Match'] !== old?.etag)) return new Response(null, { status: 412 });
    if (options.method === 'DELETE') { records.delete(url); return new Response(null, { status: 204 }); }
    assert.ok(options.headers['If-Match'] || options.headers['If-None-Match'] === '*');
    const etag = `"${++version}"`; records.set(url, { etag, body: options.body }); return new Response(null, { status: 201, headers: { ETag: etag } });
  };
}

test('Solid storage uses conditional writes and rejects stale writer versions', async () => {
  const fetch = solidFetch(), config = { keyHex: '03'.repeat(32), rootUrl: 'https://store.example.test/private/', fetch, authorization: 'Bearer synthetic-storage-credential' };
  const a = createEncryptedStore(config), b = createEncryptedStore(config);
  await a.put('owner-1:record', { n: 1 }); assert.deepEqual(await a.get('owner-1:record'), { n: 1 });
  await b.put('owner-1:record', { n: 2 });
  await assert.rejects(a.put('owner-1:record', { n: 3 }), { code: 'storage_conflict' });
  assert.deepEqual(await b.get('owner-1:record'), { n: 2 });
  await b.update('owner-1:record', value => ({ n: value.n + 1 })); assert.deepEqual(await b.get('owner-1:record'), { n: 3 });
});

test('configuration refuses weak keys, credentials in URLs and ambiguous storage', () => {
  assert.throws(() => createEncryptedStore({ keyHex: 'short', directory: '/tmp/x' }), { code: 'storage_key_must_be_32_bytes' });
  assert.throws(() => createEncryptedStore({ keyHex: '01'.repeat(32), directory: '/tmp/x', rootUrl: 'https://store.example.test/' }), { code: 'configure_one_storage_backend' });
  assert.throws(() => createEncryptedStore({ keyHex: '01'.repeat(32), rootUrl: 'https://secret@store.example.test/' }), { code: 'storage_root_invalid' });
  assert.throws(() => createSecurity({ relayUrl: 'https://relay.example.test', identityHost, store: memoryStore(), trustedRelayAddresses: [] }), { code: 'trusted_relay_required' });
});
