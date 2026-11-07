import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { AgentService } from '../src/agent-service.js';
import { AgentClient, agentArguments } from '../src/agent-client.js';
import { AGENT_TOOLS, agentToolPermitted, agentToolResult } from '../src/agent-stdio.js';
import type { AgentPermission } from '../src/agent-types.js';
import { WorkspaceService } from '../src/workspace-service.js';
import { WORKSPACE_ACTIONS as A, type WorkspaceActRequest, type WorkspacePrincipal, type WorkspaceRepresentation } from '../src/workspace-types.js';

const directories: string[] = [];
const services: AgentService[] = [];
const protector = { protect: (value: string) => Buffer.from(value).toString('base64'), unprotect: (value: string) => Buffer.from(value, 'base64').toString('utf8') };
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-workspace-agent-')) await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'interego-workspace-agent-')); directories.push(directory);
  let saved: unknown | null = null;
  const workspace = new WorkspaceService({ binding: async () => 'isolated-workspace-pod', store: { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } } });
  await workspace.act({ action: A.ENABLE });
  const room = (await workspace.act({ action: A.CREATE, input: { title: 'Family chat' } })).workspace!;
  const other = (await workspace.act({ action: A.CREATE, input: { title: 'Unselected space' } })).workspace!;
  let before: (() => Promise<void>) | undefined;
  let after: (() => Promise<void>) | undefined;
  const failures: string[] = [];
  const service = new AgentService({ dataDir: directory, protector, getPodBinding: async () => 'isolated-workspace-pod',
    execute: async (operation, args, authorize) => {
      const principal = (): Promise<WorkspacePrincipal> => authorize().then(value => ({ kind: 'agent', id: value.id, name: value.name,
        permissions: value.permissions.filter((permission): permission is 'workspaces:read' | 'workspaces:chat' => permission.startsWith('workspaces:')),
        workspaceIds: value.workspaceIds ?? [], authorize: async () => { await authorize(); } }));
      if (operation === 'status') { await authorize(); return { running: true, localOnly: true, federationEnabled: false }; }
      if (operation.startsWith('workspaces.')) {
        await before?.();
        let result: WorkspaceRepresentation;
        try { result = operation === 'workspaces.discover' ? await workspace.status(await principal()) : await workspace.act(args as WorkspaceActRequest, await principal()); }
        catch (error) { failures.push(error instanceof Error ? error.message : 'Unfamiliar workspace error'); throw error; }
        await after?.(); return result;
      }
      throw new Error('This fixture exposes only Workspaces.');
    } });
  services.push(service); await service.start();
  const connect = async (permissions: readonly AgentPermission[] = ['workspaces:read', 'workspaces:chat']) => {
    const grant = await service.create({ name: 'Chosen assistant', client: 'codex', permissions, expiresInDays: 7,
      ...(permissions.some(permission => permission.startsWith('workspaces:')) ? { workspaceIds: [room.id] } : {}) });
    return { grant, client: new AgentClient({ dataDir: directory, connectionId: grant.id, protector }) };
  };
  const invite = async (id: string) => { await workspace.act({ action: A.INVITE, target: room.id, input: { memberId: id, name: 'Chosen assistant', kind: 'agent', role: 'contributor' } }); };
  const accept = async (client: AgentClient) => {
    const representation = await client.request('workspaces.discover') as WorkspaceRepresentation;
    const invitation = representation.affordances.find(control => control.action === A.ACCEPT)!;
    await client.request('workspaces.act', { action: invitation.action, target: invitation.target });
  };
  return { directory, service, workspace, room, other, connect, invite, accept, failures, snapshot: () => structuredClone(saved), pauseBefore: (hook?: () => Promise<void>) => { before = hook; }, pauseAfter: (hook?: () => Promise<void>) => { after = hook; } };
}

describe('explicit workspace grants across the encrypted agent broker', () => {
  it('keeps old notes grants unchanged and requires a nonempty exact workspace selection', async () => {
    const f = await fixture(); const notes = await f.connect(['notes:read']);
    expect(notes.grant).not.toHaveProperty('workspaceIds');
    await expect(notes.client.request('workspaces.discover')).rejects.toThrow();
    for (const workspaceIds of [undefined, [], ['*'], [randomUUID()], [f.room.id, f.room.id]]) {
      await expect(f.service.create({ name: 'Agent', client: 'codex', expiresInDays: 7, permissions: ['workspaces:read'], workspaceIds })).rejects.toThrow();
    }
  });

  it('discovers the invitation, accepts it, follows read and post controls, and preserves JSON-LD and connection authorship', async () => {
    const f = await fixture(); const { grant, client } = await f.connect(); await f.invite(grant.id);
    let discovery = await client.request('workspaces.discover') as WorkspaceRepresentation;
    expect(discovery.workspaces?.map(room => room.id)).toEqual([f.room.id]);
    expect(JSON.stringify(discovery)).not.toContain(f.other.title);
    expect(discovery.affordances.some(control => control.action === A.ACCEPT)).toBe(true);
    await f.accept(client);
    discovery = await client.request('workspaces.discover') as WorkspaceRepresentation;
    const read = discovery.affordances.find(control => control.action === A.READ)!;
    const representation = await client.request('workspaces.act', { action: read.action, target: read.target }) as WorkspaceRepresentation;
    const post = representation.affordances.find(control => control.action === A.POST)!;
    const written = await client.request('workspaces.act', { action: post.action, target: post.target, input: { body: 'Hello from my assistant' } }) as WorkspaceRepresentation;
    expect(written.entry?.author).toEqual({ '@id': `${discovery.id}:member:${encodeURIComponent(grant.id)}`, kind: 'agent', id: grant.id, name: grant.name });
    expect(agentToolResult('workspaces.act', written, grant.id)).toEqual(written);
    expect(written['@context']).toBeDefined(); expect(written.entry?.turtle).toContain('Hello from my assistant');
    await expect(client.request('workspaces.act', { action: A.READ, target: f.other.id })).rejects.toThrow();
    await expect(client.request('workspaces.act', { action: A.POST, target: f.room.id, input: { body: 'Spoof', author: { kind: 'human', name: 'Owner' } } })).rejects.toThrow();
  });

  it('keeps read and chat permissions independent and does not turn read membership into a write grant', async () => {
    const f = await fixture(); const { grant, client } = await f.connect(['workspaces:read']); await f.invite(grant.id); await f.accept(client);
    const read = await client.request('workspaces.act', { action: A.READ, target: f.room.id }) as WorkspaceRepresentation;
    expect(read.affordances.some(control => control.action === A.POST)).toBe(false);
    await expect(client.request('workspaces.act', { action: A.POST, target: f.room.id, input: { body: 'Not granted' } })).rejects.toThrow();
  });

  it('refuses a revoked connection whose chat request was queued before its workspace action', async () => {
    const f = await fixture(); const { grant, client } = await f.connect(); await f.invite(grant.id); await f.accept(client);
    let entered!: () => void; const reached = new Promise<void>(done => { entered = done; });
    let resume!: () => void; const gate = new Promise<void>(done => { resume = done; });
    f.pauseBefore(async () => { entered(); await gate; });
    const pending = client.request('workspaces.act', { action: A.POST, target: f.room.id, input: { body: 'Must never be saved' } });
    await reached; await f.service.revoke(grant.id); resume(); await expect(pending).rejects.toThrow();
    const room = (await f.workspace.act({ action: A.READ, target: f.room.id })).workspace!;
    expect(room.entries).toEqual([]);
  });

  it('withholds a read result if its grant is revoked before the broker returns it', async () => {
    const f = await fixture(); const { grant, client } = await f.connect(); await f.invite(grant.id); await f.accept(client);
    let entered!: () => void; const reached = new Promise<void>(done => { entered = done; });
    let resume!: () => void; const gate = new Promise<void>(done => { resume = done; });
    f.pauseAfter(async () => { entered(); await gate; });
    const pending = client.request('workspaces.act', { action: A.READ, target: f.room.id });
    await reached; await f.service.revoke(grant.id); resume(); await expect(pending).rejects.toThrow();
  });

  it('offers only two hypermedia tools for workspace grants and preserves the old notes surface', () => {
    const names = (permissions: readonly AgentPermission[]) => AGENT_TOOLS.filter(tool => agentToolPermitted(tool, permissions)).map(tool => tool.tool.name);
    expect(names(['notes:read'])).toEqual(['interego_status', 'interego_search_notes', 'interego_read_note']);
    expect(names(['workspaces:read'])).toEqual(['interego_status', 'interego_discover', 'interego_act']);
    expect(agentArguments('workspaces.act', { action: A.READ, target: 'a current advertised target' })).toEqual({ action: A.READ, target: 'a current advertised target' });
    expect(() => agentArguments('workspaces.act', { action: A.READ, url: 'https://example.org' })).toThrow();
  });

  it('lets a real MCP client discover and follow workspace controls through a separately launched companion', async () => {
    const f = await fixture(); const { grant } = await f.connect(); await f.invite(grant.id);
    const bodies = Array.from({ length: 40 }, (_, index) => `Large message ${index}: `.padEnd(15_900, String(index % 10)));
    for (const body of bodies) await f.workspace.act({ action: A.POST, target: f.room.id, input: { body } });
    const persisted = f.snapshot() as { rooms: Array<{ id: string; entries: unknown[] }> };
    // This conversation would not fit in the existing 1 MiB encrypted broker plaintext limit.
    // The test keeps that limit intact and traverses bounded representations instead.
    expect(Buffer.byteLength(JSON.stringify(persisted.rooms.find(room => room.id === f.room.id)!.entries))).toBeGreaterThan(1024 * 1024);
    const modulePath = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../src/agent-stdio.ts')).href;
    const script = join(f.directory, 'companion.mts');
    await writeFile(script, `import {runAgentStdio} from ${JSON.stringify(modulePath)};\nconst handle = await runAgentStdio({dataDir:process.argv[2],connectionId:process.argv[3],protector:{protect(){throw new Error('Cannot issue tickets')},unprotect(value){const text=Buffer.from(value,'base64').toString('utf8');if(JSON.parse(text).connectionId!==process.argv[3])throw new Error('Wrong ticket');return text}}});\nawait handle.closed;\n`);
    const require_ = createRequire(import.meta.url);
    const tsx = join(dirname(require_.resolve('tsx/package.json')), 'dist', 'cli.mjs');
    const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, script, f.directory, grant.id], stderr: 'ignore', env: { ...process.env, NODE_OPTIONS: '' } as Record<string, string> });
    const client = new Client({ name: 'isolated-workspace-mcp-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['interego_status', 'interego_discover', 'interego_act']);
      const discovered = await client.callTool({ name: 'interego_discover', arguments: {} });
      expect(discovered.isError).not.toBe(true);
      const representation = discovered.structuredContent as unknown as WorkspaceRepresentation;
      expect(representation['@type']).toBe('hydra:Collection');
      const accept = representation.affordances.find(control => control.action === A.ACCEPT)!;
      const accepted = await client.callTool({ name: 'interego_act', arguments: { action: accept.action, target: accept.target } });
      expect(accepted.isError, JSON.stringify({ reply: accepted.content, failures: f.failures })).not.toBe(true);
      const read = await client.callTool({ name: 'interego_act', arguments: { action: A.READ, target: f.room.id } });
      expect(read.isError).not.toBe(true);
      const room = read.structuredContent as unknown as WorkspaceRepresentation;
      expect(room.workspace!.entries.length).toBeLessThan(bodies.length);
      expect(Buffer.byteLength(JSON.stringify(room))).toBeLessThan(512 * 1024);
      const received: string[] = []; let afterSeq = -1;
      for (let round = 0; received.length < bodies.length && round < 100; round++) {
        const pageResult = await client.callTool({ name: 'interego_act', arguments: { action: A.READ, target: f.room.id, input: { afterSeq, limit: 50 } } });
        expect(pageResult.isError).not.toBe(true);
        const page = pageResult.structuredContent as unknown as WorkspaceRepresentation;
        expect(page.workspace!.entries.length).toBeGreaterThan(0);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(512 * 1024);
        received.push(...page.workspace!.entries.map(entry => entry.body));
        afterSeq = page.workspace!.entries.at(-1)!.seq;
      }
      expect(received).toEqual(bodies);
      const post = room.affordances.find(control => control.action === A.POST)!;
      const written = await client.callTool({ name: 'interego_act', arguments: { action: post.action, target: post.target, input: { body: 'Posted over real MCP' } } });
      expect(written.isError).not.toBe(true);
      expect((written.structuredContent as unknown as WorkspaceRepresentation).entry?.author.id).toBe(grant.id);
    } finally { await client.close(); }
  });
});
