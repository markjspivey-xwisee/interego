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
  resetComposedIdCounter,
  stripStringsAndComments,
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
  // Temporal modal operators (LTL-style)
  effectiveModal,
  temporalAnnotations,
  temporalNow,
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
  EffectiveModal,
  TemporalContext,
  TemporalAnnotations,
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
  AccessControlPolicyData,
  DeonticMode,
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
  // RDF 1.2 helpers
  langString,
  parseLangString,
  withRdf12VersionDirective,
  detectRdf12Features,
  RDF12_VERSION_DIRECTIVE,
  // TriG / Turtle subject-extraction parser
  parseTrig,
  findSubjectsOfType,
  readStringValue,
  readStringValues,
  readIntegerValue,
  readIriValue,
} from './rdf/index.js';
export type {
  BaseDirection,
  ParsedDocument,
  ParsedSubject,
  ParsedTerm,
  ParsedLiteral,
  ParsedIri,
  ParsedBNode,
} from './rdf/index.js';

// ── Turtle literal escaping (substrate primitive) ───────────
export {
  escapeTurtleLiteral,
  unescapeTurtleLiteral,
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
  resolveDid,
  extractPublicKey,
  findStorageEndpoint,
  // IPFS Anchoring — solid/ipfs.ts also has a computeCid (async,
  // signed-descriptor anchor variant). It's exported as
  // `computeSolidCid` so the bare `computeCid` name resolves to the
  // sync crypto/ipfs.ts variant that tests + most callers expect.
  computeCid as computeSolidCid,
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
  predictDescriptorUrl,
  // Transient-network retry (substrate plumbing for fetch wrappers)
  withTransientRetry,
  isTransientNetworkError,
  // Generic affordance follower (Path A reach-anywhere primitive)
  followAffordance,
  DescriptorNotFoundError,
  AffordanceNotFoundError,
} from './solid/index.js';

export type {
  TransientRetryOptions,
  FollowAffordanceOptions,
  FollowAffordanceResult,
  ResolvedAffordance,
  AffordanceMethod,
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
  resolve,
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
  countUniquePGSL,
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
  matchPattern,
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
  // Abstract Agent Types (AATs) + policy engine + provenance trace
  // store + personal broker. Built-in AATs (Observer / Analyst /
  // Executor / Arbiter / Archivist / FullAccess) + the registry
  // mechanism that lets a deployment add custom AATs.
  ObserverAAT,
  AnalystAAT,
  ExecutorAAT,
  ArbiterAAT,
  ArchivistAAT,
  FullAccessAAT,
  createAATRegistry,
  registerAAT,
  getAAT,
  filterAffordancesByAAT,
  validateAction,
  createPolicyEngine,
  addRule,
  removeRule,
  evaluatePolicy,
  evaluatePolicy as evaluate,
  defaultPolicies,
  createTraceStore,
  recordTrace,
  getTraces,
  verifyCoherenceTraced,
  createAgentContext,
  createPersonalBroker,
  startConversation,
  addMessage,
  getMemoryStats,
  setPresence,
  createAATDecorator,
  traceToTurtle,
  wrapWithTracing,
  // Infrastructure — Enclaves, Checkpoints, CRDT
  createEnclaveRegistry,
  createEnclave,
  forkEnclave,
  getEnclave,
  listEnclaves,
  freezeEnclave,
  mergeEnclave,
  abandonEnclave,
  enclaveStats,
  createCheckpointStore,
  createCheckpoint,
  restoreCheckpoint,
  getCheckpoint,
  listCheckpoints,
  diffCheckpoints,
  checkpointStats,
  createCRDTState,
  incrementClock,
  mergeClock,
  happensBefore,
  createOp,
  applyOp,
  getPendingOps,
  markSynced,
  crdtStats,
  // Discovery — Introspection, Virtual Layer, Metagraph, Marketplace
  createIntrospectionAgent,
  introspectJson,
  introspectCsv,
  introspectRdf,
  introspectApi,
  applyIntrospection,
  createVirtualLayer,
  registerReference,
  resolveReference,
  invalidateCache,
  virtualLayerStats,
  generateMetagraph,
  ingestMetagraph,
  validateMetagraph,
  queryMetagraph,
  createMarketplace,
  registerListing,
  removeListing,
  discoverByCapability,
  discoverByType,
  refreshListing,
  marketplaceStats,
  marketplaceToHydra,
} from './pgsl/index.js';

export type {
  OntologyName,
  OntologyManifestEntry,
  // Agent framework types
  AbstractAgentType,
  AATRegistry,
  DeonticMode as PgslDeonticMode,
  PolicyRule,
  PolicyContext as PgslPolicyContext,
  PolicyDecision as PgslPolicyDecision,
  PolicyEngine,
  ProvTrace,
  TraceStore,
  TraceFilter,
  TracedAffordance,
  PersonalBroker,
  Conversation,
  ConversationMessage,
  AgentMemory,
  PresenceStatus,
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
  // The OODA-loop `act` is the cognitive-loop phase (Boyd), not a
  // substrate primitive. Re-exported as oodaAct so the bare `act`
  // name is reserved for the kernel's Peircean-Thirdness substrate
  // verb. Substrate is the principled owner of the unqualified verb.
  act as oodaAct,
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
  computeCid,
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
  signMessageRaw,
  recoverMessageSigner,
  getNostrPubkey,
  schnorrSign,
  schnorrVerify,
  sha256Hex,
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
  deriveEncryptionKeyPair,
  generateContentKey,
  encryptContent,
  decryptContent,
  wrapKeyForRecipient,
  unwrapKey,
  createEncryptedEnvelope,
  openEncryptedEnvelope,
  openEncryptedEnvelopeWithHistory,
  reEncryptForRecipients,
  envelopeToJson,
  envelopeFromJson,
  // Facet-field encryption
  encryptFacetValue,
  decryptFacetValue,
  isEncryptedFacetValue,
  encryptedFacetValueToTurtle,
  parseEncryptedFacetValueFromTurtle,
  // Pedersen commitments + range proofs (substrate primitives for
  // private-aggregation patterns). Includes the bit-decomposition
  // RangeProof aliased as PedersenRangeProof to disambiguate from the
  // hash-chain RangeProof in zk/.
  H_GENERATOR_LABEL,
  deriveBlinding,
  randomBlinding,
  pedersenCommit,
  commit,
  verifyPedersenOpening,
  verifyOpening,
  addCommitments,
  verifyHomomorphicSum,
  sampleLaplaceFloat,
  sampleLaplaceInt,
  splitSecret,
  reconstructSecret,
  splitSecretWithCommitments,
  verifyFeldmanShare,
  filterVerifiedShares,
  proveBit,
  verifyBit,
  proveRange,
  verifyRange,
  // Zero-Knowledge Proofs (the bare `commit` name is Pedersen's; the
  // zk chain-hash commit is exported below as `zkCommit`. Tests that
  // previously imported `commit` from the deep zk path now use the
  // Pedersen one — verified compatible because both produce
  // commitment hex strings that downstream code carries opaquely.)
  verifyCommitment,
  proveConfidenceAboveThreshold,
  verifyConfidenceProof,
  verifyConfidenceProofByReveal,
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
  // Feldman per-share verifier (aliased — the Pedersen `verifyOpening`
  // is already exported above by its bare name; we only need to surface
  // the Feldman verifier here under its bare name for back-compat).
  verifyFeldmanShare as verifyShare,
  secretCommitment,
  // DKG (Pedersen-based distributed key generation; substrate
  // primitive for committee-secret protocols).
  dkgRound1,
  dkgRound2,
  dkgRound3,
  simulateDKG,
  // Differential-privacy accountant (Renyi DP; substrate primitive
  // used by aggregate-privacy + downstream regulator-audit flows).
  sweepRenyiBestEpsilon,
  AdvancedCompositionAccountant,
  RenyiAccountant,
  // Shamir polynomial evaluator (low-level — exported because
  // existing tests reach in directly).
  evaluateAt,
  // ZK chain-hash commit (distinct from the Pedersen commit above;
  // here under its zkCommit name so callers don't conflict with the
  // Pedersen one. The zk verifier `verifyCommitment` is already
  // exported separately.)
  zkCommit,
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
  PedersenCommitment,
  ShamirShare,
  FeldmanCommitments,
  VerifiableShamirShare,
  BitProof,
  PedersenRangeProof,
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

// ── Per-vertical compositions live in sibling @interego/* packages ──
//
// Interego = primitives + composition mechanics for emergence. Anything
// that CAN be composed from the substrate primitives is split out into
// its own package so the kernel surface stays minimal + the composition
// boundaries are explicit. The verticals now live in:
//
//   @interego/connectors        @interego/extractors
//   @interego/registry          @interego/constitutional
//   @interego/compliance        @interego/privacy
//   @interego/security-txt      @interego/p2p
//   @interego/ops               @interego/transactions
//   @interego/passport          @interego/abac
//   @interego/skills
//
// Callers should import the verticals they need directly — that's the
// principled form. Back-compat re-exports live in `@interego/core/compat`
// (a separate package subpath emitted by a second tsc pass against
// `tsconfig.compat.json` after the leaves build). Existing callers that
// used `from '@interego/core'` for the moved symbols should migrate to
// either the per-vertical package or `@interego/core/compat` over the
// transition window.

// ── Kernel (the substrate's primitives as a first-class API) ────────
//
// Interego = primitives + composition mechanics for emergence. The
// kernel surfaces the six-to-eight verbs that already exist in the
// codebase (mint, dereference, compose, act, restrict, extend,
// promote, decompose) as a coherent first-class API. Higher-layer
// operations (publish_context, register_agent, ...) compose these.
// See docs/ARCHITECTURAL-FOUNDATIONS.md §11.
export * as kernel from './kernel/index.js';
// Spread the kernel verbs at the top level for ergonomic imports.
// The kernel's `act` claims the bare `act` name at top level — it is
// the substrate's irreducible Peircean-Thirdness verb (act on an
// affordance). The OODA-loop `act` (cognitive-loop phase, not a
// substrate primitive) is re-exported as `oodaAct` above. The
// principled name belongs to the substrate. `kernelAct` is also
// exported as an explicit alias for back-compat with callers that
// adopted the name during the transition.
export {
  mint,
  dereference,
  compose,
  act,
  act as kernelAct,
  restrict,
  extend,
  promote,
  decompose,
  extractAffordancesFromTurtle,
  resetKernelState,
  decorateKernelResult,
  decorateShim,
  hydraAffordance,
  hydraEntryPoint,
  KERNEL_JSONLD_CONTEXT,
  KERNEL_RESULT_SHAPES,
} from './kernel/index.js';
export type {
  Holon,
  Affordance as KernelAffordance,
  KernelCompositionOperator,
  MintOptions,
  MintResult,
  DereferenceOptions,
  DereferenceResult,
  DereferencedManifestEntry,
  ComposeOptions,
  ComposeResult,
  ActOptions,
  ActAffordance,
  ActResult,
  RestrictSelector,
  RestrictResult,
  ExtendOptions,
  ExtendResult,
  PromoteOptions,
  PromoteResult,
  DecomposeResult,
  HypermediaAffordance,
  HypermediaEnvelope,
  KernelResultKind,
} from './kernel/index.js';

// ── Name service (L2 — attestation-based naming) ───────────────────
// A name is a verifiable attestation (`<did> foaf:nick "alice"`), not a
// claimed registration. Forward + reverse resolution by federated
// discovery + a pluggable trust policy. See docs/NAME-SERVICE.md.
export {
  buildNameAttestation,
  attestName,
  resolveName,
  namesFor,
  defaultNameTrustPolicy,
  directoryNameIndex,
} from './naming/index.js';
export type {
  NamingConfig,
  AttestNameArgs,
  AttestNameResult,
  NameCandidate,
  ResolveOptions as NameResolveOptions,
  NameTrustPolicy,
  NameHint,
} from './naming/index.js';
