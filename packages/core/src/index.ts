/**
 * @interego/core
 *
 * Reference implementation of Interego 1.0 — a compositional
 * framework for typed graph contexts over RDF 1.2 Named Graphs.
 *
 * Spec: https://markjspivey-xwisee.github.io/interego/spec/interego-protocol-1.0-wd.html
 * Author: Interego
 * License: MIT
 *
 * @example
 * ```ts
 * import { ContextDescriptor, toTurtle, validate } from '@interego/core';
 *
 * const desc = ContextDescriptor.create('urn:iep:my-context')
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
  createSignedDelegationCredential,
  canonicalCredentialPayload,
  canonicalAuthorshipPayload,
  createSignedAuthorship,
  verifySignedAuthorship,
  ownerProfileToTurtle,
  parseOwnerProfile,
  delegationCredentialToJsonLd,
  parseDelegationCredential,
  verifyDelegation,
  verifyDelegationChain,
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
  // higher-level ontology terms tagged iep:constructedFrom
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
  DelegationSigner,
  DelegationVerifier,
  DelegationVerificationOptions,
  AuthorshipProof,
  AuthorshipProofInputs,
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
  SignedDelegationCredential,
  DelegationProof,
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
} from './rdf/index.js';
// Virtualized RDF layer (materializeSystem / executeSparqlProtocol /
// systemToTurtle / writeBackTriples / sparqlUpdateHandler + its types)
// lived here while PGSL was bundled into core. They now live in
// `@interego/pgsl`. The compat shim re-exports the historical names so
// existing `import { ... } from '@interego/core'` consumers keep
// working through the migration.

// ── Validation ───────────────────────────────────────────────
export {
  validate,
  assertValid,
  getShaclShapesTurtle,
  SHACL_SHAPES_TURTLE,
  validateAgainstShape,
  type ShaclReport,
  type ShaclResult,
  type ShaclSeverity,
  type ValidateAgainstShapeOptions,
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
//
// The Solid + LDP binding lives in `@interego/solid`. Substrate-level
// HTTP types (FetchFn / FetchResponse / WebSocket*) live in
// `@interego/core/http`; the generic affordance follower lives in
// `@interego/core/affordance`; withTransientRetry lives in
// `@interego/core/http`.

// Local re-exports kept here because they're substrate-shaped — used
// by the kernel. `ManifestEntry` is the substrate's manifest-row shape;
// `withTransientRetry` and `isTransientNetworkError` are the substrate's
// transient retry helper; `followAffordance` is the generic affordance
// follower; the FetchFn family is substrate HTTP.
export {
  withTransientRetry,
  isTransientNetworkError,
} from './http/index.js';
export type {
  TransientRetryOptions,
  FetchFn,
  FetchResponse,
  WebSocketLike,
  WebSocketConstructor,
} from './http/index.js';
export {
  followAffordance,
  DescriptorNotFoundError,
  AffordanceNotFoundError,
} from './affordance/index.js';
export type {
  FollowAffordanceOptions,
  FollowAffordanceResult,
  ResolvedAffordance,
  AffordanceMethod,
} from './affordance/index.js';

// `ManifestEntry` — substrate-level shape of the .well-known/context-graphs
// manifest. The Solid binding (`@interego/solid`) writes + reads the
// manifest; the substrate type is kept here so the kernel + affordance
// follower can work against rows without the binding.
export type { ManifestEntry } from './manifest/index.js';

// ── PGSL (Poly-Granular Sequence Lattice) ───────────────────
//
// PGSL lives in its own package: `@interego/pgsl`. The kernel's `mint` /
// `promote` / `decompose` verbs reach the lattice through the registered
// `LatticeAdapter`; importing `@interego/pgsl` registers the lattice-
// aware adapter as a side effect.

// ── Affordance Engine ────────────────────────────────────────
export {
  computeAffordances,
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
  makeWalletDelegationSigner,
  makeWalletDelegationVerifier,
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
// Lives in `@interego/solid` — the SDK is convenience over
// publish/discover/subscribe, which are the Solid binding's surface.

// ── Per-vertical compositions live in sibling @interego/* packages ──
//
// Interego = primitives + composition mechanics for emergence. Anything
// that CAN be composed from the substrate primitives is split out into
// its own package so the kernel surface stays minimal + the composition
// boundaries are explicit. The verticals live in:
//
//   @interego/solid             @interego/pgsl
//   @interego/connectors        @interego/extractors
//   @interego/registry          @interego/constitutional
//   @interego/compliance        @interego/privacy
//   @interego/security-txt      @interego/p2p
//   @interego/ops               @interego/transactions
//   @interego/passport          @interego/abac
//   @interego/skills
//
// Callers import the verticals they need directly. `@interego/core` no
// longer re-exports vertical symbols; the per-package import path is the
// only one.

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
  reduce,
  extractAffordancesFromTurtle,
  resetKernelState,
  clearUrnGraphCache,
  setSolidModuleForTests,
  decorateKernelResult,
  decorateShim,
  hydraAffordance,
  hydraEntryPoint,
  KERNEL_JSONLD_CONTEXT,
  KERNEL_RESULT_SHAPES,
  HYPERMEDIA_MARKDOWN_MEDIA_TYPE,
  HYPERMEDIA_MARKDOWN_VARIANT,
  controlsFromAffordances,
  parseHypermediaMarkdown,
  renderHypermediaMarkdown,
} from './kernel/index.js';
export type {
  HypermediaControl,
  HypermediaMarkdownDoc,
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
  ReducerSpec,
  ReduceOptions,
  ReduceResult,
  ReplayProof,
  ReplayCheckpoint,
  HypermediaAffordance,
  HypermediaEnvelope,
  KernelResultKind,
} from './kernel/index.js';

// ── Name service (L2 — attestation-based naming) ───────────────────
// Lives in `@interego/solid/naming` (it composes against the Solid
// binding's publish + discover).

// ── HTTP plumbing (substrate-level — FetchFn / fetch resolver / retry) ──
// Authoritative location for substrate HTTP types + helpers.
export {
  getDefaultFetch,
  getDefaultWebSocket,
} from './http/index.js';

// ── Lattice adapter (substrate-level — pluggable mint/promote/decompose backend) ──
// The kernel's lattice ops delegate to the active adapter. `@interego/pgsl`
// registers a lattice-aware adapter at module-load time; without it a
// pure-hash fallback preserves wire compat (URI scheme is unchanged).
export {
  setKernelLatticeAdapter,
  getKernelLatticeAdapter,
  fallbackLatticeAdapter,
} from './lattice/index.js';
export type {
  LatticeAdapter,
  LatticeValue,
  LatticeLevel,
  LatticeProvenance,
  AdapterMintResult,
  AdapterPromoteResult,
  AdapterDecomposeResult,
  AdapterResolveResult,
} from './lattice/index.js';
