/**
 * The general guest door client (applications/_shared/guest-access/door.ts) against identity's real
 * provider run in process (general-guest-identity.ts). The world's own routes for it are covered in
 * shared-world.test.ts, beside the other tests that start a world.
 */
import { describe, expect, it } from 'vitest';
import { GeneralGuestDoor, GuestDoorError } from '../../_shared/guest-access/door.js';
import { ACTIONS, provisionalSubjectPolicies } from '@interego/abac/portable';
import { generalGuestUserId, playKeyThumbprint, publicPlayKey } from '../../../deploy/identity/provisional-play.js';
import { ISSUER, OTHER, RETURN_PATH, WORLD, agent, identity, newKey, otherAgent } from './general-guest-identity.js';

describe('the general guest door client', () => {
  it('finishes only the visit this browser started, once, and answers the guest identity vouches for', async () => {
    const id = identity();
    const door = id.doorFor(WORLD, agent);
    const key = newKey();
    const visit = await door.start();
    const back = await id.page(key, visit.url);
    expect(back.origin + back.pathname).toBe(`${WORLD}${RETURN_PATH}`);
    const returned = { code: back.searchParams.get('code'), state: back.searchParams.get('state'), binding: visit.binding };
    // Another browser (another binding, or none) finishes nothing with this return address, asks
    // identity nothing, and does not end the visit of the browser that started it.
    const stranger = await door.start();
    for (const binding of [stranger.binding, undefined, '', 'x'.repeat(43)]) {
      await expect(door.finish({ ...returned, binding })).rejects.toMatchObject({ status: 401, code: 'guest_door_return_invalid' });
    }
    // Nor does this browser finish a visit it did not start (a return address planted on it).
    const planted = await id.page(newKey(), stranger.url);
    await expect(door.finish({ code: planted.searchParams.get('code'), state: planted.searchParams.get('state'), binding: visit.binding }))
      .rejects.toMatchObject({ status: 401, code: 'guest_door_return_invalid' });
    expect(id.exchanges).toEqual([]);
    const guest = await door.finish(returned);
    const userId = generalGuestUserId(playKeyThumbprint(publicPlayKey(key.publicKey.export({ format: 'jwk' }))));
    expect(guest).toMatchObject({ userId, ownerDid: `did:web:identity.example:users:${userId}`, podUrl: `https://pods.example/${userId}/`,
      agentDid: `did:web:identity.example:agents:mcp-client-${userId}`, namespace: 'hallowmarch' });
    expect(guest.attributes).toMatchObject({ provisional: true, claimed: false, admittedBy: [WORLD] });
    expect(id.exchanges).toHaveLength(1);
    await expect(door.finish(returned)).rejects.toMatchObject({ code: 'guest_door_return_invalid' });
    for (const bad of [{ ...returned, state: undefined }, { ...returned, code: 7 }, { ...returned, binding: '' }, { code: 'x', state: 'unknown', binding: 'y' }]) {
      await expect(door.finish(bad)).rejects.toBeInstanceOf(GuestDoorError);
    }
    expect(id.exchanges).toHaveLength(1);
  });

  it('refuses a code identity refuses, an answer that is not this application\'s, and a guest its policies do not permit', async () => {
    const id = identity();
    const door = id.doorFor(WORLD, agent);
    // A code that another application's visit earned is not exchangeable here.
    const other = id.doorFor(OTHER, otherAgent);
    const key = newKey();
    const theirs = await other.start();
    const theirBack = await id.page(key, theirs.url);
    const mine = await door.start();
    await expect(door.finish({ code: theirBack.searchParams.get('code'), state: mine.state, binding: mine.binding }))
      .rejects.toMatchObject({ status: 401, code: 'guest_door_exchange_refused' });
    // An application whose policies ask for more than the guest has is told no, by default-deny.
    const strict = id.doorFor(WORLD, agent, { policies: provisionalSubjectPolicies({ service: WORLD, provisionalMay: [ACTIONS.useService], acceptedTermsVersion: '2026-01-15' }) });
    const visit = await strict.start();
    const back = await id.page(key, visit.url);
    await expect(strict.finish({ code: back.searchParams.get('code'), state: back.searchParams.get('state'), binding: visit.binding }))
      .rejects.toMatchObject({ status: 403, code: 'guest_access_denied' });
    const claimedOnly = id.doorFor(WORLD, agent, { policies: provisionalSubjectPolicies({ service: WORLD, claimedMay: [ACTIONS.useService] }) });
    const second = await claimedOnly.start();
    const secondBack = await id.page(key, second.url);
    await expect(claimedOnly.finish({ code: secondBack.searchParams.get('code'), state: secondBack.searchParams.get('state'), binding: second.binding }))
      .rejects.toMatchObject({ code: 'guest_access_denied' });
    // Answers that are well-formed JSON but not identity's for this application.
    const good = await (async () => { const v = await door.start(); const b = await id.page(key, v.url);
      return id.general.exchange({ code: b.searchParams.get('code'), codeVerifier: 'x', audience: WORLD, state: v.state }).catch(() => null); })();
    expect(good).toBeNull();
    for (const forged of [{ valid: true }, { valid: true, provisional: true, general: true, issuer: ISSUER, audience: OTHER },
      { valid: true, provisional: true, general: true, issuer: 'https://evil.example', audience: WORLD, userId: `u-try-guest-${'a'.repeat(32)}` }]) {
      const fake = id.doorFor(WORLD, agent, { fetch: async () => ({ ok: true, status: 200, json: async () => forged }) });
      const v = await fake.start();
      await expect(fake.finish({ code: 'c', state: v.state, binding: v.binding })).rejects.toMatchObject({ code: 'guest_door_exchange_refused' });
    }
    const down = id.doorFor(WORLD, agent, { fetch: async () => { throw new Error('no route'); } });
    const v = await down.start();
    await expect(down.finish({ code: 'c', state: v.state, binding: v.binding })).rejects.toMatchObject({ status: 503 });
  });

  it('sends nothing to the door unless the service agent signed exactly what was asked, and bounds the visits it holds', async () => {
    const id = identity();
    const tampered = id.doorFor(WORLD, agent, { signGrant: async request => ({ _signed_payload: JSON.stringify({ ...request, audience: OTHER }), _signature: `0x${'12'.repeat(65)}` }) });
    await expect(tampered.start()).rejects.toMatchObject({ status: 503, code: 'guest_door_unavailable' });
    const failing = id.doorFor(WORLD, agent, { signGrant: async () => { throw new Error('relay down'); } });
    await expect(failing.start()).rejects.toMatchObject({ status: 503 });
    let now = 1_900_000_000_000;
    const small = id.doorFor(WORLD, agent, { maxVisits: 2, now: () => now, signGrant: async request => ({ _signed_payload: JSON.stringify(request), _signature: `0x${'12'.repeat(65)}` }) });
    await small.start(); await small.start();
    await expect(small.start()).rejects.toMatchObject({ status: 429, code: 'guest_door_busy' });
    now += 11 * 60 * 1000;
    await expect(small.start()).resolves.toMatchObject({ state: expect.any(String) });
    expect(() => new GeneralGuestDoor({ identityUrl: 'http://identity.example', audience: WORLD, signGrant: async () => ({ _signed_payload: '', _signature: '' }) })).toThrow(/HTTPS/);
    expect(() => new GeneralGuestDoor({ identityUrl: ISSUER, audience: `${WORLD}/path`, signGrant: async () => ({ _signed_payload: '', _signature: '' }) })).toThrow(/origin/);
  });
});
