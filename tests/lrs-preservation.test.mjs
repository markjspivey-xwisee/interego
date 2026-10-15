import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TARGET, LIMITS, checkedPod, checkedPodResource, publicStoreSpelling, archiveTarget,
  nativeReadiness, readArchiveConfig, collectArchive, verifyMultipartAttachments,
  sha256, sealArchive, openArchive, verifyRestoredArchive, main } from '../tools/lrs-preservation.mjs';

const POD = `${TARGET.gate}/foxxi/`;
const MESH = `${TARGET.gate}/agent-one/`;
const RUNTIME = `${TARGET.gate}/agent-two/`;
const INTERNAL = 'http://css.railway.internal:3456';
const NOW = new Date('2026-10-15T20:00:00.000Z');
const STORED = '2026-10-15T19:00:00.000Z';
const SECRET = 'PRIVATE-POD-SECRET-DO-NOT-OUTPUT';
const SEED = 'PRIVATE-ARCHIVE-SEED-DO-NOT-OUTPUT';
const CONFIG = {
  BRIDGE_DEPLOYMENT_URL: TARGET.origin, FOXXI_TENANT_POD_URL: POD,
  FOXXI_MESH_PODS: MESH, FOXXI_ADMIN_KEY_SEED: SEED, FOXXI_POD_WRITE_SECRET: SECRET,
  FOXXI_LRS_BASIC_AUTH_PAIRS: 'existing-user:existing-password:default',
  FOXXI_AUTHORITATIVE_SOURCE: 'did:web:tenant.example', FOXXI_BRIDGE_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
};
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const basic = `Basic ${Buffer.from('existing-user:existing-password').toString('base64')}`;
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const turtle = body => new Response(body, { headers: { 'content-type': 'text/turtle' } });
const entry = (url, type, graph = 'urn:graph:source-1792080000000') => `<${url}> a iep:ManifestEntry ;\n  iep:describes <${graph}> ;\n  dct:conformsTo <https://example.test/foxxi#${type}> ;\n  iep:hasFacetType iep:Trust ;\n  iep:modalStatus iep:Asserted ;\n  iep:trustLevel iep:CryptographicallyVerified .\n`;
const descriptor = target => `@prefix hydra: <http://www.w3.org/ns/hydra/core#> .\n<urn:distribution> hydra:target <${target}> .\n`;

function fixture() {
  const calls = [], bodies = [], attachment = Buffer.from([0, 255, 13, 10, 2, 9]);
  const hash = sha256(attachment);
  const attachments = [{ sha2: hash, length: attachment.length, contentType: 'application/octet-stream' }];
  const statement = { id: id(1), stored: STORED, actor: { account: { name: 'PRIVATE-LEARNER-NAME' } },
    verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: 'urn:private-course' }, attachments };
  const voiding = { id: id(2), stored: STORED, actor: statement.actor,
    verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: id(3) } };
  const target = { ...statement, id: id(3), attachments: [] };
  const cursor = Buffer.from(JSON.stringify({ offset: 2, ts: NOW.getTime() - 1,
    q: { until: NOW.toISOString(), ascending: true, limit: 500 } })).toString('base64url');
  const multipart = Buffer.concat([Buffer.from('--fixture\r\nContent-Type: application/json\r\n\r\n'), Buffer.from(JSON.stringify(statement)),
    Buffer.from(`\r\n--fixture\r\nContent-Type: application/octet-stream\r\nX-Experience-API-Hash: ${hash}\r\n\r\n`),
    attachment, Buffer.from('\r\n--fixture--\r\n')]);
  const route = async (url, options = {}) => {
    calls.push({ url, ...options });
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    const u = new URL(url);
    if (u.origin === TARGET.origin) {
      if (u.pathname === '/xapi/about') return json({ extensions: { [`${TARGET.origin}/ns/foxxi#lrsBackend`]: 'memory (ephemeral; 779/5000 statements resident process-wide)' } });
      if (u.pathname === '/agent/mesh/enrolment') return turtle(`<urn:register> iep:enrolled [\n iep:store <${MESH}> ;\n ] ;\n iep:retired [ iep:store <${TARGET.gate}/retired/> ; ] ;`);
      assert.equal(options.headers.Authorization, basic);
      if (u.searchParams.has('continuationToken')) return json({ statements: [], more: '' });
      if (u.searchParams.get('voidedStatementId') === id(3)) return json(target);
      if (u.searchParams.has('attachments')) return new Response(multipart, { headers: { 'content-type': 'multipart/mixed; boundary=fixture' } });
      return json({ statements: [statement, voiding], more: `/xapi/statements?continuationToken=${cursor}` });
    }
    assert.equal(u.origin, TARGET.gate);
    if (u.pathname.startsWith('/foxxi/')) assert.equal(options.headers.Authorization, `Bearer ${SECRET}`);
    else assert.equal(options.headers.Authorization, undefined);
    const p = u.pathname;
    if (p === '/foxxi/.well-known/context-graphs') return turtle(
      entry(`${INTERNAL}/foxxi/register-desc.ttl`, 'MeshEnrolmentRegister') +
      entry(`${POD}snapshot-desc.ttl`, 'AgentTrajectorySnapshot') + entry(`${POD}other-desc.ttl`, 'CourseCatalog'));
    if (p === '/foxxi/register-desc.ttl') return turtle(descriptor(`${INTERNAL}/foxxi/register-graph.trig`));
    if (p === '/foxxi/snapshot-desc.ttl') return turtle(descriptor(`${POD}snapshot.envelope.json`));
    if (p === '/foxxi/other-desc.ttl') return turtle(descriptor(`${POD}must-not-read-private-graph.trig`));
    if (p === '/foxxi/snapshot.envelope.json') return json({ protected: 'original-encrypted-snapshot-envelope', ciphertext: 'c29tZS1jaXBoZXJ0ZXh0' });
    if (p === '/foxxi/register-graph.trig') {
      const rows = [{ pod_url: RUNTIME }, { pod_url: `${TARGET.gate}/retired/`, retired_at: STORED },
        { pod_url: 'https://attacker.example/private/' }];
      return turtle(`<urn:register> <https://example.test/ns#bundleJson> "${Buffer.from(JSON.stringify(rows)).toString('base64')}" .`);
    }
    if (p === '/agent-one/.well-known/context-graphs') return turtle(entry(`${MESH}private-desc.ttl`, 'AgentActivity') +
      `<urn:manifest> iep:manifestArchive <${INTERNAL}/agent-one/.well-known/context-graphs-archive-0000> .`);
    if (p === '/agent-one/.well-known/context-graphs-archive-0000') return turtle(entry(`${MESH}older-private-desc.ttl`, 'AgentActivity') + entry(`${MESH}private-desc.ttl`, 'StaleArchiveType'));
    if (p === '/agent-two/.well-known/context-graphs') return turtle(entry(`${RUNTIME}private-desc.ttl`, 'AgentActivity'));
    throw new Error('Unexpected private route should not be fetched');
  };
  const fetchImpl = async (url, options) => {
    const response = await route(url, options);
    bodies.push(Buffer.from(await response.clone().arrayBuffer())); return response;
  };
  return { fetchImpl, calls, bodies, attachment, multipart, attachments };
}

test('archive collects exact canonical/voided/attachment bytes and source envelopes without widening roles', async () => {
  const f = fixture(); const { bundle, summary } = await collectArchive(CONFIG, { fetchImpl: f.fetchImpl, now: NOW });
  assert.equal(summary.canonicalStatementsCopied, 2); assert.equal(summary.voidedTargetsCopied, 1);
  assert.equal(summary.attachmentResponsesCopied, 1); assert.equal(summary.attachmentBytesVerified, f.attachment.length);
  assert.equal(summary.observedProcessResidentStatements, 779); assert.equal(summary.basicScopesFullyRead, 1);
  assert.equal(summary.tenantDescriptorsArchived, 3); assert.equal(summary.tenantSnapshotGraphsArchived, 1);
  assert.equal(summary.podsManifestsRead, 3); assert.equal(summary.completeManifestChains, 3);
  assert.equal(summary.manifestEntriesArchived, 6); assert.equal(summary.reconstructionCandidates, 6);
  assert.equal(summary.originalResidentStatementsCopied, false); assert.equal(summary.completeProcessInventory, false);
  assert.equal(summary.operator.attempted, false);
  assert.equal(f.calls.some(x => /admin|sign|flush/.test(new URL(x.url).pathname)), false);
  assert.equal(summary.publicMeshRegisterRead, true); assert.equal(summary.publicMeshActivePodCount, 1);
  assert.equal(bundle.candidates.find(x => x.envelope.descriptorUrl === `${MESH}private-desc.ttl`).envelope.conformsTo[0].endsWith('#AgentActivity'), true);
  assert.equal(f.calls.some(x => /private-desc|private-graph/.test(x.url)), false);
  assert.equal(f.calls.some(x => /attacker|retired/.test(x.url)), false);
  assert.equal(bundle.responses.length, f.bodies.length);
  bundle.responses.forEach((r, i) => assert.deepEqual(Buffer.from(r.bodyBase64, 'base64'), f.bodies[i]));
  const serialized = JSON.stringify(summary);
  for (const secret of [SECRET, SEED, 'existing-user', 'existing-password', 'PRIVATE-LEARNER-NAME', 'agent-one', 'agent-two']) assert.equal(serialized.includes(secret), false);
  const envelope = sealArchive(bundle, SEED);
  const restored = openArchive(envelope, SEED);
  assert.deepEqual(JSON.parse(restored), bundle);
  assert.equal(JSON.stringify(envelope).includes('PRIVATE-LEARNER-NAME'), false);
  assert.equal(JSON.stringify(envelope).includes(SECRET), false);
});

test('safe archive survives unavailable canonical credential reads, preserving source material', async () => {
  const f = fixture();
  const { bundle, summary } = await collectArchive(CONFIG, { now: NOW, fetchImpl: (url, options) =>
    new URL(url).pathname === '/xapi/statements' ? new Response('private server error with secret', { status: 403 }) : f.fetchImpl(url, options) });
  assert.equal(summary.canonicalStatementsCopied, 0); assert.equal(summary.basicScopesFullyRead, 0);
  assert.equal(summary.failureCodes['read-access-unavailable'], 1); assert.ok(summary.manifestEntriesArchived > 0);
  assert.equal(JSON.stringify(bundle).includes('private server error with secret'), false);
  assert.deepEqual(JSON.parse(openArchive(sealArchive(bundle, SEED), SEED)), bundle);
});

test('pod and resource validation rejects lookalikes, traversal, encoded delimiters and foreign targets', () => {
  for (const bad of ['http://gate.interego.xwisee.com/foxxi/', `${TARGET.gate}.attacker.example/foxxi/`,
    `${TARGET.gate}:8443/foxxi/`, `${TARGET.gate}/foxxi/../alice/`, `${TARGET.gate}/foxxi/%2e%2e/`,
    `${TARGET.gate}/foxxi/?q=1`, `${TARGET.gate}/foxxi/#fragment`, `https://user:pass@gate.interego.xwisee.com/foxxi/`,
    `${TARGET.gate}/foxxi\\evil/`]) assert.throws(() => checkedPod(bad));
  for (const bad of [`${TARGET.gate}/alice/private.ttl`, `${POD}../alice/private.ttl`, `${POD}%2e%2e/private.ttl`,
    `${POD}x?authorization=secret`, `${POD}x#foo`, 'https://attacker.example/x']) assert.throws(() => checkedPodResource(bad, POD));
  assert.equal(checkedPodResource(`${POD}snapshots/file.ttl`, POD), `${POD}snapshots/file.ttl`);
  assert.equal(publicStoreSpelling(`${INTERNAL}/foxxi/snapshot.ttl`), `${POD}snapshot.ttl`);
  assert.equal(publicStoreSpelling('http://css.railway.internal.attacker.example/foxxi/x'), 'http://css.railway.internal.attacker.example/foxxi/x');
  assert.throws(() => publicStoreSpelling(`${INTERNAL}/foxxi/x`, 'http://attacker.internal/'));
  assert.throws(() => publicStoreSpelling(`${INTERNAL}/foxxi/../alice/private.ttl`));
  assert.equal(archiveTarget(`${INTERNAL}/other-path/context-graphs-archive-0000`, POD), `${POD}.well-known/context-graphs-archive-0000`);
  assert.throws(() => archiveTarget(`${INTERNAL}/foxxi/private.ttl`, POD));
});

test('redirects never forward Basic or pod credentials and error bodies are not archived', async () => {
  const f = fixture(); let forbiddenFollow = 0;
  const { bundle, summary } = await collectArchive(CONFIG, { now: NOW, fetchImpl: async (url, options) => {
    if (new URL(url).origin !== TARGET.origin && new URL(url).origin !== TARGET.gate) forbiddenFollow++;
    if (new URL(url).pathname === '/xapi/statements') {
      assert.equal(options.redirect, 'manual'); return new Response('sensitive redirect error', { status: 302, headers: { location: 'https://attacker.example/steal' } });
    }
    return f.fetchImpl(url, options);
  } });
  assert.equal(forbiddenFollow, 0); assert.equal(summary.failureCodes['redirect-refused'], 1);
  assert.equal(JSON.stringify(bundle).includes('sensitive redirect error'), false);
});

test('continuation links cannot leak Basic credentials or replace fixed query scope', async () => {
  for (const more of ['https://attacker.example/xapi/statements?cursor=AAAA',
    `${TARGET.origin}/xapi/admin/tenants?cursor=AAAA`, '/xapi/statements?tenant=victim',
    `/xapi/statements?continuationToken=${Buffer.from(JSON.stringify({ offset: 2, ts: NOW.getTime() - 1, q: { until: '2026-12-01', ascending: true, limit: 500 } })).toString('base64url')}`]) {
    const f = fixture();
    const { summary } = await collectArchive(CONFIG, { now: NOW, fetchImpl: (url, options) =>
      new URL(url).pathname === '/xapi/statements' && !new URL(url).searchParams.has('attachments') && !new URL(url).searchParams.has('voidedStatementId')
        ? Promise.resolve(json({ statements: [{ id: id(1), stored: STORED }], more })) : f.fetchImpl(url, options) });
    assert.equal(summary.failureCodes['unsafe-continuation'], 1);
    assert.equal(f.calls.some(c => new URL(c.url).origin === 'https://attacker.example'), false);
  }
});

test('byte/request caps produce honest partial archives instead of unbounded allocation', async () => {
  const f = fixture();
  const { bundle, summary } = await collectArchive(CONFIG, { fetchImpl: f.fetchImpl, now: NOW,
    limits: { ...LIMITS, requests: 3, responseBytes: 1024, totalBytes: 2048 } });
  assert.ok(summary.failedOperations > 0); assert.ok(summary.sourceBytesArchived <= 2048);
  assert.ok(f.calls.length <= 3);
  assert.doesNotThrow(() => sealArchive(bundle, SEED));
  const oversized = await collectArchive({ ...CONFIG, FOXXI_LRS_BASIC_AUTH_PAIRS: '', FOXXI_MESH_PODS: '' }, { now: NOW,
    fetchImpl: async () => new Response('oversized', { headers: { 'content-type': 'application/json', 'content-length': '999999' } }),
    limits: { ...LIMITS, responseBytes: 8 } });
  assert.equal(oversized.summary.failureCodes['response-byte-limit'] > 0, true);
});

test('binary attachments are hash checked and missing or corrupt bytes are reported', () => {
  const f = fixture();
  assert.equal(verifyMultipartAttachments(f.multipart, 'multipart/mixed; boundary=fixture', f.attachments), f.attachment.length);
  const corrupt = Buffer.from(f.multipart); const at = corrupt.indexOf(f.attachment); corrupt[at] ^= 1;
  assert.throws(() => verifyMultipartAttachments(corrupt, 'multipart/mixed; boundary=fixture', f.attachments), /attachment-hash-mismatch/);
  assert.throws(() => verifyMultipartAttachments(Buffer.from('--fixture--\r\n'), 'multipart/mixed; boundary=fixture', f.attachments), /attachment-bytes-missing/);
});

test('AES-GCM rejects wrong key, ciphertext/header tampering, and response hash mismatch', () => {
  const body = Buffer.from([0, 1, 2, 255]);
  const bundle = { schema: 'lrs-best-effort-preservation-v1', createdAt: NOW.toISOString(), responses: [
    { kind: 'fixture', url: `${POD}snapshot`, bytes: body.length, sha256: sha256(body), bodyBase64: body.toString('base64') } ] };
  const envelope = sealArchive(bundle, SEED);
  assert.deepEqual(JSON.parse(openArchive(envelope, SEED)), bundle);
  assert.throws(() => openArchive(envelope, 'wrong-key'));
  const changed = structuredClone(envelope); const bytes = Buffer.from(changed.ciphertext, 'base64'); bytes[0] ^= 1; changed.ciphertext = bytes.toString('base64');
  assert.throws(() => openArchive(changed, SEED));
  const header = structuredClone(envelope); header.header.manifestSha256 = '0'.repeat(64);
  assert.throws(() => openArchive(header, SEED));
  const bad = structuredClone(bundle); bad.responses[0].bodyBase64 = Buffer.from('bad').toString('base64');
  assert.throws(() => verifyRestoredArchive(Buffer.from(JSON.stringify(bad))), /archived-response-hash-mismatch/);
  assert.throws(() => sealArchive(bad, SEED), /archived-response-hash-mismatch/);
});

test('Railway exact project/environment/service checks precede configuration access', async () => {
  for (const failAt of ['project', 'environment', 'service']) {
    let calls = 0;
    await assert.rejects(readArchiveConfig('TOKEN-DO-NOT-OUTPUT', async (url, options) => {
      calls++; assert.equal(url, TARGET.railway); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
      const { query } = JSON.parse(options.body); assert.ok(query.startsWith('query')); assert.equal(query.includes('mutation'), false);
      if (query.includes('projectToken')) return json({ data: { projectToken: { projectId: failAt === 'project' ? 'wrong' : TARGET.project, environmentId: failAt === 'environment' ? 'wrong' : TARGET.environment } } });
      if (query.includes('services')) return json({ data: { project: { services: { edges: [{ node: { id: TARGET.service, name: failAt === 'service' ? 'wrong' : TARGET.serviceName } }] } } } });
      assert.fail('variables must not be read after scope failure');
    }), /railway-scope-mismatch/);
    assert.equal(calls, failAt === 'service' ? 2 : 1);
  }
});

test('configuration read filters unrelated secrets and refuses missing archive seed', async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++; const { query } = JSON.parse(options.body);
    if (query.includes('projectToken')) return json({ data: { projectToken: { projectId: TARGET.project, environmentId: TARGET.environment } } });
    if (query.includes('services')) return json({ data: { project: { services: { edges: [{ node: { id: TARGET.service, name: TARGET.serviceName } }] } } } });
    return json({ data: { variables: { ...CONFIG, UNRELATED_DATABASE_PASSWORD: 'must-not-survive' } } });
  };
  const config = await readArchiveConfig('token', fetchImpl); assert.equal(calls, 3);
  assert.equal(config.UNRELATED_DATABASE_PASSWORD, undefined);
  await assert.rejects(collectArchive({ ...CONFIG, FOXXI_ADMIN_KEY_SEED: '' }, { fetchImpl: () => assert.fail('must not read plaintext without encryption seed') }), /archive-encryption-seed-unavailable/);
});

test('invalid run scope refuses before network and errors never expose supplied secrets', async () => {
  const output = [];
  const code = await main({ GITHUB_REPOSITORY: TARGET.repository, GITHUB_REF: 'refs/heads/master', RAILWAY_PROJECT_TOKEN: SECRET },
    () => assert.fail('network must not be used'), x => output.push(x));
  assert.equal(code, 1); assert.equal(output.length, 1); assert.equal(output[0].includes(SECRET), false);
  assert.equal(output[0].includes('execution-scope-mismatch'), true);
  assert.equal(nativeReadiness({ FOXXI_BRIDGE_PRIVATE_KEY: '0x' + '0'.repeat(64) }).bridgeKeyValid, false);
  assert.equal(nativeReadiness({ FOXXI_TENANT_POD_URL: `${INTERNAL}/foxxi/` }).configuredPodValid, true);
});

test('workflow isolated branch uploads only encrypted archive and safe summary', async () => {
  const workflow = await readFile(new URL('../.github/workflows/lrs-preservation.yml', import.meta.url), 'utf8');
  assert.match(workflow, /codex\/lrs-preservation-20261015/);
  assert.match(workflow, /contents: read/); assert.match(workflow, /node --test tests\/lrs-preservation.test.mjs/);
  const upload = workflow.slice(workflow.indexOf('uses: actions/upload-artifact'));
  assert.match(upload, /lrs-preservation\.encrypted\.json/); assert.match(upload, /lrs-preservation-summary\.json/);
  assert.doesNotMatch(upload, /\*\*|\.env|\.log|private|source|tools\//);
  assert.doesNotMatch(workflow, /railway up|railway deploy|mutation|FOXXI_ADMIN_KEY_SEED:/);
});
