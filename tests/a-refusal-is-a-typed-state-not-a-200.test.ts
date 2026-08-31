/**
 * A declined call does not answer 200, and says how to stop being declined.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 *
 * `createVerticalBridge`'s REST route sends whatever a handler returns and sets no status of
 * its own — the only `res.status` on that path is the 400 in its catch, which a handler that
 * RETURNS rather than THROWS never reaches. Foxxi's auth check returns
 * `{error: 'missing credential …'}`. So, driven against the live bridge, every unauthenticated
 * call to every published affordance answered **HTTP 200** — on all three deployed bridges,
 * which share this dispatcher. 17 places in our own clients branch on `.ok` and read that as
 * success.
 *
 * ── WHY THE FIX IS A KIND AND NOT AN `if (result.error)` ─────────────────────
 *
 * Sniffing the payload for an `error` key would have been the `if (x)` this substrate refuses
 * everywhere else, and `KERNEL_RESULT_SHAPES`' own note already states the rule: "each kernel
 * verb hands its own kind so we don't have to sniff the payload". There were ten kinds for
 * ways to SUCCEED and none for declining — that asymmetry is the actual primitive gap, and it
 * is why the status had nothing to derive from. `iep:Refusal` closes it, `KERNEL_RESULT_STATUS`
 * maps kind → code as DATA, and the dispatcher reads the table.
 *
 * ── AND WHY A REFUSAL CARRIES AN AFFORDANCE ──────────────────────────────────
 *
 * The old message told a HUMAN to "pass a rev-196 signed-request envelope". An agent cannot
 * follow a sentence. `iep:resolvedBy` names the affordance that MINTS one, so the refusal is a
 * hypermedia state with a way out — the same discipline `interrogative_route` already applies
 * when it answers `partial` and names `pgsl_decide` rather than describing it.
 */
import { describe, it, expect } from 'vitest';
import { KERNEL_RESULT_SHAPES, KERNEL_RESULT_STATUS } from '@interego/core';

describe('the kernel can decline in a typed way', () => {
  it('refusal is a declared result kind with a shape, like every success kind', () => {
    expect(KERNEL_RESULT_SHAPES['refusal'], 'no shape for a refusal').toBeDefined();
    expect(String(KERNEL_RESULT_SHAPES['refusal'])).toMatch(/RefusalShape$/);
  });

  it('★ its status comes from a data table, not from a branch', () => {
    // The value matters less than WHERE it lives: a dispatcher that hardcoded 401 would have
    // to be edited for every new non-success kind, and would be sniffing payloads to decide.
    expect(KERNEL_RESULT_STATUS['refusal']).toBe(401);
    // A success kind has no entry and therefore defaults to 200 — absence is the encoding.
    expect(KERNEL_RESULT_STATUS['descriptor']).toBeUndefined();
    expect(KERNEL_RESULT_STATUS['act']).toBeUndefined();
  });

  it('★ every declared result kind resolves to a shape', () => {
    // A kind the dispatcher can be handed but cannot type would fall back silently to the
    // generic shape, which is how a refusal came to look like an ordinary result.
    for (const kind of Object.keys(KERNEL_RESULT_STATUS)) {
      expect(KERNEL_RESULT_SHAPES[kind], `kind '${kind}' has a status but no shape`).toBeDefined();
    }
  });

  it('the published ontology defines what the code references', () => {
    // The shape IRI is not a string the code invented: iep:Refusal and its three properties
    // are declared in docs/ns/iep.ttl and projected into iep.html, which the parse gate and
    // the projection gate both check.
    expect(String(KERNEL_RESULT_SHAPES['refusal'])).toContain('/ns/iep#');
  });
});
