import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { appRoot, assertStagePath, repoRoot, stageRoot, within } from './paths.mjs';
import { bridgeBuildInfo, stageBridge } from './stage-bridge.mjs';

const sourceManifest = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
const workspaceNames = new Set(['@interego/local-node', '@interego/deployment-config', '@interego/core', '@interego/solid', '@interego/pod-federation', '@interego/workspace-client', '@interego/privacy']);
const productionRoots = new Set([...workspaceNames, '@modelcontextprotocol/server', 'ws']);
const installedRoot = resolve(repoRoot, 'node_modules');
const workspaceRoot = resolve(repoRoot, 'packages');
const graph = [];
const visited = new Set();
let activeCopies = 0;
const copyWaiters = [];

async function copyAsset(source, target) {
  if (activeCopies < 32) activeCopies++;
  else await new Promise(done => copyWaiters.push(done));
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  } finally {
    const next = copyWaiters.shift();
    if (next) next();
    else activeCopies--;
  }
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function resolvePackage(name, from) {
  const require = createRequire(join(from, 'package.json'));
  // Adding a subpath also obtains npm search paths for packages named like Node builtins (buffer).
  for (const search of require.resolve.paths(`${name}/package.json`) ?? []) {
    const candidate = join(search, name, 'package.json');
    if (await exists(candidate)) {
      const root = await realpath(dirname(candidate));
      return { root, manifest: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) };
    }
  }
  throw new Error(`Installed production dependency ${name} is missing from the build tree.`);
}

function destination(root, manifest) {
  if (within(installedRoot, root)) return join(stageRoot, 'node_modules', relative(installedRoot, root));
  if (workspaceNames.has(manifest.name) && dirname(root) === workspaceRoot) return join(stageRoot, 'node_modules', manifest.name);
  for (const name of workspaceNames) {
    const nested = join(workspaceRoot, name.slice('@interego/'.length), 'node_modules');
    if (within(nested, root)) return join(stageRoot, 'node_modules', name, 'node_modules', relative(nested, root));
  }
  throw new Error(`Refusing to package a dependency outside installed modules or the explicit workspace roots: ${manifest.name}`);
}

async function copyTree(source, target, packageRoot) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    const actual = await realpath(source);
    if (!within(packageRoot, actual)) throw new Error('A package asset symlink leaves its production package.');
    return copyTree(actual, target, packageRoot);
  }
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    await Promise.all((await readdir(source))
      .filter(entry => entry !== 'node_modules' && entry !== '.git' && entry !== '.npmrc' && !entry.startsWith('.env') && entry !== 'npm-debug.log')
      .map(entry => copyTree(join(source, entry), join(target, entry), packageRoot)));
  } else if (info.isFile()) {
    if (source.endsWith('.node')) throw new Error('A native Node addon requires an explicit Electron ABI build before it can be shipped.');
    await copyAsset(source, target);
  }
}

async function addPackage(name, from, optional = false) {
  let found;
  try { found = await resolvePackage(name, from); }
  catch (error) { if (optional && error.message.startsWith('Installed production dependency')) return; throw error; }
  const { root, manifest } = found;
  if (visited.has(root)) return;
  visited.add(root);
  const target = destination(root, manifest);
  const workspace = workspaceNames.has(manifest.name) && dirname(root) === workspaceRoot;
  if (workspace) {
    await mkdir(target, { recursive: true });
    // Only compiled code and the runtime's explicit CSS configuration enter the installer.
    for (const entry of ['package.json', 'dist', ...(manifest.name === '@interego/local-node' ? ['config'] : []), 'README.md', 'LICENSE']) {
      if (await exists(join(root, entry))) await copyTree(join(root, entry), join(target, entry), root);
      else if (entry === 'dist' || entry === 'package.json' || entry === 'config') throw new Error(`Build ${manifest.name} before staging it.`);
    }
  } else await copyTree(root, target, root);
  graph.push({ name: manifest.name, version: manifest.version, source: relative(repoRoot, root).replaceAll('\\', '/'), target: relative(stageRoot, target).replaceAll('\\', '/') });
  if (graph.length % 200 === 0) process.stdout.write(`Staging production dependencies: ${graph.length} packages.\n`);
  const required = { ...manifest.dependencies, ...manifest.peerDependencies };
  const optionalNames = new Set(Object.keys(manifest.optionalDependencies ?? {}));
  for (const [peer, metadata] of Object.entries(manifest.peerDependenciesMeta ?? {})) if (metadata.optional) optionalNames.add(peer);
  for (const dependency of Object.keys({ ...required, ...manifest.optionalDependencies })) {
    await addPackage(dependency, root, optionalNames.has(dependency));
  }
}

assertStagePath(stageRoot);
const stagingParent = dirname(stageRoot);
if (await exists(stagingParent) && (await lstat(stagingParent)).isSymbolicLink()) throw new Error('The staging directory must not be a symlink.');
if (await exists(stageRoot) && (await lstat(stageRoot)).isSymbolicLink()) throw new Error('The staged app must not be a symlink.');
await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });
for (const name of Object.keys(sourceManifest.dependencies)) {
  if (!productionRoots.has(name)) throw new Error(`Unexpected desktop production root ${name}; review its packaging scope first.`);
  await addPackage(name, appRoot);
}
await copyTree(join(appRoot, 'dist'), join(stageRoot, 'dist'), join(appRoot, 'dist'));
await copyFile(join(appRoot, 'index.html'), join(stageRoot, 'index.html'));
await mkdir(join(stageRoot, 'assets'), { recursive: true });
await copyFile(join(appRoot, 'assets/icon.png'), join(stageRoot, 'assets/icon.png'));
const signingRequested = Boolean(process.env.WIN_CSC_LINK || process.env.CSC_LINK);
const productionManifest = {
  name: 'interego-pod', version: sourceManifest.version, productName: 'Interego', private: true,
  description: sourceManifest.description, author: sourceManifest.author, license: 'MIT', type: 'module', main: 'dist/main.mjs',
  dependencies: sourceManifest.dependencies,
};
await writeFile(join(stageRoot, 'package.json'), `${JSON.stringify(productionManifest, null, 2)}\n`);
await writeFile(join(stageRoot, 'production-graph.json'), `${JSON.stringify({ roots: Object.keys(sourceManifest.dependencies), packages: graph.sort((a, b) => a.target.localeCompare(b.target)) }, null, 2)}\n`);
const require = createRequire(import.meta.url);
await writeFile(join(stageRoot, 'build-info.json'), `${JSON.stringify({
  product: 'Interego', version: sourceManifest.version, electron: require('electron/package.json').version,
  signing: signingRequested ? 'certificate-requested; inspect the built installer signature' : 'unsigned-preview',
  installation: 'per-user', bundledRuntime: true, federation: 'disabled',
  optionalPodFederation: { default: 'off', delivery: 'selected-encrypted-snapshots', offlineQueue: false },
  optionalLocalIdentity: { custody: 'windows-protected-native', approval: 'every-request', publicBridgeRequired: false, browserAccess: 'explicit-extension-ids' },
  optionalWebBridge: bridgeBuildInfo,
}, null, 2)}\n`);
process.stdout.write(`Staged ${graph.length} production packages at ${relative(repoRoot, stageRoot)}.\n`);
await stageBridge(stageRoot);
