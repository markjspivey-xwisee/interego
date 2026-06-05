/**
 * WebFinger (RFC 7033) unit tests.
 *
 * Drives the pure helpers in `../webfinger.ts` directly so we don't have
 * to spin up the Express app (server.ts has top-level `app.listen`
 * side effects). Mocks the `identities` map with a couple of records:
 *
 *   - canonical userId `u-pk-00181cd5dbee` whose displayName is
 *     mixed-case `Johnny`
 *   - canonical agentId `chatgpt-u-pk-00181cd5dbee` owned by the user
 *
 * Assertions:
 *   1. Looking up by canonical userId returns a JRD with the right
 *      subject + the WebID + did:web + pod-root aliases + the four
 *      mandated link rels.
 *   2. Looking up by displayName (lowercase `johnny`, mixed-case
 *      `Johnny`, uppercase `JOHNNY`) all resolve to the same record,
 *      and the response carries the displayName-form acct alias.
 *   3. Unknown handle → null (caller will 404 with empty body).
 *   4. ?rel filter restricts links to the requested rel(s) while
 *      leaving aliases intact.
 *   5. Agent handle resolves to the agent JRD with the actedOnBehalfOf
 *      link to the owner's WebID.
 *   6. parseWebFingerResource accepts acct:, https:.../users/<id>,
 *      https:.../agents/<id>, and rejects everything else.
 *
 * Run:
 *   node --test --import tsx tests/webfinger.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  type Identity,
  lookupWebFingerIdentity,
  buildWebFingerJrd,
  applyWebFingerRelFilter,
  parseWebFingerResource,
} from '../webfinger.js';

const BASE_URL = 'https://identity.example.test';
const CSS_URL = 'https://pods.example.test/';
const HOST = 'identity.example.test';

function fixtureIdentities(): Map<string, Identity> {
  const m = new Map<string, Identity>();
  m.set('u-pk-00181cd5dbee', {
    id: 'u-pk-00181cd5dbee',
    type: 'user',
    name: 'Johnny',                  // displayName, mixed case
    createdAt: '2026-01-01T00:00:00Z',
  });
  m.set('chatgpt-u-pk-00181cd5dbee', {
    id: 'chatgpt-u-pk-00181cd5dbee',
    type: 'agent',
    name: 'ChatGPT (Johnny)',
    owner: 'u-pk-00181cd5dbee',
    scope: 'ReadWrite',
    createdAt: '2026-01-01T00:00:00Z',
  });
  return m;
}

test('parseWebFingerResource — accepts acct, courtesy URLs, rejects garbage', () => {
  assert.equal(parseWebFingerResource('acct:johnny@example.test'), 'johnny');
  assert.equal(parseWebFingerResource('acct:u-pk-00181cd5dbee@example.test'), 'u-pk-00181cd5dbee');
  assert.equal(parseWebFingerResource('https://example.test/users/u-pk-00181cd5dbee'), 'u-pk-00181cd5dbee');
  assert.equal(parseWebFingerResource('https://example.test/agents/chatgpt-johnny'), 'chatgpt-johnny');
  assert.equal(parseWebFingerResource(''), null);
  assert.equal(parseWebFingerResource(undefined), null);
  assert.equal(parseWebFingerResource(42), null);
  assert.equal(parseWebFingerResource('https://example.test/random/path'), null);
  // acct without a handle
  assert.equal(parseWebFingerResource('acct:@example.test'), null);
});

test('lookupWebFingerIdentity — canonical userId hits the fast path', () => {
  const store = fixtureIdentities();
  const hit = lookupWebFingerIdentity('u-pk-00181cd5dbee', store);
  assert.ok(hit, 'expected a hit on canonical userId');
  assert.equal(hit!.id, 'u-pk-00181cd5dbee');
  assert.equal(hit!.type, 'user');
});

test('lookupWebFingerIdentity — displayName resolves regardless of case', () => {
  const store = fixtureIdentities();
  for (const handle of ['johnny', 'Johnny', 'JOHNNY', 'jOhNnY']) {
    const hit = lookupWebFingerIdentity(handle, store);
    assert.ok(hit, `expected hit for displayName ${handle}`);
    // The CANONICAL id comes back, never the displayName the requester sent.
    assert.equal(hit!.id, 'u-pk-00181cd5dbee', `case ${handle} should converge on canonical userId`);
    assert.equal(hit!.type, 'user');
  }
});

test('lookupWebFingerIdentity — unknown handle returns null', () => {
  const store = fixtureIdentities();
  assert.equal(lookupWebFingerIdentity('does-not-exist', store), null);
  assert.equal(lookupWebFingerIdentity('', store), null);
});

test('buildWebFingerJrd — user record carries WebID/did:web/pod aliases + 4 link rels', () => {
  const store = fixtureIdentities();
  const id = lookupWebFingerIdentity('u-pk-00181cd5dbee', store)!;
  const jrd = buildWebFingerJrd(id, { baseUrl: BASE_URL, cssUrl: CSS_URL, requestedHandle: 'u-pk-00181cd5dbee' });
  assert.equal(jrd.subject, `acct:u-pk-00181cd5dbee@${HOST}`);
  // Aliases: WebID + did:web + pod root (no displayName alias because requested handle == canonical id)
  assert.deepEqual(jrd.aliases, [
    `${BASE_URL}/users/u-pk-00181cd5dbee/profile`,
    `did:web:${HOST}:users:u-pk-00181cd5dbee`,
    `${CSS_URL}u-pk-00181cd5dbee/`,
  ]);
  const rels = (jrd.links ?? []).map(l => l.rel).sort();
  assert.deepEqual(rels, [
    'http://webfinger.net/rel/profile-page',
    'http://www.w3.org/ns/pim/space#storage',
    'http://www.w3.org/ns/solid/terms#oidcIssuer',
    'self',
  ].sort());
});

test('buildWebFingerJrd — displayName request adds the acct alias for the displayName form', () => {
  const store = fixtureIdentities();
  const id = lookupWebFingerIdentity('johnny', store)!;
  const jrd = buildWebFingerJrd(id, { baseUrl: BASE_URL, cssUrl: CSS_URL, requestedHandle: 'johnny' });
  // Subject is canonical, NEVER the displayName.
  assert.equal(jrd.subject, `acct:u-pk-00181cd5dbee@${HOST}`);
  // The displayName alias is appended.
  assert.ok(jrd.aliases?.includes(`acct:Johnny@${HOST}`),
    `expected acct:Johnny@${HOST} in aliases, got ${JSON.stringify(jrd.aliases)}`);
});

test('buildWebFingerJrd — agent record carries actedOnBehalfOf link to owner WebID', () => {
  const store = fixtureIdentities();
  const id = lookupWebFingerIdentity('chatgpt-u-pk-00181cd5dbee', store)!;
  const jrd = buildWebFingerJrd(id, { baseUrl: BASE_URL, cssUrl: CSS_URL, requestedHandle: 'chatgpt-u-pk-00181cd5dbee' });
  assert.equal(jrd.subject, `acct:chatgpt-u-pk-00181cd5dbee@${HOST}`);
  const ownerLink = (jrd.links ?? []).find(l => l.rel === 'http://www.w3.org/ns/prov#actedOnBehalfOf');
  assert.ok(ownerLink, 'expected actedOnBehalfOf link');
  assert.equal(ownerLink!.href, `${BASE_URL}/users/u-pk-00181cd5dbee/profile`);
  const selfLink = (jrd.links ?? []).find(l => l.rel === 'self');
  assert.ok(selfLink, 'expected self link');
  assert.equal(selfLink!.href, `${BASE_URL}/agents/chatgpt-u-pk-00181cd5dbee/did.json`);
});

test('applyWebFingerRelFilter — restricts links to matching rels, leaves aliases intact', () => {
  const store = fixtureIdentities();
  const id = lookupWebFingerIdentity('u-pk-00181cd5dbee', store)!;
  const jrd = buildWebFingerJrd(id, { baseUrl: BASE_URL, cssUrl: CSS_URL });
  const filtered = applyWebFingerRelFilter(jrd, 'http://www.w3.org/ns/solid/terms#oidcIssuer');
  assert.deepEqual(filtered.aliases, jrd.aliases, 'aliases must pass through unchanged');
  assert.equal(filtered.links?.length, 1);
  assert.equal(filtered.links?.[0]?.rel, 'http://www.w3.org/ns/solid/terms#oidcIssuer');
});

test('applyWebFingerRelFilter — repeated rel params filter to the union', () => {
  const store = fixtureIdentities();
  const id = lookupWebFingerIdentity('u-pk-00181cd5dbee', store)!;
  const jrd = buildWebFingerJrd(id, { baseUrl: BASE_URL, cssUrl: CSS_URL });
  const filtered = applyWebFingerRelFilter(jrd, [
    'http://www.w3.org/ns/solid/terms#oidcIssuer',
    'self',
  ]);
  const rels = (filtered.links ?? []).map(l => l.rel).sort();
  assert.deepEqual(rels, ['http://www.w3.org/ns/solid/terms#oidcIssuer', 'self'].sort());
});

test('applyWebFingerRelFilter — undefined / empty rel is a no-op', () => {
  const store = fixtureIdentities();
  const id = lookupWebFingerIdentity('u-pk-00181cd5dbee', store)!;
  const jrd = buildWebFingerJrd(id, { baseUrl: BASE_URL, cssUrl: CSS_URL });
  assert.deepEqual(applyWebFingerRelFilter(jrd, undefined), jrd);
  assert.deepEqual(applyWebFingerRelFilter(jrd, []), jrd);
});
