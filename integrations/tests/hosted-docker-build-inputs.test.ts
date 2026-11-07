/**
 * A root npm build can compile workspaces a partial image never copied, or discover
 * their manifests only after npm installed dependencies. Read both boundaries in
 * order; successful workstation builds and prebuilt dist/ cannot satisfy them.
 * This integration check reads application and library inputs across the hosted
 * fleet, including workspaces deliberately absent from the base-only checkout.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { copySources, matrixDockerfiles, prebuildRecipe, producedDirs, workspaceDirs } from '../../tools/deploy-bundle-scope.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
interface Manifest {
  workspaces?: string[] | { packages?: string[] };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as Manifest;
const rootManifest = manifest('.');
const rootScripts = rootManifest.scripts!;
const workspaces = workspaceDirs(ROOT);
const slash = (path: string): string => path.split('\\').join('/');
const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);
const declaredWorkspaces = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : rootManifest.workspaces?.packages ?? [];
const libraryRoots = declaredWorkspaces.filter(path => path.endsWith('/*')).map(path => path.slice(0, -2));
const libraryDirs = [...workspaces.values()].filter(dir => libraryRoots.some(root => inside(dir, root)));

/** TypeScript supplies its own source-file enumeration and config-extends resolution. */
const inputCache = new Map<string, string[]>();
function buildInputs(dir: string): string[] {
  const cached = inputCache.get(dir);
  if (cached) return cached;
  const inputs = new Set<string>([`${dir}/package.json`]);
  const remember = (absolute: string): void => {
    const rel = slash(relative(ROOT, absolute));
    if (!rel.startsWith('../') && !rel.includes('/node_modules/')) inputs.add(rel);
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(join(ROOT, dir, 'tsconfig.json'), {}, {
    ...ts.sys,
    readFile: (path) => { remember(path); return ts.sys.readFile(path); },
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (!parsed || parsed.errors.length) throw new Error(`${dir}: cannot resolve compiler inputs`);
  const outputs = producedDirs(dir, ROOT);
  for (const path of parsed.fileNames) {
    const rel = slash(relative(ROOT, path));
    if (!outputs.some(output => inside(rel, output))) inputs.add(rel);
  }
  const build = manifest(dir).scripts?.build;
  if (!build) throw new Error(`${dir}: missing workspace build script`);
  for (const match of build.matchAll(/(?:^|[\s;&|(])(?:node|tsx)\s+([./A-Za-z0-9_-]+\.(?:mjs|cjs|js|ts))/g)) {
    inputs.add(posix.normalize(`${dir}/${match[1]}`));
  }
  const result = [...inputs];
  inputCache.set(dir, result);
  return result;
}

function requiredWorkspaces(names: readonly string[]): string[] {
  const found = new Set<string>();
  const visit = (name: string): void => {
    const dir = workspaces.get(name);
    if (!dir) throw new Error(`Unknown build workspace ${name}`);
    if (found.has(dir)) return;
    found.add(dir);
    const pkg = manifest(dir);
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies,
      ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      if (workspaces.has(dependency)) visit(dependency);
    }
  };
  for (const name of names) visit(name);
  return [...found];
}

interface Copy { source: string; destination: string; directory: boolean }
interface Stage { cwd: string; copies: Copy[]; installs: Map<string, Copy[]> }
interface BuildCheck { command: string; root: string; workspaces: string[]; errors: string[] }

function workflowRunLines(command: string): string {
  // The shared reader consumes one workflow command per line. Examine every
  // Docker shell branch rather than letting one --workspace flag hide root runs.
  // Quoted semicolons in status text create inert lines with no npm command.
  return command.split(/&&|\|\||;/).map(part => `      ${part.trim().replace(/\)+\s*$/, '')}`).join('\n');
}

function originAt(destination: string, copies: readonly Copy[]): string | undefined {
  for (const copy of [...copies].reverse()) {
    if (!copy.directory && copy.destination === destination) return copy.source;
    if (copy.directory && inside(destination, copy.destination)) {
      const source = posix.join(copy.source, posix.relative(copy.destination, destination));
      // A directory COPY merges the files it contains; it does not erase earlier files.
      if (existsSync(join(ROOT, source))) return source;
    }
  }
  return undefined;
}

function inspectBuilds(text: string, scripts = rootScripts): BuildCheck[] {
  const instructions = text.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
    .replace(/\\[ \t]*\r?\n/g, ' ').split('\n').map(line => line.trim()).filter(Boolean);
  const stages = new Map<string, Stage>();
  let state: Stage = { cwd: '/', copies: [], installs: new Map() };
  const checks: BuildCheck[] = [];
  for (const line of instructions) {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
    if (from) {
      const parent = stages.get(from[1]!);
      state = { cwd: parent?.cwd ?? '/', copies: [...parent?.copies ?? []], installs: new Map(parent?.installs) };
      if (from[2]) stages.set(from[2], state);
      continue;
    }
    const workdir = /^WORKDIR\s+(\S+)$/i.exec(line);
    if (workdir) { state.cwd = posix.resolve(state.cwd, workdir[1]!); continue; }
    if (/^COPY\s/i.test(line)) {
      // Reuse the shipping scope reader's supported grammar and fail-closed refusals.
      if (/\s--from=/.test(line)) continue;
      const sources = copySources(line);
      if (!sources.confident) throw new Error(sources.reason);
      const args = line.split(/\s+/).slice(1).filter(part => !part.startsWith('--'));
      const target = args.at(-1)!;
      const destination = posix.resolve(state.cwd, target);
      for (const source of sources.paths) {
        const directory = statSync(join(ROOT, source)).isDirectory();
        state.copies.push({ source, directory, destination: directory ? destination
          : (target.endsWith('/') || sources.paths.length > 1 ? posix.join(destination, posix.basename(source)) : destination) });
      }
      continue;
    }
    if (!/^RUN\s/i.test(line)) continue;
    const command = line.slice(4);
    const rootManifest = originAt(posix.join(state.cwd, 'package.json'), state.copies);
    const rootLock = originAt(posix.join(state.cwd, 'package-lock.json'), state.copies);
    if (rootManifest !== 'package.json' && rootLock !== 'package-lock.json') continue;
    const install = /(?:^|[\s;&|(])npm\s+(?:ci|install)\b([^;&|]*)/.exec(command);
    const rootInstall = install && !/--prefix\b|--workspace(?:=|\s)|(?:^|\s)-w(?:=|\s)/.test(install[1]!);
    const build = /(?:^|[\s;&|(])npm\s+run\s+[A-Za-z0-9:_.-]+/.exec(command);
    if (rootInstall && (!build || install.index < build.index)) state.installs.set(state.cwd, [...state.copies]);
    if (build) {
      const recipe = prebuildRecipe('docker', `steps:\n  - name: workspace build\n    if: matrix.prebuild == 'docker'\n    run: |\n${workflowRunLines(command)}`, scripts);
      if (!recipe) throw new Error(`Cannot resolve root workspace build: ${command}`);
      const dirs = requiredWorkspaces(recipe.workspaces);
      const installed = state.installs.get(state.cwd) ?? [];
      const errors: string[] = [];
      const available = (path: string, copies: readonly Copy[]): boolean =>
        originAt(posix.join(state.cwd, path), copies) === path;
      for (const path of ['package.json', 'package-lock.json', ...dirs.map(dir => `${dir}/package.json`)]) {
        if (!available(path, installed)) errors.push(`${path} was not copied before the workspace dependency install`);
      }
      for (const dir of dirs) for (const path of buildInputs(dir)) {
        if (!available(path, state.copies)) errors.push(`${path} is unavailable when the workspace builds`);
      }
      checks.push({ command, root: state.cwd, workspaces: dirs, errors });
    }
    if (rootInstall && build && install.index > build.index) state.installs.set(state.cwd, [...state.copies]);
  }
  return checks;
}

const dockerfiles = [...new Set(matrixDockerfiles().values())];
function copiesLibraryWorkspaces(text: string): boolean {
  const sources = copySources(text);
  if (!sources.confident) throw new Error(sources.reason);
  return libraryDirs.some(dir => {
    const outputs = producedDirs(dir, ROOT);
    const isOutput = (source: string): boolean => outputs.some(output => inside(source, output));
    // A manifest beside a prebuilt dist/ is a consumer, not an in-image compiler.
    // Whole workspace trees or additional source/config inputs still need a build.
    return sources.paths.some(source => inside(dir, source)
      || (inside(source, dir) && source !== `${dir}/package.json` && !isOutput(source)))
      || (sources.paths.includes(`${dir}/package.json`) && !sources.paths.some(isOutput));
  });
}
function discoveryErrors(text: string): string[] {
  return copiesLibraryWorkspaces(text) && inspectBuilds(text).length === 0
    ? ['Library workspace COPY inputs have no resolvable root workspace build'] : [];
}
const inspectFleet = (): { dockerfile: string; checks: BuildCheck[] }[] => dockerfiles.map(dockerfile => ({
  dockerfile, checks: inspectBuilds(readFileSync(join(ROOT, dockerfile), 'utf8')),
})).filter(result => result.checks.length);
const bridge = (): string => readFileSync(join(ROOT, 'deploy/Dockerfile.interego-bridge'), 'utf8');
const errors = (text: string, scripts = rootScripts): string[] => inspectBuilds(text, scripts).flatMap(check => check.errors);

describe('partial hosted images have the workspaces their actual build commands require', () => {
  it('checks every root workspace build in the fleet against install-time and build-time COPY state', () => {
    const fleet = inspectFleet();
    expect(fleet.length).toBeGreaterThan(0);
    const libraryImages = dockerfiles.filter(dockerfile => copiesLibraryWorkspaces(readFileSync(join(ROOT, dockerfile), 'utf8')));
    expect(fleet.map(result => result.dockerfile).sort()).toEqual(libraryImages.sort());
    expect(fleet.flatMap(result => result.checks.flatMap(check => check.errors.map(error => `${result.dockerfile}: ${error}`)))).toEqual([]);
  });

  it('cannot hide a partial-library image by removing its root manifest COPY', () => {
    const mutated = bridge().replace(/^COPY package\.json package-lock\.json[^\r\n]*\r?\n/m, '');
    expect(mutated).not.toBe(bridge());
    expect(discoveryErrors(mutated)).toEqual(['Library workspace COPY inputs have no resolvable root workspace build']);
  });

  it('distinguishes a prebuilt-library consumer from an in-image workspace build', () => {
    const consumer = 'FROM node:22-slim\nWORKDIR /app\n'
      + 'COPY packages/pgsl-store/dist ./packages/pgsl-store/dist\n'
      + 'COPY packages/pgsl-store/package.json ./packages/pgsl-store/package.json';
    expect(copiesLibraryWorkspaces(consumer)).toBe(false);
    expect(discoveryErrors(consumer)).toEqual([]);
    expect(copiesLibraryWorkspaces(`${consumer}\nCOPY packages/pgsl-store/tsconfig.json ./packages/pgsl-store/tsconfig.json`)).toBe(true);
  });

  it('rejects a newly reached MCP application whose manifest alone was copied', () => {
    const scripts = { ...rootScripts, 'build:leaves': `${rootScripts['build:leaves']} && npm run build --workspace @interego/mcp` };
    const failures = errors(bridge(), scripts);
    expect(failures).toContain('mcp-server/server.ts is unavailable when the workspace builds');
    expect(failures).toContain('mcp-server/tsconfig.json is unavailable when the workspace builds');
    expect(failures).toContain('mcp-server/stage-shared-config.mjs is unavailable when the workspace builds');
  });

  it.each([
    'npm run build --workspace @interego/registry && npm run build',
    'npm run build; npm run build --workspace @interego/registry',
  ])('keeps every target in a grouped mixed root/workspace command: %s', commands => {
    const mutated = bridge().replace(/^RUN npm run[^\r\n]+/m,
      `RUN if [ "$PREBUILT" = "1" ]; then echo "cached; using packages"; else (${commands}); fi`);
    expect(mutated).not.toBe(bridge());
    expect(errors(mutated)).toContain('mcp-server/server.ts is unavailable when the workspace builds');
  });

  it('still refuses an actual unknown workspace after removing shell separators', () => {
    const mutated = bridge().replace(/^RUN npm run[^\r\n]+/m,
      'RUN npm run build:core && npm run build --workspace @interego/not-a-workspace;');
    expect(() => inspectBuilds(mutated)).toThrow('Unknown build workspace @interego/not-a-workspace');
  });

  it('rejects a library manifest arriving with its source after npm ci', () => {
    const mutated = bridge().replace(/^COPY packages\/local-node\/package\.json .*\r?\n/m, '');
    expect(mutated).not.toBe(bridge());
    expect(errors(mutated)).toContain('packages/local-node/package.json was not copied before the workspace dependency install');
  });

  it('requires source at build time even when workspace manifests were installed', () => {
    const mutated = bridge().replace(/^COPY packages\/ \.\/packages\/\r?\n/m, '');
    expect(mutated).not.toBe(bridge());
    expect(errors(mutated)).toContain('packages/core/src/index.ts is unavailable when the workspace builds');
  });

  it('requires inherited compiler configuration in the image', () => {
    const mutated = bridge().replace('package-lock.json tsconfig.base.json tsconfig.json', 'package-lock.json tsconfig.json');
    expect(errors(mutated)).toContain('tsconfig.base.json is unavailable when the workspace builds');
  });

  it('cannot reuse dependency installation from an unrelated stage', () => {
    const mutated = bridge().replace('RUN npm ci', 'RUN npm ci\nFROM node:22-slim AS unrelated\nWORKDIR /app\nCOPY package.json package-lock.json tsconfig.base.json tsconfig.json ./');
    expect(errors(mutated)).toContain('packages/local-node/package.json was not copied before the workspace dependency install');
  });
});
