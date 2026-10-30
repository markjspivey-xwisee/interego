import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.type, 'module');
assert.deepEqual(manifest.permissions, ['identity', 'storage', 'activeTab', 'scripting', 'nativeMessaging']);
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.content_scripts, undefined);
assert.equal(manifest.externally_connectable, undefined);
assert.equal(manifest.web_accessible_resources, undefined);
for (const name of await readdir(new URL('src/', root))) {
  if (!/\.m?js$/.test(name)) continue;
  const path = fileURLToPath(new URL(`src/${name}`, root));
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const source = await readFile(path, 'utf8');
  assert.ok(!/\.innerHTML\s*=|\beval\s*\(|new Function\s*\(/.test(source), `Executable external content in ${name}`);
}
const html = await readFile(new URL('app.html', root), 'utf8');
assert.ok(!/\son\w+\s*=|<script(?![^>]*\bsrc=)/i.test(html));
console.log('MV3 manifest, permissions, executable-content boundary, and module syntax pass.');
