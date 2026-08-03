/**
 * A test server that cannot outlive the run that started it.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Every suite in this directory that "boots Express on an ephemeral port and speaks to
 * itself" wrote the same three lines by hand, and every copy had the same two defects.
 *
 *   1. `app.listen(0)` — NO HOST. Measured on this machine:
 *
 *        listen(0)              → { address: "::",        family: "IPv6" }
 *        listen(0, "127.0.0.1") → { address: "127.0.0.1",  family: "IPv4" }
 *
 *      `::` is EVERY INTERFACE. A fixture that only ever talks to itself was reachable
 *      from the LAN for as long as it lived — which is how a unit test came to raise a
 *      Windows Defender firewall prompt.
 *
 *   2. `srv.close()` written as the last statement of a linear block, so it is skipped by
 *      every path that does not reach the last statement: a failed assertion that throws,
 *      a `fetch` that rejects, a `.json()` on a body that is not JSON, an interrupted run.
 *      Eleven orphaned node processes were found still listening, the oldest six days old.
 *
 *      `close()` on its own is not enough either: it stops accepting NEW connections and
 *      then waits for existing ones, and `fetch()` keeps its sockets alive by default. A
 *      close that never completes is a process that never exits — still holding the port.
 *
 * ── WHAT THIS GUARANTEES ─────────────────────────────────────────────────────
 *
 *   - loopback only, always, because the host argument is not the caller's to forget;
 *   - `closeAllConnections()` before `close()`, so the close actually completes rather
 *     than blocking on an idle keep-alive socket;
 *   - `unref()`, so a server nobody closed cannot BY ITSELF hold the process open — the
 *     backstop for the path where the teardown is skipped entirely;
 *   - SIGINT / SIGTERM close every live listener and then exit with the conventional
 *     signal code, so ^C on a long suite tears its sockets down instead of orphaning them.
 *
 * `unref()` is safe for these suites and only these suites: each one starts a server and
 * IMMEDIATELY awaits requests against it, and pending work keeps the loop alive on its
 * own. A harness whose whole job is to stay listening for an external driver — tests/
 * tck-sut.ts — must not use this, and does not.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** An Express app, or anything else with `listen(port, host, cb)`. Structural on purpose. */
export interface Listenable {
  listen(port: number, host: string, cb: () => void): Server;
}

export interface TestListener {
  /** `http://127.0.0.1:<port>` — the only address this server answers on. */
  readonly base: string;
  readonly port: number;
  readonly server: Server;
  /**
   * Safe to call twice — from an `after` hook and a `finally` both. The second call
   * resolves rather than rejecting: `close()` on an already-closed server hands its
   * callback an `ERR_SERVER_NOT_RUNNING` that is deliberately not treated as a failure.
   */
  close(): Promise<void>;
}

/** Every listener this process has open. Drained by the signal handlers below. */
const live = new Set<Server>();

let signalsInstalled = false;
function installSignalTeardown(): void {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.once(signal, () => {
      for (const s of live) {
        s.closeAllConnections();
        s.close();
      }
      live.clear();
      // Conventional 128+signo. Exiting explicitly matters: once a listener exists the
      // default signal disposition is no longer guaranteed to end the process promptly,
      // and "prompt" is the whole property being restored here.
      process.exit(code);
    });
  }
}

/** Bind `app` to an ephemeral LOOPBACK port and return the base URL plus a safe close. */
export async function listenLoopback(app: Listenable): Promise<TestListener> {
  installSignalTeardown();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  live.add(server);
  // A listening handle normally keeps the event loop alive by itself. Unref'd, it does
  // not — so the worst case of a skipped teardown is a socket that dies with the process
  // rather than a process that will not die because of a socket.
  server.unref();
  const { port } = server.address() as AddressInfo;
  let closed = false;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    server,
    close: async (): Promise<void> => {
      // Short-circuit, not a guard: a second close is harmless without it — Node hands
      // the callback ERR_SERVER_NOT_RUNNING and this resolves anyway. Said plainly
      // because a mutation check confirmed removing it changes nothing observable, and a
      // line described as a guard that guards nothing misleads the next reader about
      // what here is load-bearing.
      if (closed) return;
      closed = true;
      live.delete(server);
      // ★ BEFORE close(), not after. Modern Node's close() drops IDLE connections itself,
      // but it still waits for ACTIVE ones — and mcp-transport-wiring holds an SSE stream
      // open, which is exactly an active connection. Destroying both is what makes the
      // close complete rather than block on a stream the test is finished with.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
