/**
 * A read of an account's record that a change overlapped knows it, and nothing is kept for an
 * account nobody is reading (record-watch.ts).
 *
 * The route half is B10, B11 and B12 in tests/live-record-writes-routes.test.ts: a startup scan or
 * an on-demand load whose read a write (installed, or failed and only marked stale) overtook
 * installs nothing.
 *
 * Run:
 *   node --test --import tsx tests/record-watch.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRecordWatchers } from '../record-watch.js';

test('a change during a read is seen by that read, and by every read of the account in flight', () => {
  const w = createRecordWatchers();
  const first = w.watch('u-a');
  const second = w.watch('u-a');
  const other = w.watch('u-b');
  w.changed('u-a');
  assert.equal(first.changed, true);
  assert.equal(second.changed, true);
  assert.equal(other.changed, false, 'another account is not changed');
  // A read that starts after the change does not see it.
  const later = w.watch('u-a');
  assert.equal(later.changed, false);
  for (const r of [first, second, other, later]) r.done();
});

test('nothing is kept for an account nobody is reading, however often its copy changes', () => {
  const w = createRecordWatchers();
  // Changes to accounts with no read in flight (an install, or an expire of an id that has no
  // copy at all) leave nothing behind. The counter this replaces kept one entry per id for good.
  for (let i = 0; i < 1_000; i++) w.changed(`u-eth-${i}`);
  assert.equal(w.watched(), 0);
  const r = w.watch('u-a');
  const s = w.watch('u-a');
  assert.equal(w.watched(), 1);
  r.done();
  assert.equal(w.watched(), 1, 'one read of it is still in flight');
  s.done();
  assert.equal(w.watched(), 0);
  // done() twice is harmless, and does not forget a later watch of the same account.
  const t = w.watch('u-a');
  r.done();
  w.changed('u-a');
  assert.equal(t.changed, true);
  t.done();
  assert.equal(w.watched(), 0);
});
