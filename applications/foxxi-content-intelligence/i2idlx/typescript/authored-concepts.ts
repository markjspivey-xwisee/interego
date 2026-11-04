/** Authored glossary proposals, kept outside the unchanged I2IDL release. Browser and server share this projection. */
import { turtleIriRef } from '@interego/core/rdf';
type Row = Record<string, ReturnType<typeof JSON.parse>>;
export function authoredIriRef(value: unknown): string {
  const reference = turtleIriRef(value);
  if (!reference) throw new Error('Invalid authored catalog IRI.');
  return reference;
}
export const CANONICAL_CONCEPT_NS = 'https://id.i2idl.org/concepts/';
export const AUTHORED_NS = 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx#';
export const FRAMEWORK_IRI = AUTHORED_NS + 'concept-competency-framework';
export const REVIEW_SHA256 = 'f711272b203a8fe74dd26d71b895eca9ee39d05d5a0f8326f70a2852ebc3109b';
export const AUTHORED_CATALOG = {
  version: '0.1.0', namespace: AUTHORED_NS, publisher: 'Foxxi / I2IDL-X', status: 'Hypothetical',
  reviewedProposalSha256: REVIEW_SHA256,
  authors: ['did:web:identity.interego.xwisee.com:agents:chatgpt-u-pk-731e988c2c5b', 'did:web:identity.interego.xwisee.com:agents:claude-u-pk-33d42e6b33dc'],
  concepts: [{
    id: 'competency-framework', iri: FRAMEWORK_IRI, definitionIri: AUTHORED_NS + 'definition-competency-framework',
    proposedCanonicalIri: CANONICAL_CONCEPT_NS + 'competency-framework', label: 'Competency framework',
    definition: 'A structured set of related competency definitions, organized by grouping, hierarchy or progression and often paired with proficiency levels or performance indicators, used as a shared reference to plan learning, assess performance and judge readiness.',
    editorialNote: 'An authored I2IDL-X proposal, not an adopted I2IDL concept. A framework organizes competencies; it is distinct from an individual competency, its encoding standard and a claim that a learner has demonstrated it. The type, referent assignment and relations are Hypothetical editorial judgments.',
    type: 'framework', category: 'model', field: 'standards-and-interoperability',
    rationale: 'The definition describes a structured reference model. The proposed framework type independently defaults to Model, framework or theory; neither judgment asserts learner achievement.',
    related: ['competency', 'competency-based-learning', 'assessment', 'mastery-learning', 'minimum-proficiency-level', 'ieee-1484-20-2-2022-defining-competencies', 'ieee-1484-20-3-2022-shareable-competency-definitions', 'shareable-competency-definition-scd'],
    candidateAssociations: [{ iri: 'https://purl.org/ctdlasn/terms/CompetencyFramework', label: 'CTDL-ASN Competency Framework', kind: 'relatedClass', status: 'proposed', note: 'Confirmed peer class; candidate annotation only. No SKOS mapping, equivalence, subsumption or instance-typing bridge is asserted.' }],
    evidence: [{ title: 'Credential Engine CTDL-ASN Schema (2024-08-30 release)', url: 'https://www.credreg.com/ctdlasn/terms?releaseid=20240830', rights: 'CC BY 4.0', rightsUrl: 'https://creativecommons.org/licenses/by/4.0/', citation: 'CompetencyFramework container scope; hasProgressionModel and ProficiencyScale supply optional progression and level context.' }],
  }],
  peerRestrictions: [
    { iri: 'https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#CompetencyFramework', curie: 'ler:CompetencyFramework', concept: 'competency-framework', rationale: 'The pinned IEEE LER model is a structured collection of competency definitions with typed relationships; a specialized framework instance is classified by the authored generic concept.' },
    { iri: 'https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#CompetencyFramework', curie: 'tla:CompetencyFramework', concept: 'competency-framework', rationale: 'The pinned ADL TLA model is a structured directed graph of competencies with typed relations, levels and roll-up; a specialized framework instance is classified by the authored generic concept.' },
  ],
};
export function conceptIri(concept: Row): string {
  return typeof concept.iri === 'string' ? concept.iri : CANONICAL_CONCEPT_NS + concept.id;
}
/** The canonical arrays are never edited. A separate catalog is projected only when the build includes one. */
export function projectWorkbenchData(input: Row): Row {
  if (!input.authoredCatalog || input.meta?.corpusProjection === 'canonical-plus-authored-v1') return input;
  const catalog = input.authoredCatalog as Row;
  if (catalog.namespace !== AUTHORED_NS || catalog.status !== 'Hypothetical' || !Array.isArray(catalog.concepts)) throw new Error('Invalid authored glossary catalog.');
  const ids = new Set(input.concepts.map((c: Row) => c.id)), iris = new Set(input.concepts.map(conceptIri));
  const sources = [...(input.sources || [])];
  const canonical = input.concepts.map((c: Row) => ({ ...c, iri: conceptIri(c), origin: { kind: 'canonical', publisher: 'I2IDL', release: input.meta.release, commit: input.meta.commit, scheme: input.meta.scheme?.iri, graphSha256: catalog.canonicalSource?.graphSha256 } }));
  const authored = catalog.concepts.map((c: Row) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id) || ids.has(c.id) || c.iri !== AUTHORED_NS + 'concept-' + c.id || iris.has(c.iri) || !c.definition || !input.semantic?.categories?.some((cat: Row) => cat.id === c.category)) throw new Error('Authored concept collides with the source or lacks a known referent category.');
    if (!Array.isArray(c.related) || c.related.some((id: string) => !ids.has(id))) throw new Error('Authored relation target is not in the canonical snapshot.');
    ids.add(c.id); iris.add(c.iri);
    const ev = (c.evidence || []).map((e: Row, index: number) => {
      const s = sources.length;
      sources.push({ id: 'authored-' + c.id + '-evidence-' + index, iri: AUTHORED_NS + 'source-' + c.id + '-' + index, title: e.title, label: e.title, url: e.url, rights: e.rights, rightsUrl: e.rightsUrl, rc: 'open', origin: 'authored' });
      return { s, r: 's', c: e.citation, u: e.url };
    });
    return { id: c.id, iri: c.iri, l: c.label, a: [], d: c.definition, x: c.editorialNote, st: 'proposed', ds: 'proposed',
      t: c.type, k: 'framework', f: [c.field], pf: c.field, cu: [], pv: 'a', b: [], n: [], r: [...c.related],
      di: c.definitionIri, dq: 1, dl: 'en', ev, xm: [], rc: c.category, rb: 'd', rw: c.rationale, md: [], mx: [],
      origin: { kind: 'authored', publisher: catalog.publisher, catalogVersion: catalog.version, scheme: AUTHORED_NS + 'AuthoredConcepts', status: 'Hypothetical', authors: catalog.authors, reviewedProposalSha256: catalog.reviewedProposalSha256, proposedCanonicalIri: c.proposedCanonicalIri, upstreamAdopted: false },
      candidateAssociations: c.candidateAssociations || [] };
  });
  const concepts = [...canonical, ...authored];
  const bridges = (catalog.peerRestrictions || []).map((p: Row) => {
    const c = authored.find((c: Row) => c.id === p.concept);
    if (!c || !/^https:\/\//.test(p.iri)) throw new Error('Authored peer restriction has no available concept.');
    return { c: c.id, conceptIri: c.iri, t: p.curie, k: 'narrow', m: 'authored-peer-framework', origin: 'authored', status: 'Hypothetical', rationale: p.rationale };
  });
  const layout = input.layout ? { ...input.layout, xy: { ...input.layout.xy } } : null;
  for (let index = 0; index < authored.length; index++) if (layout) {
    const anchor = layout.xy[authored[index]!.r[0]] || [layout.w / 2, layout.h / 2];
    layout.xy[authored[index]!.id] = [Math.min(layout.w - 20, anchor[0] + 35 + index * 20), Math.min(layout.h - 20, anchor[1] + 35)];
  }
  return { ...input, sources, concepts, ...(layout ? { layout } : {}),
    forms: [...(input.forms || []), ...authored.map((c: Row, i: number) => [c.l, canonical.length + i, 1, 0])].sort((a, b) => b[0].length - a[0].length),
    meta: { ...input.meta, corpusProjection: 'canonical-plus-authored-v1', authoredShapes: authoredCatalogPorts(catalog.baseUrl || 'https://foxxi-bridge.interego.xwisee.com')[2]!.href,
      counts: { ...input.meta.counts, canonicalConcepts: canonical.length, authoredConcepts: authored.length, combinedConcepts: concepts.length, concepts: concepts.length } },
    semantic: { ...input.semantic, bridges: [...(input.semantic.bridges || []), ...bridges] } };
}
export function resolveConceptIndex(data: Row): Map<string, { id: string; iri: string; label: string; origin: Row }> {
  const projected = projectWorkbenchData(data);
  return new Map(projected.concepts.map((c: Row) => [conceptIri(c), { id: c.id, iri: conceptIri(c), label: c.l, origin: c.origin ?? { kind: 'canonical', publisher: 'I2IDL', release: data.meta?.release, commit: data.meta?.commit } }]));
}
/** Trusted authored TBox: the CTDL candidate annotation deliberately contributes no typing axiom. */
export function authoredCatalogPorts(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, '');
  return [
    { action: 'urn:iep:action:foxxi:i2idlx-authored-catalog', href: base + '/i2idlx/authored-catalog', method: 'GET', mediaType: 'application/json', readOnly: true },
    { action: 'urn:iep:action:foxxi:i2idlx-authored-rdf', href: base + '/i2idlx/authored.ttl', method: 'GET', mediaType: 'text/turtle', readOnly: true },
    { action: 'urn:iep:action:foxxi:i2idlx-authored-shapes', href: base + '/i2idlx/authored-shapes.ttl', method: 'GET', mediaType: 'text/turtle', readOnly: true },
  ];
}
export function authoredCatalogView(data: Row, baseUrl: string, rdfSha256: string): Row {
  const projected = projectWorkbenchData(data);
  return { kind: 'authored-glossary-catalog', status: 'Hypothetical', upstream_adopted: false,
    canonical_source: { release: data.meta.release, graphRevision: data.meta.commit, checkoutCommit: data.authoredCatalog?.canonicalSource?.commit,
      graphSha256: data.authoredCatalog?.canonicalSource?.graphSha256, repository: data.authoredCatalog?.canonicalSource?.repository },
    counts: { canonical: projected.meta.counts.canonicalConcepts, authored: projected.meta.counts.authoredConcepts, combined: projected.concepts.length },
    catalog: data.authoredCatalog, rdf: { href: authoredCatalogPorts(baseUrl)[1]!.href, mediaType: 'text/turtle', sha256: rdfSha256 },
    _affordances: authoredCatalogPorts(baseUrl) };
}
export function authoredReferentTurtle(data: Row, baseUrl = 'https://foxxi-bridge.interego.xwisee.com'): string {
  const catalog = data.authoredCatalog as Row | undefined;
  if (!catalog) return '';
  const projected = projectWorkbenchData(data), concepts: Row[] = projected.concepts.filter((c: Row) => c.origin?.kind === 'authored');
  const ns = data.meta.ns || data.meta.iri.ontology + '#';
  const rdfUrl = authoredCatalogPorts(baseUrl)[1]!.href, scheme = AUTHORED_NS + 'AuthoredConcepts';
  const iri = authoredIriRef, authors = catalog.authors.map(iri).join(', ');
  const lines = [
    `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix prov: <http://www.w3.org/ns/prov#> . @prefix dct: <http://purl.org/dc/terms/> . @prefix dcat: <http://www.w3.org/ns/dcat#> . @prefix schema: <https://schema.org/> .`,
    `${iri(rdfUrl)} a dcat:Dataset ; dct:title "Authored I2IDL-X glossary proposals" ; dct:description "Hypothetical authored concepts and directional modeling judgments; not an I2IDL canonical release or ratified mapping." ; dct:hasVersion ${JSON.stringify(catalog.version)} ; prov:wasAttributedTo ${authors} ; dct:identifier ${JSON.stringify(catalog.reviewedProposalSha256)} .`,
    `${iri(scheme)} a skos:ConceptScheme ; skos:prefLabel "Authored I2IDL-X proposals" ; rdfs:isDefinedBy ${iri(rdfUrl)} .`,
  ];
  for (const c of concepts) {
    lines.push(`${iri(c.iri)} a skos:Concept, schema:DefinedTerm ; skos:inScheme ${iri(scheme)} ; rdfs:isDefinedBy ${iri(rdfUrl)} ; dct:identifier ${JSON.stringify(c.id)} ; ${iri(ns + 'reviewStatus')} ${iri(ns + 'status-proposed')} ; ${iri(ns + 'referentCategory')} ${iri(ns + 'category-' + c.rc)} ; ${iri(ns + 'assignmentBasis')} "definition" ; ${iri(ns + 'categoryRationale')} ${JSON.stringify(c.rw)} ; skos:prefLabel ${JSON.stringify(c.l)} ; skos:definition ${JSON.stringify(c.d)} ; skos:editorialNote ${JSON.stringify(c.x)} ; prov:wasAttributedTo ${authors} ; dct:source ${iri(c.di)} .`);
    lines.push(`${iri(c.di)} a prov:Entity ; rdf:value ${JSON.stringify(c.d)} ; dct:creator ${authors} ; dct:identifier ${JSON.stringify(c.origin.reviewedProposalSha256)} .`);
    for (const related of c.r) lines.push(`${iri(c.iri)} skos:related ${iri(conceptIri(projected.concepts.find((x: Row) => x.id === related)))} .`);
    for (const ev of c.ev) {
      const source = projected.sources[ev.s];
      lines.push(`${iri(c.di)} dct:source ${iri(source.iri)} . ${iri(source.iri)} a dct:BibliographicResource ; dct:title ${JSON.stringify(source.title)} ; schema:url ${iri(source.url)} ; dct:rights ${JSON.stringify(source.rights)} ; rdfs:comment ${JSON.stringify(ev.c)} .`);
      if (source.rightsUrl) lines.push(`${iri(source.iri)} dct:license ${iri(source.rightsUrl)} .`);
    }
    for (const candidate of c.candidateAssociations) lines.push(`${iri(c.iri)} rdfs:seeAlso ${iri(candidate.iri)} ; rdfs:comment ${JSON.stringify(candidate.note)} .`);
  }
  for (const p of catalog.peerRestrictions || []) {
    const c = concepts.find(c => c.id === p.concept);
    if (!c) throw new Error('Unknown authored peer concept.');
    lines.push(`${iri(p.iri)} <http://www.w3.org/2000/01/rdf-schema#subClassOf> [ a <http://www.w3.org/2002/07/owl#Restriction> ; <http://www.w3.org/2002/07/owl#onProperty> ${iri(ns + 'isClassifiedBy')} ; <http://www.w3.org/2002/07/owl#hasValue> ${iri(c.iri)} ; rdfs:comment ${JSON.stringify('Hypothetical authored directional bridge. ' + p.rationale)} ] .`);
  }
  return lines.join('\n');
}
