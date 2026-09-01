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
 * ★★ THE FIRST VERSION OF THIS GATE WAS BLIND, AND THE CAUSE IS NOT ESTABLISHED.
 *
 * Both halves below were written inline, each running its own `code.matchAll(/…/g)`. Planted
 * defects — one auth denial reverted to an untyped `{ error }`, one new untyped denial in
 * wording the vocabulary does not know — passed 6/6. Instrumented, the same test printed
 * `totalMatches= 135` from the first `matchAll` and `untypedLen= 0` from the second, on the
 * same string in the same test body.
 *
 * I do not know why. The obvious explanation — two identical `/…/g` literals sharing one
 * object, leaking `lastIndex` — is DISPROVEN: in plain node, separate literals are distinct
 * objects AND a deliberately shared one still yields 3 then 3, because `matchAll` clones its
 * argument. So the mechanism is something about this file under the test transform that I have
 * not isolated, and this comment does not invent one.
 *
 * What IS established: routing both halves through this single helper, which builds its regex
 * with `new RegExp` per call and returns plain STRINGS, makes each half fail on its own mutant
 * by name (§A found the untyped denial; §B reported 83 against a budget of 81). That is the
 * property the gate needs, so it is what the gate rests on — but the underlying hazard is
 * unexplained and may still be reachable from other multi-`matchAll` code in this tree.
 */
function errorReturns(code: string): string[] {
  return [...code.matchAll(new RegExp('return[^]{0,4}[{][^}]*error[^}]*[}]', 'g'))].map(m => m[0]);
}

/** Those of them that answer without a refusal kind and without an explicit Express status. */
function untypedErrorReturns(code: string): string[] {
  return errorReturns(code)
    .filter(r => !r.includes("kind: 'refusal'"))
    .filter(r => !new RegExp('status:[ ]*[0-9]{3}').test(r));
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
   * The 81 remaining untyped returns are overwhelmingly VALIDATION errors ("task_name is
   * required"), which belong at 400 rather than 200 — a real defect of the same family, but a
   * deliberate separate pass rather than something to fold in silently here. This number is
   * what makes that pass measurable, and stops a NEW untyped denial from hiding among them.
   */
  it('★ §B the untyped-return count ratchets down, never up', () => {
    const UNTYPED_BUDGET = 81;
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
