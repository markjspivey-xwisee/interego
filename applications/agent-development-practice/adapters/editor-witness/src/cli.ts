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
child.on('exit', () => { report(); process.exit(0); });

await startTee({
  fromEditor: process.stdin,
  toAgent: child.stdin,
  fromAgent: child.stdout,
  toEditor: process.stdout,
  observers: [observer],
  // ★ THE EDITOR OWNS THE SESSION. When it hangs up, the day is over — report then,
  // rather than waiting for an agent that may never exit. Found on the first live run
  // against a real agent: it errored, stayed alive, both pumps stayed open, and the whole
  // tally vanished. A measurement you only get from a well-behaved peer is not a
  // measurement you can rely on having.
  onDirectionEnd: (direction) => {
    if (direction !== 'editor->agent') return;
    report();
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
