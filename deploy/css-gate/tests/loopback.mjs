// A test server that cannot outlive the run that started it.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// These suites start three or four loopback servers each — an "upstream", a couple of
// verifiers, and the gate's own exported http.Server — and closed them in a final
// `test('teardown')`. That is a teardown that only runs if the file gets that far, and a
// close that only completes if nothing is still holding a socket.
//
// The mechanism, measured rather than assumed. A script that listens, does one `fetch`,
// and then reaches its last line WITHOUT closing does not exit:
//
//     end of script reached
//     …and the process is still there, still bound, until something kills it
//
// A listening handle by itself keeps the event loop alive forever. That is how a unit
// test comes to be found still holding a port six days later.
//
// ── WHAT THIS GIVES ─────────────────────────────────────────────────────────
//
//   - `unref()`, so a listener nobody closed dies with the process instead of preventing
//     the process from dying. This is the one that turns "leaked forever" into "gone";
//   - `closeAllConnections()` before `close()`, so the close completes rather than
//     waiting on the keep-alive sockets `fetch()` leaves behind;
//   - a SIGINT / SIGTERM drain, so ^C on a suite mid-run tears the sockets down;
//   - an idempotent `close()`, so it is safe from an `after()` hook that a passing run
//     also reaches.
//
// Not named `*.test.mjs`, so `node --test` does not pick it up as a test file.

/** Every listener this process has open. Drained by the signal handlers below. */
const live = new Set();

let signalsInstalled = false;
function installSignalTeardown() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      for (const s of live) { s.closeAllConnections(); s.close(); }
      live.clear();
      process.exit(code);
    });
  }
}

/**
 * Bind an existing `http.Server` to an ephemeral LOOPBACK port.
 *
 * Takes a server rather than creating one because the gate's server is the module's own
 * export — the thing under test — and must not be replaced by a copy of itself.
 *
 * @param {import('node:http').Server} server
 * @returns {Promise<{ base: string, port: number, server: import('node:http').Server, close: () => Promise<void> }>}
 */
export async function listenLoopback(server) {
  installSignalTeardown();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  live.add(server);
  server.unref();
  const { port } = server.address();
  let closed = false;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      live.delete(server);
      // ★ BEFORE close(), not after: close() stops accepting and then WAITS for the
      // connections fetch() is holding open.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
