/**
 * A small I2IDL glossary release and I2IDL-X graphs in the shapes the live services publish them:
 * I2IDL's compact JSON-LD (https://id.i2idl.org/glossary.jsonld) and the relay's expanded JSON-LD
 * for I2IDL-X's signed graphs. The concepts and their wording are written for these tests.
 */
const I2 = 'https://id.i2idl.org/';
const X = 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx#';

const source = (id: string, title: string, rights: string) => ({ '@id': `${I2}sources/${id}`, '@type': 'dcterms:BibliographicResource', 'dcterms:title': title, 'schema:url': `https://${id}.example/`, 'dcterms:rights': rights });
const evidence = (id: string, label: string, relation: 'direct' | 'supporting') => ({
  '@type': 'gs:Evidence', 'dcterms:source': { '@id': `${I2}sources/${id}`, 'dcterms:title': label }, 'gs:sourceLabel': label,
  'gs:evidenceRelation': relation, 'gs:citationDetail': `${label} §1`, 'schema:url': `https://${id}.example/page`,
});
function concept(id: string, label: string, definition: string, alt: string[], ev: ReturnType<typeof evidence>[], extra: Record<string, unknown> = {}) {
  return [
    {
      '@id': `${I2}concepts/${id}`, '@type': ['skos:Concept', 'schema:DefinedTerm'], 'dcterms:identifier': id, 'skos:prefLabel': label,
      'skos:definition': definition, 'gs:activeDefinition': { '@id': `${I2}definitions/${id}-1` },
      ...(alt.length ? { 'skos:altLabel': alt } : {}), ...extra,
    },
    { '@id': `${I2}definitions/${id}-1`, '@type': ['prov:Entity', 'gs:Definition'], 'rdf:value': definition, 'gs:evidence': ev },
  ];
}

export const glossaryJsonLd = {
  '@context': { skos: 'http://www.w3.org/2004/02/skos/core#', schema: 'https://schema.org/', dcterms: 'http://purl.org/dc/terms/', prov: 'http://www.w3.org/ns/prov#', rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', gs: 'https://glossarystudio.app/ns/' },
  '@graph': [
    { '@id': `${I2}scheme`, '@type': ['skos:ConceptScheme', 'schema:DefinedTermSet'], 'dcterms:title': 'I2IDL Digital Learning Glossary', 'dcterms:rights': 'Mixed rights. I2IDL-original material defaults to CC BY 4.0; source-specific rights are preserved at the source and evidence level.', 'gs:publicationVersion': 'v0.0.86' },
    ...concept('learning-record-store-lrs', 'Learning Record Store (LRS)', 'A store that keeps learning records sent to it.', ['LRS'],
      [evidence('lebok', 'LeBOK', 'direct'), evidence('modernizing', 'Modernizing Learning', 'supporting')],
      { 'skos:broader': [{ '@id': `${I2}concepts/experience-api-xapi` }] }),
    ...concept('experience-api-xapi', 'Experience API (xAPI)', 'A specification for recording learning experiences as statements.', [], [evidence('xapi-base', 'IEEE xAPI Base Standard', 'direct')]),
    ...concept('ieee-xapi-base-standard', 'IEEE xAPI Base Standard', 'The IEEE standard that defines xAPI.', ['xAPI'], [evidence('xapi-base', 'IEEE xAPI Base Standard', 'direct')]),
    ...concept('formative-assessment', 'Formative assessment', 'Assessment used during learning to guide what comes next.', [], [evidence('worldbank', 'World Bank', 'direct')]),
    ...concept('feedback', 'Feedback', 'Information about performance that helps a learner improve.', [], [evidence('modernizing', 'Modernizing Learning', 'supporting')]),
    ...concept('learning-engineering', 'Learning engineering', 'A process for designing learning that draws on evidence.', [], [evidence('icicle', 'IEEE ICICLE', 'direct')]),
    source('lebok', 'Learning Engineering Body of Knowledge (LeBOK)', 'Used with permission'),
    source('modernizing', 'Modernizing Learning', 'CC BY 4.0 IGO'),
    source('xapi-base', 'IEEE xAPI Base Standard', 'Apache 2.0'),
    source('worldbank', 'Reimagining Human Connections', 'CC BY 3.0 IGO'),
    source('icicle', 'IEEE ICICLE Learning Engineering Process', 'CC BY-NC-SA 4.0'),
  ],
};

const lit = (v: string) => [{ '@value': v, '@language': 'en' }];
const ref = (iri: string) => [{ '@id': iri }];
export const i2idlxGraphs = {
  ontology: { '@context': {}, '@graph': [
    { '@id': `${X}category-application`, 'http://www.w3.org/2004/02/skos/core#prefLabel': lit('Application or platform') },
    { '@id': `${X}category-assessment`, 'http://www.w3.org/2004/02/skos/core#prefLabel': lit('Assessment, evaluation or test') },
    { '@id': `${X}role-realizes`, 'http://www.w3.org/2004/02/skos/core#prefLabel': lit('realizes') },
    { '@id': `${X}status-proposed`, 'http://www.w3.org/2004/02/skos/core#prefLabel': lit('proposed') },
  ] },
  referents: { '@context': {}, '@graph': [
    { '@id': `${I2}concepts/learning-record-store-lrs`, [`${X}referentCategory`]: ref(`${X}category-application`), [`${X}categoryRationale`]: lit('A software system people or services use.'), [`${X}assignmentBasis`]: [{ '@value': 'type' }] },
    { '@id': `${I2}concepts/formative-assessment`, [`${X}referentCategory`]: ref(`${X}category-assessment`) },
  ] },
  enactments: { '@context': {}, '@graph': [
    {
      '@id': 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx-enactments#e-lrs',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type': ref(`${X}Enactment`),
      [`${X}enactedConcept`]: ref(`${I2}concepts/learning-record-store-lrs`),
      [`${X}viaAction`]: ref('https://relay.interego.xwisee.com/ns/iep/action/foxxi/discover-lrs'),
      [`${X}enactmentRole`]: ref(`${X}role-realizes`), [`${X}reviewStatus`]: ref(`${X}status-proposed`),
      [`${X}rationale`]: lit('Reads the LRS\'s own about document.'), [`${X}confidence`]: [{ '@value': '0.90' }],
    },
    {
      '@id': 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx-enactments#e-fa',
      '@type': [`${X}Enactment`],
      [`${X}enactedConcept`]: ref(`${I2}concepts/formative-assessment`),
      [`${X}viaAction`]: ref('https://relay.interego.xwisee.com/ns/iep/action/foxxi/le-design-ab-experiment'),
      [`${X}enactmentRole`]: ref(`${X}role-realizes`), [`${X}reviewStatus`]: ref(`${X}status-proposed`),
    },
    // Not an enactment: ignored.
    { '@id': `${I2}concepts/feedback`, [`${X}enactedConcept`]: ref(`${I2}concepts/feedback`) },
  ] },
};
