/**
 * The witness must be invisible to both peers, and must count consent correctly.
 *
 * ★ WHY THE FIRST HALF MATTERS MORE THAN THE SECOND. A tee that alters what it observes
 * is not a witness, and the ways it can alter a stream are all quiet:
 *
 *   - re-serialising a parsed frame shifts JSON key order and number formatting, and
 *     silently drops ACP's `_meta` passthrough and any field this build predates;
 *   - splitting on '\n' per chunk corrupts every frame that straddles a chunk boundary,
 *     which starts happening the moment a tool call carries a real diff;
 *   - treating unparsable input as invalid turns an observer into a filter;
 *   - an observer that throws takes the session down with it.
 *
 * None of those would show up as an error. They would show up as an agent that behaves
 * subtly differently when the witness is attached, which is the one thing it may never do.
 *
 * ★ WHY THE SECOND HALF IS SUBTLE. The chosen option's KIND is not in the response — the
 * response names an `optionId`, and the kinds are in the REQUEST. So consent is only
 * knowable by correlating on the JSON-RPC id. Get that wrong and you still count requests
 * correctly while learning nothing at all about consent.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { startTee, type Observation } from '../adapters/editor-witness/src/transport.js';
import { createTally, summarise } from '../adapters/editor-witness/src/measure.js';

/**
 * Drive a tee with an ORDERED script and return what each peer received.
 *
 * ★ Ordering is explicit rather than incidental. An earlier version of this helper wrote
 * every editor line and then every agent line, which put each answer on the wire BEFORE
 * the request it answered — impossible in a real session, where the agent asks and the
 * editor replies. That made the correlation tests fail against correct code. A harness
 * that cannot express real ordering cannot test order-dependent behaviour.
 */
type Step = ['editor' | 'agent', string];

async function runScript(
  script: readonly Step[],
  observers: Array<(o: Observation) => void> = [],
  onObserverError?: (e: unknown, o: Observation) => void,
): Promise<{ agentSaw: string; editorSaw: string }> {
  const fromEditor = new PassThrough();
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const toEditor = new PassThrough();

  let agentSaw = '';
  let editorSaw = '';
  toAgent.on('data', (c: Buffer) => { agentSaw += c.toString('utf8'); });
  toEditor.on('data', (c: Buffer) => { editorSaw += c.toString('utf8'); });

  let tick = 0;
  const done = startTee({
    fromEditor, toAgent, fromAgent, toEditor,
    observers,
    ...(onObserverError ? { onObserverError } : {}),
    now: () => ++tick,
  });

  // Yield between steps so each frame is fully observed before the next is written —
  // otherwise the writes coalesce and the ordering under test is not exercised.
  for (const [side, line] of script) {
    (side === 'editor' ? fromEditor : fromAgent).write(line);
    await new Promise((r) => setImmediate(r));
  }
  fromEditor.end();
  fromAgent.end();
  await done;
  return { agentSaw, editorSaw };
}

/** Convenience for the transparency cases, where direction order does not matter. */
const runTee = (
  editorLines: readonly string[],
  agentLines: readonly string[],
  observers: Array<(o: Observation) => void> = [],
  onObserverError?: (e: unknown, o: Observation) => void,
): Promise<{ agentSaw: string; editorSaw: string }> => runScript(
  [...editorLines.map((l): Step => ['editor', l]), ...agentLines.map((l): Step => ['agent', l])],
  observers, onObserverError,
);

describe('the tee is invisible', () => {
  it('forwards frames byte-for-byte, preserving key order and number formatting', async () => {
    // Key order is deliberately NOT alphabetical, and 1.50 / 1e3 would both be rewritten
    // by a JSON round-trip.
    const line = '{"jsonrpc":"2.0","id":7,"method":"x","params":{"z":1,"a":1.50,"b":1e3}}';
    const { agentSaw } = await runTee([line + '\n'], []);
    expect(agentSaw).toBe(line + '\n');
  });

  it('preserves unknown fields, including ACP _meta passthrough', async () => {
    // _meta is reserved by ACP for peers to attach data. A witness that drops it breaks
    // an extension mechanism it does not even know is in use.
    const line = '{"jsonrpc":"2.0","id":1,"method":"session/update",'
      + '"params":{"sessionId":"s","update":{"kind":"edit"},"_meta":{"vendor":{"deep":true}}},'
      + '"futureField":"kept"}';
    const { agentSaw } = await runTee([line + '\n'], []);
    expect(agentSaw).toBe(line + '\n');
  });

  it('reassembles frames split across chunk boundaries', async () => {
    const line = '{"jsonrpc":"2.0","id":2,"method":"session/update","params":{"big":"' + 'x'.repeat(200) + '"}}';
    const chunks = [line.slice(0, 17), line.slice(17, 90), line.slice(90) + '\n'];
    const { agentSaw } = await runTee(chunks, []);
    expect(agentSaw).toBe(line + '\n');
  });

  it('forwards a final frame that has no trailing newline', async () => {
    const line = '{"jsonrpc":"2.0","id":3,"method":"tail"}';
    const { agentSaw } = await runTee([line], []);
    expect(agentSaw).toBe(line + '\n');
  });

  it('forwards unparsable input rather than filtering it', async () => {
    // Malformed to us may be fine to them. We are not a validator.
    const junk = 'not json at all';
    const { agentSaw } = await runTee([junk + '\n'], []);
    expect(agentSaw).toBe(junk + '\n');
  });

  it('survives an observer that throws, and still forwards', async () => {
    const errors: unknown[] = [];
    const line = '{"jsonrpc":"2.0","id":4,"method":"x"}';
    const { agentSaw } = await runTee(
      [line + '\n'], [],
      [() => { throw new Error('observer exploded'); }],
      (e) => errors.push(e),
    );
    expect(agentSaw).toBe(line + '\n');
    expect(errors).toHaveLength(1);
  });

  it('carries both directions independently', async () => {
    const up = '{"jsonrpc":"2.0","id":5,"method":"up"}';
    const down = '{"jsonrpc":"2.0","id":6,"result":{"ok":true}}';
    const { agentSaw, editorSaw } = await runTee([up + '\n'], [down + '\n']);
    expect(agentSaw).toBe(up + '\n');
    expect(editorSaw).toBe(down + '\n');
  });
});

describe('consent is counted by correlating the answer back to the request', () => {
  /** A permission request (agent->editor) and the human's answer (editor->agent). */
  const req = (id: number, toolKind: string) => JSON.stringify({
    jsonrpc: '2.0', id, method: 'session/request_permission',
    params: {
      sessionId: 'sess-1',
      toolCall: { toolCallId: `call_${id}`, kind: toolKind, title: 'irrelevant' },
      options: [
        { optionId: 'a1', kind: 'allow_once' },
        { optionId: 'aa', kind: 'allow_always' },
        { optionId: 'r1', kind: 'reject_once' },
        { optionId: 'ra', kind: 'reject_always' },
      ],
    },
  });
  const ans = (id: number, optionId: string) => JSON.stringify({
    jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId } },
  });

  it('resolves the chosen optionId to its kind, which lives only in the request', async () => {
    const { observer, finish } = createTally();
    await runScript([
      ['agent',  req(1, 'edit') + '\n'],       // the agent asks
      ['editor', ans(1, 'ra') + '\n'],         // the human answers
      ['agent',  req(2, 'execute') + '\n'],
      ['editor', ans(2, 'aa') + '\n'],
    ], [observer]);
    const t = finish();
    expect(t.permissionRequests).toBe(2);
    expect(t.outcomeByKind).toEqual({ reject_always: 1, allow_always: 1 });
  });

  it('records WHICH tool kinds received a standing denial — the number that decides the thesis', async () => {
    const { observer, finish } = createTally();
    await runScript([
      ['agent',  req(1, 'execute') + '\n'],
      ['editor', ans(1, 'ra') + '\n'],
      ['agent',  req(2, 'edit') + '\n'],
      ['editor', ans(2, 'a1') + '\n'],
    ], [observer]);
    const t = finish();
    // Only the always-scoped denial creates a standing constraint. A reject_once is a
    // UI event; an allow_once is not a denial at all.
    expect(t.deniedAlwaysKinds).toEqual(['execute']);
  });

  it('counts cancellations separately from denials — silence is not consent', async () => {
    const { observer, finish } = createTally();
    const cancelled = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { outcome: { outcome: 'cancelled' } } });
    await runScript([
      ['agent',  req(1, 'edit') + '\n'],
      ['editor', cancelled + '\n'],
    ], [observer]);
    const t = finish();
    expect(t.cancelled).toBe(1);
    expect(t.outcomeByKind).toEqual({});
    expect(t.deniedAlwaysKinds).toEqual([]);
  });

  it('reports requests left unanswered when the session ends', async () => {
    const { observer, finish } = createTally();
    await runTee([], [req(1, 'edit') + '\n'], [observer]);
    expect(finish().unanswered).toBe(1);
  });

  it('does not attribute an answer to the wrong request', async () => {
    const { observer, finish } = createTally();
    // Answer id 2 arrives first; ids must not be confused.
    await runScript([
      ['agent',  req(1, 'edit') + '\n'],
      ['agent',  req(2, 'execute') + '\n'],
      ['editor', ans(2, 'ra') + '\n'],        // answers id 2, leaving id 1 open
    ], [observer]);
    const t = finish();
    expect(t.deniedAlwaysKinds).toEqual(['execute']);   // not 'edit'
    expect(t.unanswered).toBe(1);
  });

  it('states plainly when the evidence does not support the thesis', async () => {
    // This fixture DOES offer reject_always; the answer was allow_always. So the deny set
    // is empty by a real choice, and the thesis is genuinely unsupported.
    const { observer, finish } = createTally();
    await runTee([ans(1, 'aa') + '\n'], [req(1, 'edit') + '\n'], [observer]);
    const out = summarise(finish());
    expect(out).toMatch(/WAS offered/);
    expect(out).toMatch(/genuinely unsupported/);
  });

  /**
   * ★ THE DISTINCTION THE INSTRUMENT EXISTS TO PROTECT.
   *
   * Zero always-scoped denials means "developers declined" only if the option was ON THE
   * MENU. The production ACP agent (@zed-industries/claude-code-acp) offers exactly
   * allow_always / allow_once / reject_once and NEVER constructs reject_always — verified
   * against its own dist and against a live session through this tee. Reporting that as
   * "the thesis is unsupported" states a conclusion the run did not earn: nobody could
   * have chosen a button that was never rendered.
   */
  const realWorldReq = (id: number, toolKind: string) => JSON.stringify({
    jsonrpc: '2.0', id, method: 'session/request_permission',
    params: {
      sessionId: 'sess-rw',
      toolCall: { toolCallId: `call_${id}`, kind: toolKind, title: 'irrelevant' },
      options: [
        { optionId: 'allow_always', kind: 'allow_always' },
        { optionId: 'allow', kind: 'allow_once' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    },
  });

  it('reports UNTESTED, not unsupported, when reject_always was never offered', async () => {
    const { observer, finish } = createTally();
    await runTee([ans(1, 'reject') + '\n'], [realWorldReq(1, 'edit') + '\n'], [observer]);
    const t = finish();
    expect(t.offeredKinds['reject_always']).toBeUndefined();
    expect(t.offeredKinds['allow_always']).toBe(1);

    const out = summarise(t);
    expect(out).toMatch(/UNTESTED/);
    expect(out).not.toMatch(/genuinely unsupported/);
    // And it must name the asymmetry, because that is the actual finding.
    expect(out).toMatch(/allow_always` WAS offered/);
  });

  /**
   * ★ THE MODE DECIDES WHO ANSWERED.
   *
   * The production agent advertises acceptEdits ("Auto-accept file edit operations"),
   * dontAsk ("Don’t prompt for permissions, deny if not pre-approved") and
   * bypassPermissions ("Bypass all permission checks"), and announces a switch as
   * session/update with sessionUpdate: "current_mode_update". That frame carries no
   * `kind`, so the original handler dropped it — leaving a tally in which forty human
   * decisions and forty agent auto-accepts look identical.
   */
  // A mode change is a NOTIFICATION: no id, and no `kind` for a naive handler to find.
  const modeUpdate = (mode: string) => JSON.stringify({
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 'sess-1', update: { sessionUpdate: 'current_mode_update', currentModeId: mode } },
  });

  it('attributes each permission request to the mode in force at the time', async () => {
    const { observer, finish } = createTally();
    await runScript([
      ['agent',  req(1, 'edit') + '\n'],
      ['editor', ans(1, 'r1') + '\n'],
      ['agent',  modeUpdate('acceptEdits') + '\n'],
      ['agent',  req(2, 'edit') + '\n'],
      ['editor', ans(2, 'a1') + '\n'],
    ], [observer]);
    const t = finish();
    expect(t.modeRequests).toEqual({ default: 1, acceptEdits: 1 });
    expect(t.modeTimeline).toEqual(['acceptEdits']);
  });

  it('warns that auto-answered outcomes are not consent data', async () => {
    const { observer, finish } = createTally();
    await runScript([
      ['agent',  modeUpdate('bypassPermissions') + '\n'],
      ['agent',  req(1, 'edit') + '\n'],
      ['editor', ans(1, 'a1') + '\n'],
    ], [observer]);
    const out = summarise(finish());
    expect(out).toMatch(/not consent data/);
  });

  it('does not warn when every request was answered by a human', async () => {
    const { observer, finish } = createTally();
    await runTee([ans(1, 'r1') + '\n'], [req(1, 'edit') + '\n'], [observer]);
    expect(summarise(finish())).not.toMatch(/not consent data/);
  });

  /**
   * ★ TRAP (b) — an "allow_always" that is really a SESSION MODE SWITCH.
   *
   * Verbatim from the production agent's ExitPlanMode prompt: the allow_always option's
   * optionId is "acceptEdits", a MODE, and choosing it grants nothing about the tool being
   * asked about. Counted naively it invents a grant and hides a mode change that
   * reinterprets every answer after it.
   */
  const exitPlanReq = (id: number) => JSON.stringify({
    jsonrpc: '2.0', id, method: 'session/request_permission',
    params: {
      sessionId: 'sess-1',
      toolCall: { toolCallId: `call_${id}`, kind: 'other', title: 'ExitPlanMode' },
      options: [
        { optionId: 'acceptEdits', kind: 'allow_always', name: 'Yes, and auto-accept edits' },
        { optionId: 'default', kind: 'allow_once', name: 'Yes, and manually approve edits' },
        { optionId: 'plan', kind: 'reject_once', name: 'No, keep planning' },
      ],
    },
  });

  it('does not count a mode switch as an always-allow grant', async () => {
    const { observer, finish } = createTally();
    await runScript([
      ['agent',  exitPlanReq(1) + '\n'],
      ['editor', ans(1, 'acceptEdits') + '\n'],
      // The agent confirms it was a mode change by announcing it. That frame is the
      // evidence — the reclassification is observed, not inferred from a vendor list.
      ['agent',  modeUpdate('acceptEdits') + '\n'],
    ], [observer]);
    const t = finish();
    expect(t.modeSwitchesMistakableForGrants).toHaveLength(1);
    expect(t.outcomeByKind['allow_always'], 'the phantom grant must be removed').toBeUndefined();
    expect(t.standingGrantsByTool).toEqual({});
    expect(summarise(t)).toMatch(/SESSION MODE SWITCHES/);
  });

  it('still counts a REAL always-allow that is not followed by a mode change', async () => {
    // The mirror case: without this, the fix could just delete every allow_always.
    const { observer, finish } = createTally();
    await runScript([
      ['agent',  req(1, 'edit') + '\n'],
      ['editor', ans(1, 'aa') + '\n'],
    ], [observer]);
    const t = finish();
    expect(t.outcomeByKind['allow_always']).toBe(1);
    expect(t.standingGrantsByTool).toEqual({ edit: 1 });
    expect(t.modeSwitchesMistakableForGrants).toHaveLength(0);
  });

  /**
   * ★ TRAP (a) — a standing grant is not a frequency. allow_always installs a session rule,
   * so each tool can contribute at most one, and the total is a decreasing function of how
   * early the grant happened.
   */
  it('counts standing grants per TOOL, and says so', async () => {
    const { observer, finish } = createTally();
    await runScript([
      ['agent',  req(1, 'edit') + '\n'],
      ['editor', ans(1, 'aa') + '\n'],
      ['agent',  req(2, 'execute') + '\n'],
      ['editor', ans(2, 'aa') + '\n'],
    ], [observer]);
    const t = finish();
    expect(t.standingGrantsByTool).toEqual({ edit: 1, execute: 1 });
    expect(summarise(t)).toMatch(/2 TOOL\(S\) placed under a rule/);
    expect(summarise(t)).toMatch(/not a count of how often you allowed/);
  });

  it('flags a tool that asks again despite a standing grant', async () => {
    // If the rule did not stick, the count means something different — say so rather
    // than quietly reporting a tool count that is really a frequency.
    const { observer, finish } = createTally();
    await runScript([
      ['agent',  req(1, 'edit') + '\n'],
      ['editor', ans(1, 'aa') + '\n'],
      ['agent',  req(2, 'edit') + '\n'],
      ['editor', ans(2, 'a1') + '\n'],
    ], [observer]);
    const t = finish();
    expect(t.asksAfterStandingGrant).toBe(1);
    expect(t.standingGrantsByTool).toEqual({ edit: 1 });
    expect(summarise(t)).toMatch(/the rule did not stick/);
  });

  it('counts the menu per option, so an unoffered kind is absent rather than zero', async () => {
    const { observer, finish } = createTally();
    await runTee([ans(1, 'r1') + '\n'], [req(1, 'edit') + '\n'], [observer]);
    const t = finish();
    // All four offered once by the four-kind fixture.
    expect(t.offeredKinds).toEqual({
      allow_once: 1, allow_always: 1, reject_once: 1, reject_always: 1,
    });
  });
});
