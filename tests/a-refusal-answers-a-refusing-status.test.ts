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
 *    which is 28 sites in the foxxi bridge
 *  · the node is TYPED `iep:Refusal`, without which the advertised RefusalShape targets nothing
 *    and its constraints validate zero nodes
 *  · an ordinary result still answers 200 — a gate that refused everything would "fix" the
 *    symptom and break the service, and status alone cannot tell those apart
 */
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createVerticalBridge } from '../applications/_shared/vertical-bridge/index.js';

const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';

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
      // 28 authorization denials in the foxxi bridge rely on exactly this.
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
});
