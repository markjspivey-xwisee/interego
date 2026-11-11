/**
 * More than one application behind provisional Play (PROVISIONAL_PLAY_CLIENTS `namespace` and
 * `maxPods`): what the guest token's marker names, the per-application admission cap inside the
 * deployment's, and the unchanged default application.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createProvisionalPlayProvider } from '../provisional-play-provider.js';
import { DEFAULT_PLAY_NAMESPACE, isPlayNamespace, parsePlayClients, publicPlayKey, playKeyThumbprint, bootstrapProofPayload,
  PlayError, type PlayClaims } from '../provisional-play.js';
import { publicJwk } from './public-jwk.js';

const game = 'https://play.example';
const learn = 'https://learn.example';
const gameClient = { agentDid: 'did:web:identity.example:agents:game', podUrl: 'https://pods.example/game/' };
const learnClient = { agentDid: 'did:web:identity.example:agents:learn', podUrl: 'https://pods.example/learn/' };
const signer = `0x${'11'.repeat(20)}`;
const code = (expected: string) => (error: unknown) => error instanceof PlayError && error.code === expected;

function deployment(clients: Record<string, unknown>, maxPods?: number) {
  const documents = new Map<string, { body: string; revision: number }>();
  const granted: PlayClaims[] = [];
  const options = {
    issuer: 'https://identity.example', cssUrl: 'https://css.internal.example/', publicPodBase: 'https://pods.example/',
    relayUrl: 'https://relay.example', signingKey: Buffer.alloc(32, 1), stableSigningKey: true,
    clientsJson: JSON.stringify(clients), maxPods,
    withOwnerLock: <T>(_userId: string, work: () => Promise<T>) => work(),
    empty: (c: PlayClaims) => ({ userId: c.userId, agentId: c.authenticatedAgentId }), committed: () => {},
    issueCredential: async (claims: PlayClaims) => { granted.push(claims); return { token: 'private', provisionalPlay: play.tokenGrant(claims) }; },
    recoverSigner: async () => signer,
    fetcher: (async (input, init) => {
      const url = String(input);
      if (url === 'https://relay.example/tool/verify_agent') {
        const asked = JSON.parse(String(init?.body)) as { pod_url: string };
        return Response.json({ verified: true, subject_pod_url: asked.pod_url, signing: { relayAnchor: signer, canSignDelegatedRequests: true } });
      }
      if (init?.method === 'PUT') {
        const current = documents.get(url); const headers = init.headers as Record<string, string>;
        if ((headers['If-None-Match'] === '*' && current) || (headers['If-Match'] && headers['If-Match'] !== String(current?.revision)))
          return new Response(null, { status: 412 });
        documents.set(url, { body: String(init.body), revision: (current?.revision ?? 0) + 1 });
        return new Response(null, { status: 201 });
      }
      const current = documents.get(url);
      return current ? new Response(current.body, { headers: { etag: String(current.revision) } }) : new Response(null, { status: 404 });
    }) as typeof fetch,
  };
  const play = createProvisionalPlayProvider(options);
  /** A new browser key's bootstrap for `audience`, through `client`'s service grant. */
  const admit = (audience: string, client: { agentDid: string; podUrl: string }) => {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicPlayKey(publicJwk(pair.publicKey));
    const now = Math.floor(Date.now() / 1000);
    const playGrant = { _signed_payload: JSON.stringify({ purpose: 'interego-play-provisional-v1', audience,
      publicKeyThumbprint: playKeyThumbprint(jwk), challenge: crypto.randomBytes(24).toString('base64url'), expiresAt: now + 60,
      agent_id: client.agentDid, subject_pod_url: client.podUrl, timestamp: new Date(now * 1000).toISOString() }),
      _signature: `0x${'12'.repeat(65)}` };
    return play.bootstrap({ playGrant, publicKeyJwk: jwk, proof: crypto.sign('sha256', Buffer.from(bootstrapProofPayload(playGrant)),
      { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') });
  };
  const admitted = () => Object.keys(JSON.parse(documents.get('https://css.internal.example/provisional-play-admission.json')?.body
    ?? '{"owners":{}}').owners).length;
  return { play, admit, admitted, granted, documents };
}

test('an application namespace is a lowercase slug, never a name a guest pod already uses', () => {
  for (const good of ['hallowmarch', 'foxxi', 'a1', 'foxxi-learning', 'a'.repeat(32)]) assert.equal(isPlayNamespace(good), true, good);
  for (const bad of ['', 'a', 'A1', 'Foxxi', '1foxxi', '-foxxi', 'foxxi_learning', 'foxxi/learning', 'foxxi.learning', '../foxxi', 'foxxi ',
    'a'.repeat(33), 'context-graphs', 'agents', 'profile', 'play-budget', 'play-limits', 'auth-methods', 7, null, undefined, ['foxxi']]) {
    assert.equal(isPlayNamespace(bad), false, String(bad));
  }
  assert.equal(DEFAULT_PLAY_NAMESPACE, 'hallowmarch');
});

test('the client allowlist takes an optional namespace and application cap, and refuses a malformed one outright', () => {
  const clients = parsePlayClients(JSON.stringify({ [game]: gameClient, [learn]: { ...learnClient, namespace: 'foxxi', maxPods: 5 } }));
  assert.deepEqual(clients.get(game), gameClient, 'an entry without either is what it always was');
  assert.deepEqual(clients.get(learn), { ...learnClient, namespace: 'foxxi', maxPods: 5 });
  // Naming the default is the same as naming none: the marker stays without a namespace.
  assert.deepEqual(parsePlayClients(JSON.stringify({ [game]: { ...gameClient, namespace: 'hallowmarch' } })).get(game), gameClient);
  for (const namespace of ['Foxxi', 'f', '../x', 'context-graphs', 'agents', '', 7, null]) {
    assert.throws(() => parsePlayClients(JSON.stringify({ [learn]: { ...learnClient, namespace } })), /Invalid provisional Play namespace/, String(namespace));
  }
  for (const maxPods of [0, -1, 1.5, 1001, '5', null]) {
    assert.throws(() => parsePlayClients(JSON.stringify({ [learn]: { ...learnClient, maxPods } })), /Invalid provisional Play application limit/, String(maxPods));
  }
});

test('a guest token names its application\'s namespace from configuration; the default application\'s marker is unchanged', async () => {
  const d = deployment({ [game]: gameClient, [learn]: { ...learnClient, namespace: 'foxxi' } });
  const first = await d.admit(game, gameClient);
  const second = await d.admit(learn, learnClient);
  assert.deepEqual(Object.keys(first.provisionalPlay as object), ['audience', 'proofKeyThumbprint', 'expiresAt'],
    'byte-identical: no namespace key at all');
  assert.equal((first.provisionalPlay as { audience: string }).audience, game);
  assert.deepEqual(second.provisionalPlay, { audience: learn, proofKeyThumbprint: second.proofKeyThumbprint,
    expiresAt: d.granted[1]!.expiresAt, namespace: 'foxxi' });
  assert.notEqual(d.granted[0]!.userId, d.granted[1]!.userId);
  assert.equal(d.play.namespaceFor(game), undefined);
  assert.equal(d.play.namespaceFor(learn), 'foxxi');
  assert.equal(d.play.namespaceFor('https://other.example'), undefined);
  // The anchor is as it was: the namespace is configuration, not a claim.
  assert.ok(!('namespace' in d.granted[1]!));
  // One application's service grant admits no guest of the other.
  await assert.rejects(d.admit(learn, gameClient), code('invalid_play_grant'));
});

test('server.ts issues the marker from tokenGrant and refuses a token whose namespace is not the configured one', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.match(server, /issueTokenResponse\(user, undefined, provisionalPlay\.tokenGrant\(claims\)\)/);
  assert.match(server, /provisionalPlay\.namespaceFor\(owner\.audience\) !== payload\.provisionalPlay\.namespace\) return \{ valid: false, reason: 'Provisional owner binding mismatch' \}/);
});

test('an application cap bounds its own admissions and leaves the other application its share', async () => {
  const d = deployment({ [game]: gameClient, [learn]: { ...learnClient, namespace: 'foxxi', maxPods: 2 } }, 5);
  await d.admit(learn, learnClient); await d.admit(learn, learnClient);
  await assert.rejects(d.admit(learn, learnClient), code('provisional_play_application_capacity'));
  assert.equal(d.admitted(), 2, 'a refused admission reserves nothing');
  // The application without a cap of its own still has the deployment's.
  await d.admit(game, gameClient); await d.admit(game, gameClient); await d.admit(game, gameClient);
  assert.equal(d.admitted(), 5);
  await assert.rejects(d.admit(game, gameClient), code('provisional_play_lifetime_capacity'));
});

test('the deployment cap still bounds the total, whatever an application\'s own cap', async () => {
  const d = deployment({ [game]: gameClient, [learn]: { ...learnClient, namespace: 'foxxi', maxPods: 10 } }, 2);
  await d.admit(game, gameClient); await d.admit(learn, learnClient);
  await assert.rejects(d.admit(learn, learnClient), code('provisional_play_lifetime_capacity'));
  assert.equal(d.admitted(), 2);
});

test('an application cap counts that application\'s expired guests too, and never the other\'s', async () => {
  const d = deployment({ [game]: gameClient, [learn]: { ...learnClient, maxPods: 1 } }, 10);
  await d.admit(game, gameClient); await d.admit(game, gameClient);
  await d.admit(learn, learnClient);
  await assert.rejects(d.admit(learn, learnClient), code('provisional_play_application_capacity'));
  await d.admit(game, gameClient);
  assert.equal(d.admitted(), 4);
});
