/**
 * publish-gates — combined sign_authorship + if_match CAS path.
 *
 * Regression coverage for the FIX 1 / FIX 2 pair documented in
 *   packages/solid/src/client.ts :: fetchDescriptorTurtleForCas
 *   deploy/mcp-relay/server.ts   :: handlePublishContext (if_match branch)
 *
 * Failure mode the fix lifts: when sign_authorship:true is paired with
 * if_match:<correct CID> the publish path (a) auto-populates
 * descriptor.supersedes from the relay's priorVersions block, (b) enters
 * the substrate CAS gate at packages/solid/src/client.ts line ~660,
 * (c) GETs the prior head descriptor turtle, (d) recomputes its CID,
 * (e) compares against the asserted if_match value. The original code
 * sent `Cache-Control: no-cache` on that GET — forcing CSS to skip its
 * response cache and re-read Azure Files on every check — and used the
 * default withTransientRetry budget (4 attempts, ~15 s ceiling). The
 * COMBINATION of those two amplified a transient Azure-Files /
 * CSS-cache miss into a `fetch failed (4×)` surface that ONLY appeared
 * on the signed+if_match path (small unsigned writes had no
 * supersedes target; large unsigned writes skipped the CAS gate
 * entirely).
 *
 * The fix drops the no-cache header (CSS already invalidates its cache
 * on PUT, current-or-newer is sufficient for CAS) and raises the GET's
 * retry budget to 6 attempts / 500 ms base — symmetric with the
 * graph + descriptor PUTs at lines ~788 and ~841. The 412 envelope and
 * the authorship-proof block must both still ride on top.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ContextDescriptor,
  createSignedAuthorship,
  verifySignedAuthorship,
  makeWalletDelegationSigner,
  makeWalletDelegationVerifier,
  createWallet,
  computeCid,
} from '@interego/core';
import { publish } from '@interego/solid';

import type {
  AuthorshipProof,
  IRI,
} from '@interego/core';

// ── Fixtures ────────────────────────────────────────────────

const POD = 'https://alice.pod/';
const PRIOR_HEAD_URL = 'https://alice.pod/context-graphs/v1.ttl';
const OWNER_WEBID = 'https://alice.pod/profile#me' as IRI;

/**
 * The canonical Turtle that GETs against PRIOR_HEAD_URL return. Stable
 * bytes → stable CID across runs, so we can pre-compute the expected
 * if_match value at test setup time.
 */
const PRIOR_HEAD_TURTLE = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#>.
<urn:cg:v1> a cg:ContextDescriptor ;
    cg:describes <urn:graph:smoke> .
`;

/**
 * mock fetch that responds to GET PRIOR_HEAD_URL with PRIOR_HEAD_TURTLE,
 * 404s the manifest (cold start), and 201s every PUT. Records every
 * non-GET so the test can assert ordering / count.
 */
function makeRecordingFetch(opts: {
  /** Override the prior-head GET response (e.g. swap turtle bytes mid-test). */
  priorHeadTurtle?: string;
  /** Inject a transient flake on the first N prior-head GETs to exercise the retry budget. */
  flakePriorHeadFirst?: number;
} = {}) {
  const writes: { url: string; method: string }[] = [];
  let flakesLeft = opts.flakePriorHeadFirst ?? 0;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push({ url: urlStr, method });
    if (method === 'GET' && urlStr === PRIOR_HEAD_URL) {
      if (flakesLeft > 0) {
        flakesLeft--;
        // Transient socket reset shape — `withTransientRetry` retries
        // anything that `isTransientNetworkError` recognises, including
        // `fetch failed` from undici.
        throw new TypeError('fetch failed');
      }
      const body = opts.priorHeadTurtle ?? PRIOR_HEAD_TURTLE;
      return {
        ok: true, status: 200, statusText: 'OK',
        text: async () => body,
        json: async () => JSON.parse(body),
        headers: new Headers({ 'content-type': 'text/turtle' }),
      } as unknown as Response;
    }
    // manifest GET → cold start
    if (method === 'GET' && urlStr.includes('.well-known/context-graphs')) {
      return {
        ok: false, status: 404, statusText: 'Not Found',
        text: async () => '', json: async () => ({}),
        headers: new Headers(),
      } as unknown as Response;
    }
    // PUTs all succeed
    return {
      ok: true, status: 201, statusText: 'Created',
      text: async () => '', json: async () => ({}),
      headers: new Headers(),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, writes };
}

function descV2WithSupersedes(): ReturnType<ReturnType<typeof ContextDescriptor.create>['build']> {
  return ContextDescriptor.create('urn:cg:v2' as IRI)
    .describes('urn:graph:smoke' as IRI)
    .temporal({ validFrom: '2026-06-06T00:00:00Z' })
    .selfAsserted('did:web:alice.example' as IRI)
    .supersedes(PRIOR_HEAD_URL as IRI)
    .build();
}

/** Build a real ECDSA-backed authorship proof so the smoke test exercises the
 *  actual sign + verify round-trip — not a stub. */
async function buildAuthorshipProof(descriptorId: IRI, created: string): Promise<{
  proof: AuthorshipProof;
  agentId: IRI;
}> {
  const wallet = await createWallet('agent', 'smoke-agent', 1);
  const agentId = `did:ethr:${wallet.address}` as IRI;
  const signer = makeWalletDelegationSigner(wallet);
  const proof = await createSignedAuthorship(
    { agentId, ownerWebId: OWNER_WEBID, descriptorId, created },
    signer,
  );
  return { proof, agentId };
}

// ═════════════════════════════════════════════════════════════
//  Combined signed-authorship + if_match CAS path
// ═════════════════════════════════════════════════════════════

describe('publish — signed authorship + if_match CAS (combined gate)', () => {
  it('succeeds when if_match matches the prior head CID AND embeds a verifiable authorship-proof block', async () => {
    const { fetch, writes } = makeRecordingFetch();
    const created = '2026-06-06T00:00:00Z';
    const descriptor = descV2WithSupersedes();
    const { proof } = await buildAuthorshipProof(descriptor.id, created);
    const expectedHeadCid = computeCid(PRIOR_HEAD_TURTLE);

    const result = await publish(
      descriptor,
      '',
      POD,
      {
        fetch,
        authorshipProof: proof,
        ifMatchCid: expectedHeadCid,
      },
    );

    // CAS gate matched against the head CID.
    expect(result.previousHeadUrl).toBe(PRIOR_HEAD_URL);
    expect(result.previousHeadCid).toBe(expectedHeadCid);

    // Descriptor PUT must carry the embedded authorship-proof block —
    // proves the authorship block survived the CAS path end-to-end.
    const descriptorPut = writes.find(w => w.method === 'PUT' && w.url.endsWith('urn-cg-v2.ttl') || w.url.endsWith('v2.ttl'));
    expect(descriptorPut).toBeDefined();

    // The authorship proof verifies against the same canonical payload
    // the signer used (round-trip; no pod-storage trust).
    const verifier = makeWalletDelegationVerifier();
    const verified = await verifySignedAuthorship(
      proof,
      async (canonical, p) => verifier(canonical, p as { proofValue: string; signerAddress: string }),
    );
    expect(verified.valid).toBe(true);
  });

  it('returns a 412 PublishPreconditionFailedError when if_match is stale (CID mismatch) — even with sign_authorship in the same call', async () => {
    const { fetch, writes } = makeRecordingFetch();
    const created = '2026-06-06T00:00:01Z';
    const descriptor = descV2WithSupersedes();
    const { proof } = await buildAuthorshipProof(descriptor.id, created);

    // Stale CID — the actual prior head's CID is computeCid(PRIOR_HEAD_TURTLE),
    // which will NOT equal this base32 placeholder.
    const staleCid = 'bafkreiSTALECIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

    let captured: unknown = null;
    try {
      await publish(
        descriptor,
        '',
        POD,
        {
          fetch,
          authorshipProof: proof,
          ifMatchCid: staleCid,
        },
      );
    } catch (err) {
      captured = err;
    }
    expect(captured).not.toBeNull();
    expect((captured as Error).name).toBe('PublishPreconditionFailedError');
    expect((captured as { code: number }).code).toBe(412);
    // 412 envelope must carry currentHead + supersedesList so the relay
    // can format the retryHint response with the freshest head info.
    const actual = (captured as {
      actual: { descriptorUrl: string | null; cid: string | null; supersedesList: readonly string[] };
    }).actual;
    expect(actual.descriptorUrl).toBe(PRIOR_HEAD_URL);
    expect(actual.supersedesList).toEqual([PRIOR_HEAD_URL]);
    // Zero pod writes — the substrate gate rejected before any PUT.
    expect(writes.length).toBe(0);
  });

  it('rides out transient prior-head GET flakes via the raised retry budget (6 attempts, 500 ms base)', async () => {
    // Simulate 3 consecutive `fetch failed` transients on the prior-head
    // GET. Default budget (4 attempts, 1 s base) would have left only
    // 1 successful attempt — but if the storm continues 5 attempts in
    // it would exhaust. With the fix (6 attempts, 500 ms base) the
    // 4th attempt succeeds and the CAS gate matches.
    const { fetch } = makeRecordingFetch({ flakePriorHeadFirst: 3 });
    const created = '2026-06-06T00:00:02Z';
    const descriptor = descV2WithSupersedes();
    const { proof } = await buildAuthorshipProof(descriptor.id, created);
    const expectedHeadCid = computeCid(PRIOR_HEAD_TURTLE);

    const result = await publish(
      descriptor,
      '',
      POD,
      {
        fetch,
        authorshipProof: proof,
        ifMatchCid: expectedHeadCid,
      },
    );
    expect(result.previousHeadCid).toBe(expectedHeadCid);
  }, 30_000);

  it('does NOT send `Cache-Control: no-cache` on the prior-head GET (regression on the failure-mode-amplifying header)', async () => {
    const { fetch } = makeRecordingFetch();
    const created = '2026-06-06T00:00:03Z';
    const descriptor = descV2WithSupersedes();
    const { proof } = await buildAuthorshipProof(descriptor.id, created);
    const expectedHeadCid = computeCid(PRIOR_HEAD_TURTLE);

    await publish(
      descriptor,
      '',
      POD,
      { fetch, authorshipProof: proof, ifMatchCid: expectedHeadCid },
    );

    // The GET against PRIOR_HEAD_URL must have happened without a
    // Cache-Control header — CSS's normal cache invalidates on PUT,
    // current-or-newer is sufficient for CAS, and the no-cache header
    // was forcing Azure-Files re-reads on every check.
    const priorHeadGetCalls = (fetch as unknown as { mock: { calls: [string | URL | Request, RequestInit | undefined][] } }).mock.calls
      .filter(([url, init]) => {
        const u = typeof url === 'string' ? url : (url as URL | Request).toString();
        return u === PRIOR_HEAD_URL && (init?.method ?? 'GET') === 'GET';
      });
    expect(priorHeadGetCalls.length).toBeGreaterThan(0);
    for (const [, init] of priorHeadGetCalls) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      // No Cache-Control set anywhere — neither lowercase nor capitalized.
      expect(headers['Cache-Control']).toBeUndefined();
      expect(headers['cache-control']).toBeUndefined();
    }
  });
});
