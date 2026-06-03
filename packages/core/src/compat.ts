/**
 * @module compat
 *
 * Back-compat re-exports from the per-vertical @interego/* packages.
 *
 * Per the substrate-vs-vertical split (see
 * docs/ARCHITECTURAL-FOUNDATIONS.md §12), connectors / extractors /
 * registry / constitutional / compliance / privacy / security-txt /
 * p2p / ops / transactions / passport / abac / skills now live in
 * their own packages. Existing consumers that imported these from
 * `@interego/core` keep working through this barrel during the
 * transition window. New code should import directly from the
 * per-vertical package — e.g.:
 *
 *   import { evaluateAbac } from '@interego/abac';        // new
 *   import { evaluateAbac } from '@interego/core';        // still works
 *
 * This re-export is shimmed via `import` (not `export * from`) so the
 * generated declaration files retain the original symbol names without
 * leaking through TypeScript's lazy re-export behavior at runtime.
 */

// ── Extractors ──────────────────────────────────────────────
export {
  extract,
  detectFormat,
} from '@interego/extractors';
export type {
  ExtractionResult,
  TextChunk,
  SourceFormat,
} from '@interego/extractors';

// ── Connectors ──────────────────────────────────────────────
export {
  createConnector,
  createNotionConnector,
  createSlackConnector,
  createWebConnector,
} from '@interego/connectors';
export type {
  ConnectorType,
  ConnectorConfig,
  ConnectorEvent,
  Connector,
  SyncState,
} from '@interego/connectors';

// ── Registry ────────────────────────────────────────────────
export {
  createRegistry,
  registerAgent,
  refreshReputation,
  queryEntries,
  federateLookup,
  aggregateReputation,
  registryToDescriptor,
  DEFAULT_AGGREGATION_POLICY,
} from '@interego/registry';
export type {
  Registry,
  RegistryConfig,
  RegistryEntry,
  ReputationSnapshot,
  AttestationInput,
  AggregationPolicy,
} from '@interego/registry';

// ── Constitutional ──────────────────────────────────────────
export {
  proposeAmendment,
  vote,
  tryRatify,
  communityModal,
  forkConstitution,
  DEFAULT_RULES,
} from '@interego/constitutional';
export type {
  ConstitutionalPolicy,
  RatificationRule,
  Amendment,
  AmendmentDiff,
  Vote,
  ConstitutionalFork,
  Tier,
} from '@interego/constitutional';

// ── Compliance ──────────────────────────────────────────────
export {
  checkComplianceInputs,
  generateFrameworkReport,
  walkLineage,
  FRAMEWORK_CONTROLS,
  loadOrCreateComplianceWallet,
  rotateComplianceWallet,
  importComplianceWallet,
  listValidSignerAddresses,
  listValidSignerAddressesAt,
} from '@interego/compliance';
export type {
  ComplianceFramework,
  ComplianceCheckResult,
  FrameworkReport,
  FrameworkReportEntry,
  AuditableDescriptor,
  LineageNode,
  PersistedComplianceWallet,
  ComplianceWalletEntry,
  ComplianceWalletStore,
} from '@interego/compliance';

// ── Privacy ─────────────────────────────────────────────────
export {
  screenForSensitiveContent,
  formatSensitivityWarning,
  shouldBlockOnSensitivity,
} from '@interego/privacy';
export type {
  SensitivityFlag,
  SensitivityKind,
} from '@interego/privacy';

// ── security.txt ────────────────────────────────────────────
export {
  buildSecurityTxt,
  buildSecurityTxtFromEnv,
} from '@interego/security-txt';
export type {
  SecurityTxtOptions,
} from '@interego/security-txt';

// ── P2P ─────────────────────────────────────────────────────
export {
  KIND_DESCRIPTOR,
  KIND_DIRECTORY,
  KIND_ATTESTATION,
  KIND_ENCRYPTED_SHARE,
  P2pClient,
  InMemoryRelay,
  FileBackedRelay,
  WebSocketRelayMirror,
  verifyEvent,
  detectSignatureScheme,
  isInteregoEvent,
} from '@interego/p2p';
export type {
  P2pEvent,
  P2pFilter,
  P2pRelay,
  P2pSubscription,
  DescriptorAnnouncement,
  DirectoryEntry,
  EncryptedShare,
  SignatureScheme,
  PublishDescriptorInput,
  PublishDirectoryInput,
  PublishEncryptedShareInput,
  RelayConnectionStatus,
  MirrorOptions,
  FileBackedRelayOptions,
} from '@interego/p2p';

// ── Ops ─────────────────────────────────────────────────────
export {
  buildDeployEvent,
  buildAccessChangeEvent,
  buildWalletRotationEvent,
  buildIncidentEvent,
  buildQuarterlyReviewEvent,
} from '@interego/ops';
export type {
  OpsEventPayload,
  DeployEventInput,
  AccessChangeInput,
  AccessAction,
  WalletRotationInput,
  IncidentInput,
  IncidentSeverity,
  QuarterlyReviewInput,
  ReviewKind,
} from '@interego/ops';

// ── Transactions ────────────────────────────────────────────
export {
  createTransaction,
  executeTransaction,
  transactionStatus,
} from '@interego/transactions';
export type {
  Transaction,
  TransactionStep,
  TxnResult,
  TxnState,
  StepState,
  IsolationLevel,
} from '@interego/transactions';

// ── Passport ────────────────────────────────────────────────
export {
  createPassport,
  recordLifeEvent,
  stateValue,
  registerOn,
  migrateInfrastructure,
  demonstratedCapabilities,
  activeValues,
  detectValueDrift,
  passportToDescriptor,
  passportSummary,
  loadAgentKeypair,
} from '@interego/passport';
export type {
  Passport,
  LifeEvent,
  LifeEventKind,
  StatedValue,
  AgentKeypair,
  AgentWallet,
  LoadAgentKeypairOptions,
} from '@interego/passport';

// ── ABAC ────────────────────────────────────────────────────
// Renamed forms (evaluateAbac, AbacPolicyContext, ...) match the
// previous monolithic-core export shape. The bare `evaluate` /
// `PolicyContext` names are NOT re-exported here because the PGSL
// agent-framework also publishes those names (as evaluatePolicy /
// PgslPolicyContext after the split) — and existing tests rely on
// the pgsl forms. Callers that want ABAC's evaluate directly should
// import it from `@interego/abac` or use the prefixed alias here.
export {
  evaluate as evaluateAbac,
  evaluateSingle as evaluateAbacPolicy,
  validateAgainstShape as validateAbacShape,
  resolveAttributes,
  extractAttribute,
  filterAttributeGraph,
  createDecisionCache,
  defaultValidUntil,
} from '@interego/abac';
export type {
  AttributeGraph,
  PolicyContext as AbacPolicyContext,
  PolicyDecision as AbacPolicyDecision,
  PolicyPredicateShape,
  PredicateConstraint,
  AbacVerdict,
  DecisionCacheEntry,
  PolicyRegistry,
  DecisionCache,
} from '@interego/abac';

// ── Skills ──────────────────────────────────────────────────
export {
  parseSkillMd,
  emitSkillMd,
  skillBundleToDescriptor,
  descriptorGraphToSkillBundle,
  descriptorGraphToSkillMd,
} from '@interego/skills';
export type {
  SkillFrontmatter,
  SkillDocument,
  SkillParseResult,
  SkillValidationError,
  SkillBundle,
  SkillToDescriptorOptions,
  DescriptorBundle as SkillDescriptorBundle,
} from '@interego/skills';
