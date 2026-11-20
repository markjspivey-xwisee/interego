/**
 * An activity that is a conversation by voice asks the LMS, with its cmi5 credential, for a live
 * call. The LMS answers for what only it knows (the credential, the session) and asks a practice
 * service for the rest, signing with its own key.
 *
 * Everything here is fictional: the practice service is a fetch double, the key is generated from a
 * test string, the course, the learner and the call credential are made up. No network, no speech.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { importWallet, recoverMessageSigner, sha256, sha256Hex } from '@interego/core';
import { buildCmi5Launch, cmi5BearerSession, observeCmi5Statement, redeemFetchToken } from '../src/cmi5-lms.js';
import { attachLiveCallRoute, liveCallServiceAsk, signedLiveCallRequest } from '../src/cmi5-live-call.js';
import type { TenantId } from '../src/tenant-context.js';

const tenant = 'lens:live-call' as TenantId;
const learner = { id: 'did:ethr:0x4444444444dd00000000000000000000000beef4' };
const AU = { id: 'https://bridge.example/au/live-call', url: 'https://bridge.example/content/au/l/0', moveOn: 'CompletedAndPassed' as const, title: 'A live practice call' };
const COURSE = 'https://bridge.example/courses/live-call';
const wallet = importWallet(`0x${sha256('foxxi-live-call-test-key')}`, 'agent', 'lms');
const SERVICE = { url: 'https://practice.example/acts/live_call_session', podUrl: 'https://pod.practice.example/practice/', action: 'urn:example:action:live-call-session' };
const SCENARIO = { scenarioIri: 'urn:example:scenario:refund-call', scenarioVersion: 3 };

const open = (launchMode: 'Normal' | 'Review' = 'Normal') => {
  const launch = buildCmi5Launch({
    au: AU, learner, lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch',
    authoritativeSource: 'did:web:bridge.example', tenant, courseId: COURSE, launchMode,
  });
  const r = redeemFetchToken(launch.fetchToken);
  if (!r.ok) throw new Error('fetch token did not redeem');
  return { launch, token: r.body['auth-token'] };
};
const terminate = (registration: string): Promise<unknown> => observeCmi5Statement(
  { verb: { id: 'http://adlnet.gov/expapi/verbs/terminated' }, object: { id: AU.id }, context: { registration } }, tenant,
  { statementsForRegistration: async () => [], emit: () => undefined },
);

const CALL = {
  provider: 'example-speech', model: 'speech-model-1', voice: 'calm', transcriptionModel: 'transcriber-1',
  connect: { url: 'https://speech.example/calls', dataChannel: 'events' }, credential: { value: 'fictional-client-secret', expiresAt: '2026-11-19T10:02:00.000Z' },
  counterpartName: 'Dana Reyes', firstLine: 'Hi, I was charged twice.', language: 'en-US', turnLimit: 12, promptTemplateHash: 'a'.repeat(64),
};
// The practice service: answers what the test put there, and keeps what it was sent.
const service = {
  answer: (): { status: number; body: unknown } => ({ status: 200, body: { registration: 'x', call: CALL, disclosure: 'The other person on this call is an AI speech model, not a person.', recorded: false } }),
  seen: [] as { url: string; body: Record<string, string> }[],
  fail: false,
  fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
    if (service.fail) throw new Error('connect ECONNREFUSED');
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
const ask = (root: string, token: string | null, body: unknown = SCENARIO): Promise<Response> => fetch(`${root}/cmi5/live-call`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});

beforeAll(async () => {
  const app = express();
  attachLiveCallRoute(app, {
    session: cmi5BearerSession, limiter: pass,
    ask: liveCallServiceAsk({ ...SERVICE, wallet, fetch: service.fetch, now: () => new Date('2026-11-19T10:00:00.000Z') }),
  });
  [server, base] = await listen(app);
  const bare = express();
  attachLiveCallRoute(bare, { session: cmi5BearerSession, limiter: pass });
  [unset, baseUnset] = await listen(bare);
});
afterAll(async () => {
  await Promise.all([server, unset].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe('POST /cmi5/live-call', () => {
  it('asks the practice service as the LMS, for the session the credential is for, and hands the unit what places the call', async () => {
    const { launch, token } = open();
    const n = service.seen.length;
    const r = await ask(base, token);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json() as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'cmi5-live-call', registration: launch.registration, call: CALL, disclosure: 'The other person on this call is an AI speech model, not a person.' });
    // What the practice service was sent: the LMS's own signature over the registration, the session and the scenario the unit named.
    expect(service.seen).toHaveLength(n + 1);
    const sent = service.seen[n]!;
    expect(sent.url).toBe(SERVICE.url);
    const payload = JSON.parse(sent.body['_signed_payload']!) as Record<string, unknown>;
    expect(payload).toMatchObject({
      agent_id: `did:ethr:${wallet.address}`, v: 1, action: SERVICE.action, pod_url: SERVICE.podUrl, timestamp: '2026-11-19T10:00:00.000Z',
      registration: launch.registration, sessionId: body['sessionId'], ...SCENARIO,
    });
    expect(String(payload['nonce']).length).toBeGreaterThanOrEqual(16);
    expect((await recoverMessageSigner(`sha256:${sha256Hex(sent.body['_signed_payload']!)}`, sent.body['_signature']!)).toLowerCase()).toBe(wallet.address.toLowerCase());
    // The learner's credential is the LMS's to check: it is not sent on.
    expect(JSON.stringify(sent.body)).not.toContain(token);
  });

  it('signs the same request the practice service would check', async () => {
    const q = { registration: '6f1c2f6e-3b1a-4c53-9d2e-0a4b7c9d1e2f', sessionId: 'b7e1a9c4-52d3-4f60-8a17-3c5d9e0f1a2b', ...SCENARIO };
    const signed = await signedLiveCallRequest({ ...SERVICE, wallet }, q, '2026-11-19T10:00:00.000Z', 'nonce-0123456789abcdef');
    expect(JSON.parse(signed._signed_payload)).toEqual({
      agent_id: `did:ethr:${wallet.address}`, v: 1, action: SERVICE.action, timestamp: '2026-11-19T10:00:00.000Z', nonce: 'nonce-0123456789abcdef', pod_url: SERVICE.podUrl,
      scenarioIri: SCENARIO.scenarioIri, scenarioVersion: 3, registration: q.registration, sessionId: q.sessionId,
    });
  });

  it('answers for the credential and the session itself, before asking anyone', async () => {
    const n = service.seen.length;
    expect((await ask(base, null)).status).toBe(401);
    expect((await ask(base, 'not-a-token-this-lms-issued')).status).toBe(401);
    // A Review launch records no result, so it holds no call.
    const review = open('Review');
    const rv = await ask(base, review.token);
    expect([rv.status, (await rv.json() as { error: string }).error]).toEqual([409, 'not_a_normal_launch']);
    // A session that has ended holds no call.
    const done = open();
    await terminate(done.launch.registration);
    const ended = await ask(base, done.token);
    expect([ended.status, (await ended.json() as { error: string }).error]).toEqual([409, 'session_ended']);
    // The unit has to say which scenario it plays, well formed.
    const live = open();
    for (const bad of [{}, { scenarioIri: 'urn:example:scenario:x' }, { scenarioIri: 'no scheme', scenarioVersion: 1 }, { scenarioIri: 'urn:example:scenario:x', scenarioVersion: 0 }, { scenarioIri: 'urn:example:scenario:x', scenarioVersion: 1.5 }]) {
      const r = await ask(base, live.token, bad);
      expect([r.status, (await r.json() as { error: string }).error], JSON.stringify(bad)).toEqual([400, 'scenario_required']);
    }
    expect(service.seen).toHaveLength(n);
  });

  it('says there is no voice service where none is configured, for a credential it would otherwise serve', async () => {
    const { token } = open();
    const r = await ask(baseUnset, token);
    expect([r.status, (await r.json() as { error: string }).error]).toEqual([501, 'no_voice_service']);
    expect((await ask(baseUnset, null)).status).toBe(401);
  });

  it('passes on why no call was opened, as a reason code and a retry time and nothing else', async () => {
    const { token } = open();
    const cases: [number, Record<string, unknown>, number, Record<string, unknown>][] = [
      [429, { kind: 'refusal', 'iep:refusalReason': 'voice-budget-spent', retryAfterSeconds: 1800.2, scope: 'registration', internal: 'not for the unit' }, 429, { error: 'too_many_calls', reason: 'voice-budget-spent', retryAfterSeconds: 1801 }],
      [409, { kind: 'refusal', 'iep:refusalReason': 'registration-already-imported', attemptIri: 'urn:x:attempt:1' }, 409, { error: 'no_call_for_this_registration', reason: 'registration-already-imported' }],
      [404, { kind: 'refusal', 'iep:refusalReason': 'scenario-not-found' }, 409, { error: 'no_call_for_this_registration', reason: 'scenario-not-found' }],
      [501, { kind: 'refusal', 'iep:refusalReason': 'voice-not-configured' }, 501, { error: 'no_voice_service', reason: 'voice-not-configured' }],
      [403, { kind: 'refusal', 'iep:refusalReason': 'not-the-lms' }, 502, { error: 'practice_service_refused', serviceStatus: 403, reason: 'not-the-lms' }],
      [502, { kind: 'refusal', 'iep:refusalReason': 'voice-service-refused', serviceStatus: 401 }, 502, { error: 'practice_service_refused', serviceStatus: 502, reason: 'voice-service-refused' }],
    ];
    for (const [status, body, want, shape] of cases) {
      service.answer = () => ({ status, body });
      const r = await ask(base, token);
      expect(r.status, String(body['iep:refusalReason'])).toBe(want);
      expect(await r.json()).toEqual(shape);
    }
  });

  it('opens no call on an answer it cannot use, and passes the unit only the fields it knows', async () => {
    const { token } = open();
    const unusable: unknown[] = [
      { call: null }, { call: { ...CALL, credential: { value: '', expiresAt: CALL.credential.expiresAt } } }, { call: { ...CALL, credential: { value: 'x', expiresAt: 'soon' } } },
      { call: { ...CALL, connect: { url: 'http://speech.example/calls', dataChannel: 'events' } } }, { call: { ...CALL, connect: { url: 'https://speech.example/calls' } } },
      { kind: 'refusal', call: CALL },
    ];
    for (const body of unusable) {
      service.answer = () => ({ status: 200, body });
      const r = await ask(base, token);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(502);
    }
    // Fields the route does not know are not passed on; ones of the wrong type are left out.
    service.answer = () => ({ status: 200, body: { call: { ...CALL, turnLimit: 'twelve', operatorKey: 'never-for-the-unit', connect: { ...CALL.connect, extra: 1 }, credential: { ...CALL.credential, session: { id: 's' } } }, rubric: { secret: true } } });
    const ok = await (await ask(base, token)).json() as { call: Record<string, unknown> };
    expect(ok.call).toEqual((({ turnLimit: _t, ...rest }) => rest)(CALL));
    expect(JSON.stringify(ok)).not.toContain('never-for-the-unit');
    expect(JSON.stringify(ok)).not.toContain('rubric');
    // An unreachable practice service is said as that.
    service.fail = true;
    const down = await ask(base, token);
    service.fail = false;
    expect([down.status, (await down.json() as { error: string }).error]).toEqual([502, 'practice_service_unreachable']);
  });
});
