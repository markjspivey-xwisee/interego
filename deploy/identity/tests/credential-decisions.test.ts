/**
 * Decisions about one wallet or DID run one at a time (credential-decisions.ts): each after the
 * writes of the ones before it, none waiting longer than its bound, and none made while an
 * earlier write of the credential is unconfirmed and its account cannot be read.
 *
 * The route half (server.ts started against a stand-in pod) is the K cases of
 * tests/live-record-writes-routes.test.ts.
 *
 * Run:
 *   node --test --import tsx tests/credential-decisions.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { createCredentialDecisions, type Turn } from '../credential-decisions.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('the turns of one credential run one at a time, in the order they were asked for', async () => {
  const decisions = createCredentialDecisions({ readAccount: async () => undefined, waitMs: 5_000 });
  const order: string[] = [];
  const first = deferred();
  const a = decisions.decide('wallet:0xa', async () => { order.push('a start'); await first.promise; order.push('a end'); return 'a'; });
  const b = decisions.decide('wallet:0xa', async () => { order.push('b'); return 'b'; });
  const c = decisions.decide('wallet:0xa', async () => { order.push('c'); return 'c'; });
  await sleep(20);
  assert.deepEqual(order, ['a start'], 'nothing else runs while the first holds the turn');
  first.resolve();
  assert.deepEqual(await Promise.all([a, b, c]), ['a', 'b', 'c'].map(value => ({ kind: 'decided', value })));
  assert.deepEqual(order, ['a start', 'a end', 'b', 'c']);
  assert.equal(decisions.inFlight(), 0, 'a credential nobody is deciding about holds nothing');
});

test('other credentials do not wait', async () => {
  const decisions = createCredentialDecisions({ readAccount: async () => undefined, waitMs: 5_000 });
  const held = deferred();
  const a = decisions.decide('wallet:0xa', () => held.promise);
  const other = await decisions.decide('did:key:zOther', async () => 'other');
  assert.deepEqual(other, { kind: 'decided', value: 'other' });
  held.resolve();
  await a;
});

test('a turn that waits longer than its bound decides nothing; the next still waits for the holder', async () => {
  const decisions = createCredentialDecisions({ readAccount: async () => undefined, waitMs: 100 });
  const held = deferred();
  let holderDone = false;
  const holder = decisions.decide('wallet:0xa', async () => { await held.promise; holderDone = true; });
  let ran = false;
  const startedAt = Date.now();
  const busy = await decisions.decide('wallet:0xa', async () => { ran = true; });
  assert.deepEqual(busy, { kind: 'busy' });
  assert.equal(ran, false);
  assert.ok(Date.now() - startedAt >= 90, 'it waited for its bound');
  // The turn after the busy one does not start before the holder has finished.
  const next = decisions.decide('wallet:0xa', async () => holderDone);
  await sleep(50);
  held.resolve();
  await holder;
  assert.deepEqual(await next, { kind: 'decided', value: true });
  assert.equal(decisions.inFlight(), 0);
});

test('server.ts answers a turn that decided nothing with 503, and logs a busy one for operators, without the credential', async () => {
  // refuseCredentialTurn, taken from server.ts as provisional-play-enrollment.test.ts takes its helpers.
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const strip = (nodeModule as { stripTypeScriptTypes?: (source: string) => string }).stripTypeScriptTypes;
  const executable = strip ? strip(server) : (await import('typescript')).default.transpileModule(server, {
    compilerOptions: { target: 9, module: 99 },
  }).outputText;
  const start = executable.search(/(?<!async )function refuseCredentialTurn\s*\(/);
  assert.ok(start >= 0, 'refuseCredentialTurn exists in server.ts');
  const source = executable.slice(start, executable.indexOf('\n}', start) + 2);
  const lines: string[] = [];
  const refuse = new Function('log', 'CREDENTIAL_TURN_WAIT_MS', `${source}; return refuseCredentialTurn;`)(
    (line: string) => { lines.push(line); }, 30_000) as (res: unknown, turn: Exclude<Turn<unknown>, { kind: 'decided' }>, credential: 'wallet' | 'DID') => void;
  const answered: Array<{ status: number; body: Record<string, string> }> = [];
  const res = { status(code: number) { return { json(body: Record<string, string>) { answered.push({ status: code, body }); } }; } };
  refuse(res, { kind: 'busy' }, 'wallet');
  refuse(res, { kind: 'busy' }, 'DID');
  assert.deepEqual(answered.map(a => a.status), [503, 503]);
  assert.match(answered[0]!.body['error']!, /Another request for this wallet/);
  assert.deepEqual(lines, ['WARN identity_credential_turn_busy kind=wallet waitedMs=30000', 'WARN identity_credential_turn_busy kind=did waitedMs=30000']);
  refuse(res, { kind: 'unreadable', userId: 'u-pk-000000000001', reason: 'a write the pod did not answer could not be fenced' }, 'DID');
  assert.equal(answered[2]!.status, 503);
  // The log says why the settlement failed: it used to say the account "cannot be read yet" whatever
  // the reason (an account deleted here, whose fence is refused, was readable).
  assert.equal(lines[2]!, 'WARN: DID decision deferred: an unconfirmed write to u-pk-000000000001 could not be settled: '
    + 'a write the pod did not answer could not be fenced');
  assert.doesNotMatch(JSON.stringify(answered[2]!.body), /cannot be read yet/);
});

test('a decision that throws gives the turn up, and the error reaches its caller', async () => {
  const decisions = createCredentialDecisions({ readAccount: async () => undefined, waitMs: 5_000 });
  await assert.rejects(decisions.decide('wallet:0xa', async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(await decisions.decide('wallet:0xa', async () => 'next'), { kind: 'decided', value: 'next' });
  assert.equal(decisions.inFlight(), 0);
});

test('an unconfirmed write is read before the credential\'s next decision, and decides nothing while it cannot be', async () => {
  let readable = false;
  const reads: string[] = [];
  const pendings: unknown[] = [];
  const decisions = createCredentialDecisions({
    readAccount: async (userId, pending) => { reads.push(userId); pendings.push(pending); if (!readable) throw new Error('502'); },
    waitMs: 5_000,
  });
  // Recorded inside a turn, as the route does after a write whose outcome stayed unknown, with the
  // condition a write the pod never answered was sent on: the read must settle that write first.
  const pending = { kind: 'match', etag: '"7-application/ld+json"' };
  await decisions.decide('wallet:0xa', async () => { decisions.unconfirmed('wallet:0xa', 'u-pk-x', pending); });
  assert.equal(decisions.unconfirmedFor('wallet:0xa'), 'u-pk-x');
  let ran = 0;
  assert.deepEqual(await decisions.decide('wallet:0xa', async () => { ran++; }), { kind: 'unreadable', userId: 'u-pk-x', reason: '502' });
  assert.equal(ran, 0, 'nothing is decided while the account cannot be read');
  assert.equal(decisions.unconfirmedFor('wallet:0xa'), 'u-pk-x', 'and the record stays');
  // Another credential is not held up by it.
  assert.deepEqual(await decisions.decide('wallet:0xb', async () => 'b'), { kind: 'decided', value: 'b' });
  readable = true;
  assert.deepEqual(await decisions.decide('wallet:0xa', async () => { ran++; return 'a'; }), { kind: 'decided', value: 'a' });
  assert.equal(ran, 1);
  assert.equal(decisions.unconfirmedFor('wallet:0xa'), undefined, 'once read, it is settled');
  await decisions.decide('wallet:0xa', async () => { ran++; });
  assert.deepEqual(reads, ['u-pk-x', 'u-pk-x'], 'and not read again');
  assert.deepEqual(pendings, [pending, pending], 'each read was given the pending write to settle');
  assert.equal(ran, 2);
});

test('recorded writes are settled without a request for the credential, and dropped once their account was read', async () => {
  let readable = false;
  const reads: string[] = [];
  const decisions = createCredentialDecisions({
    readAccount: async userId => { reads.push(userId); if (!readable) throw new Error('502'); },
    waitMs: 5_000,
  });
  // Two throwaway credentials whose first writes nothing could settle, and which never come back.
  await decisions.decide('wallet:0xa', async () => { decisions.unconfirmed('wallet:0xa', 'u-eth-a', { kind: 'absent' }); });
  await decisions.decide('did:did:key:zB', async () => { decisions.unconfirmed('did:did:key:zB', 'u-did-b'); });
  assert.equal(decisions.recorded(), 2);
  // While the pod cannot be read, each stays recorded.
  assert.equal(await decisions.settleRecorded(), 2);
  assert.deepEqual(reads, ['u-eth-a', 'u-did-b']);
  // A sweep does not take a turn that is held: it waits its bound like any turn, and keeps the record.
  readable = true;
  const held = deferred();
  const holder = decisions.decide('wallet:0xa', () => held.promise);
  const quick = createCredentialDecisions({ readAccount: async () => undefined, waitMs: 50 });
  const quickHeld = deferred();
  // Recorded by a turn that is still held when the sweep comes.
  const quickHolder = quick.decide('wallet:0xq', async () => { quick.unconfirmed('wallet:0xq', 'u-eth-q'); await quickHeld.promise; });
  await sleep(5);
  assert.equal(await quick.settleRecorded(), 1, 'a busy turn leaves its record for the next sweep');
  quickHeld.resolve();
  await quickHolder;
  assert.equal(await quick.settleRecorded(), 0);
  held.resolve();
  await holder;
  // Once readable, a sweep settles each and drops it, as each credential's next turn would have.
  assert.equal(decisions.recorded(), 1, 'the holder\'s own turn settled wallet:0xa first');
  assert.equal(await decisions.settleRecorded(), 0);
  assert.equal(decisions.unconfirmedFor('did:did:key:zB'), undefined);
  assert.equal(decisions.inFlight(), 0);
});

test('at most maxRecorded writes are recorded: a new one past that is refused, one recorded already is updated', async () => {
  const decisions = createCredentialDecisions({ readAccount: async () => { throw new Error('502'); }, waitMs: 5_000, maxRecorded: 2 });
  assert.equal(decisions.unconfirmed('wallet:0x1', 'u-1'), true);
  assert.equal(decisions.unconfirmed('wallet:0x2', 'u-2'), true);
  assert.equal(decisions.unconfirmed('wallet:0x3', 'u-3'), false, 'full: nothing recorded');
  assert.equal(decisions.unconfirmedFor('wallet:0x3'), undefined);
  assert.equal(decisions.unconfirmed('wallet:0x2', 'u-2b'), true, 'a credential recorded already keeps its place');
  assert.equal(decisions.unconfirmedFor('wallet:0x2'), 'u-2b');
  assert.equal(decisions.recorded(), 2);
});
