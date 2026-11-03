import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import express from 'express';
import {
  AgentSessionError, AgentSessionStore, attachAgentSessionRoutes, AGENT_SESSION_PATH, AGENT_DRIVER_REQUESTS_PER_MINUTE,
} from '../src/i2idlx-agent-sessions.js';

const BASE = 'https://workbench.example';
const ALICE = 'did:web:identity.example:agents:alice';
const BOB = 'did:web:identity.example:agents:bob';
const tool = { name: 'get_concept', description: 'Read a public concept.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } };
const task = { messages: [{ role: 'user', content: 'Explain formative assessment with a source citation.' }], tools: [tool] };
function fixture(config: { sessionTtlMs?: number; inviteTtlMs?: number; leaseTtlMs?: number; requestTtlMs?: number; maxSessions?: number } = {}) {
  let now = 1_000_000;
  const store = new AgentSessionStore({ baseUrl: BASE, now: () => now, ...config });
  const made = store.create('ip-1');
  const sid = made.session_id;
  let driverToken: unknown;
  const browser = (operation: string, extra = {}) => store.browser({ session_id: sid, operation, ...extra }, made.browser_token);
  const driver = (operation: string, extra = {}, actor = ALICE) => {
    const result = store.driver({ i2idlx_operation: 'agent-session', bridge_audience: BASE, session_id: sid, operation, ...(driverToken ? { driver_token: driverToken } : {}), ...extra }, actor);
    if (operation === 'claim') driverToken = result.driver_token;
    return result;
  };
  const connect = () => driver('claim', { invite_token: made.invite_token });
  const queue = () => browser('request', task);
  const next = () => driver('next');
  const finish = (lease: Record<string, unknown>, extra = {}) => driver('finish', { turn_id: lease.turn_id, lease_id: lease.lease_id, revision: lease.revision, text: 'A grounded answer [[formative-assessment]].', ...extra });
  return { store, made, sid, browser, driver, connect, queue, next, finish, advance: (ms: number) => { now += ms; } };
}
function fails(fn: () => unknown, status: number): void {
  assert.throws(fn, e => e instanceof AgentSessionError && e.status === status);
}
function row(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

describe('explicit, ephemeral external-agent workbench sessions', () => {
  it('keeps browser credentials out of driver discovery and consumes the invitation once', () => {
    const f = fixture();
    assert.match(String(f.made.browser_token), /^[a-f0-9]{64}$/);
    assert.match(String(f.made.invite_token), /^[a-f0-9]{64}$/);
    assert.notEqual(f.made.browser_token, f.made.invite_token);
    const protocol = JSON.stringify(f.made.protocol);
    assert.ok(!protocol.includes(String(f.made.browser_token)) && !protocol.includes(String(f.made.invite_token)));
    assert.equal(row(row(f.made.protocol).driver).target, BASE + AGENT_SESSION_PATH + '/driver');
    fails(() => f.queue(), 409);
    const attached = f.connect();
    assert.equal(row(attached.driver).actor, ALICE);
    assert.match(String(attached.driver_token), /^[a-f0-9]{64}$/);
    assert.notEqual(attached.driver_token, f.made.browser_token);
    assert.equal(f.browser('status').driver_token, undefined);
    assert.equal(attached.pending, null);
    fails(() => f.connect(), 403);
    assert.equal(f.browser('status').state, 'connected');
  });

  it('requires the paired-session driver capability even when another conversation has the same actor DID', () => {
    const f = fixture(); const claimed = f.connect(); f.queue();
    const signed = { i2idlx_operation: 'agent-session', bridge_audience: BASE, session_id: f.sid, operation: 'next' };
    fails(() => f.store.driver(signed, ALICE), 403);
    fails(() => f.store.driver({ ...signed, driver_token: '0'.repeat(64) }, ALICE), 403);
    fails(() => f.store.driver({ ...signed, driver_token: f.made.browser_token }, ALICE), 403);
    assert.equal(f.store.driver({ ...signed, driver_token: claimed.driver_token }, ALICE).state, 'running');
    const newInvite = f.browser('invite');
    const newer = f.driver('claim', { invite_token: newInvite.invite_token });
    fails(() => f.store.driver({ ...signed, driver_token: claimed.driver_token }, ALICE), 403);
    assert.equal(f.store.driver({ ...signed, driver_token: newer.driver_token }, ALICE).state, 'idle');
  });

  it('streams actual cumulative snapshots and completes one revision-bound request', () => {
    const f = fixture(); f.connect();
    const queued = f.queue(); assert.equal(queued.state, 'queued'); assert.equal(queued.revision, 0);
    const running = f.next(); assert.equal(running.state, 'running'); assert.equal(running.revision, 1);
    assert.deepEqual(row(running.task).messages, task.messages);
    assert.deepEqual(row(running.task).tools, task.tools);
    const streamed = f.driver('emit', { turn_id: running.turn_id, lease_id: running.lease_id, revision: running.revision, text: 'A grounded' });
    assert.equal(streamed.revision, 2);
    assert.equal(f.browser('poll', { turn_id: running.turn_id, after_revision: 1 }).text, 'A grounded');
    const done = f.finish({ ...running, revision: streamed.revision });
    assert.equal(done.state, 'completed'); assert.equal(done.revision, 3);
    assert.equal(f.next().state, 'idle');
    fails(() => f.finish({ ...running, revision: streamed.revision }), 409);
    assert.equal(f.browser('poll', { turn_id: running.turn_id }).state, 'completed');
    assert.equal(f.next().task, undefined);
  });

  it('does not let a different browser capability, invite or verified driver cross a session boundary', () => {
    const a = fixture(), b = a.store.create('ip-2'); a.connect(); a.queue();
    fails(() => a.store.browser({ session_id: a.sid, operation: 'status' }, b.browser_token), 404);
    fails(() => a.store.browser({ session_id: b.session_id, operation: 'status' }, a.made.browser_token), 404);
    fails(() => a.driver('next', {}, BOB), 403);
    fails(() => a.store.driver({ i2idlx_operation: 'agent-session', bridge_audience: BASE, session_id: b.session_id, operation: 'claim', invite_token: a.made.invite_token }, ALICE), 403);
    fails(() => a.store.driver({ i2idlx_operation: 'agent-session', bridge_audience: 'https://other.example', session_id: a.sid, operation: 'next' }, ALICE), 403);
    fails(() => a.store.driver({ i2idlx_operation: 'other-operation', bridge_audience: BASE, session_id: a.sid, operation: 'next' }, ALICE), 403);
  });

  it('rejects request replay, stale revisions, replaced leases and rewritten stream prefixes', () => {
    const f = fixture({ leaseTtlMs: 100 }); f.connect(); f.queue();
    const first = f.next();
    fails(() => f.queue(), 409);
    const args = { turn_id: first.turn_id, lease_id: first.lease_id, revision: first.revision, text: 'First' };
    const tick = f.driver('emit', args);
    fails(() => f.driver('emit', args), 409);
    fails(() => f.driver('emit', { ...args, revision: tick.revision, text: 'Different' }), 409);
    f.advance(101);
    fails(() => f.finish({ ...first, revision: tick.revision }), 409);
    const renewed = f.next(); assert.notEqual(renewed.lease_id, first.lease_id);
    fails(() => f.finish({ ...renewed, lease_id: first.lease_id, revision: renewed.revision }), 409);
    const done = f.finish(renewed, { text: 'First and finished.' }); assert.equal(done.state, 'completed');
  });

  it('only returns proposals for exact advertised page tools and never executes their code', () => {
    const f = fixture(); f.connect(); f.queue(); const lease = f.next();
    const unknown = [{ id: 'call-1', name: 'run_script', arguments: { code: 'do something' } }];
    fails(() => f.finish(lease, { text: '', tool_calls: unknown }), 400);
    const calls = [{ id: 'call-1', name: 'get_concept', arguments: { id: 'formative-assessment' } }];
    const proposed = f.finish(lease, { text: '', tool_calls: calls });
    assert.equal(proposed.state, 'completed'); assert.deepEqual(proposed.tool_calls, calls);
    const actual = f.browser('request', { messages: [...task.messages, { role: 'user', content: 'Actual get_concept result: a source-defined assessment concept.' }], tools: [tool] });
    assert.notEqual(actual.turn_id, lease.turn_id);
    assert.equal(actual.state, 'queued');
  });

  it('makes cancellation terminal and revokes an old driver when the user reconnects', () => {
    const f = fixture(); f.connect(); f.queue(); const lease = f.next();
    const cancelled = f.browser('cancel', { turn_id: lease.turn_id }); assert.equal(cancelled.state, 'cancelled');
    fails(() => f.finish(lease), 409);
    const newInvite = f.browser('invite'); assert.equal(newInvite.state, 'waiting_for_agent');
    fails(() => f.driver('next'), 403);
    fails(() => f.driver('claim', { invite_token: f.made.invite_token }), 403);
    f.driver('claim', { invite_token: newInvite.invite_token }, BOB);
    assert.equal(row(f.browser('status').driver).actor, BOB);
    f.browser('disconnect');
    fails(() => f.driver('next', {}, BOB), 410);
    fails(() => f.browser('status'), 410);
  });

  it('expires invitations, requests and sessions without retaining expired private context', () => {
    const noDriver = fixture({ inviteTtlMs: 10 }); noDriver.advance(11);
    fails(() => noDriver.connect(), 403);
    const f = fixture({ requestTtlMs: 100, sessionTtlMs: 500 }); f.connect(); f.queue(); const lease = f.next();
    f.advance(101);
    const timeout = f.browser('poll', { turn_id: lease.turn_id }); assert.equal(timeout.state, 'failed');
    fails(() => f.finish(lease), 409);
    f.advance(400); fails(() => f.browser('status'), 410);
    fails(() => f.driver('next'), 410);
  });

  it('bounds creation, messages, schemas and tool results instead of growing an unbounded queue', () => {
    const f = fixture({ maxSessions: 2 }); f.store.create('ip-2'); fails(() => f.store.create('ip-3'), 429);
    const g = fixture(); for (let n = 0; n < 4; n++) g.store.create('ip-1'); fails(() => g.store.create('ip-1'), 429);
    g.connect();
    fails(() => g.browser('request', { ...task, messages: [{ role: { toString: 'user' }, content: 'x' }] }), 400);
    fails(() => g.browser('request', { ...task, messages: Array(33).fill(task.messages[0]) }), 400);
    fails(() => g.browser('request', { ...task, messages: [{ role: 'user', content: 'x'.repeat(513 * 1024) }] }), 400);
    fails(() => g.browser('request', { ...task, tools: [{ ...tool, execute: 'not permitted' }] }), 400);
    fails(() => g.browser('request', { ...task, tools: [tool, tool] }), 400);
    g.queue(); const lease = g.next();
    fails(() => g.finish(lease, { text: 'x'.repeat(128 * 1024 + 1) }), 400);
    fails(() => g.finish(lease, { text: '', tool_calls: [{ id: 'call-1', name: 'get_concept', arguments: { x: 'x'.repeat(16 * 1024) } }] }), 400);
    fails(() => g.finish(lease, { text: '', error: 'failed', tool_calls: [] }), 400);
    const failed = g.finish(lease, { text: '', error: 'The connected model is unavailable.' }); assert.equal(failed.state, 'failed');
  });

  it('clones driver tasks and tool results so callers cannot mutate later checks', () => {
    const f = fixture(); f.connect(); f.queue(); const lease = f.next();
    const leakedTask = row(lease.task); (leakedTask.tools as { name: string }[])[0]!.name = 'run_script';
    fails(() => f.finish(lease, { text: '', tool_calls: [{ id: 'x', name: 'run_script', arguments: {} }] }), 400);
    const calls = [{ id: 'x', name: 'get_concept', arguments: { id: 'assessment' } }];
    const done = f.finish(lease, { text: '', tool_calls: calls }); calls[0]!.arguments.id = 'changed';
    assert.equal((done.tool_calls as typeof calls)[0]!.arguments.id, 'assessment');
  });

  it('enforces a global byte budget across otherwise valid per-session requests', () => {
    const store = new AgentSessionStore({ baseUrl: BASE });
    const sessions: Record<string, unknown>[] = [];
    let limited = false;
    for (let n = 0; n < 40; n++) {
      const made = store.create('distinct-ip-' + n); sessions.push(made);
      store.driver({ i2idlx_operation: 'agent-session', bridge_audience: BASE, session_id: made.session_id, operation: 'claim', invite_token: made.invite_token }, ALICE);
      try {
        store.browser({ session_id: made.session_id, operation: 'request', messages: [{ role: 'user', content: 'x'.repeat(510 * 1024) }], tools: [] }, made.browser_token);
      } catch (e) { assert.ok(e instanceof AgentSessionError && e.status === 429); limited = true; break; }
    }
    assert.equal(limited, true);
    const first = sessions[0]!, pending = row(store.browser({ session_id: first.session_id, operation: 'status' }, first.browser_token).pending);
    store.browser({ session_id: first.session_id, operation: 'cancel', turn_id: pending.turn_id }, first.browser_token);
    const last = sessions[sessions.length - 1]!;
    const resumed = store.browser({ session_id: last.session_id, operation: 'request', messages: [{ role: 'user', content: 'x'.repeat(510 * 1024) }], tools: [] }, last.browser_token);
    assert.equal(resumed.state, 'queued');
  });
});

describe('HTTP driver authentication boundary', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });
  function httpFixture(verifyCaller?: Parameters<typeof attachAgentSessionRoutes>[1]['verifyCaller']) {
    const app = express();
    app.use(express.json({ limit: '600kb' }));
    // Reproduce the context added by Foxxi's upstream HTTP middleware. The
    // packaged-entrypoint smoke separately checks the real production middleware.
    app.use((req, _res, next) => {
      if (req.body && typeof req.body === 'object') {
        req.body.__client_ip = req.get('X-Forwarded-For') ?? req.ip;
        const header = req.get('Authorization') ?? '';
        const token = header.slice(0, 7).toLowerCase() === 'bearer ' ? header.slice(7).trim() : '';
        if (token) req.body.__caller_token = token;
      }
      next();
    });
    const store = attachAgentSessionRoutes(app, { baseUrl: BASE, verifyCaller });
    const server = app.listen(0, '127.0.0.1');
    const listening = new Promise<string>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); resolve('http://127.0.0.1:' + address.port); });
    });
    cleanup.push(async () => { store.dispose(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); });
    const invoke = async (suffix: string, body: unknown, headers: Record<string, string> = {}, query = {}) => {
      const params = new URLSearchParams(query);
      const result = await fetch(await listening + AGENT_SESSION_PATH + '/' + suffix + (params.size ? '?' + params : ''), {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
      });
      return { status: result.status, body: row(await result.json()), retryAfter: result.headers.get('Retry-After') };
    };
    return { store, invoke };
  }
  it('uses only the verifier-returned identity and payload, never unsigned adjacent fields', async () => {
    const f = fixture();
    const signed = { i2idlx_operation: 'agent-session', bridge_audience: BASE, session_id: f.sid, operation: 'claim', invite_token: f.made.invite_token };
    // Use the route's own store so the verified payload references its actual session.
    let verifiedPayload = signed;
    const h = httpFixture(async (_body, write) => { assert.equal(write, true); return { ok: true, callerDid: ALICE, payload: verifiedPayload }; });
    const created = await h.invoke('create', {}); verifiedPayload = { ...signed, session_id: created.body.session_id, invite_token: created.body.invite_token };
    const connected = await h.invoke('driver', { operation: 'claim', agent_id: BOB, invite_token: 'attacker', session_id: 'other' });
    assert.equal(connected.status, 200); assert.equal(row(connected.body.driver).actor, ALICE);
  });
  it('refuses unavailable or failed signature verification and never echoes an internal exception', async () => {
    const absent = httpFixture(); assert.equal((await absent.invoke('driver', {})).status, 503);
    const denied = httpFixture(async () => ({ ok: false, status: 403, error: 'private diagnostic' }));
    const refused = await denied.invoke('driver', {}); assert.equal(refused.status, 403); assert.ok(!JSON.stringify(refused).includes('private diagnostic'));
    const throws = httpFixture(async () => { throw new Error('SECRET INTERNAL DATA'); });
    const failed = await throws.invoke('driver', {}); assert.equal(failed.status, 500); assert.ok(!JSON.stringify(failed).includes('SECRET INTERNAL DATA'));
  });
  it('refuses cross-origin browser calls, query-string credentials and mismatched browser capabilities', async () => {
    const h = httpFixture();
    assert.equal((await h.invoke('create', {}, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await h.invoke('create', {}, {}, { token: 'bad' })).status, 400);
    const made = await h.invoke('create', {}); assert.equal(made.status, 200);
    const bad = await h.invoke('browser', { session_id: made.body.session_id, operation: 'status' }, { Authorization: 'Bearer wrong' }); assert.equal(bad.status, 404);
    const good = await h.invoke('browser', { session_id: made.body.session_id, operation: 'status' }, { Authorization: 'Bearer ' + String(made.body.browser_token), Origin: BASE }); assert.equal(good.status, 200);
  });
  it('ignores only HTTP transport context and never treats it as browser authority or a creation-budget key', async () => {
    const h = httpFixture();
    const made = await h.invoke('create', { __client_ip: 'body-ip', __caller_token: 'body-token' });
    assert.equal(made.status, 200);
    assert.ok(!JSON.stringify(made.body).includes('body-token'));
    const missingHeader = await h.invoke('browser', { session_id: made.body.session_id, operation: 'status', __caller_token: made.body.browser_token });
    assert.equal(missingHeader.status, 404);
    const valid = await h.invoke('browser', { session_id: made.body.session_id, operation: 'status' }, { Authorization: 'Bearer ' + String(made.body.browser_token) });
    assert.equal(valid.status, 200);
    assert.equal((await h.invoke('create', { __unexpected_transport_field: true })).status, 400);
    for (let n = 1; n < 5; n++) assert.equal((await h.invoke('create', { __client_ip: 'body-ip-' + n }, { 'X-Forwarded-For': '198.51.100.' + n })).status, 200);
    assert.equal((await h.invoke('create', {}, { 'X-Forwarded-For': '198.51.100.99' })).status, 429);
  });
  it('rate-limits driver requests before invoking signature and delegation verification', async () => {
    let verifications = 0;
    const h = httpFixture(async () => { verifications++; return { ok: false, status: 401, error: 'Fixture refusal.' }; });
    for (let n = 0; n < AGENT_DRIVER_REQUESTS_PER_MINUTE; n++) assert.equal((await h.invoke('driver', {})).status, 401);
    const limited = await h.invoke('driver', {});
    assert.equal(limited.status, 429); assert.equal(limited.retryAfter, '60');
    assert.equal(verifications, AGENT_DRIVER_REQUESTS_PER_MINUTE);
  }, 15_000);
});
