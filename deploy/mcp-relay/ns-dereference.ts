/**
 * The /ns dereference surface — every published Interego IRI resolves through here.
 *
 * ── WHY THIS IS A MODULE ────────────────────────────────────────────────────────────────────
 *
 * This was ~540 lines in the middle of server.ts, which is 17k lines and calls app.listen() at
 * module scope — so it cannot be imported, so none of it could be unit-tested. The same reason
 * action-authority.ts, pod-authorization.ts and shapes-declared.ts left: a rule that is only
 * reachable through a live HTTP server is a rule nobody tests, and both of the defects
 * action-authority.ts caught had survived a green suite for exactly that reason.
 *
 * Nothing here changed behaviour when it moved. The pure projections are module-scope exports
 * (importable and callable with no server, no pod, no network); everything that needs relay
 * runtime state is closed over by `createNsDereference`.
 *
 * ── ★★ TWO ORDERING INVARIANTS. BOTH ARE LOAD-BEARING. ──────────────────────────────────────
 *
 * 1. CONSTRUCTION MUST HAPPEN BEFORE server.ts's `TOOLS` TABLE, MOUNTING MUST HAPPEN WHERE THE
 *    ROUTES USED TO BE. `TOOLS` is a module-scope `const` initializer that references
 *    `handleResolveLinkedData` as a value. In the old code that worked only because
 *    `handleResolveLinkedData` was a hoisted `function` declaration 4,700 lines further down.
 *    A factory whose result is bound at the old route position would put that reference in the
 *    temporal dead zone, and the relay would throw ReferenceError at import and never listen.
 *    That is why construction (pure, no side effects) is split from `mount(app)`.
 *
 *    ★ THIS ONE IS GUARDED BY THE TYPECHECKER, NOT BY A TEST. Measured: moving the
 *    `createNsDereference(...)` call below the TOOLS table fails `tsc --noEmit` with
 *    `TS2448: Block-scoped variable 'handleResolveLinkedData' used before its declaration`,
 *    and the relay's `npm test` runs that typecheck first. Worth stating plainly because no
 *    test in the suite imports server.ts — nothing actually boots this module, so a runtime-only
 *    hazard here would have no coverage at all.
 *
 * 2. `mount()` REGISTERS ITS ROUTES IN A FIXED ORDER, AND THE ORDER IS THE ROUTING RULE.
 *    `/ns/pgsl/:kind/:hash` and `/ns/iep/action/:vertical/:verb` both also match
 *    `/ns/:owner/:slug/*` (owner=pgsl, slug=<kind>, rest=<hash>). They resolve correctly only
 *    because they are registered FIRST. This is also why the iep:action route travels with this
 *    module rather than staying behind in server.ts: leaving it there would have moved it after
 *    the subject wildcard, and every action id would have started 404ing with the wrong body.
 *
 *    ★ GUARDED BY tests/ns-dereference.test.ts §6, which mounts these routes on a real Express
 *    app and asserts on the RESPONSE BODY (an unknown vertical 404s either way, so a
 *    status-only assertion would pass whichever route answered).
 *
 * 3. ★★ `mount()` MUST RUN AFTER `app.use(corsMiddleware(…))`, AND THAT IS THE WHOLE OF ITS
 *    EXTERNAL ORDERING CONSTRAINT. Measured on the booted relay rather than reasoned about: the
 *    live router stack was dumped and every one of its 79 layers was asked `layer.match(p)` for
 *    each of the four /ns path shapes `mount()` registers — `/ns/pgsl/:kind/:hash`,
 *    `/ns/iep/action/:vertical/:verb`, `/ns/:owner/:slug` and `/ns/:owner/:slug/*`.
 *    FOURTEEN layers match at least one of them: the six this module registers (which match one
 *    shape each, except the subject wildcard, which matches three), and EIGHT path-agnostic
 *    `app.use` middlewares, which match all four — Express's own `query` and `expressInit`, the
 *    HSTS header middleware, the two body parsers, `corsMiddleware`, the CORS-freeze wrapper,
 *    and the OAuth router mounted at '/'. Of the 65 route registrations that are NOT /ns routes,
 *    NONE matches any /ns path shape, and no /ns route matches any of theirs.
 *
 *    Of the eight that do match everything, none ANSWERS: live GETs against that booted relay
 *    came back from these routes' own handlers, carrying ACAO:* and `Expose-Headers: Link,
 *    ETag`. So the position of `mount(app)` among the other app.get/app.post calls is NOT
 *    load-bearing; its position relative to `corsMiddleware` is, because `corsMiddleware`'s
 *    `url.startsWith('/ns/')` branch is the ONLY place these responses get
 *    `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: Link, ETag`. Mounted
 *    ahead of it, every /ns response is still 200 on the wire and completely unreadable to a
 *    cross-origin browser agent — silent, and no assertion in the suite would move.
 *
 *    ★ THIS IS NOW ENFORCED, NOT DOCUMENTED. `mount()` reads the app's INSTALLED middleware
 *    stack and throws unless a layer carrying the tag actually MATCHES every /ns path shape,
 *    which turns "moved into the pre-CORS window" from a silent production regression into a
 *    boot crash naming the fix. Both directions are pinned in tests/ns-dereference.test.ts §8.
 */

import type { Express } from 'express';
import {
  parseTrig,
  controlsFromAffordances,
  extractAffordancesFromTurtle,
  renderHypermediaMarkdown,
  negotiateRepresentation,
  HYPERMEDIA_MARKDOWN_MEDIA_TYPE,
  HMD_PROFILE_IRI,
  HMD_PROFILE_LINK_HEADER,
  type FetchFn,
} from '@interego/core';
import {
  discover,
  fetchGraphContent,
  parseDistributionFromDescriptorTurtle,
} from '@interego/solid';
import { assertPublicPodUrl } from './url-rewrite.js';
// The ordering tag stamped on the public linked-data CORS middleware. `mount()` refuses to
// register these routes on an app that has not installed it yet — see MOUNT_PRECONDITION below.
import { PUBLIC_LINKED_DATA_CORS } from './cors-allowlist.js';
// The action naming authority: the roster and the resolution rule. See action-authority.ts for
// the Object.prototype defect that being inline hid — `GET /ns/iep/action/constructor/x` 302'd.
import { buildActionRoster, resolveActionTarget } from './action-authority.js';
import * as publishedNodes from './pgsl-node-store.js';

/**
 * Relay runtime state this surface reads. Injected rather than imported back out of server.ts,
 * so there is no cycle and a test can stand the whole surface up with a fake `solidFetch`.
 */
export interface NsDereferenceDeps {
  /** Internal CSS base, trailing slash included (server.ts's CSS_URL). */
  readonly cssUrl: string;
  /** The relay's public origin (server.ts's PUBLIC_BASE_URL); '' when unset. */
  readonly publicBaseUrl: string;
  /** Tier-2 fail-closed public-lattice resolver base (server.ts's PGSL_NODE_RESOLVER). */
  readonly pgslNodeResolver: string;
  /** The relay's screened outbound fetch (server.ts's solidFetch, from createEgress). */
  readonly solidFetch: FetchFn;
}

// ── /ns/:owner/:slug — the RDF-projection dereference surface ─────────────
//
// Base Interego is a SUPERSET of RDF: holons are payload-agnostic identities
// that project to any representation. This route affords "what people expect
// from RDF" WHERE a holon is used as RDF — a clean, stable IRI that HTTP-
// dereferences to content-negotiated linked data (Turtle / JSON-LD / HTML),
// with #fragment terms resolving in-document and rdfs:isDefinedBy / owl:imports
// following-your-nose. It is GENERIC: it dereferences ANY published PUBLIC graph
// at this IRI — an ontology, a knowledge graph, a SHACL shape, a course — with
// NO ontology special-casing. Publishing is the ordinary core publish (the
// holon's RDF projection, written to the author's own pod); this is only the
// dereference half. Read-only, public (CORS * incl null via corsMiddleware's
// /ns carve-out), no auth. Serves the signed projection bytes, never rewrites
// them. Verticals (agentic memory, Foxxi, Weft) are polygranular CONSUMERS of
// this surface — the same holon in many hyperedges.

// ── The pure projections ────────────────────────────────────────────────────────────────────
//
// Byte-in, byte-out transforms of a published graph. They read no relay state and perform no
// I/O, so they are module-scope exports a test can call directly. This is the half of the
// extraction that turns "assert against server.ts as text" into "call the function".

export const NS_OWL_ONTOLOGY = 'http://www.w3.org/2002/07/owl#Ontology';

// ── ★★ THE MOUNT PRECONDITION ───────────────────────────────────────────────────────────────
//
// Express has no way to say "register me after that middleware". Before the extraction these
// routes were a block of app.get calls physically surrounded by the rest of server.ts, and their
// ordering property was implied by where the code sat; now they are one movable call, so the
// property is asserted at call time instead of assumed.

/** Prefix of every message thrown by `assertPublicLinkedDataCorsInstalled`, so a caller (or a
 *  test) can recognise the class without matching on prose. */
export const MOUNT_PRECONDITION = '[ns-dereference] mount precondition:';

/**
 * The concrete paths every /ns route `mount()` registers has to be reachable at.
 *
 * ★ ONE PER PATH SHAPE, AND THE TEST PROVES THE LIST IS COMPLETE.
 * `tests/ns-dereference.test.ts` §8 mounts the real routes on a real Express app and asserts
 * that every registered `/ns` route layer matches at least one entry here, so a seventh route
 * with a new shape cannot be added without this list growing to cover it. The guard below
 * requires the tagged CORS middleware to match ALL of them: the carve-out that only covers some
 * of the surface is the same defect as the carve-out that covers none of it, one route along.
 */
export const NS_PATH_SHAPES: readonly string[] = [
  `/ns/pgsl/atom/${'0'.repeat(40)}`,
  '/ns/iep/action/relay/get_descriptor',
  '/ns/alice/vocab',
  '/ns/alice/vocab/subject/7',
];

/** One Express router layer, as much of it as this file reads. */
interface RouterLayer {
  readonly handle?: unknown;
  /** Express's own "does this layer run for this path" predicate. Present on every Layer in
   *  both Express 4 and Express 5; its absence is what makes a stack UNREADABLE rather than
   *  empty. */
  readonly match?: unknown;
}

/**
 * Read the Express app's INSTALLED router layers, or `null` when they cannot be read.
 *
 * `null` and `[]` are deliberately different answers. `[]` means "this app has nothing installed
 * yet" — a definite precondition violation. `null` means "this Express version does not expose
 * its stack the way we know how to read" — we have not verified anything, and saying so is the
 * point: a check that cannot see is not a check that passed.
 *
 * Express 4 keeps the router at `app._router` (lazily created on the first `use`/`get`/`listen`,
 * so an untouched app has none) and makes the public `app.router` getter THROW a 3.x-migration
 * error. Express 5 moved it back to `app.router`. Both are tried, in that order.
 */
function installedLayers(app: Express): readonly RouterLayer[] | null {
  const bag = app as unknown as Record<string, unknown>;
  let router: unknown = bag['_router'];
  if (router === undefined || router === null) {
    try { router = bag['router']; } catch { router = undefined; } // Express 4's getter throws.
  }
  if (router === undefined || router === null) return [];
  const stack = (router as Record<string, unknown>)['stack'];
  if (!Array.isArray(stack)) return null;
  return stack as readonly RouterLayer[];
}

/**
 * Throw unless the public linked-data CORS carve-out is ALREADY installed on `app` AND ACTUALLY
 * RUNS FOR THE /ns PATHS.
 *
 * ★★ IT ASKS `layer.match(path)`, AND THE VERSION THAT ASKED ONLY `layer.handle` HAD A MEASURED
 * FALSE NEGATIVE. Express layers carry a mount path as well as a handler, and that guard read
 * the handler and nothing else — so `app.use('/mcp', corsMiddleware({}))` satisfied it. Driven:
 * with the middleware mounted at `/mcp`, `mount()` returned normally and a live
 * `GET /ns/alice/vocab` carrying an `Origin` header came back with
 * `access-control-allow-origin: null`. That is the exact production symptom the guard exists to
 * prevent, reached through the guard rather than around it. Asking whether a TAGGED layer
 * matches each of {@link NS_PATH_SHAPES} is the question the ordering invariant is actually
 * about, and it is the same question Express itself asks at dispatch time.
 *
 * ★ SO IT IS NO LONGER A PROXY. Express dispatches its layer stack in registration order, so
 * "a layer carrying the tag is on the stack at the moment we register, and Express's own
 * `match` says it runs for every /ns path shape" is the ordering property itself: registration
 * order gives BEFORE, `match` gives FOR THESE PATHS, and those two conjoined are what "runs
 * ahead of these routes" means. What it still does not check is whether that middleware, once
 * it runs, sets the headers — `tests/public-cors-carveout.test.ts` and §6 of the /ns suite
 * drive that half over the wire.
 *
 * ★ WHAT IT DOES NOT COVER, stated rather than implied: it checks THIS one middleware. It does
 * not check the HSTS header middleware or the body parsers. It does not need to for the ordering
 * question, because on the relay all four are installed as consecutive `app.use` calls with
 * `corsMiddleware` LAST, so any position early enough to miss one of the others is also early
 * enough to miss this one. Reorder those four in server.ts and that subsumption stops holding;
 * this function would not notice.
 */
export function assertPublicLinkedDataCorsInstalled(app: Express): void {
  const layers = installedLayers(app);
  if (layers === null) {
    throw new Error(
      `${MOUNT_PRECONDITION} cannot read this Express app's middleware stack, so the /ns route `
      + 'ordering could not be verified. Neither `app._router.stack` (Express 4) nor '
      + '`app.router.stack` (Express 5) is an array. Refusing to mount rather than mounting '
      + 'unchecked — an unverified /ns surface serves no CORS headers and fails silently.');
  }
  const tagged = layers.filter((layer) => {
    const handle = layer?.handle;
    return typeof handle === 'function'
      && (handle as unknown as Record<symbol, unknown>)[PUBLIC_LINKED_DATA_CORS] === true;
  });
  if (tagged.length === 0) {
    throw new Error(
      `${MOUNT_PRECONDITION} corsMiddleware() from cors-allowlist.ts is not installed on this app `
      + `yet (${layers.length} layer(s) present). The /ns routes get their `
      + '`Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: Link, ETag` from '
      + "that middleware's /ns carve-out and from nowhere else, and Express runs layers in "
      + 'registration order — so mounting here would serve every published IRI with no CORS '
      + 'headers at all: 200 on the wire, invisible to any cross-origin reader. Move '
      + '`nsDereference.mount(app)` to any point AFTER `app.use(corsMiddleware({…}))`.');
  }
  // A tagged layer whose own `match` cannot be called is the unreadable case again, one level
  // in: the tag is there, and whether it runs for /ns is exactly what could not be determined.
  const uncovered: string[] = [];
  for (const path of NS_PATH_SHAPES) {
    let matched = false;
    for (const layer of tagged) {
      const match = layer.match;
      if (typeof match !== 'function') {
        throw new Error(
          `${MOUNT_PRECONDITION} a layer carrying the public linked-data CORS tag exposes no `
          + '`match(path)`, so whether it runs for a /ns path could not be determined. Refusing '
          + 'to mount rather than mounting unchecked.');
      }
      let ran: unknown;
      try { ran = (match as (p: string) => unknown).call(layer, path); }
      catch (err) {
        throw new Error(
          `${MOUNT_PRECONDITION} asking a tagged layer whether it matches ${path} threw `
          + `(${(err as Error).message}), so the /ns route ordering could not be verified. `
          + 'Refusing to mount rather than mounting unchecked.');
      }
      if (ran) { matched = true; break; }
    }
    if (!matched) uncovered.push(path);
  }
  if (uncovered.length === 0) return;
  throw new Error(
    `${MOUNT_PRECONDITION} corsMiddleware() from cors-allowlist.ts IS installed on this app `
    + `(${tagged.length} tagged layer(s) among ${layers.length}), but no tagged layer runs for `
    + `${uncovered.join(', ')} — it is mounted at a path that does not match the /ns surface, `
    + "which `app.use('/somewhere', corsMiddleware({…}))` does. The /ns routes get their "
    + '`Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: Link, ETag` from '
    + "that middleware's /ns carve-out and from nowhere else, so mounting here would serve every "
    + 'published IRI with no CORS headers at all: 200 on the wire, invisible to any cross-origin '
    + 'reader. Install it path-agnostically: `app.use(corsMiddleware({…}))`.');
}


/** Clean standalone Turtle from a stored `-graph.trig` (publish() wraps the
 *  named graph as `<graphIri> { …indented… }` under hoisted prefixes). Pure
 *  string transform so blank nodes / SHACL lists survive byte-for-byte. */
export function nsExtractGraphTurtle(trig: string, graphIri: string): string | null {
  const open = trig.indexOf(`<${graphIri}> {`);
  if (open < 0) return null;
  const bodyStart = trig.indexOf('{', open) + 1;
  const n = trig.length;
  // Quote/comment-AWARE brace matcher: only count braces OUTSIDE Turtle string
  // literals ("…"/'…'/"""…"""/'''…''') and # comments, so a lone/unbalanced `{`
  // or `}` inside an rdfs:comment (arbitrary agent content) cannot desync the
  // depth counter and truncate the served graph.
  let depth = 1, i = bodyStart;
  while (i < n && depth > 0) {
    const c = trig[i];
    if (c === '#') { while (i < n && trig[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'") {
      const q = c; const triple = trig[i + 1] === q && trig[i + 2] === q;
      i += triple ? 3 : 1;
      while (i < n) {
        if (trig[i] === '\\') { i += 2; continue; }
        if (triple) { if (trig[i] === q && trig[i + 1] === q && trig[i + 2] === q) { i += 3; break; } i++; }
        else { if (trig[i] === q) { i++; break; } if (trig[i] === '\n') { break; } i++; }
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  const inner = trig.slice(bodyStart, i - 1);
  const prefixLines = trig.split('\n').filter(l => /^\s*(@prefix|@base)\s/i.test(l));
  const deindented = inner.split('\n').map(l => l.replace(/^ {4}/, '')).join('\n').trim();
  return `${prefixLines.join('\n')}\n\n${deindented}\n`;
}

/** Flattened JSON-LD projection of the clean Turtle (best-effort; caller falls
 *  back to Turtle if this throws). */
export function nsTurtleToJsonLd(turtle: string): Record<string, unknown> {
  const doc = parseTrig(turtle);
  const ctx: Record<string, string> = {};
  for (const [p, iri] of doc.prefixes) ctx[p] = iri as string;
  const graph = doc.subjects.map(s => {
    const id = typeof s.subject === 'string' ? s.subject : `_:${s.subject.bnode}`;
    const node: Record<string, unknown> = { '@id': id };
    for (const [pred, terms] of s.properties) {
      node[pred as string] = terms.map(t =>
        t.kind === 'iri' ? { '@id': t.iri }
          : t.kind === 'bnode' ? { '@id': `_:${t.id}` }
            // ★ An RDF 1.2 triple term needs its own encoding, and JSON-LD 1.1 has no
            // standard one — RDF 1.2's JSON-LD serialization is still in progress. The
            // chain below used to end in a bare `else` that treated ANY non-IRI, non-bnode
            // term as a literal, so a triple term would have been published as
            // `{"@value": undefined}`: a well-formed-looking JSON-LD node asserting
            // nothing, on a route whose whole job is to serve the vocabulary faithfully.
            //
            // Until there is a standard, this emits the three parts under our own
            // namespace rather than guessing at one. It is unmistakably not a literal, it
            // round-trips the information, and a reader that does not know the term simply
            // sees a nested node instead of silently reading a null value as fact.
            : t.kind === 'triple'
              ? {
                // `@type: "@json"` is standard JSON-LD 1.1, so this needs no new
                // vocabulary — which matters, because three minted terms for a
                // serialization gap would join the undeclared-term debt this repo already
                // carries. It is also unmistakably structured: a reader that does not know
                // RDF 1.2 sees a JSON object, not a string it might treat as a value.
                '@type': '@json',
                '@value': {
                  subject: t.subject.kind === 'iri' ? t.subject.iri : `_:${t.subject.id}`,
                  predicate: t.predicate,
                  object: t.object.kind === 'iri' ? t.object.iri
                    : t.object.kind === 'bnode' ? `_:${t.object.id}`
                      : t.object.kind === 'literal' ? t.object.value
                        : '[nested triple term]',
                },
              }
              : { '@value': t.value, ...(t.datatype ? { '@type': t.datatype } : {}), ...(t.language ? { '@language': t.language } : {}) });
    }
    return node;
  });
  return { '@context': ctx, '@graph': graph };
}

export function nsHtml(iri: string, turtle: string, meta: { owner: string; slug: string; descriptorUrl: string; isOntology: boolean }): string {
  const esc = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><meta charset="utf-8"><title>${esc(meta.slug)}</title>`
    + `<body style="font-family:system-ui;max-width:60rem;margin:2rem auto;line-height:1.5;padding:0 1rem">`
    + `<h1>${esc(meta.slug)}</h1>`
    + `<p><b>IRI:</b> <code>${esc(iri)}</code>${meta.isOntology ? ' · <b>owl:Ontology</b>' : ''}</p>`
    + `<p>A published Interego holon, dereferenced here as linked data — the RDF projection of a signed, discoverable substrate object (<a href="${esc(publishableDescriptorUrl(meta.descriptorUrl, iri))}">descriptor</a>) on <code>${esc(meta.owner)}</code>'s pod. Terms are hash fragments (<code>${esc(iri)}#&lt;term&gt;</code>) resolving in-document.</p>`
    + `<p><b>Projections:</b> <a href="?format=turtle">Turtle</a> · <a href="?format=jsonld">JSON-LD</a></p>`
    + `<h2>Source (Turtle)</h2><pre style="background:#f6f8fa;padding:1rem;overflow:auto;border-radius:6px">${esc(turtle)}</pre>`
    + `</body>`;
}

/** Render a published graph as hypermedia Markdown — a THIRD projection beside
 *  Turtle and JSON-LD, for the channels RDF cannot cross (a README, a pasted
 *  message, an MCP resource, an LLM's context window).
 *
 *  This is a VIEW. The signed descriptor is the AUTHORITY. The document names
 *  WHAT may be done (each :::control block's `rel`) and WHERE THE AUTHORITY
 *  LIVES (`descriptorUrl`) — never WHERE TO POST: `controlsFromAffordances()`
 *  drops `hydra:target` on the floor and the renderer computes every emitted
 *  target inside the document's own resource (authority closure), so untrusted
 *  prose can never steer an auto-approved `invoke_affordance` at an
 *  attacker-chosen URL (MCP approves per-TOOL, not per-TARGET). The live target
 *  is re-resolved from the signed Turtle by followAffordance() at execution time.
 *
 *  Reuses the SAME resolveNsGraph() core as the Turtle/JSON-LD branches, so the
 *  SSRF host-pinning (nsToOwnerPodInternal) and the CORS carve-out come free. */
/**
 * The descriptor URL a document may PUBLISH.
 *
 * `resolveNsGraph` hands back whatever indexed the graph, and on the convention
 * path that is the internal CSS URL (`http://css.railway.internal:3456/...`).
 * That is correct as an internal fetch target but useless as a published one:
 * nobody outside the private network can dereference it. It matters most in the
 * Markdown projection, whose whole safety story is "the target is not here — go
 * re-resolve it from descriptorUrl": an authority you cannot reach is not an
 * authority. So when the resolved descriptor is not publicly dereferenceable,
 * publish the graph's own IRI instead. That IRI dereferences (here, through this
 * route) to the same Turtle, carrying the same affordances with their targets —
 * so re-resolution still works, over a URL the reader can actually fetch.
 */
export function publishableDescriptorUrl(descriptorUrl: string, graphIri: string): string {
  try {
    assertPublicPodUrl(descriptorUrl);
    return descriptorUrl;
  } catch {
    return graphIri;
  }
}

export function nsMarkdown(iri: string, turtle: string, meta: { owner: string; slug: string; descriptorUrl: string; isOntology: boolean }): string {
  const descriptorUrl = publishableDescriptorUrl(meta.descriptorUrl, iri);
  const controls = controlsFromAffordances(extractAffordancesFromTurtle(turtle, descriptorUrl, { requireTarget: false }));
  // NOTE: no embedded Turtle. The signed source (which legitimately carries
  // hydra:target transport endpoints) is one conneg request away via the
  // rel="alternate" links — embedding it would put those endpoints into
  // store-and-forward bytes, the exact leak the projection exists to avoid.
  const body = [
    `# ${meta.slug}`,
    ``,
    `A published Interego holon on \`${meta.owner}\`'s pod, projected as a HyperMarkdown`,
    `document. The Turtle / JSON-LD projections linked below are the same graph`,
    `resource — request them by content negotiation.`,
    ...(meta.isOntology ? [``, 'This graph is an `owl:Ontology`; its terms resolve as `#fragment`s of this IRI.'] : []),
    ...(controls.length === 0 ? [``, `This graph publishes no controls.`] : []),
  ].join('\n');

  return renderHypermediaMarkdown({
    id: iri,
    // hmd:Document typing lives on the frontmatter's document node, not the resource.
    type: meta.isOntology ? 'owl:Ontology' : 'iep:ContextDescriptor',
    descriptorUrl,
    title: meta.slug,
    // /ns serves only the current non-superseded PUBLIC graph, so this
    // lifecycle snapshot is honest by construction.
    state: 'published',
    fields: { 'dct:publisher': meta.owner },
    links: [
      { label: 'Signed descriptor (authority)', href: descriptorUrl, rel: 'describedby', type: 'text/turtle' },
      { label: 'Turtle', href: `${iri}?format=turtle`, rel: 'alternate', type: 'text/turtle' },
      { label: 'JSON-LD', href: `${iri}?format=jsonld`, rel: 'alternate', type: 'application/ld+json' },
    ],
    controls,
    body,
  });
}

/** A fetchGraphContent()/solidFetch() error whose HTTP status is 404/410 —
 *  i.e. the target graph is ABSENT, not an upstream failure. Coupled to
 *  fetchGraphContent's throw format `Failed to GET <url>: <status> <text>`;
 *  the `: <status>` token (colon-space) can only be the status separator
 *  (a URL has no space), so it never false-matches on the URL itself. */
export function isAbsentGraphError(e: unknown): boolean {
  const m = (e as Error)?.message ?? String(e);
  return /:\s(?:404|410)\b/.test(m);
}

/** What `createNsDereference` hands back. */
export interface NsDereference {
  /** Register every /ns route on the app, in the order the routing rule depends on. */
  mount(app: Express): void;
  publishableDescriptorUrl: typeof publishableDescriptorUrl;
  nsMarkdown: typeof nsMarkdown;
  resolveNsGraph(owner: string, slug: string): Promise<NsGraphResult>;
  handleResolveLinkedData(args: Record<string, unknown>): Promise<string>;
}

export type NsGraphResult =
  | { ok: true; turtle: string; ontologyIri: string; isOntology: boolean; descriptorUrl: string }
  | { ok: false; status: number; error: string; ontologyIri: string };

/**
 * Build the /ns surface. PURE — it only closes over `deps` and returns; it touches no network
 * and registers no routes until `mount(app)` is called. That purity is what lets server.ts
 * construct it early (before the TOOLS table needs `handleResolveLinkedData` as a value) and
 * mount it late (where the routes have always been). See invariant 1 in the file header.
 */
export function createNsDereference(deps: NsDereferenceDeps): NsDereference {
  const { cssUrl, publicBaseUrl, pgslNodeResolver, solidFetch } = deps;

  const RELAY_NS_ROOT = `${(publicBaseUrl || 'https://relay.interego.xwisee.com').replace(/\/+$/, '')}/ns`;

  /** Reduce any descriptor-supplied URL to the FIXED internal CSS host + the
   *  owner's own pod path — an SSRF-safe target rewrite (host is never attacker-
   *  controlled) constrained to `/<owner>/`. Returns null for a cross-owner /
   *  off-pod / unparseable URL so the caller uses the safe internal convention.
   *  Rewrites the fetch TARGET, never the served bytes (signatures verify). */
  function nsToOwnerPodInternal(u: string, owner: string): string | null {
    try {
      const cssOrigin = new URL(cssUrl).origin;
      const p = new URL(u).pathname;
      const first = p.split('/').filter(Boolean)[0] ?? '';
      if (decodeURIComponent(first) !== owner) return null;
      return `${cssOrigin}${p}`;
    } catch { return null; }
  }

  /** Shared /ns resolver core — used by BOTH the public GET route and the
   *  resolve_linked_data MCP tool. Discovers the current non-superseded published
   *  graph at <RELAY_NS_ROOT>/<owner>/<slug>, follows the descriptor (SSRF-safe:
   *  every fetch URL reduced to the FIXED internal CSS host + the owner's own pod
   *  path), and returns the clean projected Turtle. Generic — NO conformsTo filter,
   *  serves any published PUBLIC graph. */
  async function resolveNsGraph(owner: string, slug: string): Promise<
    | { ok: true; turtle: string; ontologyIri: string; isOntology: boolean; descriptorUrl: string }
    | { ok: false; status: number; error: string; ontologyIri: string }> {
    const graphIri = `${RELAY_NS_ROOT}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;
    const podUrl = `${cssUrl}${encodeURIComponent(owner)}/`;
    const convGraphUrl = `${podUrl}ontologies/${encodeURIComponent(slug)}-graph.trig`;
    // Fetch a graph URL + build the served result (null when empty / encrypted-non-public).
    const serve = async (graphUrl: string, descriptorUrl: string, conformsTo: readonly string[] | undefined) => {
      let fetched: Awaited<ReturnType<typeof fetchGraphContent>>;
      try {
        fetched = await fetchGraphContent(graphUrl, { fetch: solidFetch });
      } catch (e) {
        // An ABSENT graph (CSS 404/410) is a genuine not-found, not an upstream
        // failure: return null so the caller falls through to the clean 404 instead
        // of the outer catch's 502. Any other error (5xx / network / abort/timeout)
        // still throws → 502, the correct status for a real bad gateway. This is what
        // makes the intended `return { status: 404 }` reachable for an unpublished
        // slug whose convention graph does not exist (the 0589752 fallback regression).
        if (isAbsentGraphError(e)) return null;
        throw e;
      }
      const trig = fetched.content ?? '';
      if (!trig || (fetched.encrypted && !fetched.content)) return null;
      const turtle = nsExtractGraphTurtle(trig, graphIri) ?? trig;
      const isOntology = (conformsTo ?? []).some(c => c === NS_OWL_ONTOLOGY) || /\bowl:Ontology\b/.test(turtle);
      return { ok: true as const, turtle, ontologyIri: graphIri, isOntology, descriptorUrl };
    };
    try {
      const entries = await discover(podUrl, { graphIri }, { fetch: solidFetch });
      const superseded = new Set(entries.flatMap(e => (e.supersedes ?? []) as string[]));
      const head = entries.find(e => !superseded.has(e.descriptorUrl)) ?? entries[0];
      if (head) {
        const descUrlSafe = nsToOwnerPodInternal(head.descriptorUrl, owner);
        let dist: ReturnType<typeof parseDistributionFromDescriptorTurtle> = null;
        if (descUrlSafe) {
          const descResp = await solidFetch(descUrlSafe, { headers: { Accept: 'text/turtle' } });
          dist = parseDistributionFromDescriptorTurtle(descResp.ok ? await descResp.text() : '');
        }
        if (dist?.encrypted) return { ok: false, status: 409, error: `Graph ${graphIri} is a non-public (encrypted) projection; only public RDF projections dereference here.`, ontologyIri: graphIri };
        const graphUrl = (dist?.accessURL ? nsToOwnerPodInternal(dist.accessURL, owner) : null) ?? convGraphUrl;
        const served = await serve(graphUrl, head.descriptorUrl, head.conformsTo);
        if (served) return served;
      }
      // FALLBACK — no manifest entry indexes this IRI (or its graph was unreadable).
      // Try the ontologies/<slug> CONVENTION graph directly. This makes an ontology
      // written to the convention dereference even when the pod's manifest could not
      // be indexed — e.g. an oversized manifest whose write fails (a large pod), or a
      // publisher that wrote the descriptor+graph but no manifest entry. Bounded: one
      // internal-host, owner-pod-path GET (SSRF-safe, same as the primary path).
      const served = await serve(convGraphUrl, convGraphUrl, undefined);
      if (served) return served;
      return { ok: false, status: 404, error: `No published graph at ${graphIri} on ${owner}'s pod.`, ontologyIri: graphIri };
    } catch (err) {
      return { ok: false, status: 502, error: `Failed to dereference ${graphIri}: ${(err as Error).message}`, ontologyIri: graphIri };
    }
  }

  /**
   * ★ EVERY SUBJECT MINTED UNDER A PUBLISHED DOCUMENT DEREFERENCES TO THE VERSION THAT
   * DESCRIBES IT — the generic half of "every identifier is a dereferenceable URL".
   *
   * `/ns/:owner/:slug` serves the CURRENT head of a graph. That is right for an ontology and
   * wrong for an append-only log: a stream publishes each entry into the same graph IRI,
   * superseding the last, and mints each entry at `<stream>/e/<seq>`. Those entry IRIs are the
   * subjects a work shape targets, the objects of every citation, the things a SKOS term is
   * attached to — and all but the newest answered 404, because the head document says nothing
   * about them. The report that claimed "all 14 IRIs return 200 to an anonymous curl" had
   * quietly substituted the storage-layer `.ttl` addresses for them.
   *
   * The relay already holds the whole lineage (`discover` returns every descriptor that
   * indexed the graph IRI), so this walks it newest-first and serves the version whose graph
   * actually mentions the requested subject. Generic: it knows nothing about streams, entries
   * or any vertical — it answers "which published version of this document describes this
   * subject", which is the same question for any document in the substrate.
   *
   * Bounded on purpose: a lineage is unbounded and each step is one internal GET, so a deep
   * log must not turn one anonymous request into hundreds. Past the bound the answer is an
   * honest 404 naming the bound rather than a slow success.
   */
  const NS_SUBJECT_LINEAGE_LIMIT = 64;

  async function resolveNsSubject(owner: string, slug: string, subjectIri: string): Promise<
    | { ok: true; turtle: string; descriptorUrl: string }
    | { ok: false; status: number; error: string }> {
    const graphIri = `${RELAY_NS_ROOT}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;
    const podUrl = `${cssUrl}${encodeURIComponent(owner)}/`;
    let entries: Awaited<ReturnType<typeof discover>>;
    try {
      entries = await discover(podUrl, { graphIri }, { fetch: solidFetch });
    } catch (err) {
      return { ok: false, status: 502, error: `Failed to read the lineage of ${graphIri}: ${(err as Error).message}` };
    }
    if (entries.length === 0) return { ok: false, status: 404, error: `No published graph at ${graphIri} on ${owner}'s pod.` };

    // Newest first: a subject re-described by a later version should resolve to the later one.
    const superseded = new Set(entries.flatMap(e => (e.supersedes ?? []) as string[]));
    const ordered = [...entries].sort((a, b) => {
      const ah = superseded.has(a.descriptorUrl) ? 1 : 0;
      const bh = superseded.has(b.descriptorUrl) ? 1 : 0;
      if (ah !== bh) return ah - bh;
      return String(b.validFrom ?? '').localeCompare(String(a.validFrom ?? ''));
    });

    const needle = `<${subjectIri}>`;
    let looked = 0;
    for (const e of ordered) {
      if (looked >= NS_SUBJECT_LINEAGE_LIMIT) {
        return { ok: false, status: 404, error: `<${subjectIri}> was not described by any of the ${NS_SUBJECT_LINEAGE_LIMIT} most recent versions of ${graphIri}; this route does not walk further.` };
      }
      looked++;
      const descUrlSafe = nsToOwnerPodInternal(e.descriptorUrl, owner);
      if (!descUrlSafe) continue;
      let graphUrl: string | null = null;
      try {
        const descResp = await solidFetch(descUrlSafe, { headers: { Accept: 'text/turtle' } });
        const dist = parseDistributionFromDescriptorTurtle(descResp.ok ? await descResp.text() : '');
        // A non-public projection is not served here, exactly as at the document route.
        if (dist?.encrypted) continue;
        graphUrl = dist?.accessURL ? nsToOwnerPodInternal(dist.accessURL, owner) : null;
      } catch { continue; }
      if (!graphUrl) continue;
      let trig: string;
      try {
        const fetched = await fetchGraphContent(graphUrl, { fetch: solidFetch });
        if (fetched.encrypted && !fetched.content) continue;
        trig = fetched.content ?? '';
      } catch { continue; }
      if (trig === '') continue;
      const turtle = nsExtractGraphTurtle(trig, graphIri) ?? trig;
      // The subject must appear as a full IRIREF. A substring test on the bare IRI would match
      // `<…/e/1>` inside `<…/e/11>` and serve the wrong version.
      if (!turtle.includes(needle)) continue;
      return { ok: true, turtle, descriptorUrl: e.descriptorUrl };
    }
    return { ok: false, status: 404, error: `No published version of ${graphIri} describes <${subjectIri}>.` };
  }

  /** MCP tool handler — resolve a published /ns graph/ontology as linked data for
   *  MCP-only clients that cannot GET the URL over raw HTTP. Accepts the full
   *  <relay>/ns/<owner>/<slug> IRI OR explicit owner+slug, + optional format
   *  (turtle | jsonld). Read-only; wraps resolveNsGraph (the same core the public
   *  GET route uses). */
  // `Record<string, unknown>` spelled out rather than server.ts's `ToolArgs` alias: the alias is
  // defined as exactly this, so importing it back would buy nothing and create a cycle.
  async function handleResolveLinkedData(args: Record<string, unknown>): Promise<string> {
    let owner = (args['owner'] as string | undefined)?.trim();
    let slug = (args['slug'] as string | undefined)?.trim();
    const iri = (args['iri'] as string | undefined)?.trim();
    if ((!owner || !slug) && iri) {
      const m = /\/ns\/([^/]+)\/([^/?#]+)/.exec(iri);
      if (m) { owner = decodeURIComponent(m[1]!); slug = decodeURIComponent(m[2]!); }
    }
    if (!owner || !slug) return JSON.stringify({ error: 'Provide { iri: "<relay>/ns/<owner>/<slug>" } OR { owner, slug }.' });
    const r = await resolveNsGraph(owner, slug);
    if ('error' in r) return JSON.stringify({ iri: r.ontologyIri, error: r.error });
    const format = String(args['format'] ?? 'turtle').toLowerCase();
    if (format === 'jsonld') {
      try { return JSON.stringify({ iri: r.ontologyIri, contentType: 'application/ld+json', isOntology: r.isOntology, content: nsTurtleToJsonLd(r.turtle) }); }
      catch { /* fall through to turtle */ }
    }
    // HyperMarkdown projection — the affordance set as prose the MODEL reads
    // natively, instead of Turtle only a parser can see. Controls carry no
    // transport endpoint; act via invoke_affordance(descriptorUrl, rel).
    if (format === 'markdown' || format === 'md' || format === 'hmd') {
      try {
        return JSON.stringify({
          iri: r.ontologyIri,
          contentType: HYPERMEDIA_MARKDOWN_MEDIA_TYPE,
          profile: HMD_PROFILE_IRI,
          isOntology: r.isOntology,
          content: nsMarkdown(r.ontologyIri, r.turtle, { owner, slug, descriptorUrl: r.descriptorUrl, isOntology: r.isOntology }),
        });
      } catch { /* fall through to Turtle — same posture as the HTTP route */ }
    }
    return JSON.stringify({ iri: r.ontologyIri, contentType: 'text/turtle', isOntology: r.isOntology, content: r.turtle });
  }

  // ★ ORDER IS THE ROUTING RULE — see invariants 2 and 3 in the file header. These registrations
  // are in the same sequence they were in server.ts, and /ns/pgsl + /ns/iep/action MUST stay
  // ahead of the /ns/:owner/:slug/* wildcard, which would otherwise swallow both. The one
  // EXTERNAL ordering constraint — that all six land after the public linked-data CORS
  // middleware — is checked at call time by the first line of the body, not asserted in prose.
  function mount(app: Express): void {
    // ★★ Refuse to register at all unless the CORS carve-out these routes depend on is already
    // installed. See MOUNT_PRECONDITION above and invariant 3 in the file header.
    assertPublicLinkedDataCorsInstalled(app);

    // ── /ns/pgsl/:kind/:hash — the canonical PGSL node identifier authority ───────
    //
    // A PGSL node id is content-addressed (urn:pgsl:<kind>:<hash>) — a perfect DENOTATION
    // (same content, same id on every pod) but not itself fetchable. describeNode /
    // projectHolon now publish a location-INDEPENDENT canonical URL for each node under
    // THIS authority: https://<relay>/ns/pgsl/<kind>/<hash>. This route makes that id
    // actually RESOLVE, so a node both denotes (the id) and resolves to connotation (its
    // description) — the standing "every id is a dereferenceable URL" principle.
    //
    // ★ THE RELAY DOES HOLD A LATTICE. The comment that stood here claimed otherwise and
    // had been false since the shim/kernel fusion. But that lattice is NOT what this route
    // serves: it is untenanted scratch written by the unauthenticated mint / promote /
    // pgsl_ingest tools, and this route is unauthenticated with ACAO:*. Serving it by hash
    // would be a cross-tenant guess-and-check disclosure oracle over every caller's content
    // — worse for encrypted atoms, whose id is addressed from the PLAINTEXT while the
    // stored value is a placeholder, so a public hash resolver confirms plaintext guesses
    // without leaking a byte.
    //
    // THE INVARIANT: resolvable ⟺ PUBLISHED. Three tiers:
    //   1. the relay's durable published-node store — 200
    //   2. PGSL_NODE_RESOLVER, a fail-closed public-lattice resolver holding a DISJOINT
    //      corpus (the Foxxi bridge's ontology terms + memory commons) — 302
    //   3. uniform 404, byte-identical for never-minted, minted-but-unpublished, and
    //      private — no existence signal.
    // Tier 1 reads the DURABLE store (its in-memory commons is a strict subset), so a
    // local-first write can never shadow what other replicas can see.
    // 4 path segments, so no collision with the 3-segment /ns/:owner/:slug below.
    // The handler lives in pgsl-node-store.ts and is mounted here. It is exported as a
    // factory precisely so the regression test can mount THE SAME FUNCTION — a test that
    // re-implemented it would assert a composition we do not ship, which is how the
    // 302-into-a-foreign-404 survived a suite already containing a test named
    // "…resolves at its authority".
    app.options('/ns/pgsl/:kind/:hash', (_req, res) => { res.status(204).end(); });
    app.get('/ns/pgsl/:kind/:hash', publishedNodes.nodeRouteHandler({
      resolverBase: pgslNodeResolver,
      publicBase: publicBaseUrl,
    }));

    // The naming authority for iep:action identifiers. An action's canonical id is
    // https://relay.interego.xwisee.com/ns/iep/action/<vertical>/<verb>; it 302-redirects to
    // the vertical's affordance manifest, where that action is defined (matchable by iep:action).
    // This is what makes an action id a dereferenceable URL — a term, not a word. Fixed
    // vertical→host map (env-overridable), so there is no open redirect.
    // A value may carry a PATH, not just a host: the relay's own operations are
    // described by /.well-known/operations rather than a vertical's /affordances. That
    // makes the relay's own actions dereferenceable too, which is the precondition for
    // any interop projection whose capability ids must be real URLs rather than urns.
    /**
     * ★★ The roster and the resolution rule live in `action-authority.ts`, not here.
     *
     * They were inline, and the rule was therefore only reachable through an HTTP server — so it was
     * never tested, and it was wrong: a plain object literal plus a bare index meant every member of
     * `Object.prototype` answered as a registered vertical. Measured on the live relay,
     * `GET /ns/iep/action/constructor/publish_context` returned 302 rather than 404. See that module
     * for the full measurement and `tests/action-authority.test.ts` for the cases.
     */
    const IEP_ACTION_VERTICALS: Record<string, string> = buildActionRoster(
      {
        foxxi: 'https://foxxi-bridge.interego.xwisee.com/affordances',
        relay: `${(publicBaseUrl || '').replace(/\/$/, '')}/.well-known/operations`,
      },
      process.env.IEP_ACTION_VERTICALS,
    );
    app.get('/ns/iep/action/:vertical/:verb', (req, res) => {
      // CORS (ACAO:*) via the /ns/* public linked-data carve-out.
      const vertical = String(req.params.vertical);
      const verb = String(req.params.verb);
      // One rule, in one place, imported by the test that pins it. Underscores are allowed in both
      // segments because substrate operation names use them (publish_context, get_descriptor, …);
      // without that every relay action id 404s and the interop card would have to drop them all.
      const resolved = resolveActionTarget(IEP_ACTION_VERTICALS, vertical, verb);
      if (!resolved.ok || resolved.target === undefined) {
        res.status(404).json({ error: 'no such action', reason: resolved.reason });
        return;
      }
      res.redirect(302, resolved.target);
    });

    app.options('/ns/:owner/:slug', (_req, res) => { res.status(204).end(); });
    app.get('/ns/:owner/:slug', async (req, res) => {
      const owner = String(req.params['owner'] ?? '');
      const slug = String(req.params['slug'] ?? '');
      const r = await resolveNsGraph(owner, slug);
      if ('error' in r) { res.status(r.status).type('text/plain').send(r.error); return; }
      const { turtle, ontologyIri, isOntology, descriptorUrl } = r;
      // ONE conneg rule for every projection route (q-aware; explicit ?format wins;
      // ties broken turtle > jsonld > html > markdown; default here = Turtle).
      const kind = negotiateRepresentation(
        String(req.query['format'] ?? '') || undefined,
        String(req.headers['accept'] ?? '') || undefined,
      );
      res.setHeader('Vary', 'Accept');
      if (kind === 'jsonld') {
        try { res.type('application/ld+json').send(JSON.stringify(nsTurtleToJsonLd(turtle), null, 2)); return; } catch { /* fall back to Turtle */ }
      }
      if (kind === 'html') {
        res.type('text/html').send(nsHtml(ontologyIri, turtle, { owner, slug, descriptorUrl, isOntology })); return;
      }
      if (kind === 'markdown') {
        // HyperMarkdown: registered media type (RFC 7763 — charset REQUIRED,
        // variant names the SYNTAX flavor) + RFC 6906 profile Link for the
        // semantic dialect. The same profile claim rides in-band (the frontmatter
        // document node) because headers die at the first copy-paste.
        // try/catch like the jsonld branch: the renderer validates strictly, and
        // /ns serves ARBITRARY user-published graphs on an async Express 4 route
        // — an uncaught throw here would be an unhandled rejection (process exit
        // on Node 22), i.e. a one-GET DoS from one odd published graph.
        try {
          const md = nsMarkdown(ontologyIri, turtle, { owner, slug, descriptorUrl, isOntology });
          res.setHeader('Link', `${HMD_PROFILE_LINK_HEADER}, <${publishableDescriptorUrl(descriptorUrl, ontologyIri)}>; rel="describedby"; type="text/turtle"`);
          res.type(HYPERMEDIA_MARKDOWN_MEDIA_TYPE).send(md);
          return;
        } catch { /* fall back to Turtle */ }
      }
      res.type('text/turtle').send(turtle);
    });

    // ── /ns/:owner/:slug/* — any SUBJECT minted under a published document ────────
    //
    // See `resolveNsSubject`. Registered AFTER /ns/:owner/:slug so the document route keeps
    // priority, and it serves the containing document rather than a synthesised sub-graph: the
    // bytes a reader gets are bytes that were actually published and signed, and the subject
    // they asked about is one of the subjects in them.
    app.get('/ns/:owner/:slug/*', async (req, res) => {
      const owner = String(req.params['owner'] ?? '');
      const slug = String(req.params['slug'] ?? '');
      // Express 4 exposes a trailing `*` capture under the key '0'.
      const raw = (req.params as unknown as Record<string, unknown>)['0'];
      const rest = Array.isArray(raw) ? raw.join('/') : String(raw ?? '');
      const subjectIri = `${RELAY_NS_ROOT}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/${rest}`;
      const r = await resolveNsSubject(owner, slug, subjectIri);
      res.setHeader('Vary', 'Accept');
      if (r.ok !== true) { res.status(r.status).type('text/plain').send(r.error); return; }
      const kind = negotiateRepresentation(
        String(req.query['format'] ?? '') || undefined,
        String(req.headers['accept'] ?? '') || undefined,
      );
      // The served document describes MORE than the requested subject, and saying so is the
      // difference between "here is your resource" and "here is the document it lives in".
      res.setHeader('Content-Location', `${RELAY_NS_ROOT}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`);
      res.setHeader('Link', `<${publishableDescriptorUrl(r.descriptorUrl, subjectIri)}>; rel="describedby"; type="text/turtle"`);
      if (kind === 'jsonld') {
        try { res.type('application/ld+json').send(JSON.stringify(nsTurtleToJsonLd(r.turtle), null, 2)); return; } catch { /* fall back to Turtle */ }
      }
      res.type('text/turtle').send(r.turtle);
    });
  }

  return { mount, publishableDescriptorUrl, nsMarkdown, resolveNsGraph, handleResolveLinkedData };
}
