/**
 * cas-split — Phase A precondition + Phase B fire-and-forget split.
 *
 * Covers the CAS-split documented in
 *   packages/solid/src/client.ts :: checkSupersessionPrecondition
 *   deploy/mcp-relay/server.ts   :: handlePublishContext (Phase A branch)
 *
 * The substrate `publish()` used to run the CAS precondition GET +
 * the graph PUT + descriptor PUT + manifest CAS as one awaited chain.
 * On the if_match path that meant ~7-10 s of synchronous CSS round-trips
 * on the request thread. The split lifts the precondition GET out into
 * a standalone helper (`checkSupersessionPrecondition`) the relay runs
 * on the request thread (Phase A); on pass, the rest of the publish
 * chain runs in the background under the per-pod mutex (Phase B). On
 * fail, the 412 envelope still surfaces synchronously — same wire shape
 * as the old in-publish path.
 *
 * What this test pins:
 *
 *   1. Phase A (stale if_match) — checkSupersessionPrecondition throws
 *      PublishPreconditionFailedError carrying the currentHead +
 *      supersedesList; no pod writes happen.
 *   2. Phase A (matching if_match) + simulated Phase B success —
 *      checkSupersessionPrecondition resolves to { ok: true, ... } with
 *      the resolved head URL + CID; a subsequent publish() against the
 *      same fetch writes the graph + descriptor + manifest. The CAS
 *      witness (preconditionWitness) records which match option
 *      succeeded.
 *   3. Phase A pass + Phase B failure (mock CSS errors on the graph PUT)
 *      — Phase A still resolves, but the subsequent publish() rejects
 *      with the substrate's "Failed to write graph" error. This is the
 *      shape the relay's background task catches and converts into a
 *      `kind:'failed'` /publish/status entry.
 *   4. Backward compatibility — the helper preserves the existing
 *      in-publish behavior: when both ifMatchSupersedes + ifMatchCid
 *      point at different observed heads, it throws the same
 *      multi-target mismatch error the original block raised.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ContextDescriptor,
  computeCid,
  type IRI,
} from '@interego/core';
import { publish, checkSupersessionPrecondition } from '@interego/solid';

// ── Fixtures ────────────────────────────────────────────────

const POD = 'https://alice.pod/';
const PRIOR_HEAD_URL = 'https://alice.pod/context-graphs/v1.ttl';

const PRIOR_HEAD_TURTLE = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#>.
<urn:iep:v1> a iep:ContextDescriptor ;
    iep:describes <urn:graph:cas-split> .
`;
const EXPECTED_HEAD_CID = computeCid(PRIOR_HEAD_TURTLE);

function descV2WithSupersedes(): ReturnType<ReturnType<typeof ContextDescriptor.create>['build']> {
  return ContextDescriptor.create('urn:iep:cas-split:v2' as IRI)
    .describes('urn:graph:cas-split' as IRI)
    .temporal({ validFrom: '2026-06-07T00:00:00Z' })
    .selfAsserted('did:web:alice.example' as IRI)
    .supersedes(PRIOR_HEAD_URL as IRI)
    .build();
}

/**
 * makeRecordingFetch — synthetic CSS that responds to:
 *   - GET PRIOR_HEAD_URL          → 200 PRIOR_HEAD_TURTLE
 *   - GET ...well-known/context-graphs → 404 (cold start)
 *   - PUT *                       → 201 (or 5xx if `failOnPutSubstring` matches)
 * Records every non-GET so the test can assert ordering / count.
 */
function makeRecordingFetch(opts: {
  priorHeadTurtle?: string;
  failOnPutSubstring?: string;
} = {}) {
  const writes: { url: string; method: string }[] = [];
  const reads: { url: string }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const method = init?.method ?? 'GET';
    if (method === 'GET') reads.push({ url: urlStr });
    else writes.push({ url: urlStr, method });

    if (method === 'GET' && urlStr === PRIOR_HEAD_URL) {
      const body = opts.priorHeadTurtle ?? PRIOR_HEAD_TURTLE;
      return {
        ok: true, status: 200, statusText: 'OK',
        text: async () => body,
        json: async () => JSON.parse(body),
        headers: new Headers({ 'content-type': 'text/turtle' }),
      } as unknown as Response;
    }
    if (method === 'GET' && urlStr.includes('.well-known/context-graphs')) {
      return {
        ok: false, status: 404, statusText: 'Not Found',
        text: async () => '', json: async () => ({}),
        headers: new Headers(),
      } as unknown as Response;
    }
    if ((method === 'PUT' || method === 'PATCH') && opts.failOnPutSubstring && urlStr.includes(opts.failOnPutSubstring)) {
      return {
        ok: false, status: 500, statusText: 'Internal Server Error',
        text: async () => '', json: async () => ({}),
        headers: new Headers(),
      } as unknown as Response;
    }
    return {
      ok: true, status: 201, statusText: 'Created',
      text: async () => '', json: async () => ({}),
      headers: new Headers(),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, writes, reads };
}

// ═════════════════════════════════════════════════════════════
//  checkSupersessionPrecondition — Phase A behavior
// ═════════════════════════════════════════════════════════════

describe('checkSupersessionPrecondition — Phase A standalone CAS gate', () => {
  it('Phase A fail (stale if_match) → 412 envelope, no Phase B writes', async () => {
    const { fetch, writes } = makeRecordingFetch();
    const staleCid = 'bafkreiSTALECIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

    let captured: unknown = null;
    try {
      await checkSupersessionPrecondition({
        supersedesList: [PRIOR_HEAD_URL],
        ifMatchCid: staleCid,
        fetchFn: fetch as unknown as typeof globalThis.fetch,
      });
    } catch (err) {
      captured = err;
    }

    expect(captured).not.toBeNull();
    expect((captured as Error).name).toBe('PublishPreconditionFailedError');
    expect((captured as { code: number }).code).toBe(412);
    const actual = (captured as {
      actual: { descriptorUrl: string | null; cid: string | null; supersedesList: readonly string[] };
    }).actual;
    expect(actual.descriptorUrl).toBe(PRIOR_HEAD_URL);
    expect(actual.cid).toBe(EXPECTED_HEAD_CID);
    expect(actual.supersedesList).toEqual([PRIOR_HEAD_URL]);
    // Phase A is read-only — no pod writes happen, regardless of outcome.
    expect(writes.length).toBe(0);
  });

  it('Phase A pass (matching ifMatchCid) → returns { ok: true } with resolvedHeadUrl + resolvedHeadCid + witness', async () => {
    const { fetch, writes } = makeRecordingFetch();

    const pass = await checkSupersessionPrecondition({
      supersedesList: [PRIOR_HEAD_URL],
      ifMatchCid: EXPECTED_HEAD_CID,
      fetchFn: fetch as unknown as typeof globalThis.fetch,
    });

    expect(pass.ok).toBe(true);
    expect(pass.resolvedHeadUrl).toBe(PRIOR_HEAD_URL);
    expect(pass.resolvedHeadCid).toBe(EXPECTED_HEAD_CID);
    expect(pass.preconditionWitness).toEqual({ matched: PRIOR_HEAD_URL, via: 'cid' });
    expect(pass.currentHead).toEqual({
      descriptorUrl: PRIOR_HEAD_URL,
      cid: EXPECTED_HEAD_CID,
      supersedesList: [PRIOR_HEAD_URL],
    });
    // Still read-only on the pass branch.
    expect(writes.length).toBe(0);
  });

  it('Phase A pass (matching ifMatchSupersedes URL) → witness records via:"supersedes"', async () => {
    const { fetch } = makeRecordingFetch();

    const pass = await checkSupersessionPrecondition({
      supersedesList: [PRIOR_HEAD_URL],
      ifMatchSupersedes: PRIOR_HEAD_URL,
      fetchFn: fetch as unknown as typeof globalThis.fetch,
    });
    expect(pass.ok).toBe(true);
    expect(pass.preconditionWitness).toEqual({ matched: PRIOR_HEAD_URL, via: 'supersedes' });
    expect(pass.resolvedHeadCid).toBe(EXPECTED_HEAD_CID);
  });

  it('Phase A fail (descriptor.supersedes empty) → 412 with empty supersedesList', async () => {
    const { fetch, writes } = makeRecordingFetch();

    let captured: unknown = null;
    try {
      await checkSupersessionPrecondition({
        supersedesList: [],
        ifMatchCid: EXPECTED_HEAD_CID,
        fetchFn: fetch as unknown as typeof globalThis.fetch,
      });
    } catch (err) {
      captured = err;
    }
    expect((captured as Error).name).toBe('PublishPreconditionFailedError');
    expect((captured as { code: number }).code).toBe(412);
    const actual = (captured as {
      actual: { descriptorUrl: string | null; cid: string | null; supersedesList: readonly string[] };
    }).actual;
    expect(actual.descriptorUrl).toBeNull();
    expect(actual.supersedesList).toEqual([]);
    expect(writes.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════
//  The precondition must compare against the HEAD, not the chain
// ═════════════════════════════════════════════════════════════
//
// ★ Every test above uses a one-element supersedes list, so none of them could
// distinguish "the assertion names the head" from "the assertion names anything in the
// chain". The difference is the whole of compare-and-swap, and it went unnoticed until a
// live probe produced this against production:
//
//     chain v0 → v1;  publish v2 with if_match = v0
//     → { published: true, precondition: { passed: true } }
//
// Under `auto_supersede_prior` the descriptor supersedes EVERY prior version, so a stale
// ancestor satisfied a membership test forever. Two writers who both read v1 both landed,
// and the second overwrote a state it never read — while the response affirmed the swap
// was atomic. `currentHeads` is what makes the comparison a swap.

describe('★ if_match must name a live head, not merely an ancestor', () => {
  const V0 = 'https://alice.pod/context-graphs/v0.ttl';
  const V1 = PRIOR_HEAD_URL;

  /** As auto_supersede_prior writes it: v2 links v1 AND v0. */
  const ALL_PRIORS = [V1, V0];

  const V0_TURTLE = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#>.
<urn:iep:v0> a iep:ContextDescriptor ; iep:describes <urn:graph:cas-split> .
`;
  const V0_CID = computeCid(V0_TURTLE);

  const lookup = (url: string) =>
    url === V1 ? EXPECTED_HEAD_CID : url === V0 ? V0_CID : null;

  const check = (args: Record<string, unknown>) =>
    checkSupersessionPrecondition({
      supersedesList: ALL_PRIORS,
      fetchFn: makeRecordingFetch().fetch as unknown as typeof globalThis.fetch,
      headCidLookup: lookup,
      currentHeads: [V1],
      ...args,
    });

  it('★ asserting a SUPERSEDED ancestor by URL is refused, though it is in the chain', async () => {
    await expect(check({ ifMatchSupersedes: V0 })).rejects.toMatchObject({
      name: 'PublishPreconditionFailedError',
      code: 412,
    });
  });

  it('★ asserting a superseded ancestor by CID is refused too', async () => {
    // The CID form is the one the docs steer callers to (`previousHeadCid`), so a hole
    // here would be the one people actually fall into.
    await expect(check({ ifMatchCid: V0_CID })).rejects.toMatchObject({ code: 412 });
  });

  it('the refusal says WHICH descriptor is current, so the caller can retry', async () => {
    // A 412 that does not name the head forces a second round-trip to find out, and an
    // agent that cannot cheaply recover will be written to drop the precondition instead.
    // ★ The `.catch(...)` form left `err` typed as pass-OR-error, and the three assertions
    // below all reach for error-only fields. If the guard ever STOPS refusing, `check`
    // resolves, `err` is the pass object, and the failure surfaces as a TypeError reading
    // `.supersedesList` of undefined — a stack trace about the test instead of "the
    // precondition accepted a superseded ancestor". Rejecting explicitly on the success
    // path names the actual regression and narrows the type at the same time.
    const err = await check({ ifMatchSupersedes: V0 }).then(
      pass => { throw new Error(`expected a 412 refusal, but the precondition PASSED: ${JSON.stringify(pass)}`); },
      (e: unknown) => e as Error & { actual: { supersedesList: readonly string[] } },
    );
    expect(err.message).toMatch(/SUPERSEDED ancestor/);
    expect(err.message).toContain(V1);
    expect(err.actual.supersedesList).toEqual([V1]);
  });

  it('asserting the actual head still passes — the fix must not reject valid writes', async () => {
    const pass = await check({ ifMatchSupersedes: V1 });
    expect(pass.ok).toBe(true);
    expect(pass.resolvedHeadUrl).toBe(V1);
  });

  it('a fork reports both heads, and either may be asserted', async () => {
    // Two unresolved heads is a real state (a missed CAS). Refusing both would strand the
    // chain with no way to publish; the honest move is to let a writer supersede either
    // one and let the divergence surface where it can be repaired.
    const forked = (args: Record<string, unknown>) =>
      checkSupersessionPrecondition({
        supersedesList: ALL_PRIORS,
        fetchFn: makeRecordingFetch().fetch as unknown as typeof globalThis.fetch,
        headCidLookup: lookup,
        currentHeads: [V1, V0],
        ...args,
      });
    expect((await forked({ ifMatchSupersedes: V0 })).ok).toBe(true);
    expect((await forked({ ifMatchSupersedes: V1 })).ok).toBe(true);
  });

  it('host-form differences do not turn a live head into a refusal', async () => {
    // The frontier is computed from manifest URLs; the assertion arrives from whatever
    // form the caller was handed. Compared raw, a legitimate publish 412s — and a guard
    // that fires on valid input is a guard someone switches off.
    const INTERNAL = V1.replace('https://alice.pod/', 'http://css.internal:3456/');
    const pass = await checkSupersessionPrecondition({
      supersedesList: ALL_PRIORS,
      fetchFn: makeRecordingFetch().fetch as unknown as typeof globalThis.fetch,
      headCidLookup: lookup,
      ifMatchSupersedes: V1,
      currentHeads: [INTERNAL],
      normalizeUrl: (u: string) => u.replace('https://alice.pod/', 'http://css.internal:3456/'),
    });
    expect(pass.ok).toBe(true);
  });

  it('the if_match assertion itself may be spelled differently from the observed target', async () => {
    /**
     * ★★ THE SIBLING TEST ABOVE DID NOT COVER THIS, AND THE GATE WAS RAW.
     *
     * "host-form differences do not turn a live head into a refusal" passes `ifMatchSupersedes`
     * in the SAME spelling the observed list holds, so it exercises only the `currentHeads`
     * frontier comparison — which normalised. The membership gate one field earlier compared
     * `o.descriptorUrl === ifMatchSupersedes` RAW, so it was never asked a question it could
     * get wrong.
     *
     * Here the caller asserts the head in the INTERNAL spelling while the declared supersedes
     * targets are public-form — exactly what happens when the assertion comes back from a
     * relay response and the list comes from content. Both name one descriptor. Compared raw,
     * the caller is told its head "is not among the declared supersedes targets" while looking
     * at a list that contains it.
     */
    const INTERNAL_V1 = V1.replace('https://alice.pod/', 'http://css.internal:3456/');
    const pass = await checkSupersessionPrecondition({
      supersedesList: ALL_PRIORS,
      fetchFn: makeRecordingFetch().fetch as unknown as typeof globalThis.fetch,
      headCidLookup: lookup,
      ifMatchSupersedes: INTERNAL_V1,
      normalizeUrl: (u: string) => u.replace('https://alice.pod/', 'http://css.internal:3456/'),
    });
    expect(pass.ok).toBe(true);
    // And it resolved to the real target, not merely "did not throw".
    expect(pass.preconditionWitness.via).toBe('supersedes');
    expect(pass.resolvedHeadUrl).toBe(V1);
  });

  it('without currentHeads the old membership test still applies — and is still wrong', async () => {
    // Pinned deliberately. Callers whose supersedes list is content-authored semantic
    // supersession have no frontier to compute, so the option cannot be mandatory at this
    // layer. That makes "the relay always supplies it" a property of the relay, verified
    // where the relay is — not something this unit can assert. Documenting the gap here
    // keeps it from being mistaken for coverage.
    const pass = await checkSupersessionPrecondition({
      supersedesList: ALL_PRIORS,
      fetchFn: makeRecordingFetch().fetch as unknown as typeof globalThis.fetch,
      headCidLookup: lookup,
      ifMatchSupersedes: V0,
    });
    expect(pass.ok).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════
//  Phase A + Phase B integration — simulated relay flow
// ═════════════════════════════════════════════════════════════

describe('CAS split — Phase A pass + simulated Phase B', () => {
  it('Phase A pass + Phase B success → publish() writes graph + descriptor + manifest', async () => {
    const { fetch, writes } = makeRecordingFetch();
    const descriptor = descV2WithSupersedes();

    // Phase A — runs on the relay request thread.
    const pass = await checkSupersessionPrecondition({
      supersedesList: descriptor.supersedes ?? [],
      ifMatchCid: EXPECTED_HEAD_CID,
      fetchFn: fetch as unknown as typeof globalThis.fetch,
    });
    expect(pass.ok).toBe(true);

    // Phase B — runs in the background (here we just await it).
    // publish() re-runs the precondition defensively inside the same
    // per-pod mutex window; the recorded fetch makes that idempotent.
    const result = await publish(descriptor, '', POD, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      ifMatchCid: EXPECTED_HEAD_CID,
    });

    expect(result.descriptorUrl).toBeDefined();
    expect(result.graphUrl).toBeDefined();
    expect(result.manifestUrl).toBeDefined();
    expect(result.previousHeadUrl).toBe(PRIOR_HEAD_URL);
    expect(result.previousHeadCid).toBe(EXPECTED_HEAD_CID);

    // Phase B wrote: graph + descriptor + manifest (+ possibly an ACL or
    // verification GET). At minimum the descriptor + graph + manifest PUTs land.
    const puts = writes.filter(w => w.method === 'PUT');
    expect(puts.length).toBeGreaterThanOrEqual(3);
    // The descriptor PUT carries the same URL Phase B's publish() returned.
    const descriptorPut = puts.find(p => p.url === result.descriptorUrl);
    expect(descriptorPut).toBeDefined();
    const graphPut = puts.find(p => p.url === result.graphUrl);
    expect(graphPut).toBeDefined();
  });

  it('Phase A pass + Phase B failure (CSS errors on graph PUT) → publish() rejects with substrate write error', async () => {
    // Mock CSS that fails every PUT against the graph URL.
    // The substrate's withTransientRetry budget is 6 attempts, so this
    // exercises the same exhaustion path the relay's background task
    // catches into { kind: 'failed', error: message }.
    const { fetch } = makeRecordingFetch({ failOnPutSubstring: '-graph' });
    const descriptor = descV2WithSupersedes();

    // Phase A still passes — the precondition GET is independent of
    // the PUT-failure injection.
    const pass = await checkSupersessionPrecondition({
      supersedesList: descriptor.supersedes ?? [],
      ifMatchCid: EXPECTED_HEAD_CID,
      fetchFn: fetch as unknown as typeof globalThis.fetch,
    });
    expect(pass.ok).toBe(true);

    // Phase B — fails on the graph PUT after the retry budget exhausts.
    let phaseBError: unknown = null;
    try {
      await publish(descriptor, '<urn:s> <urn:p> "v" .', POD, {
        fetch: fetch as unknown as typeof globalThis.fetch,
        ifMatchCid: EXPECTED_HEAD_CID,
      });
    } catch (err) {
      phaseBError = err;
    }
    expect(phaseBError).not.toBeNull();
    // Substrate error string the relay's catch block surfaces verbatim
    // into the /publish/status endpoint as `error: <message>`.
    expect((phaseBError as Error).message).toMatch(/Failed to write graph|graph/i);
    // The error is NOT a PublishPreconditionFailedError — Phase A had
    // already passed. This distinguishes the two failure modes for the
    // /publish/status caller.
    expect((phaseBError as Error).name).not.toBe('PublishPreconditionFailedError');
  }, 30_000);
});
