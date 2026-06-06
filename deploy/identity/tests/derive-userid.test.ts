/**
 * Pin the three deterministic userId derivation functions used by the
 * targeted sign-in flows (WebAuthn / SIWE / DID).
 *
 * These shapes are a federation invariant: the same credential MUST
 * produce the same userId across every identity-server instance, every
 * deployment, every refactor. A drive-by change to the slice length
 * (`.slice(0, 12)` → `.slice(0, 16)`) or the prefix (`u-pk-` → `u-passkey-`)
 * would silently break that invariant — the same passkey enrolling on
 * an upgraded server would produce a different userId and therefore a
 * different pod path, splitting the user's history.
 *
 * The vectors below are FROZEN — do not edit to make this test pass.
 * If the derivation changes, that is a breaking change that needs an
 * explicit migration story.
 *
 * Run:
 *   node --test --import tsx tests/derive-userid.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  deriveUserIdFromCredentialId,
  deriveUserIdFromWallet,
  deriveUserIdFromDid,
} from '../derive-userid.js';

test('deriveUserIdFromCredentialId — frozen vector', () => {
  // base64url-shape passkey credential id (37 chars)
  assert.equal(
    deriveUserIdFromCredentialId('AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA'),
    'u-pk-eb9f16800c90',
  );
});

test('deriveUserIdFromCredentialId — deterministic + shape', () => {
  const a = deriveUserIdFromCredentialId('credential-A');
  const b = deriveUserIdFromCredentialId('credential-A');
  const c = deriveUserIdFromCredentialId('credential-B');
  assert.equal(a, b, 'same input must yield same userId');
  assert.notEqual(a, c, 'different input must yield different userId');
  assert.match(a, /^u-pk-[0-9a-f]{12}$/, 'shape: u-pk-<12 hex chars>');
});

test('deriveUserIdFromWallet — frozen vector (lowercased, no 0x)', () => {
  assert.equal(
    deriveUserIdFromWallet('d8da6bf26964af9d7eed9e03e53415d37aa96045'),
    'u-eth-d8da6bf26964',
  );
});

test('deriveUserIdFromWallet — strips a 0x prefix if present', () => {
  // The handler lowercases + normalizes upstream, but the function still
  // tolerates a leading 0x — converges on the same userId either way.
  assert.equal(
    deriveUserIdFromWallet('0xd8da6bf26964af9d7eed9e03e53415d37aa96045'),
    'u-eth-d8da6bf26964',
  );
  assert.equal(
    deriveUserIdFromWallet('d8da6bf26964af9d7eed9e03e53415d37aa96045'),
    deriveUserIdFromWallet('0xd8da6bf26964af9d7eed9e03e53415d37aa96045'),
  );
});

test('deriveUserIdFromWallet — shape', () => {
  assert.match(
    deriveUserIdFromWallet('0000000000000000000000000000000000000001'),
    /^u-eth-[0-9a-f]{12}$/,
  );
});

test('deriveUserIdFromDid — frozen vector', () => {
  assert.equal(
    deriveUserIdFromDid('did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSrnGoVgJpwbsXjPLwzx'),
    'u-did-4a9671330d2e',
  );
});

test('deriveUserIdFromDid — deterministic + shape', () => {
  const a = deriveUserIdFromDid('did:key:zA');
  const b = deriveUserIdFromDid('did:key:zA');
  const c = deriveUserIdFromDid('did:key:zB');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^u-did-[0-9a-f]{12}$/, 'shape: u-did-<12 hex chars>');
});

test('three derivation namespaces never collide', () => {
  // The prefix carves out three disjoint userId namespaces so a passkey,
  // a wallet, and a DID can never collapse onto the same userId even by
  // hash collision on the suffix.
  const pk = deriveUserIdFromCredentialId('x');
  const eth = deriveUserIdFromWallet('0000000000000000000000000000000000000000');
  const did = deriveUserIdFromDid('did:key:x');
  assert.ok(pk.startsWith('u-pk-'));
  assert.ok(eth.startsWith('u-eth-'));
  assert.ok(did.startsWith('u-did-'));
  assert.notEqual(pk, eth);
  assert.notEqual(pk, did);
  assert.notEqual(eth, did);
});
