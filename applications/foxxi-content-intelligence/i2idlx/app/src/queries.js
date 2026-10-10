// The catalog's stored queries: parameter binding (exactly as an agent substitutes $-variables) and a local
// evaluation over the embedded release, so a query can be tried here before it runs live. Two run client-side
// by design (i2x:runsOver): over the semantic-layer graphs plus the agent's own data.
import { C, META, QUERIES, SOURCES, COLLECTIONS, byId, iriOf } from "./data.js";
import { classify, conceptReferents, SEM } from "./semantic.js";

const COL_IRI = (facetId) => "https://id.i2idl.org/collections/" + facetId;
export const COLLECTION_OPTIONS = [
  ...COLLECTIONS.field.map((f) => ({ v: "field/" + f.id, l: "Field · " + f.label })),
  ...COLLECTIONS.type.map((f) => ({ v: "type/" + f.id, l: "Type · " + f.label })),
  ...COLLECTIONS.curated.map((f) => ({ v: "curated/" + f.id, l: "Curated · " + f.label })),
];
export const PARAM_KIND = { concept: "concept", text: "text", collection: "collection", fieldA: "collection", fieldB: "collection", type: "type", version: "text" };

const lit = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
export function bindValue(param, v) {
  const kind = PARAM_KIND[param];
  if (kind === "concept") return "<" + iriOf(v) + ">";
  if (kind === "collection" || kind === "type") return "<" + COL_IRI(v) + ">";
  return lit(v);
}
export function bind(q, values) {
  let s = q.sparql;
  for (const p of q.params) s = s.replace(new RegExp("\\$" + p + "\\b", "g"), () => bindValue(p, values[p] ?? ""));
  return s;
}

// SPARQL ORDER BY on plain strings compares code points, not locale.
const cp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const membersOf = (facetId) => {
  const [facet, id] = facetId.split("/");
  if (facet === "field") return C.filter((c) => c.f.includes(id));
  if (facet === "type") return C.filter((c) => c.t === id);
  if (facet === "curated") return C.filter((c) => c.cu.includes(id));
  return [];
};

/** → {head: [...], rows: [[...]], note?} or {ask: boolean, note} */
export function runLocal(name, v) {
  switch (name) {
    case "concept-neighborhood": {
      const c = byId.get(v.concept);
      if (!c) return { head: ["predicate", "object", "label"], rows: [] };
      const rows = [["skos:prefLabel", "", c.l]];
      for (const [p, l] of [["skos:broader", c.b], ["skos:narrower", c.n], ["skos:related", c.r]]) for (const x of l) rows.push([p, x, byId.get(x).l]);
      return { head: ["predicate", "object", "label"], rows, concept: true };
    }
    case "concept-search": {
      const t = String(v.text || "").toLowerCase();
      const out = new Map();
      for (const c of C) if (c.l.toLowerCase().includes(t) || c.a.some((a) => a.toLowerCase().includes(t))) out.set(c.id, c.l);
      const rows = [...out.entries()].sort((a, b) => cp(a[1], b[1])).slice(0, 50).map(([id, l]) => [id, l]);
      return { head: ["concept", "label"], rows, concept: true };
    }
    case "definition-evidence": {
      const c = byId.get(v.concept);
      if (!c) return { head: ["relation", "source", "citation"], rows: [] };
      return { head: ["relation", "source", "citation"], rows: c.ev.map((e) => [e.r === "d" ? "direct" : "supporting", SOURCES[e.s].title, e.c || ""]), note: c.d };
    }
    case "collection-members": {
      const rows = membersOf(v.collection).map((c) => [c.id, c.l]).sort((a, b) => cp(a[1], b[1]));
      return { head: ["concept", "label"], rows, concept: true };
    }
    case "field-intersection": {
      const b = new Set(membersOf(v.fieldB).map((c) => c.id));
      const rows = membersOf(v.fieldA).filter((c) => b.has(c.id)).map((c) => [c.id, c.l]).sort((x, y) => cp(x[1], y[1]));
      return { head: ["concept", "label"], rows, concept: true };
    }
    case "concepts-by-type": {
      const rows = membersOf(v.type).map((c) => [c.id, c.l]).sort((a, b) => cp(a[1], b[1]));
      return { head: ["concept", "label"], rows, concept: true };
    }
    case "multi-field-concepts": {
      const rows = C.filter((c) => c.f.length > 1).map((c) => [c.id, c.l, c.f.length]).sort((a, b) => b[2] - a[2] || cp(a[1], b[1]));
      return { head: ["concept", "label", "fields"], rows, concept: true };
    }
    case "provenance-profile": {
      const g = C.filter((c) => c.pv === "g").length;
      return { head: ["provenance", "definitions"], rows: [["source-grounded", g], ["synthesized", C.length - g]] };
    }
    case "release-check":
      return { ask: String(v.version) === META.release, note: `The embedded release is ${META.release}. Run it live to check the published scheme now.` };
    case "classify": {
      const out = classify(SEM.example);
      const rows = [];
      for (const r of out.resources) for (const x of r.classes) rows.push([r.iri, x.t]);
      rows.sort((a, b) => cp(a[0], b[0]) || cp(a[1], b[1]));
      return { head: ["resource", "class"], rows, note: `Ran over the sample organization (${out.resources.length} resources, ${out.typings} typings). Paste your own data in the Semantic layer playground.` };
    }
    case "concept-referents":
      return { head: ["category", "categoryLabel", "basis", "why", "class"], rows: conceptReferents(v.concept) };
    default:
      return { head: [], rows: [] };
  }
}

export const defaults = (q) => {
  const v = { ...q.sample };
  for (const p of q.params) if (v[p] == null) v[p] = "";
  return v;
};
export { QUERIES };
