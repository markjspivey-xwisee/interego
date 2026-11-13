/**
 * A personal cmi5 launch link: one unguessable URL per learner and course, opened as many times
 * as the learner needs. Each open mints a fresh fetch token and redirects to the AU. An open
 * session is resumed. terminated before moveOn keeps the registration and starts a new session.
 * Abandoned, waived, or terminated after moveOn starts a new registration.
 */
import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PersonalLinkAuthError, PersonalLaunchRegistry, attachPersonalLaunchRoutes, hashPersonalLaunchToken, mergePersonalLink, personalLinkState, readDurableRegistry,
  type PersonalLaunchLink, type PersonalLaunchRouteDeps,
} from '../src/cmi5-personal-link.js';
import { commitDurableRegistry } from '../src/revocable-registry.js';
import {
  buildCmi5Launch, cmi5BearerRegistration, findResumableLaunch, observeCmi5Statement, redeemFetchToken,
} from '../src/cmi5-lms.js';
import type { Cmi5Course } from '../src/cmi5-course.js';
import type { TenantId } from '../src/tenant-context.js';

const TENANT = 'lens:personal-launch' as TenantId;
const HOME = 'did:web:bridge.example';
const POD = 'https://pod.example/learners/one/';
const LEARNER = 'did:ethr:0x1111111111111111111111111111111111111111';
const OTHER = 'did:ethr:0x2222222222222222222222222222222222222222';
const DAY = 24 * 60 * 60 * 1000;
const V_PASSED = 'http://adlnet.gov/expapi/verbs/passed';
const V_TERMINATED = 'http://adlnet.gov/expapi/verbs/terminated';
const V_ABANDONED = 'https://w3id.org/xapi/adl/verbs/abandoned';
const V_WAIVED = 'https://w3id.org/xapi/adl/verbs/waived';
const SESSION = 'https://w3id.org/xapi/cmi5/context/extensions/sessionid';

const course: Cmi5Course = {
  id: 'urn:foxxi:course:personal', title: 'Personal course',
  structure: [
    { kind: 'au', id: 'https://au.example/1<script>', title: 'First', url: 'https://content.example/au/1', moveOn: 'CompletedOrPassed' },
    { kind: 'au', id: 'https://au.example/2', title: 'Second', url: 'https://content.example/au/2?already=1', moveOn: 'Passed', masteryScore: 0.8 },
  ],
};
const [first, second] = ['https://au.example/1<script>', 'https://au.example/2'];
const solo: Cmi5Course = {
  id: 'urn:foxxi:course:solo', title: 'One activity',
  structure: [{ kind: 'au', id: 'https://au.example/solo', title: 'Only', url: 'https://content.example/solo', moveOn: 'Passed', masteryScore: 0.5 }],
};

function unpacked(link: { link: PersonalLaunchLink; token: string } | { refused: string }): { link: PersonalLaunchLink; token: string } {
  if ('refused' in link) throw new Error(link.refused);
  return link;
}
function made(link: { link: PersonalLaunchLink; token: string } | { refused: string }): PersonalLaunchLink {
  return unpacked(link).link;
}

describe('the personal-link registry', () => {
  it('mints an unguessable token, stores only its hash, and knows live, revoked and expired', () => {
    const registry = new PersonalLaunchRegistry();
    const now = Date.parse('2026-11-13T00:00:00Z');
    const minted = unpacked(registry.create({ actorDid: LEARNER, courseId: course.id, learnerPod: POD, mintedBy: LEARNER, expiresAt: '2026-11-14T00:00:00.000Z' }, now));
    expect(minted.token).toMatch(/^pl-[A-Za-z0-9_-]{43}$/);
    expect(minted.link.id).toMatch(/^[a-f0-9]{64}$/);
    expect(minted.link.id).toBe(hashPersonalLaunchToken(minted.token));
    expect(JSON.stringify(registry.toJSON())).not.toContain(minted.token);
    expect(registry.lookup(minted.token)?.id).toBe(minted.link.id);
    expect(personalLinkState(minted.link, now)).toBe('live');
    expect(personalLinkState(minted.link, Date.parse('2026-11-14T00:00:00Z'))).toBe('expired');
    registry.revoke(minted.link.id, now);
    expect(personalLinkState(minted.link, now)).toBe('revoked');
    registry.dirty = false;
    registry.noteOpen(minted.link.id, now);
    expect(minted.link.opens).toBe(1);
    expect(registry.dirty).toBe(false);
  });

  it('merges a durable copy: the earlier withdrawal and expiry, the larger open count, malformed entries skipped', () => {
    const registry = new PersonalLaunchRegistry();
    const link = made(registry.create({ actorDid: LEARNER, courseId: course.id, learnerPod: POD, mintedBy: LEARNER, expiresAt: '2027-01-01T00:00:00.000Z' }, 0));
    registry.noteOpen(link.id, 0);
    const durable = {
      [link.id]: { ...link, opens: 4, expiresAt: '2026-12-01T00:00:00.000Z', revokedAt: '2026-11-20T00:00:00.000Z', lastOpenAt: '2026-11-13T00:00:00.000Z' },
      junk: { id: 'not-a-token' },
    };
    const never = made(registry.create({ actorDid: OTHER, courseId: course.id, learnerPod: POD, mintedBy: OTHER }, 0));
    expect(registry.load(JSON.parse(JSON.stringify(durable)))).toBe(1);
    expect(registry.get(link.id)).toMatchObject({ opens: 4, expiresAt: '2026-12-01T00:00:00.000Z', revokedAt: '2026-11-20T00:00:00.000Z' });
    expect(mergePersonalLink(never, { ...never, expiresAt: '2026-12-01T00:00:00.000Z', opens: 2 }).expiresAt).toBe('2026-12-01T00:00:00.000Z');
    expect(new PersonalLaunchRegistry().load(JSON.parse(JSON.stringify(registry)))).toBe(2);
  });

  it('refuses a new link when full, or when one learner holds as many as one may', () => {
    const registry = new PersonalLaunchRegistry(3, 2);
    const firstLink = made(registry.create({ actorDid: LEARNER, courseId: 'c', learnerPod: POD, mintedBy: LEARNER }, 0));
    made(registry.create({ actorDid: LEARNER, courseId: 'c', learnerPod: POD, mintedBy: LEARNER }, 0));
    expect(registry.create({ actorDid: LEARNER, courseId: 'c', learnerPod: POD, mintedBy: LEARNER }, 0)).toEqual({ refused: 'a learner may hold 2 personal launch links; withdraw one you no longer need' });
    made(registry.create({ actorDid: OTHER, courseId: 'c', learnerPod: POD, mintedBy: OTHER }, 0));
    expect(registry.create({ actorDid: 'did:ethr:0x3333333333333333333333333333333333333333', courseId: 'c', learnerPod: POD, mintedBy: 'did:ethr:0x3' }, 0)).toEqual({ refused: 'this bridge holds as many personal launch links as it can' });
    expect(registry.get(firstLink.id)?.actorDid).toBe(LEARNER);
  });

  it('drops a withdrawn or expired link when the next one is minted, so neither fills the cap', () => {
    const registry = new PersonalLaunchRegistry(2, 1);
    const now = Date.parse('2026-11-13T00:00:00Z');
    const live = made(registry.create({ actorDid: LEARNER, courseId: 'c', learnerPod: POD, mintedBy: LEARNER }, now));
    expect(registry.create({ actorDid: LEARNER, courseId: 'c', learnerPod: POD, mintedBy: LEARNER }, now)).toEqual({ refused: 'a learner may hold 1 personal launch links; withdraw one you no longer need' });
    registry.revoke(live.id, now);
    const again = made(registry.create({ actorDid: LEARNER, courseId: 'c', learnerPod: POD, mintedBy: LEARNER }, now));
    expect(registry.get(live.id)).toBeUndefined();
    expect(again.id).not.toBe(live.id);
    expect(registry.size).toBe(1);

    const expired = made(registry.create({ actorDid: OTHER, courseId: 'c', learnerPod: POD, mintedBy: OTHER, expiresAt: '2026-11-01T00:00:00.000Z' }, now));
    expect(personalLinkState(expired, now)).toBe('expired');
    expect(registry.size).toBe(2);
    const replacement = made(registry.create({ actorDid: OTHER, courseId: 'c', learnerPod: POD, mintedBy: OTHER }, now));
    expect(registry.get(expired.id)).toBeUndefined();
    expect(replacement.actorDid).toBe(OTHER);
    expect(registry.size).toBe(2);
  });

  it('ends a delegate\'s link when the delegation ends, and a failed read does not write', async () => {
    const registry = new PersonalLaunchRegistry();
    const now = Date.parse('2026-11-13T00:00:00Z');
    const delegated = made(registry.create({
      actorDid: LEARNER, courseId: 'c', learnerPod: POD, mintedBy: 'did:key:agent',
      expiresAt: '2027-01-01T00:00:00.000Z', delegationExpiresAt: '2026-11-20T00:00:00.000Z',
    }, now));
    expect(personalLinkState(delegated, now)).toBe('live');
    expect(personalLinkState(delegated, Date.parse('2026-11-20T00:00:00Z'))).toBe('expired');
    const other = made(registry.create({ actorDid: OTHER, courseId: 'c', learnerPod: POD, mintedBy: OTHER, delegationExpiresAt: '2026-12-01T00:00:00.000Z' }, now));
    expect(mergePersonalLink(other, { ...other, delegationExpiresAt: '2026-11-15T00:00:00.000Z' }).delegationExpiresAt).toBe('2026-11-15T00:00:00.000Z');

    const calls: string[] = [];
    const wrote = await commitDurableRegistry({
      resource: 'https://pod.example/foxxi-lattice/cmi5-personal-links.json',
      fetch: async (_url, init) => {
        calls.push(init?.method ?? 'GET');
        if (!init?.method || init.method === 'GET') return { ok: false, status: 503, json: async () => ({ secret: true }) };
        return { ok: true, status: 201, json: async () => ({}) };
      },
      load: () => { throw new Error('a failed read must not be loaded'); },
      body: () => { throw new Error('a failed read must not be written'); },
    });
    expect(wrote).toBe(false);
    expect(calls).toEqual(['GET']);
  });

  it('treats a missing registry as absent and a failed read as not safe to overwrite', async () => {
    const loads: unknown[] = [];
    expect(await readDurableRegistry(async () => ({ status: 404, json: async () => ({}) }), (json) => { loads.push(json); })).toBe('absent');
    expect(loads).toEqual([]);
    expect(await readDurableRegistry(async () => ({ status: 200, json: async () => ({ kept: true }) }), (json) => { loads.push(json); })).toBe('loaded');
    expect(loads).toEqual([{ kept: true }]);
    expect(await readDurableRegistry(async () => ({ status: 503, json: async () => ({ kept: false }) }), (json) => { loads.push(json); })).toBe('failed');
    expect(await readDurableRegistry(async () => ({ status: 200, json: async () => { throw new Error('not json'); } }), (json) => { loads.push(json); })).toBe('failed');
    expect(await readDurableRegistry(async () => { throw new Error('pod down'); }, (json) => { loads.push(json); })).toBe('failed');
    expect(loads).toEqual([{ kept: true }]);
  });
});

describe('an open session is the registration a later launch continues', () => {
  const learner = 'did:ethr:0x4444444444444444444444444444444444444444';
  const au = { id: 'https://au.example/resume-unit', url: 'https://content.example/resume', moveOn: 'Passed' as const, masteryScore: 0.6, title: 'Resume' };
  const req = {
    au, learner: { id: learner }, lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch',
    authoritativeSource: HOME, tenant: TENANT, courseId: 'urn:foxxi:course:resume-direct', learnerPod: POD,
  };
  const scope = { tenant: TENANT, learnerId: learner, courseId: req.courseId, auId: au.id };

  it('resumes until terminated, abandoned or waived, and a Review launch is not judged again', async () => {
    const launch = buildCmi5Launch(req);
    expect(findResumableLaunch(scope)).toEqual({ registration: launch.registration, sessionId: expect.any(String) });
    const again = buildCmi5Launch({ ...req, resume: findResumableLaunch(scope) });
    expect(again.registration).toBe(launch.registration);
    expect(again.fetchToken).not.toBe(launch.fetchToken);
    expect(again.launchData).toMatchObject({ launchMode: 'Normal', contextTemplate: { extensions: { [SESSION]: (launch.launchData.contextTemplate as { extensions: Record<string, string> }).extensions[SESSION] } } });
    const deps = { statementsForRegistration: async () => [] as Record<string, unknown>[], emit: () => undefined };
    const reviewOpen = buildCmi5Launch({ ...req, learner: { id: learner + '-review-open' }, launchMode: 'Review' });
    const reviewKept = buildCmi5Launch({ ...req, learner: { id: learner + '-review-open' }, resume: findResumableLaunch({ ...scope, learnerId: learner + '-review-open' }) });
    expect(reviewKept.registration).toBe(reviewOpen.registration);
    expect(reviewKept.launchData).toMatchObject({ launchMode: 'Review' });

    const stopped = buildCmi5Launch({ ...req, learner: { id: learner + '-stopped' } });
    const stoppedSession = (stopped.launchData.contextTemplate as { extensions: Record<string, string> }).extensions[SESSION];
    await observeCmi5Statement({ verb: { id: V_TERMINATED }, context: { registration: stopped.registration } }, TENANT, deps);
    const continued = findResumableLaunch({ ...scope, learnerId: learner + '-stopped' });
    expect(continued).toEqual({ registration: stopped.registration, newSession: true });
    const restarted = buildCmi5Launch({ ...req, learner: { id: learner + '-stopped' }, resume: continued });
    expect(restarted.registration).toBe(stopped.registration);
    expect((restarted.launchData.contextTemplate as { extensions: Record<string, string> }).extensions[SESSION]).not.toBe(stoppedSession);

    await observeCmi5Statement({ verb: { id: V_ABANDONED }, context: { registration: launch.registration } }, TENANT, deps);
    expect(findResumableLaunch(scope)).toBeUndefined();

    const waived = buildCmi5Launch({ ...req, learner: { id: learner + '-waived' } });
    await observeCmi5Statement({ verb: { id: V_WAIVED }, context: { registration: waived.registration } }, TENANT, deps);
    expect(findResumableLaunch({ ...scope, learnerId: learner + '-waived' })).toBeUndefined();

    const review = buildCmi5Launch({ ...req, learner: { id: learner + '-review' }, launchMode: 'Review' });
    const emitted: Record<string, unknown>[] = [];
    const passed = { verb: { id: V_PASSED }, object: { id: au.id }, result: { score: { scaled: 1 } }, context: { registration: review.registration } };
    await observeCmi5Statement(passed, TENANT, { statementsForRegistration: async () => [passed], emit: (s) => { emitted.push(s); } });
    expect(emitted).toEqual([]);
    await observeCmi5Statement({ verb: { id: V_TERMINATED }, context: { registration: review.registration } }, TENANT, deps);
    expect(findResumableLaunch({ ...scope, learnerId: learner + '-review' })).toBeUndefined();
  });
});

interface Started { base: string; registry: PersonalLaunchRegistry; close(): Promise<void>; setNow(t: number): void; now(): number }

const servers: Server[] = [];
afterAll(() => Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r())))));

async function start(partial: Partial<PersonalLaunchRouteDeps> & { courses?: Cmi5Course[] } = {}): Promise<Started> {
  let now = Date.parse('2026-11-13T12:00:00Z');
  const registry = partial.registry ?? new PersonalLaunchRegistry();
  const courses = new Map((partial.courses ?? [course, solo]).map(c => [c.id, c]));
  const app = express();
  app.use(express.json());
  const { courses: _courses, registry: _registry, ...rest } = partial;
  attachPersonalLaunchRoutes(app, {
    baseUrl: 'https://bridge.example',
    registry,
    authoritativeSource: HOME,
    verifyCaller: async (body) => {
      const b = (body ?? {}) as Record<string, unknown>;
      if (b.fail === 401) return { ok: false, status: 401, error: 'missing _signature or _signed_payload' };
      return { ok: true, callerDid: typeof b.callerDid === 'string' ? b.callerDid : LEARNER, payload: b };
    },
    learnerOf: async (auth) => ({ did: auth.callerDid, podUrl: POD, ...(auth.callerDid === LEARNER ? {} : { via: auth.callerDid }) }),
    tenantFor: () => TENANT,
    resolveCourse: async (id) => courses.get(id) ?? null,
    satisfiedAus: () => [],
    stageLaunch: async () => undefined,
    rateLimit: () => ({ ok: true }),
    opensPerMinute: 1000,
    opensPerTokenPerMinute: 1000,
    persist: () => undefined,
    now: () => now,
    ...rest,
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    registry, close: () => new Promise(r => server.close(() => r())),
    setNow: (t) => { now = t; }, now: () => now,
  };
}

const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };
async function mint(s: Started, payload: Record<string, unknown>, callerDid = LEARNER): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${s.base}/agent/cmi5/go`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ callerDid, ...payload }) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}
function open(s: Started, token: string, headers: Record<string, string> = { Accept: 'application/json' }): Promise<Response> {
  return fetch(`${s.base}/cmi5/go/${encodeURIComponent(token)}`, { redirect: 'manual', headers });
}
function launchParams(launchUrl: string): URLSearchParams {
  return new URL(launchUrl).searchParams;
}

describe('minting, opening and withdrawing a personal launch link', () => {
  it('requires the signed caller, ignores a named learner, and puts nothing about them in the URL', async () => {
    const s = await start();
    expect((await mint(s, { fail: 401, course_id: course.id })).status).toBe(401);
    expect((await mint(s, {})).status).toBe(400);
    expect((await mint(s, { course_id: 'urn:missing' })).status).toBe(404);
    expect((await mint(s, { course_id: course.id, au_id: 'urn:nope' })).status).toBe(404);
    expect((await mint(s, { course_id: course.id, return_url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await mint(s, { course_id: course.id, expires_in_days: 0 })).status).toBe(400);

    const minted = await mint(s, { course_id: course.id, learner: 'did:ethr:0xevil', au_id: first, return_url: 'https://learn.example/back' });
    expect(minted.status).toBe(201);
    expect(minted.body.learner).toBe(LEARNER);
    expect(minted.body.learner).not.toBe('did:ethr:0xevil');
    const url = new URL(minted.body.url as string);
    expect(url.origin + url.pathname).toBe(`https://bridge.example/cmi5/go/${String(minted.body.token)}`);
    expect(url.search).toBe('');
    expect(url.pathname).not.toContain(LEARNER);
    expect(url.pathname).not.toContain('script');
    expect(Date.parse(String(minted.body.expiresAt)) - s.now()).toBe(90 * DAY);

    const forever = await mint(s, { course_id: course.id, expires_in_days: null });
    expect(forever.status).toBe(201);
    expect(forever.body.expiresAt).toBeUndefined();
    expect(forever.body.state).toBe('live');
  });

  it('redirects each open to a conformant launch, resumes the open registration, and keeps it after terminated', async () => {
    const learner = 'did:ethr:0x5555555555555555555555555555555555555555';
    let writes = 0;
    const s = await start({ persist: () => { writes++; } });
    const minted = await mint(s, { course_id: course.id, au_id: first }, learner);
    expect(minted.status).toBe(201);
    const token = minted.body.token as string;

    const browser = await fetch(`${s.base}/cmi5/go/${token}?learner=${encodeURIComponent(OTHER)}&course_id=urn:other`, { redirect: 'manual' });
    expect(browser.status).toBe(302);
    const location = browser.headers.get('location') ?? '';
    expect(browser.headers.get('cache-control')).toContain('no-store');
    expect(browser.headers.get('referrer-policy')).toBe('no-referrer');
    const q = launchParams(location);
    expect(q.get('endpoint')).toBe('https://bridge.example/xapi');
    expect(q.get('fetch')).toMatch(/\/cmi5\/fetch\/ft-/);
    expect(q.get('activityId')).toBe(first);
    expect(q.get('registration')).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(q.get('actor') ?? '{}')).toMatchObject({ account: { homePage: HOME, name: learner } });
    expect(location).not.toContain(OTHER);
    const registration = q.get('registration')!;
    const fetchToken = q.get('fetch')!.split('/').at(-1)!;
    const spent = redeemFetchToken(fetchToken);
    expect(spent.ok).toBe(true);
    if (spent.ok) expect(cmi5BearerRegistration(spent.body['auth-token'])).toBe(registration);
    expect(redeemFetchToken(fetchToken).ok).toBe(false);
    // The first redemption spent it. A second open mints another, for the same registration.
    const second = await open(s, token);
    expect(second.status).toBe(200);
    const again = await second.json() as { resumed: boolean; registration: string; launchUrl: string };
    expect(again.resumed).toBe(true);
    expect(again.registration).toBe(registration);
    expect(launchParams(again.launchUrl).get('activityId')).toBe(first);
    const fetch2 = launchParams(again.launchUrl).get('fetch')!.split('/').at(-1)!;
    expect(fetch2).not.toBe(fetchToken);
    const redeemed = redeemFetchToken(fetch2);
    expect(redeemed.ok).toBe(true);
    if (redeemed.ok) expect(cmi5BearerRegistration(redeemed.body['auth-token'])).toBe(registration);

    await observeCmi5Statement({ verb: { id: V_TERMINATED }, context: { registration } }, TENANT, { statementsForRegistration: async () => [], emit: () => undefined });
    const third = await (await open(s, token)).json() as { resumed: boolean; registration: string };
    expect(third.resumed).toBe(false);
    expect(third.registration).toBe(registration);
    expect(s.registry.lookup(token)?.opens).toBe(3);
    expect(writes).toBe(1);
  });

  it('follows the course: the next unsatisfied activity, then Review once the only one is satisfied and closed', async () => {
    const learner = 'did:ethr:0x6666666666666666666666666666666666666666';
    const done = new Set<string>();
    const s = await start({ satisfiedAus: (_tenant, id) => id === learner ? [...done] : [] });
    const token = (await mint(s, { course_id: course.id }, learner)).body.token as string;
    const a = await (await open(s, token)).json() as { auId: string; registration: string; moveOn: string };
    expect(a).toMatchObject({ auId: first, moveOn: 'CompletedOrPassed' });
    done.add(first);
    const b = await (await open(s, token)).json() as { auId: string; registration: string; resumed: boolean; moveOn: string };
    expect(b.auId).toBe(second);
    expect(b.moveOn).toBe('Passed');
    expect(b.resumed).toBe(false);
    expect(b.registration).not.toBe(a.registration);

    const only = 'did:ethr:0x7777777777777777777777777777777777777777';
    const finished = new Set<string>();
    const review = await start({ satisfiedAus: (_tenant, id) => id === only ? [...finished] : [] });
    const reviewToken = (await mint(review, { course_id: solo.id }, only)).body.token as string;
    const firstOpen = await (await open(review, reviewToken)).json() as { registration: string; launchUrl: string };
    const passed = { verb: { id: V_PASSED }, object: { id: 'https://au.example/solo' }, result: { score: { scaled: 1 } }, context: { registration: firstOpen.registration } };
    const emitted: Record<string, unknown>[] = [];
    await observeCmi5Statement(passed, TENANT, { statementsForRegistration: async () => [passed], emit: (s) => { emitted.push(s); } });
    expect(emitted.some(s => (s.verb as { id?: string }).id?.endsWith('/satisfied'))).toBe(true);
    finished.add('https://au.example/solo');
    // Still the same session until the AU terminates it: moveOn being met does not by itself end it.
    const continued = await (await open(review, reviewToken)).json() as { resumed: boolean; registration: string };
    expect(continued).toMatchObject({ resumed: true, registration: firstOpen.registration });
    await observeCmi5Statement({ verb: { id: V_TERMINATED }, context: { registration: firstOpen.registration } }, TENANT, { statementsForRegistration: async () => [], emit: () => undefined });
    const reviewed = await (await open(review, reviewToken)).json() as { resumed: boolean; registration: string; launchUrl: string };
    expect(reviewed.resumed).toBe(false);
    expect(reviewed.registration).not.toBe(firstOpen.registration);
    expect(launchParams(reviewed.launchUrl).get('registration')).toBe(reviewed.registration);
    // Review is recorded in the launch the AU reads. A passed statement for it is kept and not judged.
    const reviewPass = { verb: { id: V_PASSED }, context: { registration: reviewed.registration }, result: { score: { scaled: 1 } } };
    const judged: Record<string, unknown>[] = [];
    const outcome = await observeCmi5Statement(reviewPass, TENANT, { statementsForRegistration: async () => [reviewPass], emit: (st) => { judged.push(st); } });
    expect(outcome).toMatchObject({ satisfied: false, emittedSatisfied: false });
    expect(judged).toEqual([]);
  });

  it('withdraws only the learner\'s own link, and an expired link stops launching', async () => {
    const s = await start();
    const minted = await mint(s, { course_id: course.id, expires_in_days: 1 });
    const token = minted.body.token as string;
    const foreign = await fetch(`${s.base}/agent/cmi5/go/revoke`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ callerDid: OTHER, token }) });
    expect(foreign.status).toBe(404);
    expect((await open(s, token)).status).toBe(200);

    const byUrl = await fetch(`${s.base}/agent/cmi5/go/revoke`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ callerDid: LEARNER, token: minted.body.url }) });
    expect(byUrl.status).toBe(200);
    const withdrawn = await byUrl.json() as { state: string; revokedAt: string };
    expect(withdrawn.state).toBe('revoked');
    expect(withdrawn.revokedAt).toBeTruthy();
    const again = await fetch(`${s.base}/agent/cmi5/go/revoke`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ callerDid: LEARNER, token }) });
    expect((await again.json() as { revokedAt: string }).revokedAt).toBe(withdrawn.revokedAt);
    const gone = await open(s, token);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ state: 'revoked' });

    const expiring = await mint(s, { course_id: solo.id, expires_in_days: 1 });
    s.setNow(s.now() + DAY);
    const expired = await open(s, expiring.body.token as string);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ state: 'expired' });
  });

  it('does not launch for a preview or a HEAD, refuses a guessed token without echoing it, and rate-limits real opens', async () => {
    const s = await start();
    const token = (await mint(s, { course_id: solo.id })).body.token as string;
    const preview = await open(s, token, { Accept: 'application/json', 'Sec-Purpose': 'prefetch' });
    expect(preview.status).toBe(204);
    expect(s.registry.lookup(token)?.opens).toBe(0);
    const head = await fetch(`${s.base}/cmi5/go/${token}`, { method: 'HEAD', redirect: 'manual' });
    expect(head.status).toBe(200);
    expect(head.headers.get('location')).toBeNull();
    expect(s.registry.lookup(token)?.opens).toBe(0);

    const guessed = 'pl-' + 'a'.repeat(43);
    const html = await open(s, guessed, { Accept: 'text/html' });
    expect(html.status).toBe(404);
    const page = await html.text();
    expect(page).not.toContain(guessed);
    expect(page).not.toContain('<script');
    const gated = await open(s, (await mint(s, { course_id: course.id, au_id: second })).body.token as string, { Accept: 'text/html' });
    expect(gated.status).toBe(409);
    const gatedPage = await gated.text();
    expect(gatedPage).toContain('&lt;script&gt;');
    expect(gatedPage).not.toContain('<script>');

    const limited = await start({ opensPerMinute: 2, opensPerTokenPerMinute: 10 });
    const limitedToken = (await mint(limited, { course_id: solo.id })).body.token as string;
    const sameAddress = { Accept: 'application/json', 'X-Forwarded-For': '203.0.113.10' };
    expect((await open(limited, limitedToken, sameAddress)).status).toBe(200);
    expect((await open(limited, limitedToken, sameAddress)).status).toBe(200);
    const blocked = await open(limited, limitedToken, sameAddress);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();

    const perToken = await start({ opensPerMinute: 100, opensPerTokenPerMinute: 1 });
    const one = (await mint(perToken, { course_id: solo.id })).body.token as string;
    expect((await open(perToken, one, { 'X-Forwarded-For': '203.0.113.20', Accept: 'application/json' })).status).toBe(200);
    const secondOpen = await open(perToken, one, { 'X-Forwarded-For': '203.0.113.21', Accept: 'application/json' });
    expect(secondOpen.status).toBe(429);
    expect(secondOpen.headers.get('retry-after')).toBeTruthy();
    expect((await secondOpen.json() as { error: string }).error).toMatch(/Too many opens of this link/);
  });

  it('reads a link this process does not hold yet, and does not say why a launch failed', async () => {
    const held = new PersonalLaunchRegistry();
    const minted = unpacked(held.create({ actorDid: LEARNER, courseId: solo.id, learnerPod: POD, mintedBy: LEARNER, expiresAt: '2027-01-01T00:00:00.000Z' }, Date.parse('2026-11-13T12:00:00Z')));
    let reloaded = 0;
    const s = await start({
      reload: async () => { reloaded++; s.registry.load(held.toJSON()); },
    });
    expect((await open(s, 'not-a-token', { Accept: 'application/json' })).status).toBe(404);
    expect(reloaded).toBe(0);
    const found = await open(s, minted.token);
    expect(found.status).toBe(200);
    expect(reloaded).toBe(1);
    expect((await found.json() as { launchUrl: string }).launchUrl).toContain('endpoint=');

    const broken = await start({ stageLaunch: async () => { throw new Error('https://secret.pod.example/internal unreachable'); } });
    const brokenToken = (await mint(broken, { course_id: solo.id })).body.token as string;
    const failed = await open(broken, brokenToken);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('secret.pod');

    const unread = await start({ reload: async () => 'failed' });
    const missing = 'pl-' + 'b'.repeat(43);
    const unavailable = await open(unread, missing, { Accept: 'application/json' });
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json() as { error: string }).error).toMatch(/could not be read/);
  });

  it('limits minting per forwarded client, lists the person\'s links, and does not bind a link when the delegation cannot be read', async () => {
    const limited = await start({ signedRequestsPerWindow: 1 });
    const headers = { ...jsonHeaders, 'X-Forwarded-For': '198.51.100.8, 10.0.0.1' };
    const first = await fetch(`${limited.base}/agent/cmi5/go`, { method: 'POST', headers, body: JSON.stringify({ course_id: solo.id }) });
    expect(first.status).toBe(201);
    const second = await fetch(`${limited.base}/agent/cmi5/go`, { method: 'POST', headers, body: JSON.stringify({ course_id: solo.id }) });
    expect(second.status).toBe(429);
    const other = await fetch(`${limited.base}/agent/cmi5/go`, { method: 'POST', headers: { ...jsonHeaders, 'X-Forwarded-For': '198.51.100.9' }, body: JSON.stringify({ course_id: course.id }) });
    expect(other.status).toBe(201);

    const person = 'did:ethr:0x8888888888888888888888888888888888888888';
    const agent = 'did:key:z6Mkdelegate';
    const listed = await start({
      learnerOf: async (auth) => {
        if (auth.callerDid === agent) throw new PersonalLinkAuthError(503, 'the delegation could not be read just now; the link was not bound to the agent');
        return { did: person, podUrl: POD, via: auth.callerDid, delegationExpiresAt: '2026-11-20T00:00:00.000Z' };
      },
    });
    const before = listed.registry.size;
    const refused = await mint(listed, { course_id: solo.id }, agent);
    expect(refused.status).toBe(503);
    expect(listed.registry.size).toBe(before);
    const minted = await mint(listed, { course_id: solo.id, expires_in_days: null }, person);
    expect(minted.status).toBe(201);
    expect(minted.body.expiresAt).toBe('2026-11-20T00:00:00.000Z');
    expect(typeof minted.body.url).toBe('string');
    const list = await fetch(`${listed.base}/agent/cmi5/go/list`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ callerDid: person }) });
    expect(list.status).toBe(200);
    const body = await list.json() as { learner: string; count: number; links: Array<{ id: string; token?: string; url?: string }> };
    expect(body.learner).toBe(person);
    expect(body.count).toBe(1);
    expect(body.links[0]?.token).toBeUndefined();
    expect(body.links[0]?.url).toBeUndefined();
    expect(body.links[0]?.id).toBe(hashPersonalLaunchToken(minted.body.token as string));
    const byId = await fetch(`${listed.base}/agent/cmi5/go/revoke`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ callerDid: person, token: body.links[0]?.id }) });
    expect(byId.status).toBe(200);
  });
});

describe('the bridge wires the personal link the way it wires a signed launch', () => {
  it('authenticates with the signed-request verifier, derives the learner from it, and keeps links on the tenant pod', () => {
    const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('const PERSONAL_LINKS_RESOURCE'), src.indexOf('// ── Composable content'));
    expect(block).toContain("foxxi-lattice/cmi5-personal-links.json");
    expect(block).toContain('verifyCaller: verifyDelegatedCaller');
    expect(block).toContain('learnerOf: signedLearnerForLink');
    expect(block).toContain('stageLaunch: stageLaunchData');
    expect(block).toContain('persist: persistPersonalLinks');
    expect(block).toContain('registryWriter(writePersonalLinks)');
    expect(block).toContain('commitDurableRegistry');
    expect(block).toContain("if (read !== 'failed') personalLinksReadAt = Date.now()");
    const auth = src.slice(src.indexOf('async function signedLearnerForLink'), src.indexOf('/** Who a signed caller is learning as'));
    expect(auth).toContain('throw new PersonalLinkAuthError(503');
    expect(auth).toContain("throw new PersonalLinkAuthError(401, 'this agent has no delegation to act as a person')");
    expect(block).toMatch(/opensPerMinute: positiveLimit\(process\.env\.FOXXI_CMI5_GO_PER_IP, 60\)/);
    expect(block).toMatch(/opensPerTokenPerMinute: positiveLimit\(process\.env\.FOXXI_CMI5_GO_PER_TOKEN, 12\)/);
  });
});
