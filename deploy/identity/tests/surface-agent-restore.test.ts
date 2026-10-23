/**
 * The pure half of restoring forgotten surface agents (surface-agent-restore.ts): which ids
 * parse as `<surface>-<canonical userId>`, when one is restored (a token issued to its user,
 * or its user's pod registry listing it), the scope it comes back with, the bound on anonymous
 * restores, what a registry lists, and which ids POST /register-agent refuses.
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
  AGENT_ID_SYNTAX,
  CANONICAL_USER_ID,
  SurfaceAgentRestores,
  checkAgentIdForRegistration,
  decideSurfaceAgentRestore,
  foreignCanonicalSuffix,
  isSurfaceSlug,
  parseSurfaceAgentId,
  registryAgentScopes,
  surfaceAgentLabel,
  type AdmitInput,
  type RestoreGranted,
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
  [`mcp-client-${ALICE}`, { type: 'agent', name: 'MCP client (Alice)' }],
]);
const lookup = (id: string) => users.get(id);

function decide(agentId: unknown, extra: Partial<RestoreInput> = {}) {
  return decideSurfaceAgentRestore({ agentId, lookup, restoredFor: () => 0, ...extra });
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
  assert.deepEqual(parseSurfaceAgentId(`claude-${ALICE}`), { surface: 'claude', userId: ALICE });
  assert.deepEqual(parseSurfaceAgentId(`claude-code-vscode-${BOB}`), { surface: 'claude-code-vscode', userId: BOB });
  assert.deepEqual(parseSurfaceAgentId(`mcp-client-${ALICE}`), { surface: 'mcp-client', userId: ALICE });
  // A slugified client name (the relay's fallback for an unknown client_name).
  assert.deepEqual(parseSurfaceAgentId(`my-agent-2-${ALICE}`), { surface: 'my-agent-2', userId: ALICE });
  const did = deriveUserIdFromDid('did:key:zX');
  assert.deepEqual(parseSurfaceAgentId(`zed-${did}`), { surface: 'zed', userId: did });
});

test('parse: the relay\'s fixed surfaces and its default parse, and its slug rule is the one here', () => {
  const relay = readFileSync(fileURLToPath(new URL('../../mcp-relay/server.ts', import.meta.url)), 'utf8');
  const block = /const SURFACE_PATTERNS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(relay);
  assert.ok(block, 'SURFACE_PATTERNS not found in the relay');
  const relaySlugs = [...block[1]!.matchAll(/,\s*'([^']+)'\]/g)].map(m => m[1]!);
  assert.ok(relaySlugs.length >= 10, `only ${relaySlugs.length} slugs read from SURFACE_PATTERNS`);
  assert.match(relay, /\?\? 'mcp-client';/, 'the relay default surface is no longer mcp-client');
  for (const s of [...relaySlugs, 'mcp-client']) {
    assert.ok(isSurfaceSlug(s), s);
    assert.deepEqual(parseSurfaceAgentId(`${s}-${ALICE}`), { surface: s, userId: ALICE }, s);
  }
  assert.ok(relay.includes('/^[a-z][a-z0-9-]{1,31}$/.test(slug)'), 'the relay slug rule changed');
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
  // Whitespace or a control character after the user id: not this user's id.
  for (const tail of ['\n', '\r', '\t', ' ']) assert.equal(parseSurfaceAgentId(`cursor-${ALICE}${tail}`), null, JSON.stringify(tail));
  // The relay's longest slug is 32 characters, and it parses.
  assert.equal(parseSurfaceAgentId(`${'a'.repeat(32)}-${ALICE}`)?.surface, 'a'.repeat(32));
});

test('parse: no restore when the id names two users', () => {
  assert.equal(parseSurfaceAgentId(`claude-${BOB}-${ALICE}`), null);
  assert.equal(parseSurfaceAgentId(`${BOB}-${ALICE}`), null);
  assert.equal(parseSurfaceAgentId(`x-${BOB}-y-${ALICE}`), null);
});

test('parse: not a string, or too long', () => {
  for (const id of [undefined, null, 42, ['claude', ALICE], [`claude-${ALICE}`], { id: `claude-${ALICE}` }]) {
    assert.equal(parseSurfaceAgentId(id), null);
  }
  assert.equal(parseSurfaceAgentId(`${'a-'.repeat(30)}${ALICE}`), null);
});

test('label: what ensureSurfaceAgent names a surface agent', () => {
  assert.equal(surfaceAgentLabel('claude', 'Alice'), 'Claude (Alice)');
  assert.equal(surfaceAgentLabel('claude-code-vscode', 'Alice'), 'Claude Code Vscode (Alice)');
  assert.equal(surfaceAgentLabel('mcp-client', 'Bob'), 'Mcp Client (Bob)');
});

test('restore: an agent the user\'s registry lists, as that user\'s agent', () => {
  assert.deepEqual(decide(`claude-${ALICE}`, { registryScope: 'ReadWrite' }), {
    restore: true, agentId: `claude-${ALICE}`, userId: ALICE, surface: 'claude',
    name: 'Claude (Alice)', scope: 'ReadWrite', confirmedBy: 'registry',
  });
});

test('restore: an anonymous lookup never invents an agent the registry does not list', () => {
  // A fixed surface the person never used, and a slug the caller made up.
  for (const id of [`windsurf-${ALICE}`, `send-funds-here-${ALICE}`, `claude-${ALICE}`]) {
    assert.deepEqual(decide(id), { restore: false, reason: 'not-in-registry' }, id);
  }
});

test('restore: a token issued to the user restores without the registry, and is not counted', () => {
  const own = decide(`my-tool-${ALICE}`, { tokenUserId: ALICE, tokenScope: 'ReadWrite', restoredFor: () => 99 });
  assert.equal(own.restore, true);
  assert.equal(own.restore && own.confirmedBy, 'token');
  assert.deepEqual(decide(`claude-${ALICE}`, { tokenUserId: BOB, registryScope: 'ReadWrite' }), { restore: false, reason: 'token-for-another-user' });
});

test('restore: with the scope the registry entry or the token records, never a broader one', () => {
  // An id of this shape registered through POST /register-agent as ReadOnly stays ReadOnly.
  for (const scope of ['ReadOnly', 'PublishOnly', 'DiscoverOnly', 'ReadWrite'] as const) {
    const listed = decide(`my-tool-${ALICE}`, { registryScope: scope });
    assert.equal(listed.restore && listed.scope, scope, scope);
    const byToken = decide(`my-tool-${ALICE}`, { tokenUserId: ALICE, tokenScope: scope, registryScope: 'ReadWrite' });
    assert.equal(byToken.restore && byToken.scope, scope, scope);
  }
  // A token scope that is not a delegation scope (register-agent once stored any string), or none.
  for (const tokenScope of ['Admin', 'readwrite', '', 7, null, undefined]) {
    const r = decide(`my-tool-${ALICE}`, { tokenUserId: ALICE, tokenScope });
    assert.equal(r.restore && r.scope, 'DiscoverOnly', JSON.stringify(tokenScope));
  }
});

test('restore: never for an unknown user, a deleted user, or an id that is not a user', () => {
  assert.deepEqual(decide('claude-u-pk-000000000000', { registryScope: 'ReadWrite' }), { restore: false, reason: 'unknown-user' });
  // A deleted user is one deleteUserCompletely removed from the identities map.
  const afterDelete = new Map(users);
  afterDelete.delete(ALICE);
  assert.deepEqual(decide(`claude-${ALICE}`, { registryScope: 'ReadWrite', lookup: id => afterDelete.get(id) }), { restore: false, reason: 'unknown-user' });
  assert.deepEqual(decide(`claude-${ALICE}`, { tokenUserId: ALICE, lookup: id => afterDelete.get(id) }), { restore: false, reason: 'unknown-user' });
  // An identity with a canonical id that is not a user (an agent registered under it).
  const agentNamedLikeAUser = (id: string) => (id === ALICE ? { type: 'agent', name: 'Squat' } : undefined);
  assert.deepEqual(decide(`claude-${ALICE}`, { registryScope: 'ReadWrite', lookup: agentNamedLikeAUser }), { restore: false, reason: 'unknown-user' });
  assert.deepEqual(decide('claude-markj', { registryScope: 'ReadWrite' }), { restore: false, reason: 'not-a-surface-agent' });
  assert.deepEqual(decide(`Claude-${ALICE}`, { registryScope: 'ReadWrite' }), { restore: false, reason: 'not-a-surface-agent' });
});

test('restore: never for an id the server already holds, or a reserved one', () => {
  assert.deepEqual(decide(`mcp-client-${ALICE}`, { registryScope: 'ReadWrite' }), { restore: false, reason: 'known' });
  const reserved = (id: string) => /^playwright-passkey-/.test(id);
  assert.deepEqual(decide(`playwright-passkey-${ALICE}`, { reserved, registryScope: 'ReadWrite' }), { restore: false, reason: 'reserved' });
  assert.deepEqual(decide(`playwright-passkey-${ALICE}`, { reserved, tokenUserId: ALICE }), { restore: false, reason: 'reserved' });
  assert.equal(decide(`claude-${ALICE}`, { reserved, registryScope: 'ReadWrite' }).restore, true);
});

test('bound: anonymous restores are capped per user; token-backed ones are not', () => {
  const limits = { perUser: 2 };
  assert.deepEqual(decide(`my-tool-${ALICE}`, { limits, registryScope: 'ReadWrite', restoredFor: () => 2 }), { restore: false, reason: 'user-limit' });
  assert.equal(decide(`my-tool-${ALICE}`, { limits, registryScope: 'ReadWrite', restoredFor: () => 1 }).restore, true);
  assert.equal(decide(`my-tool-${ALICE}`, { limits, tokenUserId: ALICE, restoredFor: () => 2 }).restore, true);
});

/** A ledger over a registry that lists `registry` (ReadWrite unless `scopes` says), recording what it reads and seeds. */
function ledgerOver(registry: Record<string, readonly string[]>, perUser = 2, scopes: Record<string, 'ReadOnly'> = {}) {
  const ledger = new SurfaceAgentRestores({ perUser });
  const known = new Map(users);
  const reads: string[] = [];
  const seeded: RestoreGranted[] = [];
  const base: Pick<AdmitInput, 'lookup' | 'registryScope' | 'seed'> = {
    lookup: id => known.get(id),
    registryScope: async (userId, agentId) => {
      reads.push(userId);
      await new Promise(resolve => setImmediate(resolve));
      return (registry[userId] ?? []).includes(agentId) ? scopes[agentId] ?? 'ReadWrite' : undefined;
    },
    seed: granted => {
      seeded.push(granted);
      known.set(granted.agentId, { type: 'agent', name: granted.name });
    },
  };
  const admit = (agentId: string, extra: Partial<AdmitInput> = {}) => ledger.admit({ ...base, agentId, ...extra });
  return { ledger, known, reads, seeded, admit };
}

test('ledger: restores what the registry lists, once, and reads it only when everything else passes', async () => {
  const { reads, seeded, admit } = ledgerOver({ [ALICE]: [`claude-${ALICE}`] });
  assert.equal((await admit(`claude-${ALICE}`)).restore, true);
  assert.deepEqual(seeded.map(s => [s.agentId, s.scope, s.confirmedBy]), [[`claude-${ALICE}`, 'ReadWrite', 'registry']]);
  // Held now: refused as known, without a registry read.
  assert.deepEqual(await admit(`claude-${ALICE}`), { restore: false, reason: 'known' });
  for (const id of ['claude-u-pk-000000000000', 'claude-markj', `Claude-${ALICE}`, `claude-${BOB}-${ALICE}`]) await admit(id);
  assert.deepEqual(await admit(`cursor-${ALICE}`, { tokenUserId: BOB }), { restore: false, reason: 'token-for-another-user' });
  assert.deepEqual(reads, [ALICE]);
  // Not listed: refused after the read, and nothing seeded.
  assert.deepEqual(await admit(`windsurf-${ALICE}`), { restore: false, reason: 'not-in-registry' });
  assert.equal(seeded.length, 1);
});

test('ledger: made-up slugs cost a user nothing; only listed restores count', async () => {
  const { admit, reads } = ledgerOver({ [BOB]: [`my-client-${BOB}`, `tool-a-${BOB}`, `tool-b-${BOB}`] });
  for (let i = 1; i <= 10; i++) assert.deepEqual(await admit(`junk-${i}-${BOB}`), { restore: false, reason: 'not-in-registry' });
  assert.equal(reads.length, 10);
  // Bob's own custom client still comes back, and so does the next listed one.
  assert.equal((await admit(`my-client-${BOB}`)).restore, true);
  assert.equal((await admit(`tool-a-${BOB}`)).restore, true);
  // perUser 2 is spent on listed agents: the third waits for a token, without a read.
  assert.deepEqual(await admit(`tool-b-${BOB}`), { restore: false, reason: 'user-limit' });
  assert.equal(reads.length, 12);
  const byToken = await admit(`tool-b-${BOB}`, { tokenUserId: BOB });
  assert.equal(byToken.restore && byToken.confirmedBy, 'token');
});

test('ledger: lookups racing for one id seed it once and count it once', async () => {
  const { admit, seeded } = ledgerOver({ [ALICE]: [`claude-${ALICE}`, `cursor-${ALICE}`] });
  const results = await Promise.all([admit(`claude-${ALICE}`), admit(`claude-${ALICE}`), admit(`claude-${ALICE}`)]);
  assert.deepEqual(results.map(r => r.restore), [true, false, false]);
  assert.deepEqual(results.slice(1), [{ restore: false, reason: 'known' }, { restore: false, reason: 'known' }]);
  assert.equal(seeded.length, 1);
  // Counted once: the second listed agent still fits under perUser 2.
  assert.equal((await admit(`cursor-${ALICE}`)).restore, true);
});

test('ledger: a user deleted while the registry is read is not restored; an unreadable registry restores nothing', async () => {
  const { admit, known, seeded } = ledgerOver({ [ALICE]: [`claude-${ALICE}`] });
  const pending = admit(`claude-${ALICE}`);
  known.delete(ALICE);
  assert.deepEqual(await pending, { restore: false, reason: 'unknown-user' });
  assert.deepEqual(await admit(`cursor-${BOB}`, { registryScope: async () => { throw new Error('pod down'); } }), { restore: false, reason: 'not-in-registry' });
  assert.equal(seeded.length, 0);
});

test('ledger: a registry entry\'s scope is the one seeded; a token\'s scope wins without a read', async () => {
  const { admit, reads, seeded } = ledgerOver({ [ALICE]: [`my-tool-${ALICE}`] }, 2, { [`my-tool-${ALICE}`]: 'ReadOnly' });
  assert.equal((await admit(`my-tool-${ALICE}`)).restore, true);
  const byToken = await admit(`cursor-${ALICE}`, { tokenUserId: ALICE, tokenScope: 'PublishOnly' });
  assert.equal(byToken.restore && byToken.scope, 'PublishOnly');
  assert.deepEqual(seeded.map(s => [s.agentId, s.scope]), [[`my-tool-${ALICE}`, 'ReadOnly'], [`cursor-${ALICE}`, 'PublishOnly']]);
  assert.deepEqual(reads, [ALICE]);
});

test('ledger: a deleted user\'s count is released', async () => {
  const { admit, ledger } = ledgerOver({ [ALICE]: [`a-1-${ALICE}`, `a-2-${ALICE}`, `a-3-${ALICE}`] });
  assert.equal((await admit(`a-1-${ALICE}`)).restore, true);
  assert.equal((await admit(`a-2-${ALICE}`)).restore, true);
  assert.deepEqual(await admit(`a-3-${ALICE}`), { restore: false, reason: 'user-limit' });
  ledger.forgetUser(ALICE);
  assert.equal((await admit(`a-3-${ALICE}`)).restore, true);
});

// What the relay writes to `<pod>/agents` (ownerProfileToTurtle in @interego/core, verbatim
// output for two agents), entries whose scope is narrower, missing, unknown or listed twice,
// and entries this server must not take for one of its agents.
const REGISTRY = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .

<https://identity.example/users/${ALICE}/profile#me> a foaf:Person ;
    foaf:name "Alice" ;
    iep:authorizedAgent
        <#agent-did%3Aweb%3Aidentity.example%3Aagents%3Aclaude-${ALICE}>,
        <#agent-did%3Aweb%3Aidentity.example%3Aagents%3Amy-client-${ALICE}> .

<#agent-did%3Aweb%3Aidentity.example%3Aagents%3Aclaude-${ALICE}> a iep:AuthorizedAgent ;
    iep:agentIdentity <did:web:identity.example:agents:claude-${ALICE}> ;
    iep:delegatedBy <https://identity.example/users/${ALICE}/profile#me> ;
    iep:scope iep:ReadWrite ;
    iep:validFrom "2026-10-01T00:00:00.000Z"^^xsd:dateTime ;
    foaf:name "Claude (Alice)" ;
    a prov:SoftwareAgent ;
    iep:encryptionPublicKey "S2V5" .

<#agent-did%3Aweb%3Aidentity.example%3Aagents%3Amy-client-${ALICE}> a iep:AuthorizedAgent ;
    iep:agentIdentity <did:web:identity.example:agents:my-client-${ALICE}> ;
    iep:delegatedBy <https://identity.example/users/${ALICE}/profile#me> ;
    iep:scope iep:ReadWrite ;
    iep:validFrom "2026-10-01T00:00:00.000Z"^^xsd:dateTime ;
    foaf:name "My Client (Alice)" ;
    a prov:SoftwareAgent ;
    iep:encryptionPublicKey "S2V5" .

<#agent-did%3Aweb%3Aidentity.example%3Aagents%3Aread-only-${ALICE}> a iep:AuthorizedAgent ;
    iep:agentIdentity <did:web:identity.example:agents:read-only-${ALICE}> ;
    iep:delegatedBy <https://identity.example/users/${ALICE}/profile#me> ;
    iep:scope iep:ReadOnly ;
    iep:validFrom "2026-10-01T00:00:00.000Z"^^xsd:dateTime .

<#agent-read-only-${ALICE}> a iep:AuthorizedAgent ;
    iep:agentIdentity <read-only-${ALICE}> ;
    iep:scope iep:ReadOnly .

<#agent-both-${ALICE}> a iep:AuthorizedAgent ;
    iep:agentIdentity <both-${ALICE}> ;
    iep:scope iep:ReadWrite .
<#agent-did%3Aweb%3Aidentity.example%3Aagents%3Aboth-${ALICE}> a iep:AuthorizedAgent ;
    iep:agentIdentity <did:web:identity.example:agents:both-${ALICE}> ;
    iep:scope iep:PublishOnly .

<#agent-odd-${ALICE}> a iep:AuthorizedAgent ;
    iep:agentIdentity <odd-${ALICE}> ;
    iep:scope iep:Everything .

<#agent-legacy> a iep:AuthorizedAgent ;
    iep:agentIdentity <zed-${ALICE}> .
<#agent-elsewhere> a iep:AuthorizedAgent ;
    iep:agentIdentity <did:web:other.example:agents:cursor-${ALICE}> .
<#agent-webid> a iep:AuthorizedAgent ;
    iep:agentIdentity <https://identity.example/agents/chatgpt-${ALICE}/profile#agent> .
`;

test('registry: the agents the relay lists, as this server names them, with their scopes', () => {
  const scopes = registryAgentScopes(REGISTRY, ['did:web:identity.example:agents:']);
  assert.deepEqual([...scopes].sort(), [
    [`both-${ALICE}`, 'DiscoverOnly'],      // listed twice, with different scopes: the least
    [`claude-${ALICE}`, 'ReadWrite'],
    [`my-client-${ALICE}`, 'ReadWrite'],
    [`odd-${ALICE}`, 'DiscoverOnly'],       // not a delegation scope
    [`read-only-${ALICE}`, 'ReadOnly'],     // listed twice, in both forms, with one scope
    [`zed-${ALICE}`, 'DiscoverOnly'],       // no scope
  ]);
  // Under another host's DID none of the did:web entries is this server's.
  assert.deepEqual([...registryAgentScopes(REGISTRY, ['did:web:identity.test:agents:']).keys()].sort(),
    [`both-${ALICE}`, `odd-${ALICE}`, `read-only-${ALICE}`, `zed-${ALICE}`]);
  assert.equal(registryAgentScopes('', ['did:web:identity.example:agents:']).size, 0);
  assert.equal(registryAgentScopes('not turtle at all <>', ['did:web:identity.example:agents:']).size, 0);
});

test('register: another user\'s canonical suffix is refused, known to the server or not', () => {
  const refused = (agentId: string, caller: string) => {
    const r = checkAgentIdForRegistration(agentId, caller);
    if (r.ok === true) return assert.fail(`${agentId} was accepted`);
    return r;
  };
  assert.equal(refused(`claude-${ALICE}`, BOB).status, 403);
  assert.match(refused(`claude-code-${BOB}`, ALICE).error, new RegExp(`another user's id \\(${BOB}\\)`));
  // Derived from a public wallet address before its owner ever signed up.
  assert.equal(refused('claude-u-eth-0123456789ab', ALICE).status, 403);
  // The bare id is the user's own namespace too, and so is the id after `.` or `_`.
  for (const id of [ALICE, `weird_name-${ALICE}`, `claude.${ALICE}`, `claude_${ALICE}`]) assert.equal(refused(id, BOB).status, 403, id);
  assert.equal(foreignCanonicalSuffix(`claude-${ALICE}`, BOB), ALICE);
  assert.equal(foreignCanonicalSuffix(`claude-${ALICE}`, ALICE), null);
});

test('squat: whitespace a URL parser drops does not hide another user\'s suffix', () => {
  for (const id of [`cursor-${ALICE}\n`, `cursor-${ALICE}\t`, `cursor-${ALICE}\r`, `cursor-${ALICE.slice(0, 9)}\n${ALICE.slice(9)}`]) {
    assert.equal(foreignCanonicalSuffix(id, BOB), ALICE, JSON.stringify(id));
    // What the URL parser makes of the id is Alice's agent's document URL.
    assert.equal(new URL(`https://id.example/agents/${id}/did.json`).pathname, `/agents/cursor-${ALICE}/did.json`, JSON.stringify(id));
  }
  // Leading and trailing controls and spaces, which a parser strips from an id at either end of a URL.
  for (const id of [`cursor-${ALICE} `, ` cursor-${ALICE}`, `cursor-${ALICE}\u0000`]) {
    assert.equal(foreignCanonicalSuffix(id, BOB), ALICE, JSON.stringify(id));
  }
  assert.equal(foreignCanonicalSuffix(`cursor-${ALICE}\n`, ALICE), null);
});

test('register: anything but a plain slug is refused with 400, before the suffix is read', () => {
  for (const agentId of [
    [`claude-code-${BOB}`], { id: `claude-code-${BOB}` }, 42, true, null,
    `cursor-${BOB}\n`, `cursor-${BOB}\t`, `cursor-${BOB}\r`, `cursor-${BOB} `, ` cursor-${BOB}`, `cursor-${BOB}\u0000`,
    `Cursor-${ALICE}`, `cursor-U-PK-${ALICE.slice(5).toUpperCase()}`, 'my bot', 'a/b', 'a:b', 'did:web:x', '-bot', '.bot',
    'a'.repeat(65), '',
  ]) {
    const r = checkAgentIdForRegistration(agentId, ALICE);
    assert.equal(r.ok, false, JSON.stringify(agentId));
    assert.equal(r.ok === false && r.status, 400, JSON.stringify(agentId));
  }
  assert.ok(AGENT_ID_SYNTAX.test('a'.repeat(64)));
});

test('register: the caller\'s own surface agents and ids without a canonical suffix are allowed', () => {
  for (const id of [`claude-${ALICE}`, `my-tool-${ALICE}`, `claude-code-vscode-${ALICE}`, 'my-bot', 'bot.v2', 'claude-markj',
    `claude-${BOB}-v2`, 'u-pk-0123456789a', `xu-eth-${BOB.slice(6)}`]) {
    assert.deepEqual(checkAgentIdForRegistration(id, ALICE), { ok: true, agentId: id }, id);
  }
});
