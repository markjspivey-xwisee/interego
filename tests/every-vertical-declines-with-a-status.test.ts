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
  /**
   * wsp's refusals are built by `respondAsMember`, which is exported and pure enough to call
   * directly. The bridge spreads its result into the answer, so what this asserts is the thing
   * the dispatcher will read. Driving the whole handler would need a live relay and an agent
   * key; the STATUS decision lives here, and here is where it is checked.
   */
  it('★ wsp: a refusal built by respondAsMember carries a status the dispatcher can use', async () => {
    const { respondAsMember } = await import('../applications/shared-workspace/src/respond.js');
    // respondAsMember(session, opts). The session carries the deps it reads through, so an
    // unreadable workspace is produced by making the dereference fail — the real first branch.
    const session = {
      identity: { podName: 'p', podUrl: 'https://pod.invalid/p/', webId: 'https://pod.invalid/p/#me', agentDid: 'did:x:1', scope: 'ReadWrite', address: '0x0' },
      deps: { getCurrentHead: async () => { throw new Error('unresolvable'); } },
    };
    const result = await respondAsMember(
      session as never,
      { workspace: 'https://relay.invalid/ns/nobody/ws', body: 'hello' } as never,
    ) as Record<string, unknown>;

    expect(result['outcome'], 'expected a refusal from an unreadable workspace').toBe('refused');
    expect(
      result['kind'],
      `a wsp refusal (${String(result['reason'])}) carries no kind, so the bridge spreads it `
        + 'into an answer the dispatcher serves as HTTP 200 — a caller that is not a member is '
        + 'told the write succeeded',
    ).toBe('refusal');
    expect(REFUSING).toContain(result['iep:refusalStatus']);
  });
  /**
   * ★ A HANDLER THAT THROWS IS THE FOURTH SPELLING OF "NO".
   *
   * agp validates required inputs by throwing (`missing required input(s): …`). On REST the
   * dispatcher's catch answers 400 with a typed AffordanceFailure — honest. This asks what the
   * MCP leg of the SAME factory does with the same throw. An honest answer is either a JSON-RPC
   * `error` object or a result with `isError: true`; a plain `result` is the defect this file
   * exists for, on the surface nobody drove.
   */
  it('★ a handler that THROWS is an error on the MCP leg too, not a plain result', async () => {
    const affordance = [{
      action: 'urn:iep:action:test:throws', toolName: 'test.throws', title: 'Throws', method: 'POST',
      description: 'Validates by throwing.', targetTemplate: '{base}/test/throws', inputs: [],
    }];
    const handlers = { 'test.throws': async () => { throw new Error('test.throws: missing required input(s): x'); } };
    await withBridge(
      { vertical: 'test', affordances: affordance as never, handlers: handlers as never, deploymentUrl: 'http://127.0.0.1' } as never,
      async (base) => {
        const r = await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'test.throws', arguments: {} } }),
        });
        const text = await r.text();
        const m = /data:\s*(\{[\s\S]*\})/.exec(text);
        const body = JSON.parse(m ? m[1]! : text) as { error?: unknown; result?: { isError?: boolean } };
        const honest = Boolean(body.error) || body.result?.isError === true;
        expect(
          honest,
          `a thrown handler error reached the MCP client as a plain successful result: ${text.slice(0, 200)}`,
        ).toBe(true);
      },
    );
  });
});
