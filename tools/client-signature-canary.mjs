/** Opt-in hosted-MCP smoke check. Creates only clearly synthetic identities and data. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { openAgentSession } from '../applications/shared-workspace/src/agent-session.ts';
import { signedJsonGraph, parseSignedJsonDocument, canonicalJson } from '../integrations/application-runtime/application-lab-runtime.ts';
import { clientSigningMessage, verifyClientAuthorization } from '../integrations/application-runtime/client-authorization.ts';

if (process.env.INTEREGO_LIVE_CANARY !== '1') throw new Error('Set INTEREGO_LIVE_CANARY=1 to authorize synthetic live test accounts and artifacts.');
const expected = process.env.EXPECTED_RELAY_BUILD ?? '';
if (expected && !/^[a-f0-9]{40}$/.test(expected)) throw new Error('EXPECTED_RELAY_BUILD must be a full commit SHA');
const relay = 'https://relay.interego.xwisee.com';
const identityHost = 'https://identity.interego.xwisee.com';
const rootPath = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportPath = join(process.env.RUNNER_TEMP ?? tmpdir(), 'client-signature-live.json');
const report = { purpose: 'SYNTHETIC client-signature test. Never a real release approval.', sourceCommit: process.env.GITHUB_SHA ?? null, checks: [] };
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) => nativeFetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(60000) });
const health = async () => {
  const [r, i] = await Promise.all([fetch(relay + '/health'), fetch(identityHost + '/health')]);
  assert.ok(r.ok && i.ok, 'Both services must be healthy');
  const [rv, iv] = await Promise.all([r.json(), i.json()]);
  return { relay: rv.build, identity: iv.build };
};
const waitForSigning = async () => {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    try {
      const builds = await health();
      const pages = await Promise.all([fetch(relay + '/sign-action'), fetch(identityHost + '/sign-action')]);
      if (pages.every(p => p.ok) && (!expected || builds.relay === expected)) return builds;
    } catch { /* Read-only deployment probes may wait; writes never retry here. */ }
    console.log('Waiting for both deployed signing pages and the requested relay build.');
    await new Promise(done => setTimeout(done, 15000));
  }
  throw new Error('The deployed signing services did not become ready within 30 minutes');
};
const unwrap = wire => typeof wire.body === 'string' ? { ...JSON.parse(wire.body), httpStatus: wire.status } : wire;
const invoke = async (session, control, payload = {}) => unwrap(await session.call('act', {
  descriptor_url: control.descriptorUrl, action_iri: control.action, payload,
}));
const call = async (session, name, args) => {
  const result = await session.call(name, args);
  assert.ok(!result.error && !result.isError, name + ' refused: ' + JSON.stringify(result).slice(0,1500));
  return result;
};
const check = name => { report.checks.push(name); save(); console.log('PASS ' + name); };
const secretDir = mkdtempSync(join(tmpdir(), 'interego-client-canary-'));
try {
  report.builds = await waitForSigning(); save();
  const wallets = [Wallet.createRandom(), Wallet.createRandom()];
  const sessions = [];
  for (const wallet of wallets) sessions.push(await openAgentSession({ privateKey: wallet.privateKey, relay, identityHost }));
  const [a, b] = sessions;
  assert.notEqual(a.identity.agentDid, b.identity.agentDid);
  assert.notEqual(a.identity.podUrl, b.identity.podUrl);
  report.identities = sessions.map(s => s.identity); check('Two process-held wallets authenticate to separate accounts and pods');
  const id = 'urn:graph:interego:application:client-signature-ci-canary-' + Date.now();
  const graphs = { contract: id + ':contract', definition: id + ':definition', state: id + ':state', catalog: id + ':catalog' };
  const head = () => call(a, 'get_current_head', { urn: graphs.state });
  const publish = async (kind, document) => {
    const graph = signedJsonGraph(graphs[kind], 'application-' + kind, document);
    const result = await call(a, 'publish_context', { graph_iri: graphs[kind], graph_content: graph.graphContent,
      visibility: 'public', sign_authorship: true });
    assert.equal(result.published, true);
    const current = await call(a, 'get_current_head', { urn: graphs[kind] });
    assert.equal(current.forked, false);
    assert.equal(current.head.descriptorUrl, result.descriptorUrl);
    return { descriptorUrl: result.descriptorUrl, cid: current.head.cid, documentDigest: graph.digest, graphIri: graphs[kind] };
  };
  const grant = await call(a, 'register_agent', { agent_id: b.identity.agentDid, label: 'SYNTHETIC client-signature canary second signer', scope: 'ReadWrite' });
  assert.equal(grant.registered, true);
  const baseGuard = [{ op: 'eq', left: '$state.status', right: 'test-review' }, { op: 'eq', left: '$authorization.verified', right: true }];
  const approve = { actionIri: id + ':approve', label: 'Sign synthetic canary receipt', method: 'POST',
    target: 'urn:interego:runtime:signed-domain:v1', clientSignature: true, inputs: [],
    guard: { op: 'all', guards: [...baseGuard,
      { op: 'none', path: '$state.approvals', where: { itemPath: 'approver', eq: '$actor' } },
      { op: 'none', path: '$state.approvals', where: { itemPath: 'keyId', eq: '$authorization.keyId' } }] },
    effects: [{ op: 'appendUnique', path: '$state.approvals', by: 'approver',
      value: { approver: '$actor', keyId: '$authorization.keyId', verified: '$authorization.verified', at: '$now' } }] };
  const finish = { actionIri: id + ':finish', label: 'Finish synthetic canary', method: 'POST',
    target: approve.target, clientSignature: true, inputs: [],
    guard: { op: 'all', guards: [...baseGuard,
      { op: 'countDistinct', path: '$state.approvals', itemPath: 'approver', gte: 2 },
      { op: 'countDistinct', path: '$state.approvals', itemPath: 'keyId', gte: 2 }] },
    effects: [{ op: 'set', path: '$state.status', value: 'synthetic-test-complete' }] };
  report.applicationId = id;
  report.contract = await publish('contract', { schema: 'interego.application.contract/v1', applicationId: id,
    version: '1.0.0', runtimeIri: approve.target, actions: [approve, finish] }); save();
  report.definition = await publish('definition', { schema: 'interego.application.definition/v1', id,
    title: 'SYNTHETIC client signature canary — no real release approval', description: report.purpose,
    version: '1.0.0', stateGraphIri: graphs.state, contractGraphIri: graphs.contract }); save();
  report.genesis = await publish('state', { schema: 'interego.application.state/v1', applicationId: id,
    version: 0, data: { status: 'test-review', approvals: [] } }); save();
  report.catalog = await publish('catalog', { schema: 'interego.application.catalog/v1', id: graphs.catalog,
    version: 1, applications: [{ applicationId: id, contractGraphIri: graphs.contract,
      definitionGraphIri: graphs.definition, definitionDescriptorUrl: report.definition.descriptorUrl,
      stateGraphIri: graphs.state, manifestCids: { contract: report.contract, definition: report.definition, genesisState: report.genesis } }] }); save();
  const render = session => call(session, 'render_hmd', { descriptor_url: report.catalog.descriptorUrl });
  let proofSequence = 0;
  const signRequest = (request, signerIndex) => {
    const prefix = join(secretDir, String(proofSequence++));
    writeFileSync(prefix + '.key', wallets[signerIndex].privateKey, { mode: 0o600, flag: 'wx' });
    writeFileSync(prefix + '.request.json', JSON.stringify(request));
    execFileSync(process.execPath, ['tools/sign-application-action.mjs', prefix + '.request.json',
      createHash('sha256').update(request.message).digest('hex'), prefix + '.proof.json'],
    { cwd: rootPath, env: { ...process.env, INTEREGO_CLIENT_KEY_FILE: prefix + '.key' }, stdio: 'pipe' });
    return JSON.parse(readFileSync(prefix + '.proof.json', 'utf8'));
  };
  const verifyCommitted = async (result, signerIndex) => {
    assert.equal(result.committed, true, JSON.stringify(result).slice(0,1500));
    assert.ok(!result.error, JSON.stringify(result).slice(0,1500));
    assert.equal(result.view.snapshot.replay.complete, true);
    const { clientAuthorization, ...unsigned } = result.receipt;
    const verified = await verifyClientAuthorization(clientAuthorization, canonicalJson(unsigned));
    assert.equal(verified.keyId, 'did:ethr:' + wallets[signerIndex].address.toLowerCase());
    assert.equal(result.receipt.actor, sessions[signerIndex].identity.agentDid);
  };
  for (let index = 0; index < sessions.length; index++) {
    const session = sessions[index], view = await render(session);
    const previewControl = view.controls.find(c => c.label === 'Preview: Sign synthetic canary receipt');
    const submitControl = view.controls.find(c => c.label === 'Submit: Sign synthetic canary receipt');
    assert.ok(previewControl && submitControl);
    const missing = await invoke(session, submitControl);
    assert.ok(missing.error && missing.committed !== true, JSON.stringify(missing).slice(0,1500));
    assert.match(String(missing.error), /client signature.*required/i);
    check('Signer ' + (index + 1) + ': missing client proof refused');
    const preview = await invoke(session, previewControl), request = preview.signingRequest;
    assert.ok(request, JSON.stringify(preview).slice(0,1500));
    assert.ok(request.keys.some(entry => entry.key.address?.toLowerCase() === wallets[index].address.toLowerCase()));
    assert.ok(request.keys.every(entry => entry.key.address?.toLowerCase() !== wallets[1-index].address.toLowerCase()));
    report.signingOrigins = preview.signingUrls.map(url => url.split('#')[0]); save();
    const wrongKey = { scheme: 'eip191', address: wallets[1-index].address };
    const wrong = { schema: 'interego.client-signature/v1', key: wrongKey, message: request.message,
      signature: await wallets[1-index].signMessage(clientSigningMessage(request.message, wrongKey)) };
    const refused = await invoke(session, submitControl, { client_proof: wrong });
    assert.ok(refused.error && refused.committed !== true, JSON.stringify(refused).slice(0,1500));
    assert.match(String(refused.error), /registered credential/i);
    assert.equal((await head()).head.cid, JSON.parse(request.message).expectedHead);
    check('Signer ' + (index + 1) + ': another account key refused without a state write');
    const proof = signRequest(request, index);
    const result = await invoke(session, submitControl, { client_proof: proof });
    await verifyCommitted(result, index);
    check('Signer ' + (index + 1) + ': process-signed receipt committed and retained signature independently verified');
    const committedHead = await head();
    const reused = await invoke(session, submitControl, { client_proof: proof });
    assert.ok(reused.error && reused.committed !== true);
    assert.equal((await head()).head.cid, committedHead.head.cid);
    check('Signer ' + (index + 1) + ': used proof refused without another state write');
  }
  const ready = await render(a);
  const finishPreview = ready.controls.find(c => c.label === 'Preview: Finish synthetic canary');
  const finishSubmit = ready.controls.find(c => c.label === 'Submit: Finish synthetic canary');
  const finishRequest = (await invoke(a, finishPreview)).signingRequest;
  assert.ok(finishRequest);
  const finished = await invoke(a, finishSubmit, { client_proof: signRequest(finishRequest, 0) });
  await verifyCommitted(finished, 0);
  check('Two distinct client signatures satisfy the live synthetic quorum');
  const finalView = await render(a), finalHead = await head();
  const descriptor = await call(a, 'get_descriptor', { url: finalHead.head.descriptorUrl });
  const finalState = parseSignedJsonDocument(descriptor.graph.content).document;
  assert.equal(finalState.data.status, 'synthetic-test-complete');
  assert.equal(finalState.data.approvals.length, 2);
  assert.equal(new Set(finalState.data.approvals.map(entry => entry.keyId)).size, 2);
  assert.equal(new Set(finalState.data.approvals.map(entry => entry.approver)).size, 2);
  assert.equal(finalHead.forked, false);
  assert.equal(finalView.snapshot.replay.complete, true);
  assert.equal(finalView.snapshot.replay.links.filter(link => link.authorizationBasis === 'client-signature').length, 3);
  report.stateHead = finalHead; report.replay = finalView.snapshot.replay;
  assert.deepEqual(await health(), report.builds, 'Deployment changed during this test; retain the test record and run a fresh canary after rollout');
  report.passed = true; save();
  console.log('CLIENT_SIGNATURE_LIVE_RESULT ' + JSON.stringify({ passed: true, builds: report.builds,
    applicationId: id, catalog: report.catalog, stateHead: finalHead,
    actors: finalState.data.approvals.map(entry => entry.approver), keys: finalState.data.approvals.map(entry => entry.keyId),
    verifiedLinks: report.replay.verifiedLinks, chainLength: report.replay.chainLength, checks: report.checks }));
} catch (error) {
  report.passed = false; report.error = String(error?.message ?? error); save(); throw error;
} finally {
  rmSync(secretDir, { recursive: true, force: true });
  globalThis.fetch = nativeFetch;
}
