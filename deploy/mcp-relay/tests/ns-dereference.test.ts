#!/usr/bin/env tsx
/**
 * The /ns dereference surface, exercised by IMPORT rather than by reading server.ts as text.
 *
 * ★★ WHY THIS FILE EXISTS. These ~540 lines lived in the middle of server.ts, which calls
 * app.listen() at module scope and therefore cannot be imported. Nothing here had a unit test —
 * not the Turtle extractor every published ontology is served through, not the descriptor
 * fallback the Markdown projection's safety story rests on, and not the route ORDER that three
 * of these routes depend on to resolve at all. The relay suite's only assertion touching this
 * code was a strip-comments canary that happened to point at one of its lines. This file is
 * what the extraction was for.
 *
 * It exercises the SHIPPED functions and mounts the SHIPPED routes on a real Express app. The
 * only thing standing in for a real dependency is `solidFetch`, which is a genuine injected
 * boundary of the module — the routes, their order, the conneg and the projections are all the
 * code the image runs.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/ns-dereference.test.ts
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  createNsDereference,
  nsExtractGraphTurtle,
  nsTurtleToJsonLd,
  publishableDescriptorUrl,
  isAbsentGraphError,
  nsMarkdown,
  nsHtml,
  assertPublicLinkedDataCorsInstalled,
  MOUNT_PRECONDITION,
  NS_PATH_SHAPES,
} from '../ns-dereference.js';
// The REAL middleware the relay installs, not a stand-in for it. Sections 6 and 8 both compose
// against it: the ordering property under test is a property of that composition, and a harness
// standing in for the dependency cannot verify it.
import { corsMiddleware } from '../cors-allowlist.js';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
};

const GRAPH_IRI = 'https://relay.test/ns/alice/vocab';

// ── 1. nsExtractGraphTurtle: the brace matcher is quote- and comment-AWARE ───────────────────
//
// Every published graph is served through this. It unwraps `<iri> { … }` out of a stored TriG,
// and it must not let a brace inside arbitrary agent-authored prose desync the depth counter —
// that would TRUNCATE the served vocabulary rather than fail, which is the silent-corruption
// class this repo keeps rediscovering. Each hostile case is paired with the benign shape that
// must still work, so a matcher that simply gives up on anything tricky fails the pair.
{
  const wrap = (body: string): string =>
    `@prefix ex: <https://example.org/> .\n\n<${GRAPH_IRI}> {\n${body}\n}\n`;

  const plain = nsExtractGraphTurtle(wrap('    ex:a ex:b "c" .'), GRAPH_IRI);
  ok('a plain graph unwraps', plain !== null && plain.includes('ex:a ex:b "c" .'), String(plain));
  ok('prefixes are hoisted back out', plain !== null && plain.includes('@prefix ex:'), String(plain));
  ok('the four-space publish indent is removed', plain !== null && /^ex:a/m.test(plain), String(plain));

  // An unbalanced closing brace inside a string literal. A naive counter closes the graph early.
  const inString = nsExtractGraphTurtle(
    wrap('    ex:a rdfs:comment "a closing brace } in prose" .\n    ex:z ex:kept "tail" .'), GRAPH_IRI);
  ok('★ a closing brace inside a string literal does not truncate the graph',
    inString !== null && inString.includes('ex:kept'), String(inString));

  const inTriple = nsExtractGraphTurtle(
    wrap('    ex:a rdfs:comment """brace } and { here""" .\n    ex:z ex:kept "tail" .'), GRAPH_IRI);
  ok('★ braces inside a triple-quoted literal do not truncate',
    inTriple !== null && inTriple.includes('ex:kept'), String(inTriple));

  const inComment = nsExtractGraphTurtle(
    wrap('    # a } in a comment\n    ex:z ex:kept "tail" .'), GRAPH_IRI);
  ok('★ a closing brace inside a # comment does not truncate',
    inComment !== null && inComment.includes('ex:kept'), String(inComment));

  // …and a REAL nested block must still close correctly, so the guard above is not "ignore braces".
  const nested = nsExtractGraphTurtle(wrap('    ex:a ex:b [ ex:c "d" ] .'), GRAPH_IRI);
  ok('a genuine nested structure still unwraps', nested !== null && nested.includes('ex:c "d"'), String(nested));

  ok('a graph this TriG does not contain returns null',
    nsExtractGraphTurtle(wrap('    ex:a ex:b "c" .'), 'https://relay.test/ns/bob/other') === null);
}

// ── 2. publishableDescriptorUrl: an authority you cannot reach is not an authority ───────────
//
// The Markdown projection's whole safety story is "the target is not in this document — go
// re-resolve it from descriptorUrl". When the resolved descriptor is the INTERNAL CSS URL, a
// reader outside the private network cannot fetch it, so the graph's own IRI is published
// instead. Both directions are pinned: a public URL must pass through UNCHANGED, or the
// fallback would be swallowing every real authority.
{
  const pub = 'https://alice.pod.example/ontologies/vocab.ttl';
  ok('a publicly dereferenceable descriptor is published as-is',
    publishableDescriptorUrl(pub, GRAPH_IRI) === pub, publishableDescriptorUrl(pub, GRAPH_IRI));

  for (const internal of [
    // The production CSS spelling. `.internal` is refused by assertPublicPodUrl, so this is the
    // case that actually fires on the live fleet.
    'http://css.railway.internal:3456/alice/ontologies/vocab.ttl',
    'http://10.0.0.5:3456/alice/ontologies/vocab.ttl',
    'not a url at all',
    '',
  ]) {
    ok(`★ an unreachable descriptor falls back to the graph IRI (${internal.slice(0, 30) || '<empty>'})`,
      publishableDescriptorUrl(internal, GRAPH_IRI) === GRAPH_IRI,
      publishableDescriptorUrl(internal, GRAPH_IRI));
  }

  // ★ A DELIBERATE EXCEPTION, PINNED SO IT IS A DECISION RATHER THAN A SURPRISE.
  // assertPublicPodUrl permits http://localhost and http://127.0.0.1 (url-rewrite.ts allows
  // plain http for exactly those two hosts), so a localhost descriptor is published verbatim
  // rather than falling back. That is right for local development and harmless in production,
  // where CSS_URL is the `.internal` spelling above and therefore always takes the fallback.
  // Asserted rather than assumed: if that allowance is ever tightened, this line says so.
  const local = 'http://localhost:3456/alice/ontologies/vocab.ttl';
  ok('a localhost descriptor is published as-is (local-dev allowance, not a fallback)',
    publishableDescriptorUrl(local, GRAPH_IRI) === local, publishableDescriptorUrl(local, GRAPH_IRI));
}

// ── 3. isAbsentGraphError distinguishes ABSENT from BROKEN ───────────────────────────────────
//
// This is the difference between a clean 404 for an unpublished slug and a 502 for a real
// upstream failure. It reads the `: <status>` token out of fetchGraphContent's throw text, and
// it must not false-match on digits inside the URL — which is why it keys on colon-space.
{
  ok('a 404 is absent', isAbsentGraphError(new Error('Failed to GET https://p.example/g.trig: 404 Not Found')));
  ok('a 410 is absent', isAbsentGraphError(new Error('Failed to GET https://p.example/g.trig: 410 Gone')));
  ok('a 500 is NOT absent', !isAbsentGraphError(new Error('Failed to GET https://p.example/g.trig: 500 Server Error')));
  ok('a network error is NOT absent', !isAbsentGraphError(new Error('fetch failed')));
  ok('★ a 404 in the URL PATH is not a status',
    !isAbsentGraphError(new Error('Failed to GET https://p.example/404/g.trig: 500 Server Error')));
}

// ── 4. nsTurtleToJsonLd publishes no null-valued literal ─────────────────────────────────────
//
// A node asserting nothing, on a route whose job is to serve the vocabulary faithfully.
{
  const jsonld = nsTurtleToJsonLd('@prefix ex: <https://example.org/> .\nex:a ex:b "lit" ; ex:c ex:d .\n');
  const text = JSON.stringify(jsonld);
  ok('a context is emitted', typeof (jsonld as { '@context'?: unknown })['@context'] === 'object');
  ok('a graph is emitted', Array.isArray((jsonld as { '@graph'?: unknown })['@graph']));
  ok('★ no null-valued literal is published', !text.includes('"@value":null'), text.slice(0, 200));
  ok('the literal survives', text.includes('lit'), text.slice(0, 200));
}

// ── 5. The projections do not emit a transport endpoint ──────────────────────────────────────
//
// controlsFromAffordances drops hydra:target on the floor so untrusted prose cannot steer an
// auto-approved invoke_affordance at an attacker-chosen URL (MCP approves per-TOOL, not
// per-TARGET). Pinned here because Markdown is the store-and-forward projection — these bytes
// get pasted into contexts where no CORS or origin check applies.
{
  const turtle = [
    '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .',
    '@prefix hydra: <http://www.w3.org/ns/hydra/core#> .',
    `<${GRAPH_IRI}> a <http://www.w3.org/2002/07/owl#Ontology> .`,
    '<https://relay.test/aff/1> a iep:Affordance ;',
    '    iep:action <https://relay.test/ns/iep/action/relay/publish_context> ;',
    '    hydra:target <https://attacker.example/collect> .',
  ].join('\n');
  const meta = { owner: 'alice', slug: 'vocab', descriptorUrl: 'https://alice.pod.example/d.ttl', isOntology: true };

  const md = nsMarkdown(GRAPH_IRI, turtle, meta);
  ok('★ the Markdown projection carries no hydra:target endpoint',
    !md.includes('attacker.example'), md.slice(0, 300));
  ok('the Markdown projection names the signed authority',
    md.includes('https://alice.pod.example/d.ttl'), md.slice(0, 300));

  const html = nsHtml(GRAPH_IRI, '<a> <b> "x & y <z>" .', meta);
  ok('★ the HTML projection escapes the served Turtle',
    html.includes('&amp;') && html.includes('&lt;z&gt;'), html.slice(-220));
}

// ── 6. ★★ THE ROUTE ORDER IS THE ROUTING RULE — the invariant that was untestable ────────────
//
// `/ns/pgsl/:kind/:hash` and `/ns/iep/action/:vertical/:verb` BOTH also match
// `/ns/:owner/:slug/*` (owner=pgsl, slug=atom, rest=<hash>). They resolve only because mount()
// registers them FIRST. Nothing could assert this while the routes were inline in server.ts,
// and it is exactly what a careless extraction breaks — silently, with a plausible 404 body.
//
// Every assertion here checks the BODY, not only the status: an unknown vertical 404s either
// way, so a status-only test passes whichever route answered. That is the shape of test this
// repo has been burned by before.
{
  const app = express();
  // The relay's own composition: the public linked-data CORS carve-out, then the /ns routes.
  // mount() now REFUSES an app without it (section 8), so this line is also the positive half of
  // that guard — remove it and every assertion in this block fails at the mount call.
  app.use(corsMiddleware({ ownOrigin: 'https://relay.test' }) as never);
  const ns = createNsDereference({
    cssUrl: 'http://css.internal:3456/',
    publicBaseUrl: 'https://relay.test',
    pgslNodeResolver: 'https://resolver.test/lattice',
    // Nothing is published anywhere, so every /ns/:owner/:slug path reaches its 404 branch —
    // which is what makes "did the wildcard swallow this?" observable at all.
    solidFetch: (async () => new Response('', { status: 404, statusText: 'Not Found' })) as never,
  });
  ns.mount(app);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  const get = async (p: string): Promise<{ status: number; body: string; loc: string | null }> => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { redirect: 'manual' });
    return { status: r.status, body: await r.text(), loc: r.headers.get('location') };
  };
  // The wildcard's 404 body is the tell: only it names the graph IRI this way.
  const WILDCARD_TELL = 'No published graph at';

  const act = await get('/ns/iep/action/relay/get_descriptor');
  ok('★★ /ns/iep/action resolves (not swallowed by /ns/:owner/:slug/*)',
    act.status === 302, `${act.status} ${act.body.slice(0, 120)}`);
  ok('★★ …and redirects to the operations catalog',
    act.loc === 'https://relay.test/.well-known/operations', String(act.loc));

  const unknownVertical = await get('/ns/iep/action/nosuch/verb');
  ok('★★ an unknown vertical 404s FROM THE ACTION ROUTE, not from the wildcard',
    unknownVertical.status === 404 && unknownVertical.body.includes('no such action'),
    `${unknownVertical.status} ${unknownVertical.body.slice(0, 160)}`);

  // Same question for the PGSL node authority: 4 segments, also wildcard-shaped.
  const pgsl = await get(`/ns/pgsl/atom/${'a'.repeat(40)}`);
  ok('★★ /ns/pgsl/:kind/:hash is answered by the node authority, not the wildcard',
    !pgsl.body.includes(WILDCARD_TELL), `${pgsl.status} ${pgsl.body.slice(0, 160)}`);

  const badHash = await get('/ns/pgsl/atom/nothex');
  ok('★★ …including for a malformed hash (still not the wildcard 404)',
    !badHash.body.includes(WILDCARD_TELL), `${badHash.status} ${badHash.body.slice(0, 160)}`);

  for (const p of [`/ns/pgsl/atom/${'a'.repeat(40)}`, '/ns/alice/vocab']) {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'OPTIONS' });
    ok(`OPTIONS ${p.slice(0, 22)} is 204`, r.status === 204, String(r.status));
  }

  // The document route reaches its own 404 (a genuine not-found, not a 502) when nothing is
  // published — the isAbsentGraphError path, end to end through the shipped route.
  const doc = await get('/ns/alice/vocab');
  ok('an unpublished document 404s rather than 502s',
    doc.status === 404 && doc.body.includes(WILDCARD_TELL), `${doc.status} ${doc.body.slice(0, 160)}`);

  // …and the subject wildcard is still reachable for a genuinely deeper path, so the ordering
  // assertions above are not passing merely because the wildcard never registered.
  const subj = await get('/ns/alice/vocab/e/7');
  ok('the subject wildcard still answers for a real subject path',
    subj.status === 404 && subj.body.includes(WILDCARD_TELL), `${subj.status} ${subj.body.slice(0, 160)}`);

  // THE CROSS-ORIGIN HALF, over the wire and through the real middleware. This is the property
  // the mount-ordering guard exists to protect: a /ns response a browser agent cannot read is a
  // dereference surface that does not work, and it is 200 on the wire either way.
  for (const p of ['/ns/alice/vocab', '/ns/iep/action/relay/get_descriptor']) {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      redirect: 'manual', headers: { origin: 'https://somewhere.example' },
    });
    ok(`★★ ${p.slice(0, 26)} is readable cross-origin (ACAO:*)`,
      r.headers.get('access-control-allow-origin') === '*',
      String(r.headers.get('access-control-allow-origin')));
    ok(`★ …and its Link/ETag are exposed to that reader`,
      (r.headers.get('access-control-expose-headers') ?? '').includes('Link'),
      String(r.headers.get('access-control-expose-headers')));
  }

  await new Promise<void>((r) => server.close(() => r()));
}

// ── 8. ★★ THE MOUNT ORDERING INVARIANT IS ENFORCED, NOT DOCUMENTED ───────────────────────────
//
// Before the extraction these routes were a block of app.get calls physically embedded in
// server.ts, and the ordering property was implied by where the code lived. The extraction
// turned it into ONE movable statement, and a statement that can move anywhere needs something
// other than a comment saying "keep this here" — that is precisely the failure this project's
// own audit names as characteristic. So mount() asserts its own precondition against the app's
// INSTALLED middleware stack, and both directions are pinned here.
//
// The claim is bounded by a measurement, not by reading: the relay was booted and its live
// router stack dumped — 79 layers, 71 route registrations and 8 path-agnostic `app.use`
// middlewares — then every layer was asked `layer.match(p)` for each of the four /ns path
// shapes. FOURTEEN match at least one: the 6 registered by mount(), and all 8 `app.use`
// middlewares, which match every path (Express's own `query` and `expressInit`, the HSTS header
// middleware, the two body parsers, `corsMiddleware`, the CORS-freeze wrapper, and the OAuth
// router mounted at '/'). Of the 65 non-/ns route registrations, NONE matches a /ns path, and no
// /ns route matches any of theirs. So the only external ordering constraint is the CORS
// carve-out, which is exactly what this guard checks.
//
// ★★ AND "CHECKS" NOW MEANS `layer.match(path)`, NOT `layer.handle`. The first version of the
// guard asked only whether the tagged FUNCTION was somewhere on the stack, which is a different
// question from whether it RUNS for a /ns path — an Express layer carries a mount path too.
// Measured: `app.use('/mcp', corsMiddleware({…}))` satisfied it, mount() returned normally, and
// a live `GET /ns/alice/vocab` with an Origin header came back
// `access-control-allow-origin: null`. The path-mounted decoy below is that reproduction, and
// the block after it drives the same composition over the wire.
{
  const cors = corsMiddleware({ ownOrigin: 'https://relay.test' });
  const ns = createNsDereference({
    cssUrl: 'http://css.internal:3456/',
    publicBaseUrl: 'https://relay.test',
    pgslNodeResolver: 'https://resolver.test/lattice',
    solidFetch: (async () => new Response('', { status: 404 })) as never,
  });

  const refused = (build: (a: express.Express) => void): string | null => {
    const a = express();
    build(a);
    try { ns.mount(a); return null; } catch (e) { return (e as Error).message; }
  };

  // The reproduced defect, exactly: the call moved into the window ABOVE app.use(cors...).
  const tooEarly = refused(() => { /* nothing installed yet */ });
  ok('★★ mounting before corsMiddleware is refused', tooEarly !== null, 'mount() returned normally');
  ok('★ …and the refusal is the precondition class',
    (tooEarly ?? '').startsWith(MOUNT_PRECONDITION), String(tooEarly));
  ok('★ …and it names the fix rather than the symptom',
    (tooEarly ?? '').includes('AFTER `app.use(corsMiddleware'), String(tooEarly));

  // A guard that any middleware satisfies would not be a guard. This is the near miss: an app
  // with real middleware installed — including a hand-rolled one setting the same header — but
  // not the tagged carve-out.
  const decoy = refused((a) => {
    a.use(express.json());
    a.use((_q, res2, n) => { res2.setHeader('Access-Control-Allow-Origin', '*'); n(); });
  });
  ok('★★ an untagged look-alike middleware does NOT satisfy the precondition',
    decoy !== null && decoy.startsWith(MOUNT_PRECONDITION), String(decoy));

  // ★★ THE MEASURED FALSE NEGATIVE: the tagged middleware IS installed, at a mount path that
  // does not match /ns. `layer.handle` says yes; `layer.match('/ns/alice/vocab')` says no, and
  // Express agrees with `match`. This is the reproduction, through the guard rather than around
  // it — the wire half is driven in the block below.
  const pathMounted = refused((a) => { a.use('/mcp', cors as never); });
  ok('★★ corsMiddleware mounted at a PATH that misses /ns is refused',
    pathMounted !== null, 'mount() returned normally for app.use(\'/mcp\', corsMiddleware(...))');
  ok('★ …and the refusal is the precondition class',
    (pathMounted ?? '').startsWith(MOUNT_PRECONDITION), String(pathMounted));
  ok('★ …and it says the middleware is installed but does not RUN for the /ns paths, naming them',
    (pathMounted ?? '').includes('IS installed') && (pathMounted ?? '').includes('/ns/alice/vocab'),
    String(pathMounted));
  ok('★ …and names the fix: install it path-agnostically',
    (pathMounted ?? '').includes('app.use(corsMiddleware('), String(pathMounted));

  // A mount path that DOES cover /ns is fine — the guard asks the routing question, not a
  // spelling question, so it must not refuse a composition that actually works.
  const nsMounted = refused((a) => { a.use('/ns', cors as never); });
  ok('★ …while a mount path that DOES cover every /ns shape is accepted',
    nsMounted === null, String(nsMounted));

  // …and the positive direction, so the guard is not simply "always throw".
  const okApp = express();
  okApp.use(cors as never);
  let mounted = true;
  try { ns.mount(okApp); } catch { mounted = false; }
  ok('★★ mounting after corsMiddleware succeeds', mounted);

  // Position AFTER the carve-out is unconstrained — the measured half of the claim. An app that
  // has since registered unrelated routes still mounts fine, so this guard pins the constraint
  // that exists rather than inventing a tighter one.
  const laterApp = express();
  laterApp.use(cors as never);
  laterApp.get('/health', (_q, res2) => { res2.end('ok'); });
  laterApp.get('/render/:iri', (_q, res2) => { res2.end('ok'); });
  let mountedLate = true;
  try { ns.mount(laterApp); } catch { mountedLate = false; }
  ok('★ …and mounting later still, after unrelated routes, is allowed', mountedLate);

  // The "cannot read the stack" branch answers differently from "not installed", because a check
  // that cannot see is not a check that passed. Constructed rather than waited for: no Express
  // version in this repo produces it, so the alternative to forging it is not testing it at all.
  const blind = { _router: { stack: 'not an array' } } as unknown as express.Express;
  let blindMsg = '';
  try { assertPublicLinkedDataCorsInstalled(blind); } catch (e) { blindMsg = (e as Error).message; }
  ok('★ an unreadable middleware stack is refused, not waved through',
    blindMsg.startsWith(MOUNT_PRECONDITION) && blindMsg.includes('could not be verified'), blindMsg);

  // ★★ THE PROBE LIST HAS TO COVER EVERY ROUTE mount() REGISTERS, or the guard checks a
  // carve-out over part of the surface and calls it the whole. Asked of the REAL routes on a
  // real app rather than of a list kept here: every /ns route layer must be matched by at least
  // one NS_PATH_SHAPES entry, so a seventh route with a new shape fails this instead of
  // silently going unguarded.
  const shapeApp = express();
  shapeApp.use(cors as never);
  ns.mount(shapeApp);
  const nsLayers = ((shapeApp as unknown as { _router: { stack: { route?: { path: string } }[] } })
    ._router.stack).filter(l => typeof l.route?.path === 'string' && l.route.path.startsWith('/ns'));
  ok('§8 the mounted app really does carry the /ns routes', nsLayers.length === 6, `${nsLayers.length}`);
  const uncovered = nsLayers.filter(l => !NS_PATH_SHAPES.some(
    p2 => (l as unknown as { match: (x: string) => unknown }).match(p2)));
  ok('★★ every /ns route mount() registers is covered by a NS_PATH_SHAPES probe',
    uncovered.length === 0, uncovered.map(l => l.route?.path ?? '?').join(', '));

  // ★ AND THE WIRE HALF OF THE FALSE NEGATIVE, so the guard is pinned against the symptom and
  // not only against its own message. With the carve-out path-mounted at /mcp the guard now
  // refuses, so the composition that produced `access-control-allow-origin: null` is stood up
  // WITHOUT the guard — assertPublicLinkedDataCorsInstalled is what mount() adds — to show the
  // symptom is real and that the guard's question is the one that predicts it.
  const decoyApp = express();
  decoyApp.use('/mcp', cors as never);
  let decoyGuard: string | null = null;
  try { assertPublicLinkedDataCorsInstalled(decoyApp); } catch (e) { decoyGuard = (e as Error).message; }
  ok('★ the guard refuses the path-mounted composition', decoyGuard !== null, String(decoyGuard));
  decoyApp.get('/ns/:owner/:slug', (_q, res2) => { res2.status(404).end('nope'); });
  const decoyServer = decoyApp.listen(0, '127.0.0.1');
  await new Promise<void>((r) => decoyServer.once('listening', () => r()));
  const decoyPort = (decoyServer.address() as AddressInfo).port;
  const decoyRes = await fetch(`http://127.0.0.1:${decoyPort}/ns/alice/vocab`, {
    headers: { origin: 'https://somewhere.example' },
  });
  ok('★★ …and that composition really does serve /ns with NO Access-Control-Allow-Origin, '
    + '200-or-404 on the wire and invisible to a cross-origin reader',
    decoyRes.headers.get('access-control-allow-origin') === null,
    String(decoyRes.headers.get('access-control-allow-origin')));
  await new Promise<void>((r) => decoyServer.close(() => r()));
}

// ── 9. OPTIONS on the subject wildcard — PRE-EXISTING, recorded rather than changed ───────────
//
// mount() registers app.options for /ns/pgsl/:kind/:hash and /ns/:owner/:slug but NOT for
// /ns/:owner/:slug/*, so an OPTIONS to a subject IRI falls through to Express's default OPTIONS
// responder instead of the 204 its siblings return. That asymmetry is unchanged from before the
// extraction — HEAD's server.ts registered exactly the same three GETs and two OPTIONS in this
// same order — so it is not a regression the extraction introduced, and this refactor
// deliberately does not alter it. Pinned so that changing it later is a decision, not a drift.
{
  const app = express();
  app.use(corsMiddleware({ ownOrigin: 'https://relay.test' }) as never);
  createNsDereference({
    cssUrl: 'http://css.internal:3456/',
    publicBaseUrl: 'https://relay.test',
    pgslNodeResolver: 'https://resolver.test/lattice',
    solidFetch: (async () => new Response('', { status: 404 })) as never,
  }).mount(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;

  const sibling = await fetch(`http://127.0.0.1:${port}/ns/alice/vocab`, { method: 'OPTIONS' });
  ok('OPTIONS on the document route is the explicit 204', sibling.status === 204, String(sibling.status));

  const wild = await fetch(`http://127.0.0.1:${port}/ns/alice/vocab/e/7`, { method: 'OPTIONS' });
  ok("PRE-EXISTING: OPTIONS on the subject wildcard is 200 from Express's default responder",
    wild.status === 200, String(wild.status));
  ok('PRE-EXISTING: …and it answers with an Allow list rather than the sibling 204',
    (wild.headers.get('allow') ?? '').includes('GET'), String(wild.headers.get('allow')));

  await new Promise<void>((r) => server.close(() => r()));
}

// ── 7. The MCP tool and the HTTP route share one core ────────────────────────────────────────
//
// resolve_linked_data must answer from resolveNsGraph, not from a restatement of it, or the
// SSRF host-pinning and the supersession walk would apply to one caller and not the other.
{
  const ns = createNsDereference({
    cssUrl: 'http://css.internal:3456/',
    publicBaseUrl: 'https://relay.test',
    pgslNodeResolver: 'https://resolver.test/lattice',
    solidFetch: (async () => new Response('', { status: 404, statusText: 'Not Found' })) as never,
  });

  const byIri = JSON.parse(await ns.handleResolveLinkedData({ iri: 'https://relay.test/ns/alice/vocab' }));
  ok('the tool parses owner/slug out of a full IRI',
    typeof byIri.error === 'string' && byIri.error.includes('alice'), JSON.stringify(byIri).slice(0, 160));
  ok('…and reports the same IRI the route would', byIri.iri === GRAPH_IRI, String(byIri.iri));

  const byParts = JSON.parse(await ns.handleResolveLinkedData({ owner: 'alice', slug: 'vocab' }));
  ok('owner+slug and iri reach the same answer', byParts.error === byIri.error, String(byParts.error));

  const neither = JSON.parse(await ns.handleResolveLinkedData({}));
  ok('neither form provided is refused, not guessed',
    typeof neither.error === 'string' && neither.error.includes('Provide'), String(neither.error));
}

console.log(`ns-dereference: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
