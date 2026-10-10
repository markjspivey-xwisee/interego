// The embedded release: the I2IDL glossary joined with the I2IDL-X layers (built by tools/build_app.py).
// Everything here is derived once at load; views only read.

const raw = JSON.parse(document.getElementById("i2-data").textContent);

export const META = raw.meta;
export const KINDS = raw.kinds;
export const ROLES = raw.roles;
export const STATUSES = raw.statuses;
export const METHODS = raw.methods;
export const INTERROGATIVES = raw.interrogatives;
export const COLLECTIONS = raw.collections;
export const SOURCES = raw.sources;
export const C = raw.concepts;
export const ACTIONS = raw.actions;
export const ENACTMENTS = raw.enactments;
export const INHERITED = raw.inherited;
export const ROLE_CAPS = raw.roleCaps;
export const MAPPINGS = raw.mappings;
export const RELEASES = raw.releases;
export const PORTS = raw.ports;
export const QUERIES = raw.queries;
export const SUGGESTIONS = raw.suggestions;
export const LAYOUT = raw.layout;
export const CHANGE_KINDS = raw.changeKinds;
export const SEMANTIC = raw.semantic;
export const FORMS = raw.forms; // [surface form, concept index, strong, case-sensitive] for Annotate

export const CONCEPT_NS = "https://id.i2idl.org/concepts/";
export const byId = new Map(C.map((c) => [c.id, c]));
export const indexOf = new Map(C.map((c, i) => [c.id, i]));
export const kindById = new Map(KINDS.map((k) => [k.id, k]));
export const roleById = new Map(ROLES.map((r) => [r.id, r]));
export const methodById = new Map(METHODS.map((m) => [m.id, m]));
export const statusById = new Map(STATUSES.map((s) => [s.id, s]));
export const fieldById = new Map(COLLECTIONS.field.map((f) => [f.id, f]));
export const typeById = new Map(COLLECTIONS.type.map((t) => [t.id, t]));
export const curatedById = new Map(COLLECTIONS.curated.map((t) => [t.id, t]));
export const changeKindById = new Map(CHANGE_KINDS.map((k) => [k.id, k]));
// "675 relationship pairs added", "1 source added": change kinds as counted phrases
const KIND_NOUN = {
  "concept-added": ["concept", "concepts", "added"], "concept-removed": ["concept", "concepts", "removed"],
  "label-changed": ["preferred label", "preferred labels", "changed"], "alt-label-added": ["alternate label", "alternate labels", "added"],
  "alt-label-removed": ["alternate label", "alternate labels", "removed"], "definition-revised": ["definition", "definitions", "revised"],
  "explanation-revised": ["editorial note", "editorial notes", "revised"], "type-changed": ["type", "types", "changed"],
  "field-changed": ["primary field", "primary fields", "changed"], "status-changed": ["editorial status", "editorial statuses", "changed"],
  "relationship-added": ["relationship pair", "relationship pairs", "added"], "relationship-removed": ["relationship pair", "relationship pairs", "removed"],
  "membership-added": ["collection membership", "collection memberships", "added"], "membership-removed": ["collection membership", "collection memberships", "removed"],
  "collection-added": ["collection", "collections", "added"], "collection-removed": ["collection", "collections", "removed"],
  "collection-revised": ["collection", "collections", "revised"], "source-added": ["source", "sources", "added"],
  "source-removed": ["source", "sources", "removed"], "source-revised": ["source title", "source titles", "revised"],
  "evidence-added": ["evidence record", "evidence records", "added"], "evidence-removed": ["evidence record", "evidence records", "removed"],
  "evidence-classified": ["evidence record", "evidence records", "classified"], "evidence-reclassified": ["evidence record", "evidence records", "reclassified"],
  "external-mapping-added": ["external mapping", "external mappings", "added"], "external-mapping-revised": ["external mapping", "external mappings", "revised"],
};
export const kindPhrase = (k, n) => {
  const w = KIND_NOUN[k];
  return w ? `${n.toLocaleString()} ${n === 1 ? w[0] : w[1]} ${w[2]}` : `${n.toLocaleString()} ${(changeKindById.get(k) || { label: k }).label.toLowerCase()}`;
};
export const collectionLabel = (path) => {
  const [facet, id] = path.split("/");
  const col = (COLLECTIONS[facet] || []).find((x) => x.id === id);
  return col ? col.label : id;
};

export const iriOf = (id) => CONCEPT_NS + id;
export const degree = (c) => c.r.length + c.b.length + c.n.length;

function group(list, key) {
  const m = new Map();
  for (const x of list) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
export const enactByConcept = group(ENACTMENTS, (e) => e.c);
export const mapsByConcept = group(MAPPINGS, (m) => m.c);
export const inhByConcept = group(INHERITED, (e) => e.c);
export const capsByConcept = group(ROLE_CAPS, (e) => e.c);
export const suggByConcept = group(SUGGESTIONS, (s) => s.a);

// action IRI → concepts that it enacts / that hold it as a role capability
export const conceptsByAction = new Map();
for (const e of ENACTMENTS) {
  if (!conceptsByAction.has(e.a)) conceptsByAction.set(e.a, []);
  conceptsByAction.get(e.a).push({ c: e.c, how: e.r, kind: "enactment" });
}
for (const e of ROLE_CAPS) {
  if (!conceptsByAction.has(e.a)) conceptsByAction.set(e.a, []);
  conceptsByAction.get(e.a).push({ c: e.c, how: "role", kind: "role" });
}

export const actionName = (iri) => {
  const a = ACTIONS[iri];
  return a ? a.n : iri.replace(META.actionRoot, "");
};
export const SYSTEM_LABEL = { foxxi: "Foxxi bridge", relay: "Interego relay" };
export const systemLabel = (sys) => SYSTEM_LABEL[sys] || (sys ? sys.replace(/-/g, " ") + " (bridge)" : "");

// Review items: the I2IDL-X records reviewers vote on.
export const ITEMS = [
  ...MAPPINGS.map((m) => ({ key: "m." + m.id, type: "mapping", rec: m, c: m.c, iri: META.iri.mappings + "#" + m.id })),
  ...ENACTMENTS.map((e) => ({ key: "e." + e.id, type: "enactment", rec: e, c: e.c, iri: META.iri.enactments + "#" + e.id })),
];
export const itemByKey = new Map(ITEMS.map((i) => [i.key, i]));

// Undirected editorial graph (related ∪ broader/narrower), for paths and neighborhoods.
export const ADJ = new Map(C.map((c) => [c.id, [...c.r.map((x) => [x, "r"]), ...c.b.map((x) => [x, "b"]), ...c.n.map((x) => [x, "n"])]]));

export function shortestPaths(a, b, max = 3) {
  if (a === b) return [[a]];
  const dist = new Map([[a, 0]]);
  const preds = new Map([[a, []]]);
  let frontier = [a];
  while (frontier.length && !dist.has(b)) {
    const next = [];
    for (const u of frontier) {
      for (const [v] of ADJ.get(u)) {
        if (!dist.has(v)) {
          dist.set(v, dist.get(u) + 1);
          preds.set(v, [u]);
          next.push(v);
        } else if (dist.get(v) === dist.get(u) + 1) {
          preds.get(v).push(u);
        }
      }
    }
    frontier = next;
  }
  if (!dist.has(b)) return [];
  const out = [];
  const walk = (v, acc) => {
    if (out.length >= max) return;
    if (v === a) { out.push([a, ...acc]); return; }
    for (const p of preds.get(v).slice().sort()) walk(p, [v, ...acc]);
  };
  walk(b, []);
  return out;
}

export function relationBetween(a, b) {
  const A = byId.get(a);
  if (!A) return null;
  if (A.r.includes(b)) return "related";
  if (A.b.includes(b)) return "narrower"; // a is narrower than b
  if (A.n.includes(b)) return "broader"; // a is broader than b
  return null;
}

export const kindColor = (k) => `var(--k-${k})`;

// Rights: what reuse of a definition grounded in a source asks of you (information, not legal advice).
export const RIGHTS = {
  open: { label: "Open (attribution)", short: "Open", note: "Reuse with attribution." },
  sharealike: { label: "Share-alike", short: "Share-alike", note: "Reuse with attribution; adaptations carry the same licence." },
  nc: { label: "Non-commercial", short: "Non-commercial", note: "Not for commercial use without permission from the rights holder." },
  permission: { label: "Permission / terms", short: "Permission", note: "Used by I2IDL with permission or under the publisher's terms; ask before reuse." },
};
// I2IDL's own card wording for definition provenance (README, next priority 3), computed from its evidence relations.
export const provenanceLine = (c) => (c.pv === "g" ? META.upstream.provenance[0] : META.upstream.provenance[1]);
export const unescoByConcept = (() => {
  const m = new Map();
  for (const x of MAPPINGS) if (x.v === "UNESCO Thesaurus") { if (!m.has(x.c)) m.set(x.c, []); m.get(x.c).push(x); }
  return m;
})();
export const directSources = (c) => [...new Set(c.ev.filter((e) => e.r === "d").map((e) => e.s))].map((i) => SOURCES[i]);
export const allSources = (c) => [...new Set(c.ev.map((e) => e.s))].map((i) => SOURCES[i]);
export function reuseClass(c) {
  // the most restrictive class among sources the definition directly rests on
  const order = ["permission", "nc", "sharealike", "open"];
  const cls = directSources(c).map((s) => s.rc);
  for (const o of order) if (cls.includes(o)) return o;
  return "open";
}

// A deterministic "term of the day".
export function termOfDay(date = new Date()) {
  const d = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 864e5);
  const pool = C.filter((c) => c.r.length >= 2);
  return pool[(Math.imul(d, 2654435761) >>> 0) % pool.length];
}

// Percent-encode like Python's urllib.parse.quote(s, safe=""), which built the materialized targets.
export const quoteAll = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());

// Per-concept decorated controls — the same recipe the build proves against all 1,985 materialized targets.
export function controlsFor(c) {
  const q = META.neighborhoodQuery.replace(/\$concept\b/g, "<" + iriOf(c.id) + ">");
  return [
    { id: "resolve", title: "Resolve (Turtle)", m: "GET", mt: "text/turtle", u: iriOf(c.id) + ".ttl", via: "tmpl-concept-turtle" },
    { id: "resolve-json", title: "Resolve (JSON-LD)", m: "GET", mt: "application/ld+json", u: iriOf(c.id) + ".jsonld", via: "tmpl-concept-jsonld" },
    { id: "definition", title: "Definition and evidence", m: "GET", mt: "text/turtle", u: c.di + ".ttl", via: "tmpl-definition" },
    { id: "neighborhood", title: "Semantic neighborhood (SPARQL)", m: "GET", mt: "text/turtle", u: META.endpoint + "?query=" + quoteAll(q), via: "q-concept-neighborhood", query: q },
    { id: "card", title: "Open the I2IDL card", m: "GET", mt: "text/html", u: META.human + "#" + c.id, via: "tmpl-human" },
  ];
}
