/**
 * The multi-agent demos' Solid server survives Community Solid Server's hourly expired-entry sweep.
 *
 * Every expiring storage CSS builds (cookies, forgot-password records, ownership tokens, IdP
 * adapter entries) is a WrappedExpiringStorage that sweeps once an hour by walking the internal
 * value storage under /.internal/. CSS 7.3.0 lists each container on that walk by running
 * `for await` over the container's body. Read through the full ResourceStore, that body is Turtle,
 * in which it finds no member, inside the locking store's wrapper, which `for await` cannot read.
 * So the first sweep waits out the 6 s resource lock and then throws "callback is not a function"
 * from a stream callback, which ends the process. CSS writes /.internal/ itself at boot, so on
 * examples/multi-agent/css-config.json the server went down about an hour after every start.
 *
 * An hour is too long to wait, so this boots that config in this process on the root's CSS 7.3.0,
 * the release solid-server.ts now pins (a case below holds the two together), and runs three of the four
 * sweeps directly on the instances CSS built. The IdP adapter's has no @id to reach it by; it walks
 * the same storage. A sweep that waits for the lock never returns, and the process crashes when the
 * lock expires, so each sweep races a budget of half the lock and fails by name.
 *
 * The server gets the modules solid-server.ts hands npx (`-p <folder>`) and nothing else from this
 * repository. Components.js, CSS's configuration loader, would otherwise walk up from the root's CSS
 * into the root's node_modules, where @comunica 5 sits beside CSS's @comunica 2, and refuse to build
 * any configuration ("… ActorDereference … is not a valid component"). So, as packages/local-node
 * does, the loader is handed CSS's own component graph plus those modules, and each module is
 * required from its folder, where npx would find it by name beside CSS.
 *
 * It lives here, not in `tests/`, because it reads `examples/`, which the base runs without.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppRunner, type App } from '@solid/community-server';
import { SOLID_SERVER_BIN, SOLID_SERVER_PACKAGE, solidServerLaunch } from '../../examples/multi-agent/solid-server.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'examples', 'multi-agent');
const CONFIG = join(DIR, 'css-config.json');
const STARTUP_MS = 120_000;
/** css:config/util/resource-locker/memory.json: an unreadable listing waits this long, then crashes. */
const LOCK_EXPIRY_MS = 6_000;

type PackageJson = Record<string, unknown> & { name?: string; main?: string };
type Manager = {
  instantiate(id: string, settings?: Record<string, unknown>): Promise<unknown>;
  configRegistry: { register(path: string): Promise<void> };
};
type Sweeping = {
  set(key: string, value: unknown, expires?: number): Promise<unknown>;
  removeExpiredEntries(): Promise<void>;
};
type Storage = { get(key: string): Promise<unknown> };
/** AppRunner, as this file drives it: loaderFor's properties are Components.js's, untyped here. */
type Runner = {
  createComponentsManager(...args: unknown[]): Promise<Manager>;
  create(input: Record<string, unknown>): Promise<App>;
};

const normalized = (path: string): string => path.replaceAll('\\', '/');
const readJson = async (path: string): Promise<PackageJson> => JSON.parse(await readFile(path, 'utf8')) as PackageJson;

/** The local folders solid-server.ts puts beside CSS with `npx -p <folder>`, before the server's own arguments. */
const launchedModules = (): string[] => {
  const { args } = solidServerLaunch({ config: CONFIG, port: 3456, baseUrl: 'http://localhost:3456/', workDir: join(tmpdir(), 'unused') });
  const npx = args.slice(0, Math.max(0, args.indexOf(SOLID_SERVER_BIN)));
  return npx.flatMap((arg, i) => (arg === '-p' && isAbsolute(npx[i + 1] ?? '') ? [npx[i + 1]!] : []));
};

/**
 * What Components.js would discover beside CSS under npx: CSS's component graph, the Components.js
 * context CSS was built against, and the given modules. Nothing else in this repository's tree.
 */
async function loaderFor(modules: readonly string[]) {
  const cssPackagePath = createRequire(import.meta.url).resolve('@solid/community-server/package.json');
  const cssRequire = createRequire(cssPackagePath);
  const componentsPackagePath = cssRequire.resolve('componentsjs/package.json');
  const cssRoot = normalized(dirname(cssPackagePath));
  const roots = [cssRoot, normalized(dirname(componentsPackagePath)), ...modules.map(normalized)];
  const packageJsons: Record<string, PackageJson> = {};
  const contexts: Record<string, unknown> = {};
  const importPaths: Record<string, string> = {};
  const componentModules: Record<string, string> = {};
  const requireNames: Record<string, string> = {};
  for (const root of roots) {
    const pkg = await readJson(join(root, 'package.json'));
    packageJsons[root] = pkg;
    for (const [iri, path] of Object.entries((pkg['lsd:contexts'] ?? {}) as Record<string, string>)) {
      contexts[iri] = await readJson(resolve(root, path));
    }
    for (const [iri, path] of Object.entries((pkg['lsd:importPaths'] ?? {}) as Record<string, string>)) {
      importPaths[iri] = normalized(resolve(root, path)) + (/[\\/]$/.test(path) ? '/' : '');
    }
    const moduleIri = pkg['lsd:module'];
    const components = pkg['lsd:components'];
    if (typeof moduleIri === 'string' && typeof components === 'string') {
      componentModules[moduleIri] = normalized(resolve(root, components));
    }
    if (modules.map(normalized).includes(root) && pkg.name && pkg.main) requireNames[pkg.name] = resolve(root, pkg.main);
  }
  const { ConstructionStrategyCommonJs } = cssRequire('componentsjs') as {
    ConstructionStrategyCommonJs: new (options: { req: NodeJS.Require; overrideRequireNames: Record<string, string> }) => unknown;
  };
  return {
    moduleState: {
      mainModulePath: cssRoot,
      nodeModuleImportPaths: [cssRoot],
      nodeModulePaths: roots,
      packageJsons,
      componentModules,
      contexts,
      importPaths,
    },
    mainModulePath: cssRoot,
    typeChecking: false,
    constructionStrategy: new ConstructionStrategyCommonJs({ req: cssRequire, overrideRequireNames: requireNames }),
  };
}

const freePort = async (): Promise<number> => new Promise((done, fail) => {
  const probe = createServer();
  probe.once('error', fail);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => done(port));
  });
});

describe('the multi-agent Solid server survives the hourly expired-entry sweep', () => {
  let fixtureDir: string;
  let app: App | undefined;
  let manager: Manager | undefined;
  let settings: Record<string, unknown> = {};
  let baseUrl = '';

  const get = async <T>(id: string): Promise<T> => {
    if (!manager) throw new Error('The components manager was not captured.');
    // Built during startup and cached by id, so these are the instances the running server uses.
    return (await manager.instantiate(`urn:solid-server:default:${id}`, settings)) as T;
  };
  // A sweep that waits for the lock does not return late: it never returns, and the process
  // crashes when the lock expires. So each sweep races a budget of half the lock, and fails by name.
  const sweepAll = async (): Promise<void> => {
    for (const id of ['CookieStorage', 'ForgotPasswordStorage', 'ExpiringTokenStorage']) {
      const storage = await get<Sweeping>(id);
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${id}'s sweep took ${LOCK_EXPIRY_MS / 2} ms: it waited for the resource lock`)), LOCK_EXPIRY_MS / 2);
      });
      try { await Promise.race([storage.removeExpiredEntries(), budget]); }
      finally { clearTimeout(timer); }
    }
  };

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://localhost:${port}/`;
    fixtureDir = await mkdtemp(join(tmpdir(), 'interego-multi-agent-sweep-'));
    const runner = new AppRunner() as unknown as Runner;
    // Capture the components manager CSS builds, and the variables it instantiates with.
    const createManager = runner.createComponentsManager.bind(runner);
    runner.createComponentsManager = async (...args: unknown[]) => {
      manager = await createManager(...args);
      const instantiate = manager.instantiate.bind(manager);
      manager.instantiate = async (id, given = {}) => { settings = given; return instantiate(id, given); };
      return manager;
    };
    app = await runner.create({
      loaderProperties: await loaderFor(launchedModules()),
      config: CONFIG,
      shorthand: { port, baseUrl, rootFilePath: join(fixtureDir, 'pods'), loggingLevel: 'error' },
    });
    await app.start();
  }, STARTUP_MS);

  afterAll(async () => {
    try { await app?.stop(); }
    finally {
      // Only remove this test's own newly created temporary directory.
      if (fixtureDir && dirname(resolve(fixtureDir)) === resolve(tmpdir())
        && basename(fixtureDir).startsWith('interego-multi-agent-sweep-')) {
        await rm(fixtureDir, { recursive: true, force: true });
      }
    }
  }, STARTUP_MS);

  it('sweeps a freshly started server at once, and the server keeps serving', async () => {
    await sweepAll();
    const response = await fetch(baseUrl, { headers: { accept: 'text/turtle' } });
    expect(response.status).toBe(200);
    await response.text();
  });

  it('deletes the expired cookie and keeps the live one', async () => {
    const cookies = await get<Sweeping>('CookieStorage');
    await cookies.set('expired', { accountId: 'a' }, 100);
    await cookies.set('live', { accountId: 'b' }, 60 * 60 * 1000);
    await new Promise((done) => setTimeout(done, 250));
    await sweepAll();
    // Read underneath the expiring wrapper: its own get() deletes on read and would hide the sweep.
    const internal = await get<Storage>('KeyValueStorage');
    expect(await internal.get('accounts/cookies/expired')).toBeUndefined();
    expect(await internal.get('accounts/cookies/live')).toBeDefined();
  });

  it('keeps the resource lock: the internal value storage still reads through the full ResourceStore', async () => {
    // The account and OIDC routes this config serves write the internal value storage's documents,
    // so it must not read them past the locking store, as packages/local-node's config can.
    const internal = await get<{ source: { constructor: { name: string }; source: unknown } }>('JsonResourceStorage');
    expect(internal.source.constructor.name).toBe('BufferedListingStore');
    expect(internal.source.source).toBe(await get('ResourceStore'));
  });

  it('keeps a session signed in through the account routes across a sweep', async () => {
    const created = await fetch(new URL('.account/account/', baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(created.status, await created.clone().text()).toBe(200);
    await created.arrayBuffer();
    const cookie = created.headers.get('set-cookie')?.split(';')[0];
    expect(cookie, 'the account route set no cookie').toMatch(/^css-account=./);
    const controls = async (headers: Record<string, string>): Promise<Record<string, unknown>> => {
      const response = await fetch(new URL('.account/', baseUrl), { headers: { accept: 'application/json', ...headers } });
      expect(response.status).toBe(200);
      return ((await response.json()) as { controls: { account: Record<string, unknown> } }).controls.account;
    };
    expect(await controls({})).not.toHaveProperty('logout');
    expect(await controls({ cookie: cookie! })).toHaveProperty('logout');
    await sweepAll();
    expect(await controls({ cookie: cookie! })).toHaveProperty('logout');
  });

  it('sweeps while a pod read is still open', async () => {
    const resource = new URL('sweep-open-read.bin', baseUrl);
    const body = Buffer.alloc(8 * 1024 * 1024, 7);
    const put = await fetch(resource, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body });
    expect(put.ok, `PUT answered ${put.status}`).toBe(true);
    await put.arrayBuffer();
    // The body is left unread, so CSS keeps this read's lock, and its reader count, until it is.
    const open = await fetch(resource);
    expect(open.status).toBe(200);
    try {
      await sweepAll();
      expect((await open.arrayBuffer()).byteLength).toBe(body.length);
    } finally {
      await open.body?.cancel().catch(() => undefined);
    }
  });
});

describe('the configs and the module they need', () => {
  const REDIS_CONFIG = join(DIR, 'css-config-redis.json');
  /** A components manager over the given modules, as CSS builds one, with no config instantiated. */
  const managerFor = async (modules: readonly string[]): Promise<Manager> => {
    const cssRequire = createRequire(createRequire(import.meta.url).resolve('@solid/community-server/package.json'));
    const { ComponentsManager } = cssRequire('componentsjs') as { ComponentsManager: { build(options: unknown): Promise<Manager> } };
    return ComponentsManager.build({ ...await loaderFor(modules), logLevel: 'error', dumpErrorState: false });
  };

  it('the demos start the release this file boots', async () => {
    const { version } = await readJson(createRequire(import.meta.url).resolve('@solid/community-server/package.json'));
    expect(SOLID_SERVER_PACKAGE).toBe(`@solid/community-server@${String(version)}`);
  });

  it('the module needs nothing but Node: npx links it, so its own imports resolve in this repository', async () => {
    for (const dir of launchedModules()) {
      const pkg = await readJson(join(dir, 'package.json'));
      expect(pkg.dependencies, dir).toBeUndefined();
      const source = await readFile(join(dir, pkg.main!), 'utf8');
      const required = [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/g)]
        .map((m) => m[1] ?? m[2] ?? m[3]);
      expect(required.length, 'the scan found no require at all').toBeGreaterThan(0);
      expect(required.filter((name) => !name!.startsWith('node:')), dir).toEqual([]);
    }
  });

  it('both configs import the listing fix', async () => {
    for (const config of [CONFIG, REDIS_CONFIG]) {
      const { import: imports } = JSON.parse(await readFile(config, 'utf8')) as { import: string[] };
      expect(imports, basename(config)).toContain('./css-internal-listing/config/internal-listing.json');
    }
  });

  it('the Redis config loads beside the module too', async () => {
    // Building anything from it starts a Redis client, which retries its placeholder address
    // forever, so this stops at loading: every import, the listing fix's included, resolves locally.
    const manager = await managerFor(launchedModules());
    await expect(manager.configRegistry.register(REDIS_CONFIG)).resolves.toBeUndefined();
  }, STARTUP_MS);

  it('a server started without the module refuses the config at boot, and fetches nothing instead', async () => {
    // Components.js fetches an import or a context it has no local copy of. The listing fix is
    // imported by a path beside the config and named by its full IRI, so there is nothing to fetch.
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      throw new Error('this test allows no network fetch');
    }) as typeof fetch;
    try {
      const failed = await (new AppRunner() as unknown as Runner).create({
        loaderProperties: await loaderFor([]),
        config: CONFIG,
        shorthand: { port: await freePort(), rootFilePath: join(tmpdir(), 'interego-multi-agent-sweep-unused'), loggingLevel: 'error' },
      }).then(() => undefined, (error: unknown) => error);
      expect(failed, 'CSS built the config without the module').toBeInstanceOf(Error);
      expect((failed as Error).message).toMatch(/^Could not create the server\nErrorResourcesContext: Could not find \(valid\) component types/);
      // CSS keeps only the message, which names an anonymous node, so build the storage directly
      // to see which component it could not find.
      const manager = await managerFor([]);
      await manager.configRegistry.register(CONFIG);
      const missing = await manager.instantiate('urn:solid-server:default:JsonResourceStorage', {
        variables: { 'urn:solid-server:default:variable:baseUrl': 'http://localhost:3456/' },
      }).then(() => undefined, (error: unknown) => error) as { exportContext?: () => unknown } | undefined;
      expect(missing?.exportContext, 'the storage was built without the module').toBeTypeOf('function');
      expect(JSON.stringify(missing!.exportContext!())).toContain('interego-css-internal-listing/^1.0.0/components/components.jsonld#BufferedListingStore');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toEqual([]);
  }, STARTUP_MS);
});
