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
import { corsMiddleware } from './cors-allowlist.js';
import {
  lookupWebFingerIdentity,
  buildWebFingerJrd,
  applyWebFingerRelFilter,
  parseWebFingerResource,
} from './webfinger.js';
import {
  getCachedParsedDid,
  setCachedParsedDid,
  getOrCreateEd25519VerifyKey,
} from './did-parse.js';
import { startTiming, logTiming, timingEnabled } from './timing.js';
import {
  deriveUserIdFromCredentialId,
  deriveUserIdFromWallet,
  deriveUserIdFromDid,
} from './derive-userid.js';
import { resolveTargetUserId } from './resolve-target-userid.js';

// ── Lazy heavy imports ──────────────────────────────────────
//
// Per cold-start profiling, the eager top-of-file imports of `ethers`
// (~250-450ms parse + ~5MB of JS) and `@simplewebauthn/server` (~150-300ms
// + CBOR/COSE-key/asn1.js transitive deps) ran on every module load even
// when the very first request was /auth/did, which uses neither. We
// replace the eager imports with a singleton-promise loader per
// dependency so the first call into a SIWE or WebAuthn handler pays the
// load cost ONCE, and /auth/did / /try / /tokens never pay it at all.
//
// The same handlers `await` the loader directly — no change to wire
// shape, no change to handler return value.

type EthersModule = typeof import('ethers');
type WebAuthnModule = typeof import('@simplewebauthn/server');
// Reduce noise — these are the symbols we actually use from each module.
type VerifiedRegistrationResponse = Awaited<
  ReturnType<WebAuthnModule['verifyRegistrationResponse']>
>;
type VerifiedAuthenticationResponse = Awaited<
  ReturnType<WebAuthnModule['verifyAuthenticationResponse']>
>;

let _ethersPromise: Promise<EthersModule> | null = null;
function loadEthers(): Promise<EthersModule> {
  return (_ethersPromise ??= import('ethers'));
}

let _webauthnPromise: Promise<WebAuthnModule> | null = null;
function loadWebAuthn(): Promise<WebAuthnModule> {
  return (_webauthnPromise ??= import('@simplewebauthn/server'));
}

// ── Config ──────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8090');
const BASE_URL = process.env['BASE_URL'] ?? `http://localhost:${PORT}`;
const CSS_URL = process.env['CSS_URL'] ?? 'https://interego-css.internal.livelysky-8b81abb0.eastus.azurecontainerapps.io/';
// Hoist these once at module load so hot-path handlers don't re-parse
// the same URL on every request (per-request `new URL(BASE_URL).host` was
// showing up on every issueTokenResponse, did-doc build, agent registry
// write, etc.). Constructing `new URL()` is ~5µs each but it ran a dozen
// times per /auth/did call.
const BASE_URL_HOST = new URL(BASE_URL).host;
const BASE_URL_HOST_NO_PORT = BASE_URL_HOST.replace(/:.*$/, '');
const BASE_URL_HOSTNAME = new URL(BASE_URL).hostname;
// The sibling MCP relay — surfaced on the landing page so agent
// operators can copy it into their MCP client without hunting.
// No literal-URL fallback: IaC is the source of truth (see the
// `Wire identity env vars` step in .github/workflows/deploy-azure.yml).
// A baked-in default silently masks a skipped wire-step and points the
// binary at a stale host.
const RELAY_URL_RAW = process.env['RELAY_URL'];
if (!RELAY_URL_RAW) {
  throw new Error('RELAY_URL is required at startup — IaC (deploy-azure.yml `Wire identity env vars`) must set it.');
}
const RELAY_URL = RELAY_URL_RAW.replace(/\/$/, '');
const REPO_URL = process.env['REPO_URL'] ?? 'https://github.com/markjspivey-xwisee/interego';
const ONTOLOGY_URL = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const TOKEN_TTL_SECONDS = 86400; // 24 hours

// Shared secret guarding POST /tokens/verify. Mirrors the relay's
// /verify-token introspection-secret pattern: any legitimate caller
// (the css-gate today) carries `Authorization: Bearer <secret>`. Without
// this gate the endpoint is an open oracle that lets an attacker
// confirm a captured bearer is a live identity token AND harvest its
// bound userId / agentId / scope for downstream targeting. Token-forging
// is already prevented by TOKEN_SIGNING_KEY; this is info-disclosure
// tightening on the verification surface.
//
// Rollout: when unset, the endpoint stays open (legacy behavior) so
// existing css-gate deployments keep working until they're rewired with
// the same secret. Production deployments MUST set this once the gate
// carries IDENTITY_INTROSPECTION_SECRET.
const IDENTITY_INTROSPECTION_SECRET = process.env['IDENTITY_INTROSPECTION_SECRET'] ?? '';

function log(msg: string) { console.log(`[identity] ${msg}`); }

// ── Bootstrap invites ───────────────────────────────────────
//
// Seeded users (markj, pre-existing pod paths) cannot be claimed by an
// arbitrary caller — that was the pre-fix vulnerability. Instead, the
// operator configures BOOTSTRAP_INVITES="userA:tokenA,userB:tokenB".
// The token is presented exactly once on first-enrollment to bind the
// very first credential to the seeded userId. All subsequent devices
// for that user enroll via the authenticated add-credential flow
// (bearer token proving control of an already-bound credential), not
// via the bootstrap invite.
//
// Why: canonical identity is the credential, not a string. The seeded
// userId 'markj' is a display alias + pod path; only the legitimate
// owner knows the invite (out-of-band) and only a successful auth with
// an already-bound credential proves ownership thereafter.
const BOOTSTRAP_INVITES: Map<string, string> = (() => {
  const raw = process.env['BOOTSTRAP_INVITES'] ?? '';
  const m = new Map<string, string>();
  for (const pair of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const uid = pair.slice(0, idx);
    const tok = pair.slice(idx + 1);
    if (uid && tok) m.set(uid, tok);
  }
  return m;
})();
// Consumed invites are remembered in-memory for process lifetime.
// Durable consumption is implicit: once the user has any credential on
// file in their pod, `hasAnyCredential(user)` is true and the invite
// flow refuses to run regardless of CONSUMED_INVITES state. So even
// after a container restart, the attacker cannot re-use an invite to
// add a second credential — the have-credentials guard fires first.
const CONSUMED_INVITES: Set<string> = new Set();

function hasAnyCredential(m: AuthMethods): boolean {
  return m.walletAddresses.length > 0
    || m.webAuthnCredentials.length > 0
    || m.didKeys.length > 0;
}

function verifyBootstrapInvite(userId: string, token: string | undefined): boolean {
  if (!token) return false;
  const expected = BOOTSTRAP_INVITES.get(userId);
  if (!expected) return false;
  // Constant-time comparison so the response-time signal can't be used to
  // enumerate the invite token character-by-character. `timingSafeEqual`
  // requires equal-length buffers, so a length mismatch is the short-circuit.
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  if (CONSUMED_INVITES.has(userId)) return false;
  CONSUMED_INVITES.add(userId);
  return true;
}

// ── UserId derivation (canonical identity, not user-claimed) ─
//
// Every fresh registration derives the userId deterministically from
// the credential material being enrolled. Attackers cannot steal
// someone else's userId by typing it because the userId is a function
// of a keypair they don't control. Seeded legacy userIds (markj) are
// protected separately by BOOTSTRAP_INVITES.
//
// IMPORTANT — derivation is GLOBAL, by design:
//   * The same credential / wallet / DID enrolling on a second
//     identity-server instance produces the SAME userId. This is the
//     "DIDs are canonical; userId is derived" invariant in CLAUDE.md —
//     the userId is a deterministic function of the cryptographic
//     material, not of the pod hosting the enrollment.
//   * Per-pod registration STILL checks for duplicate credentials within
//     that pod (so the same passkey can't enroll twice on the same pod
//     and accumulate state), but it does NOT prevent the user from
//     enrolling the same credential on a different pod. That's the
//     federated identity story: the same user is the same user across
//     pods, identified by the same userId derived from the same DID.
//   * If you ever want a pod-LOCAL identity, that's a different
//     construct (use a fresh credential per pod). Don't try to make
//     userId pod-scoped — that would re-centralize the namespace.
// Three deterministic userId-derivation functions live in
// ./derive-userid.ts so they can be unit-tested with frozen vectors
// without importing this file (which has top-level `app.listen` side
// effects). See the section comment above for the federation invariant
// these shapes encode.

// ── Key Generation ──────────────────────────────────────────

interface KeyPair {
  // Ed25519 signing key (DID authentication / assertionMethod).
  publicKeyMultibase: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  // X25519 key-agreement key (DID `keyAgreement` — used by remote pods
  // wrapping content for this identity as an envelope recipient).
  // Per-identity so each agent has its own encryption key (FIX 6 — paired
  // with FIX 3); the `keys.get(id)` map is the single source of truth.
  x25519PublicKeyMultibase: string;
  x25519PrivateKey: crypto.KeyObject;
  x25519PublicKey: crypto.KeyObject;
  /** Raw 32-byte X25519 public key, base64-encoded — matches the on-pod
   *  `iep:AuthorizedAgent.encryptionPublicKey` shape so cross-pod sharing
   *  can resolve a DID doc keyAgreement key and use it as a recipient
   *  without a second registry round-trip. */
  x25519PublicKeyBase64: string;
}

// ── base58btc (Bitcoin alphabet) — for W3C did:key + multibase ──
//
// `did:key:z<...>` per the W3C did:key Method Spec is multibase-encoded
// with prefix 'z' = base58btc, and the decoded bytes are
//   multicodec_prefix || raw_public_key
// For Ed25519 the multicodec prefix is the varint 0xed 0x01, followed by
// the 32-byte raw public key — total 34 bytes.
//
// Why hand-rolled: this deploy package intentionally keeps zero runtime
// deps beyond express/ethers/@simplewebauthn (see package.json) and
// pulls no separate base58/multibase library. The implementation is
// ~30 LOC of unambiguous arithmetic; correctness is verified against
// the W3C did:key test vectors at runtime via the round-trip
// emit-then-parse done on every new registration.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) m[BASE58_ALPHABET[i]!] = i;
  return m;
})();

function base58btcEncode(bytes: Uint8Array): string {
  // Count leading zero bytes — each maps to a '1' in the output.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Convert the big-endian byte string to base58 by repeated division.
  // Work on a copy because we mutate.
  const buf = Array.from(bytes);
  const out: number[] = [];
  let start = zeros;
  while (start < buf.length) {
    let carry = 0;
    for (let i = start; i < buf.length; i++) {
      const v = (buf[i]! & 0xff) + carry * 256;
      buf[i] = Math.floor(v / 58);
      carry = v % 58;
    }
    out.push(carry);
    if (buf[start] === 0) start++;
  }
  let result = '';
  for (let i = 0; i < zeros; i++) result += BASE58_ALPHABET[0];
  for (let i = out.length - 1; i >= 0; i--) result += BASE58_ALPHABET[out[i]!];
  return result;
}

function base58btcDecode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < str.length && str[zeros] === BASE58_ALPHABET[0]) zeros++;
  const buf: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;
    const digit = BASE58_INDEX[ch];
    if (digit === undefined) throw new Error(`invalid base58 character '${ch}' at position ${i}`);
    let carry = digit;
    for (let j = 0; j < buf.length; j++) {
      const v = buf[j]! * 58 + carry;
      buf[j] = v & 0xff;
      carry = v >> 8;
    }
    while (carry > 0) {
      buf.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // The leading-zero-character count from base58 reflects leading zero
  // bytes in the original. Append them.
  const out = new Uint8Array(zeros + buf.length);
  for (let i = 0; i < buf.length; i++) out[zeros + i] = buf[buf.length - 1 - i]!;
  return out;
}

// Multicodec varint for Ed25519 public key: 0xed 0x01.
const ED25519_MULTICODEC = Uint8Array.from([0xed, 0x01]);
// Multicodec varint for X25519 public key: 0xec 0x01.
const X25519_MULTICODEC = Uint8Array.from([0xec, 0x01]);

/**
 * Encode a 32-byte raw Ed25519 public key as a W3C-spec multibase string:
 *   'z' + base58btc(0xed 0x01 || rawKey)
 * This is the canonical form for `did:key:z…` and for the
 * `publicKeyMultibase` field of `Ed25519VerificationKey2020`.
 */
function encodeEd25519Multibase(rawKey: Buffer): string {
  if (rawKey.length !== 32) throw new Error(`Ed25519 raw key must be 32 bytes, got ${rawKey.length}`);
  const buf = new Uint8Array(ED25519_MULTICODEC.length + 32);
  buf.set(ED25519_MULTICODEC, 0);
  buf.set(rawKey, ED25519_MULTICODEC.length);
  return 'z' + base58btcEncode(buf);
}

/**
 * Encode a 32-byte raw X25519 public key as a W3C-spec multibase string:
 *   'z' + base58btc(0xec 0x01 || rawKey)
 * Canonical form for `publicKeyMultibase` on `X25519KeyAgreementKey2020`
 * verification methods (W3C Security Vocabulary — X25519 Key Agreement 2020).
 */
function encodeX25519Multibase(rawKey: Buffer): string {
  if (rawKey.length !== 32) throw new Error(`X25519 raw key must be 32 bytes, got ${rawKey.length}`);
  const buf = new Uint8Array(X25519_MULTICODEC.length + 32);
  buf.set(X25519_MULTICODEC, 0);
  buf.set(rawKey, X25519_MULTICODEC.length);
  return 'z' + base58btcEncode(buf);
}

/**
 * Parse a `did:key:z…` Ed25519 DID and return the 32-byte raw public key.
 *
 * Compat strategy (FIX 3): canonical W3C base58btc-with-multicodec is
 * tried first. If that fails we fall back to the legacy
 * `'z' + base64url(rawKey)` shape this server originally emitted, so
 * pre-existing clients that registered under the old encoding keep
 * working. The fallback logs a deprecation marker; a future relay
 * version will flip this to a hard 400.
 *
 * Returns either `{ ok: true, publicKey, format }` or
 * `{ ok: false, error }`.
 */
function parseEd25519DidKey(did: string): { ok: true; publicKey: Buffer; format: 'base58btc' | 'base64url-legacy' } | { ok: false; error: string } {
  if (!did.startsWith('did:key:')) return { ok: false, error: 'not a did:key DID' };
  const rawMultibase = did.slice('did:key:'.length);
  if (!rawMultibase.startsWith('z')) {
    return { ok: false, error: 'only base58btc (z-prefixed) multibase is supported for did:key' };
  }
  const encoded = rawMultibase.slice(1);
  // Try canonical W3C form first.
  try {
    const decoded = base58btcDecode(encoded);
    if (decoded.length === 34
      && decoded[0] === ED25519_MULTICODEC[0]
      && decoded[1] === ED25519_MULTICODEC[1]) {
      return { ok: true, publicKey: Buffer.from(decoded.subarray(2)), format: 'base58btc' };
    }
  } catch { /* fall through to legacy path */ }
  // Legacy fallback: 'z' + base64url(rawKey).
  try {
    const legacy = Buffer.from(encoded, 'base64url');
    if (legacy.length >= 32) {
      const publicKey = legacy.subarray(legacy.length - 32);
      log(`[did-key-legacy] accepted base64url-encoded did:key for ${did.slice(0, 24)}…; client should migrate to W3C base58btc encoding`);
      return { ok: true, publicKey: Buffer.from(publicKey), format: 'base64url-legacy' };
    }
  } catch { /* fall through */ }
  return {
    ok: false,
    error: 'could not decode did:key public key — tried W3C base58btc(0xed 0x01 || key) (the spec form) and legacy base64url(rawKey); neither yielded a 32-byte Ed25519 public key',
  };
}

function generateEd25519(): KeyPair {
  // Ed25519 — signing / authentication / assertionMethod.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const edSpki = publicKey.export({ type: 'spki', format: 'der' });
  const edRaw = edSpki.subarray(edSpki.length - 32);
  const publicKeyMultibase = encodeEd25519Multibase(edRaw);

  // X25519 — keyAgreement (envelope-recipient key for cross-pod E2EE
  // sharing). Per-identity so each agent has its own encryption key
  // (FIX 6 with FIX 3). Extract raw 32 bytes via JWK (`x`) — avoids
  // hand-parsing SPKI DER.
  const { publicKey: x25519PublicKey, privateKey: x25519PrivateKey } = crypto.generateKeyPairSync('x25519');
  const xJwk = x25519PublicKey.export({ format: 'jwk' }) as { x?: string };
  if (typeof xJwk.x !== 'string') {
    throw new Error('X25519 public key JWK missing `x` field; cannot derive raw key');
  }
  const xRaw = Buffer.from(xJwk.x, 'base64url');
  if (xRaw.length !== 32) {
    throw new Error(`X25519 raw public key must be 32 bytes, got ${xRaw.length}`);
  }
  const x25519PublicKeyMultibase = encodeX25519Multibase(xRaw);
  const x25519PublicKeyBase64 = xRaw.toString('base64');

  return {
    publicKeyMultibase,
    privateKey,
    publicKey,
    x25519PublicKeyMultibase,
    x25519PrivateKey,
    x25519PublicKey,
    x25519PublicKeyBase64,
  };
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
// predicates live under the iep: and sec: namespaces; any RDF-aware tool
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
  /**
   * Per-user token-revocation marker. Tokens carry the epoch they were
   * issued under; sign-out-everywhere increments this and any token with
   * a smaller epoch fails verification. Defaults to 0 when absent
   * (back-compat for auth-methods.jsonld files written before this
   * field existed). The pod is the source of truth.
   */
  sessionEpoch?: number;
}

function emptyAuthMethods(userId: string, name = userId, agentId?: string): AuthMethods {
  const m: AuthMethods = {
    '@context': {
      iep: ONTOLOGY_URL,
      sec: 'https://w3id.org/security#',
      xsd: 'http://www.w3.org/2001/XMLSchema#',
    },
    '@id': `#auth-${userId}`,
    '@type': 'iep:AuthMethods',
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

// lowercased wallet address → userId
const walletIndex: Map<string, string> = new Map();
// webauthn credential id → userId
const credentialIndex: Map<string, string> = new Map();
// did → userId
const didIndex: Map<string, string> = new Map();

// Per-user auth-methods cache with a short TTL. Stale-while-revalidate:
// a cache miss or expired entry triggers a pod fetch but returns the
// stale value in the meantime on non-critical reads.
//
// TTL reasoning (security audit Sec #13): the previous 60s TTL opened
// a window where a passkey/wallet revoked DIRECTLY on the pod
// (operator SSH-ing in, or a parallel identity-server replica writing
// to the same pod) wouldn't be reflected here for up to 60 seconds —
// an attacker holding a recently-revoked credential could still
// authenticate during that window. Writes THROUGH this server's
// endpoints update the cache + indexes synchronously
// (see putPodAuthMethods), so the TTL only matters for out-of-band
// updates.
//
// Reduced to 10s — still gives meaningful cache hit ratio (the
// typical auth flow does multiple reads in close succession) without
// the long stale-credential window. Pair this with the existing
// putPodAuthMethods cache invalidation for the in-server write case,
// and any caller worried about TOCTOU on an extremely sensitive
// check can pass allowStale=false to skip the cache entirely.
const authMethodsCache: Map<string, { value: AuthMethods; fetchedAt: number }> = new Map();
const AUTH_METHODS_TTL_MS = 10 * 1000;

// ── Per-userId pod-write mutex (FIX A) ──────────────────────
//
// Mirrors deploy/mcp-relay/server.ts:podWriteMutexes — but keyed by
// userId (not podUrl) because every putPodAuthMethods call targets the
// same `<CSS_URL><userId>/auth-methods.jsonld` URL for a given userId.
// Used to serialise the deferred background PUT scheduled off the hot
// /auth/did response path against any other inline putPodAuthMethods
// call sites that touch the same user (webauthn counter-persist, /try
// provisioning, admin/account routes) — one writer per userId at a
// time so a fast in-flight deferred write is never clobbered by a
// concurrent reader's createIfMissing refresh.
const identityPodWriteMutexes = new Map<string, Promise<unknown>>();

// Tracks userIds whose deferred pod write is still in flight. The
// readAuthMethods cache-eviction path checks this set and treats the
// in-memory cache value as authoritative while a write is pending,
// avoiding a refresh fetch racing the in-flight write.
const identityPendingPodWrites = new Set<string>();

async function withIdentityPodMutex<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = identityPodWriteMutexes.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Chain so the next caller waits for THIS call's gate, not the prior
  // one. Errors from prior callers must not propagate to the next caller.
  identityPodWriteMutexes.set(userId, prev.then(() => gate, () => gate));
  try {
    await prev.catch(() => undefined);
    return await fn();
  } finally {
    release();
    queueMicrotask(() => {
      if (identityPodWriteMutexes.get(userId) === gate) identityPodWriteMutexes.delete(userId);
    });
  }
}

// Set of userIds for which the canonical auth-methods.jsonld has been
// observed to exist on the pod (a putPodAuthMethods completed at least
// once in this process lifetime). Same shape as the relay's
// `bootstrappedPods` Set — lets a process restart short-circuit the
// repeated empty-doc materialisation that fetchPodAuthMethods's
// createIfMissing path triggers when a deferred write has not landed.
const bootstrapUserIds = new Set<string>();

/**
 * Apply an authoritative AuthMethods record to the in-process truth
 * (cache + indexes) BEFORE the pod-side PUT lands. Lets /auth/did
 * race ahead of the network round-trip — any concurrent /auth/did
 * or verifyToken from the same userId immediately sees the new
 * credential in didIndex / authMethodsCache.
 *
 * This is the same pair of side-effects putPodAuthMethods runs AFTER
 * its successful PUT (see lines below); hoisting them lets the hot
 * response path skip the await.
 */
function inlineApplyAuthMethods(userId: string, methods: AuthMethods): void {
  authMethodsCache.set(userId, { value: methods, fetchedAt: Date.now() });
  rebuildIndexesForUser(userId, methods);
}

/**
 * Schedule a putPodAuthMethods to run in the background under the
 * per-userId mutex. The caller has already applied `inlineApplyAuthMethods`
 * so the response can race ahead. Failures retry with backoff (3 attempts
 * at 1s/2s/4s); final failure is logged at ERROR level. The in-memory
 * record stays authoritative for the process lifetime in that case —
 * the user's next /auth/did with the same DID re-derives the same
 * (content-addressed) userId and the next putPodAuthMethods writes the
 * canonical record. Effectively self-healing on next login.
 */
function scheduleDeferredAuthMethodsWrite(
  userId: string,
  methods: AuthMethods,
  context: string,
): void {
  identityPendingPodWrites.add(userId);
  // setImmediate (not setTimeout) so the background task runs on the
  // next event-loop tick AFTER res.json's socket flush — minimises the
  // window where a process restart loses the in-flight write.
  setImmediate(() => {
    void withIdentityPodMutex(userId, async () => {
      const podWriteStart = timingEnabled() ? startTiming() : 0;
      const delays = [1000, 2000, 4000];
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < delays.length + 1; attempt++) {
        try {
          await putPodAuthMethods(userId, methods);
          if (timingEnabled()) logTiming('did-pod-write-completed', podWriteStart, { context, attempt });
          bootstrapUserIds.add(userId);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err as Error;
          if (attempt < delays.length) {
            await new Promise(r => setTimeout(r, delays[attempt]));
          }
        }
      }
      if (lastErr) {
        // ERROR-level — operators need to see this. The in-memory
        // record stays authoritative; metric for alerting:
        // identity_deferred_authmethods_failed.
        log(`ERROR: identity_deferred_authmethods_failed userId=${userId} context=${context} err=${lastErr.message}`);
      }
    }).finally(() => {
      identityPendingPodWrites.delete(userId);
    });
  });
}

function podAuthMethodsUrl(userId: string): string {
  return `${CSS_URL}${userId}/auth-methods.jsonld`;
}

async function fetchPodAuthMethods(
  userId: string,
  opts: { createIfMissing?: boolean } = {},
): Promise<AuthMethods> {
  const { createIfMissing = true } = opts;
  const url = podAuthMethodsUrl(userId);
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/ld+json' } });
    if (r.status === 404) {
      if (!createIfMissing) {
        // Caller is doing passive discovery (index rebuild) — don't materialize
        // an empty file just because the container exists. That would turn every
        // service-pod / inert pim:Storage shell into a phantom user on every restart.
        throw new Error('404 (createIfMissing=false)');
      }
      // First touch from an active auth flow — write an empty file so the caller
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
  // Record that auth-methods.jsonld now exists on the pod so future
  // restarts can short-circuit re-writes (relay's bootstrappedPods pattern).
  bootstrapUserIds.add(userId);
}

// ── Pod-side WebID profile/card mirror (DEPRECATED — see FIX A) ──
//
// As of FIX A the identity server NO LONGER writes the pod-side
// `<pod>/profile/card` or `<pod>/agents` documents. The MCP relay's
// /oauth/verify handler is the single authoritative pod-side writer
// for both — it has the OAuth context, the user's identityToken, and
// the relay's X25519 keypair needed to populate
// `iep:AuthorizedAgent.encryptionPublicKey` on the registry entry, and
// it runs the writes synchronously before returning the OAuth code.
//
// The functions below (`buildPodProfileCard`, `putPodProfileCard`,
// `buildPodAgentRegistry`, `putPodAgentRegistry`) are kept as dead
// code only as a reference for the document shape; they are not
// called from any code path. Do not re-enable without a coordinated
// change to the relay — two writers racing on the same CSS file
// backend produced the "Read counter would become negative" 500s the
// FIX A migration is closing out.
//
// Background: the identity server's canonical WebID document lives at
// `${BASE_URL}/users/<userId>/profile` (see buildWebIdProfile +
// app.get('/users/:id/profile')). Conventional Solid clients (Penny,
// Inrupt's @inrupt/solid-client, NSS-derived profile dereferencers)
// expect a `<pod>/profile/card` document whose `<#me>` declares
// `solid:oidcIssuer` and `solid:storage`. The relay mirrors a
// pod-self-sufficient version of that card under FIX A.

function podProfileCardUrl(userId: string): string {
  return `${CSS_URL}${userId}/profile/card`;
}

function buildPodProfileCard(identity: Identity): string {
  const cardUrl = podProfileCardUrl(identity.id);
  const podUrl = `${CSS_URL}${identity.id}/`;
  const canonicalWebId = `${BASE_URL}/users/${identity.id}/profile#me`;
  const host = new URL(BASE_URL).host;

  const agents = [...identities.values()].filter(i => i.type === 'agent' && i.owner === identity.id);

  return [
    `@prefix foaf: <http://xmlns.com/foaf/0.1/> .`,
    `@prefix solid: <http://www.w3.org/ns/solid/terms#> .`,
    `@prefix pim: <http://www.w3.org/ns/pim/space#> .`,
    `@prefix iep: <${ONTOLOGY_URL}> .`,
    `@prefix prov: <http://www.w3.org/ns/prov#> .`,
    `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
    ``,
    `<${cardUrl}#me>`,
    `    a foaf:Person ;`,
    `    foaf:name "${identity.name}" ;`,
    `    solid:oidcIssuer <${BASE_URL}> ;`,
    `    solid:storage <${podUrl}> ;`,
    `    pim:storage <${podUrl}> ;`,
    ...(agents.length > 0 ? [
      `    iep:authorizedAgent`,
      ...agents.map((a, i) => {
        const sep = i < agents.length - 1 ? ',' : ';';
        return `        <${BASE_URL}/agents/${a.id}/profile#agent>${sep}`;
      }),
    ] : []),
    `    rdfs:seeAlso <${canonicalWebId}>, <did:web:${host}:users:${identity.id}> .`,
    ``,
    ...agents.map(a => [
      `<${BASE_URL}/agents/${a.id}/profile#agent>`,
      `    a iep:AuthorizedAgent, prov:SoftwareAgent ;`,
      `    rdfs:label "${a.name}" ;`,
      `    iep:agentIdentity <did:web:${host}:agents:${a.id}> ;`,
      `    iep:delegatedBy <${cardUrl}#me> ;`,
      `    iep:scope "${a.scope ?? 'ReadWrite'}" .`,
      ``,
    ].join('\n')),
  ].join('\n');
}

async function putPodProfileCard(userId: string): Promise<void> {
  const identity = identities.get(userId);
  if (!identity || identity.type !== 'user') {
    // Nothing to mirror — caller usually invoked this fire-and-forget
    // for a surface-agent mint that happens to race with user teardown.
    return;
  }
  const url = podProfileCardUrl(userId);
  // Ensure the pod's /profile/ container exists first (idempotent) — same
  // dance putPodAuthMethods does for the user container itself.
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
  try {
    await fetch(`${CSS_URL}${userId}/profile/`, {
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
    headers: { 'Content-Type': 'text/turtle' },
    body: buildPodProfileCard(identity),
  });
  if (!r.ok && r.status !== 205) {
    throw new Error(`PUT ${url} failed: ${r.status} ${r.statusText}`);
  }
}

// ── /<userId>/agents registry ───────────────────────────────
//
// The canonical owner-profile / agent-registry document the
// substrate's verifyDelegation and resolveRecipients flows GET
// from `<pod>/agents`. Mirrored from the in-memory identities map
// so a brand-new user has a populated /agents at first-touch
// registration — no more lazy-init solely via the relay's
// publish_context auto-registration.
//
// Eager init matters because cross-pod share_with resolution reads
// /agents to discover recipient X25519 keys; without this file the
// share fails silently for any user who has never published.
//
// Idempotent: each call rewrites the file from the current map
// (so a per-surface mint via ensureSurfaceAgent triggers a fresh
// write that includes every active agent for the user).
//
// Mirrors the iep:AuthorizedAgent shape used by
// @interego/core's ownerProfileToTurtle so downstream parsers
// (readAgentRegistry / parseOwnerProfile) stay compatible.
function podAgentRegistryUrl(userId: string): string {
  return `${CSS_URL}${userId}/agents`;
}

function buildPodAgentRegistry(identity: Identity): string {
  const cardUrl = podProfileCardUrl(identity.id);
  const ownerWebId = `${cardUrl}#me`;
  const host = new URL(BASE_URL).host;
  const agents = [...identities.values()].filter(i => i.type === 'agent' && i.owner === identity.id);
  const now = new Date().toISOString();

  const lines: string[] = [];
  lines.push('@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .');
  lines.push('@prefix foaf: <http://xmlns.com/foaf/0.1/> .');
  lines.push('@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .');
  lines.push('@prefix prov: <http://www.w3.org/ns/prov#> .');
  lines.push('');
  lines.push(`<${ownerWebId}> a foaf:Person ;`);
  lines.push(`    foaf:name "${identity.name}" ;`);

  if (agents.length === 0) {
    // Close the subject with no agent links.
    const last = lines.length - 1;
    lines[last] = lines[last]!.replace(/ ;$/, ' .');
    lines.push('');
    return lines.join('\n');
  }

  // Canonical Turtle predicate-object list: a single
  // `iep:authorizedAgent` predicate followed by comma-separated objects,
  // closed with `.` since this is the last predicate on the subject.
  // Mirrors ownerProfileToTurtle so strict parsers round-trip identically.
  lines.push('    iep:authorizedAgent');
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!;
    const sep = i < agents.length - 1 ? ',' : ' .';
    const frag = `#agent-${encodeURIComponent(a.id)}`;
    lines.push(`        <${frag}>${sep}`);
  }
  lines.push('');

  for (const a of agents) {
    const frag = `#agent-${encodeURIComponent(a.id)}`;
    const agentDid = `did:web:${host}:agents:${a.id}`;
    lines.push(`<${frag}> a iep:AuthorizedAgent, prov:SoftwareAgent ;`);
    lines.push(`    iep:agentIdentity <${agentDid}> ;`);
    lines.push(`    iep:delegatedBy <${ownerWebId}> ;`);
    lines.push(`    iep:scope iep:${a.scope ?? 'ReadWrite'} ;`);
    lines.push(`    iep:validFrom "${a.createdAt}"^^xsd:dateTime ;`);
    lines.push(`    iep:registeredAt "${now}"^^xsd:dateTime ;`);
    lines.push(`    foaf:name "${a.name}" .`);
    lines.push('');
  }

  return lines.join('\n');
}

async function putPodAgentRegistry(userId: string): Promise<void> {
  const identity = identities.get(userId);
  if (!identity || identity.type !== 'user') {
    // Same fire-and-forget guard as putPodAuthMethods / putPodProfileCard.
    return;
  }
  const url = podAgentRegistryUrl(userId);
  // Ensure the pod container exists (idempotent) — same dance as the
  // sibling pod writers. The /agents document lives directly under the
  // user pod root, so no nested container creation is needed.
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
    headers: { 'Content-Type': 'text/turtle' },
    body: buildPodAgentRegistry(identity),
  });
  if (!r.ok && r.status !== 205) {
    throw new Error(`PUT ${url} failed: ${r.status} ${r.statusText}`);
  }
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
  // FIX A: if a deferred pod write is in flight for this user, the
  // in-memory cache value is authoritative — a refresh fetch could
  // race the pending PUT (404→createIfMissing would clobber the
  // in-flight write). Hold the cached value until the deferred write
  // releases the mutex; serialise any forced refresh behind it.
  if (cached && identityPendingPodWrites.has(userId)) {
    return cached.value;
  }
  if (cached && allowStale) {
    // Refresh in background, serialised behind any pending write on
    // this userId so the refresh fetch never races the in-flight PUT.
    void withIdentityPodMutex(userId, () => fetchPodAuthMethods(userId)).then(fresh => {
      authMethodsCache.set(userId, { value: fresh, fetchedAt: Date.now() });
      rebuildIndexesForUser(userId, fresh);
    }).catch(() => {});
    return cached.value;
  }
  const fresh = await withIdentityPodMutex(userId, () => fetchPodAuthMethods(userId));
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
  // Hydration runs at boot when the in-memory identities map is empty and
  // we're recovering shells from pods. If the pod's auth-methods.jsonld
  // explicitly names an agent, honour it. Otherwise seed the surface-neutral
  // placeholder `mcp-client-<userId>` — the relay's ensureSurfaceAgent() will
  // mint the real per-surface agent (chatgpt-<userId>, claude-code-vscode-<userId>,
  // claude-mobile-<userId>, etc.) on top when an actual client connects.
  // Never default to a Claude-specific slug here: not every user came in via
  // a Claude surface, and a stale `claude-mobile-<userId>` would mis-label
  // descriptors written by the placeholder agent before the surface agent appears.
  const agentId = m.agentId ?? `mcp-client-${m.userId}`;
  if (!identities.has(agentId)) {
    seedIdentity(agentId, 'agent', `MCP client (${m.name})`, m.userId, 'ReadWrite');
  }
}

/**
 * Compute the default agent ID + display label for a first-touch registration.
 *
 * If the caller supplied a `surfaceAgent` hint (forwarded by the relay's
 * /oauth/verify handler — see deploy/mcp-relay/server.ts:bodyWithSurface),
 * mint `<surface>-<userId>` directly so the very first agent on the pod is
 * the real per-surface one (chatgpt-<userId>, claude-code-vscode-<userId>,
 * cursor-<userId>, etc.) and no claude-* placeholder gets written first.
 *
 * If no hint is given, fall back to the surface-neutral generic that /try
 * already uses (`mcp-client-<userId>` / 'MCP client (<name>)'). The relay's
 * ensureSurfaceAgent() will still mint the real per-surface agent on top
 * once an actual client connects.
 *
 * Critical invariant: NEVER hardcode `claude-mobile-` or any other Claude
 * surface as the default. Users who register via the ChatGPT, Cursor, or
 * any other connector must not be silently stamped with a Claude-flavored
 * agent on their pod.
 */
function defaultAgentForRegistration(
  userId: string,
  displayName: string,
  surfaceAgent: string | undefined,
): { agentId: string; label: string } {
  if (surfaceAgent) {
    const label = surfaceAgent
      .split('-')
      .map(p => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
    return {
      agentId: `${surfaceAgent}-${userId}`,
      label: `${label} (${displayName})`,
    };
  }
  return {
    agentId: `mcp-client-${userId}`,
    label: `MCP client (${displayName})`,
  };
}

// Bounded concurrency runner — preserves Promise.all semantics (resolves
// once every item has been processed) while capping in-flight work so a
// cold-start scan over hundreds of pods doesn't exhaust file descriptors
// or rate-limit CSS.
async function runWithConcurrency<T>(limit: number, items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers: Promise<void>[] = [];
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!);
    }
  };
  for (let k = 0; k < Math.min(limit, items.length); k++) workers.push(worker());
  await Promise.all(workers);
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
  let ok = 0, skipped = 0, fail = 0;
  await runWithConcurrency(16, allUserIds, async (uid) => {
    try {
      // Passive rebuild — read what's there, don't materialize empty
      // auth-methods files for pods that aren't users. A pod container
      // existing on CSS does not by itself make its name a user identity;
      // a credential file must already be present.
      const m = await fetchPodAuthMethods(uid, { createIfMissing: false });
      if (!m.walletAddresses.length && !m.webAuthnCredentials.length && !m.didKeys.length) {
        // No credentials registered yet — skip hydration. Either the pod
        // belongs to a service (svc-*, the relay's DCR store) or it's an
        // inert pim:Storage shell left over from a deletion.
        skipped++;
        return;
      }
      hydrateFromAuthMethods(m);
      authMethodsCache.set(uid, { value: m, fetchedAt: Date.now() });
      rebuildIndexesForUser(uid, m);
      ok++;
    } catch {
      fail++;
    }
  });
  log(`Index rebuild: ${ok} pod(s) OK, ${skipped} skipped (no credentials), ${fail} failed. users=${identities.size} wallets=${walletIndex.size} webauthn=${credentialIndex.size} dids=${didIndex.size}`);
}

/**
 * Promise-cached initial-rebuild handle.
 *
 * The original boot code called `rebuildAllIndexes().catch(...)` fire-
 * and-forget from inside app.listen(). The first /auth/did request
 * that landed before the Promise.all settled raced the index rebuild
 * and missed didIndex — forcing the slow first-time-registration
 * branch (and a ~2.5s putPodAuthMethods CSS round-trip) on a user
 * whose credentials WERE actually on file, just not loaded yet.
 *
 * Hoisting the Promise here lets handlers Promise.race it against a
 * small timeout (~50ms) before falling through — a returning user
 * whose index just hasn't loaded yet hits the warm path; a genuinely
 * new user is unaffected because the index has nothing to give them
 * either way.
 *
 * The /auth/did handler is the only one that races the rebuild today
 * (it's the cold-start outlier per profiling). SIWE and WebAuthn
 * handlers don't bother awaiting it because the cold-start cost there
 * is dominated by ethers / webauthn lazy-load, not the index race.
 */
let initialIndexReady: Promise<void> | null = null;
function startInitialIndexRebuild(): Promise<void> {
  return (initialIndexReady ??= rebuildAllIndexes().catch(err => {
    log(`WARN: initial index rebuild failed: ${(err as Error).message}`);
  }));
}

function awaitInitialIndexWithBudget(budgetMs: number): Promise<void> {
  // If the rebuild hasn't started yet (test harness skipping boot), the
  // race resolves immediately on the timeout — the handler falls through
  // to its normal lookup path. Production starts the promise in app.listen.
  const ready = initialIndexReady;
  if (!ready) return Promise.resolve();
  return Promise.race([
    ready,
    new Promise<void>(resolve => setTimeout(resolve, budgetMs)),
  ]);
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

// No in-code seeded users/agents. The server starts with an empty
// identity set — everyone is a first-class new registrant whose userId
// is derived from their first credential (u-pk-… / u-eth-… / u-did-…).
// The previous hardcoded `markj` + default agents were removed for a
// true clean-slate deployment; if a legacy seeded user needs to come
// back, re-add the seed lines and configure BOOTSTRAP_INVITES so the
// one-time binding path is available.

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
  // For WebAuthn flows: the transient session-user handle emitted in
  // the registration options (so the `/register` step can match the
  // ceremony back to this challenge). NOT the final userId.
  userId?: string;
  // WebAuthn register — mode (C): existing authenticated user adding
  // another device. Set when Authorization: Bearer <token> was valid.
  addDeviceUserId?: string;
  // WebAuthn register — mode (B): seeded legacy user being claimed
  // via an out-of-band BOOTSTRAP_INVITES token.
  bootstrapUserId?: string;
  bootstrapInvite?: string;
  // Display name captured at options-time so /register doesn't have to
  // re-accept (and potentially be coerced to echo) a different one.
  displayName?: string;
  // WebAuthn rpID / origin chosen for THIS ceremony, resolved from the
  // request Origin at options/challenge time. /register and
  // /authenticate verify against these — not the static RP_ID — so a
  // ceremony run on the identity server's own domain and one run on the
  // relay's domain both verify against the origin they actually used.
  rpId?: string;
  rpOrigin?: string;
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

const RP_ID = process.env['WEBAUTHN_RP_ID'] ?? BASE_URL_HOSTNAME;
const RP_NAME = process.env['WEBAUTHN_RP_NAME'] ?? 'Interego';
const RP_ORIGIN = process.env['WEBAUTHN_RP_ORIGIN'] ?? BASE_URL;

// A WebAuthn ceremony's rpID MUST match the origin the browser ran it
// on. This server is reachable on more than one origin — its own FQDN
// (the /connect enrollment page) AND the relay's FQDN (the relay's
// OAuth /authorize page POSTs its ceremonies here). A single static
// RP_ID can only satisfy one of those. So we resolve the relying party
// per-request from the browser-sent Origin header, validated against
// an allowlist.
//
// WEBAUTHN_RP_ORIGINS: comma-separated origins where ceremonies may
// legitimately run. Defaults to RP_ORIGIN + BASE_URL. Each entry's
// hostname becomes the rpID for ceremonies originating there. An Origin
// not on the list falls back to the static RP_ID / RP_ORIGIN — so
// existing single-origin deployments keep working unchanged.
const RP_ALLOWLIST: ReadonlyMap<string, { rpId: string; origin: string }> = (() => {
  const raw = process.env['WEBAUTHN_RP_ORIGINS'] ?? `${RP_ORIGIN},${BASE_URL}`;
  const m = new Map<string, { rpId: string; origin: string }>();
  for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    try {
      const u = new URL(entry);
      m.set(u.origin, { rpId: u.hostname, origin: u.origin });
    } catch { /* skip malformed allowlist entries */ }
  }
  return m;
})();

/**
 * Resolve the WebAuthn relying party for this request. Uses the
 * browser-sent Origin header when it is on the allowlist; otherwise
 * falls back to the static RP_ID / RP_ORIGIN. The browser independently
 * enforces rpID↔origin during the ceremony; the allowlist is the
 * server-side guard against honoring an attacker-chosen Origin.
 */
// Throttle fallback warnings: log each off-allowlist Origin at most once so
// a misconfigured deployment shows up clearly in logs without spamming
// every request.
const _loggedOffAllowlistOrigins = new Set<string>();

function resolveRp(req: { headers: { origin?: string } }): { rpId: string; origin: string } {
  const origin = req.headers.origin;
  if (origin) {
    const hit = RP_ALLOWLIST.get(origin);
    if (hit) return hit;
    // Operator misconfig early-warning: a browser is presenting an Origin
    // that isn't on WEBAUTHN_RP_ORIGINS, so we fall back to RP_ID/RP_ORIGIN.
    // The browser will subsequently refuse the ceremony if the resolved
    // rpID isn't a registrable suffix of its Origin — that's the exact
    // failure mode that triggered the 2026-05 origin-aware fix. Logging
    // here lets the operator notice BEFORE users hit the error.
    if (!_loggedOffAllowlistOrigins.has(origin)) {
      _loggedOffAllowlistOrigins.add(origin);
      log(`WARN: WebAuthn Origin "${origin}" is not on WEBAUTHN_RP_ORIGINS — falling back to RP_ID=${RP_ID}. If this is your identity server's own origin, add it to the allowlist.`);
    }
  }
  return { rpId: RP_ID, origin: RP_ORIGIN };
}

// ── Token Management ────────────────────────────────────────

// ── Stateless signed tokens (HMAC) ──────────────────────────
//
// The identity server is stateless wrt user-owned credential data (the
// CLAUDE.md invariant: pods are the source of truth). Tokens were the
// last bit of state on the server — held in an in-memory Map that was
// wiped on every pod restart, logging every user out on every deploy.
//
// Replaced with HMAC-signed tokens carrying their own payload:
//   cg2_<base64url(payload-json)>.<base64url(hmac-sha256(payload-b64))>
//
// Payload includes a `sessionEpoch` snapshot at issuance time. Revocation
// (sign-out-everywhere) increments the pod's stored sessionEpoch; verify
// rejects any token whose embedded epoch is below the pod's current
// value. Per-user revocation, no global state, and the server can be
// restarted / scaled / replaced without losing sessions — as long as
// `TOKEN_SIGNING_KEY` is stable.
//
// `TOKEN_SIGNING_KEY` env var (base64-encoded 32+ bytes) is the
// stable secret. When unset, a fresh ephemeral key is generated with a
// loud warning — that case behaves like the legacy in-memory Map: every
// restart logs everyone out. The deploy workflow sets the env var once
// on first deploy and never overwrites it, so subsequent deploys
// preserve sessions.
const TOKEN_SIGNING_KEY: Buffer = (() => {
  const envKey = process.env['TOKEN_SIGNING_KEY'];
  if (envKey && envKey.length > 0) {
    try {
      const buf = Buffer.from(envKey, 'base64');
      if (buf.length >= 32) {
        log(`Token signing key: loaded from TOKEN_SIGNING_KEY env (${buf.length} bytes) — tokens survive restart.`);
        return buf;
      }
      log(`WARN: TOKEN_SIGNING_KEY env is set but decodes to ${buf.length} bytes (need >= 32) — falling back to ephemeral. All users will be signed out on every restart.`);
    } catch (e) {
      log(`WARN: TOKEN_SIGNING_KEY env is set but not valid base64 (${(e as Error).message}) — falling back to ephemeral.`);
    }
  } else {
    log(`WARN: TOKEN_SIGNING_KEY env is unset — using an ephemeral signing key. All users will be signed out on every restart. Set TOKEN_SIGNING_KEY (base64-encoded 32 bytes) to persist sessions across deploys.`);
  }
  return crypto.randomBytes(32);
})();

interface SignedTokenPayload {
  userId: string;
  agentId: string;
  scope: string;
  issuedAt: string;
  expiresAt: string;
  /** Pod-stored sessionEpoch at issuance time. Below pod's current value → revoked. */
  epoch: number;
}

function signPayload(payload: SignedTokenPayload): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SIGNING_KEY).update(b64).digest('base64url');
  return `cg2_${b64}.${sig}`;
}

function parseAndVerifySignature(token: string): { valid: true; payload: SignedTokenPayload } | { valid: false; reason: string } {
  if (!token.startsWith('cg2_')) return { valid: false, reason: 'Token not found' };
  const stripped = token.slice(4);
  const dot = stripped.lastIndexOf('.');
  if (dot < 0) return { valid: false, reason: 'Token malformed' };
  const b64 = stripped.slice(0, dot);
  const sigPart = stripped.slice(dot + 1);
  const expectedSig = crypto.createHmac('sha256', TOKEN_SIGNING_KEY).update(b64).digest();
  const sigBuf = Buffer.from(sigPart, 'base64url');
  if (sigBuf.length !== expectedSig.length || !crypto.timingSafeEqual(sigBuf, expectedSig)) {
    return { valid: false, reason: 'Invalid bearer token: signature mismatch' };
  }
  let payload: SignedTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'Token payload malformed' };
  }
  if (!payload.userId || !payload.expiresAt) return { valid: false, reason: 'Token payload incomplete' };
  return { valid: true, payload };
}

async function issueToken(userId: string, agentId: string, scope: string): Promise<TokenRecord> {
  const now = new Date();
  // Pod is the source of truth for the user's current sessionEpoch.
  // Stale-while-revalidate cache is fine here — issuing under a
  // slightly-stale epoch still works (the verify check uses the same
  // cache), and a sign-out-everywhere invalidates the cache so the next
  // issue picks up the bumped value.
  let epoch = 0;
  try {
    const methods = await readAuthMethods(userId, /* allowStale */ true);
    epoch = methods.sessionEpoch ?? 0;
  } catch {
    // Fresh user, no pod yet — epoch 0 is correct.
  }
  const payload: SignedTokenPayload = {
    userId,
    agentId,
    scope,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000).toISOString(),
    epoch,
  };
  const token = signPayload(payload);
  const record: TokenRecord = {
    token,
    userId,
    agentId,
    scope,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
  log(`Issued token for ${agentId} (user: ${userId}, scope: ${scope}, epoch: ${epoch}, expires: ${record.expiresAt})`);
  return record;
}

async function verifyToken(token: string): Promise<{ valid: boolean; record?: TokenRecord; reason?: string }> {
  const parsed = parseAndVerifySignature(token);
  if (parsed.valid !== true) {
    return { valid: false, reason: (parsed as { valid: false; reason: string }).reason };
  }
  const payload = parsed.payload;
  if (new Date(payload.expiresAt) < new Date()) {
    return { valid: false, reason: 'Token expired' };
  }
  // Deleted-user check: identities is rebuilt from pod scans at startup
  // AND mutated synchronously by deleteUserCompletely. A token whose
  // userId no longer maps to a real identity (deleted user, or some
  // malformed token that survived signature check) MUST fail. This is
  // also the hard-fail path that closes the gap left by the
  // partition-tolerant pod-read below.
  if (!identities.has(payload.userId)) {
    return { valid: false, reason: 'User for token not found' };
  }
  // Revocation check: token's embedded epoch must be ≥ pod's current
  // sessionEpoch. A sign-out-everywhere bumps the pod's value, making
  // every prior token verify-fail until the user authenticates again.
  try {
    const methods = await readAuthMethods(payload.userId, /* allowStale */ true);
    const podEpoch = methods.sessionEpoch ?? 0;
    if (payload.epoch < podEpoch) {
      return { valid: false, reason: 'Token revoked (signed out everywhere)' };
    }
  } catch {
    // If we can't read the pod, fall through: signature + expiry +
    // identities-map already bound the trust. A transient pod outage
    // is a partition, not a security event.
  }
  const record: TokenRecord = {
    token,
    userId: payload.userId,
    agentId: payload.agentId,
    scope: payload.scope,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
  return { valid: true, record };
}

// ── DID Document Builder ────────────────────────────────────

/**
 * Build a W3C-conformant did:web document for either a user or an agent.
 *
 * Agents get BOTH an Ed25519 verification method (for #authentication +
 * #assertionMethod) AND an X25519 verification method (for #keyAgreement).
 * The X25519 key lets remote pods resolving a bare
 * `did:web:<host>:agents:<id>` pull the agent's envelope-recipient key
 * straight from the DID doc — no owner-pod agent-registry round-trip
 * required (FIX 6). The owner-pod registry remains the canonical source
 * for revocation + rollover metadata; this is just a fast path so a
 * `share_with: ['did:web:…:agents:…']` call resolves even when the
 * resolver only knows the agent's DID.
 *
 * Users keep the same shape plus a `ContextGraphsManifest` service entry
 * and an `alsoKnownAs` pointer to the canonical WebID profile.
 *
 * Service entries:
 *   - SolidStorage      → the controlling user's pod (the agent acts on
 *                         behalf of its owner, so its pod IS the owner's
 *                         pod)
 *   - InteregoRelay     → agents only — points at the relay surface
 *                         clients use to reach this agent. Lets a remote
 *                         resolver route delegated operations without
 *                         hard-coding the relay URL.
 *   - ContextGraphsManifest → users only — the published manifest the
 *                             owner pod exposes.
 */
function buildDidDocument(identity: Identity): object {
  const kp = keys.get(identity.id)!;
  const host = new URL(BASE_URL).host;
  const path = identity.type === 'user' ? `users:${identity.id}` : `agents:${identity.id}`;
  const did = `did:web:${host}:${path}`;
  const ed25519KeyId = `${did}#ed25519-1`;
  const x25519KeyId = `${did}#x25519-1`;
  const owner = identity.owner ?? identity.id;

  // For agents, the controller is the owning user's did:web — this is
  // how a remote resolver discovers who delegated this agent. For users,
  // they control themselves.
  const controller = identity.type === 'agent'
    ? `did:web:${host}:users:${owner}`
    : did;

  const podUrl = `${CSS_URL}${owner}/`;

  // Per W3C DID Core 1.0 + Security Vocab 2020:
  //  - https://www.w3.org/ns/did/v1                       — core terms
  //  - https://w3id.org/security/suites/ed25519-2020/v1   — Ed25519VerificationKey2020
  //  - https://w3id.org/security/suites/x25519-2020/v1    — X25519KeyAgreementKey2020
  const doc: Record<string, unknown> = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      'https://w3id.org/security/suites/x25519-2020/v1',
    ],
    id: did,
    controller,
    verificationMethod: [
      {
        id: x25519KeyId,
        type: 'X25519KeyAgreementKey2020',
        controller: did,
        publicKeyMultibase: kp.x25519PublicKeyMultibase,
      },
      {
        id: ed25519KeyId,
        type: 'Ed25519VerificationKey2020',
        controller: did,
        publicKeyMultibase: kp.publicKeyMultibase,
      },
    ],
    authentication: [ed25519KeyId],
    assertionMethod: [ed25519KeyId],
    keyAgreement: [x25519KeyId],
  };

  if (identity.type === 'agent') {
    doc['service'] = [
      {
        id: `${did}#pod`,
        type: 'SolidStorage',
        serviceEndpoint: podUrl,
      },
      {
        id: `${did}#relay`,
        type: 'InteregoRelay',
        serviceEndpoint: RELAY_URL,
      },
      // Pointer to the owner's agent-registry resource so a resolver can
      // still fetch revocation / rollover metadata when needed (the DID
      // doc only carries the current key; the registry has the history
      // window used by sharing.ts's rollover logic).
      {
        id: `${did}#registry`,
        type: 'ContextGraphsAgentRegistry',
        serviceEndpoint: `${podUrl}agents`,
      },
    ];
  } else {
    doc['service'] = [
      { id: `${did}#pod`, type: 'SolidStorage', serviceEndpoint: podUrl },
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
    `@prefix iep: <${ONTOLOGY_URL}> .`,
    `@prefix prov: <http://www.w3.org/ns/prov#> .`,
    `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
    ``,
    `<${profileUrl}#me>`,
    `    a foaf:Person ;`,
    `    foaf:name "${identity.name}" ;`,
    `    solid:oidcIssuer <${BASE_URL}> ;`,
    `    solid:storage <${podUrl}> ;`,
    ...(agents.length > 0 ? [
      `    iep:authorizedAgent`,
      ...agents.map((a, i) => {
        const sep = i < agents.length - 1 ? ',' : ';';
        return `        <${BASE_URL}/agents/${a.id}/profile#agent>${sep}`;
      }),
    ] : []),
    `    rdfs:seeAlso <did:web:${new URL(BASE_URL).host}:users:${identity.id}> .`,
    ``,
    ...agents.map(a => [
      `<${BASE_URL}/agents/${a.id}/profile#agent>`,
      `    a iep:AuthorizedAgent, prov:SoftwareAgent ;`,
      `    rdfs:label "${a.name}" ;`,
      `    iep:agentIdentity <did:web:${new URL(BASE_URL).host}:agents:${a.id}> ;`,
      `    iep:delegatedBy <${profileUrl}#me> ;`,
      `    iep:scope "${a.scope ?? 'ReadWrite'}" .`,
      ``,
    ].join('\n')),
  ].join('\n');
}

// ── Express App ─────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// CORS: explicit allowlist, never wildcard. See cors-allowlist.ts for the
// full rationale (the same fix is applied in deploy/mcp-relay/server.ts).
// Unknown origins receive THIS service's own FQDN as ACAO so a browser
// caller cannot read the response cross-origin, and we NEVER emit
// Access-Control-Allow-Credentials: true.
app.use(corsMiddleware({
  ownOrigin: BASE_URL,
  allowMethods: 'GET, POST, OPTIONS',
  allowHeaders: 'Accept, Content-Type, Authorization',
}));

// ── Per-IP rate limiting (auth endpoints) ──────────────────────────
//
// Sliding-window counters per IP × endpoint family. Without these, an
// attacker can pound /auth/webauthn/register-options or /challenges
// faster than legitimate users could ever do, exhausting the in-memory
// challenge map (~5 min TTL × N entries) until the server OOMs.
//
// Limits are calibrated for legitimate usage:
//   - WebAuthn / SIWE / DID enrollment: a few per minute per device
//     (human-driven, not bot-driven). 30/min is generous.
//   - Challenge nonces: minted as part of every auth ceremony. 60/min
//     accommodates retries + multiple methods.
//   - Token issue / verify: per-session, low volume.
//
// In-memory implementation is fine for a single-container Azure
// Container Apps deployment. For multi-instance deployments, replace
// with a Redis-backed counter so limits are shared across replicas.

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitBuckets = new Map<string, Map<string, RateLimitEntry>>();

function rateLimit(bucketName: string, opts: { windowMs: number; max: number }) {
  if (!rateLimitBuckets.has(bucketName)) rateLimitBuckets.set(bucketName, new Map());
  const bucket = rateLimitBuckets.get(bucketName)!;
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    // req.ip honors trust-proxy when set; for Container Apps deployments
    // the platform terminates TLS at the ingress and the real client IP
    // is in X-Forwarded-For. Trust the first hop only (set above in
    // app.set('trust proxy', 1) when configured at deploy time).
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let entry = bucket.get(ip);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      bucket.set(ip, entry);
    }
    entry.count++;
    if (entry.count > opts.max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: 'rate_limit_exceeded',
        title: 'Too many requests',
        detail: `${opts.max} requests in a ${opts.windowMs / 1000}s window for ${bucketName} on this IP. Retry in ${retryAfterSec}s.`,
        retryAfterSeconds: retryAfterSec,
      });
      return;
    }
    next();
  };
}

// Periodic cleanup of expired entries so a long-lived process doesn't
// accumulate entries from one-off attackers. Runs every 5 minutes;
// `unref` keeps Node from holding the event loop open for it.
setInterval(() => {
  const now = Date.now();
  for (const bucket of rateLimitBuckets.values()) {
    for (const [ip, entry] of bucket) {
      if (entry.resetAt < now) bucket.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

const authEnrollLimiter = rateLimit('auth-enroll', { windowMs: 60_000, max: 30 });
const challengeLimiter = rateLimit('challenges', { windowMs: 60_000, max: 60 });
const tokenLimiter = rateLimit('tokens', { windowMs: 60_000, max: 60 });
// /siwe/verify runs ECDSA recovery on every call — tighter cap than the
// general auth-enroll limiter to keep unauthenticated CPU exhaustion off
// the table.
const siweVerifyLimiter = rateLimit('siwe-verify', { windowMs: 60_000, max: 10 });
const webfingerLimiter = rateLimit('webfinger', { windowMs: 60_000, max: 120 });

// ── Browser-friendly landing page ─────────────────────────────────
//
// The identity server is an API surface; everything authoritative is
// JSON. But a non-technical user who lands at the root URL (e.g.
// because an inviter shared it as "go here to set up") deserves a
// friendly explanation, not a 404. This serves a minimal page that:
//   - explains what they're looking at
//   - shows the OAuth-led onboarding flow (their MCP client will
//     trigger /authorize on the relay; that page does the method
//     picker; this URL is server-to-server otherwise)
//   - lists their developer-side endpoints for transparency
//
// Inline HTML keeps the deployment artifact-free; no build step.

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Try Interego — verifiable, federated memory for AI agents</title>
<style>
  :root { --ink:#1c1f23; --mut:#5a6470; --line:#e3e7eb; --bg:#fbfbfd; --accent:#0a66c2; --accent2:#6366f1; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 860px; margin: 0 auto; padding: 3.5em 1.5em 5em; line-height: 1.6; color: var(--ink); background: var(--bg); }
  h1 { font-weight: 800; letter-spacing: -0.025em; font-size: 2.1rem; margin: 0 0 0.15em; }
  .tag { color: var(--mut); font-size: 1.12rem; margin: 0 0 1.6em; }
  h2 { margin: 2.6em 0 0.6em; font-size: 1.18rem; }
  p { margin: 0.6em 0; }
  code { background: #f0f2f5; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
  pre { background: #11151a; color: #e6edf3; padding: 0.9em 1.1em; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; line-height: 1.5; }
  a { color: var(--accent); }
  .tracks { display: grid; grid-template-columns: 1fr 1fr; gap: 1.1em; margin: 1.4em 0; }
  @media (max-width: 620px) { .tracks { grid-template-columns: 1fr; } }
  .track { border: 1px solid var(--line); border-radius: 12px; padding: 1.3em 1.4em; background: #fff; }
  .track h3 { margin: 0 0 0.2em; font-size: 1.05rem; }
  .track .who { color: var(--mut); font-size: 0.9rem; margin: 0 0 1em; }
  .btn { display: inline-block; background: var(--accent2); color: #fff; text-decoration: none; padding: 0.62em 1.2em; border-radius: 8px; font-weight: 600; font-size: 0.95rem; margin-top: 0.4em; }
  .btn:hover { background: #818cf8; }
  .btn.ghost { background: #eef0f4; color: var(--ink); }
  .btn.ghost:hover { background: #e3e6ec; }
  .what { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1em; margin: 1.2em 0; }
  @media (max-width: 620px) { .what { grid-template-columns: 1fr; } }
  .what div { border-left: 3px solid var(--accent2); padding-left: 0.9em; }
  .what strong { display: block; }
  .what span { color: var(--mut); font-size: 0.9rem; }
  ul { padding-left: 1.2em; } li { margin-bottom: 0.3em; }
  .muted { color: var(--mut); font-size: 0.92rem; }
  footer { margin-top: 4em; padding-top: 1.2em; border-top: 1px solid var(--line); color: #8a929c; font-size: 0.87em; }
</style>
</head>
<body>
<h1>Persistent memory for AI agents</h1>
<p class="tag">Owned by you, portable across runtimes, signed by construction. Drop the relay into any MCP-speaking agent.</p>
<p class="muted" style="margin-top:-0.8em;margin-bottom:1.6em;font-size:0.88rem">Reference implementation, hosted on the maintainer's free Azure instance. Fine for evaluation; self-host before you depend on it.</p>

<h2 style="margin-top:1.2em">60-second setup</h2>
<p>Click the button to mint an anonymous, ephemeral pod + bearer token (no signup, reaped after 7 days). Paste the personalized config into your MCP client and the agent has working pod-rooted memory immediately. Want to keep it? Enroll a passkey or wallet at <code>/connect</code> using the same token as <code>addDeviceToken</code> and the pod becomes permanently yours.</p>
<button id="tryBtn" class="btn" type="button" style="margin:0.4em 0 0.8em">Try it now — no signup &rarr;</button>
<span id="tryStatus" class="muted" style="margin-left:0.6em;font-size:0.88rem"></span>
<div id="trySnippetWrap" style="display:none;margin-top:0.6em">
  <p style="margin-bottom:0.3em" class="muted">Paste into <code>~/.claude.json</code>, <code>.cursor/mcp.json</code>, or the Codex equivalent:</p>
  <pre id="trySnippet" style="position:relative"></pre>
  <button id="tryCopyBtn" class="btn ghost" type="button" style="margin-top:0.4em">Copy</button>
  <p id="tryTtl" class="muted" style="margin-top:0.4em;font-size:0.86rem"></p>
</div>
<details style="margin:0.6em 0 1em">
  <summary class="muted" style="cursor:pointer">Or do it manually (enroll first, paste your own token)</summary>
  <p style="margin-top:0.6em">Enroll at <a href="/connect">/connect</a> with a passkey or wallet, then add this to your MCP client config and substitute your bearer token:</p>
<pre>{
  "mcpServers": {
    "interego": {
      "url": "${RELAY_URL}/sse",
      "headers": { "Authorization": "Bearer YOUR_TOKEN_HERE" }
    }
  }
}</pre>
</details>
<script>
(function(){
  var btn = document.getElementById('tryBtn');
  var status = document.getElementById('tryStatus');
  var wrap = document.getElementById('trySnippetWrap');
  var pre = document.getElementById('trySnippet');
  var ttl = document.getElementById('tryTtl');
  var copy = document.getElementById('tryCopyBtn');
  if (!btn) return;
  btn.addEventListener('click', function(){
    btn.disabled = true;
    status.textContent = 'Provisioning…';
    fetch('/try', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(j){
        pre.textContent = j.mcpConfigSnippet;
        wrap.style.display = 'block';
        ttl.textContent = j.ttlNote || '';
        status.textContent = 'Ready — userId ' + j.userId;
        btn.textContent = 'Generate another →';
        btn.disabled = false;
      })
      .catch(function(e){
        status.textContent = 'Failed: ' + e.message;
        btn.disabled = false;
      });
  });
  copy.addEventListener('click', function(){
    navigator.clipboard.writeText(pre.textContent || '').then(function(){
      copy.textContent = 'Copied'; setTimeout(function(){ copy.textContent = 'Copy'; }, 1500);
    });
  });
})();
</script>

<h2>What this unlocks (one concrete shape)</h2>
<p>An agent debugs an issue and stores the findings on your pod. Tomorrow — different session, different machine, possibly a different agent — the next call discovers the same findings and avoids redoing the work. Hand the link to a teammate's agent and theirs can verify the trail back to the signer.</p>
<div class="what">
  <div><strong>Persistent</strong><span>Memory survives session, device, and runtime changes. The pod is the source of truth.</span></div>
  <div><strong>Verifiable</strong><span>Every record is cryptographically signed — who wrote it, when, on whose behalf. Auditable end-to-end.</span></div>
  <div><strong>Federated</strong><span>Agents share context across pods on demand — no central server, no membership list.</span></div>
</div>

<h2>Already enrolled, or just want to look around?</h2>
<div class="tracks">
  <div class="track">
    <h3>Open your dashboard</h3>
    <p class="who">See your DID, pod URL, registered credentials, and the descriptors your agents have published.</p>
    <a class="btn" href="/dashboard">Dashboard &rarr;</a>
    <a class="btn ghost" href="/connect">Enroll a credential</a>
  </div>
  <div class="track">
    <h3>Tighter integrations</h3>
    <p class="who">The MCP path above works with everything. These runtimes also have a native memory-slot plugin if you want it tighter.</p>
    <ul style="margin:0.4em 0 0 -0.5em">
      <li><a href="${REPO_URL}/tree/master/integrations/hermes-memory">Hermes</a> — <code>hermes memory setup</code>, pick <code>interego</code>.</li>
      <li><a href="${REPO_URL}/tree/master/integrations/openclaw-memory">OpenClaw</a> — <code>@interego/openclaw-memory</code> plugin claims the memory slot.</li>
      <li><a href="${REPO_URL}/tree/master/integrations/compliance-overlay">Compliance overlay</a> — wraps any agent action into a signed, framework-cited evidence record.</li>
    </ul>
  </div>
</div>

<p class="muted">Run it on your own infra instead? Everything is open source — see <a href="${REPO_URL}/tree/master/examples/personal-bridge">examples/personal-bridge</a> for the local-first deployment (laptop / Pi / NAS). New here? The <a href="${REPO_URL}/blob/master/docs/FIRST-HOUR.md">first-hour walkthrough</a> takes you end to end.</p>

<footer>
Open source · <a href="${REPO_URL}">github.com/markjspivey-xwisee/interego</a> ·
<a href="/dashboard">dashboard</a> ·
<a href="/health">status</a> ·
<a href="/.well-known/did.json">did.json</a> ·
this deployment is the maintainer's free reference instance
</footer>
</body>
</html>`;

app.get(['/', '/try'], (_req, res) => {
  res.type('text/html').send(LANDING_HTML);
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    users: [...identities.values()].filter(i => i.type === 'user').length,
    agents: [...identities.values()].filter(i => i.type === 'agent').length,
    // Tokens are stateless (HMAC-signed) — there's no server-side count
    // to report. Caller can still trust signature + expiry + sessionEpoch.
    tokenSigningKeyOrigin: process.env['TOKEN_SIGNING_KEY'] ? 'env' : 'ephemeral',
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
 * POST /register — DEPRECATED.
 *
 * Previously let callers reserve an arbitrary userId before proving any
 * key-ownership. That let an attacker typing `markj` sit on the slot
 * long enough to beat the real user in a race, or (for post-seed
 * existing users) passkey-hijack via the WebAuthn register flow since
 * the identity shell was treated as "already present, just add creds".
 *
 * The correct paths are:
 *
 *   - Brand-new user: call /auth/webauthn/register-options → /register,
 *     or /auth/siwe, or /auth/did. userId is derived from the credential.
 *   - Seeded legacy userId (markj): supply { bootstrapUserId,
 *     bootstrapInvite } on the first auth call (one-time).
 *   - Add another device/wallet/did: authenticate first, then call the
 *     same endpoints with Authorization: Bearer <token>.
 *
 * This endpoint now always returns 410 Gone to force migration.
 */
app.post('/register', (_req, res) => {
  res.status(410).json({
    error: 'POST /register is deprecated and no longer accepts user-supplied userIds',
    reason: 'canonical identity is derived from the credential being enrolled, not from a claimed string',
    use: {
      'brand-new user (passkey)': 'POST /auth/webauthn/register-options then /auth/webauthn/register',
      'brand-new user (wallet)': 'POST /auth/siwe after /challenges with purpose=siwe',
      'brand-new user (did)': 'POST /auth/did after /challenges with purpose=did-sig',
      'claim legacy seeded userId': 'include { bootstrapUserId, bootstrapInvite } on first-auth call (one-time)',
      'add another device to existing account': 'authenticate first, then repeat any register path with Authorization: Bearer <token>',
    },
  });
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
app.post('/challenges', challengeLimiter, async (req, res) => {
  const { purpose, userId } = req.body as { purpose?: Challenge['purpose']; userId?: string };
  // Targeted webauthn-authenticate: when a userId is supplied we MUST
  // resolve it to a real account with at least one registered passkey
  // before minting a challenge. Otherwise the relay UI would build a
  // credentials.get() ceremony with allowCredentials: [] and silently
  // fall through to the usernameless picker — losing the whole point
  // of the targeted flow. We return a generic 404 for both "no such
  // user" and "user exists but has no passkeys" to avoid leaking
  // existence (the user is on a sign-in page anyway, but cheap
  // hygiene).
  if (purpose === 'webauthn-authenticate' && userId) {
    let methods: AuthMethods | undefined;
    if (identities.has(userId)) {
      try {
        methods = await readAuthMethods(userId, /* allowStale */ true);
      } catch { /* treat as not-found below */ }
    }
    if (!methods || methods.webAuthnCredentials.length === 0) {
      res.status(404).json({
        error: 'No passkey found for this userId',
        title: 'No passkey is registered for that identifier',
        detail: 'Either the userId does not exist, or the account exists but has no passkey credentials. We do not distinguish between the two on this endpoint to avoid enumeration.',
        hint: 'Double-check the userId (u-pk-… / u-did-… / u-eth-…) or use the discoverable passkey picker (leave the userId field blank and click Sign in).',
      });
      return;
    }
  }
  const ch = issueChallenge(purpose, userId);
  // Pin the relying party for WebAuthn-authenticate ceremonies to the
  // origin this challenge was requested from — so /authenticate later
  // verifies against the same origin the browser ran the ceremony on.
  // (issueChallenge returns the stored object reference; consumeChallenge
  // hands the same object back.)
  if (purpose === 'webauthn-authenticate') {
    const rp = resolveRp(req);
    ch.rpId = rp.rpId;
    ch.rpOrigin = rp.origin;
  }
  const resp: Record<string, unknown> = { nonce: ch.nonce, expiresAt: new Date(ch.expiresAt).toISOString() };
  if (purpose === 'webauthn-authenticate' && userId) {
    // Read credentials from the user's pod (stale-while-revalidate cache).
    // The pre-check above guarantees readAuthMethods has succeeded and at
    // least one credential exists, so this branch always emits a
    // non-empty allowCredentials[].
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
app.post('/auth/siwe', authEnrollLimiter, async (req, res) => {
  const requestStart = timingEnabled() ? startTiming() : 0;
  const {
    message, signature, nonce,
    name,
    bootstrapUserId, bootstrapInvite,
    surfaceAgent,
  } = req.body ?? {};
  if (!message || !signature || !nonce) {
    res.status(400).json({
      error: 'message, signature, and nonce are required',
      title: 'SIWE request is missing required fields',
      detail: 'Your wallet client must send message, signature, and nonce — all three are produced by a single signing ceremony.',
      hint: 'Call POST /challenges with purpose=siwe to obtain a fresh nonce, then sign the SIWE message with your wallet, then POST that to /auth/siwe.',
    });
    return;
  }
  const ch = consumeChallenge(nonce, 'siwe');
  if (!ch) {
    res.status(401).json({
      error: 'Invalid or expired challenge',
      title: 'Your sign-in challenge expired or was already used',
      detail: 'Challenges are single-use and valid for 5 minutes. This one is missing from the server\'s pool — likely because too much time passed between requesting it and signing.',
      hint: 'Request a fresh challenge via POST /challenges and complete the signing flow within 5 minutes.',
    });
    return;
  }
  if (!String(message).includes(nonce)) {
    res.status(400).json({
      error: 'SIWE message does not contain the issued nonce',
      title: 'Signed message is missing the challenge nonce',
      detail: 'Replay defense: the signed SIWE statement MUST embed the nonce we issued at /challenges. Without it, an attacker could replay an old signature.',
      hint: 'Your wallet client should construct the SIWE message with `Nonce:` set to the value returned by /challenges.',
    });
    return;
  }

  let recoveredAddress: string;
  try {
    const { ethers } = await loadEthers();
    recoveredAddress = (ethers.verifyMessage(message, signature)).toLowerCase();
  } catch (err) {
    res.status(401).json({
      error: `SIWE signature verification failed: ${(err as Error).message}`,
      title: 'Wallet signature did not verify',
      detail: 'The signature blob could not be parsed or didn\'t match the SIWE message. This usually means a transport encoding issue or the wallet signed a different message than what was sent.',
      hint: 'Ensure your wallet is unlocked, you signed the EXACT message text the server expects (including newlines), and the signature is a 0x-prefixed hex string.',
    });
    return;
  }

  const addressMatch = String(message).match(/0x[a-fA-F0-9]{40}/);
  const claimedAddress = addressMatch?.[0]?.toLowerCase();
  if (claimedAddress && claimedAddress !== recoveredAddress) {
    res.status(401).json({
      error: `Signature mismatch: message claims ${claimedAddress}, recovered ${recoveredAddress}`,
      title: 'Signature belongs to a different wallet than the message claims',
      detail: 'The SIWE statement says one address but the cryptographic recovery produced another. Either the message was tampered with or the wallet signed without checking which account is selected.',
      hint: 'Check which account is active in your wallet (MetaMask shows it in the toolbar) and re-sign with the address that matches the SIWE statement.',
    });
    return;
  }

  if (!walletIndex.has(recoveredAddress)) {
    await awaitInitialIndexWithBudget(50);
  }
  // Returning user via wallet index — no user-claim needed.
  let userId = walletIndex.get(recoveredAddress);
  let user = userId ? identities.get(userId) : undefined;

  // Authenticated add-wallet: if a valid bearer is presented, bind this
  // newly-signed wallet to the caller's user (not a new one).
  if (!user) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const tr = await verifyToken(authHeader.slice(7));
      if (tr.valid) {
        userId = tr.record!.userId;
        user = identities.get(userId);
      }
    }
  }

  if (!user) {
    // Choose the target userId using the same three-mode logic as WebAuthn.
    // Mode (C) add-device is handled upstream (bearer token already
    // populated `user`); resolveTargetUserId here covers (A) derive and
    // (B) bootstrap-claim, pinned by tests/resolve-target-userid.test.ts
    // — in particular the enumeration-safe ordering of the existing-
    // credential guard before the invite check.
    const existingForBootstrap = (bootstrapUserId && bootstrapInvite)
      ? await readAuthMethods(bootstrapUserId, /* allowStale */ true)
      : { walletAddresses: [], webAuthnCredentials: [], didKeys: [] };
    const resolved = resolveTargetUserId({
      bootstrapUserId,
      bootstrapInvite,
      recoveredAddress,
      existingAuthMethods: existingForBootstrap,
      deriveFromAddress: deriveUserIdFromWallet,
      deriveFromCredentialId: deriveUserIdFromCredentialId,
      verifyInvite: verifyBootstrapInvite,
    });
    if (resolved.ok === false) {
      const err = resolved as { status: 400 | 401; body: { error: string } };
      res.status(err.status).json(err.body);
      return;
    }
    const targetUserId = resolved.targetUserId;

    if (!identities.has(targetUserId)) {
      const displayName = String(name ?? targetUserId);
      seedIdentity(targetUserId, 'user', displayName);
      const def = defaultAgentForRegistration(targetUserId, displayName, surfaceAgent);
      seedIdentity(def.agentId, 'agent', def.label, targetUserId, 'ReadWrite');
    }
    user = identities.get(targetUserId)!;
    const agentId = [...identities.values()].find(i => i.type === 'agent' && i.owner === targetUserId)?.id
      ?? defaultAgentForRegistration(targetUserId, user.name, surfaceAgent).agentId;
    const methods = emptyAuthMethods(user.id, user.name, agentId);
    methods.walletAddresses.push(recoveredAddress);
    inlineApplyAuthMethods(user.id, methods);
    scheduleDeferredAuthMethodsWrite(user.id, methods, 'siwe-first-time');
    if (timingEnabled()) logTiming('siwe-pod-write-scheduled', requestStart, { branch: 'first-time' });
    // FIX A: identity-server no longer mirrors /profile/card or /<id>/agents.
    // The relay is now the single authoritative writer for both pod-side
    // documents and does so synchronously inside /oauth/verify before
    // returning the OAuth code — see deploy/mcp-relay/server.ts. Two
    // writers were previously racing each other on every OAuth completion,
    // causing CSS file-backend HTTP 500s on the second OAuth ("Read counter
    // would become negative" on /profile/card) and a ~10s 404 window for
    // any client polling those URLs immediately after auth.
    log(`First-time SIWE registration: ${targetUserId} wallet=${recoveredAddress} defaultAgent=${agentId} (surfaceHint=${surfaceAgent ?? 'none'})`);
  } else {
    // Add-wallet (authenticated) path — append if not already bound.
    const methods = await readAuthMethods(user.id);
    if (!methods.walletAddresses.includes(recoveredAddress)) {
      methods.walletAddresses.push(recoveredAddress);
      inlineApplyAuthMethods(user.id, methods);
      scheduleDeferredAuthMethodsWrite(user.id, methods, 'siwe-add-wallet');
      if (timingEnabled()) logTiming('siwe-pod-write-scheduled', requestStart, { branch: 'add-wallet' });
      log(`Wallet ${recoveredAddress} linked to existing user ${user.id}`);
    }
  }

  res.json(await issueTokenResponse(user, surfaceAgent));
});

// ── WebAuthn / Passkeys ─────────────────────────────────────

/**
 * POST /auth/webauthn/register-options — start passkey registration.
 *
 * Three modes — the server never trusts a user-supplied userId claim:
 *
 *   (A) Fresh registration (default):
 *       Body: { name }
 *       Server mints no user up-front. userId is derived from the
 *       credential at /auth/webauthn/register time as `u-pk-<hash>`.
 *
 *   (B) Bootstrap-claim a seeded legacy user (e.g. 'markj'):
 *       Body: { name, bootstrapUserId, bootstrapInvite }
 *       Requires a matching out-of-band invite configured via env
 *       BOOTSTRAP_INVITES. Single-use: after success, that userId can
 *       only gain credentials via the add-device flow below.
 *
 *   (C) Add another device to the caller's existing account:
 *       Header: Authorization: Bearer <token>  (for user X)
 *       Body: { name }
 *       Adds a new credential to user X. No bootstrap invite, no claim.
 *
 * Returns: PublicKeyCredentialCreationOptionsJSON (pass to navigator.credentials.create)
 */
app.post('/auth/webauthn/register-options', authEnrollLimiter, async (req, res) => {
  const { name, bootstrapUserId, bootstrapInvite } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  // Mode (C): authenticated add-device flow.
  let addDeviceUserId: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const tr = await verifyToken(authHeader.slice(7));
    if (!tr.valid) {
      res.status(401).json({ error: `Invalid bearer token: ${tr.reason}` });
      return;
    }
    addDeviceUserId = tr.record!.userId;
  }

  // Mode (B): validate bootstrap invite (do NOT consume yet — consumption
  // happens at /register after the ceremony actually verifies).
  let bootstrapTargetUserId: string | undefined;
  if (bootstrapUserId || bootstrapInvite) {
    if (!bootstrapUserId || !bootstrapInvite) {
      res.status(400).json({ error: 'bootstrapUserId and bootstrapInvite must both be supplied' });
      return;
    }
    const expected = BOOTSTRAP_INVITES.get(bootstrapUserId);
    if (!expected || expected !== bootstrapInvite) {
      res.status(401).json({ error: 'Bootstrap credential invalid or already consumed' });
      return;
    }
    if (CONSUMED_INVITES.has(bootstrapUserId)) {
      res.status(409).json({ error: `Bootstrap invite for '${bootstrapUserId}' has already been consumed` });
      return;
    }
    // Additional guard: if the seeded user already has any credential on
    // file, the invite flow is locked out regardless of invite validity.
    const existing = await readAuthMethods(bootstrapUserId, /* allowStale */ true);
    if (hasAnyCredential(existing)) {
      res.status(401).json({ error: 'Bootstrap credential invalid or already consumed' });
      return;
    }
    bootstrapTargetUserId = bootstrapUserId;
  }

  // Ceremony-time correlation key: for modes (A) and (B) we don't yet
  // know the final userId (mode A derives it from the credential; mode B
  // binds to bootstrapTargetUserId at register time). A transient random
  // session id correlates the in-flight challenge to /register. For mode
  // (C) we already know the existing userId.
  //
  // IMPORTANT: sessionUserId is a SERVER-SIDE correlation key only —
  // it MUST NOT be used as the WebAuthn user.name field. The authenticator
  // persists user.name in its credential metadata, and OS passkey pickers
  // (Windows Hello, macOS Keychain, Edge, Chrome) surface user.name as
  // the primary label. Leaking 'u-pend-<rand-hex>' into user.name was a
  // regression that produced an unreadable picker — the user sees a list
  // of opaque random strings instead of human names. The typed
  // displayName from the /authorize page is the right value for both
  // user.name (the credential's primary label) and user.displayName.
  const sessionUserId = addDeviceUserId ?? `u-pend-${crypto.randomBytes(8).toString('hex')}`;
  const userDisplayName = String(name).trim();
  // Defensive: /register-options already 400s on empty name above, so this
  // fallback is unreachable in practice. Kept so a future caller bypass
  // can't reintroduce the u-pend-* leak — fall back to a readable hint
  // derived from the session id, never the raw transient handle.
  const credentialUserName = userDisplayName
    || `Interego user (${sessionUserId.replace(/^u-pend-/, '').slice(0, 6)})`;

  // excludeCredentials: prevents re-enrolling an authenticator already
  // bound to this account. Only meaningful in mode (C).
  let excludeCredentials: Array<{ id: string; transports?: import('@simplewebauthn/server').AuthenticatorTransportFuture[] }> = [];
  if (addDeviceUserId) {
    const m = await readAuthMethods(addDeviceUserId);
    excludeCredentials = m.webAuthnCredentials.map(c => ({
      id: c.id,
      transports: (c.transports ?? []) as unknown as import('@simplewebauthn/server').AuthenticatorTransportFuture[],
    }));
  }

  // Resolve the relying party from the request Origin — the rpID must
  // match the origin the browser will run the ceremony on (the /connect
  // page on this server's own domain, or the relay's /authorize page).
  const rp = resolveRp(req);

  const { generateRegistrationOptions } = await loadWebAuthn();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpId,
    // user.name is what OS passkey pickers display as the primary label.
    // Use the typed display name — NEVER the sessionUserId transient.
    userName: credentialUserName,
    userDisplayName: credentialUserName,
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });

  // Stash session state on the challenge so /register can consult it.
  const ch: Challenge = {
    nonce: options.challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    purpose: 'webauthn-register',
    userId: sessionUserId,
  };
  if (addDeviceUserId) ch.addDeviceUserId = addDeviceUserId;
  if (bootstrapTargetUserId) {
    ch.bootstrapUserId = bootstrapTargetUserId;
    ch.bootstrapInvite = bootstrapInvite;
  }
  // Use the same value we wrote into the credential so /register's
  // Identity row stays in sync with what the authenticator persisted.
  ch.displayName = credentialUserName;
  // /register verifies against the rp this ceremony actually used.
  ch.rpId = rp.rpId;
  ch.rpOrigin = rp.origin;
  challenges.set(options.challenge, ch);
  res.json(options);
});

/**
 * POST /auth/webauthn/register — finish passkey registration.
 *
 * Body: { response: RegistrationResponseJSON, surfaceAgent? }
 *
 * The server NEVER trusts a user-supplied userId here. The final userId
 * is determined by the challenge's pre-validated session state:
 *
 *   - addDeviceUserId (mode C): bound at options-time by bearer token
 *   - bootstrapUserId (mode B): bound at options-time by valid invite
 *   - else (mode A): derived from the new credential's ID
 */
app.post('/auth/webauthn/register', authEnrollLimiter, async (req, res) => {
  const { response, surfaceAgent } = req.body ?? {};
  if (!response) {
    res.status(400).json({ error: 'response is required' });
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
  if (!ch) {
    res.status(401).json({ error: 'Invalid or expired registration challenge' });
    return;
  }

  let verification: VerifiedRegistrationResponse;
  try {
    const { verifyRegistrationResponse } = await loadWebAuthn();
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      // Verify against the rp this ceremony actually ran on (resolved
      // from the Origin at options-time, stashed on the challenge).
      // Falls back to the static RP_* for pre-existing challenges.
      expectedOrigin: ch.rpOrigin ?? RP_ORIGIN,
      expectedRPID: ch.rpId ?? RP_ID,
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
  const credentialId = credential.id;

  // Reject a credential we've seen before — either as a duplicate register
  // attempt, or (extremely unlikely) as a 256-bit collision.
  if (credentialIndex.has(credentialId)) {
    res.status(409).json({ error: 'This credential is already registered' });
    return;
  }

  // Resolve the target userId according to the mode established at
  // /register-options time (already authorised there).
  let targetUserId: string;
  const displayName = ch.displayName ?? credentialId.slice(0, 8);
  if (ch.addDeviceUserId) {
    // Mode (C) add-device — proven by bearer token at options time.
    targetUserId = ch.addDeviceUserId;
  } else if (ch.bootstrapUserId) {
    // Mode (B) bootstrap-claim — invite pre-validated at options time.
    // Consume the invite now that we have a verified credential to bind.
    if (!verifyBootstrapInvite(ch.bootstrapUserId, ch.bootstrapInvite)) {
      res.status(409).json({ error: 'Bootstrap invite no longer valid' });
      return;
    }
    // Re-check: if somebody else bound a credential in the interim, refuse.
    const existing = await readAuthMethods(ch.bootstrapUserId, /* allowStale */ true);
    if (hasAnyCredential(existing)) {
      res.status(401).json({ error: 'Bootstrap credential invalid or already consumed' });
      return;
    }
    targetUserId = ch.bootstrapUserId;
  } else {
    // Mode (A) fresh user — derive userId from the credential itself.
    targetUserId = deriveUserIdFromCredentialId(credentialId);
  }

  // Ensure an Identity shell exists for the target. Seeded users already
  // have one; derived users get created here on first touch.
  let user = identities.get(targetUserId);
  if (!user) {
    seedIdentity(targetUserId, 'user', displayName);
    user = identities.get(targetUserId)!;
  }
  // Make sure the user has a default agent to issue tokens for.
  const hasAgent = [...identities.values()].some(i => i.type === 'agent' && i.owner === targetUserId);
  if (!hasAgent) {
    const def = defaultAgentForRegistration(targetUserId, displayName, surfaceAgent);
    seedIdentity(def.agentId, 'agent', def.label, targetUserId, 'ReadWrite');
    log(`First-time WebAuthn registration: ${targetUserId} defaultAgent=${def.agentId} (surfaceHint=${surfaceAgent ?? 'none'})`);
  }

  const methods = await readAuthMethods(targetUserId);
  if (!methods.name || methods.name === targetUserId) {
    methods.name = user.name;
  }
  if (!methods.agentId) {
    const a = [...identities.values()].find(i => i.type === 'agent' && i.owner === targetUserId);
    if (a) methods.agentId = a.id;
  }
  methods.webAuthnCredentials.push({
    id: credentialId,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: (response.response?.transports as string[] | undefined) ?? [],
    createdAt: new Date().toISOString(),
  });
  // Defer the ~2.5s CSS PUT off the hot response path — same shape as
  // /auth/did and /auth/siwe. The credential is added to the in-memory
  // index synchronously via inlineApplyAuthMethods so any concurrent
  // verifyToken sees it; the pod write is just durability. Note: this
  // does NOT apply to /auth/webauthn/authenticate, whose synchronous
  // persist is load-bearing for WebAuthn §6.1.1 clone detection.
  inlineApplyAuthMethods(targetUserId, methods);
  scheduleDeferredAuthMethodsWrite(targetUserId, methods, 'webauthn-register');
  // FIX A: identity-server no longer mirrors /profile/card or /<id>/agents.
  // Single authoritative pod-side writer is the relay's /oauth/verify
  // handler — see deploy/mcp-relay/server.ts. See SIWE first-touch comment
  // above for the race / 500 / 404-window background.
  log(`WebAuthn credential registered for ${targetUserId} (mode=${ch.addDeviceUserId ? 'add-device' : ch.bootstrapUserId ? 'bootstrap' : 'derive'})`);

  res.json(await issueTokenResponse(user, surfaceAgent));
});

/**
 * POST /auth/webauthn/authenticate — finish passkey login. Verifies
 * the assertion against the user's stored credential.
 * Body: { userId, response: AuthenticationResponseJSON }
 */
app.post('/auth/webauthn/authenticate', authEnrollLimiter, async (req, res) => {
  const { response, surfaceAgent } = req.body ?? {};
  if (!response?.id) {
    res.status(400).json({ error: 'response (with credential id) is required' });
    return;
  }
  if (!credentialIndex.has(response.id)) {
    await awaitInitialIndexWithBudget(50);
  }
  // Canonical lookup: credential id → userId. We never trust a body-supplied
  // userId claim; the identity is whichever user owns the credential that
  // successfully signs the ceremony.
  const userId = credentialIndex.get(response.id);
  if (!userId) {
    res.status(401).json({ error: 'No WebAuthn credential matches this response' });
    return;
  }
  const user = identities.get(userId);
  if (!user || user.type !== 'user') {
    res.status(404).json({ error: `User for credential not found` });
    return;
  }
  const methods = await readAuthMethods(userId);
  const cred = methods.webAuthnCredentials.find(c => c.id === response.id);
  if (!cred) {
    res.status(401).json({ error: 'Credential indexed but not on file' });
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
  // If the challenge was scoped to a specific userId at issuance time, it
  // MUST match the credential's owning userId. No cross-account reuse.
  if (!ch || (ch.userId && ch.userId !== userId)) {
    res.status(401).json({ error: 'Invalid or expired authentication challenge' });
    return;
  }

  let verification: VerifiedAuthenticationResponse;
  try {
    const { verifyAuthenticationResponse } = await loadWebAuthn();
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      // Verify against the rp pinned on the challenge at /challenges
      // time (resolved from the Origin); static RP_* fallback for
      // challenges issued before this was tracked.
      expectedOrigin: ch.rpOrigin ?? RP_ORIGIN,
      expectedRPID: ch.rpId ?? RP_ID,
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

  // Counter is bumped by the authenticator; we MUST persist the new value
  // before considering the auth successful, or a clone with a stale counter
  // can keep authenticating indefinitely (WebAuthn §6.1.1 clone detection).
  // Persist FIRST; on failure, roll the in-memory counter back to what's
  // stored on the pod and refuse the auth with a transient 503 so the
  // client retries. That preserves the invariant: in-memory counter ≡
  // persisted counter.
  const previousCounter = cred.counter;
  cred.counter = verification.authenticationInfo.newCounter;
  try {
    await putPodAuthMethods(userId, methods);
  } catch (err) {
    cred.counter = previousCounter;
    log(`WARN: refused passkey auth — counter persist failed: ${(err as Error).message}`);
    res.status(503).json({ error: 'transient: failed to persist passkey counter; retry' });
    return;
  }
  res.json(await issueTokenResponse(user, surfaceAgent));
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
app.post('/auth/did', authEnrollLimiter, async (req, res) => {
  const requestStart = timingEnabled() ? startTiming() : 0;
  const {
    did, nonce, signature,
    name,
    publicKeyMultibase,
    bootstrapUserId, bootstrapInvite,
    surfaceAgent,
  } = req.body ?? {};
  if (!did || !nonce || !signature) {
    res.status(400).json({ error: 'did, nonce, and signature are required' });
    return;
  }
  const ch = consumeChallenge(nonce, 'did-sig');
  if (!ch) {
    res.status(401).json({ error: 'Invalid or expired challenge' });
    return;
  }

  // Resolve public key — cache the parse result keyed by the DID string.
  // did:key is content-addressed (the public key is encoded INTO the DID),
  // so a given did:key string can never refer to a different key — TTL is
  // process lifetime. base58btc decode runs ~30 LOC of hand-rolled
  // arithmetic per character that's redundant after the first call.
  let publicKeyRaw: Buffer;
  let didKeyFormat: 'base58btc' | 'base64url-legacy' | null = null;
  const parseStart = timingEnabled() ? startTiming() : 0;
  const cached = getCachedParsedDid(did);
  if (cached) {
    publicKeyRaw = cached.publicKeyRaw;
    didKeyFormat = cached.format;
    if (timingEnabled()) logTiming('did-parse', parseStart, { did: did.slice(0, 24), cache: 'hit' });
  } else if (did.startsWith('did:key:z') && did.length > 10) {
    // Per W3C did:key spec: 'z' + base58btc(0xed 0x01 || rawKey32) for
    // Ed25519. We accept the spec form first and the legacy
    // 'z' + base64url(rawKey32) shape this server originally emitted as
    // a deprecated fallback — see parseEd25519DidKey for the migration
    // story.
    const parsed = parseEd25519DidKey(did);
    if (parsed.ok === false) {
      res.status(400).json({ error: `Could not decode did:key public key: ${parsed.error}` });
      return;
    }
    publicKeyRaw = parsed.publicKey;
    didKeyFormat = parsed.format;
    setCachedParsedDid(did, publicKeyRaw, didKeyFormat);
    if (timingEnabled()) logTiming('did-parse', parseStart, { did: did.slice(0, 24), cache: 'miss', format: didKeyFormat });
  } else if (publicKeyMultibase?.startsWith('z')) {
    // Caller-supplied publicKeyMultibase for non-did:key DIDs (did:web, etc.).
    // Try W3C base58btc-with-multicodec first; fall back to the legacy
    // base64url form for back-compat.
    const encoded = publicKeyMultibase.slice(1);
    let resolved: Buffer | null = null;
    let resolvedFormat: 'base58btc' | 'base64url-legacy' | null = null;
    try {
      const decoded = base58btcDecode(encoded);
      if (decoded.length === 34
        && decoded[0] === ED25519_MULTICODEC[0]
        && decoded[1] === ED25519_MULTICODEC[1]) {
        resolved = Buffer.from(decoded.subarray(2));
        resolvedFormat = 'base58btc';
      }
    } catch { /* fall through */ }
    if (!resolved) {
      try {
        const legacy = Buffer.from(encoded, 'base64url');
        if (legacy.length >= 32) {
          resolved = Buffer.from(legacy.subarray(legacy.length - 32));
          resolvedFormat = 'base64url-legacy';
          log(`[did-key-legacy] accepted base64url-encoded publicKeyMultibase for ${did}; client should migrate to W3C base58btc encoding`);
        }
      } catch { /* fall through */ }
    }
    if (!resolved || !resolvedFormat) {
      res.status(400).json({ error: 'Could not decode publicKeyMultibase — tried W3C base58btc(0xed 0x01 || key) and legacy base64url(rawKey); neither yielded a 32-byte Ed25519 public key' });
      return;
    }
    publicKeyRaw = resolved;
    // Cache the parsed result for did:web too — TTL is 60s per the
    // did-parse module so a rotated did:web key still surfaces quickly.
    setCachedParsedDid(did, publicKeyRaw, resolvedFormat);
    if (timingEnabled()) logTiming('did-parse', parseStart, { did: did.slice(0, 24), cache: 'miss', format: resolvedFormat, source: 'multibase' });
  } else {
    res.status(400).json({ error: 'Supply publicKeyMultibase alongside non-did:key DIDs' });
    return;
  }
  if (didKeyFormat === 'base64url-legacy') {
    // Telegraph the upcoming hard-fail to clients via a deprecation header
    // on every legacy-format login response, per the FIX 3 plan.
    res.setHeader('Deprecation', 'true');
    res.setHeader('Warning', '299 - "did:key base64url encoding is deprecated; migrate to W3C base58btc multicodec format"');
  }

  // Verify Ed25519 signature over the nonce.
  //
  // crypto.createPublicKey(...) does ~30ms of native work on the first
  // call in the process (lazy-loads OpenSSL EVP_PKEY + ed25519 curve
  // params) and ~0.3ms thereafter. The KeyObject is immutable, so we
  // cache it keyed on hex(publicKeyRaw) — every subsequent /auth/did
  // for the same DID skips the SPKI assembly + KeyObject build entirely.
  const verifyStart = timingEnabled() ? startTiming() : 0;
  try {
    const sig = Buffer.from(signature, 'base64url');
    const verifyKey = getOrCreateEd25519VerifyKey(publicKeyRaw);
    const ok = crypto.verify(null, Buffer.from(nonce, 'utf8'), verifyKey, sig);
    if (timingEnabled()) logTiming('did-verify', verifyStart, { ok });
    if (!ok) {
      res.status(401).json({ error: 'Ed25519 signature verification failed' });
      return;
    }
  } catch (err) {
    res.status(401).json({ error: `DID signature verification error: ${(err as Error).message}` });
    return;
  }

  // If the initial pod-index rebuild hasn't settled yet, give it a small
  // budget before we look up `did` in didIndex. Without this race the
  // very first /auth/did after a container restart misses didIndex,
  // falls into the first-time-registration branch, and pays a ~2.5s
  // CSS PUT cost — even though the user's credential is already on
  // the pod and the rebuild was about to load it. The budget is small
  // enough to be invisible on warm hits and saves multiple seconds on
  // the boot-race case.
  if (!didIndex.has(did)) {
    await awaitInitialIndexWithBudget(50);
  }

  // Returning user via DID index — no user-claim needed.
  const indexLookupStart = timingEnabled() ? startTiming() : 0;
  let userId = didIndex.get(did);
  let user = userId ? identities.get(userId) : undefined;
  if (timingEnabled()) logTiming('did-index-lookup', indexLookupStart, { hit: !!user });

  // Authenticated add-did: bearer token binds this DID to the caller.
  if (!user) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const tr = await verifyToken(authHeader.slice(7));
      if (tr.valid) {
        userId = tr.record!.userId;
        user = identities.get(userId);
      }
    }
  }

  // Canonical W3C base58btc-with-multicodec encoding of the raw 32-byte
  // Ed25519 key the server actually verified against. Computed ONCE here
  // (hoisted from two prior didKeys.push sites) — encodeEd25519Multibase
  // does a base58btc encode loop on every call. Reused below for both
  // first-time registration and add-did paths.
  const canonicalPublicKeyMultibase = encodeEd25519Multibase(publicKeyRaw);

  if (!user) {
    // Mode (C) add-device handled upstream (bearer populated `user`);
    // resolveTargetUserId covers (A) derive and (B) bootstrap-claim with
    // the enumeration-safe ordering pinned by tests/resolve-target-userid.test.ts.
    const existingForBootstrap = (bootstrapUserId && bootstrapInvite)
      ? await readAuthMethods(bootstrapUserId, /* allowStale */ true)
      : { walletAddresses: [], webAuthnCredentials: [], didKeys: [] };
    const resolved = resolveTargetUserId({
      bootstrapUserId,
      bootstrapInvite,
      did,
      existingAuthMethods: existingForBootstrap,
      deriveFromAddress: deriveUserIdFromWallet,
      deriveFromCredentialId: deriveUserIdFromCredentialId,
      deriveFromDid: deriveUserIdFromDid,
      verifyInvite: verifyBootstrapInvite,
    });
    if (resolved.ok === false) {
      const err = resolved as { status: 400 | 401; body: { error: string } };
      res.status(err.status).json(err.body);
      return;
    }
    const targetUserId = resolved.targetUserId;

    if (!identities.has(targetUserId)) {
      const displayName = String(name ?? targetUserId);
      seedIdentity(targetUserId, 'user', displayName);
      const def = defaultAgentForRegistration(targetUserId, displayName, surfaceAgent);
      seedIdentity(def.agentId, 'agent', def.label, targetUserId, 'ReadWrite');
    }
    user = identities.get(targetUserId)!;
    const agentId = [...identities.values()].find(i => i.type === 'agent' && i.owner === targetUserId)?.id
      ?? defaultAgentForRegistration(targetUserId, user.name, surfaceAgent).agentId;
    const methods = emptyAuthMethods(user.id, user.name, agentId);
    methods.didKeys.push({
      did,
      publicKeyMultibase: canonicalPublicKeyMultibase,
      keyType: 'Ed25519VerificationKey2020',
      createdAt: new Date().toISOString(),
    });
    // FIX A: defer the pod-side PUT off the hot response path. The
    // in-memory record (cache + didIndex + walletIndex + credentialIndex)
    // is updated SYNCHRONOUSLY first so any concurrent /auth/did or
    // verifyToken from this user immediately sees the new credential —
    // no pod read required for the new user's first token to verify.
    // The actual ~2.5s CSS PUT runs in the background under the per-
    // userId mutex; failures retry + log at ERROR for operator alerting.
    inlineApplyAuthMethods(user.id, methods);
    scheduleDeferredAuthMethodsWrite(user.id, methods, 'did-first-time');
    if (timingEnabled()) logTiming('did-pod-write-scheduled', requestStart, { branch: 'first-time' });
    // FIX A: identity-server no longer mirrors /profile/card or /<id>/agents.
    // Single authoritative pod-side writer is the relay's /oauth/verify
    // handler. See SIWE first-touch comment above for background.
    log(`First-time DID registration: ${targetUserId} did=${did} defaultAgent=${agentId} (surfaceHint=${surfaceAgent ?? 'none'})`);
  } else {
    // Add-did (authenticated) path — append if not already bound.
    const methods = await readAuthMethods(user.id);
    if (!methods.didKeys.some(k => k.did === did)) {
      methods.didKeys.push({
        did,
        publicKeyMultibase: canonicalPublicKeyMultibase,
        keyType: 'Ed25519VerificationKey2020',
        createdAt: new Date().toISOString(),
      });
      // FIX A: defer the pod-side PUT — same shape as first-time branch.
      inlineApplyAuthMethods(user.id, methods);
      scheduleDeferredAuthMethodsWrite(user.id, methods, 'did-add-did');
      if (timingEnabled()) logTiming('did-pod-write-scheduled', requestStart, { branch: 'add-did' });
      log(`DID ${did} linked to existing user ${user.id}`);
    }
  }

  const tokenStart = timingEnabled() ? startTiming() : 0;
  const tokenResponse = await issueTokenResponse(user, surfaceAgent);
  if (timingEnabled()) logTiming('did-issue-token', tokenStart);
  if (timingEnabled()) logTiming('did-total', requestStart);
  res.json(tokenResponse);
});

// ── Try-it provisioning (no signup, ephemeral identity) ─────
//
// POST /try mints a fresh anonymous user + pod + token so a stranger
// can evaluate Interego from any MCP client in literally 60 seconds.
// No credential is required — the trade is that the identity is
// ephemeral: the janitor reaps `u-try-*` users after TRY_USER_TTL_MS
// (default 7 days). Users who like what they see follow the normal
// `/connect` flow to enroll a passkey / wallet against the SAME pod
// (the bearer token returned here can be used as `addDeviceToken` on
// the WebAuthn registration flow).
//
// Rate-limited per IP. The token is signed by the same HMAC key as
// every other token, so it survives deploys (until the janitor reaps
// the underlying user).
const tryProvisionLimiter = rateLimit('try-provision', { windowMs: 60 * 60 * 1000, max: 5 });

app.post('/try', tryProvisionLimiter, async (_req, res) => {
  // userId derivation is global per the CLAUDE.md invariant — for `/try`
  // there's no credential to derive from, so we use a fresh random suffix
  // and prefix `u-try-` so the janitor knows to reap it. Same shape as
  // the seeded-userId pattern (`u-pend-<rand>`) used during in-flight
  // WebAuthn ceremonies.
  const userId = `u-try-${crypto.randomBytes(8).toString('hex').slice(0, 12)}`;
  const name = 'Try Interego (anonymous)';
  // Seed the user + a default mcp-client agent. issueToken needs the
  // agent to exist so the per-surface agent resolution doesn't throw.
  seedIdentity(userId, 'user', name);
  const agentId = `mcp-client-${userId}`;
  seedIdentity(agentId, 'agent', `MCP client (${name})`, userId, 'ReadWrite');
  // Write the empty auth-methods.jsonld so the pod has a canonical
  // anchor and a future credential can be appended via /auth/webauthn
  // (with this token as `addDeviceToken`) to claim the pod permanently.
  try {
    await putPodAuthMethods(userId, emptyAuthMethods(userId, name, agentId));
  } catch (err) {
    // If the pod write fails, roll back the in-memory seeds so we don't
    // leave dangling identities that can't actually be used.
    identities.delete(agentId);
    identities.delete(userId);
    res.status(503).json({ error: `Could not provision pod: ${(err as Error).message}` });
    return;
  }
  // FIX A: pod-side /profile/card + /<id>/agents are no longer written
  // here. Try-it users hit the relay's OAuth flow once they begin using
  // an MCP client, at which point the relay's /oauth/verify becomes the
  // single authoritative writer for both documents. For try-it users who
  // never use the OAuth flow, the pod still has the canonical auth-methods
  // document and `${IDENTITY_URL}/users/<id>/profile` remains
  // dereferenceable as the WebID — no pod-side mirror needed pre-OAuth.
  const tokenResponse = await issueTokenResponse(identities.get(userId)!);
  const mcpConfigSnippet = JSON.stringify({
    mcpServers: {
      interego: {
        url: `${RELAY_URL}/sse`,
        headers: { Authorization: `Bearer ${(tokenResponse as { token: string }).token}` },
      },
    },
  }, null, 2);
  log(`Provisioned try-it identity: ${userId} (TTL via janitor)`);
  res.json({
    ...tokenResponse,
    ephemeral: true,
    ttlNote: `Anonymous evaluation identity. The janitor reaps the user + pod ~${TRY_USER_TTL_MS / 86400000}d after creation UNLESS you claim it by enrolling a credential. To claim: go to /connect, expand "Advanced options", paste this bearer token into "addDeviceToken", and enroll a passkey or wallet. The same pod (and its descriptors) becomes permanently yours; the janitor leaves credentialed u-try-* users alone.`,
    mcpConfigSnippet,
  });
});

// Janitor TTL for `u-try-*` users. Configurable; default 7 days. The
// constant is defined here (and read by the janitor block below) so the
// /try endpoint can include the TTL in its response without duplicating
// the env-var read.
const TRY_USER_TTL_MS = parseInt(process.env['TRY_USER_TTL_MS'] ?? String(7 * 24 * 60 * 60 * 1000));

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
      // FIX A: identity-server no longer touches /profile/card or
      // /<id>/agents on the pod. The relay's /oauth/verify is the single
      // authoritative writer for both, and runs the surface-agent
      // registration synchronously after this token is issued. The
      // canonical /users/:id/profile endpoint (in-memory) reflects the
      // new agent immediately for any client that resolves the
      // identity-side WebID directly.
      return identities.get(surfaceAgentId)!;
    }
  }
  const firstAgent = [...identities.values()].find(i => i.type === 'agent' && i.owner === user.id);
  if (!firstAgent) throw new Error(`User '${user.id}' has no agents`);
  return firstAgent;
}

async function issueTokenResponse(user: Identity, surfaceAgent?: string): Promise<Record<string, unknown>> {
  const agent = ensureSurfaceAgent(user, surfaceAgent);
  const tokenRecord = await issueToken(user.id, agent.id, agent.scope ?? 'ReadWrite');
  const host = BASE_URL_HOST;
  // Summarise registered auth methods from cache (stale ok — this is just
  // a UI hint, not security-critical).
  const cached = authMethodsCache.get(user.id)?.value;
  return {
    userId: user.id,
    // Display name for the pod-side /profile/card mirror the relay writes
    // in /oauth/verify (FIX A: relay is now the single authoritative pod
    // writer). Without this, the relay falls back to userId as the
    // foaf:name, which is uglier for human-facing Solid clients.
    name: user.name,
    agentId: agent.id,
    // Display label for the per-surface agent — also needed by the relay's
    // pod-side registry write so iep:AuthorizedAgent entries get a meaningful
    // foaf:name instead of just "Surface agent <slug>".
    agentName: agent.name,
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
app.post('/register-agent', tokenLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required' });
    return;
  }

  const tokenResult = await verifyToken(authHeader.slice(7));
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
  const tokenRecord = await issueToken(userId, agentId, scope ?? 'ReadWrite');

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
app.post('/tokens', tokenLimiter, async (req, res) => {
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

  const record = await issueToken(userId, agentId, agent.scope ?? 'ReadWrite');
  res.json({ token: record.token, expiresAt: record.expiresAt, scope: record.scope });
});

/**
 * POST /tokens/verify — Verify a bearer token
 * Body: { token }
 * Returns: { valid, userId?, agentId?, scope?, reason? }
 */
app.post('/tokens/verify', tokenLimiter, async (req, res) => {
  // Introspection-secret gate. Mirrors the relay's /verify-token: when
  // IDENTITY_INTROSPECTION_SECRET is set we require the caller to carry
  // the same shared secret in `Authorization: Bearer <secret>`, compared
  // timing-safe. Unset = legacy open behavior so the rollout doesn't
  // break existing css-gate deployments before they're rewired.
  if (IDENTITY_INTROSPECTION_SECRET) {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) {
      res.status(401).json({ error: 'introspection bearer required' });
      return;
    }
    const presented = Buffer.from(auth.slice(7), 'utf8');
    const expected = Buffer.from(IDENTITY_INTROSPECTION_SECRET, 'utf8');
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      res.status(401).json({ error: 'introspection bearer rejected' });
      return;
    }
  }

  const { token } = req.body;
  if (!token) {
    res.status(400).json({ error: 'token is required' });
    return;
  }

  const result = await verifyToken(token);
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

// Identity server's own signing key. Generated once at process start
// and used for serving /.well-known/did.json. Previously this read from
// the seeded `markj` entry, which coupled the server's DID to an
// application-level user. Now the server has its own key.
const SERVER_KEY = generateEd25519();

// ── /.well-known/security.txt — RFC 9116 ─────────────────────
//
// Coordinated disclosure contact for security researchers. The
// identity service deliberately has zero dependency on @interego/core
// (lean container, separate Dockerfile). Body MUST stay in lockstep
// with @interego/core's buildSecurityTxt — verified by
// tests/security-txt-consistency.test.ts so audit consistency holds.
// See spec/policies/14-vulnerability-management.md §5.3.
const SECURITY_CONTACT = process.env.SECURITY_CONTACT;
const SECURITY_TXT_BODY = (() => {
  const contact = SECURITY_CONTACT
    ? (SECURITY_CONTACT.startsWith('mailto:') || SECURITY_CONTACT.startsWith('https:') || SECURITY_CONTACT.startsWith('tel:')
        ? SECURITY_CONTACT
        : `mailto:${SECURITY_CONTACT}`)
    : 'https://github.com/markjspivey-xwisee/interego/security/advisories/new';
  const lines = [
    `Contact: ${contact}`,
    `Expires: 2027-01-01T00:00:00Z`,
    `Preferred-Languages: en`,
  ];
  if (BASE_URL) {
    lines.push(`Canonical: ${BASE_URL.replace(/\/$/, '')}/.well-known/security.txt`);
  }
  lines.push(`Policy: https://github.com/markjspivey-xwisee/interego/blob/master/spec/policies/14-vulnerability-management.md`);
  lines.push(`Acknowledgments: https://github.com/markjspivey-xwisee/interego/blob/master/SECURITY-ACKNOWLEDGMENTS.md`);
  lines.push('');
  return lines.join('\n');
})();
app.get(['/.well-known/security.txt', '/security.txt'], (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(SECURITY_TXT_BODY);
});

app.get('/.well-known/did.json', (_req, res) => {
  const serverDid = `did:web:${new URL(BASE_URL).host}`;
  res.json({
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: serverDid,
    verificationMethod: [{
      id: `${serverDid}#key-1`,
      type: 'Ed25519VerificationKey2020',
      controller: serverDid,
      publicKeyMultibase: SERVER_KEY.publicKeyMultibase,
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
    `@prefix iep: <${ONTOLOGY_URL}> .`,
    `@prefix prov: <http://www.w3.org/ns/prov#> .`,
    `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
    ``,
    `<${BASE_URL}/agents/${identity.id}/profile#agent>`,
    `    a iep:AuthorizedAgent, prov:SoftwareAgent ;`,
    `    rdfs:label "${identity.name}" ;`,
    `    iep:agentIdentity <${did}> ;`,
    `    iep:delegatedBy <${BASE_URL}/users/${owner}/profile#me> ;`,
    `    iep:scope "${identity.scope ?? 'ReadWrite'}" .`,
  ].join('\n'));
});

// ── WebFinger (RFC 7033) ────────────────────────────────────
//
// Discovery endpoint per RFC 7033. PUBLIC: any caller (browser, federation
// crawler, anonymous bot) may hit this with no auth, so we always emit
// `Access-Control-Allow-Origin: *` here regardless of the
// identity-server's normal CORS allowlist. Per RFC 7033 §4.4 the
// response media type is `application/jrd+json`.
//
// Lookup strategy:
//   1) acct:<handle>@<host> — extract handle.
//      Also accept the courtesy form https://<host>/users/<id> (and
//      /agents/<id>) and pull the id from the path.
//   2) Try identities.get(handle) — the fast path for canonical userIds
//      like `u-pk-00181cd5dbee`. Confirm type === 'user' or 'agent'.
//   3) If (2) misses, iterate identities.values() looking for a
//      case-insensitive identity.name match. Covers the display-name
//      form (e.g. `acct:johnny@host` resolving to userId `u-pk-…`).
//   4) Anything still unresolved → 404 with empty body (RFC 7033 §4.2
//      leaves 404 body unspecified; an empty body is cleaner than the
//      JSON error blob the previous version emitted, which some
//      federation crawlers misparse).
//
// We answer for ANY host portion of the resource (i.e. no @<host>
// equality check). We are an OIDC issuer + DID registrar that hosts
// the canonical record for every userId we know about; refusing to
// answer because the requester wrote the wrong hostname would just
// break cross-instance probing.

// Explicit, always-* CORS for WebFinger discovery. The /.well-known/webfinger
// endpoint is required by RFC 7033 to be publicly readable. We set ACAO=* on
// both the GET response and the OPTIONS preflight, overriding the
// `corsMiddleware` allowlist that the rest of the identity server uses.
function setWebFingerCors(res: express.Response): void {
  // cors-public-discovery: RFC 7033 §4.4 requires /.well-known/webfinger to be
  // world-readable cross-origin. Unauthenticated + read-only + carries no
  // credentials, so ACAO:* here is correct and is NOT the reflected-origin
  // CSRF risk the cors-allowlist test guards against (which still forbids any
  // UNMARKED wildcard in the general handlers).
  res.setHeader('Access-Control-Allow-Origin', '*'); // cors-public-discovery
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept');
  res.setHeader('Vary', 'Origin');
}

app.options('/.well-known/webfinger', (_req, res) => {
  setWebFingerCors(res);
  res.status(204).end();
});

app.get('/.well-known/webfinger', webfingerLimiter, (req, res) => {
  setWebFingerCors(res);
  const handle = parseWebFingerResource(req.query.resource);
  if (handle === null) {
    res.status(400).setHeader('Content-Type', 'application/json');
    res.json({ error: 'resource parameter required (acct:<handle>@<host>)' });
    return;
  }
  const identity = lookupWebFingerIdentity(handle, identities);
  if (!identity) {
    // Empty body per RFC 7033 §4.2.
    res.status(404).end();
    return;
  }
  const jrd = buildWebFingerJrd(identity, {
    baseUrl: BASE_URL,
    cssUrl: CSS_URL,
    requestedHandle: handle,
  });
  const filtered = applyWebFingerRelFilter(jrd, req.query.rel as undefined | string | string[]);
  res.setHeader('Content-Type', 'application/jrd+json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).send(JSON.stringify(filtered));
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
app.post('/siwe/verify', siweVerifyLimiter, async (req, res) => {
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
    const { ethers } = await loadEthers();
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
    const token = await issueToken(user.id, `wallet-${walletAddress}`, 'ReadWrite');
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
app.post('/siwe/nonce', authEnrollLimiter, (_req, res) => {
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

app.get('/users', async (req, res) => {
  // Auth-gated to prevent unauthenticated enumeration of every account on
  // the deployment. Returns only the authenticated user's own record.
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required' });
    return;
  }
  const tr = await verifyToken(authHeader.slice(7));
  if (!tr.valid) { res.status(401).json({ error: `Invalid bearer token: ${tr.reason}` }); return; }
  const callerId = tr.record!.userId;
  const users = [...identities.values()]
    .filter(i => i.type === 'user' && i.id === callerId)
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
app.post('/wallet/link', authEnrollLimiter, async (req, res) => {
  // MUST be authenticated as the target user. Previously any caller could
  // name an arbitrary userId and attach a valid-but-foreign wallet to it,
  // which gave that wallet first-class auth into the victim's account on
  // the next /auth/siwe call.
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required to link a wallet. POST /auth/siwe (no userId claim) to bind a fresh wallet to its own derived userId; POST /auth/siwe with Authorization: Bearer <token> to bind an additional wallet to the token\'s user.' });
    return;
  }
  const tr = await verifyToken(authHeader.slice(7));
  if (!tr.valid) { res.status(401).json({ error: `Invalid bearer token: ${tr.reason}` }); return; }

  const { walletAddress, siweMessage, signature } = req.body ?? {};
  if (!walletAddress || !siweMessage || !signature) {
    res.status(400).json({ error: 'walletAddress, siweMessage, and signature are required' });
    return;
  }

  const userId = tr.record!.userId;
  const user = identities.get(userId);
  if (!user || user.type !== 'user') {
    res.status(404).json({ error: `User '${userId}' (from token) not found` });
    return;
  }

  // Verify the SIWE signature with real ECDSA recovery
  try {
    const { ethers } = await loadEthers();
    const recovered = ethers.verifyMessage(siweMessage, signature);
    if (recovered.toLowerCase() !== (walletAddress as string).toLowerCase()) {
      res.status(401).json({ error: `Signature mismatch: expected ${walletAddress}, recovered ${recovered}` });
      return;
    }
  } catch (err) {
    res.status(401).json({ error: `Signature verification failed: ${(err as Error).message}` });
    return;
  }

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
 * GET /auth-methods/me — Return the full auth-methods.jsonld for the
 * bearer-token's user. Intended for auditing (did anyone else add a
 * credential to my account?) and for UIs that show "your registered
 * passkeys / wallets / DIDs".
 *
 * We intentionally return ONLY the calling user's own doc — not an
 * admin dump. No userId path parameter, no lookup by arbitrary id;
 * the token's userId is authoritative.
 */
app.get('/auth-methods/me', authEnrollLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required' });
    return;
  }
  const tr = await verifyToken(authHeader.slice(7));
  if (!tr.valid) { res.status(401).json({ error: `Invalid bearer token: ${tr.reason}` }); return; }
  const userId = tr.record!.userId;
  const methods = await readAuthMethods(userId);
  res.json({
    userId,
    name: methods.name,
    agentId: methods.agentId,
    walletAddresses: methods.walletAddresses,
    webAuthnCredentials: methods.webAuthnCredentials.map(c => ({
      id: c.id,
      createdAt: c.createdAt,
      transports: c.transports,
      // NOTE: publicKey + counter intentionally omitted — not useful for
      // audit and they're stored in the pod anyway.
    })),
    didKeys: methods.didKeys.map(k => ({
      did: k.did,
      keyType: k.keyType,
      createdAt: k.createdAt,
    })),
  });
});

/**
 * GET /me — consumer-friendly identity summary.
 *
 * Returns just the fields a dashboard / inviter / sharing UI needs:
 * the user's canonical DID, WebID, pod URL, display name, and the
 * primary agent ID — without enumerating every passkey or wallet.
 *
 * For credential management use /auth-methods/me. For the full
 * profile (DID document with verification methods) use
 * /users/:id/profile or /users/:id/did.json. This endpoint exists
 * because the consumer UX audit (UX#5) flagged "the user enrolls and
 * has no way to find their own DID without command-line tools."
 *
 * Bearer-authenticated; the token's userId is authoritative — no
 * lookup-by-arbitrary-id surface.
 */
app.get('/me', authEnrollLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'authentication_required',
      title: 'Bearer token required',
      detail: 'GET /me returns your own identity summary. Authenticate first via /authorize on the relay or one of the /auth/* flows on the identity server.',
    });
    return;
  }
  const tr = await verifyToken(authHeader.slice(7));
  if (!tr.valid) {
    res.status(401).json({
      error: 'invalid_token',
      title: 'Invalid bearer token',
      detail: tr.reason ?? 'Token failed verification — it may have expired or been revoked.',
    });
    return;
  }
  const userId = tr.record!.userId;
  const user = identities.get(userId);
  if (!user || user.type !== 'user') {
    res.status(404).json({
      error: 'user_not_found',
      title: 'User not found',
      detail: 'Your token verified but the matching user record is missing. This usually means the server was restarted with a different BOOTSTRAP_INVITES configuration. Re-enroll via /auth/* to get a fresh token.',
    });
    return;
  }
  // Resolve the *session's* agent — the one this bearer token was issued for —
  // rather than picking whichever agent appears first in identities.values().
  // Map insertion order is unstable across hydrate/rebuild paths and would
  // otherwise return a stale placeholder (e.g. mcp-client-<userId>) even after
  // the relay minted a real per-surface agent (chatgpt-<userId>, etc.) on top.
  const sessionAgentId = tr.record!.agentId;
  let primaryAgent = identities.get(sessionAgentId);
  if (!primaryAgent || primaryAgent.type !== 'agent' || primaryAgent.owner !== userId) {
    // Token's agent record is gone (post-restart hydration miss, manual
    // revocation, etc.) — fall back to any agent owned by this user so
    // /me stays useful for re-enrollment hints.
    primaryAgent = [...identities.values()].find(i => i.type === 'agent' && i.owner === userId);
  }
  // Pod URL derives from the user's canonical id (deployment convention).
  const did = `did:web:${BASE_URL_HOST_NO_PORT}:users:${userId}`;
  const webId = `${BASE_URL.replace(/\/$/, '')}/users/${userId}/profile#me`;
  res.json({
    userId,
    did,
    webId,
    displayName: user.name,
    primaryAgentId: primaryAgent?.id ?? null,
    primaryAgentDid: primaryAgent
      ? `did:web:${BASE_URL_HOST_NO_PORT}:agents:${primaryAgent.id}`
      : null,
    podHint: `${BASE_URL.replace('-identity.', '-css.').replace(/\/$/, '')}/${userId}/`,
    enrolledAt: user.createdAt,
    actions: {
      manageCredentials: `${BASE_URL.replace(/\/$/, '')}/auth-methods/me`,
      profile: `${BASE_URL.replace(/\/$/, '')}/users/${userId}/profile`,
      didDocument: `${BASE_URL.replace(/\/$/, '')}/users/${userId}/did.json`,
    },
  });
});

// Shared helper: resolve bearer token to the user, refuse if invalid.
async function requireUserFromBearer(req: express.Request, res: express.Response): Promise<Identity | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required' });
    return null;
  }
  const tr = await verifyToken(authHeader.slice(7));
  if (!tr.valid) { res.status(401).json({ error: `Invalid bearer token: ${tr.reason}` }); return null; }
  const user = identities.get(tr.record!.userId);
  if (!user || user.type !== 'user') {
    res.status(404).json({ error: `User for token not found` });
    return null;
  }
  return user;
}

/**
 * DELETE /auth-methods/me/webauthn/:credentialId
 *
 * Remove a passkey from the calling user's auth-methods.jsonld. Rejects
 * if removing this credential would leave the user with zero auth
 * methods — preventing accidental lockout. (User can rotate to a new
 * method first, then delete the old one.)
 */
app.delete('/auth-methods/me/webauthn/:credentialId', authEnrollLimiter, async (req, res) => {
  const user = await requireUserFromBearer(req, res);
  if (!user) return;
  const credentialId = decodeURIComponent((req.params['credentialId'] as string | undefined) ?? '');
  if (!credentialId) { res.status(400).json({ error: 'credentialId required' }); return; }
  const methods = await readAuthMethods(user.id);
  const before = methods.webAuthnCredentials.length;
  const next = methods.webAuthnCredentials.filter(c => c.id !== credentialId);
  if (next.length === before) { res.status(404).json({ error: 'Credential not found' }); return; }
  // Lockout guard: refuse to remove the user's last auth method of any kind.
  const remainingTotal = next.length + methods.walletAddresses.length + methods.didKeys.length;
  if (remainingTotal === 0) {
    res.status(409).json({ error: 'Refusing to delete your last authentication method. Add another method first, then retry.' });
    return;
  }
  methods.webAuthnCredentials = next;
  try { await putPodAuthMethods(user.id, methods); }
  catch (err) { res.status(500).json({ error: `Failed to persist: ${(err as Error).message}` }); return; }
  log(`Removed WebAuthn credential ${credentialId} for ${user.id}`);
  res.json({ removed: true, credentialId, remaining: next.length });
});

/**
 * DELETE /auth-methods/me/wallet/:address
 *
 * Unlink an Ethereum wallet. Same lockout guard as above.
 */
app.delete('/auth-methods/me/wallet/:address', authEnrollLimiter, async (req, res) => {
  const user = await requireUserFromBearer(req, res);
  if (!user) return;
  const address = ((req.params['address'] as string | undefined) ?? '').toLowerCase();
  if (!address) { res.status(400).json({ error: 'address required' }); return; }
  const methods = await readAuthMethods(user.id);
  const before = methods.walletAddresses.length;
  const next = methods.walletAddresses.filter(a => a.toLowerCase() !== address);
  if (next.length === before) { res.status(404).json({ error: 'Wallet not found' }); return; }
  const remainingTotal = next.length + methods.webAuthnCredentials.length + methods.didKeys.length;
  if (remainingTotal === 0) {
    res.status(409).json({ error: 'Refusing to delete your last authentication method. Add another method first, then retry.' });
    return;
  }
  methods.walletAddresses = next;
  try { await putPodAuthMethods(user.id, methods); }
  catch (err) { res.status(500).json({ error: `Failed to persist: ${(err as Error).message}` }); return; }
  log(`Removed wallet ${address} for ${user.id}`);
  res.json({ removed: true, walletAddress: address, remaining: next.length });
});

/**
 * DELETE /auth-methods/me/did
 *
 * Body: { did: string }. DID strings contain colons which are messy in
 * URL path params; accept via body instead.
 */
app.delete('/auth-methods/me/did', authEnrollLimiter, async (req, res) => {
  const user = await requireUserFromBearer(req, res);
  if (!user) return;
  const did: string | undefined = req.body?.did;
  if (!did) { res.status(400).json({ error: 'did required in body' }); return; }
  const methods = await readAuthMethods(user.id);
  const before = methods.didKeys.length;
  const next = methods.didKeys.filter(k => k.did !== did);
  if (next.length === before) { res.status(404).json({ error: 'DID not found' }); return; }
  const remainingTotal = next.length + methods.webAuthnCredentials.length + methods.walletAddresses.length;
  if (remainingTotal === 0) {
    res.status(409).json({ error: 'Refusing to delete your last authentication method. Add another method first, then retry.' });
    return;
  }
  methods.didKeys = next;
  try { await putPodAuthMethods(user.id, methods); }
  catch (err) { res.status(500).json({ error: `Failed to persist: ${(err as Error).message}` }); return; }
  log(`Removed DID ${did} for ${user.id}`);
  res.json({ removed: true, did, remaining: next.length });
});

/**
 * POST /tokens/me/sign-out-everywhere
 *
 * Revoke every currently-active identity-server bearer token for the
 * calling user. The caller's own token is also invalidated, so the
 * dashboard must treat the response as a forced sign-out. Useful after
 * removing a compromised device or suspicious activity.
 *
 * Note: this only revokes identity-server tokens. OAuth MCP access
 * tokens issued by the relay are held in relay memory and not touched
 * here. The relay will, however, no longer be able to mint new identity
 * tokens for those MCP tokens (their extra.identityToken becomes stale
 * — any /identity-token call returns a stale string that identity then
 * rejects).
 */
app.post('/tokens/me/sign-out-everywhere', tokenLimiter, async (req, res) => {
  const user = await requireUserFromBearer(req, res);
  if (!user) return;
  // Stateless revocation: bump the pod's sessionEpoch. Tokens were
  // signed with the epoch in force at their issuance; verifyToken
  // refuses anything below the pod's current value. The cache is
  // invalidated via putPodAuthMethods so the next verify sees the
  // bumped epoch immediately.
  let methods: AuthMethods;
  try {
    methods = await readAuthMethods(user.id, /* allowStale */ false);
  } catch (err) {
    res.status(500).json({ error: `Failed to read auth-methods: ${(err as Error).message}` });
    return;
  }
  const newEpoch = (methods.sessionEpoch ?? 0) + 1;
  const updated: AuthMethods = { ...methods, sessionEpoch: newEpoch };
  try {
    await putPodAuthMethods(user.id, updated);
  } catch (err) {
    res.status(500).json({ error: `Failed to persist sessionEpoch bump: ${(err as Error).message}` });
    return;
  }
  log(`Signed out everywhere for ${user.id} — sessionEpoch ${methods.sessionEpoch ?? 0} → ${newEpoch}`);
  res.json({ revoked: true, userId: user.id, sessionEpoch: newEpoch });
});

/**
 * POST /users/me/delete
 *
 * Tear down the calling user entirely:
 *   - all in-memory identities (user + every owned agent)
 *   - all bearer tokens issued for that user
 *   - the user's pod-side auth-methods.jsonld
 *   - the user's pod-side agents file
 *
 * Bearer-gated by the user's own token, so the operation is self-
 * service. Used by the Playwright E2E test for happy-path cleanup and
 * by the periodic janitor (see `janitor` loop below) for stale test
 * users left behind after a crashed run.
 *
 * Pod *files* are deleted via CSS HTTP DELETE; the empty pod *container*
 * remains (CSS doesn't auto-prune empty containers, and removing them
 * requires storage-account credentials the identity server doesn't carry).
 * That's acceptable — empty containers don't slow the root listing
 * appreciably and the dashboard's discovery cache absorbs the rest.
 */
async function deleteUserCompletely(userId: string): Promise<{ agents: string[]; podCleanup: { authMethods: number; agents: number } }> {
  const ownedAgentIds = [...identities.values()]
    .filter(i => i.type === 'agent' && i.owner === userId)
    .map(a => a.id);
  for (const agentId of ownedAgentIds) {
    identities.delete(agentId);
    keys.delete(agentId);
  }
  identities.delete(userId);
  keys.delete(userId);

  // Token revocation: deleting the pod's auth-methods.jsonld (below)
  // makes `readAuthMethods` fail for this user; verifyToken handles
  // that as a soft-pass (partition tolerance), but tokens will hit TTL
  // shortly. Hard revocation isn't necessary for a delete — the user
  // and their pod are gone.
  authMethodsCache.delete(userId);
  for (const [k, v] of walletIndex) if (v === userId) walletIndex.delete(k);
  for (const [k, v] of credentialIndex) if (v === userId) credentialIndex.delete(k);
  for (const [k, v] of didIndex) if (v === userId) didIndex.delete(k);

  const podCleanup = { authMethods: 0, agents: 0 };
  try {
    const r = await fetch(podAuthMethodsUrl(userId), { method: 'DELETE' });
    podCleanup.authMethods = r.status;
  } catch { /* best-effort */ }
  try {
    const r = await fetch(`${CSS_URL}${userId}/agents`, { method: 'DELETE' });
    podCleanup.agents = r.status;
  } catch { /* best-effort */ }

  return { agents: ownedAgentIds, podCleanup };
}

app.post('/users/me/delete', tokenLimiter, async (req, res) => {
  const user = await requireUserFromBearer(req, res);
  if (!user) return;
  const result = await deleteUserCompletely(user.id);
  log(`Deleted user ${user.id} (agents removed: ${result.agents.join(', ') || 'none'})`);
  res.json({ deleted: true, userId: user.id, ...result });
});

/**
 * GET /agents/me
 *
 * Return the calling user's registered agents. Read from in-memory
 * identities map (hydrated from pod scans). The dashboard uses this to
 * render per-agent management UIs.
 */
app.get('/agents/me', tokenLimiter, async (req, res) => {
  const user = await requireUserFromBearer(req, res);
  if (!user) return;
  const userAgents = [...identities.values()]
    .filter(i => i.type === 'agent' && i.owner === user.id)
    .map(a => ({
      id: a.id,
      name: a.name,
      scope: a.scope ?? 'ReadWrite',
      createdAt: a.createdAt,
      did: `did:web:${new URL(BASE_URL).host}:agents:${a.id}`,
    }));
  res.json({
    userId: user.id,
    name: user.name,
    agents: userAgents,
  });
});

/**
 * GET /wallet/status/:userId — Check if a user has any linked wallets.
 */
app.get('/wallet/status/:userId', async (req, res) => {
  // Auth-gated to prevent linking userIds to on-chain wallet addresses.
  // Only the bearer's own userId may be queried.
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required' });
    return;
  }
  const tr = await verifyToken(authHeader.slice(7));
  if (!tr.valid) { res.status(401).json({ error: `Invalid bearer token: ${tr.reason}` }); return; }
  if (tr.record!.userId !== req.params.userId) {
    res.status(403).json({ error: 'Bearer token does not match the requested userId' });
    return;
  }
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
 * GET /dashboard — consumer-facing browser dashboard.
 *
 * Renders a single-page UI that shows the bearer-authenticated user's:
 *   - canonical DID + WebID + pod URL (with copy buttons — closes UX#5)
 *   - inbox (recent descriptors on their pod via relay /inbox — UX#10)
 *   - registered credentials (passkeys / wallets / DIDs from
 *     /auth-methods/me — UX#5 admin surface)
 *   - sign-out-everywhere action (token revocation)
 *
 * Single static HTML document, no build step, no external resources.
 * Token resolution order:
 *   1. ?token= query param (set by OAuth callback redirect)
 *   2. sessionStorage 'cg.token' (persisted across reloads in this tab)
 * If neither, the page prompts to authenticate via the landing flow.
 *
 * Closes the audit's biggest cluster: "I enrolled — now what?" The
 * dashboard answers it with the four surfaces a non-developer
 * actually needs.
 */
app.get('/dashboard', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'public, max-age=300');
  const relayBase = BASE_URL.replace('-identity.', '-relay.').replace(/\/$/, '');
  const identityBase = BASE_URL.replace(/\/$/, '');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Interego Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #0a0a0f; color: #e0e0e8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; }
  body { padding: 24px 16px; max-width: 920px; margin: 0 auto; }
  .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #2a2a3a; }
  .topbar h1 { font-size: 1.3rem; font-weight: 600; }
  .topbar .greeting { color: #9090a0; font-size: 0.85rem; margin-top: 2px; }
  .signout { background: transparent; color: #f87171; border: 1px solid #f87171; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
  .signout:hover { background: #f87171; color: white; }
  .grid { display: grid; gap: 18px; grid-template-columns: 1fr; }
  @media (min-width: 700px) { .grid { grid-template-columns: 1fr 1fr; } }
  .card { background: #12121a; border: 1px solid #2a2a3a; border-radius: 12px; padding: 20px; }
  .card.full { grid-column: 1 / -1; }
  .card h2 { font-size: 1rem; margin-bottom: 14px; color: #a78bfa; display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .field { margin-bottom: 12px; }
  .field label { display: block; color: #888; font-size: 0.78rem; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
  .field-row { display: flex; gap: 8px; align-items: center; }
  .field-row code { flex: 1; background: #0a0a0f; padding: 8px 12px; border-radius: 6px; font-size: 0.82rem; color: #c0c0c8; overflow-x: auto; white-space: nowrap; }
  .copy { background: #2a2a3a; border: none; color: #e0e0e8; padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 0.82rem; white-space: nowrap; }
  .copy:hover { background: #3a3a4a; }
  .copy.copied { background: #10b981; color: white; }
  .inbox-item { padding: 12px 0; border-bottom: 1px solid #1a1a26; font-size: 0.85rem; }
  .inbox-item:last-child { border-bottom: none; }
  .inbox-item .url { color: #c0c0c8; word-break: break-all; }
  .inbox-item .meta { color: #888; font-size: 0.76rem; margin-top: 3px; }
  .inbox-item .pill { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.7rem; margin-right: 4px; }
  .pill-asserted { background: #1f3a26; color: #10b981; }
  .pill-hypothetical { background: #2a2a3a; color: #a78bfa; }
  .pill-counterfactual { background: #3a1f1f; color: #f87171; }
  .cred-item { padding: 10px 0; border-bottom: 1px solid #1a1a26; font-size: 0.84rem; display: flex; justify-content: space-between; align-items: center; }
  .cred-item:last-child { border-bottom: none; }
  .cred-item .kind { color: #a78bfa; font-weight: 600; margin-right: 8px; }
  .cred-item .val { color: #c0c0c8; word-break: break-all; }
  .empty { color: #888; font-size: 0.85rem; padding: 8px 0; font-style: italic; }
  .err { color: #f87171; font-size: 0.85rem; padding: 8px 0; }
  .auth-required { text-align: center; padding: 40px 20px; color: #9090a0; }
  .auth-required a { color: #a78bfa; text-decoration: none; font-weight: 600; }
  .auth-required a:hover { text-decoration: underline; }
  .footer { color: #555; font-size: 0.76rem; text-align: center; margin-top: 32px; padding-top: 16px; border-top: 1px solid #1a1a26; }
  .hint { color: #888; font-size: 0.8rem; margin-top: 6px; line-height: 1.4; }
  .hint code { background: #0a0a0f; padding: 1px 4px; border-radius: 3px; color: #a78bfa; }
</style>
</head>
<body>
  <div id="app"></div>
<script>
  const IDENTITY_BASE = ${JSON.stringify(identityBase)};
  const RELAY_BASE = ${JSON.stringify(relayBase)};

  // Token resolution: query param → sessionStorage → unauthenticated.
  function getToken() {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl) {
      sessionStorage.setItem('cg.token', fromUrl);
      // Strip the token from the URL so it isn't logged in shared bookmarks
      url.searchParams.delete('token');
      history.replaceState({}, '', url.toString());
      return fromUrl;
    }
    return sessionStorage.getItem('cg.token');
  }
  function clearToken() {
    sessionStorage.removeItem('cg.token');
  }

  async function api(base, path, opts) {
    const token = getToken();
    const headers = Object.assign({}, (opts && opts.headers) || {}, token ? { Authorization: 'Bearer ' + token } : {});
    const resp = await fetch(base + path, Object.assign({}, opts, { headers }));
    if (!resp.ok) {
      let detail = '';
      try { const j = await resp.json(); detail = j.detail || j.title || j.error || JSON.stringify(j); }
      catch { detail = await resp.text(); }
      throw new Error(detail || ('HTTP ' + resp.status));
    }
    return resp.json();
  }

  function copyButton(text) {
    const btn = document.createElement('button');
    btn.className = 'copy';
    btn.textContent = 'Copy';
    btn.onclick = function () {
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      });
    };
    return btn;
  }

  function field(label, value) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const lab = document.createElement('label');
    lab.textContent = label;
    const row = document.createElement('div');
    row.className = 'field-row';
    const c = document.createElement('code');
    c.textContent = value || '—';
    row.appendChild(c);
    if (value) row.appendChild(copyButton(value));
    wrap.appendChild(lab);
    wrap.appendChild(row);
    return wrap;
  }

  // ── base64url helpers (paired with the bytesToB64url on /connect) ──
  function b64urlToBytes(s) {
    const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(p);
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }
  function bytesToB64url(bytes) {
    let s = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (const b of arr) s += String.fromCharCode(b);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }

  // Returning users authenticate (passkey assertion / wallet SIWE) — they
  // are NOT enrolling new credentials. The browser holds the keypair; the
  // server holds the credential registry. A successful ceremony yields a
  // fresh bearer token that replaces whatever stale one was in
  // sessionStorage.
  async function signInWithPasskey() {
    if (!window.PublicKeyCredential) {
      alert('This browser does not support passkeys.');
      return;
    }
    try {
      // Username-less ceremony: no userId in the challenge, no
      // allowCredentials — the browser shows its discoverable-credential
      // picker and /auth/webauthn/authenticate looks up the user via the
      // credential id that comes back.
      const chResp = await fetch(IDENTITY_BASE + '/challenges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'webauthn-authenticate' }),
      });
      if (!chResp.ok) throw new Error('challenge: ' + await chResp.text());
      const ch = await chResp.json();
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: b64urlToBytes(ch.nonce),
          // Empty = any discoverable credential on this device. The
          // browser/OS shows the picker.
          allowCredentials: [],
          userVerification: 'preferred',
          timeout: 60000,
        },
      });
      if (!assertion) throw new Error('No credential returned');
      const response = {
        id: assertion.id,
        rawId: bytesToB64url(assertion.rawId),
        type: assertion.type,
        response: {
          authenticatorData: bytesToB64url(assertion.response.authenticatorData),
          clientDataJSON: bytesToB64url(assertion.response.clientDataJSON),
          signature: bytesToB64url(assertion.response.signature),
          userHandle: assertion.response.userHandle ? bytesToB64url(assertion.response.userHandle) : null,
        },
        clientExtensionResults: assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {},
      };
      const authResp = await fetch(IDENTITY_BASE + '/auth/webauthn/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
      });
      if (!authResp.ok) {
        const t = await authResp.text();
        throw new Error('authenticate: ' + t);
      }
      const result = await authResp.json();
      sessionStorage.setItem('cg.token', result.token);
      renderDashboard().catch(function (e) { console.error(e); });
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      alert('Passkey sign-in failed: ' + msg + '\\n\\nIf you originally enrolled with a wallet, use that option instead.');
    }
  }

  function renderAuthRequired(opts) {
    const reason = opts && opts.reason;
    const app = document.getElementById('app');
    app.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'auth-required';
    div.style.maxWidth = '460px';
    div.style.margin = '60px auto';
    div.style.padding = '32px';
    div.style.background = '#12121a';
    div.style.border = '1px solid #2a2a3a';
    div.style.borderRadius = '14px';
    div.style.textAlign = 'left';
    var html = '<h2 style="font-size:1.2rem;margin-bottom:8px;color:#e0e0e8">Sign back in</h2>';
    if (reason) {
      html += '<p style="margin-bottom:12px;font-size:0.82rem;color:#9aa0ac">' + reason + '</p>';
    } else {
      html += '<p style="margin-bottom:16px;font-size:0.9rem;color:#9aa0ac">Your session ended. Use the credential you originally enrolled with — no new identity needed.</p>';
    }
    html += '<button id="signInPasskeyBtn" style="width:100%;padding:13px;border:none;border-radius:9px;font-size:0.97rem;font-weight:600;cursor:pointer;background:#6366f1;color:white;margin-bottom:10px">Sign in with your passkey</button>';
    html += '<a href="/connect" style="display:block;text-align:center;padding:13px;border-radius:9px;font-size:0.92rem;background:#1a1a2e;color:#e0e0e8;border:1px solid #2a2a3a;text-decoration:none;margin-bottom:10px">Sign in with your wallet / enroll a new credential</a>';
    html += '<p style="margin-top:14px;font-size:0.8rem;color:#7a818d"><a href="/" style="color:#8a8af0">← Back to the overview</a></p>';
    div.innerHTML = html;
    app.appendChild(div);
    var btn = document.getElementById('signInPasskeyBtn');
    if (btn) btn.onclick = signInWithPasskey;
  }

  // Auth-class error messages from the identity server — when the
  // dashboard sees any of these on a /me-style call, the stored token
  // is stale (expired, sessionEpoch bumped by sign-out-everywhere,
  // TOKEN_SIGNING_KEY rotated/missing, or token revoked) and the user
  // needs to re-authenticate.
  function isAuthError(err) {
    var m = (err && err.message) || '';
    // Cover every reason verifyToken can return: signature mismatch,
    // expired, revoked (sign-out-everywhere), malformed, deleted user.
    return /token not found|invalid bearer|expired|not authenticated|401|user for token not found|token revoked|signature mismatch|token malformed|token payload/i.test(m);
  }

  async function renderDashboard() {
    const app = document.getElementById('app');
    app.innerHTML = '';

    // Top bar
    const top = document.createElement('div');
    top.className = 'topbar';
    top.innerHTML = '<div><h1>Interego</h1><div class="greeting" id="greeting">…</div></div>';
    const so = document.createElement('button');
    so.className = 'signout';
    so.textContent = 'Sign out everywhere';
    so.onclick = signOutEverywhere;
    top.appendChild(so);
    app.appendChild(top);

    const grid = document.createElement('div');
    grid.className = 'grid';
    app.appendChild(grid);

    // ── Identity card ──
    const idCard = document.createElement('div');
    idCard.className = 'card';
    idCard.innerHTML = '<h2>🆔 Your Identity</h2>';
    grid.appendChild(idCard);

    // ── Credentials card ──
    const credCard = document.createElement('div');
    credCard.className = 'card';
    credCard.innerHTML = '<h2>🔐 Registered Credentials</h2><div class="empty">Loading…</div>';
    grid.appendChild(credCard);

    // ── Inbox card (full-width) ──
    const inboxCard = document.createElement('div');
    inboxCard.className = 'card full';
    inboxCard.innerHTML = '<h2>📬 Inbox <span style="color:#888;font-weight:400;font-size:0.85rem">(recent descriptors on your pod, last 7 days)</span></h2><div class="empty">Loading…</div>';
    grid.appendChild(inboxCard);

    // Fetch /me
    let meData;
    try {
      meData = await api(IDENTITY_BASE, '/me');
    } catch (e) {
      // Stale tokens are the common case here — the stored token can
      // fail verification because it expired, the user's sessionEpoch
      // was bumped (sign-out-everywhere), TOKEN_SIGNING_KEY was rotated
      // or fell back to an ephemeral key, or the token was revoked.
      // Surface a sign-in path; never leave the user stranded on a
      // broken dashboard view.
      if (isAuthError(e)) {
        clearToken();
        renderAuthRequired({ reason: 'Your previous session ended. Sign in again with the credential you enrolled — no new identity is created.' });
        return;
      }
      idCard.innerHTML = '<h2>🆔 Your Identity</h2><div class="err">Could not load identity: ' + e.message + '</div>';
      credCard.innerHTML = '<h2>🔐 Registered Credentials</h2><div class="err">' + e.message + '</div>';
      inboxCard.innerHTML = '<h2>📬 Inbox</h2><div class="err">' + e.message + '</div>';
      document.getElementById('greeting').textContent = 'Not signed in';
      // Even on non-auth errors, give the user a way out.
      var retry = document.createElement('button');
      retry.textContent = 'Sign in again';
      retry.style.cssText = 'margin-top:12px;padding:10px 18px;border:none;border-radius:8px;background:#6366f1;color:white;cursor:pointer;font-weight:600';
      retry.onclick = function () { clearToken(); renderAuthRequired(); };
      idCard.appendChild(retry);
      return;
    }
    document.getElementById('greeting').textContent = 'Hi ' + (meData.displayName || meData.userId);

    // Ephemeral evaluation identity (u-try-*) — surface the
    // claim-it-or-lose-it path before the user invests in this pod.
    // The /try response promises the upgrade flow; this is the UI hook.
    if (typeof meData.userId === 'string' && meData.userId.indexOf('u-try-') === 0) {
      const banner = document.createElement('div');
      banner.style.cssText = 'background:#1a1a2e;border:1px solid #6366f1;border-radius:9px;padding:14px 16px;margin-bottom:14px;color:#e0e0e8;font-size:0.92rem;line-height:1.5';
      banner.innerHTML =
        '<strong style="color:#a78bfa">Anonymous evaluation identity.</strong> ' +
        'The janitor reaps this pod ~7 days after creation unless you claim it. Enroll a passkey or wallet to keep the same pod (and everything in it) permanently.' +
        '<br><br>' +
        '<a id="claimBtn" href="/connect" style="display:inline-block;background:#6366f1;color:white;text-decoration:none;padding:9px 16px;border-radius:7px;font-weight:600;font-size:0.92rem">Claim this identity →</a>';
      idCard.appendChild(banner);
      // Pre-fill the addDeviceToken on /connect by passing it in the URL.
      // getToken() returns the current bearer; /connect reads ?claim=...
      // and slots it into the advanced "addDeviceToken" field on load.
      var claimAnchor = document.getElementById('claimBtn');
      var currentToken = getToken();
      if (claimAnchor && currentToken) {
        claimAnchor.setAttribute('href', '/connect?claim=' + encodeURIComponent(currentToken));
      }
    }

    // Populate identity card
    idCard.appendChild(field('Display name', meData.displayName));
    idCard.appendChild(field('Your DID (share with a friend so they can send you context)', meData.did));
    idCard.appendChild(field('WebID', meData.webId));
    idCard.appendChild(field('Pod URL', meData.podHint));
    if (meData.primaryAgentDid) idCard.appendChild(field('Primary agent DID', meData.primaryAgentDid));
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.innerHTML = 'To receive shared descriptors from another user, send them your <strong>DID</strong>. They publish with <code>share_with: ["' + (meData.did.slice(0, 40) + '…') + '"]</code> and the descriptor lands on your pod, encrypted to your key.';
    idCard.appendChild(hint);

    // Fetch /auth-methods/me
    try {
      const am = await api(IDENTITY_BASE, '/auth-methods/me');
      credCard.innerHTML = '<h2>🔐 Registered Credentials</h2>';
      const list = document.createElement('div');
      const total = am.walletAddresses.length + am.webAuthnCredentials.length + am.didKeys.length;
      if (total === 0) {
        list.innerHTML = '<div class="empty">No credentials registered yet.</div>';
      }
      for (const w of am.walletAddresses) {
        const row = document.createElement('div');
        row.className = 'cred-item';
        row.innerHTML = '<div><span class="kind">Wallet</span><span class="val">' + w + '</span></div>';
        list.appendChild(row);
      }
      for (const p of am.webAuthnCredentials) {
        const row = document.createElement('div');
        row.className = 'cred-item';
        row.innerHTML = '<div><span class="kind">Passkey</span><span class="val">' + p.id.slice(0, 20) + '…</span></div><div style="color:#888;font-size:0.78rem">' + (p.createdAt || '').slice(0, 10) + '</div>';
        list.appendChild(row);
      }
      for (const d of am.didKeys) {
        const row = document.createElement('div');
        row.className = 'cred-item';
        row.innerHTML = '<div><span class="kind">DID</span><span class="val">' + d.did.slice(0, 60) + (d.did.length > 60 ? '…' : '') + '</span></div>';
        list.appendChild(row);
      }
      credCard.appendChild(list);
      const addHint = document.createElement('div');
      addHint.className = 'hint';
      addHint.innerHTML = 'Add another device by visiting <a href="/" style="color:#a78bfa">/</a> with this tab\\'s token, or revoke a credential via <code>DELETE /auth-methods/me/...</code>.';
      credCard.appendChild(addHint);
    } catch (e) {
      credCard.innerHTML = '<h2>🔐 Registered Credentials</h2><div class="err">' + e.message + '</div>';
    }

    // Fetch /inbox?pod=podUrl from relay
    try {
      const inbox = await api(RELAY_BASE, '/inbox?pod=' + encodeURIComponent(meData.podHint) + '&limit=20');
      inboxCard.innerHTML = '<h2>📬 Inbox <span style="color:#888;font-weight:400;font-size:0.85rem">(' + inbox.count + ' / ' + inbox.totalOnPod + ' in last 7 days)</span></h2>';
      if (inbox.count === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = inbox.hint || 'Nothing in the last 7 days.';
        inboxCard.appendChild(empty);
      } else {
        for (const ev of inbox.events) {
          const it = document.createElement('div');
          it.className = 'inbox-item';
          const pillClass = ev.modalStatus ? 'pill-' + ev.modalStatus.toLowerCase() : '';
          it.innerHTML =
            '<div>' + (pillClass ? '<span class="pill ' + pillClass + '">' + ev.modalStatus + '</span>' : '') +
            '<span class="url">' + ev.descriptorUrl + '</span></div>' +
            '<div class="meta">' + (ev.validFrom || 'no validFrom') + (ev.trustLevel ? ' · ' + ev.trustLevel : '') + '</div>';
          inboxCard.appendChild(it);
        }
      }
    } catch (e) {
      inboxCard.innerHTML = '<h2>📬 Inbox</h2><div class="err">Could not load inbox: ' + e.message + '</div>';
    }

    // Footer
    const foot = document.createElement('div');
    foot.className = 'footer';
    foot.innerHTML = 'Add the relay to your MCP client: <code style="color:#a78bfa">' + RELAY_BASE + '/sse</code>';
    app.appendChild(foot);
  }

  async function signOutEverywhere() {
    if (!confirm('Sign out everywhere? All your active tokens will be revoked.')) return;
    try {
      await api(IDENTITY_BASE, '/tokens/me/sign-out-everywhere', { method: 'POST' });
    } catch (e) {
      alert('Sign-out failed: ' + e.message);
      return;
    }
    clearToken();
    renderAuthRequired();
  }

  // Boot
  if (!getToken()) {
    renderAuthRequired();
  } else {
    renderDashboard().catch(function (e) {
      console.error(e);
      // Token might be stale — give the user a path forward. isAuthError
      // catches "Token not found" (in-memory store wiped on server
      // restart), "Invalid bearer", "expired", etc.
      if (isAuthError(e)) {
        clearToken();
        renderAuthRequired();
      }
    });
  }
</script>
</body>
</html>`);
});

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
<title>Create your Interego identity</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#0a0a0f; color:#e0e0e8; display:flex; justify-content:center; align-items:center; min-height:100vh; padding:24px; }
  .card { background:#12121a; border:1px solid #2a2a3a; border-radius:14px; padding:32px; max-width:460px; width:100%; }
  h1 { font-size:1.45rem; margin-bottom:8px; letter-spacing:-0.02em; }
  .lede { color:#9aa0ac; margin-bottom:22px; font-size:0.92rem; line-height:1.55; }
  input { width:100%; padding:10px 14px; border:1px solid #2a2a3a; border-radius:8px; background:#0a0a0f; color:#e0e0e8; font-size:0.9rem; margin-bottom:10px; }
  button { width:100%; padding:13px; border:none; border-radius:9px; font-size:0.97rem; font-weight:600; cursor:pointer; }
  .primary { background:#6366f1; color:white; }
  .primary:hover { background:#818cf8; }
  .secondary { background:#1a1a2e; color:#e0e0e8; border:1px solid #2a2a3a; }
  .secondary:hover { background:#22223a; }
  .status { padding:13px 14px; border-radius:8px; margin-top:18px; font-size:0.85rem; line-height:1.5; display:none; }
  .status.success { display:block; background:#0a2a0a; border:1px solid #2a6a2a; color:#6ae66a; }
  .status.error { display:block; background:#2a0a0a; border:1px solid #6a2a2a; color:#e66a6a; }
  .status.info { display:block; background:#0a0a2a; border:1px solid #2a2a6a; color:#8a8af0; }
  .step { margin-bottom:14px; }
  .hint { color:#7a818d; font-size:0.78rem; margin-top:6px; line-height:1.45; }
  details { margin-top:8px; border-top:1px solid #1f1f2e; padding-top:14px; }
  summary { color:#7a818d; font-size:0.82rem; cursor:pointer; }
  details label { display:block; font-size:0.78rem; color:#888; margin:10px 0 4px; }
  code { background:#1a1a2e; padding:2px 6px; border-radius:4px; font-size:0.85rem; }
  .foot { margin-top:20px; font-size:0.82rem; color:#7a818d; }
  .foot a { color:#8a8af0; }
</style>
</head>
<body>
<div class="card">
  <h1>Create your Interego identity</h1>
  <p class="lede">No password, no email, no account to set up. Your identity is a key that stays on your device — Interego only ever sees signatures. Your DID and pod are minted from whatever credential you pick.</p>

  <div class="step">
    <input id="displayName" placeholder="Display name (optional) — e.g. Mark J" />
  </div>

  <div class="step">
    <button class="primary" onclick="passkeyCreate()">Create with a passkey</button>
    <p class="hint">Touch ID, Windows Hello, a security key, or your password manager. Recommended — works on most modern devices, nothing to install.</p>
  </div>

  <div class="step">
    <button class="secondary" onclick="connectMetaMask()">Connect an Ethereum wallet</button>
    <p class="hint">MetaMask, Coinbase Wallet, or a hardware wallet. You sign one message — no transaction, no gas, no cost.</p>
  </div>

  <details class="step">
    <summary>Advanced options</summary>
    <label>Claim a legacy seeded userId (requires a one-time invite token)</label>
    <input id="bootstrapUserId" placeholder="Legacy userId (e.g. markj)" />
    <input id="bootstrapInvite" placeholder="Bootstrap invite token (provided out-of-band)" />
    <label>Add this credential to an account you already have</label>
    <input id="addDeviceToken" placeholder="Bearer token from a previous sign-in" />
  </details>

  <div id="status" class="status"></div>
  <p class="foot">Already enrolled? <a href="/dashboard">Open your dashboard</a>. New here? <a href="/">Start at the overview</a>.</p>
</div>

<script>
const BASE = window.location.origin;

function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
}

// Pre-fill the addDeviceToken field when the user arrived here from
// the dashboard's "Claim this identity" button on a u-try-* identity
// (?claim=<bearer>). Auto-expand the Advanced section so the field
// is visible, and prepend a soft status so the user knows the
// passkey they're about to enroll will bind to the SAME pod they
// were just using (no new identity will be minted).
(function prefillClaim() {
  try {
    var params = new URL(window.location.href).searchParams;
    var claim = params.get('claim');
    if (!claim) return;
    var field = document.getElementById('addDeviceToken');
    if (field) field.value = claim;
    var details = document.querySelector('details.step');
    if (details) details.open = true;
    setStatus('Claiming an evaluation identity — the passkey or wallet you enroll next will bind to your existing u-try-* pod (no new identity is minted).', 'info');
    // Strip the bearer from the URL so it isn't logged in shared
    // bookmarks; preserve any other params.
    params.delete('claim');
    var clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
    window.history.replaceState({}, '', clean);
  } catch { /* best-effort UX, never throw */ }
})();

function onEnrolled(result) {
  const el = document.getElementById('status');
  el.className = 'status success';
  const dash = '/dashboard?token=' + encodeURIComponent(result.token);
  el.innerHTML = "<strong>You're in.</strong> Identity: <code>" + result.userId + "</code>"
    + '<br>Your DID and pod are minted and a bearer token has been issued — '
    + 'your agent or MCP client can use it now.'
    + '<br><a href="' + dash + '" style="color:#6ae66a;text-decoration:underline">Open your dashboard &rarr;</a>';
}

function readAdvanced() {
  const bootstrapUserId = document.getElementById('bootstrapUserId').value.trim();
  const bootstrapInvite = document.getElementById('bootstrapInvite').value.trim();
  const addDeviceToken = document.getElementById('addDeviceToken').value.trim();
  if ((bootstrapUserId && !bootstrapInvite) || (!bootstrapUserId && bootstrapInvite)) {
    throw new Error('Bootstrap userId and invite must both be supplied.');
  }
  return { bootstrapUserId, bootstrapInvite, addDeviceToken };
}

// ── base64url helpers (same conversion the relay's auth page uses) ──
function b64urlToBytes(s) {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(p);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function bytesToB64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}

// ── Passkey (WebAuthn) — the recommended path ──
async function passkeyCreate() {
  if (!window.PublicKeyCredential) {
    setStatus('This browser does not support passkeys. Try the wallet option below.', 'error');
    return;
  }
  let adv;
  try { adv = readAdvanced(); } catch (e) { setStatus(e.message, 'error'); return; }
  const name = document.getElementById('displayName').value.trim() || 'Interego user';
  try {
    setStatus('Creating your passkey...', 'info');
    const body = { name };
    if (adv.bootstrapUserId) { body.bootstrapUserId = adv.bootstrapUserId; body.bootstrapInvite = adv.bootstrapInvite; }
    const headers = { 'Content-Type': 'application/json' };
    if (adv.addDeviceToken) headers['Authorization'] = 'Bearer ' + adv.addDeviceToken;

    const optRes = await fetch(BASE + '/auth/webauthn/register-options', {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!optRes.ok) throw new Error('register-options: ' + await optRes.text());
    const options = await optRes.json();
    options.challenge = b64urlToBytes(options.challenge);
    options.user.id = b64urlToBytes(options.user.id);
    if (options.excludeCredentials) options.excludeCredentials.forEach(c => c.id = b64urlToBytes(c.id));

    setStatus('Confirm with Touch ID / Windows Hello / your security key...', 'info');
    const cred = await navigator.credentials.create({ publicKey: options });
    const resp = {
      id: cred.id,
      rawId: bytesToB64url(new Uint8Array(cred.rawId)),
      type: cred.type,
      response: {
        attestationObject: bytesToB64url(new Uint8Array(cred.response.attestationObject)),
        clientDataJSON: bytesToB64url(new Uint8Array(cred.response.clientDataJSON)),
        transports: (cred.response.getTransports && cred.response.getTransports()) || [],
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
    const regRes = await fetch(BASE + '/auth/webauthn/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: resp }),
    });
    const result = await regRes.json();
    if (regRes.ok && result.userId && result.token) onEnrolled(result);
    else setStatus('Enrollment failed: ' + (result.error || ('HTTP ' + regRes.status)), 'error');
  } catch (err) {
    setStatus('Error: ' + (err && err.message ? err.message : err), 'error');
  }
}

// ── Ethereum wallet (SIWE) ──
async function connectMetaMask() {
  if (!window.ethereum) {
    setStatus('No wallet detected. Install MetaMask, or use the passkey option above.', 'error');
    return;
  }
  let adv;
  try { adv = readAdvanced(); } catch (e) { setStatus(e.message, 'error'); return; }
  const displayName = document.getElementById('displayName').value.trim();

  try {
    setStatus('Requesting wallet connection...', 'info');
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const address = accounts[0];

    const chResp = await fetch(BASE + '/challenges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'siwe' }),
    });
    const { nonce } = await chResp.json();

    const domain = window.location.host;
    const issuedAt = new Date().toISOString();
    const siweMessage = domain + ' wants you to sign in with your Ethereum account:\\n'
      + address + '\\n\\n'
      + 'Sign in to Interego\\n\\n'
      + 'URI: ' + window.location.origin + '\\n'
      + 'Version: 1\\n'
      + 'Chain ID: 1\\n'
      + 'Nonce: ' + nonce + '\\n'
      + 'Issued At: ' + issuedAt;

    setStatus('Please sign the message in your wallet...', 'info');
    const signature = await window.ethereum.request({
      method: 'personal_sign', params: [siweMessage, address],
    });

    const body = { message: siweMessage, signature, nonce };
    if (displayName) body.name = displayName;
    if (adv.bootstrapUserId) { body.bootstrapUserId = adv.bootstrapUserId; body.bootstrapInvite = adv.bootstrapInvite; }
    const headers = { 'Content-Type': 'application/json' };
    if (adv.addDeviceToken) headers['Authorization'] = 'Bearer ' + adv.addDeviceToken;

    const authResp = await fetch(BASE + '/auth/siwe', { method: 'POST', headers, body: JSON.stringify(body) });
    const result = await authResp.json();
    if (authResp.ok && result.userId && result.token) onEnrolled(result);
    else setStatus('Sign-in failed: ' + (result.error || 'Unknown error'), 'error');
  } catch (err) {
    setStatus('Error: ' + (err && err.message ? err.message : err), 'error');
  }
}
</script>
</body>
</html>`);
});

// ── Cold-path pre-warm ──────────────────────────────────────
//
// Several node:crypto + undici code paths lazy-load their underlying
// native modules on the very first call in the process — adding latency
// (3-100ms each) to the first user-facing request that hits them.
// Doing one throwaway call here, after app.listen has fired, warms each
// path so the first real /auth/did call finds them already initialised.
//
// Specifically warmed:
//   * crypto.createHmac SHA-256          (signPayload + parseAndVerifySignature)
//   * crypto.createPublicKey + crypto.verify on a synthetic Ed25519
//     keypair                            (verify path in /auth/did)
//   * crypto.createHash SHA-256          (deriveUserIdFromDid)
//   * undici Agent + TCP/TLS pool to CSS (HEAD probe — no auth, no body)
//
// Failures are swallowed: every code path has a per-request fallback,
// pre-warm is a latency optimisation not a correctness requirement.
function prewarmColdPaths(): void {
  try {
    // HMAC-SHA256 — token signing path.
    crypto.createHmac('sha256', TOKEN_SIGNING_KEY).update('prewarm').digest();
    // SHA-256 — userId derivation path.
    crypto.createHash('sha256').update('prewarm').digest();
    // Ed25519 createPublicKey + verify — /auth/did hot path. Use a tiny
    // throwaway keypair so OpenSSL's EVP_PKEY + ed25519 curve params init.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const sig = crypto.sign(null, Buffer.from('prewarm'), privateKey);
    crypto.verify(null, Buffer.from('prewarm'), publicKey, sig);
  } catch (err) {
    log(`WARN: prewarm crypto failed (non-fatal): ${(err as Error).message}`);
  }
  // Warm the undici TCP/TLS pool to CSS_URL with a HEAD request. Even
  // a 404/405 response is enough to construct the Agent + dial+TLS.
  // Fire-and-forget — we don't want to block boot on CSS reachability.
  void (async () => {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      try {
        await fetch(CSS_URL, { method: 'HEAD', signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // CSS unreachable at boot is fine — the real handler will surface
      // a useful error if/when an /auth/did call actually needs to write.
    }
  })();
}

// ── Start ───────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`Interego Identity Server v2 started on port ${PORT}`);
  log(`Base URL: ${BASE_URL}`);
  log(`CSS URL: ${CSS_URL}`);
  log(`WebAuthn RP: static id=${RP_ID} origin=${RP_ORIGIN}; per-request allowlist=[${[...RP_ALLOWLIST.keys()].join(', ') || '(none)'}]`);
  log(`Auth: decentralized — user credentials stored per-pod at <pod>/auth-methods.jsonld`);
  log(`Bootstrap invites: ${BOOTSTRAP_INVITES.size} configured${BOOTSTRAP_INVITES.size > 0 ? ' (' + [...BOOTSTRAP_INVITES.keys()].join(', ') + ')' : ''}`);
  log(`Endpoints:`);
  log(`  POST /register                        DEPRECATED (410 Gone) — userId is derived, not claimed`);
  log(`  POST /challenges                      Issue proof-of-possession nonce`);
  log(`  POST /auth/siwe                       Sign-In With Ethereum (derives u-eth-<…> or binds via Bearer/invite)`);
  log(`  POST /auth/webauthn/register-options  Begin passkey enrollment (Bearer for add-device, invite for seeded)`);
  log(`  POST /auth/webauthn/register          Finish passkey enrollment (userId derived from credential)`);
  log(`  POST /auth/webauthn/authenticate      Passkey sign-in (user resolved via credentialIndex, not body)`);
  log(`  POST /auth/did                        Ed25519 DID-signature auth (derives u-did-<…> or binds via Bearer/invite)`);
  log(`  POST /tokens/verify                   Verify bearer token`);
  log(`  GET  /users/:id/did.json              User DID document`);
  log(`  GET  /users/:id/profile               WebID profile (Turtle)`);
  log(`  GET  /.well-known/webfinger           WebFinger (RFC 7033)`);
  log(`  GET  /health                          Health check`);

  // Rebuild credential indexes from existing pod data so users who registered
  // before this container restarted are still reachable without re-enrolling.
  // Non-blocking — health checks come up immediately, indexes populate async.
  // The promise is cached at module scope so /auth/did can Promise.race
  // against a small timeout before its didIndex.get() — see
  // awaitInitialIndexWithBudget().
  startInitialIndexRebuild();

  // Pre-warm cold-start surfaces — each runs lazily in node:crypto / undici
  // on the very first use, adding ~3-100ms to the first request that hits it.
  // Doing them here lets the first /auth/did skip the warm-up costs entirely.
  prewarmColdPaths();

  // Janitor — periodic safety net for E2E test users left behind after a
  // crashed run. The Playwright passkey suite calls /users/me/delete in
  // its afterEach for happy-path cleanup; this loop only catches the
  // crash-recovery cases, identified by an agent name matching
  // TEST_AGENT_PATTERN whose owning user is older than TEST_USER_GRACE_MS.
  // The grace window is intentionally larger than the longest possible
  // test run so we never race with an in-flight test.
  const TEST_AGENT_PATTERN = new RegExp(process.env['TEST_AGENT_PATTERN'] ?? '^playwright-passkey-');
  const JANITOR_INTERVAL_MS = parseInt(process.env['JANITOR_INTERVAL_MS'] ?? '300000');     // 5 min
  const TEST_USER_GRACE_MS = parseInt(process.env['TEST_USER_GRACE_MS'] ?? '900000');       // 15 min
  if (JANITOR_INTERVAL_MS > 0) {
    setInterval(async () => {
      const now = Date.now();
      const testCutoff = now - TEST_USER_GRACE_MS;
      const tryCutoff = now - TRY_USER_TTL_MS;
      const allAgents = [...identities.values()].filter(i => i.type === 'agent');
      const toPurge = new Set<string>();
      // Crash-recovery sweep for E2E test users (existing behaviour).
      for (const a of allAgents) {
        if (TEST_AGENT_PATTERN.test(a.id) && a.owner) {
          const owner = identities.get(a.owner);
          if (owner && new Date(owner.createdAt).getTime() < testCutoff) {
            toPurge.add(a.owner);
          }
        }
      }
      // TTL sweep for anonymous `u-try-*` evaluation users. The /try
      // endpoint promises eligibility for reaping in its response; this
      // is the enforcer. CRITICAL EXEMPTION: a u-try-* user who has
      // ALSO enrolled any credential (passkey, wallet, or did:key) has
      // explicitly chosen to claim the identity. The /try response
      // promises that path keeps the pod. Skip them; otherwise we'd
      // delete a user's pod right after they enrolled a passkey to
      // save it — the exact opposite of what the promise says.
      for (const u of identities.values()) {
        if (u.type !== 'user' || !u.id.startsWith('u-try-')) continue;
        if (new Date(u.createdAt).getTime() >= tryCutoff) continue;
        try {
          const methods = await readAuthMethods(u.id, /* allowStale */ true);
          if (hasAnyCredential(methods)) {
            // Claimed. Don't reap — the user has chosen to keep this.
            continue;
          }
        } catch {
          // If we can't even read auth-methods, the pod may already be
          // gone (rebuilt from a partial scan); fall through to reap.
        }
        toPurge.add(u.id);
      }
      if (toPurge.size === 0) return;
      log(`Janitor: purging ${toPurge.size} stale user(s) (test + try-it)`);
      for (const uid of toPurge) {
        deleteUserCompletely(uid).catch(err => log(`Janitor: failed to delete ${uid}: ${(err as Error).message}`));
      }
    }, JANITOR_INTERVAL_MS).unref();
    log(`Janitor: scanning every ${JANITOR_INTERVAL_MS}ms; test grace ${TEST_USER_GRACE_MS}ms (pattern ${TEST_AGENT_PATTERN}); try-it TTL ${TRY_USER_TTL_MS}ms`);
  }
});
