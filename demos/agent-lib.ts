/**
 * demos/agent-lib.ts — shared helpers for end-to-end demonstration
 * scenarios that drive REAL Claude Code CLI instances as agents.
 *
 * Each scenario:
 *   1. Boots the per-vertical bridges it needs (independent processes)
 *   2. Generates a per-scenario MCP config for the claude agent(s)
 *   3. Invokes `claude -p "..." --mcp-config <file> --output-format json`
 *   4. Parses the agent's tool_use chain + final response
 *   5. Asserts key invariants
 *   6. Tears down bridges + cleans up pod sub-containers
 *
 * No API key required — claude CLI uses your existing Claude Code
 * subscription auth. Reproducible — prompts are explicit and the
 * scenario's expected behavior is documented.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = join(import.meta.dirname ?? '', '..');

// ── Pod target ────────────────────────────────────────────────────────

export const AZURE_CSS_BASE =
  'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const TEST_POD_BASE = `${AZURE_CSS_BASE}/u-pk-6e3bc2f9723c/`;

export function uniquePodUrl(prefix: string): string {
  return `${TEST_POD_BASE}${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}/`;
}

// ── Bridge process management ─────────────────────────────────────────

export type VerticalName =
  | 'learner-performer-companion'
  | 'agent-development-practice'
  | 'lrs-adapter'
  | 'agent-collective'
  | 'organizational-working-memory';

export interface BridgeHandle {
  readonly name: VerticalName;
  readonly port: number;
  readonly url: string;
  readonly process: ChildProcess;
  readonly podUrl: string;
}

const VERTICAL_PORTS: Record<VerticalName, number> = {
  'learner-performer-companion': 6010,
  'agent-development-practice': 6020,
  'lrs-adapter': 6030,
  'agent-collective': 6040,
  'organizational-working-memory': 6060,
};

export interface BridgeSpawnOptions {
  readonly podUrl: string;
  readonly didPrefix: string;  // becomes did:web:${didPrefix}.example
}

/**
 * Spawn a per-vertical bridge as an independent child process. Waits
 * for /affordances to respond before returning.
 */
export async function spawnBridge(
  name: VerticalName,
  options: BridgeSpawnOptions,
): Promise<BridgeHandle> {
  const port = VERTICAL_PORTS[name];
  const url = `http://localhost:${port}`;
  const did = `did:web:${options.didPrefix}.example`;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    BRIDGE_DEPLOYMENT_URL: url,
    NODE_NO_WARNINGS: '1',
  };

  // Per-vertical env-var conventions established by each bridge's server.ts
  switch (name) {
    case 'learner-performer-companion':
      env.LPC_DEFAULT_POD_URL = options.podUrl;
      env.LPC_DEFAULT_USER_DID = did;
      break;
    case 'agent-development-practice':
      env.ADP_DEFAULT_POD_URL = options.podUrl;
      env.ADP_DEFAULT_OPERATOR_DID = did;
      break;
    case 'lrs-adapter':
      env.LRS_DEFAULT_POD_URL = options.podUrl;
      env.LRS_DEFAULT_USER_DID = did;
      break;
    case 'agent-collective':
      env.AC_DEFAULT_POD_URL = options.podUrl;
      env.AC_DEFAULT_AGENT_DID = did;
      break;
    case 'organizational-working-memory':
      env.OWM_DEFAULT_POD_URL = options.podUrl;
      env.OWM_DEFAULT_ORG_DID = did;
      break;
  }

  const cwd = join(REPO_ROOT, 'applications', name, 'bridge');

  // tsx so we don't need a build step
  const proc = spawn('npx', ['tsx', 'server.ts'], {
    cwd, env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  // Capture output for diagnostics; surface only on failure
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  proc.stdout?.on('data', (b: Buffer) => stdoutChunks.push(b.toString()));
  proc.stderr?.on('data', (b: Buffer) => stderrChunks.push(b.toString()));

  // Wait up to 30s for /affordances to respond
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/affordances`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return { name, port, url, process: proc, podUrl: options.podUrl };
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }

  // Bridge didn't come up — surface diagnostics
  const stdout = stdoutChunks.join('');
  const stderr = stderrChunks.join('');
  proc.kill('SIGTERM');
  throw new Error(`bridge ${name} failed to start within 30s.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
}

export async function killBridges(bridges: readonly BridgeHandle[]): Promise<void> {
  for (const b of bridges) {
    b.process.kill('SIGTERM');
  }
  // Give them 2s to exit cleanly
  await new Promise(r => setTimeout(r, 2000));
  for (const b of bridges) {
    if (!b.process.killed) b.process.kill('SIGKILL');
  }
}

// ── Pod cleanup ──────────────────────────────────────────────────────

export async function cleanupPod(podUrl: string): Promise<void> {
  // Best-effort: enumerate manifest, DELETE all entries, DELETE the
  // sub-container. Pods can have stragglers; ignore failures.
  try {
    const manifestUrl = `${podUrl}.well-known/context-graphs`;
    const r = await fetch(manifestUrl, { headers: { Accept: 'text/turtle' } });
    if (r.ok) {
      const ttl = await r.text();
      const urls = Array.from(ttl.matchAll(/^<(https?:\/\/[^>]+)>\s+a\s+cg:ManifestEntry/gm), m => m[1]);
      for (const u of urls) {
        try { await fetch(u!, { method: 'DELETE' }); } catch {}
        // graph file too
        const graphUrl = u!.replace(/\.ttl$/, '-graph.trig');
        try { await fetch(graphUrl, { method: 'DELETE' }); } catch {}
      }
      try { await fetch(manifestUrl, { method: 'DELETE' }); } catch {}
    }
    try { await fetch(`${podUrl}context-graphs/`, { method: 'DELETE' }); } catch {}
    try { await fetch(`${podUrl}.well-known/`, { method: 'DELETE' }); } catch {}
    try { await fetch(podUrl, { method: 'DELETE' }); } catch {}
  } catch { /* best-effort */ }
}

// ── MCP config generation ────────────────────────────────────────────

export interface McpConfig {
  readonly mcpServers: Record<string, {
    readonly type: 'http';
    readonly url: string;
  }>;
}

/**
 * Generate an MCP config pointing at one or more bridges and write it
 * to a temp file. Returns the absolute path.
 */
export function writeMcpConfig(
  scenarioId: string,
  bridges: readonly BridgeHandle[],
): string {
  const dir = join(tmpdir(), 'interego-demos');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `mcp-${scenarioId}.json`);

  const servers: McpConfig['mcpServers'] = {};
  for (const b of bridges) {
    // Convention: server-name = vertical's short prefix
    const short = ({
      'learner-performer-companion': 'lpc-bridge',
      'agent-development-practice': 'adp-bridge',
      'lrs-adapter': 'lrs-bridge',
      'agent-collective': 'ac-bridge',
      'organizational-working-memory': 'owm-bridge',
    } as const)[b.name];
    servers[short] = { type: 'http', url: `${b.url}/mcp` };
  }

  writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2));
  return path;
}

// ── Claude CLI invocation ─────────────────────────────────────────────

export interface ClaudeRunResult {
  readonly success: boolean;
  readonly response: string;        // textual final response from claude
  readonly toolCallsTotal: number;
  readonly toolCallsByName: Record<string, number>;
  readonly rawOutput: string;       // full --output-format=json blob
  readonly stderr: string;
  readonly exitCode: number | null;
}

/**
 * Invoke `claude -p "<prompt>" --mcp-config <path>` headless and parse
 * the JSON output. Captures the full tool-use chain.
 */
export async function runClaudeAgent(
  prompt: string,
  mcpConfigPath: string,
  options: {
    readonly timeoutMs?: number;
    readonly maxTurns?: number;
    /** Optional model alias or full ID. Aliases: "opus" / "sonnet" / "haiku". */
    readonly model?: string;
  } = {},
): Promise<ClaudeRunResult> {
  return await new Promise((resolve) => {
    // Pipe prompt via stdin instead of passing as an arg — avoids
    // command-line-escaping issues with multi-line prompts containing
    // special characters (which is most non-trivial demo prompts).
    // stream-json output captures every assistant turn including
    // tool_use blocks — needed for verifying which MCP tools the agent
    // actually called. The `json` format only returns the final result.
    const args = [
      '-p',
      '--mcp-config', mcpConfigPath,
      '--output-format', 'stream-json',
      '--input-format', 'text',
      '--verbose',
      '--no-session-persistence',
      '--dangerously-skip-permissions',
    ];
    if (options.maxTurns !== undefined) args.push('--max-turns', String(options.maxTurns));
    if (options.model !== undefined) args.push('--model', options.model);

    // Defeat the nested-session check when this scenario is itself
    // executed from inside a Claude Code session. The check exists to
    // prevent runtime-resource clashes; for headless demo invocations
    // each child process is fully independent so the check is not
    // applicable.
    const childEnv = { ...process.env, CLAUDECODE: '' };

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: childEnv,
    });

    // Write the prompt to stdin and close it
    proc.stdin?.write(prompt);
    proc.stdin?.end();

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    proc.stdout?.on('data', (b: Buffer) => stdoutChunks.push(b.toString()));
    proc.stderr?.on('data', (b: Buffer) => stderrChunks.push(b.toString()));

    const timer = setTimeout(() => proc.kill('SIGTERM'), options.timeoutMs ?? 300000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const raw = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      try {
        // stream-json output is NDJSON: one JSON object per line.
        // Types we care about:
        //   { type: 'system',    subtype: 'init',  ... }
        //   { type: 'assistant', message: { content: [...] }, ... }
        //   { type: 'user',      message: { content: [...] }, ... }
        //   { type: 'result',    result: '<final text>', ... }
        const lines = raw.split('\n').filter(l => l.trim().length > 0);
        const toolCallsByName: Record<string, number> = {};
        let toolCallsTotal = 0;
        let response = '';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const visitContent = (content: any): void => {
          if (!Array.isArray(content)) return;
          for (const c of content) {
            if (c?.type === 'tool_use' && typeof c.name === 'string') {
              toolCallsTotal++;
              toolCallsByName[c.name] = (toolCallsByName[c.name] ?? 0) + 1;
            }
            if (c?.type === 'text' && typeof c.text === 'string') {
              // accumulate assistant text as a fallback for response
              // (the result message also carries it but stream-json may
              // not include `result` if --max-turns truncates)
            }
          }
        };

        for (const line of lines) {
          let msg: { type?: string; result?: string; message?: { content?: unknown } };
          try { msg = JSON.parse(line) as typeof msg; } catch { continue; }
          if (msg.type === 'result' && typeof msg.result === 'string') {
            response = msg.result;
          } else if (msg.type === 'assistant' && msg.message?.content) {
            visitContent(msg.message.content);
          }
        }

        resolve({
          success: code === 0 && response.length > 0,
          response,
          toolCallsTotal,
          toolCallsByName,
          rawOutput: raw,
          stderr,
          exitCode: code,
        });
      } catch (e) {
        resolve({
          success: false,
          response: raw,
          toolCallsTotal: 0,
          toolCallsByName: {},
          rawOutput: raw,
          stderr: stderr + `\n[parse error] ${(e as Error).message}`,
          exitCode: code,
        });
      }
    });
  });
}

// ── Output formatting ────────────────────────────────────────────────

export function header(title: string): void {
  const line = '═'.repeat(72);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

export function step(n: number | string, msg: string): void {
  console.log(`\n[${n}] ${msg}`);
}

export function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

export function fail(msg: string): never {
  console.log(`  ✗ ${msg}`);
  throw new Error(msg);
}

export function info(msg: string): void {
  console.log(`    ${msg}`);
}

export function scenarioId(): string {
  return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}

// ── Report writing ───────────────────────────────────────────────────

export function writeReport(
  scenarioName: string,
  body: string,
): string {
  const dir = join(REPO_ROOT, 'demos', 'output');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${scenarioName}-${Date.now()}.md`);
  writeFileSync(path, body);
  return path;
}
