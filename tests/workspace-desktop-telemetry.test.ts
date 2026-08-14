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
  readTurns, recordTurn, toolsInTurn, totals, turnsPath, usageFrom, type TurnRecord,
} from '../applications/shared-workspace/desktop/src/telemetry.js';
import { gateDecision, type GateConfig } from '../applications/shared-workspace/desktop/src/gate.js';

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
