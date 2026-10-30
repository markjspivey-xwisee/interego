/** Owner-only installation of the origin-restricted Windows browser companion. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { extensionIds } from './browser-extensions.js';

export const IDENTITY_HOST_NAME = 'com.interego.identity';
const REGISTRY = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${IDENTITY_HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${IDENTITY_HOST_NAME}`,
] as const;
type Command = (file: string, args: readonly string[], input?: string) => Promise<{ code: number; stdout: string }>;
const run: Command = (file, args, input) => new Promise((done, fail) => {
  const child = spawn(file, [...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let size = 0; let settled = false;
  const timer = setTimeout(() => { child.kill(); finish(new Error('The browser companion did not respond. Reopen Interego and try again.')); }, 15_000);
  function finish(error?: Error, code = 1): void {
    if (settled) return; settled = true; clearTimeout(timer);
    if (error) fail(error); else done({ code, stdout });
  }
  child.once('error', () => finish(new Error('The browser companion could not open. Reinstall Interego and try again.')));
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > 64 * 1024) { child.kill(); finish(new Error('The browser companion returned an invalid response.')); }
    else stdout += chunk.toString('utf8');
  });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.once('close', code => finish(undefined, code ?? 1));
  child.stdin.end(input);
});

export class NativeIdentityHost {
  readonly manifestPath: string;
  private readonly command: Command;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: { dataDir: string; executable: string; command?: Command }) {
    if (!isAbsolute(options.dataDir) || !isAbsolute(options.executable)) throw new Error('The browser companion needs an installed file location.');
    this.manifestPath = join(options.dataDir, `${IDENTITY_HOST_NAME}.json`);
    this.command = options.command ?? run;
  }
  async protectTicket(plaintext: string): Promise<string> {
    if (Buffer.byteLength(plaintext) > 4096) throw new Error('The browser connection could not be created.');
    const reply = await this.command(this.options.executable, ['--protect-ticket'], plaintext);
    const value = reply.stdout.trim();
    if (reply.code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length < 64 || value.length > 16_384
      || Buffer.from(value, 'base64').toString('base64') !== value) {
      throw new Error('Windows could not protect this browser connection. Reopen Interego and try again.');
    }
    return value;
  }
  private async current(key: string): Promise<string | null> {
    const value = await this.command('reg.exe', ['query', key, '/ve']);
    if (value.code === 1) return null;
    const match = /REG_SZ\s+([^\r\n]+)\s*(?:\r?\n|$)/.exec(value.stdout);
    if (value.code !== 0 || !match) throw new Error('Windows browser connection settings could not be checked.');
    return match[1]!.trim();
  }
  configure(value: unknown): Promise<readonly string[]> {
    const ids = extensionIds(value);
    const task = this.queue.then(async () => {
      if (process.platform !== 'win32' && !this.options.command) throw new Error('Local browser sign-in is available in the Windows preview.');
      await access(this.options.executable);
      const existing = await Promise.all(REGISTRY.map(key => this.current(key)));
      if (existing.some(path => path !== null && path.toLowerCase() !== this.manifestPath.toLowerCase())) {
        throw new Error('Another Interego installation owns this browser connection. Open that installation to disconnect it first.');
      }
      if (!ids.length) {
        for (let i = 0; i < REGISTRY.length; ++i) if (existing[i] !== null) {
          const reply = await this.command('reg.exe', ['delete', REGISTRY[i]!, '/ve', '/f']);
          if (reply.code !== 0) throw new Error('Windows could not disconnect the browser companion. Try again.');
        }
        await unlink(this.manifestPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        return ids;
      }
      await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.manifestPath}.tmp-${randomUUID()}`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify({ name: IDENTITY_HOST_NAME, description: 'Interego local identity consent',
            path: this.options.executable, type: 'stdio', allowed_origins: ids.map(id => `chrome-extension://${id}/`) }) + '\n');
          await file.sync();
        } finally { await file.close(); }
        await rename(temporary, this.manifestPath);
      } finally { await unlink(temporary).catch(() => {}); }
      for (const key of REGISTRY) {
        const reply = await this.command('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', this.manifestPath, '/f']);
        if (reply.code !== 0) throw new Error('Windows could not finish browser setup. Save the allowed extension IDs again.');
      }
      return ids;
    });
    this.queue = task.catch(() => {}); return task;
  }
}
