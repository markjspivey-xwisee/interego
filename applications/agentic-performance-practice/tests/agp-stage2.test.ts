/**
 * What the agp bridge PUBLISHES must satisfy the shapes the agp bridge SERVES.
 *
 * ★ WHY. Two defects, one mechanism.
 *
 * (1) Six of nine handlers answered `{ pending: 'stage-2', note: '… Publisher +
 *     regime engine arrive in Stage 2, when the performance engine is moved out of
 *     Foxxi …' }`. That move had already shipped — the engine's canonical home is
 *     src/performance-architecture.ts and Foxxi re-exports it via a shim — but the
 *     sentence was a hard-coded literal derived from nothing, so nothing in the repo
 *     could notice its stated precondition had become false. The same 183-line file
 *     called it "Stage 1" in its header, "stage-2" in its payload and "Stage 3" in
 *     its startup log, and the suite stayed green.
 *
 * (2) The reason they could not simply be un-stubbed: `publishAgpArtifact` emitted a
 *     LABEL-ONLY graph (`<iri#graph> a <Type> ; rdfs:label "L" .`) with no parameter
 *     for domain triples, and never passed publish()'s `conformsToShapes` gate. Run
 *     against ontology/agp-shapes.ttl that graph fails SIX of the seven publishable
 *     classes — so agp.diagnose, which was already "REAL", has been writing invalid
 *     agp:Diagnosis nodes to pods. Wiring the stubs to it naively would have replaced
 *     "publishes nothing" with "publishes shape-invalid nodes".
 *
 * The network is the ONLY thing doubled here. The handler, the publisher, the shapes
 * and the SHACL engine are all real, and the capture below happily records an INVALID
 * graph — it can express the failure it exists to catch.
 */
import { describe, it, expect } from 'vitest';
import { validateAgainstShape } from '@interego/core';
import { PublishShapeViolationError } from '@interego/solid';
import { createAgpHandlers } from '../bridge/handlers.js';
import { publishAgpArtifact, AGP } from '../bridge/pod-helpers.js';
import { readShapesTurtle } from '../src/ontology.js';
import type { IRI } from '@interego/core';

const POD = 'https://pod.example.test/me/';
const SHAPES = readShapesTurtle();

interface Captured { url: string; method: string; body: string }

/** Records every write the publisher attempts and answers 201/200, so the bytes
 *  that WOULD have reached a pod can be validated. Never assigned to
 *  globalThis.fetch — vitest shares one realm here and a global patch would break
 *  unrelated pod-touching suites in a full run only. */
function captureFetch(): { fetchFn: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, body });
    if (method === 'GET' || method === 'HEAD') {
      return new Response('', { status: 404 });
    }
    return new Response('', { status: 201, headers: { location: url } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** The Turtle bodies the publisher tried to PUT (as opposed to the JSON-LD
 *  descriptor), identified by the `a <agp:…>` type triple the graph carries. */
const graphBodies = (calls: Captured[]): string[] =>
  calls.filter(c => c.method !== 'GET' && c.body.includes(`a <${AGP}`)).map(c => c.body);

const conformsMsg = (ttl: string): string => {
  const r = validateAgainstShape(ttl, SHAPES, { entailment: 'rdfs' });
  return r.conforms ? '' : r.results.map(x => x.message).join(' | ');
};

describe('agp publishes graphs that satisfy its own SHACL shapes', () => {
  it('agp.actualize publishes a graph that satisfies ActualizationShape', async () => {
    const { fetchFn, calls } = captureFetch();
    const h = createAgpHandlers({ fetchFn });
    const out = await h['agp.actualize']!({
      situation_iri: 'urn:agp:situation:s1', capability_iri: 'urn:agp:capability:c1',
      affordance_iri: 'urn:agp:affordance:a1', performance_statement: 'mitigated the cache incident',
      pod_url: POD,
    }) as Record<string, unknown>;
    expect(out.pending).toBeNull();
    expect(out.performanceIri).toBeTruthy();
    const bodies = graphBodies(calls);
    expect(bodies.length, 'the publisher wrote no graph at all').toBeGreaterThan(0);
    expect(conformsMsg(bodies[0]!)).toBe('');
  });

  it('agp.diagnose publishes a graph that satisfies DiagnosisShape', async () => {
    // The PRE-EXISTING live defect: this handler was already "REAL" and has been
    // publishing label-only, shape-invalid agp:Diagnosis nodes.
    const { fetchFn, calls } = captureFetch();
    const h = createAgpHandlers({ fetchFn });
    const out = await h['agp.diagnose']!({
      situation: {
        id: 'urn:agp:situation:s1', workContext: 'on-call', competency: 'mitigate cache-tier incidents',
        observed: 'escalates instead of mitigating', domain: 'Knowable',
      },
      pod_url: POD,
    }) as Record<string, unknown>;
    expect(out.pending).toBeNull();
    const bodies = graphBodies(calls);
    expect(bodies.length).toBeGreaterThan(0);
    expect(conformsMsg(bodies[0]!)).toBe('');
    expect(bodies[0]).toContain(`${AGP}diagnoses`);
    expect(bodies[0]).toContain(`${AGP}method`);
  });

  it('★ the publisher REFUSES an artifact that omits a shape-required triple', async () => {
    // The gate itself. Without conformsToShapes armed, this write succeeds and the
    // invalid node lands on the pod — which is exactly what has been happening.
    const { fetchFn, calls } = captureFetch();
    await expect(publishAgpArtifact({
      iri: 'urn:agp:actualization:bad' as IRI, typeIri: `${AGP}Actualization`,
      label: 'missing yields', podUrl: POD, slug: 'bad', fetchFn,
      properties: [
        { predicate: `${AGP}engages`, object: { iri: 'urn:agp:capability:c1' } },
        { predicate: `${AGP}inSituation`, object: { iri: 'urn:agp:situation:s1' } },
        { predicate: `${AGP}actualizes`, object: { iri: 'urn:agp:affordance:a1' } },
        // agp:yields deliberately absent.
      ],
    })).rejects.toBeInstanceOf(PublishShapeViolationError);
    expect(graphBodies(calls), 'the invalid graph must never reach the pod').toEqual([]);
  });

  it('★ a caller-supplied IRI cannot inject triples', async () => {
    const { fetchFn, calls } = captureFetch();
    const h = createAgpHandlers({ fetchFn });
    await expect(h['agp.map_affordance']!({
      situation_iri: 'urn:agp:situation:s1',
      affordance_statement: 'mitigate without escalating',
      requires_capability_iri: `urn:x> ; <${AGP}composedOf> <urn:pwn`,
      pod_url: POD,
    })).rejects.toThrow(/unsafe IRI/);
    expect(calls.filter(c => c.method !== 'GET'), 'nothing may be written when serialization is refused').toEqual([]);
  });

  it('contextualize refuses to publish a regime-less situation', async () => {
    // PerformanceSituationShape requires agp:regime minCount 1. With no asserted
    // regime and no evidence the engine returns unclassified, and publishing would
    // emit an invalid node — so it says so instead.
    const { fetchFn, calls } = captureFetch();
    const h = createAgpHandlers({ fetchFn });
    const out = await h['agp.contextualize_situation']!({
      situation_statement: 'on-call engineers cannot mitigate cache-tier incidents',
      pod_url: POD,
    }) as Record<string, unknown>;
    expect(out.persisted).toBe(false);
    expect(out.pending).toBe('no-regime-evidence');
    expect(out.regime).toBeNull();
    expect(graphBodies(calls)).toEqual([]);
  });

  it('contextualize does not honour a caller-asserted regime_source', async () => {
    // 'derived' is reserved for trajectory evidence and is the only provenance
    // permitted to gap-analyse or accrue calibration authority. A caller minting it
    // would be a one-field backdoor into both.
    const { fetchFn } = captureFetch();
    const h = createAgpHandlers({ fetchFn });
    const out = await h['agp.contextualize_situation']!({
      situation_statement: 'x', regime: 'Knowable', regime_source: 'derived', pod_url: POD,
    }) as Record<string, unknown>;
    expect(out.regimeSource).toBe('asserted');
    expect(out.regimeSource).not.toBe('derived');
  });

  it('contextualize publishes a conformant situation once a regime is placed', async () => {
    const { fetchFn, calls } = captureFetch();
    const h = createAgpHandlers({ fetchFn });
    const out = await h['agp.contextualize_situation']!({
      situation_statement: 'on-call engineers cannot mitigate cache-tier incidents',
      regime: 'Knowable', pod_url: POD,
    }) as Record<string, unknown>;
    expect(out.pending).toBeNull();
    const bodies = graphBodies(calls);
    expect(bodies.length).toBeGreaterThan(0);
    expect(conformsMsg(bodies[0]!)).toBe('');
  });

  it('define_capability refuses an empty capability rather than publishing one', async () => {
    const { fetchFn, calls } = captureFetch();
    const h = createAgpHandlers({ fetchFn });
    await expect(h['agp.define_capability']!({ name: 'Incident mitigation', pod_url: POD }))
      .rejects.toThrow(/at least one constituent/);
    expect(graphBodies(calls)).toEqual([]);
  });

  it('evaluate_intervention publishes a graph that satisfies InterventionEvaluationShape', async () => {
    const { fetchFn, calls } = captureFetch();
    const h = createAgpHandlers({ fetchFn });
    const situation = {
      id: 'urn:agp:situation:s1', workContext: 'on-call', competency: 'mitigate cache-tier incidents',
      observed: 'escalates instead of mitigating', domain: 'Knowable',
    };
    const out = await h['agp.evaluate_intervention']!({
      intervention_iri: 'urn:agp:intervention:i1',
      plan: { diagnosis: { situationId: 'urn:agp:situation:s1', regimeSource: 'asserted', method: 'gap-analysis', rootCauses: [], skillDeficiency: true, reasoning: [] }, selected: [{ type: 'instruction', rationale: 'r' }] },
      situation, pod_url: POD,
    }) as Record<string, unknown>;
    expect(out.pending).toBeNull();
    expect(out.verdict).toBeTruthy();
    const bodies = graphBodies(calls);
    expect(bodies.length).toBeGreaterThan(0);
    expect(conformsMsg(bodies[0]!)).toBe('');
  });

  it('no handler answers with a stage label', async () => {
    // The guard that makes the stale-blocker mechanism unrepeatable. A `pending`
    // value must name a real unmet precondition, not a roadmap position, and no
    // note may still claim the engine has yet to move out of Foxxi.
    const h = createAgpHandlers({ fetchFn: captureFetch().fetchFn });
    const inputs: Record<string, Record<string, unknown>> = {
      'agp.contextualize_situation': { situation_statement: 'x', regime: 'Knowable' },
      'agp.define_capability': { name: 'c', skill_iris: ['urn:agp:skill:s'] },
      'agp.map_affordance': { situation_iri: 'urn:agp:situation:s', affordance_statement: 'a', requires_capability_iri: 'urn:agp:capability:c' },
      'agp.actualize': { situation_iri: 'urn:agp:situation:s', capability_iri: 'urn:agp:capability:c', affordance_iri: 'urn:agp:affordance:a', performance_statement: 'p' },
      'agp.diagnose': { situation: { id: 'urn:agp:situation:s', workContext: 'w', competency: 'c', observed: 'o', domain: 'Knowable' } },
      // Evident/apply-practice on purpose: recommendInterventions() dereferences
      // diagnosis.factors! on the Knowable branch, and coerceDiagnosis does not
      // require it. That is a pre-existing engine/coercer gap, not this sweep's
      // subject — the sweep is about the ANSWER SHAPE of every handler.
      'agp.plan_intervention': { diagnosis: { situationId: 'urn:agp:situation:s', domain: 'Evident', regimeSource: 'asserted', method: 'apply-practice', rootCauses: [], skillDeficiency: false, reasoning: [] }, situation: { id: 'urn:agp:situation:s', workContext: 'w', competency: 'c', observed: 'o' } },
      'agp.evaluate_intervention': { intervention_iri: 'urn:agp:intervention:i' },
      // Needs the pod it reads: list_practice stopped being a stub that echoed its inputs
      // and became a real manifest walk, so "which pod" is now a required question rather
      // than a field it could ignore. The sweep is about the ANSWER SHAPE, so it supplies one.
      'agp.list_practice': { pod_url: 'https://pod.example/alice/' },
      'agp.extend_standards': { kind: 'LerTerm', name: 'n', definition: 'd' },
    };
    for (const [tool, args] of Object.entries(inputs)) {
      const out = await h[tool]!(args) as Record<string, unknown>;
      const pending = out.pending == null ? '' : String(out.pending);
      const note = out.note == null ? '' : String(out.note);
      expect(pending, `${tool} answered with a roadmap position instead of a blocker`).not.toMatch(/^stage-\d+$/);
      expect(note, `${tool} still claims the engine has not moved out of Foxxi`).not.toContain('moved out of Foxxi');
    }
  });
});
