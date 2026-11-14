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
import { actorAliases, canonicalActorName, setActorAliasSource } from '../src/actor-alias.js';
import { actorForPod } from '../src/mesh-event-projector.js';
import { attachCoursePlayerRoutes, browserWantsPlayer, persistVoidCopies, playerLocation, PlayerBook, statementNamesGuest, voidActorStatements, type PlayerLearner } from '../src/cmi5-player.js';
import { attachHostedPackageRoutes } from '../src/scorm-hosting.js';
import { cmi5BearerTenant, dropLearnerSatisfaction, forgetCmi5Learner, learnerSatisfiedAus, observeCmi5Statement, redeemFetchToken, registerCmi5Course, buildCmi5Launch } from '../src/cmi5-lms.js';
import { matchesFilter } from '../src/statement-store.js';
import { clearActorStateDocuments, clearStatementStore, getStatementStore, internalRefusalOf, listStoredStatements, readStateDocument, stageStateDocument, storeStatementDurably } from '../src/xapi-lrs.js';
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

/** The same lens a signed launch and `foxxi.read_xapi_statements_signed` use: `lens:` plus the pod's actor. */
function lensTenant(person: PlayerLearner) {
  return `lens:${actorForPod(person.podUrl)}` as typeof DEFAULT_TENANT;
}

function markStored(rows: Array<{ id: string; voided: boolean; statement: Record<string, unknown> }>, targetId: string, voidingId: string): boolean {
  const rec = rows.find(row => row.id === targetId);
  const voider = rows.find(row => row.id === voidingId);
  const object = voider?.statement.object as { objectType?: string; id?: string } | undefined;
  if (!rec || rec.voided || !voider || voidingId === targetId || object?.objectType !== 'StatementRef' || object.id !== targetId) return false;
  rec.voided = true;
  return true;
}

function learner(did: string, guest: boolean): PlayerLearner {
  const userId = did.split(':').at(-1)!;
  return { did, webId: `https://identity.example/users/${userId}/profile#me`, podUrl: `https://pods.example/${userId}/`, userId, guest };
}

async function player(options: { perMinute?: number; who?: PlayerLearner; verifyGuest?: () => Promise<PlayerLearner> } = {}) {
  registerCmi5Course(DEFAULT_TENANT, course);
  const book = new PlayerBook();
  let who = options.who ?? learner(GUEST, true);
  const statements: Array<{ id: string; voided: boolean; statement: Record<string, unknown> }> = [];
  const staged: Array<{ launchMode?: unknown; registration: string }> = [];
  const launchedSeen: Array<Record<string, unknown>> = [];
  const app = express();
  app.use(express.json());
  attachCoursePlayerRoutes(app, {
    baseUrl: HOME, authoritativeSource: SOURCE, book, launchesPerMinute: options.perMinute ?? 30,
    requireLearner: async () => who,
    verifyGuest: options.verifyGuest ?? (async () => learner(GUEST, true)),
    resolveCourse: async (id) => id === course.id ? course : null,
    satisfied: (tenant, id) => learnerSatisfiedAus(tenant, id),
    stageLaunch: async (_tenant, launch) => { staged.push({ launchMode: launch.launchData.launchMode, registration: launch.registration }); },
    recordLaunched: async (_tenant, statement) => { launchedSeen.push(statement); },
    forgetActor: async (did, tenant = DEFAULT_TENANT) => {
      const result = await voidActorStatements({
        did, homePage: SOURCE,
        list: async () => statements,
        store: async (statement) => {
          const id = randomUUID();
          statements.push({ id, voided: false, statement });
          return id;
        },
        mark: (targetId, voidingId) => Promise.resolve(markStored(statements, targetId, voidingId)),
      });
      forgetCmi5Learner(tenant, did);
      await clearActorStateDocuments(tenant, { homePage: SOURCE, name: did });
      return result.forgotten;
    },
    dropSatisfaction: (tenant, id, auIds) => { dropLearnerSatisfaction(tenant, id, auIds); },
    voidClaims: async (ownerDid, _tenant, guestDid) => {
      const result = await voidActorStatements({
        did: ownerDid, homePage: SOURCE,
        list: async () => statements.filter(rec => statementNamesGuest(rec.statement, guestDid)),
        store: async (statement) => {
          const id = randomUUID();
          statements.push({ id, voided: false, statement });
          return id;
        },
        mark: (targetId, voidingId) => Promise.resolve(markStored(statements, targetId, voidingId)),
      });
      return result.forgotten;
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
    base, book, staged, statements, launchedSeen, setWho: (next: PlayerLearner) => { who = next; },
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

  it('opens a finished attempt in Review and keeps that mode when the review is resumed', async () => {
    // A learner no other test launches, and nothing of theirs left in the LMS, so a passed review cannot be a leftover open session.
    const solo = learner('did:web:identity.example:users:u-try-play-' + '54'.repeat(16), true);
    forgetCmi5Learner(DEFAULT_TENANT, solo.did);
    const launched = await player({ who: solo });
    try {
      const body = { course_id: course.id, tracking_consent: true };
      const first = await (await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as { registration: string; resumed: boolean };
      expect(first.resumed).toBe(false);
      expect(launched.staged.at(-1)).toMatchObject({ launchMode: 'Normal', registration: first.registration });
      const auId = course.structure[0] && course.structure[0].kind === 'au' ? course.structure[0].id : '';
      const completed = { verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: auId }, context: { registration: first.registration }, result: { completion: true } };
      const deps = { statementsForRegistration: async () => [completed], emit: () => undefined };
      await observeCmi5Statement({ verb: { id: 'http://adlnet.gov/expapi/verbs/terminated' }, object: { id: auId }, context: { registration: first.registration } }, DEFAULT_TENANT, deps);
      expect((await observeCmi5Statement(completed, DEFAULT_TENANT, deps))?.satisfied).toBe(true);
      const review = await (await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as { registration: string; resumed: boolean };
      expect(review.resumed).toBe(false);
      expect(review.registration).not.toBe(first.registration);
      expect(launched.staged.at(-1)).toMatchObject({ launchMode: 'Review' });
      const again = await (await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as { registration: string; resumed: boolean };
      expect(again.resumed).toBe(true);
      expect(again.registration).toBe(review.registration);
      expect(launched.staged.at(-1)).toMatchObject({ launchMode: 'Review' });
    } finally {
      forgetCmi5Learner(DEFAULT_TENANT, solo.did);
      await launched.close();
    }
  });

  it('reopens a finished activity in Review for a learner with no other launch in memory', async () => {
    // A learner nothing else in this file has launched, so no open launch left by another test can stand in for a resume.
    const solo = learner('did:web:identity.example:users:u-try-play-' + '51'.repeat(16), true);
    const launched = await player({ who: solo });
    try {
      const body = { course_id: course.id, tracking_consent: true };
      const post = async () => (await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<{ registration: string; resumed: boolean }>;
      const first = await post();
      expect(first.resumed).toBe(false);
      expect(launched.staged.at(-1)).toMatchObject({ launchMode: 'Normal' });
      // The LMS said it launched the session: the unit's activity, this registration, the session the launch opened.
      expect(launched.launchedSeen).toHaveLength(1);
      const said = launched.launchedSeen[0] as { verb: { id: string }; object: { id: string }; context: { registration: string; extensions: Record<string, unknown> } };
      const auId = course.structure[0] && course.structure[0].kind === 'au' ? course.structure[0].id : '';
      expect([said.verb.id, said.object.id, said.context.registration]).toEqual(['http://adlnet.gov/expapi/verbs/launched', auId, first.registration]);
      expect(said.context.extensions['https://w3id.org/xapi/cmi5/context/extensions/sessionid']).toBe(launched.book.open(solo.did, course.id, auId)?.sessionId);
      expect(said.context.extensions['https://w3id.org/xapi/cmi5/context/extensions/launchmode']).toBe('Normal');
      const completed = { verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: auId }, context: { registration: first.registration }, result: { completion: true } };
      const deps = { statementsForRegistration: async () => [completed], emit: () => undefined };
      expect((await observeCmi5Statement(completed, DEFAULT_TENANT, deps))?.satisfied).toBe(true);
      await observeCmi5Statement({ verb: { id: 'http://adlnet.gov/expapi/verbs/terminated' }, object: { id: auId }, context: { registration: first.registration } }, DEFAULT_TENANT, deps);
      // The book still holds the finished attempt's row. It is not what decides the mode.
      expect(launched.book.open(solo.did, course.id, auId)?.registration).toBe(first.registration);
      const review = await post();
      expect(review.resumed).toBe(false);
      expect(review.registration).not.toBe(first.registration);
      expect(launched.staged.at(-1)).toMatchObject({ launchMode: 'Review', registration: review.registration });
      expect(launched.launchedSeen).toHaveLength(2);
    } finally { await launched.close(); }
  });

  it('continues the registration in a new session when the last one ended before the activity was satisfied', async () => {
    const solo = learner('did:web:identity.example:users:u-try-play-' + '52'.repeat(16), true);
    const launched = await player({ who: solo });
    try {
      const body = { course_id: course.id, tracking_consent: true };
      const post = async () => (await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<{ registration: string; resumed: boolean }>;
      const auId = course.structure[0] && course.structure[0].kind === 'au' ? course.structure[0].id : '';
      const first = await post();
      const firstSession = launched.book.open(solo.did, course.id, auId)?.sessionId;
      // Reopened while the session is open: the same session, and the LMS does not say launched again.
      const same = await post();
      expect([same.resumed, same.registration]).toEqual([true, first.registration]);
      expect(launched.book.open(solo.did, course.id, auId)?.sessionId).toBe(firstSession);
      expect(launched.launchedSeen).toHaveLength(1);
      // Terminated with nothing completed: the next open is the same registration, a new session, and its own launched.
      const deps = { statementsForRegistration: async () => [], emit: () => undefined };
      await observeCmi5Statement({ verb: { id: 'http://adlnet.gov/expapi/verbs/terminated' }, object: { id: auId }, context: { registration: first.registration } }, DEFAULT_TENANT, deps);
      const next = await post();
      expect(next.registration).toBe(first.registration);
      expect(next.resumed).toBe(false);
      const nextSession = launched.book.open(solo.did, course.id, auId)?.sessionId;
      expect(nextSession).toBeTruthy();
      expect(nextSession).not.toBe(firstSession);
      expect(launched.launchedSeen).toHaveLength(2);
      const said = launched.launchedSeen[1] as { context: { registration: string; extensions: Record<string, unknown> } };
      expect(said.context.registration).toBe(first.registration);
      expect(said.context.extensions['https://w3id.org/xapi/cmi5/context/extensions/sessionid']).toBe(nextSession);
      expect(launched.staged.at(-1)).toMatchObject({ launchMode: 'Normal', registration: first.registration });
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
      const repeat = await (await fetch(`${launched.base}/learn/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json() as { already?: boolean };
      expect(repeat.already).toBe(true);
      expect(launched.statements.filter(rec => (rec.statement.verb as { id?: string }).id?.endsWith('#claimed'))).toHaveLength(1);
      const owner = { account: { homePage: SOURCE, name: OWNER } };
      expect(matchesFilter({ id: original.id, statement: original, stored: new Date().toISOString(), voided: false }, { agent: owner, alsoAgents: actorAliases(owner) })).toBe(true);
      const forgotten = await fetch(`${launched.base}/learn/forget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect((await forgotten.json() as { forgotten: number }).forgotten).toBeGreaterThan(0);
      expect(launched.statements[0]!.voided).toBe(true);
      expect(original.actor.account.name).toBe(GUEST);
    } finally { await launched.close(); }
  });

  it('brings over what a linked guest satisfies after the link, when the owner next launches', async () => {
    const guest = learner('did:web:identity.example:users:u-try-play-' + '53'.repeat(16), true);
    const owner = learner('did:web:identity.example:users:u-pk-53owner53owner', false);
    const launched = await player({ who: guest, verifyGuest: async () => guest });
    try {
      const body = { course_id: course.id, tracking_consent: true };
      const post = async () => (await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<{ registration: string }>;
      const auId = course.structure[0] && course.structure[0].kind === 'au' ? course.structure[0].id : '';
      const asGuest = await post();
      // Linked while the guest has satisfied nothing.
      launched.setWho(owner);
      expect((await fetch(`${launched.base}/learn/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(200);
      expect(learnerSatisfiedAus(DEFAULT_TENANT, owner.did)).toEqual([]);
      // The guest goes on and completes the activity.
      const completed = { verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: auId }, context: { registration: asGuest.registration }, result: { completion: true } };
      expect((await observeCmi5Statement(completed, DEFAULT_TENANT, { statementsForRegistration: async () => [completed], emit: () => undefined }))?.satisfied).toBe(true);
      expect(learnerSatisfiedAus(DEFAULT_TENANT, owner.did)).toEqual([]);
      // The owner's next launch finds it satisfied, so it opens in Review.
      await post();
      expect(learnerSatisfiedAus(DEFAULT_TENANT, owner.did)).toEqual([auId]);
      expect(launched.staged.at(-1)).toMatchObject({ launchMode: 'Review' });
    } finally {
      forgetCmi5Learner(DEFAULT_TENANT, guest.did);
      forgetCmi5Learner(DEFAULT_TENANT, owner.did);
      await launched.close();
    }
  });

  it('records a linked guest\'s later launch as the owner, and the guest\'s forget removes the copy and the claim', async () => {
    const guest = learner('did:web:identity.example:users:u-try-play-' + '55'.repeat(16), true);
    const owner = learner('did:web:identity.example:users:u-pk-55owner55owner', false);
    const launched = await player({ who: guest, verifyGuest: async () => guest });
    const auId = course.structure[0] && course.structure[0].kind === 'au' ? course.structure[0].id : '';
    const guestAgent = JSON.stringify({ objectType: 'Agent', account: { homePage: SOURCE, name: guest.did } });
    const ownerAgent = JSON.stringify({ objectType: 'Agent', account: { homePage: SOURCE, name: owner.did } });
    try {
      const body = { course_id: course.id, tracking_consent: true };
      const post = async () => (await fetch(`${launched.base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<{ registration: string; actor: { account: { name: string } } }>;
      const first = await post();
      expect(first.actor.account.name).toBe(guest.did);
      const completed = { verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: auId }, context: { registration: first.registration }, result: { completion: true } };
      expect((await observeCmi5Statement(completed, DEFAULT_TENANT, { statementsForRegistration: async () => [completed], emit: () => undefined }))?.satisfied).toBe(true);
      launched.setWho(owner);
      expect((await fetch(`${launched.base}/learn/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(200);
      expect(learnerSatisfiedAus(DEFAULT_TENANT, owner.did)).toContain(auId);
      dropLearnerSatisfaction(DEFAULT_TENANT, owner.did, [auId]);
      const repeat = await (await fetch(`${launched.base}/learn/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json() as { already?: boolean };
      expect(repeat.already).toBe(true);
      expect(learnerSatisfiedAus(DEFAULT_TENANT, owner.did)).toContain(auId);
      expect(launched.statements.filter(rec => statementNamesGuest(rec.statement, guest.did))).toHaveLength(1);
      launched.setWho(guest);
      const later = await post();
      expect(later.actor.account.name).toBe(owner.did);
      await stageStateDocument(DEFAULT_TENANT, { activityId: auId, agent: guestAgent, stateId: 'LMS.LaunchData', registration: first.registration }, { launchMode: 'Normal' });
      await stageStateDocument(DEFAULT_TENANT, { activityId: auId, agent: guestAgent, stateId: 'suspend', registration: first.registration }, { at: 1 });
      await stageStateDocument(DEFAULT_TENANT, { activityId: auId, agent: ownerAgent, stateId: 'LMS.LaunchData', registration: 'kept' }, { launchMode: 'Review' });
      const kept = { id: randomUUID(), actor: { objectType: 'Agent', account: { homePage: SOURCE, name: owner.did } }, verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' }, object: { id: auId } };
      launched.statements.push({ id: kept.id, voided: false, statement: kept });
      const forgotten = await (await fetch(`${launched.base}/learn/forget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json() as { forgotten: number };
      expect(forgotten.forgotten).toBeGreaterThan(0);
      expect(learnerSatisfiedAus(DEFAULT_TENANT, owner.did)).not.toContain(auId);
      expect(learnerSatisfiedAus(DEFAULT_TENANT, guest.did)).toEqual([]);
      expect(launched.statements.find(rec => statementNamesGuest(rec.statement, guest.did))?.voided).toBe(true);
      expect(launched.statements.find(rec => rec.id === kept.id)?.voided).toBe(false);
      expect(await readStateDocument(DEFAULT_TENANT, { activityId: auId, agent: guestAgent, stateId: 'LMS.LaunchData', registration: first.registration })).toBeUndefined();
      expect(await readStateDocument(DEFAULT_TENANT, { activityId: auId, agent: guestAgent, stateId: 'suspend', registration: first.registration })).toBeUndefined();
      expect(await readStateDocument(DEFAULT_TENANT, { activityId: auId, agent: ownerAgent, stateId: 'LMS.LaunchData', registration: 'kept' })).toEqual({ launchMode: 'Review' });
    } finally {
      forgetCmi5Learner(DEFAULT_TENANT, guest.did);
      forgetCmi5Learner(DEFAULT_TENANT, owner.did);
      await clearActorStateDocuments(DEFAULT_TENANT, { homePage: SOURCE, name: owner.did });
      await launched.close();
    }
  });

  it('writes a linked guest\'s later statement into the owner lens and leaves the earlier one in the guest lens', async () => {
    const guest = learner('did:web:identity.example:users:u-try-play-' + '56'.repeat(16), true);
    const owner = learner('did:web:identity.example:users:u-pk-56owner56owner', false);
    const guestLens = lensTenant(guest);
    const ownerLens = lensTenant(owner);
    registerCmi5Course(DEFAULT_TENANT, course);
    let who = guest;
    const app = express();
    app.use(express.json());
    attachCoursePlayerRoutes(app, {
      baseUrl: HOME, authoritativeSource: SOURCE, tenantFor: lensTenant,
      requireLearner: async () => who,
      verifyGuest: async () => guest,
      resolveCourse: async (id) => id === course.id ? course : null,
      satisfied: (tenant, id) => learnerSatisfiedAus(tenant, id),
      stageLaunch: async () => undefined,
      recordLaunched: (tenant, statement) => storeStatementDurably(statement, tenant).then(() => undefined),
      forgetActor: async () => 0,
      storeStatement: (statement, tenant) => storeStatementDurably(statement, tenant),
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}`;
    const verb = `${HOME}/learn#consented`;
    const read = async (tenant: typeof DEFAULT_TENANT, did: string) =>
      (await getStatementStore(tenant).query({ agent: { objectType: 'Agent', account: { homePage: SOURCE, name: did } }, verb })).statements;
    try {
      const body = { course_id: course.id, tracking_consent: true };
      const post = async () => (await fetch(`${base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<{ actor: { account: { name: string } } }>;
      expect((await post()).actor.account.name).toBe(guest.did);
      expect(await read(guestLens, guest.did)).toHaveLength(1);
      expect(await read(ownerLens, owner.did)).toEqual([]);
      who = owner;
      expect((await fetch(`${base}/learn/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(200);
      who = guest;
      expect((await post()).actor.account.name).toBe(owner.did);
      expect(await read(guestLens, guest.did)).toHaveLength(1);
      expect(await read(ownerLens, owner.did)).toHaveLength(1);
      expect(await read(DEFAULT_TENANT, owner.did)).toEqual([]);
    } finally {
      await clearStatementStore(guestLens);
      await clearStatementStore(ownerLens);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('says when a pod copy of a void did not land', async () => {
    const statement = { id: 'void-1', actor: { account: { name: 'did:guest' } } };
    const seen: unknown[] = [];
    await expect(persistVoidCopies([statement], async (next) => { seen.push(next); return false; })).rejects.toMatchObject({ status: 503, code: 'player_forget_incomplete' });
    expect(seen).toEqual([statement]);
    await expect(persistVoidCopies([], async () => false)).resolves.toBeUndefined();
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
  });

  it('refuses to link an account that is not a provisional guest', async () => {
    const launched = await player({ verifyGuest: async () => learner('did:web:identity.example:users:u-pk-abc123abc123', false) });
    try {
      launched.setWho(learner(OWNER, false));
      const refused = await fetch(`${launched.base}/learn/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: 'player_not_a_guest' });
    } finally { await launched.close(); }
  });

  it('forgetting one learner leaves another learner\'s satisfaction and auth token', async () => {
    const au = course.structure[0] && course.structure[0].kind === 'au' ? course.structure[0] : undefined;
    if (!au) throw new Error('course');
    const other = 'did:web:identity.example:users:u-try-play-' + 'cd'.repeat(16);
    const kept = buildCmi5Launch({
      au, learner: { id: other }, lrsEndpoint: `${HOME}/xapi`, fetchBaseUrl: `${HOME}/cmi5/fetch`,
      authoritativeSource: SOURCE, tenant: DEFAULT_TENANT, courseId: course.id,
    });
    const redeemed = redeemFetchToken(kept.fetchToken);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;
    expect(cmi5BearerTenant(redeemed.body['auth-token'])).toBe(DEFAULT_TENANT);
    const auId = au.id;
    const completed = { verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: auId }, context: { registration: kept.registration }, result: { completion: true } };
    await observeCmi5Statement(completed, DEFAULT_TENANT, { statementsForRegistration: async () => [completed], emit: () => undefined });
    const keptSatisfied = learnerSatisfiedAus(DEFAULT_TENANT, other);
    expect(keptSatisfied).toContain(auId);
    const dropped = buildCmi5Launch({
      au, learner: { id: GUEST }, lrsEndpoint: `${HOME}/xapi`, fetchBaseUrl: `${HOME}/cmi5/fetch`,
      authoritativeSource: SOURCE, tenant: DEFAULT_TENANT, courseId: course.id, learnerPod: 'https://pods.example/guest/',
    });
    forgetCmi5Learner(DEFAULT_TENANT, GUEST);
    expect(learnerSatisfiedAus(DEFAULT_TENANT, other)).toEqual(keptSatisfied);
    expect(learnerSatisfiedAus(DEFAULT_TENANT, GUEST)).toEqual([]);
    expect(cmi5BearerTenant(redeemed.body['auth-token'])).toBe(DEFAULT_TENANT);
    expect(redeemFetchToken(dropped.fetchToken).ok).toBe(false);
  });

  it('keeps a pending attempt and a deletion when an older copy is read, and counts every linked guest', () => {
    const book = new PlayerBook();
    const older = { learnerDid: 'did:guest', courseId: 'course', auId: 'au', registration: 'old', sessionId: 's' };
    book.remember(older);
    const stale = book.toJSON();
    book.remember({ ...older, registration: 'new' });
    book.load(stale);
    expect(book.open('did:guest', 'course', 'au')?.registration).toBe('new');
    book.forgetLearner('did:guest');
    book.load(stale);
    expect(book.open('did:guest', 'course', 'au')).toBeUndefined();
    const restored = new PlayerBook();
    restored.load(book.toJSON());
    restored.load(stale);
    expect(restored.open('did:guest', 'course', 'au')).toBeUndefined();
    book.link('did:guest-a', 'did:owner', 't');
    book.link('did:guest-b', 'did:owner', 't');
    const home = { homePage: SOURCE, name: 'did:owner' };
    expect(actorAliases({ account: home }).map(actor => actor.account?.name).sort()).toEqual(['did:guest-a', 'did:guest-b']);
    expect(canonicalActorName('did:guest-a')).toBe('did:owner');
    expect(actorAliases({ account: { homePage: SOURCE, name: 'did:guest-a' } }).map(actor => actor.account?.name).sort()).toEqual(['did:guest-b', 'did:owner']);
  });

  it('voids a recording in the statement store with a separate voiding statement', async () => {
    const tenant = `player-void-${randomUUID()}` as typeof DEFAULT_TENANT;
    const id = randomUUID();
    const statement = { id, actor: { objectType: 'Agent', account: { homePage: SOURCE, name: GUEST } }, verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' }, object: { id: 'https://bridge.example/au/1' }, timestamp: new Date().toISOString() };
    expect(await storeStatementDurably(statement, tenant)).toBe(id);
    const result = await voidActorStatements({
      homePage: SOURCE, did: GUEST,
      list: () => getStatementStore(tenant).listAll(),
      store: (next) => storeStatementDurably(next, tenant),
      mark: (target, voiding) => getStatementStore(tenant).markVoided(target, voiding),
    });
    expect(result.forgotten).toBe(1);
    const stored = await getStatementStore(tenant).get(id);
    expect(stored?.voided).toBe(true);
    expect(stored?.voidingStatementId).not.toBe(id);
    const voider = await getStatementStore(tenant).get(stored!.voidingStatementId!);
    expect((voider?.statement.verb as { id: string }).id).toBe('http://adlnet.gov/expapi/verbs/voided');
    expect(internalRefusalOf(voider!.statement)).toEqual([]);
    await clearStatementStore(tenant);
  });

  it('returns a statement written through /learn from that learner lens, and not from another', async () => {
    const guest = learner(GUEST, true);
    const owner = learner(OWNER, false);
    const guestLens = lensTenant(guest);
    const ownerLens = lensTenant(owner);
    expect(guestLens).not.toBe(ownerLens);
    expect(guestLens).not.toBe(DEFAULT_TENANT);
    registerCmi5Course(DEFAULT_TENANT, course);
    const book = new PlayerBook();
    let who = guest;
    const app = express();
    app.use(express.json());
    attachCoursePlayerRoutes(app, {
      baseUrl: HOME, authoritativeSource: SOURCE, book, tenantFor: lensTenant,
      requireLearner: async () => who,
      verifyGuest: async () => guest,
      resolveCourse: async (id) => id === course.id ? course : null,
      satisfied: (tenant, id) => learnerSatisfiedAus(tenant, id),
      stageLaunch: async () => undefined, recordLaunched: async () => undefined,
      forgetActor: async (did, tenant) => {
        const result = await voidActorStatements({
          did, homePage: SOURCE,
          list: () => getStatementStore(tenant).listAll(),
          store: (statement) => storeStatementDurably(statement, tenant),
          mark: (targetId, voidingId) => getStatementStore(tenant).markVoided(targetId, voidingId),
        });
        forgetCmi5Learner(tenant, did);
        return result.forgotten;
      },
      statementIds: async (did, tenant) => (await listStoredStatements(tenant))
        .filter(rec => !rec.voided && (rec.statement.actor as { account?: { name?: string } }).account?.name === did)
        .map(rec => rec.id),
      storeStatement: (statement, tenant) => storeStatementDurably(statement, tenant),
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}`;
    const agentFor = (did: string) => ({ objectType: 'Agent', account: { homePage: SOURCE, name: did } });
    const read = async (tenant: typeof DEFAULT_TENANT, did: string) =>
      (await getStatementStore(tenant).query({ agent: agentFor(did), verb: `${HOME}/learn#consented` })).statements;
    const auId = course.structure[0] && course.structure[0].kind === 'au' ? course.structure[0].id : '';
    try {
      const body = { course_id: course.id, tracking_consent: true };
      const opened = await (await fetch(`${base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as { registration: string };
      who = owner;
      await fetch(`${base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(await read(guestLens, GUEST)).toHaveLength(1);
      expect(await read(ownerLens, GUEST)).toEqual([]);
      expect(await read(DEFAULT_TENANT, GUEST)).toEqual([]);
      expect(await read(ownerLens, OWNER)).toHaveLength(1);
      expect(await read(guestLens, OWNER)).toEqual([]);
      const completed = { verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: auId }, context: { registration: opened.registration }, result: { completion: true } };
      const deps = { statementsForRegistration: async () => [completed], emit: () => undefined };
      await observeCmi5Statement({ verb: { id: 'http://adlnet.gov/expapi/verbs/terminated' }, object: { id: auId }, context: { registration: opened.registration } }, guestLens, deps);
      expect((await observeCmi5Statement(completed, guestLens, deps))?.satisfied).toBe(true);
      expect(learnerSatisfiedAus(guestLens, GUEST)).toContain(auId);
      expect(learnerSatisfiedAus(ownerLens, GUEST)).toEqual([]);
      expect(learnerSatisfiedAus(DEFAULT_TENANT, GUEST)).toEqual([]);
      who = guest;
      const forgotten = await (await fetch(`${base}/learn/forget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json() as { forgotten: number };
      expect(forgotten.forgotten).toBeGreaterThan(0);
      expect(await read(guestLens, GUEST)).toEqual([]);
      expect(await read(ownerLens, OWNER)).toHaveLength(1);
      expect(learnerSatisfiedAus(guestLens, GUEST)).toEqual([]);
    } finally {
      forgetCmi5Learner(guestLens, GUEST);
      forgetCmi5Learner(ownerLens, OWNER);
      await clearStatementStore(guestLens);
      await clearStatementStore(ownerLens);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('copies the guest lens satisfaction onto the owner lens and leaves the guest statements there', async () => {
    const guest = learner(GUEST, true);
    const owner = learner(OWNER, false);
    const guestLens = lensTenant(guest);
    const ownerLens = lensTenant(owner);
    registerCmi5Course(DEFAULT_TENANT, course);
    let who = guest;
    const app = express();
    app.use(express.json());
    attachCoursePlayerRoutes(app, {
      baseUrl: HOME, authoritativeSource: SOURCE, tenantFor: lensTenant,
      requireLearner: async () => who,
      verifyGuest: async () => guest,
      resolveCourse: async (id) => id === course.id ? course : null,
      satisfied: (tenant, id) => learnerSatisfiedAus(tenant, id),
      stageLaunch: async () => undefined, recordLaunched: async () => undefined,
      forgetActor: async () => 0,
      statementIds: async (did, tenant) => (await listStoredStatements(tenant))
        .filter(rec => !rec.voided && (rec.statement.actor as { account?: { name?: string } }).account?.name === did)
        .map(rec => rec.id),
      storeStatement: (statement, tenant) => storeStatementDurably(statement, tenant),
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}`;
    const auId = course.structure[0] && course.structure[0].kind === 'au' ? course.structure[0].id : '';
    try {
      const opened = await (await fetch(`${base}/learn/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ course_id: course.id, tracking_consent: true }) })).json() as { registration: string };
      const completed = { verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: auId }, context: { registration: opened.registration }, result: { completion: true } };
      const deps = { statementsForRegistration: async () => [completed], emit: () => undefined };
      expect((await observeCmi5Statement(completed, guestLens, deps))?.satisfied).toBe(true);
      const catalogueBefore = learnerSatisfiedAus(DEFAULT_TENANT, OWNER);
      who = owner;
      const linked = await fetch(`${base}/learn/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(linked.status).toBe(200);
      expect(learnerSatisfiedAus(ownerLens, OWNER)).toContain(auId);
      expect(learnerSatisfiedAus(guestLens, GUEST)).toContain(auId);
      expect(learnerSatisfiedAus(DEFAULT_TENANT, OWNER)).toEqual(catalogueBefore);
      const claim = await getStatementStore(ownerLens).query({ agent: { objectType: 'Agent', account: { homePage: SOURCE, name: OWNER } }, verb: `${HOME}/learn#claimed` });
      expect(claim.statements).toHaveLength(1);
      expect(await getStatementStore(guestLens).query({ agent: { objectType: 'Agent', account: { homePage: SOURCE, name: OWNER } }, verb: `${HOME}/learn#claimed` })).toMatchObject({ statements: [] });
      const guestConsent = await getStatementStore(guestLens).query({ agent: { objectType: 'Agent', account: { homePage: SOURCE, name: GUEST } }, verb: `${HOME}/learn#consented` });
      expect(guestConsent.statements).toHaveLength(1);
    } finally {
      forgetCmi5Learner(guestLens, GUEST);
      forgetCmi5Learner(ownerLens, OWNER);
      await clearStatementStore(guestLens);
      await clearStatementStore(ownerLens);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
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
