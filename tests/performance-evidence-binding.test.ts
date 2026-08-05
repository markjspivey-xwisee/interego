/**
 * A recorded performance is bound to evidence that exists, on the READ side.
 *
 * The reviewed defect: `record-performance` took the submitter's word for everything. Six
 * signed submissions citing `task_id`s that had never existed — every one a live 404 —
 * produced `performanceVerifiedCompetencies: 1` at Dreyfus Proficient, Wilson 0.61. The
 * published work shape gated only writes that VOLUNTARILY declared it, and the read path
 * never consulted it, so the answer to "would this FAIL for evidence that should not
 * qualify" was no.
 *
 * Mutating either guard away — dropping the `!r.ok` refusal, or treating an unfetchable
 * shape as "no constraints" — fails a case below.
 */
import { describe, it, expect } from 'vitest';
import { bindPerformanceToEvidence } from '../applications/foxxi-content-intelligence/src/performance-evidence.js';

type Resp = { ok: boolean; status: number; statusText: string; headers: { get(n: string): string | null }; text(): Promise<string>; json(): Promise<unknown> };
const resp = (status: number, body = ''): Resp => ({
  ok: status >= 200 && status < 300, status, statusText: String(status),
  headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? String(body.length) : null) },
  text: async () => body, json: async () => JSON.parse(body || '{}'),
});
const routes = (map: Record<string, Resp>) =>
  (async (url: string) => map[url] ?? resp(404)) as unknown as Parameters<typeof bindPerformanceToEvidence>[0]['fetchFn'];

const WORK = 'https://gate.interego.xwisee.com/u-eth-8f3b8e939600/context-graphs/1785907408816.ttl';
const SHAPE = 'https://relay.interego.xwisee.com/ns/u-eth-9bf50894ff23/wsp-work-shapes';

const WSP = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const SKILL = 'https://relay.interego.xwisee.com/ns/u-eth-9bf50894ff23/wsp-skills#EvidenceIntegrityReview';

const conformingRecord = `@prefix wsp: <${WSP}> .
@prefix iep: <${IEP}> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<https://relay.interego.xwisee.com/ns/u-eth-8f3b8e939600/wsp-evidence-review-work/e/3>
  a wsp:Entry ; dct:conformsTo <${SKILL}> ; dct:description "a review" ;
  iep:success "true"^^xsd:boolean .`;

/** The same record with the outcome removed — the case the work contract exists to refuse. */
const outcomelessRecord = conformingRecord.replace(/;\s*\n\s*iep:success[^.]*\./, '.');

const workShape = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix wsp: <${WSP}> .
@prefix iep: <${IEP}> .
<${SHAPE}#WorkItemShape> a sh:NodeShape ;
  sh:targetClass wsp:Entry ;
  sh:property [ sh:path dct:conformsTo ; sh:minCount 1 ; sh:nodeKind sh:IRI ;
                sh:in ( <${SKILL}> ) ; sh:message "cite one published skill term" ] ;
  sh:property [ sh:path iep:success ; sh:minCount 1 ; sh:datatype xsd:boolean ;
                sh:message "assert exactly one boolean outcome" ] .`;

describe('a claim is bound to evidence that resolves', () => {
  it('refuses a task_id that 404s — the reviewer\'s exact fabrication', async () => {
    const r = await bindPerformanceToEvidence({
      taskId: 'https://gate.interego.xwisee.com/u-pk-63aaca4b0d72/context-graphs/0000000000001.ttl',
      fetchFn: routes({}),
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.detail).toContain('404');
  });

  it('accepts a task_id that resolves, and reports it as resolved-but-unchecked', async () => {
    const r = await bindPerformanceToEvidence({ taskId: WORK, fetchFn: routes({ [WORK]: resp(200, conformingRecord) }) });
    expect(r).toMatchObject({ ok: true, binding: 'resolved' });
    expect(r.shapeIri).toBeUndefined();
  });

  it('records a non-URL task_id as an UNBOUND self-report rather than refusing it', async () => {
    const r = await bindPerformanceToEvidence({ taskId: 'triage the weekend backlog', fetchFn: routes({}) });
    expect(r).toMatchObject({ ok: true, binding: 'unbound' });
  });
});

describe('the work contract runs on the read side, from published data', () => {
  it('passes a record that satisfies the shape its submitter named', async () => {
    const r = await bindPerformanceToEvidence({
      taskId: WORK, evidenceShapeIri: SHAPE,
      fetchFn: routes({ [WORK]: resp(200, conformingRecord), [SHAPE]: resp(200, workShape) }),
    });
    expect(r).toMatchObject({ ok: true, binding: 'shape-validated', shapeIri: SHAPE });
  });

  it('refuses a record that asserts no outcome — 422, carrying the shape\'s own message', async () => {
    const r = await bindPerformanceToEvidence({
      taskId: WORK, evidenceShapeIri: SHAPE,
      fetchFn: routes({ [WORK]: resp(200, outcomelessRecord), [SHAPE]: resp(200, workShape) }),
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
    expect(r.violations?.some(v => v.message.includes('boolean outcome'))).toBe(true);
  });

  it('refuses when the named shape does not resolve, rather than recording it as checked', async () => {
    const r = await bindPerformanceToEvidence({
      taskId: WORK, evidenceShapeIri: SHAPE,
      fetchFn: routes({ [WORK]: resp(200, conformingRecord) }),
    });
    expect(r.ok).toBe(false);
    expect(r.binding).not.toBe('shape-validated');
    expect(r.detail).toContain('404');
  });
});
