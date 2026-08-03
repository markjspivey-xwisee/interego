#!/usr/bin/env tsx
/**
 * The publish gate's shape fetch: what it will follow, and what it refuses to.
 *
 * ★ WHY THIS SUITE EXISTS AT ALL. `fetchShapeBody` followed a page's
 * `<link rel="alternate" type="text/turtle">` with its own inline copy of the hop, and that
 * copy did NOT refuse a cross-origin alternate. A shape whose HTML page advertised a Turtle
 * document on a FOREIGN ORIGIN had that document fetched and used as the gate — so whoever
 * controlled the foreign origin decided what every `conforms_to_shapes` publish to that pod
 * had to satisfy, while the caller believed it was validating against the IRI it named.
 *
 * ★★ AND WHY IT IS A UNIT SUITE RATHER THAN A LIVE RUN. A LIVE RUN EXERCISES THE HONEST PATH
 * AND NOTHING ELSE. Every shape we publish advertises a SAME-ORIGIN RELATIVE href (measured:
 * all 78 `text/turtle` alternates in the deployed `docs/` tree), so production cannot tell a
 * follower that refuses a foreign origin from one that does not, and cannot tell FOLLOWING
 * the advertised href from GUESSING `<IRI>.ttl` — our pages advertise exactly the name a
 * guesser would derive. Both cases below are built so the two answers DIFFER.
 *
 * ★ THE DOUBLE ANSWERS DIFFERENTLY PER URL, ON PURPOSE. Every document in a web carries its
 * own URL in its body, and the shape at a "wrong" URL is deliberately the PERMISSIVE one. A
 * double that returned one body for every request would let a mutant that fetched the wrong
 * document pass every assertion here.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/shape-body-alternate.test.ts
 *
 * Exits non-zero on any failing assertion.
 */

import {
  fetchShapeBodyWith,
  type FetchedShapeRepresentation,
  type ShapeBodyCacheEntry,
} from '../shape-body.js';

let pass = 0;
let fail = 0;

function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) {
    pass += 1;
    // eslint-disable-next-line no-console
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

// ── The web the gate reads ───────────────────────────────────────────────────

/**
 * The contract a real published shape carries: a title AND a creator are required. This is
 * the document a correct follower must end up with.
 */
const strictShape = (at: string): string => `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix dct: <http://purl.org/dc/terms/> .
# served from ${at}
<#S> a sh:NodeShape ;
  sh:property [ sh:path dct:title ; sh:minCount 1 ] ;
  sh:property [ sh:path dct:creator ; sh:minCount 1 ] .
`;

/**
 * The contract an attacker (or a stale guess) would rather the gate used: it constrains
 * nothing. Parked at every URL a mutant might reach instead of the advertised one, so a
 * mutant SUCCEEDS with the wrong document rather than failing loudly — which is the only
 * arrangement in which the assertion below can see the difference.
 */
const permissiveShape = (at: string): string => `@prefix sh: <http://www.w3.org/ns/shacl#> .
# served from ${at} — constrains nothing
<#S> a sh:NodeShape .
`;

/** A page advertising `href` as its Turtle, in the shape our generator actually emits. */
const pageAdvertising = (href: string): string =>
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n'
  + `<link rel="alternate" type="text/turtle" href="${href}" />\n`
  + `<link rel="describedby" type="text/turtle" href="${href}" />\n`
  + '</head>\n<body><h1>Shape</h1></body>\n</html>\n';

interface Doc {
  readonly body: string;
  readonly status?: number;
  readonly statusText?: string;
  /** Where the bytes actually came from, when that differs from the URL asked for. */
  readonly landsAt?: string;
}

/**
 * A web of URL → document, recording every URL the gate asked for.
 *
 * ★ THE DOUBLE HANDS BACK A BODY ON A NON-2XX, WHICH THE REAL ADAPTER DOES NOT. `server.ts`
 * returns `''` for an error response so a caller-chosen host cannot make the relay buffer an
 * unbounded error page. Reproducing that here would HIDE a mutant that used the error body as
 * the shape — the 503 case below would then be indistinguishable from an empty one. A double
 * exists to express failures the honest path cannot, so it stays more permissive than the
 * adapter on purpose.
 */
function webOf(web: Record<string, Doc>) {
  const asked: string[] = [];
  const fetchRepresentation = async (url: string): Promise<FetchedShapeRepresentation> => {
    asked.push(url);
    const d = web[url];
    if (d === undefined) {
      return {
        ok: false, status: 404, statusText: 'Not Found', url,
        contentType: 'text/html', body: '<!doctype html><h1>404</h1>',
      };
    }
    const status = d.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: d.statusText ?? 'OK',
      url: d.landsAt ?? url,
      contentType: /^\s*<(?:!doctype|html)/i.test(d.body) ? 'text/html' : 'text/turtle',
      body: d.body,
    };
  };
  return { asked, fetchRepresentation };
}

/** Deps with a fresh cache unless the caller primes one. */
function depsFor(
  fetchRepresentation: (url: string) => Promise<FetchedShapeRepresentation>,
  cache: Map<string, ShapeBodyCacheEntry> = new Map(),
) {
  const logs: string[] = [];
  return {
    logs,
    cache,
    deps: {
      fetchRepresentation,
      // Stands in for the in-process SHACL parser. Deliberately narrower than "not HTML":
      // the real predicate refuses ANY body the shapes parser cannot read — an HTML error
      // page, a JSON error envelope — and a double that only screened HTML would let a
      // JSON body earn 24h of known-good status, which is precisely the case below.
      parsesAsShapesGraph: (body: string) => /\bsh:NodeShape\b/.test(body),
      log: (m: string) => { logs.push(m); },
      cache,
      cacheMax: 256,
      freshTtlMs: 60_000,
      knownGoodTtlMs: 24 * 60 * 60 * 1000,
    },
  };
}

const SHAPE = 'https://shapes.test/ns/record-shape';

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('\nthe alternate a shape page advertises');

  // ── ★★ THE HOLE THIS ROUND CLOSED ─────────────────────────────────────────
  {
    // The shape IRI answers 200 text/html — exactly what GitHub Pages does for our own
    // ontology IRIs — and names somebody else's Turtle as its own representation. The
    // foreign document EXISTS and is reachable, and it is the PERMISSIVE shape: before this
    // round the gate fetched it and every publish to the pod was validated against a
    // contract a stranger wrote.
    const { asked, fetchRepresentation } = webOf({
      [SHAPE]: { body: pageAdvertising('https://evil.test/loose.ttl') },
      'https://evil.test/loose.ttl': { body: permissiveShape('https://evil.test/loose.ttl') },
    });
    const { deps, logs, cache } = depsFor(fetchRepresentation);
    const body = await fetchShapeBodyWith(SHAPE, deps);

    ok(body === null,
      '★★ a CROSS-ORIGIN alternate is refused — the gate fails closed rather than validating '
      + 'against a foreign document',
      body === null ? '' : `got a body: ${JSON.stringify(body).slice(0, 90)}`);
    // ★★ THIS IS THE ASSERTION THAT KILLS THE MUTANT, AND THE ONE ABOVE IS NOT. Measured:
    // deleting the cross-origin refusal in `alternateTurtleUrl` leaves the assertion above
    // GREEN, because the follower's landed-URL check then catches the same document one step
    // later and the gate still returns null. Two guards overlap on the outcome and differ
    // only in whether the request is MADE — and making it is not free: it hands a foreign
    // host a request from the relay, with our Accept header, whose timing tells the attacker
    // their document was reached. Contact is the observable, so contact is what is asserted.
    ok(!asked.includes('https://evil.test/loose.ttl'),
      '★ …and the foreign origin is never even CONTACTED, so the refusal is not "fetch then '
      + 'discard"',
      `asked: ${JSON.stringify(asked)}`);
    ok(logs.some(l => /different origin/.test(l)),
      '★ …and the WARN log names WHICH step refused, so an outage sends an operator to the '
      + 'markup rather than the network',
      JSON.stringify(logs));
    ok(cache.get(SHAPE) === undefined,
      '★ …and nothing is cached, so the foreign body cannot become last-known-good');
  }

  {
    // ★ THE CONTROL. A follower that refused every alternate would satisfy the case above
    // and be useless — and would break every ontology IRI we publish, all of which serve
    // HTML. A SAME-ORIGIN alternate must still be followed, and the strict shape must come
    // back.
    const { fetchRepresentation, asked } = webOf({
      [SHAPE]: { body: pageAdvertising('record-shape.ttl') },
      'https://shapes.test/ns/record-shape.ttl': {
        body: strictShape('https://shapes.test/ns/record-shape.ttl'),
      },
    });
    const { deps } = depsFor(fetchRepresentation);
    const body = await fetchShapeBodyWith(SHAPE, deps);
    ok(body === strictShape('https://shapes.test/ns/record-shape.ttl'),
      '★ a SAME-ORIGIN alternate is still followed — the case every published ontology IRI is',
      JSON.stringify(body).slice(0, 90));
    ok(asked.length === 2,
      '★ …in exactly two fetches: the page, then its Turtle',
      JSON.stringify(asked));
  }

  {
    // ★★ FOLLOWING vs GUESSING, WHICH PRODUCTION CANNOT SEPARATE. Our own pages advertise
    // `<name>.ttl`, which is also what `shapeIri + '.ttl'` derives, so a live run scores a
    // guesser and a follower identically. Here the advertised name is DIFFERENT, and the
    // guessable URL EXISTS and serves the permissive shape — so "just append .ttl" succeeds
    // with a contract that constrains nothing instead of failing where somebody would notice.
    const { fetchRepresentation, asked } = webOf({
      [SHAPE]: { body: pageAdvertising('record-shape-v2.ttl') },
      'https://shapes.test/ns/record-shape-v2.ttl': {
        body: strictShape('https://shapes.test/ns/record-shape-v2.ttl'),
      },
      'https://shapes.test/ns/record-shape.ttl': {
        body: permissiveShape('https://shapes.test/ns/record-shape.ttl'),
      },
    });
    const { deps } = depsFor(fetchRepresentation);
    const body = await fetchShapeBodyWith(SHAPE, deps);
    ok(body === strictShape('https://shapes.test/ns/record-shape-v2.ttl'),
      '★★ the gate follows the href the PAGE names, not an extension a reader guessed',
      JSON.stringify(body).slice(0, 90));
    ok(!asked.includes('https://shapes.test/ns/record-shape.ttl'),
      '★ …and the guessable URL is never asked for at all',
      JSON.stringify(asked));
  }

  // eslint-disable-next-line no-console
  console.log('\nhow far the gate will follow');

  {
    // ★ THE BOUND IS THE GUARD, AND THE ASSERTION IS THE FETCH COUNT. A page whose alternate
    // points at another page — a self-referential href, a directory index, a soft-404 that
    // advertises itself — is what a misconfigured static host produces, and an unbounded
    // follower spins on one forever inside a publish gate. Raising the budget to 2 still
    // terminates and (here) still refuses, so only `asked` can see the difference.
    const { fetchRepresentation, asked } = webOf({
      [SHAPE]: { body: pageAdvertising('page-two') },
      'https://shapes.test/ns/page-two': { body: pageAdvertising('record-shape.ttl') },
      'https://shapes.test/ns/record-shape.ttl': {
        body: permissiveShape('https://shapes.test/ns/record-shape.ttl'),
      },
    });
    const { deps, logs } = depsFor(fetchRepresentation);
    const body = await fetchShapeBodyWith(SHAPE, deps);
    ok(body === null, '★ a chain of pages is refused, not chased',
      JSON.stringify(body).slice(0, 90));
    ok(asked.length === 2 && asked[1] === 'https://shapes.test/ns/page-two',
      '★ …after EXACTLY ONE hop — the second page is fetched, the third is not',
      JSON.stringify(asked));
    ok(logs.some(l => /bounded at 1 hop/.test(l)),
      '★ …and the bound is stated in the log rather than inferred from a hang');
  }

  {
    // ★ A same-origin href that REDIRECTS off the origin arrives past the href check, and
    // reading the response without re-checking where it landed would let a redirect reach
    // exactly what a foreign href is refused for.
    const { fetchRepresentation } = webOf({
      [SHAPE]: { body: pageAdvertising('record-shape.ttl') },
      'https://shapes.test/ns/record-shape.ttl': {
        landsAt: 'https://evil.test/loose.ttl',
        body: permissiveShape('https://evil.test/loose.ttl'),
      },
    });
    const { deps, logs } = depsFor(fetchRepresentation);
    const body = await fetchShapeBodyWith(SHAPE, deps);
    ok(body === null,
      '★ a REDIRECT off the origin on the hop is refused, which an href check alone cannot see',
      JSON.stringify(body).slice(0, 90));
    ok(logs.some(l => /different origin from the page that advertised it/.test(l)),
      '★ …and the refusal names the redirect rather than the href');
  }

  {
    // ★★ THE CASE THE GUARD ITSELF COULD HAVE BROKEN, AND THE REASON THE ANCHOR IS THE
    // LANDED URL. `normalizeCssUrl` rewrites a legacy public CSS host onto its `.internal.`
    // form, so for every pod-hosted shape the URL ASKED FOR and the URL FETCHED are
    // different ORIGINS. A same-origin check anchored on the IRI the caller named would
    // refuse all of them — the guard meant to protect the gate would have closed it.
    const asked2 = webOf({
      [SHAPE]: {
        landsAt: 'https://pinned.internal.test/ns/record-shape',
        body: pageAdvertising('record-shape.ttl'),
      },
      'https://pinned.internal.test/ns/record-shape.ttl': {
        body: strictShape('https://pinned.internal.test/ns/record-shape.ttl'),
      },
    });
    const { deps } = depsFor(asked2.fetchRepresentation);
    const body = await fetchShapeBodyWith(SHAPE, deps);
    ok(body === strictShape('https://pinned.internal.test/ns/record-shape.ttl'),
      '★★ the href resolves against where the page LANDED, so a rewritten/redirected shape '
      + 'IRI still reaches its Turtle',
      JSON.stringify(body).slice(0, 90));
    ok(asked2.asked[1] === 'https://pinned.internal.test/ns/record-shape.ttl',
      '★ …and the relative href is resolved against the landed URL, not concatenated onto the '
      + 'IRI asked for',
      JSON.stringify(asked2.asked));
  }

  {
    // A page advertising a Turtle that 404s is the state `docs/` was in before the `.ttl`
    // shipped, one level down. It must refuse rather than fall back to the HTML.
    const { fetchRepresentation } = webOf({
      [SHAPE]: { body: pageAdvertising('record-shape.ttl') },
    });
    const { deps } = depsFor(fetchRepresentation);
    ok(await fetchShapeBodyWith(SHAPE, deps) === null,
      'a page whose advertised Turtle 404s refuses — the HTML is never used as a shape');
  }

  {
    // A blank 200 at the advertised URL is not a shapes graph. Left un-checked, the follower
    // returns it happily (it is not HTML) and the gate would cache an empty contract.
    const { fetchRepresentation } = webOf({
      [SHAPE]: { body: pageAdvertising('record-shape.ttl') },
      'https://shapes.test/ns/record-shape.ttl': { body: '   \n\n  ' },
    });
    const { deps, cache } = depsFor(fetchRepresentation);
    ok(await fetchShapeBodyWith(SHAPE, deps) === null,
      'a BLANK body at the advertised URL refuses rather than caching an empty contract');
    ok(cache.get(SHAPE) === undefined, '…and is not cached');
  }

  {
    // ★ The identity case. A shape IRI that already answers Turtle must not be hopped at all
    // — one fetch, no follower involvement.
    const { fetchRepresentation, asked } = webOf({
      [SHAPE]: { body: strictShape(SHAPE) },
    });
    const { deps } = depsFor(fetchRepresentation);
    ok(await fetchShapeBodyWith(SHAPE, deps) === strictShape(SHAPE)
      && asked.length === 1,
      '★ a shape IRI that already serves Turtle is fetched ONCE and returned untouched',
      JSON.stringify(asked));
  }

  // eslint-disable-next-line no-console
  console.log('\nlast-known-good, which the hop is braided into');

  /** A cache primed with a verified body whose freshness has expired. */
  const primed = (knownGoodUntil: number): Map<string, ShapeBodyCacheEntry> => new Map([
    [SHAPE, { body: strictShape('cached'), expiresAt: Date.now() - 1, knownGoodUntil }],
  ]);

  {
    // ★ A TRANSIENT failure validates against the last body we verified rather than refusing
    // the publish. Without it one 503 on a shape host 422s every publish to the pod for as
    // long as the blip lasts — and the entry must NOT be deleted on the way in, or this
    // branch is dead code and fail-closed ships with no mitigation at all.
    const { fetchRepresentation } = webOf({
      [SHAPE]: { status: 503, statusText: 'Service Unavailable', body: 'upstream down' },
    });
    const cache = primed(Date.now() + 60_000);
    const { deps, logs } = depsFor(fetchRepresentation, cache);
    const body = await fetchShapeBodyWith(SHAPE, deps);
    ok(body === strictShape('cached'),
      '★ a 503 falls back to the last body the gate VERIFIED, not to nothing',
      JSON.stringify(body).slice(0, 90));
    ok(logs.some(l => /last-known-good/.test(l)),
      '★ …and says so, because validating against a stale contract must never be silent');
  }

  {
    // ★★ THE FALLBACK HAS TO SURVIVE THE CALL THAT USES IT, AND A ONE-CALL TEST CANNOT SEE
    // THAT. `cached` is read into a local before the fetch, so a mutant that evicts the stale
    // entry on the way in still falls back ONCE — and then the entry is gone and every
    // subsequent publish during the same outage is refused. That mutant survived the first
    // version of this suite, which is exactly the shape of the bug the comment in
    // `shape-body.ts` records ("deleting here made that fallback dead code"): an outage is not
    // one request. So this drives THREE calls through one cache, ageing the entry between
    // them the way the clock would.
    const web: Record<string, Doc> = {
      [SHAPE]: { body: strictShape(SHAPE) },
    };
    const { asked, fetchRepresentation } = webOf(web);
    const cache = new Map<string, ShapeBodyCacheEntry>();
    const { deps } = depsFor(fetchRepresentation, cache);

    const first = await fetchShapeBodyWith(SHAPE, deps);
    ok(first === strictShape(SHAPE) && cache.get(SHAPE)!.knownGoodUntil > Date.now(),
      '★ a live fetch is what PRIMES last-known-good — nothing else writes that entry');

    // The shape host goes down, and time passes so the cached body is no longer fresh.
    web[SHAPE] = { status: 503, statusText: 'Service Unavailable', body: 'upstream down' };
    const age = (): void => {
      const e = cache.get(SHAPE);
      if (e) cache.set(SHAPE, { ...e, expiresAt: Date.now() - 1 });
    };

    age();
    const second = await fetchShapeBodyWith(SHAPE, deps);
    age();
    const third = await fetchShapeBodyWith(SHAPE, deps);

    ok(second === strictShape(SHAPE) && third === strictShape(SHAPE),
      '★★ EVERY publish during the outage falls back, not just the first',
      `second=${JSON.stringify(second)?.slice(0, 40)} third=${JSON.stringify(third)?.slice(0, 40)}`);
    ok(cache.get(SHAPE)?.body === strictShape(SHAPE),
      '★ …because the stale entry is left in place rather than evicted on the way in');
    ok(asked.length === 3,
      '★ …and each of the three calls still RETRIED the network, so the fallback is a '
      + 'degradation and not a way to stop asking',
      JSON.stringify(asked));
  }

  {
    // ★ AND THE OTHER HALF, WHICH IS THE SECURITY HALF. A 404/403/410 is the shape owner
    // DELETING or tightening the shape. Honouring a cached permissive copy for 24h after
    // that would keep a withdrawn contract enforcing nothing, so a permanent failure refuses
    // AND evicts.
    const { fetchRepresentation } = webOf({});   // → 404
    const cache = primed(Date.now() + 60_000);
    const { deps } = depsFor(fetchRepresentation, cache);
    ok(await fetchShapeBodyWith(SHAPE, deps) === null,
      '★ a 404 does NOT fall back — a deleted shape stops constraining, it does not linger');
    ok(cache.get(SHAPE) === undefined,
      '★ …and the stale entry is EVICTED, so a later publish cannot pick it up either');
  }

  {
    // ★ THE HOP'S OWN FAILURE IS PERMANENT, AND THAT IS DELIBERATE. The page answered 200
    // and then said its Turtle is somewhere unreachable — the shape being withdrawn, not a
    // network blip. Classifying it transient would keep a stale body alive for 24h behind a
    // hop whoever controls the page can break at will.
    const { fetchRepresentation } = webOf({
      [SHAPE]: { body: pageAdvertising('https://evil.test/loose.ttl') },
    });
    const cache = primed(Date.now() + 60_000);
    const { deps } = depsFor(fetchRepresentation, cache);
    ok(await fetchShapeBodyWith(SHAPE, deps) === null,
      '★ a 200 page with a refused alternate does NOT reach last-known-good');
    ok(cache.get(SHAPE) === undefined,
      '★ …and evicts, because the live page is the shape owner speaking');
  }

  {
    // ★ Known-good is stamped only on a body that PARSES. An HTML error page cached as
    // known-good would pin a shape that constrains nothing for 24 hours, which is how a
    // permissive contract outlives the outage that produced it.
    const { fetchRepresentation } = webOf({
      // Not HTML (so no hop) and not a shapes graph either — the parser refuses it.
      [SHAPE]: { body: '{"error":"this is JSON, not Turtle"}' },
    });
    const cache = new Map<string, ShapeBodyCacheEntry>();
    const { deps } = depsFor(fetchRepresentation, cache);
    await fetchShapeBodyWith(SHAPE, deps);
    ok(cache.get(SHAPE)?.knownGoodUntil === 0,
      '★ a body that does not parse as a shapes graph is cached but NEVER known-good',
      JSON.stringify(cache.get(SHAPE)?.knownGoodUntil));
  }

  {
    // A body still inside its freshness window is served without a fetch — the reason the
    // gate does not re-GET every shape on every publish.
    const { fetchRepresentation, asked } = webOf({});
    const cache = new Map<string, ShapeBodyCacheEntry>([
      [SHAPE, { body: strictShape('cached'), expiresAt: Date.now() + 60_000, knownGoodUntil: 0 }],
    ]);
    const { deps } = depsFor(fetchRepresentation, cache);
    ok(await fetchShapeBodyWith(SHAPE, deps) === strictShape('cached') && asked.length === 0,
      'a FRESH cache entry is served with no fetch at all', JSON.stringify(asked));
  }

  // eslint-disable-next-line no-console
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
