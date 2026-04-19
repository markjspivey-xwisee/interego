export {
  publish, discover, subscribe, parseManifest,
  fetchGraphContent,
  parseDistributionFromDescriptorTurtle,
  writeAgentRegistry, readAgentRegistry,
  writeDelegationCredential, verifyAgentDelegation,
} from './client.js';
export type { DistributionLink } from './client.js';
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
export { AGENT_REGISTRY_PATH, CREDENTIALS_PATH } from './types.js';

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
export { didWebToUrl, resolveDidWeb, extractPublicKey, findStorageEndpoint } from './did.js';
export type { DidDocument, VerificationMethod, ServiceEndpoint, DidResolutionResult } from './did.js';

// ── Cross-pod Sharing (federated recipient resolution) ─────
export {
  resolveHandleToPodUrl,
  resolveRecipient,
  resolveRecipients,
} from './sharing.js';
export type { ShareHandle, ResolvedRecipientPod, ResolveRecipientsOptions } from './sharing.js';

// ── IPFS Anchoring ──────────────────────────────────────────
export { computeCid, computeLatticeCids, pinToIPFS, computeDescriptorAnchor } from './ipfs.js';

// ── Zero-Copy Anchor Receipts ────────────────────────────────
export {
  writeAnchor,
  writeAnchors,
  readAnchors,
} from './anchors.js';

export type {
  IpfsAnchorReceipt,
  SignatureAnchorReceipt,
  EncryptionAnchorReceipt,
  PgslAnchorReceipt,
  ActivityAnchorReceipt,
  AnchorReceipt,
} from './anchors.js';
