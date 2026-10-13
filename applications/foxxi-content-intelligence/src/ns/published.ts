/**
 * ns/published.ts — everything the bridge publishes at a version, in one list.
 *
 * Each Foxxi /ns document, SSSOM mapping set and JSON-LD context carries a version (YYYY.MM.PATCH,
 * see catalog.ts) and is answered at a version IRI, `<IRI>/<version>`. When a version is released,
 * tools/release-ns.ts archives it in ns-releases/, and from then on the bridge answers that version
 * IRI from the archive (releases.ts). This is the list the release tool archives and the tests hold
 * the archive to: fourteen ontologies, twelve shapes graphs, the mapping sets of the ontologies that
 * map their terms, and the two contexts data is read through.
 */
import {
  renderOwl, renderOwlNTriples, renderOwlRdfXml, renderJsonLd, renderShacl, renderShaclNTriples, renderShaclRdfXml,
  renderShaclJsonLd, ontologyIri, shapesIri, docMeta, shapesDocMeta, type OntologyModel,
} from '../spec-ontology.js';
import { SPEC_MODELS } from '../spec/index.js';
import { COMPLIANCE_MODELS } from '../spec/compliance.model.js';
import { OB3_MODEL, CLR_MODEL, LER_MODEL } from '../spec/ler.model.js';
import { XAPI_MODEL } from '../spec/xapi.model.js';
import { XAPI_CONTEXT_URL, renderXapiContext } from '../spec/xapi-context.js';
import {
  renderSemOntologyTurtle, renderSemOntologyNTriples, renderSemOntologyRdfXml, renderSemOntologyJsonLd, semDocMeta,
  ELR_CONTEXT_URL, renderElrContext,
} from '../ler-tla-vocab.js';
import { renderVocabTurtle, renderVocabNTriples, renderVocabRdfXml, renderVocabJsonLd, foxxiDocMeta } from '../foxxi-vocab.js';
import { mappingSetModules, renderMappingSet } from './mapping-sets.js';
import { mappingSetIri } from './sssom.js';
import { NS_BASE } from './catalog.js';

/** What a published artifact is: an ontology, a SHACL shapes graph, a mapping set, a JSON-LD context. */
export type PublishedKind = 'ontology' | 'shapes' | 'mappings' | 'context';

/** One artifact the bridge publishes at a version. */
export interface Published {
  readonly kind: PublishedKind;
  /** The IRI it is published at, without a version: a document's IRI, a mapping set's id, a
   *  context's URL. Its version IRI is `<iri>/<version>`. */
  readonly iri: string;
  readonly version: string;
  /** For a document: the released version this one follows (its owl:priorVersion). */
  readonly priorVersion?: string;
  /** What is released: a document's Turtle, a mapping set's SSSOM/TSV, a context's JSON. */
  readonly render: () => string;
  /** A document's other forms, each a serialization of the graph its Turtle is. */
  readonly forms?: { readonly ntriples: () => string; readonly rdfxml: () => string; readonly jsonld: () => unknown };
}

const MODELS: readonly OntologyModel[] = [...Object.values(SPEC_MODELS), ...Object.values(COMPLIANCE_MODELS), OB3_MODEL, CLR_MODEL];

/** The ontology documents. */
function ontologies(): Published[] {
  const prior = (p: string | undefined): { priorVersion?: string } => (p ? { priorVersion: p } : {});
  return [
    ...MODELS.map((m): Published => ({
      kind: 'ontology', iri: ontologyIri(m), version: m.version, ...prior(docMeta(m).priorVersion), render: () => renderOwl(m),
      forms: { ntriples: () => renderOwlNTriples(m), rdfxml: () => renderOwlRdfXml(m), jsonld: () => renderJsonLd(m) },
    })),
    ...(['ler', 'tla'] as const).map((f): Published => ({
      kind: 'ontology', iri: semDocMeta(f).iri, version: semDocMeta(f).version, ...prior(semDocMeta(f).priorVersion),
      render: () => renderSemOntologyTurtle(f),
      forms: { ntriples: () => renderSemOntologyNTriples(f), rdfxml: () => renderSemOntologyRdfXml(f), jsonld: () => renderSemOntologyJsonLd(f) },
    })),
    {
      kind: 'ontology', iri: foxxiDocMeta().iri, version: foxxiDocMeta().version, ...prior(foxxiDocMeta().priorVersion),
      render: renderVocabTurtle, forms: { ntriples: renderVocabNTriples, rdfxml: renderVocabRdfXml, jsonld: renderVocabJsonLd },
    },
  ];
}

/** The SHACL shapes graphs: one per model, and the IEEE LER record shapes. */
function shapesGraphs(): Published[] {
  return [...MODELS, LER_MODEL].map((m): Published => ({
    kind: 'shapes', iri: shapesIri(m), version: m.version,
    ...(shapesDocMeta(m).priorVersion ? { priorVersion: shapesDocMeta(m).priorVersion } : {}),
    render: () => renderShacl(m),
    forms: { ntriples: () => renderShaclNTriples(m), rdfxml: () => renderShaclRdfXml(m), jsonld: () => renderShaclJsonLd(m) },
  }));
}

/** The mapping sets, each at the version of the ontology it is generated from. */
function mappingSets(): Published[] {
  const byPath = new Map(ontologies().map(d => [d.iri.slice(NS_BASE.length), d]));
  return mappingSetModules().map((module): Published => {
    const doc = byPath.get(module);
    if (!doc) throw new Error(`no ontology is published at /ns/${module}, which publishes a mapping set`);
    return { kind: 'mappings', iri: mappingSetIri(doc.iri), version: doc.version, render: () => renderMappingSet(module)! };
  });
}

/** Strip the version segment from a versioned context URL. */
const unversioned = (url: string, version: string): string => {
  if (!url.endsWith(`/${version}`)) throw new Error(`${url} is not the URL of version ${version}`);
  return url.slice(0, -(version.length + 1));
};

/** The JSON-LD contexts, each at the version of the vocabulary it reads data into. */
function contexts(): Published[] {
  const ler = semDocMeta('ler').version;
  return [
    { kind: 'context', iri: unversioned(XAPI_CONTEXT_URL, XAPI_MODEL.version), version: XAPI_MODEL.version, render: renderXapiContext },
    { kind: 'context', iri: unversioned(ELR_CONTEXT_URL, ler), version: ler, render: renderElrContext },
  ];
}

/** Every artifact published at a version. */
export function publishedArtifacts(): Published[] {
  return [...ontologies(), ...shapesGraphs(), ...mappingSets(), ...contexts()];
}
