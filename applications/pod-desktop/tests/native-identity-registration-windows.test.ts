/** Real registry semantics on disposable keys in GitHub-hosted Windows CI only. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const windowsCi = process.platform === 'win32' && process.env['GITHUB_ACTIONS'] === 'true' && process.env['CI'] === 'true';
const appRoot = fileURLToPath(new URL('../', import.meta.url));
let directory: string | undefined;
let executable = '';

function captured(file: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(file, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true; child.kill(); reject(new Error('Disposable registration fixture exceeded its bounded runtime.'));
    }, 15_000);
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(0, 16_384); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, 16_384); });
    child.once('error', () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Disposable registration fixture could not start.')); } });
    child.once('close', code => { if (!settled) { settled = true; clearTimeout(timer); done({ code, stdout, stderr }); } });
  });
}

describe.skipIf(!windowsCi)('GitHub-hosted Windows real native registration semantics', () => {
  beforeAll(async () => {
    // An unexpected Windows CI runner must fail rather than silently omit the
    // required real-registry proof. Local Windows still skips this entire suite.
    expect(process.env['RUNNER_ENVIRONMENT']).toBe('github-hosted');
    directory = await mkdtemp(join(tmpdir(), 'interego-native-registration-ci-'));
    executable = join(directory, 'NativeIdentityRegistrationFixture.exe');
    const compiler = join(process.env['WINDIR'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const compiled = await captured(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/warnaserror+',
      '/reference:System.Web.Extensions.dll', '/reference:System.Security.dll', '/main:NativeIdentityRegistrationFixture',
      `/out:${executable}`, join(appRoot, 'native-host/IdentityHost.cs'), join(appRoot, 'tests/fixtures/NativeIdentityRegistrationFixture.cs')]);
    expect(compiled.code, compiled.stdout + compiled.stderr).toBe(0);
  });
  afterAll(async () => {
    if (directory && dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-native-registration-ci-')) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('classifies real missing defaults after DeleteRegValue and preserves foreign/type/access boundaries', async () => {
    // The C# entry point independently checks the same CI environment before
    // creating its unique test key. It never opens either Interego product key.
    const result = await captured(executable, []);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^Disposable native registration fixture: 25 checks passed\.\s*$/);
    process.stdout.write(result.stdout);
  });
});
