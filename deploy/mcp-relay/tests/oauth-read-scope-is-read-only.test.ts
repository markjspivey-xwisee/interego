/**
 * A bearer narrowed to `mcp:read` cannot write, and the classification cannot go stale.
 *
 * ── WHAT THIS EXISTS FOR ────────────────────────────────────────────────────
 *
 * The OAuth scope gate asked `WRITE_SIDE_TOOLS.has(name)` against a hand-maintained list of
 * eighteen names, so any tool nobody remembered to add was ungated — the list failed OPEN. An
 * adversarial pass measured nine pod- or state-mutating tools missing from it, including
 * `record_trajectory_step`, whose handler ends in `handlePublishContext(…)` with
 * `sign_authorship` defaulting true; `set_reachability`, which durably rewrites the caller's
 * federation directory row; `rebuild_manifest`; and `sign_request`, which signs as the caller.
 * Two of the eighteen named tools that do not exist at all, which is what a hand-maintained
 * list looks like after a year.
 *
 * The gate is now `!READ_SIDE_TOOLS.has(name)` — default-deny. This file keeps that honest in
 * the only two ways that matter: the classification must COVER the registered surface, and the
 * tools that provably write must land on the write side of it.
 *
 * ── WHY IT READS THE SOURCE RATHER THAN IMPORTING ───────────────────────────
 *
 * `server.ts` calls `app.listen()` at import, so importing it to read one Set starts a relay.
 * The names are extracted from the source text instead — which is also what makes the coverage
 * assertion meaningful: it compares the two lists AS WRITTEN, and a set that stopped matching
 * the registered tools is exactly the drift being guarded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { oauthAccountHandler, nativeBackingIdentityValidator, type OAuthAccountGrant } from '../oauth-account.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const HERE = fileURLToPath(new URL('.', import.meta.url));

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Every tool registered in the TOOLS table. */
function registeredTools(): string[] {
  const at = SRC.indexOf('const TOOLS: Record<string, ToolEntry> = gateRequiredArgs({');
  if (at < 0) throw new Error('TOOLS table not found — this guard is reading the wrong file');
  const seg = SRC.slice(at, at + 40_000);
  // Top-level keys only (two-space indent); nested schema objects sit deeper.
  const names = [...seg.matchAll(/^ {2}([a-z][a-z0-9_]*):\s*\{/gm)].map(m => m[1] as string);
  return [...new Set(names)].filter(n => n !== 'properties');
}

/** The declared read-side allowlist, read out of the source. */
function readSideTools(): Set<string> {
  const at = SRC.indexOf('const READ_SIDE_TOOLS = new Set<string>([');
  if (at < 0) throw new Error('READ_SIDE_TOOLS not found — the gate was renamed or removed');
  const seg = SRC.slice(at, SRC.indexOf(']);', at));
  return new Set([...seg.matchAll(/'([a-z][a-z0-9_]*)'/g)].map(m => m[1] as string));
}

const tools = registeredTools();
const readSide = readSideTools();
check('generic resource read admission is capability-classified', SRC.includes('resourceCompositions.access(') && SRC.includes('isWriteSideTool(name, rawArgs ?? {})'));
check('no application tools in the substrate', !tools.some(name => /application/.test(name)));

// Guards the guard: an extractor that stopped matching would make every assertion vacuous.
check('the registered-tool scan still finds the tool table', tools.length > 40,
  `found ${tools.length}`);
check('the read-side allowlist still parses', readSide.size > 10, `found ${readSide.size}`);

/**
 * ★ THE TOOLS THAT PROVABLY WRITE. Each is here because its handler was read and found to
 * publish, persist, or sign — not because it looked like a writer. The six after the blank
 * line are the ones the old hand-maintained list had missed.
 */
const MUST_BE_WRITE_GATED = [
  'publish_context', 'remember', 'register_agent', 'revoke_agent', 'add_pod', 'remove_pod',
  'subscribe_to_pod', 'unsubscribe_from_pod', 'subscribe_all', 'pgsl_ingest', 'publish_node',
  'publish_directory', 'link_wallet', 'setup_identity', 'invoke_affordance', 'act',

  'record_trajectory_step', 'notify_agent', 'set_reachability', 'sign_request',
  'rebuild_manifest', 'mint', 'promote',
];

const leaked = MUST_BE_WRITE_GATED.filter(t => readSide.has(t));
check('no tool that writes pod state is on the read-side allowlist', leaked.length === 0,
  leaked.join(', '));

const unregistered = MUST_BE_WRITE_GATED.filter(t => !tools.includes(t));
check('every tool this file names is actually registered (else it is guarding a ghost)',
  unregistered.length === 0, unregistered.join(', '));

/**
 * ★★ THE CLASSIFICATION MUST COVER THE SURFACE.
 *
 * Under default-deny an unclassified tool is refused rather than granted, so this cannot leak.
 * It can still go WRONG the other way — a read that starts answering 403 to a read-only bearer
 * — and, more importantly, an entry left in the allowlist for a tool that no longer exists is
 * the same rot that put two phantom names in the old list. Both are reported here.
 */
const stale = [...readSide].filter(t => !tools.includes(t));
check('the read-side allowlist names no tool that has been removed', stale.length === 0,
  stale.join(', '));

console.log(`\n${tools.length} registered tool(s); ${readSide.size} classified read-side, `
  + `${tools.length - [...readSide].filter(t => tools.includes(t)).length} write-gated by default.`);

if (failures) {
  console.error(`\n${failures} FAILURE(S) — ${HERE}`);
  process.exit(1);
}
console.log('All checks passed — the read-only grant is read-only.');

// The own-account HTTP projection is also bounded by the read-only grant.
{
const identity = 'https://identity.example', pod = 'https://pods.example';
const alice = 'u-pk-aaaaaaaaaaaa', bob = 'u-pk-bbbbbbbbbbbb';
const now = 1_800_000_000_000;
function grant(id = alice): OAuthAccountGrant {
  return { valid: true, userId: id, ownerWebId: `${identity}/users/${id}/profile#me`,
    podUrl: `http://css.internal/${id}/`, agentId: `did:web:identity.example:agents:learning-${id}`,
    clientId: 'https://workbench.example/client.json', scope: ['mcp:read'], expiresAt: now / 1000 + 3600 };
}
test('account is a read-only, own-bearer projection with no token or credential disclosure', async () => {
  const grants = new Map([['test-alice', grant()], ['test-bob', grant(bob)]]);
  const app = express();
  app.get('/oauth/account', oauthAccountHandler({ identityOrigin: identity, podOrigin: pod, validateBackingIdentity: async () => true, now: () => now,
    introspect: token => grants.get(token) ?? null,
    publicPod: raw => raw.startsWith('http://css.internal/') ? raw.replace('http://css.internal', pod) : undefined }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/oauth/account`;
  const read = (token?: string, query = '') => fetch(endpoint + query, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  try {
    for (const token of [undefined, 'unknown']) { const r = await read(token); assert.equal(r.status, 401); await r.text(); }
    for (const [token, id] of [['test-alice', alice], ['test-bob', bob]]) {
      const r = await read(token); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
      const a = await r.json(); assert.deepEqual(Object.keys(a).sort(), ['agentId', 'clientId', 'expiresAt', 'ownerDid', 'podUrl', 'scope', 'userId', 'webId']);
      assert.equal(a.ownerDid, `did:web:identity.example:users:${id}`); assert.equal(a.podUrl, `${pod}/${id}/`);
      assert.equal(a.scope, 'mcp:read'); assert.equal(a.userId, id);
      assert.ok(!JSON.stringify(a).includes(token!)); assert.ok(!JSON.stringify(a).includes('css.internal'));
    }
    const query = await read('test-alice', '?userId=' + bob); assert.equal(query.status, 400); await query.text();
    for (const change of [
      { scope: ['mcp'] }, { scope: ['mcp:write'] }, { expiresAt: now / 1000 }, { expiresAt: 0 },
      { provisionalPlay: {} }, { ownerWebId: `${identity}/users/${bob}/profile#me` },
      { ownerDid: `did:web:identity.example:users:${bob}` }, { podUrl: `http://css.internal/${bob}/` },
      { agentId: `did:web:other.example:agents:learning-${alice}` }, { agentId: `did:web:identity.example:agents:learning-${bob}` },
      { userId: '../victim' },
    ]) {
      grants.set('test-invalid', { ...grant(), ...change });
      const r = await read('test-invalid'); assert.ok([401, 403].includes(r.status)); await r.text();
    }
    grants.set('test-valid-did', { ...grant(), ownerDid: `did:web:identity.example:users:${alice}` });
    const r = await read('test-valid-did'); assert.equal(r.status, 200); await r.text();
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
test('the real relay advertises and mounts the same custom account endpoint', () => {
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('interego_account_endpoint: `${issuerHref}/oauth/account`'));
  assert.ok(source.includes("app.get('/oauth/account', oauthAccountHandler({"));
  assert.ok(source.includes('introspect: token => oauthProvider.introspectAccessToken(token)'));
  assert.ok(source.includes('publicPod: asPublicPodUrl'));
});
test('verified people have separate bounded budgets behind one IP; invalid tokens cannot grow unlimited state', async () => {
  let clock = now;
  const grants = new Map([['test-alice', grant()], ['test-alice-two', grant()], ['test-bob', grant(bob)]]);
  const app = express(); app.set('trust proxy', 1);
  app.get('/oauth/account', oauthAccountHandler({ identityOrigin: identity, podOrigin: pod, validateBackingIdentity: async () => true, now: () => clock,
    introspect: token => grants.get(token) ?? null, publicPod: raw => raw.replace('http://css.internal', pod),
    limits: { perAccount: 2, accountEntries: 2, invalidPerIp: 2, invalidGlobal: 6, invalidIpEntries: 2 } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/oauth/account`;
  const read = async (token: string, expected: number, ip = '192.0.2.1') => {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, 'X-Forwarded-For': ip } });
    assert.equal(r.status, expected); if (expected === 429) assert.equal(r.headers.get('retry-after'), '60'); await r.text();
  };
  try {
    await read('test-alice', 200); await read('test-alice-two', 200); await read('test-alice', 429);
    await read('test-bob', 200); // Same IP, different verified person.
    await read('unknown-one', 401); await read('unknown-two', 401); await read('unknown-three', 429);
    await read('unknown-four', 401, '192.0.2.2'); await read('unknown-five', 429, '192.0.2.3'); // capped invalid-IP map
    await read('unknown-six', 401, '192.0.2.2'); await read('unknown-seven', 429, '192.0.2.2'); // global cap
    await read('test-bob', 200); // Anonymous abuse spends no verified person's budget.
    const third = 'u-pk-cccccccccccc'; grants.set('test-third', grant(third));
    await read('test-third', 429); // valid-account map also has a hard bound.
    clock += 60_001;
    await read('test-third', 200); await read('test-alice', 200); await read('new-unknown', 401, '192.0.2.3');
    clock += 3_600_000;
    await read('test-third', 401); // An expired grant cannot refresh a verified budget.
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
test('own-account reads require fresh native identity proof and recheck a cached OAuth grant after awaiting it', async () => {
  const grants = new Map([['test-alice', grant()]]);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<boolean>(resolve => { release = () => resolve(true); }), started = new Promise<void>(resolve => { entered = resolve; });
  const common = { identityOrigin: identity, podOrigin: pod, now: () => now, introspect: (token: string) => grants.get(token) ?? null,
    publicPod: (raw: string) => raw.replace('http://css.internal', pod) };
  const app = express();
  app.get('/accepted', oauthAccountHandler({ ...common, validateBackingIdentity: async () => true }));
  app.get('/rejected', oauthAccountHandler({ ...common, validateBackingIdentity: async () => false }));
  app.get('/unavailable', oauthAccountHandler({ ...common, validateBackingIdentity: async () => { throw Error('test-native'); } }));
  app.get('/missing', oauthAccountHandler(common));
  app.get('/held', oauthAccountHandler({ ...common, validateBackingIdentity: async bound => { assert.ok(Object.isFrozen(bound)); entered(); return blocked; } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const read = (path: string) => fetch(endpoint + path, { headers: { Authorization: 'Bearer test-alice' } });
  try {
    for (const [path, expected] of [['/accepted', 200], ['/rejected', 401], ['/unavailable', 503], ['/missing', 503]] as const) {
      const r = await read(path); assert.equal(r.status, expected); const body = await r.text(); assert.ok(!body.includes('test-native')); assert.ok(!body.includes('test-alice'));
    }
    const pending = read('/held'); await started; grants.delete('test-alice'); release();
    const revoked = await pending; assert.equal(revoked.status, 401); assert.ok(!(await revoked.text()).includes(alice));
  } finally { release(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
test('native backing verification binds the live subject, session agent and pod without returning native credentials', async () => {
  const rawGrant = grant(); let backing = { ...rawGrant, identityToken: 'test-native' };
  const nativeAccount = () => ({ valid: true, userId: alice, ownerDid: `did:web:identity.example:users:${alice}`, webId: rawGrant.ownerWebId,
    agentId: 'learning-' + alice, podUrl: rawGrant.podUrl, expiresAt: new Date(now + 3_600_000).toISOString() });
  let response: Record<string, unknown> = nativeAccount(), status = 200, calls = 0;
  const app = express(); app.use(express.json()); app.post('/tokens/verify', (req, res) => {
    calls++; assert.equal(req.get('Authorization'), 'Bearer test-secret'); assert.deepEqual(req.body, { token: 'test-native' }); res.status(status).json(response);
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const publicPod = (raw: string) => raw.startsWith('http://css.internal/') ? raw.replace('http://css.internal', pod) : raw.startsWith(pod + '/') ? raw : undefined;
  const options = { identityUrl: `http://127.0.0.1:${address.port}`, introspectionSecret: () => 'test-secret', now: () => now,
    lookupOAuth: async (token: string) => token === 'test-alice' ? backing : null, publicPod };
  const validator = nativeBackingIdentityValidator(options), signal = new AbortController().signal;
  try {
    assert.equal(await validator(rawGrant, 'test-alice', signal), true); assert.equal(calls, 1);
    response = { valid: false }; assert.equal(await validator(rawGrant, 'test-alice', signal), false);
    response = { valid: false, unreadable: true }; await assert.rejects(() => validator(rawGrant, 'test-alice', signal));
    for (const patch of [{ userId: bob }, { ownerDid: `did:web:identity.example:users:${bob}` }, { webId: `${identity}/users/${bob}/profile#me` },
      { agentId: 'learning-' + bob }, { podUrl: 'http://css.internal/' + bob + '/' }, { expiresAt: new Date(now - 1).toISOString() }, { provisionalPlay: {} }]) {
      response = { ...nativeAccount(), ...patch }; assert.equal(await validator(rawGrant, 'test-alice', signal), false);
    }
    response = nativeAccount(); status = 401; assert.equal(await validator(rawGrant, 'test-alice', signal), false);
    status = 404; await assert.rejects(() => validator(rawGrant, 'test-alice', signal)); status = 503; await assert.rejects(() => validator(rawGrant, 'test-alice', signal)); status = 200;
    const before = calls; backing = { ...grant(bob), identityToken: 'test-native' };
    assert.equal(await validator(rawGrant, 'test-alice', signal), false); assert.equal(calls, before);
    backing = { ...rawGrant, identityToken: 'test-native' };
    await assert.rejects(() => nativeBackingIdentityValidator({ ...options, introspectionSecret: () => undefined })(rawGrant, 'test-alice', signal));
    const aborted = new AbortController(); aborted.abort(); await assert.rejects(() => validator(rawGrant, 'test-alice', aborted.signal));
    assert.equal(calls, before);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
}
