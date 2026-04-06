export * from './namespaces.js';
export { toTurtle, toTurtleDocument, toTripleAnnotationTurtle, toTripleAnnotationDocument, type SerializerOptions } from './serializer.js';
export {
  toJsonLd,
  toJsonLdString,
  fromJsonLd,
  CONTEXT_GRAPHS_JSONLD_CONTEXT,
  CONTEXT_GRAPHS_JSONLD_CONTEXT_URL,
  type JsonLdOptions,
} from './jsonld.js';
// System ontology (full OWL/SHACL/Hydra/DCAT)
export {
  systemOntology,
  systemShaclShapes,
  systemHydraApi,
  systemDcatCatalog,
  allPrefixes,
  CG_NS,
} from './system-ontology.js';
// Virtualized RDF layer (bidirectional)
export {
  materializeSystem,
  executeSparqlProtocol,
  writeBackTriples,
  sparqlUpdateHandler,
  systemToTurtle,
  systemToJsonLd,
} from './virtualized-layer.js';
export type {
  SystemState,
  SparqlProtocolResult,
  WriteBackResult,
} from './virtualized-layer.js';
