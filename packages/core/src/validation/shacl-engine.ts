/**
 * @module validation/shacl-engine
 * @description Minimal in-process SHACL validation engine.
 *
 * A deliberately narrow SHACL implementation used by the publish-path
 * conformance gate (deploy/mcp-relay/server.ts handlePublishContext)
 * and any caller that needs to validate an inbound data graph against
 * a shape graph WITHOUT pulling in a heavy SHACL engine dependency
 * (rdf-validate-shacl etc. — none of which are currently in the repo).
 *
 * Supported constraints (Core SHACL subset):
 *   - sh:targetClass            — bind the shape to every subject of that class
 *   - sh:targetNode             — bind the shape to specific nodes
 *   - sh:property → sh:path     — property-path single predicate
 *   - sh:minCount / sh:maxCount — cardinality
 *   - sh:datatype               — literal datatype check
 *   - sh:nodeKind sh:IRI / sh:Literal / sh:BlankNode / sh:BlankNodeOrIRI
 *   - sh:class                  — value must be a subject with that rdf:type
 *   - sh:in (...)               — value enumeration (parsed as comma list)
 *   - sh:hasValue               — must include the listed value
 *   - sh:pattern                — regex on literal lexical form
 *   - sh:message                — surfaced verbatim on violation
 *
 * NOT supported (intentional — out-of-scope for the kernel gate):
 *   - sh:and / sh:or / sh:not / sh:xone
 *   - Property paths beyond single predicate (inverse, sequence, alternative)
 *   - sh:qualifiedValueShape
 *   - SHACL-SPARQL (sh:sparql)
 *
 * The motivating use case: container-declared `cg:conformsTo <shapeIri>`
 * triples on a Solid pod's manifest. The relay fetches the shape graph,
 * runs validateAgainstShape() against the inbound graph_content, and
 * rejects the publish 422 on non-conformance before the CSS write.
 */
import {
  parseTrig,
  findSubjectsOfType,
  type ParsedDocument,
  type ParsedSubject,
  type ParsedTerm,
} from '../rdf/turtle-parser.js';
import type { IRI } from '../model/types.js';

const SHACL = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' as IRI;
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const SH_NODE_SHAPE = `${SHACL}NodeShape` as IRI;
const SH_PROPERTY_SHAPE = `${SHACL}PropertyShape` as IRI;
const SH_TARGET_CLASS = `${SHACL}targetClass` as IRI;
const SH_TARGET_NODE = `${SHACL}targetNode` as IRI;
const SH_PROPERTY = `${SHACL}property` as IRI;
const SH_PATH = `${SHACL}path` as IRI;
const SH_MIN_COUNT = `${SHACL}minCount` as IRI;
const SH_MAX_COUNT = `${SHACL}maxCount` as IRI;
const SH_DATATYPE = `${SHACL}datatype` as IRI;
const SH_NODE_KIND = `${SHACL}nodeKind` as IRI;
const SH_CLASS = `${SHACL}class` as IRI;
const SH_PATTERN = `${SHACL}pattern` as IRI;
const SH_HAS_VALUE = `${SHACL}hasValue` as IRI;
const SH_MESSAGE = `${SHACL}message` as IRI;
const SH_IN = `${SHACL}in` as IRI;

const SH_IRI = `${SHACL}IRI` as IRI;
const SH_LITERAL = `${SHACL}Literal` as IRI;
const SH_BLANK_NODE = `${SHACL}BlankNode` as IRI;
const SH_BLANK_NODE_OR_IRI = `${SHACL}BlankNodeOrIRI` as IRI;

export type ShaclSeverity = 'Violation' | 'Warning' | 'Info';

export interface ShaclResult {
  readonly focusNode: string;
  readonly path?: string;
  readonly value?: string;
  readonly sourceShape?: string;
  readonly constraintComponent: string;
  readonly severity: ShaclSeverity;
  readonly message: string;
}

export interface ShaclReport {
  readonly conforms: boolean;
  readonly results: readonly ShaclResult[];
}

export interface ValidateAgainstShapeOptions {
  /**
   * RDFS entailment knob — when 'rdfs', the validator treats values
   * whose declared rdf:type is a subclass of the constraint's sh:class
   * as conformant. We don't load external class hierarchies, so the
   * check stays direct-type. Provided for API parity with rdf-validate-
   * shacl.
   */
  readonly entailment?: 'none' | 'rdfs';
}

interface PropertyShape {
  readonly id: string;
  readonly path: IRI;
  readonly minCount?: number;
  readonly maxCount?: number;
  readonly datatype?: IRI;
  readonly nodeKind?: IRI;
  readonly clazz?: IRI;
  readonly pattern?: string;
  readonly hasValue?: ParsedTerm;
  readonly inValues?: readonly ParsedTerm[];
  readonly message?: string;
}

interface NodeShape {
  readonly id: string;
  readonly targetClasses: readonly IRI[];
  readonly targetNodes: readonly IRI[];
  readonly propertyShapes: readonly PropertyShape[];
}

// ── Shape graph compilation ──────────────────────────────────

function asIri(term: ParsedTerm | undefined): IRI | undefined {
  return term?.kind === 'iri' ? term.iri : undefined;
}

function asLiteral(term: ParsedTerm | undefined): string | undefined {
  return term?.kind === 'literal' ? term.value : undefined;
}

function getOne(subj: ParsedSubject, pred: IRI): ParsedTerm | undefined {
  return subj.properties.get(pred)?.[0];
}

function getAll(subj: ParsedSubject, pred: IRI): readonly ParsedTerm[] {
  return subj.properties.get(pred) ?? [];
}

function subjectKey(subj: ParsedSubject): string {
  return typeof subj.subject === 'string' ? subj.subject : `_:${subj.subject.bnode}`;
}

function isShape(subj: ParsedSubject): boolean {
  const types = subj.properties.get(RDF_TYPE) ?? [];
  return types.some(t => t.kind === 'iri' && (t.iri === SH_NODE_SHAPE || t.iri === SH_PROPERTY_SHAPE));
}

function compilePropertyShape(subj: ParsedSubject): PropertyShape | null {
  const path = asIri(getOne(subj, SH_PATH));
  if (!path) return null;
  const minCountLit = asLiteral(getOne(subj, SH_MIN_COUNT));
  const maxCountLit = asLiteral(getOne(subj, SH_MAX_COUNT));
  return {
    id: subjectKey(subj),
    path,
    minCount: minCountLit !== undefined ? parseInt(minCountLit, 10) : undefined,
    maxCount: maxCountLit !== undefined ? parseInt(maxCountLit, 10) : undefined,
    datatype: asIri(getOne(subj, SH_DATATYPE)),
    nodeKind: asIri(getOne(subj, SH_NODE_KIND)),
    clazz: asIri(getOne(subj, SH_CLASS)),
    pattern: asLiteral(getOne(subj, SH_PATTERN)),
    hasValue: getOne(subj, SH_HAS_VALUE),
    inValues: getAll(subj, SH_IN),
    message: asLiteral(getOne(subj, SH_MESSAGE)),
  };
}

function compileShapes(doc: ParsedDocument): readonly NodeShape[] {
  const nodeShapes: NodeShape[] = [];
  const propertyShapesByKey = new Map<string, ParsedSubject>();
  for (const subj of doc.subjects) {
    propertyShapesByKey.set(subjectKey(subj), subj);
  }

  for (const subj of doc.subjects) {
    if (!isShape(subj)) continue;
    const types = (subj.properties.get(RDF_TYPE) ?? []).filter(t => t.kind === 'iri') as { kind: 'iri'; iri: IRI }[];
    const isProperty = types.some(t => t.iri === SH_PROPERTY_SHAPE);
    // A property-shape declared standalone is not a node shape itself.
    if (isProperty && !types.some(t => t.iri === SH_NODE_SHAPE)) continue;

    const targetClasses = getAll(subj, SH_TARGET_CLASS)
      .map(t => asIri(t))
      .filter((x): x is IRI => x !== undefined);
    const targetNodes = getAll(subj, SH_TARGET_NODE)
      .map(t => asIri(t))
      .filter((x): x is IRI => x !== undefined);
    const propertyShapeRefs = getAll(subj, SH_PROPERTY);

    const propertyShapes: PropertyShape[] = [];
    for (const ref of propertyShapeRefs) {
      if (ref.kind === 'iri') {
        const target = propertyShapesByKey.get(ref.iri);
        if (target) {
          const ps = compilePropertyShape(target);
          if (ps) propertyShapes.push(ps);
        }
      } else if (ref.kind === 'bnode') {
        const target = propertyShapesByKey.get(`_:${ref.id}`);
        if (target) {
          const ps = compilePropertyShape(target);
          if (ps) propertyShapes.push(ps);
        }
      }
    }

    nodeShapes.push({
      id: subjectKey(subj),
      targetClasses,
      targetNodes,
      propertyShapes,
    });
  }
  return nodeShapes;
}

// ── Data graph indexing ──────────────────────────────────────

function findFocusNodes(data: ParsedDocument, shape: NodeShape): readonly ParsedSubject[] {
  const matched: ParsedSubject[] = [];
  const seen = new Set<string>();
  for (const cls of shape.targetClasses) {
    for (const s of findSubjectsOfType(data, cls)) {
      const key = subjectKey(s);
      if (!seen.has(key)) {
        seen.add(key);
        matched.push(s);
      }
    }
  }
  for (const node of shape.targetNodes) {
    for (const s of data.subjects) {
      if (typeof s.subject === 'string' && s.subject === node) {
        const key = subjectKey(s);
        if (!seen.has(key)) {
          seen.add(key);
          matched.push(s);
        }
      }
    }
  }
  return matched;
}

function termValue(t: ParsedTerm): string {
  if (t.kind === 'iri') return t.iri;
  if (t.kind === 'literal') return t.value;
  return `_:${t.id}`;
}

function termsEqual(a: ParsedTerm, b: ParsedTerm): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'iri' && b.kind === 'iri') return a.iri === b.iri;
  if (a.kind === 'literal' && b.kind === 'literal') {
    return a.value === b.value && a.datatype === b.datatype && a.language === b.language;
  }
  if (a.kind === 'bnode' && b.kind === 'bnode') return a.id === b.id;
  return false;
}

function matchesNodeKind(t: ParsedTerm, kind: IRI): boolean {
  switch (kind) {
    case SH_IRI: return t.kind === 'iri';
    case SH_LITERAL: return t.kind === 'literal';
    case SH_BLANK_NODE: return t.kind === 'bnode';
    case SH_BLANK_NODE_OR_IRI: return t.kind === 'iri' || t.kind === 'bnode';
    default: return true;
  }
}

function matchesDatatype(t: ParsedTerm, datatype: IRI): boolean {
  if (t.kind !== 'literal') return false;
  if (t.datatype) return t.datatype === datatype;
  // Untyped literals are xsd:string by RDF semantics.
  return datatype === (`${XSD}string` as IRI);
}

function valueHasClass(data: ParsedDocument, valueTerm: ParsedTerm, expectedClass: IRI): boolean {
  // Locate the subject in the data graph whose key matches the value.
  const key = valueTerm.kind === 'iri'
    ? valueTerm.iri
    : valueTerm.kind === 'bnode'
      ? `_:${valueTerm.id}`
      : null;
  if (!key) return false;
  for (const s of data.subjects) {
    if (subjectKey(s) !== key) continue;
    const types = s.properties.get(RDF_TYPE) ?? [];
    for (const t of types) {
      if (t.kind === 'iri' && t.iri === expectedClass) return true;
    }
  }
  return false;
}

// ── Validation ───────────────────────────────────────────────

function evaluatePropertyShape(
  data: ParsedDocument,
  focus: ParsedSubject,
  shape: NodeShape,
  ps: PropertyShape,
): ShaclResult[] {
  const results: ShaclResult[] = [];
  const values = focus.properties.get(ps.path) ?? [];
  const focusNode = subjectKey(focus);

  if (ps.minCount !== undefined && values.length < ps.minCount) {
    results.push({
      focusNode,
      path: ps.path,
      sourceShape: shape.id,
      constraintComponent: `${SHACL}MinCountConstraintComponent`,
      severity: 'Violation',
      message: ps.message ?? `Value count ${values.length} is below sh:minCount ${ps.minCount} for ${ps.path}`,
    });
  }
  if (ps.maxCount !== undefined && values.length > ps.maxCount) {
    results.push({
      focusNode,
      path: ps.path,
      sourceShape: shape.id,
      constraintComponent: `${SHACL}MaxCountConstraintComponent`,
      severity: 'Violation',
      message: ps.message ?? `Value count ${values.length} exceeds sh:maxCount ${ps.maxCount} for ${ps.path}`,
    });
  }

  for (const v of values) {
    if (ps.nodeKind && !matchesNodeKind(v, ps.nodeKind)) {
      results.push({
        focusNode,
        path: ps.path,
        value: termValue(v),
        sourceShape: shape.id,
        constraintComponent: `${SHACL}NodeKindConstraintComponent`,
        severity: 'Violation',
        message: ps.message ?? `Value does not match sh:nodeKind ${ps.nodeKind}`,
      });
    }
    if (ps.datatype && !matchesDatatype(v, ps.datatype)) {
      results.push({
        focusNode,
        path: ps.path,
        value: termValue(v),
        sourceShape: shape.id,
        constraintComponent: `${SHACL}DatatypeConstraintComponent`,
        severity: 'Violation',
        message: ps.message ?? `Value does not match sh:datatype ${ps.datatype}`,
      });
    }
    if (ps.clazz && !valueHasClass(data, v, ps.clazz)) {
      results.push({
        focusNode,
        path: ps.path,
        value: termValue(v),
        sourceShape: shape.id,
        constraintComponent: `${SHACL}ClassConstraintComponent`,
        severity: 'Violation',
        message: ps.message ?? `Value is not an instance of sh:class ${ps.clazz}`,
      });
    }
    if (ps.pattern && v.kind === 'literal') {
      try {
        const re = new RegExp(ps.pattern);
        if (!re.test(v.value)) {
          results.push({
            focusNode,
            path: ps.path,
            value: termValue(v),
            sourceShape: shape.id,
            constraintComponent: `${SHACL}PatternConstraintComponent`,
            severity: 'Violation',
            message: ps.message ?? `Value does not match sh:pattern /${ps.pattern}/`,
          });
        }
      } catch {
        // Malformed regex in shape — skip rather than crash the gate.
      }
    }
    if (ps.inValues && ps.inValues.length > 0) {
      if (!ps.inValues.some(allowed => termsEqual(allowed, v))) {
        results.push({
          focusNode,
          path: ps.path,
          value: termValue(v),
          sourceShape: shape.id,
          constraintComponent: `${SHACL}InConstraintComponent`,
          severity: 'Violation',
          message: ps.message ?? `Value is not in the sh:in enumeration`,
        });
      }
    }
  }

  if (ps.hasValue) {
    const present = values.some(v => termsEqual(v, ps.hasValue!));
    if (!present) {
      results.push({
        focusNode,
        path: ps.path,
        sourceShape: shape.id,
        constraintComponent: `${SHACL}HasValueConstraintComponent`,
        severity: 'Violation',
        message: ps.message ?? `Required sh:hasValue ${termValue(ps.hasValue)} is missing`,
      });
    }
  }

  return results;
}

/**
 * Validate a data graph (Turtle/TriG string) against a SHACL shape graph
 * (Turtle string).
 *
 * Returns a SHACL-style ValidationReport with conforms + results. Bad
 * input (unparseable shape graph) is treated as "no constraints to
 * check" → conforms: true, no results. Bad data is treated as
 * "conforms" only when there are zero matching focus nodes for any
 * shape — that is the correct SHACL semantics (a shape with no targets
 * trivially conforms).
 */
export function validateAgainstShape(
  dataTurtle: string,
  shapeTurtle: string,
  options: ValidateAgainstShapeOptions = {},
): ShaclReport {
  let shapeDoc: ParsedDocument;
  try {
    shapeDoc = parseTrig(shapeTurtle);
  } catch {
    return { conforms: true, results: [] };
  }
  let dataDoc: ParsedDocument;
  try {
    dataDoc = parseTrig(dataTurtle);
  } catch {
    return {
      conforms: false,
      results: [{
        focusNode: '',
        constraintComponent: `${SHACL}DataGraphParseFailure`,
        severity: 'Violation',
        message: 'Data graph is not parseable as Turtle/TriG',
      }],
    };
  }

  // entailment is reserved for parity with rdf-validate-shacl; the
  // direct-type check is what the kernel ships. Mark it used to keep
  // strict-null TS happy.
  void options.entailment;

  const shapes = compileShapes(shapeDoc);
  const results: ShaclResult[] = [];
  for (const shape of shapes) {
    const focusNodes = findFocusNodes(dataDoc, shape);
    for (const focus of focusNodes) {
      for (const ps of shape.propertyShapes) {
        results.push(...evaluatePropertyShape(dataDoc, focus, shape, ps));
      }
    }
  }

  return {
    conforms: results.filter(r => r.severity === 'Violation').length === 0,
    results,
  };
}
