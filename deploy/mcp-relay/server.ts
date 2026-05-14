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
  ContextDescriptor,
  toTurtle,
  validate,
  publish,
  discover,
  subscribe,
  writeAgentRegistry,
  readAgentRegistry,
  writeDelegationCredential,
  verifyAgentDelegation,
  createOwnerProfile,
  addAuthorizedAgent,
  removeAuthorizedAgent,
  createDelegationCredential,
  fetchPodDirectory,
  publishPodDirectory,
  resolveWebFinger,
  pinToIpfs,
  cryptoComputeCid,
  generateKeyPair,
  fetchGraphContent,
  type EncryptionKeyPair,
  resolveRecipients,
  parseDistributionFromDescriptorTurtle,
  normalizePublishInputs,
  // Privacy hygiene (pre-publish content screening)
  screenForSensitiveContent,
  formatSensitivityWarning,
  // Compliance — framework reports + lineage walks for /audit/* endpoints
  checkComplianceInputs,
  generateFrameworkReport,
  walkLineage,
  FRAMEWORK_CONTROLS,
  loadOrCreateComplianceWallet,
  signDescriptor,
  verifyDescriptorSignature,
  predictDescriptorUrl,
  buildSecurityTxtFromEnv,
  buildAccessChangeEvent,
  type ComplianceFramework,
  type AuditableDescriptor,
  type PersistedComplianceWallet,
  type SignedDescriptor,
} from '@interego/core';

import type {
  IRI,
  ContextDescriptorData,
  OwnerProfileData,
  PodDirectoryData,
  PodDirectoryEntry,
  FetchFn,
  WebSocketConstructor,
  Subscription,
  ContextChangeEvent,
  ManifestEntry,
} from '@interego/core';

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
const oauthProvider = new InteregoOAuthProvider({
  identityUrl: IDENTITY_URL,
  tokenTtlSec: 3600,
});

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

async function handleGetPodStatus(args: ToolArgs): Promise<string> {
  const podUrl = args.pod_url as string;
  const entries = await discover(podUrl, undefined, { fetch: solidFetch }).catch(() => []);
  const profile = await readAgentRegistry(podUrl, { fetch: solidFetch }).catch(() => null);

  return JSON.stringify({
    pod: podUrl,
    css: CSS_URL,
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

// Simple in-memory pod registry for the relay
const knownPods: Map<string, { url: string; label?: string; owner?: string; via: string }> = new Map();

async function handleDiscoverAll(args: ToolArgs): Promise<string> {
  const pods = [...knownPods.values()];
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

async function handleListKnownPods(_args: ToolArgs): Promise<string> {
  return JSON.stringify([...knownPods.values()]);
}

async function handleAddPod(args: ToolArgs): Promise<string> {
  const url = args.pod_url as string;
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
  return JSON.stringify({ imported: directory.entries.length, added, total: knownPods.size });
}

async function handlePublishDirectory(args: ToolArgs): Promise<string> {
  const podName = (args.pod_name as string) ?? 'default';
  const podUrl = `${CSS_URL}${podName}/`;
  const entries: PodDirectoryEntry[] = [...knownPods.values()].map(p => ({
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

// ── Tool Registry ───────────────────────────────────────────

const TOOLS: Record<string, { description: string; handler: (args: ToolArgs) => Promise<string> }> = {
  // Core tools
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
};

// ── MCP Tool Schemas ────────────────────────────────────────
// Input schemas for each tool. Claude's LLM uses these to know how to call
// each tool; empty inputSchema means the model can never pick the right args.
// Property names match what each handler reads off args.

const TOOL_SCHEMAS = [
  {
    name: 'publish_context',
    description: 'Publish a context-annotated knowledge graph (Turtle) to your Solid pod with the full 6-facet descriptor (Temporal, Provenance, Agent, Semiotic, Trust, Federation). Attributes the descriptor to the pod owner and associates it with the calling agent.',
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
  },
  {
    name: 'discover_context',
    description: 'Discover context descriptors on a specific Solid pod. Optionally verify the agent delegation chain.',
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
  },
  {
    name: 'get_descriptor',
    description: 'Fetch the full Turtle content of a specific context descriptor.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL of the descriptor resource (ends in .ttl)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'get_pod_status',
    description: 'Check a Solid pod — owner, authorized agents, descriptor count, recent notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod URL (default: home pod for authenticated user)' },
      },
    },
  },
  {
    name: 'subscribe_to_pod',
    description: 'Subscribe to a pod\'s Solid Notifications channel; incoming changes accumulate in the relay\'s notification log.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod URL to subscribe to' },
      },
      required: ['pod_url'],
    },
  },
  {
    name: 'register_agent',
    description: 'Register an agent (delegate) on a pod on behalf of an owner. Creates the owner profile if missing, adds the agent with a delegation credential.',
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
  },
  {
    name: 'revoke_agent',
    description: 'Revoke an agent\'s delegation on a pod.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent IRI to revoke' },
        pod_name: { type: 'string', description: 'Pod name (default: authenticated user\'s pod)' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'verify_agent',
    description: 'Verify an agent\'s delegation chain on a pod — checks registry, credential, and non-revocation.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent IRI to verify' },
        pod_url: { type: 'string', description: 'Pod URL where the agent is registered' },
      },
      required: ['agent_id', 'pod_url'],
    },
  },
  {
    name: 'discover_all',
    description: 'Discover context descriptors across all pods currently in the relay\'s federation registry. Use add_pod or discover_directory first to populate.',
    inputSchema: {
      type: 'object',
      properties: {
        facet_type: { type: 'string', enum: ['Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation'], description: 'Filter by facet type' },
      },
    },
  },
  {
    name: 'list_known_pods',
    description: 'List pods in the relay\'s in-memory federation registry (home pod, manually added, directory-discovered, WebFinger-resolved).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_pod',
    description: 'Manually add a pod to the federation registry.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod URL to add' },
        label: { type: 'string', description: 'Human-readable label' },
        owner: { type: 'string', description: 'Owner WebID or name' },
      },
      required: ['pod_url'],
    },
  },
  {
    name: 'remove_pod',
    description: 'Remove a pod from the federation registry.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod URL to remove' },
      },
      required: ['pod_url'],
    },
  },
  {
    name: 'discover_directory',
    description: 'Import a PodDirectory graph and merge its entries into the federation registry.',
    inputSchema: {
      type: 'object',
      properties: {
        directory_url: { type: 'string', description: 'URL of a Turtle-encoded PodDirectory graph' },
      },
      required: ['directory_url'],
    },
  },
  {
    name: 'publish_directory',
    description: 'Publish the current federation registry as a PodDirectory graph on a pod.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_name: { type: 'string', description: 'Pod name to publish to (default: authenticated user)' },
        directory_id: { type: 'string', description: 'Optional directory IRI' },
      },
    },
  },
  {
    name: 'resolve_webfinger',
    description: 'Resolve a WebFinger resource identifier (acct:user@host) to its pod URL. Adds the pod to the registry on success.',
    inputSchema: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: 'WebFinger resource, e.g. acct:alice@example.com' },
      },
      required: ['resource'],
    },
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

function buildMcpServer(authContext: { agentId: string; ownerWebId?: string; userId?: string } | null): Server {
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
      if (!args.pod_url && authContext.userId) args.pod_url = `${CSS_URL}${authContext.userId}/`;
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
  // Legacy API-key path carries the default markj identity. Keep the agent
  // ID distinct from per-user OAuth-issued tokens so attributions stay
  // readable in prov:wasAssociatedWith.
  return {
    ok: true,
    authContext: {
      agentId: 'urn:agent:anthropic:relay-apikey:markj',
      ownerWebId: `${IDENTITY_URL}/users/markj/profile#me`,
      userId: 'markj',
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

// CORS: deliberately open origin, deliberately bounded by OAuth.
//
// Why `Access-Control-Allow-Origin: *`:
//   The MCP relay is consumed by browser-based clients (claude.ai
//   custom connectors, OpenAI plugin runtime, Cursor's web shell,
//   etc.) whose origins we do not enumerate or want to. The OAuth
//   2.1 + DCR flow already gates every state-changing call: the
//   browser obtains a bearer token only after the user authenticates
//   against THEIR pod's identity, and the bearer is bound to a
//   per-user agent IRI. CORS-open + OAuth-gated is the standard
//   pattern for MCP / OpenAPI services that serve browser clients.
//
// What this would not work for:
//   Cookie-based session auth. We don't use cookies; bearer tokens
//   in the Authorization header are required. Without that header
//   no request authenticates.
//
// What's still risk-bounded:
//   /audit/* endpoints are read-only public audit metadata (per
//   the comments at their declaration). /health is intentionally
//   public. /x402/price/:podName is public price discovery. Every
//   tool call that mutates state requires `verifyBearerToken`.
//
// Do NOT tighten this without re-validating that browser-based MCP
// clients still work — specifically claude.ai's custom-connector
// preflight + OpenAI's plugin runtime. Audit-relevant: this is an
// intentional design choice, not an oversight.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
  next();
});

// ── OAuth Routes ────────────────────────────────────────────
// mcpAuthRouter wires: /.well-known/oauth-authorization-server,
// /.well-known/oauth-protected-resource, /authorize, /token, /register,
// /revoke (optional). Uses our InteregoOAuthProvider for the business logic.
//
// issuerUrl must be the externally-reachable URL of this relay. If unset,
// we fall back to localhost (useful for local dev); deployments MUST set
// PUBLIC_BASE_URL to the true public URL.
const DEFAULT_ISSUER = new URL(PUBLIC_BASE_URL || `http://localhost:${PORT}`);
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
    agentId?: string;
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

  const redirect = new URL(result.redirectUri);
  redirect.searchParams.set('code', result.code);
  if (result.state) redirect.searchParams.set('state', result.state);
  res.json({ redirect: redirect.toString() });
});

// ── Browser-friendly landing page ─────────────────────────────────
//
// A non-technical user hitting the relay's root URL would otherwise
// see "Cannot GET /" — not actionable. This serves a minimal page
// pointing them at the right next step (configure their MCP client
// with the /sse URL; OAuth-led flow handles enrollment).

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

<p>Add this URL to your MCP-speaking agent runtime (Claude Code, Claude Desktop, Cursor, Windsurf, Hermes, OpenClaw, claude.ai connectors, etc.):</p>

<pre><strong>SSE endpoint:</strong>  <span id="sseUrl"></span>/sse
<strong>HTTP endpoint:</strong> <span id="mcpUrl"></span>/mcp</pre>

<p>Example MCP config (file location depends on your client):</p>

<pre>{
  "mcpServers": {
    "interego": {
      "url": "<span id="sseUrl2"></span>/sse"
    }
  }
}</pre>

<div class="note">
First call triggers an OAuth flow in your browser. You'll be asked to enroll a <strong>passkey</strong>, <strong>Ethereum wallet</strong>, or <strong>did:key</strong>. Your private keys never leave your device — no password, no email, no account database.
</div>

<h2>New to Interego, or just a person?</h2>
<p>You don't need an MCP client to start. Create an identity and pod directly — passkey or wallet, about 30 seconds — then point an agent at it later:</p>
<ul>
  <li><a href="${IDENTITY_URL}/">Overview &amp; sign-up</a> — what Interego is, and the human/agent paths</li>
  <li><a href="${IDENTITY_URL}/connect">Create my identity</a> — enroll a passkey or wallet now</li>
  <li><a href="https://github.com/markjspivey-xwisee/interego/blob/main/docs/FIRST-HOUR.md">First-hour walkthrough</a> · <a href="https://github.com/markjspivey-xwisee/interego/blob/main/docs/integrations/agent-runtime-integration.md">Runtime integration guide</a> (Hermes / OpenClaw / MCP)</li>
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
  for (const el of document.querySelectorAll('#sseUrl, #sseUrl2, #mcpUrl')) el.textContent = base;
</script>

<footer>
Open-source substrate · <a href="https://github.com/markjspivey-xwisee/interego">github</a> · this deployment is the maintainer's reference instance
</footer>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.type('text/html').send(RELAY_LANDING_HTML);
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
  const podUrl = (req.query.pod as string | undefined) ?? `${CSS_URL}markj/`;
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
  const podUrl = (req.query.pod as string | undefined) ?? `${CSS_URL}markj/`;
  if (!descriptorUrl) {
    res.status(400).json({ error: 'descriptor query param required' });
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
  const podUrl = (req.query.pod as string | undefined) ?? `${CSS_URL}markj/`;
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
app.get('/tools', (_req, res) => {
  res.json(Object.entries(TOOLS).map(([name, { description }]) => ({ name, description })));
});

// Call a tool directly via REST (auth enforced on write operations)
app.post('/tool/:name', async (req, res) => {
  const toolName = req.params.name;
  const tool = TOOLS[toolName];
  if (!tool) {
    res.status(404).json({ error: `Unknown tool: ${toolName}` });
    return;
  }

  // Auth check for write operations
  if (AUTH_REQUIRED_TOOLS.has(toolName)) {
    const auth = await verifyBearerToken(req.headers.authorization);
    if (!auth.authenticated) {
      res.status(401).json({
        error: 'Authentication required for write operations',
        detail: auth.error,
        hint: `POST ${IDENTITY_URL}/register to create an account and get a token`,
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
    res.json(JSON.parse(result));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
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
function resolveAuthContext(req: express.Request): { agentId: string; ownerWebId: string; userId: string } | null {
  // OAuth-verified request: bearerAuth middleware already set req.auth
  const reqAuth = (req as express.Request & { auth?: { extra?: { agentId?: string; ownerWebId?: string; userId?: string } } }).auth;
  if (reqAuth?.extra?.agentId && reqAuth.extra.ownerWebId && reqAuth.extra.userId) {
    return {
      agentId: reqAuth.extra.agentId,
      ownerWebId: reqAuth.extra.ownerWebId,
      userId: reqAuth.extra.userId,
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

// Custom /mcp gate: if the request has an Authorization header starting with
// the legacy API key, short-circuit past OAuth. Otherwise run the OAuth
// bearer middleware, which will either validate the token or return 401 with
// proper WWW-Authenticate so clients know to start the OAuth flow.
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
  oauthBearer(req, res, next);
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
  log(`/mcp auth: OAuth 2.1 + legacy Bearer <RELAY_MCP_API_KEY> fallback (${RELAY_MCP_API_KEY ? `enabled fp=${fingerprint(RELAY_MCP_API_KEY)}` : 'disabled — OAuth-only'})`);
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
  log(`  */authorize /token /register /revoke           OAuth endpoints (SDK)`);
});
