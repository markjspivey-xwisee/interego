import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import express from 'express';
import {
  AgentSessionError, AgentSessionStore, agentSessionRoutine, attachAgentSessionRoutes, AGENT_SESSION_PATH, AGENT_DRIVER_REQUESTS_PER_MINUTE,
  type AgentSessionConfig,
} from '../src/i2idlx-agent-sessions.js';

const BASE = 'https://workbench.example';
const ALICE = 'did:web:identity.example:agents:alice';
const BOB = 'did:web:identity.example:agents:bob';
const tool = { name: 'get_concept', description: 'Read a public concept.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } };
const task = { messages: [{ role: 'user', content: 'Explain formative assessment with a source citation.' }], tools: [tool] };
function fixture(config: Omit<AgentSessionConfig, 'baseUrl' | 'now'> = {}) {
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

type WakeEvent = { session_id: string; wake_id: string };
const routineSetup = {
  provider: 'grok-bot',
  url: 'https://api2.cursor.sh/automations/webhook/fixture_hook',
  key: 'crsr_fixture_wake_key_0123456789',
};
const flushWake = () => new Promise<void>(resolve => setImmediate(resolve));
function routineFixture(deliver?: (event: WakeEvent) => Promise<void>) {
  const events: WakeEvent[] = [];
  const f = fixture({ routine: setup => {
    assert.deepEqual(setup, routineSetup);
    return { async wake(event) { events.push(event); await deliver?.(event); } };
  } });
  const configured = f.browser('configure_monitoring', { routine: routineSetup });
  const optIn = (actor = ALICE, invite = configured.invite_token) => f.driver('claim', { invite_token: invite, start_monitoring: true }, actor);
  const wakeAt = (index: number) => {
    const event = events[index];
    assert.ok(event);
    assert.deepEqual(Object.keys(event).sort(), ['session_id', 'wake_id']);
    assert.equal(event.session_id, f.sid);
    assert.match(event.wake_id, /^[a-f0-9]{64}$/);
    return event;
  };
  const useWake = (operation: string, event: WakeEvent, extra = {}, actor = ALICE) => f.store.driver({
    i2idlx_operation: 'agent-session', bridge_audience: BASE, operation, ...event, ...extra,
  }, actor);
  return { ...f, configured, events, optIn, wakeAt, useWake };
}

describe('explicit, ephemeral external-agent workbench sessions', () => {
  it('accepts the transport fields a relay-signed request carries, client_id included, and nothing unlisted', () => {
    const f = fixture();
    // The relay signs agent_id, timestamp, subject_pod_url and the OAuth client its session's token was issued to.
    const relay = { agent_id: ALICE, timestamp: '2026-11-09T12:00:00.000Z', subject_pod_url: 'https://pod.example/alice/', client_id: 'https://bridge.example/ui/oauth/client.json' };
    fails(() => f.driver('claim', { invite_token: f.made.invite_token, ...relay, pod_name: 'alice' }), 400);
    assert.equal(row(f.driver('claim', { invite_token: f.made.invite_token, ...relay }).driver).actor, ALICE);
  });
  it('authorizes private browser capabilities only for a verified attached actor and revokes their lifetime', () => {
    const f = fixture();
    fails(() => f.store.authorizeBrowser(f.sid, f.made.browser_token), 409);
    const claimed = f.connect();
    fails(() => f.store.authorizeBrowser(f.sid, claimed.driver_token), 404);
    const identity = f.store.authorizeBrowser(f.sid, f.made.browser_token);
    assert.equal(identity.session_id, f.sid);
    assert.equal(identity.actor, ALICE);
    assert.equal(identity.expires_at, 1_000_000 + 30 * 60_000);
    assert.equal(identity.signal.aborted, false);
    f.browser('disconnect');
    assert.equal(identity.signal.aborted, true);
    fails(() => f.store.authorizeBrowser(f.sid, f.made.browser_token), 410);

    const expired = fixture({ sessionTtlMs: 100 });
    expired.connect();
    const expiring = expired.store.authorizeBrowser(expired.sid, expired.made.browser_token);
    expired.advance(101);
    fails(() => expired.store.authorizeBrowser(expired.sid, expired.made.browser_token), 410);
    assert.equal(expiring.signal.aborted, true);
    const disposed = fixture();
    disposed.connect();
    const disposing = disposed.store.authorizeBrowser(disposed.sid, disposed.made.browser_token);
    disposed.store.dispose();
    assert.equal(disposing.signal.aborted, true);
  });

  it('revokes private capability lifetimes when pairing is renewed and starts a fresh lifetime on reclaim', () => {
    const f = fixture();
    f.connect();
    const old = f.store.authorizeBrowser(f.sid, f.made.browser_token);
    const invitation = f.browser('invite');
    assert.equal(old.signal.aborted, true);
    fails(() => f.store.authorizeBrowser(f.sid, f.made.browser_token), 409);
    f.driver('claim', { invite_token: invitation.invite_token });
    const fresh = f.store.authorizeBrowser(f.sid, f.made.browser_token);
    assert.notEqual(fresh.signal, old.signal);
    assert.equal(fresh.signal.aborted, false);
    f.store.dispose();
  });

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

describe('opt-in background agent monitoring', () => {
  it('accepts only the exact Grok webhook shape and posts only the two wake references', async () => {
    let status = 200;
    const requests: { url: string; init: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      assert.ok(init);
      requests.push({ url: String(input), init });
      return new Response('Fixture transport response.', { status });
    };
    for (const url of [
      routineSetup.url.replace('https:', 'http:'),
      routineSetup.url.replace('api2.cursor.sh', 'api2.cursor.sh.attacker.example'),
      routineSetup.url.replace('api2.cursor.sh', 'api2.cursor.sh:443'),
      routineSetup.url.replace('api2.cursor.sh', 'user@api2.cursor.sh'),
      routineSetup.url.replace('fixture_hook', '%66ixture_hook'),
      routineSetup.url + '?x=1', routineSetup.url + '#fragment', routineSetup.url + '/',
      ' ' + routineSetup.url, 'https://127.0.0.1/automations/webhook/fixture_hook',
    ]) assert.throws(() => agentSessionRoutine({ ...routineSetup, url }, fetcher));
    assert.throws(() => agentSessionRoutine({ ...routineSetup, provider: 'other' }, fetcher));
    assert.throws(() => agentSessionRoutine({ ...routineSetup, key: 'crsr_short' }, fetcher));
    assert.throws(() => agentSessionRoutine({ ...routineSetup, key: routineSetup.key + '\n' }, fetcher));
    assert.throws(() => agentSessionRoutine({ ...routineSetup, headers: { Accept: '*/*' } }, fetcher));
    assert.equal(requests.length, 0);
    const routine = agentSessionRoutine(routineSetup, fetcher);
    const wake = { session_id: '1'.repeat(32), wake_id: '2'.repeat(64) };
    await routine.wake(wake);
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.url, routineSetup.url);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.redirect, 'error');
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer ' + routineSetup.key);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(request.init.body)), wake);
    status = 202;
    await assert.rejects(routine.wake(wake), /rejected the wake event/);
  });

  it('requires the paired actor to confirm startup and wakes each queued turn once', async () => {
    const f = routineFixture();
    const claimed = f.optIn();
    assert.equal(claimed.monitoring, 'starting');
    assert.equal(claimed.driver_token, undefined);
    assert.equal(f.browser('status').monitoring, 'starting');
    fails(() => f.queue(), 409);
    await flushWake();
    assert.equal(f.events.length, 1);
    const startup = f.wakeAt(0);
    assert.ok(!JSON.stringify(claimed).includes(startup.wake_id));
    assert.ok(!JSON.stringify(f.browser('status')).includes(startup.wake_id));
    fails(() => f.useWake('next', startup, {}, BOB), 403);
    fails(() => f.useWake('next', { ...startup, wake_id: '0'.repeat(64) }), 403);
    fails(() => f.useWake('next', startup, { driver_token: '3'.repeat(64) }), 403);
    assert.equal(f.useWake('next', startup).state, 'idle');
    assert.equal(f.browser('status').monitoring, 'ready');
    fails(() => f.useWake('next', startup), 403);

    const queued = f.queue();
    await flushWake();
    assert.equal(f.events.length, 2);
    const wake = f.wakeAt(1);
    assert.notEqual(wake.wake_id, startup.wake_id);
    assert.ok(!JSON.stringify(queued).includes(wake.wake_id));
    fails(() => f.useWake('next', wake, {}, BOB), 403);
    const lease = f.useWake('next', wake);
    assert.equal(lease.state, 'running');
    assert.equal(lease.turn_id, queued.turn_id);
    assert.deepEqual(row(lease.task).messages, task.messages);
    fails(() => f.useWake('next', wake), 409);
    const update = { turn_id: lease.turn_id, lease_id: lease.lease_id, revision: lease.revision, text: 'I will check.' };
    fails(() => f.useWake('emit', wake, { ...update, lease_id: '0'.repeat(64) }), 409);
    const emitted = f.useWake('emit', wake, update);
    fails(() => f.useWake('emit', wake, update), 409);
    const calls = [{ id: 'call-1', name: 'get_concept', arguments: { id: 'formative-assessment' } }];
    const done = f.useWake('finish', wake, { ...update, revision: emitted.revision, tool_calls: calls });
    assert.equal(done.state, 'completed');
    assert.deepEqual(f.browser('poll', { turn_id: lease.turn_id }).tool_calls, calls);
    fails(() => f.useWake('finish', wake, { ...update, revision: emitted.revision }), 403);

    const messages = [...task.messages, { role: 'user', content: 'Actual page-tool result: formative assessment guides ongoing learning.' }];
    const followup = f.browser('request', { messages, tools: [tool] });
    await flushWake();
    assert.equal(f.events.length, 3);
    const nextWake = f.wakeAt(2);
    assert.notEqual(nextWake.wake_id, wake.wake_id);
    fails(() => f.useWake('next', wake), 403);
    const next = f.useWake('next', nextWake);
    assert.equal(next.turn_id, followup.turn_id);
    assert.notEqual(next.turn_id, lease.turn_id);
    assert.deepEqual(row(next.task).messages, messages);
    assert.equal(f.useWake('finish', nextWake, { turn_id: next.turn_id, lease_id: next.lease_id, revision: next.revision, text: 'A grounded answer.' }).state, 'completed');
    await flushWake();
    assert.equal(f.events.length, 3);
  });

  it('rotates the invitation and requires an explicit signed mode match without consuming it', async () => {
    const configured = routineFixture();
    assert.equal(row(row(configured.made.protocol).driver).routine_start, undefined);
    assert.equal(row(row(configured.configured.protocol).driver).routine_start, true);
    assert.notEqual(configured.configured.invite_token, configured.made.invite_token);
    fails(() => configured.optIn(BOB, configured.made.invite_token), 403);
    fails(() => configured.driver('claim', { invite_token: configured.configured.invite_token }, BOB), 409);
    assert.equal(configured.browser('status').state, 'waiting_for_agent');
    await flushWake();
    assert.deepEqual(configured.events, []);
    const claimed = configured.optIn(BOB);
    assert.equal(row(claimed.driver).actor, BOB);
    assert.equal(claimed.monitoring, 'starting');
    await flushWake();
    fails(() => configured.useWake('next', configured.wakeAt(0)), 403);
    assert.equal(configured.useWake('next', configured.wakeAt(0), {}, BOB).state, 'idle');

    const unconfigured = fixture();
    fails(() => unconfigured.driver('claim', { invite_token: unconfigured.made.invite_token, start_monitoring: true }), 409);
    assert.equal(unconfigured.connect().monitoring, undefined);
    unconfigured.queue();
    assert.equal(unconfigured.next().state, 'running');
  });

  it('revokes wake references on cancellation and re-pairing', async () => {
    const f = routineFixture();
    f.optIn();
    await flushWake();
    f.useWake('next', f.wakeAt(0));
    const queued = f.queue();
    await flushWake();
    const cancelled = f.wakeAt(1);
    assert.equal(f.browser('cancel', { turn_id: queued.turn_id }).state, 'cancelled');
    fails(() => f.useWake('next', cancelled), 403);

    f.queue();
    await flushWake();
    const replaced = f.wakeAt(2);
    const lease = f.useWake('next', replaced);
    const newInvite = f.browser('invite');
    assert.equal(newInvite.state, 'waiting_for_agent');
    assert.equal(row(row(newInvite.protocol).driver).routine_start, true);
    fails(() => f.useWake('finish', replaced, { turn_id: lease.turn_id, lease_id: lease.lease_id, revision: lease.revision, text: 'Stale result.' }), 403);

    assert.equal(f.optIn(ALICE, newInvite.invite_token).monitoring, 'starting');
    fails(() => f.driver('next', { driver_token: '3'.repeat(64) }), 403);
    fails(() => f.useWake('next', replaced), 403);
    await flushWake();
    f.useWake('next', f.wakeAt(3));
    f.queue();
    await flushWake();
    assert.equal(f.events.length, 5);
    assert.equal(f.useWake('next', f.wakeAt(4)).state, 'running');
  });

  it('makes an undelivered turn terminal and allows a fresh wake for the retry', async () => {
    let rejectDelivery: ((reason: Error) => void) | undefined;
    const f = routineFixture(async () => {
      if (f.events.length === 2) await new Promise<void>((_resolve, reject) => { rejectDelivery = reject; });
    });
    f.optIn();
    await flushWake();
    f.useWake('next', f.wakeAt(0));
    const queued = f.queue();
    await flushWake();
    const failedWake = f.wakeAt(1);
    assert.equal(f.browser('poll', { turn_id: queued.turn_id }).state, 'queued');
    assert.ok(rejectDelivery);
    rejectDelivery(new Error('Private transport diagnostic'));
    await flushWake();
    const failed = f.browser('poll', { turn_id: queued.turn_id });
    assert.equal(failed.state, 'failed');
    assert.ok(!JSON.stringify(failed).includes('Private transport diagnostic'));
    fails(() => f.useWake('next', failedWake), 403);

    const retry = f.queue();
    await flushWake();
    assert.equal(f.events.length, 3);
    const freshWake = f.wakeAt(2);
    assert.notEqual(freshWake.wake_id, failedWake.wake_id);
    fails(() => f.useWake('next', failedWake), 403);
    const lease = f.useWake('next', freshWake);
    assert.equal(lease.turn_id, retry.turn_id);
    assert.equal(f.useWake('finish', freshWake, { turn_id: lease.turn_id, lease_id: lease.lease_id, revision: lease.revision, text: 'The retry completed.' }).state, 'completed');
  });

  it('expires acknowledged deliveries that the routine never picks up', async () => {
    const f = routineFixture();
    f.optIn();
    await flushWake();
    const expiredStartup = f.wakeAt(0);
    f.advance(60_001);
    assert.equal(f.browser('status').monitoring, 'unavailable');
    fails(() => f.useWake('next', expiredStartup), 403);
    fails(() => f.queue(), 409);

    const replacement = f.browser('invite');
    assert.equal(f.optIn(ALICE, replacement.invite_token).monitoring, 'starting');
    await flushWake();
    f.useWake('next', f.wakeAt(1));
    const queued = f.queue();
    await flushWake();
    const expiredTurn = f.wakeAt(2);
    f.advance(60_001);
    assert.equal(f.browser('poll', { turn_id: queued.turn_id }).state, 'failed');
    fails(() => f.useWake('next', expiredTurn), 403);
    const retry = f.queue();
    assert.equal(retry.state, 'queued');
    await flushWake();
    assert.equal(f.events.length, 4);
    const freshWake = f.wakeAt(3);
    assert.notEqual(freshWake.wake_id, expiredTurn.wake_id);
    const lease = f.useWake('next', freshWake);
    f.advance(60_001);
    assert.equal(f.browser('poll', { turn_id: retry.turn_id }).state, 'failed');
    fails(() => f.useWake('finish', freshWake, { turn_id: lease.turn_id, lease_id: lease.lease_id, revision: lease.revision, text: 'Late result.' }), 403);
  });
});

describe('HTTP driver authentication boundary', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });
  function httpFixture(verifyCaller?: AgentSessionConfig['verifyCaller'], routine?: AgentSessionConfig['routine'], browserAdmissionLimit?: number) {
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
    const store = attachAgentSessionRoutes(app, { baseUrl: BASE, verifyCaller, routine, browserAdmissionLimit });
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
    const wakes: WakeEvent[] = [];
    const h = httpFixture(async (_body, write) => { assert.equal(write, true); return { ok: true, callerDid: ALICE, payload: verifiedPayload }; }, () => ({ async wake(event) { wakes.push(event); } }));
    const created = await h.invoke('create', {}); verifiedPayload = { ...signed, session_id: created.body.session_id, invite_token: created.body.invite_token };
    const connected = await h.invoke('driver', { operation: 'claim', agent_id: BOB, invite_token: 'attacker', session_id: 'other', start_monitoring: true });
    assert.equal(connected.status, 200); assert.equal(row(connected.body.driver).actor, ALICE);
    assert.equal(connected.body.monitoring, undefined);
    await flushWake();
    assert.deepEqual(wakes, []);
  });
  it('requires the correct browser capability and exact Origin to configure monitoring', async () => {
    let configurations = 0;
    const h = httpFixture(undefined, raw => {
      configurations++;
      assert.deepEqual(raw, routineSetup);
      return { async wake() {} };
    });
    const made = (await h.invoke('create', {})).body;
    const payload = { operation: 'configure_monitoring', session_id: made.session_id, routine: routineSetup };
    const auth = { Authorization: 'Bearer ' + String(made.browser_token) };
    assert.equal((await h.invoke('browser', payload, auth)).status, 403);
    assert.equal((await h.invoke('browser', payload, { ...auth, Origin: 'https://other.example' })).status, 403);
    assert.equal((await h.invoke('browser', payload, { Origin: BASE })).status, 404);
    assert.equal((await h.invoke('browser', { ...payload, __caller_token: made.browser_token }, { Origin: BASE })).status, 404);
    assert.equal(configurations, 0);
    const configured = await h.invoke('browser', payload, { ...auth, Origin: BASE });
    assert.equal(configured.status, 200);
    assert.equal(configurations, 1);
    assert.notEqual(configured.body.invite_token, made.invite_token);
    assert.equal(row(row(configured.body.protocol).driver).routine_start, true);
    const response = JSON.stringify(configured.body);
    assert.ok(!response.includes(routineSetup.url) && !response.includes(routineSetup.key));
  });
  it('isolates real HTTP sessions and webhook credentials even for the same verified actor', async () => {
    const setupB = { ...routineSetup, url: routineSetup.url.replace('fixture_hook', 'other_hook'), key: 'crsr_other_fixture_key_0123456789' };
    const deliveries: { url: string; auth: string | null; event: WakeEvent }[] = [];
    let failA = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const event = JSON.parse(String(init?.body)) as WakeEvent;
      deliveries.push({ url, auth: new Headers(init?.headers).get('Authorization'), event });
      return new Response(null, { status: failA && url === routineSetup.url ? 503 : 200 });
    };
    const h = httpFixture(async body => ({ ok: true, callerDid: ALICE, payload: row(row(body).signedFixture) }), raw => agentSessionRoutine(raw, fetcher));
    const open = async (routine: typeof routineSetup) => {
      const made = (await h.invoke('create', {})).body;
      const browser = (operation: string, extra = {}) => h.invoke('browser', { session_id: made.session_id, operation, ...extra }, { Origin: BASE, Authorization: 'Bearer ' + String(made.browser_token) });
      const driver = (operation: string, extra = {}, unsigned = {}) => h.invoke('driver', { signedFixture: { i2idlx_operation: 'agent-session', bridge_audience: BASE, session_id: made.session_id, operation, ...extra }, ...unsigned });
      const configured = await browser('configure_monitoring', { routine });
      assert.equal(configured.status, 200);
      const fields = { invite_token: configured.body.invite_token };
      assert.equal((await driver('claim', fields, { start_monitoring: true })).status, 409);
      const claim = await driver('claim', { ...fields, start_monitoring: true });
      assert.equal(claim.status, 200);
      assert.equal(row(claim.body.driver).actor, ALICE);
      assert.equal(claim.body.monitoring, 'starting');
      assert.equal(claim.body.driver_token, undefined);
      return { made, browser, driver, routine };
    };
    const [a, b] = await Promise.all([open(routineSetup), open(setupB)]);
    const wakeFor = (connection: typeof a, index: number) => {
      const delivery = deliveries.filter(row => row.event.session_id === connection.made.session_id)[index];
      assert.ok(delivery);
      assert.equal(delivery.url, connection.routine.url);
      assert.equal(delivery.auth, 'Bearer ' + connection.routine.key);
      assert.deepEqual(Object.keys(delivery.event).sort(), ['session_id', 'wake_id']);
      return delivery.event.wake_id;
    };
    await flushWake();
    const startupA = wakeFor(a, 0), startupB = wakeFor(b, 0);
    assert.notEqual(startupA, startupB);
    assert.equal((await a.driver('next', { wake_id: startupB })).status, 403);
    assert.equal((await b.driver('next', { wake_id: startupA })).status, 403);
    const startup = await Promise.all([a.driver('next', { wake_id: startupA }), b.driver('next', { wake_id: startupB })]);
    assert.deepEqual(startup.map(result => [result.status, result.body.state]), [[200, 'idle'], [200, 'idle']]);

    failA = true;
    const [queuedA, queuedB] = await Promise.all([
      a.browser('request', task),
      b.browser('request', { ...task, messages: [{ role: 'user', content: 'A different browser request.' }] }),
    ]);
    assert.deepEqual([queuedA.status, queuedB.status], [200, 200]);
    await flushWake();
    const turnA = wakeFor(a, 1), turnB = wakeFor(b, 1);
    assert.notEqual(turnA, turnB);
    assert.equal((await a.browser('poll', { turn_id: queuedA.body.turn_id })).body.state, 'failed');
    assert.equal((await a.driver('next', { wake_id: turnB })).status, 403);
    assert.equal((await b.driver('next', { wake_id: turnA })).status, 403);
    const lease = await b.driver('next', { wake_id: turnB });
    assert.equal(lease.status, 200);
    assert.equal(lease.body.turn_id, queuedB.body.turn_id);
    assert.deepEqual(row(lease.body.task).messages, [{ role: 'user', content: 'A different browser request.' }]);
    const done = await b.driver('finish', { wake_id: turnB, turn_id: lease.body.turn_id, lease_id: lease.body.lease_id, revision: lease.body.revision, text: 'Session B completed.' });
    assert.equal(done.status, 200);
    assert.equal((await b.browser('poll', { turn_id: lease.body.turn_id })).body.text, 'Session B completed.');
    assert.equal(deliveries.length, 4);
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
  it('bounds browser admission before session authorization without trusting request limits or client addresses', async () => {
    const h = httpFixture(undefined, undefined, 2);
    let authorizations = 0;
    const authorize = h.store.browserAuthorized.bind(h.store);
    h.store.browserAuthorized = async (...args) => { authorizations++; return authorize(...args); };
    for (let n = 0; n < 2; n++) assert.equal((await h.invoke('browser', { session_id: 'unknown', operation: 'status' })).status, 404);
    const limited = await h.invoke('browser', { session_id: 'unknown', operation: 'status', browserAdmissionLimit: 6000 }, { 'X-Forwarded-For': '198.51.100.77' });
    assert.equal(limited.status, 429); assert.equal(limited.retryAfter, '60');
    assert.equal(authorizations, 2);
  });
});
