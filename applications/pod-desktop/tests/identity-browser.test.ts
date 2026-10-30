import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { IdentityBrowser } from '../src/identity-browser.js';
import { LocalIdentityService } from '../src/local-identity.js';
import { NativeIdentityHost } from '../src/native-identity-host.js';
import { openAgentMessage, sealAgentMessage } from '../src/agent-protocol.js';
import { identityHash, type LocalIdentitySaved } from '../src/local-identity-protocol.js';
import type { AgentEndpoint, AgentTicket } from '../src/agent-types.js';
import type { LocalIdentityContext, LocalIdentityTicket } from '../src/local-identity-types.js';

type RecordValue = Record<string, unknown>;
const appRoot = fileURLToPath(new URL('../', import.meta.url));
let executable: string; let buildDirectory: string;
const origin = `chrome-extension://${'a'.repeat(32)}`;
const otherOrigin = `chrome-extension://${'b'.repeat(32)}`;
const relay = 'https://relay.example.com';
const provider = 'https://identity.example.com';
const callback = 'https://website.example.com/callback';
const token = () => randomBytes(32).toString('base64url');
const handoffCode = 'interego-login:v1:' + token() + '.' + token();
const directories = new Set<string>();
const brokers: IdentityBrowser[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function frame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}
class NativePort {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<number | null>;
  readonly errors: string[] = [];
  private readonly output: AsyncIterator<Buffer>;
  private buffered = Buffer.alloc(0);
  constructor(directory: string, browserOrigin = origin) {
    this.child = spawn(executable, [browserOrigin + '/', '--parent-window=0', '--pod-data-dir', directory], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(this.child); this.child.stdin.on('error', () => {}); this.child.stderr.on('data', (chunk: Buffer) => { this.errors.push(chunk.toString()); });
    this.closed = new Promise((resolve, reject) => { this.child.once('error', reject); this.child.once('close', resolve); });
    this.output = this.child.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }
  async send(value: RecordValue): Promise<RecordValue> {
    this.child.stdin.write(frame(value));
    for (;;) {
      if (this.buffered.length >= 4) {
        const length = this.buffered.readUInt32LE(0); if (!length || length > 64 * 1024) throw new Error('Invalid native frame.');
        if (this.buffered.length >= length + 4) {
          const result = JSON.parse(this.buffered.subarray(4, length + 4).toString('utf8')) as RecordValue;
          this.buffered = this.buffered.subarray(length + 4); return result;
        }
      }
      const chunk = await this.output.next(); if (chunk.done) throw new Error('Native companion closed without replying.');
      this.buffered = Buffer.concat([this.buffered, chunk.value]);
    }
  }
  async end(): Promise<void> { this.child.stdin.end(); expect(await this.closed).toBe(0); expect(this.errors).toEqual([]); }
}
function message(operation: string, args: RecordValue = {}): RecordValue { return { version: 1, id: randomUUID(), operation, ...args }; }
function startMessage() { return message('start', { relayOrigin: relay, handoffCode }); }
function pollMessage(ticket: LocalIdentityTicket) { return message('poll', { requestId: ticket.id, receipt: ticket.receipt }); }
async function fixture(input: { allowedOrigins?: () => Promise<readonly string[]>; directory?: string } = {}) {
  const directory = input.directory ?? await mkdtemp(join(tmpdir(), 'interego-identity-browser-')); directories.add(directory);
  const dataDir = join(directory, 'identity-browser'); let saved: unknown = null; let ticket!: AgentTicket;
  const nonce = token(); const context: LocalIdentityContext = { version: 1, issuer: relay, identityOrigin: provider, pendingId: randomBytes(16).toString('hex'),
    clientId: 'registered-website', clientName: 'My hosted website', redirectUri: callback, scopes: ['mcp:read'], resource: null,
    codeChallenge: token(), stateDigest: identityHash('browser-session-state'), expiresAt: new Date(Date.now() + 120_000).toISOString(), nonce,
    message: `Interego DID sign-in v1\nHost: identity.example.com\nNonce: ${nonce}`, challengeExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    completionCode: 'interego-login-result:v1:' + token() + '.' + token() };
  const posts: Array<{ url: string; body: RecordValue }> = [];
  const service = new LocalIdentityService({ store: { load: async () => saved, save: async value => { saved = structuredClone(value); } }, binding: async () => 'private-local-pod',
    trustedRelays: [{ relayOrigin: relay, identityOrigin: provider }], fetch: async (request, init) => {
      const req = new Request(request, init); const body = JSON.parse(await req.text()) as RecordValue; posts.push({ url: req.url, body });
      if (new URL(req.url).pathname.endsWith('/context')) return Response.json(context);
      if (new URL(req.url).pathname === '/oauth/verify') return Response.json({ redirect: callback + '?code=short-lived-code&state=browser-session-state' });
      throw new Error('Unexpected test endpoint.');
    } });
  await service.setup();
  const native = new NativeIdentityHost({ dataDir, executable }); let pendingNotifications = 0;
  const broker = new IdentityBrowser({ dataDir, service, allowedOrigins: input.allowedOrigins ?? (async () => [origin]),
    protectTicket: async value => { ticket = JSON.parse(value) as AgentTicket; return native.protectTicket(value); }, onPending: () => { pendingNotifications++; } });
  brokers.push(broker); await broker.start();
  const endpoint = JSON.parse(await readFile(join(dataDir, 'endpoint.json'), 'utf8')) as AgentEndpoint;
  const payload = (channel: string, operation: string, args: RecordValue, browserOrigin = origin) => sealAgentMessage(ticket, endpoint, randomUUID(), 'request', {
    issuedAt: Date.now(), browserOrigin, channel, operation, arguments: args,
  });
  const open = (value: unknown) => openAgentMessage(ticket, endpoint, value, 'response') as RecordValue;
  const call = async (value: unknown, headers: Record<string, string> = {}) => fetch(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
  return { directory, dataDir, service, broker, endpoint, ticket, context, posts, payload, call, open, saved: () => saved as LocalIdentitySaved, notifications: () => pendingNotifications };
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(done => {
    if (child.exitCode !== null) { done(); return; } child.once('close', () => done()); child.kill();
  })));
  await Promise.all(brokers.splice(0).map(broker => broker.close()));
  for (const directory of directories) if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-identity-browser-')) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

describe.skipIf(process.platform !== 'win32')('Windows browser companion through the real local identity broker', () => {
  beforeAll(async () => {
    buildDirectory = await mkdtemp(join(tmpdir(), 'interego-identity-browser-build-')); executable = join(buildDirectory, 'Interego-Identity.exe');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [join(appRoot, 'tools/build-native-host.mjs'), '--output-dir', buildDirectory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = ''; child.stdout.on('data', chunk => { text += String(chunk); }); child.stderr.on('data', chunk => { text += String(chunk); });
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(text)));
    });
  });
  afterAll(async () => {
    if (buildDirectory && dirname(resolve(buildDirectory)) === resolve(tmpdir()) && basename(buildDirectory).startsWith('interego-identity-browser-build-')) await rm(buildDirectory, { recursive: true, force: true });
  });
  it('uses real DPAPI and persistent framing for native owner approval, keeping proof inside the app and consuming the callback once', async () => {
    const f = await fixture(); const file = await readFile(join(f.dataDir, 'ticket.bin'), 'utf8'); expect(file).not.toContain(f.ticket.secret);
    const port = new NativePort(f.directory); const start = await port.send(startMessage()); expect(start['ok']).toBe(true); const ticket = start['value'] as LocalIdentityTicket;
    expect(f.notifications()).toBe(1); expect(f.posts).toHaveLength(1); expect(await port.send(pollMessage(ticket))).toMatchObject({ ok: true, value: { state: 'waiting' } });
    const status = await f.service.status(); expect(status.pending[0]).toMatchObject({ verificationCode: ticket.verificationCode, redirectUri: callback, resource: null });
    await f.service.approve(ticket.id, ticket.verificationCode); expect(f.posts).toHaveLength(2);
    const proof = f.posts[1]!.body; expect(f.posts[1]!.url).toBe(relay + '/oauth/verify'); expect(proof['native_handoff']).toBe(f.context.completionCode);
    expect(verify(null, Buffer.from(f.context.message), createPublicKey({ key: Buffer.from(f.saved().publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(String(proof['signature']), 'base64url'))).toBe(true);
    const completed = await port.send(pollMessage(ticket)); expect(completed).toMatchObject({ ok: true, value: { state: 'complete', redirect: callback + '?code=short-lived-code&state=browser-session-state' } });
    for (const secret of [String(proof['signature']), f.saved().privateKey, f.context.nonce, f.context.completionCode]) expect(JSON.stringify([start, status, completed])).not.toContain(secret);
    expect(await port.send(pollMessage(ticket))).toMatchObject({ ok: true, value: { state: 'expired' } });
    await expect(f.service.approve(ticket.id, ticket.verificationCode)).rejects.toThrow(); expect(f.posts).toHaveLength(2); await port.end();
  });
  it('returns a native denial and cancels an unapproved request on actual native-port EOF', async () => {
    const f = await fixture(); const port = new NativePort(f.directory); const ticket = (await port.send(startMessage()))['value'] as LocalIdentityTicket;
    f.service.deny(ticket.id); expect(await port.send(pollMessage(ticket))).toMatchObject({ ok: true, value: { state: 'denied' } });
    const next = (await port.send(startMessage()))['value'] as LocalIdentityTicket; expect((await f.service.status()).pending).toHaveLength(1);
    await port.end(); expect((await f.service.status()).pending).toEqual([]); expect(f.posts).toHaveLength(2);
    await expect(f.service.approve(next.id, next.verificationCode)).rejects.toThrow();
  });
  it('refuses an unapproved extension and prevents a second native channel consuming the first channel receipt', async () => {
    const f = await fixture(); const disallowed = new NativePort(f.directory, otherOrigin);
    expect(await disallowed.send(startMessage())).toMatchObject({ ok: false }); await disallowed.end(); expect(f.posts).toEqual([]);
    const first = new NativePort(f.directory); const second = new NativePort(f.directory);
    const firstTicket = (await first.send(startMessage()))['value'] as LocalIdentityTicket; await second.send(startMessage());
    expect(await second.send(pollMessage(firstTicket))).toMatchObject({ ok: false }); expect(await first.send(pollMessage(firstTicket))).toMatchObject({ ok: true, value: { state: 'waiting' } });
    expect(f.posts).toHaveLength(2); await second.end(); expect((await f.service.status()).pending).toHaveLength(1); await first.end();
  });
  it('atomically refuses concurrent encrypted-envelope replay before an asynchronous allowlist read', async () => {
    const entered = deferred<void>(); const gate = deferred<readonly string[]>();
    const f = await fixture({ allowedOrigins: async () => { entered.resolve(); return gate.promise; } });
    const value = f.payload(randomUUID(), 'start', { relayOrigin: relay, handoffCode }); const first = f.call(value); await entered.promise;
    try { expect((await f.call(value)).status).toBe(401); } finally { gate.resolve([origin]); }
    const response = await first; expect(response.status).toBe(200); expect(f.open(await response.json())['ok']).toBe(true);
    expect(f.posts).toHaveLength(1); expect((await f.call(value)).status).toBe(401);
  });
  it('refuses browser HTTP origins, tampered envelopes and changed authenticated origins without cancelling the rightful channel', async () => {
    const f = await fixture({ allowedOrigins: async () => [origin, otherOrigin] }); const channel = randomUUID();
    const value = f.payload(channel, 'start', { relayOrigin: relay, handoffCode });
    expect((await f.call(value, { origin: 'https://website.example.com' })).status).toBe(403);
    expect((await f.call({ ...value, tag: randomBytes(16).toString('base64') })).status).toBe(401);
    const accepted = f.open(await (await f.call(value)).json()); const ticket = accepted['value'] as LocalIdentityTicket;
    expect((await f.call(f.payload(channel, 'poll', { requestId: ticket.id, receipt: ticket.receipt }, otherOrigin))).status).toBe(401);
    const result = f.open(await (await f.call(f.payload(channel, 'poll', { requestId: ticket.id, receipt: ticket.receipt }))).json());
    expect(result).toMatchObject({ ok: true, value: { state: 'waiting' } }); expect(f.posts).toHaveLength(1);
  });
  it('invalidates in-flight allowlist reads on owner revocation and then permits a new approved connection', async () => {
    const entered = deferred<void>(); const gate = deferred<void>(); let pause = true;
    const f = await fixture({ allowedOrigins: async () => { if (pause) { entered.resolve(); await gate.promise; } return [origin]; } });
    const request = f.call(f.payload(randomUUID(), 'start', { relayOrigin: relay, handoffCode })); await entered.promise;
    f.broker.revokeChannels(); pause = false; gate.resolve(); expect((await request).status).toBe(401); expect(f.posts).toEqual([]);
    const port = new NativePort(f.directory); expect(await port.send(startMessage())).toMatchObject({ ok: true }); expect(f.posts).toHaveLength(1); await port.end();
  });
  it('removes only its own published endpoint when a newer broker has taken over the same native profile', async () => {
    const old = await fixture(); const current = await fixture({ directory: old.directory }); expect(current.endpoint.sessionId).not.toBe(old.endpoint.sessionId);
    await old.broker.close(); expect(JSON.parse(await readFile(join(current.dataDir, 'endpoint.json'), 'utf8'))).toEqual(current.endpoint);
    const port = new NativePort(current.directory); expect(await port.send(startMessage())).toMatchObject({ ok: true }); await port.end();
    await current.broker.close(); await expect(readFile(join(current.dataDir, 'endpoint.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
