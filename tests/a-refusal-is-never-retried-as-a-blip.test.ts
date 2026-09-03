/**
 * A considered "no" is not a network blip, and a content address is not a status code.
 *
 * ── TWO DEFECTS, ONE CLASS ───────────────────────────────────────────────────
 *
 * `withTransientRetry` retries on `isTransientNetworkError`, whose matcher ends `|5\d\d/`.
 * That alternative is UNANCHORED, so it fires on any three-digit run beginning with 5 anywhere
 * in the message — including inside a longer number and inside a hex address. Measured on this
 * matcher: 59.3% of sha1-length hex addresses and 76.6% of sha256-length ones contain such a
 * run. This substrate addresses nearly everything by content hash, and
 * `followAffordance`'s own descriptor fetch throws
 * `Failed to fetch descriptor <url>: 403 Forbidden` — so a PERMANENT 403 or 404 on a
 * content-addressed descriptor is misclassified as transient most of the time and retried four
 * times across ~15s of backoff, to be refused identically four times.
 *
 * Separately, the invoke leg throws on `status >= 500` so that `withTransientRetry` will retry
 * it. That is right for an infrastructure 5xx and wrong for an `iep:Refusal`: a vertical that
 * answers 502 has DECIDED — `unreadable-workspace`, `append-failed`, foxxi's `upstreamFailed` —
 * and retrying a decision cannot change it. Those refusals became 5xx in this same body of
 * work, which is what turned a latent policy into four 15-second waits per declined call.
 *
 * Both legs assert a COUNT of calls, not a status, because the bug is invisible in the result:
 * every one of these already returns the right answer, just four times and fifteen seconds
 * later. The last leg is the floor — over-fixing this into "never retry anything" would be a
 * worse bug than the one it replaces, and nothing else in the suite would notice.
 */
import { describe, it, expect } from 'vitest';
import { isTransientNetworkError } from '../packages/core/src/http/retry.js';
import { followAffordance } from '../packages/core/src/affordance/follow.js';
import type { FetchFn, FetchResponse } from '../packages/core/src/http/types.js';

/** A content address that really does contain a `5\d\d` run, from this repo's own output. */
const HASHED = 'https://relay.interego.xwisee.com/amep/exchanges/x318c23b311f459cfa5f54287e0be0a5a560086f9';

function res(status: number, body: string, contentType = 'application/json'): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null) },
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  };
}

const DESCRIPTOR = `
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<${HASHED}> iep:affordance [
  a iep:Affordance, hydra:Operation ;
  iep:action <https://example.org/act/decline> ;
  hydra:target <https://example.org/target> ;
  hydra:method "POST"
] .
`;

describe('a refusal is never retried as a blip', () => {
  it('★ does not call a permanent failure transient because the ADDRESS contains 5xx-shaped digits', () => {
    // Exactly the string followAffordance throws for a refused descriptor read.
    const permanent = [
      new Error(`Failed to fetch descriptor ${HASHED}: 403 Forbidden`),
      new Error(`Failed to fetch descriptor ${HASHED}: 404 Not Found`),
      new Error('descriptor 1523 not found'),
      new Error('chunk of 512 bytes rejected'),
      new Error('entry 2500 conflicts with head'),
    ];
    const misread = permanent.filter((e) => isTransientNetworkError(e)).map((e) => e.message);
    expect(
      misread,
      'these will never succeed on a retry, so four attempts across ~15s of backoff buys '
        + 'nothing and delays the refusal the caller is waiting for:\n  ' + misread.join('\n  '),
    ).toEqual([]);
  });

  it('still treats a real transient as transient — the floor on the fix above', () => {
    // If the fix narrows this into uselessness, the retry policy silently stops existing.
    const transient = [
      new Error('Failed to publish: 503 Service Unavailable'),
      new Error('Affordance target https://example.org/t returned 502 Bad Gateway'),
      new Error('fetch failed'),
      Object.assign(new Error('boom'), { cause: { code: 'UND_ERR_SOCKET' } }),
      Object.assign(new Error('boom'), { code: 'ECONNRESET' }),
    ];
    const missed = transient.filter((e) => !isTransientNetworkError(e)).map((e) => e.message);
    expect(missed, 'the retry policy must still fire on genuine blips').toEqual([]);
  });

  it('★ reads a refused descriptor ONCE, not four times', async () => {
    let calls = 0;
    const fetchImpl: FetchFn = (_url) => {
      calls += 1;
      return Promise.resolve(res(403, 'forbidden', 'text/plain'));
    };
    await expect(followAffordance(HASHED, 'https://example.org/act/decline', {}, { fetch: fetchImpl }))
      .rejects.toThrow();
    expect(calls, 'a 403 was retried — the caller waits ~15s to be refused four times').toBe(1);
  });

  it('★ invokes a target that DECLARES a refusal once, however it statuses it', async () => {
    let invokes = 0;
    const refusal = JSON.stringify({
      kind: 'refusal',
      error: 'the workspace record could not be read',
      'iep:refusalStatus': 502,
      'iep:refusalReason': 'the workspace record could not be read, so membership could not be established',
    });
    const fetchImpl: FetchFn = (url) => {
      if (url === HASHED) return Promise.resolve(res(200, DESCRIPTOR, 'text/turtle'));
      invokes += 1;
      return Promise.resolve(res(502, refusal));
    };
    const r = await followAffordance(HASHED, 'https://example.org/act/decline', {}, { fetch: fetchImpl });
    expect(invokes, 'a declared refusal was retried; retrying a decision cannot change it').toBe(1);
    // And it is still surfaced as data, exactly as a 4xx refusal already is.
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body)['iep:refusalReason']).toContain('membership');
  });

  /**
   * ★★ THE FLOOR LEG ABOVE PASSED WHILE A REAL CALLER LOST ITS RETRIES.
   *
   * Its transient examples were the two spellings I had asserted were the only two — `...: 503
   * Service Unavailable` and `... returned 502 Bad Gateway`. An adversarial pass then rendered
   * all 23 in-repo 5xx throws that sit inside a `withTransientRetry` callback and ran each
   * through the built matcher: 22 matched and one did not.
   *
   *     lrs-forwarding.ts:252  `forward POST ${resp.status} ${resp.statusText}`
   *
   * No colon, no `HTTP`, no `status`, no `returned`. So anchoring the matcher silently disabled
   * retry for the xAPI forwarding path, where a downstream LRS 503 then dead-letters every
   * statement on its FIRST attempt into a 200-entry in-memory buffer that drops the oldest.
   *
   * The examples now come from the REAL throw sites rather than from my account of them.
   */
  it('★ classifies every real 5xx throw in this repo as transient, whatever its spelling', () => {
    const realThrows = [
      // applications/foxxi-content-intelligence/src/lrs-forwarding.ts:252 — no introducer at all
      'forward POST 503 Service Unavailable',
      // applications/foxxi-content-intelligence/src/statement-store.ts:501 — colon form
      'primary LRS failed: 503 Service Unavailable',
      // packages/core/src/affordance/follow.ts — `returned` form
      'Affordance target https://example.org/t returned 502 Bad Gateway',
      // deploy/mcp-relay/server.ts:15171 — bare status after a colon
      'GET <https://pod.example/x> failed: 500 Internal Server Error',
      'HTTP 504 Gateway Timeout',
    ];
    const missed = realThrows.filter((m) => !isTransientNetworkError(new Error(m)));
    expect(
      missed,
      'these are thrown INSIDE a withTransientRetry callback precisely so they are retried, and '
        + 'the matcher does not recognise them — so that caller silently gets one attempt:\n  '
        + missed.join('\n  '),
    ).toEqual([]);
  });

  it('★ and the reason-phrase form does not re-admit a bare number (the flag trap)', () => {
    // The reason-phrase alternative is case-SENSITIVE on purpose. Under /i it reads `bytes` as
    // a reason phrase and `chunk of 512 bytes rejected` becomes transient again — putting back
    // the exact false positive the anchoring existed to remove.
    const permanent = ['chunk of 512 bytes rejected', 'entry 2500 conflicts with head',
      'descriptor 1523 not found'];
    const misread = permanent.filter((m) => isTransientNetworkError(new Error(m)));
    expect(misread, 'the reason-phrase form is matching lowercase words').toEqual([]);
  });

  it('still retries a 5xx that declares NOTHING — the floor on the leg above', async () => {
    let invokes = 0;
    const fetchImpl: FetchFn = (url) => {
      if (url === HASHED) return Promise.resolve(res(200, DESCRIPTOR, 'text/turtle'));
      invokes += 1;
      return Promise.resolve(res(503, 'upstream exploded', 'text/plain'));
    };
    await expect(followAffordance(HASHED, 'https://example.org/act/decline', {}, { fetch: fetchImpl }))
      .rejects.toThrow();
    expect(invokes, 'a bare 5xx is a blip and must still be retried').toBeGreaterThan(1);
  });

  /**
   * ★★ `act()` REACHES A TARGET TWO WAYS AND ONLY ONE WAS FIXED.
   *
   * The descriptor-resolved leg delegates to `followAffordance`, which the legs above cover.
   * A caller supplying a PRE-RESOLVED target takes a second leg inside `kernel/index.ts` that
   * had its own copy of `if (r.status >= 500) throw`, read the body only after the retry, and
   * so structurally could not consult `declaresRefusal`. Measured before this: four fetches,
   * ~7s, and the refusal arrived as a thrown exception instead of as data carrying its
   * `iep:refusalReason`. Same call, same refusal, two outcomes decided by which argument the
   * caller passed — reached from `invoke_affordance` on both the relay and the stdio server.
   *
   * Both legs are asserted here so a future fix to one keeps having to be a fix to both.
   */
  it('★ act() with a PRE-RESOLVED target honours a declared refusal too, not just the descriptor leg', async () => {
    const { act } = await import('../packages/core/src/kernel/index.js');
    let invokes = 0;
    const refusal = JSON.stringify({
      kind: 'refusal',
      error: 'the workspace record could not be read',
      'iep:refusalStatus': 502,
      'iep:refusalReason': 'membership could not be established; nothing about the caller failed',
    });
    const fetchImpl: FetchFn = () => {
      invokes += 1;
      return Promise.resolve(res(502, refusal));
    };
    // The PRE-RESOLVED shape: the affordance itself is the first argument, which is what
    // `isPreResolvedAffordance` keys on and what routes to the second invoke leg.
    const result = await act(
      {
        action: 'https://example.org/act/decline',
        target: 'https://example.org/target',
        method: 'POST',
      } as never,
      {},
      { fetch: fetchImpl } as never,
    ) as { status?: number; body?: string };
    expect(invokes, 'the pre-resolved leg retried a declared refusal').toBe(1);
    expect(result.status, 'the refusal must arrive as data, with its status').toBe(502);
    expect(String(result.body)).toContain('membership could not be established');
  });
});
