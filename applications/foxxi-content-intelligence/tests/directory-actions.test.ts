import { describe, it, expect, vi } from 'vitest';
import { Parser } from 'n3';
import { Wallet } from 'ethers';
import { createHash } from 'node:crypto';
import { generateKeyPair, openEncryptedEnvelope } from '@interego/core';
import { recoverSignedRequest } from '../src/auth.js';
import { DirectoryActions, configuredLmsFromEnv, makeDirectoryActionAuthorizer, type DirectoryActionConfig, type DirectoryAction } from '../src/directory-actions.js';

// Every endpoint below is a fictional isolated transport; no production learner/course is written.
vi.mock('../src/ssrf-guard.js', () => ({
  assertSafeFetchTarget: async () => undefined,
  guardedFetchFn: (f: typeof fetch) => f,
}));
const alice = Wallet.createRandom(), bob = Wallet.createRandom();
const actor = 'did:ethr:' + alice.address;
const pod = 'https://fictional-pod.example/eth-' + alice.address.toLowerCase().slice(2, 14) + '/';
const audience = 'https://fictional-bridge.example';
const courseIri = pod + 'courses/fixture-course#package';
const course = {
  packageMeta: { course_id: 'fixture-course', course_label: 'Fictional', title: 'Fictional isolated test course', federation_iri_base: pod + 'courses/fixture-course' },
  concepts: [
    { id: 'one', label: 'Fixture starting concept', confidence: 1, taught_in_slides: ['s1'] },
    { id: 'two', label: 'Fixture following concept', confidence: 1, taught_in_slides: ['s2'] },
  ],
  slides: [
    { id: 's1', title: 'Fixture one', sequence_index: 0, transcript_combined: 'Fictional source transcript, not a real course.' },
    { id: 's2', title: 'Fixture two', sequence_index: 1, transcript_combined: 'Another fictional test slide.' },
  ],
  prereq_edges: [{ from: 'one', to: 'two', confidence: 1 }],
};
const connector = {
  id: 'fixture-lms', ownerPod: pod, product: 'Fictional LMS', instance: 'https://fictional-lms.example/', probeUrl: 'https://fictional-lms.example/api/me',
  authorization: 'Bearer fictional-test-secret-never-persist', authMethod: 'Bearer',
  identityPath: ['account', 'id'], expectedIdentity: 'fictional-account',
};
async function sign(w: typeof alice, action: DirectoryAction, payload: Record<string, unknown>) {
  const _signed_payload = JSON.stringify({ ...payload, agent_id: 'did:ethr:' + w.address,
    timestamp: new Date().toISOString(), bridge_audience: audience, action: 'foxxi.' + action });
  return { _signed_payload, _signature: await w.signMessage('sha256:' + createHash('sha256').update(_signed_payload).digest('hex')) };
}
function fixture() {
  const files = new Map<string, { body: string; type: string; etag: string }>();
  const requests: { url: string; method: string; headers: Headers; body: string }[] = [];
  const owner = generateKeyPair(), bridge = generateKeyPair();
  let revision = 0, remoteStatus = 200, wrongIdentity = false, corruptReadback = false, stripOwner = false, stripPeer = false, missingCourse = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET', headers = new Headers(init?.headers), body = typeof init?.body === 'string' ? init.body : '';
    requests.push({ url, method, headers, body });
    if (url === connector.probeUrl) {
      return new Response(JSON.stringify({ account: { id: wrongIdentity ? 'another-account' : connector.expectedIdentity } }), {
        status: remoteStatus, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!url.startsWith(pod)) throw new Error('Fixture forbids non-authorized transport destination');
    if (method === 'PUT') {
      files.set(url, { body, type: headers.get('Content-Type') ?? 'text/turtle', etag: '"' + (++revision) + '"' });
      return new Response('', { status: 201 });
    }
    const prev = files.get(url);
    if (method === 'GET' && prev) {
      let served = prev.body;
      if (url.endsWith('.envelope.jose.json')) {
        if (corruptReadback) served = '{}';
        else if (stripOwner || stripPeer) {
          const env = JSON.parse(served);
          env.wrappedKeys = env.wrappedKeys.filter((k: { recipientPublicKey: string }) => stripOwner
            ? k.recipientPublicKey !== owner.publicKey : [owner.publicKey, bridge.publicKey].includes(k.recipientPublicKey));
          served = JSON.stringify(env);
        }
      }
      return new Response(served, { headers: { 'Content-Type': prev.type, ETag: prev.etag } });
    }
    if (url === pod || url.endsWith('/')) return new Response('', { headers: { 'Content-Type': 'text/turtle' } });
    return new Response('', { status: 404 });
  };
  const config: DirectoryActionConfig = {
    fetch: fetcher, encryptionKeypair: () => bridge, configuredLms: () => [connector],
    authorize: makeDirectoryActionAuthorizer({
      audience,
      verifyCaller: async envelope => {
        const r = recoverSignedRequest(envelope);
        if (!r.ok) return { ok: false, status: 401, error: 'Signature did not verify' };
        // ECDSA recovery can return a DIFFERENT address for changed message bytes; it is
        // authentication only when that recovered key also binds the claimed direct actor.
        if (r.agentId !== 'did:ethr:' + r.signer) return { ok: false, status: 401, error: 'Recovered signing key does not authenticate the claimed fixture actor' };
        if (r.signer !== alice.address || r.agentId !== actor) return { ok: false, status: 403, error: 'Fixture principal does not own the target pod' };
        return { ok: true, callerDid: actor, payload: r.payload };
      },
      ownPod: who => { if (who !== actor) throw new Error('Unknown fixture principal'); return pod; },
      samePod: (a, b) => a === b,
    }),
    course: async (_auth, iri) => missingCourse || iri !== courseIri ? null : course,
  };
  const actions = new DirectoryActions(config);
  const call = async (action: DirectoryAction, payload: Record<string, unknown> = {}, signer = alice) => {
    const signed = await sign(signer, action, { owner_encryption_key: owner.publicKey, ...payload });
    return actions.run(action, signed);
  };
  return { files, requests, config, actions, owner, bridge, call,
    badStatus: () => { remoteStatus = 401; }, wrongIdentity: () => { wrongIdentity = true; },
    corrupt: () => { corruptReadback = true; }, stripOwner: () => { stripOwner = true; }, stripPeer: () => { stripPeer = true; }, missing: () => { missingCourse = true; } };
}
function opened(f: ReturnType<typeof fixture>, result: Record<string, unknown>, key = f.owner) {
  return openEncryptedEnvelope(JSON.parse(f.files.get(String(result.graphUrl))!.body), key)!;
}
describe('implemented directory actions have authenticated real effects', () => {
  it('constructs for the ordinary local bridge origin but refuses protected use before authentication or effects', async () => {
    const f = fixture(), verifyCaller = vi.fn(async () => ({ ok: true as const, callerDid: actor, payload: {} }));
    const authorize = makeDirectoryActionAuthorizer({
      audience: 'http://localhost:6080', verifyCaller, ownPod: () => pod, samePod: (a, b) => a === b,
    });
    const actions = new DirectoryActions({ ...f.config, authorize });
    const signed = await sign(alice, 'connect_lms', { owner_encryption_key: f.owner.publicKey,
      connector_id: connector.id, product: connector.product, instance: connector.instance, auth_method: connector.authMethod });
    expect(await actions.run('connect_lms', signed)).toMatchObject({
      kind: 'refusal', 'iep:refusalStatus': 503, published: false,
      error: 'Directory actions require an exact HTTPS deployment origin; configure the bridge audience before use',
    });
    expect(verifyCaller).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
    expect(f.files.size).toBe(0);
  });

  it('binds the recovered action and own pod, and ignores unsigned outer steering', async () => {
    const f = fixture();
    const signed = await sign(alice, 'consume_lesson', { course_iri: courseIri });
    expect(await f.actions.run('consume_lesson', { ...signed, _session: { key: 'fictional-ephemeral' } })).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 401 });
    expect(await f.actions.run('publish_concept_map', signed)).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 403 });
    const foreign = await f.call('publish_concept_map', { course_iri: courseIri, tenant_pod_url: 'https://another-fictional.example/' });
    expect(foreign).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 403 });
    const wrongAudiencePayload = JSON.parse(signed._signed_payload);
    wrongAudiencePayload.bridge_audience = 'https://another-fictional-bridge.example';
    const wrongAudienceText = JSON.stringify(wrongAudiencePayload);
    expect(await f.actions.run('consume_lesson', { _signed_payload: wrongAudienceText,
      _signature: await alice.signMessage('sha256:' + createHash('sha256').update(wrongAudienceText).digest('hex')) })).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 403 });
    expect(await f.actions.run('consume_lesson', { ...signed, tenant_pod_url: 'http://127.0.0.1/', mode: 'record-progress' })).toMatchObject({ loaded: true, writesPerformed: false });
    expect(f.requests).toEqual([]);
  });
  it('requires publish scope based on recovered mode, never unsigned outer mode', async () => {
    const checked: boolean[] = [];
    const authorize = makeDirectoryActionAuthorizer({
      audience,
      verifyCaller: async (_body, write) => {
        checked.push(write);
        return write ? { ok: false, status: 403, error: 'Fictional delegation has discover scope only' }
          : { ok: true, callerDid: actor, payload: { bridge_audience: audience, action: 'foxxi.consume_lesson', mode: 'record-progress' } };
      },
      ownPod: () => pod, samePod: (a, b) => a === b,
    });
    await expect(authorize('consume_lesson', { mode: 'load' })).rejects.toMatchObject({ status: 403 });
    expect(checked).toEqual([false, true]);
    checked.length = 0;
    const read = makeDirectoryActionAuthorizer({
      audience,
      verifyCaller: async (_body, write) => { checked.push(write); return { ok: true, callerDid: actor, payload: { bridge_audience: audience, action: 'foxxi.consume_lesson', mode: 'load' } }; },
      ownPod: () => pod, samePod: (a, b) => a === b,
    });
    expect(await read('consume_lesson', { mode: 'record-progress' })).toMatchObject({ actor, pod });
    expect(checked).toEqual([false]);
  });

  it.each(['consume_lesson', 'connect_lms', 'publish_concept_map', 'publish_compliance_evidence'] as const)('%s refuses unsigned/foreign/tampered requests before course or pod effects', async action => {
    const f = fixture();
    expect(await f.actions.run(action, {})).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 401, published: false });
    expect(await f.call(action, { course_iri: courseIri }, bob)).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 403 });
    const envelope = await sign(alice, action, { course_iri: courseIri });
    expect(await f.actions.run(action, { ...envelope, _signed_payload: envelope._signed_payload + ' ' })).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 401 });
    expect(f.requests).toEqual([]);
  });
  it('loads the real published lesson without manufacturing consumption, progress, completion or xAPI', async () => {
    const f = fixture(), result = await f.call('consume_lesson', { course_iri: courseIri });
    expect(result).toMatchObject({ loaded: true, consumed: false, completed: false, writesPerformed: false, lesson: { title: course.packageMeta.title, slides: course.slides } });
    expect(f.requests).toEqual([]);
    f.missing();
    expect(await f.call('consume_lesson', { course_iri: courseIri })).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 404 });
  });
  it('persists only a signed self-report of actual source slide ids, as Hypothetical; the owner can decrypt it', async () => {
    const f = fixture(), result = await f.call('consume_lesson', { course_iri: courseIri, mode: 'record-progress', advanced_slide_ids: ['s1'] });
    expect(result).toMatchObject({ published: true, encrypted: true, readbackVerified: true, completed: false, consumed: false, modalStatus: 'Hypothetical', xapiStatementIds: [] });
    const body = opened(f, result);
    expect(body).toContain('caller-self-report');
    expect(new Parser().parse(body).some(q => q.predicate.value.endsWith('#modalStatus') && q.object.value.endsWith('#Hypothetical'))).toBe(true);
    expect(body).toContain('advanced_slide_ids');
    expect(opened(f, result, f.bridge)).toBe(body);
    expect([...f.files.values()].filter(v => v.type.includes('jose')).every(v => !v.body.includes('caller-self-report'))).toBe(true);
    expect(body).not.toContain('http://adlnet.gov/expapi/verbs/completed');
  });
  it.each([
    { advanced_slide_ids: ['invented-slide'] },
    { advanced_slide_ids: ['s1', 's1'] },
    { advanced_slide_ids: [] },
    { learner_did: 'did:ethr:' + bob.address, advanced_slide_ids: ['s1'] },
    { lrs_endpoint: 'http://127.0.0.1/', advanced_slide_ids: ['s1'] },
  ])('refuses invalid or cross-learner progress before any write', async p => {
    const f = fixture();
    expect(await f.call('consume_lesson', { course_iri: courseIri, mode: 'record-progress', ...p })).toMatchObject({ kind: 'refusal' });
    expect(f.requests).toEqual([]);
  });
  it('publishes the actual source concepts and prerequisite graph, encrypted, with explicit signed recipient bindings', async () => {
    const f = fixture(), peer = generateKeyPair(), peerDid = 'did:web:fictional-peer.example';
    const result = await f.call('publish_concept_map', { course_iri: courseIri, federation_share_with: [peerDid], recipient_encryption_keys: { [peerDid]: peer.publicKey } });
    expect(result).toMatchObject({ published: true, readbackVerified: true, conceptCount: 2, prerequisiteCount: 1, sharedWith: [peerDid] });
    const body = opened(f, result, peer);
    expect(body).toContain('http://www.w3.org/2004/02/skos/core#Concept');
    expect(body).toContain('Fixture starting concept');
    expect(body).toContain('http://purl.org/dc/terms/requires');
    expect(body).toContain(courseIri);
    expect(openEncryptedEnvelope(JSON.parse(f.files.get(String(result.graphUrl))!.body), generateKeyPair())).toBeNull();
  });
  it.each(['consume_lesson', 'connect_lms', 'publish_concept_map', 'publish_compliance_evidence'] as const)('%s refuses the bridge public key in place of an owner-held key before any write or probe', async action => {
    const f = fixture();
    const payload = action === 'consume_lesson' ? { course_iri: courseIri, mode: 'record-progress', advanced_slide_ids: ['s1'] }
      : action === 'publish_concept_map' ? { course_iri: courseIri }
      : action === 'publish_compliance_evidence' ? { event_type: 'audit-action', event_payload: { action: 'Fictional isolated test only' } }
      : { connector_id: connector.id, product: connector.product, instance: connector.instance, auth_method: connector.authMethod };
    expect(await f.call(action, { ...payload, owner_encryption_key: f.bridge.publicKey })).toMatchObject({
      kind: 'refusal', 'iep:refusalStatus': 400, published: false, error: 'owner_encryption_key must be a distinct owner-held key; bridge-only storage is refused',
    });
    expect(f.requests).toEqual([]);
    expect(f.files.size).toBe(0);
  });
  it('refuses unsigned outer key injection, missing owner keys and unresolved recipients without a plaintext fallback', async () => {
    const f = fixture();
    const signed = await sign(alice, 'publish_concept_map', { course_iri: courseIri });
    expect(await f.actions.run('publish_concept_map', { ...signed, owner_encryption_key: f.owner.publicKey })).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 503 });
    expect(await f.call('publish_concept_map', { course_iri: courseIri, federation_share_with: ['did:web:fictional-peer.example'] })).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 400 });
    expect(f.requests).toEqual([]);
  });
  it('retains caller-reported compliance evidence with real published control citations without certifying the claim', async () => {
    const f = fixture(), result = await f.call('publish_compliance_evidence', { event_type: 'audit-action', event_payload: { action: 'Fictional isolated verification only' }, framework: 'soc2' });
    expect(result).toMatchObject({ published: true, readbackVerified: true, modalStatus: 'Hypothetical', independentlyVerified: false, complianceSatisfied: false, credentialIssued: false });
    expect((result.cited as string[]).length).toBeGreaterThan(0);
    const body = opened(f, result);
    expect(body).toContain('caller-reported');
    expect(new Parser().parse(body).some(q => q.predicate.value.endsWith('#modalStatus') && q.object.value.endsWith('#Hypothetical'))).toBe(true);
    expect(body).toContain('Fictional isolated verification only');
  });
  it.each([
    { event_type: 'unrecognized', event_payload: { action: 'fictional' } },
    { event_type: 'completion', event_payload: {} },
    { event_type: 'audit-action', event_payload: { action: 'fictional' }, framework: 'invented' },
    { event_type: 'audit-action', event_payload: { action: 'fictional' }, controls: ['urn:fake-control'] },
  ])('refuses invalid compliance assertions before publication', async p => {
    const f = fixture();
    expect(await f.call('publish_compliance_evidence', p)).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 400 });
    expect(f.requests).toEqual([]);
  });
  it('performs the exact configured authenticated LMS identity probe and persists a non-secret connection artifact', async () => {
    const f = fixture(), result = await f.call('connect_lms', { connector_id: connector.id, product: connector.product, instance: connector.instance, auth_method: connector.authMethod, sync_frequency: 'manual' });
    expect(result).toMatchObject({ published: true, readbackVerified: true, authenticatedProbe: true, syncScheduled: false, credentialsPersisted: false, remotePayloadPersisted: false });
    expect(f.requests[0]).toMatchObject({ url: connector.probeUrl, method: 'GET' });
    expect(f.requests[0]!.headers.get('Authorization')).toBe(connector.authorization);
    expect(opened(f, result)).not.toContain(connector.authorization);
    expect(JSON.stringify([...f.files.values()])).not.toContain(connector.authorization);
    expect(JSON.stringify(result)).not.toContain(connector.authorization);
  });
  it('does not let another genuinely verified own-pod principal use the configured LMS credentials', async () => {
    const f = fixture(), bobActor = 'did:ethr:' + bob.address;
    const bobPod = 'https://fictional-pod.example/eth-' + bob.address.toLowerCase().slice(2, 14) + '/';
    const actions = new DirectoryActions({
      ...f.config,
      authorize: makeDirectoryActionAuthorizer({
        audience,
        verifyCaller: async envelope => {
          const r = recoverSignedRequest(envelope);
          if (!r.ok) return { ok: false, status: 401, error: 'Signature did not verify' };
          if (r.signer !== bob.address || r.agentId !== bobActor) return { ok: false, status: 403, error: 'Wrong fixture owner' };
          return { ok: true, callerDid: bobActor, payload: r.payload };
        },
        ownPod: () => bobPod, samePod: (a, b) => a === b,
      }),
    });
    const signed = await sign(bob, 'connect_lms', { owner_encryption_key: generateKeyPair().publicKey,
      connector_id: connector.id, product: connector.product, instance: connector.instance, auth_method: connector.authMethod });
    expect(await actions.run('connect_lms', signed)).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 403, published: false });
    expect(f.requests).toEqual([]);
  });
  it('refuses a connector configuration missing the verified owner binding as operator setup, before probe or writes', async () => {
    const f = fixture();
    const actions = new DirectoryActions({ ...f.config, configuredLms: () => [{ ...connector, ownerPod: '' }] });
    const signed = await sign(alice, 'connect_lms', { owner_encryption_key: f.owner.publicKey,
      connector_id: connector.id, product: connector.product, instance: connector.instance, auth_method: connector.authMethod });
    expect(await actions.run('connect_lms', signed)).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 503, published: false });
    expect(f.requests).toEqual([]);
  });
  it.each(['badStatus', 'wrongIdentity'] as const)('LMS %s cannot produce a success or a pod write', async failure => {
    const f = fixture(); f[failure]();
    expect(await f.call('connect_lms', { connector_id: connector.id, product: connector.product, instance: connector.instance, auth_method: connector.authMethod })).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 502, published: false });
    expect(f.requests.some(r => r.method === 'PUT')).toBe(false);
  });
  it.each([
    { connector_id: 'unconfigured' },
    { connector_id: connector.id, instance: 'https://evil.example/' },
    { connector_id: connector.id, product: connector.product, instance: connector.instance, auth_method: connector.authMethod, probe_url: 'http://127.0.0.1/' },
    { connector_id: connector.id, product: connector.product, instance: connector.instance, auth_method: connector.authMethod, human_seed: 'fictional-sensitive-input-must-not-be-saved' },
    { connector_id: connector.id, product: connector.product, instance: connector.instance, auth_method: connector.authMethod, recipient_encryption_keys: { api_key: 'fictional-sensitive-input-must-not-be-saved' } },
    { connector_id: connector.id, product: connector.product, instance: connector.instance, auth_method: connector.authMethod, lrs_auth_header: 'Bearer fictional-sensitive-input-must-not-be-forwarded' },
    { connector_id: connector.id, product: connector.product, instance: connector.instance, auth_method: connector.authMethod, sync_frequency: 'every 6 hours' },
  ])('cannot turn connector setup into arbitrary egress, credential forwarding, or a fictional scheduler', async p => {
    const f = fixture();
    expect(await f.call('connect_lms', p)).toMatchObject({ kind: 'refusal', published: false });
    expect(f.requests).toEqual([]);
  });
  it('rejects unsafe operator connector configuration and duplicate ids', () => {
    for (const p of [
      { ...connector, ownerPod: '' },
      { ...connector, ownerPod: 'http://fictional-pod.example/owner/' },
      { ...connector, ownerPod: 'https://fictional-pod.example/owner/?target=another' },
      { ...connector, probeUrl: 'https://evil.example/api/me' },
      { ...connector, probeUrl: 'http://fictional-lms.example/api/me' },
      { ...connector, instance: 'https://name:password@fictional-lms.example/' },
      { ...connector, identityPath: [] },
    ]) expect(() => configuredLmsFromEnv(JSON.stringify([p]))).toThrow();
    expect(() => configuredLmsFromEnv(JSON.stringify([connector, connector]))).toThrow();
    expect(configuredLmsFromEnv(undefined)).toEqual([]);
  });
  it.each(['stripOwner', 'stripPeer'] as const)('refuses %s tampering even when the bridge can still decrypt the content', async mode => {
    const f = fixture(), peer = generateKeyPair(), peerDid = 'did:web:fictional-peer.example'; f[mode]();
    expect(await f.call('publish_concept_map', { course_iri: courseIri, federation_share_with: [peerDid], recipient_encryption_keys: { [peerDid]: peer.publicKey } }))
      .toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 502, effects: 'write-attempted', published: false });
  });
  it('does not report publication success when actual encrypted readback is corrupt', async () => {
    const f = fixture(); f.corrupt();
    expect(await f.call('publish_concept_map', { course_iri: courseIri })).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 502, published: false, effects: 'write-attempted' });
  });
});
