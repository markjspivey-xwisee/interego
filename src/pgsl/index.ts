export * from './types.js';
export {
  createPGSL,
  mintAtom,
  mintEncryptedAtom,
  resolveAtomValue,
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
  countUniquePGSL,
} from './computation.js';
export type {
  TemporalFact,
} from './computation.js';
export type {
  TemporalQuestionParsed,
  AdvancedTemporalResult,
} from './advanced-temporal.js';
export { signNode, verifyNodeSignature, ensureBuilt } from './lattice.js';
// Static ontology loaders (Node-only — reads the authoritative .ttl files in docs/ns/)
export {
  loadOntology,
  loadFullOntology,
  loadFullShapes,
  getOntologyManifest,
  ONTOLOGY_MANIFEST,
} from './static-ontology.js';
export type {
  OntologyName,
  OntologyManifestEntry,
} from './static-ontology.js';
// Coherence verification
export {
  verifyCoherence,
  computeCoverage,
  getCertificates,
  getCoherenceStatus,
} from './coherence.js';
export type {
  CoherenceStatus,
  CoherenceCertificate,
  CoherenceObstruction,
  CoherenceCoverage,
  AtomCoherence,
} from './coherence.js';
export type { TokenGranularity, ContainmentAnnotation, ContainmentRole } from './types.js';
// Ingestion profiles
export {
  registerProfile,
  getProfile,
  listProfiles,
  ingestWithProfile,
  batchIngestWithProfile,
} from './profiles.js';
export type {
  IngestionProfile,
  XapiStatement,
  LersCredential,
  RdfTriple,
} from './profiles.js';
// SPARQL engine
export {
  createTripleStore,
  addTriple,
  addTriples,
  matchPattern,
  materializeTriples,
  parseSparql,
  executeSparql,
  executeSparqlString,
  sparqlQueryPGSL,
} from './sparql-engine.js';
export type {
  Triple,
  TripleStore,
  SparqlPattern,
  SparqlQuery,
  SparqlResult,
  Binding,
} from './sparql-engine.js';
// SHACL validation
export {
  validateCorePGSL,
  validateStructuralPGSL,
  validateDomainShapes,
  validateAllPGSL,
  domainShapesToTurtle,
} from './shacl.js';
export type {
  ShaclViolation,
  ShaclValidationResult,
  ShaclShapeDefinition,
  ShaclPropertyConstraint,
} from './shacl.js';
// LLM tools
export {
  getToolDefinitions,
  parseToolCalls,
  executeToolCall,
  formatToolPrompt,
  formatToolResult,
  runToolLoop,
} from './tools.js';
export type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolContext,
} from './tools.js';
// Decision functor
export {
  extractObservations,
  computeAffordances,
  selectStrategy,
  decide,
  composeDecisions,
} from './decision-functor.js';
export type {
  Affordance,
  Decision,
  ObservationSection,
  DecisionStrategy,
  DecisionResult,
} from './decision-functor.js';
// Affordance decorators
export {
  createDecoratorRegistry,
  createDefaultRegistry,
  registerDecorator,
  removeDecorator,
  decorateNode,
  coreSystemDecorator,
  ontologyPatternDecorator,
  coherenceDecorator,
  persistenceDecorator,
  xapiDomainDecorator,
  federationDecorator,
  llmAdvisorDecorator,
} from './affordance-decorators.js';
export type {
  AffordanceDecorator,
  DecoratorContext,
  DecoratedAffordance,
  StructuralSuggestion,
  DecoratorResult,
  DecoratorRegistry,
} from './affordance-decorators.js';
// Agent framework (AAT, Policy, PROV, Personal Broker)
export {
  ObserverAAT, AnalystAAT, ExecutorAAT, ArbiterAAT, ArchivistAAT, FullAccessAAT,
  createAATRegistry, registerAAT, getAAT, filterAffordancesByAAT, validateAction,
  createPolicyEngine, addRule, removeRule, evaluate as evaluatePolicy, defaultPolicies,
  createTraceStore, recordTrace, getTraces, traceToTurtle, wrapWithTracing,
  createPersonalBroker, startConversation, addMessage, getMemoryStats, setPresence,
  createAATDecorator,
  verifyCoherenceTraced,
  createAgentContext,
} from './agent-framework.js';
export type {
  AbstractAgentType, AATRegistry,
  DeonticMode, PolicyRule, PolicyContext, PolicyDecision, PolicyEngine,
  ProvTrace, TraceStore, TraceFilter, TracedAffordance,
  PersonalBroker, Conversation, ConversationMessage, AgentMemory, PresenceStatus,
} from './agent-framework.js';
// Infrastructure (Enclaves, Checkpoints, CRDT)
export {
  createEnclaveRegistry, createEnclave, forkEnclave, getEnclave, listEnclaves,
  freezeEnclave, mergeEnclave, abandonEnclave, enclaveStats,
  createCheckpointStore, createCheckpoint, restoreCheckpoint, getCheckpoint,
  listCheckpoints, diffCheckpoints, checkpointStats,
  createCRDTState, incrementClock, mergeClock, happensBefore,
  createOp, applyOp, getPendingOps, markSynced, crdtStats,
} from './infrastructure.js';
export type {
  Enclave, EnclaveRegistry, MergeReport,
  Checkpoint, CheckpointState, CheckpointStore, CheckpointDiff,
  VectorClock, CRDTOperation, CRDTState, ApplyResult,
} from './infrastructure.js';
// Discovery (Introspection, Virtual Layer, Metagraph, Marketplace)
export {
  createIntrospectionAgent, introspectJson, introspectCsv, introspectRdf, introspectApi, applyIntrospection,
  createVirtualLayer, registerReference, resolveReference, invalidateCache, virtualLayerStats,
  generateMetagraph, ingestMetagraph, validateMetagraph, queryMetagraph,
  createMarketplace, registerListing, removeListing, discoverByCapability, discoverByType,
  refreshListing, marketplaceToHydra, marketplaceStats,
} from './discovery.js';
export type {
  DataSource, IntrospectionResult, DiscoveredSchema, DiscoveredEntity, DiscoveredRelationship,
  VirtualReference, VirtualLayerConfig, VirtualLayer,
  MetagraphDescriptor,
  MarketplaceListing, MarketplaceOperation, Marketplace,
} from './discovery.js';
// Runtime evaluation
export {
  computeConfidence,
  confidenceLevel,
  evaluate as runtimeEvaluate,
  answerWithEval,
  createRuntimeEvalDecorator,
  getEvalHistory,
  recordEvalOutcome,
  historicalAccuracy,
  DEFAULT_EVAL_CONFIG,
} from './runtime-eval.js';
export type {
  ConfidenceLevel,
  StructuralSignals,
  RuntimeEval,
  EvalHistoryEntry,
  RuntimeEvalConfig,
} from './runtime-eval.js';
// Progressive persistence
export {
  createPersistenceRegistry,
  recordPersistence,
  getMaxTier,
  getTierRecords,
  getNodesAtTier,
  promoteToLocal,
  promoteToPod,
  promoteToIpfs,
  promoteToChain,
  resolve as resolveFromTiers,
  promoteBatch,
  persistenceStats,
  TierName,
} from './persistence.js';
export type {
  PersistenceTier,
  PersistenceRecord,
  ResolutionResult,
  PersistenceRegistry,
} from './persistence.js';
