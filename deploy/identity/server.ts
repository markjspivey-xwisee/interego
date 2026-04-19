#!/usr/bin/env tsx
/**
 * Interego Identity Server v2
 *
 * Serves identity documents + issues bearer tokens for pod access.
 * Supports dynamic registration — any human can onboard.
 *
 * Endpoints:
 *   Identity:
 *     GET  /.well-known/did.json          — Server DID
 *     GET  /users/:id/did.json            — User DID document
 *     GET  /agents/:id/did.json           — Agent DID document
 *     GET  /users/:id/profile             — WebID profile (Turtle)
 *     GET  /agents/:id/profile            — Agent profile (Turtle)
 *     GET  /.well-known/webfinger         — RFC 7033
 *
 *   Auth:
 *     POST /register                      — Register new human + first agent
 *     POST /register-agent                — Register additional agent for existing user
 *     POST /tokens                        — Issue bearer token for agent
 *     POST /tokens/verify                 — Verify a bearer token
 *
 *   Health:
 *     GET  /health
 */

import express from 'express';
import * as crypto from 'node:crypto';
import { ethers } from 'ethers';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';

// ── Config ──────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8090');
const BASE_URL = process.env['BASE_URL'] ?? `http://localhost:${PORT}`;
const CSS_URL = process.env['CSS_URL'] ?? 'https://interego-css.internal.livelysky-8b81abb0.eastus.azurecontainerapps.io/';
const ONTOLOGY_URL = 'https://markjspivey-xwisee.github.io/interego/ns/cg#';
const TOKEN_TTL_SECONDS = 86400; // 24 hours

function log(msg: string) { console.log(`[identity] ${msg}`); }

// ── Key Generation ──────────────────────────────────────────

interface KeyPair {
  publicKeyMultibase: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
}

function generateEd25519(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' });
  const rawKey = pubRaw.subarray(pubRaw.length - 32);
  const publicKeyMultibase = 'z' + rawKey.toString('base64url');
  return { publicKeyMultibase, privateKey, publicKey };
}

// ── Dynamic Identity Registry ───────────────────────────────

interface Identity {
  id: string;
  type: 'user' | 'agent';
  name: string;
  owner?: string;        // for agents: the user who owns them
  scope?: string;
  createdAt: string;
  erc8004Key?: string;
  // NOTE: auth methods (walletAddress, webAuthnCredentials, didKeys) live in
  // the user's own Solid pod at <pod>/auth-methods.jsonld — not here. The
  // identity server is stateless wrt user-owned credential data; pods are
  // the source of truth. See readAuthMethods() / writeAuthMethods() below.
}

// Auth methods schema persisted in each user's pod as JSON-LD. Canonical
// predicates live under the cg: and sec: namespaces; any RDF-aware tool
// can consume the file. A user can have multiple methods of each kind
// (multiple wallets, multiple passkeys, multiple DID keys) registered.
interface AuthMethods {
  '@context'?: Record<string, string>;
  '@id'?: string;
  '@type'?: string;
  userId: string;
  name: string;                           // display name — restored on restart
  agentId?: string;                       // user's first agent ID for token issuance
  walletAddresses: string[];              // lowercased Ethereum addresses
  webAuthnCredentials: Array<{
    id: string;                           // credential ID (base64url)
    publicKey: string;                    // COSE public key (base64url)
    counter: number;
    transports?: string[];
    label?: string;
    createdAt: string;
  }>;
  didKeys: Array<{
    did: string;
    publicKeyMultibase: string;
    keyType: 'Ed25519VerificationKey2020';
    label?: string;
    createdAt: string;
  }>;
}

function emptyAuthMethods(userId: string, name = userId, agentId?: string): AuthMethods {
  const m: AuthMethods = {
    '@context': {
      cg: ONTOLOGY_URL,
      sec: 'https://w3id.org/security#',
      xsd: 'http://www.w3.org/2001/XMLSchema#',
    },
    '@id': `#auth-${userId}`,
    '@type': 'cg:AuthMethods',
    userId,
    name,
    walletAddresses: [],
    webAuthnCredentials: [],
    didKeys: [],
  };
  if (agentId) m.agentId = agentId;
  return m;
}

interface TokenRecord {
  token: string;
  userId: string;
  agentId: string;
  scope: string;
  issuedAt: string;
  expiresAt: string;
}

// In-memory stores. `identities` and `keys` are cheap-to-rebuild bookkeeping
// (user/agent shells + Ed25519 keys for DID documents). The user-authoritative
// credential data (wallets, passkeys, DID keys) does NOT live here — it lives
// in each user's Solid pod as auth-methods.jsonld. `walletIndex` and
// `credentialIndex` are read-through caches built from pod scans on startup
// so SIWE/passkey flows can look up "which user owns this wallet/credential?"
// without scanning every pod on every call.
const identities: Map<string, Identity> = new Map();
const keys: Map<string, KeyPair> = new Map();
const tokens: Map<string, TokenRecord> = new Map();

// lowercased wallet address → userId
const walletIndex: Map<string, string> = new Map();
// webauthn credential id → userId
const credentialIndex: Map<string, string> = new Map();
// did → userId
const didIndex: Map<string, string> = new Map();

// Per-user auth-methods cache with 60s TTL. Stale-while-revalidate:
// a cache miss or expired entry triggers a pod fetch but returns the
// stale value in the meantime on non-critical reads.
const authMethodsCache: Map<string, { value: AuthMethods; fetchedAt: number }> = new Map();
const AUTH_METHODS_TTL_MS = 60 * 1000;

function podAuthMethodsUrl(userId: string): string {
  return `${CSS_URL}${userId}/auth-methods.jsonld`;
}

async function fetchPodAuthMethods(userId: string): Promise<AuthMethods> {
  const url = podAuthMethodsUrl(userId);
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/ld+json' } });
    if (r.status === 404) {
      // First touch — pod has no file yet; write an empty one so the caller
      // can append to it without racing other writers.
      const empty = emptyAuthMethods(userId);
      await putPodAuthMethods(userId, empty);
      return empty;
    }
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const body = await r.json();
    return normaliseAuthMethods(body, userId);
  } catch (err) {
    log(`WARN: could not read ${url}: ${(err as Error).message}`);
    // Return an empty doc rather than throwing — identity flows gracefully
    // degrade to "no credentials on file" which surfaces as "register first".
    return emptyAuthMethods(userId);
  }
}

async function putPodAuthMethods(userId: string, methods: AuthMethods): Promise<void> {
  const url = podAuthMethodsUrl(userId);
  // Ensure pod container exists first (idempotent).
  try {
    await fetch(`${CSS_URL}${userId}/`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '',
    });
  } catch { /* best-effort */ }
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify(methods, null, 2),
  });
  if (!r.ok && r.status !== 205) {
    throw new Error(`PUT ${url} failed: ${r.status} ${r.statusText}`);
  }
  // Update cache + indexes for this user
  authMethodsCache.set(userId, { value: methods, fetchedAt: Date.now() });
  rebuildIndexesForUser(userId, methods);
}

function normaliseAuthMethods(raw: unknown, userId: string): AuthMethods {
  const base = emptyAuthMethods(userId);
  if (!raw || typeof raw !== 'object') return base;
  const src = raw as Partial<AuthMethods>;
  return {
    ...base,
    userId: typeof src.userId === 'string' ? src.userId : userId,
    name: typeof src.name === 'string' ? src.name : userId,
    ...(src.agentId ? { agentId: src.agentId } : {}),
    walletAddresses: Array.isArray(src.walletAddresses)
      ? src.walletAddresses.filter((w): w is string => typeof w === 'string').map(w => w.toLowerCase())
      : [],
    webAuthnCredentials: Array.isArray(src.webAuthnCredentials) ? src.webAuthnCredentials : [],
    didKeys: Array.isArray(src.didKeys) ? src.didKeys : [],
  };
}

async function readAuthMethods(userId: string, allowStale = false): Promise<AuthMethods> {
  const cached = authMethodsCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < AUTH_METHODS_TTL_MS) {
    return cached.value;
  }
  if (cached && allowStale) {
    // Refresh in background; return stale now
    fetchPodAuthMethods(userId).then(fresh => {
      authMethodsCache.set(userId, { value: fresh, fetchedAt: Date.now() });
      rebuildIndexesForUser(userId, fresh);
    }).catch(() => {});
    return cached.value;
  }
  const fresh = await fetchPodAuthMethods(userId);
  authMethodsCache.set(userId, { value: fresh, fetchedAt: now });
  rebuildIndexesForUser(userId, fresh);
  return fresh;
}

function rebuildIndexesForUser(userId: string, m: AuthMethods): void {
  // Remove previous entries pointing at this user (e.g. after credential deletion)
  for (const [k, v] of walletIndex) if (v === userId) walletIndex.delete(k);
  for (const [k, v] of credentialIndex) if (v === userId) credentialIndex.delete(k);
  for (const [k, v] of didIndex) if (v === userId) didIndex.delete(k);
  for (const addr of m.walletAddresses) walletIndex.set(addr.toLowerCase(), userId);
  for (const c of m.webAuthnCredentials) credentialIndex.set(c.id, userId);
  for (const k of m.didKeys) didIndex.set(k.did, userId);
}

// Discover pods by listing the CSS root as an LDP BasicContainer. CSS emits
// `ldp:contains <child/>, <other/> ;` for every direct sub-container, which
// is exactly the set of user pods (one per user). This makes the pod layer
// — not a database — the authoritative user registry.
async function discoverUsersFromCSS(): Promise<string[]> {
  try {
    const r = await fetch(CSS_URL, { headers: { 'Accept': 'text/turtle' } });
    if (!r.ok) return [];
    const body = await r.text();
    const out: string[] = [];
    // Match ldp:contains blocks and extract child IRIs
    const re = /ldp:contains\s+([\s\S]*?)\s*(?:;|\.)/g;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = re.exec(body)) !== null) {
      const refs = blockMatch[1].match(/<([^>]+)>/g) || [];
      for (const ref of refs) {
        const path = ref.slice(1, -1);
        // Child IRIs are relative URIs ending in '/' — pod paths are "<userId>/"
        if (path.endsWith('/') && !path.startsWith('.')) {
          out.push(path.replace(/\/$/, ''));
        }
      }
    }
    return [...new Set(out)];
  } catch (err) {
    log(`WARN: could not list CSS root: ${(err as Error).message}`);
    return [];
  }
}

// Hydrate an identity shell from a pod's auth-methods.jsonld when we don't
// have an in-memory entry yet (common after a container restart). Also
// creates a default agent if auth-methods references one, so issueTokenResponse
// has something to issue for. Idempotent — skipped if the user is already in
// the identities map.
function hydrateFromAuthMethods(m: AuthMethods): void {
  if (identities.has(m.userId)) return;
  seedIdentity(m.userId, 'user', m.name);
  const agentId = m.agentId ?? `claude-mobile-${m.userId}`;
  if (!identities.has(agentId)) {
    seedIdentity(agentId, 'agent', `Claude Mobile (${m.name})`, m.userId, 'ReadWrite');
  }
}

// Rebuild all indexes from pod scans. Uses LDP discovery on CSS so users
// registered in a previous container life are recoverable without any
// in-memory state having survived. Seeded users (markj + default agents)
// are still rehydrated too in case their pods aren't in CSS yet.
async function rebuildAllIndexes(): Promise<void> {
  const seededUserIds = [...identities.values()].filter(i => i.type === 'user').map(i => i.id);
  const discoveredUserIds = await discoverUsersFromCSS();
  const allUserIds = [...new Set([...seededUserIds, ...discoveredUserIds])];
  log(`Rebuilding credential indexes from ${allUserIds.length} pod(s) (seeded=${seededUserIds.length} discovered=${discoveredUserIds.length})...`);
  let ok = 0, fail = 0;
  await Promise.all(allUserIds.map(async (uid) => {
    try {
      const m = await fetchPodAuthMethods(uid);
      // Hydrate in-memory shell so downstream token issuance works
      hydrateFromAuthMethods(m);
      authMethodsCache.set(uid, { value: m, fetchedAt: Date.now() });
      rebuildIndexesForUser(uid, m);
      ok++;
    } catch {
      fail++;
    }
  }));
  log(`Index rebuild: ${ok} pod(s) OK, ${fail} failed. users=${identities.size} wallets=${walletIndex.size} webauthn=${credentialIndex.size} dids=${didIndex.size}`);
}

// Seed with markj + agents. No passwords, no secrets — identities only
// exist to reserve names and mint DID documents. Auth is wired up after
// seeding via the user's own wallet / passkey / DID key registration.
function seedIdentity(id: string, type: 'user' | 'agent', name: string, owner?: string, scope?: string) {
  const rec: Identity = { id, type, name, createdAt: new Date().toISOString() };
  if (owner !== undefined) rec.owner = owner;
  if (scope !== undefined) rec.scope = scope;
  identities.set(id, rec);
  keys.set(id, generateEd25519());
  log(`Seeded ${type} identity: ${id} (${name})`);
}

seedIdentity('markj', 'user', 'Mark J');
seedIdentity('claude-code-vscode', 'agent', 'Claude Code (VS Code)', 'markj', 'ReadWrite');
seedIdentity('claude-code-desktop', 'agent', 'Claude Code (Desktop)', 'markj', 'ReadWrite');

// ── Challenges (nonces for proof-of-possession auth) ────────
//
// Every sign-in starts with POST /challenges -> nonce. The client then
// signs the nonce with their private key (wallet / passkey / DID key)
// and POSTs it to /verify. The server checks the nonce was issued,
// hasn't been used, hasn't expired, and that the signature matches the
// public key already on file (or being registered for first time).

interface Challenge {
  nonce: string;
  expiresAt: number;
  // Optional binding: if set, this challenge may only be used for a
  // specific auth method / WebAuthn operation. Prevents cross-use of
  // a WebAuthn-originated challenge against SIWE, etc.
  purpose?: 'siwe' | 'webauthn-register' | 'webauthn-authenticate' | 'did-sig';
  // For WebAuthn flows: the user this challenge is scoped to (so the
  // relying party knows which credentials to match against).
  userId?: string;
}

const challenges = new Map<string, Challenge>();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function issueChallenge(purpose?: Challenge['purpose'], userId?: string): Challenge {
  // Prune expired entries periodically on new issues
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expiresAt < now) challenges.delete(k);
  const nonce = crypto.randomBytes(32).toString('base64url');
  const ch: Challenge = { nonce, expiresAt: now + CHALLENGE_TTL_MS };
  if (purpose) ch.purpose = purpose;
  if (userId) ch.userId = userId;
  challenges.set(nonce, ch);
  return ch;
}

function consumeChallenge(nonce: string, purpose?: Challenge['purpose']): Challenge | null {
  const ch = challenges.get(nonce);
  if (!ch) return null;
  if (ch.expiresAt < Date.now()) { challenges.delete(nonce); return null; }
  if (purpose && ch.purpose && ch.purpose !== purpose) return null;
  challenges.delete(nonce); // single-use
  return ch;
}

// ── WebAuthn RP Config ──────────────────────────────────────
//
// Relying party: the full origin under which the user's browser will
// execute the WebAuthn ceremony. For cross-service setups (user runs
// passkey dance at relay, relay verifies at identity) set WEBAUTHN_RP_*
// consistently on both sides so the RP ID is stable.

const RP_ID = process.env['WEBAUTHN_RP_ID'] ?? new URL(BASE_URL).hostname;
const RP_NAME = process.env['WEBAUTHN_RP_NAME'] ?? 'Interego';
const RP_ORIGIN = process.env['WEBAUTHN_RP_ORIGIN'] ?? BASE_URL;

// ── Token Management ────────────────────────────────────────

function issueToken(userId: string, agentId: string, scope: string): TokenRecord {
  const token = `cg_${crypto.randomBytes(32).toString('base64url')}`;
  const now = new Date();
  const record: TokenRecord = {
    token,
    userId,
    agentId,
    scope,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000).toISOString(),
  };
  tokens.set(token, record);
  log(`Issued token for ${agentId} (user: ${userId}, scope: ${scope}, expires: ${record.expiresAt})`);
  return record;
}

function verifyToken(token: string): { valid: boolean; record?: TokenRecord; reason?: string } {
  const record = tokens.get(token);
  if (!record) return { valid: false, reason: 'Token not found' };
  if (new Date(record.expiresAt) < new Date()) {
    tokens.delete(token);
    return { valid: false, reason: 'Token expired' };
  }
  return { valid: true, record };
}

// ── DID Document Builder ────────────────────────────────────

function buildDidDocument(identity: Identity): object {
  const kp = keys.get(identity.id)!;
  const path = identity.type === 'user' ? `users:${identity.id}` : `agents:${identity.id}`;
  const did = `did:web:${new URL(BASE_URL).host}:${path}`;
  const keyId = `${did}#key-1`;
  const owner = identity.owner ?? identity.id;

  const doc: Record<string, unknown> = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: did,
    controller: identity.type === 'agent'
      ? `did:web:${new URL(BASE_URL).host}:users:${owner}`
      : did,
    verificationMethod: [{
      id: keyId,
      type: 'Ed25519VerificationKey2020',
      controller: did,
      publicKeyMultibase: kp.publicKeyMultibase,
    }],
    authentication: [keyId],
    assertionMethod: [keyId],
  };

  const podUrl = `${CSS_URL}${owner}/`;

  if (identity.type === 'agent') {
    doc['service'] = [{
      id: `${did}#solid-pod`,
      type: 'SolidStorage',
      serviceEndpoint: podUrl,
    }];
  } else {
    doc['service'] = [
      { id: `${did}#solid-pod`, type: 'SolidStorage', serviceEndpoint: podUrl },
      { id: `${did}#context-graphs`, type: 'ContextGraphsManifest', serviceEndpoint: `${podUrl}.well-known/context-graphs` },
    ];
    doc['alsoKnownAs'] = [`${BASE_URL}/users/${identity.id}/profile`];
  }

  return doc;
}

// ── WebID Profile Builder ───────────────────────────────────

function buildWebIdProfile(identity: Identity): string {
  const profileUrl = `${BASE_URL}/users/${identity.id}/profile`;
  const podUrl = `${CSS_URL}${identity.id}/`;

  const agents = [...identities.values()].filter(i => i.type === 'agent' && i.owner === identity.id);

  return [
    `@prefix foaf: <http://xmlns.com/foaf/0.1/> .`,
    `@prefix solid: <http://www.w3.org/ns/solid/terms#> .`,
    `@prefix cg: <${ONTOLOGY_URL}> .`,
    `@prefix prov: <http://www.w3.org/ns/prov#> .`,
    `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
    ``,
    `<${profileUrl}#me>`,
    `    a foaf:Person ;`,
    `    foaf:name "${identity.name}" ;`,
    `    solid:oidcIssuer <${BASE_URL}> ;`,
    `    solid:storage <${podUrl}> ;`,
    ...(agents.length > 0 ? [
      `    cg:authorizedAgent`,
      ...agents.map((a, i) => {
        const sep = i < agents.length - 1 ? ',' : ';';
        return `        <${BASE_URL}/agents/${a.id}/profile#agent>${sep}`;
      }),
    ] : []),
    `    rdfs:seeAlso <did:web:${new URL(BASE_URL).host}:users:${identity.id}> .`,
    ``,
    ...agents.map(a => [
      `<${BASE_URL}/agents/${a.id}/profile#agent>`,
      `    a cg:AuthorizedAgent, prov:SoftwareAgent ;`,
      `    rdfs:label "${a.name}" ;`,
      `    cg:agentIdentity <did:web:${new URL(BASE_URL).host}:agents:${a.id}> ;`,
      `    cg:delegatedBy <${profileUrl}#me> ;`,
      `    cg:scope "${a.scope ?? 'ReadWrite'}" .`,
      ``,
    ].join('\n')),
  ].join('\n');
}

// ── Express App ─────────────────────────────────────────────

const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, Authorization');
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    users: [...identities.values()].filter(i => i.type === 'user').length,
    agents: [...identities.values()].filter(i => i.type === 'agent').length,
    activeTokens: tokens.size,
    base: BASE_URL,
  });
});

// ── Registration ─────────────────────────────────────────────

// ── Registration (reserve a username; auth added separately) ────────
//
// POST /register — reserves a userId + creates a first agent. Auth
// methods (wallet / passkey / did key) are registered via the proof
// flows below; this endpoint does NOT require or accept passwords.
// Callers should follow up with one of the registration flows to make
// the account usable from a client that can sign challenges.

/**
 * POST /register — Reserve a new human identity + first agent.
 * Body: { name, userId, agentId, agentName?, scope? }
 * Returns: { userId, agentId, webId, did, podUrl, ... }
 *
 * No initial bearer token is issued — tokens come from /verify after
 * a successful signature proof. Register-then-authenticate is the
 * pattern because tokens imply authentication, and we have none yet.
 */
app.post('/register', (req, res) => {
  const { name, userId, agentId, agentName, scope } = req.body;
  if (!name || !userId || !agentId) {
    res.status(400).json({ error: 'name, userId, and agentId are required' });
    return;
  }
  if (identities.has(userId)) {
    res.status(409).json({ error: `User '${userId}' already exists` });
    return;
  }

  seedIdentity(userId, 'user', name);
  const agentLabel = agentName ?? `Agent (${agentId})`;
  seedIdentity(agentId, 'agent', agentLabel, userId, scope ?? 'ReadWrite');

  const host = new URL(BASE_URL).host;
  res.status(201).json({
    registered: true,
    userId,
    agentId,
    webId: `${BASE_URL}/users/${userId}/profile#me`,
    did: `did:web:${host}:users:${userId}`,
    agentDid: `did:web:${host}:agents:${agentId}`,
    podUrl: `${CSS_URL}${userId}/`,
    identityServer: BASE_URL,
    nextStep: 'Register an auth method: POST /auth/siwe, /auth/webauthn/register, or /auth/did',
  });
  log(`Registered new user: ${userId} (${name}) with agent ${agentId}`);
});

// ── Challenge issuance ──────────────────────────────────────

/**
 * POST /challenges — issue a nonce the client signs to prove key control.
 * Body: { purpose?, userId? }
 *   purpose:  'siwe' | 'webauthn-register' | 'webauthn-authenticate' | 'did-sig'
 *   userId:   for WebAuthn authenticate, scopes the challenge to a user
 *             (server returns allowed credential IDs the client may use)
 * Returns: { nonce, expiresAt, allowCredentials? }
 */
app.post('/challenges', async (req, res) => {
  const { purpose, userId } = req.body as { purpose?: Challenge['purpose']; userId?: string };
  const ch = issueChallenge(purpose, userId);
  const resp: Record<string, unknown> = { nonce: ch.nonce, expiresAt: new Date(ch.expiresAt).toISOString() };
  if (purpose === 'webauthn-authenticate' && userId) {
    // Read credentials from the user's pod (stale-while-revalidate cache)
    const methods = await readAuthMethods(userId, /* allowStale */ true);
    resp.allowCredentials = methods.webAuthnCredentials.map(c => ({
      id: c.id,
      type: 'public-key',
      transports: c.transports,
    }));
  }
  res.json(resp);
});

// ── SIWE auth (Ethereum wallet) ─────────────────────────────

/**
 * POST /auth/siwe — verify a SIWE message + signature, issue a bearer
 * token scoped to the user whose wallet is either already registered
 * or is being registered now (first-time flow).
 *
 * Body: {
 *   message: string,         // SIWE message containing the nonce
 *   signature: string,       // 0x... ECDSA signature over `message`
 *   nonce: string,           // must be the nonce inside `message` too
 *   userId?: string,         // required for first-time wallet link
 *   name?: string,           // display name if first-time
 *   agentId?: string,        // agent to mint alongside (first-time)
 * }
 */
app.post('/auth/siwe', async (req, res) => {
  const { message, signature, nonce, userId: hintedUserId, name, agentId: hintedAgentId, surfaceAgent } = req.body;
  if (!message || !signature || !nonce) {
    res.status(400).json({ error: 'message, signature, and nonce are required' });
    return;
  }
  const ch = consumeChallenge(nonce, 'siwe');
  if (!ch) {
    res.status(401).json({ error: 'Invalid or expired challenge' });
    return;
  }
  if (!String(message).includes(nonce)) {
    res.status(400).json({ error: 'SIWE message does not contain the issued nonce' });
    return;
  }

  let recoveredAddress: string;
  try {
    recoveredAddress = (await ethers.verifyMessage(message, signature)).toLowerCase();
  } catch (err) {
    res.status(401).json({ error: `SIWE signature verification failed: ${(err as Error).message}` });
    return;
  }

  // Extract wallet address from the SIWE message (second line per ERC-4361)
  const addressMatch = String(message).match(/0x[a-fA-F0-9]{40}/);
  const claimedAddress = addressMatch?.[0]?.toLowerCase();
  if (claimedAddress && claimedAddress !== recoveredAddress) {
    res.status(401).json({ error: `Signature mismatch: message claims ${claimedAddress}, recovered ${recoveredAddress}` });
    return;
  }

  // Find user by wallet address (returning user via index) or create (first-time)
  let userId = walletIndex.get(recoveredAddress);
  let user = userId ? identities.get(userId) : undefined;

  if (!user) {
    if (!hintedUserId || !name) {
      res.status(404).json({
        error: 'Wallet not linked to any user. Supply userId + name to register.',
        walletAddress: recoveredAddress,
      });
      return;
    }
    if (identities.has(hintedUserId)) {
      res.status(409).json({ error: `userId '${hintedUserId}' already taken` });
      return;
    }
    seedIdentity(hintedUserId, 'user', name);
    user = identities.get(hintedUserId)!;
    const agentId = hintedAgentId ?? `claude-mobile-${hintedUserId}`;
    seedIdentity(agentId, 'agent', `Claude Mobile (${name})`, hintedUserId, 'ReadWrite');
    // Persist wallet binding to user's pod (name + agentId included so a
    // future container restart can recover the full identity from the pod).
    const methods = emptyAuthMethods(user.id, name, agentId);
    methods.walletAddresses.push(recoveredAddress);
    try {
      await putPodAuthMethods(user.id, methods);
    } catch (err) {
      res.status(500).json({ error: `Failed to persist wallet to pod: ${(err as Error).message}` });
      return;
    }
    log(`First-time SIWE registration: ${hintedUserId} wallet=${recoveredAddress}`);
  }

  res.json(issueTokenResponse(user, surfaceAgent));
});

// ── WebAuthn / Passkeys ─────────────────────────────────────

/**
 * POST /auth/webauthn/register-options — start passkey registration.
 * Body: { userId, name }
 * Returns: PublicKeyCredentialCreationOptionsJSON (pass to navigator.credentials.create)
 */
app.post('/auth/webauthn/register-options', async (req, res) => {
  const { userId, name } = req.body;
  if (!userId || !name) {
    res.status(400).json({ error: 'userId and name are required' });
    return;
  }
  // Ensure user exists (or create shell)
  if (!identities.has(userId)) {
    seedIdentity(userId, 'user', name);
    // Also seed a default agent so the user has something to issue tokens for
    const agentId = `claude-mobile-${userId}`;
    seedIdentity(agentId, 'agent', `Claude Mobile (${name})`, userId, 'ReadWrite');
  }
  const existingMethods = await readAuthMethods(userId);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: userId,
    userDisplayName: name,
    attestationType: 'none',
    excludeCredentials: existingMethods.webAuthnCredentials.map(c => ({
      id: c.id,
      transports: (c.transports ?? []) as unknown as import('@simplewebauthn/server').AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });

  // Bind this challenge to webauthn-register for this user
  challenges.set(options.challenge, {
    nonce: options.challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    purpose: 'webauthn-register',
    userId,
  });
  res.json(options);
});

/**
 * POST /auth/webauthn/register — finish passkey registration. Verifies
 * the attestation, stores the new credential, issues a bearer token.
 * Body: { userId, response: RegistrationResponseJSON }
 */
app.post('/auth/webauthn/register', async (req, res) => {
  const { userId, response, surfaceAgent } = req.body;
  if (!userId || !response) {
    res.status(400).json({ error: 'userId and response are required' });
    return;
  }
  const user = identities.get(userId);
  if (!user || user.type !== 'user') {
    res.status(404).json({ error: `User '${userId}' not found` });
    return;
  }

  const expectedChallenge = response?.response?.clientDataJSON
    ? JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString()).challenge
    : null;
  if (!expectedChallenge) {
    res.status(400).json({ error: 'Could not extract challenge from clientDataJSON' });
    return;
  }
  const ch = consumeChallenge(expectedChallenge, 'webauthn-register');
  if (!ch || ch.userId !== userId) {
    res.status(401).json({ error: 'Invalid or expired registration challenge' });
    return;
  }

  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
    });
  } catch (err) {
    res.status(401).json({ error: `WebAuthn registration verification failed: ${(err as Error).message}` });
    return;
  }

  if (!verification.verified || !verification.registrationInfo) {
    res.status(401).json({ error: 'WebAuthn registration not verified' });
    return;
  }

  const { credential } = verification.registrationInfo;
  const methods = await readAuthMethods(userId);
  // On first enrollment the stale methods doc may not have name/agentId
  // populated — backfill from the in-memory shell so a container restart
  // can rehydrate this user straight from their pod.
  if (!methods.name || methods.name === userId) {
    methods.name = user.name;
  }
  if (!methods.agentId) {
    const a = [...identities.values()].find(i => i.type === 'agent' && i.owner === userId);
    if (a) methods.agentId = a.id;
  }
  methods.webAuthnCredentials.push({
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: (response.response?.transports as string[] | undefined) ?? [],
    createdAt: new Date().toISOString(),
  });
  try {
    await putPodAuthMethods(userId, methods);
  } catch (err) {
    res.status(500).json({ error: `Failed to persist passkey to pod: ${(err as Error).message}` });
    return;
  }
  log(`WebAuthn credential registered for ${userId}`);

  res.json(issueTokenResponse(user, surfaceAgent));
});

/**
 * POST /auth/webauthn/authenticate — finish passkey login. Verifies
 * the assertion against the user's stored credential.
 * Body: { userId, response: AuthenticationResponseJSON }
 */
app.post('/auth/webauthn/authenticate', async (req, res) => {
  const { userId, response, surfaceAgent } = req.body;
  if (!userId || !response) {
    res.status(400).json({ error: 'userId and response are required' });
    return;
  }
  const user = identities.get(userId);
  if (!user || user.type !== 'user') {
    res.status(404).json({ error: `User '${userId}' not found` });
    return;
  }
  const methods = await readAuthMethods(userId);
  const cred = methods.webAuthnCredentials.find(c => c.id === response.id);
  if (!cred) {
    res.status(401).json({ error: 'No WebAuthn credential matches this response' });
    return;
  }

  const expectedChallenge = response?.response?.clientDataJSON
    ? JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString()).challenge
    : null;
  if (!expectedChallenge) {
    res.status(400).json({ error: 'Could not extract challenge from clientDataJSON' });
    return;
  }
  const ch = consumeChallenge(expectedChallenge, 'webauthn-authenticate');
  if (!ch || (ch.userId && ch.userId !== userId)) {
    res.status(401).json({ error: 'Invalid or expired authentication challenge' });
    return;
  }

  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: cred.id,
        publicKey: Buffer.from(cred.publicKey, 'base64url'),
        counter: cred.counter,
        transports: (cred.transports ?? []) as unknown as import('@simplewebauthn/server').AuthenticatorTransportFuture[],
      },
    });
  } catch (err) {
    res.status(401).json({ error: `WebAuthn verification failed: ${(err as Error).message}` });
    return;
  }
  if (!verification.verified) {
    res.status(401).json({ error: 'WebAuthn assertion not verified' });
    return;
  }

  // Counter is bumped by the authenticator; persist the new value so the
  // next authentication rejects replay of older signed counters.
  cred.counter = verification.authenticationInfo.newCounter;
  try {
    await putPodAuthMethods(userId, methods);
  } catch (err) {
    log(`WARN: failed to persist updated passkey counter: ${(err as Error).message}`);
    // Not fatal — the user successfully authenticated this round; worst case
    // the next attempt re-accepts an older counter value (still valid per spec).
  }
  res.json(issueTokenResponse(user, surfaceAgent));
});

// ── Generic DID-signature auth (did:key / did:web) ──────────

/**
 * POST /auth/did — verify an Ed25519 signature against a pre-registered
 * DID key. Supports did:key (self-sovereign, public-key-encoded-as-DID)
 * and did:web (DID document hosted at an https URL we can fetch).
 *
 * Body: {
 *   did: string,              // did:key:z... or did:web:...
 *   nonce: string,            // from /challenges
 *   signature: string,        // base64url Ed25519 signature of nonce
 *   userId?: string,          // first-time: register this DID to this user
 *   name?: string,            // first-time display name
 *   publicKeyMultibase?: string,  // for did:key, or first-time registration
 * }
 */
app.post('/auth/did', async (req, res) => {
  const { did, nonce, signature, userId: hintedUserId, name, publicKeyMultibase, surfaceAgent } = req.body;
  if (!did || !nonce || !signature) {
    res.status(400).json({ error: 'did, nonce, and signature are required' });
    return;
  }
  const ch = consumeChallenge(nonce, 'did-sig');
  if (!ch) {
    res.status(401).json({ error: 'Invalid or expired challenge' });
    return;
  }

  // Resolve public key
  let publicKeyRaw: Buffer;
  if (did.startsWith('did:key:z') && did.length > 10) {
    // did:key multibase is the public key itself (z... base58btc)
    // For Ed25519 did:key: prefix bytes 0xed 0x01 + 32-byte key
    const rawMultibase = did.slice('did:key:'.length);
    if (!rawMultibase.startsWith('z')) {
      res.status(400).json({ error: 'Only base58btc (z-prefixed) did:key supported' });
      return;
    }
    // Decode using our multibase format (publicKeyMultibase is 'z' + base64url 32-byte raw key)
    // For interop with the simple format used elsewhere in this server
    try {
      publicKeyRaw = Buffer.from(rawMultibase.slice(1), 'base64url');
      if (publicKeyRaw.length < 32) throw new Error('key too short');
      publicKeyRaw = publicKeyRaw.subarray(publicKeyRaw.length - 32);
    } catch (err) {
      res.status(400).json({ error: `Could not decode did:key public key: ${(err as Error).message}` });
      return;
    }
  } else if (publicKeyMultibase?.startsWith('z')) {
    publicKeyRaw = Buffer.from(publicKeyMultibase.slice(1), 'base64url');
  } else {
    res.status(400).json({ error: 'Supply publicKeyMultibase alongside non-did:key DIDs' });
    return;
  }

  // Verify Ed25519 signature over the nonce
  try {
    const sig = Buffer.from(signature, 'base64url');
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), // Ed25519 SPKI prefix
      publicKeyRaw,
    ]);
    const verifyKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const ok = crypto.verify(null, Buffer.from(nonce, 'utf8'), verifyKey, sig);
    if (!ok) {
      res.status(401).json({ error: 'Ed25519 signature verification failed' });
      return;
    }
  } catch (err) {
    res.status(401).json({ error: `DID signature verification error: ${(err as Error).message}` });
    return;
  }

  // Find user by registered DID (returning) via index or create (first-time)
  let userId = didIndex.get(did);
  let user = userId ? identities.get(userId) : undefined;

  if (!user) {
    if (!hintedUserId || !name) {
      res.status(404).json({ error: 'DID not linked. Supply userId + name to register.', did });
      return;
    }
    if (identities.has(hintedUserId)) {
      res.status(409).json({ error: `userId '${hintedUserId}' already taken` });
      return;
    }
    seedIdentity(hintedUserId, 'user', name);
    user = identities.get(hintedUserId)!;
    const agentId = `claude-mobile-${hintedUserId}`;
    seedIdentity(agentId, 'agent', `Claude Mobile (${name})`, hintedUserId, 'ReadWrite');
    const methods = emptyAuthMethods(user.id, name, agentId);
    methods.didKeys.push({
      did,
      publicKeyMultibase: publicKeyMultibase ?? ('z' + publicKeyRaw.toString('base64url')),
      keyType: 'Ed25519VerificationKey2020',
      createdAt: new Date().toISOString(),
    });
    try {
      await putPodAuthMethods(user.id, methods);
    } catch (err) {
      res.status(500).json({ error: `Failed to persist DID to pod: ${(err as Error).message}` });
      return;
    }
    log(`First-time DID registration: ${hintedUserId} did=${did}`);
  }

  res.json(issueTokenResponse(user, surfaceAgent));
});

// ── Token response helper (shared across auth methods) ──────
/**
 * Ensure a per-surface agent exists for this user.
 *
 * `surfaceAgent` is a short prefix like 'claude-mobile' or 'claude-desktop'
 * coming from the relay's /oauth/verify route. We want each surface
 * (mobile app, desktop app, web client, VS Code, Slack bot, etc.) to
 * have its OWN agent entry — distinct DID, distinct X25519 key, distinct
 * revocation surface — so pod attribution and recipient lists reflect
 * which surface actually wrote each descriptor.
 *
 * If no hint is given, fall back to the first-registered agent (legacy
 * behaviour). If the hinted surface agent doesn't exist yet under this
 * user, mint it inline — safe because the proof step already validated
 * the user's key-possession.
 */
function ensureSurfaceAgent(user: Identity, surfaceAgent: string | undefined): Identity {
  if (surfaceAgent) {
    const surfaceAgentId = `${surfaceAgent}-${user.id}`;
    const existing = identities.get(surfaceAgentId);
    if (existing && existing.type === 'agent' && existing.owner === user.id) {
      return existing;
    }
    if (!existing) {
      const label = surfaceAgent
        .split('-')
        .map(p => p.charAt(0).toUpperCase() + p.slice(1))
        .join(' ');
      seedIdentity(surfaceAgentId, 'agent', `${label} (${user.name})`, user.id, 'ReadWrite');
      return identities.get(surfaceAgentId)!;
    }
  }
  const firstAgent = [...identities.values()].find(i => i.type === 'agent' && i.owner === user.id);
  if (!firstAgent) throw new Error(`User '${user.id}' has no agents`);
  return firstAgent;
}

function issueTokenResponse(user: Identity, surfaceAgent?: string): Record<string, unknown> {
  const agent = ensureSurfaceAgent(user, surfaceAgent);
  const tokenRecord = issueToken(user.id, agent.id, agent.scope ?? 'ReadWrite');
  const host = new URL(BASE_URL).host;
  // Summarise registered auth methods from cache (stale ok — this is just
  // a UI hint, not security-critical).
  const cached = authMethodsCache.get(user.id)?.value;
  return {
    userId: user.id,
    agentId: agent.id,
    token: tokenRecord.token,
    expiresAt: tokenRecord.expiresAt,
    scope: tokenRecord.scope,
    webId: `${BASE_URL}/users/${user.id}/profile#me`,
    did: `did:web:${host}:users:${user.id}`,
    agentDid: `did:web:${host}:agents:${agent.id}`,
    podUrl: `${CSS_URL}${user.id}/`,
    authMethodsUrl: podAuthMethodsUrl(user.id),
    identityServer: BASE_URL,
    authMethods: {
      wallets: cached?.walletAddresses.length ?? 0,
      webauthn: cached?.webAuthnCredentials.length ?? 0,
      dids: cached?.didKeys.length ?? 0,
    },
  };
}

/**
 * POST /register-agent — Register additional agent for existing user
 * Body: { userId, agentId, agentName, scope }
 * Requires: Authorization header with valid token for that user
 */
app.post('/register-agent', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required' });
    return;
  }

  const tokenResult = verifyToken(authHeader.slice(7));
  if (!tokenResult.valid) {
    res.status(401).json({ error: tokenResult.reason });
    return;
  }

  const { userId, agentId, agentName, scope } = req.body;
  if (tokenResult.record!.userId !== userId) {
    res.status(403).json({ error: 'Token does not belong to this user' });
    return;
  }

  if (!agentId) {
    res.status(400).json({ error: 'agentId is required' });
    return;
  }

  if (identities.has(agentId)) {
    res.status(409).json({ error: `Agent '${agentId}' already exists` });
    return;
  }

  const agentLabel = agentName ?? `Agent (${agentId})`;
  seedIdentity(agentId, 'agent', agentLabel, userId, scope ?? 'ReadWrite');
  const tokenRecord = issueToken(userId, agentId, scope ?? 'ReadWrite');

  const host = new URL(BASE_URL).host;
  res.status(201).json({
    registered: true,
    agentId,
    token: tokenRecord.token,
    expiresAt: tokenRecord.expiresAt,
    agentDid: `did:web:${host}:agents:${agentId}`,
  });
  log(`Registered new agent: ${agentId} for user ${userId}`);
});

// ── Token Management ─────────────────────────────────────────

/**
 * POST /tokens — Issue a new bearer token
 * Body: { userId, agentId }
 * Returns: { token, expiresAt }
 */
app.post('/tokens', (req, res) => {
  const { userId, agentId } = req.body;
  if (!userId || !agentId) {
    res.status(400).json({ error: 'userId and agentId are required' });
    return;
  }

  const user = identities.get(userId);
  if (!user || user.type !== 'user') {
    res.status(404).json({ error: `User '${userId}' not found` });
    return;
  }

  const agent = identities.get(agentId);
  if (!agent || agent.type !== 'agent' || agent.owner !== userId) {
    res.status(403).json({ error: `Agent '${agentId}' is not authorized for user '${userId}'` });
    return;
  }

  const record = issueToken(userId, agentId, agent.scope ?? 'ReadWrite');
  res.json({ token: record.token, expiresAt: record.expiresAt, scope: record.scope });
});

/**
 * POST /tokens/verify — Verify a bearer token
 * Body: { token }
 * Returns: { valid, userId?, agentId?, scope?, reason? }
 */
app.post('/tokens/verify', (req, res) => {
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ error: 'token is required' });
    return;
  }

  const result = verifyToken(token);
  if (result.valid) {
    res.json({
      valid: true,
      userId: result.record!.userId,
      agentId: result.record!.agentId,
      scope: result.record!.scope,
      expiresAt: result.record!.expiresAt,
    });
  } else {
    res.json({ valid: false, reason: result.reason });
  }
});

// ── DID Documents ────────────────────────────────────────────

app.get('/.well-known/did.json', (_req, res) => {
  const serverDid = `did:web:${new URL(BASE_URL).host}`;
  const kp = keys.get('markj')!;
  res.json({
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: serverDid,
    verificationMethod: [{
      id: `${serverDid}#key-1`,
      type: 'Ed25519VerificationKey2020',
      controller: serverDid,
      publicKeyMultibase: kp.publicKeyMultibase,
    }],
    authentication: [`${serverDid}#key-1`],
  });
});

app.get('/users/:id/did.json', (req, res) => {
  const identity = identities.get(req.params.id);
  if (!identity || identity.type !== 'user') { res.status(404).json({ error: 'Not found' }); return; }
  res.json(buildDidDocument(identity));
});

app.get('/agents/:id/did.json', (req, res) => {
  const identity = identities.get(req.params.id);
  if (!identity || identity.type !== 'agent') { res.status(404).json({ error: 'Not found' }); return; }
  res.json(buildDidDocument(identity));
});

// ── WebID Profiles ──────────────────────────────────────────

app.get('/users/:id/profile', (req, res) => {
  const identity = identities.get(req.params.id);
  if (!identity || identity.type !== 'user') { res.status(404).json({ error: 'Not found' }); return; }
  res.setHeader('Content-Type', 'text/turtle');
  res.send(buildWebIdProfile(identity));
});

app.get('/agents/:id/profile', (req, res) => {
  const identity = identities.get(req.params.id);
  if (!identity || identity.type !== 'agent') { res.status(404).json({ error: 'Not found' }); return; }
  const did = `did:web:${new URL(BASE_URL).host}:agents:${identity.id}`;
  const owner = identity.owner ?? 'unknown';
  res.setHeader('Content-Type', 'text/turtle');
  res.send([
    `@prefix cg: <${ONTOLOGY_URL}> .`,
    `@prefix prov: <http://www.w3.org/ns/prov#> .`,
    `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
    ``,
    `<${BASE_URL}/agents/${identity.id}/profile#agent>`,
    `    a cg:AuthorizedAgent, prov:SoftwareAgent ;`,
    `    rdfs:label "${identity.name}" ;`,
    `    cg:agentIdentity <${did}> ;`,
    `    cg:delegatedBy <${BASE_URL}/users/${owner}/profile#me> ;`,
    `    cg:scope "${identity.scope ?? 'ReadWrite'}" .`,
  ].join('\n'));
});

// ── WebFinger (RFC 7033) ────────────────────────────────────

app.get('/.well-known/webfinger', (req, res) => {
  const resource = req.query.resource as string;
  if (!resource) { res.status(400).json({ error: 'resource parameter required' }); return; }

  let userId: string | null = null;
  if (resource.startsWith('acct:')) {
    const parts = resource.slice(5).split('@');
    userId = parts[0] ?? null;
  } else {
    try {
      const url = new URL(resource);
      const match = url.pathname.match(/\/users\/([^/]+)/);
      if (match) userId = match[1] ?? null;
    } catch { /* ignore */ }
  }

  const identity = userId ? identities.get(userId) : null;
  if (!identity || identity.type !== 'user') { res.status(404).json({ error: 'Unknown resource' }); return; }

  const host = new URL(BASE_URL).host;
  res.json({
    subject: `acct:${identity.id}@${host}`,
    aliases: [
      `${BASE_URL}/users/${identity.id}/profile`,
      `did:web:${host}:users:${identity.id}`,
    ],
    links: [
      { rel: 'http://www.w3.org/ns/solid/terms#storage', href: `${CSS_URL}${identity.id}/` },
      { rel: 'http://webfinger.net/rel/profile-page', href: `${BASE_URL}/users/${identity.id}/profile` },
      { rel: 'self', type: 'application/activity+json', href: `${BASE_URL}/users/${identity.id}/profile` },
    ],
  });
});

// ── List users (for admin/dashboard) ─────────────────────────

// ── SIWE (Sign-In With Ethereum / ERC-4361) ─────────────────

/**
 * POST /siwe/verify — Verify a SIWE message signature
 * Body: { message, signature }
 * Returns: { valid, walletAddress, userId? }
 *
 * The SIWE message format (ERC-4361):
 *   {domain} wants you to sign in with your Ethereum account:
 *   {address}
 *   {statement}
 *   URI: {uri}
 *   Nonce: {nonce}
 *   Issued At: {issuedAt}
 */
app.post('/siwe/verify', (req, res) => {
  const { message, signature } = req.body;
  if (!message || !signature) {
    res.status(400).json({ error: 'message and signature are required' });
    return;
  }

  // Parse SIWE message to extract wallet address
  const addressMatch = message.match(/0x[a-fA-F0-9]{40}/);
  if (!addressMatch) {
    res.status(400).json({ error: 'No Ethereum address found in SIWE message' });
    return;
  }
  const walletAddress = addressMatch[0].toLowerCase();

  // Verify the signature using ethers.js — real ECDSA recovery
  try {
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== walletAddress) {
      res.status(401).json({ valid: false, error: `Signature mismatch: expected ${walletAddress}, recovered ${recovered.toLowerCase()}` });
      return;
    }
  } catch (err) {
    res.status(401).json({ valid: false, error: `Signature verification failed: ${(err as Error).message}` });
    return;
  }

  // Look up by pod-resident index (rebuilt from pods on startup + on writes).
  const userId = walletIndex.get(walletAddress);
  const user = userId ? identities.get(userId) : undefined;

  if (user) {
    const token = issueToken(user.id, `wallet-${walletAddress}`, 'ReadWrite');
    res.json({
      valid: true,
      walletAddress,
      userId: user.id,
      token: token.token,
      expiresAt: token.expiresAt,
    });
  } else {
    res.json({
      valid: true,
      walletAddress,
      userId: null,
      message: 'Wallet signature valid but no account linked. Use POST /auth/siwe to register.',
    });
  }
});

/**
 * POST /siwe/nonce — Generate a nonce for SIWE
 */
app.post('/siwe/nonce', (_req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  res.json({ nonce });
});

// ── ERC-8004 Agent Identity Resolution ──────────────────────

/**
 * GET /erc8004/:chain/:contract/:tokenId — Resolve ERC-8004 agent identity
 * Returns the agent's DID document if the token maps to a known agent.
 */
app.get('/erc8004/:chain/:contract/:tokenId', (req, res) => {
  const key = `${req.params.chain}:${req.params.contract}:${req.params.tokenId}`;
  // Look up agent by ERC-8004 token
  const agent = [...identities.values()].find(
    i => i.type === 'agent' && (i as any).erc8004Key === key
  );

  if (!agent) {
    res.status(404).json({
      error: 'No agent found for this ERC-8004 token',
      hint: 'POST /register-agent with erc8004 field to link an agent to a token',
    });
    return;
  }

  res.json(buildDidDocument(agent));
});

// ── List users (admin/dashboard) ─────────────────────────────

app.get('/users', (_req, res) => {
  const users = [...identities.values()]
    .filter(i => i.type === 'user')
    .map(u => ({
      id: u.id,
      name: u.name,
      agents: [...identities.values()].filter(a => a.type === 'agent' && a.owner === u.id).map(a => a.id),
      createdAt: u.createdAt,
    }));
  res.json(users);
});

// ── Wallet Linking ──────────────────────────────────────────

/**
 * POST /wallet/link — Link an existing Ethereum wallet to a user account.
 * Body: { userId, walletAddress, siweMessage, signature }
 * The user signs a SIWE message proving they own the wallet.
 */
app.post('/wallet/link', async (req, res) => {
  const { userId, walletAddress, siweMessage, signature } = req.body;
  if (!userId || !walletAddress || !siweMessage || !signature) {
    res.status(400).json({ error: 'userId, walletAddress, siweMessage, and signature are required' });
    return;
  }

  const user = identities.get(userId);
  if (!user || user.type !== 'user') {
    res.status(404).json({ error: `User '${userId}' not found` });
    return;
  }

  // Verify the SIWE signature with real ECDSA recovery
  try {
    const recovered = ethers.verifyMessage(siweMessage, signature);
    if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
      res.status(401).json({ error: `Signature mismatch: expected ${walletAddress}, recovered ${recovered}` });
      return;
    }
  } catch (err) {
    res.status(401).json({ error: `Signature verification failed: ${(err as Error).message}` });
    return;
  }

  // Persist the wallet link to the user's pod, not an in-memory field.
  const addr = (walletAddress as string).toLowerCase();
  const methods = await readAuthMethods(userId);
  if (!methods.walletAddresses.includes(addr)) {
    methods.walletAddresses.push(addr);
    try {
      await putPodAuthMethods(userId, methods);
    } catch (err) {
      res.status(500).json({ error: `Failed to persist wallet to pod: ${(err as Error).message}` });
      return;
    }
  }
  log(`Linked wallet ${addr} to user ${userId}`);

  res.json({
    linked: true,
    userId,
    walletAddress: addr,
    message: 'Wallet linked. You can now use SIWE to authenticate.',
  });
});

/**
 * GET /wallet/status/:userId — Check if a user has any linked wallets.
 */
app.get('/wallet/status/:userId', async (req, res) => {
  const user = identities.get(req.params.userId);
  if (!user || user.type !== 'user') {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const methods = await readAuthMethods(user.id, /* allowStale */ true);
  res.json({
    userId: user.id,
    hasWallet: methods.walletAddresses.length > 0,
    walletAddresses: methods.walletAddresses,
    // Legacy field preserved for older callers
    walletAddress: methods.walletAddresses[0] ?? null,
  });
});

// ── Wallet Connect Web Page ─────────────────────────────────

/**
 * GET /connect — Web page for connecting an existing Ethereum wallet.
 * Uses MetaMask/Coinbase Wallet/WalletConnect to sign a SIWE message.
 */
app.get('/connect', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Wallet — Interego</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#0a0a0f; color:#e0e0e8; display:flex; justify-content:center; align-items:center; min-height:100vh; }
  .card { background:#12121a; border:1px solid #2a2a3a; border-radius:12px; padding:32px; max-width:480px; width:100%; }
  h1 { font-size:1.4rem; margin-bottom:8px; }
  p { color:#888; margin-bottom:20px; font-size:0.9rem; line-height:1.5; }
  input { width:100%; padding:10px 14px; border:1px solid #2a2a3a; border-radius:8px; background:#0a0a0f; color:#e0e0e8; font-size:0.9rem; margin-bottom:12px; }
  button { width:100%; padding:12px; border:none; border-radius:8px; font-size:0.95rem; cursor:pointer; margin-bottom:10px; }
  .primary { background:#6366f1; color:white; }
  .primary:hover { background:#818cf8; }
  .secondary { background:#1a1a2e; color:#e0e0e8; border:1px solid #2a2a3a; }
  .secondary:hover { background:#22223a; }
  .status { padding:12px; border-radius:8px; margin-top:16px; font-size:0.85rem; display:none; }
  .status.success { display:block; background:#0a2a0a; border:1px solid #2a6a2a; color:#6ae66a; }
  .status.error { display:block; background:#2a0a0a; border:1px solid #6a2a2a; color:#e66a6a; }
  .status.info { display:block; background:#0a0a2a; border:1px solid #2a2a6a; color:#6a6ae6; }
  .step { margin-bottom:16px; padding-bottom:16px; border-bottom:1px solid #1a1a2a; }
  .step:last-child { border-bottom:none; }
  label { display:block; font-size:0.8rem; color:#888; margin-bottom:4px; }
  code { background:#1a1a2e; padding:2px 6px; border-radius:4px; font-size:0.85rem; }
</style>
</head>
<body>
<div class="card">
  <h1>Connect Wallet to Interego</h1>
  <p>Link your Ethereum wallet to your Interego identity. This proves you own the wallet via a SIWE (Sign-In With Ethereum) signature.</p>

  <div class="step">
    <label>Your User ID</label>
    <input id="userId" placeholder="e.g. markj" />
  </div>

  <div id="step-metamask" class="step">
    <button class="primary" onclick="connectMetaMask()">Connect with MetaMask / Browser Wallet</button>
    <p style="margin-top:8px;margin-bottom:0;">Your wallet will prompt you to sign a message. No transaction, no gas, no cost.</p>
  </div>

  <div id="step-manual" class="step">
    <label>Or paste wallet address + signature manually (for CLI users)</label>
    <input id="manualAddress" placeholder="0x..." />
    <input id="manualSignature" placeholder="Signature (0x...)" />
    <button class="secondary" onclick="linkManual()">Link Wallet</button>
  </div>

  <div id="status" class="status"></div>
</div>

<script>
const BASE = window.location.origin;

function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
}

async function connectMetaMask() {
  if (!window.ethereum) {
    setStatus('No wallet detected. Install MetaMask or use the manual flow below.', 'error');
    return;
  }

  const userId = document.getElementById('userId').value.trim();
  if (!userId) { setStatus('Enter your User ID first.', 'error'); return; }

  try {
    setStatus('Requesting wallet connection...', 'info');
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const address = accounts[0];

    // Get nonce from server
    const nonceResp = await fetch(BASE + '/siwe/nonce', { method: 'POST' });
    const { nonce } = await nonceResp.json();

    // Build SIWE message
    const domain = window.location.host;
    const uri = window.location.origin;
    const issuedAt = new Date().toISOString();
    const siweMessage = domain + ' wants you to sign in with your Ethereum account:\\n'
      + address + '\\n\\n'
      + 'Link wallet to Interego identity: ' + userId + '\\n\\n'
      + 'URI: ' + uri + '\\n'
      + 'Version: 1\\n'
      + 'Chain ID: 1\\n'
      + 'Nonce: ' + nonce + '\\n'
      + 'Issued At: ' + issuedAt;

    setStatus('Please sign the message in your wallet...', 'info');

    // Request signature
    const signature = await window.ethereum.request({
      method: 'personal_sign',
      params: [siweMessage, address],
    });

    // Send to server
    const linkResp = await fetch(BASE + '/wallet/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        walletAddress: address,
        siweMessage,
        signature,
      }),
    });
    const result = await linkResp.json();

    if (result.linked) {
      setStatus('Wallet ' + address + ' linked to ' + userId + ' successfully! You can close this page.', 'success');
    } else {
      setStatus('Link failed: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
  }
}

async function linkManual() {
  const userId = document.getElementById('userId').value.trim();
  const address = document.getElementById('manualAddress').value.trim();
  const signature = document.getElementById('manualSignature').value.trim();

  if (!userId || !address || !signature) {
    setStatus('Fill in all fields: User ID, wallet address, and signature.', 'error');
    return;
  }

  // Build the same SIWE message the CLI would build
  const domain = window.location.host;
  const siweMessage = domain + ' wants you to sign in with your Ethereum account:\\n'
    + address + '\\n\\n'
    + 'Link wallet to Interego identity: ' + userId + '\\n\\n'
    + 'URI: ' + window.location.origin + '\\n'
    + 'Version: 1\\n'
    + 'Chain ID: 1\\n'
    + 'Nonce: manual\\n'
    + 'Issued At: ' + new Date().toISOString();

  try {
    const resp = await fetch(BASE + '/wallet/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, walletAddress: address, siweMessage, signature }),
    });
    const result = await resp.json();

    if (result.linked) {
      setStatus('Wallet ' + address + ' linked to ' + userId + '!', 'success');
    } else {
      setStatus('Link failed: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
  }
}
</script>
</body>
</html>`);
});

// ── Start ───────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`Interego Identity Server v2 started on port ${PORT}`);
  log(`Base URL: ${BASE_URL}`);
  log(`CSS URL: ${CSS_URL}`);
  log(`WebAuthn RP: id=${RP_ID} origin=${RP_ORIGIN}`);
  log(`Auth: decentralized — user credentials stored per-pod at <pod>/auth-methods.jsonld`);
  log(`Endpoints:`);
  log(`  POST /register                        Reserve user+agent (no auth)`);
  log(`  POST /challenges                      Issue proof-of-possession nonce`);
  log(`  POST /auth/siwe                       Sign-In With Ethereum`);
  log(`  POST /auth/webauthn/register-options  Begin passkey enrollment`);
  log(`  POST /auth/webauthn/register          Finish passkey enrollment`);
  log(`  POST /auth/webauthn/authenticate      Passkey sign-in`);
  log(`  POST /auth/did                        Ed25519 DID-signature auth`);
  log(`  POST /tokens/verify                   Verify bearer token`);
  log(`  GET  /users/:id/did.json              User DID document`);
  log(`  GET  /users/:id/profile               WebID profile (Turtle)`);
  log(`  GET  /.well-known/webfinger           WebFinger (RFC 7033)`);
  log(`  GET  /health                          Health check`);

  // Rebuild credential indexes from existing pod data so users who registered
  // before this container restarted are still reachable without re-enrolling.
  // Non-blocking — health checks come up immediately, indexes populate async.
  rebuildAllIndexes().catch(err => log(`WARN: initial index rebuild failed: ${(err as Error).message}`));
});
