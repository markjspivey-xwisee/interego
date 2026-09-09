/** One synthetic actor per process. Only public identities, receipts and proofs cross IPC. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { openAgentSession } from '../applications/shared-workspace/src/agent-session.ts';
import { canonicalJson, parseSignedJsonDocument } from '../integrations/application-runtime/application-lab-runtime.ts';
import { fixture, roles, labels } from './client-signature-fixture.mjs';

const [role, id] = process.argv.slice(2);
assert.equal(process.env.INTEREGO_LIVE_CANARY, '1');
assert.ok(process.send && roles.includes(role), 'Start this synthetic worker through the canary runner');
assert.match(id, /^urn:graph:interego:application:client-signature-ci-canary-[0-9]+-[a-f0-9]+$/);
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) => nativeFetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(60000) });
const secretDir = mkdtempSync(join(tmpdir(), 'interego-synthetic-signer-'));
process.on('exit', () => rmSync(secretDir, { recursive: true, force: true }));
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
const wallet = Wallet.createRandom();
const keyId = 'did:ethr:' + wallet.address.toLowerCase();
const keyPath = join(secretDir, 'actor.key');
writeFileSync(keyPath, wallet.privateKey, { mode: 0o600, flag: 'wx' });
const session = await openAgentSession({ privateKey: wallet.privateKey,
  relay: 'https://relay.interego.xwisee.com', identityHost: 'https://identity.interego.xwisee.com' });
let scenario, participants, refs, sequence = 0;
const controls = new Map();
const handoffs = new Map();
let holderToken;
async function holderApi(path, body) {
  if (!holderToken) {
    const base = 'https://identity.interego.xwisee.com';
    const challenge = await fetch(base + '/challenges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'siwe' }) });
    const { nonce } = await challenge.json();
    const message = new URL(base).host + ' wants you to sign in with your Ethereum account:\n' + wallet.address
      + '\n\nSign in to Interego\n\nURI: ' + base + '\nVersion: 1\nChain ID: 1\nNonce: ' + nonce + '\nIssued At: ' + new Date().toISOString();
    const auth = await fetch(base + '/auth/siwe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, signature: await wallet.signMessage(message), nonce, existingOnly: true }) });
    assert.ok(auth.ok, 'Existing synthetic key holder must authenticate');
    holderToken = (await auth.json()).token; assert.equal(typeof holderToken, 'string');
  }
  const response = await fetch('https://relay.interego.xwisee.com/client-interactions/' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + holderToken, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  assert.ok(response.ok, 'Holder operation refused: ' + JSON.stringify(value).slice(0, 1000));
  return value;
}
const unwrap = wire => {
  if (typeof wire.status === 'number' && typeof wire.body === 'string') return { ...JSON.parse(wire.body), httpStatus: wire.status };
  if (typeof wire.text === 'string' && wire.text.startsWith('Error: ')) return { error: wire.text.slice(7) };
  return wire;
};
const read = async (name, args) => {
  const result = unwrap(await session.call(name, args));
  assert.ok(!result.error && !result.isError, name + ' refused: ' + JSON.stringify(result).slice(0, 1500));
  return result;
};
const rememberControls = view => {
  assert.equal(view.snapshot.trust.verified, true);
  assert.equal(view.snapshot.replay.complete, true);
  for (const c of view.controls) if ([id + ':approve', id + ':finish'].includes(c.action)) controls.set(c.descriptorUrl, c.action);
  return view;
};
const render = async () => rememberControls(await read('render_hmd', { descriptor_url: refs.catalog.descriptorUrl }));
const invoke = (control, payload = {}) => session.call('act', {
  descriptor_url: control.descriptorUrl, action_iri: control.action, payload }).then(unwrap);

async function command(method, args) {
  if (method === 'configure') {
    assert.ok(!scenario, 'Worker is already scoped to a scenario');
    scenario = fixture(id, args.participants);
    participants = args.participants;
    assert.deepEqual(participants[roles.indexOf(role)], session.identity);
    return { configured: true };
  }
  assert.ok(scenario, 'Configure the synthetic scenario first');
  const podUrl = participants[0].podUrl;
  if (method === 'bind') {
    assert.ok(!refs, 'Fixture references are immutable');
    const documents = { contract: scenario.contract, definition: scenario.definition,
      genesis: scenario.state, catalog: scenario.catalog(args.refs) };
    for (const [kind, expected] of Object.entries(documents)) {
      const ref = args.refs[kind];
      assert.ok(ref.descriptorUrl.startsWith(podUrl + 'context-graphs/'));
      const descriptor = await read('get_descriptor', { url: ref.descriptorUrl });
      const envelope = parseSignedJsonDocument(descriptor.graph.content);
      assert.equal(envelope.digestVerified, true);
      assert.equal(envelope.graphIri, scenario.graphs[kind === 'genesis' ? 'state' : kind]);
      assert.equal(envelope.declaredDigest, ref.documentDigest);
      assert.equal(canonicalJson(envelope.document), canonicalJson(expected), 'Worker must read the expected synthetic ' + kind);
    }
    refs = args.refs;
    await render();
    return { verified: true, role, contractDigest: refs.contract.documentDigest };
  }
  if (method === 'begin-handoff') {
    assert.ok(refs && Object.hasOwn(labels, args.action));
    const view = await render();
    const submit = view.controls.find(c => c.label === 'Submit: ' + labels[args.action]);
    assert.ok(submit);
    const pending = await invoke(submit);
    assert.equal(pending.schema, 'interego.client-interaction/v1', JSON.stringify(pending).slice(0, 1000));
    assert.equal(pending.status, 'pending'); assert.match(pending.id, /^[\w-]{43}$/);
    assert.equal(pending.signingUrl, 'https://identity.interego.xwisee.com/sign-action?request=' + pending.id);
    handoffs.set(args.action, pending);
    const unauthenticated = await fetch('https://relay.interego.xwisee.com/client-interactions/' + pending.id);
    assert.equal(unauthenticated.status, 401, 'Knowing the short identifier grants no receipt access');
    return pending;
  }
  if (method === 'prepare' || method === 'handoff') {
    assert.ok(refs && Object.hasOwn(labels, args.action));
    // Read independently through this actor's own authenticated session. Never
    // accept a caller-supplied receipt or digest as an instruction to sign.
    const view = await render();
    const preview = view.controls.find(c => c.label === 'Preview: ' + labels[args.action]);
    const submit = view.controls.find(c => c.label === 'Submit: ' + labels[args.action]);
    assert.ok(preview && submit);
    const pending = method === 'handoff' ? handoffs.get(args.action) : undefined;
    if (method === 'handoff') assert.ok(pending, 'This worker must originate its own handoff');
    const prepared = pending ? await holderApi(pending.id + '/review', {}) : await invoke(preview);
    const request = prepared.signingRequest;
    assert.ok(request, JSON.stringify(prepared).slice(0, 1500));
    const receipt = JSON.parse(request.message);
    const head = await read('get_current_head', { pod_url: podUrl, urn: scenario.graphs.state });
    assert.equal(head.forked, false);
    const stateDescriptor = await read('get_descriptor', { url: head.head.descriptorUrl });
    const state = parseSignedJsonDocument(stateDescriptor.graph.content);
    assert.equal(state.digestVerified, true);
    assert.equal(state.document.applicationId, id);
    assert.equal(state.document.data.submitter, participants[0].agentDid);
    assert.deepEqual(state.document.data.candidate, scenario.state.data.candidate);
    const candidate = state.document.data.candidate;
    assert.equal(candidate.inputs.reduce((sum, value) => sum + value, 0), candidate.sum);
    assert.equal(state.document.data.candidateDigest, scenario.candidateDigest);
    assert.equal(receipt.actor, session.identity.agentDid);
    assert.equal(receipt.applicationId, id);
    assert.equal(receipt.actionIri, id + ':' + args.action);
    assert.equal(receipt.contractDigest, refs.contract.documentDigest);
    assert.equal(receipt.descriptorUrl, refs.contract.descriptorUrl);
    assert.equal(receipt.expectedHead, head.head.cid);
    assert.equal(receipt.stateVersion, state.document.version);
    assert.deepEqual(receipt.payload, {});
    assert.deepEqual(receipt.authority, { podUrl,
      catalogDescriptorUrl: refs.catalog.descriptorUrl, catalogDigest: refs.catalog.documentDigest,
      definitionDescriptorUrl: refs.definition.descriptorUrl, definitionDigest: refs.definition.documentDigest,
      stateDescriptorUrl: head.head.descriptorUrl, stateDigest: state.declaredDigest,
      stateGraphIri: scenario.graphs.state });
    assert.equal(request.keys.length, 1);
    assert.equal(request.keys[0].keyId, keyId);
    const prefix = join(secretDir, String(sequence++));
    writeFileSync(prefix + '.request.json', JSON.stringify(request), { mode: 0o600, flag: 'wx' });
    const reviewedDigest = createHash('sha256').update(request.message).digest('hex');
    execFileSync(process.execPath, ['tools/sign-application-action.mjs', prefix + '.request.json',
      reviewedDigest, prefix + '.proof.json'], { env: { ...process.env, INTEREGO_CLIENT_KEY_FILE: keyPath }, stdio: 'pipe' });
    const proof = JSON.parse(readFileSync(prefix + '.proof.json', 'utf8'));
    if (pending) {
      const completed = await holderApi(pending.id + '/submit', { reviewId: prepared.reviewId, proof });
      assert.equal(completed.status, 'completed', JSON.stringify(completed).slice(0, 1500));
      const status = unwrap(await session.call('act', { descriptor_url: pending.descriptorUrl, action_iri: pending.action, payload: {} }));
      assert.equal(status.status, 'completed');
      assert.deepEqual(status.result, completed.result, 'MCP must retrieve the automatic submission result');
      const repeat = await holderApi(pending.id + '/submit', { reviewId: prepared.reviewId, proof });
      assert.deepEqual(repeat.result, completed.result, 'Replayed handoff POST returns the original result');
      return { ...completed.result, handoff: { id: pending.id, status: completed.status, signingUrl: pending.signingUrl }, proof, submit };
    }
    return { proof, submit, request, reviewedDigest, signingOrigins: prepared.signingUrls.map(url => url.split('#')[0]) };
  }
  assert.equal(method, 'call', 'Unknown worker command');
  const { name, payload } = args;
  // This IPC surface is a test fixture, not a general credential proxy. It can
  // publish only this fresh scenario and act only on controls it has read.
  if (name === 'publish_context') {
    assert.equal(role, 'submitter');
    assert.ok(!refs && Object.values(scenario.graphs).includes(payload.graph_iri));
    assert.equal(payload.visibility, 'public');
    assert.equal(payload.pod_name, undefined);
  } else if (name === 'register_agent') {
    assert.equal(role, 'submitter');
    assert.ok(!refs && participants.slice(1).some(p => p.agentDid === payload.agent_id));
    assert.equal(payload.scope, 'ReadWrite');
  } else if (name === 'get_current_head') {
    assert.ok(Object.values(scenario.graphs).includes(payload.urn));
    assert.ok(!payload.pod_url || payload.pod_url === podUrl);
    return session.call(name, { ...payload, pod_url: podUrl });
  } else if (name === 'get_descriptor') {
    assert.ok(payload.url.startsWith(podUrl + 'context-graphs/'));
  } else if (name === 'render_hmd') {
    assert.equal(payload.descriptor_url, refs?.catalog.descriptorUrl);
    return render();
  } else if (name === 'act') {
    assert.ok(refs && controls.has(payload.descriptor_url));
    assert.equal(controls.get(payload.descriptor_url), payload.action_iri);
  } else throw new Error('Unsupported synthetic worker tool');
  return session.call(name, payload);
}

// Serial per actor: a command cannot race that actor's current signing operation.
let pending = Promise.resolve();
process.on('message', message => {
  pending = pending.then(async () => {
    try { process.send({ sequence: message.sequence, result: await command(message.method, message.args) }); }
    catch (error) { process.send({ sequence: message.sequence, error: String(error?.message ?? error) }); }
  });
});
process.send({ ready: true, identity: session.identity, role, keyId, processId: process.pid });
