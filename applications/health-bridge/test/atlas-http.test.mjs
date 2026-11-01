import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTION, createHealthBridge } from '../bridge.mjs';
import { createEncryptedStore } from '../security.mjs';

const START = Date.parse('2026-11-01T15:00:00Z');
const SUBJECT = { name: 'Test Subject', birthDate: '1980-02-03' };
const PATIENT = 'PRIVATE-HTTP-PATIENT';
const actors = Object.fromEntries(['admin', 'owner', 'other'].map(name => [name, {
  principal: `did:web:identity.example:users:${name}`,
  userId: name,
  agentId: `did:web:identity.example:agents:${name}`,
  podUrl: `https://store.example/${name}/`,
  // Browser authority must come from the bridge session, not this identity proof.
  transport: 'mcp', authenticatedAt: 0,
}]));
const sha = value => createHash('sha256').update(value).digest('hex');
const ownerKey = actor => 'owner:' + sha(actor.principal);
const recordKey = (actor, id) => 'record:' + sha(actor.principal + ':' + id);
const publicPath = format => `/public/atlas/mayya/record.${format}`;
const patient = () => ({ resourceType: 'Patient', id: PATIENT,
  name: [{ use: 'official', given: ['Test'], family: 'Subject' }], birthDate: SUBJECT.birthDate,
  identifier: [{ value: 'PRIVATE-MRN-HTTP' }], telecom: [{ value: 'private-person@example.test' }],
});
const observation = (value = 12) => ({ resourceType: 'Observation', id: 'PRIVATE-HTTP-OBSERVATION',
  subject: { reference: `Patient/${PATIENT}` }, identifier: [{ value: 'PRIVATE-LAB-IDENTIFIER' }],
  status: 'final', effectiveDateTime: '2026-10-31T08:00:00Z',
  code: { coding: [{ system: 'http://loinc.org', code: '718-7', display: 'Hemoglobin' }] },
  valueQuantity: { value, unit: 'g/dL', system: 'http://unitsofmeasure.org', code: 'g/dL' },
  text: { div: '<div>PRIVATE-NOTE-HTTP bearer PRIVATE-SOURCE-TOKEN</div>' },
});

async function fixture(t) {
  let time = START;
  const directory = await mkdtemp(join(tmpdir(), 'atlas-http-'));
  const encrypted = createEncryptedStore({ directory, keyHex: 'c3'.repeat(32) });
  const privateReads = [], upstream = [], authenticated = [];
  let signedChecks = 0;
  const store = { ...encrypted, async get(key) {
    if (key.startsWith('owner:') || key.startsWith('record:')) privateReads.push(key);
    return encrypted.get(key);
  } };
  const security = {
    async authenticateBearer(header) {
      const actor = actors[header.replace('Bearer synthetic-', '')];
      assert.ok(actor, 'OAuth callback must authenticate the synthetic relay credential');
      authenticated.push(actor.principal);
      return { ...actor };
    },
    async authenticateSigned(envelope, action, target) {
      signedChecks++;
      const payload = JSON.parse(envelope._signed_payload);
      assert.equal(payload.action, action); assert.equal(payload.target, target);
      assert.ok(actors[payload.actor]);
      return { ...actors[payload.actor], payload };
    },
  };
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bridge = createHealthBridge({ publicUrl: origin, relayUrl: 'https://relay.example',
    store, security, now: () => time, duke: { clientId: 'synthetic-epic-client' }, oura: {},
    atlas: { adminPrincipal: actors.admin.principal, expectedSubject: SUBJECT,
      atlasUrl: 'https://atlas.example/', baseRecord: {
        meta: { subject: SUBJECT.name, scope: 'Synthetic curated history and reviewed provider records.' },
        timeline: [{ id: 'curated-event', title: 'Curated family history', sourceIds: ['curated-source'] }],
        sources: [{ id: 'curated-source', title: 'Previously public family update' }],
        faq: [{ q: 'What does the older family history say?', a: 'A dated family history.', sourceIds: ['curated-source'] }],
      } },
    fetch: async (url, options) => {
      upstream.push(url);
      assert.equal(options.redirect, 'error');
      if (url === 'https://relay.example/.well-known/oauth-authorization-server') return Response.json({
        authorization_endpoint: 'https://relay.example/authorize', token_endpoint: 'https://relay.example/token',
      });
      if (url === 'https://relay.example/token') {
        const actor = options.body.get('code'); assert.ok(actors[actor]);
        return Response.json({ access_token: 'synthetic-' + actor, expires_in: 3600 });
      }
      throw new Error('Unexpected upstream request in an HTTP publication test');
    },
  });
  server.on('request', bridge.handler);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await store.put(ownerKey(actors.owner), { principal: actors.owner.principal, userId: 'owner',
    consent: { enabled: true }, sources: { duke: { connected: true, patientId: PATIENT,
      lastAttempt: '2026-11-01T14:00:00Z', lastSync: '2026-11-01T14:00:00Z',
      token: { access_token: 'PRIVATE-SOURCE-TOKEN', refresh_token: 'PRIVATE-REFRESH-TOKEN' },
    } }, records: [], batches: [],
  });
  const insert = async raw => {
    const actor = actors.owner, id = `duke:${raw.resourceType}:${raw.id}`;
    await store.put(recordKey(actor, id), { id, source: 'duke', resourceType: raw.resourceType,
      retrievedAt: new Date(time).toISOString(), sourceUrl: `https://private.example/${PATIENT}`, raw });
    const owner = await store.get(ownerKey(actor));
    const index = { id, source: 'duke', resourceType: raw.resourceType,
      digest: sha(JSON.stringify(raw)), clinicalDate: raw.effectiveDateTime ?? null };
    const prior = owner.records.findIndex(item => item.id === id);
    if (prior === -1) owner.records.push(index); else owner.records[prior] = index;
    await store.put(ownerKey(actor), owner);
  };
  await insert(patient()); await insert(observation());
  const call = async (operation, params = {}, actor = 'admin') => {
    const payload = { action: ACTION + operation, target: origin, actor, params,
      nonce: 'synthetic-http-nonce-12345', transport: 'browser', authenticatedAt: time };
    const response = await fetch(origin + '/actions', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _signed_payload: JSON.stringify(payload), _signature: 'verified-by-security-test-suite',
        transport: 'browser', authenticatedAt: time }),
    });
    return { status: response.status, body: await response.json() };
  };
  const signIn = async (actor = 'owner') => {
    const start = await fetch(origin + '/oauth/interego/start', { redirect: 'manual' });
    assert.equal(start.status, 303);
    const flowCookie = start.headers.get('set-cookie').split(';')[0];
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await fetch(`${origin}/oauth/interego/callback?code=${actor}&state=${state}`, {
      headers: { Cookie: flowCookie }, redirect: 'manual',
    });
    assert.equal(callback.status, 303);
    const cookie = callback.headers.get('set-cookie').split(';')[0];
    const response = await fetch(origin + '/api/status', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.owner.principal, actors[actor].principal);
    return { cookie, csrfToken: status.csrfToken };
  };
  const browser = async (session, operation, body = {}, headerChanges = {}) => {
    const headers = { 'Content-Type': 'application/json', Cookie: session?.cookie,
      Origin: origin, 'X-CSRF-Token': session?.csrfToken, ...headerChanges };
    for (const [key, value] of Object.entries(headers)) if (value === undefined || value === null) delete headers[key];
    const response = await fetch(origin + '/api/' + operation, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const link = async () => {
    const grant = await call('atlas/link'); assert.equal(grant.status, 200);
    const url = new URL(grant.body.url); assert.equal(url.origin, origin);
    assert.equal(url.search, ''); assert.match(url.hash, /^#atlas-link=[A-Za-z0-9_-]{43}$/);
    return url.hash.slice('#atlas-link='.length);
  };
  const claim = async session => browser(session, 'atlas/claim', { token: await link(),
    // These fields are deliberately stale/false; only server-injected authority counts.
    transport: 'mcp', authenticatedAt: 0, principal: actors.admin.principal });
  return { origin, store, insert, call, signIn, browser, link, claim, privateReads, upstream, authenticated,
    signedChecks: () => signedChecks, advance: milliseconds => { time += milliseconds; } };
}

test('browser owner publishes the reviewed server draft; every public format reads only that approved copy', async t => {
  const f = await fixture(t);
  for (const format of ['json', 'jsonld', 'md', 'ttl']) {
    const response = await fetch(f.origin + publicPath(format));
    assert.equal(response.status, 404); assert.equal((await response.json()).error, 'atlas_not_published');
  }
  assert.equal((await f.call('atlas/link', {}, 'owner')).status, 403);
  const session = await f.signIn();
  assert.equal((await f.claim(session)).status, 200);
  assert.deepEqual(f.authenticated, [actors.owner.principal]);
  const preview = await f.browser(session, 'atlas/preview'); assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.subject, SUBJECT);
  const draft = preview.body;
  assert.equal(draft.projection.labs[0].values[0].value, 12);
  const published = await f.browser(session, 'atlas/publish', { draftId: draft.draftId,
    digest: draft.digest, baseRevision: draft.baseRevision, autoPublish: false,
    projection: { meta: { subject: 'CLIENT-FORGED-PUBLIC-RECORD' } },
    target: 'https://attacker.example/', principal: actors.admin.principal,
  });
  assert.equal(published.status, 200); assert.equal(published.body.revision, 1);
  assert.equal(published.body.publicRecordUrl, f.origin + publicPath('json'));
  assert.equal(draft.projection.meta.publication.managementUrl, f.origin);
  assert.equal(draft.projection.meta.publication.publicRecordUrl, published.body.publicRecordUrl);

  const expected = await (await fetch(f.origin + publicPath('json'))).text();
  const publicRecord = JSON.parse(expected);
  const approved = JSON.parse(expected);
  if (!Object.hasOwn(draft.projection, 'reconciliation')) delete approved.reconciliation;
  for (const faq of approved.faq ?? []) delete faq.questionId;
  assert.deepEqual(approved, draft.projection);
  const reads = f.privateReads.length, external = f.upstream.length;
  const formats = { json: 'application/json', jsonld: 'application/ld+json', md: 'text/markdown', ttl: 'text/turtle' };
  const approvedBodies = new Map();
  for (const [format, type] of Object.entries(formats)) {
    const response = await fetch(f.origin + publicPath(format));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type').split(';')[0], type);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.equal(response.headers.get('x-atlas-revision'), '1');
    assert.match(response.headers.get('access-control-expose-headers'), /X-Atlas-Revision/i);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('set-cookie'), null);
    const body = await response.text();
    approvedBodies.set(format, body);
    assert.doesNotMatch(body, /PRIVATE-|1980-02-03|private-person@example|CLIENT-FORGED|attacker\.example|did:web:identity/);
    if (format === 'json') assert.equal(body, expected);
    if (format === 'jsonld') {
      const ld = JSON.parse(body); assert.equal(ld['dct:hasVersion'], 1);
      assert.equal(ld['schema:encoding']['schema:text'], expected);
      assert.equal(ld['schema:encoding']['schema:contentUrl'], published.body.publicRecordUrl);
    }
    if (format === 'ttl') assert.ok(body.includes(JSON.stringify(expected) + '^^rdf:JSON'));
    if (format === 'md') {
      assert.match(body, /Publication revision: 1/);
      const sections = Object.fromEntries([...body.matchAll(/## (\w+)\n\n```json\n([\s\S]*?)\n```/g)].map(match => [match[1], JSON.parse(match[2])]));
      assert.deepEqual(sections, publicRecord);
    }
  }
  assert.equal(f.privateReads.length, reads, 'public formats must never load a private owner or source record');
  assert.equal(f.upstream.length, external, 'public reads must not start a source or identity request');
  await f.insert(observation(13));
  const pending = await f.browser(session, 'atlas/preview'); assert.equal(pending.status, 200);
  assert.equal(pending.body.projection.labs[0].values[0].value, 13);
  for (const [format, approvedBody] of approvedBodies) {
    const response = await fetch(f.origin + publicPath(format));
    assert.equal(response.headers.get('x-atlas-revision'), '1');
    assert.equal(await response.text(), approvedBody, 'an unpublished preview must not change any public representation');
  }
});

test('Atlas browser writes require a real session, exact Origin and CSRF despite caller-forged browser authority', async t => {
  const f = await fixture(t), session = await f.signIn(), token = await f.link();
  const operations = ['atlas/claim', 'atlas/preview', 'atlas/publish', 'atlas/automatic'];
  for (const operation of operations) {
    const forged = { token, principal: actors.owner.principal, owner: actors.owner.principal,
      transport: 'browser', authenticatedAt: START, enabled: true };
    const absent = await f.browser(null, operation, forged, { 'X-CSRF-Token': session.csrfToken,
      Authorization: 'Bearer synthetic-owner' });
    assert.equal(absent.status, 401); assert.equal(absent.body.error, 'sign_in_required');
    for (const changes of [{ Origin: null }, { Origin: 'https://attacker.example' },
      { 'X-CSRF-Token': null }, { 'X-CSRF-Token': 'forged-csrf' }]) {
      const rejected = await f.browser(session, operation, forged, changes);
      assert.equal(rejected.status, 403); assert.equal(rejected.body.error, 'request_origin');
    }
  }
  const claimed = await f.browser(session, 'atlas/claim', { token });
  assert.equal(claimed.status, 200, 'failed CSRF checks must not consume the one-time link');
});

test('signed agent routes advertise enrollment and bounded editorial review only and cannot forge browser publication transport', async t => {
  const f = await fixture(t), profile = await (await fetch(f.origin + '/profile')).json();
  const atlasActions = profile.affordances.filter(item => item.action.startsWith(ACTION + 'atlas/'));
  assert.deepEqual(atlasActions.map(item => item.action), [ACTION + 'atlas/link', ACTION + 'atlas/review']);
  const turtle = await (await fetch(f.origin + '/profile.ttl')).text();
  assert.ok(turtle.includes('<' + ACTION + 'atlas/link>'));
  const checked = f.signedChecks();
  for (const operation of ['atlas/claim', 'atlas/preview', 'atlas/publish', 'atlas/automatic']) {
    assert.equal(turtle.includes('<' + ACTION + operation + '>'), false);
    const rejected = await f.call(operation, { transport: 'browser', authenticatedAt: START,
      principal: actors.owner.principal, enabled: true, token: 'x'.repeat(43) });
    assert.equal(rejected.status, 400); assert.equal(rejected.body.error, 'action_invalid');
  }
  assert.equal(f.signedChecks(), checked, 'unadvertised publication actions must be rejected before signed authentication');
  const grant = await f.call('atlas/link'); assert.equal(grant.status, 200);
  assert.equal(f.signedChecks(), checked + 1);
});

test('another browser account cannot publish the linked owner by injecting identity or reusing its draft', async t => {
  const f = await fixture(t), owner = await f.signIn(), other = await f.signIn('other');
  assert.equal((await f.claim(owner)).status, 200);
  const draft = (await f.browser(owner, 'atlas/preview')).body;
  for (const [operation, input] of [
    ['atlas/preview', {}],
    ['atlas/publish', { draftId: draft.draftId, digest: draft.digest, baseRevision: draft.baseRevision }],
    ['atlas/automatic', { enabled: true }],
  ]) {
    const rejected = await f.browser(other, operation, { ...input, principal: actors.owner.principal,
      owner: actors.owner.principal, transport: 'browser', authenticatedAt: START });
    assert.equal(rejected.status, 403); assert.equal(rejected.body.error, 'atlas_owner_forbidden');
  }
  assert.equal((await fetch(f.origin + publicPath('json'))).status, 404);
  f.advance(3_600_001);
  const expired = await f.browser(owner, 'atlas/preview', { transport: 'browser', authenticatedAt: START + 3_600_001 });
  assert.equal(expired.status, 401); assert.equal(expired.body.error, 'sign_in_required');
});

test('browser claims validate the stored Duke Patient rather than caller-supplied matching demographics', async t => {
  const f = await fixture(t), session = await f.signIn(), token = await f.link();
  await f.insert({ ...patient(), birthDate: '1970-01-01' });
  const rejected = await f.browser(session, 'atlas/claim', { token, subject: SUBJECT,
    patientId: PATIENT, patient: patient(), principal: actors.owner.principal });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error, 'atlas_subject_mismatch');
  await f.insert(patient());
  assert.equal((await f.browser(session, 'atlas/claim', { token })).status, 200);
});


test('signed admin editorial action is bounded to approved public sources and cannot bypass source publication', async t => {
  const f = await fixture(t), owner = await f.signIn();
  assert.equal((await f.claim(owner)).status, 200);
  const draft = (await f.browser(owner, 'atlas/preview')).body;
  assert.equal((await f.browser(owner, 'atlas/publish', { draftId: draft.draftId, digest: draft.digest, baseRevision: draft.baseRevision })).status, 200);
  const publicUrl = f.origin + '/public/atlas/mayya/review.json';
  const response = await fetch(publicUrl); assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const context = await response.json();
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 96 * 1024);
  const publicRecord = await (await fetch(f.origin + publicPath('json'))).json();
  const sourceIds = publicRecord.labs[0].sourceIds;
  const input = { mode: 'submit', sourceRevision: context.sourceRevision, sourceDigest: context.sourceDigest,
    summaryBullets: [{ text: 'A structured laboratory record reports hemoglobin of 12 g/dL.', sourceIds }],
    questionAnswers: [{ questionId: publicRecord.faq[0].questionId, answer: 'The older family account remains dated history.', sourceIds: ['curated-source'] }],
  };
  const reads = f.privateReads.length;
  assert.equal((await f.call('atlas/review', { mode: 'context' })).status, 200);
  assert.equal((await f.call('atlas/review', input, 'owner')).status, 403);
  assert.equal((await f.call('atlas/review', { ...input, sourceDigest: 'sha256:' + '0'.repeat(64) })).status, 409);
  assert.equal((await f.call('atlas/review', { ...input, summaryBullets: [{ text: 'An uncited claim.', sourceIds: ['unknown-source'] }] })).status, 400);
  const published = await f.call('atlas/review', input); assert.equal(published.status, 200);
  assert.equal(published.body.reviewRevision, 1); assert.equal(published.body.reviewStatus, 'reviewed');
  const repeated = await f.call('atlas/review', input); assert.equal(repeated.body.duplicate, true);
  const stateResponse = await fetch(f.origin + '/public/atlas/mayya/review-status.json'); assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json(); assert.equal(state.reviewStatus, 'reviewed'); assert.equal(state.sourceRevision, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 4096);
  assert.equal(f.privateReads.length, reads, 'review action/context/status must never access private owner records');
  const updated = await (await fetch(f.origin + publicPath('json'))).json();
  assert.deepEqual(updated.agentReview.summaryBullets, input.summaryBullets);
  assert.equal(updated.meta.publication.contentDigest, context.sourceDigest);
  const adminSession = await f.signIn('admin');
  const browserAttempt = await f.browser(adminSession, 'atlas/review', input);
  assert.equal(browserAttempt.status, 403); assert.equal(browserAttempt.body.error, 'atlas_review_signed_action_required');
  const profile = await (await fetch(f.origin + '/profile')).json();
  const action = profile.affordances.find(item => item.action === ACTION + 'atlas/review');
  assert.equal(action.target, f.origin + '/actions'); assert.equal(action.parameters.mode, 'context | submit');
  const turtle = await (await fetch(f.origin + '/profile.ttl')).text();
  assert.ok(turtle.includes('<' + ACTION + 'atlas/review>'));
  assert.ok(turtle.includes('sourceRevision')); assert.ok(turtle.includes('summaryBullets'));
});
