/** Read-only Oura Cloud v2 adapter. No credentials, records or logs are persisted here. */
import { createHash } from 'node:crypto';

export const OURA_API_BASE = 'https://api.ouraring.com';
export const OURA_AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';
export const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
export const OURA_DEFAULT_SCOPES = 'daily heartrate';
export const OURA_USER_AGENT = 'InteregoHealthBridge/0.1';
const ALLOWED_SCOPES = new Set(['daily', 'heartrate', 'spo2']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RUN_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 12_000;
const MAX_PAGES_PER_COLLECTION = 12;
const TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;

export class OuraConnectionError extends Error {
  constructor(code, { status = 502, reconnectRequired = false, retryAfter = undefined } = {}) {
    const messages = {
      configuration_required: 'Oura application configuration is required.',
      invalid_request: 'The Oura connection request is incomplete or invalid.',
      reconnect_required: 'Oura authorization has expired or was revoked. Reconnect the account.',
      access_forbidden: 'Oura did not allow this data request. Check the selected permissions and membership.',
      rate_limited: 'Oura is limiting requests. Try again later.',
      response_invalid: 'Oura returned an unexpected response.',
      response_limit: 'The Oura result exceeded this sync limit. Retry with a smaller date window.',
      request_failed: 'The Oura request could not finish. Try again later.',
      redirect_refused: 'An unexpected Oura redirect was refused.',
    };
    super(messages[code] ?? messages.request_failed);
    this.name = 'OuraConnectionError';
    this.code = code;
    this.status = status;
    this.reconnectRequired = reconnectRequired;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

function text(value, { min = 1, max = 4096 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OuraConnectionError('invalid_request', { status: 400 });
  }
  return value;
}

function redirect(value) {
  const raw = text(value, { max: 2048 });
  let url;
  try { url = new URL(raw); } catch { throw new OuraConnectionError('invalid_request', { status: 400 }); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
    throw new OuraConnectionError('invalid_request', { status: 400 });
  }
  return raw; // Exact registered spelling must be preserved for the code exchange.
}

function scopes(value = OURA_DEFAULT_SCOPES) {
  const list = Array.isArray(value) ? value : text(value, { max: 256 }).split(/\s+/u);
  if (!list.length || list.some(s => !ALLOWED_SCOPES.has(s))) throw new OuraConnectionError('invalid_request', { status: 400 });
  return [...new Set(list)].join(' ');
}

function verifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/u.test(value)) {
    throw new OuraConnectionError('invalid_request', { status: 400 });
  }
  return value;
}

export function ouraAuthorizationRequest({ clientId, redirectUri, state, verifier: pkce, scope = OURA_DEFAULT_SCOPES }) {
  const url = new URL(OURA_AUTHORIZE_URL);
  const requested = scopes(scope);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', text(clientId, { max: 512 }));
  url.searchParams.set('redirect_uri', redirect(redirectUri));
  url.searchParams.set('state', text(state, { min: 16, max: 512 }));
  url.searchParams.set('scope', requested); // An omitted Oura scope requests ALL scopes; never omit it.
  const codeChallenge = pkce === undefined ? undefined : createHash('sha256').update(verifier(pkce)).digest('base64url');
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return { url: url.href, scope: requested, ...(codeChallenge ? { codeChallenge } : {}) };
}

async function boundedText(response, maxBytes) {
  const size = Number(response.headers?.get('content-length'));
  if (size > maxBytes) {
    try { await response.body?.cancel(); } catch { /* discarded */ }
    throw new OuraConnectionError('response_limit');
  }
  let raw;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > maxBytes) throw new OuraConnectionError('response_limit');
        chunks.push(item.value);
      }
      raw = Buffer.concat(chunks, bytes).toString('utf8');
    } finally {
      try { await reader.cancel(); } catch { /* already complete */ }
      reader.releaseLock();
    }
  } else {
    raw = await response.text();
    if (Buffer.byteLength(raw) > maxBytes) throw new OuraConnectionError('response_limit');
  }
  return raw;
}

async function boundedJson(response, maxBytes, oauth = false) {
  if (response.status >= 300 && response.status < 400) throw new OuraConnectionError('redirect_refused');
  if (response.url && new URL(response.url).origin !== OURA_API_BASE) throw new OuraConnectionError('redirect_refused');
  if (!response.ok) {
    // Error bodies can contain tokens or provider-echoed parameters. Do not expose them.
    if (oauth && response.status === 400) {
      let code;
      try { code = JSON.parse(await boundedText(response, 8192)).error; } catch { /* sanitized below */ }
      if (code === 'invalid_grant' || code === 'invalid_token') {
        throw new OuraConnectionError('reconnect_required', { status: 401, reconnectRequired: true });
      }
      if (code === 'invalid_client') throw new OuraConnectionError('configuration_required', { status: 503 });
      throw new OuraConnectionError('request_failed', { status: 400 });
    }
    try { await response.body?.cancel(); } catch { /* discarded */ }
    if (response.status === 401) throw new OuraConnectionError('reconnect_required', { status: 401, reconnectRequired: true });
    if (response.status === 403) throw new OuraConnectionError('access_forbidden', { status: 403 });
    if (response.status === 429) {
      const raw = response.headers?.get('retry-after');
      const seconds = raw && /^\d{1,6}$/u.test(raw) ? Math.min(Number(raw), 3600) : undefined;
      throw new OuraConnectionError('rate_limited', { status: 429, retryAfter: seconds });
    }
    throw new OuraConnectionError('request_failed', { status: response.status >= 500 ? 502 : 400 });
  }
  const raw = await boundedText(response, maxBytes);
  try { return { value: JSON.parse(raw), bytes: Buffer.byteLength(raw) }; }
  catch { throw new OuraConnectionError('response_invalid'); }
}

async function requestJson(url, init, fetcher, maxBytes = MAX_RESPONSE_BYTES, oauth = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal });
    return await boundedJson(response, maxBytes, oauth);
  } catch (error) {
    if (error instanceof OuraConnectionError) throw error;
    throw new OuraConnectionError('request_failed');
  } finally { clearTimeout(timer); }
}

function tokenShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.access_token !== 'string'
    || !value.access_token || value.access_token.length > 16_384 || typeof value.refresh_token !== 'string'
    || !value.refresh_token || value.refresh_token.length > 16_384 || String(value.token_type).toLowerCase() !== 'bearer'
    || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 366 * 86_400) {
    throw new OuraConnectionError('response_invalid');
  }
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    token_type: 'Bearer',
    expires_in: value.expires_in,
    // Oura documents that callback scope may be absent/deprecated. Only keep provider-supplied token scopes.
    ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
  };
}

async function tokenRequest(fields, { clientId, clientSecret, fetch: fetcher = globalThis.fetch }) {
  const id = text(clientId, { max: 512 });
  const secret = text(clientSecret, { max: 16_384 });
  const body = new URLSearchParams(fields);
  const basic = Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64');
  const { value } = await requestJson(OURA_TOKEN_URL, {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json', 'User-Agent': OURA_USER_AGENT }, body: body.toString(),
  }, fetcher, 64 * 1024, true);
  return tokenShape(value);
}

export async function exchangeOuraCode({ clientId, clientSecret, redirectUri, code, verifier: pkce, fetch }) {
  const fields = { grant_type: 'authorization_code', code: text(code, { max: 4096 }), redirect_uri: redirect(redirectUri) };
  if (pkce !== undefined) fields.code_verifier = verifier(pkce);
  return tokenRequest(fields, { clientId, clientSecret, fetch });
}

export async function refreshOuraToken({ clientId, clientSecret, refreshToken, fetch }) {
  // Oura refresh tokens are single-use. The caller MUST serialize refresh and save the replacement before any other API call.
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: text(refreshToken, { max: 16_384 }) }, { clientId, clientSecret, fetch });
}

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new OuraConnectionError('invalid_request', { status: 400 });
  const time = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new OuraConnectionError('invalid_request', { status: 400 });
  return { date: value, time };
}

const stableJson = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

function normalize(collection, raw, retrievedAt) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OuraConnectionError('response_invalid');
  const providerId = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 256 ? raw.id : undefined;
  const derived = createHash('sha256').update(stableJson(raw)).digest('hex');
  const id = providerId ?? derived;
  const clinicalDate = typeof raw.day === 'string' ? raw.day : typeof raw.timestamp === 'string' ? raw.timestamp : null;
  return {
    id: `oura:${collection}:${id}`, source: 'oura', resourceType: collection,
    clinicalDate, retrievedAt, sourceUrl: `${OURA_API_BASE}/v2/usercollection/${collection}`,
    kind: collection === 'heartrate' ? 'wearable-sample' : 'wearable-summary',
    provenance: { provider: 'Oura', apiVersion: 'v2', collection,
      idMethod: providerId ? 'provider-id' : 'derived-content-hash',
      doNotAggregateAcrossSources: true,
      note: 'Oura readings can also be mirrored into Apple Health. Keep feed provenance and do not sum duplicate physiological observations or proprietary scores.' },
    raw,
  };
}

/**
 * One bounded, read-only date-window pass. No watermark advances on a partial result.
 * `complete` describes the requested window/allowed collections, never a complete medical history.
 */
export async function syncOura({ accessToken, startDate, endDate, grantedScopes, previousWatermark = null,
  fetch: fetcher = globalThis.fetch, now = () => new Date() }) {
  const token = text(accessToken, { max: 16_384 });
  const observed = now();
  const clock = observed instanceof Date ? observed : new Date(observed);
  if (!Number.isFinite(clock.getTime())) throw new OuraConnectionError('invalid_request', { status: 400 });
  const finish = isoDate(endDate ?? clock.toISOString().slice(0, 10));
  const begin = isoDate(startDate ?? new Date(finish.time - 29 * DAY_MS).toISOString().slice(0, 10));
  if (finish.time < begin.time || finish.time - begin.time > 30 * DAY_MS || finish.time > clock.getTime() + DAY_MS) {
    throw new OuraConnectionError('invalid_request', { status: 400 });
  }
  const knownScopes = grantedScopes === undefined ? undefined
    : new Set(Array.isArray(grantedScopes) ? grantedScopes : String(grantedScopes).split(/\s+/u));
  const collections = [
    ['daily_sleep', 'daily'], ['daily_readiness', 'daily'], ['daily_activity', 'daily'], ['sleep', 'daily'],
    ['heartrate', 'heartrate'], ['daily_spo2', 'spo2'],
  ];
  const records = [], coverage = [], errors = [], seen = new Set();
  let totalBytes = 0;
  const startedAt = clock.toISOString();
  for (const [collection, requiredScope] of collections) {
    // An unknown grant is not assumed authorized: daily/HR may be attempted, with provider errors retained.
    // Optional SpO2 is attempted only with an explicitly known spo2 grant.
    if ((knownScopes && !knownScopes.has(requiredScope)) || (!knownScopes && requiredScope === 'spo2')) {
      coverage.push({ resourceType: collection, scope: requiredScope, status: 'not_granted_or_not_requested', count: 0, pages: 0 });
      continue;
    }
    const url = new URL(`/v2/usercollection/${collection}`, OURA_API_BASE);
    if (collection === 'heartrate') {
      url.searchParams.set('start_datetime', begin.date + 'T00:00:00Z');
      // Oura end_datetime is an instant; use the following midnight for the selected inclusive day window.
      url.searchParams.set('end_datetime', new Date(finish.time + DAY_MS).toISOString());
    } else {
      url.searchParams.set('start_date', begin.date);
      url.searchParams.set('end_date', finish.date);
    }
    let pages = 0, count = 0, nextToken;
    const cursors = new Set();
    try {
      do {
        if (++pages > MAX_PAGES_PER_COLLECTION || records.length >= MAX_RECORDS) throw new OuraConnectionError('response_limit');
        if (nextToken !== undefined) url.searchParams.set('next_token', nextToken);
        const { value, bytes } = await requestJson(url.href, { method: 'GET', headers: {
          Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': OURA_USER_AGENT,
        } }, fetcher);
        totalBytes += bytes;
        if (totalBytes > MAX_RUN_BYTES || !value || typeof value !== 'object' || !Array.isArray(value.data)) {
          throw new OuraConnectionError(totalBytes > MAX_RUN_BYTES ? 'response_limit' : 'response_invalid');
        }
        for (const raw of value.data) {
          const entry = normalize(collection, raw, startedAt);
          if (!seen.has(entry.id)) {
            if (records.length >= MAX_RECORDS) throw new OuraConnectionError('response_limit');
            seen.add(entry.id); records.push(entry); count++;
          }
        }
        nextToken = value.next_token ?? undefined;
        if (nextToken !== undefined && (typeof nextToken !== 'string' || !nextToken || nextToken.length > 4096 || cursors.has(nextToken))) {
          throw new OuraConnectionError('response_invalid');
        }
        if (nextToken) cursors.add(nextToken);
      } while (nextToken !== undefined);
      coverage.push({ resourceType: collection, scope: requiredScope, scopeKnown: Boolean(knownScopes), status: 'ok', count, pages });
    } catch (error) {
      const safe = error instanceof OuraConnectionError ? error : new OuraConnectionError('request_failed');
      const detail = { resourceType: collection, code: safe.code, status: safe.status, reconnectRequired: safe.reconnectRequired,
        ...(safe.retryAfter !== undefined ? { retryAfter: safe.retryAfter } : {}) };
      errors.push(detail);
      coverage.push({ resourceType: collection, scope: requiredScope, status: 'incomplete', count, pages, error: safe.code });
      // A dead credential or budget exhaustion affects all subsequent collections; do not hammer the provider.
      if (safe.reconnectRequired || safe.code === 'rate_limited' || safe.code === 'response_limit') break;
    }
  }
  const completedAt = new Date(now()).toISOString();
  const complete = errors.length === 0 && coverage.some(c => c.status === 'ok');
  return { complete, records, coverage, errors, startedAt, completedAt,
    window: { startDate: begin.date, endDate: finish.date, maxDays: 31 },
    watermark: complete ? finish.date : previousWatermark, proposedWatermark: finish.date,
    warnings: ['Oura daily records may be revised after initial sync; overlap the previous window on later runs.',
      'Source provenance does not establish equivalence with Apple Health mirrors. No cross-source totals are computed.',
      ...(!knownScopes ? ['Granted scopes were not supplied; successful collections and denied requests are recorded separately.'] : [])] };
}
