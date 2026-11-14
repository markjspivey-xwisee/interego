/**
 * The shared agent-connection broker, used the way a bridge that is NOT the workbench uses it:
 * its own path and action, the neutral wording, plain `node:http`, and the framework-free
 * browser client talking to it. A scripted driver plays the paired chat session.
 *
 * The workbench's own suite (applications/foxxi-content-intelligence/tests/i2idlx-agent-*) is
 * the proof that lifting the core changed nothing for it; this file is the proof the core
 * stands without it. Everything here is fictional: no model is called and no key is real.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_CONNECTION_BROWSER_CLIENT, AgentConnectionBroker, AgentConnectionError, attachExpress, handleNodeHttp,
  makeDelegatedCallerVerifier, type AgentConnectionNodeOptions, type ExpressLikeRequest, type ExpressLikeResponse,
  type Row, type VerifySignedCaller,
} from '../agent-connection/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:6199';
const PROFILE = { path: '/pairing', action: 'urn:example:pairing' };
const ACTOR = 'did:web:agents.example:fictional-driver';

/** A signed envelope is not what these tests are about: the stub believes what it is told. */
const stubVerifier: VerifySignedCaller = async body => {
  const b = body as { actor?: unknown; payload?: unknown };
  if (typeof b.actor !== 'string' || !b.payload || typeof b.payload !== 'object') return { ok: false, status: 401, error: 'unsigned' };
  return { ok: true, callerDid: b.actor, payload: b.payload as Record<string, unknown> };
};

function refusal(fn: () => unknown, status: number, message?: RegExp): void {
  try { fn(); }
  catch (e) {
    expect(e).toBeInstanceOf(AgentConnectionError);
    expect((e as AgentConnectionError).status).toBe(status);
    if (message) expect((e as Error).message).toMatch(message);
    return;
  }
  throw new Error('expected a refusal');
}

describe('the broker, with no workbench in it', () => {
  it('runs a whole turn: create, claim once, lease, stream, finish', () => {
    let now = 1_000_000;
    const broker = new AgentConnectionBroker({ baseUrl: BASE, profile: PROFILE, now: () => now });
    const created = broker.create('203.0.113.7');
    expect(created['driver_url']).toBe(`${BASE}/pairing/driver`);
    expect(created['action']).toBe('urn:example:pairing');
    const protocol = created['protocol'] as { driver: { signed_fields: Row } };
    // The neutral names: nothing of the workbench's is in a profile that did not ask for it.
    expect(protocol.driver.signed_fields).toEqual({ connection_operation: 'agent-session', bridge_audience: BASE, session_id: created['session_id'] });
    expect(JSON.stringify(created)).not.toMatch(/i2idlx|workbench|learning/i);

    const signed = { connection_operation: 'agent-session', bridge_audience: BASE, session_id: created['session_id'] };
    const claimed = broker.driver({ ...signed, operation: 'claim', invite_token: created['invite_token'] }, ACTOR);
    const driverToken = claimed['driver_token'] as string;
    expect(claimed['state']).toBe('connected');
    // One use.
    refusal(() => broker.driver({ ...signed, operation: 'claim', invite_token: created['invite_token'] }, 'did:web:agents.example:someone-else'), 403);
    // Bound to this operation and this origin.
    refusal(() => broker.driver({ ...signed, connection_operation: 'something-else', operation: 'next', driver_token: driverToken }, ACTOR), 403, /this operation and service/);
    refusal(() => broker.driver({ ...signed, bridge_audience: 'http://elsewhere.example', operation: 'next', driver_token: driverToken }, ACTOR), 403);

    const browser = (operation: string, extra: Row = {}) => broker.browser({ session_id: created['session_id'], operation, ...extra }, created['browser_token']);
    expect(broker.driver({ ...signed, operation: 'next', driver_token: driverToken }, ACTOR)['state']).toBe('idle');
    const queued = browser('request', { messages: [{ role: 'user', content: 'Count the made-up apples.' }] });
    refusal(() => browser('request', { messages: [{ role: 'user', content: 'again' }] }), 409);
    const leased = broker.driver({ ...signed, operation: 'next', driver_token: driverToken }, ACTOR);
    expect(leased['turn_id']).toBe(queued['turn_id']);
    expect((leased['task'] as { messages: unknown[] }).messages).toHaveLength(1);
    const turn = { ...signed, driver_token: driverToken, turn_id: leased['turn_id'], lease_id: leased['lease_id'] };
    const streamed = broker.driver({ ...turn, operation: 'emit', revision: leased['revision'], text: 'Seven' }, ACTOR);
    refusal(() => broker.driver({ ...turn, operation: 'emit', revision: streamed['revision'], text: 'Eight' }, ACTOR), 409, /extend/);
    const finished = broker.driver({ ...turn, operation: 'finish', revision: streamed['revision'], text: 'Seven apples.' }, ACTOR);
    expect(finished['state']).toBe('completed');
    expect(browser('poll', { turn_id: queued['turn_id'] })).toMatchObject({ state: 'completed', text: 'Seven apples.' });

    // A lease that ran out is not finishable; the session itself ends, and says so.
    browser('request', { messages: [{ role: 'user', content: 'And the pears?' }] });
    const second = broker.driver({ ...signed, operation: 'next', driver_token: driverToken }, ACTOR);
    now += 61_000;
    refusal(() => broker.driver({ ...signed, driver_token: driverToken, turn_id: second['turn_id'], lease_id: second['lease_id'], operation: 'finish', revision: second['revision'], text: 'late' }, ACTOR), 409);
    now += 31 * 60_000;
    refusal(() => browser('status'), 410);
    broker.dispose();
  });

  it('refuses a profile it could not route, and only ever lowers its ceilings', () => {
    for (const profile of [{ path: 'pairing', action: 'urn:x' }, { path: '/pairing/', action: 'urn:x' }, { path: '/pairing', action: ' ' }, { path: '/pairing', action: 'urn:x', signedOperationField: 'Not Valid' }]) {
      expect(() => new AgentConnectionBroker({ baseUrl: BASE, profile }), JSON.stringify(profile)).toThrow(/profile/);
    }
    const small = new AgentConnectionBroker({ baseUrl: BASE, profile: PROFILE, outputBytes: 64 });
    const created = small.create();
    expect((created['protocol'] as { limits: { text_bytes: number } }).limits.text_bytes).toBe(64);
    const signed = { connection_operation: 'agent-session', bridge_audience: BASE, session_id: created['session_id'] };
    const token = small.driver({ ...signed, operation: 'claim', invite_token: created['invite_token'] }, ACTOR)['driver_token'];
    small.browser({ session_id: created['session_id'], operation: 'request', messages: [{ role: 'user', content: 'x' }] }, created['browser_token']);
    const leased = small.driver({ ...signed, operation: 'next', driver_token: token }, ACTOR);
    refusal(() => small.driver({ ...signed, driver_token: token, turn_id: leased['turn_id'], lease_id: leased['lease_id'], operation: 'finish', revision: leased['revision'], text: 'y'.repeat(65) }, ACTOR), 400, /too large/);
    small.dispose();
    const wide = new AgentConnectionBroker({ baseUrl: BASE, profile: PROFILE, outputBytes: 10 ** 9, maxSessions: 10 ** 6 });
    expect(((wide.create()['protocol'] as { limits: { text_bytes: number } }).limits.text_bytes)).toBe(128 * 1024);
    wide.dispose();
  });

  it('imports no web framework, names no vertical in its code, and reads no environment', () => {
    for (const file of ['broker.ts', 'http.ts', 'signed-caller.ts', 'index.ts', 'browser-client.js']) {
      const source = readFileSync(join(here, '../agent-connection', file), 'utf8');
      expect(source, file).not.toMatch(/from 'express|from "express|express-rate-limit|process\.env/);
      // Comments may say where the code came from. Code may not depend on it.
      const code = source.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
      expect(code, file).not.toMatch(/i2idlx|foxxi|workbench|grok|cursor\.sh/i);
    }
  });
});

describe('the HTTP adapters', () => {
  const servers: Server[] = [];
  const brokers: AgentConnectionBroker[] = [];
  afterEach(async () => {
    for (const broker of brokers.splice(0)) broker.dispose();
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  });

  async function nodeFixture(options: AgentConnectionNodeOptions = {}): Promise<{ url: string; broker: AgentConnectionBroker }> {
    const holder: { broker?: AgentConnectionBroker } = {};
    const server = createServer((req, res) => {
      void (async () => {
        if (!holder.broker || !await handleNodeHttp(req, res, holder.broker, options)) { res.writeHead(404); res.end('{"error":"not-found"}'); }
      })();
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const url = `http://127.0.0.1:${address.port}`;
    holder.broker = new AgentConnectionBroker({ baseUrl: url, profile: PROFILE });
    brokers.push(holder.broker);
    return { url, broker: holder.broker };
  }
  const post = async (url: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: await response.json() as Row };
  };

  it('node:http serves the three routes, leaves every other path alone, and never puts input in a URL', async () => {
    const { url } = await nodeFixture({ verifyCaller: stubVerifier });
    expect((await post(url, '/pairing/nothing', {})).status).toBe(404);
    expect((await fetch(url + '/pairing/create')).status).toBe(404);
    const created = await post(url, '/pairing/create', {});
    expect(created.status).toBe(200);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(created.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await post(url, '/pairing/create?x=1', {})).status).toBe(400);
    expect((await post(url, '/pairing/create', { extra: true })).status).toBe(400);
    expect((await post(url, '/pairing/create', {}, { Origin: 'http://elsewhere.example' })).status).toBe(403);
    const bearer = { Authorization: `Bearer ${String(created.body['browser_token'])}` };
    expect((await post(url, '/pairing/browser', { session_id: created.body['session_id'], operation: 'status' }, bearer)).body['state']).toBe('waiting_for_agent');
    // Without the capability the session does not exist, as far as anyone can tell.
    expect((await post(url, '/pairing/browser', { session_id: created.body['session_id'], operation: 'status' })).status).toBe(404);
    const bad = await fetch(url + '/pairing/browser', { method: 'POST', body: '{not json' });
    expect(bad.status).toBe(400);
    const signed = { connection_operation: 'agent-session', bridge_audience: url, session_id: created.body['session_id'] };
    expect((await post(url, '/pairing/driver', { payload: { ...signed, operation: 'claim', invite_token: created.body['invite_token'] } })).status).toBe(401);
    const claimed = await post(url, '/pairing/driver', { actor: ACTOR, payload: { ...signed, operation: 'claim', invite_token: created.body['invite_token'] } });
    expect(claimed.status).toBe(200);
    expect(typeof claimed.body['driver_token']).toBe('string');
    expect((await post(url, '/pairing/browser', { session_id: created.body['session_id'], operation: 'status' }, bearer)).body['driver']).toEqual({ actor: ACTOR });
  });

  it('with no verifier nobody can drive; hooks decide who may create, what a page may do, and who is limited', async () => {
    const owners: unknown[] = [];
    let limited = false;
    const { url } = await nodeFixture({
      authorizeCreate: request => { if (request.authorization !== 'Bearer made-up-sign-in') throw new AgentConnectionError('Sign in first.', 401); return 'fictional-owner'; },
      created: (_reply, owner) => { owners.push(owner); },
      browserOperations: ['status'],
      admit: route => limited && route === 'driver' ? { retryAfterSeconds: 7 } : null,
    });
    expect((await post(url, '/pairing/create', {})).status).toBe(401);
    const created = await post(url, '/pairing/create', {}, { Authorization: 'Bearer made-up-sign-in' });
    expect(created.status).toBe(200);
    expect(owners).toEqual(['fictional-owner']);
    const bearer = { Authorization: `Bearer ${String(created.body['browser_token'])}` };
    expect((await post(url, '/pairing/browser', { session_id: created.body['session_id'], operation: 'status' }, bearer)).status).toBe(200);
    expect((await post(url, '/pairing/browser', { session_id: created.body['session_id'], operation: 'request', messages: [{ role: 'user', content: 'x' }] }, bearer)).status).toBe(400);
    const unverifiable = await post(url, '/pairing/driver', { actor: ACTOR, payload: {} });
    expect(unverifiable.status).toBe(503);
    limited = true;
    const refused = await post(url, '/pairing/driver', { actor: ACTOR, payload: {} });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('7');
  });

  it('express gets the same routes and answers from the same function, behind the bridge\'s own middleware', async () => {
    const broker = new AgentConnectionBroker({ baseUrl: BASE, profile: PROFILE });
    brokers.push(broker);
    const routes = new Map<string, Array<(req: ExpressLikeRequest, res: ExpressLikeResponse, next: () => void) => unknown>>();
    const app = { post: (path: string, ...handlers: never[]) => { routes.set(path, handlers as never); } };
    const seen: string[] = [];
    attachExpress(app, broker, {
      verifyCaller: stubVerifier, stripBodyFields: ['__added_by_host'],
      admission: { browser: (_req: unknown, _res: unknown, next: () => void) => { seen.push('browser-limit'); next(); } },
    });
    expect([...routes.keys()]).toEqual(['/pairing/create', '/pairing/browser', '/pairing/driver']);
    expect(routes.get('/pairing/browser')).toHaveLength(2);
    expect(routes.get('/pairing/create')).toHaveLength(1);
    const call = async (path: string, body: unknown, headers: Record<string, string> = {}, query: object = {}) => {
      const answer: { status: number; headers: Record<string, string>; body: Row } = { status: 200, headers: {}, body: {} };
      const res: ExpressLikeResponse = {
        status(code) { answer.status = code; return res; }, set(name, value) { answer.headers[name] = value; return res; },
        json(value) { answer.body = value as Row; return undefined; },
      };
      const req: ExpressLikeRequest = { query, body, ip: '203.0.113.9', socket: {}, get: name => headers[name] };
      const handlers = routes.get(path) ?? [];
      for (const handler of handlers) {
        let went = false;
        await handler(req, res, () => { went = true; });
        if (!went) break;
      }
      return answer;
    };
    const created = await call('/pairing/create', { __added_by_host: 'ignored' });
    expect(created.status).toBe(200);
    expect(created.headers).toEqual({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    expect((await call('/pairing/create', {}, {}, { token: 'in-a-url' })).status).toBe(400);
    const status = await call('/pairing/browser', { session_id: created.body['session_id'], operation: 'status' }, { Authorization: `Bearer ${String(created.body['browser_token'])}` });
    expect(status.body['state']).toBe('waiting_for_agent');
    expect(seen).toEqual(['browser-limit']);
    // Background monitoring is configured only from the service's own https page.
    const monitoring = await call('/pairing/browser', { session_id: created.body['session_id'], operation: 'configure_monitoring', routine: {} }, { Authorization: `Bearer ${String(created.body['browser_token'])}` });
    expect(monitoring.status).toBe(403);
    expect(monitoring.headers).toEqual({ 'Cache-Control': 'no-store' });
  });

  it('the browser client connects, shows an invitation an agent can act on, follows a turn, and disconnects', async () => {
    const { url } = await nodeFixture({ verifyCaller: stubVerifier });
    const module = await import(pathToFileURL(AGENT_CONNECTION_BROWSER_CLIENT).href) as {
      createAgentConnectionClient(config: Row): {
        connect(): Promise<string>; refresh(): Promise<Row>; status(): Row; disconnect(): Promise<void>; renewInvitation(): Promise<string>;
        request(input: string, options?: Row): Promise<{ text: string; toolCalls: unknown[] }>;
        subscribe(listener: (status: Row) => void): () => void;
      };
    };
    const states: string[] = [];
    const client = module.createAgentConnectionClient({
      root: '/pairing', origin: () => url, pollMs: 5, page: 'this made-up page', purpose: 'Answer about fictional fruit.',
      fetch: (path: string, init: RequestInit) => fetch(url + path, init),
    });
    client.subscribe(status => { states.push(String(status['state'])); });
    const invitation = await client.connect();
    expect(invitation).toContain('this made-up page');
    expect(invitation).toContain('Answer about fictional fruit.');
    expect(invitation).toContain(`${url}/pairing/driver`);
    // The template in the text is a real claim: an agent that signs exactly it is paired.
    const template = JSON.parse(invitation.slice(invitation.indexOf('Claim call template: ') + 21).split('\n\n')[0] ?? '') as { target: string; action: string; method: string; payload: Row };
    expect(template).toMatchObject({ target: `${url}/pairing/driver`, action: 'urn:example:pairing', method: 'POST' });
    const drive = (payload: Row) => post(url, '/pairing/driver', { actor: ACTOR, payload });
    const claimed = await drive(template.payload);
    expect(claimed.status).toBe(200);
    expect((await client.refresh())['driverActor']).toBe(ACTOR);
    const signed = { connection_operation: 'agent-session', bridge_audience: url, session_id: template.payload['session_id'], driver_token: claimed.body['driver_token'] };
    const pieces: string[] = [];
    const asking = client.request('How many made-up pears?', { onText: (event: { text: string }) => { pieces.push(event.text); } });
    let leased = await drive({ ...signed, operation: 'next' });
    for (let i = 0; i < 200 && leased.body['state'] === 'idle'; i++) { await new Promise(resolve => setTimeout(resolve, 5)); leased = await drive({ ...signed, operation: 'next' }); }
    const turn = { ...signed, turn_id: leased.body['turn_id'], lease_id: leased.body['lease_id'] };
    const streamed = await drive({ ...turn, operation: 'emit', revision: leased.body['revision'], text: 'Three' });
    await new Promise(resolve => setTimeout(resolve, 30));
    await drive({ ...turn, operation: 'finish', revision: streamed.body['revision'], text: 'Three pears.' });
    expect(await asking).toEqual({ text: 'Three pears.', truncated: false, toolCalls: [] });
    expect(pieces.at(-1)).toBe('Three pears.');
    const renewed = await client.renewInvitation();
    expect(renewed).not.toBe(invitation);
    expect(client.status()['state']).toBe('waiting_for_agent');
    await client.disconnect();
    expect(client.status()['state']).toBe('disconnected');
    expect((await drive({ ...signed, operation: 'next' })).status).toBe(410);
    expect(states).toContain('connecting');
  });
});

describe('who signed a driver request', () => {
  const SIGNER = '0x00000000000000000000000000000000000000a1';
  const ANCHOR = '0x00000000000000000000000000000000000000b2';
  const AGENT = 'did:web:agents.example:fictional-delegate';
  const deps = (over: Partial<Parameters<typeof makeDelegatedCallerVerifier>[0]> = {}) => {
    const pods: string[] = [];
    const verify = makeDelegatedCallerVerifier({
      recover: body => {
        const b = body as { signer?: string; agentId?: string };
        return b.signer && b.agentId ? { ok: true, signer: b.signer, agentId: b.agentId, payload: { made: 'up' } } : { ok: false, reason: 'missing _signature' };
      },
      delegationPod: agentId => `https://pods.example/${agentId.split(':').at(-1)}/`,
      delegation: async (_agent, pod) => { pods.push(pod); return { verified: true, anchor: ANCHOR }; },
      ...over,
    });
    return { verify, pods };
  };

  it('believes a key that signs as itself without reading any pod', async () => {
    const { verify, pods } = deps();
    expect(await verify({ signer: SIGNER, agentId: `did:ethr:${SIGNER.toUpperCase().replace('0X', '0x')}` }, true)).toEqual({ ok: true, callerDid: `did:ethr:${SIGNER}`, payload: { made: 'up' } });
    expect(pods).toEqual([]);
  });

  it('believes a request signed for an agent only when its delegation verifies and the signer anchors it', async () => {
    const { verify, pods } = deps();
    expect(await verify({ signer: ANCHOR, agentId: AGENT }, true)).toEqual({ ok: true, callerDid: AGENT, payload: { made: 'up' } });
    // The pod came from the agent id, not from anything the request said.
    expect(pods).toEqual(['https://pods.example/fictional-delegate/']);
    expect(await verify({ signer: SIGNER, agentId: AGENT }, true)).toMatchObject({ ok: false, status: 401, error: expect.stringMatching(/anchor/) as unknown });
    expect(await deps({ delegation: async () => ({ verified: false, reason: 'SelfAsserted' }) }).verify({ signer: ANCHOR, agentId: AGENT }, true)).toMatchObject({ ok: false, status: 401 });
    expect(await deps({ delegation: async () => { throw new Error('private detail'); } }).verify({ signer: ANCHOR, agentId: AGENT }, true)).toEqual({ ok: false, status: 401, error: 'delegation verification failed' });
    expect(await deps({ delegationPod: () => undefined }).verify({ signer: ANCHOR, agentId: AGENT }, true)).toMatchObject({ ok: false, status: 401 });
    expect(await verify({}, true)).toMatchObject({ ok: false, status: 401, error: expect.stringMatching(/signature required/) as unknown });
  });
});
