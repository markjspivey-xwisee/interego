import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createDirectoryDemand, directoryConsumerPath, type DirectoryUser } from '../src/directory-demand.js';
import { decodeToken, encodeToken, deriveUserWallet, mintSessionToken } from '../src/auth.js';
import { attachXapiLrsRoutes } from '../src/xapi-lrs.js';
import { attachXapiAdminRoutes } from '../src/xapi-admin.js';
import { attachCmi5LmsRoutes } from '../src/cmi5-lms.js';
import { attachLti13Routes } from '../src/lti13.js';
import { attachOneRosterRoutes } from '../src/oneroster.js';
import { DEFAULT_TENANT } from '../src/tenant-context.js';

const SEED = 'directory-demand-private-test-seed';
const OPERATOR = { user_id: 'operator', web_id: 'https://operator.example/profile#me',
  wallet_address: deriveUserWallet('operator', SEED).address };
const operatorToken = () => mintSessionToken({ userId: OPERATOR.user_id, webId: OPERATOR.web_id, seed: SEED });
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

async function fixture(load: () => Promise<ReadonlyArray<DirectoryUser>>, now: () => number = () => 0) {
  const directory = createDirectoryDemand(load, 60_000, now);
  const app = express();
  app.use(directory.middleware);
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/affordances', (_req, res) => res.json([]));
  const operatorAuth = { adminWebId: OPERATOR.web_id, learningEngineerWebIds: new Set<string>(), loadUsers: directory.read };
  attachXapiAdminRoutes(app, { ...operatorAuth, selfBaseUrl: 'http://127.0.0.1', basicAuthPairs: '', forwardingTargets: '' });
  attachCmi5LmsRoutes(app, { ...operatorAuth, selfBaseUrl: 'http://127.0.0.1', authoritativeSource: 'did:web:test' });
  attachLti13Routes(app, { ...operatorAuth, selfBaseUrl: 'http://127.0.0.1', tenantDid: 'did:web:test',
    keySeed: SEED, dashboardUrl: 'http://127.0.0.1/dashboard', platformsConfig: '' });
  attachOneRosterRoutes(app, { ...operatorAuth, tenantDid: 'did:web:test' });
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  attachXapiLrsRoutes(app, { podUrl: 'https://pod.example/', tenantDid: 'did:web:test',
    basicAuthPairs: 'directory-demand-basic:secret', forwardingTargets: '', selfBaseUrl: 'http://127.0.0.1',
    sessionUsers: directory.read, oauthPublicKey: publicKey,
    bearerTenantResolver: token => token === 'cmi5-known-token' ? DEFAULT_TENANT : null });
  const h = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: 'oauth-client', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const jwt = h + '.' + p + '.' + sign('sha256', Buffer.from(h + '.' + p), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const request = async (path: string, authorization?: string) => {
    const response = await fetch(base + path, { headers: { 'X-Experience-API-Version': '2.0.0',
      ...(authorization ? { Authorization: authorization } : {}) } });
    const body = await response.text();
    return { status: response.status, body };
  };
  return { directory, request, jwt };
}

describe('directory refresh runs only for an explicit wallet-authenticated consumer', () => {
  it('does no work at construction, after idle time, or for health/discovery, even with a valid session header', async () => {
    let calls = 0, now = 0;
    const { request } = await fixture(async () => { calls++; return [OPERATOR]; }, () => now);
    now = 86_400_000;
    const token = await operatorToken();
    expect((await request('/health', 'Bearer ' + token)).status).toBe(200);
    expect((await request('/affordances', 'Bearer ' + token)).status).toBe(200);
    expect(calls).toBe(0);
  });

  it('loads a cold directory before existing admin, cmi5, LTI and OneRoster gates; expires revoked users', async () => {
    let calls = 0, now = 0;
    let users: ReadonlyArray<DirectoryUser> = [OPERATOR];
    const { request } = await fixture(async () => { calls++; return users; }, () => now);
    const auth = 'Bearer ' + await operatorToken();
    for (const [path, status] of [['/xapi/admin/config', 200], ['/cmi5/launch', 400],
      ['/lti/nrps/members', 200], ['/ims/oneroster/v1p2/users', 200]] as const) {
      expect((await request(path, auth)).status).toBe(status);
    }
    expect(calls).toBe(1);
    users = []; now = 60_000;
    expect((await request('/xapi/admin/config', auth)).status).toBe(401);
    expect(calls).toBe(2);
  });

  it('coalesces a burst of real authenticated requests into one directory read', async () => {
    let calls = 0, finish: ((users: ReadonlyArray<DirectoryUser>) => void) | undefined;
    const { request } = await fixture(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
    const auth = 'Bearer ' + await operatorToken();
    const replies = Array.from({ length: 12 }, () => request('/xapi/admin/config', auth));
    for (let i = 0; i < 100 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(calls).toBe(1); expect(finish).toBeTypeOf('function');
    finish!([OPERATOR]);
    expect((await Promise.all(replies)).map(reply => reply.status)).toEqual(Array(12).fill(200));
    expect(calls).toBe(1);
  });

  it('fails closed on a refresh error and bounds retries while the directory is unavailable', async () => {
    let now = 0, calls = 0, fail = false;
    const { request } = await fixture(async () => { calls++; if (fail) throw new Error('offline'); return [OPERATOR]; }, () => now);
    const auth = 'Bearer ' + await operatorToken();
    expect((await request('/xapi/admin/config', auth)).status).toBe(200);
    now = 60_000; fail = true;
    expect((await request('/xapi/admin/config', auth)).status).toBe(401);
    expect((await request('/xapi/admin/config', auth)).status).toBe(401);
    expect(calls).toBe(2);
    now = 120_000; fail = false;
    expect((await request('/xapi/admin/config', auth)).status).toBe(200);
    expect(calls).toBe(3);
  });

  it('preserves Basic, cmi5 Basic/Bearer and real OAuth authentication on a cold cache without directory IO', async () => {
    let calls = 0;
    const { request, jwt } = await fixture(async () => { calls++; return []; });
    for (const auth of ['Basic ' + Buffer.from('directory-demand-basic:secret').toString('base64'),
      'Basic cmi5-known-token', 'Bearer cmi5-known-token', 'Bearer ' + jwt]) {
      const reply = await request('/xapi/activities', auth);
      expect(reply.status).toBe(400);
      expect(reply.body).toContain('activityId');
    }
    expect(calls).toBe(0);
  });

  it('does not fetch for missing, junk, expired or tampered tokens, and never grants an outsider access', async () => {
    let calls = 0;
    const { request } = await fixture(async () => { calls++; return [OPERATOR]; });
    const token = await operatorToken();
    const decoded = decodeToken(token)!;
    const expired = encodeToken({ ...decoded, exp: '2000-01-01T00:00:00.000Z' });
    const forged = encodeToken({ ...decoded, sub: 'https://victim.example/me' });
    for (const auth of [undefined, 'Bearer junk', 'Bearer ' + expired, 'Bearer ' + forged]) {
      expect((await request('/xapi/admin/config', auth)).status).toBe(401);
    }
    expect(calls).toBe(0);
    const outsider = await mintSessionToken({ userId: 'outsider', webId: 'https://outsider.example/me', seed: SEED });
    expect((await request('/xapi/admin/config', 'Bearer ' + outsider)).status).toBe(401);
    expect(calls).toBe(1);
  });

  it('recognizes every directory consumer and reuses an already requested admin snapshot', async () => {
    for (const path of ['/xapi/admin/config', '/cmi5/course', '/lti/ags/scores', '/lti/nrps/members',
      '/ims/oneroster/v1p2/users', '/content/deliver', '/content/ask', '/api/foxxi/v1/profiles/learner']) {
      expect(directoryConsumerPath(path)).toBe(true);
    }
    let calls = 0;
    const { directory, request } = await fixture(async () => { calls++; return []; });
    directory.observe([OPERATOR]);
    expect((await request('/xapi/admin/config', 'Bearer ' + await operatorToken())).status).toBe(200);
    expect(calls).toBe(0);
  });
});
