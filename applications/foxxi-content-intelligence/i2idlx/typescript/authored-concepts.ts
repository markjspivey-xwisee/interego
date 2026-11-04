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
export const AUTHOR_ROOT = 'did:web:identity.interego.xwisee.com:agents:chatgpt-u-pk-731e988c2c5b';
export const CLAUDE_REVIEWER = 'did:web:identity.interego.xwisee.com:agents:claude-u-pk-33d42e6b33dc';
export const REVIEW_SHA256 = 'f711272b203a8fe74dd26d71b895eca9ee39d05d5a0f8326f70a2852ebc3109b';
export const CLAUDE_REVIEW_SHA256 = '7780fd9246ee5fdea82a9941093c752b64f38d36683c647ffaa2bda305ee5aaf';
export const AUTHORED_CATALOG = {
  version: '0.1.1', namespace: AUTHORED_NS, publisher: 'Foxxi / I2IDL-X', status: 'Hypothetical',
  reviewedProposalSha256: REVIEW_SHA256,
  authors: [AUTHOR_ROOT],
  proposalReview: { iri: 'urn:sha256:' + REVIEW_SHA256, sha256: REVIEW_SHA256, title: 'Agreed competency-framework definition and gap review', scope: 'English definition co-authorship and original gap review; not dataset or bridge authorship.' },
  reviews: [{
    iri: AUTHORED_NS + 'review-claude-2026-11-04', reviewer: CLAUDE_REVIEWER,
    document: { iri: 'urn:sha256:' + CLAUDE_REVIEW_SHA256, sha256: CLAUDE_REVIEW_SHA256, title: 'Competency framework release: Claude (georgio) review' },
    date: '2026-11-04', reviewedDefinition: AUTHORED_NS + 'definition-competency-framework',
    reviewedBridges: [AUTHORED_NS + 'bridge-ler-competency-framework', AUTHORED_NS + 'bridge-tla-competency-framework'],
    scope: 'Definition unchanged; accepts the two directional IEEE LER and ADL TLA framework bridges. The reviewer did not author the catalog, concept editorial note or bridges. This review also reports separate classifier and provenance findings; it is not blanket release or mapping ratification.',
  }],
  concepts: [{
    id: 'competency-framework', iri: FRAMEWORK_IRI, definitionIri: AUTHORED_NS + 'definition-competency-framework',
    definitionAuthors: [AUTHOR_ROOT, CLAUDE_REVIEWER],
    proposedCanonicalIri: CANONICAL_CONCEPT_NS + 'competency-framework', label: 'Competency framework',
    definition: 'A structured set of related competency definitions, organized by grouping, hierarchy or progression and often paired with proficiency levels or performance indicators, used as a shared reference to plan learning, assess performance and judge readiness.',
    editorialNote: 'An authored I2IDL-X proposal, not an adopted I2IDL concept. A framework organizes competencies; it is distinct from an individual competency, its encoding standard and a claim that a learner has demonstrated it. The type, referent assignment and relations are Hypothetical editorial judgments.',
    type: 'framework', category: 'model', field: 'standards-and-interoperability',
    rationale: 'The definition describes a structured reference model. The proposed framework type independently defaults to Model, framework or theory; neither judgment asserts learner achievement.',
    related: ['competency', 'competency-based-learning', 'assessment', 'mastery-learning', 'minimum-proficiency-level', 'ieee-1484-20-2-2022-defining-competencies', 'ieee-1484-20-3-2022-shareable-competency-definitions', 'shareable-competency-definition-scd'],
    candidateAssociations: [{
      iri: 'https://purl.org/ctdlasn/terms/CompetencyFramework', label: 'CTDL-ASN Competency Framework', vocabulary: 'CTDL-ASN', targetKind: 'rdfs:Class', kind: 'relatedClass', status: 'proposed',
      note: 'Candidate association between the glossary concept and the CTDL-ASN class for resources containing a related set of competencies. This proposed annotation asserts no concept equivalence, class identity, instance typing or subsumption.',
    }],
    evidence: [
      { role: 'direct', sourceIri: 'https://id.i2idl.org/sources/ctdl-asn-schema',
        title: 'Credential Engine CTDL-ASN Schema (2024-08-30 release)', url: 'https://www.credreg.com/ctdlasn/terms?releaseid=20240830',
        rights: 'Creative Commons Attribution 4.0 International (CC BY 4.0)', rightsUrl: 'https://creativecommons.org/licenses/by/4.0/', rightsClass: 'open',
        citation: '2024-08-30 release: CompetencyFramework class definition and container scope; hasProgressionModel and ProficiencyScale supply optional progression/level context.' },
      { role: 'supporting', sourceIri: 'https://id.i2idl.org/sources/ieee-ltsc',
        title: 'IEEE Learning Technology Standards Committee (LTSC) Active Standards', sourceUrl: 'https://sagroups.ieee.org/ltsc/active-standards/', url: 'https://standards.ieee.org/ieee/1484.20.2/10743/',
        rights: 'IEEE terms apply', rightsClass: 'permission',
        citation: 'IEEE 1484.20.2-2022 public abstract: disciplined definitions of competencies and their interoperable information.' },
      { role: 'supporting', sourceIri: 'https://id.i2idl.org/sources/ieee-ltsc',
        title: 'IEEE Learning Technology Standards Committee (LTSC) Active Standards', sourceUrl: 'https://sagroups.ieee.org/ltsc/active-standards/', url: 'https://standards.ieee.org/ieee/1484.20.3/10749/',
        rights: 'IEEE terms apply', rightsClass: 'permission',
        citation: 'IEEE 1484.20.3-2022 public abstract: shared competency definitions, frameworks and rubrics; the representation standard is distinct from a framework instance.' },
    ],
  }],
  peerRestrictions: [
    { id: 'bridge-ler-competency-framework', iri: 'https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#CompetencyFramework', curie: 'ler:CompetencyFramework', concept: 'competency-framework', rationale: 'The pinned IEEE LER model is a structured collection of competency definitions with typed relationships; a specialized framework instance is classified by the authored generic concept.' },
    { id: 'bridge-tla-competency-framework', iri: 'https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#CompetencyFramework', curie: 'tla:CompetencyFramework', concept: 'competency-framework', rationale: 'The pinned ADL TLA model is a structured directed graph of competencies with typed relations, levels and roll-up; a specialized framework instance is classified by the authored generic concept.' },
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
      sources.push({ id: 'authored-' + c.id + '-evidence-' + index, iri: AUTHORED_NS + 'source-' + c.id + '-' + index, title: e.title, label: e.title, url: e.sourceUrl || e.url, upstreamSourceIri: e.sourceIri, rights: e.rights, rightsUrl: e.rightsUrl, rc: e.rightsClass, origin: 'authored' });
      return { s, r: e.role === 'direct' ? 'd' : 's', c: e.citation, u: e.url };
    });
    return { id: c.id, iri: c.iri, l: c.label, a: [], d: c.definition, x: c.editorialNote, st: 'proposed', ds: 'proposed',
      t: c.type, k: 'framework', f: [c.field], pf: c.field, cu: [], pv: 'a', b: [], n: [], r: [...c.related],
      di: c.definitionIri, dq: 1, dl: 'en', ev, xm: [], rc: c.category, rb: 'd', rw: c.rationale, md: [], mx: [],
      origin: { kind: 'authored', publisher: catalog.publisher, catalogVersion: catalog.version, scheme: AUTHORED_NS + 'AuthoredConcepts', status: 'Hypothetical', authors: catalog.authors, reviewedProposalSha256: catalog.reviewedProposalSha256, proposedCanonicalIri: c.proposedCanonicalIri, upstreamAdopted: false },
      definitionAuthors: c.definitionAuthors || catalog.authors, candidateAssociations: c.candidateAssociations || [] };
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
  const rdfUrl = authoredCatalogPorts(baseUrl)[1]!.href, scheme = AUTHORED_NS + 'AuthoredConcepts', publisher = AUTHORED_NS + 'publisher';
  const iri = authoredIriRef, lit = JSON.stringify, en = (value: string) => lit(value) + '@en';
  const authors = catalog.authors.map(iri).join(', ');
  const lines = [
    '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix prov: <http://www.w3.org/ns/prov#> . @prefix dct: <http://purl.org/dc/terms/> . @prefix dcat: <http://www.w3.org/ns/dcat#> . @prefix schema: <https://schema.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix spdx: <http://spdx.org/rdf/terms#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    iri(rdfUrl) + ' a dcat:Dataset ; dct:title "Authored I2IDL-X glossary proposals"@en ; dct:description "Hypothetical authored concepts and directional modeling judgments; not an I2IDL canonical release or ratified mapping."@en ; dct:hasVersion ' + lit(catalog.version) + ' ; dct:publisher ' + iri(publisher) + ' ; prov:wasAttributedTo ' + authors + ' .',
    iri(publisher) + ' a prov:SoftwareAgent ; rdfs:label ' + en(catalog.publisher) + ' .',
    iri(scheme) + ' a skos:ConceptScheme ; skos:prefLabel "Authored I2IDL-X proposals"@en ; rdfs:isDefinedBy ' + iri(rdfUrl) + ' .',
  ];
  const document = (doc: Row) => {
    if (!/^[a-f0-9]{64}$/.test(doc.sha256) || doc.iri !== 'urn:sha256:' + doc.sha256) throw new Error('Invalid authored review document digest.');
    lines.push(iri(doc.iri) + ' a prov:Entity ; dct:title ' + en(doc.title) + ' ; dct:format "text/markdown" ; spdx:checksum [ a spdx:Checksum ; spdx:algorithm spdx:checksumAlgorithm_sha256 ; spdx:checksumValue ' + lit(doc.sha256) + ' ] .');
  };
  if (catalog.proposalReview) {
    document(catalog.proposalReview);
    lines.push(iri(rdfUrl) + ' prov:wasDerivedFrom ' + iri(catalog.proposalReview.iri) + ' .');
  }
  for (const c of concepts) {
    lines.push(iri(c.iri) + ' a skos:Concept, schema:DefinedTerm ; skos:inScheme ' + iri(scheme) + ' ; rdfs:isDefinedBy ' + iri(rdfUrl) + ' ; dct:identifier ' + lit(c.id) + ' ; ' + iri(ns + 'reviewStatus') + ' ' + iri(ns + 'status-proposed') + ' ; ' + iri(ns + 'referentCategory') + ' ' + iri(ns + 'category-' + c.rc) + ' ; ' + iri(ns + 'assignmentBasis') + ' "definition" ; ' + iri(ns + 'categoryRationale') + ' ' + en(c.rw) + ' ; skos:prefLabel ' + en(c.l) + ' ; skos:definition ' + en(c.d) + ' ; skos:editorialNote ' + en(c.x) + ' ; prov:wasAttributedTo ' + authors + ' ; dct:source ' + iri(c.di) + ' .');
    lines.push(iri(c.di) + ' a prov:Entity ; rdf:value ' + en(c.d) + ' ; dct:language "en" ; dct:creator ' + c.definitionAuthors.map(iri).join(', ') + ' .');
    if (catalog.proposalReview) lines.push(iri(c.di) + ' prov:wasDerivedFrom ' + iri(catalog.proposalReview.iri) + ' .');
    for (const related of c.r) lines.push(iri(c.iri) + ' skos:related ' + iri(conceptIri(projected.concepts.find((x: Row) => x.id === related))) + ' .');
    for (const ev of c.ev) {
      const source = projected.sources[ev.s];
      lines.push(iri(c.di) + ' dct:source ' + iri(source.iri) + ' ; prov:qualifiedDerivation [ a prov:Derivation ; prov:entity ' + iri(source.iri) + ' ; dct:type ' + lit(ev.r === 'd' ? 'direct' : 'supporting') + ' ; rdfs:comment ' + en(ev.c) + ' ; schema:url ' + iri(ev.u) + ' ] .');
      lines.push(iri(source.iri) + ' a dct:BibliographicResource ; dct:title ' + en(source.title) + ' ; schema:url ' + iri(source.url) + ' ; dct:rights ' + lit(source.rights) + ' .');
      if (source.upstreamSourceIri) lines.push(iri(source.iri) + ' prov:wasDerivedFrom ' + iri(source.upstreamSourceIri) + ' .');
      if (source.rightsUrl) lines.push(iri(source.iri) + ' dct:license ' + iri(source.rightsUrl) + ' .');
    }
    for (const [index, candidate] of c.candidateAssociations.entries()) {
      const association = AUTHORED_NS + 'association-' + c.id + '-' + index;
      lines.push(iri(c.iri) + ' rdfs:seeAlso ' + iri(candidate.iri) + ' .');
      lines.push(iri(association) + ' a rdf:Statement ; rdf:subject ' + iri(c.iri) + ' ; rdf:predicate rdfs:seeAlso ; rdf:object ' + iri(candidate.iri) + ' ; rdfs:comment ' + en(candidate.note) + ' ; prov:wasAttributedTo ' + authors + ' .');
    }
  }
  for (const p of catalog.peerRestrictions || []) {
    const c = concepts.find(c => c.id === p.concept);
    if (!c) throw new Error('Unknown authored peer concept.');
    if (!/^[a-z][a-z0-9-]*$/.test(p.id)) throw new Error('Invalid authored bridge id.');
    const bridge = AUTHORED_NS + p.id, restriction = '_:restriction_' + p.id.replaceAll('-', '_');
    // OWLAPI reads the anonymous restriction expression; a named class with
    // restriction predicates does not preserve this entailment. Name the axiom.
    lines.push(iri(p.iri) + ' rdfs:subClassOf ' + restriction + ' .');
    lines.push(restriction + ' a owl:Restriction ; owl:onProperty ' + iri(ns + 'isClassifiedBy') + ' ; owl:hasValue ' + iri(c.iri) + ' ; rdfs:comment ' + en('Hypothetical authored directional bridge. ' + p.rationale) + ' .');
    lines.push(iri(bridge) + ' a owl:Axiom ; owl:annotatedSource ' + iri(p.iri) + ' ; owl:annotatedProperty rdfs:subClassOf ; owl:annotatedTarget ' + restriction + ' ; prov:wasAttributedTo ' + authors + ' .');
  }
  for (const review of catalog.reviews || []) {
    document(review.document);
    const subjects = [review.reviewedDefinition, ...review.reviewedBridges];
    lines.push(iri(review.iri) + ' a schema:Review, prov:Entity ; schema:author ' + iri(review.reviewer) + ' ; schema:itemReviewed ' + subjects.map(iri).join(', ') + ' ; schema:reviewBody ' + en(review.scope) + ' ; dct:date ' + lit(review.date) + '^^xsd:date ; prov:wasDerivedFrom ' + iri(review.document.iri) + ' .');
    lines.push(iri(review.document.iri) + ' prov:wasAttributedTo ' + iri(review.reviewer) + ' .');
    for (const subject of subjects) lines.push(iri(subject) + ' schema:review ' + iri(review.iri) + ' .');
    lines.push(iri(rdfUrl) + ' rdfs:seeAlso ' + iri(review.iri) + ' .');
  }
  return lines.join('\n');
}
