import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

let stage = 'configuration';
/** Test-only IPC: retain failure category, never connection details or quoted values. */
function startupFailure(error) {
  const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name.slice(0, 64) : 'Error';
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code.slice(0, 64) : undefined;
  let message = typeof error?.message === 'string' ? error.message : 'Startup failed without an Error message';
  // Redact full configured values before truncating; a secret may otherwise be
  // split at the diagnostic boundary and evade an exact-value replacement.
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 4 && /KEY|SECRET|TOKEN|PASSWORD|CAPABILITY|CONNSTR|URL/i.test(key)) {
      message = message.split(value).join('[redacted]');
      try {
        const url = new URL(value);
        for (const part of [url.username, url.password, url.hostname]) if (part.length >= 4) message = message.split(part).join('[redacted]');
      } catch { /* a key or token is not necessarily a URL */ }
    }
  }
  message = message
    .replace(/\b(?:https?|postgres(?:ql)?|redis|file):\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/(["'])(?:\\.|(?!\1)[^\r\n])*?\1/g, '$1[redacted]$1')
    .replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, '[encoded]')
    .replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, 360);
  return { event: 'failed', stage, error: { name, ...(code ? { code } : {}), message } };
}

try {
  const root = process.env.NATIVE_TEST_CSS_ROOT;
  const port = Number(process.env.NATIVE_TEST_CSS_PORT);
  const gatePort = Number(process.env.NATIVE_TEST_GATE_PORT);
  const capability = process.env.NATIVE_TEST_GATE_CAPABILITY;
  if (!root || !Number.isInteger(port) || port < 1 || !Number.isInteger(gatePort) || gatePort < 1 || port === gatePort
    || !capability || !process.env.PGSL_PG_CONNSTR || process.env.PGSL_INMEM === '1') throw new Error('Incomplete persistent native fixture configuration');
  const require = createRequire(path.join(root, 'package.json'));
  stage = 'css-module-load';
  const { AppRunner } = await import(pathToFileURL(require.resolve('@solid/community-server')).href);
  stage = 'css-construction';
  const app = await new AppRunner().create({
    loaderProperties: { mainModulePath: root, typeChecking: false },
    config: path.join(root, 'config', 'pgsl-server.json'),
    shorthand: { port, baseUrl: `http://127.0.0.1:${port}/`, loggingLevel: 'error',
      rootFilePath: path.join(os.tmpdir(), `interego-native-lrs-${port}`) },
  });
  stage = 'css-start';
  await app.start();
  stage = 'css-root-read';
  const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: 'text/turtle' } });
  if (!response.ok) throw new Error('Native fixture root unavailable');
  // Real production gate, with its existing operator-authority policy. Its
  // public origin deliberately differs from CSS's internal identifier space.
  process.env.CSS_INTERNAL_URL = `http://127.0.0.1:${port}/`;
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${gatePort}`;
  process.env.CSS_HOST_HEADER = `127.0.0.1:${port}`;
  process.env.WRITE_SECRET = capability;
  process.env.IDENTITY_URL = '';
  process.env.RELAY_VERIFY_URL = '';
  process.env.RELAY_INTROSPECTION_SECRET = '';
  process.env.CSS_GATE_AUTOSTART = '0';
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  stage = 'gate-module-load';
  const { server: gate } = await import(pathToFileURL(path.join(repository, 'deploy/css-gate/server.mjs')).href);
  stage = 'gate-start';
  await new Promise((resolve, reject) => {
    gate.once('error', reject);
    gate.listen(gatePort, '127.0.0.1', resolve);
  });
  const publicBase = process.env.PUBLIC_BASE_URL;
  stage = 'native-discovery';
  const advertised = await fetch(publicBase + '/', { method: 'OPTIONS' });
  if (!advertised.ok || advertised.headers.get('Interego-Native-Commit') !== '1') throw new Error('Native gate discovery unavailable');
  stage = 'anonymous-write-refusal';
  const anonymousWrite = await fetch(publicBase + '/native-fixture-anonymous-probe', {
    method: 'PUT', headers: { 'Content-Type': 'application/vnd.interego.native-commit+json' }, body: '{}',
  });
  if (anonymousWrite.status !== 401) throw new Error('Native fixture write authority was bypassed');
  stage = 'authenticated-read';
  const authenticatedRead = await fetch(publicBase + '/', { headers: { accept: 'text/turtle', Authorization: 'Bearer ' + capability } });
  if (!authenticatedRead.ok) throw new Error('Native fixture authenticated read unavailable');
  await authenticatedRead.arrayBuffer();
  process.send?.({ event: 'ready' });
} catch (error) {
  process.send?.(startupFailure(error));
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
}
