/** Opt-in autonomous approval test against hosted MCP. All actors and data are synthetic. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signedJsonGraph, parseSignedJsonDocument, canonicalJson } from '../integrations/application-runtime/application-lab-runtime.ts';
import { verifyClientAuthorization } from '../integrations/application-runtime/client-authorization.ts';
import { fixture, roles, labels, purpose } from './client-signature-fixture.mjs';

if (process.env.INTEREGO_LIVE_CANARY !== '1') throw new Error('Set INTEREGO_LIVE_CANARY=1 to authorize synthetic live test accounts and artifacts.');
const expected = process.env.EXPECTED_RELAY_BUILD ?? '';
if (expected && !/^[a-f0-9]{40}$/.test(expected)) throw new Error('EXPECTED_RELAY_BUILD must be a full commit SHA');
const relay = 'https://relay.interego.xwisee.com';
const identityHost = 'https://identity.interego.xwisee.com';
const rootPath = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportPath = join(process.env.RUNNER_TEMP ?? tmpdir(), 'client-signature-live.json');
const id = 'urn:graph:interego:application:client-signature-ci-canary-' + Date.now() + '-' + randomBytes(6).toString('hex');
const report = { purpose, applicationId: id, sourceCommit: process.env.GITHUB_SHA ?? null, checks: [], receipts: [] };
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

const children = [];
const transportEnv = Object.fromEntries(['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
function startWorker(role) {
  const child = fork(new URL('./client-signature-canary-worker.mjs', import.meta.url), [role, id], {
    cwd: rootPath, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    // Preserve managed network transport settings, but no parent account credential.
    env: { ...transportEnv, TMPDIR: tmpdir(), INTEREGO_LIVE_CANARY: '1' },
  });
  children.push(child);
  return new Promise((resolveReady, rejectReady) => {
    let sequence = 0;
    const waiting = new Map();
    const startup = setTimeout(() => rejectReady(new Error(role + ' did not authenticate in time')), 180000);
    const request = (method, args) => new Promise((resolveResult, rejectResult) => {
      const seq = sequence++;
      const timer = setTimeout(() => { waiting.delete(seq); rejectResult(new Error(role + ': ' + method + ' timed out; do not retry a write')); }, 180000);
      waiting.set(seq, { resolveResult, rejectResult, timer });
      child.send({ sequence: seq, method, args }, error => {
        if (error) { clearTimeout(timer); waiting.delete(seq); rejectResult(error); }
      });
    });
    const fail = error => {
      clearTimeout(startup); rejectReady(error);
      for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.rejectResult(error); }
      waiting.clear();
    };
    child.on('error', fail);
    child.on('exit', code => fail(new Error(role + ' exited (' + code + ')')));
    child.on('message', message => {
      if (message.ready) {
        clearTimeout(startup);
        if (message.processId !== child.pid || message.role !== role) return fail(new Error('Worker identity handshake mismatch'));
        resolveReady({ ...message, request, call: (name, payload) => request('call', { name, payload }) });
      } else {
        const entry = waiting.get(message.sequence);
        if (!entry) return;
        clearTimeout(entry.timer); waiting.delete(message.sequence);
        if (message.error) entry.rejectResult(new Error(role + ': ' + message.error));
        else entry.resolveResult(message.result);
      }
    });
  });
}
const unwrap = wire => {
  if (typeof wire.status === 'number' && typeof wire.body === 'string') return { ...JSON.parse(wire.body), httpStatus: wire.status };
  if (typeof wire.text === 'string' && wire.text.startsWith('Error: ')) return { error: wire.text.slice(7) };
  return wire;
};
const invoke = async (session, control, payload = {}) => unwrap(await session.call('act', {
  descriptor_url: control.descriptorUrl, action_iri: control.action, payload,
}));
const call = async (session, name, args) => {
  const result = unwrap(await session.call(name, args));
  assert.ok(!result.error && !result.isError, name + ' refused: ' + JSON.stringify(result).slice(0, 1500));
  return result;
};
const check = name => { report.checks.push(name); save(); console.log('PASS ' + name); };

try {
  report.builds = await waitForSigning(); save();
  const sessions = [];
  for (const role of roles) sessions.push(await startWorker(role));
  const [submitter, ...reviewers] = sessions;
  const participants = sessions.map(s => s.identity);
  const scenario = fixture(id, participants), { graphs } = scenario;
  assert.equal(new Set(sessions.map(s => s.processId)).size, 3);
  assert.equal(new Set(sessions.map(s => s.keyId)).size, 3);
  report.identities = sessions.map(s => ({ role: s.role, processId: s.processId, keyId: s.keyId, ...s.identity }));
  await Promise.all(sessions.map(s => s.request('configure', { participants })));
  check('Submitter and two reviewers authenticate from separate key-holding processes to three accounts and pods');
  const head = () => call(submitter, 'get_current_head', { urn: graphs.state });
  const publish = async (kind, document) => {
    const graph = signedJsonGraph(graphs[kind], 'application-' + kind, document);
    const result = await call(submitter, 'publish_context', { graph_iri: graphs[kind], graph_content: graph.graphContent,
      visibility: 'public', sign_authorship: true });
    assert.equal(result.published, true);
    assert.ok(['pending', 'committed'].includes(result.status));
    if (result.status === 'pending') {
      // Publication acceptance precedes commit. Poll status, never repeat the write.
      const deadline = Date.now() + 90_000;
      let status;
      do {
        const response = await fetch(relay + '/publish/status?descriptorUrl=' + encodeURIComponent(result.descriptorUrl));
        assert.ok(response.ok);
        status = await response.json();
        assert.ok(['pending', 'committed'].includes(status.kind), JSON.stringify(status));
        if (status.kind === 'committed') break;
        await new Promise(done => setTimeout(done, 1000));
      } while (Date.now() < deadline);
      assert.equal(status.kind, 'committed', 'Synthetic publication did not commit in time');
    }
    const current = await call(submitter, 'get_current_head', { urn: graphs[kind] });
    assert.equal(current.forked, false);
    assert.equal(current.head.descriptorUrl, result.descriptorUrl);
    return { descriptorUrl: result.descriptorUrl, cid: current.head.cid, documentDigest: graph.digest, graphIri: graphs[kind] };
  };
  for (const reviewer of reviewers) {
    const grant = await call(submitter, 'register_agent', { agent_id: reviewer.identity.agentDid,
      label: 'SYNTHETIC client-signature canary ' + reviewer.role, scope: 'ReadWrite' });
    assert.equal(grant.registered, true);
  }
  report.contract = await publish('contract', scenario.contract); save();
  report.definition = await publish('definition', scenario.definition); save();
  report.genesis = await publish('state', scenario.state); save();
  const refs = { contract: report.contract, definition: report.definition, genesis: report.genesis };
  report.catalog = await publish('catalog', scenario.catalog(refs)); save();
  refs.catalog = report.catalog;
  report.fixtureReviews = await Promise.all(sessions.map(s => s.request('bind', { refs })));
  check('Each actor independently reads and verifies the published synthetic fixture and two-reviewer policy');
  const render = session => call(session, 'render_hmd', { descriptor_url: report.catalog.descriptorUrl });
  const prepare = (session, action) => session.request('prepare', { action });
  const refuse = async (session, control, payload, reason, name) => {
    const before = await head();
    const result = await invoke(session, control, payload);
    assert.ok(result.error && result.committed !== true, JSON.stringify(result).slice(0, 1500));
    assert.match(String(result.error), reason);
    assert.equal((await head()).head.cid, before.head.cid, 'Refusal must not change the state head');
    check(name);
  };
  const refuseSigned = async (session, action, name) => {
    const prepared = await prepare(session, action);
    await refuse(session, prepared.submit, { client_proof: prepared.proof }, /guard refused/i, name);
  };
  const verifyCommitted = async (result, signer) => {
    assert.equal(result.committed, true, JSON.stringify(result).slice(0, 1500));
    assert.ok(!result.error);
    assert.equal(result.view.snapshot.replay.complete, true);
    const { clientAuthorization, ...unsigned } = result.receipt;
    const verified = await verifyClientAuthorization(clientAuthorization, canonicalJson(unsigned));
    assert.equal(verified.keyId, signer.keyId);
    assert.equal(result.receipt.actor, signer.identity.agentDid);
    report.receipts.push(result.receipt);
  };
  await refuseSigned(submitter, 'approve', 'Submitter cannot count its own valid signature as a reviewer confirmation');
  await refuseSigned(submitter, 'finish', 'Zero reviewer confirmations cannot complete the test');
  const beforeHandoffs = await head();
  report.handoffs = await Promise.all(reviewers.map(reviewer => reviewer.request('begin-handoff', { action: 'approve' })));
  assert.equal((await head()).head.cid, beforeHandoffs.head.cid);
  check('Both reviewers obtain private short-link handoffs through MCP without changing the application state');
  for (let index = 0; index < reviewers.length; index++) {
    const reviewer = reviewers[index], name = reviewer.role;
    const view = await render(reviewer);
    const submit = view.controls.find(c => c.label === 'Submit: ' + labels.approve);
    assert.ok(submit);
    const prepared = await prepare(reviewer, 'approve');
    const foreign = await prepare(reviewers[1 - index], 'approve');
    await refuse(reviewer, prepared.submit, { client_proof: foreign.proof }, /exact action receipt|registered credential/i,
      name + ': other reviewer proof cannot be submitted as this actor');
    report.signingOrigins = prepared.signingOrigins;
    const result = await reviewer.request('handoff', { action: 'approve' });
    await verifyCommitted(result, reviewer);
    check(name + ': fresh handoff receipt signed by its own process, automatically committed and returned through MCP');
    await refuse(reviewer, prepared.submit, { client_proof: prepared.proof }, /stale application head/i,
      name + ': replayed proof refused without another state write');
    await refuseSigned(reviewer, 'approve', name + ': a fresh signature from the same reviewer cannot count twice');
    if (index === 0) await refuseSigned(submitter, 'finish', 'One reviewer confirmation cannot complete the test');
  }
  await refuseSigned(reviewers[0], 'finish', 'A reviewer cannot perform the submitter-only final transition');
  const finished = await submitter.request('finish-autonomously', {});
  await verifyCommitted(finished, submitter);
  check('Two distinct non-submitter confirmations allow the runtime-held signer to complete through MCP without a human handoff');
  const finalView = await render(submitter), finalHead = await head();
  const descriptor = await call(submitter, 'get_descriptor', { url: finalHead.head.descriptorUrl });
  const finalState = parseSignedJsonDocument(descriptor.graph.content).document;
  assert.equal(finalState.data.status, 'synthetic-test-complete');
  assert.equal(finalState.data.approvals.length, 2);
  assert.deepEqual(finalState.data.approvals.map(entry => entry.approver), reviewers.map(s => s.identity.agentDid));
  assert.deepEqual(finalState.data.approvals.map(entry => entry.keyId), reviewers.map(s => s.keyId));
  assert.ok(finalState.data.approvals.every(entry => entry.verified && entry.candidateDigest === scenario.candidateDigest));
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
  for (const child of children) child.kill('SIGTERM');
  globalThis.fetch = nativeFetch;
}
