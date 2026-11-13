/**
 * The course player launches any published cmi5 course as the learner who is already signed in:
 * a provisional Interego guest or an existing owner. It does not mint an identity. A second open
 * continues the same registration until the attempt is satisfied. Linking an existing owner to a
 * guest leaves the guest's statements as they were.
 */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { actorAliases, setActorAliasSource } from '../src/actor-alias.js';
import { attachCoursePlayerRoutes, browserWantsPlayer, playerLocation, PlayerBook, PlayerError, type PlayerLearner } from '../src/cmi5-player.js';
import { attachHostedPackageRoutes } from '../src/scorm-hosting.js';
import { learnerSatisfiedAus, observeCmi5Statement, registerCmi5Course } from '../src/cmi5-lms.js';
import { matchesFilter } from '../src/statement-store.js';
import { internalRefusalOf } from '../src/xapi-lrs.js';
import { DEFAULT_TENANT } from '../src/tenant-context.js';
import type { Cmi5Course } from '../src/cmi5-course.js';

const HOME = 'https://bridge.example';
const SOURCE = 'did:web:bridge.example';
const GUEST = 'did:web:identity.example:users:u-try-play-' + 'ab'.repeat(16);
const OWNER = 'did:web:identity.example:users:u-pk-abc123abc123';
const course: Cmi5Course = {
  id: 'https://bridge.example/scorm/packages/' + 'cd'.repeat(32),
  title: 'Whatever the package is called',
  description: 'From the course record.',
  structure: [{ kind: 'au', id: 'https://bridge.example/au/1', title: 'First activity', url: 'https://bridge.example/content/au/p/0', moveOn: 'Completed' }],
};

function learner(did: string, guest: boolean): PlayerLearner {
  const userId = did.split(':').at(-1)!;
  return { did, webId: `https://identity.example/users/${userId}/profile#me`, podUrl: `https://pods.example/${userId}/`, userId, guest };
}

async function player(options: { perMinute?: number; who?: PlayerLearner } = {}) {
  registerCmi5Course(DEFAULT_TENANT, course);
  const book = new PlayerBook();
  let who = options.who ?? learner(GUEST, true);
  const statements: Array<{ id: string; voided: boolean; statement: Record<string, unknown> }> = [];
  const staged: Array<{ launchMode?: unknown; registration: string }> = [];
  const app = express();
  app.use(express.json());
  attachCoursePlayerRoutes(app, {
    baseUrl: HOME, authoritativeSource: SOURCE, book, launchesPerMinute: options.perMinute ?? 30,
    requireLearner: async () => who,
    verifyGuest: async () => learner(GUEST, true),
    resolveCourse: async (id) => id === course.id ? course : null,
    satisfied: (tenant, id) => learnerSatisfiedAus(tenant, id),
    stageLaunch: async (_tenant, launch) => { staged.push({ launchMode: launch.launchData.launchMode, registration: launch.registration }); },
    forgetActor: async (did) => {
      let n = 0;
      for (const rec of statements) {
        const name = (rec.statement.actor as { account?: { name?: string } }).account?.name;
        if (!rec.voided && name === did) { rec.voided = true; n++; }
      }
      return n;
    },
    statementIds: async (did) => statements.filter(rec => !rec.voided && (rec.statement.actor as { account?: { name?: string } }).account?.name === did).map(rec => rec.id),
    storeStatement: async (statement) => {
      expect(internalRefusalOf(statement)).toEqual([]);
      const id = randomUUID();
      statements.push({ id, voided: false, statement });
      return id;
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base, book, staged, statements, setWho: (next: PlayerLearner) => { who = next; },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

afterEach(() => setActorAliasSource());

describe('the course player', () => {
  it('is a page for whatever course was asked for, with agreement before anything is recorded', async () => {
    const launched = await player();
    try {
      const page = await fetch(`${launched.base}/learn?course_id=${encodeURIComponent(course.id)}`);
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain(course.title);
      expect(html).toContain(course.description!);
      expect(html).toContain('>Start<');
      expect(html).toContain('Nothing is recorded until you agree');
      expect(html).not.toContain('Callcraft');
      const refused = await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ course_id: course.id, tracking_consent: false }) });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: 'player_consent_required' });
    } finally { await launched.close(); }
  });

  it('launches the signed-in guest, then continues the same registration', async () => {
    const launched = await player();
    try {
      const body = { course_id: course.id, tracking_consent: true };
      const first = await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const opened = await first.json() as { registration: string; launchUrl: string; actor: { account: { name: string; homePage: string } }; resumed: boolean; guest: boolean };
      expect(first.status).toBe(200);
      expect(opened.guest).toBe(true);
      expect(opened.resumed).toBe(false);
      expect(opened.actor.account).toEqual({ homePage: SOURCE, name: GUEST });
      const url = new URL(opened.launchUrl);
      expect(url.searchParams.get('endpoint')).toBe(`${HOME}/xapi`);
      expect(url.searchParams.get('fetch')).toContain('/cmi5/fetch/');
      expect(url.searchParams.get('registration')).toBe(opened.registration);
      expect(JSON.parse(url.searchParams.get('actor')!)).toMatchObject({ account: { name: GUEST } });
      const second = await (await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as { registration: string; resumed: boolean };
      expect(second.resumed).toBe(true);
      expect(second.registration).toBe(opened.registration);
    } finally { await launched.close(); }
  });

  it('starts a new registration once the attempt is satisfied, in review', async () => {
    const launched = await player();
    try {
      const body = { course_id: course.id, tracking_consent: true };
      const first = await (await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as { registration: string };
      const completed = { verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: course.structure[0] && course.structure[0].kind === 'au' ? course.structure[0].id : '' }, context: { registration: first.registration }, result: { completion: true } };
      const observed = await observeCmi5Statement(completed, DEFAULT_TENANT, { statementsForRegistration: async () => [completed], emit: () => undefined });
      expect(observed?.satisfied).toBe(true);
      const again = await (await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as { registration: string; resumed: boolean };
      expect(again.resumed).toBe(false);
      expect(again.registration).not.toBe(first.registration);
      expect(launched.staged.at(-1)).toMatchObject({ launchMode: 'Review' });
    } finally { await launched.close(); }
  });

  it('links an existing owner to a guest without changing the guest statements', async () => {
    const launched = await player();
    try {
      const original = { id: randomUUID(), actor: { objectType: 'Agent', account: { homePage: SOURCE, name: GUEST } }, verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' }, object: { id: 'https://bridge.example/au/1' } };
      launched.statements.push({ id: original.id, voided: false, statement: original });
      const asGuest = await fetch(`${launched.base}/learn/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(asGuest.status).toBe(409);
      launched.setWho(learner(OWNER, false));
      const linked = await fetch(`${launched.base}/learn/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await linked.json() as { guest: string; owner: string; statementsUnchanged: boolean; claimStatementId: string };
      expect(linked.status).toBe(200);
      expect(body).toMatchObject({ guest: GUEST, owner: OWNER, statementsUnchanged: true });
      expect(original.actor.account.name).toBe(GUEST);
      const claim = launched.statements.find(rec => rec.id === body.claimStatementId)!;
      expect((claim.statement.actor as { account: { name: string } }).account.name).toBe(OWNER);
      const owner = { account: { homePage: SOURCE, name: OWNER } };
      expect(matchesFilter({ id: original.id, statement: original, stored: new Date().toISOString(), voided: false }, { agent: owner, alsoAgents: actorAliases(owner) })).toBe(true);
      const forgotten = await fetch(`${launched.base}/learn/forget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(await forgotten.json()).toMatchObject({ forgotten: 1 });
      expect(launched.statements[0]!.voided).toBe(true);
      expect(original.actor.account.name).toBe(GUEST);
    } finally { await launched.close(); }
  });

  it('refuses a launch of a course that is not here, and limits how often a launch may be asked', async () => {
    const launched = await player({ perMinute: 2 });
    try {
      const missing = await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ course_id: 'https://bridge.example/missing', tracking_consent: true }) });
      expect(missing.status).toBe(404);
      const body = { course_id: course.id, tracking_consent: true };
      expect((await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(200);
      const limited = await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(limited.status).toBe(429);
    } finally { await launched.close(); }
  });

  it('sends a browser that opens a hosted package to the player, and a cmi5 launch to the activity', () => {
    expect(browserWantsPlayer({ headers: { accept: 'text/html,application/xhtml+xml' }, query: {} })).toBe(true);
    expect(browserWantsPlayer({ headers: { accept: '*/*' }, query: {} })).toBe(false);
    expect(browserWantsPlayer({ headers: { accept: 'text/html' }, query: { endpoint: 'https://lrs.example', fetch: 'https://lrs.example/fetch', registration: 'r' } })).toBe(false);
    expect(playerLocation(course.id)).toBe(`/learn?course_id=${encodeURIComponent(course.id)}`);
    expect(() => { throw new PlayerError(503, 'player_sign_in_unavailable'); }).toThrow(PlayerError);
  });

  it('redirects a browser visiting a hosted package record to the player', async () => {
    const sha = 'ab'.repeat(32);
    const hosted: Cmi5Course = { ...course, id: `https://bridge.example/scorm/packages/${sha}` };
    const app = express();
    attachHostedPackageRoutes(app, {
      packages: { about: async () => null } as never,
      bridgeBaseUrl: HOME,
      courseFor: async () => hosted,
      onError: (res) => { res.status(500).end(); },
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    try {
      const browser = await fetch(`http://127.0.0.1:${address.port}/scorm/packages/${sha}`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
      expect(browser.status).toBe(303);
      expect(browser.headers.get('location')).toBe(playerLocation(hosted.id));
      const agent = await fetch(`http://127.0.0.1:${address.port}/scorm/packages/${sha}`, { headers: { Accept: 'application/json' } });
      expect(agent.status).toBe(200);
      expect(await agent.json()).toMatchObject({ course: { id: hosted.id } });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
