/**
 * The phone-roleplay xAPI profile, as the Foxxi validator reads it.
 *
 * The published document is Turtle (ADL xAPI Profiles). `validateAgainstSuppliedProfile`
 * wants the JSON shape: templates with determining properties and rules, and patterns
 * with one operator each. This reads the snapshot checked in beside this package
 * (the v3 document at the relay) and does not fetch it.
 */
import { readFileSync } from 'node:fs';
import { parseTrig, type ParsedDocument, type ParsedTerm } from '@interego/core';

export const PHONE_ROLEPLAY_PROFILE = 'https://relay.interego.xwisee.com/ns/u-pk-0d4144c0c851/phone-roleplay-xapi';
export const PHONE_ROLEPLAY_V3 = `${PHONE_ROLEPLAY_PROFILE}/v/3`;

const PROFILE_NS = 'https://w3id.org/xapi/profiles/ontology#';
const XAPI = 'https://w3id.org/xapi/ontology#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

const SNAPSHOT = new URL('../profile/phone-roleplay-xapi.ttl', import.meta.url);

type Props = ReadonlyMap<string, readonly ParsedTerm[]>;
type Graph = Map<string, Props>;

const subjectId = (subject: ParsedDocument['subjects'][number]['subject']): string =>
  typeof subject === 'string' ? subject : `_:${subject.bnode}`;

const nodeId = (term: ParsedTerm): string | null =>
  term.kind === 'iri' ? term.iri : term.kind === 'bnode' ? `_:${term.id}` : null;

function index(doc: ParsedDocument): Graph {
  const graph: Graph = new Map();
  for (const subject of doc.subjects) graph.set(subjectId(subject.subject), subject.properties);
  return graph;
}

const first = (props: Props | undefined, predicate: string): ParsedTerm | undefined => props?.get(predicate)?.[0];

function asList(graph: Graph, head: ParsedTerm): ParsedTerm[] {
  const out: ParsedTerm[] = [];
  let cursor: ParsedTerm | undefined = head;
  const seen = new Set<string>();
  while (cursor) {
    const id = nodeId(cursor);
    if (!id || id === RDF_NIL || seen.has(id)) break;
    seen.add(id);
    const props = graph.get(id);
    const item = first(props, RDF_FIRST);
    if (!item) break;
    out.push(item);
    cursor = first(props, RDF_REST);
  }
  return out;
}

/** One predicate's objects, expanding an RDF list when that is what was written. */
function objects(graph: Graph, terms: readonly ParsedTerm[]): ParsedTerm[] {
  if (terms.length === 1 && terms[0]?.kind === 'bnode' && graph.get(`_:${terms[0].id}`)?.has(RDF_FIRST)) {
    return asList(graph, terms[0]);
  }
  return [...terms];
}

function scalar(term: ParsedTerm): string | boolean | null {
  if (term.kind === 'iri') return term.iri;
  if (term.kind !== 'literal') return null;
  if (term.datatype === XSD_BOOLEAN) return term.value === 'true';
  return term.value;
}

function scalars(graph: Graph, props: Props | undefined, predicate: string): Array<string | boolean> {
  const terms = props?.get(predicate);
  if (!terms?.length) return [];
  return objects(graph, terms).flatMap((term) => {
    const value = scalar(term);
    return value === null ? [] : [value];
  });
}

function strings(graph: Graph, props: Props | undefined, predicate: string): string[] {
  return scalars(graph, props, predicate).filter((value): value is string => typeof value === 'string');
}

function ruleOf(graph: Graph, id: string): Record<string, unknown> | null {
  const props = graph.get(id);
  const location = strings(graph, props, `${PROFILE_NS}location`)[0];
  if (!location) return null;
  const rule: Record<string, unknown> = { location };
  const presence = strings(graph, props, `${PROFILE_NS}presence`)[0];
  if (presence) rule['presence'] = presence;
  for (const key of ['any', 'all', 'none'] as const) {
    const values = scalars(graph, props, `${PROFILE_NS}${key}`);
    if (values.length) rule[key] = values;
  }
  return rule;
}

function rules(graph: Graph, props: Props | undefined): Record<string, unknown>[] {
  const terms = props?.get(`${PROFILE_NS}rules`) ?? [];
  return objects(graph, terms).flatMap((term) => {
    const id = nodeId(term);
    const rule = id ? ruleOf(graph, id) : null;
    return rule ? [rule] : [];
  });
}

const DETERMINING = [
  'objectActivityType',
  'contextGroupingActivityType',
  'contextParentActivityType',
  'contextOtherActivityType',
  'contextCategoryActivityType',
  'attachmentUsageType',
] as const;

const OPERATORS = ['sequence', 'alternates', 'optional', 'oneOrMore', 'zeroOrMore'] as const;

/** JSON profile document for `validateAgainstSuppliedProfile` and the pattern checker. */
export function profileJsonFromTurtle(turtle: string): Record<string, unknown> {
  const graph = index(parseTrig(turtle));
  const templates: Record<string, unknown>[] = [];
  const patterns: Record<string, unknown>[] = [];
  const concepts: Record<string, unknown>[] = [];
  for (const [id, props] of graph) {
    const types = strings(graph, props, RDF_TYPE);
    if (types.includes(`${PROFILE_NS}StatementTemplate`)) {
      const template: Record<string, unknown> = { id, rules: rules(graph, props) };
      const verb = strings(graph, props, `${PROFILE_NS}verb`)[0];
      if (verb) template['verb'] = verb;
      for (const key of DETERMINING) {
        const values = strings(graph, props, `${PROFILE_NS}${key}`);
        if (values.length === 1) template[key] = values[0];
        else if (values.length > 1) template[key] = values;
      }
      templates.push(template);
    } else if (types.includes(`${PROFILE_NS}Pattern`)) {
      const used = OPERATORS.filter((operator) => (props.get(`${PROFILE_NS}${operator}`) ?? []).length > 0);
      if (used.length !== 1) continue;
      const operator = used[0]!;
      const values = strings(graph, props, `${PROFILE_NS}${operator}`);
      const primary = scalars(graph, props, `${PROFILE_NS}primary`).includes(true);
      patterns.push({
        id,
        primary,
        [operator]: operator === 'sequence' || operator === 'alternates' ? values : values[0],
      });
    } else if (types.includes(`${XAPI}Verb`)) {
      concepts.push({ id, type: 'Verb' });
    }
  }
  return { id: PHONE_ROLEPLAY_PROFILE, templates, patterns, concepts };
}

let cached: Record<string, unknown> | undefined;

/** The checked-in v3 profile document, parsed once. */
export function phoneRoleplayProfile(): Record<string, unknown> {
  if (!cached) cached = profileJsonFromTurtle(readFileSync(SNAPSHOT, 'utf8'));
  return cached;
}
