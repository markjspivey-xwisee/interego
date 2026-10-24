/**
 * A failing request answers 500. It does not end the process.
 *
 * Express 4 calls a route handler and ignores what it returns. An `async` handler that
 * throws returns a rejected promise, nothing handles it, and Node 20+ ends the process on
 * an unhandled rejection. Measured on the identity server: one unauthenticated POST
 * /auth/did whose `did` was a JSON array (plus a free challenge nonce) made the process
 * exit, and the restart wiped every in-memory index, challenge and session. Any request
 * that reaches a throwing line in any async handler or middleware did the same.
 *
 * Three pieces, each used by a service's entry point:
 *
 *   forwardAsyncRouteErrors(log)   a rejection from a handler goes to next(err), Express's
 *                                  own error path, the way a synchronous throw already does
 *   routeErrorHandler(log)         the last middleware: a JSON answer with no stack trace
 *   installProcessSafetyNet(log)   a logged last resort for rejections nothing awaited
 *
 * IDENTICAL COPIES of this file live in deploy/identity, deploy/mcp-relay, deploy/validator
 * and applications/_shared/vertical-bridge. Each is a separate image that copies its own
 * sources and shares no package with the others (the same reason cors-allowlist.ts is
 * copied). tests/route-errors-every-service.test.ts fails if the copies differ.
 */
import { createRequire } from 'node:module';
import { STATUS_CODES } from 'node:http';

type Next = (err?: unknown) => void;
type Handle = (...args: unknown[]) => unknown;
interface LayerPrototype {
  handle: Handle;
  handle_request(req: unknown, res: unknown, next: Next): void;
  handle_error(error: unknown, req: unknown, res: unknown, next: Next): void;
}

const FORWARDS = Symbol.for('interego.routeErrors.forwardsRejections');

/**
 * Make every handler's rejected promise reach `next(err)`.
 *
 * Express 5 does this itself, so this returns 'native' and changes nothing. On Express 4
 * it replaces the two methods of express's internal Layer that call a handler, keeping
 * their behaviour and adding one thing: when the handler returns a promise that rejects,
 * the rejection is passed to `next`. This is how the express-async-errors package works,
 * done here so no service takes a new dependency.
 *
 * Patching the Layer rather than wrapping each handler matters in two ways. Every router
 * built from this copy of express is covered, including the sub-routers a module creates
 * with express.Router(), not only the routes added through `app`. And each layer's
 * `handle` stays the function that was registered: its arity is what Express reads to
 * tell an error handler (four parameters) from a request handler, and the relay reads a
 * tag on it to check its middleware order (ns-dereference.ts).
 *
 * A handler that has already called next() and then rejects is logged rather than passed
 * on: a second next() would run the rest of the chain twice. Applies to the whole
 * process, once; repeated calls do nothing, and the first call's `log` is the one used.
 */
export function forwardAsyncRouteErrors(log: (msg: string) => void): 'patched' | 'native' {
  const require = createRequire(import.meta.url);
  const { version } = require('express/package.json') as { version: string };
  if (Number(version.split('.')[0]) >= 5) return 'native';
  const proto = (require('express/lib/router/layer.js') as { prototype: LayerPrototype }).prototype;
  if ((proto as unknown as Record<symbol, unknown>)[FORWARDS] === true) return 'patched';
  if (typeof proto.handle_request !== 'function' || typeof proto.handle_error !== 'function') {
    throw new Error(`route-errors: express ${version} has no Layer.handle_request/handle_error to patch`);
  }
  // Each is express 4's own body (lib/router/layer.js) with the promise passed to settle().
  proto.handle_request = function handleRequest(this: LayerPrototype, req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) { next(); return; } // an error handler: not for a request
    settle(log, next, onward => fn(req, res, onward));
  };
  proto.handle_error = function handleError(this: LayerPrototype, error, req, res, next) {
    const fn = this.handle;
    if (fn.length !== 4) { next(error); return; } // not an error handler
    settle(log, next, onward => fn(error, req, res, onward));
  };
  Object.defineProperty(proto, FORWARDS, { value: true });
  return 'patched';
}

function settle(log: (msg: string) => void, next: Next, call: (onward: Next) => unknown): void {
  let handedOn = false;
  const onward: Next = (err) => { handedOn = true; next(err); };
  let result: unknown;
  try {
    result = call(onward);
  } catch (err) {
    next(err);
    return;
  }
  if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return;
  const then = (result as { then?: unknown }).then;
  if (typeof then !== 'function') return;
  then.call(result, undefined, (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error('async route handler rejected with a non-Error value');
    if (handedOn) {
      log(`ERROR: route_rejected_after_next ${describe(err)}`);
      return;
    }
    next(err);
  });
}

interface ReqLike { method?: string; path?: string }
interface ResLike {
  headersSent: boolean;
  status(code: number): ResLike;
  json(body: unknown): unknown;
}

/**
 * The terminal error middleware. Register it LAST, after every route.
 *
 * A client error that names its status (a malformed or oversized JSON body from
 * express.json(), any http-errors value) keeps that status. Everything else is a 500.
 * The body is JSON and carries no stack trace and no message from inside the server:
 * Express's own default answers HTML, and with the stack trace whenever NODE_ENV is not
 * "production", which no image here sets. A 4xx error marked `expose` (the convention
 * body-parser and http-errors use for a message written for the client) adds that
 * message as `detail`. A 5xx is logged with its stack, under a stable marker.
 *
 * When the response has already started there is nothing to answer with, so the error
 * goes on to Express's default, which ends the connection.
 */
export function routeErrorHandler(log: (msg: string) => void) {
  return function routeError(err: unknown, req: ReqLike, res: ResLike, next: Next): void {
    if (res.headersSent) { next(err); return; }
    const e = (err ?? {}) as { status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown };
    const named = typeof e.status === 'number' ? e.status : e.statusCode;
    const status = typeof named === 'number' && Number.isInteger(named) && named >= 400 && named <= 599 ? named : 500;
    if (status >= 500) log(`ERROR: route_error ${req.method ?? ''} ${req.path ?? ''} ${describe(err)}`);
    const detail = status < 500 && e.expose === true && typeof e.message === 'string' ? e.message : undefined;
    res.status(status).json({ error: STATUS_CODES[status] ?? 'Error', ...(detail ? { detail } : {}) });
  };
}

let safetyNetInstalled = false;

/**
 * The process-level last resort. Call once, from a service's entry point, never from a
 * module that tests import: it changes how the whole process treats a failure.
 *
 * An unhandled rejection is logged under `ERROR: unhandled_rejection` and the service
 * keeps serving. By the time a rejection goes unhandled the code that made the promise
 * has already moved on, and the failed operation stopped where any awaited failure would
 * have; ending the process for it throws away every session, challenge and index in
 * memory, which is the larger harm.
 *
 * An uncaught exception is NOT survived. It is a synchronous throw that unwound an
 * arbitrary stack, possibly half way through changing shared state, and serving on from
 * there can answer later requests from corrupt state. This only logs it under
 * `FATAL: uncaught_exception` (the monitor event leaves Node's own handling in place), and
 * Node then prints it and exits with code 1 as it would anyway, so the platform restarts
 * the service clean.
 */
export function installProcessSafetyNet(log: (msg: string) => void): void {
  if (safetyNetInstalled) return;
  safetyNetInstalled = true;
  process.on('unhandledRejection', (reason) => {
    log(`ERROR: unhandled_rejection ${describe(reason)}`);
  });
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    log(`FATAL: uncaught_exception (${origin}) ${describe(err)}`);
  });
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  return `non-Error ${typeof value}`;
}
