import test from 'node:test';
import assert from 'node:assert/strict';
import { createWallet, trustedSender, profileFromStatus } from '../src/wallet.mjs';
import { normalizeRelay } from '../src/relay.mjs';

const relay = 'https://relay.example';
const principal = 'did:web:identity.example:agents:browser-alice';
const pod = 'http://css.internal/alice/';
const profile = { sessionAgent: { did: principal }, pod };
const descriptor = `${pod}note.ttl`;
function area(initial = {}) {
  let data = structuredClone(initial);
  return {
    async setAccessLevel() {},
    async get(defaults) { return structuredClone({ ...defaults, ...data }); },
    async set(values) { data = structuredClone({ ...data, ...values }); },
    snapshot: () => structuredClone(data),
  };
}
function fixture() {
  let clock = 1_800_000_000_000;
  let id = 0;
  const calls = [];
  const runtime = { id: 'wallet', getURL: path => `chrome-extension://wallet/${path}` };
  const chrome = {
    runtime,
    storage: { local: area(), session: area() },
    identity: { getRedirectURL: p => `https://wallet.chromiumapp.org/${p}`, launchWebAuthFlow: async () => 'callback' },
    permissions: { contains: async () => true, remove: async () => true },
  };
  const modes = { status: profile, entries: [{ descriptorUrl: descriptor, describes: ['urn:graph:test'] }], saveError: false, readError: false, save: null, echo: pod };
  const deps = {
    chrome, normalizeRelay,
    now: () => clock, uuid: () => `id-${++id}`,
    signIn: async ({ scope }) => ({ accessToken: 'session-secret', scope, expiresAt: clock + 3600000, relay }),
    discoverCatalog: async () => ({ relay, tools: {} }),
    callTool: async (origin, token, catalog, name, args) => {
      calls.push({ origin, token, name, args });
      if (name === 'get_pod_status') return structuredClone(modes.status);
      if (name === 'discover_context') return { pod: modes.echo, entries: modes.entries };
      if (name === 'remember') {
        if (modes.saveError) throw new Error('Network ended after dispatch');
        return modes.save ?? { remembered: true, visibility: 'private', descriptorUrl: descriptor };
      }
      if (name === 'get_descriptor') {
        if (modes.readError) throw new Error('Not readable yet');
        return { url: args.url, turtle: '<urn:note> a <urn:Descriptor>.', graph: { content: 'readable payload' } };
      }
      throw new Error('Unexpected tool');
    },
  };
  const wallet = createWallet(deps);
  const sender = { id: runtime.id, url: runtime.getURL('app.html') };
  const dispatch = (type, fields = {}) => wallet.dispatch({ type, expectedAccountId: chrome.storage.local.snapshot().activeId, ...fields }, sender);
  return { wallet, chrome, sender, dispatch, modes, calls, advance: ms => { clock += ms; } };
}
const note = { title: 'A note', url: 'https://page.example/article?secret=value#token', text: '<script>hostile text</script>', purpose: 'Research' };
async function connect(f, scope = 'mcp:write') { return f.dispatch('CONNECT', { relay, scope }); }

test('only the exact trusted extension page can operate the wallet', async () => {
  const f = fixture();
  for (const sender of [{ id: 'other', url: f.sender.url }, { id: 'wallet', url: 'https://page.example/' }, { id: 'wallet', url: f.sender.url + '?spoof' }, null]) {
    assert.equal(trustedSender(sender, f.chrome.runtime), false);
    await assert.rejects(f.wallet.dispatch({ type: 'CONNECT', relay }, sender), /Only the Interego/);
  }
  assert.equal(f.calls.length, 0);
});

test('current session agent is used rather than a historical primary identity', () => {
  assert.equal(profileFromStatus({ ...profile, identity: { primaryAgentDid: 'did:web:historical' } }, relay).principal, principal);
  assert.throws(() => profileFromStatus({ pod, identity: { primaryAgentDid: principal } }, relay));
});

test('tokens stay in session storage and never enter UI state or durable metadata', async () => {
  const f = fixture();
  const s = await connect(f);
  assert.ok(JSON.stringify(f.chrome.storage.session.snapshot()).includes('session-secret'));
  assert.ok(!JSON.stringify(f.chrome.storage.local.snapshot()).includes('session-secret'));
  assert.ok(!JSON.stringify(s).includes('session-secret'));
  assert.ok(!JSON.stringify(await f.dispatch('STATE')).includes('session-secret'));
});

test('read-only connection cannot prepare or save', async () => {
  const f = fixture(); await connect(f, 'mcp:read');
  await assert.rejects(f.dispatch('PREPARE', note), /permission to save/);
  await assert.rejects(f.dispatch('SAVE', { reviewId: 'anything' }));
  assert.equal(f.calls.filter(c => c.name === 'remember').length, 0);
});

test('discovery failures and wrong-pod echoes never look like an empty pod', async () => {
  const f = fixture(); await connect(f);
  f.modes.entries = null;
  await assert.rejects(f.dispatch('REFRESH'), /could not be read/);
  f.modes.entries = []; f.modes.echo = 'http://css.internal/bob/';
  await assert.rejects(f.dispatch('REFRESH'), /different pod/);
});

test('descriptor reading is limited to references returned by authenticated discovery', async () => {
  const f = fixture(); await connect(f); await f.dispatch('REFRESH');
  await assert.rejects(f.dispatch('DESCRIPTOR', { url: 'http://internal/secret.ttl' }), /current context list/);
  const opened = await f.dispatch('DESCRIPTOR', { url: descriptor });
  assert.equal(opened.graph.content, 'readable payload');
});

test('private saves send exactly the reviewed payload and one approval can be consumed only once', async () => {
  const f = fixture(); await connect(f);
  const review = await f.dispatch('PREPARE', note);
  assert.ok(!review.body.includes('secret=value'));
  const outcomes = await Promise.allSettled([f.dispatch('SAVE', { reviewId: review.id, body: 'replacement' }), f.dispatch('SAVE', { reviewId: review.id })]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  const writes = f.calls.filter(c => c.name === 'remember');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args, { title: review.title, body: review.body, visibility: 'private' });
  assert.equal((await f.dispatch('STATE')).receipts[0].status, 'read-back');
  assert.ok(!JSON.stringify(f.chrome.storage.local.snapshot()).includes(note.text));
});

test('cancelled and expired reviews cannot dispatch a save', async () => {
  const f = fixture(); await connect(f);
  let review = await f.dispatch('PREPARE', note);
  await f.dispatch('CANCEL');
  await assert.rejects(f.dispatch('SAVE', { reviewId: review.id }), /review expired/);
  review = await f.dispatch('PREPARE', note); f.advance(300001);
  await assert.rejects(f.dispatch('SAVE', { reviewId: review.id }), /review expired/);
  assert.equal(f.calls.filter(c => c.name === 'remember').length, 0);
});

test('changed authenticated identity is refused before remember', async () => {
  const f = fixture(); await connect(f);
  const review = await f.dispatch('PREPARE', note);
  f.modes.status = { sessionAgent: { did: 'did:web:bob' }, pod: 'http://css.internal/bob/' };
  await assert.rejects(f.dispatch('SAVE', { reviewId: review.id }), /Identity check refused/);
  assert.equal(f.calls.filter(c => c.name === 'remember').length, 0);
  assert.equal((await f.dispatch('STATE')).receipts[0].status, 'refused');
});

test('uncertain writes create a receipt, consume approval and are never retried automatically', async () => {
  const f = fixture(); await connect(f);
  const review = await f.dispatch('PREPARE', note); f.modes.saveError = true;
  await assert.rejects(f.dispatch('SAVE', { reviewId: review.id }), /uncertain/);
  await assert.rejects(f.dispatch('SAVE', { reviewId: review.id }));
  assert.equal(f.calls.filter(c => c.name === 'remember').length, 1);
  assert.equal((await f.dispatch('STATE')).receipts[0].status, 'uncertain');
});

test('accepted save with failed read-back remains accepted without repeating a write', async () => {
  const f = fixture(); await connect(f);
  const review = await f.dispatch('PREPARE', note); f.modes.readError = true;
  const entry = await f.dispatch('SAVE', { reviewId: review.id });
  assert.equal(entry.status, 'accepted');
  assert.equal(f.calls.filter(c => c.name === 'remember').length, 1);
});

test('expired session and disconnect cannot reuse stored authority', async () => {
  const f = fixture(); await connect(f); f.advance(3600001);
  await assert.rejects(f.dispatch('REFRESH'), /Sign in/);
  await connect(f);
  const state = await f.dispatch('DISCONNECT');
  assert.equal(state.accounts.length, 0);
  assert.deepEqual(f.chrome.storage.session.snapshot().sessions, {});
  await assert.rejects(f.dispatch('REFRESH'), /Sign in/);
});

test('stale windows cannot read, prepare, save, or forget the newly selected identity', async () => {
  const f = fixture(); await connect(f);
  for (const type of ['REFRESH', 'DESCRIPTOR', 'PREPARE', 'SAVE', 'DISCONNECT']) {
    await assert.rejects(f.dispatch(type, { ...note, expectedAccountId: 'stale-account' }), /active identity changed/);
  }
  assert.equal(f.calls.filter(c => c.name === 'remember').length, 0);
  assert.equal((await f.dispatch('STATE')).accounts.length, 1);
});

test('removed browser permission refuses the operation before any network call', async () => {
  const f = fixture(); await connect(f);
  const review = await f.dispatch('PREPARE', note);
  const count = f.calls.length;
  f.chrome.permissions.contains = async () => false;
  await assert.rejects(f.dispatch('SAVE', { reviewId: review.id }), /access to this relay was removed/);
  assert.equal(f.calls.length, count);
  assert.equal((await f.dispatch('STATE')).receipts.length, 0);
});
