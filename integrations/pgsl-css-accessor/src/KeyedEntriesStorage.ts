import { getLoggerFor, type KeyValueStorage } from '@solid/community-server';

/**
 * A KeyValueStorage that passes everything through but leaves out of `entries()` any
 * entry without a string key.
 *
 * CSS's internal value storage is a MaxKeyLengthStorage over a JsonResourceStorage rooted
 * at /.internal/. Its `entries()` walks EVERY document under /.internal/ and yields each
 * one's `key` field, but documents another storage wrote into that same tree without the
 * `{ key, payload }` wrapper have no such field. Reader counts that GreedyReadWriteLocker
 * left in /.internal/locks/ while LockStorage was still backed by the pod (a count is a bare
 * number) are such documents. The key comes out `undefined`, every ContainerPathStorage above
 * calls `key.startsWith(...)` on it and throws, and that throw aborts WrappedExpiringStorage's
 * hourly sweep before it deletes a single expired cookie, IdP adapter entry or token.
 * An entry without a key cannot belong to anything that reads through this storage.
 */
export class KeyedEntriesStorage<T> implements KeyValueStorage<string, T> {
  protected readonly logger = getLoggerFor(this);

  constructor(private readonly source: KeyValueStorage<string, T>) {}

  async get(key: string): Promise<T | undefined> {
    return this.source.get(key);
  }
  async has(key: string): Promise<boolean> {
    return this.source.has(key);
  }
  async set(key: string, value: T): Promise<this> {
    await this.source.set(key, value);
    return this;
  }
  async delete(key: string): Promise<boolean> {
    return this.source.delete(key);
  }

  async *entries(): AsyncIterableIterator<[string, T]> {
    let skipped = 0;
    for await (const entry of this.source.entries()) {
      if (typeof entry[0] === 'string') yield entry;
      else skipped++;
    }
    if (skipped > 0) this.logger.debug(`Skipped ${skipped} internal document(s) without a key`);
  }
}
