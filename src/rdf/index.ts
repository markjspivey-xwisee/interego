export * from './namespaces.js';
export { toTurtle, toTurtleDocument, toTripleAnnotationTurtle, toTripleAnnotationDocument, type SerializerOptions } from './serializer.js';
export {
  parseTrig,
  findSubjectsOfType,
  readStringValue,
  readStringValues,
  readIntegerValue,
  readIriValue,
  type ParsedDocument,
  type ParsedSubject,
  type ParsedTerm,
  type ParsedLiteral,
  type ParsedIri,
  type ParsedBNode,
} from './turtle-parser.js';
// RDF 1.2 helpers (version directive, directional language tags)
export {
  langString,
  parseLangString,
  withRdf12VersionDirective,
  detectRdf12Features,
  RDF12_VERSION_DIRECTIVE,
} from './rdf12.js';
export type { BaseDirection } from './rdf12.js';
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
