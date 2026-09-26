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
import { buildCmi5Launch, cmi5BearerRegistration, cmi5BearerTenant, redeemFetchToken, signedLaunchLearner, stageLaunchData } from '../src/cmi5-lms.js';
import { attachXapiLrsRoutes, getStatementStore } from '../src/xapi-lrs.js';
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
    bearerTenantResolver: cmi5BearerTenant, bearerRegistrationResolver: cmi5BearerRegistration,
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
    stageLaunchData(tenant, A, au(1).id);
    stageLaunchData(tenant, C, au(1).id);
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

  it('keeps the launch\'s whole actor for the pod: its type and both account fields', () => {
    expect(signedLaunchLearner(A.registration, tenant)).toEqual({ did: learner.id, podUrl: 'https://pod.example/eth-222222222222/', homePage: 'did:web:bridge.example' });
  });
});
