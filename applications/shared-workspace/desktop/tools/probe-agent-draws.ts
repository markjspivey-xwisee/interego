/**
 * CAN THE DELEGATE PRODUCE AN IMAGE WITH NO TOOL, NO CONNECTOR AND NO CREDENTIAL?
 *
 * ★ THE QUESTION A REAL ANSWER IN DISCORD RAISED. Asked for a donkey, the delegate replied that
 * "image generation isn't a capability I have … you'd need a tool or bot that wraps an
 * image-generation model". Everything after that went looking for a way to grant it one: a
 * connector, a per-tool grant, a published affordance with its own key.
 *
 * All of which may be beside the point. A language model DRAWS — SVG is text, and writing text is
 * the one thing a delegate needs no permission for. If that is true then an image is not a
 * capability to be granted at all; it is output, and the only real work is carrying it to the
 * channel. If it is false, the affordance path is the answer and this probe says so.
 *
 * Runs the child exactly as a delegate runs — `childEnv`, `neutralCwd`, the relay as its only MCP
 * server, every built-in denied — so what comes back is what a delegate could actually produce.
 *
 * Run from applications/shared-workspace/desktop/:  npx tsx tools/probe-agent-draws.ts
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, neutralCwd, resolveClaudeCli, DENIED_BUILTINS } from '../src/modelprovider.js';
import { withAgentTools } from '../src/agent-tools.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';

const PROMPT = [
  'Somebody in a channel asked you for a picture of a donkey.',
  'You have no image-generation tool and you do not need one: you can DRAW, because SVG is text.',
  'Reply with a single self-contained <svg>…</svg> element and nothing else — no prose, no code fence.',
  'Keep it under 3000 characters. Give it a viewBox and make it recognisable as a donkey.',
].join('\n');

function bearer(): string {
  return readFileSync(join(process.cwd(), '..', '..', '..', 'scratchpad', '.token'), 'utf8').trim();
}

async function main(): Promise<void> {
  const cli = resolveClaudeCli();
  if (!cli?.path) { process.stdout.write('no claude CLI on this machine\n'); process.exit(1); }

  await withAgentTools({ relay: RELAY, bearer: bearer(), delegatePod: 'probe' }, async (tools) => {
    const r = spawnSync(cli.path as string, [
      '-p', '--model', 'sonnet',
      '--mcp-config', tools.mcpConfigPath, '--strict-mcp-config',
      '--allowedTools', 'mcp__' + tools.server,
      '--disallowedTools', ...DENIED_BUILTINS,
      '--permission-mode', 'dontAsk', '--no-session-persistence', '--output-format', 'json',
    ], { input: PROMPT, encoding: 'utf8', timeout: 300_000, env: childEnv(), cwd: neutralCwd() });

    let text = String(r.stdout ?? '');
    try { text = (JSON.parse(text) as { result?: string }).result ?? text; } catch { /* raw */ }

    const svg = /<svg[\s\S]*<\/svg>/i.exec(text)?.[0] ?? '';
    process.stdout.write('\nreplied with ' + text.trim().length + ' characters\n');
    process.stdout.write('contains an <svg> element : ' + (svg ? 'YES (' + svg.length + ' chars)' : 'NO') + '\n');
    if (svg) {
      // Cheap structural checks — a thing that opens and closes and declares a coordinate space.
      process.stdout.write('has a viewBox             : ' + (/viewBox\s*=/.test(svg) ? 'yes' : 'no') + '\n');
      process.stdout.write('draws something           : '
        + (/<(path|circle|ellipse|rect|polygon|polyline|line|g)\b/i.test(svg) ? 'yes' : 'no') + '\n');
      process.stdout.write('no script element         : ' + (/<script/i.test(svg) ? 'NO — CONTAINS SCRIPT' : 'yes') + '\n');
      process.stdout.write('\nfirst 240 characters:\n' + svg.slice(0, 240) + '\n');
    } else {
      process.stdout.write('\nwhat it said instead:\n' + text.trim().slice(0, 400) + '\n');
    }
  });
}

void main().catch((e: unknown) => {
  process.stdout.write('probe failed: ' + ((e as Error)?.stack ?? String(e)) + '\n');
  process.exit(1);
});
