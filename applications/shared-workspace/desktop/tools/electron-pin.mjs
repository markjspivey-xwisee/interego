/**
 * Refuse to package unless electron-builder.yml's `electronVersion` is the Electron installed at
 * the repo root.
 *
 * electron-builder packages whatever `electronVersion` names and never compares it with the
 * installed `electron` (app-builder-lib's `getElectronVersion` returns the config value as soon as
 * it is set). So a lockfile moved to a patched Electron with the pin left behind would ship the old
 * runtime from a green packaging job. Each `package*` script in package.json runs this first.
 *
 * Usage: node tools/electron-pin.mjs   (from applications/shared-workspace/desktop)
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = join(here, '..', 'electron-builder.yml');
const pinned = /^electronVersion:\s*(\S+)\s*$/m.exec(readFileSync(configPath, 'utf8'))?.[1];

let installed;
try {
  // Resolved the way Node resolves it from this package, so the hoisted root copy is found.
  installed = createRequire(configPath)('electron/package.json').version;
} catch (err) {
  process.stderr.write(`electron-pin: cannot read the installed electron's package.json: ${String(err)}\n`);
  process.exit(1);
}

if (!pinned) {
  process.stderr.write(`electron-pin: ${configPath} has no top-level electronVersion line\n`);
  process.exit(1);
}
if (pinned !== installed) {
  process.stderr.write(
    `electron-pin: electron-builder.yml pins electronVersion ${pinned}, but electron ${installed} is installed. `
    + `Set electronVersion to ${installed} (or install ${pinned}) so the packaged runtime is the one in the lockfile.\n`,
  );
  process.exit(1);
}
process.stdout.write(`electron-pin: electronVersion ${pinned} matches the installed electron\n`);
