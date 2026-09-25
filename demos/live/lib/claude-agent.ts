/**
 * A Claude agent, run headless with the Claude Code CLI on your own subscription, streamed step
 * by step. It starts in an empty directory with only project-level settings, so nothing of yours
 * (memory, instructions, enabled plugins) reaches it: it knows what it is handed — MCP servers,
 * skills in a plugin directory, and the prompt — and nothing else.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface AgentEvent {
  readonly kind: 'started' | 'thinking' | 'says' | 'calls' | 'got' | 'done' | 'error';
  readonly text?: string;
  readonly detail?: unknown;
}

export interface ToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  output?: string;
  isError?: boolean;
}

export interface AgentRun {
  readonly result: string;
  readonly events: AgentEvent[];
  readonly toolUses: ToolUse[];
  readonly exitCode: number | null;
  readonly costUsd?: number;
  readonly turns?: number;
  readonly stderr: string;
}

export interface AgentOptions {
  readonly prompt: string;
  /** MCP servers the agent may use, and no others. */
  readonly mcpServers: Record<string, { readonly type: 'http'; readonly url: string; readonly headers?: Record<string, string> }>;
  /** Skill directories (each holding a SKILL.md) to install, as one local plugin. */
  readonly skills?: readonly { readonly name: string; readonly dir: string }[];
  /** Built-in tools to make available; the default is only the Skill tool. */
  readonly tools?: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly onEvent?: (e: AgentEvent) => void;
}

/** A fresh working directory, a plugin holding the skills, and the MCP config file. */
function stage(opts: AgentOptions): { cwd: string; mcpConfig: string; pluginDir?: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'interego-live-agent-'));
  const mcpConfig = join(cwd, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: opts.mcpServers }, null, 2));
  if (!opts.skills?.length) return { cwd, mcpConfig };
  const pluginDir = join(cwd, 'plugin');
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'interego', version: '0.0.1', description: 'Interego skills generated from the verticals\' affordance declarations' }, null, 2));
  for (const s of opts.skills) cpSync(s.dir, join(pluginDir, 'skills', s.name), { recursive: true });
  return { cwd, mcpConfig, pluginDir };
}

/** Quote an argument for the Windows shell the CLI's .cmd shim needs. */
const quote = (a: string): string => (process.platform === 'win32' && /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

/**
 * The Claude Code CLI you run, not the copy this repository installs as a dev dependency: `npx`
 * puts `node_modules/.bin` first on PATH, and that copy's native binary is not built for every
 * Windows. DEMO_CLAUDE_BIN overrides.
 */
export function claudeBin(): string {
  const override = process.env['DEMO_CLAUDE_BIN'];
  if (override) return override;
  const names = process.platform === 'win32' ? ['claude.cmd', 'claude.exe'] : ['claude'];
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir || /node_modules/i.test(dir)) continue;
    for (const n of names) if (existsSync(join(dir, n))) return join(dir, n);
  }
  return 'claude';
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('');
  return '';
};

/** Run the agent to the end, calling `onEvent` for each step as the CLI reports it. */
export function runClaudeAgent(opts: AgentOptions): Promise<AgentRun> {
  const { cwd, mcpConfig, pluginDir } = stage(opts);
  const args = [
    '-p',
    '--output-format', 'stream-json', '--input-format', 'text', '--verbose',
    '--no-session-persistence',
    '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--tools', opts.tools ?? 'Skill',
    '--permission-mode', 'bypassPermissions',
    '--max-turns', String(opts.maxTurns ?? 14),
    '--model', opts.model ?? process.env['DEMO_AGENT_MODEL'] ?? 'sonnet',
    ...(pluginDir ? ['--plugin-dir', pluginDir] : []),
  ];
  const events: AgentEvent[] = [];
  const toolUses: ToolUse[] = [];
  const emit = (e: AgentEvent): void => { events.push(e); opts.onEvent?.(e); };

  return new Promise((resolve) => {
    const bin = claudeBin();
    const proc = spawn(quote(bin), args.map(quote), { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true, env: { ...process.env, CLAUDECODE: '' } });
    // A child that dies at start closes its stdin under us; that is the child's failure to report, not this server's crash.
    proc.stdin?.on('error', () => undefined);
    proc.stdin?.end(opts.prompt);
    let buffer = '';
    let stderr = '';
    let result = '';
    let costUsd: number | undefined;
    let turns: number | undefined;
    const timer = setTimeout(() => { emit({ kind: 'error', text: 'the agent ran out of time' }); proc.kill(); }, opts.timeoutMs ?? 300_000);

    const line = (l: string): void => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(l) as Record<string, unknown>; } catch { return; }
      const type = m['type'];
      if (type === 'system' && m['subtype'] === 'init') {
        const tools = (m['tools'] as string[] | undefined) ?? [];
        const servers = (m['mcp_servers'] as { name: string; status: string }[] | undefined) ?? [];
        const skills = (m['skills'] as string[] | undefined) ?? (m['slash_commands'] as string[] | undefined)?.filter((s) => s.includes(':')) ?? [];
        emit({ kind: 'started', text: `${String(m['model'] ?? '')}: ${tools.length} tools, MCP ${servers.map((s) => `${s.name} ${s.status}`).join(', ') || 'none'}${skills.length ? `, skills ${skills.join(', ')}` : ''}` });
        return;
      }
      if (type === 'assistant') {
        const content = ((m['message'] as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[];
        for (const c of content) {
          if (c['type'] === 'thinking' && typeof c['thinking'] === 'string' && c['thinking'].trim()) emit({ kind: 'thinking', text: c['thinking'] });
          else if (c['type'] === 'text' && typeof c['text'] === 'string' && c['text'].trim()) emit({ kind: 'says', text: c['text'] });
          else if (c['type'] === 'tool_use') {
            const use: ToolUse = { id: String(c['id']), name: String(c['name']), input: c['input'] };
            toolUses.push(use);
            emit({ kind: 'calls', text: use.name, detail: use.input });
          }
        }
        return;
      }
      if (type === 'user') {
        const content = ((m['message'] as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[];
        for (const c of content) {
          if (c['type'] !== 'tool_result') continue;
          const use = toolUses.find((u) => u.id === c['tool_use_id']);
          const out = textOf(c['content']);
          if (use) { use.output = out; use.isError = c['is_error'] === true; }
          emit({ kind: 'got', text: use ? `${use.name}${c['is_error'] ? ' (error)' : ''}` : 'result', detail: out.length > 4000 ? `${out.slice(0, 4000)}…` : out });
        }
        return;
      }
      if (type === 'result') {
        result = typeof m['result'] === 'string' ? m['result'] : '';
        costUsd = typeof m['total_cost_usd'] === 'number' ? m['total_cost_usd'] : undefined;
        turns = typeof m['num_turns'] === 'number' ? m['num_turns'] : undefined;
        emit({ kind: 'done', text: result, detail: { turns, costUsd, subtype: m['subtype'] } });
      }
    };

    proc.stdout?.on('data', (b: Buffer) => {
      buffer += b.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) { const l = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1); if (l) line(l); }
    });
    proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString(); });
    proc.on('error', (e) => emit({ kind: 'error', text: `could not start the Claude CLI: ${e.message}` }));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (buffer.trim()) line(buffer.trim());
      if (code !== 0 && !result) emit({ kind: 'error', text: stderr.trim().split('\n').slice(-3).join(' ') || `the Claude CLI exited ${code}` });
      resolve({ result, events, toolUses, exitCode: code, stderr, ...(costUsd !== undefined ? { costUsd } : {}), ...(turns !== undefined ? { turns } : {}) });
    });
  });
}
