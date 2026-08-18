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
 *.selfAsserted('did:web:identity.interego.xwisee.com')
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
  TENANT_ADMIN_CAPABILITY,
  createSignedDelegationCredential,
  canonicalCredentialPayload,
  canonicalAuthorshipPayload,
  createSignedAuthorship,
  contentBindingWhenUnchecked,
  verifySignedAuthorship,
  proofBindsToDescriptorUrl,
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
  // Delegate affordance — the live half of the delegation model. Node consumers reach it here;
  // a browser bundle must use the narrow `@interego/core/delegate` subpath instead.
  DELEGATION_SCOPES,
  WRITE_ELIGIBLE_SCOPES,
  isDelegationScope,
  scopeWriteEligible,
  AGENT_ID_RX,
  DELEGATE_LABEL_PREFIX,
  DELEGATE_NAME_MAX,
  DELEGATE_SURFACE,
  delegateLabel,
  parseDelegateLabel,
  delegateNameProblem,
  delegateAgentId,
  isDelegateRow,
  relayRefusal,
  readDelegates,
  delegatePlan,
  publishDelegation,
  revokeDelegation,
  scopeCeiling,
  judgeAuthorship,
  authorshipLine,
  signerLine,
  agentPodOf,
  verifiedSigner,
} from './model/index.js';
export type {
  DelegateRow,
  DelegateRoster,
  DelegateRegistryPort,
  DelegateField,
  DelegateProblem,
  DelegatePlan,
  DelegateOutcome,
  CeilingVerdict,
  EntryAuthorship,
  EntrySigner,
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
  ContentBinding,
  DescriptorBinding,
  DescriptorBindingBasis,
  ProofOwnerScope,
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
  // Nameable so a third-party registrant can declare its custom merge against the same
  // type the registry stores. `FacetRegistryEntry` alone leaves the merge signature
  // inline-only, which is how all three copies of it drifted to `any[] => any[]`.
  FacetMerge,
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
  /** One page of a collection — the substrate's single name for partialness. See model/types.ts. */
  Page,
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
  // Serialization-stable graph digest (authorship contentHash)
  canonicalGraphDigest,
  canonicalGraphDigestResult,
  canonicalGraphTriples,
  digestAlgorithmOf,
  GRAPH_DIGEST_ALGORITHM,
} from './rdf/index.js';
export type {
  GraphDigestResult,
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
  turtleIriRef,
  turtlePrefixedLocal,
} from './rdf/index.js';

// ── Following a page's advertised Turtle (substrate primitive) ─
// Our own ontology IRIs answer 200 text/html — GitHub Pages ignores Accept and falls back to
// `<name>.html` — and every page we publish advertises its Turtle with a `rel=alternate`.
// Both the relay's shape gate and the workspace reader dereference such IRIs, so the
// follower is here rather than in either of them.
export {
  looksLikeHtml,
  alternateTurtleHref,
  alternateTurtleUrl,
  followAlternateTurtle,
} from './rdf/index.js';
export type { FetchedRepresentation } from './rdf/index.js';

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
  runShaclRules,
  ShaclRuleError,
  type ShaclReport,
  type ShaclResult,
  type ShaclRuleRun,
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
  // ★ The DKG functions above (dkgRound1/2/3, simulateDKG) were exported with NONE of
  // their parameter or return types. `dkgRound2({ recipientIndex, received })` takes a
  // `readonly DKGReceivedShare[]`, so an external caller could invoke the function and
  // had no way to name the shape of its required argument — the round-2 input had to be
  // built untyped and any field typo went uncaught. Found by the typecheck gate, which
  // flagged tests/dkg.test.ts importing a name the package does not export; the defect
  // was the package's, not the test's. All four public DKG shapes are surfaced together
  // so the same gap cannot reopen one type at a time.
  DKGParticipantState,
  DKGReceivedShare,
  DKGRound2Result,
  DKGFinalState,
  // The contract `AdvancedCompositionAccountant`, `RenyiAccountant` and the verticals' own
  // `EpsilonBudget` all satisfy. Re-exported at the root because `applications/_shared`
  // imports from '@interego/core', not from '@interego/core/crypto'.
  PrivacyAccountant,
  PrivacyConsumption,
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
  HYPERMEDIA_MARKDOWN_MEDIA_TYPE_LEGACY,
  HYPERMEDIA_MARKDOWN_VARIANT,
  HMD_PROFILE_IRI,
  HMD_NS,
  HMD_PROFILE_LINK_HEADER,
  HMD_PROJECTION_CONTEXT,
  controlBlockIds,
  controlsFromAffordances,
  expandHmdTerm,
  hmdDocumentNode,
  liftHypermediaMarkdown,
  negotiateRepresentation,
  parseHypermediaMarkdown,
  renderHypermediaMarkdown,
  typedLink,
} from './kernel/index.js';
export type {
  HmdTriple,
  HypermediaControl,
  HypermediaLink,
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
  PGSL_ID_AUTHORITY,
  LEGACY_PGSL_PREFIX,
  mintNodeId,
  isPgslNodeId,
  pgslNodeKind,
  pgslNodeHash,
  toCanonicalNodeId,
} from './lattice/index.js';
// Action identity — a dereferenceable URL scheme for iep:action IRIs, with dual-read.
export {
  IEP_ACTION_AUTHORITY,
  isActionIri,
  actionKey,
  actionUrl,
  actionUrn,
  sameAction,
} from './kernel/action-identity.js';
export type {
  LatticeAdapter,
  LatticeValue,
  LatticeLevel,
  LatticeProvenance,
  AdapterMintResult,
  AdapterPromoteResult,
  AdapterDecomposeResult,
  AdapterResolveResult,
  PgslNodeKind,
} from './lattice/index.js';

// ── MCP outputSchema / structuredContent projection ─────────────────────────
// ONE implementation of the 2025-06-18 rule that a declared `outputSchema`
// describes the RESULT PAYLOAD and obliges the tool to return conforming
// `structuredContent`. It was implemented correctly in deploy/mcp-relay and
// inverted (envelope-shaped, payload hidden in a non-standard extension) in both
// applications/_shared/affordance-mcp and mcp-server. Shared here so a fourth
// copy cannot drift.
export {
  makeSchemaNullTolerant,
  mcpOutputSchema,
  omitNullish,
  toStructuredContent,
} from './mcp/output-schema.js';
export type { JsonSchemaNode } from './mcp/output-schema.js';

// The two pieces every MCP-over-HTTP mount must get right. Shared because three
// surfaces mount MCP over Express and both pieces were learned from production
// breakage: protocolMembersOnly (a middleware-injected top-level field 400'd every
// request) and acceptForSdkTransport (the SDK 406s a client that does not accept SSE,
// which is every browser client we ship).
export {
  protocolMembersOnly,
  acceptForSdkTransport,
  SDK_REQUIRED_ACCEPT,
  MCP_MODERN_CORS_HEADERS,
} from './mcp/http-mount.js';

// Deterministic JSON for content-addressing. Shared because three call sites derived a
// "content-stable" id with `JSON.stringify(obj, Object.keys(obj).sort())`, which is a
// recursive property ALLOW-LIST, not a key sort — it empties every nested object, so
// structurally different values hashed to one id. See the module header.
export { canonicalJson } from './canonical-json.js';

// Structural check for a Context Descriptor. Exported because `mint(kind:'descriptor')`
// used to accept any value and the mistake only surfaced later, inside compose(), as a
// raw `facets is not iterable` TypeError with no hint of what was expected.
export { descriptorProblem, assertDescriptor } from './model/descriptor-shape.js';

/**
 * The SSRF screen for caller-supplied URLs, shared by every surface that fetches one.
 *
 * ★ It lived inside one vertical while a second re-implemented it and a third had none — which is
 * the direction this class of defect always travels, because each application only notices the hole
 * it already fell into. See net/guarded-fetch.ts for why the relay's superset stays where it is.
 */
export {
  isPrivateHostname, assertSafeFetchTarget, safePublicUrlOrUndefined, safeFetch, guardedFetchFn,
} from './net/guarded-fetch.js';

/** Which pod segment an identity's OWN pod lives at — see identity/own-pod.ts for the four copies
 *  this replaces and the one lookalike it deliberately leaves alone. */
export { ownPodSegment, ownPodSegmentForAddress } from './identity/own-pod.js';
