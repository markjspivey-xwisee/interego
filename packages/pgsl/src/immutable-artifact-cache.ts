/**
 * A process-bounded cache for previously verified immutable ciphertext only.
 * Callers own private namespaces and still authenticate/decrypt every cache hit.
 * Mutable heads and publication readbacks must never use this cache.
 */
export class ImmutableArtifactCache {
  private readonly entries = new Map<object, { namespace: object; key: string; bytes: Uint8Array }>();
  private readonly namespaces = new WeakMap<object, Map<string, object>>();
  private bytesUsed = 0;
  constructor(private readonly maxBytes: number, private readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 0) {
      throw new Error('Invalid immutable artifact cache capacity.');
    }
  }
  get size(): number { return this.entries.size; }
  get byteLength(): number { return this.bytesUsed; }
  get(namespace: object, key: string): Uint8Array | undefined {
    const id = this.namespaces.get(namespace)?.get(key);
    if (!id) return undefined;
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id); this.entries.set(id, entry);
    return Uint8Array.from(entry.bytes);
  }
  set(namespace: object, key: string, bytes: Uint8Array): void {
    const old = this.namespaces.get(namespace)?.get(key);
    if (old) this.remove(old);
    if (bytes.byteLength > this.maxBytes || this.maxEntries === 0) return;
    while (this.entries.size >= this.maxEntries || this.bytesUsed + bytes.byteLength > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) return;
      this.remove(oldest);
    }
    let keys = this.namespaces.get(namespace);
    if (!keys) { keys = new Map(); this.namespaces.set(namespace, keys); }
    const id = {};
    keys.set(key, id);
    this.entries.set(id, { namespace, key, bytes: Uint8Array.from(bytes) });
    this.bytesUsed += bytes.byteLength;
  }
  private remove(id: object): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.namespaces.get(entry.namespace)?.delete(entry.key);
    this.bytesUsed -= entry.bytes.byteLength;
  }
}

/** One budget across every native client in this process, including inactive owners. */
export const immutableArtifactCache = new ImmutableArtifactCache(32 * 1024 * 1024, 128);
