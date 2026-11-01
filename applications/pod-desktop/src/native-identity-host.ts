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
export type NativeIdentityRegistrationFailure = 'foreign-registration' | 'invalid-registration-type' | 'registration-unavailable';
const REGISTRATION_ERRORS = Object.freeze({
  'foreign-registration': 'Another Interego installation owns this browser connection. It has not been replaced. Review that installation before reconnecting here.',
  'invalid-registration-type': 'Windows browser connection settings have an unexpected format. Interego has not replaced those settings. Browser access remains paused.',
  'registration-unavailable': 'Windows browser sign-in settings could not be checked or updated. Browser access is paused. Reopen Interego to try again.',
});
const RESTORE_FAILURE = 'Saved browser sign-in could not be restored. Your identity and saved extension permissions have not changed. Browser sign-in is paused. Reopen Interego to try again.';
export class NativeIdentityRegistrationError extends Error {
  constructor(readonly code: NativeIdentityRegistrationFailure) {
    super(REGISTRATION_ERRORS[code]);
    this.name = 'NativeIdentityRegistrationError';
  }
}
/** Owner-facing restoration copy never includes arbitrary exception or registry text. */
export function identityBrowserRestoreError(error: unknown): string {
  if (error instanceof NativeIdentityRegistrationError && Object.hasOwn(REGISTRATION_ERRORS, error.code)) {
    return REGISTRATION_ERRORS[error.code] + ' Your identity and saved extension permissions have not changed.';
  }
  return RESTORE_FAILURE;
}
const REGISTRATION_STATES = ['absent', 'matching', 'foreign', 'wrong-type', 'unavailable'] as const;
type RegistrationState = typeof REGISTRATION_STATES[number];
const registrationState = (value: unknown): value is RegistrationState => REGISTRATION_STATES.some(state => state === value);
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
  private async current(): Promise<readonly RegistrationState[]> {
    try {
      const reply = await this.command(this.options.executable, ['--registration-status'], JSON.stringify({ manifestPath: this.manifestPath }));
      // Bound original output, not trimmed output; whitespace is part of the transport budget.
      if (reply.code !== 0 || Buffer.byteLength(reply.stdout, 'utf8') > 4096) throw new Error('Invalid registration status.');
      const value: unknown = JSON.parse(reply.stdout);
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'chrome,edge,version') throw new Error('Invalid registration status.');
      const fields = value as Record<string, unknown>;
      if (fields['version'] !== 1 || !registrationState(fields['chrome']) || !registrationState(fields['edge'])) {
        throw new Error('Invalid registration status.');
      }
      return [fields['chrome'], fields['edge']];
    } catch {
      throw new NativeIdentityRegistrationError('registration-unavailable');
    }
  }
  configure(value: unknown): Promise<readonly string[]> {
    const ids = extensionIds(value);
    const task = this.queue.then(async () => {
      if (process.platform !== 'win32' && !this.options.command) throw new Error('Local browser sign-in is available in the Windows preview.');
      await access(this.options.executable);
      const existing = await this.current();
      if (existing.includes('foreign')) throw new NativeIdentityRegistrationError('foreign-registration');
      if (existing.includes('wrong-type')) throw new NativeIdentityRegistrationError('invalid-registration-type');
      if (existing.includes('unavailable')) throw new NativeIdentityRegistrationError('registration-unavailable');
      if (!ids.length) {
        for (let i = 0; i < REGISTRY.length; ++i) if (existing[i] === 'matching') {
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
