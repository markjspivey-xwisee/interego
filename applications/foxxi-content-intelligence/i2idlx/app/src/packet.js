// The editorial packet: everything I2IDL-X found or proposes, as one Markdown file an I2IDL editor can
// read, forward or turn into issues. Nothing in it changes I2IDL's record.
import { META, C, MAPPINGS, SUGGESTIONS, RELEASES, byId, kindPhrase } from "./data.js";
import { health } from "./health.js";

const md = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const link = (c) => `[${c.l}](https://id.i2idl.org/concepts/${c.id})`;
const ago = (iso) => { try { return new Date(iso).toISOString().slice(0, 10); } catch { return iso; } };

/** status(key) → this page's consensus label for a review item (default: "proposed"). */
export function editorialPacket({ status = () => "proposed" } = {}) {
  const H = health();
  const unesco = MAPPINGS.filter((m) => m.v === "UNESCO Thesaurus");
  const others = MAPPINGS.filter((m) => m.v !== "UNESCO Thesaurus");
  const g = C.filter((c) => c.pv === "g").length;
  const L = [];
  const p = (...xs) => L.push(...xs);
  p(`# Editorial packet — ${META.scheme.title} ${META.release}`, "",
    `Prepared with Interpretant / I2IDL-X from commit \`${META.commit.slice(0, 7)}\` of ${META.repo} (${ago(META.commitDate)}).`,
    `Everything below is a candidate for I2IDL's editors to accept, change or ignore. Nothing here alters I2IDL's record: the I2IDL-X layer lives on Interego (${META.base}) and points at I2IDL's IRIs.`,
    `Independent work by Mark Spivey (Foxxi Mediums Inc.); not affiliated with or endorsed by I2IDL.`, "",
    `## At a glance`, "",
    `| Item | Count | Mirrors I2IDL's roadmap |`, `|---|---:|---|`,
    `| Crosswalk candidates to the UNESCO Thesaurus, drawn from I2IDL's own citations | ${unesco.length} | 1. Crosswalks |`,
    `| Other crosswalk candidates (xAPI, xAPI Profiles, IEEE LER, ADL TLA, schema.org, W3C VC, Interego) | ${others.length} | 1. Crosswalks |`,
    `| Definitions showing "${META.upstream.provenance[0]}" | ${g} | 3. Provenance |`,
    `| Definitions showing "${META.upstream.provenance[1]}" | ${C.length - g} | 3. Provenance |`,
    `| Change events since ${META.changes.baseline} (fact-level changes) | ${META.changes.events} (${META.changes.facts}) | 4. Change history |`,
    `| Unlinked mentions: an entry names a concept it does not relate to | ${SUGGESTIONS.length} | — |`, "");

  p(`## 1. UNESCO Thesaurus crosswalk candidates (evidence-cited)`, "",
    `Each I2IDL concept below already cites a UNESCO Thesaurus preferred term as **direct** evidence. I2IDL-X turns that citation into a SKOS mapping candidate and proposes a predicate after reading both texts; editors decide the predicate (the README asks to avoid overstated equivalence, and a citation shows provenance, not necessarily equivalence). UNESCO Thesaurus terms © UNESCO, CC BY-SA 3.0 IGO; snapshot fetched ${ago(META.unesco.fetchedAt)}.`, "",
    `| I2IDL concept | Proposed | UNESCO term | Confidence | Review here |`, `|---|---|---|---:|---|`);
  for (const m of unesco) {
    const c = byId.get(m.c);
    p(`| ${link(c)} | \`skos:${m.p}\` | [${md(m.ol)}](${m.pg}) (\`${m.o.replace("http://vocabularies.unesco.org/thesaurus/", "unesco:")}\`) | ${m.cf.toFixed(2)} | ${status("m." + m.id)} |`);
  }
  p("");
  for (const m of unesco) {
    const c = byId.get(m.c);
    p(`- **${c.l} → ${m.ol}** (\`skos:${m.p}\`). ${m.w}`,
      `  - I2IDL: “${c.d}”`,
      `  - UNESCO ${m.on || "record"}: ${m.od ? "“" + m.od + "”" : "none published"}${m.oa && m.oa.length ? ` · alternative labels: ${m.oa.join(", ")}` : ""}`,
      `  - Cited in \`${m.ci.replace("https://id.i2idl.org/", "")}\``);
  }
  const groupsOnly = META.unesco.groups.filter((x) => x.only);
  if (groupsOnly.length) {
    p("", `**Modeling note.** ${groupsOnly.length} concepts cite only a UNESCO *microthesaurus* page (a group of terms, not a concept), so no SKOS mapping predicate applies: ${groupsOnly.map((x) => `${byId.get(x.c).l} (${x.page.split("/").pop()})`).join(", ")}. Consider also citing a preferred term, or recording the group with \`dcterms:subject\`.`);
  }
  p("", `## 2. Other crosswalk candidates`, "",
    `Standards-text candidates rest on the same normative text (the I2IDL concept cites the specification that defines the external class); AI-drafted candidates need full editorial review. All are published Hypothetical in \`i2idlx-mappings\`; a mapping triple exists only after ratification.`, "");
  const byVocab = new Map();
  for (const m of others) { if (!byVocab.has(m.v)) byVocab.set(m.v, []); byVocab.get(m.v).push(m); }
  for (const [v, list] of byVocab) {
    p(`### ${v}`, "", `| I2IDL concept | Proposed | Target | Method | Confidence | Review here |`, `|---|---|---|---|---:|---|`);
    for (const m of list) p(`| ${link(byId.get(m.c))} | \`skos:${m.p}\` | [${md(m.ol || m.o.split(/[#/]/).pop())}](${m.o}) | ${m.m} | ${m.cf.toFixed(2)} | ${status("m." + m.id)} |`);
    p("");
  }

  p(`## 3. Definition provenance, ready for the cards`, "",
    `Computed from I2IDL's own evidence relations with the wording from I2IDL's README (next priority 3): a definition with at least one **direct** evidence record shows “${META.upstream.provenance[0]}” (${g}); the others show “${META.upstream.provenance[1]}” (${C.length - g}). The same rule is published as SHACL in \`i2idlx-rules\`.`, "",
    `Synthesized definitions: ${H.synth.map((c) => c.l).join(", ")}.`, "");

  p(`## 4. Change history`, "",
    `Derived from the public git history of \`public/glossary.jsonld\` and published as PROV in \`${META.iri.changes}\` (one \`i2x:ReleaseChange\` per release, typed \`i2x:ChangeEvent\`s). It reconciles exactly: the ${META.changes.baseline} baseline plus every addition minus every removal equals ${META.release} for concepts, relationship pairs, memberships, evidence, sources and collections.`, "",
    `| Release | Date | Changes |`, `|---|---|---|`);
  for (const r of RELEASES.slice(1)) {
    const parts = Object.entries(r.ch || {}).map(([k, n]) => kindPhrase(k, n));
    p(`| ${r.v} | ${ago(r.at)} | ${parts.length ? parts.join("; ") : "no change to the graph"} |`);
  }
  p("", `Notes: evidence relations were first assigned in v0.0.60 and v0.0.61 (recorded as *classified*, not *reclassified*); v0.0.62 reclassified 6 records from supporting to direct; v0.0.63 expanded 6 source titles.`, "");

  p(`## 5. Unlinked mentions`, "",
    `An entry's definition or editorial note names another concept that I2IDL does not relate to it (no \`skos:related\`, \`skos:broader\` or \`skos:narrower\`). Candidates only; some are deliberate.`, "");
  const byA = new Map();
  for (const s of SUGGESTIONS) { if (!byA.has(s.a)) byA.set(s.a, []); byA.get(s.a).push(s); }
  for (const [a, list] of [...byA.entries()].sort((x, y) => byId.get(x[0]).l.localeCompare(byId.get(y[0]).l))) {
    const c = byId.get(a);
    p(`- [ ] ${link(c)} names ${list.map((s) => `${link(byId.get(s.b))} (in the ${s.in === "d" ? "definition" : "note"})`).join(", ")}`);
  }
  p("", `## 6. Editorial health`, "",
    `- One-way related links: ${H.asym.length}`, `- Broader links without the inverse narrower: ${H.inv.length}`,
    `- Concepts with no related links: ${H.noRelated.length}${H.noRelated.length ? " — " + H.noRelated.map((c) => c.l).join(", ") : ""}`,
    `- Definitions resting on a single evidence record: ${H.single.length}`,
    `- Labels shared by more than one concept: ${H.altClash.length}${H.altClash.length ? " — " + H.altClash.map((x) => `“${x.form}” (${x.ids.map((id) => byId.get(id).l).join(" / ")})`).join("; ") : ""}`,
    `- Definitions carrying an adaptation notice: ${H.adapted.length}`, "");
  p(`## How to act on this`, "",
    `- Review the candidates together: ${window.__APP_URL__ ? window.__APP_URL__ + "#review-method.evidence-cited" : "the Review view in Interpretant"} (votes compose under Interego's ratification algebra; a ratified crosswalk opens a prefilled issue on ${META.repo}).`,
    `- Or take any line straight into the JSON-LD: I2IDL-X never needs to be in the loop.`,
    `- Graphs: ${META.iri.mappings} (crosswalk proposals), ${META.iri.changes} (change history), ${META.iri.catalog} (agent catalog).`, "");
  return L.join("\n");
}
