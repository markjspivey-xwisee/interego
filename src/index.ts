/**
 * @interego/core
 *
 * Reference implementation of Interego 1.0 — a compositional
 * framework for typed graph contexts over RDF 1.2 Named Graphs.
 *
 * Spec: https://markjspivey-xwisee.github.io/interego/spec/interego-1.0.html
 * Author: Interego
 * License: MIT
 *
 * @example
 * ```ts
 * import { ContextDescriptor, toTurtle, validate } from '@interego/core';
 *
 * const desc = ContextDescriptor.create('urn:cg:my-context')
 *.describes('urn:graph:observations-2026-Q1')
 *.temporal({ validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-03-31T23:59:59Z' })
 *.asserted(0.95)
 *.selfAsserted('did:web:interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io')
 *.build();
 *
 * const result = validate(desc);
 * console.log(result.conforms); // true
 *
 * console.log(toTurtle(desc));
 * ```
 */

// ── Model ────────────────────────────────────────────────────
export {
  ContextDescriptor,
  union,
  intersection,
  restriction,
  override,
  effectiveContext,
  createOwnerProfile,
  addAuthorizedAgent,
  removeAuthorizedAgent,
  createDelegationCredential,
  ownerProfileToTurtle,
  parseOwnerProfile,
  delegationCredentialToJsonLd,
  verifyDelegation,
  registerFacetType,
  getFacetEntry,
  getRegisteredTypes,
  executeMerge,
  asSign,
  fromSign,
  // Category theory — presheaf, naturality, lattice laws
  toPresheaf,
  fromPresheaf,
  verifyUnionNaturality,
  verifyIntersectionNaturality,
  verifyIdempotence,
  verifyCommutativity,
  verifyAssociativity,
  verifyAbsorption,
  verifyBoundedLattice,
  // Semiotic — Sign functor, adjunction, field functor
  phi,
  psi,
  signUnion,
  signIntersection,
  adjunctionUnit,
  adjunctionCounit,
  verifyAdjunction,
  semioticField,
  verifySemioticFieldFunctoriality,
  // Publish-input preprocessing (modal-truth + cleartext mirror)
  normalizePublishInputs,
  extractRevocationConditions,
  // Derivation (spec/DERIVATION.md) — runtime constructors for
  // higher-level ontology terms tagged cg:constructedFrom
  constructOmega,
  makeGeometricMorphism,
  ModalAlgebra,
  facetModal,
  descriptorModal,
  composeFacetTransformations,
  identityFacetTransformation,
} from './model/index.js';
export type {
  PublishInputs,
  PreprocessedPublish,
  Omega,
  OmegaVerdict,
  PodView,
  GeometricMorphism,
  ModalValue,
  FacetTransformation,
} from './model/index.js';

// ── Causality (Pearl's SCM Framework) ───────────────────────
export {
  buildSCM,
  hasCycle,
  topologicalSort,
  ancestors,
  descendants,
  parents,
  children,
  doIntervention,
  isDSeparated,
  causalPaths,
  evaluateCounterfactual,
  satisfiesBackdoorCriterion,
  findBackdoorSet,
  satisfiesFrontDoorCriterion,
  scmSummary,
} from './model/causality.js';

export type {
  IRI,
  ContextDescriptorData,
  ComposedDescriptorData,
  ContextFacetData,
  ContextTypeName,
  TemporalFacetData,
  ProvenanceFacetData,
  ProvenanceActivity,
  AgentFacetData,
  AgentDescription,
  AccessControlFacetData,
  Authorization,
  SemioticFacetData,
  TrustFacetData,
  FederationFacetData,
  Distribution,
  TripleContextAnnotation,
  TripleTerm,
  ModalStatus,
  TrustLevel,
  AgentRole,
  SyncProtocol,
  CompositionOperator,
  ACLMode,
  DelegationScope,
  AuthorizedAgentData,
  OwnerProfileData,
  AgentDelegationCredential,
  DelegationVerification,
  PodDirectoryEntry,
  PodDirectoryData,
  CausalFacetData,
  CausalRole,
  CausalVariable,
  CausalEdge,
  StructuralCausalModel,
  CausalIntervention,
  CounterfactualQuery,
  ProjectionFacetData,
  ExternalBinding,
  VocabularyMapping,
  BindingStrength,
  ValidationResult,
  ValidationViolation,
  Sign,
  MergeStrategy,
  FacetRegistryEntry,
  DescriptorPresheaf,
  NaturalityWitness,
  LatticeLawProof,
  SignMorphism,
  // Activity & Session (§9)
  AgentPlatform,
  ExecutionMode,
  ToolCallRecord,
  GitContext,
  ActivityTrace,
  // Identity Anchoring (§10)
  ERC8004Identity,
  SIWEProof,
  IPFSAnchor,
  BlockchainAnchor,
  OpenBadgeCredential,
  LERSRecord,
  IdentityAnchors,
  // Payment (§11)
  PaymentRequirement,
  PaymentReceipt,
} from './model/index.js';

export type { CounterfactualResult } from './model/causality.js';

// ── RDF Serialization ────────────────────────────────────────
export {
  toTurtle,
  toTurtleDocument,
  toTripleAnnotationTurtle,
  toTripleAnnotationDocument,
  toJsonLd,
  toJsonLdString,
  fromJsonLd,
  CONTEXT_GRAPHS_JSONLD_CONTEXT,
  CONTEXT_GRAPHS_JSONLD_CONTEXT_URL,
} from './rdf/index.js';

// ── Namespaces ───────────────────────────────────────────────
export {
  CG, RDF, RDFS, XSD, OWL, PROV, TIME, DCT, AS, SHACL, ACL, VC, DID, DCAT, LDP, SOLID, OA, HYDRA, DPROD, FOAF, SKOS,
  PREFIXES,
  CGClass,
  CGProp,
  CGContextType,
  CGCompositionOp,
  CGModalStatus,
  CGTrustLevel,
  CGAgentRole,
  CGSyncProtocol,
  expand,
  compact,
  turtlePrefixes,
  sparqlPrefixes,
} from './rdf/index.js';

// ── System Ontology & Virtualized RDF Layer ─────────────────
export {
  systemOntology,
  systemShaclShapes,
  systemHydraApi,
  systemDcatCatalog,
  allPrefixes,
  CG_NS,
  materializeSystem,
  executeSparqlProtocol,
  writeBackTriples,
  sparqlUpdateHandler,
  systemToTurtle,
  systemToJsonLd,
} from './rdf/index.js';
export type {
  SystemState,
  SparqlProtocolResult,
  WriteBackResult,
} from './rdf/index.js';

// ── Validation ───────────────────────────────────────────────
export {
  validate,
  assertValid,
  getShaclShapesTurtle,
  SHACL_SHAPES_TURTLE,
} from './validation/index.js';

// ── SPARQL Patterns ──────────────────────────────────────────
export {
  queryContextForGraph,
  queryGraphsAtTime,
  queryGraphsInInterval,
  queryGraphsByModalStatus,
  queryGraphsByFacetType,
  queryProvenanceChain,
  queryGraphsByTrustLevel,
  queryGraphsByOrigin,
  queryContextManifest,
  askHasContextType,
  constructContextForGraph,
} from './sparql/index.js';

// ── Solid Integration ───────────────────────────────────────
export {
  publish,
  discover,
  subscribe,
  parseManifest,
  writeAgentRegistry,
  readAgentRegistry,
  writeDelegationCredential,
  verifyAgentDelegation,
  AGENT_REGISTRY_PATH,
  CREDENTIALS_PATH,
  podDirectoryToTurtle,
  parsePodDirectory,
  fetchPodDirectory,
  publishPodDirectory,
  POD_DIRECTORY_PATH,
  resolveWebFinger,
  didWebToUrl,
  resolveDidWeb,
  extractPublicKey,
  findStorageEndpoint,
  // IPFS Anchoring
  computeCid,
  computeLatticeCids,
  pinToIPFS,
  computeDescriptorAnchor,
  // Zero-Copy Anchor Receipts
  writeAnchor,
  writeAnchors,
  readAnchors,
  // E2EE envelope fetch
  fetchGraphContent,
  // Hypermedia: descriptor -> graph payload link
  parseDistributionFromDescriptorTurtle,
  // Cross-pod sharing
  resolveHandleToPodUrl,
  resolveRecipient,
  resolveRecipients,
  // Shape discovery (§6.5b)
  resolveShape,
  listPodShapes,
  parseShapeIndex,
  shapeIndexTurtle,
  POD_SHAPES_PATH,
  POD_SHAPES_INDEX_PATH,
  // Progressive discovery (§6.5d)
  resolveIdentifier,
  fetchWellKnownAgents,
  parseAgentsCatalog,
  agentsCatalogTurtle,
  WELL_KNOWN_AGENTS_PATH,
  socialWalk,
} from './solid/index.js';

export type {
  FetchFn,
  FetchResponse,
  WebSocketLike,
  WebSocketConstructor,
  PublishResult,
  PublishOptions,
  DiscoverFilter,
  DiscoverOptions,
  ManifestEntry,
  ContextChangeEvent,
  ContextChangeCallback,
  Subscription,
  SubscribeOptions,
  ContextGraphsManifest,
  RegistryOptions,
  WebFingerResult,
  WebFingerLink,
  DidDocument,
  VerificationMethod,
  ServiceEndpoint,
  DidResolutionResult,
  IpfsAnchorReceipt,
  SignatureAnchorReceipt,
  EncryptionAnchorReceipt,
  PgslAnchorReceipt,
  ActivityAnchorReceipt,
  AnchorReceipt,
  ShareHandle,
  ResolvedRecipientPod,
  ResolveRecipientsOptions,
  DistributionLink,
  ResolvedShape,
  ShapeIndexEntry,
  DiscoveryResult,
  DiscoveryTier,
  AgentCatalogEntry,
  SocialWalkResult,
  PodNode,
  PodEdge,
  SocialWalkOptions,
} from './solid/index.js';

// ── PGSL (Poly-Granular Sequence Lattice) ───────────────────
export {
  createPGSL,
  mintAtom,
  mintEncryptedAtom,
  resolveAtomValue,
  ingest,
  resolve as pgslResolve,
  queryNeighbors,
  latticeStats,
  fiber,
  maxLevel,
  constituents,
  pullbackSquare,
  ancestorFragments,
  descendantNodes,
  latticeMeet,
  isSubFragment,
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
  liftToDescriptor,
  embedInPGSL,
  verifyIntersectionCoherence,
  verifyProvenanceNaturality,
  structuralRetrieve,
  atomRetrieve,
  computeContainmentAnnotations,
  allContainmentAnnotations,
  // Entity/relation extraction
  extractEntities,
  extractRelations,
  classifyQuestion,
  expandEntitiesWithOntology,
  // Computation (structural date math, counting, aggregation)
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
  signNode,
  verifyNodeSignature,
  // Coherence
  verifyCoherence,
  computeCoverage,
  getCertificates,
  getCoherenceStatus,
  // Ingestion profiles
  registerProfile,
  getProfile,
  listProfiles,
  ingestWithProfile,
  batchIngestWithProfile,
  // SPARQL engine
  createTripleStore,
  addTriple,
  addTriples,
  matchPattern as sparqlMatchPattern,
  materializeTriples,
  parseSparql,
  executeSparql,
  executeSparqlString,
  sparqlQueryPGSL,
  // SHACL validation
  validateCorePGSL,
  validateStructuralPGSL,
  validateDomainShapes,
  validateAllPGSL,
  domainShapesToTurtle,
  // LLM tools
  getToolDefinitions,
  parseToolCalls,
  executeToolCall,
  formatToolPrompt,
  formatToolResult,
  runToolLoop,
  // Decision functor
  extractObservations,
  computeAffordances as computeDecisionAffordances,
  selectStrategy,
  decide as decideFromObservations,
  composeDecisions,
  // Affordance decorators
  createDecoratorRegistry,
  createDefaultRegistry,
  registerDecorator,
  removeDecorator,
  decorateNode,
  // Static ontology loaders (Node-only — reads docs/ns/*.ttl)
  loadOntology,
  loadFullOntology,
  loadFullShapes,
  getOntologyManifest,
  ONTOLOGY_MANIFEST,
} from './pgsl/index.js';

export type {
  OntologyName,
  OntologyManifestEntry,
} from './pgsl/index.js';

export type {
  Value,
  Level,
  Height,
  Atom,
  Fragment,
  Node as PGSLNode,
  NodeProvenance,
  PGSLInstance,
  Direction,
  ConstituentMorphism,
  PullbackSquare,
  ContainmentAnnotation,
  ContainmentRole,
  TokenGranularity,
  RetrievalResult,
  RetrievalOptions,
  // SPARQL engine types
  Triple,
  TripleStore,
  SparqlQuery,
  SparqlResult,
  Binding,
  // SHACL types
  ShaclViolation,
  ShaclValidationResult,
  ShaclShapeDefinition,
  ShaclPropertyConstraint,
  // Tool types
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolContext,
  // Coherence types
  CoherenceStatus,
  CoherenceCertificate,
  CoherenceObstruction,
  CoherenceCoverage,
  AtomCoherence,
  // Ingestion profile types
  IngestionProfile,
  XapiStatement,
  LersCredential,
  RdfTriple,
  // Decision functor types
  Affordance as DecisionAffordance,
  Decision,
  ObservationSection,
  DecisionStrategy,
  DecisionResult,
  // Decorator types
  AffordanceDecorator,
  DecoratorContext,
  DecoratedAffordance,
  StructuralSuggestion,
  DecoratorResult,
  DecoratorRegistry,
} from './pgsl/index.js';

// ── Affordance Engine ────────────────────────────────────────
export {
  computeAffordances,
  computeCognitiveStrategy,
  createAgentState,
  assimilateDescriptor,
  addDesire,
  commitToAffordance,
  createOODACycle,
  observe,
  orient,
  decide,
  act,
  evaluateSurprise,
  createStigmergicField,
  updateStigmergicField,
} from './affordance/index.js';

export type {
  AffordanceAction,
  AffordanceReason,
  Affordance as AffordanceResult,
  AntiAffordance,
  AffordanceSet,
  Signifier,
  AgentProfile,
  AgentCapability,
  TrustPolicy,
  CausalAffordanceEffect,
  OODAPhase,
  Orientation,
  TrustEvaluation as AffordanceTrustEvaluation,
  OODACycle,
  CompletedAction,
  SituationalAwarenessLevel,
  PerceptionState,
  ComprehensionState,
  ProjectionState,
  AnticipatedChange,
  AgentState,
  BeliefEntry,
  Desire,
  CommittedAffordance,
  CognitiveStrategy,
  ReconsiderationTrigger,
  FreeEnergyEvaluation,
  FreeEnergyResponse,
  StigmergicField,
  PodFieldState,
  TrustDistribution,
} from './affordance/index.js';

// ── Crypto / IPFS / Wallets ──────────────────────────────────
export {
  sha256,
  computeCid as cryptoComputeCid,
  CHAIN_CONFIGS,
  setChain,
  getChainConfig,
  checkBalance,
  getConnectedSigner,
  pinToIpfs,
  createIpfsAnchor,
  pinPgslFragment,
  pinDescriptor,
  createWallet,
  importWallet,
  exportPrivateKey,
  createDelegation,
  verifyDelegationSignature,
  signDescriptor,
  verifyDescriptorSignature,
  createAgentToken,
  createSiweMessage,
  formatSiweMessage,
  signSiweMessage,
  verifySiweSignature,
  createAgentKitWallet,
  // E2E Encryption
  generateKeyPair,
  generateContentKey,
  encryptContent,
  decryptContent,
  wrapKeyForRecipient,
  unwrapKey,
  createEncryptedEnvelope,
  openEncryptedEnvelope,
  reEncryptForRecipients,
  envelopeToJson,
  envelopeFromJson,
  // Facet-field encryption
  encryptFacetValue,
  decryptFacetValue,
  isEncryptedFacetValue,
  encryptedFacetValueToTurtle,
  parseEncryptedFacetValueFromTurtle,
  // Zero-Knowledge Proofs
  commit,
  verifyCommitment,
  proveConfidenceAboveThreshold,
  verifyConfidenceProof,
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
  proveDelegationMembership,
  verifyDelegationMembership,
  proveTemporalOrdering,
  verifyTemporalProof,
  proveFragmentMembership,
  verifyFragmentMembership,
  createSelectiveDisclosure,
} from './crypto/index.js';

export type {
  CID,
  IpfsPinResult,
  IpfsAnchor,
  IpfsConfig,
  ChainMode,
  ChainConfig,
  WalletBalance,
  Wallet,
  WalletDelegation,
  SignedDescriptor,
  AgentIdentityToken,
  SiweMessage,
  SiweVerification,
  X402PaymentRequired,
  X402PaymentOption,
  X402PaymentReceipt,
  ExternalCredential,
  ExternalCredentialType,
  UniversalWallet,
  CredentialPresentation,
  EncryptionKeyPair,
  ContentKey,
  EncryptedContent,
  WrappedKey,
  EncryptedEnvelope,
  EncryptedFacetValue,
  Commitment,
  RangeProof,
  MerkleProof,
  MerklePathElement,
  TemporalProof,
  FragmentMembershipProof,
  ZKProof,
  SelectiveDisclosure,
} from './crypto/index.js';

// ── SDK (3-line developer API) ───────────────────────────────
export { ContextGraphsSDK } from './sdk.js';
export type {
  ContextGraphsConfig,
  PublishOptions as SDKPublishOptions,
  SearchOptions,
  SearchResult,
  PublishResult as SDKPublishResult,
} from './sdk.js';

// ── Extractors (multi-format content extraction) ─────────────
export {
  extract,
  detectFormat,
} from './extractors/index.js';
export type {
  ExtractionResult,
  TextChunk,
  SourceFormat,
} from './extractors/index.js';

// ── Connectors (Notion, Slack, Web → pod sync) ──────────────
export {
  createConnector,
  createNotionConnector,
  createSlackConnector,
  createWebConnector,
} from './connectors/index.js';
export type {
  ConnectorType,
  ConnectorConfig,
  ConnectorEvent,
  Connector,
  SyncState,
} from './connectors/index.js';
