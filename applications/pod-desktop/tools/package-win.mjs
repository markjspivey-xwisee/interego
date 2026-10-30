import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { appRoot, releaseRoot, stageRoot } from './paths.mjs';
import signaturePolicy from './signature-policy.cjs';

if (process.platform !== 'win32') throw new Error('The Windows installer and its signature are verified on Windows.');
const require = createRequire(import.meta.url);
const source = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
const bridgeComponent = JSON.parse(await readFile(join(appRoot, 'bridge-manifest.json'), 'utf8'));
const staged = JSON.parse(await readFile(join(stageRoot, 'package.json'), 'utf8'));
if (staged.version !== source.version || staged.main !== 'dist/main.mjs') throw new Error('Build and stage this desktop version before packaging.');
const cli = require.resolve('electron-builder/cli.js');
await new Promise((done, fail) => {
  const child = spawn(process.execPath, [cli, '--win', 'nsis', '--x64', '--publish', 'never', '--config', join(appRoot, 'electron-builder.config.cjs')], {
    cwd: appRoot, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ?? '5' },
  });
  child.once('error', fail);
  child.once('exit', code => code === 0 ? done() : fail(new Error(`Windows packaging exited ${code}.`)));
});
const artifact = `Interego-${source.version}-windows-x64-setup.exe`;
const installer = join(releaseRoot, artifact);
const helperHash = createHash('sha256');
for await (const chunk of createReadStream(join(releaseRoot, 'win-unpacked', 'resources', 'app', 'bridge', bridgeComponent.filename))) helperHash.update(chunk);
if (helperHash.digest('hex') !== bridgeComponent.sha256) throw new Error('Packaging changed the pinned bridge helper. Its original bytes and publisher signature must be preserved.');
if ((await stat(installer)).size < 1024 * 1024) throw new Error('The expected Windows setup artifact is missing or unexpectedly small.');
const sha256 = createHash('sha256');
for await (const chunk of createReadStream(installer)) sha256.update(chunk);
await writeFile(join(releaseRoot, 'SHA256SUMS.txt'), `${sha256.digest('hex')}  ${artifact}\n`);
await new Promise((done, fail) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(appRoot, 'tools/inspect-signature.ps1'), '-Target', installer], { windowsHide: true });
  let output = '';
  let errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  child.once('error', fail);
  child.once('close', async code => {
    try {
      if (code !== 0) throw new Error(`Installer signature inspection failed: ${errors}`);
      const signature = JSON.parse(output);
      const signingRequested = Boolean(process.env.WIN_CSC_LINK || process.env.CSC_LINK);
      const distribution = signaturePolicy(signature.status, signingRequested);
      const info = {
        artifact, version: source.version, electron: require('electron/package.json').version,
        signature, distribution,
        installation: 'per-user; no elevation', preservesUserDataOnUninstall: true,
        bundledRuntime: true, published: false,
        optionalWebBridge: {
          default: 'off-every-launch', provider: 'Cloudflare Quick Tunnel', temporaryUrl: true,
          componentVersion: bridgeComponent.version, sha256: bridgeComponent.sha256,
        },
      };
      await writeFile(join(releaseRoot, 'BUILD-INFO.json'), `${JSON.stringify(info, null, 2)}\n`);
      process.stdout.write(`${artifact}: ${info.distribution}. No release was published.\n`);
      done();
    } catch (error) { fail(error); }
  });
});
