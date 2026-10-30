/** Read-only companion for one app-issued grant. It never opens the notes vault. */
import { randomUUID } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import {
  AGENT_ID_PATTERN, MAX_AGENT_REQUEST_BYTES, MAX_AGENT_RESPONSE_BYTES,
  openAgentMessage, sealAgentMessage,
} from './agent-protocol.js';
import type { AgentEndpoint, AgentOperation, AgentProtector, AgentTicket } from './agent-types.js';

export interface AgentClientOptions {
  readonly dataDir: string;
  readonly connectionId: string;
  readonly protector: AgentProtector;
}
const UNAVAILABLE = 'This agent connection is unavailable. Open Interego and check its permissions.';
export const NOTE_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(UNAVAILABLE);
  return value as Record<string, unknown>;
}

/** Validate independently of the MCP schema; SDK low-level handlers do not enforce it. */
export function agentArguments(operation: AgentOperation, value: unknown): Record<string, unknown> {
  const args = record(value === undefined ? {} : value);
  const keys = Object.keys(args).sort().join(',');
  if (operation === 'status' && keys === '') return {};
  if (operation === 'notes.search' && ['query', 'limit,query'].includes(keys)
    && typeof args['query'] === 'string' && args['query'].length <= 200
    && (args['limit'] === undefined || (Number.isInteger(args['limit']) && Number(args['limit']) >= 1 && Number(args['limit']) <= 50))) {
    return { query: args['query'], limit: args['limit'] ?? 10 };
  }
  if (operation === 'notes.read' && keys === 'id' && typeof args['id'] === 'string' && NOTE_ID_PATTERN.test(args['id'])) return { id: args['id'] };
  if (operation === 'notes.create' && keys === 'body,title' && typeof args['title'] === 'string' && args['title'].trim()
    && args['title'].length <= 160 && typeof args['body'] === 'string' && args['body'].trim() && args['body'].length <= 50_000) {
    return { title: args['title'].trim(), body: args['body'] };
  }
  throw new Error('This tool received unsupported arguments.');
}

async function readJson(path: string, limit: number): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error(UNAVAILABLE);
  const file = await open(path, 'r');
  try {
    const after = await file.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size > limit) throw new Error(UNAVAILABLE);
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > limit) throw new Error(UNAVAILABLE);
    return JSON.parse(bytes.subarray(0, size).toString('utf8')) as unknown;
  } finally { await file.close(); }
}

export class AgentClient {
  private readonly directory: string;
  private readonly options: AgentClientOptions;

  constructor(options: AgentClientOptions) {
    if (!AGENT_ID_PATTERN.test(options.connectionId) || !isAbsolute(options.dataDir)) throw new Error(UNAVAILABLE);
    this.options = options;
    this.directory = resolve(options.dataDir);
  }

  private async context(): Promise<{ ticket: AgentTicket; endpoint: AgentEndpoint }> {
    const wrapper = record(await readJson(join(this.directory, 'tickets', `${this.options.connectionId}.json`), 32 * 1024));
    if (Object.keys(wrapper).sort().join(',') !== 'ciphertext,version' || wrapper['version'] !== 1
      || typeof wrapper['ciphertext'] !== 'string' || !wrapper['ciphertext']) throw new Error(UNAVAILABLE);
    const raw = record(JSON.parse(this.options.protector.unprotect(wrapper['ciphertext'])));
    if (Object.keys(raw).sort().join(',') !== 'connectionId,secret,version' || raw['version'] !== 1
      || raw['connectionId'] !== this.options.connectionId || typeof raw['secret'] !== 'string'
      || Buffer.from(raw['secret'], 'base64').length !== 32 || Buffer.from(raw['secret'], 'base64').toString('base64') !== raw['secret']) throw new Error(UNAVAILABLE);
    const location = record(await readJson(join(this.directory, 'endpoint.json'), 4096));
    if (Object.keys(location).sort().join(',') !== 'sessionId,url,version' || location['version'] !== 1
      || typeof location['sessionId'] !== 'string' || !AGENT_ID_PATTERN.test(location['sessionId']) || typeof location['url'] !== 'string') throw new Error(UNAVAILABLE);
    const url = new URL(location['url']);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1
      || url.pathname !== '/agent' || url.search || url.hash || url.username || url.password || url.href !== location['url']) throw new Error(UNAVAILABLE);
    return { ticket: raw as unknown as AgentTicket, endpoint: location as unknown as AgentEndpoint };
  }

  async request(operation: AgentOperation, input: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    const args = agentArguments(operation, input);
    let authenticatedError: string | undefined;
    try {
      signal?.throwIfAborted();
      const { ticket, endpoint } = await this.context();
      signal?.throwIfAborted();
      const requestId = randomUUID();
      const envelope = sealAgentMessage(ticket, endpoint, requestId, 'request', { issuedAt: Date.now(), operation, arguments: args });
      const body = Buffer.from(JSON.stringify(envelope));
      if (body.length > MAX_AGENT_REQUEST_BYTES) throw new Error(UNAVAILABLE);
      const url = new URL(endpoint.url);
      const response = await new Promise<unknown>((done, fail) => {
        const timeout = AbortSignal.timeout(180_000);
        const request = httpRequest({ hostname: '127.0.0.1', port: Number(url.port), path: '/agent', method: 'POST', agent: false,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { host: url.host, 'content-type': 'application/json', 'content-length': body.length } }, incoming => {
          if (incoming.statusCode !== 200) { incoming.destroy(); fail(new Error(UNAVAILABLE)); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_AGENT_RESPONSE_BYTES) { incoming.destroy(); fail(new Error(UNAVAILABLE)); }
            else chunks.push(chunk);
          });
          incoming.once('error', fail);
          incoming.once('aborted', () => fail(new Error(UNAVAILABLE)));
          incoming.once('end', () => {
            try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(new Error(UNAVAILABLE)); }
          });
        });
        request.setTimeout(180_000, () => request.destroy(new Error(UNAVAILABLE)));
        request.once('error', fail);
        request.end(body);
      });
      if (record(response)['requestId'] !== requestId) throw new Error(UNAVAILABLE);
      const result = record(openAgentMessage(ticket, endpoint, response, 'response'));
      if (result['ok'] === true && Object.keys(result).sort().join(',') === 'ok,value') return result['value'];
      if (result['ok'] === false && Object.keys(result).sort().join(',') === 'error,ok' && typeof result['error'] === 'string' && result['error'].length <= 350) authenticatedError = result['error'];
    } catch { /* File, OS protection, network and unauthenticated details stay out of MCP replies. */ }
    throw new Error(authenticatedError ?? UNAVAILABLE);
  }
}
