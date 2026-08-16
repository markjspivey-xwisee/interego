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

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

/** One turn, as it will be written to disk. Every field comes from a tool that reported it. */
export interface TurnRecord {
  readonly turnId: string;
  /** When the record was WRITTEN, which is after the turn finished. */
  readonly atIso: string;
  /**
   * When the turn STARTED, stamped before anything ran.
   *
   * ★ A DURATION NEEDS A TIME AXIS THAT AGREES WITH IT. The published graph carries
   * `prov:startedAtTime` and `ieh:elapsedMs`, and `atIso` is written after the run — so using it
   * as the start put the beginning of the turn after its own end. Optional because records written
   * before this existed have no honest value for it, and inventing one from `atIso - ms` would be
   * a derived number wearing a measurement's clothes.
   */
  readonly startedIso?: string;
  /** The delegate that answered — its DID where known, else the id the app knows it by. */
  readonly agentId: string;
  readonly agentName: string;
  /** Who addressed it, and where. Empty when the turn was not caused by a person in a channel. */
  readonly askedBy: string;
  readonly channel: string;
  readonly ok: boolean;
  /**
   * What happened to the DRAFT after the model produced it, when that is known.
   *
   * ── ★★ WITHOUT THIS, "THE TURN SUCCEEDED" AND "SOMETHING WAS WRITTEN" LOOK IDENTICAL ────
   *
   * `ok` means the model ran. It says nothing about whether the reply survived `checkDraft`, and
   * those come apart constantly — a missing footing line, an over-long body, an abstention. Live:
   * a delegate ran three turns, every one recorded `ok: true`, cost about $0.27 between them, and
   * wrote nothing at all, while the person who had asked twice sat looking at silence. The reason
   * existed only as text in a panel on their screen, so diagnosing it meant asking them to read
   * their own UI aloud.
   *
   * `posted` for a written entry, or the refusal's own short reason. Absent on turns from before
   * this existed — which is why it is optional rather than defaulted to something cheerful.
   */
  readonly draft?: string;
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
  /**
   * ★ A BOUNDED TAIL, because this is now called REPEATEDLY DURING A TURN, not once after it.
   * The live progress push reads it every couple of seconds for a minute or more, on the Electron
   * main process, and the audit trail only grows. A turn's own lines were written seconds ago, so
   * they are always inside the window; anything older belongs to a turn nobody is asking about.
   */
  const raw = readTail(p, TAIL_BYTES);

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
/**
 * What became of a draft, in its own file.
 *
 * ★★ SEPARATE FROM THE AUDIT TRAIL ON PURPOSE. `toolsInTurn` counts every line in
 * `agent-audit.jsonl` that carries the turn's id, so a verdict written there would be counted as a
 * tool call and quietly inflate what every turn appears to have done. A file that measures
 * something must not be appended to by something it does not measure.
 *
 * ★ AND IT IS WRITTEN EVEN WHEN THE DRAFT WAS REFUSED — especially then. A refusal is the case
 * nobody can currently see: `ok: true` in the turn log means the model ran, and says nothing about
 * whether a word of it survived.
 */
export function recordDraft(userData: string, rec: { turnId: string; atIso: string; channel: string; outcome: string }): void {
  try {
    mkdirSync(userData, { recursive: true });
    appendFileSync(join(userData, 'agent-drafts.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* telemetry is not worth breaking the thing it measures */ }
}

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

/**
 * How much of the tail of the log to read when looking one turn up.
 *
 * ★★ A BOUND ON THE READ, NOT JUST ON THE PARSE. `readTurns` caps how many lines it PARSES but
 * still pulls the whole file into memory first — tolerable for a panel a person opens, and a fault
 * waiting for a busy week when it runs on the Electron main process after every single turn. At
 * roughly 300 bytes a record this window still covers the last several thousand turns, which is
 * far more than the seconds-old record a lookup is actually after.
 */
const TAIL_BYTES = 512 * 1024;

/** The last `bytes` of a file, starting at a line boundary. Never throws; '' on any failure. */
function readTail(p: string, bytes: number): string {
  let fd = -1;
  try {
    fd = openSync(p, 'r');
    const size = fstatSync(fd).size;
    const start = size > bytes ? size - bytes : 0;
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const s = buf.toString('utf8');
    // A window that starts mid-file starts mid-line — and possibly mid-UTF-8-sequence. Dropping
    // everything before the first newline handles both, at the cost of one record nobody wanted.
    return start > 0 ? s.slice(s.indexOf('\n') + 1) : s;
  } catch {
    return '';
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* a descriptor that will not close is not this function's problem */ } }
  }
}

/**
 * The turn's start time, if the record carries a usable one.
 *
 * ★ VALIDATED BECAUSE IT IS PUBLISHED. This is parsed from a file another process appends to with
 * no locking, and it goes straight into `prov:startedAtTime` as an `xsd:dateTime`. An empty string
 * survives `??` (which only rejects null and undefined) and would produce `""^^xsd:dateTime` — an
 * ill-typed literal that the relay's shape check refuses, losing the whole record.
 */
export function startedAt(rec: TurnRecord | null | undefined): string | null {
  const v = rec?.startedIso;
  if (typeof v !== 'string' || !v) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * One turn by id, or null.
 *
 * ── ★★ THE JOIN THAT WAS MISSING ────────────────────────────────────────────
 *
 * `agent:think` records what a turn COST. The renderer decides what became of the DRAFT, and the
 * published turn graph is written from there. Nothing carried the cost across, so the first live
 * `ieh:AgentTurn` on the pod said who ran, when, and what became of it — and not one number. The
 * half of the question that started this ("what is this costing me") was missing from the record
 * built to answer it.
 *
 * ★ AN EMPTY ID MATCHES NOTHING. The renderer sent `''` before this existed, and a lenient lookup
 * would have attached the newest turn's cost to whatever asked — a real number under the wrong
 * turn, which is worse than none.
 *
 * Bounded exactly like {@link readTurns}, and newest-first because the turn being looked up was
 * written seconds ago by the same process.
 */
export function findTurn(userData: string, turnId: string, limit = 500): TurnRecord | null {
  if (!turnId) return null;
  const p = turnsPath(userData);
  if (!existsSync(p)) return null;
  const raw = readTail(p, TAIL_BYTES);
  const lines = raw.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < limit; i--, seen++) {
    const line = lines[i] as string;
    if (!line.includes(turnId)) continue;
    try {
      const r = JSON.parse(line) as TurnRecord;
      if (r?.turnId === turnId) return r;
    } catch { /* a partial append is ordinary here */ }
  }
  return null;
}

/** The measured part of a turn, named as the published `ieh:AgentTurn` vocabulary names it. */
export interface MeasuredTurn {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly costUsd?: number;
  readonly elapsedMs?: number;
  readonly providerTurns?: number;
  readonly toolCallCount?: number;
  readonly models?: readonly string[];
}

/**
 * A local turn record, as the fields a published turn graph carries.
 *
 * ── ★★ A ZERO FROM THE CLI IS "NOT REPORTED"; A ZERO FROM THE GATE IS "NONE" ─
 *
 * `usageFrom` collapses an absent field to `0` on purpose — it parses another program's output and
 * must not throw — so on this side of the file the two are indistinguishable. Publishing that zero
 * would assert that a turn which demonstrably ran cost nothing, and a total summed over the series
 * would be wrong in the one direction nobody checks. So a zero from the CLI is OMITTED here, and
 * the published record says nothing rather than something false. (No real turn reports zero input
 * tokens, which is what makes the collapse safe to read this way.)
 *
 * `toolCallCount` is not treated the same, because it has a different provenance: it is counted
 * BY US over audit lines we read, and a turn that called no tools really did call none. Erasing
 * that would hide the case worth seeing — an agent thinking expensively and touching nothing.
 *
 * `elapsedMs` follows the CLI rule: the app writes `ms: 0` for a turn that never spawned a child,
 * so a zero here means nothing was timed, not that it took no time.
 */
export function measuredFacts(rec: TurnRecord | null | undefined): MeasuredTurn {
  if (!rec) return {};
  const reported = (v: unknown): number | undefined =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : undefined;
  const put = <K extends keyof MeasuredTurn>(k: K, v: MeasuredTurn[K]): MeasuredTurn =>
    (v === undefined ? {} : { [k]: v } as MeasuredTurn);
  /**
   * ★ THE SHAPE OF THIS IS NOT GUARANTEED. It comes from `JSON.parse` of a line another process
   * appended, cast to `TurnRecord` with no validation, and every key becomes a published
   * `ieh:turnModel`. `Object.keys('haiku')` is `['0','1','2','3','4']` — five model names that
   * never existed, permanently, on a public graph.
   */
  const raw: unknown = rec.models;
  const models = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? Object.keys(raw) : [];
  return {
    ...put('inputTokens', reported(rec.inputTokens)),
    ...put('outputTokens', reported(rec.outputTokens)),
    ...put('cacheReadTokens', reported(rec.cacheReadTokens)),
    ...put('cacheCreationTokens', reported(rec.cacheCreationTokens)),
    ...put('costUsd', reported(rec.costUsd)),
    /**
     * ★★ A DURATION ONLY WHERE THERE IS A START IT COMPOSES WITH. When a record has no usable
     * `startedIso` — every record written before that field existed — the publisher falls back to
     * "now" for `prov:startedAtTime`, and a real `ieh:elapsedMs` beside a fabricated start
     * reproduces the exact "finished before it began" graph this was written to remove. The
     * duration is still in the local log; it is only the incoherent PAIR that is not published.
     */
    ...put('elapsedMs', startedAt(rec) ? reported(rec.ms) : undefined),
    ...put('providerTurns', reported(rec.numTurns)),
    // Counted here, not reported to us: zero is a measurement and is published as one.
    ...(typeof rec.toolCalls === 'number' && Number.isFinite(rec.toolCalls) && rec.toolCalls >= 0
      ? { toolCallCount: rec.toolCalls } : {}),
    ...(models.length ? { models } : {}),
  };
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
