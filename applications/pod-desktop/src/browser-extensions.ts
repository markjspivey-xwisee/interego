/** Native owner-managed browser origins. An origin allowance is not a notes grant. */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentProtector } from './agent-types.js';

const failure = 'Browser extension settings could not be opened. Review and save the allowed extension IDs again.';
export function extensionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4 || value.some(id => typeof id !== 'string' || !/^[a-p]{32}$/.test(id))
    || new Set(value).size !== value.length) throw new Error('Enter up to four different Chrome or Edge extension IDs (32 lowercase letters).');
  return [...value].sort();
}

export class BrowserExtensionStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly protector: AgentProtector) {}
  async list(): Promise<string[]> {
    const path = join(this.directory, 'browser-extensions.bin');
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error(failure);
      const file = await open(path, 'r');
      let bytes: Buffer;
      try {
        const actual = await file.stat();
        if (!actual.isFile() || actual.size > 8192 || actual.ino !== stat.ino) throw new Error(failure);
        bytes = await file.readFile();
      } finally { await file.close(); }
      return extensionIds(JSON.parse(this.protector.unprotect(bytes.toString('utf8'))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(failure);
    }
  }
  save(value: unknown): Promise<string[]> {
    const ids = extensionIds(value);
    const next = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, 'browser-extensions.bin');
      const temporary = `${path}.tmp-${randomUUID()}`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(this.protector.protect(JSON.stringify(ids))); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => {}); }
      return ids;
    });
    this.queue = next.catch(() => {});
    return next;
  }
  async origins(): Promise<string[]> { return (await this.list()).map(id => `chrome-extension://${id}`); }
}
