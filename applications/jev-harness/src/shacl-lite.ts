/**
 * SHACL-lite: the subset of SHACL Core the harness's input shapes use, evaluated against a
 * JSON payload (not an RDF graph). A JSON key matches a property shape whose sh:path local
 * name equals the key. Supported: sh:minCount, sh:maxCount, sh:datatype (xsd:string /
 * integer / double / decimal / boolean), sh:minLength, sh:maxLength, sh:minInclusive,
 * sh:maxInclusive, sh:in, and sh:or over property-shape alternatives.
 *
 * The bridge validates every request with it BEFORE any model call and refuses with the same
 * 422 { error: 'shape_violation', shape, violations } envelope the relay's publish gate uses;
 * the follower validates BEFORE it posts, so a malformed call never leaves the client. Both
 * read the same shapes document (the vertical's ontology), so there is one contract.
 */

import { Parser, Store, DataFactory, type Quad, type Term } from 'n3';

const SH = 'http://www.w3.org/ns/shacl#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

export interface PropertyConstraint {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly minCount?: number;
  readonly maxCount?: number;
  readonly datatype?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minInclusive?: number;
  readonly maxInclusive?: number;
  readonly in?: readonly string[];
}

export interface NodeShape {
  readonly iri: string;
  readonly label?: string;
  readonly properties: readonly PropertyConstraint[];
  /** sh:or alternatives, each a list of property constraints that must all hold. */
  readonly or: readonly (readonly PropertyConstraint[])[];
}

export interface Violation {
  readonly path: string;
  readonly constraint: string;
  readonly message: string;
}

export interface ValidationReport {
  readonly conforms: boolean;
  readonly shape: string;
  readonly violations: readonly Violation[];
}

export function localName(iri: string): string {
  const hash = iri.lastIndexOf('#');
  const slash = iri.lastIndexOf('/');
  return iri.slice(Math.max(hash, slash) + 1);
}

/** Parse every sh:NodeShape in a Turtle document. */
export function parseShapes(turtle: string, baseIri?: string): Map<string, NodeShape> {
  const store = new Store();
  const parser = baseIri ? new Parser({ baseIRI: baseIri }) : new Parser();
  store.addQuads(parser.parse(turtle));
  const shapes = new Map<string, NodeShape>();
  const nodeShapeType = DataFactory.namedNode(`${SH}NodeShape`);
  for (const q of store.getQuads(null, DataFactory.namedNode(`${RDF}type`), nodeShapeType, null)) {
    const subject = q.subject;
    if (subject.termType !== 'NamedNode') continue;
    const label = firstLiteral(store, subject, `${RDFS}label`);
    const properties = propertyShapes(store, subject);
    const or: PropertyConstraint[][] = [];
    for (const orQuad of store.getQuads(subject, DataFactory.namedNode(`${SH}or`), null, null)) {
      for (const alt of listItems(store, orQuad.object)) {
        or.push(propertyShapes(store, alt));
      }
    }
    shapes.set(subject.value, { iri: subject.value, ...(label ? { label } : {}), properties, or });
  }
  return shapes;
}

function propertyShapes(store: Store, subject: Term): PropertyConstraint[] {
  const out: PropertyConstraint[] = [];
  for (const pq of store.getQuads(subject, DataFactory.namedNode(`${SH}property`), null, null)) {
    const p = pq.object;
    const path = firstIri(store, p, `${SH}path`);
    if (!path) continue;
    const c: Record<string, unknown> = { path, name: firstLiteral(store, p, `${SH}name`) ?? localName(path) };
    const desc = firstLiteral(store, p, `${SH}description`);
    if (desc) c['description'] = desc;
    const num = (pred: string): number | undefined => {
      const v = firstLiteral(store, p, `${SH}${pred}`);
      return v === undefined ? undefined : Number(v);
    };
    const minCount = num('minCount'); if (minCount !== undefined) c['minCount'] = minCount;
    const maxCount = num('maxCount'); if (maxCount !== undefined) c['maxCount'] = maxCount;
    const minLength = num('minLength'); if (minLength !== undefined) c['minLength'] = minLength;
    const maxLength = num('maxLength'); if (maxLength !== undefined) c['maxLength'] = maxLength;
    const minInclusive = num('minInclusive'); if (minInclusive !== undefined) c['minInclusive'] = minInclusive;
    const maxInclusive = num('maxInclusive'); if (maxInclusive !== undefined) c['maxInclusive'] = maxInclusive;
    const datatype = firstIri(store, p, `${SH}datatype`); if (datatype) c['datatype'] = datatype;
    const inList = store.getQuads(p, DataFactory.namedNode(`${SH}in`), null, null)[0];
    if (inList) c['in'] = listItems(store, inList.object).map((t) => t.value);
    out.push(c as unknown as PropertyConstraint);
  }
  return out;
}

function listItems(store: Store, head: Term): Term[] {
  const items: Term[] = [];
  let node: Term = head;
  const nil = `${RDF}nil`;
  for (let guard = 0; guard < 1000 && node.value !== nil; guard += 1) {
    const first = store.getQuads(node, DataFactory.namedNode(`${RDF}first`), null, null)[0];
    if (!first) break;
    items.push(first.object);
    const rest = store.getQuads(node, DataFactory.namedNode(`${RDF}rest`), null, null)[0];
    if (!rest) break;
    node = rest.object;
  }
  return items;
}

function firstLiteral(store: Store, s: Term, predicate: string): string | undefined {
  const q: Quad | undefined = store.getQuads(s, DataFactory.namedNode(predicate), null, null)[0];
  return q && q.object.termType === 'Literal' ? q.object.value : undefined;
}

function firstIri(store: Store, s: Term, predicate: string): string | undefined {
  const q: Quad | undefined = store.getQuads(s, DataFactory.namedNode(predicate), null, null)[0];
  return q && q.object.termType === 'NamedNode' ? q.object.value : undefined;
}

/** Validate a JSON object against a node shape. */
export function validate(shape: NodeShape, payload: unknown): ValidationReport {
  const violations: Violation[] = [];
  const obj = (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}) as Record<string, unknown>;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    violations.push({ path: '', constraint: 'sh:NodeShape', message: 'payload must be a JSON object' });
  }
  for (const c of shape.properties) violations.push(...checkProperty(c, obj));
  if (shape.or.length > 0) {
    const satisfied = shape.or.some((alt) => alt.every((c) => checkProperty(c, obj).length === 0));
    if (!satisfied) {
      const names = shape.or.map((alt) => alt.map((c) => c.name).join(' + ')).join(' or ');
      violations.push({ path: '', constraint: 'sh:or', message: `one of these must be present: ${names}` });
    }
  }
  return { conforms: violations.length === 0, shape: shape.iri, violations };
}

function checkProperty(c: PropertyConstraint, obj: Record<string, unknown>): Violation[] {
  const key = c.name && Object.prototype.hasOwnProperty.call(obj, c.name) ? c.name : localName(c.path);
  const raw = obj[key];
  const values: unknown[] = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  const out: Violation[] = [];
  const v = (constraint: string, message: string): void => { out.push({ path: key, constraint, message }); };
  if (c.minCount !== undefined && values.length < c.minCount) v('sh:minCount', `${key} is required (minCount ${c.minCount})`);
  if (c.maxCount !== undefined && values.length > c.maxCount) v('sh:maxCount', `${key} allows at most ${c.maxCount} value(s)`);
  for (const value of values) {
    if (c.datatype) {
      const ok = datatypeOk(c.datatype, value);
      if (!ok) { v('sh:datatype', `${key} must be ${localName(c.datatype)}`); continue; }
    }
    if (typeof value === 'string') {
      if (c.minLength !== undefined && value.length < c.minLength) v('sh:minLength', `${key} must be at least ${c.minLength} characters`);
      if (c.maxLength !== undefined && value.length > c.maxLength) v('sh:maxLength', `${key} must be at most ${c.maxLength} characters`);
    }
    if (typeof value === 'number') {
      if (c.minInclusive !== undefined && value < c.minInclusive) v('sh:minInclusive', `${key} must be >= ${c.minInclusive}`);
      if (c.maxInclusive !== undefined && value > c.maxInclusive) v('sh:maxInclusive', `${key} must be <= ${c.maxInclusive}`);
    }
    if (c.in && !c.in.includes(String(value))) v('sh:in', `${key} must be one of ${c.in.join(', ')}`);
  }
  return out;
}

function datatypeOk(datatype: string, value: unknown): boolean {
  switch (datatype) {
    case `${XSD}string`: return typeof value === 'string';
    case `${XSD}integer`: return typeof value === 'number' && Number.isInteger(value);
    case `${XSD}double`:
    case `${XSD}decimal`:
    case `${XSD}float`: return typeof value === 'number' && Number.isFinite(value);
    case `${XSD}boolean`: return typeof value === 'boolean';
    default: return true;
  }
}

/** The 422 envelope the bridge answers with, shaped like the relay's publish gate. */
export function shapeViolationEnvelope(report: ValidationReport): { error: 'shape_violation'; code: 422; shape: string; violations: readonly Violation[] } {
  return { error: 'shape_violation', code: 422, shape: report.shape, violations: report.violations };
}
