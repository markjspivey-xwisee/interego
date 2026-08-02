#!/usr/bin/env tsx
/**
 * Regression test for the publish_context accept-then-publish defer.
 *
 * The fix in deploy/mcp-relay/server.ts:handlePublishContext returns
 * synchronously with `status: 'pending'` once the gates pass, and runs
 * the substrate-CSS chain (graph PUT + descriptor PUT + manifest CAS)
 * in the background. The synchronous response carries content-addressable
 * predicted URLs (descriptor + graph + manifest + IPFS CID) so the
 * caller does not have to wait for CSS for the wire to come back.
 *
 * What this test pins:
 *
 *   1. predictDescriptorUrl + predictGraphUrl + predictManifestUrl
 *      compute the exact URLs publish() will write. If a slug
 *      convention drifts in publish() without a matching update in
 *      the predict helpers, the relay's deferred response would point
 *      at a 404 forever — this test catches the drift.
 *
 *   2. The predicted URLs are computed in O(1) (no fetch). That's the
 *      property the deferred-publish response time depends on: the
 *      synchronous return path does NO CSS I/O for URL computation.
 *
 *   3. The actual publish() against a deliberately slow fetch takes
 *      noticeably longer than the predicted-URL computation — proving
 *      the defer has a real wall-time payoff. Three payload sizes
 *      (200B / 6KB / 50KB) confirm the predict path is constant-time
 *      in payload size.
 *
 *   4. The predicted URLs match the URLs actually written by
 *      publish() to the in-memory pod (the equality property the
 *      defer relies on for response correctness).
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/publish-defer.test.ts
 *
 * Exits non-zero on any failing assertion.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ContextDescriptor } from '@interego/core';
import type { FetchFn, IRI } from '@interego/core';
import {
  publish,
  predictDescriptorUrl,
  predictGraphUrl,
  predictManifestUrl,
} from '@interego/solid';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(cond: boolean, name: string): void {
  if (cond) {
    pass++;
    // eslint-disable-next-line no-console
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    failures.push(name);
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${name}`);
  }
}

// Synthetic pod that records every PUT, with a configurable per-request
// delay so we can measure the wall-time payoff of skipping the chain.
function makeSlowPod(perRequestDelayMs: number): {
  fetch: FetchFn;
  puts: { url: string; body: string }[];
} {
  const resources = new Map<string, string>();
  const puts: { url: string; body: string }[] = [];
  const f: FetchFn = async (url, init) => {
    await new Promise((r) => setTimeout(r, perRequestDelayMs));
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      const body = resources.get(url);
      if (body !== undefined) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? '"v1"' : null) },
          text: async () => body,
          json: async () => JSON.parse(body),
        };
      }
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: { get: () => null },
        text: async () => '',
        json: async () => ({}),
      };
    }
    if (method === 'PUT' || method === 'PATCH') {
      const body = typeof init?.body === 'string' ? (init!.body as string) : '';
      resources.set(url, body);
      puts.push({ url, body });
      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? '"v1"' : null) },
        text: async () => '',
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({}),
    };
  };
  return { fetch: f, puts };
}

function buildDescriptor(id: string): ReturnType<ReturnType<typeof ContextDescriptor.create>['build']> {
  return ContextDescriptor.create(id as IRI)
    .describes('urn:graph:test:defer' as IRI)
    .temporal({ validFrom: '2026-06-07T00:00:00Z' })
    .validFrom('2026-06-07T00:00:00Z')
    .delegatedBy(
      'https://owner.example/profile#me' as IRI,
      'urn:agent:test:defer' as IRI,
      { endedAt: '2026-06-07T00:00:00Z' },
    )
    .trust({ trustLevel: 'SelfAsserted', issuer: 'https://owner.example/profile#me' as IRI })
    .federation({
      origin: 'https://pod.example/u/' as IRI,
      storageEndpoint: 'https://pod.example/u/' as IRI,
      syncProtocol: 'SolidNotifications',
    })
    .version(1)
    .build();
}

async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = process.hrtime.bigint();
  const result = await fn();
  const end = process.hrtime.bigint();
  return { result, ms: Number(end - start) / 1_000_000 };
}

async function main(): Promise<void> {
  const podUrl = 'https://pod.example/u/';
  const descriptorId = 'urn:iep:defer:test:1' as IRI;

  // ── Predict URLs are O(1) and produce stable, deterministic strings.
  const tPredict = await measure(async () => {
    return {
      d: predictDescriptorUrl(podUrl, descriptorId),
      g: predictGraphUrl(podUrl, descriptorId),
      ge: predictGraphUrl(podUrl, descriptorId, { encrypted: true }),
      m: predictManifestUrl(podUrl),
    };
  });
  ok(tPredict.ms < 5, `predict URLs run in O(1) (<5ms; observed ${tPredict.ms.toFixed(2)}ms)`);
  ok(
    tPredict.result.d === 'https://pod.example/u/context-graphs/1.ttl',
    `predictDescriptorUrl == https://pod.example/u/context-graphs/1.ttl (observed ${tPredict.result.d})`,
  );
  ok(
    tPredict.result.g === 'https://pod.example/u/context-graphs/1-graph.trig',
    `predictGraphUrl (plaintext) == ...1-graph.trig (observed ${tPredict.result.g})`,
  );
  ok(
    tPredict.result.ge === 'https://pod.example/u/context-graphs/1-graph.envelope.jose.json',
    `predictGraphUrl (encrypted) == ...1-graph.envelope.jose.json (observed ${tPredict.result.ge})`,
  );
  ok(
    tPredict.result.m === 'https://pod.example/u/.well-known/context-graphs',
    `predictManifestUrl == ...well-known/context-graphs (observed ${tPredict.result.m})`,
  );

  // ── Predict URLs MATCH what publish() actually writes.
  const fastPod = makeSlowPod(0);
  const descriptor = buildDescriptor(descriptorId as string);
  const tinyGraph = '<urn:graph:test:defer> <urn:p:hello> "world" .';
  const actual = await publish(descriptor, tinyGraph, podUrl, { fetch: fastPod.fetch });
  ok(
    actual.descriptorUrl === tPredict.result.d,
    `predictDescriptorUrl matches publish().descriptorUrl (predicted ${tPredict.result.d}, actual ${actual.descriptorUrl})`,
  );
  ok(
    actual.graphUrl === tPredict.result.g,
    `predictGraphUrl matches publish().graphUrl (predicted ${tPredict.result.g}, actual ${actual.graphUrl})`,
  );
  ok(
    actual.manifestUrl === tPredict.result.m,
    `predictManifestUrl matches publish().manifestUrl (predicted ${tPredict.result.m}, actual ${actual.manifestUrl})`,
  );

  // ── Wall-time payoff: with a slow CSS (50ms per round-trip),
  //    publish() runs noticeably longer than the predict path. We
  //    measure across three payload sizes to confirm the predict
  //    path is constant-time in payload size.
  const sizes: { label: string; bytes: number }[] = [
    { label: '200B',  bytes: 200 },
    { label: '6KB',   bytes: 6 * 1024 },
    { label: '50KB',  bytes: 50 * 1024 },
  ];
  for (const sz of sizes) {
    const graphContent =
      '<urn:graph:test:defer> <urn:p:body> "' +
      'x'.repeat(sz.bytes) +
      '" .';
    const podForSize = makeSlowPod(50);
    const descForSize = buildDescriptor(`urn:iep:defer:test:${sz.label}` as string);

    const tPredictForSize = await measure(async () => ({
      d: predictDescriptorUrl(podUrl, descForSize.id),
      g: predictGraphUrl(podUrl, descForSize.id),
      m: predictManifestUrl(podUrl),
    }));
    ok(
      tPredictForSize.ms < 5,
      `predict URLs constant-time in payload size — ${sz.label} ran in ${tPredictForSize.ms.toFixed(2)}ms (<5ms)`,
    );

    const tPublish = await measure(async () =>
      publish(descForSize, graphContent, podUrl, { fetch: podForSize.fetch }),
    );
    // The synchronous response time the relay returns IS tPredictForSize
    // (the deferred path) — NOT tPublish (the substrate chain).
    // Real wire-time will include gate I/O, but the substrate-CSS chain
    // is the dragon. Assert the deferred-response budget would hold:
    // tPredictForSize < 3000ms regardless of payload size.
    ok(
      tPredictForSize.ms < 3000,
      `${sz.label}: deferred response time (predict URLs) <3000ms (observed ${tPredictForSize.ms.toFixed(2)}ms)`,
    );
    // And the actual publish() takes longer than the predict path —
    // the property the defer relies on for a real payoff.
    ok(
      tPublish.ms > tPredictForSize.ms,
      `${sz.label}: publish() (${tPublish.ms.toFixed(2)}ms) > predict (${tPredictForSize.ms.toFixed(2)}ms) — defer has wall-time payoff`,
    );
  }

  // ── The 202's content address, and what is pinned under it ─────────────────
  //
  // ★ THE DEFERRED RESPONSE IS CONTENT-ADDRESSED OVER A DESCRIPTOR THAT MIGHT NOT LAND.
  //
  // The CID is computed from the descriptor decided on the request thread. The deferred
  // write then RE-DECIDES `iep:supersedes` inside the mutex that performs it (so a publish
  // that queued behind another does not fork the chain), which changes the bytes. So under
  // contention the caller was handed — and IPFS was permanently pinned with — a content
  // address for a document the pod does not hold. A content address cannot be retracted.
  //
  // Two properties are asserted here, both about `handlePublishContext`, which no test can
  // call: server.ts starts an HTTP listener on import. Read as source for the same reason
  // identity-attribution-gates.test.ts does — the alternative is no witness at all.
  const serverSrc = readFileSync(
    fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8',
  );
  ok(
    /const writtenTurtle = toTurtle\(descriptorToWrite\);/.test(serverSrc),
    'the deferred task content-addresses the descriptor it actually wrote',
  );
  ok(
    /void pinToIpfs\(writtenTurtle,/.test(serverSrc),
    '★ and pins THOSE bytes — not the prediction the response was computed over',
  );
  ok(
    /if \(!publishDeferred\) \{\s*\n\s*void pinToIpfs\(turtle,/.test(serverSrc),
    '★ the response-path pin is skipped on the deferred path, so the prediction is never pinned',
  );
  ok(
    /const cidIsProvisional = publishDeferred;/.test(serverSrc)
    && /provisional: true,/.test(serverSrc),
    'and the CID the caller is handed is marked provisional on that path rather than claimed final',
  );
  ok(
    /cid: committedCid,/.test(serverSrc),
    'with the committed CID recorded on the deferred status the response points at',
  );

  // ── Summary ────────────────────────────────────────────────
  if (fail > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n${pass} passed, ${fail} failed`);
    // eslint-disable-next-line no-console
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${pass} passed, 0 failed`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('test crashed:', err);
  process.exit(1);
});
