/**
 * An activity judged after its session asks the LMS, with its cmi5 credential, for the passed,
 * failed or completed it may now send. The LMS answers for what only it knows (the credential, the
 * session) and asks a review service for the rest, signing with its own key.
 *
 * Everything here is fictional: the review service is a fetch double, the key is generated from a
 * test string, the course and learner are made up. No network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { importWallet, recoverMessageSigner, sha256, sha256Hex } from '@interego/core';
import { buildCmi5Launch, cmi5BearerSession, findResumableLaunch, observeCmi5Statement, redeemFetchToken } from '../src/cmi5-lms.js';
import { attachReviewedStatementsRoute, reviewServiceAsk, signedReviewRequest } from '../src/cmi5-reviewed.js';
import type { TenantId } from '../src/tenant-context.js';

const tenant = 'lens:reviewed-statements' as TenantId;
const learner = { id: 'did:ethr:0x3333333333cc00000000000000000000000beef3' };
const AU = { id: 'https://bridge.example/au/practice', url: 'https://bridge.example/content/au/p/0', moveOn: 'Passed' as const, title: 'A practice call' };
const COURSE = 'https://bridge.example/courses/practice';
const wallet = importWallet(`0x${sha256('foxxi-reviewed-test-key')}`, 'agent', 'lms');
const SERVICE = { url: 'https://review.example/acts/launched_statements', podUrl: 'https://pod.review.example/practice/', action: 'urn:example:action:launched-statements' };

const open = (launchMode: 'Normal' | 'Review' = 'Normal', resume?: { registration: string; newSession?: boolean }) => {
  const launch = buildCmi5Launch({
    au: AU, learner, lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch',
    authoritativeSource: 'did:web:bridge.example', tenant, courseId: COURSE, ...(resume ? { resume } : { launchMode }),
  });
  const r = redeemFetchToken(launch.fetchToken);
  if (!r.ok) throw new Error('fetch token did not redeem');
  return { launch, token: r.body['auth-token'] };
};
const terminate = (registration: string): Promise<unknown> => observeCmi5Statement(
  { verb: { id: 'http://adlnet.gov/expapi/verbs/terminated' }, object: { id: AU.id }, context: { registration } }, tenant,
  { statementsForRegistration: async () => [], emit: () => undefined },
);

// The review service: answers what the test put there, and keeps what it was sent.
const service = {
  answer: (): { status: number; body: unknown } => ({ status: 409, body: { kind: 'refusal', 'iep:refusalReason': 'attempt-not-countersigned' } }),
  seen: [] as { url: string; body: Record<string, string> }[],
  fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
    service.seen.push({ url: String(u), body: JSON.parse(String(init?.body)) as Record<string, string> });
    const a = service.answer();
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch,
};

let server: Server;
let unset: Server;
let base = '';
let baseUnset = '';
const pass: express.RequestHandler = (_req, _res, next) => next();
const listen = async (app: express.Express): Promise<[Server, string]> => {
  const s = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => s.once('listening', () => resolve()));
  return [s, `http://127.0.0.1:${(s.address() as AddressInfo).port}`];
};

beforeAll(async () => {
  const app = express();
  attachReviewedStatementsRoute(app, {
    session: cmi5BearerSession, limiter: pass,
    ask: reviewServiceAsk({ ...SERVICE, wallet, fetch: service.fetch, now: () => new Date('2026-11-14T10:00:00.000Z') }),
  });
  [server, base] = await listen(app);
  const bare = express();
  attachReviewedStatementsRoute(bare, { session: cmi5BearerSession, limiter: pass });
  [unset, baseUnset] = await listen(bare);
});
afterAll(async () => {
  await Promise.all([server, unset].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

const get = async (token?: string, from = base): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(`${from}/cmi5/reviewed`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};

describe('GET /cmi5/reviewed', () => {
  it('answers only a credential this LMS issued, and asks nobody for anything else', async () => {
    expect((await get()).status).toBe(401);
    expect((await get('cmi5-0-00000000-0000-4000-8000-000000000000')).status).toBe(401);
    expect(service.seen).toEqual([]);
  });

  it('says so where no review service is set up', async () => {
    const { token } = open();
    const r = await get(token, baseUnset);
    expect([r.status, r.body['error']]).toEqual([501, 'no_review_service']);
  });

  it('refuses a Review launch and an ended session itself, without asking', async () => {
    const review = open('Review');
    const r = await get(review.token);
    expect([r.status, r.body['error']]).toEqual([409, 'not_a_normal_launch']);
    const ended = open();
    await terminate(ended.launch.registration);
    const e = await get(ended.token);
    expect([e.status, e.body['error']]).toEqual([409, 'session_ended']);
    expect(service.seen).toEqual([]);
  });

  it('asks the review service as itself, for the registration and session the credential belongs to', async () => {
    const first = open();
    const session = cmi5BearerSession(first.token)!;
    expect(session).toMatchObject({ registration: first.launch.registration, launchMode: 'Normal', closed: false });

    // Not reviewed yet: the unit is told it has nothing to send, with the service's reason and none of its other words.
    const waiting = await get(first.token);
    expect([waiting.status, waiting.body['error'], waiting.body['reason']]).toEqual([409, 'no_reviewed_statements', 'attempt-not-countersigned']);
    service.answer = () => ({ status: 404, body: { kind: 'refusal', 'iep:refusalReason': 'registration-not-taken' } });
    expect((await get(first.token)).body['error']).toBe('registration_not_under_review');

    // What the LMS sent: a signed-request envelope by its own key, naming this registration and session and nothing of the unit's token.
    const sent = service.seen[0]!;
    expect(sent.url).toBe(SERVICE.url);
    expect(Object.keys(sent.body).sort()).toEqual(['_signature', '_signed_payload']);
    const payload = JSON.parse(sent.body['_signed_payload']!) as Record<string, unknown>;
    expect(payload).toMatchObject({
      agent_id: `did:ethr:${wallet.address}`, v: 1, action: SERVICE.action, pod_url: SERVICE.podUrl,
      registration: session.registration, sessionId: session.sessionId, timestamp: '2026-11-14T10:00:00.000Z',
    });
    expect(recoverMessageSigner(`sha256:${sha256Hex(sent.body['_signed_payload']!)}`, sent.body['_signature']!).toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(JSON.stringify(sent.body)).not.toContain(first.token);
    // Each ask is signed afresh: the review service spends a nonce once.
    expect(new Set(service.seen.map((x) => (JSON.parse(x.body['_signed_payload']!) as { nonce: string }).nonce)).size).toBe(service.seen.length);
  });

  it('hands the unit the documents the review service fixed, and says when they are not for this session', async () => {
    const first = open();
    const statements = [{ id: '00000000-0000-4000-8000-000000000001', verb: { id: 'http://adlnet.gov/expapi/verbs/passed' } }, { id: '00000000-0000-4000-8000-000000000002', verb: { id: 'http://adlnet.gov/expapi/verbs/completed' } }];
    service.answer = () => ({ status: 200, body: { statements, usableInSession: true, usableOnlyIn: 'this', again: false, forUnit: { anything: 'else' } } });
    const r = await get(first.token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'cmi5-reviewed-statements', registration: first.launch.registration, statements, usableInSession: true });
    expect(r.body['forUnit']).toBeUndefined();
    service.answer = () => ({ status: 200, body: { statements, usableInSession: false, usableOnlyIn: 'an-earlier-session' } });
    expect((await get(first.token)).body).toMatchObject({ usableInSession: false, usableOnlyIn: 'an-earlier-session' });
    // A refusal that arrives as 200, or an answer with no statements, hands out nothing.
    service.answer = () => ({ status: 200, body: { kind: 'refusal', statements } });
    expect((await get(first.token)).status).toBe(502);
    service.answer = () => ({ status: 500, body: null });
    expect((await get(first.token)).body).toMatchObject({ error: 'review_service_refused', reviewStatus: 500 });
  });

  it('follows the registration into its next session: the new credential asks for the new session', async () => {
    const first = open();
    await terminate(first.launch.registration);
    const again = findResumableLaunch({ tenant, learnerId: learner.id, courseId: COURSE, auId: AU.id });
    expect(again).toMatchObject({ registration: first.launch.registration, newSession: true });
    const second = open('Normal', again);
    expect(second.launch.registration).toBe(first.launch.registration);
    const session = cmi5BearerSession(second.token)!;
    expect(session.closed).toBe(false);
    const seen = service.seen.length;
    service.answer = () => ({ status: 409, body: { kind: 'refusal', 'iep:refusalReason': 'attempt-not-countersigned' } });
    await get(second.token);
    const payload = JSON.parse(service.seen[seen]!.body['_signed_payload']!) as { registration: string; sessionId: string };
    expect([payload.registration, payload.sessionId]).toEqual([first.launch.registration, session.sessionId]);
  });

  it('signs what it says it signs', async () => {
    const e = await signedReviewRequest({ ...SERVICE, wallet }, { registration: 'r', sessionId: 's' }, '2026-11-14T10:00:00.000Z', 'n-1');
    expect(JSON.parse(e._signed_payload)).toEqual({
      agent_id: `did:ethr:${wallet.address}`, v: 1, action: SERVICE.action, timestamp: '2026-11-14T10:00:00.000Z', nonce: 'n-1', pod_url: SERVICE.podUrl, registration: 'r', sessionId: 's',
    });
  });
});
