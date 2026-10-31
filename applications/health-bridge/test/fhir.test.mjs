import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import {
  DUKE_BASE, DEFAULT_DUKE_SCOPE, DukeConnectionError, discoverDuke,
  authorizationRequest, exchangeDukeCode, refreshDukeToken, syncDuke,
} from '../fhir.mjs';

const patient = 'chart-1';
const verifier = 'a'.repeat(64);
const state = 'random-session-state-'.repeat(3);
const redirectUri = 'https://bridge.example/duke/callback';
const metadata = {
  fhirBase: DUKE_BASE,
  authorization_endpoint: 'https://health-apis.duke.edu/FHIR/oauth2/authorize',
  token_endpoint: 'https://health-apis.duke.edu/FHIR/oauth2/token',
  code_challenge_methods_supported: ['S256'],
  capabilities: ['client-public', 'permission-offline'],
  token_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_basic', 'client_secret_post'],
};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const bundle = (entries = [], next, total = entries.length) => ({ resourceType: 'Bundle', type: 'searchset', total, entry: entries.map(resource => ({ resource })), ...(next ? { link: [{ relation: 'next', url: next }] } : {}) });
const resource = (type, id = 'result-1', extras = {}) => ({ resourceType: type, id, subject: { reference: `Patient/${patient}` }, ...extras });
const validToken = (extras = {}) => ({ access_token: 'access-secret', token_type: 'Bearer', expires_in: 3600, patient, scope: 'launch/patient patient/Patient.read patient/Observation.read offline_access', ...extras });
const codeArgs = { metadata, clientId: 'client-1', redirectUri, state, verifier, code: 'one-use-code' };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

test('discovery uses only the pinned Duke base and forwards actual Epic client ID', async () => {
  const calls = [];
  const result = await discoverDuke({ clientId: 'registered-client', fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('smart-configuration')) return json(metadata);
    return json({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [{ type: 'Observation', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'patient' }] }] }] });
  } });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(x => x.url.startsWith(DUKE_BASE + '/') && x.options.headers['Epic-Client-ID'] === 'registered-client' && x.options.redirect === 'error'));
  assert.deepEqual(result.resources, [{ type: 'Observation', interactions: ['read', 'search-type'], searchParams: ['patient'] }]);
  assert.equal(result.resourceScopeListExhaustive, false);
});

test('discovery rejects untrusted provider OAuth endpoints', async () => {
  await assert.rejects(discoverDuke({ fetch: async url => url.endsWith('smart-configuration') ? json({ ...metadata, token_endpoint: 'https://other.example/token' }) : json({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1' }) }), { code: 'UNTRUSTED_ENDPOINT' });
});

test('authorization binds S256 PKCE, state, redirect and resource audience', () => {
  const request = authorizationRequest({ metadata, clientId: 'client-1', redirectUri, state, verifier });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('aud'), DUKE_BASE);
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(url.searchParams.get('scope'), DEFAULT_DUKE_SCOPE);
  assert.equal(url.searchParams.has('launch'), false);
});

test('authorization rejects wildcard/write scopes, short state and insecure nonloopback callbacks', () => {
  for (const scope of ['patient/*.read', 'patient/Observation.write', 'patient/Observation.cruds', 'system/*.read']) {
    assert.throws(() => authorizationRequest({ metadata, clientId: 'c', redirectUri, state, verifier, scope }), { code: 'UNSAFE_SCOPE' });
  }
  assert.throws(() => authorizationRequest({ metadata, clientId: 'c', redirectUri, state: 'short', verifier }), { code: 'INVALID_STATE' });
  assert.throws(() => authorizationRequest({ metadata, clientId: 'c', redirectUri: 'http://bridge.example/callback', state, verifier }), { code: 'INVALID_REDIRECT' });
});

test('code exchange authenticates using a signed, bounded private-key assertion', async () => {
  let captured;
  const token = await exchangeDukeCode({ ...codeArgs, privateKeyPem, keyId: 'key-1', fetch: async (url, options) => {
    captured = { url, options };
    return json(validToken({ refresh_token: 'refresh-secret', id_token: 'unverified-id-token' }));
  } });
  const body = captured.options.body;
  assert.equal(captured.url, metadata.token_endpoint);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code_verifier'), verifier);
  assert.equal(body.get('redirect_uri'), redirectUri);
  assert.equal(body.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  const [h, p, sig] = body.get('client_assertion').split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(header.alg, 'RS256'); assert.equal(header.kid, 'key-1');
  assert.equal(claims.aud, metadata.token_endpoint);
  assert.equal(claims.iss, 'client-1'); assert.equal(claims.sub, 'client-1');
  assert.equal(claims.exp - claims.iat, 300);
  assert.ok(claims.jti.length >= 22);
  assert.equal(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url')), true);
  assert.equal(token.refresh_token, 'refresh-secret');
  assert.equal('id_token' in token, false);
});

test('EC client authentication uses correct JOSE P1363 encoding', async () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  await exchangeDukeCode({ ...codeArgs, privateKeyPem: pem, keyId: 'ec-1', fetch: async (_url, options) => {
    const [h, p, sig] = options.body.get('client_assertion').split('.');
    assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'ES256');
    assert.equal(Buffer.from(sig, 'base64url').length, 64);
    assert.equal(verify('sha256', Buffer.from(`${h}.${p}`), { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), true);
    return json(validToken());
  } });
});

test('client-secret authentication selects advertised Basic, without placing secret in URL', async () => {
  await exchangeDukeCode({ ...codeArgs, clientSecret: 'private-secret', fetch: async (url, options) => {
    assert.equal(url.includes('private-secret'), false);
    assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('client-1:private-secret').toString('base64'));
    assert.equal(options.body.has('client_secret'), false);
    return json(validToken());
  } });
});

test('refresh requires a confidential credential and checks patient context when returned', async () => {
  await assert.rejects(refreshDukeToken({ metadata, clientId: 'c', refreshToken: 'r', fetch: async () => { throw new Error('should not fetch'); } }), { code: 'CONFIDENTIAL_CLIENT_REQUIRED' });
  await assert.rejects(refreshDukeToken({ metadata, clientId: 'c', clientSecret: 's', refreshToken: 'r', patientId: patient, fetch: async () => json(validToken({ patient: 'different-chart' })) }), { code: 'PATIENT_CONTEXT_CHANGED' });
});

test('refresh token omission is preserved instead of fabricating a new credential', async () => {
  const result = await refreshDukeToken({ metadata, clientId: 'c', clientSecret: 's', refreshToken: 'old-refresh', patientId: patient, fetch: async (_url, options) => {
    assert.equal(options.body.get('grant_type'), 'refresh_token');
    assert.equal(options.body.get('refresh_token'), 'old-refresh');
    return json(validToken({ patient: undefined }));
  } });
  assert.equal(result.refresh_token, undefined);
  assert.equal(result.patient, undefined);
});

test('expired/revoked grants yield sanitized reconnect errors', async () => {
  await assert.rejects(exchangeDukeCode({ ...codeArgs, fetch: async () => json({ error: 'invalid_grant', error_description: 'SECRET-DO-NOT-LOG token=private' }, 400) }), error => {
    assert.ok(error instanceof DukeConnectionError);
    assert.equal(error.code, 'RECONNECT_REQUIRED');
    assert.equal(error.reconnectRequired, true);
    assert.equal(error.message.includes('SECRET'), false);
    return true;
  });
});

test('code exchange rejects missing patient context, invalid expiry and write grants', async () => {
  for (const [change, code] of [[{ patient: undefined }, 'PATIENT_CONTEXT_MISSING'], [{ expires_in: -1 }, 'INVALID_TOKEN_RESPONSE'], [{ scope: 'patient/Observation.cruds' }, 'UNSAFE_SCOPE']]) {
    await assert.rejects(exchangeDukeCode({ ...codeArgs, fetch: async () => json(validToken(change)) }), { code });
  }
});

test('sync reads only the selected chart and preserves orders as orders', async () => {
  const order = resource('MedicationRequest', 'order-1', { authoredOn: '2026-10-01', status: 'active', medicationCodeableConcept: { text: 'Synthetic medication' } });
  const calls = [];
  const result = await syncDuke({ accessToken: 'access-secret', patientId: patient, resources: ['Patient', 'MedicationRequest'], fetch: async (url, options) => {
    calls.push({ url, options });
    return json(url.includes('/Patient/') ? { resourceType: 'Patient', id: patient } : bundle([order]));
  } });
  assert.equal(result.complete, true);
  assert.equal(result.watermark, result.startedAt);
  assert.ok(calls.every(x => x.options.method === undefined && x.options.redirect === 'error' && x.options.headers.Authorization === 'Bearer access-secret'));
  assert.equal(new URL(calls[1].url).searchParams.get('patient'), patient);
  const imported = result.resources.find(x => x.resourceType === 'MedicationRequest');
  assert.deepEqual(imported.raw, order);
  assert.equal(imported.kind, 'medication-order');
  assert.equal(imported.dateMeaning, 'order-authored');
  assert.equal(imported.clinicalDate, '2026-10-01');
  assert.equal(result.priorWatermarkUsedAsQueryFilter, false);
});

test('paginated reads bind each result, preserve source versions and finish only all pages', async () => {
  let n = 0;
  const result = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], fetch: async url => {
    n++;
    if (new URL(url).searchParams.get('category') === 'vital-signs') return json(bundle());
    return json(n === 1 ? bundle([resource('Observation', 'o1', { meta: { versionId: 'v1' } })], `${DUKE_BASE}/Observation?patient=${patient}&page=2`, 2) : bundle([resource('Observation', 'o2', { meta: { versionId: 'v2' } })], undefined, 2));
  } });
  assert.equal(result.complete, true);
  assert.equal(n, 3);
  assert.equal(result.coverage[0].pages, 3);
  assert.deepEqual(result.resources.map(x => x.versionId), ['v1', 'v2']);
});

test('Observation searches use both selected clinical categories and deduplicate overlapping records', async () => {
  const calls = [];
  const overlap = resource('Observation', 'shared-result', { meta: { versionId: '1' } });
  const result = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], fetch: async url => {
    const parsed = new URL(url);
    calls.push(parsed);
    assert.equal(parsed.pathname, new URL(`${DUKE_BASE}/Observation`).pathname);
    assert.equal(parsed.searchParams.get('patient'), patient);
    assert.equal(parsed.searchParams.get('_count'), '100');
    return json(bundle([overlap, resource('Observation', parsed.searchParams.get('category'))]));
  } });
  assert.deepEqual(calls.map(url => url.searchParams.get('category')), ['laboratory', 'vital-signs']);
  assert.equal(result.complete, true);
  assert.equal(result.resources.length, 3);
  assert.equal(result.resources.filter(item => item.id === 'shared-result').length, 1);
  assert.deepEqual(result.coverage[0].searches.map(search => search.status), ['ok', 'ok']);
  assert.equal(result.coverage[0].count, 3);
});

test('either Observation category can fail without advancing the watermark or dropping the successful category', async () => {
  const previousWatermark = '2026-10-01T00:00:00Z';
  for (const failedCategory of ['laboratory', 'vital-signs']) {
    const calls = [];
    const result = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], previousWatermark, fetch: async url => {
      const category = new URL(url).searchParams.get('category');
      calls.push(category);
      return category === failedCategory ? json({ error: 'insufficient_scope' }, 403) : json(bundle([resource('Observation', category)]));
    } });
    assert.deepEqual(calls, ['laboratory', 'vital-signs']);
    assert.equal(result.complete, false);
    assert.equal(result.watermark, previousWatermark);
    assert.equal(result.resources.length, 1);
    assert.notEqual(result.resources[0].id, failedCategory);
    assert.equal(result.errors[0].category, failedCategory);
    assert.equal(result.coverage[0].searches.find(search => search.category === failedCategory).status, 'denied');
  }
});

test('Observation category pagination cannot switch to an unrequested clinical category', async () => {
  const calls = [];
  const result = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], fetch: async url => {
    const category = new URL(url).searchParams.get('category');
    calls.push(category);
    return json(category === 'laboratory' ? bundle([resource('Observation', 'lab-1')], `${DUKE_BASE}/Observation?patient=${patient}&category=genomics`, 2) : bundle());
  } });
  assert.deepEqual(calls, ['laboratory', 'vital-signs']);
  assert.equal(result.complete, false);
  assert.equal(result.errors[0].code, 'QUERY_BINDING_FAILED');
  assert.equal(result.coverage[0].status, 'binding-error');
});

test('Condition and Procedure searches explicitly cover only both registered categories', async () => {
  const expected = { Condition: ['problem-list-item', 'encounter-diagnosis'], Procedure: ['103693007', '387713003'] };
  for (const [type, categories] of Object.entries(expected)) {
    const calls = [];
    const result = await syncDuke({ accessToken: 'a', patientId: patient, resources: [type], fetch: async url => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('patient'), patient);
      assert.equal(parsed.pathname, new URL(`${DUKE_BASE}/${type}`).pathname);
      const category = parsed.searchParams.get('category');
      calls.push(category);
      return json(bundle([resource(type, category)]));
    } });
    assert.deepEqual(calls, categories);
    assert.equal(result.complete, true);
    assert.deepEqual(result.resources.map(item => item.id), categories);
    assert.deepEqual(result.coverage[0].searches.map(search => search.category), categories);
  }
});

test('a missing diagnosis or surgery category page leaves coverage incomplete while retaining the other category', async () => {
  for (const [type, goodCategory] of [['Condition', 'problem-list-item'], ['Procedure', '103693007']]) {
    const result = await syncDuke({ accessToken: 'a', patientId: patient, resources: [type], previousWatermark: 'previous', fetch: async url => {
      const category = new URL(url).searchParams.get('category');
      return json(category === goodCategory ? bundle([resource(type, category)]) : bundle([resource(type, category)], undefined, 2));
    } });
    assert.equal(result.complete, false);
    assert.equal(result.watermark, 'previous');
    assert.equal(result.errors[0].code, 'MISSING_PAGE');
    assert.equal(result.coverage[0].searches[0].status, 'ok');
    assert.equal(result.coverage[0].searches[1].status, 'truncated');
    assert.equal(result.resources.some(item => item.id === goodCategory), true);
  }
});

test('partial read keeps the previous watermark, reports denial and retains safe data', async () => {
  const result = await syncDuke({ accessToken: 'a', patientId: patient, previousWatermark: '2026-09-01T00:00:00Z', resources: ['Condition', 'Observation'], fetch: async url => url.includes('/Condition?') ? json(bundle([resource('Condition')])) : json({ error: 'insufficient_scope' }, 403) });
  assert.equal(result.complete, false);
  assert.equal(result.watermark, '2026-09-01T00:00:00Z');
  assert.equal(result.resources.length, 1);
  assert.equal(result.coverage[1].status, 'denied');
});

test('cross-origin and authorization-path pagination never receives bearer credentials', async () => {
  for (const next of ['https://attacker.example/capture', 'https://health-apis.duke.edu/FHIR/oauth2/token']) {
    let n = 0;
    const result = await syncDuke({ accessToken: 'private-token', patientId: patient, resources: ['Observation'], fetch: async () => { n++; return json(bundle([resource('Observation')], next, 2)); } });
    assert.equal(result.complete, false);
    assert.equal(result.errors[0].code, 'UNTRUSTED_ENDPOINT');
    assert.equal(n, 2);
  }
});

test('a same-provider pagination link cannot change the selected patient', async () => {
  let n = 0;
  const result = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], fetch: async () => { n++; return json(bundle([resource('Observation')], `${DUKE_BASE}/Observation?patient=other-chart`, 2)); } });
  assert.equal(n, 2);
  assert.equal(result.coverage[0].status, 'binding-error');
  assert.equal(result.complete, false);
});

test('foreign or unbound resources cannot enter the imported record', async () => {
  for (const subject of [{ reference: 'Patient/other-chart' }, undefined]) {
    const result = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Condition'], fetch: async () => json(bundle([resource('Condition', 'c1', { subject })])) });
    assert.equal(result.resources.length, 0);
    assert.equal(result.coverage[0].status, 'binding-error');
  }
});

test('missing grants and unsupported resources are distinguished from empty results', async () => {
  const noFetch = async () => { throw new Error('must not fetch'); };
  const denied = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], grantedScopes: 'patient/Patient.read', fetch: noFetch });
  assert.equal(denied.coverage[0].status, 'denied');
  const unsupported = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], metadata: { resources: [] }, fetch: noFetch });
  assert.equal(unsupported.coverage[0].status, 'unsupported');
  const empty = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], fetch: async () => json(bundle()) });
  assert.equal(empty.coverage[0].status, 'empty');
  assert.equal(empty.complete, true);
});

test('MedicationAdministration needs opt-in, actual grant and declared provider capability', async () => {
  const options = { accessToken: 'a', patientId: patient, resources: ['MedicationAdministration'], fetch: async () => { throw new Error('must not fetch'); } };
  const disabled = await syncDuke(options);
  assert.equal(disabled.errors[0].code, 'EXTENDED_CAPABILITY_REQUIRED');
  const enabled = await syncDuke({ ...options, enableMedicationAdministration: true, grantedScopes: 'patient/MedicationAdministration.read', metadata: { resources: [{ type: 'MedicationAdministration', interactions: ['read', 'search-type'] }] }, fetch: async () => json(bundle([resource('MedicationAdministration', 'admin-1', { effectiveDateTime: '2026-10-20T12:00:00Z', status: 'completed' })])) });
  assert.equal(enabled.complete, true);
  assert.equal(enabled.resources[0].kind, 'medication-administration');
  assert.equal(enabled.resources[0].clinicalDate, '2026-10-20T12:00:00Z');
});

test('unsupported resource types and dot path identifiers are rejected before network access', async () => {
  for (const resourceType of ['MedicationStatement', 'Patient/$everything', '../Patient']) await assert.rejects(syncDuke({ accessToken: 'a', patientId: patient, resources: [resourceType] }), { code: 'UNSUPPORTED_RESOURCE' });
  for (const badPatient of ['.', '..', 'chart/other', 'chart?name=x']) await assert.rejects(syncDuke({ accessToken: 'a', patientId: badPatient }), { code: 'INVALID_PATIENT' });
});

test('cyclic and unreturned pagination remain incomplete', async () => {
  const repeated = `${DUKE_BASE}/Observation?patient=${patient}&_count=100`;
  const loop = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], fetch: async () => json(bundle([resource('Observation')], repeated, 2)) });
  assert.equal(loop.errors[0].code, 'PAGINATION_LOOP');
  const missing = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], fetch: async () => json(bundle([resource('Observation')], undefined, 2)) });
  assert.equal(missing.errors[0].code, 'MISSING_PAGE');
  assert.equal(missing.coverage[0].status, 'truncated');
});

test('response size and total page count are bounded', async () => {
  const oversized = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], fetch: async () => json(bundle(), 200, { 'content-length': String(9 * 1024 * 1024) }) });
  assert.equal(oversized.errors[0].code, 'RESPONSE_TOO_LARGE');
  let page = 0;
  const bounded = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], fetch: async () => { page++; return json(bundle([resource('Observation', `o-${page}`)], `${DUKE_BASE}/Observation?patient=${patient}&page=${page + 1}`, 100)); } });
  assert.equal(page, 32);
  assert.equal(bounded.errors[0].code, 'PAGE_LIMIT');
  assert.equal(bounded.complete, false);
  assert.equal(bounded.watermark, null);
});

test('FHIR errors and network exceptions expose no raw provider diagnostics', async () => {
  const result = await syncDuke({ accessToken: 'DO-NOT-LOG', patientId: patient, resources: ['Observation'], fetch: async () => json(bundle([{ resourceType: 'OperationOutcome', issue: [{ severity: 'error', diagnostics: 'DO-NOT-LOG sensitive content' }] }])) });
  assert.equal(result.errors[0].code, 'FHIR_OPERATION_FAILED');
  assert.equal(JSON.stringify(result.errors).includes('DO-NOT-LOG'), false);
  const failed = await syncDuke({ accessToken: 'DO-NOT-LOG', patientId: patient, resources: ['Observation'], fetch: async () => { throw new Error('DO-NOT-LOG'); } });
  assert.equal(failed.errors[0].code, 'PROVIDER_UNREACHABLE');
  assert.equal(JSON.stringify(failed).includes('DO-NOT-LOG'), false);
});

test('document indexing date is not called the examination date and intentionally unfetched bodies remain explicit', async () => {
  const result = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['DocumentReference'], includeDocumentBodies: false, fetch: async () => json(bundle([resource('DocumentReference', 'note-1', { date: '2026-10-01T10:00:00Z', content: [{ attachment: { contentType: 'text/plain', url: 'https://other.example/note' } }] })])) });
  assert.equal(result.resources[0].dateMeaning, 'document-indexed');
  assert.equal(result.documentAttachments[0].status, 'not-fetched');
  assert.ok(result.completenessScope.includes('Unfetched document bodies'));
});

const notesMetadata = { resources: [{ type: 'DocumentReference', interactions: ['read', 'search-type'] }, { type: 'Binary', interactions: ['read'] }] };
const notesOptions = { accessToken: 'private-access', patientId: patient, resources: ['DocumentReference'], grantedScopes: 'patient/DocumentReference.read patient/Binary.read', metadata: notesMetadata };
const note = (url = `${DUKE_BASE}/Binary/body-1`, extras = {}) => resource('DocumentReference', 'note-1', { context: { period: { start: '2026-10-20' } }, content: [{ attachment: { contentType: 'text/plain', url } }], ...extras });
const binary = extras => ({ resourceType: 'Binary', id: 'body-1', contentType: 'text/plain', data: Buffer.from('Synthetic oncology note.').toString('base64'), ...extras });

test('referenced patient-bound note body is imported with original Binary content and provenance', async () => {
  let calls = 0;
  const result = await syncDuke({ ...notesOptions, fetch: async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, 'Bearer private-access');
    return json(url.includes('/DocumentReference?') ? bundle([note()]) : binary({ securityContext: { reference: 'DocumentReference/note-1' } }));
  } });
  assert.equal(calls, 2);
  assert.equal(result.complete, true);
  const body = result.resources.find(x => x.resourceType === 'Binary');
  assert.equal(body.kind, 'clinical-document-body');
  assert.equal(body.parentDocumentId, 'note-1');
  assert.deepEqual(body.documentIds, ['note-1']);
  assert.equal(body.clinicalDate, '2026-10-20');
  assert.equal(body.dateMeaning, 'document-clinical-period-start');
  assert.deepEqual(body.raw, binary({ securityContext: { reference: 'DocumentReference/note-1' } }));
  assert.equal(result.documentAttachments[0].status, 'fetched');
  assert.equal(result.coverage[1].resourceType, 'Binary');
  assert.equal(result.coverage[1].status, 'ok');
});

test('missing Binary grant leaves structured references but makes note sync incomplete', async () => {
  let calls = 0;
  const result = await syncDuke({ ...notesOptions, grantedScopes: 'patient/DocumentReference.read', previousWatermark: 'old-watermark', fetch: async () => { calls++; return json(bundle([note()])); } });
  assert.equal(calls, 1);
  assert.equal(result.resources.length, 1);
  assert.equal(result.coverage[0].status, 'ok');
  assert.equal(result.coverage[1].status, 'denied');
  assert.equal(result.documentAttachments[0].status, 'not-fetched');
  assert.equal(result.complete, false);
  assert.equal(result.watermark, 'old-watermark');
});

test('undeclared Binary read capability and missing body URLs are explicit incomplete outcomes', async () => {
  const unsupported = await syncDuke({ ...notesOptions, metadata: { resources: notesMetadata.resources.slice(0,1) }, fetch: async () => json(bundle([note()])) });
  assert.equal(unsupported.coverage[1].status, 'unsupported');
  const absent = await syncDuke({ ...notesOptions, fetch: async () => json(bundle([note(undefined, { content: [{ attachment: { title: 'Missing body' } }] })])) });
  assert.equal(absent.documentAttachments[0].status, 'unavailable');
  assert.equal(absent.errors[0].code, 'DOCUMENT_BODY_MISSING');
});

test('external, OAuth, query-token and encoded-path attachments are never fetched', async () => {
  for (const url of ['https://other.example/Binary/body-1', 'https://health-apis.duke.edu/FHIR/oauth2/token', `${DUKE_BASE}/Binary/body-1?token=secret`, `${DUKE_BASE}/Binary/%252e%252e%252ftoken`]) {
    let calls = 0;
    const result = await syncDuke({ ...notesOptions, fetch: async () => { calls++; return json(bundle([note(url)])); } });
    assert.equal(calls, 1);
    assert.equal(result.documentAttachments[0].status, 'not-fetched');
    assert.equal(result.complete, false);
  }
});

test('duplicate referenced Binary bodies are fetched once and retain both document links', async () => {
  let calls = 0;
  const result = await syncDuke({ ...notesOptions, fetch: async url => {
    calls++;
    return json(url.includes('/DocumentReference?') ? bundle([note(), note(undefined, { id: 'note-2' })]) : binary());
  } });
  assert.equal(calls, 2);
  assert.equal(result.resources.length, 3);
  assert.deepEqual(result.resources.find(x => x.resourceType === 'Binary').documentIds, ['note-1', 'note-2']);
});

test('bounded plain-text and PDF response bytes are preserved without interpretation', async () => {
  for (const [contentType, bytes] of [['text/plain', Buffer.from('A synthetic source note.')], ['application/pdf', Buffer.from('%PDF-1.4\nsynthetic fixture\n')]]) {
    const result = await syncDuke({ ...notesOptions, fetch: async url => url.includes('/DocumentReference?') ? json(bundle([note()])) : new Response(bytes, { headers: { 'Content-Type': contentType } }) });
    assert.equal(result.complete, true);
    const imported = result.resources.find(x => x.kind === 'clinical-document-body');
    assert.equal(imported.representation, 'raw-body');
    assert.equal(imported.contentType, contentType);
    assert.deepEqual(Buffer.from(imported.raw.data, 'base64'), bytes);
  }
});

test('wrong Binary ID or patient securityContext cannot bind to a valid document', async () => {
  for (const body of [binary({ id: 'wrong-body' }), binary({ securityContext: { reference: 'Patient/different-chart' } })]) {
    const result = await syncDuke({ ...notesOptions, fetch: async url => json(url.includes('/DocumentReference?') ? bundle([note()]) : body) });
    assert.equal(result.resources.length, 1);
    assert.equal(result.complete, false);
    assert.equal(result.documentAttachments[0].status, 'unavailable');
  }
});

test('oversized or invalid encoded Binary bodies remain unavailable without a watermark advance', async () => {
  for (const response of [() => new Response('x', { headers: { 'Content-Type': 'application/pdf', 'content-length': String(6 * 1024 * 1024) } }), () => json(binary({ data: 'not!base64' }))]) {
    const result = await syncDuke({ ...notesOptions, previousWatermark: 'old', fetch: async url => url.includes('/DocumentReference?') ? json(bundle([note()])) : response() });
    assert.equal(result.complete, false);
    assert.equal(result.watermark, 'old');
    assert.equal(result.documentAttachments[0].status, 'unavailable');
  }
});

test('inline patient-document attachments need no separate Binary request or grant', async () => {
  const data = Buffer.from('Inline clinical note.').toString('base64');
  let calls = 0;
  const result = await syncDuke({ ...notesOptions, grantedScopes: 'patient/DocumentReference.read', metadata: { resources: notesMetadata.resources.slice(0,1) }, fetch: async () => { calls++; return json(bundle([note(undefined, { content: [{ attachment: { contentType: 'text/plain', data } }] })])); } });
  assert.equal(calls, 1);
  assert.equal(result.complete, true);
  assert.equal(result.documentAttachments[0].status, 'inline');
  assert.equal(result.resources[1].representation, 'inline-attachment');
  assert.equal(result.resources[1].raw.data, data);
  assert.equal(JSON.stringify(result.documentAttachments).includes(data), false);
});

test('SMARTv2 read-only grants do not implicitly permit resource searching', async () => {
  const result = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], grantedScopes: 'patient/Observation.r', fetch: async () => { throw new Error('must not fetch'); } });
  assert.equal(result.coverage[0].status, 'denied');
  const success = await syncDuke({ accessToken: 'a', patientId: patient, resources: ['Observation'], grantedScopes: 'patient/Observation.rs', fetch: async () => json(bundle()) });
  assert.equal(success.complete, true);
});
