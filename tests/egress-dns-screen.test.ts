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
 * `screeningEgressLookup` is the in-tree half: undici's connect-time resolver, so the
 * address screened is the address dialled. It was BUILT AND NOT WIRED for two releases —
 * #260 attached it and it took every shape-gated publish down, #261 detached it and
 * edited no comment, so three files went on describing a live screen while
 * `10-0-0-5.nip.io` and `localtest.me` reached a socket. It is wired again, and the
 * difference this time is the third describe block below: the claim "wired" is now
 * something this file MEASURES over a real socket, not something it reads.
 *
 * ── WHERE THESE ASSERTIONS LIVE ──────────────────────────────────────────────
 *
 * `assertPublicPodUrl`'s address-screen corpus is here rather than in
 * `tests/url-rewrite.test.ts` (which covers `normalizeCssUrl`) so that one file owns the
 * whole SSRF screen — the syntactic half, the resolved half, and the wiring that joins
 * them — and a reviewer reading any one sees the others.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { Agent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { stripComments } from '../deploy/mcp-relay/tests/strip-comments.js';
import {
  assertPublicPodUrl,
  bareAddressHost,
  privateAddressReason,
  screeningEgressLookup,
  setEgressResolverForTests,
} from '../deploy/mcp-relay/url-rewrite.js';
import { createEgress } from '../deploy/mcp-relay/egress.js';

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
 * ★ THE WIRING TEST. THIS IS THE ONE THAT WAS MISSING, AND ITS ABSENCE IS THE WHOLE
 * INCIDENT.
 *
 * The screen's only interesting property is not "does the predicate classify addresses
 * correctly" — four mutants already pin that, and all four were green while the screen
 * was switched off. It is "does the fetch the relay's guarded egress path issues travel
 * through the dispatcher that owns the screen". The two things that stood in for that
 * question both passed with the dispatcher fully detached:
 *
 *   - the `screeningEgressLookup` block above builds its OWN `new Agent({connect:
 *     {lookup}})`. It tests the double, not the composition.
 *   - the docs/wiring gate below is a REGEX OVER SOURCE TEXT. It is satisfied by the
 *     token appearing in code no request reaches.
 *
 * That pair was recorded as a known-surviving mutant (M5), with the warning "do not let
 * a reviewer read four green mutants as covering it". It survived, and then it broke
 * production.
 *
 * ── WHERE THE DOUBLE GOES, WHICH IS THE WHOLE DESIGN ─────────────────────────
 *
 * Everything in the path stays production: `createEgress` from `egress.ts` builds the
 * real pools, the real screen goes on the real Agent, `guardedInvokeFetch` is the real
 * entry point, and a real socket is opened to a real listener. The ONE thing replaced is
 * THE INTERNET — the OS resolver, one layer BELOW the unit under test. Nothing about the
 * relay is stubbed, so no change to the relay can satisfy this except actually wiring the
 * dispatcher.
 *
 * The alternative was a real public name that resolves into private space, and it was
 * rejected on measurement: `169-254-169-254.nip.io` returned ENOENT on win32 in the same
 * run that resolved `10-0-0-5.nip.io`, and `ip6-localhost` does not exist on win32 at
 * all. A gate that passes because a name failed to resolve is worse than no gate.
 *
 * ── THE DISCRIMINATOR, MEASURED BOTH WAYS ────────────────────────────────────
 *
 * Applied to `egress.ts` and re-run, deleting the `dispatcher:` option:
 *
 *   dispatcher ATTACHED (HEAD)   0 connections, cause.code ERR_EGRESS_PRIVATE_ADDRESS
 *   dispatcher DETACHED (#261)   1 connection,  cause.code ECONNRESET
 *
 * ECONNRESET and not a 200 only because this listener destroys the socket the instant
 * it accepts, so the TLS handshake never completes — the SOCKET is the finding, and
 * against a listener that answers, the same detached request is a 200 with the body in
 * hand (measured separately, against `localtest.me`).
 *
 * The detached row is not a prediction: the positive control below RUNS the unguarded
 * request, so the fixture is proven able to express the failure before the guarded path
 * is asked to prevent it.
 */
describe('★ the address screen is WIRED: a socket, from the far side', () => {
  /** The name under test. `.example` is reserved (RFC 2606) and resolves nowhere real. */
  const HOST = 'shape-host.example';

  /**
   * The stand-in internet: this name IS an A record for loopback. Exactly the SSRF the
   * screen exists to stop, and exactly what `10-0-0-5.nip.io` does for real.
   *
   * One object serves both consumers — the screen's resolver seam and the unguarded
   * pool's connector — so the two paths cannot disagree about what DNS says, and the
   * comparison between them is a comparison of the WIRING and nothing else.
   */
  function theInternet(
    hostname: string,
    options: Record<string, unknown>,
    cb: (err: NodeJS.ErrnoException | null, addr?: unknown, family?: number) => void,
  ): void {
    if (hostname !== HOST) {
      cb(Object.assign(new Error(`no such host: ${hostname}`), { code: 'ENOTFOUND' }));
      return;
    }
    const list = [{ address: '127.0.0.1', family: 4 }];
    if (options['all']) { cb(null, list); return; }
    cb(null, list[0]!.address, list[0]!.family);
  }

  it('refuses the connect, and the SAME request lands a socket when unguarded', async () => {
    let connections = 0;
    let server: Server | undefined;
    let restoreResolver: (() => void) | undefined;
    let previousGlobal: Dispatcher | undefined;
    let unguardedPool: Agent | undefined;
    let egress: ReturnType<typeof createEgress> | undefined;
    try {
      // A bare TCP counter. No TLS: the connect precedes the handshake, and "a socket was
      // opened to 127.0.0.1" is the event the screen exists to prevent — whether the
      // handshake then succeeds is irrelevant to that.
      server = createServer(sock => { connections += 1; sock.destroy(); });
      await new Promise<void>(r => { server!.listen(0, '127.0.0.1', () => r()); });
      server.unref();
      const port = (server.address() as AddressInfo).port;
      const url = `https://${HOST}:${port}/shape.ttl`;

      restoreResolver = setEgressResolverForTests(theInternet);
      // The UNGUARDED pool is what production's global dispatcher is: `outboundAgent`,
      // no screen, because the relay's own CSS and identity hosts resolve private by
      // design. Installing it globally is what makes a DETACHED dispatcher fall back to
      // a working connect — i.e. what makes the mutant observable rather than merely
      // "some error either way".
      previousGlobal = getGlobalDispatcher();
      unguardedPool = new Agent({ connect: { lookup: theInternet as never } });
      setGlobalDispatcher(unguardedPool);

      // ── POSITIVE CONTROL: the fixture can express the failure ──────────────
      // Without this the assertion below could pass because the name did not resolve,
      // which is precisely how the previous gate managed to check nothing.
      await fetch(url).catch(() => undefined);
      expect(connections, 'the fixture never reached the listener — every assertion below would be vacuous')
        .toBe(1);

      // ── THE PRODUCTION PATH ────────────────────────────────────────────────
      connections = 0;
      egress = createEgress({ cssUrl: 'https://css.pinned.example/', publicBaseUrl: '' });
      let code: unknown;
      let status: number | undefined;
      try {
        status = (await egress.guardedInvokeFetch(url, { method: 'GET' })).status;
      } catch (err) {
        code = ((err as { cause?: NodeJS.ErrnoException }).cause)?.code ?? (err as Error).message;
      }

      // ★ SOFT, all three, deliberately. Detaching the dispatcher breaks every one of
      // them and they say different things — a socket landed / it failed for the wrong
      // reason / it succeeded outright. A hard assert on the first would report one and
      // hide the other two, and the socket count is the finding a reader needs first.
      expect.soft(connections, 'the guarded fetch opened a socket to 127.0.0.1 — the screen is not on the wire')
        .toBe(0);
      // ★ ERR_EGRESS_PRIVATE_ADDRESS and not ECONNRESET/ECONNREFUSED/ENOTFOUND: the
      // distinction IS the assertion. Any other code means the request failed for a
      // reason that is not the screen, and the screen would have prevented nothing.
      expect.soft(code, 'the guarded fetch failed, but NOT because the address screen refused it')
        .toBe('ERR_EGRESS_PRIVATE_ADDRESS');
      expect.soft(status, 'the guarded fetch COMPLETED against a loopback listener — this is the SSRF itself')
        .toBeUndefined();
    } finally {
      // vitest runs this repo single-threaded (`poolOptions.threads.singleThread`), so a
      // global dispatcher or resolver left installed here is installed for every later
      // test FILE in the run. Restored in a `finally`, not at the end of the happy path.
      if (previousGlobal) setGlobalDispatcher(previousGlobal);
      restoreResolver?.();
      await egress?.close();
      await unguardedPool?.close();
      server?.close();
    }
  });

  /**
   * ★ AND THE SCREEN DID NOT TURN HAPPY EYEBALLS OFF — the regression #260 was blamed
   * for, asserted rather than argued.
   *
   * `net` switches back to a SINGLE connect the moment a lookup hands back one address:
   * no attempt timer, no next-address retry, no AggregateError. So "did the list survive
   * the screen" is decidable from the shape of the failure when every address is dead.
   * Measured on both platforms this suite runs on, connecting to 240.0.0.0/4:
   *
   *   multi path   AggregateError, members ["…","…"], attempted 2 addresses  (~30 ms)
   *   single path  plain Error, no members, attempted null                   (~5 ms)
   *
   * The error CODE differs by platform — ENETUNREACH on win32, ECONNREFUSED in
   * node:22-slim — so it is deliberately not asserted; the STRUCTURE is identical.
   *
   * This also pins `autoSelectFamily: true` on the guarded Agent. The test flips the
   * process-global OFF first: unpinned, Node then asks the lookup for one address and
   * this drops to the single path. That global is mutable by anything in the process,
   * and setting `family` or `localAddress` on the Agent has the same effect, so the
   * property was ambient before and is declared now.
   */
  it('hands the whole address list to Node, in order, with the family pin holding', async () => {
    const DEAD = [{ address: '240.0.0.1', family: 4 }, { address: '240.0.0.2', family: 4 }];
    const previousAutoSelect = net.getDefaultAutoSelectFamily();
    // ★ BOUND THE ATTEMPT, DO NOT BOUND THE TEST. 240.0.0.0/4 is reserved space, and how a
    // connect to it fails is a property of the ROUTING TABLE, not of this code: on a host
    // with no route it is an immediate ENETUNREACH, and on a host with a default gateway —
    // which every GitHub Actions runner has — the SYN goes out and nothing answers. This
    // test passed here in 26ms and hit vitest's 5s ceiling in CI for exactly that reason.
    //
    // Happy Eyeballs bounds each attempt itself; the default is 250ms, and the two attempts
    // plus TLS setup can crowd 5s on a loaded runner. Pinning it low makes the timing a
    // property of this test rather than of the network the test happens to run on, and the
    // ASSERTIONS are untouched: they are about how many candidates reached the connector,
    // which is what the family pin is here to prove. Raising the vitest timeout instead
    // would have left the real variable — the routing table — still in the test.
    const previousAttemptTimeout = net.getDefaultAutoSelectFamilyAttemptTimeout();
    net.setDefaultAutoSelectFamilyAttemptTimeout(100);
    let restoreResolver: (() => void) | undefined;
    let egress: ReturnType<typeof createEgress> | undefined;
    try {
      restoreResolver = setEgressResolverForTests((_h, options, cb) => {
        if (options['all']) { cb(null, DEAD); return; }
        cb(null, DEAD[0]!.address, DEAD[0]!.family);
      });
      net.setDefaultAutoSelectFamily(false);
      egress = createEgress({ cssUrl: 'https://css.pinned.example/', publicBaseUrl: '' });

      let cause: (Error & { errors?: unknown[] }) | undefined;
      try {
        await egress.guardedInvokeFetch(`https://dead-host.example/shape.ttl`, { method: 'GET' });
      } catch (err) {
        cause = (err as { cause?: Error & { errors?: unknown[] } }).cause;
      }
      expect(cause, 'the guarded fetch did not fail at connect at all').toBeDefined();
      // Collapse the list to `[list[0]]`, filter it, or drop the `autoSelectFamily` pin,
      // and this is a plain Error with no members.
      expect(cause!.name, 'Node took the SINGLE-connect path — the address list was collapsed to one entry')
        .toBe('AggregateError');
      expect(cause!.errors, 'fewer candidates reached the connector than the resolver returned')
        .toHaveLength(DEAD.length);
    } finally {
      net.setDefaultAutoSelectFamily(previousAutoSelect);
      net.setDefaultAutoSelectFamilyAttemptTimeout(previousAttemptTimeout);
      restoreResolver?.();
      await egress?.close();
    }
  });

  /**
   * The pass-through contract, stated directly on the screen: same length, same order,
   * numeric families. `net` takes the family of the FIRST entry as the family tried
   * first and performs no RFC-3484 re-sort of its own, so a screen that sorted — even
   * "helpfully", v4-first — would silently change every guarded connect's preference.
   */
  it('returns the resolver\'s array verbatim when Node asked for `all`', async () => {
    const ANSWER = [
      { address: '2606:50c0:8001::153', family: 6 },
      { address: '2606:50c0:8003::153', family: 6 },
      { address: '185.199.109.153', family: 4 },
      { address: '185.199.108.153', family: 4 },
    ];
    const restore = setEgressResolverForTests((_h, _o, cb) => cb(null, ANSWER));
    try {
      const got = await new Promise<{ address: string; family: number }[]>(resolve => {
        // The options linux actually passes: AI_ADDRCONFIG, and `all` from autoSelectFamily.
        screeningEgressLookup('example.com', { hints: 32, all: true }, (_e, addrs) =>
          resolve(addrs as { address: string; family: number }[]));
      });
      expect(got).toEqual(ANSWER);
      expect(got.map(a => a.address)).toEqual(ANSWER.map(a => a.address));   // order, explicitly
      expect(got.every(a => typeof a.family === 'number')).toBe(true);
    } finally { restore(); }
  });

  /**
   * The refusal is ALL-OR-NOTHING. A hostname answering with one public and one private
   * address is a rebinding answer, not a partially usable one — filtering the private
   * entry out and dialling the survivor would leave the NEXT resolution, the one the
   * socket uses under a TTL of 0, free to be the private one.
   */
  it('refuses the whole hostname when ANY address is private, rather than filtering', async () => {
    const restore = setEgressResolverForTests((_h, _o, cb) => cb(null, [
      { address: '185.199.108.153', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]));
    try {
      const err = await new Promise<NodeJS.ErrnoException | null>(resolve => {
        screeningEgressLookup('mixed.example', { all: true }, e => resolve(e));
      });
      expect(err?.code).toBe('ERR_EGRESS_PRIVATE_ADDRESS');
      expect(err?.message).toContain('169.254.169.254');
    } finally { restore(); }
  });
});

/**
 * ★ THE DOCS AND THE WIRING CANNOT DRIFT APART AGAIN.
 *
 * #261 unwired `guardedEgressAgent` and edited nothing else. The module that DEFINES the
 * screen went on asserting, in the present tense, that the mitigation was "now IN TREE",
 * that `screeningEgressLookup` was "the resolver undici actually uses", and that the
 * reader should "keep BOTH" — three sentences telling a reader of the security boundary
 * to stop looking, at a commit that was deployed. This repo's rule is that a comment
 * asserting coverage the code lacks is worse than the gap; nothing enforced it.
 *
 * So the PROSE must agree with the wiring in both directions. Unwiring the dispatcher
 * without deleting the "in force" language fails here just as loudly as re-landing it
 * without deleting the "not wired" language.
 *
 * ★ THIS IS THE WEAKER GATE OF THE TWO AND MUST NOT BE READ AS THE WIRING TEST. It is a
 * regex over source text, and a regex cannot tell wired from written-down — that is
 * exactly how M5 survived. The block above is the wiring test; this one keeps the
 * ENGLISH honest. Comments are stripped with the shared parser-based stripper, because a
 * retracted wiring line survives as a `//` comment and a substring test over raw text
 * would read it as evidence the screen is live.
 */
describe('the address screen: what the code does and what the comments claim', () => {
  const RELAY = fileURLToPath(new URL('../deploy/mcp-relay/', import.meta.url));
  const serverSrc = readFileSync(`${RELAY}server.ts`, 'utf8');
  const rewriteSrc = readFileSync(`${RELAY}url-rewrite.ts`, 'utf8');
  const egressSrc = readFileSync(`${RELAY}egress.ts`, 'utf8');
  const egressCode = stripComments(egressSrc, 'egress.ts');

  /** Is the screening resolver the resolver of a dispatcher a fetch actually uses? */
  const wired = /dispatcher:\s*guardedEgressAgent/.test(egressCode);

  /** Sentences that are TRUE only while it is wired. */
  const CLAIMS_IN_FORCE = [
    'The mitigation is now IN TREE',
    'Wired ONLY onto the guarded-egress dispatcher',
    'is what tells the caller to dial through',
    'THE ADDRESS HALF OF THE SSRF SCREEN',
    'THE MODE IS READ',
  ];
  /** Sentences that are TRUE only while it is NOT. */
  const CLAIMS_NOT_WIRED = [
    'THE ADDRESS SCREEN IS NOT IN FORCE',
    'IT IS THE RESOLVER FOR NOTHING',
    'THE ADDRESS SCREEN IS NOT WIRED HERE',
    'BUILT, NOT WIRED',
    'NOBODY READS THE MODE',
  ];
  const SOURCES = [
    ['url-rewrite.ts', rewriteSrc],
    ['server.ts', serverSrc],
    ['egress.ts', egressSrc],
  ] as const;

  it('reads a wiring state at all — the guard is not looking at the wrong token', () => {
    // If `guardedEgressAgent` were renamed or deleted outright, `wired` would read false
    // and every assertion below would be trivially satisfied in the WRONG direction.
    expect(egressCode, 'guardedEgressAgent is gone from egress.ts — this gate now checks nothing')
      .toMatch(/guardedEgressAgent/);
    expect(rewriteSrc).toMatch(/export function screeningEgressLookup/);
    // server.ts must still be the thing that BUILDS the egress layer; if it stopped
    // calling createEgress, egress.ts could be perfectly wired and reach no request.
    expect(stripComments(serverSrc, 'server.ts'), 'server.ts no longer calls createEgress')
      .toMatch(/createEgress\(/);
  });

  it('says the screen is live only when it IS live', () => {
    for (const claim of CLAIMS_IN_FORCE) {
      for (const [name, src] of SOURCES) {
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
      for (const [name, src] of SOURCES) {
        expect(
          src.includes(claim) && wired,
          `${name} still says "${claim}" although guardedEgressAgent is now dispatching. `
            + 'Delete the not-wired language in the same commit that re-lands the wiring.',
        ).toBe(false);
      }
    }
  });

  it('keeps the incident record at the wiring site while the wiring is live', () => {
    if (!wired) return;
    // #260 is the reason anyone will ever look at this line again. The note is not
    // decoration: it records that the diagnosis of record was REFUTED, so a recurrence
    // is not re-diagnosed from the same wrong premise.
    const loop = egressSrc.slice(egressSrc.indexOf('async function guardedInvokeFetchLanded'));
    expect(loop, 'the #260 incident record is gone from the line that caused it')
      .toContain('#260');
    expect(loop, 'the note no longer says the recorded diagnosis was refuted')
      .toMatch(/refute/i);
    // And the one thing that made it undiagnosable must stay fixed.
    const shapeBody = readFileSync(`${RELAY}shape-body.ts`, 'utf8');
    expect(shapeBody, 'shape-body.ts is back to discarding err.cause — the next outage is unreadable again')
      .toContain('describeFetchFailure');
  });

  it('states the mitigation where a reader of the NAME screen will hit it', () => {
    // Not "somewhere in the file": in the header of the syntactic screen, which is where
    // someone auditing an SSRF report starts reading, and which on its own is NOT
    // sufficient — it accepts every one of the measured bypasses.
    const header = rewriteSrc.slice(0, rewriteSrc.indexOf('export function assertPublicPodUrl'));
    for (const host of ['10-0-0-5.nip.io', 'localtest.me']) {
      expect(header, `assertPublicPodUrl's header does not name the measured bypass ${host}`)
        .toContain(host);
    }
    expect(header, 'assertPublicPodUrl does not tell the reader which half actually stops those')
      .toContain('screeningEgressLookup');
  });
});
