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

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
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
  /**
   * Optional extra env-vars to pass to the bridge process. Useful
   * for the operator-side affordances (e.g., OWM_DEFAULT_AUTHORITY_DID,
   * LPC_INSTITUTION_POD_URL, LPC_INSTITUTION_ISSUER_DID) that the
   * vertical-specific conventional env vars below don't cover.
   */
  readonly env?: Record<string, string>;
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

  // Per-call env overrides (e.g., operator-authority DIDs that aren't
  // covered by the conventional defaults above). Applied AFTER the
  // per-vertical defaults so callers can override.
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) env[k] = v;
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

  // Wait up to 30s for the bridge to be ready AND to identify itself
  // as the bridge we just configured.
  //
  // Probe order:
  //   1. GET /  — verify the reported `pod` field equals options.podUrl.
  //      This catches a stale bridge from a prior run still holding the
  //      port; that bridge would respond OK to /affordances but report
  //      a different pod URL. (Discovered during Demo 19's first dry-run.)
  //   2. If the bridge doesn't yet implement the `pod` field on /,
  //      fall back to /affordances — strictly weaker, but preserves
  //      back-compat with bridges that haven't been rebuilt yet.
  const TIMEOUT_MS = 30000;
  const deadline = Date.now() + TIMEOUT_MS;
  let staleBridgeWarning: string | undefined;
  // Track WHICH failure mode dominated during the spawn window so the
  // diagnostic at the end can be specific. Was previously a flat
  // "bridge failed to start within 30s" with no hint about whether
  // the bridge never came up, came up on the wrong port, came up as
  // someone else's process, or came up but failed health checks.
  // Each shape needs a different fix; the diagnostic should say so.
  type FailureMode = 'unreachable' | 'wrong-pod' | 'wrong-shape' | 'no-affordances';
  let lastFailureMode: FailureMode = 'unreachable';
  let lastReason = '';
  let connectsAt = 0;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) });
      if (!connectsAt) connectsAt = Date.now();
      if (r.ok) {
        const body = await r.json() as { pod?: string };
        if (body.pod === options.podUrl) {
          return { name, port, url, process: proc, podUrl: options.podUrl };
        }
        if (body.pod === undefined) {
          // Older bridge — accept once /affordances also responds.
          const r2 = await fetch(`${url}/affordances`, { signal: AbortSignal.timeout(2000) });
          if (r2.ok) return { name, port, url, process: proc, podUrl: options.podUrl };
          lastFailureMode = 'no-affordances';
          lastReason = `responds at / but /affordances returned ${r2.status}`;
        } else {
          lastFailureMode = 'wrong-pod';
          staleBridgeWarning = `port ${port} is held by a different bridge (it reports pod=${body.pod}, we want pod=${options.podUrl})`;
          lastReason = staleBridgeWarning;
        }
      } else {
        lastFailureMode = 'wrong-shape';
        lastReason = `GET / returned ${r.status} ${r.statusText}`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastFailureMode = connectsAt ? 'wrong-shape' : 'unreachable';
      lastReason = msg;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Bridge didn't come up — surface a SPECIFIC diagnostic based on
  // what we observed during the spawn window.
  const stdout = stdoutChunks.join('');
  const stderr = stderrChunks.join('');
  treeKill(proc, 'SIGTERM');

  let diagnostic: string;
  switch (lastFailureMode) {
    case 'unreachable':
      diagnostic = connectsAt
        ? `bridge ${name} on :${port} accepted a connection but never responded successfully within ${TIMEOUT_MS}ms — the server process likely started but crashed before binding its routes. Inspect STDERR below.`
        : `bridge ${name} on :${port} never accepted a TCP connection within ${TIMEOUT_MS}ms — most likely the npx-tsx-node spawn failed (network issue downloading deps, missing dep, syntax error in server.ts). Inspect STDOUT/STDERR below. Last network error: ${lastReason}`;
      break;
    case 'wrong-pod':
      diagnostic = `bridge ${name} on :${port} is up but ${staleBridgeWarning}. A stale bridge from a previous run is holding the port. Kill it:\n  Windows: taskkill /T /F /PID <pid>\n  POSIX:   kill -9 <pid>\nFind the pid with \`lsof -i :${port}\` (POSIX) or \`Get-NetTCPConnection -LocalPort ${port}\` (PowerShell).`;
      break;
    case 'no-affordances':
      diagnostic = `bridge ${name} on :${port} is up and reports the right pod URL, but /affordances returned ${lastReason}. Either the bridge's manifest generation is broken or its vertical isn't fully wired. Inspect STDERR below.`;
      break;
    case 'wrong-shape':
      diagnostic = `bridge ${name} on :${port} is up but the response shape is wrong: ${lastReason}. A different service is listening on this port. Stop it or use a different port via PORT=NNNN.`;
      break;
  }
  throw new Error(`${diagnostic}\nSTDOUT:\n${stdout || '(empty)'}\nSTDERR:\n${stderr || '(empty)'}`);
}

/**
 * Cross-platform tree-kill.
 *
 * Background: `npx tsx server.ts` spawns `npx → tsx → node` on Windows.
 * `proc.kill('SIGTERM')` only signals the npx wrapper; the inner node
 * process keeps running and holds the bridge port open. After enough
 * failed demo runs the operator's port table fills up with stale
 * listeners. The Unix path is similar — npx forks a child and the
 * default kill doesn't propagate to the descendants.
 *
 * Strategy:
 *   - Windows: `taskkill /T /F /PID <pid>` (T = tree, F = force).
 *     Synchronous via execFileSync; surfaces stderr to the demo
 *     output unless DEBUG_TREE_KILL is unset.
 *   - POSIX: signal the negative process-group ID, which delivers to
 *     every descendant of the spawned shell. Caller MUST have spawned
 *     with detached: true (we don't, by default), so we fall back to
 *     plain kill if PGID isn't available — which is fine because
 *     POSIX node properly inherits SIGTERM down the chain in most
 *     shells.
 *
 * Performance bound (Windows): execFileSync blocks the event loop
 * until taskkill returns. For typical demo trees (≤10 child processes)
 * this is sub-second. If you spawn dozens of bridges in one teardown,
 * either parallelize the kills via spawn() instead of execFileSync,
 * or accept the brief stall. We don't optimize for that case because
 * no current scenario hits it.
 */
export function treeKill(proc: ChildProcess, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
  if (proc.pid === undefined || proc.killed) return;
  if (process.platform === 'win32') {
    try {
      // /T = include child processes. /F = force (no graceful
      // shutdown — fine for demo bridges that have no persistent
      // state to flush).
      execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], {
        stdio: process.env['DEBUG_TREE_KILL'] ? 'inherit' : 'ignore',
      });
    } catch (err) {
      // Always log the taskkill failure — silent fallback to
      // proc.kill is exactly the failure mode this helper exists
      // to prevent (the inner node process holds the port open
      // and the next bridge readiness probe binds to the stale
      // listener). The fallback runs anyway, but the operator
      // needs to see that it happened.
      const code = (err as { status?: number; signal?: string }).status;
      console.error(`[treeKill] taskkill /T /F /PID ${proc.pid} failed (exit=${code ?? 'n/a'}); falling back to proc.kill — port may stay held.`);
      try { proc.kill(signal); } catch { /* already gone */ }
    }
  } else {
    try { proc.kill(signal); } catch { /* already gone */ }
  }
}

export async function killBridges(bridges: readonly BridgeHandle[]): Promise<void> {
  // Tree-kill each bridge synchronously up front. On Windows this
  // actually terminates the inner node process; on POSIX the parent's
  // SIGTERM propagates normally.
  for (const b of bridges) treeKill(b.process, 'SIGTERM');
  // Give graceful shutdown 1.5s, then force-kill anything still alive.
  await new Promise(r => setTimeout(r, 1500));
  for (const b of bridges) {
    if (!b.process.killed) treeKill(b.process, 'SIGKILL');
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
