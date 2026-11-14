/**
 * The agent-connection broker as HTTP routes, for express or for plain `node:http`.
 *
 * One function, {@link handleAgentConnection}, holds everything the three routes decide: a plain
 * request in, a plain `{ status, headers, body }` out. {@link attachExpress} and
 * {@link handleNodeHttp} only translate a framework's request into that input and write the
 * answer back, so the two can not drift apart.
 *
 *   POST <path>/create    a page opens a session and gets its one-use invitation
 *   POST <path>/browser   the page (bearer: its browser capability) reads state, queues a turn,
 *                         polls, cancels, renews the invitation, disconnects
 *   POST <path>/driver    the paired agent, with a signed Interego request: claim, next, emit,
 *                         finish
 *
 * How a signed caller is verified is the bridge's to supply ({@link VerifySignedCaller}). With
 * none, the driver route answers 503 and nothing can be claimed. Request limits are the
 * bridge's too: express middleware in `admission`, or an `admit` function for `node:http`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AGENT_CONNECTION_BODY_BYTES, AgentConnectionError, exact, record, reject,
  type AgentConnectionBroker, type Row,
} from './broker.js';

/** What a bridge's verifier answers for a signed request: who signed it and the payload they signed. */
export type SignedCallerResult =
  | { ok: true; callerDid: string; payload: Record<string, unknown> }
  | { ok: false; status: number; error: string };
/** Verify an Interego-signed caller. `write` is true for every driver operation. */
export type VerifySignedCaller = (body: unknown, write: boolean) => Promise<SignedCallerResult>;

export type AgentConnectionRoute = 'create' | 'browser' | 'driver';

export interface AgentConnectionRequest {
  readonly route: AgentConnectionRoute;
  /** Whether the URL carried a query string. Credentials and inputs never travel in one. */
  readonly hasQuery: boolean;
  /** The `Origin` header, when the caller sent one. */
  readonly origin: string | undefined;
  /** The `Authorization` header, whole. */
  readonly authorization: string | undefined;
  /** Who is asking, for the creation budget. An address the server observed, never one the body named. */
  readonly client: string;
  /** The parsed JSON body. */
  readonly body: unknown;
}

export interface AgentConnectionReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Row;
}

export interface AgentConnectionHttpOptions {
  /** How this bridge verifies an Interego-signed caller. Unset, the driver route answers 503. */
  readonly verifyCaller?: VerifySignedCaller;
  /** Body fields a host adds before routing that are not part of the protocol. Removed before any check. */
  readonly stripBodyFields?: readonly string[];
  /** The browser operations this bridge serves over HTTP. Unset, all of them. */
  readonly browserOperations?: readonly string[];
  /**
   * Decide whether this caller may open a session. Throw an {@link AgentConnectionError} to
   * refuse. Whatever it returns is handed to `created`, so a bridge can remember whose session
   * the new one is.
   */
  readonly authorizeCreate?: (request: AgentConnectionRequest) => unknown | Promise<unknown>;
  /** Called with the reply to a successful create, before it is sent. */
  readonly created?: (reply: Row, owner: unknown) => void | Promise<void>;
  readonly wording?: { readonly monitoringNeedsHttps?: string };
}

function ok(body: Row): AgentConnectionReply {
  return { status: 200, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body };
}
function refused(e: unknown): AgentConnectionReply {
  // A verifier's internal exception may contain private inputs: never echo it.
  const known = e instanceof AgentConnectionError;
  return {
    status: known ? e.status : 500, headers: { 'Cache-Control': 'no-store' },
    body: { error: known ? e.message : 'Agent-session operation failed.', ...(known && e.code ? { code: e.code } : {}) },
  };
}

/** The route a POST to `pathname` names on this broker, or null when it is not one of the three. */
export function agentConnectionRoute(broker: AgentConnectionBroker, method: string | undefined, pathname: string): AgentConnectionRoute | null {
  if (method !== 'POST' || !pathname.startsWith(broker.path + '/')) return null;
  const rest = pathname.slice(broker.path.length + 1);
  return rest === 'create' || rest === 'browser' || rest === 'driver' ? rest : null;
}

/** Answer one request. Never throws: a refusal is a reply. */
export async function handleAgentConnection(broker: AgentConnectionBroker, options: AgentConnectionHttpOptions, request: AgentConnectionRequest): Promise<AgentConnectionReply> {
  const base = new URL(broker.audience).origin;
  const browserArguments = (value: unknown): Row => {
    const body = { ...record(value) };
    for (const field of options.stripBodyFields ?? []) delete body[field];
    return body;
  };
  const browserOrigin = (): void => {
    if (request.hasQuery) reject('Agent-session credentials and inputs belong in headers or JSON, never URLs.');
    if (request.origin && request.origin !== base) reject('Cross-origin browser agent-session request refused.', 403);
  };
  try {
    if (request.route === 'create') {
      browserOrigin();
      exact(browserArguments(request.body), []);
      const owner = options.authorizeCreate ? await options.authorizeCreate(request) : undefined;
      const reply = broker.create(request.client);
      if (options.created) await options.created(reply, owner);
      return ok(reply);
    }
    if (request.route === 'browser') {
      browserOrigin();
      const body = browserArguments(request.body);
      if (body.operation === 'configure_monitoring' && (!base.startsWith('https://') || request.origin !== base)) {
        reject(options.wording?.monitoringNeedsHttps ?? 'Use the HTTPS page of this service to configure background monitoring.', 403);
      }
      if (options.browserOperations && !options.browserOperations.includes(String(body.operation))) reject('Unknown browser agent-session operation.');
      const auth = request.authorization;
      return ok(await broker.browserAuthorized(body, auth?.startsWith('Bearer ') ? auth.slice(7) : null));
    }
    if (request.hasQuery) reject('Agent-session input belongs in signed JSON, never URLs.');
    record(request.body);
    if (!options.verifyCaller) reject('Authenticated agent-session driving is not available on this deployment.', 503);
    const auth = await options.verifyCaller(request.body, true);
    if (!auth.ok) reject('A verified, delegated Interego agent is required.', auth.status);
    return ok(await broker.driverAuthorized(auth.payload, auth.callerDid));
  } catch (e) { return refused(e); }
}

// ── express ────────────────────────────────────────────────────────────────
// Structural types, so this file imports no framework. An express `app`, `Request` and
// `Response` satisfy them as they are.

export interface ExpressLikeRequest {
  readonly query: object;
  readonly body: unknown;
  readonly ip?: string | undefined;
  readonly socket: { readonly remoteAddress?: string | undefined };
  get(name: string): string | string[] | undefined;
}
export interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  set(name: string, value: string): ExpressLikeResponse;
  json(body: unknown): unknown;
}
export interface ExpressLikeApp { post(path: string, ...handlers: never[]): unknown }

export interface AgentConnectionExpressOptions extends AgentConnectionHttpOptions {
  /** Middleware run before a route's handler: where a bridge puts its request limits. */
  readonly admission?: { readonly create?: unknown; readonly browser?: unknown; readonly driver?: unknown };
}

/** Mount the three routes on an express app. The broker's sweep is the caller's to start. */
export function attachExpress(app: ExpressLikeApp, broker: AgentConnectionBroker, options: AgentConnectionExpressOptions = {}): void {
  const header = (req: ExpressLikeRequest, name: string): string | undefined => {
    const value = req.get(name);
    return typeof value === 'string' ? value : undefined;
  };
  for (const route of ['create', 'browser', 'driver'] as const) {
    const handler = async (req: ExpressLikeRequest, res: ExpressLikeResponse): Promise<void> => {
      const reply = await handleAgentConnection(broker, options, {
        route, hasQuery: Object.keys(req.query).length > 0, origin: header(req, 'Origin'), authorization: header(req, 'Authorization'),
        client: req.ip ?? req.socket.remoteAddress ?? 'unknown', body: req.body,
      });
      for (const [name, value] of Object.entries(reply.headers)) res.set(name, value);
      res.status(reply.status).json(reply.body);
    };
    const before = options.admission?.[route];
    const handlers = before ? [before, handler] : [handler];
    app.post(broker.path + '/' + route, ...(handlers as never[]));
  }
}

// ── node:http ──────────────────────────────────────────────────────────────

export interface AgentConnectionNodeOptions extends AgentConnectionHttpOptions {
  /**
   * Count this request against the bridge's limits before anything is read. Answer null to let
   * it through, or how long the caller should wait.
   */
  readonly admit?: (route: AgentConnectionRoute, req: IncomingMessage) => { readonly retryAfterSeconds: number; readonly error?: string } | null;
  /** Who is asking, as the bridge counts clients. Defaults to the socket's peer. */
  readonly client?: (req: IncomingMessage) => string;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > AGENT_CONNECTION_BODY_BYTES + 4096) throw new AgentConnectionError('Agent-session input is too large.', 413);
    chunks.push(buf);
  }
  if (!chunks.length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new AgentConnectionError('A JSON object is required.'); }
}

/**
 * Answer a `node:http` request if it is one of the broker's routes. Returns false, having
 * touched nothing, when it is not, so the caller's own routing carries on.
 */
export async function handleNodeHttp(req: IncomingMessage, res: ServerResponse, broker: AgentConnectionBroker, options: AgentConnectionNodeOptions = {}): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = agentConnectionRoute(broker, req.method, url.pathname);
  if (!route) return false;
  const write = (reply: AgentConnectionReply, extra: Record<string, string> = {}): void => {
    const json = JSON.stringify(reply.body);
    res.writeHead(reply.status, { 'Content-Type': 'application/json; charset=utf-8', ...reply.headers, ...extra, 'Content-Length': String(Buffer.byteLength(json)) });
    res.end(json);
  };
  const limited = options.admit?.(route, req);
  if (limited) {
    // The body is not read: the connection is closed after the answer instead.
    write({ status: 429, headers: { 'Cache-Control': 'no-store' }, body: { error: limited.error ?? 'The agent connection is busy. Try again shortly.' } },
      { 'Retry-After': String(limited.retryAfterSeconds), Connection: 'close' });
    return true;
  }
  let body: unknown;
  try { body = await readBody(req); }
  catch (e) { write(refused(e), { Connection: 'close' }); return true; }
  const single = (value: string | string[] | undefined): string | undefined => typeof value === 'string' ? value : undefined;
  write(await handleAgentConnection(broker, options, {
    route, hasQuery: [...url.searchParams.keys()].length > 0, origin: single(req.headers.origin), authorization: single(req.headers.authorization),
    client: options.client?.(req) ?? req.socket.remoteAddress ?? 'unknown', body,
  }));
  return true;
}
