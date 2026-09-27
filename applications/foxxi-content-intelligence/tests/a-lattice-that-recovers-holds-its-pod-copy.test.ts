/**
 * A shared lattice that could not read its pod copy, and later can, holds that copy from then on.
 *
 * ★ WHY. While a lattice's pod copy cannot be read, the lattice is fenced: it serves from memory
 * and persists nothing. What is composed then is kept in memory only. When the pod answers again,
 * getLattice kept the in-memory instance unmerged, trusting "the write path's CAS will merge them
 * onto the pod", and recorded the pod's current etag. So the next write's If-Match succeeded, and
 * put the in-memory instance over the pod's: whatever only the pod held was gone. Until that
 * write, a reader asking whether the lattice was whole (latticeReadWhole) was told yes, and was
 * served a lattice missing it.
 *
 * The pod is stood in for (its read, the bridge key, the transport guard); the lattice is the
 * real one, driven through the fence and back.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const pod = vi.hoisted(() => {
  process.env.FOXXI_LATTICE_RETRY_BASE_MS = '0';   // a fenced lattice may retry at once
  return { answer: { status: 'unreadable' } as { status: 'ok' | 'absent' | 'unreadable'; nodes?: unknown; etag?: string } };
});

vi.mock('@interego/pgsl', async (original) => ({
  ...(await original<typeof import('@interego/pgsl')>()),
  resolveLatticeFromPodDetailed: async () => pod.answer,
}));
vi.mock('../src/foundation-holon-altitude.js', async (original) => ({
  ...(await original<typeof import('../src/foundation-holon-altitude.js')>()),
  bridgeEncryptionKeypair: () => ({ publicKey: 'test-public-key', privateKey: 'test-private-key' }),
}));
vi.mock('../src/ssrf-guard.js', () => ({
  assertSafeFetchTarget: async () => undefined,
  guardedFetchFn: (f: unknown) => f,
  safeFetch: async () => new Response('', { status: 503 }),
  safePublicUrlOrUndefined: (u: string) => u,
  isPrivateHostname: () => false,
}));

const { composeIntoSharedLattice, dereferenceTerm, ensureResident, latticeReadWhole } = await import('../src/foundation-shared-lattice.js');
const { createPGSL, ingest } = await import('@interego/pgsl');

describe('a lattice that recovers', () => {
  const podUrl = 'https://recovering.example/p/';
  const did = 'did:ethr:0x3333333333333333333333333333333333333333';
  const label = 'recovering';
  const held = (term: string) => dereferenceTerm(label, term)?.found === true;

  it('takes in its pod copy when the pod answers again, and keeps what was composed while it could not', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    pod.answer = { status: 'unreadable' };
    await ensureResident(podUrl, did, label);
    expect(latticeReadWhole(label)).toBe(false);

    // Composed while fenced: held in memory only.
    await composeIntoSharedLattice({ podUrl, agentDid: did, label, terms: ['urn:test:composed-while-fenced'], content: { n: 1 }, contentType: 'test:Artifact', ephemeral: true });
    expect(held('urn:test:composed-while-fenced')).toBe(true);

    // The pod answers again, holding what was written to it before the fence.
    const onPod = createPGSL({ wasAttributedTo: did as never, generatedAtTime: '2026-09-27T00:00:00Z' });
    ingest(onPod, ['urn:test:only-on-the-pod', 'urn:test:also-on-the-pod']);
    pod.answer = { status: 'ok', nodes: onPod.nodes, etag: '"after-the-fence"' };
    vi.setSystemTime(Date.now() + 6_000);   // past the retry's jitter (backoff is 0 here)
    await ensureResident(podUrl, did, label);
    vi.useRealTimers();

    expect(latticeReadWhole(label)).toBe(true);
    expect(held('urn:test:only-on-the-pod')).toBe(true);
    expect(held('urn:test:also-on-the-pod')).toBe(true);
    expect(held('urn:test:composed-while-fenced')).toBe(true);
  });

  it("merges with the CAS path's own merge, and still adopts the pod copy outright when nothing was composed", () => {
    const src = readFileSync(new URL('../src/foundation-shared-lattice.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/if \(!pgsl \|\| pgsl\.nodes\.size === 0\) pgsl = rebuildInstance\(d\.nodes!, agentDid\);\s+else pgsl = mergeReseat\(label, pgsl, d\.nodes!, agentDid\);/);
  });
});
