/**
 * The pure half of restoring forgotten surface agents (surface-agent-restore.ts): which ids
 * parse as `<surface>-<canonical userId>`, when one is restored, the bound on anonymous
 * restores, and which ids POST /register-agent refuses as another user's.
 *
 * The route half (server.ts started against a stand-in pod server) is
 * tests/surface-agent-restore-routes.test.ts.
 *
 * Run:
 *   node --test --import tsx tests/surface-agent-restore.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_USER_ID,
  FIXED_SURFACES,
  SurfaceAgentRestores,
  decideSurfaceAgentRestore,
  isSurfaceSlug,
  parseSurfaceAgentId,
  registrationSquat,
  surfaceAgentLabel,
  type RestoreInput,
} from '../surface-agent-restore.js';
import {
  deriveUserIdFromCredentialId,
  deriveUserIdFromDid,
  deriveUserIdFromWallet,
} from '../derive-userid.js';

const ALICE = 'u-pk-f2a9c751075a';
const BOB = 'u-eth-d8da6bf26964';
const users = new Map<string, { type: string; name: string }>([
  [ALICE, { type: 'user', name: 'Alice' }],
  [BOB, { type: 'user', name: 'Bob' }],
  ['markj', { type: 'user', name: 'Mark' }],
  [`claude-${ALICE}`, { type: 'agent', name: 'not a user' }],
]);
const lookup = (id: string) => users.get(id);

function decide(agentId: unknown, extra: Partial<RestoreInput> = {}) {
  return decideSurfaceAgentRestore({ agentId, lookup, restoredFor: () => 0, restoredTotal: 0, ...extra });
}

test('the canonical user id shapes are the ones derive-userid.ts produces', () => {
  assert.match(deriveUserIdFromCredentialId('cred'), CANONICAL_USER_ID);
  assert.match(deriveUserIdFromWallet('0xd8da6bf26964af9d7eed9e03e53415d37aa96045'), CANONICAL_USER_ID);
  assert.match(deriveUserIdFromDid('did:key:z6Mk'), CANONICAL_USER_ID);
  for (const id of ['markj', 'u-try-0123456789ab', 'u-pend-0123456789ab', 'u-pk-0123456789a', 'u-pk-0123456789abc', 'u-pk-0123456789AB']) {
    assert.doesNotMatch(id, CANONICAL_USER_ID, id);
  }
});

test('parse: a relay surface and a canonical user id', () => {
  assert.deepEqual(parseSurfaceAgentId(`claude-${ALICE}`), { surface: 'claude', userId: ALICE, fixed: true });
  assert.deepEqual(parseSurfaceAgentId(`claude-code-vscode-${BOB}`), { surface: 'claude-code-vscode', userId: BOB, fixed: true });
  assert.deepEqual(parseSurfaceAgentId(`mcp-client-${ALICE}`), { surface: 'mcp-client', userId: ALICE, fixed: true });
  // A slugified client name (the relay's fallback for an unknown client_name).
  assert.deepEqual(parseSurfaceAgentId(`my-agent-2-${ALICE}`), { surface: 'my-agent-2', userId: ALICE, fixed: false });
  const did = deriveUserIdFromDid('did:key:zX');
  assert.deepEqual(parseSurfaceAgentId(`zed-${did}`), { surface: 'zed', userId: did, fixed: true });
});

test('the fixed surfaces and the slug rule are the relay\'s (deploy/mcp-relay/server.ts)', () => {
  const relay = readFileSync(fileURLToPath(new URL('../../mcp-relay/server.ts', import.meta.url)), 'utf8');
  const block = /const SURFACE_PATTERNS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(relay);
  assert.ok(block, 'SURFACE_PATTERNS not found in the relay');
  const relaySlugs = [...block[1]!.matchAll(/,\s*'([^']+)'\]/g)].map(m => m[1]!);
  assert.ok(relaySlugs.length >= 10, `only ${relaySlugs.length} slugs read from SURFACE_PATTERNS`);
  assert.deepEqual([...FIXED_SURFACES].filter(s => s !== 'mcp-client').sort(), [...new Set(relaySlugs)].sort());
  assert.match(relay, /\?\? 'mcp-client';/, 'the relay default surface is no longer mcp-client');
  assert.ok(relay.includes('/^[a-z][a-z0-9-]{1,31}$/.test(slug)'), 'the relay slug rule changed');
});

test('parse: every fixed surface is a relay slug', () => {
  for (const s of FIXED_SURFACES) {
    assert.ok(isSurfaceSlug(s), s);
    assert.equal(parseSurfaceAgentId(`${s}-${ALICE}`)?.fixed, true, s);
  }
});

test('parse: no restore for a non-canonical user id', () => {
  for (const id of ['claude-markj', 'claude-u-try-0123456789ab', 'claude-u-pend-0123456789ab',
    'claude-u-pk-0123456789a', 'claude-u-pk-0123456789abcd', 'claude-u-pk-0123456789AB', `claude-${ALICE}-x`,
    ALICE, `-${ALICE}`, 'claude', '']) {
    assert.equal(parseSurfaceAgentId(id), null, id);
  }
});

test('parse: no restore for a malformed surface slug', () => {
  for (const surface of ['Claude', 'c', '1claude', 'claude-', 'claude--code', 'claude_code', 'claude.code',
    'claude code', 'a'.repeat(33), 'claude/../x', 'ClAuDe']) {
    assert.equal(parseSurfaceAgentId(`${surface}-${ALICE}`), null, surface);
  }
  // The relay's longest slug is 32 characters, and it parses.
  assert.equal(parseSurfaceAgentId(`${'a'.repeat(32)}-${ALICE}`)?.surface, 'a'.repeat(32));
});

test('parse: no restore when the id names two users', () => {
  assert.equal(parseSurfaceAgentId(`claude-${BOB}-${ALICE}`), null);
  assert.equal(parseSurfaceAgentId(`${BOB}-${ALICE}`), null);
  assert.equal(parseSurfaceAgentId(`x-${BOB}-y-${ALICE}`), null);
});

test('parse: not a string, or too long', () => {
  for (const id of [undefined, null, 42, ['claude', ALICE], { id: `claude-${ALICE}` }]) {
    assert.equal(parseSurfaceAgentId(id), null);
  }
  assert.equal(parseSurfaceAgentId(`${'a-'.repeat(30)}${ALICE}`), null);
});

test('label: what ensureSurfaceAgent names a surface agent', () => {
  assert.equal(surfaceAgentLabel('claude', 'Alice'), 'Claude (Alice)');
  assert.equal(surfaceAgentLabel('claude-code-vscode', 'Alice'), 'Claude Code Vscode (Alice)');
  assert.equal(surfaceAgentLabel('mcp-client', 'Bob'), 'Mcp Client (Bob)');
});

test('restore: a known canonical user, as that user\'s agent', () => {
  const d = decide(`claude-${ALICE}`);
  assert.deepEqual(d, {
    restore: true, agentId: `claude-${ALICE}`, userId: ALICE, surface: 'claude',
    name: 'Claude (Alice)', scope: 'ReadWrite', counted: false,
  });
});

test('restore: never for an unknown user, a deleted user, or an id that is not a user', () => {
  assert.deepEqual(decide('claude-u-pk-000000000000'), { restore: false, reason: 'unknown-user' });
  // A deleted user is one deleteUserCompletely removed from the identities map.
  const afterDelete = new Map(users);
  afterDelete.delete(ALICE);
  assert.deepEqual(decide(`claude-${ALICE}`, { lookup: id => afterDelete.get(id) }), { restore: false, reason: 'unknown-user' });
  // An identity with a canonical id that is not a user (an agent registered under it).
  const agentNamedLikeAUser = (id: string) => (id === ALICE ? { type: 'agent', name: 'Squat' } : undefined);
  assert.deepEqual(decide(`claude-${ALICE}`, { lookup: agentNamedLikeAUser }), { restore: false, reason: 'unknown-user' });
  assert.deepEqual(decide('claude-markj'), { restore: false, reason: 'not-a-surface-agent' });
  assert.deepEqual(decide(`Claude-${ALICE}`), { restore: false, reason: 'not-a-surface-agent' });
});

test('restore: never for a reserved id', () => {
  const reserved = (id: string) => /^playwright-passkey-/.test(id);
  assert.deepEqual(decide(`playwright-passkey-${ALICE}`, { reserved }), { restore: false, reason: 'reserved' });
  assert.deepEqual(decide(`playwright-passkey-${ALICE}`, { reserved, tokenUserId: ALICE }), { restore: false, reason: 'reserved' });
  assert.equal(decide(`claude-${ALICE}`, { reserved }).restore, true);
});

test('restore: a token restores only its own user\'s agent, and is not counted', () => {
  assert.deepEqual(decide(`claude-${ALICE}`, { tokenUserId: BOB }), { restore: false, reason: 'token-for-another-user' });
  const own = decide(`my-tool-${ALICE}`, { tokenUserId: ALICE, restoredFor: () => 99, restoredTotal: 99_999 });
  assert.equal(own.restore, true);
  assert.equal(own.restore && own.counted, false);
});

test('bound: slugified names are capped per user and overall; fixed surfaces are not', () => {
  const limits = { perUser: 2, total: 3 };
  assert.deepEqual(decide(`my-tool-${ALICE}`, { limits, restoredFor: () => 2 }), { restore: false, reason: 'user-limit' });
  assert.deepEqual(decide(`my-tool-${ALICE}`, { limits, restoredFor: () => 0, restoredTotal: 3 }), { restore: false, reason: 'total-limit' });
  const fixed = decide(`cursor-${ALICE}`, { limits, restoredFor: () => 2, restoredTotal: 3 });
  assert.equal(fixed.restore && fixed.counted, false);
});

test('bound: the ledger counts what it admits, and forgets a deleted user', () => {
  const ledger = new SurfaceAgentRestores({ perUser: 2, total: 3 });
  const admit = (agentId: string, tokenUserId?: string) =>
    ledger.admit({ agentId, lookup, ...(tokenUserId ? { tokenUserId } : {}) });
  assert.equal(admit(`one-${ALICE}`).restore, true);
  assert.equal(admit(`two-${ALICE}`).restore, true);
  assert.deepEqual(admit(`three-${ALICE}`), { restore: false, reason: 'user-limit' });
  // Fixed surfaces and token-backed restores do not count.
  assert.equal(admit(`chatgpt-${ALICE}`).restore, true);
  assert.equal(admit(`three-${ALICE}`, ALICE).restore, true);
  assert.equal(admit(`one-${BOB}`).restore, true);
  assert.deepEqual(admit(`two-${BOB}`), { restore: false, reason: 'total-limit' });
  // A refused restore counts nothing.
  assert.deepEqual(admit('one-u-pk-000000000000'), { restore: false, reason: 'unknown-user' });
  ledger.forgetUser(ALICE);
  assert.equal(admit(`two-${BOB}`).restore, true);
  assert.equal(admit(`one-${ALICE}`).restore, true);
  assert.deepEqual(admit(`two-${ALICE}`), { restore: false, reason: 'total-limit' });
});

test('squat: another user\'s canonical suffix is refused, known to the server or not', () => {
  assert.equal(registrationSquat(`claude-${ALICE}`, BOB), ALICE);
  assert.equal(registrationSquat(`claude-code-${BOB}`, ALICE), BOB);
  // Derived from a public wallet address before its owner ever signed up.
  assert.equal(registrationSquat('claude-u-eth-0123456789ab', ALICE), 'u-eth-0123456789ab');
  // Any name in front, malformed or not: the suffix is what restore reads.
  assert.equal(registrationSquat(`Weird_Name-${ALICE}`, BOB), ALICE);
  // The bare id is the user's own namespace too.
  assert.equal(registrationSquat(ALICE, BOB), ALICE);
});

test('squat: the caller\'s own surface agents and ids without a canonical suffix are allowed', () => {
  assert.equal(registrationSquat(`claude-${ALICE}`, ALICE), null);
  assert.equal(registrationSquat(`my-tool-${ALICE}`, ALICE), null);
  for (const id of ['my-bot', 'claude-markj', `claude-${ALICE}-v2`, 'u-pk-0123456789a', `xu-pk-${ALICE.slice(5)}`, 42, undefined]) {
    assert.equal(registrationSquat(id, BOB), null, String(id));
  }
});
