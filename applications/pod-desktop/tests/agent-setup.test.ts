import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentSetup } from '../src/agent-setup.js';
import type { AgentClient, AgentConnection } from '../src/agent-types.js';

const id = '3db6c121-0e15-4d77-b67e-f55a7d8657aa';
const connection: AgentConnection = { id, name: 'My agent', client: 'codex', permissions: ['notes:read'],
  state: 'waiting', createdAt: '2026-10-29T12:00:00.000Z', expiresAt: '2026-11-05T12:00:00.000Z' };
const launch = { command: join(tmpdir(), "Interego's $App ` folder", 'Interego.exe'), args: [join(tmpdir(), 'main entry.mjs')] };
const userData = join(tmpdir(), "Owner's $pod ` data");
const clients: readonly AgentClient[] = ['codex', 'chatgpt-desktop', 'claude-code', 'claude-desktop', 'grok-build', 'openclaw', 'other'];
const name = `interego-${id}`;
const expectedArgs = [...launch.args, '--mcp-stdio', '--connection', id, '--pod-data-dir', userData];
interface LaunchEntry { command: string; args: string[]; env: Record<string, string>; requestTimeoutMs?: number; }

describe('local agent setup', () => {
  for (const client of clients) {
    it(`produces a scoped local launch for ${client} without exporting a credential`, () => {
      const result = buildAgentSetup({ ...connection, client }, launch, userData);
      expect(result.connectionId).toBe(id);
      expect(result.steps.join(' ')).toContain('AI provider');
      expect(result.steps.join(' ')).toContain('Interego open');
      let entry: LaunchEntry;
      if (['codex', 'chatgpt-desktop', 'grok-build'].includes(client)) {
        expect(result.configuration).toContain(`[mcp_servers.${name}]`);
        const assignment = (key: string) => JSON.parse(result.configuration.split('\n').find(line => line.startsWith(`${key} = `))!.slice(key.length + 3)) as unknown;
        entry = { command: assignment('command') as string, args: assignment('args') as string[], env: { NODE_OPTIONS: '' } };
        expect(result.configuration).toContain('NODE_OPTIONS = ""');
        expect(result.configuration).toContain('tool_timeout_sec = 180');
      } else {
        const config = JSON.parse(result.configuration) as { mcpServers: Record<string, LaunchEntry>; mcp: { servers: Record<string, LaunchEntry> } };
        entry = (client === 'openclaw' ? config.mcp.servers[name] : config.mcpServers[name])!;
        if (client === 'openclaw') expect(entry.requestTimeoutMs).toBe(180_000);
      }
      expect(entry.command).toBe(launch.command);
      expect(entry.args).toEqual(expectedArgs);
      expect(entry.env).toEqual({ NODE_OPTIONS: '' });
      expect(result.configuration).not.toContain('ELECTRON_RUN_AS_NODE');
      expect(result.configuration).not.toMatch(/secret|ciphertext|Authorization|Bearer|service-credential|privateKey/i);
      expect(Object.keys(entry)).not.toContain('url');
    });
  }

  it('quotes Windows PowerShell commands as literal arguments, including apostrophes and shell expressions', () => {
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    for (const client of ['codex', 'claude-code'] as const) {
      const result = buildAgentSetup({ ...connection, client }, launch, userData);
      expect(result.command).toContain(`-- ${[launch.command, ...expectedArgs].map(literal).join(' ')}`);
      expect(result.command).not.toContain('ELECTRON_RUN_AS_NODE');
      expect(result.command).toContain("--env 'NODE_OPTIONS='");
      expect(result.steps.join(' ')).toContain('In PowerShell');
    }
  });

  it('uses a distinct server name per connection and refuses revoked, malformed or injected launches', () => {
    const second = buildAgentSetup({ ...connection, id: '5136a222-ade4-4b29-8b81-9316a147b510' }, launch, userData);
    expect(second.configuration).not.toContain(`[mcp_servers.${name}]`);
    for (const state of ['revoked', 'expired', 'pod-changed'] as const) expect(() => buildAgentSetup({ ...connection, state }, launch, userData)).toThrow('unavailable');
    expect(() => buildAgentSetup({ ...connection, id: '../owner' }, launch, userData)).toThrow('unavailable');
    expect(() => buildAgentSetup(connection, { command: 'Interego.exe', args: [] }, userData)).toThrow('unavailable');
    expect(() => buildAgentSetup(connection, { ...launch, args: ['--connection'] }, userData)).toThrow('unavailable');
    expect(() => buildAgentSetup(connection, { ...launch, args: ['hello\n[another.server]'] }, userData)).toThrow('unavailable');
    expect(() => buildAgentSetup(connection, launch, 'relative-folder')).toThrow('unavailable');
  });
});
