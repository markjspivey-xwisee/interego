/**
 * ns/model-context.ts — the JSON-LD context that gives a Foxxi document's JSON instances their RDF
 * reading, generated from the document's model.
 *
 * ★ WHY. A shapes graph constrains RDF, and its shapes select nodes by class (sh:targetClass). For
 * eight of the documents — SCORM CAM, SN and RTE, cmi5, the AI e-learning profile, SOC 2, the EU AI
 * Act and the NIST AI RMF — nothing read their instances into RDF: the validator checked the JSON
 * forms (POST /ns/<module>/validate), and a SHACL processor given the shapes had nothing to select.
 * A review counted 62 node shapes across those eight graphs that selected nothing in any published
 * reading. Each now publishes the context its JSON instances are read through, at
 * /ns/<module>/context, versioned and archived like the document it reads into. A model says that
 * its instances are read so (generatedContext), and the document cites the context (rdfs:seeAlso).
 *
 * ★ GENERATED FROM THE MODEL, SO IT NAMES WHAT THE SHAPES CONSTRAIN:
 *  - a class by its name: the value of `@type`, or of `type` where the module has no property by
 *    that name (SCORM's resource `type` is a property, so a resource is typed with `@type`);
 *  - a property by its name, or by the JSON key a shape reads it from where the two differ (SCORM's
 *    `<title>` is read into titleText). Where one key names different properties on different
 *    kinds of node (cmi5's entitlementKey, of an AU and of launch data), the kind's own term carries
 *    a type-scoped context;
 *  - an object property's value as a node: an IRI, or — where its range is a class whose instances
 *    are the concepts of one of the document's code lists — the concept a token names (the SOC 2
 *    criterion "CC6.2", the NIST function "GOVERN"), through a scoped @vocab; or, where its range is
 *    a class of another Foxxi document that has a context of its own, read through that context;
 *  - a datatype property's value as a literal of its range where JSON writes it as a string (a
 *    dateTime, a date, a time, an anyURI, a language tag), and of an integer range where the shapes
 *    ask for that integer type. A JSON number otherwise keeps the type JSON-LD gives it (an integer
 *    or a double), which the numeric ranges and shapes admit;
 *  - a language-tagged string as the module's JSON writes one: a language map, or a list of
 *    {lang, text} objects (cmi5's course structure, after its XML).
 *
 * A deprecated property keeps its term where no current one is read from its name (SOC 2's actor), so
 * data written before it was replaced still has a reading. A key the model does not name has no term,
 * so a JSON-LD processor in safe mode refuses an instance that carries one, as the shapes would not
 * know what it means.
 */
import {
  type OntologyModel, type OntProperty, type OntShape, contextIri, ns, expandAbs, slugLocal, jsonKeysOf,
} from '../spec-ontology.js';
import { XAPI_MODEL, XAPI_CONTEXT_URL } from '../spec/xapi.model.js';

/** Where a module's context is published (without a version; its version IRI is `<this>/<version>`). */
export const modelContextIri = contextIri;
/** The URL a document's instances cite: the context at the document's version. */
export const modelContextUrl = (m: OntologyModel): string => `${modelContextIri(m)}/${m.version}`;

/** The contexts of other Foxxi documents' classes: a value whose range is one of them is read
 *  through that document's context — cmi5's contextTemplate is an xAPI Context, a session's learner
 *  an xAPI Agent, so each is written as xAPI writes it. */
export const OTHER_CONTEXTS: Readonly<Record<string, string>> = Object.fromEntries(
  XAPI_MODEL.classes.map(c => [`${ns(XAPI_MODEL)}${c.name}`, XAPI_CONTEXT_URL]),
);

/** The JSON keys whose values a document's context reads through another document's context (cmi5's
 *  contextTemplate, an xAPI Context): what is inside them is that document's terms, not this one's,
 *  so this document's shapes select nothing there. Empty for a document with no generated context. */
export function foreignContextKeys(m: OntologyModel, otherContexts: Readonly<Record<string, string>> = OTHER_CONTEXTS): Set<string> {
  if (!m.generatedContext) return new Set();
  return new Set(m.properties.filter(p => p.kind === 'object' && !p.deprecated && tokens(p.range).some(r => otherContexts[expandAbs(m, r)]))
    .flatMap(p => jsonKeysOf(m, p.name)));
}

const XSD = 'http://www.w3.org/2001/XMLSchema#';
/** Ranges whose values JSON writes as strings, read as literals of that datatype. */
const STRING_FORMS = new Set(['xsd:dateTime', 'xsd:date', 'xsd:time', 'xsd:anyURI', 'xsd:language']);
/** Integer ranges, read as that datatype where the shapes ask for it (else JSON-LD's xsd:integer). */
const INTEGER_FORMS = new Set(['xsd:integer', 'xsd:nonNegativeInteger', 'xsd:positiveInteger', 'xsd:int']);

type TermDef = Record<string, unknown>;

const tokens = (r: string | readonly string[] | undefined): string[] => (r === undefined ? [] : typeof r === 'string' ? [r] : [...r]);
const xsdIri = (t: string): string => `${XSD}${t.slice('xsd:'.length)}`;

/** The JSON key a constraint reads, and the property it reads it into, for every step of its path. */
function keyMappings(m: OntologyModel, s: OntShape): Array<{ key: string; property: string }> {
  const out: Array<{ key: string; property: string }> = [];
  for (const c of s.constraints) {
    if (c.identifies || c.rdfPath === null) continue;
    const keys = (c.jsonPath ?? c.path).split('.');
    const rdf = c.rdfPath === undefined ? keys : typeof c.rdfPath === 'string' ? [c.rdfPath] : [...c.rdfPath];
    if (keys.length !== rdf.length) continue;
    keys.forEach((k, i) => {
      const r = rdf[i]!;
      if (k.startsWith('@') || r.includes(':') || k === 'id') return; // a keyword, another vocabulary's term, or the node's own IRI
      if (m.properties.some(p => p.name === r)) out.push({ key: k, property: r });
    });
  }
  return out;
}

/**
 * The JSON-LD 1.1 context that reads `m`'s JSON instances into its ontology.
 * `otherContexts` names the context URL of another document's classes, for an object property whose
 * range is one of them (cmi5's contextTemplate is an xAPI Context).
 */
export function modelJsonLdContext(m: OntologyModel, otherContexts: Readonly<Record<string, string>> = OTHER_CONTEXTS): Record<string, unknown> {
  const N = ns(m);
  const props = new Map(m.properties.filter(p => !p.deprecated).map(p => [p.name, p]));
  const ctx: Record<string, unknown> = { '@version': 1.1 };

  // The node's own IRI, and its type.
  if (!props.has('id')) ctx.id = '@id';
  if (!props.has('type')) ctx.type = '@type';
  for (const c of m.classes) ctx[c.name] = { '@id': N + c.name };
  for (const s of m.shapes) {
    for (const t of s.jsonTypes ?? []) if (s.targetClass && !(t in ctx)) ctx[t] = { '@id': expandAbs(m, s.targetClass) };
  }

  /** The concept scheme whose members are all typed with one of these classes, if one is. */
  const schemeFor = (classes: readonly string[]): string | undefined => {
    for (const v of m.vocabularies ?? []) {
      if (v.members.length && v.members.every(mem => (mem.types ?? []).some(t => classes.includes(t)))) return v.name;
    }
    return undefined;
  };
  /** The datatype every constraint on a key asks for, when they agree on one. */
  const shapeDatatypes = new Map<string, Set<string>>();
  for (const s of m.shapes) {
    for (const c of s.constraints) {
      if (!c.datatype) continue;
      const key = (c.jsonPath ?? c.path).split('.').pop()!;
      const set = shapeDatatypes.get(key) ?? new Set<string>();
      for (const d of tokens(c.datatype)) set.add(d);
      shapeDatatypes.set(key, set);
    }
  }
  const languageForm = m.jsonLanguageStrings ?? 'map';

  const termFor = (key: string, p: OntProperty): TermDef => {
    const id = N + p.name;
    if (p.kind === 'object') {
      const ranges = tokens(p.range);
      const scheme = schemeFor(ranges);
      if (scheme) return { '@id': id, '@type': '@vocab', '@context': { '@vocab': `${N}${slugLocal(scheme)}-` } };
      const other = ranges.map(r => otherContexts[expandAbs(m, r)]).find(Boolean);
      if (other) return { '@id': id, '@type': '@id', '@context': other };
      return { '@id': id, '@type': '@id' };
    }
    if (p.oneOf?.length) return { '@id': id };
    const ranges = tokens(p.range);
    if (ranges.includes('rdf:langString') && !ranges.includes('xsd:string')) {
      return languageForm === 'list'
        ? { '@id': id, '@container': '@set', '@context': { lang: '@language', text: '@value' } }
        : { '@id': id, '@container': '@language' };
    }
    if (ranges.length === 1) {
      const r = ranges[0]!;
      if (STRING_FORMS.has(r)) return { '@id': id, '@type': xsdIri(r) };
      const asked = shapeDatatypes.get(key);
      if (INTEGER_FORMS.has(r) && asked && asked.size === 1 && asked.has(r)) return { '@id': id, '@type': xsdIri(r) };
    }
    return { '@id': id };
  };

  // Every property under its own name; then the JSON keys the shapes read it from, where those
  // differ.
  for (const p of props.values()) ctx[p.name] = termFor(p.name, p);
  const byKey = new Map<string, Map<string, string[]>>();
  for (const s of m.shapes) {
    for (const { key, property } of keyMappings(m, s)) {
      if (key === property) continue;
      const kinds = byKey.get(key) ?? new Map<string, string[]>();
      kinds.set(property, [...(kinds.get(property) ?? []), ...(s.targetClass ? [s.targetClass] : [])]);
      byKey.set(key, kinds);
    }
  }
  // A key that names different properties on different kinds of node (cmi5's entitlementKey: an
  // Assignable Unit's string, the launch data's object) is read by the node's kind. A kind no property
  // reaches is a document's root, whose JSON a standard leaves untyped (cmi5's LMS.LaunchData): the
  // key's top-level term is its reading there. Each other reading is scoped to its kinds — by the
  // node's type (a type-scoped context on the kind's term) and by the property that reaches the node
  // (a property-scoped context on each property whose range is the kind).
  const reached = new Set(m.properties.filter(p => p.kind === 'object' && !p.deprecated && typeof p.range === 'string').map(p => expandAbs(m, p.range as string)));
  const scope = (term: string, key: string, def: TermDef): void => {
    const base = (typeof ctx[term] === 'object' ? ctx[term] : { '@id': N + term }) as TermDef;
    ctx[term] = { ...base, '@context': { ...((base['@context'] ?? {}) as Record<string, unknown>), [key]: def } };
  };
  for (const [key, kinds] of byKey) {
    const owner = props.get(key);
    if (kinds.size === 1 && !owner) {
      const [property] = [...kinds.keys()];
      ctx[key] = termFor(key, props.get(property!)!);
      continue;
    }
    const readings = [...kinds].map(([property, classes]) => ({ property, classes }));
    if (owner) readings.push({ property: owner.name, classes: tokens(owner.domain).filter(c => !c.includes(':')) });
    const roots = readings.filter(r => r.classes.length && r.classes.every(c => !reached.has(expandAbs(m, c))));
    const top = roots.length === 1 ? roots[0]! : readings.find(r => r.property === owner?.name);
    if (top) ctx[key] = termFor(key, props.get(top.property)!);
    else delete ctx[key];
    for (const r of readings) {
      if (r === top) continue;
      const def = termFor(key, props.get(r.property)!);
      for (const cls of r.classes) {
        if (cls.includes(':')) continue;
        scope(cls, key, def);
        for (const via of m.properties) {
          if (via.kind === 'object' && !via.deprecated && typeof via.range === 'string' && expandAbs(m, via.range) === expandAbs(m, cls)) scope(via.name, key, def);
        }
      }
    }
  }
  // A deprecated property keeps its term, where its name is not read into a current property.
  for (const p of m.properties) if (p.deprecated && !(p.name in ctx)) ctx[p.name] = termFor(p.name, p);
  return { '@context': ctx };
}

/** The context as it is served and archived: indented JSON, one trailing newline. */
export const renderModelContext = (m: OntologyModel, otherContexts: Readonly<Record<string, string>> = OTHER_CONTEXTS): string =>
  `${JSON.stringify(modelJsonLdContext(m, otherContexts), null, 2)}\n`;
