import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentClient } from '../src/agent-client.js';
import { MAX_AGENT_RESPONSE_BYTES } from '../src/agent-protocol.js';
import { AgentService, type AgentServiceOptions } from '../src/agent-service.js';
import type { AgentConnection, AgentOperation, AgentPermission, AgentProtector } from '../src/agent-types.js';
import type { LocalNote } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const tsxCli = join(dirname(require_.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const directories: string[] = [];
const services: AgentService[] = [];
const clients: Client[] = [];
const servers: Server[] = [];
// Portable test protection only. The installed entry supplies Windows DPAPI instead.
const protector: AgentProtector = { protect: value => Buffer.from(value).toString('base64'), unprotect: value => Buffer.from(value, 'base64').toString('utf8') };
const originalNote: LocalNote = { id: randomUUID(), title: 'Owner note', body: 'Full private body '.repeat(30),
  createdAt: '2026-10-29T10:00:00.000Z', updatedAt: '2026-10-29T10:00:00.000Z' };

async function fixture(permissions: readonly AgentPermission[] = ['notes:read'], execute?: AgentServiceOptions['execute']) {
  const directory = await mkdtemp(join(tmpdir(), 'interego-agent-stdio-'));
  directories.push(directory);
  const operations: AgentOperation[] = []; const notes = [originalNote];
  const service = new AgentService({ dataDir: directory, protector, getPodBinding: async () => 'test-owned-pod',
    execute: execute ?? (async (operation, args, authorize) => {
      const principal = await authorize(); operations.push(operation);
      const input = args as Record<string, string>;
      if (operation === 'status') return { running: true, localOnly: true, federationEnabled: false, secret: 'not-public' };
      if (operation === 'notes.search') return { notes: notes.map(note => ({ ...note, excerpt: note.body.slice(0, 240), secret: 'not-public' })) };
      if (operation === 'notes.read') return { note: notes.find(note => note.id === input['id']) };
      const note = { id: randomUUID(), title: input['title']!, body: input['body']!, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), author: { connectionId: principal.id, name: principal.name } };
      notes.push(note); return { note };
    }) });
  services.push(service); const endpoint = await service.start();
  const connection = await service.create({ name: 'My local client', client: 'codex', permissions, expiresInDays: 7 });
  const script = join(directory, 'companion.mts');
  await writeFile(script, `import {runAgentStdio} from ${JSON.stringify(pathToFileURL(resolve(here, '../src/agent-stdio.ts')).href)};\nconst handle = await runAgentStdio({dataDir:process.argv[2],connectionId:process.argv[3],protector:{protect(value){throw new Error('Companion cannot issue tickets')},unprotect(value){const text=Buffer.from(value,'base64').toString('utf8');if(JSON.parse(text).connectionId!==process.argv[3])throw new Error('Only own ticket allowed');return text}}});\nawait handle.closed;\n`);
  const connect = async (mode: 'legacy' | 'auto' = 'legacy') => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [tsxCli, script, directory, connection.id], stderr: 'ignore',
      env: { ...process.env, NODE_OPTIONS: '' } as Record<string, string> });
    const client = new Client({ name: 'interego-installed-client-test', version: '1.0.0' }, mode === 'auto' ? { versionNegotiation: { mode: 'auto' } } : undefined);
    clients.push(client); await client.connect(transport); return client;
  };
  return { directory, endpoint, connection, service, operations, notes, connect };
}
function content<T>(value: unknown): T {
  const result = value as { isError?: boolean; structuredContent?: T; content: Array<{ text?: string }> };
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  expect(JSON.parse(result.content[0]!.text!)).toEqual(result.structuredContent);
  return result.structuredContent!;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-agent-stdio-')) await rm(directory, { recursive: true, force: true });
  }
});

describe('installed local stdio companion', () => {
  for (const mode of ['legacy', 'auto'] as const) {
    it(`serves a real ${mode} MCP client, with summaries separate from full note reads`, async () => {
      const f = await fixture(); const client = await f.connect(mode);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual(['interego_read_note', 'interego_search_notes', 'interego_status']);
      const status = content<{ connection: AgentConnection; running: boolean }>(await client.callTool({ name: 'interego_status', arguments: {} }));
      expect(status.connection.id).toBe(f.connection.id); expect(status.running).toBe(true);
      expect(JSON.stringify(status)).not.toContain('not-public');
      const summary = content<{ notes: Array<{ excerpt: string }> }>(await client.callTool({ name: 'interego_search_notes', arguments: { query: '', limit: 10 } }));
      expect(summary.notes[0]!.excerpt).toBe(originalNote.body.slice(0, 240));
      expect(summary.notes[0]).not.toHaveProperty('body'); expect(summary.notes[0]).not.toHaveProperty('secret');
      const read = content<{ note: LocalNote }>(await client.callTool({ name: 'interego_read_note', arguments: { id: originalNote.id } }));
      expect(read.note).toEqual(originalNote);
      expect((await f.service.get(f.connection.id)).state).toBe('active');
      await client.close();
    }, 45_000);
  }

  it('offers append-only saving to a create-only grant and rechecks revocation on list and call', async () => {
    const f = await fixture(['notes:create']); const client = await f.connect();
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['interego_save_note', 'interego_status']);
    const saved = content<{ note: LocalNote }>(await client.callTool({ name: 'interego_save_note', arguments: { title: 'Agent observation', body: 'Save this useful detail.' } }));
    expect(saved.note.author).toEqual({ connectionId: f.connection.id, name: f.connection.name });
    expect(f.notes).toHaveLength(2); expect(f.notes[0]).toEqual(originalNote);
    const denied = await client.callTool({ name: 'interego_read_note', arguments: { id: originalNote.id } });
    expect(denied).toMatchObject({ isError: true }); expect(f.operations).not.toContain('notes.read');
    await f.service.revoke(f.connection.id);
    await expect(client.listTools()).rejects.toThrow();
    expect(await client.callTool({ name: 'interego_save_note', arguments: { title: 'Denied', body: 'No write.' } })).toMatchObject({ isError: true });
    expect(f.notes).toHaveLength(2);
  }, 45_000);

  it('rejects unsupported tools and arguments before note operations reach the broker', async () => {
    const f = await fixture(['notes:read', 'notes:create']); const client = await f.connect();
    for (const call of [
      { name: 'owner_delete_note', arguments: {} },
      { name: 'interego_status', arguments: { ownerKey: true } },
      { name: 'interego_read_note', arguments: { id: '../notes-key.json' } },
      { name: 'interego_search_notes', arguments: { query: '', limit: 51 } },
      { name: 'interego_save_note', arguments: { title: 'Replace', body: 'No', id: originalNote.id } },
    ]) expect(await client.callTool(call)).toMatchObject({ isError: true });
    expect(f.operations.filter(operation => operation !== 'status')).toEqual([]);
  }, 45_000);

  it('cancels a queued write when the MCP client closes its pipe', async () => {
    let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    let finish!: () => void; const finished = new Promise<void>(done => { finish = done; });
    let writes = 0;
    const f = await fixture(['notes:create'], async (operation, _args, authorize) => {
      if (operation === 'status') return { running: true, localOnly: true, federationEnabled: false };
      entered(); await gate;
      try { await authorize(); writes++; return { note: originalNote }; } finally { finish(); }
    });
    const client = await f.connect();
    const pending = client.callTool({ name: 'interego_save_note', arguments: { title: 'Queued', body: 'Must not commit after close.' } }).catch(() => undefined);
    try { await started; await client.close(); }
    finally { release(); }
    await finished; await pending; expect(writes).toBe(0);
  }, 45_000);

  it('refuses remote endpoints, redirects and oversized HTTP responses', async () => {
    const f = await fixture(); const client = new AgentClient({ dataDir: f.directory, connectionId: f.connection.id, protector });
    await writeFile(join(f.directory, 'endpoint.json'), JSON.stringify({ ...f.endpoint, url: 'https://example.invalid/agent' }));
    await expect(client.request('status')).rejects.toThrow('unavailable');
    let requests = 0; let mode: 'redirect' | 'large' = 'redirect';
    const server = createServer((_request, response) => {
      requests++;
      if (mode === 'redirect') { response.writeHead(302, { location: f.endpoint.url }); response.end(); }
      else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(Buffer.alloc(MAX_AGENT_RESPONSE_BYTES + 1, 32)); }
    });
    servers.push(server); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected test TCP endpoint');
    await writeFile(join(f.directory, 'endpoint.json'), JSON.stringify({ ...f.endpoint, url: `http://127.0.0.1:${address.port}/agent` }));
    await expect(client.request('status')).rejects.toThrow('unavailable');
    expect(requests).toBe(1); expect(f.operations).toEqual([]);
    mode = 'large'; await expect(client.request('status')).rejects.toThrow('unavailable'); expect(requests).toBe(2);
    const ticketFile = JSON.parse(await readFile(join(f.directory, 'tickets', `${f.connection.id}.json`), 'utf8')) as { ciphertext: string };
    const ticket = JSON.parse(protector.unprotect(ticketFile.ciphertext)) as { secret: string };
    expect(JSON.stringify(f.connection)).not.toContain(ticket.secret);
  });
});
