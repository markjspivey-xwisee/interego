// Build-time download only. The installed app never downloads executable code.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appRoot, assertStagePath } from './paths.mjs';

const manifest = JSON.parse(await readFile(join(appRoot, 'bridge-manifest.json'), 'utf8'));
const releaseHosts = new Set(['github.com', 'release-assets.githubusercontent.com']);
export const bridgeBuildInfo = Object.freeze({
  default: 'off-every-launch', provider: 'User-owned Cloudflare Tunnel or HTTPS gateway; temporary link optional', componentVersion: manifest.version,
  sha256: manifest.sha256, rememberedPairings: true,
});

async function hashFile(path, maximum) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('The cached bridge component must be a regular file.');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function fetchPinned(url, path, expected, maximum) {
  try { if (await hashFile(path, maximum) === expected) return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    let current = new URL(url); let response;
    for (let redirects = 0; redirects < 5; redirects++) {
      if (current.protocol !== 'https:' || current.username || current.password
        || (!releaseHosts.has(current.hostname) && current.href !== manifest.licenseUrl)) throw new Error('The pinned bridge download redirected outside its official release hosts.');
      response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(120_000), headers: { 'user-agent': 'Interego-desktop-build' } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('The bridge download returned an incomplete redirect.');
        current = new URL(location, current); continue;
      }
      break;
    }
    if (!response?.ok || !response.body) throw new Error('The pinned bridge component could not be downloaded. Retry the build when online.');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum) { await response.body.cancel(); throw new Error('The bridge download exceeds the size limit.'); }
    const file = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256'); let total = 0;
    try {
      for await (const bytes of response.body) {
        total += bytes.length;
        if (total > maximum) throw new Error('The bridge download exceeds the size limit.');
        hash.update(bytes); await file.writeFile(bytes);
      }
      await file.sync();
    } finally { await file.close(); }
    if (hash.digest('hex') !== expected) throw new Error('The bridge release did not match its pinned checksum.');
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function stageBridge(root) {
  assertStagePath(root);
  const cache = join(appRoot, '.staging', 'bridge-cache');
  const target = join(root, 'bridge');
  for (const path of [join(appRoot, '.staging'), cache, target]) {
    await mkdir(path, { recursive: true });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Bridge staging folders must be physical directories.');
  }
  const binary = join(cache, `cloudflared-${manifest.version}-windows-amd64.exe`);
  const license = join(cache, `cloudflared-${manifest.version}-LICENSE.txt`);
  await fetchPinned(manifest.url, binary, manifest.sha256, 128 * 1024 * 1024);
  await fetchPinned(manifest.licenseUrl, license, manifest.licenseSha256, 64 * 1024);
  await copyFile(binary, join(target, manifest.filename));
  await copyFile(license, join(target, 'LICENSE.txt'));
  await writeFile(join(target, 'component.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(target, 'NOTICE.txt'), `cloudflared ${manifest.version}\nCopyright Cloudflare, Inc. and contributors.\nUnmodified official Windows x64 binary, Apache License 2.0 (LICENSE.txt).\nSource and dependency notices: ${manifest.sourceUrl}\nRelease: ${manifest.url}\nSHA256: ${manifest.sha256}\n\nUsed only when the owner explicitly enables Interego's web bridge.\nCloudflare services are subject to https://www.cloudflare.com/website-terms/\n`);
  process.stdout.write(`Staged verified cloudflared ${manifest.version}; the bridge stays off until enabled.\n`);
}
