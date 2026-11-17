/**
 * The dashboard offers identity's GENERAL guest beside "Start as a guest", when the operator turns
 * that on (DURABLE-GUEST.md, "The general guest").
 *
 * ★ WHAT IS HELD HERE. A general guest on the dashboard is still a tab key: the bridge keeps a
 * statement of whom that key is attributed to (the guest, or the account it is linked to) and
 * nothing in its caller model reads it. So these tests hold the round trip, the ways a visit
 * cannot be finished by anyone but the tab that started it, the statement's bounds, and that the
 * statement is no authority.
 *
 * Identity is the real provider run in process over fake storage
 * (applications/_shared/tests/general-guest-identity.ts); the door page is played by a generated
 * P-256 key. No identity, relay or pod is called. Every name is fictional.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import express from 'express';
import { ethers } from 'ethers';
import {
  DASHBOARD_GENERAL_GUEST_PATHS as PATHS, DASHBOARD_GENERAL_GUEST_PURPOSES as PURPOSES, DASHBOARD_GENERAL_GUEST_RETURN_PATH, DASHBOARD_GUEST_SESSION_MS,
  DashboardGeneralGuest, attachDashboardGeneralGuestRoutes, dashboardGeneralGuestOffer, dashboardGeneralGuestSettings, type DashboardGuestDoor,
} from '../src/dashboard-general-guest.js';
import { playGrantConfig } from '../src/play-grant.js';
import { resolveCallerContext } from '../src/policy.js';
import { mayAdministerTenant } from '../src/tenant-admin-policy.js';
import {
  GENERAL_GUEST_RETURN_PATH, GeneralGuestError, finishGeneralGuest, generalGuestOffer, generalGuestReturn, signOutGeneralGuest, startGeneralGuest,
  type GeneralGuestDeps, type GeneralGuestOffer,
} from '../dashboard-app/src/auth/general-guest.js';
import { connectAsGeneralGuest, saveSession } from '../dashboard-app/src/auth/session.js';
import { signAgentRequestAs } from '../dashboard-app/src/auth/signed-request.js';
import { LINKED_GUEST_SESSION_MS } from '../../_shared/guest-access/session.js';
import type { GeneralGuestSession } from '../../_shared/guest-access/door.js';
import { ISSUER, identity, newKey } from '../../_shared/tests/general-guest-identity.js';
import { generalGuestUserId, playKeyThumbprint, publicPlayKey } from '../../../deploy/identity/provisional-play.js';

const DASH = 'https://dashboard.example', BRIDGE = 'https://bridge.example', POD = 'https://pods.example/tenant/';
const SERVICE = { agentDid: 'did:web:identity.example:agents:dashboard-service', podUrl: 'https://pods.example/dashboard/' };
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
type Key = ReturnType<typeof newKey>;
const guestDidOf = (key: Key) => `did:web:identity.example:users:${generalGuestUserId(playKeyThumbprint(publicPlayKey(key.publicKey.export({ format: 'jwk' }))))}`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

/** The bridge's four routes over `door`, and a page on the dashboard's origin that can reach them. */
async function bridge(door: DashboardGuestDoor | null, options: { now?: () => number; maxBindings?: number } = {}) {
  const guests = door ? new DashboardGeneralGuest({ door, ...options }) : null;
  const app = express(); app.set('trust proxy', false); app.use(express.json());
  // What the bridge's /play/guest answers, with the member this adds only where it is on.
  app.get('/play/guest', (_req, res) => { res.json({ enabled: true, audience: DASH, identityUrl: ISSUER,
    ...(guests ? { generalGuest: dashboardGeneralGuestOffer({ audience: DASH, identityUrl: ISSUER }) } : {}) }); });
  if (guests) attachDashboardGeneralGuestRoutes(app, guests);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
  cleanups.push(() => new Promise(done => { server.close(() => done()); }));
  const local = `http://127.0.0.1:${address.port}`;
  const seen: Array<{ url: string; status: number; body: string }> = [];
  /** A request as a browser page on `origin` makes it. */
  const post = async (path: string, body: unknown, origin: string | null = DASH) => {
    const response = await fetch(local + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
    const answered = await response.text(); seen.push({ url: path, status: response.status, body: answered });
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(answered || '{}') as Record<string, unknown>; } catch { parsed = { notJson: answered.replace(path, '') }; }
    return { status: response.status, body: parsed, location: response.headers.get('location') };
  };
  /** One tab of the dashboard: its own sessionStorage, and fetch as the browser would send it. */
  const tab = (): GeneralGuestDeps & { requests: string[]; kept: Map<string, string> } => {
    const kept = new Map<string, string>(), requests: string[] = [];
    return { kept, requests, store: { getItem: key => kept.get(key) ?? null, setItem: (key, value) => { kept.set(key, value); }, removeItem: key => { kept.delete(key); } },
      fetch: async (url, init) => {
        requests.push(url);
        const response = await fetch(url.replace(BRIDGE, local), { method: init?.method ?? 'GET', headers: { ...(init?.headers ?? {}), Origin: DASH }, ...(init?.body ? { body: init.body } : {}) });
        const answered = await response.text(); seen.push({ url, status: response.status, body: answered });
        return { ok: response.ok, status: response.status, json: async () => JSON.parse(answered) as unknown };
      } };
  };
  return { guests, local, post, tab, seen };
}
const signed = (wallet: ethers.HDNodeWallet | ethers.Wallet, args: Record<string, unknown>) => signAgentRequestAs(wallet, args);
const standingOf = async (b: Awaited<ReturnType<typeof bridge>>, wallet: ethers.HDNodeWallet) =>
  (await b.post(PATHS.standing, await signed(wallet, { purpose: PURPOSES.standing }))).body['generalGuest'] as Record<string, unknown> | null;

/**
 * Identity with the dashboard registered for the door, and a clock for the bridge that a test can
 * move on. Identity and the door keep the real one: identity reads each grant's short expiry by it.
 */
function world() {
  let offset = 0;
  const now = () => Date.now() + offset;
  const id = identity({ [DASH]: { ...SERVICE, returnPath: DASHBOARD_GENERAL_GUEST_RETURN_PATH } });
  return { id, now, advance: (ms: number) => { offset += ms; }, door: id.doorFor(DASH, SERVICE) };
}
/** One browser's whole journey: start in a tab, the door page, back to the dashboard, finish. */
async function comeThrough(b: Awaited<ReturnType<typeof bridge>>, id: ReturnType<typeof identity>, key: Key) {
  const page = b.tab(), offer = (await generalGuestOffer(BRIDGE, page))!;
  const doorUrl = await startGeneralGuest(offer, page);
  const back = await id.page(key, doorUrl);
  const returned = generalGuestReturn({ pathname: back.pathname, search: back.search })!;
  return { page, offer, back, returned, ...await finishGeneralGuest(offer, returned, page) };
}

/** A door that answers whatever a test states identity said, to hold the bounds and the table. */
function statedDoor(state: () => Partial<GeneralGuestSession> & { linkedTo?: string }, now: () => number): DashboardGuestDoor & { finished: number } {
  let serial = 0;
  const door = { audience: DASH, identityUrl: ISSUER, finished: 0,
    async start() { return { url: `${ISSUER}/guest/door#grant=x`, state: 's'.repeat(43), binding: 'b'.repeat(43) }; },
    async finish(): Promise<GeneralGuestSession> {
      door.finished += 1;
      const userId = `u-try-guest-${String(++serial).padStart(32, '0')}`, ownerDid = `did:web:identity.example:users:${userId}`;
      const { linkedTo, ...over } = state(), guestExpiresAt = over.guestExpiresAt ?? now() + 24 * 3_600_000;
      return { userId, ownerDid, webId: `${ISSUER}/users/${userId}/profile#me`, podUrl: `https://pods.example/${userId}/`, agentDid: 'did:web:identity.example:agents:a',
        namespace: 'foxxi', guestExpiresAt, token: 'cg2_never-kept', tokenExpiresAt: new Date(now() + 3_600_000).toISOString(),
        attributes: { subject: ownerDid, provisional: true, claimed: false, establishedAt: Math.floor(now() / 1000) - 60, standingUntil: Math.floor(guestExpiresAt / 1000),
          admittedBy: [DASH], ...(linkedTo ? { linkedTo: linkedTo === 'itself' ? ownerDid : linkedTo } : {}) } as GeneralGuestSession['attributes'], ...over };
    } };
  return door;
}
const finishWith = async (b: Awaited<ReturnType<typeof bridge>>, wallet: ethers.HDNodeWallet) =>
  b.post(PATHS.finish, await signed(wallet, { purpose: PURPOSES.finish, code: 'c', state: 's'.repeat(43), binding: 'b'.repeat(43) }));

describe('off unless configured', () => {
  const PLAY = { FOXXI_PLAY_SERVICE_PRIVATE_KEY: '0x' + '11'.repeat(32), FOXXI_PLAY_AUDIENCE: DASH, INTEREGO_IDENTITY_URL: ISSUER, INTEREGO_RELAY_URL: 'https://relay.example' };

  it('is on only for exactly 1, and only with the dashboard\'s own guest service', () => {
    const play = playGrantConfig(PLAY);
    for (const value of [undefined, '', '0', 'true', '1 ', 'yes']) expect(dashboardGeneralGuestSettings({ ...PLAY, FOXXI_PLAY_GENERAL_GUEST: value }, play), String(value)).toBeNull();
    expect(dashboardGeneralGuestSettings({ ...PLAY, FOXXI_PLAY_GENERAL_GUEST: '1' }, play)).toEqual({ audience: DASH, identityUrl: ISSUER });
    expect(() => dashboardGeneralGuestSettings({ FOXXI_PLAY_GENERAL_GUEST: '1' }, null)).toThrow(/FOXXI_PLAY_SERVICE_PRIVATE_KEY/);
    expect(dashboardGeneralGuestSettings({ FOXXI_PLAY_GENERAL_GUEST: '1', FOXXI_PLAY_GENERAL_GUEST_DOOR_ORIGIN: 'https://door.example' }, play)).toMatchObject({ doorOrigin: 'https://door.example' });
    for (const bad of ['door.example', 'https://door.example/path', 'http://door.example', DASH]) {
      expect(() => dashboardGeneralGuestSettings({ FOXXI_PLAY_GENERAL_GUEST: '1', FOXXI_PLAY_GENERAL_GUEST_DOOR_ORIGIN: bad }, play), bad).toThrow();
    }
  });

  it('with it off, its paths are any path the bridge never had, and the sign-in page is offered nothing', async () => {
    const b = await bridge(null);
    const never = await b.post('/play/general/never-existed', {});
    for (const path of Object.values(PATHS)) {
      const answer = await b.post(path, {});
      expect({ status: answer.status, body: answer.body }, path).toEqual({ status: never.status, body: never.body });
    }
    expect(never.status).toBe(404);
    const page = b.tab();
    expect(await generalGuestOffer(BRIDGE, page)).toBeNull();
    expect(await (await fetch(b.local + '/play/guest')).json()).toEqual({ enabled: true, audience: DASH, identityUrl: ISSUER });
  });

  it('the bridge builds, attaches and reports it only where the setting is on, and no caller check reads it', () => {
    const server = read('../bridge/server.ts');
    expect(server).toContain('const dashboardGeneralGuest = dashboardGeneralGuestSettings(process.env, playGrantSettings);');
    expect(server).toContain('if (dashboardGeneralGuests) attachDashboardGeneralGuestRoutes(app, dashboardGeneralGuests);');
    expect(server).toContain('...(dashboardGeneralGuest ? { generalGuest: dashboardGeneralGuestOffer(dashboardGeneralGuest) } : {}) }\n    : { enabled: false });');
    // The table is named where it is made and where its routes are attached, and nowhere else:
    // resolveCaller, verifyDelegatedCaller and bindSignedCaller do not know it exists.
    expect(server.split('dashboardGeneralGuests').length - 1).toBe(3);
    expect(server.includes('dashboardGeneralGuests.')).toBe(false);
  });
});

describe('the round trip', () => {
  it('ends in a guest session on a key the tab makes, which the bridge attributes to the browser\'s Interego guest', async () => {
    const w = world(), b = await bridge(w.door, { now: w.now }), key = newKey();
    const { page, offer, back, wallet, standing } = await comeThrough(b, w.id, key);
    // The door returned to the DASHBOARD's own origin and registered path, where the app routes the sign-in page.
    expect(back.origin + back.pathname).toBe(DASH + GENERAL_GUEST_RETURN_PATH);
    expect(GENERAL_GUEST_RETURN_PATH).toBe(DASHBOARD_GENERAL_GUEST_RETURN_PATH);
    expect(standing).toMatchObject({ guestDid: guestDidOf(key), subject: guestDidOf(key), linked: false });
    expect(await standingOf(b, wallet)).toEqual(standing);
    expect(b.guests!.standingOf(wallet.address)).toMatchObject({ subject: guestDidOf(key), linked: false });
    // Nothing of the visit is left in the tab, and the tab's key was never there.
    expect([...page.kept.values()].join('')).toBe('');
    // The session is a guest session: it IS the tab key, and says whom it is attributed to.
    const session = await connectAsGeneralGuest(POD, wallet, standing, offer.signOutUrl);
    expect(session).toMatchObject({ role: 'learner', webId: `did:ethr:${wallet.address}`, connectedPrivateKey: wallet.privateKey,
      audienceTags: ['connected-wallet', 'guest', 'general-guest'], generalGuest: { guestDid: guestDidOf(key), subject: guestDidOf(key), linked: false } });
    const written: Record<string, string> = {}, had = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = { setItem: (k: string, v: string) => { written[k] = v; } };
    try { saveSession(session); } finally { (globalThis as { localStorage?: unknown }).localStorage = had; }
    expect(Object.values(written).join('')).not.toContain(wallet.privateKey);
    expect(Object.values(written).join('')).not.toContain(session.guestRecoveryPhrase!);
    // The same browser key through the door again is the same Interego guest, on another tab key.
    const again = await comeThrough(b, w.id, key);
    expect(again.standing.guestDid).toBe(standing.guestDid);
    expect(again.wallet.address).not.toBe(wallet.address);
  });

  it('puts nothing secret where it is not meant to be', async () => {
    const w = world(), b = await bridge(w.door, { now: w.now }), key = newKey();
    const { returned, wallet } = await comeThrough(b, w.id, key);
    const exchanged = w.id.exchanges.at(-1) as { codeVerifier: string };
    for (const answer of b.seen) {
      // The PKCE verifier and identity's token for the guest leave the bridge in no answer at all.
      expect(answer.body, answer.url).not.toContain(exchanged.codeVerifier);
      expect(answer.body, answer.url).not.toMatch(/cg2_|codeVerifier|"token"/);
      // The start answer is the one that carries the visit's state and binding, to the page that asked.
      if (!answer.url.endsWith(PATHS.start)) expect(answer.body, answer.url).not.toMatch(/binding|grant=|"state"/);
      expect(answer.body, answer.url).not.toContain(returned.code);
      expect(answer.body, answer.url).not.toContain(wallet.privateKey);
    }
    // No route here redirects: there is no Location header to carry anything.
    expect((await b.post(PATHS.standing, await signed(wallet, { purpose: PURPOSES.standing }))).location).toBeNull();
  });
});

describe('a visit is finished only by the tab that started it', () => {
  it('a stranger holding the return address gains nothing and spends nothing', async () => {
    const w = world(), b = await bridge(w.door, { now: w.now }), key = newKey();
    const page = b.tab(), offer = (await generalGuestOffer(BRIDGE, page))!;
    const back = await w.id.page(key, await startGeneralGuest(offer, page));
    const returned = generalGuestReturn(back)!, stranger = ethers.Wallet.createRandom();
    // With no binding, a guessed one, and from a tab that never started a visit.
    for (const binding of ['A'.repeat(43), returned.state.slice(0, 43).padEnd(43, 'A')]) {
      const answer = await b.post(PATHS.finish, await signed(stranger, { purpose: PURPOSES.finish, ...returned, binding }));
      expect(answer).toMatchObject({ status: 401, body: { error: 'general_guest_return_invalid' } });
    }
    expect((await b.post(PATHS.finish, await signed(stranger, { purpose: PURPOSES.finish, ...returned }))).status).toBe(400);
    const elsewhere = b.tab(), before = elsewhere.requests.length;
    await expect(finishGeneralGuest(offer, returned, elsewhere)).rejects.toMatchObject({ code: 'general_guest_not_started_here' });
    expect(elsewhere.requests.length).toBe(before);
    expect(b.guests!.standingOf(stranger.address)).toBeNull();
    expect(w.id.exchanges).toHaveLength(0);
    // The tab that started it still finishes.
    const { standing } = await finishGeneralGuest(offer, returned, page);
    expect(standing.guestDid).toBe(guestDidOf(key));
  });

  it('a code is used once, and a finished visit finishes nothing again', async () => {
    const w = world(), b = await bridge(w.door, { now: w.now }), key = newKey();
    const page = b.tab(), offer = (await generalGuestOffer(BRIDGE, page))!;
    const back = await w.id.page(key, await startGeneralGuest(offer, page));
    const visit = JSON.parse(page.kept.values().next().value!) as { state: string; binding: string };
    const returned = generalGuestReturn(back)!, wallet = ethers.Wallet.createRandom(), other = ethers.Wallet.createRandom();
    const envelope = await signed(wallet, { purpose: PURPOSES.finish, ...returned, binding: visit.binding });
    expect((await b.post(PATHS.finish, envelope)).status).toBe(200);
    // The same request again, the same visit under a fresh signature, and the same visit under another key.
    expect((await b.post(PATHS.finish, envelope)).status).toBe(401);
    expect((await b.post(PATHS.finish, await signed(wallet, { purpose: PURPOSES.finish, ...returned, binding: visit.binding }))).status).toBe(401);
    expect((await b.post(PATHS.finish, await signed(other, { purpose: PURPOSES.finish, ...returned, binding: visit.binding }))).status).toBe(401);
    expect(b.guests!.size).toBe(1);
    expect(b.guests!.standingOf(other.address)).toBeNull();
    expect(w.id.exchanges).toHaveLength(1);
  });

  it('an attacker\'s return address does not make a victim\'s tab the attacker\'s guest', async () => {
    const w = world(), b = await bridge(w.door, { now: w.now }), attackerKey = newKey(), victimKey = newKey();
    // The attacker starts a visit and passes the door as their own guest, then hands the victim the return address.
    const attacker = b.tab(), offer = (await generalGuestOffer(BRIDGE, attacker))!;
    const planted = generalGuestReturn(await w.id.page(attackerKey, await startGeneralGuest(offer, attacker)))!;
    // A victim who started nothing: the page drops it without a request.
    const idle = b.tab(), asked = idle.requests.length;
    await expect(finishGeneralGuest(offer, planted, idle)).rejects.toBeInstanceOf(GeneralGuestError);
    expect(idle.requests.length).toBe(asked);
    // A victim in the middle of their own visit: the planted state is not theirs, so again no request.
    const victim = b.tab(), victimDoor = await startGeneralGuest(offer, victim);
    const victimVisit = JSON.parse(victim.kept.values().next().value!) as { state: string; binding: string };
    await expect(finishGeneralGuest(offer, planted, victim)).rejects.toMatchObject({ code: 'general_guest_not_started_here' });
    // And were a page to send it all the same, the bridge refuses the victim's binding for the attacker's state.
    const victimWallet = ethers.Wallet.createRandom();
    expect((await b.post(PATHS.finish, await signed(victimWallet, { purpose: PURPOSES.finish, ...planted, binding: victimVisit.binding }))).status).toBe(401);
    expect(b.guests!.standingOf(victimWallet.address)).toBeNull();
    // Fixation, the other way round: the attacker with the victim's return address and their own binding.
    const victimReturn = generalGuestReturn(await w.id.page(victimKey, victimDoor))!;
    const attackerVisit = JSON.parse(attacker.kept.values().next().value!) as { binding: string };
    const attackerWallet = ethers.Wallet.createRandom();
    expect((await b.post(PATHS.finish, await signed(attackerWallet, { purpose: PURPOSES.finish, ...victimReturn, binding: attackerVisit.binding }))).status).toBe(401);
    expect(b.guests!.size).toBe(0);
    // Neither refusal spent the victim's visit.
    expect((await b.post(PATHS.finish, await signed(victimWallet, { purpose: PURPOSES.finish, ...victimReturn, binding: victimVisit.binding }))).body).toMatchObject({ generalGuest: { guestDid: guestDidOf(victimKey) } });
  });

  it('answers only the dashboard\'s origin, and only a key signing as itself for that purpose', async () => {
    const w = world(), b = await bridge(w.door, { now: w.now }), wallet = ethers.Wallet.createRandom();
    for (const origin of ['https://evil.example', null]) {
      expect((await b.post(PATHS.start, {}, origin)).status, String(origin)).toBe(403);
      expect((await b.post(PATHS.standing, await signed(wallet, { purpose: PURPOSES.standing }), origin)).status).toBe(403);
    }
    expect((await b.post(PATHS.start, { next: 'https://evil.example' })).status).toBe(400);
    expect((await b.post(PATHS.standing, {})).status).toBe(401);
    // A signature made for one of these routes is no use at another.
    expect((await b.post(PATHS.standing, await signed(wallet, { purpose: PURPOSES.signOut }))).status).toBe(400);
    expect((await b.post(PATHS.signOut, await signed(wallet, { purpose: PURPOSES.standing }))).status).toBe(400);
    // Signing in another's name: the envelope's agent_id must be the signer's own did:ethr.
    const other = ethers.Wallet.createRandom();
    const _signed_payload = JSON.stringify({ agent_id: `did:ethr:${other.address}`, timestamp: new Date().toISOString(), purpose: PURPOSES.standing });
    const forged = { _signed_payload, _signature: await wallet.signMessage(`sha256:${ethers.sha256(ethers.toUtf8Bytes(_signed_payload)).slice(2)}`) };
    expect((await b.post(PATHS.standing, forged)).status).toBe(401);
    expect((await b.post(PATHS.standing, { ...await signed(wallet, { purpose: PURPOSES.standing }), _session: {} })).status).toBe(400);
  });
});

describe('the statement is an attribution and no authority', () => {
  it('a guest linked to an account is attributed to it, is not it, and is itself again once unlinked', async () => {
    const w = world(), b = await bridge(w.door, { now: w.now }), key = newKey();
    const first = await comeThrough(b, w.id, key);
    expect(first.standing).toMatchObject({ subject: guestDidOf(key), linked: false });
    const owner = w.id.account('u-pk-0123456789ab', 'A Fictional Owner');
    const accountDid = await w.id.linkGuest(key, owner);
    // A statement made before the link says what identity said then; the next visit reads the link.
    expect(await standingOf(b, first.wallet)).toMatchObject({ linked: false });
    const started = w.now(), linked = await comeThrough(b, w.id, key);
    expect(linked.standing).toMatchObject({ guestDid: guestDidOf(key), subject: accountDid, linked: true });
    expect(Date.parse(linked.standing.expiresAt)).toBeLessThanOrEqual(w.now() + LINKED_GUEST_SESSION_MS);
    expect(Date.parse(linked.standing.expiresAt)).toBeGreaterThanOrEqual(started + LINKED_GUEST_SESSION_MS);

    // ★ The caller is the TAB KEY, whoever it is attributed to. Even where the linked account is
    // the tenant's administrator, the key resolves to no role of the account's and the admin
    // gate's policy refuses it, in shadow and enforcing alike.
    const callerDid = `did:ethr:${linked.wallet.address}`;
    const ctx = resolveCallerContext({ callerWebId: callerDid, callerUserId: linked.wallet.address, users: [], adminWebId: accountDid, learningEngineerWebIds: new Set([accountDid]) });
    expect(ctx).toMatchObject({ webId: callerDid, role: 'learner' });
    for (const mode of ['shadow', 'enforce']) {
      expect(mayAdministerTenant(ctx, { point: 'test', mode }), mode).toBe(false);
      expect(mayAdministerTenant(null, { point: 'test', mode }), mode).toBe(false);
    }
    const unlinkedCtx = resolveCallerContext({ callerWebId: `did:ethr:${first.wallet.address}`, callerUserId: first.wallet.address, users: [], adminWebId: accountDid });
    expect(mayAdministerTenant(unlinkedCtx, { point: 'test', mode: 'enforce' })).toBe(false);
    // The session the page builds signs as the tab key too: no account id is anywhere it signs with.
    const session = await connectAsGeneralGuest(POD, linked.wallet, linked.standing, linked.offer.signOutUrl);
    expect(session.webId).toBe(callerDid);
    expect(session.role).toBe('learner');

    // The link is read again no later than ten minutes on: the statement ends at its bound.
    w.advance(LINKED_GUEST_SESSION_MS + 1);
    expect(await standingOf(b, linked.wallet)).toBeNull();
    expect(b.guests!.standingOf(linked.wallet.address)).toBeNull();
    // Unlinked by the owner, the same browser comes back as itself.
    await w.id.unlinkGuest(key, owner);
    const after = await comeThrough(b, w.id, key);
    expect(after.standing).toMatchObject({ guestDid: guestDidOf(key), subject: guestDidOf(key), linked: false });
  });

  it('is bounded by the guest\'s deadline, the tab guest\'s ceiling, and ten minutes when linked', async () => {
    let offset = 0; const now = () => Date.now() + offset;
    let stated: Partial<GeneralGuestSession> & { linkedTo?: string } = {};
    const door = statedDoor(() => stated, now), b = await bridge(door, { now });
    const bound = async () => { const wallet = ethers.Wallet.createRandom(); const answer = await finishWith(b, wallet);
      return { wallet, status: answer.status, until: Date.parse(String((answer.body['generalGuest'] as { expiresAt?: string } | undefined)?.expiresAt)) - now() }; };
    expect((await bound()).until / 1000).toBeCloseTo(DASHBOARD_GUEST_SESSION_MS / 1000, 0);
    stated = { guestExpiresAt: now() + 5 * 60_000 };
    const short = await bound();
    expect(short.until / 1000).toBeCloseTo(300, 0);
    stated = { linkedTo: 'did:web:identity.example:users:u-pk-0123456789ab' };
    expect((await bound()).until / 1000).toBeCloseTo(LINKED_GUEST_SESSION_MS / 1000, 0);
    stated = { linkedTo: 'did:web:identity.example:users:u-pk-0123456789ab', guestExpiresAt: now() + 60_000 };
    expect((await bound()).until / 1000).toBeCloseTo(60, 0);
    // The guest's deadline passes: the statement is gone, whatever ceiling it had.
    offset += 5 * 60_000 + 1;
    expect(b.guests!.standingOf(short.wallet.address)).toBeNull();
    // What identity may not have said: a link to the guest itself, to another authority's subject, a guest already past its deadline.
    for (const refused of [{ linkedTo: 'itself' }, { linkedTo: 'did:web:elsewhere.example:users:u-pk-0123456789ab' }, { linkedTo: 'https://identity.example/users/x' }, { guestExpiresAt: now() - 1 },
      { userId: 'u-try-play-' + '0'.repeat(32) }, { ownerDid: 'did:web:elsewhere.example:users:u-try-guest-' + '0'.repeat(32) }]) {
      stated = refused; const size = b.guests!.size;
      const answer = await bound();
      expect(answer.status, JSON.stringify(refused)).toBe(401);
      expect(b.guests!.size).toBe(size);
    }
  });

  it('is held for a bounded number of keys, swept when over, and dropped on sign-out', async () => {
    let offset = 0; const now = () => Date.now() + offset;
    const door = statedDoor(() => ({ guestExpiresAt: now() + 60 * 60_000 }), now), b = await bridge(door, { now, maxBindings: 2 });
    const [one, two, three] = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
    expect((await finishWith(b, one)).status).toBe(200);
    expect((await finishWith(b, two)).status).toBe(200);
    // Full: a third key is refused BEFORE its code is spent; a key already held may come again.
    const spent = door.finished;
    expect(await finishWith(b, three)).toMatchObject({ status: 429, body: { error: 'general_guest_busy' } });
    expect(door.finished).toBe(spent);
    expect((await finishWith(b, one)).status).toBe(200);
    expect(b.guests!.size).toBe(2);
    // Sign-out drops one at once, and only its own.
    expect(await signOutGeneralGuest({ signOutUrl: BRIDGE + PATHS.signOut }, one.privateKey, b.tab())).toBe(true);
    expect(await standingOf(b, one)).toBeNull();
    expect(await standingOf(b, two)).not.toBeNull();
    expect((await finishWith(b, three)).status).toBe(200);
    // Past their bound they are swept, and there is room again.
    offset += 60 * 60_000 + 1;
    expect(b.guests!.size).toBe(0);
    expect((await finishWith(b, one)).status).toBe(200);
    expect(() => new DashboardGeneralGuest({ door, maxBindings: 0 })).toThrow();
  });
});

describe('the pages', () => {
  const login = read('../dashboard-app/src/components/Login.tsx'), app = read('../dashboard-app/src/App.tsx');

  it('offer the door beside the tab guest, only where the bridge offers it, and clear the return address first', () => {
    expect(login.indexOf('Start as a guest')).toBeLessThan(login.indexOf('Continue as an Interego guest'));
    expect(login).toContain('{general && (');
    // The code and state leave the address in the same step that reads them, before any request.
    expect(login.indexOf("window.history.replaceState(null, '', '/login')")).toBeLessThan(login.indexOf('await generalGuestOffer(BRIDGE_BASE, deps)'));
    expect(app).toContain('<Route path={GENERAL_GUEST_RETURN_PATH} element={<Login onSignIn={onSignIn} />} />');
    expect(app).toContain('void signOutGeneralGuest(session.generalGuest, session.connectedPrivateKey, browserGeneralGuestDeps());');
  });

  it('send the browser nowhere but identity\'s door', async () => {
    const offer: GeneralGuestOffer = { startUrl: BRIDGE + PATHS.start, finishUrl: BRIDGE + PATHS.finish, standingUrl: BRIDGE + PATHS.standing, signOutUrl: BRIDGE + PATHS.signOut,
      returnPath: GENERAL_GUEST_RETURN_PATH, doorOrigin: ISSUER };
    for (const doorUrl of ['https://evil.example/guest/door#grant=x', `${ISSUER}/connect#grant=x`, `${ISSUER}/guest/door?next=https://evil.example#grant=x`, 'javascript:alert(1)']) {
      const kept = new Map<string, string>();
      const deps: GeneralGuestDeps = { store: { getItem: k => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); }, removeItem: k => { kept.delete(k); } },
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ doorUrl, state: 's'.repeat(43), binding: 'b'.repeat(43) }) }) };
      await expect(startGeneralGuest(offer, deps), doorUrl).rejects.toBeInstanceOf(GeneralGuestError);
      expect(kept.size).toBe(0);
    }
    expect(generalGuestReturn({ pathname: '/login', search: '?code=a&state=b' })).toBeNull();
    expect(generalGuestReturn({ pathname: GENERAL_GUEST_RETURN_PATH, search: '?code=a' })).toBeNull();
  });
});
