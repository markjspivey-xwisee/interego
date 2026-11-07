import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_DIAGNOSTIC_LINE, AgentClient } from '../src/agent-client.js';
import { sealAgentMessage, type AgentEnvelope } from '../src/agent-protocol.js';
import type { AgentEndpoint, AgentProtector, AgentTicket } from '../src/agent-types.js';

const directories: string[] = [];
const servers: Server[] = [];
const unavailable = 'This agent connection is unavailable. Open Interego and check its permissions.';
async function fixture(mode: 'success' | 'http' | 'json' | 'request' | 'tag' | 'refusal' = 'success') {
  const directory = await mkdtemp(join(tmpdir(), 'interego-agent-diagnostics-')); directories.push(directory);
  const ticket: AgentTicket = { version: 1, connectionId: randomUUID(), secret: randomBytes(32).toString('base64') };
  const protection: AgentProtector = { protect: value => Buffer.from(value).toString('base64'), unprotect: value => Buffer.from(value, 'base64').toString() };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const envelope = JSON.parse(Buffer.concat(chunks).toString()) as AgentEnvelope;
    if (mode === 'http') { response.writeHead(401); response.end('secret OS error must not leak'); return; }
    if (mode === 'json') { response.end('secret invalid response must not leak'); return; }
    const result = sealAgentMessage(ticket, endpoint, envelope.requestId, 'response', mode === 'refusal'
      ? { ok: false, error: 'The connection has been revoked.' } : { ok: true, value: { privateNote: 'must-not-be-diagnostic' } });
    response.end(JSON.stringify(mode === 'request' ? { ...result, requestId: randomUUID() }
      : mode === 'tag' ? { ...result, tag: randomBytes(16).toString('base64') } : result));
  }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const endpoint: AgentEndpoint = { version: 1, url: `http://127.0.0.1:${address.port}/agent`, sessionId: randomUUID() };
  const ticketPath = join(directory, 'tickets', `${ticket.connectionId}.json`); const endpointPath = join(directory, 'endpoint.json');
  await mkdir(join(directory, 'tickets')); await writeFile(ticketPath, JSON.stringify({ version: 1, ciphertext: protection.protect(JSON.stringify(ticket)) }));
  await writeFile(endpointPath, JSON.stringify(endpoint));
  return { directory, ticket, endpoint, protection, ticketPath, endpointPath,
    client: (protector = protection) => new AgentClient({ dataDir: directory, connectionId: ticket.connectionId, protector }) };
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('safe packaged agent failure diagnostics', () => {
  it('distinguishes ticket read, OS unprotect and endpoint stages without leaking exceptions or credentials', async () => {
    vi.stubEnv('INTEREGO_POD_DIAGNOSTICS', '1'); const log = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const f = await fixture();
    await expect(f.client({ ...f.protection, unprotect: () => { throw new Error(`Secret ${f.ticket.secret} at C:\\Users\\private\\Local State`); } }).request('status')).rejects.toThrow(unavailable);
    expect(log.mock.calls.map(call => call[0])).toEqual(['interego-agent-failure:ticket-unprotect:unavailable\n']); log.mockClear();
    await unlink(f.endpointPath); await expect(f.client().request('status')).rejects.toThrow(unavailable);
    expect(log.mock.calls.map(call => call[0])).toEqual(['interego-agent-failure:endpoint-read:ENOENT\n']); log.mockClear();
    await unlink(f.ticketPath); await expect(f.client().request('status')).rejects.toThrow(unavailable);
    expect(log.mock.calls.map(call => call[0])).toEqual(['interego-agent-failure:ticket-read:ENOENT\n']);
  });

  it.each([
    ['http', 'broker-http:http-401'], ['json', 'response-json:unavailable'], ['request', 'response-bind:unavailable'],
    ['tag', 'response-authenticate:unavailable'], ['refusal', 'broker-refusal:unavailable'],
  ] as const)('identifies %s failure using only a fixed label', async (mode, label) => {
    vi.stubEnv('INTEREGO_POD_DIAGNOSTICS', '1'); const log = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const f = await fixture(mode); await expect(f.client().request('status')).rejects.toThrow(mode === 'refusal' ? 'revoked' : unavailable);
    expect(log.mock.calls.map(call => call[0])).toEqual([`interego-agent-failure:${label}\n`]);
    expect(AGENT_DIAGNOSTIC_LINE.test(`interego-agent-failure:${label}`)).toBe(true);
  });

  it('keeps normal operation quiet, and requires explicit diagnostics for failures', async () => {
    const log = vi.spyOn(process.stderr, 'write').mockReturnValue(true); const f = await fixture();
    vi.stubEnv('INTEREGO_POD_DIAGNOSTICS', '1'); expect(await f.client().request('status')).toEqual({ privateNote: 'must-not-be-diagnostic' });
    vi.stubEnv('INTEREGO_POD_DIAGNOSTICS', '0'); await unlink(f.ticketPath); await expect(f.client().request('status')).rejects.toThrow(unavailable);
    expect(log).not.toHaveBeenCalled();
  });

  it('permits forwarding only exact application stage labels', () => {
    for (const value of ['Chromium error C:\\Users\\private', 'interego-agent-failure:ticket-unprotect:secret',
      'interego-agent-failure:ticket-unprotect:unavailable extra-secret', 'interego-agent-failure:unknown:unavailable',
      'prefix interego-agent-failure:ticket-read:ENOENT']) expect(AGENT_DIAGNOSTIC_LINE.test(value)).toBe(false);
  });
});
