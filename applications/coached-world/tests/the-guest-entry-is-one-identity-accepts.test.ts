/**
 * tools/coached-world-guest-provision.mjs writes identity's PROVISIONAL_PLAY_CLIENTS, and a value
 * identity cannot parse stops it at start. The tool mirrors identity's rules so it can refuse on
 * the runner; this holds the mirror to the real ones (deploy/identity/provisional-play.ts,
 * provisional-general-guest-routes.ts), so a rule added there and not here fails a test instead of
 * a deploy. The tool's own behaviour is tests/coached-world-guest-provision.test.mjs.
 *
 * Every origin, agent and pod here is made up.
 */
import { describe, expect, it } from 'vitest';
import { parsePlayClients, isGuestReturnPath as identityReturnPath } from '../../../deploy/identity/provisional-play.js';
import { parseDoorOrigin } from '../../../deploy/identity/provisional-general-guest-routes.js';
import {
  IDENTITY_URL, NAMESPACE, RETURN_PATH, WORLD_ORIGIN, checkDoorOrigin, checkPlayClients, isGuestReturnPath, mergePlayClients,
} from '../../../tools/coached-world-guest-provision.mjs';

const SERVICE = { agentDid: 'did:web:identity.example:agents:mcp-client-u-eth-0a1b2c3d4e5f', podUrl: 'https://pods.example/u-eth-0a1b2c3d4e5f/', maxPods: 25 };
const OTHER = { agentDid: 'did:web:identity.example:agents:lanternfall-service', podUrl: 'https://pods.example/lanternfall/' };
const accepts = (f: () => unknown): boolean => { try { f(); return true; } catch { return false; } };

describe('the value the provisioning tool writes to identity', () => {
  it('is accepted by identity\'s own parser, with the other applications as they were', () => {
    const lists: Array<Record<string, unknown> | undefined> = [
      undefined,
      { 'https://lanternfall.example': OTHER },
      { 'https://lanternfall.example': { ...OTHER, namespace: 'lanternfall', maxPods: 40, generalGuest: true, generalGuestReturnPath: '/guest/return' },
        'http://localhost:6191': { ...OTHER, generalGuest: false } },
      { [WORLD_ORIGIN]: { ...OTHER, maxPods: 3 }, 'https://lanternfall.example': OTHER },
    ];
    for (const list of lists) {
      const raw = list && JSON.stringify(list);
      const before = parsePlayClients(raw);
      const after = parsePlayClients(mergePlayClients(raw, SERVICE).value);
      expect(after.get(WORLD_ORIGIN)).toEqual({ ...SERVICE, namespace: NAMESPACE, generalGuest: true, generalGuestReturnPath: RETURN_PATH });
      for (const [origin, client] of before) if (origin !== WORLD_ORIGIN) expect(after.get(origin)).toEqual(client);
      expect([...after.keys()].sort()).toEqual([...new Set([...before.keys(), WORLD_ORIGIN])].sort());
    }
    expect(identityReturnPath(RETURN_PATH)).toBe(true);
  });

  it('is refused by the tool exactly where identity would refuse it', () => {
    const entry = (over: Record<string, unknown>, origin = 'https://lanternfall.example') => JSON.stringify({ [origin]: { ...OTHER, ...over } });
    const cases = [
      '', '{}', '[]', 'null', '7', '"text"', '{"https://lanternfall.example":', entry({}), entry({}, 'https://lanternfall.example/'),
      entry({}, 'http://lanternfall.example'), entry({}, 'http://localhost:6191'), entry({}, 'http://127.0.0.1:6191'), entry({}, 'not a url'),
      entry({}, `https://${'a'.repeat(250)}.example`), JSON.stringify({ 'https://lanternfall.example': null }), JSON.stringify({ 'https://lanternfall.example': 'text' }),
      entry({ agentDid: 'did:key:z6Mkfixture' }), entry({ agentDid: 'did:web:identity.example:agents:bad name' }), entry({ agentDid: 7 }),
      entry({ podUrl: 'https://pods.example/lanternfall' }), entry({ podUrl: 'http://pods.example/lanternfall/' }), entry({ podUrl: 'https://pods.example/l/?q=1' }),
      entry({ podUrl: 'https://pods.example/l/#f' }), entry({ podUrl: 'https://user@pods.example/l/' }), entry({ podUrl: 'pods' }), entry({ podUrl: undefined }),
      entry({ namespace: 'lanternfall' }), entry({ namespace: 'hallowmarch' }), entry({ namespace: 'agents' }), entry({ namespace: 'X' }), entry({ namespace: 'a' }), entry({ namespace: 7 }),
      entry({ maxPods: 1 }), entry({ maxPods: 1000 }), entry({ maxPods: 0 }), entry({ maxPods: 1001 }), entry({ maxPods: 2.5 }), entry({ maxPods: '25' }),
      entry({ generalGuest: false }), entry({ generalGuest: 'yes' }), entry({ generalGuest: true }), entry({ generalGuest: true, generalGuestReturnPath: '/guest/return' }),
      entry({ generalGuest: true, generalGuestReturnPath: 'guest' }), entry({ generalGuest: true, generalGuestReturnPath: '/a//b' }),
      entry({ generalGuest: true, generalGuestReturnPath: '/a/../b' }), entry({ generalGuest: true, generalGuestReturnPath: '/a?b=1' }),
      entry({ generalGuest: false, generalGuestReturnPath: 'ignored' }),
    ];
    for (const raw of cases) expect([raw, accepts(() => checkPlayClients(raw))]).toEqual([raw, accepts(() => parsePlayClients(raw))]);
    for (const path of ['/', '/play/general/return', 'play', '/a//b', '/a/..', '/a b', `/${'a'.repeat(127)}`, `/${'a'.repeat(128)}`, 7, undefined]) {
      expect([path, isGuestReturnPath(path)]).toEqual([path, identityReturnPath(path)]);
    }
  });

  it('takes a door origin only where identity would, and never a plain-http one', () => {
    for (const value of ['https://door.example', 'https://door.example/', 'https://door.example/guest', 'door', IDENTITY_URL, 'https://door.example:8443', 'ftp://door.example']) {
      expect([value, accepts(() => checkDoorOrigin(value))]).toEqual([value, accepts(() => parseDoorOrigin(value, IDENTITY_URL))]);
    }
    // Identity allows loopback http for its own tests. A production door does not.
    expect(accepts(() => parseDoorOrigin('http://localhost:6191', IDENTITY_URL))).toBe(true);
    expect(accepts(() => checkDoorOrigin('http://localhost:6191'))).toBe(false);
  });
});
