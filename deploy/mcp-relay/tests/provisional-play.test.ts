#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { chargeProvisionalExchange, claimProvisionalExchange, createProvisionalToolGuard, playHash, provisionalGraphs,
  PROVISIONAL_EXCHANGE_LIMIT,
  ProvisionalPlayError, validateProvisionalTool, verifyProvisionalExchange } from '../provisional-play.js';

const deadline = Math.floor(Date.now() / 1000) + 7200;
const play = { audience: 'hallowmarch', proofKeyThumbprint: 'a'.repeat(43), expiresAt: deadline };
const principal = { userId: 'u-guest-1', agentId: 'did:web:id.example:agents:browser-u-guest-1',
  ownerWebId: 'https://id.example/users/u-guest-1/profile#me', ownerDid: 'did:web:id.example:users:u-guest-1',
  podUrl: 'https://gate.example/u-guest-1/', provisionalPlay: play };
const request = { identityToken: 'native-secret', attestation: 'ipa1_public', audience: play.audience, proof: 'proof' };
const me = { userId: principal.userId, webId: principal.ownerWebId, did: principal.ownerDid, podUrl: principal.podUrl,
  authenticatedAgentId: 'browser-u-guest-1', authenticatedAgentDid: principal.agentId,
  tokenExpiresAt: new Date(deadline * 1000).toISOString(), provisionalPlay: play };
const verified = { valid: true, provisional: true, issuer: 'https://id.example', audience: play.audience,
  userId: principal.userId, ownerDid: principal.ownerDid, webId: principal.ownerWebId, podUrl: principal.podUrl,
  authenticatedAgentId: me.authenticatedAgentId, authenticatedAgentDid: principal.agentId,
  proofKeyThumbprint: play.proofKeyThumbprint, expiresAt: me.tokenExpiresAt,
  capabilities: ['human-play', 'own-pod-checkpoint'] };
const reply = (status: number, body: any, etag?: string) => ({ status, ok: status >= 200 && status < 300,
  headers: { get: (name: string) => name.toLowerCase() === 'etag' ? etag ?? null : null },
  text: async () => JSON.stringify(body), json: async () => JSON.parse(JSON.stringify(body)) });
const code = (expected: string) => (e: unknown) => e instanceof ProvisionalPlayError && e.code === expected;
function provider(m: any = me, v: any = verified) {
  const calls: any[] = [];
  return { calls, fetch: async (url: string, init: any) => {
    calls.push({ url, init });
    return reply(200, url.endsWith('/me') ? m : v);
  }};
}
function pod() {
  const files = new Map<string, { body: any; version: number }>();
  let failing = false;
  return { files, fail: () => { failing = true; }, fetch: async (url: string, init: any = {}) => {
    const file = files.get(url), etag = file ? '"' + file.version + '"' : undefined;
    if (init.method === 'PUT') {
      if (failing) return reply(503, {});
      if ((init.headers['If-None-Match'] === '*' && file)
        || (init.headers['If-Match'] && init.headers['If-Match'] !== etag)) return reply(412, {});
      const next = { body: JSON.parse(init.body), version: (file?.version ?? 0) + 1 };
      files.set(url, next); return reply(201, {}, '"' + next.version + '"');
    }
    return file ? reply(200, file.body, etag) : reply(404, {});
  }};
}
const mutex = (() => {
  const locks = new Map<string, Promise<unknown>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prior = locks.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    locks.set(key, next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  };
})();
const recipientKey = Buffer.alloc(32, 7).toString('base64');
const recipient = { pod_name: principal.userId, agent_id: principal.podUrl + 'agents#browser-encryption-' + playHash(recipientKey),
  encryption_public_key: recipientKey, scope: 'ReadOnly', label: 'Browser-held encryption recipient' };
function binding(graph = provisionalGraphs(principal)[0]) {
  return { pod_name: principal.userId, graph_iri: graph, descriptor_id: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    graph_content: JSON.stringify({ version: 1, algorithm: 'X25519-XSalsa20-Poly1305',
      content: { algorithm: 'XSalsa20-Poly1305', ciphertext: 'encrypted' },
      wrappedKeys: [{ senderPublicKey: recipientKey, recipientPublicKey: recipientKey }] }),
    sealed_payload: true, content_digest: 'graph-nquads-sha256:' + 'b'.repeat(64),
    visibility: 'private', sign_authorship: true, sync: true, cleartext_mirror: '', auto_supersede_prior: false };
}

test('exchange binds provider-verified proof to the exact native token and configured endpoint', async () => {
  const p = provider();
  const identity = await verifyProvisionalExchange(request, { identityUrl: 'http://identity.internal:8090', fetch: p.fetch });
  assert.equal(identity.ownerDid, principal.ownerDid);
  assert.equal(identity.agentId, principal.agentId);
  assert.equal(identity.expiresAt, deadline);
  assert.deepEqual(p.calls.map(c => c.url), ['http://identity.internal:8090/me', 'http://identity.internal:8090/play/provisional/verify']);
  assert.equal(p.calls[0].init.headers.Authorization, 'Bearer ' + request.identityToken);
  assert.equal(p.calls[0].init.redirect, 'error');
  const proof = JSON.parse(p.calls[1].init.body);
  assert.equal(proof.challenge, createHash('sha256').update(request.identityToken).digest('base64url'));
  assert.ok(!p.calls[1].init.body.includes(request.identityToken));
  await assert.rejects(verifyProvisionalExchange({ ...request, issuer: 'http://attacker/' }, { identityUrl: 'https://id.example', fetch: p.fetch }), code('invalid_provisional_exchange'));
});
test('exchange refuses changed user, agent, pod, audience, key, absent marker and capability escalation', async () => {
  for (const changed of [{ userId: 'victim' }, { authenticatedAgentDid: 'did:web:id.example:agents:other' },
    { podUrl: 'https://gate.example/victim/' }, { audience: 'other-game' }, { proofKeyThumbprint: 'b'.repeat(43) }]) {
    const p = provider(me, { ...verified, ...changed });
    await assert.rejects(verifyProvisionalExchange(request, { identityUrl: 'https://id.example', fetch: p.fetch }), code('provisional_identity_mismatch'));
  }
  const p = provider({ ...me, provisionalPlay: undefined });
  await assert.rejects(verifyProvisionalExchange(request, { identityUrl: 'https://id.example', fetch: p.fetch }), code('provisional_identity_mismatch'));
  const broad = provider(me, { ...verified, capabilities: [...verified.capabilities, 'autonomous-agent'] });
  await assert.rejects(verifyProvisionalExchange(request, { identityUrl: 'https://id.example', fetch: broad.fetch }), code('invalid_provisional_capabilities'));
});
test('exchange fails closed on expired authority and native token beyond guest deadline', async () => {
  const p = provider();
  await assert.rejects(verifyProvisionalExchange(request, { identityUrl: 'https://id.example', fetch: p.fetch, now: () => deadline * 1000 }), code('provisional_authority_expired'));
  const future = provider({ ...me, tokenExpiresAt: new Date((deadline + 1) * 1000).toISOString() });
  await assert.rejects(verifyProvisionalExchange(request, { identityUrl: 'https://id.example', fetch: future.fetch }), code('invalid_provisional_expiry'));
});
test('exchange receipt survives process restart and prevents concurrent replay', async () => {
  const p = pod(), cfg = { podUrl: 'https://gate.example/svc-relay/', fetch: p.fetch };
  const outcomes = await Promise.allSettled([claimProvisionalExchange('secret', deadline, cfg), claimProvisionalExchange('secret', deadline, cfg)]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  await assert.rejects(claimProvisionalExchange('secret', deadline, { ...cfg }), code('provisional_exchange_replayed'));
  assert.ok(!JSON.stringify([...p.files]).includes('secret'));
});
test('receipt and mutation persistence failures grant no action', async () => {
  const p = pod(); p.fail();
  await assert.rejects(claimProvisionalExchange('secret', deadline, { podUrl: 'https://gate.example/svc/', fetch: p.fetch }), code('provisional_receipt_unavailable'));
  let invoked = 0;
  const guard = createProvisionalToolGuard({ podUrl: 'https://gate.example/svc/', fetch: p.fetch, withMutex: mutex, assertUnpublished: async () => {} });
  await assert.rejects(guard('register_agent', recipient, principal, async () => { invoked++; return '{}'; }), code('provisional_limits_unavailable'));
  assert.equal(invoked, 0);
});
test('provisional policy confines all six tools to own pod, own two graphs, encryption recipient and sealed bindings', () => {
  assert.equal(validateProvisionalTool('get_descriptor', { url: principal.podUrl + 'agents' }, principal), undefined);
  assert.equal(validateProvisionalTool('get_encrypted_graph', { url: principal.podUrl + 'context-graphs/a.ttl' }, principal), undefined);
  for (const name of ['sign_request','notify_agent','mint','act','revoke_agent','discover_all','publish_directory']) {
    assert.throws(() => validateProvisionalTool(name, {}, principal), code('provisional_tool_forbidden'));
  }
  assert.throws(() => validateProvisionalTool('get_pod_status', { pod_name: 'victim' }, principal), code('provisional_own_pod_only'));
  assert.throws(() => validateProvisionalTool('get_descriptor', { url: 'https://gate.example/victim/agents' }, principal), code('provisional_resource_forbidden'));
  assert.throws(() => validateProvisionalTool('get_current_head', { urn: 'urn:graph:other' }, principal), code('provisional_graph_forbidden'));
  assert.throws(() => validateProvisionalTool('register_agent', { ...recipient, scope: 'ReadWrite' }, principal), code('provisional_recipient_only'));
  assert.throws(() => validateProvisionalTool('register_agent', { ...recipient, tenant_admin: true }, principal), code('provisional_recipient_only'));
  assert.throws(() => validateProvisionalTool('publish_context', { ...binding(), sealed_payload: false }, principal), code('provisional_checkpoint_only'));
  assert.throws(() => validateProvisionalTool('publish_context', { ...binding(), graph_content: 'x'.repeat(2 * 1024 * 1024) }, principal), code('provisional_payload_too_large'));
});
test('durable policy permits one recipient and exactly two immutable graph bindings; identical retries are cached', async () => {
  const p = pod();
  const create = () => createProvisionalToolGuard({ podUrl: 'https://gate.example/svc/', fetch: p.fetch, withMutex: mutex, assertUnpublished: async () => {} });
  let invoked = 0;
  const invoke = async () => { invoked++; return JSON.stringify({ registered: true, published: true, descriptorUrl: principal.podUrl + 'context-graphs/x.ttl' }); };
  await create()('register_agent', recipient, principal, invoke);
  await create()('publish_context', binding(), principal, invoke);
  await create()('publish_context', binding(provisionalGraphs(principal)[1]), principal, invoke);
  await create()('publish_context', binding(), principal, invoke);
  assert.equal(invoked, 3);
  await assert.rejects(create()('publish_context', { ...binding(), descriptor_id: 'urn:uuid:00000000-0000-4000-8000-000000000002' }, principal, invoke), code('provisional_initial_binding_exists'));
  const key = Buffer.alloc(32, 8).toString('base64');
  await assert.rejects(create()('register_agent', { ...recipient, encryption_public_key: key,
    agent_id: principal.podUrl + 'agents#browser-encryption-' + playHash(key) }, principal, invoke), code('provisional_initial_binding_exists'));
  assert.equal(invoked, 3);
  assert.equal(Object.keys([...p.files.values()][0].body.entries).length, 3);
});
test('only the enrolled browser key can receive initial ciphertext', async () => {
  const p = pod(), guard = createProvisionalToolGuard({ podUrl: 'https://gate.example/svc/', fetch: p.fetch, withMutex: mutex, assertUnpublished: async () => {} });
  await guard('register_agent', recipient, principal, async () => '{"registered":true}');
  const args = binding(), envelope = JSON.parse(args.graph_content);
  envelope.wrappedKeys.push(envelope.wrappedKeys[0]); args.graph_content = JSON.stringify(envelope);
  await assert.rejects(guard('publish_context', args, principal, async () => '{"published":true}'), code('provisional_owner_recipient_only'));
});
test('an incomplete durable mutation has a finite retry allowance', async () => {
  const p = pod(), guard = createProvisionalToolGuard({ podUrl: 'https://gate.example/svc/', fetch: p.fetch, withMutex: mutex, assertUnpublished: async () => {} });
  let invoked = 0;
  const failed = async () => { invoked++; throw new Error('storage failed'); };
  for (let i = 0; i < 3; i++) await assert.rejects(guard('register_agent', recipient, principal, failed), /storage failed/);
  await assert.rejects(guard('register_agent', recipient, principal, failed), code('provisional_binding_retry_limit'));
  assert.equal(invoked, 3);
});

test('fresh native tokens and process restarts share one fixed guest lifetime exchange budget', async () => {
  const p = pod(), cfg = { podUrl: 'https://gate.example/svc/', fetch: p.fetch, withMutex: mutex };
  for (let i = 0; i < PROVISIONAL_EXCHANGE_LIMIT; i++) {
    await chargeProvisionalExchange({ ...principal, provisionalPlay: { ...play } }, { ...cfg });
    await claimProvisionalExchange('fresh-native-token-' + i, deadline, cfg);
  }
  await assert.rejects(chargeProvisionalExchange({ ...principal }, { ...cfg }), code('provisional_exchange_limit'));
  const counter = [...p.files.values()].find(file => file.body.binding);
  assert.equal(counter?.body.attempts, PROVISIONAL_EXCHANGE_LIMIT);
  assert.ok(Buffer.byteLength(JSON.stringify(counter?.body), 'utf8') <= 512);
  assert.equal(p.files.size, PROVISIONAL_EXCHANGE_LIMIT + 1);
  for (const changed of [{ ...play, expiresAt: deadline + 1 }, { ...play, audience: 'another-game' },
    { ...play, proofKeyThumbprint: 'b'.repeat(43) }]) {
    await assert.rejects(chargeProvisionalExchange({ ...principal, provisionalPlay: changed }, cfg), code('provisional_exchange_budget_mismatch'));
  }
});
test('concurrent exchange charges cannot exceed the durable counter and failed writes grant no allocation', async () => {
  const p = pod(), cfg = { podUrl: 'https://gate.example/svc/', fetch: p.fetch, withMutex: mutex };
  const outcomes = await Promise.allSettled(Array.from({ length: PROVISIONAL_EXCHANGE_LIMIT + 2 },
    () => chargeProvisionalExchange(principal, cfg)));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, PROVISIONAL_EXCHANGE_LIMIT);
  assert.equal([...p.files.values()][0].body.attempts, PROVISIONAL_EXCHANGE_LIMIT);
  const failed = pod(); failed.fail();
  await assert.rejects(chargeProvisionalExchange(principal, { ...cfg, fetch: failed.fetch }), code('provisional_exchange_budget_unavailable'));
  assert.equal(failed.files.size, 0);
});
test('provisional exchanges reject oversized native credentials before fetching the provider', async () => {
  const p = provider();
  await assert.rejects(verifyProvisionalExchange({ ...request, identityToken: 'x'.repeat(4097) },
    { identityUrl: 'https://id.example', fetch: p.fetch }), code('invalid_provisional_exchange'));
  assert.equal(p.calls.length, 0);
});


