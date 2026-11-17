/**
 * The I2IDL-X learner workbench admits identity's GENERAL guest (one guest per browser across
 * Interego applications) beside its own guest, when the operator turns that on.
 *
 * Identity here is the real provider run in process over fake storage
 * (applications/_shared/tests/general-guest-identity.ts), and the door page is played by a
 * generated P-256 key. No identity, relay or pod is called. Every name is fictional.
 */
import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { decide, subjectAttributeGraph, type SubjectFacts } from '@interego/abac/portable';
import { attachLearningRoutes, GUEST_LEARNING_OPERATIONS } from '../src/i2idlx-learning-routes.js';
import { GENERAL_GUEST_RETURN_PATH, GENERAL_GUEST_START_PATH, type GeneralGuestEntry, type LearningPrincipal } from '../src/i2idlx-learning-auth.js';
import { emptyLearningState, LearningConnectionsStore, type LearningRepository, type LearningSnapshot } from '../src/i2idlx-learning-connections.js';
import { learnerGeneralGuestDoor, learnerGeneralGuestSettings } from '../src/i2idlx-general-guest.js';
import { learnerGuestGrantConfig } from '../src/play-grant.js';
import { TENANT_ADMIN_ACTION, TENANT_ADMIN_POLICIES, mayAdministerTenant } from '../src/tenant-admin-policy.js';
import { attachCoursePlayerRoutes, learnerFromPlayerAuth } from '../src/cmi5-player.js';
import { registerCmi5Course } from '../src/cmi5-lms.js';
import { DEFAULT_TENANT } from '../src/tenant-context.js';
import { LINKED_GUEST_SESSION_MS } from '../../_shared/guest-access/session.js';
import type { GeneralGuestSession } from '../../_shared/guest-access/door.js';
import { ISSUER, identity, newKey } from '../../_shared/tests/general-guest-identity.js';
import { generalGuestUserId, playKeyThumbprint, publicPlayKey } from '../../../deploy/identity/provisional-play.js';

type Row = Record<string, unknown>;
// The browser modules, as the workbench app and the course player load them.
const { learningGeneralGuestSignIn } = await import(/* @vite-ignore */ new URL('../i2idlx/app/src/learning-guest.js', import.meta.url).href) as { learningGeneralGuestSignIn(value: unknown, origin: string): { start_url: string } | null };
const { learningSession } = await import(/* @vite-ignore */ new URL('../i2idlx/app/src/learning-client.js', import.meta.url).href) as { learningSession(value: unknown, origin: string): Row };
const BASE = 'https://workbench.example', RELAY = 'https://relay.example', POD = 'https://pods.example', ELSEWHERE = 'https://elsewhere.example';
const PREFIX = '/i2idlx/learning', API = '/i2idlx/api/learning';
const SERVICE = { agentDid: 'did:web:identity.example:agents:learn-service', podUrl: POD + '/learn/' };
const COURSE = 'https://workbench.example/general-course';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

type Key = ReturnType<typeof newKey>;
const guestIdOf = (key: Key) => generalGuestUserId(playKeyThumbprint(publicPlayKey(key.publicKey.export({ format: 'jwk' }))));
const guestDidOf = (key: Key) => `did:web:identity.example:users:${guestIdOf(key)}`;
/** Everything a test may not find in an address or a body the browser is handed. */
const SECRET = /cg2_|code=|state=|token|grant=/i;

async function fixture(options: { general?: 'off' | 'door'; door?: (id: ReturnType<typeof identity>) => GeneralGuestEntry; guests?: boolean } = {}) {
  let offset = 0;
  const now = () => Date.now() + offset;
  const id = identity({ [BASE]: { ...SERVICE, returnPath: GENERAL_GUEST_RETURN_PATH },
    [ELSEWHERE]: { agentDid: 'did:web:identity.example:agents:elsewhere-service', podUrl: POD + '/elsewhere/', returnPath: '/return' } });
  let snapshot: LearningSnapshot = { revision: null, state: emptyLearningState() }, serial = 0;
  const repository: LearningRepository = {
    async read() { return structuredClone(snapshot); },
    async write(expected, state) { assert.equal(expected, snapshot.revision); snapshot = { revision: String(++serial), state: structuredClone(state) }; },
  };
  // What the workbench itself may call while serving a general guest: nobody. Identity is asked
  // once, by the door, at the exchange; the session is never re-checked.
  const outbound: string[] = [];
  const transport: typeof fetch = async input => { outbound.push(String(input)); throw new Error('a general guest session calls no one'); };
  const door = options.general === 'off' ? undefined : (options.door ? options.door(id) : id.doorFor(BASE, SERVICE));
  const app = express(); app.set('trust proxy', false); app.use(express.json());
  const learning = attachLearningRoutes(app, { baseUrl: BASE, relayOrigin: RELAY, identityOrigin: ISSUER, podOrigin: POD, repository, fetch: transport, now,
    sessions: {} as never, taskConfig: { baseUrl: BASE, appDataFile: '', checkOperations: {} } as never,
    ...(options.guests === false ? {} : { guestGrant: async () => { throw new Error('the workbench\'s own guest door is not used here'); } }),
    ...(door ? { generalGuest: door } : {}) });
  const structure = [{ kind: 'au' as const, id: COURSE + '/au', title: 'One', url: COURSE + '/au.html', moveOn: 'Completed' as const }];
  registerCmi5Course(DEFAULT_TENANT, { id: COURSE, title: 'A fictional course', structure });
  attachCoursePlayerRoutes(app, {
    baseUrl: BASE, authoritativeSource: 'did:web:workbench.example', book: undefined,
    requireLearner: req => learnerFromPlayerAuth(learning.auth, req),
    verifyGuest: async () => { throw new Error('unused'); },
    resolveCourse: async courseId => courseId === COURSE ? { id: COURSE, title: 'A fictional course', structure } : null,
    satisfied: () => [], stageLaunch: async () => undefined, recordLaunched: async () => undefined, forgetActor: async () => 0,
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const local = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { learning.auth.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  /** Every address this application sent a browser to, and every page address it was left on. */
  const locations: string[] = [];

  /** One browser: a cookie jar and the workbench's Origin. Its guest key lives at the door, as `key`. */
  function browser(key: Key = newKey()) {
    const jar = new Map<string, string>();
    const send = async (pathAndQuery: string, init: RequestInit = {}, cookies: Map<string, string> = jar): Promise<Response> => {
      const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await fetch(local + pathAndQuery, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), ...(cookie ? { Cookie: cookie } : {}) } });
      for (const set of response.headers.getSetCookie()) {
        const [pair] = set.split(';'), at = pair!.indexOf('='), name = pair!.slice(0, at), value = pair!.slice(at + 1);
        if (value) cookies.set(name, value); else cookies.delete(name);
      }
      const location = response.headers.get('location'); if (location) locations.push(location);
      return response;
    };
    const status = async () => (await (await send(PREFIX + '/session')).json()) as Row;
    /** Leave for the door. Answers the door address and, once the page is clicked, the return address. */
    const leave = async (query = '') => {
      const started = await send(GENERAL_GUEST_START_PATH + query);
      assert.equal(started.status, 302, 'the workbench sends the browser to the door');
      const doorUrl = started.headers.get('location')!;
      const back = await id.page(key, doorUrl);
      return { started, doorUrl, back, returnPath: back.pathname + back.search };
    };
    /** The whole visit: out through the door and back in. */
    const arrive = async (query = '') => { const visit = await leave(query); return { ...visit, returned: await send(visit.returnPath) }; };
    const call = async (path: string, body: Row) => {
      const csrf = String((await status()).csrf);
      const response = await send(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, 'X-I2IDLX-Learning-CSRF': csrf }, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as Row };
    };
    return { key, jar, send, status, leave, arrive, call };
  }
  /** A second store over the same records, for what a registered owner would have done in their own session. */
  const records = new LearningConnectionsStore({ repository, now, fetch: (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v2/courses') return Response.json({ courses: [{ id: 'course-a', title: 'A fictional course', version: 2 }] });
    return Response.json({ id: 'course-a', title: 'A fictional course', version: 2 });
  }) as typeof fetch });
  const registered = (userId: string): LearningPrincipal => ({ subject: `did:web:identity.example:users:${userId}`, userId, webId: `${ISSUER}/users/${userId}/profile#me`, podUrl: `${POD}/${userId}/`,
    sessionId: 'fixture-session-' + userId, expiresAt: now() + 3_600_000, signal: new AbortController().signal });
  return { id, browser, local, locations, outbound, records, registered, now, advance: (ms: number) => { offset += ms; }, state: () => snapshot.state };
}

/** A door with the shared client's shape that answers whatever a test says identity answered. */
function scriptedDoor(answer: () => GeneralGuestSession | Promise<GeneralGuestSession>): GeneralGuestEntry {
  return { audience: BASE,
    async start() { return { url: `${ISSUER}/guest/door#grant=fixture`, state: 's'.repeat(43), binding: 'b'.repeat(43) }; },
    async finish() { return answer(); } };
}
const USER = 'u-try-guest-' + 'ab'.repeat(16);
function stated(over: Partial<GeneralGuestSession> = {}, facts: Partial<SubjectFacts> = {}): GeneralGuestSession {
  const ownerDid = `did:web:identity.example:users:${USER}`, guestExpiresAt = (Math.floor(Date.now() / 1000) + 86_400) * 1000;
  return { userId: USER, ownerDid, webId: `${ISSUER}/users/${USER}/profile#me`, podUrl: `${POD}/${USER}/`, agentDid: `did:web:identity.example:agents:play-${USER}`,
    namespace: 'hallowmarch', guestExpiresAt, token: 'cg2_NEVER-KEPT', tokenExpiresAt: new Date(guestExpiresAt).toISOString(),
    attributes: { subject: ownerDid, provisional: true, claimed: false, establishedAt: Math.floor(Date.now() / 1000) - 60, standingUntil: guestExpiresAt / 1000, admittedBy: [BASE], ...facts },
    ...over };
}
const scriptedReturn = GENERAL_GUEST_RETURN_PATH + '?code=fixture-code&state=' + 's'.repeat(43);

describe('the learner workbench and identity\'s general guest', () => {
  it('is off unless configured: no status member, no route, no cookie, and the settings name exactly what turns it on', async () => {
    for (const guests of [true, false]) {
      const f = await fixture({ general: 'off', guests }), b = f.browser();
      const status = await b.status();
      // The whole signed-out answer, as it was before this door existed.
      assert.deepEqual(status, { authenticated: false, enabled: true, account: null, csrf: null, expires_at: null, sign_in_url: PREFIX + '/oauth/start',
        ...(guests ? { guest_sign_in: { grant_url: PREFIX + '/guest/grant', challenge_url: PREFIX + '/guest/challenge', session_url: PREFIX + '/guest/session',
          bootstrap_url: ISSUER + '/play/provisional', audience: BASE } } : {}) });
      // The door's two paths answer as a path this application never had: same status, same body, same headers.
      const shape = async (path: string) => { const r = await fetch(f.local + path, { redirect: 'manual' }); const headers = Object.fromEntries(r.headers); delete headers.date;
        return { status: r.status, headers, body: (await r.text()).replaceAll(path.split('?')[0]!, '<path>') }; };
      const never = await shape(PREFIX + '/guest/general/never-existed');
      assert.equal(never.status, 404);
      for (const path of [GENERAL_GUEST_START_PATH, GENERAL_GUEST_RETURN_PATH + '?code=x&state=y']) {
        const answered = await shape(path);
        assert.deepEqual({ ...answered, headers: { ...answered.headers, 'content-length': '' } }, { ...never, headers: { ...never.headers, 'content-length': '' } }, path);
        assert.equal(answered.headers['set-cookie'], undefined);
      }
      assert.equal(b.jar.size, 0);
      // The page's reading of that answer has no member for the door either.
      assert.deepEqual(Object.keys(learningSession(status, BASE)).sort(), ['account', 'authenticated', 'enabled', 'guest', 'guest_sign_in', 'sign_in_url']);
    }
    const KEY = '0x' + '11'.repeat(32);
    const learner = learnerGuestGrantConfig({ FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY: KEY, INTEREGO_IDENTITY_URL: ISSUER, INTEREGO_RELAY_URL: RELAY }, BASE)!;
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', 'on']) {
      assert.equal(learnerGeneralGuestSettings({ ...(value === undefined ? {} : { FOXXI_I2IDLX_GENERAL_GUEST: value }), FOXXI_I2IDLX_GENERAL_GUEST_DOOR_ORIGIN: 'https://door.example' }, learner), null, JSON.stringify(value));
    }
    assert.deepEqual(learnerGeneralGuestSettings({ FOXXI_I2IDLX_GENERAL_GUEST: '1' }, learner), { audience: BASE, identityUrl: ISSUER });
    assert.deepEqual(learnerGeneralGuestSettings({ FOXXI_I2IDLX_GENERAL_GUEST: '1', FOXXI_I2IDLX_GENERAL_GUEST_DOOR_ORIGIN: 'https://door.example' }, learner),
      { audience: BASE, identityUrl: ISSUER, doorOrigin: 'https://door.example' });
    assert.throws(() => learnerGeneralGuestSettings({ FOXXI_I2IDLX_GENERAL_GUEST: '1' }, null), /FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY/);
    for (const origin of ['https://door.example/guest', 'http://door.example', 'door.example', BASE]) {
      assert.throws(() => learnerGeneralGuestSettings({ FOXXI_I2IDLX_GENERAL_GUEST: '1', FOXXI_I2IDLX_GENERAL_GUEST_DOOR_ORIGIN: origin }, learner), /DOOR_ORIGIN/, origin);
    }
    // The bridge's door is the shared client, for the workbench's own origin and the stated door.
    const door = learnerGeneralGuestDoor({ audience: BASE, identityUrl: ISSUER, doorOrigin: 'https://door.example' }, async () => { throw new Error('unused'); });
    assert.deepEqual([door.audience, door.identityUrl, door.doorOrigin], [BASE, ISSUER, 'https://door.example']);
  });

  it('refuses to start with a door that answers for another origin', async () => {
    await assert.rejects(fixture({ door: id => id.doorFor(ELSEWHERE, { agentDid: 'did:web:identity.example:agents:elsewhere-service', podUrl: POD + '/elsewhere/' }) }), /audience/);
  });

  it('takes a browser through the door and back into a guest learner session, with no code or bearer left in any address', async () => {
    const f = await fixture(), b = f.browser();
    const offered = await b.status();
    assert.deepEqual(offered.general_guest_sign_in, { start_url: GENERAL_GUEST_START_PATH });
    assert.equal(offered.authenticated, false);
    // The page follows only this workbench's own start path, whatever a status answer says.
    assert.deepEqual(learningGeneralGuestSignIn(offered.general_guest_sign_in, BASE), { start_url: BASE + GENERAL_GUEST_START_PATH });
    assert.equal(learningGeneralGuestSignIn(undefined, BASE), null);
    for (const start_url of ['https://evil.example' + GENERAL_GUEST_START_PATH, ISSUER + '/guest/door', GENERAL_GUEST_START_PATH + '?next=/learn', PREFIX + '/oauth/start', 'javascript:alert(1)']) {
      assert.throws(() => learningGeneralGuestSignIn({ start_url }, BASE), /unsupported guest configuration/, start_url);
    }
    assert.deepEqual(learningSession(offered, BASE).general_guest_sign_in, { start_url: BASE + GENERAL_GUEST_START_PATH });

    const visit = await b.leave();
    // Out: a top-level address at identity's door. The grant is in the fragment, which no server is sent.
    const doorUrl = new URL(visit.doorUrl);
    assert.equal(doorUrl.origin + doorUrl.pathname, ISSUER + '/guest/door'); assert.equal(doorUrl.search, ''); assert.match(doorUrl.hash, /^#grant=[A-Za-z0-9_-]+$/);
    const grant = JSON.parse(JSON.parse(Buffer.from(doorUrl.hash.slice('#grant='.length), 'base64url').toString('utf8'))._signed_payload) as Row;
    assert.equal(grant.audience, BASE); assert.equal(grant.purpose, 'interego-general-guest-v1'); assert.equal(grant.agent_id, SERVICE.agentDid);
    // The visit is bound to this browser by a cookie no script can read, which is no credential.
    const doorCookie = visit.started.headers.getSetCookie().find(c => c.startsWith('__Host-i2idlx-learning-door='))!;
    assert.match(doorCookie, /; Path=\/; /); assert.match(doorCookie, /; HttpOnly/); assert.match(doorCookie, /; Secure/); assert.match(doorCookie, /; SameSite=Lax/);
    assert.equal(visit.started.headers.get('cache-control'), 'no-store'); assert.equal(visit.started.headers.get('referrer-policy'), 'no-referrer');
    // Back: identity returns the browser to the path registered for this application, on its own origin.
    assert.equal(visit.back.origin, BASE); assert.equal(visit.back.pathname, GENERAL_GUEST_RETURN_PATH);

    const returned = await b.send(visit.returnPath);
    assert.equal(returned.status, 303);
    assert.equal(returned.headers.get('location'), BASE + '/i2idlx/#ask');
    assert.equal(returned.headers.get('referrer-policy'), 'no-referrer');
    const set = returned.headers.getSetCookie();
    assert.ok(set.some(c => /^__Host-i2idlx-learning=[a-f0-9]{64}; .*HttpOnly/.test(c) && /; Secure/.test(c) && /; SameSite=Lax/.test(c)), 'the session is the workbench\'s ordinary HttpOnly cookie');
    assert.ok(set.some(c => c.startsWith('__Host-i2idlx-learning-door=;')), 'the door cookie is cleared');
    assert.deepEqual([...b.jar.keys()], ['__Host-i2idlx-learning']);

    const status = await b.status();
    assert.equal(status.authenticated, true); assert.equal(status.guest, true); assert.equal(status.general_guest, true); assert.equal(status.linked_account, undefined);
    assert.deepEqual(status.account, { id: guestDidOf(b.key), userId: guestIdOf(b.key), webId: `${ISSUER}/users/${guestIdOf(b.key)}/profile#me` });
    const read = learningSession(status, BASE);
    assert.equal(read.guest, true); assert.equal(read.general_guest, true); assert.equal(read.linked_account, undefined);
    const life = Date.parse(String(status.expires_at)) - f.now();
    assert.ok(life > 3_590_000 && life <= 3_600_000, 'an unlinked general guest\'s session has the workbench guest\'s one-hour ceiling');
    // Identity was asked once, by the door, and the workbench itself asked nobody.
    assert.equal(f.id.exchanges.length, 1); assert.deepEqual(f.outbound, []);
    // Nothing the browser was sent to or left on, and nothing it was told, carries a code or a bearer.
    for (const location of f.locations.filter(l => !l.startsWith(ISSUER + '/guest/door#'))) assert.doesNotMatch(location, SECRET, location);
    assert.equal(f.locations.filter(l => l.startsWith(ISSUER + '/guest/door#')).length, 1);
    assert.doesNotMatch(JSON.stringify(status), /cg2_|code=|state=|"token"/i);

    // The same browser key, another visit, with somewhere to return to: the same guest, a new session.
    f.advance(61_000);
    const again = await b.arrive('?next=' + encodeURIComponent('/learn?course=' + encodeURIComponent(COURSE)));
    assert.equal(again.returned.status, 303);
    assert.equal(again.returned.headers.get('location'), BASE + '/learn?course=' + encodeURIComponent(COURSE));
    assert.equal(((await b.status()).account as Row).userId, guestIdOf(b.key));
    // Signing out ends it like any other session.
    assert.equal((await b.call(PREFIX + '/sign-out', {})).status, 200);
    assert.equal((await b.status()).authenticated, false);
  });

  it('refuses a return without the door cookie or with another browser\'s, a replayed code, and anything but the two members', async () => {
    const f = await fixture(), a = f.browser(), stranger = f.browser();
    const mine = await a.leave(), theirs = await stranger.leave();
    const refused = async (response: Response) => { assert.equal(response.status, 400); assert.equal(((await response.json()) as Row).error, 'learning_sign_in_state_invalid'); assert.equal(response.headers.get('location'), null); };
    // No cookie at all: a return address alone signs nobody in.
    await refused(await a.send(mine.returnPath, {}, new Map()));
    // Another browser's cookie: a stranger holding this return address is not let in by it,
    await refused(await a.send(mine.returnPath, {}, new Map(stranger.jar)));
    // and a return address planted on this browser (another visit's code and state) signs it in to nothing.
    await refused(await a.send(theirs.returnPath));
    await refused(await a.send(mine.returnPath + '&next=/learn'));
    await refused(await a.send(GENERAL_GUEST_RETURN_PATH + '?state=' + new URLSearchParams(mine.back.search).get('state')));
    assert.equal(f.id.exchanges.length, 0, 'none of those reached identity');
    assert.equal((await a.status()).authenticated, false); assert.equal((await stranger.status()).authenticated, false);
    // None of those spent the visit: the browser that started it still finishes it,
    assert.equal((await a.send(mine.returnPath)).status, 303);
    assert.equal(((await a.status()).account as Row).userId, guestIdOf(a.key));
    // and so does the stranger, as itself.
    assert.equal((await stranger.send(theirs.returnPath)).status, 303);
    assert.equal(((await stranger.status()).account as Row).userId, guestIdOf(stranger.key));
    // The return address is spent with its code: replayed with or without the old cookie it is refused,
    await refused(await a.send(mine.returnPath));
    await refused(await a.send(mine.returnPath, {}, new Map([['__Host-i2idlx-learning-door', mine.started.headers.getSetCookie()[0]!.split(';')[0]!.split('=')[1]!]])));
    assert.equal(f.id.exchanges.length, 2);
    // and a code replayed straight to identity is spent there too.
    const replay = f.id.exchanges[0] as Row;
    await assert.rejects(f.id.general.exchange(replay), /guest_code_already_used/);
    // Another site cannot start a visit with this browser's cookies by a scripted request, nor name where to go after.
    assert.equal((await a.send(GENERAL_GUEST_START_PATH, { headers: { Origin: 'https://evil.example' } })).status, 400);
    for (const next of ['https://evil.example/learn', '//evil.example/learn', '/admin', '/learn/../admin//x']) {
      f.advance(61_000);
      assert.equal((await a.send(GENERAL_GUEST_START_PATH + '?next=' + encodeURIComponent(next))).status, 400, next);
    }
    f.advance(61_000);
    assert.equal((await a.send(GENERAL_GUEST_START_PATH + '?audience=' + encodeURIComponent(ELSEWHERE))).status, 400);
    // Starting is limited per address, as the workbench's own guest grant is: each start has the service agent sign.
    f.advance(61_000);
    const answers: number[] = [];
    for (let i = 0; i < 7; i++) answers.push((await f.browser().send(GENERAL_GUEST_START_PATH)).status);
    assert.deepEqual(answers, [302, 302, 302, 302, 302, 429, 429]);
    // Behind the bridge's proxy every request arrives from the proxy's address. The limit is kept
    // per visitor by the forwarded header's last hop, so one visitor's starts do not shut out another.
    f.advance(61_000);
    const from = async (address: string) => (await f.browser().send(GENERAL_GUEST_START_PATH, { headers: { 'X-Forwarded-For': `203.0.113.9, ${address}` } })).status;
    const first: number[] = []; for (let i = 0; i < 6; i++) first.push(await from('198.51.100.7'));
    assert.deepEqual(first, [302, 302, 302, 302, 302, 429]);
    assert.equal(await from('198.51.100.8'), 302, 'another visitor behind the same proxy is not counted with the first');
  });

  it('lets nobody in whom identity does not vouch for, or whom this application\'s policy does not permit', async () => {
    // The application's own decision over what identity stated is default-deny: a policy set that permits nothing admits nobody.
    const denied = await fixture({ door: id => id.doorFor(BASE, SERVICE, { policies: { policies: [], predicates: new Map() } }) }), b = denied.browser();
    const visit = await b.arrive();
    assert.equal(visit.returned.status, 403); assert.equal(((await visit.returned.json()) as Row).error, 'learning_guest_refused');
    assert.equal((await b.status()).authenticated, false); assert.deepEqual([...b.jar.keys()], []);

    // Identity's answer must be this deployment's own, field by field, or there is no session.
    const wrong: Array<[string, GeneralGuestSession]> = [
      ['a registered owner id', stated({ userId: 'u-pk-aaaaaaaaaaaa', ownerDid: 'did:web:identity.example:users:u-pk-aaaaaaaaaaaa' })],
      ['a per-application guest id', stated({ userId: 'u-try-play-' + 'ab'.repeat(16) })],
      ['another authority\'s DID', stated({ ownerDid: `did:web:evil.example:users:${USER}` }, { subject: `did:web:evil.example:users:${USER}` })],
      ['someone else\'s pod', stated({ podUrl: POD + '/someone-else/' })],
      ['another WebID', stated({ webId: `${ISSUER}/users/u-pk-aaaaaaaaaaaa/profile#me` })],
      ['another authority\'s agent', stated({ agentDid: 'did:web:evil.example:agents:x' })],
      ['a deadline already passed', stated({ guestExpiresAt: Date.now() - 1000 })],
      ['attributes about someone else', stated({}, { subject: 'did:web:identity.example:users:u-pk-aaaaaaaaaaaa' })],
      ['a link to itself', stated({}, { linkedTo: `did:web:identity.example:users:${USER}` })],
      ['a link to another authority\'s account', stated({}, { linkedTo: 'did:web:evil.example:users:u-pk-aaaaaaaaaaaa' })],
      ['a link to something that is not an account', stated({}, { linkedTo: 'did:web:identity.example:agents:some-agent' })],
    ];
    for (const [what, answer] of wrong) {
      const f = await fixture({ door: () => scriptedDoor(() => answer) }), c = f.browser();
      assert.equal((await c.send(GENERAL_GUEST_START_PATH)).status, 302);
      const returned = await c.send(scriptedReturn);
      assert.equal(returned.status, 401, what); assert.equal(((await returned.json()) as Row).error, 'learning_account_invalid', what);
      assert.equal((await c.status()).authenticated, false, what); assert.deepEqual([...c.jar.keys()], [], what);
    }
    // Identity unreachable is a 503 and no session; a door that cannot be signed for sends nobody anywhere.
    const down = await fixture({ door: () => scriptedDoor(() => { throw Object.assign(new Error('guest_door_unavailable'), { status: 503, code: 'guest_door_unavailable' }); }) }), d = down.browser();
    await d.send(GENERAL_GUEST_START_PATH);
    assert.equal((await d.send(scriptedReturn)).status, 503); assert.equal((await d.status()).authenticated, false);
    const unsigned = await fixture({ door: () => ({ ...scriptedDoor(() => stated()), start: async () => { throw Object.assign(new Error('guest_door_unavailable'), { status: 503 }); } }) });
    const none = await unsigned.browser().send(GENERAL_GUEST_START_PATH);
    assert.equal(none.status, 503); assert.equal(none.headers.get('location'), null); assert.deepEqual(none.headers.getSetCookie(), []);
  });

  it('bounds an unlinked guest\'s session by the guest\'s own deadline and by one hour, whichever is sooner', async () => {
    const soon = (Math.floor(Date.now() / 1000) + 300) * 1000;
    const short = await fixture({ door: () => scriptedDoor(() => stated({ guestExpiresAt: soon }, { standingUntil: soon / 1000 })) }), b = short.browser();
    await b.send(GENERAL_GUEST_START_PATH); assert.equal((await b.send(scriptedReturn)).status, 303);
    assert.equal(Date.parse(String((await b.status()).expires_at)), soon, 'never later than identity\'s guestExpiresAt');
    short.advance(soon - Date.now() + 1000);
    assert.equal((await b.status()).authenticated, false);

    const f = await fixture(), c = f.browser(); await c.arrive();
    f.advance(3_599_000); assert.equal((await c.status()).authenticated, true);
    f.advance(2_000); assert.equal((await c.status()).authenticated, false, 'one hour, as for the workbench\'s own guest');
    assert.equal((await c.call(API, { operation: 'my-links' })).status, 401, 'a session that ended acts for nobody');
  });

  it('has a guest learner\'s operations and nothing an owner, an administrator or another subject has', async () => {
    const f = await fixture(), b = f.browser(); await b.arrive();
    for (const operation of GUEST_LEARNING_OPERATIONS) assert.notEqual((await b.call(API, { operation })).body.error, 'learning_guest_refused', operation);
    const before = JSON.stringify(f.state());
    for (const operation of ['create-connector', 'owned-connectors', 'owned-courses', 'pending-links', 'approve-link', 'revoke-connector', 'set-review-policy', 'set-notification-policy',
      'set-targeted-launch-policy', 'save-course-map', 'get-course-map', 'delete-course-map', 'preview-course-map', 'prepare-lti', 'install-lti', 'remove-lti',
      'enable-progress-notifications', 'disable-progress-notifications', 'progress-notification-status', 'not-an-operation']) {
      const result = await b.call(API, { operation, connector_id: 'c', link_id: 'l', label: 'x' });
      assert.equal(result.status, 403, operation); assert.equal(result.body.error, 'learning_guest_refused', operation);
    }
    assert.equal((await b.call(API, {})).status, 403);
    assert.equal(JSON.stringify(f.state()), before, 'a refused operation writes nothing');
    const context = await b.call(API + '/context', { link_id: 'missing' });
    assert.equal(context.status, 403); assert.equal(context.body.error, 'learning_guest_refused');
    // The course player's owner-only link is refused, and a launch is recorded as the guest itself.
    assert.equal((await b.call('/learn/link', { attestation: 'x', challenge: 'y', proof: 'z' })).status, 409);
    const launched = await b.call('/learn/launch', { course_id: COURSE, tracking_consent: true });
    assert.equal(launched.status, 200); assert.equal(launched.body.guest, true);
    assert.equal(((launched.body.actor as Row).account as Row).name, guestDidOf(b.key));

    // Another subject's records are not this guest's: a link belongs to whoever asked for it.
    const owner = f.registered('u-eth-c0ac4ed0aaaa');
    const connector = (await f.records.request(owner, { operation: 'create-connector', label: 'A fictional connection', credentials: { app_id: 'fictional-app', secret: 'fictional-secret-value' },
      policy: { allowAiContent: true, allowAiProgress: true }, intent: 'authorize-enrolled-learners', request_id: 'fixture-create-1' })).connector as Row;
    const other = f.browser(); f.advance(61_000); await other.arrive();
    const asked = await other.call(API, { operation: 'request-link', join_code: connector.join_code });
    assert.equal(asked.status, 200);
    const theirs = (asked.body.link as Row).id as string;
    assert.equal(((await other.call(API, { operation: 'my-links' })).body.links as Row[]).length, 1);
    assert.deepEqual((await b.call(API, { operation: 'my-links' })).body.links, []);
    const taken = await b.call(API, { operation: 'revoke-link', link_id: theirs });
    assert.notEqual(taken.status, 200);
    assert.equal(((await other.call(API, { operation: 'my-links' })).body.links as Row[])[0]!.status, 'pending-admin', 'the other guest\'s link is untouched');

    // The bridge's administrator gate reads a caller the tenant directory resolved. A general guest
    // is never one: there is no caller for it, and what identity states about it satisfies no admin policy.
    assert.equal(mayAdministerTenant(null, { point: 'general-guest-test' }), false);
    assert.equal(mayAdministerTenant(null, { point: 'general-guest-test', mode: 'enforce' }), false);
    for (const facts of [stated().attributes, stated({}, { linkedTo: 'did:web:identity.example:users:u-eth-c0ac4ed0aaaa' }).attributes, stated({}, { claimed: true }).attributes]) {
      assert.equal(decide(TENANT_ADMIN_ACTION, TENANT_ADMIN_POLICIES, subjectAttributeGraph(facts)).allowed, false);
    }
  });

  it('makes a guest linked to an account that account, for ten minutes at a time, and itself again once unlinked', async () => {
    const f = await fixture(), laptop = f.browser(), plain = f.browser();
    // A guest exists once a browser has been through the door; only then can it be linked.
    await laptop.arrive(); await plain.arrive();
    assert.equal(((await laptop.status()).account as Row).id, guestDidOf(laptop.key));
    const ownerId = f.id.account('u-eth-c0ac4ed00002', 'Fictional Account Two'), ownerDid = `did:web:identity.example:users:${ownerId}`;
    // What the account already has here, from its own sign-in: a link to a connection.
    const admin = f.registered('u-eth-c0ac4ed0bbbb');
    const connector = (await f.records.request(admin, { operation: 'create-connector', label: 'A fictional connection', credentials: { app_id: 'fictional-app', secret: 'fictional-secret-value' },
      policy: { allowAiContent: true, allowAiProgress: true }, intent: 'authorize-enrolled-learners', request_id: 'fixture-create-2' })).connector as Row;
    await f.records.request(f.registered(ownerId), { operation: 'request-link', join_code: connector.join_code });
    // Linking changes nothing for a session already made: it was the guest's, and stays so.
    assert.equal(await f.id.linkGuest(laptop.key, ownerId), ownerDid);
    assert.equal(((await laptop.status()).account as Row).id, guestDidOf(laptop.key));
    assert.deepEqual((await laptop.call(API, { operation: 'my-links' })).body.links, []);

    // From its next visit through the door, the guest is the account.
    f.advance(61_000);
    assert.equal((await laptop.arrive()).returned.status, 303);
    const linked = await laptop.status();
    assert.deepEqual(linked.account, { id: ownerDid, userId: ownerId, webId: `${ISSUER}/users/${ownerId}/profile#me` });
    assert.equal(linked.guest, true, 'still a guest learner: the account\'s name, not an owner\'s permissions');
    assert.equal(linked.general_guest, true); assert.equal(linked.linked_account, true);
    const linkedLife = Date.parse(String(linked.expires_at)) - f.now();
    assert.ok(linkedLife <= LINKED_GUEST_SESSION_MS && linkedLife > LINKED_GUEST_SESSION_MS - 10_000, 'ten minutes, not the unlinked guest\'s hour');
    assert.equal(((await laptop.call(API, { operation: 'my-links' })).body.links as Row[]).length, 1, 'the account\'s own link');
    assert.equal((await laptop.call(API, { operation: 'owned-connectors' })).body.error, 'learning_guest_refused');
    assert.equal((await laptop.call(API + '/context', { link_id: 'missing' })).status, 403);
    const launched = await laptop.call('/learn/launch', { course_id: COURSE, tracking_consent: true });
    assert.equal(((launched.body.actor as Row).account as Row).name, ownerDid, 'usage is attributed to the account');
    // A guest nobody linked is not that account.
    assert.equal(((await plain.status()).account as Row).id, guestDidOf(plain.key));
    assert.deepEqual((await plain.call(API, { operation: 'my-links' })).body.links, []);

    // The owner unlinks. The workbench is not told; the session it gave is the account's until its bound, and not after.
    await f.id.unlinkGuest(laptop.key, ownerId);
    f.advance(LINKED_GUEST_SESSION_MS - 20_000);
    assert.equal(((await laptop.status()).account as Row).id, ownerDid);
    f.advance(21_000);
    assert.equal((await laptop.status()).authenticated, false);
    assert.equal((await laptop.call(API, { operation: 'my-links' })).status, 401);
    // Back through the door, identity states no link, and the guest is itself.
    const after = await laptop.arrive(); assert.equal(after.returned.status, 303);
    const itself = await laptop.status();
    assert.equal((itself.account as Row).id, guestDidOf(laptop.key)); assert.equal(itself.linked_account, undefined);
    assert.deepEqual((await laptop.call(API, { operation: 'my-links' })).body.links, []);
    // The unlinked guest's own session was never ended by the linked bound.
    assert.equal(((await plain.status()).account as Row).id, guestDidOf(plain.key));
    for (const location of f.locations.filter(l => !l.startsWith(ISSUER + '/guest/door#'))) assert.doesNotMatch(location, SECRET, location);
    assert.deepEqual(f.outbound, []);
  });
});
