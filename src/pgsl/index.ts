export * from './types.js';
export {
  createPGSL,
  mintAtom,
  ingest,
  resolve,
  queryNeighbors,
  latticeStats,
  computeLatticeCids,
  computeContainmentAnnotations,
  allContainmentAnnotations,
} from './lattice.js';
export {
  fiber,
  maxLevel,
  constituents,
  pullbackSquare,
  ancestorFragments,
  descendantNodes,
  latticeMeet,
  isSubFragment,
} from './category.js';
export {
  PGSL_NS,
  PGSLClass,
  PGSLProp,
  pgslTurtlePrefixes,
  nodeToTurtle,
  pgslToTurtle,
  pgslOwlOntology,
  pgslShaclShapes,
  sparqlFragmentsAtLevel,
  sparqlFragmentsContaining,
  sparqlPullbackOf,
  sparqlNeighbors,
  sparqlLatticeStats,
} from './rdf.js';
export {
  liftToDescriptor,
  embedInPGSL,
  verifyIntersectionCoherence,
  verifyProvenanceNaturality,
} from './geometric.js';
export {
  structuralRetrieve,
  atomRetrieve,
} from './retrieval.js';
export type {
  RetrievalResult,
  RetrievalOptions,
} from './retrieval.js';
export {
  extractEntities,
  embedEntitiesInPGSL,
  embedDualInPGSL,
} from './entity-extraction.js';
export type {
  EntityExtractionResult,
} from './entity-extraction.js';
export {
  extractTemporalMarkers,
  isTemporalQuestion,
  temporalMatch,
} from './temporal-retrieval.js';
export type {
  TemporalMarker,
  TemporalMatch,
} from './temporal-retrieval.js';
export {
  extractRelations,
  embedRelationsInPGSL,
  compositeRetrieve,
} from './relation-extraction.js';
export type {
  Relation,
  RelationExtractionResult,
} from './relation-extraction.js';
export {
  expandTerm,
  expandEntitiesWithOntology,
  ontologicalSimilarity,
} from './ontological-inference.js';
export {
  classifyQuestion,
  routedRetrieve,
} from './question-router.js';
export type {
  QuestionType,
  RoutedRetrievalResult,
} from './question-router.js';
export {
  buildCoOccurrenceMatrix,
  getCoOccurringAtoms,
  yonedaEmbedding,
  yonedaSimilarity,
  detectEmergentSynonyms,
  usageExpand,
  usageBasedSimilarity,
  hybridRetrieve,
} from './usage-semantics.js';
export type {
  CoOccurrence,
} from './usage-semantics.js';
export {
  parseTemporalQuestion,
  advancedTemporalRetrieve,
} from './advanced-temporal.js';
export {
  extractFactsWithLLM,
  structuralFactExtraction,
  embedFactsInPGSL,
  questionToFactQuery,
  matchFacts,
  deriveAnswer,
} from './fact-extraction.js';
export type {
  Fact,
  FactExtractionResult,
} from './fact-extraction.js';
// Structural computation (date math, counting, aggregation)
export {
  parseDate,
  daysBetween,
  dateDifference,
  orderChronologically,
  countUnique,
  sumValues,
  averageValues,
  extractNumbers,
  getLatestFact,
  findFirstAfter,
  whichCameFirst,
  shouldAbstain,
} from './computation.js';
export type {
  TemporalFact,
} from './computation.js';
export type {
  TemporalQuestionParsed,
  AdvancedTemporalResult,
} from './advanced-temporal.js';
export type { TokenGranularity, ContainmentAnnotation, ContainmentRole } from './types.js';
