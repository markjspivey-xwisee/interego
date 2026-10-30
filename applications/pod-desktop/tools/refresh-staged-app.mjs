import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { appRoot, assertStagePath, stageRoot } from './paths.mjs';
import { bridgeBuildInfo, stageBridge } from './stage-bridge.mjs';

// An app-only edit need not copy the complete dependency graph again. Any runtime
// workspace source, dependency or version change requires the full `stage` command,
// even when that workspace's package version and dependency names did not change.
assertStagePath(stageRoot);
for (const path of [dirname(stageRoot), stageRoot, join(stageRoot, 'dist'), join(stageRoot, 'assets')]) {
  if ((await lstat(path)).isSymbolicLink()) throw new Error('Staging folders must be physical directories.');
}
const source = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
const staged = JSON.parse(await readFile(join(stageRoot, 'package.json'), 'utf8'));
const dependencyList = value => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
if (source.version !== staged.version || dependencyList(source.dependencies) !== dependencyList(staged.dependencies)) {
  throw new Error('The staged dependency graph differs. Run the full stage command.');
}
const graph = JSON.parse(await readFile(join(stageRoot, 'production-graph.json'), 'utf8'));
if (!Array.isArray(graph.packages) || graph.packages.length === 0) throw new Error('The production dependency graph has not been staged.');
for (const name of ['main.mjs', 'preload.cjs', 'renderer.js']) {
  await copyFile(join(appRoot, 'dist', name), join(stageRoot, 'dist', name));
}
await mkdir(join(stageRoot, 'dist/native-host'), { recursive: true });
await copyFile(join(appRoot, 'dist/native-host/Interego-Identity.exe'), join(stageRoot, 'dist/native-host/Interego-Identity.exe'));
await copyFile(join(appRoot, 'index.html'), join(stageRoot, 'index.html'));
await copyFile(join(appRoot, 'assets/icon.png'), join(stageRoot, 'assets/icon.png'));
const appRequire = createRequire(import.meta.url);
await writeFile(join(stageRoot, 'build-info.json'), `${JSON.stringify({
  product: 'Interego', version: source.version, electron: appRequire('electron/package.json').version,
  signing: process.env.WIN_CSC_LINK || process.env.CSC_LINK ? 'certificate-requested; inspect the built installer signature' : 'unsigned-preview',
  installation: 'per-user', bundledRuntime: true, federation: 'disabled',
  optionalPodFederation: { default: 'off', delivery: 'selected-encrypted-snapshots', offlineQueue: false },
  optionalLocalIdentity: { custody: 'windows-protected-native', approval: 'every-request', publicBridgeRequired: false, browserAccess: 'explicit-extension-ids' },
  optionalWebBridge: bridgeBuildInfo,
}, null, 2)}\n`);
process.stdout.write('Refreshed compiled application files; the staged production dependency graph is unchanged.\n');
await stageBridge(stageRoot);
