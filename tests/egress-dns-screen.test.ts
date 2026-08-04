/**
 * The relay's SSRF screen, on both axes: the NAME it is handed, and the ADDRESS it dials.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * `assertPublicPodUrl` had no test at all, and it accepted EVERY IPv6 literal.
 * `URL.hostname` returns the WHATWG-normalised host, and for an IPv6 literal the SQUARE
 * BRACKETS ARE PART OF THAT STRING — `new URL('https://[fd00::1]/').hostname` is
 * `'[fd00::1]'`. Every private-IPv6 regex in `url-rewrite.ts` is `^`-anchored, so the
 * leading `[` made all of them unmatchable: `::1`, `::`, `fd00::1`, `fe80::1` and
 * `::ffff:127.0.0.1` all passed the screen. Separately, the `::ffff:<dotted quad>` branch
 * was DEAD CODE, because `URL.hostname` compresses a v4-mapped literal into hextets —
 * `https://[::ffff:169.254.169.254]/` arrives as `[::ffff:a9fe:a9fe]` — so the IPv4
 * blocklist, the only list that knows about IMDS and RFC1918, was unreachable by that
 * spelling.
 *
 * And the docstring's mitigation was a promise about something outside the repo: it said
 * an attacker "can still RACE a hostname's A-record", and pointed at "the deployment's
 * egress firewall". No race is required — a name is not an address, and a static
 * publicly-resolvable name that simply IS an A record for private space (nip.io,
 * localtest.me) defeats a syntactic check outright. `screeningEgressLookup` is the
 * in-tree half: undici's connect-time resolver, so the address screened is the address
 * dialled and there is no window between them.
 *
 * ── WHERE THESE ASSERTIONS LIVE ──────────────────────────────────────────────
 *
 * `assertPublicPodUrl`'s address-screen corpus is here rather than in
 * `tests/url-rewrite.test.ts` (which covers `normalizeCssUrl`) so that one file owns the
 * whole SSRF screen — the syntactic half and the resolved half — and a reviewer reading
 * either half sees the other.
 */
import { describe, it, expect } from 'vitest';
import { Agent } from 'undici';
import {
  assertPublicPodUrl,
  bareAddressHost,
  privateAddressReason,
  screeningEgressLookup,
} from '../deploy/mcp-relay/url-rewrite.js';

describe('assertPublicPodUrl — address screen', () => {
  // Every one of these was measured ACCEPTED before the fix.
  const REJECT = [
    'https://[::1]/', 'https://[::]/', 'https://[fd00::1]/', 'https://[fc00::dead]/',
    'https://[fe80::1]/', 'https://[feb0::1]/',
    // ★ v4-mapped, in the spelling `URL.hostname` actually produces (hextets).
    'https://[::ffff:127.0.0.1]/', 'https://[::ffff:169.254.169.254]/',
    'https://[::ffff:10.0.0.5]/', 'https://[::ffff:192.168.1.1]/',
    'https://[::ffff:172.16.0.1]/', 'https://[::ffff:100.64.0.1]/',
    'https://[::169.254.169.254]/',
    // The IPv4 literals, which DID work before — kept so a regression in the
    // rewrite of the screen is caught too.
    'https://169.254.169.254/', 'https://10.0.0.5/', 'https://127.0.0.1/',
    'https://192.168.1.1/', 'https://0.0.0.0/', 'https://100.64.0.1/',
  ];
  for (const u of REJECT) {
    it(`rejects ${u}`, () => { expect(() => assertPublicPodUrl(u)).toThrow(); });
  }

  // The honest-data direction. A screen that over-rejects takes the relay off the
  // federation it exists to reach, which is the more expensive failure of the two.
  const ACCEPT = [
    'https://example.com/', 'https://[2001:db8::1]/', 'https://[2606:4700:4700::1111]/',
    'https://8.8.8.8/',
    // Boundary cases either side of RFC1918 / CGNAT — a sloppier regex eats these.
    'https://172.15.0.1/', 'https://172.32.0.1/', 'https://100.128.0.1/',
    'https://relay.interego.xwisee.com/mcp',
  ];
  for (const u of ACCEPT) {
    it(`accepts ${u}`, () => { expect(() => assertPublicPodUrl(u)).not.toThrow(); });
  }

  // A zone id cannot reach the guard at all: `new URL` throws ERR_INVALID_URL on
  // `https://[fe80::1%25eth0]/`. Recorded so nobody adds a case that can never run.
  it('a zone-id literal is refused by URL parsing before the screen is reached', () => {
    expect(() => new URL('https://[fe80::1%25eth0]/')).toThrow();
  });

  it('bareAddressHost strips the brackets URL.hostname adds', () => {
    expect(bareAddressHost(new URL('https://[fd00::1]/').hostname)).toBe('fd00::1');
  });

  it('privateAddressReason decodes a v4-mapped address in the hextet spelling', () => {
    // This is the assertion the dead `::ffff:<dotted>` branch could never make.
    expect(new URL('https://[::ffff:169.254.169.254]/').hostname).toBe('[::ffff:a9fe:a9fe]');
    expect(privateAddressReason('[::ffff:a9fe:a9fe]')).toMatch(/169\.254\.169\.254/);
  });
});

describe('screeningEgressLookup — the resolved half', () => {
  // `localhost` is a NAME, not a literal, so it goes through the OS resolver with no
  // network — offline-safe in CI while still exercising the real `node:dns`.
  it('refuses a hostname that resolves to a private address', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>(resolve => {
      screeningEgressLookup('localhost', {}, e => resolve(e));
    });
    expect(err).toBeTruthy();
    expect(err!.code).toBe('ERR_EGRESS_PRIVATE_ADDRESS');
  });

  it('blocks at CONNECT when handed to undici, not merely in a pre-check', async () => {
    const agent = new Agent({ connect: { lookup: screeningEgressLookup as never } });
    let message = '';
    try {
      // NOT a low port: fetch rejects the WHATWG "bad port" list ("bad port")
      // before any dispatcher runs, which would make this assertion vacuous.
      await fetch('https://localhost:45999/', { dispatcher: agent } as RequestInit);
    } catch (e) {
      const cause = (e as { cause?: { message?: string } }).cause;
      message = cause?.message ?? (e as Error).message;
    } finally {
      await agent.close();
    }
    // ★ Distinguishing these two messages IS the assertion. ECONNREFUSED would mean the
    // socket was attempted and the port merely happened to be shut — the screen would
    // have done nothing and the test would still have "failed to connect".
    expect(message).toMatch(/egress blocked/);
    expect(message).not.toMatch(/ECONNREFUSED/);
  });
});
