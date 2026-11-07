import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { CourseLtiManager, verifyCourseLtiJwt, type CourseLtiBinding, type CourseLtiPlatform, type CourseLtiVerifyResult } from '../src/i2idlx-course-lti.js';
import { LTI_CLAIMS } from '../src/lti13.js';

const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));

const NOW = Date.parse('2026-11-07T20:00:00Z');
const PLATFORM: CourseLtiPlatform = { issuer: 'https://platform.example/lti', clientId: 'runtime-client', deploymentId: 'runtime-deployment',
  jwksUrl: 'https://keys.example/jwks', authorizationEndpoint: 'https://platform.example/authorize', tokenEndpoint: 'https://platform.example/token' };
const managers: CourseLtiManager[] = [];
beforeEach(() => { mocks.request.mockReset(); mocks.lookup.mockReset(); });
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); });

function fixture(verifyJwt?: (jwt: string, jwks: string, signal: AbortSignal) => Promise<CourseLtiVerifyResult>) {
  const time = { value: NOW }, controller = new AbortController();
  const binding: CourseLtiBinding = { sessionId: 'browser-session', actor: 'did:web:identity.example:agents:alice', connectionId: 'source-connection',
    courseId: 'native-course', version: 0, expiresAt: NOW + 10 * 60_000, signal: controller.signal };
  const manager = new CourseLtiManager({ baseUrl: 'https://workbench.example', now: () => time.value,
    verifyJwt: verifyJwt ?? (async token => ({ ok: true, header: { alg: 'RS256' }, payload: JSON.parse(token) })) });
  managers.push(manager);
  const descriptor = manager.prepare(binding);
  manager.configure(descriptor.id, PLATFORM, descriptor.id, 'resource-1');
  const login = () => new URL(manager.login(descriptor.id, { iss: PLATFORM.issuer, client_id: PLATFORM.clientId, lti_deployment_id: PLATFORM.deploymentId,
    target_link_uri: descriptor.launch_url, login_hint: 'opaque-platform-hint', lti_message_hint: 'opaque-message' }));
  const claims = (nonce: string) => ({ iss: PLATFORM.issuer, aud: PLATFORM.clientId, azp: PLATFORM.clientId, sub: 'cloud-subject-42',
    iat: NOW / 1000, exp: NOW / 1000 + 300, nonce,
    [LTI_CLAIMS.deploymentId]: PLATFORM.deploymentId, [LTI_CLAIMS.version]: '1.3.0', [LTI_CLAIMS.messageType]: 'LtiResourceLinkRequest',
    [LTI_CLAIMS.targetLinkUri]: descriptor.launch_url, [LTI_CLAIMS.context]: { id: descriptor.id },
    [LTI_CLAIMS.resourceLink]: { id: 'resource-1' }, [LTI_CLAIMS.roles]: ['Instructor'],
    [LTI_CLAIMS.custom]: { agent_did: 'did:web:attacker.example', owner: true } });
  const form = (patch: Record<string, unknown> = {}) => {
    const url = login(); return { state: url.searchParams.get('state')!, id_token: JSON.stringify({ ...claims(url.searchParams.get('nonce')!), ...patch }) };
  };
  return { manager, binding, descriptor, controller, time, login, claims, form };
}

describe('dynamic user-scoped LTI course connection', () => {
  it('publishes fresh public registration details and attaches only after explicit private consumption', async () => {
    const f = fixture(), other = fixture();
    expect(f.descriptor.id).not.toBe(other.descriptor.id);
    expect(f.descriptor.public_key_pem).toContain('BEGIN PUBLIC KEY');
    expect(f.descriptor.public_key_pem).not.toContain('PRIVATE');
    expect(f.manager.jwks(f.descriptor.id).keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    expect(f.manager.jwks(f.descriptor.id).keys[0]).not.toHaveProperty('d');
    expect(f.manager.status(f.descriptor.id, f.binding).state).toBe('configured');
    expect(() => f.manager.consume(f.descriptor.id, f.binding)).toThrow(/Verify a fresh/);
    const url = f.login();
    expect(url.origin + url.pathname).toBe(PLATFORM.authorizationEndpoint);
    expect(url.searchParams.get('redirect_uri')).toBe(f.descriptor.launch_url);
    expect(url.searchParams.get('response_mode')).toBe('form_post');
    await f.manager.launch(f.descriptor.id, { state: url.searchParams.get('state'), id_token: JSON.stringify(f.claims(url.searchParams.get('nonce')!)) });
    const status = f.manager.status(f.descriptor.id, f.binding);
    expect(status).toMatchObject({ state: 'verified', launch: { subject: 'cloud-subject-42', course_id: 'native-course', version: 0 } });
    expect(JSON.stringify(status)).not.toContain('attacker');
    expect(JSON.stringify(status)).not.toContain('owner');
    status.launch!.subject = 'changed-client-copy';
    expect(f.manager.consume(f.descriptor.id, f.binding).subject).toBe('cloud-subject-42');
    expect(f.manager.status(f.descriptor.id, f.binding).state).toBe('consumed');
    expect(() => f.manager.consume(f.descriptor.id, f.binding)).toThrow(/Verify a fresh/);
  });
  it.each([
    { sessionId: 'another-session' }, { actor: 'did:web:identity.example:agents:bob' }, { connectionId: 'another-source' },
    { courseId: 'another-course' }, { version: '0' }, { expiresAt: NOW + 11 * 60_000 },
  ])('refuses another authenticated binding %j', async patch => {
    const f = fixture(); await f.manager.launch(f.descriptor.id, f.form());
    const binding = { ...f.binding, ...patch };
    expect(() => f.manager.status(f.descriptor.id, binding)).toThrow(/does not belong/);
    expect(() => f.manager.consume(f.descriptor.id, binding)).toThrow(/does not belong/);
  });
  it.each([
    { iss: 'https://other.example/lti' }, { aud: 'wrong-client' }, { azp: 'wrong-client' }, { aud: ['runtime-client', 'other'], azp: undefined },
    { sub: '' }, { sub: 'space in subject' }, { nonce: 'wrong-nonce' }, { iat: NOW / 1000 + 61 }, { iat: NOW / 1000 - 301 },
    { exp: NOW / 1000 }, { exp: NOW / 1000 + 601 }, { nbf: NOW / 1000 + 61 },
    { [LTI_CLAIMS.deploymentId]: 'wrong-deployment' }, { [LTI_CLAIMS.version]: '1.1' },
    { [LTI_CLAIMS.messageType]: 'LtiDeepLinkingRequest' }, { [LTI_CLAIMS.targetLinkUri]: 'https://workbench.example/other' },
    { [LTI_CLAIMS.context]: { id: 'different-source' } }, { [LTI_CLAIMS.resourceLink]: { id: 'different-resource' } },
  ])('rejects a verified but mismatched claim %j without releasing proof', async patch => {
    const f = fixture(); await expect(f.manager.launch(f.descriptor.id, f.form(patch))).rejects.toMatchObject({ code: 'course_lti_claims_rejected' });
    expect(f.manager.status(f.descriptor.id, f.binding).state).toBe('configured');
  });
  it('accepts an exact multi-audience authorized-party binding and never infers owner rights from roles', async () => {
    const f = fixture(); await f.manager.launch(f.descriptor.id, f.form({ aud: [PLATFORM.clientId, 'other'], azp: PLATFORM.clientId }));
    const proof = f.manager.consume(f.descriptor.id, f.binding);
    expect(proof).not.toHaveProperty('roles'); expect(proof).not.toHaveProperty('owner'); expect(proof).not.toHaveProperty('actor');
    expect(proof.subject).not.toBe(f.binding.actor);
  });
  it('spends state on a failed signature and rejects its replay', async () => {
    const f = fixture(async () => ({ ok: false })), form = f.form();
    await expect(f.manager.launch(f.descriptor.id, form)).rejects.toMatchObject({ code: 'course_lti_token_rejected' });
    await expect(f.manager.launch(f.descriptor.id, form)).rejects.toMatchObject({ code: 'course_lti_launch_rejected' });
  });
  it('expires a login after five minutes without extending its connection', async () => {
    const f = fixture(), form = f.form(); f.time.value += 5 * 60_000;
    await expect(f.manager.launch(f.descriptor.id, form)).rejects.toMatchObject({ code: 'course_lti_launch_rejected' });
    expect(f.manager.status(f.descriptor.id, f.binding).state).toBe('configured');
    f.time.value = f.binding.expiresAt;
    expect(() => f.manager.jwks(f.descriptor.id)).toThrow(/connection ended/);
  });
  it('aborts verification and prevents a late result from restoring a revoked connection', async () => {
    let release!: (result: CourseLtiVerifyResult) => void;
    const f = fixture(() => new Promise(resolve => { release = resolve; })), form = f.form();
    const pending = f.manager.launch(f.descriptor.id, form); f.controller.abort();
    release({ ok: true, header: { alg: 'RS256' }, payload: JSON.parse(form.id_token) });
    await expect(pending).rejects.toMatchObject({ code: 'course_lti_expired' });
    expect(() => f.manager.status(f.descriptor.id, f.binding)).toThrow(/connection ended/);
  });
  it('revokes only the selected connection and bounds concurrent pending logins', () => {
    const f = fixture(), otherBinding = { ...f.binding, connectionId: 'other-connection' };
    const other = f.manager.prepare(otherBinding); f.manager.configure(other.id, PLATFORM, other.id);
    for (let n = 0; n < 4; n++) f.login();
    expect(() => f.login()).toThrow(/Too many pending/);
    f.manager.revokeConnection(f.binding.connectionId);
    expect(() => f.manager.status(f.descriptor.id, f.binding)).toThrow(/connection ended/);
    expect(f.manager.status(other.id, otherBinding).state).toBe('configured');
  });
  it('revokes one owned setup without removing another setup on the same source connection', () => {
    const f = fixture(), second = f.manager.prepare(f.binding); f.manager.configure(second.id, PLATFORM, second.id);
    expect(() => f.manager.revoke(f.descriptor.id, { ...f.binding, actor: 'different-actor' })).toThrow(/does not belong/);
    expect(f.manager.status(f.descriptor.id, f.binding).state).toBe('configured');
    f.manager.revoke(f.descriptor.id, f.binding);
    expect(() => f.manager.status(f.descriptor.id, f.binding)).toThrow(/connection ended/);
    expect(f.manager.status(second.id, f.binding).state).toBe('configured');
  });
  it('bounds concurrent verification and accepts only one winning launch proof', async () => {
    const releases: Array<{ resolve: (value: CourseLtiVerifyResult) => void; payload: Record<string, unknown> }> = [];
    const f = fixture(token => new Promise(resolve => releases.push({ resolve, payload: JSON.parse(token) })));
    const pending = Array.from({ length: 4 }, () => f.manager.launch(f.descriptor.id, f.form()));
    const settled = Promise.allSettled(pending);
    await expect(f.manager.launch(f.descriptor.id, f.form())).rejects.toMatchObject({ status: 429 });
    for (const release of releases) release.resolve({ ok: true, header: { alg: 'RS256' }, payload: release.payload });
    const results = await settled;
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(f.manager.status(f.descriptor.id, f.binding).state).toBe('verified');
  });
  it.each(['https://127.0.0.1/jwks', 'https://platform.example/jwks?key=secret', 'http://platform.example/jwks', 'https://host.local/jwks'])('refuses unsafe registered endpoints %s', jwksUrl => {
    const f = fixture(); const next = f.manager.prepare({ ...f.binding, connectionId: 'different' });
    expect(() => f.manager.configure(next.id, { ...PLATFORM, jwksUrl }, next.id)).toThrow(/public HTTPS/);
  });
  it('does not let login parameters replace the registered issuer, client or target', () => {
    const f = fixture();
    const input = { iss: PLATFORM.issuer, login_hint: 'hint', target_link_uri: f.descriptor.launch_url };
    for (const patch of [{ iss: 'https://other.example' }, { client_id: 'other' }, { target_link_uri: 'https://other.example/launch' }, { lti_deployment_id: 'other' }, { login_hint: ['ambiguous'] }]) {
      expect(() => f.manager.login(f.descriptor.id, { ...input, ...patch })).toThrow(/does not match/);
    }
  });
  it('exposes only bounded public protocol routes, leaves proof private, and returns a token-free completion page', async () => {
    const f = fixture(), app = express(); f.manager.attachRoutes(app);
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    try {
      const key = await fetch(base + new URL(f.descriptor.jwks_url).pathname);
      expect(key.status).toBe(200); expect(key.headers.get('cache-control')).toBe('no-store');
      expect(await key.json()).toMatchObject({ keys: [{ kty: 'RSA' }] });
      expect((await fetch(base + new URL(f.descriptor.jwks_url).pathname + '?token=bad')).status).toBe(400);
      expect((await fetch(base + '/i2idlx/course-lti/' + f.descriptor.id + '/status')).status).toBe(404);
      const login = await fetch(base + new URL(f.descriptor.login_url).pathname, { method: 'POST', redirect: 'manual',
        body: new URLSearchParams({ iss: PLATFORM.issuer, login_hint: 'hint', target_link_uri: f.descriptor.launch_url }) });
      expect(login.status).toBe(302);
      const redirect = new URL(login.headers.get('location')!);
      const response = await fetch(base + new URL(f.descriptor.launch_url).pathname, { method: 'POST',
        body: new URLSearchParams({ state: redirect.searchParams.get('state')!, id_token: JSON.stringify(f.claims(redirect.searchParams.get('nonce')!)) }) });
      const page = await response.text();
      expect(response.status).toBe(200); expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(page).toContain('Use verified launch'); expect(page).not.toContain('cloud-subject-42'); expect(page).not.toContain('id_token');
      expect(f.manager.status(f.descriptor.id, f.binding).state).toBe('verified');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});

describe('real JWT verification over the bounded registered-key transport', () => {
  function transport(keys: Record<string, unknown>[], status = 200, mime = 'application/json', announced?: number) {
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mocks.request.mockImplementation((_url, options, callback) => {
      const request = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: () => void; destroy: (error?: Error) => void };
      request.setTimeout = () => undefined;
      request.destroy = error => { if (error) request.emit('error', error); };
      request.end = () => options.lookup('keys.example', { all: true }, (error: Error | null) => {
        if (error) { request.emit('error', error); return; }
        const response = Readable.from([Buffer.from(JSON.stringify({ keys }))]) as Readable & { statusCode: number; headers: Record<string, string> };
        response.statusCode = status; response.headers = { 'content-type': mime, ...(announced ? { 'content-length': String(announced) } : {}) };
        callback(response);
      });
      return request;
    });
  }
  function signed(algorithm: 'RS256' | 'ES256') {
    const keys = algorithm === 'RS256' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = { ...keys.publicKey.export({ format: 'jwk' }), alg: algorithm, kid: 'platform-key', use: 'sig' };
    const header = Buffer.from(JSON.stringify({ alg: algorithm, kid: 'platform-key', jku: 'http://127.0.0.1/private' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: PLATFORM.issuer, sub: 'actual-signed-subject' })).toString('base64url');
    const input = header + '.' + payload;
    const signature = algorithm === 'RS256' ? sign('RSA-SHA256', Buffer.from(input), keys.privateKey)
      : sign('sha256', Buffer.from(input), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
    return { jwt: input + '.' + signature.toString('base64url'), jwk };
  }
  it.each(['RS256', 'ES256'] as const)('verifies a real %s signature only with registered public keys', async algorithm => {
    const data = signed(algorithm); transport([data.jwk]);
    expect(await verifyCourseLtiJwt(data.jwt, PLATFORM.jwksUrl, new AbortController().signal)).toMatchObject({ ok: true, payload: { sub: 'actual-signed-subject' } });
    expect(mocks.request.mock.calls[0]![0].href).toBe(PLATFORM.jwksUrl);
    expect(mocks.request.mock.calls[0]![1]).toMatchObject({ method: 'GET', agent: false });
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    transport([{ ...data.jwk, kid: 'wrong-key' }]);
    expect((await verifyCourseLtiJwt(data.jwt, PLATFORM.jwksUrl, new AbortController().signal)).ok).toBe(false);
  });
  it.each([[302, 'application/json', undefined], [200, 'text/html', undefined], [200, 'application/json', 65_537]] as const)('rejects key response status/mime/size %j', async (status, mime, length) => {
    const data = signed('RS256'); transport([data.jwk], status, mime, length);
    await expect(verifyCourseLtiJwt(data.jwt, PLATFORM.jwksUrl, new AbortController().signal)).rejects.toThrow(/bounded public keys/);
  });
  it('screens DNS in the actual socket lookup and refuses private or mixed answers', async () => {
    const data = signed('RS256'); transport([data.jwk]);
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(verifyCourseLtiJwt(data.jwt, PLATFORM.jwksUrl, new AbortController().signal)).rejects.toThrow(/public network/);
  });
  it('refuses unsupported algorithms before any key request', async () => {
    const jwt = Buffer.from(JSON.stringify({ alg: 'none', kid: 'key' })).toString('base64url') + '.' + Buffer.from('{}').toString('base64url') + '.abc';
    expect((await verifyCourseLtiJwt(jwt, PLATFORM.jwksUrl, new AbortController().signal)).ok).toBe(false);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
