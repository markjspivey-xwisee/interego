/**
 * @foxxi/context-graphs
 *
 * Reference implementation of Context Graphs 1.0 — a compositional
 * framework for typed graph contexts over RDF 1.2 Named Graphs.
 *
 * Spec: https://markjspivey-xwisee.github.io/context-graphs/spec/context-graphs-1.0-wd.html
 * Author: Mark Spivey <mark.spivey@xwisee.com>
 * License: CC-BY-4.0
 *
 * @example
 * ```ts
 * import { ContextDescriptor, toTurtle, validate } from '@foxxi/context-graphs';
 *
 * const desc = ContextDescriptor.create('urn:cg:my-context')
 *   .describes('urn:graph:observations-2026-Q1')
 *   .temporal({ validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-03-31T23:59:59Z' })
 *   .asserted(0.95)
 *   .selfAsserted('did:web:context-graphs-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io')
 *   .build();
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
} from './solid/index.js';

// ── PGSL (Poly-Granular Sequence Lattice) ───────────────────
export {
  createPGSL,
  mintAtom,
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
} from './pgsl/index.js';
