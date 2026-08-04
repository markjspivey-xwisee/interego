/**
 * The relay's OUTBOUND HTTP layer: the connection pools, the fetch wrapper every
 * CSS read/write goes through, and the egress choke point every CALLER-SUPPLIED URL
 * goes through.
 *
 * ── WHY THIS IS A MODULE AND NOT 250 LINES OF server.ts ──────────────────────
 *
 * It was 250 lines of server.ts, and that is the whole reason the address screen
 * spent two releases switched off.
 *
 * `server.ts` calls `app.listen()` at module scope, so NO test can import it. The
 * SSRF address screen's only interesting property is a wiring property — "the fetch
 * this function issues travels through the dispatcher that owns the screen" — and a
 * wiring property is not expressible about a module you cannot load. What stood in
 * for it was a regex over server.ts's own source text (`/dispatcher:\s*guardedEgress
 * Agent/`) plus a test that built its OWN `new Agent({connect:{lookup}})` and fetched
 * through that. The first is satisfied by the token appearing in code no request
 * reaches; the second tests the double, not the composition. Both passed with the
 * dispatcher fully detached. That pair was recorded as a KNOWN-SURVIVING mutant (M5)
 * when it shipped, with the warning "do not let a reviewer read four green mutants as
 * covering it" — and then it broke production.
 *
 * So the choke point moved to where a test can hold it. This follows the pattern
 * `lazy-pod-init.ts` and `compliance-sign.ts` already set in this directory:
 * extracted so vitest can cover the invariants without spinning the full relay.
 * server.ts destructures the same identifiers it used to declare, so every
 * `solidFetch` and `guardedInvokeFetch` call site there is unchanged — the move is
 * a change of file, not of behaviour. (A count is deliberately not written here:
 * a hand-maintained number in a comment is the drift this repo has been bitten by.)
 *
 * The one line that remains untested-by-construction is server.ts's
 * `createEgress({...})` call itself. That is a deliberate trade: it is one visible
 * line at the top of the file instead of a dispatcher argument buried at hop level
 * inside a redirect loop 200 lines from its declaration, which is what hid the last
 * one.
 */
import { Agent } from 'undici';
import type { FetchFn } from '@interego/core';
import { normalizeCssUrl, assertPublicPodUrl, bareAddressHost, screeningEgressLookup } from './url-rewrite.js';

export interface EgressConfig {
  /** The pinned CSS pod origin. Resolves into private space BY DESIGN — never screened. */
  cssUrl: string;
  /** The relay's own public base (AMEP acts loop back through it). '' when unset. */
  publicBaseUrl: string;
  /**
   * ★ Attach the address screen to caller-supplied egress. DEFAULT OFF, and the default
   * is the whole point.
   *
   * Wiring this on has now taken shape-gated publish down TWICE — #260, unwound by #261,
   * and again on the deploy of #263, caught by a direct probe returning
   * `iep:shapeUnfetchable` and rolled back the same hour. Both times the code was correct
   * everywhere it could be reproduced (Windows, `node:22-slim`, three independent
   * attempts) and wrong in the Railway container, whose resolver neither reproduction
   * could observe from outside Railway.
   *
   * So this is a flag rather than a constant because the missing evidence can only be
   * taken from a real deploy: set `RELAY_ADDRESS_SCREEN=1` on the service, publish one
   * shape-gated graph, read `cause.code` out of the WARN log — `ERR_EGRESS_PRIVATE_ADDRESS`
   * confirms the ULA hypothesis at the top of `guardedInvokeFetchLanded`, anything else
   * refutes it — then turn it off. That is a bounded experiment against the one
   * environment that has ever disagreed, instead of a third guess shipped to production.
   *
   * It is NOT a licence to leave the screen off forever. `assertPublicPodUrl` still
   * screens the NAME on every request; what is unattached is the ADDRESS half, and the
   * gap that leaves is measured and stated at `guardedEgressAgent`.
   */
  screenAddresses: boolean;
}

export interface Egress {
  /** The shared keep-alive pool. The caller installs it with `setGlobalDispatcher`. */
  outboundAgent: Agent;
  /** The same pool plus the connect-time address screen. */
  guardedEgressAgent: Agent;
  solidFetch: FetchFn;
  assertInvokeTargetAllowed(url: string): 'pinned' | 'public';
  guardedInvokeFetchLanded(
    url: string,
    init?: Parameters<FetchFn>[1],
  ): Promise<{ response: Awaited<ReturnType<FetchFn>>; landedUrl: string }>;
  guardedInvokeFetch: FetchFn;
  /** Drain both pools. Tests need it; the relay process never outlives its sockets. */
  close(): Promise<void>;
}

export const GUARDED_MAX_REDIRECTS = 5;

export function createEgress(config: EgressConfig): Egress {
  const { cssUrl, publicBaseUrl, screenAddresses } = config;

  // ── Outbound HTTP keep-alive pool ───────────────────────────
  //
  // Every outbound fetch the relay makes — solidFetch (CSS reads/writes), raw fetch
  // to IDENTITY_URL (token verify, /agents/me, etc.), webhook POST fan-out — flows
  // through Node's global undici dispatcher. Pinning a single shared Agent with
  // keep-alive on lets all of them reuse pooled TCP+TLS sockets to the env-internal
  // CSS/identity envoy instead of handshaking per request. Single source-of-truth:
  // the caller's `setGlobalDispatcher` covers solidFetch + every raw fetch site
  // without per-callsite edits.
  const outboundAgent = new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
    connections: 64,
    pipelining: 1,
  });

  // ── Guarded-egress dispatcher — THE ADDRESS HALF OF THE SSRF SCREEN ─────────
  //
  // Same pool settings as `outboundAgent`, plus a connect-time resolver that refuses
  // private addresses. `assertPublicPodUrl` screens the NAME; this screens the
  // ADDRESS at the moment of connect, which is what stops a name that STATICALLY
  // points at private space (measured: `10-0-0-5.nip.io` -> 10.0.0.5,
  // `localtest.me` -> 127.0.0.1) from ever getting a socket. A name screen cannot do
  // that and no amount of work on it ever will.
  //
  // It is attached at the `dispatcher:` option in `guardedInvokeFetchLanded` below,
  // for `mode === 'public'` only. NEVER as the global dispatcher: the relay's own CSS
  // and identity hosts resolve to private addresses by design, and `outboundAgent` —
  // which is the global one — is what carries them.
  //
  // ★ autoSelectFamily IS PINNED, AND THAT PIN IS THE FIX FOR THE FAILURE MODE #261
  // WAS BLAMED ON. undici forwards this into `net.connect` only when it is a boolean
  // here — `lib/dispatcher/client.js:235` spreads it in behind
  // `typeof autoSelectFamily === 'boolean'` — so omitted, Node falls back to the
  // PROCESS-GLOBAL `net.getDefaultAutoSelectFamily()`, which is mutable at runtime.
  // The global decides which of two callback shapes Node asks the lookup for, and
  // only the `all: true` shape can carry more than one address. Measured on this
  // Agent, after `net.setDefaultAutoSelectFamily(false)`:
  //
  //     with the pin      lookup asked {"hints":0,"all":true}    <- list, Happy Eyeballs on
  //     without the pin   lookup asked {"hints":0}               <- ONE address, no fallback
  //
  // Without the pin, one `net.setDefaultAutoSelectFamily(false)` anywhere in the
  // process — or one future edit adding `family` or `localAddress` to this Agent,
  // which has the same effect — silently turns IPv4/IPv6 fallback off for every
  // guarded egress request. That safety was ambient before; now it is declared.
  const guardedEgressAgent = new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
    connections: 64,
    pipelining: 1,
    autoSelectFamily: true,
    connect: { lookup: screeningEgressLookup as never },
  });

  // ── Fetch wrapper ───────────────────────────────────────────

  const solidFetch: FetchFn = async (url, init) => {
    // Rewrite OLD-host CSS URLs at the HTTP boundary so every code path
    // (kernel dereference, get_descriptor GET, fetchGraphContent envelope
    // fetch, verify_agent registry walk, kernelAct affordance follow, ...)
    // transparently follows the canonical internal-FQDN target. See
    // `url-rewrite.ts` for the matching regex and rewrite rules.
    const target = normalizeCssUrl(url);
    // Bounded connect+headers deadline. Without this, a CSS host that accepts the
    // TCP connection but stalls before responding blocks on undici's ~300s default
    // (and, once it surfaces as "fetch failed", is retried 4-6x by withTransientRetry),
    // riding far past the ACA ingress timeout and surfacing as an opaque 502. An abort
    // here is non-transient (AbortError doesn't match the retry matcher), so it fails
    // fast to a bounded, correctly-classified error instead of a multi-minute hang.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Number(process.env['NS_FETCH_TIMEOUT_MS'] ?? 15_000));
    try {
      // ★ `...init` IS PART OF THE SSRF WIRING, not just header plumbing. This spread
      // is how `dispatcher` reaches `fetch` — `guardedInvokeFetchLanded` puts it in
      // `init` and this line is the only thing that carries it the rest of the way.
      // Narrowing this to a hand-picked field list detaches the address screen from
      // every guarded caller at once, silently, and `tests/egress-dns-screen.test.ts`
      // is what would report it.
      const resp = await fetch(target, { ...(init as RequestInit), signal: ac.signal });
      return {
        ok: resp.ok,
        status: resp.status,
        statusText: resp.statusText,
        headers: { get: (n: string) => resp.headers.get(n) },
        text: () => resp.text(),
        json: () => resp.json(),
      };
    } finally {
      clearTimeout(timer);
    }
  };

  // ── Invoke-path outbound guard ──────────────────────────────
  //
  // Every URL fetched while FOLLOWING a descriptor (invoke_affordance / kernel
  // act): the descriptor itself, the resolved hydra:target, envelope fetches.
  // followAffordance() fires the method at whatever hydra:target the fetched
  // descriptor names — so without a network policy here, an attacker-authored
  // descriptor whose target names an internal-only host (css *.railway.internal,
  // the identity service, IMDS) turns the relay into an authenticated SSRF proxy
  // that echoes the response body back. Allowed: (a) the internal CSS pod space
  // (the normalizeCssUrl rewrite target — checked FIRST because *.internal is
  // exactly what assertPublicPodUrl rejects), (b) the relay's own public base
  // (AMEP acts), (c) any public host passing the same RFC1918/link-local/
  // loopback/IMDS screen the /ns + /audit routes enforce (federation stays open).
  //
  // Returns 'pinned' for the two origins the relay owns — their private resolution
  // is intended, so they must NOT go through the address screen — and 'public' for
  // everything else, which must. THE MODE IS READ: it is the dispatcher switch in
  // `guardedInvokeFetchLanded`. It spent two releases discarded at
  // `void assertInvokeTargetAllowed(target)` while the guarded dispatcher was
  // unwired, and that is exactly the state this module exists to make visible.
  function assertInvokeTargetAllowed(url: string): 'pinned' | 'public' {
    let u: URL;
    try { u = new URL(url); } catch { throw new Error(`invoke: unparseable URL: ${url}`); }
    try {
      const cssOrigin = new URL(cssUrl).origin;
      if (u.origin === cssOrigin) return 'pinned';
    } catch { /* CSS_URL malformed — fall through to the public screen */ }
    try {
      if (publicBaseUrl && u.origin === new URL(publicBaseUrl).origin) return 'pinned';
    } catch { /* ignore */ }
    // LOOPBACK — the relay's OWN process + sidecars. assertPublicPodUrl (below)
    // exempts `http://localhost` (it's not an IP literal), so screen it HERE, in the
    // single egress guard every guardedInvokeFetch caller shares (descriptor follow,
    // kernel_dereference/act, reduce-chain, the graph-affordance fallback). The CSS
    // and PUBLIC_BASE_URL same-origin cases already returned above, so a legitimate
    // dev PUBLIC_BASE_URL=localhost still works; any OTHER loopback is a relay-to-self
    // SSRF and is rejected.
    // Same bracket-stripping as url-rewrite.ts, imported rather than re-spelled —
    // the two copies had DIFFERENT behaviour, which is exactly how `[::1]` was
    // caught here and `[fd00::1]` was not caught anywhere.
    const hn = bareAddressHost(u.hostname);
    if (hn === 'localhost' || hn === '::1' || /^127\./.test(hn) || /^::ffff:127\./.test(hn)) {
      throw new Error(`invoke: loopback host not allowed: ${u.hostname}`);
    }
    // assertPublicPodUrl only rejects a TERMINAL `.internal` label, but
    // normalizeCssUrl can synthesize hosts with `.internal.` mid-label from
    // attacker-supplied legacy URLs (…-css.internal.<env>.azurecontainerapps.io).
    // Any host carrying an `internal` DNS label that is not the pinned CSS
    // origin is rejected outright.
    if (u.hostname.toLowerCase().split('.').includes('internal')) {
      throw new Error(`invoke: internal-labeled host not allowed: ${u.hostname}`);
    }
    assertPublicPodUrl(url);
    return 'public';
  }

  /**
   * The egress choke point for every CALLER-SUPPLIED URL, plus the URL the bytes
   * LANDED at.
   *
   * Screening only the INITIAL url was not a guard: solidFetch calls fetch() with no
   * `redirect` option, so undici follows up to 20 hops unscreened. A caller-controlled
   * public host answering `302 Location: http://169.254.169.254/…` defeated the screen
   * in one hop and reached link-local/IMDS and private ranges — the body then echoed
   * back to the caller by dereference / act / invoke_affordance / reduce_chain.
   *
   * Follow redirects MANUALLY and re-screen EVERY hop (the same discipline
   * amep-session-bridge.ts already uses with redirect:'manual'). Because this is the
   * shared wrapper, fixing it here re-arms every existing guarded caller at once.
   * `guardedInvokeFetch` is this function with the landed URL dropped, so there is one
   * screen-every-hop implementation and "re-screen every hop" cannot become true of
   * one caller and false of another.
   *
   * ★ WHY THE LANDED URL IS EXPOSED AT ALL. `FetchResponse` (the substrate's minimal
   * HTTP surface) carries no `url`, so a caller that has to reason about WHERE a body
   * came from cannot. The shape gate is exactly that caller: it resolves a page's
   * advertised `rel=alternate` href and refuses a cross-origin one, and both operations
   * are anchored on the URL the page was served from. Two things make the URL asked for
   * the wrong anchor — `normalizeCssUrl` rewrites a legacy public CSS host to its
   * `.internal.` form (a DIFFERENT ORIGIN), and the loop below follows redirects.
   * Anchoring on the URL asked for would have made every pod-hosted shape look
   * cross-origin and refused it.
   */
  async function guardedInvokeFetchLanded(
    url: string,
    init?: Parameters<FetchFn>[1],
  ): Promise<{ response: Awaited<ReturnType<FetchFn>>; landedUrl: string }> {
    let target = normalizeCssUrl(url);
    for (let hop = 0; hop <= GUARDED_MAX_REDIRECTS; hop++) {
      // ★ THIS LINE IS THE ADDRESS SCREEN. Everything else about it is a predicate.
      //
      // `mode === 'public'` is the whole reason `assertInvokeTargetAllowed` returns a
      // value: the two PINNED origins are ours and resolve into private space on
      // purpose, so they go out on the unscreened global pool; everything else is a
      // caller-chosen host and dials through `screeningEgressLookup`.
      //
      // ── THE INCIDENT THIS LINE CAUSED, AND WHAT WAS AND WAS NOT ESTABLISHED ──
      //
      // It was here for exactly one production deploy (#260) and took every
      // shape-gated publish down: `fetchShapeRepresentation` reaches GitHub Pages
      // through this function, the fetch failed, and the conformance gate — correctly
      // failing closed — refused every append with `422 iep:shapeUnfetchable`. The
      // whole shared-workspace stream path stopped (verify-stream-live 8/20). Reverted
      // in production minutes later (#261).
      //
      // THE DIAGNOSIS RECORDED AT THE TIME WAS WRONG, and re-landing on the strength
      // of "we fixed the lookup" would be wrong too. It said `screeningEgressLookup`
      // collapsed the answer to `list[0]`, killing IPv4/IPv6 fallback. Two independent
      // reproductions, on win32 and inside containers built from BOTH the relay's build
      // image (node:22-slim) and its runtime image (distroless/nodejs22-debian12),
      // refute it: undici asks a connect-time lookup for `all: true` whenever
      // autoSelectFamily is on, so that branch never executed; the real screen on the
      // real Agent fetched the real shape URL 200 OK on an IPv4-only bridge, on an
      // IPv6 bridge, and with a forced v6-first list and no v6 route.
      //
      // WHAT IS CONFIRMED IS THAT THE OUTAGE WAS UNDIAGNOSABLE BY CONSTRUCTION.
      // Measured in the runtime image, identical at the call site:
      //     screen fires  -> "TypeError: fetch failed", cause.code ERR_EGRESS_PRIVATE_ADDRESS
      //     DNS failure   -> "TypeError: fetch failed", cause.code ENOTFOUND
      //     TLS failure   -> "TypeError: fetch failed", cause.code ERR_TLS_CERT_ALTNAME_INVALID
      // and `shape-body.ts` recorded only `err.message`. So the log said `fetch threw:
      // fetch failed` and nothing else, and "the connect failed" was an inference from
      // a string that cannot distinguish a connect failure from THE SCREEN CORRECTLY
      // FIRING. That is fixed in this round — shape-body.ts now records `cause.code` —
      // which is the one change that makes a recurrence readable instead of guessable.
      //
      // ★ THE LEADING UNTESTED HYPOTHESIS, for whoever reads the next incident. Railway
      // private networking is IPv6 ULA, and `PRIVATE_IPV6_RE` blocks `fc00::/7` by
      // design. Any answer that lands in that range — a NAT64/DNS64 synthesis on a
      // ULA prefix, a resolver returning ULA for an external name — is refused with
      // ERR_EGRESS_PRIVATE_ADDRESS and presents as exactly this outage. Neither
      // reproduction could observe Railway's resolver from outside Railway, and a
      // laptop Docker bridge is inadmissible evidence about it (measured asymmetry:
      // AI_ADDRCONFIG drops AAAA entirely in an IPv4-only container, which Railway is
      // not). If shape publishes fail again, the `cause.code` in the WARN log answers
      // this in one line.
      const mode = assertInvokeTargetAllowed(target);
      const r = await solidFetch(target, {
        ...(init as Record<string, unknown>),
        redirect: 'manual',
        // `screenAddresses` gates the ADDRESS half only, and defaults off — see
        // `EgressConfig.screenAddresses` for the two outages that made it a flag and for
        // the one measurement that will settle it. `mode` still decides which pool a
        // request is ELIGIBLE for, so a pinned target is never screened either way.
        ...(mode === 'public' && screenAddresses ? { dispatcher: guardedEgressAgent } : {}),
      } as typeof init);
      if (r.status < 300 || r.status >= 400) return { response: r, landedUrl: target };
      // `headers` is optional on the substrate's minimal `FetchResponse`, and this line
      // was an unguarded `.get` in server.ts — where the stricter tsconfig that caught it
      // does not reach. A 3xx from any FetchFn that omits headers threw a TypeError out
      // of the egress guard instead of returning the redirect unfollowed.
      const loc = r.headers?.get('location');
      if (!loc) return { response: r, landedUrl: target };
      // Resolve relative Locations against the CURRENT hop, then re-screen on the
      // next iteration — a relative redirect must not escape the guard either.
      target = normalizeCssUrl(new URL(loc, target).toString());
    }
    throw new Error('invoke: too many redirects');
  }

  const guardedInvokeFetch: FetchFn = async (url, init) =>
    (await guardedInvokeFetchLanded(url, init)).response;

  return {
    outboundAgent,
    guardedEgressAgent,
    solidFetch,
    assertInvokeTargetAllowed,
    guardedInvokeFetchLanded,
    guardedInvokeFetch,
    close: async () => { await Promise.all([outboundAgent.close(), guardedEgressAgent.close()]); },
  };
}
