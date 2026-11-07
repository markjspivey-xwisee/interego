import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgentProtector } from './agent-types.js';
import type { LocalIdentityStore } from './local-identity-types.js';
import { IDENTITY_STORE_ERROR, identityObject, identityText } from './local-identity-protocol.js';

const MAX_BYTES = 16 * 1024;
export class ProtectedLocalIdentityStore implements LocalIdentityStore {
  private readonly directory: string;
  private readonly path: string;
  constructor(private readonly options: { readonly dataDir: string; readonly protector: AgentProtector }) {
    if (!isAbsolute(options.dataDir)) throw new Error('Local identity needs a private folder on this computer.');
    this.directory = resolve(options.dataDir); this.path = join(this.directory, 'identity-key.json');
  }
  async load(): Promise<unknown | null> {
    try {
      const directory = await lstat(this.directory); const stat = await lstat(this.path);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error(IDENTITY_STORE_ERROR);
      const file = await open(this.path, 'r'); let text: string;
      try {
        const actual = await file.stat();
        if (!actual.isFile() || actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size > MAX_BYTES) throw new Error(IDENTITY_STORE_ERROR);
        const bytes = Buffer.alloc(MAX_BYTES + 1); let size = 0;
        while (size < bytes.length) { const value = await file.read(bytes, size, bytes.length - size, null); if (!value.bytesRead) break; size += value.bytesRead; }
        if (size > MAX_BYTES) throw new Error(IDENTITY_STORE_ERROR); text = bytes.subarray(0, size).toString('utf8');
      } finally { await file.close(); }
      const wrapper = identityObject(JSON.parse(text), ['version', 'ciphertext']);
      if (wrapper['version'] !== 1) throw new Error(IDENTITY_STORE_ERROR);
      return JSON.parse(this.options.protector.unprotect(identityText(wrapper['ciphertext'], MAX_BYTES))) as unknown;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error(IDENTITY_STORE_ERROR); }
  }
  async save(value: unknown | null): Promise<void> {
    const bytes = JSON.stringify({ version: 1, ciphertext: this.options.protector.protect(JSON.stringify(value)) }) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Local identity settings are too large. Nothing was saved.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(IDENTITY_STORE_ERROR);
    const temporary = join(this.directory, '.identity-' + randomUUID() + '.tmp');
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes, 'utf8'); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
