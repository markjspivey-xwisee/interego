import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { FederationStore } from './types.js';
import { object, text } from './protocol.js';

const MAX_BYTES = 32 * 1024 * 1024;
const ERROR = 'Saved pod connections could not be opened. Reset sharing setup to continue. Your notes are safe.';
export interface FederationProtector { protect(value: string): string; unprotect(value: string): string }
export interface ProtectedFederationStoreOptions { readonly dataDir: string; readonly protector: FederationProtector }
/** Windows hosts inject DPAPI; other hosts must supply equivalent key custody. */
export class ProtectedFederationStore implements FederationStore {
  private readonly directory: string;
  private readonly path: string;
  constructor(private readonly options: ProtectedFederationStoreOptions) {
    if (!isAbsolute(options.dataDir)) throw new Error('Pod connections need a private local folder.');
    this.directory = resolve(options.dataDir); this.path = join(this.directory, 'federation-state.json');
  }
  async load(): Promise<unknown | null> {
    try {
      const directory = await lstat(this.directory); const metadata = await lstat(this.path);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_BYTES) throw new Error(ERROR);
      const file = await open(this.path, 'r'); let bytes: Buffer;
      try {
        const actual = await file.stat();
        if (!actual.isFile() || actual.dev !== metadata.dev || actual.ino !== metadata.ino || actual.size > MAX_BYTES) throw new Error(ERROR);
        const buffer = Buffer.alloc(MAX_BYTES + 1); let count = 0;
        while (count < buffer.length) { const read = await file.read(buffer, count, buffer.length - count, null); if (!read.bytesRead) break; count += read.bytesRead; }
        if (count > MAX_BYTES) throw new Error(ERROR); bytes = buffer.subarray(0, count);
      } finally { await file.close(); }
      const wrapper = object(JSON.parse(bytes.toString('utf8')), ['version', 'ciphertext']);
      if (wrapper['version'] !== 1) throw new Error(ERROR);
      return JSON.parse(this.options.protector.unprotect(text(wrapper['ciphertext'], MAX_BYTES))) as unknown;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error(ERROR); }
  }
  async save(value: unknown | null): Promise<void> {
    const ciphertext = this.options.protector.protect(JSON.stringify(value)); const bytes = JSON.stringify({ version: 1, ciphertext }) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Pod sharing storage is full. Remove an old received snapshot.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(ERROR);
    const temporary = join(this.directory, '.federation-' + randomUUID() + '.tmp');
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes, 'utf8'); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
