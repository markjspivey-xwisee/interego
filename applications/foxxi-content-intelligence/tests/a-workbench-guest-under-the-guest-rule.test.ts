/**
 * The learner workbench's general guest, with the dashboard's guest rule on and off.
 *
 * WHY. FOXXI_PLAY_GENERAL_GUEST=1 switches on a rule in the bridge's ONE pod resolver
 * (`resolveSubjectPodUrl` in bridge/server.ts, `resolveSubjectPodUrlGuarded` in
 * src/subject-pod-url.ts): a general guest's DID resolves to the guest's OWN pod, or the resolver
 * throws. That resolver is called at some sixty places, and the learner workbench's general guest
 * (FOXXI_I2IDLX_GENERAL_GUEST, a separate switch that is already on) reaches several of them with
 * its DID: every statement its course posts is asked whose it is, and every void is kept with its
 * owner. With the rule off those places answered the SHARED TENANT POD for a guest.
 *
 * What these tests hold:
 *
 *   - rule off: every place answers exactly what it did before the rule existed;
 *   - rule on, a guest of this deployment's identity: its own pod, which is where the course
 *     player already keeps that guest's statements (its own lens), so the two now agree;
 *   - rule on, a guest of some OTHER identity (a name anyone can put in a statement): nobody's
 *     here. The request that named it still succeeds. Wired the old way the LRS answered it as a
 *     refusal AFTER the statement was stored, which the last flow test reproduces;
 *   - every call of the resolver in bridge/server.ts has been looked at and is listed below, so a
 *     new one is classified on purpose.
 *
 * Identity is the real provider run in process, the door page is played by a generated key, and
 * the LRS and the course player are the bridge's own modules. Every name is fictional.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { IRI } from '@interego/core';
import { attachLearningRoutes } from '../src/i2idlx-learning-routes.js';
import { GENERAL_GUEST_RETURN_PATH, GENERAL_GUEST_START_PATH } from '../src/i2idlx-learning-auth.js';
import { emptyLearningState, type LearningRepository, type LearningSnapshot } from '../src/i2idlx-learning-connections.js';
import { attachCoursePlayerRoutes, learnerFromPlayerAuth } from '../src/cmi5-player.js';
import { registerCmi5Course } from '../src/cmi5-lms.js';
import { attachXapiLrsRoutes } from '../src/xapi-lrs.js';
import { actorForPod } from '../src/mesh-event-projector.js';
import { ownerDidOf } from '../src/applied-voids.js';
import { sendServerError } from '../src/http-errors.js';
import { DEFAULT_TENANT, type TenantId } from '../src/tenant-context.js';
import {
  SubjectPodRefusedError, namedSubjectPodUrlGuarded, resolveSubjectPodUrlGuarded, resolveSubjectPodUrlPure, statementOwnerPod,
} from '../src/subject-pod-url.js';
import { ISSUER, identity, newKey } from '../../_shared/tests/general-guest-identity.js';
import { generalGuestUserId, playKeyThumbprint, publicPlayKey } from '../../../deploy/identity/provisional-play.js';

type Row = Record<string, unknown>;
const BASE = 'https://workbench.example', POD = 'https://pods.example', TENANT = POD + '/foxxi/';
const HOST = 'identity.example';
const SERVICE = { agentDid: 'did:web:identity.example:agents:learn-service', podUrl: POD + '/learn/' };
const COURSE = 'https://workbench.example/tide-pools';
const safeUrl = (raw: string): string | undefined => (raw.startsWith('https://') ? raw : undefined);
const lens = (podUrl: string): TenantId => ('lens:' + actorForPod(podUrl)) as TenantId;
/** A guest some OTHER identity service admitted: the shape of a general guest, under a host that is not ours. */
const FOREIGN_GUEST = 'did:web:identity.elsewhere.example:users:u-try-guest-' + 'c'.repeat(32);
/** The switch: the identity host the resolver is given for guest DIDs, or nothing (bridge/server.ts `guestIdentityHost`). */
const ruleFor = (on: boolean): string | undefined => (on ? HOST : undefined);

/** `resolveSubjectPodUrl` and `namedSubjectPodUrl` as bridge/server.ts builds them. */
const resolvers = (on: boolean) => ({
  resolve: (id: string | undefined, explicit?: string): string => resolveSubjectPodUrlGuarded({ tenantPodUrl: TENANT, identity: id, explicit, safeUrl, guestIdentityHost: ruleFor(on) }),
  named: (id: string | undefined): string | undefined => namedSubjectPodUrlGuarded({ tenantPodUrl: TENANT, identity: id, safeUrl, guestIdentityHost: ruleFor(on) }),
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

/**
 * The workbench, its course player and the LRS, wired as bridge/server.ts wires them: the player's
 * tenant from the learner's pod, the statement's owner through `statementOwnerPod`, and an applied
 * void kept with its owner as `keepAppliedVoid` decides. `oldWiring` asks the throwing resolver at
 * the statement's owner, as the bridge did before.
 */
async function workbench(on: boolean, oldWiring = false) {
  const { resolve, named } = resolvers(on);
  const id = identity({ [BASE]: { ...SERVICE, returnPath: GENERAL_GUEST_RETURN_PATH } });
  let snapshot: LearningSnapshot = { revision: null, state: emptyLearningState() }, serial = 0;
  const repository: LearningRepository = {
    async read() { return structuredClone(snapshot); },
    async write(_expected, state) { snapshot = { revision: String(++serial), state: structuredClone(state) }; },
  };
  const app = express(); app.set('trust proxy', false); app.use(express.json());
  const learning = attachLearningRoutes(app, { baseUrl: BASE, relayOrigin: 'https://relay.example', identityOrigin: ISSUER, podOrigin: POD, repository,
    fetch: (async () => { throw new Error('a general guest session calls no one'); }) as typeof fetch,
    sessions: {} as never, taskConfig: { baseUrl: BASE, appDataFile: '', checkOperations: {} } as never,
    guestGrant: async () => { throw new Error('unused'); }, generalGuest: id.doorFor(BASE, SERVICE) });
  const structure = [{ kind: 'au' as const, id: COURSE + '/au', title: 'One', url: COURSE + '/au.html', moveOn: 'Completed' as const }];
  registerCmi5Course(DEFAULT_TENANT, { id: COURSE, title: 'Tide pools', structure });

  /** What each wired place answered, in order. */
  const seen = { launchTenants: [] as TenantId[], learnerPods: [] as string[], owners: [] as Array<{ name: unknown; tenant: TenantId | null }>, voidHomes: [] as Array<{ did: string; pod: string | null }> };
  attachCoursePlayerRoutes(app, {
    baseUrl: BASE, authoritativeSource: 'did:web:workbench.example', book: undefined,
    requireLearner: req => learnerFromPlayerAuth(learning.auth, req),
    verifyGuest: async () => { throw new Error('unused'); },
    resolveCourse: async courseId => courseId === COURSE ? { id: COURSE, title: 'Tide pools', structure } : null,
    // bridge/server.ts: tenantFor: (learner) => lensTenantFor(actorForPod(learner.podUrl, MESH_ACTOR_LABELS))
    tenantFor: learner => lens(learner.podUrl),
    satisfied: () => [],
    stageLaunch: async tenant => { seen.launchTenants.push(tenant); },
    recordLaunched: async (_tenant, _statement, learner) => { seen.learnerPods.push(learner.podUrl); },
    forgetActor: async () => 0,
  });
  /** The AU's credential: bound to the tenant its launch was staged in, as a cmi5 bearer is. */
  const bearers = new Map<string, TenantId>();
  attachXapiLrsRoutes(app, {
    podUrl: '', tenantDid: 'did:web:workbench.example' as IRI, basicAuthPairs: '', forwardingTargets: '', selfBaseUrl: BASE,
    bearerTenantResolver: token => bearers.get(token) ?? null,
    ownerTenantOfStatement: stmt => {
      const name = (stmt?.['actor'] as { account?: { name?: unknown } } | undefined)?.account?.name;
      if (oldWiring) {
        // What bridge/server.ts did: the throwing resolver, asked about a name it was merely given.
        if (typeof name !== 'string' || !name || !/^did:(ethr|web|key):/.test(name)) return null;
        return lens(resolve(name));
      }
      const pod = statementOwnerPod(stmt, named);
      const tenant = pod === null ? null : lens(pod);
      seen.owners.push({ name, tenant });
      return tenant;
    },
    // keepAppliedVoid: the owner's pod through the named resolver; nothing is kept where there is none on this store.
    onVoidApplied: target => {
      const did = ownerDidOf(target.statement);
      if (!did) return;
      const pod = named(did);
      seen.voidHomes.push({ did, pod: pod === undefined || new URL(pod).origin !== POD ? null : pod });
    },
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no address');
  const local = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { learning.auth.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });

  /** One browser: out through identity's door and back, as a general guest of the workbench. */
  async function guest() {
    const key = newKey(), jar = new Map<string, string>();
    const send = async (pathAndQuery: string, init: RequestInit = {}): Promise<Response> => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await fetch(local + pathAndQuery, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), ...(cookie ? { Cookie: cookie } : {}) } });
      for (const set of response.headers.getSetCookie()) {
        const [pair] = set.split(';'), at = pair!.indexOf('='), name = pair!.slice(0, at), value = pair!.slice(at + 1);
        if (value) jar.set(name, value); else jar.delete(name);
      }
      return response;
    };
    const started = await send(GENERAL_GUEST_START_PATH);
    const back = await id.page(key, started.headers.get('location')!);
    expect((await send(back.pathname + back.search)).status).toBe(303);
    const userId = generalGuestUserId(playKeyThumbprint(publicPlayKey(key.publicKey.export({ format: 'jwk' }))));
    const did = `did:web:${HOST}:users:${userId}`, podUrl = `${POD}/${userId}/`;
    const call = async (path: string, body: Row) => {
      const csrf = String(((await (await send('/i2idlx/learning/session')).json()) as Row)['csrf']);
      const response = await send(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, 'X-I2IDLX-Learning-CSRF': csrf }, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as Row };
    };
    /** Launch the course, and hand back what the AU would hold: its actor and a credential bound to the launch's tenant. */
    const launch = async () => {
      const launched = await call('/learn/launch', { course_id: COURSE, tracking_consent: true });
      expect(launched.status).toBe(200);
      const tenant = seen.launchTenants.at(-1)!, token = 'au-' + randomUUID();
      bearers.set(token, tenant);
      return { actor: launched.body['actor'] as Row, tenant, token };
    };
    return { userId, did, podUrl, launch };
  }
  const xapi = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Experience-API-Version': '2.0.0', 'Content-Type': 'application/json' });
  const post = (token: string, body: unknown) => fetch(`${local}/xapi/statements`, { method: 'POST', headers: xapi(token), body: JSON.stringify(body) });
  const stored = async (token: string, statementId: string) => (await fetch(`${local}/xapi/statements?statementId=${statementId}`, { headers: xapi(token) })).status;
  return { guest, post, stored, seen };
}
const experienced = (actor: unknown, extra: Row = {}): Row & { id: string } => ({
  id: randomUUID(), actor, verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' }, object: { objectType: 'Activity', id: COURSE + '/au' }, ...extra,
});
const account = (name: string): Row => ({ objectType: 'Agent', account: { homePage: 'did:web:workbench.example', name } });

describe('the workbench general guest plays a course, with the guest rule off', () => {
  it('everything answers as it did before the rule existed: the guest\'s statements are the tenant pod\'s to forward, its voids the tenant pod\'s to keep', async () => {
    const w = await workbench(false), g = await w.guest();
    const { actor, tenant, token } = await g.launch();
    // The player has always kept this guest in its own lens, on its own pod.
    expect((actor['account'] as Row)['name']).toBe(g.did);
    expect(tenant).toBe(`lens:${g.userId}`);
    expect(w.seen.learnerPods).toEqual([g.podUrl]);
    const s = experienced(actor);
    expect((await post(w, token, s)).status).toBe(200);
    expect(w.seen.owners.at(-1)).toEqual({ name: g.did, tenant: 'lens:foxxi' });
    const v = { id: randomUUID(), actor, verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: s.id } };
    expect((await post(w, token, v)).status).toBe(200);
    expect(w.seen.voidHomes).toEqual([{ did: g.did, pod: TENANT }]);
    // Another identity's guest, named in a statement: the tenant pod too, and no refusal anywhere.
    expect((await post(w, token, experienced(account(FOREIGN_GUEST)))).status).toBe(200);
    expect(w.seen.owners.at(-1)).toEqual({ name: FOREIGN_GUEST, tenant: 'lens:foxxi' });
  });

  it('the old wiring and the new one answer the same: with the rule off the named resolver IS the resolver', async () => {
    const { resolve, named } = resolvers(false);
    const guest = `did:web:${HOST}:users:u-try-guest-${'ab'.repeat(16)}`;
    for (const identityGiven of [guest, FOREIGN_GUEST, guest.toUpperCase(), 'did:ethr:0x3333333333cc00000000000000000000000beef3', `did:web:${HOST}:users:u-try-play-${'cd'.repeat(16)}`,
      `did:web:${HOST}:users:u-eth-0123456789ab`, 'https://pods.example/someone/profile/card#me', 'a generic upstream account name', '', undefined]) {
      const before = resolveSubjectPodUrlPure({ tenantPodUrl: TENANT, identity: identityGiven, safeUrl });
      expect(resolve(identityGiven), String(identityGiven)).toBe(before);
      expect(named(identityGiven), String(identityGiven)).toBe(before);
    }
    // A guest's DID was the tenant pod's, which is what the rule exists to end.
    expect(resolve(guest)).toBe(TENANT);
    expect(resolve(FOREIGN_GUEST)).toBe(TENANT);
  });
});

describe('the workbench general guest plays a course, with the guest rule on', () => {
  it('the same flow succeeds, and the guest\'s statements and voids are its OWN pod\'s: where the player already keeps them', async () => {
    const w = await workbench(true), g = await w.guest();
    const { actor, tenant, token } = await g.launch();
    expect((actor['account'] as Row)['name']).toBe(g.did);
    expect(tenant).toBe(`lens:${g.userId}`);
    expect(w.seen.learnerPods).toEqual([g.podUrl]);
    const s = experienced(actor);
    expect((await post(w, token, s)).status).toBe(200);
    // The statement's owner is now the lens the launch was staged in, not the shared tenant pod's.
    expect(w.seen.owners.at(-1)).toEqual({ name: g.did, tenant });
    const v = { id: randomUUID(), actor, verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: s.id } };
    expect((await post(w, token, v)).status).toBe(200);
    expect(w.seen.voidHomes).toEqual([{ did: g.did, pod: g.podUrl }]);
    expect(JSON.stringify(w.seen)).not.toContain('lens:foxxi');
  });

  it('two guests are two owners: neither\'s statements are the other\'s or the tenant pod\'s', async () => {
    const w = await workbench(true), a = await w.guest(), b = await w.guest();
    const la = await a.launch(), lb = await b.launch();
    expect((await post(w, la.token, experienced(la.actor))).status).toBe(200);
    expect((await post(w, lb.token, experienced(lb.actor))).status).toBe(200);
    expect(w.seen.owners.map(o => o.tenant)).toEqual([`lens:${a.userId}`, `lens:${b.userId}`]);
    expect(a.userId).not.toBe(b.userId);
  });

  it('another identity\'s guest named in a statement is nobody\'s here: the statement is still taken, and is the caller\'s tenant\'s', async () => {
    const w = await workbench(true), g = await w.guest();
    const { token } = await g.launch();
    for (const name of [FOREIGN_GUEST, `did:web:${HOST}:users:U-TRY-GUEST-${'AB'.repeat(16)}`, `did:web:${HOST}%3A8443:users:u-try-guest-${'ab'.repeat(16)}`]) {
      const s = experienced(account(name));
      const response = await post(w, token, s);
      expect(response.status, name).toBe(200);
      expect(await response.json()).toEqual([s.id]);
      expect(w.seen.owners.at(-1), name).toEqual({ name, tenant: null });
    }
    // A void of such a statement is voided in the lens alone: there is no pod here to keep it on.
    const s = experienced(account(FOREIGN_GUEST));
    await post(w, token, s);
    const v = { id: randomUUID(), actor: account(FOREIGN_GUEST), verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: s.id } };
    expect((await post(w, token, v)).status).toBe(200);
    expect(w.seen.voidHomes).toEqual([{ did: FOREIGN_GUEST, pod: null }]);
  });

  it('wired the old way, that same statement was stored and then answered as an error', async () => {
    const w = await workbench(true, true), g = await w.guest();
    const { actor, token } = await g.launch();
    // The guest's own statements were fine either way.
    expect((await post(w, token, experienced(actor))).status).toBe(200);
    const s = experienced(account(FOREIGN_GUEST));
    const response = await post(w, token, s);
    // The resolver's refusal reached the LRS's own error answer: the client is told its statement
    // was refused, and the store holds it.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await w.stored(token, s.id)).toBe(200);
  });

  it('every other identity is answered exactly as with the rule off', () => {
    const on = resolvers(true), off = resolvers(false);
    for (const identityGiven of ['did:ethr:0x3333333333cc00000000000000000000000beef3', `did:web:${HOST}:users:u-try-play-${'cd'.repeat(16)}`, `did:web:${HOST}:users:u-eth-0123456789ab`,
      `did:web:${HOST}:agents:helper-u-pk-0123456789ab`, 'https://pods.example/someone/profile/card#me', 'a generic upstream account name', '', undefined]) {
      expect(on.resolve(identityGiven), String(identityGiven)).toBe(off.resolve(identityGiven));
      expect(on.named(identityGiven), String(identityGiven)).toBe(off.named(identityGiven));
    }
  });
});

const post = (w: Awaited<ReturnType<typeof workbench>>, token: string, body: unknown): Promise<Response> => w.post(token, body);

describe('a name the bridge was given, and a caller acting as a guest', () => {
  const guest = `did:web:${HOST}:users:u-try-guest-${'ab'.repeat(16)}`;

  it('the throwing resolver still throws for a guest it would put on the tenant pod; the named one answers nothing', () => {
    const { resolve, named } = resolvers(true);
    expect(resolve(guest)).toBe(`${POD}/u-try-guest-${'ab'.repeat(16)}/`);
    expect(named(guest)).toBe(`${POD}/u-try-guest-${'ab'.repeat(16)}/`);
    for (const refused of [FOREIGN_GUEST, guest.replace('u-try-guest-', 'U-TRY-GUEST-')]) {
      expect(() => resolve(refused), refused).toThrow(SubjectPodRefusedError);
      expect(named(refused), refused).toBeUndefined();
    }
    // An explicit pod cannot move a guest: still a throw, where the caller is acting AS the guest.
    expect(() => resolve(guest, TENANT)).toThrow(SubjectPodRefusedError);
  });

  it('only the guest rule\'s refusal is swallowed: any other failure of the resolver still throws', () => {
    const broken = (): string | undefined => { throw new Error('the SSRF guard is unavailable'); };
    expect(() => namedSubjectPodUrlGuarded({ tenantPodUrl: TENANT, identity: guest, explicit: 'https://pods.example/x/', safeUrl: broken, guestIdentityHost: HOST })).toThrow('the SSRF guard is unavailable');
  });

  it('a statement\'s owner: only a recognizable identity has one, and a refused guest has none', () => {
    const { named } = resolvers(true);
    const owner = (name: unknown): string | null => statementOwnerPod({ actor: { account: { name } } }, named);
    expect(owner(guest)).toBe(`${POD}/u-try-guest-${'ab'.repeat(16)}/`);
    expect(owner(FOREIGN_GUEST)).toBeNull();
    const wallet = 'did:ethr:0x3333333333cc00000000000000000000000beef3';
    expect(owner(wallet)).toBe(resolveSubjectPodUrlPure({ tenantPodUrl: TENANT, identity: wallet, safeUrl }));
    expect(owner(wallet)).not.toBe(TENANT);
    for (const none of ['a generic upstream account name', '', undefined, 7, null]) expect(owner(none), String(none)).toBeNull();
    expect(statementOwnerPod(undefined, named)).toBeNull();
    expect(statementOwnerPod({ actor: { mbox: 'mailto:reader@example.org' } }, named)).toBeNull();
    // An empty answer from the resolver is an answer (a bridge with no tenant pod), not a refusal.
    expect(statementOwnerPod({ actor: { account: { name: guest } } }, () => '')).toBe('');
  });

  it('a route that still meets the refusal answers 403 with its reason, not a 500', () => {
    const answered: Array<{ status: number; body: unknown }> = [];
    const res = { status: (status: number) => ({ json: (body: unknown) => { answered.push({ status, body }); } }) };
    let refusal: unknown;
    try { resolvers(true).resolve(FOREIGN_GUEST); } catch (error) { refusal = error; }
    sendServerError(res, refusal, 'test');
    expect(answered).toEqual([{ status: 403, body: { ok: false, error: 'subject_pod_refused', reason: 'shared-tenant-pod' } }]);
  });
});

describe('every call of the pod resolver in bridge/server.ts is one somebody decided about', () => {
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'server.ts'), 'utf8');
  /** Each line of code (not a comment) that calls a resolver, less the three definitions. */
  const calls = server.split('\n').map(line => line.trim())
    .filter(line => /\b(?:resolveSubjectPodUrl|namedSubjectPodUrl|selfBoundPod)\(/.test(line) && !/^(?:\/\/|\/?\*)/.test(line) && !/^function (?:resolveSubjectPodUrl|namedSubjectPodUrl|selfBoundPod)\(/.test(line));

  /**
   * What the identity at each call is, and so what the guest rule does there.
   *
   *   caller   a signed caller the one caller decision admitted (`decideCallerPrincipal` refuses a
   *            general guest's DID before any pod is derived), or a did:ethr built from a wallet
   *            address. Never a guest's DID: the rule is not reached.
   *   own-pod  `privatePerformancePod`: an identity with no pod segment of its own is refused
   *            before the resolver is asked, as a guest always was.
   *   named    an identity someone else named, asked through `namedSubjectPodUrl`: this
   *            deployment's guest resolves to its own pod; a refused one is treated as having no
   *            pod here, and the request goes on.
   *   refuses  an identity a request names, inside a route or a tool that answers its own
   *            failures: this deployment's guest resolves to its own pod; a refused one ends the
   *            request with 403 (`sendServerError`) or as the tool's own refusal, never a 500.
   *   guest    the dashboard guest's own door: the rule is what it is there for.
   */
  type Kind = 'caller' | 'own-pod' | 'named' | 'refuses' | 'guest';
  const DECIDED: ReadonlyArray<readonly [string, Kind, number?]> = [
    ['const pod = selfBoundPod(callerDid, explicit);', 'caller'],
    ['const derived = resolveSubjectPodUrl(callerDid);', 'caller'],
    ['const override = resolveSubjectPodUrl(callerDid, explicit);', 'caller'],
    ['podFor: (agentId) => resolveSubjectPodUrl(agentId),', 'caller'],
    ['Use the pod your own wallet is named for: ${resolveSubjectPodUrl(`did:ethr:${wallet}`)}', 'caller'],
    ['podOfWallet: (address) => resolveSubjectPodUrl(`did:ethr:${address}`),', 'caller'],
    ['const callerPodUrl = selfBoundPod(opts.callerDid, opts.stampedPodUrl);', 'caller'],
    ['subjectPodUrl: subjectIdentity ? resolveSubjectPodUrl(subjectIdentity) : callerPodUrl,', 'refuses'],
    ['for (const at of [...new Set([resolveSubjectPodUrl(authorDid), pod])]) {', 'caller'],
    ['const learnerPodUrl = resolveSubjectPodUrl(requestedLearnerDid, args.learner_pod_url as string | undefined);', 'refuses'],
    ['const perfPod = resolveSubjectPodUrl(performerDid, perfPodOverride);', 'refuses'],
    ['learnerPodUrl: selfBoundPod(requestedLearnerDid, (args.learner_pod_url as string) || undefined),', 'refuses'],
    ['const provePod = selfBoundPod(learnerDid, (args.subject_pod_url ?? args.learner_pod_url) as string | undefined);', 'refuses'],
    ['const subjectPodUrl = resolveSubjectPodUrl(subjectDid);', 'refuses'],
    ['const recipientPod = selfBoundPod(recipientDid, typeof p.recipient_pod_url === \'string\' ? p.recipient_pod_url : undefined);', 'refuses'],
    ['const callerOwnPod = resolveSubjectPodUrl(callerDid);', 'caller'],
    ['const issuerPod = resolveSubjectPodUrl(callerDid);', 'caller'],
    ['const verifierPod = resolveSubjectPodUrl(auth.callerDid);', 'caller'],
    // Twice: `privatePerformancePod` (own-pod), and a public course read for a STORED author (a signed caller's DID).
    ['const pod = resolveSubjectPodUrl(owner);', 'own-pod', 2],
    ['const pod = selfBoundPod(callerDid, typeof p.subject_pod_url === \'string\' ? p.subject_pod_url : undefined);', 'caller'],
    ['const subjectPod = selfBoundPod(callerDid, typeof p.subject_pod_url === \'string\' ? p.subject_pod_url : undefined);', 'caller', 4],
    ['const coursePod = (rawCoursePod && safePublicUrlOrUndefined(rawCoursePod)) || resolveSubjectPodUrl(authorDid);', 'refuses'],
    ['const podU = /^https?:\\/\\//.test(x) ? x : resolveSubjectPodUrl(x);', 'refuses'],
    ['const authorPod = selfBoundPod(callerDid, podArg);', 'caller'],
    ['const ownerPod = resolveSubjectPodUrl(callerDid);', 'caller', 2],
    ['const podUrl = resolveSubjectPodUrl(actor); const label = actorForPod(podUrl, MESH_ACTOR_LABELS);', 'refuses'],
    ['? selfBoundPod(bound.callerDid, typeof bound.payload.subject_pod_url === \'string\' ? bound.payload.subject_pod_url : undefined)', 'caller'],
    [': resolveSubjectPodUrl(bound.callerDid);', 'caller'],
    ['const actorPod = resolveSubjectPodUrl(args.actorDid);', 'caller'],
    ['const pod = namedSubjectPodUrl(did);', 'named', 2],
    // The fallback is a signed launch's caller: this bridge's own LMS hands the play the learner's pod (`play.learnerPod`).
    ['const learnerPod = play.learnerPod ?? resolveSubjectPodUrl(play.learnerDid);', 'caller'],
    ['const podUrl = selfBoundPod(auth.callerDid);', 'caller', 2],
    ['vc = await readDelegationCredential(resolveSubjectPodUrl(auth.callerDid), auth.callerDid as IRI, { fetch: guardedFetchFn(globalThis.fetch) as never });', 'caller'],
    ['const vc = await readDelegationCredential(resolveSubjectPodUrl(auth.callerDid), auth.callerDid as IRI,', 'caller'],
    ['samePodPrincipal(resolveSubjectPodUrl(String(course.authoredBy)), learner.podUrl);', 'refuses'],
    // A STORED signed author, and only when the pod it was written to was not recorded.
    ['const pod = written || resolveSubjectPodUrl(did);', 'caller'],
    ['const authorPod = selfBoundPod(authorDid, typeof subjectPodUrl === \'string\' ? subjectPodUrl : undefined);', 'caller', 2],
    ['const pod = namedSubjectPodUrl(learnerDid);', 'named', 2],
    ['const pod = resolveSubjectPodUrl(auth.callerDid);', 'caller'],
    ['const statements = await learnerStatementsFor(resolveSubjectPodUrl(auth.callerDid), auth.callerDid);', 'caller'],
    ['const pod = resolveSubjectPodUrl(learnerDid);', 'caller'],
    ['podFor: guestDid => resolveSubjectPodUrl(guestDid),', 'guest'],
    ['const authorPod = selfBoundPod(auth.callerDid, typeof auth.payload.subject_pod_url === \'string\' ? auth.payload.subject_pod_url : undefined);', 'caller'],
    ['? resolveSubjectPodUrl(authorNamed)', 'refuses'],
    [': selfBoundPod(callerDid, typeof p.subject_pod_url === \'string\' ? p.subject_pod_url : undefined));', 'caller'],
  ];

  it('each call is on the list, as many times as it occurs, and nothing on the list is gone', () => {
    const unlisted = calls.filter(line => !DECIDED.some(([text]) => line.includes(text)));
    expect(unlisted).toEqual([]);
    for (const [text, , times = 1] of DECIDED) {
      expect(calls.filter(line => line.includes(text)).length, text).toBe(times);
    }
    // No call is counted under two entries, so the list accounts for every call exactly once.
    expect(DECIDED.reduce((sum, [, , times = 1]) => sum + times, 0)).toBe(calls.length);
    expect(calls.length).toBe(54);
  });

  it('the places a guest\'s own statements reach ask the named resolver, and the statement\'s owner is decided in src', () => {
    expect(server).toContain('const pod = statementOwnerPod(stmt, namedSubjectPodUrl);');
    expect(server).toContain('return pod === null ? null : lensTenantFor(actorForPod(pod, MESH_ACTOR_LABELS));');
    const keep = server.slice(server.indexOf('async function keepAppliedVoid('));
    expect(keep.slice(0, 800)).toContain('const pod = namedSubjectPodUrl(did);\n  if (pod === undefined) return;');
    // The throwing resolver is still the one a caller acting as a guest goes through.
    expect(server).toContain('return resolveSubjectPodUrlGuarded({ tenantPodUrl, identity: didOrWebId, explicit, safeUrl: safePublicUrlOrUndefined, guestIdentityHost });');
    expect(server.includes('resolveSubjectPodUrlPure(')).toBe(false);
  });
});
