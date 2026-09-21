import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NS, payloadTurtle, type PublishContext } from '../src/descriptor.js';
import { judgmentFromContent } from '../src/pod-judgment.js';
import { recordOutcome, type AnyJudgment } from '../src/judgments/outcome.js';
import type { NavigationJudgment } from '../src/judgments/navigate.js';
import type { TestSelectionJudgment } from '../src/judgments/select-tests.js';
import type { ReviewVerdictJudgment } from '../src/judgments/review-gate.js';
import type { FailureTriageJudgment } from '../src/judgments/triage.js';
import { FakeJevClient } from '../src/jev-client.js';
import { RelayClient } from '../src/publish.js';
import { Harness, HarnessError } from '../src/service.js';

const ctx: PublishContext = { base: 'http://localhost:6090', ns: DEFAULT_NS, agentId: 'urn:agent:test', ownerWebId: 'https://id.example/me#me' };
const base = { createdAt: '2026-09-20T00:00:00.000Z', model: 'jev-1.13.0', repository: { name: 'interego', root: '/r', commit: 'abc' }, usage: { requests: 1, input_tokens: 1, output_tokens: 0, latencyMs: 1 } };

const navigation: NavigationJudgment = {
  ...base, kind: 'navigation', id: 'n1', graphIri: 'urn:graph:jev-harness:navigation:n1', confidence: 0.61, task: 'move the gate', scope: 'src',
  files: [{ path: 'src/a.ts', probability: 0.6 }, { path: 'src/b.ts', probability: 0.3 }], tests: [{ path: 'tests/a.test.ts', probability: 0.5 }], docs: [],
  covered: 0.4, noTestProbability: 0.6, advice: 'open-top-three', passes: [], filesConsidered: 3, directoryProbability: 0.7,
};
const selection: TestSelectionJudgment = {
  ...base, kind: 'test-selection', id: 's1', graphIri: 'urn:graph:jev-harness:test-selection:s1', confidence: 1, changedFiles: ['src/a.ts'], mode: 'subset',
  reasons: ['import graph'], tests: [{ path: 'tests/a.test.ts', selectedBy: 'deterministic' }, { path: 'tests/b.test.ts', selectedBy: 'semantic', probability: 0.4 }], covered: { 'src/a.ts': 0.9 }, task: 't',
};
const verdict: ReviewVerdictJudgment = {
  ...base, kind: 'review-verdict', id: 'v1', graphIri: 'urn:graph:jev-harness:review-verdict:v1', confidence: 0.8, verdict: 'auto-ok', checks: [],
  hazards: [{ name: 'authorization-change', description: 'd', probability: 0.1, threshold: 0.6, fired: false }, { name: 'assertions-removed', description: 'd', probability: 0.7, threshold: 0.6, fired: true }],
  descriptionMatch: 1.5, risk: { choice: 'low', probabilities: { low: 0.8 }, confidence: 0.8 }, changedFiles: ['src/a.ts'], reasons: ['nothing fired'], policy: 'p', title: 'fix a',
};
const triage: FailureTriageJudgment = {
  ...base, kind: 'failure-triage', id: 'f1', graphIri: 'urn:graph:jev-harness:failure-triage:f1', confidence: 0.7, changedFiles: ['src/a.ts'], parsedFailures: 2,
  failures: [
    { id: 'X00', file: 'tests/a.test.ts', name: 'does a', excerpt: 'boom', causeClass: 'code-defect', probabilities: { 'code-defect': 0.8, flaky: 0.2 }, confidence: 0.8, action: 'fix-the-code' },
    { id: 'X01', excerpt: 'timeout', causeClass: 'environment', probabilities: { environment: 0.6 }, confidence: 0.6, action: 'fix-environment-then-retry' },
  ],
  groups: [{ causeClass: 'code-defect', count: 1, action: 'fix-the-code', failures: ['X00'] }, { causeClass: 'environment', count: 1, action: 'fix-environment-then-retry', failures: ['X01'] }],
};

/** What get_descriptor hands back: prefixes on top, then the payload inside the graph, as the relay stores it. */
function asPodContent(j: AnyJudgment): string {
  const turtle = payloadTurtle(j, ctx);
  const lines = turtle.split('\n');
  const prefixes = lines.filter((l) => l.startsWith('@prefix'));
  const body = lines.filter((l) => !l.startsWith('@prefix'));
  return `${prefixes.join('\n')}\n\n<urn:iep:u-pk-x:1> a iep:ContextDescriptor ; iep:describes <${j.graphIri}> .\n\n<${j.graphIri}> {\n${body.join('\n')}\n}\n`;
}

describe('a judgment read back from the pod', () => {
  it('rebuilds each kind well enough that an outcome scores the same as against the original', () => {
    const cases: Array<[AnyJudgment, Parameters<typeof recordOutcome>[1]]> = [
      [navigation, { judgmentIri: navigation.graphIri, filesChanged: ['src/b.ts', 'src/c.ts'] }],
      [selection, { judgmentIri: selection.graphIri, testsRun: ['tests/a.test.ts'], testsFailed: ['tests/b.test.ts', 'tests/c.test.ts'] }],
      [verdict, { judgmentIri: verdict.graphIri, humanDecision: 'approved' }],
      [triage, { judgmentIri: triage.graphIri, confirmedClasses: { X00: 'code-defect', X01: 'flaky' } }],
    ];
    for (const [original, input] of cases) {
      const parsed = judgmentFromContent(asPodContent(original), { graphIri: original.graphIri, descriptorUrl: 'http://css/u-pk-x/context-graphs/1.ttl' });
      expect(parsed.kind).toBe('judgment');
      if (parsed.kind !== 'judgment') return;
      expect(parsed.judgment.kind).toBe(original.kind);
      expect(parsed.judgment.id).toBe(original.id);
      expect(parsed.judgment.confidence).toBe(original.confidence);
      expect(parsed.judgment.model).toBe(original.model);
      expect(parsed.judgment.repository.commit).toBe('abc');
      expect(parsed.judgment.podDescriptorUrl).toBe('http://css/u-pk-x/context-graphs/1.ttl');
      const a = recordOutcome(original, input);
      const b = recordOutcome(parsed.judgment, input);
      expect([b.hitAt1, b.hitAt3, b.missed, b.agreement, b.summary, b.priorConfidence]).toEqual([a.hitAt1, a.hitAt3, a.missed, a.agreement, a.summary, a.priorConfidence]);
      if (original.kind !== 'failure-triage') expect(b.brier).toBe(a.brier);
    }
  });

  it('keeps the fields a reader of the judgment itself needs', () => {
    const nav = judgmentFromContent(asPodContent(navigation), { graphIri: navigation.graphIri, descriptorUrl: 'u' });
    expect(nav.kind === 'judgment' && nav.judgment.kind === 'navigation' && [nav.judgment.task, nav.judgment.advice, nav.judgment.files.length, nav.judgment.tests.length, nav.judgment.directoryProbability]).toEqual(['move the gate', 'open-top-three', 2, 1, 0.7]);
    const v = judgmentFromContent(asPodContent(verdict), { graphIri: verdict.graphIri, descriptorUrl: 'u' });
    expect(v.kind === 'judgment' && v.judgment.kind === 'review-verdict' && [v.judgment.verdict, v.judgment.hazards.map((h) => h.fired), v.judgment.title, v.judgment.risk?.choice]).toEqual(['auto-ok', [false, true], 'fix a', 'low']);
  });

  it('reports an outcome head and unreadable content as such', () => {
    const outcome = recordOutcome(verdict, { judgmentIri: verdict.graphIri, humanDecision: 'approved' });
    expect(judgmentFromContent(asPodContent(outcome as unknown as AnyJudgment), { graphIri: verdict.graphIri, descriptorUrl: 'u' }).kind).toBe('outcome');
    expect(judgmentFromContent('not turtle {{{', { graphIri: 'x', descriptorUrl: 'u' }).kind).toBe('none');
    expect(judgmentFromContent('<urn:a> <urn:p> "no judgment" .', { graphIri: 'x', descriptorUrl: 'u' }).kind).toBe('none');
  });
});

describe('scoring a judgment the bridge did not make', () => {
  let server: Server;
  let url: string;
  const state = { head: 'http://css/u-pk-x/context-graphs/1.ttl', content: asPodContent(verdict), publishes: [] as Array<Record<string, unknown>> };
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        if (body['method'] === 'initialize') { res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: {} })); return; }
        if (body['method'] === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
        const params = body['params'] as { name: string; arguments: Record<string, unknown> };
        let result: unknown = { ok: true };
        if (params.name === 'get_current_head') result = { urn: params.arguments['urn'], head: { descriptorUrl: state.head, cid: 'bafy' } };
        else if (params.name === 'get_descriptor') result = { url: params.arguments['url'], turtle: '', graph: { content: state.content } };
        else if (params.name === 'publish_context') { state.publishes.push(params.arguments); result = { descriptorUrl: 'http://css/u-pk-x/context-graphs/2.ttl', previousHeadCid: 'bafy' }; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }));
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => { server.close(); });

  const harness = () => new Harness({
    jev: new FakeJevClient(() => ({})), repoRoot: mkdtempSync(join(tmpdir(), 'jev-pod-')), base: 'http://localhost:1',
    relay: new RelayClient({ url, bearer: 't', podName: 'u-pk-x' }),
  });

  it('reads the judgment back from the pod, scores it, and publishes the outcome as the next version of its chain', async () => {
    const h = harness();
    const r = await h.recordOutcome({ judgmentIri: verdict.graphIri, humanDecision: 'approved' });
    expect(r.judgment.kind).toBe('outcome');
    expect(r.judgment.agreement).toBe('agree');
    expect(r.judgment.judgmentKind).toBe('review-verdict');
    expect(r.judgment.priorConfidence).toBe(0.8);
    expect(r.publish.status).toBe('published');
    const p = state.publishes[state.publishes.length - 1]!;
    expect(p['graph_iri']).toBe(verdict.graphIri);
    expect(p['if_match']).toBe('http://css/u-pk-x/context-graphs/1.ttl');
    expect(p['modal_status']).toBe('Asserted');
    expect(p['pod_name']).toBe('u-pk-x');
    // The local TriG names the pod descriptor it supersedes, not a URL this bridge never served.
    expect(h.store.artifact(r.judgment.id, 'trig')).toContain('http://css/u-pk-x/context-graphs/1.ttl');
  });

  it('refuses to score a chain whose head is already an outcome, and a graph the pod does not hold', async () => {
    const h = harness();
    state.content = asPodContent(recordOutcome(verdict, { judgmentIri: verdict.graphIri, humanDecision: 'approved' }) as unknown as AnyJudgment);
    await expect(h.recordOutcome({ judgmentIri: verdict.graphIri, humanDecision: 'approved' })).rejects.toMatchObject({ status: 409 });
    state.content = 'not a judgment at all';
    await expect(h.recordOutcome({ judgmentIri: verdict.graphIri, humanDecision: 'approved' })).rejects.toMatchObject({ status: 404 });
    state.content = asPodContent(verdict);
    const noRelay = new Harness({ jev: new FakeJevClient(() => ({})), repoRoot: mkdtempSync(join(tmpdir(), 'jev-pod-')), base: 'http://localhost:1', relay: null });
    await expect(noRelay.recordOutcome({ judgmentIri: verdict.graphIri, humanDecision: 'approved' })).rejects.toBeInstanceOf(HarnessError);
  });
});
