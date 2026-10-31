import { createHash, createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';

export const DUKE_BASE = 'https://health-apis.duke.edu/FHIR/api/FHIR/R4';
const DUKE_ORIGIN = new URL(DUKE_BASE).origin;
export const DEFAULT_DUKE_RESOURCES = Object.freeze([
  'Patient', 'Condition', 'Observation', 'MedicationRequest', 'AllergyIntolerance',
  'Procedure', 'DiagnosticReport', 'DocumentReference',
]);
const ALLOWED_RESOURCES = new Set([...DEFAULT_DUKE_RESOURCES, 'MedicationAdministration']);
export const DEFAULT_DUKE_SCOPE = [
  'launch/patient', 'offline_access', 'openid', 'fhirUser',
  ...DEFAULT_DUKE_RESOURCES.map(type => `patient/${type}.read`),
  'patient/Binary.read',
].join(' ');
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PAGES_PER_RESOURCE = 32;
const MAX_TOTAL_PAGES = 128;
const MAX_RECORDS = 10_000;
const MAX_DOCUMENT_BODIES = 64;
const MAX_BINARY_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const ID = /^[A-Za-z0-9.-]{1,64}$/;
const SECRET = /^[^\r\n\0]{1,16384}$/;

export class DukeConnectionError extends Error {
  constructor(code, message, { status, reconnectRequired = false } = {}) {
    super(message);
    this.name = 'DukeConnectionError';
    this.code = code;
    if (status !== undefined) this.status = status;
    this.reconnectRequired = reconnectRequired;
  }
}
function fail(code, message, extra) { throw new DukeConnectionError(code, message, extra); }
function required(value, name, max = 2048) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\r\n\0]/.test(value)) {
    fail('INVALID_INPUT', `A valid ${name} is required.`);
  }
  return value;
}
function patientId(value) {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') fail('INVALID_PATIENT', 'A valid FHIR patient identifier is required.');
  return value;
}
function pinnedUrl(value, kind = 'fhir') {
  let url;
  try { url = new URL(value); } catch { fail('UNTRUSTED_ENDPOINT', 'The provider endpoint is invalid.'); }
  if (url.origin !== DUKE_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.hash) {
    fail('UNTRUSTED_ENDPOINT', 'Only the verified Duke provider origin is permitted.');
  }
  if (/%|\\/.test(url.pathname)) fail('UNTRUSTED_ENDPOINT', 'Encoded path separators are not permitted in provider endpoints.');
  const basePath = new URL(DUKE_BASE).pathname;
  if (kind === 'fhir' && !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))) {
    fail('UNTRUSTED_ENDPOINT', 'The endpoint is outside the verified Duke FHIR base.');
  }
  if (kind === 'authorize' || kind === 'token') {
    const suffix = kind === 'authorize' ? '/oauth2/authorize' : '/oauth2/token';
    if (!url.pathname.startsWith('/FHIR/') || !url.pathname.endsWith(suffix) || url.search) {
      fail('UNTRUSTED_ENDPOINT', 'The OAuth endpoint is outside the verified Duke authorization service.');
    }
  }
  return url;
}
function scopes(value = '') {
  const list = Array.isArray(value) ? value : String(value).trim().split(/\s+/).filter(Boolean);
  return [...new Set(list)];
}
function readOnlyScopes(value) {
  const list = scopes(value);
  const identity = new Set(['openid', 'profile', 'fhirUser', 'offline_access', 'online_access', 'launch/patient']);
  if (!list.length || list.some(scope => typeof scope !== 'string' || (!identity.has(scope) && !/^patient\/[A-Za-z][A-Za-z0-9]*\.(?:read|r|rs)$/i.test(scope)))) {
    fail('UNSAFE_SCOPE', 'Only explicit patient read/search and necessary identity scopes are permitted.');
  }
  return list.join(' ');
}
function canRead(scopeList, resourceType, search = false) {
  return scopeList.some(scope => {
    const match = /^patient\/(\*|[A-Za-z][A-Za-z0-9]*)\.(read|r|rs)$/i.exec(scope);
    return match && (match[1] === '*' || match[1] === resourceType) && (match[2].toLowerCase() === 'read' || (search ? match[2].toLowerCase().includes('s') : match[2].toLowerCase().includes('r')));
  });
}
async function boundedBytes(response, maxBytes = MAX_RESPONSE_BYTES) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > maxBytes) fail('RESPONSE_TOO_LARGE', 'The provider response exceeded the import limit.');
  let output;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const parts = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          fail('RESPONSE_TOO_LARGE', 'The provider response exceeded the import limit.');
        }
        parts.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    output = Buffer.concat(parts);
  } else if (typeof response.arrayBuffer === 'function') {
    output = Buffer.from(await response.arrayBuffer());
  } else if (typeof response.text === 'function') {
    output = Buffer.from(await response.text());
  } else output = Buffer.from(JSON.stringify(await response.json()));
  if (output.length > maxBytes) fail('RESPONSE_TOO_LARGE', 'The provider response exceeded the import limit.');
  return output;
}
async function boundedJson(response) {
  const bytes = await boundedBytes(response);
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_PROVIDER_JSON', 'The provider returned an invalid JSON response.'); }
}
async function requestResponse(url, { fetch: fetchImpl = globalThis.fetch, ...options } = {}) {
  if (typeof fetchImpl !== 'function') fail('FETCH_UNAVAILABLE', 'A fetch implementation is required.');
  let response;
  try {
    response = await fetchImpl(String(url), { ...options, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    fail('PROVIDER_UNREACHABLE', 'The Duke provider request failed or timed out.');
  }
  if (!response || !Number.isFinite(response.status)) fail('INVALID_PROVIDER_RESPONSE', 'The provider response is invalid.');
  if (response.status >= 300 && response.status < 400) fail('PROVIDER_REDIRECT', 'Provider redirects are not followed.');
  if (response.url && new URL(response.url).href !== new URL(url).href) fail('PROVIDER_REDIRECT', 'An unexpected provider response location was rejected.');
  if (!response.ok) {
    let oauthError;
    try {
      const body = await boundedJson(response);
      if (typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error)) oauthError = body.error;
    } catch { /* Error bodies can be non-JSON; never expose provider diagnostics. */ }
    const reconnectRequired = response.status === 401 || oauthError === 'invalid_grant';
    fail(oauthError === 'invalid_grant' ? 'RECONNECT_REQUIRED' : `PROVIDER_HTTP_${response.status}`, 'The Duke provider rejected the request.', { status: response.status, reconnectRequired });
  }
  return response;
}
async function requestJson(url, options) { return boundedJson(await requestResponse(url, options)); }

export async function discoverDuke({ clientId, fetch: fetchImpl = globalThis.fetch } = {}) {
  const headers = { Accept: 'application/fhir+json, application/json' };
  if (clientId !== undefined) headers['Epic-Client-ID'] = required(clientId, 'client ID', 512);
  const [smart, capability] = await Promise.all([
    requestJson(`${DUKE_BASE}/.well-known/smart-configuration`, { fetch: fetchImpl, headers }),
    requestJson(`${DUKE_BASE}/metadata`, { fetch: fetchImpl, headers }),
  ]);
  pinnedUrl(smart.authorization_endpoint, 'authorize');
  pinnedUrl(smart.token_endpoint, 'token');
  if (capability.resourceType !== 'CapabilityStatement' || capability.fhirVersion !== '4.0.1') {
    fail('UNSUPPORTED_PROVIDER', 'The provider did not return the expected R4 capability statement.');
  }
  const resources = (capability.rest ?? []).filter(r => r.mode === 'server').flatMap(rest => rest.resource ?? []).map(resource => ({
    type: resource.type,
    interactions: (resource.interaction ?? []).map(x => x.code),
    searchParams: (resource.searchParam ?? []).map(x => x.name),
  }));
  return {
    ...smart,
    fhirBase: DUKE_BASE,
    fhirVersion: capability.fhirVersion,
    resources,
    retrievedAt: new Date().toISOString(),
    resourceScopeListExhaustive: false,
  };
}

export function authorizationRequest({ metadata, clientId, redirectUri, state, verifier, scope = DEFAULT_DUKE_SCOPE } = {}) {
  required(clientId, 'client ID', 512);
  required(state, 'OAuth state', 1024);
  if (state.length < 22) fail('INVALID_STATE', 'OAuth state must contain at least 22 unpredictable characters.');
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) fail('INVALID_PKCE', 'A valid PKCE verifier is required.');
  let redirect;
  try { redirect = new URL(redirectUri); } catch { fail('INVALID_REDIRECT', 'A valid registered redirect URI is required.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
  if ((!loopback && redirect.protocol !== 'https:') || (loopback && !['http:', 'https:'].includes(redirect.protocol)) || redirect.username || redirect.password || redirect.hash) {
    fail('INVALID_REDIRECT', 'The redirect URI must use HTTPS or a development loopback address.');
  }
  if (metadata?.fhirBase && metadata.fhirBase !== DUKE_BASE) fail('UNTRUSTED_ENDPOINT', 'The provider FHIR base is not Duke.');
  if (!metadata?.code_challenge_methods_supported?.includes('S256')) fail('PKCE_UNSUPPORTED', 'The provider did not advertise S256 PKCE.');
  const url = pinnedUrl(metadata.authorization_endpoint, 'authorize');
  const approvedScope = readOnlyScopes(scope);
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirect.href, state, code_challenge: codeChallenge, code_challenge_method: 'S256', scope: approvedScope, aud: DUKE_BASE })) url.searchParams.set(key, value);
  return { url: url.href, scope: approvedScope, codeChallenge };
}

function clientAuthentication({ metadata, clientId, privateKeyPem, keyId, clientSecret, refresh = false }) {
  const methods = metadata.token_endpoint_auth_methods_supported ?? [];
  if (privateKeyPem && clientSecret) fail('AMBIGUOUS_CREDENTIAL', 'Configure one OAuth client authentication method.');
  const body = { client_id: clientId };
  const headers = {};
  if (privateKeyPem) {
    if (!methods.includes('private_key_jwt')) fail('AUTH_METHOD_UNSUPPORTED', 'The provider does not advertise private-key client authentication.');
    required(keyId, 'signing key identifier', 512);
    let key;
    try { key = createPrivateKey(privateKeyPem); } catch { fail('INVALID_SIGNING_KEY', 'The OAuth signing key could not be loaded.'); }
    const curve = key.asymmetricKeyDetails?.namedCurve;
    const algorithm = key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails?.modulusLength >= 2048 ? 'RS256' : key.asymmetricKeyType === 'ec' && curve === 'prime256v1' ? 'ES256' : key.asymmetricKeyType === 'ec' && curve === 'secp384r1' ? 'ES384' : null;
    if (!algorithm) fail('INVALID_SIGNING_KEY', 'Use an RSA key of at least 2048 bits or a supported P-256/P-384 key.');
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: 'JWT', kid: keyId })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: clientId, sub: clientId, aud: metadata.token_endpoint, iat: now, nbf: now, exp: now + 300, jti: randomBytes(24).toString('base64url') })).toString('base64url');
    let signature;
    try { signature = cryptoSign(algorithm === 'ES384' ? 'sha384' : 'sha256', Buffer.from(`${header}.${claims}`), { key, ...(key.asymmetricKeyType === 'ec' ? { dsaEncoding: 'ieee-p1363' } : {}) }).toString('base64url'); } catch { fail('INVALID_SIGNING_KEY', 'The OAuth signing key could not be used.'); }
    body.client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
    body.client_assertion = `${header}.${claims}.${signature}`;
  } else if (clientSecret) {
    if (typeof clientSecret !== 'string' || !SECRET.test(clientSecret)) fail('INVALID_CREDENTIAL', 'A valid OAuth client credential is required.');
    if (methods.includes('client_secret_basic')) {
      headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
    } else if (methods.includes('client_secret_post')) body.client_secret = clientSecret;
    else fail('AUTH_METHOD_UNSUPPORTED', 'The provider does not advertise secret-based client authentication.');
  } else if (refresh) fail('CONFIDENTIAL_CLIENT_REQUIRED', 'Persistent access requires a configured confidential OAuth client credential.');
  else if (!methods.includes('none') && !metadata.capabilities?.includes('client-public')) fail('CONFIDENTIAL_CLIENT_REQUIRED', 'This provider requires an OAuth client credential.');
  return { body, headers };
}
function validateToken(body, { requirePatient = false, expectedPatient } = {}) {
  if (!body || typeof body !== 'object' || typeof body.access_token !== 'string' || !SECRET.test(body.access_token) || String(body.token_type).toLowerCase() !== 'bearer') fail('INVALID_TOKEN_RESPONSE', 'The provider did not return a valid bearer token.');
  const expires = Number(body.expires_in);
  if (!Number.isSafeInteger(expires) || expires <= 0 || expires > 31_536_000) fail('INVALID_TOKEN_RESPONSE', 'The provider returned an invalid token lifetime.');
  if (requirePatient && !body.patient) fail('PATIENT_CONTEXT_MISSING', 'The provider did not identify the patient chart selected during authorization.');
  if (body.patient) patientId(body.patient);
  if (expectedPatient && body.patient && body.patient !== expectedPatient) fail('PATIENT_CONTEXT_CHANGED', 'The refreshed token identifies a different patient chart.');
  const grantedScope = typeof body.scope === 'string' ? body.scope.trim() : '';
  if (grantedScope && scopes(grantedScope).some(x => {
    const match = /^(?:patient|user|system)\/[^.]+\.(.+)$/i.exec(x);
    if (!match || /^(read|r|rs)$/i.test(match[1])) return false;
    return match[1] === '*' || /^write$/i.test(match[1]) || /[cud]/i.test(match[1]);
  })) fail('UNSAFE_SCOPE', 'The provider returned unexpected write permissions.');
  const token = { access_token: body.access_token, token_type: 'Bearer', expires_in: expires, scope: grantedScope };
  if (body.patient) token.patient = body.patient;
  if (body.refresh_token !== undefined) {
    if (typeof body.refresh_token !== 'string' || !SECRET.test(body.refresh_token)) fail('INVALID_TOKEN_RESPONSE', 'The provider returned an invalid refresh token.');
    token.refresh_token = body.refresh_token;
  }
  // ID tokens are intentionally not returned or treated as verified identities.
  return token;
}
async function tokenRequest(args, grant) {
  const { clientId, fetch: fetchImpl = globalThis.fetch } = args;
  required(clientId, 'client ID', 512);
  const metadata = args.metadata ?? await discoverDuke({ clientId, fetch: fetchImpl });
  pinnedUrl(metadata.token_endpoint, 'token');
  const auth = clientAuthentication({ ...args, metadata, refresh: grant === 'refresh_token' });
  const body = new URLSearchParams({ ...auth.body, grant_type: grant });
  if (grant === 'authorization_code') {
    required(args.code, 'authorization code', 4096);
    if (typeof args.verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(args.verifier)) fail('INVALID_PKCE', 'A valid PKCE verifier is required.');
    required(args.redirectUri, 'registered redirect URI');
    body.set('code', args.code); body.set('code_verifier', args.verifier); body.set('redirect_uri', args.redirectUri);
  } else body.set('refresh_token', required(args.refreshToken, 'refresh token', 16384));
  const result = await requestJson(metadata.token_endpoint, { fetch: fetchImpl, method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', ...auth.headers }, body });
  return validateToken(result, { requirePatient: grant === 'authorization_code', expectedPatient: args.patientId });
}
export async function exchangeDukeCode(args = {}) { return tokenRequest(args, 'authorization_code'); }
export async function refreshDukeToken(args = {}) { return tokenRequest(args, 'refresh_token'); }

function belongsToPatient(resource, id) {
  if (resource.resourceType === 'Patient') return resource.id === id;
  const reference = resource.subject?.reference ?? resource.patient?.reference;
  if (typeof reference !== 'string') return false;
  const relative = reference.replace(`${DUKE_BASE}/`, '');
  return relative === `Patient/${id}` || relative.startsWith(`Patient/${id}/_history/`);
}
function normalized(resource) {
  const type = resource.resourceType;
  let kind = 'clinical-resource', clinicalDate = null, dateMeaning = null;
  const firstDate = (...pairs) => pairs.find(([, value]) => typeof value === 'string' && value.length) ?? [null, null];
  if (type === 'MedicationRequest') {
    kind = 'medication-order'; [dateMeaning, clinicalDate] = firstDate(['order-authored', resource.authoredOn]);
  } else if (type === 'MedicationAdministration') {
    kind = 'medication-administration'; [dateMeaning, clinicalDate] = firstDate(['administration-effective', resource.effectiveDateTime], ['administration-period-start', resource.effectivePeriod?.start]);
  } else if (type === 'DocumentReference') {
    kind = 'clinical-document-reference'; [dateMeaning, clinicalDate] = firstDate(['document-clinical-period-start', resource.context?.period?.start], ['document-indexed', resource.date]);
  } else if (type === 'Observation' || type === 'DiagnosticReport') {
    kind = type === 'Observation' ? 'clinical-observation' : 'diagnostic-report'; [dateMeaning, clinicalDate] = firstDate(['effective', resource.effectiveDateTime], ['effective-period-start', resource.effectivePeriod?.start], ['issued', resource.issued]);
  } else if (type === 'Procedure') [dateMeaning, clinicalDate] = firstDate(['performed', resource.performedDateTime], ['performed-period-start', resource.performedPeriod?.start]);
  else if (type === 'Condition') [dateMeaning, clinicalDate] = firstDate(['onset', resource.onsetDateTime], ['recorded', resource.recordedDate]);
  else if (type === 'AllergyIntolerance') [dateMeaning, clinicalDate] = firstDate(['recorded', resource.recordedDate]);
  return { kind, clinicalDate, dateMeaning, status: resource.status ?? resource.clinicalStatus ?? null };
}
function coverageStatus(error) {
  if (error.status === 403 || error.status === 401) return 'denied';
  if (error.status === 404 || error.status === 405) return 'unsupported';
  if (error.code === 'PATIENT_BINDING_FAILED' || error.code === 'QUERY_BINDING_FAILED') return 'binding-error';
  if (['PAGE_LIMIT', 'RECORD_LIMIT', 'RESPONSE_TOO_LARGE', 'MISSING_PAGE', 'IMPORT_BYTE_LIMIT', 'DOCUMENT_BODY_LIMIT'].includes(error.code)) return 'truncated';
  return 'error';
}
function supported(metadata, type) {
  const resources = metadata?.resources;
  if (!Array.isArray(resources)) return undefined;
  return resources.some(x => x.type === type && (x.interactions ?? []).includes(type === 'Patient' || type === 'Binary' ? 'read' : 'search-type'));
}
function searchPlans(type) {
  // Match only the registered R4 API variants. Observation requires category
  // or code; Condition and Procedure do not document category-omitted dispatch.
  const categories = {
    Observation: ['laboratory', 'vital-signs'],
    Condition: ['problem-list-item', 'encounter-diagnosis'],
    Procedure: ['103693007', '387713003'],
  };
  return categories[type]?.map(category => ({ category })) ?? [{}];
}
function decodeBodyData(data) {
  if (typeof data !== 'string' || data.length > MAX_RESPONSE_BYTES || !/^[A-Za-z0-9+/\s]*={0,2}$/.test(data)) fail('INVALID_DOCUMENT_BODY', 'The provider returned invalid document-body encoding.');
  const normalized = data.replace(/\s/g, '');
  if (!normalized || normalized.length % 4 === 1) fail('INVALID_DOCUMENT_BODY', 'The provider returned an empty or invalid document body.');
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) fail('INVALID_DOCUMENT_BODY', 'The provider returned invalid document-body encoding.');
  if (bytes.length > MAX_BINARY_BYTES) fail('RESPONSE_TOO_LARGE', 'The document body exceeded the import limit.');
  return bytes;
}
function binaryAttachmentUrl(value) {
  if (typeof value !== 'string') fail('UNTRUSTED_ENDPOINT', 'The document body URL is invalid.');
  let url;
  try { url = new URL(value, `${DUKE_BASE}/`); } catch { fail('UNTRUSTED_ENDPOINT', 'The document body URL is invalid.'); }
  pinnedUrl(url.href);
  const prefix = `${new URL(DUKE_BASE).pathname}/Binary/`;
  if (!url.pathname.startsWith(prefix) || url.search) fail('UNTRUSTED_ENDPOINT', 'Only a referenced Duke FHIR Binary resource can be fetched.');
  const parts = url.pathname.slice(prefix.length).split('/');
  if (!ID.test(parts[0]) || parts[0] === '.' || parts[0] === '..' || !(parts.length === 1 || (parts.length === 3 && parts[1] === '_history' && ID.test(parts[2])))) fail('UNTRUSTED_ENDPOINT', 'The document body URL does not identify a supported Binary resource.');
  return { url: url.href, id: parts[0] };
}
async function retrieveDocumentBody({ url, id, documentId, selectedPatient, accessToken, fetch: fetchImpl }) {
  const response = await requestResponse(url, { fetch: fetchImpl, headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/fhir+json, application/json' } });
  const contentType = response.headers?.get?.('content-type')?.split(';')[0]?.trim()?.toLowerCase() ?? '';
  if (contentType.includes('json')) {
    const raw = await boundedJson(response);
    if (raw.resourceType !== 'Binary' || raw.id !== id) fail('INVALID_DOCUMENT_BODY', 'The provider returned an unexpected document-body resource.');
    const context = raw.securityContext?.reference;
    if (typeof context === 'string') {
      if (/^https?:\/\//.test(context)) pinnedUrl(context);
      const relative = context.replace(`${DUKE_BASE}/`, '');
      const matches = expected => relative === expected || relative.startsWith(`${expected}/_history/`);
      if ((relative.startsWith('Patient/') && !matches(`Patient/${selectedPatient}`)) || (relative.startsWith('DocumentReference/') && !matches(`DocumentReference/${documentId}`))) fail('PATIENT_BINDING_FAILED', 'The document body identifies a different patient or document.');
    }
    const bytes = decodeBodyData(raw.data);
    return { raw, contentType: raw.contentType ?? 'application/octet-stream', byteLength: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), representation: 'FHIR-Binary', versionId: raw.meta?.versionId ?? null };
  }
  const bytes = await boundedBytes(response, MAX_BINARY_BYTES);
  if (!bytes.length) fail('INVALID_DOCUMENT_BODY', 'The provider returned an empty document body.');
  // Preserve bounded source bytes without executing text or processing PDFs.
  return { raw: { contentType: contentType || 'application/octet-stream', data: bytes.toString('base64') }, contentType: contentType || 'application/octet-stream', byteLength: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), representation: 'raw-body', versionId: null };
}
export async function syncDuke({ accessToken, patientId: selectedPatient, previousWatermark = null, resources: requested = DEFAULT_DUKE_RESOURCES, fetch: fetchImpl = globalThis.fetch, grantedScopes, metadata, enableMedicationAdministration = false, includeDocumentBodies = true } = {}) {
  patientId(selectedPatient);
  required(accessToken, 'access token', 16384);
  if (!Array.isArray(requested) || requested.length > ALLOWED_RESOURCES.size || requested.some(x => !ALLOWED_RESOURCES.has(x))) fail('UNSUPPORTED_RESOURCE', 'Only the supported read-only patient resource types may be synchronized.');
  const resourceTypes = [...new Set(requested)];
  const scopeList = grantedScopes === undefined ? null : scopes(grantedScopes);
  const startedAt = new Date().toISOString(), results = [], coverage = [], errors = [], attachments = [];
  const seenRecords = new Set();
  let totalPages = 0, importedBytes = 0;
  for (const type of resourceTypes) {
    const report = { resourceType: type, status: 'pending', count: 0, pages: 0 };
    coverage.push(report);
    try {
      if (type === 'MedicationAdministration' && (!enableMedicationAdministration || !scopeList || !canRead(scopeList, type, true) || supported(metadata, type) !== true)) {
        fail('EXTENDED_CAPABILITY_REQUIRED', 'Medication administration requires explicit enablement, a granted read scope, and a declared provider capability.');
      }
      if (supported(metadata, type) === false) fail('RESOURCE_NOT_DECLARED', 'The provider did not declare this requested resource capability.', { status: 404 });
      if (scopeList && !canRead(scopeList, type, type !== 'Patient')) fail('SCOPE_NOT_GRANTED', 'The provider did not grant this requested patient read/search scope.', { status: 403 });
      let firstFailure;
      const plans = searchPlans(type);
      if (plans.length > 1) report.searches = [];
      for (const filters of plans) {
        const search = { ...filters, status: 'pending', count: 0, pages: 0 };
        if (report.searches) report.searches.push(search);
        try {
          let next = new URL(type === 'Patient' ? `${DUKE_BASE}/Patient/${selectedPatient}` : `${DUKE_BASE}/${type}`);
          if (type !== 'Patient') { next.searchParams.set('patient', selectedPatient); next.searchParams.set('_count', '100'); }
          for (const [name, value] of Object.entries(filters)) next.searchParams.set(name, value);
          const visited = new Set();
          let rawCount = 0, expectedTotal;
          while (next) {
            pinnedUrl(next.href);
            for (const name of ['patient', 'subject']) {
              if (next.searchParams.getAll(name).some(value => value !== selectedPatient && value !== `Patient/${selectedPatient}`)) fail('PATIENT_BINDING_FAILED', 'A pagination link changed patient context.');
            }
            for (const [name, value] of Object.entries(filters)) {
              if (next.searchParams.getAll(name).some(actual => actual !== value)) fail('QUERY_BINDING_FAILED', 'A pagination link changed the requested clinical category.');
            }
            if (visited.has(next.href)) fail('PAGINATION_LOOP', 'The provider repeated a pagination link.');
            if (report.pages >= MAX_PAGES_PER_RESOURCE || totalPages >= MAX_TOTAL_PAGES) fail('PAGE_LIMIT', 'The bounded provider page limit was reached.');
            visited.add(next.href); report.pages++; search.pages++; totalPages++;
            const sourceUrl = next.href;
            const response = await requestJson(sourceUrl, { fetch: fetchImpl, headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/fhir+json, application/json' } });
            importedBytes += Buffer.byteLength(JSON.stringify(response));
            if (importedBytes > MAX_IMPORT_BYTES) fail('IMPORT_BYTE_LIMIT', 'The bounded total import size was reached.');
            let entries;
            if (type === 'Patient') {
              if (response.resourceType !== 'Patient') fail('INVALID_FHIR_RESPONSE', 'The provider returned an unexpected patient resource.');
              entries = [response]; next = null;
            } else {
              if (response.resourceType !== 'Bundle' || response.type !== 'searchset' || !Array.isArray(response.entry ?? [])) fail('INVALID_FHIR_RESPONSE', 'The provider returned an invalid search result bundle.');
              entries = (response.entry ?? []).map(x => x.resource);
              if (Number.isSafeInteger(response.total) && response.total >= 0) expectedTotal = response.total;
              const links = (response.link ?? []).filter(x => x.relation === 'next');
              if (links.length > 1) fail('INVALID_FHIR_RESPONSE', 'The provider returned multiple next-page links.');
              if (links.length) {
                try { next = new URL(links[0].url, sourceUrl); } catch { fail('UNTRUSTED_ENDPOINT', 'The provider returned an invalid pagination link.'); }
                pinnedUrl(next.href);
              } else next = null;
            }
            for (const raw of entries) {
              if (raw?.resourceType === 'OperationOutcome') {
                if ((raw.issue ?? []).some(x => x.severity === 'error' || x.severity === 'fatal')) fail('FHIR_OPERATION_FAILED', 'The provider reported an unsuccessful FHIR operation.');
                continue;
              }
              rawCount++;
              if (!raw || raw.resourceType !== type || typeof raw.id !== 'string' || !ID.test(raw.id)) fail('INVALID_FHIR_RESOURCE', 'The provider returned an unexpected resource type or identifier.');
              if (!belongsToPatient(raw, selectedPatient)) fail('PATIENT_BINDING_FAILED', 'A provider resource did not match the authorized patient chart.');
              const versionId = typeof raw.meta?.versionId === 'string' ? raw.meta.versionId : null;
              const key = `${type}/${raw.id}/${versionId ?? ''}/${createHash('sha256').update(JSON.stringify(raw)).digest('hex')}`;
              if (seenRecords.has(key)) continue;
              if (results.length >= MAX_RECORDS) fail('RECORD_LIMIT', 'The bounded resource import limit was reached.');
              seenRecords.add(key);
              const item = { resourceType: type, id: raw.id, versionId, sourceUrl, retrievedAt: new Date().toISOString(), ...normalized(raw), raw };
              results.push(item); report.count++; search.count++;
              if (type === 'DocumentReference') {
                for (const content of (Array.isArray(raw.content) && raw.content.length ? raw.content : [{}])) {
                  const a = content?.attachment;
                  attachments.push({ documentId: raw.id, url: a?.url ?? null, contentType: a?.contentType ?? null, status: 'not-fetched', ...(a?.data ? { inlineData: a.data } : {}), sourceUrl, clinicalDate: item.clinicalDate, dateMeaning: item.dateMeaning });
                }
              }
            }
            if (!next && expectedTotal !== undefined && rawCount < expectedTotal) fail('MISSING_PAGE', 'The provider result total indicates unreturned records without a next-page link.');
          }
          search.status = rawCount ? 'ok' : 'empty';
        } catch (error) {
          const safe = error instanceof DukeConnectionError ? error : new DukeConnectionError('SYNC_FAILED', 'This resource could not be synchronized.');
          firstFailure ??= safe;
          search.status = coverageStatus(safe);
          search.error = { code: safe.code, message: safe.message, ...(safe.status !== undefined ? { status: safe.status } : {}), reconnectRequired: safe.reconnectRequired };
          report.error ??= search.error;
          errors.push({ resourceType: type, ...filters, ...search.error });
        }
      }
      report.status = firstFailure ? coverageStatus(firstFailure) : report.count ? 'ok' : 'empty';
    } catch (error) {
      const safe = error instanceof DukeConnectionError ? error : new DukeConnectionError('SYNC_FAILED', 'This resource could not be synchronized.');
      report.status = coverageStatus(safe);
      report.error = { code: safe.code, message: safe.message, ...(safe.status !== undefined ? { status: safe.status } : {}), reconnectRequired: safe.reconnectRequired };
      errors.push({ resourceType: type, ...report.error });
    }
  }
  if (attachments.length && includeDocumentBodies) {
    const report = { resourceType: 'Binary', coverageScope: 'referenced-document-bodies', status: 'pending', count: 0, pages: 0, referencedAttachments: attachments.length };
    coverage.push(report);
    const failures = [];
    const fetchedBodies = new Map();
    for (let index = 0; index < attachments.length; index++) {
      const attachment = attachments[index];
      try {
        if (index >= MAX_DOCUMENT_BODIES) fail('DOCUMENT_BODY_LIMIT', 'The bounded document-body count was reached.');
        let body, id, sourceUrl, cached;
        if (attachment.inlineData) {
          const bytes = decodeBodyData(attachment.inlineData);
          id = `inline-${createHash('sha256').update(`${attachment.documentId}:${index}:${attachment.inlineData}`).digest('hex').slice(0,40)}`;
          body = { raw: { contentType: attachment.contentType ?? 'application/octet-stream', data: attachment.inlineData }, contentType: attachment.contentType ?? 'application/octet-stream', byteLength: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), representation: 'inline-attachment', versionId: null };
          sourceUrl = attachment.sourceUrl;
        } else {
          if (!attachment.url) fail('DOCUMENT_BODY_MISSING', 'The document reference did not provide a retrievable body.');
          if (!scopeList || !canRead(scopeList, 'Binary')) fail('SCOPE_NOT_GRANTED', 'The provider did not grant Binary read access for document bodies.', { status: 403 });
          if (supported(metadata, 'Binary') !== true) fail('RESOURCE_NOT_DECLARED', 'The provider did not declare Binary read support for document bodies.', { status: 404 });
          const target = binaryAttachmentUrl(attachment.url);
          id = target.id; sourceUrl = target.url;
          cached = fetchedBodies.get(sourceUrl);
          if (cached) body = cached.body;
          else {
            if (totalPages >= MAX_TOTAL_PAGES) fail('PAGE_LIMIT', 'The bounded provider request limit was reached.');
            totalPages++; report.pages++;
            body = await retrieveDocumentBody({ ...target, documentId: attachment.documentId, selectedPatient, accessToken, fetch: fetchImpl });
          }
        }
        if (!cached) {
          importedBytes += Buffer.byteLength(JSON.stringify(body.raw));
          if (importedBytes > MAX_IMPORT_BYTES) fail('IMPORT_BYTE_LIMIT', 'The bounded total import size was reached.');
          if (results.length >= MAX_RECORDS) fail('RECORD_LIMIT', 'The bounded resource import limit was reached.');
          const item = { resourceType: body.representation === 'FHIR-Binary' ? 'Binary' : 'DocumentAttachment', id, versionId: body.versionId, sourceUrl, retrievedAt: new Date().toISOString(), clinicalDate: attachment.clinicalDate, dateMeaning: attachment.dateMeaning, kind: 'clinical-document-body', parentDocumentId: attachment.documentId, documentIds: [attachment.documentId], contentType: body.contentType, byteLength: body.byteLength, sha256: body.digest, representation: body.representation, raw: body.raw };
          results.push(item); report.count++;
          if (attachment.url) fetchedBodies.set(sourceUrl, { item, body });
        } else if (!cached.item.documentIds.includes(attachment.documentId)) cached.item.documentIds.push(attachment.documentId);
        attachment.status = attachment.inlineData ? 'inline' : 'fetched';
        attachment.bodyResourceId = id;
        attachment.byteLength = body.byteLength;
        delete attachment.inlineData;
      } catch (error) {
        const safe = error instanceof DukeConnectionError ? error : new DukeConnectionError('DOCUMENT_BODY_FAILED', 'The document body could not be imported.');
        attachment.status = safe.code === 'UNTRUSTED_ENDPOINT' || safe.code === 'SCOPE_NOT_GRANTED' || safe.code === 'RESOURCE_NOT_DECLARED' ? 'not-fetched' : 'unavailable';
        attachment.error = { code: safe.code, message: safe.message };
        delete attachment.inlineData;
        const issue = { resourceType: 'Binary', documentId: attachment.documentId, code: safe.code, message: safe.message, ...(safe.status !== undefined ? { status: safe.status } : {}), reconnectRequired: safe.reconnectRequired };
        errors.push(issue); failures.push({ safe, issue });
      }
    }
    report.status = failures.length ? (report.count ? 'partial' : coverageStatus(failures[0].safe)) : report.count ? 'ok' : 'empty';
    if (failures.length) { report.error = failures[0].issue; report.failedAttachments = failures.length; }
  } else {
    for (const attachment of attachments) { delete attachment.inlineData; attachment.reason = 'Document bodies were not requested by this sync.'; }
  }
  const complete = coverage.length > 0 && coverage.every(x => x.status === 'ok' || x.status === 'empty');
  return {
    complete,
    watermark: complete ? startedAt : previousWatermark,
    proposedWatermark: startedAt,
    startedAt,
    completedAt: new Date().toISOString(),
    strategy: 'bounded-full-read',
    resources: results,
    coverage,
    errors,
    documentAttachments: attachments,
    completenessScope: includeDocumentBodies ? 'Requested structured resources and their referenced supported document bodies only. This does not establish complete EHR coverage.' : 'Requested structured resources only. Unfetched document bodies, unrequested resources and the complete EHR are not covered.',
    documentBodiesRequested: includeDocumentBodies,
    priorWatermarkUsedAsQueryFilter: false,
  };
}
