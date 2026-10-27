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
import { createCredentialDecisions } from '../credential-decisions.js';

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
  assert.deepEqual(await decisions.decide('wallet:0xa', async () => { ran++; }), { kind: 'unreadable', userId: 'u-pk-x' });
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
