/** Encrypted loopback channel for the installed, origin-restricted native host. */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_ID_PATTERN, AGENT_REQUEST_WINDOW_MS, openAgentMessage, sealAgentMessage } from './agent-protocol.js';
import type { AgentEndpoint, AgentTicket } from './agent-types.js';
import type { LocalIdentityService } from './local-identity.js';
import { IDENTITY_LINK_HANDOFF } from './local-identity-link.js';

export interface IdentityBrowserOptions {
  readonly dataDir: string;
  readonly service: LocalIdentityService;
  readonly allowedOrigins: () => Promise<readonly string[]>;
  /** Uses the console host's Windows CurrentUser DPAPI, never a browser operation. */
  readonly protectTicket: (plaintext: string) => Promise<string>;
  readonly onPending?: () => void;
}
const MAX_BYTES = 128 * 1024;
interface Channel { readonly origin: string; readonly generation: number; touched: number; linking?: boolean }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native identity message.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error('Invalid native identity fields.');
}
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message.length > 0 && message.length <= 350 && !/[\r\n]|[\\/](?:Users|node_modules)[\\/]/i.test(message)
    ? message : 'This local identity request could not be completed. Open Interego and try again.';
}
export class IdentityBrowser {
  private server: Server | undefined;
  private endpoint: AgentEndpoint | undefined;
  private published: AgentEndpoint | undefined;
  private readonly ticket: AgentTicket = { version: 1, connectionId: randomUUID(), secret: randomBytes(32).toString('base64') };
  private readonly replay = new Map<string, number>();
  private readonly channels = new Map<string, Channel>();
  private generation = 0;
  private inFlight = 0;
  private closed = false;
  private starting: Promise<void> | undefined;

  constructor(private readonly options: IdentityBrowserOptions) {}

  private async write(path: string, value: string): Promise<void> {
    const temporary = `${path}.tmp-${randomUUID()}`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (this.closed) throw new Error('Native identity access is closed.');
      await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.options.dataDir);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Native identity storage is unavailable.');
      const protectedTicket = await this.options.protectTicket(JSON.stringify(this.ticket));
      if (this.closed) throw new Error('Native identity access is closed.');
      const server = createServer((request, response) => { void this.handle(request, response); }); this.server = server;
      server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.keepAliveTimeout = 1000; server.maxConnections = 16;
      await new Promise<void>((done, fail) => {
        server.once('error', fail); server.listen(0, '127.0.0.1', () => { server.off('error', fail); done(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Native identity access could not open.');
      const endpoint: AgentEndpoint = { version: 1, url: `http://127.0.0.1:${address.port}/identity-browser`, sessionId: randomUUID() };
      try {
        if (this.closed) throw new Error('Native identity access is closed.');
        await this.write(join(this.options.dataDir, 'ticket.bin'), protectedTicket);
        if (this.closed) throw new Error('Native identity access is closed.');
        this.published = endpoint;
        await this.write(join(this.options.dataDir, 'endpoint.json'), JSON.stringify(endpoint));
        if (this.closed) throw new Error('Native identity access is closed.');
        this.endpoint = endpoint;
      } catch (error) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); throw error; }
    })();
    return this.starting;
  }

  private send(response: ServerResponse, status: number, value: unknown): void {
    if (response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' });
    response.end(JSON.stringify(value));
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, expiry] of this.replay) if (expiry <= now) this.replay.delete(key);
    for (const [channel, value] of this.channels) if (value.touched < now - 60_000) {
      this.options.service.cancelChannel(channel); this.channels.delete(channel);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const endpoint = this.endpoint;
    if (this.closed || !endpoint) { this.send(response, 503, { error: 'Open Interego to use local identity.' }); return; }
    if (request.headers.origin !== undefined || request.headers.host !== new URL(endpoint.url).host
      || request.method !== 'POST' || request.url !== '/identity-browser') { this.send(response, 403, { error: 'Native identity route refused.' }); return; }
    if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']
      || Number(request.headers['content-length'] ?? 0) > MAX_BYTES) { this.send(response, 400, { error: 'Invalid native request.' }); return; }
    this.prune();
    if (this.inFlight >= 8 || this.replay.size >= 1024) { this.send(response, 429, { error: 'Native identity is busy.' }); return; }
    this.inFlight++; const generation = this.generation;
    let channel: string | undefined; let ownedChannel: Channel | undefined;
    const cancelOwned = () => {
      if (channel && ownedChannel && this.channels.get(channel) === ownedChannel) { this.options.service.cancelChannel(channel); this.channels.delete(channel); }
    };
    const disconnected = () => { if (!response.writableEnded) cancelOwned(); };
    const current = () => !this.closed && this.generation === generation && !request.aborted && !response.destroyed;
    response.once('close', disconnected); request.once('aborted', disconnected);
    const began = Date.now();
    const expire = () => { disconnected(); if (!request.complete) request.destroy(); if (!response.writableEnded) response.destroy(); };
    let timeout = setTimeout(expire, 20_000);
    const linkBudget = () => { clearTimeout(timeout); timeout = setTimeout(expire, Math.max(1, 55_000 - (Date.now() - began))); };
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
        if (size > MAX_BYTES) throw new Error('Native request too large.'); chunks.push(bytes);
      }
      const envelope = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const value = record(openAgentMessage(this.ticket, endpoint, envelope, 'request'));
      keys(value, ['issuedAt', 'browserOrigin', 'channel', 'operation', 'arguments']);
      if (typeof envelope['requestId'] !== 'string' || !AGENT_ID_PATTERN.test(envelope['requestId'])
        || typeof value['issuedAt'] !== 'number' || !Number.isSafeInteger(value['issuedAt']) || Math.abs(Date.now() - value['issuedAt']) > AGENT_REQUEST_WINDOW_MS
        || typeof value['browserOrigin'] !== 'string' || !/^chrome-extension:\/\/[a-p]{32}$/.test(value['browserOrigin'])
        || typeof value['channel'] !== 'string' || !AGENT_ID_PATTERN.test(value['channel']) || typeof value['operation'] !== 'string'
        || !['start', 'poll', 'cancel', 'close'].includes(value['operation']) || this.replay.has(envelope['requestId'])) throw new Error('Native request refused.');
      // Reserve before the asynchronous allowlist read: two concurrent copies must
      // never both use an otherwise valid transport envelope.
      this.replay.set(envelope['requestId'], Date.now() + 2 * AGENT_REQUEST_WINDOW_MS + 1);
      const origin = value['browserOrigin']; const incomingChannel = value['channel'];
      if (!(await this.options.allowedOrigins()).includes(origin) || !current()) throw new Error('This extension is not allowed to request local identity.');
      const known = this.channels.get(incomingChannel);
      if (known && (known.origin !== origin || known.generation !== generation) || !known && value['operation'] !== 'start') throw new Error('This native identity channel is unavailable.');
      if (!known && this.channels.size >= 16) throw new Error('Too many native identity windows are open.');
      channel = incomingChannel; ownedChannel = known ?? { origin, generation, touched: Date.now() }; ownedChannel.touched = Date.now();
      this.channels.set(channel, ownedChannel);
      const args = record(value['arguments']); let result: unknown;
      if (ownedChannel.linking && value['operation'] !== 'start') linkBudget();
      try {
        if (value['operation'] === 'start') {
          keys(args, ['relayOrigin', 'handoffCode']);
          if (typeof args['relayOrigin'] !== 'string' || typeof args['handoffCode'] !== 'string') throw new Error('Invalid sign-in request.');
          ownedChannel.linking = IDENTITY_LINK_HANDOFF.test(args['handoffCode']);
          if (ownedChannel.linking) linkBudget();
          result = await this.options.service.request({ relayOrigin: args['relayOrigin'], handoffCode: args['handoffCode'] }, channel);
          if (!current() || !(await this.options.allowedOrigins()).includes(origin) || !current()) { cancelOwned(); throw new Error('This sign-in window has closed.'); }
          this.options.onPending?.();
        } else if (value['operation'] === 'close') {
          keys(args, []); this.options.service.cancelChannel(channel); this.channels.delete(channel); result = { closed: true };
        } else {
          keys(args, ['requestId', 'receipt']);
          if (typeof args['requestId'] !== 'string' || typeof args['receipt'] !== 'string') throw new Error('Invalid sign-in receipt.');
          result = value['operation'] === 'poll' ? this.options.service.poll(args['requestId'], args['receipt'], channel)
            : (this.options.service.cancel(args['requestId'], args['receipt'], channel), { cancelled: true });
        }
        this.send(response, 200, sealAgentMessage(this.ticket, endpoint, envelope['requestId'], 'response', { ok: true, value: result }));
      } catch (error) {
        if (!current()) cancelOwned();
        this.send(response, 200, sealAgentMessage(this.ticket, endpoint, envelope['requestId'], 'response', { ok: false, error: safeError(error) }));
      }
    } catch { this.send(response, 401, { error: 'Native identity request refused.' }); }
    finally { clearTimeout(timeout); response.off('close', disconnected); request.off('aborted', disconnected); this.inFlight--; }
  }

  /** Native owner policy change: cancel old authority while keeping the broker available. */
  revokeChannels(): void {
    ++this.generation; this.options.service.stop();
    for (const channel of this.channels.keys()) this.options.service.cancelChannel(channel);
    this.channels.clear();
  }

  private async removeOwnEndpoint(): Promise<void> {
    const endpoint = this.published; if (!endpoint) return;
    const path = join(this.options.dataDir, 'endpoint.json');
    try {
      const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return;
      const file = await open(path, 'r');
      try {
        const actual = await file.stat(); if (actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size > 4096) return;
        const bytes = Buffer.alloc(4097); let size = 0;
        while (size < bytes.length) { const result = await file.read(bytes, size, bytes.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
        if (size > 4096) return;
        const value = record(JSON.parse(bytes.subarray(0, size).toString('utf8'))); keys(value, ['version', 'url', 'sessionId']);
        if (value['version'] !== endpoint.version || value['url'] !== endpoint.url || value['sessionId'] !== endpoint.sessionId) return;
        const current = await lstat(path); if (current.dev !== stat.dev || current.ino !== stat.ino || current.isSymbolicLink()) return;
        await unlink(path);
      } finally { await file.close(); }
    } catch { /* A newer, missing or damaged endpoint does not belong to this shutdown. */ }
  }

  async close(): Promise<void> {
    this.closed = true; this.revokeChannels(); this.endpoint = undefined;
    await this.starting?.catch(() => {});
    if (this.server?.listening) { this.server.closeAllConnections(); await new Promise<void>(done => this.server!.close(() => done())); }
    await this.removeOwnEndpoint();
    this.replay.clear();
  }
}
