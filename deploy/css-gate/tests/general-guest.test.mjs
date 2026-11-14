/**
 * A general guest at the css-gate: one provisional owner per browser key across applications
 * (identity's provisional-general-guest.ts). Its write surface is its application's two checkpoint
 * documents, granted by POLICY over the attributes identity stated (guest-access.mjs: a provisional
 * guest that application admitted, whose deadline has not passed), default-deny. A per-application
 * guest's hard-coded check is not involved and is covered by the provisional-play-*.test.mjs files.
 *
 * Unit tests of the decision first, then the running gate over a stand-in identity and store.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'undici';
import { listenLoopback } from './loopback.mjs';
import { GENERAL_GUEST_BUDGET_AUDIENCE, checkProvisionalTarget, generalGuestMayWrite, provisionalCheckpointPaths,
  verifiedProvisional } from '../provisional-play.mjs';

const game = 'https://game.example';
const learn = 'https://learn.example';
const userId = 'u-try-guest-' + 'a'.repeat(32);
const ownerDid = `did:web:identity.example:users:${userId}`;
const thumbprint = 'T'.repeat(43);
const nowSeconds = Math.floor(Date.now() / 1000);
const deadline = nowSeconds + 3600;
const marker = (over = {}) => ({ general: true, application: game, proofKeyThumbprint: thumbprint, expiresAt: deadline, ...over });
const attributes = (over = {}) => ({ subject: ownerDid, provisional: true, claimed: false, createdAt: nowSeconds - 60, expiresAt: deadline,
  admittedBy: [game], proofKeyThumbprint: thumbprint, ...over });
const answer = (markerOver = {}, attributeOver = {}, top = {}) => ({ valid: true, userId, ownerDid,
  provisionalPlay: marker(markerOver), guestAttributes: attributes(attributeOver), ...top });
const initial = { 'content-type': 'application/vnd.interego.native-commit+json', 'if-none-match': '*' };

test('a general guest\'s marker is checked on its own, and a malformed one refuses the credential', () => {
  const claims = verifiedProvisional(answer());
  assert.equal(claims.general, true);
  assert.equal(claims.application, game);
  assert.equal(claims.namespace, 'hallowmarch');
  assert.equal(claims.audience, GENERAL_GUEST_BUDGET_AUDIENCE, 'one write budget for the pod, whichever application writes');
  assert.equal(verifiedProvisional(answer({ application: learn, namespace: 'foxxi' })).namespace, 'foxxi');
  const door = verifiedProvisional({ valid: true, userId, ownerDid, provisionalPlay: { general: true, door: true, proofKeyThumbprint: thumbprint, expiresAt: deadline } });
  assert.equal(door.door, true);
  assert.equal(door.application, undefined);
  const refused = [
    answer({ general: false }), answer({ general: 'true' }), answer({ audience: game }), answer({ application: undefined }),
    answer({ application: 'http://game.example' }), answer({ application: `${game}/` }), answer({ application: `${game}/path` }),
    answer({ application: 7 }), answer({ namespace: '../hallowmarch' }), answer({ namespace: 7 }), answer({ proofKeyThumbprint: 'short' }),
    answer({ expiresAt: nowSeconds }), answer({ expiresAt: nowSeconds + 9 * 86400 }), answer({ expiresAt: '1' }),
    answer({ door: true }), answer({ door: 'yes' }), answer({ door: false }),
    // The id and the DID are a general guest's, of the same owner.
    answer({}, {}, { userId: 'u-try-play-' + 'a'.repeat(32), ownerDid: `did:web:identity.example:users:u-try-play-${'a'.repeat(32)}` }),
    answer({}, {}, { userId: 'u-pk-aaaaaaaaaaaa', ownerDid: 'did:web:identity.example:users:u-pk-aaaaaaaaaaaa' }),
    answer({}, {}, { ownerDid: `did:web:identity.example:users:u-try-guest-${'b'.repeat(32)}` }),
    answer({}, {}, { ownerDid: undefined }),
  ];
  for (const data of refused) assert.throws(() => verifiedProvisional(data), error => error.status === 401 && error.code === 'provisional_play_invalid', JSON.stringify(data.provisionalPlay));
  // A per-application marker on a general guest's id is refused by the per-application check, as before.
  assert.throws(() => verifiedProvisional({ valid: true, userId, ownerDid, provisionalPlay: { audience: game, proofKeyThumbprint: thumbprint, expiresAt: deadline } }),
    error => error.status === 401);
});

test('the write surface is granted by policy over the guest\'s attributes, and by nothing else', () => {
  const allowed = generalGuestMayWrite(verifiedProvisional(answer()));
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.verdict, 'Allowed');
  assert.deepEqual(allowed.matchedPolicies, [`urn:interego:guest-access:${game}#permit-provisional-guest:guest:WriteCheckpoint`]);
  const denied = [
    ['not admitted by this application', answer({}, { admittedBy: [learn] })],
    ['admitted by no application', answer({}, { admittedBy: [] })],
    ['an application whose origin only begins like the admitted one', answer({ application: 'https://game.example.evil.example' })],
    ['no attributes at all', answer({}, {}, { guestAttributes: undefined })],
    ['attributes that are not an object', answer({}, {}, { guestAttributes: 'provisional' })],
    ['attributes of another owner', answer({}, { subject: `did:web:identity.example:users:u-try-guest-${'b'.repeat(32)}` })],
    ['attributes of another key', answer({}, { proofKeyThumbprint: 'U'.repeat(43) })],
    ['attributes with another deadline', answer({}, { expiresAt: deadline + 60 })],
    ['attributes that do not say provisional', answer({}, { provisional: false })],
    ['malformed attributes', answer({}, { admittedBy: game })],
    ['a malformed creation time', answer({}, { createdAt: 'yesterday' })],
  ];
  for (const [name, data] of denied) {
    const claims = verifiedProvisional(data);
    assert.equal(generalGuestMayWrite(claims).allowed, false, name);
    const target = new URL(provisionalCheckpointPaths(claims)[0], 'https://gate.example');
    assert.throws(() => checkProvisionalTarget(claims, 'PUT', target, initial), error => error.status === 403 && error.code === 'provisional_play_scope', name);
  }
  // The door's own token is no application's: it writes nothing.
  const door = verifiedProvisional({ valid: true, userId, ownerDid, guestAttributes: attributes(),
    provisionalPlay: { general: true, door: true, proofKeyThumbprint: thumbprint, expiresAt: deadline } });
  assert.equal(generalGuestMayWrite(door).allowed, false);
  assert.throws(() => checkProvisionalTarget(door, 'PUT', new URL(provisionalCheckpointPaths(door)[0], 'https://gate.example'), initial), error => error.status === 403);
  for (const junk of [undefined, null, {}, { general: true }]) assert.equal(generalGuestMayWrite(junk).allowed, false);
  // A claimed owner's guest token keeps the same surface until its deadline.
  assert.equal(generalGuestMayWrite(verifiedProvisional(answer({}, { claimed: true }))).allowed, true);
});

test('past the deadline the policy denies (an explicit Deny), and the gate answers expired first', () => {
  const claims = verifiedProvisional(answer());
  const later = (deadline + 1) * 1000;
  assert.deepEqual({ allowed: generalGuestMayWrite(claims, later).allowed, verdict: generalGuestMayWrite(claims, later).verdict }, { allowed: false, verdict: 'Denied' });
  assert.equal(generalGuestMayWrite(claims, deadline * 1000).verdict, 'Denied');
  assert.equal(generalGuestMayWrite(claims, (deadline - 1) * 1000).allowed, true);
  const target = new URL(provisionalCheckpointPaths(claims)[0], 'https://gate.example');
  assert.throws(() => checkProvisionalTarget(claims, 'PUT', target, initial, later), error => error.status === 401 && error.code === 'provisional_play_expired');
});

test('once the policy permits, the surface has the per-application guest\'s shape: two documents, conditional native PUTs', () => {
  const claims = verifiedProvisional(answer({ application: learn, namespace: 'foxxi' }, { admittedBy: [game, learn] }));
  const paths = provisionalCheckpointPaths(claims);
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.deepEqual(paths, ['player-profile', 'player-profile-index'].map(kind =>
    `/${userId}/foxxi/checkpoints/${hash(`urn:graph:foxxi:${kind}:${hash(ownerDid)}`)}.json`));
  const at = path => new URL(path, 'https://gate.example');
  assert.equal(checkProvisionalTarget(claims, 'PUT', at(paths[0]), initial), null);
  // The other application's namespace in the same pod is not this token's surface.
  const otherNamespace = provisionalCheckpointPaths({ userId, ownerDid, namespace: 'hallowmarch' });
  for (const [method, path, headers, status] of [
    ['PUT', otherNamespace[0], initial, 403], ['PUT', `/${userId}/foxxi/notes.json`, initial, 403], ['PUT', `/${userId}/play-budget.json`, initial, 403],
    ['PUT', `/${userId}/auth-methods.jsonld`, initial, 403], ['DELETE', paths[0], initial, 403], ['POST', `/${userId}/`, initial, 403],
    ['PUT', paths[0] + '?x=1', initial, 403], ['PUT', paths[0], { ...initial, 'content-type': 'application/json' }, 415],
    ['PUT', paths[0], { 'content-type': initial['content-type'] }, 428],
  ]) assert.throws(() => checkProvisionalTarget(claims, method, at(path), headers), error => error.status === status, `${method} ${path}`);
});

test('the gate\'s image carries the decision helper', () => {
  const dockerfile = readFileSync(new URL('../../Dockerfile.css-gate', import.meta.url), 'utf8');
  assert.match(dockerfile, /^COPY deploy\/css-gate\/guest-access\.mjs \/app\/guest-access\.mjs$/m);
  const helper = readFileSync(new URL('../guest-access.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /^\s*import\s|\bimport\(|\brequire\(/m, 'no import: the image holds nothing else of the repository');
});

// ── The running gate ─────────────────────────────────────────
process.env.WRITE_SECRET = 'operator-fixture';
process.env.CSS_INTERNAL_URL = 'http://play-storage.invalid';
process.env.CSS_HOST_HEADER = 'storage.example';
process.env.PUBLIC_BASE_URL = 'https://gate.example';
process.env.CSS_GATE_AUTOSTART = '0';
process.env.RELAY_VERIFY_URL = '';
process.env.USER_BEARER_CACHE_TTL_MS = '0';

const tokens = {
  'game-token': answer(),
  'learn-token': answer({ application: learn, namespace: 'foxxi' }, { admittedBy: [game, learn] }),
  'not-admitted': answer({ application: learn, namespace: 'foxxi' }),
  'no-attributes': answer({}, {}, { guestAttributes: undefined }),
  'door-token': { valid: true, userId, ownerDid, guestAttributes: attributes(), provisionalPlay: { general: true, door: true, proofKeyThumbprint: thumbprint, expiresAt: deadline } },
  'with-audience': answer({ audience: game }),
};
const identity = await listenLoopback(createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(tokens[JSON.parse(body).token] ?? { valid: false }));
}));
process.env.IDENTITY_URL = identity.base;
const { server, _setUpstreamPool } = await import('../server.mjs');
const stored = new Map();
const forwarded = [];
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
let generation = 0;
const upstream = await listenLoopback(createServer(async (req, res) => {
  const path = req.url;
  if (!path.endsWith('/play-budget.json')) forwarded.push(path);
  const previous = stored.get(path);
  if (req.method === 'GET') {
    res.writeHead(previous ? 200 : 404, previous ? { 'Content-Type': 'application/json', ETag: `"${previous.revision}"`,
      'Interego-Revision': previous.revision, 'Interego-Body-Digest': hash(previous.body) } : {});
    res.end(previous?.body ?? ''); return;
  }
  let wrapper = ''; for await (const chunk of req) wrapper += chunk;
  const command = JSON.parse(wrapper);
  if ((previous?.revision ?? null) !== command.expectedRevision) { res.writeHead(412); res.end('conflict'); return; }
  const body = Buffer.from(command.bodyBase64, 'base64');
  const revision = hash(Buffer.concat([Buffer.from(String(++generation)), body]));
  stored.set(path, { body, revision });
  const resource = 'http://storage.example' + path;
  res.writeHead(201, { 'Content-Type': 'application/json', ETag: `"${revision}"` });
  res.end(JSON.stringify({ version: 1, status: 'committed', expectedRevision: command.expectedRevision, resource, path: resource,
    pod: 'fixture', revision, bodyDigest: hash(body), contentType: 'application/json', updatedAt: Date.now(), size: body.length,
    topUri: 'urn:pgsl:atom:' + 'a'.repeat(40), opaqueUri: 'urn:pgsl:atom:' + 'b'.repeat(40) }));
}));
const pool = new Pool(upstream.base, { connections: 4 });
_setUpstreamPool(process.env.CSS_INTERNAL_URL, pool);
const gate = await listenLoopback(server);
after(async () => { await gate.close(); await pool.close(); await upstream.close(); await identity.close(); });

const encrypted = Buffer.from(JSON.stringify({ version: 1, algorithm: 'X25519-XSalsa20-Poly1305',
  content: { algorithm: 'XSalsa20-Poly1305', ciphertext: 'opaque' }, wrappedKeys: [{}] }));
const send = (token, target) => fetch(gate.base + target, { method: 'PUT', headers: { Authorization: `Bearer ${token}`,
  'Content-Type': 'application/vnd.interego.native-commit+json', 'If-None-Match': '*' },
  body: JSON.stringify({ version: 1, expectedRevision: null, contentType: 'application/json', bodyBase64: encrypted.toString('base64') }) });

test('through the gate: each application\'s token writes that application\'s two checkpoints in the one pod, and nothing else reaches the store', async () => {
  const gamePaths = provisionalCheckpointPaths({ userId, ownerDid, namespace: 'hallowmarch' });
  const learnPaths = provisionalCheckpointPaths({ userId, ownerDid, namespace: 'foxxi' });
  const otherPod = 'u-try-guest-' + 'b'.repeat(32);
  const refusals = [
    ['game-token', learnPaths[0], 403], ['learn-token', gamePaths[0], 403], ['game-token', `/${userId}/junk.json`, 403],
    ['game-token', `/${userId}/play-budget.json`, 403], ['game-token', `/${userId}/auth-methods.jsonld`, 403],
    ['game-token', provisionalCheckpointPaths({ userId: otherPod, ownerDid: `did:web:identity.example:users:${otherPod}` })[0], 403],
    // Not admitted by the application the token names: the policy does not apply, and default-deny refuses.
    ['not-admitted', learnPaths[0], 403], ['not-admitted', gamePaths[0], 403],
    ['no-attributes', gamePaths[0], 403], ['door-token', gamePaths[0], 403],
    // A marker that is both kinds is neither.
    ['with-audience', gamePaths[0], 401], ['unknown-token', gamePaths[0], 401],
  ];
  for (const [token, target, status] of refusals) assert.equal((await send(token, target)).status, status, `${token} ${target}`);
  assert.deepEqual(forwarded, []);
  assert.equal(stored.size, 0, 'no refusal charged the budget');
  for (const target of gamePaths) assert.equal((await send('game-token', target)).status, 201, target);
  for (const target of learnPaths) assert.equal((await send('learn-token', target)).status, 201, target);
  assert.deepEqual(forwarded, [...gamePaths, ...learnPaths]);
  // The pod's private documents (the sign-in record, which lists the owner's credentials and the
  // other applications it has used, and the budget) are not read with an application's or the door's
  // credential, though an ordinary owner's bearer reads its own.
  forwarded.length = 0;
  for (const token of ['game-token', 'learn-token', 'door-token', 'not-admitted']) {
    for (const document of ['auth-methods.jsonld', 'play-budget.json']) {
      const read = await fetch(`${gate.base}/${userId}/${document}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(read.status, 403, `${token} ${document}`);
      assert.doesNotMatch(await read.text(), /writes|bytes|provisionalPlayAnchor/);
    }
  }
  assert.equal((await fetch(`${gate.base}/${userId}/auth-methods.jsonld`)).status, 401, 'and not anonymously either, as before');
  assert.deepEqual(forwarded, []);
  // Everything else in the pod is read as any pod content is: without a bearer.
  assert.equal((await fetch(gate.base + gamePaths[0])).status, 200);
  // One budget for the pod, charged by both applications' writes.
  const budget = JSON.parse(stored.get(`/${userId}/play-budget.json`).body);
  assert.equal(budget.writes, 4);
  assert.equal(budget.audience, GENERAL_GUEST_BUDGET_AUDIENCE);
  assert.equal(budget.userId, userId);
});
