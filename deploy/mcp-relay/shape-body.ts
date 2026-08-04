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
import {
  ERR_EGRESS_PRIVATE_ADDRESS,
  ERR_EGRESS_TARGET_REFUSED,
} from './url-rewrite.js';

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

/**
 * WHY the gate could not obtain a shape body.
 *
 * ★ THE FACT THE 422 USED TO THROW AWAY. `fetchShapeBodyWith` returns `string | null`, so
 * everything it learned about the failure died at the boundary and every cause reached the
 * caller as the identical `shapeUnfetchable` envelope. Measured on the live relay:
 * `conforms_to_shapes: ["https://10-0-0-5.nip.io/s.ttl"]` and a plain 404 produced
 * BYTE-IDENTICAL responses, while the discriminating fact — the egress screen refusing to
 * open a socket to private space — survived only in a WARN log the caller cannot read.
 *
 * That is the same defect the shared-workspace stream mapper had one layer up: an
 * instrument that says the same word for "your input is wrong" and "I could not check your
 * input" is evidence for neither, and a verifier reading it reports a PASS for the wrong
 * reason. `reason` is for the operator, `egressRefused` is the machine-readable split.
 */
export interface ShapeFetchFailure {
  /**
   * The operator-facing rendering — the same text the WARN line carries. MAY name resolved
   * addresses, internal hosts and CSS paths, so it is for the log, NEVER for the envelope.
   */
  readonly reason: string;
  /**
   * True only when the relay REFUSED to send the request because the target is in, or
   * resolves into, private/internal address space — as opposed to the request being sent
   * and failing. Determined from the error's `code`, never from its message: WHATWG `fetch`
   * flattens every network outcome to the message `fetch failed`, so the message cannot
   * tell a refusal from a DNS miss.
   */
  readonly egressRefused: boolean;
}

/**
 * Did the egress screen REFUSE this target, rather than the request being sent and failing?
 *
 * Reads `code` at both levels the two screen halves raise it:
 *  - the SYNTACTIC screen throws directly, so the code is on the error itself;
 *  - the connect-time RESOLVER refuses inside `fetch`, which wraps it — WHATWG `fetch`
 *    reports `TypeError: fetch failed` and hangs the real error off `cause`.
 *
 * `cause.errors` is walked too: exhausting Happy Eyeballs' candidate list yields an
 * AggregateError whose MEMBERS carry the per-address codes, so a refusal on a multi-homed
 * name is only visible one level further down.
 */
export function isEgressRefusal(err: unknown): boolean {
  const codes = new Set<string>([ERR_EGRESS_PRIVATE_ADDRESS, ERR_EGRESS_TARGET_REFUSED]);
  const codeOf = (e: unknown): string | undefined =>
    typeof e === 'object' && e !== null
      ? (e as NodeJS.ErrnoException).code
      : undefined;
  if (codes.has(codeOf(err) ?? '')) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (codes.has(codeOf(cause) ?? '')) return true;
  const members = (cause as { errors?: unknown } | undefined)?.errors;
  return Array.isArray(members) && members.some(m => codes.has(codeOf(m) ?? ''));
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
  /**
   * Called EXACTLY when this function is about to return null — i.e. when the gate will
   * refuse the publish — with why.
   *
   * ★ A CALLBACK RATHER THAN MODULE STATE, ON PURPOSE. The reflex fix for "the reason
   * cannot escape a `string | null` return" is a module-level map keyed by shape IRI. Two
   * concurrent publishes naming the same shape would then race, and the loser would attach
   * the winner's reason to its own 422 — a WRONG attribution, which for a security-relevant
   * refusal is worse than the no-attribution state this replaces. The callback closes over
   * the caller's own stack frame, so a second publish structurally cannot read the first's.
   *
   * Optional so every existing `ShapeBodyDeps` literal still type-checks; a caller that
   * does not pass it gets exactly the previous behaviour.
   *
   * NOT called when a transient failure falls back to a last-known-good body: nothing is
   * refused on that path, and reporting a failure for a publish that SUCCEEDED would put
   * the same class of lie back in, pointing the other way.
   */
  readonly recordFailure?: (failure: ShapeFetchFailure) => void;
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
  // Set only by the catch below. A non-ok HTTP status or a failed alternate hop means the
  // request WAS sent, so neither can be an egress refusal — the screen fires before a
  // socket exists.
  let egressRefused = false;
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
    // ★ Classified HERE, off the live error object, not later off the rendered string.
    // `warnReason` is prose assembled for humans; re-parsing it downstream would make a
    // reword silently reclassify a security refusal as a generic outage.
    egressRefused = isEgressRefusal(err);
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
    // The refusal is now final, so hand the caller WHY. Guarded on `warnReason` because a
    // reason it does not have must not be invented: every path that nulls `body` sets one,
    // and if a future one does not, the gate falls back to the generic constraint rather
    // than reporting a confident-looking empty string.
    if (warnReason !== null) deps.recordFailure?.({ reason: warnReason, egressRefused });
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

/**
 * Namespace for gate-emitted constraint components. A dereferenceable URL, not a `urn:` —
 * the same principle the substrate applies to every other identifier it mints. Every local
 * name concatenated below is declared in `docs/ns/iep.ttl`, which is what this URL serves.
 *
 * ★ IT ENDS AT THE `#`, AND THAT IS NOT COSMETIC. It used to end at `…#shape` with the call
 * sites spelling only the tail (a template literal over the constant plus `Unfetchable`).
 * The IRIs came out identical, so nothing was WRONG at runtime — but
 * `tools/ontology-lint.mjs` reads template emissions over a namespace constant to check
 * every owned-namespace term is declared, and
 * a constant carrying half the local name made the real term name unspellable to it. Both
 * pre-existing components were therefore invisible to the gate that exists to catch exactly
 * this, and neither was declared anywhere. Splitting at the `#` makes the emitted local name
 * literal in the source, so the lint can see it and CI fails if it is not in the ontology.
 */
export const PUBLIC_SHAPE_NS = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';

/** One SHACL-style result body: the machine-readable constraint plus its sentence. */
export interface ShapeUnfetchableViolation {
  readonly constraintComponent: string;
  readonly message: string;
}

/**
 * What the caller is told when a declared shape could not be read — WITH the cause.
 *
 * ── WHY THE CAUSE GETS ITS OWN CONSTRAINT COMPONENT ──────────────────────────
 *
 * Three different facts, three different operator responses, and a message tweak would not
 * carry any of them across a machine boundary:
 *
 *   shapeUnfetchableScheme        the IRI can NEVER be fetched (not https). A configuration
 *                                 error in the caller's own declaration; fix the IRI.
 *   shapeUnfetchable              the request was SENT and did not yield a shape — 404, 5xx,
 *                                 timeout, a page whose advertised Turtle is gone. Either
 *                                 the shape host is down or the shape was withdrawn.
 *   shapeUnfetchableEgressRefused NO REQUEST WAS SENT. The relay's SSRF screen refused the
 *                                 target because it is in, or resolves into, private space.
 *                                 Nothing about the shape host is known or implied, and no
 *                                 amount of waiting or retrying changes it.
 *
 * The third is the one this function was written for. It is not a variant of the second: a
 * caller retrying "an outage" forever, and an operator hunting a network fault that never
 * happened, are both consequences of collapsing a refusal into an outage.
 *
 * ── WHAT AN ANONYMOUS CALLER LEARNS, DELIBERATELY BOUNDED ────────────────────
 *
 * The message names the shape IRI — which is the CALLER'S OWN INPUT — and the class of
 * refusal. It carries NO resolved address, NO internal hostname and NO CSS path. Those live
 * in `ShapeFetchFailure.reason`, which goes to the WARN log only.
 *
 * The tempting exception — echoing the resolved address when the caller "already knows" it,
 * as with `10-0-0-5.nip.io` — is declined. It is only already-known for names that ENCODE
 * their address; for `something.railway.internal`, or for a DNS-rebinding probe pointed at a
 * name the attacker does not control the records of, the resolved address is precisely the
 * internal-topology fact they came to learn. Telling the two apart needs a heuristic, and a
 * heuristic that is wrong once is a disclosure with no way back. The caller loses nothing:
 * they can resolve their own hostname. So the CONSTRAINT discriminates and the MESSAGE stays
 * topology-free.
 */
export function shapeUnfetchableViolation(
  shapeIri: string,
  failure: ShapeFetchFailure | null,
): ShapeUnfetchableViolation {
  // Scheme first, and unchanged: a non-https IRI is unfetchable for a reason that makes
  // every other classification moot — no screen and no network was ever consulted.
  if (!/^https:\/\//i.test(shapeIri)) {
    return {
      constraintComponent: `${PUBLIC_SHAPE_NS}shapeUnfetchableScheme`,
      message: `Declared shape ${shapeIri} could not be fetched, so conformance cannot be asserted. `
        + 'The publish was refused rather than proceeding unvalidated.',
    };
  }
  if (failure?.egressRefused === true) {
    return {
      constraintComponent: `${PUBLIC_SHAPE_NS}shapeUnfetchableEgressRefused`,
      message: `Declared shape ${shapeIri} was NOT fetched: this relay refused to connect to it `
        + 'because its host is, or resolves into, private or internal address space. No request '
        + 'was sent, so nothing is known about that host. This is not an outage and retrying will '
        + 'not clear it — declare a shape on a publicly reachable host. The publish was refused '
        + 'rather than proceeding unvalidated.',
    };
  }
  return {
    constraintComponent: `${PUBLIC_SHAPE_NS}shapeUnfetchable`,
    message: `Declared shape ${shapeIri} could not be fetched, so conformance cannot be asserted. `
      + 'The publish was refused rather than proceeding unvalidated.',
  };
}
