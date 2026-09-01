/**
 * Every vertical's declined call answers a refusing status — checked by DRIVING it, not reading it.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT ANOTHER SOURCE CENSUS ─────────────────
 *
 * The typed-refusal work was declared complete for the foxxi bridge and "closed" everywhere
 * else on the strength of a repo-wide source census. An audit then found declined calls
 * answering HTTP 200 in THREE more verticals. They escaped because the census filtered on two
 * conditions in series — a key (`error|reason|refused|denied`) and a hand-written phrase list —
 * and a census is only as wide as its NARROWEST conjunct:
 *
 *   owm  `{ ok: false, reason: 'refused: target host is private/loopback/link-local' }`
 *        matched the key twice over; no phrase in the list matches "private/loopback/link-local".
 *   wsp  `{ outcome: 'refused', reason: 'not-seated' }` — same.
 *   agp  `{ pending: 'situation-not-resolvable', note: 'The engine ran nothing …' }`
 *        matched NEITHER. A third shape for "no", which no word list would have anticipated.
 *
 * So this does not pattern-match source. It mounts the REAL `createVerticalBridge` with each
 * vertical's REAL affordances and REAL handlers and POSTs to them, exactly as the auditors did.
 * A decline is then whatever the HANDLER says it is, and the only question asked is the one
 * that matters: what status does a client see? No vocabulary, nothing to keep widening.
 *
 * Each bridge's `server.ts` calls `app.listen()` at import, so importing it would start a
 * server. That is not a reason to fall back to reading source: what those modules COMPOSE —
 * the affordances and the handler factory — is importable, and composing them here is what the
 * bridge itself does one line later.
 */
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createVerticalBridge } from '../applications/_shared/vertical-bridge/index.js';

/** Statuses a DECLINE may answer with. 200 is the whole point: it is never one of them. */
const REFUSING = [400, 401, 403, 404, 409, 422, 429, 500, 501, 502, 503];

async function withBridge<T>(
  opts: Parameters<typeof createVerticalBridge>[0],
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const app = createVerticalBridge(opts);
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

const post = async (base: string, path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};

describe('a declined call answers a refusing status on every vertical', () => {
  it('★ agp: an unresolvable situation is a declined call, not a successful diagnosis', async () => {
    const { agpAffordances } = await import('../applications/agentic-performance-practice/affordances.js');
    const { createAgpHandlers } = await import('../applications/agentic-performance-practice/bridge/handlers.js');
    await withBridge(
      { vertical: 'agp', affordances: agpAffordances as never, handlers: createAgpHandlers({}) as never, deploymentUrl: 'http://127.0.0.1' } as never,
      async (base) => {
        for (const tool of ['diagnose', 'plan_intervention', 'evaluate_intervention']) {
          const { status, body } = await post(base, `/agp/${tool}`, {});
          expect(
            REFUSING,
            `agp.${tool} answered ${status} for a call it declined outright — the engine ran `
              + `nothing and the caller was told it succeeded. body: ${JSON.stringify(body).slice(0, 160)}`,
          ).toContain(status);
        }
      },
    );
  });

  /**
   * owm's 14 handlers are declared inline in a `server.ts` that calls `app.listen()` at import,
   * so unlike agp there is no factory to import. `owm.navigate_source` is a ONE-LINE passthrough
   * — `return adapter.navigate(verb, verbArgs)` — so driving the real adapter through the real
   * dispatcher tests everything except that one line.
   *
   * That one line is therefore ASSERTED below rather than assumed. A harness standing in for a
   * dependency cannot verify it; a harness that pins the shape of the line it stands in for can
   * at least fail when the assumption stops holding. Extracting owm's handlers into a factory
   * (as agp and foxxi have) would remove the need, and is the better fix when someone has cause
   * to touch that file.
   */
  it('★ owm: an SSRF refusal is a refusal, not a 200 with the word "refused" in it', async () => {
    const { owmAffordances } = await import('../applications/organizational-working-memory/affordances.js');
    const { AdapterRegistry } = await import('../applications/organizational-working-memory/source-adapters/index.js');
    const { webAdapter } = await import('../applications/organizational-working-memory/source-adapters/web.js');

    const registry = new AdapterRegistry();
    registry.register(webAdapter);
    // The passthrough, verbatim from bridge/server.ts:95-105.
    const handlers = {
      'owm.navigate_source': async (args: Record<string, unknown>) => {
        const adapter = registry.get(String(args['source'] ?? ''));
        if (!adapter) throw new Error('unknown source');
        return adapter.navigate(String(args['verb'] ?? '') as never, (args['args'] as Record<string, unknown>) ?? {});
      },
    };

    // The factory requires a handler per affordance, so mount only the one under test — the
    // real affordance record, from the real published list, not a hand-written stand-in.
    const navigate = (owmAffordances as ReadonlyArray<{ toolName: string }>)
      .filter(a => a.toolName === 'owm.navigate_source');
    expect(navigate.length, 'owm.navigate_source is no longer a published affordance').toBe(1);

    await withBridge(
      { vertical: 'owm', affordances: navigate as never, handlers: handlers as never, deploymentUrl: 'http://127.0.0.1' } as never,
      async (base) => {
        const { status, body } = await post(base, '/owm/navigate_source', {
          source: 'web', verb: 'cat', args: { uri: 'http://169.254.169.254/latest/meta-data/' },
        });
        expect(
          REFUSING,
          'the SSRF guard refused a link-local target and the caller was told HTTP 200. A client '
            + `that branches on res.ok cannot tell this from a successful fetch. body: ${JSON.stringify(body).slice(0, 160)}`,
        ).toContain(status);
        expect(body['kind'], 'the refusal is not typed, so the dispatcher cannot status it').toBe('refusal');
      },
    );
  });

  it('the owm passthrough this gate stands in for is still a passthrough', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../applications/organizational-working-memory/bridge/server.ts', import.meta.url), 'utf8',
    );
    // If navigate_source starts SHAPING the adapter's answer, the test above stops covering it.
    expect(
      src,
      'owm.navigate_source no longer ends in a bare `return adapter.navigate(...)`, so the gate '
        + 'above is now testing a double rather than the composition — drive the real handler '
        + '(extract a factory) instead of updating this assertion',
    ).toContain('return adapter.navigate(verb, verbArgs);');
  });
});
