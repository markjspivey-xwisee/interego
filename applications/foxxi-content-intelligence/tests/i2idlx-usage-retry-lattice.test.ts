/** Actual signed persist callback + real PGSL ingest, encryption, CAS and decryption.
 * Only external transport/key provisioning and the failed corpus lookup are fixtures.
 * These are synthetic local records; no listener or live learner/pod write is used. */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { generateKeyPair, type FetchFn } from '@interego/core';
import { resolveLatticeFromPodDetailed } from '@interego/pgsl';
import { persistStatementWithUsage, type UsageArtifactReceipt } from '../src/i2idlx-usage-record.js';
import { writeSelfXapi } from '../src/self-xapi.js';

const provision = vi.hoisted(() => ({ key: null as import('@interego/core').EncryptionKeyPair | null }));
vi.mock('../src/spec-ontology.js', () => ({ NS_ROOT: 'https://foxxi-bridge.interego.xwisee.com/ns/' }));
vi.mock('../src/foundation-holon-altitude.js', () => ({ bridgeEncryptionKeypair: () => provision.key }));
vi.mock('../src/ssrf-guard.js', () => ({ assertSafeFetchTarget: async () => undefined, guardedFetchFn: (fetch: unknown) => fetch }));

const ns = 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx#';
const concept = 'https://id.i2idl.org/concepts/xapi-statement';
const did = 'did:web:example.org:agents:usage-retry-diagnostic';
const tag = 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi#conceptIds';
const known = new Map([[concept, { id: 'xapi-statement', iri: concept, label: 'xAPI Statement', origin: { kind: 'canonical', release: 'v0.0.93' } }]]);
function sourceStatement() {
  return { id: 'eb7fc83a-8498-413a-a937-e901b6ecf5bf', timestamp: '2026-11-04T20:00:00.000Z',
    actor: { objectType: 'Agent', account: { homePage: 'https://example.org/', name: did } },
    verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' }, object: { objectType: 'Activity', id: 'https://example.org/diagnostic/catalog' },
    context: { extensions: { [tag]: [concept] } } };
}

/** An in-memory HTTP resource, not an ingest/persistence replacement. Bodies are
 * encrypted by the real package and decrypted by its normal pod read function. */
function podFixture(podUrl: string) {
  const resource = podUrl + 'foxxi-lattice/shared-lattice.holon.json';
  let body: string | undefined, revision = 0, puts = 0;
  const descriptors = new Map<string, string>();
  const fetch: FetchFn = async (url, init = {}) => {
    const address = String(url), method = init.method ?? 'GET';
    if (address === podUrl + 'keys/encryption.json') return new Response(null, { status: 404 });
    if (address === podUrl + 'foxxi-lattice/' && method === 'PUT') return new Response(null, { status: 201 });
    if (address.endsWith('.ttl') && method === 'PUT') { descriptors.set(address, String(init.body)); return new Response(null, { status: 201 }); }
    if (address !== resource) throw new Error('Unexpected fixture transport target: ' + address);
    const etag = '"revision-' + revision + '"';
    if (method === 'HEAD' || method === 'GET') return body === undefined ? new Response(null, { status: 404 })
      : new Response(method === 'HEAD' ? null : body, { status: 200, headers: { ETag: etag, 'Content-Type': 'application/json' } });
    if (method !== 'PUT') throw new Error('Unexpected fixture transport method: ' + method);
    const headers = new Headers(init.headers);
    if ((headers.get('if-none-match') === '*' && body !== undefined) || (headers.has('if-match') && headers.get('if-match') !== etag)) return new Response(null, { status: 412 });
    expect(body === undefined ? headers.get('if-none-match') : headers.get('if-match')).toBe(body === undefined ? '*' : etag);
    body = String(init.body); puts++; revision++;
    return new Response(null, { status: 201, headers: { ETag: '"revision-' + revision + '"' } });
  };
  return { fetch, resource, descriptors, puts: () => puts, ciphertext: () => body };
}

/** Extract the actual signed server callback, keeping its original/derived
 * compose arguments and wrapper ordering instead of recreating that behavior. */
function signedPersist(compose: typeof import('../src/foundation-shared-lattice.js').composeIntoSharedLattice,
  podUrl: string, label: string, lookup: () => Promise<unknown>) {
  const source = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.ES2022, true);
  let callback: ts.ArrowFunction | undefined;
  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'persist' && ts.isArrowFunction(node.initializer)
      && node.initializer.getText(ast).includes("contentType: 'xapi:Statement'")) callback = node.initializer;
    ts.forEachChild(node, walk);
  };
  walk(ast);
  if (!callback) throw new Error('Actual signed statement persist callback not found');
  const js = ts.transpileModule('const persist = ' + callback.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return Function('composeIntoSharedLattice', 'persistStatementWithUsage', 'loadPublicTaskData', 'resolveConceptIndex', 'bound', 'podUrl', 'label', 'telemetry', 'bridgeBaseUrl', js + '; return persist;')(
    compose, persistStatementWithUsage, lookup, () => known, { callerDid: did }, podUrl, label, false, 'https://bridge.example',
  ) as (statement: Record<string, unknown>) => Promise<UsageArtifactReceipt | null>;
}

describe('an identical xAPI retry after original pod persistence', () => {
  for (const restart of [false, true]) it(restart ? 'recovers and deduplicates the original after a cold resident reload' : 'reuses the same original in a warm resident and only adds the derived record', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime('2026-11-04T20:01:00.000Z');
      const key = generateKeyPair(); provision.key = key;
      let foundation = await import('../src/foundation-shared-lattice.js');
      const podUrl = 'https://usage-retry.example/' + (restart ? 'cold/' : 'warm/'), label = restart ? 'retry-cold' : 'retry-warm';
      const pod = podFixture(podUrl), caller = sourceStatement(), before = structuredClone(caller);
      const actual = { ...structuredClone(caller), stored: '2026-11-04T20:00:01.000Z', authority: { account: { homePage: 'https://example.org/lrs', name: 'fixture-lrs' } }, version: '2.0.0' };
      let unavailable = true, lookupCalls = 0;
      const lookup = async () => { lookupCalls++; if (unavailable) throw new Error('Controlled local corpus lookup failure'); return { meta: { ns } }; };
      const makePersist = () => signedPersist(args => foundation.composeIntoSharedLattice({ ...args, fetch: pod.fetch }), podUrl, label, lookup);
      let persist = makePersist();
      const request = async (method: 'GET' | 'POST') => method === 'POST' ? { status: 200, body: [caller.id] } : { status: 200, body: structuredClone(actual) };
      const first = await writeSelfXapi(did, [caller], { request, persist });
      expect(first.status).toBe(502);
      const firstReceipt = (first.body as { receipts: Array<{ holonUri: string; usageRecord: unknown }> }).receipts[0]!;
      expect(firstReceipt.usageRecord).toMatchObject({ status: 'failed', originalRetained: true });
      expect(pod.puts()).toBe(1);
      expect(pod.ciphertext()).not.toContain(caller.id);
      expect(foundation.latticeArtifacts(label, 'xapi:Statement')).toHaveLength(1);
      const held = await resolveLatticeFromPodDetailed(pod.resource, key, pod.fetch as typeof fetch);
      expect(held.status).toBe('ok');
      if (held.status !== 'ok' || !held.nodes) throw new Error('Original was not decryptable from the actual stored ciphertext');
      if (restart) {
        // No process-local lattice or clean-checkpoint cache survives this import.
        // The same encrypted pod resource is loaded and its dedup indexes rebuilt.
        vi.resetModules();
        foundation = await import('../src/foundation-shared-lattice.js');
        expect(foundation.latticeArtifacts(label, 'xapi:Statement')).toHaveLength(0);
        persist = makePersist();
      }
      vi.setSystemTime('2026-11-04T20:05:00.000Z'); unavailable = false;
      const second = await writeSelfXapi(did, [caller], { request, persist });
      expect(second.status).toBe(200);
      const secondReceipt = (second.body as { statementIds: string[]; receipts: Array<{ holonUri: string; usageRecord: { holonUri: string; status: string } }> });
      expect(secondReceipt.statementIds).toEqual([caller.id]);
      expect(secondReceipt.receipts[0]!.holonUri).toBe(firstReceipt.holonUri);
      expect(secondReceipt.receipts[0]!.usageRecord.status).toBe('persisted');
      const originals = foundation.latticeArtifacts(label, 'xapi:Statement');
      expect(originals).toHaveLength(1); expect(originals[0]!.content).toEqual(actual);
      expect(foundation.readArtifact(label, firstReceipt.holonUri)?.content).toEqual(actual);
      expect(foundation.latticeArtifacts(label, ns + 'UsageRecord')).toHaveLength(1);
      const derived = foundation.readArtifact(label, secondReceipt.receipts[0]!.usageRecord.holonUri)!.content as { sourceStatementId: string; sourceTimestamp: string; sourceStored: string; generatedAt: string };
      expect(derived).toMatchObject({ sourceStatementId: caller.id, sourceTimestamp: caller.timestamp, sourceStored: actual.stored, generatedAt: '2026-11-04T20:05:00.000Z' });
      expect(caller).toEqual(before); expect(lookupCalls).toBe(2);
      expect(pod.descriptors.size).toBe(1); // Original projection is the same URL; derived stays private.
      // Warm retry skips a confirmed unchanged original PUT. A cold retry may
      // re-encrypt the snapshot, but does not create another original artifact.
      expect(pod.puts()).toBe(restart ? 3 : 2);
      const final = await resolveLatticeFromPodDetailed(pod.resource, key, pod.fetch as typeof fetch);
      expect(final.status).toBe('ok');
      if (final.status !== 'ok' || !final.nodes) throw new Error('Retried ciphertext is unreadable');
      for (const [id, node] of held.nodes) expect(final.nodes.get(id)).toEqual(node);
    } finally { vi.useRealTimers(); }
  });
});
