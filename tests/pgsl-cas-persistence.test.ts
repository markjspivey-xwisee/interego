/**
 * Optimistic-concurrency persistence — promoteInstanceEncryptedCAS +
 * resolveLatticeFromPodDetailed.
 *
 * The point of this suite is the one property PR #64 and this change exist for:
 * a concurrent write must NEVER destroy a corpus. So the mock pod below models the
 * real CSS contract we verified live (etag = a monotonic tag; If-Match ⇒ 412 on
 * mismatch; If-None-Match:* ⇒ 412 when the resource exists; PUT carries no etag, so
 * the etag is read via HEAD), and the tests drive the exact conflict path.
 */
import { describe, it, expect } from 'vitest';
import { createPGSL, ingest, promoteInstanceEncryptedCAS, resolveLatticeFromPodDetailed, type IRI } from '@interego/pgsl';
import { deriveEncryptionKeyPair } from '@interego/core';

const kp = deriveEncryptionKeyPair('0'.repeat(64));
const prov = { wasAttributedTo: 'https://example.test/agent' as IRI, generatedAtTime: '2026-07-17T00:00:00Z' };

/** A pod resource with the CSS conditional-write semantics we verified against the
 *  live gate. One resource per instance; the fetch it returns is the transport. */
function mockPod() {
  let body: string | null = null;
  let etag = 0;
  const tag = () => `"${etag}-application/json"`;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const h = new Headers(init?.headers ?? {});
    if (method === 'GET' || method === 'HEAD') {
      if (body == null) return new Response(null, { status: 404 });
      return new Response(method === 'HEAD' ? null : body, { status: 200, headers: { etag: tag() } });
    }
    if (method === 'PUT') {
      const ifMatch = h.get('If-Match');
      const ifNone = h.get('If-None-Match');
      if (ifNone === '*' && body != null) return new Response(null, { status: 412 });   // create-guard
      if (ifMatch && ifMatch !== tag()) return new Response(null, { status: 412 });      // stale update
      body = await new Response(init?.body as BodyInit).text();
      etag += 1;
      return new Response(null, { status: body === null ? 201 : 205 });                 // no etag on PUT
    }
    return new Response(null, { status: 405 });
  }) as unknown as typeof fetch;
  return { fetchFn, peekEtag: () => (body == null ? null : tag()), exists: () => body != null };
}

function instanceWith(values: string[]) {
  const pgsl = createPGSL(prov as never);
  const top = ingest(pgsl, values as never, prov as never);
  return { pgsl, top: top as IRI };
}

const URL_ = 'https://pod.test/lattice.json';

describe('CAS persistence', () => {
  it('resolveLatticeFromPodDetailed distinguishes absent from ok, and carries the etag', async () => {
    const pod = mockPod();
    const first = await resolveLatticeFromPodDetailed(URL_, kp, pod.fetchFn);
    expect(first.status).toBe('absent');                       // 404 -> absent, not "unreadable"
    const { pgsl, top } = instanceWith(['a', 'b', 'c']);
    await promoteInstanceEncryptedCAS(pgsl, top, URL_, [kp.publicKey], kp, pod.fetchFn, { ifNoneMatch: '*' });
    const after = await resolveLatticeFromPodDetailed(URL_, kp, pod.fetchFn);
    expect(after.status).toBe('ok');
    expect(after.etag).toBeTruthy();
    expect(after.nodes!.size).toBeGreaterThan(0);
  });

  it('a create-guard (If-None-Match:*) fails on an existing resource', async () => {
    const pod = mockPod();
    const { pgsl, top } = instanceWith(['x', 'y']);
    const first = await promoteInstanceEncryptedCAS(pgsl, top, URL_, [kp.publicKey], kp, pod.fetchFn, { ifNoneMatch: '*' });
    expect(first.status).toBe('ok');
    const second = await promoteInstanceEncryptedCAS(pgsl, top, URL_, [kp.publicKey], kp, pod.fetchFn, { ifNoneMatch: '*' });
    expect(second.status).toBe('conflict');                    // 412, NOT swallowed as success
  });

  it('a stale If-Match yields a conflict, not a silent overwrite', async () => {
    const pod = mockPod();
    const a = instanceWith(['a']);
    const w1 = await promoteInstanceEncryptedCAS(a.pgsl, a.top, URL_, [kp.publicKey], kp, pod.fetchFn, { ifNoneMatch: '*' });
    const staleEtag = w1.etag!;                                // A's view of the etag
    // B writes, advancing the etag.
    const b = instanceWith(['b']);
    await promoteInstanceEncryptedCAS(b.pgsl, b.top, URL_, [kp.publicKey], kp, pod.fetchFn, { ifMatch: staleEtag });
    // A tries again with its now-stale etag -> conflict.
    const a2 = await promoteInstanceEncryptedCAS(a.pgsl, a.top, URL_, [kp.publicKey], kp, pod.fetchFn, { ifMatch: staleEtag });
    expect(a2.status).toBe('conflict');
  });

  it('the conflict path with pod-wins merge loses NEITHER writer', async () => {
    const pod = mockPod();
    // Writer A creates the resource with {a1,a2}.
    const a = instanceWith(['a1', 'a2']);
    const wA = await promoteInstanceEncryptedCAS(a.pgsl, a.top, URL_, [kp.publicKey], kp, pod.fetchFn, { ifNoneMatch: '*' });
    expect(wA.status).toBe('ok');
    // Writer B has its own {b1,b2} and a STALE view (no etag) -> its create-guard 412s.
    const b = instanceWith(['b1', 'b2']);
    const wB = await promoteInstanceEncryptedCAS(b.pgsl, b.top, URL_, [kp.publicKey], kp, pod.fetchFn, { ifNoneMatch: '*' });
    expect(wB.status).toBe('conflict');
    // B reloads (gets A's corpus), MERGES pod-wins (A's nodes + B's absent nodes),
    // and re-writes with the current etag — exactly what casPersist does.
    const reload = await resolveLatticeFromPodDetailed(URL_, kp, pod.fetchFn);
    expect(reload.status).toBe('ok');
    // pod-wins merge: base = pod nodes, add only B's nodes absent from the pod.
    const merged = new Map(reload.nodes!);
    for (const [u, n] of b.pgsl.nodes) if (!merged.has(u)) merged.set(u, n);
    const mergedInst = createPGSL(prov as never);
    for (const [u, n] of merged) (mergedInst.nodes as Map<IRI, unknown>).set(u, n);
    const wB2 = await promoteInstanceEncryptedCAS(mergedInst as never, b.top, URL_, [kp.publicKey], kp, pod.fetchFn, { ifMatch: reload.etag });
    expect(wB2.status).toBe('ok');
    // The final pod state must contain BOTH A's and B's atoms — no loss.
    const final = await resolveLatticeFromPodDetailed(URL_, kp, pod.fetchFn);
    const values = new Set([...final.nodes!.values()].filter((n: any) => n.kind === 'Atom').map((n: any) => String(n.value)));
    expect(values.has('a1')).toBe(true);
    expect(values.has('a2')).toBe(true);
    expect(values.has('b1')).toBe(true);
    expect(values.has('b2')).toBe(true);
  });
});
