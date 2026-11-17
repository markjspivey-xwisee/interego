/**
 * The Community Solid Server this server starts for itself when its home pod is on localhost and
 * nothing answers there (spec/STORAGE-TIERS.md, Tier 1).
 *
 * ★ NOT node_modules/.bin/community-solid-server. server.ts ran that binary, and it never started.
 * Components.js, the server's configuration loader, walks from the server's package directory up to
 * the filesystem root and loads the modules in every node_modules it passes. The server here is
 * installed in the repository's root node_modules, where that walk also finds the root's @comunica 5
 * beside the server's own @comunica 2, so it refused to build any configuration ("… ActorDereference
 * … is not a valid component"). The loader is now handed the server's own component graph, the
 * Components.js context it was built against, and the local modules the configuration imports, and
 * nothing else; each of those modules is required from its own folder. packages/local-node starts
 * its server the same way, and integrations/tests/multi-agent-css-expired-sweep.test.ts boots this
 * configuration so.
 *
 * ★ IN A CHILD PROCESS. The server logs through winston's Console transport, which writes to stdout,
 * and this process's stdout is the MCP stream. In a child, its output is a pipe that server.ts copies
 * to stderr, and a crash ends the Solid server, not the MCP session. The child is forked, so it runs
 * with this process's execArgv: under tsx it runs this file from source, compiled it runs dist/. It
 * stops when its parent goes away, through the IPC channel, so no server is left holding the port.
 *
 * ★ NOT THE DEMOS' npx LAUNCHER (examples/multi-agent/solid-server.ts). That runs a server npx
 * downloads into its cache, which needs the network on the first run, and the base may not import
 * examples/ (tools/base-neutrality-lint.mjs). The fallback runs the server installed in this tree, as
 * it always meant to; the configuration, and the module beside it, are found by path, as before. Where
 * none of that is installed (a package installed on its own has neither), it says so at once.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const HERE = dirname(THIS_FILE);
const requireHere = createRequire(import.meta.url);

export interface LocalSolidServerOptions {
  /** A Community Solid Server configuration file. */
  readonly config: string;
  readonly port: number;
  readonly baseUrl: string;
  /** Where the file backend keeps the pods. */
  readonly rootFilePath: string;
  readonly loggingLevel?: string;
}

/** What the child sends its parent once the server is listening. */
export interface LocalSolidServerListening {
  readonly type: 'listening';
  readonly baseUrl: string;
}

type PackageJson = Record<string, unknown> & { name?: string; main?: string };
type App = { start(): Promise<void>; stop(): Promise<void> };
type AppRunner = { create(input: Record<string, unknown>): Promise<App> };

const normalized = (path: string): string => path.replaceAll('\\', '/');
const readJson = async (path: string): Promise<PackageJson> => JSON.parse(await readFile(path, 'utf8')) as PackageJson;

/**
 * The configuration the fallback starts, examples/multi-agent/css-config.json, from where this file
 * runs: mcp-server/ from source, mcp-server/dist/ compiled. Undefined when neither has it.
 */
export function findLocalSolidServerConfig(from: string = HERE): string | undefined {
  return [resolve(from, '..'), resolve(from, '..', '..')]
    .map(root => join(root, 'examples', 'multi-agent', 'css-config.json'))
    .find(path => existsSync(path));
}

/** The server's package.json, as Node resolves it from here; undefined when it is not installed. */
export function findLocalSolidServerPackage(): string | undefined {
  try {
    return requireHere.resolve('@solid/community-server/package.json');
  } catch {
    return undefined;
  }
}

/**
 * The Components.js modules a configuration imports from beside itself: each `./<folder>/…` import
 * whose folder is a package with an `lsd:module`. css-config.json imports css-internal-listing/ so.
 */
export async function localModulesOf(config: string): Promise<string[]> {
  const { import: imports = [] } = JSON.parse(await readFile(config, 'utf8')) as { import?: string[] };
  const modules = new Set<string>();
  for (const path of imports) {
    const folder = /^\.\/([^/]+)\//.exec(path)?.[1];
    if (!folder) continue;
    const dir = join(dirname(config), folder);
    const pkg = await readJson(join(dir, 'package.json')).catch(() => undefined);
    if (typeof pkg?.['lsd:module'] === 'string') modules.add(dir);
  }
  return [...modules];
}

/**
 * What Components.js would discover beside an install of the server holding nothing but it and the
 * given modules: the server's component graph, the Components.js context it was built against, and
 * those modules, each required from its own folder by its package name.
 */
export async function isolatedLoader(modules: readonly string[]): Promise<{ loaderProperties: Record<string, unknown>; serverRequire: NodeJS.Require }> {
  const serverPackagePath = findLocalSolidServerPackage();
  if (!serverPackagePath) throw new Error('@solid/community-server is not installed where mcp-server can resolve it');
  const serverRequire = createRequire(serverPackagePath);
  const componentsPackagePath = serverRequire.resolve('componentsjs/package.json');
  const serverRoot = normalized(dirname(serverPackagePath));
  const moduleRoots = modules.map(normalized);
  const roots = [serverRoot, normalized(dirname(componentsPackagePath)), ...moduleRoots];
  const packageJsons: Record<string, PackageJson> = {};
  const contexts: Record<string, unknown> = {};
  const importPaths: Record<string, string> = {};
  const componentModules: Record<string, string> = {};
  const requireNames: Record<string, string> = {};
  for (const root of roots) {
    const pkg = await readJson(join(root, 'package.json'));
    packageJsons[root] = pkg;
    for (const [iri, path] of Object.entries((pkg['lsd:contexts'] ?? {}) as Record<string, string>)) {
      // Components.js's type says string, but its own builder stores the parsed context.
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
    if (moduleRoots.includes(root) && pkg.name && pkg.main) requireNames[pkg.name] = resolve(root, pkg.main);
  }
  const { ConstructionStrategyCommonJs } = serverRequire('componentsjs') as {
    ConstructionStrategyCommonJs: new (options: { req: NodeJS.Require; overrideRequireNames: Record<string, string> }) => unknown;
  };
  return {
    loaderProperties: {
      moduleState: {
        mainModulePath: serverRoot,
        nodeModuleImportPaths: [serverRoot],
        nodeModulePaths: roots,
        packageJsons,
        componentModules,
        contexts,
        importPaths,
      },
      mainModulePath: serverRoot,
      typeChecking: false,
      constructionStrategy: new ConstructionStrategyCommonJs({ req: serverRequire, overrideRequireNames: requireNames }),
    },
    serverRequire,
  };
}

/** Build the server from the configuration, with an isolated module graph, and start it in this process. */
export async function bootLocalSolidServer(options: LocalSolidServerOptions): Promise<App> {
  const { loaderProperties, serverRequire } = await isolatedLoader(await localModulesOf(options.config));
  const { AppRunner } = serverRequire('@solid/community-server') as { AppRunner: new () => AppRunner };
  const app = await new AppRunner().create({
    loaderProperties,
    config: options.config,
    shorthand: {
      port: options.port,
      baseUrl: options.baseUrl,
      rootFilePath: options.rootFilePath,
      loggingLevel: options.loggingLevel ?? 'warn',
    },
  });
  await app.start();
  return app;
}

/**
 * Start the server in a child process running this file. Its stdout and stderr are pipes, which the
 * caller must read, and it sends a {@link LocalSolidServerListening} message once it listens.
 */
export function forkLocalSolidServer(options: LocalSolidServerOptions, execArgv: readonly string[] = process.execArgv): ChildProcess {
  return fork(THIS_FILE, [JSON.stringify(options)], { execArgv: [...execArgv], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
}

/** The child: boot, tell the parent, and stop when the parent goes away or asks. */
async function runChild(): Promise<void> {
  const options = JSON.parse(process.argv[2] ?? '') as LocalSolidServerOptions;
  let app: App | undefined;
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void Promise.resolve(app?.stop()).catch(() => undefined).finally(() => process.exit(0));
  };
  // `on`, not `once`: signal-exit, which the server loads, re-raises a signal on any process left
  // with only its own handler, and a `once` handler is removed before the next one runs.
  process.on('disconnect', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    app = await bootLocalSolidServer(options);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  const listening: LocalSolidServerListening = { type: 'listening', baseUrl: options.baseUrl };
  process.send?.(listening);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === THIS_FILE && process.send) {
  void runChild();
}
