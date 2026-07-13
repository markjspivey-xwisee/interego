#!/usr/bin/env tsx
/**
 * MCP Relay — HTTP/SSE bridge for remote AI agents.
 *
 * Exposes the context-graphs MCP tools over HTTP so agents
 * running anywhere (not just localhost) can publish, discover,
 * and subscribe to context on the cloud-hosted Solid server.
 *
 * Endpoints:
 *   GET  /sse              — SSE stream (MCP over SSE transport)
 *   POST /messages         — MCP JSON-RPC messages
 *   GET  /health           — Health check
 *   GET  /tools            — List available tools (convenience)
 *   POST /tool/:name       — Call a tool directly via REST (convenience)
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { Agent, setGlobalDispatcher } from 'undici';
import { Wallet as EthersWalletCtor } from 'ethers';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolve as resolvePath, dirname as pathDirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InteregoOAuthProvider } from './oauth-provider.js';
import {
  loadClients as loadOAuthClients,
  loadOneClient as loadOneOAuthClient,
  listClientFilesOnPod as listOAuthClientFilesOnPod,
  removeClient as removeOAuthClient,
  saveClient as saveOAuthClient,
  resolveMaintainerPodUrl as resolveOAuthStorePodUrl,
  relayDidFromAddress,
  type OAuthClientStoreConfig,
} from './oauth-client-store.js';
import {
  loadAccessTokens as loadOAuthAccessTokens,
  loadRefreshTokens as loadOAuthRefreshTokens,
  loadAccessTokenByRaw as loadOAuthAccessTokenByRaw,
  loadRefreshTokenByRaw as loadOAuthRefreshTokenByRaw,
  persistAccessToken as persistOAuthAccessToken,
  persistRefreshToken as persistOAuthRefreshToken,
  removeAccessToken as removeOAuthAccessToken,
  removeRefreshToken as removeOAuthRefreshToken,
  type OAuthTokenStoreConfig,
} from './oauth-token-store.js';
import {
  loadEntries as loadFederationEntries,
  saveEntry as saveFederationEntry,
  removeEntry as removeFederationEntry,
  type FederationStoreConfig,
  type FederationEntry,
} from './federation-store.js';
import {
  inboxUrlFor,
  buildNotification,
  deliverNotification,
  readInbox as readAgentInbox,
  type NotificationInput,
} from './agent-mesh.js';
import {
  actorUrl as apActorUrl,
  buildWebfinger as apBuildWebfinger,
  buildActor as apBuildActor,
  buildOutbox as apBuildOutbox,
  type AgentCardLite,
} from './activitypub.js';
import {
  fanOut as reachFanOut,
  KNOWN_CHANNEL_TYPES,
  type Channel as ReachChannel,
} from './reachability.js';
import {
  validateDpopJwt,
  athFromAccessToken,
  reconstructRequestUrl,
} from './dpop.js';
import { corsMiddleware } from './cors-allowlist.js';
import { normalizeCssUrl, assertPublicPodUrl } from './url-rewrite.js';
import { withAmepSession, principalIri } from './amep-session-bridge.js';

// Substrate kernel + model + crypto + sparql + RDF + HTTP — `@interego/core`.
import {
  addAuthorizedAgent,
  compose as kernelCompose,
  ContextDescriptor,
  createDelegationCredential,
  createSignedAuthorship,
  createSignedDelegationCredential,
  createOwnerProfile,
  verifySignedAuthorship,
  type AuthorshipProof,
  cryptoComputeCid,
  decompose as kernelDecompose,
  reduce as kernelReduce,
  decorateKernelResult,
  decorateShim,
  dereference as kernelDereference,
  type EncryptionKeyPair,
  type EncryptedEnvelope,
  extend as kernelExtend,
  followAffordance,
  generateKeyPair,
  getShaclShapesTurtle,
  hydraEntryPoint,
  KERNEL_JSONLD_CONTEXT,
  KERNEL_RESULT_SHAPES,
  kernelAct,
  mint as kernelMint,
  normalizePublishInputs,
  openEncryptedEnvelope,
  parseTrig,
  pinToIpfs,
  promote as kernelPromote,
  removeAuthorizedAgent,
  restrict as kernelRestrict,
  signDescriptor,
  makeWalletDelegationSigner,
  makeWalletDelegationVerifier,
  type SignedDescriptor,
  type DelegationSigner,
  type DelegationVerifier,
  recoverMessageSigner,
  importWallet,
  toTurtle,
  validate,
  validateAgainstShape,
  verifyDescriptorSignature,
  withTransientRetry,
  // HyperMarkdown projection (a VIEW of the signed descriptor; see nsMarkdown).
  controlsFromAffordances,
  extractAffordancesFromTurtle,
  renderHypermediaMarkdown,
  negotiateRepresentation,
  HYPERMEDIA_MARKDOWN_MEDIA_TYPE,
  HMD_PROFILE_IRI,
  HMD_PROFILE_LINK_HEADER,
  type ShaclResult,
} from '@interego/core';
import {
  buildAccessChangeEvent,
} from '@interego/ops';
// Private-note HyperMarkdown projection (extracted for unit-testability; server.ts is self-starting).
import { noteToHyperMarkdown } from './note-view.js';

import type {
  ContextDescriptorData,
  FetchFn,
  IRI,
  ManifestEntry,
  OwnerProfileData,
  PodDirectoryData,
  PodDirectoryEntry,
  ReducerSpec,
  WebSocketConstructor,
} from '@interego/core';
import type {
  ContextChangeEvent,
  Subscription,
} from '@interego/solid';

// Solid binding — `@interego/solid`.
import {
  publish,
  discover,
  parseManifest,
  rebuildManifestFromPod,
  subscribe,
  writeAgentRegistry,
  readAgentRegistry,
  writeDelegationCredential,
  readDelegationCredential,
  verifyAgentDelegation,
  buildVerifyAgentEnvelope,
  fetchPodDirectory,
  publishPodDirectory,
  resolveWebFinger,
  fetchGraphContent,
  resolveRecipients,
  computePublishRecipients,
  parseDistributionFromDescriptorTurtle,
  parseAuthorshipProofFromDescriptorTurtle,
  predictDescriptorUrl,
  predictGraphUrl,
  predictManifestUrl,
  PublishPreconditionFailedError,
  checkSupersessionPrecondition,
} from '@interego/solid';

// PGSL — `@interego/pgsl`.
//
// IMPORTANT: do NOT import `createPGSL` here. The relay must not mint
// its own PGSL instance — the kernel adapter owns the one true PGSL
// singleton, exposed via `getKernelPGSL()`. Routing pgsl_* shims
// through anything else fragments the substrate (kernel.dereference
// of a shim-minted URI returns not-found). The kernel verbs
// (`kernel.mint` / `promote` / `dereference` / `decompose`) are the
// primary surface; this package exposes the singleton accessor and
// the lattice-only helpers (embedInPGSL, liftToDescriptor,
// pgslToTurtle, latticeStats, latticeMeet) that operate on it.
import {
  embedInPGSL,
  getKernelPGSL,
  latticeStats,
  resolve as pgslResolve,
  liftToDescriptor,
  latticeMeet,
  pgslToTurtle,
  computeCognitiveStrategy,
  extractEntities,
  shouldAbstain,
  routeInterrogatives,
  CANONICAL_ORDER,
} from '@interego/pgsl';
import type { NodeProvenance } from '@interego/pgsl';

// Privacy — `@interego/privacy`.
import { screenForSensitiveContent, formatSensitivityWarning } from '@interego/privacy';

// Compliance — `@interego/compliance`.
import {
  checkComplianceInputs,
  generateFrameworkReport,
  walkLineage,
  FRAMEWORK_CONTROLS,
  loadOrCreateComplianceWallet,
} from '@interego/compliance';
import type { ComplianceFramework, AuditableDescriptor, PersistedComplianceWallet } from '@interego/compliance';

// Wallet check_balance — `@interego/core` (wallet primitives).
import {
  checkBalance,
  getChainConfig,
} from '@interego/core';

// Security.txt — `@interego/security-txt`.
import { buildSecurityTxtFromEnv } from '@interego/security-txt';

// Lazy pod-init self-heal helper (Set fast-path + HEAD probe +
// mutex-guarded bootstrap). Extracted so vitest can cover the
// invariants without spinning the full relay.
import { createLazyPodInit, POD_AWARE_TOOLS } from './lazy-pod-init.js';

// Compliance-grade re-fetch-then-sign helper. Extracted so the
// audit-load-bearing "sign the bytes the pod actually persists, not
// the locally-built body" contract has dedicated test coverage.
import { fetchAndSignCanonicalTurtle } from './compliance-sign.js';
import { mountAmep, seedRelease42, type AmepDeps } from './amep.js';

// ── Config ──────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8080');
const CSS_URL = process.env['CSS_URL'] ?? 'http://localhost:3456/';
const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:8090';

// OAuth 2.1 auth config for /mcp. This is the real auth path used by
// claude.ai custom connectors and any MCP client that speaks OAuth.
// RELAY_MCP_API_KEY still works as a legacy fallback for tooling that can
// set an Authorization header directly (local curl, scripts).
const RELAY_MCP_API_KEY = process.env['RELAY_MCP_API_KEY'] ?? '';

// Shared secret for the gate-to-relay token-introspection RPC at
// /verify-token. The css-gate's verifyUserBearer() falls back to this
// endpoint when identity-server's /tokens/verify rejects the bearer
// (because the bearer is one of this relay's opaque OAuth access tokens
// — randomBytes(32).hex strings the identity server has never seen and
// cannot verify). The gate forwards the inbound user bearer in the
// request body, the relay introspects it against its in-process
// accessTokens map, and returns the same { valid, userId, ... } shape
// the gate already consumes from identity. Bearer-auth on the
// introspection endpoint itself uses THIS secret, carried in
// Authorization: Bearer — separate from any user bearer being
// introspected.
//
// MUST be set on production relay deployments where css-gate uses the
// introspection fallback. Unset => /verify-token returns 503 (the gate
// then falls back to its existing identity-only path, which still
// works for identity-server-minted tokens). Same secret MUST be set
// on the css-gate as RELAY_INTROSPECTION_SECRET; mismatched secrets
// cause every introspection attempt to fail 401 and the gate rejects
// every relay-OAuth-bearer write.
const RELAY_INTROSPECTION_SECRET = process.env['RELAY_INTROSPECTION_SECRET'] ?? '';

// Public base URL of THIS relay (used as the OAuth issuer + resource URL).
// Must be set in production so the OAuth metadata advertises the correct
// externally-reachable URL. Falls back to constructing from request host.
const PUBLIC_BASE_URL = process.env['PUBLIC_BASE_URL'] ?? '';
// Operator bearer for POST /amep/acts (AMEP engine). Unset ⇒ operator path
// disabled; OAuth bearers with mcp:write scope still work.
const AMEP_ACT_SECRET = process.env['AMEP_ACT_SECRET'] ?? '';

// Solid OIDC / RFC 9449 DPoP enforcement.
//   - Default (false): DPoP is supported but optional. Clients that send a
//     Bearer token continue to work; clients that send DPoP get the
//     stronger token-key-binding guarantees.
//   - Hard-require (true): /mcp rejects unbound Bearer tokens with a 401
//     carrying `WWW-Authenticate: DPoP error="invalid_token",
//     error_description="DPoP required by this resource"`. Tokens that
//     were ISSUED with `cnf.jkt` are always DPoP-required regardless of
//     this flag — the binding sticks to the token, not the env.
//
// Flip this to `true` once all expected clients (claude.ai, ChatGPT, etc.)
// have shipped DPoP support.
const RELAY_REQUIRE_DPOP = (process.env['RELAY_REQUIRE_DPOP'] ?? 'false').toLowerCase() === 'true';

// Surface-agent prefix this relay uses when minting per-user agents on
// identity. Every user who authenticates through this relay gets a
// distinct `<surface>-<userId>` agent on their pod (own DID, own X25519
// key, own revocation point).
//
// By default the surface is auto-detected from the OAuth client's
// DCR-registered `client_name` (see `surfaceAgentFromClient` below).
// RELAY_DEFAULT_SURFACE_AGENT overrides the fallback used when the
// client name matches nothing known — set it per-deployment if you want
// a fixed label (e.g. a dedicated mobile relay). Previous deployments
// set this to `claude-mobile`; the new default is the generic
// `mcp-client` so unknown clients don't masquerade as Claude.
const RELAY_DEFAULT_SURFACE_AGENT = process.env['RELAY_DEFAULT_SURFACE_AGENT']
  ?? process.env['RELAY_SURFACE_AGENT']   // legacy env name
  ?? 'mcp-client';

// Maintainer pod slug — the pod that backs the legacy API-key identity.
// No default: shipping a real human's userId (`markj`) as the fallback
// silently impersonated him for any script that knew the shared key.
// Operators who enable the API-key path (RELAY_MCP_API_KEY set) MUST also
// set RELAY_MAINTAINER_POD_NAME to a userId they control; the startup
// check below throws otherwise. Stays a slug (pod path segment), not a
// full URL — composes against CSS_URL / IDENTITY_URL. Audit endpoints
// derive the target pod from the `?pod=` query param, not from this var.
const RELAY_MAINTAINER_POD_NAME = process.env['RELAY_MAINTAINER_POD_NAME'] ?? '';
if (RELAY_MCP_API_KEY && !RELAY_MAINTAINER_POD_NAME) {
  throw new Error(
    'RELAY_MCP_API_KEY is set but RELAY_MAINTAINER_POD_NAME is not. ' +
    'The legacy API-key path needs a user identity to attribute writes to; ' +
    'pick a userId for your deployment (e.g. an ops account you control, ' +
    'NOT a real end user) and set RELAY_MAINTAINER_POD_NAME=<that-id>. ' +
    'To disable the API-key path entirely, unset RELAY_MCP_API_KEY.',
  );
}

// Best-effort client-name → surface-slug mapping. We match on a
// lowercased, trimmed version of `client_name` so small spelling
// variations all collapse to the same slug. Keep the slug in the
// `^[a-z][a-z0-9-]*$` shape so it's safe as part of an agent IRI path.
// Ordering matters: first substring match wins. Fall back to
// RELAY_DEFAULT_SURFACE_AGENT if no pattern matches.
const SURFACE_PATTERNS: Array<[RegExp, string]> = [
  // Anthropic Claude surfaces — leave room to split further by platform
  // hint words ("mobile", "desktop", "web", "code", "vscode", "cli").
  [/claude.*code.*(vscode|vs\s*code)/i, 'claude-code-vscode'],
  [/claude.*code/i, 'claude-code'],
  [/claude.*(desktop|mac|windows)/i, 'claude-desktop'],
  [/claude.*(mobile|ios|android|phone)/i, 'claude-mobile'],
  [/claude/i, 'claude'],
  // OpenAI surfaces
  [/chatgpt/i, 'chatgpt'],
  [/openai.*codex/i, 'openai-codex'],
  [/\bcodex\b/i, 'codex'],
  [/openai/i, 'openai'],
  // Other popular MCP clients
  [/\bcursor\b/i, 'cursor'],
  [/\bwindsurf\b/i, 'windsurf'],
  [/\bcline\b/i, 'cline'],
  [/\bzed\b/i, 'zed'],
  [/continue\b/i, 'continue'],
  [/hermes.*agent/i, 'hermes-agent'],
  [/openclaw/i, 'openclaw'],
];

function surfaceAgentFromClient(clientName: string | undefined): string {
  if (!clientName) return RELAY_DEFAULT_SURFACE_AGENT;
  const name = clientName.trim();
  if (!name) return RELAY_DEFAULT_SURFACE_AGENT;
  for (const [re, slug] of SURFACE_PATTERNS) {
    if (re.test(name)) return slug;
  }
  // Unknown client: slugify the name if it's reasonable, otherwise fall
  // back to the generic default. We don't want arbitrary attacker-
  // controlled client_name strings landing as pod-path components.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug && /^[a-z][a-z0-9-]{1,31}$/.test(slug)) return slug;
  return RELAY_DEFAULT_SURFACE_AGENT;
}

// Singleton OAuth provider. Auth is delegated to the identity server — the
// provider's login form collects userId+password, server.ts /oauth/login
// forwards to ${IDENTITY_URL}/login, and the returned identity is baked into
// the OAuth access token. Per-user, fully federated, no shared admin secret.
//
// Dynamic Client Registration persistence:
//   The Map of registered OAuth clients is hydrated at startup from the
//   maintainer's pod (see deploy/mcp-relay/oauth-client-store.ts) and
//   each subsequent registerClient call is mirrored back to the pod as
//   a typed Context Descriptor. Without this, every container restart
//   would silently invalidate every previously-issued client_id and
//   every existing ChatGPT / claude.ai / etc. connector would fail
//   with {"error":"invalid_client"} on its next request.
//
//   Wiring lives further down in this module (after solidFetch, log,
//   and ensureRelayComplianceWallet are defined). The provider binding
//   here is intentionally `let` so the async init can assign it before
//   any top-level consumer (mcpAuthRouter, requireBearerAuth) runs.
let oauthProvider!: InteregoOAuthProvider;

// Org-level IPFS/CDP keys — used as defaults when users don't provide their own.
//
// Auto-detection: if PINATA_API_KEY or WEB3STORAGE_TOKEN is set in env, the
// relay defaults to that provider so publishes ACTUALLY pin to a public
// gateway. Operators no longer need to set IPFS_PROVIDER separately.
// IPFS_PROVIDER + IPFS_API_KEY remain supported as explicit overrides for
// legacy deployments. When no key is present at all, we report
// `local-unpinned` (NOT `local`) — see crypto/ipfs.ts:localPin for why
// the old `local` label was misleading.
const ENV_PINATA_KEY = process.env['PINATA_API_KEY'] ?? '';
const ENV_WEB3STORAGE_KEY = process.env['WEB3STORAGE_TOKEN'] ?? '';
const ORG_IPFS_PROVIDER: 'pinata' | 'web3storage' | 'local-unpinned' = (() => {
  const explicit = process.env['IPFS_PROVIDER'];
  if (explicit === 'pinata' || explicit === 'web3storage') return explicit;
  if (explicit === 'local' || explicit === 'local-unpinned') return 'local-unpinned';
  // Auto-detect when no explicit provider is set.
  if (ENV_PINATA_KEY) return 'pinata';
  if (ENV_WEB3STORAGE_KEY) return 'web3storage';
  return 'local-unpinned';
})();
const ORG_IPFS_API_KEY = process.env['IPFS_API_KEY']
  ?? (ORG_IPFS_PROVIDER === 'pinata' ? ENV_PINATA_KEY
    : ORG_IPFS_PROVIDER === 'web3storage' ? ENV_WEB3STORAGE_KEY
    : '');
const ORG_CDP_API_KEY_NAME = process.env['CDP_API_KEY_NAME'] ?? '';
const ORG_CDP_API_KEY_PRIVATE = process.env['CDP_API_KEY_PRIVATE'] ?? '';

/**
 * Resolve IPFS config: user override (from request headers) > org default >
 * local-unpinned. A `local-unpinned` provider means we compute a CID for the
 * content but do NOT upload it; the caller MUST surface that distinction in
 * its response (see publish_context's `ipfs.warning` field).
 */
function resolveIpfsConfig(req: any): { provider: 'pinata' | 'web3storage' | 'local-unpinned'; apiKey: string } {
  const userProvider = req.headers?.['x-ipfs-provider'] as string | undefined;
  const userKey = req.headers?.['x-ipfs-api-key'] as string | undefined;

  if (userProvider && userKey) {
    const normalized: 'pinata' | 'web3storage' | 'local-unpinned' =
      userProvider === 'pinata' ? 'pinata'
      : userProvider === 'web3storage' ? 'web3storage'
      : 'local-unpinned';
    return { provider: normalized, apiKey: userKey };
  }
  return { provider: ORG_IPFS_PROVIDER, apiKey: ORG_IPFS_API_KEY };
}

function log(msg: string): void {
  console.log(`[mcp-relay] ${msg}`);
}

// ── Auth Middleware ──────────────────────────────────────────

// Tools that require authentication (write operations).
// Includes stateful "public" tools (subscribe_to_pod, add_pod,
// resolve_webfinger) that mutate relay subscription slots or write
// a federation entry to the maintainer pod — anonymous callers can
// otherwise exhaust CG_MAX_SUBSCRIPTIONS or amplify writes to the
// maintainer pod past the css-gate (the bridge holds WRITE_SECRET).
const AUTH_REQUIRED_TOOLS = new Set([
  'publish_context', 'register_agent', 'revoke_agent',
  'publish_directory',
  'subscribe_to_pod', 'add_pod', 'resolve_webfinger',
  // record_trajectory_step ultimately calls publish_context internally,
  // so it MUST be auth-gated at the wire to prevent unauthenticated
  // trajectory writes (which would then attribute to the relay's
  // session agent, polluting the trajectory pod). pgsl_decide stays
  // public — it's a read-only lattice query.
  'record_trajectory_step',
  // notify_agent writes a notification into another agent's inbox and
  // attributes the sender — must be authenticated. read_inbox defaults
  // to the caller's own pod, so it needs the bound identity too.
  // set_reachability mutates the caller's own agent card.
  'notify_agent', 'read_inbox', 'set_reachability',
  // sign_request signs a payload AS the bound caller (session-derived identity)
  // with the relay delegation key — the agent's signing primitive for
  // signed-request affordances. Must be auth-gated so it can never sign for
  // anyone but the authenticated caller.
  'sign_request',
  // rebuild_manifest rewrites a pod's manifest index (non-destructive,
  // reconstructs from on-pod descriptors) — gate it behind auth.
  'rebuild_manifest',
]);

// Tools that are public (read operations)
const PUBLIC_TOOLS = new Set([
  'discover_context', 'get_descriptor', 'get_pod_status',
  'discover_all', 'list_known_pods',
  'remove_pod', 'discover_directory',
  'verify_agent',
]);

// Kernel verbs — the 8 substrate primitives. Every other entry in
// TOOLS is a thin-facade compatibility shim that internally composes
// these. Used by /.well-known/operations to classify each affordance
// as 'kernel-verb' vs 'thin-facade' so hypermedia clients can prefer
// the substrate surface where appropriate. Single source of truth —
// keep in sync with the kernel-verb block at the top of TOOLS.
const KERNEL_VERBS = new Set([
  'mint', 'dereference', 'compose', 'act',
  'restrict', 'extend', 'promote', 'decompose',
  'reduce_chain',
]);

interface AuthResult {
  authenticated: boolean;
  userId?: string;
  agentId?: string;
  scope?: string;
  error?: string;
}

async function verifyBearerToken(authHeader: string | undefined): Promise<AuthResult> {
  if (!authHeader?.startsWith('Bearer ')) {
    return { authenticated: false, error: 'Bearer token required' };
  }
  const token = authHeader.slice(7);

  try {
    const resp = await fetch(`${IDENTITY_URL}/tokens/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!resp.ok) return { authenticated: false, error: `Identity server error: ${resp.status}` };
    const data = await resp.json() as { valid: boolean; userId?: string; agentId?: string; scope?: string; reason?: string };
    if (data.valid) {
      return { authenticated: true, userId: data.userId, agentId: data.agentId, scope: data.scope };
    }
    return { authenticated: false, error: data.reason ?? 'Invalid token' };
  } catch (err) {
    return { authenticated: false, error: `Cannot reach identity server: ${(err as Error).message}` };
  }
}

// ── Signed-request auth (machine-to-machine, headless) ─────────
//
// OAuth answers "did this human grant this app permission to act on
// their behalf?" — browser-mediated, suitable for claude.ai / ChatGPT
// connector flows. ECDSA signature auth answers a different question:
// "is this caller really who they claim to be?" — machine-to-machine,
// suitable for headless agents, CI runners, sensors, IoT, and scripts
// that cannot complete a browser-based authorization flow.
//
// Both are legitimate auth questions. The relay supports both; either
// satisfies the AUTH_REQUIRED_TOOLS gate, neither requires the other.
//
// Wire shape: the caller's body includes
//   { _signature: '0x...', _signed_payload: '<canonical JSON string>' }
// and inside the signed payload there MUST be:
//   - `agent_id`: a did:ethr:<addr> the caller claims to be
//   - `timestamp`: ISO 8601 instant, within ±60s of relay time (replay
//                  protection — without it, a leaked signature would
//                  be replayable forever)
//
// The signer signs `sha256:<hex(sha256(signedPayload))>` with their
// wallet (same canonical scheme Foxxi's verifySignature uses for
// /agent/teach and /performance/outcome, kept consistent so a wallet
// that signs one signs all). Verification recovers the address and
// compares it against the address inside the claimed agent_id DID.
//
// Identity binding: when signature auth succeeds, the caller's
// effective agent_id is OVERRIDDEN by the DID the signature recovers
// to. This blocks spoofing: a caller cannot claim agent_id=alice in
// the body while signing with bob's wallet — the recovered DID wins.
interface SignedAuthResult extends AuthResult {
  // When signature auth succeeded, this is the recovered did:ethr — the
  // descriptor's authorship MUST be set from here, not from any
  // caller-claimed agent_id.
  recoveredDid?: string;
}

const SIGNATURE_REPLAY_WINDOW_MS = 60_000;

function verifySignedRequest(body: unknown): SignedAuthResult {
  if (!body || typeof body !== 'object') {
    return { authenticated: false, error: 'signed-request body is not an object' };
  }
  const b = body as Record<string, unknown>;
  const signature = typeof b._signature === 'string' ? b._signature : undefined;
  const signedPayload = typeof b._signed_payload === 'string' ? b._signed_payload : undefined;
  if (!signature || !signedPayload) {
    return { authenticated: false, error: 'missing _signature or _signed_payload' };
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(signedPayload) as Record<string, unknown>;
  } catch (err) {
    return { authenticated: false, error: `_signed_payload is not valid JSON: ${(err as Error).message}` };
  }
  const claimedAgentId = typeof payload.agent_id === 'string' ? payload.agent_id : undefined;
  const timestamp = typeof payload.timestamp === 'string' ? payload.timestamp : undefined;
  if (!claimedAgentId) {
    return { authenticated: false, error: 'signed payload missing agent_id' };
  }
  if (!timestamp) {
    return { authenticated: false, error: 'signed payload missing timestamp (replay protection — include ISO 8601 instant)' };
  }
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) {
    return { authenticated: false, error: `signed payload timestamp is not a parseable instant: ${timestamp}` };
  }
  const drift = Math.abs(Date.now() - t);
  if (drift > SIGNATURE_REPLAY_WINDOW_MS) {
    return { authenticated: false, error: `signature timestamp drift ${Math.round(drift / 1000)}s exceeds ±${SIGNATURE_REPLAY_WINDOW_MS / 1000}s window — replay protection` };
  }
  // Recover signer; canonical message is `sha256:<hex(sha256(signedPayload))>`.
  const message = `sha256:${createHash('sha256').update(signedPayload, 'utf8').digest('hex')}`;
  let recovered: string;
  try {
    recovered = recoverMessageSigner(message, signature);
  } catch (err) {
    return { authenticated: false, error: `signature recovery threw: ${(err as Error).message}` };
  }
  // Compare against the address embedded in the agent_id DID. Accepts
  // did:ethr:<addr> and did:key:0x<addr> conventions (case-insensitive).
  const addrMatch = claimedAgentId.toLowerCase().match(/0x[0-9a-f]{40}/);
  if (!addrMatch) {
    return { authenticated: false, error: `agent_id ${claimedAgentId} does not embed a recognizable Ethereum address (did:ethr:<addr> expected)` };
  }
  if (recovered.toLowerCase() !== addrMatch[0]) {
    return {
      authenticated: false,
      error: `signature recovered to ${recovered} but agent_id claimed ${addrMatch[0]}`,
    };
  }
  // The recovered DID is the canonical identity — use it, not the
  // (matching) caller-claimed agent_id, so identity binding is uniform
  // regardless of which form the caller used in the claim.
  const recoveredDid = `did:ethr:${recovered}`;
  return {
    authenticated: true,
    agentId: recoveredDid,
    userId: recoveredDid,
    recoveredDid,
    scope: 'mcp', // signed requests get baseline MCP scope; finer-grained scoping is OAuth's job
  };
}

// ── Migration: old public-host → internal-FQDN URL translation ──
//
// Pre-migration the CSS pod was reachable at `interego-css.livelysky-<id>...`;
// the canonical host is now `interego-css.internal.livelysky-<id>...`. A
// non-trivial number of LIVE descriptors on the markj pod (plus external
// caches / wallet snapshots / search indexes) still carry the OLD
// public-host URL in `iep:origin` / `descriptorUrl` / `dcat:accessURL`
// positions. Dereferencing those would 404 against the now-internal-only
// host.
//
// Strategy: relay-side translation on dereference. The helper lives in
// `url-rewrite.ts` (pure, side-effect-free, directly unit-testable). It
// is wired in two places:
//   1. `solidFetch` (below) — every HTTP read/write the relay performs
//      goes through this wrapper, so the rewrite catches dereference,
//      get_descriptor's GET, fetchGraphContent's envelope fetch,
//      verify_agent's registry walk, kernelAct's affordance follow, etc.
//   2. The URL-receiving handler entry points (handleKernelDereference,
//      handleGetDescriptor, handleVerifyAgent, handleKernelAct,
//      handleInvokeAffordance) so URN→URL hints, decorated affordances,
//      and logs reflect the canonical target.
//
// Migration guarantee: pod content is byte-identical (signatures over the
// original URL still verify) — we rewrite the HTTP target only, never the
// bytes. External callers can keep using the old URL; the relay
// transparently rewrites at the HTTP boundary.
//
// Companion: the OLD origin remains on the CORS allowlist (see
// `cors-allowlist.ts`) so browser callers presenting it as their `Origin`
// header still receive `Access-Control-Allow-Origin` echoes.
//
// (`normalizeCssUrl` is imported alongside the other local helpers at the
// top of the file.)

// ── Outbound HTTP keep-alive pool ───────────────────────────
//
// Every outbound fetch the relay makes — solidFetch (CSS reads/writes),
// raw fetch to IDENTITY_URL (token verify, /agents/me, etc.), webhook
// POST fan-out — flows through Node's global undici dispatcher. Pinning
// a single shared Agent with keep-alive on lets all of them reuse pooled
// TCP+TLS sockets to the env-internal CSS/identity envoy instead of
// handshaking per request. Single source-of-truth: setGlobalDispatcher
// covers solidFetch + every raw fetch site without per-callsite edits.
const outboundAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 120_000,
  connections: 64,
  pipelining: 1,
});
setGlobalDispatcher(outboundAgent);

// ── Fetch wrapper ───────────────────────────────────────────

const solidFetch: FetchFn = async (url, init) => {
  // Rewrite OLD-host CSS URLs at the HTTP boundary so every code path
  // (kernel dereference, get_descriptor GET, fetchGraphContent envelope
  // fetch, verify_agent registry walk, kernelAct affordance follow, ...)
  // transparently follows the canonical internal-FQDN target. See
  // `url-rewrite.ts` for the matching regex and rewrite rules.
  const target = normalizeCssUrl(url);
  // Bounded connect+headers deadline. Without this, a CSS host that accepts the
  // TCP connection but stalls before responding blocks on undici's ~300s default
  // (and, once it surfaces as "fetch failed", is retried 4-6x by withTransientRetry),
  // riding far past the ACA ingress timeout and surfacing as an opaque 502. An abort
  // here is non-transient (AbortError doesn't match the retry matcher), so it fails
  // fast to a bounded, correctly-classified error instead of a multi-minute hang.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(process.env['NS_FETCH_TIMEOUT_MS'] ?? 15_000));
  try {
    const resp = await fetch(target, { ...(init as RequestInit), signal: ac.signal });
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      headers: { get: (n: string) => resp.headers.get(n) },
      text: () => resp.text(),
      json: () => resp.json(),
    };
  } finally {
    clearTimeout(timer);
  }
};

// ── Invoke-path outbound guard ──────────────────────────────
//
// Every URL fetched while FOLLOWING a descriptor (invoke_affordance / kernel
// act): the descriptor itself, the resolved hydra:target, envelope fetches.
// followAffordance() fires the method at whatever hydra:target the fetched
// descriptor names — so without a network policy here, an attacker-authored
// descriptor whose target names an internal-only host (css *.railway.internal,
// the identity service, IMDS) turns the relay into an authenticated SSRF proxy
// that echoes the response body back. Allowed: (a) the internal CSS pod space
// (the normalizeCssUrl rewrite target — checked FIRST because *.internal is
// exactly what assertPublicPodUrl rejects), (b) the relay's own public base
// (AMEP acts), (c) any public host passing the same RFC1918/link-local/
// loopback/IMDS screen the /ns + /audit routes enforce (federation stays open).
function assertInvokeTargetAllowed(url: string): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`invoke: unparseable URL: ${url}`); }
  try {
    const cssOrigin = new URL(CSS_URL).origin;
    if (u.origin === cssOrigin) return;
  } catch { /* CSS_URL malformed — fall through to the public screen */ }
  try {
    if (PUBLIC_BASE_URL && u.origin === new URL(PUBLIC_BASE_URL).origin) return;
  } catch { /* ignore */ }
  // assertPublicPodUrl only rejects a TERMINAL `.internal` label, but
  // normalizeCssUrl can synthesize hosts with `.internal.` mid-label from
  // attacker-supplied legacy URLs (…-css.internal.<env>.azurecontainerapps.io).
  // Any host carrying an `internal` DNS label that is not the pinned CSS
  // origin is rejected outright.
  if (u.hostname.toLowerCase().split('.').includes('internal')) {
    throw new Error(`invoke: internal-labeled host not allowed: ${u.hostname}`);
  }
  assertPublicPodUrl(url);
}

const guardedInvokeFetch: FetchFn = async (url, init) => {
  const target = normalizeCssUrl(url);
  assertInvokeTargetAllowed(target);
  return solidFetch(target, init);
};

// AMEP same-origin session bridge (extracted to amep-session-bridge.ts so its
// same-origin gate + fetch/actor-stamp logic are unit-testable without importing
// this self-starting module). Call sites pass { solidFetch, PUBLIC_BASE_URL }.

// ── State ───────────────────────────────────────────────────

let subscriptions: Map<string, Subscription> = new Map();
let notificationLog: ContextChangeEvent[] = [];

// ── SolidNotifications SSE fan-out ──────────────────────────
//
// Implements the syncProtocol: 'SolidNotifications' contract declared
// in every descriptor's FederationFacet. Every successful
// publish_context emits a NotificationEvent to:
//   1. an in-process subscriber map keyed by podSlug — fed to
//      /notifications/:podSlug Server-Sent-Event clients
//      (text/event-stream)
//   2. any HTTP webhook URLs registered for the pod (best-effort POST)
//   3. the legacy in-memory notificationLog so the older /sse polling
//      transport still surfaces the event for backwards compatibility.
//
// A podSlug is the first 16 chars of sha256(podUrl) — a stable, opaque
// public token that doesn't leak pod path structure. The relay maps
// slug -> podUrl in `podSlugToUrl`; clients receive the slug from
// subscribe_to_pod and use it directly in the SSE URL.
interface NotificationEvent {
  readonly '@context': string;
  readonly type: 'iep:Notification';
  readonly eventType: 'created' | 'updated' | 'superseded';
  readonly timestamp: string;
  readonly podUrl: string;
  readonly descriptorUrl: string;
  readonly graphUrl?: string;
  readonly author?: string;
}

const sseSubscribers: Map<string, Set<express.Response>> = new Map();
const notificationWebhooks: Map<string, Set<string>> = new Map();
const podSlugToUrl: Map<string, string> = new Map();

function podSlug(podUrl: string): string {
  const slug = createHash('sha256').update(podUrl).digest('hex').slice(0, 16);
  // First registration wins — record both directions for round-tripping.
  if (!podSlugToUrl.has(slug)) {
    podSlugToUrl.set(slug, podUrl);
  }
  return slug;
}

function emitNotification(
  podUrl: string,
  partial: Omit<NotificationEvent, '@context' | 'type' | 'timestamp' | 'podUrl'> & { timestamp?: string },
): void {
  const event: NotificationEvent = {
    '@context': 'https://markjspivey-xwisee.github.io/interego/ns/iep#',
    type: 'iep:Notification',
    timestamp: partial.timestamp ?? new Date().toISOString(),
    podUrl,
    eventType: partial.eventType,
    descriptorUrl: partial.descriptorUrl,
    ...(partial.graphUrl !== undefined ? { graphUrl: partial.graphUrl } : {}),
    ...(partial.author !== undefined ? { author: partial.author } : {}),
  };
  const slug = podSlug(podUrl);
  const payload = `data: ${JSON.stringify(event)}\n\n`;

  // (1) Fan-out to live SSE subscribers for this pod.
  const subs = sseSubscribers.get(slug);
  if (subs && subs.size > 0) {
    for (const res of subs) {
      try {
        res.write(payload);
      } catch (err) {
        log(`[notify/sse] write failed for pod=${podUrl}: ${(err as Error).message}`);
      }
    }
  }

  // (2) POST to registered webhooks (best-effort, fire-and-forget).
  const hooks = notificationWebhooks.get(podUrl);
  if (hooks && hooks.size > 0) {
    for (const url of hooks) {
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: JSON.stringify(event),
      }).catch(err => log(`[notify/webhook] POST ${url} failed: ${(err as Error).message}`));
    }
  }

  // (3) Bridge into the legacy notificationLog so /sse polling clients
  // continue to observe events even when no upstream WebSocket
  // subscription exists. Maps the JSON-LD eventType to the legacy
  // 'Add' | 'Update' | 'Remove' triad.
  const legacyType: 'Add' | 'Update' | 'Remove' =
    event.eventType === 'created' ? 'Add'
      : event.eventType === 'superseded' ? 'Remove'
      : 'Update';
  notificationLog.push({
    resource: event.descriptorUrl,
    type: legacyType,
    timestamp: event.timestamp,
  });
  // Cap the legacy log so it doesn't grow without bound.
  if (notificationLog.length > 1024) {
    notificationLog = notificationLog.slice(-512);
  }
}

// PGSL lattice — the relay does NOT own a private PGSL instance.
// Every pgsl_* shim composes against the kernel's lattice via the
// substrate verbs (`kernel.mint` / `promote` / `dereference` /
// `decompose`) plus the kernel-owned PGSL singleton accessor
// `getKernelPGSL()` for read-only structural ops the kernel hasn't
// surfaced as verbs (turtle export, lattice stats, lattice meet,
// content-to-fragment embedding, descriptor lift). Holding a parallel
// `createPGSL(...)` here used to mean kernel.dereference of a shim-
// minted URI returned not-found — two PGSL instances, two truths.
// Now there is exactly one PGSL instance: the kernel adapter's. The
// provenance below is the relay-attribution attached to nodes minted
// through the shims (first call to `getKernelPGSL(pgslProvenance)`
// seeds the singleton's `defaultProvenance`; subsequent calls reuse
// the existing instance).
const pgslProvenance: NodeProvenance = {
  wasAttributedTo: 'urn:agent:mcp-relay:pgsl' as IRI,
  generatedAtTime: new Date().toISOString(),
};

// Per-process X25519 keypair used to encrypt content the relay publishes on
// behalf of the authenticated mobile agent, and to seal the persisted
// OAuth client_secrets + access/refresh identity bearers at rest. Stable
// across revisions or every redeploy orphans every previously-sealed
// envelope (new key cannot decrypt old payloads) — surfaced as the
// `failed to unseal identityToken at .../tokens-refresh/...` log line
// and forced Claude/ChatGPT re-authorization on each rollover.
//
// Resolution order (first match wins):
//   1. RELAY_AGENT_KEY_JSON — inline JSON content. Wire from a
//      Container Apps secretref so the keypair survives every revision
//      rollover. This is the ONLY path that works on ephemeral
//      filesystems (Container Apps, Lambda, etc.).
//   2. RELAY_AGENT_KEY_FILE — on-disk JSON file (default
//      /app/relay-agent-key.json). Useful for self-hosted / bare-metal
//      deployments where the container has a persistent volume.
//   3. Mint a fresh keypair and try to persist to the file path. On
//      ephemeral storage this resets every restart — warned at startup.
function parseRelayAgentKey(source: string, label: string): EncryptionKeyPair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new Error(
      `${label} is not valid JSON: ${(err as Error).message}. ` +
      `Restore from backup or unset the variable to mint a new identity.`,
    );
  }
  const p = parsed as Partial<EncryptionKeyPair>;
  if (p?.publicKey && p?.secretKey && p?.algorithm === 'X25519-XSalsa20-Poly1305') {
    return p as EncryptionKeyPair;
  }
  throw new Error(
    `${label} is missing required fields ` +
    `(publicKey + secretKey + algorithm=X25519-XSalsa20-Poly1305). ` +
    `Restore from backup or unset to mint a new identity.`,
  );
}
const RELAY_AGENT_KEY_FILE = process.env['RELAY_AGENT_KEY_FILE'] ?? '/app/relay-agent-key.json';
const RELAY_AGENT_KEY_JSON = process.env['RELAY_AGENT_KEY_JSON'];
const relayAgentKey: EncryptionKeyPair = (() => {
  if (RELAY_AGENT_KEY_JSON && RELAY_AGENT_KEY_JSON.trim().length > 0) {
    return parseRelayAgentKey(RELAY_AGENT_KEY_JSON, 'RELAY_AGENT_KEY_JSON env var');
  }
  if (existsSync(RELAY_AGENT_KEY_FILE)) {
    return parseRelayAgentKey(
      readFileSync(RELAY_AGENT_KEY_FILE, 'utf8'),
      `RELAY_AGENT_KEY_FILE (${RELAY_AGENT_KEY_FILE})`,
    );
  }
  const kp = generateKeyPair();
  try {
    writeFileSync(RELAY_AGENT_KEY_FILE, JSON.stringify(kp, null, 2), { mode: 0o600 });
  } catch (err) {
    log(`[startup-warn] Could not persist relay agent key to ${RELAY_AGENT_KEY_FILE}: ${(err as Error).message}. ` +
        `Identity will reset on next restart, orphaning any envelopes encrypted this session. ` +
        `Set RELAY_AGENT_KEY_JSON as a Container Apps secretref to make the keypair stable across revisions.`);
  }
  return kp;
})();

// ECDSA wallet for compliance-grade descriptor signing. Persisted next
// to the X25519 envelope key. Loaded lazily on first compliance publish.
const RELAY_COMPLIANCE_WALLET_FILE = process.env['RELAY_COMPLIANCE_WALLET_FILE']
  ?? RELAY_AGENT_KEY_FILE.replace(/\.json$/, '-ecdsa.json');
// Inline-JSON path — the ONLY way to keep relayDid stable on ephemeral
// container filesystems (Container Apps /app resets every revision).
// This ECDSA wallet derives relayDid, which the OAuth DCR client store
// is keyed to; if it regenerates per revision, every previously
// registered MCP client_id is orphaned (→ invalid_client on reconnect).
// Mirror RELAY_AGENT_KEY_JSON (X25519): wire from a Container Apps
// secretref. Shape: { "privateKey": "0x..." }.
const RELAY_COMPLIANCE_WALLET_JSON = process.env['RELAY_COMPLIANCE_WALLET_JSON'];
let _relayComplianceWallet: PersistedComplianceWallet | null = null;
async function ensureRelayComplianceWallet(): Promise<PersistedComplianceWallet> {
  if (_relayComplianceWallet) return _relayComplianceWallet;
  if (RELAY_COMPLIANCE_WALLET_JSON && RELAY_COMPLIANCE_WALLET_JSON.trim().length > 0) {
    let pk: string | undefined;
    try {
      pk = (JSON.parse(RELAY_COMPLIANCE_WALLET_JSON) as { privateKey?: string }).privateKey;
    } catch (err) {
      throw new Error(`RELAY_COMPLIANCE_WALLET_JSON is not valid JSON: ${(err as Error).message}. Restore from backup or unset to mint a new (ephemeral) wallet.`);
    }
    if (!pk) throw new Error('RELAY_COMPLIANCE_WALLET_JSON missing required field `privateKey`.');
    const wallet = new EthersWalletCtor(pk) as unknown as PersistedComplianceWallet['wallet'];
    _relayComplianceWallet = {
      wallet,
      privateKey: pk,
      createdAt: new Date().toISOString(),
      path: 'env:RELAY_COMPLIANCE_WALLET_JSON',
      fresh: false,
      historyCount: 0,
    };
    registerComplianceWalletForSigning(_relayComplianceWallet);
    return _relayComplianceWallet;
  }
  _relayComplianceWallet = await loadOrCreateComplianceWallet(
    RELAY_COMPLIANCE_WALLET_FILE,
    'relay-compliance-signer',
  );
  registerComplianceWalletForSigning(_relayComplianceWallet);
  return _relayComplianceWallet;
}

// Register the compliance wallet's private key in @interego/core's
// in-process walletKeys map so signMessageRaw → getSigningWallet(addr)
// can actually sign with it. WITHOUT this, the wallet object exists and
// the address is pinned (RELAY_COMPLIANCE_WALLET_JSON), but every
// sign_authorship / delegation-credential signing throws "No private key
// available for <addr>. Only wallets created in this process can sign."
// — because getSigningWallet only knows wallets registered via
// createWallet/importWallet, and the compliance wallet is constructed
// directly. This was the root cause of finding f-agent-identity-persistence
// symptoms #1 (sign_authorship signed:false) and #2 (register_agent's
// credential step throwing → verify_agent finds nothing). Pinning the
// wallet (durable address) + registering it here (signable in every
// process) together close the finding for the relay's single-signer model.
function registerComplianceWalletForSigning(cw: PersistedComplianceWallet): void {
  try {
    importWallet(cw.privateKey, 'agent', 'relay-compliance-signer');
  } catch (err) {
    log(`[startup-warn] could not register compliance wallet for signing: ${(err as Error).message}`);
  }
}

// ── Delegation VC signer + verifier ─────────────────────────
//
// The relay holds the compliance ECDSA wallet on the pod owner's
// authenticated behalf (the OAuth bearer the request came in with
// proves key-possession against identity server, which is itself the
// gatekeeper for the wallet). At register-agent time we mint a signed
// VC whose `proof` is an ECDSA signature over the canonical credential
// payload. At verify-delegation time we recover the signer from the
// proof and confirm it matches the address recorded inside the VC —
// any tampering with the credential body, the agent id, the scope, or
// the proof block itself invalidates the recovery.
//
// `did:ethr:<addr>` is used as the `verificationMethod` IRI: it is
// self-describing and lets non-pod verifiers (an audit tool, another
// relay) recover the public key without an extra DID-document fetch.
async function getDelegationSigner(): Promise<DelegationSigner> {
  const cw = await ensureRelayComplianceWallet();
  return makeWalletDelegationSigner(cw.wallet);
}

/**
 * Verify a delegation proof block against its canonical payload.
 *
 * Recovery-based check shared with the stdio MCP shim: derives the
 * address from the (payload, signature) pair and compares it
 * case-insensitively against `proof.signerAddress`. Symmetric with
 * `getDelegationSigner` so the relay can verify the VCs it signed
 * itself AND VCs signed by any other party using an Ethereum-style
 * ECDSA key (including external wallets that users will eventually
 * plug in to replace the relay-backed compliance signer).
 */
const delegationVerifier: DelegationVerifier = makeWalletDelegationVerifier();

// ── OAuth provider init (DCR-persistent) ────────────────────
//
// Hydrate the OAuth provider's client map from the maintainer's pod
// BEFORE any top-level consumer (mcpAuthRouter, requireBearerAuth) is
// wired below. Without this, every container restart silently
// invalidates every previously-issued DCR client_id. The store module
// also gives the provider a `persistClient` sink so each future
// registerClient mirrors back to the pod as its own Context Descriptor
// with an AccessControl facet restricting reads to the relay's DID.
//
// All cold-start failures collapse to "empty Map": loadClients catches
// network / parse errors and returns an empty map, so a brand-new
// deployment (no maintainer pod yet, no manifest) starts cleanly.
const oauthStorePodUrl = resolveOAuthStorePodUrl(CSS_URL);
const _oauthStoreWallet = await ensureRelayComplianceWallet();
const oauthStoreCfg: OAuthClientStoreConfig = {
  podUrl: oauthStorePodUrl,
  relayDid: relayDidFromAddress(_oauthStoreWallet.wallet.address),
  fetch: solidFetch,
  log: (msg: string) => log(msg),
  // At-rest seal for client_secret in each persisted DCR descriptor.
  // CSS leaves GETs anonymous, so the descriptor graph is reachable to
  // any caller that knows the slug pattern; wrapping the secret in a
  // self-recipient X25519 envelope keeps the on-pod literal opaque.
  encryptionKey: relayAgentKey,
};
const _oauthInitialClients = await loadOAuthClients(oauthStoreCfg);
log(`OAuth DCR store: pod=${oauthStorePodUrl} relayDid=${oauthStoreCfg.relayDid} loaded=${_oauthInitialClients.size}`);

// OAuth access + refresh tokens piggyback on the same service-account
// pod. They live under sibling subcontainers `tokens/` and
// `tokens-refresh/`, filename = sha256(token).hex so the raw bearer
// never lands on disk. See oauth-token-store.ts for the storage shape.
//
// Without this hydration, every relay restart drops every issued
// access token and existing ChatGPT / claude.ai sessions surface as
// `401 invalid_token` until the user re-authorizes. The
// `lookupAccessTokenByRaw` hook handles the narrower case where a
// token was issued by a peer process this restart hasn't seen yet.
const oauthTokenStoreCfg: OAuthTokenStoreConfig = {
  podUrl: oauthStorePodUrl,
  fetch: solidFetch,
  log: (msg: string) => log(msg),
  // At-rest seal for the long-lived identity-server bearer carried in
  // each persisted access/refresh record. The css-gate intentionally
  // leaves GETs anonymous, so anything written to svc-relay-dcr/tokens/
  // is enumerable by an unauthenticated reader via the LDP container
  // listing; envelope-wrapping the bearer to the relay's own X25519
  // keypair keeps the on-pod body opaque while a single relay process
  // round-trips encrypt/decrypt locally.
  encryptionKey: relayAgentKey,
};
// Access tokens stay EAGER-loaded: introspectAccessToken (the css-gate
// /verify-token path) is synchronous and can't read-through, so the
// sha-map must be warm for it. They're short-lived (1h) so the set is
// small — a cheap boot cost.
const _oauthInitialAccessTokensBySha = await loadOAuthAccessTokens(oauthTokenStoreCfg);
// Refresh tokens warm in the BACKGROUND (not awaited) — they were the
// slow boot leg (~115 entries × CSS read latency). The provider holds
// this Map by reference, so background fills are visible to it, and the
// new lookupRefreshTokenByRaw read-through covers any token used before
// the warm completes. "Authority on the pod; the process holds only a
// read-through cache" — so boot no longer blocks loading it.
const _oauthInitialRefreshTokensBySha: Awaited<ReturnType<typeof loadOAuthRefreshTokens>> = new Map();
void loadOAuthRefreshTokens(oauthTokenStoreCfg)
  .then(loaded => {
    for (const [k, v] of loaded) if (!_oauthInitialRefreshTokensBySha.has(k)) _oauthInitialRefreshTokensBySha.set(k, v);
    log(`OAuth refresh tokens warmed (background): ${_oauthInitialRefreshTokensBySha.size}`);
  })
  .catch(err => log(`[startup-warn] background refresh-token warm failed: ${(err as Error).message}`));
log(`OAuth token store: pod=${oauthStorePodUrl} access=${_oauthInitialAccessTokensBySha.size} refresh=<warming in background>`);

oauthProvider = new InteregoOAuthProvider({
  identityUrl: IDENTITY_URL,
  tokenTtlSec: 3600,
  initialClients: _oauthInitialClients,
  persistClient: (client_id, client_data) =>
    saveOAuthClient(client_id, client_data, oauthStoreCfg),
  // Read-through fallback on getClient miss: a registration that exists
  // on the pod but isn't in the boot-loaded map (manifest drift) still
  // authenticates. See loadOneClient in oauth-client-store.ts.
  loadClient: (client_id) => loadOneOAuthClient(client_id, oauthStoreCfg),
  initialAccessTokensBySha: _oauthInitialAccessTokensBySha,
  initialRefreshTokensBySha: _oauthInitialRefreshTokensBySha,
  persistAccessToken: (token, info) => persistOAuthAccessToken(token, info, oauthTokenStoreCfg),
  persistRefreshToken: (refreshToken, rec) => persistOAuthRefreshToken(refreshToken, rec, oauthTokenStoreCfg),
  removeAccessToken: (sha) => removeOAuthAccessToken(sha, oauthTokenStoreCfg),
  removeRefreshToken: (sha) => removeOAuthRefreshToken(sha, oauthTokenStoreCfg),
  lookupAccessTokenByRaw: (token) => loadOAuthAccessTokenByRaw(token, oauthTokenStoreCfg),
  lookupRefreshTokenByRaw: (token) => loadOAuthRefreshTokenByRaw(token, oauthTokenStoreCfg),
  log: (msg: string) => log(msg),
});

// ── Tool Handlers ───────────────────────────────────────────

type ToolArgs = Record<string, unknown>;

// In steady state every publish_context calls readAgentRegistry just to
// confirm the calling surface-agent is registered with the relay's
// current encryption key. Both checks are stable for the relay-process
// lifetime, so a short TTL cache eliminates one CSS GET per publish on
// the response path. Bounded LRU mirrors identityMeCache below.
const AGENT_REGISTRATION_CACHE_TTL_MS = 60 * 1000;
const AGENT_REGISTRATION_CACHE_MAX = 1024;
const agentRegistrationCache = new Map<string, { expiresAt: number }>();

// Per-pod full-profile cache. agentRegistrationCache above only memoizes the
// boolean "this surface-agent is registered + key matches" check — the
// publish_context recipient-set computation (and discover_context's
// verify_delegation branch, and get_pod_status) still need the entire
// AgentRegistry to enumerate every authorized agent's encryptionPublicKey.
// Without this cache each authenticated publish does a second CSS GET
// against Azure CSS on the hot path. Mirrors mcp-server's profileCache.
// Invalidated on every writeAgentRegistry success below.
const relayProfileCache = new Map<string, { profile: OwnerProfileData; expiresAt: number }>();
async function getCachedRelayProfile(podUrl: string): Promise<OwnerProfileData | null> {
  const hit = relayProfileCache.get(podUrl);
  if (hit && hit.expiresAt > Date.now()) return hit.profile;
  if (hit) relayProfileCache.delete(podUrl);
  const profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
  if (profile) {
    if (relayProfileCache.size >= AGENT_REGISTRATION_CACHE_MAX) {
      const oldestKey = relayProfileCache.keys().next().value;
      if (oldestKey !== undefined) relayProfileCache.delete(oldestKey);
    }
    relayProfileCache.set(podUrl, { profile, expiresAt: Date.now() + AGENT_REGISTRATION_CACHE_TTL_MS });
  }
  return profile;
}

// Per-pod unfiltered-manifest cache. publish_context auto-supersede plus
// the get_pod_status / verify_agent / register_agent / revoke_agent paths
// all GET the full manifest (10s-100s of KB on busy pods) and re-run
// parseManifest. Short TTL coalesces burst publishes while staying small
// enough that competing publishers' writes become visible quickly.
// Invalidated locally on publish since this handler just changed it.
const MANIFEST_CACHE_TTL_MS = 10 * 1000;
const MANIFEST_CACHE_MAX = 1024;
const manifestCache = new Map<string, { entries: ManifestEntry[]; expiresAt: number; graphIriIndex: Map<string, ManifestEntry[]> }>();
async function getCachedManifest(podUrl: string): Promise<ManifestEntry[]> {
  const hit = manifestCache.get(podUrl);
  if (hit && hit.expiresAt > Date.now()) return hit.entries;
  if (hit) manifestCache.delete(podUrl);
  // Read the monolithic manifest (always — legacy + authoritative).
  // When append-only is enabled, ALSO read the per-entry container and
  // union/dedupe by descriptor URL. The monolithic version is
  // preferred on collision (it's the published-and-CAS-verified version).
  const [monolithic, appendOnly] = await Promise.all([
    discover(podUrl, undefined, { fetch: solidFetch }),
    APPEND_ONLY_ENABLED ? readAppendOnlyEntries(podUrl) : Promise.resolve([] as ManifestEntry[]),
  ]);
  const byUrl = new Map<string, ManifestEntry>();
  for (const e of appendOnly) byUrl.set(String(e.descriptorUrl), e);
  for (const e of monolithic) byUrl.set(String(e.descriptorUrl), e); // monolithic wins on collision
  const entries = [...byUrl.values()];
  if (manifestCache.size >= MANIFEST_CACHE_MAX) {
    const oldestKey = manifestCache.keys().next().value;
    if (oldestKey !== undefined) manifestCache.delete(oldestKey);
  }
  // Build a graph_iri → entries index alongside the cache. The rev-192
  // graph_iri filter is the hot path on discover_context (and on the
  // auto-supersede sweep inside publish_context) — without the index
  // both paths do O(N) linear scans of the manifest. With it they're
  // O(1) per matching graph IRI.
  const graphIriIndex = new Map<string, ManifestEntry[]>();
  for (const e of entries) {
    for (const g of e.describes ?? []) {
      const list = graphIriIndex.get(g);
      if (list) list.push(e); else graphIriIndex.set(g, [e]);
    }
  }
  manifestCache.set(podUrl, { entries, expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS, graphIriIndex });
  return entries;
}

// Apply filter/sort/limit to cached manifest entries in-process. Mirrors
// the logic inside @interego/solid's discover() at packages/solid/src/
// client.ts L1768-1808, but starts from cached entries (avoiding the
// full manifest GET + parseManifest on every call) and short-circuits
// graph_iri filter through the graphIriIndex (O(1) instead of O(N)).
//
// Filter shape mirrors DiscoverFilter (graphIri, facetType, validFrom,
// validUntil, effectiveAt, sort, limit). The rev-192 graph_iri filter
// is the only one for which we have a server-side index; other
// predicates still scan, but only the cached entries.
type DiscoverFilterLite = {
  graphIri?: string;
  facetType?: string;
  validFrom?: string;
  validUntil?: string;
  effectiveAt?: string;
  sort?: 'newest-first' | 'oldest-first' | 'unsorted';
  limit?: number;
};
async function discoverCached(podUrl: string, filter?: DiscoverFilterLite): Promise<ManifestEntry[]> {
  // Force a fresh fetch when no cache hit, so callers see writes that
  // happened in the same request flow (publish_context invalidates).
  await getCachedManifest(podUrl);
  const cached = manifestCache.get(podUrl);
  if (!cached) return [];
  // Fast path: graph_iri filter via index.
  let candidates: ManifestEntry[];
  if (filter?.graphIri) {
    candidates = cached.graphIriIndex.get(filter.graphIri) ?? [];
  } else {
    candidates = cached.entries;
  }
  // Apply remaining predicates linearly.
  const filtered = candidates.filter(e => {
    if (filter?.facetType && !(e.facetTypes ?? []).some(f => f === filter.facetType)) return false;
    if (filter?.validFrom && (e.validFrom ?? '') < filter.validFrom) return false;
    if (filter?.validUntil && (e.validUntil ?? '') > filter.validUntil) return false;
    if (filter?.effectiveAt) {
      const t = filter.effectiveAt;
      if ((e.validFrom ?? '') > t) return false;
      if (e.validUntil && e.validUntil < t) return false;
    }
    return true;
  });
  // Sort (default newest-first by validFrom).
  const sortMode = filter?.sort ?? 'newest-first';
  let sorted: ManifestEntry[] = filtered;
  if (sortMode !== 'unsorted') {
    sorted = filtered.slice().sort((a, b) => {
      const av = a.validFrom ?? '';
      const bv = b.validFrom ?? '';
      return sortMode === 'newest-first' ? bv.localeCompare(av) : av.localeCompare(bv);
    });
  }
  if (typeof filter?.limit === 'number' && filter.limit >= 0) {
    return sorted.slice(0, filter.limit);
  }
  return sorted;
}

// ── Append-only manifest (Fix-5, feature-flagged) ───────────
//
// The monolithic manifest at `<pod>/.well-known/context-graphs` is a
// single Turtle resource updated via GET-modify-PUT with If-Match CAS.
// Under sustained load this is the bottleneck — every publish reads,
// edits, and rewrites the entire manifest, and concurrent writes
// have to serialize through the relay's per-pod mutex (Fix-1).
//
// The append-only path writes EACH manifest entry as its own resource
// at `<pod>/.well-known/cg-entries/<descriptor-slug>.entry.ttl` (one
// PUT, no RMW, no CAS). Reads union the monolithic manifest + the
// container listing of cg-entries/.
//
// Feature-flagged + ADDITIVE — when on, every publish writes BOTH the
// monolithic update (legacy) AND the entry file. When off, behavior is
// identical to pre-Fix-5. Turn on via env to test in prod without risk.
const APPEND_ONLY_ENABLED = String(process.env.MANIFEST_APPEND_ONLY_ENABLED ?? '').toLowerCase() === 'true';
// NOT under .well-known/ — CSS serializes writes to .well-known/* through
// a shared lock, so entry PUTs there collide with the monolithic manifest
// CAS (observed live: "412 concurrent manifest update detected after 8
// attempts" + "post-PUT verification: entry missing after 200 OK" when
// both paths shared the .well-known/ prefix). A regular pod-level
// container gets per-resource locks only.
const APPEND_ONLY_CONTAINER_SLUG = 'cg-entries';
function appendOnlyContainerUrl(podUrl: string): string {
  return `${podUrl}${APPEND_ONLY_CONTAINER_SLUG}/`;
}
function appendOnlyEntryUrl(podUrl: string, descriptorUrl: string): string {
  // Derive a stable filename from the descriptor URL's last segment.
  const tail = descriptorUrl.replace(/\.ttl$/, '').split('/').pop() ?? `entry-${Date.now()}`;
  return `${appendOnlyContainerUrl(podUrl)}${tail}.entry.ttl`;
}

// Build a standalone single-entry Turtle document — same predicates
// the legacy manifestEntryTurtle (packages/solid/src/client.ts L363)
// uses, with prefix declarations included so it can be parsed in
// isolation by the existing parseManifest regex.
function renderAppendOnlyEntry(args: {
  descriptorUrl: string;
  contentCid?: string;
  graphIris: string[];
  facetTypes: string[];
  validFrom?: string;
  validUntil?: string;
  conformsTo?: string[];
  supersedes?: string[];
  modalStatus?: string;
  trustLevel?: string;
  issuer?: string;
}): string {
  const lines: string[] = [
    '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '@prefix dct: <http://purl.org/dc/terms/> .',
    '',
    `<${args.descriptorUrl}> a iep:ManifestEntry ;`,
  ];
  if (args.contentCid) lines.push(`    iep:contentCid "${args.contentCid}" ;`);
  for (const g of args.graphIris ?? []) lines.push(`    iep:describes <${g}> ;`);
  for (const ft of args.facetTypes ?? []) lines.push(`    iep:hasFacetType iep:${ft} ;`);
  if (args.validFrom)  lines.push(`    iep:validFrom "${args.validFrom}"^^xsd:dateTime ;`);
  if (args.validUntil) lines.push(`    iep:validUntil "${args.validUntil}"^^xsd:dateTime ;`);
  for (const c of args.conformsTo ?? []) lines.push(`    dct:conformsTo <${c}> ;`);
  for (const s of args.supersedes ?? []) lines.push(`    iep:supersedes <${s}> ;`);
  if (args.modalStatus) lines.push(`    iep:modalStatus iep:${args.modalStatus} ;`);
  if (args.trustLevel)  lines.push(`    iep:trustLevel iep:${args.trustLevel} ;`);
  if (args.issuer)      lines.push(`    iep:issuer <${args.issuer}> ;`);
  // Terminate (replace trailing semicolon)
  const last = lines[lines.length - 1];
  lines[lines.length - 1] = last.endsWith(' ;') ? last.slice(0, -2) + ' .' : last + ' .';
  return lines.join('\n') + '\n';
}

// Write a single-entry file. Fire-and-forget so it doesn't block the
// caller's publish response. Best-effort: failures are logged but do
// not affect the monolithic manifest (which is still the authoritative
// store while the flag is being rolled out).
function writeAppendOnlyEntryAsync(podUrl: string, descriptorUrl: string, entryTurtle: string): void {
  const url = appendOnlyEntryUrl(podUrl, descriptorUrl);
  // Bootstrap the container if needed — single best-effort PUT, the
  // request that follows will work even if this is a no-op.
  void (async () => {
    try {
      await solidFetch(appendOnlyContainerUrl(podUrl), {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/turtle',
          'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
        },
        body: '',
      });
      const res = await solidFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/turtle' },
        body: entryTurtle,
      });
      if (!res.ok && res.status !== 201 && res.status !== 204) {
        console.warn(`[relay] append-only entry write ${url} → ${res.status}`);
      }
    } catch (err) {
      console.warn(`[relay] append-only entry write ${url} failed: ${(err as Error).message}`);
    }
  })();
}

// Read entries from the append-only container. Returns the parsed
// ManifestEntry[] (parseManifest can handle our renderAppendOnlyEntry
// format since each entry uses the same `<url> a iep:ManifestEntry`
// anchor). Empty array if container does not exist.
async function readAppendOnlyEntries(podUrl: string): Promise<ManifestEntry[]> {
  const containerUrl = appendOnlyContainerUrl(podUrl);
  try {
    const listResp = await solidFetch(containerUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/ld+json' },
    });
    if (!listResp.ok) return [];
    const listJson = await listResp.json() as Array<{ '@id'?: string }>;
    const entryUrls = (Array.isArray(listJson) ? listJson : [])
      .map(x => x?.['@id'])
      .filter((u): u is string => typeof u === 'string' && u.endsWith('.entry.ttl'));
    if (entryUrls.length === 0) return [];
    // Fetch entries in parallel (bounded by undici pool).
    const entryTurtles = await Promise.all(entryUrls.map(async u => {
      const cached = descriptorBodyCache.get(u);
      if (cached && cached.expiresAt > Date.now()) return cached.content;
      const r = await solidFetch(u, { method: 'GET', headers: { 'Accept': 'text/turtle' } });
      if (!r.ok) return null;
      const text = await r.text();
      cacheDescriptorBody(u, { content: text, mediaType: 'text/turtle', encrypted: false });
      return text;
    }));
    const combined = entryTurtles.filter((t): t is string => typeof t === 'string').join('\n\n');
    if (!combined) return [];
    return parseManifest(combined);
  } catch {
    return [];
  }
}

// ── Descriptor body cache (Fix-4 outer) ─────────────────────
//
// Descriptors and their graph bodies are content-addressed via
// iep:contentCid — once published, the URL → bytes mapping is immutable.
// Cache plaintext (non-encrypted) bodies with a long TTL so repeated
// dereference / get_descriptor / federated-read calls don't hit CSS
// for the same URL. Encrypted envelopes are NEVER cached (the bytes
// depend on the recipient key thumbprint; cross-recipient leakage
// would be a security bug).
const DESCRIPTOR_BODY_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes
const DESCRIPTOR_BODY_CACHE_MAX = 2048;
const descriptorBodyCache = new Map<string, { content: string; mediaType: string; encrypted: boolean; expiresAt: number }>();
function cacheDescriptorBody(url: string, value: { content: string; mediaType: string; encrypted: boolean }): void {
  if (value.encrypted) return;
  if (descriptorBodyCache.size >= DESCRIPTOR_BODY_CACHE_MAX) {
    const oldest = descriptorBodyCache.keys().next().value;
    if (oldest !== undefined) descriptorBodyCache.delete(oldest);
  }
  descriptorBodyCache.set(url, { ...value, expiresAt: Date.now() + DESCRIPTOR_BODY_CACHE_TTL_MS });
}

// ── Deferred-publish tracker ────────────────────────────────
//
// publish_context returns a synchronous 202-shaped result with
// content-addressable predicted URLs (descriptor + graph + manifest + CID)
// and runs the substrate CSS chain (graph PUT + descriptor PUT + manifest
// CAS) in the background. Callers that need hard confirmation poll the
// descriptor URL (HEAD until 200). This map gives us a per-pending
// publish status so future tooling (and tests) can read "is the publish
// committed yet?" without HEAD-spinning.
//
// Pattern mirrors the in-process tracked-promise maps used in
// federationStore, lazyPodInit's `bootstrappedPods`, and the
// `manifestWriteQueues` mutex map inside the solid binding. Each entry
// is short-lived — entries are removed once the deferred publish
// resolves OR after DEFERRED_PUBLISH_MAX_AGE_MS to bound memory.
type DeferredPublishStatus =
  | { kind: 'pending'; startedAt: number }
  | { kind: 'committed'; startedAt: number; resolvedAt: number; descriptorUrl: string; graphUrl: string }
  | { kind: 'failed'; startedAt: number; resolvedAt: number; error: string };
const DEFERRED_PUBLISH_MAX_ENTRIES = 4096;
const DEFERRED_PUBLISH_MAX_AGE_MS = 5 * 60 * 1000;
const deferredPublishStatus = new Map<string, DeferredPublishStatus>();
function setDeferredPublishStatus(descriptorUrl: string, status: DeferredPublishStatus): void {
  if (deferredPublishStatus.size >= DEFERRED_PUBLISH_MAX_ENTRIES) {
    // Evict the oldest insertion (Map preserves insertion order).
    const oldestKey = deferredPublishStatus.keys().next().value;
    if (oldestKey !== undefined) deferredPublishStatus.delete(oldestKey);
  }
  deferredPublishStatus.set(descriptorUrl, status);
  // Best-effort age-based eviction sweep — at most one extra delete
  // per write so the sweep cost stays O(1) amortized.
  const now = Date.now();
  for (const [k, v] of deferredPublishStatus) {
    const baseline = v.kind === 'pending' ? v.startedAt : v.resolvedAt;
    if (now - baseline > DEFERRED_PUBLISH_MAX_AGE_MS) {
      deferredPublishStatus.delete(k);
    }
    break; // sweep one entry per call — cheap, bounded
  }
}
export function getDeferredPublishStatus(descriptorUrl: string): DeferredPublishStatus | undefined {
  return deferredPublishStatus.get(descriptorUrl);
}

// ── Conformance gate (SHACL) ────────────────────────────────
//
// FIX 4 — at publish time, look up `iep:conformsTo <shapeIri>` triples
// declared on the target pod's container metadata, fetch each shape,
// and validate the inbound graph_content against it. On non-conformance
// reject 422 BEFORE the CSS write so a violating descriptor never lands
// on the pod. Cached per-podUrl to avoid the manifest GET on every
// publish.
//
// Container-shape lookup precedence:
//   1. <container>.well-known/container-shape  (Turtle, listing
//      iep:conformsTo IRIs as iep:declares-shape triples — purpose-built
//      home for shape declarations that isn't tied to the manifest CAS
//      dance).
//   2. The pod manifest (.well-known/context-graphs) — any iep:conformsTo
//      / dct:conformsTo on the manifest collection subject is treated
//      as a container-level declaration.
//
// Either source is fine; #1 is preferred because it doesn't compete with
// publish() for manifest etags.
const CONTAINER_SHAPE_CACHE_TTL_MS = 60 * 1000;
const CONTAINER_SHAPE_CACHE_MAX = 256;
const containerShapeCache = new Map<string, { shapes: readonly string[]; expiresAt: number }>();
const shapeBodyCache = new Map<string, { body: string | null; expiresAt: number }>();

async function fetchContainerShapes(podUrl: string): Promise<readonly string[]> {
  const cached = containerShapeCache.get(podUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.shapes;
  if (cached) containerShapeCache.delete(podUrl);

  const shapes = new Set<string>();
  const containerShapeUrl = `${podUrl.replace(/\/$/, '')}/.well-known/container-shape`;
  try {
    const r = await solidFetch(containerShapeUrl, { method: 'GET', headers: { 'Accept': 'text/turtle' } });
    if (r.ok) {
      const body = await r.text();
      for (const m of body.matchAll(/iep:conformsTo\s+<([^>]+)>/g)) shapes.add(m[1]!);
      for (const m of body.matchAll(/dct:conformsTo\s+<([^>]+)>/g)) shapes.add(m[1]!);
      for (const m of body.matchAll(/iep:declares-shape\s+<([^>]+)>/g)) shapes.add(m[1]!);
    }
  } catch { /* ignore — fall through to manifest scan */ }

  if (shapes.size === 0) {
    const manifestUrl = `${podUrl.replace(/\/$/, '')}/.well-known/context-graphs`;
    try {
      const r = await solidFetch(manifestUrl, { method: 'GET', headers: { 'Accept': 'text/turtle' } });
      if (r.ok) {
        const body = await r.text();
        // Restrict the scan to the manifest collection's own subject —
        // we only want CONTAINER-level conformance, not random conformsTo
        // triples on individual ManifestEntry rows (which belong to
        // descriptors, not to the container).
        const escapedManifest = manifestUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const collectionBlock = body.match(
          new RegExp(`<${escapedManifest}>[\\s\\S]*?(?=\\n<|$)`),
        )?.[0];
        if (collectionBlock) {
          for (const m of collectionBlock.matchAll(/iep:conformsTo\s+<([^>]+)>/g)) shapes.add(m[1]!);
          for (const m of collectionBlock.matchAll(/dct:conformsTo\s+<([^>]+)>/g)) shapes.add(m[1]!);
        }
      }
    } catch { /* ignore — pod has no manifest yet */ }
  }

  const result = Object.freeze([...shapes]);
  if (containerShapeCache.size >= CONTAINER_SHAPE_CACHE_MAX) {
    const oldestKey = containerShapeCache.keys().next().value;
    if (oldestKey !== undefined) containerShapeCache.delete(oldestKey);
  }
  containerShapeCache.set(podUrl, { shapes: result, expiresAt: Date.now() + CONTAINER_SHAPE_CACHE_TTL_MS });
  return result;
}

// FIX A — Accept header for shape fetches.
//
// Advertises every serialization the in-process SHACL engine can
// parse: parseTrig handles turtle + trig uniformly, and n-quads is
// line-oriented quads that the TriG parser tolerates (each quad-line
// terminates with a `.`). Without this header, a strict server
// (CSS quad-store config, an nginx negotiator, or any reverse proxy)
// facing a shape PUT'd as application/trig answers 406 Not Acceptable
// for `text/turtle`-only requests — and the gate then silently lets
// the publish through because fetchShapeBody returns null. JSON-LD is
// advertised at low q so a JSON-LD-stored shape can at least signal
// its presence; the parser will fail JSON-LD bodies but the WARN
// below makes the miss observable rather than invisible.
const SHAPE_ACCEPT_HEADER =
  'text/turtle, application/trig;q=0.9, application/n-quads;q=0.8, application/ld+json;q=0.7';

async function fetchShapeBody(shapeIri: string): Promise<string | null> {
  const cached = shapeBodyCache.get(shapeIri);
  if (cached && cached.expiresAt > Date.now()) return cached.body;
  if (cached) shapeBodyCache.delete(shapeIri);

  let body: string | null = null;
  let warnReason: string | null = null;
  try {
    const r = await solidFetch(shapeIri, { method: 'GET', headers: { 'Accept': SHAPE_ACCEPT_HEADER } });
    if (r.ok) {
      const text = await r.text();
      if (text && text.trim().length > 0) {
        body = text;
      } else {
        warnReason = `empty body (HTTP ${r.status})`;
      }
    } else {
      warnReason = `HTTP ${r.status} ${r.statusText}`;
    }
  } catch (err) {
    // Network failures → treat as missing shape, but record the cause
    // so a misconfigured / unreachable shape can't masquerade as "no
    // shape declared". WARN-logged below, NOT silently swallowed.
    warnReason = `fetch threw: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (body === null && warnReason !== null) {
    log(`WARN conformance gate could not fetch shape ${shapeIri} — ${warnReason}. Publish will proceed UNVALIDATED against this shape.`);
  }

  if (shapeBodyCache.size >= CONTAINER_SHAPE_CACHE_MAX) {
    const oldestKey = shapeBodyCache.keys().next().value;
    if (oldestKey !== undefined) shapeBodyCache.delete(oldestKey);
  }
  shapeBodyCache.set(shapeIri, { body, expiresAt: Date.now() + CONTAINER_SHAPE_CACHE_TTL_MS });
  return body;
}

/**
 * Run every container-declared shape AND every caller-supplied shape
 * (via the MCP `conforms_to_shapes` arg) against the inbound graph_content.
 * Returns either { conforms: true, resolvedShapes } or the violation list
 * ready to surface in the 422 error envelope. Missing shape bodies (404
 * etc.) are ignored — they can't constrain a publish if the relay can't
 * fetch them.
 *
 * Container-declared shapes (from .well-known/container-shape or the
 * pod's manifest collection's iep:conformsTo / dct:conformsTo triples)
 * AND caller-supplied shapes are both validated — any one failing rejects.
 * De-duplicated by IRI: if the same shape appears in both sources, it
 * runs once.
 *
 * `resolvedShapes` carries every (shapeIri, shapeTurtle) pair the gate
 * fetched, so the caller can re-thread the same bodies into the
 * substrate-level publish() gate (defense in depth — the gate is the
 * relay's fast-fail, the substrate gate is the kernel-level invariant)
 * without double-fetching.
 */
async function runConformanceGate(
  podUrl: string,
  graphContent: string,
  callerShapeIris: readonly string[] = [],
): Promise<
  | { conforms: true; resolvedShapes: readonly { shapeIri: string; shapeTurtle: string }[] }
  | { conforms: false; shape: string; violations: readonly ShaclResult[] }
> {
  const containerShapeIris = await fetchContainerShapes(podUrl);
  const seen = new Set<string>();
  const allShapes: string[] = [];
  for (const s of containerShapeIris) {
    if (!seen.has(s)) { seen.add(s); allShapes.push(s); }
  }
  for (const s of callerShapeIris) {
    if (!seen.has(s)) { seen.add(s); allShapes.push(s); }
  }
  if (allShapes.length === 0) return { conforms: true, resolvedShapes: [] };
  const resolvedShapes: { shapeIri: string; shapeTurtle: string }[] = [];
  for (const shapeIri of allShapes) {
    const shapeTurtle = await fetchShapeBody(shapeIri);
    if (!shapeTurtle) continue;
    const report = validateAgainstShape(graphContent, shapeTurtle, { entailment: 'rdfs' });
    if (!report.conforms) {
      return { conforms: false, shape: shapeIri, violations: report.results };
    }
    resolvedShapes.push({ shapeIri, shapeTurtle });
  }
  return { conforms: true, resolvedShapes };
}

// ── Scope gate ──────────────────────────────────────────────
//
// FIX 4 — registry-declared iep:scope (ReadWrite / ReadOnly / PublishOnly
// / DiscoverOnly) was previously decorative: handlePublishContext didn't
// check it at all, so a Read-scoped agent could call publish_context and
// the relay would happily write the descriptor + payload on their pod.
// This gate makes scope normative: any scope NOT in the write-eligible
// set short-circuits to a 403 error envelope BEFORE the CSS write.
//
// Cached per (agentId, podUrl) for AGENT_REGISTRATION_CACHE_TTL_MS so
// the verify round-trip doesn't fire on every publish from the same
// session.
const SCOPE_CACHE_TTL_MS = AGENT_REGISTRATION_CACHE_TTL_MS;
const SCOPE_CACHE_MAX = AGENT_REGISTRATION_CACHE_MAX;
const agentScopeCache = new Map<string, { scope: string; valid: boolean; expiresAt: number }>();

const WRITE_ELIGIBLE_SCOPES = new Set(['ReadWrite', 'PublishOnly']);

// ── OAuth-level read/write scope split ──────────────────────────
//
// The substrate scope above (iep:scope: ReadWrite / ReadOnly / PublishOnly
// / DiscoverOnly) lives in the pod's agent registry and is keyed on the
// AGENT delegation chain — every publish_context invocation walks it
// before the CSS write. That gate is mature.
//
// What was missing — and what FIX D adds — is an OAuth-LAYER read/write
// split that an external verifier can drive entirely through the
// standard OAuth authorize/token flow, without needing to mint an
// agent in the registry first. The relay now advertises three scopes
// in its OAuth metadata:
//
//   - `mcp`       — full access (read + write). Default.
//   - `mcp:read`  — read-only. Refused by every write-side tool.
//   - `mcp:write` — explicit write-side. Currently a synonym for `mcp`.
//
// A client requests narrowed scope via the standard query parameter
// (`GET /authorize?...&scope=mcp:read`); the MCP SDK's authorize handler
// passes it through to oauthProvider.authorize() as params.scopes,
// which propagates into the issued authorization code and (after the
// /token exchange) into the access token's `scopes` claim.
//
// The /mcp middleware admits the token if ANY of {mcp, mcp:read,
// mcp:write} is present (so a read-only bearer can still hit /mcp);
// per-tool enforcement below checks WRITE_SIDE_OAUTH_SCOPES and
// returns 403 insufficient_scope for write tools when the bearer
// carries `mcp:read` only.
//
// This is intentionally INDEPENDENT of the substrate-level scope gate
// — the two gates compose. A bearer might pass the OAuth scope check
// (carries `mcp` or `mcp:write`) and still be refused by the substrate
// gate because the delegated agent's iep:scope is ReadOnly. Either gate
// can independently produce a 403; verifiers need both to be
// independently testable, hence FIX D.
const OAUTH_SCOPE_FULL = 'mcp';
const OAUTH_SCOPE_READ = 'mcp:read';
const OAUTH_SCOPE_WRITE = 'mcp:write';
const ALL_MCP_OAUTH_SCOPES = new Set<string>([OAUTH_SCOPE_FULL, OAUTH_SCOPE_READ, OAUTH_SCOPE_WRITE]);
// Tools that mutate pod state. A bearer with only `mcp:read` is refused
// here BEFORE the substrate scope gate runs. (Read-side tools —
// discover_context, get_descriptor, list_known_pods, etc. — are not in
// this set, so a read-only bearer reaches them normally.)
const WRITE_SIDE_OAUTH_SCOPES = new Set<string>([OAUTH_SCOPE_FULL, OAUTH_SCOPE_WRITE]);
const WRITE_SIDE_TOOLS = new Set<string>([
  'publish_context',
  'register_agent',
  'revoke_agent',
  'compose_contexts',
  'add_pod',
  'remove_pod',
  'subscribe_to_pod',
  'unsubscribe_from_pod',
  'subscribe_all',
  'pgsl_ingest',
  'publish_context_descriptor',
  'publish_directory',
  'link_wallet',
  'setup_identity',
  'invoke_affordance',
  // `act` is now a first-class write path (it POSTs AMEP acts to /amep/acts with
  // the caller's auto-forwarded session), so a read-only OAuth bearer must be
  // refused at the early scope gate, consistently with invoke_affordance.
  'act',
]);

/** Any scope acceptable as a /mcp resource bearer. */
function hasAnyMcpScope(scopes: readonly string[] | undefined): boolean {
  if (!scopes) return false;
  for (const s of scopes) if (ALL_MCP_OAUTH_SCOPES.has(s)) return true;
  return false;
}

/** Returns true iff the bearer is permitted to invoke write-side tools. */
function hasWriteOauthScope(scopes: readonly string[] | undefined): boolean {
  if (!scopes) return false;
  for (const s of scopes) if (WRITE_SIDE_OAUTH_SCOPES.has(s)) return true;
  return false;
}

async function runScopeGate(
  agentId: string,
  podUrl: string,
): Promise<{ allowed: true } | { allowed: false; scope: string; reason: string }> {
  const key = `${podUrl}|${agentId}`;
  const cached = agentScopeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.valid && WRITE_ELIGIBLE_SCOPES.has(cached.scope)) return { allowed: true };
    return {
      allowed: false,
      scope: cached.scope,
      reason: cached.valid
        ? `scope "${cached.scope}" cannot publish`
        : 'agent is not registered on this pod',
    };
  }
  if (cached) agentScopeCache.delete(key);

  // Prefer the more-recently-verified value: walk the signed chain when
  // we have a verifier configured (the relay always does — see
  // delegationVerifier above) so the scope we read is the one the
  // owner cryptographically attested to. Falls back to the registry-only
  // check if the chain walk fails for any reason.
  let scope: string | undefined;
  let valid = false;
  try {
    const verified = await verifyAgentDelegation(
      agentId as IRI,
      podUrl,
      { fetch: solidFetch, verifier: delegationVerifier },
    );
    valid = verified.valid;
    scope = verified.scope;
    if (!valid) {
      const registryOnly = await verifyAgentDelegation(
        agentId as IRI,
        podUrl,
        { fetch: solidFetch },
      );
      valid = registryOnly.valid;
      scope = registryOnly.scope ?? scope;
    }
  } catch (err) {
    log(`WARN: scope gate verification threw for ${agentId} on ${podUrl}: ${(err as Error).message}`);
  }

  const resolvedScope = scope ?? 'Unknown';
  if (agentScopeCache.size >= SCOPE_CACHE_MAX) {
    const oldestKey = agentScopeCache.keys().next().value;
    if (oldestKey !== undefined) agentScopeCache.delete(oldestKey);
  }
  agentScopeCache.set(key, {
    scope: resolvedScope,
    valid,
    expiresAt: Date.now() + SCOPE_CACHE_TTL_MS,
  });

  if (valid && WRITE_ELIGIBLE_SCOPES.has(resolvedScope)) return { allowed: true };
  return {
    allowed: false,
    scope: resolvedScope,
    reason: valid
      ? `scope "${resolvedScope}" cannot publish — only ReadWrite or PublishOnly may write`
      : 'agent is not registered on this pod',
  };
}

async function handlePublishContext(args: ToolArgs): Promise<string> {
  const podName = (args.pod_name as string) ?? 'default';
  const podUrl = `${CSS_URL}${podName}/`;
  const agentId = (args.agent_id as string) ?? 'urn:agent:remote:unknown';
  const ownerWebId = (args.owner_webid as string) ?? `https://id.example.com/${podName}/profile#me`;
  const descId = (args.descriptor_id as string ?? `urn:iep:${podName}:${Date.now()}`) as IRI;
  const now = new Date().toISOString();

  // Ensure pod container exists. Skip on steady-state — lazy-pod-init's
  // bootstrappedPods Set is populated on successful bootstrap/HEAD, so
  // the PUT (one CSS round-trip) is only needed before that fast-path.
  if (!bootstrappedPods.has(podUrl)) {
    const res = await solidFetch(podUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '',
    });
    if (res.ok) bootstrappedPods.add(podUrl);
  }

  // ── Per-pod write serialization ───────────────────────────────
  //
  // Everything below — manifest pre-fetch, priorVersions computation,
  // agent-registry read-modify-write, Phase A precondition, and the
  // substrate publish() call — needs to run atomically per pod or
  // concurrent publish_context calls to the same pod will all read
  // the same stale manifest snapshot and compute the same
  // auto-supersede list before any of them commit. The CAS gate
  // inside publish() catches the head mismatch (412 retry), but the
  // priorVersions / auto-supersede computation that runs OUTSIDE
  // publish() will still be stale.
  //
  // Wrap the full handler body in withPodMutex (the existing per-pod
  // mutex primitive at ~L7052) so manifest-read + decisions + commit
  // are atomic from this relay's perspective. The deferred-publish
  // path's inner withPodMutex (L2149) stays — its background IIFE
  // runs AFTER this outer mutex releases, and serializes against
  // newer concurrent callers via the same gate.
  return await withPodMutex(podUrl, async () => {

  // Privacy-hygiene preflight: scan content for credentials, PII, etc.
  // We always WARN. We don't block automatically — the calling agent
  // decides. Warning is appended to the response so any LLM in the
  // loop sees it. See docs://interego/playbook §2 for guidance.
  const sensitivityFlags = screenForSensitiveContent((args.graph_content as string | undefined) ?? '');
  const sensitivityWarning = formatSensitivityWarning(sensitivityFlags);

  // L1 protocol preprocessing — modal-truth consistency + cleartext
  // mirror of cross-descriptor relationships from content into the
  // descriptor layer. Consolidated in @interego/core so the relay and
  // the local MCP path produce identical descriptors for identical
  // inputs (was duplicated in two places before 2026-04-20).
  const preprocessed = normalizePublishInputs({
    modalStatus: args.modal_status as 'Asserted' | 'Hypothetical' | 'Counterfactual' | undefined,
    confidence: args.confidence as number | undefined,
    graphContent: args.graph_content as string | undefined,
  });

  // Auto-supersede: when republishing a graph_iri (typically because
  // share_with added recipients), mark prior descriptor(s) on this pod
  // for the same graph_iri as superseded. Keeps federation queries
  // returning the canonical current version. Disable via
  // auto_supersede_prior: false.
  //
  // CAS precondition (if_match): the value is threaded into publish()
  // as ifMatchSupersedes / ifMatchCid — the substrate-level gate at
  // packages/solid/src/client.ts is the authoritative precondition
  // (it re-reads the actual descriptor turtle from the pod, not the
  // cached manifest snapshot) and rejects with 412 if the resolved
  // head doesn't match what the caller asserted.
  //
  // FIX (combined sign_authorship + if_match path) — we do NOT
  // pre-emptively `manifestCache.delete(podUrl)` here. The previous
  // behavior forced a fresh manifest GET ahead of the substrate CAS
  // round-trip, doubling the failure surface for the if_match path:
  // both the relay-side manifest read AND the substrate-side
  // prior-head read could fail in series if the freshly-written rev1
  // entry was still propagating. The substrate gate already does the
  // single authoritative GET of the actual descriptor turtle; the
  // cached manifest snapshot is only used to seed priorVersions
  // (which the substrate gate then validates). The post-publish
  // invalidation at the end of this handler keeps the cache honest
  // for the NEXT call.
  const ifMatch = args.if_match as string | undefined;
  const priorVersions: IRI[] = [];
  // Manifest entries the substrate gate / best-effort head-CID echo can
  // reuse. Populated when EITHER (a) auto_supersede needs to look up
  // prior versions, OR (b) an if_match precondition was supplied.
  // Built once so the manifest GET round-trip is shared.
  //
  // Stale-cache defence: when an if_match precondition was supplied we
  // FORCE a fresh manifest read (same `manifestCache.delete` policy
  // `handleGetCurrentHead` uses — see deploy/mcp-relay/server.ts:3760)
  // rather than risk consulting a 10-s-old snapshot that predates the
  // post-backfill mirror. Without this, the first publish after the
  // backfill admin endpoint ran would see a pre-mirror cached snapshot
  // (cidByUrl empty) and fall through to the body-fetch path the
  // backfill was meant to retire — exact failure mode johnny pinned.
  let manifestEntriesForLookup: readonly ManifestEntry[] | null = null;
  const needsManifest =
    (args.auto_supersede_prior !== false && args.graph_iri) ||
    ifMatch !== undefined;
  if (needsManifest) {
    if (ifMatch !== undefined) {
      manifestCache.delete(podUrl);
    }
    try {
      manifestEntriesForLookup = await getCachedManifest(podUrl);
    } catch (err) {
      log(`[publish/phaseA] manifest pre-fetch threw for ${podUrl}: ${(err as Error).message}`);
      manifestEntriesForLookup = null;
    }
    if (manifestEntriesForLookup && args.auto_supersede_prior !== false && args.graph_iri) {
      for (const e of manifestEntriesForLookup) {
        if (e.describes.includes((args.graph_iri as string) as IRI) && e.descriptorUrl !== descId) {
          priorVersions.push(e.descriptorUrl as IRI);
        }
      }
    }
  }
  // Manifest-mirrored head-CID lookup. Threaded into Phase A precondition
  // AND into publish()'s sync path so the descriptor-body GET +
  // computeCid step is skipped whenever the manifest carries the head's
  // iep:contentCid (always the case for entries written by post-fix
  // publishes; legacy entries fall through to the body fetch).
  //
  // URL-form normalization: manifest entries can carry either the
  // internal-FQDN host (`interego-css.internal.livelysky-...`) OR the
  // legacy public host (`interego-css.livelysky-...`) depending on when
  // they were written, and `descriptor.supersedes` may carry either
  // form too. Index by the canonical (internal) form on BOTH sides so a
  // legacy-public supersedes target still hits an internal-form
  // manifest entry (and vice versa). `normalizeCssUrl` is idempotent so
  // applying it on a canonical URL is a no-op.
  const manifestHeadCidLookupOpt: { headCidLookup?: (url: string) => string | null } = (() => {
    if (!manifestEntriesForLookup) return {};
    const cidByUrl = new Map<string, string>();
    for (const e of manifestEntriesForLookup) {
      if (!e.cid) continue;
      // Index by BOTH the raw + normalized form so neither side of the
      // lookup has to know which host shape the other indexed under.
      cidByUrl.set(e.descriptorUrl, e.cid);
      const normalized = normalizeCssUrl(e.descriptorUrl);
      if (normalized !== e.descriptorUrl) cidByUrl.set(normalized, e.cid);
    }
    if (cidByUrl.size === 0) return {};
    return {
      headCidLookup: (url: string) => {
        const direct = cidByUrl.get(url);
        if (direct) return direct;
        const normalized = normalizeCssUrl(url);
        return cidByUrl.get(normalized) ?? null;
      },
    };
  })();
  // Wire-level visibility for Phase A diagnosis. Logs whether the
  // mirror lookup is populated, the supersedes list the precondition
  // will iterate, and a sample of indexed URLs so a publish that 503s
  // can be triaged by reading one log line instead of binary-searching
  // the codepath. The descriptor URL is in `descId` (the relay's slug
  // form, NOT the predicted descriptor URL — that's resolved later).
  if (ifMatch !== undefined) {
    const cidIndexSize = manifestHeadCidLookupOpt.headCidLookup
      ? (() => {
        if (!manifestEntriesForLookup) return 0;
        let n = 0;
        for (const e of manifestEntriesForLookup) if (e.cid) n++;
        return n;
      })()
      : 0;
    const sampleEntries = (manifestEntriesForLookup ?? [])
      .filter(e => e.cid)
      .slice(0, 3)
      .map(e => `${e.descriptorUrl.slice(-40)}→${e.cid?.slice(0, 16)}…`);
    // Split priorVersions by scheme so we see at the wire whether
    // urn:/non-http targets are in the supersedes set (the failure
    // mode rev 190 fixes): those skip-via-non-http-guard cleanly
    // instead of body-fetching and burning the retry budget on
    // unreachable URLs.
    const httpTargets = priorVersions.filter(u => /^https?:\/\//i.test(u));
    const otherTargets = priorVersions.filter(u => !/^https?:\/\//i.test(u));
    log(`[publish/phaseA] cidIndex=${cidIndexSize} supersedes.http=${httpTargets.length} supersedes.other=${otherTargets.length} sample.http=[${httpTargets.slice(0, 2).map(u => u.slice(-50)).join(', ')}] sample.other=[${otherTargets.slice(0, 2).join(', ')}] sample.indexed=[${sampleEntries.join(', ')}]`);
  }

  // Heuristic: distinguish URL-form (URI scheme present) from CID-form
  // (base32 multibase, typically starting with `bafkrei...`). A real
  // CIDv1 raw-codec b32 is 59 chars; we accept anything without a URI
  // scheme as a CID candidate so the wire stays simple. The substrate
  // gate accepts both shapes, so degradation is graceful if a caller
  // passes the wrong form.
  const ifMatchLooksLikeUrl = ifMatch !== undefined && /^(https?:|urn:|file:|did:|\w+:\/\/)/i.test(ifMatch);
  const ifMatchSupersedes = ifMatchLooksLikeUrl ? ifMatch : undefined;
  const ifMatchCid = (ifMatch !== undefined && !ifMatchLooksLikeUrl) ? ifMatch : undefined;

  // Ensure the calling agent is registered + has a signed delegation VC
  // BEFORE the trust facet evaluates — the compliance grade upgrade
  // depends on verifyAgentDelegation finding a valid signed credential
  // chain on the pod for this agent. Without this ordering, the very
  // first publish_context call for a new OAuth session would always
  // downgrade to SelfAsserted because the chain wouldn't have been
  // minted yet.
  //
  // Three cases:
  //   1. No registry yet                          -> create profile + register this agent
  //   2. Registry present, this agent missing     -> register it (auto-provision) + mint signed VC
  //   3. Agent present but encryption key stale   -> patch the key
  // Without (1) and (2), OAuth clients whose agent identity wasn't already on
  // the pod would silently piggyback on whatever agent *was* registered,
  // breaking per-agent attribution and recipient-set growth. After this
  // block, every new OAuth-authenticated session adds its own did:web agent
  // with its own X25519 key as a first-class authorized agent on the pod.
  const agentRegCacheKey = `${podUrl}|${agentId}`;
  const agentRegCached = agentRegistrationCache.get(agentRegCacheKey);
  if (!agentRegCached || agentRegCached.expiresAt <= Date.now()) {
    if (agentRegCached) agentRegistrationCache.delete(agentRegCacheKey);
    try {
      let profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
      if (!profile) {
        profile = createOwnerProfile(ownerWebId as IRI, args.owner_name as string | undefined);
      }
      const me = profile.authorizedAgents.find(a => a.agentId === agentId && !a.revoked);
      let registeredOk = false;
      if (!me) {
        // Auto-register: this agent authenticated against identity server (so
        // the OAuth token proves key-possession). Safe to add to the pod's
        // authorized-agent list automatically.
        profile = addAuthorizedAgent(profile, {
          agentId: agentId as IRI,
          delegatedBy: ownerWebId as IRI,
          label: (args.label as string) ?? `Agent ${agentId}`,
          isSoftwareAgent: true,
          scope: 'ReadWrite',
          validFrom: new Date().toISOString(),
          encryptionPublicKey: relayAgentKey.publicKey,
        });
        // Mint a SIGNED VC so downstream verifiers can cryptographically
        // walk the chain (the unsigned form forces a SelfAsserted trust
        // label even on otherwise-trusted publishes). The signer is the
        // relay's compliance ECDSA wallet acting on the OAuth-bearer's
        // authenticated behalf. The credential write runs concurrently
        // with the registry PUT (independent CSS paths) but remains
        // best-effort — registry is authoritative.
        const newAgent = profile.authorizedAgents.find(a => a.agentId === agentId)!;
        const credentialWrite = (async () => {
          try {
            const signer = await getDelegationSigner();
            const credential = await createSignedDelegationCredential(
              profile,
              newAgent,
              podUrl as IRI,
              signer,
            );
            await writeDelegationCredential(credential, podUrl, { fetch: solidFetch });
          } catch { /* delegation credential is nice-to-have; registry is authoritative */ }
        })();
        await writeAgentRegistry(profile, podUrl, { fetch: solidFetch });
        relayProfileCache.delete(podUrl);
        registeredOk = true;
        await credentialWrite;
      } else if (me.encryptionPublicKey !== relayAgentKey.publicKey) {
        const updated = {
          ...profile,
          authorizedAgents: Object.freeze(
            profile.authorizedAgents.map(a =>
              a.agentId === agentId && !a.revoked
                ? { ...a, encryptionPublicKey: relayAgentKey.publicKey }
                : a,
            ),
          ),
        };
        await writeAgentRegistry(updated, podUrl, { fetch: solidFetch });
        relayProfileCache.delete(podUrl);
        registeredOk = true;
      } else {
        registeredOk = true;
      }
      if (registeredOk) {
        if (agentRegistrationCache.size >= AGENT_REGISTRATION_CACHE_MAX) {
          const oldestKey = agentRegistrationCache.keys().next().value;
          if (oldestKey !== undefined) agentRegistrationCache.delete(oldestKey);
        }
        agentRegistrationCache.set(agentRegCacheKey, {
          expiresAt: Date.now() + AGENT_REGISTRATION_CACHE_TTL_MS,
        });
      }
    } catch (err) {
      log(`WARN: could not ensure agent registration: ${(err as Error).message}`);
    }
  }

  const builder = ContextDescriptor.create(descId)
.describes((args.graph_iri as string) as IRI)
.temporal({ validFrom: (args.valid_from as string) ?? now, validUntil: args.valid_until as string })
.validFrom((args.valid_from as string) ?? now)
.delegatedBy(ownerWebId as IRI, agentId as IRI, {
      endedAt: now,
      derivedFrom: preprocessed.wasDerivedFrom.length > 0 ? preprocessed.wasDerivedFrom : undefined,
    })
.semiotic(preprocessed.semiotic)
.trust(await (async () => {
      // Trust label is only elevated to `CryptographicallyVerified` when
      // BOTH conditions hold:
      //   (a) the caller asked for a compliance-grade publish, AND
      //   (b) the agent's signed VC chain on the pod verifies end-to-end
      //       via verifyAgentDelegation(verifier: delegationVerifier).
      // Otherwise we fall back to SelfAsserted — the registry membership
      // check alone is not a cryptographic claim.
      const requestedCompliance = args.compliance === true;
      let chainVerified = false;
      if (requestedCompliance) {
        try {
          const verifyResult = await verifyAgentDelegation(
            agentId as IRI,
            podUrl,
            { fetch: solidFetch, verifier: delegationVerifier },
          );
          chainVerified = verifyResult.valid && verifyResult.trustLevel === 'CryptographicallyVerified';
          if (!chainVerified) {
            log(`WARN: compliance publish requested but VC chain did not verify for ${agentId}: ${verifyResult.reason ?? 'unknown reason'} — downgrading to SelfAsserted`);
          }
        } catch (err) {
          log(`WARN: compliance publish requested but VC verification threw for ${agentId}: ${(err as Error).message} — downgrading to SelfAsserted`);
        }
      }
      const baseTrust = {
        trustLevel: (chainVerified ? 'CryptographicallyVerified' : 'SelfAsserted') as 'CryptographicallyVerified' | 'SelfAsserted',
        issuer: ownerWebId as IRI,
      };
      if (!chainVerified) return baseTrust;
      // Pre-compute the sig URL so iep:proof can be embedded in the
      // Turtle BEFORE signing. Verifies against tampering: if anyone
      // edits iep:proof in transit the signature won't validate.
      const predicted = predictDescriptorUrl(podUrl, descId);
      const cw = await ensureRelayComplianceWallet();
      return {
        ...baseTrust,
        proof: {
          scheme: 'ECDSA-secp256k1',
          proofUrl: `${predicted}.sig.json` as IRI,
          signer: cw.wallet.address,
        },
      };
    })())
.federation({
      origin: podUrl as IRI,
      storageEndpoint: podUrl as IRI,
      syncProtocol: 'SolidNotifications',
    })
.version(1);
  if (args.valid_until) builder.validUntil(args.valid_until as string);
  // Thread cleartext-mirror relationships from content → descriptor,
  // unioned with any auto-detected prior versions for this graph_iri.
  // Keeps federation-queryable links out of the encrypted payload.
  const allSupersedes = [...new Set([...preprocessed.supersedes, ...priorVersions])];
  if (allSupersedes.length > 0) {
    builder.supersedes(...allSupersedes);
  }
  if (preprocessed.conformsTo.length > 0) {
    builder.conformsTo(...preprocessed.conformsTo);
  }

  const descriptor = builder.build();
  const validation = validate(descriptor);
  if (!validation.conforms) {
    return JSON.stringify({ error: validation.violations.map(v => v.message) });
  }

  // Agent registration + signed-VC minting was moved BEFORE the builder
  // so the trust facet's `verifyAgentDelegation` chain walk could find a
  // credential to verify. See the block immediately following the
  // privacy-screen + auto-supersede preprocessing above.

  // ── FIX 4: gates before the CSS write ───────────────────────
  //
  // Two sub-gates run BEFORE publish() touches the pod. Order matters:
  // conformance is the cheap local computation, scope walks the chain
  // (one CSS GET worst-case, cached), so we run conformance first to
  // fail fast on shape violations and skip the chain walk when the
  // payload was never going to be accepted anyway.
  // Caller-supplied shape IRIs (via the MCP `conforms_to_shapes` arg)
  // stack on top of any container-declared shapes the target pod carries.
  // Both sources are validated; either failing rejects with the same 422
  // envelope. Lets MCP clients enforce a per-publish shape contract
  // without needing the target pod's .well-known/container-shape to be
  // present (the test pod typically doesn't have one).
  const callerShapesRaw = args.conforms_to_shapes;
  const callerShapeIris: string[] = Array.isArray(callerShapesRaw)
    ? (callerShapesRaw as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const conformance = await runConformanceGate(
    podUrl,
    (args.graph_content as string) ?? '',
    callerShapeIris,
  );
  if (conformance.conforms === false) {
    return JSON.stringify({
      error: 'shape_violation',
      code: 422,
      shape: conformance.shape,
      violations: conformance.violations.map(r => ({
        focusNode: r.focusNode,
        path: r.path,
        value: r.value,
        constraint: r.constraintComponent,
        severity: r.severity,
        message: r.message,
      })),
    });
  }

  const scopeCheck = await runScopeGate(agentId, podUrl);
  if (scopeCheck.allowed === false) {
    return JSON.stringify({
      error: 'scope_violation',
      code: 403,
      scope: scopeCheck.scope,
      requiredScope: ['ReadWrite', 'PublishOnly'],
      reason: scopeCheck.reason,
    });
  }

  // ── Visibility branch ──────────────────────────────────────────
  //
  // `visibility` is the explicit audience-class knob. Before this knob
  // existed, every publish encrypted to whatever recipients the registry
  // surfaced (plus the author's session-agent key), which meant a
  // human-readable wiki-style note couldn't actually be written — a
  // public reader can't be a JOSE envelope recipient, so the payload
  // would always be opaque to them.
  //
  //   - 'public'  → no envelope, plaintext payload, ACL grants
  //                 acl:Read to acl:agentClass foaf:Agent on descriptor
  //                 + payload. share_with is ignored (a plaintext graph
  //                 has no per-recipient routing) and a warn is logged
  //                 if it was supplied.
  //   - 'private' → envelope, recipient set = author's session-agent
  //                 key ONLY. share_with is ignored + warn-logged for
  //                 the same reason `public` ignores it (the author
  //                 explicitly opted out of co-recipients).
  //   - 'shared'  → preserved historical behavior: union(registry agents,
  //                 author key, share_with-resolved keys).
  //
  // Default is 'shared' to keep callers that omit the param wire-compatible.
  const rawVisibility = args.visibility as string | undefined;
  const shareWith = (args.share_with as string[] | undefined) ?? [];
  const authorEncryptionKey = relayAgentKey.publicKey;
  const shareResolved: { handle: string; podUrl: string; agentCount: number }[] = [];

  // Pre-fetch the inputs the pure helper needs. Only do the registry read +
  // share_with resolution when visibility is (or defaults to) 'shared' —
  // computePublishRecipients ignores them for 'public'/'private' but
  // skipping the I/O saves a round-trip.
  const willShare = (rawVisibility === undefined || rawVisibility === 'shared');
  const currentProfile = willShare
    ? await getCachedRelayProfile(podUrl).catch(() => null)
    : null;
  const registryAgentKeys = (currentProfile?.authorizedAgents ?? [])
    .filter(a => !a.revoked && a.encryptionPublicKey)
    .map(a => a.encryptionPublicKey!) as string[];
  const resolvedShareTargets = (willShare && shareWith.length > 0)
    ? await resolveRecipients(shareWith, { fetch: solidFetch })
    : [];
  for (const r of resolvedShareTargets) {
    shareResolved.push({ handle: r.handle, podUrl: r.podUrl, agentCount: r.agentEncryptionKeys.length });
  }

  const computed = computePublishRecipients({
    rawVisibility,
    shareWith,
    authorEncryptionKey,
    authorAgentId: agentId,
    registryAgentKeys,
    resolvedShareTargets,
  });
  for (const w of computed.warnings) log(w);
  const visibility = computed.visibility;
  const recipients = computed.recipients;
  const recipientAgents = computed.recipientAgents;
  const selfIncluded = computed.selfIncluded;

  // relayBaseUrl is threaded in so encrypted publishes emit a SECOND
  // affordance — iep:renderView — pointing at this relay's
  // /render/<descriptorIri> endpoint. Thin clients (no X25519 keypair)
  // follow that affordance with a bearer token to get plaintext Turtle
  // server-side. Without a configured public base we omit the renderView
  // affordance (iep:canDecrypt remains the only path), so behavior is
  // unchanged for dev runs that don't set PUBLIC_BASE_URL.
  const publishRelayBase = (PUBLIC_BASE_URL || '').replace(/\/$/, '');

  // ── Authorship proof (opt-in, default false) ─────────────────
  //
  // `sign_authorship: true` mints a small ECDSA signature over the
  // canonical (agentId, ownerWebId, descriptorId, created, agentDid?)
  // tuple — the AgentFacet's identity claim, bound to THIS descriptor.
  // Embedded into the descriptor Turtle as `iep:authorshipProof [...]`
  // and verified on read from the descriptor ALONE (no pod-storage
  // trust). Default off preserves SelfAsserted neutrality for callers
  // that have not opted into agent-level signing.
  //
  // Independent of the compliance branch below:
  //   - iep:proof on TrustFacet (compliance branch): operator-grade
  //     signature over the WHOLE descriptor turtle, lands in
  //     <descriptor>.sig.json, opt-in via `compliance: true`.
  //   - iep:authorshipProof (this block): agent-grade signature over
  //     the AgentFacet payload, embedded INSIDE the descriptor turtle,
  //     opt-in via `sign_authorship: true`.
  // The two stack: a publish can carry both, neither, or either.
  const signAuthorship = args.sign_authorship === true;
  let authorshipProof: AuthorshipProof | undefined;
  let authorshipError: string | undefined;
  if (signAuthorship) {
    try {
      const signer = await getDelegationSigner();
      const agentDidArg = typeof args.agent_did === 'string' ? args.agent_did : undefined;
      authorshipProof = await createSignedAuthorship(
        {
          agentId: agentId as IRI,
          ownerWebId: ownerWebId as IRI,
          descriptorId: descriptor.id,
          created: now,
          ...(agentDidArg ? { agentDid: agentDidArg } : {}),
        },
        signer,
      );
    } catch (err) {
      authorshipError = (err as Error).message;
      log(`WARN: sign_authorship requested but signing failed for ${agentId}: ${authorshipError}`);
    }
  }

  // Thread the resolved (shapeIri, shapeTurtle) pairs from the
  // relay-level gate into the substrate-level publish() gate so the
  // SHACL invariant is enforced at both layers. The relay gate already
  // accepted the payload, so publish()'s conformsToShapes is here as
  // defense in depth (and gives the kernel-level PublishShapeViolationError
  // a single place to fire from, regardless of which entry point
  // triggered the publish).
  const resolvedShapesForPublish = conformance.conforms === true ? conformance.resolvedShapes : [];
  const conformsToShapesOpt = resolvedShapesForPublish.length > 0
    ? { conformsToShapes: resolvedShapesForPublish }
    : {};
  const publishOptions: Parameters<typeof publish>[3] = recipients.length > 0
    ? {
        fetch: solidFetch,
        encrypt: { recipients, senderKeyPair: relayAgentKey },
        visibility,
        ...(publishRelayBase ? { relayBaseUrl: publishRelayBase } : {}),
        ...(authorshipProof ? { authorshipProof } : {}),
        ...(ifMatchSupersedes ? { ifMatchSupersedes } : {}),
        ...(ifMatchCid ? { ifMatchCid } : {}),
        ...manifestHeadCidLookupOpt,
        ...conformsToShapesOpt,
      }
    : {
        fetch: solidFetch,
        visibility,
        ...(authorshipProof ? { authorshipProof } : {}),
        ...(ifMatchSupersedes ? { ifMatchSupersedes } : {}),
        ...(ifMatchCid ? { ifMatchCid } : {}),
        ...manifestHeadCidLookupOpt,
        ...conformsToShapesOpt,
      };
  // Per-pod mutex: serialize same-process publishers to this pod so the
  // read-check-write (auto-supersede manifest read above + substrate CAS
  // gate inside publish() + manifest CAS) is atomic from this relay's
  // perspective. Cross-process / cross-replica writers still hit the
  // CSS-side ETag CAS plus the supersedes substrate gate, which is the
  // cross-host portion of the precondition.
  //
  // ── Accept-then-publish (deferred) ──────────────────────────
  //
  // The dominant fixed cost in this handler is the chain of awaited CSS
  // round-trips inside publish(): graph PUT + descriptor PUT + manifest
  // CAS GET/PUT/verify GET, each wrapped in withTransientRetry. Even
  // with healthy hops that runs 5-9s — well above the MCP connector's
  // ~5s response budget. The pin defer (already shipped) covers IPFS
  // but the substrate-CSS chain is the rest of the dragon.
  //
  // We split on three signals:
  //   - args.compliance === true    — caller needs the signed-then-anchored
  //                                    chain to land synchronously; defer
  //                                    would break the compliance grade.
  //   - args.if_match !== undefined — caller is asserting a CAS precondition
  //                                    and needs the 412 path observable
  //                                    synchronously (deferred 412 is a
  //                                    silent precondition violation).
  //   - args.sync === true          — explicit opt-in to the old synchronous
  //                                    contract for callers that prefer hard
  //                                    confirmation over fast response.
  //
  // Otherwise we synthesize the predicted descriptorUrl / graphUrl /
  // manifestUrl (the publish() naming convention is deterministic from
  // pod + descriptorId + recipients), return a 202-shaped pending result
  // with the content-addressable CID, and run the substrate-CSS chain in
  // the background. Status is tracked in the in-process
  // `deferredPublishStatus` Map so callers (and tests) can poll commit
  // state without HEAD-spinning the descriptor URL — though HEAD-spinning
  // also works once the descriptor PUT lands. Public-ACL writes +
  // emitNotification fire AFTER the deferred publish resolves since they
  // both need a confirmed result.descriptorUrl/graphUrl.
  // CAS-split (Phase A / Phase B):
  //
  // The if_match branch used to be part of `syncRequired` so the relay
  // held the request thread for the full ~7-10s of CSS round-trips
  // (graph PUT + descriptor PUT + manifest CAS). The substrate gate
  // itself is the only part of that chain that has to be observable
  // synchronously — a deferred 412 would be a silent precondition
  // violation. So we now run the precondition check (Phase A) on the
  // request thread via the standalone checkSupersessionPrecondition
  // helper, and — on pass — defer the rest of the chain (Phase B) to
  // the background, just like the default async path. compliance:true
  // and sync:true STILL take the fully synchronous chain.
  const syncRequired =
    args.compliance === true ||
    args.sync === true;
  const willEncrypt = recipients.length > 0;
  const predictedDescriptorUrl = predictDescriptorUrl(podUrl, descriptor.id);
  const predictedGraphUrl = predictGraphUrl(podUrl, descriptor.id, { encrypted: willEncrypt });
  const predictedManifestUrl = predictManifestUrl(podUrl);

  // Phase A precondition pre-flight — only when if_match was supplied.
  // On pass we capture the resolved head identifiers so the deferred
  // 202 can echo previousHeadCid / previousHeadUrl synchronously
  // (unlike the default async path, which leaves them null because no
  // CAS read happened on the request thread).
  //
  // Manifest-CID fast-path: getCachedManifest is a single lightweight
  // GET on `.well-known/context-graphs` that already mirrors the head
  // CID into each entry's `iep:contentCid` triple (publish path always
  // writes it; legacy entries fall through to the body-fetch path
  // inside the substrate gate). Threading the cached entries' CIDs
  // through as `headCidLookup` removes 1xN descriptor body GETs from
  // Phase A — the exact flaky read johnny pinned as the 503
  // `precondition_unavailable` source on cold Azure-Files caches.
  let phaseAPass: Awaited<ReturnType<typeof checkSupersessionPrecondition>> | null = null;
  if (!syncRequired && ifMatch !== undefined) {
    try {
      phaseAPass = await checkSupersessionPrecondition({
        supersedesList: descriptor.supersedes ?? [],
        ...(ifMatchSupersedes ? { ifMatchSupersedes } : {}),
        ...(ifMatchCid ? { ifMatchCid } : {}),
        fetchFn: solidFetch,
        ...manifestHeadCidLookupOpt,
      });
    } catch (err) {
      if (err instanceof PublishPreconditionFailedError) {
        manifestCache.delete(podUrl);
        return JSON.stringify({
          error: 'precondition_failed',
          code: 412,
          message: err.message,
          expected: err.expected,
          currentHead: {
            descriptorUrl: err.actual.descriptorUrl,
            cid: err.actual.cid,
            supersedesList: err.actual.supersedesList,
          },
          retryHint: 'Re-read the manifest (or call get_current_head with the urn:graph IRI) and resend publish_context with the fresh if_match value.',
        });
      }
      // Non-412 (transient GET exhaustion, malformed turtle, etc.) —
      // surface as a retryable 503 so the caller can distinguish "your
      // assertion was wrong" from "we couldn't tell".
      const message = (err as Error).message;
      log(`[publish/phaseA] precondition check failed for ${descriptor.id}: ${message}`);
      return JSON.stringify({
        error: 'precondition_unavailable',
        code: 503,
        retryable: true,
        message,
      });
    }
  }

  let result: Awaited<ReturnType<typeof publish>>;
  let publishDeferred = false;
  if (syncRequired) {
    try {
      // Outer withPodMutex (Fix-1) already holds the per-pod gate, so
      // the inner mutex wrap is removed — it would deadlock.
      result = await publish(descriptor, args.graph_content as string, podUrl, publishOptions);
    } catch (err) {
      if (err instanceof PublishPreconditionFailedError) {
        // Surface the precondition-failed response as a tool result the
        // caller can act on (re-read, rebuild, retry). HTTP semantic is 412.
        manifestCache.delete(podUrl);
        return JSON.stringify({
          error: 'precondition_failed',
          code: 412,
          message: err.message,
          expected: err.expected,
          currentHead: {
            descriptorUrl: err.actual.descriptorUrl,
            cid: err.actual.cid,
            supersedesList: err.actual.supersedesList,
          },
          retryHint: 'Re-read the manifest (or call get_current_head with the urn:graph IRI) and resend publish_context with the fresh if_match value.',
        });
      }
      throw err;
    }
    manifestCache.delete(podUrl);

    // Append-only mirror (Fix-5, feature-flagged). Best-effort, fire-and-
    // forget — the monolithic manifest is still the authoritative store.
    // When this flag is on, each entry also lands at
    // <pod>/.well-known/cg-entries/<slug>.entry.ttl so unioned reads pick
    // it up even if a future monolithic update is racing.
    if (APPEND_ONLY_ENABLED) {
      const facetTypes = [...new Set(descriptor.facets.map(f => f.type))];
      const issuerFacet = descriptor.facets.find(f => f.type === 'Trust') as { type: 'Trust'; issuer?: string; trustLevel?: string } | undefined;
      const semioticFacet = descriptor.facets.find(f => f.type === 'Semiotic') as { type: 'Semiotic'; modalStatus?: string } | undefined;
      const entryTurtle = renderAppendOnlyEntry({
        descriptorUrl: result.descriptorUrl,
        graphIris: [...(descriptor.describes ?? [])] as string[],
        facetTypes,
        validFrom: descriptor.validFrom,
        validUntil: descriptor.validUntil,
        conformsTo: descriptor.conformsTo ? [...descriptor.conformsTo] as string[] : undefined,
        supersedes: descriptor.supersedes ? [...descriptor.supersedes] as string[] : undefined,
        modalStatus: semioticFacet?.modalStatus,
        trustLevel: issuerFacet?.trustLevel,
        issuer: issuerFacet?.issuer,
      });
      writeAppendOnlyEntryAsync(podUrl, result.descriptorUrl, entryTurtle);
    }

    // For 'public' visibility, write per-resource .acl entries that
    // explicitly grant acl:Read to acl:agentClass foaf:Agent on the
    // descriptor + payload. The /context-graphs/ container ACL already
    // inherits anonymous Read, but pinning the policy on the leaf
    // resources keeps the publish self-contained and survives any
    // future tightening of the parent ACL. Best-effort: log + continue
    // on failure (the parent ACL still applies).
    if (visibility === 'public') {
      const aclResults = await Promise.allSettled([
        writePublicReadAcl(result.descriptorUrl, ownerWebId as IRI),
        writePublicReadAcl(result.graphUrl, ownerWebId as IRI),
      ]);
      const aclLabels = ['descriptor', 'payload'] as const;
      aclResults.forEach((settled, idx) => {
        if (settled.status === 'rejected') {
          log(`[publish/public] warn: ${aclLabels[idx]} .acl PUT failed: ${(settled.reason as Error).message}`);
        }
      });
    }
  } else {
    // Deferred path. Construct a predicted-shape PublishResult so the
    // synchronous response carries the URLs the substrate is committed
    // to writing — the slug + container naming is deterministic from
    // (podUrl, descriptor.id, recipients>0). previousHead* are left null
    // unless Phase A ran an if_match precondition above — in which case
    // we carry the resolved head identifiers through synchronously, so
    // the 202 response is observably stronger than the default async
    // path (the precondition was definitively checked).
    publishDeferred = true;
    result = {
      descriptorUrl: predictedDescriptorUrl,
      graphUrl: predictedGraphUrl,
      manifestUrl: predictedManifestUrl,
      encrypted: willEncrypt,
      previousHeadCid: phaseAPass?.resolvedHeadCid ?? null,
      previousHeadUrl: phaseAPass?.resolvedHeadUrl ?? null,
    } as Awaited<ReturnType<typeof publish>>;
    setDeferredPublishStatus(predictedDescriptorUrl, {
      kind: 'pending',
      startedAt: Date.now(),
    });
    void (async () => {
      const startedAt = Date.now();
      try {
        // Append-only mirror (Fix-5, deferred path). Fired BEFORE
        // publish() on purpose: the failure mode this path heals is
        // "graph + descriptor PUTs landed but the monolithic manifest
        // CAS failed" — if we waited for publish() to resolve, the
        // entry would be skipped in exactly the case it's needed.
        // The descriptor URL is deterministic (predictDescriptorUrl),
        // so the entry is correct even written ahead of the commit.
        // Worst case (descriptor PUT itself fails) leaves a dangling
        // entry pointing at a 404 — readers dereferencing it skip it.
        if (APPEND_ONLY_ENABLED) {
          const facetTypes = [...new Set(descriptor.facets.map(f => f.type))];
          const issuerFacet = descriptor.facets.find(f => f.type === 'Trust') as { type: 'Trust'; issuer?: string; trustLevel?: string } | undefined;
          const semioticFacet = descriptor.facets.find(f => f.type === 'Semiotic') as { type: 'Semiotic'; modalStatus?: string } | undefined;
          const entryTurtle = renderAppendOnlyEntry({
            descriptorUrl: predictedDescriptorUrl,
            graphIris: [...(descriptor.describes ?? [])] as string[],
            facetTypes,
            validFrom: descriptor.validFrom,
            validUntil: descriptor.validUntil,
            conformsTo: descriptor.conformsTo ? [...descriptor.conformsTo] as string[] : undefined,
            supersedes: descriptor.supersedes ? [...descriptor.supersedes] as string[] : undefined,
            modalStatus: semioticFacet?.modalStatus,
            trustLevel: issuerFacet?.trustLevel,
            issuer: issuerFacet?.issuer,
          });
          writeAppendOnlyEntryAsync(podUrl, predictedDescriptorUrl, entryTurtle);
        }
        const real = await withPodMutex(podUrl, () =>
          publish(descriptor, args.graph_content as string, podUrl, publishOptions),
        );
        manifestCache.delete(podUrl);
        if (visibility === 'public') {
          const aclResults = await Promise.allSettled([
            writePublicReadAcl(real.descriptorUrl, ownerWebId as IRI),
            writePublicReadAcl(real.graphUrl, ownerWebId as IRI),
          ]);
          const aclLabels = ['descriptor', 'payload'] as const;
          aclResults.forEach((settled, idx) => {
            if (settled.status === 'rejected') {
              log(`[publish/public/deferred] warn: ${aclLabels[idx]} .acl PUT failed: ${(settled.reason as Error).message}`);
            }
          });
        }
        // SolidNotifications fan-out — must run AFTER the descriptor +
        // graph land on the pod so subscribers reading the notification
        // can dereference the URLs immediately.
        emitNotification(podUrl, {
          eventType: priorVersions.length > 0 ? 'superseded' : 'created',
          descriptorUrl: real.descriptorUrl,
          graphUrl: real.graphUrl,
          author: agentId,
        });
        setDeferredPublishStatus(predictedDescriptorUrl, {
          kind: 'committed',
          startedAt,
          resolvedAt: Date.now(),
          descriptorUrl: real.descriptorUrl,
          graphUrl: real.graphUrl,
        });
      } catch (err) {
        const message = (err as Error).message;
        log(`[publish/deferred] failed for ${descriptor.id}: ${message}`);
        setDeferredPublishStatus(predictedDescriptorUrl, {
          kind: 'failed',
          startedAt,
          resolvedAt: Date.now(),
          error: message,
        });
      }
    })();
  }

  // Pin to IPFS if configured (org-level or user override).
  //
  // Honesty about what the CID addresses + whether it's actually pinned:
  //   - `addresses`: 'ciphertext' when the graph payload was encrypted
  //     (we hash the JOSE envelope's Turtle — what's actually public on
  //     the pod), 'plaintext' when no recipients were configured. The
  //     descriptor turtle itself is always the cleartext index; what
  //     varies is the payload it links to. We CID the descriptor here,
  //     so `addresses` reports the descriptor's payload class.
  //   - `warning`: present iff provider is 'local-unpinned' so consumers
  //     don't mistake a content-addressed-but-not-uploaded CID for a
  //     successful pin to a public gateway.
  const ipfsConfig = resolveIpfsConfig(args._req ?? {});
  const turtle = toTurtle(descriptor);
  const addresses: 'ciphertext' | 'plaintext' = (result.encrypted ?? false) ? 'ciphertext' : 'plaintext';
  let ipfs: {
    cid?: string;
    url?: string;
    provider?: string;
    addresses?: 'ciphertext' | 'plaintext';
    warning?: string;
  } = {};
  if (ipfsConfig.provider !== 'local-unpinned' && ipfsConfig.apiKey) {
    // Defer the external HTTPS pin upload to a background task so the
    // publish_context response isn't blocked on a 500-3000ms (cold-DNS /
    // large-payload outliers up to 10s+) round-trip to Pinata/Web3Storage.
    // The CID is content-addressed so the value returned now is the same
    // value the pin will carry. Mirrors the IPFS-pin defer in
    // mcp-server/server.ts.
    const cid = cryptoComputeCid(turtle);
    ipfs = {
      cid,
      url: `ipfs://${cid}`,
      provider: 'pending',
      addresses,
    };
    void pinToIpfs(turtle, `descriptor-${descriptor.id}`, ipfsConfig, solidFetch)
      .then(r => log(`IPFS pin completed for ${descriptor.id}: ${r.cid} via ${r.provider}`))
      .catch(err => log(`IPFS pin failed for ${descriptor.id}: ${(err as Error).message}`));
  } else {
    // No pinning provider configured: compute the CID locally so the
    // descriptor still has a content-address, but report `local-unpinned`
    // and carry a warning so the caller knows it's NOT on a public gateway.
    const cid = cryptoComputeCid(turtle);
    ipfs = {
      cid,
      url: `ipfs://${cid}`,
      provider: 'local-unpinned',
      addresses,
      warning: '[ipfs] no PINATA_API_KEY / WEB3STORAGE_TOKEN — content is NOT on a public gateway; CID is local-only',
    };
  }

  // Auto-publish pod directory on first write. A pod holding content
  // but no directory at /.well-known/context-graphs-directory cannot be
  // discovered by federation clients that traverse directories (see
  // spec/LAYERS.md L2 federation patterns). Previously operators had
  // to remember to call publish_directory manually. Now it's asserted
  // inline — idempotent, best-effort, non-fatal so the publish itself
  // isn't blocked by directory plumbing.
  void ensurePodDirectory(podUrl, ownerWebId).catch((err) =>
    log(`ensurePodDirectory failed for ${podUrl}: ${(err as Error).message}`),
  );

  // SolidNotifications fan-out — honors the syncProtocol contract
  // declared in the descriptor's FederationFacet. Emits a JSON-LD
  // NotificationEvent to every SSE subscriber + webhook for this pod
  // AND mirrors it into the legacy notificationLog for the /sse
  // polling transport. This is the producer side; the consumer side
  // is GET /notifications/:podSlug (text/event-stream). Done before
  // the JSON return so observable causality matches the response.
  //
  // Skipped on the deferred path — the background task emits the
  // notification once the descriptor + graph have actually landed on
  // the pod, so subscribers don't receive a notification pointing at
  // a URL that hasn't been written yet.
  if (!publishDeferred) {
    emitNotification(podUrl, {
      eventType: priorVersions.length > 0 ? 'superseded' : 'created',
      descriptorUrl: result.descriptorUrl,
      graphUrl: result.graphUrl,
      author: agentId,
    });
  }

  return JSON.stringify({
    published: true,
    // 'pending' on the accept-then-publish path (the substrate-CSS chain
    // is running in the background; HEAD the descriptorUrl until 200 OR
    // call /publish/status with the descriptorUrl for a definitive read).
    // 'committed' on the synchronous path (compliance / if_match / sync).
    status: publishDeferred ? 'pending' : 'committed',
    // When pending, the descriptor URL doubles as a poll target —
    // HEAD it until 200 to confirm the publish landed.
    ...(publishDeferred ? { pollUrl: result.descriptorUrl } : {}),
    // When the CAS-split Phase A ran an if_match precondition before
    // deferring, echo the observed-vs-expected CIDs so the caller can
    // confirm the gate fired synchronously (vs. silently skipped). The
    // pollUrl is a hint; /publish/status is authoritative for the
    // commit outcome, including the case where Phase B fails AFTER
    // Phase A passed (descriptor / graph may have landed but manifest
    // CAS gave up — the pollUrl can return 200 while status is failed).
    ...(phaseAPass !== null
      ? {
          precondition: {
            passed: true,
            observedCid: phaseAPass.resolvedHeadCid,
            expectedCid: ifMatchCid ?? phaseAPass.resolvedHeadCid,
            ...(ifMatchSupersedes ? { observedUrl: phaseAPass.resolvedHeadUrl, expectedUrl: ifMatchSupersedes } : {}),
          },
        }
      : {}),
    owner: ownerWebId,
    agent: agentId,
    pod: podUrl,
    descriptorUrl: result.descriptorUrl,
    graphUrl: result.graphUrl,
    encrypted: result.encrypted ?? false,
    // The note's DEREFERENCEABLE HTTPS identity + how to view it as a complete
    // HyperMarkdown document (prose + fields + describedby/alternate links +
    // its controls), rendered/decrypted server-side. Prefer this URL over the
    // urn:graph logical id when showing the note — everything is a URL, and a
    // urn is not fetchable. Encrypted notes decrypt for the authorized bearer;
    // request it as text/markdown.
    ...(publishRelayBase
      ? {
          view: {
            url: `${publishRelayBase}/render/${encodeURIComponent(result.descriptorUrl)}`,
            mediaType: HYPERMEDIA_MARKDOWN_MEDIA_TYPE,
            howTo: (result.encrypted ?? false)
              ? 'GET this URL with your bearer + `Accept: text/markdown` for the complete, decrypted HyperMarkdown view (this is the note\'s dereferenceable identity — use it, not the urn:graph).'
              : 'Public note: GET the descriptorUrl (or resolve_linked_data) for its representations.',
          },
        }
      : {}),
    // Audience-class echoed back so callers can confirm the branch
    // taken (default 'shared' is the back-compat path).
    visibility,
    recipients: recipients.length,
    // Agent-IRI-level view of who can decrypt this envelope. `recipients`
    // (count) was misleading when multiple surface-agents share the relay's
    // single X25519 keypair (they dedup to one key). `recipientAgents`
    // reports identities, and `selfIncluded` confirms the author can
    // self-decrypt — both essential for the share_with author-inclusion
    // invariant. See fix `share-with-author`.
    recipientAgents,
    selfIncluded,
    sharedWith: shareResolved.length > 0 ? shareResolved : undefined,
    manifestUrl: result.manifestUrl,
    ipfs,
    supersedesPriorVersions: priorVersions.length > 0 ? priorVersions : undefined,
    // CAS chain head — content-CID + URL of the prior head this publish
    // was gated against (or, if no precondition was supplied, an
    // observational read of the first supersedes target). Pass back as
    // `if_match` on the next publish_context to detect concurrent writers
    // — see fix CAS-supersession.
    previousHeadCid: result.previousHeadCid,
    previousHeadUrl: result.previousHeadUrl,
    // SolidNotifications channel — the relay-hosted SSE endpoint that
    // delivers iep:Notification events for this pod. Consumers can
    // `EventSource(notifications.sse_url)` to receive every subsequent
    // create/update/supersede event without polling. Honors the
    // syncProtocol contract declared on the descriptor's FederationFacet.
    notifications: {
      sse_url: `${(PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '')}/notifications/${podSlug(podUrl)}`,
      pod_slug: podSlug(podUrl),
    },
    // Privacy-hygiene preflight (see docs://interego/playbook §2). Empty
    // string means no flags. The calling agent — and any LLM in the
    // loop — should surface the warning to the user before treating the
    // publish as final.
    sensitivityPreflight: sensitivityWarning || undefined,
    // Agent-level authorship-signing report (when args.sign_authorship
    // === true). The signed proof block is embedded directly in the
    // descriptor turtle (iep:authorshipProof [...]); this object echoes
    // back what was signed for downstream callers + audit. Verifiers
    // re-derive the canonical payload from the descriptor turtle and
    // run delegationVerifier on dereference — see handleGetDescriptor.
    ...(signAuthorship
      ? {
          authorship: authorshipProof
            ? {
                signed: true,
                signer: authorshipProof.issuer,
                verificationMethod: authorshipProof.verificationMethod,
                signerAddress: authorshipProof.signerAddress,
                created: authorshipProof.created,
                scheme: authorshipProof.scheme,
              }
            : {
                signed: false,
                reason: authorshipError ?? 'unknown signing failure',
              },
        }
      : {}),
    // Compliance-grade fields (when args.compliance === true): sign
    // the descriptor turtle with the relay's ECDSA wallet, write a
    // sibling .sig.json to the pod, and return the check report.
    //
    // The GET-then-sign-then-PUT-then-IPFS-pin chain (~2 CSS round-trips
    // + an external HTTPS upload) is deferred to a background task so
    // the publish_context response is not blocked. The signature URL is
    // content-addressed (`${descriptorUrl}.sig.json`) so it can be
    // returned synchronously; callers that need the signature itself
    // poll the URL. Mirrors the IPFS-pin defer in mcp-server/server.ts.
    ...(args.compliance === true
      ? (() => {
          const sigUrl = `${result.descriptorUrl}.sig.json`;
          const check = checkComplianceInputs({
            modalStatus: preprocessed.semiotic.modalStatus,
            trustLevel: 'CryptographicallyVerified',
            hasSignature: true,
            framework: args.compliance_framework as ComplianceFramework | undefined,
          });
          void (async () => {
            try {
              const cw = await ensureRelayComplianceWallet();
              const out = await fetchAndSignCanonicalTurtle(
                result.descriptorUrl,
                descriptor.id,
                cw.wallet,
                solidFetch,
              );
              const sigBody = JSON.stringify(out.signed, null, 2);
              const sigResp = await solidFetch(sigUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: sigBody,
              });
              if (!sigResp.ok) {
                log(`compliance sign pod write failed for ${descriptor.id}: ${sigResp.status}`);
                return;
              }
              const sigIpfsConfig = resolveIpfsConfig(args._req ?? {});
              if (sigIpfsConfig.provider !== 'local-unpinned' && sigIpfsConfig.apiKey) {
                // Fire-and-forget the compliance-signature pin so the
                // background compliance-sign chain doesn't serialize on
                // Pinata. Matches the main descriptor-pin pattern at
                // ~L2210 (void pinToIpfs(...).then(...).catch(...)).
                void pinToIpfs(sigBody, `signature-${descriptor.id}`, sigIpfsConfig, solidFetch)
                  .catch(err => log(`compliance signature pin failed for ${descriptor.id}: ${(err as Error).message}`));
              }
            } catch (err) {
              log(`compliance sign chain failed for ${descriptor.id}: ${(err as Error).message}`);
            }
          })();
          return {
            complianceCheck: check,
            signature: { url: sigUrl, status: 'pending' as const },
          };
        })()
      : {}),
  });
  }); // end of withPodMutex wrap (Fix-1: per-pod serialization)
}

/**
 * Ensure the pod has a discoverable directory at
 * /.well-known/context-graphs-directory. Idempotent + best-effort — if
 * the directory already exists or the call fails, the caller's publish
 * is not blocked. Federation clients use the directory to enumerate a
 * pod's context graphs without having to scan LDP containers.
 */
// In-process memo of pods whose directory we've already verified this
// process lifetime. Without this every publish_context re-fires the
// fetchPodDirectory GET round-trip against the pod (~hundreds of ms on
// Azure CSS) just to confirm idempotency. Mirrors the bootstrappedPods
// pattern: populated only on success so transient failures retry.
const podDirectoryEnsured = new Set<string>();

async function ensurePodDirectory(podUrl: string, ownerWebId: string): Promise<void> {
  if (podDirectoryEnsured.has(podUrl)) return;
  const directoryUrl = `${podUrl}.well-known/context-graphs-directory`;
  try {
    const existing = await fetchPodDirectory(directoryUrl, { fetch: solidFetch }).catch(() => null);
    if (existing) {
      podDirectoryEnsured.add(podUrl);
      return; // already published
    }
    await publishPodDirectory(
      { id: directoryUrl as IRI, entries: [] },
      podUrl,
      { fetch: solidFetch },
    );
    podDirectoryEnsured.add(podUrl);
  } catch (err) {
    console.warn(`[relay] ensurePodDirectory(${podUrl}) failed: ${(err as Error).message}`);
  }
}

// ── Tier-1 dogfood: substrate-native trajectory recording ─────
//
// `record_trajectory_step` is the smallest possible MCP surface for an
// agent to record what it just did, as a first-class signed
// ContextDescriptor on the agent's own pod. The descriptor uses
// substrate-native facets (Temporal, Provenance, Agent, Semiotic) so
// any reader can discover, verify, and reason about the step without
// importing a vertical.
//
// Why this lives in the relay (not Foxxi): the trajectory record
// itself is substrate (signed, content-addressed, supersedes-chained).
// The L&D interpretation (verifyCapabilityTransfer, OutcomeRecord,
// calibration) is Foxxi and reads these descriptors from the pod via
// discover_context (the rev-192 `graph_iri` filter is exactly what
// makes the read efficient).
//
// Steps describe a stable per-agent graph IRI
// `urn:graph:trajectory:<agentSlug>` so an agent's whole trajectory is
// discoverable with one filtered call. Each step is its own descriptor
// with the verb + objectName the verify path needs, plus modal status
// (so an agent can record a Hypothetical "I'm about to X" and later
// supersede with an Asserted "I did X").
async function handleRecordTrajectoryStep(args: ToolArgs): Promise<string> {
  const verb = typeof args.verb === 'string' ? args.verb.trim() : '';
  const objectName = typeof args.object_name === 'string' ? args.object_name.trim() : '';
  if (!verb || !objectName) {
    return JSON.stringify({ error: 'record_trajectory_step: `verb` and `object_name` are both required (load-bearing for verifyCapabilityTransfer signal matching).' });
  }
  const modalStatus = typeof args.modal_status === 'string'
    && ['Asserted', 'Hypothetical', 'Counterfactual'].includes(args.modal_status as string)
    ? (args.modal_status as 'Asserted' | 'Hypothetical' | 'Counterfactual')
    : 'Asserted';
  const granularity = typeof args.granularity === 'string'
    && ['task', 'subtask', 'tool-call'].includes(args.granularity as string)
    ? (args.granularity as string)
    : 'tool-call';
  const agentId = (args.agent_id as string) ?? 'urn:agent:remote:unknown';
  const ownerWebId = (args.owner_webid as string) ?? '';
  const agentSlug = (agentId.match(/[^:/#]+$/)?.[0] ?? 'unknown').toLowerCase();
  const sessionId = typeof args.session_id === 'string' && args.session_id.length > 0
    ? args.session_id
    : `default-${new Date().toISOString().slice(0, 10)}`;
  const graphIri = `urn:graph:trajectory:${agentSlug}`;
  const stepId = `urn:iep:trajectory-step:${agentSlug}:${Date.now()}`;
  // Inline turtle for the step's graph payload. Facets are emitted on
  // the publish_context side; this is the substantive content the
  // verifier reads.
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const parentLine = typeof args.parent_step_id === 'string' && args.parent_step_id
    ? `    traj:parentStep <${args.parent_step_id}> ;\n`
    : '';
  const supersedesLine = typeof args.supersedes_step_id === 'string' && args.supersedes_step_id
    ? `    iep:supersedes <${args.supersedes_step_id}> ;\n`
    : '';
  const derivedLines = Array.isArray(args.was_derived_from)
    ? (args.was_derived_from as unknown[])
        .filter((u): u is string => typeof u === 'string')
        .map(u => `    prov:wasDerivedFrom <${u}> ;\n`)
        .join('')
    : '';
  const resultBlock = (() => {
    const success = typeof args.result_success === 'boolean' ? args.result_success : undefined;
    const quality = typeof args.result_quality === 'number' ? args.result_quality : undefined;
    const note = typeof args.result_note === 'string' ? args.result_note : undefined;
    if (success === undefined && quality === undefined && note === undefined) return '';
    const inner: string[] = [];
    if (success !== undefined) inner.push(`        traj:resultSuccess ${success ? 'true' : 'false'}`);
    if (quality !== undefined) inner.push(`        traj:resultQuality "${quality}"^^xsd:double`);
    if (note !== undefined) inner.push(`        traj:resultNote "${escape(note)}"`);
    return `    traj:result [\n${inner.join(' ;\n')}\n    ] ;\n`;
  })();
  const graphContent = `@prefix traj: <urn:iep:ns:trajectory:> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${stepId}>
    a traj:Step ;
    traj:trajectory <${graphIri}> ;
    traj:session "${escape(sessionId)}" ;
    traj:verb "${escape(verb)}" ;
    traj:objectName "${escape(objectName)}" ;
    traj:granularity "${granularity}" ;
${parentLine}${supersedesLine}${derivedLines}${resultBlock}    prov:wasAttributedTo <${agentId}> ;
    iep:modalStatus iep:${modalStatus} .
`;

  // Defaults that match the trajectory recording's intent:
  //   - sign_authorship default true: trajectories are evidence,
  //     readers need to verify they came from the claimed agent
  //   - auto_supersede_prior false: each step is its own descriptor,
  //     not a replacement for prior steps describing the same urn
  //   - visibility 'public': trajectory steps are public by default
  //     (a private trajectory is opt-in via the arg below)
  const publishArgs: ToolArgs = {
    graph_iri: graphIri,
    graph_content: graphContent,
    descriptor_id: stepId,
    agent_id: agentId,
    ...(ownerWebId ? { owner_webid: ownerWebId } : {}),
    sign_authorship: args.sign_authorship !== false,
    auto_supersede_prior: false,
    visibility: typeof args.visibility === 'string' ? args.visibility : 'public',
    modal_status: modalStatus,
  };
  // Pass through the auth-context injectors if present (the relay's
  // /mcp dispatcher injects these; tests may not).
  if (typeof args._identity_token === 'string') publishArgs._identity_token = args._identity_token;
  if (typeof args._session_agent_did === 'string') publishArgs._session_agent_did = args._session_agent_did;
  if (typeof args._session_agent_id === 'string') publishArgs._session_agent_id = args._session_agent_id;
  if (typeof args.pod_name === 'string') publishArgs.pod_name = args.pod_name;

  const publishResultJson = await handlePublishContext(publishArgs);
  let publishResult: Record<string, unknown> = {};
  try { publishResult = JSON.parse(publishResultJson); } catch { /* keep raw */ }
  return JSON.stringify({
    recorded: !publishResult.error,
    stepId,
    trajectoryGraphIri: graphIri,
    sessionId,
    verb,
    objectName,
    granularity,
    modalStatus,
    publish: publishResult,
  });
}

// ── Tier-2 dogfood: substrate-native OODA decide tool ─────────
//
// Surfaces packages/pgsl/src/decision-functor.ts (the OODA functor
// already living in the codebase but never wired to an MCP tool).
// The functor takes the agent's PGSL lattice view + optional
// coherence certificates and returns a strategy:
//
//   'exploit'  — high coherence (>0.7) with another agent: act on
//                shared knowledge
//   'explore'  — no coherence data OR low coherence (<0.3) with
//                everyone: gather more observations first
//   'delegate' — medium coherence (0.3–0.7) AND another agent has
//                higher overlap: delegate to them
//   'abstain'  — no observations or no affordances: cannot decide
//
// The substrate-honest framing of "I write loops" (Cherny): an
// agent inside a persistent loop calls this on every tick to get
// the next OODA decision rather than reasoning from scratch.
async function handlePgslDecide(args: ToolArgs): Promise<string> {
  try {
    const agentId = typeof args.agent_id === 'string' && args.agent_id.length > 0
      ? args.agent_id
      : 'urn:agent:remote:unknown';
    // The decision functor operates over the kernel's PGSL singleton —
    // the same lattice pgsl_ingest writes to, so observations reflect
    // anything the agent (or its session) has previously ingested.
    const { decide } = await import('@interego/pgsl');
    const pgsl = getKernelPGSL(pgslProvenance);
    // Caller can optionally pre-supply coherence certificates from
    // pgsl_meet calls; default to empty (functor will return 'explore'
    // when no coherence data exists, which IS the right move).
    const certificates = Array.isArray(args.certificates)
      ? (args.certificates as unknown[]).filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null) as never
      : [];
    const result = decide(pgsl, agentId, certificates);
    return JSON.stringify({
      agent: agentId,
      strategy: result.strategy,
      decisionCount: result.decisions.length,
      topDecision: result.decisions[0] ?? null,
      coverage: result.coverage,
      ungroundedObservations: result.ungroundedObservations,
      note: 'OODA decision functor — Observe (presheaf section) + Orient (coherence) + Decide (this strategy) + Act (follow the top decision\'s affordance via the act / invoke_affordance / publish_context tools). Returns "abstain" when there are no atoms ingested or no affordances available — pgsl_ingest something first.',
    });
  } catch (err) {
    return JSON.stringify({
      error: 'pgsl_decide: decision functor threw',
      message: (err as Error).message,
    });
  }
}

async function handleDiscoverContext(args: ToolArgs): Promise<string> {
  const podUrl = args.pod_url as string;
  const filter: DiscoverFilterLite = {};
  if (args.facet_type)   filter.facetType   = args.facet_type as string;
  if (args.valid_from)   filter.validFrom   = args.valid_from as string;
  if (args.valid_until)  filter.validUntil  = args.valid_until as string;
  if (args.effective_at) filter.effectiveAt = args.effective_at as string;
  if (args.graph_iri)    filter.graphIri    = args.graph_iri as string;
  if (args.sort)         filter.sort        = args.sort as 'newest-first' | 'oldest-first' | 'unsorted';
  if (typeof args.limit === 'number' && args.limit >= 0) filter.limit = args.limit;

  // Route through the cached + indexed path (Fix-4 inner). The cache
  // is invalidated on publish_context locally (manifestCache.delete),
  // so reads within ~10s of a write see the write. Other callers see
  // up-to-10s-old entries — acceptable for discover semantics.
  const [entries, delegationProfile] = await Promise.all([
    discoverCached(podUrl, filter),
    args.verify_delegation
      ? getCachedRelayProfile(podUrl)
      : Promise.resolve(null),
  ]);

  // Optionally include registry info
  let registry = null;
  if (args.verify_delegation) {
    const profile = delegationProfile;
    if (profile) {
      registry = {
        owner: profile.webId,
        name: profile.name,
        agents: profile.authorizedAgents.filter(a => !a.revoked).map(a => ({
          id: a.agentId, scope: a.scope, label: a.label,
        })),
      };
    }
  }

  return JSON.stringify({ entries, registry });
}

async function handleGetDescriptor(args: ToolArgs): Promise<string> {
  // Translate legacy public-host CSS URLs at the handler boundary so the
  // distribution-link parsing / response-body URLs see the canonical
  // internal-FQDN target. solidFetch ALSO rewrites at the HTTP layer.
  const url = normalizeCssUrl(args.url as string);
  // Route envelope / TriG URLs through fetchGraphContent so encrypted
  // payloads are transparently decrypted for this relay's agent key (the
  // recipients registered on the pod include us when we published, so
  // round-tripping is seamless).
  if (url.endsWith('.envelope.jose.json') || url.endsWith('.trig')) {
    // Cache plaintext envelopes only — encrypted ones depend on the
    // recipient key, and we don't want to leak cross-recipient.
    const cached = !args.bypass_cache ? descriptorBodyCache.get(url) : undefined;
    if (cached && cached.expiresAt > Date.now() && !cached.encrypted) {
      return JSON.stringify({ url, encrypted: false, mediaType: cached.mediaType, content: cached.content });
    }
    const { content, encrypted, mediaType } = await fetchGraphContent(url, {
      fetch: solidFetch,
      recipientKeyPair: relayAgentKey,
    });
    if (content === null && encrypted) {
      return JSON.stringify({
        url,
        encrypted: true,
        error: 'Relay agent key is not a recipient of this envelope; cannot decrypt.',
      });
    }
    if (!encrypted && content !== null) {
      cacheDescriptorBody(url, { content, mediaType, encrypted: false });
    }
    return JSON.stringify({ url, encrypted, mediaType, content });
  }

  // Descriptor turtle is immutable (content-addressed) so cache it with
  // a long TTL keyed by URL only.
  const cached = !args.bypass_cache ? descriptorBodyCache.get(url) : undefined;
  let turtle: string;
  if (cached && cached.expiresAt > Date.now() && !cached.encrypted) {
    turtle = cached.content;
  } else {
    const resp = await solidFetch(url, {
      method: 'GET',
      headers: { 'Accept': 'text/turtle' },
    });
    if (!resp.ok) {
      return JSON.stringify({ error: `${resp.status} ${resp.statusText}` });
    }
    turtle = await resp.text();
    cacheDescriptorBody(url, { content: turtle, mediaType: 'text/turtle', encrypted: false });
  }

  // Hypermedia follow-your-nose: the descriptor Turtle includes
  // iep:hasDistribution [ dcat:accessURL <...> ; dcat:mediaType "..." ;
  // iep:encrypted <bool> ; ... ]. We parse that instead of reconstructing
  // the URL by naming convention, so clients and this handler alike
  // stay decoupled from the relay's internal filename scheme. Matches
  // the REST / HATEOAS / DCAT / Hydra principles the project builds on.
  let graph: { url: string; mediaType: string; encrypted: boolean; content: string | null } | undefined;
  const link = parseDistributionFromDescriptorTurtle(turtle);
  if (link) {
    try {
      const { content, encrypted } = await fetchGraphContent(link.accessURL, {
        fetch: solidFetch,
        recipientKeyPair: relayAgentKey,
      });
      graph = { url: link.accessURL, mediaType: link.mediaType, encrypted, content };
    } catch { /* link present but fetch/decrypt failed; return descriptor only */ }
  }

  // ── Authorship verification (automatic, not opt-in) ──────────
  //
  // When the descriptor embeds `iep:authorshipProof [...]`, re-derive
  // the canonical payload and run delegationVerifier against the
  // descriptor turtle ALONE. Verifiers do not need to trust the pod's
  // storage layer — the verification method (did:ethr:<addr>) lets us
  // recover the public key, and any tampering with the signed payload
  // invalidates the signature.
  //
  // Trust-label upgrade per substrate semantics: when authorship
  // verifies AND the agent's delegation chain verifies on the owner's
  // pod, the EFFECTIVE trust is CryptographicallyVerified — even if
  // the descriptor body ships TrustFacet.trustLevel = SelfAsserted.
  // Substrate-derived trust is what counts, not the declared body.
  //
  // Failure surfaces as `{ authorshipVerified: false, reason }` so
  // callers see the diagnostic; we never reject the read because of a
  // bad authorship proof — that's the caller's policy decision.
  let authorship: {
    authorshipVerified: boolean;
    signedBy?: IRI;
    verificationMethod?: IRI;
    effectiveTrustLevel?: 'CryptographicallyVerified' | 'SelfAsserted';
    reason?: string;
  } | undefined;
  const parsedProof = parseAuthorshipProofFromDescriptorTurtle(turtle);
  if (parsedProof) {
    try {
      const verifyResult = await verifySignedAuthorship(parsedProof, delegationVerifier);
      if (verifyResult.valid) {
        let effective: 'CryptographicallyVerified' | 'SelfAsserted' = 'SelfAsserted';
        try {
          // Find the pod URL for this descriptor — strip back to the
          // container so the chain walk knows where the agent registry
          // and credentials live. Pattern matches the publish-side
          // `${pod}context-graphs/...` layout produced by `publish()`.
          const m = url.match(/^(https?:\/\/[^/]+\/[^/]+\/)context-graphs\//);
          const inferredPodUrl = m ? m[1]! : undefined;
          if (inferredPodUrl) {
            const chainResult = await verifyAgentDelegation(
              parsedProof.issuer,
              inferredPodUrl,
              { fetch: solidFetch, verifier: delegationVerifier },
            );
            if (chainResult.valid && chainResult.trustLevel === 'CryptographicallyVerified') {
              effective = 'CryptographicallyVerified';
            }
          }
        } catch { /* chain-walk best-effort; fall back to SelfAsserted */ }
        authorship = {
          authorshipVerified: true,
          signedBy: parsedProof.issuer,
          verificationMethod: parsedProof.verificationMethod,
          effectiveTrustLevel: effective,
        };
      } else {
        authorship = {
          authorshipVerified: false,
          signedBy: parsedProof.issuer,
          verificationMethod: parsedProof.verificationMethod,
          reason: verifyResult.reason ?? 'verification returned false',
        };
      }
    } catch (err) {
      authorship = {
        authorshipVerified: false,
        signedBy: parsedProof.issuer,
        reason: `verifier threw: ${(err as Error).message}`,
      };
    }
  }

  return JSON.stringify({
    url,
    turtle,
    ...(graph ? { graph } : {}),
    ...(authorship ? { authorship } : {}),
  });
}

// Per-user identity cache for the IDENTITY_URL/me lookup. The display
// name + DID + webId + primary-agent-DID are stable for the duration of
// an OAuth session (they change only on credential rotation / passport
// edit), so a per-userId TTL cache lets every get_pod_status (and any
// future identity-aware handler) avoid a per-call round-trip without
// going stale on actual changes. Keyed by userId — NOT by bearer token,
// so multiple concurrent sessions for the same user share one entry.
interface IdentityMeRecord {
  userId?: string;
  did?: string;
  webId?: string;
  displayName?: string;
  primaryAgentId?: string;
  primaryAgentDid?: string;
}
const IDENTITY_ME_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const IDENTITY_ME_CACHE_MAX = 1024;
const identityMeCache = new Map<string, { record: IdentityMeRecord; expiresAt: number }>();

// Cached identity-side agent inventory. IDENTITY_URL/agents/me returns
// every agent registered to the calling user across all per-surface
// minting flows (chatgpt-<userId>, claude-mobile-<userId>, etc.) — the
// "primary agent" exposed by /me is just the first one and is a
// historical artefact of registration order. get_pod_status needs the
// full list so the dashboard / MCP client can show "you have 3 agents
// across 3 surfaces; this session is using chatgpt-<userId>" instead
// of pinning the headline identity to whichever agent was minted first.
// Cached per userId with the same 5 min TTL as /me.
interface IdentityAgentRecord {
  id: string;
  name?: string;
  scope?: string;
  createdAt?: string;
  did?: string;
}
interface IdentityAgentsRecord {
  userId?: string;
  name?: string;
  agents: IdentityAgentRecord[];
}
const identityAgentsCache = new Map<string, { record: IdentityAgentsRecord; expiresAt: number }>();

async function fetchIdentityMe(identityToken: string): Promise<IdentityMeRecord | null> {
  // Best-effort decode of the JWT to get the userId claim — used only as
  // a cache key. If decode fails, fall back to keying by token (still
  // sound, just lower hit rate). Cache key MUST be derivable without a
  // network call, otherwise we defeat the cache's purpose.
  const cacheKey = jwtUserIdClaim(identityToken) ?? `tok:${identityToken}`;
  const now = Date.now();
  const cached = identityMeCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.record;

  try {
    const r = await fetch(`${IDENTITY_URL}/me`, {
      headers: { 'Authorization': `Bearer ${identityToken}` },
    });
    if (!r.ok) return cached?.record ?? null;
    const me = await r.json() as IdentityMeRecord;
    const record: IdentityMeRecord = {
      ...(me.userId ? { userId: me.userId } : {}),
      ...(me.did ? { did: me.did } : {}),
      ...(me.webId ? { webId: me.webId } : {}),
      ...(me.displayName ? { displayName: me.displayName } : {}),
      ...(me.primaryAgentId ? { primaryAgentId: me.primaryAgentId } : {}),
      ...(me.primaryAgentDid ? { primaryAgentDid: me.primaryAgentDid } : {}),
    };
    // LRU eviction: cap the cache so a hostile client can't OOM us with
    // distinct tokens. Evict the oldest entry by insertion order.
    if (identityMeCache.size >= IDENTITY_ME_CACHE_MAX) {
      const oldestKey = identityMeCache.keys().next().value;
      if (oldestKey !== undefined) identityMeCache.delete(oldestKey);
    }
    identityMeCache.set(cacheKey, { record, expiresAt: now + IDENTITY_ME_CACHE_TTL_MS });
    return record;
  } catch {
    // Network / parse error: serve stale-if-available, else null.
    return cached?.record ?? null;
  }
}

// Fetch the calling user's full agent inventory from the identity
// server. Returns null on auth / network failure (caller falls back to
// /me's primary-agent-only view). Same caching contract as
// fetchIdentityMe — keyed by userId, 5 min TTL, LRU-capped.
async function fetchIdentityAgents(identityToken: string): Promise<IdentityAgentsRecord | null> {
  const cacheKey = jwtUserIdClaim(identityToken) ?? `tok:${identityToken}`;
  const now = Date.now();
  const cached = identityAgentsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.record;

  try {
    const r = await fetch(`${IDENTITY_URL}/agents/me`, {
      headers: { 'Authorization': `Bearer ${identityToken}` },
    });
    if (!r.ok) return cached?.record ?? null;
    const data = await r.json() as IdentityAgentsRecord;
    const record: IdentityAgentsRecord = {
      ...(data.userId ? { userId: data.userId } : {}),
      ...(data.name ? { name: data.name } : {}),
      agents: Array.isArray(data.agents) ? data.agents.map(a => ({
        id: a.id,
        ...(a.name ? { name: a.name } : {}),
        ...(a.scope ? { scope: a.scope } : {}),
        ...(a.createdAt ? { createdAt: a.createdAt } : {}),
        ...(a.did ? { did: a.did } : {}),
      })) : [],
    };
    if (identityAgentsCache.size >= IDENTITY_ME_CACHE_MAX) {
      const oldestKey = identityAgentsCache.keys().next().value;
      if (oldestKey !== undefined) identityAgentsCache.delete(oldestKey);
    }
    identityAgentsCache.set(cacheKey, { record, expiresAt: now + IDENTITY_ME_CACHE_TTL_MS });
    return record;
  } catch {
    return cached?.record ?? null;
  }
}

// Best-effort surface-slug extraction from an agent id like
// "chatgpt-u-pk-b03a054d6915" → "chatgpt". Walks back from the userId
// prefix ("u-pk-", "u-eth-", "u-did-") since the slug itself may
// contain hyphens (e.g. "claude-mobile-u-pk-..."). If no userId prefix
// is found, returns undefined.
function surfaceSlugFromAgentId(agentId: string | undefined): string | undefined {
  if (!agentId) return undefined;
  const m = agentId.match(/^(.+?)-u-(?:pk|eth|did)-/);
  return m?.[1];
}

// Extract the bare agent id from either a bare id or a did:web form.
// did:web:host:agents:chatgpt-u-pk-xxx → chatgpt-u-pk-xxx
function bareAgentId(idOrDid: string | undefined): string | undefined {
  if (!idOrDid) return undefined;
  if (idOrDid.startsWith('did:web:')) {
    const parts = idOrDid.split(':');
    return parts[parts.length - 1];
  }
  return idOrDid;
}

// Decode the sub / userId claim from a JWT without verifying it. Used
// only as a cache key — the upstream IDENTITY_URL/me request still does
// the real verification.
function jwtUserIdClaim(token: string): string | undefined {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return undefined;
    const payloadJson = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(payloadJson) as { sub?: string; userId?: string };
    return payload.userId ?? payload.sub;
  } catch {
    return undefined;
  }
}

async function handleGetPodStatus(args: ToolArgs): Promise<string> {
  const podUrl = args.pod_url as string;
  const identityToken = args._identity_token as string | undefined;
  // Session agent — derived from THIS connection's OAuth bearer token
  // (req.auth.extra.agentId), not from registration order. The relay
  // mints one per-surface agent per session (chatgpt-<userId>,
  // claude-mobile-<userId>, ...) and we surface THAT one as the
  // headline identity. The historical "primary agent" from /me is
  // demoted to one entry in the `agents` list.
  const sessionAgentDid = args._session_agent_did as string | undefined;
  const sessionAgentIdRaw = args._session_agent_id as string | undefined;
  const [entries, profile] = await Promise.all([
    getCachedManifest(podUrl).catch(() => []),
    getCachedRelayProfile(podUrl).catch(() => null),
  ]);

  // Resolve the calling user's display name (set at WebAuthn / DID
  // registration and stored in auth-methods.jsonld#name on identity).
  // The pod-side AgentRegistry only carries a name once register_agent
  // has run — but every onboarded user has a display name from day 1, so
  // we fetch IDENTITY_URL/me which returns { userId, did, webId,
  // displayName, primaryAgentDid, podHint, ... }. Cached per userId with
  // a 5 min TTL so we don't take a network hop on every status call.
  // Failure here is non-fatal: the rest of the response still lands.
  const [identity, agentsList] = identityToken
    ? await Promise.all([fetchIdentityMe(identityToken), fetchIdentityAgents(identityToken)])
    : [null, null];

  // The display name is set at registration. Surface it at the top level
  // (and inside `identity` for full context) so MCP clients can render
  // "Hi <displayName>" without parsing a nested registry block that may
  // not exist yet on first-use pods.
  const displayName = identity?.displayName
    ?? profile?.name
    ?? undefined;
  // Also expose webId / userId top-level (back-compat: existing fields
  // like `registry`, `descriptors`, `entries`, `recentNotifications`
  // are untouched). Lets MCP clients render "logged in as <name> (<webId>)"
  // without descending into the nested `identity` block.
  const webId = identity?.webId;
  const userId = identity?.userId;

  // Build the agents list. Prefer identity-server /agents/me (every
  // surface-minted agent the user owns) and fall back to pod-side
  // AgentRegistry if identity is unreachable. Each entry carries id,
  // did, label, surface slug (derived from id), and firstSeen so MCP
  // clients can render per-surface management UIs.
  type AgentEntry = {
    id: string;
    did?: string;
    label?: string;
    surface?: string;
    firstSeen?: string;
    scope?: string;
  };
  const agents: AgentEntry[] = [];
  if (agentsList?.agents.length) {
    for (const a of agentsList.agents) {
      agents.push({
        id: a.id,
        ...(a.did ? { did: a.did } : {}),
        ...(a.name ? { label: a.name } : {}),
        ...(surfaceSlugFromAgentId(a.id) ? { surface: surfaceSlugFromAgentId(a.id)! } : {}),
        ...(a.createdAt ? { firstSeen: a.createdAt } : {}),
        ...(a.scope ? { scope: a.scope } : {}),
      });
    }
  } else if (profile) {
    // Identity unavailable — derive what we can from the pod-side
    // AgentRegistry. validFrom is the pod's nearest equivalent to
    // identity-side createdAt.
    for (const a of profile.authorizedAgents.filter(x => !x.revoked)) {
      const bare = bareAgentId(a.agentId) ?? a.agentId;
      agents.push({
        id: bare,
        did: a.agentId,
        ...(a.label ? { label: a.label } : {}),
        ...(surfaceSlugFromAgentId(bare) ? { surface: surfaceSlugFromAgentId(bare)! } : {}),
        ...(a.validFrom ? { firstSeen: a.validFrom } : {}),
        ...(a.scope ? { scope: a.scope } : {}),
      });
    }
  }

  // Resolve the session agent. The authContext-injected
  // _session_agent_did is the OAuth token's agent IRI (did:web:... when
  // identity returned an agentDid; bare id otherwise). We prefer the
  // matching entry from the agents list so label/surface/firstSeen come
  // from a single source of truth; if no match (e.g. agents list fetch
  // failed) we fabricate a minimal entry from what the token tells us.
  const sessionBareId = bareAgentId(sessionAgentIdRaw) ?? bareAgentId(sessionAgentDid);
  let sessionAgent: AgentEntry | undefined;
  if (sessionBareId) {
    const match = agents.find(a => a.id === sessionBareId || a.did === sessionAgentDid);
    if (match) {
      sessionAgent = match;
    } else {
      sessionAgent = {
        id: sessionBareId,
        ...(sessionAgentDid ? { did: sessionAgentDid } : {}),
        ...(surfaceSlugFromAgentId(sessionBareId) ? { surface: surfaceSlugFromAgentId(sessionBareId)! } : {}),
      };
    }
  }

  // back-compat: top-level agentId continues to exist but now points at
  // the SESSION agent (what this connection is actually using), not the
  // historical "primary". Old clients keep rendering; new clients should
  // read sessionAgent.id.
  const agentId = sessionAgent?.id ?? identity?.primaryAgentId;

  // Inside the nested `identity` block we keep primaryAgentId/Did for
  // strict back-compat AND add a clarifying note pointing readers at
  // sessionAgent. "Primary" is the historical first-registered agent;
  // the current session is using sessionAgent. Without this note a
  // dashboard could keep showing primaryAgentId as the headline.
  const identityWithNote = identity ? {
    ...identity,
    ...(sessionAgent ? {
      sessionAgentNote: 'primaryAgentId is the first agent ever registered for this user; the current connection is using sessionAgent (see top-level field).',
    } : {}),
  } : null;

  return JSON.stringify({
    pod: podUrl,
    css: CSS_URL,
    ...(displayName ? { displayName } : {}),
    ...(webId ? { webId } : {}),
    ...(userId ? { userId } : {}),
    ...(sessionAgent ? { sessionAgent } : {}),
    ...(agents.length ? { agents } : {}),
    ...(agentId ? { agentId } : {}),
    ...(identityWithNote ? { identity: identityWithNote } : {}),
    registry: profile ? {
      owner: profile.webId,
      name: profile.name,
      agents: profile.authorizedAgents.filter(a => !a.revoked).length,
    } : null,
    descriptors: entries.length,
    entries,
    recentNotifications: notificationLog.slice(-10),
  });
}

async function handleSubscribeToPod(args: ToolArgs): Promise<string> {
  const podUrl = args.pod_url as string;
  const slug = podSlug(podUrl);
  const relayBase = (PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const sseUrl = `${relayBase}/notifications/${slug}`;

  if (subscriptions.has(podUrl)) {
    return JSON.stringify({
      subscribed: true,
      message: 'Already subscribed',
      pod: podUrl,
      sse_url: sseUrl,
      pod_slug: slug,
    });
  }

  try {
    const sub = await subscribe(podUrl, (event: ContextChangeEvent) => {
      // Tee the upstream WebSocket event into the relay's
      // SolidNotifications fan-out so SSE clients see remote changes,
      // not just local relay-mediated publishes. The legacy
      // notificationLog is still populated as a side-effect of
      // emitNotification so older /sse pollers continue to work.
      const legacyEventType: 'created' | 'updated' | 'superseded' =
        event.type === 'Add' ? 'created'
          : event.type === 'Remove' ? 'superseded'
          : 'updated';
      emitNotification(podUrl, {
        eventType: legacyEventType,
        descriptorUrl: event.resource,
        timestamp: event.timestamp,
      });
      log(`[notification] ${event.type} on ${event.resource}`);
    }, {
      fetch: solidFetch,
      WebSocket: WebSocket as unknown as WebSocketConstructor,
    });
    subscriptions.set(podUrl, sub);
    return JSON.stringify({
      subscribed: true,
      pod: podUrl,
      // SolidNotifications SSE channel for this pod — clients can
      // connect directly with `EventSource(sse_url, { withCredentials })`
      // to receive every iep:Notification event without paying the
      // /sse global polling tax.
      sse_url: sseUrl,
      pod_slug: slug,
    });
  } catch (err) {
    // Graceful degradation path. The upstream Solid Notifications
    // discovery handshake (HEAD for a storageDescription Link header,
    // then GET <pod>.well-known/solid as a fallback) is a Solid-spec
    // compatibility layer, not the substrate's canonical wire. CSS
    // routes the per-user .well-known/solid path to 501 Not Implemented
    // because that endpoint is defined at the server origin
    // (https://<host>/.well-known/solid) — not under a user-rooted
    // storage container (https://<host>/<user>/.well-known/solid).
    // When the discovery fails (501 / 404 / other 4xx / 5xx / network),
    // we still have a fully functional SSE channel at
    // /notifications/<podSlug>: it fans out every relay-mediated
    // publish via emitNotification, independent of any upstream
    // WebSocket subscription. So report subscribed:true with the SSE
    // URL as the primary path and surface the upstream-discovery
    // failure as a structured fallback_reason rather than a hard error.
    const reason = (err as Error).message;
    log(`[subscribe] upstream Solid Notifications discovery failed for ${podUrl}: ${reason}; falling back to substrate-native SSE at ${sseUrl}`);
    return JSON.stringify({
      subscribed: true,
      upstream_websocket: false,
      pod: podUrl,
      sse_url: sseUrl,
      pod_slug: slug,
      fallback_reason: reason,
    });
  }
}

async function handleRegisterAgent(args: ToolArgs): Promise<string> {
  const podName = (args.pod_name as string) ?? 'default';
  const podUrl = `${CSS_URL}${podName}/`;
  const ownerWebId = (args.owner_webid as string) as IRI;
  const agentId = (args.agent_id as string) as IRI;

  let profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
  if (!profile) {
    profile = createOwnerProfile(ownerWebId, args.owner_name as string);
  }

  try {
    profile = addAuthorizedAgent(profile, {
      agentId,
      delegatedBy: ownerWebId,
      label: args.label as string,
      isSoftwareAgent: true,
      scope: (args.scope as 'ReadWrite') ?? 'ReadWrite',
      validFrom: new Date().toISOString(),
      // The relay registers its own X25519 public key alongside the agent
      // so content encrypted to "this agent" lands decryptable here. Clients
      // that call register_agent explicitly get the same wiring they'd get
      // from the auto-registration path in publish_context.
      encryptionPublicKey: relayAgentKey.publicKey,
    });
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }

  // Sign the credential with the relay's compliance wallet so
  // verify_agent can perform a cryptographic chain walk later.
  // Registry + credential target distinct CSS paths — run the two
  // PUTs concurrently.
  const agent = profile.authorizedAgents.find(a => a.agentId === agentId)!;
  const credentialAndWrite = (async () => {
    const signer = await getDelegationSigner();
    const cred = await createSignedDelegationCredential(
      profile,
      agent,
      podUrl as IRI,
      signer,
    );
    const url = await writeDelegationCredential(cred, podUrl, { fetch: solidFetch });
    return { cred, url };
  })();
  const [, { cred: credential, url: credUrl }] = await Promise.all([
    writeAgentRegistry(profile, podUrl, { fetch: solidFetch }),
    credentialAndWrite,
  ]);
  relayProfileCache.delete(podUrl);

  return JSON.stringify({
    registered: true,
    agent: agentId,
    credential: credUrl,
    proof: credential.proof,
  });
}

async function handleVerifyAgent(args: ToolArgs): Promise<string> {
  // Translate legacy public-host CSS URLs at the handler boundary so the
  // delegation walk targets the canonical internal-FQDN. This is the
  // specific failure case called out in the migration diagnosis:
  // `verify_agent` against `https://interego-css.livelysky-<id>...
  // .azurecontainerapps.io/markj/` was returning "No agent registry
  // found" because that public host no longer serves the canonical pod
  // tree. solidFetch ALSO rewrites at the HTTP layer.
  const rawPodUrl = (args.pod_url ?? args.podUrl) as string | undefined;
  if (typeof rawPodUrl !== 'string' || rawPodUrl.length === 0) {
    // Defensive: a caller (or a mis-unwrapped signed request) reached
    // verify_agent without a pod_url. Return a clean, well-shaped
    // negative rather than dereferencing undefined downstream (which
    // crashed in readAgentRegistry's ensureTrailingSlash on `undefined`).
    return JSON.stringify(buildVerifyAgentEnvelope({
      valid: false,
      agent: (args.agent_id as IRI) ?? ('urn:unknown' as IRI),
      reason: 'verify_agent requires a pod_url',
    }));
  }
  const podUrl = normalizeCssUrl(rawPodUrl);
  // Pass the verifier so the registry-only path is upgraded to a real
  // cryptographic chain walk: the signed VC at /credentials/<agent>.jsonld
  // is fetched, its proof is checked against the owner's wallet key,
  // and any sub-delegation chain is walked to the pod owner before a
  // `CryptographicallyVerified` label is returned.
  const result = await verifyAgentDelegation(
    (args.agent_id as string) as IRI,
    podUrl,
    { fetch: solidFetch, verifier: delegationVerifier },
  );
  return JSON.stringify(buildVerifyAgentEnvelope(result));
}

// ── Federation Tool Handlers ────────────────────────────────

// In-memory pod registry for the relay, backed by a persistent
// federation store on the service-account pod (see
// `federation-store.ts`). Every mutator (`handleAddPod`,
// `handleRemovePod`, `handleDiscoverDirectory`,
// `handleResolveWebfinger`) updates this map AND mirrors to the pod
// so a container restart recovers the federation rather than dropping
// every peer.
//
// `via` tracks how a pod entry got into our view of the federation:
//   'manual'    — explicitly added via add_pod
//   'directory' — imported from a published pod directory
//   'webfinger' — resolved via WebFinger lookup
//   'self'      — synthetic per-call projection of the calling
//                 bearer's own pod (NEVER persisted to knownPods —
//                 see selfPodEntry()). 'self' wins on URL collisions
//                 so users see their own pod as their own pod even
//                 if a directory import previously listed it.
type KnownPodVia = 'manual' | 'directory' | 'webfinger' | 'self' | 'auto';
interface KnownPodEntry {
  url: string;
  label?: string;
  owner?: string;
  via: KnownPodVia;
  /** ISO-8601 — when this entry first landed in the federation. */
  addedAt: string;
  // Agent-card fields (populated by the auto-registration path).
  did?: string;
  webId?: string;
  inbox?: string;
  surface?: string;
  handle?: string;
  channels?: ReadonlyArray<{ type: string; value: string }>;
  updatedAt?: string;
}
const knownPods: Map<string, KnownPodEntry> = new Map();

// Federation store config — same service-account pod the OAuth token
// store already writes to, under a sibling `federation/` subcontainer.
// Hydrated at startup below (synchronously into the `knownPods` map)
// so the first `list_known_pods` after restart already sees every
// previously-added peer.
const federationStoreCfg: FederationStoreConfig = {
  podUrl: oauthStorePodUrl,
  fetch: solidFetch,
  log: (msg: string) => log(msg),
};

// Most recent successful persistence — surfaced in
// `list_known_pods` so operators can confirm at a glance that the
// store is being written to. Updated by `persistFederationEntry()`
// on every successful save; never reset on failure (last-known-good
// semantics).
let federationLastPersistedAt: string | null = null;

// Most recent successful hydrate (load-from-pod) completion. Updated
// once when `startFederationHydrate()` resolves regardless of how many
// entries came back (so an empty container still flips the flag,
// distinguishing 'hydrate completed clean, just no entries yet' from
// 'hydrate has not run / is in flight').
//
// Bug fix (FIX 5): before this, the only durability-observable signal
// was `federationLastPersistedAt`, which is null until the first WRITE
// after process start. A healthy deploy that hydrated N entries off the
// pod but received no add_pod/remove_pod traffic legitimately reported
// `lastPersistedAt: null` AND a populated `pods` list — operators could
// not tell that apart from a broken store. `lastHydratedAt` +
// `hydrateSourceCount` give an unambiguous health signal independent
// of post-start mutation activity.
let federationLastHydratedAt: string | null = null;
let federationHydrateSourceCount: number = 0;

// Debounce window for the persist sink. add_pod / discover_directory
// can fire many add events in quick succession; we coalesce into a
// single PUT per pod URL by replacing any pending timer for that URL
// with a new one. The actual filesystem write still happens per-URL
// (each pod has its own file keyed by sha256(url)) so this only
// elides redundant writes to the SAME URL during the same burst.
const FEDERATION_PERSIST_DEBOUNCE_MS = 250;
const _federationPendingWrites: Map<string, NodeJS.Timeout> = new Map();

// Per-URL in-flight write promise. Serializes concurrent writes to
// the SAME pod URL so a rapid add_pod → remove_pod → add_pod sequence
// doesn't race on the underlying PUT/DELETE/PUT. Different URLs run
// in parallel (no shared resource).
const _federationWriteChain: Map<string, Promise<void>> = new Map();

/**
 * Serialize writes for a given pod URL. Returns a promise that resolves
 * when the supplied task finishes; subsequent calls for the same URL
 * queue behind any in-flight work. Mirrors the `withPodMutex` pattern
 * used elsewhere in the relay for descriptor writes.
 */
function withFederationUrlMutex<T>(podUrl: string, task: () => Promise<T>): Promise<T> {
  const prior = _federationWriteChain.get(podUrl) ?? Promise.resolve();
  const next = prior.then(task, task);
  _federationWriteChain.set(podUrl, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Run the actual persistence write under the per-URL mutex. Returns a
 * promise that resolves when the PUT completes (success OR transport
 * failure — best-effort, the in-memory map is the live source of truth).
 * Updates `federationLastPersistedAt` on success so post-write reads
 * via `list_known_pods` see the fresh timestamp.
 *
 * Shared by both the synchronous (`persistFederationEntry`) and the
 * debounced (`persistFederationEntryDebounced`) entry points so the
 * write semantics are identical regardless of caller.
 */
function runFederationPersist(entry: KnownPodEntry): Promise<void> {
  return withFederationUrlMutex(entry.url, async () => {
    const persistEntry: FederationEntry = {
      url: entry.url,
      via: entry.via,
      addedAt: entry.addedAt,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
    };
    try {
      await saveFederationEntry(persistEntry, federationStoreCfg);
      federationLastPersistedAt = new Date().toISOString();
    } catch (err) {
      log(`[federation-store] persistFederationEntry(${entry.url}) failed: ${(err as Error).message}`);
    }
  });
}

/**
 * Immediate, awaitable persistence write for user-facing handlers
 * (add_pod, single-entry directory adds). Returns a promise that the
 * caller MUST await before responding to the wire so a container
 * restart inside the ~300-800ms PUT window doesn't drop the entry.
 *
 * If a debounced write for the same URL is already pending, cancel it —
 * this immediate write supersedes it, and runs under the per-URL mutex
 * so it still serializes against any concurrent unpersist.
 *
 * `via: 'self'` entries are projected per-call from the bearer and
 * never persisted; we short-circuit those silently.
 */
function persistFederationEntry(entry: KnownPodEntry): Promise<void> {
  if (entry.via === 'self') return Promise.resolve();
  const pending = _federationPendingWrites.get(entry.url);
  if (pending) {
    clearTimeout(pending);
    _federationPendingWrites.delete(entry.url);
  }
  return runFederationPersist(entry);
}

/**
 * Debounced variant for bulk import paths (e.g. discover_directory
 * fanning out N entries). Coalesces a burst of identical add events
 * for the same URL into a single PUT after `FEDERATION_PERSIST_DEBOUNCE_MS`.
 *
 * Returns a promise that resolves when the eventual write completes,
 * so the caller can `Promise.allSettled([...])` the entire batch and
 * await durability before returning. The promise resolves immediately
 * for `via: 'self'` entries (which are never persisted).
 */
function persistFederationEntryDebounced(entry: KnownPodEntry): Promise<void> {
  if (entry.via === 'self') return Promise.resolve();
  const existing = _federationPendingWrites.get(entry.url);
  if (existing) clearTimeout(existing);
  return new Promise<void>((resolve) => {
    const handle = setTimeout(() => {
      _federationPendingWrites.delete(entry.url);
      runFederationPersist(entry).then(resolve, resolve);
    }, FEDERATION_PERSIST_DEBOUNCE_MS);
    _federationPendingWrites.set(entry.url, handle);
  });
}

/**
 * Awaitable removal write. Cancels any pending add for the same URL
 * (no point persisting an add that's about to be removed) then issues
 * the DELETE under the same per-URL mutex. Callers MUST await before
 * responding so a container restart inside the DELETE window doesn't
 * resurrect the entry.
 */
function unpersistFederationEntry(podUrl: string): Promise<void> {
  const pending = _federationPendingWrites.get(podUrl);
  if (pending) {
    clearTimeout(pending);
    _federationPendingWrites.delete(podUrl);
  }
  return withFederationUrlMutex(podUrl, async () => {
    try {
      await removeFederationEntry(podUrl, federationStoreCfg);
      federationLastPersistedAt = new Date().toISOString();
    } catch (err) {
      log(`[federation-store] unpersistFederationEntry(${podUrl}) failed: ${(err as Error).message}`);
    }
  });
}

// Hydrate from the federation store. Cold-start safe: a missing
// container, a transport error, or zero entries all yield an empty
// load and the relay starts with just the per-call synthetic `self`
// entry — same legacy behaviour as before persistence existed.
//
// Promise-cached + lazy: the original top-level `await` blocked module
// evaluation on a CSS round-trip, so a slow/unreachable CSS during a
// container roll froze the entire relay process in import — health
// checks failed, container restarted, hydration retried from scratch.
// Mirrors `startInitialIndexRebuild` in identity/server.ts:1142.
let federationHydrateReady: Promise<void> | null = null;
function startFederationHydrate(): Promise<void> {
  return (federationHydrateReady ??= loadFederationEntries(federationStoreCfg).then(loaded => {
    for (const entry of loaded) {
      // Defensive: loadEntries already filters via:'self', but double-
      // check at the insertion point so future writers can't sneak one in.
      if (entry.via === 'self') continue;
      knownPods.set(entry.url, {
        url: entry.url,
        via: entry.via,
        addedAt: entry.addedAt,
        ...(entry.label !== undefined ? { label: entry.label } : {}),
        ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
      });
    }
    // Record successful hydrate completion so `list_known_pods` +
    // `/relay/federation-status` can distinguish 'never wrote since
    // startup' from 'never loaded since startup'. Flips even on an
    // empty container — that's a real, healthy state.
    federationLastHydratedAt = new Date().toISOString();
    federationHydrateSourceCount = loaded.length;
    log(`Federation store: pod=${oauthStorePodUrl} loaded=${loaded.length}`);
  }).catch(err => {
    log(`WARN: federation hydrate failed: ${(err as Error).message}`);
  }));
}
startFederationHydrate();

function awaitFederationHydrateWithBudget(budgetMs: number): Promise<void> {
  const ready = federationHydrateReady;
  if (!ready) return Promise.resolve();
  return Promise.race([
    ready,
    new Promise<void>(resolve => setTimeout(resolve, budgetMs)),
  ]);
}

// Resolve the calling user's OWN pod URL from the auth-context-
// injected args, INDEPENDENT of args.pod_url (which on tools like
// add_pod is the *candidate* pod the caller passed, not the caller's
// own pod). Order of resolution:
//   1. identity-server /me (cached, source of truth — survives
//      preferred-pod overlays where userId may not match pod path)
//   2. CSS_URL + pod_name (the userId) — the bootstrap convention
//      identity follows when no overlay is set
// Returns undefined when the bearer didn't yield either signal
// (unauthenticated /mcp call with RELAY_MCP_API_KEY unset).
async function selfPodUrl(args: ToolArgs): Promise<string | undefined> {
  const identityToken = args._identity_token as string | undefined;
  if (identityToken) {
    const me = await fetchIdentityMe(identityToken);
    if (me?.userId) return `${CSS_URL}${me.userId}/`;
  }
  const userId = args.pod_name as string | undefined;
  if (userId) return `${CSS_URL}${userId}/`;
  return undefined;
}

// Build the per-call synthetic 'self' entry for the calling user's
// own pod from the auth-context-injected args. Returns undefined if
// the bearer didn't yield a pod URL (e.g. unauthenticated /mcp call
// when RELAY_MCP_API_KEY is unset). Best-effort resolves the display
// name via the per-user identity cache; falls back to pod_name (the
// userId) for the same reason bootstrapPod falls back when
// identity is unreachable. This is a presentation-layer projection
// — never persisted to knownPods, so it stays correct across user
// switches on a shared relay instance.
async function selfPodEntry(args: ToolArgs): Promise<{ url: string; label?: string; owner?: string; via: KnownPodVia } | undefined> {
  const url = await selfPodUrl(args);
  if (!url) return undefined;
  const owner = args.owner_webid as string | undefined;
  const userId = args.pod_name as string | undefined;
  let label: string | undefined;
  const identityToken = args._identity_token as string | undefined;
  if (identityToken) {
    const me = await fetchIdentityMe(identityToken);
    label = me?.displayName ?? me?.userId ?? userId;
  } else {
    label = userId;
  }
  return { url, label, owner, via: 'self' };
}

// Merge the synthetic 'self' entry on top of the persisted knownPods
// values. 'self' is always first; URL collisions are de-duped with
// 'self' winning (so a user who imported a directory that listed
// their own pod still sees it labelled as their own).
async function knownPodsWithSelf(args: ToolArgs): Promise<Array<{ url: string; label?: string; owner?: string; via: KnownPodVia; addedAt?: string; did?: string; webId?: string; inbox?: string; surface?: string; handle?: string; channels?: ReadonlyArray<{ type: string; value: string }> }>> {
  const self = await selfPodEntry(args);
  const others = [...knownPods.values()].filter(p => !self || p.url !== self.url).map(p => ({ ...p }));
  return self ? [{ ...self }, ...others] : others;
}

async function handleDiscoverAll(args: ToolArgs): Promise<string> {
  await awaitFederationHydrateWithBudget(50);
  const pods = await knownPodsWithSelf(args);
  if (pods.length === 0) {
    return JSON.stringify({ message: 'No known pods. Use add_pod or discover_directory first.' });
  }

  const results: Array<{ pod: string; entries: ManifestEntry[]; error?: string }> = [];
  await Promise.allSettled(pods.map(async (pod) => {
    try {
      const filter: Record<string, unknown> = {};
      if (args.facet_type) filter.facetType = args.facet_type;
      if (args.graph_iri) filter.graphIri = args.graph_iri;
      if (args.valid_from) filter.validFrom = args.valid_from;
      if (args.valid_until) filter.validUntil = args.valid_until;
      if (args.effective_at) filter.effectiveAt = args.effective_at;
      if (args.sort) filter.sort = args.sort;
      if (typeof args.limit === 'number' && args.limit >= 0) filter.limit = args.limit;
      const entries = await discover(
        pod.url,
        Object.keys(filter).length > 0 ? filter as Parameters<typeof discover>[1] : undefined,
        { fetch: solidFetch },
      );
      results.push({ pod: pod.url, entries });
    } catch (err) {
      results.push({ pod: pod.url, entries: [], error: (err as Error).message });
    }
  }));

  return JSON.stringify({ pods: results.length, results });
}

async function handleListKnownPods(args: ToolArgs): Promise<string> {
  // Surface federation-store observability so operators can
  // distinguish a healthy fresh-deploy-with-no-writes-yet from a
  // genuinely broken store:
  //
  //   • `lastPersistedAt` — timestamp of the most recent successful
  //     write (PUT or DELETE). Null until the first successful persist;
  //     a populated pods list with null `lastPersistedAt` is normal on
  //     a deploy that has hydrated entries but received no mutations
  //     since startup. The string fallback below makes that explicit
  //     for human operators reading the JSON.
  //   • `lastHydratedAt` — timestamp of the most recent successful
  //     load-from-pod (set once on startup completion, regardless of
  //     mutation activity). Non-null means the store has been read at
  //     least once.
  //   • `hydrateSourceCount` — number of entries returned by the most
  //     recent successful hydrate. Gives operators a baseline for the
  //     'why is my pods list shorter than expected' diagnosis.
  //   • `hydrateSource` — the pod URL we hydrate from, so operators
  //     can sanity-check that the relay is reading from the expected
  //     service-account pod.
  await awaitFederationHydrateWithBudget(50);
  // De-dup on display by canonical host form (gate vs internal differ as
  // map keys but are the same pod) so the directory reads cleanly even
  // when an entry was added manually (gate URL) and auto-registered
  // (internal URL).
  const seen = new Set<string>();
  const pods = (await knownPodsWithSelf(args)).filter(p => {
    const key = canonicalPodKey(p.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return JSON.stringify({
    pods,
    lastPersistedAt: federationLastPersistedAt ?? '<no mutations since startup>',
    lastHydratedAt: federationLastHydratedAt,
    hydrateSourceCount: federationHydrateSourceCount,
    hydrateSource: oauthStorePodUrl,
  });
}

// ── Agent mesh: auto-registration, agent cards, notify, inbox ───────
//
// Canonical key for de-duping pod URLs that differ only by host
// (interego-css-gate.* public host vs interego-css.internal.* host) or
// trailing slash. Used for directory de-dup + target resolution.
function canonicalPodKey(url: string): string {
  try {
    const u = new URL(url);
    return ensureTrailingSlashLocal(u.pathname).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
function ensureTrailingSlashLocal(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

// Evict any OTHER knownPods entries that are the same pod as `keepUrl`
// (same canonical path, different host form — e.g. a gate-host entry
// added manually vs the internal-host entry written by auto-register).
// Also deletes their persisted federation files so the dup doesn't
// re-hydrate on restart. Keeps the directory one-entry-per-pod.
function evictCanonicalDuplicates(keepUrl: string): void {
  const key = canonicalPodKey(keepUrl);
  for (const [u] of [...knownPods.entries()]) {
    if (u !== keepUrl && canonicalPodKey(u) === key) {
      knownPods.delete(u);
      void removeFederationEntry(u, federationStoreCfg).catch(() => {});
    }
  }
}

// Map any pod URL (public gate host or legacy host) to the relay's
// internal CSS host, which the relay's solidFetch writes/reads against
// (the gate enforces per-user auth + rejects the relay's service writes;
// the internal host is the relay's allow-all write path). Preserves the
// path (the userId/eth- pod segment) exactly.
function toInternalPodUrl(url: string): string {
  try {
    return `${CSS_URL.replace(/\/$/, '')}${new URL(url).pathname}`;
  } catch {
    return url;
  }
}

// Relay host used to mint WebFinger-style acct: handles.
const RELAY_HANDLE_HOST = (() => {
  try { return PUBLIC_BASE_URL ? new URL(PUBLIC_BASE_URL).host : `localhost:${PORT}`; }
  catch { return `localhost:${PORT}`; }
})();

function podLocalPart(podUrl: string): string {
  try {
    const segs = new URL(podUrl).pathname.split('/').filter(Boolean);
    return segs[segs.length - 1] ?? 'agent';
  } catch { return 'agent'; }
}

// Process-local guard so we persist each agent card at most once per
// process unless something changed — keeps the auto-register hook on the
// hot path effectively free after first contact.
const _autoRegistered = new Set<string>();

/**
 * Idempotently upsert the calling agent into the federation directory as
 * an agent card (DID + pod + LDN inbox + acct handle), and persist it
 * fire-and-forget. Called from the tool-dispatch identity hook so EVERY
 * authenticated participant lands in the directory automatically — the
 * "everyone is discoverable" property, without manual add_pod.
 */
function autoRegisterAgentCard(
  podUrl: string | undefined,
  did: string | undefined,
  surface?: string,
  label?: string,
): void {
  if (!podUrl || !did) return;
  const key = `${did}|${canonicalPodKey(podUrl)}`;
  if (_autoRegistered.has(key)) return;
  _autoRegistered.add(key);
  const now = new Date().toISOString();
  const existing = knownPods.get(podUrl);
  const lp = podLocalPart(podUrl);
  const handle = `acct:${lp}@${RELAY_HANDLE_HOST}`;
  const inbox = inboxUrlFor(podUrl);
  // Native channels every agent carries; merge any externally-declared
  // (non-native) channels the agent set via set_reachability.
  const nativeChannels: Array<{ type: string; value: string }> = [
    { type: 'ldn', value: inbox },
    { type: 'activitypub', value: apActorUrl((PUBLIC_BASE_URL || `http://localhost:${PORT}`), lp) },
    { type: 'acct', value: handle },
  ];
  const externalChannels = (existing?.channels ?? []).filter(c => !['ldn', 'activitypub', 'acct'].includes(c.type));
  const entry: KnownPodEntry = {
    url: podUrl,
    via: existing && existing.via !== 'self' ? existing.via : 'auto',
    label: label ?? existing?.label,
    owner: did,
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
    did,
    webId: did,
    inbox,
    handle,
    channels: [...nativeChannels, ...externalChannels],
    ...(surface ? { surface } : existing?.surface ? { surface: existing.surface } : {}),
  };
  knownPods.set(podUrl, entry);
  evictCanonicalDuplicates(podUrl);
  void saveFederationEntry(
    {
      url: podUrl,
      via: entry.via as FederationEntry['via'],
      addedAt: entry.addedAt,
      ...(entry.label ? { label: entry.label } : {}),
      owner: did,
      did,
      webId: did,
      inbox,
      handle,
      channels: entry.channels,
      ...(surface ? { surface } : {}),
      updatedAt: now,
    },
    federationStoreCfg,
  ).then(() => { federationLastPersistedAt = new Date().toISOString(); }).catch(() => {});
}

/**
 * Resolve a notify target (DID, pod URL, or acct: handle) to a pod URL.
 * Prefers a directory match (so handles + DIDs work); falls back to
 * treating a u-pk-/eth-/did-shaped id as a pod under CSS_URL.
 */
function resolveTargetPodUrl(to: string): string | undefined {
  if (!to) return undefined;
  // A registered agent (by did/handle/webId) resolves to its canonical pod URL —
  // checked FIRST so a WebID never short-circuits to a profile-local inbox.
  for (const e of knownPods.values()) {
    if (e.did === to || e.handle === to || e.webId === to) return e.url;
  }
  // An Interego WebID/profile URL carries the agent's pod id (u-pk-/u-did-/eth-)
  // in its path. Resolve to the CSS pod root — its /inbox/ is the OPERATIONAL
  // inbox the recipient's read_inbox polls — NOT the profile-local inbox a raw
  // WebID would otherwise be delivered to (f-foxxi-webid-inbox-routing: a
  // WebID-addressed notification returned delivered:true but silently
  // dead-lettered into …/profile/inbox/, which no one polls).
  const idm = to.match(/(u-pk-|u-did-|u-eth-|eth-)[0-9a-z]+/i);
  if (/^https?:\/\//.test(to)) {
    if (idm) return `${CSS_URL}${idm[0].toLowerCase()}/`;
    return to;   // external / non-Interego URL — best-effort, delivered as given
  }
  // Bare id (e.g. "u-pk-…", "eth-…").
  if (/^(u-pk-|u-did-|u-eth-|eth-)/.test(to)) return `${CSS_URL}${to}/`;
  // did:ethr → eth-<slug> pod.
  const m = to.match(/^did:ethr:0x([0-9a-fA-F]{40})$/);
  if (m) return `${CSS_URL}eth-${m[1]!.slice(0, 12).toLowerCase()}/`;
  return undefined;
}

/** Whether a resolved target is the recipient's canonical CSS-pod inbox (the one
 *  read_inbox polls) vs a best-effort external URL. Lets notify_agent qualify
 *  delivered:true instead of reporting an unpolled dead-letter as success. */
function isCanonicalPodTarget(targetPod: string): boolean {
  return targetPod.startsWith(CSS_URL)
    || toInternalPodUrl(targetPod).startsWith(toInternalPodUrl(CSS_URL))
    || /(u-pk-|u-did-|u-eth-|eth-)[0-9a-z]+/i.test(targetPod);
}

async function handleNotifyAgent(args: ToolArgs): Promise<string> {
  const to = (args.to ?? args.recipient ?? args.agent) as string | undefined;
  const summary = (args.summary ?? args.subject) as string | undefined;
  if (!to || typeof to !== 'string') return JSON.stringify({ delivered: false, error: 'notify_agent requires `to` (DID, pod URL, or acct: handle)' });
  if (!summary || typeof summary !== 'string') return JSON.stringify({ delivered: false, error: 'notify_agent requires `summary`' });
  const targetPod = resolveTargetPodUrl(to);
  if (!targetPod) return JSON.stringify({ delivered: false, error: `could not resolve recipient "${to}" to a pod` });
  const from = (args.agent_id as string) ?? 'urn:unknown';
  const now = new Date().toISOString();
  const idSlug = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const input: NotificationInput = {
    from,
    to,
    summary,
    published: now,
    ...(typeof args.content === 'string' ? { content: args.content } : {}),
    ...(typeof args.about === 'string' ? { about: args.about } : {}),
    ...(typeof args.in_reply_to === 'string' ? { inReplyTo: args.in_reply_to } : {}),
    ...(typeof args.type === 'string' ? { type: args.type } : {}),
  };
  const notif = buildNotification(input, idSlug);
  const internalPod = toInternalPodUrl(targetPod);
  // Fan out to the recipient's declared channels: native LDN is always
  // attempted; any external channels (discord/telegram/email/sms/voice)
  // the recipient registered via set_reachability are delivered through
  // their adapters (live where credentials/targets are present).
  const tk = canonicalPodKey(targetPod);
  const cardMatches = [...knownPods.values()].filter(e => canonicalPodKey(e.url) === tk);
  // Prefer the entry that actually declares channels (avoids a stale
  // host-form duplicate that lacks them).
  const card = cardMatches.find(e => (e.channels?.length ?? 0) > 0) ?? cardMatches[0];
  const channels = (card?.channels ?? []) as ReachChannel[];
  const results = await reachFanOut(
    channels,
    { summary, from, ...(typeof args.content === 'string' ? { content: args.content } : {}), ...(typeof args.about === 'string' ? { about: args.about } : {}) },
    { deliverLdn: () => deliverNotification(internalPod, notif, idSlug, solidFetch, (m) => log(m)) },
  );
  const ldn = results.find(r => r.type === 'ldn');
  // delivered:true must mean the recipient's REAL (polled) inbox was reached, not
  // that some inbox was written. Qualify it when the target isn't the canonical
  // CSS-pod inbox, so a best-effort external delivery can't masquerade as a sure
  // hand-off (f-foxxi-webid-inbox-routing).
  const canonicalInbox = isCanonicalPodTarget(targetPod);
  return JSON.stringify({
    delivered: ldn?.ok ?? false,
    canonicalInbox,
    to,
    targetPod,
    inbox: inboxUrlFor(targetPod),
    notificationUrl: ldn?.detail,
    channels: results,
    from,
    ...(ldn?.ok && !canonicalInbox
      ? { warning: `delivered to ${targetPod} but this is not a recognized CSS-pod inbox the recipient is known to poll — confirm the recipient reads this inbox, or address them by did:ethr / pod-id / a registered WebID.` }
      : {}),
  });
}

// NOTE: Foxxi performance review is intentionally NOT a relay tool. Foxxi is a
// composed vertical over Interego, not a substrate primitive, so baking a
// foxxi-named tool into the relay would couple the substrate to a vertical. The
// capability is reached emergently instead: an agent discovers the published
// iep:Affordance urn:interego:foxxi:capability:review_foxxi_record, dereferences
// it, and invokes it with the generic `act` verb — the Foxxi bridge authenticates
// the agent's OWN signed request directly (no relay vouching).

// sign_request — substrate signing primitive (the dual of the signature
// verification the relay already runs on every signed request). The relay is
// single-signer, so a relay-mediated agent (which holds no key of its own)
// cannot produce a rev-196 signed envelope for a signed-request affordance like
// the Foxxi review endpoint. sign_request signs a caller-chosen payload with the
// relay's compliance delegation key, binding the caller's OWN authenticated
// agent identity. That identity is SESSION-DERIVED (server-injected at OAuth,
// non-overridable from the wire) — a caller can NEVER sign as anyone else, which
// matters because the compliance key anchors every agent's delegation VC. The
// verifier resolves the agent's delegation on their own pod (anchored by this
// same key), so NO key material is handed out and the relay can only sign for
// agents it has actually been delegated to. Returns { _signature, _signed_payload }
// — pass it verbatim as the `payload` of `act` on the target affordance.
async function handleSignRequest(args: ToolArgs): Promise<string> {
  // Identity is SESSION-DERIVED (server-injected), never a caller argument.
  const agentId = (args._session_agent_id as string | undefined)
    ?? (args._session_agent_did as string | undefined);
  if (!agentId) {
    return JSON.stringify({ error: 'sign_request: no authenticated session identity — sign_request signs only for the bound caller (authenticate first).' });
  }
  const podUrl = await selfPodUrl(args);
  // Caller-chosen, response-affecting options to fold INTO the signed assertion.
  // Accept them nested under `payload` OR at the top level (MCP clients vary), so
  // they become part of the verified message rather than an unsigned wrapper
  // (johnny's f-foxxi-include-clr-unsigned). Strip identity/timestamp/envelope and
  // server-injected session fields — those are set from the session, not the wire,
  // so the caller cannot claim a different agent_id, pod, or replay window.
  const reserved = new Set([
    'agent_id', 'timestamp', '_signature', '_signed_payload', 'subject_pod_url', 'payload',
    '_session_agent_id', '_session_agent_did', '_identity_token', 'pod_name', 'owner_webid', 'owner_name',
  ]);
  const safe: Record<string, unknown> = {};
  const collectOptions = (o: unknown): void => {
    // MCP clients vary: `payload` may arrive as an object OR a JSON-encoded
    // string. Parse strings so caller options (e.g. include_clr) are captured
    // either way — without this they were silently dropped from the signed
    // payload (johnny's f-foxxi-include-clr-unsigned "fix-did-not-land" re-run).
    let obj = o;
    if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return; } }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (!reserved.has(k)) safe[k] = v;
      }
    }
  };
  collectOptions(args);          // top-level options
  collectOptions(args.payload);  // nested options (object OR JSON string)
  const signedObj: Record<string, unknown> = {
    ...safe,
    agent_id: agentId,
    ...(podUrl ? { subject_pod_url: podUrl } : {}),
    timestamp: new Date().toISOString(),
  };
  const signedPayload = JSON.stringify(signedObj);
  const message = `sha256:${createHash('sha256').update(signedPayload, 'utf8').digest('hex')}`;
  try {
    const signer = await getDelegationSigner();
    const { signature, signerAddress } = await signer(message);
    return JSON.stringify({
      _signature: signature,
      _signed_payload: signedPayload,
      signed_as: agentId,
      anchor: `did:ethr:${signerAddress}`,
      hint: 'Pass this object as the `payload` of `act` on a rev-196 signed-request affordance (e.g. iep:action urn:iep:action:foxxi:review-record). The endpoint verifies your delegation on your own pod — no key material leaves the relay.',
    });
  } catch (err) {
    return JSON.stringify({ error: `sign_request: signing failed: ${(err as Error).message}` });
  }
}

async function handleSetReachability(args: ToolArgs): Promise<string> {
  // The caller declares external reachability channels on their OWN card.
  // Native channels (ldn/activitypub/acct) are managed automatically and
  // cannot be set here. Pod target = the caller's own pod.
  const podUrl = await selfPodUrl(args);
  const did = (args.agent_id as string | undefined);
  if (!podUrl || !did) return JSON.stringify({ error: 'set_reachability: could not resolve your identity/pod' });
  const raw = Array.isArray(args.channels) ? args.channels : [];
  const incoming: ReachChannel[] = [];
  for (const c of raw) {
    if (c && typeof c === 'object' && typeof (c as any).type === 'string' && typeof (c as any).value === 'string') {
      const t = (c as any).type as string;
      if (['ldn', 'activitypub', 'acct'].includes(t)) continue; // native, managed
      if (!KNOWN_CHANNEL_TYPES.includes(t)) continue;
      incoming.push({ type: t, value: (c as any).value });
    }
  }
  const existing = knownPods.get(podUrl);
  const native = (existing?.channels ?? []).filter(c => ['ldn', 'activitypub', 'acct'].includes(c.type));
  const merged = [...native, ...incoming];
  const now = new Date().toISOString();
  const lp = podLocalPart(podUrl);
  const updated: KnownPodEntry = {
    url: podUrl,
    via: existing && existing.via !== 'self' ? existing.via : 'auto',
    label: existing?.label,
    owner: did,
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
    did,
    webId: did,
    inbox: inboxUrlFor(podUrl),
    handle: `acct:${lp}@${RELAY_HANDLE_HOST}`,
    channels: merged,
    ...(existing?.surface ? { surface: existing.surface } : {}),
  };
  knownPods.set(podUrl, updated);
  evictCanonicalDuplicates(podUrl);
  void saveFederationEntry(
    { url: podUrl, via: updated.via as FederationEntry['via'], addedAt: updated.addedAt, owner: did, did, webId: did, inbox: updated.inbox, handle: updated.handle, channels: merged, updatedAt: now, ...(updated.surface ? { surface: updated.surface } : {}) },
    federationStoreCfg,
  ).then(() => { federationLastPersistedAt = new Date().toISOString(); }).catch(() => {});
  return JSON.stringify({ ok: true, pod: podUrl, channels: merged });
}

async function handleReadInbox(args: ToolArgs): Promise<string> {
  const explicit = (args.pod_url ?? args.podUrl) as string | undefined;
  const podUrl = explicit ?? await selfPodUrl(args);
  if (!podUrl) return JSON.stringify({ error: 'read_inbox: no pod_url and could not derive your own pod' });
  const limit = typeof args.limit === 'number' ? args.limit : 50;
  const items = await readAgentInbox(toInternalPodUrl(podUrl), solidFetch, limit);
  return JSON.stringify({ inbox: inboxUrlFor(podUrl), count: items.length, items });
}

async function handleRebuildManifest(args: ToolArgs): Promise<string> {
  // Heal f-manifest-collapse: reconstruct a pod's .well-known/context-graphs
  // index from its on-pod descriptors. Non-destructive (descriptors are the
  // authority; this only rebuilds the index). Defaults to the caller's own
  // pod; an explicit pod_url lets an operator restore a peer pod whose index
  // collapsed. Goes through the relay's internal CSS write path.
  const explicit = (args.pod_url ?? args.podUrl) as string | undefined;
  const podUrl = explicit ?? await selfPodUrl(args);
  if (!podUrl) return JSON.stringify({ error: 'rebuild_manifest: no pod_url and could not derive your own pod' });
  const internal = toInternalPodUrl(podUrl);
  try {
    const r = await rebuildManifestFromPod(internal, { fetch: solidFetch, log: (m) => log(m) });
    manifestCache.delete(internal);
    manifestCache.delete(podUrl);
    return JSON.stringify({ ok: true, pod: podUrl, manifestUrl: r.manifestUrl, scanned: r.scanned, written: r.written });
  } catch (err) {
    return JSON.stringify({ ok: false, pod: podUrl, error: (err as Error).message });
  }
}

async function handleAddPod(args: ToolArgs): Promise<string> {
  // add_pod takes the candidate pod URL explicitly — the auth-context
  // injection of args.pod_url here is the CALLER's own pod, not the
  // pod being added. The add_pod tool uses a separate `pod_url`
  // argument convention (see TOOLS schema), so we read `args.pod_url`
  // here but treat the auth-context-derived self pod as the dedupe
  // anchor. NB: in practice the injection at server.ts:3168 overwrites
  // pod_url only when the wire request omitted it; an add_pod call
  // without an explicit pod_url is malformed — we still de-shim here
  // for the case where the caller passes their own pod URL by mistake.
  const url = args.pod_url as string;
  const self = await selfPodEntry(args);
  if (self && self.url === url) {
    // Silently dedupe — adding your own pod is a no-op since
    // list_known_pods + discover_directory project it via 'self'.
    return JSON.stringify({ added: false, url, total: knownPods.size, reason: 'self' });
  }
  // Preserve the original addedAt on re-adds (operator updates the
  // label) so the audit trail stays meaningful — first-seen time, not
  // most-recent-edit time.
  const existing = knownPods.get(url);
  const entry: KnownPodEntry = {
    url,
    label: args.label as string | undefined,
    owner: args.owner as string | undefined,
    via: 'manual',
    addedAt: existing?.addedAt ?? new Date().toISOString(),
  };
  knownPods.set(url, entry);
  // AWAIT the persist before returning — add_pod is a control-plane
  // mutator and durability of a single PUT (~300-800ms against an
  // Azure-hosted CSS) is qualitatively more valuable than the latency
  // win of fire-and-forget. A container restart inside the old async
  // window silently dropped the add; awaiting eliminates that gap.
  await persistFederationEntry(entry);
  return JSON.stringify({ added: true, url, total: knownPods.size, lastPersistedAt: federationLastPersistedAt });
}

async function handleRemovePod(args: ToolArgs): Promise<string> {
  const url = args.pod_url as string;
  const removed = knownPods.delete(url);
  // AWAIT the DELETE before returning so a restart in the unpersist
  // window doesn't resurrect the entry on next load. Same durability
  // argument as handleAddPod.
  if (removed) await unpersistFederationEntry(url);
  return JSON.stringify({ removed, url, total: knownPods.size, lastPersistedAt: federationLastPersistedAt });
}

async function handleDiscoverDirectory(args: ToolArgs): Promise<string> {
  const directory = await fetchPodDirectory(args.directory_url as string, { fetch: solidFetch });
  let added = 0;
  // discover_directory can fan out to many adds, so use the debounced
  // path to coalesce bursts for the same URL. Collect the per-entry
  // write promises so we can AWAIT the whole batch before responding —
  // keeps the post-discover read shape (list_known_pods seeing every
  // imported entry as persisted) consistent across all three mutators.
  const pendingWrites: Promise<void>[] = [];
  for (const entry of directory.entries) {
    if (!knownPods.has(entry.podUrl)) added++;
    const existing = knownPods.get(entry.podUrl);
    const next: KnownPodEntry = {
      url: entry.podUrl,
      label: entry.label,
      owner: entry.owner,
      via: 'directory',
      addedAt: existing?.addedAt ?? new Date().toISOString(),
    };
    knownPods.set(entry.podUrl, next);
    pendingWrites.push(persistFederationEntryDebounced(next));
  }
  await Promise.allSettled(pendingWrites);
  // Return the merged view including the calling user's own pod
  // — addresses the "directory listing of my pods does not include
  // my own pod" surprise. We do NOT persist self into knownPods
  // (it is projected per-call from the bearer); we just include it
  // in the returned `pods` array for caller convenience. `added`
  // remains a count of newly-persisted directory entries.
  const pods = await knownPodsWithSelf(args);
  return JSON.stringify({ imported: directory.entries.length, added, total: knownPods.size, pods, lastPersistedAt: federationLastPersistedAt });
}

async function handlePublishDirectory(args: ToolArgs): Promise<string> {
  const podName = (args.pod_name as string) ?? 'default';
  const podUrl = `${CSS_URL}${podName}/`;
  // Seed the calling user's own pod as the FIRST entry in the
  // published directory so a downstream consumer reading it sees
  // the owner pod before any peers. The self entry is projected
  // from the bearer's identity (not persisted to knownPods); we
  // de-dup by URL with self winning over any peer entry that
  // happened to also list the same pod URL.
  const pods = await knownPodsWithSelf(args);
  const entries: PodDirectoryEntry[] = pods.map(p => ({
    podUrl: p.url as IRI,
    owner: p.owner as IRI | undefined,
    label: p.label,
  }));
  const directory: PodDirectoryData = {
    id: (args.directory_id as string ?? `urn:directory:${podName}`) as IRI,
    entries,
  };
  const url = await publishPodDirectory(directory, podUrl, { fetch: solidFetch });
  return JSON.stringify({ published: true, url, entries: entries.length });
}

async function handleResolveWebfinger(args: ToolArgs): Promise<string> {
  const result = await resolveWebFinger(args.resource as string, { fetch: solidFetch });
  if (result.podUrl) {
    const existing = knownPods.get(result.podUrl);
    const entry: KnownPodEntry = {
      url: result.podUrl,
      via: 'webfinger',
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      ...(existing?.label !== undefined ? { label: existing.label } : {}),
      ...(existing?.owner !== undefined ? { owner: existing.owner } : {}),
    };
    knownPods.set(result.podUrl, entry);
    // AWAIT the persist for parity with add_pod — webfinger resolution
    // is a single-entry user-facing add, same durability argument.
    await persistFederationEntry(entry);
  }
  return JSON.stringify(result);
}

async function handleRevokeAgent(args: ToolArgs): Promise<string> {
  const podName = (args.pod_name as string) ?? 'default';
  const podUrl = `${CSS_URL}${podName}/`;
  let profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
  if (!profile) return JSON.stringify({ error: 'No registry found' });
  profile = removeAuthorizedAgent(profile, (args.agent_id as string) as IRI);
  await writeAgentRegistry(profile, podUrl, { fetch: solidFetch });
  relayProfileCache.delete(podUrl);
  return JSON.stringify({ revoked: true, agent: args.agent_id });
}

// ── Federation: subscription management ─────────────────────

async function handleUnsubscribeFromPod(args: ToolArgs): Promise<string> {
  const podUrl = args.pod_url as string;
  const sub = subscriptions.get(podUrl);
  if (!sub) {
    return JSON.stringify({ unsubscribed: false, message: `No active subscription on ${podUrl}.` });
  }
  try {
    sub.unsubscribe();
  } catch (err) {
    log(`unsubscribe() failed for ${podUrl}: ${(err as Error).message}`);
  }
  subscriptions.delete(podUrl);
  return JSON.stringify({ unsubscribed: true, pod: podUrl, remaining: subscriptions.size });
}

async function handleSubscribeAll(args: ToolArgs): Promise<string> {
  // Include the calling user's own pod in the subscription set —
  // a user "subscribing to all" reasonably expects events from
  // their own pod too (notifications about their own publishes
  // are useful for cross-surface mirroring). Self is projected
  // per-call; de-duped on URL against persisted peers.
  const pods = await knownPodsWithSelf(args);
  let subscribed = 0;
  let failed = 0;
  const failures: Array<{ pod: string; error: string }> = [];

  const toSubscribe = pods.filter(p => !subscriptions.has(p.url));
  const skipped = pods.length - toSubscribe.length;

  await Promise.allSettled(toSubscribe.map(async (pod) => {
    try {
      const sub = await subscribe(pod.url, (event: ContextChangeEvent) => {
        // Tee upstream events into the SolidNotifications SSE fan-out
        // (also writes the legacy notificationLog entry as a side-effect).
        const legacyEventType: 'created' | 'updated' | 'superseded' =
          event.type === 'Add' ? 'created'
            : event.type === 'Remove' ? 'superseded'
            : 'updated';
        emitNotification(pod.url, {
          eventType: legacyEventType,
          descriptorUrl: event.resource,
          timestamp: event.timestamp,
        });
        log(`[notification] ${event.type} on ${event.resource}`);
      }, {
        fetch: solidFetch,
        WebSocket: WebSocket as unknown as WebSocketConstructor,
      });
      subscriptions.set(pod.url, sub);
      subscribed++;
    } catch (err) {
      failed++;
      failures.push({ pod: pod.url, error: (err as Error).message });
    }
  }));

  const relayBase = (PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const sseChannels = pods.map(p => ({
    pod: p.url,
    pod_slug: podSlug(p.url),
    sse_url: `${relayBase}/notifications/${podSlug(p.url)}`,
  }));

  return JSON.stringify({
    total: pods.length,
    subscribed,
    skipped,
    failed,
    failures: failures.length > 0 ? failures : undefined,
    sse_channels: sseChannels,
  });
}

// ── Identity / wallet — stubs on the remote OAuth surface ───
//
// setup_identity and link_wallet are designed for the local stdio MCP
// context where the agent can drive identity provisioning + wallet
// signing flows. On the remote relay the user is already identified
// via OAuth (their pod, WebID, agent IRI, and credentials are bound
// to the access token), so these tools have no useful work to do
// here. Returning a clear redirect message keeps the tool surface
// uniform across both servers while pointing the agent at the right
// place to manage credentials.

async function handleSetupIdentity(args: ToolArgs): Promise<string> {
  const userId = (args.agent_id as string | undefined) ?? '(unknown user)';
  return JSON.stringify({
    skipped: true,
    reason: 'already-identified-via-oauth',
    message: `You're already identified on this relay as ${userId} via OAuth. ` +
      `The setup_identity/link_wallet tools are only meaningful in the local stdio MCP ` +
      `context where the agent has direct access to your wallet keystore. To manage your ` +
      `wallet, use the local stdio MCP server (Claude Desktop / Claude Code) or the ` +
      `relay's /auth-methods/me endpoint to view your registered credentials.`,
  });
}

async function handleLinkWallet(args: ToolArgs): Promise<string> {
  const userId = (args.agent_id as string | undefined) ?? '(unknown user)';
  return JSON.stringify({
    skipped: true,
    reason: 'already-identified-via-oauth',
    message: `You're already identified on this relay as ${userId} via OAuth. ` +
      `The setup_identity/link_wallet tools are only meaningful in the local stdio MCP ` +
      `context where the agent has direct access to your wallet keystore. To manage your ` +
      `wallet, use the local stdio MCP server (Claude Desktop / Claude Code) or the ` +
      `relay's /auth-methods/me endpoint to view your registered credentials.`,
  });
}

// ── Wallet — read-only balance check ────────────────────────

async function handleCheckBalance(args: ToolArgs): Promise<string> {
  const chain = getChainConfig();

  if (chain.mode === 'local') {
    return JSON.stringify({
      chain: { mode: chain.mode, chainId: chain.chainId },
      message: 'Chain mode is local — no blockchain connection. Set CG_CHAIN=base-sepolia or CG_CHAIN=base for on-chain operations.',
    });
  }

  // Address resolution: explicit arg wins, otherwise fall back to the
  // relay's compliance wallet (loaded lazily on first compliance publish).
  let address = (args.address as string | undefined);
  if (!address) {
    try {
      const cw = await ensureRelayComplianceWallet();
      address = cw.wallet.address;
    } catch (err) {
      return JSON.stringify({
        error: 'no-address',
        message: `No address provided and relay compliance wallet unavailable: ${(err as Error).message}. ` +
          `Pass an explicit { "address": "0x..." } argument.`,
      });
    }
  }

  const balance = await checkBalance(address);
  return JSON.stringify({
    wallet: balance.address,
    chain: { mode: chain.mode, chainId: chain.chainId },
    balance: balance.balance,
    funded: balance.funded,
    sufficient: balance.sufficient,
    fundingInstructions: balance.fundingInstructions,
  });
}

// ── Comprehension — cognitive strategy for a question ───────

async function handleAnalyzeQuestion(args: ToolArgs): Promise<string> {
  const question = args.question as string;
  const sessionContent = args.session_content as string | undefined;
  const strategy = computeCognitiveStrategy(question);

  let abstainInfo: { abstain: boolean; missingEntities: string[]; matchRatio: number } | undefined;
  if (sessionContent) {
    const sessionExtr = extractEntities(sessionContent);
    const sessionEntities = new Set(sessionExtr.allEntities.map(e => e.toLowerCase()));
    abstainInfo = shouldAbstain(
      [...strategy.entities.contentWords],
      sessionEntities,
    );
  }

  return JSON.stringify({
    questionType: strategy.questionType,
    strategy: abstainInfo?.abstain ? 'abstain' : strategy.strategy,
    requiresComputation: strategy.requiresComputation,
    computationType: strategy.computationType,
    entities: {
      contentWords: strategy.entities.contentWords,
      nounPhrases: strategy.entities.nounPhrases,
    },
    confidence: strategy.confidence,
    abstention: abstainInfo,
  });
}

// ── Interrogative router — runtime realization of the ie: grammar ──────
//
// Turns the published Interego Interrogatives Core Ontology (ie:) into a read:
// classify a question into interrogative type(s), then PROJECT the answering
// facet(s) already present on a context descriptor. Pure routing lives in
// @interego/pgsl (interrogative-router.ts, drift-guarded against docs/ns); this
// handler is a thin composer over the EXISTING get_descriptor read. Read-only.
async function handleInterrogativeRoute(args: ToolArgs): Promise<string> {
  const question = typeof args.question === 'string' ? args.question : undefined;
  const interrogatives = args.interrogatives as string | string[] | undefined;
  const all = args.all === true;
  const hasInterro = interrogatives !== undefined &&
    (Array.isArray(interrogatives) ? interrogatives.length > 0 : String(interrogatives).trim() !== '');
  // Gate BEFORE any fetch — don't read a descriptor we have nothing to ask of.
  if (!question?.trim() && !hasInterro && !all) {
    return JSON.stringify({ error: 'specify a `question`, an `interrogatives` list, or `all:true`', interrogatives: [...CANONICAL_ORDER] });
  }
  const target = (typeof args.target === 'string' && args.target) ? args.target
    : (typeof args.url === 'string' ? args.url : undefined);
  if (!target) {
    return JSON.stringify({ error: 'a descriptor `url` (or `target`) is required — pick one via discover_context / discover_all first' });
  }
  // Compose the EXISTING descriptor read (same normalize/fetch/decrypt/cache/auth path).
  const descJson = JSON.parse(await handleGetDescriptor({ url: target, bypass_cache: args.bypass_cache } as ToolArgs)) as Record<string, unknown>;
  if (descJson.error) return JSON.stringify({ error: `could not read descriptor: ${String(descJson.error)}`, target });
  const turtle: string | undefined =
    typeof descJson.turtle === 'string' ? descJson.turtle
      : (descJson.encrypted !== true && typeof descJson.content === 'string') ? descJson.content
        : undefined;
  if (!turtle) {
    return JSON.stringify({
      error: 'descriptor-not-parseable', target, targetKind: 'descriptor',
      reason: descJson.encrypted === true
        ? 'the descriptor graph is encrypted and not decryptable by this relay key'
        : 'no turtle/content in the descriptor response',
    });
  }
  const result = routeInterrogatives({
    turtle, question, interrogatives, all,
    authorship: descJson.authorship as { effectiveTrustLevel?: string; authorshipVerified?: boolean; signedBy?: string } | undefined,
    target,
  });
  return JSON.stringify(result);
}

// ── PGSL — compatibility shims composed over the kernel ────────────────
//
// Every pgsl_* tool here is a thin compatibility shim. The wire shape
// (inputs + outputs) is preserved unchanged for existing clients
// (ChatGPT, Claude, Cursor); only the internal routing has been
// rewritten to compose against the KERNEL'S PGSL singleton — the one
// the kernel's LatticeAdapter owns — instead of a relay-private
// `createPGSL(...)` instance. The previous parallel-state shim meant
// a URI minted by `pgsl_ingest` here was invisible to
// `kernel.dereference`; that contract is now restored.
//
// Composition strategy:
//   - per-URI lookups go through kernel verbs (`kernelDereference`,
//     `kernelDecompose`) so callers see the adapter's authoritative
//     view.
//   - structural helpers the kernel does not surface as verbs
//     (`embedInPGSL` tokenization, `liftToDescriptor`, `latticeStats`,
//     `latticeMeet`, `pgslToTurtle`) operate on the kernel-owned
//     singleton via `getKernelPGSL(pgslProvenance)`. That singleton
//     is the same PGSLInstance the adapter mutates inside
//     `kernel.mint` / `kernel.promote`, so writes from any path are
//     visible to reads from every path.

async function handlePgslIngest(args: ToolArgs): Promise<string> {
  const content = args.content as string;
  // Tokenize + ingest into the kernel-owned lattice. `embedInPGSL`
  // routes through the same `ingest` primitive the kernel adapter's
  // `promote` verb uses, so the resulting apex IRI is the one the
  // kernel will subsequently `dereference` / `decompose`.
  const pgsl = getKernelPGSL(pgslProvenance);
  const topUri = embedInPGSL(pgsl, content);

  // Read-back via kernel verb confirms the URI is live on the
  // substrate (kernel.dereference now finds shim-minted URIs because
  // there is only one PGSL).
  const deref = await kernelDereference(topUri);
  const adapterView = deref.status === 'ok' ? deref : null;

  const resolved = pgslResolve(pgsl, topUri);
  const stats = latticeStats(pgsl);

  const result: Record<string, unknown> = {
    ingested: true,
    topUri,
    resolved,
    stats,
  };
  // Additive only — historical fields above are unchanged. Kernel
  // affordances are surfaced as a sibling so hypermedia-aware clients
  // can follow them; legacy clients ignore the new key.
  if (adapterView) {
    result.kernelAffordances = adapterView.affordances;
  }

  // Optional: lift to a context descriptor and publish to the user's pod.
  // Mirrors toolPgslIngest in the stdio server, but uses the authenticated
  // user's WebID + agent from the relay's authContext-injected args.
  if (args.publish_to_pod) {
    const podName = (args.pod_name as string) ?? 'default';
    const podUrl = `${CSS_URL}${podName}/`;
    const ownerWebId = (args.owner_webid as string) ?? `https://id.example.com/${podName}/profile#me`;
    const agentId = (args.agent_id as string) ?? 'urn:agent:remote:unknown';
    const now = new Date().toISOString();

    try {
      const desc = liftToDescriptor(
        pgsl,
        topUri,
        `urn:iep:${podName}:pgsl:${Date.now()}` as IRI,
        [{
          type: 'Temporal',
          validFrom: now,
        }, {
          type: 'Provenance',
          wasAttributedTo: ownerWebId as IRI,
          generatedAtTime: now,
          wasGeneratedBy: { agent: agentId as IRI, endedAt: now },
        }],
      );
      const turtle = pgslToTurtle(pgsl);
      const publishResult = await publish(desc, turtle, podUrl, { fetch: solidFetch });
      result.publishedDescriptorUrl = publishResult.descriptorUrl;
    } catch (err) {
      result.publishError = (err as Error).message;
    }
  }

  return JSON.stringify(result);
}

async function handlePgslResolve(args: ToolArgs): Promise<string> {
  const uri = args.uri as IRI;

  // Route resolution through the kernel verb so the shim and any
  // direct `dereference` caller see the same source of truth.
  const deref = await kernelDereference(uri);
  if (deref.status !== 'ok') {
    return JSON.stringify({ error: `Not found: ${uri}` });
  }

  const pgsl = getKernelPGSL(pgslProvenance);
  const node = pgsl.nodes.get(uri);
  if (!node) {
    // Defensive: kernel reported ok but the singleton lost track.
    // Treat as not-found to preserve the legacy wire response.
    return JSON.stringify({ error: `Not found: ${uri}` });
  }
  const resolved = pgslResolve(pgsl, uri);
  const base: Record<string, unknown> = {
    uri,
    resolved,
    kind: node.kind,
    provenance: {
      wasAttributedTo: node.provenance.wasAttributedTo,
      generatedAtTime: node.provenance.generatedAtTime,
    },
  };
  if (node.kind === 'Atom') {
    base.level = 0;
    base.value = node.value;
  } else {
    base.level = node.level;
    base.itemCount = node.items.length;
    if (node.left) base.left = node.left;
    if (node.right) base.right = node.right;
    // Overlap comes from the kernel verb — the same pullback square
    // kernel.decompose surfaces to direct callers.
    const dec = kernelDecompose(uri);
    if (dec) base.overlap = dec.overlap;
  }
  return JSON.stringify(base);
}

async function handlePgslLatticeStatus(_args: ToolArgs): Promise<string> {
  // No kernel verb returns lattice statistics — this is observability
  // over the singleton, not a substrate primitive. Read directly from
  // the kernel-owned instance.
  return JSON.stringify(latticeStats(getKernelPGSL(pgslProvenance)));
}

async function handlePgslMeet(args: ToolArgs): Promise<string> {
  const uriA = args.uri_a as IRI;
  const uriB = args.uri_b as IRI;
  const pgsl = getKernelPGSL(pgslProvenance);
  const meet = latticeMeet(pgsl, uriA, uriB);
  if (!meet) {
    return JSON.stringify({
      meet: null,
      message: `No shared sub-fragment between ${uriA} and ${uriB}`,
    });
  }
  return JSON.stringify({
    meet,
    resolved: pgslResolve(pgsl, meet),
    a: uriA,
    b: uriB,
  });
}

async function handlePgslToTurtle(_args: ToolArgs): Promise<string> {
  return JSON.stringify({ turtle: pgslToTurtle(getKernelPGSL(pgslProvenance)) });
}

// ── get_current_head ────────────────────────────────────────
//
// Returns the current chain head for a given urn:graph IRI — the
// descriptorUrl plus the content-CID of that descriptor's Turtle. Used
// as the read half of a CAS supersession chain: a multi-writer
// composition flow calls get_current_head first to obtain the
// `if_match` token, builds the new descriptor, and posts publish_context
// with that token. If a competing writer republished the same graph_iri
// in between, the substrate-level precondition gate at
// packages/solid/src/client.ts rejects with 412 and the caller re-reads.
//
// Resolution strategy:
//   1. Read the pod's .well-known/context-graphs manifest (cache-bypassed
//      so we observe fresh server state).
//   2. Filter to entries whose iep:describes contains the supplied urn.
//   3. Pick the entry that is NOT supersededBy any other entry — i.e.
//      the chain HEAD. If multiple unsuperseded entries exist (the
//      forked-chain symptom this fix is meant to prevent), all are
//      returned so the caller can see the divergence.
//   4. GET the descriptor Turtle, compute computeCid.
async function handleGetCurrentHead(args: ToolArgs): Promise<string> {
  const urn = args.urn as string | undefined;
  if (!urn) {
    return JSON.stringify({ error: 'urn is required' });
  }
  const podName = (args.pod_name as string) ?? 'default';
  const rawPodUrl = (args.pod_url as string) ?? `${CSS_URL}${podName}/`;
  const podUrl = rawPodUrl.endsWith('/') ? rawPodUrl : `${rawPodUrl}/`;
  // Read freshest manifest — bypass the cache so concurrent writers see
  // each other's just-published HEAD on the next get_current_head call.
  manifestCache.delete(podUrl);
  let entries: ManifestEntry[] = [];
  try {
    entries = await getCachedManifest(podUrl);
  } catch (err) {
    return JSON.stringify({ error: `Could not read manifest from ${podUrl}: ${(err as Error).message}` });
  }

  const describing = entries.filter((e) => e.describes.includes(urn as IRI));
  if (describing.length === 0) {
    return JSON.stringify({ urn, podUrl, head: null, message: 'No descriptor on this pod describes the requested urn.' });
  }
  // An entry is a chain head iff no other entry's iep:supersedes points
  // at it. The manifest mirrors iep:supersedes (see manifestEntryTurtle),
  // so we can compute this without fetching descriptors.
  const superseded = new Set<string>();
  for (const e of describing) {
    for (const s of (e.supersedes ?? [])) {
      superseded.add(s);
    }
  }
  const heads = describing.filter((e) => !superseded.has(e.descriptorUrl));
  // Compute CIDs for each candidate head. If there are multiple, the
  // chain has forked — the caller needs to see all of them.
  //
  // Manifest fast-path: post-fix manifest entries carry `iep:contentCid`
  // mirroring the descriptor's content-CID, so the head CID is already
  // known from the single manifest GET above — no need to body-fetch +
  // rehash each candidate. Legacy entries (no mirror) fall through to
  // the descriptor body GET so the response shape is identical either
  // way. Same source-of-truth the Phase-A precondition uses, so
  // `get_current_head` → `if_match` → `precondition_pass` round-trips
  // without a single descriptor body read on the happy path.
  const headResults = await Promise.all(
    heads.map(async (h) => {
      if (h.cid) {
        return { descriptorUrl: h.descriptorUrl, cid: h.cid };
      }
      try {
        const resp = await solidFetch(h.descriptorUrl, {
          method: 'GET',
          headers: { 'Accept': 'text/turtle', 'Cache-Control': 'no-cache' },
        });
        if (!resp.ok) {
          return { descriptorUrl: h.descriptorUrl, cid: null, error: `${resp.status} ${resp.statusText}` };
        }
        const turtle = await resp.text();
        return { descriptorUrl: h.descriptorUrl, cid: cryptoComputeCid(turtle) };
      } catch (err) {
        return { descriptorUrl: h.descriptorUrl, cid: null, error: (err as Error).message };
      }
    }),
  );
  if (headResults.length === 0) {
    // All describing entries have been superseded by something — pick
    // the most-recent superseder (i.e. an entry that's both describing
    // AND that supersedes another describing entry, and isn't itself
    // superseded by anything in the describing set). Edge case: if every
    // describing entry has been superseded by entries OUTSIDE the
    // describing set, fall back to the lexicographic max of describing
    // entries as a best-effort tip.
    return JSON.stringify({ urn, podUrl, head: null, forked: false, message: 'All descriptors describing this urn are superseded; no current head.' });
  }
  const forked = headResults.length > 1;
  return JSON.stringify({
    urn,
    podUrl,
    head: forked ? null : headResults[0],
    heads: forked ? headResults : undefined,
    forked,
    message: forked
      ? `Chain has ${headResults.length} unresolved heads (forked supersession chain — likely a missed CAS). Pick one as if_match or compose them.`
      : undefined,
  });
}

// ── Generic affordance follower ─────────────────────────────
//
// Proxies a `iep:Affordance` invocation through the MCP layer so a single
// Interego connector reaches any vertical's affordances (Foxxi, LRS, OWM,
// ADP, AC, LPC, ...) without installing the per-vertical bridge. Discover
// available actions via `discover_context` + `get_descriptor`; this handler
// performs the descriptor fetch + match + HTTP POST in one shot.
async function handleInvokeAffordance(args: ToolArgs): Promise<string> {
  // Compatibility shim — internally a kernel `act` call. Wire format
  // unchanged: descriptor_url + action_iri + payload + authorization
  // map onto the kernel's affordance-resolved form, and the kernel
  // returns the same fields the legacy followAffordance did.
  // Translate legacy public-host CSS URLs at the handler boundary so the
  // affordance fetch + match targets the canonical internal-FQDN.
  // solidFetch ALSO rewrites at the HTTP layer.
  const descriptorUrl = normalizeCssUrl(args.descriptor_url as string);
  const actionIri = args.action_iri as string;
  // Same connector double-encode tolerance as handleKernelAct (this shim is an
  // internal `act`): peel a redundantly-quoted payload before invoking.
  const payload = normalizeActPayload(args.payload ?? {});
  const authorization = args.authorization as string | undefined;
  if (!descriptorUrl) throw new Error('invoke_affordance: descriptor_url is required');
  if (!actionIri) throw new Error('invoke_affordance: action_iri is required');
  // AMEP same-origin session bridge (same as handleKernelAct): reuse the caller's
  // verified session for an act that targets the relay's own /amep.
  const { fetch: invFetch, payload: invPayload } = withAmepSession(
    descriptorUrl,
    payload,
    {
      sessionBearer: args['_session_bearer'] as string | undefined,
      principalId: args['_session_principal'] as string | undefined,
      explicitAuth: authorization,
    },
    // guardedInvokeFetch: every fetch in the follow chain (descriptor,
    // resolved hydra:target, envelope) passes the SSRF screen.
    { solidFetch: guardedInvokeFetch, publicBaseUrl: PUBLIC_BASE_URL },
  );
  // Pass `recipientKeyPair` so `iep:canDecrypt` affordances return
  // plaintext to authorized recipients (the relay's session agent is in
  // the envelope's recipient set whenever it published or was added as
  // a share target). Non-recipients fall through and see the raw
  // envelope as today.
  const result = await kernelAct(
    { descriptorUrl, actionIri },
    invPayload,
    {
      fetch: invFetch,
      recipientKeyPair: relayAgentKey,
      ...(authorization ? { authorization } : {}),
    },
  );
  return JSON.stringify(result);
}

// ── Tool Registry ───────────────────────────────────────────

// ── Kernel-verb relay handlers ────────────────────────────────
//
// Thin JSON-adapter wrappers around the @interego/core kernel
// exports. The kernel is the substrate surface; these are MCP-side
// argument adapters. See docs/ARCHITECTURAL-FOUNDATIONS.md §11.
async function handleKernelMint(args: ToolArgs): Promise<string> {
  const content = args['content'];
  const kind = args['kind'] as ('atom' | 'fragment' | 'descriptor' | 'opaque' | undefined);
  const r = kernelMint(content, kind ? { kind } : undefined);
  // The advertised affordances MUST be invokable through `act` against the
  // minted holon's IRI. `act` routes urn:pgsl:* targets through
  // actOnLatticeNode, which dispatches only on the canonical
  // `urn:iep:action:kernel:{dereference,decompose,promote}` action IRIs and
  // expects the holon IRI itself as the target. The previous
  // `urn:iep:action:{dereference,promote,decompose}` action IRIs plus the
  // bogus `urn:iep:tool:promote` / `urn:iep:tool:decompose` targets broke the
  // hypermedia round-trip (act → 405 unsupported_action_on_lattice_target).
  return JSON.stringify(decorateKernelResult(r as unknown as Record<string, unknown>, {
    kind: 'mint',
    id: r.holon.iri,
    nextSteps: [
      { action: 'urn:iep:action:kernel:dereference', target: r.holon.iri, method: 'GET' },
      { action: 'urn:iep:action:kernel:promote',     target: r.holon.iri, method: 'POST' },
      { action: 'urn:iep:action:kernel:decompose',   target: r.holon.iri, method: 'POST' },
    ],
  }));
}
async function handleKernelDereference(args: ToolArgs): Promise<string> {
  // Translate legacy public-host CSS URLs at the handler boundary so the
  // kernel sees the canonical internal-FQDN. solidFetch (the kernel's
  // fetch) ALSO rewrites at the HTTP layer (belt-and-suspenders), but
  // doing it here means logs / decorated affordances / URN→URL hints
  // also reflect the canonical target. URN inputs (`urn:graph:*`,
  // `urn:pgsl:*`) pass through unchanged.
  const iri = normalizeCssUrl(String(args['iri'] ?? ''));
  const decorateManifest = args['decorate_manifest'] !== false;
  // Pass `recipientKeyPair` so envelopes addressed to the relay's agent
  // round-trip to plaintext for the calling user — mirrors the existing
  // handleGetDescriptor pattern. Without this, every encrypted target
  // returns `status: 'encrypted-no-key'` even though the relay holds the
  // wrapped key (the calling agent is in the recipient set by virtue of
  // being a delegate of the pod owner who published).
  //
  // For `urn:graph:*` IRIs the kernel needs at least one pod URL to scan
  // for the URN's descriptor. We supply the caller's own pod first
  // (`podHint`) and then the union of every pod the relay has learned
  // about (`knownPods` — the same map that backs list_known_pods +
  // discover_all). This closes the URN→URL hypermedia leg end-to-end
  // so callers can deref `urn:graph:*` without first walking a manifest.
  const podHint = await selfPodUrl(args).catch(() => undefined);
  const knownPodUrls = Array.from(knownPods.values()).map(e => e.url);
  const r = await kernelDereference(iri, {
    // guardedInvokeFetch: kernel_dereference fetches a CALLER-SUPPLIED IRI and
    // echoes the representation back — the same SSRF screen as the affordance
    // follow chain applies (internal hosts / IMDS / private ranges rejected).
    fetch: guardedInvokeFetch,
    decorateManifest,
    recipientKeyPair: relayAgentKey,
    ...(podHint ? { podHint } : {}),
    ...(knownPodUrls.length > 0 ? { knownPods: knownPodUrls } : {}),
  });
  return JSON.stringify(decorateKernelResult(r as unknown as Record<string, unknown>, {
    kind: 'dereference',
    id: iri,
    existing: r.affordances,
  }));
}
async function handleKernelCompose(args: ToolArgs): Promise<string> {
  const descriptors = (args['descriptors'] as ContextDescriptorData[]) ?? [];
  const operator = args['operator'] as 'union' | 'intersection' | 'restriction' | 'override';
  const types = args['types'] as string[] | undefined;
  const r = kernelCompose(descriptors, operator, types ? ({ types } as Parameters<typeof kernelCompose>[2]) : undefined);
  return JSON.stringify(decorateKernelResult(r as unknown as Record<string, unknown>, {
    kind: 'compose',
    id: r.composed.id,
    nextSteps: [
      { action: 'urn:iep:action:restrict', target: 'urn:iep:tool:restrict', method: 'POST' },
      { action: 'urn:iep:action:publish',  target: 'urn:iep:tool:publish_context', method: 'POST' },
    ],
  }));
}
/** Defensive tolerance for MCP connectors that DOUBLE-ENCODE a nested `payload`
 *  arg (JSON.stringify an already-JSON string), so the relay receives a quoted
 *  JSON string instead of the object/JSON it should. The kernel `act` +
 *  `followAffordance` serializers are correct (they send a string body AS-IS),
 *  but that means a connector's extra encode is faithfully forwarded and the
 *  target's strict JSON body-parser 400s — silently dead-lettering cross-agent
 *  act calls (f-act-payload-double-encode, connector-side). If the payload is a
 *  string that parses to ANOTHER string, peel the redundant layer(s); objects
 *  and correctly single-encoded JSON-object strings are returned untouched. */
function normalizeActPayload(payload: unknown): unknown {
  let v: unknown = payload;
  // Peel up to a few redundant JSON-string wrappings a connector may have added.
  // A correctly-encoded body is either an OBJECT (act stringifies it once) or raw
  // JSON text starting with '{'/'[' (act sends a string as-is). Only a QUOTED
  // string ('"…') is an over-encoded layer to peel. Stop at the first object or
  // raw-JSON-text we reach. Robust to single/double/triple quoting + whitespace.
  for (let i = 0; i < 6; i++) {
    if (typeof v !== 'string') return v;            // object/array → act stringifies once
    const t = v.trim();
    if (!t || t[0] !== '"') return v;               // raw JSON text or plain string → as-is
    try {
      v = JSON.parse(t);                            // peel one quote layer
    } catch {
      return v;                                     // unparseable → leave untouched
    }
  }
  return v;
}

async function handleKernelAct(args: ToolArgs): Promise<string> {
  // Translate legacy public-host CSS URLs at the handler boundary so the
  // act-via-descriptor + act-via-affordance paths both target the
  // canonical internal-FQDN. solidFetch ALSO rewrites at the HTTP layer.
  const descriptorUrlRaw = args['descriptor_url'] as string | undefined;
  const descriptorUrl = descriptorUrlRaw ? normalizeCssUrl(descriptorUrlRaw) : undefined;
  const actionIri = args['action_iri'] as string | undefined;
  const authorization = args['authorization'] as string | undefined;
  const targetRaw = args['target'] as string | undefined;
  const affordance = descriptorUrl && actionIri
    ? { descriptorUrl, actionIri }
    : {
        action: (args['action'] as string | undefined) ?? actionIri ?? '',
        target: targetRaw ? normalizeCssUrl(targetRaw) : '',
        method: (args['method'] as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | undefined) ?? 'POST',
        ...(args['media_type'] ? { mediaType: args['media_type'] as string } : {}),
      };
  // Pass the relay's session key as recipient so a `iep:canDecrypt`
  // affordance returns plaintext when the relay's agent is in the
  // envelope's recipient set. Non-recipients fall through and see the
  // raw envelope as today.
  // Diagnostic (f-act-payload-double-encode): capture the EXACT shape of the
  // incoming payload so a connector's over-encoding is visible in the relay log
  // without guessing. Logs structure only (first 80 chars), not full signed
  // content. Lets us confirm whether normalization fires for real connector traffic.
  const rawPayload = args['payload'];
  const normPayload = normalizeActPayload(rawPayload);
  try {
    if (typeof rawPayload === 'string') {
      log(`[act-payload-diag] type=string len=${rawPayload.length} normalized=${rawPayload !== normPayload} rawHead=${JSON.stringify(rawPayload.slice(0, 80))} normHead=${JSON.stringify(String(typeof normPayload === 'string' ? normPayload : JSON.stringify(normPayload)).slice(0, 80))}`);
    } else {
      log(`[act-payload-diag] type=${typeof rawPayload} keys=${rawPayload && typeof rawPayload === 'object' ? Object.keys(rawPayload as object).slice(0, 6).join(',') : '-'}`);
    }
  } catch { /* logging must never break the call */ }
  // AMEP same-origin session bridge: when this act targets the relay's own
  // /amep, reuse the caller's verified session (auto-forward the bearer + stamp
  // act.actor) so an OAuth user drives Compose/etc. without a pasted credential.
  const { fetch: actFetch, payload: actPayload } = withAmepSession(
    descriptorUrl ?? targetRaw ?? '',
    normPayload,
    {
      sessionBearer: args['_session_bearer'] as string | undefined,
      principalId: args['_session_principal'] as string | undefined,
      explicitAuth: authorization,
    },
    // guardedInvokeFetch: the kernel-act follow chain passes the SSRF screen.
    { solidFetch: guardedInvokeFetch, publicBaseUrl: PUBLIC_BASE_URL },
  );
  const r = await kernelAct(affordance as Parameters<typeof kernelAct>[0], actPayload, {
    fetch: actFetch,
    recipientKeyPair: relayAgentKey,
    ...(authorization ? { authorization } : {}),
  });
  return JSON.stringify(decorateKernelResult(r as unknown as Record<string, unknown>, {
    kind: 'act',
    id: r.affordance.target,
    existing: [r.affordance],
  }));
}
async function handleKernelRestrict(args: ToolArgs): Promise<string> {
  const descriptor = args['descriptor'] as ContextDescriptorData;
  const selector = args['selector'] as Parameters<typeof kernelRestrict>[1];
  const r = kernelRestrict(descriptor, selector);
  return JSON.stringify(decorateKernelResult(r as unknown as Record<string, unknown>, {
    kind: 'restrict',
    id: r.restricted.id,
    nextSteps: [
      { action: 'urn:iep:action:extend',  target: 'urn:iep:tool:extend',  method: 'POST' },
      { action: 'urn:iep:action:publish', target: 'urn:iep:tool:publish_context', method: 'POST' },
    ],
  }));
}
async function handleKernelExtend(args: ToolArgs): Promise<string> {
  const part = args['part'] as ContextDescriptorData;
  const whole = args['whole'] as ContextDescriptorData;
  const preserveWitness = args['preserve_witness'] !== false;
  const r = kernelExtend(part, whole, { preserveWitness });
  return JSON.stringify(decorateKernelResult(r as unknown as Record<string, unknown>, {
    kind: 'extend',
    id: r.extended.id,
    nextSteps: [
      { action: 'urn:iep:action:restrict', target: 'urn:iep:tool:restrict', method: 'POST' },
      { action: 'urn:iep:action:publish',  target: 'urn:iep:tool:publish_context', method: 'POST' },
    ],
  }));
}
async function handleKernelPromote(args: ToolArgs): Promise<string> {
  const atoms = (args['atoms'] ?? []) as Parameters<typeof kernelPromote>[0];
  const r = kernelPromote(atoms);
  // Same hypermedia contract as handleKernelMint: emit canonical
  // `urn:iep:action:kernel:*` action IRIs with the apex's urn:pgsl:* IRI as
  // the target so `act` round-trips through actOnLatticeNode cleanly.
  return JSON.stringify(decorateKernelResult(r as unknown as Record<string, unknown>, {
    kind: 'promote',
    id: r.apex,
    nextSteps: [
      { action: 'urn:iep:action:kernel:dereference', target: r.apex, method: 'GET' },
      { action: 'urn:iep:action:kernel:decompose',   target: r.apex, method: 'POST' },
    ],
  }));
}
async function handleKernelDecompose(args: ToolArgs): Promise<string> {
  const iri = String(args['iri'] ?? '') as Parameters<typeof kernelDecompose>[0];
  const r = kernelDecompose(iri);
  // Decompose constituents are urn:pgsl:* IRIs so the advertised
  // dereference affordances must use the kernel-prefixed action IRI
  // for `act` to dispatch through actOnLatticeNode.
  if (r === null) {
    return JSON.stringify(decorateKernelResult({ result: null, iri }, {
      kind: 'decompose',
      id: iri,
      nextSteps: [
        { action: 'urn:iep:action:kernel:dereference', target: iri, method: 'GET' },
      ],
    }));
  }
  return JSON.stringify(decorateKernelResult(r as unknown as Record<string, unknown>, {
    kind: 'decompose',
    id: r.apex,
    nextSteps: [
      { action: 'urn:iep:action:kernel:dereference', target: r.left,    method: 'GET' },
      { action: 'urn:iep:action:kernel:dereference', target: r.right,   method: 'GET' },
      { action: 'urn:iep:action:kernel:dereference', target: r.overlap, method: 'GET' },
    ],
  }));
}

// Kernel verb #9 — reduce a iep:supersedes chain through a declarative
// reducer and return the canonical state + a content-addressed
// ReplayProof. The reducer is either inlined (turtle-template /
// shacl-transform body) OR resolved via `iep:reducer <iri>` declared
// on the chain head. The fold is the colimit of the chain in the
// supersession category; the ReplayProof lets any third party
// independently re-fetch by CID and replay.
async function handleKernelReduceChain(args: ToolArgs): Promise<string> {
  const chainIri = normalizeCssUrl(String(args['chain_iri'] ?? '')) as IRI;
  if (!chainIri) {
    return JSON.stringify({
      error: 'chain_iri is required',
      detail: 'reduce_chain folds a iep:supersedes chain — supply the chain HEAD IRI as `chain_iri`.',
    });
  }

  // Reducer resolution: either inline reducer_spec wins, or
  // reducer_iri is dereferenced and its body classified, or the
  // kernel reads `iep:reducer` off the chain head.
  let reducerSpec: ReducerSpec | undefined;
  const inline = args['reducer_spec'] as
    | { kind: 'turtle-template'; template: string }
    | { kind: 'shacl-transform'; shape: string }
    | undefined;
  if (inline && (inline.kind === 'turtle-template' || inline.kind === 'shacl-transform')) {
    reducerSpec = inline;
  } else {
    const reducerIri = args['reducer_iri'] as string | undefined;
    if (reducerIri) {
      const r = await kernelDereference(normalizeCssUrl(reducerIri), {
        // guardedInvokeFetch: reducer_iri is caller-supplied and its body is
        // interpreted — same SSRF screen as the follow chain.
        fetch: guardedInvokeFetch,
        recipientKeyPair: relayAgentKey,
      });
      if (r.status === 'ok' && r.representation !== undefined) {
        const body = r.representation;
        reducerSpec = /\bsh:\w+|sh:rule|sh:construct/i.test(body)
          ? { kind: 'shacl-transform', shape: body }
          : { kind: 'turtle-template', template: body };
      }
    }
  }

  // Caller-supplied bounds, with sensible defaults.
  const maxChain = typeof args['max_chain'] === 'number' ? args['max_chain'] as number : undefined;
  const checkpointEvery = typeof args['checkpoint_every'] === 'number' ? args['checkpoint_every'] as number : undefined;
  // Traversal mode — 'shortest' (default, breadth-shortest path) or
  // 'full' (transitive supersedes closure sorted by validFrom). The
  // 'full' mode is the one a lineage-audit caller wants when
  // auto_supersede_prior writes ALL priors per version.
  const traversalRaw = args['traversal'];
  const traversal: 'shortest' | 'full' | undefined =
    traversalRaw === 'shortest' || traversalRaw === 'full' ? traversalRaw : undefined;

  try {
    // Resolve each chain link through the kernel's own dereference
    // so the relay's solidFetch (URL rewriting, retries, agent key
    // for decrypt) participates in the walk.
    const linkFetch = async (iri: IRI): Promise<string | null> => {
      const r = await kernelDereference(iri, {
        // guardedInvokeFetch: chain links start from a caller-supplied head
        // IRI and are echoed into the fold — screened like every invoke fetch.
        fetch: guardedInvokeFetch,
        recipientKeyPair: relayAgentKey,
      });
      if (r.status !== 'ok' || r.representation === undefined) return null;
      return r.representation;
    };
    const opts: Parameters<typeof kernelReduce>[1] = {
      fetch: linkFetch,
      ...(reducerSpec ? { reducerSpec } : {}),
      ...(typeof maxChain === 'number' ? { maxChain } : {}),
      ...(typeof checkpointEvery === 'number' ? { checkpointEvery } : {}),
      ...(traversal ? { traversal } : {}),
    };
    const r = await kernelReduce(chainIri, opts);
    return JSON.stringify(decorateKernelResult(r as unknown as Record<string, unknown>, {
      kind: 'reduce',
      id: chainIri,
      // Next-step affordance: any reducer-aware client can re-call
      // reduce_chain on the same head and verify by comparing the
      // replayProof.headStateCid.
      nextSteps: [
        { action: 'urn:iep:action:kernel:dereference', target: chainIri, method: 'GET' },
      ],
    }));
  } catch (err) {
    return JSON.stringify({
      error: 'reduce_failed',
      detail: (err as Error).message ?? String(err),
      chain_iri: chainIri,
    });
  }
}

const TOOLS: Record<string, { description: string; handler: (args: ToolArgs) => Promise<string> }> = {
  // ── Kernel verbs (first-class substrate access) ──
  // These delegate straight to @interego/core kernel exports. The 27
  // named tools below remain wire-compatible compatibility shims.
  mint: { description: 'Kernel verb — mint a holon (content-addressed identity)', handler: handleKernelMint },
  dereference: { description: 'Kernel verb — resolve an IRI to representation + affordances', handler: handleKernelDereference },
  compose: { description: 'Kernel verb — operadic composition (union/intersection/restriction/override)', handler: handleKernelCompose },
  act: { description: 'Kernel verb — follow an affordance (Peircean Thirdness operational)', handler: handleKernelAct },
  restrict: { description: 'Kernel verb — adjunction left half (whole → part)', handler: handleKernelRestrict },
  extend: { description: 'Kernel verb — adjunction right half (part → whole)', handler: handleKernelExtend },
  promote: { description: 'Kernel verb — PGSL fibration vertical movement upward', handler: handleKernelPromote },
  decompose: { description: 'Kernel verb — PGSL fibration vertical movement downward', handler: handleKernelDecompose },
  reduce_chain: { description: 'Kernel verb — fold a iep:supersedes chain through a declarative reducer (turtle-template OR shacl-transform) and return the canonical head state + a content-addressed ReplayProof (chain CIDs, reducer CID, periodic state checkpoints, head-state CID) that any third party can use to independently re-fetch + re-fold + verify.', handler: handleKernelReduceChain },
  // ── Core tools (compatibility shims; internal implementation routes through kernel where natural) ──
  publish_context: { description: 'Publish a context-annotated knowledge graph', handler: handlePublishContext },
  record_trajectory_step: { description: 'Record one step of an agent\'s trajectory as a signed, content-addressed ContextDescriptor — substrate-native dogfood that turns the agent\'s own actions into discoverable evidence (later read by verifyCapabilityTransfer and the calibration loop)', handler: handleRecordTrajectoryStep },
  pgsl_decide: { description: 'OODA decision functor — returns the next-strategy recommendation (exploit / explore / delegate / abstain) for an agent based on its lattice observations + coherence with peers. The substrate-honest "decide" tool that closes the OODA tick.', handler: handlePgslDecide },
  get_current_head: { description: 'Resolve the current chain head (descriptorUrl + content-CID) for a urn:graph:* on a pod — used as the read half of CAS supersession', handler: handleGetCurrentHead },
  discover_context: { description: 'Discover descriptors on a pod', handler: handleDiscoverContext },
  get_descriptor: { description: 'Fetch a descriptor\'s Turtle', handler: handleGetDescriptor },
  get_pod_status: { description: 'Check pod status', handler: handleGetPodStatus },
  subscribe_to_pod: { description: 'Subscribe to pod notifications', handler: handleSubscribeToPod },
  register_agent: { description: 'Register an agent on a pod', handler: handleRegisterAgent },
  revoke_agent: { description: 'Revoke an agent delegation', handler: handleRevokeAgent },
  verify_agent: { description: 'Verify agent delegation', handler: handleVerifyAgent },
  // Federation tools
  discover_all: { description: 'Discover across all known pods', handler: handleDiscoverAll },
  list_known_pods: { description: 'List pods in the federation registry', handler: handleListKnownPods },
  add_pod: { description: 'Add a pod to the registry', handler: handleAddPod },
  remove_pod: { description: 'Remove a pod from the registry', handler: handleRemovePod },
  discover_directory: { description: 'Import pods from a directory graph', handler: handleDiscoverDirectory },
  publish_directory: { description: 'Publish pod registry as a directory', handler: handlePublishDirectory },
  resolve_webfinger: { description: 'Resolve WebFinger to find a pod', handler: handleResolveWebfinger },
  // Agent-to-agent messaging (Linked Data Notifications over Solid inboxes)
  notify_agent: { description: 'Send a notification to another agent (fans out across their declared channels: LDN inbox + any discord/telegram/email/sms/voice)', handler: handleNotifyAgent },
  read_inbox: { description: 'Read notifications delivered to your (or a given) pod\'s LDN inbox, newest-first', handler: handleReadInbox },
  sign_request: { description: 'Sign a payload as your bound identity (rev-196 envelope) so you can act on a signed-request affordance', handler: handleSignRequest },
  set_reachability: { description: 'Declare external reachability channels on your own agent card (discord/telegram/email/sms/voice)', handler: handleSetReachability },
  rebuild_manifest: { description: 'Reconstruct a pod\'s .well-known/context-graphs index from its on-pod descriptors (heals a collapsed/lost manifest; non-destructive)', handler: handleRebuildManifest },
  // Subscription management
  unsubscribe_from_pod: { description: 'Close an active WebSocket subscription on a pod', handler: handleUnsubscribeFromPod },
  subscribe_all: { description: 'Subscribe to notifications from all known pods', handler: handleSubscribeAll },
  // Onboarding / wallet (stubbed on the remote OAuth surface)
  setup_identity: { description: 'Identity onboarding (not applicable on remote relay — see message)', handler: handleSetupIdentity },
  link_wallet: { description: 'Link an Ethereum wallet (not applicable on remote relay — see message)', handler: handleLinkWallet },
  check_balance: { description: 'Check ETH balance for a wallet address', handler: handleCheckBalance },
  // Comprehension
  analyze_question: { description: 'Analyze a question to pick the optimal cognitive strategy', handler: handleAnalyzeQuestion },
  interrogative_route: { description: 'Route a question (or explicit interrogatives) to the descriptor facets that answer it — the ie: grammar (Who/What/When/Where/Why/How/Which/WhatKind/HowMuch/Whose/Whether) over a context descriptor. Read-only; composes get_descriptor.', handler: handleInterrogativeRoute },
  // PGSL lattice
  pgsl_ingest: { description: 'Ingest content into the PGSL lattice', handler: handlePgslIngest },
  pgsl_resolve: { description: 'Resolve a PGSL URI to its content + metadata', handler: handlePgslResolve },
  pgsl_lattice_status: { description: 'Report PGSL lattice statistics', handler: handlePgslLatticeStatus },
  pgsl_meet: { description: 'Compute the lattice meet of two PGSL fragments', handler: handlePgslMeet },
  pgsl_to_turtle: { description: 'Serialize the PGSL lattice as RDF Turtle', handler: handlePgslToTurtle },
  // Generic affordance follower (Path A — reach any vertical without per-vertical bridge)
  invoke_affordance: { description: 'Invoke a vertical affordance by descriptor URL + iep:action IRI', handler: handleInvokeAffordance },
  // Linked-data dereference for MCP-only clients (the tool-equivalent of GET <relay>/ns/<owner>/<slug>)
  resolve_linked_data: { description: 'Resolve a published /ns ontology/graph as content-negotiated linked data (Turtle/JSON-LD) — for MCP-only clients that cannot GET the URL directly', handler: handleResolveLinkedData },
};

// ── Tier-4: dynamic relay-tool registry over ac:AgentTool ────
//
// Tools authored via ac.author_tool, attested to threshold, and
// promoted to Asserted via ac.promote_tool can be loaded into the
// running relay's tool surface — without a redeploy. The substrate is
// using its own promote-by-attestation pipeline to grow the relay.
//
// Trust boundary: only ONE pod is scanned (RELAY_DYNAMIC_TOOLS_POD,
// default = the relay's own service pod). The pod owner controls
// what lives there; attestations are the gate-keeping mechanism, not
// the relay. Asserted modal status is REQUIRED — Hypothetical tools
// (newly authored, not yet attested to threshold) are not loaded.
//
// Handlers proxy through the affordance machinery: when a dynamic
// tool is invoked, the handler dereferences the descriptor and
// returns its iep:affordance block + body so the caller can follow it
// (or, when hydra:target is present, invokes it directly via
// kernelAct). Either way the relay never executes arbitrary code
// from a pod — the affordance is itself a hypermedia operation, not
// raw JS.
interface DynamicToolEntry {
  readonly description: string;
  readonly handler: (args: ToolArgs) => Promise<string>;
  readonly descriptorUrl: string;
  readonly affordanceAction?: string;
}
const dynamicTools = new Map<string, DynamicToolEntry>();
let dynamicToolsLastLoadedAt: string | null = null;
let dynamicToolsLastLoadCount = 0;
const RELAY_DYNAMIC_TOOLS_POD = process.env['RELAY_DYNAMIC_TOOLS_POD'];

/**
 * Discover Asserted ac:AgentTool descriptors on the configured pod
 * and register them as runtime-loaded MCP tools. Idempotent: re-runs
 * replace the existing dynamicTools registry wholesale. Returns the
 * count of tools loaded.
 *
 * The discovery uses the same primitives the substrate already
 * exposes: discover_context for manifest listing, get_descriptor for
 * each ac:AgentTool descriptor body. No new wire surface; the relay
 * is consuming its own MCP capabilities to grow itself.
 */
async function loadDynamicTools(): Promise<number> {
  if (!RELAY_DYNAMIC_TOOLS_POD) return 0;
  const podUrl = RELAY_DYNAMIC_TOOLS_POD.endsWith('/') ? RELAY_DYNAMIC_TOOLS_POD : `${RELAY_DYNAMIC_TOOLS_POD}/`;
  let entries: Awaited<ReturnType<typeof discover>>;
  try {
    // Newest-first sort + reasonable limit so initial load is bounded.
    // No graph_iri filter here — we want every Asserted AgentTool, and
    // by-convention they describe graphs prefixed `urn:graph:ac:tool:`.
    // Filtering by that prefix client-side keeps the wire request simple.
    entries = await discover(podUrl, { sort: 'newest-first', limit: 200 }, { fetch: solidFetch });
  } catch (err) {
    log(`[dynamic-tools] discover failed: ${(err as Error).message}`);
    return 0;
  }
  const candidates = entries.filter(e => e.describes.some(g => g.startsWith('urn:graph:ac:tool:')));
  dynamicTools.clear();
  let loaded = 0;
  for (const entry of candidates) {
    try {
      const resp = await solidFetch(entry.descriptorUrl, {
        method: 'GET',
        headers: { 'Accept': 'text/turtle' },
      });
      if (!resp.ok) continue;
      const turtle = await resp.text();
      // Only Asserted, only ac:AgentTool.
      if (!/iep:modalStatus\s+iep:Asserted/i.test(turtle)) continue;
      if (!/\ba ac:AgentTool\b|\ba\s+ac:AgentTool/.test(turtle)) continue;
      const labelMatch = turtle.match(/rdfs:label\s+"([^"]+)"/);
      const actionMatch = turtle.match(/iep:action\s+<([^>]+)>/);
      const commentMatch = turtle.match(/iep:affordance\s+\[[\s\S]*?rdfs:comment\s+"([^"]+)"/);
      if (!labelMatch) continue;
      const rawName = labelMatch[1]!;
      const toolName = `dynamic:${rawName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}`;
      const description =
        `[Dynamic, pod-loaded ac:AgentTool] ${commentMatch?.[1] ?? rawName}. `
        + `Promoted to Asserted via ac:promote_tool attestations. `
        + `Source descriptor: ${entry.descriptorUrl}. `
        + (actionMatch ? `Affordance action: ${actionMatch[1]} (follow via act/invoke_affordance).` : 'No callable affordance — descriptor-only introspection.');
      const descriptorUrl = entry.descriptorUrl;
      const affordanceAction = actionMatch?.[1];
      const handler = async (args: ToolArgs): Promise<string> => {
        // The dynamic tool's handler is a thin wrapper: dereference the
        // descriptor and return its representation + affordances. The
        // caller decides how to follow them (act / invoke_affordance /
        // publish_context). This is the substrate-honest "execution
        // model": the descriptor IS the tool definition; calling it
        // surfaces its callable affordances rather than running code.
        try {
          const r = await kernelDereference(descriptorUrl, {
            fetch: solidFetch,
            recipientKeyPair: relayAgentKey,
          });
          return JSON.stringify({
            tool: toolName,
            sourceDescriptor: descriptorUrl,
            affordanceAction: affordanceAction ?? null,
            dereference: r,
            args,
            note:
              `This is a dynamic tool loaded from the relay's configured ac:AgentTool pod. `
              + `Its handler dereferences the source descriptor and returns its affordances; `
              + `follow them via the \`act\` or \`invoke_affordance\` tools. The relay does NOT `
              + `execute arbitrary code from pods — the descriptor IS the executable definition `
              + `(as a hypermedia affordance), and following the affordance is how the tool runs.`,
          });
        } catch (err) {
          return JSON.stringify({
            tool: toolName,
            error: 'dynamic tool handler threw',
            message: (err as Error).message,
            sourceDescriptor: descriptorUrl,
          });
        }
      };
      dynamicTools.set(toolName, {
        description,
        handler,
        descriptorUrl,
        ...(affordanceAction ? { affordanceAction } : {}),
      });
      loaded++;
    } catch (err) {
      log(`[dynamic-tools] failed to load ${entry.descriptorUrl}: ${(err as Error).message}`);
    }
  }
  dynamicToolsLastLoadedAt = new Date().toISOString();
  dynamicToolsLastLoadCount = loaded;
  log(`[dynamic-tools] loaded ${loaded} ac:AgentTool descriptor(s) from ${podUrl} (scanned ${candidates.length} candidate entries)`);
  return loaded;
}

// Schedule initial load: don't block module evaluation, but don't
// await either — fire-and-forget like the federation hydrate. Subsequent
// reloads can be triggered via the admin endpoint added below.
if (RELAY_DYNAMIC_TOOLS_POD) {
  void loadDynamicTools().catch(err => {
    log(`[dynamic-tools] initial load failed: ${(err as Error).message}`);
  });
} else {
  log(`[dynamic-tools] RELAY_DYNAMIC_TOOLS_POD not set; static TOOLS only`);
}

// ── MCP Tool Schemas ────────────────────────────────────────
// Input schemas for each tool. Claude's LLM uses these to know how to call
// each tool; empty inputSchema means the model can never pick the right args.
// Property names match what each handler reads off args.
//
// outputSchema describes the structured RESULT PAYLOAD — i.e. the object
// the relay returns as `structuredContent` (the parsed form of the JSON
// the handler emits in content[0].text). This is what the MCP spec means
// by outputSchema (2025-06-18): a tool that declares one MUST return
// `structuredContent` conforming to it. The relay's /mcp dispatch attaches
// structuredContent = JSON.parse(handler output) for every tool, so the
// schema must describe that payload, NOT the wire envelope.
//
// Two robustness rules, both load-bearing:
//   1. additionalProperties: true  — handlers return success OR soft-error
//      JSON ({error, code}) on the same tool; extras must not fail validation.
//   2. NO top-level `required`     — a soft-error return won't carry the
//      success fields; requiring them would trade the "missing
//      structuredContent" error for a "schema mismatch" error on a strict
//      client. Property descriptions are kept (documentation); only the
//      hard presence constraint is dropped. Nested `required` (inside array
//      items, e.g. each manifest entry must have descriptorUrl) is kept —
//      it only validates items that actually appear.
//
// Generic tools fall back to a fully permissive object. Tier-1
// (publish_context / discover_context / get_descriptor / list_known_pods /
// get_pod_status / analyze_question / invoke_affordance) keep their
// hand-authored property docs. Handler behavior is untouched.

// Recursively make a JSON Schema null-tolerant: drop `required` at EVERY
// level and widen every declared `type` to also accept `null`. This closes
// the f-schema-nullability class — a strict MCP client (Anthropic Messages
// API mcp_servers) validates structuredContent against outputSchema and
// rejects a `null` where the schema said `"string"`. Handlers legitimately
// emit null for "absent" optional fields (previousHeadCid on a fresh-URN
// publish, authorship when unsigned, precondition on a non-CAS publish, …),
// so rather than chase every field per dogfood cycle we make the declared
// schema accept what the handlers actually produce. Belt to the
// toStructuredContent omit-nulls suspenders below.
// `isRoot` MUST stay false for the top-level call: the MCP spec types a
// tool's outputSchema as an object whose root `type` is the LITERAL
// "object", and a strict client can reject the tool definition on
// tools/list if the root is a union like ["object","null"]. So at the
// root we drop `required` and recurse, but DON'T widen the root type.
// Nested property/items types ARE widened to include null (a nested
// object/string field can legitimately be null).
function makeSchemaNullTolerant(node: unknown, isRoot = false): unknown {
  if (Array.isArray(node)) return node.map(n => makeSchemaNullTolerant(n, false));
  if (node && typeof node === 'object') {
    const o: Record<string, unknown> = { ...(node as Record<string, unknown>) };
    delete o.required; // drop required at every nesting level
    if (!isRoot) {
      if (typeof o.type === 'string' && o.type !== 'null') {
        o.type = [o.type, 'null'];
      } else if (Array.isArray(o.type) && !o.type.includes('null')) {
        o.type = [...o.type, 'null'];
      }
    }
    if (o.properties && typeof o.properties === 'object') {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
        props[k] = makeSchemaNullTolerant(v, false);
      }
      o.properties = props;
    }
    if (o.items) o.items = makeSchemaNullTolerant(o.items, false);
    return o;
  }
  return node;
}

function mcpOutputSchema(
  payloadSchema?: Record<string, unknown>,
): Record<string, unknown> {
  if (!payloadSchema) {
    return { type: 'object', additionalProperties: true };
  }
  const schema = makeSchemaNullTolerant({ ...payloadSchema, type: 'object' }, true) as Record<string, unknown>;
  if (!('additionalProperties' in schema)) schema.additionalProperties = true;
  return schema;
}

// Parse a handler's JSON-string return into the structuredContent object
// the /mcp dispatch attaches to every tool result. Always yields an object
// so it conforms to the permissive payload outputSchema: a JSON object is
// returned as-is; a non-object JSON value (number/bool/string/array) or an
// unparseable string is wrapped as { result: <value> }.
// Recursively drop null/undefined-valued KEYS from objects (johnny's
// preferred "omit optional fields when empty" — cleaner payloads + nothing
// for a strict validator to reject). Array elements are preserved as-is
// (removing them would shift indices / change semantics); the null-tolerant
// outputSchema above covers any null that survives inside an array.
function omitNullish(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(omitNullish);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null || val === undefined) continue;
      o[k] = omitNullish(val);
    }
    return o;
  }
  return v;
}

function toStructuredContent(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return omitNullish(parsed) as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: text };
  }
}

const GENERIC_OUTPUT_SCHEMA = mcpOutputSchema({
  type: 'object',
  additionalProperties: true,
  description: "Tool returned a JSON object (or human-readable text) embedded in the MCP content[0].text field. See the tool's source for the exact shape.",
});

const PUBLISH_CONTEXT_OUTPUT = mcpOutputSchema({
  type: 'object',
  description: 'publish_context returns a human-readable multi-line summary embedding the fields below; the relay variant returns the same fields as a JSON object.',
  properties: {
    published: { type: 'boolean' },
    owner: { type: 'string', description: 'Pod owner WebID' },
    agent: { type: 'string', description: 'Acting agent IRI' },
    pod: { type: 'string', description: 'Pod URL the descriptor was written to' },
    descriptorUrl: { type: 'string', description: 'URL of the published descriptor .ttl' },
    graphUrl: { type: 'string', description: 'URL of the graph payload (.trig or .envelope.jose.json)' },
    encrypted: { type: 'boolean', description: 'True when the graph was wrapped in a JOSE envelope' },
    visibility: {
      type: 'string',
      enum: ['public', 'shared', 'private'],
      description: 'Audience class actually applied (echoes the input; "shared" when input was omitted).',
    },
    recipients: { type: 'integer', description: 'Number of envelope recipients (includes self). 0 when visibility="public".' },
    manifestUrl: { type: 'string', description: 'URL of the pod manifest entry for this descriptor' },
    sharedWith: {
      type: 'array',
      description: 'When share_with was supplied: per-handle resolution outcome',
      items: {
        type: 'object',
        properties: {
          handle: { type: 'string' },
          podUrl: { type: 'string' },
          agentCount: { type: 'integer' },
        },
      },
    },
    supersedesPriorVersions: {
      type: 'array',
      description: 'When auto_supersede_prior was active: prior descriptor URLs marked superseded',
      items: { type: 'string' },
    },
    previousHeadCid: {
      type: 'string',
      description: 'Content-CID (CIDv1 raw codec, base32) of the prior chain head this publish was gated against. Pass back as `if_match` on the next publish_context to detect concurrent writers (CAS supersession). Absent when descriptor had no supersedes target.',
    },
    previousHeadUrl: {
      type: 'string',
      description: 'Descriptor URL of the prior chain head this publish was gated against. Companion to previousHeadCid; either may be used as `if_match` on the next publish.',
    },
    ipfs: {
      type: 'object',
      description: 'IPFS pin result (or local CID when no provider configured)',
      properties: {
        cid: { type: 'string' },
        url: { type: 'string' },
        provider: { type: 'string', description: 'local | pinata | web3-storage | …' },
      },
    },
    anchorUrl: { type: 'string', description: 'Pod-anchored receipt URL (zero-copy metadata)' },
    sensitivityPreflight: {
      type: 'string',
      description: 'Privacy-hygiene warning if HIGH-severity content detected (was allowed via allow_sensitive_content) or LOW/MEDIUM flagged content',
    },
    complianceCheck: {
      type: 'object',
      description: 'When compliance: true — framework conformance report',
      properties: {
        compliant: { type: 'boolean' },
        framework: { type: 'string' },
        violations: { type: 'array', items: { type: 'string' } },
        upgradedFacets: { type: 'array', items: { type: 'string' } },
      },
    },
    signature: {
      type: 'object',
      description: 'When compliance: true — ECDSA signature record sibling .sig.json. The url is content-addressed and returned synchronously; signing + pod PUT + IPFS pin run in the background, so status is "pending" until the caller GETs the url.',
      properties: {
        url: { type: 'string' },
        status: { type: 'string', description: 'pending — sign + PUT + pin deferred; poll url' },
      },
    },
  },
});

const DISCOVER_CONTEXT_OUTPUT = mcpOutputSchema({
  type: 'object',
  description: 'Aggregated discovery result: array of ManifestEntry plus optional registry info when verify_delegation was true.',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        description: 'ManifestEntry — one row per descriptor known to the pod manifest',
        properties: {
          descriptorUrl: { type: 'string' },
          describes: { type: 'array', items: { type: 'string' }, description: 'Graph IRIs the descriptor describes' },
          conformsTo: { type: 'array', items: { type: 'string' } },
          facetTypes: { type: 'array', items: { type: 'string' }, description: 'Facet type names (Temporal, Provenance, …)' },
          modalStatus: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'] },
          trustLevel: { type: 'string' },
          validFrom: { type: 'string' },
          validUntil: { type: 'string' },
        },
        required: ['descriptorUrl'],
      },
    },
    registry: {
      type: 'object',
      description: 'When verify_delegation: true — owner + authorized agents snapshot',
      properties: {
        owner: { type: 'string' },
        name: { type: 'string' },
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              scope: { type: 'string' },
              label: { type: 'string' },
            },
          },
        },
      },
    },
  },
});

const GET_DESCRIPTOR_OUTPUT = mcpOutputSchema({
  type: 'object',
  description: "Descriptor Turtle plus optional decrypted graph payload reached via the descriptor's iep:hasDistribution link.",
  properties: {
    url: { type: 'string', description: 'Echo of the descriptor URL requested' },
    turtle: { type: 'string', description: 'Full Turtle of the descriptor (when the URL is a .ttl)' },
    encrypted: { type: 'boolean', description: 'For .envelope.jose.json / .trig URLs: was the payload encrypted' },
    mediaType: { type: 'string' },
    content: { type: 'string', description: 'Resolved graph payload (decrypted when this agent is a recipient)' },
    graph: {
      type: 'object',
      description: 'Distribution-followed graph payload (when descriptor has iep:hasDistribution and content was reachable)',
      properties: {
        url: { type: 'string' },
        mediaType: { type: 'string' },
        encrypted: { type: 'boolean' },
        content: { type: 'string' },
      },
    },
    authorship: {
      type: 'object',
      description: 'When the descriptor embeds a iep:authorshipProof, the relay automatically re-derives the canonical authorship payload and runs the delegation verifier from the descriptor turtle alone. authorshipVerified=true means the signature matched and the named agent really signed the AgentFacet. When BOTH the authorship proof and the delegation chain verify, effectiveTrustLevel becomes CryptographicallyVerified even if the descriptor body shipped SelfAsserted.',
      properties: {
        authorshipVerified: { type: 'boolean' },
        signedBy: { type: 'string', description: 'Agent IRI claimed in the proof' },
        verificationMethod: { type: 'string', description: 'did:ethr:<addr> or other key-resolution IRI' },
        effectiveTrustLevel: { type: 'string', enum: ['CryptographicallyVerified', 'SelfAsserted'] },
        reason: { type: 'string', description: 'Diagnostic when authorshipVerified is false' },
      },
    },
    error: { type: 'string', description: 'HTTP error from the pod when the fetch failed' },
  },
});

const LIST_KNOWN_PODS_OUTPUT = mcpOutputSchema({
  type: 'object',
  description: 'Federation pod registry snapshot. The stdio server returns a human-readable list; the relay returns the array directly under `pods`/at the top level.',
  properties: {
    pods: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          label: { type: 'string' },
          owner: { type: 'string', description: 'Owner WebID when known' },
          via: { type: 'string', description: 'How the pod entered the registry (manual / directory / webfinger / home)' },
          isHome: { type: 'boolean' },
          lastSeen: { type: 'string' },
          subscribed: { type: 'boolean' },
        },
        required: ['url'],
      },
    },
  },
});

const GET_POD_STATUS_OUTPUT = mcpOutputSchema({
  type: 'object',
  description: 'Pod liveness + registry summary + descriptor count + recent notifications.',
  properties: {
    pod: { type: 'string' },
    css: { type: 'string', description: 'CSS / pod-host base URL' },
    registry: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        name: { type: 'string' },
        agents: { type: 'integer', description: 'Active (non-revoked) authorized agent count' },
      },
    },
    descriptors: { type: 'integer', description: 'Number of descriptors currently in the manifest' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          descriptorUrl: { type: 'string' },
          describes: { type: 'array', items: { type: 'string' } },
          facetTypes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    recentNotifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          resource: { type: 'string' },
          timestamp: { type: 'string' },
        },
      },
    },
  },
});

const ANALYZE_QUESTION_OUTPUT = mcpOutputSchema({
  type: 'object',
  description: 'Cognitive-strategy recommendation from the affordance engine.',
  properties: {
    questionType: { type: 'string', description: 'Detected question type (temporal / multi-session / preference / direct / …)' },
    strategy: {
      type: 'string',
      enum: ['direct', 'temporal-twopass', 'multi-session-aggregate', 'preference-meta', 'abstain'],
      description: 'Recommended strategy. abstain when question entities not present in session_content.',
    },
    requiresComputation: { type: 'boolean' },
    computationType: { type: 'string' },
    entities: {
      type: 'object',
      properties: {
        contentWords: { type: 'array', items: { type: 'string' } },
        nounPhrases: { type: 'array', items: { type: 'string' } },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    abstention: {
      type: 'object',
      description: 'Populated when session_content was supplied',
      properties: {
        abstain: { type: 'boolean' },
        missingEntities: { type: 'array', items: { type: 'string' } },
        matchRatio: { type: 'number' },
      },
    },
  },
  required: ['strategy'],
});

const STUB_REDIRECT_OUTPUT = mcpOutputSchema({
  type: 'object',
  description: 'Stub-handler response on the remote OAuth relay: tool is meaningful only on the local stdio surface.',
  properties: {
    skipped: { type: 'boolean', const: true },
    reason: { type: 'string', description: 'e.g. already-identified-via-oauth' },
    message: { type: 'string', description: 'Human-readable redirect explanation' },
  },
  required: ['skipped', 'reason', 'message'],
});

const INVOKE_AFFORDANCE_OUTPUT = mcpOutputSchema({
  type: 'object',
  description: 'Result of a iep:Affordance invocation — echo of the resolved affordance metadata plus the raw HTTP response from the target. Parse body based on contentType; 4xx is informative (e.g. forbidden / validation), 5xx is retried internally before surfacing.',
  properties: {
    status: { type: 'integer', description: 'HTTP status from the target' },
    statusText: { type: 'string' },
    contentType: { type: 'string', description: 'Content-Type header from the target (null when absent)' },
    body: { type: 'string', description: 'Raw response body — JSON-parse when contentType is application/json' },
    affordance: {
      type: 'object',
      description: 'Resolved affordance metadata from the descriptor',
      properties: {
        action: { type: 'string', description: 'iep:action IRI selected by the caller' },
        target: { type: 'string', description: 'hydra:target URL invoked' },
        method: { type: 'string', description: 'hydra:method (default POST when absent on the descriptor)' },
        mediaType: { type: 'string', description: 'dcat:mediaType when present' },
      },
      required: ['action', 'target', 'method'],
    },
  },
  required: ['status', 'statusText', 'contentType', 'body', 'affordance'],
});

const TOOL_SCHEMAS = [
  // ═══════════════════════════════════════════════════════════
  //  Kernel verbs — the substrate's primitives as first-class
  //  tools. The named tools below are compatibility shims
  //  internally composed from these. See
  //  docs/ARCHITECTURAL-FOUNDATIONS.md §11.
  // ═══════════════════════════════════════════════════════════
  {
    name: 'mint',
    description: 'Kernel verb — content-addressed holon construction. Same content always yields the same IRI (Identity-by-reference, Invariant 1). Kinds: atom (default), fragment, descriptor, opaque.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { description: 'Value (atom), list (fragment), descriptor JSON, or any value (opaque).' },
        kind: { type: 'string', enum: ['atom', 'fragment', 'descriptor', 'opaque'], description: 'Substrate kind (default: atom).' },
      },
      required: ['content'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Mint a holon', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'dereference',
    description: 'Kernel verb — Peircean Secondness: resolve an IRI to its representation, affordances, and provenance. Manifests return entry lists decorated with affordances. Encrypted envelopes return status: encrypted-no-key when no key supplied.',
    inputSchema: {
      type: 'object',
      properties: {
        iri: { type: 'string', description: 'IRI to resolve.' },
        decorate_manifest: { type: 'boolean', description: 'Decorate manifest entries with affordances (default true).' },
      },
      required: ['iri'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Dereference an IRI', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'compose',
    description: 'Kernel verb — operadic composition over typed-hyperedge category. Operators: union (join), intersection (meet), restriction (project), override (left-biased).',
    inputSchema: {
      type: 'object',
      properties: {
        descriptors: { type: 'array', items: { type: 'object', additionalProperties: true } },
        operator: { type: 'string', enum: ['union', 'intersection', 'restriction', 'override'] },
        types: { type: 'array', items: { type: 'string' } },
      },
      required: ['descriptors', 'operator'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Compose descriptors', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'act',
    description: 'Kernel verb — Peircean Thirdness operational. Follows an affordance via {descriptor_url, action_iri} or via pre-resolved {target, action, method}.',
    inputSchema: {
      type: 'object',
      properties: {
        descriptor_url: { type: 'string' },
        action_iri: { type: 'string' },
        target: { type: 'string' },
        action: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        media_type: { type: 'string' },
        payload: {},
        authorization: { type: 'string' },
      },
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Act on an affordance', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'restrict',
    description: 'Kernel verb — adjunction left half (whole → part). Projects a descriptor to a facet-type subset.',
    inputSchema: {
      type: 'object',
      properties: {
        descriptor: { type: 'object', additionalProperties: true },
        selector: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['facet-types'] },
            types: { type: 'array', items: { type: 'string' } },
          },
          required: ['kind'],
        },
      },
      required: ['descriptor', 'selector'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Restrict a holon', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'extend',
    description: 'Kernel verb — adjunction right half (part → whole). Inverse of restrict; back-links via iep:supersedes.',
    inputSchema: {
      type: 'object',
      properties: {
        part: { type: 'object', additionalProperties: true },
        whole: { type: 'object', additionalProperties: true },
        preserve_witness: { type: 'boolean' },
      },
      required: ['part', 'whole'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Extend a part to a whole', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'promote',
    description: 'Kernel verb — PGSL fibration upward (level k → k+1). Builds the lattice and returns the apex + pullback square (when level ≥ 2).',
    inputSchema: {
      type: 'object',
      properties: {
        atoms: { type: 'array', items: {}, description: 'Values or PGSL atom IRIs.' },
      },
      required: ['atoms'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Promote atoms', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'decompose',
    description: 'Kernel verb — PGSL fibration downward (level k → k-1). Returns left/right/overlap for fragment of level ≥ 2.',
    inputSchema: {
      type: 'object',
      properties: {
        iri: { type: 'string' },
      },
      required: ['iri'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Decompose a fragment', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'reduce_chain',
    description: 'Kernel verb — fold a iep:supersedes chain through a declarative reducer (Turtle-template OR SHACL-transform) and return the canonical head state alongside a content-addressed ReplayProof. The proof carries each chain link\'s CID in walk order, the reducer artifact\'s CID, periodic state checkpoints, and the final head-state CID. Any third party can independently re-fetch by CID and replay the same fold to verify the result — no trust in the original kernel is required. Reducer resolution order: (1) inline reducer_spec wins, (2) reducer_iri is dereferenced and classified, (3) the kernel reads `iep:reducer <iri>` declared on the chain head.',
    inputSchema: {
      type: 'object',
      properties: {
        chain_iri: { type: 'string', description: 'Chain HEAD IRI — the most recent descriptor in the iep:supersedes chain. The fold walks back to the chain origin and applies the reducer left-to-right.' },
        reducer_iri: { type: 'string', description: 'Optional reducer artifact IRI to dereference + apply. Body starting with sh:rule / sh:construct / sh:* is treated as a SHACL transform; otherwise as a Turtle template with `{?prior}` / `{?current}` placeholders.' },
        reducer_spec: {
          type: 'object',
          description: 'Inline reducer spec. Wins over reducer_iri and over iep:reducer on the chain head when supplied. Shape: { kind: "turtle-template", template: "<turtle>" } OR { kind: "shacl-transform", shape: "<shacl-turtle>" }.',
        },
        max_chain: { type: 'number', description: 'Maximum chain length to walk (default 64). Defense in depth against tampered cyclic chains; supersedes is normatively a DAG.' },
        checkpoint_every: { type: 'number', description: 'Emit a state checkpoint every Nth link (default 8). Verifiers can short-circuit replay from the nearest checkpoint when partial trust is acceptable.' },
        traversal: {
          type: 'string',
          enum: ['shortest', 'full'],
          description: 'How the walker reconstructs the chain from iep:supersedes back-links. "shortest" (default) follows the first iep:supersedes per link — fast and historical-compat. "full" walks every iep:supersedes branch transitively, then folds the union in canonical order (iep:validFrom ascending, descriptor-IRI lexical tiebreak). Use "full" for a complete lineage audit when auto_supersede_prior writes ALL priors per version — the ReplayProof\'s chainCids[] cover the entire DAG closure so independent verifiers reproduce the same head.',
        },
      },
      required: ['chain_iri'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Reduce a supersedes chain', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  // ═══════════════════════════════════════════════════════════
  //  Compatibility shims — the 27 named tools. Each remains
  //  wire-compatible; descriptions tagged with "Compatibility
  //  shim" + the kernel verb composition that realizes it.
  // ═══════════════════════════════════════════════════════════
  {
    name: 'publish_context',
    description: 'Compatibility shim — internally composes kernel(compose+act) over a publish affordance plus E2EE/anchoring/compliance plumbing. Publishes a context-annotated knowledge graph (Turtle) to your Solid pod with the full 6-facet descriptor (Temporal, Provenance, Agent, Semiotic, Trust, Federation). Attributes the descriptor to the pod owner and associates it with the calling agent. Audience class is set via `visibility`: "public" (plaintext payload + foaf:Agent acl:Read — useful for wiki-style notes or jam:renderView projections), "shared" (default; JOSE envelope to the pod\'s authorized agents plus optional share_with recipients), or "private" (envelope to the calling agent ONLY; share_with ignored). SHACL conformance gate: pass `conforms_to_shapes` as an array of shape IRIs — every shape is fetched, parsed, and validated against the inbound graph_content BEFORE the pod write; non-conformance returns a 422 envelope `{ error: "shape_violation", code: 422, shape, violations: [...] }` and the descriptor/payload never lands on the pod. Caller-supplied shapes stack with any iep:conformsTo / dct:conformsTo declarations the target container (or its manifest) already carries — either failing rejects.',
    inputSchema: {
      type: 'object',
      properties: {
        graph_iri: { type: 'string', description: 'IRI for the named graph, e.g. urn:graph:markj:session:20260418' },
        graph_content: { type: 'string', description: 'RDF Turtle content of the knowledge graph' },
        pod_name: { type: 'string', description: 'Pod name (default: the authenticated user\'s pod)' },
        descriptor_id: { type: 'string', description: 'Optional descriptor IRI (auto-generated if omitted)' },
        valid_from: { type: 'string', description: 'ISO 8601 start of validity (default: now)' },
        valid_until: { type: 'string', description: 'ISO 8601 end of validity (optional)' },
        modal_status: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'], description: 'Semiotic modal status (default: Asserted)' },
        confidence: { type: 'number', description: 'Epistemic confidence 0.0-1.0 (default: 0.85)' },
        visibility: {
          type: 'string',
          enum: ['public', 'shared', 'private'],
          description: 'Audience class for the published payload. Default "shared". "public" → no envelope; plaintext Turtle written to the pod; the descriptor + payload .acl grants acl:Read to acl:agentClass foaf:Agent (any authenticated user); descriptor advertises iep:visibility "public" and iep:encrypted false. Use for wiki-style notes, jam:renderView projections, or anything the user explicitly wants publicly readable. "shared" (DEFAULT) → JOSE envelope wrapped to the pod\'s authorized agents + author\'s session-agent key + any share_with recipients — historical behavior, preserves wire compat. "private" → envelope to the author\'s session agent ONLY; even other authorized agents on the same pod cannot decrypt. Use for personal scratchpads. share_with is ignored under "public" and "private" (a warn is logged if it was supplied).',
        },
        share_with: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of external identity handles (did:web:..., WebID URLs, or acct:user@host). Each is resolved to its pod, and their authorized agents\' X25519 keys are added as recipients on the envelope — per-graph cross-pod sharing without any pod-level ACL change. Use to share a specific graph with another person while keeping your other graphs private. NOTE: only honored when visibility is "shared" (the default); ignored + warn-logged under "public" or "private".',
        },
        auto_supersede_prior: {
          type: 'boolean',
          description: 'When true (default), automatically add iep:supersedes links to any prior descriptor on this pod that describes the same graph_iri. Makes republish-to-add-recipients cleanly mark the older version as superseded. Set to false to allow multiple coexisting descriptors for the same graph.',
        },
        if_match: {
          type: 'string',
          description: 'CAS precondition — the descriptor URL (https://.../foo.ttl) OR content-CID (bafkrei...) of the chain head this publish is meant to supersede. publish() resolves the current head for descriptor.supersedes and rejects with code 412 {currentHead, expected} if the assertion does not match what the pod currently holds. Use the `previousHeadCid` field returned by a prior publish_context (or call get_current_head first) as the next publish_context\'s if_match — that gives you atomic compare-and-swap on the supersession chain, preventing two concurrent writers from forking the chain into two competing HEADs.',
        },
        compliance: {
          type: 'boolean',
          description: 'When true, publish as compliance-grade evidence (regulatory audit trail). Forces trust to HighAssurance, requires non-Hypothetical modal status. Response carries a complianceCheck report.',
        },
        compliance_framework: {
          type: 'string',
          enum: ['eu-ai-act', 'nist-rmf', 'soc2'],
          description: 'Optional regulatory framework this descriptor provides evidence for. The graph_content should cite the relevant control IRIs (e.g., soc2:CC6.1) so framework reports can aggregate.',
        },
        sign_authorship: {
          type: 'boolean',
          description: 'When true, embed an agent-level iep:authorshipProof block in the descriptor turtle. The proof signs a canonical payload of (agentId, ownerWebId, descriptorId, created, agentDid?) with the agent\'s delegation key (same ECDSA key the signed delegation VC chain uses). Verifiable from the descriptor ALONE: the verificationMethod (did:ethr:<addr>) lets a reader recover the public key without trusting pod storage. On dereference (get_descriptor), the relay automatically runs the verifier and returns { authorshipVerified, signedBy, verificationMethod, effectiveTrustLevel }. When BOTH the authorship proof AND the delegation chain verify, the EFFECTIVE trustLevel is CryptographicallyVerified even when the descriptor body ships TrustFacet.trustLevel = SelfAsserted. Default false to preserve SelfAsserted neutrality. Independent of `compliance` (the trust-facet operator-grade iep:proof block) — the two stack: a publish can carry both, neither, or either.',
        },
        agent_did: {
          type: 'string',
          description: 'Optional DID for the calling agent. When present and sign_authorship is true, the DID is included in the canonical authorship payload (so verifiers have a resolution hint without an extra round-trip).',
        },
        conforms_to_shapes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of SHACL shape IRIs the inbound graph_content MUST conform to. Each shape is fetched (text/turtle) and run against the payload BEFORE any pod write — non-conformance rejects with the same 422 envelope as the container-declared conformance gate ({ error: "shape_violation", code: 422, shape, violations: [...] }) and the descriptor + payload never land on the pod. Stacks on top of any iep:conformsTo / dct:conformsTo shapes the target container (or its manifest collection) already declares; ALL shapes (container-declared + caller-supplied) must conform — any one failing rejects. Use to enforce a per-publish shape contract from the MCP wire without relying on the pod\'s .well-known/container-shape file being present.',
        },
      },
      required: ['graph_iri', 'graph_content'],
      examples: [
        {
          graph_iri: 'urn:graph:markj:public:about',
          graph_content: '<urn:graph:markj:public:about> a <https://schema.org/AboutPage> ; <http://purl.org/dc/terms/title> "About me" .',
          visibility: 'public',
        },
        {
          graph_iri: 'urn:graph:markj:notes:20260605',
          graph_content: '<urn:graph:markj:notes:20260605> <http://purl.org/dc/terms/description> "Team-internal note." .',
          visibility: 'shared',
          share_with: ['did:web:alice.example'],
        },
        {
          graph_iri: 'urn:graph:markj:scratchpad:20260605',
          graph_content: '<urn:graph:markj:scratchpad:20260605> <http://purl.org/dc/terms/description> "Personal scratch — author only." .',
          visibility: 'private',
        },
      ],
    },
    outputSchema: PUBLISH_CONTEXT_OUTPUT,
    annotations: { title: 'Publish context graph', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'record_trajectory_step',
    description: 'Record one step of the calling agent\'s OODA trajectory as a substrate-native ContextDescriptor. Each step lands on the agent\'s own pod, signed (sign_authorship default true), discoverable via discover_context with `graph_iri: "urn:graph:trajectory:<agentSlug>"`, and consumable by verifyCapabilityTransfer / the Foxxi calibration loop. Use Hypothetical when recording intent BEFORE acting, then call again with Asserted + supersedes_step_id pointing at the Hypothetical to mark it executed. The `verb` + `object_name` pair is what verifyCapabilityTransfer pattern-matches against signal/anti-signal markers, so write them as the action you took, e.g. verb: "ratified", object_name: "g3 agreement v2 CID anchor". This is the smallest possible "I write loops" dogfood — every tool call your loop makes becomes a discoverable, attestable trajectory step.',
    inputSchema: {
      type: 'object',
      properties: {
        verb: { type: 'string', description: 'What the agent did (e.g. "published", "verified", "supersededBoard"). Combined with `object_name` for substring matching by verifyCapabilityTransfer.' },
        object_name: { type: 'string', description: 'What the agent did it to (e.g. "move:4", "g3 agreement", "Phase A precondition"). Combined with `verb` for verifier matching.' },
        modal_status: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'], description: 'Asserted (default) for completed actions; Hypothetical for intent recorded BEFORE acting; Counterfactual to retract a prior step. Use Hypothetical+supersedes_step_id to flip plan→execute.' },
        granularity: { type: 'string', enum: ['task', 'subtask', 'tool-call'], description: 'task (high-level goal), subtask (intermediate), tool-call (one tool invocation). Default: tool-call.' },
        session_id: { type: 'string', description: 'Optional grouping label. Default: "default-YYYY-MM-DD".' },
        parent_step_id: { type: 'string', description: 'Optional URN of the parent step (for hierarchical decomposition: task → subtask → tool-call).' },
        supersedes_step_id: { type: 'string', description: 'Optional URN of a step this one supersedes (use to flip a Hypothetical intent into an Asserted execution).' },
        was_derived_from: { type: 'array', items: { type: 'string' }, description: 'Optional list of descriptor URLs/URNs this step drew on (prov:wasDerivedFrom).' },
        result_success: { type: 'boolean', description: 'Optional: did the action succeed?' },
        result_quality: { type: 'number', minimum: 0, maximum: 1, description: 'Optional quality score in [0,1].' },
        result_note: { type: 'string', description: 'Optional short description of the outcome.' },
        sign_authorship: { type: 'boolean', description: 'Default true (trajectory steps are evidence; readers need to verify the signer). Set false only for low-stakes scratch.' },
        visibility: { type: 'string', enum: ['public', 'shared', 'private'], description: 'Default "public" — trajectory steps are discoverable evidence. Use "private" for sensitive ones.' },
      },
      required: ['verb', 'object_name'],
      examples: [
        { verb: 'walked', object_name: 'iep:supersedes chain to head' },
        { verb: 'planning', object_name: 'rev5 supersession of rev4', modal_status: 'Hypothetical', granularity: 'task' },
        { verb: 'published', object_name: 'rev5 via signed+CAS', modal_status: 'Asserted', supersedes_step_id: 'urn:iep:trajectory-step:johnny:1780851000000', result_success: true },
      ],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Record trajectory step', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'pgsl_decide',
    description: 'Run the OODA decision functor over the calling agent\'s PGSL lattice view + (optionally) supplied coherence certificates. Returns one of four strategies: "exploit" (high coherence with peer — act on shared knowledge), "explore" (low or no coherence — gather more observations first), "delegate" (medium coherence, peer has higher overlap — delegate to them), "abstain" (no atoms ingested OR no affordances — cannot decide; pgsl_ingest first). The substrate-honest "decide" tool: instead of an agent reasoning from scratch about its next move, it asks the lattice. Used inside a persistent loop as the natural transformation between Observe (the lattice atoms+patterns) and Act (follow the returned top affordance).',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The calling agent\'s identity (used as the agent slot in the decision functor\'s observation section). Default: derived from auth context.' },
        certificates: { type: 'array', items: { type: 'object' }, description: 'Optional coherence certificates from prior pgsl_meet calls. Without them the functor returns "explore" (which is the right move when coherence is unknown).' },
      },
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'OODA decide (PGSL)', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'get_current_head',
    description: 'Resolve the current chain head for a urn:graph:* IRI on a pod — returns the descriptorUrl + content-CID of the descriptor that no other descriptor supersedes. Used as the read half of a CAS supersession chain: call this BEFORE composing a new descriptor that supersedes the urn, pass the returned `cid` (or `descriptorUrl`) as `if_match` on the follow-up publish_context, and the substrate-level precondition gate detects any concurrent writer that raced ahead of you. Returns `forked: true` + a `heads` array when the chain has diverged into multiple unresolved tips — a CAS miss that already happened — so the caller can pick one or compose them.',
    inputSchema: {
      type: 'object',
      properties: {
        urn: { type: 'string', description: 'The urn:graph:* IRI whose current chain head is being resolved.' },
        pod_url: { type: 'string', description: 'Pod URL (default: ${CSS_URL}${pod_name}/). Provide either pod_url or pod_name.' },
        pod_name: { type: 'string', description: 'Pod name on the relay\'s CSS_URL (default: "default"). Ignored when pod_url is provided.' },
      },
      required: ['urn'],
    },
    outputSchema: mcpOutputSchema({
      type: 'object',
      properties: {
        urn: { type: 'string' },
        podUrl: { type: 'string' },
        head: {
          type: 'object',
          description: 'The current chain head when the chain is well-formed (one unsuperseded tip).',
          properties: {
            descriptorUrl: { type: 'string' },
            cid: { type: 'string', description: 'CIDv1 raw codec, base32 multihash — same value you pass back as `if_match` on the next publish_context.' },
          },
        },
        heads: {
          type: 'array',
          description: 'When the chain has forked (forked: true), every unresolved tip is listed here. A missed CAS produced this — pick one and supersede the others, or compose them via a union/intersection.',
          items: {
            type: 'object',
            properties: {
              descriptorUrl: { type: 'string' },
              cid: { type: 'string' },
            },
          },
        },
        forked: { type: 'boolean' },
        message: { type: 'string' },
      },
    }),
    annotations: { title: 'Get current chain head for a urn:graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'discover_context',
    description: 'Compatibility shim — internally `dereference(podUrl + "/.well-known/context-graphs")` plus filter post-processing. Discovers context descriptors on a specific Solid pod. WHEN TO REACH FOR THIS vs `get_current_head`: if you ALREADY KNOW the specific `urn:graph:*` IRI you want and just need its live (unsuperseded) head — call `get_current_head` instead, NOT this tool followed by post-filtering; `get_current_head` does the supersedes walk for you and returns one entry instead of an unbounded list. Use `discover_context` for "show me what is on this pod" / lineage / supersedes-chain walks. Narrow the result set with `graph_iri` (most useful filter — drops manifest size from ~tens of KB to one or two entries when you know the urn), `facet_type`, `valid_from`/`valid_until`/`effective_at`, and bound it with `limit` + `sort` (defaults: `sort: "newest-first"`, no limit). Optionally verify the agent delegation chain. For pure substrate access, use the kernel verb `dereference` directly.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Solid pod URL to discover from (e.g. https://pod.example.com/agent/)' },
        graph_iri: { type: 'string', description: 'Narrow to descriptors that mention this urn:graph:* IRI in their iep:describes set. Server-side filter — avoids fetching+truncating the full manifest. If you only want the LIVE HEAD descriptor for this IRI (not the whole lineage), prefer `get_current_head`.' },
        facet_type: { type: 'string', enum: ['Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation'], description: 'Filter by facet type' },
        valid_from: { type: 'string', description: 'Filter: valid at or after this ISO datetime' },
        valid_until: { type: 'string', description: 'Filter: valid at or before this ISO datetime' },
        effective_at: { type: 'string', description: 'Filter: descriptors that are currently valid at the given instant (validFrom <= T AND (validUntil >= T OR validUntil absent)). The "currently-valid-at-time-T" semantic — distinct from valid_from/valid_until which only filter on the endpoints.' },
        sort: { type: 'string', enum: ['newest-first', 'oldest-first', 'unsorted'], description: 'Sort order applied after filters. Default: "newest-first" (largest validFrom first) — matches the typical "find what just landed" workflow.' },
        limit: { type: 'integer', minimum: 0, description: 'Cap result count. Combined with sort, gives the "latest N descriptors" affordance. Default: unbounded.' },
        verify_delegation: { type: 'boolean', description: 'If true, also fetch the agent registry to verify delegation' },
      },
      required: ['pod_url'],
    },
    outputSchema: DISCOVER_CONTEXT_OUTPUT,
    annotations: { title: 'Discover descriptors on a pod', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'get_descriptor',
    description: 'Compatibility shim — internally `dereference(descriptorUrl)`. Fetches the full Turtle content of a specific context descriptor. WHEN TO REACH FOR THIS: when you already have a concrete descriptor URL (e.g. from a prior `get_current_head` / `discover_context` / `prov:wasDerivedFrom` link) and want the body — including its `iep:affordance` block which self-describes how to participate (action IRIs, hydra:target endpoints, input templates). Reading affordances from a descriptor IS the emergent agent-teaching pattern: the publisher embeds the call surface, the consumer dereferences and invokes. For pure substrate access, use `dereference` directly.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL of the descriptor resource (ends in .ttl). If you don\'t have the URL yet but know the urn:graph IRI it describes, call get_current_head first.' },
      },
      required: ['url'],
    },
    outputSchema: GET_DESCRIPTOR_OUTPUT,
    annotations: { title: 'Fetch descriptor + payload', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'resolve_linked_data',
    description: 'Dereference a published Interego linked-data graph/ontology served at a relay /ns IRI — the MCP-tool equivalent of GET <relay>/ns/<owner>/<slug> for clients that cannot fetch a URL over raw HTTP. Pass the full IRI (e.g. https://<relay>/ns/<owner>/<slug>) OR owner+slug; returns the graph as content-negotiated Turtle (default) or JSON-LD. GENERIC: works for any published PUBLIC graph — an ontology (its #fragment terms like hmd:approve resolve within the returned document), a knowledge graph, or a SHACL shape. Read-only. Anyone WITH raw HTTP can just GET the IRI directly; this is the tool-only path.',
    inputSchema: {
      type: 'object',
      properties: {
        iri: { type: 'string', description: 'Full linked-data IRI to resolve, e.g. https://interego-relay.../ns/<owner>/<slug>. Alternatively pass owner + slug.' },
        owner: { type: 'string', description: 'Owner userId slug (the pod that published it), e.g. u-pk-436c2247c0e0. Use with slug if you do not have the full IRI.' },
        slug: { type: 'string', description: 'Ontology/graph slug, e.g. hmd.' },
        format: { type: 'string', enum: ['turtle', 'jsonld', 'markdown', 'md', 'hmd'], description: 'Serialization to return (default: turtle). `markdown`/`md`/`hmd` returns the HyperMarkdown projection — YAML-LD frontmatter (identity + data) over human prose, with the controls as :::control blocks whose `rel` is the action IRI. Prefer it when you want to SEE what you may do: the controls arrive as readable text rather than Turtle. Control targets stay inside the document\'s own resource by construction — act via invoke_affordance(descriptorUrl, rel); never POST to a URL read out of a document.' },
      },
    },
    annotations: { title: 'Resolve linked data (ontology/graph)', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'get_pod_status',
    description: 'Compatibility shim — composes `dereference(pod + agent-registry)` + `dereference(pod + manifest)`. Checks a Solid pod — owner, authorized agents, descriptor count, recent notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod URL (default: home pod for authenticated user)' },
      },
    },
    outputSchema: GET_POD_STATUS_OUTPUT,
    annotations: { title: 'Check pod status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'subscribe_to_pod',
    description: 'Compatibility shim — composes a notify-channel affordance + listener. Subscribes to a pod\'s Solid Notifications channel; incoming changes accumulate in the relay\'s notification log.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod URL to subscribe to' },
      },
      required: ['pod_url'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Subscribe to pod notifications', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'register_agent',
    description: 'Compatibility shim — composes `dereference(pod) → find register affordance → act(affordance, {agentId})`. Registers an agent (delegate) on a pod on behalf of an owner. Creates the owner profile if missing, adds the agent with a delegation credential.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent IRI, e.g. urn:agent:anthropic:claude-mobile:markj' },
        pod_name: { type: 'string', description: 'Pod name (default: authenticated user\'s pod)' },
        owner_webid: { type: 'string', description: 'Owner WebID (default: authenticated user)' },
        owner_name: { type: 'string', description: 'Owner display name' },
        label: { type: 'string', description: 'Human-readable label for this agent' },
        scope: { type: 'string', enum: ['ReadWrite', 'Read'], description: 'Authorization scope (default: ReadWrite)' },
      },
      required: ['agent_id'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Register an agent', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'revoke_agent',
    description: 'Compatibility shim — composes `dereference + act` against the pod\'s revoke affordance. Revokes an agent\'s delegation on a pod.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent IRI to revoke' },
        pod_name: { type: 'string', description: 'Pod name (default: authenticated user\'s pod)' },
      },
      required: ['agent_id'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Revoke agent delegation', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'verify_agent',
    description: 'Compatibility shim — `dereference(pod + agent-registry)` + delegation-chain verification. Verifies an agent\'s delegation chain on a pod — checks registry, credential, and non-revocation.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent IRI to verify' },
        pod_url: { type: 'string', description: 'Pod URL where the agent is registered' },
      },
      required: ['agent_id', 'pod_url'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Verify agent delegation', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'discover_all',
    description: 'Compatibility shim — `Promise.all(knownPods.map(p => dereference(p + manifest)))` + result merge. Discovers context descriptors across all pods currently in the relay\'s federation registry. Use add_pod or discover_directory first to populate. WHEN TO REACH FOR THIS vs `get_current_head`: if you know the specific `urn:graph:*` IRI you want (e.g. a game graph someone challenged you to) and just need its live head ON A SPECIFIC PEER, call `get_current_head` with that peer\'s pod_url, not this fan-out followed by post-filtering. Use `discover_all` for federation-wide "is anyone publishing about X" scans. Same filter set as discover_context — `graph_iri` is the most useful narrowing arg; default `sort: "newest-first"` per pod.',
    inputSchema: {
      type: 'object',
      properties: {
        graph_iri: { type: 'string', description: 'Narrow to descriptors mentioning this urn:graph:* IRI in their iep:describes set. Applied per pod, server-side.' },
        facet_type: { type: 'string', enum: ['Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation'], description: 'Filter by facet type' },
        valid_from: { type: 'string', description: 'Filter: valid at or after this ISO datetime' },
        valid_until: { type: 'string', description: 'Filter: valid at or before this ISO datetime' },
        effective_at: { type: 'string', description: 'Filter: descriptors currently valid at the given instant.' },
        sort: { type: 'string', enum: ['newest-first', 'oldest-first', 'unsorted'], description: 'Sort order per pod. Default: "newest-first".' },
        limit: { type: 'integer', minimum: 0, description: 'Cap result count per pod. Default: unbounded.' },
      },
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Discover across known pods', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'list_known_pods',
    description: 'Compatibility shim — local registry view; underlying entries are dereferenceable IRIs. Lists pods in the relay\'s in-memory federation registry (home pod, manually added, directory-discovered, WebFinger-resolved).',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: LIST_KNOWN_PODS_OUTPUT,
    annotations: { title: 'List pods in federation', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'add_pod',
    description: 'Compatibility shim — updates local pod registry. Manually adds a pod to the federation registry.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod URL to add' },
        label: { type: 'string', description: 'Human-readable label' },
        owner: { type: 'string', description: 'Owner WebID or name' },
      },
      required: ['pod_url'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Add pod to federation', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'remove_pod',
    description: 'Compatibility shim — updates local pod registry only. Removes a pod from the federation registry.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod URL to remove' },
      },
      required: ['pod_url'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Remove pod from federation', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'discover_directory',
    description: 'Compatibility shim — `dereference(directoryUrl)` then registers listed pods. Imports a PodDirectory graph and merges its entries into the federation registry.',
    inputSchema: {
      type: 'object',
      properties: {
        directory_url: { type: 'string', description: 'URL of a Turtle-encoded PodDirectory graph' },
      },
      required: ['directory_url'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Discover a directory of pods', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'publish_directory',
    description: 'Compatibility shim — composes `mint(directory) → act(homePod.publishAffordance)`. Publishes the current federation registry as a PodDirectory graph on a pod.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_name: { type: 'string', description: 'Pod name to publish to (default: authenticated user)' },
        directory_id: { type: 'string', description: 'Optional directory IRI' },
      },
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Publish a directory', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'resolve_webfinger',
    description: 'Compatibility shim — `dereference(host + .well-known/webfinger)` with RFC 7033 parsing. Resolves a WebFinger resource identifier (acct:user@host) to its pod URL. Adds the pod to the registry on success.',
    inputSchema: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: 'WebFinger resource, e.g. acct:alice@example.com' },
      },
      required: ['resource'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Resolve WebFinger handle', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'notify_agent',
    description: 'Send a notification to another agent on the Interego federation. Delivered as an ActivityStreams 2.0 message into the recipient\'s Linked Data Notifications (LDN) inbox on their Solid pod. Address the recipient by DID (did:ethr:0x…), pod URL, or acct: handle (acct:<id>@<relay-host>) — resolve via list_known_pods. Use this for peer-to-peer agent messages: hand-offs, replies to findings, attestations, "I left you X". The recipient reads it with read_inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient: a DID, pod URL, or acct: handle (see list_known_pods).' },
        summary: { type: 'string', description: 'One-line summary (shows in inbox previews).' },
        content: { type: 'string', description: 'Optional longer message body.' },
        about: { type: 'string', description: 'Optional IRI this is about (a finding, resolution, descriptor, or graph).' },
        in_reply_to: { type: 'string', description: 'Optional IRI this notification replies to.' },
        type: { type: 'string', description: 'ActivityStreams type: Create (default), Announce, Offer, Question, Update.' },
      },
      required: ['to', 'summary'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Notify an agent', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'sign_request',
    description: 'Sign a payload AS your bound identity, producing a rev-196 signed-request envelope { _signature, _signed_payload }. This is your signing primitive: relay-mediated agents hold no key of their own, so to invoke an affordance that authenticates via a signed request (e.g. the Foxxi performance-record review, iep:action urn:iep:action:foxxi:review-record) you call sign_request with your intended args as `payload`, then pass the returned envelope as the `payload` of `act` on that affordance. The relay signs with its delegation key, binding YOUR authenticated identity (derived from your session — you cannot sign as anyone else); the target verifies your delegation against your own pod. No key material is exposed. WHAT IS SIGNED: the canonical message commits to your IDENTITY (agent_id), your pod, and a fresh timestamp (replay protection) — these are the security boundary, and the target binds the acted-on subject to this signed identity, so a caller can never reach another subject\'s data. Response-affecting options you pass (e.g. include_clr) are folded into the signed payload on a best-effort basis (object or JSON-string `payload`); treat them as ADVISORY — they only ever shape your OWN response and are never a cross-subject authority.',
    inputSchema: {
      type: 'object',
      properties: {
        payload: { description: 'The request arguments you want signed (an object). Your identity + a fresh timestamp are added automatically; any agent_id/timestamp/subject_pod_url you pass is ignored and overwritten from your session.' },
      },
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Sign a request as yourself', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'read_inbox',
    description: 'Read notifications delivered to your Linked Data Notifications (LDN) inbox, newest-first. Defaults to your own pod; pass pod_url to read a specific pod\'s inbox. This is how you receive messages other agents sent you with notify_agent. Check it when someone says "I left you a message on Interego".',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod whose inbox to read. Defaults to your own pod.' },
        limit: { type: 'integer', description: 'Max notifications to return (default 50).' },
      },
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Read your inbox', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'set_reachability',
    description: 'Declare external reachability channels on your own agent card so other agents (and notify_agent) can reach you beyond the substrate. Native channels (LDN inbox, ActivityPub, acct: handle) are automatic. Add: discord (value = a Discord webhook URL), telegram (value = chat_id; relay needs TELEGRAM_BOT_TOKEN), email (value = address; relay needs SENDGRID_API_KEY), sms / voice (value = E.164 phone; relay needs Twilio creds). Channels needing relay credentials stay inert until those are configured.',
    inputSchema: {
      type: 'object',
      properties: {
        channels: {
          type: 'array',
          description: 'Channels to set: [{ type, value }]. type ∈ {discord, telegram, email, sms, voice}.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'discord | telegram | email | sms | voice' },
              value: { type: 'string', description: 'webhook URL / chat_id / email / E.164 phone' },
            },
            required: ['type', 'value'],
          },
        },
      },
      required: ['channels'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Set reachability channels', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'rebuild_manifest',
    description: 'Reconstruct a pod\'s .well-known/context-graphs manifest index from its on-pod descriptors. Heals f-manifest-collapse — a lost or truncated index where the descriptors + payloads are still intact. Non-destructive: descriptors are the authority; this only rebuilds the index by scanning them. Defaults to your own pod; pass pod_url to restore a peer pod.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod whose manifest to rebuild. Defaults to your own pod.' },
      },
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Rebuild pod manifest', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'unsubscribe_from_pod',
    description: 'Compatibility shim — paired with subscribe_to_pod. Closes an active WebSocket subscription on a Solid pod. Releases a slot toward the relay-wide subscription cap. No-op if not subscribed.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Solid pod URL to unsubscribe from' },
      },
      required: ['pod_url'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Unsubscribe from pod', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'subscribe_all',
    description: 'Compatibility shim — `knownPods.forEach(subscribe_to_pod)`. Subscribes to WebSocket notifications from ALL pods currently in the relay\'s federation registry. Use add_pod / discover_directory first to populate.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Subscribe to all known pods', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'setup_identity',
    description: 'Compatibility shim — composes identity-server setup affordance + agent-registry mint. First-time onboarding for a human (local stdio surface). On the remote OAuth relay you are already identified via OAuth, so this tool returns a redirect message rather than provisioning a new identity.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable name (e.g. "Sarah Chen")' },
        user_id: { type: 'string', description: 'Short identifier (e.g. "sarah") — auto-derived from name if omitted' },
        agent_name: { type: 'string', description: 'Label for the agent (e.g. "Claude Code (Sarah)")' },
      },
    },
    outputSchema: STUB_REDIRECT_OUTPUT,
    annotations: { title: 'Set up an identity', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'link_wallet',
    description: 'Compatibility shim — composes SIWE-message construction + identity-server link affordance. Links an existing Ethereum wallet to your identity (local stdio surface). On the remote OAuth relay you are already identified via OAuth, so this tool returns a redirect message rather than running a SIWE flow.',
    inputSchema: {
      type: 'object',
      properties: {
        wallet_address: { type: 'string', description: 'Your Ethereum wallet address (0x...)' },
        signature: { type: 'string', description: 'SIWE signature (0x...) — if you already signed offline. Omit to get the message to sign.' },
      },
      required: ['wallet_address'],
    },
    outputSchema: STUB_REDIRECT_OUTPUT,
    annotations: { title: 'Link a wallet to identity', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'check_balance',
    description: 'Compatibility shim — calls the active chain\'s RPC; not a substrate-level operation. Checks the ETH balance of a wallet on the active chain. Returns balance, funding status, and instructions if unfunded.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet address to check (default: the relay\'s compliance wallet)' },
      },
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Check wallet balance', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'analyze_question',
    description: 'Compatibility shim — composes the affordance engine\'s cognitive-strategy primitive. Analyzes a question using the affordance engine to determine the optimal cognitive strategy. Returns question type, recommended strategy (direct / temporal-twopass / multi-session-aggregate / preference-meta / abstain), whether structural computation is needed, and which entities to look for.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to analyze' },
        session_content: { type: 'string', description: 'Optional session content to check for abstention (are the question entities present?)' },
      },
      required: ['question'],
    },
    outputSchema: ANALYZE_QUESTION_OUTPUT,
    annotations: { title: 'Analyze a question', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'interrogative_route',
    description: 'Answer interrogatives about a context descriptor by projecting the facet(s) that answer each — the runtime realization of the Interego ie: grammar. Pass a natural-language `question` (lexically classified into interrogative types from the ie: SKOS labels) OR an explicit `interrogatives` list (' + CANONICAL_ORDER.join(' / ') + '), plus the descriptor `url`. Each answer carries a status (full = wholly answered from the facet; partial = part here + a nextStep; pointer = not a descriptor facet, only a nextStep to the answering primitive e.g. pgsl_resolve for What; absent = the answering facet is missing). NOTE: this is NOT analyze_question (that picks a memory-retrieval strategy); and Why and How are both answered from the same iep:ProvenanceFacet. Read-only; composes get_descriptor.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Descriptor .ttl URL to interrogate (REQUIRED; `target` is an alias). Routed through the same fetch/decrypt/cache/auth path as get_descriptor. Pick one via discover_context / discover_all first.' },
        target: { type: 'string', description: 'Alias for `url`.' },
        question: { type: 'string', description: 'Natural-language question; lexically classified into interrogative type(s).' },
        interrogatives: { type: 'array', items: { type: 'string' }, description: 'Explicit interrogative(s), e.g. ["Who","When"] — bypasses NL classification. One or more of: ' + CANONICAL_ORDER.join(', ') + '.' },
        all: { type: 'boolean', description: 'Project all eleven interrogatives (only honored when neither `question` nor `interrogatives` is given).' },
        bypass_cache: { type: 'boolean', description: 'Bypass the descriptor body cache.' },
      },
      required: ['url'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Route interrogatives over a descriptor', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pgsl_ingest',
    description: 'Compatibility shim — internally `promote(tokens)`. For pure substrate access, use the kernel verb `promote` directly. Ingests content into the PGSL lattice. Tokenizes the content, builds the overlapping-pair lattice bottom-up, and returns the top fragment URI. Optionally publishes the lattice as a context descriptor to the pod.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Text content to ingest into the lattice' },
        publish_to_pod: { type: 'boolean', description: 'Also publish as a context descriptor to the pod (default: false)' },
      },
      required: ['content'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Ingest into PGSL lattice', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pgsl_resolve',
    description: 'Compatibility shim — composes `decompose` (for fragments) and value-resolution. For pure substrate access, use `decompose`. Resolves a PGSL URI to its content. For atoms: returns the value. For fragments: returns the full reconstructed text. Also shows node metadata (level, constituents, pullback, provenance).',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'PGSL URI to resolve (urn:pgsl:atom:... or urn:pgsl:fragment:...)' },
      },
      required: ['uri'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Resolve a PGSL URI', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pgsl_lattice_status',
    description: 'Compatibility shim — local view of the PGSL fibration\'s base. Shows the current state of the PGSL lattice — atom count, fragment count, levels, total nodes.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'PGSL lattice status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pgsl_meet',
    description: 'Compatibility shim — kernel `compose([a,b], "intersection")` realizes the same lattice meet at the descriptor layer; this shim retains the PGSL-fragment-specific view. Computes the lattice meet (greatest lower bound) of two fragments — the largest shared sub-sequence. This is the categorical intersection in the presheaf topos.',
    inputSchema: {
      type: 'object',
      properties: {
        uri_a: { type: 'string', description: 'First PGSL fragment URI' },
        uri_b: { type: 'string', description: 'Second PGSL fragment URI' },
      },
      required: ['uri_a', 'uri_b'],
    },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'PGSL lattice meet', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pgsl_to_turtle',
    description: 'Compatibility shim — serializes the kernel\'s shared PGSL instance. Serializes the entire PGSL lattice as RDF Turtle. Includes atoms, fragments, pullback structures, and provenance — all as typed RDF resources with the pgsl: vocabulary.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: GENERIC_OUTPUT_SCHEMA,
    annotations: { title: 'Serialize PGSL as Turtle', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  // ── Generic affordance follower (Path A — reach any vertical) ──
  {
    name: 'invoke_affordance',
    description: 'Compatibility shim — internally `act({descriptorUrl, actionIri}, payload)`. For pure substrate access, use the kernel verb `act` directly. Generic affordance follower. Given a descriptor URL and a iep:action IRI, this fetches the descriptor, finds the matching iep:Affordance block, and POSTs your payload to its hydra:target — proxying through the MCP layer so any vertical (Foxxi, LRS, OWM, ADP, AC, LPC, ...) is reachable through the one Interego connector. Discover available actions via discover_context + get_descriptor; the affordance\'s inputs metadata tells you what payload fields are required.',
    inputSchema: {
      type: 'object',
      properties: {
        descriptor_url: { type: 'string', description: 'URL of the Context Descriptor containing the affordance (e.g., a Foxxi course descriptor URL).' },
        action_iri: { type: 'string', description: 'The iep:action IRI of the affordance to invoke (e.g., urn:iep:action:foxxi:discover-assigned-courses). Discover available actions via discover_context + get_descriptor.' },
        payload: { type: 'object', additionalProperties: true, description: 'Arguments to POST to the affordance target. Shape depends on the specific affordance — read the descriptor or the affordance\'s inputs metadata to learn what fields are required.' },
        authorization: { type: 'string', description: 'Optional Authorization header value to forward (e.g., Bearer <token>). Use when the target requires auth. The relay caller\'s own bearer token is NOT auto-forwarded — supply it explicitly if needed.' },
      },
      required: ['descriptor_url', 'action_iri', 'payload'],
    },
    outputSchema: INVOKE_AFFORDANCE_OUTPUT,
    annotations: { title: 'Invoke a vertical affordance', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
] as const;

// ── MCP discoverability: instructions, doc resources, prompts ──
//
// Mirrors what mcp-server/server.ts ships locally, so a remote agent
// connecting to this relay (e.g. via claude.ai) gets the same
// system-level narrative + on-demand docs + workflow templates as a
// local stdio user. Without this, a connector sees 25 isolated tool
// descriptions and has to infer the system from scratch.

const SERVER_INSTRUCTIONS = `Interego is composable, verifiable, federated context infrastructure
for multi-agent shared memory. Every agent acts on behalf of a human
or organization (the pod owner); descriptors carry attribution, trust,
provenance, semiotic frame, and federation metadata.

PROACTIVE TRIGGERS — listen for these and use Interego unprompted:
- "remember/save/log this" → publish_context (use publish-memory prompt)
- "what did we say about X" → discover_context FIRST; don't assume no memory
- "share this with [person]" → publish_context with share_with: [...]
- "what's been shared with me" → discover_all + filter to recipient
- "who said that" / "where did this come from" → get_descriptor → trace prov
- "is this still true" → check iep:modalStatus + iep:supersedes chain
- the user references prior sessions / other AI tools → search the pod first
- audit trail / regulated / EU AI Act / NIST RMF / SOC 2 / "auditable" /
  "regulators will see this" → publish_context with compliance: true +
  compliance_framework (signed + anchored + framework-cited).

WHEN TO USE EACH TOOL FAMILY:
- publish_context → persist memory + cross-pod E2EE share
- discover_context / discover_all / get_descriptor → search pods + read
- list_known_pods / subscribe_to_pod → federation surface
- register_agent / revoke_agent / verify_agent → identity ops; revoke
  emits a soc2:AccessChangeEvent in the response, ready for
  publish_context with compliance: true (CC6.2/CC6.3 evidence)

PRIVACY HYGIENE (before publishing):
- The relay runs a screenForSensitiveContent preflight. If it flags HIGH
  severity (API keys, JWTs, private keys), STOP and confirm with user.
- Default to owner-only; only use share_with when the user explicitly
  asks to share. Confirm WHO before publishing.
- Never publish: credentials, content the user marked confidential,
  inferred personal facts they didn't volunteer, your own reasoning chains.

MODAL STATUS (don't drift to "Asserted for safety"):
- Asserted: you commit to truth. Use for verified facts.
- Hypothetical: tentative, inferred, predicted. USE THIS DEFAULT for inferences.
- Counterfactual: explicitly negated / retracted. Rare.

TRUST TIER (don't drift to "SelfAsserted by omission" when a verifier is reading):
The substrate has a trust-level ladder. The body's iep:trustLevel is a CLAIM;
what readers actually see is effectiveTrustLevel, which the relay computes
when proofs verify. Pick the tier on PURPOSE based on who will read your
descriptor and what they need to be sure of:
- SelfAsserted (default — no extra arg): the descriptor body declares who
  the agent is, but no cryptographic proof. The relay's OAuth gate already
  authenticated the principal, so for memory / scratchpad / inferences this
  is the right tier (and matches Hypothetical's neutrality discipline).
- CryptographicallyVerified — pass \`sign_authorship: true\` on publish_context.
  The relay embeds a iep:authorshipProof signed with the calling agent's
  delegation key (ECDSA-secp256k1). The proof verifies from the descriptor
  ALONE — readers don't need to trust pod storage. USE THIS when: another
  agent will verify this came from YOU (not just your pod), you are
  publishing into an audit trail, or you are entering/ratifying a contract
  (odrl:Agreement, rules-of-engagement) that requires a verified principal.
- HighAssurance — pass \`compliance: true\` (and a compliance_framework).
  Adds an operator-grade signature over the WHOLE descriptor turtle. For
  regulated evidence (EU AI Act, NIST RMF, SOC 2) and high-stakes attestations.
  Requires non-Hypothetical modal status.

CONTRACTS MAY REQUIRE A MINIMUM TIER. When publishing into an existing
odrl:Agreement, ttt:Game, ratification flow, or similar policy, READ the
contract's required iep:trustLevel before publishing. If it asks for
CryptographicallyVerified, pass sign_authorship: true — do NOT emit a
\`"signed": true\` triple in the body and call it done; that is a SelfAsserted
CLAIM about signing, not an actual signature. The relay's verifier (and any
third-party replayer) treats the two completely differently. If your client
surface does not appear to expose sign_authorship in its UI, try passing it
in the tool-call args anyway — MCP arg names are pass-through; some clients
filter UI parameters but transmit args verbatim.

VERSIONING (auto_supersede_prior=true is the right default):
- Leave true when updating, sharing, or republishing the same memory.
- Set false ONLY for genuine sibling descriptors (e.g., multi-agent perspectives).

ERRORS — don't pretend success:
- Pod unreachable → tell the user; this stays in-conversation only.
- Validation failed → show the error + propose a fix.
- Cross-pod share resolved 0 agents → recipient unreachable; ask user.

KEY INVARIANTS (do not violate):
- Pods are the source of truth. Identity server is stateless.
- DIDs are canonical identifiers; userIds are derived. Never accept a
  user-supplied userId.
- All cross-pod content is end-to-end encrypted; recipients are
  cryptographic, not access-list.
- Descriptors are versioned via iep:supersedes; cached decisions are
  verifiable-stale, not silent.

DEEPER REFERENCE (fetch via resources/read when you need it):
- docs://interego/playbook        — agent-side concrete "when X do Y" rules
- docs://interego/overview        — what Interego is, top-level
- docs://interego/architecture    — protocol architecture + facets
- docs://interego/layers          — L1 protocol vs L2 patterns vs L3 domains
- docs://interego/emergence       — emergent properties + demos
- docs://interego/abac-pattern    — attribute-based access control
- docs://interego/code-domain     — example L3 domain ontology

If the user is asking general questions about the protocol, fetch the
relevant doc resource rather than answering from inferred knowledge.

If you're acting on Interego for the first time in a session and aren't
sure WHEN/HOW to use a tool, fetch docs://interego/playbook first.`;

// Doc resources are read on demand. Files are baked into the docker
// image at /app/relay-docs/ (see Dockerfile.relay) and also live one
// directory up during dev (deploy/mcp-relay/server.ts → context-graphs/{spec,docs,README.md}).
const __relayDir = pathDirname(fileURLToPath(import.meta.url));

function resolveDocFile(...candidatePaths: string[][]): string | null {
  for (const segs of candidatePaths) {
    const candidate = resolvePath(__relayDir, ...segs);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface DocResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  // Try each path; first one that exists wins. First path is the
  // production (/app/relay-docs/) layout; second is dev fallback.
  candidatePaths: string[][];
}

const DOC_CONTENT_CACHE = new Map<string, string>();

const DOC_RESOURCES: readonly DocResource[] = [
  {
    uri: 'docs://interego/playbook',
    name: 'Interego — Agent Playbook (when X do Y)',
    description: 'Operational playbook for AI agents using the Interego MCP. Covers proactive triggers, privacy hygiene, modal-status selection, versioning defaults, error handling, cross-surface continuity, ABAC. Fetch this on first use of Interego in a session.',
    mimeType: 'text/markdown',
    candidatePaths: [['relay-docs', 'AGENT-PLAYBOOK.md'], ['..', '..', 'docs', 'AGENT-PLAYBOOK.md']],
  },
  {
    uri: 'docs://interego/integration-guide',
    name: 'Interego — Integration Guide for Agent Frameworks',
    description: 'One-page integrator guide for AI agent harnesses (OpenClaw, Cursor, Cline, Aider, custom). System-prompt snippet to embed, optional native library integration, conformance levels, brand-neutral framing.',
    mimeType: 'text/markdown',
    candidatePaths: [['relay-docs', 'AGENT-INTEGRATION-GUIDE.md'], ['..', '..', 'docs', 'AGENT-INTEGRATION-GUIDE.md']],
  },
  {
    uri: 'docs://interego/overview',
    name: 'Interego — Overview',
    description: 'Top-level project README: what Interego is, who it\'s for, key features.',
    mimeType: 'text/markdown',
    candidatePaths: [['relay-docs', 'README.md'], ['..', '..', 'README.md']],
  },
  {
    uri: 'docs://interego/architecture',
    name: 'Interego — Architecture (normative)',
    description: 'Protocol architecture: seven facet types, composition operators, federation model, RDF 1.2 / SHACL 1.2 alignment.',
    mimeType: 'text/markdown',
    candidatePaths: [['relay-docs', 'architecture.md'], ['..', '..', 'spec', 'architecture.md']],
  },
  {
    uri: 'docs://interego/layers',
    name: 'Interego — Layering Discipline',
    description: 'L1 (protocol) vs L2 (architecture patterns) vs L3 (implementation + domain).',
    mimeType: 'text/markdown',
    candidatePaths: [['relay-docs', 'LAYERS.md'], ['..', '..', 'spec', 'LAYERS.md']],
  },
  {
    uri: 'docs://interego/derivation',
    name: 'Interego — Derivation Discipline',
    description: 'Normative construction rules: every L2/L3 ontology class must be grounded in L1 primitives.',
    mimeType: 'text/markdown',
    candidatePaths: [['relay-docs', 'DERIVATION.md'], ['..', '..', 'spec', 'DERIVATION.md']],
  },
  {
    uri: 'docs://interego/emergence',
    name: 'Interego — Emergent Properties',
    description: 'Demos showing emergent properties of the protocol: vocabulary alignment, mediator pullback, localized closed-world, stigmergic colony.',
    mimeType: 'text/markdown',
    candidatePaths: [['relay-docs', 'EMERGENCE.md'], ['..', '..', 'docs', 'EMERGENCE.md']],
  },
  {
    uri: 'docs://interego/abac-pattern',
    name: 'Interego — ABAC pattern (L2)',
    description: 'Attribute-based access control: policies as descriptors, SHACL predicates, federated attribute resolution.',
    mimeType: 'text/turtle',
    candidatePaths: [['relay-docs', 'abac.ttl'], ['..', '..', 'docs', 'ns', 'abac.ttl']],
  },
  {
    uri: 'docs://interego/code-domain',
    name: 'Interego — code: domain ontology (L3)',
    description: 'Example L3 domain ontology for source-code artifacts (Repository, Commit, Branch, PullRequest, Review, Defect).',
    mimeType: 'text/turtle',
    candidatePaths: [['relay-docs', 'code.ttl'], ['..', '..', 'docs', 'ns', 'code.ttl']],
  },
];

interface PromptDef {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  build: (args: Record<string, string>) => string;
}

const PROMPTS: readonly PromptDef[] = [
  {
    name: 'publish-audit-record',
    description: 'Publish a compliance-grade audit-trail descriptor (signed, trust-upgraded, framework-cited, anchored). Use for regulated contexts (EU AI Act / NIST RMF / SOC 2) or when the user asks for an auditable record.',
    arguments: [
      { name: 'topic', description: 'What action is being recorded.', required: true },
      { name: 'content', description: 'Turtle content; include dct:conformsTo <framework-control-IRI> so /audit/compliance can aggregate.', required: true },
      { name: 'framework', description: 'Regulatory framework: eu-ai-act | nist-rmf | soc2.', required: false },
    ],
    build: (a) => `Publish a COMPLIANCE-GRADE audit record:

Topic: ${a.topic}
Framework: ${a.framework ?? '(unspecified — signed but not framework-cited)'}

Use publish_context with:
  - graph_iri: urn:graph:audit:<slug-of-topic>:<timestamp>
  - graph_content: ${a.content}
  - modal_status: Asserted (compliance grade requires committed claims)
  - compliance: true
${a.framework ? `  - compliance_framework: '${a.framework}'\n` : ''}
Response includes signature (.sig.json url, signer address, signedAt) and
complianceCheck (compliant + violations + upgradedFacets). Surface results
to the user. Point them at /audit/compliance/${a.framework ?? '<framework>'}
to see overall conformance after this record.`,
  },
  {
    name: 'whats-on-my-pod',
    description: 'Quick orientation: enumerate, summarize, and present what context descriptors currently live on the user\'s home pod. Run this when the user asks "what do you remember?" / "what\'s there?" / "what\'s on my pod".',
    arguments: [
      { name: 'limit', description: 'Maximum descriptors to surface (default 25).', required: false },
      { name: 'topic_filter', description: 'Optional substring to filter descriptors by graph IRI or content.', required: false },
    ],
    build: (a) => `Use discover_context to enumerate descriptors on the user's home pod${a.topic_filter ? ` (filtering for "${a.topic_filter}")` : ''}.

For each descriptor you find (up to ${a.limit ?? '25'}):
- Surface the graph_iri + descriptor URL
- Note the modal status (Asserted / Hypothetical / Counterfactual)
- Note who attributed it (prov:wasAttributedTo)
- Note when it was published (validFrom)
- If the content is small, include a one-line summary; otherwise just the topic

Group the results by either author or topic, whichever produces a clearer picture.

End with a short summary of total descriptor count + notable patterns (most recent topics, dominant authors, anything Hypothetical or Counterfactual that might warrant the user's attention).

Cite descriptor URLs so the user can drill in via get_descriptor on anything interesting.`,
  },
  {
    name: 'publish-memory',
    description: 'Publish a typed memory descriptor to the user\'s home pod so it survives across sessions and is discoverable by other agents.',
    arguments: [
      { name: 'topic', description: 'Short topic or title for the memory.', required: true },
      { name: 'content', description: 'The actual content to remember (free-form text or RDF Turtle).', required: true },
      { name: 'modal_status', description: 'Asserted | Hypothetical | Counterfactual (default Asserted).', required: false },
    ],
    build: (a) => `Use publish_context to persist this memory to the user's home pod:

Topic: ${a.topic}
Content: ${a.content}
Modal status: ${a.modal_status ?? 'Asserted'}

Construct an appropriate graph_iri (urn:graph:memory:<slug>), include the
content as graph_content, and use the modal status above. Confirm with the
user that the descriptor was published, and report the descriptor URL.`,
  },
  {
    name: 'discover-shared-context',
    description: 'Find what context other agents have shared with the user, across known pods.',
    arguments: [
      { name: 'topic', description: 'Optional topic filter (substring match).', required: false },
      { name: 'since', description: 'Optional ISO 8601 datetime — only descriptors validFrom on/after this.', required: false },
    ],
    build: (a) => `Discover context shared with the user across known pods:

1. Use list_known_pods to enumerate the federation surface.
2. For each pod, use discover_context (with effective_at = now to filter
   to currently-valid descriptors).
${a.topic ? `3. Filter results by topic substring: "${a.topic}".\n` : ''}${a.since ? `4. Filter to descriptors with validFrom ≥ ${a.since}.\n` : ''}
5. Summarize: which pods returned what, total descriptor count, any
   noteworthy modal statuses.

Surface anything the user might have forgotten about, and offer to
get_descriptor for fuller content on any specific descriptor.`,
  },
  {
    name: 'verify-trust-chain',
    description: 'Verify the delegation + signature chain on a specific descriptor (provenance audit).',
    arguments: [
      { name: 'descriptor_url', description: 'Full URL of the descriptor to verify.', required: true },
    ],
    build: (a) => `Verify the trust chain for descriptor: ${a.descriptor_url}

1. Use get_descriptor to fetch the full Turtle.
2. Read the AgentFacet (assertingAgent + onBehalfOf) and TrustFacet
   (issuer + trustLevel).
3. Use discover_context with verify_delegation=true on the descriptor's
   origin pod to confirm the agent is in the owner's authorized agents list.
4. Report: who authored, on whose behalf, with what trust level, and
   whether the delegation chain verifies.`,
  },
  {
    name: 'explain-interego',
    description: 'Briefly explain to the user what Interego is and what they can do with this MCP server.',
    arguments: [],
    build: () => `Read the docs://interego/overview resource. Then summarize for the
user, in their words, what Interego is and three concrete things they
can do right now with this MCP server. Keep it under 150 words.

Offer to show them more — point at docs://interego/architecture for
the protocol shape, docs://interego/emergence for what's possible, or
just demo a publish + discover round-trip on their own pod.`,
  },
];

// ── MCP Server Factory ──────────────────────────────────────
// One Server instance per /mcp request (stateless mode). Wires ListTools
// and CallTool to the same handler registry used by the REST routes.

function buildMcpServer(authContext: { agentId: string; ownerWebId?: string; userId?: string; podUrl?: string; identityToken?: string; oauthScopes?: readonly string[]; accessToken?: string } | null): Server {
  const server = new Server(
    { name: '@interego/mcp-relay', version: '0.3.0' },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_SCHEMAS.map((t) => ({...t })),
  }));

  // ── Resources: doc:// URIs serve protocol documentation ────
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: DOC_RESOURCES.map(d => ({
      uri: d.uri,
      name: d.name,
      description: d.description,
      mimeType: d.mimeType,
    })),
  }));

  // ── Resource templates: LIVE substrate objects, not files on disk ──
  //
  // Until now every resource this relay served was a STATIC doc read off the
  // container's filesystem. `interego://ns/{owner}/{slug}` is the first LIVE one:
  // it resolves a published graph through the SAME resolveNsGraph() core the HTTP
  // /ns route uses (so SSRF host-pinning comes free) and hands back the
  // HyperMarkdown projection — the affordance set as prose the model reads
  // natively, rather than Turtle only a parser can see.
  //
  // Control targets stay inside the document's own resource (authority closure).
  // The model reads them and CHOOSES to call invoke_affordance(descriptorUrl,
  // rel — the control's action IRI); no MCP client
  // "follows" them, because MCP is an RPC catalog, not a hypermedia protocol.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{
      uriTemplate: 'interego://ns/{owner}/{slug}',
      name: 'Interego — published graph (hypermedia Markdown)',
      description: 'Any PUBLIC graph published at <relay>/ns/{owner}/{slug} — a holon, an ontology, or a SHACL shape — projected as a HyperMarkdown document: YAML-LD frontmatter (identity + data), human prose, typed links, and :::control blocks (what you may do; each block\'s `rel` is the action IRI). To ACT on a control, call invoke_affordance with the frontmatter\'s descriptorUrl and the control\'s rel; the POST target is resolved from the signed descriptor and is deliberately NOT published in the document.',
      mimeType: HYPERMEDIA_MARKDOWN_MEDIA_TYPE,
    }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    // Live substrate resource (resolved, not read off disk).
    const ns = /^interego:\/\/ns\/([^/]+)\/([^/?#]+)$/.exec(req.params.uri);
    if (ns) {
      const owner = decodeURIComponent(ns[1]!);
      const slug = decodeURIComponent(ns[2]!);
      const r = await resolveNsGraph(owner, slug);
      if ('error' in r) throw new Error(`${req.params.uri}: ${r.error}`);
      return {
        contents: [{
          uri: req.params.uri,
          mimeType: HYPERMEDIA_MARKDOWN_MEDIA_TYPE,
          text: nsMarkdown(r.ontologyIri, r.turtle, {
            owner, slug, descriptorUrl: r.descriptorUrl, isOntology: r.isOntology,
          }),
        }],
      };
    }

    const doc = DOC_RESOURCES.find(d => d.uri === req.params.uri);
    if (!doc) throw new Error(`Unknown resource: ${req.params.uri}`);
    const path = resolveDocFile(...doc.candidatePaths);
    if (!path) {
      return {
        contents: [{
          uri: req.params.uri,
          mimeType: doc.mimeType,
          text: `(doc not bundled in this build; see https://github.com/markjspivey-xwisee/interego)`,
        }],
      };
    }
    try {
      let text = DOC_CONTENT_CACHE.get(path);
      if (text === undefined) {
        text = await readFile(path, 'utf8');
        DOC_CONTENT_CACHE.set(path, text);
      }
      return { contents: [{ uri: req.params.uri, mimeType: doc.mimeType, text }] };
    } catch (err) {
      return {
        contents: [{
          uri: req.params.uri,
          mimeType: doc.mimeType,
          text: `(error reading ${path}: ${(err as Error).message})`,
        }],
      };
    }
  });

  // ── Prompts: workflow templates ────────────────────────────
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(p => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const prompt = PROMPTS.find(p => p.name === req.params.name);
    if (!prompt) throw new Error(`Unknown prompt: ${req.params.name}`);
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    for (const arg of prompt.arguments) {
      if (arg.required && !args[arg.name]) {
        throw new Error(`Missing required argument: ${arg.name}`);
      }
    }
    return {
      description: prompt.description,
      messages: [{
        role: 'user' as const,
        content: { type: 'text' as const, text: prompt.build(args) },
      }],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const tool = TOOLS[name] ?? dynamicTools.get(name);
    if (!tool) {
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }

    // FIX D — OAuth-scope write gate. An OAuth bearer issued with only
    // `mcp:read` scope is refused by every write-side tool here, BEFORE
    // any pod state is touched and BEFORE the substrate-level scope
    // gate (which would also refuse but for a different reason — the
    // delegated agent's iep:scope rather than the OAuth bearer's scope).
    //
    // External verifiers can drive this gate end-to-end via the
    // standard OAuth flow:
    //   1. GET /authorize?...&scope=mcp:read → consent → redirect with code
    //   2. POST /token (PKCE exchange) → access_token w/ scope="mcp:read"
    //   3. POST /mcp { tools/call: publish_context, ... } with that bearer
    //   4. observe 403 insufficient_scope from this branch
    //
    // Legacy clients (no oauthScopes — e.g. RELAY_MCP_API_KEY path or
    // the open-mode default) are NOT subject to this gate; they fall
    // through and are still gated by the substrate scope check inside
    // each write handler. Only an OAuth-issued bearer carries an OAuth
    // scope claim to gate on.
    if (
      authContext?.oauthScopes
      && WRITE_SIDE_TOOLS.has(name)
      && !hasWriteOauthScope(authContext.oauthScopes)
    ) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'insufficient_scope',
            code: 403,
            requiredScope: ['mcp', 'mcp:write'],
            grantedScope: Array.from(authContext.oauthScopes),
            reason: `tool "${name}" requires OAuth scope "mcp" or "mcp:write"; bearer was issued with ${JSON.stringify(Array.from(authContext.oauthScopes))}`,
          }),
        }],
        isError: true,
      };
    }

    const args: ToolArgs = { ...(rawArgs ?? {}) };
    // SECURITY: these are relay-injected, server-authoritative identity/credential
    // fields. Strip any client-supplied values UNCONDITIONALLY — before the
    // authContext guard — so they can never be smuggled in via tools/call args in
    // open-mode or the legacy-API-key path (where the block below does not run).
    for (const reserved of ['_session_bearer', '_session_principal', '_identity_token', '_session_agent_did', '_session_agent_id']) {
      delete (args as Record<string, unknown>)[reserved];
    }
    // Inject identity from auth context so the authenticated user's default
    // pod / agent / WebID fill in when the caller doesn't specify them.
    // Applies to ALL tools, not just writes — lets reads like get_pod_status
    // and discover_context default to "your home pod".
    if (authContext) {
      if (!args.agent_id) args.agent_id = authContext.agentId;
      if (!args.owner_webid && authContext.ownerWebId) args.owner_webid = authContext.ownerWebId;
      if (!args.pod_name && authContext.userId) args.pod_name = authContext.userId;
      // Prefer the identity-server-authoritative podUrl over reconstructing
      // from userId. They're equivalent today (identity derives podUrl from
      // userId) but become different once preferred-pod overlays exist —
      // e.g. one user with two credentials canonically sharing one pod.
      // The relay must not silently second-guess the identity layer.
      if (!args.pod_url) {
        args.pod_url = authContext.podUrl
          ?? (authContext.userId ? `${CSS_URL}${authContext.userId}/` : undefined);
      }
      // Thread the identity-server token through so handlers that need to
      // resolve the calling user's identity-side profile (display name,
      // primary agent DID, etc.) can call IDENTITY_URL/me on the user's
      // behalf without taking another auth round-trip. Handlers MUST treat
      // this as opaque + non-overridable from the wire (a caller cannot
      // smuggle their own token in via tools/call arguments — we overwrite).
      if (authContext.identityToken) args._identity_token = authContext.identityToken;
      // Same-origin AMEP session bridge: the raw OAuth access token + the
      // authenticated principal id, so `act`/`invoke_affordance` can drive
      // POST /amep/acts as this user without a pasted bearer (withAmepSession).
      // Reserved + server-injected (stripped from wire input above), so a caller
      // cannot forge either. Bearer is attached ONLY to a same-origin /amep POST.
      if (authContext.accessToken) args._session_bearer = authContext.accessToken;
      // The IRI form of the identity (agent DID / WebID), NOT the bare userId slug
      // — amep needs an IRI actor. Same principalIri() amep's introspect uses, so
      // the stamped act.actor === principal.id.
      if (authContext.userId) args._session_principal = principalIri(authContext.agentId, authContext.ownerWebId, authContext.userId);
      // Thread the THIS-session agent identity through so handlers like
      // handleGetPodStatus can surface the per-surface agent that the
      // current OAuth token actually authorizes (chatgpt-<userId>,
      // claude-mobile-<userId>, ...) instead of falling back to the
      // historical "primary agent" from identity /me. Like _identity_token,
      // these are server-injected and non-overridable from the wire.
      // _session_agent_did carries the agent IRI as it was minted at
      // OAuth (did:web:... when identity returned an agentDid, bare
      // string otherwise); _session_agent_id is the bare slug that handlers
      // can match against IDENTITY_URL/agents/me responses.
      args._session_agent_did = authContext.agentId;
      // Best-effort bare id: handlers use bareAgentId() defensively but
      // pre-computing here avoids re-parsing per call.
      const bareSessionId = authContext.agentId.startsWith('did:web:')
        ? authContext.agentId.split(':').pop()
        : authContext.agentId;
      if (bareSessionId) args._session_agent_id = bareSessionId;
      // Auto-register this participant into the federation directory as
      // an agent card (idempotent, fire-and-forget) so everyone who
      // authenticates becomes discoverable + notifiable without manual
      // add_pod. Use the caller's OWN pod (authContext.podUrl) — NOT
      // args.pod_url, which on tools like discover_context / read_inbox /
      // notify_agent is a TARGET pod, not the caller's. Surface is
      // derived from the session-agent slug prefix when available.
      {
        const sessId = (args._session_agent_id as string | undefined) ?? '';
        const surf = sessId.includes('-') ? sessId.split('-')[0] : undefined;
        autoRegisterAgentCard(
          authContext.podUrl,
          (args._session_agent_did as string | undefined) ?? (args.agent_id as string | undefined),
          surf,
          args.owner_name as string | undefined,
        );
      }
    }

    // ── Lazy pod-init middleware (FIX A) ─────────────────────
    // Self-heal bearers issued before the OAuth-side eager bootstrap:
    // on the first MCP call for a (pod, relay-process) pair, run the
    // SAME bootstrap helper that /oauth/verify uses, behind the SAME
    // per-pod mutex. The HEAD-based idempotency check inside
    // ensurePodInitialized makes every subsequent call free.
    //
    // For tools that materially depend on /agents + /profile/card
    // (POD_AWARE_TOOLS) we AWAIT — those handlers will produce a
    // misleading result against an empty pod. For everything else
    // (mint, dereference of urn:pgsl:*, kernel verbs on the lattice,
    // ping, etc.) we fire the bootstrap as a best-effort warm-up so
    // the next call lands on a populated pod with zero added latency
    // on THIS call.
    //
    // Failure handling: best-effort by default. The exception is the
    // strict-DPoP environment, where AUTH_REQUIRED_TOOLS calls bubble
    // the bootstrap error to the tool handler shell so the client gets
    // a clear failure rather than a silent half-init write.
    if (authContext && authContext.podUrl && authContext.ownerWebId && authContext.userId) {
      const podAware = POD_AWARE_TOOLS.has(name);
      const strictRequired = RELAY_REQUIRE_DPOP && AUTH_REQUIRED_TOOLS.has(name);
      const initAuthCtx = {
        podUrl: authContext.podUrl,
        agentId: authContext.agentId,
        ownerWebId: authContext.ownerWebId,
        userId: authContext.userId,
        ...(authContext.identityToken ? { identityToken: authContext.identityToken } : {}),
      };
      if (podAware) {
        try {
          await ensurePodInitialized(initAuthCtx);
        } catch (err) {
          if (strictRequired) {
            return {
              content: [{ type: 'text' as const, text: `Error: pod bootstrap failed for ${authContext.podUrl}: ${(err as Error).message}` }],
              isError: true,
            };
          }
          // Best-effort: log + let the tool proceed; reads degrade
          // gracefully, writes surface their own underlying error.
          log(`WARN: ensurePodInitialized(${authContext.podUrl}) failed for tool ${name}: ${(err as Error).message}`);
        }
      } else {
        // Fire-and-forget warm-up — do not add latency to lattice /
        // kernel-verb tools that don't read pod state. Swallow the
        // promise rejection; the next pod-aware call retries via the
        // (failure-not-cached) Set logic.
        void ensurePodInitialized(initAuthCtx).catch((err: Error) => {
          log(`WARN: background ensurePodInitialized(${authContext.podUrl}) failed: ${err.message}`);
        });
      }
    }

    try {
      const text = await tool.handler(args);
      // MCP spec: a tool that declares an outputSchema MUST return
      // structuredContent conforming to it. Every relay handler returns
      // a JSON string, so we parse it and attach the object as
      // structuredContent (also serialized into content[0].text for
      // backward-compat with lenient clients). Strict clients
      // (mcp-client-2025-04-04) validate it; lenient ones ignore it.
      // Non-object / unparseable returns are wrapped as { result: ... }
      // so structuredContent is always an object (the permissive
      // outputSchema accepts it).
      return { content: [{ type: 'text' as const, text }], structuredContent: toStructuredContent(text) };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  });

  return server;
}

// Timing-safe string compare to prevent auth-key length leakage
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkMcpApiKey(req: express.Request): { ok: true; authContext: { agentId: string; ownerWebId: string; userId: string } | null } | { ok: false; error: string } {
  // If no key is configured, /mcp is open. Writes still require the relay's
  // existing AUTH_REQUIRED_TOOLS gate downstream.
  if (!RELAY_MCP_API_KEY) return { ok: true, authContext: null };

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return { ok: false, error: 'Missing Authorization: Bearer <key> header' };
  }
  const token = auth.slice(7).trim();
  if (!safeEqual(token, RELAY_MCP_API_KEY)) {
    return { ok: false, error: 'Invalid MCP API key' };
  }
  // Legacy API-key path carries the maintainer-pod identity from
  // RELAY_MAINTAINER_POD_NAME. The startup guard above ensures this var
  // is non-empty whenever RELAY_MCP_API_KEY is set, so this branch always
  // mints an operator-configured identity (no silent default-to-`markj`).
  // Keep the agent ID distinct from per-user OAuth-issued tokens so
  // attributions stay readable in prov:wasAssociatedWith.
  return {
    ok: true,
    authContext: {
      agentId: `urn:agent:anthropic:relay-apikey:${RELAY_MAINTAINER_POD_NAME}`,
      ownerWebId: `${IDENTITY_URL}/users/${RELAY_MAINTAINER_POD_NAME}/profile#me`,
      userId: RELAY_MAINTAINER_POD_NAME,
    },
  };
}

// Suppress randomBytes lint: it's used by ops to generate a RELAY_MCP_API_KEY
// at deploy time (az containerapp update --set-env-vars RELAY_MCP_API_KEY=...),
// but leaving the import in keeps the tsc-strict "unused" warning quiet.
void randomBytes;

// ── Express App ─────────────────────────────────────────────

const app = express();
// Azure Container Apps sits behind Envoy, which sets X-Forwarded-For.
// The SDK's mcpAuthRouter applies express-rate-limit, which throws
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR unless Express trusts the proxy.
// Trust a single hop of proxy (Envoy) so the real client IP is preserved
// without opening up header-spoofing from arbitrary callers.
app.set('trust proxy', 1);

// Body limit: the relay accepts inbound `publish_context` MCP tool calls
// that wrap the caller's `graph_content` payload inside a JSON-RPC
// envelope. With sign_authorship signatures, X25519-XSalsa20-Poly1305
// envelope inflation (~33% base64 overhead per recipient), descriptor
// Turtle, and JSON tool-call framing, a ~50KB user payload routinely
// exceeds the express.json default 100kb cap. The cap surfaces as a
// PayloadTooLargeError at the parser, which the MCP transport then
// reports to the caller as a generic "fetch failed". 4mb matches the
// upstream substrate's default DEFAULT_MAX_GRAPH_BYTES guard in
// `packages/solid/src/client.ts` and is far above any realistic single-
// descriptor publish (oversized payloads are content-addressed into
// PGSL instead, per the size guard's error message).
app.use(express.json({ limit: '4mb' }));
// Login form POSTs x-www-form-urlencoded; OAuth token endpoint does too.
app.use(express.urlencoded({ extended: false, limit: '4mb' }));

// CORS: explicit allowlist, never wildcard. See cors-allowlist.ts for the
// full rationale. Summary:
//
//   - The legacy `Access-Control-Allow-Origin: *` posture was safe TODAY
//     (bearer-token auth on every state-changing call, no cookies) but
//     fragile: any future middleware that sets
//     `Access-Control-Allow-Credentials: true` would silently turn the
//     wildcard into a credentialed cross-origin read hole.
//   - The allowlist is composed from this relay's own FQDN, all sibling
//     deployment FQDNs (identity, dashboard, css-gate, pgsl-browser,
//     acme-id, foxxi-*), the browser-based MCP client hosts we actually
//     serve (https://claude.ai, https://chatgpt.com, https://chat.openai.com),
//     localhost dev ports, and the RELAY_CORS_ALLOWLIST env-var extension.
//   - For unknown origins we serve THIS relay's own FQDN as ACAO so a
//     browser caller cannot read the response (its origin never matches
//     ours). We never emit Access-Control-Allow-Credentials.
//   - `Origin: null` (sandboxed iframes, file://) is rejected.
//
// Audit-relevant: tightening from `*` to an allowlist is the deliberate
// fix to issue `cors`. Adding a new browser-based MCP client host: extend
// BROWSER_MCP_CLIENT_ORIGINS in cors-allowlist.ts (or set
// RELAY_CORS_ALLOWLIST at deploy time for a transient addition).
app.use(corsMiddleware({
  ownOrigin: PUBLIC_BASE_URL || `http://localhost:${PORT}`,
  allowMethods: 'GET, POST, OPTIONS, DELETE',
  allowHeaders: 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version, DPoP',
  exposeHeaders: 'mcp-session-id, mcp-protocol-version',
}));

// ── OAuth Routes ────────────────────────────────────────────
// mcpAuthRouter wires: /.well-known/oauth-authorization-server,
// /.well-known/oauth-protected-resource, /authorize, /token, /register,
// /revoke (optional). Uses our InteregoOAuthProvider for the business logic.
//
// issuerUrl must be the externally-reachable URL of this relay. If unset,
// we fall back to localhost (useful for local dev); deployments MUST set
// PUBLIC_BASE_URL to the true public URL.
const DEFAULT_ISSUER = new URL(PUBLIC_BASE_URL || `http://localhost:${PORT}`);

// ── Solid OIDC / RFC 9449 metadata overrides ────────────────
// Express dispatches the FIRST matching route. Mounting these before the
// SDK's mcpAuthRouter lets us augment the discovery documents with
// DPoP capability advertisement without forking the SDK. Falls back
// (cleanly, via the SDK router) for any field not overridden here.
//
// Required by Solid OIDC §4 for the relay to count as "DPoP-aware"; any
// Solid OIDC client looks for `dpop_signing_alg_values_supported` in
// both documents before deciding it can use DPoP against this relay.
const DPOP_SIGNING_ALGS = ['ES256', 'EdDSA'];
const issuerHref = DEFAULT_ISSUER.href.replace(/\/$/, '');
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  // RFC 8414 (OAuth Authorization Server Metadata) — the body shape is
  // dictated by the spec, so we keep the canonical fields verbatim
  // and add hypermedia (`@context` + `@type` + `affordances`) as
  // additive linked-data decoration so Hydra-aware clients see the
  // authorize/token/register endpoints as fully Hydra-typed operations.
  //
  // Content-Type: RFC 8414 §3.2 mandates `application/json`. Some MCP
  // clients (ChatGPT custom connectors among them) reject any other
  // type — `application/ld+json` triggers a "does not implement OAuth"
  // error there. Honor Accept: send `application/ld+json` only when
  // explicitly requested; default to `application/json`. The body is
  // identical and valid JSON either way (JSON-LD ⊂ JSON).
  const wantsJsonLd = (req.get('accept') || '').includes('application/ld+json');
  res.type(wantsJsonLd ? 'application/ld+json' : 'application/json').json({
    '@context': KERNEL_JSONLD_CONTEXT,
    '@id': `${issuerHref}/.well-known/oauth-authorization-server`,
    '@type': ['hydra:Resource', 'urn:iep:oauth:AuthorizationServerMetadata'],
    conformsToShape: 'urn:iep:shape:OAuthAuthorizationServerMetadata',
    issuer: DEFAULT_ISSUER.href,
    authorization_endpoint: `${issuerHref}/authorize`,
    token_endpoint: `${issuerHref}/token`,
    registration_endpoint: `${issuerHref}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    // OAuth 2.1 scopes advertised by this resource:
    //   - `mcp`       — full access (read + write). Default for clients
    //                   that request no scope or just `mcp`.
    //   - `mcp:read`  — read-only access. A bearer with ONLY this scope
    //                   may invoke discover_context / get_descriptor /
    //                   any other read-side tool but is refused by every
    //                   write-side tool (publish_context, register_agent,
    //                   pgsl_ingest, ...) with 403 insufficient_scope.
    //                   This is the OAuth-layer read/write split — it is
    //                   independent of the substrate-level per-agent
    //                   scope (ReadOnly / ReadWrite / PublishOnly /
    //                   DiscoverOnly) declared in the pod's agent
    //                   registry, which gates the same write tools at a
    //                   different layer (cryptographic delegation chain).
    //   - `mcp:write` — explicit write-side access. Currently a synonym
    //                   for `mcp` (every write-eligible bearer carries
    //                   both). Advertised so external verifiers can
    //                   request it explicitly and so the scope vocabulary
    //                   is symmetric.
    // A bearer with `mcp:read` only does NOT include `mcp` — that is the
    // whole point of the narrowed scope. External verifiers can mint
    // such a bearer via the standard OAuth authorize flow:
    //   GET /authorize?...&scope=mcp:read
    // and then observe the 403 insufficient_scope from any write tool.
    scopes_supported: ['mcp', 'mcp:read', 'mcp:write'],
    // RFC 9449 §5.1 — advertise DPoP support to clients.
    dpop_signing_alg_values_supported: DPOP_SIGNING_ALGS,
    // Hydra affordances — every OAuth endpoint as a hydra:Operation so
    // clients can navigate the auth flow via link traversal.
    affordances: [
      {
        '@type': ['iep:Affordance', 'hydra:Operation'],
        action: 'urn:iep:action:oauth:authorize',
        target: `${issuerHref}/authorize`,
        method: 'GET',
        returns: 'urn:iep:type:AuthorizationCode',
      },
      {
        '@type': ['iep:Affordance', 'hydra:Operation'],
        action: 'urn:iep:action:oauth:token',
        target: `${issuerHref}/token`,
        method: 'POST',
        expects: 'urn:iep:type:TokenRequest',
        returns: 'urn:iep:type:AccessToken',
      },
      {
        '@type': ['iep:Affordance', 'hydra:Operation'],
        action: 'urn:iep:action:oauth:register',
        target: `${issuerHref}/register`,
        method: 'POST',
        expects: 'urn:iep:type:ClientRegistrationRequest',
        returns: 'urn:iep:type:ClientRegistration',
      },
    ],
  });
});
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  // RFC 9728 §3.3 mandates `application/json`. Same Accept-driven
  // negotiation as the authorization-server metadata above —
  // application/json by default, application/ld+json only when asked.
  const wantsJsonLd = (req.get('accept') || '').includes('application/ld+json');
  res.type(wantsJsonLd ? 'application/ld+json' : 'application/json').json({
    '@context': KERNEL_JSONLD_CONTEXT,
    '@id': `${issuerHref}/.well-known/oauth-protected-resource`,
    '@type': ['hydra:Resource', 'urn:iep:oauth:ProtectedResourceMetadata'],
    conformsToShape: 'urn:iep:shape:OAuthProtectedResourceMetadata',
    resource: issuerHref + '/',
    authorization_servers: [DEFAULT_ISSUER.href],
    // Mirror the authorization-server metadata's scope vocabulary. See
    // the long comment above for the read/write split rationale.
    scopes_supported: ['mcp', 'mcp:read', 'mcp:write'],
    resource_name: 'Interego MCP',
    // RFC 9449 §5.1 — advertise DPoP support at the resource as well so
    // clients that only fetch the protected-resource metadata document
    // (Solid OIDC's preferred entry point) know to use DPoP.
    dpop_signing_alg_values_supported: DPOP_SIGNING_ALGS,
    // RFC 9728 §3.2 — declare which bearer-token usage methods this
    // resource accepts. "DPoP" is the canonical method name.
    bearer_methods_supported: RELAY_REQUIRE_DPOP ? ['DPoP'] : ['header', 'DPoP'],
    affordances: [
      {
        '@type': ['iep:Affordance', 'hydra:Operation'],
        action: 'urn:iep:action:oauth:discover-authorization-server',
        target: `${issuerHref}/.well-known/oauth-authorization-server`,
        method: 'GET',
        returns: 'urn:iep:type:AuthorizationServerMetadata',
      },
      {
        '@type': ['iep:Affordance', 'hydra:Operation'],
        action: 'urn:iep:action:mcp:invoke',
        target: `${issuerHref}/mcp`,
        method: 'POST',
        expects: 'urn:iep:type:McpRequest',
        returns: 'urn:iep:type:McpResponse',
      },
      {
        '@type': ['iep:Affordance', 'hydra:Operation'],
        action: 'urn:iep:action:mcp:list-tools',
        target: `${issuerHref}/tools`,
        method: 'GET',
        returns: 'urn:iep:type:HydraCollection',
      },
      {
        // /.well-known/operations — typed substrate-operation catalog
        // (8 kernel verbs + every thin-facade shim) as iep:Affordance
        // entries. Lets a hypermedia client walk discovery → catalog →
        // shape → invocation without an MCP client. See FIX 4 in the
        // survey plan; the underlying route remains POST /mcp (or
        // POST /tool/:name for the REST shortcut), the catalog only
        // publishes WHAT exists and WHERE to send it.
        '@type': ['iep:Affordance', 'hydra:Operation'],
        action: 'urn:iep:action:operations:catalog',
        target: `${issuerHref}/.well-known/operations`,
        method: 'GET',
        returns: 'urn:iep:type:OperationsCatalog',
      },
    ],
  });
});

// ── /.well-known/operations — substrate-operation catalog ──
//
// FIX 4 from the survey: publish a discoverable Hydra collection of
// every named substrate operation (8 kernel verbs + each thin-facade
// MCP tool) so HTTP-only / hypermedia clients can reach the same
// surface MCP clients see. One source of truth (the in-process TOOLS
// registry + TOOL_SCHEMAS), two access paths (MCP JSON-RPC at /mcp,
// hypermedia at /.well-known/operations + /tool/:name).
//
// Invocation contract: client GETs this catalog → picks an
// affordance by matching its `action` IRI / description → dereferences
// `expects` (a SHACL shape served from /.well-known/shacl-shapes) for
// the payload contract → POSTs to `target` (== /tool/<name>) with the
// validated payload + Bearer + DPoP headers. The existing
// app.post('/tool/:name', …) dispatcher handles the rest — no new
// route. kernel.act() callers can use the same catalog uniformly:
// act({descriptorUrl: '<base>/.well-known/operations', actionIri:
// 'urn:iep:action:<name>'}, payload).
app.get('/.well-known/operations', (req, res) => {
  // Same Accept-driven negotiation as the OAuth metadata documents:
  // application/json by default (max-compat with non-JSON-LD clients),
  // application/ld+json only when explicitly requested. Body is the
  // same JSON either way (JSON-LD ⊂ JSON).
  const wantsJsonLd = (req.get('accept') || '').includes('application/ld+json');
  const base = `${req.protocol}://${req.get('host') ?? ''}`;
  const catalogId = `${base}/.well-known/operations`;
  // Schema lookup by name — used to surface input/output schema IRIs
  // pointing into /.well-known/shacl-shapes (one shape per tool name).
  const schemaByName = new Map<string, typeof TOOL_SCHEMAS[number]>(
    TOOL_SCHEMAS.map(t => [t.name, t])
  );
  // Enumerate from the runtime tool registry so the catalog can never
  // drift from the actual /mcp surface. We classify each entry as
  // 'kernel-verb' (the 8 substrate primitives) vs 'thin-facade' (every
  // named shim that ultimately composes through to the kernel).
  // bandaid-parallel-state / bandaid-kernel-bypass entries are *not*
  // in TOOLS at all on this relay, so by construction the catalog
  // only publishes the surface a hypermedia client should reach for.
  const members = Object.entries(TOOLS).map(([name, { description }]) => {
    const schema = schemaByName.get(name);
    const classification = KERNEL_VERBS.has(name) ? 'kernel-verb' : 'thin-facade';
    const authRequired = AUTH_REQUIRED_TOOLS.has(name);
    const shapeIri = `urn:iep:shape:input:${name}`;
    const returnsIri = `urn:iep:shape:output:${name}`;
    const title = schema && typeof (schema as { annotations?: { title?: string } }).annotations?.title === 'string'
      ? (schema as { annotations: { title: string } }).annotations.title
      : name;
    return {
      '@id': `urn:iep:operation:${name}`,
      '@type': ['iep:Affordance', 'hydra:Operation'],
      action: `urn:iep:action:${name}`,
      // REST shortcut — POST to /tool/:name is dispatched by the
      // existing handler at app.post('/tool/:name', …) which routes
      // by toolName through the same TOOLS registry.
      target: `${base}/tool/${name}`,
      method: 'POST',
      title,
      description,
      expects: shapeIri,
      returns: returnsIri,
      classification,
      // Hydra header expectations — Authorization is only required
      // for write tools (AUTH_REQUIRED_TOOLS); DPoP is always
      // optional but advertised so clients know they MAY bind their
      // token. RFC 9449 §5.1 + RFC 9728 §3.2 capability echo.
      'hydra:expectsHeader': [
        { 'hydra:headerName': 'Authorization', 'hydra:required': authRequired },
        { 'hydra:headerName': 'DPoP',          'hydra:required': false },
      ],
      // Pointer into the SHACL shapes graph served by
      // /.well-known/shacl-shapes — clients dereference this to learn
      // the payload contract before POSTing.
      'sh:nodeShape': `${base}/.well-known/shacl-shapes#${shapeIri}`,
    };
  });
  res.type(wantsJsonLd ? 'application/ld+json' : 'application/json').json({
    '@context': KERNEL_JSONLD_CONTEXT,
    '@id': catalogId,
    '@type': ['hydra:Collection', 'urn:iep:type:OperationsCatalog'],
    conformsToShape: 'urn:iep:shape:OperationsCatalog',
    'hydra:totalItems': members.length,
    'hydra:member': members,
  });
});

// ── WebFinger (RFC 7033) + ActivityPub (W3C) discovery surface ──────
//
// Public, pre-auth: these are federation discovery endpoints. They read
// the same agent cards the agent-mesh auto-registration maintains, so an
// agent becomes a resolvable acct: handle + ActivityPub actor the moment
// it first authenticates — no extra registration step.
const RELAY_AP_BASE = (PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

function cardForLocalPart(localPart: string): AgentCardLite | undefined {
  // Collect all matches (there can be host-form duplicates pre-eviction)
  // and prefer the richest — one that actually carries a DID.
  const matches = [...knownPods.values()].filter(e =>
    e.via !== 'self' &&
    (podLocalPart(e.url) === localPart || e.handle === `acct:${localPart}@${RELAY_HANDLE_HOST}`));
  if (matches.length === 0) return undefined;
  const e = matches.find(x => x.did) ?? matches[0]!;
  return { url: e.url, did: e.did, handle: e.handle, inbox: e.inbox ?? inboxUrlFor(e.url), label: e.label, surface: e.surface };
}

app.get('/.well-known/webfinger', async (req, res) => {
  await awaitFederationHydrateWithBudget(50);
  const resource = String(req.query.resource ?? '');
  const m = resource.match(/^acct:([^@]+)@(.+)$/);
  if (!m) { res.status(400).json({ error: 'resource must be acct:<user>@<host>' }); return; }
  const localPart = m[1]!;
  const card = cardForLocalPart(localPart);
  if (!card) { res.status(404).json({ error: `no agent for ${resource}` }); return; }
  res.type('application/jrd+json').json(apBuildWebfinger(resource, RELAY_AP_BASE, localPart, card));
});

app.get('/agents/:localPart', async (req, res) => {
  await awaitFederationHydrateWithBudget(50);
  const card = cardForLocalPart(req.params.localPart);
  if (!card) { res.status(404).json({ error: 'unknown agent' }); return; }
  res.type('application/activity+json').json(apBuildActor(RELAY_AP_BASE, req.params.localPart, card));
});

app.get('/agents/:localPart/outbox', async (req, res) => {
  await awaitFederationHydrateWithBudget(50);
  const card = cardForLocalPart(req.params.localPart);
  if (!card) { res.status(404).json({ error: 'unknown agent' }); return; }
  let descriptors: Array<{ descriptorUrl?: string; graphIri?: string; validFrom?: string; modalStatus?: string }> = [];
  try {
    const entries = await discover(toInternalPodUrl(card.url), { sort: 'newest-first', limit: 50 } as Parameters<typeof discover>[1], { fetch: solidFetch });
    descriptors = entries.map(e => ({ descriptorUrl: e.descriptorUrl, graphIri: (e as { graphIri?: string }).graphIri, validFrom: e.validFrom, modalStatus: (e as { modalStatus?: string }).modalStatus }));
  } catch { /* empty outbox on read failure */ }
  res.type('application/activity+json').json(apBuildOutbox(RELAY_AP_BASE, req.params.localPart, card, descriptors));
});

app.post('/agents/:localPart/inbox', async (req, res) => {
  await awaitFederationHydrateWithBudget(50);
  const card = cardForLocalPart(req.params.localPart);
  if (!card) { res.status(404).json({ error: 'unknown agent' }); return; }
  // NOTE: untrusted cross-server delivery should verify an HTTP Signature
  // here before accepting. For now we accept + map the activity onto the
  // agent's native LDN inbox so federated + in-substrate messages converge.
  const act = (req.body ?? {}) as Record<string, any>;
  const obj = (act.object ?? {}) as Record<string, any>;
  const idSlug = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const notif = buildNotification({
    from: typeof act.actor === 'string' ? act.actor : 'urn:activitypub:remote',
    to: card.did ?? card.url,
    summary: (act.summary ?? obj.summary ?? `${act.type ?? 'Activity'} via ActivityPub`) as string,
    published: new Date().toISOString(),
    ...(typeof obj.content === 'string' ? { content: obj.content } : {}),
    ...(typeof obj.id === 'string' ? { about: obj.id } : {}),
    type: typeof act.type === 'string' ? act.type : 'Create',
  }, idSlug);
  const url = await deliverNotification(toInternalPodUrl(card.url), notif, idSlug, solidFetch, (mm) => log(mm));
  res.status(url ? 202 : 502).json({ accepted: url !== null, stored: url });
});

// ── Shared next-step hint table for relay shim responses ──
//
// Mirrors the table on the stdio server but for the relay's HTTP
// surface. Decorates JSON shim payloads with the affordances callers
// can follow next — plain-text legacy responses are left untouched.
function relayShimNextSteps(name: string, payload: Record<string, unknown>): ReadonlyArray<{ action: string; target: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' }> {
  const pick = (k: string): string | undefined => {
    const v = payload[k];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };
  switch (name) {
    case 'publish_context': {
      const descriptorUrl = pick('descriptorUrl');
      const steps: Array<{ action: string; target: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' }> = [];
      if (descriptorUrl) {
        steps.push({ action: 'urn:iep:action:read',      target: descriptorUrl, method: 'GET' });
        steps.push({ action: 'urn:iep:action:supersede', target: descriptorUrl, method: 'POST' });
      }
      return steps;
    }
    case 'discover_context':
    case 'discover_all':
      return [{ action: 'urn:iep:action:refine-search', target: 'urn:iep:tool:discover_context', method: 'POST' }];
    case 'get_descriptor': {
      const url = pick('url');
      return url
        ? [{ action: 'urn:iep:action:dereference', target: url, method: 'GET' }]
        : [];
    }
    case 'register_agent': {
      const agentIri = pick('agentIri') ?? pick('agentId');
      const steps: Array<{ action: string; target: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' }> = [
        { action: 'urn:iep:action:verify-agent', target: 'urn:iep:tool:verify_agent', method: 'POST' },
      ];
      if (agentIri) steps.push({ action: 'urn:iep:action:revoke-agent', target: agentIri, method: 'DELETE' });
      return steps;
    }
    default:
      return [];
  }
}

function decorateRelayShimText(name: string, text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return text; }
  if (!parsed || typeof parsed !== 'object') return text;
  if (Array.isArray(parsed)) {
    return JSON.stringify(decorateShim({ items: parsed }, {
      tool: name,
      shape: KERNEL_RESULT_SHAPES['result']!,
      nextSteps: relayShimNextSteps(name, {}),
    }));
  }
  // Skip if already decorated (idempotent — kernel-verb handlers may
  // have decorated upstream).
  const payload = parsed as Record<string, unknown>;
  if (payload['@context'] && payload['affordances']) return text;
  const id = typeof payload['descriptorUrl'] === 'string' ? payload['descriptorUrl'] as string
    : typeof payload['url'] === 'string' ? payload['url'] as string
    : undefined;
  return JSON.stringify(decorateShim(payload, {
    tool: name,
    ...(id ? { id } : {}),
    shape: KERNEL_RESULT_SHAPES['result']!,
    nextSteps: relayShimNextSteps(name, payload),
  }));
}

// ── /token DPoP pre-processor ───────────────────────────────
//
// When a client POSTs to /token with a DPoP header alongside its
// authorization_code or refresh_token grant, validate the DPoP proof
// here, compute the JWK thumbprint, and stash it on the provider so
// `exchangeAuthorizationCode` / `exchangeRefreshToken` can embed
// `cnf: { jkt: <thumbprint> }` in the access token and flip
// token_type from "Bearer" to "DPoP".
//
// This runs BEFORE the SDK's tokenHandler (which sees the same route
// because of express's first-mounted-wins for matching prefixes).
// On DPoP failure we 400 immediately and skip the SDK handler so the
// client doesn't get a Bearer token that contradicts its DPoP intent.
const tokenDpopMiddleware: express.RequestHandler = async (req, res, next) => {
  const dpopHeader = req.headers['dpop'];
  if (!dpopHeader || typeof dpopHeader !== 'string') {
    // No DPoP — proceed unchanged. The SDK will issue a plain Bearer token.
    // If RELAY_REQUIRE_DPOP we still allow this through and let the
    // /mcp middleware later reject unbound tokens, which keeps /token
    // useful for the legacy Bearer fallback during transition.
    next();
    return;
  }
  try {
    const htu = reconstructRequestUrl(req);
    const { jkt } = await validateDpopJwt(dpopHeader, {
      htm: 'POST',
      htu,
      // /token requests have no `ath` — there's no access token in scope yet.
    });
    const body = req.body as { grant_type?: string; code?: string; refresh_token?: string };
    if (body?.grant_type === 'authorization_code' && body.code) {
      oauthProvider.bindAuthorizationCodeDpop(body.code, jkt);
    } else if (body?.grant_type === 'refresh_token' && body.refresh_token) {
      // RFC 9449 §5.2: the inbound DPoP key MUST match the JKT the
      // refresh token was originally bound to.
      const bound = oauthProvider.getRefreshTokenJkt(body.refresh_token);
      if (bound && bound !== jkt) {
        res.status(400).json({
          error: 'invalid_dpop_proof',
          error_description: 'DPoP key does not match the original token binding',
        });
        return;
      }
      // If the refresh token wasn't originally DPoP-bound but the
      // client is presenting one now, accept the upgrade — that's
      // the path a client takes when it adopts DPoP on a refresh.
      if (!bound) {
        // Bind retroactively so the next exchangeRefreshToken sees it.
        // We piggy-back on the provider's internal stash by treating
        // the refresh_token string as the binding key.
        // Note: this only matters until rotation; the new refresh
        // token will inherit the binding.
        // (We expose this via getRefreshTokenJkt + the provider's
        // own setter wouldn't be ideal here; we instead let
        // exchangeRefreshToken pick up the binding from the
        // freshly-validated proof through a side-channel header.)
        (req as express.Request & { _dpopJkt?: string })._dpopJkt = jkt;
      }
    }
    next();
  } catch (err) {
    const msg = (err as Error).message;
    res.set('WWW-Authenticate', `DPoP error="invalid_dpop_proof", error_description="${msg.replace(/"/g, "'")}"`);
    res.status(400).json({ error: 'invalid_dpop_proof', error_description: msg });
  }
};
// /token is served by the SDK router below. Express runs middlewares in
// mount order, so mounting this here makes it run BEFORE the SDK handler.
// The DPoP verification below performs WebCrypto signature checks and a
// JTI replay-cache lookup on every inbound request — without a per-IP gate
// here an unauthenticated client could force unbounded crypto.verify work
// before the SDK's own rate limiter is reached.
const tokenLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
// The SDK's mcpAuthRouter sub-routers (/register, /token, /revoke,
// /.well-known/*) each call `router.use(cors())` with default wildcard
// config, which would overwrite the allowlist headers set above with
// `Access-Control-Allow-Origin: *`. Freeze the CORS-related response
// headers our allowlist middleware just set so the SDK's late
// res.setHeader calls cannot re-open the wildcard. Mounted BEFORE
// the /token handler below so any future CORS-touching middleware
// added to that chain still cannot bypass the allowlist.
const FROZEN_CORS_HEADERS = new Set([
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-allow-credentials',
  'vary',
]);
app.use((_req, res, next) => {
  const original = res.setHeader.bind(res);
  (res as unknown as { setHeader: typeof res.setHeader }).setHeader = function (
    name: string,
    value: number | string | readonly string[],
  ): express.Response {
    if (typeof name === 'string' && FROZEN_CORS_HEADERS.has(name.toLowerCase())) {
      return res;
    }
    return original(name, value);
  };
  next();
});

app.post('/token', tokenLimiter, express.urlencoded({ extended: false }), tokenDpopMiddleware);

app.use(mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: DEFAULT_ISSUER,
  // Same vocabulary as the well-known metadata. The SDK passes the
  // requested `scope=` query parameter on /authorize through to
  // oauthProvider.authorize() as params.scopes; from there it propagates
  // into the issued authorization code and (after token exchange) into
  // the access token's `scopes` claim, which is what the /mcp middleware
  // and the per-tool write-side gate (see WRITE_SIDE_OAUTH_SCOPES below
  // and handlePublishContext) inspect to decide read vs. write.
  scopesSupported: ['mcp', 'mcp:read', 'mcp:write'],
  resourceName: 'Interego MCP',
}));

/**
 * POST /oauth/verify — single endpoint the authorize-page JS posts to.
 *
 * Accepts a `method` discriminator ('siwe' | 'webauthn-register' |
 * 'webauthn-authenticate' | 'did') plus the method-specific proof body,
 * forwards to the matching /auth/* endpoint on the identity server, and
 * on success returns { redirect } pointing at the OAuth client's
 * redirect_uri with the authorization code + state.
 *
 * No shared secrets — every successful call is backed by a cryptographic
 * signature verified by identity against the user's public key.
 */
// Rate limiter for /oauth/verify. Each successful call ultimately
// produces a signature-verification request to the identity service;
// without a per-IP cap an attacker could grind through pending_id
// guesses or hammer credential-verification endpoints. The limit is
// generous enough to allow normal interactive auth retries (a user
// fumbling WebAuthn or a SIWE wallet prompt) but kills sustained abuse.
// 30 attempts per minute per IP, then 429 with standard headers.
const oauthVerifyLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.post('/oauth/verify', oauthVerifyLimiter, async (req, res) => {
  const { pending_id, method, ...proofBody } = req.body as {
    pending_id?: string;
    method?: 'siwe' | 'webauthn-register' | 'webauthn-authenticate' | 'did';
    [k: string]: unknown;
  };
  if (!pending_id || !method) {
    res.status(400).json({ error: 'pending_id and method are required' });
    return;
  }

  const endpointByMethod: Record<typeof method, string> = {
    'siwe': '/auth/siwe',
    'webauthn-register': '/auth/webauthn/register',
    'webauthn-authenticate': '/auth/webauthn/authenticate',
    'did': '/auth/did',
  };
  const endpoint = endpointByMethod[method];
  if (!endpoint) {
    res.status(400).json({ error: `Unknown method: ${method}` });
    return;
  }

  let authResp: {
    userId?: string;
    // Display name for the user; used as foaf:name when the relay writes
    // the pod-side /profile/card mirror below (FIX A — single authoritative
    // pod writer).
    name?: string;
    agentId?: string;
    // Display label for the per-surface agent; used as foaf:name in the
    // <pod>/agents registry entry the relay writes below.
    agentName?: string;
    agentDid?: string;
    token?: string;
    webId?: string;
    did?: string;
    podUrl?: string;
    error?: string;
  };
  // Detect the calling MCP client from its DCR-registered client_name so
  // identity mints a surface-specific agent (chatgpt-<userId>,
  // codex-<userId>, cursor-<userId>, etc.) instead of a single relay-wide
  // default. Falls back to RELAY_DEFAULT_SURFACE_AGENT when the
  // client_name is missing / unrecognised — which defaults to the
  // generic `mcp-client`, deliberately NOT `claude-*`, so an unknown
  // client isn't silently attributed to Claude.
  const pending = oauthProvider.getPendingAuthorization(pending_id);
  const clientName = pending?.client?.client_name;
  const surfaceAgent = surfaceAgentFromClient(clientName);

  try {
    const bodyWithSurface = { ...proofBody, surfaceAgent };
    const r = await fetch(`${IDENTITY_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyWithSurface),
    });
    authResp = await r.json() as typeof authResp;
    if (!r.ok || !authResp.userId || !authResp.token) {
      res.status(r.status || 401).json({ error: authResp.error ?? `Identity /auth returned ${r.status}` });
      return;
    }
  } catch (err) {
    res.status(503).json({ error: `Identity server unreachable: ${(err as Error).message}` });
    return;
  }

  // Prefer the agent's did:web form as the agent IRI — bare strings like
  // "claude-code-vscode" aren't valid IRIs for prov:wasAssociatedWith and
  // would render as relative refs in the descriptor's Turtle. did:web IRIs
  // are resolvable via DID resolution and align with the W3C DID core spec.
  const agentIri = authResp.agentDid ?? authResp.agentId!;

  const result = oauthProvider.completePendingAuthorization(pending_id, {
    userId: authResp.userId,
    agentId: agentIri,
    ownerWebId: authResp.webId!,
    podUrl: authResp.podUrl!,
    identityToken: authResp.token,
  });
  if (!result) {
    res.status(400).json({ error: 'Authorization request expired or unknown. Retry from your MCP client.' });
    return;
  }

  // FIX A: relay is the single authoritative pod-side writer for
  // /<userId>/profile/card AND /<userId>/agents. Identity-server's old
  // eager-init writes are removed; two writers were racing on every OAuth
  // completion, producing CSS file-backend HTTP 500s on the second OAuth
  // ("Read counter would become negative" on /profile/card) and a ~10s 404
  // window for any client that hit /agents or /profile/card immediately
  // after the OAuth code came back.
  //
  // FIX B (this block): the OAuth response NO LONGER awaits the pod
  // bootstrap. Identity auth has already succeeded and the authorization
  // code has already been minted by oauthProvider.completePendingAuthorization
  // above — the client only needs the redirect URL to complete the OAuth
  // dance. Bootstrap is dispatched as a fire-and-forget under the SAME
  // per-pod mutex (`podWriteMutexes`) that the lazy-init path at
  // ensurePodInitialized() takes, so the contract holds:
  //
  //   - If the user's first MCP tool call arrives AFTER background
  //     bootstrap finishes, the .then(bootstrappedPods.add) below makes
  //     ensurePodInitialized's Layer-1 Set fast-path absorb the call with
  //     zero added latency.
  //   - If the tool call arrives DURING background bootstrap, its
  //     ensurePodInitialized → withPodMutex(podUrl, ...) queues behind
  //     the in-flight call on the SAME mutex key and proceeds once it
  //     releases — worst-case the original bootstrap latency lands on
  //     the first tool call instead of on the OAuth response.
  //   - If background bootstrap fails (CSS down etc.), bootstrappedPods
  //     is intentionally NOT populated and the next pod-aware tool call
  //     re-runs the bootstrap via ensurePodInitialized's HEAD probe +
  //     mutex path. This is exactly what lazy-init was designed for
  //     (see the comment at ~5071). We log at ERROR level so operators
  //     can correlate slow first tool calls with failed deferred
  //     bootstraps.
  //   - The 502-on-bootstrap-failure of the prior implementation is
  //     dropped: the OAuth code is already valid, the redirect is
  //     already in flight, and forcing the client to retry the verify
  //     step would invalidate a perfectly good authorization.
  //
  // Idempotency of bootstrapPod itself is unchanged:
  //   - First-touch: write both /profile/card AND /agents.
  //   - Surface add: append the surface agent to /agents.
  //   - Re-connect from known surface: no writes at all.
  //
  // Concurrency across simultaneous OAuth flows for the same pod is
  // still handled by the same in-process mutex + post-write
  // verify-and-merge loop inside bootstrapPod.
  const redirect = new URL(result.redirectUri);
  redirect.searchParams.set('code', result.code);
  if (result.state) redirect.searchParams.set('state', result.state);

  // Dispatch background bootstrap BEFORE responding so the mutex slot
  // is reserved before any racing tool call's ensurePodInitialized can
  // observe an unguarded podUrl.
  const podUrlForBg = authResp.podUrl!;
  log(`bootstrap_deferred pod=${podUrlForBg} agent=${agentIri} userId=${authResp.userId}`);
  void withPodMutex(podUrlForBg, () => bootstrapPod({
    podUrl: podUrlForBg,
    ownerWebId: authResp.webId! as IRI,
    surfaceAgentIri: agentIri as IRI,
    userName: authResp.name ?? authResp.userId!,
    agentLabel: authResp.agentName ?? `Surface agent ${surfaceAgent}`,
    userId: authResp.userId!,
    identityWebId: authResp.webId!,
    identityDid: authResp.did,
  }))
    .then(() => {
      // CRITICAL: populate the Set so any tool call that arrives AFTER
      // background bootstrap completes hits ensurePodInitialized's
      // Layer-1 fast-path with zero mutex wait and zero HEAD probe.
      bootstrappedPods.add(podUrlForBg);
      try {
        log(`bootstrap_deferred_ok pod=${podUrlForBg}`);
      } catch { /* never let log() crash a fire-and-forget */ }
    })
    .catch(err => {
      // ERROR level (not WARN) — operators need this to correlate
      // user-visible empty-pod symptoms with deferred-bootstrap failure.
      // bootstrappedPods is intentionally NOT populated on failure so
      // ensurePodInitialized re-runs on the next pod-aware tool call.
      try {
        log(`ERROR: background bootstrapPod(${podUrlForBg}) failed: ${(err as Error).message}`);
      } catch { /* never let log() crash a fire-and-forget */ }
    });

  res.json({ redirect: redirect.toString() });
});

// ── Per-pod in-process mutex (FIX A concurrency) ──────────────────
//
// Serialises read-modify-write of `<pod>/agents` and `<pod>/profile/card`
// within a single relay process. Two simultaneous OAuth flows for the
// same user (e.g. Claude Desktop + Cursor logging in at once on a
// pristine pod) would otherwise both observe an empty registry and
// then write last-wins, losing one surface agent. The mutex makes the
// second flow wait for the first's PUTs to land before it does its own
// read.
//
// This is an in-process mutex — it does NOT cross relay replicas. The
// relay currently runs single-replica; if multi-replica is ever turned
// on we would need a CSS-side compare-and-swap (e.g. ETag-based
// If-Match) or an external lock. The post-write verify-and-merge loop
// inside `bootstrapPod` provides a best-effort safety net even
// across replicas.
const podWriteMutexes = new Map<string, Promise<unknown>>();

async function withPodMutex<T>(podUrl: string, fn: () => Promise<T>): Promise<T> {
  const prev = podWriteMutexes.get(podUrl) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Chain so the next caller waits for THIS call's gate, not the prior
  // one. Errors from prior callers must not propagate to the next caller.
  // Keep a handle to the EXACT value stored in the map: the cleanup below must
  // compare against `chained`, not `gate` — the map never holds `gate`, so the
  // old `=== gate` check never matched and the entry was never freed (an
  // unbounded leak, one entry per distinct podUrl / AMEP exchange slug forever).
  const chained = prev.then(() => gate, () => gate);
  podWriteMutexes.set(podUrl, chained);
  try {
    await prev.catch(() => undefined);
    return await fn();
  } finally {
    release();
    // Clean up if we're still the last entry in the chain (no later caller has
    // replaced the map value).
    queueMicrotask(() => {
      if (podWriteMutexes.get(podUrl) === chained) podWriteMutexes.delete(podUrl);
    });
  }
}

// Maximum number of re-merge attempts when the post-write verify
// observes that our surface agent isn't in the registry (concurrent
// writer clobbered us between our read and our write). Three attempts
// is enough for any reasonable burst — beyond that we surface an
// error rather than spinning indefinitely.
const POD_BOOTSTRAP_MAX_ATTEMPTS = 3;

// ── Pod-side WAC .acl writer ──────────────────────────────────────
//
// On first-touch pod init we PUT proper WAC turtle to `<container>.acl`
// for every container that needs a policy distinct from the parent.
//
// Policy summary (WAC inheritance handles unspecified children):
//
//   /                — public Read, owner Read+Write+Control
//   /profile/        — public Read, owner Read+Write+Control (profile
//                      card MUST be world-readable for federation
//                      discovery + DID/WebID resolution)
//   /agents          — owner Read+Write+Control. Public READ is
//                      intentional: cross-pod agents resolve a recipient
//                      pod's authorized-agent registry to find encryption
//                      keys for envelope sharing. The contents themselves
//                      are non-sensitive metadata (agent IRIs + public
//                      keys + scopes).
//   /credentials/    — owner Read+Write+Control ONLY. No public read.
//                      Delegation credentials carry the relay's signed
//                      attestation that a surface agent acts on behalf
//                      of this user; they are NOT secrets but also do
//                      not belong in public discovery.
//   /context-graphs/ — owner Read+Write+Control; authorized agents
//                      (currently the relay's per-surface agent on this
//                      pod) Read+Write within their delegation scope;
//                      anonymous Read allowed so descriptors remain
//                      world-discoverable. Field-level confidentiality
//                      is handled by JOSE envelope encryption at the
//                      content layer, NOT by WAC at the storage layer.
//
// This is belt-and-suspenders: even if CSS is taken off allow-all (or
// the css-gate is bypassed), WAC alone still rejects anonymous writes
// from anywhere on the public internet. Once CSS is moved off allow-all
// the .acl files become the storage-side authority and the gate's
// per-user check becomes a redundant verifier layer — which is the
// desired defense-in-depth posture.
//
// Idempotency: each .acl write is a full PUT (replace-semantics). The
// content is a deterministic function of (podUrl, ownerWebId,
// surfaceAgentIri) so re-runs against the same inputs produce the same
// document. Re-runs that change the surface agent simply overwrite the
// previous policy — historical surface agents stay in the agent
// registry (revoked / superseded), but new writes are authorized only
// against the currently-named surface agent.
//
// Failure mode: best-effort. WAC writes log + continue on failure;
// the gate remains the authoritative authz boundary until CSS is moved
// off allow-all. We don't want a transient CSS .acl PUT failure to
// block the rest of the pod init (agent registry, profile card,
// bootstrap descriptor).
async function ensurePodAcls(params: {
  podUrl: string;
  userId: string;
  ownerWebId: IRI;
  surfaceAgentIri: IRI;
}): Promise<void> {
  const { podUrl, userId, ownerWebId, surfaceAgentIri } = params;
  void userId; // referenced only by callers' logging; podUrl already encodes it.

  // Containers needing distinct policy + the WAC turtle for each.
  // Keys are container URLs; CSS exposes their .acl at `${container}.acl`.
  const aclSpecs: Array<{ targetUrl: string; aclBody: string }> = [
    {
      // Pod root — public READ (so anyone can dereference profile/card
      // + the manifest + published descriptors); owner full control.
      targetUrl: podUrl,
      aclBody: buildRootAcl(podUrl, ownerWebId),
    },
    {
      // Profile container — explicit public READ. (Inherits from root,
      // but pinning the policy locally keeps it stable if root's policy
      // ever tightens.)
      targetUrl: `${podUrl}profile/`,
      aclBody: buildPublicReadOwnerWriteAcl(`${podUrl}profile/`, ownerWebId),
    },
    {
      // Authorized-agents registry — public READ for cross-pod agent
      // resolution; owner-only WRITE.
      targetUrl: `${podUrl}agents`,
      aclBody: buildPublicReadOwnerWriteAcl(`${podUrl}agents`, ownerWebId),
    },
    {
      // Delegation credentials — owner-only READ + WRITE.
      targetUrl: `${podUrl}credentials/`,
      aclBody: buildOwnerOnlyAcl(`${podUrl}credentials/`, ownerWebId),
    },
    {
      // Context-graphs manifest + descriptor container. Anonymous READ
      // allowed (federation discovery); owner + delegated surface agent
      // WRITE. The surface agent's WebID is the relay-minted
      // `surfaceAgentIri` registered in `<pod>/agents`.
      targetUrl: `${podUrl}context-graphs/`,
      aclBody: buildContextGraphsAcl(
        `${podUrl}context-graphs/`,
        ownerWebId,
        surfaceAgentIri,
      ),
    },
  ];

  for (const { targetUrl, aclBody } of aclSpecs) {
    // CSS / WAC convention: the ACL for a container `<c>/` lives at
    // `<c>/.acl`; the ACL for a leaf resource `<r>` lives at `<r>.acl`.
    // Both reduce to `${targetUrl}.acl` because we keep container URLs
    // trailing-slashed and leaf URLs un-slashed.
    const aclUrl = `${targetUrl}.acl`;
    try {
      const resp = await fetch(aclUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/turtle' },
        body: aclBody,
      });
      if (!resp.ok && resp.status !== 205) {
        log(`[pod-acl] warn: PUT ${aclUrl} returned ${resp.status} ${resp.statusText}; gate remains the authoritative authz boundary`);
      }
    } catch (err) {
      log(`[pod-acl] warn: PUT ${aclUrl} threw ${(err as Error).message}; gate remains the authoritative authz boundary`);
    }
  }
}

// Per-resource WAC writer used by `publish_context` with
// `visibility: "public"`. Pins `acl:Read` for `acl:agentClass foaf:Agent`
// (any authenticated user) on the leaf resource even if the parent
// `/context-graphs/` ACL is later tightened. Owner retains full control.
// Best-effort: any non-2xx is logged by the caller; the parent ACL on
// `/context-graphs/` still grants the same anonymous read by inheritance.
async function writePublicReadAcl(targetUrl: string, ownerWebId: IRI): Promise<void> {
  const aclUrl = `${targetUrl}.acl`;
  const aclBody = [
    `@prefix acl: <http://www.w3.org/ns/auth/acl#> .`,
    `@prefix foaf: <http://xmlns.com/foaf/0.1/> .`,
    ``,
    `<#owner>`,
    `    a acl:Authorization ;`,
    `    acl:agent <${ownerWebId}> ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:mode acl:Read, acl:Write, acl:Control .`,
    ``,
    `<#public>`,
    `    a acl:Authorization ;`,
    `    acl:agentClass foaf:Agent ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:mode acl:Read .`,
    ``,
  ].join('\n');
  const resp = await solidFetch(aclUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body: aclBody,
  });
  if (!resp.ok && resp.status !== 205) {
    throw new Error(`PUT ${aclUrl} → ${resp.status} ${resp.statusText}`);
  }
}

// Pod-root WAC: public Read; owner full control. Default policy applies
// to children via `acl:default <root>` so the whole pod inherits unless
// a child container overrides.
function buildRootAcl(podUrl: string, ownerWebId: IRI): string {
  return [
    `@prefix acl: <http://www.w3.org/ns/auth/acl#> .`,
    `@prefix foaf: <http://xmlns.com/foaf/0.1/> .`,
    ``,
    `<#owner>`,
    `    a acl:Authorization ;`,
    `    acl:agent <${ownerWebId}> ;`,
    `    acl:accessTo <${podUrl}> ;`,
    `    acl:default <${podUrl}> ;`,
    `    acl:mode acl:Read, acl:Write, acl:Control .`,
    ``,
    `<#public>`,
    `    a acl:Authorization ;`,
    `    acl:agentClass foaf:Agent ;`,
    `    acl:accessTo <${podUrl}> ;`,
    `    acl:default <${podUrl}> ;`,
    `    acl:mode acl:Read .`,
    ``,
  ].join('\n');
}

// Generic policy: public Read, owner Read+Write+Control. Used for
// /profile/ + /agents.
function buildPublicReadOwnerWriteAcl(targetUrl: string, ownerWebId: IRI): string {
  return [
    `@prefix acl: <http://www.w3.org/ns/auth/acl#> .`,
    `@prefix foaf: <http://xmlns.com/foaf/0.1/> .`,
    ``,
    `<#owner>`,
    `    a acl:Authorization ;`,
    `    acl:agent <${ownerWebId}> ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:default <${targetUrl}> ;`,
    `    acl:mode acl:Read, acl:Write, acl:Control .`,
    ``,
    `<#public>`,
    `    a acl:Authorization ;`,
    `    acl:agentClass foaf:Agent ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:default <${targetUrl}> ;`,
    `    acl:mode acl:Read .`,
    ``,
  ].join('\n');
}

// Owner-only policy. Used for /credentials/.
function buildOwnerOnlyAcl(targetUrl: string, ownerWebId: IRI): string {
  return [
    `@prefix acl: <http://www.w3.org/ns/auth/acl#> .`,
    ``,
    `<#owner>`,
    `    a acl:Authorization ;`,
    `    acl:agent <${ownerWebId}> ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:default <${targetUrl}> ;`,
    `    acl:mode acl:Read, acl:Write, acl:Control .`,
    ``,
  ].join('\n');
}

// Context-graphs policy: owner full control + delegated surface agent
// Read+Write within the container + public Read. The surface agent
// authorization is what lets the relay's per-user/per-surface agent
// publish descriptors on the user's behalf when the user is signed in
// through that surface (claude.ai, ChatGPT, etc.). Additional authorized
// agents added via `register_agent` extend the registry but do NOT
// implicitly grant write here — they must be added to this .acl too
// when CSS is moved off allow-all. (Until then, the css-gate per-user
// bearer check is the live enforcement; this .acl is forward-looking.)
function buildContextGraphsAcl(
  targetUrl: string,
  ownerWebId: IRI,
  surfaceAgentIri: IRI,
): string {
  return [
    `@prefix acl: <http://www.w3.org/ns/auth/acl#> .`,
    `@prefix foaf: <http://xmlns.com/foaf/0.1/> .`,
    ``,
    `<#owner>`,
    `    a acl:Authorization ;`,
    `    acl:agent <${ownerWebId}> ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:default <${targetUrl}> ;`,
    `    acl:mode acl:Read, acl:Write, acl:Control .`,
    ``,
    `<#surface-agent>`,
    `    a acl:Authorization ;`,
    `    acl:agent <${surfaceAgentIri}> ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:default <${targetUrl}> ;`,
    `    acl:mode acl:Read, acl:Write .`,
    ``,
    `<#public>`,
    `    a acl:Authorization ;`,
    `    acl:agentClass foaf:Agent ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:default <${targetUrl}> ;`,
    `    acl:mode acl:Read .`,
    ``,
  ].join('\n');
}

// Renamed from `bootstrapPodForOAuth` — the helper is now ingress-agnostic
// and called from BOTH /oauth/verify AND the lazy CallTool middleware
// (ensurePodInitialized). Behavior is unchanged; only the name changed
// to drop the misleading "ForOAuth" suffix.
async function bootstrapPod(params: {
  podUrl: string;
  ownerWebId: IRI;
  surfaceAgentIri: IRI;
  userName: string;
  agentLabel: string;
  userId: string;
  identityWebId: string;
  identityDid?: string | undefined;
}): Promise<void> {
  const {
    podUrl,
    ownerWebId,
    surfaceAgentIri,
    userName,
    agentLabel,
    userId,
    identityWebId,
    identityDid,
  } = params;

  for (let attempt = 1; attempt <= POD_BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
    let profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
    const firstTouch = profile === null;
    if (!profile) profile = createOwnerProfile(ownerWebId, userName);
    const existing = profile.authorizedAgents.find(
      a => a.agentId === surfaceAgentIri && !a.revoked,
    );

    if (existing && existing.encryptionPublicKey === relayAgentKey.publicKey) {
      // Re-connect from known surface with current key — nothing to do.
      return;
    }

    const nextProfile = existing
      ? {
          ...profile,
          authorizedAgents: Object.freeze(
            profile.authorizedAgents.map(a =>
              a.agentId === surfaceAgentIri && !a.revoked
                ? { ...a, encryptionPublicKey: relayAgentKey.publicKey }
                : a,
            ),
          ),
        }
      : addAuthorizedAgent(profile, {
          agentId: surfaceAgentIri,
          delegatedBy: ownerWebId,
          label: agentLabel,
          isSoftwareAgent: true,
          scope: 'ReadWrite',
          validFrom: new Date().toISOString(),
          encryptionPublicKey: relayAgentKey.publicKey,
        });

    if (firstTouch) {
      await putRelayProfileCard({
        podUrl,
        userId,
        userName,
        ownerWebId,
        identityWebId,
        identityDid,
      });
      // FIX 1 (anon-write): write WAC .acl resources at pod root +
      // key containers BEFORE the first registry write lands, so the
      // initial /agents PUT itself is policy-bound (when CSS is
      // off allow-all). Order is: profile/card → .acl → agents PUT.
      // Best-effort: log + continue on failure; the css-gate's
      // per-user bearer check remains the live enforcement until
      // CSS is moved off allow-all.
      await ensurePodAcls({
        podUrl,
        userId,
        ownerWebId,
        surfaceAgentIri,
      });
    }
    // FIX C: write the iep:PodBootstrap descriptor in the same
    // single-writer block as /agents + /profile/card. Idempotent
    // (fixed IRI urn:iep:pod-bootstrap:<userId>:v1) so re-bootstraps
    // don't duplicate the manifest entry. Best-effort — see
    // publishPodBootstrapDescriptor's failure-mode comment. We only
    // publish on first-touch because the bootstrap describes the pod's
    // static topology (owner / storage / WebID / registry / card); the
    // dynamic surface-agent list lives on /agents and is read from
    // there. Subsequent surface adds don't need to re-publish the
    // bootstrap descriptor.
    // The bootstrap descriptor targets a distinct CSS path from
    // /agents — run the two PUTs concurrently.
    await Promise.all([
      writeAgentRegistry(nextProfile, podUrl, { fetch: solidFetch }),
      firstTouch
        ? publishPodBootstrapDescriptor({
            podUrl,
            ownerWebId,
            userId,
            surfaceAgentIri,
          })
        : Promise.resolve(),
    ]);
    relayProfileCache.delete(podUrl);

    // Post-write verify: re-read and confirm our surface agent landed.
    // If a concurrent writer (different replica, or anything outside
    // this process's mutex) clobbered our write, the surface agent
    // won't be there — back off briefly and retry the merge.
    const verifyProfile = await readAgentRegistry(podUrl, { fetch: solidFetch });
    const landed = verifyProfile?.authorizedAgents.some(
      a => a.agentId === surfaceAgentIri && !a.revoked,
    );
    if (landed) return;
    if (attempt === POD_BOOTSTRAP_MAX_ATTEMPTS) {
      throw new Error(
        `Post-write verify failed: ${surfaceAgentIri} missing from ${podUrl}agents after ${attempt} attempts (concurrent writer)`,
      );
    }
    // Short backoff before re-merge — gives the concurrent writer
    // time to finish so we read a stable state next iteration.
    await new Promise(r => setTimeout(r, 100 * attempt));
  }
}

// ── Lazy pod-init for already-authenticated tool calls (FIX A) ────
//
// Background: /oauth/verify is the canonical first-write entry point
// for `<pod>/agents` + `<pod>/profile/card`. But bearer tokens that
// were issued BEFORE the eager OAuth-side bootstrap shipped are still
// in the wild — those callers have a valid token but a pod that was
// never initialized (no /agents, no /profile/card), so any tool that
// reads the registry returns "no agent" and any tool that writes
// fails its first-line auth check. The fix is self-healing on first
// MCP call: when a CallToolRequest comes in with auth context that
// resolves a podUrl, we lazily run the SAME bootstrap helper used by
// /oauth/verify, behind the SAME per-pod mutex, gated by a cheap
// HEAD-based idempotency check so the cost is one round-trip per
// (pod, relay-process) pair across the relay's lifetime.
//
// Idempotency: two layers.
//   (1) `bootstrappedPods` Set — populated on confirmed success (HEAD
//       200 or successful bootstrap). O(1) hit cost, no network. The
//       fast path that absorbs every call after the first.
//   (2) On Set miss: HEAD <podUrl>agents. 200 → another replica /
//       process already initialized — record + skip. 404 → take the
//       mutex, re-check the Set inside the mutex (double-checked
//       locking against concurrent in-process callers), then bootstrap.
// No TTL — pod-init is monotonic. The Set is intentionally NOT
// populated on bootstrap FAILURE so a transient 5xx does not poison
// subsequent calls.
//
// Failure mode: lazy init is best-effort. If bootstrap throws we log
// at warn level and let the tool call proceed; reads degrade
// gracefully (discover_context returns []), writes surface their own
// underlying error. The single exception is the strict-DPoP environment
// (RELAY_REQUIRE_DPOP=true) combined with an AUTH_REQUIRED_TOOLS call —
// there we honor the strict guarantee and rethrow so the tool handler
// surfaces a clear error rather than silently writing to a half-init pod.
const { bootstrappedPods, ensurePodInitialized } = createLazyPodInit({
  solidFetch,
  withPodMutex,
  bootstrapPod,
});

// ── Pod-side /profile/card writer (FIX A) ─────────────────────────
//
// Conventional Solid clients (Penny, @inrupt/solid-client, NSS-derived
// profile dereferencers) dereference `<pod>/profile/card#me` expecting
// `solid:oidcIssuer` + `solid:storage` so they can sign in against the
// pod alone, without out-of-band knowledge of the identity server. The
// relay mirrors this card on the first OAuth completion for a given
// pod. Subsequent surface-agent additions don't require rewriting the
// card — it points to `<pod>/agents` (via rdfs:seeAlso) as the
// authoritative authorized-agent list.
//
// We deliberately keep the inline `iep:authorizedAgent` payload narrow
// (the current surface agent only). The full multi-surface list lives
// on `<pod>/agents` and is read from there by every cross-pod
// resolution flow.
async function putRelayProfileCard(params: {
  podUrl: string;
  userId: string;
  userName: string;
  ownerWebId: IRI;
  identityWebId: string;
  identityDid?: string | undefined;
}): Promise<void> {
  const { podUrl, userId, userName, ownerWebId, identityWebId, identityDid } = params;
  const cardUrl = `${podUrl}profile/card`;
  const agentsRegistryUrl = `${podUrl}agents`;

  // Ensure the pod's root container and /profile/ subcontainer exist —
  // CSS file backend needs explicit LDP BasicContainer PUTs before a
  // leaf PUT into a missing parent. Best-effort; later steps surface a
  // real error if the leaf PUT still fails.
  for (const containerUrl of [podUrl, `${podUrl}profile/`]) {
    try {
      await fetch(containerUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/turtle',
          'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
        },
        body: '',
      });
    } catch { /* best-effort */ }
  }

  const seeAlsoTargets: string[] = [agentsRegistryUrl, identityWebId];
  if (identityDid) seeAlsoTargets.push(identityDid);

  const turtle = [
    `@prefix foaf: <http://xmlns.com/foaf/0.1/> .`,
    `@prefix solid: <http://www.w3.org/ns/solid/terms#> .`,
    `@prefix pim: <http://www.w3.org/ns/pim/space#> .`,
    `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .`,
    `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
    ``,
    `<${cardUrl}#me>`,
    `    a foaf:Person ;`,
    `    foaf:name "${escapeTurtleString(userName)}" ;`,
    `    solid:oidcIssuer <${IDENTITY_URL}> ;`,
    `    solid:storage <${podUrl}> ;`,
    `    pim:storage <${podUrl}> ;`,
    `    iep:agentRegistry <${agentsRegistryUrl}> ;`,
    `    rdfs:seeAlso ${seeAlsoTargets.map(t => `<${t}>`).join(', ')} .`,
    ``,
    // Owner WebID returned by identity (`<identityWebId>`) is the
    // canonical one; cross-reference it back to the pod card so a client
    // resolving either direction stays linked. owl:sameAs is intentional —
    // both IRIs denote the same Person.
    `@prefix owl: <http://www.w3.org/2002/07/owl#> .`,
    `<${ownerWebId}> owl:sameAs <${cardUrl}#me> .`,
    ``,
  ].join('\n');
  void userId; // referenced only for the log/diagnostics surface upstream

  const r = await fetch(cardUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body: turtle,
  });
  if (!r.ok && r.status !== 205) {
    throw new Error(`PUT ${cardUrl} failed: ${r.status} ${r.statusText}`);
  }
}

// Minimal Turtle string escape — escape backslashes, double quotes,
// and the control characters that Turtle long-string literals reject.
function escapeTurtleString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// ── Pod-bootstrap descriptor writer (FIX C) ───────────────────────
//
// On first-touch pod init the relay also publishes a single
// `iep:PodBootstrap` Context Descriptor into the pod's
// `.well-known/context-graphs` manifest. The descriptor self-describes
// the pod (iep:owner / iep:storage / iep:webId / iep:agentRegistry /
// iep:profileCard) and carries one iep:Affordance (iep:canPublish) whose
// hydra:target points back at the relay's publish_context tool so a
// client discovering the pristine pod has a strictly better UX signal
// than an empty manifest: "pod is alive, owned by X, here is how to
// add more context."
//
// Idempotency
// -----------
// Descriptor IRI is pinned to `urn:iep:pod-bootstrap:<userId>:v1` — the
// same IRI every time. `publish()` on the substrate is idempotent at
// the manifest level (it observes the entry already exists and skips
// the PUT), so subsequent bootstrap calls are no-ops at the manifest
// layer. The descriptor + graph PUTs overwrite themselves with
// identical content (or only updated timestamps), so re-bootstrap
// never accumulates duplicate manifest entries.
//
// Failure mode
// ------------
// This call is best-effort. If the bootstrap publish fails (CSS
// unreachable, descriptor validation rejects, manifest CAS exhausts
// retries), we log and continue — the agent registry + profile card
// PUTs already landed, and an empty manifest is still functionally
// correct, just a slightly worse first-touch UX. Callers should not
// surface this failure as a bootstrap blocker.
async function publishPodBootstrapDescriptor(params: {
  podUrl: string;
  ownerWebId: IRI;
  userId: string;
  surfaceAgentIri: IRI;
}): Promise<void> {
  const { podUrl, ownerWebId, userId, surfaceAgentIri } = params;
  const descId = `urn:iep:pod-bootstrap:${userId}:v1` as IRI;
  const agentsRegistryUrl = `${podUrl}agents`;
  const cardUrl = `${podUrl}profile/card`;
  const ownerWebIdHash = `${cardUrl}#me`;
  // hydra:target for the iep:canPublish affordance. PUBLIC_BASE_URL is
  // the relay's public origin (set in container env). When unset the
  // affordance still gets a sensible local-dev target so dev-mode
  // discovers behave consistently with prod.
  const relayBase = (PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const publishTarget = `${relayBase}/tool/publish_context`;
  const now = new Date().toISOString();

  const builder = ContextDescriptor.create(descId)
    .describes(podUrl as IRI)
    .temporal({ validFrom: now })
    .validFrom(now)
    .delegatedBy(ownerWebId, surfaceAgentIri, {
      endedAt: now,
    })
    .semiotic({
      modalStatus: 'Asserted',
      epistemicConfidence: 1.0,
    })
    .trust({
      trustLevel: 'SelfAsserted',
      issuer: ownerWebId,
    })
    .federation({
      origin: podUrl as IRI,
      storageEndpoint: podUrl as IRI,
      syncProtocol: 'SolidNotifications',
    })
    .version(1);
  const descriptor = builder.build();

  const validation = validate(descriptor);
  if (!validation.conforms) {
    log(`WARN: pod-bootstrap descriptor failed validation: ${validation.violations.map(v => v.message).join('; ')}`);
    return;
  }

  // Named-graph body: the pod self-description + one iep:canPublish
  // affordance. Kept compact; conventional iep: / hydra: / dcat:
  // vocabularies only. Lines are emitted without prefix declarations —
  // `wrapAsTriG()` hoists the descriptor's prefix block above the
  // named-graph body so iep: / hydra: / dcat: / prov: are already in
  // scope inside the graph block.
  const graphContent = [
    `<${podUrl}>`,
    `    a iep:PodBootstrap ;`,
    `    iep:owner <${ownerWebId}> ;`,
    `    iep:storage <${podUrl}> ;`,
    `    iep:webId <${ownerWebIdHash}> ;`,
    `    iep:agentRegistry <${agentsRegistryUrl}> ;`,
    `    iep:profileCard <${cardUrl}> ;`,
    `    prov:wasGeneratedBy <${surfaceAgentIri}> ;`,
    `    iep:affordance [`,
    `        a iep:Affordance, hydra:Operation ;`,
    `        iep:action iep:canPublish ;`,
    `        hydra:method "POST" ;`,
    `        hydra:target <${publishTarget}> ;`,
    `        hydra:title "Publish a new context descriptor to this pod"`,
    `    ] .`,
  ].join('\n');

  try {
    await publish(descriptor, graphContent, podUrl, { fetch: solidFetch });
    log(`[pod-bootstrap] published ${descId} to ${podUrl}`);
  } catch (err) {
    // Best-effort — see the failure-mode comment above.
    log(`WARN: pod-bootstrap publish failed for ${podUrl}: ${(err as Error).message}`);
  }
}

// ── Browser-friendly landing page ─────────────────────────────────
//
// A non-technical user hitting the relay's root URL would otherwise
// see "Cannot GET /" — not actionable. This serves a minimal page
// pointing them at the right next step (configure their MCP client
// with the /mcp URL — Streamable HTTP, current spec — falling back
// to /sse only if their client doesn't support it; OAuth-led flow
// handles enrollment).

const RELAY_LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Interego MCP relay</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 760px; margin: 4em auto; padding: 0 1.5em; line-height: 1.55; color: #1c1f23; background: #fbfbfd; }
  h1 { font-weight: 700; letter-spacing: -0.02em; margin-bottom: 0.2em; }
  .sub { color: #5a6470; margin-top: 0; }
  h2 { margin-top: 2.4em; border-bottom: 1px solid #e3e7eb; padding-bottom: 0.3em; }
  code { background: #f0f2f5; padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }
  pre { background: #f0f2f5; padding: 0.9em 1em; border-radius: 6px; overflow-x: auto; font-size: 0.86em; line-height: 1.5; }
  .note { background: #eaf6ff; border-left: 4px solid #0a66c2; padding: 0.8em 1em; margin: 1em 0; border-radius: 4px; }
  .recommended { background: #ecf8ee; border-left: 4px solid #2e8b3d; padding: 0.8em 1em; margin: 1em 0; border-radius: 4px; }
  .legacy { background: #f6f1e7; border-left: 4px solid #b58a2c; padding: 0.8em 1em; margin: 1em 0; border-radius: 4px; font-size: 0.92em; }
  .badge { display: inline-block; background: #2e8b3d; color: #fff; font-size: 0.72em; font-weight: 600; padding: 2px 7px; border-radius: 10px; margin-left: 0.4em; vertical-align: middle; letter-spacing: 0.04em; }
  .badge.legacy { background: #b58a2c; }
  h3 { margin-top: 1.6em; margin-bottom: 0.4em; font-size: 1.05em; }
  a { color: #0a66c2; }
  ul { padding-left: 1.2em; }
  li { margin-bottom: 0.35em; }
  footer { margin-top: 4em; color: #8a929c; font-size: 0.87em; }
</style>
</head>
<body>
<h1>Interego MCP relay</h1>
<p class="sub">OAuth-gated MCP server. Connect your AI agent runtime here.</p>

<h2>Connect your agent runtime</h2>

<p>Add this URL to your MCP-speaking agent runtime (Claude Code, Claude Desktop, Cursor, Windsurf, Hermes, OpenClaw, claude.ai connectors, ChatGPT custom connectors, etc.).</p>

<div class="recommended">
<strong>Use this endpoint<span class="badge">RECOMMENDED</span></strong><br>
<code><span id="mcpUrl"></span>/mcp</code> — Streamable HTTP transport (current MCP spec). This is what every modern client should use.
</div>

<p>Example MCP config (file location depends on your client):</p>

<pre>{
  "mcpServers": {
    "interego": {
      "url": "<span id="mcpUrl2"></span>/mcp"
    }
  }
}</pre>

<div class="legacy">
<strong>Legacy / compat<span class="badge legacy">FALLBACK</span></strong><br>
<code><span id="sseUrl"></span>/sse</code> — older Server-Sent-Events transport. Only use this if your client doesn't support Streamable HTTP yet. The relay keeps it running for backwards compatibility.
</div>

<div class="note">
First call triggers an OAuth flow in your browser. You'll be asked to enroll a <strong>passkey</strong>, <strong>Ethereum wallet</strong>, or <strong>did:key</strong>. Your private keys never leave your device — no password, no email, no account database.
</div>

<h3>ChatGPT &amp; Claude.ai connector setup</h3>
<p>For the hosted chat apps (web + mobile), paste the <code>/mcp</code> URL into the connector picker:</p>
<ul>
  <li><strong>ChatGPT</strong> (web or mobile) — Settings &rarr; Connectors &rarr; Add custom connector &rarr; paste <code><span id="mcpUrl3"></span>/mcp</code>. Sign in via the OAuth popup.</li>
  <li><strong>Claude.ai</strong> (web or iOS/Android) — Settings &rarr; Connectors &rarr; Add custom connector &rarr; paste <code><span id="mcpUrl4"></span>/mcp</code>. Approve the passkey/wallet enrollment when prompted.</li>
</ul>
<p>Once connected, both apps will discover the 60+ Interego tools automatically. No CLI required.</p>

<h2>New to Interego, or just a person?</h2>
<p>You don't need an MCP client to start. Create an identity and pod directly — passkey or wallet, about 30 seconds — then point an agent at it later:</p>
<ul>
  <li><a href="${IDENTITY_URL}/">Overview &amp; sign-up</a> — what Interego is, and the human/agent paths</li>
  <li><a href="${IDENTITY_URL}/connect">Create my identity</a> — enroll a passkey or wallet now</li>
  <li><a href="https://github.com/markjspivey-xwisee/interego/blob/master/docs/FIRST-HOUR.md">First-hour walkthrough</a> · <a href="https://github.com/markjspivey-xwisee/interego/blob/master/docs/integrations/agent-runtime-integration.md">Runtime integration guide</a> (Hermes / OpenClaw / MCP)</li>
</ul>

<h2>What's exposed here</h2>
<ul>
  <li><strong>60+ MCP tools</strong> — typed-context publish/discover, federation, identity ops, PGSL lattice, ZK proofs, compliance-grade descriptors, ABAC, x402 payments, agent registry</li>
  <li><strong>Per-surface agents</strong> — your DCR client name (chatgpt, cursor, claude-code-vscode, etc.) maps to a per-surface agent automatically</li>
  <li><strong>Cross-pod E2EE share</strong> — <code>publish_context(..., share_with: [did:web:bob])</code> wraps the envelope key for any recipient DID</li>
</ul>

<h2>For auditors / developers</h2>
<ul>
  <li><a href="/health">/health</a> — relay status</li>
  <li><a href="/tools">/tools</a> — list of every MCP tool this surface exposes</li>
  <li><a href="/audit/frameworks">/audit/frameworks</a> — compliance frameworks supported (EU AI Act / NIST RMF / SOC 2)</li>
  <li><a href="/audit/events">/audit/events</a> — public read of compliance-graded events</li>
  <li><a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a> — OAuth discovery</li>
  <li><a href="/.well-known/security.txt">/.well-known/security.txt</a> — coordinated disclosure contact</li>
</ul>

<script>
  const u = new URL(window.location.href);
  const base = u.origin;
  for (const el of document.querySelectorAll('#sseUrl, #mcpUrl, #mcpUrl2, #mcpUrl3, #mcpUrl4')) el.textContent = base;
</script>

<footer>
Open-source substrate · <a href="https://github.com/markjspivey-xwisee/interego">github</a> · this deployment is the maintainer's reference instance
</footer>
</body>
</html>`;

app.get('/', (req, res) => {
  // Content negotiation: browsers and curl-without-Accept get the
  // HTML landing page (unchanged behaviour). Hydra-aware / JSON-LD
  // clients get the hydra:EntryPoint document. This is the canonical
  // "where do I go from here?" surface every Hydra client expects;
  // adding it without removing the HTML keeps backward compat.
  const accept = (req.headers['accept'] ?? '').toString();
  const wantsJsonLd = accept.includes('application/ld+json') || accept.includes('application/json');
  if (!wantsJsonLd) {
    res.type('text/html').send(RELAY_LANDING_HTML);
    return;
  }
  const base = `${req.protocol}://${req.get('host') ?? ''}`;
  const entry = hydraEntryPoint({
    base,
    title: 'Interego MCP relay',
    description: 'Hypermedia entry point — every operation below is a hydra:Operation and can be followed by URL.',
    shapesGraph: `${base}/.well-known/shacl-shapes`,
    operations: [
      { name: 'list-tools',       target: '/tools',                          method: 'GET',  description: 'Hydra collection of every MCP tool exposed by this relay (kernel verbs + named shims).' },
      { name: 'invoke-tool',      target: '/tool/{name}',                    method: 'POST', description: 'Invoke a tool by name; body is the tool inputSchema payload.' },
      { name: 'mcp-rpc',          target: '/mcp',                            method: 'POST', description: 'MCP JSON-RPC endpoint (Bearer + DPoP).' },
      { name: 'mcp-stream',       target: '/sse',                            method: 'GET',  description: 'Server-sent-events stream for MCP notifications.' },
      { name: 'audit-frameworks', target: '/audit/frameworks',               method: 'GET',  description: 'List known compliance frameworks + their controls.' },
      { name: 'audit-events',     target: '/audit/events?pod=<url>',         method: 'GET',  description: 'List recent descriptors on a pod (audit log).' },
      { name: 'audit-lineage',    target: '/audit/lineage?descriptor=<url>', method: 'GET',  description: 'Walk prov:wasDerivedFrom + iep:supersedes for one descriptor.' },
      { name: 'audit-compliance', target: '/audit/compliance/{framework}',   method: 'GET',  description: 'Generate a regulatory framework report.' },
      { name: 'inbox',            target: '/inbox?pod=<url>',                method: 'GET',  description: 'What\'s new on a pod (consumer-friendly framing of /audit/events).' },
      { name: 'oauth-as-meta',    target: '/.well-known/oauth-authorization-server', method: 'GET', description: 'OAuth 2.0 Authorization Server Metadata (RFC 8414) + Hydra.' },
      { name: 'oauth-pr-meta',    target: '/.well-known/oauth-protected-resource',    method: 'GET', description: 'OAuth Protected Resource Metadata (RFC 9728) + Hydra.' },
      { name: 'operations',       target: '/.well-known/operations',         method: 'GET',  description: 'Typed substrate-operation catalog — 8 kernel verbs + every thin-facade shim as iep:Affordance entries (FIX 4).' },
      { name: 'shacl-shapes',     target: '/.well-known/shacl-shapes',       method: 'GET',  description: 'SHACL shapes graph this relay\'s responses conform to.' },
      { name: 'health',           target: '/health',                         method: 'GET',  description: 'Relay liveness probe.' },
      { name: 'federation-status', target: '/relay/federation-status',       method: 'GET',  description: 'Federation registry durability snapshot (entry count + last-hydrate / last-persist timestamps + hydrate source pod). No auth required.' },
    ],
  });
  res.type('application/ld+json').json(entry);
});

// SHACL shapes graph — Turtle export of every shape the relay's
// responses reference via iep:conformsToShape. Lets validators verify
// any kernel-verb / shim payload without out-of-band schema lookup.
app.get('/.well-known/shacl-shapes', (_req, res) => {
  res.type('text/turtle').send(getShaclShapesTurtle());
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', css: CSS_URL, tools: Object.keys(TOOLS).length, auth: 'bearer-token', x402: true });
});

// ── /publish/status — deferred-publish status lookup ─────────
//
// publish_context returns synchronously with `status: 'pending'` once
// the gates pass and the substrate-CSS chain (graph PUT + descriptor PUT
// + manifest CAS) has been handed off to the background. Callers that
// need a definitive read of whether the publish committed (without
// HEAD-spinning the descriptor URL) GET this endpoint with the predicted
// descriptor URL as the `descriptorUrl` query param. Returns one of:
//   - { kind: 'pending', ... }   — still running
//   - { kind: 'committed', ... } — landed on the pod
//   - { kind: 'failed', error }  — gave up after the retry budget
//   - { kind: 'unknown' }        — never seen / evicted (after
//                                   DEFERRED_PUBLISH_MAX_AGE_MS)
// Read-only, no auth — the descriptor URL is a content-addressable
// public key for the publish + we only return whether the publish
// completed (no content leakage).
app.get('/publish/status', (req, res) => {
  const descriptorUrl = req.query['descriptorUrl'];
  if (typeof descriptorUrl !== 'string' || descriptorUrl.length === 0) {
    res.status(400).json({ error: 'missing_param', param: 'descriptorUrl' });
    return;
  }
  const status = getDeferredPublishStatus(descriptorUrl);
  if (status === undefined) {
    res.json({ kind: 'unknown', descriptorUrl });
    return;
  }
  res.json({ ...status, descriptorUrl });
});

// ── /relay/federation-status — operator probe (FIX 5) ──────────
//
// Public, no-auth read-only snapshot of the federation registry's
// durability state. Mirrors the observability fields that
// `list_known_pods` exposes but does NOT require MCP / OAuth — ops
// tooling (synthetic monitors, container-app readiness checks, manual
// curl from a runbook) can verify post-deploy that the relay has
// successfully hydrated entries from the service-account pod without
// minting a bearer.
//
// Authorization: returns federation METADATA only (entry COUNT, source
// pod URL, last-write/last-load timestamps). The list of pod URLs is
// MCP-only (via `list_known_pods`) — operators who need that already
// have a bearer. So this endpoint leaks nothing a federation peer
// couldn't already infer by hitting `/.well-known/operations`.
app.get('/relay/federation-status', async (_req, res) => {
  // Best-effort: wait briefly for hydrate to complete so a cold-start
  // probe sees the populated state instead of zeros. Same budget as
  // handleListKnownPods.
  await awaitFederationHydrateWithBudget(50);
  res.json({
    entries: knownPods.size,
    lastPersistedAt: federationLastPersistedAt,
    lastHydratedAt: federationLastHydratedAt,
    hydrateSourceCount: federationHydrateSourceCount,
    hydrateSource: oauthStorePodUrl,
    podUrl: oauthStorePodUrl,
  });
});

// ── /.well-known/security.txt — RFC 9116 ─────────────────────
//
// Coordinated disclosure contact for security researchers. Body
// generated by the shared @interego/core builder so all 5 surfaces
// emit identical content (single source of truth for policy URL +
// Expires + Acknowledgments). See spec/policies/14-vulnerability-management.md §5.3.
const SECURITY_TXT_BODY = buildSecurityTxtFromEnv(PUBLIC_BASE_URL || undefined);
app.get(['/.well-known/security.txt', '/security.txt'], (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(SECURITY_TXT_BODY);
});

// ── /ns/:owner/:slug — the RDF-projection dereference surface ─────────────
//
// Base Interego is a SUPERSET of RDF: holons are payload-agnostic identities
// that project to any representation. This route affords "what people expect
// from RDF" WHERE a holon is used as RDF — a clean, stable IRI that HTTP-
// dereferences to content-negotiated linked data (Turtle / JSON-LD / HTML),
// with #fragment terms resolving in-document and rdfs:isDefinedBy / owl:imports
// following-your-nose. It is GENERIC: it dereferences ANY published PUBLIC graph
// at this IRI — an ontology, a knowledge graph, a SHACL shape, a course — with
// NO ontology special-casing. Publishing is the ordinary core publish (the
// holon's RDF projection, written to the author's own pod); this is only the
// dereference half. Read-only, public (CORS * incl null via corsMiddleware's
// /ns carve-out), no auth. Serves the signed projection bytes, never rewrites
// them. Verticals (agentic memory, Foxxi, Weft) are polygranular CONSUMERS of
// this surface — the same holon in many hyperedges.
const RELAY_NS_ROOT = `${(PUBLIC_BASE_URL || 'https://relay.interego.xwisee.com').replace(/\/+$/, '')}/ns`;
const NS_OWL_ONTOLOGY = 'http://www.w3.org/2002/07/owl#Ontology';

/** Clean standalone Turtle from a stored `-graph.trig` (publish() wraps the
 *  named graph as `<graphIri> { …indented… }` under hoisted prefixes). Pure
 *  string transform so blank nodes / SHACL lists survive byte-for-byte. */
function nsExtractGraphTurtle(trig: string, graphIri: string): string | null {
  const open = trig.indexOf(`<${graphIri}> {`);
  if (open < 0) return null;
  const bodyStart = trig.indexOf('{', open) + 1;
  const n = trig.length;
  // Quote/comment-AWARE brace matcher: only count braces OUTSIDE Turtle string
  // literals ("…"/'…'/"""…"""/'''…''') and # comments, so a lone/unbalanced `{`
  // or `}` inside an rdfs:comment (arbitrary agent content) cannot desync the
  // depth counter and truncate the served graph.
  let depth = 1, i = bodyStart;
  while (i < n && depth > 0) {
    const c = trig[i];
    if (c === '#') { while (i < n && trig[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'") {
      const q = c; const triple = trig[i + 1] === q && trig[i + 2] === q;
      i += triple ? 3 : 1;
      while (i < n) {
        if (trig[i] === '\\') { i += 2; continue; }
        if (triple) { if (trig[i] === q && trig[i + 1] === q && trig[i + 2] === q) { i += 3; break; } i++; }
        else { if (trig[i] === q) { i++; break; } if (trig[i] === '\n') { break; } i++; }
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  const inner = trig.slice(bodyStart, i - 1);
  const prefixLines = trig.split('\n').filter(l => /^\s*(@prefix|@base)\s/i.test(l));
  const deindented = inner.split('\n').map(l => l.replace(/^ {4}/, '')).join('\n').trim();
  return `${prefixLines.join('\n')}\n\n${deindented}\n`;
}

/** Flattened JSON-LD projection of the clean Turtle (best-effort; caller falls
 *  back to Turtle if this throws). */
function nsTurtleToJsonLd(turtle: string): Record<string, unknown> {
  const doc = parseTrig(turtle);
  const ctx: Record<string, string> = {};
  for (const [p, iri] of doc.prefixes) ctx[p] = iri as string;
  const graph = doc.subjects.map(s => {
    const id = typeof s.subject === 'string' ? s.subject : `_:${s.subject.bnode}`;
    const node: Record<string, unknown> = { '@id': id };
    for (const [pred, terms] of s.properties) {
      node[pred as string] = terms.map(t =>
        t.kind === 'iri' ? { '@id': t.iri }
          : t.kind === 'bnode' ? { '@id': `_:${t.id}` }
            : { '@value': t.value, ...(t.datatype ? { '@type': t.datatype } : {}), ...(t.language ? { '@language': t.language } : {}) });
    }
    return node;
  });
  return { '@context': ctx, '@graph': graph };
}

function nsHtml(iri: string, turtle: string, meta: { owner: string; slug: string; descriptorUrl: string; isOntology: boolean }): string {
  const esc = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><meta charset="utf-8"><title>${esc(meta.slug)}</title>`
    + `<body style="font-family:system-ui;max-width:60rem;margin:2rem auto;line-height:1.5;padding:0 1rem">`
    + `<h1>${esc(meta.slug)}</h1>`
    + `<p><b>IRI:</b> <code>${esc(iri)}</code>${meta.isOntology ? ' · <b>owl:Ontology</b>' : ''}</p>`
    + `<p>A published Interego holon, dereferenced here as linked data — the RDF projection of a signed, discoverable substrate object (<a href="${esc(publishableDescriptorUrl(meta.descriptorUrl, iri))}">descriptor</a>) on <code>${esc(meta.owner)}</code>'s pod. Terms are hash fragments (<code>${esc(iri)}#&lt;term&gt;</code>) resolving in-document.</p>`
    + `<p><b>Projections:</b> <a href="?format=turtle">Turtle</a> · <a href="?format=jsonld">JSON-LD</a></p>`
    + `<h2>Source (Turtle)</h2><pre style="background:#f6f8fa;padding:1rem;overflow:auto;border-radius:6px">${esc(turtle)}</pre>`
    + `</body>`;
}

/** Render a published graph as hypermedia Markdown — a THIRD projection beside
 *  Turtle and JSON-LD, for the channels RDF cannot cross (a README, a pasted
 *  message, an MCP resource, an LLM's context window).
 *
 *  This is a VIEW. The signed descriptor is the AUTHORITY. The document names
 *  WHAT may be done (each :::control block's `rel`) and WHERE THE AUTHORITY
 *  LIVES (`descriptorUrl`) — never WHERE TO POST: `controlsFromAffordances()`
 *  drops `hydra:target` on the floor and the renderer computes every emitted
 *  target inside the document's own resource (authority closure), so untrusted
 *  prose can never steer an auto-approved `invoke_affordance` at an
 *  attacker-chosen URL (MCP approves per-TOOL, not per-TARGET). The live target
 *  is re-resolved from the signed Turtle by followAffordance() at execution time.
 *
 *  Reuses the SAME resolveNsGraph() core as the Turtle/JSON-LD branches, so the
 *  SSRF host-pinning (nsToOwnerPodInternal) and the CORS carve-out come free. */
/**
 * The descriptor URL a document may PUBLISH.
 *
 * `resolveNsGraph` hands back whatever indexed the graph, and on the convention
 * path that is the internal CSS URL (`http://css.railway.internal:3456/...`).
 * That is correct as an internal fetch target but useless as a published one:
 * nobody outside the private network can dereference it. It matters most in the
 * Markdown projection, whose whole safety story is "the target is not here — go
 * re-resolve it from descriptorUrl": an authority you cannot reach is not an
 * authority. So when the resolved descriptor is not publicly dereferenceable,
 * publish the graph's own IRI instead. That IRI dereferences (here, through this
 * route) to the same Turtle, carrying the same affordances with their targets —
 * so re-resolution still works, over a URL the reader can actually fetch.
 */
function publishableDescriptorUrl(descriptorUrl: string, graphIri: string): string {
  try {
    assertPublicPodUrl(descriptorUrl);
    return descriptorUrl;
  } catch {
    return graphIri;
  }
}

function nsMarkdown(iri: string, turtle: string, meta: { owner: string; slug: string; descriptorUrl: string; isOntology: boolean }): string {
  const descriptorUrl = publishableDescriptorUrl(meta.descriptorUrl, iri);
  const controls = controlsFromAffordances(extractAffordancesFromTurtle(turtle, descriptorUrl));
  // NOTE: no embedded Turtle. The signed source (which legitimately carries
  // hydra:target transport endpoints) is one conneg request away via the
  // rel="alternate" links — embedding it would put those endpoints into
  // store-and-forward bytes, the exact leak the projection exists to avoid.
  const body = [
    `# ${meta.slug}`,
    ``,
    `A published Interego holon on \`${meta.owner}\`'s pod, projected as a HyperMarkdown`,
    `document. The Turtle / JSON-LD projections linked below are the same graph`,
    `resource — request them by content negotiation.`,
    ...(meta.isOntology ? [``, 'This graph is an `owl:Ontology`; its terms resolve as `#fragment`s of this IRI.'] : []),
    ...(controls.length === 0 ? [``, `This graph publishes no controls.`] : []),
  ].join('\n');

  return renderHypermediaMarkdown({
    id: iri,
    // hmd:Document typing lives on the frontmatter's document node, not the resource.
    type: meta.isOntology ? 'owl:Ontology' : 'iep:ContextDescriptor',
    descriptorUrl,
    title: meta.slug,
    // /ns serves only the current non-superseded PUBLIC graph, so this
    // lifecycle snapshot is honest by construction.
    state: 'published',
    fields: { 'dct:publisher': meta.owner },
    links: [
      { label: 'Signed descriptor (authority)', href: descriptorUrl, rel: 'describedby', type: 'text/turtle' },
      { label: 'Turtle', href: `${iri}?format=turtle`, rel: 'alternate', type: 'text/turtle' },
      { label: 'JSON-LD', href: `${iri}?format=jsonld`, rel: 'alternate', type: 'application/ld+json' },
    ],
    controls,
    body,
  });
}

/** Reduce any descriptor-supplied URL to the FIXED internal CSS host + the
 *  owner's own pod path — an SSRF-safe target rewrite (host is never attacker-
 *  controlled) constrained to `/<owner>/`. Returns null for a cross-owner /
 *  off-pod / unparseable URL so the caller uses the safe internal convention.
 *  Rewrites the fetch TARGET, never the served bytes (signatures verify). */
function nsToOwnerPodInternal(u: string, owner: string): string | null {
  try {
    const cssOrigin = new URL(CSS_URL).origin;
    const p = new URL(u).pathname;
    const first = p.split('/').filter(Boolean)[0] ?? '';
    if (decodeURIComponent(first) !== owner) return null;
    return `${cssOrigin}${p}`;
  } catch { return null; }
}

/** A fetchGraphContent()/solidFetch() error whose HTTP status is 404/410 —
 *  i.e. the target graph is ABSENT, not an upstream failure. Coupled to
 *  fetchGraphContent's throw format `Failed to GET <url>: <status> <text>`;
 *  the `: <status>` token (colon-space) can only be the status separator
 *  (a URL has no space), so it never false-matches on the URL itself. */
function isAbsentGraphError(e: unknown): boolean {
  const m = (e as Error)?.message ?? String(e);
  return /:\s(?:404|410)\b/.test(m);
}

/** Shared /ns resolver core — used by BOTH the public GET route and the
 *  resolve_linked_data MCP tool. Discovers the current non-superseded published
 *  graph at <RELAY_NS_ROOT>/<owner>/<slug>, follows the descriptor (SSRF-safe:
 *  every fetch URL reduced to the FIXED internal CSS host + the owner's own pod
 *  path), and returns the clean projected Turtle. Generic — NO conformsTo filter,
 *  serves any published PUBLIC graph. */
async function resolveNsGraph(owner: string, slug: string): Promise<
  | { ok: true; turtle: string; ontologyIri: string; isOntology: boolean; descriptorUrl: string }
  | { ok: false; status: number; error: string; ontologyIri: string }> {
  const graphIri = `${RELAY_NS_ROOT}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;
  const podUrl = `${CSS_URL}${encodeURIComponent(owner)}/`;
  const convGraphUrl = `${podUrl}ontologies/${encodeURIComponent(slug)}-graph.trig`;
  // Fetch a graph URL + build the served result (null when empty / encrypted-non-public).
  const serve = async (graphUrl: string, descriptorUrl: string, conformsTo: readonly string[] | undefined) => {
    let fetched: Awaited<ReturnType<typeof fetchGraphContent>>;
    try {
      fetched = await fetchGraphContent(graphUrl, { fetch: solidFetch });
    } catch (e) {
      // An ABSENT graph (CSS 404/410) is a genuine not-found, not an upstream
      // failure: return null so the caller falls through to the clean 404 instead
      // of the outer catch's 502. Any other error (5xx / network / abort/timeout)
      // still throws → 502, the correct status for a real bad gateway. This is what
      // makes the intended `return { status: 404 }` reachable for an unpublished
      // slug whose convention graph does not exist (the 0589752 fallback regression).
      if (isAbsentGraphError(e)) return null;
      throw e;
    }
    const trig = fetched.content ?? '';
    if (!trig || (fetched.encrypted && !fetched.content)) return null;
    const turtle = nsExtractGraphTurtle(trig, graphIri) ?? trig;
    const isOntology = (conformsTo ?? []).some(c => c === NS_OWL_ONTOLOGY) || /\bowl:Ontology\b/.test(turtle);
    return { ok: true as const, turtle, ontologyIri: graphIri, isOntology, descriptorUrl };
  };
  try {
    const entries = await discover(podUrl, { graphIri }, { fetch: solidFetch });
    const superseded = new Set(entries.flatMap(e => (e.supersedes ?? []) as string[]));
    const head = entries.find(e => !superseded.has(e.descriptorUrl)) ?? entries[0];
    if (head) {
      const descUrlSafe = nsToOwnerPodInternal(head.descriptorUrl, owner);
      let dist: ReturnType<typeof parseDistributionFromDescriptorTurtle> = null;
      if (descUrlSafe) {
        const descResp = await solidFetch(descUrlSafe, { headers: { Accept: 'text/turtle' } });
        dist = parseDistributionFromDescriptorTurtle(descResp.ok ? await descResp.text() : '');
      }
      if (dist?.encrypted) return { ok: false, status: 409, error: `Graph ${graphIri} is a non-public (encrypted) projection; only public RDF projections dereference here.`, ontologyIri: graphIri };
      const graphUrl = (dist?.accessURL ? nsToOwnerPodInternal(dist.accessURL, owner) : null) ?? convGraphUrl;
      const served = await serve(graphUrl, head.descriptorUrl, head.conformsTo);
      if (served) return served;
    }
    // FALLBACK — no manifest entry indexes this IRI (or its graph was unreadable).
    // Try the ontologies/<slug> CONVENTION graph directly. This makes an ontology
    // written to the convention dereference even when the pod's manifest could not
    // be indexed — e.g. an oversized manifest whose write fails (a large pod), or a
    // publisher that wrote the descriptor+graph but no manifest entry. Bounded: one
    // internal-host, owner-pod-path GET (SSRF-safe, same as the primary path).
    const served = await serve(convGraphUrl, convGraphUrl, undefined);
    if (served) return served;
    return { ok: false, status: 404, error: `No published graph at ${graphIri} on ${owner}'s pod.`, ontologyIri: graphIri };
  } catch (err) {
    return { ok: false, status: 502, error: `Failed to dereference ${graphIri}: ${(err as Error).message}`, ontologyIri: graphIri };
  }
}

/** MCP tool handler — resolve a published /ns graph/ontology as linked data for
 *  MCP-only clients that cannot GET the URL over raw HTTP. Accepts the full
 *  <relay>/ns/<owner>/<slug> IRI OR explicit owner+slug, + optional format
 *  (turtle | jsonld). Read-only; wraps resolveNsGraph (the same core the public
 *  GET route uses). */
async function handleResolveLinkedData(args: ToolArgs): Promise<string> {
  let owner = (args['owner'] as string | undefined)?.trim();
  let slug = (args['slug'] as string | undefined)?.trim();
  const iri = (args['iri'] as string | undefined)?.trim();
  if ((!owner || !slug) && iri) {
    const m = /\/ns\/([^/]+)\/([^/?#]+)/.exec(iri);
    if (m) { owner = decodeURIComponent(m[1]!); slug = decodeURIComponent(m[2]!); }
  }
  if (!owner || !slug) return JSON.stringify({ error: 'Provide { iri: "<relay>/ns/<owner>/<slug>" } OR { owner, slug }.' });
  const r = await resolveNsGraph(owner, slug);
  if ('error' in r) return JSON.stringify({ iri: r.ontologyIri, error: r.error });
  const format = String(args['format'] ?? 'turtle').toLowerCase();
  if (format === 'jsonld') {
    try { return JSON.stringify({ iri: r.ontologyIri, contentType: 'application/ld+json', isOntology: r.isOntology, content: nsTurtleToJsonLd(r.turtle) }); }
    catch { /* fall through to turtle */ }
  }
  // HyperMarkdown projection — the affordance set as prose the MODEL reads
  // natively, instead of Turtle only a parser can see. Controls carry no
  // transport endpoint; act via invoke_affordance(descriptorUrl, rel).
  if (format === 'markdown' || format === 'md' || format === 'hmd') {
    try {
      return JSON.stringify({
        iri: r.ontologyIri,
        contentType: HYPERMEDIA_MARKDOWN_MEDIA_TYPE,
        profile: HMD_PROFILE_IRI,
        isOntology: r.isOntology,
        content: nsMarkdown(r.ontologyIri, r.turtle, { owner, slug, descriptorUrl: r.descriptorUrl, isOntology: r.isOntology }),
      });
    } catch { /* fall through to Turtle — same posture as the HTTP route */ }
  }
  return JSON.stringify({ iri: r.ontologyIri, contentType: 'text/turtle', isOntology: r.isOntology, content: r.turtle });
}

app.options('/ns/:owner/:slug', (_req, res) => { res.status(204).end(); });
app.get('/ns/:owner/:slug', async (req, res) => {
  const owner = String(req.params['owner'] ?? '');
  const slug = String(req.params['slug'] ?? '');
  const r = await resolveNsGraph(owner, slug);
  if ('error' in r) { res.status(r.status).type('text/plain').send(r.error); return; }
  const { turtle, ontologyIri, isOntology, descriptorUrl } = r;
  // ONE conneg rule for every projection route (q-aware; explicit ?format wins;
  // ties broken turtle > jsonld > html > markdown; default here = Turtle).
  const kind = negotiateRepresentation(
    String(req.query['format'] ?? '') || undefined,
    String(req.headers['accept'] ?? '') || undefined,
  );
  res.setHeader('Vary', 'Accept');
  if (kind === 'jsonld') {
    try { res.type('application/ld+json').send(JSON.stringify(nsTurtleToJsonLd(turtle), null, 2)); return; } catch { /* fall back to Turtle */ }
  }
  if (kind === 'html') {
    res.type('text/html').send(nsHtml(ontologyIri, turtle, { owner, slug, descriptorUrl, isOntology })); return;
  }
  if (kind === 'markdown') {
    // HyperMarkdown: registered media type (RFC 7763 — charset REQUIRED,
    // variant names the SYNTAX flavor) + RFC 6906 profile Link for the
    // semantic dialect. The same profile claim rides in-band (the frontmatter
    // document node) because headers die at the first copy-paste.
    // try/catch like the jsonld branch: the renderer validates strictly, and
    // /ns serves ARBITRARY user-published graphs on an async Express 4 route
    // — an uncaught throw here would be an unhandled rejection (process exit
    // on Node 22), i.e. a one-GET DoS from one odd published graph.
    try {
      const md = nsMarkdown(ontologyIri, turtle, { owner, slug, descriptorUrl, isOntology });
      res.setHeader('Link', `${HMD_PROFILE_LINK_HEADER}, <${publishableDescriptorUrl(descriptorUrl, ontologyIri)}>; rel="describedby"; type="text/turtle"`);
      res.type(HYPERMEDIA_MARKDOWN_MEDIA_TYPE).send(md);
      return;
    } catch { /* fall back to Turtle */ }
  }
  res.type('text/turtle').send(turtle);
});

// ── /amep/* — AMEP engine (Interego is the reference implementation) ──
//
// Six protocol acts over pod-backed exchange state, served in four bindings.
// Conformance is validated on every response by the AMEP repo's own reference
// validator (vendored in ./amep-vendor/). See amep.ts for the full hardening.
const amepDeps: AmepDeps = {
  solidFetch,
  withPodMutex,
  introspect: (token: string) => {
    const intro = oauthProvider.introspectAccessToken(token);
    if (!intro) return null;
    // AMEP's actor / submittedBy must be an absolute IRI (they become @id nodes),
    // but intro.userId is a bare slug (u-pk-…). Use an IRI identity (session agent
    // DID, else WebID). The session bridge stamps act.actor with the SAME
    // principalIri() from the same token, so the actor-binding still holds.
    return { userId: principalIri(intro.agentId, intro.ownerWebId, intro.userId), scope: intro.scope ?? [], clientId: intro.clientId };
  },
  cssUrl: CSS_URL,
  maintainerPod: RELAY_MAINTAINER_POD_NAME || 'maintainer',
  publicBase: PUBLIC_BASE_URL || `http://localhost:${PORT}`,
  actSecret: AMEP_ACT_SECRET,
  // NON-NORMATIVE presentation binding: amep.ts's exchangeHyperMarkdown is the
  // default composer (a thin composition over the core HyperMarkdown renderer,
  // exported there so the binding is testable without booting this module).
  // No markdownFn override needed.
  log: (msg: string, extra?: unknown) => { if (extra !== undefined) console.log(msg, extra); else console.log(msg); },
};
mountAmep(app, amepDeps);

// ── /audit/* — compliance + lineage endpoints ──────────────
//
// /inbox + /audit/{events,lineage,verify-signature,compliance} take a
// user-supplied pod or descriptor URL and dereference it server-side.
// Without auth + URL validation an unauthenticated attacker could use
// the relay as an SSRF proxy to fetch Azure IMDS (169.254.169.254),
// the internal-only CSS host, the identity server, localhost services,
// etc., and exfiltrate the response through the 502 error body. The
// shared `requireAuthorizedPodUrl` gate below enforces (1) a valid
// OAuth bearer, (2) that the supplied pod/descriptor URL belongs to
// the bearer's own pod, and (3) that the URL parses as a public-https
// host outside RFC1918 / link-local / loopback / IMDS ranges.
//
// /audit/events — list recent descriptors on a pod (audit log).
// /audit/lineage — walk prov:wasDerivedFrom + iep:supersedes for one descriptor.
// /audit/compliance/:framework — generate a regulatory framework report.
// /audit/frameworks — list known frameworks + their controls (public; no URL input).

// Allowed host suffixes for user-supplied pod / descriptor URLs. The
// deployment's CSS_URL host is always allowed; operators can extend the
// list with comma-separated suffixes (e.g. known federation peers) via
// RELAY_POD_HOST_ALLOWLIST. Empty list still rejects private-IP / IMDS
// / .internal hosts via assertPublicPodUrl.
const RELAY_POD_HOST_ALLOWLIST: readonly string[] = (() => {
  const fromEnv = (process.env['RELAY_POD_HOST_ALLOWLIST'] ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  try {
    const cssHost = new URL(CSS_URL).hostname.toLowerCase();
    if (cssHost && !fromEnv.includes(cssHost)) fromEnv.push(cssHost);
  } catch { /* CSS_URL parse failure: rely on explicit allowlist only */ }
  return fromEnv;
})();

async function requireAuthorizedPodUrl(
  req: express.Request,
  res: express.Response,
  suppliedUrl: string,
): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required' });
    return null;
  }
  let ownerPodUrl: string | undefined;
  try {
    const info = await oauthProvider.verifyAccessToken(authHeader.slice(7));
    const extra = (info as { extra?: { podUrl?: string; userId?: string } }).extra;
    ownerPodUrl = extra?.podUrl
      ?? (extra?.userId ? `${CSS_URL}${extra.userId}/` : undefined);
  } catch (err) {
    res.status(401).json({ error: `Invalid access token: ${(err as Error).message}` });
    return null;
  }
  if (!ownerPodUrl) {
    res.status(403).json({ error: 'Token has no associated pod' });
    return null;
  }
  let parsed: URL;
  try {
    parsed = assertPublicPodUrl(suppliedUrl, RELAY_POD_HOST_ALLOWLIST);
  } catch (err) {
    res.status(400).json({ error: 'pod_url_rejected', detail: (err as Error).message });
    return null;
  }
  let ownerParsed: URL;
  try {
    ownerParsed = new URL(ownerPodUrl);
  } catch {
    res.status(500).json({ error: 'owner pod URL is malformed' });
    return null;
  }
  const sameOrigin = parsed.protocol === ownerParsed.protocol
    && parsed.hostname.toLowerCase() === ownerParsed.hostname.toLowerCase()
    && parsed.port === ownerParsed.port;
  const ownerPath = ownerParsed.pathname.endsWith('/') ? ownerParsed.pathname : `${ownerParsed.pathname}/`;
  const suppliedPath = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  if (!sameOrigin || !suppliedPath.startsWith(ownerPath)) {
    res.status(403).json({ error: 'pod URL does not belong to the authenticated user' });
    return null;
  }
  return suppliedUrl;
}

app.get('/audit/frameworks', (_req, res) => {
  const frameworks = Object.entries(FRAMEWORK_CONTROLS).map(([name, controls]) => ({
    framework: name,
    controlCount: controls.length,
    controls: controls.map(c => ({ iri: c.iri, label: c.label })),
  }));
  res.json({ frameworks });
});

// Shared rate limiter for bearer-gated endpoints whose first step is an
// OAuth bearer verification (oauthProvider.verifyAccessToken /
// verifyBearerToken) — that call can round-trip to the identity server,
// so an unbounded caller could DoS the verification path. 60/min/IP is
// well above any legitimate UX (dashboard token exchange, agent revoke,
// price setting).
const bearerVerifyLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * GET /inbox?pod=<pod-url>&since=<iso>
 *
 * "What's new on my pod?" — consumer-friendly framing of /audit/events
 * tailored for the share-and-discover loop. Returns descriptors on the
 * given pod sorted newest-first, with a default 7-day window so users
 * see what arrived recently without paging through everything.
 *
 * Per-publish E2EE means we can't reveal "who shared this with me" in
 * the manifest (recipients are X25519 pubkey hashes inside the
 * envelope, not DIDs in plaintext). The inbox surface lists ALL recent
 * descriptors on the pod; if the consumer's agent has the matching
 * private key, the envelope decrypts and the content shows. Otherwise
 * the descriptor is visible-but-opaque, which is the intended E2EE
 * tradeoff.
 *
 * UX audit (#10) flagged "user A shares with user B but B has no way
 * to discover what's been sent" as a blocking gap for family/team
 * adoption. This endpoint closes the visibility gap without leaking
 * the recipient graph at the manifest level.
 */
app.get('/inbox', bearerVerifyLimiter, async (req, res) => {
  const suppliedPodUrl = req.query.pod as string | undefined;
  if (!suppliedPodUrl) {
    res.status(400).json({
      error: 'pod_required',
      title: 'pod query parameter required',
      detail: 'GET /inbox?pod=https://your-pod.example/me/ — supplies the pod URL to scan. The relay does not know which pod is "yours" unless you tell it.',
    });
    return;
  }
  const podUrl = await requireAuthorizedPodUrl(req, res, suppliedPodUrl);
  if (!podUrl) return;
  // Default window: last 7 days. Tighten with ?since=2026-05-01T00:00:00Z.
  const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const since = (req.query.since as string | undefined) ?? sevenDaysAgoIso;
  const limit = Math.min(parseInt((req.query.limit as string | undefined) ?? '50', 10) || 50, 200);
  try {
    const entries = await discover(podUrl, undefined, { fetch: solidFetch });
    const recent = entries
      .filter(e => !e.validFrom || e.validFrom >= since)
      .sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''))
      .slice(0, limit);
    res.json({
      pod: podUrl,
      window: { since, sortedBy: 'validFrom-desc', limit },
      count: recent.length,
      totalOnPod: entries.length,
      hint: recent.length === 0
        ? 'No descriptors in this window. Try a wider `since` (e.g. ?since=2025-01-01T00:00:00Z) or check that your pod URL is correct.'
        : 'Items with an unfamiliar publisher are likely shared-with-you descriptors. Your agent\'s private key decides whether the content decrypts.',
      events: recent.map(e => ({
        descriptorUrl: e.descriptorUrl,
        graphIris: e.describes,
        validFrom: e.validFrom,
        modalStatus: e.modalStatus,
        trustLevel: e.trustLevel,
        supersedes: e.supersedes,
      })),
    });
  } catch (err) {
    res.status(502).json({
      error: 'pod_fetch_failed',
      title: `Could not reach pod ${podUrl}`,
      detail: (err as Error).message,
      retry: 'Common causes: pod is offline, URL has a typo, pod requires auth that this relay doesn\'t have. Verify the URL works in a browser first.',
    });
  }
});

app.get('/audit/events', bearerVerifyLimiter, async (req, res) => {
  const suppliedPodUrl = req.query.pod as string | undefined;
  if (!suppliedPodUrl) {
    res.status(400).json({
      error: 'pod_required',
      title: 'pod query parameter required',
      detail: 'GET /audit/events?pod=https://your-pod.example/me/ — supplies the pod URL to audit. The relay does not know which pod is "yours" unless you tell it.',
    });
    return;
  }
  const podUrl = await requireAuthorizedPodUrl(req, res, suppliedPodUrl);
  if (!podUrl) return;
  const since = req.query.since as string | undefined;
  const until = req.query.until as string | undefined;
  try {
    const entries = await discover(podUrl, undefined, { fetch: solidFetch });
    const filtered = entries.filter(e => {
      if (since && e.validFrom && e.validFrom < since) return false;
      if (until && e.validFrom && e.validFrom > until) return false;
      return true;
    });
    res.json({
      pod: podUrl,
      auditPeriod: (since || until) ? { since, until } : undefined,
      count: filtered.length,
      events: filtered.map(e => ({
        descriptorUrl: e.descriptorUrl,
        graphIris: e.describes,
        validFrom: e.validFrom,
        modalStatus: e.modalStatus,
        trustLevel: e.trustLevel,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get('/audit/lineage', bearerVerifyLimiter, async (req, res) => {
  const descriptorUrl = req.query.descriptor as string | undefined;
  const suppliedPodUrl = req.query.pod as string | undefined;
  if (!descriptorUrl) {
    res.status(400).json({ error: 'descriptor query param required' });
    return;
  }
  if (!suppliedPodUrl) {
    res.status(400).json({
      error: 'pod_required',
      title: 'pod query parameter required',
      detail: 'GET /audit/lineage?descriptor=<url>&pod=https://your-pod.example/me/ — supplies the pod URL to walk lineage on. The relay does not know which pod is "yours" unless you tell it.',
    });
    return;
  }
  const podUrl = await requireAuthorizedPodUrl(req, res, suppliedPodUrl);
  if (!podUrl) return;
  // descriptorUrl is reflected back to the caller — keep it on the same
  // public-https pod the bearer authorized.
  try {
    assertPublicPodUrl(descriptorUrl, RELAY_POD_HOST_ALLOWLIST);
  } catch (err) {
    res.status(400).json({ error: 'descriptor_url_rejected', detail: (err as Error).message });
    return;
  }
  if (!descriptorUrl.startsWith(podUrl)) {
    res.status(403).json({ error: 'descriptor URL is not under the authorized pod' });
    return;
  }
  try {
    // Walk the pod's manifest to build a descriptor index, then walk
    // lineage from the requested root.
    const entries = await discover(podUrl, undefined, { fetch: solidFetch });
    // The manifest doesn't yet cleartext-mirror derivedFrom/supersedes
    // into ManifestEntry typed fields; v1 lineage walker uses the manifest
    // as a flat index (depth=1 reachability) and reports unknown ancestors.
    // Future: extend ManifestEntry to expose these directly so the walker
    // can recurse without per-descriptor fetches.
    const index = new Map<IRI, { publishedAt: string; derivedFrom: IRI[]; supersedes: IRI[] }>();
    for (const e of entries) {
      index.set(e.descriptorUrl as IRI, {
        publishedAt: e.validFrom ?? '',
        derivedFrom: [],
        supersedes: [],
      });
    }
    const lineage = walkLineage(descriptorUrl as IRI, index);
    res.json({ root: descriptorUrl, pod: podUrl, lineageNodes: lineage.length, lineage });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/**
 * GET /audit/verify-signature?descriptor=<url>
 *
 * Fetches the descriptor's serialized Turtle + the sibling .sig.json
 * (produced by publish_context with compliance: true) and runs ECDSA
 * verification. Returns:
 *   { valid, descriptorUrl, signerAddress, signedAt, contentHashOk, reason? }
 *
 * Public read; auditors can independently verify any compliance
 * descriptor's signature without trusting the relay.
 */
app.get('/audit/verify-signature', bearerVerifyLimiter, async (req, res) => {
  const descriptorUrl = req.query.descriptor as string | undefined;
  if (!descriptorUrl) {
    res.status(400).json({ error: 'descriptor query param required' });
    return;
  }
  const authorized = await requireAuthorizedPodUrl(req, res, descriptorUrl);
  if (!authorized) return;
  try {
    const sigUrl = `${descriptorUrl}.sig.json`;
    const [ttlResp, sigResp] = await Promise.all([
      solidFetch(descriptorUrl, { headers: { 'Accept': 'text/turtle' } }),
      solidFetch(sigUrl, { headers: { 'Accept': 'application/json' } }),
    ]);
    if (!ttlResp.ok) {
      res.status(404).json({ error: `descriptor not fetchable (${ttlResp.status})`, descriptorUrl });
      return;
    }
    if (!sigResp.ok) {
      res.json({
        valid: false,
        descriptorUrl,
        reason: `no sibling .sig.json (HTTP ${sigResp.status}); descriptor was not published with compliance: true`,
      });
      return;
    }
    const turtle = await ttlResp.text();
    const signed = JSON.parse(await sigResp.text()) as SignedDescriptor;
    const result = await verifyDescriptorSignature(signed, turtle);
    res.json({
      ...result,
      descriptorUrl,
      sigUrl,
      signerAddress: signed.signerAddress,
      signedAt: signed.signedAt,
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get('/audit/compliance/:framework', bearerVerifyLimiter, async (req, res) => {
  const framework = req.params.framework as ComplianceFramework;
  if (!['eu-ai-act', 'nist-rmf', 'soc2'].includes(framework)) {
    res.status(400).json({ error: `unknown framework; must be one of eu-ai-act / nist-rmf / soc2` });
    return;
  }
  const suppliedPodUrl = req.query.pod as string | undefined;
  if (!suppliedPodUrl) {
    res.status(400).json({
      error: 'pod_required',
      title: 'pod query parameter required',
      detail: 'GET /audit/compliance/:framework?pod=https://your-pod.example/me/ — supplies the pod URL to generate the report from. The relay does not know which pod is "yours" unless you tell it.',
    });
    return;
  }
  const podUrl = await requireAuthorizedPodUrl(req, res, suppliedPodUrl);
  if (!podUrl) return;
  const auditPeriod = req.query.from && req.query.to
    ? { from: req.query.from as string, to: req.query.to as string }
    : undefined;
  try {
    const entries = await discover(podUrl, undefined, { fetch: solidFetch });
    // Map manifest entries → AuditableDescriptor. v1: derive evidence
    // citations from a (currently absent) iep:evidenceForControl predicate;
    // for now the heuristic is the dct:conformsTo array (pre-existing).
    const auditable: AuditableDescriptor[] = entries.map(e => ({
      id: e.descriptorUrl as IRI,
      publishedAt: e.validFrom ?? '',
      evidenceForControls: (e.conformsTo ?? []) as IRI[],
    }));
    const report = generateFrameworkReport(framework, auditable, { auditPeriod });
    res.json(report);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/**
 * GET /identity-token — exchange a valid MCP access token for the
 * underlying identity-server bearer token stored in the token's extra
 * field. Used by the dashboard so it can call identity's /auth-methods/*
 * endpoints directly on the user's behalf after OAuth sign-in.
 *
 * Auth: Bearer <MCP access token> (issued by this relay's OAuth).
 * Returns: { identityToken, expiresAt }.
 *
 * The identity token itself is bearer-bound to the user, so once the
 * dashboard has it, identity's own authorization checks apply.
 */
app.get('/identity-token', bearerVerifyLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required' });
    return;
  }
  try {
    const info = await oauthProvider.verifyAccessToken(authHeader.slice(7));
    const identityToken = (info as { extra?: { identityToken?: string } }).extra?.identityToken;
    if (!identityToken) {
      res.status(404).json({ error: 'No identity token associated with this access token' });
      return;
    }
    res.json({
      identityToken,
      expiresAt: info.expiresAt,
      userId: (info as { extra?: { userId?: string } }).extra?.userId,
    });
  } catch (err) {
    res.status(401).json({ error: `Invalid access token: ${(err as Error).message}` });
  }
});

/**
 * POST /verify-token — gate-to-relay OAuth-bearer introspection RPC.
 *
 * Solves a specific cross-service handoff problem:
 *
 *   - css-gate's verifyUserBearer() (deploy/css-gate/server.mjs)
 *     accepts two bearer types on writes: the operator WRITE_SECRET,
 *     or a per-user bearer it verifies against identity-server's POST
 *     /tokens/verify (which only accepts identity-server-signed tokens).
 *
 *   - This relay's OAuth flow mints OPAQUE access tokens
 *     (randomBytes(32).hex) that live ONLY in this relay's in-process
 *     `accessTokens` Map. Identity has never seen them and its
 *     signature verifier always rejects them, so every browser/MCP
 *     client that authenticated through the relay's OAuth flow and
 *     presents its access_token directly to the css-gate gets 401
 *     "identity returned 401" on every write — the exact failure mode
 *     this endpoint exists to fix.
 *
 * Contract:
 *   - Auth on THIS endpoint:
 *       Authorization: Bearer <RELAY_INTROSPECTION_SECRET>
 *     The gate carries the same secret in its own env. Mismatched or
 *     unset => 503 (config error; gate logs + retries the
 *     identity-only path).
 *   - Body: { token: <raw-opaque-access-token-the-gate-received> }
 *   - Response shape MATCHES identity-server's /tokens/verify so the
 *     gate's existing cache + path-scope check work unchanged:
 *       200 { valid: true,  userId, agentId, ownerWebId, podUrl,
 *             scope, expiresAt, clientId }
 *       200 { valid: false, reason }   (token unknown / expired)
 *       400 on missing/invalid body
 *       401 on missing/invalid introspection secret
 *       503 when RELAY_INTROSPECTION_SECRET is unset on this relay
 *
 * Security notes:
 *   - 200 + valid:false (not 401) for unknown tokens — distinguishes
 *     "you the gate aren't authorized to ask" from "the user's token
 *     isn't live" so the gate caches the right outcome.
 *   - The introspection secret is a SHARED password between gate and
 *     relay. Rotate it via az containerapp update --set-env-vars on
 *     both apps together; the relay drops in-flight requests on env
 *     reload but the gate's cache TTL bounds the window where stale
 *     introspections leak.
 *   - DPoP cnf.jkt binding is NOT enforced here. The gate isn't an
 *     audience for the client's DPoP proof (the proof's htu is the
 *     gate URL, not /mcp), so the relay's introspection report stops
 *     short of asserting key-binding. The token's freshness + the
 *     gate's path-scope check are the trust bar at the gate boundary.
 */
// Per-IP rate limit on /verify-token. The bearer compare is timing-safe,
// but with no throttle a leaked/guessed secret turns this into an
// unbounded oracle over oauthProvider.introspectAccessToken. 60/min is
// generous for the gate's normal traffic and kills sustained abuse.
const verifyTokenLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.post('/verify-token', verifyTokenLimiter, async (req, res) => {
  // Config sanity. If the operator forgot to set the shared secret on
  // this relay, fail closed with 503 so the gate can fall back to its
  // identity-only path without thinking the introspection said
  // "valid:false".
  if (!RELAY_INTROSPECTION_SECRET) {
    res.status(503).json({
      valid: false,
      reason: 'RELAY_INTROSPECTION_SECRET not configured on relay; token introspection disabled',
    });
    return;
  }

  // Gate auth: the gate's introspection request itself carries the
  // shared secret as its bearer. We use a timing-safe compare so a
  // wrong-secret probe doesn't leak the correct length character by
  // character.
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ valid: false, reason: 'introspection bearer required' });
    return;
  }
  const presented = auth.slice(7);
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(RELAY_INTROSPECTION_SECRET, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ valid: false, reason: 'introspection bearer rejected' });
    return;
  }

  // Body: { token: string }. The gate forwards the raw user bearer
  // verbatim — we never see the gate's caller, only the token they
  // presented.
  const body = req.body as { token?: unknown } | undefined;
  const token = body && typeof body.token === 'string' ? body.token : null;
  if (!token) {
    res.status(400).json({ valid: false, reason: 'request body must be { token: string }' });
    return;
  }

  const intro = oauthProvider.introspectAccessToken(token);
  if (!intro) {
    // 200 + valid:false (NOT 401) — matches identity-server's
    // /tokens/verify shape so the gate can cache this as a definitive
    // "not a relay token" miss instead of treating it as transport
    // failure.
    res.status(200).json({ valid: false, reason: 'token not found or expired' });
    return;
  }

  res.status(200).json({
    valid: true,
    userId: intro.userId,
    agentId: intro.agentId,
    ownerWebId: intro.ownerWebId,
    podUrl: intro.podUrl,
    scope: intro.scope.join(' '),
    expiresAt: intro.expiresAt,
    clientId: intro.clientId,
  });
});

/**
 * POST /admin/backfill-manifest-cid — one-shot rewrite that adds the
 * `iep:contentCid "<cid>"` triple to existing manifest entries that
 * predate the mirror. Closes the legacy-entry gap in the Phase A CAS
 * precondition fast-path: post-fix publishes always write the mirror,
 * but entries written by pre-fix publishes (every head currently on
 * every pod) still force a body-fetch + rehash inside
 * `checkSupersessionPrecondition`. That body fetch is the flaky read
 * johnny pinned as the 503 `precondition_unavailable` source. After
 * backfill, Phase A reads the head CID straight from the manifest and
 * the descriptor body GET is gone from the CAS path entirely.
 *
 * Auth: `Authorization: Bearer <RELAY_INTROSPECTION_SECRET>` — same
 * shared secret /verify-token uses. Fail closed (503) when unset.
 *
 * Body:
 *   { podUrl: string,                 // pod root, trailing slash OK
 *     descriptorUrls?: string[] }     // optional whitelist; default = all
 *                                     // entries missing the mirror
 *
 * Response:
 *   200 { ok: true, podUrl, manifestUrl, scanned, backfilled, skipped,
 *         entries: [{ descriptorUrl, cid, action }] }
 *   400 missing/invalid body
 *   401 introspection bearer wrong
 *   412 manifest changed mid-rewrite (caller can retry)
 *   503 RELAY_INTROSPECTION_SECRET unset
 *
 * Semantics: identical CID derivation to `publish()` —
 * `computeCid(descriptorBody)` over the bytes returned by GET, same
 * function the substrate gate would invoke on the fallback path. The
 * read pulls each descriptor with `Cache-Control: no-cache` so a stale
 * intermediary can't poison the mirror. Writes go through the same
 * If-Match CAS dance the manifest-update path uses inside `publish()`,
 * so a concurrent publisher's update is detected and reported rather
 * than clobbered.
 */
// POST /admin/reload-dynamic-tools — re-scan the configured
// RELAY_DYNAMIC_TOOLS_POD for Asserted ac:AgentTool descriptors and
// rebuild the dynamicTools registry. Same auth model as
// /admin/backfill-manifest-cid (introspection-secret-gated). The
// substrate-honest "grow myself" tool: a new tool gets authored +
// attested on a pod, this endpoint surfaces it, and the next MCP
// `tools/list` call shows the new entry.
app.post('/admin/reload-dynamic-tools', async (req, res) => {
  if (!RELAY_INTROSPECTION_SECRET) {
    res.status(503).json({ ok: false, reason: 'RELAY_INTROSPECTION_SECRET not configured on relay; admin endpoints disabled' });
    return;
  }
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, reason: 'introspection bearer required' });
    return;
  }
  const presented = auth.slice(7);
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(RELAY_INTROSPECTION_SECRET, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ ok: false, reason: 'introspection bearer rejected' });
    return;
  }
  if (!RELAY_DYNAMIC_TOOLS_POD) {
    res.status(503).json({ ok: false, reason: 'RELAY_DYNAMIC_TOOLS_POD not configured; no pod to scan' });
    return;
  }
  const loaded = await loadDynamicTools();
  res.status(200).json({
    ok: true,
    podUrl: RELAY_DYNAMIC_TOOLS_POD,
    loaded,
    tools: [...dynamicTools.keys()],
    lastLoadedAt: dynamicToolsLastLoadedAt,
  });
});

// GET /admin/dynamic-tools-status — read-only view of the dynamic
// registry's current state (count + names + last-load timestamp).
// Same introspection-secret gate. Useful for ops monitoring without
// triggering a rescan.
app.get('/admin/dynamic-tools-status', async (req, res) => {
  if (!RELAY_INTROSPECTION_SECRET) {
    res.status(503).json({ ok: false, reason: 'RELAY_INTROSPECTION_SECRET not configured' });
    return;
  }
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, reason: 'introspection bearer required' });
    return;
  }
  const presented = auth.slice(7);
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(RELAY_INTROSPECTION_SECRET, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ ok: false, reason: 'introspection bearer rejected' });
    return;
  }
  res.status(200).json({
    ok: true,
    configuredPod: RELAY_DYNAMIC_TOOLS_POD ?? null,
    lastLoadedAt: dynamicToolsLastLoadedAt,
    lastLoadCount: dynamicToolsLastLoadCount,
    tools: [...dynamicTools.entries()].map(([name, t]) => ({
      name,
      descriptorUrl: t.descriptorUrl,
      affordanceAction: t.affordanceAction ?? null,
    })),
  });
});

app.post('/admin/backfill-manifest-cid', async (req, res) => {
  if (!RELAY_INTROSPECTION_SECRET) {
    res.status(503).json({ ok: false, reason: 'RELAY_INTROSPECTION_SECRET not configured on relay; admin endpoints disabled' });
    return;
  }
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, reason: 'introspection bearer required' });
    return;
  }
  const presented = auth.slice(7);
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(RELAY_INTROSPECTION_SECRET, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ ok: false, reason: 'introspection bearer rejected' });
    return;
  }

  const body = req.body as { podUrl?: unknown; descriptorUrls?: unknown } | undefined;
  const podUrlRaw = body && typeof body.podUrl === 'string' ? body.podUrl : null;
  if (!podUrlRaw) {
    res.status(400).json({ ok: false, reason: 'request body must include { podUrl: string }' });
    return;
  }
  const podUrl = podUrlRaw.endsWith('/') ? podUrlRaw : `${podUrlRaw}/`;
  const whitelist = Array.isArray(body!.descriptorUrls)
    ? new Set((body!.descriptorUrls as unknown[]).filter((x): x is string => typeof x === 'string'))
    : null;

  const manifestUrl = `${podUrl}.well-known/context-graphs`;

  // 1. GET manifest with ETag. We need the etag for the rewrite CAS.
  //    Wrap in withTransientRetry + 5xx-as-throw promotion so a single
  //    Azure-Files cold-cache 503 doesn't surface as a backfill
  //    failure when the substrate is otherwise healthy.
  let getResp;
  try {
    getResp = await withTransientRetry(async () => {
      const r = await solidFetch(manifestUrl, {
        method: 'GET',
        headers: { 'Accept': 'text/turtle', 'Cache-Control': 'no-cache' },
      });
      if (r.status >= 500) {
        throw new Error(`manifest GET <${manifestUrl}> failed: ${r.status} ${r.statusText}`);
      }
      return r;
    }, { maxAttempts: 6, baseMs: 500 });
  } catch (err) {
    res.status(502).json({ ok: false, reason: `manifest GET failed after retries: ${(err as Error).message}` });
    return;
  }
  if (!getResp.ok) {
    res.status(getResp.status).json({ ok: false, reason: `manifest GET failed: ${getResp.status} ${getResp.statusText}` });
    return;
  }
  const manifestTurtle = await getResp.text();
  const etag = getResp.headers?.get('etag') ?? null;

  // 2. Parse + compute backfill targets.
  const entries = parseManifest(manifestTurtle);
  const targets: { descriptorUrl: string; existingCid?: string }[] = [];
  for (const e of entries) {
    if (whitelist && !whitelist.has(e.descriptorUrl)) continue;
    if (e.cid) continue; // already mirrored
    targets.push({ descriptorUrl: e.descriptorUrl });
  }

  if (targets.length === 0) {
    res.status(200).json({
      ok: true,
      podUrl,
      manifestUrl,
      scanned: entries.length,
      backfilled: 0,
      skipped: entries.length,
      entries: [],
      note: whitelist
        ? 'All whitelisted entries already carry iep:contentCid (or were not present in the manifest); nothing to backfill.'
        : 'All manifest entries already carry iep:contentCid; nothing to backfill.',
    });
    return;
  }

  // 3. For each target: GET descriptor body, computeCid, build edit set.
  const edits: { descriptorUrl: string; cid: string }[] = [];
  const failures: { descriptorUrl: string; error: string }[] = [];
  for (const t of targets) {
    try {
      const dResp = await solidFetch(t.descriptorUrl, {
        method: 'GET',
        headers: { 'Accept': 'text/turtle', 'Cache-Control': 'no-cache' },
      });
      if (!dResp.ok) {
        failures.push({ descriptorUrl: t.descriptorUrl, error: `descriptor GET ${dResp.status} ${dResp.statusText}` });
        continue;
      }
      const turtle = await dResp.text();
      const cid = cryptoComputeCid(turtle);
      edits.push({ descriptorUrl: t.descriptorUrl, cid });
    } catch (err) {
      failures.push({ descriptorUrl: t.descriptorUrl, error: (err as Error).message });
    }
  }

  if (edits.length === 0) {
    res.status(502).json({
      ok: false,
      reason: 'all descriptor body fetches failed; manifest unchanged',
      failures,
    });
    return;
  }

  // 4. Inject `iep:contentCid "<cid>" ;` into each target entry.
  // The manifest format is line-oriented (parseManifest is too): each
  // entry begins with `<URL> a iep:ManifestEntry ;` and runs until a
  // line ending in `.`. Insert the new triple right after the entry
  // header so it sits in the same field-order publish() now emits.
  const editByUrl = new Map(edits.map(e => [e.descriptorUrl, e.cid]));
  const lines = manifestTurtle.split(/\r?\n/);
  const out: string[] = [];
  for (const ln of lines) {
    out.push(ln);
    const m = ln.match(/^<([^>]+)>\s+a\s+iep:ManifestEntry\s*;/);
    if (m) {
      const url = m[1]!;
      const cid = editByUrl.get(url);
      if (cid) {
        // Match the indentation of the existing entry triples (4 spaces
        // is the manifestEntryTurtle convention; fall back to leading
        // whitespace of the next non-blank if present).
        const indent = '    ';
        out.push(`${indent}iep:contentCid "${cid}" ;`);
      }
    }
  }
  const rewritten = out.join('\n');

  // 5. CAS PUT back. If-Match guards against a concurrent publisher
  // having moved the manifest between our GET and this PUT.
  const putHeaders: Record<string, string> = { 'Content-Type': 'text/turtle' };
  if (etag) putHeaders['If-Match'] = etag;
  const putResp = await solidFetch(manifestUrl, {
    method: 'PUT',
    headers: putHeaders,
    body: rewritten,
  });
  if (!putResp.ok) {
    res.status(putResp.status === 412 ? 412 : 502).json({
      ok: false,
      reason: `manifest PUT failed: ${putResp.status} ${putResp.statusText}`,
      retryable: putResp.status === 412,
      edits,
      failures,
    });
    return;
  }

  // 6. Invalidate the in-process manifest cache so the next read sees
  // the mirrored entries.
  manifestCache.delete(podUrl);

  res.status(200).json({
    ok: true,
    podUrl,
    manifestUrl,
    scanned: entries.length,
    backfilled: edits.length,
    skipped: entries.length - targets.length,
    failed: failures.length,
    entries: edits.map(e => ({ descriptorUrl: e.descriptorUrl, cid: e.cid, action: 'mirror-added' })),
    ...(failures.length > 0 ? { failures } : {}),
  });
});

/**
 * GET /render/:descriptorIri — server-side projection of an encrypted graph
 * payload for thin clients (no X25519 keypair). Content-negotiated: plaintext
 * Turtle by default; a complete HyperMarkdown note (prose + fields + links +
 * controls) when text/markdown is requested.
 *
 * Implements the `iep:renderView` affordance pattern: the publisher
 * emits a second affordance on the descriptor (alongside iep:canDecrypt)
 * pointing at this endpoint. Holders of a bearer token whose minted
 * surface-agent is in the descriptor's envelope recipient set follow
 * that link and receive the decrypted named-graph as `text/turtle`.
 *
 *   1. Verify bearer (OAuth access token OR identity-server token).
 *   2. Resolve `descriptorIri` (URN or URL) to a descriptor URL via
 *      kernel.dereference using podHint = caller's pod and knownPods.
 *   3. Fetch the descriptor turtle; parse its Distribution affordance
 *      to find the envelope URL + encryption status.
 *   4. Fetch the envelope JSON.
 *   5. Server-side unwrap using the relay's per-agent X25519 keypair
 *      (`relayAgentKey`) — the relay holds the recipient key for every
 *      surface-agent it has minted, so every envelope published through
 *      this relay (or sharedWith one of its agents) is openable here.
 *   6. Return plaintext Turtle with `Content-Type: text/turtle`.
 *
 * Returns:
 *   200 text/turtle on success (plaintext projection)
 *   401 when bearer is missing or invalid
 *   403 when the relay agent is not in the envelope's recipient set
 *   404 when the descriptor can't be resolved
 *   409 when the descriptor's payload is NOT encrypted (no projection
 *       needed — caller can fetch the payload URL directly via the
 *       existing iep:canFetchPayload affordance)
 */
app.get('/render/:descriptorIri', async (req, res) => {
  const auth = await verifyBearerToken(req.headers.authorization);
  if (!auth.authenticated) {
    res.status(401).type('application/ld+json').json({
      '@context': KERNEL_JSONLD_CONTEXT,
      '@type': ['hydra:Status', 'urn:iep:error:Unauthorized'],
      error: auth.error ?? 'Bearer token required',
    });
    return;
  }
  const descriptorIri = decodeURIComponent(req.params['descriptorIri'] ?? '');
  if (!descriptorIri) {
    res.status(400).type('application/ld+json').json({
      '@context': KERNEL_JSONLD_CONTEXT,
      '@type': ['hydra:Status', 'urn:iep:error:BadRequest'],
      error: 'descriptorIri path segment required',
    });
    return;
  }

  try {
    // Resolve the descriptor IRI to a fetchable descriptor URL.
    // Either form works:
    //   - urn:graph:* — needs podHint + knownPods so the kernel can
    //     scan manifests
    //   - https://… — already a URL; we fetch directly
    let descriptorUrl: string | null = null;
    if (descriptorIri.startsWith('http://') || descriptorIri.startsWith('https://')) {
      descriptorUrl = descriptorIri;
    } else {
      const podHint = auth.userId ? `${CSS_URL}${auth.userId}/` : undefined;
      const knownPodUrls = Array.from(knownPods.values()).map(e => e.url);
      const r = await kernelDereference(descriptorIri, {
        fetch: solidFetch,
        decorateManifest: false,
        recipientKeyPair: relayAgentKey,
        ...(podHint ? { podHint } : {}),
        ...(knownPodUrls.length > 0 ? { knownPods: knownPodUrls } : {}),
      });
      // kernelDereference returns affordances; the descriptor URL is the
      // resolved canonical IRI. When it returned a manifest entry (URN
      // resolution), its `source` field carries the descriptor URL.
      const rr = r as unknown as { source?: string; manifest?: { source?: string } };
      descriptorUrl = rr.source ?? rr.manifest?.source ?? null;
    }
    if (!descriptorUrl) {
      res.status(404).type('application/ld+json').json({
        '@context': KERNEL_JSONLD_CONTEXT,
        '@type': ['hydra:Status', 'urn:iep:error:DescriptorNotFound'],
        error: `Cannot resolve descriptor IRI: ${descriptorIri}`,
      });
      return;
    }

    // Fetch the descriptor and parse its Distribution affordance.
    const descResp = await solidFetch(descriptorUrl, {
      headers: { 'Accept': 'text/turtle' },
    });
    if (!descResp.ok) {
      res.status(404).type('application/ld+json').json({
        '@context': KERNEL_JSONLD_CONTEXT,
        '@type': ['hydra:Status', 'urn:iep:error:DescriptorNotFound'],
        error: `Descriptor GET failed: ${descResp.status} ${descResp.statusText}`,
        descriptorUrl,
      });
      return;
    }
    const descTurtle = await descResp.text();
    const dist = parseDistributionFromDescriptorTurtle(descTurtle);
    if (!dist) {
      res.status(404).type('application/ld+json').json({
        '@context': KERNEL_JSONLD_CONTEXT,
        '@type': ['hydra:Status', 'urn:iep:error:NoDistribution'],
        error: 'Descriptor has no parseable Distribution affordance',
        descriptorUrl,
      });
      return;
    }
    if (!dist.encrypted) {
      res.status(409).type('application/ld+json').json({
        '@context': KERNEL_JSONLD_CONTEXT,
        '@type': ['hydra:Status', 'urn:iep:error:NotEncrypted'],
        error: 'Payload is not encrypted; iep:renderView is only meaningful for encrypted distributions. Follow the iep:canFetchPayload affordance directly.',
        accessURL: dist.accessURL,
      });
      return;
    }

    // Fetch the envelope and server-side unwrap.
    const envResp = await solidFetch(dist.accessURL, {
      headers: { 'Accept': 'application/jose+json, application/json' },
    });
    if (!envResp.ok) {
      res.status(502).type('application/ld+json').json({
        '@context': KERNEL_JSONLD_CONTEXT,
        '@type': ['hydra:Status', 'urn:iep:error:EnvelopeFetchFailed'],
        error: `Envelope GET failed: ${envResp.status} ${envResp.statusText}`,
        envelopeUrl: dist.accessURL,
      });
      return;
    }
    const envBody = await envResp.text();
    let envelope: EncryptedEnvelope;
    try {
      envelope = JSON.parse(envBody) as EncryptedEnvelope;
    } catch (err) {
      res.status(502).type('application/ld+json').json({
        '@context': KERNEL_JSONLD_CONTEXT,
        '@type': ['hydra:Status', 'urn:iep:error:MalformedEnvelope'],
        error: `Envelope is not valid JSON: ${(err as Error).message}`,
      });
      return;
    }
    if (!envelope || envelope.algorithm !== 'X25519-XSalsa20-Poly1305' || !Array.isArray(envelope.wrappedKeys)) {
      res.status(502).type('application/ld+json').json({
        '@context': KERNEL_JSONLD_CONTEXT,
        '@type': ['hydra:Status', 'urn:iep:error:MalformedEnvelope'],
        error: 'Envelope is not a valid X25519-XSalsa20-Poly1305 JOSE envelope',
      });
      return;
    }
    // Recipient-set check via wrappedKeys: the relay's per-agent X25519
    // public key MUST be in the envelope's recipient list for the
    // unwrap below to succeed. We check explicitly (instead of relying
    // on openEncryptedEnvelope returning null) so the 403 carries a
    // clear "you are not a recipient" message rather than a generic
    // decryption failure — important for thin-client diagnostics.
    const inRecipientSet = envelope.wrappedKeys.some(
      wk => wk.recipientPublicKey === relayAgentKey.publicKey,
    );
    if (!inRecipientSet) {
      res.status(403).type('application/ld+json').json({
        '@context': KERNEL_JSONLD_CONTEXT,
        '@type': ['hydra:Status', 'urn:iep:error:NotARecipient'],
        error: 'Relay agent is not in the envelope recipient set; cannot render plaintext projection.',
        relayAgentPublicKey: relayAgentKey.publicKey,
        recipientCount: envelope.wrappedKeys.length,
      });
      return;
    }
    const plaintext = openEncryptedEnvelope(envelope, relayAgentKey);
    if (plaintext === null) {
      res.status(500).type('application/ld+json').json({
        '@context': KERNEL_JSONLD_CONTEXT,
        '@type': ['hydra:Status', 'urn:iep:error:UnwrapFailed'],
        error: 'Relay agent is in recipient set but unwrap failed (key material corrupted?).',
      });
      return;
    }
    // Content-negotiated projection. Default: plaintext Turtle (the envelope
    // body is a TriG document wrapping the descriptor prefixes + named-graph
    // payload — valid Turtle a thin client parses without further unwrap).
    // text/markdown (or ?format=markdown|hmd): the complete HyperMarkdown note
    // — the human-legible + agent-actionable view, with the note's own controls
    // and links, decrypted for this authorized owner. Falls back to Turtle if
    // projection throws (never 500s a successful decrypt).
    const kind = negotiateRepresentation(
      String(req.query['format'] ?? '') || undefined,
      String(req.headers['accept'] ?? '') || undefined,
    );
    res.setHeader('Vary', 'Accept');
    if (kind === 'markdown') {
      try {
        const viewUrl = `${(PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '')}/render/${encodeURIComponent(descriptorIri)}`;
        const authority = publishableDescriptorUrl(descriptorUrl, viewUrl);
        const md = noteToHyperMarkdown({ viewUrl, authority, descriptorTurtle: descTurtle, plaintextTurtle: plaintext });
        res.setHeader('Link', `${HMD_PROFILE_LINK_HEADER}, <${authority}>; rel="describedby"; type="text/turtle"`);
        res.status(200).type(HYPERMEDIA_MARKDOWN_MEDIA_TYPE).send(md);
        return;
      } catch { /* fall back to Turtle */ }
    }
    res.status(200).type('text/turtle').send(plaintext);
  } catch (err) {
    res.status(500).type('application/ld+json').json({
      '@context': KERNEL_JSONLD_CONTEXT,
      '@type': ['hydra:Status', 'urn:iep:error:RenderFailed'],
      error: `Render failed: ${(err as Error).message}`,
    });
  }
});

/**
 * POST /agents/:agentIri/revoke — remove a non-revoked agent from the
 * calling user's pod agent registry. Bearer-gated via MCP access token;
 * the agent IRI in the path must belong to the token's user's pod.
 *
 * `agentIri` is URL-encoded (typically a did:web IRI). Returns 404 if
 * the agent doesn't appear in the current registry, 403 if the agent
 * belongs to a different user's pod (owner IRI mismatch), 200 on
 * success with `{ revoked: true, agentIri, remaining: <count> }`.
 *
 * After revocation, the agent no longer appears as a recipient on
 * future envelope writes; already-encrypted envelopes keep their
 * previous recipient sets (true of all E2EE systems).
 */
app.post('/agents/:agentIri/revoke', bearerVerifyLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required' });
    return;
  }
  let authInfo: { extra?: { userId?: string; ownerWebId?: string; identityToken?: string } };
  try {
    authInfo = await oauthProvider.verifyAccessToken(authHeader.slice(7)) as typeof authInfo;
  } catch (err) {
    res.status(401).json({ error: `Invalid access token: ${(err as Error).message}` });
    return;
  }
  const tokenUserId = authInfo.extra?.userId;
  const tokenOwnerWebId = authInfo.extra?.ownerWebId;
  if (!tokenUserId || !tokenOwnerWebId) {
    res.status(403).json({ error: 'Token has no identity binding' });
    return;
  }

  const agentIri = decodeURIComponent((req.params['agentIri'] ?? '') as string) as IRI;
  if (!agentIri) { res.status(400).json({ error: 'agentIri path param required' }); return; }

  const podUrl = `${CSS_URL}${tokenUserId}/`;
  try {
    const profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
    if (!profile) {
      res.status(404).json({ error: 'No agent registry on this pod' });
      return;
    }
    if (profile.webId !== tokenOwnerWebId) {
      res.status(403).json({ error: `Agent registry owner ${profile.webId} does not match token user's WebID` });
      return;
    }
    const found = profile.authorizedAgents.find(a => a.agentId === agentIri && !a.revoked);
    if (!found) {
      res.status(404).json({ error: `Agent ${agentIri} not present (or already revoked) in this pod's registry` });
      return;
    }
    const updated = removeAuthorizedAgent(profile, agentIri);
    await writeAgentRegistry(updated, podUrl, { fetch: solidFetch });
    relayProfileCache.delete(podUrl);
    const remaining = updated.authorizedAgents.filter(a => !a.revoked).length;

    // Emit a SOC 2 access-change descriptor — every agent revocation
    // is auditable evidence per spec/policies/02-access-control.md §5.3
    // and spec/policies/04-incident-response.md §5.8 (credential
    // compromise). Failure here MUST NOT fail the revoke (the registry
    // mutation is the source of truth); we log + surface in the
    // response.
    let auditEvent: ReturnType<typeof buildAccessChangeEvent> | null = null;
    let auditWarning: string | null = null;
    try {
      auditEvent = buildAccessChangeEvent({
        action: 'revoked',
        principal: agentIri,
        system: `pod:${podUrl}`,
        scope: `iep:authorizedAgent on ${podUrl}`,
        grantorDid: tokenOwnerWebId,
        justification: (req.body && typeof req.body === 'object' && typeof req.body.reason === 'string')
          ? req.body.reason
          : 'operator-initiated revocation via /agents/:agentIri/revoke',
      });
    } catch (auditErr) {
      auditWarning = `Audit-event generation failed: ${(auditErr as Error).message}`;
      log(`[audit] revoke ${agentIri}: ${auditWarning}`);
    }
    res.json({
      revoked: true,
      agentIri,
      remaining,
      ...(auditEvent ? { audit: auditEvent } : {}),
      ...(auditWarning ? { auditWarning } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: `Revoke failed: ${(err as Error).message}` });
  }
});

// ── X402 Payment Required ───────────────────────────────────
// Descriptors can optionally require payment. The relay returns
// HTTP 402 with X-Payment-Required headers per the X402 spec.

const PAYMENT_REQUIRED_PODS = new Map<string, { amount: string; currency: string; address: string }>();

app.post('/x402/set-price', bearerVerifyLimiter, async (req, res) => {
  const { pod_url, amount, currency, address } = req.body;
  if (!pod_url || !amount || !currency || !address) {
    res.status(400).json({ error: 'pod_url, amount, currency, and address are required' });
    return;
  }
  const podUrl = await requireAuthorizedPodUrl(req, res, pod_url);
  if (!podUrl) return;
  PAYMENT_REQUIRED_PODS.set(podUrl, { amount, currency, address });
  res.json({ set: true, pod: podUrl, amount, currency });
});

app.get('/x402/price/:podName', (req, res) => {
  const podUrl = `${CSS_URL}${req.params.podName}/`;
  const price = PAYMENT_REQUIRED_PODS.get(podUrl);
  if (!price) {
    res.json({ paymentRequired: false, pod: podUrl });
  } else {
    res.status(402).json({
      paymentRequired: true,
      pod: podUrl,
...price,
      x402: {
        version: '1',
        accepts: [{ network: 'ethereum', token: price.currency, amount: price.amount, address: price.address }],
      },
    });
  }
});

// List tools
app.get('/tools', (req, res) => {
  // Mirror the MCP /mcp tools/list response so HTTP-browseable
  // introspection sees the same schemas + annotations the MCP
  // clients see. Falls back to the legacy {name, description}
  // shape for any tool that doesn't appear in TOOL_SCHEMAS.
  const schemaByName = new Map<string, typeof TOOL_SCHEMAS[number]>(
    TOOL_SCHEMAS.map(t => [t.name, t])
  );
  const base = `${req.protocol}://${req.get('host') ?? ''}`;
  const members = Object.entries(TOOLS).map(([name, { description }]) => {
    const schema = schemaByName.get(name);
    const baseSchema = schema ?? { name, description };
    // Each entry is a hydra:Resource carrying its own affordance
    // (POST to /tool/:name) so clients can navigate from the
    // catalog to an individual invocation by following links.
    return {
      '@id': `${base}/tool/${name}`,
      '@type': ['hydra:Resource', 'urn:iep:type:McpTool'],
      ...baseSchema,
      affordances: [
        {
          '@type': ['iep:Affordance', 'hydra:Operation'],
          action: `urn:iep:action:invoke:${name}`,
          target: `${base}/tool/${name}`,
          method: 'POST',
          expects: 'urn:iep:type:ToolInput',
          returns: 'urn:iep:type:ToolResult',
        },
      ],
    };
  });
  res.type('application/ld+json').json({
    '@context': KERNEL_JSONLD_CONTEXT,
    '@id': `${base}/tools`,
    '@type': ['hydra:Collection', 'urn:iep:type:McpToolCatalog'],
    conformsToShape: 'urn:iep:shape:McpToolCatalog',
    'hydra:totalItems': members.length,
    'hydra:member': members,
  });
});

// Call a tool directly via REST (auth enforced on write operations).
// Rate-limited to bound anonymous DoS surface on the PUBLIC_TOOLS path
// (paired with the AUTH_REQUIRED_TOOLS gate below for stateful tools).
const toolInvokeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.post('/tool/:name', toolInvokeLimiter, async (req, res) => {
  const toolName = req.params.name as string;
  const tool = TOOLS[toolName] ?? dynamicTools.get(toolName);
  if (!tool) {
    res.status(404).type('application/ld+json').json({
      '@context': KERNEL_JSONLD_CONTEXT,
      '@type': ['hydra:Status', 'urn:iep:error:UnknownTool'],
      error: `Unknown tool: ${toolName}`,
    });
    return;
  }

  // Auth check for write operations. Two paths accepted: OAuth bearer
  // (browser-mediated, the claude.ai/ChatGPT connector flow) OR an
  // ECDSA signed-request envelope (headless-agent flow — see
  // verifySignedRequest above). Either satisfies the gate; the
  // recovered identity is used to bind descriptor authorship.
  if (AUTH_REQUIRED_TOOLS.has(toolName)) {
    let auth: SignedAuthResult = await verifyBearerToken(req.headers.authorization);
    let viaSignature = false;
    if (!auth.authenticated) {
      // Fall back to signed-request auth.
      const sig = verifySignedRequest(req.body);
      if (sig.authenticated) {
        auth = sig;
        viaSignature = true;
        // Unwrap the signed payload into the request body so handlers
        // see the actual call args. The wrapper fields are stripped.
        try {
          const payload = JSON.parse(req.body._signed_payload as string);
          for (const k of Object.keys(payload)) {
            // Don't let the signed payload smuggle a different agent_id
            // — the recovered DID is authoritative.
            if (k === 'agent_id' || k === 'timestamp') continue;
            req.body[k] = payload[k];
          }
          delete req.body._signature;
          delete req.body._signed_payload;
        } catch { /* already validated by verifySignedRequest */ }
      }
    }
    if (!auth.authenticated) {
      res.status(401).type('application/ld+json').json({
        '@context': KERNEL_JSONLD_CONTEXT,
        '@type': ['hydra:Status', 'urn:iep:error:Unauthorized'],
        error: 'Authentication required for write operations',
        detail: auth.error,
        hint: `Two paths: (1) OAuth bearer via ${(PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '')}/authorize (browser-mediated), or (2) ECDSA signed request — POST body with { _signature: "0x...", _signed_payload: JSON.stringify({ ...args, agent_id: "did:ethr:<addr>", timestamp: <ISO 8601> }) } signed with the wallet matching agent_id.`,
        affordances: [
          {
            '@type': ['iep:Affordance', 'hydra:Operation'],
            action: 'urn:iep:action:identity:try',
            target: `${IDENTITY_URL}/try`,
            method: 'POST',
          },
          {
            '@type': ['iep:Affordance', 'hydra:Operation'],
            action: 'urn:iep:action:identity:authorize',
            target: `${(PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '')}/authorize`,
            method: 'GET',
          },
        ],
      });
      return;
    }
    // Bind authenticated identity into args.
    // OAuth bearer: inject userId-derived defaults (existing behavior).
    // Signature auth: the recovered DID IS the identity — override
    // body.agent_id even if it was supplied (prevents spoofing).
    if (viaSignature) {
      req.body.agent_id = auth.recoveredDid;
      // For pod naming, derive from the address suffix so signed
      // agents land on their own pods.
      const addr = auth.recoveredDid!.slice('did:ethr:'.length).toLowerCase();
      if (!req.body.pod_name) req.body.pod_name = `eth-${addr.slice(2, 14)}`;
      if (!req.body.owner_webid) req.body.owner_webid = auth.recoveredDid;
    } else {
      if (!req.body.agent_id) req.body.agent_id = auth.agentId;
      if (!req.body.owner_webid) req.body.owner_webid = `${IDENTITY_URL}/users/${auth.userId}/profile#me`;
      if (!req.body.pod_name) req.body.pod_name = auth.userId;
    }
    // Auto-register the authenticated participant into the directory
    // (idempotent, fire-and-forget) — REST/signed path counterpart of
    // the MCP-path hook above. Use the caller's OWN pod derived from the
    // bound identity (pod_name), NEVER req.body.pod_url — that is a
    // TARGET on tools like notify_agent / read_inbox / discover_context
    // and would mis-attribute the caller's DID to someone else's pod.
    autoRegisterAgentCard(
      req.body.pod_name ? `${CSS_URL}${req.body.pod_name}/` : undefined,
      req.body.agent_id as string | undefined,
      viaSignature ? 'signed' : undefined,
    );
  } else if (
    req.body && typeof req.body === 'object' &&
    typeof (req.body as Record<string, unknown>)._signed_payload === 'string'
  ) {
    // A signed-request envelope was sent to a NON-auth-required (read)
    // tool — e.g. verify_agent / discover_context / get_descriptor.
    // The auth-enforcement block above only unwraps the payload for
    // AUTH_REQUIRED_TOOLS, so without this branch the handler would
    // receive `{ _signature, _signed_payload }` with none of the real
    // args (pod_url, etc.), and tools that deref args.pod_url would
    // crash on undefined. Reads are public so we don't enforce auth
    // here, but we MUST unwrap the args, and we bind the recovered
    // identity when the signature checks out so a signed read can
    // default to the caller's own pod.
    const sig = verifySignedRequest(req.body);
    try {
      const payload = JSON.parse(req.body._signed_payload as string);
      for (const k of Object.keys(payload)) {
        if (k === 'agent_id' || k === 'timestamp') continue;
        req.body[k] = payload[k];
      }
    } catch { /* validated by verifySignedRequest above */ }
    if (sig.authenticated && sig.recoveredDid) {
      req.body.agent_id = sig.recoveredDid;
      const addr = sig.recoveredDid.slice('did:ethr:'.length).toLowerCase();
      if (!req.body.pod_name) req.body.pod_name = `eth-${addr.slice(2, 14)}`;
      if (!req.body.owner_webid) req.body.owner_webid = sig.recoveredDid;
    }
    delete req.body._signature;
    delete req.body._signed_payload;
  }

  try {
    const result = await tool.handler({...req.body, _req: req });
    // Hypermedia decoration: kernel-verb handlers already return
    // decorated JSON; named-shim handlers get decorated here.
    const decorated = decorateRelayShimText(toolName, result);
    let parsed: unknown;
    try { parsed = JSON.parse(decorated); } catch { parsed = decorated; }
    if (parsed && typeof parsed === 'object') {
      res.type('application/ld+json').json(parsed);
    } else {
      res.type('text/plain').send(decorated);
    }
  } catch (err) {
    res.status(500).type('application/ld+json').json({
      '@context': KERNEL_JSONLD_CONTEXT,
      '@type': ['hydra:Status', 'urn:iep:error:ToolFailure'],
      error: (err as Error).message,
    });
  }
});

// SSE endpoint for MCP-over-SSE
app.get('/sse', (req, res, next) => mcpGate(req, res, next), (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connection', tools: Object.keys(TOOLS) })}\n\n`);

  // Forward notification events
  const interval = setInterval(() => {
    if (notificationLog.length > 0) {
      const recent = notificationLog.slice(-5);
      res.write(`data: ${JSON.stringify({ type: 'notifications', events: recent })}\n\n`);
    }
  }, 2000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// ── SolidNotifications SSE — per-pod live channel ───────────
//
// GET /notifications/:podSlug
//
// Honors the syncProtocol: 'SolidNotifications' contract declared
// in every descriptor's FederationFacet. Clients connect with
// `EventSource(url)`; each `data:` event is a JSON-LD
// iep:Notification describing a descriptor lifecycle event
// (created | updated | superseded). The producer side is
// emitNotification() — called at the end of handlePublishContext
// AND from every WebSocket subscription tee, so every relay-mediated
// publish AND every upstream pod event reaches every connected client
// with zero polling tail.
//
// Auth: requires a bearer that owns or has read access to the pod
// the slug resolves to. The existing requireAuthorizedPodUrl() gate
// is reused so the authorization model is identical to /inbox.
//
// Transport hygiene:
//   - Content-Type: text/event-stream
//   - Cache-Control: no-cache
//   - Connection: keep-alive
//   - X-Accel-Buffering: no (disable nginx buffering for SSE)
//   - ': heartbeat\n\n' comment line every 30s so proxies + load
//     balancers don't close the idle TCP socket.
app.get('/notifications/:podSlug', bearerVerifyLimiter, async (req, res) => {
  const slug = String(req.params.podSlug);
  const podUrl = podSlugToUrl.get(slug);
  if (!podUrl) {
    res.status(404).json({
      error: 'unknown_pod_slug',
      detail: 'No pod is registered under this slug on this relay. Call subscribe_to_pod or publish_context first to register the pod, then reconnect.',
    });
    return;
  }

  // Reuse the existing read-auth gate: the bearer must own the pod
  // (or a subpath). This mirrors /inbox and /audit/compliance.
  const authorizedPod = await requireAuthorizedPodUrl(req, res, podUrl);
  if (!authorizedPod) return; // requireAuthorizedPodUrl already wrote the 401/403

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Register this response in the per-pod subscriber set.
  let subs = sseSubscribers.get(slug);
  if (!subs) {
    subs = new Set();
    sseSubscribers.set(slug, subs);
  }
  subs.add(res);

  // Hello event so the client confirms the channel is live.
  res.write(`data: ${JSON.stringify({
    '@context': 'https://markjspivey-xwisee.github.io/interego/ns/iep#',
    type: 'iep:NotificationChannelOpen',
    podUrl,
    pod_slug: slug,
    timestamp: new Date().toISOString(),
  })}\n\n`);

  // Heartbeat every 30s — proxy idle timeouts are typically 60-120s,
  // so 30s leaves plenty of margin while not generating measurable
  // traffic.
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      /* socket already gone — close handler will clean up */
    }
  }, 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const set = sseSubscribers.get(slug);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseSubscribers.delete(slug);
    }
  });
});

// POST /notifications/:podSlug/webhook — register an HTTP webhook URL
// so the relay can POST iep:Notification events to it in addition to
// the SSE fan-out. Bearer-gated identically to the SSE channel.
app.post('/notifications/:podSlug/webhook', bearerVerifyLimiter, express.json(), async (req, res) => {
  const slug = String(req.params.podSlug);
  const podUrl = podSlugToUrl.get(slug);
  if (!podUrl) {
    res.status(404).json({ error: 'unknown_pod_slug' });
    return;
  }
  const authorizedPod = await requireAuthorizedPodUrl(req, res, podUrl);
  if (!authorizedPod) return;
  const webhookUrl = (req.body as { url?: string } | undefined)?.url;
  if (!webhookUrl || typeof webhookUrl !== 'string') {
    res.status(400).json({ error: 'url_required', detail: 'POST body must be {"url": "https://..."}' });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    res.status(400).json({ error: 'invalid_url' });
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    res.status(400).json({ error: 'unsupported_scheme', detail: 'Only http(s) webhooks are supported.' });
    return;
  }
  let hooks = notificationWebhooks.get(podUrl);
  if (!hooks) {
    hooks = new Set();
    notificationWebhooks.set(podUrl, hooks);
  }
  hooks.add(webhookUrl);
  res.json({ registered: true, podUrl, webhook: webhookUrl, total: hooks.size });
});

// MCP JSON-RPC over POST (simplified — for tools/list and tools/call)
const messagesLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.post('/messages', messagesLimiter, async (req, res) => {
  const { method, params, id } = req.body;

  if (method === 'tools/list') {
    res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: Object.entries(TOOLS).map(([name, { description }]) => ({
          name,
          description,
          inputSchema: { type: 'object', properties: {} },
        })),
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const tool = TOOLS[toolName] ?? dynamicTools.get(toolName);
    if (!tool) {
      res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
      return;
    }

    const args: Record<string, unknown> = { ...(params?.arguments ?? {}) };
    if (AUTH_REQUIRED_TOOLS.has(toolName)) {
      // Same dual-path auth as /tool/:name: OAuth bearer OR ECDSA
      // signed-request envelope. See verifySignedRequest for the
      // headless-agent flow rationale.
      let auth: SignedAuthResult = await verifyBearerToken(req.headers.authorization);
      let viaSignature = false;
      if (!auth.authenticated) {
        const sig = verifySignedRequest(args);
        if (sig.authenticated) {
          auth = sig;
          viaSignature = true;
          try {
            const payload = JSON.parse(args._signed_payload as string);
            for (const k of Object.keys(payload)) {
              if (k === 'agent_id' || k === 'timestamp') continue;
              args[k] = payload[k];
            }
            delete args._signature;
            delete args._signed_payload;
          } catch { /* already validated */ }
        }
      }
      if (!auth.authenticated) {
        res.status(401).json({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: 'Authentication required for write operations',
            data: {
              detail: auth.error,
              hint: `Two paths: (1) OAuth bearer via ${(PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '')}/authorize, or (2) ECDSA signed request — args.{_signature, _signed_payload}, signedPayload JSON with agent_id (did:ethr:<addr>) + timestamp (±60s).`,
            },
          },
        });
        return;
      }
      if (viaSignature) {
        args.agent_id = auth.recoveredDid;
        const addr = auth.recoveredDid!.slice('did:ethr:'.length).toLowerCase();
        if (!args.pod_name) args.pod_name = `eth-${addr.slice(2, 14)}`;
        if (!args.owner_webid) args.owner_webid = auth.recoveredDid;
      } else {
        if (!args.agent_id) args.agent_id = auth.agentId;
        if (!args.owner_webid) args.owner_webid = `${IDENTITY_URL}/users/${auth.userId}/profile#me`;
        if (!args.pod_name) args.pod_name = auth.userId;
      }
    }

    try {
      const result = await tool.handler(args);
      // Attach structuredContent on this (legacy /messages) transport too,
      // through the same chokepoint as /mcp — so a strict client on either
      // transport gets schema-conformant, null-stripped structured output.
      // Without this the /messages path advertises outputSchema (via
      // tools/list) but emits no structuredContent (the original
      // f-structuredcontent gap) — and any structuredContent it did emit
      // would hit f-schema-nullability. toStructuredContent runs omitNullish.
      res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result }], structuredContent: toStructuredContent(result) } });
    } catch (err) {
      res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: (err as Error).message } });
    }
    return;
  }

  res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});

// ── MCP Streamable HTTP Endpoint (/mcp) ─────────────────────
// This is the real MCP transport — what claude.ai custom connectors and
// any modern MCP client will use. Handles initialize + tools/list + tools/call
// with proper JSON-RPC framing and SSE streaming.

// Extract the auth context for this request. Three valid paths:
//   1. req.auth populated by requireBearerAuth (OAuth token verified by provider)
//   2. Authorization: Bearer <RELAY_MCP_API_KEY> (legacy API key, for curl/scripts)
//   3. Unauthenticated (if RELAY_MCP_API_KEY unset AND no OAuth token) — open mode
function resolveAuthContext(req: express.Request): { agentId: string; ownerWebId: string; userId: string; podUrl?: string; identityToken?: string; oauthScopes?: readonly string[]; accessToken?: string } | null {
  // OAuth-verified request: bearerAuth middleware already set req.auth
  const reqAuth = (req as express.Request & { auth?: { token?: string; scopes?: string[]; extra?: { agentId?: string; ownerWebId?: string; userId?: string; podUrl?: string; identityToken?: string } } }).auth;
  if (reqAuth?.extra?.agentId && reqAuth.extra.ownerWebId && reqAuth.extra.userId) {
    return {
      agentId: reqAuth.extra.agentId,
      ownerWebId: reqAuth.extra.ownerWebId,
      userId: reqAuth.extra.userId,
      // Thread the identity-server-provided podUrl through. Today identity
      // derives it from userId so this is equivalent to ${CSS_URL}${userId}/,
      // but when identity layer adds preferred-pod overlays (e.g. one user
      // with two credentials sharing one canonical pod), the relay must
      // honor the authoritative podUrl — not silently reconstruct from userId.
      ...(reqAuth.extra.podUrl ? { podUrl: reqAuth.extra.podUrl } : {}),
      // Thread the identity-server-issued bearer token through so handlers
      // (e.g. handleGetPodStatus) can fetch the calling user's display
      // name + primary-agent DID from IDENTITY_URL/me without another
      // auth hop.
      ...(reqAuth.extra.identityToken ? { identityToken: reqAuth.extra.identityToken } : {}),
      // FIX D — thread the OAuth scope claim through so the per-tool
      // write gate in buildMcpServer's CallToolRequest handler can
      // refuse write tools when the bearer was issued with `mcp:read`
      // only. Only OAuth-issued bearers carry scopes; the legacy
      // API-key path below produces no oauthScopes field, so write
      // tools remain accessible via that path (unchanged behavior).
      ...(Array.isArray(reqAuth.scopes) ? { oauthScopes: reqAuth.scopes } : {}),
      // Raw OAuth access token — the exact bearer the MCP client presented (raw,
      // never a sha). Threaded so the AMEP same-origin session bridge can reuse
      // it for POST /amep/acts (see withAmepSession). OAuth branch only; the
      // legacy API-key path below never carries one, so no auto-forward there.
      ...(reqAuth.token ? { accessToken: reqAuth.token } : {}),
    };
  }
  // Legacy API-key path: Authorization: Bearer <RELAY_MCP_API_KEY>
  const legacy = checkMcpApiKey(req);
  if (legacy.ok && legacy.authContext) return legacy.authContext;
  return null;
}

async function handleMcp(req: express.Request, res: express.Response): Promise<void> {
  const authContext = resolveAuthContext(req);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildMcpServer(authContext);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, (req as express.Request & { body?: unknown }).body);
  } catch (err) {
    log(`[/mcp] transport error: ${(err as Error).message}`);
    if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
  } finally {
    await server.close().catch(() => {});
  }
}

// Bearer-auth middleware for the OAuth path. Requires 'mcp' scope on the
// token. When a request arrives WITHOUT an Authorization header, the
// middleware returns 401 with a WWW-Authenticate header that points MCP
// clients at the OAuth discovery metadata — so claude.ai can discover the
// authorization server and kick off the DCR + code+PKCE flow.
const resourceMetadataUrl = PUBLIC_BASE_URL
  ? `${PUBLIC_BASE_URL.replace(/\/$/, '')}/.well-known/oauth-protected-resource`
  : undefined;

// FIX D — the SDK's `requireBearerAuth` middleware enforces an
// INTERSECTION semantics on `requiredScopes` (every listed scope must
// be present on the bearer). Hard-coding `['mcp']` here would refuse a
// bearer issued with `mcp:read` only, defeating the read-scope path.
// We pass no required scopes to the SDK middleware and instead enforce
// the "any of {mcp, mcp:read, mcp:write}" rule ourselves in the
// `oauthDpopOrBearer` Case 3 branch below (and in Case 1 / DPoP
// already). The SDK middleware still handles the 401 + discovery
// WWW-Authenticate header on missing/invalid tokens — that behavior
// is unchanged.
const oauthBearer = requireBearerAuth({
  verifier: oauthProvider,
  requiredScopes: [],
  ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
});

/**
 * Build a `WWW-Authenticate: DPoP ...` header value. RFC 9449 §7.1.
 */
function dpopWwwAuth(errorCode: string, description: string): string {
  let h = `DPoP error="${errorCode}", error_description="${description.replace(/"/g, "'")}"`;
  h += `, algs="${'ES256 EdDSA'}"`;
  if (resourceMetadataUrl) h += `, resource_metadata="${resourceMetadataUrl}"`;
  return h;
}

/**
 * DPoP-aware auth middleware for /mcp.
 *
 * Decision tree:
 *   1. `Authorization: DPoP <token>` + `DPoP: <jwt>`
 *      → Validate DPoP proof (htm/htu/iat/jti/sig + ath = sha256(token)),
 *        verify access-token cnf.jkt matches the proof's JWK thumbprint.
 *   2. `Authorization: Bearer <token>` AND token has `cnf.jkt`
 *      → Reject: this token is DPoP-bound and MUST be presented with a
 *        DPoP proof. 401 DPoP error="invalid_token".
 *   3. `Authorization: Bearer <token>` AND token has no `cnf.jkt` AND
 *      RELAY_REQUIRE_DPOP=false
 *      → Accept (legacy Bearer path).
 *   4. `Authorization: Bearer <token>` AND no `cnf.jkt` AND
 *      RELAY_REQUIRE_DPOP=true
 *      → Reject: 401 DPoP error="invalid_token",
 *        error_description="DPoP required by this resource".
 *   5. No Authorization header
 *      → SDK's requireBearerAuth's behavior: 401 with WWW-Authenticate
 *        pointing at the discovery metadata.
 *
 * The SDK's requireBearerAuth handles case 5 for us; we delegate to it
 * after handling cases 1-4. This keeps the OAuth-discovery WWW-Authenticate
 * response untouched for fresh clients.
 */
const oauthDpopOrBearer: express.RequestHandler = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    // No Authorization header at all → fall through to the SDK bearer
    // middleware, which emits the canonical OAuth discovery 401.
    oauthBearer(req, res, next);
    return;
  }
  const spaceIdx = authHeader.indexOf(' ');
  const scheme = spaceIdx > 0 ? authHeader.slice(0, spaceIdx) : authHeader;
  const token = spaceIdx > 0 ? authHeader.slice(spaceIdx + 1).trim() : '';
  const schemeLower = scheme.toLowerCase();

  // ── Case 1: DPoP scheme ──
  if (schemeLower === 'dpop') {
    const dpopHeader = req.headers['dpop'];
    if (!dpopHeader || typeof dpopHeader !== 'string') {
      res.set('WWW-Authenticate', dpopWwwAuth('invalid_request', 'Missing DPoP header'));
      res.status(401).json({ error: 'invalid_request', error_description: 'Missing DPoP header' });
      return;
    }
    if (!token) {
      res.set('WWW-Authenticate', dpopWwwAuth('invalid_token', 'Missing access token'));
      res.status(401).json({ error: 'invalid_token', error_description: 'Missing access token' });
      return;
    }
    // Verify the access token first so we have the bound jkt to check against.
    let authInfo: Awaited<ReturnType<typeof oauthProvider.verifyAccessToken>>;
    try {
      authInfo = await oauthProvider.verifyAccessToken(token);
    } catch (err) {
      const msg = (err as Error).message;
      res.set('WWW-Authenticate', dpopWwwAuth('invalid_token', msg));
      res.status(401).json({ error: 'invalid_token', error_description: msg });
      return;
    }
    // DPoP proof validation.
    try {
      const htu = reconstructRequestUrl(req);
      const { jkt } = await validateDpopJwt(dpopHeader, {
        htm: req.method,
        htu,
        ath: athFromAccessToken(token),
      });
      // Verify token-key binding (cnf.jkt MUST match the proof JWK).
      const tokenCnf = (authInfo as { extra?: { cnf?: { jkt?: string } } }).extra?.cnf;
      if (!tokenCnf?.jkt) {
        res.set('WWW-Authenticate', dpopWwwAuth('invalid_token', 'Access token is not DPoP-bound'));
        res.status(401).json({ error: 'invalid_token', error_description: 'Access token is not DPoP-bound' });
        return;
      }
      if (tokenCnf.jkt !== jkt) {
        res.set('WWW-Authenticate', dpopWwwAuth('invalid_token', 'DPoP key thumbprint does not match cnf.jkt'));
        res.status(401).json({ error: 'invalid_token', error_description: 'DPoP key thumbprint does not match cnf.jkt' });
        return;
      }
      // Scope + expiry checks mirror requireBearerAuth.
      // Resource access (any /mcp call): any of `mcp`, `mcp:read`, or
      // `mcp:write` is sufficient. The read/write SPLIT is enforced
      // per-tool downstream — see WRITE_SIDE_OAUTH_SCOPES + the
      // per-tool gate in buildMcpServer, which refuses write tools when
      // the bearer carries `mcp:read` only.
      if (!hasAnyMcpScope(authInfo.scopes)) {
        res.set('WWW-Authenticate', dpopWwwAuth('insufficient_scope', 'Required scope: mcp (or mcp:read / mcp:write)'));
        res.status(403).json({ error: 'insufficient_scope', error_description: 'Required scope: mcp (or mcp:read / mcp:write)' });
        return;
      }
      if (typeof authInfo.expiresAt !== 'number' || authInfo.expiresAt < Date.now() / 1000) {
        res.set('WWW-Authenticate', dpopWwwAuth('invalid_token', 'Token expired or missing expiry'));
        res.status(401).json({ error: 'invalid_token', error_description: 'Token expired or missing expiry' });
        return;
      }
      (req as express.Request & { auth?: unknown }).auth = authInfo;
      next();
      return;
    } catch (err) {
      const msg = (err as Error).message;
      res.set('WWW-Authenticate', dpopWwwAuth('invalid_dpop_proof', msg));
      res.status(401).json({ error: 'invalid_dpop_proof', error_description: msg });
      return;
    }
  }

  // ── Cases 2-4: Bearer scheme ──
  if (schemeLower === 'bearer') {
    // Inspect the token's cnf.jkt before deciding. If the token was
    // issued as DPoP-bound, the client MUST present it as DPoP.
    let authInfo: Awaited<ReturnType<typeof oauthProvider.verifyAccessToken>> | undefined;
    try {
      authInfo = await oauthProvider.verifyAccessToken(token);
    } catch {
      // Token didn't verify locally — could be the legacy RELAY_MCP_API_KEY
      // or just garbage. Fall through to oauthBearer which will surface
      // the right 401.
      oauthBearer(req, res, next);
      return;
    }
    const tokenCnf = (authInfo as { extra?: { cnf?: { jkt?: string } } }).extra?.cnf;
    if (tokenCnf?.jkt) {
      // Case 2: DPoP-bound token presented as Bearer.
      res.set('WWW-Authenticate', dpopWwwAuth('invalid_token', 'Access token is DPoP-bound; use Authorization: DPoP'));
      res.status(401).json({ error: 'invalid_token', error_description: 'Access token is DPoP-bound; use Authorization: DPoP' });
      return;
    }
    if (RELAY_REQUIRE_DPOP) {
      // Case 4: hard-require DPoP.
      res.set('WWW-Authenticate', dpopWwwAuth('invalid_token', 'DPoP required by this resource'));
      res.status(401).json({ error: 'invalid_token', error_description: 'DPoP required by this resource' });
      return;
    }
    // Case 3: legacy unbound Bearer — accept. Delegate to oauthBearer
    // for the expiry checks + req.auth population (it re-verifies the
    // token, harmless). After it succeeds we enforce the "any mcp*
    // scope" rule ourselves — see comment on `oauthBearer` above for
    // why we don't push the scope check into the SDK middleware.
    oauthBearer(req, res, () => {
      const rAuth = (req as express.Request & { auth?: { scopes?: string[] } }).auth;
      if (!hasAnyMcpScope(rAuth?.scopes)) {
        res.set('WWW-Authenticate', dpopWwwAuth('insufficient_scope', 'Required scope: mcp (or mcp:read / mcp:write)'));
        res.status(403).json({ error: 'insufficient_scope', error_description: 'Required scope: mcp (or mcp:read / mcp:write)' });
        return;
      }
      next();
    });
    return;
  }

  // Unknown scheme.
  res.set('WWW-Authenticate', dpopWwwAuth('invalid_request', `Unsupported auth scheme: ${scheme}`));
  res.status(401).json({ error: 'invalid_request', error_description: `Unsupported auth scheme: ${scheme}` });
};

// Custom /mcp gate: if the request has an Authorization header starting with
// the legacy API key, short-circuit past OAuth. Otherwise run the DPoP-aware
// OAuth middleware, which will either validate the token (DPoP or Bearer)
// or return 401 with proper WWW-Authenticate so clients know how to retry.
const mcpGate: express.RequestHandler = (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && RELAY_MCP_API_KEY) {
    const token = auth.slice(7).trim();
    if (safeEqual(token, RELAY_MCP_API_KEY)) {
      // Legacy API key — skip OAuth, handleMcp will pick up via resolveAuthContext
      next();
      return;
    }
  }
  oauthDpopOrBearer(req, res, next);
};

app.post('/mcp', mcpGate, handleMcp);
app.get('/mcp', mcpGate, handleMcp);
app.delete('/mcp', mcpGate, handleMcp);

// ── Start ───────────────────────────────────────────────────

// Compute fingerprints (sha256 prefix) for sensitive material we
// hold in memory so the operator can confirm at startup that the
// expected key/secret was loaded — without ever logging the secret
// itself. SOC 2 CC6.7 evidence ("we know what's running") without
// SOC 2 CC6.7 violation ("we logged the secret in plaintext").
function fingerprint(material: string): string {
  if (!material) return '<unset>';
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

app.listen(PORT, () => {
  log(`MCP Relay started on port ${PORT}`);
  log(`CSS: ${CSS_URL}`);
  log(`/mcp auth: OAuth 2.1 + DPoP (RFC 9449, Solid OIDC) + legacy Bearer <RELAY_MCP_API_KEY> fallback (${RELAY_MCP_API_KEY ? `enabled fp=${fingerprint(RELAY_MCP_API_KEY)}` : 'disabled — OAuth-only'})`);
  log(`DPoP: enforced=${RELAY_REQUIRE_DPOP} algs=${DPOP_SIGNING_ALGS.join(',')}`);
  if (!RELAY_MCP_API_KEY && !PUBLIC_BASE_URL) {
    log(`[startup-warn] Neither RELAY_MCP_API_KEY nor PUBLIC_BASE_URL is set. Local OAuth will work, but no remote MCP client can connect.`);
  }
  log(`OAuth issuer: ${PUBLIC_BASE_URL || `http://localhost:${PORT}`}`);
  log(`Identity server: ${IDENTITY_URL}`);
  log(`Relay agent key fingerprint (X25519 public): ${fingerprint(relayAgentKey.publicKey)}`);
  log(`CDP API key: ${ORG_CDP_API_KEY_NAME ? `name=${ORG_CDP_API_KEY_NAME} priv-fp=${fingerprint(ORG_CDP_API_KEY_PRIVATE)}` : '<unset>'}`);
  // Startup banner: be explicit about whether IPFS pinning is actually
  // active. A `local-unpinned` provider means we compute CIDs but DO NOT
  // upload — operators should know this on boot, not discover it after
  // their first publish.
  if (ORG_IPFS_PROVIDER === 'local-unpinned') {
    log(`IPFS: local-unpinned (CIDs are computed but NOT retrievable from public gateways; set PINATA_API_KEY or WEB3STORAGE_TOKEN to enable pinning)`);
  } else {
    log(`IPFS: ${ORG_IPFS_PROVIDER} (active) api-key-fp=${fingerprint(ORG_IPFS_API_KEY)}`);
  }
  log(`Endpoints:`);
  log(`  GET  /health                                  Health check`);
  log(`  GET  /tools  |  POST /tool/:name              REST convenience`);
  log(`  POST /mcp                                     MCP Streamable HTTP (OAuth-gated)`);
  log(`  GET  /.well-known/oauth-authorization-server  OAuth metadata`);
  log(`  GET  /.well-known/oauth-protected-resource    Resource metadata`);
  log(`  GET  /.well-known/operations                  Substrate-operation catalog`);
  log(`  */authorize /token /register /revoke           OAuth endpoints (SDK)`);
  log(`  GET  /amep  |  POST /amep/acts                 AMEP engine (reference impl)`);
});

// ── Seed the AMEP release-42 exchange (best-effort, after listen) ────
// Runs post-listen so it never blocks the health probe. Create-only: skips if
// the exchange already exists. Requires a warmed maintainer pod.
void (async () => {
  try {
    await seedRelease42(amepDeps);
  } catch (e) {
    log(`[amep] seed skipped: ${(e as Error).message}`);
  }
})();

// ── One-shot store hygiene (env-gated, background, after listen) ─────
//
// Set RELAY_PRUNE_DEAD_CLIENTS=1 for a single deploy to clean the
// svc-relay-dcr pod. Runs AFTER app.listen so it never blocks the
// health probe, and only when explicitly enabled.
//
// Two passes, both safe for active connectors:
//   1. Dead client descriptors. Observed: 336 oauth-client-*.ttl files
//      on the pod but only a handful tracked in the manifest — every
//      connector add / re-add / test registration is a permanent file
//      and nothing ever GC'd them (removeClient existed but was never
//      wired). We delete a client file iff its client_id is NOT in the
//      boot-loaded map AND has NO live refresh token AND the file is
//      older than a 1h grace window. Live connectors (johnny et al.)
//      keep a live refresh token, so they are never touched. The
//      read-through getClient added alongside this means a kept-but-
//      manifest-orphaned client still authenticates.
//   2. Duplicate refresh tokens. Every authorization mints a new refresh
//      token; the old ones linger until their 14d expiry (loadRefreshTokens
//      already drops expired ones, so all 115 loaded are live — they're
//      stale DUPLICATES from repeated re-auth of the same client, not
//      expired). A connector only ever presents its newest. We keep the
//      newest (max expiresAt) per client_id and delete the rest, which
//      is what actually shrinks the slow refresh-token boot load.
if ((process.env['RELAY_PRUNE_DEAD_CLIENTS'] ?? '').trim() === '1') {
  void (async () => {
    try {
      const now = Date.now();
      const GRACE_MS = 60 * 60 * 1000;

      // The live client_ids are exactly those carrying a refresh token
      // (loadRefreshTokens already dropped expired ones, so all loaded
      // are live). These accumulated because every connector re-add
      // mints a NEW client_id + refresh token and nothing supersedes the
      // old one. Read each live client's identity (name + redirect_uris)
      // and keep only the NEWEST registration per identity; the older
      // ones are abandoned re-adds the connector no longer presents.
      const liveClientIds = new Set<string>();
      for (const rec of _oauthInitialRefreshTokensBySha.values()) {
        if (rec.expiresAt > now) liveClientIds.add(rec.clientId);
      }
      log(`[prune] start. live clientIds (have refresh token)=${liveClientIds.size}, manifest=${_oauthInitialClients.size}`);

      // identity key -> [{ clientId, issuedAt }]
      const groups = new Map<string, Array<{ clientId: string; issuedAt: number }>>();
      const ungrouped: string[] = []; // couldn't read identity — keep, never prune
      await Promise.allSettled([...liveClientIds].map(async clientId => {
        const c = await loadOneOAuthClient(clientId, oauthStoreCfg);
        if (!c) { ungrouped.push(clientId); return; }
        const key = `${c.client_name ?? '(none)'}|${(c.redirect_uris ?? []).slice().sort().join(',')}`;
        const issuedAt = typeof c.client_id_issued_at === 'number' ? c.client_id_issued_at : 0;
        const arr = groups.get(key) ?? [];
        arr.push({ clientId, issuedAt });
        groups.set(key, arr);
      }));

      // keep = manifest clients + newest-per-identity + any unreadable.
      const keep = new Set<string>(_oauthInitialClients.keys());
      for (const id of ungrouped) keep.add(id);
      const superseded = new Set<string>();
      for (const [key, arr] of groups.entries()) {
        arr.sort((a, b) => b.issuedAt - a.issuedAt); // newest first
        keep.add(arr[0]!.clientId);
        for (let i = 1; i < arr.length; i++) superseded.add(arr[i]!.clientId);
        if (arr.length > 1) log(`[prune] identity "${key}": ${arr.length} registrations, keep ${arr[0]!.clientId}, supersede ${arr.length - 1}`);
      }
      log(`[prune] identities=${groups.size} keep=${keep.size} superseded=${superseded.size} unreadable=${ungrouped.length}`);

      // Delete superseded clients' refresh tokens — this is what shrinks
      // the slow refresh-token boot load.
      let removedRefresh = 0;
      for (const [sha, rec] of _oauthInitialRefreshTokensBySha.entries()) {
        if (superseded.has(rec.clientId)) {
          try { await removeOAuthRefreshToken(sha, oauthTokenStoreCfg); removedRefresh++; }
          catch { /* best effort */ }
        }
      }

      // Delete client descriptor files that are superseded OR dead
      // (no live refresh token, not in manifest) and older than grace.
      const files = await listOAuthClientFilesOnPod(oauthStoreCfg);
      let removedSuperseded = 0, removedDead = 0, keptRecent = 0;
      for (const f of files) {
        if (keep.has(f.clientId)) continue;
        if (now - f.modifiedMs < GRACE_MS) { keptRecent++; continue; }
        try {
          await removeOAuthClient(f.clientId, oauthStoreCfg);
          if (superseded.has(f.clientId)) removedSuperseded++; else removedDead++;
        } catch (err) { log(`[prune] removeClient(${f.clientId}) failed: ${(err as Error).message}`); }
      }
      log(`[prune] DONE. refreshTokensRemoved=${removedRefresh} clientFilesOnPod=${files.length} removedSuperseded=${removedSuperseded} removedDead=${removedDead} keptRecent=${keptRecent} kept=${keep.size}`);
    } catch (err) {
      log(`[prune] aborted: ${(err as Error).message}`);
    }
  })();
}
