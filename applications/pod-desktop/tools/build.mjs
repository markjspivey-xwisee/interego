import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { appRoot } from './paths.mjs';

const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');
await new Promise((done, fail) => {
  const child = spawn(process.execPath, [tsc, '--noEmit', '-p', join(appRoot, 'tsconfig.json')], { stdio: 'inherit', windowsHide: true });
  child.once('error', fail);
  child.once('exit', code => code === 0 ? done() : fail(new Error(`Desktop typecheck exited ${code}.`)));
});
await mkdir(join(appRoot, 'dist'), { recursive: true });
await Promise.all([
  build({ entryPoints: [join(appRoot, 'src/main.ts')], outfile: join(appRoot, 'dist/main.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' }),
  build({ entryPoints: [join(appRoot, 'src/preload.ts')], outfile: join(appRoot, 'dist/preload.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external' }),
  build({ entryPoints: [join(appRoot, 'src/renderer.ts')], outfile: join(appRoot, 'dist/renderer.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome130' }),
]);
