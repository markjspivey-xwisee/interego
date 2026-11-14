/**
 * A cmi5 auth-token reads and writes only its own launch.
 *
 * A learner's launches all resolve to their one lens tenant, and the LRS used to treat every token
 * for that tenant as interchangeable. So launch A's token could query the tenant's statements,
 * find launch B's registration, and POST `passed` for B with the learner's actor; the bridge would
 * keep it on the learner's pod and mark B satisfied (the automated review of #478). Now a token
 * carries its registration: a statement it writes must name it, a query is held to it, a statement
 * outside it is not found, and the State it reads and writes is its own launch's.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IRI } from '@interego/core';
import { buildCmi5Launch, cmi5BearerActor, cmi5BearerRegistration, cmi5BearerTenant, redeemFetchToken, signedLaunchLearner, stageLaunchData } from '../src/cmi5-lms.js';
import { attachXapiLrsRoutes, getStatementStore, lmsStatementAuthority, LMS_AUTHORITY_NAME, storeStatementDurably } from '../src/xapi-lrs.js';
import { writeSelfXapi } from '../src/self-xapi.js';
import type { TenantId } from '../src/tenant-context.js';

const tenant = 'lens:token-is-its-launch' as TenantId;
const learner = { id: 'did:ethr:0x2222222222bb00000000000000000000000beef2' };
const au = (n: number) => ({ id: `https://bridge.example/au/${n}`, url: `https://bridge.example/content/au/p/${n}`, moveOn: 'Completed' as const, title: `AU ${n}` });
const launch = (n: number) => buildCmi5Launch({
  au: au(n), learner, lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch',
  authoritativeSource: 'did:web:bridge.example', tenant, learnerPod: 'https://pod.example/eth-222222222222/',
});
const A = launch(1);
const B = launch(2);
const redeem = (fetchToken: string): string => {
  const r = redeemFetchToken(fetchToken);
  if (!r.ok) throw new Error('fetch token did not redeem');
  return r.body['auth-token'];
};
const tokenA = redeem(A.fetchToken);
const tokenB = redeem(B.fetchToken);
/** A second launch of A's AU: same activity, same actor, another registration. */
const C = launch(1);
const tokenC = redeem(C.fetchToken);

let server: Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  attachXapiLrsRoutes(app, {
    podUrl: '', tenantDid: 'did:web:bridge.example' as IRI, basicAuthPairs: '', forwardingTargets: '', selfBaseUrl: 'http://127.0.0.1',
    bearerTenantResolver: cmi5BearerTenant, bearerRegistrationResolver: cmi5BearerRegistration, bearerActorResolver: cmi5BearerActor,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => { server.close(() => r()); }));

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Experience-API-Version': '2.0.0', 'Content-Type': 'application/json' });
const statement = (registration: string, verb: string, id = randomUUID()) => ({
  id, actor: A.actor, verb: { id: `http://adlnet.gov/expapi/verbs/${verb}` },
  object: { objectType: 'Activity', id: au(1).id }, context: { registration },
});
const post = (token: string, body: unknown) => fetch(`${base}/xapi/statements`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
const get = (token: string, query: string) => fetch(`${base}/xapi/statements?${query}`, { headers: headers(token) });

describe('a cmi5 auth-token is bound to its launch', () => {
  it('names the tenant and the registration it was minted for', () => {
    expect(cmi5BearerTenant(tokenA)).toBe(tenant);
    expect(cmi5BearerRegistration(tokenA)).toBe(A.registration);
    expect(cmi5BearerRegistration(tokenB)).toBe(B.registration);
    expect(cmi5BearerRegistration('not-a-token')).toBeNull();
  });

  it('writes its own launch\'s statements, and is refused another launch\'s', async () => {
    expect((await post(tokenA, statement(A.registration, 'initialized'))).status).toBe(200);
    expect((await post(tokenA, statement(B.registration, 'passed'))).status).toBe(403);
    // A batch with one stray statement is refused whole.
    expect((await post(tokenA, [statement(A.registration, 'completed'), statement(B.registration, 'passed')])).status).toBe(403);
    const id = randomUUID();
    const put = await fetch(`${base}/xapi/statements?statementId=${id}`, { method: 'PUT', headers: headers(tokenA), body: JSON.stringify(statement(B.registration, 'passed', id)) });
    expect(put.status).toBe(403);
  });

  it('reads only its own launch: another registration is refused, and another launch\'s statement is not found', async () => {
    const theirs = statement(B.registration, 'initialized');
    expect((await post(tokenB, theirs)).status).toBe(200);
    const mine = await (await get(tokenA, 'limit=50')).json() as { statements: Array<{ context?: { registration?: string } }> };
    expect(mine.statements.length).toBeGreaterThan(0);
    expect(mine.statements.every((s) => s.context?.registration === A.registration)).toBe(true);
    expect((await get(tokenA, `registration=${B.registration}`)).status).toBe(403);
    expect((await get(tokenA, `statementId=${theirs.id}`)).status).toBe(404);
    expect((await get(tokenB, `statementId=${theirs.id}`)).status).toBe(200);
  });

  it('reads and writes the State of its own launch only', async () => {
    const state = (token: string, registration?: string) => {
      const u = new URL(`${base}/xapi/activities/state`);
      u.searchParams.set('activityId', au(1).id);
      u.searchParams.set('agent', JSON.stringify(A.actor));
      u.searchParams.set('stateId', 'LMS.LaunchData');
      if (registration) u.searchParams.set('registration', registration);
      return fetch(u, { headers: headers(token) });
    };
    expect((await state(tokenA, B.registration)).status).toBe(403);
    expect((await state(tokenA)).status).toBe(403);
    expect((await state(tokenA, A.registration)).status).not.toBe(403);
  });

  it('voids only its own launch\'s statements (the review of #485)', async () => {
    const mine = statement(A.registration, 'completed');
    expect((await post(tokenA, mine)).status).toBe(200);
    const voiding = (registration: string) => ({ id: randomUUID(), actor: A.actor, verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: mine.id }, context: { registration } });
    // B's own registration on the voiding statement, A's statement as its target: refused.
    expect((await post(tokenB, voiding(B.registration))).status).toBe(403);
    expect((await get(tokenA, `statementId=${mine.id}`)).status).toBe(200);
    expect((await post(tokenA, voiding(A.registration))).status).toBe(200);
    expect((await get(tokenA, `statementId=${mine.id}`)).status).toBe(404);
  });

  it('checks the target\'s launch as it voids it, not only in an earlier read (the review of #487)', async () => {
    const theirs = statement(A.registration, 'completed');
    expect((await post(tokenA, theirs)).status).toBe(200);
    // B's request reads the target before launch A has stored it (the race), and A's statement is
    // there by the time B's void marks it. The read before is not the check that counts.
    const earlierRead = vi.spyOn(getStatementStore(tenant), 'get').mockResolvedValueOnce(null);
    try {
      const voiding = { id: randomUUID(), actor: A.actor, verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: theirs.id }, context: { registration: B.registration } };
      expect((await post(tokenB, voiding)).status).toBe(200);
      expect(earlierRead).toHaveBeenCalledWith(theirs.id);
    } finally {
      earlierRead.mockRestore();
    }
    // B's voiding statement is its own and is kept, but A's statement is not voided.
    expect((await get(tokenA, `statementId=${theirs.id}`)).status).toBe(200);
    expect((await get(tokenA, `voidedStatementId=${theirs.id}`)).status).toBe(404);
  });

  it('deletes and lists only its own launch\'s State, even for a relaunch of the same AU (the review of #485)', async () => {
    await stageLaunchData(tenant, A, au(1).id);
    await stageLaunchData(tenant, C, au(1).id);
    const scope = (token: string, registration: string, method = 'GET') => {
      const u = new URL(`${base}/xapi/activities/state`);
      u.searchParams.set('activityId', new URL(A.launchUrl).searchParams.get('activityId') ?? '');
      u.searchParams.set('agent', JSON.stringify(A.actor));
      u.searchParams.set('registration', registration);
      return fetch(u, { method, headers: headers(token) });
    };
    expect(await (await scope(tokenC, C.registration)).json()).toEqual(['LMS.LaunchData']);
    expect((await scope(tokenA, A.registration, 'DELETE')).status).toBe(204);
    expect(await (await scope(tokenA, A.registration)).json()).toEqual([]);
    // C's State for the same AU and actor is still there.
    expect(await (await scope(tokenC, C.registration)).json()).toEqual(['LMS.LaunchData']);
  });

  it('takes its auth-token under the Basic scheme, as cmi5 has an AU send it, held to its launch the same way', async () => {
    // cmi5 §8.2.2: the token goes in the Authorization header as RFC 1945 Basic, the token itself.
    const basic = (token: string) => ({ Authorization: `Basic ${token}`, 'X-Experience-API-Version': '2.0.0', 'Content-Type': 'application/json' });
    const send = (token: string, body: unknown) => fetch(`${base}/xapi/statements`, { method: 'POST', headers: basic(token), body: JSON.stringify(body) });
    expect((await send(tokenA, statement(A.registration, 'initialized'))).status).toBe(200);
    expect((await send(tokenA, statement(B.registration, 'passed'))).status).toBe(403);
    expect((await fetch(`${base}/xapi/statements?registration=${B.registration}`, { headers: basic(tokenA) })).status).toBe(403);
    const mine = await (await fetch(`${base}/xapi/statements?limit=50`, { headers: basic(tokenA) })).json() as { statements: Array<{ context?: { registration?: string } }> };
    expect(mine.statements.every((s) => s.context?.registration === A.registration)).toBe(true);
    // A Basic value that is neither a credential nor a launch's token is refused, as a Bearer one is.
    expect((await send('cmi5-0-not-a-launch', statement(A.registration, 'initialized'))).status).toBe(401);
    expect((await send(Buffer.from('user:guess').toString('base64'), statement(A.registration, 'initialized'))).status).toBe(401);
  });

  it('takes a token an AU sends with no scheme, as it came from the fetch URL, held to its launch, and nothing else bare', async () => {
    const bare = (value: string) => ({ Authorization: value, 'X-Experience-API-Version': '2.0.0', 'Content-Type': 'application/json' });
    const send = (value: string, body: unknown) => fetch(`${base}/xapi/statements`, { method: 'POST', headers: bare(value), body: JSON.stringify(body) });
    expect((await send(tokenA, statement(A.registration, 'initialized'))).status).toBe(200);
    expect((await send(tokenA, statement(B.registration, 'passed'))).status).toBe(403);
    expect((await send('cmi5-0-not-a-launch', statement(A.registration, 'initialized'))).status).toBe(401);
    expect((await send(Buffer.from('user:guess').toString('base64'), statement(A.registration, 'initialized'))).status).toBe(401);
  });

  it('does not write the LMS\'s own verbs, or as anyone but the actor it was launched for', async () => {
    expect(cmi5BearerActor(tokenA)).toEqual({ homePage: 'did:web:bridge.example', name: learner.id });
    expect(cmi5BearerActor('not-a-token')).toBeNull();
    const store = getStatementStore(tenant);
    const before = (await store.query({ registration: A.registration })).statements.length;
    const as = (verb: string, actor: unknown = A.actor) => ({
      id: randomUUID(), actor, verb: { id: verb }, object: { objectType: 'Activity', id: au(1).id }, context: { registration: A.registration },
    });
    // cmi5 has the LMS record these. From the unit's token each would be the learner's browser speaking as the LMS.
    // Verb ids, not addresses anything here dials: every request below goes to the loopback LRS.
    const LAUNCHED = 'http://adlnet.gov/expapi/verbs/launched';
    const SATISFIED = 'https://w3id.org/xapi/adl/verbs/satisfied';
    const COMPLETED = 'http://adlnet.gov/expapi/verbs/completed';
    for (const verb of [LAUNCHED, 'https://w3id.org/xapi/adl/verbs/abandoned', 'https://w3id.org/xapi/adl/verbs/waived', SATISFIED]) {
      const r = await post(tokenA, as(verb));
      expect([verb, r.status]).toEqual([verb, 403]);
      expect(String((await r.json() as { error: string }).error)).toContain('is the LMS\'s to record');
    }
    // In a batch, with the scheme an AU uses, and by PUT: the same.
    const batch = [as(COMPLETED), as(SATISFIED)];
    expect((await post(tokenA, batch)).status).toBe(403);
    const asLms = JSON.stringify(as(SATISFIED));
    const basic = await fetch(`${base}/xapi/statements`, { method: 'POST', headers: { ...headers(tokenA), Authorization: `Basic ${tokenA}` }, body: asLms });
    expect(basic.status).toBe(403);
    const one = as(LAUNCHED);
    expect((await fetch(`${base}/xapi/statements?statementId=${one.id}`, { method: 'PUT', headers: headers(tokenA), body: JSON.stringify(one) })).status).toBe(403);
    // As another learner, or as the same name under another homePage: refused.
    const other = { objectType: 'Agent', account: { homePage: 'did:web:bridge.example', name: 'did:ethr:0x9999999999bb00000000000000000000000beef9' } };
    const elsewhere = { objectType: 'Agent', account: { homePage: 'did:web:another-lms.example', name: learner.id } };
    for (const actor of [other, elsewhere, { objectType: 'Agent', mbox: 'mailto:someone@example.org' }]) {
      const wrong = as(COMPLETED, actor);
      const r = await post(tokenA, wrong);
      expect(r.status).toBe(403);
      expect(String((await r.json() as { error: string }).error)).toContain('only as the actor it was launched for');
    }
    // None of it was stored, and the unit's own statements still are.
    expect((await store.query({ registration: A.registration })).statements.length).toBe(before);
    const own = as('http://adlnet.gov/expapi/verbs/experienced');
    expect((await post(tokenA, own)).status).toBe(200);
  });

  it('writes nothing where the LRS is not told which actor a launch token is for', async () => {
    // The same LRS routes, wired as before this rule existed: the registration is known, the actor is not.
    const bare = express();
    bare.use(express.json({ limit: '1mb' }));
    attachXapiLrsRoutes(bare, {
      podUrl: '', tenantDid: 'did:web:bridge.example' as IRI, basicAuthPairs: '', forwardingTargets: '', selfBaseUrl: 'http://127.0.0.1',
      bearerTenantResolver: cmi5BearerTenant, bearerRegistrationResolver: cmi5BearerRegistration,
    });
    const s2 = bare.listen(0, '127.0.0.1');
    await new Promise<void>((r) => s2.once('listening', () => r()));
    try {
      const url = `http://127.0.0.1:${(s2.address() as AddressInfo).port}/xapi/statements`;
      const own = JSON.stringify(statement(A.registration, 'experienced'));
      const r = await fetch(url, { method: 'POST', headers: headers(tokenA), body: own });
      expect(r.status).toBe(403);
      expect(String((await r.json() as { error: string }).error)).toContain('cannot tell which actor');
      // Reading its own launch is not a write and is unaffected.
      expect((await fetch(`${url}?registration=${A.registration}`, { headers: headers(tokenA) })).status).toBe(200);
    } finally { await new Promise<void>((r) => { s2.close(() => r()); }); }
  });

  it('marks the LMS\'s own statements with an authority nobody can send', async () => {
    const SATISFIED = 'https://w3id.org/xapi/adl/verbs/satisfied';
    const LAUNCHED = 'http://adlnet.gov/expapi/verbs/launched';
    const store = getStatementStore(tenant);
    const said = (verb: string, more: Record<string, unknown> = {}) => ({
      id: randomUUID(), actor: A.actor, verb: { id: verb }, object: { objectType: 'Activity', id: au(1).id }, context: { registration: A.registration }, ...more,
    });
    const authorityOf = async (id: string) => ((await store.get(id))!.statement['authority'] as { account: { homePage: string; name: string } }).account;

    // The LMS's own code stores under the LMS's authority, whatever the statement carried in.
    const mine = await storeStatementDurably(said(SATISFIED, { authority: { objectType: 'Agent', account: { homePage: 'https://elsewhere.example', name: 'someone' } } }), tenant, 'lms');
    expect(await authorityOf(mine!)).toEqual(lmsStatementAuthority().account);
    expect(lmsStatementAuthority().account.name).toBe(LMS_AUTHORITY_NAME);

    // Any other internal store does not, and a statement handed to it claiming the authority loses the claim.
    const plain = await storeStatementDurably(said(SATISFIED), tenant);
    const claiming = await storeStatementDurably(said(SATISFIED, { authority: lmsStatementAuthority() }), tenant);
    const shouting = await storeStatementDurably(said(SATISFIED, { authority: { objectType: 'Agent', account: { homePage: 'https://elsewhere.example', name: ' FOXXI-LMS ' } } }), tenant);
    for (const id of [plain, claiming, shouting]) expect((await authorityOf(id!)).name).toBe('foxxi-lrs');

    // Sent in, the claim is refused: by POST, in a batch, and by PUT.
    const claim = said('http://adlnet.gov/expapi/verbs/experienced', { authority: lmsStatementAuthority() });
    const posted = await post(tokenA, claim);
    expect(posted.status).toBe(403);
    expect(String((await posted.json() as { error: string }).error)).toContain('is assigned by this LRS');
    const mixed = [said('http://adlnet.gov/expapi/verbs/experienced'), claim];
    expect((await post(tokenA, mixed)).status).toBe(403);
    const body = JSON.stringify(claim);
    expect((await fetch(`${base}/xapi/statements?statementId=${claim.id}`, { method: 'PUT', headers: headers(tokenA), body })).status).toBe(403);
    expect(await store.get(claim.id)).toBeFalsy();

    // The signed route by which a learner writes about themselves takes none of the LMS's verbs.
    const never = { request: async () => { throw new Error('the LRS must not be asked'); }, persist: async () => null };
    for (const verb of [LAUNCHED, SATISFIED, 'https://w3id.org/xapi/adl/verbs/abandoned', 'https://w3id.org/xapi/adl/verbs/waived']) {
      const r = await writeSelfXapi(learner.id, [{ ...said(verb), timestamp: '2026-11-14T10:00:00.000Z' }], never as never);
      expect([verb, r.status]).toEqual([verb, 403]);
    }
  });

  it('keeps the launch\'s whole actor for the pod: its type and both account fields', () => {
    expect(signedLaunchLearner(A.registration, tenant)).toEqual({ did: learner.id, podUrl: 'https://pod.example/eth-222222222222/', homePage: 'did:web:bridge.example' });
  });
});
