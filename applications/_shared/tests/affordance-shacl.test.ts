/**
 * The affordance's input contract as SHACL: derived from the same `inputs` as the MCP tool schema
 * and hydra:expects, so a reader that validates RDF sees the contract the JSON caller sees.
 */
import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { inputShapeTurtle, type AffordanceInput } from '../affordance-mcp/index.js';

const SH = 'http://www.w3.org/ns/shacl#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const inputs: AffordanceInput[] = [
  { name: 'task', type: 'string', required: true, description: 'The task sentence: "what" to change.' },
  { name: 'top_k', type: 'integer', required: false, description: 'Candidates per role.', minimum: 1, maximum: 10 },
  { name: 'kind', type: 'string', required: true, description: 'One of two.', enum: ['evidence-level', 'work-regime'] },
  { name: 'evidence', type: 'array', required: false, description: 'References.', itemType: 'object', minItems: 1 },
  { name: 'tags', type: 'array', required: true, description: 'Tags.', itemType: 'string' },
  { name: 'strict', type: 'boolean', required: false, description: 'Strict mode.' },
  { name: 'weight', type: 'number', required: false, description: 'A weight.', minimum: 0.5 },
];
const turtle = inputShapeTurtle({ shapeIri: 'https://vert.example/ns/vert#JudgeInputShape', label: 'judge input', inputs });
const quads = new Parser().parse(turtle);
const of = (predicate: string) => quads.filter((q) => q.predicate.value === predicate);
const propertyFor = (name: string) => of(`${SH}name`).find((q) => q.object.value === name)!.subject;
const valueOf = (subject: { value: string }, predicate: string) => quads.find((q) => q.subject.value === subject.value && q.predicate.value === predicate)?.object;

describe('the input contract as a node shape', () => {
  it("is one sh:NodeShape with one sh:property per input, paths in the shape's namespace", () => {
    expect(of('http://www.w3.org/1999/02/22-rdf-syntax-ns#type').map((q) => q.object.value)).toEqual([`${SH}NodeShape`]);
    expect(of(`${SH}property`)).toHaveLength(inputs.length);
    expect(valueOf(propertyFor('task'), `${SH}path`)?.value).toBe('https://vert.example/ns/vert#task');
    expect(turtle).toContain('rdfs:label "judge input"');
  });
  it('maps types to datatypes, required to a minCount, scalars to a maxCount, bounds and enums to constraints', () => {
    expect(valueOf(propertyFor('task'), `${SH}datatype`)?.value).toBe(`${XSD}string`);
    expect(valueOf(propertyFor('task'), `${SH}minCount`)?.value).toBe('1');
    expect(valueOf(propertyFor('task'), `${SH}maxCount`)?.value).toBe('1');
    expect(valueOf(propertyFor('top_k'), `${SH}datatype`)?.value).toBe(`${XSD}integer`);
    expect(valueOf(propertyFor('top_k'), `${SH}minCount`)).toBeUndefined();
    expect(valueOf(propertyFor('top_k'), `${SH}minInclusive`)?.value).toBe('1');
    expect(valueOf(propertyFor('top_k'), `${SH}maxInclusive`)?.value).toBe('10');
    expect(valueOf(propertyFor('weight'), `${SH}datatype`)?.value).toBe(`${XSD}double`);
    expect(valueOf(propertyFor('weight'), `${SH}minInclusive`)?.value).toBe('0.5');
    expect(valueOf(propertyFor('strict'), `${SH}datatype`)?.value).toBe(`${XSD}boolean`);
    expect(valueOf(propertyFor('kind'), `${SH}in`)).toBeDefined();
    expect(turtle).toContain('sh:in ( "evidence-level" "work-regime" )');
  });
  it("an array takes its items' datatype, its minItems as minCount, and no maxCount; objects take a node kind", () => {
    expect(valueOf(propertyFor('tags'), `${SH}datatype`)?.value).toBe(`${XSD}string`);
    expect(valueOf(propertyFor('tags'), `${SH}minCount`)?.value).toBe('1');
    expect(valueOf(propertyFor('tags'), `${SH}maxCount`)).toBeUndefined();
    expect(valueOf(propertyFor('evidence'), `${SH}minCount`)?.value).toBe('1');
    expect(valueOf(propertyFor('evidence'), `${SH}nodeKind`)?.value).toBe(`${SH}BlankNodeOrIRI`);
    expect(valueOf(propertyFor('evidence'), `${SH}datatype`)).toBeUndefined();
  });
  it('escapes a description the way Turtle reads it back, and shapes an affordance without inputs as an empty node shape', () => {
    expect(valueOf(propertyFor('task'), `${SH}description`)?.value).toBe('The task sentence: "what" to change.');
    const empty = new Parser().parse(inputShapeTurtle({ shapeIri: 'https://vert.example/x#Shape', inputs: [] }));
    expect(empty.filter((q) => q.predicate.value === `${SH}property`)).toHaveLength(0);
    expect(empty.some((q) => q.object.value === `${SH}NodeShape`)).toBe(true);
  });
  it('takes its paths from a given namespace when the shape IRI is not where the fields live', () => {
    const t = inputShapeTurtle({ shapeIri: 'https://bridge.example/affordances/x/input#Shape', pathNs: 'https://vert.example/ns/vert#', inputs: inputs.slice(0, 1) });
    expect(t).toContain('sh:path <https://vert.example/ns/vert#task>');
  });
});
