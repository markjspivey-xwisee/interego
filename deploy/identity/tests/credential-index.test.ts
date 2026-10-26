/**
 * A credential (passkey id, wallet, DID) maps to every account that lists it. With one
 * account per credential, whichever account loaded last owned it, so registering a victim's
 * non-secret passkey id on another account made the victim's sign-ins fail on and off.
 *
 * The route half is tests/credential-multi-holder-routes.test.ts.
 *
 * Run:
 *   node --test --import tsx tests/credential-index.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AccountIndex } from '../credential-index.js';

test('indexing a second holder of a key keeps the first', () => {
  const index = new AccountIndex();
  index.setUser('u-eth-victim', ['cred-p', 'cred-v']);
  index.setUser('u-pk-attacker', ['cred-p']);
  assert.deepEqual(index.candidates('cred-p'), ['u-eth-victim', 'u-pk-attacker']);
  assert.deepEqual(index.candidates('cred-v'), ['u-eth-victim']);
  // Loading them again, in either order, changes nothing.
  index.setUser('u-eth-victim', ['cred-p', 'cred-v']);
  assert.deepEqual(index.candidates('cred-p'), ['u-eth-victim', 'u-pk-attacker']);
  index.setUser('u-pk-attacker', ['cred-p']);
  assert.deepEqual(index.candidates('cred-p'), ['u-eth-victim', 'u-pk-attacker']);
  assert.equal(index.size, 2);
});

test('candidates are in a stable order: the preferred holder first, then by id', () => {
  const index = new AccountIndex();
  for (const id of ['u-pk-c', 'u-pk-a', 'u-pk-b']) index.setUser(id, ['k']);
  assert.deepEqual(index.candidates('k'), ['u-pk-a', 'u-pk-b', 'u-pk-c']);
  assert.deepEqual(index.candidates('k', 'u-pk-c'), ['u-pk-c', 'u-pk-a', 'u-pk-b']);
  assert.deepEqual(index.candidates('k', 'u-pk-a'), ['u-pk-a', 'u-pk-b', 'u-pk-c']);
  // A preferred id that holds nothing is not added.
  assert.deepEqual(index.candidates('k', 'u-pk-z'), ['u-pk-a', 'u-pk-b', 'u-pk-c']);
  assert.deepEqual(index.candidates('missing', 'u-pk-a'), []);
});

test('re-indexing a user with fewer keys drops only its own entries', () => {
  const index = new AccountIndex();
  index.setUser('a', ['k1', 'k2']);
  index.setUser('b', ['k2']);
  index.setUser('a', ['k1']);
  assert.deepEqual(index.candidates('k2'), ['b']);
  assert.deepEqual(index.candidates('k1'), ['a']);
  index.setUser('b', []);
  assert.equal(index.has('k2'), false);
  assert.equal(index.size, 1);
});

test('removeUser empties its entries and leaves the other holders', () => {
  const index = new AccountIndex();
  index.setUser('a', ['k1', 'k2']);
  index.setUser('b', ['k1']);
  index.removeUser('a');
  assert.deepEqual(index.candidates('k1'), ['b']);
  assert.equal(index.has('k2'), false);
  index.removeUser('b');
  assert.equal(index.size, 0);
  index.removeUser('never-indexed');
  assert.equal(index.size, 0);
});

test('setUser reports the holder count of each key it newly shares, and nothing on a re-index', () => {
  const index = new AccountIndex();
  assert.deepEqual(index.setUser('a', ['k1', 'k2']), []);
  assert.deepEqual(index.setUser('b', ['k1']), [2]);
  assert.deepEqual(index.setUser('c', ['k1', 'k2']), [3, 2]);
  assert.deepEqual(index.setUser('c', ['k1', 'k2']), []);
  assert.deepEqual(index.setUser('a', ['k1', 'k2']), []);
});
