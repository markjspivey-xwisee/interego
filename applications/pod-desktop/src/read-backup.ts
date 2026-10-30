import { open } from 'node:fs/promises';

export const MAX_NOTES_BACKUP_BYTES = 32 * 1024 * 1024;
class BackupReadError extends Error {}

/** Read one regular file handle with a hard byte limit, even when the file grows. */
export async function readBackupFile(path: string, maximumBytes = MAX_NOTES_BACKUP_BYTES): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > MAX_NOTES_BACKUP_BYTES) {
    throw new BackupReadError('The backup size limit is invalid.');
  }
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, 'r');
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new BackupReadError('Choose a regular notes backup file.');
    if (metadata.size > maximumBytes) throw new BackupReadError('This backup is too large for this version of Interego.');
    const chunks: Buffer[] = [];
    const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));
    let total = 0;
    while (true) {
      // Read one extra byte to distinguish an exact-size file from an oversized file.
      const capacity = Math.min(scratch.length, maximumBytes + 1 - total);
      const { bytesRead } = await file.read(scratch, 0, capacity, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) throw new BackupReadError('This backup is too large for this version of Interego.');
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof BackupReadError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') throw new BackupReadError('Choose a regular notes backup file.');
    throw new BackupReadError('The notes backup could not be read. Choose the file again and try again.');
  } finally { await file?.close(); }
}
