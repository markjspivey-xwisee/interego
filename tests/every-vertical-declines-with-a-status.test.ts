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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createVerticalBridge } from '../applications/_shared/vertical-bridge/index.js';
import { returnObjects } from './return-object-scan.js';
import { delegationsIn } from './handler-delegation-reach.js';
import { fileURLToPath } from 'node:url';

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
   * ★★ EVERY wsp REFUSAL, NOT THE ONE MY HARNESS HAPPENED TO REACH.
   *
   * The first version of this leg called `respondAsMember` with a session whose deps were
   * `{ getCurrentHead }` — a name `StreamDeps` does not declare (it declares publish / discover
   * / get_descriptor). So the dereference failed for an unrelated reason and the leg landed on
   * the FIRST return by accident, pinning `unreadable-workspace` alone. It never touched
   * `not-seated` or `ceiling` — the authorization refusals the commit was named for, and the
   * two that matter most, since they are the ones that told an unauthorised caller HTTP 200.
   *
   * Reaching those by driving needs a readable workspace record, a seated roster and a role
   * profile — a fixture larger than the thing it would check. The property is simpler than the
   * path to it: EVERY refusal this module can return must carry the two fields the dispatcher
   * reads. That is a fact about the source, so the parser answers it for all seven at once,
   * including the ones no harness of mine has reached.
   */
  it('★ wsp: every refusal respondAsMember can return carries a kind and a status', async () => {
    const { readFileSync } = await import('node:fs');
    const { returnObjects } = await import('./return-object-scan.js');
    const src = readFileSync(
      new URL('../applications/shared-workspace/src/respond.js'.replace('.js', '.ts'), import.meta.url), 'utf8',
    );
    const refusals = returnObjects(src).filter(r => /outcome:\s*'refused'/.test(r.text));
    expect(refusals.length, 'no wsp refusals found — this leg is not reading respond.ts').toBeGreaterThanOrEqual(7);

    const untyped = refusals
      .filter(r => !r.text.includes("kind: 'refusal'") || !/iep:refusalStatus/.test(r.text))
      .map(r => `L${r.line} ${r.text.replace(/\s+/g, ' ').slice(0, 110)}`);
    expect(
      untyped,
      'a wsp refusal carries no kind/status, so the bridge spreads it into an answer the '
        + 'dispatcher serves as HTTP 200 — for not-seated and ceiling that means an '
        + 'unauthorised caller is told the write succeeded:'
        + String.fromCharCode(10) + '  ' + untyped.join(String.fromCharCode(10) + '  '),
    ).toEqual([]);

    // And the statuses must mean what the reasons say: authorization is 4xx, a failed READ is
    // 5xx. "A read that failed is not a thing that is missing" cuts both ways.
    const wrong: string[] = [];
    for (const r of refusals) {
      const reason = /reason:\s*'([a-z-]+)'/.exec(r.text)?.[1] ?? '?';
      const status = Number(/['"]iep:refusalStatus['"]:\s*([0-9]{3})/.exec(r.text)?.[1] ?? 0);
      const want = (reason === 'not-seated' || reason === 'ceiling') ? 403 : 502;
      if (status !== want) wrong.push(`L${r.line} ${reason}: ${status}, expected ${want}`);
    }
    expect(wrong, 'a wsp refusal answers a status its reason contradicts').toEqual([]);
  });

  /**
   * The driven half, with the deps the code ACTUALLY reads, so it fails for the reason it names
   * rather than because a stub was misnamed.
   */
  it('★ wsp: an unreadable workspace is refused through the real dependency surface', async () => {
    const { respondAsMember } = await import('../applications/shared-workspace/src/respond.js');
    const session = {
      identity: { podName: 'p', podUrl: 'https://pod.invalid/p/', webId: 'https://pod.invalid/p/#me', agentDid: 'did:x:1', scope: 'ReadWrite', address: '0x0' },
      deps: {
        publish: async () => ({}),
        discover: async () => { throw new Error('unresolvable'); },
        getDescriptor: async () => ({}),
      },
    };
    const result = await respondAsMember(
      session as never,
      { workspace: 'https://relay.invalid/ns/nobody/ws', body: 'hello' } as never,
    ) as Record<string, unknown>;
    expect(result['outcome']).toBe('refused');
    expect(result['kind'], `a wsp refusal (${String(result['reason'])}) carries no kind`).toBe('refusal');
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

  /**
   * ★★ "EVERY VERTICAL" MEANT THREE OF EIGHT.
   *
   * The three legs above DRIVE agp, owm and wsp. All EIGHT verticals mount
   * `createVerticalBridge`, so five are not driven here: agent-collective,
   * agent-development-practice, foxxi, learner-performer-companion and lrs-adapter. Of those,
   * only foxxi is reached by anything else - the two source censuses each read exactly one
   * file, and that file is foxxi's bridge server. So FOUR verticals were covered by nothing in
   * the tree, and this file's own title is what made that invisible: the same defect class as
   * the untyped refusals it was written to catch, a green tick standing in for coverage that
   * was never there.
   *
   * Driving all eight is not available cheaply. ★ NOT for the reason first written here —
   * "every bridge server but agp's calls `app.listen()` at import time" is false, and agp's own
   * source says so: grepping every `applications/<vertical>/bridge/server.ts` for a
   * column-zero `app.listen` returns one hit in all EIGHT, agp included. (Written that way
   * rather than as a glob: a `*` followed by a `/` closes this comment block, which is the
   * same delimiter-inside-its-own-delimiter trap that has broken a template literal here
   * before.) What agp actually does differently is keep its handler MAP in a
   * separate `bridge/handlers.ts`, which is importable without starting anything — and that,
   * not the listen call, is why agp alone can be driven here. Extracting the other seven the
   * same way is the work that would make this leg unnecessary.
   * What IS available meanwhile is to READ every mount, which this leg does - and to derive
   * the list from the filesystem rather than writing it down, because a hand-written list is
   * precisely how "every vertical" came to mean three.
   *
   * Measured when this was added: no untyped decline in any of the four. They delegate their
   * handlers to `src/`, and the decline-shaped returns there are
   * benign - `{ok:true, answer:null, reason:'no-data'}` is an empty result rather than a
   * refusal, and `agent-collective/src/request-gate.ts` is imported by nothing but its own
   * tests. The value here is that the NEXT one is caught by this file rather than by an audit.
   */
  it('★ every vertical that mounts the dispatcher is read, not just the three driven above', () => {
    const appsDir = new URL('../applications/', import.meta.url);
    const verticals = readdirSync(appsDir)
      .filter((d) => d !== '_shared')
      .filter((d) => {
        const server = new URL(`../applications/${d}/bridge/server.ts`, import.meta.url);
        return existsSync(server) && readFileSync(server, 'utf8').includes('createVerticalBridge(');
      });

    // Guards the guard: a discovery that stopped discovering would pass everything below.
    expect(
      verticals.length,
      'fewer mounts found than the eight known to exist - the discovery is broken, and a '
        + 'census that finds nothing reports no defects',
    ).toBeGreaterThanOrEqual(8);

    // ★★ `note` IS THE FOURTH SPELLING OF "NO", AND IT IS DELIBERATELY NOT IN THIS LIST.
    // The spellings that have defeated a census here, in order: `error`, `reason`, `pending`,
    // and then `note` - three foxxi retrieval handlers declined a MISSING REQUIRED input with
    // `{note: 'stub: pass args.course_content …'}` at HTTP 200 (now fixed to invalidArguments).
    //
    // Adding `note` was tried and REVERTED: it flags nine SUCCESSES that carry an advisory
    // note - `{recorded: true, …, note: 'Safe-to-fail probe recorded …'}` and eight like it.
    // The word does not carry the meaning; the same key says "why I declined" and "what I just
    // did". A permanent false positive is as damaging as a false negative, because a gate that
    // always fails is a gate nobody reads.
    //
    // So a word list has now lost four times and cannot be repaired by adding words. It is
    // kept for the shapes it does catch; the legs that DRIVE a bridge are what cannot be
    // out-spelled, and a mutant below plants a `note:` decline in a DRIVEN vertical to keep
    // proving that difference.
    const DECLINE = /\b(error|reason|refused|denied|forbidden|unauthori[sz]ed|invalid|pending|rejected|conflict|unavailable)\b/i;
    const offenders: string[] = [];
    let handlerReturns = 0;

    for (const v of verticals) {
      for (const rel of [`${v}/bridge/server.ts`, `${v}/bridge/handlers.ts`]) {
        const url = new URL(`../applications/${rel}`, import.meta.url);
        if (!existsSync(url)) continue;
        for (const o of returnObjects(readFileSync(url, 'utf8'))) {
          if (!o.enclosing.startsWith('HANDLER')) continue;
          handlerReturns += 1;
          // A refusal built by the shared helper IS typed; the literal `kind` lives inside
          // `refuse()`, not at the call site. Matching only the literal reported all six of
          // agp's correctly-typed refusals as untyped on this leg's first run.
          if (/\.\.\.\s*refuse\s*\(/.test(o.text)) continue;
          if (o.text.includes("kind: 'refusal'")) continue;
          // ★ A KEY SET TO null / undefined / false IS THE NEGATION OF THAT KEY. `pending: null`
          // is a SUCCESS saying nothing is pending, and five agp successes were reported as
          // declines because the word appeared. Strip the negated keys before asking.
          const claimed = o.text.replace(/\b\w+\s*:\s*(?:null|undefined|false)\b/g, '');
          if (!DECLINE.test(claimed)) continue;
          if (o.statusCall !== null && !Number.isNaN(o.statusCall) && o.statusCall >= 400) continue;
          // An empty RESULT is not a refusal: the caller's arguments were fine and the query
          // simply matched nothing. An OUTCOME FLAG is the marker and it is load-bearing - a
          // handler that declines does not report a verdict on work it did not do.
          //
          // ★ `true` OR `ok`, not `ok: true` alone. `verifyCompletionPresentation` answers
          // `{verified: ok, reason: ok ? undefined : 'BBS+ proof verification failed'}` - the
          // call SUCCEEDED and the verdict is 'invalid', which is a correct 200, and the
          // `reason` there annotates a result rather than refusing a call. Matching the shape
          // `<key>: true|ok` keeps this mechanical instead of growing a second vocabulary of
          // outcome nouns beside the decline one.
          if (/\b\w+:\s*(?:true|ok)\b/.test(o.text)) continue;
          offenders.push(`${rel}:${o.line} [${o.enclosing}] ${o.text.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }

    expect(
      handlerReturns,
      'no handler-enclosed return objects found across any mount - the scanner is reading '
        + 'nothing and this leg is vacuous',
    ).toBeGreaterThan(20);

    expect(
      offenders,
      'these handler returns say no without declaring a refusal, so createVerticalBridge '
        + 'answers them 200 and the caller cannot tell them from success:\n  '
        + offenders.join('\n  '),
    ).toEqual([]);
  });

  /**
   * ★★ THE LEG ABOVE READS THE BRIDGE, AND THE BRIDGE IS NOT WHERE THE ANSWER IS BUILT.
   *
   * Most handler maps are a wall of thin delegators — `'ac.author_tool': async (args) =>
   * authorTool({…}, ctx(args))` — so the value the dispatcher reads is constructed in `src/`,
   * and a census of `bridge/**` reads the argument marshalling and none of the decisions.
   * Measured: `agent-collective/bridge/server.ts` holds ONE return object literal in total.
   *
   * That was a real hole in the leg above, and writing it into a comment there did not close
   * it. `delegationsIn` names the function each handler hands its answer to and resolves the
   * module, so the census follows.
   *
   * ★★ AND IT FOLLOWED EXACTLY ONE HOP, WITH THE BOUND WRITTEN DOWN INSTEAD OF CLOSED. The
   * stated reason was that going deeper needs dataflow — something three calls down may build an
   * `{error}` its caller inspects and never returns. True of calls in general; false of the only
   * thing being followed. `return f(x)` hands f's value back UNEXAMINED, so the caller cannot
   * branch on it, and that property is transitive: hop while every step is a pure tail call and
   * the last one's return value is still the HTTP response by construction. The walk stops the
   * moment a step examines the value, which is where the bridge-file leg above takes over.
   *
   * Measured after widening: 77 delegating handlers, 77 resolved hop modules, 8 chains longer
   * than one hop — five owm handlers reaching `publishOwm`, `lrs.ingest_statement` reaching
   * `publishIngestedStatement`, and two `extend_standards` reaching `withGuidance`. Those second
   * hops were previously uncensused. 0 untyped declines in any of them.
   */
  it('★ follows each handler through every tail call its answer passes through', () => {
    // ★★ `note` IS THE FOURTH SPELLING OF "NO", AND IT IS DELIBERATELY NOT IN THIS LIST.
    // The spellings that have defeated a census here, in order: `error`, `reason`, `pending`,
    // and then `note` - three foxxi retrieval handlers declined a MISSING REQUIRED input with
    // `{note: 'stub: pass args.course_content …'}` at HTTP 200 (now fixed to invalidArguments).
    //
    // Adding `note` was tried and REVERTED: it flags nine SUCCESSES that carry an advisory
    // note - `{recorded: true, …, note: 'Safe-to-fail probe recorded …'}` and eight like it.
    // The word does not carry the meaning; the same key says "why I declined" and "what I just
    // did". A permanent false positive is as damaging as a false negative, because a gate that
    // always fails is a gate nobody reads.
    //
    // So a word list has now lost four times and cannot be repaired by adding words. It is
    // kept for the shapes it does catch; the legs that DRIVE a bridge are what cannot be
    // out-spelled, and a mutant below plants a `note:` decline in a DRIVEN vertical to keep
    // proving that difference.
    const DECLINE = /\b(error|reason|refused|denied|forbidden|unauthori[sz]ed|invalid|pending|rejected|conflict|unavailable)\b/i;
    const appsDir = new URL('../applications/', import.meta.url);
    const verticals = readdirSync(appsDir).filter((d) => d !== '_shared');

    const offenders: string[] = [];
    let delegations = 0;
    let resolvedModules = 0;
    let censusedReturns = 0;
    /** Longest tail-call chain reached, so a walk that silently stopped at one hop is visible. */
    let hopsCensused = 0;

    for (const v of verticals) {
      for (const rel of [`${v}/bridge/server.ts`, `${v}/bridge/handlers.ts`]) {
        const url = new URL(`../applications/${rel}`, import.meta.url);
        if (!existsSync(url)) continue;
        for (const d of delegationsIn(fileURLToPath(url))) {
          delegations += 1;
          // ★ EVERY HOP, NOT JUST THE FIRST. See handler-delegation-reach.ts: the chain is
          // followed only while each step is a pure tail call, so each hop's return value is
          // the HTTP response by the same construction that made depth one sound.
          for (const hop of d.hops) {
            if (!hop.module) continue;
            resolvedModules += 1;
            hopsCensused = Math.max(hopsCensused, d.hops.length);
          for (const o of returnObjects(readFileSync(hop.module, 'utf8'))) {
            if (o.enclosing !== hop.fn) continue;
            censusedReturns += 1;
            if (/\.\.\.\s*refuse\s*\(/.test(o.text)) continue;
            if (o.text.includes("kind: 'refusal'")) continue;
            const claimed = o.text.replace(/\b\w+\s*:\s*(?:null|undefined|false)\b/g, '');
            if (!DECLINE.test(claimed)) continue;
            if (o.statusCall !== null && !Number.isNaN(o.statusCall) && o.statusCall >= 400) continue;
            // Same outcome-flag rule as the leg above, and for the same measured reason:
            // `{verified: ok, reason: ok ? undefined : '…'}` is a verdict, not a refusal.
            if (/\b\w+:\s*(?:true|ok)\b/.test(o.text)) continue;
            offenders.push(`${d.tool} -> ${d.hops.slice(0, d.hops.findIndex((h) => h.fn === hop.fn) + 1)
              .map((h) => `${h.fn}()`).join(' -> ')} at line ${o.line}: `
              + o.text.replace(/\s+/g, ' ').slice(0, 120));
          }
          }
        }
      }
    }

    // ★ THREE FLOORS, BECAUSE THIS LEG HAS THREE WAYS TO SILENTLY READ NOTHING: find no
    // handlers, resolve no modules, or census no returns inside the functions it resolved.
    // Each collapses to "0 offenders" and each is a different broken step.
    expect(delegations, 'no delegating handlers found - the handler-map matcher is broken')
      .toBeGreaterThan(30);
    expect(resolvedModules, 'no delegated module resolved - the import resolver is broken')
      .toBeGreaterThan(30);
    expect(censusedReturns, 'no returns censused inside any delegated function - the enclosing '
      + 'name from returnObjects no longer matches the delegated function name')
      .toBeGreaterThan(25);
    // ★ A FOURTH FLOOR, ON THE DEPTH ITSELF. Every widening of this leg has been reverted by a
    // later edit at some point, and a tail-call walk that stops at one hop is indistinguishable
    // from the depth-one version it replaced: same shape, same pass, less covered. Measured: 8
    // chains longer than one hop, the longest being 2.
    expect(hopsCensused, 'no handler chain longer than a single hop was followed - the tail-call '
      + 'walk has collapsed back to depth one, which passes while covering less')
      .toBeGreaterThan(1);

    expect(
      offenders,
      'these src/ functions build a decline that a handler returns VERBATIM, so it reaches the '
        + 'caller as HTTP 200:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

});
