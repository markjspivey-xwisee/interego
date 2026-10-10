// The sandbox the agents work in, and the tools they use on it. Every tool is a function of this page:
// it reads the embedded release (the same data every workbench view reads), changes the sandbox, and says
// how the workbench should show what it did. Nothing here writes to the shared database or the network —
// governed writes are staged as the exact publish_context calls the catalog's ports declare, and leave only
// when a human approves. Tool results are deterministic (no clock, no randomness), so a recorded run
// replays to the same results; tools/check_orchestra.py proves it.
import { META, PORTS, QUERIES, MAPPINGS, byId, typeById, mapsByConcept } from "../data.js";
import { classify, catById, classesOf, columnOf, labelOf, expand, curieOf, bridgesOf, disjointWith, conceptsIn, vocabOf, SEM, COLUMNS } from "../semantic.js";
import { search } from "../search.js";
import { suggestForPack } from "../lib.js";
import { consensus } from "../caps.js";
import { ORG, RECORDS, agentById } from "./scenario.js";

export const QUORUM = 2;
const RELAY = META.base.replace(/\/ns\/.*$/, "");
const OWNER_GRAPH = (slug) => `${RELAY}/ns/<your-owner>/${slug}`;
const SKOS = "http://www.w3.org/2004/02/skos/core#";
const PREDICATES = ["exactMatch", "closeMatch", "broadMatch", "narrowMatch", "relatedMatch"];
const LINK_PREDICATES = { "prov:used": "http://www.w3.org/ns/prov#used", "dct:hasPart": "http://purl.org/dc/terms/hasPart",
  "dct:isPartOf": "http://purl.org/dc/terms/isPartOf", "dct:relation": "http://purl.org/dc/terms/relation" };
const VOTES = { for: { modal: "Asserted", iep: "iep:Asserted" }, against: { modal: "Counterfactual", iep: "iep:Counterfactual" }, abstain: { modal: "Hypothetical", iep: "iep:Hypothetical" } };
const COLUMN_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label]));

const short = (s, n) => (s && s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s || "");
const lit = (s) => JSON.stringify(String(s));
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const slugOk = (s) => /^[a-z0-9][a-z0-9-]{1,48}$/.test(s);
const conceptLabel = (id) => (byId.get(id) ? byId.get(id).l : id);
const catLabel = (id) => (catById.get(id) ? catById.get(id).label : id);

/** Peer terms the build verified against pinned snapshots and term indexes, plus I2IDL-X's mapping targets. */
const VERIFIED = (() => {
  const m = new Map();
  for (const [curie, label] of Object.entries(SEM.labels)) m.set(expand(curie), { curie, label });
  for (const x of MAPPINGS) if (!m.has(x.o)) m.set(x.o, { curie: curieOf(x.o), label: x.ol || x.o.split(/[#/]/).pop(), definition: x.od || null, vocabulary: x.v });
  return m;
})();

export function createWorld() {
  return {
    records: new Map(RECORDS.map((r) => [r.id, { ...r, concepts: [], about: [], rationale: "", by: null, status: "unclassified", parts: null, from: null }])),
    order: RECORDS.map((r) => r.id),
    links: [],
    gaps: new Map(),
    fixes: [],
    discovered: new Set(),
    items: [],
    ballots: new Map(),
    packs: [],
    staged: [],
    gate: null,
    clashesSeen: 0,
    fixedClashes: 0,
    runs: 0,
  };
}

// ── Reading the sandbox ──────────────────────────────────────────────────────────────────────────────

export const iriOfRecord = (id) => ORG.ns + id;
export const liveRecords = (w) => w.order.map((id) => w.records.get(id)).filter((r) => r.status !== "split");

export function worldTurtle(w) {
  const used = new Set(["i2x", "i2idl", "rdfs", "dct"]);
  const body = [];
  for (const r of w.order.map((id) => w.records.get(id))) {
    if (r.status === "split") {
      body.push(`ex:${r.id} rdfs:label ${lit(r.title)}@en ;\n    rdfs:comment ${lit("Catalog record split into " + r.parts.map((x) => "ex:" + x).join(" and ") + ": it described more than one kind of thing.")}@en .`);
      continue;
    }
    const po = [];
    if (r.sourceTypes.length) { po.push("a " + r.sourceTypes.join(", ")); r.sourceTypes.forEach((t) => used.add(t.split(":")[0])); }
    po.push(`rdfs:label ${lit(r.title)}@en`);
    if (r.concepts.length) po.push("i2x:isClassifiedBy " + r.concepts.map((c) => "i2idl:" + c).join(", "));
    if (r.about.length) po.push("dct:subject " + r.about.map((c) => "i2idl:" + c).join(", "));
    if (r.from) po.push(`dct:source ex:${r.from}`);
    const gap = w.gaps.get(r.id);
    if (gap) po.push(`rdfs:comment ${lit("No fitting I2IDL concept (gap flagged for I2IDL's editors). Nearest: " + gap.nearest.map(conceptLabel).join(", ") + ".")}@en`);
    body.push(`ex:${r.id} ${po.join(" ;\n    ")} .`);
  }
  for (const l of w.links) { used.add(l.p.split(":")[0]); body.push(`ex:${l.s} ${l.p} ex:${l.o} .`); }
  const pfx = { ...SEM.prefixes, ex: ORG.ns, rdfs: "http://www.w3.org/2000/01/rdf-schema#", prov: "http://www.w3.org/ns/prov#" };
  const head = [...used, "ex"].filter((p, i, a) => a.indexOf(p) === i).map((p) => `@prefix ${p}: <${pfx[p]}> .`);
  return `# ${ORG.name} (fictional) — learning inventory as a context graph, classified with I2IDL concepts.\n${head.join("\n")}\n\n${body.join("\n")}\n`;
}

export function tallyOf(w, key) {
  const t = { for: [], against: [], abstain: [], notes: [] };
  for (const [u, doc] of w.ballots) {
    const v = doc.v[key];
    if (v && t[v.vote]) { t[v.vote].push(u); if (v.note) t.notes.push({ u, vote: v.vote, note: v.note, at: v.at }); }
  }
  return t;
}

/** Sandbox proposals reviewers ratified, as the OWL bridges a class-target crosswalk becomes. */
export function ratifiedBridges(w) {
  const out = [];
  for (const i of w.items) {
    const r = i.rec;
    if (!["exactMatch", "broadMatch", "narrowMatch"].includes(r.p + "")) continue;
    if (consensus(tallyOf(w, i.key), QUORUM) !== "ratified") continue;
    out.push({ c: r.c, t: curieOf(r.o), k: r.p.replace("Match", ""), m: r.id });
  }
  return out;
}

export function runClassifier(w) {
  return classify(worldTurtle(w), ratifiedBridges(w));
}

function byOntology(out) {
  const n = {};
  for (const r of out.resources) for (const x of r.classes) {
    const col = columnOf(x.t);
    const key = col === "foxxi" ? "peer" : col;
    if (key === "i2x" || key === "other" || key === "interego") continue;
    n[COLUMN_LABEL[key] || key] = (n[COLUMN_LABEL[key] || key] || 0) + 1;
  }
  return n;
}
const localId = (iri) => (iri.startsWith(ORG.ns) ? iri.slice(ORG.ns.length) : iri);

function resourceView(r) {
  const top = {};
  for (const x of r.classes) {
    const col = columnOf(x.t) === "foxxi" ? "peer" : columnOf(x.t);
    if (col === "i2x" || col === "other" || col === "interego") continue;
    const k = COLUMN_LABEL[col] || col;
    (top[k] = top[k] || []).push(labelOf(x.t));
  }
  for (const k of Object.keys(top)) top[k] = top[k].slice(0, 3).join(", ") + (top[k].length > 3 ? ` (+${top[k].length - 3})` : "");
  return {
    record: localId(r.iri), label: r.label,
    classifiedBy: r.by.map((b) => b.how === "bridge" ? `${b.c} (inferred: typed ${b.t}, crosswalk ${b.m} is an OWL bridge)` : b.c),
    categories: r.cats.map(catLabel), typings: r.classes.length, typedAs: top,
    clashes: r.clashes.map((x) => ({
      between: [conceptLabel(x.a), conceptLabel(x.b)], categories: [catLabel(x.ca), catLabel(x.cb)],
      disjointIn: Object.entries(x.why).map(([o, [a, b]]) => `${o}: ${labelOf(a)} ⟂ ${labelOf(b)}`),
    })),
    notes: r.notes.map((n) => n.text), problems: r.problems.map((p) => p.text),
  };
}

// ── Tools ────────────────────────────────────────────────────────────────────────────────────────────
// Each: description and inputSchema for Claude; via = the catalog control it follows (it must have been
// inspected first); run(world, input, agentId) → {result, summary, ui}. ui steps: {route}, {type: key, text},
// {set: key, value}, {focus: selector | [selectors], click}, {gate}.

const requireControl = (w, via) => {
  if (!w.discovered.has(via)) throw new Error(`The team has not followed the catalog to control ${via} yet. The Scout inspects it first; nothing acts through a control the catalog has not advertised.`);
};
const conceptsOrThrow = (ids) => {
  const out = [...new Set(list(ids).map(String))];
  const bad = out.filter((id) => !byId.has(id));
  if (bad.length) throw new Error(`Not I2IDL concept ids: ${bad.join(", ")}. Use ids from search_glossary or read_concepts.`);
  return out;
};
const recordOrThrow = (w, id) => {
  const r = w.records.get(String(id));
  if (!r) throw new Error(`No record "${id}". get_records lists them.`);
  if (r.status === "split") throw new Error(`Record "${id}" was split into ${r.parts.join(", ")}; work on those.`);
  return r;
};
const playUi = (w, focusIri) => [
  { set: "sem.play", value: worldTurtle(w) }, { route: "semantic-play" },
  { focus: focusIri ? [`.rescard[data-iri="${focusIri}"]`, ".play [aria-live] > .row"] : ".play [aria-live] > .row" },
];
function stage(w, agent, port, title, call) {
  const id = "call-" + (w.staged.length + 1);
  w.staged.push({ id, port, title, call, by: agent, status: "staged" });
  return id;
}

export const TOOLS = {
  get_records: {
    description: "The organization's brief and its learning inventory: every record with id, title, source system, description, any peer types its registry already carries, and its status in this run (unclassified, classified with which concepts, gap, or split).",
    run(w) {
      const result = {
        organization: ORG.name + " (fictional)", goal: ORG.goal,
        records: liveRecords(w).map((r) => ({
          id: r.id, title: r.title, source: r.source, description: r.description,
          ...(r.sourceTypes.length ? { sourceTypes: r.sourceTypes } : {}),
          status: r.status, ...(r.concepts.length ? { classifiedBy: r.concepts } : {}), ...(r.from ? { splitFrom: r.from } : {}),
        })),
      };
      return { result, summary: `${result.records.length} records`, ui: [] };
    },
  },

  read_catalog: {
    description: "Read the I2IDL-X HyprCat catalog (the agent entry point published on Interego): its controls — ports with method, target and whether they write — its stored queries, and its graphs. Inspect a control before anyone follows it.",
    run() {
      const result = {
        catalog: META.iri.catalog,
        dataProduct: "The I2IDL Digital Learning Glossary as a hyprcat:FederatedDataProduct, decorated by I2IDL-X",
        controls: PORTS.map((p) => ({ id: p.id, label: p.label, method: p.m, writes: !p.ro, ...(p.expects ? { takesInput: p.expects.label } : {}) })),
        storedQueries: QUERIES.map((q) => ({ id: q.id, label: q.label, ...(q.over ? { runsClientSideOver: q.over } : {}) })),
        graphs: META.graphs.map((g) => `${g.title} (${g.status})`),
      };
      return { result, summary: `${result.controls.length} controls · ${result.storedQueries.length} stored queries`, ui: [{ route: "agents" }, { focus: "#ports" }] };
    },
  },

  inspect_control: {
    description: "Follow one control from the catalog by id (a port such as port-publish-classified, or a stored query such as q-classify): its target, method, the input shape it expects with each field's default and constraint, and what the relay checks. Inspecting a control is what lets the team use it.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Control id from read_catalog" } }, required: ["id"] },
    run(w, { id }) {
      const p = PORTS.find((x) => x.id === String(id));
      if (p) {
        w.discovered.add(p.id);
        const result = {
          id: p.id, kind: "port", label: p.label, method: p.m, target: p.u || p.tpl, writes: !p.ro, mediaType: p.mt,
          description: short(p.desc || p.title, 520), action: p.action,
          ...(p.expects ? { input: { shape: p.expects.label, note: p.expects.note || undefined, fields: p.expects.props.map((x) => ({
            name: x.n, required: !!x.req, ...(x.def ? { default: x.def } : {}), ...(x.pat ? { pattern: x.pat } : {}), ...(x.c ? { meaning: short(x.c, 200) } : {}),
          })) } } : {}),
          ...(p.cap ? { requires: "i2x:" + p.cap } : {}),
        };
        return { result, summary: `${p.label} · ${p.m}${p.ro ? "" : " · writes"}`, ui: [{ route: "agents-" + p.id }, { focus: "#" + p.id, click: true }] };
      }
      const q = QUERIES.find((x) => x.id === String(id) || x.name === String(id));
      if (q) {
        w.discovered.add(q.id);
        const result = { id: q.id, kind: "stored query", label: q.label, form: q.form, description: short(q.desc, 600), parameters: q.params.map((x) => x.name || x),
          ...(q.over ? { runsClientSideOver: q.over, how: "Runs client-side over those graphs plus your own data; no reasoner needed. This workbench runs the same inference in the page." } : {}) };
        return { result, summary: `${q.label}`, ui: [{ route: "agents-" + q.id }, { focus: "#" + q.id }] };
      }
      throw new Error(`No control "${id}" in the catalog. read_catalog lists the ids.`);
    },
  },

  search_glossary: {
    description: "Search the I2IDL glossary (labels, alternate labels, definitions). Pass several queries at once (at most 14 per call); each returns up to `limit` (default 5, at most 8) concepts as {id, label, category, definition}. category is the referent category: what kind of thing the concept classifies.",
    inputSchema: { type: "object", properties: { queries: { type: "array", items: { type: "string" } }, limit: { type: "number" } }, required: ["queries"] },
    run(w, input) {
      const qs = list(input.queries || input.query).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 14);
      if (!qs.length) throw new Error("Give queries: an array of search strings.");
      const n = Math.max(1, Math.min(8, Number(input.limit) || 5));
      const result = qs.map((q) => ({ query: q, matches: search(q, n).map(({ c }) => ({ id: c.id, label: c.l, category: catLabel(c.rc), definition: short(c.d, 160) })) }));
      const ui = [{ route: "browse" }];
      for (const q of qs.slice(0, 3)) ui.push({ type: "lex.q", text: q }, { focus: ".lex-list .li" });
      if (qs.length > 3) ui.push({ set: "lex.q", value: qs[qs.length - 1] });
      return { result, summary: `${qs.length} ${qs.length === 1 ? "query" : "queries"} · ${result.reduce((s, r) => s + r.matches.length, 0)} matches`, ui };
    },
  },

  read_concepts: {
    description: "Read I2IDL concepts by id (at most 14 per call): definition, I2IDL type, referent category with the reason it was assigned, and broader / narrower / related concepts. Read a concept before you classify with it, propose a mapping for it, or vote on one.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
    run(w, input) {
      const ids = [...new Set(list(input.ids || input.id).map(String))].slice(0, 14);
      if (!ids.length) throw new Error("Give ids: an array of concept ids.");
      const result = ids.map((id) => {
        const c = byId.get(id);
        if (!c) return { id, error: "No such concept in this release. Search first." };
        return {
          id, label: c.l, definition: short(c.d, 440), i2idlType: typeById.get(c.t).label, category: catLabel(c.rc),
          categoryFrom: c.rb === "t" ? "I2IDL's type" : "its definition", categoryReason: short(c.rw, 240),
          broader: c.b.map(conceptLabel), narrower: c.n.slice(0, 6).map(conceptLabel), related: c.r.slice(0, 6).map(conceptLabel),
        };
      });
      const ui = [];
      for (const id of ids.filter((x) => byId.has(x)).slice(0, 3)) ui.push({ route: "c-" + id }, { focus: ".definition" }, { focus: 'section[aria-label="What it classifies"]' });
      return { result, summary: ids.map(conceptLabel).slice(0, 4).join(", ") + (ids.length > 4 ? ` +${ids.length - 4}` : ""), ui };
    },
  },

  classify_records: {
    description: "Classify records: for each item, link the record with i2x:isClassifiedBy to the I2IDL concept(s) it IS AN INSTANCE OF, with a one-sentence rationale. Optional about: concepts the record is only about (dct:subject; no typing). Replaces any earlier classification of that record. Classify many records in one call.",
    inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: {
      record: { type: "string" }, concepts: { type: "array", items: { type: "string" } }, about: { type: "array", items: { type: "string" } }, rationale: { type: "string" } },
      required: ["record", "concepts", "rationale"] } } }, required: ["items"] },
    run(w, input, agent) {
      const items = list(input.items);
      if (!items.length) throw new Error("Give items: [{record, concepts, rationale}].");
      const done = [], errors = [];
      for (const it of items) {
        try {
          const r = recordOrThrow(w, it.record);
          const concepts = conceptsOrThrow(it.concepts);
          if (!concepts.length) throw new Error(`No concepts for ${r.id}; flag a gap instead.`);
          r.concepts = concepts; r.about = it.about ? conceptsOrThrow(it.about) : []; r.rationale = short(String(it.rationale || ""), 400); r.by = agent; r.status = "classified";
          w.gaps.delete(r.id);
          done.push({ record: r.id, concepts: concepts.map((c) => `${conceptLabel(c)} (${catLabel(byId.get(c).rc)})`) });
        } catch (e) { errors.push({ record: String(it.record), error: e.message }); }
      }
      const remaining = liveRecords(w).filter((r) => r.status === "unclassified").map((r) => r.id);
      return { result: { classified: done, ...(errors.length ? { errors } : {}), stillUnclassified: remaining },
        summary: `${done.length} classified${errors.length ? ` · ${errors.length} errors` : ""}`, ui: playUi(w, done[0] && iriOfRecord(done[0].record)) };
    },
  },

  flag_gap: {
    description: "Record that no I2IDL concept fits a record: what the thing is, the nearest concepts and why they don't fit, and any peer-vocabulary class that does name it. The gap goes to I2IDL's editors as a suggestion; the record stays unclassified.",
    inputSchema: { type: "object", properties: { record: { type: "string" }, note: { type: "string" }, nearest: { type: "array", items: { type: "string" } }, peerClasses: { type: "array", items: { type: "string" } } }, required: ["record", "note"] },
    run(w, input, agent) {
      const r = recordOrThrow(w, input.record);
      const nearest = list(input.nearest).map(String).filter((id) => byId.has(id)).slice(0, 4);
      const peers = list(input.peerClasses).map(String).slice(0, 4);
      w.gaps.set(r.id, { note: short(String(input.note || ""), 500), nearest, peers, by: agent });
      r.concepts = []; r.status = "gap";
      return { result: { record: r.id, flagged: true, nearest: nearest.map(conceptLabel), ...(peers.length ? { peerClasses: peers } : {}) },
        summary: `gap: ${r.title}`, ui: nearest.length ? [{ route: "c-" + nearest[0] }, { focus: ".headword" }] : [] };
    },
  },

  run_classifier: {
    via: "q-classify",
    description: "Run the catalog's classifier (q-classify) over the classified inventory: every record classified by an I2IDL concept — or typed with a peer class a crosswalk bridge ties to one — is typed in BFO 2020 (with IAO and CCO), gist, DOLCE-UltraLite, gUFO, PROV-O, schema.org and peer vocabularies. Reports typings and contradictions (two categories an upper ontology makes disjoint).",
    run(w) {
      requireControl(w, "q-classify");
      const out = runClassifier(w);
      w.runs++;
      w.clashesSeen = Math.max(w.clashesSeen, out.resources.filter((r) => r.clashes.length).length);
      const result = { resources: out.resources.length, typings: out.typings, clashes: out.clashes, byOntology: byOntology(out), records: out.resources.map(resourceView) };
      const clash = out.resources.find((r) => r.clashes.length);
      const ui = playUi(w, null);
      if (clash) ui.push({ focus: `.rescard[data-iri="${clash.iri}"]` });
      return { result, summary: `${out.typings} typings · ${out.clashes ? out.clashes + (out.clashes === 1 ? " contradiction" : " contradictions") : "no contradictions"}`, ui };
    },
  },

  explain_category: {
    description: "One referent category (by id or label, e.g. 'resource' or 'Learning resource'): its definition, OWL class, the classes its members get in each ontology, and the categories it can never share a member with (and in which ontologies).",
    inputSchema: { type: "object", properties: { category: { type: "string" } }, required: ["category"] },
    run(w, { category }) {
      const key = String(category || "").toLowerCase();
      const cat = catById.get(key) || [...catById.values()].find((c) => c.label.toLowerCase() === key);
      if (!cat) throw new Error(`No referent category "${category}".`);
      const cls = {};
      for (const x of classesOf(cat.id)) {
        const col = columnOf(x.t) === "foxxi" ? "peer" : columnOf(x.t);
        if (col === "i2x" || col === "other") continue;
        (cls[COLUMN_LABEL[col] || col] = cls[COLUMN_LABEL[col] || col] || []).push(labelOf(x.t));
      }
      const result = { id: cat.id, label: cat.label, definition: cat.def, owlClass: cat.cls, members: cls,
        neverAlso: disjointWith(cat.id).slice(0, 14).map((d) => `${catLabel(d.id)} (${Object.keys(d.why).join(", ")})`), concepts: conceptsIn(cat.id).length };
      return { result, summary: cat.label, ui: [{ route: "semantic-cat." + cat.id }, { focus: ".catd" }] };
    },
  },

  request_fix: {
    description: "Ask the Lexicographer to fix a record: what is wrong (the contradiction or problem) and what the record should become — e.g. split it into the separate things it describes, or drop a concept it is not an instance of.",
    inputSchema: { type: "object", properties: { record: { type: "string" }, problem: { type: "string" }, suggestion: { type: "string" } }, required: ["record", "problem", "suggestion"] },
    run(w, input, agent) {
      const r = recordOrThrow(w, input.record);
      const id = "fix-" + (w.fixes.length + 1);
      w.fixes.push({ id, record: r.id, problem: short(String(input.problem || ""), 500), suggestion: short(String(input.suggestion || ""), 500), by: agent, status: "open" });
      return { result: { fix: id, record: r.id, assignedTo: "Lexicographer", status: "open" }, summary: `${id} → Lexicographer: ${r.title}`, ui: [] };
    },
  },

  split_record: {
    description: "Split a record that describes more than one thing into parts (2 or 3), each with its own new id (lowercase-hyphen slug), title, concepts it is an instance of, and rationale; a part no I2IDL concept fits takes a gap note instead of concepts. Optionally link two parts with prov:used, dct:hasPart, dct:isPartOf or dct:relation. The original record keeps no classification; each part cites it with dct:source.",
    inputSchema: { type: "object", properties: {
      record: { type: "string" },
      into: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, concepts: { type: "array", items: { type: "string" } }, rationale: { type: "string" }, gap: { type: "string" } }, required: ["id", "title"] } },
      link: { type: "object", properties: { from: { type: "string" }, predicate: { type: "string" }, to: { type: "string" } } } }, required: ["record", "into"] },
    run(w, input, agent) {
      const r = recordOrThrow(w, input.record);
      const parts = list(input.into);
      if (parts.length < 2 || parts.length > 3) throw new Error("Split into 2 or 3 parts.");
      const made = parts.map((p) => {
        const id = String(p.id || "").trim();
        if (!slugOk(id) || w.records.has(id)) throw new Error(`Part id "${id}" must be a new lowercase-hyphen slug.`);
        const concepts = conceptsOrThrow(p.concepts);
        const gap = String(p.gap || "").trim();
        if (!concepts.length && !gap) throw new Error(`Part ${id} needs at least one concept, or a gap note.`);
        return { id, title: short(String(p.title || id), 120), source: r.source, sourceTypes: [], description: `Split from “${r.title}”.`,
          concepts, about: [], rationale: short(String(p.rationale || ""), 400), by: agent, status: concepts.length ? "classified" : "gap", parts: null, from: r.id,
          gap: concepts.length ? null : short(gap, 500) };
      });
      if (new Set(made.map((m) => m.id)).size !== made.length) throw new Error("Part ids must differ.");
      const at = w.order.indexOf(r.id);
      for (const m of made) {
        if (m.gap) w.gaps.set(m.id, { note: m.gap, nearest: [], peers: [], by: agent });
        delete m.gap;
        w.records.set(m.id, m);
      }
      w.order.splice(at + 1, 0, ...made.map((m) => m.id));
      r.status = "split"; r.parts = made.map((m) => m.id); r.concepts = [];
      let link = null;
      if (input.link && input.link.predicate) {
        const p = String(input.link.predicate);
        const ids = made.map((m) => m.id);
        if (!LINK_PREDICATES[p]) throw new Error(`Link predicate must be one of ${Object.keys(LINK_PREDICATES).join(", ")}.`);
        if (!ids.includes(String(input.link.from)) || !ids.includes(String(input.link.to))) throw new Error("Link must connect two of the new parts.");
        link = { s: String(input.link.from), p, o: String(input.link.to) };
        w.links.push(link);
      }
      const closed = w.fixes.filter((f) => f.record === r.id && f.status === "open");
      closed.forEach((f) => { f.status = "done"; });
      w.fixedClashes += closed.length;
      return { result: { record: r.id, splitInto: made.map((m) => ({ id: m.id, title: m.title, ...(m.concepts.length ? { concepts: m.concepts.map(conceptLabel) } : { gap: true }) })), ...(link ? { link: `${link.s} ${link.p} ${link.o}` } : {}), fixesClosed: closed.map((f) => f.id) },
        summary: `${r.title} → ${made.map((m) => m.title).join(" + ")}`, ui: playUi(w, iriOfRecord(made[0].id)) };
    },
  },

  reclassify_record: {
    description: "Replace one record's classification with the given concepts (and optional about concepts), with a rationale. Closes any open fix request on that record.",
    inputSchema: { type: "object", properties: { record: { type: "string" }, concepts: { type: "array", items: { type: "string" } }, about: { type: "array", items: { type: "string" } }, rationale: { type: "string" } }, required: ["record", "concepts", "rationale"] },
    run(w, input, agent) {
      const r = recordOrThrow(w, input.record);
      const concepts = conceptsOrThrow(input.concepts);
      if (!concepts.length) throw new Error("Give at least one concept, or flag a gap.");
      r.concepts = concepts; r.about = input.about ? conceptsOrThrow(input.about) : []; r.rationale = short(String(input.rationale || ""), 400); r.by = agent; r.status = "classified";
      const closed = w.fixes.filter((f) => f.record === r.id && f.status === "open");
      closed.forEach((f) => { f.status = "done"; });
      w.fixedClashes += closed.length;
      return { result: { record: r.id, concepts: concepts.map(conceptLabel), ...(r.about.length ? { about: r.about.map(conceptLabel) } : {}), fixesClosed: closed.map((f) => f.id) },
        summary: `${r.title} → ${concepts.map(conceptLabel).join(", ")}`, ui: playUi(w, iriOfRecord(r.id)) };
    },
  },

  list_classified: {
    description: "The inventory as classified so far: each record with the concepts it is classified by, plus flagged gaps.",
    run(w) {
      const result = {
        records: liveRecords(w).filter((r) => r.concepts.length).map((r) => ({ record: r.id, title: r.title, concepts: r.concepts.map((id) => ({ id, label: conceptLabel(id) })) })),
        gaps: [...w.gaps.entries()].map(([id, g]) => ({ record: id, nearest: g.nearest.map(conceptLabel), note: g.note })),
      };
      return { result, summary: `${result.records.length} classified · ${result.gaps.length} gaps`, ui: [] };
    },
  },

  find_crosswalks: {
    description: "For I2IDL concept ids: the crosswalk proposals they already have (predicate, target, vocabulary, confidence), the OWL bridges those make, proposals made in this run, the peer classes their referents are already typed with, and the classes their category says to publish descriptions as (export targets).",
    inputSchema: { type: "object", properties: { concepts: { type: "array", items: { type: "string" } } }, required: ["concepts"] },
    run(w, input) {
      const ids = conceptsOrThrow(input.concepts).slice(0, 6);
      const result = ids.map((id) => {
        const c = byId.get(id);
        const cat = catById.get(c.rc);
        return {
          concept: id, label: c.l, category: cat.label,
          existing: (mapsByConcept.get(id) || []).map((m) => ({ predicate: "skos:" + m.p, target: curieOf(m.o), targetLabel: m.ol || null, vocabulary: m.v, confidence: m.cf, status: "proposed (Hypothetical)" })),
          bridges: bridgesOf(id).map((b) => `${b.k}Match ${b.t} (${b.m})`),
          proposedThisRun: w.items.filter((i) => i.c === id).map((i) => `${i.key}: skos:${i.rec.p} ${curieOf(i.rec.o)} — ${consensus(tallyOf(w, i.key), QUORUM)}`),
          alreadyTypedAs: classesOf(cat.id).filter((x) => ["peer", "foxxi"].includes(columnOf(x.t))).map((x) => x.t),
          publishAs: cat.ex,
        };
      });
      return { result, summary: ids.map(conceptLabel).join(", "),
        ui: [{ route: "c-" + ids[0] }, { focus: ['section[aria-label="Crosswalk proposals"]', 'section[aria-label="What it classifies"]'] }] };
    },
  },

  check_peer_term: {
    description: "Check that a peer-vocabulary term exists (CURIE such as ceterms:Credential, or full IRI) against the vocabulary snapshots and term indexes the I2IDL-X build pins. Returns its label and vocabulary, or says it cannot be confirmed.",
    inputSchema: { type: "object", properties: { term: { type: "string" } }, required: ["term"] },
    run(w, { term }) {
      const t = String(term || "").trim();
      const iri = t.includes("://") ? t : expand(t);
      const hit = VERIFIED.get(iri);
      const curie = curieOf(iri);
      const v = vocabOf(curie);
      const result = hit ? { term: curie, iri, exists: true, label: hit.label, vocabulary: (v && v.title) || hit.vocabulary || null, ...(hit.definition ? { definition: short(hit.definition, 300) } : {}) }
        : { term: curie, iri, exists: false, note: "Not in the pinned snapshots or term indexes, so I2IDL-X cannot confirm it exists. Propose only a confirmed term." };
      return { result, summary: `${curie}: ${hit ? "confirmed" : "not confirmed"}`, ui: [] };
    },
  },

  propose_mapping: {
    via: "port-propose-mapping",
    description: "Propose a SKOS crosswalk from an I2IDL concept to a confirmed peer term, through the catalog's port-propose-mapping: predicate (exactMatch, closeMatch, broadMatch, narrowMatch, relatedMatch), confidence 0–1 and a one-sentence rationale. It is published Hypothetical and enters review; once ratified, an exact, broad or narrow match to a class becomes an OWL bridge the classifier uses.",
    inputSchema: { type: "object", properties: { concept: { type: "string" }, predicate: { type: "string" }, target: { type: "string" }, confidence: { type: "number" }, rationale: { type: "string" } }, required: ["concept", "predicate", "target", "confidence", "rationale"] },
    run(w, input, agent) {
      requireControl(w, "port-propose-mapping");
      const [cid] = conceptsOrThrow([input.concept]);
      const p = String(input.predicate || "").replace(/^skos:/, "");
      if (!PREDICATES.includes(p)) throw new Error(`predicate must be one of ${PREDICATES.join(", ")}.`);
      const t = String(input.target || "").trim();
      const iri = t.includes("://") ? t : expand(t);
      const hit = VERIFIED.get(iri);
      if (!hit) throw new Error(`${t} is not a confirmed peer term (check_peer_term). Propose only to a term I2IDL-X can confirm.`);
      const cf = Math.round(Math.max(0, Math.min(1, Number(input.confidence))) * 100) / 100;
      const why = String(input.rationale || "").trim();
      if (why.length < 8) throw new Error("Give a one-sentence rationale.");
      if (w.items.some((i) => i.c === cid && i.rec.o === iri && i.rec.p === p)) throw new Error("That proposal already exists in this run.");
      const id = "orc-" + (w.items.length + 1);
      const key = "m." + id;
      const graph = OWNER_GRAPH(ORG.slug + "-crosswalks");
      const subject = `urn:interpretant:${ORG.slug}:proposal:${id}`; // the graph IRI waits for your pod; the record's own IRI does not
      const v = vocabOf(curieOf(iri));
      const rec = { id, c: cid, p, o: iri, v: (v && v.short) || hit.vocabulary || curieOf(iri).split(":")[0], ol: hit.label, od: hit.definition || null, cf, w: short(why, 400), s: "proposed", m: "ai-drafted" };
      w.items.push({ key, type: "mapping", rec, c: cid, iri: subject, sandbox: true, by: agent });
      const ttl = `@prefix i2x: <${META.ns}> .\n@prefix i2idl: <https://id.i2idl.org/concepts/> .\n@prefix skos: <${SKOS}> .\n@prefix prov: <http://www.w3.org/ns/prov#> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n\n<${subject}> a i2x:MappingProposal ;\n    i2x:proposedSubject i2idl:${cid} ; i2x:proposedPredicate skos:${p} ; i2x:proposedObject <${iri}> ;\n    i2x:rationale ${lit(rec.w)}@en ;\n    i2x:confidence "${cf}"^^xsd:decimal ; i2x:reviewStatus i2x:status-proposed ;\n    i2x:mappingMethod i2x:method-ai-drafted ;\n    prov:wasAttributedTo <urn:interpretant:agent:${agent}> .\n`;
      const call = stage(w, agent, "port-propose-mapping", `Crosswalk proposal ${id}`, { graph_iri: graph, graph_content: ttl, modal_status: "Hypothetical", conforms_to_shapes: [META.shapes], visibility: "shared" });
      return { result: { item: key, proposal: `${conceptLabel(cid)} skos:${p} ${curieOf(iri)} (${hit.label})`, modalStatus: "Hypothetical", review: `needs ${QUORUM} votes for, and more for than against`, stagedCall: call },
        summary: `${key}: skos:${p} ${curieOf(iri)}`, ui: [{ route: "review-" + key }, { focus: `[data-key="${key}"]` }] };
    },
  },

  read_proposal: {
    description: "Read a crosswalk proposal under review by item key (e.g. m.orc-1): the I2IDL concept and its definition, the predicate, the target with its vocabulary and label, confidence, rationale, the concept's other crosswalks, the review policy and the current tally.",
    inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
    run(w, { item }) {
      const it = w.items.find((i) => i.key === String(item));
      if (!it) throw new Error(`No proposal "${item}" in this run. The Crosswalker's handoff names it.`);
      const c = byId.get(it.c), r = it.rec, t = tallyOf(w, it.key);
      const result = {
        item: it.key, proposedBy: (agentById.get(it.by) || {}).name || it.by, method: "AI-drafted",
        concept: { id: c.id, label: c.l, definition: short(c.d, 400), category: catLabel(c.rc) },
        predicate: "skos:" + r.p, target: { term: curieOf(r.o), label: r.ol, vocabulary: r.v, ...(r.od ? { definition: short(r.od, 300) } : {}) },
        confidence: r.cf, rationale: r.w,
        otherCrosswalks: (mapsByConcept.get(c.id) || []).map((m) => `skos:${m.p} ${curieOf(m.o)} (${m.v})`),
        ifRatified: ["exactMatch", "broadMatch", "narrowMatch"].includes(r.p) ? `It becomes an OWL bridge: anything classified by ${c.l} is ${r.p === "narrowMatch" ? "inferred from" : "also typed"} ${curieOf(r.o)}.` : "It stays a SKOS link; a reasoner draws no typing from it.",
        policy: `ratified when at least ${QUORUM} vote for and for outnumbers against`, tally: { for: t.for.length, against: t.against.length, abstain: t.abstain.length },
      };
      return { result, summary: it.key, ui: [{ route: "review-" + it.key }, { focus: `[data-key="${it.key}"]` }] };
    },
  },

  cast_vote: {
    via: "port-ratify",
    description: "Vote on a proposal through the catalog's port-ratify: for (published Asserted), against (Counterfactual) or abstain (Hypothetical), with a one-sentence reason. Returns the tally and the consensus under the review policy.",
    inputSchema: { type: "object", properties: { item: { type: "string" }, vote: { type: "string", enum: ["for", "against", "abstain"] }, note: { type: "string" } }, required: ["item", "vote", "note"] },
    run(w, input, agent) {
      requireControl(w, "port-ratify");
      const it = w.items.find((i) => i.key === String(input.item));
      if (!it) throw new Error(`No proposal "${input.item}" in this run.`);
      const vote = String(input.vote || "").toLowerCase();
      if (!VOTES[vote]) throw new Error("vote must be for, against or abstain.");
      const note = short(String(input.note || "").trim(), 600);
      if (!note) throw new Error("Give a one-sentence reason.");
      const doc = w.ballots.get(agent) || { v: {} };
      doc.v[it.key] = { vote, note, at: Date.now() };
      w.ballots.set(agent, doc);
      const id = `urn:interpretant:${ORG.slug}:vote:${it.rec.id}:${agent}`;
      const ttl = `@prefix i2x: <${META.ns}> .\n@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n@prefix prov: <http://www.w3.org/ns/prov#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n\n<${id}> a i2x:RatificationVote ;\n    i2x:votesOn <${it.iri}> ;\n    i2x:vote ${VOTES[vote].iep} ;\n    prov:wasAttributedTo <urn:interpretant:agent:${agent}> ;\n    prov:generatedAtTime "${new Date(doc.v[it.key].at).toISOString().replace(/\.\d{3}Z$/, "Z")}"^^xsd:dateTime ;\n    rdfs:comment ${lit(note)}@en .\n`;
      const call = stage(w, agent, "port-ratify", `Vote on ${it.rec.id}`, { graph_iri: OWNER_GRAPH(`${ORG.slug}-vote-${it.rec.id}-${agent}`), graph_content: ttl, modal_status: VOTES[vote].modal, conforms_to_shapes: [META.shapes] });
      const t = tallyOf(w, it.key);
      const s = consensus(t, QUORUM);
      return { result: { item: it.key, vote, modalStatus: VOTES[vote].modal, tally: { for: t.for.length, against: t.against.length, abstain: t.abstain.length }, consensus: s, stagedCall: call },
        summary: `${vote} · ${s}`, ui: [{ route: "review-" + it.key }, { focus: `[data-key="${it.key}"] .vb.${vote}`, click: true }, { focus: `[data-key="${it.key}"]` }] };
    },
  },

  create_pack: {
    description: "Create a pack (a course glossary) from I2IDL concept ids in teaching order, with a name, audience, description and an optional one-line note per concept ({id: note}).",
    inputSchema: { type: "object", properties: { name: { type: "string" }, audience: { type: "string" }, description: { type: "string" }, concepts: { type: "array", items: { type: "string" } }, notes: { type: "object" } }, required: ["name", "concepts"] },
    run(w, input, agent) {
      const ids = conceptsOrThrow(input.concepts);
      if (!ids.length) throw new Error("Give concepts.");
      const notes = input.notes && typeof input.notes === "object" ? input.notes : {};
      const id = "orc-pack-" + (w.packs.length + 1);
      const now = Date.now();
      const pack = { id, name: short(String(input.name || "Onboarding glossary"), 80), desc: short(String(input.description || ""), 400), audience: short(String(input.audience || ""), 80),
        created: now, updated: now, items: ids.map((x) => ({ id: x, note: short(String(notes[x] || ""), 200) })), by: agent };
      w.packs.push(pack);
      return { result: { pack: id, name: pack.name, terms: ids.length, order: ids.map(conceptLabel) }, summary: `${pack.name} · ${ids.length} terms`, ui: [{ route: "packs-" + id }, { focus: ".pk" }] };
    },
  },

  suggest_additions: {
    description: "Concepts I2IDL relates to a pack's terms (related, broader, narrower) that the pack does not have yet, best first, with which pack terms point to them.",
    inputSchema: { type: "object", properties: { pack: { type: "string" } }, required: ["pack"] },
    run(w, { pack }) {
      const p = w.packs.find((x) => x.id === String(pack));
      if (!p) throw new Error(`No pack "${pack}".`);
      const have = p.items.map((i) => i.id);
      const result = suggestForPack(p, 8).map(({ id }) => ({ id, label: conceptLabel(id), relatedTo: have.filter((h) => { const c = byId.get(h); return c.r.includes(id) || c.b.includes(id) || c.n.includes(id); }).map(conceptLabel).slice(0, 3) }));
      return { result, summary: `${result.length} suggestions`, ui: [{ route: "packs-" + p.id }, { focus: ".pk" }] };
    },
  },

  add_to_pack: {
    description: "Add concepts to a pack, at the end or after a given concept, with optional one-line notes ({id: note}).",
    inputSchema: { type: "object", properties: { pack: { type: "string" }, concepts: { type: "array", items: { type: "string" } }, after: { type: "string" }, notes: { type: "object" } }, required: ["pack", "concepts"] },
    run(w, input) {
      const p = w.packs.find((x) => x.id === String(input.pack));
      if (!p) throw new Error(`No pack "${input.pack}".`);
      const ids = conceptsOrThrow(input.concepts).filter((id) => !p.items.some((i) => i.id === id));
      const notes = input.notes && typeof input.notes === "object" ? input.notes : {};
      const add = ids.map((x) => ({ id: x, note: short(String(notes[x] || ""), 200) }));
      const at = input.after ? p.items.findIndex((i) => i.id === String(input.after)) : -1;
      p.items = at >= 0 ? [...p.items.slice(0, at + 1), ...add, ...p.items.slice(at + 1)] : [...p.items, ...add];
      p.updated = Date.now();
      return { result: { pack: p.id, added: ids.map(conceptLabel), terms: p.items.length }, summary: `+${ids.length} → ${p.items.length} terms`, ui: [{ route: "packs-" + p.id }, { focus: ".pk" }] };
    },
  },

  validate_publication: {
    description: "Check the context graph before staging it: every record classified or flagged as a gap, no contradictions, no open fix requests, every concept a real I2IDL concept, and where the crosswalk review stands. Also reports the typings ratified crosswalks added.",
    run(w) {
      const out = runClassifier(w);
      const base = classify(worldTurtle(w));
      const problems = [];
      const live = liveRecords(w);
      const un = live.filter((r) => r.status === "unclassified");
      if (un.length) problems.push(`${un.length} records unclassified: ${un.map((r) => r.id).join(", ")}`);
      if (out.clashes) problems.push(`${out.clashes} contradictions remain`);
      const open = w.fixes.filter((f) => f.status === "open");
      if (open.length) problems.push(`${open.length} fix requests open`);
      for (const r of out.resources) for (const p of r.problems) problems.push(p.text);
      const added = [];
      for (const r of out.resources) {
        const b = base.resources.find((x) => x.iri === r.iri);
        const had = new Set(b ? b.classes.map((x) => x.t) : []);
        const extra = r.classes.filter((x) => !had.has(x.t)).map((x) => x.t);
        if (extra.length) added.push({ record: localId(r.iri), nowAlsoTyped: extra });
      }
      const result = {
        ready: !problems.length, problems,
        records: { total: live.length, classified: live.filter((r) => r.status === "classified").length, gaps: w.gaps.size, splitFrom: [...w.records.values()].filter((r) => r.status === "split").map((r) => r.id) },
        typings: out.typings, clashes: out.clashes,
        proposals: w.items.map((i) => ({ item: i.key, consensus: consensus(tallyOf(w, i.key), QUORUM) })),
        fromRatifiedCrosswalks: added, packs: w.packs.map((p) => `${p.name} (${p.items.length} terms)`),
      };
      return { result, summary: result.ready ? "ready" : `${problems.length} problems`, ui: playUi(w, added[0] && iriOfRecord(added[0].record)) };
    },
  },

  stage_publication: {
    via: "port-publish-classified",
    description: "Stage the context graph as the publish_context call the catalog's port-publish-classified declares: the academy's classified inventory as Turtle, graph IRI on the academy's own pod, modal status Asserted, the I2IDL-X shapes to validate against, and visibility (default private). Staged only; it is sent when the human approves.",
    inputSchema: { type: "object", properties: { visibility: { type: "string", enum: ["private", "shared", "public"] } } },
    run(w, input, agent) {
      requireControl(w, "port-publish-classified");
      const out = runClassifier(w);
      if (out.clashes || liveRecords(w).some((r) => r.status === "unclassified")) throw new Error("Not ready: validate_publication reports problems. Resolve them first.");
      const visibility = ["private", "shared", "public"].includes(String(input.visibility)) ? String(input.visibility) : "private";
      const ttl = worldTurtle(w);
      const call = stage(w, agent, "port-publish-classified", `${ORG.short} context graph`, { graph_iri: OWNER_GRAPH(ORG.slug), graph_content: ttl, modal_status: "Asserted", visibility, conforms_to_shapes: [META.shapes] });
      const triples = classify(ttl).triples;
      return { result: { stagedCall: call, port: "port-publish-classified", graph: OWNER_GRAPH(ORG.slug), modalStatus: "Asserted", visibility, conformsTo: META.shapes, statements: triples },
        summary: `${call} · ${visibility}`, ui: [{ route: "agents-port-publish-classified" }, { focus: "#port-publish-classified", click: true }] };
    },
  },

  request_approval: {
    description: "Ask the human to approve every staged call, with a short summary of what each does. The human decides after your turn ends; nothing is sent before they approve.",
    inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    run(w, input, agent) {
      const calls = w.staged.filter((s) => s.status === "staged").map((s) => s.id);
      if (!calls.length) throw new Error("Nothing is staged.");
      w.gate = { id: "gate-1", summary: short(String(input.summary || ""), 900), calls, by: agent, status: "pending" };
      return { result: { gate: "gate-1", calls: calls.length, status: "pending: the human decides after your turn" }, summary: `${calls.length} calls await approval`, ui: [{ gate: true }] };
    },
  },

  run_summary: {
    description: "Everything the run produced, for the report: records and how they were classified, typings by ontology, contradictions caught and fixed, gaps, proposals and votes, packs, staged calls and the human's decision.",
    run(w) {
      const out = runClassifier(w);
      const live = liveRecords(w);
      const result = {
        records: live.map((r) => ({ id: r.id, status: r.status, concepts: r.concepts.map(conceptLabel), ...(r.from ? { splitFrom: r.from } : {}) })),
        typings: out.typings, byOntology: byOntology(out), recordsWithContradictions: w.clashesSeen, fixesApplied: w.fixedClashes,
        gaps: [...w.gaps.entries()].map(([id, g]) => ({ record: id, nearest: g.nearest.map(conceptLabel), ...(g.peers.length ? { peerClasses: g.peers } : {}) })),
        proposals: w.items.map((i) => { const t = tallyOf(w, i.key); return { item: i.key, proposal: `${conceptLabel(i.c)} skos:${i.rec.p} ${curieOf(i.rec.o)}`, consensus: consensus(t, QUORUM), votes: { for: t.for.length, against: t.against.length, abstain: t.abstain.length } }; }),
        packs: w.packs.map((p) => ({ name: p.name, terms: p.items.length })),
        staged: w.staged.map((s) => ({ id: s.id, port: s.port, title: s.title, status: s.status })),
        humanDecision: w.gate ? w.gate.status : "not asked",
      };
      return { result, summary: `${out.typings} typings · ${w.staged.length} staged`, ui: [] };
    },
  },
};

/** Run one tool for an agent. Returns {ok, result | error, summary, ui}. Never throws. */
export function callTool(w, name, input, agent, allowed) {
  const tool = TOOLS[name];
  try {
    if (!tool) throw new Error(`No tool "${name}".`);
    if (allowed && !allowed.includes(name)) throw new Error(`${name} is not one of this step's tools.`);
    const out = tool.run(w, input && typeof input === "object" ? input : {}, agent);
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), summary: "error", ui: [] };
  }
}

/** The human's decision at the gate. Approving marks the staged calls approved; nothing is sent from the page. */
export function decideGate(w, decision) {
  if (!w.gate) return;
  w.gate.status = decision;
  for (const s of w.staged) if (w.gate.calls.includes(s.id)) s.status = decision;
}

/** Schemas for the sample capability's tools option. */
export function toolSpecs(names) {
  return names.map((n) => ({ name: n, description: TOOLS[n].description, ...(TOOLS[n].inputSchema ? { inputSchema: TOOLS[n].inputSchema } : {}) }));
}
