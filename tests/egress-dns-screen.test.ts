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
 * localtest.me) defeats a syntactic check outright.
 *
 * ★ AND THE IN-TREE HALF IS BUILT AND NOT WIRED. This paragraph used to end
 * "`screeningEgressLookup` is the in-tree half: undici's connect-time resolver, so the
 * address screened is the address dialled" — present tense, and false since #261 unwired
 * `guardedEgressAgent` after it took every shape-gated publish down. The function below
 * is exercised here against a real `Agent`, which is what keeps it correct; nothing in
 * the relay process dispatches through such an Agent. `10-0-0-5.nip.io` and
 * `localtest.me` reach a socket today. The last describe block in this file is the gate
 * that keeps these three files from saying otherwise while the wiring is absent.
 *
 * ── WHERE THESE ASSERTIONS LIVE ──────────────────────────────────────────────
 *
 * `assertPublicPodUrl`'s address-screen corpus is here rather than in
 * `tests/url-rewrite.test.ts` (which covers `normalizeCssUrl`) so that one file owns the
 * whole SSRF screen — the syntactic half and the resolved half — and a reviewer reading
 * either half sees the other.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';
import { stripComments } from '../deploy/mcp-relay/tests/strip-comments.js';
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

/**
 * ★ THE DOCS AND THE WIRING CANNOT DRIFT APART AGAIN.
 *
 * #261 unwired `guardedEgressAgent` in server.ts and edited nothing else. The module that
 * DEFINES the screen went on asserting, in the present tense, that the mitigation was
 * "now IN TREE", that `screeningEgressLookup` was "the resolver undici actually uses", and
 * that the reader should "keep BOTH" — three sentences telling a reader of the security
 * boundary to stop looking, at a commit that was deployed. This repo's rule is that a
 * comment asserting coverage the code lacks is worse than the gap; nothing enforced it.
 *
 * So the WIRING is read out of server.ts and the PROSE must agree with it, in both
 * directions. Re-landing the dispatcher without deleting the "not wired" language fails
 * here just as loudly as unwiring it without deleting the "in force" language.
 *
 * Comments are stripped with the shared parser-based stripper: server.ts's own retracted
 * wiring line survives as a `//` comment, and a substring test over raw text would read
 * that commented-out line as evidence the screen is live — the exact confusion this gate
 * exists to prevent.
 */
describe('the address screen: what the code does and what the comments claim', () => {
  const RELAY = fileURLToPath(new URL('../deploy/mcp-relay/', import.meta.url));
  const serverSrc = readFileSync(`${RELAY}server.ts`, 'utf8');
  const rewriteSrc = readFileSync(`${RELAY}url-rewrite.ts`, 'utf8');
  const serverCode = stripComments(serverSrc, 'server.ts');

  /** Is the screening resolver the resolver of any dispatcher a fetch actually uses? */
  const wired = /dispatcher:\s*guardedEgressAgent/.test(serverCode);

  /** Sentences that are TRUE only while it is wired. */
  const CLAIMS_IN_FORCE = [
    'The mitigation is now IN TREE',
    'as the resolver undici actually uses',
    'Wired ONLY onto the guarded-egress dispatcher',
    'is what tells the caller to dial through',
  ];
  /** Sentences that are TRUE only while it is NOT. */
  const CLAIMS_NOT_WIRED = [
    'THE ADDRESS SCREEN IS NOT IN FORCE',
    'IT IS THE RESOLVER FOR NOTHING',
  ];

  it('reads a wiring state at all — the guard is not looking at the wrong token', () => {
    // `guardedEgressAgent` must still exist under one name or the other; if it were
    // deleted outright, every assertion below would be trivially satisfied.
    expect(serverCode, 'guardedEgressAgent is gone from server.ts — this gate now checks nothing')
      .toMatch(/guardedEgressAgent/);
    expect(rewriteSrc).toMatch(/export function screeningEgressLookup/);
  });

  it('says the screen is live only when it IS live', () => {
    for (const claim of CLAIMS_IN_FORCE) {
      for (const [name, src] of [['url-rewrite.ts', rewriteSrc], ['server.ts', serverSrc]] as const) {
        expect(
          src.includes(claim) && !wired,
          `${name} still says "${claim}" while nothing dispatches through guardedEgressAgent. `
            + 'A publicly-resolvable name pointing at private space reaches a socket.',
        ).toBe(false);
      }
    }
  });

  it('says the screen is absent only when it IS absent', () => {
    for (const claim of CLAIMS_NOT_WIRED) {
      expect(
        rewriteSrc.includes(claim) && wired,
        `url-rewrite.ts still says "${claim}" although guardedEgressAgent is now dispatching. `
          + 'Delete the not-wired language in the same commit that re-lands the wiring.',
      ).toBe(false);
    }
  });

  it('states the absence where a reader of the guard will hit it', () => {
    if (wired) return;
    // Not "somewhere in the file": in the header of the function that is now the ONLY
    // defence, which is where someone auditing an SSRF report starts reading.
    const header = rewriteSrc.slice(0, rewriteSrc.indexOf('export function assertPublicPodUrl'));
    expect(header, 'assertPublicPodUrl does not tell the reader the address screen is unwired')
      .toContain('THE ADDRESS SCREEN IS NOT IN FORCE');
    // …and it names the bypasses that were measured, so "unwired" is not abstract.
    for (const host of ['10-0-0-5.nip.io', 'localtest.me']) {
      expect(header, `assertPublicPodUrl's header does not name the measured bypass ${host}`)
        .toContain(host);
    }
  });

  it('keeps the re-landing conditions where the wiring was removed', () => {
    if (wired) return;
    expect(serverSrc, 'the incident note no longer says the cause is unknown')
      .toContain('THE CAUSE IS NOT KNOWN');
    // The refuted diagnosis must not come back as an instruction. It sent the next
    // engineer at `screeningEgressLookup`'s address selection, which four measurements
    // (undici always passes `all: true`; AI_ADDRCONFIG on linux; a live 200 through the
    // real lookup on node:22-slim; happy-eyeballs recovering an IPv6-first list in an
    // IPv4-only container) say is not what broke.
    expect(serverSrc, 'the refuted "preserve Node\'s selection" instruction is back')
      .not.toMatch(/preserve Node's selection instead of forcing one address/);
  });
});
