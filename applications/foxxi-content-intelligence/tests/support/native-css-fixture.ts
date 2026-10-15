import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

/** Synthetic authority for the isolated real gate; never a production credential. */
export const NATIVE_CSS_FIXTURE_CAPABILITY = 'native-css-fixture-existing-write-authority';

export interface NativeCssFixture {
  readonly podUrl: string;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

/** Isolated test server only. SQL is confined to Interego's existing substrate. */
export async function startNativeCssFixture(): Promise<NativeCssFixture> {
  const cssRoot = process.env.TEST_NATIVE_CSS_ROOT;
  const connectionString = process.env.TEST_NATIVE_PG_URL;
  if (!cssRoot || !connectionString) {
    throw new Error('Native recovery fixture requires TEST_NATIVE_CSS_ROOT and TEST_NATIVE_PG_URL');
  }
  const reservePort = async (): Promise<number> => {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Cannot allocate native fixture port');
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    return address.port;
  };
  const port = await reservePort();
  let gatePort = await reservePort();
  while (gatePort === port) gatePort = await reservePort();
  let child: ChildProcess | undefined;

  const stop = async (): Promise<void> => {
    const current = child;
    child = undefined;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    const ended = once(current, 'exit');
    current.kill('SIGKILL');
    await ended;
  };
  const boot = async (): Promise<void> => {
    const current = fork(fileURLToPath(new URL('./native-css-http-child.mjs', import.meta.url)), [], {
      silent: true,
      env: { ...process.env, PGSL_INMEM: '', PGSL_PG_CONNSTR: connectionString,
        NATIVE_TEST_CSS_ROOT: cssRoot, NATIVE_TEST_CSS_PORT: String(port),
        NATIVE_TEST_GATE_PORT: String(gatePort), NATIVE_TEST_GATE_CAPABILITY: NATIVE_CSS_FIXTURE_CAPABILITY },
      execArgv: [],
    });
    child = current;
    // Do not copy database URLs, keys or private record bodies into test reports.
    current.stdout?.resume();
    current.stderr?.resume();
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => { clearTimeout(timer); current.off('message', onMessage); current.off('exit', onExit); current.off('error', onError); };
        const onMessage = (message: unknown): void => {
          if (message && typeof message === 'object' && 'event' in message && message.event === 'ready') { cleanup(); resolve(); }
          else if (message && typeof message === 'object' && 'event' in message && message.event === 'failed') {
            cleanup();
            const failure = message as { stage?: unknown; error?: { name?: unknown; code?: unknown; message?: unknown } };
            const label = (value: unknown, fallback: string): string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : fallback;
            const stage = label(failure.stage, 'unknown-stage');
            const name = label(failure.error?.name, 'Error');
            const code = label(failure.error?.code, 'no-code');
            const detail = typeof failure.error?.message === 'string' ? failure.error.message.replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').slice(0, 360) : 'No sanitized detail';
            reject(new Error(`Native CSS fixture failed during ${stage} (${name}/${code}): ${detail}`));
          }
        };
        const onExit = (): void => { cleanup(); reject(new Error('Native CSS fixture exited before readiness')); };
        const onError = (): void => { cleanup(); reject(new Error('Native CSS fixture could not start')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Native CSS fixture readiness timed out')); }, 30_000);
        current.on('message', onMessage); current.once('exit', onExit); current.once('error', onError);
      });
    } catch (error) { await stop(); throw error; }
  };
  await boot();
  return {
    podUrl: `http://127.0.0.1:${gatePort}/`,
    async restart() { await stop(); await boot(); },
    stop,
  };
}
