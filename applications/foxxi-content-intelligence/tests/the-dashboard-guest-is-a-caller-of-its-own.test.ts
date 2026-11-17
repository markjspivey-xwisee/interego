/**
 * The dashboard's general guest: through identity's door, bound to one tab, and then a caller
 * that is the GUEST (src/dashboard-general-guest.ts).
 *
 * WHY. A dashboard tab holds a key it made. Until now a request that key signed was the key's and
 * nobody else's. This stage admits the key as a guest identity vouched for, so that what it does
 * is the guest's: its principal's subject is the guest's DID and its records are on the guest's
 * own pod. These tests hold the round trip, who is refused at the door (a linked guest, for now),
 * that only the allow-listed operations run, that limits are the guest's and not the tab's, and
 * that a guest the gate says is gone has its session ended.
 *
 * Everything here is synthetic: the door, the guests, the pods and the course names.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import type { Request } from 'express';
import {
  DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE, DASHBOARD_GUEST_KEYS_PER_GUEST, DASHBOARD_GUEST_LIMITS, DASHBOARD_GUEST_SESSION_MS,
  DashboardGeneralGuest, DashboardGuestError, dashboardGeneralGuestOn, dashboardGeneralGuestSettings, dashboardGuestIdentityHost,
  type DashboardGuestDoor, type DashboardGuestPorts,
} from '../src/dashboard-general-guest.js';
import { GuestPodError } from '../src/guest-learning-record.js';
import { GUEST_OPERATION_PURPOSE } from '../src/guest-operations.js';
import type { GuestCallerPrincipal } from '../src/caller-principal.js';
import type { GeneralGuestSession } from '../../_shared/guest-access/door.js';
import { SubjectPodRefusedError, resolveSubjectPodUrlGuarded } from '../src/subject-pod-url.js';

const DASH = 'https://dashboard.example';
const IDENTITY = 'https://identity.example';
const TENANT = 'https://pods.example/foxxi/';
const NOW = Date.parse('2026-11-17T10:00:00Z');
const guestId = (n: number): string => 'u-try-guest-' + n.toString(16).padStart(32, '0');
const guestDid = (id: string): string => `did:web:identity.example:users:${id}`;
const sha256Hex = (s: string): string => ethers.sha256(new TextEncoder().encode(s)).slice(2);

/** What identity answered at the exchange, for an unlinked guest unless `attributes` says otherwise. */
function vouched(id: string, attributes: Record<string, unknown> = {}, over: Partial<GeneralGuestSession> = {}): GeneralGuestSession {
  const expires = NOW + 6 * 3600_000;
  return {
    userId: id, ownerDid: guestDid(id), webId: `${IDENTITY}/users/${id}/profile#me`, podUrl: `https://pods.example/${id}/`,
    agentDid: 'did:web:identity.example:agents:dashboard-guest', namespace: 'play', guestExpiresAt: expires,
    attributes: { subject: guestDid(id), provisional: true, establishedAt: Math.floor(NOW / 1000) - 60, standingUntil: expires / 1000, admittedBy: [DASH], ...attributes } as GeneralGuestSession['attributes'],
    token: 'not-kept', tokenExpiresAt: new Date(expires).toISOString(), ...over,
  };
}

/** A door that hands out visits and answers `finish` with what a test set for the state. */
function door(): DashboardGuestDoor & { answers: Map<string, GeneralGuestSession | { status: number }>; finished: string[] } {
  let n = 0;
  const visits = new Map<string, string>();
  const answers = new Map<string, GeneralGuestSession | { status: number }>();
  const finished: string[] = [];
  return {
    audience: DASH, identityUrl: IDENTITY, answers, finished,
    start: async () => { n += 1; const state = `state-${String(n).padStart(20, '0')}`, binding = String(n).padStart(43, 'b'); visits.set(state, binding); return { url: `https://door.example/guest/door#grant=g${n}`, state, binding }; },
    finish: async ({ code, state, binding }) => {
      if (typeof state !== 'string' || visits.get(state) !== binding) throw Object.assign(new Error('x'), { status: 401, code: 'guest_door_return_invalid' });
      visits.delete(state); finished.push(String(code));
      const answer = answers.get(state);
      if (!answer || 'status' in answer) throw Object.assign(new Error('x'), { status: (answer as { status: number } | undefined)?.status ?? 401 });
      return answer;
    },
  };
}

const request = (body: unknown, origin: string | null = DASH, query: Record<string, unknown> = {}): Request =>
  ({ body, query, ip: '203.0.113.9', get: (name: string) => (name.toLowerCase() === 'origin' ? origin ?? undefined : undefined) }) as unknown as Request;
async function signed(key: ethers.HDNodeWallet | ethers.Wallet, fields: Record<string, unknown>, agentId = `did:ethr:${key.address}`): Promise<Record<string, unknown>> {
  const _signed_payload = JSON.stringify({ agent_id: agentId, timestamp: new Date().toISOString(), ...fields });
  return { _signed_payload, _signature: await key.signMessage(`sha256:${sha256Hex(_signed_payload)}`) };
}
const act = (key: ethers.HDNodeWallet | ethers.Wallet, operation: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  signed(key, { purpose: GUEST_OPERATION_PURPOSE, operation, args, ...extra });
const refusal = async (work: Promise<unknown> | (() => unknown)): Promise<{ status: number; code: string }> => {
  try { await (typeof work === 'function' ? work() : work); } catch (error) { if (error instanceof DashboardGuestError) return { status: error.status, code: error.code }; throw error; }
  throw new Error('expected a refusal');
};

interface World {
  guests: DashboardGeneralGuest; door: ReturnType<typeof door>; clock: { now: number };
  seen: Array<{ operation: string; principal: GuestCallerPrincipal; args: Record<string, unknown> }>;
  fail: { next?: unknown };
}
function world(options: { podFor?: (did: string) => string } = {}): World {
  const d = door(), clock = { now: NOW }, seen: World['seen'] = [], fail: World['fail'] = {};
  const port = (operation: string) => async (principal: GuestCallerPrincipal, args: Record<string, unknown>) => {
    seen.push({ operation, principal, args });
    if (fail.next !== undefined) { const e = fail.next; delete fail.next; throw e; }
    return { ok: true, did: operation };
  };
  const ports: DashboardGuestPorts = { 'record.read': port('record.read'), 'course.resolve': port('course.resolve'), 'course.launch': port('course.launch'), 'course.next': port('course.next') };
  const guests = new DashboardGeneralGuest({
    door: d, ports, now: () => clock.now,
    podFor: options.podFor ?? (did => resolveSubjectPodUrlGuarded({ tenantPodUrl: TENANT, identity: did, safeUrl: raw => raw, guestIdentityHost: 'identity.example' })),
  });
  return { guests, door: d, clock, seen, fail };
}
let visitor = 0;
/** One whole visit: start (each from its own address), the door, finish with a new tab key. */
async function admitted(w: World, id: string, guest: GeneralGuestSession = vouched(id)): Promise<ethers.HDNodeWallet> {
  visitor += 1;
  const visit = await w.guests.start(request({ __client_ip: `198.51.100.${visitor % 250}` })) as { state: string; binding: string };
  w.door.answers.set(visit.state, guest);
  const key = ethers.Wallet.createRandom();
  await w.guests.finish(request(await signed(key, { purpose: DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE, code: 'code-1', state: visit.state, binding: visit.binding })));
  return key;
}

describe('the switch', () => {
  const play = { servicePrivateKey: '0x' + '11'.repeat(32), audience: DASH, identityUrl: IDENTITY, relayUrl: 'https://relay.example' } as never;

  it('is off unless FOXXI_PLAY_GENERAL_GUEST is exactly 1', () => {
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', 'on']) {
      const env = { FOXXI_PLAY_GENERAL_GUEST: value };
      expect(dashboardGeneralGuestOn(env), String(value)).toBe(false);
      expect(dashboardGeneralGuestSettings(env, play), String(value)).toBeNull();
      // Off, the pod resolver is given no identity host: it answers as it always has.
      expect(dashboardGuestIdentityHost({ ...env, INTEREGO_IDENTITY_URL: IDENTITY }), String(value)).toBeUndefined();
    }
  });

  it('on, it is the dashboard\'s own application to identity, and names the identity host', () => {
    const env = { FOXXI_PLAY_GENERAL_GUEST: '1', INTEREGO_IDENTITY_URL: IDENTITY };
    expect(dashboardGeneralGuestSettings(env, play)).toEqual({ audience: DASH, identityUrl: IDENTITY });
    expect(dashboardGuestIdentityHost(env)).toBe('identity.example');
    expect(dashboardGeneralGuestSettings({ ...env, FOXXI_PLAY_GENERAL_GUEST_DOOR_ORIGIN: 'https://door.example' }, play)).toMatchObject({ doorOrigin: 'https://door.example' });
  });

  it('on without the dashboard\'s service account, or with an unusable door origin, the bridge does not start', () => {
    expect(() => dashboardGeneralGuestSettings({ FOXXI_PLAY_GENERAL_GUEST: '1' }, null)).toThrow(/FOXXI_PLAY_SERVICE_PRIVATE_KEY/);
    for (const bad of ['door.example', 'http://door.example', 'https://door.example/path', DASH]) {
      expect(() => dashboardGeneralGuestSettings({ FOXXI_PLAY_GENERAL_GUEST: '1', FOXXI_PLAY_GENERAL_GUEST_DOOR_ORIGIN: bad }, play), bad).toThrow();
    }
  });
});

describe('the door round trip', () => {
  it('start answers only the dashboard\'s own page, with a door address and a binding', async () => {
    const w = world();
    expect(await w.guests.start(request({ __client_ip: '203.0.113.9' }))).toMatchObject({ doorUrl: expect.stringContaining('https://door.example/guest/door#grant='), returnPath: '/guest/general/return' });
    expect(await refusal(w.guests.start(request({}, 'https://elsewhere.example')))).toEqual({ status: 403, code: 'general_guest_origin' });
    expect(await refusal(w.guests.start(request({}, null)))).toEqual({ status: 403, code: 'general_guest_origin' });
    expect(await refusal(w.guests.start(request({ acting_as: 'someone' })))).toEqual({ status: 400, code: 'general_guest_input_invalid' });
  });

  it('starts are limited by address', async () => {
    const w = world();
    for (let i = 0; i < 5; i++) await w.guests.start(request({}));
    expect(await refusal(w.guests.start(request({})))).toEqual({ status: 429, code: 'general_guest_busy' });
  });

  it('finish admits the tab key as the guest identity vouched for, on the guest\'s own pod, for an hour at most', async () => {
    const w = world(), id = guestId(1);
    const visit = await w.guests.start(request({})) as { state: string; binding: string };
    w.door.answers.set(visit.state, vouched(id));
    const key = ethers.Wallet.createRandom();
    const answer = await w.guests.finish(request(await signed(key, { purpose: DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE, code: 'code-1', state: visit.state, binding: visit.binding })));
    expect(answer).toEqual({ generalGuest: { guestDid: guestDid(id), userId: id, linked: false, expiresAt: new Date(NOW + DASHBOARD_GUEST_SESSION_MS).toISOString() } });
    expect(JSON.stringify(answer)).not.toContain('not-kept');
    expect(w.guests.holds(key.address)).toBe(true);
    expect(w.guests.holds(ethers.Wallet.createRandom().address)).toBe(false);
    w.clock.now = NOW + DASHBOARD_GUEST_SESSION_MS;
    expect(w.guests.holds(key.address)).toBe(false);
  });

  it('a return without the binding its visit was started with finishes nothing and spends nothing', async () => {
    const w = world(), id = guestId(2);
    const visit = await w.guests.start(request({})) as { state: string; binding: string };
    w.door.answers.set(visit.state, vouched(id));
    const stranger = ethers.Wallet.createRandom();
    expect(await refusal(w.guests.finish(request(await signed(stranger, { purpose: DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE, code: 'code-1', state: visit.state, binding: 'x'.repeat(43) })))))
      .toEqual({ status: 401, code: 'general_guest_return_invalid' });
    expect(w.guests.holds(stranger.address)).toBe(false);
    // The tab that started it still can.
    const key = ethers.Wallet.createRandom();
    await w.guests.finish(request(await signed(key, { purpose: DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE, code: 'code-1', state: visit.state, binding: visit.binding })));
    expect(w.guests.holds(key.address)).toBe(true);
  });

  it('finish takes only a tab key signing as itself, for this purpose, with exactly these fields', async () => {
    const w = world(), key = ethers.Wallet.createRandom();
    const fields = { purpose: DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE, code: 'c', state: 's'.repeat(24), binding: 'b'.repeat(43) };
    expect(await refusal(w.guests.finish(request({})))).toEqual({ status: 401, code: 'general_guest_signature_required' });
    expect(await refusal(w.guests.finish(request(await signed(key, fields, 'https://relay.example/agents/helper-u-eth-1234'))))).toEqual({ status: 401, code: 'general_guest_signature_required' });
    expect(await refusal(w.guests.finish(request(await signed(key, fields, guestDid(guestId(3))))))).toEqual({ status: 401, code: 'general_guest_signature_required' });
    expect(await refusal(w.guests.finish(request({ ...await signed(key, fields), _session: { key: key.address } })))).toEqual({ status: 400, code: 'general_guest_input_invalid' });
    expect(await refusal(w.guests.finish(request(await signed(key, { ...fields, purpose: GUEST_OPERATION_PURPOSE }))))).toEqual({ status: 400, code: 'general_guest_input_invalid' });
    expect(await refusal(w.guests.finish(request(await signed(key, { ...fields, acting_as: guestDid(guestId(3)) }))))).toEqual({ status: 400, code: 'general_guest_input_invalid' });
    expect(await refusal(w.guests.finish(request(await signed(key, fields), 'https://elsewhere.example')))).toEqual({ status: 403, code: 'general_guest_origin' });
    expect(w.door.finished).toEqual([]);
  });

  it('what identity did not confirm, or the door\'s policy did not permit, admits nobody', async () => {
    const w = world();
    for (const [status, expected] of [[401, { status: 401, code: 'general_guest_return_invalid' }], [403, { status: 403, code: 'general_guest_refused' }], [503, { status: 503, code: 'general_guest_unavailable' }]] as const) {
      const visit = await w.guests.start(request({})) as { state: string; binding: string };
      w.door.answers.set(visit.state, { status });
      const key = ethers.Wallet.createRandom();
      expect(await refusal(w.guests.finish(request(await signed(key, { purpose: DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE, code: 'c', state: visit.state, binding: visit.binding }))))).toEqual(expected);
      expect(w.guests.holds(key.address)).toBe(false);
    }
  });
});

describe('who is refused at the door', () => {
  async function finishWith(w: World, guest: GeneralGuestSession): Promise<{ key: ethers.HDNodeWallet; refused: { status: number; code: string } }> {
    const visit = await w.guests.start(request({ __client_ip: `198.51.100.${Math.floor(Math.random() * 250)}` })) as { state: string; binding: string };
    w.door.answers.set(visit.state, guest);
    const key = ethers.Wallet.createRandom();
    const refused = await refusal(w.guests.finish(request(await signed(key, { purpose: DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE, code: 'c', state: visit.state, binding: visit.binding }))));
    return { key, refused };
  }

  it('a guest linked to an account: not yet, whatever the link names', async () => {
    const w = world(), id = guestId(4);
    for (const linkedTo of ['did:web:identity.example:users:u-pk-0123456789ab', guestDid(id), guestDid(guestId(5)), '', 0, false, {}]) {
      const { key, refused } = await finishWith(w, vouched(id, { linkedTo }));
      expect(refused, JSON.stringify(linkedTo)).toEqual({ status: 403, code: 'general_guest_linked_refused' });
      expect(w.guests.holds(key.address)).toBe(false);
    }
  });

  it('a guest stated to act on another\'s behalf', async () => {
    const w = world();
    const { key, refused } = await finishWith(w, vouched(guestId(6), { onBehalfOf: 'did:web:identity.example:users:u-pk-0123456789ab' }));
    expect(refused).toEqual({ status: 403, code: 'general_guest_delegation_refused' });
    expect(w.guests.holds(key.address)).toBe(false);
  });

  it('an answer that is not a guest of this identity', async () => {
    const w = world(), id = guestId(7);
    for (const guest of [
      vouched(id, {}, { userId: 'u-pk-0123456789ab' }),
      vouched(id, {}, { ownerDid: `did:web:identity.elsewhere.example:users:${id}` }),
      vouched(id, {}, { ownerDid: guestDid(guestId(8)) }),
      vouched(id, { subject: guestDid(guestId(8)) }),
      vouched(id, {}, { guestExpiresAt: NOW - 1 }),
    ]) {
      const { key, refused } = await finishWith(w, guest);
      expect(refused).toEqual({ status: 401, code: 'general_guest_return_invalid' });
      expect(w.guests.holds(key.address)).toBe(false);
    }
  });

  it('a guest whose pod is not its own: the tenant pod, another guest\'s, another origin', async () => {
    const w = world(), id = guestId(9);
    for (const podUrl of [TENANT, `https://pods.example/${guestId(10)}/`, `https://pods.elsewhere.example/${id}/`, `https://pods.example/${id}`]) {
      const { key, refused } = await finishWith(w, vouched(id, {}, { podUrl }));
      expect(refused, podUrl).toEqual({ status: 403, code: 'general_guest_pod_refused' });
      expect(w.guests.holds(key.address)).toBe(false);
    }
  });

  it('a guest the pod resolver would put on the tenant pod, or refuses', async () => {
    for (const podFor of [() => TENANT, () => { throw new SubjectPodRefusedError('shared-tenant-pod', 'x'); }]) {
      const w = world({ podFor });
      const { key, refused } = await finishWith(w, vouched(guestId(11)));
      expect(refused).toEqual({ status: 403, code: 'general_guest_pod_refused' });
      expect(w.guests.holds(key.address)).toBe(false);
    }
  });
});

describe('the guest as a caller', () => {
  it('an allowed operation runs as the GUEST: its DID, its own pod, and nothing from the request', async () => {
    const w = world(), id = guestId(20), key = await admitted(w, id);
    expect(await w.guests.act(request(await act(key, 'course.launch', { composition: 'urn:example:composition:tide-tables' })))).toEqual({ ok: true, did: 'course.launch' });
    expect(w.seen).toHaveLength(1);
    expect(w.seen[0]!.args).toEqual({ composition: 'urn:example:composition:tide-tables' });
    expect(w.seen[0]!.principal).toMatchObject({
      subject: guestDid(id), key: key.address.toLowerCase(), authMode: 'general-guest', kind: 'human',
      guest: { userId: id, guestDid: guestDid(id), podUrl: `https://pods.example/${id}/` },
    });
    expect(w.seen[0]!.principal.guest.podUrl).not.toBe(TENANT);
  });

  it('standing and sign-out are answered here; a signed-out key is nobody', async () => {
    const w = world(), id = guestId(21), key = await admitted(w, id);
    expect(await w.guests.act(request(await act(key, 'guest.standing')))).toMatchObject({ generalGuest: { guestDid: guestDid(id), linked: false } });
    expect(await w.guests.act(request(await act(key, 'guest.sign_out')))).toEqual({ signed_out: true });
    expect(w.guests.holds(key.address)).toBe(false);
    expect(await refusal(w.guests.act(request(await act(key, 'record.read'))))).toEqual({ status: 401, code: 'general_guest_not_admitted' });
    expect(w.seen).toEqual([]);
  });

  it('a key that never came through the door is not a guest, whatever it signs', async () => {
    const w = world();
    await admitted(w, guestId(22));
    const stranger = ethers.Wallet.createRandom();
    expect(await refusal(w.guests.act(request(await act(stranger, 'record.read'))))).toEqual({ status: 401, code: 'general_guest_not_admitted' });
    expect(await refusal(w.guests.act(request(await signed(stranger, { purpose: GUEST_OPERATION_PURPOSE, operation: 'record.read', args: {} }, guestDid(guestId(22))))))).toEqual({ status: 401, code: 'general_guest_signature_required' });
    expect(await refusal(w.guests.act(request({})))).toEqual({ status: 401, code: 'general_guest_signature_required' });
    expect(await refusal(w.guests.act(request({ operation: 'record.read', args: {} })))).toEqual({ status: 400, code: 'general_guest_input_invalid' });
    expect(w.seen).toEqual([]);
  });

  it('everything not on the list is refused and nothing runs', async () => {
    const w = world(), key = await admitted(w, guestId(23));
    for (const operation of ['foxxi.bootstrap_tenant', 'foxxi.assign_audience', 'foxxi.ingest_content_package', '/agent/void-credential', '/agent/mesh/enrolment', 'record.delete', 'directory.read', 'tenant.admin']) {
      expect(await refusal(w.guests.act(request(await act(key, operation)))), operation).toEqual({ status: 403, code: 'general_guest_operation_refused' });
    }
    expect(w.seen).toEqual([]);
  });

  it('a delegation claim from a guest fails closed and nothing runs', async () => {
    const w = world(), id = guestId(24), key = await admitted(w, id);
    const claim = { status: 403, code: 'general_guest_delegation_refused' };
    expect(await refusal(w.guests.act(request(await act(key, 'record.read', { acting_as: 'did:web:identity.example:users:u-pk-0123456789ab' }))))).toEqual(claim);
    expect(await refusal(w.guests.act(request(await act(key, 'record.read', { subject_pod_url: TENANT }))))).toEqual(claim);
    expect(await refusal(w.guests.act(request(await act(key, 'course.next', { session_id: 's', answers: [], learner_did: guestDid(id) }))))).toEqual(claim);
    expect(await refusal(w.guests.act(request(await act(key, 'record.read', {}, { on_behalf_of: guestDid(guestId(25)) }))))).toEqual(claim);
    // A session key beside the envelope is not read as one: the request is refused whole.
    expect(await refusal(w.guests.act(request({ ...await act(key, 'record.read'), _session: { actor: key.address } })))).toEqual({ status: 400, code: 'general_guest_input_invalid' });
    expect(w.seen).toEqual([]);
  });

  it('a signature made to finish a visit is no use at the guest route, and the reverse', async () => {
    const w = world(), key = await admitted(w, guestId(26));
    expect(await refusal(w.guests.act(request(await signed(key, { purpose: DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE, operation: 'record.read', args: {} }))))).toEqual({ status: 400, code: 'general_guest_input_invalid' });
    expect(await refusal(w.guests.act(request(await signed(key, { operation: 'record.read', args: {} }))))).toEqual({ status: 400, code: 'general_guest_input_invalid' });
    expect(await refusal(w.guests.act(request(await act(key, 'record.read'), 'https://elsewhere.example')))).toEqual({ status: 403, code: 'general_guest_origin' });
    expect(w.seen).toEqual([]);
  });
});

describe('limits are the guest\'s', () => {
  it('operations are counted per guest across its tabs, and another guest is not held up', async () => {
    const w = world(), id = guestId(30);
    const first = await admitted(w, id), second = await admitted(w, id);
    for (let i = 0; i < DASHBOARD_GUEST_LIMITS.operations; i++) await w.guests.act(request(await act(i % 2 ? first : second, 'guest.standing')));
    expect(await refusal(w.guests.act(request(await act(first, 'guest.standing'))))).toEqual({ status: 429, code: 'general_guest_busy' });
    expect(await refusal(w.guests.act(request(await act(second, 'record.read'))))).toEqual({ status: 429, code: 'general_guest_busy' });
    const other = await admitted(w, guestId(31));
    expect(await w.guests.act(request(await act(other, 'record.read')))).toEqual({ ok: true, did: 'record.read' });
    // A minute later the guest may ask again.
    w.clock.now += 60_000;
    expect(await w.guests.act(request(await act(first, 'record.read')))).toEqual({ ok: true, did: 'record.read' });
  }, 60_000);

  it('writes have a smaller allowance of their own', async () => {
    const w = world(), key = await admitted(w, guestId(32));
    for (let i = 0; i < DASHBOARD_GUEST_LIMITS.writes; i++) await w.guests.act(request(await act(key, 'course.next', { session_id: 's-1', answers: ['a'] })));
    expect(await refusal(w.guests.act(request(await act(key, 'course.next', { session_id: 's-1', answers: ['a'] }))))).toEqual({ status: 429, code: 'general_guest_busy' });
    expect(await w.guests.act(request(await act(key, 'record.read')))).toEqual({ ok: true, did: 'record.read' });
    expect(w.seen.filter(s => s.operation === 'course.next')).toHaveLength(DASHBOARD_GUEST_LIMITS.writes);
  });

  it('one guest holds a few tabs; a further one ends the oldest', async () => {
    const w = world(), id = guestId(33), keys: ethers.HDNodeWallet[] = [];
    for (let i = 0; i < DASHBOARD_GUEST_KEYS_PER_GUEST + 1; i++) { keys.push(await admitted(w, id)); w.clock.now += 61_000; }
    expect(keys.map(k => w.guests.holds(k.address))).toEqual([false, true, true, true, true]);
    expect(w.guests.size).toBe(DASHBOARD_GUEST_KEYS_PER_GUEST);
  });

  it('finishing is limited per guest', async () => {
    const w = world(), id = guestId(34);
    for (let i = 0; i < DASHBOARD_GUEST_LIMITS.finishes; i++) await admitted(w, id);
    w.clock.now += 1; // the same minute
    await expect(admitted(w, id)).rejects.toMatchObject({ status: 429, code: 'general_guest_busy' });
  });
});

describe('a guest the gate says is gone', () => {
  it('410 ends every session of that guest at once, and it is not admitted again', async () => {
    const w = world(), id = guestId(40);
    const first = await admitted(w, id), second = await admitted(w, id), other = await admitted(w, guestId(41));
    w.fail.next = new GuestPodError(410, 'general_guest_gone');
    expect(await refusal(w.guests.act(request(await act(first, 'course.next', { session_id: 's-1', answers: ['a'] }))))).toEqual({ status: 410, code: 'general_guest_gone' });
    // The write was tried once and not again.
    expect(w.seen.filter(s => s.operation === 'course.next')).toHaveLength(1);
    expect([w.guests.holds(first.address), w.guests.holds(second.address), w.guests.holds(other.address)]).toEqual([false, false, true]);
    expect(await refusal(w.guests.act(request(await act(second, 'record.read'))))).toEqual({ status: 401, code: 'general_guest_not_admitted' });
    await expect(admitted(w, id)).rejects.toMatchObject({ status: 410, code: 'general_guest_gone' });
  });

  it('the gate\'s other refusals are answered as they are and end nothing', async () => {
    const w = world(), key = await admitted(w, guestId(42));
    for (const error of [new GuestPodError(409, 'general_guest_pod_not_open'), new GuestPodError(503, 'general_guest_pod_unavailable'), new GuestPodError(507, 'general_guest_storage_full')]) {
      w.fail.next = error;
      expect(await refusal(w.guests.act(request(await act(key, 'course.next', { session_id: 's-1', answers: ['a'] }))))).toEqual({ status: error.status, code: error.code });
      expect(w.guests.holds(key.address)).toBe(true);
    }
  });
});
