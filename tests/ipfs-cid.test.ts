/**
 * Tests for computeCid — must produce real CIDv1 (raw codec, sha2-256)
 * that any IPFS gateway will resolve. Earlier implementation returned
 * `bafkrei` + raw-hex which looked like a CID but wasn't one.
 */

import { describe, it, expect } from 'vitest';
import { computeCid } from '../src/crypto/ipfs.js';

describe('computeCid — real CIDv1 raw + sha2-256', () => {
  it('starts with multibase prefix b + raw-codec marker afkrei', () => {
    const cid = computeCid('hello world');
    expect(cid).toMatch(/^bafkrei/);
  });

  it('is purely base32 lowercase (a-z + 2-7), no hex artifacts', () => {
    const cid = computeCid('hello world');
    // Whole CID is multibase-prefixed base32 → only b + [a-z2-7].
    expect(cid).toMatch(/^b[a-z2-7]+$/);
    // Specifically: no characters outside the base32 alphabet.
    // Old impl produced strings with `0`, `1`, `8`, `9` — those are NOT
    // valid base32. This regex catches the regression.
    expect(cid).not.toMatch(/[018-9]/);
  });

  it('matches the canonical CIDv1 raw of "hello world" produced by ipfs', () => {
    // `echo -n "hello world" | ipfs add --pin --raw-leaves --cid-version=1 -Q`
    // produces this CID. Locking it in stops silent regressions.
    const cid = computeCid('hello world');
    expect(cid).toBe('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
  });

  it('is deterministic for the same content', () => {
    const a = computeCid('the same content');
    const b = computeCid('the same content');
    expect(a).toBe(b);
  });

  it('differs across different content', () => {
    const a = computeCid('alice');
    const b = computeCid('bob');
    expect(a).not.toBe(b);
  });

  it('handles empty content correctly', () => {
    const cid = computeCid('');
    expect(cid).toMatch(/^bafkrei/);
    expect(cid.length).toBeGreaterThan(40);
  });

  it('handles unicode + multi-byte content', () => {
    const cid = computeCid('hello 世界 🌍');
    expect(cid).toMatch(/^bafkrei/);
    expect(cid).toMatch(/^b[a-z2-7]+$/);
  });

  it('produces consistent length across content sizes (sha2-256 always 32 bytes)', () => {
    // Multibase prefix (1) + version (1) + codec (1) + multihash header (2)
    // + 32 bytes digest = 37 bytes raw → ceil(37 * 8 / 5) = 60 chars base32.
    // Plus the multibase prefix. Total expected: 59 chars.
    expect(computeCid('a').length).toBe(59);
    expect(computeCid('a much longer string of content here').length).toBe(59);
  });
});
