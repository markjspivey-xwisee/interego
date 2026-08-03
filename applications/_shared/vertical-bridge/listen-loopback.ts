/**
 * A test server that cannot outlive the run that started it — vertical-bridge copy.
 *
 * ── WHY THIS EXISTS HERE, AS A SECOND COPY ───────────────────────────────────
 *
 * `deploy/mcp-relay/tests/listen-loopback.ts` closed this defect for the relay's suites and
 * `deploy/css-gate/tests/loopback.mjs` for the gate's. It was closed for ONE DIRECTORY,
 * not for the class: the two suites in THIS directory were still doing the worse version of
 * the same thing, and both run in CI (`.github/workflows/bridge-typecheck.yml`).
 *
 * Measured on this machine, before this file existed:
 *
 *     app.listen(6099)             → { address: "::", family: "IPv6", port: 6099 }
 *     app.listen(0, '127.0.0.1')   → { address: "127.0.0.1", family: "IPv4" }
 *
 * `::` is EVERY INTERFACE — and on a FIXED port, which is strictly worse than the ephemeral
 * `listen(0)` the original fix was written about: two runs of the same suite collide, and
 * the LAN binding is live for the whole run rather than for an unpredictable port. That
 * binding is what raised a Windows Defender firewall prompt from a unit test.
 *
 * `mcp-wire-contract.test.ts` also tore down with `finally { server.close(); }` and no
 * `closeAllConnections()` — the exact pair the relay's copy describes as insufficient:
 * `close()` stops accepting NEW connections and then waits for existing ones, and `fetch()`
 * keeps its sockets alive by default, so the close can never complete and the process never
 * exits. Eleven orphaned node processes were found still listening, the oldest six days old.
 *
 * ── WHY A COPY AND NOT AN IMPORT ─────────────────────────────────────────────
 *
 * This is a different deployment unit from the relay. `deploy/Dockerfile.relay` copies the
 * relay's sources file by file, and reaching into `deploy/mcp-relay/tests/` from
 * `applications/` would make an application depend on another unit's TEST directory —
 * coupling that survives only until someone prunes test files from a build. The css-gate
 * copy exists for the same reason and could not be shared either: it is plain `.mjs` with
 * no TypeScript in its package at all. Three units, three copies, one property.
 *
 * The property is kept honest across all three by the source scan in
 * `deploy/mcp-relay/tests/listen-loopback.test.ts`, which now walks the REPOSITORY rather
 * than one directory and fails on any suite that calls `.listen()` without naming
 * 127.0.0.1 — including this directory, and including any directory added later.
 *
 * ── WHAT THIS GUARANTEES ─────────────────────────────────────────────────────
 *
 *   - loopback only, always, because the host argument is not the caller's to forget;
 *   - an EPHEMERAL port, so two runs of the same suite cannot collide on 6098/6099;
 *   - `closeAllConnections()` before `close()`, so the close actually completes rather
 *     than blocking on an idle keep-alive socket;
 *   - `unref()`, so a server nobody closed cannot BY ITSELF hold the process open — the
 *     backstop for the path where the teardown is skipped entirely;
 *   - SIGINT / SIGTERM close every live listener and then exit with the conventional
 *     signal code, so ^C on a suite tears its sockets down instead of orphaning them.
 *
 * `unref()` is safe for these suites because each one starts a server and IMMEDIATELY
 * awaits requests against it, and pending work keeps the loop alive on its own. A harness
 * whose whole job is to stay listening for an external driver must not use this.
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
   * Safe to call twice — from a `finally` and an exit hook both. The second call resolves
   * rather than rejecting: `close()` on an already-closed server hands its callback an
   * `ERR_SERVER_NOT_RUNNING` that is deliberately not treated as a failure.
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
      if (closed) return;
      closed = true;
      live.delete(server);
      // ★ BEFORE close(), not after. Modern Node's close() drops IDLE connections itself,
      // but it still waits for ACTIVE ones. Destroying both is what makes the close
      // complete rather than block on a socket the test is finished with.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
