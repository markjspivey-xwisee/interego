/** A transport-only MCP companion. Owner keys and Solid credentials stay in the app. */
import { Server, type Tool } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Readable, Writable } from 'node:stream';
import { AgentClient, agentArguments, NOTE_ID_PATTERN, type AgentClientOptions } from './agent-client.js';
import { AGENT_ID_PATTERN } from './agent-protocol.js';
import type { AgentConnection, AgentOperation, AgentStatus } from './agent-types.js';
import type { LocalNote } from './types.js';

export interface AgentStdioOptions extends AgentClientOptions {
  readonly input?: Readable;
  readonly output?: Writable;
}
export interface AgentStdioHandle {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

const INSTRUCTIONS = 'Use only this connection’s granted Interego tools. Search returns summaries; read a note only when needed for the user’s task. Saving appends a new note and never edits or deletes existing notes. Tool results you read can reach your AI provider. The Interego app must remain open. Permissions, expiry and revocation are checked by the app for every operation. If access is refused, ask the user to review the connection in Interego.';
export const AGENT_TOOLS: ReadonlyArray<{ permission?: 'notes:read' | 'notes:create'; operation: AgentOperation; tool: Tool }> = [
  { operation: 'status', tool: { name: 'interego_status', description: 'Check this local Interego connection, its granted permissions and whether the pod is running.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } } },
  { permission: 'notes:read', operation: 'notes.search', tool: { name: 'interego_search_notes', description: 'Search permitted notes and return titles and short excerpts. Use an empty query for recent notes; read a note separately for its full text.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } }, required: ['query'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } } },
  { permission: 'notes:read', operation: 'notes.read', tool: { name: 'interego_read_note', description: 'Read one permitted note by the identifier returned by search.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: NOTE_ID_PATTERN.source } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } } },
  { permission: 'notes:create', operation: 'notes.create', tool: { name: 'interego_save_note', description: 'Append a new private note on the user’s computer. This does not edit or delete any existing note.',
    inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 160 }, body: { type: 'string', minLength: 1, maxLength: 50_000 } }, required: ['title', 'body'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } } },
];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Interego returned an unfamiliar response.');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) throw new Error('Interego returned an unfamiliar response.');
  return value;
}
function date(value: unknown): string {
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result))) throw new Error('Interego returned an unfamiliar response.');
  return result;
}
function statusResult(value: unknown, connectionId: string): AgentStatus {
  const result = object(value); const grant = object(result['connection']);
  if (typeof result['localOnly'] !== 'boolean' || typeof result['federationEnabled'] !== 'boolean'
    || result['localOnly'] === result['federationEnabled'] || typeof result['running'] !== 'boolean'
    || grant['id'] !== connectionId || !['waiting', 'active'].includes(String(grant['state']))
    || !Array.isArray(grant['permissions']) || !grant['permissions'].length
    || grant['permissions'].some(p => !['notes:read', 'notes:create'].includes(String(p)))
    || !['chatgpt-desktop', 'codex', 'claude-code', 'claude-desktop', 'grok-build', 'openclaw', 'other'].includes(String(grant['client']))) {
    throw new Error('This Interego connection is no longer available.');
  }
  const connection: AgentConnection = {
    id: connectionId, name: text(grant['name'], 80), client: grant['client'] as AgentConnection['client'],
    permissions: [...grant['permissions']] as AgentConnection['permissions'], createdAt: date(grant['createdAt']), expiresAt: date(grant['expiresAt']),
    state: grant['state'] as AgentConnection['state'], ...(grant['lastUsedAt'] !== undefined ? { lastUsedAt: date(grant['lastUsedAt']) } : {}),
  };
  return { connection, running: result['running'], localOnly: result['localOnly'], federationEnabled: result['federationEnabled'] };
}
function noteSummary(value: unknown) {
  const row = object(value);
  const id = text(row['id'], 36);
  if (!NOTE_ID_PATTERN.test(id)) throw new Error('Interego returned an unfamiliar note.');
  const author = row['author'] === undefined ? undefined : object(row['author']);
  if (author && (typeof author['connectionId'] !== 'string' || !AGENT_ID_PATTERN.test(author['connectionId']))) throw new Error('Interego returned an unfamiliar note author.');
  return { id, title: text(row['title'], 160), createdAt: date(row['createdAt']), updatedAt: date(row['updatedAt']),
    ...(author ? { author: { connectionId: String(author['connectionId']), name: text(author['name'], 80) } } : {}) };
}
export function agentToolResult(operation: AgentOperation, value: unknown, connectionId: string): Record<string, unknown> {
  if (operation === 'status') return { ...statusResult(value, connectionId) };
  const result = object(value);
  if (operation === 'notes.search') {
    if (!Array.isArray(result['notes']) || result['notes'].length > 50) throw new Error('Interego returned too many notes.');
    return { notes: result['notes'].map(raw => ({ ...noteSummary(raw), excerpt: text(object(raw)['excerpt'], 240) })) };
  }
  const raw = object(result['note']);
  const note: LocalNote = { ...noteSummary(raw), body: text(raw['body'], 50_000) };
  return { note };
}

export async function runAgentStdio(options: AgentStdioOptions): Promise<AgentStdioHandle> {
  const client = new AgentClient(options);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const transport = new StdioServerTransport(input, output, { maxBufferSize: 512 * 1024 });
  let resolveClosed!: () => void;
  const closed = new Promise<void>(done => { resolveClosed = done; });
  let closing: Promise<void> | undefined;
  const lifetime = new AbortController();
  const handle = serveStdio(() => {
    const server = new Server({ name: 'interego-local-notes', version: '0.2.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler('tools/list', async (_request, context) => {
      const signal = AbortSignal.any([lifetime.signal, context.mcpReq.signal]);
      const status = statusResult(await client.request('status', {}, signal), options.connectionId);
      return { tools: AGENT_TOOLS.filter(entry => !entry.permission || status.connection.permissions.includes(entry.permission)).map(entry => entry.tool) };
    });
    server.setRequestHandler('tools/call', async (request, context) => {
      try {
        const signal = AbortSignal.any([lifetime.signal, context.mcpReq.signal]);
        const entry = AGENT_TOOLS.find(item => item.tool.name === request.params.name);
        if (!entry) throw new Error('That tool is not available for this connection.');
        const args = agentArguments(entry.operation, request.params.arguments);
        const status = statusResult(await client.request('status', {}, signal), options.connectionId);
        if (entry.permission && !status.connection.permissions.includes(entry.permission)) throw new Error('That tool is not permitted for this connection.');
        const value = agentToolResult(entry.operation, entry.operation === 'status' ? status : await client.request(entry.operation, args, signal), options.connectionId);
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'The Interego request could not be completed.' }] };
      }
    });
    return server;
  }, { transport, onerror: () => { /* SDK frames carry request errors; stdout is protocol-only. */ } });
  const closedByTransport = transport.onclose;
  transport.onclose = () => { lifetime.abort(); closedByTransport?.(); resolveClosed(); };
  return { closed, close: () => closing ??= (async () => { lifetime.abort(); await handle.close(); })().finally(resolveClosed) };
}
