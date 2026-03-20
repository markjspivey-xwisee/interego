export {
  publish, discover, subscribe, parseManifest,
  writeAgentRegistry, readAgentRegistry,
  writeDelegationCredential, verifyAgentDelegation,
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
