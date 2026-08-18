export {
  publish, discover, subscribe, parseManifest,
  // `discover()` bounds the ANSWER; this one can also bound the READ, and reports whether it
  // did. See its doc comment — a limit that still parses the whole index is what took the
  // Foxxi projector's heap out.
  discoverPage,
  rebuildManifestFromPod,
  // ★ THE BOUNDED-MANIFEST READ PRIMITIVE, EXPORTED BECAUSE ELEVEN CONSUMERS DO RAW MANIFEST
  // GETS. A pod past the write bound keeps only its most recent rows in
  // `.well-known/context-graphs` and links the rest; a reader that GETs that one document
  // still parses a valid manifest, but it holds a PARTIAL index. These two are how a reader
  // gets the whole thing — and, via `complete`, how it finds out when it did not. Left
  // unexported, every consumer would have reinvented the union, and the ones that did not
  // would have gone on reporting a slice as the pod.
  fetchManifestChain, fetchAllManifestEntries, parseManifestArchiveUrls,
  // ★ AND THE ONE EVERY READER MUST GO THROUGH TO TURN A LINK INTO A REQUEST. The IRI in the
  // data is the pod's CANONICAL one, which on this deployment names an internal host no
  // external client can resolve. Measured live: the relay read all 654 rows and a reader
  // reached through the public gate found all seven segments unreachable. A segment is always
  // a sibling of its manifest, so the fetch target comes from the manifest's own origin.
  archiveFetchTarget,
  fetchGraphContent,
  // The TriG wrap `publish()` writes, and its inverse — how a reader recovers the graph an
  // authorship proof's contentHash was computed over. The emitter is exported so a test can
  // serve the document a pod serves rather than a hand-rolled approximation of it.
  wrapAsTriG,
  extractNamedGraphTurtle,
  // ★ AND THE ONE FUNCTION BOTH THE DIGESTER AND ANY READER MUST GO THROUGH. Exported
  // rather than left to be reimplemented: the reader that reimplemented it parsed the
  // whole served document while the digester covered only the block, and the gap between
  // the two scopes was a manufactured workspace participant.
  digestedGraphRegion,
  graphIriFromDescriptorTurtle,
  parseDistributionFromDescriptorTurtle,
  parseAuthorshipProofFromDescriptorTurtle,
  // Exported alongside its parser: a round-trip is only testable if both halves are
  // reachable, and a signed-but-unserialised field breaks verification silently.
  buildAuthorshipProofBlock,
  writeAgentRegistry, readAgentRegistry,
  writeDelegationCredential, readDelegationCredential, verifyAgentDelegation,
  buildVerifyAgentEnvelope,
  predictDescriptorUrl,
  predictGraphUrl,
  predictManifestUrl,
  checkSupersessionPrecondition,
} from './client.js';
export type {
  DistributionLink, VerifyAgentDelegationOptions, VerifyAgentEnvelope, SupersessionPreconditionPass,
  DigestedGraphRegion, DigestedRegionFailure,
} from './client.js';
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
} from './types.js';
export { AGENT_REGISTRY_PATH, CREDENTIALS_PATH, PublishPreconditionFailedError, PublishShapeViolationError } from './types.js';

// ── Shape discovery (spec §6.5b) ─────────────────────────────
export {
  resolveShape,
  listPodShapes,
  parseShapeIndex,
  shapeIndexTurtle,
  POD_SHAPES_PATH,
  POD_SHAPES_INDEX_PATH,
} from './shapes.js';
export type { ResolvedShape, ShapeIndexEntry } from './shapes.js';

// ── Progressive discovery (spec §6.5d) ───────────────────────
export {
  resolveIdentifier,
  fetchWellKnownAgents,
  parseAgentsCatalog,
  agentsCatalogTurtle,
  WELL_KNOWN_AGENTS_PATH,
} from './discovery.js';
export type { DiscoveryResult, DiscoveryTier, AgentCatalogEntry } from './discovery.js';
export {
  resolveStorageForShape,
  registerShapeStorage,
  type StorageResolution,
  type ResolveStorageOptions,
} from './type-index.js';
export {
  publishAgentEncryptionKey,
  resolveAgentEncryptionKey,
  AGENT_ENCRYPTION_KEY_PATH,
  type AgentEncryptionKey,
} from './encryption-keys.js';
export { socialWalk } from './social-walk.js';
export type { SocialWalkResult, PodNode, PodEdge, SocialWalkOptions } from './social-walk.js';

// ── Pod Directory ───────────────────────────────────────────
export {
  podDirectoryToTurtle,
  parsePodDirectory,
  fetchPodDirectory,
  publishPodDirectory,
  POD_DIRECTORY_PATH,
} from './directory.js';

// ── WebFinger ───────────────────────────────────────────────
export { resolveWebFinger } from './webfinger.js';
export type { WebFingerResult, WebFingerLink } from './webfinger.js';

// ── DID Resolution ─────────────────────────────────────────
export { didWebToUrl, resolveDidWeb, extractPublicKey, findStorageEndpoint, findKeyAgreementKey } from './did.js';
export type { DidDocument, VerificationMethod, ServiceEndpoint, DidResolutionResult } from './did.js';
export { resolveDid } from './did-resolver.js';

// ── Cross-pod Sharing (federated recipient resolution) ─────
export {
  resolveHandleToPodUrl,
  resolveRecipient,
  resolveRecipients,
  computePublishRecipients,
} from './sharing.js';
export type {
  ShareHandle,
  ResolvedRecipientPod,
  ResolveRecipientsOptions,
  PublishVisibility,
  ComputePublishRecipientsInput,
  ComputePublishRecipientsResult,
} from './sharing.js';

// ── IPFS Anchoring ──────────────────────────────────────────
export { computeCid, computeLatticeCids, pinToIPFS, computeDescriptorAnchor } from './ipfs.js';

// ── Zero-Copy Anchor Receipts ────────────────────────────────
export {
  writeAnchor,
  writeAnchors,
  readAnchors,
} from './anchors.js';

// ── Transient-network retry (substrate plumbing) ────────────
export {
  withTransientRetry,
  isTransientNetworkError,
} from './retry.js';
export type { TransientRetryOptions } from './retry.js';

// ── Generic affordance follower (Path A reach-anywhere primitive) ──
export {
  followAffordance,
  DescriptorNotFoundError,
  AffordanceNotFoundError,
} from './affordance.js';
export type {
  FollowAffordanceOptions,
  FollowAffordanceResult,
  ResolvedAffordance,
  AffordanceMethod,
} from './affordance.js';

export type {
  IpfsAnchorReceipt,
  SignatureAnchorReceipt,
  EncryptionAnchorReceipt,
  PgslAnchorReceipt,
  ActivityAnchorReceipt,
  AnchorReceipt,
} from './anchors.js';

// SDK — 3-line convenience over publish / discover / subscribe.
export { ContextGraphsSDK } from './sdk.js';
export type {
  ContextGraphsConfig,
  PublishOptions as SDKPublishOptions,
  SearchOptions,
  SearchResult,
  PublishResult as SDKPublishResult,
} from './sdk.js';
