// Run in a small-heap child: the logical live payload exceeds its entire heap.
import assert from 'node:assert/strict';
const { collectLive, hex } = await import(process.argv[2]);
const { nodeKey, subspaceRange, cpKey } = await import(process.argv[3]);
const { nodeAddrFromUrn } = await import(process.argv[4]);
const count = 768, payload = 'x'.repeat(512 * 1024);
const uris = Array.from({ length: count }, (_, i) => 'urn:pgsl:atom:' + i.toString(16).padStart(40, '0'));
const top = 'urn:pgsl:fragment:' + 'f'.repeat(40);
const fragment = Buffer.from(JSON.stringify({ uri: top, kind: 'fragment', level: 1, items: uris }));
const atomKeys = new Map(uris.map((uri, i) => [hex(nodeKey(nodeAddrFromUrn(uri))), i]));
let total = fragment.length, largestBatch = 0;
const live = await collectLive({
  async scan(begin, _end, onRow) {
    if (hex(begin) === hex(subspaceRange('C').begin)) {
      onRow(cpKey('fixture', 'root'), Buffer.from(JSON.stringify({ topUri: top })));
    }
  },
  async getMany(keys) {
    largestBatch = Math.max(largestBatch, keys.length);
    return new Map(keys.map(key => {
      const h = hex(key);
      if (h === hex(nodeKey(nodeAddrFromUrn(top)))) return [h, fragment];
      const i = atomKeys.get(h); assert.notEqual(i, undefined);
      const bytes = Buffer.from(JSON.stringify({ uri: uris[i], kind: 'atom', level: 0, value: payload }));
      total += bytes.length;
      return [h, bytes];
    }));
  },
});
assert(largestBatch <= 32);
assert.equal(live.stats.liveNodes, count + 1);
assert.equal(live.stats.liveAtoms, count);
assert.equal(live.stats.liveFragments, 1);
assert.equal(live.stats.liveNodeBytes, total);
assert.deepEqual(live.stats.danglingRoots, []);
assert.equal(live.stats.unreadableNodes, 0);
assert.equal(live.stats.kept.N, count + 1);
assert.equal(live.stats.kept.V, count + 1);
assert.equal(live.stats.kept.P, count + 1);
assert.equal(live.stats.kept.I, count);
assert.equal(live.stats.kept.B, count);
assert.equal(live.keys.size, 3 * (count + 1) + 2 * count + 1);
process.stdout.write(JSON.stringify({ liveNodes: live.stats.liveNodes, liveNodeBytes: total, largestBatch }) + '\n');
