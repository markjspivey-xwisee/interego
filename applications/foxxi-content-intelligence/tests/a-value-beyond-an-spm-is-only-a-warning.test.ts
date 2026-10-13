/**
 * A SCORM value beyond its smallest permitted maximum (SPM) is a warning; a value of the wrong type,
 * or a second value, is still a violation.
 *
 * ★ WHY. An SPM is the length every LMS must accept: a longer value is allowed, only not portable, so
 * the shapes report it as sh:Warning. The severity was put on the property shape that also carried
 * the element's datatype and its maxCount — and SHACL applies a shape's severity to every constraint
 * it has, so `suspendData 42` and two suspend data values were reported as warnings too, and passed
 * any reader that allows warnings. The SPM is a property shape of its own now.
 */
import { describe, it, expect } from 'vitest';
import { validateAgainstShape as shacl } from '@interego/core';
import { renderShacl, shapesIri, ns } from '../src/spec-ontology.js';
import { SCORM_RTE_MODEL } from '../src/spec/scorm-rte.model.js';
import { validateInstance } from '../src/spec/index.js';

const R = ns(SCORM_RTE_MODEL);
const SHAPES = `${shapesIri(SCORM_RTE_MODEL)}#`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const turtle = (values: string): string => `<https://example.org/attempt> a <${R}DataModel> ; <${R}suspendData> ${values} .`;
const bySeverity = (r: { results: ReadonlyArray<{ severity: string; sourceShape?: string }> }) => ({
  violations: [...new Set(r.results.filter(x => x.severity === 'Violation').map(x => x.sourceShape))].sort(),
  warnings: [...new Set(r.results.filter(x => x.severity === 'Warning').map(x => x.sourceShape))].sort(),
});
const long = 'x'.repeat(64001);

describe('cmi.suspend_data, in RDF', () => {
  const shapes = renderShacl(SCORM_RTE_MODEL);
  it('a value beyond its SPM is a warning, from its own property shape', () => {
    expect(bySeverity(shacl(turtle(JSON.stringify(long)), shapes))).toEqual({ violations: [], warnings: [`${SHAPES}DataModelShape-suspendData-SPM`] });
  });
  it('a number is a violation of the element\'s datatype, not a warning', () => {
    expect(bySeverity(shacl(turtle(`"42"^^<${XSD}integer>`), shapes))).toEqual({ violations: [`${SHAPES}DataModelShape-suspendData`], warnings: [] });
  });
  it('two values are a violation of its maxCount, not a warning', () => {
    expect(bySeverity(shacl(turtle('"a", "b"'), shapes))).toEqual({ violations: [`${SHAPES}DataModelShape-suspendData`], warnings: [] });
  });
});

describe('cmi.suspend_data, in JSON', () => {
  const v = (suspendData: unknown) => bySeverity(validateInstance('scorm-rte', { type: 'DataModel', suspendData } as Record<string, unknown>)!);
  it('reports the same: a long value warns, a number violates', () => {
    expect(v(long)).toEqual({ violations: [], warnings: [`${SHAPES}DataModelShape-suspendData-SPM`] });
    expect(v(42)).toEqual({ violations: [`${SHAPES}DataModelShape-suspendData`], warnings: [] });
    expect(v(['a', 'b'])).toEqual({ violations: [`${SHAPES}DataModelShape-suspendData`], warnings: [] });
  });
});
