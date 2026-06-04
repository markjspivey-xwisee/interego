export * from './namespaces.js';
// Turtle/N-Triples literal escaping — substrate primitive used by every
// vertical that emits RDF. Exported so per-vertical @interego/*
// packages don't have to reach into core internals.
export { escapeTurtleLiteral, unescapeTurtleLiteral } from './escape.js';
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
// The virtualized RDF layer (`materializeSystem` / `executeSparqlProtocol`
// / `systemToTurtle`...) used to live here. It depends on PGSL and now
// lives in `@interego/pgsl`. The exports above remain unchanged for the
// substrate's own Turtle / TriG / JSON-LD work.
