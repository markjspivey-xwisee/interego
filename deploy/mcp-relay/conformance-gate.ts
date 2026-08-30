/**
 * The SHACL conformance gate: fetch a container's declared shapes, follow owl:imports, and
 * decide whether a document conforms before it is published.
 *
 * ★★ EXTRACTED FROM server.ts, WHICH WAS 17,366 LINES. A friction census measured why that
 * matters and it is not ceremony: commits touching one of the six files nobody can hold in
 * context cost a median 40.2 min against 18.5 for commits touching neither — about 96 hours since
 * July. This region was chosen by MEASUREMENT rather than by size: of every banner section in
 * server.ts it had the lowest inbound coupling, needing exactly ONE identifier from its old home
 * (`log`) and registering ZERO routes, so there is no ordering invariant to preserve.
 *
 * ★ THE TWO SECTIONS THAT WERE SUPPOSED TO GO NEXT DID NOT SURVIVE THE SAME MEASUREMENT. The
 * X402 surface is 326 lines but needs 28 identifiers from server.ts — TOOLS, TOOL_SCHEMAS,
 * AUTH_REQUIRED_TOOLS, mcpGate, dynamicTools among them — and /audit/* is 1,293 lines needing 24.
 * Both were named as the next clean lifts on line count alone. A factory with a 28-field deps
 * object is not an extraction; it is the same coupling with a longer signature.
 *
 * ★ `log` IS INJECTED RATHER THAN IMPORTED, so this module has no path back to server.ts and
 * cannot form a cycle — the shape ns-dereference.ts established in 471b7497.
 */
import { validateAgainstShape, type ShaclResult } from '@interego/core';

import {
  fetchShapeBodyWith, shapeUnfetchableViolation,
  type FetchedShapeRepresentation, type ShapeBodyCacheEntry, type ShapeFetchFailure,
} from './shape-body.js';
import {
  iriObjectsOf, emptyShapesGraphViolation, refusesEmptyShapesGraph,
  type ShapeCoverage,
} from './shapes-declared.js';
import type { createEgress } from './egress.js';
import { normalizeCssUrl } from './url-rewrite.js';

/** ★ Typed FROM the thing that builds them, so a signature change here is a compile error
 *  rather than a guess that drifts. All three come from `createEgress()` in egress.ts. */
type Egress = ReturnType<typeof createEgress>;

export interface ConformanceGateDeps {
  readonly log: (msg: string) => void;
  /**
   * ★ THE THREE FETCHERS ARE INJECTED, NOT IMPORTED, and that is the whole reason this module has
   * no path back to server.ts. `solidFetch` carries the relay's own credential and
   * `guardedInvokeFetch` is the SSRF screen every caller-supplied URL goes through — both live in
   * server.ts beside the config they read. Importing them would make this file depend on the file
   * it was extracted from, which is a cycle wearing a different name.
   */
  readonly solidFetch: Egress['solidFetch'];
  readonly guardedInvokeFetch: Egress['guardedInvokeFetch'];
  readonly guardedInvokeFetchLanded: Egress['guardedInvokeFetchLanded'];
}

export interface ConformanceGate {
  readonly fetchContainerShapes: ReturnType<typeof build>['fetchContainerShapes'];
  readonly runConformanceGate: ReturnType<typeof build>['runConformanceGate'];
}

function build(deps: ConformanceGateDeps) {
  const log = deps.log;
  const solidFetch = deps.solidFetch;
  const guardedInvokeFetch = deps.guardedInvokeFetch;
  const guardedInvokeFetchLanded = deps.guardedInvokeFetchLanded;

  // ── Conformance gate (SHACL) ────────────────────────────────
  //
  // FIX 4 — at publish time, look up `iep:conformsTo <shapeIri>` triples
  // declared on the target pod's container metadata, fetch each shape,
  // and validate the inbound graph_content against it. On non-conformance
  // reject 422 BEFORE the CSS write so a violating descriptor never lands
  // on the pod. Cached per-podUrl to avoid the manifest GET on every
  // publish.
  //
  // Container-shape lookup precedence:
  //   1. <container>.well-known/container-shape  (Turtle, listing
  //      iep:conformsTo IRIs as iep:declares-shape triples — purpose-built
  //      home for shape declarations that isn't tied to the manifest CAS
  //      dance).
  //   2. The pod manifest (.well-known/context-graphs) — any iep:conformsTo
  //      / dct:conformsTo on the manifest collection subject is treated
  //      as a container-level declaration.
  //
  // Either source is fine; #1 is preferred because it doesn't compete with
  // publish() for manifest etags.
  const CONTAINER_SHAPE_CACHE_TTL_MS = 60 * 1000;
  /**
   * How long a previously-VERIFIED shape body stays usable as a fallback when a refetch
   * fails. Deliberately much longer than the freshness TTL: the choice on a transient
   * fetch failure is between validating against a slightly stale contract and refusing
   * the publish outright, and the stale contract is the better error. Beyond this the
   * gate fails closed.
   */
  const KNOWN_GOOD_TTL_MS = 24 * 60 * 60 * 1000;
  // The namespace for gate-emitted constraint components moved to `shape-body.ts` with the
  // violation constructor that spells them, so the emitted local names are literal in a file
  // a test can import and `tools/ontology-lint.mjs` can read.
  const CONTAINER_SHAPE_CACHE_MAX = 256;
  const containerShapeCache = new Map<string, { shapes: readonly string[]; expiresAt: number }>();
  const shapeBodyCache = new Map<string, ShapeBodyCacheEntry>();

  async function fetchContainerShapes(podUrl: string): Promise<readonly string[]> {
    const cached = containerShapeCache.get(podUrl);
    if (cached && cached.expiresAt > Date.now()) return cached.shapes;
    if (cached) containerShapeCache.delete(podUrl);

    const shapes = new Set<string>();
    const containerShapeUrl = `${podUrl.replace(/\/$/, '')}/.well-known/container-shape`;
    try {
      // Derived from podUrl, which is caller-influenced — same guard.
      const r = await guardedInvokeFetch(containerShapeUrl, { method: 'GET', headers: { 'Accept': 'text/turtle' } });
      if (r.ok) {
        const body = await r.text();
        // ★★ SAME SCANNER AS `owl:imports`, FOR THE SAME REASON. These were three
        // `/…\s+<([^>]+)>/g` regexes, which read every OCCURRENCE of the predicate but only the
        // FIRST object of each — so a container declaring `dct:conformsTo <a> , <b> , <c>` had
        // two of its three contracts never fetched and never run, while the publish still
        // answered that the gate had passed. A pass for a contract nobody read is this round's
        // whole defect class. The token boundary in `iriObjectsOf` is also what keeps
        // `iep:conformsToShape` — which descriptors in this repo really do carry — from being
        // read as a container declaration and sent to the fetcher as a `urn:`.
        for (const p of ['iep:conformsTo', 'dct:conformsTo', 'iep:declares-shape']) {
          for (const iri of iriObjectsOf(body, p)) shapes.add(iri);
        }
      }
    } catch { /* ignore — fall through to manifest scan */ }

    if (shapes.size === 0) {
      const manifestUrl = `${podUrl.replace(/\/$/, '')}/.well-known/context-graphs`;
      try {
        const r = await solidFetch(manifestUrl, { method: 'GET', headers: { 'Accept': 'text/turtle' } });
        if (r.ok) {
          const body = await r.text();
          // Restrict the scan to the manifest collection's own subject —
          // we only want CONTAINER-level conformance, not random conformsTo
          // triples on individual ManifestEntry rows (which belong to
          // descriptors, not to the container).
          //
          // ── ★★ AND "ITS OWN SUBJECT" IS WHAT THE MATCH HAD TO BE MADE TO MEAN ─────────
          //
          // This was `<url>[\s\S]*?(?=\n<|$)` — unanchored, so it found the FIRST occurrence
          // of the URL anywhere in the document, in object position as readily as in subject
          // position. DRIVEN against the real relay: a manifest whose descriptor row read
          // `<…/ctx/row> a iep:ContextDescriptor ; dct:isPartOf <manifestUrl> ; dct:conformsTo
          // <decoy> .` ABOVE the collection's own statement made the "collection block" the
          // tail of that row — `<manifestUrl> ;\n dct:conformsTo <decoy> .` — and the publish
          // came back 422 on a MinCount violation from the DECOY, one descriptor's contract,
          // while the collection's real contract was never fetched. Both failure directions
          // at once: closed on a contract nobody declared at container level, open on the one
          // that was. Relay-written manifests put the collection subject first and so were
          // safe, but this branch exists for the hand-authored and foreign manifests where
          // document order is not ours.
          //
          // ★ TWO GUARDS, BOTH ABOUT SUBJECT POSITION, NEITHER A PARSE. `(?:^|\n)` requires
          // the URL to start a line — the same assumption the terminator `(?=\n<)` has always
          // made about where the NEXT subject starts, so the two halves now agree. And an IRI
          // at the start of a line can still be an object (a wrapped list); a subject is
          // always followed by a predicate, so the lookahead refuses `;` `,` `.` `]`, which
          // is every punctuation an object position can be followed by. What neither guard
          // buys is a second statement block about the same subject later in the document:
          // `.match` reads the first, as it always has.
          const escapedManifest = manifestUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const collectionBlock = body.match(
            new RegExp(`(?:^|\\n)(<${escapedManifest}>(?=\\s*[^\\s;,.\\]])[\\s\\S]*?)(?=\\n<|$)`),
          )?.[1];
          if (collectionBlock) {
            // Object-list aware, like the container-shape scan above — a manifest collection
            // that declares two profiles in one list must not have the second one dropped.
            for (const p of ['iep:conformsTo', 'dct:conformsTo']) {
              for (const iri of iriObjectsOf(collectionBlock, p)) shapes.add(iri);
            }
          }
        }
      } catch { /* ignore — pod has no manifest yet */ }
    }

    const result = Object.freeze([...shapes]);
    if (containerShapeCache.size >= CONTAINER_SHAPE_CACHE_MAX) {
      const oldestKey = containerShapeCache.keys().next().value;
      if (oldestKey !== undefined) containerShapeCache.delete(oldestKey);
    }
    containerShapeCache.set(podUrl, { shapes: result, expiresAt: Date.now() + CONTAINER_SHAPE_CACHE_TTL_MS });
    return result;
  }

  // FIX A — Accept header for shape fetches.
  //
  // Advertises every serialization the in-process SHACL engine can
  // parse: parseTrig handles turtle + trig uniformly, and n-quads is
  // line-oriented quads that the TriG parser tolerates (each quad-line
  // terminates with a `.`). Without this header, a strict server
  // (CSS quad-store config, an nginx negotiator, or any reverse proxy)
  // facing a shape PUT'd as application/trig answers 406 Not Acceptable
  // for `text/turtle`-only requests — and the gate then silently lets
  // the publish through because fetchShapeBody returns null. JSON-LD is
  // advertised at low q so a JSON-LD-stored shape can at least signal
  // its presence; the parser will fail JSON-LD bodies but the WARN
  // below makes the miss observable rather than invisible.
  const SHAPE_ACCEPT_HEADER =
    'text/turtle, application/trig;q=0.9, application/n-quads;q=0.8, application/ld+json;q=0.7';

  /**
   * One shape representation, fetched through the SSRF screen and carrying the URL it
   * LANDED at.
   *
   * ★ THE LANDED URL IS THE POINT. `fetchShapeBodyWith` resolves the page's advertised
   * `rel=alternate` href against this URL and refuses an alternate on a different origin.
   * Handing it `shapeIri` instead would be wrong in BOTH directions: `normalizeCssUrl`
   * rewrites a legacy public CSS host to its `.internal.` form, so every pod-hosted shape
   * would look cross-origin and be refused, and a redirect chain would be invisible to the
   * origin comparison it exists to make.
   */
  async function fetchShapeRepresentation(url: string): Promise<FetchedShapeRepresentation> {
    const { response, landedUrl } = await guardedInvokeFetchLanded(
      url, { method: 'GET', headers: { 'Accept': SHAPE_ACCEPT_HEADER } },
    );
    // ★ THE ERROR BODY IS NOT READ, AND THAT IS NOT TIDINESS. `shapeIri` is a caller argument,
    // so the host answering it is caller-chosen; `solidFetch` bounds the request by TIME but not
    // by SIZE. Buffering the body of a 500 would let any caller point the gate at a host that
    // streams an arbitrarily large error page and have the relay hold it in memory — on a relay
    // whose OOM shows up as generic 502s with empty logs. Nothing downstream reads it either:
    // a non-ok first response never becomes a shape body, and the follower refuses any hop that
    // is not exactly 200 before it touches `body`.
    const body = response.ok ? await response.text() : '';
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: landedUrl,
      contentType: response.headers?.get('content-type') ?? null,
      body,
    };
  }

  /**
   * The shape body the conformance gate validates against.
   *
   * ★ THE WHOLE OF THIS FUNCTION LIVES IN `shape-body.ts`. It followed a page's
   * `rel=alternate` with an inline copy of the hop that did NOT refuse a cross-origin
   * alternate — a shape whose HTML page advertised a FOREIGN ORIGIN's Turtle had that
   * document fetched and used as the publish gate. Fixing it in place was not enough: this
   * module opens a listener on import, so no unit test can reach anything defined here, and a
   * live run against production only ever exercises the honest path. The cache, the
   * last-known-good fallback, the transient/permanent split and the hop moved out together —
   * they are one behaviour — and this is now the binding that supplies them with the relay's
   * guarded fetch and SHACL parser.
   */
  /**
   * A shape body, plus WHY there is not one.
   *
   * ★ THE PAIR, NOT A SHARED SLOT. `failure` has to reach `runConformanceGate` so the 422 can
   * say which cause it hit, and the reflex plumbing for that — a module-level map keyed by
   * shape IRI — races: two concurrent publishes naming the same shape can read each other's
   * reason, and a MISATTRIBUTED security refusal is worse than the missing one it replaces.
   * Returning the pair keeps the reason on the caller's own stack, where a second publish
   * structurally cannot see it.
   */
  interface FetchedShapeBody {
    readonly body: string | null;
    /** Non-null only when `body` is null AND the fetch layer recorded a cause. */
    readonly failure: ShapeFetchFailure | null;
  }

  /**
   * ★★ AN UNFETCHABLE IMPORT MUST NOT BE LOGGED AS A REFUSAL, BECAUSE IT IS NOT ONE.
   *
   * `shape-body.ts` ends its give-up path with "Publish is REFUSED (422 shapeUnfetchable); the
   * gate fails closed." — true for a shape the caller NAMED, and false for an `owl:imports`
   * target, which `withImports` drops as non-fatal. Observed on a live run of the very call this
   * round was repairing: `docs/ns/harness.ttl` imports `http://www.w3.org/ns/prov-o`, the egress
   * guard refuses `http:`, and the operator log read
   *
   *     WARN … could not fetch shape http://www.w3.org/ns/prov-o … Publish is REFUSED (422 …)
   *     WARN … owl:imports http://www.w3.org/ns/prov-o … unreachable — continuing without it
   *
   * — a refusal announced on one line and contradicted on the next, on a publish that returned
   * 200. An operator who greps for the first line goes hunting a 422 that never happened. Same
   * class as everything else in this round: a message answering a question nobody asked here.
   *
   * Rewritten at THIS call site rather than in `shape-body.ts`, because the sentence is correct
   * for that module's other caller and the thing that differs is who is asking.
   */
  function importLog(line: string): void {
    log(line.replace(
      /Publish is REFUSED \(422 shapeUnfetchable\); the gate fails closed\./,
      'This is an owl:imports target, so it is DROPPED and the publish continues — see the '
      + 'next line for what was lost.',
    ));
  }

  async function fetchShapeBody(shapeIri: string, forImport = false): Promise<FetchedShapeBody> {
    let failure: ShapeFetchFailure | null = null;
    const body = await fetchShapeBodyWith(shapeIri, {
      fetchRepresentation: fetchShapeRepresentation,
      // ★ Only a body that actually PARSES as a shapes graph earns known-good status. Any
      // non-empty 200 used to qualify — including an HTML error page, which is not
      // hypothetical: GitHub Pages ignores Accept and serves HTML for our own shape IRIs.
      parsesAsShapesGraph: (body: string) => validateAgainstShape('', body).results
        .every(r => r.constraintComponent !== `${'http://www.w3.org/ns/shacl#'}ShapeGraphParseFailure`),
      log: forImport ? importLog : log,
      cache: shapeBodyCache,
      cacheMax: CONTAINER_SHAPE_CACHE_MAX,
      freshTtlMs: CONTAINER_SHAPE_CACHE_TTL_MS,
      knownGoodTtlMs: KNOWN_GOOD_TTL_MS,
      // Fires only on the paths that return null — for a caller- or container-named shape that
      // means the gate is about to refuse; for an import it means the import is dropped.
      recordFailure: f => { failure = f; },
    });
    return { body, failure };
  }

  /**
   * Resolve `owl:imports` and append the imported graphs to the shapes text.
   *
   * ★ WHY THIS LIVES AT THE GATE AND NOT IN THE VALIDATOR. Following an import means a
   * network fetch, and a validator that reaches the network is no longer a pure function —
   * it becomes untestable offline and acquires an SSRF surface of its own. The gate already
   * fetches shape bodies, already has the guard, and already has the cache, so resolution
   * belongs here and the validator stays something you can reason about.
   *
   * ★ WHY IT MATTERS. Our shape files carry no rdfs:subClassOf; the hierarchy lives in the
   * ontology they import (iep-shapes.ttl -> iep.ttl). Without following the import the
   * subclass closure is empty for every published contract, so entailment sees nothing and
   * an attacker escapes a class-targeted shape by simply not declaring the subclass triple
   * in their own data.
   *
   * Bounded on every axis that could be turned into a weapon: one level deep (an import of
   * an import is not followed), a small fan-out cap, the same guarded fetch and cache as
   * shape bodies, and a failure to fetch an import is NON-fatal — an import is
   * supplementary vocabulary, not the contract itself, so losing it must not refuse a
   * publish the way losing the shape does.
   */
  const MAX_IMPORTS = 8;
  async function withImports(shapeTurtle: string | null, shapeIri: string): Promise<string | null> {
    if (!shapeTurtle) return shapeTurtle;
    const targets: string[] = [];
    // ★★ THE OBJECT LIST, NOT ONLY ITS FIRST MEMBER. This read
    // `shapeTurtle.matchAll(/owl:imports\s+<([^>]+)>/g)`, which collects one object per
    // OCCURRENCE of the predicate and therefore stopped at the first comma. `docs/ns/harness.ttl`
    // imports prov-o, pgsl and iep as one list, so only prov-o was followed — and prov-o is
    // `http:`, refused by the egress guard on scheme and then dropped as non-fatal. The merged
    // body was harness.ttl alone, `shapesDeclared` was 0, and the caller-side refusal below fired
    // on our own writers. Driven against this server with a fixture pod: 422 before, published
    // with declared=41 after. See `iriObjectsOf` for the measurement and the parser's bounds.
    for (const t of iriObjectsOf(shapeTurtle, 'owl:imports')) {
      if (t && t !== shapeIri && !targets.includes(t)) targets.push(t);
      if (targets.length >= MAX_IMPORTS) break;
    }
    if (targets.length === 0) return shapeTurtle;
    const parts = [shapeTurtle];
    for (const t of targets) {
      // An import's failure REASON is deliberately dropped: losing an import is non-fatal
      // (see the header), so there is no refusal for it to explain. The log line below is
      // the whole of the operator's signal here.
      const { body } = await fetchShapeBody(t, true);
      // ★ AN IMPORT THAT IS NOT TURTLE MUST BE DROPPED, NOT APPENDED.
      //
      // Content negotiation does not save us: GitHub Pages ignores Accept and serves HTML
      // for our own ontology IRIs, so `owl:imports <…/ns/iep>` returns a web page. Appending
      // it made the CONCATENATED graph unparseable, which turned a shape that validated
      // perfectly well into a hard 422 — a shape body is only as good as the worst thing
      // glued to it. Verified live: this exact URL broke iep-shapes.ttl.
      //
      // Parsing it here costs one parse and converts a fatal corruption into the same
      // non-fatal degradation an unreachable import already gets.
      const usable = body !== null && validateAgainstShape('', body).results
        .every(r => !/ShapeGraphParseFailure/.test(r.constraintComponent));
      if (usable) parts.push(`
  # ── owl:imports ${t} ──
  ${body}`);
      else if (body !== null) log(`WARN conformance gate: owl:imports ${t} (from ${shapeIri}) is not parseable Turtle (likely an HTML representation) — continuing without it`);
      else log(`WARN conformance gate: owl:imports ${t} (from ${shapeIri}) unreachable — continuing without it`);
    }
    return parts.join('\n');
  }

  /**
   * Run every container-declared shape AND every caller-supplied shape
   * (via the MCP `conforms_to_shapes` arg) against the inbound graph_content.
   * Returns either { conforms: true, resolvedShapes } or the violation list
   * ready to surface in the 422 error envelope.
   *
   * ★ A MISSING SHAPE BODY REFUSES THE PUBLISH. This header used to end "Missing shape bodies
   * (404 etc.) are ignored — they can't constrain a publish if the relay can't fetch them",
   * which is the behaviour the ★ FAIL CLOSED branch forty lines below was written to remove and
   * is its exact inverse. The header outlived the fix and described a relay that no longer
   * exists — and it is load-bearing in both directions: `applications/shared-workspace`'s
   * `publishMembershipRecord` passes `conforms_to_shapes` precisely so a malformed authorization
   * record never lands, and its README rests on "shape-validated at publish". A reader who
   * believed this sentence would conclude an unreachable shape silently waves a record through.
   * You cannot claim conformance to a shape you could not read.
   *
   * Container-declared shapes (from .well-known/container-shape or the
   * pod's manifest collection's iep:conformsTo / dct:conformsTo triples)
   * AND caller-supplied shapes are both validated — any one failing rejects.
   * De-duplicated by IRI: if the same shape appears in both sources, it
   * runs once.
   *
   * `resolvedShapes` carries every (shapeIri, shapeTurtle) pair the gate
   * fetched, so the caller can re-thread the same bodies into the
   * substrate-level publish() gate (defense in depth — the gate is the
   * relay's fast-fail, the substrate gate is the kernel-level invariant)
   * without double-fetching.
   */
  async function runConformanceGate(
    podUrl: string,
    graphContent: string,
    callerShapeIris: readonly string[] = [],
  ): Promise<
    | {
        conforms: true;
        resolvedShapes: readonly { shapeIri: string; shapeTurtle: string }[];
        /**
         * What each resolved shape ACTUALLY constrained — so the response can tell a clean pass
         * from a pass against nothing. See the header of `shapes-declared.ts` for the measured
         * defect: before this existed, `conforms: true` with no results meant either, and the
         * caller had no field anywhere to tell them which. A success that ends the enquiry
         * without answering it is worse than a failure, because a failure sends you back to look.
         */
        coverage: readonly ShapeCoverage[];
      }
    | { conforms: false; shape: string; violations: readonly ShaclResult[] }
  > {
    const containerShapeIris = await fetchContainerShapes(podUrl);
    const seen = new Set<string>();
    const allShapes: string[] = [];
    for (const s of containerShapeIris) {
      if (!seen.has(s)) { seen.add(s); allShapes.push(s); }
    }
    for (const s of callerShapeIris) {
      if (!seen.has(s)) { seen.add(s); allShapes.push(s); }
    }
    if (allShapes.length === 0) return { conforms: true, resolvedShapes: [], coverage: [] };
    // ★ ATTRIBUTED BY MEMBERSHIP, NOT BY WHICH LOOP ADDED IT. The de-dup above keeps the
    // CONTAINER's copy when a shape appears in both sources, so reading the source off insertion
    // order would silently downgrade a caller-named document to the container's lenient
    // treatment — and the whole refuse/report split in `shapes-declared.ts` turns on that
    // attribution. If the caller named it, the caller owns it, however it also got here.
    const namedByCaller = new Set(callerShapeIris);
    const coverage: ShapeCoverage[] = [];
    const resolvedShapes: { shapeIri: string; shapeTurtle: string }[] = [];
    for (const shapeIri of allShapes) {
      // Per-iteration, per-call: `failure` never leaves this frame, so a concurrent publish
      // cannot read it. See `FetchedShapeBody`.
      const fetched = await fetchShapeBody(shapeIri);
      const shapeTurtle = await withImports(fetched.body, shapeIri);
      if (!shapeTurtle) {
        // ★ FAIL CLOSED. This used to `continue`, so a declared shape that 404'd,
        // timed out, or was simply unreachable was skipped and the publish returned
        // conforms:true — every contract was optional at the discretion of whoever
        // could make a shape unfetchable. You cannot claim conformance to a shape you
        // could not read.
        //
        // ★ AND IT NOW SAYS WHICH. Every cause used to arrive as one constraint component
        // with one sentence, so "I could not reach the shape host" and "I REFUSED to, the
        // target is private space" were byte-identical to the caller — measured live against
        // a nip.io shape IRI and a plain 404 on a public host. The reason is chosen from the
        // failure the fetch layer recorded, in a function a unit test can execute.
        const violation = shapeUnfetchableViolation(shapeIri, fetched.failure);
        return {
          conforms: false,
          shape: shapeIri,
          violations: [{
            focusNode: shapeIri,
            sourceShape: shapeIri,
            constraintComponent: violation.constraintComponent,
            severity: 'Violation',
            message: violation.message,
          }],
        };
      }
      // ★ ENFORCING. The observe period is over, and the reason it ended is not that the
      // logs went quiet — it is that the premise for observing was wrong.
      //
      // Observe mode existed because "entailment is a fleet change: publishes that pass
      // today start failing all at once." That was false. `packages/solid/src/client.ts`
      // ALREADY validates the very same imports-resolved shape bodies with
      // { entailment: 'rdfs' } and throws PublishShapeViolationError. Enforcement has been
      // on the whole time, one layer down. Every graph this gate would newly refuse is
      // already refused today — only later, and on the DEFAULT DEFERRED path silently,
      // after the caller has already been handed a 202 "pending" success.
      //
      // So this is not a rollout risk being accepted; it is a silent background failure
      // being converted into an honest synchronous 422. rdfs violations are a strict
      // superset of observe violations (the downgrade at shacl-engine only rewrites
      // severity), so nothing that passes today can start failing here that was not
      // already failing deeper.
      //
      // Measured blast radius, recomputed independently and adversarially re-verified:
      // iep:DescriptorCoreFacetShape additionally targets 10 iep: subclasses, and
      // iep:NotificationShape additionally targets iep:NotificationChannelOpen. Everything
      // else that intersects is sh:deactivated or a constraint-free stub, so inert.
      // ★ THE GATE'S SEVERITY POLICY, STATED RATHER THAN INHERITED.
      //
      // `conforms` used to mean "no sh:Violation" in this engine, everywhere, with no way to
      // ask for anything else. That was a misreading of §3.6 — which says ANY result — and
      // fixing it silently tightened every gate that reads the flag, including this one.
      //
      // Measured, on a shape this repo publishes: iep:AgentProvenanceConsistencyShape
      // declares `sh:severity sh:Warning` and its own prose says why — "Warning (not
      // violation) because there are legitimate ghost-write patterns (e.g. agent X proxying
      // for agent Y) where this is intentional". Under the corrected rule that Warning
      // refuses the publish, so a pattern the shape author explicitly permits would start
      // being rejected by a change that was about a boolean's definition.
      //
      // sh:conformanceDisallows is SHACL 1.2's answer: the severities that defeat
      // conformance are a property of the REQUEST, not of the engine. Declaring
      // ['Violation'] here preserves exactly the behaviour this gate has always had, and
      // says so out loud at the call site instead of relying on the engine to keep getting
      // a boolean wrong in a convenient direction. Warnings still travel in `results` —
      // they are advice, and the caller below already carries the notes forward.
      const report = validateAgainstShape(graphContent, shapeTurtle,
        { entailment: 'rdfs', conformanceDisallows: ['Violation'] });
      // ★★ WHAT THIS SHAPE ACTUALLY CONSTRAINED, RECORDED BEFORE THE VERDICT IS READ.
      //
      // `report.conforms` alone answered a question adjacent to the one asked: a document that
      // declares no shapes conforms trivially and reports IDENTICALLY to a real clean pass —
      // same `true`, same empty `results`, same `fullyChecked` — so a caller who named the
      // wrong URL was told their contract held when it had never run. Measured, one turn record
      // missing its required outcome: against `harness-shapes.ttl` conforms=false, against
      // `harness.ttl` (the ontology, 0 shapes) conforms=true.
      //
      // `declared` is taken here and not recomputed later because a second pass over the same
      // body is free to drift from this one, and nothing would fail when it did — the same
      // reason the engine records `liveShapeIds` inside its own validation loop.
      //
      // ★★ AND IT IS READ ONLY AFTER `report.conforms`, WHICH IS NOT COSMETIC ORDERING. An
      // UNPARSEABLE DATA GRAPH returns `conforms:false` with `shapesDeclared: 0`, because the
      // engine gives up before compiling anything. Testing the zero first — which is how this
      // block was first written — answered a malformed graph with "the shape you named declares
      // no shapes", sending the caller to fix a shape IRI that was never the problem. That is
      // the very defect class this unit exists to close, reintroduced one line further down, so
      // the real verdict is returned first and zero-declared is only ever read on a pass.
      if (!report.conforms) {
        return { conforms: false, shape: shapeIri, violations: report.results };
      }
      const cover: ShapeCoverage = {
        shapeIri,
        source: namedByCaller.has(shapeIri) ? 'caller' : 'container',
        declared: report.shapesDeclared,
        applied: report.shapesApplied,
      };
      coverage.push(cover);
      if (refusesEmptyShapesGraph(cover)) {
        // ★ REFUSED, NOT COUNTED — and only for a shape the CALLER named. A count is something
        // the caller must remember to assert on, and a caller who already suspected the problem
        // would not have named the wrong document in the first place; the refusal reaches
        // everyone who does not suspect it, which is the whole population this defect had.
        //
        // The container-declared side is deliberately NOT refused here: `dct:conformsTo` on a
        // pod is a profile assertion that in this system routinely names an ontology (23 of the
        // 33 documents in `docs/ns/` declare zero shapes — re-measured with the engine over every
        // one of them, because the figure this comment used to carry had never been run), the pod
        // owner is not the caller, and the repair would be a pod write this very 422 has just
        // locked out. It travels in `coverage.unenforced` instead — see `shapes-declared.ts` for
        // the measurement, and for the imports bug that made this refusal fire on our own writers.
        //
        // ★ THE FIGURE IS CHECKED, NOT JUST STATED. `tests/shapes-declared-not-silent.test.ts` §9
        // re-counts it and compares it to this sentence, because the wrong number sat here through
        // a review purely on the strength of reading well.
        const violation = emptyShapesGraphViolation(shapeIri);
        log(`WARN conformance gate: ${shapeIri} was fetched and parsed but declares NO SHACL shapes; the publish is REFUSED (422 shapeDeclaresNoShapes) rather than reporting a pass nothing was tested for.`);
        return {
          conforms: false,
          shape: shapeIri,
          violations: [{
            focusNode: shapeIri,
            sourceShape: shapeIri,
            constraintComponent: violation.constraintComponent,
            severity: 'Violation',
            message: violation.message,
          }],
        };
      }
      if (cover.declared === 0) {
        // Container-declared and shapeless: allowed through, but never silently. The operator
        // reading this line is the pod owner who can correct the declaration; the CALLER learns
        // the same fact from `conformance.unenforced` in the response.
        log(`WARN conformance gate: container-declared ${shapeIri} declares NO SHACL shapes, so it constrained nothing on this publish. Allowed because a pod's dct:conformsTo is a profile assertion and refusing it would lock the pod out of the write that would fix it.`);
      }
      // ★ Carry the Info notes forward. The engine emits UnsupportedConstraint precisely
      // so `conforms` cannot be mistaken for `was actually checked` — dropping them here
      // would have thrown away the signal one commit after adding it.
      //
      // ★ WHY THIS GATE IS NOT `conforms && report.fullyChecked` — RESTATED WITH THE MEASURED
      // SCOPE, because the previous statement of it was false. It said `fullyChecked` is
      // "false for every graph against iep-shapes.ttl, so flipping it today refuses
      // everything". That is not what the code does, and the whole point of grading the scan
      // against the DATA graph was that it is not blanket. Measured against
      // `docs/ns/iep-shapes.ttl`:
      //
      //     empty graph            fullyChecked=true      a plain dct: note   true
      //     unrelated graph        true                   iep:SignedAuthorship true
      //     iep:ContextDescriptor  FALSE                  iep:Affordance       FALSE
      //     iep:SemioticFacet      FALSE                  iep:TemporalFacet    FALSE
      //     iep:RevocationCondition FALSE
      //
      // The honest statement of the blocker: `fullyChecked` is false for any graph carrying
      // one of those five classes — which IS every descriptor on this write path, so flipping
      // the gate would still refuse effectively every publish. The conclusion survives; the
      // reason given for it did not, and a deferral defended by a false measurement is one
      // nobody can re-check. The unblock is a SPARQL evaluator (or re-expressing
      // `iep:RevocationConditionNoSelfReferenceShape` and its siblings in Core SHACL), not a
      // flag flip. `spec/conformance/runner.mjs` now reports the same gap as UNVERIFIABLE
      // rather than as a pass, so the two surfaces agree about what is unenforced.
      for (const note of report.results) {
        if (note.constraintComponent === 'urn:iep:shacl:UnsupportedConstraint') {
          log(`WARN conformance gate: ${shapeIri} — ${note.message}`);
        }
        // The entailment rollout signal. Each line is a publish that WOULD be rejected
        // once entailment enforces — this is the list to read before flipping it on.
        if (typeof note.message === 'string' && note.message.startsWith('[entailment-observe]')) {
          log(`WARN entailment-observe: ${shapeIri} focus=${note.focusNode} — ${note.message}`);
        }
      }
      resolvedShapes.push({ shapeIri, shapeTurtle });
    }
    return { conforms: true, resolvedShapes, coverage };
  }


  return { fetchContainerShapes, runConformanceGate };
}

/** One gate per process; `log` is the only thing it needs from its caller. */
export function createConformanceGate(deps: ConformanceGateDeps): ConformanceGate {
  return build(deps);
}
