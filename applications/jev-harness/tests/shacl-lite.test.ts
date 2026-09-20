import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseShapes, validate } from '../src/shacl-lite.js';
import { DEFAULT_NS } from '../src/descriptor.js';

const ontology = readFileSync(new URL('../ontology/jev-harness.ttl', import.meta.url), 'utf8');
const shapes = parseShapes(ontology);

describe('shacl-lite over the vertical\'s input shapes', () => {
  it('parses every input shape the affordances declare', () => {
    for (const name of ['NavigateInputShape', 'SelectTestsInputShape', 'TriageInputShape', 'ReviewGateInputShape', 'RecordOutcomeInputShape']) {
      expect(shapes.has(`${DEFAULT_NS}${name}`), name).toBe(true);
    }
  });

  it('accepts a conforming navigate payload and refuses a short task', () => {
    const shape = shapes.get(`${DEFAULT_NS}NavigateInputShape`)!;
    expect(validate(shape, { task: 'fix the cmi5 block rollup' }).conforms).toBe(true);
    const r = validate(shape, { task: 'short', top_k: 40 });
    expect(r.conforms).toBe(false);
    expect(r.violations.map((v) => v.constraint)).toEqual(expect.arrayContaining(['sh:minLength', 'sh:maxInclusive']));
  });

  it('requires task and refuses the wrong datatype', () => {
    const shape = shapes.get(`${DEFAULT_NS}NavigateInputShape`)!;
    expect(validate(shape, {}).violations[0]?.constraint).toBe('sh:minCount');
    expect(validate(shape, { task: 42 }).violations.some((v) => v.constraint === 'sh:datatype')).toBe(true);
  });

  it('enforces sh:or alternatives: select-tests needs changed_files or base_ref', () => {
    const shape = shapes.get(`${DEFAULT_NS}SelectTestsInputShape`)!;
    expect(validate(shape, {}).violations.some((v) => v.constraint === 'sh:or')).toBe(true);
    expect(validate(shape, { changed_files: ['src/a.ts'] }).conforms).toBe(true);
    expect(validate(shape, { base_ref: 'origin/master' }).conforms).toBe(true);
  });

  it('enforces sh:in on human_decision', () => {
    const shape = shapes.get(`${DEFAULT_NS}RecordOutcomeInputShape`)!;
    expect(validate(shape, { judgment_iri: 'urn:graph:jev-harness:review-verdict:x', human_decision: 'maybe' }).violations[0]?.constraint).toBe('sh:in');
    expect(validate(shape, { judgment_iri: 'urn:graph:jev-harness:review-verdict:x', human_decision: 'approved' }).conforms).toBe(true);
  });

  it('refuses a non-object payload', () => {
    const shape = shapes.get(`${DEFAULT_NS}TriageInputShape`)!;
    expect(validate(shape, 'a string').conforms).toBe(false);
  });
});
