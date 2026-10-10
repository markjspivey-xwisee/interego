// Citations, packs and payload builders shared by the entry, packs and agent views.
import { META, byId, iriOf, SOURCES, directSources, allSources, RIGHTS, reuseClass, PORTS } from "./data.js";
import { uid } from "./util.js";

const year = () => (META.commitDate || "").slice(0, 4) || "2026";
const publisher = () => META.license.holder.replace(/^©\s*\d{4}\s*/, "");

export function citeText(c) {
  return `${publisher()}. (${year()}). ${c.l}. In ${META.scheme.title} (release ${META.release}). ${iriOf(c.id)}`;
}
export const citeMarkdown = (c) => `[${c.l}](${iriOf(c.id)}) — ${META.scheme.title}, ${META.release}`;
export function citeBibtex(c) {
  return `@misc{i2idl_${c.id.replace(/-/g, "_")},
  title        = {${c.l}},
  author       = {{${publisher()}}},
  howpublished = {${META.scheme.title}, release ${META.release}},
  year         = {${year()}},
  url          = {${iriOf(c.id)}},
  note         = {${META.license.name} for I2IDL-original content; source-specific rights apply}
}`;
}
export function quoteWithAttribution(c) {
  const src = directSources(c);
  const grounded = src.length ? ` Grounded in: ${src.map((s) => `${s.label} (${s.rights})`).join("; ")}.` : "";
  return `“${c.d}”\n— ${c.l}, ${META.scheme.title} (${META.release}), ${iriOf(c.id)}. ${META.license.holder}, ${META.license.name}.${grounded}`;
}
export function attributionLines(concepts) {
  const used = new Map();
  for (const c of concepts) for (const s of allSources(c)) used.set(s.id, s);
  const lines = [`Definitions from the ${META.scheme.title} (release ${META.release}), ${META.license.holder}, licensed ${META.license.name} (${META.license.url}) for I2IDL-original content.`];
  for (const s of [...used.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    let line = `${s.cite || s.title}${s.url && !(s.cite || "").includes(s.url) ? ` ${s.url}` : ""} — ${s.rights}${s.rightsUrl ? ` (${s.rightsUrl})` : ""}.`;
    if (s.adapt) line += ` ${s.adapt}`;
    if (s.disclaimer) line += ` ${s.disclaimer}`;
    if (s.thirdParty) line += ` ${s.thirdParty}`;
    lines.push(line);
  }
  return lines;
}
export function rightsSummary(concepts) {
  const by = { open: [], sharealike: [], nc: [], permission: [] };
  for (const c of concepts) by[reuseClass(c)].push(c);
  return by;
}

// ── Packs (course glossaries) ───────────────────────────────────────────────────────────────────
export function newPack(name, ids = []) {
  const now = Date.now();
  return { id: uid(), name: name || "Untitled pack", desc: "", audience: "", created: now, updated: now, items: ids.map((id) => ({ id, note: "" })) };
}
export function addToPack(pack, ids) {
  const have = new Set(pack.items.map((i) => i.id));
  const add = ids.filter((id) => !have.has(id) && byId.has(id));
  return { ...pack, updated: Date.now(), items: [...pack.items, ...add.map((id) => ({ id, note: "" }))] };
}
/** Neighbors of a pack's terms that are not in it yet, most-connected to the pack first. */
export function suggestForPack(pack, limit = 12) {
  const have = new Set(pack.items.map((i) => i.id));
  const score = new Map();
  for (const { id } of pack.items) {
    const c = byId.get(id);
    if (!c) continue;
    for (const x of [...c.r, ...c.b, ...c.n]) if (!have.has(x)) score.set(x, (score.get(x) || 0) + (c.b.includes(x) ? 1.5 : 1));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1] || byId.get(a[0]).l.localeCompare(byId.get(b[0]).l)).slice(0, limit).map(([id, s]) => ({ id, s }));
}

// ── Foxxi usage: an xAPI statement tagged with I2IDL concepts ───────────────────────────────────
export const CONCEPT_IDS_EXT = "https://foxxi-bridge.interego.xwisee.com/ns/foxxi#conceptIds";
export const ADL_VERBS = ["experienced", "completed", "attempted", "answered", "mastered", "passed", "interacted"];
export function usageStatement({ ids, verb = "experienced", activityId, activityName, did }) {
  return {
    id: (crypto.randomUUID ? crypto.randomUUID() : "00000000-0000-4000-8000-" + Date.now().toString(16).padStart(12, "0")),
    timestamp: new Date().toISOString(),
    actor: { objectType: "Agent", account: { homePage: "https://identity.interego.xwisee.com", name: did || "<your authenticated DID>" } },
    verb: { id: "http://adlnet.gov/expapi/verbs/" + verb, display: { "en-US": verb } },
    object: { objectType: "Activity", id: activityId || "urn:example:your-course/activity", definition: { name: { "en-US": activityName || "Your activity" } } },
    context: { extensions: { [CONCEPT_IDS_EXT]: ids.map(iriOf) } },
  };
}
export function usageActCall(stmt) {
  return { descriptor_url: META.foxxiManifest, action_iri: META.actionRoot + "foxxi/write-xapi-statements-signed", payload: { statements: [stmt] }, sign_payload: true };
}

// ── Interego calls for reads ────────────────────────────────────────────────────────────────────
const SPARQL_POST_ACTION = () => PORTS.find((p) => p.id === "port-sparql-post").action;
export const actQuery = (sparql) => ({ descriptor_url: META.iri.catalog, action_iri: SPARQL_POST_ACTION(), payload: sparql });
export const curlQuery = (sparql) => `curl -X POST ${META.endpoint} \\\n  -H 'Content-Type: application/sparql-query' \\\n  -H 'Accept: application/sparql-results+json, text/turtle' \\\n  --data-binary @- <<'SPARQL'\n${sparql.trim()}\nSPARQL`;
export const liveGet = (sparql) => META.endpoint + "?query=" + encodeURIComponent(sparql);
export const pretty = (o) => JSON.stringify(o, null, 2);

// ── Course-concept alignment (Foxxi course graph node → I2IDL) ──────────────────────────────────
export function alignmentTurtle({ courseConcept, id, predicate = "closeMatch", agent }) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return `@prefix i2x:   <${META.ns}> .
@prefix i2idl: <https://id.i2idl.org/concepts/> .
@prefix skos:  <http://www.w3.org/2004/02/skos/core#> .
@prefix prov:  <http://www.w3.org/ns/prov#> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .

<urn:interpretant:alignment:${id}:${Date.now().toString(36)}> a i2x:CourseConceptAlignment ;
    i2x:courseConcept <${courseConcept || "urn:example:your-course/concept/x"}> ;
    i2x:alignedTo i2idl:${id} ;
    i2x:alignmentPredicate skos:${predicate} ;
    i2x:reviewStatus i2x:status-proposed ;
    prov:wasAttributedTo <${agent || "urn:interpretant:reviewer:me"}> ;
    prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
}
export const SOURCES_BY_ID = new Map(SOURCES.map((s) => [s.id, s]));
export { RIGHTS };
