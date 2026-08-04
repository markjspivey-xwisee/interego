/**
 * The body of a SHACL shape the publish gate validates against — fetched, followed, cached.
 *
 * ── ★ WHY THIS LEFT server.ts ────────────────────────────────────────────────
 *
 * `fetchShapeBody` was the last reader in the tree that followed a page's own
 * `<link rel="alternate" type="text/turtle">` with an inline copy of the hop, and that copy
 * did NOT refuse a cross-origin alternate. A shape whose HTML page advertised a Turtle
 * document on a FOREIGN ORIGIN had that foreign document fetched and used as the publish
 * gate — so whoever controlled the foreign origin decided what every publish to that pod had
 * to satisfy, while the caller still believed it was validating against the IRI it named.
 * Every `conforms_to_shapes` publish in the system runs through this function.
 *
 * The fix is to compose {@link followAlternateTurtle} rather than keep a third copy of the
 * hop. Two copies of a follower drift in exactly the way that is invisible until somebody
 * publishes a page written the other way round — which is the reason the predicates were
 * pulled into @interego/core in the first place, and this is that move finished.
 *
 * ── ★★ WHY IT IS A MODULE AND NOT AN EDIT IN PLACE ───────────────────────────
 *
 * `server.ts` starts an HTTP listener on import, so nothing defined in it can be reached by a
 * unit test — and a LIVE RUN EXERCISES THE HONEST PATH AND NOTHING ELSE. Running the gate
 * against production proves the shape fetch works; it says nothing about what happens when a
 * page advertises somebody else's Turtle, because no page we publish does. The whole of the
 * entanglement below therefore moves here behind injected dependencies, the same extraction
 * `supersession-frontier.ts`, `interop-principal.ts` and `authorship-content-binding.ts` are
 * a record of.
 *
 * ── THE ENTANGLEMENT, PRESERVED ──────────────────────────────────────────────
 *
 * Three things were braided into the hop and all three still hold:
 *
 *  1. LAST-KNOWN-GOOD. A cached success doubles as the fallback used when a later fetch fails
 *     TRANSIENTLY, so one network blip does not 422 every publish to a pod for as long as it
 *     lasts. Deleting the stale entry on the way in made that fallback dead code once, so the
 *     stale entry is deliberately left in place until it is either refreshed or evicted.
 *
 *  2. TRANSIENT vs PERMANENT. Only 5xx/429/408 and a network throw may fall back. A
 *     404/403/410 is the shape owner deleting or tightening the shape, and honouring a cached
 *     permissive copy for 24h after that would be worse than the bug the fallback fixes — so
 *     a permanent failure EVICTS.
 *
 *  3. THE GUARDED FETCH. `guardedInvokeFetch` screens SSRF, every redirect hop, internal
 *     hosts and loopback, and `shapeIri` is a caller argument that reaches this code BEFORE
 *     the scope gate. The follower takes an injected fetch precisely so the hop goes through
 *     the same screen as the first fetch instead of around it.
 *
 * ── WHAT CHANGED DELIBERATELY ────────────────────────────────────────────────
 *
 *  - A CROSS-ORIGIN alternate is now REFUSED. Measured before shipping: all 78
 *    `text/turtle` alternates in the deployed `docs/` tree are RELATIVE hrefs, and every live
 *    shape IRI in the tree that answers `text/html` advertises a same-origin relative href.
 *    Nothing published relies on a cross-origin alternate, so the refusal costs no real
 *    publish. CSS-hosted shapes never reach the hop at all — the pod serves `text/turtle`.
 *
 *  - The href resolves against the URL the page LANDED at rather than the URL asked for, and
 *    the same-origin comparison uses the same landed URL on both sides. This is not cosmetic:
 *    `normalizeCssUrl` rewrites a legacy public CSS host to its `.internal.` form, so the URL
 *    asked for and the URL fetched are DIFFERENT ORIGINS for pod-hosted shapes. Anchoring on
 *    the URL asked for would have made every such shape look cross-origin and refused it —
 *    a fail-closed break of the live gate introduced by the guard meant to protect it.
 *
 *  - The hop's response must be exactly 200 with a non-blank body (it was any 2xx before).
 *    A 204 is not a shapes graph, and a blank one constrains nothing.
 *
 *  - The refusal REASON now reaches the WARN log, so an operator reading it learns which step
 *    refused — no alternate advertised, foreign origin, redirect off-origin, 404 — instead of
 *    the single "no usable rel=alternate" sentence that covered all four.
 *
 * Behaviour deliberately NOT changed: a page that answers 200 and then fails the hop is
 * classified PERMANENT, exactly as before. It is a live document saying its Turtle is gone,
 * and the safe reading is that the shape was withdrawn — which evicts last-known-good rather
 * than keeping a stale permissive copy alive for 24h behind a hop somebody else can break.
 */

import {
  followAlternateTurtle,
  type FetchedRepresentation,
} from './alternate-turtle.js';

/**
 * One cached shape body. `expiresAt` is freshness; `knownGoodUntil` is how long the body may
 * still be used as a fallback after a transient failure — deliberately much longer, and 0 for
 * a body that did not parse as a shapes graph (pinning an HTML error page for 24h would be
 * pinning a shape that constrains nothing).
 */
export interface ShapeBodyCacheEntry {
  readonly body: string;
  readonly expiresAt: number;
  readonly knownGoodUntil: number;
}

/**
 * One fetched shape representation as the relay's HTTP client reports it.
 *
 * `url` is the URL the bytes LANDED at after `normalizeCssUrl` and every redirect hop —
 * not the URL asked for. That distinction is the whole of the origin guard below.
 */
export interface FetchedShapeRepresentation extends FetchedRepresentation {
  readonly ok: boolean;
  readonly statusText: string;
}

export interface ShapeBodyDeps {
  /** The SSRF-screened fetch, reporting the URL the bytes landed at. */
  readonly fetchRepresentation: (url: string) => Promise<FetchedShapeRepresentation>;
  /** Does this body parse as a shapes graph at all? (the in-process SHACL parser). */
  readonly parsesAsShapesGraph: (body: string) => boolean;
  readonly log: (message: string) => void;
  readonly cache: Map<string, ShapeBodyCacheEntry>;
  readonly cacheMax: number;
  /** How long a fetched body is served without refetching. */
  readonly freshTtlMs: number;
  /** How long a previously-VERIFIED body stays usable after a transient failure. */
  readonly knownGoodTtlMs: number;
}

/**
 * The shape body for `shapeIri`, or null when the gate must refuse the publish.
 *
 * Null is NOT "this shape constrains nothing" — `runConformanceGate` turns it into a 422
 * carrying `iep:shapeUnfetchable`. You cannot claim conformance to a shape you could not
 * read, so every path that gives up here fails the publish closed.
 */
/**
 * Render a thrown fetch failure so the WARN line says WHICH failure it was.
 *
 * ★ THIS IS THE REASON THE #260 OUTAGE COULD NOT BE DIAGNOSED. `err.message` alone
 * is the string `fetch failed` for every network-layer outcome — measured in the
 * relay's own runtime image, byte-identical at this call site:
 *
 *     the egress address screen firing  ->  "fetch failed", cause.code ERR_EGRESS_PRIVATE_ADDRESS
 *     DNS failure                       ->  "fetch failed", cause.code ENOTFOUND
 *     TLS failure                       ->  "fetch failed", cause.code ERR_TLS_CERT_ALTNAME_INVALID
 *
 * So the whole log record of an outage that stopped every shape-gated publish was
 * `fetch threw: fetch failed`, and "the connect failed" was an INFERENCE from a
 * string that cannot distinguish a broken connect from the SSRF screen correctly
 * refusing a target. `cause.code` is the only channel that separates them, because
 * undici puts the real error there and WHATWG `fetch` flattens everything above it.
 *
 * `cause.errors` is unwrapped too: exhausting Happy Eyeballs' candidate list yields
 * an AggregateError whose members carry the per-address codes, and "which addresses
 * did we actually try" is the question a family-selection regression turns on.
 */
export function describeFetchFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return err.message;
  const code = (cause as NodeJS.ErrnoException).code;
  const inner = (cause as { errors?: unknown }).errors;
  const members = Array.isArray(inner)
    ? inner.map(e => (e as NodeJS.ErrnoException)?.code ?? String(e)).join(',')
    : '';
  return `${err.message} | cause=${code ?? cause.name}: ${cause.message}`
    + (members ? ` | attempts=[${members}]` : '');
}

export async function fetchShapeBodyWith(
  shapeIri: string,
  deps: ShapeBodyDeps,
): Promise<string | null> {
  const cached = deps.cache.get(shapeIri);
  if (cached && cached.expiresAt > Date.now()) return cached.body;
  // ★ DO NOT DELETE the stale entry — it is the last-known-good fallback used below.
  // Deleting here made that fallback dead code, so fail-closed would have shipped with
  // no mitigation at all: one transient blip on a shape host would 422 every publish
  // to that pod for as long as it lasted.

  let page: FetchedShapeRepresentation | null = null;
  let body: string | null = null;
  let warnReason: string | null = null;
  // Only a TRANSIENT failure may fall back to a stale body. A 404/403/410 is the shape
  // owner deleting or tightening the shape, and honouring a cached permissive copy for
  // 24h after that would be worse than the bug this fixes.
  let transient = false;
  try {
    // ★ THE GUARDED FETCH, NOT A RAW ONE. shapeIri comes from the caller's
    // `conforms_to_shapes` argument, so an unguarded fetch here is a caller-directed
    // SSRF that runs BEFORE the scope gate — loopback, `.internal` hosts and cloud
    // metadata endpoints were all reachable. Same guard every other caller-URL fetch
    // in the relay already uses, and the hop below reuses this same function so the
    // second request is screened exactly like the first.
    page = await deps.fetchRepresentation(shapeIri);
    if (page.ok) {
      if (page.body && page.body.trim().length > 0) {
        body = page.body;
      } else {
        warnReason = `empty body (HTTP ${page.status})`;
      }
    } else {
      warnReason = `HTTP ${page.status} ${page.statusText}`;
      transient = page.status >= 500 || page.status === 429 || page.status === 408;
    }
  } catch (err) {
    transient = true;   // network throw / timeout / DNS
    // Network failures → treat as missing shape, but record the cause so a
    // misconfigured / unreachable shape can't masquerade as "no shape declared".
    // WARN-logged below, NOT silently swallowed.
    warnReason = `fetch threw: ${describeFetchFailure(err)}`;
  }

  // ★ FOLLOW THE PAGE'S OWN ADVERTISED TURTLE — through the SHARED follower.
  //
  // GitHub Pages ignores Accept and serves text/html for our own ontology IRIs, so a
  // perfectly good shape looked unreachable and an owl:imports of one corrupted the graph
  // it was glued into. The reflex fix is to append `.ttl`; that reinvents a mechanism the
  // publishing side already implements correctly — every page we generate carries
  //
  //     <link rel="alternate" type="text/turtle" href="iep.ttl" />
  //
  // …and guessing an extension only ever works for publishers that spell things the way we
  // do. What is followed is what the PAGE says about itself.
  //
  // Calling the follower unconditionally is the point: it is the identity on a body that is
  // already Turtle, and the alternative — testing `looksLikeHtml` here first — puts the HTML
  // predicate back at this call site, which is the duplication the shared module exists to
  // remove.
  if (body !== null && page !== null) {
    // The page as the follower sees it: the body we accepted above, at the URL it LANDED at.
    const followed = await followAlternateTurtle(
      { status: page.status, url: page.url, contentType: page.contentType, body },
      deps.fetchRepresentation,
    );
    if ('why' in followed) {
      // ★ THE PAGE ANSWERED 200 AND THEN THE HOP FAILED — CLASSIFIED PERMANENT, as it was
      // before this moved. A live document saying its Turtle is somewhere unreachable (gone,
      // foreign, redirected away) is the shape being withdrawn, not a blip; `transient` is
      // left at whatever the page fetch set it to, which for a 200 is false. Treating it as
      // transient would keep a stale permissive body alive for 24h behind a hop that whoever
      // controls the page can break at will.
      warnReason = followed.why;
      body = null;
    } else if (followed.representation.body.trim().length > 0) {
      if (followed.hops > 0) {
        deps.log(
          `conformance gate: ${shapeIri} served HTML; followed its rel=alternate to `
          + `${followed.representation.url}`,
        );
      }
      body = followed.representation.body;
      warnReason = null;
    } else {
      // A blank 200 at the advertised URL is not a shapes graph. Reached only via a hop —
      // a blank FIRST body never gets here (it is refused as `empty body` above).
      warnReason = `the Turtle it advertises at <${followed.representation.url}> is blank`;
      body = null;
    }
  }

  if (body === null && warnReason !== null) {
    // ★ This sentence used to read "Publish will proceed UNVALIDATED against this shape."
    // That was true when the gate failed OPEN; it has failed CLOSED since PR #210, and the
    // caller now gets a 422 carrying iep:shapeUnfetchable. Caught by reading the live logs
    // beside the live response and seeing them contradict each other. A security gate whose
    // log states the opposite of what it did is worse than one that logs nothing — it tells
    // whoever is debugging an outage to go looking in precisely the wrong place.
    deps.log(`WARN conformance gate could not fetch shape ${shapeIri} — ${warnReason}. Publish is REFUSED (422 shapeUnfetchable); the gate fails closed.`);
  }

  // ★ NEVER CACHE A FAILURE. Storing `body: null` memoised "this shape does not
  // constrain anything" for the whole TTL, so one transient blip disabled a contract
  // for every subsequent publish without even retrying. Only successes are cached.
  //
  // A cached success also doubles as LAST-KNOWN-GOOD: if a later fetch fails we fall
  // back to the body we previously verified rather than refusing the publish, so a
  // network blip degrades to "validated against a slightly stale shape" instead of an
  // outage. The fallback is deliberately generous because the alternative — failing the
  // publish — is the worse error for a transient fault.
  if (body === null) {
    if (transient && cached?.body && cached.knownGoodUntil > Date.now()) {
      deps.log(`WARN conformance gate: ${shapeIri} unreachable (${warnReason}); validating against last-known-good body`);
      return cached.body;
    }
    // A permanent failure evicts, so a deleted shape stops being honoured.
    if (!transient && cached) deps.cache.delete(shapeIri);
    return null;
  }
  // ★ Only stamp known-good on a body that actually PARSES as a shapes graph. Any
  // non-empty 200 used to qualify — including an HTML error page, which is not
  // hypothetical: GitHub Pages ignores Accept and serves HTML for our own shape IRIs.
  // Pinning that for 24h would be pinning a shape that constrains nothing.
  const parses = deps.parsesAsShapesGraph(body);
  if (deps.cache.size >= deps.cacheMax) {
    const oldestKey = deps.cache.keys().next().value;
    if (oldestKey !== undefined) deps.cache.delete(oldestKey);
  }
  deps.cache.set(shapeIri, {
    body,
    expiresAt: Date.now() + deps.freshTtlMs,
    knownGoodUntil: parses ? Date.now() + deps.knownGoodTtlMs : 0,
  });
  return body;
}
