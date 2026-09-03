/**
 * An input a capability ADVERTISES must reach the graph, or be refused.
 *
 * ── ★★ WHY: TWO DECLARED INPUTS THAT WERE ACCEPTED AND DROPPED ───────────────────────────────
 *
 * `agp.actualize` declared `success` and `score_scaled` in its affordance. Neither was read.
 * Driven with `success: true, score_scaled: 0.9`, the handler answered HTTP 200 and published four
 * triples — engages / inSituation / actualizes / yields — and nothing else. A caller that sends an
 * outcome and is told the request succeeded has been told the outcome was recorded.
 *
 * ★★ AND THE FIRST ATTEMPT TO CLOSE IT WAS TO WRITE IT DOWN. The input descriptions were changed
 * to say "ACCEPTED BUT NOT YET RECORDED", which made the published affordance honest and left the
 * caller's data exactly where it was — on the floor. That is the same move as documenting a
 * capability that has no service behind it: the record improves, the defect does not. Same class
 * as advertising an affordance nothing serves, one level down, in an input rather than an action.
 *
 * ── WHAT THIS PINS ──────────────────────────────────────────────────────────────────────────
 *
 * Both values in the published bytes; an omitted value asserting NOTHING rather than a default;
 * and an out-of-range score REFUSED with a refusing status rather than clamped into range, because
 * a clamped score is a measurement nobody took.
 *
 * The network is the only thing doubled — the handler, the publisher, the shapes and the SHACL
 * engine are all real, as in `agp-stage2.test.ts`, whose capture helper this mirrors.
 */
import { describe, it, expect } from 'vitest';
import { validateAgainstShape } from '@interego/core';
import { createAgpHandlers } from '../bridge/handlers.js';
import { AGP } from '../bridge/pod-helpers.js';
import { readShapesTurtle } from '../src/ontology.js';

const POD = 'https://pod.example.test/me/';
const SHAPES = readShapesTurtle();
const IEP_SUCCESS = 'https://markjspivey-xwisee.github.io/interego/ns/iep#success';

interface Captured { url: string; method: string; body: string }

function captureFetch(): { fetchFn: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, body });
    if (method === 'GET' || method === 'HEAD') return new Response('', { status: 404 });
    return new Response('', { status: 201, headers: { location: url } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const graphBodies = (calls: Captured[]): string[] =>
  calls.filter((c) => c.method !== 'GET' && c.body.includes(`a <${AGP}`)).map((c) => c.body);

const BASE_ARGS = {
  situation_iri: 'urn:agp:situation:s1',
  capability_iri: 'urn:agp:capability:c1',
  affordance_iri: 'urn:agp:affordance:a1',
  performance_statement: 'mitigated the cache incident',
  pod_url: POD,
};

async function actualize(extra: Record<string, unknown>): Promise<{
  out: Record<string, unknown>; graph: string | undefined;
}> {
  const { fetchFn, calls } = captureFetch();
  const h = createAgpHandlers({ fetchFn });
  const out = await h['agp.actualize']!({ ...BASE_ARGS, ...extra }) as Record<string, unknown>;
  return { out, graph: graphBodies(calls)[0] };
}

describe('an outcome the affordance accepts reaches the graph', () => {
  it('★ records `success` as iep:success and `score_scaled` as agp:scoreScaled', async () => {
    const { out, graph } = await actualize({ success: true, score_scaled: 0.9 });
    expect(graph, 'the publisher wrote no graph at all').toBeTruthy();
    expect(graph, 'success was accepted and never written').toContain(`<${IEP_SUCCESS}>`);
    expect(graph, 'the boolean was not typed').toContain('"true"^^<http://www.w3.org/2001/XMLSchema#boolean>');
    expect(graph, 'score_scaled was accepted and never written').toContain(`<${AGP}scoreScaled>`);
    expect(graph, 'the score was not typed').toContain('"0.9"^^<http://www.w3.org/2001/XMLSchema#double>');
    expect(out.recordedOutcome, 'the result does not say what it recorded')
      .toEqual({ success: true, scoreScaled: 0.9 });
  });

  it('records a negative score and a false outcome as sent', async () => {
    // The range is [-1,1], not [0,1]: a worsening is a real observation, and `false` must not be
    // confused with "not observed" by either side.
    const { out, graph } = await actualize({ success: false, score_scaled: -0.25 });
    expect(graph).toContain('"false"^^<http://www.w3.org/2001/XMLSchema#boolean>');
    expect(graph).toContain('"-0.25"^^<http://www.w3.org/2001/XMLSchema#double>');
    expect(out.recordedOutcome).toEqual({ success: false, scoreScaled: -0.25 });
  });

  it('★ asserts nothing when nothing was observed', async () => {
    // An unobserved outcome is not a failed one. A serializer that defaulted this would invent a
    // measurement, which is the rule agpEvaluationProperties already follows for `too-early`.
    const { out, graph } = await actualize({});
    expect(graph, 'an unobserved outcome was serialized anyway').not.toContain(`<${IEP_SUCCESS}>`);
    expect(graph).not.toContain(`<${AGP}scoreScaled>`);
    expect(out.recordedOutcome).toBeNull();
  });

  it('records each half independently', async () => {
    const onlyScore = await actualize({ score_scaled: 1 });
    expect(onlyScore.graph).toContain(`<${AGP}scoreScaled>`);
    expect(onlyScore.graph).not.toContain(`<${IEP_SUCCESS}>`);
    expect(onlyScore.out.recordedOutcome).toEqual({ scoreScaled: 1 });

    const onlySuccess = await actualize({ success: true });
    expect(onlySuccess.graph).toContain(`<${IEP_SUCCESS}>`);
    expect(onlySuccess.graph).not.toContain(`<${AGP}scoreScaled>`);
    expect(onlySuccess.out.recordedOutcome).toEqual({ success: true });
  });

  it('still satisfies ActualizationShape with the outcome triples present', async () => {
    const { graph } = await actualize({ success: true, score_scaled: 0.5 });
    const report = validateAgainstShape(graph ?? '', SHAPES, { entailment: 'rdfs' });
    expect(
      report.conforms ? '' : report.results.map((r) => r.message).join(' | '),
    ).toBe('');
  });
});

describe('a score outside the declared range is refused, not clamped', () => {
  for (const bad of [1.5, -3, Number.NaN, Number.POSITIVE_INFINITY, 'high']) {
    it(`refuses score_scaled=${String(bad)} with a refusing status`, async () => {
      const { out, graph } = await actualize({ score_scaled: bad });
      expect(out['iep:refusalStatus'] ?? out.refusalStatus,
        `score_scaled=${String(bad)} did not answer a refusing status`).toBe(400);
      // Nothing may be published on the way to refusing: a partial write would leave an
      // actualization on the pod whose caller was told the call failed.
      expect(graph, 'a refused call published a graph anyway').toBeUndefined();
    });
  }

  it('accepts the exact endpoints, which are in range', async () => {
    for (const edge of [1, -1, 0]) {
      const { out } = await actualize({ score_scaled: edge });
      expect(out['iep:refusalStatus'] ?? out.refusalStatus,
        `score_scaled=${edge} is in range and was refused`).toBeUndefined();
      expect(out.recordedOutcome).toEqual({ scoreScaled: edge });
    }
  });
});
