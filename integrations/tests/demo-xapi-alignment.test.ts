import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Parser, Store, DataFactory } from 'n3';
import { demoExperienceRdf } from '../../examples/xapi-record-rdf.js';

const { namedNode: nn } = DataFactory;
const XAPI = 'https://foxxi-bridge.interego.xwisee.com/ns/xapi#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
function execute(code: string, values: Record<string, unknown>) {
  return runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, values);
}
function verify(graph: string, count: number) {
  const store = new Store(new Parser().parse(graph));
  const records = store.getSubjects(nn(RDF + 'type'), nn(XAPI + 'Statement'), null);
  expect(records).toHaveLength(count);
  expect([...store].some(q => q.predicate.value.includes('ontology#result/'))).toBe(false);
  expect(store.countQuads(null, nn(RDF + 'type'), nn('https://w3id.org/xapi/ontology#Statement'), null)).toBe(0);
  for (const record of records) {
    const original = store.getObjects(record, nn('https://schema.org/about'), null)[0]!;
    expect(original.value).not.toBe(record.value);
    expect(store.countQuads(original, nn(RDF + 'type'), nn(XAPI + 'Statement'), null)).toBe(0);
    const result = store.getObjects(record, nn(XAPI + 'result'), null)[0]!;
    const score = store.getObjects(result, nn(XAPI + 'score'), null)[0]!;
    expect(score.termType).toBe('BlankNode');
    expect(store.countQuads(score, nn(XAPI + 'raw'), null, null)).toBe(1);
    expect(store.countQuads(result, nn(XAPI + 'duration'), null, null)).toBe(1);
    const source = store.getObjects(record, nn('http://www.w3.org/ns/prov#wasDerivedFrom'), null)[0]!;
    expect(source.value).not.toBe(original.value);
    const payload = JSON.parse(store.getObjects(source, nn(RDF + 'value'), null)[0]!.value);
    expect(payload.legacyIri).toBe(original.value);
    expect(payload.experience.score).toBe(Number(store.getObjects(score, nn(XAPI + 'raw'), null)[0]!.value));
  }
  return store;
}
describe('actual legacy demo producers', () => {
  it('runs the actual browser producer function with its original fixture shape', () => {
    const source = readFileSync(new URL('../../examples/pgsl-browser/server.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('function xapiToRdf('), source.indexOf('\ninterface DemoState'));
    const fixture = { verb: 'completed', activity: 'test-activity', activityName: 'Synthetic test', score: 92, success: true, duration: 'PT45M', timestamp: '2026-03-15T14:30:00Z' };
    const values = { demoExperienceRdf, LEARNER_INFO: { fixture: { did: 'urn:fixture:actor' } }, fixture };
    const graph = execute(body + '\nxapiToRdf("fixture", [fixture]);', values) as string;
    verify(graph, 1);
    expect(execute(body + '\nxapiToRdf("fixture", [fixture]);', values)).toBe(graph);
  });
  it('runs the actual TLA producer expression and preserves the legacy registration as source data', () => {
    const source = readFileSync(new URL('../../examples/multi-agent/tla-demo.ts', import.meta.url), 'utf8');
    const start = source.indexOf('  const experiences = '), end = source.indexOf("\n  log('LRS', '5 xAPI statements received:", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const graph = execute(source.slice(start, end) + '\nxapiGraph;', { demoExperienceRdf }) as string;
    const store = verify(graph, 5);
    expect(store.countQuads(null, nn(XAPI + 'registration'), null, null)).toBe(0);
    expect(store.getObjects(null, nn(RDF + 'value'), null).some(value => JSON.parse(value.value).experience.context.registration === 'urn:reg:chen-ils-2026-03')).toBe(true);
  });
  it('refuses malformed values and IRIs rather than serializing injected triples', () => {
    const fixture = { verb: 'completed', activity: 'test', activityName: 'Synthetic', score: NaN, success: true, duration: 'PT1M', timestamp: '2026-03-15T14:30:00Z' };
    expect(() => demoExperienceRdf('urn:test', 'urn:actor', fixture)).toThrow();
    expect(() => demoExperienceRdf('urn:test> . <urn:inject', 'urn:actor', { ...fixture, score: 1 })).toThrow();
    for (const unsafe of ['|', '^', '`', '\\', '\u0000']) {
      expect(() => demoExperienceRdf('urn:test', 'urn:actor' + unsafe, { ...fixture, score: 1 })).toThrow();
    }
  });
});
