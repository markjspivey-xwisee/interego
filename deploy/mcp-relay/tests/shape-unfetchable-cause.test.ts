#!/usr/bin/env tsx
/**
 * The publish gate says WHICH failure refused the publish, not merely that one did.
 *
 * ── ★ THE DEFECT THIS SUITE PINS ─────────────────────────────────────────────
 *
 * The relay knows the difference between "I could not fetch the declared shape" and
 * "I REFUSED to fetch it because its host resolves into private space", and threw that
 * difference away at the boundary. `fetchShapeBodyWith` returns `string | null`, so
 * everything it learned died there, and `runConformanceGate` built one violation with one
 * constraint component and one sentence for every cause.
 *
 * Measured on the live relay before this change: `conforms_to_shapes:
 * ["https://10-0-0-5.nip.io/s.ttl"]` and a declared shape that plainly 404s produced
 * BYTE-IDENTICAL 422 envelopes. The discriminating fact —
 * `ERR_EGRESS_PRIVATE_ADDRESS: egress blocked: 10-0-0-5.nip.io resolves to a
 * private/loopback IPv4 address: 10.0.0.5` — existed, and survived only in a WARN log the
 * caller cannot read.
 *
 * ── ★★ WHY ASSERTING "A 422 CAME BACK" WOULD PROVE NOTHING ───────────────────
 *
 * A 422 arrives for BOTH causes, before and after. A check that passes for two different
 * reasons is evidence for neither — the same trap that made a live verifier report "an
 * entry with no wsp:seq is refused (got 422)" as a PASS while the real cause was that no
 * shape had been fetched at all. So every assertion below reads the CONSTRAINT COMPONENT,
 * and the load-bearing one asserts the two values DIFFER.
 *
 * ── WHY A UNIT SUITE ─────────────────────────────────────────────────────────
 *
 * `server.ts` opens a listener on import, so nothing decided there can be executed by a
 * test — which is why the constraint choice lives in `shape-body.ts`. And a live run
 * exercises the honest path only: production never points the gate at private space, so
 * production cannot tell a relay that distinguishes the two causes from one that does not.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/shape-unfetchable-cause.test.ts
 *
 * Exits non-zero on any failing assertion.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fetchShapeBodyWith,
  isEgressRefusal,
  shapeUnfetchableViolation,
  PUBLIC_SHAPE_NS,
  type FetchedShapeRepresentation,
  type ShapeBodyCacheEntry,
  type ShapeBodyDeps,
  type ShapeFetchFailure,
} from '../shape-body.js';
import {
  ERR_EGRESS_PRIVATE_ADDRESS,
  ERR_EGRESS_TARGET_REFUSED,
} from '../url-rewrite.js';

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

// ── The failures, spelled exactly as the two screen halves raise them ─────────

/**
 * What the CONNECT-TIME resolver produces. undici refuses inside `fetch`, and WHATWG
 * `fetch` flattens that to the message `fetch failed` with the real error on `cause` — so a
 * double that threw a plain `Error('egress blocked')` would be testing a fiction, and would
 * pass against an implementation that matched on the message. Matched off `code` here for
 * the same reason the implementation does.
 */
function resolvedIntoPrivateSpace(): Error {
  const cause = Object.assign(
    new Error('egress blocked: 10-0-0-5.nip.io resolves to a private/loopback IPv4 address: 10.0.0.5'),
    { code: ERR_EGRESS_PRIVATE_ADDRESS },
  );
  return Object.assign(new TypeError('fetch failed'), { cause });
}

/** What the SYNTACTIC screen produces: thrown directly, so the code is on the error itself. */
function refusedOnSight(host: string): Error {
  return Object.assign(
    new Error(`invoke: internal-labeled host not allowed: ${host}`),
    { code: ERR_EGRESS_TARGET_REFUSED },
  );
}

/**
 * Exhausting Happy Eyeballs' candidate list: the codes live on the AggregateError's
 * MEMBERS, one level below `cause`. A multi-homed name whose refusal is only visible there
 * must not read as a plain network fault.
 */
function refusedAcrossEveryCandidate(): Error {
  const members = [
    Object.assign(new Error('egress blocked: … 10.0.0.5'), { code: ERR_EGRESS_PRIVATE_ADDRESS }),
    Object.assign(new Error('egress blocked: … fd00::1'), { code: ERR_EGRESS_PRIVATE_ADDRESS }),
  ];
  const cause = Object.assign(new AggregateError(members, 'all attempts failed'), {
    code: undefined as string | undefined,
    errors: members,
  });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

/** A genuine network fault. Byte-identical at `err.message`; different at `cause.code`. */
function dnsMiss(): Error {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND shapes.example'), {
    code: 'ENOTFOUND',
  });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

// ── Harness ──────────────────────────────────────────────────────────────────

const SHAPE = 'https://10-0-0-5.nip.io/s.ttl';
const PLAIN_404_SHAPE = 'https://shapes.example/missing.ttl';
const GOOD_SHAPE = '@prefix sh: <http://www.w3.org/ns/shacl#> .\n<#S> a sh:NodeShape .\n';

interface Harness {
  readonly deps: ShapeBodyDeps;
  /** Every failure the fetch layer reported, in order. Empty means it reported none. */
  readonly recorded: ShapeFetchFailure[];
  readonly logs: string[];
}

function harness(
  fetchRepresentation: (url: string) => Promise<FetchedShapeRepresentation>,
  cache = new Map<string, ShapeBodyCacheEntry>(),
): Harness {
  const recorded: ShapeFetchFailure[] = [];
  const logs: string[] = [];
  return {
    recorded,
    logs,
    deps: {
      fetchRepresentation,
      parsesAsShapesGraph: (body: string) => /\bsh:NodeShape\b/.test(body),
      log: (m: string) => { logs.push(m); },
      cache,
      cacheMax: 256,
      freshTtlMs: 60_000,
      knownGoodTtlMs: 24 * 60 * 60 * 1000,
      recordFailure: f => { recorded.push(f); },
    },
  };
}

const throwing = (err: Error) => async (): Promise<FetchedShapeRepresentation> => { throw err; };

const statusOf = (status: number, statusText: string) =>
  async (url: string): Promise<FetchedShapeRepresentation> => ({
    ok: false, status, statusText, url, contentType: null, body: '',
  });

/** The end-to-end answer: fetch the shape, then build the violation the caller receives. */
async function constraintFor(
  shapeIri: string,
  fetchRepresentation: (url: string) => Promise<FetchedShapeRepresentation>,
): Promise<{ constraint: string; message: string; recorded: ShapeFetchFailure[]; logs: string[] }> {
  const h = harness(fetchRepresentation);
  const body = await fetchShapeBodyWith(shapeIri, h.deps);
  const v = shapeUnfetchableViolation(shapeIri, h.recorded[0] ?? null);
  return {
    constraint: body === null ? v.constraintComponent : '(a body was returned — no violation)',
    message: v.message,
    recorded: h.recorded,
    logs: h.logs,
  };
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('\nThe gate distinguishes "could not fetch" from "refused to fetch"\n');

  // ── ★ THE LOAD-BEARING PAIR ────────────────────────────────────────────────
  const refused = await constraintFor(SHAPE, throwing(resolvedIntoPrivateSpace()));
  const missing = await constraintFor(PLAIN_404_SHAPE, statusOf(404, 'Not Found'));

  ok(refused.constraint === `${PUBLIC_SHAPE_NS}shapeUnfetchableEgressRefused`,
    'a target that resolves into private space gets its OWN constraint component',
    refused.constraint);
  ok(missing.constraint === `${PUBLIC_SHAPE_NS}shapeUnfetchable`,
    'a plain 404 still gets the generic unfetchable component', missing.constraint);
  // The assertion the whole change exists for. Not "both are 422" — both were always 422.
  ok(refused.constraint !== missing.constraint,
    '★ the two causes are DISTINGUISHABLE by constraint component',
    `${refused.constraint} vs ${missing.constraint}`);

  // ── The reason reaches the caller's frame at all ───────────────────────────
  ok(refused.recorded.length === 1 && refused.recorded[0]!.egressRefused === true,
    'the fetch layer reports the refusal to its caller', JSON.stringify(refused.recorded));
  ok(missing.recorded.length === 1 && missing.recorded[0]!.egressRefused === false,
    'a sent-and-failed request is NOT reported as a refusal', JSON.stringify(missing.recorded));
  ok(missing.recorded[0]?.reason.includes('404') === true,
    'the operator-facing reason still carries the status it always did',
    JSON.stringify(missing.recorded[0]));

  // ── ★ WHAT AN ANONYMOUS CALLER LEARNS ──────────────────────────────────────
  //
  // The resolved address is DNS-derived from a host the caller named, and for a name that
  // encodes it (nip.io) echoing it back discloses nothing. But the same code path serves
  // `something.railway.internal` and a rebinding probe against a name whose records the
  // caller does not control, where the resolved address IS the internal-topology fact they
  // came for. One heuristic wrong once is a disclosure with no way back, so nothing
  // resolved is echoed — the constraint carries the discrimination instead.
  ok(!refused.message.includes('10.0.0.5'),
    'the public message does not echo the RESOLVED address', refused.message);
  ok(refused.message.includes(SHAPE),
    "the public message does name the caller's own input", refused.message);
  ok(refused.recorded[0]!.reason.includes('10.0.0.5'),
    'and the address is NOT lost — it is in the operator reason',
    refused.recorded[0]!.reason);
  ok(refused.logs.some(l => l.includes('10.0.0.5') && l.startsWith('WARN')),
    'the WARN line an operator reads still carries the whole cause',
    JSON.stringify(refused.logs));
  const internal = await constraintFor(
    'https://shapes.example/s.ttl',
    throwing(refusedOnSight('interego-css.railway.internal')),
  );
  ok(!internal.message.includes('railway.internal'),
    'an internal hostname from the refusal never reaches the public envelope',
    internal.message);

  // ── Both halves of the screen count as a refusal ───────────────────────────
  ok(internal.constraint === `${PUBLIC_SHAPE_NS}shapeUnfetchableEgressRefused`,
    'the SYNTACTIC screen (code on the error itself) is a refusal too', internal.constraint);
  const multiHomed = await constraintFor(SHAPE, throwing(refusedAcrossEveryCandidate()));
  ok(multiHomed.constraint === `${PUBLIC_SHAPE_NS}shapeUnfetchableEgressRefused`,
    'a refusal visible only in AggregateError members is still a refusal',
    multiHomed.constraint);

  // ── And a real fault is NOT one ────────────────────────────────────────────
  //
  // The measured hazard: at `err.message` a DNS miss and a screen refusal are both the
  // string `fetch failed`. If classification ever slid onto the message, this goes red.
  const dns = await constraintFor('https://shapes.example/s.ttl', throwing(dnsMiss()));
  ok(dns.constraint === `${PUBLIC_SHAPE_NS}shapeUnfetchable`,
    'a DNS failure is reported as an outage, not as a refusal', dns.constraint);
  ok(isEgressRefusal(dnsMiss()) === false && isEgressRefusal(new Error('fetch failed')) === false,
    'nothing without an egress code classifies as a refusal');
  ok(isEgressRefusal(resolvedIntoPrivateSpace()) && isEgressRefusal(refusedOnSight('x.internal')),
    'both egress codes classify as a refusal');

  // ── The scheme split is unchanged ──────────────────────────────────────────
  //
  // A non-https IRI was never fetched, so no screen and no network was consulted — the
  // configuration error is the more actionable fact and still wins.
  const httpScheme = shapeUnfetchableViolation(
    'http://10-0-0-5.nip.io/s.ttl',
    { reason: 'egress blocked', egressRefused: true },
  );
  ok(httpScheme.constraintComponent === `${PUBLIC_SHAPE_NS}shapeUnfetchableScheme`,
    'a non-https IRI still reports the scheme error, even when the screen also refused',
    httpScheme.constraintComponent);
  ok(shapeUnfetchableViolation(PLAIN_404_SHAPE, null).constraintComponent
      === `${PUBLIC_SHAPE_NS}shapeUnfetchable`,
    'no recorded failure falls back to the generic component');

  // ── ★ NO SHARED SLOT: CONCURRENT PUBLISHES CANNOT SWAP REASONS ─────────────
  //
  // The reflex plumbing for "the reason cannot escape a `string | null`" is a module-level
  // map keyed by shape IRI. Two publishes in flight then race, and the loser attaches the
  // winner's reason to its own 422 — a WRONG attribution, which for a security refusal is
  // worse than the missing one it replaces. Interleaved on purpose: the refusing fetch
  // resolves LAST, so a shared slot would hand its reason to the 404's violation.
  {
    let releaseRefusal: (() => void) | null = null;
    const gate = new Promise<void>(r => { releaseRefusal = r; });
    const slowRefusal = async (): Promise<FetchedShapeRepresentation> => {
      await gate;
      throw resolvedIntoPrivateSpace();
    };
    const a = constraintFor(SHAPE, slowRefusal);
    const b = constraintFor(PLAIN_404_SHAPE, statusOf(404, 'Not Found'));
    const bResult = await b;
    releaseRefusal!();
    const aResult = await a;
    ok(aResult.constraint === `${PUBLIC_SHAPE_NS}shapeUnfetchableEgressRefused`
        && bResult.constraint === `${PUBLIC_SHAPE_NS}shapeUnfetchable`,
      '★ two concurrent publishes each keep their OWN cause',
      `${aResult.constraint} vs ${bResult.constraint}`);
  }

  // ── Nothing is reported when nothing is refused ────────────────────────────
  {
    const h = harness(async (url: string) => ({
      ok: true, status: 200, statusText: 'OK', url, contentType: 'text/turtle', body: GOOD_SHAPE,
    }));
    const body = await fetchShapeBodyWith(PLAIN_404_SHAPE, h.deps);
    ok(body === GOOD_SHAPE && h.recorded.length === 0,
      'a successful fetch reports no failure at all', JSON.stringify(h.recorded));
  }
  {
    // The last-known-good fallback SUCCEEDS — the publish is validated, not refused — so
    // reporting a failure here would be the same lie pointing the other way.
    const cache = new Map<string, ShapeBodyCacheEntry>([
      [PLAIN_404_SHAPE, {
        body: GOOD_SHAPE,
        expiresAt: Date.now() - 1,
        knownGoodUntil: Date.now() + 60_000,
      }],
    ]);
    const h = harness(throwing(dnsMiss()), cache);
    const body = await fetchShapeBodyWith(PLAIN_404_SHAPE, h.deps);
    ok(body === GOOD_SHAPE && h.recorded.length === 0,
      'a transient failure that falls back to last-known-good reports no refusal',
      JSON.stringify(h.recorded));
  }
  {
    // `recordFailure` is optional so every pre-existing deps literal still compiles. A
    // caller that omits it must get exactly the old behaviour, not a crash on the
    // refusal path — which is the path least likely to be exercised before it matters.
    const cache = new Map<string, ShapeBodyCacheEntry>();
    const deps: ShapeBodyDeps = {
      fetchRepresentation: throwing(dnsMiss()),
      parsesAsShapesGraph: () => true,
      log: () => {},
      cache,
      cacheMax: 256,
      freshTtlMs: 60_000,
      knownGoodTtlMs: 1000,
    };
    ok(await fetchShapeBodyWith(PLAIN_404_SHAPE, deps) === null,
      'deps without recordFailure still refuse cleanly');
  }

  // ── Every emitted term is DECLARED where the IRI dereferences ──────────────
  //
  // The two pre-existing components were emitted for months and declared nowhere: the
  // namespace constant used to carry half the local name, so `tools/ontology-lint.mjs` saw
  // a term the relay never emits. Asserted here as well as in the lint because this suite
  // is what runs in the relay's own CI.
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const ttl = readFileSync(join(here, '..', '..', '..', 'docs', 'ns', 'iep.ttl'), 'utf8');
    for (const term of ['shapeUnfetchable', 'shapeUnfetchableScheme', 'shapeUnfetchableEgressRefused']) {
      ok(new RegExp(`(^|\\n)iep:${term}\\s+a\\s`).test(ttl),
        `iep:${term} is declared in docs/ns/iep.ttl, so the emitted IRI dereferences`);
    }
    ok(PUBLIC_SHAPE_NS === 'https://markjspivey-xwisee.github.io/interego/ns/iep#',
      'the namespace constant ends at the # so the local name is literal in the source',
      PUBLIC_SHAPE_NS);
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
