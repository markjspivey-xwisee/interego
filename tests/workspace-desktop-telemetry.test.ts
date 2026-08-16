/**
 * WHAT A TURN COST, AND WHETHER THE NUMBERS ARE THE TOOLS' OWN.
 *
 * Asked for: "telemetry — input/output LLM tokens, turns taken, tool calls, user id".
 *
 * ★ THE POINT OF THESE TESTS IS THAT NOTHING IS INVENTED. `claude -p --output-format json` already
 * reports usage, turn count, cost and a session id (measured with `tools/probe-turn-usage.ts`
 * against a real turn), and the permission gate already writes one audit line per tool call. So
 * every figure has a source, and what is pinned below is that the source is read faithfully and
 * joined correctly — not that some arithmetic is right.
 */

import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findTurn, measuredFacts, readTurns, recordTurn, startedAt, toolsInTurn, totals, turnsPath,
  usageFrom, type TurnRecord,
} from '../applications/shared-workspace/desktop/src/telemetry.js';
import { gateDecision, type GateConfig } from '../applications/shared-workspace/desktop/src/gate.js';
import { decimalLiteral, turnTurtle } from '../packages/workspace-client/src/turnrecord.js';
import { validateAgainstShape } from '@interego/core';

const RELAY = 'https://relay.interego.xwisee.com';
const POD = 'u-eth-8f3b8e939600';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'iego-tel-'));

/** A real reply shape, copied from what the CLI actually returned to `probe-turn-usage.ts`. */
const REAL_REPLY = {
  type: 'result', is_error: false, duration_ms: 2042, ttft_ms: 2030,
  num_turns: 1, result: 'PONG', session_id: 'b009ecd2-3cae-4fdf-96a7-43e98ee422a3',
  total_cost_usd: 0.03056845,
  usage: {
    input_tokens: 3, cache_creation_input_tokens: 6363, cache_read_input_tokens: 20294,
    output_tokens: 6, service_tier: 'standard',
  },
  modelUsage: {
    'claude-haiku-4-5-20251001': { inputTokens: 445, outputTokens: 15, cacheReadInputTokens: 0 },
  },
};

describe('the numbers come from the tools, not from this app', () => {
  it('★ reads every field the CLI actually reports', () => {
    const u = usageFrom(REAL_REPLY);
    expect(u.inputTokens).toBe(3);
    expect(u.outputTokens).toBe(6);
    expect(u.cacheReadTokens).toBe(20294);
    expect(u.cacheCreationTokens).toBe(6363);
    expect(u.numTurns).toBe(1);
    expect(u.costUsd).toBeCloseTo(0.03056845, 8);
    expect(u.ttftMs).toBe(2030);
    expect(u.sessionId).toBe('b009ecd2-3cae-4fdf-96a7-43e98ee422a3');
    expect(u.models['claude-haiku-4-5-20251001']).toBe(460);
  });

  it('★ an unreadable reply produces zeros, not an exception', () => {
    // This parses ANOTHER PROGRAM'S output. A CLI upgrade that renames a field must cost a number
    // in a report, never a turn — telemetry that can break the thing it measures is a liability.
    for (const junk of [null, undefined, 'not an object', {}, { usage: 'nonsense' }, { usage: { input_tokens: 'x' } }]) {
      const u = usageFrom(junk);
      expect(u.inputTokens).toBe(0);
      expect(u.costUsd).toBe(0);
    }
  });
});

describe('★★ tool calls are joined to a turn by id, not by time', () => {
  const auditLine = (userData: string, turnId: string, tool: string, decision: string): void => {
    appendFileSync(join(userData, 'agent-audit.jsonl'),
      JSON.stringify({ atIso: '2026-08-13T22:00:00Z', turnId, tool, decision, why: '', input: {} }) + '\n', 'utf8');
  };

  it('counts only this turn\'s calls, even while another delegate is answering', () => {
    /**
     * ★ THE WHOLE REASON THE JOIN KEY EXISTS. Two delegates answering at once is the ordinary case
     * in a shared workspace, and their audit lines interleave in one file. A time-window join
     * would bill one agent for the other's tool calls — a wrong number attributed to a named
     * person, which is worse than no number at all.
     */
    const ud = tmp();
    auditLine(ud, 'turn-A', 'Bash', 'allow');
    auditLine(ud, 'turn-B', 'Bash', 'allow');
    auditLine(ud, 'turn-A', 'Read', 'ask');
    auditLine(ud, 'turn-B', 'Write', 'deny');
    auditLine(ud, 'turn-A', 'Bash', 'granted');

    const a = toolsInTurn(ud, 'turn-A');
    expect(a.toolCalls).toBe(3);
    expect(a.allowed).toBe(2);          // allow + granted
    expect(a.asked).toBe(1);
    expect(a.denied).toBe(0);
    expect(a.tools).toEqual({ Bash: 2, Read: 1 });

    const b = toolsInTurn(ud, 'turn-B');
    expect(b.toolCalls).toBe(2);
    expect(b.denied).toBe(1);
    rmSync(ud, { recursive: true, force: true });
  });

  it('★ and the GATE really does stamp the id — the two halves must agree', () => {
    // The join only works if the writer writes what the reader looks for. These are different
    // files in different processes, so this drives the real `gateDecision` rather than
    // hand-writing a line in the shape the reader happens to want.
    const root = tmp();
    const cfg: GateConfig = {
      policy: { workspace: join(root, 'ws'), nominated: [], grants: [] },
      requestsDir: join(root, 'req'),
      auditPath: join(root, 'agent-audit.jsonl'),
      context: { agentName: 'Claude Desktop', askedBy: 'goldenfleece', channel: '#house', turnId: 'turn-Z' },
    };
    gateDecision(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: join(root, 'ws') }),
      cfg, '2026-08-13T22:00:00Z');
    const counted = toolsInTurn(root, 'turn-Z');
    expect(counted.toolCalls).toBe(1);
    expect(counted.allowed).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('an audit line from before the id existed is skipped, not guessed at', () => {
    const ud = tmp();
    appendFileSync(join(ud, 'agent-audit.jsonl'),
      JSON.stringify({ atIso: '2026-08-13T21:00:00Z', tool: 'Bash', decision: 'allow' }) + '\n', 'utf8');
    expect(toolsInTurn(ud, 'turn-A').toolCalls).toBe(0);
    rmSync(ud, { recursive: true, force: true });
  });
});

describe('the record on disk', () => {
  const rec = (over: Partial<TurnRecord> = {}): TurnRecord => ({
    turnId: 't1', atIso: '2026-08-13T22:00:00Z', agentId: '0xabc', agentName: 'Claude Desktop',
    askedBy: 'goldenfleece', channel: '#house', ok: true, ms: 2042,
    inputTokens: 3, outputTokens: 6, cacheReadTokens: 20294, cacheCreationTokens: 6363,
    numTurns: 1, costUsd: 0.03, ttftMs: 2030, sessionId: 's1', models: {},
    toolCalls: 3, allowed: 2, asked: 1, denied: 0, tools: { Bash: 2, Read: 1 }, ...over,
  });

  it('round-trips, newest first', () => {
    const ud = tmp();
    mkdirSync(ud, { recursive: true });
    recordTurn(ud, rec({ turnId: 'one' }));
    recordTurn(ud, rec({ turnId: 'two' }));
    const back = readTurns(ud);
    expect(back.map((t) => t.turnId)).toEqual(['two', 'one']);
    rmSync(ud, { recursive: true, force: true });
  });

  it('★ is bounded, because this file only ever grows', () => {
    // A `get_pod_status` tool in this same system once returned 56 MB and broke every client that
    // called it. An unbounded reader is that fault waiting for a busy week.
    const ud = tmp();
    mkdirSync(ud, { recursive: true });
    for (let i = 0; i < 50; i++) recordTurn(ud, rec({ turnId: 'n' + i }));
    expect(readTurns(ud, 10)).toHaveLength(10);
    rmSync(ud, { recursive: true, force: true });
  });

  it('★ a torn last line does not hide the turns above it', () => {
    const ud = tmp();
    mkdirSync(ud, { recursive: true });
    recordTurn(ud, rec({ turnId: 'good' }));
    appendFileSync(turnsPath(ud), '{"turnId":"tor', 'utf8');
    expect(readTurns(ud).map((t) => t.turnId)).toEqual(['good']);
    rmSync(ud, { recursive: true, force: true });
  });

  it('★ and no message text is stored — a token count, not a transcript', () => {
    // What was said belongs on the workspace record, where the people in the channel can see it.
    // A second copy in a telemetry file is a privacy surface nobody asked for and nobody audits.
    const ud = tmp();
    mkdirSync(ud, { recursive: true });
    recordTurn(ud, rec());
    const raw = readFileSync(turnsPath(ud), 'utf8');
    expect(raw).not.toContain('prompt');
    expect(raw).not.toContain('result');
    expect(raw).not.toContain('text');
    rmSync(ud, { recursive: true, force: true });
  });
});

describe('★★ the cost joined to the outcome, which is what gets published', () => {
  /**
   * ── WHY THIS BLOCK EXISTS ──────────────────────────────────────────────────
   *
   * Measured live: the first `ieh:AgentTurn` published to the pod carried the agent, the time, the
   * person, the channel and the outcome — and not one number. The cost is recorded in `agent:think`
   * and the outcome is decided in the RENDERER, and nothing carried the id between them, so the
   * published record could never be joined to what the turn actually spent.
   */
  const rec = (over: Partial<TurnRecord> = {}): TurnRecord => ({
    turnId: 't1', atIso: '2026-08-16T04:27:08.377Z', startedIso: '2026-08-16T04:26:45.934Z',
    agentId: 'did:web:x', agentName: 'delegate',
    askedBy: 'goldenfleece', channel: '#house', ok: true, ms: 22443,
    inputTokens: 7, outputTokens: 774, cacheReadTokens: 95002, cacheCreationTokens: 13995,
    numTurns: 3, costUsd: 0.10098685, ttftMs: 2030, sessionId: 's1',
    models: { 'claude-haiku-4-5-20251001': 460, 'claude-sonnet-4-6': 8800 },
    toolCalls: 2, allowed: 2, asked: 0, denied: 0, tools: { Bash: 1, Read: 1 }, ...over,
  });

  it('finds the turn by id, with another delegate\'s turns interleaved around it', () => {
    const ud = tmp();
    mkdirSync(ud, { recursive: true });
    recordTurn(ud, rec({ turnId: 'other-A', costUsd: 9 }));
    recordTurn(ud, rec({ turnId: 'mine', costUsd: 0.5 }));
    recordTurn(ud, rec({ turnId: 'other-B', costUsd: 9 }));
    expect(findTurn(ud, 'mine')?.costUsd).toBe(0.5);
    rmSync(ud, { recursive: true, force: true });
  });

  it('★★ an empty id matches nothing — the renderer sent one for weeks', () => {
    /**
     * A lenient lookup would have attached the newest turn's cost to whatever asked. A real number
     * published under the wrong turn is worse than an absent one: it reads as evidence.
     */
    const ud = tmp();
    mkdirSync(ud, { recursive: true });
    recordTurn(ud, rec({ turnId: 'mine' }));
    expect(findTurn(ud, '')).toBeNull();
    expect(findTurn(ud, 'never-ran')).toBeNull();
    expect(measuredFacts(findTurn(ud, ''))).toEqual({});
    rmSync(ud, { recursive: true, force: true });
  });

  it('★★ the start time survives the join — a duration needs an axis that agrees with it', () => {
    /**
     * `atIso` is written when the turn ENDS. Published as `prov:startedAtTime` next to
     * `ieh:elapsedMs`, it described a turn that finished 22 seconds before it began. The start is
     * stamped separately, before anything runs, and that is the one the graph must carry.
     */
    const ud = tmp();
    mkdirSync(ud, { recursive: true });
    recordTurn(ud, rec({ startedIso: '2026-08-16T04:26:45.934Z', atIso: '2026-08-16T04:27:08.377Z' }));
    const back = findTurn(ud, 't1');
    expect(back?.startedIso).toBe('2026-08-16T04:26:45.934Z');
    expect(Date.parse(back?.atIso as string) - Date.parse(back?.startedIso as string))
      .toBeCloseTo(rec().ms, -2);
    rmSync(ud, { recursive: true, force: true });
  });

  it('★★ a zero the CLI never reported is omitted; a zero WE counted is published', () => {
    /**
     * `usageFrom` collapses an absent field to 0 by design, so on this side the two are the same
     * value. Publishing it would assert a turn that ran cost nothing — wrong in the direction
     * nobody audits. `toolCallCount` has a different provenance: we count it ourselves over lines
     * we read, and "called no tools" is a measurement worth keeping.
     */
    const m = measuredFacts(rec({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsd: 0, numTurns: 0, ms: 0, toolCalls: 0, models: {},
    }));
    expect(m).toEqual({ toolCallCount: 0 });
  });

  it('carries every number that WAS reported', () => {
    const m = measuredFacts(rec());
    expect(m).toEqual({
      inputTokens: 7, outputTokens: 774, cacheReadTokens: 95002, cacheCreationTokens: 13995,
      costUsd: 0.10098685, elapsedMs: 22443, providerTurns: 3, toolCallCount: 2,
      models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
    });
  });

  it('★★ and those fields survive into the Turtle — a spread drops a misnamed key silently', () => {
    /**
     * `...measuredFacts(...)` into an `AgentTurnFacts` literal gets NO excess-property check from
     * TypeScript, so a key renamed on one side and not the other compiles, publishes, and emits
     * nothing. The only way to know the join reaches the graph is to look at the graph.
     */
    const ttl = turnTurtle('https://relay.interego.xwisee.com', 'u-eth-8f3b8e939600', {
      turnId: 't1', agentId: 'did:web:x', atIso: '2026-08-16T04:26:45.934Z', outcome: 'Posted',
      ...measuredFacts(rec()),
    });
    expect(ttl).toContain('ieh:costUsd "0.10098685"^^xsd:decimal');
    expect(ttl).toContain('ieh:inputTokens "7"^^xsd:integer');
    expect(ttl).toContain('ieh:outputTokens "774"^^xsd:integer');
    expect(ttl).toContain('ieh:cacheReadTokens "95002"^^xsd:integer');
    expect(ttl).toContain('ieh:cacheCreationTokens "13995"^^xsd:integer');
    expect(ttl).toContain('ieh:elapsedMs "22443"^^xsd:integer');
    expect(ttl).toContain('ieh:providerTurns "3"^^xsd:integer');
    expect(ttl).toContain('ieh:toolCallCount "2"^^xsd:integer');
    expect(ttl).toContain('ieh:turnModel "claude-sonnet-4-6"');
  });

  it('★ a model name is a literal, and cannot close the statement it sits in', () => {
    // The model list comes from another program's JSON, keyed by whatever it chose to call itself.
    const ttl = turnTurtle('https://relay.interego.xwisee.com', 'u-eth-8f3b8e939600', {
      turnId: 't1', agentId: 'did:web:x', atIso: '2026-08-16T04:26:45.934Z', outcome: 'Posted',
      ...measuredFacts(rec({ models: { 'evil" ; ieh:costUsd "0"^^xsd:decimal ; ieh:x "': 1 } })),
    });
    // The quote is escaped, so the injected text stays INSIDE the literal...
    expect(ttl).toContain('\\"');
    // ...and the only `ieh:costUsd` STATEMENT is the real one. Counting occurrences would pass on
    // the injected copy; only the line position distinguishes a statement from quoted text.
    const statements = ttl.split('\n').filter((l) => l.trimStart().startsWith('ieh:costUsd'));
    expect(statements).toEqual(['  ieh:costUsd "0.10098685"^^xsd:decimal ;']);
    expect(ttl.split('\n').some((l) => l.trimStart().startsWith('ieh:x'))).toBe(false);
  });
});

describe('★★ what an adversarial review found, pinned so it stays found', () => {
  /**
   * Six reviewers were told to REFUTE the join above rather than confirm it. Everything in this
   * block is a defect they produced that the green suite had not: each one publishes either a false
   * triple or an ill-formed one, and an ill-formed one loses the WHOLE record, because the relay
   * validates `conforms_to_shapes` before the pod write.
   */
  const rec = (over: Partial<TurnRecord> = {}): TurnRecord => ({
    turnId: 't1', atIso: '2026-08-16T04:27:08.377Z', startedIso: '2026-08-16T04:26:45.934Z',
    agentId: 'did:web:x', agentName: 'delegate', askedBy: 'g', channel: '#house', ok: true, ms: 22443,
    inputTokens: 7, outputTokens: 774, cacheReadTokens: 0, cacheCreationTokens: 0,
    numTurns: 3, costUsd: 0.1, ttftMs: 2030, sessionId: 's1', models: {},
    toolCalls: 2, allowed: 2, asked: 0, denied: 0, tools: {}, ...over,
  });

  it('★★ a sub-microdollar cost is a plain decimal, not "1e-7"', () => {
    /**
     * xsd:decimal has no exponent notation — that is xsd:double. `String(1e-7)` is "1e-7", which is
     * outside the lexical space, so `sh:datatype xsd:decimal` rejects it and the relay refuses the
     * write. A cheap cached turn is exactly when a cost this small occurs.
     */
    expect(decimalLiteral(1e-7)).toBe('0.0000001');
    expect(decimalLiteral(1.2345e-7)).toBe('0.00000012345');
    expect(decimalLiteral(-2.5e-8)).toBe('-0.000000025');
    expect(decimalLiteral(1e21)).toBe('1000000000000000000000');
    // Already plain: kept exactly as JS renders it, so no precision is invented.
    expect(decimalLiteral(0.1)).toBe('0.1');
    expect(decimalLiteral(0.10098685)).toBe('0.10098685');
    expect(decimalLiteral(3e-6)).toBe('0.000003');
    for (const v of [1e-7, 1.2345e-7, 2.5e-8, 1e-21, 0.1, 123.456]) {
      expect(decimalLiteral(v), String(v)).not.toMatch(/e/i);
      expect(Number(decimalLiteral(v))).toBeCloseTo(v, 30);
    }
  });

  it('★★ and it conforms as published — the shape is what would have refused it', () => {
    const ttl = turnTurtle(RELAY, POD, {
      turnId: 't1', agentId: 'did:web:x', atIso: '2026-08-16T04:26:45.934Z', outcome: 'Posted',
      ...measuredFacts(rec({ costUsd: 1e-7 })),
    });
    expect(ttl).toContain('ieh:costUsd "0.0000001"^^xsd:decimal');
    const shapes = readFileSync(join(process.cwd(), 'docs/ns/harness-shapes.ttl'), 'utf8')
      + '\n' + readFileSync(join(process.cwd(), 'docs/ns/harness.ttl'), 'utf8');
    const r = validateAgainstShape(ttl, shapes, { entailment: 'rdfs' });
    expect(r.conforms, r.results.map((x) => String(x.message)).join('; ')).toBe(true);
  });

  it('★★ no duration is published without a start it composes with', () => {
    // An old record has ms but no startedIso; the publisher then falls back to "now" for
    // prov:startedAtTime, and a real elapsedMs beside a fabricated start is the "finished before it
    // began" graph again.
    const old = measuredFacts(rec({ startedIso: undefined }));
    expect(old.elapsedMs).toBeUndefined();
    expect(old.costUsd).toBe(0.1);            // the rest of the record still publishes
    expect(measuredFacts(rec()).elapsedMs).toBe(22443);
  });

  it('★★ a startedIso that is empty or unparseable is refused, not published', () => {
    // `??` only rejects null and undefined, so '' reached the graph as ""^^xsd:dateTime — ill-typed,
    // refused by the shape, and the whole record lost.
    expect(startedAt(rec({ startedIso: '' }))).toBeNull();
    expect(startedAt(rec({ startedIso: 'yesterday' }))).toBeNull();
    expect(startedAt(rec({ startedIso: undefined }))).toBeNull();
    expect(startedAt(null)).toBeNull();
    expect(startedAt(rec())).toBe('2026-08-16T04:26:45.934Z');
  });

  it('★★ a models value that is not an object publishes no model names', () => {
    // Object.keys('haiku') is ['0','1','2','3','4'] — five models that never existed, permanently.
    for (const bad of ['haiku', 42, ['a', 'b'], null]) {
      const m = measuredFacts(rec({ models: bad as unknown as Record<string, number> }));
      expect(m.models, JSON.stringify(bad)).toBeUndefined();
    }
    expect(measuredFacts(rec({ models: { haiku: 1 } })).models).toEqual(['haiku']);
  });

  it('★★ the lookup reads a bounded tail, not the whole file', () => {
    /**
     * `limit` bounded only the PARSE. This runs on the Electron main process after every turn, and
     * the file only grows — a `get_pod_status` in this same system once returned 56 MB and broke
     * every client that called it.
     */
    const ud = tmp();
    mkdirSync(ud, { recursive: true });
    // A record far outside the tail window, then the one being looked for.
    recordTurn(ud, rec({ turnId: 'ancient' }));
    appendFileSync(turnsPath(ud), 'x'.repeat(600 * 1024) + '\n', 'utf8');
    recordTurn(ud, rec({ turnId: 'recent' }));
    expect(findTurn(ud, 'recent')?.turnId).toBe('recent');
    // Beyond the window it is simply not found — which is correct, and is not an exception.
    expect(findTurn(ud, 'ancient')).toBeNull();
    rmSync(ud, { recursive: true, force: true });
  });
});

describe('the summary a person actually looks at', () => {
  it('attributes tokens to the agent AND to whoever asked', () => {
    // ★ Who ASKED, not only which agent answered. A bill nobody can attribute to a person is a
    // number; attributed, it is a conversation about who is driving the machine and how hard.
    const base = {
      atIso: '2026-08-13T22:00:00Z', channel: '#house', ok: true, ms: 1, cacheReadTokens: 0,
      cacheCreationTokens: 0, numTurns: 1, ttftMs: 1, sessionId: 's', models: {},
      allowed: 0, denied: 0, tools: {},
    };
    const t = totals([
      { ...base, turnId: 'a', agentId: '1', agentName: 'Claude Desktop', askedBy: 'mark', inputTokens: 100, outputTokens: 10, costUsd: 0.01, toolCalls: 2, asked: 1 },
      { ...base, turnId: 'b', agentId: '1', agentName: 'Claude Desktop', askedBy: 'brother', inputTokens: 50, outputTokens: 5, costUsd: 0.02, toolCalls: 1, asked: 0 },
    ] as TurnRecord[]);
    expect(t.turns).toBe(2);
    expect(t.inputTokens).toBe(150);
    expect(t.outputTokens).toBe(15);
    expect(t.toolCalls).toBe(3);
    expect(t.asked).toBe(1);
    expect(t.costUsd).toBeCloseTo(0.03, 6);
    expect(t.byAgent['Claude Desktop']).toBe(165);
    expect(t.byAsker['mark']).toBe(110);
    expect(t.byAsker['brother']).toBe(55);
  });
});
