#!/usr/bin/env node
/**
 * @interego/mcp v0.4.1
 *
 * MCP server for federated context-annotated knowledge graphs.
 *
 * Identity model:
 *   Pod belongs to the OWNER (human/org, identified by WebID).
 *   Agent is a DELEGATE acting on the owner's behalf.
 *   Descriptors carry: wasAttributedTo → owner, wasAssociatedWith → agent.
 *
 * Federation:
 *   Supports multiple pods across multiple CSS instances.
 *   Three discovery approaches: known pods list, directory graphs, WebFinger.
 *
 * Config (env vars, all backwards compatible):
 *   CG_HOME_POD      — Full URL of the agent's home pod (takes precedence)
 *   CG_BASE_URL      — CSS base URL (fallback, combined with CG_POD_NAME)
 *   CG_POD_NAME      — Pod name on the CSS (fallback)
 *   CG_AGENT_ID      — Agent identity IRI
 *   CG_OWNER_WEBID   — Owner's WebID
 *   CG_OWNER_NAME    — Owner's display name
 *   CG_DID           — Agent's DID
 *   CG_KNOWN_PODS    — Comma-separated pod URLs for auto-discovery
 *   CG_DIRECTORY_URL  — URL of a PodDirectory graph to auto-load
 *   CG_PORT          — CSS port for local startup (default 3456)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { WebSocket } from 'ws';

import {
  ContextDescriptor,
  toTurtle,
  toJsonLdString,
  validate,
  intersection,
  union,
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
  sha256,
  // IPFS
  pinToIpfs,
  pinDescriptor,
  cryptoComputeCid,
  // PGSL
  createPGSL,
  mintAtom,
  ingest,
  pgslResolve,
  queryNeighbors,
  latticeStats,
  pgslToTurtle,
  embedInPGSL,
  liftToDescriptor,
  latticeMeet,
  isSubFragment,
  pullbackSquare,
  // Extraction + Computation + Affordance
  extractEntities,
  extractRelations,
  classifyQuestion,
  expandEntitiesWithOntology,
  computeCognitiveStrategy,
  parseDate,
  daysBetween,
  countUnique,
  shouldAbstain,
  // E2EE
  generateKeyPair,
  createEncryptedEnvelope,
  openEncryptedEnvelope,
  type EncryptionKeyPair,
  fetchGraphContent,
  parseDistributionFromDescriptorTurtle,
  // Cross-pod sharing
  resolveRecipients,
  // Publish-input preprocessing
  normalizePublishInputs,
  // Privacy hygiene (pre-publish content screening)
  screenForSensitiveContent,
  formatSensitivityWarning,
  // Compliance grade publish + framework reports + ECDSA signing
  checkComplianceInputs,
  loadOrCreateComplianceWallet,
  signDescriptor,
  predictDescriptorUrl,
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
  PGSLInstance,
  NodeProvenance,
} from '@interego/core';

import { PodRegistry, type KnownPod } from './pod-registry.js';

// ── Config ──────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_PORT = parseInt(process.env['CG_PORT'] ?? '3456');
const POD_NAME = process.env['CG_POD_NAME'] ?? 'agent';

// Home pod: explicit CG_HOME_POD, or computed from CG_BASE_URL + CG_POD_NAME
const BASE_URL = process.env['CG_BASE_URL'] ?? `http://localhost:${CSS_PORT}/`;
const HOME_POD = process.env['CG_HOME_POD'] ?? `${BASE_URL}${POD_NAME}/`;

const MY_AGENT_ID = (process.env['CG_AGENT_ID'] ?? 'urn:agent:claude-code:local') as IRI;
const MY_OWNER_WEBID = (process.env['CG_OWNER_WEBID'] ?? `https://id.example.com/${POD_NAME}/profile#me`) as IRI;
const MY_OWNER_NAME = process.env['CG_OWNER_NAME'] ?? undefined;
const MY_DID = (process.env['CG_DID'] ?? `did:web:${POD_NAME}.local`) as IRI;

const KNOWN_PODS_RAW = process.env['CG_KNOWN_PODS'] ?? '';
const DIRECTORY_URL = process.env['CG_DIRECTORY_URL'] ?? undefined;
const IDENTITY_SERVER_URL = process.env['CG_IDENTITY_URL']
  ?? 'https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io';

// IPFS config
const IPFS_PROVIDER = (process.env['CG_IPFS_PROVIDER'] ?? 'local') as 'pinata' | 'web3storage' | 'local';
const IPFS_API_KEY = process.env['CG_IPFS_API_KEY'] ?? '';
const IPFS_CONFIG = { provider: IPFS_PROVIDER, apiKey: IPFS_API_KEY } as const;

// Local mode: detect when running without cloud services
const IS_LOCAL = BASE_URL.includes('localhost') || BASE_URL.includes('127.0.0.1');
const IS_CLOUD = !IS_LOCAL;

// Progressive tool tiers
const TOOL_TIER = process.env['CG_TOOL_TIER'] ?? 'all';
const CORE_TOOLS = new Set(['publish_context', 'discover_context', 'get_descriptor', 'get_pod_status', 'subscribe_to_pod', 'analyze_question']);
const FEDERATION_TOOLS = new Set(['register_agent', 'revoke_agent', 'verify_agent', 'discover_all', 'subscribe_all', 'list_known_pods', 'add_pod', 'remove_pod', 'discover_directory', 'publish_directory', 'resolve_webfinger']);
const CRYPTO_TOOLS = new Set(['setup_identity', 'link_wallet', 'check_balance']);
const PGSL_TOOLS = new Set(['pgsl_ingest', 'pgsl_resolve', 'pgsl_lattice_status', 'pgsl_meet', 'pgsl_to_turtle']);

function isToolEnabled(toolName: string): boolean {
  if (TOOL_TIER === 'all') return true;
  if (TOOL_TIER === 'core') return CORE_TOOLS.has(toolName);
  if (TOOL_TIER === 'standard') return CORE_TOOLS.has(toolName) || FEDERATION_TOOLS.has(toolName);
  if (TOOL_TIER === 'full') return CORE_TOOLS.has(toolName) || FEDERATION_TOOLS.has(toolName) || CRYPTO_TOOLS.has(toolName);
  return true; // unknown tier = all
}

const CSS_CONFIG = resolve(__dirname, '..', 'examples', 'multi-agent', 'css-config.json');
// __dirname resolves to either mcp-server/ (when run via tsx on source) or
// mcp-server/dist/ (when run as compiled JS). Probe both locations and pick
// whichever actually has the binary. Env override wins if set.
const CSS_BIN = (() => {
  if (process.env.CG_CSS_BIN) return process.env.CG_CSS_BIN;
  const candidates = [
    resolve(__dirname, 'node_modules', '.bin', 'community-solid-server'),
    resolve(__dirname, '..', 'node_modules', '.bin', 'community-solid-server'),
  ];
  for (const p of candidates) {
    if (existsSync(p) || existsSync(p + '.cmd')) return p;
  }
  return candidates[1]; // default to sibling-of-dist path; detected later
})();

// ── State ───────────────────────────────────────────────────

const podRegistry = new PodRegistry();
let cssProcess: ChildProcess | null = null;
let cssReady = false;
// Sticky flag: once CSS has proven unreachable in this session, stop retrying.
// Reset only on explicit user action (there is none currently). Prevents every
// pod-touching tool from paying the 30s CSS-startup-timeout on systems that
// have no local CSS binary and no remote CSS configured.
let cssUnavailable = false;
let registryInitialized = false;
let notificationLog: ContextChangeEvent[] = [];
let lastPublishedDescriptor: ContextDescriptorData | null = null;

// ── Agent X25519 Keypair (for E2EE) ─────────────────────────
// Each agent has a persistent X25519 keypair (public + secret). The
// public key is registered on the user's pod as an authorizedAgent
// attribute so other authorized agents can wrap content keys for us.
// The secret key never leaves this host. Persisted next to the agent
// dist so it survives container rebuilds on the same volume; new
// keypair is generated on first use (written atomically).
const AGENT_KEY_PATH = (() => {
  if (process.env['CG_AGENT_KEY_FILE']) return process.env['CG_AGENT_KEY_FILE'];
  return resolve(__dirname, '..', `agent-key-${encodeURIComponent(MY_AGENT_ID)}.json`);
})();

const agentKeyPair: EncryptionKeyPair = (() => {
  try {
    if (existsSync(AGENT_KEY_PATH)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const parsed = JSON.parse(require('node:fs').readFileSync(AGENT_KEY_PATH, 'utf8'));
      if (parsed?.publicKey && parsed?.secretKey && parsed?.algorithm === 'X25519-XSalsa20-Poly1305') {
        return parsed as EncryptionKeyPair;
      }
    }
  } catch { /* fall through to fresh generation */ }
  const kp = generateKeyPair();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').writeFileSync(AGENT_KEY_PATH, JSON.stringify(kp, null, 2), { mode: 0o600 });
  } catch { /* best-effort; in-memory still works for this session */ }
  return kp;
})();

// ECDSA wallet for compliance-grade descriptor signing. Persisted next
// to the X25519 envelope key. Only used when publish_context is invoked
// with `compliance: true`. Loaded lazily on first compliance publish.
const COMPLIANCE_WALLET_PATH = process.env['CG_COMPLIANCE_WALLET_PATH']
  ?? AGENT_KEY_PATH.replace(/\.json$/, '-ecdsa.json');
// Cache the PROMISE, not the resolved wallet. Two concurrent
// compliance publishes that both arrive during cold-start would
// otherwise each call loadOrCreateComplianceWallet, which would either
// race to create the same file (whichever rename loses corrupts a
// freshly-generated key the other one wrote) or load it twice with
// different in-memory states. Caching the promise serializes all
// callers behind a single load.
let _complianceWalletPromise: Promise<PersistedComplianceWallet> | null = null;
async function ensureComplianceWallet(): Promise<PersistedComplianceWallet> {
  if (_complianceWalletPromise) return _complianceWalletPromise;
  _complianceWalletPromise = loadOrCreateComplianceWallet(
    COMPLIANCE_WALLET_PATH,
    `compliance-signer-${MY_AGENT_ID}`,
  ).catch((err) => {
    // On failure, clear the cache so the next caller retries fresh
    // rather than seeing the same rejected promise forever.
    _complianceWalletPromise = null;
    throw err;
  });
  return _complianceWalletPromise;
}

// PGSL state — the lattice persists across tool calls
const pgslProvenance: NodeProvenance = {
  wasAttributedTo: MY_OWNER_WEBID,
  generatedAtTime: new Date().toISOString(),
};
const pgslInstance: PGSLInstance = createPGSL(pgslProvenance);

// Initialize pod registry from config
podRegistry.add({ url: HOME_POD, isHome: true, discoveredVia: 'config' });
if (KNOWN_PODS_RAW) {
  for (const raw of KNOWN_PODS_RAW.split(',')) {
    const url = raw.trim();
    if (url) podRegistry.add({ url, isHome: false, discoveredVia: 'config' });
  }
}

// ── Logging (stderr only — stdout is MCP protocol) ──────────

function log(msg: string): void {
  process.stderr.write(`[context-graphs-mcp] ${msg}\n`);
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

// ── CSS Lifecycle ───────────────────────────────────────────

async function ensureCSS(): Promise<void> {
  if (cssReady) return;
  // cssUnavailable was previously a one-way latch — once set, the whole
  // MCP session was poisoned even if CSS recovered. That masked cold
  // starts and transient network blips. Now it's advisory: we retry on
  // each call, and fall through to the existing startup logic.
  if (cssUnavailable) {
    cssUnavailable = false;
  }

  const homePod = podRegistry.getHome()!;
  const homeUrl = new URL(homePod.url);

  // Check if CSS is already running. Bound the probe with a 5s
  // timeout — without this, a hung CSS instance (slow DNS, half-open
  // socket, slow remote pod URL) blocks the entire MCP server's
  // initialization indefinitely.
  let probeError: unknown = null;
  try {
    const resp = await fetch(homePod.url, { signal: AbortSignal.timeout(5000) });
    if (resp.ok || resp.status < 500) {
      cssReady = true;
      log(`CSS reachable at ${homePod.url}`);
      await ensurePod();
      return;
    }
    probeError = new Error(`probe status ${resp.status}`);
  } catch (err) {
    probeError = err;
    log(`CSS probe failed for ${homePod.url}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Only start local CSS if home pod is localhost
  if (homeUrl.hostname !== 'localhost' && homeUrl.hostname !== '127.0.0.1') {
    cssUnavailable = true;
    const detail = probeError instanceof Error ? probeError.message : String(probeError ?? 'unknown');
    throw new Error(`Cannot reach CSS at ${homePod.url} — ${detail}`);
  }

  // If the local CSS binary isn't present, skip immediately instead of
  // waiting 30s for the poll to time out on a spawn that will never start.
  if (!existsSync(CSS_BIN) && !existsSync(CSS_BIN + '.cmd')) {
    cssUnavailable = true;
    throw new Error(`Local CSS binary not found at ${CSS_BIN}`);
  }

  log(`Starting local CSS on port ${CSS_PORT}...`);

  return new Promise((res, rej) => {
    const proc = spawn(CSS_BIN, [
      '-c', CSS_CONFIG,
      '-p', String(CSS_PORT),
      '-l', 'warn',
      '--baseUrl', BASE_URL,
    ], { stdio: ['ignore', 'pipe', 'pipe'], shell: true });

    cssProcess = proc;
    let started = false;

    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text) log(`[css] ${text}`);
    });

    const poll = setInterval(async () => {
      if (started) { clearInterval(poll); return; }
      try {
        const resp = await fetch(homePod.url, { signal: AbortSignal.timeout(2000) });
        if (resp.ok || resp.status < 500) {
          clearInterval(poll);
          started = true;
          cssReady = true;
          log(`CSS ready at ${homePod.url}`);
          await ensurePod();
          res();
        }
      } catch { /* not ready */ }
    }, 400);

    setTimeout(() => {
      clearInterval(poll);
      if (!started) { cssUnavailable = true; rej(new Error('CSS startup timeout')); }
    }, 30_000);
  });
}

async function ensurePod(): Promise<void> {
  const homePod = podRegistry.getHome()!;
  await fetch(homePod.url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
    body: '',
  });
  // Ensure sub-containers exist
  for (const sub of ['anchors/']) {
    await fetch(`${homePod.url}${sub}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '',
    }).catch(() => {});
  }
  log(`Pod ready: ${homePod.url}`);
  // Auto-bootstrap: ensure agent is registered on the pod
  await ensureRegistry();
}

async function ensureRegistry(): Promise<void> {
  const homePod = podRegistry.getHome()!;

  // Check actual pod state — skip only if we've verified this session AND
  // we haven't been idle long enough for external changes
  if (registryInitialized) {
    // Quick re-check: is the registry still there?
    const check = await readAgentRegistry(homePod.url, { fetch: solidFetch });
    if (check && check.authorizedAgents.some(a => a.agentId === MY_AGENT_ID && !a.revoked)) {
      return; // still valid
    }
    log('Registry was deleted or agent removed — re-provisioning');
    registryInitialized = false;
  }

  let profile = await readAgentRegistry(homePod.url, { fetch: solidFetch });

  if (!profile) {
    log(`Creating agent registry for owner ${MY_OWNER_WEBID}`);
    profile = createOwnerProfile(MY_OWNER_WEBID, MY_OWNER_NAME);
  }

  const existing = profile.authorizedAgents.find(a => a.agentId === MY_AGENT_ID && !a.revoked);
  const existingHasKey = existing?.encryptionPublicKey === agentKeyPair.publicKey;

  if (!existing) {
    log(`Registering agent ${MY_AGENT_ID} on behalf of ${MY_OWNER_WEBID}`);
    profile = addAuthorizedAgent(profile, {
      agentId: MY_AGENT_ID,
      delegatedBy: MY_OWNER_WEBID,
      label: MY_AGENT_ID.includes('vscode') ? 'Claude Code (VS Code)' :
             MY_AGENT_ID.includes('desktop') ? 'Claude Code (Desktop)' :
             MY_AGENT_ID.includes('codex') ? 'Codex CLI' :
             'AI Agent',
      isSoftwareAgent: true,
      scope: 'ReadWrite',
      validFrom: new Date().toISOString(),
      encryptionPublicKey: agentKeyPair.publicKey,
    });

    await writeAgentRegistry(profile, homePod.url, { fetch: solidFetch });

    const agent = profile.authorizedAgents.find(a => a.agentId === MY_AGENT_ID)!;
    const credential = createDelegationCredential(profile, agent, homePod.url as IRI);
    await writeDelegationCredential(credential, homePod.url, { fetch: solidFetch });
    log(`Delegation credential written for ${MY_AGENT_ID}`);
  } else if (!existingHasKey) {
    // Agent was registered before we had a keypair (or key rotated). Re-register
    // with the current encryption key so other agents can encrypt to us.
    log(`Updating encryption key for existing agent ${MY_AGENT_ID}`);
    const updatedAgents = profile.authorizedAgents.map(a =>
      a.agentId === MY_AGENT_ID && !a.revoked
        ? { ...a, encryptionPublicKey: agentKeyPair.publicKey }
        : a,
    );
    profile = { ...profile, authorizedAgents: Object.freeze(updatedAgents) };
    await writeAgentRegistry(profile, homePod.url, { fetch: solidFetch });
  }

  registryInitialized = true;
  log(`Agent registry initialized — ${profile.authorizedAgents.filter(a => !a.revoked).length} active agent(s)`);
}

function stopCSS(): void {
  podRegistry.unsubscribeAll();
  if (cssProcess) {
    cssProcess.kill('SIGTERM');
    cssProcess = null;
    cssReady = false;
  }
}

// ── Tool implementations ────────────────────────────────────

async function toolPublishContext(args: {
  graph_iri: string;
  graph_content: string;
  descriptor_id?: string;
  confidence?: number;
  modal_status?: string;
  task_description?: string;
  valid_from?: string;
  valid_until?: string;
  target_pod?: string;
  share_with?: string[];
  /**
   * When true (default), look up any prior descriptor on the same pod
   * that describes the same graph_iri and add a cg:supersedes link to
   * it. This makes republishing-to-add-recipients cleanly mark the old
   * version as superseded so federation queries filter it out. Set to
   * false if you want multiple coexisting descriptors for the same
   * graph (e.g., different agents' perspectives on the same subject).
   */
  auto_supersede_prior?: boolean;
  /**
   * When true, this descriptor is "compliance grade" — used for
   * regulatory audit trails (EU AI Act, NIST RMF, SOC 2). Forces:
   * trust level upgraded to HighAssurance, modal status
   * Asserted/Counterfactual only (no Hypothetical), evidence
   * citations (e.g. soc2:satisfiesControl) recorded in the graph
   * content. The response carries a compliance check report.
   */
  compliance?: boolean;
  /**
   * Optional regulatory framework this descriptor provides evidence
   * for. Currently 'eu-ai-act' | 'nist-rmf' | 'soc2'.
   */
  compliance_framework?: 'eu-ai-act' | 'nist-rmf' | 'soc2';
}): Promise<string> {
  await ensureCSS();
  await ensureRegistry();

  const homePod = podRegistry.getHome()!;
  const podUrl = args.target_pod ?? homePod.url;
  const descId = (args.descriptor_id ?? `urn:cg:${POD_NAME}:${Date.now()}`) as IRI;
  const now = new Date().toISOString();

  // Privacy-hygiene preflight: scan content for credentials, PII, etc.
  // We always WARN. We don't block automatically — the calling agent
  // decides. The warning is appended to the response so any LLM in the
  // loop sees it and can decide to surface to the user. See
  // docs://interego/playbook §2 for the agent-side guidance.
  const sensitivityFlags = screenForSensitiveContent(args.graph_content ?? '');
  const sensitivityWarning = formatSensitivityWarning(sensitivityFlags);

  // Auto-supersede: if previous descriptor(s) on this pod describe the
  // same graph_iri, our new one supersedes them. Disabled with
  // auto_supersede_prior: false. Failure is non-fatal — we just publish
  // without the supersedes link if discovery fails.
  const priorVersions: IRI[] = [];
  if (args.auto_supersede_prior !== false) {
    try {
      const entries = await discover(podUrl, undefined, { fetch: solidFetch });
      for (const e of entries) {
        if (e.describes.includes(args.graph_iri as IRI) && e.descriptorUrl !== descId) {
          priorVersions.push(e.descriptorUrl as IRI);
        }
      }
    } catch {
      // Manifest not yet present, or pod unreachable — proceed without supersedes.
    }
  }

  // L1 protocol preprocessing — modal-truth consistency + cleartext
  // mirror (spec/architecture.md §5.2.2 + spec/revocation.md §1).
  // Consolidated into @interego/core so relay + MCP-server paths
  // produce identical descriptors for identical inputs.
  const preprocessed = normalizePublishInputs({
    modalStatus: args.modal_status as 'Asserted' | 'Hypothetical' | 'Counterfactual' | undefined,
    confidence: args.confidence,
    graphContent: args.graph_content,
  });

  const builder = ContextDescriptor.create(descId)
.describes(args.graph_iri as IRI)
.temporal({
      validFrom: args.valid_from ?? now,
      validUntil: args.valid_until,
    })
.validFrom(args.valid_from ?? now)
.delegatedBy(MY_OWNER_WEBID, MY_AGENT_ID, {
      endedAt: now,
      derivedFrom: preprocessed.wasDerivedFrom.length > 0 ? preprocessed.wasDerivedFrom : undefined,
    })
.semiotic(preprocessed.semiotic)
.trust(await (async () => {
      const baseTrust = {
        // Compliance grade upgrades trust to HighAssurance; otherwise default
        // SelfAsserted (caller's own claim, no third-party attestation).
        trustLevel: (args.compliance ? 'CryptographicallyVerified' : 'SelfAsserted') as 'CryptographicallyVerified' | 'SelfAsserted',
        issuer: MY_OWNER_WEBID,
        verifiableCredential: `${podUrl}credentials/${encodeURIComponent(MY_AGENT_ID)}.jsonld` as IRI,
      };
      if (!args.compliance) return baseTrust;
      // For compliance descriptors: embed cg:proof reference BEFORE
      // serialization so the signed Turtle carries the self-referential
      // proof URL. Tampering with cg:proof invalidates the signature.
      const predicted = predictDescriptorUrl(podUrl, descId);
      const cw = await ensureComplianceWallet();
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
  if (args.valid_until) builder.validUntil(args.valid_until);
  // Union the auto-detected prior versions with any cg:supersedes
  // explicitly carried in the graph content. Both contribute.
  const allSupersedes = [...new Set([...preprocessed.supersedes, ...priorVersions])];
  if (allSupersedes.length > 0) builder.supersedes(...allSupersedes);
  if (preprocessed.conformsTo.length > 0) builder.conformsTo(...preprocessed.conformsTo);

  const descriptor = builder.build();
  const validation = validate(descriptor);
  if (!validation.conforms) {
    return `Validation failed: ${validation.violations.map(v => v.message).join('; ')}`;
  }

  // E2EE: wrap graph content in an nacl envelope keyed to every authorized
  // agent with a registered encryption public key. Only agents with a key
  // in the registry can decrypt — CSS / Azure Files / IPFS pin see only
  // ciphertext. When the registry has no keyed agents yet (bootstrap), we
  // fall back to plaintext publish so the very first writes aren't locked
  // out of themselves. The descriptor metadata (facets, manifest entry)
  // stays plaintext so discovery queries work across federation.
  const currentProfile = await readAgentRegistry(podUrl, { fetch: solidFetch });
  const recipients = (currentProfile?.authorizedAgents ?? [])
    .filter(a => !a.revoked && a.encryptionPublicKey)
    .map(a => a.encryptionPublicKey!) as string[];
  // Include our own key so we can read back our own publish in later sessions
  if (!recipients.includes(agentKeyPair.publicKey)) recipients.push(agentKeyPair.publicKey);

  // Cross-pod sharing: for each handle in share_with, resolve to their pod's
  // agent registry and union their agents' encryption keys into recipients.
  // This graph then becomes decryptable by those other people's agents too —
  // per-graph opt-in, no pod-level ACL change needed, fully federated.
  //
  // We cap the share_with array at SHARE_WITH_MAX entries. Without a cap,
  // a caller (or LLM with too much enthusiasm) could pass thousands of
  // handles — each triggers a pod-resolution fetch + key extraction; the
  // request would O(N) the relay's network budget and inflate the envelope
  // to N wrapped keys. 50 is generous for legitimate cross-pod sharing
  // (family / small team) and refuses pathological inputs early with a
  // clear error rather than silently degrading.
  const SHARE_WITH_MAX = 50;
  if (args.share_with && args.share_with.length > SHARE_WITH_MAX) {
    throw new Error(
      `share_with cap exceeded: ${args.share_with.length} handles supplied, max ${SHARE_WITH_MAX}. ` +
      `For larger groups, publish via a group-list descriptor and have recipients subscribe — ` +
      `per-publish sharing is designed for small numbers of direct recipients.`,
    );
  }
  const shareResolved: { handle: string; podUrl: string; agentCount: number }[] = [];
  if (args.share_with && args.share_with.length > 0) {
    const resolved = await resolveRecipients(args.share_with, { fetch: solidFetch });
    for (const r of resolved) {
      shareResolved.push({ handle: r.handle, podUrl: r.podUrl, agentCount: r.agentEncryptionKeys.length });
      for (const key of r.agentEncryptionKeys) {
        if (!recipients.includes(key)) recipients.push(key);
      }
    }
  }

  const publishOptions: Parameters<typeof publish>[3] = recipients.length > 0
    ? { fetch: solidFetch, encrypt: { recipients, senderKeyPair: agentKeyPair } }
    : { fetch: solidFetch };
  const result = await publish(descriptor, args.graph_content, podUrl, publishOptions);
  lastPublishedDescriptor = descriptor;

  const lines = [
    `Published to ${podUrl}`,
    `  Owner: ${MY_OWNER_WEBID}`,
    `  Agent: ${MY_AGENT_ID}`,
    `  Descriptor: ${result.descriptorUrl}`,
    `  Graph: ${result.graphUrl}${result.encrypted ? ' [encrypted envelope]' : ''}`,
    `  Manifest: ${result.manifestUrl}`,
    `  Facets: ${descriptor.facets.map(f => f.type).join(', ')}`,
    `  Confidence: ${args.confidence ?? 0.85}`,
    `  E2EE: ${result.encrypted ? `yes (${recipients.length} recipient(s))` : 'no (no keyed agents in registry; publish plaintext)'}`,
    ...(shareResolved.length > 0 ? [
      `  Shared with:`,
      ...shareResolved.map(s => `    ${s.handle} → ${s.podUrl || 'UNRESOLVED'} (${s.agentCount} agent(s))`),
    ] : []),
    ...(priorVersions.length > 0 ? [
      `  Supersedes prior versions for this graph_iri:`,
      ...priorVersions.map(p => `    ${p}`),
    ] : []),
    args.task_description ? `  Task: ${args.task_description}` : '',
  ];

  // Pin to IPFS if configured
  const turtle = toTurtle(descriptor);
  let ipfsCid: string | undefined;
  let ipfsUrl: string | undefined;
  let ipfsProvider: string = 'local';

  if (IPFS_PROVIDER !== 'local') {
    try {
      const pinResult = await pinToIpfs(turtle, `descriptor-${descriptor.id}`, IPFS_CONFIG, solidFetch);
      ipfsCid = pinResult.cid;
      ipfsUrl = pinResult.url;
      ipfsProvider = pinResult.provider;
      lines.push(`  IPFS: ${ipfsCid}`);
      lines.push(`  IPFS URL: ${ipfsUrl}`);
      lines.push(`  IPFS Provider: ${ipfsProvider}`);
    } catch (err) {
      lines.push(`  IPFS: failed — ${(err as Error).message}`);
    }
  } else {
    ipfsCid = cryptoComputeCid(turtle);
    ipfsProvider = 'local';
    lines.push(`  CID (local): ${ipfsCid}`);
  }

  // Write anchor receipt to pod (zero-copy: only metadata, not content)
  log(`Building anchor receipt for ${result.descriptorUrl}`);
  const anchor = {
    descriptorUrl: result.descriptorUrl,
    graphUrl: result.graphUrl,
    descriptorId: descriptor.id,
    publishedAt: new Date().toISOString(),
    publishedBy: MY_AGENT_ID,
    onBehalfOf: MY_OWNER_WEBID,
    ipfs: ipfsCid ? { cid: ipfsCid, url: ipfsUrl, provider: ipfsProvider } : undefined,
    contentHash: typeof sha256 === 'function' ? sha256(turtle) : 'unavailable',
    facetTypes: descriptor.facets.map(f => f.type),
    confidence: (descriptor.facets.find(f => f.type === 'Semiotic') as any)?.epistemicConfidence,
    modalStatus: (descriptor.facets.find(f => f.type === 'Semiotic') as any)?.modalStatus,
  };

  try {
    const slug = result.descriptorUrl.split('/').pop()?.replace('.ttl', '');
    const anchorUrl = `${podUrl}anchors/${slug}.json`;
    log(`Writing anchor to ${anchorUrl}`);
    const anchorResp = await fetch(anchorUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(anchor, null, 2),
    });
    if (anchorResp.ok) {
      lines.push(`  Anchor: ${anchorUrl}`);
    } else {
      const errText = await anchorResp.text().catch(() => '');
      log(`Anchor write failed: ${anchorResp.status} ${anchorResp.statusText} ${errText}`);
      lines.push(`  Anchor: failed (${anchorResp.status})`);
    }
  } catch (err) {
    log(`Anchor write error: ${(err as Error).message}\n${(err as Error).stack}`);
  }

  lines.push('', 'Turtle:', turtle);

  // Append privacy-hygiene preflight warning (if any) so the calling
  // agent — and any LLM in the loop — sees that sensitive content was
  // detected. We don't block; the agent + user decide. See
  // docs://interego/playbook §2.
  if (sensitivityWarning) {
    lines.push(sensitivityWarning);
  }

  // Compliance-grade check (when args.compliance === true).
  // Signs the descriptor turtle with the agent's ECDSA wallet,
  // writes a sibling .sig.json next to the descriptor, and reports
  // compliance status. Signing failure is non-fatal (logged + reported).
  if (args.compliance) {
    let signed: SignedDescriptor | null = null;
    let signError: string | null = null;
    let sigIpfsCid: string | null = null;
    try {
      const cw = await ensureComplianceWallet();
      signed = await signDescriptor(descriptor.id, turtle, cw.wallet);
      // Persist the signature alongside the descriptor on the pod, at
      // <descriptor-url>.sig.json (Content-Type: application/json).
      const sigUrl = `${result.descriptorUrl}.sig.json`;
      const sigBody = JSON.stringify(signed, null, 2);
      const sigResp = await solidFetch(sigUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: sigBody,
      });
      if (!sigResp.ok) {
        signError = `signature stored locally but pod write failed (${sigResp.status})`;
      }
      lines.push(`  Signature: ${sigUrl}`);
      lines.push(`    Signer:    ${signed.signerAddress}`);
      lines.push(`    SignedAt:  ${signed.signedAt}`);

      // Auto-pin the signature to IPFS too (compliance descriptors get
      // their full audit pair publicly anchored when a pin provider is
      // configured). Failure is non-fatal — local CID still computed.
      if (IPFS_PROVIDER !== 'local') {
        try {
          const sigPin = await pinToIpfs(sigBody, `signature-${descriptor.id}`, IPFS_CONFIG, solidFetch);
          sigIpfsCid = sigPin.cid;
          lines.push(`    SigCID:    ${sigIpfsCid}`);
        } catch (err) {
          lines.push(`    SigPin:    failed (${(err as Error).message})`);
        }
      }
    } catch (err) {
      signError = (err as Error).message;
    }

    const check = checkComplianceInputs({
      modalStatus: preprocessed.semiotic.modalStatus,
      trustLevel: 'CryptographicallyVerified',
      hasSignature: signed !== null,
      framework: args.compliance_framework,
    });
    lines.push('');
    lines.push(`-- Compliance grade ${args.compliance_framework ?? '(framework unspecified)'}: ${check.compliant ? 'PASS' : 'PARTIAL'} --`);
    if (signError) lines.push(`  Sign error: ${signError}`);
    if (check.violations.length > 0) {
      lines.push(`Violations:`);
      for (const v of check.violations) lines.push(`  ${v}`);
    }
    if (check.upgradedFacets.length > 0) {
      lines.push(`Auto-upgraded facets:`);
      for (const u of check.upgradedFacets) lines.push(`  ${u}`);
    }
  }

  return lines.filter(Boolean).join('\n');
}

async function toolDiscoverContext(args: {
  pod_url: string;
  facet_type?: string;
  valid_from?: string;
  valid_until?: string;
  effective_at?: string;
  verify_delegation?: boolean;
}): Promise<string> {
  await ensureCSS();

  const filter: Record<string, unknown> = {};
  if (args.facet_type) filter.facetType = args.facet_type;
  if (args.valid_from) filter.validFrom = args.valid_from;
  if (args.valid_until) filter.validUntil = args.valid_until;
  if (args.effective_at) filter.effectiveAt = args.effective_at;

  const entries = await discover(
    args.pod_url,
    Object.keys(filter).length > 0 ? filter as Parameters<typeof discover>[1] : undefined,
    { fetch: solidFetch },
  );

  if (entries.length === 0) {
    return `No context descriptors found on ${args.pod_url}`;
  }

  const lines: string[] = [`Found ${entries.length} descriptor(s) on ${args.pod_url}:`, ''];

  if (args.verify_delegation) {
    const profile = await readAgentRegistry(args.pod_url, { fetch: solidFetch });
    if (profile) {
      lines.push(`  Pod owner: ${profile.webId}${profile.name ? ` (${profile.name})` : ''}`);
      lines.push(`  Authorized agents: ${profile.authorizedAgents.filter(a => !a.revoked).length}`);
      for (const a of profile.authorizedAgents.filter(a => !a.revoked)) {
        lines.push(`    - ${a.agentId} [${a.scope}]${a.label ? ` — ${a.label}` : ''}`);
      }
      lines.push('');
    } else {
      lines.push('  No agent registry found — delegation unverifiable');
      lines.push('');
    }
  }

  for (const entry of entries) {
    lines.push(`  ${entry.descriptorUrl}`);
    lines.push(`    Describes: ${entry.describes.join(', ')}`);
    lines.push(`    Facets: ${entry.facetTypes.join(', ')}`);
    // L2 fix (see post-run findings 2026-04-20): surface modalStatus +
    // trustLevel in the discover summary so federation clients can
    // filter on them without having to fetch each full descriptor.
    if (entry.modalStatus) lines.push(`    Modal: ${entry.modalStatus}`);
    if (entry.trustLevel) lines.push(`    Trust: ${entry.trustLevel}`);
    if (entry.validFrom) lines.push(`    Valid: ${entry.validFrom} — ${entry.validUntil ?? '...'}`);
    lines.push('');
  }

  // Touch the pod in registry
  podRegistry.touch(args.pod_url);

  return lines.join('\n');
}

async function toolGetDescriptor(args: { url: string }): Promise<string> {
  await ensureCSS();
  // If the caller passes a graph payload URL (.envelope.jose.json or .trig),
  // route through fetchGraphContent which handles envelope decryption for
  // the recipients of this agent's key. Descriptor .ttl URLs return as-is.
  if (args.url.endsWith('.envelope.jose.json') || args.url.endsWith('.trig')) {
    const { content, encrypted, mediaType } = await fetchGraphContent(args.url, {
      fetch: solidFetch,
      recipientKeyPair: agentKeyPair,
    });
    if (content === null && encrypted) {
      return `Fetched ${args.url} but this agent (${MY_AGENT_ID}) is not a recipient — no wrapped key matches its public key. Add its encryption key to the pod's agent registry to decrypt.`;
    }
    const tag = encrypted ? ' [decrypted envelope]' : '';
    return `Graph at ${args.url} (${content?.length ?? 0} bytes, ${mediaType})${tag}:\n\n${content ?? ''}`;
  }
  const resp = await fetch(args.url, { headers: { 'Accept': 'text/turtle' } });
  if (!resp.ok) {
    return `Failed to fetch ${args.url}: ${resp.status} ${resp.statusText}`;
  }
  const turtle = await resp.text();

  // HATEOAS: follow cg:hasDistribution link from the descriptor to its
  // graph payload instead of assuming a naming convention. Descriptor
  // self-describes where the payload lives, what media type it serves,
  // and whether it's encrypted — matches DCAT + Hydra semantics.
  let graphBlock = '';
  const link = parseDistributionFromDescriptorTurtle(turtle);
  if (link) {
    try {
      const { content, encrypted } = await fetchGraphContent(link.accessURL, {
        fetch: solidFetch,
        recipientKeyPair: agentKeyPair,
      });
      if (content !== null) {
        graphBlock = `\n\n── Graph payload (${encrypted ? 'decrypted envelope' : 'plaintext'}, ${content.length} bytes, ${link.mediaType}) ──\n${link.accessURL}\n\n${content}`;
      } else if (encrypted) {
        graphBlock = `\n\n── Graph payload at ${link.accessURL}: encrypted, this agent is not a recipient ──`;
      }
    } catch { /* link present but fetch failed — return descriptor alone */ }
  }

  return `Descriptor at ${args.url} (${turtle.length} bytes):\n\n${turtle}${graphBlock}`;
}

async function toolGetPodStatus(args: { pod_url?: string }): Promise<string> {
  await ensureCSS();
  await ensureRegistry();

  const homePod = podRegistry.getHome()!;
  const podUrl = args.pod_url ?? homePod.url;
  const isHome = podUrl === homePod.url;

  const lines: string[] = [
    `Pod: ${podUrl}`,
    `Owner: ${isHome ? MY_OWNER_WEBID : '(check registry)'}`,
    `Agent: ${isHome ? MY_AGENT_ID : '(remote pod)'}`,
    `CSS: ${cssReady ? 'running' : 'stopped'}`,
    '',
  ];

  try {
    const profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
    if (profile) {
      lines.push(`Registry:`);
      lines.push(`  Owner: ${profile.webId}${profile.name ? ` (${profile.name})` : ''}`);
      const active = profile.authorizedAgents.filter(a => !a.revoked);
      lines.push(`  Agents: ${active.length} active`);
      for (const a of active) {
        lines.push(`    ${a.agentId} [${a.scope}]${a.label ? ` — ${a.label}` : ''}`);
      }
    } else {
      lines.push('Registry: not found');
    }
  } catch (err) {
    lines.push(`Registry: ${(err as Error).message}`);
  }

  lines.push('');

  try {
    const entries = await discover(podUrl, undefined, { fetch: solidFetch });
    lines.push(`Descriptors: ${entries.length}`);
    for (const e of entries) {
      lines.push(`  ${e.descriptorUrl}`);
      lines.push(`    Graphs: ${e.describes.join(', ')}`);
      lines.push(`    Facets: ${e.facetTypes.join(', ')}`);
    }
  } catch (err) {
    lines.push(`Manifest: ${(err as Error).message}`);
  }

  if (notificationLog.length > 0) {
    lines.push('');
    lines.push(`Recent notifications (${notificationLog.length}):`);
    for (const n of notificationLog.slice(-5)) {
      lines.push(`  [${n.type}] ${n.resource} at ${n.timestamp}`);
    }
  }

  return lines.join('\n');
}

// Per-process cap on simultaneous WebSocket subscriptions. Each
// open subscription is a long-lived WebSocket; without a cap a
// long-running MCP session could accumulate hundreds of them as the
// agent explores federation. Default 32 — generous for normal use,
// finite for resource bounding. Override via CG_MAX_SUBSCRIPTIONS.
const MAX_SUBSCRIPTIONS = parseInt(process.env['CG_MAX_SUBSCRIPTIONS'] ?? '32', 10);

async function toolSubscribeToPod(args: { pod_url: string }): Promise<string> {
  await ensureCSS();

  const existing = podRegistry.get(args.pod_url);
  if (existing?.subscription) {
    return `Already subscribed to ${args.pod_url}`;
  }

  if (podRegistry.activeSubscriptionCount >= MAX_SUBSCRIPTIONS) {
    return `Subscription cap reached (${MAX_SUBSCRIPTIONS} active). Call unsubscribe_from_pod on a pod you no longer need, or raise CG_MAX_SUBSCRIPTIONS.`;
  }

  try {
    const sub = await subscribe(args.pod_url, (event: ContextChangeEvent) => {
      notificationLog.push(event);
      log(`[notification] ${event.type} on ${event.resource}`);
    }, {
      fetch: solidFetch,
      WebSocket: WebSocket as unknown as WebSocketConstructor,
    });

    podRegistry.setSubscription(args.pod_url, sub);
    return `Subscribed to ${args.pod_url} via WebSocket. (${podRegistry.activeSubscriptionCount}/${MAX_SUBSCRIPTIONS} active.)`;
  } catch (err) {
    return `Failed to subscribe to ${args.pod_url}: ${(err as Error).message}`;
  }
}

async function toolUnsubscribeFromPod(args: { pod_url: string }): Promise<string> {
  const closed = podRegistry.unsubscribe(args.pod_url);
  if (!closed) {
    return `No active subscription on ${args.pod_url}.`;
  }
  return `Unsubscribed from ${args.pod_url}. (${podRegistry.activeSubscriptionCount}/${MAX_SUBSCRIPTIONS} active.)`;
}

async function toolRegisterAgent(args: {
  agent_id: string;
  label?: string;
  scope?: string;
  valid_until?: string;
  pod_url?: string;
}): Promise<string> {
  await ensureCSS();
  await ensureRegistry();

  const homePod = podRegistry.getHome()!;
  const podUrl = args.pod_url ?? homePod.url;

  let profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
  if (!profile) {
    profile = createOwnerProfile(MY_OWNER_WEBID, MY_OWNER_NAME);
  }

  const scope = (args.scope ?? 'ReadWrite') as 'ReadWrite' | 'ReadOnly' | 'PublishOnly' | 'DiscoverOnly';

  try {
    profile = addAuthorizedAgent(profile, {
      agentId: args.agent_id as IRI,
      delegatedBy: MY_OWNER_WEBID,
      label: args.label,
      isSoftwareAgent: true,
      scope,
      validFrom: new Date().toISOString(),
      validUntil: args.valid_until,
    });
  } catch (err) {
    return (err as Error).message;
  }

  await writeAgentRegistry(profile, podUrl, { fetch: solidFetch });

  const agent = profile.authorizedAgents.find(a => a.agentId === args.agent_id)!;
  const credential = createDelegationCredential(profile, agent, podUrl as IRI);
  const credUrl = await writeDelegationCredential(credential, podUrl, { fetch: solidFetch });

  return [
    `Registered agent ${args.agent_id}`,
    `  Delegated by: ${MY_OWNER_WEBID}`,
    `  Scope: ${scope}`,
    `  Credential: ${credUrl}`,
    `  Registry: ${podUrl}agents`,
  ].join('\n');
}

async function toolRevokeAgent(args: { agent_id: string; pod_url?: string }): Promise<string> {
  await ensureCSS();

  const homePod = podRegistry.getHome()!;
  const podUrl = args.pod_url ?? homePod.url;

  let profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
  if (!profile) {
    return 'No agent registry found on this pod.';
  }

  profile = removeAuthorizedAgent(profile, args.agent_id as IRI);
  await writeAgentRegistry(profile, podUrl, { fetch: solidFetch });

  return `Revoked delegation for ${args.agent_id}. Agent can no longer act on behalf of ${MY_OWNER_WEBID}.`;
}

async function toolVerifyAgent(args: {
  agent_id: string;
  pod_url: string;
}): Promise<string> {
  await ensureCSS();

  const result = await verifyAgentDelegation(
    args.agent_id as IRI,
    args.pod_url,
    { fetch: solidFetch },
  );

  if (result.valid) {
    // L2 clarification (see post-run findings 2026-04-20): registry
    // membership ≠ envelope-recipient eligibility. An agent without a
    // registered cg:encryptionPublicKey is authorized to act but
    // CANNOT decrypt new envelopes (because publish excludes agents
    // missing a public key from recipient-set composition). Surface
    // this distinction explicitly so clients don't assume valid →
    // readable.
    const profile = await readAgentRegistry(args.pod_url, { fetch: solidFetch }).catch(() => null);
    const entry = profile?.authorizedAgents.find(a => a.agentId === result.agent);
    const canDecrypt = Boolean(entry?.encryptionPublicKey);
    return [
      `VALID — Agent ${result.agent} is authorized`,
      `  Owner: ${result.owner}`,
      `  Scope: ${result.scope}`,
      `  Pod: ${args.pod_url}`,
      `  Can decrypt new envelopes: ${canDecrypt ? 'YES' : 'NO — no cg:encryptionPublicKey on file. Agent can act (per scope) but cannot read E2EE payloads addressed to recipients registered after its enrollment.'}`,
    ].join('\n');
  } else {
    return [
      `INVALID — ${result.reason}`,
      `  Agent: ${result.agent}`,
      result.owner ? `  Owner: ${result.owner}` : '',
      `  Pod: ${args.pod_url}`,
    ].filter(Boolean).join('\n');
  }
}

// ── NEW: Multi-pod federation tools ──────────────────────────

async function toolDiscoverAll(args: {
  facet_type?: string;
  valid_from?: string;
  valid_until?: string;
  verify_delegation?: boolean;
}): Promise<string> {
  await ensureCSS();

  const pods = podRegistry.list();
  const allResults: Array<{ pod: KnownPod; entries: ManifestEntry[]; error?: string }> = [];

  await Promise.allSettled(pods.map(async (pod) => {
    try {
      const filter: Record<string, unknown> = {};
      if (args.facet_type) filter.facetType = args.facet_type;
      if (args.valid_from) filter.validFrom = args.valid_from;
      if (args.valid_until) filter.validUntil = args.valid_until;

      const entries = await discover(
        pod.url,
        Object.keys(filter).length > 0 ? filter as Parameters<typeof discover>[1] : undefined,
        { fetch: solidFetch },
      );
      podRegistry.touch(pod.url);
      allResults.push({ pod, entries });
    } catch (err) {
      allResults.push({ pod, entries: [], error: (err as Error).message });
    }
  }));

  const totalEntries = allResults.reduce((sum, r) => sum + r.entries.length, 0);
  const lines: string[] = [
    `Discovered ${totalEntries} descriptor(s) across ${pods.length} pod(s):`,
    '',
  ];

  for (const r of allResults) {
    const tag = r.pod.isHome ? ' [HOME]' : '';
    const label = r.pod.label ? ` (${r.pod.label})` : '';
    lines.push(`${r.pod.url}${tag}${label}`);

    if (r.error) {
      lines.push(`  Error: ${r.error}`);
    } else if (r.entries.length === 0) {
      lines.push(`  (no descriptors)`);
    } else {
      for (const entry of r.entries) {
        lines.push(`  ${entry.descriptorUrl}`);
        lines.push(`    Describes: ${entry.describes.join(', ')}`);
        lines.push(`    Facets: ${entry.facetTypes.join(', ')}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function toolSubscribeAll(_args: Record<string, never>): Promise<string> {
  await ensureCSS();

  const pods = podRegistry.list();
  const results: string[] = [];
  let subscribed = 0;
  let skipped = 0;
  let failed = 0;

  for (const pod of pods) {
    if (pod.subscription) {
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
      podRegistry.setSubscription(pod.url, sub);
      subscribed++;
    } catch (err) {
      results.push(`  Failed: ${pod.url} — ${(err as Error).message}`);
      failed++;
    }
  }

  return [
    `Subscribe all: ${subscribed} new, ${skipped} already subscribed, ${failed} failed`,
...results,
  ].join('\n');
}

async function toolListKnownPods(_args: Record<string, never>): Promise<string> {
  const pods = podRegistry.list();
  if (pods.length === 0) return 'No known pods.';

  const lines: string[] = [`Known pods (${pods.length}):`, ''];

  for (const pod of pods) {
    const flags: string[] = [];
    if (pod.isHome) flags.push('HOME');
    if (pod.subscription) flags.push('SUBSCRIBED');
    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    const label = pod.label ? ` — ${pod.label}` : '';

    lines.push(`  ${pod.url}${flagStr}${label}`);
    lines.push(`    Via: ${pod.discoveredVia}${pod.owner ? ` | Owner: ${pod.owner}` : ''}`);
    if (pod.lastSeen) lines.push(`    Last seen: ${pod.lastSeen}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function toolAddPod(args: {
  pod_url: string;
  label?: string;
  owner?: string;
}): Promise<string> {
  podRegistry.add({
    url: args.pod_url,
    label: args.label,
    owner: args.owner as IRI | undefined,
    isHome: false,
    discoveredVia: 'manual',
  });
  return `Added ${args.pod_url} to pod registry (${podRegistry.size} pods total)`;
}

async function toolRemovePod(args: { pod_url: string }): Promise<string> {
  const removed = podRegistry.remove(args.pod_url);
  if (removed) {
    return `Removed ${args.pod_url} from pod registry (${podRegistry.size} pods remaining)`;
  }
  const pod = podRegistry.get(args.pod_url);
  if (pod?.isHome) {
    return `Cannot remove home pod ${args.pod_url}`;
  }
  return `Pod ${args.pod_url} not found in registry`;
}

async function toolDiscoverDirectory(args: { directory_url: string }): Promise<string> {
  const directory = await fetchPodDirectory(args.directory_url, { fetch: solidFetch });
  let added = 0;
  for (const entry of directory.entries) {
    if (!podRegistry.get(entry.podUrl)) added++;
    podRegistry.add({
      url: entry.podUrl,
      label: entry.label,
      owner: entry.owner,
      isHome: false,
      discoveredVia: 'directory',
    });
  }
  return `Imported ${directory.entries.length} pod(s) from directory (${added} new). Registry: ${podRegistry.size} pods.`;
}

async function toolPublishDirectory(args: {
  directory_id?: string;
}): Promise<string> {
  await ensureCSS();
  await ensureRegistry();

  const homePod = podRegistry.getHome()!;
  const entries: PodDirectoryEntry[] = podRegistry.list().map(p => ({
    podUrl: p.url as IRI,
    owner: p.owner,
    label: p.label,
  }));

  const directory: PodDirectoryData = {
    id: (args.directory_id ?? `urn:directory:${POD_NAME}`) as IRI,
    entries,
  };

  const url = await publishPodDirectory(directory, homePod.url, { fetch: solidFetch });
  return `Published directory with ${entries.length} pod(s) to ${url}`;
}

async function toolResolveWebfinger(args: { resource: string }): Promise<string> {
  const result = await resolveWebFinger(args.resource, { fetch: solidFetch });

  if (result.podUrl) {
    podRegistry.add({
      url: result.podUrl,
      isHome: false,
      discoveredVia: 'webfinger',
    });
  }

  return [
    `WebFinger resolution for ${args.resource}:`,
    `  Subject: ${result.subject}`,
    result.podUrl ? `  Pod URL: ${result.podUrl} (added to registry)` : '  Pod URL: not found in JRD links',
    result.webId ? `  WebID: ${result.webId}` : '',
    `  Links: ${result.links.length}`,
...result.links.map(l => `    ${l.rel} -> ${l.href}`),
  ].filter(Boolean).join('\n');
}

// ── Onboarding Tool Implementation ──────────────────────────

/**
 * setup_identity — first-time onboarding for a human.
 *
 * Two modes:
 *   Cloud: registers on the identity server, provisions pod, gets bearer token.
 *   Local: provisions pod + registry locally, no internet needed.
 */
async function toolSetupIdentity(args: {
  name?: string;
  owner_name?: string;
  user_id?: string;
  agent_name?: string;
}): Promise<string> {
  const name = args.name ?? args.owner_name ?? MY_OWNER_NAME ?? 'Agent User';
  const userId = args.user_id ?? name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const agentId = `claude-code-${userId}`;
  const agentName = args.agent_name ?? `Claude Code (${name})`;

  await ensureCSS();
  const podUrl = `${BASE_URL}${userId}/`;

  // ── Local mode: no identity server needed ──────────────────
  if (IS_LOCAL) {
    // Provision pod
    await solidFetch(podUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '',
    });

    const webId = `${podUrl}profile#me` as IRI;
    const agentIri = `urn:agent:anthropic:${agentId}` as IRI;

    // Write agent registry
    const profile = createOwnerProfile(webId, name);
    const profileWithAgent = addAuthorizedAgent(profile, {
      agentId: agentIri,
      delegatedBy: webId,
      label: agentName,
      isSoftwareAgent: true,
      scope: 'ReadWrite',
      validFrom: new Date().toISOString(),
    });
    await writeAgentRegistry(profileWithAgent, podUrl, { fetch: solidFetch });

    const agent = profileWithAgent.authorizedAgents.find(a => a.agentId === agentIri)!;
    const credential = createDelegationCredential(profileWithAgent, agent, podUrl as IRI);
    await writeDelegationCredential(credential, podUrl, { fetch: solidFetch });

    return [
      `Identity created (local mode)!`,
      ``,
      `  Name: ${name}`,
      `  User ID: ${userId}`,
      `  WebID: ${webId}`,
      `  Pod: ${podUrl}`,
      `  Agent: ${agentIri}`,
      `  Mode: LOCAL (no internet required)`,
      ``,
      `To configure another Claude Code instance:`,
      `  CG_POD_NAME="${userId}"`,
      `  CG_AGENT_ID="${agentIri}"`,
      `  CG_OWNER_WEBID="${webId}"`,
      `  CG_OWNER_NAME="${name}"`,
      `  CG_BASE_URL="${BASE_URL}"`,
      ``,
      `Your pod is ready. Discover context at:`,
      `  ${podUrl}.well-known/context-graphs`,
      ``,
      `To switch to cloud mode later, set CG_BASE_URL to a remote CSS.`,
    ].join('\n');
  }

  // ── Cloud mode: register on identity server ──────────────────
  let registerResult: any;
  try {
    const resp = await fetch(`${IDENTITY_SERVER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        userId,
        agentId,
        agentName,
        scope: 'ReadWrite',
      }),
    });
    registerResult = await resp.json();
    if (!resp.ok) {
      return [
        `Registration failed: ${registerResult.error}`,
        registerResult.error?.includes('already exists')
          ? `User '${userId}' is already registered. Use your existing token.`
          : '',
      ].filter(Boolean).join('\n');
    }
  } catch (err) {
    return `Cannot reach identity server at ${IDENTITY_SERVER_URL}: ${(err as Error).message}\n\nTip: Set CG_BASE_URL to http://localhost:3456/ to use local mode without internet.`;
  }

  // Provision pod on CSS
  await solidFetch(podUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
    body: '',
  });

  // Write agent registry
  const profile = createOwnerProfile(registerResult.webId as IRI, name);
  const profileWithAgent = addAuthorizedAgent(profile, {
    agentId: `urn:agent:anthropic:${agentId}` as IRI,
    delegatedBy: registerResult.webId as IRI,
    label: agentName,
    isSoftwareAgent: true,
    scope: 'ReadWrite',
    validFrom: new Date().toISOString(),
  });
  await writeAgentRegistry(profileWithAgent, podUrl, { fetch: solidFetch });

  const agent = profileWithAgent.authorizedAgents.find(a => a.agentId === `urn:agent:anthropic:${agentId}`)!;
  const credential = createDelegationCredential(profileWithAgent, agent, podUrl as IRI);
  await writeDelegationCredential(credential, podUrl, { fetch: solidFetch });

  return [
    `Identity created successfully!`,
    ``,
    `  Name: ${name}`,
    `  User ID: ${userId}`,
    `  WebID: ${registerResult.webId}`,
    `  DID: ${registerResult.did}`,
    `  Pod: ${registerResult.podUrl}`,
    `  Agent: ${agentId}`,
    `  Agent DID: ${registerResult.agentDid}`,
    `  Token: ${registerResult.token}`,
    `  Expires: ${registerResult.expiresAt}`,
    `  Mode: CLOUD (${IDENTITY_SERVER_URL})`,
    ``,
    `To configure another Claude Code instance:`,
    `  CG_POD_NAME="${userId}"`,
    `  CG_AGENT_ID="urn:agent:anthropic:${agentId}"`,
    `  CG_OWNER_WEBID="${registerResult.webId}"`,
    `  CG_OWNER_NAME="${name}"`,
    `  CG_BASE_URL="${BASE_URL}"`,
    ``,
    `Your pod is ready. Other agents can discover your context at:`,
    `  ${registerResult.podUrl}.well-known/context-graphs`,
  ].join('\n');
}

// ── Wallet Tool Implementations ─────────────────────────────

async function toolLinkWallet(args: {
  wallet_address: string;
  signature?: string;
}): Promise<string> {
  const address = args.wallet_address;
  const userId = POD_NAME;

  if (!args.signature) {
    // Generate SIWE message for the user to sign offline
    const domain = new URL(IDENTITY_SERVER_URL).host;
    const nonce = Math.random().toString(36).slice(2, 18);
    const siweMessage = [
      `${domain} wants you to sign in with your Ethereum account:`,
      address,
      '',
      `Link wallet to Interego identity: ${userId}`,
      '',
      `URI: ${IDENTITY_SERVER_URL}`,
      `Version: 1`,
      `Chain ID: 1`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join('\n');

    return [
      `Sign this message with your wallet to link it to your identity.`,
      ``,
      `Message to sign:`,
      `─────────────────────────────────────`,
      siweMessage,
      `─────────────────────────────────────`,
      ``,
      `How to sign:`,
      `  • cast: cast wallet sign --private-key <key> "${siweMessage.replace(/\n/g, '\\n')}"`,
      `  • Web: Open ${IDENTITY_SERVER_URL}/connect and use MetaMask`,
      ``,
      `Then call link_wallet again with your wallet_address and signature.`,
    ].join('\n');
  }

  // Verify and link
  const domain = new URL(IDENTITY_SERVER_URL).host;
  const siweMessage = [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    `Link wallet to Interego identity: ${userId}`,
    '',
    `URI: ${IDENTITY_SERVER_URL}`,
    `Version: 1`,
    `Chain ID: 1`,
    `Nonce: manual`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n');

  try {
    const resp = await fetch(`${IDENTITY_SERVER_URL}/wallet/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        walletAddress: address,
        siweMessage,
        signature: args.signature,
      }),
    });
    const result = await resp.json() as any;

    if (result.linked) {
      return [
        `Wallet linked successfully!`,
        `  Address: ${address}`,
        `  User: ${userId}`,
        `  You can now use SIWE to authenticate from any device.`,
      ].join('\n');
    }
    return `Link failed: ${result.error}`;
  } catch (err) {
    return `Cannot reach identity server: ${(err as Error).message}`;
  }
}

async function toolCheckBalance(args: { address?: string }): Promise<string> {
  const { checkBalance, getChainConfig } = await import('@interego/core');
  const chain = getChainConfig();

  if (chain.mode === 'local') {
    return [
      `Chain mode: local (no blockchain connection)`,
      `  No balance checking needed — all crypto operations are off-chain.`,
      `  Set CG_CHAIN=base-sepolia or CG_CHAIN=base for on-chain operations.`,
    ].join('\n');
  }

  // Address resolution priority:
  //   1. Explicit args.address (caller-supplied — wins)
  //   2. The persisted ECDSA compliance wallet (if loaded; this is
  //      the canonical signer identity for all on-chain action)
  //   3. MY_DID (a `did:web:` identifier — NOT a fundable wallet
  //      address but useful as a last-resort label for diagnostics)
  // Falling through to MY_DID will produce an "invalid address"
  // surface from checkBalance for any real chain mode; that's the
  // correct failure mode (operator should configure a wallet).
  let address = args.address;
  if (!address) {
    if (_complianceWallet) {
      address = _complianceWallet.wallet.address;
    } else {
      try {
        const cw = await ensureComplianceWallet();
        address = cw.wallet.address;
      } catch {
        address = MY_DID;
      }
    }
  }
  const balance = await checkBalance(address);

  const lines = [
    `Wallet: ${balance.address}`,
    `Chain: ${chain.mode} (${chain.chainId})`,
    `Balance: ${balance.balance} ETH`,
    `Funded: ${balance.funded ? 'Yes' : 'No'}`,
    `Sufficient for operations: ${balance.sufficient ? 'Yes' : 'No'}`,
  ];

  if (balance.fundingInstructions) {
    lines.push('', balance.fundingInstructions);
  }

  return lines.join('\n');
}

// ── Comprehension Tool Implementations ──────────────────────

async function toolAnalyzeQuestion(args: {
  question: string;
  session_content?: string;
}): Promise<string> {
  const strategy = computeCognitiveStrategy(args.question);

  // If session content provided, also check for abstention
  let sessionEntities: Set<string> | undefined;
  if (args.session_content) {
    const sessionExtr = extractEntities(args.session_content);
    sessionEntities = new Set(sessionExtr.allEntities.map(e => e.toLowerCase()));
    const abstain = shouldAbstain(
      [...strategy.entities.contentWords],
      sessionEntities,
    );
    if (abstain.abstain) {
      return [
        `Question Analysis:`,
        `  Type: ${strategy.questionType}`,
        `  Strategy: ABSTAIN — question entities not found in session content`,
        `  Missing entities: ${abstain.missingEntities.join(', ')}`,
        `  Match ratio: ${(abstain.matchRatio * 100).toFixed(0)}%`,
      ].join('\n');
    }
  }

  const lines = [
    `Question Analysis:`,
    `  Type: ${strategy.questionType}`,
    `  Strategy: ${strategy.strategy}`,
    `  Requires computation: ${strategy.requiresComputation}`,
    strategy.computationType ? `  Computation type: ${strategy.computationType}` : '',
    `  Key entities: ${strategy.entities.contentWords.join(', ')}`,
    strategy.entities.nounPhrases.length > 0
      ? `  Noun phrases: ${strategy.entities.nounPhrases.join(', ')}`
      : '',
    `  Confidence: ${(strategy.confidence * 100).toFixed(0)}%`,
    ``,
    `Recommended approach:`,
  ];

  switch (strategy.strategy) {
    case 'temporal-twopass':
      lines.push(`  1. Extract all dates/temporal markers from sessions`);
      lines.push(`  2. Use structural date arithmetic to compute answer`);
      lines.push(`  3. Verify with session context`);
      break;
    case 'multi-session-aggregate':
      lines.push(`  1. Extract relevant items from EACH session separately`);
      lines.push(`  2. Deduplicate and count structurally`);
      lines.push(`  3. Aggregate (sum/count/average) in code, not LLM`);
      break;
    case 'preference-meta':
      lines.push(`  1. Identify user's stated preferences, interests, expertise`);
      lines.push(`  2. Generate meta-description: "The user would prefer..."`);
      break;
    case 'abstain':
      lines.push(`  The question references entities not found in available context.`);
      lines.push(`  The system should respond: "This information was not mentioned."`);
      break;
    default:
      lines.push(`  Direct comprehension from session content`);
  }

  return lines.filter(Boolean).join('\n');
}

// ── PGSL Tool Implementations ───────────────────────────────

async function toolPgslIngest(args: {
  content: string;
  publish_to_pod?: boolean;
}): Promise<string> {
  const topUri = embedInPGSL(pgslInstance, args.content);
  const stats = latticeStats(pgslInstance);
  const resolved = pgslResolve(pgslInstance, topUri);

  const lines = [
    `Ingested into PGSL lattice`,
    `  Top fragment: ${topUri}`,
    `  Resolved: "${resolved}"`,
    `  Atoms: ${stats.atoms}`,
    `  Fragments: ${stats.fragments}`,
    `  Max level: ${stats.maxLevel}`,
    `  Levels: ${Object.entries(stats.levels).map(([k, v]) => `L${k}=${v}`).join(', ')}`,
  ];

  // Always write PGSL stats to the pod so the dashboard can observe
  try {
    await ensureCSS();
    const statsJson = JSON.stringify({...stats, lastIngested: resolved, lastTopUri: topUri, updatedAt: new Date().toISOString() });
    await solidFetch(`${HOME_POD}pgsl-stats.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: statsJson,
    });
  } catch { /* best effort */ }

  if (args.publish_to_pod) {
    await ensureCSS();
    const desc = liftToDescriptor(
      pgslInstance,
      topUri,
      `urn:cg:${POD_NAME}:pgsl:${Date.now()}` as IRI,
      [{
        type: 'Temporal',
        validFrom: new Date().toISOString(),
      }, {
        type: 'Provenance',
        wasAttributedTo: MY_OWNER_WEBID,
        generatedAtTime: new Date().toISOString(),
        wasGeneratedBy: { agent: MY_AGENT_ID, endedAt: new Date().toISOString() },
      }],
    );
    const turtle = pgslToTurtle(pgslInstance);
    const result = await publish(desc, turtle, HOME_POD, { fetch: solidFetch });
    lines.push(`  Published to: ${result.descriptorUrl}`);
  }

  return lines.join('\n');
}

async function toolPgslResolve(args: { uri: string }): Promise<string> {
  const resolved = pgslResolve(pgslInstance, args.uri as IRI);
  const node = pgslInstance.nodes.get(args.uri as IRI);
  if (!node) return `Not found: ${args.uri}`;

  const lines = [`Resolved: "${resolved}"`];
  if (node.kind === 'Atom') {
    lines.push(`  Type: Atom (level 0)`);
    lines.push(`  Value: ${node.value}`);
  } else {
    lines.push(`  Type: Fragment (level ${node.level})`);
    lines.push(`  Items: ${node.items.length}`);
    if (node.left) lines.push(`  Left: ${node.left}`);
    if (node.right) lines.push(`  Right: ${node.right}`);
    const pb = pullbackSquare(pgslInstance, args.uri as IRI);
    if (pb) lines.push(`  Overlap: ${pb.overlap}`);
  }
  lines.push(`  Agent: ${node.provenance.wasAttributedTo}`);
  lines.push(`  Created: ${node.provenance.generatedAtTime}`);
  return lines.join('\n');
}

async function toolPgslLatticeStatus(_args: Record<string, never>): Promise<string> {
  const stats = latticeStats(pgslInstance);
  const lines = [
    `PGSL Lattice Status`,
    `  Total nodes: ${stats.totalNodes}`,
    `  Atoms: ${stats.atoms}`,
    `  Fragments: ${stats.fragments}`,
    `  Max level: ${stats.maxLevel}`,
    `  By level:`,
...Object.entries(stats.levels).map(([k, v]) => `    L${k}: ${v} nodes`),
  ];
  return lines.join('\n');
}

async function toolPgslMeet(args: { uri_a: string; uri_b: string }): Promise<string> {
  const meet = latticeMeet(pgslInstance, args.uri_a as IRI, args.uri_b as IRI);
  if (!meet) return `No shared sub-fragment between ${args.uri_a} and ${args.uri_b}`;
  const resolved = pgslResolve(pgslInstance, meet);
  return [
    `Lattice meet (greatest lower bound):`,
    `  Fragment: ${meet}`,
    `  Content: "${resolved}"`,
    `  A: ${args.uri_a}`,
    `  B: ${args.uri_b}`,
  ].join('\n');
}

async function toolPgslToTurtle(_args: Record<string, never>): Promise<string> {
  return pgslToTurtle(pgslInstance);
}

// ── MCP Server ──────────────────────────────────────────────

// ── Server-level instructions ────────────────────────────────
//
// Returned in the MCP `initialize` response. The connecting agent
// reads this once at session start to understand WHAT this server is
// for, WHEN to use it, and HOW its tools relate. Keep concise — the
// detailed reference material lives in the `docs://interego/*`
// resources, which the agent can fetch on demand.

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
- audit trail / regulated / EU AI Act / NIST RMF / SOC 2 / "auditable" / "regulators
  will see this" → publish_context with compliance: true + compliance_framework
  (signed + anchored + framework-cited). Use publish-audit-record prompt.

WHEN TO USE EACH TOOL FAMILY:
- publish_context → persist memory + cross-pod E2EE share
- discover_context / discover_all / get_descriptor → search pods + read
- compose_contexts → union / intersection / restriction / override
- list_known_pods / subscribe_to_pod → federation surface
- unsubscribe_from_pod → release a subscription slot when no longer needed
  (subscriptions capped per-process via CG_MAX_SUBSCRIPTIONS, default 32)
- register_agent / revoke_agent / verify_agent → identity ops; revoke
  events are auditable (the response carries a soc2:AccessChangeEvent
  ready for publish_context with compliance: true)

PRIVACY HYGIENE (before publishing):
- The MCP runs a screenForSensitiveContent preflight. If it flags HIGH
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

const mcpServer = new Server(
  { name: '@interego/mcp', version: '0.5.0' },
  {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: SERVER_INSTRUCTIONS,
  },
);

// ── Tool Definitions ────────────────────────────────────────

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ([
    // ── Core tools ──
    {
      name: 'publish_context',
      description: 'Publish a context-annotated knowledge graph to your Solid pod on behalf of the pod owner. The descriptor includes owner attribution (wasAttributedTo → owner, wasAssociatedWith → agent), semiotic frame, trust with delegation credential, and federation metadata.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          graph_iri: { type: 'string', description: 'IRI for the named graph (e.g. urn:graph:project:arch-v1)' },
          graph_content: { type: 'string', description: 'RDF Turtle content of the knowledge graph' },
          descriptor_id: { type: 'string', description: 'Optional IRI for the descriptor (auto-generated if omitted)' },
          confidence: { type: 'number', description: 'Epistemic confidence 0.0-1.0 (default 0.85)' },
          modal_status: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'], description: 'Semiotic modal status (default: Asserted)' },
          task_description: { type: 'string', description: 'What task produced this context (for provenance)' },
          valid_from: { type: 'string', description: 'ISO 8601 start of validity (default: now)' },
          valid_until: { type: 'string', description: 'ISO 8601 end of validity (optional)' },
          target_pod: { type: 'string', description: 'Pod URL to publish to (default: home pod)' },
          share_with: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of external identity handles (did:web:..., WebID URLs, or acct:user@host) to include as additional E2EE recipients. Their pods are resolved and their authorized agents are added to the envelope recipient set — only those specific agents can decrypt THIS graph. Use for selective cross-pod sharing without exposing other pod content.',
          },
          auto_supersede_prior: {
            type: 'boolean',
            description: 'When true (default), automatically add cg:supersedes links to any prior descriptor on this pod that describes the same graph_iri. Makes republish-to-add-recipients cleanly mark the older version as superseded. Set to false to allow multiple coexisting descriptors for the same graph.',
          },
          compliance: {
            type: 'boolean',
            description: 'When true, publish as compliance-grade evidence (regulatory audit trail). Forces trust to HighAssurance, requires non-Hypothetical modal status, validates against compliance shapes. Response includes a compliance check report.',
          },
          compliance_framework: {
            type: 'string',
            enum: ['eu-ai-act', 'nist-rmf', 'soc2'],
            description: 'Optional regulatory framework this descriptor provides evidence for. The graph_content should cite specific control IRIs (e.g., soc2:CC6.1) via the framework\'s evidence-citation predicate.',
          },
        },
        required: ['graph_iri', 'graph_content'],
      },
    },
    {
      name: 'discover_context',
      description: 'Discover context descriptors on a specific Solid pod. Optionally verify the agent delegation chain.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pod_url: { type: 'string', description: 'Solid pod URL to discover from' },
          facet_type: { type: 'string', enum: ['Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation'], description: 'Filter by facet type' },
          valid_from: { type: 'string', description: 'Filter by the descriptor\'s own validFrom (endpoint-only, not interval-contains)' },
          valid_until: { type: 'string', description: 'Filter by the descriptor\'s own validUntil (endpoint-only)' },
          effective_at: { type: 'string', description: 'ISO 8601 instant. "Currently-valid-at-time-T": only descriptors whose interval [validFrom, validUntil] contains the given instant are returned. Use this for the common "what\'s effective now?" query — valid_from alone does NOT implement this semantic.' },
          verify_delegation: { type: 'boolean', description: 'If true, also fetch the agent registry to verify delegation' },
        },
        required: ['pod_url'],
      },
    },
    {
      name: 'get_descriptor',
      description: 'Fetch the full Turtle content of a specific context descriptor.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Full URL of the descriptor resource' },
        },
        required: ['url'],
      },
    },
    {
      name: 'subscribe_to_pod',
      description: 'Subscribe to live WebSocket notifications from a Solid pod. Capped at CG_MAX_SUBSCRIPTIONS (default 32) per process; call unsubscribe_from_pod to release a slot.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pod_url: { type: 'string', description: 'Solid pod URL to subscribe to' },
        },
        required: ['pod_url'],
      },
    },
    {
      name: 'unsubscribe_from_pod',
      description: 'Close an active WebSocket subscription on a Solid pod. Releases a slot toward the CG_MAX_SUBSCRIPTIONS cap. No-op if not subscribed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pod_url: { type: 'string', description: 'Solid pod URL to unsubscribe from' },
        },
        required: ['pod_url'],
      },
    },
    {
      name: 'get_pod_status',
      description: 'Check a Solid pod — owner, agents, descriptors, notifications.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pod_url: { type: 'string', description: 'Pod URL (default: home pod)' },
        },
      },
    },
    // ── Delegation tools ──
    {
      name: 'register_agent',
      description: 'Register an AI agent as authorized to act on behalf of the pod owner.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_id: { type: 'string', description: 'Agent identity IRI' },
          label: { type: 'string', description: 'Human-readable label' },
          scope: { type: 'string', enum: ['ReadWrite', 'ReadOnly', 'PublishOnly', 'DiscoverOnly'], description: 'Delegation scope (default: ReadWrite)' },
          valid_until: { type: 'string', description: 'ISO 8601 expiration (optional)' },
          pod_url: { type: 'string', description: 'Pod URL (default: home pod)' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'revoke_agent',
      description: "Revoke an agent's delegation.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_id: { type: 'string', description: 'Agent identity IRI to revoke' },
          pod_url: { type: 'string', description: 'Pod URL (default: home pod)' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'verify_agent',
      description: "Verify an agent is authorized on a pod by checking the agent registry.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_id: { type: 'string', description: 'Agent identity IRI to verify' },
          pod_url: { type: 'string', description: 'Pod URL to check' },
        },
        required: ['agent_id', 'pod_url'],
      },
    },
    // ── Multi-pod federation tools ──
    {
      name: 'discover_all',
      description: 'Fan out discovery across ALL known pods in the registry. Returns aggregated results from every pod.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          facet_type: { type: 'string', enum: ['Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation'], description: 'Filter by facet type' },
          valid_from: { type: 'string', description: 'Filter: valid at or after this datetime' },
          valid_until: { type: 'string', description: 'Filter: valid at or before this datetime' },
        },
      },
    },
    {
      name: 'subscribe_all',
      description: 'Subscribe to WebSocket notifications from ALL known pods.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'list_known_pods',
      description: 'List all pods in the federation registry — home pod, configured pods, directory-discovered pods, WebFinger-resolved pods.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'add_pod',
      description: 'Manually add a Solid pod URL to the federation registry.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pod_url: { type: 'string', description: 'Solid pod URL to add' },
          label: { type: 'string', description: 'Human-readable label' },
          owner: { type: 'string', description: "Pod owner's WebID" },
        },
        required: ['pod_url'],
      },
    },
    {
      name: 'remove_pod',
      description: 'Remove a pod from the federation registry (cannot remove home pod).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pod_url: { type: 'string', description: 'Pod URL to remove' },
        },
        required: ['pod_url'],
      },
    },
    {
      name: 'discover_directory',
      description: 'Fetch a PodDirectory graph from a URL and import all listed pods into the registry. Directories are RDF graphs listing known pods.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          directory_url: { type: 'string', description: 'URL of the PodDirectory resource' },
        },
        required: ['directory_url'],
      },
    },
    {
      name: 'publish_directory',
      description: 'Publish the current pod registry as a PodDirectory graph on your home pod. Other agents can fetch this to discover your known pods.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          directory_id: { type: 'string', description: 'IRI for the directory (default: auto-generated)' },
        },
      },
    },
    {
      name: 'resolve_webfinger',
      description: 'Resolve a WebFinger identifier (acct:user@domain or WebID URL) to discover a Solid pod URL via RFC 7033. Adds the discovered pod to the registry.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          resource: { type: 'string', description: 'WebFinger resource (e.g. "acct:markj@interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io" or a WebID URL)' },
        },
        required: ['resource'],
      },
    },
    // ── Onboarding ──
    {
      name: 'setup_identity',
      description: 'First-time onboarding: creates your identity (WebID, DID, Ed25519 keys), provisions your Solid pod, registers your agent with delegation credentials, and returns a bearer token. Run this once when setting up a new human user.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Human-readable name (e.g. "Sarah Chen")' },
          user_id: { type: 'string', description: 'Short identifier (e.g. "sarah") — auto-derived from name if omitted' },
          agent_name: { type: 'string', description: 'Label for the agent (e.g. "Claude Code (Sarah)")' },
        },
        required: ['name'],
      },
    },
    {
      name: 'link_wallet',
      description: 'Link an existing Ethereum wallet to your identity. Generates a SIWE message for you to sign offline (with cast, ethers CLI, or MetaMask). Alternatively, open the web connect page at the identity server to sign in browser.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          wallet_address: { type: 'string', description: 'Your Ethereum wallet address (0x...)' },
          signature: { type: 'string', description: 'SIWE signature (0x...) — if you already signed offline. Omit to get the message to sign.' },
        },
        required: ['wallet_address'],
      },
    },
    {
      name: 'check_balance',
      description: 'Check the ETH balance of a wallet on the active chain. Returns balance, funding status, and instructions if unfunded.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          address: { type: 'string', description: 'Wallet address to check (default: your wallet)' },
        },
      },
    },
    // ── Comprehension tools ──
    {
      name: 'analyze_question',
      description: 'Analyze a question using the affordance engine to determine the optimal cognitive strategy. Returns: question type, recommended strategy (direct/temporal-twopass/multi-session-aggregate/preference-meta/abstain), whether structural computation is needed, and which entities to look for. Use this BEFORE answering a question to select the right approach.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          question: { type: 'string', description: 'The question to analyze' },
          session_content: { type: 'string', description: 'Optional session content to check for abstention (are the question entities present?)' },
        },
        required: ['question'],
      },
    },
    // ── PGSL tools ──
    {
      name: 'pgsl_ingest',
      description: 'Ingest content into the PGSL lattice. Tokenizes the content, builds the overlapping-pair lattice bottom-up, and returns the top fragment URI. Optionally publishes the lattice as a context descriptor to the pod.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'Text content to ingest into the lattice' },
          publish_to_pod: { type: 'boolean', description: 'Also publish as a context descriptor to the pod (default: false)' },
        },
        required: ['content'],
      },
    },
    {
      name: 'pgsl_resolve',
      description: 'Resolve a PGSL URI to its content. For atoms: returns the value. For fragments: returns the full reconstructed text. Also shows node metadata (level, constituents, pullback, provenance).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          uri: { type: 'string', description: 'PGSL URI to resolve (urn:pgsl:atom:... or urn:pgsl:fragment:...)' },
        },
        required: ['uri'],
      },
    },
    {
      name: 'pgsl_lattice_status',
      description: 'Show the current state of the PGSL lattice — atom count, fragment count, levels, total nodes.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'pgsl_meet',
      description: 'Compute the lattice meet (greatest lower bound) of two fragments — the largest shared sub-sequence. This is the categorical intersection in the presheaf topos.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          uri_a: { type: 'string', description: 'First PGSL fragment URI' },
          uri_b: { type: 'string', description: 'Second PGSL fragment URI' },
        },
        required: ['uri_a', 'uri_b'],
      },
    },
    {
      name: 'pgsl_to_turtle',
      description: 'Serialize the entire PGSL lattice as RDF Turtle. Includes atoms, fragments, pullback structures, and provenance — all as typed RDF resources with the pgsl: vocabulary.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ] as Array<{name: string; description: string; inputSchema: object}>).filter(t => isToolEnabled(t.name)),
}));

// ── Tool Dispatch ───────────────────────────────────────────

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case 'publish_context':
        result = await toolPublishContext(args as Parameters<typeof toolPublishContext>[0]);
        break;
      case 'discover_context':
        result = await toolDiscoverContext(args as Parameters<typeof toolDiscoverContext>[0]);
        break;
      case 'get_descriptor':
        result = await toolGetDescriptor(args as Parameters<typeof toolGetDescriptor>[0]);
        break;
      case 'subscribe_to_pod':
        result = await toolSubscribeToPod(args as Parameters<typeof toolSubscribeToPod>[0]);
        break;
      case 'unsubscribe_from_pod':
        result = await toolUnsubscribeFromPod(args as Parameters<typeof toolUnsubscribeFromPod>[0]);
        break;
      case 'get_pod_status':
        result = await toolGetPodStatus(args as Parameters<typeof toolGetPodStatus>[0]);
        break;
      case 'register_agent':
        result = await toolRegisterAgent(args as Parameters<typeof toolRegisterAgent>[0]);
        break;
      case 'revoke_agent':
        result = await toolRevokeAgent(args as Parameters<typeof toolRevokeAgent>[0]);
        break;
      case 'verify_agent':
        result = await toolVerifyAgent(args as Parameters<typeof toolVerifyAgent>[0]);
        break;
      // Multi-pod federation
      case 'discover_all':
        result = await toolDiscoverAll(args as Parameters<typeof toolDiscoverAll>[0]);
        break;
      case 'subscribe_all':
        result = await toolSubscribeAll(args as Record<string, never>);
        break;
      case 'list_known_pods':
        result = await toolListKnownPods(args as Record<string, never>);
        break;
      case 'add_pod':
        result = await toolAddPod(args as Parameters<typeof toolAddPod>[0]);
        break;
      case 'remove_pod':
        result = await toolRemovePod(args as Parameters<typeof toolRemovePod>[0]);
        break;
      case 'discover_directory':
        result = await toolDiscoverDirectory(args as Parameters<typeof toolDiscoverDirectory>[0]);
        break;
      case 'publish_directory':
        result = await toolPublishDirectory(args as Parameters<typeof toolPublishDirectory>[0]);
        break;
      case 'resolve_webfinger':
        result = await toolResolveWebfinger(args as Parameters<typeof toolResolveWebfinger>[0]);
        break;
      // Onboarding
      case 'setup_identity':
        result = await toolSetupIdentity(args as Parameters<typeof toolSetupIdentity>[0]);
        break;
      case 'link_wallet':
        result = await toolLinkWallet(args as Parameters<typeof toolLinkWallet>[0]);
        break;
      case 'check_balance':
        result = await toolCheckBalance(args as { address?: string });
        break;
      // Comprehension
      case 'analyze_question':
        result = await toolAnalyzeQuestion(args as Parameters<typeof toolAnalyzeQuestion>[0]);
        break;
      // PGSL
      case 'pgsl_ingest':
        result = await toolPgslIngest(args as Parameters<typeof toolPgslIngest>[0]);
        break;
      case 'pgsl_resolve':
        result = await toolPgslResolve(args as Parameters<typeof toolPgslResolve>[0]);
        break;
      case 'pgsl_lattice_status':
        result = await toolPgslLatticeStatus(args as Record<string, never>);
        break;
      case 'pgsl_meet':
        result = await toolPgslMeet(args as Parameters<typeof toolPgslMeet>[0]);
        break;
      case 'pgsl_to_turtle':
        result = await toolPgslToTurtle(args as Record<string, never>);
        break;
      default:
        result = `Unknown tool: ${name}`;
    }

    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

// ── Resources ───────────────────────────────────────────────

// ── Doc resources ────────────────────────────────────────────
//
// Each doc:// resource is a slice of the project documentation
// the agent can fetch on demand. Files are resolved by walking up
// from the module location until the candidate exists, so this
// works in both dev (mcp-server/server.ts) and dist
// (mcp-server/dist/server.js) layouts.

const __mcpDir = dirname(fileURLToPath(import.meta.url));

function resolveProjectFile(...segments: string[]): string | null {
  // Try walking 1, 2, 3 levels up from the module location.
  for (const ups of [['..'], ['..', '..'], ['..', '..', '..']]) {
    const candidate = resolve(__mcpDir, ...ups, ...segments);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface DocResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  segments: string[];
}

const DOC_RESOURCES: readonly DocResource[] = [
  {
    uri: 'docs://interego/playbook',
    name: 'Interego — Agent Playbook (when X do Y)',
    description: 'Operational playbook for AI agents using the Interego MCP. Covers proactive triggers, privacy hygiene, modal-status selection, versioning defaults, error handling, cross-surface continuity, ABAC. Fetch this on first use of Interego in a session.',
    mimeType: 'text/markdown',
    segments: ['docs', 'AGENT-PLAYBOOK.md'],
  },
  {
    uri: 'docs://interego/integration-guide',
    name: 'Interego — Integration Guide for Agent Frameworks',
    description: 'One-page integrator guide for AI agent harnesses (OpenClaw, Cursor, Cline, Aider, custom). System-prompt snippet to embed, optional native library integration, conformance levels, brand-neutral framing.',
    mimeType: 'text/markdown',
    segments: ['docs', 'AGENT-INTEGRATION-GUIDE.md'],
  },
  {
    uri: 'docs://interego/overview',
    name: 'Interego — Overview',
    description: 'Top-level project README: what Interego is, who it\'s for, key features.',
    mimeType: 'text/markdown',
    segments: ['README.md'],
  },
  {
    uri: 'docs://interego/architecture',
    name: 'Interego — Architecture (normative)',
    description: 'Protocol architecture: seven facet types, composition operators, federation model, RDF 1.2 / SHACL 1.2 alignment.',
    mimeType: 'text/markdown',
    segments: ['spec', 'architecture.md'],
  },
  {
    uri: 'docs://interego/layers',
    name: 'Interego — Layering Discipline',
    description: 'L1 (protocol) vs L2 (architecture patterns) vs L3 (implementation + domain). Read before authoring specs, ontologies, or new namespaces.',
    mimeType: 'text/markdown',
    segments: ['spec', 'LAYERS.md'],
  },
  {
    uri: 'docs://interego/derivation',
    name: 'Interego — Derivation Discipline',
    description: 'Normative construction rules: every L2/L3 ontology class must be grounded in L1 primitives. CI-enforced.',
    mimeType: 'text/markdown',
    segments: ['spec', 'DERIVATION.md'],
  },
  {
    uri: 'docs://interego/emergence',
    name: 'Interego — Emergent Properties',
    description: 'Four demos showing emergent properties of the protocol: vocabulary alignment, mediator pullback, localized closed-world, stigmergic colony.',
    mimeType: 'text/markdown',
    segments: ['docs', 'EMERGENCE.md'],
  },
  {
    uri: 'docs://interego/abac-pattern',
    name: 'Interego — ABAC pattern (L2)',
    description: 'Attribute-based access control: policies as descriptors, SHACL predicates, federated attribute resolution, decision caching.',
    mimeType: 'text/turtle',
    segments: ['docs', 'ns', 'abac.ttl'],
  },
  {
    uri: 'docs://interego/code-domain',
    name: 'Interego — code: domain ontology (L3)',
    description: 'Example L3 domain ontology for source-code artifacts (Repository, Commit, Branch, PullRequest, Review, Defect). Demonstrates that a non-trivial domain expresses fully on top of L1 primitives.',
    mimeType: 'text/turtle',
    segments: ['docs', 'ns', 'code.ttl'],
  },
];

mcpServer.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    // Live data resources (pod state)
    {
      uri: `solid://${POD_NAME}/manifest`,
      name: 'Home Pod Manifest',
      description: `Context descriptors on ${HOME_POD}`,
      mimeType: 'text/turtle',
    },
    {
      uri: `solid://${POD_NAME}/agents`,
      name: 'Agent Registry',
      description: `Authorized agents for ${MY_OWNER_WEBID}`,
      mimeType: 'text/turtle',
    },
    {
      uri: 'solid://registry/pods',
      name: 'Pod Registry',
      description: 'All known pods in the federation',
      mimeType: 'application/json',
    },
    // Documentation resources (read on demand for protocol context)
    ...DOC_RESOURCES.map(d => ({
      uri: d.uri,
      name: d.name,
      description: d.description,
      mimeType: d.mimeType,
    })),
  ],
}));

mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const homePod = podRegistry.getHome()!;

  if (request.params.uri === `solid://${POD_NAME}/manifest`) {
    try {
      await ensureCSS();
      const resp = await fetch(`${homePod.url}.well-known/context-graphs`, { headers: { 'Accept': 'text/turtle' } });
      const body = resp.ok ? await resp.text() : '# No manifest yet';
      return { contents: [{ uri: request.params.uri, mimeType: 'text/turtle', text: body }] };
    } catch {
      return { contents: [{ uri: request.params.uri, mimeType: 'text/turtle', text: '# Solid server not reachable' }] };
    }
  }

  if (request.params.uri === `solid://${POD_NAME}/agents`) {
    try {
      await ensureCSS();
      const resp = await fetch(`${homePod.url}agents`, { headers: { 'Accept': 'text/turtle' } });
      const body = resp.ok ? await resp.text() : '# No agent registry yet';
      return { contents: [{ uri: request.params.uri, mimeType: 'text/turtle', text: body }] };
    } catch {
      return { contents: [{ uri: request.params.uri, mimeType: 'text/turtle', text: '# Solid server not reachable' }] };
    }
  }

  if (request.params.uri === 'solid://registry/pods') {
    const pods = podRegistry.list();
    const json = JSON.stringify(pods.map(p => ({
      url: p.url,
      label: p.label,
      owner: p.owner,
      isHome: p.isHome,
      discoveredVia: p.discoveredVia,
      subscribed: !!p.subscription,
      lastSeen: p.lastSeen,
    })), null, 2);
    return { contents: [{ uri: request.params.uri, mimeType: 'application/json', text: json }] };
  }

  // Doc resources — read project files on demand.
  const doc = DOC_RESOURCES.find(d => d.uri === request.params.uri);
  if (doc) {
    const path = resolveProjectFile(...doc.segments);
    if (!path) {
      return {
        contents: [{
          uri: request.params.uri,
          mimeType: doc.mimeType,
          text: `(doc not found at expected location: ${doc.segments.join('/')})`,
        }],
      };
    }
    try {
      const text = readFileSync(path, 'utf8');
      return { contents: [{ uri: request.params.uri, mimeType: doc.mimeType, text }] };
    } catch (err) {
      return {
        contents: [{
          uri: request.params.uri,
          mimeType: doc.mimeType,
          text: `(error reading ${path}: ${(err as Error).message})`,
        }],
      };
    }
  }

  throw new Error(`Unknown resource: ${request.params.uri}`);
});

// ── Prompts ──────────────────────────────────────────────────
//
// Workflow templates the connecting agent can offer to the user as
// canned starting points. Each prompt captures one concrete
// Interego use case so a brand-new agent has tangible entry points
// rather than 25 isolated tool descriptions.

interface PromptDef {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  build: (args: Record<string, string>) => string;
}

const PROMPTS: readonly PromptDef[] = [
  {
    name: 'publish-audit-record',
    description: 'Publish a compliance-grade audit-trail descriptor: signed (ECDSA), trust upgraded to CryptographicallyVerified, framework-cited, anchored. Use when the user is in a regulated context (EU AI Act, NIST RMF, SOC 2) or asks for an auditable record.',
    arguments: [
      { name: 'topic', description: 'Short topic / what action is being recorded.', required: true },
      { name: 'content', description: 'The action content (Turtle preferred — include framework control IRIs via dct:conformsTo so /audit/compliance can aggregate).', required: true },
      { name: 'framework', description: 'Regulatory framework: eu-ai-act | nist-rmf | soc2.', required: false },
    ],
    build: (a) => `Publish a COMPLIANCE-GRADE audit record:

Topic: ${a.topic}
Framework: ${a.framework ?? '(unspecified — descriptor will still be signed but not framework-cited)'}

Use publish_context with:
  - graph_iri:        urn:graph:audit:<slug-of-topic>:<timestamp>
  - graph_content:    ${a.content}
  - modal_status:     Asserted (compliance grade requires committed claims, not Hypothetical)
  - compliance:       true
${a.framework ? `  - compliance_framework: '${a.framework}'\n` : ''}
The response will include:
  - descriptorUrl: where the descriptor lives on the pod
  - signature: { url (sig.json), signer (ECDSA address), signedAt, ipfsCid? }
  - complianceCheck: { compliant, violations, upgradedFacets }

Surface the response to the user. If complianceCheck.compliant is false,
explain the violations and offer to fix (typical fix: configure the
operator's compliance wallet path so signing succeeds).

If a framework was specified, suggest the user check their per-framework
report at /audit/compliance/${a.framework ?? '<framework>'} to see how this
record contributes to overall conformance.`,
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
      { name: 'topic', description: 'Short topic or title for the memory (e.g. "API design preferences").', required: true },
      { name: 'content', description: 'The actual content to remember (free-form text or RDF Turtle).', required: true },
      { name: 'modal_status', description: 'Asserted | Hypothetical | Counterfactual (default Asserted).', required: false },
    ],
    build: (a) => `Use publish_context to persist this memory to the user's home pod:

Topic: ${a.topic}
Content: ${a.content}
Modal status: ${a.modal_status ?? 'Asserted'}

Construct an appropriate graph_iri (urn:graph:memory:<slug>), include the
content as graph_content (Turtle if structured, otherwise as a plain literal
in a single-triple graph), and use the modal status above. Confirm with the
user that the descriptor was published, and report the descriptor URL so they
can reference it later.`,
  },
  {
    name: 'discover-shared-context',
    description: 'Find what context other agents have shared with the user, across known pods.',
    arguments: [
      { name: 'topic', description: 'Optional topic filter (substring match on descriptor titles or graph IRIs).', required: false },
      { name: 'since', description: 'Optional ISO 8601 datetime — only descriptors validFrom on/after this.', required: false },
    ],
    build: (a) => `Discover context shared with the user across known pods:

1. Use list_known_pods to enumerate the federation surface.
2. For each pod, use discover_pod (with effective_at = now to filter to
   currently-valid descriptors).
${a.topic ? `3. Filter results by topic substring: "${a.topic}".\n` : ''}${a.since ? `4. Filter to descriptors with validFrom ≥ ${a.since}.\n` : ''}
5. Summarize: which pods returned what, total descriptor count, any
   noteworthy modal statuses (Counterfactual flags? Hypothetical claims?).

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
2. Read the AgentFacet (assertingAgent + onBehalfOf) and TrustFacet (issuer + trustLevel).
3. Use discover_pod with verify_delegation=true on the descriptor's origin pod
   to confirm the agent is in the owner's authorized agents list.
4. Report: who authored, on whose behalf, with what trust level, and whether
   the delegation chain verifies.

Flag any of: SelfAsserted trust on a high-stakes claim; missing agent
registration; mismatched issuer + asserting agent.`,
  },
  {
    name: 'compose-contexts',
    description: 'Compose two existing contexts via a lattice operator (union / intersection / restriction / override) and persist the result as a new descriptor.',
    arguments: [
      { name: 'descriptor_a', description: 'URL of the first descriptor.', required: true },
      { name: 'descriptor_b', description: 'URL of the second descriptor.', required: true },
      { name: 'operator', description: 'union | intersection | restriction | override', required: true },
    ],
    build: (a) => `Compose two contexts:

A: ${a.descriptor_a}
B: ${a.descriptor_b}
Operator: ${a.operator}

1. Fetch both descriptors with get_descriptor.
2. Use compose_contexts with operator="${a.operator}" — see Interego
   architecture (docs://interego/architecture) for facet-merge semantics
   per operator.
3. Publish the composed result as a new descriptor with a fresh graph_iri,
   citing both sources via prov:wasDerivedFrom.
4. Report the composed descriptor's URL.`,
  },
  {
    name: 'explain-interego',
    description: 'Briefly explain to the user what Interego is and what they can do with this MCP server.',
    arguments: [],
    build: () => `Read the docs://interego/overview resource. Then summarize for the
user, in their words, what Interego is and three concrete things they
can do right now with this MCP server. Keep it under 150 words.

Offer to show them more — point at docs://interego/architecture for
the protocol shape, docs://interego/emergence for what's possible,
or just demo a publish + discover round-trip on their own pod.`,
  },
];

mcpServer.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPTS.map(p => ({
    name: p.name,
    description: p.description,
    arguments: p.arguments,
  })),
}));

mcpServer.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const prompt = PROMPTS.find(p => p.name === request.params.name);
  if (!prompt) throw new Error(`Unknown prompt: ${request.params.name}`);
  const args = (request.params.arguments ?? {}) as Record<string, string>;
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

// ── Start ───────────────────────────────────────────────────

async function main(): Promise<void> {
  log('Starting Interego MCP server v0.4.1...');
  log(`Owner: ${MY_OWNER_WEBID}${MY_OWNER_NAME ? ` (${MY_OWNER_NAME})` : ''}`);
  log(`Agent: ${MY_AGENT_ID}`);
  log(`Home pod: ${HOME_POD}`);
  log(`Known pods: ${podRegistry.size}`);

  // Auto-load directory if configured
  if (DIRECTORY_URL) {
    try {
      const directory = await fetchPodDirectory(DIRECTORY_URL, { fetch: solidFetch });
      for (const entry of directory.entries) {
        podRegistry.add({
          url: entry.podUrl,
          label: entry.label,
          owner: entry.owner,
          isHome: false,
          discoveredVia: 'directory',
        });
      }
      log(`Loaded ${directory.entries.length} pod(s) from directory ${DIRECTORY_URL}`);
    } catch (err) {
      log(`Warning: could not load directory ${DIRECTORY_URL}: ${(err as Error).message}`);
    }
  }

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  log('MCP server connected via stdio');
}

process.on('SIGINT', () => { stopCSS(); process.exit(0); });
process.on('SIGTERM', () => { stopCSS(); process.exit(0); });
process.on('exit', () => { stopCSS(); });

main().catch((err) => {
  log(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
