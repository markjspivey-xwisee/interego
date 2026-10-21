import { describe, expect, it } from 'vitest';
import { latticeSnapshotDigest, confirmedSnapshotMatches } from '../src/lattice-checkpoint.js';

const url = 'https://pod.example/owner/foxxi-lattice/shared-lattice.holon.json';
const root = 'urn:pgsl:fragment:root';
const nodes = new Map<string, unknown>([['urn:pgsl:atom:one', { kind: 'Atom', value: 'private content' }]]);
const digest = () => latticeSnapshotDigest(url, root, nodes, ['bridge', 'owner']);

describe('encrypted shared lattice content confirmation', () => {
  it('covers destination, root, same-ID node edits, additional nodes and recipient changes', () => {
    const original = digest();
    expect(latticeSnapshotDigest(url + '.other', root, nodes, ['bridge', 'owner'])).not.toBe(original);
    expect(latticeSnapshotDigest(url, root + '-other', nodes, ['bridge', 'owner'])).not.toBe(original);
    expect(latticeSnapshotDigest(url, root, new Map([['urn:pgsl:atom:one', { kind: 'Atom', value: 'changed' }]]), ['bridge', 'owner'])).not.toBe(original);
    expect(latticeSnapshotDigest(url, root, new Map([...nodes, ['urn:pgsl:atom:two', {}]]), ['bridge', 'owner'])).not.toBe(original);
    expect(latticeSnapshotDigest(url, root, nodes, ['bridge', 'new-owner'])).not.toBe(original);
    expect(latticeSnapshotDigest(url, root, nodes, ['owner', 'bridge', 'owner'])).toBe(original);
  });

  it('skips only an acknowledged body whose ETag is still current', async () => {
    const d = digest(), checkpoint = { digest: d, etag: '"v1"' };
    let heads = 0;
    const same = async () => { heads++; return '"v1"'; };
    expect(await confirmedSnapshotMatches(undefined, d, '"v1"', same)).toBe(false);
    expect(await confirmedSnapshotMatches(checkpoint, d, undefined, same)).toBe(false);
    expect(await confirmedSnapshotMatches(checkpoint, d + 'changed', '"v1"', same)).toBe(false);
    expect(await confirmedSnapshotMatches(checkpoint, d, '"v2"', same)).toBe(false);
    expect(heads).toBe(0);
    expect(await confirmedSnapshotMatches(checkpoint, d, '"v1"', same)).toBe(true);
    expect(heads).toBe(1);
    expect(await confirmedSnapshotMatches(checkpoint, d, '"v1"', async () => '"v2"')).toBe(false);
    expect(await confirmedSnapshotMatches(checkpoint, d, '"v1"', async () => undefined)).toBe(false);
    expect(await confirmedSnapshotMatches(checkpoint, d, '"v1"', async () => { throw new Error('offline'); })).toBe(false);
  });
});
