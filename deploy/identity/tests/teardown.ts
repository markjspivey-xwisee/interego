/**
 * Teardown for the route suites, so an after() hook always finishes and leaves nothing behind
 * that would keep the test process alive.
 *
 * Each route suite runs server.ts as a child process over a stub pod server. Under `node --test`
 * a file is done only when its process exits, and a process with a live child, a listening
 * server or a pending timer does not exit. So teardown waits for the child to be gone (SIGTERM,
 * then SIGKILL after a grace period), closes the pod server together with every connection still
 * open on it (a keep-alive socket, or a request a test held and never let go), and treats an
 * unset handle as nothing to do: a before() hook that failed part-way leaves some unset, and a
 * `server?.close(resolve)` on one of those never calls resolve.
 */

import type { ChildProcess } from 'node:child_process';
import type * as http from 'node:http';

/** Stop a server child and resolve once it has exited, escalating to SIGKILL after `graceMs`. */
export async function stopChild(child: ChildProcess | undefined, graceMs = 5_000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), graceMs);
  try { await exited; } finally { clearTimeout(kill); }
}

/** Close an HTTP server and every connection on it, without waiting on any of them. */
export async function closeServer(server: http.Server | undefined): Promise<void> {
  if (!server?.listening) return;
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}
