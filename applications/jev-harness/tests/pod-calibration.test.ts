import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPodOutcomes, outcomeEntries, outcomeFromContent } from '../src/pod-calibration.js';
import { RelayClient } from '../src/publish.js';
import { HarnessStore } from '../src/store.js';
import { Harness } from '../src/service.js';
import type { JevClient } from '../src/jev-client.js';

const POD = 'http://css.railway.internal:3456/u-pk-x/';
const url = (n: number) => `${POD}context-graphs/${n}.ttl`;

/** What get_descriptor hands back for a harness outcome: descriptor triples, then the payload graph. */
function outcomeContent(id: string, judgment: string, prior: number, hit3: boolean): string {
  return `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix jvh: <https://jev-harness.interego.xwisee.com/ns/jev-harness#> .

# ── Context Descriptor ────────────────────────────
<urn:iep:u-pk-x:${id}> a iep:ContextDescriptor ; iep:describes <${judgment}> .

# ── Named Graph Content ───────────────────────────
<${judgment}> {
    <urn:jev-harness:outcome:${id}> a jvh:Outcome .
    <urn:jev-harness:outcome:${id}> a jvh:Judgment .
    <urn:jev-harness:outcome:${id}> jvh:model "jev-1.13.0" .
    <urn:jev-harness:outcome:${id}> jvh:confidence "1"^^xsd:double .
    <urn:jev-harness:outcome:${id}> jvh:repository "interego" .
    <urn:jev-harness:outcome:${id}> jvh:commit "abc123" .
    <urn:jev-harness:outcome:${id}> dct:created "2026-09-20T14:20:22.343Z"^^xsd:dateTime .
    <urn:jev-harness:outcome:${id}> jvh:judgmentIri <${judgment}> .
    <urn:jev-harness:outcome:${id}> jvh:judgmentKind "navigation" .
    <urn:jev-harness:outcome:${id}> jvh:priorConfidence "${prior}"^^xsd:double .
    <urn:jev-harness:outcome:${id}> jvh:outcomeSource "live" .
    <urn:jev-harness:outcome:${id}> jvh:hitAt1 "false"^^xsd:boolean .
    <urn:jev-harness:outcome:${id}> jvh:hitAt3 "${hit3}"^^xsd:boolean .
    <urn:jev-harness:outcome:${id}> jvh:brier "0.2"^^xsd:double .
    <urn:jev-harness:outcome:${id}> jvh:missed "src/a.ts" .
    <urn:jev-harness:outcome:${id}> jvh:missed "src/b.ts" .
    <urn:jev-harness:outcome:${id}> jvh:summary "hit at 3, not at 1" .
}
`;
}

const entries = [
  { descriptorUrl: url(1), describes: ['urn:graph:jev-harness:navigation:j1'], modalStatus: 'Asserted', validFrom: '2026-09-20T14:20:24.271Z', supersedes: [url(0)] },
  { descriptorUrl: url(0), describes: ['urn:graph:jev-harness:navigation:j1'], modalStatus: 'Hypothetical' },
  { descriptorUrl: url(3), describes: ['urn:graph:someone-else:note'], modalStatus: 'Asserted' },
  { descriptorUrl: url(4), describes: ['urn:graph:jev-harness:review-verdict:v1'], modalStatus: 'Asserted' },
  { descriptorUrl: url(5), describes: ['urn:graph:jev-harness:navigation:j2'], modalStatus: 'Asserted' },
];
const contents: Record<string, string> = {
  [url(1)]: outcomeContent('o1', 'urn:graph:jev-harness:navigation:j1', 0.42, true),
  [url(4)]: 'this is not turtle {{{',
  [url(5)]: outcomeContent('o2', 'urn:graph:jev-harness:navigation:j2', 0.9, false),
};

let server: Server;
let relayUrl: string;
let calls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      if (body['method'] === 'initialize') { res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: {} })); return; }
      if (body['method'] === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      const params = body['params'] as { name: string; arguments: Record<string, unknown> };
      calls += 1;
      let result: unknown;
      if (params.name === 'discover_context') result = { pod: POD, entries };
      else if (params.name === 'get_descriptor') {
        const u = params.arguments['url'] as string;
        result = u in contents ? { url: u, turtle: '', graph: { content: contents[u] } } : { error: 'not found' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  relayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => { server.close(); });

describe('reading outcomes back from the pod', () => {
  it('picks the Asserted heads of harness graphs out of the manifest', () => {
    expect(outcomeEntries(entries).map((e) => e.descriptorUrl)).toEqual([url(1), url(4), url(5)]);
  });

  it('turns a descriptor\'s payload graph into an outcome record', () => {
    const o = outcomeFromContent(contents[url(1)]!, { descriptorUrl: url(1), validFrom: '2026-09-20T14:20:24.271Z' });
    expect(o).toMatchObject({
      kind: 'outcome', id: 'o1', judgmentIri: 'urn:graph:jev-harness:navigation:j1', judgmentKind: 'navigation', priorConfidence: 0.42,
      source: 'live', hitAt1: false, hitAt3: true, brier: 0.2, missed: ['src/a.ts', 'src/b.ts'], summary: 'hit at 3, not at 1',
      model: 'jev-1.13.0', createdAt: '2026-09-20T14:20:22.343Z', descriptorUrl: url(1),
    });
    expect(o?.repository.commit).toBe('abc123');
    expect(outcomeFromContent('not turtle {{{', { descriptorUrl: url(4) })).toBeUndefined();
    expect(outcomeFromContent('<urn:x> <urn:p> "no outcome here" .', { descriptorUrl: url(4) })).toBeUndefined();
  });

  it('fetches every unknown outcome through the relay, skips known ones, and records the unreadable', async () => {
    const relay = new RelayClient({ url: relayUrl, bearer: 't', podName: 'u-pk-x' });
    const r = await fetchPodOutcomes(relay, 'u-pk-x');
    expect(r.scanned).toBe(5);
    expect(r.records.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain(url(4));
    const before = calls;
    const again = await fetchPodOutcomes(relay, 'u-pk-x', { known: new Set([url(1), url(4), url(5)]) });
    expect(again.records).toHaveLength(0);
    expect(again.skipped).toBe(3);
    expect(calls - before).toBe(1);
  });

  it('merges into the store once, and a local outcome with the same id wins over the pod copy', async () => {
    const base = mkdtempSync(join(tmpdir(), 'jev-store-'));
    const store = new HarnessStore(base);
    const relay = new RelayClient({ url: relayUrl, bearer: 't', podName: 'u-pk-x' });
    const r = await fetchPodOutcomes(relay, 'u-pk-x');
    expect(store.mergePodOutcomes(r.records)).toEqual({ added: 2, total: 2 });
    expect(store.mergePodOutcomes(r.records)).toEqual({ added: 0, total: 2 });
    expect(store.outcomes().map((o) => o.id)).toEqual(['o1', 'o2']);
    appendFileSync(join(store.dir, 'outcomes.jsonl'), `${JSON.stringify({ ...r.records[0], priorConfidence: 0.99, descriptorUrl: undefined })}\n`);
    const merged = store.outcomes();
    expect(merged).toHaveLength(2);
    expect(merged.find((o) => o.id === 'o1')?.priorConfidence).toBe(0.99);
    expect(store.calibration().cells.find((c) => c.kind === 'navigation')?.samples).toBe(2);
  });

  it('is off for a bridge without a relay that names a pod, and reports a failure without throwing', async () => {
    const base = mkdtempSync(join(tmpdir(), 'jev-store-'));
    const jev = { model: 'fake' } as unknown as JevClient;
    const off = new Harness({ jev, repoRoot: base, base: 'http://localhost:1', relay: null });
    expect((await off.backfillFromPod()).status).toBe('off');
    const broken = new Harness({ jev, repoRoot: base, base: 'http://localhost:1', relay: new RelayClient({ url: 'http://127.0.0.1:9/mcp', bearer: 't', podName: 'u-pk-x' }) });
    const s = await broken.backfillFromPod();
    expect(s.status).toBe('failed');
    expect(s.error).toBeTruthy();
    const ok = new Harness({ jev, repoRoot: base, base: 'http://localhost:1', relay: new RelayClient({ url: relayUrl, bearer: 't', podName: 'u-pk-x' }) });
    const s2 = await ok.backfillFromPod();
    expect(s2).toMatchObject({ status: 'ok', scanned: 5, added: 2, total: 2 });
    expect(ok.store.podBackfill.status).toBe('ok');
  });
});
