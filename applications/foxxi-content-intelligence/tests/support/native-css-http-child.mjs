import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer, request } from 'node:http';
import { createServer as reservePort } from 'node:net';

try {
  const root = process.env.NATIVE_TEST_CSS_ROOT;
  const port = Number(process.env.NATIVE_TEST_CSS_PORT);
  const capability = process.env.NATIVE_TEST_CSS_CAPABILITY;
  if (!root || !capability || !Number.isInteger(port) || port < 1 || !process.env.PGSL_PG_CONNSTR || process.env.PGSL_INMEM === '1') throw new Error('Incomplete persistent native fixture configuration');
  const reservation = reservePort();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('No native fixture port');
  const cssPort = address.port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const require = createRequire(path.join(root, 'package.json'));
  const { AppRunner } = await import(pathToFileURL(require.resolve('@solid/community-server')).href);
  const app = await new AppRunner().create({
    loaderProperties: { mainModulePath: root, typeChecking: false },
    config: path.join(root, 'config', 'pgsl-server.json'),
    shorthand: { port: cssPort, baseUrl: `http://127.0.0.1:${port}/`, loggingLevel: 'error',
      rootFilePath: path.join(os.tmpdir(), `interego-native-lrs-${port}`) },
  });
  await app.start();
  // Test-only equivalent of css-gate's opaque capability boundary. The real
  // CSS authentication stack remains intact: strip the verified fixture bearer
  // before forwarding to CSS, which is intentionally allow-all below that gate.
  const gate = createServer((incoming, outgoing) => {
    if (incoming.headers.authorization !== `Bearer ${capability}`) {
      outgoing.writeHead(401); outgoing.end(); return;
    }
    const headers = { ...incoming.headers };
    delete headers.authorization;
    delete headers.connection;
    const upstream = request({ host: '127.0.0.1', port: cssPort, path: incoming.url,
      method: incoming.method, headers }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.on('error', () => outgoing.destroy());
      response.pipe(outgoing);
    });
    upstream.on('error', () => {
      if (outgoing.headersSent) outgoing.destroy();
      else { outgoing.writeHead(503); outgoing.end(); }
    });
    incoming.on('aborted', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise((resolve, reject) => { gate.once('error', reject); gate.listen(port, '127.0.0.1', resolve); });
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { accept: 'text/turtle', authorization: `Bearer ${capability}` },
  });
  if (!response.ok) throw new Error('Native fixture root unavailable');
  process.send?.({ event: 'ready' });
} catch {
  process.send?.({ event: 'failed' });
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
}
