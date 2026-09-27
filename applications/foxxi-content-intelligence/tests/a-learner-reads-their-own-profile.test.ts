/**
 * A learner reads their own profile, the resource that carries their assignments; an operator
 * reads anyone's; no one else reads anyone's.
 *
 * ★ WHY. `GET /api/foxxi/v1/profiles/:id` was operator-only, because a profile carries directory
 * PII (email, employee id, hire date, manager). The learner's own home page reads their
 * assignments from it, so every learner who was not an operator got a 401 where their assigned
 * courses belong. The item route now also serves the profile's own user, verified the way an
 * operator is (a session token signed by a wallet the directory binds to them, never a public
 * demo seed's). A verified user asking for someone else's is refused 403. An unknown profile is a
 * 404 only for an operator, so a non-operator cannot tell which ids exist. The collection (the
 * whole directory) stays operator-only.
 *
 * The directory here is the tenant's real one (imported/admin_payload.json) with wallets from a
 * test seed, so its tokens verify; the routes and the checks are the bridge's own.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Request } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { attachHypermediaRoutes } from '../src/hypermedia-resources.js';
import { callerIsOperator, callerUserIdOf, type OperatorAuthConfig } from '../src/operator-auth.js';
import { buildAddressMap, deriveUserWallet, mintSessionToken, verifySessionToken } from '../src/auth.js';

const SEED = 'a-learner-reads-their-own-profile';
const admin = JSON.parse(readFileSync(new URL('../imported/admin_payload.json', import.meta.url), 'utf8')) as {
  users: Array<{ user_id: string; web_id: string; email: string }>;
};
const person = (id: string) => {
  const u = admin.users.find(x => x.user_id === id);
  if (!u) throw new Error(`${id} is not in the tenant directory`);
  return { userId: u.user_id, webId: u.web_id, email: u.email };
};
const ADMIN = person('u-admin');
const LE = person('u-le');
const LEARNER = person('u-joshua');
const OTHER = person('u-mgr1');
/** Signs with the wallet the PUBLIC demo seed derives, and the directory binds that wallet to them. */
const DEMO = person('u-mgr2');

const directory = () => admin.users
  .filter(u => [ADMIN, LE, LEARNER, OTHER, DEMO].some(p => p.userId === u.user_id))
  .map(u => ({
    user_id: u.user_id,
    web_id: u.web_id,
    wallet_address: (u.user_id === DEMO.userId ? deriveUserWallet(u.user_id) : deriveUserWallet(u.user_id, SEED)).address,
  }));
const operatorAuth: OperatorAuthConfig = {
  adminWebId: ADMIN.webId,
  learningEngineerWebIds: new Set([LE.webId]),
  loadUsers: directory,
};
const token = (p: { userId: string; webId: string }) => mintSessionToken({ ...p, seed: SEED });
/** Signed by the wallet the public demo seed derives for DEMO (no seed given means that one). */
const demoToken = () => mintSessionToken({ userId: DEMO.userId, webId: DEMO.webId });

let server: Server;
let base = '';
/** Each directory user's opaque profile id, as the collection lists it to an operator. */
const idOf = new Map<string, string>();

beforeAll(async () => {
  const app = express();
  attachHypermediaRoutes(app, {
    selfBaseUrl: 'http://127.0.0.1',
    affordances: [],
    isOperator: (req) => callerIsOperator(req, operatorAuth),
    callerUserId: (req) => callerUserIdOf(req, operatorAuth),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/foxxi/v1`;
  const listed = await fetch(`${base}/profiles?limit=500`, { headers: { Authorization: `Bearer ${await token(ADMIN)}` } });
  expect(listed.status).toBe(200);
  for (const item of ((await listed.json()) as { 'hydra:member': Array<{ user_id: string; id: string }> })['hydra:member']) {
    idOf.set(item.user_id, item.id);
  }
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const profile = async (userId: string, bearer?: string) => {
  const id = idOf.get(userId);
  if (!id) throw new Error(`no listed profile for ${userId}`);
  return fetch(`${base}/profiles/${id}`, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
};
type ProfileBody = { user_id?: string; email?: string; error?: string; _embedded?: { enrollments: Array<{ courseId: string }>; enrollmentsCount: number } };

describe("a learner reads their own profile, and no one else's", () => {
  it('serves a learner their own profile, with the assignments an operator reads there', async () => {
    const own = await profile(LEARNER.userId, await token(LEARNER));
    expect(own.status).toBe(200);
    const body = (await own.json()) as ProfileBody;
    expect(body.user_id).toBe(LEARNER.userId);
    expect(body._embedded!.enrollmentsCount).toBeGreaterThan(0);
    const asOperator = (await (await profile(LEARNER.userId, await token(ADMIN))).json()) as ProfileBody;
    expect(body._embedded!.enrollments).toEqual(asOperator._embedded!.enrollments);
  });

  it("refuses a verified user someone else's profile as 403, and shows none of it", async () => {
    const r = await profile(OTHER.userId, await token(LEARNER));
    expect(r.status).toBe(403);
    const text = await r.text();
    expect(text).toMatch(/only their own profile/);
    expect(text).not.toContain(OTHER.email);
  });

  it('answers an anonymous read 401', async () => {
    const r = await profile(LEARNER.userId);
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain(LEARNER.email);
  });

  it("does not take a public demo seed's token as its user, even for their own profile", async () => {
    const demo = await demoToken();
    // The control: the directory does bind the wallet that signed it, so only the public seed refuses it.
    expect(verifySessionToken(demo, buildAddressMap(directory())).ok).toBe(true);
    const r = await profile(DEMO.userId, demo);
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain(DEMO.email);
  });

  it("serves an operator anyone's profile: the admin and a learning engineer", async () => {
    const byAdmin = await profile(OTHER.userId, await token(ADMIN));
    expect(byAdmin.status).toBe(200);
    expect(((await byAdmin.json()) as ProfileBody).user_id).toBe(OTHER.userId);
    const byLe = await profile(LEARNER.userId, await token(LE));
    expect(byLe.status).toBe(200);
  });

  it('says a profile does not exist only to an operator', async () => {
    const unknown = `${base}/profiles/00000000-0000-5000-8000-000000000000`;
    const as = async (bearer?: string) => (await fetch(unknown, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} })).status;
    expect(await as(await token(ADMIN))).toBe(404);
    expect(await as(await token(LEARNER))).toBe(403);
    expect(await as()).toBe(401);
  });

  it('keeps the directory itself operator-only', async () => {
    const r = await fetch(`${base}/profiles`, { headers: { Authorization: `Bearer ${await token(LEARNER)}` } });
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain(OTHER.email);
  });
});

describe('the user a session token verifies as', () => {
  const req = (bearer?: string) => ({ headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }) as unknown as Request;

  it("is the directory user whose bound wallet signed it", async () => {
    expect(callerUserIdOf(req(await token(LEARNER)), operatorAuth)).toBe(LEARNER.userId);
    expect(callerUserIdOf(req(await token(ADMIN)), operatorAuth)).toBe(ADMIN.userId);
  });

  it('is no one without a token, for a token that does not decode, or without a directory', async () => {
    expect(callerUserIdOf(req(), operatorAuth)).toBeNull();
    expect(callerUserIdOf(req('not-a-token'), operatorAuth)).toBeNull();
    const good = await token(LEARNER);
    expect(callerUserIdOf(req(good), { ...operatorAuth, loadUsers: undefined })).toBeNull();
    expect(callerUserIdOf(req(good), { ...operatorAuth, loadUsers: () => { throw new Error('directory unreadable'); } })).toBeNull();
  });

  it("is no one for a wallet the directory binds to someone else, or for a public demo seed's", async () => {
    // Signed by the learner's own wallet, claiming another user's WebID.
    expect(callerUserIdOf(req(await mintSessionToken({ userId: LEARNER.userId, webId: OTHER.webId, seed: SEED })), operatorAuth)).toBeNull();
    expect(callerUserIdOf(req(await demoToken()), operatorAuth)).toBeNull();
  });
});

describe('the bridge wires the self read', () => {
  it('passes the user a token verifies as to the hypermedia routes, beside the operator check', () => {
    const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    const config = server.slice(server.indexOf('attachHypermediaRoutes(a, {'), server.indexOf('});', server.indexOf('attachHypermediaRoutes(a, {')));
    expect(config).toContain('isOperator: (req) => callerIsOperator(req, operatorAuth),');
    expect(config).toContain('callerUserId: (req) => callerUserIdOf(req, operatorAuth),');
  });
});
