/**
 * WHAT A TURN COST, WHO CAUSED IT, AND WHAT IT DID.
 *
 * ── ★ THE MEASUREMENTS ALREADY EXISTED; THEY WERE BEING THROWN AWAY ──────────
 *
 * Asked for: "telemetry — input/output LLM tokens, turns taken, tool calls, user id". The first
 * question was not how to build that but what the tools already report, and MEASURED with
 * `tools/probe-turn-usage.ts` against a real turn, `claude -p --output-format json` returns:
 *
 *     usage.input_tokens · output_tokens · cache_read_input_tokens · cache_creation_input_tokens
 *     num_turns · total_cost_usd · duration_ms · ttft_ms · session_id
 *     modelUsage (a per-model breakdown) · permission_denials
 *
 * The app read exactly one field out of that reply — `result` — and discarded the rest. And the
 * permission gate has been writing one audit line per tool call since it shipped. So this is a
 * REPORTING gap, not a measurement problem, and nothing here invents a number: every field below
 * is copied from something the CLI or the gate already produced.
 *
 * ── WHAT IS JOINED, AND HOW ──────────────────────────────────────────────────
 *
 * A turn's cost comes from the CLI; what the turn DID comes from the gate, which runs in a
 * different process per tool call and cannot talk back. They are joined by a `turnId` the app
 * mints before the turn and writes into the gate's config, so every audit line carries it. That is
 * an exact join rather than a guess from timestamps — two delegates answering at once would
 * interleave, and attributing another agent's tool calls to this one's bill would be worse than
 * reporting nothing.
 *
 * ── ★ WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * It is a LOCAL record, on the machine that ran the turn, in the same directory as the audit trail
 * and the grants — see the note in `permission.ts` about why enforcement is local. Nothing is sent
 * anywhere. "user id" here is the identity the substrate already uses: the delegate's DID and the
 * human who addressed it, both of which are already on the public record for the message that
 * caused the turn. No new identifier is minted, and no message text is stored — a token count and
 * a tool name, not a transcript.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One turn, as it will be written to disk. Every field comes from a tool that reported it. */
export interface TurnRecord {
  readonly turnId: string;
  readonly atIso: string;
  /** The delegate that answered — its DID where known, else the id the app knows it by. */
  readonly agentId: string;
  readonly agentName: string;
  /** Who addressed it, and where. Empty when the turn was not caused by a person in a channel. */
  readonly askedBy: string;
  readonly channel: string;
  readonly ok: boolean;
  /** Milliseconds the app measured around the child process. */
  readonly ms: number;

  // ── straight from the CLI's own reply ──
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly numTurns: number;
  readonly costUsd: number;
  readonly ttftMs: number;
  readonly sessionId: string;
  /** Per-model totals, exactly as `modelUsage` reported them. */
  readonly models: Readonly<Record<string, number>>;

  // ── joined from the gate's audit trail, by turnId ──
  readonly toolCalls: number;
  readonly allowed: number;
  readonly asked: number;
  readonly denied: number;
  /** Which tools, and how many times each. */
  readonly tools: Readonly<Record<string, number>>;
}

export function turnsPath(userData: string): string {
  return join(userData, 'agent-turns.jsonl');
}

/**
 * Pull the usage numbers out of a CLI reply.
 *
 * ★ TOLERANT OF EVERY FIELD BEING ABSENT. This reads another program's output, and a CLI upgrade
 * that renames or drops one of these must not break a turn — the worst acceptable outcome is a
 * zero in a report. So there is no schema check and nothing throws: an unreadable reply produces
 * an empty record, and the turn itself is unaffected.
 */
export function usageFrom(reply: unknown): {
  readonly inputTokens: number; readonly outputTokens: number;
  readonly cacheReadTokens: number; readonly cacheCreationTokens: number;
  readonly numTurns: number; readonly costUsd: number; readonly ttftMs: number;
  readonly sessionId: string; readonly models: Record<string, number>;
} {
  const j = (reply ?? {}) as Record<string, unknown>;
  const u = (j['usage'] ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const models: Record<string, number> = {};
  const mu = j['modelUsage'];
  if (mu && typeof mu === 'object') {
    for (const [name, v] of Object.entries(mu as Record<string, unknown>)) {
      const m = (v ?? {}) as Record<string, unknown>;
      models[name] = num(m['inputTokens']) + num(m['outputTokens']);
    }
  }
  return {
    inputTokens: num(u['input_tokens']),
    outputTokens: num(u['output_tokens']),
    cacheReadTokens: num(u['cache_read_input_tokens']),
    cacheCreationTokens: num(u['cache_creation_input_tokens']),
    numTurns: num(j['num_turns']),
    costUsd: num(j['total_cost_usd']),
    ttftMs: num(j['ttft_ms']),
    sessionId: typeof j['session_id'] === 'string' ? j['session_id'] : '',
    models,
  };
}

/**
 * Count what the gate decided during one turn, from its audit trail.
 *
 * ★ FILTERED BY turnId, NOT BY TIME. Two delegates can answer at once — that is the whole point of
 * a shared workspace — and a time window would bill one agent for another's tool calls. An audit
 * line without a turnId is from before this was added and is skipped rather than guessed at.
 */
export function toolsInTurn(userData: string, turnId: string): {
  readonly toolCalls: number; readonly allowed: number; readonly asked: number;
  readonly denied: number; readonly tools: Record<string, number>;
} {
  const empty = { toolCalls: 0, allowed: 0, asked: 0, denied: 0, tools: {} as Record<string, number> };
  const p = join(userData, 'agent-audit.jsonl');
  if (!existsSync(p)) return empty;
  let raw = '';
  try { raw = readFileSync(p, 'utf8'); } catch { return empty; }

  const tools: Record<string, number> = {};
  let toolCalls = 0, allowed = 0, asked = 0, denied = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim() || !line.includes(turnId)) continue;
    let e: { turnId?: string; tool?: string; decision?: string };
    try { e = JSON.parse(line) as typeof e; } catch { continue; }
    if (e.turnId !== turnId) continue;
    toolCalls++;
    const tool = typeof e.tool === 'string' ? e.tool : 'unknown';
    tools[tool] = (tools[tool] ?? 0) + 1;
    if (e.decision === 'allow' || e.decision === 'granted') allowed++;
    else if (e.decision === 'ask') asked++;
    else if (e.decision === 'deny') denied++;
  }
  return { toolCalls, allowed, asked, denied, tools };
}

/** Append one turn. Never throws: a report nobody can write must not fail the turn it describes. */
export function recordTurn(userData: string, rec: TurnRecord): void {
  try {
    mkdirSync(userData, { recursive: true });
    appendFileSync(turnsPath(userData), JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* telemetry is not worth breaking the thing it measures */ }
}

/**
 * Read the turns back, newest first.
 *
 * ★ BOUNDED, BECAUSE THIS FILE ONLY GROWS. A `get_pod_status` tool in this same system once
 * returned 56 MB and broke every client that called it; the lesson was that an unbounded reader is
 * a fault waiting for a busy week. `limit` caps what is parsed, and a torn last line is skipped
 * rather than fatal — another process appends here with no locking.
 */
export function readTurns(userData: string, limit = 500): readonly TurnRecord[] {
  const p = turnsPath(userData);
  if (!existsSync(p)) return [];
  let raw = '';
  try { raw = readFileSync(p, 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter((l) => l.trim());
  const out: TurnRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const r = JSON.parse(lines[i] as string) as TurnRecord;
      if (typeof r?.turnId === 'string') out.push(r);
    } catch { /* a partial append is ordinary here */ }
  }
  return out;
}

/** Totals over a set of turns, for the summary a person actually looks at. */
export interface Totals {
  readonly turns: number; readonly inputTokens: number; readonly outputTokens: number;
  readonly cacheReadTokens: number; readonly cacheCreationTokens: number;
  readonly costUsd: number; readonly toolCalls: number; readonly asked: number; readonly denied: number;
  readonly byAgent: Readonly<Record<string, number>>;
  readonly byAsker: Readonly<Record<string, number>>;
}

export function totals(turns: readonly TurnRecord[]): Totals {
  const byAgent: Record<string, number> = {};
  const byAsker: Record<string, number> = {};
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;
  let costUsd = 0, toolCalls = 0, asked = 0, denied = 0;
  for (const t of turns) {
    inputTokens += t.inputTokens; outputTokens += t.outputTokens;
    cacheReadTokens += t.cacheReadTokens; cacheCreationTokens += t.cacheCreationTokens;
    costUsd += t.costUsd; toolCalls += t.toolCalls; asked += t.asked; denied += t.denied;
    const tok = t.inputTokens + t.outputTokens;
    if (t.agentName) byAgent[t.agentName] = (byAgent[t.agentName] ?? 0) + tok;
    if (t.askedBy) byAsker[t.askedBy] = (byAsker[t.askedBy] ?? 0) + tok;
  }
  return {
    turns: turns.length, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
    costUsd, toolCalls, asked, denied, byAgent, byAsker,
  };
}
