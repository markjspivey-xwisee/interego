/**
 * Regression test for the three-mode targeted-userId selection used by
 * the SIWE handler (deploy/identity/server.ts:2072-2124) and the
 * WebAuthn /register handler (deploy/identity/server.ts:2353-2392).
 *
 * Before this test existed, only the deterministic derivation hashes
 * were pinned (derive-userid.test.ts). The branch selection — which
 * gates bootstrap-invite consumption AND protects against account
 * enumeration via uniform error responses — had no unit test. A
 * regression that swapped the order of the existing-credential guard
 * and the verifyInvite call would reintroduce the enumeration oracle
 * the server comment explicitly warns about ("don't disclose whether
 * `bootstrapUserId` is a valid seeded account"), and nothing would
 * catch it before deploy.
 *
 * Run:
 *   node --test --import tsx tests/resolve-target-userid.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  resolveTargetUserId,
  type AuthMethodsLike,
} from '../resolve-target-userid.js';

const emptyMethods: AuthMethodsLike = {
  walletAddresses: [],
  webAuthnCredentials: [],
  didKeys: [],
};

const populatedMethods: AuthMethodsLike = {
  walletAddresses: ['0xdeadbeef'],
  webAuthnCredentials: [],
  didKeys: [],
};

// Inert derive stubs — the helper just calls them; the deterministic
// shape is already pinned by derive-userid.test.ts. We use stubs here
// so the helper test stays focused on branch selection, not hashing.
const deriveFromAddress = (addr: string) => `u-eth-${addr.slice(0, 12)}`;
const deriveFromCredentialId = (id: string) => `u-pk-${id.slice(0, 12)}`;
const deriveFromDid = (did: string) => `u-did-${did.slice(8, 20)}`;

// Default verifyInvite: only accepts the (markj, token-good) pair.
function verifyInviteFactory(opts?: { accept?: Array<[string, string]> }) {
  const calls: Array<{ userId: string; token: string | undefined }> = [];
  const accept = opts?.accept ?? [['markj', 'token-good']];
  const fn = (userId: string, token: string | undefined) => {
    calls.push({ userId, token });
    return accept.some(([u, t]) => u === userId && t === token);
  };
  return { fn, calls };
}

test('(a) mode A — SIWE derives from recoveredAddress', () => {
  const out = resolveTargetUserId({
    recoveredAddress: 'd8da6bf26964af9d7eed9e03e53415d37aa96045',
    existingAuthMethods: emptyMethods,
    deriveFromAddress,
    deriveFromCredentialId,
    verifyInvite: () => false,
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.mode, 'derive');
    assert.equal(out.targetUserId, 'u-eth-d8da6bf26964');
  }
});

test('(a) mode A — DID derives from did:key string', () => {
  const out = resolveTargetUserId({
    did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSrnGoVgJpwbsXjPLwzx',
    existingAuthMethods: emptyMethods,
    deriveFromAddress,
    deriveFromCredentialId,
    deriveFromDid,
    verifyInvite: () => false,
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.mode, 'derive');
    assert.equal(out.targetUserId, 'u-did-z6MkpTHR8VNs');
  }
});

test('(b) mode B locked-out response is byte-identical across SIWE / WebAuthn / DID', () => {
  // Pins enumeration-safety across ALL three credential families: the
  // /auth/did handler shares the same resolver as SIWE + WebAuthn, so a
  // future refactor that diverges any one of them surfaces here.
  const lockedSiwe = resolveTargetUserId({
    bootstrapUserId: 'markj',
    bootstrapInvite: 'token-good',
    recoveredAddress: 'd8da6bf26964af9d7eed9e03e53415d37aa96045',
    existingAuthMethods: populatedMethods,
    deriveFromAddress,
    deriveFromCredentialId,
    deriveFromDid,
    verifyInvite: () => true,
  });
  const lockedDid = resolveTargetUserId({
    bootstrapUserId: 'markj',
    bootstrapInvite: 'token-good',
    did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSrnGoVgJpwbsXjPLwzx',
    existingAuthMethods: populatedMethods,
    deriveFromAddress,
    deriveFromCredentialId,
    deriveFromDid,
    verifyInvite: () => true,
  });
  assert.deepEqual(lockedSiwe, lockedDid);
});

test('(a) mode A — WebAuthn derives from credentialId', () => {
  const out = resolveTargetUserId({
    credentialId: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA',
    existingAuthMethods: emptyMethods,
    deriveFromAddress,
    deriveFromCredentialId,
    verifyInvite: () => false,
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.mode, 'derive');
    assert.equal(out.targetUserId, 'u-pk-AQIDBAUGBwgJ');
  }
});

test('(b) mode B requires BOTH bootstrapUserId and bootstrapInvite — only userId is a 400', () => {
  const out = resolveTargetUserId({
    bootstrapUserId: 'markj',
    existingAuthMethods: emptyMethods,
    deriveFromAddress,
    deriveFromCredentialId,
    verifyInvite: () => true,
  });
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, 400);
    assert.match(out.body.error, /both be supplied/);
  }
});

test('(b) mode B requires BOTH bootstrapUserId and bootstrapInvite — only invite is a 400', () => {
  const out = resolveTargetUserId({
    bootstrapInvite: 'token-good',
    existingAuthMethods: emptyMethods,
    deriveFromAddress,
    deriveFromCredentialId,
    verifyInvite: () => true,
  });
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, 400);
  }
});

test('(b) mode B succeeds when both supplied + invite is valid + no existing credential', () => {
  const { fn, calls } = verifyInviteFactory();
  const out = resolveTargetUserId({
    bootstrapUserId: 'markj',
    bootstrapInvite: 'token-good',
    existingAuthMethods: emptyMethods,
    deriveFromAddress,
    deriveFromCredentialId,
    verifyInvite: fn,
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.mode, 'bootstrap');
    assert.equal(out.targetUserId, 'markj');
  }
  assert.equal(calls.length, 1, 'verifyInvite is consulted exactly once');
});

test('(c) mode B rejects with uniform 401-equivalent when target already has any credential', () => {
  const { fn, calls } = verifyInviteFactory();
  const out = resolveTargetUserId({
    bootstrapUserId: 'markj',
    bootstrapInvite: 'token-good',
    existingAuthMethods: populatedMethods,
    deriveFromAddress,
    deriveFromCredentialId,
    verifyInvite: fn,
  });
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, 401);
    assert.equal(out.body.error, 'Bootstrap credential invalid or already consumed');
  }
  // Critical enumeration-safety invariant: the existing-credential guard
  // MUST run BEFORE verifyInvite is consulted. Otherwise an attacker who
  // doesn't know a real seeded userId could probe by submitting an
  // invalid invite; a discrepancy in side effects (or in timing) between
  // "userId real but locked" and "userId unknown" would leak the bit.
  assert.equal(calls.length, 0, 'existing-credential guard short-circuits before invite check');
});

test('(d) mode B fails uniformly on invalid invite — same status + body as the locked-out case', () => {
  // Compare the locked-out response to the invalid-invite response and
  // assert they are byte-identical. If a future refactor reorders the
  // checks or changes one of the error strings, this assertion fires
  // and the enumeration oracle never ships.
  const lockedOut = resolveTargetUserId({
    bootstrapUserId: 'markj',
    bootstrapInvite: 'token-good',
    existingAuthMethods: populatedMethods,
    deriveFromAddress,
    deriveFromCredentialId,
    verifyInvite: () => true,
  });
  const invalidInvite = resolveTargetUserId({
    bootstrapUserId: 'markj',
    bootstrapInvite: 'token-bad',
    existingAuthMethods: emptyMethods,
    deriveFromAddress,
    deriveFromCredentialId,
    verifyInvite: () => false,
  });
  assert.equal(lockedOut.ok, false);
  assert.equal(invalidInvite.ok, false);
  assert.deepEqual(lockedOut, invalidInvite);
});

test('(e) mode C uses the bearer-provided addDeviceUserId verbatim', () => {
  // Critically: when addDeviceUserId is set, the helper MUST NOT consult
  // verifyInvite or even look at recoveredAddress/credentialId. The
  // bearer token already proved ownership upstream.
  const { fn, calls } = verifyInviteFactory();
  const out = resolveTargetUserId({
    addDeviceUserId: 'u-pk-existinguser1',
    // Trap fields — these MUST be ignored when addDeviceUserId is set.
    bootstrapUserId: 'markj',
    bootstrapInvite: 'token-good',
    credentialId: 'someothercred',
    recoveredAddress: 'someotheraddr',
    existingAuthMethods: emptyMethods,
    deriveFromAddress,
    deriveFromCredentialId,
    verifyInvite: fn,
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.mode, 'addDevice');
    assert.equal(out.targetUserId, 'u-pk-existinguser1');
  }
  assert.equal(calls.length, 0, 'mode C must not consult verifyInvite');
});

test('mode B — verifyInvite is consulted only after the existing-credential guard passes', () => {
  // Pins the ORDER even when the invite is invalid. If a regression
  // reorders the checks to call verifyInvite first, the side-effect-free
  // verifyInvite stub here still records a call and this assertion fires.
  const { fn, calls } = verifyInviteFactory({ accept: [] });
  const out = resolveTargetUserId({
    bootstrapUserId: 'markj',
    bootstrapInvite: 'whatever',
    existingAuthMethods: populatedMethods, // locks out first
    deriveFromAddress,
    deriveFromCredentialId,
    verifyInvite: fn,
  });
  assert.equal(out.ok, false);
  assert.equal(calls.length, 0);
});

test('mode A — no derive input supplied is a 400 (caller logic-bug fallthrough)', () => {
  // Pins the final fallthrough: when none of addDeviceUserId,
  // bootstrapUserId/bootstrapInvite, recoveredAddress, credentialId, or
  // did is supplied, the helper MUST return a 400 with a clear error
  // rather than silently deriving from undefined (which would produce a
  // `u-eth-undefined`-shape userId).
  const out = resolveTargetUserId({
    existingAuthMethods: emptyMethods,
    deriveFromAddress,
    deriveFromCredentialId,
    verifyInvite: () => false,
  });
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, 400);
    assert.match(out.body.error, /credential material/);
  }
});
