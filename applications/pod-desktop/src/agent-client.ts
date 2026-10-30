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
type DiagnosticStage = 'ticket-read' | 'ticket-wrapper' | 'ticket-unprotect' | 'ticket-parse' | 'ticket-validate'
  | 'endpoint-read' | 'endpoint-validate' | 'request-seal' | 'broker-connect' | 'broker-http'
  | 'response-json' | 'response-bind' | 'response-authenticate' | 'response-shape' | 'broker-refusal';
interface Diagnostic { stage: DiagnosticStage; status?: number }
/** Fixed labels only: safe to retain in a packaged CI log without ticket, note, or OS error text. */
export const AGENT_DIAGNOSTIC_LINE = /^interego-agent-failure:(ticket-read|ticket-wrapper|ticket-unprotect|ticket-parse|ticket-validate|endpoint-read|endpoint-validate|request-seal|broker-connect|broker-http|response-json|response-bind|response-authenticate|response-shape|broker-refusal):(unavailable|ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ABORT_ERR|http-[1-5][0-9]{2})$/;
function diagnosticFailure(diagnostic: Diagnostic, error?: unknown): void {
  if (process.env['INTEREGO_POD_DIAGNOSTICS'] !== '1') return;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const kind = diagnostic.status && Number.isInteger(diagnostic.status) && diagnostic.status >= 100 && diagnostic.status <= 599
    ? `http-${diagnostic.status}` : typeof code === 'string' && ['ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ABORT_ERR'].includes(code) ? code : 'unavailable';
  process.stderr.write(`interego-agent-failure:${diagnostic.stage}:${kind}\n`);
}
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

  private async context(diagnostic: Diagnostic): Promise<{ ticket: AgentTicket; endpoint: AgentEndpoint }> {
    diagnostic.stage = 'ticket-read';
    const wrapper = record(await readJson(join(this.directory, 'tickets', `${this.options.connectionId}.json`), 32 * 1024));
    diagnostic.stage = 'ticket-wrapper';
    if (Object.keys(wrapper).sort().join(',') !== 'ciphertext,version' || wrapper['version'] !== 1
      || typeof wrapper['ciphertext'] !== 'string' || !wrapper['ciphertext']) throw new Error(UNAVAILABLE);
    diagnostic.stage = 'ticket-unprotect';
    const plaintext = this.options.protector.unprotect(wrapper['ciphertext']);
    diagnostic.stage = 'ticket-parse';
    const raw = record(JSON.parse(plaintext));
    diagnostic.stage = 'ticket-validate';
    if (Object.keys(raw).sort().join(',') !== 'connectionId,secret,version' || raw['version'] !== 1
      || raw['connectionId'] !== this.options.connectionId || typeof raw['secret'] !== 'string'
      || Buffer.from(raw['secret'], 'base64').length !== 32 || Buffer.from(raw['secret'], 'base64').toString('base64') !== raw['secret']) throw new Error(UNAVAILABLE);
    diagnostic.stage = 'endpoint-read';
    const location = record(await readJson(join(this.directory, 'endpoint.json'), 4096));
    diagnostic.stage = 'endpoint-validate';
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
    const diagnostic: Diagnostic = { stage: 'ticket-read' };
    try {
      signal?.throwIfAborted();
      const { ticket, endpoint } = await this.context(diagnostic);
      signal?.throwIfAborted();
      const requestId = randomUUID();
      diagnostic.stage = 'request-seal';
      const envelope = sealAgentMessage(ticket, endpoint, requestId, 'request', { issuedAt: Date.now(), operation, arguments: args });
      const body = Buffer.from(JSON.stringify(envelope));
      if (body.length > MAX_AGENT_REQUEST_BYTES) throw new Error(UNAVAILABLE);
      const url = new URL(endpoint.url);
      diagnostic.stage = 'broker-connect';
      const response = await new Promise<unknown>((done, fail) => {
        const timeout = AbortSignal.timeout(180_000);
        const request = httpRequest({ hostname: '127.0.0.1', port: Number(url.port), path: '/agent', method: 'POST', agent: false,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { host: url.host, 'content-type': 'application/json', 'content-length': body.length } }, incoming => {
          if (incoming.statusCode !== 200) {
            diagnostic.stage = 'broker-http'; diagnostic.status = incoming.statusCode;
            incoming.destroy(); fail(new Error(UNAVAILABLE)); return;
          }
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
            diagnostic.stage = 'response-json';
            try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(new Error(UNAVAILABLE)); }
          });
        });
        request.setTimeout(180_000, () => request.destroy(new Error(UNAVAILABLE)));
        request.once('error', fail);
        request.end(body);
      });
      diagnostic.stage = 'response-bind';
      if (record(response)['requestId'] !== requestId) throw new Error(UNAVAILABLE);
      diagnostic.stage = 'response-authenticate';
      const result = record(openAgentMessage(ticket, endpoint, response, 'response'));
      diagnostic.stage = 'response-shape';
      if (result['ok'] === true && Object.keys(result).sort().join(',') === 'ok,value') return result['value'];
      if (result['ok'] === false && Object.keys(result).sort().join(',') === 'error,ok' && typeof result['error'] === 'string' && result['error'].length <= 350) {
        authenticatedError = result['error']; diagnostic.stage = 'broker-refusal';
      }
      diagnosticFailure(diagnostic);
    } catch (error) { diagnosticFailure(diagnostic, error); /* Details stay out of MCP replies and diagnostic logs. */ }
    throw new Error(authenticatedError ?? UNAVAILABLE);
  }
}
