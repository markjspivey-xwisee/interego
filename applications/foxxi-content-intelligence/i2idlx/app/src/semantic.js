// The semantic layer on the client: what each I2IDL concept classifies, the classes that follow, and a
// classifier for pasted Turtle that reaches exactly what the catalog's q-classify reaches (the build checks
// that q-classify concludes nothing an OWL 2 RL reasoner does not, and check_app_logic.py checks this file
// against q-classify). Clashes come from the category disjointness table, which OWL 2 RL confirmed pair by pair.
import N3Parser from "n3/src/N3Parser.js";
import { META, SEMANTIC as S, C, byId, CONCEPT_NS } from "./data.js";

export const SEM = S;
export const CATS = S.categories;
export const catById = new Map(CATS.map((c) => [c.id, c]));
export const catIndex = new Map(CATS.map((c, i) => [c.id, i]));
export const VOCAB_BY_PREFIX = new Map(S.vocabs.map((v) => [v.p, v]));
export const COLUMNS = S.columns;
const PFX = Object.entries(S.prefixes).sort((a, b) => b[1].length - a[1].length);
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const CLASSIFIED_BY = META.ns + "isClassifiedBy";
const LABEL_PREDS = ["http://www.w3.org/2000/01/rdf-schema#label", "http://www.w3.org/2004/02/skos/core#prefLabel",
  "https://schema.org/name", "http://schema.org/name", "http://purl.org/dc/terms/title"];

export function curieOf(iri) {
  for (const [p, ns] of PFX) if (iri.startsWith(ns) && iri.length > ns.length) return p + ":" + iri.slice(ns.length);
  return iri;
}
export function expand(curie) {
  const i = curie.indexOf(":");
  const ns = S.prefixes[curie.slice(0, i)];
  return ns ? ns + curie.slice(i + 1) : curie;
}
const humanize = (local) => local.replace(/^ont\d+$/, (x) => x).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
/** A class's own label from its publisher's file; the local name when the publisher gives none. */
export function labelOf(curie) {
  const l = S.labels[curie];
  if (l) return l;
  const local = curie.includes(":") ? curie.slice(curie.indexOf(":") + 1) : curie;
  return humanize(local);
}
/** Matrix column of a term: bfo, cco, gist, dul, gufo, prov, schema, peer, foxxi, interego, i2x. */
export function columnOf(curie) {
  const p = curie.slice(0, curie.indexOf(":"));
  if (p === "i2x") return "i2x";
  const v = VOCAB_BY_PREFIX.get(p);
  return v ? v.col : "other";
}
export const vocabOf = (curie) => VOCAB_BY_PREFIX.get(curie.slice(0, curie.indexOf(":")));

export function ancestors(id) {
  const out = [];
  for (let c = catById.get(id); c && c.parent; c = catById.get(c.parent)) out.push(c.parent);
  return out;
}
export const chain = (id) => [id, ...ancestors(id)];
export const childrenOf = (id) => CATS.filter((c) => c.parent === id).map((c) => c.id);
export const conceptsIn = (id) => C.filter((c) => c.rc === id);

/** Every class a referent of this category joins, each with the category in its chain that brings it. */
export function classesOf(id) {
  const cat = catById.get(id);
  const from = new Map();
  for (const k of chain(id)) {
    const ck = catById.get(k);
    if (!from.has(ck.cls)) from.set(ck.cls, { k, how: "category" });
    for (const t of ck.own) if (!from.has(t)) from.set(t, { k, how: "aligned" });
  }
  if (!from.has("i2x:Referent")) from.set("i2x:Referent", { k: null, how: "referent" });
  // anything further that rdfs:subClassOf* reaches in the published vocabulary and alignments
  for (const t of cat.all) if (!from.has(t)) from.set(t, { k: null, how: "inherited" });
  return [...from.entries()].map(([t, w]) => ({ t, ...w }));
}

export const bridgesIn = new Map(); // peer class → [{c, k, m}] : typed with the class ⇒ classified by the concept
export const bridgesOut = new Map(); // concept → [{t, k, m}] : classified by the concept ⇒ typed with the class
for (const b of S.bridges) {
  if (b.k === "exact" || b.k === "narrow") (bridgesIn.get(b.t) || bridgesIn.set(b.t, []).get(b.t)).push(b);
  if (b.k === "exact" || b.k === "broad") (bridgesOut.get(b.c) || bridgesOut.set(b.c, []).get(b.c)).push(b);
}
export const bridgesOf = (cid) => S.bridges.filter((b) => b.c === cid);

/** Why two categories can never share a member: {ontology: [classA, classB]}, or null. */
export function disjointness(a, b) {
  if (a === b) return null;
  const [x, y] = catIndex.get(a) < catIndex.get(b) ? [a, b] : [b, a];
  return S.disjoint[x + "|" + y] || null;
}
export function disjointWith(id) {
  return CATS.filter((c) => c.id !== id && disjointness(id, c.id)).map((c) => ({ id: c.id, why: disjointness(id, c.id) }));
}

const DEFAULT_PREFIXES = `@prefix i2x:   <${META.ns}> .\n@prefix i2idl: <${CONCEPT_NS}> .\n@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .\n`;
/** A starter snippet that classifies one made-up thing with a concept. */
export function snippetFor(cid) {
  const c = byId.get(cid);
  return `${DEFAULT_PREFIXES}@prefix ex:    <https://example.org/my-org/> .\n\nex:my-${cid.slice(0, 40)} rdfs:label ${JSON.stringify("Our " + c.l.toLowerCase())} ;\n    i2x:isClassifiedBy i2idl:${cid} .\n`;
}

/**
 * Classify pasted Turtle. Returns {error} or {resources, triples, typings, clashes, turtle}.
 * resources: [{iri, label, by: [{c, how: "stated"|"bridge", t?, k?, m?}], cats, classes: [{t, why: [...]}],
 *              clashes: [{a, b, ca, cb, why}], notes: [...], problems: [...]}]
 */
export function classify(text) {
  let quads;
  try {
    quads = new N3Parser({ format: "text/turtle", baseIRI: "https://example.org/" }).parse(text);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
  const res = new Map();
  const get = (s) => res.get(s) || res.set(s, { iri: s, label: null, types: new Set(), by: new Map(), problems: [] }).get(s);
  for (const q of quads) {
    const s = q.subject.termType === "BlankNode" ? "_:" + q.subject.value : q.subject.value;
    const p = q.predicate.value;
    if (p === RDF_TYPE && q.object.termType === "NamedNode") get(s).types.add(q.object.value);
    else if (p === CLASSIFIED_BY) {
      const o = q.object;
      const id = o.termType === "NamedNode" && o.value.startsWith(CONCEPT_NS) ? o.value.slice(CONCEPT_NS.length) : null;
      if (id && byId.has(id)) get(s).by.set(id, { c: id, how: "stated" });
      else get(s).problems.push(o.termType === "NamedNode"
        ? { kind: "unknown", v: o.value, text: o.value.startsWith(CONCEPT_NS) ? `${o.value} is not a concept in I2IDL ${META.release}.` : `${o.value} is not an I2IDL concept; i2x:isClassifiedBy names one by its IRI under ${CONCEPT_NS}.` }
        : { kind: "literal", v: o.value, text: `"${o.value}" is text; i2x:isClassifiedBy needs an I2IDL concept IRI.` });
    } else if (LABEL_PREDS.includes(p) && q.object.termType === "Literal") {
      const r = get(s);
      if (!r.label) r.label = q.object.value;
    }
  }
  for (const r of res.values())
    for (const t of r.types) for (const b of bridgesIn.get(curieOf(t)) || [])
      if (!r.by.has(b.c)) r.by.set(b.c, { c: b.c, how: "bridge", t: b.t, k: b.k, m: b.m });

  const resources = [];
  let typings = 0;
  const lines = [];
  for (const r of res.values()) {
    if (!r.by.size && !r.problems.length) continue;
    const classes = new Map();
    const add = (t, why) => (classes.get(t) || classes.set(t, { t, why: [] }).get(t)).why.push(why);
    const notes = [];
    const cats = [];
    for (const b of r.by.values()) {
      const c = byId.get(b.c);
      const cat = catById.get(c.rc);
      cats.push(c.rc);
      for (const x of classesOf(c.rc)) add(x.t, { c: b.c, k: x.k, how: x.how });
      for (const o of bridgesOut.get(b.c) || []) add(o.t, { c: b.c, how: "bridge", k: o.k, m: o.m });
      if (cat.mode === "subject") notes.push({ kind: "subject", c: b.c, text: `${c.l} is a field: things are about it, not instances of it. Link to it with dct:subject; it types nothing beyond i2x:${cat.cls.split(":")[1]}.` });
      if (cat.mode === "none") notes.push({ kind: "none", c: b.c, text: `${c.l} has no single upper-ontology category (${cat.def.replace(/^A concept whose /, "its ")}), so it types nothing beyond I2IDL-X's own classes.` });
    }
    const uniq = [...new Set(cats)];
    const clashes = [];
    const byList = [...r.by.values()];
    for (let i = 0; i < byList.length; i++)
      for (let j = i + 1; j < byList.length; j++) {
        const ca = byId.get(byList[i].c).rc, cb = byId.get(byList[j].c).rc;
        const why = disjointness(ca, cb);
        if (why) clashes.push({ a: byList[i].c, b: byList[j].c, ca, cb, why });
      }
    const list = [...classes.values()].sort((x, y) => x.t.localeCompare(y.t));
    typings += list.length;
    for (const x of list) lines.push(`${r.iri.startsWith("_:") ? r.iri : "<" + r.iri + ">"} a <${expand(x.t)}> .`);
    for (const b of r.by.values()) if (b.how === "bridge") lines.push(`<${r.iri}> <${CLASSIFIED_BY}> <${CONCEPT_NS + b.c}> .`);
    resources.push({ iri: r.iri, label: r.label, by: [...r.by.values()], cats: uniq, classes: list, clashes, notes, problems: r.problems,
      types: [...r.types].map(curieOf) });
  }
  const turtle = lines.length
    ? `# Inferred by I2IDL-X's semantic layer (graphs i2idlx-alignments and i2idlx-referents), modal status Hypothetical.\n${lines.join("\n")}\n`
    : "";
  return { resources, triples: quads.length, typings, clashes: resources.reduce((n, r) => n + r.clashes.length, 0), turtle };
}

/** One concept's referent row, as q-concept-referents returns it (category, label, basis, reason, class). */
export function conceptReferents(cid) {
  const c = byId.get(cid);
  if (!c) return [];
  const cat = catById.get(c.rc);
  return cat.all.slice().sort((a, b) => (expand(a) < expand(b) ? -1 : expand(a) > expand(b) ? 1 : 0))
    .map((t) => [META.ns + "category-" + cat.id, cat.label, c.rb === "t" ? "type" : "definition", c.rw, expand(t)]);
}
