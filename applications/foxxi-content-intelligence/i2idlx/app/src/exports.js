// Pack exports: a printable handout, Markdown, CSV, JSON-LD, flashcards, xAPI tags and Foxxi alignments.
import { META, byId, iriOf, kindById, typeById, fieldById, directSources, reuseClass, RIGHTS } from "./data.js";
import { attributionLines, CONCEPT_IDS_EXT, usageStatement } from "./lib.js";
import { escHtml, csvCell, slugify, ttlStr } from "./util.js";

export const FORMATS = [
  { id: "html", label: "Handout", ext: "html", desc: "A printable, styled glossary page with attribution." },
  { id: "md", label: "Markdown", ext: "md", desc: "For docs, LMS pages and READMEs." },
  { id: "csv", label: "CSV", ext: "csv", desc: "One row per term for spreadsheets and LMS imports." },
  { id: "jsonld", label: "JSON-LD", ext: "json", desc: "A skos:Collection pointing at I2IDL IRIs." },
  { id: "cards", label: "Flashcards", ext: "txt", desc: "Tab-separated front/back, importable into Anki and Quizlet." },
  { id: "xapi", label: "xAPI tags", ext: "json", desc: "Foxxi conceptIds for tagging statements." },
  { id: "align", label: "Foxxi alignment", ext: "txt", desc: "Turtle: course concepts aligned to I2IDL, for port-align-course-concept." },
];

const terms = (pack) => pack.items.map((it) => ({ ...it, c: byId.get(it.id) })).filter((t) => t.c);

export function render(format, pack, opts = {}) {
  const ts = terms(pack);
  const cs = ts.map((t) => t.c);
  const att = attributionLines(cs);
  const date = new Date().toISOString().slice(0, 10);
  const name = pack.name || "Glossary";
  switch (format) {
    case "md": {
      let s = `# ${name}\n\n`;
      if (pack.desc) s += `${pack.desc}\n\n`;
      if (pack.audience) s += `*For: ${pack.audience}*\n\n`;
      for (const t of ts) {
        s += `## ${t.c.l}\n\n`;
        if (t.c.a.length) s += `*Also: ${t.c.a.join(", ")}*\n\n`;
        s += `${t.c.d}\n\n`;
        if (opts.notes && t.c.x) s += `> ${t.c.x}\n\n`;
        if (t.note) s += `**In this course:** ${t.note}\n\n`;
        s += `[${iriOf(t.c.id)}](${iriOf(t.c.id)})${opts.sources ? " · " + directOrAll(t.c) : ""}\n\n`;
      }
      s += `---\n\n**Attribution**\n\n${att.map((l) => "- " + l).join("\n")}\n\n*Generated ${date} with Interpretant from ${META.scheme.title} ${META.release}.*\n`;
      return s;
    }
    case "csv": {
      const head = ["term", "also_known_as", "definition", "editorial_note", "course_note", "kind", "type", "field", "iri", "grounded_in", "reuse"];
      const rows = ts.map((t) => [t.c.l, t.c.a.join("; "), t.c.d, opts.notes ? t.c.x : "", t.note || "", kindById.get(t.c.k).label, typeById.get(t.c.t).label,
        fieldById.get(t.c.pf).label, iriOf(t.c.id), directSources(t.c).map((s) => `${s.label} (${s.rights})`).join("; "), RIGHTS[reuseClass(t.c)].label]);
      return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
    }
    case "jsonld": {
      return JSON.stringify({
        "@context": { skos: "http://www.w3.org/2004/02/skos/core#", dct: "http://purl.org/dc/terms/", schema: "https://schema.org/" },
        "@id": `urn:interpretant:pack:${pack.id}`,
        "@type": ["skos:Collection", "schema:DefinedTermSet"],
        "skos:prefLabel": name,
        ...(pack.desc ? { "dct:description": pack.desc } : {}),
        ...(pack.audience ? { "schema:audience": pack.audience } : {}),
        "dct:source": { "@id": META.scheme.iri },
        "dct:rights": att.join(" "),
        "skos:member": ts.map((t) => ({
          "@id": iriOf(t.c.id), "@type": ["skos:Concept", "schema:DefinedTerm"], "skos:prefLabel": t.c.l,
          ...(t.c.a.length ? { "skos:altLabel": t.c.a } : {}), "skos:definition": t.c.d,
          ...(t.note ? { "skos:scopeNote": t.note } : {}), "skos:inScheme": { "@id": META.scheme.iri },
        })),
      }, null, 2);
    }
    case "cards": {
      const clean = (s) => String(s || "").replace(/[\t\r\n]+/g, " ");
      const lines = ts.map((t) => `${clean(t.c.l)}\t${clean(t.c.d)}${t.note ? "<br><br><i>" + clean(t.note) + "</i>" : ""}<br><small>${clean(META.scheme.title)} ${META.release} · ${iriOf(t.c.id)}</small>`);
      return `#separator:tab\n#html:true\n#notetype:Basic\n#tags:i2idl ${slugify(name)}\n` + lines.join("\n") + "\n";
    }
    case "xapi": {
      const ids = ts.map((t) => t.c.id);
      return JSON.stringify({
        comment: `Tag statements with these I2IDL IRIs in Foxxi's conceptIds context extension; each tagged statement is a usage interpretant of every concept it names.`,
        contextExtensions: { [CONCEPT_IDS_EXT]: ids.map(iriOf) },
        exampleStatement: usageStatement({ ids, verb: "experienced", activityId: opts.activityBase ? opts.activityBase.replace(/\/$/, "") + "/glossary" : undefined, activityName: name }),
      }, null, 2);
    }
    case "align": {
      const base = (opts.courseBase || "urn:example:your-course").replace(/\/$/, "");
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      let s = `# ${name}: course concepts aligned to I2IDL (publish through port-align-course-concept; modal status Hypothetical)\n` +
        `@prefix i2x:   <${META.ns}> .\n@prefix i2idl: <https://id.i2idl.org/concepts/> .\n@prefix skos:  <http://www.w3.org/2004/02/skos/core#> .\n` +
        `@prefix prov:  <http://www.w3.org/ns/prov#> .\n@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .\n@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .\n\n`;
      for (const t of ts) {
        s += `<urn:interpretant:alignment:${pack.id}:${t.c.id}> a i2x:CourseConceptAlignment ;\n    i2x:courseConcept <${base}/concept/${t.c.id}> ;\n` +
          `    i2x:alignedTo i2idl:${t.c.id} ;\n    i2x:alignmentPredicate skos:closeMatch ;\n    i2x:reviewStatus i2x:status-proposed ;\n` +
          `    prov:wasAttributedTo <${opts.agent || "urn:interpretant:reviewer:me"}> ;\n    prov:generatedAtTime "${now}"^^xsd:dateTime` +
          (t.note ? ` ;\n    rdfs:comment ${ttlStr(t.note)}@en` : "") + " .\n\n";
      }
      return s;
    }
    case "html":
    default:
      return handout(pack, ts, att, opts, date);
  }
}

function directOrAll(c) {
  const d = directSources(c);
  return d.length ? "Grounded in " + d.map((s) => s.label).join(", ") : "Synthesized";
}

function handout(pack, ts, att, opts, date) {
  const name = escHtml(pack.name || "Glossary");
  const items = ts.map((t, i) => `
  <article class="t">
    <h2><span class="n">${i + 1}</span>${escHtml(t.c.l)}</h2>
    ${t.c.a.length ? `<p class="aka">Also: ${t.c.a.map(escHtml).join(", ")}</p>` : ""}
    <p class="d">${escHtml(t.c.d)}</p>
    ${opts.notes && t.c.x ? `<p class="x">${escHtml(t.c.x)}</p>` : ""}
    ${t.note ? `<p class="cn"><b>In this course:</b> ${escHtml(t.note)}</p>` : ""}
    <p class="m"><a href="${iriOf(t.c.id)}">${iriOf(t.c.id)}</a>${opts.sources ? ` · ${escHtml(directOrAll(t.c))}` : ""}</p>
  </article>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<style>
  :root { color-scheme: light; --ink:#142029; --muted:#5c6d78; --rule:#dde4e8; --accent:#1b6a86; }
  body { margin: 0; background: #fff; color: var(--ink); font: 16px/1.55 Georgia, "Iowan Old Style", serif; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 24px 64px; }
  header { border-bottom: 2px solid var(--ink); padding-bottom: 16px; margin-bottom: 28px; }
  h1 { font-size: 34px; line-height: 1.1; margin: 0 0 8px; }
  .lede { color: var(--muted); margin: 0; }
  .t { padding: 16px 0; border-bottom: 1px solid var(--rule); break-inside: avoid; }
  .t h2 { font-size: 21px; margin: 0 0 4px; display: flex; gap: 10px; align-items: baseline; }
  .n { font: 600 12px/1 system-ui, sans-serif; color: var(--muted); min-width: 18px; }
  .aka { margin: 0 0 6px; color: var(--muted); font-style: italic; }
  .d { margin: 0; }
  .x { margin: 8px 0 0; color: var(--muted); font-size: 15px; }
  .cn { margin: 8px 0 0; padding: 8px 12px; background: #f3f7f9; border-left: 3px solid var(--accent); font-size: 15px; }
  .m { margin: 8px 0 0; font: 12px/1.4 system-ui, sans-serif; color: var(--muted); }
  .m a { color: var(--muted); }
  footer { margin-top: 32px; font: 12.5px/1.5 system-ui, sans-serif; color: var(--muted); }
  footer li { margin: 4px 0; }
  @media print { main { padding: 0; } a { color: inherit; text-decoration: none; } }
</style></head>
<body><main>
<header><h1>${name}</h1>${pack.desc ? `<p class="lede">${escHtml(pack.desc)}</p>` : ""}${pack.audience ? `<p class="lede">For ${escHtml(pack.audience)}</p>` : ""}</header>
${items}
<footer><b>Attribution</b><ul>${att.map((l) => `<li>${escHtml(l)}</li>`).join("")}</ul>
<p>${ts.length} terms · generated ${date} from the ${escHtml(META.scheme.title)} (${META.release}).</p></footer>
</main></body></html>
`;
}

export function filenameFor(pack, f) {
  const s = slugify(pack.name);
  return { html: `${s}.html`, md: `${s}.md`, csv: `${s}.csv`, jsonld: `${s}.jsonld.json`, cards: `${s}-flashcards.txt`,
    xapi: `${s}-xapi-tags.json`, align: `${s}-foxxi-alignment.ttl.txt` }[f];
}
