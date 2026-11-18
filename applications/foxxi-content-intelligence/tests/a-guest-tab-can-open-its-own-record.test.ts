/**
 * Two things the dashboard's general guest door settles when a tab finishes its visit
 * (src/dashboard-general-guest.ts):
 *
 * 1. The tab may hand over an X25519 public key of its own (`record_key`). The guest's sealed
 *    record (src/guest-learning-record.ts) is then sealed for that tab as well as for the bridge,
 *    so the guest's own browser can open its record from its own pod without asking the bridge.
 *
 * 2. Identity states the guest's pod, and the bridge derives it. The two were compared as strings,
 *    which made a visit depend on two services spelling one store identically. They are compared
 *    as URLs now (`statedPodIsOwn`), and the pod that is kept and used is always the derived one.
 *    Identity here is the real provider run in process, so what it states is what production's
 *    code states.
 *
 * Everything here is synthetic.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import type { Request } from 'express';
import { generateKeyPair, openEncryptedEnvelope, type EncryptedEnvelope } from '@interego/core';
import {
  DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE, DASHBOARD_GUEST_KEYS_PER_GUEST, DASHBOARD_GUEST_SESSION_MS,
  DashboardGeneralGuest, DashboardGuestError, statedPodIsOwn, type DashboardGuestDoor, type DashboardGuestPorts,
} from '../src/dashboard-general-guest.js';
import { GUEST_RECORD_PATH, GuestLearningRecordStore, type GuestRecordFetch } from '../src/guest-learning-record.js';
import { GUEST_OPERATION_PURPOSE } from '../src/guest-operations.js';
import { resolveSubjectPodUrlGuarded } from '../src/subject-pod-url.js';
import type { GeneralGuestSession } from '../../_shared/guest-access/door.js';
import { ISSUER, identity, newKey } from '../../_shared/tests/general-guest-identity.js';
import { generalGuestUserId, playKeyThumbprint, publicPlayKey } from '../../../deploy/identity/provisional-play.js';

const DASH = 'https://dashboard.example';
const TENANT = 'https://pods.example/foxxi/';
const NOW = Date.parse('2026-11-18T10:00:00Z');
const SECRET = '5ea1'.repeat(16);
const guestId = (n: number): string => 'u-try-guest-' + n.toString(16).padStart(32, '0');
const guestDid = (id: string): string => `did:web:identity.example:users:${id}`;
const sha256Hex = (s: string): string => ethers.sha256(new TextEncoder().encode(s)).slice(2);

function vouched(id: string, over: Partial<GeneralGuestSession> = {}): GeneralGuestSession {
  const expires = NOW + 6 * 3600_000;
  return {
    userId: id, ownerDid: guestDid(id), webId: `${ISSUER}/users/${id}/profile#me`, podUrl: `https://pods.example/${id}/`,
    agentDid: 'did:web:identity.example:agents:dashboard-guest', namespace: 'play', guestExpiresAt: expires,
    attributes: { subject: guestDid(id), provisional: true, establishedAt: Math.floor(NOW / 1000) - 60, standingUntil: expires / 1000, admittedBy: [DASH] } as GeneralGuestSession['attributes'],
    token: 'not-kept', tokenExpiresAt: new Date(expires).toISOString(), ...over,
  };
}
const request = (body: unknown): Request =>
  ({ body, query: {}, ip: '203.0.113.9', get: (name: string) => (name.toLowerCase() === 'origin' ? DASH : undefined) }) as unknown as Request;
async function signed(key: ethers.HDNodeWallet, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const _signed_payload = JSON.stringify({ agent_id: `did:ethr:${key.address}`, timestamp: new Date().toISOString(), ...fields });
  return { _signed_payload, _signature: await key.signMessage(`sha256:${sha256Hex(_signed_payload)}`) };
}
const refusal = async (work: Promise<unknown>): Promise<{ status: number; code: string }> => {
  try { await work; } catch (error) { if (error instanceof DashboardGuestError) return { status: error.status, code: error.code }; throw error; }
  throw new Error('expected a refusal');
};

/** A bridge: a pod that keeps what it is PUT, the real record store over it, and the real door module over a scripted door. */
function bridge(options: { sameStore?: (a: string, b: string) => boolean } = {}) {
  const docs = new Map<string, string>();
  const fetch: GuestRecordFetch = async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET') { const doc = docs.get(url); return { ok: doc !== undefined, status: doc !== undefined ? 200 : 404, text: async () => doc ?? '' }; }
    docs.set(url, init?.body ?? ''); return { ok: true, status: 201, text: async () => '' };
  };
  let n = 0, visitor = 0;
  const visits = new Map<string, string>(), answers = new Map<string, GeneralGuestSession>();
  const door: DashboardGuestDoor = {
    audience: DASH, identityUrl: ISSUER,
    start: async () => { n += 1; const state = `state-${String(n).padStart(20, '0')}`, binding = String(n).padStart(43, 'b'); visits.set(state, binding); return { url: 'https://door.example/guest/door#grant=g', state, binding }; },
    finish: async ({ state, binding }) => {
      if (typeof state !== 'string' || visits.get(state) !== binding) throw Object.assign(new Error('x'), { status: 401 });
      visits.delete(state); return answers.get(state)!;
    },
  };
  const clock = { now: NOW };
  // Bound once the door exists, as bridge/server.ts binds it.
  let tabKeys: (userId: string) => readonly string[] = () => [];
  const records = new GuestLearningRecordStore({ tenantPodUrl: TENANT, identityHost: 'identity.example', sealSecret: SECRET, fetch, tabKeys: owner => tabKeys(owner.userId), now: () => clock.now });
  const never = async () => { throw new Error('not used here'); };
  const ports: DashboardGuestPorts = {
    'record.read': async principal => { const kept = await records.read(principal.guest); return { ok: true, statements: kept.statements }; },
    'course.resolve': never, 'course.launch': never,
    'course.next': async (principal, args) => ({ ok: true, kept: await records.append(principal.guest, [{ id: String(args['session_id']), result: { response: 'a-heron-stands-in-the-shallows' } }]) }),
  };
  const guests = new DashboardGeneralGuest({
    door, ports, now: () => clock.now, record: records,
    podFor: did => resolveSubjectPodUrlGuarded({ tenantPodUrl: TENANT, identity: did, safeUrl: raw => raw, guestIdentityHost: 'identity.example' }),
    ...(options.sameStore ? { sameStore: options.sameStore } : {}),
  });
  tabKeys = userId => guests.recordKeysOf(userId);
  /** One whole visit by a new tab. `recordKey` is what the tab sends as `record_key`, when it sends one. */
  async function visit(guest: GeneralGuestSession, recordKey?: unknown): Promise<{ key: ethers.HDNodeWallet; answer: Record<string, unknown> }> {
    visitor += 1;
    const started = await guests.start(request({ __client_ip: `198.51.100.${visitor % 250}` })) as { state: string; binding: string };
    answers.set(started.state, guest);
    const key = ethers.Wallet.createRandom();
    const fields = { purpose: DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE, code: 'code-1', state: started.state, binding: started.binding, ...(recordKey !== undefined ? { record_key: recordKey } : {}) };
    return { key, answer: await guests.finish(request(await signed(key, fields))) };
  }
  const act = async (key: ethers.HDNodeWallet, operation: string, args: Record<string, unknown> = {}) =>
    guests.act(request(await signed(key, { purpose: GUEST_OPERATION_PURPOSE, operation, args })));
  return { guests, records, docs, clock, visit, act };
}
const envelopeAt = (docs: Map<string, string>, id: string): EncryptedEnvelope =>
  (JSON.parse(docs.get(`https://pods.example/${id}/${GUEST_RECORD_PATH}`)!) as { envelope: EncryptedEnvelope }).envelope;

describe('a tab hands over a record key when it finishes', () => {
  it('and then opens its own record from its own pod, sealed by the bridge', async () => {
    const b = bridge(), id = guestId(1), tab = generateKeyPair();
    const { key, answer } = await b.visit(vouched(id), tab.publicKey);
    const standing = (answer as { generalGuest: { record: { url: string; sealed: boolean; sealedBy: string; forThisTab: boolean } } }).generalGuest;
    expect(standing.record).toEqual({ url: `https://pods.example/${id}/${GUEST_RECORD_PATH}`, sealed: true, sealedBy: b.records.sealedBy({ userId: id, guestDid: guestDid(id), podUrl: `https://pods.example/${id}/` }), forThisTab: true });
    await b.act(key, 'course.next', { session_id: 'step-1', answers: ['a'] });
    // What the tab does with no help from the bridge: fetch the document, find its wrapped key, check who wrapped it, open it.
    const envelope = envelopeAt(b.docs, id);
    const mine = envelope.wrappedKeys.find(w => w.recipientPublicKey === tab.publicKey)!;
    expect(mine.senderPublicKey).toBe(standing.record.sealedBy);
    expect(openEncryptedEnvelope(envelope, tab)).toContain('a-heron-stands-in-the-shallows');
    expect(b.docs.get(standing.record.url)!.includes('a-heron-stands-in-the-shallows')).toBe(false);
    // The answer holds no secret: the bridge's PUBLIC key for this guest, and nothing of the secret it is derived from.
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect((await b.act(key, 'guest.standing') as { generalGuest: { record: unknown } }).generalGuest.record).toEqual(standing.record);
  });

  it('the record key carries no authority: it signs nothing, and a visit without one is the visit it always was', async () => {
    const b = bridge(), id = guestId(2);
    const { key, answer } = await b.visit(vouched(id));
    expect((answer as { generalGuest: Record<string, unknown> }).generalGuest).toMatchObject({ guestDid: guestDid(id), userId: id, linked: false, expiresAt: new Date(NOW + DASHBOARD_GUEST_SESSION_MS).toISOString(), record: { forThisTab: false } });
    expect(b.guests.recordKeysOf(id)).toEqual([]);
    await b.act(key, 'course.next', { session_id: 'step-1', answers: ['a'] });
    expect(envelopeAt(b.docs, id).wrappedKeys).toHaveLength(1);
    expect(await b.act(key, 'record.read')).toMatchObject({ ok: true, statements: [{ id: 'step-1' }] });
  });

  it('a record key that is not a usable X25519 public key finishes nothing and spends nothing', async () => {
    const b = bridge(), id = guestId(3);
    for (const bad of ['', 'not-a-key', 7, null, Buffer.alloc(32).toString('base64'), generateKeyPair().publicKey + 'AAAA', { key: generateKeyPair().publicKey }]) {
      expect(await refusal(b.visit(vouched(id), bad)), JSON.stringify(bad)).toEqual({ status: 400, code: 'general_guest_input_invalid' });
    }
    expect(b.guests.size).toBe(0);
    // Any other extra field is still refused: the one optional member is `record_key`.
    const started = await b.guests.start(request({ __client_ip: '198.51.100.251' })) as { state: string; binding: string };
    const key = ethers.Wallet.createRandom();
    expect(await refusal(b.guests.finish(request(await signed(key, { purpose: DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE, code: 'c', state: started.state, binding: started.binding, recordKey: generateKeyPair().publicKey })))))
      .toEqual({ status: 400, code: 'general_guest_input_invalid' });
  });

  it('each tab of a guest is sealed for while it is admitted; a signed-out, ended or expired tab and another guest\'s are not', async () => {
    const b = bridge(), id = guestId(4), other = guestId(5);
    const tabs = Array.from({ length: 3 }, () => generateKeyPair());
    const keys = [];
    for (const tab of tabs) keys.push((await b.visit(vouched(id), tab.publicKey)).key);
    const strangerTab = generateKeyPair();
    const stranger = (await b.visit(vouched(other), strangerTab.publicKey)).key;
    expect(b.guests.recordKeysOf(id)).toEqual(tabs.map(t => t.publicKey));
    expect(b.guests.recordKeysOf(other)).toEqual([strangerTab.publicKey]);
    await b.act(keys[0]!, 'course.next', { session_id: 'step-1', answers: ['a'] });
    let envelope = envelopeAt(b.docs, id);
    for (const tab of tabs) expect(openEncryptedEnvelope(envelope, tab)).not.toBeNull();
    expect(openEncryptedEnvelope(envelope, strangerTab)).toBeNull();
    // The second tab signs out; the next write is not sealed for it.
    await b.act(keys[1]!, 'guest.sign_out');
    await b.act(keys[0]!, 'course.next', { session_id: 'step-2', answers: ['a'] });
    envelope = envelopeAt(b.docs, id);
    expect([openEncryptedEnvelope(envelope, tabs[0]!) !== null, openEncryptedEnvelope(envelope, tabs[1]!) !== null, openEncryptedEnvelope(envelope, tabs[2]!) !== null]).toEqual([true, false, true]);
    // The other guest's record is its own, sealed for its own tab and not for these.
    await b.act(stranger, 'course.next', { session_id: 'step-1', answers: ['a'] });
    expect(openEncryptedEnvelope(envelopeAt(b.docs, other), strangerTab)).not.toBeNull();
    expect(openEncryptedEnvelope(envelopeAt(b.docs, other), tabs[0]!)).toBeNull();
    // Past the session's bound nobody is admitted, so no tab is a recipient of anything further.
    b.clock.now = NOW + DASHBOARD_GUEST_SESSION_MS;
    expect(b.guests.recordKeysOf(id)).toEqual([]);
  });

  it('a further tab ends the oldest, and the oldest stops being sealed for', async () => {
    const b = bridge(), id = guestId(6);
    const tabs = Array.from({ length: DASHBOARD_GUEST_KEYS_PER_GUEST + 1 }, () => generateKeyPair());
    for (const tab of tabs) await b.visit(vouched(id), tab.publicKey);
    expect(b.guests.recordKeysOf(id)).toEqual(tabs.slice(1).map(t => t.publicKey));
  });
});

describe('the pod identity states, read as a URL', () => {
  const ID = guestId(9), DERIVED = `https://pods.example/${ID}/`;

  it('the same pod root on the same store is the guest\'s own, however the origin is spelled', () => {
    for (const stated of [DERIVED, `https://PODS.example/${ID}/`, `https://pods.example:443/${ID}/`]) expect(statedPodIsOwn(stated, DERIVED, ID), stated).toBe(true);
  });

  it('anything else is refused, as it always was', () => {
    const refused = [
      TENANT, `https://pods.example/${guestId(10)}/`, `https://pods.elsewhere.example/${ID}/`, `https://pods.example/${ID}`,
      `https://pods.example/${ID}/deeper/`, `https://pods.example/foxxi/../${ID}/`, `https://pods.example/x/../${ID}/`, `https://pods.example//${ID}/`,
      `https://pods.example/${ID}/?as=other`, `https://pods.example/${ID}/#x`, `https://someone@pods.example/${ID}/`, `https://pods.example:8443/${ID}/`,
      `http://pods.example/${ID}/`, `ftp://pods.example/${ID}/`, `https://pods.example/${ID.toUpperCase()}/`, `https://pods.example/%75-try-guest-${ID.slice(12)}/`,
      'not a url', '', undefined, null, 7, { href: DERIVED },
    ];
    for (const stated of refused) expect(statedPodIsOwn(stated, DERIVED, ID), String(stated)).toBe(false);
    // A derived pod that is not this guest's own root, or an id that is not a guest's, matches nothing.
    expect(statedPodIsOwn(TENANT, TENANT, ID)).toBe(false);
    expect(statedPodIsOwn(DERIVED, DERIVED, 'u-pk-0123456789ab')).toBe(false);
  });

  it('another spelling of this deployment\'s own store is the same store only where the bridge says so', () => {
    const internal = `http://store.internal.example:3456/${ID}/`;
    const own = (a: string, b: string): boolean => [a, b].every(u => ['https://pods.example', 'http://store.internal.example:3456'].includes(new URL(u).origin));
    expect(statedPodIsOwn(internal, DERIVED, ID)).toBe(false);
    expect(statedPodIsOwn(internal, DERIVED, ID, own)).toBe(true);
    // The store's other spelling does not loosen the path: still this guest's pod root and nothing else.
    for (const stated of [`http://store.internal.example:3456/foxxi/`, `http://store.internal.example:3456/${guestId(10)}/`, `http://store.internal.example:3456/${ID}/deeper/`, `http://elsewhere.internal.example:3456/${ID}/`]) {
      expect(statedPodIsOwn(stated, DERIVED, ID, own), stated).toBe(false);
    }
    expect(statedPodIsOwn(internal, DERIVED, ID, () => { throw new Error('unreadable'); })).toBe(false);
  });

  it('at the door: a differently spelled origin is admitted on the DERIVED pod; any other pod is still refused', async () => {
    const own = (a: string, b: string): boolean => [a, b].every(u => ['https://pods.example', 'http://store.internal.example:3456'].includes(new URL(u).origin));
    const b = bridge({ sameStore: own });
    let n = 20;
    for (const podUrl of [`https://pods.example:443/${guestId(20)}/`, `http://store.internal.example:3456/${guestId(21)}/`]) {
      const id = guestId(n++);
      const { key, answer } = await b.visit(vouched(id, { podUrl }));
      expect(b.guests.holds(key.address)).toBe(true);
      // What is kept and used is the bridge's own derivation, on the tenant pod's origin, never identity's string.
      expect((answer as { generalGuest: { record: { url: string } } }).generalGuest.record.url).toBe(`https://pods.example/${id}/${GUEST_RECORD_PATH}`);
    }
    for (const podUrl of [TENANT, `https://pods.example/${guestId(30)}/`, `https://pods.elsewhere.example/${guestId(22)}/`, `https://pods.example/${guestId(22)}`, `http://store.internal.example:3456/foxxi/`]) {
      expect(await refusal(b.visit(vouched(guestId(22), { podUrl }))), podUrl).toEqual({ status: 403, code: 'general_guest_pod_refused' });
    }
    // Without the bridge's word, the store's other spelling is another origin.
    expect(await refusal(bridge().visit(vouched(guestId(23), { podUrl: `http://store.internal.example:3456/${guestId(23)}/` })))).toEqual({ status: 403, code: 'general_guest_pod_refused' });
  });

  it('what identity\'s own code states for a general guest is its pod root on its public pod base, which the bridge takes', async () => {
    // The real provider, in process (applications/_shared/tests/general-guest-identity.ts): its
    // public pod base is https://pods.example/, as CSS_PUBLIC_URL is in a deployment.
    const SERVICE = { agentDid: 'did:web:identity.example:agents:dashboard-service', podUrl: 'https://pods.example/dashboard/', returnPath: '/guest/general/return' };
    const id = identity({ [DASH]: SERVICE });
    const door = id.doorFor(DASH, SERVICE), browserKey = newKey();
    const started = await door.start();
    const back = await id.page(browserKey, started.url);
    const guest = await door.finish({ code: back.searchParams.get('code'), state: back.searchParams.get('state'), binding: started.binding });
    const userId = generalGuestUserId(playKeyThumbprint(publicPlayKey(browserKey.publicKey.export({ format: 'jwk' }))));
    expect(guest.userId).toBe(userId);
    expect(guest.podUrl).toBe(`https://pods.example/${userId}/`);
    const derived = resolveSubjectPodUrlGuarded({ tenantPodUrl: TENANT, identity: guest.ownerDid, safeUrl: raw => raw, guestIdentityHost: 'identity.example' });
    expect(statedPodIsOwn(guest.podUrl, derived, userId)).toBe(true);
    // And a bridge whose tenant pod is on another origin than identity's public pod base refuses, as it must.
    const elsewhere = resolveSubjectPodUrlGuarded({ tenantPodUrl: 'https://store.elsewhere.example/foxxi/', identity: guest.ownerDid, safeUrl: raw => raw, guestIdentityHost: 'identity.example' });
    expect(statedPodIsOwn(guest.podUrl, elsewhere, userId)).toBe(false);
  });
});
