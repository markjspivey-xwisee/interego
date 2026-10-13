/**
 * ns/html.ts — human-readable documentation for a Foxxi ontology, generated from its graph.
 *
 * A term IRI like `…/ns/xapi#Statement` opened in a browser fetches the document and then jumps to
 * the fragment. That only works if the HTML has an element whose id IS the fragment — the old views
 * listed prefixed names without anchors or definitions, so every hash IRI landed at the top of a
 * bare list. This renderer gives each term its own section, anchored at its local name, with its
 * definition, its axioms in plain words, its mappings, and the shapes that constrain it.
 *
 * It reads only the graph (plus the shapes graph, if any), so the page cannot describe a term
 * differently from the Turtle a machine receives at the same URL.
 */
import { compactIri, toJsonLd, Graph, type Term, type Subject, type Prefixes, RDF, RDFS, OWL, SKOS, DCT, SH, BIBO } from './rdf.js';
import { type DocMeta, versionIri, noticeOf, citation, LICENSE } from './catalog.js';

const h = (s: unknown): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface HtmlInput {
  readonly graph: Graph;
  readonly meta: DocMeta;
  readonly prefixes: Prefixes;
  readonly shapes?: Graph;
  readonly shapesIri?: string;
  readonly links?: ReadonlyArray<{ label: string; href: string; type?: string }>;
  readonly extraSections?: ReadonlyArray<{ id: string; title: string; html: string }>;
  /** A notice shown under the title, as HTML (an archived version names the current one). */
  readonly banner?: string;
  /** How to cite the document, when the graph already says (dct:bibliographicCitation). */
  readonly cite?: string;
}

const SECTION_ORDER: ReadonlyArray<{ id: string; title: string; kind: string; type: string }> = [
  { id: 'classes', title: 'Classes', kind: 'class', type: OWL + 'Class' },
  { id: 'object-properties', title: 'Object properties', kind: 'object property', type: OWL + 'ObjectProperty' },
  { id: 'datatype-properties', title: 'Datatype properties', kind: 'datatype property', type: OWL + 'DatatypeProperty' },
  { id: 'annotation-properties', title: 'Annotation properties', kind: 'annotation property', type: OWL + 'AnnotationProperty' },
  { id: 'datatypes', title: 'Datatypes', kind: 'datatype', type: RDFS + 'Datatype' },
  { id: 'concept-schemes', title: 'Code lists (SKOS concept schemes)', kind: 'code list', type: SKOS + 'ConceptScheme' },
  { id: 'collections', title: 'Collections', kind: 'collection', type: SKOS + 'Collection' },
];

/** Render a complete, standalone HTML5 page. */
export function renderOntologyHtml(input: HtmlInput): string {
  const { graph: g, meta, prefixes } = input;
  const ns = meta.ns ?? `${meta.iri}#`;
  const own = (v: string): boolean => v.startsWith(ns);
  const local = (v: string): string => v.slice(ns.length);
  const lit = (t: Term): string => t.termType === 'Literal' ? t.value : t.value;
  const textOf = (s: Subject, p: string): string[] => g.objects(s, p).filter(t => t.termType === 'Literal').map(lit);
  const label = (v: string): string => {
    // A code value's own word (skos:prefLabel) where it has one — its rdfs:label adds the list's
    // name, which the page already shows around it — and otherwise rdfs:label.
    const n = g.triples.find(t => t.s.value === v && t.p.value === SKOS + 'prefLabel' && t.o.termType === 'Literal')
      ?? g.triples.find(t => t.s.value === v && t.p.value === RDFS + 'label' && t.o.termType === 'Literal');
    return n ? n.o.value : (compactIri(v, prefixes) ?? v);
  };
  const link = (t: Term): string => {
    if (t.termType === 'Literal') {
      const dt = t.datatype ? ` <span class="dt">${h(compactIri(t.datatype, prefixes) ?? t.datatype)}</span>` : '';
      return `<span class="lit">${h(t.value)}</span>${t.language ? ` <span class="dt">@${h(t.language)}</span>` : dt}`;
    }
    if (t.termType === 'BlankNode') return classExpression(t);
    const c = compactIri(t.value, prefixes);
    const href = own(t.value) ? `#${encodeURIComponent(local(t.value)).replace(/%2F/g, '/')}` : t.value;
    return `<a href="${h(href)}" title="${h(t.value)}"><code>${h(c ?? t.value)}</code></a>`;
  };
  const listItems = (head: Term): Term[] => {
    const out: Term[] = [];
    let cur: Term | undefined = head;
    for (let guard = 0; cur && cur.termType === 'BlankNode' && guard < 1000; guard++) {
      const f = g.objects(cur, RDF + 'first')[0]; if (f) out.push(f);
      cur = g.objects(cur, RDF + 'rest')[0];
    }
    return out;
  };
  function classExpression(b: Term): string {
    if (b.termType !== 'BlankNode') return link(b);
    const u = g.objects(b, OWL + 'unionOf')[0];
    if (u) return listItems(u).map(link).join(' <span class="op">or</span> ');
    const i = g.objects(b, OWL + 'intersectionOf')[0];
    if (i) return listItems(i).map(link).join(' <span class="op">and</span> ');
    const one = g.objects(b, OWL + 'oneOf')[0];
    if (one) return `one of ${listItems(one).map(link).join(', ')}`;
    const onDt = g.objects(b, OWL + 'onDatatype')[0];
    if (onDt) {
      const facets = listItems(g.objects(b, OWL + 'withRestrictions')[0] ?? { termType: 'NamedNode', value: RDF + 'nil' })
        .flatMap(f => f.termType === 'BlankNode' ? g.triples.filter(t => t.s.value === f.value && t.s.termType === 'BlankNode')
          .map(t => `${h(compactIri(t.p.value, prefixes) ?? t.p.value)} ${link(t.o)}`) : []);
      return `${link(onDt)} restricted by ${facets.join(', ')}`;
    }
    return '<em>anonymous class</em>';
  }
  const row = (k: string, vals: Term[] | string[]): string => {
    if (!vals.length) return '';
    const cells = (vals as Array<Term | string>).map(v => typeof v === 'string' ? h(v) : link(v));
    return `<tr><th>${h(k)}</th><td>${cells.join('<br>')}</td></tr>`;
  };
  const reverse = (p: string, o: string): Subject[] => g.triples.filter(t => t.p.value === p && t.o.termType === 'NamedNode' && t.o.value === o).map(t => t.s);
  // owl:AllDisjointClasses groups: each class is disjoint with every other member of its group.
  const disjointGroups: Term[][] = g.subjectsOfType(OWL + 'AllDisjointClasses')
    .map(d => listItems(g.objects(d, OWL + 'members')[0] ?? { termType: 'NamedNode', value: RDF + 'nil' }));
  const disjointWith = (v: string): Term[] => {
    const out = [...g.objects({ termType: 'NamedNode', value: v }, OWL + 'disjointWith')];
    for (const grp of disjointGroups) if (grp.some(x => x.value === v)) out.push(...grp.filter(x => x.value !== v));
    return out;
  };
  const inUnion = (p: string, o: string): Subject[] => g.triples.filter(t => t.p.value === p && t.o.termType === 'BlankNode'
    && (() => { const u = g.objects(t.o as Subject, OWL + 'unionOf')[0]; return !!u && listItems(u).some(x => x.value === o); })()).map(t => t.s);

  // ── Shapes index: the term a node shape targets → the shapes ──
  // A class's section lists the shapes its instances are checked by; a property's, the shapes its
  // values (sh:targetObjectsOf) or the nodes that have it (sh:targetSubjectsOf) are checked by.
  const shapesFor = new Map<string, Array<{ shape: string; label: string; how: string; rows: string[] }>>();
  if (input.shapes) {
    const sg = input.shapes;
    const TARGETS: ReadonlyArray<readonly [string, string]> = [
      [SH + 'targetClass', 'Constrained by'],
      [SH + 'targetObjectsOf', 'Its values are constrained by'],
      [SH + 'targetSubjectsOf', 'What has it is constrained by'],
    ];
    const rowsOf = (s: Subject): string[] => {
      const rows: string[] = [];
      for (const ps of sg.objects(s, SH + 'property')) {
        if (ps.termType === 'Literal') continue;
        const path = sg.objects(ps, SH + 'path')[0];
        const pathText = !path ? '?' : path.termType === 'NamedNode' ? (compactIri(path.value, prefixes) ?? path.value)
          : listItemsIn(sg, path).map(x => compactIri(x.value, prefixes) ?? x.value).join(' / ');
        const msg = sg.objects(ps, SH + 'message')[0]?.value ?? sg.objects(ps, RDFS + 'comment')[0]?.value ?? '';
        rows.push(`<li><code>${h(pathText)}</code>${msg ? ` — ${h(msg)}` : ''}</li>`);
      }
      // Requirements on the node as a whole: a choice among alternatives (sh:xone, sh:or).
      for (const [key, words] of [[SH + 'xone', 'exactly one of'], [SH + 'or', 'at least one of']] as const) {
        for (const head of sg.objects(s, key)) {
          const alts = listItemsIn(sg, head).map(b => {
            const p = sg.objects(b as Subject, SH + 'path')[0];
            const k = sg.objects(b as Subject, SH + 'nodeKind')[0];
            const c = sg.objects(b as Subject, SH + 'class')[0];
            const n = sg.objects(b as Subject, SH + 'node')[0];
            const name = (t: Term): string => h(compactIri(t.value, prefixes) ?? t.value);
            return p ? `<code>${name(p)}</code> has a value` : k ? `the node itself is ${name(k)}`
              : c ? `it is a <code>${name(c)}</code>` : n ? `it conforms to <code>${name(n)}</code>` : '…';
          });
          rows.push(`<li>${words}: ${alts.join('; ')}</li>`);
        }
      }
      const nk = sg.objects(s, SH + 'nodeKind')[0];
      if (nk) rows.unshift(`<li>the node itself is ${h(compactIri(nk.value, prefixes) ?? nk.value)}</li>`);
      return rows;
    };
    for (const [pred, how] of TARGETS) {
      for (const t of sg.triples) {
        if (t.p.value !== pred || t.o.termType !== 'NamedNode') continue;
        const s = t.s as Subject;
        const lab = sg.objects(s, RDFS + 'label')[0]?.value ?? (compactIri(s.value, prefixes) ?? s.value);
        const arr = shapesFor.get(t.o.value) ?? [];
        arr.push({ shape: s.value, label: lab, how, rows: rowsOf(s) });
        shapesFor.set(t.o.value, arr);
      }
    }
  }

  // ── Terms by section ──
  const typed = (type: string): string[] => {
    const seen = new Set<string>(); const out: string[] = [];
    for (const t of g.triples) {
      if (t.p.value === RDF + 'type' && t.o.termType === 'NamedNode' && t.o.value === type && t.s.termType === 'NamedNode' && own(t.s.value) && !seen.has(t.s.value)) {
        seen.add(t.s.value); out.push(t.s.value);
      }
    }
    return out;
  };
  const documented = new Set<string>();
  const termSection = (v: string, kindLabel: string): string => {
    documented.add(v);
    const S: Subject = { termType: 'NamedNode', value: v };
    const types = g.objects(S, RDF + 'type').filter(t => t.termType === 'NamedNode');
    const characteristics = types.filter(t => [OWL + 'FunctionalProperty', OWL + 'InverseFunctionalProperty', OWL + 'TransitiveProperty', OWL + 'SymmetricProperty'].includes(t.value));
    const definition = [...textOf(S, RDFS + 'comment'), ...textOf(S, SKOS + 'definition')];
    const rows = [
      row('IRI', [`${v}`]),
      row('Type', types.filter(t => !characteristics.includes(t))),
      row('Notation', textOf(S, SKOS + 'notation')),
      row('Also labelled', textOf(S, SKOS + 'altLabel')),
      row('Subclass of', g.objects(S, RDFS + 'subClassOf')),
      row('Superclass of', reverse(RDFS + 'subClassOf', v)),
      row('Equivalent to', g.objects(S, OWL + 'equivalentClass')),
      row('Disjoint with', disjointWith(v)),
      row('Domain', g.objects(S, RDFS + 'domain')),
      row('Range', g.objects(S, RDFS + 'range')),
      row('Characteristics', characteristics),
      row('Subproperty of', g.objects(S, RDFS + 'subPropertyOf')),
      row('Inverse of', g.objects(S, OWL + 'inverseOf')),
      row('Properties with this domain', [...reverse(RDFS + 'domain', v), ...inUnion(RDFS + 'domain', v)]),
      row('Properties with this range', [...reverse(RDFS + 'range', v), ...inUnion(RDFS + 'range', v)]),
      row('In scheme', g.objects(S, SKOS + 'inScheme')),
      row('Exact match', g.objects(S, SKOS + 'exactMatch')),
      row('Close match', g.objects(S, SKOS + 'closeMatch')),
      row('Broad match', g.objects(S, SKOS + 'broadMatch')),
      row('Narrow match', g.objects(S, SKOS + 'narrowMatch')),
      row('Related match', g.objects(S, SKOS + 'relatedMatch')),
      row('Constructed from', g.objects(S, 'https://markjspivey-xwisee.github.io/interego/ns/iep#constructedFrom')),
      row('Source', g.objects(S, DCT + 'source')),
      row('See also', g.objects(S, RDFS + 'seeAlso')),
      row('Deprecated', g.objects(S, OWL + 'deprecated')),
    ].join('');
    const members = g.objects(S, SKOS + 'hasTopConcept').concat(g.objects(S, SKOS + 'member'));
    const memberTable = members.length ? `<table class="members"><thead><tr><th>Concept</th><th>Notation</th><th>Definition</th></tr></thead><tbody>${members.map(m => {
      if (m.termType !== 'NamedNode') return '';
      documented.add(m.value);
      const M: Subject = m;
      const id = own(m.value) ? local(m.value) : '';
      return `<tr${id ? ` id="${h(id)}"` : ''}><td>${link(m)}<br><span class="sub">${h(label(m.value))}</span></td><td>${h(textOf(M, SKOS + 'notation').join(', '))}</td><td>${h([...textOf(M, SKOS + 'definition'), ...textOf(M, RDFS + 'comment')].join(' '))}${(() => { const xm = [...g.objects(M, SKOS + 'exactMatch'), ...g.objects(M, SKOS + 'closeMatch')]; return xm.length ? `<br><span class="sub">matches ${xm.map(link).join(', ')}</span>` : ''; })()}</td></tr>`;
    }).join('')}</tbody></table>` : '';
    const instances = reverse(RDF + 'type', v).filter(s => s.termType === 'NamedNode' && own(s.value) && !members.some(m => m.value === s.value));
    const shapeBlocks = (shapesFor.get(v) ?? []).map(sb => `<div class="shape"><p><strong>${h(sb.how)}</strong> <a href="${h(sb.shape)}"><code>${h(compactIri(sb.shape, prefixes) ?? sb.shape)}</code></a> — ${h(sb.label)}</p><ul>${sb.rows.join('')}</ul></div>`).join('');
    return `<section class="term" id="${h(local(v))}"><h3>${h(label(v))} <span class="kind">${h(kindLabel)}</span></h3>`
      + (definition.length ? `<p class="def">${h(definition.join(' '))}</p>` : '')
      + `<table class="facts">${rows}</table>${memberTable}`
      + (instances.length ? `<p><strong>Individuals:</strong> ${instances.map(link).join(', ')}</p>` : '')
      + `${shapeBlocks}</section>`;
  };
  const sections: string[] = [];
  const toc: string[] = [];
  for (const sec of SECTION_ORDER) {
    const terms = typed(sec.type).filter(v => !documented.has(v));
    if (!terms.length) continue;
    terms.sort((a, b) => label(a).localeCompare(label(b)));
    toc.push(`<li><a href="#${sec.id}">${h(sec.title)}</a> (${terms.length})</li>`);
    sections.push(`<section id="${sec.id}"><h2>${h(sec.title)}</h2>${terms.map(v => termSection(v, sec.kind)).join('')}</section>`);
  }
  // Remaining own individuals (concepts outside schemes, rules, levels…).
  const restIndividuals = [...new Set(g.triples.filter(t => t.s.termType === 'NamedNode' && own(t.s.value) && !documented.has(t.s.value) && t.p.value === RDF + 'type').map(t => t.s.value))];
  if (restIndividuals.length) {
    toc.push(`<li><a href="#individuals">Individuals</a> (${restIndividuals.length})</li>`);
    sections.push(`<section id="individuals"><h2>Individuals</h2>${restIndividuals.map(v => termSection(v, 'individual')).join('')}</section>`);
  }
  for (const x of input.extraSections ?? []) {
    toc.push(`<li><a href="#${h(x.id)}">${h(x.title)}</a></li>`);
    sections.push(`<section id="${h(x.id)}"><h2>${h(x.title)}</h2>${x.html}</section>`);
  }
  // External terms (declared, MIREOT)
  const external = [...new Set(g.triples.filter(t => t.p.value === RDF + 'type' && t.s.termType === 'NamedNode' && !own(t.s.value) && t.s.value !== meta.iri
    && t.o.termType === 'NamedNode' && [OWL + 'Class', OWL + 'ObjectProperty', OWL + 'DatatypeProperty', OWL + 'AnnotationProperty', RDFS + 'Datatype'].includes(t.o.value)).map(t => t.s.value))];
  if (external.length) {
    toc.push(`<li><a href="#external">External terms referenced</a> (${external.length})</li>`);
    sections.push(`<section id="external"><h2>External terms referenced</h2><p>Declared here so the document is self-contained OWL 2 DL; each is defined by its own publisher.</p><ul class="ext">${external.sort().map(u => `<li>${link({ termType: 'NamedNode', value: u })}</li>`).join('')}</ul></section>`);
  }

  const O: Subject = { termType: 'NamedNode', value: meta.iri };
  const metaRows = [
    row('IRI', [meta.iri]),
    row('This version', [versionIri(meta)]),
    row('Version', [meta.version]),
    row('Issued', [meta.issued]), row('Modified', [meta.modified]), row('Created', [meta.created]),
    meta.prefix && meta.ns ? row('Preferred prefix', [`${meta.prefix}: <${meta.ns}>`]) : '',
    meta.standards.length ? row('Formalizes', meta.standards.map(s => s.title)) : '',
    row('Imports', g.objects(O, OWL + 'imports')),
    `<tr><th>License</th><td><a href="${h(LICENSE)}">MIT</a></td></tr>`,
    row('Creator', textOf(O, DCT + 'creator')), row('Contributor', textOf(O, DCT + 'contributor')), row('Publisher', textOf(O, DCT + 'publisher')),
    row('Status', g.objects(O, BIBO + 'status').map(s => s.value.split('/').pop() ?? '')),
    row('Cite as', [input.cite ?? citation(meta)]),
  ].join('');
  const standards = meta.standards.map(s => `<li><a href="${h(s.url)}">${h(s.title)}</a></li>`).join('');
  const links = (input.links ?? []).map(l => `<a href="${h(l.href)}"${l.type ? ` type="${h(l.type)}"` : ''}>${h(l.label)}</a>`).join(' · ');
  const altHead = (input.links ?? []).filter(l => l.type).map(l => `<link rel="alternate" type="${h(l.type!)}" href="${h(l.href)}">`).join('');
  const notice = noticeOf(meta);
  const notes = textOf(O, RDFS + 'comment');
  // The document's own description, as JSON-LD in the page, for whoever reads the page rather than
  // negotiating for RDF (a search engine, a FAIR assessor): the header triples, the same graph's.
  const header = new Graph();
  for (const t of g.triples) if (t.s.termType === 'NamedNode' && t.s.value === meta.iri && t.o.termType !== 'BlankNode') header.add(t.s, t.p, t.o);
  const headerJsonLd = JSON.stringify(toJsonLd(header, prefixes, { first: [meta.iri] }), null, 1).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(meta.title)}</title><meta name="description" content="${h(meta.description)}">${altHead}
<script type="application/ld+json">${headerJsonLd}</script>
<style>
:root{--fg:#1d2330;--muted:#5b6475;--bg:#fff;--line:#e3e6ec;--accent:#7a3d00;--chip:#f3f4f7}
@media (prefers-color-scheme:dark){:root{--fg:#e6e8ee;--muted:#a3abbb;--bg:#141821;--line:#2a3140;--accent:#ffb26b;--chip:#1e2430}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:62rem;margin:0 auto;padding:2rem 1rem 4rem}
h1{font-size:1.9rem;margin:.2rem 0 .6rem}h2{margin-top:2.6rem;border-bottom:2px solid var(--line);padding-bottom:.3rem}
h3{margin:.2rem 0 .4rem;font-size:1.15rem}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em}
a{color:var(--accent)}.notice{background:var(--chip);border-left:4px solid var(--accent);padding:.7rem 1rem;margin:1rem 0}
table{border-collapse:collapse;width:100%;margin:.4rem 0}th,td{text-align:left;vertical-align:top;padding:.3rem .5rem;border-bottom:1px solid var(--line)}
th{width:13rem;color:var(--muted);font-weight:600}.term{border:1px solid var(--line);border-radius:8px;padding:.8rem 1rem;margin:1rem 0}
.term:target{outline:3px solid var(--accent)}.kind{font-size:.75rem;color:var(--muted);font-weight:400;margin-left:.4rem;text-transform:uppercase;letter-spacing:.04em}
.def{margin:.2rem 0 .6rem}.members th{width:auto}.sub,.dt{color:var(--muted);font-size:.85em}.lit{white-space:pre-wrap}.op{color:var(--muted)}
.shape{background:var(--chip);border-radius:6px;padding:.4rem .8rem;margin-top:.6rem}.shape ul{margin:.2rem 0}
.ext{columns:2}.formats{margin:.4rem 0 1rem}
</style></head>
<body><main>
<p class="sub">${h(meta.iri)}</p>
<h1>${h(meta.title)}</h1>
${input.banner ? `<div class="notice">${input.banner}</div>` : ''}
<p>${h(meta.description)}</p>
<p class="formats">Also available as ${links}</p>
<div class="notice">${h(notice)}</div>
${notes.filter(n => n !== notice).map(n => `<p>${h(n)}</p>`).join('')}
<table class="facts">${metaRows}</table>
${standards ? `<h2 id="sources">What this formalizes</h2><ul>${standards}</ul>` : ''}
<h2 id="contents">Contents</h2><ul>${toc.join('')}</ul>
${sections.join('\n')}
<footer><p class="sub">Generated from the published graph. Every term above is a fragment of this document: its IRI opens this page at its section.</p></footer>
</main></body></html>
`;
}

function listItemsIn(g: Graph, head: Term): Term[] {
  const out: Term[] = [];
  let cur: Term | undefined = head;
  for (let guard = 0; cur && cur.termType === 'BlankNode' && guard < 1000; guard++) {
    const f = g.objects(cur, RDF + 'first')[0]; if (f) out.push(f);
    cur = g.objects(cur, RDF + 'rest')[0];
  }
  return out;
}
