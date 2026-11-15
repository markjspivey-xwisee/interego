/**
 * The general guest door (provisional-general-guest.ts): one provisional owner per browser key
 * across applications, off unless its setting is on and an application opted in.
 *
 * Fake conditional storage and generated local keys only, as in provisional-play-applications.test.ts.
 * No identity, pod or relay is called.
 */
import { test, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { createProvisionalPlayProvider } from '../provisional-play-provider.js';
import { PlayError, bootstrapProofPayload, generalGuestUserId, isGuestReturnPath, isProvisionalOwnerId, parsePlayClients,
  playKeyThumbprint, playProofPayload, provisionalUserId, publicPlayKey, type PlayClaims } from '../provisional-play.js';
import { GENERAL_GUEST_PURPOSE, claimProofPayload, doorProofPayload, type GeneralTokenGrant } from '../provisional-general-guest.js';
import { generalGuestDoorPage } from '../provisional-general-guest-routes.js';
import { hostedTermsPolicy } from '../hosted-terms.js';
import { purgeProvisionalPlayPod } from '../provisional-play-cleanup.js';
import { readFileSync } from 'node:fs';
import { publicJwk } from './public-jwk.js';
import { inlineScripts } from './inline-scripts.js';
import * as vm from 'node:vm';

const ISSUER = 'https://identity.example';
const game = 'https://play.example';
const learn = 'https://learn.example';
const other = 'https://other.example';
const gameAgent = { agentDid: 'did:web:identity.example:agents:game', podUrl: 'https://pods.example/game/' };
const learnAgent = { agentDid: 'did:web:identity.example:agents:learn', podUrl: 'https://pods.example/learn/' };
const otherAgent = { agentDid: 'did:web:identity.example:agents:other', podUrl: 'https://pods.example/other/' };
const general = { generalGuest: true, generalGuestReturnPath: '/guest/return' };
const signer = `0x${'11'.repeat(20)}`;
const code = (expected: string) => (error: unknown) => error instanceof PlayError && error.code === expected;
const sha = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('base64url');
type Pair = crypto.KeyPairKeyObjectResult;
const newPair = (): Pair => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwkOf = (pair: Pair) => publicPlayKey(publicJwk(pair.publicKey));
const sign = (pair: Pair, text: string) => crypto.sign('sha256', Buffer.from(text), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');

const DEFAULT_CLIENTS = { [game]: { ...gameAgent, ...general }, [learn]: { ...learnAgent, namespace: 'foxxi', ...general }, [other]: otherAgent };

function deployment(opts: { clients?: Record<string, unknown>; generalGuest?: boolean; maxPods?: number; terms?: boolean } = {}) {
  const documents = new Map<string, { body: string; revision: number }>();
  const tokens: Array<{ claims: PlayClaims; grant: GeneralTokenGrant }> = [];
  const play = createProvisionalPlayProvider({
    issuer: ISSUER, cssUrl: 'https://css.internal.example/', publicPodBase: 'https://pods.example/',
    relayUrl: 'https://relay.example', signingKey: Buffer.alloc(32, 1), stableSigningKey: true,
    clientsJson: JSON.stringify(opts.clients ?? DEFAULT_CLIENTS), maxPods: opts.maxPods, generalGuest: opts.generalGuest ?? true,
    hostedTerms: opts.terms ? hostedTermsPolicy('2026-01-15') ?? undefined : undefined,
    withOwnerLock: <T>(_userId: string, work: () => Promise<T>) => work(),
    empty: (c: PlayClaims) => ({ userId: c.userId, agentId: c.authenticatedAgentId }), committed: () => {},
    issueCredential: async (claims: PlayClaims) => ({ token: 'per-application', userId: claims.userId, provisionalPlay: play.tokenGrant(claims) }),
    issueGuestToken: async (claims, grant) => { tokens.push({ claims, grant }); return { token: `guest-token-${tokens.length}`, expiresAt: '2030-01-01T00:00:00.000Z' }; },
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
  });
  const door = play.general!;
  /** What an application backend prepares: a signed grant naming a fresh state and code challenge. */
  const grantFor = (audience: string, agent: { agentDid: string; podUrl: string }, over: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const playGrant = { _signed_payload: JSON.stringify({ purpose: GENERAL_GUEST_PURPOSE, audience, state, codeChallenge: sha(verifier),
      expiresAt: now + 60, agent_id: agent.agentDid, subject_pod_url: agent.podUrl, timestamp: new Date(now * 1000).toISOString(), ...over }),
      _signature: `0x${'12'.repeat(65)}` };
    return { playGrant, state, verifier, audience };
  };
  /** The door page's request for `pair`, then what the browser carries back to the application. */
  const enter = async (pair: Pair, audience: string, agent: { agentDid: string; podUrl: string }, opts2: { terms?: string } = {}) => {
    const prepared = grantFor(audience, agent);
    const answer = await door.door({ playGrant: prepared.playGrant, publicKeyJwk: jwkOf(pair),
      proof: sign(pair, doorProofPayload(prepared.playGrant, opts2.terms)), ...(opts2.terms ? { termsVersion: opts2.terms } : {}) }, ISSUER);
    const back = new URL(answer.redirect);
    return { ...prepared, back, code: back.searchParams.get('code')!, returnedState: back.searchParams.get('state')! };
  };
  const exchange = (entered: { code: string; verifier: string; audience: string; state: string }, over: Record<string, unknown> = {}) =>
    door.exchange({ code: entered.code, codeVerifier: entered.verifier, audience: entered.audience, state: entered.state, ...over });
  const ledger = () => JSON.parse(documents.get('https://css.internal.example/provisional-play-admission.json')?.body ?? '{"owners":{}}').owners as Record<string, string>;
  const record = (userId: string) => JSON.parse(documents.get(`https://css.internal.example/${userId}/auth-methods.jsonld`)!.body) as Record<string, unknown>;
  return { play, door, grantFor, enter, exchange, ledger, record, tokens, documents };
}

test('a general guest id is a function of the key alone, under a prefix no other account has', () => {
  const thumbprint = 'T'.repeat(43);
  const id = generalGuestUserId(thumbprint);
  assert.match(id, /^u-try-guest-[a-f0-9]{32}$/);
  assert.equal(generalGuestUserId(thumbprint), id);
  assert.notEqual(generalGuestUserId('U'.repeat(43)), id);
  assert.notEqual(provisionalUserId(game, thumbprint).slice('u-try-play-'.length), id.slice('u-try-guest-'.length));
  // The css-gate and relay of before this change recognise a guest by this pattern, which no general id matches.
  assert.doesNotMatch(id, /^u-try-play-[a-f0-9]{32}$/);
  for (const owner of [id, provisionalUserId(game, thumbprint)]) assert.equal(isProvisionalOwnerId(owner), true);
  for (const not of ['u-try-0123456789ab', 'u-pk-aaaaaaaaaaaa', `u-try-guest-${'g'.repeat(32)}`, `u-try-guest-${'a'.repeat(31)}`, `xu-try-guest-${'a'.repeat(32)}`]) {
    assert.equal(isProvisionalOwnerId(not), false, not);
  }
});

test('an application opts in with generalGuest and a registered return path; an entry without them is what it always was', () => {
  const clients = parsePlayClients(JSON.stringify({ [game]: gameAgent, [learn]: { ...learnAgent, ...general } }));
  assert.deepEqual(clients.get(game), gameAgent);
  assert.deepEqual(clients.get(learn), { ...learnAgent, generalGuest: true, generalGuestReturnPath: '/guest/return' });
  // false is the same as absent, and a return path without the opt-in is not kept.
  assert.deepEqual(parsePlayClients(JSON.stringify({ [game]: { ...gameAgent, generalGuest: false, generalGuestReturnPath: '/x' } })).get(game), gameAgent);
  for (const value of ['true', 1, null, {}]) {
    assert.throws(() => parsePlayClients(JSON.stringify({ [game]: { ...gameAgent, generalGuest: value, generalGuestReturnPath: '/x' } })), /general guest setting/, String(value));
  }
  for (const path of [undefined, '', 'guest', 'https://evil.example/', '//evil.example', '/a//b', '/a/../b', '/..', '/a?b=1', '/a#b', '/a b', '/a\\b', `/${'a'.repeat(128)}`, 7]) {
    assert.throws(() => parsePlayClients(JSON.stringify({ [game]: { ...gameAgent, generalGuest: true, generalGuestReturnPath: path } })), /return path/, String(path));
    assert.equal(isGuestReturnPath(path), false, String(path));
  }
  for (const path of ['/', '/guest/return', '/i2idlx/learning/guest/return', '/a.b_c~d-e']) assert.equal(isGuestReturnPath(path), true, path);
});

test('with the setting off there is no door, no exchange, no claim and no change to the metadata or to a per-application guest', async () => {
  const off = deployment({ generalGuest: false });
  const plain = deployment({ generalGuest: false, clients: { [game]: gameAgent, [learn]: { ...learnAgent, namespace: 'foxxi' }, [other]: otherAgent } });
  assert.equal(off.door.enabled, false);
  assert.deepEqual(off.play.metadata(), plain.play.metadata());
  assert.ok(!('generalGuest' in off.play.metadata()));
  const pair = newPair();
  const prepared = off.grantFor(game, gameAgent);
  await assert.rejects(off.door.door({ playGrant: prepared.playGrant, publicKeyJwk: jwkOf(pair), proof: sign(pair, doorProofPayload(prepared.playGrant)) }, ISSUER), code('general_guest_disabled'));
  await assert.rejects(off.door.exchange({ code: 'igc1_a.b', codeVerifier: prepared.verifier, audience: game, state: prepared.state }), code('general_guest_disabled'));
  await assert.rejects(off.door.claim({ publicKeyJwk: jwkOf(pair), expiresAt: Math.floor(Date.now() / 1000) + 30, proof: 'x' }, ISSUER), code('general_guest_disabled'));
  assert.equal(off.documents.size, 0, 'nothing was read or written');
  // The same key's per-application guest is the same owner with the same marker, whatever the opt-in says.
  const bootstrap = async (d: ReturnType<typeof deployment>) => {
    const now = Math.floor(Date.now() / 1000);
    const playGrant = { _signed_payload: JSON.stringify({ purpose: 'interego-play-provisional-v1', audience: learn,
      publicKeyThumbprint: playKeyThumbprint(jwkOf(pair)), challenge: 'c'.repeat(32), expiresAt: now + 60,
      agent_id: learnAgent.agentDid, subject_pod_url: learnAgent.podUrl, timestamp: new Date(now * 1000).toISOString() }), _signature: `0x${'12'.repeat(65)}` };
    return d.play.bootstrap({ playGrant, publicKeyJwk: jwkOf(pair), proof: sign(pair, bootstrapProofPayload(playGrant)) });
  };
  const [a, b] = [await bootstrap(off), await bootstrap(plain)];
  assert.equal(a.userId, b.userId);
  assert.equal(a.userId, provisionalUserId(learn, playKeyThumbprint(jwkOf(pair))));
  assert.deepEqual(Object.keys(a.provisionalPlay as object), ['audience', 'proofKeyThumbprint', 'expiresAt', 'namespace']);
  assert.deepEqual({ ...(a.provisionalPlay as object), expiresAt: 0 }, { ...(b.provisionalPlay as object), expiresAt: 0 });
  assert.deepEqual(Object.keys(off.record(a.userId as string)).sort(), Object.keys(plain.record(b.userId as string)).sort());
});

test('the setting alone opens nothing: an application that did not opt in has no door', async () => {
  const d = deployment();
  const pair = newPair();
  const prepared = d.grantFor(other, otherAgent);
  await assert.rejects(d.door.door({ playGrant: prepared.playGrant, publicKeyJwk: jwkOf(pair), proof: sign(pair, doorProofPayload(prepared.playGrant)) }, ISSUER), code('invalid_play_grant'));
  assert.equal(deployment({ clients: { [other]: otherAgent } }).door.enabled, false);
  assert.deepEqual(d.play.metadata().generalGuest?.applications, [game, learn]);
});

test('the door returns the browser to the registered path with a one-use code, and the exchange answers the guest', async () => {
  const d = deployment();
  const pair = newPair();
  const thumbprint = playKeyThumbprint(jwkOf(pair));
  const entered = await d.enter(pair, game, gameAgent);
  assert.equal(entered.back.origin + entered.back.pathname, `${game}/guest/return`);
  assert.deepEqual([...entered.back.searchParams.keys()], ['code', 'state']);
  assert.equal(entered.returnedState, entered.state);
  const guest = await d.exchange(entered);
  const userId = generalGuestUserId(thumbprint);
  assert.equal(guest.userId, userId);
  assert.equal(guest.ownerDid, `did:web:identity.example:users:${userId}`);
  assert.equal(guest.webId, `${ISSUER}/users/${userId}/profile#me`);
  assert.equal(guest.podUrl, `https://pods.example/${userId}/`);
  assert.equal(guest.audience, game);
  assert.equal(guest.namespace, 'hallowmarch');
  const attributes = guest.subjectAttributes as Record<string, unknown>;
  assert.deepEqual({ ...attributes, establishedAt: 0, standingUntil: 0 }, { subject: guest.ownerDid, provisional: true, claimed: false, establishedAt: 0, standingUntil: 0,
    admittedBy: [game], proofKeyThumbprint: thumbprint });
  assert.equal((attributes.standingUntil as number) - (attributes.establishedAt as number), 86400);
  // The application's token: the marker has no audience, so a service that knows only per-application guests refuses it.
  assert.equal(guest.token, 'guest-token-1');
  assert.deepEqual(d.tokens[0]!.grant, { general: true, application: game, proofKeyThumbprint: thumbprint, expiresAt: attributes.standingUntil });
  assert.ok(!('audience' in d.tokens[0]!.grant));
  assert.ok(!('attestation' in guest), 'the anchor is not handed to an application');
  // One use.
  await assert.rejects(d.exchange(entered), code('guest_code_already_used'));
  assert.deepEqual(d.record(userId).provisionalGuestCodes, []);
});

test('a code is bound to its application, its state and the verifier whose challenge the service agent signed', async () => {
  const d = deployment();
  const pair = newPair();
  const entered = await d.enter(pair, game, gameAgent);
  await assert.rejects(d.exchange(entered, { codeVerifier: crypto.randomBytes(32).toString('base64url') }), code('invalid_guest_code'));
  await assert.rejects(d.exchange(entered, { state: 's'.repeat(32) }), code('invalid_guest_code'));
  await assert.rejects(d.exchange(entered, { audience: learn }), code('invalid_guest_code'));
  await assert.rejects(d.exchange(entered, { audience: other }), code('invalid_guest_code'));
  await assert.rejects(d.exchange(entered, { code: `${entered.code.slice(0, -2)}AA` }), code('invalid_guest_code'));
  await assert.rejects(d.exchange(entered, { code: 'igc1_e30.AAAA' }), code('invalid_guest_code'));
  for (const bad of [undefined, 7, '', 'x'.repeat(4096)]) await assert.rejects(d.exchange(entered, { code: bad }), code('invalid_guest_code'));
  // None of those refusals spent it.
  assert.equal((await d.exchange(entered)).valid, true);
  // A code past its minute is refused although its signature is good.
  const expired = { v: 1, userId: generalGuestUserId(playKeyThumbprint(jwkOf(pair))), audience: game, state: entered.state,
    codeChallenge: sha(entered.verifier), expiresAt: Math.floor(Date.now() / 1000) - 1, nonce: 'n' };
  const encoded = Buffer.from(JSON.stringify(expired)).toString('base64url');
  const forged = `igc1_${encoded}.${crypto.createHmac('sha256', Buffer.alloc(32, 1)).update(`interego-general-guest-code-v1\0${encoded}`).digest('base64url')}`;
  await assert.rejects(d.exchange(entered, { code: forged }), code('invalid_guest_code'));
  // A well-signed, unexpired code that was never recorded on the owner (another deployment's, say) is not spendable.
  const unrecorded = { ...expired, expiresAt: Math.floor(Date.now() / 1000) + 30 };
  const encoded2 = Buffer.from(JSON.stringify(unrecorded)).toString('base64url');
  const forged2 = `igc1_${encoded2}.${crypto.createHmac('sha256', Buffer.alloc(32, 1)).update(`interego-general-guest-code-v1\0${encoded2}`).digest('base64url')}`;
  await assert.rejects(d.exchange(entered, { code: forged2 }), code('guest_code_already_used'));
});

test('a second application finds the same guest: the first paid the admission, and each is told only of itself', async () => {
  const d = deployment({ clients: { [game]: { ...gameAgent, ...general, maxPods: 5 }, [learn]: { ...learnAgent, namespace: 'foxxi', ...general, maxPods: 1 } } });
  const pair = newPair();
  const first = await d.exchange(await d.enter(pair, game, gameAgent));
  const second = await d.exchange(await d.enter(pair, learn, learnAgent));
  assert.equal(second.userId, first.userId);
  assert.equal(second.podUrl, first.podUrl);
  assert.equal(second.namespace, 'foxxi');
  // Each application is told only that it is itself among those the subject was admitted to: not which others there are.
  assert.deepEqual((second.subjectAttributes as { admittedBy: string[] }).admittedBy, [learn]);
  assert.deepEqual((first.subjectAttributes as { admittedBy: string[] }).admittedBy, [game]);
  assert.equal((second.subjectAttributes as { standingUntil: number }).standingUntil, (first.subjectAttributes as { standingUntil: number }).standingUntil, 'the deadline is the first admission\'s');
  assert.deepEqual(d.tokens[1]!.grant, { general: true, application: learn, proofKeyThumbprint: first.proofKeyThumbprint,
    expiresAt: (first.subjectAttributes as { standingUntil: number }).standingUntil, namespace: 'foxxi' });
  assert.deepEqual(Object.keys(d.ledger()), [first.userId], 'one admission');
  assert.equal(d.play.open(d.ledger()[first.userId as string]!, true).audience, game, 'charged to the application that sent the browser first');
  // The second application's own cap of one is still whole: it admits a new browser, then no other.
  await d.enter(newPair(), learn, learnAgent);
  await assert.rejects(d.enter(newPair(), learn, learnAgent), code('provisional_play_application_capacity'));
  // Returning again through either door admits nothing more and lists each application once.
  await d.enter(pair, game, gameAgent);
  assert.equal(Object.keys(d.ledger()).length, 2);
  assert.deepEqual((d.record(first.userId as string).provisionalGuestApplications as Array<{ audience: string }>).map(row => row.audience), [game, learn]);
});

test('the deployment cap bounds general and per-application admissions together', async () => {
  const d = deployment({ maxPods: 2 });
  await d.enter(newPair(), game, gameAgent);
  await d.enter(newPair(), learn, learnAgent);
  await assert.rejects(d.enter(newPair(), game, gameAgent), code('provisional_play_lifetime_capacity'));
  assert.equal(Object.keys(d.ledger()).length, 2);
});

test('the same key is a different owner at the door and in an application\'s own guest flow, and neither grant serves the other', async () => {
  const d = deployment();
  const pair = newPair();
  const thumbprint = playKeyThumbprint(jwkOf(pair));
  const now = Math.floor(Date.now() / 1000);
  const perApplication = { _signed_payload: JSON.stringify({ purpose: 'interego-play-provisional-v1', audience: game, publicKeyThumbprint: thumbprint,
    challenge: 'c'.repeat(32), expiresAt: now + 60, agent_id: gameAgent.agentDid, subject_pod_url: gameAgent.podUrl, timestamp: new Date(now * 1000).toISOString() }),
    _signature: `0x${'12'.repeat(65)}` };
  const own = await d.play.bootstrap({ playGrant: perApplication, publicKeyJwk: jwkOf(pair), proof: sign(pair, bootstrapProofPayload(perApplication)) });
  const guest = await d.exchange(await d.enter(pair, game, gameAgent));
  assert.equal(own.userId, provisionalUserId(game, thumbprint));
  assert.equal(guest.userId, generalGuestUserId(thumbprint));
  assert.notEqual(own.userId, guest.userId);
  assert.deepEqual(own.provisionalPlay, { audience: game, proofKeyThumbprint: thumbprint, expiresAt: (own.provisionalPlay as { expiresAt: number }).expiresAt });
  // A per-application grant does not open the door, even with a door proof over it.
  await assert.rejects(d.door.door({ playGrant: perApplication, publicKeyJwk: jwkOf(pair), proof: sign(pair, doorProofPayload(perApplication)) }, ISSUER), code('invalid_play_grant'));
  // A door grant does not bootstrap a per-application guest, and a door proof is not a bootstrap proof.
  const doorGrant = d.grantFor(game, gameAgent).playGrant;
  await assert.rejects(d.play.bootstrap({ playGrant: doorGrant, publicKeyJwk: jwkOf(pair), proof: sign(pair, bootstrapProofPayload(doorGrant)) }), code('invalid_play_grant'));
  await assert.rejects(d.door.door({ playGrant: doorGrant, publicKeyJwk: jwkOf(pair), proof: sign(pair, bootstrapProofPayload(doorGrant)) }, ISSUER), code('invalid_browser_proof'));
  // The verification route answers no general guest: its key proves itself at the door only.
  const anchor = d.record(guest.userId as string).provisionalPlayAnchor as string;
  const challenge = 'c'.repeat(32);
  await assert.rejects(d.play.verify({ attestation: anchor, audience: game, challenge, proof: sign(pair, playProofPayload(anchor, game, challenge)) }), code('invalid_attestation'));
});

test('the door refuses a grant that is replayed, stale, for another agent, or without a state and challenge of the right shape', async () => {
  const d = deployment();
  const pair = newPair();
  const attempt = (prepared: { playGrant: { _signed_payload: string; _signature: string } }, origin: unknown = ISSUER, key = pair) =>
    d.door.door({ playGrant: prepared.playGrant, publicKeyJwk: jwkOf(key), proof: sign(key, doorProofPayload(prepared.playGrant)) }, origin);
  const used = d.grantFor(game, gameAgent);
  await attempt(used);
  await assert.rejects(attempt(used), code('play_grant_already_used'));
  const now = Math.floor(Date.now() / 1000);
  const refused: Array<[string, Record<string, unknown>]> = [
    ['another purpose', { purpose: 'interego-play-provisional-v1' }], ['another application\'s agent', { agent_id: learnAgent.agentDid }],
    ['another pod', { subject_pod_url: learnAgent.podUrl }], ['no state', { state: undefined }], ['a short state', { state: 'short' }],
    ['a state that is not base64url', { state: 'not base64url!!!!!!!!!!!!!!' }], ['no challenge', { codeChallenge: undefined }],
    ['a challenge that is not 32 bytes', { codeChallenge: 'c'.repeat(42) }], ['a stale timestamp', { timestamp: new Date((now - 600) * 1000).toISOString() }],
    ['an expiry beyond two minutes', { expiresAt: now + 600 }], ['an expiry in the past', { expiresAt: now - 1 }],
  ];
  for (const [name, over] of refused) await assert.rejects(attempt(d.grantFor(game, gameAgent, over)), code('invalid_play_grant'), name);
  // Only the door page calls: any other origin, or none, is refused before anything is read.
  for (const origin of [game, 'https://evil.example', null, 'null', `${ISSUER}/`, 'http://identity.example']) {
    await assert.rejects(attempt(d.grantFor(game, gameAgent), origin), code('general_guest_door_origin'), String(origin));
  }
  // A proof by another key than the one presented.
  const prepared = d.grantFor(game, gameAgent);
  await assert.rejects(d.door.door({ playGrant: prepared.playGrant, publicKeyJwk: jwkOf(pair), proof: sign(pair, doorProofPayload(prepared.playGrant)) }, undefined),
    code('general_guest_door_origin'), 'a request with no Origin header');
  await assert.rejects(d.door.door({ playGrant: prepared.playGrant, publicKeyJwk: jwkOf(pair), proof: sign(newPair(), doorProofPayload(prepared.playGrant)) }, ISSUER), code('invalid_browser_proof'));
  await assert.rejects(d.door.door({ playGrant: prepared.playGrant, publicKeyJwk: { ...jwkOf(pair), d: 'AAAA' }, proof: 'x' }, ISSUER), code('invalid_public_key'));
  assert.equal(Object.keys(d.ledger()).length, 1, 'no refusal admitted anything');
});

test('hosted terms gate a new general guest as they gate a per-application one', async () => {
  const d = deployment({ terms: true });
  const pair = newPair();
  await assert.rejects(d.enter(pair, game, gameAgent), code('hosted_terms_required'));
  assert.equal(Object.keys(d.ledger()).length, 0, 'refused before an admission is reserved');
  await assert.rejects(d.enter(pair, game, gameAgent, { terms: '2020-01-01' }), code('hosted_terms_required'));
  const guest = await d.exchange(await d.enter(pair, game, gameAgent, { terms: '2026-01-15' }));
  assert.equal((guest.subjectAttributes as { acceptedTermsVersion?: string }).acceptedTermsVersion, '2026-01-15');
  assert.equal(d.play.metadata().generalGuest?.terms?.version, '2026-01-15');
});

test('a guest that enrolled a credential is claimed in its attributes', async () => {
  const d = deployment();
  const pair = newPair();
  const first = await d.exchange(await d.enter(pair, game, gameAgent));
  const url = `https://css.internal.example/${first.userId}/auth-methods.jsonld`;
  const stored = d.documents.get(url)!;
  d.documents.set(url, { body: JSON.stringify({ ...JSON.parse(stored.body), walletAddresses: [`0x${'ab'.repeat(20)}`] }), revision: stored.revision + 1 });
  const again = await d.exchange(await d.enter(pair, game, gameAgent));
  assert.equal((again.subjectAttributes as { claimed: boolean }).claimed, true);
  assert.equal((first.subjectAttributes as { claimed: boolean }).claimed, false);
});

test('the claim flow answers a door token for the guest the key holds, once per proof, on this origin only', async () => {
  const d = deployment();
  const pair = newPair();
  const thumbprint = playKeyThumbprint(jwkOf(pair));
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  const request = (key = pair, at = expiresAt) => ({ publicKeyJwk: jwkOf(key), expiresAt: at, proof: sign(key, claimProofPayload(ISSUER, playKeyThumbprint(jwkOf(key)), at)) });
  await assert.rejects(d.door.claim(request(), ISSUER), code('provisional_owner_unavailable'));
  const guest = await d.exchange(await d.enter(pair, game, gameAgent));
  await assert.rejects(d.door.claim(request(), game), code('general_guest_door_origin'));
  const body = request();
  const token = await d.door.claim(body, ISSUER);
  assert.equal(token.token, 'guest-token-2');
  assert.deepEqual(d.tokens[1]!.grant, { general: true, door: true, proofKeyThumbprint: thumbprint, expiresAt: (guest.subjectAttributes as { standingUntil: number }).standingUntil });
  assert.equal(d.tokens[1]!.claims.userId, guest.userId);
  await assert.rejects(d.door.claim(body, ISSUER), code('play_grant_already_used'));
  await assert.rejects(d.door.claim(request(newPair()), ISSUER), code('provisional_owner_unavailable'));
  for (const at of [expiresAt - 3600, expiresAt + 3600, 1.5, '1']) {
    await assert.rejects(d.door.claim({ ...request(), expiresAt: at }, ISSUER), code('invalid_browser_proof'), String(at));
  }
  // A door proof is not a claim proof.
  const prepared = d.grantFor(game, gameAgent);
  await assert.rejects(d.door.claim({ publicKeyJwk: jwkOf(pair), expiresAt, proof: sign(pair, doorProofPayload(prepared.playGrant)) }, ISSUER), code('invalid_browser_proof'));
});

test('a general guest ends at its deadline, and its anchor then opens for the cleanup alone', async () => {
  const d = deployment();
  const pair = newPair();
  const entered = await d.enter(pair, game, gameAgent);
  const guest = await d.exchange(entered);
  const anchor = d.record(guest.userId as string).provisionalPlayAnchor as string;
  assert.equal(d.play.open(anchor).general, true);
  // With the setting off its anchor opens for the cleanup (allowExpired) and for nothing else.
  const off = deployment({ generalGuest: false });
  assert.throws(() => off.play.open(anchor), code('invalid_attestation'));
  assert.equal(off.play.open(anchor, true).userId, guest.userId);
  // An anchor altered to drop the mark, or to claim it for a per-application owner, does not open.
  assert.throws(() => d.play.open(`${anchor.slice(0, -3)}AAA`), code('invalid_attestation'));
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    mock.timers.tick(86_400_000 + 1000);
    await assert.rejects(d.enter(pair, game, gameAgent), code('provisional_owner_expired'));
    await assert.rejects(d.enter(pair, learn, learnAgent), code('provisional_owner_expired'));
    assert.equal(d.play.open(anchor, true).general, true);
  } finally { mock.timers.reset(); }
});

test('the door page is a top-level document that runs one script, named by hash, and talks to this origin alone', () => {
  const page = generalGuestDoorPage({ issuer: ISSUER, terms: { version: '2026-01', url: 'https://terms.example/t?a=1&b="2"', privacyUrl: 'https://terms.example/p' } });
  const directives = Object.fromEntries(page.csp.split('; ').map(part => [part.split(' ')[0], part.split(' ').slice(1).join(' ')]));
  assert.equal(directives['default-src'], "'none'");
  assert.equal(directives['frame-ancestors'], "'none'");
  assert.equal(directives['connect-src'], "'self'");
  assert.equal(directives['form-action'], "'none'");
  assert.equal(directives['base-uri'], "'none'");
  assert.doesNotMatch(page.csp, /unsafe-inline|unsafe-eval|\*/);
  const scripts = inlineScripts(page.html);
  assert.equal(scripts.length, 1);
  assert.equal(directives['script-src'], `'sha256-${crypto.createHash('sha256').update(scripts[0]!, 'utf8').digest('base64')}'`);
  const style = /<style>([\s\S]*?)<\/style>/.exec(page.html)![1]!;
  assert.equal(directives['style-src'], `'sha256-${crypto.createHash('sha256').update(style, 'utf8').digest('base64')}'`);
  const script = scripts[0]!;
  // The key is generated non-extractable, and the page reaches nothing but its own three routes.
  assert.match(script, /generateKey\(\{ name: 'ECDSA', namedCurve: 'P-256' \}, false, \['sign'\]\)/);
  assert.deepEqual([...script.matchAll(/post\('([^']+)'/g)].map(m => m[1]), ['/guest/door', '/guest/door/claim', '/guest/door/link']);
  // Apart from its configuration (the issuer and the terms links), the script names no address at all.
  assert.doesNotMatch(script.replace(/^ {2}var config = .*$/m, ''), /https?:\/\//);
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie|postMessage|innerHTML|eval\(/);
  assert.match(script, /new URL\(result\.answer\.redirect\)\.origin !== audience/);
  // The terms link is escaped, and no attribute or tag is opened by its value.
  assert.match(page.html, /href="https:\/\/terms\.example\/t\?a=1&#38;b=&#34;2&#34;"/);
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'door-page.js' }), 'the script parses');
});

test('the janitor and the cleanup take up a general guest as they take up a per-application one, whatever the setting', async () => {
  const id = generalGuestUserId('T'.repeat(43));
  const listed: string[] = [];
  const purge = (userId: string) => purgeProvisionalPlayPod({ userId, cssUrl: 'https://css.internal.example/',
    fetcher: (async (input: string | URL | Request) => { listed.push(String(input)); return new Response('', { status: 200, headers: { 'Content-Type': 'text/turtle' } }); }) as typeof fetch,
    close: async () => 'kept' });
  assert.deepEqual(await purge(id), { outcome: 'kept', retained: [] });
  assert.deepEqual(listed, [`https://css.internal.example/${id}/`], 'its own pod, and nothing else');
  for (const not of ['u-pk-aaaaaaaaaaaa', 'u-try-0123456789ab', `u-try-guest-${'a'.repeat(31)}`, `u-try-guest-${'a'.repeat(32)}/..`]) {
    await assert.rejects(purge(not), /Refusing non-Play pod cleanup/, not);
  }
  // server.ts recognises both prefixes wherever it recognised the first: the janitor's sweep and its
  // purge, an unfinished purge found at load, a deletion's bookkeeping, the backfill's ledger read.
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.equal(server.match(/\/\^u-try-\(\?:play\|guest\)-\/\.test\(/g)?.length, 6);
  assert.match(server, /const PLAY_OWNER_ID = \/\^u-try-\(\?:play\|guest\)-\[a-f0-9\]\{32\}\$\/;/);
  assert.doesNotMatch(server, /startsWith\('u-try-play-'\)/, 'no place is left that knows only the per-application prefix');
  const writer = readFileSync(new URL('../auth-methods-writer.ts', import.meta.url), 'utf8');
  assert.match(writer, /const isPlayOwner = \(userId: string\) => \/\^u-try-\(\?:play\|guest\)-\/\.test\(userId\);/);
  // The setting is read as exactly "1", and only where the provider is built.
  assert.equal(server.match(/process\.env\['PROVISIONAL_GENERAL_GUEST'\]/g)?.length, 1);
  assert.match(server, /generalGuest: process\.env\['PROVISIONAL_GENERAL_GUEST'\] === '1',/);
  // An application's general guest token is answered where introspection asks, and nowhere else.
  assert.equal(server.match(/verifyToken\([^)]*\{ generalGuest: true \}\)/g)?.length, 1);
  assert.match(server, /const result = await verifyToken\(token, \{ generalGuest: true \}\);\n {2}if \(result\.valid\) \{\n {4}res\.json\(\{\n {6}valid: true,/);
});
