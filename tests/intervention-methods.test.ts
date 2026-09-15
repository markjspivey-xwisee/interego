import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { parseTrig, validateAgainstShape } from '@interego/core';
import { AGP_NS, readOntologyTurtle, readMethodsTurtle, readShapesTurtle, renderTermJsonLd } from '../applications/agentic-performance-practice/src/ontology.js';
import { findInterventionMethod, interventionMethods, loadInterventionMethods, methodologyFor, reviewMethodEvidence } from '../applications/agentic-performance-practice/src/intervention-methods.js';
import { diagnose, recommendInterventions, type PerformanceSituation } from '../applications/agentic-performance-practice/src/performance-architecture.js';
import { attachInterventionMethodRoutes } from '../applications/agentic-performance-practice/bridge/method-routes.js';
import { interventionMethodAffordances } from '../applications/agentic-performance-practice/method-affordances.js';
import { agpAffordances } from '../applications/agentic-performance-practice/affordances.js';
import { foxxiAdminAffordances } from '../applications/foxxi-content-intelligence/affordances.js';

const instruction = () => findInterventionMethod('instruction')!;
const situation: PerformanceSituation = { id: 'urn:test:situation', performer: { id: 'urn:test:performer', kind: 'agent' },
  workContext: 'Handle a work request', competency: 'Triage', observed: 'Uncertain result', frequency: 'frequent',
  criticality: 'moderate', modalStatus: 'Hypothetical', provenance: 'synthetic test observation' };

describe('published consulting and intervention methods', () => {
  it('validates the connected canonical graph with the shipped SHACL engine', () => {
    const report = validateAgainstShape(readMethodsTurtle(), readShapesTurtle(), {});
    expect(report).toMatchObject({ conforms: true, fullyChecked: true });
    expect(report.shapesApplied).toBeGreaterThan(0);
    expect(readFileSync(new URL('../docs/applications/agentic-performance-practice/agp.ttl', import.meta.url), 'utf8')).toBe(readOntologyTurtle());
    expect(readFileSync(new URL('../docs/applications/agentic-performance-practice/agp-shapes.ttl', import.meta.url), 'utf8')).toBe(readShapesTurtle());
    const broken = readMethodsTurtle().replace('agp:entryStep agp:LearnerTaskAnalysisStep ;', '');
    expect(validateAgainstShape(broken, readShapesTurtle(), {}).conforms).toBe(false);
  });
  it('publishes one method per intervention with an explicit consulting lifecycle and revision paths', () => {
    const methods = interventionMethods();
    expect(methods.flatMap(m => m.intervention ? [m.intervention] : []).sort()).toEqual([
      'assessment', 'coaching', 'environmental-fix', 'instruction', 'no-intervention', 'performance-support', 'practice', 'probe', 'reference',
    ]);
    expect(findInterventionMethod('consulting')!.steps).toHaveLength(7);
    expect(findInterventionMethod('consulting')!.steps.at(-1)!.next).toContain(`${AGP_NS}ConsultingContextualize`);
    for (const m of methods) {
      expect(m.criteria.length).toBeGreaterThan(0);
      expect(m.steps.some(s => s['@id'] === m.entryStep)).toBe(true);
      expect(m.steps.at(-1)!.revisits.length).toBeGreaterThan(0);
      expect(m.criteria.every(c => c.workProduct.length > 0 && c.source.length > 0)).toBe(true);
    }
  });
  it('requires objective alignment, assessment validation, runtime evidence and transfer for instruction', () => {
    const criteria = instruction().criteria.map(c => c['@id'].replace(AGP_NS, ''));
    expect(criteria).toEqual(expect.arrayContaining(['ObjectiveAlignment', 'AssessmentContract', 'UsabilityAccess', 'RuntimeRecording', 'PilotRevision', 'TransferSupport', 'EvaluationPlan', 'MaintenancePlan']));
    expect(renderTermJsonLd('InstructionalDesign')).toMatchObject({ '@id': `${AGP_NS}InstructionalDesign` });
  });
  it('reads the intervention mapping from the graph and refuses missing or duplicate links', () => {
    const changed = readMethodsTurtle().replace('agp:interventionToken "instruction"', 'agp:interventionToken "new-kind"');
    expect(loadInterventionMethods(changed).find(m => m.token === 'instruction')!.intervention).toBe('new-kind');
    expect(() => loadInterventionMethods(readMethodsTurtle().replace('agp:profileToken "instruction"', 'agp:profileToken "practice"'))).toThrow(/unique/);
    expect(() => loadInterventionMethods(readMethodsTurtle().replace('agp:entryStep agp:LearnerTaskAnalysisStep ;', 'agp:entryStep agp:MissingStep ;'))).toThrow(/entry step/);
    expect(() => methodologyFor('unknown')).toThrow(/No published/);
  });
  it('does not let a caller mutate the shared method catalogue', () => {
    instruction().criteria.splice(0);
    expect(instruction().criteria.length).toBeGreaterThan(0);
  });
  it.each([
    [undefined, 'classify-first'], ['Evident', 'apply-practice'], ['Knowable', 'gap-analysis'],
    ['Emergent', 'dispositional-read'], ['Turbulent', 'stabilise-first'],
  ] as const)('links methods without changing %s regime routing', (domain, expectedMethod) => {
    const s = { ...situation, ...(domain ? { domain } : {}) };
    const diagnosis = diagnose({ situation: s });
    const plan = recommendInterventions({ situation: s, diagnosis });
    expect(diagnosis.method).toBe(expectedMethod);
    expect(plan.consultingProcess?.token).toBe('consulting');
    expect(plan.paradigm.every(p => p.methodology?.token === p.type)).toBe(true);
    if (domain !== 'Knowable') expect(plan.selected.some(p => p.type === 'instruction')).toBe(false);
    if (!domain) expect(plan.selected).toEqual([]);
  });
});

describe('evidence coverage does not masquerade as verification', () => {
  it('lists missing work and never grants a pass to supplied pointers', () => {
    const empty = reviewMethodEvidence({ method: 'instruction' });
    expect(empty).toMatchObject({ status: 'missing-evidence', coverage: 0, verified: false });
    const rows = instruction().criteria.map(c => ({ criterion: c['@id'], artifact: 'https://evidence.example/review', note: 'Review this artifact against the criterion.' }));
    const partial = reviewMethodEvidence({ method: 'instruction', evidence: rows.slice(0, 1) });
    expect(partial.status).toBe('missing-evidence'); expect(partial.coverage).toBeGreaterThan(0);
    const complete = reviewMethodEvidence({ method: 'instruction', evidence: rows });
    expect(complete).toMatchObject({ status: 'documented-unverified', coverage: 100, verified: false });
    expect(complete.criterionResults.every(c => c.status === 'documented-unverified')).toBe(true);
    expect(complete.criteria.every(c => !('status' in c))).toBe(true);
  });
  it.each([
    { method: 'instruction', verified: true },
    { method: 'instruction', evidence: [{ criterion: `${AGP_NS}AssessmentContract`, artifact: 'javascript:alert(1)', note: 'A test' }] },
    { method: 'instruction', evidence: [{ criterion: `${AGP_NS}UnknownCriterion`, artifact: 'https://example.org', note: 'A test' }] },
    { method: 'instruction', evidence: [{ criterion: `${AGP_NS}AssessmentContract`, artifact: 'https://example.org', note: ' ' }] },
    { method: 'instruction', evidence: [{ criterion: `${AGP_NS}AssessmentContract`, artifact: 'https://example.org', note: 'A test', approved: true }] },
    { method: 'unknown' },
  ])('rejects malformed or caller-approved evidence: %j', input => {
    expect(() => reviewMethodEvidence(input)).toThrow();
  });
  it('does not double-count repeated pointers', () => {
    const row = { criterion: instruction().criteria[0]!['@id'], artifact: 'urn:evidence:test', note: 'Synthetic evidence pointer' };
    expect(reviewMethodEvidence({ method: 'instruction', evidence: [row, row] }).coverage).toBe(reviewMethodEvidence({ method: 'instruction', evidence: [row] }).coverage);
  });
  it('the review shape rejects a claim of verified quality', () => {
    const p = `@prefix agp: <${AGP_NS}> . <urn:review:test> a agp:MethodEvidenceReview ; agp:methodology agp:InstructionalDesign ; agp:reviewStatus "documented-unverified" ; agp:qualityVerified `;
    expect(validateAgainstShape(p + 'false .', readShapesTurtle(), {}).conforms).toBe(true);
    expect(validateAgainstShape(p + 'true .', readShapesTurtle(), {}).conforms).toBe(false);
  });
});

describe('shared native methodology routes', () => {
  let server: Server, base: string;
  beforeAll(async () => {
    const app = express(); app.use(express.json()); server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server address');
    base = `http://127.0.0.1:${address.port}`; attachInterventionMethodRoutes(app, base);
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
  it('both vertical authorities declare the same invocable method controls', () => {
    for (const a of interventionMethodAffordances) {
      expect(agpAffordances).toContainEqual(a); expect(foxxiAdminAffordances).toContainEqual(a);
    }
  });
  it('serves JSON-LD, connected Turtle and HMD with typed controls', async () => {
    const json = await fetch(`${base}/performance/methods?method=instruction`).then(r => r.json());
    expect(json['@graph'][0]).toMatchObject({ token: 'instruction', '@id': `${AGP_NS}InstructionalDesign` });
    const turtle = await fetch(`${base}/performance/methods`, { headers: { Accept: 'text/turtle' } }).then(r => r.text());
    expect(parseTrig(turtle).subjects.length).toBeGreaterThan(50);
    const markdown = await fetch(`${base}/performance/methods?method=instruction&format=markdown`);
    expect(markdown.headers.get('content-type')).toContain('text/markdown');
    const body = await markdown.text();
    expect(body).toContain('Objective-to-practice-to-assessment alignment map');
    expect(body).toContain('review-method-evidence'); expect(body).toContain(`${base}/affordances`);
  });
  it('returns useful missing evidence and rejects forged review fields over HTTP', async () => {
    const post = (body: unknown) => fetch(`${base}/performance/methods/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const valid = await post({ method: 'instruction', evidence: [] });
    expect(valid.status).toBe(200); expect(await valid.json()).toMatchObject({ status: 'missing-evidence', verified: false });
    const bad = await post({ method: 'instruction', verified: true }); expect(bad.status).toBe(400);
    expect((await fetch(`${base}/performance/methods?method=unknown`)).status).toBe(404);
  });
});
