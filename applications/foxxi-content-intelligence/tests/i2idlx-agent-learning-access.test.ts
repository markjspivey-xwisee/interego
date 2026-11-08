import { describe, expect, it } from 'vitest';
import { AgentSessionStore, type AgentLearningAccess, type AgentLearningPhase } from '../src/i2idlx-agent-sessions.js';

const BASE = 'https://workbench.example', ACTOR = 'did:web:identity.example:agents:driver';
const RECEIPT = 'PRIVATE-LEARNING-AUTHORIZATION';
const task = { messages: [{ role: 'user', content: 'Selected private course evidence: BLUE27.' }],
  tools: [{ name: 'get_concept', description: 'Read a public glossary term.', inputSchema: { type: 'object' } }] };
function fixture() {
  let at = 1_000_000, allowed = true, disposed = 0;
  const abort = new AbortController(), phases: AgentLearningPhase[] = [];
  let hold: { phase: AgentLearningPhase; wait: Promise<void> } | null = null;
  const opened: unknown[] = [];
  const access: AgentLearningAccess = { signal: abort.signal,
    async assertCurrent(phase) { phases.push(phase); if (hold?.phase === phase) await hold.wait; if (!allowed) throw Error('Private internal failure'); },
    dispose() { disposed++; } };
  const store = new AgentSessionStore({ baseUrl: BASE, now: () => at, openLearningAccess(receipt, identity, messages) {
    expect(receipt).toBe(RECEIPT); expect(identity.actor).toBe(ACTOR); expect(messages).toEqual(task.messages);
    opened.push({ receipt, identity, messages }); return access;
  } });
  const made = store.create('isolated'), sid = made.session_id;
  const signed = (operation: string, extra = {}) => ({ i2idlx_operation: 'agent-session', bridge_audience: BASE, session_id: sid, operation, driver_token: token, ...extra });
  const token = store.driver({ i2idlx_operation: 'agent-session', bridge_audience: BASE, session_id: sid, operation: 'claim', invite_token: made.invite_token }, ACTOR).driver_token;
  const browser = (operation: string, extra = {}) => store.browser({ session_id: sid, operation, ...extra }, made.browser_token);
  const authorized = (operation: string, extra = {}) => store.browserAuthorized({ session_id: sid, operation, ...extra }, made.browser_token);
  const driver = (operation: string, extra = {}) => store.driverAuthorized(signed(operation, extra), ACTOR);
  const queue = () => authorized('request', { ...task, learning_authorization: RECEIPT });
  const emit = (lease: Record<string, unknown>, text: string) => driver('emit', { turn_id: lease.turn_id, lease_id: lease.lease_id, revision: lease.revision, text });
  const finish = (lease: Record<string, unknown>, extra = {}) => driver('finish', { turn_id: lease.turn_id, lease_id: lease.lease_id, revision: lease.revision, text: 'Private answer BLUE27.', ...extra });
  return { store, made, sid, signed, browser, authorized, driver, queue, emit, finish, phases, opened, abort,
    revoke() { allowed = false; }, disposed: () => disposed, advance(ms: number) { at += ms; },
    hold(phase: AgentLearningPhase) { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); hold = { phase, wait }; return release; } };
}

describe('learner authorization remains live across the agent broker', () => {
  it('strips the receipt from actual tasks, authenticates browser access and refuses synchronous private bypasses', async () => {
    const f = fixture();
    expect(() => f.browser('request', { ...task, learning_authorization: RECEIPT })).toThrow(); expect(f.opened).toHaveLength(0);
    await expect(f.store.browserAuthorized({ session_id: f.sid, operation: 'request', ...task, learning_authorization: RECEIPT }, '0'.repeat(64))).rejects.toMatchObject({ status: 404 });
    await f.queue(); expect(() => f.browser('status')).toThrow(); expect(() => f.store.driver(f.signed('next'), ACTOR)).toThrow();
    const lease = await f.driver('next'); expect(lease.task).toEqual(task); expect(JSON.stringify(lease)).not.toContain(RECEIPT);
    expect(f.phases).toEqual(['enqueue', 'dispatch']); f.store.dispose(); expect(f.disposed()).toBe(1);
  });
  it('refuses access revoked after source fetch before enqueue and queues no private task', async () => {
    const f = fixture(); f.revoke(); await expect(f.queue()).rejects.toMatchObject({ code: 'learning_access_revoked' });
    expect(f.browser('status').pending).toBeNull(); expect(await f.driver('next')).toMatchObject({ state: 'idle' }); expect(f.disposed()).toBe(1);
  });
  it('detaches the exact authorized messages before awaiting a source check', async () => {
    const f = fixture(), release = f.hold('enqueue'), messages = task.messages.map(message => ({ ...message }));
    const pending = f.authorized('request', { ...task, messages, learning_authorization: RECEIPT });
    messages[0]!.content = 'Caller changed the task while authorization was pending.'; release(); await pending;
    expect((await f.driver('next')).task).toEqual(task);
    f.store.dispose();
  });
  it('checks the exact driver credential before revalidating or dispatching queued private messages', async () => {
    const f = fixture(), queued = await f.queue();
    await expect(f.store.driverAuthorized({ ...f.signed('next'), driver_token: '0'.repeat(64) }, ACTOR)).rejects.toMatchObject({ status: 403 });
    expect(f.phases).toEqual(['enqueue']);
    f.revoke(); await expect(f.driver('next')).rejects.toMatchObject({ code: 'learning_access_revoked' });
    expect(await f.authorized('poll', { turn_id: queued.turn_id })).toMatchObject({ state: 'failed', text: '', error_code: 'learning_access_revoked' });
  });
  it('signal revocation removes a partial stream immediately and prevents finish from restoring it', async () => {
    const f = fixture(), queued = await f.queue(), lease = await f.driver('next');
    const emitted = await f.emit(lease, 'Private answer');
    expect(await f.authorized('poll', { turn_id: queued.turn_id })).toMatchObject({ text: 'Private answer' });
    f.abort.abort();
    const cleared = f.browser('poll', { turn_id: queued.turn_id }); expect(cleared).toMatchObject({ text: '', error_code: 'learning_access_revoked' }); expect(cleared.tool_calls).toBeUndefined();
    await expect(f.finish({ ...lease, ...emitted })).rejects.toMatchObject({ code: 'learning_access_revoked' }); expect(f.disposed()).toBe(1);
  });
  it('revalidates before stream and finish even when no revocation signal has arrived', async () => {
    for (const operation of ['emit', 'finish']) {
      const f = fixture(), queued = await f.queue(), lease = await f.driver('next'); f.revoke();
      await expect(operation === 'emit' ? f.emit(lease, 'Private') : f.finish(lease)).rejects.toMatchObject({ code: 'learning_access_revoked' });
      expect(await f.authorized('poll', { turn_id: queued.turn_id })).toMatchObject({ text: '', state: 'failed' });
    }
  });
  it('revalidates a completed answer before browser delivery and removes proposed tools on refusal', async () => {
    const f = fixture(), queued = await f.queue(), lease = await f.driver('next');
    await f.finish(lease, { tool_calls: [{ id: 'one', name: 'get_concept', arguments: { id: 'assessment' } }] });
    expect(() => f.browser('poll', { turn_id: queued.turn_id })).toThrow();
    f.revoke(); const cleared = await f.authorized('poll', { turn_id: queued.turn_id });
    expect(cleared).toMatchObject({ state: 'failed', text: '', error_code: 'learning_access_revoked' }); expect(cleared.tool_calls).toBeUndefined();
    expect(f.phases).toEqual(['enqueue', 'dispatch', 'finish', 'read']);
  });
  it('cannot apply an awaited dispatch check after invitation renewal replaces its authority', async () => {
    const f = fixture(); await f.queue(); const release = f.hold('dispatch'), pending = f.driver('next');
    f.browser('invite'); release(); await expect(pending).rejects.toMatchObject({ code: 'learning_access_revoked' });
    expect(f.browser('status').pending).toBeNull(); expect(f.disposed()).toBe(1);
  });
  it('disposes retained authorization on turn replacement, disconnect and session expiry without changing legacy turns', async () => {
    const replacement = fixture(); await replacement.queue(); const lease = await replacement.driver('next'); await replacement.finish(lease);
    const next = replacement.browser('request', task); expect(next.state).toBe('queued'); expect(replacement.disposed()).toBe(1);
    expect(replacement.store.driver(replacement.signed('next'), ACTOR).task).toEqual(task);
    for (const action of ['disconnect', 'expire']) {
      const f = fixture(); await f.queue(); if (action === 'disconnect') f.browser('disconnect'); else { f.advance(31 * 60_000); expect(() => f.browser('status')).toThrow(); }
      expect(f.disposed()).toBe(1);
    }
  });
});
