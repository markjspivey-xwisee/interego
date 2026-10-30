import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { AgentService, type AgentServiceOptions } from '../src/agent-service.js';
import {
  AGENT_REQUEST_WINDOW_MS, MAX_AGENT_REQUEST_BYTES, openAgentMessage, sealAgentMessage, type AgentEnvelope,
} from '../src/agent-protocol.js';
import type { AgentConnectionInput, AgentEndpoint, AgentOperation, AgentPrincipal, AgentProtector, AgentTicket } from '../src/agent-types.js';

const input: AgentConnectionInput = { name: 'My coding agent', client: 'codex', permissions: ['notes:read'], expiresInDays: 7 };
const services: AgentService[] = [];
const directories: string[] = [];
function protector(): AgentProtector {
  const key = randomBytes(32);
  return {
    protect(value) {
      const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
      return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64');
    },
    unprotect(value) {
      const bytes = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
    },
  };
}
async function fixture(overrides: Partial<AgentServiceOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'interego-agent-test-'));
  directories.push(directory);
  const protection = protector();
  let binding: string | null = 'pod-fingerprint-a';
  const executed: AgentOperation[] = [];
  const options: AgentServiceOptions = { dataDir: directory, protector: protection, getPodBinding: async () => binding,
    execute: async (operation, _args, authorize) => {
      await authorize(); executed.push(operation);
      return operation === 'status' ? { running: false, localOnly: true, federationEnabled: false } : { body: 'private note text' };
    }, ...overrides };
  const service = new AgentService(options); services.push(service);
  const endpoint = await service.start();
  const connection = await service.create(input);
  const loadTicket = async (id = connection.id) => {
    const wrapper = JSON.parse(await readFile(join(directory, 'tickets', `${id}.json`), 'utf8')) as { ciphertext: string };
    return JSON.parse(protection.unprotect(wrapper.ciphertext)) as AgentTicket;
  };
  return { service, options, directory, endpoint, connection, loadTicket, executed, setBinding: (value: string | null) => { binding = value; } };
}
function envelope(ticket: AgentTicket, endpoint: AgentEndpoint, operation: AgentOperation = 'status', issuedAt = Date.now(), args: unknown = {}) {
  return sealAgentMessage(ticket, endpoint, randomUUID(), 'request', { issuedAt, operation, arguments: args });
}
async function post(endpoint: AgentEndpoint, message: unknown) {
  const response = await fetch(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
  return { status: response.status, body: await response.json() as unknown };
}
async function decrypted(ticket: AgentTicket, endpoint: AgentEndpoint, message: AgentEnvelope) {
  const response = await post(endpoint, message);
  expect(response.status).toBe(200);
  const wire = response.body as AgentEnvelope;
  expect(wire.requestId).toBe(message.requestId);
  expect(JSON.stringify(wire)).not.toContain('private note text');
  return openAgentMessage(ticket, endpoint, wire, 'response') as { ok: boolean; value?: unknown; error?: string };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-agent-test-')) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe('encrypted local agent access', () => {
  it('keeps secrets out of public grants and HTTP, and persists authenticated use', async () => {
    const f = await fixture(); const ticket = await f.loadTicket();
    expect(f.connection.state).toBe('waiting');
    expect(f.connection).not.toHaveProperty('secret');
    expect(f.connection).not.toHaveProperty('podBinding');
    const read = await decrypted(ticket, f.endpoint, envelope(ticket, f.endpoint, 'notes.read'));
    expect(read).toEqual({ ok: true, value: { body: 'private note text' } });
    const status = await decrypted(ticket, f.endpoint, envelope(ticket, f.endpoint));
    expect(status).toMatchObject({ ok: true, value: { running: false, localOnly: true, federationEnabled: false, connection: { state: 'active', id: f.connection.id } } });
    expect((await f.service.get(f.connection.id)).lastUsedAt).toBeDefined();
    expect(await readFile(join(f.directory, 'connections.json'), 'utf8')).not.toContain(ticket.secret);
    expect(await readFile(join(f.directory, 'tickets', `${f.connection.id}.json`), 'utf8')).not.toContain(ticket.secret);
    await f.service.close();
    const replacement = new AgentService(f.options); services.push(replacement);
    const endpoint = await replacement.start();
    expect(endpoint.sessionId).not.toBe(f.endpoint.sessionId);
    expect((await replacement.list())[0]?.state).toBe('active');
    expect((await post(endpoint, envelope(ticket, f.endpoint))).status).toBe(401);
    expect((await decrypted(ticket, endpoint, envelope(ticket, endpoint))).ok).toBe(true);
  });

  it('binds ciphertext to direction, session, connection and request', async () => {
    const f = await fixture(); const ticket = await f.loadTicket(); const request = envelope(ticket, f.endpoint);
    expect(() => openAgentMessage(ticket, f.endpoint, request, 'response')).toThrow();
    expect(() => openAgentMessage(ticket, f.endpoint, { ...request, requestId: randomUUID() }, 'request')).toThrow();
    expect(() => openAgentMessage(ticket, { ...f.endpoint, sessionId: randomUUID() }, request, 'request')).toThrow();
    expect(() => openAgentMessage({ ...ticket, connectionId: randomUUID() }, f.endpoint, request, 'request')).toThrow();
    const wrong = { ...ticket, secret: randomBytes(32).toString('base64') };
    expect((await post(f.endpoint, envelope(wrong, f.endpoint))).status).toBe(401);
    expect(f.executed).toEqual([]);
    expect((await f.service.get(f.connection.id)).state).toBe('waiting');
  });

  it('refuses replays, old/future requests, malformed messages and unsupported operations', async () => {
    const f = await fixture(); const ticket = await f.loadTicket(); const request = envelope(ticket, f.endpoint);
    expect((await post(f.endpoint, request)).status).toBe(200);
    expect((await post(f.endpoint, request)).status).toBe(401);
    expect((await post(f.endpoint, envelope(ticket, f.endpoint, 'status', Date.now() - AGENT_REQUEST_WINDOW_MS - 1000))).status).toBe(401);
    expect((await post(f.endpoint, envelope(ticket, f.endpoint, 'status', Date.now() + AGENT_REQUEST_WINDOW_MS + 1000))).status).toBe(401);
    expect((await post(f.endpoint, { ...request, extra: 'smuggled' })).status).toBe(401);
    expect((await post(f.endpoint, [])).status).toBe(401);
    const arbitrary = sealAgentMessage(ticket, f.endpoint, randomUUID(), 'request', { issuedAt: Date.now(), operation: 'backup', arguments: {} });
    expect((await post(f.endpoint, arbitrary)).status).toBe(401);
    expect(f.executed).toEqual(['status']);
  });

  it('enforces read/create permissions, revocation, expiry and changed pods', async () => {
    const f = await fixture(); const ticket = await f.loadTicket();
    expect((await decrypted(ticket, f.endpoint, envelope(ticket, f.endpoint, 'notes.create'))).ok).toBe(false);
    expect(f.executed).toEqual([]);
    f.setBinding('different-pod');
    expect((await f.service.get(f.connection.id)).state).toBe('pod-changed');
    expect((await decrypted(ticket, f.endpoint, envelope(ticket, f.endpoint))).ok).toBe(false);
    f.setBinding('pod-fingerprint-a');
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 86_400_000);
    expect((await f.service.get(f.connection.id)).state).toBe('expired');
    expect((await decrypted(ticket, f.endpoint, envelope(ticket, f.endpoint))).ok).toBe(false);
    vi.restoreAllMocks();
    expect((await f.service.revoke(f.connection.id)).state).toBe('revoked');
    expect((await decrypted(ticket, f.endpoint, envelope(ticket, f.endpoint))).ok).toBe(false);
    await f.service.close();
    const replacement = new AgentService(f.options); services.push(replacement);
    await replacement.start();
    expect((await replacement.get(f.connection.id)).state).toBe('revoked');
  });

  it('does not release results after revocation during execution or queue admission', async () => {
    let entered!: () => void; let finish!: () => void;
    const enteredPromise = new Promise<void>(done => { entered = done; });
    const gate = new Promise<void>(done => { finish = done; });
    let completed = false;
    const f = await fixture({ execute: async (_operation, _args, authorize) => {
      entered(); await gate; await authorize(); completed = true; return { body: 'private note text' };
    } });
    const ticket = await f.loadTicket();
    const pending = decrypted(ticket, f.endpoint, envelope(ticket, f.endpoint, 'notes.read'));
    await enteredPromise;
    await f.service.revoke(f.connection.id);
    finish();
    expect((await pending).ok).toBe(false);
    expect(completed).toBe(false);
    expect((await f.service.get(f.connection.id)).lastUsedAt).toBeUndefined();
  });

  it('refuses a disconnected caller before its queued action begins', async () => {
    let entered!: () => void; let finish!: () => void; let completed!: () => void;
    let reauthorize!: () => Promise<AgentPrincipal>;
    const enteredPromise = new Promise<void>(done => { entered = done; });
    const gate = new Promise<void>(done => { finish = done; });
    const finished = new Promise<void>(done => { completed = done; });
    let wrote = false;
    const f = await fixture({ execute: async (_operation, _args, authorize) => {
      reauthorize = authorize; entered();
      try { await gate; await authorize(); wrote = true; return {}; }
      finally { completed(); }
    } });
    const ticket = await f.loadTicket(); const abort = new AbortController();
    const pending = fetch(f.endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope(ticket, f.endpoint)), signal: abort.signal }).catch(() => null);
    await enteredPromise; abort.abort(); await pending;
    await vi.waitFor(async () => { await expect(reauthorize()).rejects.toThrow(); });
    finish(); await finished;
    expect(wrote).toBe(false);
    expect((await f.service.get(f.connection.id)).lastUsedAt).toBeUndefined();
  });

  it('rejects browser origins, wrong Host, other paths/methods/media and oversized bodies', async () => {
    const f = await fixture();
    const raw = (method: string, path: string, headers: Record<string, string>, body = '{}') => new Promise<number>((done, fail) => {
      const url = new URL(f.endpoint.url);
      const request = httpRequest({ hostname: url.hostname, port: url.port, path, method,
        headers: { 'content-type': 'application/json', ...headers } }, response => { response.resume(); response.once('end', () => done(response.statusCode!)); });
      request.once('error', fail); request.end(body);
    });
    expect(await raw('POST', '/agent', { origin: 'https://evil.example' })).toBe(403);
    expect(await raw('POST', '/agent', { origin: 'null' })).toBe(403);
    expect(await raw('POST', '/agent', { host: 'localhost:1234' })).toBe(403);
    expect(await raw('POST', '/agent?token=no', {})).toBe(404);
    expect(await raw('GET', '/agent', {})).toBe(405);
    expect(await raw('POST', '/agent', { 'content-type': 'text/plain' })).toBe(415);
    expect(await raw('POST', '/agent', {}, 'x'.repeat(MAX_AGENT_REQUEST_BYTES + 1))).toBe(413);
    expect(f.executed).toEqual([]);
  });

  it('validates enrollment, persists before admitting grants, and treats orphan tickets as unauthorized', async () => {
    const f = await fixture();
    for (const value of [ { ...input, name: '../\ninvalid' }, { ...input, permissions: [] },
      { ...input, permissions: ['notes:read', 'notes:read'] }, { ...input, expiresInDays: 365 },
      { ...input, client: 'invented' }, { ...input, extra: true } ]) {
      await expect(f.service.create(value as AgentConnectionInput)).rejects.toThrow();
    }
    f.setBinding(null);
    await expect(f.service.create(input)).rejects.toThrow(/pod/i);
    expect((await f.service.list()).length).toBe(1);
    // The ticket is written successfully, but the registry cannot be replaced.
    f.setBinding('pod-fingerprint-a');
    await rm(join(f.directory, 'connections.json'));
    await mkdir(join(f.directory, 'connections.json'));
    await expect(f.service.create(input)).rejects.toThrow();
    expect((await f.service.list()).length).toBe(1);
    const tickets = await readdir(join(f.directory, 'tickets'));
    const orphanId = tickets.map(name => name.replace(/\.json$/, '')).find(id => id !== f.connection.id)!;
    const orphan = await f.loadTicket(orphanId);
    expect((await post(f.endpoint, envelope(orphan, f.endpoint))).status).toBe(401);
  });

  it('bounds concurrent authenticated executions and closes its listener', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(done => { finish = done; });
    let count = 0; let entered!: () => void;
    const enteredAll = new Promise<void>(done => { entered = done; });
    const f = await fixture({ execute: async (_operation, _args, authorize) => {
      await authorize(); count++; if (count === 8) entered(); await gate; return { running: false, localOnly: true, federationEnabled: false };
    } });
    const ticket = await f.loadTicket();
    const requests = Array.from({ length: 8 }, () => post(f.endpoint, envelope(ticket, f.endpoint)));
    await enteredAll;
    expect((await post(f.endpoint, envelope(ticket, f.endpoint))).status).toBe(429);
    finish(); await Promise.all(requests);
    await f.service.close();
    await expect(fetch(f.endpoint.url)).rejects.toThrow();
    await expect(readFile(join(f.directory, 'endpoint.json'))).rejects.toThrow();
  });

  it('reclaims the oldest inactive slot at capacity while retaining all active grants', async () => {
    const f = await fixture(); const oldTicket = await f.loadTicket();
    await f.service.close();
    const wrapper = JSON.parse(await readFile(join(f.directory, 'connections.json'), 'utf8')) as { ciphertext: string };
    const original = (JSON.parse(f.options.protector.unprotect(wrapper.ciphertext)) as Record<string, unknown>[])[0]!;
    const revoked = { ...original, createdAt: '2026-01-01T00:00:00Z', revokedAt: new Date().toISOString() };
    const active = Array.from({ length: 63 }, () => ({ ...original, id: randomUUID(), secret: randomBytes(32).toString('base64') }));
    await writeFile(join(f.directory, 'connections.json'), JSON.stringify({ version: 1,
      ciphertext: f.options.protector.protect(JSON.stringify([revoked, ...active])) }));
    const replacement = new AgentService(f.options); services.push(replacement);
    const endpoint = await replacement.start();
    await replacement.create(input);
    const ids = (await replacement.list()).map(record => record.id);
    expect(ids).toHaveLength(64);
    expect(ids).not.toContain(f.connection.id);
    expect(active.every(record => ids.includes(String(record.id)))).toBe(true);
    expect((await post(endpoint, envelope(oldTicket, endpoint))).status).toBe(401);
    await expect(replacement.create(input)).rejects.toThrow(/64 active/);
  });
});
