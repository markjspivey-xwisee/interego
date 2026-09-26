/**
 * NRPS consumer mode, `GET /lti/nrps/members?members_url=<platform URL>`, reads a registered LMS's
 * course roster (names, emails, roles) with a platform token the bridge obtains with its own key.
 * Like the producer roster and the AGS consumer paths, it is operator-only, and the check comes
 * before any token request: an anonymous call never reaches the platform at all.
 *
 * Every request to the platform is recorded and refused by a fetch stub. The operator case is the
 * control: it shows the stub does see the token request, so "no request" means none was made.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { attachLti13Routes } from '../src/lti13.js';
import { deriveUserWallet, mintSessionToken } from '../src/auth.js';

const PLATFORM = 'https://platform.example';
const TOKEN_URL = `${PLATFORM}/token`;
const MEMBERS_URL = `${PLATFORM}/api/lti/courses/7/names_and_roles`;
const SEED = 'nrps-consumer-is-operator-only';
const OPERATOR = { userId: 'nrps-operator', webId: 'https://operator.example/profile#me' };
const LEARNER = { userId: 'nrps-learner', webId: 'https://learner.example/profile#me' };

const realFetch = globalThis.fetch;
const platformRequests: string[] = [];
let server: Server;
let base = '';

beforeAll(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(PLATFORM)) {
      platformRequests.push(url);
      return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  });
  const app = express();
  app.use(express.json());
  attachLti13Routes(app, {
    selfBaseUrl: 'http://127.0.0.1', tenantDid: 'did:web:test', keySeed: SEED, dashboardUrl: 'http://127.0.0.1/dash',
    platformsConfig: `${PLATFORM}||client-123||deploy-1||${PLATFORM}/jwks||${PLATFORM}/auth||${TOKEN_URL}`,
    adminWebId: OPERATOR.webId,
    loadUsers: () => [OPERATOR, LEARNER].map((u) => ({ user_id: u.userId, web_id: u.webId, wallet_address: deriveUserWallet(u.userId, SEED).address })),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => { platformRequests.length = 0; });
afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((r) => server.close(() => r()));
});

const consumerMembers = (bearer?: string) => fetch(`${base}/lti/nrps/members?members_url=${encodeURIComponent(MEMBERS_URL)}`, {
  headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
});

describe('NRPS consumer mode is operator-only', () => {
  it('answers an anonymous caller 401 without asking the platform for a token', async () => {
    const r = await consumerMembers();
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error?: string }).error).toMatch(/^NRPS membership requires /);
    expect(platformRequests).toEqual([]);
  });

  it('answers a signed-in learner 401 as well: a valid session is not an operator\'s', async () => {
    const r = await consumerMembers(await mintSessionToken({ ...LEARNER, seed: SEED }));
    expect(r.status).toBe(401);
    expect(platformRequests).toEqual([]);
  });

  it('lets an operator through to the platform (the control for the two above)', async () => {
    const r = await consumerMembers(await mintSessionToken({ ...OPERATOR, seed: SEED }));
    // The stub refuses the token request, so the route answers 502, after asking the platform.
    expect(r.status).toBe(502);
    expect(platformRequests).toEqual([TOKEN_URL]);
  });

  it('keeps producer mode operator-only too', async () => {
    expect((await fetch(`${base}/lti/nrps/members`)).status).toBe(401);
    const r = await fetch(`${base}/lti/nrps/members`, { headers: { Authorization: `Bearer ${await mintSessionToken({ ...OPERATOR, seed: SEED })}` } });
    expect(r.status).toBe(200);
    expect(Array.isArray(((await r.json()) as { members?: unknown }).members)).toBe(true);
    expect(platformRequests).toEqual([]);
  });
});
