#!/usr/bin/env tsx
/**
 * Run a coding agent behind the Editor Witness.
 *
 * The witness is a drop-in replacement for the agent command in your editor's ACP config.
 * Point the editor at this, give it the real agent as arguments, and everything behaves
 * exactly as before — because every frame is forwarded byte-for-byte. See transport.ts.
 *
 *   Editor  <--stdio-->  witness  <--stdio-->  agent
 *
 * Increment 0 publishes NOTHING. It counts consent decisions in memory and prints a
 * summary when the session ends, to answer the one question the rest of the design is
 * gated on: do always-scoped denials actually happen?
 *
 * Usage, in your editor's agent settings:
 *   command: npx
 *   args:    ["tsx", "<repo>/applications/agent-development-practice/adapters/editor-witness/src/cli.ts",
 *             "--", "npx", "@agentclientprotocol/claude-agent-acp"]
 *
 * Or from a terminal, against the SDK's example agent, to see it work:
 *   npx tsx src/cli.ts -- node node_modules/@agentclientprotocol/sdk/dist/examples/agent.js
 *
 * --json <path>  also write the tally as JSON (still local; nothing leaves the machine)
 */
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { startTee } from './transport.js';
import { createTally, summarise } from './measure.js';

function parseArgv(argv: readonly string[]): { jsonOut?: string; cmd: string[] } {
  const dash = argv.indexOf('--');
  const flags = dash === -1 ? argv : argv.slice(0, dash);
  const cmd = dash === -1 ? [] : argv.slice(dash + 1);
  const j = flags.indexOf('--json');
  return { ...(j !== -1 && flags[j + 1] ? { jsonOut: flags[j + 1] } : {}), cmd };
}

const { jsonOut, cmd } = parseArgv(process.argv.slice(2));
if (cmd.length === 0) {
  process.stderr.write(
    'editor-witness: give the agent command after `--`.\n' +
    '  e.g. npx tsx src/cli.ts -- npx @agentclientprotocol/claude-agent-acp\n');
  process.exit(2);
}

// stderr only: stdout IS the protocol channel, and a stray byte there corrupts the session.
const note = (s: string): void => { process.stderr.write(s + '\n'); };
note(`[witness] increment 0 — observing only, publishing nothing`);
note(`[witness] agent: ${cmd.join(' ')}`);

const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
child.on('error', (e) => { note(`[witness] could not start agent: ${e.message}`); process.exit(1); });

const { observer, finish } = createTally();

/**
 * ★ FLUSH ON EVERY OBSERVATION, NOT ONLY AT EXIT.
 *
 * An editor terminates its agent rather than closing the pipe, so no stream-end fires and
 * the exit-time write never happens. Measured against a real editor: one permission request
 * and one answer observed, and the tally file absent afterwards — the entire session lost,
 * with only the stderr log surviving by accident. A day of work would have gone the same way.
 */
const flush = (): void => {
  if (!jsonOut) return;
  try { writeFileSync(jsonOut, JSON.stringify(finish(), null, 2)); } catch { /* never fatal */ }
};

let reported = false;
const report = (): void => {
  if (reported) return;
  reported = true;
  const t = finish();
  note(summarise(t));
  if (jsonOut) {
    try {
      writeFileSync(jsonOut, JSON.stringify(t, null, 2));
      note(`[witness] tally written to ${jsonOut}`);
    } catch (e) {
      note(`[witness] could not write ${jsonOut}: ${(e as Error).message}`);
    }
  }
};

// Report on every exit path — a session usually ends by the editor closing the pipe,
// not by anything as tidy as a protocol goodbye.
process.on('SIGINT', () => { report(); process.exit(0); });
process.on('SIGTERM', () => { report(); process.exit(0); });
// ★ DO NOT REPORT-AND-EXIT THE MOMENT THE AGENT EXITS.
//
// This used to be `child.on('exit', () => { report(); process.exit(0); })`. A process
// exiting does not mean its stdout has been drained: the frames it wrote just before
// exiting are still in the pipe. Exiting here left them unforwarded to the editor AND
// uncounted — breaking the invisibility invariant at the one moment it is most visible,
// the end of a session, where the last tool result and the stop message live.
//
// The correct signal is the STREAM ending, which fires after the buffer flushes and is
// handled by onDirectionEnd below. This keeps only a bounded backstop for an agent whose
// stdout never closes.
child.on('exit', () => {
  const backstop = setTimeout(() => { report(); process.exit(0); }, 3000);
  backstop.unref?.();
});

await startTee({
  fromEditor: process.stdin,
  toAgent: child.stdin,
  fromAgent: child.stdout,
  toEditor: process.stdout,
  observers: [observer, () => flush()],
  // ★ THE EDITOR OWNS THE SESSION. When it hangs up, the day is over — report then,
  // rather than waiting for an agent that may never exit. Found on the first live run
  // against a real agent: it errored, stayed alive, both pumps stayed open, and the whole
  // tally vanished. A measurement you only get from a well-behaved peer is not a
  // measurement you can rely on having.
  onDirectionEnd: (direction) => {
    // Either end closing ends the session, and both fire only AFTER their stream has
    // flushed — so nothing is counted late or dropped. report() is idempotent.
    report();
    if (direction !== 'editor->agent') return;
    // Give the agent a bounded moment to drain, then stop waiting on it.
    const grace = setTimeout(() => { child.kill(); process.exit(0); }, 3000);
    grace.unref?.();
  },
  onObserverError: (err) => {
    // Never fatal: the session outranks the measurement.
    note(`[witness] observer error (session unaffected): ${(err as Error)?.message ?? String(err)}`);
  },
});

report();
