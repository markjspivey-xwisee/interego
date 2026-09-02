/**
 * A refusal returned by a handler comes back over HTTP as a refusing status, typed as a refusal.
 *
 * ── WHY THIS EXISTS: MY OTHER REFUSAL TESTS COULD NOT FAIL ───────────────────
 *
 * Two tests were written for the typed-refusal work and neither observes an HTTP response.
 * `a-refusal-is-a-typed-state-not-a-200.test.ts` asserts over `KERNEL_RESULT_SHAPES` and
 * `KERNEL_RESULT_STATUS` — constants. `a-refusal-is-propagated-not-rebuilt.test.ts` greps
 * source text. So deleting `res.status(status)` from the dispatcher — which restores the exact
 * "every affordance answers 200" bug the whole change was written to fix — leaves both green.
 * An adversarial audit found that; I did not, and I had already shipped a fix for this feature
 * that was INERT in production for the same reason: nothing drove the actual surface.
 *
 * `createVerticalBridge` returns an Express app and the CALLER listens, so it was always
 * drivable in-process. There was no reason not to.
 *
 * ── WHAT IT PINS ─────────────────────────────────────────────────────────────
 *
 *  · a `kind: 'refusal'` handler result answers 401 (the kind's default from KERNEL_RESULT_STATUS)
 *  · an explicit `iep:refusalStatus` overrides it — 403 for "authenticated but not permitted",
 *    which is what the foxxi bridge's authorization denials use (the count is derived by the
 *    census below rather than stated here, because a stated one drifts the moment a site is
 *    added — an earlier version of this line said 28 when the code said 31)
 *  · the node is TYPED `iep:Refusal`, without which the advertised RefusalShape targets nothing
 *    and its constraints validate zero nodes
 *  · an ordinary result still answers 200 — a gate that refused everything would "fix" the
 *    symptom and break the service, and status alone cannot tell those apart
 */
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { createVerticalBridge } from '../applications/_shared/vertical-bridge/index.js';
import { returnObjects } from './return-object-scan.js';

const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';

/**
 * The foxxi bridge, read by the PARSER — not stripped, not pattern-matched.
 *
 * This used to strip full-line comments before matching, which produced two defects at once: a
 * TRAILING `// was: return { error: … }` was censused as a real handler return, and every line
 * number reported was off by the number of comment lines above it (1,454 lines off in one case,
 * so §C named a site nobody could find). The parser does not see comments at all and reports
 * positions in the file as written, so both go away by not doing the stripping.
 */
function bridgeCode(): string {
  return readFileSync(
    new URL('../applications/foxxi-content-intelligence/bridge/server.ts', import.meta.url), 'utf8',
  );
}

/**
 * Every answer in the bridge that carries a decline-shaped key.
 *
 * This helper has been rewritten four times and each rewrite is recorded in the scanner's
 * header, because the pattern of failure matters more than any one of them: a regex, then a
 * wider regex, then a hand-rolled brace counter, then the TypeScript parser. Only the last is
 * correct by construction, and it is the only one whose correctness does not rest on me having
 * thought of the right special cases.
 *
 * (An earlier version of this comment described a blindness whose cause was "still not known".
 * That investigation is closed: the gate was a regex, and the mechanism was the regex.)
 */
function errorReturns(code: string): string[] {
  // The KEYS stay a judgement — "what counts as a decline" is one. Where an object BEGINS and
  // ENDS is not a judgement, and is now the parser's answer rather than a pattern's guess.
  const key = ['error', 'reason', 'refused', 'denied'];
  return returnObjects(code)
    .filter(r => r.statusCall === null)
    .map(r => r.text)
    .filter(t => key.some(k => new RegExp('[{,]\\s*(?:readonly\\s+)?' + k + '\\s*[:,}]').test(t)));
}

/**
 * Those that answer without a refusal kind and without an explicit status.
 *
 * `{ ok: false, error }` is EXCLUDED. The exclusion was described here as "measured: all 29 sit
 * inside a named helper … and their callers set a status". An audit found that sentence wrong
 * in three ways — some sit in an anonymous callback, one was invisible to the matcher, and
 * nothing anywhere checked that callers set a status. So the claim is now the WEAKER one that
 * §C actually enforces: no `{ok:false}` return sits directly in a handler entry, where the
 * dispatcher would serve it as 200. Whether a helper's caller sets a status is not asserted by
 * this file, and this comment no longer says it is.
 */
function untypedErrorReturns(code: string): string[] {
  return errorReturns(code)
    .filter(r => !r.includes("kind: 'refusal'"))
    .filter(r => !new RegExp('^\\{\\s*ok:\\s*false').test(r.trimStart()))
    // The dispatcher reads ONLY `iep:refusalStatus` / `refusalStatus`. A bare `status:` sets
    // nothing and excuses nothing — it used to do both, hiding the producer idiom
    // `{ error, status }` from §A and §B while it answered 200.
    // Both quotings, because both are written in this tree — `'iep:refusalStatus':` in the foxxi
    // bridge and `"iep:refusalStatus":` in wsp. A filter that knew only one would have called
    // every wsp refusal untyped the moment one was read by this gate: the narrowest-filter
    // mistake again, one level down from where it was last found.
    .filter(r => !new RegExp("['\"]?(?:iep:)?refusalStatus['\"]?\\s*:").test(r))
    // A response that DECLARES success is not a decline, whatever words it carries: three
    // `ok: true` payloads hold a `reason` (why a credential verified, why a descriptor was not
    // projectable). Routes that set a status are excluded structurally in errorReturns.
    .filter(r => !new RegExp('[{,]\\s*ok:\\s*true').test(r));
}

/**
 * Every `{ ok: false … }` answer, with where it sits.
 *
 * Both previous versions misclassified. The first found returns by LINE, so the multi-line form
 * was invisible; the second called any property whose value began with `(` a "callback" — a
 * cast, a parenthesised expression — and 57 such lines sit inside handlers, so a `{ok:false}`
 * below any of them was excused. The parser answers "which function is this in" directly.
 */
function okFalseSites(code: string): Array<{ line: number; enclosing: string }> {
  return returnObjects(code)
    .filter(r => new RegExp('^\\{\\s*ok:\\s*false').test(r.text.trimStart()))
    .map(r => ({ line: r.line, enclosing: r.enclosing }));
}

const AFFORDANCES = [
  {
    action: 'urn:iep:action:test:refuse-auth',
    toolName: 'test.refuse_auth',
    title: 'Refuses with the kind default',
    description: 'Returns a refusal with no explicit status.',
    method: 'POST',
    targetTemplate: '{base}/test/refuse_auth',
    inputs: [],
  },
  {
    action: 'urn:iep:action:test:refuse-forbidden',
    toolName: 'test.refuse_forbidden',
    title: 'Refuses with an explicit 403',
    description: 'Returns a refusal naming its own status.',
    method: 'POST',
    targetTemplate: '{base}/test/refuse_forbidden',
    inputs: [],
  },
  {
    action: 'urn:iep:action:test:succeed',
    toolName: 'test.succeed',
    title: 'Succeeds',
    description: 'An ordinary result.',
    method: 'POST',
    targetTemplate: '{base}/test/succeed',
    inputs: [],
  },
];

const handlers = {
  'test.refuse_auth': async () => ({
    kind: 'refusal',
    error: 'missing credential',
    'iep:refusalReason': 'the caller could not be authenticated',
  }),
  'test.refuse_forbidden': async () => ({
    kind: 'refusal',
    'iep:refusalStatus': 403,
    error: 'forbidden — not your record',
    'iep:refusalReason': 'the caller is authenticated but not permitted this operation',
  }),
  'test.succeed': async () => ({ ok: true, value: 42 }),
};

async function withBridge<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = createVerticalBridge({
    vertical: 'test',
    affordances: AFFORDANCES as never,
    handlers: handlers as never,
    deploymentUrl: 'http://127.0.0.1',
  } as never);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const post = async (base: string, path: string) => {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};

describe('a refusal answers over HTTP as a refusal', () => {
  it('★ a refusal does NOT answer 200 — the bug this whole change exists for', async () => {
    await withBridge(async (base) => {
      const { status } = await post(base, '/test/refuse_auth');
      expect(status, 'a refusal answered 200; every client that checks .ok reads that as success')
        .not.toBe(200);
      expect(status).toBe(401);
    });
  });

  it('an explicit iep:refusalStatus wins over the kind default', async () => {
    await withBridge(async (base) => {
      const { status } = await post(base, '/test/refuse_forbidden');
      expect(status).toBe(403);
    });
  });

  it('★ the node is typed iep:Refusal, or the advertised shape targets nothing', async () => {
    await withBridge(async (base) => {
      const { body } = await post(base, '/test/refuse_auth');
      const types = Array.isArray(body['@type']) ? body['@type'] as string[] : [String(body['@type'])];
      expect(
        types,
        'conformsToShape advertised RefusalShape while @type carried no iep:Refusal — '
          + 'sh:targetClass selects zero nodes and every constraint on it validates nothing',
      ).toContain(`${IEP}Refusal`);
      expect(String(body['iep:conformsToShape'] ?? body['conformsToShape'])).toContain('RefusalShape');
    });
  });

  it('★ an ordinary result still answers 200 — it refuses selectively, not universally', async () => {
    await withBridge(async (base) => {
      const { status, body } = await post(base, '/test/succeed');
      expect(status).toBe(200);
      expect(body['value']).toBe(42);
    });
  });

  /**
   * ★★ THE CENSUS, NOT THE INSTANCE — AND A RATCHET FOR WHAT THE CENSUS CANNOT NAME.
   *
   * The typed-refusal sweep has now been declared complete FOUR times and was wrong each time,
   * each time because it fixed the sites in front of it:
   *
   *   pass 1  converted 41 handler returns, left 28 authorization denials at HTTP 200
   *   pass 2  converted those, left 6 reached through `assertTenantOwnerWrite` /
   *           `assertSelfSovereignOwner`, which returned a bare STRING every caller re-wrapped
   *   pass 3  the first version of THIS gate found 2 more within the hour
   *   pass 4  a live probe of the deployed bridge found `a signed request is required` answering
   *           200 — and this gate did not flag it, because its vocabulary was a list of the
   *           phrasings I happened to have seen. A census that guesses vocabulary writes a
   *           FALSE all-clear, which is worse than no census.
   *
   * So the gate has two halves, and the second exists because the first cannot be trusted:
   *
   *   §A  VOCABULARY — every denial matching a known auth/refusal phrasing must be typed. This
   *       catches what can be named, and is zero-tolerance.
   *   §B  RATCHET — the total count of untyped `return { error }` may only ever go DOWN. A new
   *       denial of a phrasing nobody anticipated fails §B even when §A is blind to it. Same
   *       instrument as the turtle IRI ratchet (674, never rises).
   */
  it('★ §A no denial in the foxxi bridge returns without a refusal kind', () => {
    const code = bridgeCode();
    const DENIAL = new RegExp([
      'forbidden', 'auth: ', 'requires an admin caller', 'is not the owner of',
      'signed request is required', 'requires an operator role', 'proof-of-possession',
      'rate limit exceeded', 'unauthorized', 'not permitted', 'permission denied',
      'requires a signature', 'credential required',
    ].join('|'), 'i');

    const offenders = untypedErrorReturns(code)
      .filter(r => DENIAL.test(r))
      .map(r => r.replace(new RegExp('[ ]+', 'g'), ' ').slice(0, 150));
    expect(
      offenders,
      `${offenders.length} handler return(s) refuse a caller without a refusal kind, so the `
        + 'dispatcher answers 200 and every client that branches on res.ok reads success:'
        + `${String.fromCharCode(10)}  ${offenders.join(String.fromCharCode(10) + '  ')}`,
    ).toEqual([]);

    const typed = code.match(/kind: 'refusal'/g)?.length ?? 0;
    expect(typed, 'no typed refusals found — this gate is not reading the bridge').toBeGreaterThan(30);
  });

  /**
   * 81 -> 0. Every declined call this bridge returns now answers the status it means.
   *
   * The pass ran in three rounds because each one revealed a class the previous had not
   * considered, and the classes are the useful record:
   *
   *   round 1  60 sites: 400 invalidArguments (iep:resolvedBy points at the affordance's own
   *            published input contract instead of restating it), 404 notFound, 503
   *            notConfigured, 502 upstreamFailed, 403 wrongPod.
   *   round 2  a live signed request showed two refusals with the WRONG status rather than
   *            none — see a-refusal-status-names-what-actually-failed.test.ts.
   *   round 3  the last 14. Four `catch { (e as Error).message }` around mergeSignedEnvelope
   *            turned out to be AUTH failures, not internals — 401 naming sign_request.
   *            `notImplemented` became 501: a bridge that PUBLISHES an affordance it cannot run
   *            was answering success, which is "advertise only what you can run" stated in HTTP.
   *            Two authorization denials in the evaluation path answered 200. And the xAPI
   *            emitter failure answered 200 on the tool surface while its /agent twin answered
   *            500 — the third instance of one failure giving two different answers.
   *
   * The propagations were fixed at the SOURCE rather than the call site: `agent-evaluation.ts`
   * and `read-target.ts` now name a status on each refusal, and the bridge propagates it. A
   * caller that guessed 404 from the words "no evaluation" would break the first time someone
   * reworded the message.
   */
    it('★ §C the excluded `{ok:false}` idiom stays inside helpers, never a handler', () => {
    // §B ignores `return { ok: false, error }` because every one of them is an internal helper
    // with a union return type whose CALLER sets the status. That is only true while it is
    // true: wire one into a handler and it would answer HTTP 200 while this gate reported zero.
    const inHandlers = okFalseSites(bridgeCode()).filter(s => s.enclosing.startsWith('HANDLER'));
    expect(
      inHandlers.map(s => `L${s.line} ${s.enclosing}`),
      'a `{ok:false}` return sits in a HANDLER, where the dispatcher will serve it as 200 — '
        + 'either give it a refusal kind or move it into a helper whose caller sets the status',
    ).toEqual([]);
    // And the exclusion must still be reading something, or §B is silently unbounded.
    expect(okFalseSites(bridgeCode()).length, 'no ok:false sites found — this leg is vacuous')
      .toBeGreaterThan(20);
  });

  it('★ §B the untyped-return count ratchets down, never up', () => {
    const UNTYPED_BUDGET = 0;
    const code = bridgeCode();
    const untyped = untypedErrorReturns(code);
    expect(
      untyped.length,
      `${untyped.length} untyped error returns, budget ${UNTYPED_BUDGET}. If this ROSE, a new `
        + 'declined call answers HTTP 200 — type it as a refusal. If it FELL, lower the budget '
        + 'in this file; the ratchet only holds while it is tight.',
    ).toBeLessThanOrEqual(UNTYPED_BUDGET);
  });
});
