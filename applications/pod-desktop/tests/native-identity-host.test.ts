import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openAgentMessage, sealAgentMessage, type AgentEnvelope } from '../src/agent-protocol.js';
import type { AgentEndpoint, AgentTicket } from '../src/agent-types.js';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
let executable = '';
let buildDirectory: string | undefined;
const origin = `chrome-extension://${'a'.repeat(32)}`;
const directories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];
type RecordValue = Record<string, unknown>;
interface Call { readonly body: RecordValue; readonly envelope: AgentEnvelope; readonly wire: string }

function start(args: readonly string[]): ChildProcessWithoutNullStreams {
  const child = spawn(executable, [...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  // Rejected argv can close the process before the browser's first frame arrives.
  child.stdin.on('error', () => {});
  children.push(child);
  return child;
}
function finish(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; out: Buffer; err: string }> {
  const output: Buffer[] = []; let error = '';
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, out: Buffer.concat(output), err: error }));
  });
}
async function run(args: readonly string[], input: Buffer | string) {
  const child = start(args); const completed = finish(child);
  child.stdin.end(input);
  return completed;
}
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function frames(bytes: Buffer): RecordValue[] {
  const result: RecordValue[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset); offset += 4;
    expect(length).toBeGreaterThan(0); expect(length).toBeLessThanOrEqual(64 * 1024);
    expect(offset + length).toBeLessThanOrEqual(bytes.length);
    result.push(JSON.parse(bytes.subarray(offset, offset + length).toString('utf8')) as RecordValue);
    offset += length;
  }
  return result;
}
class NativePort {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly iterator: AsyncIterator<Buffer>;
  private buffered = Buffer.alloc(0);
  constructor(directory: string, browserOrigin = `${origin}/`) {
    this.child = start([browserOrigin, '--parent-window=0', '--pod-data-dir', directory]);
    this.iterator = this.child.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }
  async response(): Promise<RecordValue> {
    for (;;) {
      if (this.buffered.length >= 4) {
        const length = this.buffered.readUInt32LE(0);
        expect(length).toBeGreaterThan(0); expect(length).toBeLessThanOrEqual(64 * 1024);
        if (this.buffered.length >= length + 4) {
          const value = JSON.parse(this.buffered.subarray(4, length + 4).toString('utf8')) as RecordValue;
          this.buffered = this.buffered.subarray(length + 4);
          return value;
        }
      }
      const next = await this.iterator.next();
      if (next.done) throw new Error('Native identity host closed without a response.');
      this.buffered = Buffer.concat([this.buffered, next.value]);
    }
  }
}

async function fixture(response?: (call: Call, ticket: AgentTicket, endpoint: AgentEndpoint) => unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'interego-native-identity-')); directories.push(directory);
  const calls: Call[] = [];
  const ticket: AgentTicket = { version: 1, connectionId: randomUUID(), secret: randomBytes(32).toString('base64') };
  const server = createServer(async (request, reply) => {
    try {
      expect(request.method).toBe('POST'); expect(request.url).toBe('/identity-browser');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const wire = Buffer.concat(chunks).toString();
      const envelope = JSON.parse(wire) as AgentEnvelope;
      const body = openAgentMessage(ticket, endpoint, envelope, 'request') as RecordValue;
      const call = { body, envelope, wire }; calls.push(call);
      const value = response ? response(call, ticket, endpoint)
        : sealAgentMessage(ticket, endpoint, envelope.requestId, 'response', { ok: true, value: { state: 'pending', receipt: 'opaque-browser-receipt' } });
      reply.writeHead(200, { 'Content-Type': 'application/json' }); reply.end(JSON.stringify(value));
    } catch {
      reply.writeHead(500); reply.end();
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test broker port.');
  const endpoint: AgentEndpoint = { version: 1, url: `http://127.0.0.1:${address.port}/identity-browser`, sessionId: randomUUID() };
  const protectedTicket = await run(['--protect-ticket'], JSON.stringify(ticket));
  expect(protectedTicket.code).toBe(0); expect(protectedTicket.err).toBe('');
  expect(protectedTicket.out.toString()).not.toContain(ticket.secret);
  expect(Buffer.from(protectedTicket.out.toString(), 'base64').toString('base64')).toBe(protectedTicket.out.toString());
  await mkdir(join(directory, 'identity-browser'));
  await writeFile(join(directory, 'identity-browser/ticket.bin'), protectedTicket.out);
  await writeFile(join(directory, 'identity-browser/endpoint.json'), JSON.stringify(endpoint));
  return { directory, ticket, endpoint, calls };
}

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && !child.killed) child.kill();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== 'win32')('Windows native identity companion executable', () => {
  beforeAll(async () => {
    buildDirectory = await mkdtemp(join(tmpdir(), 'interego-native-host-build-'));
    executable = join(buildDirectory, 'Interego-Identity.exe');
    const outputDirectory = buildDirectory;
    await new Promise<void>((resolve, reject) => {
      const build = spawn(process.execPath, [join(appRoot, 'tools/build-native-host.mjs'), '--output-dir', outputDirectory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; build.stdout.on('data', chunk => { output += String(chunk); }); build.stderr.on('data', chunk => { output += String(chunk); });
      build.once('error', reject); build.once('exit', code => code === 0 ? resolve() : reject(new Error(output)));
    });
  });
  afterAll(async () => { if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true }); });

  it('interoperates with the Node AES-GCM protocol, retains one private channel, and closes it on EOF', async () => {
    const pod = await fixture(); const port = new NativePort(pod.directory);
    const requestId = randomUUID();
    const startMessage = { version: 1, id: randomUUID(), operation: 'start', relayOrigin: 'https://relay.example', handoffCode: 'interego-login:v1:private-handoff' };
    const startFrame = frame(startMessage);
    // Native Messaging is a byte stream; headers and payloads need not arrive together.
    port.child.stdin.write(startFrame.subarray(0, 2)); port.child.stdin.write(startFrame.subarray(2, 9)); port.child.stdin.write(startFrame.subarray(9));
    expect(await port.response()).toEqual({ version: 1, id: startMessage.id, ok: true, value: { state: 'pending', receipt: 'opaque-browser-receipt' } });
    const poll = { version: 1, id: randomUUID(), operation: 'poll', requestId, receipt: 'opaque-browser-receipt' };
    const cancel = { ...poll, id: randomUUID(), operation: 'cancel' };
    port.child.stdin.write(Buffer.concat([frame(poll), frame(cancel)]));
    expect((await port.response())['id']).toBe(poll.id); expect((await port.response())['id']).toBe(cancel.id);
    const closed = new Promise<number | null>(resolve => port.child.once('close', resolve)); port.child.stdin.end();
    expect(await closed).toBe(0);
    expect(pod.calls.map(call => call.body['operation'])).toEqual(['start', 'poll', 'cancel', 'close']);
    const channels = pod.calls.map(call => call.body['channel']); expect(new Set(channels).size).toBe(1);
    expect(channels[0]).toMatch(/^[0-9a-f-]{36}$/);
    for (const call of pod.calls) {
      expect(call.body['browserOrigin']).toBe(origin); expect(call.body['issuedAt']).toBeGreaterThan(Date.now() - 60_000);
      expect(Object.keys(call.body).sort()).toEqual(['arguments', 'browserOrigin', 'channel', 'issuedAt', 'operation']);
      expect(call.wire).not.toContain('relay.example'); expect(call.wire).not.toContain('private-handoff'); expect(call.wire).not.toContain('opaque-browser-receipt');
    }
    expect(new Set(pod.calls.map(call => call.envelope.requestId)).size).toBe(4);
    expect(new Set(pod.calls.map(call => call.envelope.nonce)).size).toBe(4);
    expect(pod.calls[0]!.body['arguments']).toEqual({ relayOrigin: startMessage.relayOrigin, handoffCode: startMessage.handoffCode });
    expect(pod.calls[3]!.body['arguments']).toEqual({});
  });

  it.each(['tag', 'requestId', 'sessionId', 'connectionId'] as const)('rejects a response with tampered %s without exposing broker data', async field => {
    const pod = await fixture((call, ticket, endpoint) => {
      const envelope = sealAgentMessage(ticket, endpoint, call.envelope.requestId, 'response', { ok: true, value: { privateProof: 'must-not-leak' } });
      return { ...envelope, [field]: field === 'tag' ? randomBytes(16).toString('base64') : randomUUID() };
    });
    const message = { version: 1, id: randomUUID(), operation: 'start', relayOrigin: 'https://relay.example', handoffCode: 'hidden-handoff' };
    const result = await run([origin, '--pod-data-dir', pod.directory], frame(message));
    expect(result.code).toBe(0); expect(result.err).toBe(''); expect(frames(result.out)).toEqual([{ version: 1, id: message.id, ok: false,
      error: 'This local identity request could not be completed. Open Interego and try again.' }]);
    expect(result.out.toString()).not.toContain('must-not-leak');
  });

  it.each([
    Buffer.from([0, 0, 0, 0]), Buffer.from([1, 0, 1, 0]), Buffer.from([255, 255, 255, 255]),
    Buffer.from([1, 0]), Buffer.from([10, 0, 0, 0, 123]), Buffer.from([2, 0, 0, 0, 0xc3, 0x28]),
  ])('bounds framing and rejects truncated or invalid UTF8 input (%j)', async bytes => {
    const pod = await fixture(); const result = await run([origin, '--pod-data-dir', pod.directory], bytes);
    expect(frames(result.out)).toHaveLength(1); expect(frames(result.out)[0]).toMatchObject({ version: 1, id: null, ok: false });
    expect(result.err).toBe(''); expect(pod.calls).toHaveLength(0);
  });

  it('rejects unsupported operations, injected origins/channels, and unknown message fields', async () => {
    const pod = await fixture();
    const base = { version: 1, id: randomUUID(), operation: 'start', relayOrigin: 'https://relay.example', handoffCode: 'hidden' };
    const messages = [{ ...base, operation: 'approve' }, { ...base, browserOrigin: origin }, { ...base, channel: randomUUID() }, { ...base, privateKey: 'invalid' }];
    const result = await run([origin, '--pod-data-dir', pod.directory], Buffer.concat(messages.map(frame)));
    expect(frames(result.out).map(reply => reply['ok'])).toEqual([false, false, false, false]); expect(pod.calls).toHaveLength(0);
  });

  it.each([`https://${'a'.repeat(32)}`, `${origin}/path`, `${origin}?query`, `chrome-extension://${'z'.repeat(32)}`, '--protect-ticket'])('does not trust malformed browser origin %s', async browserOrigin => {
    const pod = await fixture(); const result = await run([browserOrigin, '--pod-data-dir', pod.directory], frame({ version: 1, id: randomUUID(), operation: 'poll', requestId: randomUUID(), receipt: 'hidden' }));
    expect(result.code).toBe(1); expect(frames(result.out)[0]).toMatchObject({ id: null, ok: false }); expect(pod.calls).toHaveLength(0);
  });

  it('rejects a substituted non-loopback endpoint and corrupt DPAPI data before making requests', async () => {
    const pod = await fixture(); const message = frame({ version: 1, id: randomUUID(), operation: 'start', relayOrigin: 'https://relay.example', handoffCode: 'hidden' });
    await writeFile(join(pod.directory, 'identity-browser/endpoint.json'), JSON.stringify({ ...pod.endpoint, url: 'https://relay.example/identity-browser' }));
    expect(frames((await run([origin, '--pod-data-dir', pod.directory], message)).out)[0]?.['ok']).toBe(false);
    await writeFile(join(pod.directory, 'identity-browser/endpoint.json'), JSON.stringify(pod.endpoint));
    const path = join(pod.directory, 'identity-browser/ticket.bin'); const protectedTicket = Buffer.from((await readFile(path)).toString(), 'base64');
    protectedTicket[protectedTicket.length - 1] = protectedTicket[protectedTicket.length - 1]! ^ 1;
    await writeFile(path, protectedTicket.toString('base64'));
    expect(frames((await run([origin, '--pod-data-dir', pod.directory], message)).out)[0]?.['ok']).toBe(false); expect(pod.calls).toHaveLength(0);
  });

  it('protect mode validates and bounds input without emitting plaintext diagnostics', async () => {
    for (const input of ['not json', JSON.stringify({ version: 1, connectionId: randomUUID(), secret: 'bad' }), 'x'.repeat(4097)]) {
      const result = await run(['--protect-ticket'], input); expect(result.code).toBe(1); expect(result.out.length).toBe(0); expect(result.err).toBe('');
    }
  });
});
