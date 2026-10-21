import { describe, expect, it } from 'vitest';
import { ImmutableArtifactCache } from '../packages/pgsl/src/immutable-artifact-cache.js';

describe('bounded immutable ciphertext cache', () => {
  it('evicts least-recently-read bytes across private client namespaces', () => {
    const cache = new ImmutableArtifactCache(6, 10), a = {}, b = {};
    cache.set(a, 'one', new Uint8Array([1, 1]));
    cache.set(b, 'two', new Uint8Array([2, 2]));
    cache.set(a, 'three', new Uint8Array([3, 3]));
    expect(cache.get(a, 'one')).toEqual(new Uint8Array([1, 1]));
    cache.set(b, 'four', new Uint8Array([4, 4]));
    expect(cache.get(b, 'two')).toBeUndefined();
    expect(cache.get(a, 'three')).toEqual(new Uint8Array([3, 3]));
    expect(cache.size).toBe(3); expect(cache.byteLength).toBe(6);
  });

  it('bounds entries independently from payload bytes and refuses oversized artifacts', () => {
    const cache = new ImmutableArtifactCache(20, 2), owner = {};
    cache.set(owner, 'one', new Uint8Array([1]));
    cache.set(owner, 'two', new Uint8Array([2]));
    cache.set(owner, 'three', new Uint8Array([3]));
    expect(cache.get(owner, 'one')).toBeUndefined();
    expect(cache.size).toBe(2); expect(cache.byteLength).toBe(2);
    cache.set(owner, 'large', new Uint8Array(21));
    expect(cache.get(owner, 'large')).toBeUndefined();
    expect(cache.size).toBe(2); expect(cache.byteLength).toBe(2);
  });

  it('copies at both boundaries and isolates equal keys by private namespace', () => {
    const cache = new ImmutableArtifactCache(20, 10), a = {}, b = {}, input = Buffer.from([1, 2]);
    cache.set(a, 'same', input); input[0] = 9;
    expect(cache.get(b, 'same')).toBeUndefined();
    const returned = cache.get(a, 'same')!; returned[0] = 8;
    expect(cache.get(a, 'same')).toEqual(new Uint8Array([1, 2]));
    cache.set(b, 'same', new Uint8Array([3]));
    cache.set(a, 'same', new Uint8Array([4]));
    expect(cache.get(a, 'same')).toEqual(new Uint8Array([4]));
    expect(cache.get(b, 'same')).toEqual(new Uint8Array([3]));
    expect(cache.size).toBe(2); expect(cache.byteLength).toBe(2);
  });

  it('supports a disabled budget without retaining entries', () => {
    const owner = {}, cache = new ImmutableArtifactCache(0, 0);
    cache.set(owner, 'empty', new Uint8Array());
    expect(cache.get(owner, 'empty')).toBeUndefined();
    expect(cache.size).toBe(0); expect(cache.byteLength).toBe(0);
  });
});
