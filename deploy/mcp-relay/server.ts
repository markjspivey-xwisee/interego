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
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
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
  saveClient as saveOAuthClient,
  resolveMaintainerPodUrl as resolveOAuthStorePodUrl,
  relayDidFromAddress,
  type OAuthClientStoreConfig,
} from './oauth-client-store.js';
import {
  loadAccessTokens as loadOAuthAccessTokens,
  loadRefreshTokens as loadOAuthRefreshTokens,
  loadAccessTokenByRaw as loadOAuthAccessTokenByRaw,
  persistAccessToken as persistOAuthAccessToken,
  persistRefreshToken as persistOAuthRefreshToken,
  removeAccessToken as removeOAuthAccessToken,
  removeRefreshToken as removeOAuthRefreshToken,
  type OAuthTokenStoreConfig,
} from './oauth-token-store.js';
import {
  validateDpopJwt,
  athFromAccessToken,
  reconstructRequestUrl,
} from './dpop.js';
import { corsMiddleware } from './cors-allowlist.js';

// Substrate kernel + model + crypto + sparql + RDF + HTTP — `@interego/core`.
import {
  addAuthorizedAgent,
  compose as kernelCompose,
  ContextDescriptor,
  createDelegationCredential,
  createOwnerProfile,
  cryptoComputeCid,
  decompose as kernelDecompose,
  decorateKernelResult,
  decorateShim,
  dereference as kernelDereference,
  type EncryptionKeyPair,
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
  pinToIpfs,
  promote as kernelPromote,
  removeAuthorizedAgent,
  restrict as kernelRestrict,
  signDescriptor,
  type SignedDescriptor,
  toTurtle,
  validate,
  verifyDescriptorSignature,
} from '@interego/core';
import {
  buildAccessChangeEvent,
} from '@interego/ops';

import type {
  ContextDescriptorData,
  FetchFn,
  IRI,
  ManifestEntry,
  OwnerProfileData,
  PodDirectoryData,
  PodDirectoryEntry,
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
  subscribe,
  writeAgentRegistry,
  readAgentRegistry,
  writeDelegationCredential,
  verifyAgentDelegation,
  fetchPodDirectory,
  publishPodDirectory,
  resolveWebFinger,
  fetchGraphContent,
  resolveRecipients,
  parseDistributionFromDescriptorTurtle,
  predictDescriptorUrl,
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

// ── Config ──────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8080');
const CSS_URL = process.env['CSS_URL'] ?? 'http://localhost:3456/';
const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:8090';

// OAuth 2.1 auth config for /mcp. This is the real auth path used by
// claude.ai custom connectors and any MCP client that speaks OAuth.
// RELAY_MCP_API_KEY still works as a legacy fallback for tooling that can
// set an Authorization header directly (local curl, scripts).
const RELAY_MCP_API_KEY = process.env['RELAY_MCP_API_KEY'] ?? '';

// Public base URL of THIS relay (used as the OAuth issuer + resource URL).
// Must be set in production so the OAuth metadata advertises the correct
// externally-reachable URL. Falls back to constructing from request host.
const PUBLIC_BASE_URL = process.env['PUBLIC_BASE_URL'] ?? '';

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

// Org-level IPFS/CDP keys — used as defaults when users don't provide their own
const ORG_IPFS_PROVIDER = (process.env['IPFS_PROVIDER'] ?? 'local') as 'pinata' | 'web3storage' | 'local';
const ORG_IPFS_API_KEY = process.env['IPFS_API_KEY'] ?? '';
const ORG_CDP_API_KEY_NAME = process.env['CDP_API_KEY_NAME'] ?? '';
const ORG_CDP_API_KEY_PRIVATE = process.env['CDP_API_KEY_PRIVATE'] ?? '';

/**
 * Resolve IPFS config: user override (from request headers) > org default > local
 */
function resolveIpfsConfig(req: any): { provider: 'pinata' | 'web3storage' | 'local'; apiKey: string } {
  const userProvider = req.headers?.['x-ipfs-provider'] as string | undefined;
  const userKey = req.headers?.['x-ipfs-api-key'] as string | undefined;

  if (userProvider && userKey) {
    return { provider: userProvider as any, apiKey: userKey };
  }
  return { provider: ORG_IPFS_PROVIDER, apiKey: ORG_IPFS_API_KEY };
}

function log(msg: string): void {
  console.log(`[mcp-relay] ${msg}`);
}

// ── Auth Middleware ──────────────────────────────────────────

// Tools that require authentication (write operations)
const AUTH_REQUIRED_TOOLS = new Set([
  'publish_context', 'register_agent', 'revoke_agent',
  'publish_directory',
]);

// Tools that are public (read operations)
const PUBLIC_TOOLS = new Set([
  'discover_context', 'get_descriptor', 'get_pod_status',
  'subscribe_to_pod', 'discover_all', 'list_known_pods',
  'add_pod', 'remove_pod', 'discover_directory', 'resolve_webfinger',
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

// ── Fetch wrapper ───────────────────────────────────────────

const solidFetch: FetchFn = async (url, init) => {
  const resp = await fetch(url, init as RequestInit);
  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    headers: { get: (n: string) => resp.headers.get(n) },
    text: () => resp.text(),
    json: () => resp.json(),
  };
};

// ── State ───────────────────────────────────────────────────

let subscriptions: Map<string, Subscription> = new Map();
let notificationLog: ContextChangeEvent[] = [];

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
// behalf of the authenticated mobile agent. Persisted to disk so container
// restarts preserve the same identity (matters for recipient membership on
// previously-encrypted envelopes). Generated fresh on first run.
const RELAY_AGENT_KEY_FILE = process.env['RELAY_AGENT_KEY_FILE'] ?? '/app/relay-agent-key.json';
const relayAgentKey: EncryptionKeyPair = (() => {
  // If the file exists, it MUST be loadable. Silently regenerating
  // on parse failure would mint a new identity and orphan every
  // previously-encrypted envelope keyed to the old public key.
  // Better to fail fast and let the operator restore from backup.
  if (existsSync(RELAY_AGENT_KEY_FILE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(RELAY_AGENT_KEY_FILE, 'utf8'));
    } catch (err) {
      throw new Error(
        `RELAY_AGENT_KEY_FILE (${RELAY_AGENT_KEY_FILE}) exists but is not valid JSON: ${(err as Error).message}. ` +
        `Restore from backup or move the file aside to mint a new identity.`,
      );
    }
    const p = parsed as Partial<EncryptionKeyPair>;
    if (p?.publicKey && p?.secretKey && p?.algorithm === 'X25519-XSalsa20-Poly1305') {
      return p as EncryptionKeyPair;
    }
    throw new Error(
      `RELAY_AGENT_KEY_FILE (${RELAY_AGENT_KEY_FILE}) is missing required fields ` +
      `(publicKey + secretKey + algorithm=X25519-XSalsa20-Poly1305). ` +
      `Restore from backup or move the file aside to mint a new identity.`,
    );
  }
  const kp = generateKeyPair();
  try {
    writeFileSync(RELAY_AGENT_KEY_FILE, JSON.stringify(kp, null, 2), { mode: 0o600 });
  } catch (err) {
    log(`[startup-warn] Could not persist relay agent key to ${RELAY_AGENT_KEY_FILE}: ${(err as Error).message}. ` +
        `Identity will reset on next restart, orphaning any envelopes encrypted this session.`);
  }
  return kp;
})();

// ECDSA wallet for compliance-grade descriptor signing. Persisted next
// to the X25519 envelope key. Loaded lazily on first compliance publish.
const RELAY_COMPLIANCE_WALLET_FILE = process.env['RELAY_COMPLIANCE_WALLET_FILE']
  ?? RELAY_AGENT_KEY_FILE.replace(/\.json$/, '-ecdsa.json');
let _relayComplianceWallet: PersistedComplianceWallet | null = null;
async function ensureRelayComplianceWallet(): Promise<PersistedComplianceWallet> {
  if (_relayComplianceWallet) return _relayComplianceWallet;
  _relayComplianceWallet = await loadOrCreateComplianceWallet(
    RELAY_COMPLIANCE_WALLET_FILE,
    'relay-compliance-signer',
  );
  return _relayComplianceWallet;
}

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
};
const _oauthInitialAccessTokensBySha = await loadOAuthAccessTokens(oauthTokenStoreCfg);
const _oauthInitialRefreshTokensBySha = await loadOAuthRefreshTokens(oauthTokenStoreCfg);
log(`OAuth token store: pod=${oauthStorePodUrl} access=${_oauthInitialAccessTokensBySha.size} refresh=${_oauthInitialRefreshTokensBySha.size}`);

oauthProvider = new InteregoOAuthProvider({
  identityUrl: IDENTITY_URL,
  tokenTtlSec: 3600,
  initialClients: _oauthInitialClients,
  persistClient: (client_id, client_data) =>
    saveOAuthClient(client_id, client_data, oauthStoreCfg),
  initialAccessTokensBySha: _oauthInitialAccessTokensBySha,
  initialRefreshTokensBySha: _oauthInitialRefreshTokensBySha,
  persistAccessToken: (token, info) => persistOAuthAccessToken(token, info, oauthTokenStoreCfg),
  persistRefreshToken: (refreshToken, rec) => persistOAuthRefreshToken(refreshToken, rec, oauthTokenStoreCfg),
  removeAccessToken: (sha) => removeOAuthAccessToken(sha, oauthTokenStoreCfg),
  removeRefreshToken: (sha) => removeOAuthRefreshToken(sha, oauthTokenStoreCfg),
  lookupAccessTokenByRaw: (token) => loadOAuthAccessTokenByRaw(token, oauthTokenStoreCfg),
  log: (msg: string) => log(msg),
});

// ── Tool Handlers ───────────────────────────────────────────

type ToolArgs = Record<string, unknown>;

async function handlePublishContext(args: ToolArgs): Promise<string> {
  const podName = (args.pod_name as string) ?? 'default';
  const podUrl = `${CSS_URL}${podName}/`;
  const agentId = (args.agent_id as string) ?? 'urn:agent:remote:unknown';
  const ownerWebId = (args.owner_webid as string) ?? `https://id.example.com/${podName}/profile#me`;
  const descId = (args.descriptor_id as string ?? `urn:cg:${podName}:${Date.now()}`) as IRI;
  const now = new Date().toISOString();

  // Ensure pod container exists
  await solidFetch(podUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
    body: '',
  });

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
  const priorVersions: IRI[] = [];
  if (args.auto_supersede_prior !== false) {
    try {
      const entries = await discover(podUrl, undefined, { fetch: solidFetch });
      for (const e of entries) {
        if (e.describes.includes((args.graph_iri as string) as IRI) && e.descriptorUrl !== descId) {
          priorVersions.push(e.descriptorUrl as IRI);
        }
      }
    } catch {
      // Manifest not yet present, or pod unreachable — proceed without supersedes.
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
      const baseTrust = {
        // Compliance grade upgrades to HighAssurance per spec.
        trustLevel: (args.compliance === true ? 'CryptographicallyVerified' : 'SelfAsserted') as 'CryptographicallyVerified' | 'SelfAsserted',
        issuer: ownerWebId as IRI,
      };
      if (args.compliance !== true) return baseTrust;
      // Pre-compute the sig URL so cg:proof can be embedded in the
      // Turtle BEFORE signing. Verifies against tampering: if anyone
      // edits cg:proof in transit the signature won't validate.
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

  // Ensure the calling agent is registered on this pod with the relay's
  // encryption public key. Three cases:
  //   1. No registry yet        -> create profile + register this agent
  //   2. Registry present, this agent missing   -> register it (auto-provision)
  //   3. Agent present but encryption key stale -> patch the key
  // Without (1) and (2), OAuth clients whose agent identity wasn't already on
  // the pod would silently piggyback on whatever agent *was* registered,
  // breaking per-agent attribution and recipient-set growth. After this
  // block, every new OAuth-authenticated session adds its own did:web agent
  // with its own X25519 key as a first-class authorized agent on the pod.
  try {
    let profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
    if (!profile) {
      profile = createOwnerProfile(ownerWebId as IRI, args.owner_name as string | undefined);
    }
    const me = profile.authorizedAgents.find(a => a.agentId === agentId && !a.revoked);
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
      await writeAgentRegistry(profile, podUrl, { fetch: solidFetch });
      try {
        const newAgent = profile.authorizedAgents.find(a => a.agentId === agentId)!;
        const credential = createDelegationCredential(profile, newAgent, podUrl as IRI);
        await writeDelegationCredential(credential, podUrl, { fetch: solidFetch });
      } catch { /* delegation credential is nice-to-have; registry is authoritative */ }
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
    }
  } catch (err) {
    log(`WARN: could not ensure agent registration: ${(err as Error).message}`);
  }

  const currentProfile = await readAgentRegistry(podUrl, { fetch: solidFetch }).catch(() => null);
  const recipients = (currentProfile?.authorizedAgents ?? [])
    .filter(a => !a.revoked && a.encryptionPublicKey)
    .map(a => a.encryptionPublicKey!) as string[];
  if (!recipients.includes(relayAgentKey.publicKey)) recipients.push(relayAgentKey.publicKey);

  // Cross-pod selective sharing: resolve each share_with handle to their
  // pod's authorized agents, union their keys into recipients. Their
  // agents can then decrypt THIS graph without any pod-level ACL change.
  const shareWith = (args.share_with as string[] | undefined) ?? [];
  const shareResolved: { handle: string; podUrl: string; agentCount: number }[] = [];
  if (shareWith.length > 0) {
    const resolved = await resolveRecipients(shareWith, { fetch: solidFetch });
    for (const r of resolved) {
      shareResolved.push({ handle: r.handle, podUrl: r.podUrl, agentCount: r.agentEncryptionKeys.length });
      for (const key of r.agentEncryptionKeys) {
        if (!recipients.includes(key)) recipients.push(key);
      }
    }
  }

  const publishOptions: Parameters<typeof publish>[3] = recipients.length > 0
    ? { fetch: solidFetch, encrypt: { recipients, senderKeyPair: relayAgentKey } }
    : { fetch: solidFetch };
  const result = await publish(descriptor, args.graph_content as string, podUrl, publishOptions);

  // Pin to IPFS if configured (org-level or user override)
  const ipfsConfig = resolveIpfsConfig(args._req ?? {});
  let ipfs: { cid?: string; url?: string; provider?: string } = {};
  if (ipfsConfig.provider !== 'local' && ipfsConfig.apiKey) {
    try {
      const turtle = toTurtle(descriptor);
      const pinResult = await pinToIpfs(turtle, `descriptor-${descriptor.id}`, ipfsConfig, solidFetch);
      ipfs = { cid: pinResult.cid, url: pinResult.url, provider: pinResult.provider };
    } catch (err) {
      ipfs = { cid: `error: ${(err as Error).message}` };
    }
  } else {
    const turtle = toTurtle(descriptor);
    ipfs = { cid: cryptoComputeCid(turtle), provider: 'local' };
  }

  // Auto-publish pod directory on first write. A pod holding content
  // but no directory at /.well-known/context-graphs-directory cannot be
  // discovered by federation clients that traverse directories (see
  // spec/LAYERS.md L2 federation patterns). Previously operators had
  // to remember to call publish_directory manually. Now it's asserted
  // inline — idempotent, best-effort, non-fatal so the publish itself
  // isn't blocked by directory plumbing.
  await ensurePodDirectory(podUrl, ownerWebId);

  return JSON.stringify({
    published: true,
    owner: ownerWebId,
    agent: agentId,
    pod: podUrl,
    descriptorUrl: result.descriptorUrl,
    graphUrl: result.graphUrl,
    encrypted: result.encrypted ?? false,
    recipients: recipients.length,
    sharedWith: shareResolved.length > 0 ? shareResolved : undefined,
    manifestUrl: result.manifestUrl,
    ipfs,
    supersedesPriorVersions: priorVersions.length > 0 ? priorVersions : undefined,
    // Privacy-hygiene preflight (see docs://interego/playbook §2). Empty
    // string means no flags. The calling agent — and any LLM in the
    // loop — should surface the warning to the user before treating the
    // publish as final.
    sensitivityPreflight: sensitivityWarning || undefined,
    // Compliance-grade fields (when args.compliance === true): sign
    // the descriptor turtle with the relay's ECDSA wallet, write a
    // sibling .sig.json to the pod, and return the check report.
    ...(args.compliance === true
      ? await (async () => {
          let signed: SignedDescriptor | null = null;
          let signError: string | null = null;
          let sigUrl: string | null = null;
          let sigIpfsCid: string | null = null;
          try {
            const cw = await ensureRelayComplianceWallet();
            // Re-fetch the published Turtle to sign canonical bytes the
            // pod actually persists (storage layer may normalize).
            const ttlResp = await solidFetch(result.descriptorUrl, {
              headers: { 'Accept': 'text/turtle' },
            });
            const canonicalTurtle = ttlResp.ok ? await ttlResp.text() : '';
            signed = await signDescriptor(descriptor.id, canonicalTurtle, cw.wallet);
            sigUrl = `${result.descriptorUrl}.sig.json`;
            const sigBody = JSON.stringify(signed, null, 2);
            const sigResp = await solidFetch(sigUrl, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: sigBody,
            });
            if (!sigResp.ok) signError = `pod write failed (${sigResp.status})`;
            // Auto-pin the signature alongside the descriptor when an
            // IPFS provider is configured. Non-fatal on failure.
            const sigIpfsConfig = resolveIpfsConfig(args._req ?? {});
            if (sigIpfsConfig.provider !== 'local' && sigIpfsConfig.apiKey) {
              try {
                const sigPin = await pinToIpfs(sigBody, `signature-${descriptor.id}`, sigIpfsConfig, solidFetch);
                sigIpfsCid = sigPin.cid;
              } catch (err) {
                signError = signError ?? `signature pin failed: ${(err as Error).message}`;
              }
            }
          } catch (err) {
            signError = (err as Error).message;
          }
          const check = checkComplianceInputs({
            modalStatus: preprocessed.semiotic.modalStatus,
            trustLevel: 'CryptographicallyVerified',
            hasSignature: signed !== null,
            framework: args.compliance_framework as ComplianceFramework | undefined,
          });
          return {
            complianceCheck: check,
            signature: signed
              ? {
                  url: sigUrl,
                  signer: signed.signerAddress,
                  signedAt: signed.signedAt,
                  ipfsCid: sigIpfsCid ?? undefined,
                }
              : { error: signError },
          };
        })()
      : {}),
  });
}

/**
 * Ensure the pod has a discoverable directory at
 * /.well-known/context-graphs-directory. Idempotent + best-effort — if
 * the directory already exists or the call fails, the caller's publish
 * is not blocked. Federation clients use the directory to enumerate a
 * pod's context graphs without having to scan LDP containers.
 */
async function ensurePodDirectory(podUrl: string, ownerWebId: string): Promise<void> {
  const directoryUrl = `${podUrl}.well-known/context-graphs-directory`;
  try {
    const existing = await fetchPodDirectory(directoryUrl, { fetch: solidFetch }).catch(() => null);
    if (existing) return; // already published
    await publishPodDirectory(
      { id: directoryUrl as IRI, entries: [] },
      podUrl,
      { fetch: solidFetch },
    );
  } catch (err) {
    console.warn(`[relay] ensurePodDirectory(${podUrl}) failed: ${(err as Error).message}`);
  }
}

async function handleDiscoverContext(args: ToolArgs): Promise<string> {
  const podUrl = args.pod_url as string;
  const filter: Record<string, unknown> = {};
  if (args.facet_type) filter.facetType = args.facet_type;
  if (args.valid_from) filter.validFrom = args.valid_from;
  if (args.valid_until) filter.validUntil = args.valid_until;
  if (args.effective_at) filter.effectiveAt = args.effective_at;

  const entries = await discover(
    podUrl,
    Object.keys(filter).length > 0 ? filter as Parameters<typeof discover>[1] : undefined,
    { fetch: solidFetch },
  );

  // Optionally include registry info
  let registry = null;
  if (args.verify_delegation) {
    const profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
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
  const url = args.url as string;
  // Route envelope / TriG URLs through fetchGraphContent so encrypted
  // payloads are transparently decrypted for this relay's agent key (the
  // recipients registered on the pod include us when we published, so
  // round-tripping is seamless).
  if (url.endsWith('.envelope.jose.json') || url.endsWith('.trig')) {
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
    return JSON.stringify({ url, encrypted, mediaType, content });
  }

  const resp = await solidFetch(url, {
    method: 'GET',
    headers: { 'Accept': 'text/turtle' },
  });
  if (!resp.ok) {
    return JSON.stringify({ error: `${resp.status} ${resp.statusText}` });
  }
  const turtle = await resp.text();

  // Hypermedia follow-your-nose: the descriptor Turtle includes
  // cg:hasDistribution [ dcat:accessURL <...> ; dcat:mediaType "..." ;
  // cg:encrypted <bool> ; ... ]. We parse that instead of reconstructing
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

  return JSON.stringify({ url, turtle, ...(graph ? { graph } : {}) });
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
  const entries = await discover(podUrl, undefined, { fetch: solidFetch }).catch(() => []);
  const profile = await readAgentRegistry(podUrl, { fetch: solidFetch }).catch(() => null);

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
  if (subscriptions.has(podUrl)) {
    return JSON.stringify({ subscribed: true, message: 'Already subscribed' });
  }

  try {
    const sub = await subscribe(podUrl, (event: ContextChangeEvent) => {
      notificationLog.push(event);
      log(`[notification] ${event.type} on ${event.resource}`);
    }, {
      fetch: solidFetch,
      WebSocket: WebSocket as unknown as WebSocketConstructor,
    });
    subscriptions.set(podUrl, sub);
    return JSON.stringify({ subscribed: true, pod: podUrl });
  } catch (err) {
    return JSON.stringify({ subscribed: false, error: (err as Error).message });
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

  await writeAgentRegistry(profile, podUrl, { fetch: solidFetch });

  const agent = profile.authorizedAgents.find(a => a.agentId === agentId)!;
  const credential = createDelegationCredential(profile, agent, podUrl as IRI);
  const credUrl = await writeDelegationCredential(credential, podUrl, { fetch: solidFetch });

  return JSON.stringify({ registered: true, agent: agentId, credential: credUrl });
}

async function handleVerifyAgent(args: ToolArgs): Promise<string> {
  const result = await verifyAgentDelegation(
    (args.agent_id as string) as IRI,
    args.pod_url as string,
    { fetch: solidFetch },
  );
  return JSON.stringify(result);
}

// ── Federation Tool Handlers ────────────────────────────────

// Simple in-memory pod registry for the relay.
// `via` tracks how a pod entry got into our view of the federation:
//   'manual'    — explicitly added via add_pod
//   'directory' — imported from a published pod directory
//   'webfinger' — resolved via WebFinger lookup
//   'self'      — synthetic per-call projection of the calling
//                 bearer's own pod (NEVER persisted to knownPods —
//                 see selfPodEntry()). 'self' wins on URL collisions
//                 so users see their own pod as their own pod even
//                 if a directory import previously listed it.
type KnownPodVia = 'manual' | 'directory' | 'webfinger' | 'self';
const knownPods: Map<string, { url: string; label?: string; owner?: string; via: KnownPodVia }> = new Map();

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
async function knownPodsWithSelf(args: ToolArgs): Promise<Array<{ url: string; label?: string; owner?: string; via: KnownPodVia }>> {
  const self = await selfPodEntry(args);
  const others = [...knownPods.values()].filter(p => !self || p.url !== self.url);
  return self ? [self, ...others] : others;
}

async function handleDiscoverAll(args: ToolArgs): Promise<string> {
  const pods = await knownPodsWithSelf(args);
  if (pods.length === 0) {
    return JSON.stringify({ message: 'No known pods. Use add_pod or discover_directory first.' });
  }

  const results: Array<{ pod: string; entries: ManifestEntry[]; error?: string }> = [];
  await Promise.allSettled(pods.map(async (pod) => {
    try {
      const filter: Record<string, unknown> = {};
      if (args.facet_type) filter.facetType = args.facet_type;
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
  return JSON.stringify(await knownPodsWithSelf(args));
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
  knownPods.set(url, {
    url,
    label: args.label as string | undefined,
    owner: args.owner as string | undefined,
    via: 'manual',
  });
  return JSON.stringify({ added: true, url, total: knownPods.size });
}

async function handleRemovePod(args: ToolArgs): Promise<string> {
  const url = args.pod_url as string;
  const removed = knownPods.delete(url);
  return JSON.stringify({ removed, url, total: knownPods.size });
}

async function handleDiscoverDirectory(args: ToolArgs): Promise<string> {
  const directory = await fetchPodDirectory(args.directory_url as string, { fetch: solidFetch });
  let added = 0;
  for (const entry of directory.entries) {
    if (!knownPods.has(entry.podUrl)) added++;
    knownPods.set(entry.podUrl, {
      url: entry.podUrl,
      label: entry.label,
      owner: entry.owner,
      via: 'directory',
    });
  }
  // Return the merged view including the calling user's own pod
  // — addresses the "directory listing of my pods does not include
  // my own pod" surprise. We do NOT persist self into knownPods
  // (it is projected per-call from the bearer); we just include it
  // in the returned `pods` array for caller convenience. `added`
  // remains a count of newly-persisted directory entries.
  const pods = await knownPodsWithSelf(args);
  return JSON.stringify({ imported: directory.entries.length, added, total: knownPods.size, pods });
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
    knownPods.set(result.podUrl, {
      url: result.podUrl,
      via: 'webfinger',
    });
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
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ pod: string; error: string }> = [];

  for (const pod of pods) {
    if (subscriptions.has(pod.url)) {
      skipped++;
      continue;
    }
    try {
      const sub = await subscribe(pod.url, (event: ContextChangeEvent) => {
        notificationLog.push(event);
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
  }

  return JSON.stringify({
    total: pods.length,
    subscribed,
    skipped,
    failed,
    failures: failures.length > 0 ? failures : undefined,
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
        `urn:cg:${podName}:pgsl:${Date.now()}` as IRI,
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

// ── Generic affordance follower ─────────────────────────────
//
// Proxies a `cg:Affordance` invocation through the MCP layer so a single
// Interego connector reaches any vertical's affordances (Foxxi, LRS, OWM,
// ADP, AC, LPC, ...) without installing the per-vertical bridge. Discover
// available actions via `discover_context` + `get_descriptor`; this handler
// performs the descriptor fetch + match + HTTP POST in one shot.
async function handleInvokeAffordance(args: ToolArgs): Promise<string> {
  // Compatibility shim — internally a kernel `act` call. Wire format
  // unchanged: descriptor_url + action_iri + payload + authorization
  // map onto the kernel's affordance-resolved form, and the kernel
  // returns the same fields the legacy followAffordance did.
  const descriptorUrl = args.descriptor_url as string;
  const actionIri = args.action_iri as string;
  const payload = (args.payload ?? {}) as Record<string, unknown>;
  const authorization = args.authorization as string | undefined;
  if (!descriptorUrl) throw new Error('invoke_affordance: descriptor_url is required');
  if (!actionIri) throw new Error('invoke_affordance: action_iri is required');
  const result = await kernelAct(
    { descriptorUrl, actionIri },
    payload,
    {
      fetch: solidFetch,
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
  // `urn:cg:action:kernel:{dereference,decompose,promote}` action IRIs and
  // expects the holon IRI itself as the target. The previous
  // `urn:cg:action:{dereference,promote,decompose}` action IRIs plus the
  // bogus `urn:cg:tool:promote` / `urn:cg:tool:decompose` targets broke the
  // hypermedia round-trip (act → 405 unsupported_action_on_lattice_target).
  return JSON.stringify(decorateKernelResult(r as unknown as Record<string, unknown>, {
    kind: 'mint',
    id: r.holon.iri,
    nextSteps: [
      { action: 'urn:cg:action:kernel:dereference', target: r.holon.iri, method: 'GET' },
      { action: 'urn:cg:action:kernel:promote',     target: r.holon.iri, method: 'POST' },
      { action: 'urn:cg:action:kernel:decompose',   target: r.holon.iri, method: 'POST' },
    ],
  }));
}
async function handleKernelDereference(args: ToolArgs): Promise<string> {
  const iri = String(args['iri'] ?? '');
  const decorateManifest = args['decorate_manifest'] !== false;
  const r = await kernelDereference(iri, { fetch: solidFetch, decorateManifest });
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
      { action: 'urn:cg:action:restrict', target: 'urn:cg:tool:restrict', method: 'POST' },
      { action: 'urn:cg:action:publish',  target: 'urn:cg:tool:publish_context', method: 'POST' },
    ],
  }));
}
async function handleKernelAct(args: ToolArgs): Promise<string> {
  const descriptorUrl = args['descriptor_url'] as string | undefined;
  const actionIri = args['action_iri'] as string | undefined;
  const authorization = args['authorization'] as string | undefined;
  const affordance = descriptorUrl && actionIri
    ? { descriptorUrl, actionIri }
    : {
        action: (args['action'] as string | undefined) ?? actionIri ?? '',
        target: (args['target'] as string | undefined) ?? '',
        method: (args['method'] as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | undefined) ?? 'POST',
        ...(args['media_type'] ? { mediaType: args['media_type'] as string } : {}),
      };
  const r = await kernelAct(affordance as Parameters<typeof kernelAct>[0], args['payload'], {
    fetch: solidFetch,
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
      { action: 'urn:cg:action:extend',  target: 'urn:cg:tool:extend',  method: 'POST' },
      { action: 'urn:cg:action:publish', target: 'urn:cg:tool:publish_context', method: 'POST' },
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
      { action: 'urn:cg:action:restrict', target: 'urn:cg:tool:restrict', method: 'POST' },
      { action: 'urn:cg:action:publish',  target: 'urn:cg:tool:publish_context', method: 'POST' },
    ],
  }));
}
async function handleKernelPromote(args: ToolArgs): Promise<string> {
  const atoms = (args['atoms'] ?? []) as Parameters<typeof kernelPromote>[0];
  const r = kernelPromote(atoms);
  // Same hypermedia contract as handleKernelMint: emit canonical
  // `urn:cg:action:kernel:*` action IRIs with the apex's urn:pgsl:* IRI as
  // the target so `act` round-trips through actOnLatticeNode cleanly.
  return JSON.stringify(decorateKernelResult(r as unknown as Record<string, unknown>, {
    kind: 'promote',
    id: r.apex,
    nextSteps: [
      { action: 'urn:cg:action:kernel:dereference', target: r.apex, method: 'GET' },
      { action: 'urn:cg:action:kernel:decompose',   target: r.apex, method: 'POST' },
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
        { action: 'urn:cg:action:kernel:dereference', target: iri, method: 'GET' },
      ],
    }));
  }
  return JSON.stringify(decorateKernelResult(r as unknown as Record<string, unknown>, {
    kind: 'decompose',
    id: r.apex,
    nextSteps: [
      { action: 'urn:cg:action:kernel:dereference', target: r.left,    method: 'GET' },
      { action: 'urn:cg:action:kernel:dereference', target: r.right,   method: 'GET' },
      { action: 'urn:cg:action:kernel:dereference', target: r.overlap, method: 'GET' },
    ],
  }));
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
  // ── Core tools (compatibility shims; internal implementation routes through kernel where natural) ──
  publish_context: { description: 'Publish a context-annotated knowledge graph', handler: handlePublishContext },
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
  // Subscription management
  unsubscribe_from_pod: { description: 'Close an active WebSocket subscription on a pod', handler: handleUnsubscribeFromPod },
  subscribe_all: { description: 'Subscribe to notifications from all known pods', handler: handleSubscribeAll },
  // Onboarding / wallet (stubbed on the remote OAuth surface)
  setup_identity: { description: 'Identity onboarding (not applicable on remote relay — see message)', handler: handleSetupIdentity },
  link_wallet: { description: 'Link an Ethereum wallet (not applicable on remote relay — see message)', handler: handleLinkWallet },
  check_balance: { description: 'Check ETH balance for a wallet address', handler: handleCheckBalance },
  // Comprehension
  analyze_question: { description: 'Analyze a question to pick the optimal cognitive strategy', handler: handleAnalyzeQuestion },
  // PGSL lattice
  pgsl_ingest: { description: 'Ingest content into the PGSL lattice', handler: handlePgslIngest },
  pgsl_resolve: { description: 'Resolve a PGSL URI to its content + metadata', handler: handlePgslResolve },
  pgsl_lattice_status: { description: 'Report PGSL lattice statistics', handler: handlePgslLatticeStatus },
  pgsl_meet: { description: 'Compute the lattice meet of two PGSL fragments', handler: handlePgslMeet },
  pgsl_to_turtle: { description: 'Serialize the PGSL lattice as RDF Turtle', handler: handlePgslToTurtle },
  // Generic affordance follower (Path A — reach any vertical without per-vertical bridge)
  invoke_affordance: { description: 'Invoke a vertical affordance by descriptor URL + cg:action IRI', handler: handleInvokeAffordance },
};

// ── MCP Tool Schemas ────────────────────────────────────────
// Input schemas for each tool. Claude's LLM uses these to know how to call
// each tool; empty inputSchema means the model can never pick the right args.
// Property names match what each handler reads off args.
//
// outputSchema describes the wire-level MCP response envelope (top-level
// `type: 'object'` is required by the SDK validator). Where the handler
// returns a known JSON object, the inner `text` payload schema is
// attached as `x-payload-schema` so downstream catalogs can show clients
// the structured response shape (no more "output schema missing" in
// OpenAI Apps). Generic tools fall back to a permissive object. Tier-1
// (publish_context / discover_context / get_descriptor / list_known_pods /
// get_pod_status / analyze_question) have hand-authored shapes. This is
// metadata only — handler behavior is untouched.

function mcpOutputSchema(
  textPayloadSchema?: Record<string, unknown>,
): Record<string, unknown> {
  const textProp: Record<string, unknown> = {
    type: 'string',
    description: textPayloadSchema && typeof textPayloadSchema.description === 'string'
      ? textPayloadSchema.description
      : 'JSON-encoded result payload (or human-readable summary with embedded URLs).',
  };
  if (textPayloadSchema) {
    textProp['x-payload-schema'] = textPayloadSchema;
  }
  return {
    type: 'object',
    properties: {
      content: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'text' },
            text: textProp,
          },
          required: ['type', 'text'],
        },
      },
      isError: { type: 'boolean' },
    },
    required: ['content'],
  };
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
    recipients: { type: 'integer', description: 'Number of envelope recipients (includes self)' },
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
      description: 'When compliance: true — ECDSA signature record sibling .sig.json',
      properties: {
        url: { type: 'string' },
        signer: { type: 'string', description: 'Ethereum address of signer' },
        signedAt: { type: 'string', description: 'ISO 8601 signing timestamp' },
        ipfsCid: { type: 'string' },
        error: { type: 'string' },
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
  description: "Descriptor Turtle plus optional decrypted graph payload reached via the descriptor's cg:hasDistribution link.",
  properties: {
    url: { type: 'string', description: 'Echo of the descriptor URL requested' },
    turtle: { type: 'string', description: 'Full Turtle of the descriptor (when the URL is a .ttl)' },
    encrypted: { type: 'boolean', description: 'For .envelope.jose.json / .trig URLs: was the payload encrypted' },
    mediaType: { type: 'string' },
    content: { type: 'string', description: 'Resolved graph payload (decrypted when this agent is a recipient)' },
    graph: {
      type: 'object',
      description: 'Distribution-followed graph payload (when descriptor has cg:hasDistribution and content was reachable)',
      properties: {
        url: { type: 'string' },
        mediaType: { type: 'string' },
        encrypted: { type: 'boolean' },
        content: { type: 'string' },
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
  description: 'Result of a cg:Affordance invocation — echo of the resolved affordance metadata plus the raw HTTP response from the target. Parse body based on contentType; 4xx is informative (e.g. forbidden / validation), 5xx is retried internally before surfacing.',
  properties: {
    status: { type: 'integer', description: 'HTTP status from the target' },
    statusText: { type: 'string' },
    contentType: { type: 'string', description: 'Content-Type header from the target (null when absent)' },
    body: { type: 'string', description: 'Raw response body — JSON-parse when contentType is application/json' },
    affordance: {
      type: 'object',
      description: 'Resolved affordance metadata from the descriptor',
      properties: {
        action: { type: 'string', description: 'cg:action IRI selected by the caller' },
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
    description: 'Kernel verb — adjunction right half (part → whole). Inverse of restrict; back-links via cg:supersedes.',
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
  // ═══════════════════════════════════════════════════════════
  //  Compatibility shims — the 27 named tools. Each remains
  //  wire-compatible; descriptions tagged with "Compatibility
  //  shim" + the kernel verb composition that realizes it.
  // ═══════════════════════════════════════════════════════════
  {
    name: 'publish_context',
    description: 'Compatibility shim — internally composes kernel(compose+act) over a publish affordance plus E2EE/anchoring/compliance plumbing. Publishes a context-annotated knowledge graph (Turtle) to your Solid pod with the full 6-facet descriptor (Temporal, Provenance, Agent, Semiotic, Trust, Federation). Attributes the descriptor to the pod owner and associates it with the calling agent.',
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
        share_with: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of external identity handles (did:web:..., WebID URLs, or acct:user@host). Each is resolved to its pod, and their authorized agents\' X25519 keys are added as recipients on the envelope — per-graph cross-pod sharing without any pod-level ACL change. Use to share a specific graph with another person while keeping your other graphs private.',
        },
        auto_supersede_prior: {
          type: 'boolean',
          description: 'When true (default), automatically add cg:supersedes links to any prior descriptor on this pod that describes the same graph_iri. Makes republish-to-add-recipients cleanly mark the older version as superseded. Set to false to allow multiple coexisting descriptors for the same graph.',
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
      },
      required: ['graph_iri', 'graph_content'],
    },
    outputSchema: PUBLISH_CONTEXT_OUTPUT,
    annotations: { title: 'Publish context graph', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'discover_context',
    description: 'Compatibility shim — internally `dereference(podUrl + "/.well-known/context-graphs")` plus filter post-processing. For pure substrate access, use the kernel verb `dereference` directly. Discovers context descriptors on a specific Solid pod. Optionally verify the agent delegation chain.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Solid pod URL to discover from (e.g. https://pod.example.com/agent/)' },
        facet_type: { type: 'string', enum: ['Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation'], description: 'Filter by facet type' },
        valid_from: { type: 'string', description: 'Filter: valid at or after this ISO datetime' },
        valid_until: { type: 'string', description: 'Filter: valid at or before this ISO datetime' },
        verify_delegation: { type: 'boolean', description: 'If true, also fetch the agent registry to verify delegation' },
      },
      required: ['pod_url'],
    },
    outputSchema: DISCOVER_CONTEXT_OUTPUT,
    annotations: { title: 'Discover descriptors on a pod', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'get_descriptor',
    description: 'Compatibility shim — internally `dereference(descriptorUrl)`. For pure substrate access, use `dereference` directly. Fetches the full Turtle content of a specific context descriptor.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL of the descriptor resource (ends in .ttl)' },
      },
      required: ['url'],
    },
    outputSchema: GET_DESCRIPTOR_OUTPUT,
    annotations: { title: 'Fetch descriptor + payload', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    description: 'Compatibility shim — `Promise.all(knownPods.map(p => dereference(p + manifest)))` + result merge. Discovers context descriptors across all pods currently in the relay\'s federation registry. Use add_pod or discover_directory first to populate.',
    inputSchema: {
      type: 'object',
      properties: {
        facet_type: { type: 'string', enum: ['Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation'], description: 'Filter by facet type' },
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
    description: 'Compatibility shim — internally `act({descriptorUrl, actionIri}, payload)`. For pure substrate access, use the kernel verb `act` directly. Generic affordance follower. Given a descriptor URL and a cg:action IRI, this fetches the descriptor, finds the matching cg:Affordance block, and POSTs your payload to its hydra:target — proxying through the MCP layer so any vertical (Foxxi, LRS, OWM, ADP, AC, LPC, ...) is reachable through the one Interego connector. Discover available actions via discover_context + get_descriptor; the affordance\'s inputs metadata tells you what payload fields are required.',
    inputSchema: {
      type: 'object',
      properties: {
        descriptor_url: { type: 'string', description: 'URL of the Context Descriptor containing the affordance (e.g., a Foxxi course descriptor URL).' },
        action_iri: { type: 'string', description: 'The cg:action IRI of the affordance to invoke (e.g., urn:cg:action:foxxi:discover-assigned-courses). Discover available actions via discover_context + get_descriptor.' },
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
- "is this still true" → check cg:modalStatus + cg:supersedes chain
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
- Descriptors are versioned via cg:supersedes; cached decisions are
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

function buildMcpServer(authContext: { agentId: string; ownerWebId?: string; userId?: string; podUrl?: string; identityToken?: string } | null): Server {
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

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
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
      const text = readFileSync(path, 'utf8');
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
    const tool = TOOLS[name];
    if (!tool) {
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }
    const args: ToolArgs = { ...(rawArgs ?? {}) };
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
      return { content: [{ type: 'text' as const, text }] };
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

app.use(express.json());
// Login form POSTs x-www-form-urlencoded; OAuth token endpoint does too.
app.use(express.urlencoded({ extended: false }));

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
    '@type': ['hydra:Resource', 'urn:cg:oauth:AuthorizationServerMetadata'],
    conformsToShape: 'urn:cg:shape:OAuthAuthorizationServerMetadata',
    issuer: DEFAULT_ISSUER.href,
    authorization_endpoint: `${issuerHref}/authorize`,
    token_endpoint: `${issuerHref}/token`,
    registration_endpoint: `${issuerHref}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: ['mcp'],
    // RFC 9449 §5.1 — advertise DPoP support to clients.
    dpop_signing_alg_values_supported: DPOP_SIGNING_ALGS,
    // Hydra affordances — every OAuth endpoint as a hydra:Operation so
    // clients can navigate the auth flow via link traversal.
    affordances: [
      {
        '@type': ['cg:Affordance', 'hydra:Operation'],
        action: 'urn:cg:action:oauth:authorize',
        target: `${issuerHref}/authorize`,
        method: 'GET',
        returns: 'urn:cg:type:AuthorizationCode',
      },
      {
        '@type': ['cg:Affordance', 'hydra:Operation'],
        action: 'urn:cg:action:oauth:token',
        target: `${issuerHref}/token`,
        method: 'POST',
        expects: 'urn:cg:type:TokenRequest',
        returns: 'urn:cg:type:AccessToken',
      },
      {
        '@type': ['cg:Affordance', 'hydra:Operation'],
        action: 'urn:cg:action:oauth:register',
        target: `${issuerHref}/register`,
        method: 'POST',
        expects: 'urn:cg:type:ClientRegistrationRequest',
        returns: 'urn:cg:type:ClientRegistration',
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
    '@type': ['hydra:Resource', 'urn:cg:oauth:ProtectedResourceMetadata'],
    conformsToShape: 'urn:cg:shape:OAuthProtectedResourceMetadata',
    resource: issuerHref + '/',
    authorization_servers: [DEFAULT_ISSUER.href],
    scopes_supported: ['mcp'],
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
        '@type': ['cg:Affordance', 'hydra:Operation'],
        action: 'urn:cg:action:oauth:discover-authorization-server',
        target: `${issuerHref}/.well-known/oauth-authorization-server`,
        method: 'GET',
        returns: 'urn:cg:type:AuthorizationServerMetadata',
      },
      {
        '@type': ['cg:Affordance', 'hydra:Operation'],
        action: 'urn:cg:action:mcp:invoke',
        target: `${issuerHref}/mcp`,
        method: 'POST',
        expects: 'urn:cg:type:McpRequest',
        returns: 'urn:cg:type:McpResponse',
      },
      {
        '@type': ['cg:Affordance', 'hydra:Operation'],
        action: 'urn:cg:action:mcp:list-tools',
        target: `${issuerHref}/tools`,
        method: 'GET',
        returns: 'urn:cg:type:HydraCollection',
      },
      {
        // /.well-known/operations — typed substrate-operation catalog
        // (8 kernel verbs + every thin-facade shim) as cg:Affordance
        // entries. Lets a hypermedia client walk discovery → catalog →
        // shape → invocation without an MCP client. See FIX 4 in the
        // survey plan; the underlying route remains POST /mcp (or
        // POST /tool/:name for the REST shortcut), the catalog only
        // publishes WHAT exists and WHERE to send it.
        '@type': ['cg:Affordance', 'hydra:Operation'],
        action: 'urn:cg:action:operations:catalog',
        target: `${issuerHref}/.well-known/operations`,
        method: 'GET',
        returns: 'urn:cg:type:OperationsCatalog',
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
// 'urn:cg:action:<name>'}, payload).
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
    const shapeIri = `urn:cg:shape:input:${name}`;
    const returnsIri = `urn:cg:shape:output:${name}`;
    const title = schema && typeof (schema as { annotations?: { title?: string } }).annotations?.title === 'string'
      ? (schema as { annotations: { title: string } }).annotations.title
      : name;
    return {
      '@id': `urn:cg:operation:${name}`,
      '@type': ['cg:Affordance', 'hydra:Operation'],
      action: `urn:cg:action:${name}`,
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
    '@type': ['hydra:Collection', 'urn:cg:type:OperationsCatalog'],
    conformsToShape: 'urn:cg:shape:OperationsCatalog',
    'hydra:totalItems': members.length,
    'hydra:member': members,
  });
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
        steps.push({ action: 'urn:cg:action:read',      target: descriptorUrl, method: 'GET' });
        steps.push({ action: 'urn:cg:action:supersede', target: descriptorUrl, method: 'POST' });
      }
      return steps;
    }
    case 'discover_context':
    case 'discover_all':
      return [{ action: 'urn:cg:action:refine-search', target: 'urn:cg:tool:discover_context', method: 'POST' }];
    case 'get_descriptor': {
      const url = pick('url');
      return url
        ? [{ action: 'urn:cg:action:dereference', target: url, method: 'GET' }]
        : [];
    }
    case 'register_agent': {
      const agentIri = pick('agentIri') ?? pick('agentId');
      const steps: Array<{ action: string; target: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' }> = [
        { action: 'urn:cg:action:verify-agent', target: 'urn:cg:tool:verify_agent', method: 'POST' },
      ];
      if (agentIri) steps.push({ action: 'urn:cg:action:revoke-agent', target: agentIri, method: 'DELETE' });
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
app.post('/token', express.urlencoded({ extended: false }), tokenDpopMiddleware);

app.use(mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: DEFAULT_ISSUER,
  scopesSupported: ['mcp'],
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

  // FIX A: relay is now the single authoritative pod-side writer for
  // /<userId>/profile/card AND /<userId>/agents. Identity-server's old
  // eager-init writes are removed; two writers were racing on every OAuth
  // completion, producing CSS file-backend HTTP 500s on the second OAuth
  // ("Read counter would become negative" on /profile/card) and a ~10s 404
  // window for any client that hit /agents or /profile/card immediately
  // after the OAuth code came back.
  //
  // This block runs SYNCHRONOUSLY before /oauth/verify returns — no more
  // fire-and-forget. The OAuth code is only handed back once both pod
  // documents are HTTP 2xx, so any client hitting the pod right after
  // authorization sees populated documents instead of 404 / 500.
  //
  // Idempotency:
  //   - First-touch (no /agents yet on this pod): write both /profile/card
  //     AND /agents as the initial pod bootstrap.
  //   - Subsequent surface add (registry present, surface agent missing):
  //     append the surface agent to /agents. /profile/card already points
  //     to /agents for the canonical authorizedAgent list, so it does not
  //     need rewriting.
  //   - Re-connect from known surface (agent present with correct
  //     encryptionPublicKey): no writes at all. Save the CSS round-trips.
  //
  // Concurrency: two OAuth flows for the same user (e.g. simultaneous
  // logins from Claude Desktop AND Cursor while the pod has no /agents
  // yet) would both read the empty registry, both build a "first-touch"
  // profile with their own surface agent, and then write last-wins —
  // the second write clobbers the first surface. We handle this by
  // wrapping the read-modify-write in a per-pod mutex (in-process,
  // sufficient for the single-replica relay) AND by post-write
  // verification: after the write we re-read /agents, and if the
  // surface agent we just wrote is missing (because a concurrent
  // writer clobbered us in the gap between our read and write), we
  // re-execute the merge with the fresh state. A small backoff +
  // retry budget bounds the worst case.
  try {
    await withPodMutex(authResp.podUrl!, () => bootstrapPod({
      podUrl: authResp.podUrl!,
      ownerWebId: authResp.webId! as IRI,
      surfaceAgentIri: agentIri as IRI,
      userName: authResp.name ?? authResp.userId!,
      agentLabel: authResp.agentName ?? `Surface agent ${surfaceAgent}`,
      userId: authResp.userId!,
      identityWebId: authResp.webId!,
      identityDid: authResp.did,
    }));
  } catch (err) {
    // A pod-init failure means the OAuth flow cannot reliably complete —
    // the redirected client would hit /agents or /profile/card and 404 or
    // get a stale view. Return 502 so the client retries the verify step
    // rather than silently issuing the OAuth code over a broken pod.
    const msg = `Pod bootstrap failed for ${authResp.podUrl}: ${(err as Error).message}`;
    log(`ERROR: /oauth/verify ${msg}`);
    res.status(502).json({ error: msg });
    return;
  }

  const redirect = new URL(result.redirectUri);
  redirect.searchParams.set('code', result.code);
  if (result.state) redirect.searchParams.set('state', result.state);
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
  podWriteMutexes.set(podUrl, prev.then(() => gate, () => gate));
  try {
    await prev.catch(() => undefined);
    return await fn();
  } finally {
    release();
    // Clean up if we're the last entry in the chain.
    queueMicrotask(() => {
      if (podWriteMutexes.get(podUrl) === gate) podWriteMutexes.delete(podUrl);
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
    await writeAgentRegistry(nextProfile, podUrl, { fetch: solidFetch });

    // FIX C: write the cg:PodBootstrap descriptor in the same
    // single-writer block as /agents + /profile/card. Idempotent
    // (fixed IRI urn:cg:pod-bootstrap:<userId>:v1) so re-bootstraps
    // don't duplicate the manifest entry. Best-effort — see
    // publishPodBootstrapDescriptor's failure-mode comment. We only
    // publish on first-touch because the bootstrap describes the pod's
    // static topology (owner / storage / WebID / registry / card); the
    // dynamic surface-agent list lives on /agents and is read from
    // there. Subsequent surface adds don't need to re-publish the
    // bootstrap descriptor.
    if (firstTouch) {
      await publishPodBootstrapDescriptor({
        podUrl,
        ownerWebId,
        userId,
        surfaceAgentIri,
      });
    }

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
const bootstrappedPods = new Set<string>();

// Tools that materially depend on `<pod>/agents` and/or
// `<pod>/profile/card` existing before they run — these AWAIT the
// lazy init. Reads (discover/list/status) need /agents for the
// registry-derived identity claims; writes (publish/register/revoke/
// publish_directory) need the registry for their first-line auth
// check. Everything else (mint, dereference, compose, act, restrict,
// extend, promote, decompose, pgsl_* lattice ops, kernel verbs that
// operate purely on lattice atoms, ping, etc.) does NOT need pod
// state pre-init — for those we kick off the bootstrap as a
// best-effort fire-and-forget so the NEXT call lands on a warm pod
// without paying any latency on THIS call.
const POD_AWARE_TOOLS = new Set<string>([
  // Writes — first-line auth reads /agents
  'publish_context', 'register_agent', 'revoke_agent', 'publish_directory',
  // Reads that materialize over /agents or /profile/card
  'discover_context', 'discover_all', 'get_descriptor',
  'get_pod_status', 'list_known_pods', 'verify_agent',
  'subscribe_to_pod', 'unsubscribe_from_pod',
  'add_pod', 'remove_pod', 'discover_directory', 'resolve_webfinger',
]);

async function ensurePodInitialized(
  authContext: { podUrl?: string; agentId: string; ownerWebId: string; userId: string; identityToken?: string },
): Promise<void> {
  const podUrl = authContext.podUrl;
  if (!podUrl) return;
  // Layer 1: in-process fast-path. After a confirmed success on this
  // process this is O(1) Set.has — no network.
  if (bootstrappedPods.has(podUrl)) return;

  // Layer 2: HEAD probe. A 200 means another replica/process beat us
  // to it — record + skip. A 404 means first-touch and we proceed to
  // the mutex-guarded bootstrap. Anything else (5xx, network) we treat
  // as "unknown" and attempt the bootstrap; bootstrap itself is
  // idempotent (existing-agent re-connect path is a no-op write).
  try {
    const head = await solidFetch(`${podUrl}agents`, { method: 'HEAD' });
    if (head.status === 200) {
      bootstrappedPods.add(podUrl);
      return;
    }
  } catch {
    // Network blip — fall through to the bootstrap attempt. The mutex
    // + bootstrap-internal retries cope with transient CSS issues.
  }

  // Mutex-guarded bootstrap. The same `podWriteMutexes` map used by
  // the OAuth verify path — serialises lazy init AND OAuth init on
  // the SAME per-pod key, so a tool call racing an OAuth completion
  // for the same user does not double-write the registry.
  await withPodMutex(podUrl, async () => {
    // Double-checked locking: a concurrent in-process call may have
    // landed the Set entry while we were waiting on the mutex.
    if (bootstrappedPods.has(podUrl)) return;
    // Fallback labels mirror the OAuth-verify path when identity
    // is unreachable / cache-cold: userName=userId, agentLabel
    // synthesized from the bare agent slug.
    const bareAgentSlug = authContext.agentId.startsWith('did:web:')
      ? (authContext.agentId.split(':').pop() ?? authContext.agentId)
      : authContext.agentId;
    await bootstrapPod({
      podUrl,
      ownerWebId: authContext.ownerWebId as IRI,
      surfaceAgentIri: authContext.agentId as IRI,
      userName: authContext.userId,
      agentLabel: `Surface agent ${bareAgentSlug}`,
      userId: authContext.userId,
      identityWebId: authContext.ownerWebId,
    });
    bootstrappedPods.add(podUrl);
    // On throw: do NOT add to bootstrappedPods so next call retries;
    // the throw propagates so the caller can decide whether to mask
    // (best-effort path) or surface (strict-DPoP write path).
  });
}

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
// We deliberately keep the inline `cg:authorizedAgent` payload narrow
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
    `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .`,
    `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
    ``,
    `<${cardUrl}#me>`,
    `    a foaf:Person ;`,
    `    foaf:name "${escapeTurtleString(userName)}" ;`,
    `    solid:oidcIssuer <${IDENTITY_URL}> ;`,
    `    solid:storage <${podUrl}> ;`,
    `    pim:storage <${podUrl}> ;`,
    `    cg:agentRegistry <${agentsRegistryUrl}> ;`,
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
// `cg:PodBootstrap` Context Descriptor into the pod's
// `.well-known/context-graphs` manifest. The descriptor self-describes
// the pod (cg:owner / cg:storage / cg:webId / cg:agentRegistry /
// cg:profileCard) and carries one cg:Affordance (cg:canPublish) whose
// hydra:target points back at the relay's publish_context tool so a
// client discovering the pristine pod has a strictly better UX signal
// than an empty manifest: "pod is alive, owned by X, here is how to
// add more context."
//
// Idempotency
// -----------
// Descriptor IRI is pinned to `urn:cg:pod-bootstrap:<userId>:v1` — the
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
  const descId = `urn:cg:pod-bootstrap:${userId}:v1` as IRI;
  const agentsRegistryUrl = `${podUrl}agents`;
  const cardUrl = `${podUrl}profile/card`;
  const ownerWebIdHash = `${cardUrl}#me`;
  // hydra:target for the cg:canPublish affordance. PUBLIC_BASE_URL is
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

  // Named-graph body: the pod self-description + one cg:canPublish
  // affordance. Kept compact; conventional cg: / hydra: / dcat:
  // vocabularies only. Lines are emitted without prefix declarations —
  // `wrapAsTriG()` hoists the descriptor's prefix block above the
  // named-graph body so cg: / hydra: / dcat: / prov: are already in
  // scope inside the graph block.
  const graphContent = [
    `<${podUrl}>`,
    `    a cg:PodBootstrap ;`,
    `    cg:owner <${ownerWebId}> ;`,
    `    cg:storage <${podUrl}> ;`,
    `    cg:webId <${ownerWebIdHash}> ;`,
    `    cg:agentRegistry <${agentsRegistryUrl}> ;`,
    `    cg:profileCard <${cardUrl}> ;`,
    `    prov:wasGeneratedBy <${surfaceAgentIri}> ;`,
    `    cg:affordance [`,
    `        a cg:Affordance, hydra:Operation ;`,
    `        cg:action cg:canPublish ;`,
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
      { name: 'audit-lineage',    target: '/audit/lineage?descriptor=<url>', method: 'GET',  description: 'Walk prov:wasDerivedFrom + cg:supersedes for one descriptor.' },
      { name: 'audit-compliance', target: '/audit/compliance/{framework}',   method: 'GET',  description: 'Generate a regulatory framework report.' },
      { name: 'inbox',            target: '/inbox?pod=<url>',                method: 'GET',  description: 'What\'s new on a pod (consumer-friendly framing of /audit/events).' },
      { name: 'oauth-as-meta',    target: '/.well-known/oauth-authorization-server', method: 'GET', description: 'OAuth 2.0 Authorization Server Metadata (RFC 8414) + Hydra.' },
      { name: 'oauth-pr-meta',    target: '/.well-known/oauth-protected-resource',    method: 'GET', description: 'OAuth Protected Resource Metadata (RFC 9728) + Hydra.' },
      { name: 'operations',       target: '/.well-known/operations',         method: 'GET',  description: 'Typed substrate-operation catalog — 8 kernel verbs + every thin-facade shim as cg:Affordance entries (FIX 4).' },
      { name: 'shacl-shapes',     target: '/.well-known/shacl-shapes',       method: 'GET',  description: 'SHACL shapes graph this relay\'s responses conform to.' },
      { name: 'health',           target: '/health',                         method: 'GET',  description: 'Relay liveness probe.' },
    ],
  });
  res.type('application/ld+json').json(entry);
});

// SHACL shapes graph — Turtle export of every shape the relay's
// responses reference via cg:conformsToShape. Lets validators verify
// any kernel-verb / shim payload without out-of-band schema lookup.
app.get('/.well-known/shacl-shapes', (_req, res) => {
  res.type('text/turtle').send(getShaclShapesTurtle());
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', css: CSS_URL, tools: Object.keys(TOOLS).length, auth: 'bearer-token', x402: true });
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

// ── /audit/* — compliance + lineage endpoints ──────────────
//
// Public (no auth required for now — they read public metadata only;
// add auth gating before exposing anything beyond read-only descriptor
// summaries). Each endpoint is a thin wrapper over the relay's
// existing pod-fetch + the compliance helpers in @interego/core.
//
// /audit/events — list recent descriptors on a pod (audit log).
// /audit/lineage — walk prov:wasDerivedFrom + cg:supersedes for one descriptor.
// /audit/compliance/:framework — generate a regulatory framework report.
// /audit/frameworks — list known frameworks + their controls.

app.get('/audit/frameworks', (_req, res) => {
  const frameworks = Object.entries(FRAMEWORK_CONTROLS).map(([name, controls]) => ({
    framework: name,
    controlCount: controls.length,
    controls: controls.map(c => ({ iri: c.iri, label: c.label })),
  }));
  res.json({ frameworks });
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
app.get('/inbox', async (req, res) => {
  const podUrl = req.query.pod as string | undefined;
  if (!podUrl) {
    res.status(400).json({
      error: 'pod_required',
      title: 'pod query parameter required',
      detail: 'GET /inbox?pod=https://your-pod.example/me/ — supplies the pod URL to scan. The relay does not know which pod is "yours" unless you tell it.',
    });
    return;
  }
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

app.get('/audit/events', async (req, res) => {
  const podUrl = req.query.pod as string | undefined;
  if (!podUrl) {
    res.status(400).json({
      error: 'pod_required',
      title: 'pod query parameter required',
      detail: 'GET /audit/events?pod=https://your-pod.example/me/ — supplies the pod URL to audit. The relay does not know which pod is "yours" unless you tell it.',
    });
    return;
  }
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

app.get('/audit/lineage', async (req, res) => {
  const descriptorUrl = req.query.descriptor as string | undefined;
  const podUrl = req.query.pod as string | undefined;
  if (!descriptorUrl) {
    res.status(400).json({ error: 'descriptor query param required' });
    return;
  }
  if (!podUrl) {
    res.status(400).json({
      error: 'pod_required',
      title: 'pod query parameter required',
      detail: 'GET /audit/lineage?descriptor=<url>&pod=https://your-pod.example/me/ — supplies the pod URL to walk lineage on. The relay does not know which pod is "yours" unless you tell it.',
    });
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
app.get('/audit/verify-signature', async (req, res) => {
  const descriptorUrl = req.query.descriptor as string | undefined;
  if (!descriptorUrl) {
    res.status(400).json({ error: 'descriptor query param required' });
    return;
  }
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

app.get('/audit/compliance/:framework', async (req, res) => {
  const framework = req.params.framework as ComplianceFramework;
  if (!['eu-ai-act', 'nist-rmf', 'soc2'].includes(framework)) {
    res.status(400).json({ error: `unknown framework; must be one of eu-ai-act / nist-rmf / soc2` });
    return;
  }
  const podUrl = req.query.pod as string | undefined;
  if (!podUrl) {
    res.status(400).json({
      error: 'pod_required',
      title: 'pod query parameter required',
      detail: 'GET /audit/compliance/:framework?pod=https://your-pod.example/me/ — supplies the pod URL to generate the report from. The relay does not know which pod is "yours" unless you tell it.',
    });
    return;
  }
  const auditPeriod = req.query.from && req.query.to
    ? { from: req.query.from as string, to: req.query.to as string }
    : undefined;
  try {
    const entries = await discover(podUrl, undefined, { fetch: solidFetch });
    // Map manifest entries → AuditableDescriptor. v1: derive evidence
    // citations from a (currently absent) cg:evidenceForControl predicate;
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
app.get('/identity-token', async (req, res) => {
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
app.post('/agents/:agentIri/revoke', async (req, res) => {
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

  const agentIri = decodeURIComponent(req.params['agentIri'] ?? '') as IRI;
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
        scope: `cg:authorizedAgent on ${podUrl}`,
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

app.post('/x402/set-price', async (req, res) => {
  const auth = await verifyBearerToken(req.headers.authorization);
  if (!auth.authenticated) { res.status(401).json({ error: auth.error }); return; }

  const { pod_url, amount, currency, address } = req.body;
  if (!pod_url || !amount || !currency || !address) {
    res.status(400).json({ error: 'pod_url, amount, currency, and address are required' });
    return;
  }
  PAYMENT_REQUIRED_PODS.set(pod_url, { amount, currency, address });
  res.json({ set: true, pod: pod_url, amount, currency });
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
      '@type': ['hydra:Resource', 'urn:cg:type:McpTool'],
      ...baseSchema,
      affordances: [
        {
          '@type': ['cg:Affordance', 'hydra:Operation'],
          action: `urn:cg:action:invoke:${name}`,
          target: `${base}/tool/${name}`,
          method: 'POST',
          expects: 'urn:cg:type:ToolInput',
          returns: 'urn:cg:type:ToolResult',
        },
      ],
    };
  });
  res.type('application/ld+json').json({
    '@context': KERNEL_JSONLD_CONTEXT,
    '@id': `${base}/tools`,
    '@type': ['hydra:Collection', 'urn:cg:type:McpToolCatalog'],
    conformsToShape: 'urn:cg:shape:McpToolCatalog',
    'hydra:totalItems': members.length,
    'hydra:member': members,
  });
});

// Call a tool directly via REST (auth enforced on write operations)
app.post('/tool/:name', async (req, res) => {
  const toolName = req.params.name;
  const tool = TOOLS[toolName];
  if (!tool) {
    res.status(404).type('application/ld+json').json({
      '@context': KERNEL_JSONLD_CONTEXT,
      '@type': ['hydra:Status', 'urn:cg:error:UnknownTool'],
      error: `Unknown tool: ${toolName}`,
    });
    return;
  }

  // Auth check for write operations
  if (AUTH_REQUIRED_TOOLS.has(toolName)) {
    const auth = await verifyBearerToken(req.headers.authorization);
    if (!auth.authenticated) {
      res.status(401).type('application/ld+json').json({
        '@context': KERNEL_JSONLD_CONTEXT,
        '@type': ['hydra:Status', 'urn:cg:error:Unauthorized'],
        error: 'Authentication required for write operations',
        detail: auth.error,
        hint: `POST ${IDENTITY_URL}/register to create an account and get a token`,
        affordances: [
          {
            '@type': ['cg:Affordance', 'hydra:Operation'],
            action: 'urn:cg:action:identity:register',
            target: `${IDENTITY_URL}/register`,
            method: 'POST',
          },
        ],
      });
      return;
    }
    // Inject authenticated identity into args if not provided
    if (!req.body.agent_id) req.body.agent_id = auth.agentId;
    if (!req.body.owner_webid) req.body.owner_webid = `${IDENTITY_URL}/users/${auth.userId}/profile#me`;
    if (!req.body.pod_name) req.body.pod_name = auth.userId;
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
      '@type': ['hydra:Status', 'urn:cg:error:ToolFailure'],
      error: (err as Error).message,
    });
  }
});

// SSE endpoint for MCP-over-SSE
app.get('/sse', (req, res) => {
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

// MCP JSON-RPC over POST (simplified — for tools/list and tools/call)
app.post('/messages', async (req, res) => {
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
    const tool = TOOLS[params?.name];
    if (!tool) {
      res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${params?.name}` } });
      return;
    }

    try {
      const result = await tool.handler(params?.arguments ?? {});
      res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result }] } });
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
function resolveAuthContext(req: express.Request): { agentId: string; ownerWebId: string; userId: string; podUrl?: string; identityToken?: string } | null {
  // OAuth-verified request: bearerAuth middleware already set req.auth
  const reqAuth = (req as express.Request & { auth?: { extra?: { agentId?: string; ownerWebId?: string; userId?: string; podUrl?: string; identityToken?: string } } }).auth;
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

const oauthBearer = requireBearerAuth({
  verifier: oauthProvider,
  requiredScopes: ['mcp'],
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
      if (!authInfo.scopes.includes('mcp')) {
        res.set('WWW-Authenticate', dpopWwwAuth('insufficient_scope', 'Required scope: mcp'));
        res.status(403).json({ error: 'insufficient_scope', error_description: 'Required scope: mcp' });
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
    // for the scope + expiry checks (it'll re-verify the token, harmless).
    oauthBearer(req, res, next);
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
  log(`IPFS: provider=${ORG_IPFS_PROVIDER} api-key-fp=${fingerprint(ORG_IPFS_API_KEY)}`);
  log(`Endpoints:`);
  log(`  GET  /health                                  Health check`);
  log(`  GET  /tools  |  POST /tool/:name              REST convenience`);
  log(`  POST /mcp                                     MCP Streamable HTTP (OAuth-gated)`);
  log(`  GET  /.well-known/oauth-authorization-server  OAuth metadata`);
  log(`  GET  /.well-known/oauth-protected-resource    Resource metadata`);
  log(`  GET  /.well-known/operations                  Substrate-operation catalog`);
  log(`  */authorize /token /register /revoke           OAuth endpoints (SDK)`);
});
