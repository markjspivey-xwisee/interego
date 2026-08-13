/**
 * THE GATE THE CLI RUNS BEFORE EVERY TOOL.
 *
 * ── HOW THIS FILE IS EXECUTED, WHICH IS NOT LIKE THE REST OF THE APP ─────────
 *
 * Claude Code runs a `PreToolUse` hook as a COMMAND: a fresh process per tool call, handed the
 * call on stdin, expected to answer on stdout. It is not part of the Electron app, cannot import
 * from it at runtime, and has no access to its state. So the app writes the policy it should use
 * into a file per turn, and this reads it.
 *
 * MEASURED (`probe-permission-gate.ts`): the hook fires under `-p`, receives the full call, and a
 * `deny` genuinely stops the tool. Those three facts are the whole basis of this design, and the
 * first attempt to measure them said the opposite — because the probe's hook command was broken,
 * not because the mechanism was missing. Anything here that stops working should be re-measured
 * with that probe before being reasoned about.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────
 *
 * ★ IT DOES NOT BLOCK WAITING FOR A HUMAN. A tool call is inside a turn, a turn is inside a poll
 * loop, and a person may be asleep. Holding the subprocess open until somebody answers turns one
 * unattended question into a hung agent and, eventually, a timeout that says nothing useful — the
 * exact failure this replaces. Instead: refuse now, record the request, and let the ANSWER outlive
 * the turn. Approving writes a grant; the next attempt goes straight through.
 *
 * ★ AND IT FAILS CLOSED. A policy file it cannot read, a payload it cannot parse, an unexpected
 * shape — every one of them denies. A permission gate whose error path is "allow" is decoration.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide, requestId, type Policy, type ToolCall } from './permission.js';

/** What the app writes for the turn, and where the gate leaves what it refused. */
export interface GateConfig {
  readonly policy: Policy;
  /** Directory the gate appends pending requests to, one JSON line each. */
  readonly requestsDir: string;
  /** Who is being acted for, and what prompted it — so an approval is attributable. */
  readonly context: { readonly agentName: string; readonly askedBy: string; readonly channel: string };
  /**
   * Every decision, appended one JSON line each.
   *
   * ★ WITHOUT THIS THERE IS NO WAY TO KNOW THE GATE RAN. Measured while building it: a probe
   * asked a gated agent to read a credential store and it refused — and the refusal came from the
   * MODEL's own judgement, not from the gate, which had silently failed to load. A check that
   * passes because the thing under test was never reached is worse than no check.
   *
   * It is also the answer to "what has my agent been trying to do", which is a question anybody
   * running one unattended is entitled to ask.
   */
  readonly auditPath?: string;
}

/** The answer shape Claude Code expects on stdout. */
function answer(decision: 'allow' | 'deny', reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

/** Append one decision to the audit trail. Never throws: an unwritable log denies nothing. */
function audit(cfg: GateConfig, line: Record<string, unknown>): void {
  if (!cfg.auditPath) return;
  try { appendFileSync(cfg.auditPath, JSON.stringify(line) + '\n', 'utf8'); } catch { /* not a reason to change the answer */ }
}

export function gateDecision(raw: string, cfg: GateConfig, nowIso: string): string {
  let call: ToolCall;
  try {
    const parsed = JSON.parse(raw) as { tool_name?: unknown; tool_input?: unknown };
    if (typeof parsed.tool_name !== 'string') throw new Error('no tool_name');
    call = { tool: parsed.tool_name, input: (parsed.tool_input ?? {}) as Record<string, unknown> };
  } catch (e) {
    // ★ FAIL CLOSED. A payload this cannot read is a call it cannot judge.
    return answer('deny', 'the permission gate could not read this tool call ('
      + ((e as Error)?.message ?? String(e)) + '), so it was refused rather than guessed at');
  }

  const d = decide(call, cfg.policy);
  audit(cfg, { atIso: nowIso, tool: call.tool, decision: d.kind, why: d.why, input: call.input });
  if (d.kind === 'allow' || d.kind === 'granted') return answer('allow', d.why);
  if (d.kind === 'deny') return answer('deny', d.why);

  /**
   * ★ THE REQUEST IS RECORDED WITH WHO CAUSED IT.
   *
   * "Claude Desktop wants to run `npm install`" is not enough for anybody to answer safely. What
   * makes it answerable is the rest of the sentence: because THIS person asked THIS in THIS
   * channel. The approval is then attributable to a message on the record rather than to an
   * anonymous dialog that appeared while somebody was making coffee.
   */
  try {
    mkdirSync(cfg.requestsDir, { recursive: true });
    appendFileSync(join(cfg.requestsDir, 'pending.jsonl'), JSON.stringify({
      id: requestId(call), rule: d.rule, what: d.what, tool: call.tool,
      agentName: cfg.context.agentName, askedBy: cfg.context.askedBy, channel: cfg.context.channel,
      atIso: nowIso,
    }) + '\n', 'utf8');
  } catch { /* the refusal below still stands; a request nobody can write is not a reason to allow */ }

  return answer('deny', d.why + '. Permission to ' + d.what + ' has been REQUESTED from '
    + 'the person you act for — tell them plainly that you have asked, and what for. If they '
    + 'approve it, the next attempt will go through without asking again. Do not try to work '
    + 'around this.');
}

/** The program. Reads the call on stdin, the config from argv, and answers on stdout. */
export function runGate(): void {
  const cfgPath = process.argv[2];
  let cfg: GateConfig;
  try { cfg = JSON.parse(readFileSync(String(cfgPath), 'utf8')) as GateConfig; }
  catch (e) {
    process.stdout.write(answer('deny', 'the permission gate could not read its own policy ('
      + ((e as Error)?.message ?? String(e)) + '), so nothing is permitted this turn'));
    return;
  }
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    process.stdout.write(gateDecision(raw, cfg, new Date().toISOString()));
  });
}

/**
 * The settings JSON that installs this gate in front of every tool.
 *
 * ★ `matcher: '*'` — EVERY TOOL, not a list. A list is a thing that goes out of date the day the
 * CLI adds one, and the tool it does not name is the one nobody thought about. `decide` already
 * treats an unrecognised tool as "ask", so an unknown arrival reaches the human rather than the
 * machine — but only if the hook is invoked for it at all.
 */
export function gateSettings(nodePath: string, gateScript: string, cfgPath: string): string {
  const command = JSON.stringify(nodePath) + ' ' + JSON.stringify(gateScript) + ' ' + JSON.stringify(cfgPath);
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] },
  });
}

export function writeGateConfig(dir: string, cfg: GateConfig): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'gate-config.json');
  writeFileSync(p, JSON.stringify(cfg), { mode: 0o600, encoding: 'utf8' });
  return p;
}
