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

/** The foxxi bridge with comments stripped, so a denial DESCRIBED in prose is never mistaken
 *  for a denial RETURNED by a handler — the way a sibling gate matched its own documentation. */
function bridgeCode(): string {
  return readFileSync(
    new URL('../applications/foxxi-content-intelligence/bridge/server.ts', import.meta.url), 'utf8',
  ).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

/**
 * Every `return { ... error ... }` statement in the bridge, as strings.
 *
 * ★★ THE FIRST VERSION OF THIS GATE WAS BLIND. THE CAUSE IS STILL NOT KNOWN.
 *
 * Both halves below were once written inline, each running its own `code.matchAll(/…/g)`.
 * Planted defects — one auth denial reverted to an untyped `{ error }`, one new untyped denial
 * in wording the vocabulary does not know — passed 6/6. Instrumented, the same test body
 * printed `totalMatches= 135` from its first `matchAll` and `untypedLen= 0` from its second,
 * over the same string.
 *
 * TWO explanations have been tried and BOTH are disproven, so neither is written here as fact:
 *
 *   · "identical /…/g literals share one object and leak lastIndex" — in plain node, separate
 *     literals are distinct objects, and a deliberately SHARED one still yields 3 then 3,
 *     because `matchAll` clones its argument.
 *   · "something about this file under the test transform" — a scratch suite reproducing the
 *     exact shape (for-of, spread, and both in one body, identical literals, same string) under
 *     vitest returned 133 / 133 / 133. `matchAll` reuse is NOT a hazard in this tree, and the
 *     four other files that reuse a matchAll literal are not at risk from it.
 *
 * So the mechanism is unexplained and this comment does not invent a third story. What IS
 * established is narrow and sufficient: routing both halves through this one helper, which
 * builds its regex per call and returns plain STRINGS, makes each half fail on its own mutant
 * by name (§A named the untyped denial; §B reported 83 against a budget of 81). The gate rests
 * on measured behaviour, not on a diagnosis.
 */
function errorReturns(code: string): string[] {
  // ★ SCANNED, NOT MATCHED. This was a regex until an audit showed `[^}]*` cannot cross a
  // NESTED object — so every refusal carrying `iep:resolvedBy: { … }`, which is every refusal
  // that names a way out, was invisible to §A and §B. Three earlier bounds failed the same way
  // (see tests/return-object-scan.ts for all four and why each moved the blindness rather than
  // removing it). The keys stay a list because "what counts as a decline" is a judgement; where
  // the object ENDS is not, and that is now counted rather than guessed.
  const key = ['error', 'reason', 'refused', 'denied'];
  return returnObjects(code)
    .map(r => r.text)
    .filter(t => key.some(k => new RegExp('[{,]\\s*(?:readonly\\s+)?' + k + '\\s*[:,}]').test(t)));
}

/**
 * Those that answer without a refusal kind and without an explicit status.
 *
 * `{ ok: false, error }` is EXCLUDED, and the exclusion is measured rather than assumed: all 29
 * such returns in the bridge sit inside a named helper function with a discriminated-union
 * return type, never inside a handler entry, and their callers set a status of their own
 * (validateTourRun's does `res.status(400)`). The gate below re-checks that property, so the
 * exclusion cannot quietly start hiding a real handler.
 */
function untypedErrorReturns(code: string): string[] {
  return errorReturns(code)
    .filter(r => !r.includes("kind: 'refusal'"))
    // Whitespace-tolerant: `return {\n  ok: false,` is the same idiom, and a startsWith() on the
    // single-line spelling silently let every multi-line one through.
    .filter(r => !new RegExp('^return\\s*\\{\\s*ok:\\s*false').test(r.trimStart()))
    // ★ A BARE `status:` USED TO EXCUSE A RETURN, AND IT EXCUSES NOTHING.
    //
    // The dispatcher reads `payload['iep:refusalStatus'] ?? payload['refusalStatus']` and
    // nothing else, so `return { error, status: 403 }` answers HTTP 200 — while this filter
    // dropped it from the census, making it invisible to §A and §B at the same time. That is
    // not a hypothetical spelling: `agent-evaluation.ts` returns `{ error, status }` as its
    // producer idiom and `propagateRefusal` exists to translate it, so a handler that returned
    // the producer's value directly would have re-created the whole bug silently.
    //
    // The `ok: false` filter above already covers the helper returns this was written for, and
    // §C polices that those stay inside helpers.
    .filter(r => !new RegExp("(?:iep:)?refusalStatus'?\\s*:").test(r))
    // An Express route sets the status on the RESPONSE, one call to the left of the object —
    // `res.status(403).json({ … })`. The scanner captures that prefix precisely so this can
    // tell an honest Express answer from an un-statused handler return; without it, all 138
    // routes in this bridge read as defects and the gate becomes noise nobody acts on.
    .filter(r => !new RegExp('res\\s*\\.\\s*status\\s*\\(').test(r))
    // ★ A RESPONSE THAT DECLARES SUCCESS IS NOT A DECLINE, whatever words it contains. Three
    // `ok: true` payloads carry a `reason` — why a credential verified, why a descriptor was
    // not projectable — and the key list cannot tell that from a refusal. `ok: true` can, and
    // it is the answer's own statement about itself rather than a guess about its prose.
    .filter(r => !new RegExp('[{,]\\s*ok:\\s*true').test(r));
}

/** Every `return { ok: false` line, paired with the nearest enclosing declaration above it. */
function okFalseSites(code: string): Array<{ line: number; enclosing: string }> {
  const lines = code.split(String.fromCharCode(10));
  const out: Array<{ line: number; enclosing: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes('return { ok: false')) continue;
    let enclosing = '(top level)';
    for (let j = i; j >= 0; j--) {
      const fn = new RegExp('^(?:async )?function ([A-Za-z0-9_]+)').exec(lines[j]!);
      const handler = new RegExp("^\\s*'([a-z0-9_.]+)': async").exec(lines[j]!);
      // A nested callback property — `verifyCaller: async (token): Promise<CallerVerification>`
      // — has its own contract and its own consumer, which sets the status (context-chat.ts
      // answers 401 on a failed verification). Without this the scan walks past it to the
      // enclosing handler and reports three false positives, which is how a gate that flags
      // explainable things stops being believed.
      const callback = new RegExp('^\\s*[A-Za-z0-9_]+: (?:async )?\\(').exec(lines[j]!);
      if (handler) { enclosing = 'HANDLER ' + handler[1]; break; }
      if (callback) { enclosing = 'callback'; break; }
      if (fn) { enclosing = fn[1]!; break; }
    }
    out.push({ line: i + 1, enclosing });
  }
  return out;
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
