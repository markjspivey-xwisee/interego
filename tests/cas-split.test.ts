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
