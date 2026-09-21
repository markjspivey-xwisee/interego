/**
 * Calibration on the pod: the view as a descriptor, the attestation it grounds, and the
 * service's publish — through a relay faked at the fetch level, so nothing dials out.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Parser } from 'n3';
import { attestationAxes, attestationPayload, calibrationFingerprint, calibrationGraphIri, calibrationPayload, repoSlug } from '../src/calibration-publish.js';
import { contextFromEnv, descriptorTrig, hmdMarkdown, payloadTurtle } from '../src/descriptor.js';
import { recordOutcome, type OutcomeRecord } from '../src/judgments/outcome.js';
import { navigate } from '../src/judgments/navigate.js';
import { RelayClient } from '../src/publish.js';
import { inventory } from '../src/repo.js';
import { Harness } from '../src/service.js';
import { HarnessStore, computeCalibration } from '../src/store.js';
import { fixtureRepo, idOf, preferringJev } from './helpers.js';

const ctx = contextFromEnv('http://localhost:6090');

/** Outcomes shaped like the store's: n navigation live outcomes with the given hits, and review verdicts with agreements. */
function outcomes(spec: { nav?: Array<{ hitAt1: boolean; hitAt3: boolean; brier: number; source?: 'live' | 'backtest'; memory?: number }>; gate?: string[] }): OutcomeRecord[] {
  const base = { kind: 'outcome' as const, createdAt: '2026-09-21T04:00:00.000Z', model: 'jev-fake', confidence: 1, repository: { name: 'fixture', root: '', commit: null }, usage: { requests: 0, input_tokens: 0, output_tokens: 0, latencyMs: 0 }, missed: [], summary: '' };
  const out: OutcomeRecord[] = [];
  (spec.nav ?? []).forEach((n, i) => out.push({ ...base, id: `n${i}`, graphIri: `urn:graph:jev-harness:outcome:n${i}`, judgmentIri: `urn:graph:jev-harness:navigation:j${i}`, judgmentKind: 'navigation', priorConfidence: 0.5, source: n.source ?? 'live', hitAt1: n.hitAt1, hitAt3: n.hitAt3, brier: n.brier, agreement: null, observed: { judgmentIri: `urn:graph:jev-harness:navigation:j${i}` }, ...(n.memory !== undefined ? { priorPrecedentWeight: n.memory } : {}) }));
  (spec.gate ?? []).forEach((a, i) => out.push({ ...base, id: `g${i}`, graphIri: `urn:graph:jev-harness:outcome:g${i}`, judgmentIri: `urn:graph:jev-harness:review-verdict:v${i}`, judgmentKind: 'review-verdict', priorConfidence: 0.8, source: 'live', hitAt1: a === 'agree', hitAt3: null, brier: null, agreement: a, observed: { judgmentIri: `urn:graph:jev-harness:review-verdict:v${i}` } }));
  return out;
}

const parse = (turtle: string) => new Parser().parse(turtle);
const JVH = ctx.ns;
const AMTA = 'https://markjspivey-xwisee.github.io/interego/ns/amta#';

describe('the calibration descriptor', () => {
  const view = computeCalibration(outcomes({ nav: [{ hitAt1: true, hitAt3: true, brier: 0.1, memory: 0.4 }, { hitAt1: false, hitAt3: true, brier: 0.2 }, { hitAt1: false, hitAt3: false, brier: 0.3, source: 'backtest' }], gate: ['agree', 'conservative'] }));

  it('names one graph per repository and fingerprints everything but the clock', () => {
    expect(calibrationGraphIri('Interego (main)')).toBe('urn:graph:jev-harness:calibration:interego-main');
    expect(repoSlug('')).toBe('repository');
    const later = { ...view, computedAt: '2030-01-01T00:00:00.000Z' };
    expect(calibrationFingerprint(later)).toBe(calibrationFingerprint(view));
    expect(calibrationFingerprint({ ...view, minSamples: 9 })).not.toBe(calibrationFingerprint(view));
  });

  it('carries a cell per kind with live counts and agreement, the memory split and the buckets, and parses', () => {
    const turtle = calibrationPayload(view, ctx, 'fixture');
    const quads = parse(turtle);
    const S = 'urn:jev-harness:calibration:fixture';
    const cells = quads.filter((q) => q.subject.value === S && q.predicate.value === `${JVH}cell`);
    expect(cells).toHaveLength(4);
    expect(turtle).toContain('jvh:judgmentKind "navigation" ; jvh:samples "3"^^xsd:integer ; jvh:liveSamples "2"^^xsd:integer ; jvh:cellStatus "Hypothetical"');
    expect(turtle).toContain('jvh:agreementCount [ jvh:agreement "agree" ; jvh:samples "1"^^xsd:integer ]');
    expect(turtle).toContain('jvh:memoryApplied [ jvh:samples "1"^^xsd:integer ; jvh:hitAt1Rate "1"^^xsd:double');
    expect(turtle).toContain('jvh:memoryNone [ jvh:samples "2"^^xsd:integer');
    expect(turtle).toContain('jvh:adviceBucket [ jvh:bucketFrom "0.4"^^xsd:double ; jvh:samples "3"^^xsd:integer');
    expect(turtle).toContain(`hydra:target <http://localhost:6090/jev-harness/calibration>`);
    expect(quads.some((q) => q.subject.value === S && q.predicate.value === 'https://schema.org/text' && q.object.value.includes('| navigation | 3 (2) | Hypothetical |'))).toBe(true);
  });
});

describe('the self-attestation', () => {
  it('is not issued while no cell has reached the floor', () => {
    const thin = computeCalibration(outcomes({ nav: [{ hitAt1: true, hitAt3: true, brier: 0.1 }], gate: ['agree'] }));
    expect(attestationAxes(thin)).toBeUndefined();
    expect(attestationPayload(thin, ctx, 'fixture')).toBeUndefined();
  });

  it('rates each axis from the Asserted cell that supports it, names what it attests to, and grounds itself in the calibration', () => {
    const nav = Array.from({ length: 5 }, (_, i) => ({ hitAt1: i < 2, hitAt3: i < 4, brier: 0.2 }));
    const view = computeCalibration(outcomes({ nav, gate: ['agree', 'agree', 'agree', 'conservative', 'disagree'] }));
    const axes = attestationAxes(view)!;
    expect(axes).toEqual({ competence: 0.8, honesty: 0.8, accuracy: 0.6, samples: 10, kinds: ['navigation', 'review-verdict'] });
    const turtle = attestationPayload(view, ctx, 'fixture', { calibrationDescriptorUrl: 'http://css.railway.internal:3456/u-pk-x/context-graphs/77.ttl', attestedAt: '2026-09-21T05:00:00.000Z' })!;
    const quads = parse(turtle);
    const S = 'urn:jev-harness:attestation:fixture';
    const of = (p: string) => quads.filter((q) => q.subject.value === S && q.predicate.value === `${AMTA}${p}`).map((q) => q.object.value);
    expect(quads.some((q) => q.subject.value === S && q.object.value === `${AMTA}Attestation`)).toBe(true);
    expect(of('attestor')).toEqual([ctx.agentId]);
    expect(of('subject')).toEqual([ctx.agentId]);
    expect(of('direction')).toEqual(['Self']);
    expect(of('competence')).toEqual(['0.8']);
    expect(of('accuracy')).toEqual(['0.6']);
    expect(of('honesty')).toEqual(['0.8']);
    expect(of('relevance')).toEqual([]);
    expect(of('attestsTo').sort()).toEqual(['urn:iep:action:jev-harness:navigate', 'urn:iep:action:jev-harness:review-gate']);
    expect(of('fromExecution')).toEqual(['http://css.railway.internal:3456/u-pk-x/context-graphs/77.ttl']);
    expect(of('attestedAt')).toEqual(['2026-09-21T05:00:00.000Z']);
  });
});

describe('the service publishes the view', () => {
  /** A relay at the fetch level: initialize opens a session, publish_context answers with a descriptor URL. */
  function fakeRelay(): { relay: RelayClient; published: Array<Record<string, unknown>> } {
    const published: Array<Record<string, unknown>> = [];
    let n = 100;
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), { status: 200, headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's1' } });
      if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
      if (body.params?.name === 'publish_context') {
        published.push(body.params.arguments ?? {});
        n += 1;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ descriptorUrl: `http://css.railway.internal:3456/u-pk-x/context-graphs/${n}.ttl` }) }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{}' }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return { relay: new RelayClient({ url: 'http://relay.test/mcp', bearer: 'test-token', podName: 'u-pk-x', fetchImpl }), published };
  }

  it('publishes the calibration under its graph, attests once the floor is reached, and skips an unchanged view unless forced', async () => {
    const root = fixtureRepo();
    const store = new HarnessStore(mkdtempSync(join(tmpdir(), 'jev-calibration-')));
    const jev = preferringJev((q, state) => (q === 'change' ? idOf(state, 'src/rollup.ts') : undefined));
    const { relay, published } = fakeRelay();
    const harness = new Harness({ jev, repoRoot: root, base: 'http://localhost:6090', store, relay, context: ctx });
    const inv = inventory(root, { includeHeads: true });
    const save = (p: Parameters<typeof payloadTurtle>[0]): void => store.save(p, { payloadTurtle: payloadTurtle(p, ctx), descriptorTrig: descriptorTrig(p, ctx), markdown: hmdMarkdown(p, ctx) });

    // One outcome: the view exists but no cell is Asserted, so no attestation.
    const j1 = await navigate(jev, inv, { task: 'rollup emits satisfied once per block' });
    save(j1); save(recordOutcome(j1, { judgmentIri: j1.graphIri, filesChanged: ['src/rollup.ts'] }));
    const first = await harness.publishCalibration();
    expect(first.status).toBe('published');
    expect(first.calibrationUrl).toMatch(/context-graphs\/101\.ttl$/);
    expect(first.attestationUrl).toBeUndefined();
    expect(published[0]).toMatchObject({ graph_iri: calibrationGraphIri(inv.name), modal_status: 'Asserted', pod_name: 'u-pk-x', auto_supersede_prior: true });
    expect(String(published[0]!['graph_content'])).toContain('a jvh:Calibration');

    expect((await harness.publishCalibration()).status).toBe('unchanged');
    expect(published).toHaveLength(1);
    expect((await harness.publishCalibration({ force: true })).status).toBe('published');
    expect(published).toHaveLength(2);

    // Five navigation outcomes: the cell is Asserted, so the attestation follows the calibration.
    for (let i = 0; i < 4; i += 1) {
      const j = await navigate(jev, inv, { task: `rollup emits satisfied ${i} times per block` });
      save(j); save(recordOutcome(j, { judgmentIri: j.graphIri, filesChanged: [i % 2 === 0 ? 'src/rollup.ts' : 'src/course.ts'] }));
    }
    const attested = await harness.publishCalibration();
    expect(attested.status).toBe('published');
    expect(attested.attestationUrl).toBeTruthy();
    const last = published.at(-1)!;
    expect(last['graph_iri']).toBe('urn:graph:jev-harness:attestation:' + repoSlug(inv.name));
    expect(String(last['graph_content'])).toContain('amta:fromExecution <' + attested.calibrationUrl + '>');
    expect(harness.calibrationPublish).toEqual(attested);
  });

  it('is off without a relay', async () => {
    const harness = new Harness({ jev: preferringJev(() => undefined), repoRoot: fixtureRepo(), base: 'http://localhost:6090', store: new HarnessStore(mkdtempSync(join(tmpdir(), 'jev-calibration-'))), relay: null, context: ctx });
    expect(await harness.publishCalibration()).toEqual({ status: 'off' });
  });
});
