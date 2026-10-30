import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appRoot } from './paths.mjs';

/** No downloadable compiler/runtime: Windows 10/11's .NET Framework console host. */
export async function buildNativeHost(options = {}) {
  if (options.outputDir !== undefined && (typeof options.outputDir !== 'string' || !isAbsolute(options.outputDir))) {
    throw new Error('The native identity host output directory must be absolute.');
  }
  if (process.platform !== 'win32') return undefined;
  const compiler = join(process.env['WINDIR'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await access(compiler);
  const outputDir = options.outputDir ?? resolve(appRoot, 'dist/native-host');
  const executable = join(outputDir, 'Interego-Identity.exe');
  await mkdir(outputDir, { recursive: true });
  await new Promise((done, reject) => {
    const child = spawn(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/warnaserror+',
      '/reference:System.Web.Extensions.dll', '/reference:System.Security.dll', `/out:${executable}`,
      resolve(appRoot, 'native-host/IdentityHost.cs')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    const collect = (chunk) => { diagnostics = `${diagnostics}${String(chunk)}`.slice(0, 16_384); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? done() : reject(new Error(`Native identity host compilation failed (${code}).\n${diagnostics}`)));
  });
  return executable;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output-dir')) throw new Error('Unsupported native identity build arguments.');
  const executable = await buildNativeHost(args.length ? { outputDir: args[1] } : {});
  process.stdout.write(executable ? `Built ${executable}\n` : 'Native identity host compilation is Windows-only.\n');
}
