import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rmdir, unlink } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppRunner, type App } from '@solid/community-server';
import type { LocalDeploymentConfig } from '@interego/deployment-config';

export interface LocalNodeOptions {
  /** Override the configured port. Zero requests an ephemeral port, useful for isolated hosts/tests. */
  readonly port?: number;
  readonly startupTimeoutMs?: number;
}

export interface LocalNode {
  /** Actual listening address; authoritative when an ephemeral port was requested. */
  readonly baseUrl: string;
  readonly podUrl: string;
  /** Authenticated, same-origin-only fetch. Credentials are never forwarded to another origin. */
  readonly fetch: typeof globalThis.fetch;
  stop(): Promise<void>;
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const CONFIG_PATH = fileURLToPath(new URL('../config/file-pod.json', import.meta.url));
const METHODS = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'];
const MEDIA_TYPES = new Set([
  'text/turtle', 'application/trig', 'application/n-triples', 'application/n-quads',
  'application/jose+json', 'application/octet-stream', 'text/plain',
]);

/** No request-selected context/profile loader or executable update language reaches CSS. */
function safeWriteMedia(value: string | undefined): boolean {
  if (!value) return false;
  const [type, ...parameters] = value.toLowerCase().split(';').map(part => part.trim());
  return Boolean(type && MEDIA_TYPES.has(type)) && parameters.every(parameter => /^charset=(?:utf-8|"utf-8")$/.test(parameter));
}

function safeAccept(value: string | undefined): boolean {
  if (!value) return true;
  return value.toLowerCase().split(',').every(range => {
    const [type, ...parameters] = range.split(';').map(part => part.trim());
    return Boolean(type && (MEDIA_TYPES.has(type) || ['*/*', 'application/*', 'text/*'].includes(type)))
      && parameters.every(parameter => /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(parameter));
  });
}

/**
 * ComponentsJS normally scans every ancestor node_modules, including unrelated applications.
 * Supply its supported moduleState seam with only CSS's component graph and the locally
 * installed ComponentsJS context. Runtime JS dependencies still use ordinary Node resolution.
 */
async function isolatedCssModules() {
  const require = createRequire(import.meta.url);
  const cssPackagePath = require.resolve('@solid/community-server/package.json');
  const cssRequire = createRequire(cssPackagePath);
  const componentPackagePath = cssRequire.resolve('componentsjs/package.json');
  const normalized = (path: string): string => path.replaceAll('\\', '/');
  const cssRoot = normalized(dirname(cssPackagePath));
  const componentRoot = normalized(dirname(componentPackagePath));
  const css = JSON.parse(await readFile(cssPackagePath, 'utf8')) as Record<string, unknown>;
  const components = JSON.parse(await readFile(componentPackagePath, 'utf8')) as Record<string, unknown>;
  const contexts: Record<string, string> = {};
  const importPaths: Record<string, string> = {};
  for (const [root, metadata] of [[cssRoot, css], [componentRoot, components]] as const) {
    for (const [iri, path] of Object.entries((metadata['lsd:contexts'] ?? {}) as Record<string, string>)) {
      // ComponentsJS 5's type says string, but its builder stores parsed context JSON.
      contexts[iri] = JSON.parse(await readFile(resolve(root, path), 'utf8'));
    }
    for (const [iri, path] of Object.entries((metadata['lsd:importPaths'] ?? {}) as Record<string, string>)) {
      importPaths[iri] = normalized(resolve(root, path)) + (/[\\/]$/.test(path) ? '/' : '');
    }
  }
  const moduleIri = css['lsd:module'];
  const componentPath = css['lsd:components'];
  if (typeof moduleIri !== 'string' || typeof componentPath !== 'string') {
    throw new Error('The installed CSS package does not describe its component graph.');
  }
  return {
    mainModulePath: cssRoot,
    nodeModuleImportPaths: [cssRoot],
    nodeModulePaths: [cssRoot, componentRoot],
    packageJsons: { [cssRoot]: css, [componentRoot]: components },
    componentModules: { [moduleIri]: normalized(resolve(cssRoot, componentPath)) },
    contexts,
    importPaths,
  };
}

function fail(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(message);
}

function credentialMatches(header: string | undefined, credential: string): boolean {
  if (!header) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${credential}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function loadCredential(dataDir: string): Promise<string> {
  const path = join(dataDir, 'service-credential');
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      const value = randomBytes(32).toString('base64url');
      await handle.writeFile(`${value}\n`, 'utf8');
      await handle.sync();
      return value;
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Local service credential must be a regular file.');
  const value = (await readFile(path, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('Local service credential is damaged. Restore it rather than silently replacing it.');
  }
  if (process.platform !== 'win32') await chmod(path, 0o600);
  return value;
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function probeSocket(socketPath: string, deadline: number, cancelled: () => boolean): Promise<void> {
  while (!cancelled() && Date.now() < deadline) {
    const ready = await new Promise<boolean>(resolve => {
      // App.start completed initialization; only wait for its IPC listener to bind.
      // An HTTP root listing here can outlive a timed-out probe and keep writing caches.
      const socket = createConnection({ path: socketPath });
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.setTimeout(250, () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(false));
      socket.once('close', () => resolve(false));
    });
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Local storage startup timed out.');
}

/**
 * Start an explicitly selected local node. This hosts descriptor/RDF-primary Solid storage;
 * it does not start the hosted relay, create a cloud identity, or enable federation transports.
 * The caller supplies encrypted content through the existing Solid publisher when privacy is needed.
 */
export async function startLocalNode(config: LocalDeploymentConfig, options: LocalNodeOptions = {}): Promise<LocalNode> {
  if (config.profile !== 'local') throw new Error('startLocalNode requires the local deployment profile.');
  if (config.federation.enabled) throw new Error('Federation transport is not included in this local runtime. Keep federation disabled.');
  if (!isAbsolute(config.dataDir) || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(config.dataDir))) {
    throw new Error('A local node requires a fully qualified durable directory on this machine.');
  }
  const configuredUrl = new URL(config.baseUrl);
  if (configuredUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(configuredUrl.hostname)
    || configuredUrl.pathname !== '/' || configuredUrl.search || configuredUrl.hash || configuredUrl.username || configuredUrl.password) {
    throw new Error('The local node requires a loopback HTTP origin without a path or credentials.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.podName)) throw new Error('Local pod name must be a simple path segment.');
  const port = options.port ?? Number(configuredUrl.port || 80);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local node port.');
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) throw new Error('Invalid local node startup timeout.');

  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const dataDir = await realpath(config.dataDir);
  if (process.platform !== 'win32') {
    const directory = await lstat(dataDir);
    if ((directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid())) {
      throw new Error('The local data directory must be owned by the current user and have private permissions (0700).');
    }
  }
  const lockPath = join(dataDir, 'runtime.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('This data directory is locked by a local node. Check that it has stopped before removing a stale runtime.lock.');
    }
    throw error;
  }
  const lockId = randomUUID();
  let app: App | undefined;
  let socketDir: string | undefined;
  let socketPath: string | undefined;
  let gateway: Server | undefined;
  let stopping: Promise<void> | undefined;
  let startupTask: Promise<void> | undefined;
  let cancelled = false;
  const cleanup = (): Promise<void> => stopping ??= (async () => {
    const errors: unknown[] = [];
    if (gateway) { try { await closeServer(gateway); } catch (error) { errors.push(error); } }
    // AppRunner has no cancellation primitive. Retain the writer lock until a late
    // create/start settles, so a timeout cannot overlap a replacement runtime.
    if (cancelled && startupTask) { try { await startupTask; } catch { /* Startup failure is returned by the caller. */ } }
    let backendStopped = !app;
    if (app) { try { await app.stop(); backendStopped = true; } catch (error) { errors.push(error); } }
    if (backendStopped && socketPath && socketDir) { try { await unlink(socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error); } }
    if (backendStopped && socketDir) { try { await rmdir(socketDir); } catch (error) { errors.push(error); } }
    try { await lock.close(); } catch (error) { errors.push(error); }
    if (backendStopped) {
      try {
        if (JSON.parse(await readFile(lockPath, 'utf8')).id === lockId) await unlink(lockPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Local node cleanup failed.');
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await lock.writeFile(JSON.stringify({ version: 1, id: lockId, pid: process.pid }), 'utf8');
    const credential = await loadCredential(dataDir);
    await mkdir(join(dataDir, 'pod'), { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') socketPath = `\\\\.\\pipe\\interego-${randomUUID()}`;
    else {
      socketDir = await mkdtemp(join(tmpdir(), 'interego-'));
      await chmod(socketDir, 0o700);
      socketPath = join(socketDir, 'pod.sock');
    }
    const ipcPath = socketPath;
    let origin = '';
    let podPath = '';
    let ready = false;
    const authorized = (request: IncomingMessage): boolean => credentialMatches(request.headers.authorization, credential);
    gateway = createServer((request, response) => {
      if (!origin) { fail(response, 503, 'Local storage is starting.'); return; }
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) {
        fail(response, 403, 'Local origin refused.'); return;
      }
      if (!authorized(request)) { fail(response, 401, 'Local authorization required.'); return; }
      if (!ready) { fail(response, 503, 'Local storage is starting.'); return; }
      if (!METHODS.includes(request.method ?? '')) {
        response.setHeader('allow', METHODS.join(', '));
        fail(response, 405, 'This local runtime does not support that method.'); return;
      }
      if (request.method === 'PUT' && !safeWriteMedia(request.headers['content-type'])) {
        fail(response, 415, 'This local runtime accepts core RDF and opaque media without remote loaders.'); return;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && !safeAccept(request.headers.accept)) {
        fail(response, 406, 'This local runtime does not offer that representation or remote profile.'); return;
      }
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) { fail(response, 400, 'Invalid local request.'); return; }
      let url: URL;
      try {
        url = new URL(request.url, origin);
        const decoded = decodeURIComponent(url.pathname);
        if (/%2f|%5c|%00/i.test(url.pathname) || decoded.includes('\\') || decoded.split('/').includes('..')) throw new Error('path');
      } catch { fail(response, 400, 'Invalid local path.'); return; }
      if (!url.pathname.startsWith(podPath)) { fail(response, 404, 'No local pod resource at this path.'); return; }
      const headers: IncomingHttpHeaders = { ...request.headers, host: new URL(origin).host };
      const connectionHeaders = String(headers.connection ?? '').split(',').map(header => header.trim().toLowerCase());
      for (const header of Object.keys(headers)) {
        if (HOP_HEADERS.has(header) || connectionHeaders.includes(header) || header === 'authorization' || header.startsWith('x-forwarded-')) delete headers[header];
      }
      const upstream = httpRequest({ socketPath: ipcPath, path: `${url.pathname}${url.search}`, method: request.method, headers }, result => {
        const responseHeaders = { ...result.headers };
        for (const header of HOP_HEADERS) delete responseHeaders[header];
        if (responseHeaders.allow) responseHeaders.allow = METHODS.join(', ');
        response.writeHead(result.statusCode ?? 502, responseHeaders);
        result.pipe(response);
      });
      upstream.setTimeout(30_000, () => upstream.destroy(new Error('Local storage request timeout.')));
      upstream.once('error', () => {
        if (!response.headersSent) fail(response, 502, 'Local storage request failed.');
        else response.destroy();
      });
      request.once('aborted', () => upstream.destroy());
      response.once('close', () => { if (!response.writableFinished) upstream.destroy(); });
      request.pipe(upstream);
    });
    gateway.requestTimeout = 30_000;
    gateway.headersTimeout = 15_000;
    gateway.maxHeadersCount = 100;
    gateway.on('upgrade', (request, socket) => {
      const sameOrigin = origin && request.headers.host === new URL(origin).host
        && (!request.headers.origin || request.headers.origin === origin);
      const status = !sameOrigin ? '403 Forbidden' : authorized(request) ? '501 Not Implemented' : '401 Unauthorized';
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    gateway.on('clientError', (_error, socket) => socket.destroy());
    const host = configuredUrl.hostname === '[::1]' ? '::1' : '127.0.0.1';
    await listen(gateway, port, host);
    const address = gateway.address();
    if (!address || typeof address === 'string') throw new Error('Local gateway did not open a TCP listener.');
    const baseUrl = `http://${host === '::1' ? '[::1]' : host}:${address.port}/`;
    origin = new URL(baseUrl).origin;
    podPath = `/${config.podName}/`;
    const podUrl = new URL(podPath, baseUrl).href;

    startupTask = (async () => {
      const moduleState = await isolatedCssModules();
      const created = await new AppRunner().create({
        loaderProperties: { moduleState, mainModulePath: moduleState.mainModulePath, typeChecking: false },
        config: CONFIG_PATH,
        shorthand: { baseUrl, rootFilePath: join(dataDir, 'pod'), socket: ipcPath, loggingLevel: 'error' },
      });
      app = created;
      if (cancelled) return;
      await app.start();
      if (cancelled) return;
      await probeSocket(ipcPath, Date.now() + startupTimeoutMs, () => cancelled);
    })();
    await Promise.race([startupTask, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { cancelled = true; reject(new Error('Local node startup timed out.')); }, startupTimeoutMs);
    })]);
    if (timer) clearTimeout(timer);
    ready = true;

    const localFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url && new URL(request.url).origin !== origin) throw new Error('Local credentials cannot be sent to another origin.');
      if (stopping) throw new Error('The local node has stopped.');
      const headers = new Headers(request.headers);
      headers.set('authorization', `Bearer ${credential}`);
      return globalThis.fetch(new Request(request, { headers, redirect: 'error' }));
    };
    const hasPodContainer = async (): Promise<boolean> => {
      const existing = await localFetch(podUrl, { method: 'HEAD' });
      await existing.arrayBuffer();
      if (existing.status === 404) return false;
      if (!existing.ok) throw new Error(`Local pod inspection failed (${existing.status}).`);
      const types = existing.headers.get('link') ?? '';
      if (!types.includes('<http://www.w3.org/ns/ldp#BasicContainer>') && !types.includes('<http://www.w3.org/ns/ldp#Container>')) {
        throw new Error('The configured local pod path already exists without a container type.');
      }
      return true;
    };
    // CSS rejects existing-container PUT before evaluating If-None-Match. Inspect first,
    // keep the conditional create for races, and verify any conflict by rereading the pod.
    if (!await hasPodContainer()) {
      const provisioned = await localFetch(podUrl, {
        method: 'PUT', headers: {
          'content-type': 'text/turtle', link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"', 'if-none-match': '*',
        }, body: '',
      });
      await provisioned.arrayBuffer();
      if (!provisioned.ok && !([409, 412].includes(provisioned.status) && await hasPodContainer())) {
        throw new Error(`Local pod provisioning failed (${provisioned.status}).`);
      }
    }
    return Object.freeze({ baseUrl, podUrl, fetch: localFetch, stop: cleanup });
  } catch (error) {
    cancelled = true;
    if (timer) clearTimeout(timer);
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Local node startup and cleanup failed.'); }
    throw error;
  }
}
