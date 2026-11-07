/** Packaged verification only: real executable, MCP stdio, protected ticket and app broker. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AGENT_DIAGNOSTIC_LINE } from './agent-client.js';
import type { AgentConnection, AgentConnectionInput } from './agent-types.js';
import type { LocalNote } from './types.js';

interface SmokeOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly userData: string;
  readonly packaged: boolean;
  readonly expectPrevious: boolean;
  readonly create: (input: AgentConnectionInput) => Promise<AgentConnection>;
  readonly revoke: (id: string) => Promise<void>;
  readonly list: () => Promise<readonly AgentConnection[]>;
  readonly notes: () => Promise<readonly LocalNote[]>;
}

class Peer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requests = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private next = 0;
  private exited = false;
  private readonly exit: Promise<void>;

  constructor(options: SmokeOptions, id: string, inheritedNodeMode = false) {
    const env: NodeJS.ProcessEnv = { ...process.env, INTEREGO_POD_DIAGNOSTICS: '1', NODE_OPTIONS: '' };
    // Installed launchers disable this Electron fuse, including when a host has
    // accidentally inherited the variable. Stock developer Electron does not.
    if (inheritedNodeMode) env['ELECTRON_RUN_AS_NODE'] = '1';
    else delete env['ELECTRON_RUN_AS_NODE'];
    this.child = spawn(options.command, [...options.args, '--mcp-stdio', '--connection', id, '--pod-data-dir', options.userData],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: this.child.stdout });
    const fail = () => {
      for (const request of this.requests.values()) request.reject(new Error('The packaged MCP companion stopped before answering.'));
      this.requests.clear();
    };
    lines.on('line', line => {
      // Windows GUI executables can emit an empty console startup line. The
      // MCP SDK skips it too; nonempty diagnostic output remains a failure.
      if (!line.trim()) return;
      let message: { id?: number; result?: unknown; error?: unknown };
      try { message = JSON.parse(line) as typeof message; }
      catch { process.stderr.write(`The MCP companion emitted a non-protocol stdout line: ${JSON.stringify(line).slice(0, 240)}\n`); fail(); return; }
      if (typeof message.id !== 'number') return;
      const pending = this.requests.get(message.id);
      if (!pending) return;
      this.requests.delete(message.id);
      if (message.error) {
        const fault = message.error as { code?: unknown; message?: unknown };
        pending.reject(new Error(`The packaged MCP companion refused ${pending.method}: ${String(fault.code)} ${String(fault.message).slice(0, 350)}`));
      }
      else pending.resolve(message.result);
    });
    // Retain only fixed application stage labels, never Chromium/OS output,
    // credential contents, request payloads, paths, or exception messages.
    const diagnostics = createInterface({ input: this.child.stderr });
    diagnostics.on('line', line => {
      if (AGENT_DIAGNOSTIC_LINE.test(line)) process.stderr.write(`${line}\n`);
    });
    this.child.on('error', fail);
    this.exit = new Promise(done => this.child.once('close', () => { this.exited = true; fail(); lines.close(); diagnostics.close(); done(); }));
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error('The packaged MCP companion has closed.'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.requests.delete(id); reject(new Error('The packaged MCP companion did not answer.')); }, 60_000);
      this.requests.set(id, {
        method,
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (error) { clearTimeout(timeout); this.requests.delete(id); reject(error); }
      });
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Interego packaged verification', version: '1' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.exit, new Promise<void>(done => { timer = setTimeout(done, 5_000); })]);
    clearTimeout(timer);
    if (!this.exited) { this.child.kill(); await this.exit; }
  }
}

function result(value: unknown): Record<string, unknown> {
  const tool = value as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { type?: string; text?: string }[] };
  if (tool.isError) throw new Error('A permitted packaged MCP operation was refused.');
  const text = tool.content?.find(row => row.type === 'text')?.text;
  return tool.structuredContent ?? JSON.parse(text ?? 'null') as Record<string, unknown>;
}

async function mustRefuse(call: () => Promise<unknown>): Promise<void> {
  try {
    const response = await call() as { isError?: boolean };
    if (response.isError) return;
  } catch { return; }
  throw new Error('A packaged MCP connection exceeded its granted permissions.');
}

export async function verifyAgentPairing(options: SmokeOptions): Promise<string> {
  const previousRows = await options.list();
  const previous = previousRows.find(row => row.state === 'revoked' && row.name === 'Packaged read connection');
  if (options.expectPrevious) {
    const writer = previousRows.find(row => row.state === 'revoked' && row.name === 'Packaged save connection');
    if (!previous || !writer || !(await options.notes()).some(note => note.author?.connectionId === writer.id)) {
      throw new Error('The reopened app lost its retained grant state or private agent note.');
    }
  }
  if (previous) {
    const revoked = new Peer(options, previous.id);
    try { await revoked.initialize(); await mustRefuse(() => revoked.request('tools/list')); }
    finally { await revoked.close(); }
  }
  const read = await options.create({ client: 'codex', name: 'Packaged read connection', permissions: ['notes:read'], expiresInDays: 7 });
  const write = await options.create({ client: 'other', name: 'Packaged save connection', permissions: ['notes:create'], expiresInDays: 7 });
  if (read.state !== 'waiting' || write.state !== 'waiting') throw new Error('Creating setup incorrectly reported an active agent.');
  const reader = new Peer(options, read.id); const writer = new Peer(options, write.id, options.packaged);
  try {
    await reader.initialize(); await writer.initialize();
    const readTools = await reader.request('tools/list') as { tools: { name: string }[] };
    const writeTools = await writer.request('tools/list') as { tools: { name: string }[] };
    if (readTools.tools.some(tool => tool.name === 'interego_save_note')
      || writeTools.tools.some(tool => ['interego_search_notes', 'interego_read_note'].includes(tool.name))) throw new Error('MCP tool listings exceed their granted permissions.');
    const status = result(await reader.request('tools/call', { name: 'interego_status', arguments: {} }));
    if (!status['running'] || status['federationEnabled'] !== false || status['localOnly'] !== true) throw new Error('The paired pod has the wrong profile.');
    await mustRefuse(() => reader.request('tools/call', { name: 'interego_save_note', arguments: { title: 'Must not be written', body: 'A read connection cannot create this.' } }));
    const body = `Private companion note ${'x'.repeat(300)} full-text-tail`;
    const saved = result(await writer.request('tools/call', { name: 'interego_save_note', arguments: { title: 'Paired local memory', body } }))['note'] as LocalNote;
    if (saved.body !== body || saved.author?.connectionId !== write.id) throw new Error('The paired write has the wrong local author.');
    const search = result(await reader.request('tools/call', { name: 'interego_search_notes', arguments: { query: 'Paired local memory', limit: 10 } }));
    if (JSON.stringify(search).includes('full-text-tail') || !(search['notes'] as { id: string }[]).some(note => note.id === saved.id)) throw new Error('Paired search did not return bounded summaries.');
    const opened = result(await reader.request('tools/call', { name: 'interego_read_note', arguments: { id: saved.id } }))['note'] as LocalNote;
    if (opened.body !== body || opened.author?.connectionId !== write.id) throw new Error('The paired read did not recover the private note.');
    await mustRefuse(() => writer.request('tools/call', { name: 'interego_read_note', arguments: { id: saved.id } }));
    await options.revoke(read.id);
    await mustRefuse(() => reader.request('tools/call', { name: 'interego_read_note', arguments: { id: saved.id } }));
    const rows = await options.list();
    if (rows.find(row => row.id === read.id)?.state !== 'revoked' || !rows.find(row => row.id === write.id)?.lastUsedAt) throw new Error('The paired access state was not retained.');
    await options.revoke(write.id);
    return saved.id;
  } finally { await reader.close(); await writer.close(); }
}
