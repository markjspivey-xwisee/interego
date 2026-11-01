import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  OURA_API_BASE, OURA_TOKEN_URL, OURA_USER_AGENT, OuraConnectionError,
  ouraAuthorizationRequest, exchangeOuraCode, refreshOuraToken, syncOura,
} from '../oura.mjs';

const state = 'random-server-state-01234567890123456789';
const verifier = 'a'.repeat(64);
const callback = 'https://health.example/oauth/oura/callback';
const now = () => new Date('2026-10-31T12:00:00Z');
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status,
  headers: { 'Content-Type': 'application/json', ...headers } });
const validToken = { access_token: 'new-access-token', refresh_token: 'new-refresh-token', token_type: 'bearer', expires_in: 86400 };

test('authorization requests explicit limited scopes, exact callback, state and S256 challenge', () => {
  const result = ouraAuthorizationRequest({ clientId: 'client123', redirectUri: callback, state, verifier });
  const url = new URL(result.url);
  assert.equal(url.origin, 'https://cloud.ouraring.com');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'daily heartrate');
  assert.equal(url.searchParams.get('redirect_uri'), callback);
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.throws(() => ouraAuthorizationRequest({ clientId: 'c', redirectUri: callback, state, scope: 'daily personal' }), OuraConnectionError);
  assert.throws(() => ouraAuthorizationRequest({ clientId: 'c', redirectUri: 'http://remote.example/cb', state }), OuraConnectionError);
  assert.throws(() => ouraAuthorizationRequest({ clientId: 'c', redirectUri: callback, state: 'short' }), OuraConnectionError);
});

test('code exchange keeps secrets in Basic/body, supplies verifier, uses no redirects and validates returned token', async () => {
  let request;
  const result = await exchangeOuraCode({ clientId: 'client', clientSecret: 'secret', redirectUri: callback,
    code: 'one-time-code', verifier, fetch: async (url, init) => { request = { url, init }; return json(validToken); } });
  assert.equal(request.url, OURA_TOKEN_URL);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'manual');
  assert.equal(request.init.headers['User-Agent'], OURA_USER_AGENT);
  assert.equal(request.init.headers.Authorization, 'Basic ' + Buffer.from('client:secret').toString('base64'));
  const form = new URLSearchParams(request.init.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code_verifier'), verifier);
  assert.equal(form.get('redirect_uri'), callback);
  assert.equal(form.has('client_secret'), false);
  assert.equal(result.refresh_token, 'new-refresh-token');
  assert.equal(result.token_type, 'Bearer');
  assert.equal('scope' in result, false); // Never fabricate the granted scopes from what was requested.
});

test('refresh returns rotated token; invalid_grant becomes sanitized reconnect requirement', async () => {
  let form;
  const result = await refreshOuraToken({ clientId: 'c', clientSecret: 's', refreshToken: 'old-refresh',
    fetch: async (_url, init) => { form = new URLSearchParams(init.body); return json(validToken); } });
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'old-refresh');
  assert.equal(result.refresh_token, 'new-refresh-token');
  await assert.rejects(refreshOuraToken({ clientId: 'c', clientSecret: 's', refreshToken: 'old-refresh',
    fetch: async () => json({ error: 'invalid_grant', error_description: 'private-token-old-refresh' }, 400) }),
  error => error.code === 'reconnect_required' && error.reconnectRequired === true && !error.message.includes('old-refresh'));
  await assert.rejects(refreshOuraToken({ clientId: 'c', clientSecret: 's', refreshToken: 'old-refresh',
    fetch: async () => json({ ...validToken, refresh_token: undefined }) }),
  error => error.code === 'response_invalid');
});

test('sync retains provider provenance, deduplicates repeated document IDs and never aggregates Apple mirrors', async () => {
  const calls = [];
  const result = await syncOura({ accessToken: 'token', startDate: '2026-10-29', endDate: '2026-10-30', grantedScopes: 'daily heartrate spo2', now,
    fetch: async (url, init) => {
      calls.push({ url: new URL(url), init });
      const collection = new URL(url).pathname.split('/').at(-1);
      return json(collection === 'heartrate'
        ? { data: [{ timestamp: '2026-10-30T12:00:00+00:00', bpm: 68, source: 'awake' }], next_token: null }
        : { data: [{ id: 'one', day: '2026-10-30', score: 70 }, { id: 'one', day: '2026-10-30', score: 70 }], next_token: null });
    } });
  assert.equal(result.complete, true);
  assert.equal(result.records.length, 6);
  assert.equal(result.watermark, '2026-10-30');
  assert.equal(calls.length, 6);
  const hr = calls.find(c => c.url.pathname.endsWith('/heartrate'));
  assert.equal(hr.url.searchParams.get('start_datetime'), '2026-10-29T00:00:00Z');
  assert.equal(hr.url.searchParams.has('start_date'), false);
  assert.equal(hr.url.searchParams.get('end_datetime'), '2026-10-31T00:00:00.000Z');
  for (const c of calls) {
    assert.equal(c.url.origin, OURA_API_BASE);
    assert.equal(c.init.headers.Authorization, 'Bearer token');
    assert.equal(c.init.headers['User-Agent'], OURA_USER_AGENT);
    assert.equal(c.init.redirect, 'manual');
  }
  const sample = result.records.find(r => r.resourceType === 'heartrate');
  assert.equal(sample.source, 'oura');
  assert.equal(sample.provenance.idMethod, 'derived-content-hash');
  assert.equal(sample.provenance.doNotAggregateAcrossSources, true);
  assert.deepEqual(sample.raw, { timestamp: '2026-10-30T12:00:00+00:00', bpm: 68, source: 'awake' });
});

test('unknown scopes are not declared granted; optional SpO2 needs explicit grant', async () => {
  const calls = [];
  const result = await syncOura({ accessToken: 'token', startDate: '2026-10-30', endDate: '2026-10-30', now,
    fetch: async url => { calls.push(url); return json({ data: [], next_token: null }); } });
  assert.equal(result.complete, true);
  assert.equal(calls.length, 5);
  assert.equal(calls.some(x => x.includes('daily_spo2')), false);
  assert.equal(result.coverage.find(x => x.resourceType === 'daily_spo2').status, 'not_granted_or_not_requested');
  assert.equal(result.coverage.find(x => x.resourceType === 'daily_sleep').scopeKnown, false);
});

test('opaque cursors stay on pinned collection URL; repeated cursor yields partial result without advancing watermark', async () => {
  let pages = 0;
  const urls = [];
  const result = await syncOura({ accessToken: 'token', startDate: '2026-10-30', endDate: '2026-10-30', grantedScopes: 'daily',
    previousWatermark: '2026-10-29', now, fetch: async url => {
      urls.push(new URL(url));
      if (new URL(url).pathname.endsWith('/daily_sleep')) {
        return json({ data: [{ id: 'p' + (++pages), day: '2026-10-30' }], next_token: 'https://evil.example/steal' });
      }
      return json({ data: [], next_token: null });
    } });
  assert.equal(result.complete, false);
  assert.equal(result.watermark, '2026-10-29');
  assert.equal(result.errors[0].code, 'response_invalid');
  assert.equal(urls.every(x => x.origin === OURA_API_BASE), true);
  assert.equal(urls[1].searchParams.get('next_token'), 'https://evil.example/steal');
});

test('401 stops further API calls and preserves prior watermark; 403 is explicit incomplete coverage', async () => {
  let count = 0;
  const expired = await syncOura({ accessToken: 'bad', now, previousWatermark: '2026-10-28',
    fetch: async () => { count++; return json({ detail: 'secret echo' }, 401); } });
  assert.equal(count, 1);
  assert.equal(expired.complete, false);
  assert.equal(expired.watermark, '2026-10-28');
  assert.equal(expired.errors[0].reconnectRequired, true);
  const denied = await syncOura({ accessToken: 'token', now, grantedScopes: 'daily heartrate',
    fetch: async url => new URL(url).pathname.endsWith('/heartrate') ? json({}, 403) : json({ data: [] }) });
  assert.equal(denied.complete, false);
  assert.equal(denied.coverage.find(x => x.resourceType === 'heartrate').error, 'access_forbidden');
});

test('redirects and oversized pages are refused without leaking the token', async () => {
  const redirected = await syncOura({ accessToken: 'do-not-echo', now,
    fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }) });
  assert.equal(redirected.complete, false);
  assert.equal(redirected.errors[0].code, 'redirect_refused');
  assert.equal(JSON.stringify(redirected).includes('do-not-echo'), false);
  const oversized = await syncOura({ accessToken: 'token', now, fetch: async () => new Response('x',
    { headers: { 'content-length': String(3 * 1024 * 1024) } }) });
  assert.equal(oversized.errors[0].code, 'response_limit');
});

test('invalid and excessive date windows fail before any provider request', async () => {
  const options = { accessToken: 'token', now, fetch: () => { throw new Error('must not fetch'); } };
  await assert.rejects(syncOura({ ...options, startDate: '2026-02-30', endDate: '2026-03-01' }), OuraConnectionError);
  await assert.rejects(syncOura({ ...options, startDate: '2026-09-01', endDate: '2026-10-31' }), OuraConnectionError);
  await assert.rejects(syncOura({ ...options, startDate: '2026-10-31', endDate: '2026-10-01' }), OuraConnectionError);
});
