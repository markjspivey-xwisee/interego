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
import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  isSmallOrderEd25519Key,
} from './did-parse.js';
import { startTiming, logTiming, timingEnabled } from './timing.js';
import {
  deriveUserIdFromCredentialId,
  deriveUserIdFromWallet,
  deriveUserIdFromDid,
} from './derive-userid.js';
import { resolveTargetUserId } from './resolve-target-userid.js';
import { claimFirstSignIn, type FirstSignInOutcome } from './first-sign-in.js';
import { publicKeyIdentity, verifyPasskeyAssertion } from './passkey-authentication.js';
import { PodReadError, listPods, loadAccounts, podResourceExists, readPodJson, readPodJsonWithEtag, type AccountLoadReport, type FetchLike } from './account-index.js';
import {
  AccountDeletedError,
  AccountRecordMissingError,
  AuthMethodsConflictError,
  AuthMethodsWriteError,
  NoWrite,
  PlayOwnerUnavailableError,
  PodLockReentryError,
  Write,
  applyUpdate as applyAuthMethodsUpdate,
  settle as settleAuthMethods,
  unknownTopLevelKeys,
  updateAuthMethods as updateAuthMethodsWith,
  type Delta,
  type LiveRecord,
  type UpdateOptions,
  type UpdateResult,
  type WriteResult,
  type WritePrecondition,
  type WriterDeps,
} from './auth-methods-writer.js';
import { AccountIndex, MAX_HOLDERS, enrolledAt } from './credential-index.js';
import { createCredentialDecisions, type Turn } from './credential-decisions.js';
import { createRecordWatchers } from './record-watch.js';
import { createProvisionalPlayProvider } from './provisional-play-provider.js';
import { parsePlayClients } from './provisional-play.js';
import { mountProvisionalPlay } from './provisional-play-routes.js';
import { purgeProvisionalPlayPod } from './provisional-play-cleanup.js';
import {
  SurfaceAgentRestores,
  checkAgentIdForRegistration,
  foreignCanonicalSuffix,
  registryAgentScopes,
  surfaceAgentLabel,
  type DelegationScope,
} from './surface-agent-restore.js';
import { clientIp, createLimiter, limitByIp, rateLimit, sendRateLimited } from './rate-limit.js';
import { forwardAsyncRouteErrors, installProcessSafetyNet, routeErrorHandler } from './route-errors.js';
import { parseSiweMessage, SIWE_DOMAIN_SUFFIX } from './siwe-message.js';

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
const CSS_URL = process.env['CSS_URL'] ?? 'http://css.railway.internal:3456/';
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

// Shared secret guarding POST /tokens/verify. Mirrors the relay's /verify-token
// introspection-secret pattern. Without it the endpoint is an open oracle: anyone holding a
// captured bearer can confirm it is a live identity token and read its bound userId / agentId /
// scope for downstream targeting. Token-forging is already prevented by TOKEN_SIGNING_KEY; this
// is information-disclosure tightening on the verification surface.
//
// Two callers send `Authorization: Bearer <IDENTITY_INTROSPECTION_SECRET>` whenever their own
// copy of the variable is non-empty: the relay (deploy/mcp-relay/server.ts verifyBearerToken,
// which reads it on every call) and css-gate (deploy/css-gate/server.mjs, which reads it at
// start). All three services must hold the same value.
//
// The mode is fixed at startup:
//   - IDENTITY_INTROSPECTION_SECRET set → enforced. ALLOW_OPEN_INTROSPECTION is then ignored,
//     and kept only as the rollback (delete the secret and redeploy → open again).
//   - secret empty and ALLOW_OPEN_INTROSPECTION=1 → open, with a startup warning.
//   - neither → disabled: /tokens/verify answers 401 to everyone, instead of silently being an
//     open oracle that a forgotten env var leaves exposed. Symmetric with how the relay's
//     /verify-token fails closed and how TOKEN_SIGNING_KEY warns loudly when unset.
// The rollout order, the rollback, and the oldest relay and css-gate images that send the
// header are in deploy/identity/AUTH-ARCHITECTURE.md.
const IDENTITY_INTROSPECTION_SECRET = process.env['IDENTITY_INTROSPECTION_SECRET'] ?? '';
const ALLOW_OPEN_INTROSPECTION = process.env['ALLOW_OPEN_INTROSPECTION'] === '1';
type IntrospectionMode = 'enforced' | 'open' | 'disabled';
const INTROSPECTION_MODE: IntrospectionMode = IDENTITY_INTROSPECTION_SECRET ? 'enforced' : ALLOW_OPEN_INTROSPECTION ? 'open' : 'disabled';

// DID sign-in transition. A did-sig challenge carries a message naming this server
// (didSignInMessage), and /auth/did verifies the signature over it. A signature over the bare
// nonce names no server. While this setting is on, such a signature is still accepted and each
// sign-in made with one is logged as identity_did_bare_nonce, so the clients still sending one
// can be found.
// Surrounding whitespace is ignored. Unset, empty or '1': on (the default for now). '0': refused
// with 401. Any other value stops the server here.
const DID_ACCEPT_BARE_NONCE = (() => {
  const raw = (process.env['DID_ACCEPT_BARE_NONCE'] ?? '').trim();
  if (raw === '' || raw === '1') return true;
  if (raw === '0') return false;
  throw new Error(`DID_ACCEPT_BARE_NONCE must be 1 (accept a DID signature over the bare nonce, logged) or 0 (refuse it); got ${JSON.stringify(raw)}`);
})();

// A line break inside a message (a stack trace, or text a caller sent: a display name, a
// surface hint) continues the entry indented, so nothing a caller sends starts a log line. A line
// break is any character a log reader may end a line at: CRLF, LF, CR, VT, FF, U+001C to U+001E,
// U+0085, U+2028 and U+2029 (the set Python's str.splitlines uses; JavaScript and Java end lines
// at some of them). The continuation still carries the caller's text, behind the indent: a line
// is this server's own only when it starts with "[identity] ".
const LOG_LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g;
function log(msg: string) { console.log(`[identity] ${msg.replace(LOG_LINE_BREAK, '\n    ')}`); }

/** A request value for one log line: printable ASCII, at most `max` characters, JSON-quoted; '-' when absent. */
function logValue(value: unknown, max = 120): string {
  return typeof value === 'string' && value !== '' ? JSON.stringify(value.slice(0, max).replace(/[^\x20-\x7e]/g, '?')) : '-';
}

// A failure nothing awaited is logged and the server keeps serving; see route-errors.ts.
installProcessSafetyNet(log);

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

/**
 * Whether `token` is the invite configured for `userId`, without spending it, and `userId` has
 * an account id's shape (no slash, no dot-segment). A bootstrap claim reads the seeded account's
 * pod only after this (readBootstrapTarget), so a wrong invite touches no pod. The read used to
 * come first, and on a 404 it wrote an empty document (no read writes now): any caller could
 * put a document into the pod of an account not yet opened, `x/../<id>` reaching any account's.
 */
function bootstrapInviteMatches(userId: unknown, token: unknown): boolean {
  if (typeof userId !== 'string' || typeof token !== 'string' || !token || !ACCOUNT_ID_SHAPE.test(userId)) return false;
  const expected = BOOTSTRAP_INVITES.get(userId);
  if (!expected) return false;
  // Constant-time comparison so the response-time signal can't be used to
  // enumerate the invite token character-by-character. `timingSafeEqual`
  // requires equal-length buffers, so a length mismatch is the short-circuit.
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyBootstrapInvite(userId: string, token: string | undefined): boolean {
  if (!bootstrapInviteMatches(userId, token)) return false;
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
 * working. /auth/did logs a deprecation marker for the fallback; a
 * future relay version will flip this to a hard 400.
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
      return { ok: true, publicKey: Buffer.from(publicKey), format: 'base64url-legacy' };
    }
  } catch { /* fall through */ }
  return {
    ok: false,
    error: 'could not decode did:key public key — tried W3C base58btc(0xed 0x01 || key) (the spec form) and legacy base64url(rawKey); neither yielded a 32-byte Ed25519 public key',
  };
}

/**
 * The raw 32-byte Ed25519 key in a `publicKeyMultibase` value: the W3C form
 * 'z' + base58btc(0xed 0x01 || key) first, then the legacy 'z' + base64url(key) this server
 * once emitted, which clients still send and pods still hold. Null when neither yields a key.
 */
function decodeEd25519PublicKeyMultibase(value: unknown): { publicKey: Buffer; format: 'base58btc' | 'base64url-legacy' } | null {
  if (typeof value !== 'string' || !value.startsWith('z')) return null;
  const encoded = value.slice(1);
  try {
    const decoded = base58btcDecode(encoded);
    if (decoded.length === 34
      && decoded[0] === ED25519_MULTICODEC[0]
      && decoded[1] === ED25519_MULTICODEC[1]) {
      return { publicKey: Buffer.from(decoded.subarray(2)), format: 'base58btc' };
    }
  } catch { /* fall through */ }
  try {
    const legacy = Buffer.from(encoded, 'base64url');
    if (legacy.length >= 32) return { publicKey: Buffer.from(legacy.subarray(legacy.length - 32)), format: 'base64url-legacy' };
  } catch { /* fall through */ }
  return null;
}

/**
 * Whether an account lists `did` with this key. A did:key is its own key. Any other DID was
 * verified against a key the caller supplied, so the account must hold that same key for it;
 * keys are compared as raw bytes, so either encoding of one key matches.
 */
function accountHoldsDidKey(m: AuthMethods, did: string, keyFromDid: boolean, publicKeyRaw: Buffer): boolean {
  return m.didKeys.some(k => k.did === did
    && (keyFromDid || decodeEd25519PublicKeyMultibase(k.publicKeyMultibase)?.publicKey.equals(publicKeyRaw) === true));
}

/**
 * The refusals of /auth/did. A DID that is not a did:key gets one answer whether or not some
 * account lists it, so the answer does not say which DIDs are registered here.
 */
const DID_NOT_REGISTERED = 'This DID is not registered. Sign in with an existing credential for this account and add this DID from there.';
const DID_KEY_NOT_REGISTERED = 'This DID is not registered with this key, and only a did:key can open an account by itself. Sign in with an existing credential and add this DID from there.';
const DID_SIGNATURE_FAILED = 'Ed25519 signature verification failed. Sign, with the DID\'s key, the exact UTF-8 bytes of the message that POST /challenges with {"purpose":"did-sig"} returned beside this nonce (LF line breaks, nothing added or removed). The challenge is spent; request a new one.';
const DID_BARE_NONCE_REFUSED = 'This signature is over the bare nonce, which names no server. POST /challenges with {"purpose":"did-sig"} returns a message beside a new nonce: sign that message\'s exact UTF-8 bytes and send the signature with its nonce. The challenge is spent; request a new one.';
// A key of small order (isSmallOrderEd25519Key), from a did:key or publicKeyMultibase: a signature
// by it can be made without a private key, so it proves nothing.
const DID_KEY_NOT_USABLE = 'This is not a usable Ed25519 key: it is a point of small order, for which a signature proves nothing. Use a key made by an Ed25519 key generator. The challenge is spent; request a new one.';

function generateEd25519(): KeyPair {
  // Ed25519 — signing / authentication / assertionMethod.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const edSpki = publicKey.export({ type: 'spki', format: 'der' });
  const edRaw = edSpki.subarray(edSpki.length - 32);
  const publicKeyMultibase = encodeEd25519Multibase(edRaw);

  // X25519 — keyAgreement (envelope-recipient key for cross-pod E2EE
  // sharing). Per-identity so each agent has its own encryption key
  // (FIX 6 with FIX 3). The raw 32 bytes are the end of the 44-byte SPKI
  // DER, as for Ed25519 above. Not via JWK: on Node 20 a JWK export of a
  // freshly generated key holds the key pair's mutex while it allocates,
  // a GC there can run the finished keygen job's destructor, which takes
  // the same mutex, and the thread deadlocks with itself (see
  // tests/public-jwk.ts). The SPKI export takes no lock.
  const { publicKey: x25519PublicKey, privateKey: x25519PrivateKey } = crypto.generateKeyPairSync('x25519');
  const xSpki = x25519PublicKey.export({ type: 'spki', format: 'der' });
  if (xSpki.length !== 44) {
    throw new Error(`X25519 SPKI must be 44 bytes, got ${xSpki.length}`);
  }
  const xRaw = xSpki.subarray(xSpki.length - 32);
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
  // the source of truth. See readAuthMethods() / updateAuthMethods() below.
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
    rpId?: string;
    rpOrigin?: string;
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
  /** Provider-signed immutable Play owner anchor; not an enrolled human credential. */
  provisionalPlayAnchor?: string;
  provisionalPlayReceipts?: Array<{ hash: string; expiresAt: number }>;
  /**
   * Set (to the day, YYYY-MM-DD) on the tombstone a deleted account leaves at this URL. Its
   * derived id may never be opened again; see deletionTombstone.
   */
  deletedAt?: string;
  /**
   * Set (true) on the tombstone the janitor writes when it purges a Play owner, until every other
   * resource of the pod is deleted (purgePlayOwner): a purge that fails part-way is retried from
   * it, at the next pass and after a restart (loadAccountFromPod). A deletion's tombstone has none.
   */
  provisionalPlayPurgePending?: true;
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
  provisionalPlay?: ProvisionalTokenGrant;
}

interface ProvisionalTokenGrant {
  audience: string;
  proofKeyThumbprint: string;
  expiresAt: number;
}

// In-memory stores. `identities` and `keys` are cheap-to-rebuild bookkeeping
// (user/agent shells + Ed25519 keys for DID documents). The user-authoritative
// credential data (wallets, passkeys, DID keys) does NOT live here — it lives
// in each user's Solid pod as auth-methods.jsonld. `walletIndex`,
// `credentialIndex` and `didIndex` are read-through caches built from pod scans on startup
// so SIWE/passkey/DID flows can look up "which users hold this wallet/credential/DID?"
// without scanning every pod on every call. Each maps a credential to EVERY account that
// lists it (credential-index.ts): with one account per credential, whichever loaded last
// won, so anyone who put a victim's (non-secret) passkey id on an account of their own made
// the victim's sign-ins fail on and off. A sign-in tries the holders in a stable order, and
// sees only the accounts loaded so far: while any is not, a credential no loaded account
// holds opens no account, and a passkey or wallet joins none (refuseWhileLoading).
const identities: Map<string, Identity> = new Map();
const keys: Map<string, KeyPair> = new Map();

// lowercased wallet address → userIds
const walletIndex = new AccountIndex();
// webauthn credential id → userIds
const credentialIndex = new AccountIndex();
// did → userIds
const didIndex = new AccountIndex();

// Per-user auth-methods cache with a short TTL, read for decisions (which accounts a credential
// may sign in to, the epoch a token is checked against). Stale-while-revalidate: an expired
// entry is refreshed from the pod, and a non-critical read gets the stale value meanwhile.
//
// TTL reasoning (security audit Sec #13): the previous 60s TTL opened a window where a
// passkey/wallet revoked DIRECTLY on the pod (operator SSH-ing in, or a parallel
// identity-server replica writing to the same pod) wouldn't be reflected here for up to 60
// seconds. Reduced to 10s, which still gives a meaningful hit ratio (an auth flow does several
// reads in close succession).
//
// Nothing writes the pod from this copy. Every write of auth-methods.jsonld reads the record
// from the pod under the account's lock, applies only its own change, writes it conditionally
// and only then installs what it wrote here (updateAuthMethods, auth-methods-writer.ts). The
// copy and the indexes are changed only by installAuthMethods, together, from a record read
// or written under the lock (and by loadAccountFromPod, which checks recordWatchers instead).
const authMethodsCache: Map<string, { value: AuthMethods; fetchedAt: number }> = new Map();
const AUTH_METHODS_TTL_MS = 10 * 1000;

// ── Per-userId lock on auth-methods.jsonld ──────────────────
//
// Keyed by userId because every write of an account's record targets the same
// `<CSS_URL><userId>/auth-methods.jsonld`. One holder per account at a time: every write
// (updateAuthMethods, claimFirstSignInOnPod, Play provisioning, deletion) and every refresh of
// this server's copy runs inside it. The lock is not re-entrant: a call that already holds an
// account's lock and asks for it again would wait for itself for ever, so it throws
// PodLockReentryError at once instead (a bug, answered 500). podLockContext carries, through
// the async calls made inside a lock, which accounts' locks they run under; each entry's
// `held` turns false when its lock is released, so work started inside a lock that asks for
// the same lock after the release (a background refresh, say) is not mistaken for re-entry.
const identityPodWriteMutexes = new Map<string, Promise<unknown>>();
const podLockContext = new AsyncLocalStorage<ReadonlyMap<string, { held: boolean }>>();

// Accounts deleted in this process. deleteUserCompletely adds the id under the account's lock
// once the pod has the tombstone (every id but a Play owner's, which may be provisioned again);
// from then on every write of that id except the tombstone is refused
// (writeLive, applyUpdate) and nothing it reads is installed (installAuthMethods). Every writer
// reads the record under the same lock, so it runs wholly before the tombstone (which is then
// written over its result) or after this mark. Process-local, like the lock: a second replica writing
// the same pod is not covered (see AUTH-ARCHITECTURE.md). An operator re-opens an id by
// editing its tombstone into a record that lists a credential (see the Deletion tombstone
// block) and restarts the process to clear this.
const deletedUserIds = new Set<string>();

// Play owners whose purge by the janitor closed the account (its tombstone written, marked
// provisionalPlayPurgePending) but did not delete every other resource of the pod: a DELETE failed,
// or the process stopped. The janitor tries each again at its next pass (purgePlayOwner), and the
// startup scan finds the marked tombstone again after a restart (loadAccountFromPod), so a purge
// that fails part-way is retried, never dropped: the account, closed, is no longer in `identities`,
// which is all the janitor's sweep walks.
const unfinishedPlayPurges = new Set<string>();

// Play owners whose deletion (POST /users/me/delete) the pod may have taken without confirming it,
// nothing having settled it, so the route answered 503 and asked for a retry with the same token:
// each id with its guest deadline (playGuestDeadline). Until then a guest token can make that retry,
// and a fresh grant can provision the owner again over the tombstone (provisional-play-store.ts), so
// the janitor leaves such an owner as it is, in memory and on the pod, for the retry to finish
// (unfinishedDeletion). After it, the janitor finishes the deletion itself, as the retry would have:
// the agent registry DELETE, which no provisioning can race any more. Its purge used to find the
// tombstone unmarked and only forget the owner, so the retry was refused and the registry stayed.
// Process-local: after a restart such a tombstone loads no account, and its registry stays, as for
// any account whose deletion was answered 503 and not retried before the restart.
const unconfirmedPlayDeletions = new Map<string, number>();

/** Whether a Play owner's deletion this process answered 503 may still be retried by its guest (unconfirmedPlayDeletions). */
function awaitsGuestRetry(userId: string): boolean {
  return (unconfirmedPlayDeletions.get(userId) ?? 0) > Date.now();
}

/**
 * The guest deadline (ms) of the Play owner whose record is `m`: its anchor's, after which no guest
 * token verifies and no grant provisions the owner again. Where the anchor cannot be opened, the
 * longest an anchor can be valid (seven days, provisional-play.ts) from now.
 */
function playGuestDeadline(m: Readonly<AuthMethods> | null): number {
  try { return provisionalPlay.open(m?.provisionalPlayAnchor, true).expiresAt * 1000; } catch { return Date.now() + 604_800_000; }
}

async function withIdentityPodMutex<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const outer = podLockContext.getStore();
  if (outer?.get(userId)?.held) throw new PodLockReentryError(`${userId}: this request already holds the account's lock`);
  const prev = identityPodWriteMutexes.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Chain so the next caller waits for THIS call's gate, not the prior
  // one. Errors from prior callers must not propagate to the next caller.
  const chained = prev.then(() => gate, () => gate);
  identityPodWriteMutexes.set(userId, chained);
  const token = { held: true };
  try {
    await prev.catch(() => undefined);
    return await podLockContext.run(new Map([...(outer ?? []), [userId, token]]), fn);
  } finally {
    token.held = false;
    release();
    queueMicrotask(() => {
      if (identityPodWriteMutexes.get(userId) === chained) identityPodWriteMutexes.delete(userId);
    });
  }
}

/** Throws unless this call runs inside the account's lock. */
function assertLockHeld(userId: string): void {
  if (podLockContext.getStore()?.get(userId)?.held !== true) throw new Error(`${userId}: the account's lock is not held`);
}

// Told of every install, and of every expire (a write that failed and could not be settled). An
// unlocked loader (loadAccountFromPod) whose read overlapped either does not install what it read,
// and a refresh that queued behind a writer reuses what the writer installed (never an expired
// copy) instead of reading again. A watch lasts as long as its read (record-watch.ts): nothing is
// kept for an account nobody is reading.
const recordWatchers = createRecordWatchers();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/**
 * Make `m` this server's copy of the account: the cache entry and the sign-in indexes, set
 * together. Called only with a record read from the pod or written to it under the account's
 * lock (or by an unlocked loader whose read nothing overlapped). The copy is frozen, so no
 * caller can change it in place. A deleted account's record never goes back in, except its
 * tombstone (which indexes nothing).
 */
function installAuthMethods(userId: string, m: AuthMethods): AuthMethods {
  const value = deepFreeze(structuredClone(m));
  if (deletedUserIds.has(userId) && !isTombstone(value)) return value;
  authMethodsCache.set(userId, { value, fetchedAt: Date.now() });
  rebuildIndexesForUser(userId, value);
  recordWatchers.changed(userId);
  return value;
}

/**
 * Mark this server's copy stale (keeping it and its index entries): the next reader goes to the
 * pod. Its watchers see a change, as for an install: a write that failed may have landed, so an
 * unlocked load whose read began before it (loadAccountFromPod) must not install that read.
 */
function expireAuthMethods(userId: string): void {
  const cached = authMethodsCache.get(userId);
  if (cached) authMethodsCache.set(userId, { value: cached.value, fetchedAt: 0 });
  recordWatchers.changed(userId);
}

function podAuthMethodsUrl(userId: string): string {
  return `${CSS_URL}${userId}/auth-methods.jsonld`;
}

// Reads of auth-methods documents and of the pod listing give up after this long, so one
// hung read is a failure to retry, not a worker that never returns (which would leave the
// account index incomplete for good).
const POD_READ_TIMEOUT_MS = 30_000;
const podFetch: FetchLike = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(POD_READ_TIMEOUT_MS) });
// Reads and writes of an account's auth-methods.jsonld made under its lock (readLive, writeLive)
// give up sooner: one that never answered would hold every sign-in, enrolment and
// sign-out of that account behind it. A writer makes at most two such requests in a row that a
// pod can leave unanswered: its write, then one request of the settlement that follows a failed
// write (a read, the fence that writes the record back, a read: auth-methods-writer.ts settle),
// which stops at the first request that fails. So a pod that never answers holds an account's
// lock for at most 15 s when the read hangs and 30 s when the write does. A create's container
// PUT has a timeout of its own, and a create whose container PUT gets no answer sends no
// document, so a create takes no longer than an update on a pod that never answers (a fence that
// is a create counts its container PUT as the fence: the settlement stops there,
// AuthMethodsWriteError.stalled); on one that answers slowly, every request may take up to 15 s.
// A 412 makes the writer read and write again (three reads in all), and a settlement makes up to
// three requests, which takes longer only while the pod keeps answering; a Play owner's
// provisioning and the janitor's purge of one make requests of their own under the lock, 15 s
// each (provisional-play-*.ts, and deleteUserCompletely's delete of the owner's agent registry),
// and so do the HEAD probes a first sign-in makes before it creates a derived id
// (deletedBeforeTombstones): a probe that hangs ends the claim, as a read does.
const POD_RECORD_TIMEOUT_MS = 15_000;
const recordFetch: FetchLike = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(POD_RECORD_TIMEOUT_MS) });

/**
 * The account's record as the pod holds it now, with the document as parsed (for the keys
 * this server does not read) and its ETag. `methods` is null when the pod has no
 * auth-methods document (404). ★ THROWS (PodReadError) WHEN THE POD CANNOT BE READ, or its
 * document is not JSON: an empty record is a claim ("this account has no credentials"), and
 * one cached after a timed-out read once deleted a user's passkeys, wallets and DIDs from the
 * sign-in indexes (account-index.ts). It never writes: a read used to create an empty document
 * when there was none, for any caller, and a write built on it could re-create an account.
 */
async function readLive(userId: string): Promise<LiveRecord<AuthMethods>> {
  const { body, etag } = await readPodJsonWithEtag(recordFetch, podAuthMethodsUrl(userId));
  if (body === null) return { methods: null, raw: null, etag: null };
  return { methods: normaliseAuthMethods(body, userId), raw: body, etag };
}

/**
 * Write the account's document. `pre` is the condition it is sent with: If-None-Match: * when
 * the pod had none ('absent', after the account's container is created), If-Match on the ETag
 * read ('match'), or unconditionally when the pod sent no ETag ('none'). Returns
 * 'precondition-failed' on a 412 (someone wrote since the read). Any other failure throws
 * AuthMethodsWriteError and logs identity_authmethods_write_failed. A deleted account takes
 * no write but its tombstone, and a tombstone takes no credential (AccountDeletedError).
 */
async function writeLive(userId: string, doc: AuthMethods, pre: WritePrecondition, context: string): Promise<WriteResult> {
  if ((isTombstone(doc) && hasAnyCredential(doc)) || (deletedUserIds.has(userId) && !isTombstone(doc))) {
    throw new AccountDeletedError(`${userId}: ${ACCOUNT_DELETED_MESSAGE}`);
  }
  const url = podAuthMethodsUrl(userId);
  const failed = (status: string, detail: string, unknownOutcome: boolean, unanswered = false): AuthMethodsWriteError => {
    log(`WARN identity_authmethods_write_failed userId=${userId} context=${context} status=${status}`);
    return new AuthMethodsWriteError(`PUT ${url} failed: ${detail}`, unknownOutcome, unanswered);
  };
  if (pre.kind === 'absent') {
    // The account's container first (idempotent; best-effort, as the document PUT says whether
    // it worked), with a timeout of its own. It used to share the document's 15 s, so a create
    // failed on a pod taking more than about 7.5 s per PUT, where an update failed only past 15 s.
    const container = AbortSignal.timeout(POD_RECORD_TIMEOUT_MS);
    try {
      await fetch(`${CSS_URL}${userId}/`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/turtle', 'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' },
        body: '',
        signal: container,
      });
    } catch { /* best-effort */ }
    // No answer for the container: the document is not sent (a pod that does not answer holds
    // the lock no longer for a create than for an update), so the pod does not have it. `stalled`:
    // a settlement whose fence this was stops here, as for a fence the pod did not answer.
    if (container.aborted) {
      const err = failed('timeout', 'the container PUT got no answer within the write timeout', false);
      err.stalled = true;
      throw err;
    }
  }
  let r: Response;
  try {
    r = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/ld+json',
        ...(pre.kind === 'absent' ? { 'If-None-Match': '*' } : pre.kind === 'match' ? { 'If-Match': pre.etag } : {}),
      },
      body: JSON.stringify(doc, null, 2),
      signal: AbortSignal.timeout(POD_RECORD_TIMEOUT_MS),
    });
  } catch (err) {
    // No answer: the pod may still apply it (AuthMethodsWriteError.unanswered; the writer settles it).
    const timedOut = (err as Error).name === 'TimeoutError';
    throw failed(timedOut ? 'timeout' : 'network', (err as Error).message, true, true);
  }
  if (r.status === 412) return 'precondition-failed';
  if (r.ok || r.status === 205) return 'ok';
  throw failed(String(r.status), `${r.status} ${r.statusText}`, r.status >= 500);
}

/**
 * After a write sent on `pre` that failed (`err`), for a caller writing outside applyUpdate: the
 * pod may hold the new record (a timeout, or a store that applied it and then answered 500) or
 * the old one, and one it never answered may still apply. Still under the lock, settle it
 * (auth-methods-writer.ts settle: a fence where the record has not moved) and install what it
 * holds then, so this server's copy agrees with the pod whatever happened; if that fails, mark
 * the copy stale and set `err.pending`. Returns what the pod holds (null: no document), or
 * undefined when it could not be settled.
 */
async function reconcileAfterWriteFailure(userId: string, err: unknown, pre: WritePrecondition, context: string): Promise<AuthMethods | null | undefined> {
  const pending = err instanceof AuthMethodsWriteError && err.unanswered ? pre : undefined;
  try {
    const now = await settleAuthMethods(authMethodsWriter, userId, pending, context);
    installAuthMethods(userId, now.methods ?? emptyAuthMethods(userId));
    return now.methods;
  } catch {
    expireAuthMethods(userId);
    if (pending && err instanceof AuthMethodsWriteError) err.pending = pending;
    return undefined;
  }
}

/**
 * The account's record as the pod holds it now, read under its lock (after every write queued
 * for it before this call) and made this server's copy and indexes. `pending`: the condition of
 * an earlier write of it the pod never answered (AuthMethodsWriteError.pending), which is settled
 * first (a fence where the record has not moved), so the record returned is one that write can
 * no longer change. Throws when the pod cannot be read or that write cannot be settled. Unlike a
 * refresh it never answers with a copy, nor joins a read already in flight.
 *
 * An account deleted in this process is settled as it is, with nothing read or written. Its
 * deletion already moved the record off every state a write still pending there could apply to:
 * the tombstone is written on the ETag read, or with If-None-Match: * where there was no document
 * (a write that landed first makes it read again), and stays (deleteUserCompletely never removes
 * one, for any id; a Play owner's, which is never marked deleted here, is replaced only by its
 * provisioning, and written again only by the janitor's purge that marked it: finishPlayPurge
 * clearing the mark, and the fence a settlement writes back when the pod does not answer that.
 * Each is written on the tombstone's ETag, which a pending write cannot match either).
 * A pending write is conditional on an ETag the record had before the tombstone, or on there
 * being no document; the tombstone is a document with an ETag of its own, so neither can hold
 * again, and no such write can land afterwards, before a restart or after one. (The record is
 * never removed: Community Solid Server 7.2 applies a write sent with If-Match on an ETag to a
 * missing document, so a removed record is off no such state. A `u-try-` account's used to be
 * removed, and this comment said that a removed record could take no such write: an add recorded
 * against it landed after the 200, and the deleted account loaded at the next restart.) Nothing
 * read from the account is installed here anyway (installAuthMethods), and writeLive refuses every
 * write of it but the tombstone, so a fence could never be sent. It used to be tried all the same,
 * and a write of a wallet or DID recorded against a deleted `u-try-` account could never be
 * settled: that credential answered 503 until the process restarted.
 */
async function readAccountNow(userId: string, pending?: WritePrecondition): Promise<AuthMethods> {
  return withIdentityPodMutex(userId, async () => {
    if (deletedUserIds.has(userId)) return emptyAuthMethods(userId);
    return installAuthMethods(userId, (await settleAuthMethods(authMethodsWriter, userId, pending, 'unconfirmed-write')).methods ?? emptyAuthMethods(userId));
  });
}

// ── One decision at a time about each wallet and DID ────────
//
// Which account a wallet or DID signs in to is decided from the sign-in indexes, and a write that
// puts one on an account (a bearer's add, /wallet/link, a first sign-in) reaches those indexes
// only once the pod has it. /auth/siwe, /auth/did and /wallet/link therefore decide and write in
// the credential's turn (credential-decisions.ts), keyed `wallet:<address>` or `did:<did>`: a
// sign-in made while the credential is being added to an account waits for that write, and then
// signs in to the account it went to, instead of opening the account derived from the credential
// beside it (which would keep the credential's sign-ins for good, being preferred). A write whose
// outcome nothing could settle (auth-methods-writer.ts settle), an add or a removal, is recorded
// with the condition it was sent on, and the credential's next turn settles that account before
// deciding (503 while it cannot). Removals of a wallet or DID run in its turn too, so they settle
// such a record before they read (DELETE /auth-methods/me/wallet, /did). A turn waits at most 30 s
// for the ones before it (then 503, logged as identity_credential_turn_busy). A DID that is not a
// did:key takes its turn only for a request that can write it, or once a write of it is recorded
// as unconfirmed (see /auth/did).
//
// Records are settled in the background too (UNCONFIRMED_SETTLE_MS): a pass starts at most once a
// minute, and not while one is running, and visits the recorded credentials one after another,
// each in its turn, so one whose credential never comes back (a throwaway wallet's first sign-in
// that met a failing pod) does not stay for the life of the process. On pods that do not answer
// a pass takes about 15 s per record, so a record is visited once per pass, not once a minute. A
// pass that leaves records unsettled logs identity_unconfirmed_writes_unsettled. At most 10,000
// are held (UNCONFIRMED_WRITES_MAX), and at most half of them for first sign-ins of an account
// derived from the credential (the records a request with no bearer and no invite can make, so a
// flood of them leaves the other half for writes made with a bearer or an invite); past that a
// new one is not recorded, the request still answers 503 "may or may not have been saved", and
// identity_unconfirmed_writes_full is logged. A bearer's add that was not recorded is told to add
// it again with the same bearer (which reads the account under its lock, and adds the credential
// or finds it there), not to sign in with it: such a sign-in would not settle that account first.
const CREDENTIAL_TURN_WAIT_MS = 30_000;
const UNCONFIRMED_WRITES_MAX = parseInt(process.env['UNCONFIRMED_WRITES_MAX'] ?? '10000');
const UNCONFIRMED_FIRST_SIGN_INS_MAX = Math.floor(UNCONFIRMED_WRITES_MAX / 2);
const UNCONFIRMED_SETTLE_MS = parseInt(process.env['UNCONFIRMED_SETTLE_MS'] ?? '60000');
const credentialDecisions = createCredentialDecisions({
  readAccount: (userId, pending) => readAccountNow(userId, pending as WritePrecondition | undefined),
  waitMs: CREDENTIAL_TURN_WAIT_MS,
  maxRecorded: UNCONFIRMED_WRITES_MAX,
  maxFirstSignIns: UNCONFIRMED_FIRST_SIGN_INS_MAX,
});
const walletCredential = (address: string) => `wallet:${address.toLowerCase()}`;
const didCredential = (did: string) => `did:${did}`;

/**
 * Record a write of `credential` on `userId` that nothing could settle (credentialDecisions
 * .unconfirmed), in the credential's turn. `firstSignIn`: a first sign-in of the account derived
 * from the credential, which counts against the smaller bound. When the records are full, nothing
 * is recorded and an operator line says so (no credential value), and this returns false: a
 * bearer's add then tells the caller to add it again rather than to sign in with it.
 */
function recordUnconfirmed(credential: string, userId: string, pending: WritePrecondition | undefined, firstSignIn = false): boolean {
  const recording = credentialDecisions.unconfirmed(credential, userId, pending, { firstSignIn });
  if (recording === 'recorded') return true;
  log(recording === 'full'
    ? `WARN identity_unconfirmed_writes_full max=${UNCONFIRMED_WRITES_MAX} scope=all userId=${userId}`
    : `WARN identity_unconfirmed_writes_full max=${UNCONFIRMED_FIRST_SIGN_INS_MAX} scope=first-sign-ins userId=${userId}`);
  return false;
}

if (UNCONFIRMED_SETTLE_MS > 0) {
  let sweeping = false;
  setInterval(() => {
    if (sweeping || credentialDecisions.recorded() === 0) return;
    sweeping = true;
    void credentialDecisions.settleRecorded()
      .then(left => { if (left > 0) log(`WARN identity_unconfirmed_writes_unsettled left=${left}`); })
      .catch(err => log(`WARN: settling unconfirmed writes failed: ${(err as Error).message}`))
      .finally(() => { sweeping = false; });
  }, UNCONFIRMED_SETTLE_MS).unref();
}

/**
 * The answer when a credential's turn decided nothing: another request held it too long, or an
 * unconfirmed write's account could not be read or that write settled. Both are logged: a turn
 * held that long is a pod read or write that hangs inside it, and every later request for the
 * credential gets this 503 until it ends (`identity_credential_turn_busy`, with no credential
 * value, is the line to alert on); the other logs why the settlement failed.
 */
function refuseCredentialTurn(res: express.Response, turn: Exclude<Turn<unknown>, { kind: 'decided' }>, credential: 'wallet' | 'DID'): void {
  if (turn.kind === 'busy') {
    log(`WARN identity_credential_turn_busy kind=${credential === 'wallet' ? 'wallet' : 'did'} waitedMs=${CREDENTIAL_TURN_WAIT_MS}`);
    res.status(503).json({
      error: `Another request for this ${credential} is still being answered`,
      detail: `A sign-in or add of this ${credential} made before this one has not finished. Nothing was changed; try again in a minute.`,
    });
    return;
  }
  log(`WARN: ${credential} decision deferred: an unconfirmed write to ${turn.userId} could not be settled: ${turn.reason}`);
  res.status(503).json({
    error: 'Could not read this account just now',
    detail: `An earlier write of this ${credential} to an account was not confirmed, and what that account holds could not be confirmed yet. Nothing was changed; try again in a minute.`,
  });
}

/**
 * A bearer's add of a wallet or DID (`credential`) to `userId` whose write failed: whether the pod
 * lists it on the account now. Only a write whose outcome is unknown (a 5xx, a timeout) can have
 * landed. The writer settled the record under the lock (AuthMethodsWriteError.podRecord: final,
 * as a write the pod never answered was fenced); when that failed, the account is settled once
 * more here, so what the pod holds reaches the sign-in indexes now rather than whenever something
 * next reads this account (a sign-in with the credential never would: it reads only the accounts
 * the indexes name). When that fails as well, the write is recorded as unconfirmed, with the
 * condition a write the pod never answered was sent on, and the credential's next turn settles
 * the account before deciding ('undetermined'; 'unrecorded' when the records were full, and
 * nothing was recorded). Called in the credential's turn.
 */
async function credentialAfterFailedAdd(
  credential: string,
  userId: string,
  err: unknown,
  lists: (m: AuthMethods) => boolean,
): Promise<'listed' | 'not-listed' | 'undetermined' | 'unrecorded'> {
  if (!(err instanceof AuthMethodsWriteError) || !err.unknownOutcome) return 'not-listed';
  let onPod = err.podRecord as AuthMethods | null | undefined;
  if (onPod === undefined) {
    try {
      onPod = await readAccountNow(userId, err.pending);
    } catch (readErr) {
      log(`WARN: add to ${userId} unconfirmed, and the account cannot be read: ${(readErr as Error).message}`);
      return recordUnconfirmed(credential, userId, err.pending) ? 'undetermined' : 'unrecorded';
    }
  }
  return onPod && !isTombstone(onPod) && lists(onPod) ? 'listed' : 'not-listed';
}

/**
 * The answer to a bearer's add of a wallet or DID whose write the pod did not confirm, but which
 * may have landed. 'undetermined': recorded, so the credential's next sign-in settles the account
 * first. 'unrecorded': the records were full, so a sign-in with it would decide on indexes that
 * may not show it (and open the account derived from it); the safe next step is the same add with
 * the same bearer, which reads the account under its lock and adds the credential, or finds it.
 */
function refuseUnconfirmedAdd(res: express.Response, credential: 'wallet' | 'DID', onPod: 'listed' | 'undetermined' | 'unrecorded'): void {
  res.status(503).json({
    error: `Your ${credential} could not be confirmed as added`,
    detail: onPod === 'listed'
      ? `The pod did not confirm the write, but it lists this ${credential} on your account now: sign in with it. No session was issued here.`
      : onPod === 'undetermined'
        ? `The pod did not confirm the write, and could not be read after it, so it may or may not have been saved. Try signing in with this ${credential} in a minute. No session was issued here.`
        : `The pod did not confirm the write, and could not be read after it, so it may or may not have been saved. Add it again with the same bearer token in a minute: that adds it if it was not saved, and signs in to your account if it was. Until then, do not sign in with this ${credential} alone. No session was issued here.`,
  });
}

/**
 * Whether a change whose write failed (`err`) is on the pod: 'landed' when the record the writer
 * settled under the lock (AuthMethodsWriteError.podRecord: final, as a write the pod never answered
 * was fenced first) `shows` it; 'undetermined' when nothing could settle it; 'not-landed' for a
 * refusal the pod answered, or a record without the change (or a tombstone).
 */
function changeOnPod(err: unknown, shows: (m: AuthMethods) => boolean): 'landed' | 'not-landed' | 'undetermined' {
  if (!(err instanceof AuthMethodsWriteError) || !err.unknownOutcome) return 'not-landed';
  const onPod = err.podRecord as AuthMethods | null | undefined;
  if (onPod === undefined) return 'undetermined';
  return onPod && !isTombstone(onPod) && shows(onPod) ? 'landed' : 'not-landed';
}

/**
 * The answer to a change whose write the pod did not confirm, and that nothing could settle: a
 * removal, a sign-out-everywhere, a passkey sign-in's counter. `again` says what sending the same
 * request again does, which is safe whether or not the write was saved. The answer used to point
 * at GET /auth-methods/me, which could not tell: while the pod is unreadable it answers this
 * server's copy from before the write, and it is a plain read that a write still pending at the
 * pod can overtake.
 */
function refuseUndeterminedChange(res: express.Response, error: string, again: string): void {
  res.status(503).json({
    error,
    detail: `The pod did not confirm the write, and could not be read after it, so it may or may not have been saved. ${again}`,
  });
}
const REMOVE_AGAIN = 'Sending the same removal again is safe: it removes the credential if it is still there, and answers 404 if it is not.';

/** An unclaimed Play owner may change only while its anchor opens to its id; a claimed one always. */
function playOwnerWritable(userId: string, m: AuthMethods): boolean {
  if (hasAnyCredential(m)) return true;
  try { return provisionalPlay.open(m.provisionalPlayAnchor).userId === userId; } catch { return false; }
}

/**
 * Whether the janitor visits a Play owner whose record is `m` (purgePlayOwner): unclaimed (no
 * credential) with its guest deadline passed, which it closes and purges; or closed already (a
 * tombstone), which it does not close again: one its own purge left marked (an unfinished purge)
 * it finishes, and a deletion's (the other instance's, whose memory was not cleared here) it only
 * forgets, writing and deleting nothing of the pod; one this process answered 503 it finishes once
 * its guest deadline has passed (unconfirmedPlayDeletions). A record whose anchor cannot be opened
 * is kept. As a deletion's `stillDeletable` it is never asked about a tombstone
 * (deleteUserCompletely finds those first).
 */
function playOwnerPurgeable(m: AuthMethods): boolean {
  if (isTombstone(m)) return true;
  if (hasAnyCredential(m)) return false;
  try { return provisionalPlay.open(m.provisionalPlayAnchor, true).expiresAt * 1000 <= Date.now(); } catch { return false; }
}

const authMethodsWriter: WriterDeps<AuthMethods> = {
  lock: (userId, fn) => withIdentityPodMutex(userId, fn),
  assertLockHeld: userId => assertLockHeld(userId),
  readLive: userId => readLive(userId),
  writeLive: (userId, doc, pre, context) => writeLive(userId, doc, pre, context),
  install: (userId, m) => { installAuthMethods(userId, m); },
  expire: userId => expireAuthMethods(userId),
  isDeleted: userId => deletedUserIds.has(userId),
  isTombstone: m => isTombstone(m),
  empty: userId => emptyAuthMethods(userId),
  playGuard: (userId, m) => playOwnerWritable(userId, m),
  conflicted: (userId, context, attempts) => logWriteConflict(userId, context, attempts),
};

/** A write that met another writer's change at every attempt: the request fails (503 or 500). */
function logWriteConflict(userId: string, context: string, attempts: number): void {
  log(`WARN identity_authmethods_write_conflict userId=${userId} context=${context} attempts=${attempts}`);
}

/**
 * Change an account's record as the pod holds it (auth-methods-writer.ts): under the account's
 * lock, read it, apply `delta`, write it conditionally, then install what was written.
 */
async function updateAuthMethods(userId: string, context: string, delta: Delta<AuthMethods>, opts: UpdateOptions = {}): Promise<UpdateResult<AuthMethods>> {
  return updateAuthMethodsWith(authMethodsWriter, userId, context, delta, opts);
}

/** updateAuthMethods for a caller that already holds the account's lock (deleteUserCompletely). */
async function applyUpdate(userId: string, context: string, delta: Delta<AuthMethods>, opts: UpdateOptions = {}): Promise<UpdateResult<AuthMethods>> {
  return applyAuthMethodsUpdate(authMethodsWriter, userId, context, delta, opts);
}

// ── Accounts deleted before deletions left a tombstone ──────
//
// Until 2026-10-26 POST /users/me/delete removed auth-methods.jsonld and <pod>/agents and kept
// every other file: the container, the relay's profile/card and .acl files, the descriptors
// and the .well-known/context-graphs manifest, the inbox. Such a pod has no tombstone, so a
// derived id signing in to it again was created over it and inherited all of that (and its
// did:web name). Before a derived id is created, its pod is asked whether such an account used
// it, and only when the pod holds no credentials and the credential may create an account:
//   - u-pk-: any container at all. An owner's authenticator never presents the same credential
//     id twice (every registration makes a new one), so no owner is turned away, and a
//     container exists only because an account with this id was written, or attempted, before.
//   - u-eth- / u-did-: <pod>/agents is gone (only a deletion removes it) while the relay's
//     profile/card remains. The relay writes that card only when it creates agents, at its
//     first touch of a pod after this server issued a token for that very id (/oauth/verify,
//     or lazy init for the token's own pod), and only since 2026-06-04, so the card shows that
//     an account here used the pod. Nothing else in the pod does: every publish() writes the
//     manifest (.well-known/context-graphs) and context-graphs/, and a bridge holding the gate's
//     write secret publishes into a signer's own u-eth- pod with no account here at all (a
//     vertical's self-enrolment, credential issuance, ontology publishing), so counting them
//     locked such a wallet out at its first sign-in. A pod whose agents registry is still there
//     lost only its sign-in record (a write before 2026-10-24 that never landed); its owner,
//     holding the same wallet or key, signs in to it as before. The inbox does not count either:
//     anyone can deliver to a pod, and these ids follow from a public address or key. A pod
//     without the card shows nothing and opens again, as it did before, and that is more pods
//     than the deletion date suggests: the relay wrote agents (publish path, /oauth/verify) long
//     before it wrote cards and never adds a card to a pod that has agents, so a pod whose agents
//     predates 2026-06-04 has none whenever it was deleted, nor has a pod that never connected to
//     the relay (AUTH-ARCHITECTURE.md says how an operator finds them).
// Yes: the sign-in is refused as deleted (409) and the tombstone written (identity_deleted_
// before_tombstone in the log), so the next attempt reads it and asks nothing. A probe that
// cannot be answered is 'unreadable' (503), never a new account. A brand-new account pays one
// HEAD; a live account (a pod listing a credential) is never asked.
const DERIVED_USER_ID = /^u-(pk|eth|did)-[0-9a-f]{12}$/;

/**
 * What in `userId`'s pod shows that an account deleted before deletions left a tombstone used
 * it, or null when nothing does. `existing` is the pod's record without credentials, or null
 * when it has none. Throws PodReadError when a probe cannot be answered.
 */
async function deletedBeforeTombstones(userId: string, existing: AuthMethods | null): Promise<string | null> {
  const pod = `${CSS_URL}${userId}/`;
  // Asked under the account's lock, so bounded like the record's own reads (POD_RECORD_TIMEOUT_MS).
  // A record lies in its container, so only a pod without one is asked whether it exists.
  if (existing === null && !(await podResourceExists(recordFetch, pod))) return null;
  if (userId.startsWith('u-pk-')) return existing === null ? 'container' : 'auth-methods.jsonld without credentials';
  const [agents, card] = await Promise.all([
    podResourceExists(recordFetch, `${pod}agents`),
    podResourceExists(recordFetch, `${pod}profile/card`),
  ]);
  return !agents && card ? 'profile/card' : null;
}

/**
 * claimFirstSignIn's answer. On 'unconfirmed': `undetermined` when the write failed and nothing
 * could settle what the pod holds (auth-methods-writer.ts settle), with `pending`, the condition
 * of a write the pod never answered, for a later settle (credentialDecisions.unconfirmed);
 * otherwise `onPod`, what the pod holds now, final (null: no document; undefined when no write of
 * this claim failed, as when every attempt met a document written under it). `fenced`: the failed
 * write was one the pod never answered, so settling it may have written the record back (or an
 * empty one where there was none).
 */
type FirstSignInOnPod =
  | Exclude<FirstSignInOutcome<AuthMethods>, { kind: 'unconfirmed' }>
  | { readonly kind: 'unconfirmed'; readonly reason: string; readonly undetermined: boolean;
      readonly onPod?: AuthMethods | null; readonly pending?: WritePrecondition; readonly fenced?: boolean };

/**
 * A first-time wallet or DID sign-in to `userId` (first-sign-in.ts): read the account's pod
 * under its lock and create the account only if the pod holds no credentials, so a credential
 * the indexes missed never replaces the ones the account already has. The create keeps what
 * the document holds besides (its session epoch, and keys this server does not read), and is
 * conditional on what was read. A 'returning' account is loaded (identity shell, copy and
 * indexes) inside the lock; a 'refused' or 'deleted' one has its record installed as read.
 *
 * A write that fails may have landed all the same (a 5xx after the store applied it, a
 * timeout), and one the pod never answered may land later still, so what the pod holds once it
 * is settled decides, never the failed request (reconcileAfterWriteFailure: a fence where the
 * record has not moved). Settled under the lock, a record that `holds` the credential is
 * 'created': whoever wrote it, the account lists the credential that signed, so this is a
 * sign-in to it. When that cannot be settled, the account is settled again once the lock is
 * released, and a record there that holds the credential is 'returning', with the shell a load
 * seeds (a seeded account has none before). Only when neither settles is the outcome
 * 'unconfirmed' with `undetermined` set. A write the pod refused (a 4xx) did not land, so it is
 * 'unconfirmed' without `undetermined` even when the read after it failed: the route says nothing
 * was changed, and nothing is recorded for the credential. A passkey registration's `holds` is
 * never true (a passkey is never signed in to by registering it), so its route decides on `onPod`
 * itself. An id deleted in this process whose record was put back without a tombstone (out of
 * band) is 'deleted': writeLive refuses every write of it but the tombstone.
 *
 * `derived`: the id was derived from the credential presented (not a bootstrap invite's seeded
 * id, whose files predate its credentials by design), so before it is created its pod is asked
 * whether an account deleted before tombstones used it (deletedBeforeTombstones). When it was,
 * the outcome is 'deleted' and the tombstone is written conditionally on the claim's own read,
 * the state the probes judged: If-None-Match: * where that read found no record, If-Match on its
 * ETag where it found one. A record another writer made or changed since is never replaced: the
 * write gets 412, nothing is written, the record the pod holds then is installed (so a credential
 * on it reaches the sign-in indexes), and the next sign-in asks again. What is written is
 * installed only once the pod has it.
 */
async function claimFirstSignInOnPod(
  userId: string,
  agentId: string,
  displayName: string,
  holds: (methods: AuthMethods) => boolean,
  add: (methods: AuthMethods) => void,
  mayCreate = true,
  derived = false,
): Promise<FirstSignInOnPod> {
  const probe = derived && DERIVED_USER_ID.test(userId);
  let evidence: string | null = null;
  // Set when this claim's write failed in a way that may have landed (a 5xx, a timeout): what the
  // pod held once settled (undefined: unsettled), and, for a write the pod never answered that
  // could not be settled, the condition it was sent on. A write the pod refused with a 4xx did
  // not land, whatever a read after it says (refusedWrite): "nothing was changed" is true then.
  let failedWrite = false;
  let refusedWrite = false;
  // writeLive refused the write itself: the id was deleted in this process, and only its
  // tombstone may be written (a record put back over it out of band, say).
  let deletedHere = false;
  let onPod: AuthMethods | null | undefined;
  let pending: WritePrecondition | undefined;
  let unanswered = false;
  const outcome = await withIdentityPodMutex(userId, async () => {
    let live: LiveRecord<AuthMethods> = { methods: null, raw: null, etag: null };
    // Set once `retire` has run: what it wrote (or read after a refused write) is installed, not `live`.
    let retired = false;
    const outcome = await claimFirstSignIn<AuthMethods>({
      mayCreate,
      closed: isTombstone,
      conflicted: attempts => logWriteConflict(userId, 'first-sign-in', attempts),
      ...(probe ? {
        vacated: async (existing: AuthMethods | null) => {
          evidence = await deletedBeforeTombstones(userId, existing);
          return evidence !== null;
        },
        // Still under the lock. Conditional on the claim's own read (`live`, the read the probes
        // were asked about), so nothing another writer made or changed since is replaced.
        retire: async () => {
          retired = true;
          log(`WARN identity_deleted_before_tombstone userId=${userId} evidence=${evidence} refused=deleted`);
          const tombstone = deletionTombstone(userId, live.methods?.sessionEpoch ?? 0);
          const pre: WritePrecondition = live.methods === null ? { kind: 'absent' } : live.etag ? { kind: 'match', etag: live.etag } : { kind: 'none' };
          let result: WriteResult;
          try {
            result = await writeLive(userId, tombstone, pre, 'deleted-before-tombstone');
          } catch (err) {
            // Written or not, it is the tombstone for the state the probes judged; the next sign-in reads what the pod holds.
            expireAuthMethods(userId);
            log(`WARN: tombstone for ${userId} not confirmed (the next sign-in asks again): ${(err as Error).message}`);
            throw err;
          }
          if (result === 'ok') {
            installAuthMethods(userId, tombstone);
            return;
          }
          log(`WARN: tombstone for ${userId} not written: the record changed since it was read (the next sign-in asks again)`);
          try {
            installAuthMethods(userId, (await readLive(userId)).methods ?? emptyAuthMethods(userId));
          } catch {
            expireAuthMethods(userId);
          }
        },
      } : {}),
      read: async () => {
        live = await readLive(userId);
        return live.methods;
      },
      holds,
      build: existing => {
        // A document without credentials keeps what it records (its session epoch above all). A name
        // that is only the id (an empty record a settlement's fence left) takes the one asked for,
        // as a passkey registration's does: it used to keep the id.
        const methods = existing ? { ...structuredClone(existing), agentId } : emptyAuthMethods(userId, displayName, agentId);
        if (!methods.name || methods.name === userId) methods.name = displayName;
        add(methods);
        return methods;
      },
      create: async (methods, ifAbsent) => {
        const doc = { ...unknownTopLevelKeys(live.raw), ...methods } as AuthMethods;
        const pre: WritePrecondition = ifAbsent ? { kind: 'absent' } : live.etag ? { kind: 'match', etag: live.etag } : { kind: 'none' };
        let result: WriteResult;
        try {
          result = await writeLive(userId, doc, pre, 'first-sign-in');
        } catch (err) {
          if (err instanceof AccountDeletedError) { deletedHere = true; throw err; }
          const mayHaveLanded = !(err instanceof AuthMethodsWriteError) || err.unknownOutcome;
          // Still read (and installed), so this server holds what the pod holds.
          const now = await reconcileAfterWriteFailure(userId, err, pre, 'first-sign-in');
          if (!mayHaveLanded) {
            refusedWrite = true;
            throw err;
          }
          failedWrite = true;
          onPod = now;
          pending = err instanceof AuthMethodsWriteError ? err.pending : undefined;
          unanswered = err instanceof AuthMethodsWriteError && err.unanswered;
          if (onPod && !isTombstone(onPod) && holds(onPod)) {
            log(`WARN: first sign-in to ${userId}: the pod took the write without confirming it (${(err as Error).message})`);
            return true;
          }
          throw err;
        }
        if (result === 'precondition-failed') return false;
        installAuthMethods(userId, doc);
        return true;
      },
    });
    if (outcome.kind === 'returning') {
      if (!deletedUserIds.has(userId) && !isTombstone(outcome.methods)) hydrateFromAuthMethods(userId, outcome.methods);
      installAuthMethods(userId, outcome.methods);
    } else if ((outcome.kind === 'refused' || outcome.kind === 'deleted') && live.methods && !retired) {
      installAuthMethods(userId, live.methods);
    }
    return outcome;
  });
  if (outcome.kind !== 'unconfirmed') return outcome;
  if (deletedHere) return { kind: 'deleted' };
  if (!failedWrite || refusedWrite) return { ...outcome, undetermined: false };
  if (onPod !== undefined) return { ...outcome, undetermined: false, onPod, fenced: unanswered };
  // Not settled under the lock: once more now, after the lock was released.
  let current: AuthMethods;
  try {
    current = await readAccountNow(userId, pending);
  } catch {
    return { ...outcome, undetermined: true, ...(pending ? { pending } : {}) };
  }
  if (!isTombstone(current) && holds(current)) {
    if (!deletedUserIds.has(userId)) hydrateFromAuthMethods(userId, current);
    log(`WARN: first sign-in to ${userId}: the pod took the write without confirming it, found on reading the account again`);
    return { kind: 'returning', methods: current };
  }
  return { ...outcome, undetermined: false, onPod: current, fenced: unanswered };
}

/**
 * The answer to a first-time wallet or DID sign-in that read nothing, or whose write the pod did
 * not take (claimFirstSignInOnPod). A bootstrap invite spent on it (`bootstrapUserId`) is given
 * back, or every retry is refused as "already consumed": nothing is on the seeded account, or the
 * pod could not say, and a credential that did land unseen refuses any other claim of the account
 * anyway (the retry reads the pod first, and the credential's own next sign-in settles it first).
 * "Nothing was changed" is said only when nothing was written: a read that failed before any
 * write, or a failed write the pod answered (a refusal, a 5xx) that the read after it shows did not
 * land. A write the pod never answered, settled without the credential, did not land either (it is
 * fenced first, so it can no longer land), but the fence may have written the record back, or
 * created an empty one where there was none (`fenced`): the answer says that the sign-in was not
 * saved, not that nothing was changed. Neither says the account could not be read: it was.
 */
function refuseUnfinishedFirstSignIn(
  res: express.Response,
  outcome: { kind: 'unreadable' } | { kind: 'unconfirmed'; undetermined: boolean; fenced?: boolean },
  bootstrapUserId: string | undefined,
): void {
  if (bootstrapUserId) CONSUMED_INVITES.delete(bootstrapUserId);
  if (outcome.kind === 'unconfirmed' && outcome.undetermined) {
    res.status(503).json({
      error: 'Your sign-in could not be confirmed as saved',
      detail: 'The pod did not confirm the write, and could not be read after it, so it may or may not have been saved. Try signing in again in a minute.',
    });
    return;
  }
  if (outcome.kind === 'unconfirmed' && outcome.fenced) {
    res.status(503).json({
      error: 'Your sign-in was not saved',
      detail: 'The pod did not take the write, so the credential was not added to the account. Try signing in again in a minute.',
    });
    return;
  }
  res.status(503).json(outcome.kind === 'unreadable'
    ? { error: 'Could not read this account just now', detail: 'The pod holding this account did not answer. Nothing was changed; try signing in again in a minute.' }
    : { error: 'Your sign-in was not saved', detail: 'The pod did not take the write. Nothing was changed; try signing in again in a minute.' });
}

/** The error answers every account write shares: an unreadable pod, a deleted account, no record. */
function sendAccountWriteRefusal(res: express.Response, err: unknown): boolean {
  if (err instanceof PodReadError) {
    log(`WARN: account write refused, record unreadable: ${err.message}`);
    res.status(503).json({ error: 'Could not read this account just now', detail: 'Nothing was changed; try again in a minute.' });
    return true;
  }
  if (err instanceof AccountDeletedError) {
    res.status(409).json({ error: ACCOUNT_DELETED_MESSAGE });
    return true;
  }
  if (err instanceof AccountRecordMissingError) {
    // Not "User for token not found" (an unknown token): the token's account is known here, and
    // its record was removed from its pod by something other than this server.
    res.status(404).json({
      error: "This account's sign-in record is missing from its pod",
      detail: 'Nothing was written: this server does not re-create a record removed outside it.',
    });
    return true;
  }
  return false;
}

/**
 * The one way a route changes an account's credentials or session epoch. `update` edits a copy
 * of the record as the pod holds it (it may run more than once, so it resets anything it
 * records elsewhere at its start), and returns false to write nothing. Resolves once the pod
 * has the change; throws (and the route says so) when it does not. Every account, a Play
 * owner's included, goes through the one writer (updateAuthMethods): a 412 re-reads and applies
 * the change again; a Play owner's record is never created, and an unclaimed owner is changed
 * only while its anchor still opens to its id (playOwnerWritable, checked under the lock on the
 * record read). `absent`: what to do when the pod has no document ('refuse' by default:
 * AccountRecordMissingError).
 */
async function commitCredentialEnrollment(
  userId: string,
  context: string,
  update: (methods: AuthMethods) => boolean | void,
  opts: { absent?: 'refuse' | 'create' } = {},
): Promise<UpdateResult<AuthMethods>> {
  return updateAuthMethods(userId, context, draft => update(draft) === false ? NoWrite('unchanged') : Write,
    { absent: opts.absent ?? 'refuse' });
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
  // dance writeLive does for the user container itself.
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
    // Same fire-and-forget guard as putPodProfileCard.
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

// `userId` is the pod the document was read from, and that pod's account is the one it
// describes, whatever its own userId field says. A document planted in another account's pod
// (a bootstrap pre-read once wrote one for any caller) seeded the identity under its field's
// id, and after each restart that pod's account could not sign in (its wallet got a 500).
function normaliseAuthMethods(raw: unknown, userId: string): AuthMethods {
  const base = emptyAuthMethods(userId);
  if (!raw || typeof raw !== 'object') return base;
  const src = raw as Partial<AuthMethods>;
  return {
    ...base,
    name: typeof src.name === 'string' ? src.name : userId,
    ...(src.agentId ? { agentId: src.agentId } : {}),
    walletAddresses: Array.isArray(src.walletAddresses)
      ? src.walletAddresses.filter((w): w is string => typeof w === 'string').map(w => w.toLowerCase())
      : [],
    webAuthnCredentials: Array.isArray(src.webAuthnCredentials) ? src.webAuthnCredentials : [],
    didKeys: Array.isArray(src.didKeys) ? src.didKeys : [],
    ...(Number.isInteger(src.sessionEpoch) ? { sessionEpoch: src.sessionEpoch } : {}),
    ...(typeof src.provisionalPlayAnchor === 'string' ? { provisionalPlayAnchor: src.provisionalPlayAnchor } : {}),
    ...(Array.isArray(src.provisionalPlayReceipts) ? { provisionalPlayReceipts: src.provisionalPlayReceipts } : {}),
    ...(typeof src.deletedAt === 'string' ? { deletedAt: src.deletedAt } : {}),
    ...(src.provisionalPlayPurgePending === true ? { provisionalPlayPurgePending: true as const } : {}),
  };
}

// ── Deletion tombstone ──────────────────────────────────────
//
// Deleting an account cannot empty its pod: the container and its other files (descriptors,
// inbox, profile) stay, and the relay maps a userId straight to that container. A derived id
// (u-pk-/u-eth-/u-did-) is a function of a credential, and passkey credential ids are not
// secret, so re-creating the account would hand those files, and the did:web name others
// hold for it, to whoever presents an old credential, and a fresh document at session epoch
// 0 would make the deleted account's unexpired tokens verify again. So deletion overwrites
// auth-methods.jsonld with this tombstone instead of removing it: the URL every first
// sign-in already reads, in the pod (the identity server keeps nothing). It records the id
// (already the path), the day, and an epoch above every token issued; no name, agent or
// credential. It is permanent. An operator re-opens an id by editing the file into a record
// that lists the credential to admit, without deletedAt and with its sessionEpoch kept (so
// the old tokens stay refused), and restarting the process (deletedUserIds).
// Deletions before 2026-10-26 left no tombstone: they removed auth-methods.jsonld and
// <pod>/agents and kept the rest. A derived id whose pod still looks like that is refused at
// its first sign-in and given its tombstone then (deletedBeforeTombstones). A deletion since
// leaves the pod looking the same once its tombstone is gone, so for u-pk- (while its
// container exists) and for u-eth-/u-did- with the relay's card (while agents is gone),
// deleting the file does not re-open the id: the tombstone comes back at the next try. A
// u-eth-/u-did- pod without the card (its agents predates 2026-06-04, or it never connected
// to the relay) shows nothing then: deleting the file and restarting re-opens the id at
// epoch 0, and the deleted account's unexpired tokens verify again. Editing is the only way.
const ACCOUNT_DELETED_MESSAGE = 'This account was deleted and cannot be re-opened; register a new credential';

function isTombstone(m: AuthMethods): boolean {
  return typeof m.deletedAt === 'string';
}

function deletionTombstone(userId: string, sessionEpoch: number, purgePending = false): AuthMethods {
  return { ...emptyAuthMethods(userId), sessionEpoch: sessionEpoch + 1, deletedAt: new Date().toISOString().slice(0, 10),
    ...(purgePending ? { provisionalPlayPurgePending: true as const } : {}) };
}

// One refresh of an account's copy at a time: every reader that finds the entry stale while a
// refresh is in flight waits for that one, rather than queueing another locked read of the pod.
const refreshing = new Map<string, Promise<AuthMethods>>();

/**
 * Read the account's record from the pod, under its lock, and install it. A refresh that waited
 * for the lock behind a writer reuses what the writer installed (the generation moved since the
 * caller found the entry stale, and the copy is fresh: a writer that could only expire it
 * installed nothing) rather than reading the pod again. Throws when the pod cannot be read;
 * installs nothing then.
 */
function refreshAuthMethods(userId: string): Promise<AuthMethods> {
  if (podLockContext.getStore()?.get(userId)?.held) {
    return Promise.reject(new PodLockReentryError(`${userId}: a read of this server's copy inside the account's own lock`));
  }
  const inFlight = refreshing.get(userId);
  if (inFlight) return inFlight;
  const watch = recordWatchers.watch(userId);
  const refresh = withIdentityPodMutex(userId, async () => {
    const cached = authMethodsCache.get(userId);
    if (cached && watch.changed && Date.now() - cached.fetchedAt < AUTH_METHODS_TTL_MS) return cached.value;
    const live = await readLive(userId);
    return installAuthMethods(userId, live.methods ?? emptyAuthMethods(userId));
  }).finally(() => {
    watch.done();
    if (refreshing.get(userId) === refresh) refreshing.delete(userId);
  });
  refreshing.set(userId, refresh);
  return refresh;
}

/**
 * This server's copy of the account's record, for a decision (never as the base of a write:
 * writers read the pod themselves). Under 10 s old it is returned as is; otherwise it is
 * refreshed from the pod (allowStale: in the background, the stale copy answering meanwhile).
 * Never throws and never creates: a pod that cannot be read keeps the copy there was, and with
 * none the caller gets an empty record that is neither cached nor indexed, so the next read
 * goes back to the pod instead of trusting the failure.
 *
 * A copy marked stale by a write that failed and could not be settled (expireAuthMethods,
 * fetchedAt 0) may be older than a change the pod took, so an allowStale reader waits for the
 * read too, and gets the copy only when that read fails. It used to get the copy at once: a
 * sign-out-everywhere the pod applied without answering in time answered 503, and the token it
 * ended still verified at its next use.
 */
async function readAuthMethods(userId: string, allowStale = false): Promise<AuthMethods> {
  const cached = authMethodsCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < AUTH_METHODS_TTL_MS) return cached.value;
  if (cached && allowStale && cached.fetchedAt !== 0) {
    // A refresh that fails keeps what we had: an unreadable pod is not an account without credentials.
    void refreshAuthMethods(userId).catch(err => log(`WARN: kept cached auth-methods for ${userId}: ${(err as Error).message}`));
    return cached.value;
  }
  try {
    return await refreshAuthMethods(userId);
  } catch (err) {
    log(`WARN: could not read auth-methods for ${userId}: ${(err as Error).message}`);
    return cached ? cached.value : emptyAuthMethods(userId);
  }
}

/**
 * The account's record for a sign-in that decides on what it lists (which account a wallet or
 * DID signs in to): this server's copy while it is under 10 s old, otherwise the record read
 * from the pod now. 'unreadable' when the copy is older and the pod cannot be read: a sign-in
 * is never decided on a copy older than 10 s, so a credential removed by the other instance or
 * by hand signs in here for at most 10 s after this server last read the account, whether or
 * not the pod answers now, and an account this server cannot see is answered with "try again"
 * (503), never read as one without credentials.
 */
async function readForDecision(userId: string): Promise<AuthMethods | 'unreadable'> {
  const fresh = (): AuthMethods | undefined => {
    const cached = authMethodsCache.get(userId);
    return cached && Date.now() - cached.fetchedAt < AUTH_METHODS_TTL_MS ? cached.value : undefined;
  };
  const copy = fresh();
  if (copy) return copy;
  try {
    return await refreshAuthMethods(userId);
  } catch (err) {
    log(`WARN: could not read auth-methods for ${userId}: ${(err as Error).message}`);
    // A record a writer installed meanwhile, under the lock, is as good as a read.
    return fresh() ?? 'unreadable';
  }
}

// Replaces this account's entries (a credential it no longer lists drops out) and leaves every
// other holder alone. A deleted or tombstoned account holds nothing, so it is never a candidate.
function rebuildIndexesForUser(userId: string, m: AuthMethods): void {
  const closed = isTombstone(m) || deletedUserIds.has(userId);
  const shared: Array<[string, number[]]> = [
    ['wallet', walletIndex.setUser(userId, closed ? [] : m.walletAddresses.map(a => a.toLowerCase()))],
    // A passkey is registered with 'none' attestation, so its public key is whatever the
    // registrant sends, and a public key is not secret: anyone can register a copy of the
    // owner's under the owner's id. Rank holders by when the server enrolled them, so among
    // the accounts loaded the owner's is tried before a later copy. While the owner's account
    // is not loaded a copy is tried alone, so no copy is enrolled then (refuseWhileLoading);
    // a copy enrolled before that check, or during a deploy's overlap, is still tried alone
    // until the owner's account loads, unless the owner is the account derived from the id,
    // which a sign-in loads first (AUTH-ARCHITECTURE.md, While accounts are loading).
    ['webauthn', credentialIndex.setUser(userId, closed ? [] : m.webAuthnCredentials.map(c => [c.id, enrolledAt(c.createdAt)] as const))],
    // A DID that is not a did:key is bound only with a key /auth/did saw sign this server's
    // nonce, so another account lists it with a key of its own, which never verifies the
    // owner's signature. Ranking by enrolment keeps the owner among the first MAX_HOLDERS
    // tried however many such bindings pile up.
    ['did', didIndex.setUser(userId, closed ? [] : m.didKeys.map(k => k.did.startsWith('did:key:') ? k.did : [k.did, enrolledAt(k.createdAt)] as const))],
  ];
  // Counts only, never an id. A second holder of a passkey may hold a copy of its key; of a
  // did:web, a key of its own; of a did:key, the key's holder bound it; of a wallet, see
  // walletAccount.
  for (const [kind, counts] of shared) {
    for (const holders of counts) log(`WARN identity_credential_multi_holder kind=${kind} holders=${holders}`);
  }
}

function removeFromIndexes(userId: string): void {
  walletIndex.removeUser(userId);
  credentialIndex.removeUser(userId);
  didIndex.removeUser(userId);
}

// The CSS root lists every pod as a direct sub-container, which makes the pod layer —
// not a database — the authoritative user registry (account-index.ts listPods).

// Hydrate an identity shell from a pod's auth-methods.jsonld when we don't
// have an in-memory entry yet (common after a container restart). Also
// creates a default agent if auth-methods references one, so issueTokenResponse
// has something to issue for. Idempotent — skipped if the user is already in
// the identities map. Seeded under `userId`, the pod the record was read from.
function hydrateFromAuthMethods(userId: string, m: AuthMethods): void {
  if (identities.has(userId)) return;
  seedIdentity(userId, 'user', m.name);
  // Hydration runs at boot when the in-memory identities map is empty and
  // we're recovering shells from pods. If the pod's auth-methods.jsonld
  // explicitly names an agent, honour it. Otherwise seed the surface-neutral
  // placeholder `mcp-client-<userId>` — the relay's ensureSurfaceAgent() will
  // mint the real per-surface agent (chatgpt-<userId>, claude-code-vscode-<userId>,
  // claude-mobile-<userId>, etc.) on top when an actual client connects.
  // Never default to a Claude-specific slug here: not every user came in via
  // a Claude surface, and a stale `claude-mobile-<userId>` would mis-label
  // descriptors written by the placeholder agent before the surface agent appears.
  const agentId = m.agentId ?? `mcp-client-${userId}`;
  if (!identities.has(agentId)) {
    seedIdentity(agentId, 'agent', `MCP client (${m.name})`, userId, 'ReadWrite');
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
    return {
      agentId: `${surfaceAgent}-${userId}`,
      label: surfaceAgentLabel(surfaceAgent, displayName),
    };
  }
  return {
    agentId: `mcp-client-${userId}`,
    label: `MCP client (${displayName})`,
  };
}

// Load one account from its pod into the identities map, the auth-methods cache and the
// sign-in indexes. Returns false for a pod with no credentials (a service pod, an inert
// pim:Storage shell, a deleted user); throws PodReadError when the pod cannot be read, so
// the caller retries it rather than forgetting the account.
//
// Not under the account's lock: the startup scan and an on-demand load must not queue behind
// a slow writer, and a load that read the record before a deletion must not wait for the
// deletion and then put the account back. Instead, a read that an install overlapped (a
// writer's, a refresh's) is not installed: what was installed meanwhile is newer than what
// this read, so the account is reported as that record has it.
async function loadAccountFromPod(userId: string): Promise<boolean> {
  const watch = recordWatchers.watch(userId);
  let body: unknown;
  try {
    body = await readPodJson(podFetch, podAuthMethodsUrl(userId));
  } finally {
    watch.done();
  }
  if (deletedUserIds.has(userId)) return false;
  if (watch.changed) {
    const current = authMethodsCache.get(userId)?.value;
    if (!current || isTombstone(current) || !holdsAnAccount(userId, current)) return false;
    hydrateFromAuthMethods(userId, current);
    return true;
  }
  if (body === null) return false;
  const m = normaliseAuthMethods(body, userId);
  // A janitor's purge of this Play owner that did not finish (purgePlayOwner): its next pass does.
  if (isTombstone(m) && m.provisionalPlayPurgePending && userId.startsWith('u-try-play-')) unfinishedPlayPurges.add(userId);
  if (!holdsAnAccount(userId, m)) return false;
  return adoptAccount(userId, m);
}

// A record that makes its pod an account: one with a credential, or a Play owner's anchor that
// still opens to this id.
function holdsAnAccount(userId: string, m: AuthMethods): boolean {
  if (hasAnyCredential(m)) return true;
  if (!m.provisionalPlayAnchor) return false;
  try {
    return provisionalPlay.open(m.provisionalPlayAnchor, true).userId === userId;
  } catch { return false; }
}

// An account read from its pod becomes known: identity shell, auth-methods cache, indexes.
// Returns false, adopting nothing, for a tombstone or an account deleted in this process: a
// read that started before the deletion's tombstone and finished after it cleared memory
// holds the old record, and must not put it back (installAuthMethods has the same guard).
function adoptAccount(userId: string, m: AuthMethods): boolean {
  if (isTombstone(m) || deletedUserIds.has(userId)) return false;
  hydrateFromAuthMethods(userId, m);
  installAuthMethods(userId, m);
  return true;
}

// What the last pass over the pods found, for /health: the accounts loaded, and the pods
// still unreadable (retried every ACCOUNT_RETRY_MS until none is left).
const ACCOUNT_RETRY_MS = 60_000;
let accountIndexState: { complete: boolean; listed: boolean; unreadable: number; loaded: number; lastPass: AccountLoadReport | null } =
  { complete: false, listed: false, unreadable: 0, loaded: 0, lastPass: null };

// Rebuild all indexes from the pods. Users registered in a previous container life are
// recovered without any in-memory state having survived. A pod that cannot be read is
// retried (account-index.ts loadAccounts: three more passes, then once a minute in the
// background) — never counted as an account without credentials.
async function rebuildAllIndexes(only?: readonly string[]): Promise<void> {
  const seededUserIds = [...identities.values()].filter(i => i.type === 'user').map(i => i.id);
  const report = await loadAccounts({
    list: async () => [...new Set([...seededUserIds, ...(await listPods(podFetch, CSS_URL))])],
    load: loadAccountFromPod,
    ...(only ? { only } : {}),
    concurrency: 16,
  });
  accountIndexState = {
    complete: report.listed && report.unreadable.length === 0,
    listed: report.listed,
    unreadable: report.listed ? report.unreadable.length : accountIndexState.unreadable,
    loaded: accountIndexState.loaded + report.loaded,
    lastPass: report,
  };
  log(report.listed
    ? `Account index: ${report.loaded} loaded, ${report.skipped} without credentials, ${report.unreadable.length} unreadable after ${report.rounds} pass(es) over ${report.attempted} pod(s). users=${[...identities.values()].filter(i => i.type === 'user').length} wallets=${walletIndex.size} webauthn=${credentialIndex.size} dids=${didIndex.size}`
    : `ERROR: identity_account_index_incomplete: could not list the pods at ${CSS_URL}; retrying in ${ACCOUNT_RETRY_MS / 1000}s`);
  if (!accountIndexState.complete) {
    if (report.listed) log(`ERROR: identity_account_index_incomplete: ${report.unreadable.length} pod(s) unreadable (${report.unreadable.slice(0, 5).join(', ')}${report.unreadable.length > 5 ? ', …' : ''}); retrying in ${ACCOUNT_RETRY_MS / 1000}s`);
    const retry = setTimeout(() => {
      void rebuildAllIndexes(report.listed ? report.unreadable : undefined)
        .catch(err => log(`WARN: account index retry failed: ${(err as Error).message}`));
    }, ACCOUNT_RETRY_MS);
    retry.unref?.();
  }
}

// An account asked for by id but not in memory (its pod was unreadable at startup, or it
// registered on another replica): load it from its pod now. 'unreadable' means the pod
// could not be read, so the caller can say "try again" rather than "no such account".
const ACCOUNT_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;
async function ensureAccountLoaded(userId: string): Promise<'loaded' | 'absent' | 'unreadable'> {
  const known = identities.get(userId);
  if (known) return known.type === 'user' ? 'loaded' : 'absent';
  if (!ACCOUNT_ID_SHAPE.test(userId)) return 'absent';
  try {
    return (await loadAccountFromPod(userId)) ? 'loaded' : 'absent';
  } catch (err) {
    log(`WARN: could not load account ${userId} on demand: ${(err as Error).message}`);
    return 'unreadable';
  }
}

/**
 * Load each of `holders` (accounts a sign-in index lists for a credential) that this server holds
 * no identity shell for. The indexes can list an account that was never loaded here: any record
 * installed without loading its account puts what it lists into them without the shell a load
 * seeds. Among those installs: the settlement after a failed write, a read of an account whose
 * add was unconfirmed (readAccountNow, from a credential's turn or credentialAfterFailedAdd), a
 * refused first sign-in, a refused bootstrap passkey, and the record a tombstone write found
 * changed. A sign-in tries only accounts with a shell, so it passed such a holder over: a passkey
 * got 404, and a wallet or a did:key opened the account derived from it beside the one listing it,
 * leaving it on two accounts. False: one could not be read (the caller answers 503).
 */
async function loadIndexedHolders(holders: readonly string[]): Promise<boolean> {
  for (const id of holders.slice(0, MAX_HOLDERS)) {
    if (identities.has(id) || deletedUserIds.has(id)) continue;
    if (await ensureAccountLoaded(id) === 'unreadable') return false;
  }
  return true;
}

/**
 * The answer for a credential no loaded account holds while some account is not loaded yet
 * (the startup scan is still running, or a pod it listed stays unreadable; the log line
 * identity_account_index_incomplete names it). The account holding the credential may be one
 * of those, so the credential opens no account, a passkey or a DID that is not a did:key is
 * added to none (nor is a wallet: walletHolder), and a sign-in no loaded account verifies,
 * existingOnly wallet sign-ins included, is not told the credential is unknown. Opening one
 * would leave the credential on two accounts: a wallet's first sign-in opens the account derived
 * from it, which then takes the wallet's sign-ins from the account listing it for good; a
 * passkey id registered with a copy of its owner's public key (registering proves nothing about
 * the private key) takes the owner's usernameless sign-ins whenever the owner's account is not
 * loaded; and a did:web bound with another key, though that key never verifies the owner's
 * signature, keeps the owner from binding the DID again once it removes it (to change its key,
 * say), since a DID a loaded account lists with another key is refused. A did:key added with a
 * bearer is still bound: only its key's holder can bind it, so every account listing it is one
 * that holder chose. A passkey is refused at /register-options already, before the browser
 * creates one that no account would list. The cost: new accounts and new credentials wait until
 * every pod has been read.
 *
 * This stops new second holders only. A credential two accounts already list was put there
 * before this check: a passkey copy registered then, a did:web another account bound with a key
 * of its own then, a wallet linked before /wallet/link needed this server's nonce, the account
 * derived from a wallet or did:key that its first sign-in opened while the account listing it
 * was not loaded (the first-time path waited 50 ms for the scan and opened it), or a write by
 * the other instance while a deploy overlapped the two.
 * A passkey, wallet or did:key sign-in loads the account derived from the credential before
 * choosing another holder (503 while it is unreadable); the rest are decided among the loaded
 * holders, as at every startup scan. So a passkey copy takes the sign-in of an owner that is
 * not the account derived from its id, a wallet that would get 409 signs in to its one loaded
 * holder, and a did:key with no derived holder goes to the lowest loaded id, until every holder
 * is loaded; and a derived account the first-time path opened beside the owner's keeps the
 * wallet's or did:key's sign-ins even then, as the derived account is preferred (walletAccount).
 */
function refuseWhileLoading(res: express.Response, credential: 'passkey' | 'wallet' | 'DID', adding = false): void {
  res.status(503).json({
    error: 'Interego is still loading accounts',
    detail: adding
      ? `This ${credential} may already be on an account that has not been loaded yet, so it is added to no account until every account is loaded. Nothing was changed; try again in a minute.`
      : `This ${credential} may belong to an account that has not been loaded yet. Nothing was changed; try signing in again in a minute rather than creating a new account.`,
  });
}

/**
 * Promise-cached initial-rebuild handle.
 *
 * The original boot code called `rebuildAllIndexes().catch(...)` fire-
 * and-forget from inside app.listen(). The first /auth/did request
 * that landed before the Promise.all settled raced the index rebuild
 * and missed didIndex — forcing the slow first-time-registration
 * branch (and a ~2.5s CSS write round-trip) on a user
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
  // Quoted: a first sign-in names the user and its agent from what the caller sends.
  log(`Seeded ${type} identity: ${logValue(id, 200)} (${logValue(name, 200)})`);
}

// The janitor (app.listen below) deletes the OWNER of any agent whose id matches this, once
// the owner is older than its grace window. Module scope so that restoreSurfaceAgent can
// refuse those ids: restoring `playwright-passkey-<victim>` on an anonymous GET would hand
// the victim's account to the janitor.
const TEST_AGENT_PATTERN = new RegExp(process.env['TEST_AGENT_PATTERN'] ?? '^playwright-passkey-');

// Per-surface agents (`<surface>-<userId>`, minted by ensureSurfaceAgent) live only in
// memory, and the boot-time rebuild restores one placeholder agent per user, not these.
// After a restart the relay's OAuth sessions keep signing as an agent this server no longer
// knows, and anything that reads that agent's DID document got a 404. The id names its user,
// so it is restored on demand (surface-agent-restore.ts): only for a canonical user id of a
// user known here, never for a reserved id, and only when the user's pod agent registry
// (which the relay writes on OAuth) lists it or a verified token issued to that user names
// it, with the scope that registry entry or token records. Anonymous restores are capped per
// user as a backstop.
const surfaceAgentRestores = new SurfaceAgentRestores();

// The forms of an agent's DID this server mints (issueTokenResponse, /me), as the relay
// writes them into `<pod>/agents`.
const AGENT_DID_PREFIXES = [...new Set([`did:web:${BASE_URL_HOST}:agents:`, `did:web:${BASE_URL_HOST_NO_PORT}:agents:`])];

// One registry read per user per minute at most, however many lookups name that user's
// agents: an anonymous caller cannot turn DID resolutions into a stream of pod reads. Keys
// are known users only (restore asks the registry after every other check has passed). A
// read that failed is retried sooner.
const POD_REGISTRY_TTL_MS = 60_000;
const POD_REGISTRY_FAILURE_TTL_MS = 5_000;
const podRegistryCache = new Map<string, { expires: number; ids: Promise<ReadonlyMap<string, DelegationScope> | null> }>();

async function readPodRegistryAgentScopes(userId: string): Promise<ReadonlyMap<string, DelegationScope> | null> {
  const url = podAgentRegistryUrl(userId);
  try {
    const r = await podFetch(url, { headers: { Accept: 'text/turtle' } });
    if (r.status === 404) return new Map();
    if (!r.ok) {
      log(`WARN: could not read agent registry ${url}: ${r.status} ${r.statusText}`);
      return null;
    }
    return registryAgentScopes(await r.text(), AGENT_DID_PREFIXES);
  } catch (err) {
    log(`WARN: could not read agent registry ${url}: ${(err as Error).message}`);
    return null;
  }
}

/** The agent ids `<pod>/agents` lists for this user, with their scopes; null when it could not be read. */
function podRegistryAgentScopes(userId: string): Promise<ReadonlyMap<string, DelegationScope> | null> {
  const now = Date.now();
  const cached = podRegistryCache.get(userId);
  if (cached && cached.expires > now) return cached.ids;
  const entry = { expires: now + POD_REGISTRY_TTL_MS, ids: readPodRegistryAgentScopes(userId) };
  podRegistryCache.set(userId, entry);
  void entry.ids.then(ids => {
    if (ids === null) entry.expires = Math.min(entry.expires, Date.now() + POD_REGISTRY_FAILURE_TTL_MS);
  });
  return entry.ids;
}

/**
 * Restore a forgotten surface agent as its user's, with the name ensureSurfaceAgent would give
 * it. `token` is a verified token naming this agent: the user it was issued to and the scope
 * it was signed with. Without one the user's pod registry must list the agent, and its entry
 * gives the scope. Never rejects.
 */
async function restoreSurfaceAgent(agentId: string, token?: { userId: string; scope: unknown }): Promise<void> {
  if (identities.has(agentId)) return;
  try {
    await surfaceAgentRestores.admit({
      agentId,
      lookup: id => identities.get(id),
      reserved: id => TEST_AGENT_PATTERN.test(id),
      ...(token !== undefined ? { tokenUserId: token.userId, tokenScope: token.scope } : {}),
      registryScope: async (userId, id) => (await podRegistryAgentScopes(userId))?.get(id),
      seed: granted => {
        seedIdentity(granted.agentId, 'agent', granted.name, granted.userId, granted.scope);
        log(`Restored surface agent ${granted.agentId} for ${granted.userId} as ${granted.scope} (confirmed by ${granted.confirmedBy})`);
      },
    });
  } catch (err) {
    log(`WARN: could not restore surface agent ${agentId}: ${(err as Error).message}`);
  }
}

/** The agent with this id: in memory, or a forgotten surface agent restored now. */
async function agentIdentity(agentId: string): Promise<Identity | undefined> {
  if (!identities.has(agentId)) await restoreSurfaceAgent(agentId);
  // Restored by this call, or by a lookup that raced it.
  const identity = identities.get(agentId);
  return identity?.type === 'agent' ? identity : undefined;
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
// Every sign-in starts with POST /challenges -> nonce. A passkey signs
// the nonce as its WebAuthn challenge bytes; a wallet signs a SIWE
// message that carries it; a DID key signs the message its did-sig
// challenge comes with. The client POSTs the proof to /auth/<method>.
// The server checks the nonce was issued, is unused and has not
// expired, and, if it was issued with a purpose, that the purpose is
// this route's (consumeChallenge); then it checks the signature.

interface Challenge {
  nonce: string;
  expiresAt: number;
  // Optional binding: if set, this challenge may only be used for a
  // specific auth method / WebAuthn operation. Prevents cross-use of
  // a WebAuthn-originated challenge against SIWE, etc.
  purpose?: 'siwe' | 'webauthn-register' | 'webauthn-authenticate' | 'did-sig';
  // did-sig: the text the DID's key signs (didSignInMessage), kept so /auth/did verifies the
  // bytes it handed out.
  message?: string;
  // For WebAuthn flows: the transient session-user handle emitted in
  // the registration options (so the `/register` step can match the
  // ceremony back to this challenge). NOT the final userId.
  userId?: string;
  // WebAuthn register — mode (C): existing authenticated user adding
  // another device. Set when Authorization: Bearer <token> was valid.
  addDeviceUserId?: string;
  // Mode (C): the session epoch of the bearer's token, so the registration adds nothing to an
  // account that signed out everywhere after the options were issued (signedOutSince).
  addDeviceEpoch?: number;
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

/**
 * The text a did-sig challenge asks the DID's key to sign: what it is and its format version,
 * this server's host (from BASE_URL, the `base` /health reports; never a request header), and
 * the nonce. LF line ends, no trailing newline, ASCII only. Nothing in it comes from the request.
 */
function didSignInMessage(nonce: string): string {
  return `Interego DID sign-in v1\nHost: ${BASE_URL_HOST}\nNonce: ${nonce}`;
}

function issueChallenge(purpose?: Challenge['purpose'], userId?: string): Challenge {
  // Prune expired entries periodically on new issues
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expiresAt < now) challenges.delete(k);
  // A SIWE nonce is hex: ERC-4361 allows letters and digits only, and a wallet does not read a
  // message whose nonce has base64url's '-' or '_' as a sign-in (so it would skip its domain
  // check). The other purposes keep base64url, which WebAuthn decodes as challenge bytes.
  const nonce = crypto.randomBytes(32).toString(purpose === 'siwe' ? 'hex' : 'base64url');
  const ch: Challenge = { nonce, expiresAt: now + CHALLENGE_TTL_MS };
  if (purpose) ch.purpose = purpose;
  if (purpose === 'did-sig') ch.message = didSignInMessage(nonce);
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
  provisionalPlay?: ProvisionalTokenGrant;
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
  // issueToken signs string ids only. A token whose agentId is not one (an array, minted by
  // POST /register-agent before it checked the type) names no agent this server knows.
  if (typeof payload.userId !== 'string' || !payload.userId || typeof payload.agentId !== 'string' || !payload.expiresAt) {
    return { valid: false, reason: 'Token payload incomplete' };
  }
  return { valid: true, payload };
}

async function issueToken(userId: string, agentId: string, scope: string, provisional?: ProvisionalTokenGrant): Promise<TokenRecord> {
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
    expiresAt: new Date(Math.min(now.getTime() + TOKEN_TTL_SECONDS * 1000, provisional ? provisional.expiresAt * 1000 : Infinity)).toISOString(),
    epoch,
    ...(provisional ? { provisionalPlay: provisional } : {}),
  };
  const token = signPayload(payload);
  const record: TokenRecord = {
    token,
    userId,
    agentId,
    scope,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    ...(payload.provisionalPlay ? { provisionalPlay: payload.provisionalPlay } : {}),
  };
  log(`Issued token for ${logValue(agentId, 200)} (user: ${userId}, scope: ${scope}, epoch: ${epoch}, expires: ${record.expiresAt})`);
  return record;
}

/**
 * The answer to a request that sent a bearer with a wallet or DID no account holds (an add, in
 * /auth/siwe and /auth/did) when that bearer did not verify. Such a request never goes on as a
 * plain first sign-in: that opened the account derived from the credential, which is preferred
 * where several hold a wallet or did:key, so the owner's retry with the same bearer then signed in
 * to it instead of adding the credential. 503 when the bearer's account could not be read (try
 * again), 401 for any other reason (signed out, expired, deleted). Nothing is changed either way.
 */
function refuseUnverifiedBearer(res: express.Response, check: { reason?: string; unreadable?: boolean }): void {
  if (check.unreadable) {
    res.status(503).json({
      error: 'Could not read the account for this token just now',
      detail: 'The account this bearer token is for could not be read, so the credential was not added to it. Nothing was changed; try again in a minute.',
    });
    return;
  }
  res.status(401).json({
    error: `Invalid bearer token: ${check.reason ?? 'not valid'}`,
    detail: 'The credential was not added, and no account was opened for it. Sign in again, then add it; or send the request without a bearer token to sign in with the credential alone.',
  });
}

/**
 * The answer to a bearer that did not verify, on a route that acts on the bearer's own account
 * (/wallet/link, a device's registration options, and every route behind requireUserFromBearer):
 * 503 when the account could not be read (its pod did not answer; a Play guest's owner record
 * could not be read), so that a client does not drop a token that is still good, and 401 for any
 * other reason. They all answered 401, where /auth/siwe and /auth/did (refuseUnverifiedBearer,
 * which also says no account was opened) answered 503. `again`: what the client does next.
 */
function refuseBearer(res: express.Response, check: { reason?: string; unreadable?: boolean },
  again = 'Nothing was changed; try again in a minute.'): void {
  if (check.unreadable) {
    res.status(503).json({
      error: 'Could not read the account for this token just now',
      detail: `The account this bearer token is for could not be read. ${again}`,
    });
    return;
  }
  res.status(401).json({ error: `Invalid bearer token: ${check.reason ?? 'not valid'}` });
}

/** The session epoch a token this server signed was issued at (verifyToken has checked it). */
function tokenEpoch(token: string): number {
  const parsed = parseAndVerifySignature(token);
  return parsed.valid === true && Number.isFinite(parsed.payload.epoch) ? parsed.payload.epoch : 0;
}

/**
 * Whether the record an add is about to change has signed out everywhere since the bearer's
 * token was issued. Checked inside the add's write (on the record as the pod holds it, under the
 * lock), so a token signed out while its request waited (for a credential's turn, or between a
 * passkey ceremony's options and its registration) completes no add: the check made when the
 * request arrived is not enough.
 */
const signedOutSince = (m: AuthMethods, epoch: number): boolean => (m.sessionEpoch ?? 0) > epoch;
const SIGNED_OUT_DURING_ADD = 'Invalid bearer token: Token revoked (signed out everywhere)';

async function verifyToken(token: string): Promise<{ valid: boolean; record?: TokenRecord; reason?: string; unreadable?: boolean }> {
  const parsed = parseAndVerifySignature(token);
  if (parsed.valid !== true) {
    return { valid: false, reason: (parsed as { valid: false; reason: string }).reason };
  }
  const payload = parsed.payload;
  // An account deleted in this process is refused before anything is read: what memory or a
  // failed pod read would say about it (a shell re-seeded by a refused sign-in, an empty
  // record at epoch 0) is not the tombstone's answer.
  if (deletedUserIds.has(payload.userId)) return { valid: false, reason: 'Account deleted' };
  // An agent id ending in ANOTHER user's canonical id reads as that user's agent
  // (surface-agent-restore.ts). This server never issues one now (POST /register-agent
  // refuses it, and every other issuer names the user's own agents), so such a token was
  // minted for a squat before that check: it does not verify.
  if (foreignCanonicalSuffix(payload.agentId, payload.userId) !== null) {
    return { valid: false, reason: "Token names an agent in another user's namespace" };
  }
  if (payload.provisionalPlay && (!Number.isInteger(payload.provisionalPlay.expiresAt)
    || payload.provisionalPlay.expiresAt * 1000 <= Date.now())) {
    return { valid: false, reason: 'Provisional owner expired' };
  }
  if (payload.provisionalPlay) {
    try {
      const body = await readPodJson(podFetch, podAuthMethodsUrl(payload.userId));
      const methods = normaliseAuthMethods(body, payload.userId);
      // A tombstone (the guest's deletion, or the janitor's purge) has no anchor to open: the token
      // is a closed account's, and is answered as one. While this process still holds the owner, its
      // copy is made the tombstone (read under the lock), so that POST /users/me/delete accepts the
      // retry of a deletion the pod took without confirming it (unfinishedDeletion). It was answered
      // "Provisional owner unavailable", which no route accepts, so that retry was refused (401).
      if (isTombstone(methods)) {
        const copy = authMethodsCache.get(payload.userId)?.value;
        if (identities.has(payload.userId) && !(copy && isTombstone(copy))) await refreshAuthMethods(payload.userId).catch(() => undefined);
        return { valid: false, reason: 'Account deleted' };
      }
      const owner = provisionalPlay.open(methods.provisionalPlayAnchor);
      if (owner.userId !== payload.userId || owner.authenticatedAgentId !== payload.agentId
        || owner.audience !== payload.provisionalPlay.audience || owner.proofKeyThumbprint !== payload.provisionalPlay.proofKeyThumbprint
        || owner.expiresAt !== payload.provisionalPlay.expiresAt) return { valid: false, reason: 'Provisional owner binding mismatch' };
    } catch (err) {
      // An owner's record the pod could not read is a "try again" (a 503: refuseUnverifiedBearer,
      // refuseBearer), not a refusal: only an anchor that does not open to this owner is.
      return { valid: false, reason: 'Provisional owner unavailable', ...(err instanceof PodReadError ? { unreadable: true } : {}) };
    }
  }
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
    // The signature is already verified, so only a genuine token gets here: load its account
    // from the pod (unreadable at startup, say) before calling the user missing. A deleted
    // user's pod holds a tombstone without credentials, which does not load.
    const account = await ensureAccountLoaded(payload.userId);
    if (account === 'unreadable') return { valid: false, reason: 'Could not read the account for this token; try again', unreadable: true };
    if (account !== 'loaded') return { valid: false, reason: 'User for token not found' };
  }
  // Revocation check: token's embedded epoch must be ≥ pod's current
  // sessionEpoch. A sign-out-everywhere bumps the pod's value, making
  // every prior token verify-fail until the user authenticates again.
  try {
    const methods = await readAuthMethods(payload.userId, /* allowStale */ true);
    if (isTombstone(methods)) return { valid: false, reason: 'Account deleted' };
    const podEpoch = methods.sessionEpoch ?? 0;
    if (payload.epoch < podEpoch) {
      return { valid: false, reason: 'Token revoked (signed out everywhere)' };
    }
  } catch {
    // If we can't read the pod, fall through: signature + expiry +
    // identities-map already bound the trust. A transient pod outage
    // is a partition, not a security event.
  }
  // The token's agent may be a surface agent forgotten by a restart, as the anonymous DID
  // document route would restore it. This server signed that agent id for this user, so it
  // is restored here too (only as this user's `<surface>-<userId>`, with the scope the token
  // was signed with, without asking the pod registry and uncounted). The record below is the
  // same either way: nothing the token can do changes.
  await restoreSurfaceAgent(payload.agentId, { userId: payload.userId, scope: payload.scope });
  const record: TokenRecord = {
    token,
    userId: payload.userId,
    agentId: payload.agentId,
    scope: payload.scope,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    ...(payload.provisionalPlay ? { provisionalPlay: payload.provisionalPlay } : {}),
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
// An async handler that throws reaches routeErrorHandler (registered last, above
// app.listen) instead of ending the process. See route-errors.ts.
forwardAsyncRouteErrors(log);

/**
 * Transport-security headers.
 *
 * This host MINTS AND ACCEPTS BEARER TOKENS. Plain http:// already 301s to https,
 * but a redirect only protects the second request — the first one, carrying an
 * Authorization header, has already crossed the wire in clear. HSTS is what removes
 * that first request: once seen, the browser upgrades before sending anything.
 *
 * Not preloaded, and `includeSubDomains` is deliberately omitted: this zone carries
 * hosts this service does not own, and asserting a policy on their behalf is not
 * ours to do. A year is the usual floor for the header to be worth setting at all.
 *
 * `nosniff` rides along because it is the other one-liner that matters here: several
 * routes serve JSON and Turtle that must never be content-sniffed into something
 * executable.
 */
app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ★ AFTER the headers, not before — and this line USED to sit above them, which made the
// block above dead on the one path that most needs it. body-parser throws on a malformed
// body and express jumps straight to the error handler, skipping every middleware
// registered after the parser. Measured live 2026-08-03:
//
//   POST https://identity.interego.xwisee.com/  body `{ not json`
//     -> 400 Bad Request, NO Strict-Transport-Security
//
// while the relay, which already registers its HSTS middleware before its parser, returned
// 400 WITH it. This host mints and accepts bearer tokens, and a smoke test never sees this
// because a smoke test always sends valid JSON. Nothing but a JSDoc comment sat between the
// two lines, so no route's ordering changed; `app.set('trust proxy', 1)` stays above both.
app.use(express.json());

// CORS: explicit allowlist, never wildcard. See cors-allowlist.ts for the
// full rationale (the same fix is applied in deploy/mcp-relay/server.ts).
// Unknown origins receive THIS service's own FQDN as ACAO so a browser
// caller cannot read the response cross-origin, and we NEVER emit
// Access-Control-Allow-Credentials: true.
app.use(corsMiddleware({
  ownOrigin: BASE_URL,
  extra: [...parsePlayClients(process.env['PROVISIONAL_PLAY_CLIENTS']).keys()],
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
//   - Token issue: per-session, low volume. POST /tokens/verify from a caller presenting the
//     introspection bearer has its own per-address budget (see the route); every other verify
//     counts against 'tokens' with the routes below.
//   - GET /auth-methods/me: per verified account, not per IP (see the
//     route). The relay reads it with each user's bearer from its one
//     address, so a per-IP cap there is one budget for every relay user.
//
// The counters live in rate-limit.ts (in-memory, per process).

const authEnrollLimiter = rateLimit('auth-enroll', { windowMs: 60_000, max: 30 });
const challengeLimiter = rateLimit('challenges', { windowMs: 60_000, max: 60 });
const tokenBucket = createLimiter('tokens', { windowMs: 60_000, max: 60 });
const tokenLimiter = limitByIp(tokenBucket);
const introspectionBucket = createLimiter('introspection', { windowMs: 60_000, max: 600 });
// /siwe/verify runs ECDSA recovery on every call — tighter cap than the
// general auth-enroll limiter to keep unauthenticated CPU exhaustion off
// the table.
const siweVerifyLimiter = rateLimit('siwe-verify', { windowMs: 60_000, max: 10 });
const webfingerLimiter = rateLimit('webfinger', { windowMs: 60_000, max: 120 });
// GET /auth-methods/me. A token this server signed counts against the account it names: the
// relay reads a user's registered signing keys once for every client-signed write it makes for
// them, so 120/min (two a second, sustained) is well above what one person's surfaces produce
// together while still bounding the verifications and pod reads one account's tokens cause.
// A missing bearer or one this server did not sign counts against the IP at the auth-enroll
// rate, so forged tokens cannot be used to hammer the route either.
const authMethodsUserLimiter = createLimiter('auth-methods-me', { windowMs: 60_000, max: 120 });
const authMethodsFailureLimiter = createLimiter('auth-methods-me-unauthenticated', { windowMs: 60_000, max: 30 });

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
<p class="muted" style="margin-top:-0.8em;margin-bottom:1.6em;font-size:0.88rem">Reference implementation on the maintainer's own hosting. Fine for evaluation; self-host before you depend on it.</p>

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
      "url": "${RELAY_URL}/mcp",
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
app.get('/sign-action', (_req, res) => {
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ${new URL(resolveRelayBase()).origin}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(readFileSync(process.env.INTEREGO_CLIENT_SIGN_PAGE ?? new URL('../../docs/client-sign.html', import.meta.url), 'utf8')
    .replace('__INTEREGO_SIGNING_CONFIG__', JSON.stringify({ identityUrl: BASE_URL, relayUrl: resolveRelayBase(),
      signingOrigins: [BASE_URL, resolveRelayBase()] }).replace(/</g, '\\u003c')));
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    users: [...identities.values()].filter(i => i.type === 'user').length,
    agents: [...identities.values()].filter(i => i.type === 'agent').length,
    // Whether every pod has been read into the sign-in indexes. `complete: false` with
    // `unreadable > 0` means some accounts cannot sign in yet; they are retried every minute.
    accountIndex: {
      complete: accountIndexState.complete,
      listed: accountIndexState.listed,
      unreadable: accountIndexState.unreadable,
      lastPassAt: accountIndexState.lastPass?.finishedAt ?? null,
    },
    // Writes of a wallet or DID whose outcome nothing could settle yet (a count, no credential):
    // each is settled by its credential's next request, or by the once-a-minute sweep.
    unconfirmedWrites: credentialDecisions.recorded(),
    // Tokens are stateless (HMAC-signed) — there's no server-side count
    // to report. Caller can still trust signature + expiry + sessionEpoch.
    tokenSigningKeyOrigin: process.env['TOKEN_SIGNING_KEY'] ? 'env' : 'ephemeral',
    // Which mode POST /tokens/verify runs in, and whether ALLOW_OPEN_INTROSPECTION=1 is set (while
    // enforced it is only the rollback). Neither says anything about the secret's value.
    introspection: INTROSPECTION_MODE,
    allowOpenIntrospection: ALLOW_OPEN_INTROSPECTION,
    base: BASE_URL,
    // ★ The field is named `build` and nothing more descriptive because
    // tools/railway-redeploy.mjs reads exactly `j.build` from --verify-url, and that poll
    // is the ONLY assertion distinguishing the new container from the old one still
    // serving: Railway calls a deploy SUCCESS as soon as the container binds a port, and
    // on a tag that does not exist in the registry the previous container keeps answering
    // 200. Without this field every other key in this body was byte-identical before and
    // after every deploy, so nothing could tell a landed rollout from a skipped one —
    // which is how identity sat pinned to a commit it was demonstrably not running.
    // Matches deploy/mcp-relay/server.ts.
    build: process.env['INTEREGO_BUILD_SHA'] ?? 'unset',
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
      'brand-new user (did)': 'POST /auth/did with a signature over the message /challenges returns for purpose=did-sig',
      'claim legacy seeded userId': 'include { bootstrapUserId, bootstrapInvite } on first-auth call (one-time)',
      'add another device to existing account': 'authenticate first, then repeat any register path with Authorization: Bearer <token>',
    },
  });
});

// ── Challenge issuance ──────────────────────────────────────

/**
 * POST /challenges — issue a nonce the client signs to prove key control.
 * Body: { purpose?, userId?, address? }
 *   purpose:  'siwe' | 'webauthn-register' | 'webauthn-authenticate' | 'did-sig'
 *   userId:   for WebAuthn authenticate, scopes the challenge to a user
 *             (server returns allowed credential IDs the client may use)
 *   address:  siwe only; comes back in EIP-55 form to sign with
 * Returns: { nonce, expiresAt, message?, rpId?, address?, allowCredentials? }
 *   message:  did-sig only. The exact text the DID's key signs, byte for byte; a client never
 *             rebuilds it. It names this server's host (from BASE_URL) and carries the nonce.
 */
app.post('/challenges', challengeLimiter, async (req, res) => {
  const { purpose, userId, address } = req.body as { purpose?: Challenge['purpose']; userId?: string; address?: unknown };
  // A SIWE message must carry the wallet's address in EIP-55 mixed case, which takes keccak-256
  // to compute and a browser has no built-in for; eth_requestAccounts hands pages a lowercase
  // address. A client that sends the address here gets it back in checksum form to sign with.
  let checksummedAddress: string | undefined;
  if (purpose === 'siwe' && address !== undefined) {
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      res.status(400).json({ error: 'address must be a 0x-prefixed 20-byte hex address' });
      return;
    }
    checksummedAddress = (await loadEthers()).getAddress(address.toLowerCase());
  }
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
    // An account that is not in memory may still be on its pod (it was unreadable when
    // this container started): load it rather than answering "no passkey".
    const account = await ensureAccountLoaded(userId);
    if (account === 'unreadable') {
      res.status(503).json({
        error: 'Could not read this account just now',
        detail: 'The pod holding this account did not answer. Nothing was changed; try signing in again in a minute.',
      });
      return;
    }
    if (account === 'loaded') {
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
  if (ch.message) resp.message = ch.message;
  if (ch.rpId) resp.rpId = ch.rpId;
  if (checksummedAddress) resp.address = checksummedAddress;
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

// ── SIWE message rule (shared by /auth/siwe and /wallet/link) ──

/**
 * The hosts a SIWE message may name on its first line (and in its URI): this server
 * (BASE_URL), the relay whose /authorize page signs users in (RELAY_URL, RELAY_PUBLIC_URL), the
 * WebAuthn ceremony origins (WEBAUTHN_RP_ORIGINS), and any extra front-end listed in
 * SIWE_DOMAINS (comma-separated hosts). A wallet shows the user this domain line and warns when
 * it does not match the page asking, so it is what ties a signature to an Interego sign-in.
 * Without this rule a server nonce relayed into another site's "Sign in with Ethereum" prompt
 * came back as a signature this server accepted.
 *
 * Only hosts the operator configured. The relay host that relayPublicBase() derives from
 * BASE_URL when RELAY_PUBLIC_URL is unset (identity.<zone> -> relay.<zone>,
 * x-identity.<zone> -> x-relay.<zone>) is a guess: on a shared hosting suffix it can be a name
 * anyone may register, and a page an attacker serves on an admitted host passes the wallet's
 * own domain check too. Each host is listed at startup with the setting it came from.
 */
let siweDomainsMemo: ReadonlyMap<string, string> | null = null;
function siweDomainSources(): ReadonlyMap<string, string> {
  if (siweDomainsMemo) return siweDomainsMemo;
  const hosts = new Map<string, string>();
  const add = (host: string, source: string) => { if (!hosts.has(host)) hosts.set(host, source); };
  const addUrl = (u: string | undefined, source: string) => {
    if (!u || !u.trim()) return;
    try { add(new URL(u.trim()).host.toLowerCase(), source); } catch { /* not a URL: skip */ }
  };
  addUrl(BASE_URL, 'BASE_URL');
  addUrl(RELAY_URL, 'RELAY_URL');
  addUrl(process.env['RELAY_PUBLIC_URL'], 'RELAY_PUBLIC_URL');
  for (const origin of RP_ALLOWLIST.keys()) addUrl(origin, 'WEBAUTHN_RP_ORIGINS');
  for (const h of (process.env['SIWE_DOMAINS'] ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)) add(h, 'SIWE_DOMAINS');
  siweDomainsMemo = hosts;
  return hosts;
}
function siweDomains(): ReadonlySet<string> { return new Set(siweDomainSources().keys()); }

/** How far ahead of this server's clock a message's Not Before may be. */
const SIWE_CLOCK_SKEW_MS = 5 * 60 * 1000;
/**
 * How far a message's Issued At may be from its challenge's issue, either way. Issued At is the
 * signing device's clock, which can be off by hours (a phone with the wrong time zone, a laptop
 * that never synced); freshness is the single-use nonce's job, which this server issued and
 * which expires CHALLENGE_TTL_MS after that. A window of minutes refused those devices' sign-ins
 * and kept nothing out that the nonce does not.
 */
const SIWE_ISSUED_AT_WINDOW_MS = 24 * 60 * 60 * 1000;

type SiweMessageCheck =
  | { ok: true; address: string }
  | { ok: false; status: 400; body: Record<string, string> };

/**
 * An ERC-4361 message this server accepts for challenge `ch`: one parseSiweMessage reads (so a
 * wallet reads it as a sign-in too and runs its domain check), whose domain and URI host are in
 * siweDomains(), whose address is in EIP-55 form (a wallet's parser refuses any other), whose
 * Nonce field is exactly the challenge's nonce, and whose Issued At (an RFC 3339 date-time, as
 * the parser requires) is within SIWE_ISSUED_AT_WINDOW_MS of the challenge's issue, either way.
 * Expiration Time, if present, must not have passed, and Not Before must have arrived (give or
 * take SIWE_CLOCK_SKEW_MS).
 * Returns the address, lowercased; the caller still checks the signature recovers to it.
 */
async function checkSiweMessage(message: string, ch: Challenge): Promise<SiweMessageCheck> {
  const refuse = (body: Record<string, string>): SiweMessageCheck => ({ ok: false, status: 400, body });
  const parsed = parseSiweMessage(message);
  if (parsed.ok === false) {
    return refuse({
      error: 'Signed message is not an ERC-4361 sign-in message',
      detail: `${parsed.reason}. A wallet checks the site it is signing in to only on a message it reads as Sign-In with Ethereum, so this server accepts no other.`,
      hint: `Build the message exactly as ERC-4361 lays it out: "${BASE_URL_HOST}${SIWE_DOMAIN_SUFFIX}", the checksummed address, a blank line, an optional statement and blank line, then URI, Version: 1, Chain ID, Nonce and Issued At, one per line, separated by LF.`,
    });
  }
  const f = parsed.fields;
  const domains = siweDomains();
  if (!domains.has(f.domain)) {
    return refuse({
      error: 'SIWE message is not addressed to this server',
      detail: 'The first line of the signed message names the site the wallet was signing in to. It must be this Interego deployment.',
      hint: `Its first line must be "${BASE_URL_HOST}${SIWE_DOMAIN_SUFFIX}" (or name another front-end of this deployment).`,
    });
  }
  let uriHost = '';
  try { uriHost = new URL(f.uri).host.toLowerCase(); } catch { /* parseSiweMessage checked it */ }
  if (!domains.has(uriHost)) {
    return refuse({
      error: 'SIWE message URI is not this server',
      hint: 'The URI field names the resource being signed in to; it must be on the same deployment as the domain line.',
    });
  }
  const { ethers } = await loadEthers();
  let checksummed = '';
  try { checksummed = ethers.getAddress(f.address.toLowerCase()); } catch { /* not an address */ }
  if (checksummed !== f.address) {
    return refuse({
      error: 'SIWE message address is not in EIP-55 checksum form',
      detail: 'ERC-4361 requires the address line in EIP-55 mixed case; a wallet does not read a message with a lowercase address as a sign-in.',
      hint: checksummed ? `Write the address as ${checksummed}. POST /challenges with {"purpose":"siwe","address":"0x..."} also returns it in this form.` : 'The second line must be the 0x address of the signing wallet.',
    });
  }
  if (f.nonce !== ch.nonce) {
    return refuse({
      error: 'SIWE message does not contain the issued nonce',
      title: 'Signed message is missing the challenge nonce',
      detail: 'Replay defense: the signed SIWE message MUST carry the nonce we issued at /challenges in its Nonce field.',
      hint: 'Your wallet client should construct the SIWE message with `Nonce:` set to the value returned by /challenges.',
    });
  }
  const now = Date.now();
  const issuedAt = Date.parse(f.issuedAt);
  const challengeIssued = ch.expiresAt - CHALLENGE_TTL_MS;
  if (Math.abs(issuedAt - challengeIssued) > SIWE_ISSUED_AT_WINDOW_MS) {
    return refuse({
      error: 'SIWE message Issued At is more than 24 hours from its challenge',
      hint: 'Issued At must be the time the message was built, just after the nonce was fetched; it may be up to 24 hours off this server\'s clock either way. Check the signing device\'s date and clock.',
    });
  }
  if (f.expirationTime !== undefined && Date.parse(f.expirationTime) <= now) {
    return refuse({ error: 'SIWE message has expired (Expiration Time has passed)' });
  }
  if (f.notBefore !== undefined && Date.parse(f.notBefore) > now + SIWE_CLOCK_SKEW_MS) {
    return refuse({ error: 'SIWE message is not valid yet (Not Before is in the future)' });
  }
  return { ok: true, address: f.address.toLowerCase() };
}

/**
 * Who holds `addr`, as far as this server can tell, before binding it to `forUserId`. The
 * account the wallet would have opened by itself (u-eth-<addr>) is loaded from its pod in case
 * the index missed it, before any holder is named (walletAccount prefers it). 'unknown' means
 * some pod could not be read, so another account may hold the wallet unseen: the caller must
 * not bind it.
 */
async function walletHolder(addr: string, forUserId: string): Promise<{ kind: 'free' } | { kind: 'held'; account: WalletAccount } | { kind: 'unknown' }> {
  const derivedId = deriveUserIdFromWallet(addr);
  const derived = derivedId === forUserId ? 'absent' : await ensureAccountLoaded(derivedId);
  if (derived === 'unreadable') return { kind: 'unknown' };
  if (walletIndex.candidates(addr).some(id => id !== forUserId)) return { kind: 'held', account: walletAccount(addr) };
  if (!accountIndexState.complete) return { kind: 'unknown' };
  return { kind: 'free' };
}

type WalletAccount = { kind: 'none' } | { kind: 'one'; userId: string } | { kind: 'ambiguous'; holders: number };

/**
 * The account a wallet signs in to, among the accounts this server has loaded: the one account
 * listing it or, when several do, the account derived from the wallet if it is one of them. The
 * derived account may list the wallet without being loaded yet, so a caller loads it before
 * acting on any other answer.
 *
 * This server gives a wallet to an account only when no account it has loaded holds it, and
 * opens or extends none while some account is not loaded (walletHolder, refuseWhileLoading).
 * A wallet on several accounts therefore comes from a binding made before /wallet/link required
 * this server's nonce (it took any signature the wallet had ever made, so a holder may not be
 * the wallet's own); from a first sign-in made before sign-ins waited for every account, which
 * opened the derived account while the account listing the wallet was not loaded (the scan
 * after any restart, or an unreadable pod: the first-time path waited 50 ms for the scan, then
 * opened it); from a write this server did not see (the other instance, while a deploy
 * overlapped the two, opening an account after this one listed the pods or adding the wallet to
 * an account after this one read it), after which this server can open the derived account
 * itself at the wallet's first sign-in here; or from a write to a pod outside this server. A
 * derived account opened beside the owner's keeps the wallet's sign-ins even once every holder
 * is loaded, since it is preferred; it usually holds that wallet and nothing else, so the
 * wallet cannot be removed from it (its last credential), and signing in to it with the wallet
 * and deleting it (POST /users/me/delete) hands the wallet to the other holder. The derived
 * account is the one the wallet's first sign-in opens. With several holders and none of them
 * derived, nothing here says which is the wallet's, so the wallet signs in to none; while one of
 * them is not loaded, the choice is among the others, so such a wallet signs in to its one
 * loaded holder until then.
 */
function walletAccount(addr: string): WalletAccount {
  const derivedId = deriveUserIdFromWallet(addr);
  const holders = walletIndex.candidates(addr, derivedId);
  if (holders.length === 0) return { kind: 'none' };
  if (holders.length === 1 || holders[0] === derivedId) return { kind: 'one', userId: holders[0]! };
  return { kind: 'ambiguous', holders: holders.length };
}

/**
 * walletAccount's answer as the holders' records have it, for a sign-in. A record can drop the
 * wallet without this server seeing it (the other instance removes it while a deploy overlaps
 * the two, or an operator removes it by hand), so each holder the answer rests on is read again
 * (readForDecision: from its pod once this server's copy is 10 s old). One whose record no
 * longer lists the wallet drops out of the index, and the choice is made again: the wallet signs
 * in there no more, and nothing writes it back. The derived account may list the wallet without
 * being loaded, so it is loaded before another answer is acted on. 'unreadable': it, or a holder
 * whose copy here is 10 s old or more (or missing), could not be read.
 */
async function walletSignInAccount(addr: string): Promise<WalletAccount | 'unreadable'> {
  const derivedId = deriveUserIdFromWallet(addr);
  // A pass that does not return dropped a holder from the index (a record and its index entries
  // are installed together), so this ends; the bound only keeps a disagreement from spinning.
  for (let pass = 0; pass <= MAX_HOLDERS; pass++) {
    let account = walletAccount(addr);
    if (account.kind === 'ambiguous' || (account.kind === 'one' && account.userId !== derivedId)) {
      if (await ensureAccountLoaded(derivedId) === 'unreadable') return 'unreadable';
      account = walletAccount(addr);
    }
    if (account.kind === 'none') return account;
    const holders = account.kind === 'one' ? [account.userId] : walletIndex.candidates(addr, derivedId).slice(0, MAX_HOLDERS);
    if (!(await loadIndexedHolders(holders))) return 'unreadable';
    let dropped = false;
    for (const id of holders) {
      const m = await readForDecision(id);
      if (m === 'unreadable') return 'unreadable';
      if (!m.walletAddresses.some(a => a.toLowerCase() === addr)) dropped = true;
    }
    if (!dropped) return account;
  }
  return 'unreadable';
}

const WALLET_AMBIGUOUS = {
  error: 'This wallet is listed on more than one account',
  detail: 'More than one account lists it, and this server cannot tell which account is yours. Nothing was changed.',
  hint: 'Sign in with another credential and remove the wallet from each account that is not yours (DELETE /auth-methods/me/wallet/<address>). An account you cannot sign in to needs the operator.',
};

function refuseAmbiguousWallet(res: express.Response, account: { holders: number }): void {
  log(`WARN identity_credential_multi_holder kind=wallet holders=${account.holders} refused=ambiguous`);
  res.status(409).json(WALLET_AMBIGUOUS);
}

type BootstrapTarget = Pick<AuthMethods, 'walletAddresses' | 'webAuthnCredentials' | 'didKeys'>;

/**
 * What resolveTargetUserId checks a bootstrap claim of /auth/siwe or /auth/did against: the
 * seeded account's record, read only when the claim carries the invite configured for that id
 * (bootstrapInviteMatches), and never created. Any other claim reads no pod and gets an empty
 * record, which resolveTargetUserId then refuses on the invite with the same answer as an
 * account that already has credentials. 'unreadable': the pod did not answer, and the caller
 * answers 503 before resolveTargetUserId spends the invite.
 */
async function readBootstrapTarget(bootstrapUserId: unknown, bootstrapInvite: unknown): Promise<BootstrapTarget | 'unreadable'> {
  if (!bootstrapInviteMatches(bootstrapUserId, bootstrapInvite)) return { walletAddresses: [], webAuthnCredentials: [], didKeys: [] };
  const userId = bootstrapUserId as string;
  try {
    return await withIdentityPodMutex(userId, async () => (await readLive(userId)).methods ?? emptyAuthMethods(userId));
  } catch (err) {
    log(`WARN: bootstrap claim of ${userId} not completed (unreadable): ${(err as Error).message}`);
    return 'unreadable';
  }
}

// ── SIWE auth (Ethereum wallet) ─────────────────────────────

/**
 * POST /auth/siwe — verify a SIWE message + signature, issue a bearer
 * token scoped to the user whose wallet is either already registered
 * or is being registered now (first-time flow).
 *
 * The message must be one checkSiweMessage accepts: addressed to this deployment on its first
 * line, naming the signing wallet on its second, and carrying the /challenges nonce on its
 * `Nonce:` line. A wallet already held by an account signs in to that account, bearer or not;
 * a bearer adds the wallet to its own account only when no account holds it, and only when
 * every account could be read (otherwise 503).
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
  if (typeof message !== 'string' || typeof signature !== 'string' || typeof nonce !== 'string'
    || !message || !signature || !nonce) {
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
  // The nonce alone does not tie the signature to this server: anyone can fetch one from
  // /challenges and put it in their own site's sign-in prompt. The domain line does.
  const checked = await checkSiweMessage(message, ch);
  if (checked.ok === false) {
    res.status(checked.status).json(checked.body);
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

  const claimedAddress = checked.address;
  if (claimedAddress !== recoveredAddress) {
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
  // Which account holds the wallet is decided, and the wallet written onto one, in the wallet's
  // turn (credentialDecisions): a sign-in made while a bearer adds this wallet to an account waits
  // for that write, and then signs in there, rather than opening the account derived from it.
  const walletKey = walletCredential(recoveredAddress);
  const turn = await credentialDecisions.decide(walletKey, async (): Promise<Identity | undefined> => {
    // Returning user via wallet index — no user-claim needed. A wallet several accounts list signs
    // in to the one derived from it, or to none (walletAccount). The index holds loaded accounts
    // only, and the derived account may list the wallet without being loaded: load it before
    // signing in to another account or refusing several, or the wallet would move to it once it
    // loads. A holder whose record no longer lists the wallet is not one (walletSignInAccount). A
    // pod that cannot be read signs nobody in.
    const indexed = await walletSignInAccount(recoveredAddress);
    if (indexed === 'unreadable') {
      res.status(503).json({ error: 'Could not read this account just now', detail: 'Nothing was changed; try signing in again in a minute.' });
      return;
    }
    if (indexed.kind === 'ambiguous') {
      refuseAmbiguousWallet(res, indexed);
      return;
    }
    let userId: string | undefined = indexed.kind === 'one' ? indexed.userId : undefined;
    let user = userId ? identities.get(userId) : undefined;
    // Set only where a bearer adds the wallet to its own account; every other account here lists
    // it already, and a sign-in writes nothing to it.
    let adding = false;
    // A sign-in to an account that already lists the wallet, and nothing else (the relay's
    // /sign-action page): it opens no account, adds the wallet to none and claims no invite, but
    // still finds the account the first-time path below would find.
    const existingOnly = req.body?.existingOnly === true;

    // Authenticated add-wallet: if a valid bearer is presented, bind this
    // newly-signed wallet to the caller's user (not a new one) — but only a
    // wallet no account holds. Not being in the wallet index does not show
    // that: the holder's pod may not have been read. The same check as
    // /wallet/link (walletHolder): a holder found on its pod is signed in to,
    // exactly as an indexed one is above, and a wallet whose holder cannot be
    // ruled out is not bound at all.
    // The epoch of the bearer's token, for the add's own check of the record it writes.
    let bearerEpoch = 0;
    if (!user && !existingOnly) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const tr = await verifyToken(authHeader.slice(7));
        // A bearer that does not verify adds nothing, and the request does not go on to open the
        // account derived from the wallet (refuseUnverifiedBearer).
        if (!tr.valid) {
          refuseUnverifiedBearer(res, tr);
          return;
        }
        bearerEpoch = tokenEpoch(authHeader.slice(7));
        const holder = await walletHolder(recoveredAddress, tr.record!.userId);
        if (holder.kind === 'unknown') {
          res.status(503).json({
            error: 'Could not check this wallet just now',
            detail: 'Not every account could be read, so this server cannot tell whether another account holds this wallet. Nothing was changed; try again in a minute.',
          });
          return;
        }
        if (holder.kind === 'held' && holder.account.kind === 'ambiguous') {
          refuseAmbiguousWallet(res, holder.account);
          return;
        }
        adding = holder.kind === 'free';
        userId = holder.kind === 'held' && holder.account.kind === 'one' ? holder.account.userId : tr.record!.userId;
        user = identities.get(userId);
        // The bearer's account was deleted while walletHolder read the pod (refuseUnverifiedBearer,
        // as for a bearer deleted before the request): it used to go on as a first sign-in, and
        // open the account derived from the wallet.
        if (adding && (!user || deletedUserIds.has(userId))) {
          refuseUnverifiedBearer(res, { reason: 'Account deleted' });
          return;
        }
      }
    }

    if (!user) {
      // No account this server has loaded holds the wallet. While some account is not loaded,
      // the wallet's may be one of them, so no account is opened for it (refuseWhileLoading); the
      // account derived from it can still be signed in to (read below, never created). An
      // existingOnly sign-in opens nothing either, whether accounts are loading or not. A
      // bootstrap claim only opens an account, so in both cases it is refused before
      // resolveTargetUserId spends the invite or anything reads the seeded pod.
      const loading = !accountIndexState.complete;
      // No account that lists the wallet was found. While accounts are loading, that is not "not
      // registered": the wallet's account may be one not loaded yet.
      const refuseUnknownWallet = (): void => {
        if (loading) refuseWhileLoading(res, 'wallet');
        else if (existingOnly) res.status(401).json({ error: 'This wallet is not registered. Sign in with an existing credential for the requested account.' });
        else res.status(401).json({ error: 'This wallet is not registered. Sign in with an existing credential for this account and add this wallet from there.' });
      };
      if ((loading || existingOnly) && (bootstrapUserId || bootstrapInvite)) {
        refuseUnknownWallet();
        return;
      }
      // Choose the target userId using the same three-mode logic as WebAuthn.
      // Mode (C) add-device is handled upstream (bearer token already
      // populated `user`); resolveTargetUserId here covers (A) derive and
      // (B) bootstrap-claim, pinned by tests/resolve-target-userid.test.ts
      // — in particular the enumeration-safe ordering of the existing-
      // credential guard before the invite check. The seeded pod is read
      // only with its invite, and written by nothing here (readBootstrapTarget).
      const existingForBootstrap = await readBootstrapTarget(bootstrapUserId, bootstrapInvite);
      if (existingForBootstrap === 'unreadable') {
        res.status(503).json({
          error: 'Could not read this account just now',
          detail: 'The pod holding this account did not answer. Nothing was changed; try signing in again in a minute.',
        });
        return;
      }
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
      const displayName = identities.get(targetUserId)?.name ?? String(name ?? targetUserId);
      const def = defaultAgentForRegistration(targetUserId, displayName, surfaceAgent);
      const agentId = [...identities.values()].find(i => i.type === 'agent' && i.owner === targetUserId)?.id ?? def.agentId;

      // Not in the wallet index is not "no such account": the pod may be one that was not
      // loaded, or this wallet may have been removed from it. Read the pod before writing, and
      // create the account only if it holds no credentials (first-sign-in.ts). This costs the
      // first sign-in a pod read and a synchronous write, which FIX A had deferred; a blind
      // deferred write is what replaced whole accounts with one wallet. While accounts are
      // loading, and for an existingOnly sign-in, only an account that already lists the wallet
      // is signed in to.
      const outcome = await claimFirstSignInOnPod(targetUserId, agentId, displayName,
        m => m.walletAddresses.some(a => a.toLowerCase() === recoveredAddress),
        m => { m.walletAddresses.push(recoveredAddress); }, /* mayCreate */ !loading && !existingOnly,
        /* derived */ resolved.mode === 'derive');
      if (outcome.kind === 'unreadable' || outcome.kind === 'unconfirmed') {
        log(`WARN: first-time SIWE sign-in to ${targetUserId} not completed (${outcome.kind}): ${outcome.reason}`);
        // Nothing settled what the pod holds after the failed write: the wallet may be on that
        // account, unseen by the indexes, so its next turn settles the account first.
        if (outcome.kind === 'unconfirmed' && outcome.undetermined) recordUnconfirmed(walletKey, targetUserId, outcome.pending, resolved.mode === 'derive');
        refuseUnfinishedFirstSignIn(res, outcome, resolved.mode === 'bootstrap' ? targetUserId : undefined);
        return;
      }
      if (outcome.kind === 'deleted') {
        if (resolved.mode === 'bootstrap') CONSUMED_INVITES.delete(targetUserId);
        res.status(409).json({ error: ACCOUNT_DELETED_MESSAGE });
        return;
      }
      if (outcome.kind === 'refused') {
        refuseUnknownWallet();
        return;
      }
      if (outcome.kind === 'returning') {
        // claimFirstSignInOnPod loaded it: a sign-in to an account that lists the credential (one
        // whose write this request made unconfirmed, found when the account was loaded, included).
        log(`Wallet ${recoveredAddress} signed in to ${targetUserId}, loaded from its pod (not in the wallet index)`);
      } else if (!identities.has(targetUserId)) {
        seedIdentity(targetUserId, 'user', displayName);
        seedIdentity(def.agentId, 'agent', def.label, targetUserId, 'ReadWrite');
      }
      user = identities.get(targetUserId)!;
      if (timingEnabled()) logTiming('siwe-pod-write-completed', requestStart, { branch: 'first-time' });
      // FIX A: identity-server no longer mirrors /profile/card or /<id>/agents.
      // The relay is now the single authoritative writer for both pod-side
      // documents and does so synchronously inside /oauth/verify before
      // returning the OAuth code — see deploy/mcp-relay/server.ts. Two
      // writers were previously racing each other on every OAuth completion,
      // causing CSS file-backend HTTP 500s on the second OAuth ("Read counter
      // would become negative" on /profile/card) and a ~10s 404 window for
      // any client polling those URLs immediately after auth.
      if (outcome.kind === 'created') log(`First-time SIWE registration: ${targetUserId} wallet=${recoveredAddress} defaultAgent=${agentId} (surfaceHint=${surfaceAgent ?? 'none'})`);
    } else if (adding) {
      // Add-wallet (authenticated) path: added to the record as the pod holds it, and answered
      // only once the pod has it, unless that record signed out everywhere since the bearer's
      // token was issued (signedOutSince).
      let signedOut = false;
      try {
        await commitCredentialEnrollment(user.id, 'siwe-add-wallet', methods => {
          signedOut = signedOutSince(methods, bearerEpoch);
          if (signedOut) return false;
          if (methods.walletAddresses.some(a => a.toLowerCase() === recoveredAddress)) return false;
          methods.walletAddresses.push(recoveredAddress);
        });
      } catch (err) {
        log(`SIWE credential enrollment not confirmed for ${user.id}: ${(err as Error).message}`);
        // A write the pod may have taken: what it holds now decides the answer, and reaches the
        // wallet index here (credentialAfterFailedAdd), so the wallet's next sign-in finds it.
        const onPod = await credentialAfterFailedAdd(walletKey, user.id, err, m => m.walletAddresses.some(a => a.toLowerCase() === recoveredAddress));
        if (onPod !== 'not-listed') {
          refuseUnconfirmedAdd(res, 'wallet', onPod);
          return;
        }
        if (sendAccountWriteRefusal(res, err)) return;
        res.status(503).json({ error: 'Credential enrollment could not be confirmed. No permanent session was issued.' });
        return;
      }
      if (signedOut) {
        res.status(401).json({ error: SIGNED_OUT_DURING_ADD });
        return;
      }
      if (timingEnabled()) logTiming('siwe-pod-write-completed', requestStart, { branch: 'add-wallet' });
      log(`Wallet ${recoveredAddress} linked to existing user ${user.id}`);
    }
    return user;
  });
  if (turn.kind !== 'decided') {
    refuseCredentialTurn(res, turn, 'wallet');
    return;
  }
  if (!turn.value) return;

  res.json(await issueTokenResponse(turn.value, surfaceAgent));
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
  let addDeviceEpoch = 0;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const tr = await verifyToken(authHeader.slice(7));
    if (!tr.valid) {
      refuseBearer(res, tr);
      return;
    }
    addDeviceUserId = tr.record!.userId;
    addDeviceEpoch = tokenEpoch(authHeader.slice(7));
  }

  // Mode (B): validate bootstrap invite (do NOT consume yet — consumption
  // happens at /register after the ceremony actually verifies).
  if (bootstrapUserId || bootstrapInvite) {
    if (!bootstrapUserId || !bootstrapInvite) {
      res.status(400).json({ error: 'bootstrapUserId and bootstrapInvite must both be supplied' });
      return;
    }
    if (!bootstrapInviteMatches(bootstrapUserId, bootstrapInvite)) {
      res.status(401).json({ error: 'Bootstrap credential invalid or already consumed' });
      return;
    }
    if (CONSUMED_INVITES.has(bootstrapUserId)) {
      res.status(409).json({ error: `Bootstrap invite for '${bootstrapUserId}' has already been consumed` });
      return;
    }
  }

  // While some account is not loaded, /register refuses every passkey (refuseWhileLoading), and
  // by then the browser has created it: a discoverable passkey on the user's authenticator that
  // no account lists, offered by the passkey picker from then on, one more with each retry. So
  // no ceremony starts. Refused after the bearer and invite checks, whose answers do not depend
  // on loading, and before the seeded account's pod or the signed-in account's passkeys are read.
  if (!accountIndexState.complete) {
    refuseWhileLoading(res, 'passkey', true);
    return;
  }

  let bootstrapTargetUserId: string | undefined;
  if (bootstrapUserId) {
    // Additional guard: if the seeded user already has any credential on
    // file, the invite flow is locked out regardless of invite validity.
    // Read from the pod as /register reads it, creating nothing: no ceremony has run yet, and
    // one abandoned now would leave an empty document behind. An unreadable pod is not an
    // account without credentials.
    let existing: AuthMethods;
    try {
      existing = await withIdentityPodMutex(bootstrapUserId, async () => (await readLive(bootstrapUserId)).methods ?? emptyAuthMethods(bootstrapUserId));
    } catch (err) {
      log(`WARN: bootstrap passkey registration options for ${bootstrapUserId} not issued (unreadable): ${(err as Error).message}`);
      res.status(503).json({ error: 'Could not read this account just now', detail: 'Nothing was changed; try registering again in a minute.' });
      return;
    }
    if (isTombstone(existing)) {
      res.status(409).json({ error: ACCOUNT_DELETED_MESSAGE });
      return;
    }
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
  if (addDeviceUserId) {
    ch.addDeviceUserId = addDeviceUserId;
    ch.addDeviceEpoch = addDeviceEpoch;
  }
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
 *   - else (mode A): derived from the new credential's ID; may only create
 *     that account, never join one that already holds credentials
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

  // The account a fresh registration of this id opened is derived from it, and may list it
  // without being loaded here (opened on the other instance while a deploy overlapped the two):
  // load it, so an id it holds is refused below rather than added to another account with a
  // copy of its key. A fresh registration reads that account's pod below anyway.
  if ((ch.addDeviceUserId || ch.bootstrapUserId)
    && await ensureAccountLoaded(deriveUserIdFromCredentialId(credentialId)) === 'unreadable') {
    res.status(503).json({ error: 'Could not read this account just now', detail: 'Nothing was changed; try registering again in a minute.' });
    return;
  }
  // Reject a credential we've seen before — either as a duplicate register
  // attempt, or (extremely unlikely) as a 256-bit collision.
  if (credentialIndex.has(credentialId)) {
    res.status(409).json({ error: 'This credential is already registered' });
    return;
  }
  // Absent from the index says nothing while some account is not loaded: the id may be one an
  // unloaded account lists, sent here with a copy of that account's public key ('none'
  // attestation proves nothing about the private key), and the owner's usernameless sign-in
  // would then find only the copy. So no passkey is registered, in any mode, until every
  // account is loaded: refused before the bootstrap invite is spent or any pod is written.
  // /register-options refuses first, so no ceremony starts; this catches a challenge from POST
  // /challenges, which issues one for a fresh registration without the options.
  if (!accountIndexState.complete) {
    refuseWhileLoading(res, 'passkey', true);
    return;
  }

  const record: AuthMethods['webAuthnCredentials'][number] = {
    id: credentialId,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: (response.response?.transports as string[] | undefined) ?? [],
    createdAt: new Date().toISOString(),
    rpId: ch.rpId ?? RP_ID,
    rpOrigin: ch.rpOrigin ?? RP_ORIGIN,
  };

  // Resolve the target userId according to the mode established at
  // /register-options time (already authorised there).
  let targetUserId: string;
  let created = false;
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
    // Whether somebody else bound a credential in the interim, or the account was deleted, is
    // decided on the record as the pod holds it, by the one write below that binds this passkey.
    targetUserId = ch.bootstrapUserId;
  } else {
    // Mode (A) fresh user — derive userId from the credential itself.
    targetUserId = deriveUserIdFromCredentialId(credentialId);
    // This mode may only CREATE an account. Not being in the credential index says nothing
    // about the derived account: it may not be loaded yet, its owner may have removed this
    // passkey, or another credential id may derive to the same 48-bit id — and credential
    // ids are not secret, so a software authenticator can present anyone's. Read the pod
    // under its mutex and create the account only if it holds no credentials
    // (first-sign-in.ts); a passkey for an existing account is added from inside it (mode C).
    const agentId = [...identities.values()].find(i => i.type === 'agent' && i.owner === targetUserId)?.id
      ?? defaultAgentForRegistration(targetUserId, displayName, surfaceAgent).agentId;
    const outcome = await claimFirstSignInOnPod(targetUserId, agentId, displayName,
      () => false,
      m => {
        if (!m.name || m.name === targetUserId) m.name = displayName;
        m.webAuthnCredentials.push(record);
      }, /* mayCreate */ true, /* derived */ true);
    if (outcome.kind === 'unreadable') {
      log(`WARN: passkey registration of ${targetUserId} not completed (unreadable): ${outcome.reason}`);
      res.status(503).json({
        error: 'Could not read this account just now',
        detail: 'The pod for this passkey did not answer. Nothing was changed; try registering again in a minute.',
      });
      return;
    }
    if (outcome.kind === 'deleted') {
      res.status(409).json({ error: ACCOUNT_DELETED_MESSAGE });
      return;
    }
    if (outcome.kind !== 'created') {
      // Load what the pod holds, with no token: a create the pod applied without confirming
      // it, or an account the indexes missed, can then be signed in to, as both answers say.
      await ensureAccountLoaded(targetUserId);
      if (outcome.kind === 'unconfirmed') {
        log(`WARN: passkey registration of ${targetUserId} not confirmed: ${outcome.reason}`);
        // What the pod holds once the failed write was settled (final), unless nothing could settle it.
        const saved = !!outcome.onPod?.webAuthnCredentials.some(c => c.id === record.id && c.publicKey === record.publicKey);
        res.status(503).json({
          error: 'Your passkey could not be confirmed as saved',
          detail: saved
            ? 'The pod did not confirm the write, but it lists this passkey now: sign in with it. No session was issued here.'
            : outcome.undetermined
              ? 'The pod did not confirm the write, and could not be read after it, so it may or may not have been saved. Try signing in with this passkey in a minute; if that does not work, register again.'
              : 'The pod did not take the write, so this passkey was not saved. Register it again.',
        });
        return;
      }
      res.status(409).json({ error: 'This passkey cannot be registered as a new account; sign in, then add it from your account' });
      return;
    }
    created = true;
  }

  // An add-device challenge issued before the account was deleted is refused here, before any
  // shell is seeded for it (commitCredentialEnrollment below refuses it too).
  if (deletedUserIds.has(targetUserId)) {
    res.status(409).json({ error: ACCOUNT_DELETED_MESSAGE });
    return;
  }

  // Ensure an Identity shell exists for the target. Seeded users already
  // have one; derived users get created here on first touch.
  let user = identities.get(targetUserId);
  const seeded: string[] = [];
  if (!user) {
    seedIdentity(targetUserId, 'user', displayName);
    seeded.push(targetUserId);
    user = identities.get(targetUserId)!;
  }
  // Make sure the user has a default agent to issue tokens for.
  const hasAgent = [...identities.values()].some(i => i.type === 'agent' && i.owner === targetUserId);
  if (!hasAgent) {
    const def = defaultAgentForRegistration(targetUserId, displayName, surfaceAgent);
    seedIdentity(def.agentId, 'agent', def.label, targetUserId, 'ReadWrite');
    seeded.push(def.agentId);
    log(`First-time WebAuthn registration: ${targetUserId} defaultAgent=${def.agentId} (surfaceHint=${surfaceAgent ?? 'none'})`);
  }

  // Mode (A) wrote its new account above; modes (B) and (C) append to theirs, on the record as
  // the pod holds it. A bootstrap claim may create the seeded account's document, and only
  // binds a passkey to one that holds no credential yet; an added device needs the document.
  if (!created) {
    const bootstrap = !ch.addDeviceUserId && !!ch.bootstrapUserId;
    let refusal: 'claimed' | 'signed-out' | undefined;
    // Nothing was enrolled, so the shell seeded above for it goes again: left in memory it
    // would make the account look loaded (its profile and did:web document resolvable).
    const rollBack = () => { for (const id of seeded.splice(0)) { identities.delete(id); keys.delete(id); } };
    const listsPasskey = (m: AuthMethods | null | undefined) => !!m?.webAuthnCredentials.some(c => c.id === record.id);
    try {
      await commitCredentialEnrollment(targetUserId, bootstrap ? 'webauthn-bootstrap' : 'webauthn-register', methods => {
        refusal = undefined;
        if (bootstrap && hasAnyCredential(methods)) { refusal = 'claimed'; return false; }
        // An added device: not onto an account that signed out everywhere since the options.
        if (ch.addDeviceUserId && signedOutSince(methods, ch.addDeviceEpoch ?? 0)) { refusal = 'signed-out'; return false; }
        if (methods.webAuthnCredentials.some(c => c.id === record.id)) return false;
        if (!methods.name || methods.name === targetUserId) methods.name = user.name;
        if (!methods.agentId) {
          const a = [...identities.values()].find(i => i.type === 'agent' && i.owner === targetUserId);
          if (a) methods.agentId = a.id;
        }
        methods.webAuthnCredentials.push(record);
      }, bootstrap ? { absent: 'create' } : {});
    } catch (err) {
      log(`WebAuthn credential enrollment not confirmed for ${targetUserId}: ${(err as Error).message}`);
      // A write whose outcome is unknown (a 5xx, a timeout) may have landed. The writer settled
      // what the pod holds under the lock (a write it never answered fenced first, so it cannot
      // land afterwards) and this server now holds that (the passkey indexed to this account
      // when it is there), so the shell seeded above stays with it, and so does a spent invite:
      // the pod lists a credential, which refuses any other claim anyway.
      const unknownOutcome = err instanceof AuthMethodsWriteError && err.unknownOutcome;
      let after = unknownOutcome ? (err as AuthMethodsWriteError).podRecord as AuthMethods | null | undefined : null;
      if (unknownOutcome && after === undefined) {
        // Not settled under the lock: settle the account once more (a seeded one gets its shell
        // from the record, as at startup), so a passkey the pod took signs in.
        try {
          after = await readAccountNow(targetUserId, (err as AuthMethodsWriteError).pending);
        } catch { /* still undetermined */ }
      }
      const saved = listsPasskey(after);
      const undetermined = unknownOutcome && after === undefined;
      if (saved) {
        if (!identities.has(targetUserId) && after) hydrateFromAuthMethods(targetUserId, after);
        res.status(503).json({
          error: 'Your passkey could not be confirmed as saved',
          detail: 'The pod did not confirm the write, but it lists this passkey now: sign in with it. No session was issued here.',
        });
        return;
      }
      rollBack();
      // Not written, as far as the pod shows, so a bootstrap invite spent above is still unused:
      // give it back, or every retry is refused as "already consumed". A passkey that did land
      // unseen (undetermined) refuses any other claim of the seeded account anyway.
      if (bootstrap) CONSUMED_INVITES.delete(targetUserId);
      if (undetermined) {
        res.status(503).json({
          error: 'Your passkey could not be confirmed as saved',
          detail: 'The pod did not confirm the write, so it may or may not have been saved. Try signing in with this passkey in a minute; if that does not work, register it again.',
        });
        return;
      }
      if (sendAccountWriteRefusal(res, err)) return;
      res.status(503).json({ error: 'Credential enrollment could not be confirmed. No permanent session was issued.' });
      return;
    }
    if (refusal === 'claimed') {
      // Somebody else bound a credential to the seeded account first: the invite stays spent.
      rollBack();
      res.status(401).json({ error: 'Bootstrap credential invalid or already consumed' });
      return;
    }
    if (refusal === 'signed-out') {
      rollBack();
      res.status(401).json({ error: SIGNED_OUT_DURING_ADD });
      return;
    }
  }
  // FIX A: identity-server no longer mirrors /profile/card or /<id>/agents.
  // Single authoritative pod-side writer is the relay's /oauth/verify
  // handler — see deploy/mcp-relay/server.ts. See SIWE first-touch comment
  // above for the race / 500 / 404-window background.
  log(`WebAuthn credential registered for ${targetUserId} (mode=${ch.addDeviceUserId ? 'add-device' : ch.bootstrapUserId ? 'bootstrap' : 'derive'})`);

  res.json(await issueTokenResponse(user, surfaceAgent));
});

type PasskeySignIn =
  | { kind: 'signed-in'; userId: string }
  | { kind: 'deleted' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'unpersisted'; reason: string }
  /** The counter write failed and nothing could settle it: it may or may not have been saved. */
  | { kind: 'undetermined'; reason: string }
  | { kind: 'not-on-file' }
  | { kind: 'not-verified'; lastError: unknown };

/**
 * A passkey sign-in, tried at each holder in the index's stable order (the earliest-enrolled
 * first); the first whose stored key verifies the assertion is the passkey's account.
 *
 * Each holder is checked against its record as the pod holds it, under the account's lock
 * (updateAuthMethods): a credential this server's copy still lists may have been removed by
 * the other instance or by hand. Only the credential's sign counter and relying-party binding
 * change, and nothing is written when neither does (a synced passkey reports counter 0, and the
 * binding is pinned at its first sign-in), so the usual sign-in is one read and no write.
 *
 * Each public key is tried once, at its earliest holder. A later holder storing the same key
 * would give the same answer, except where the answer turned on the earlier holder's record: a
 * sign counter at or above the assertion's is refused before the signature is checked, and a
 * later copy of the key with a lower counter would then accept the assertion it refused. Keys
 * are compared as keys (publicKeyIdentity): a copy's registrant chooses its COSE bytes. A key
 * counts as tried only once its holder's call has returned: the check may run again after a
 * precondition failure, and must give the same answer then.
 *
 * A holder deleted in this process since the route read the holders refuses before reading;
 * the assertion is then checked against the copy this server held before (the snapshot), and if
 * it verifies there, the passkey's account was deleted ('deleted').
 */
async function signInWithPasskey(
  holders: readonly string[],
  response: import('@simplewebauthn/server').AuthenticationResponseJSON,
  challenge: string,
  rpId: string,
  origin: string,
): Promise<PasskeySignIn> {
  // Taken before any lock: a deletion clears this server's copy of the account it deletes.
  const snapshot = new Map(holders.map(id => [id, authMethodsCache.get(id)?.value] as const));
  const triedKeys = new Set<string>();
  let lastError: unknown;
  let onFile = false;
  for (const userId of holders) {
    const known = snapshot.get(userId)?.webAuthnCredentials.find(c => c.id === response.id);
    if (known && triedKeys.has(await publicKeyIdentity(known.publicKey))) continue;
    let attemptedKey: string | undefined;
    // The counter and pin this attempt writes, to recognise them on the pod after a failed write.
    let writing: { counter: number; rpId: string } | undefined;
    let result: UpdateResult<AuthMethods>;
    try {
      result = await updateAuthMethods(userId, 'passkey-sign-in', async (draft, live) => {
        attemptedKey = undefined;
        writing = undefined;
        const cred = live ? draft.webAuthnCredentials.find(c => c.id === response.id) : undefined;
        if (!cred) return NoWrite('not-on-file');
        const key = await publicKeyIdentity(cred.publicKey);
        attemptedKey = key;
        if (triedKeys.has(key)) return NoWrite('same-key');
        const verified = await verifyPasskeyAssertion({ credential: cred, response, challenge, rpId, origin });
        if (verified.ok === false) return NoWrite('not-verified', verified.error);
        const stored = Number.isFinite(cred.counter) ? cred.counter : 0;
        if (verified.newCounter <= stored && cred.rpId === rpId && cred.rpOrigin) return NoWrite('verified-unchanged');
        cred.counter = Math.max(stored, verified.newCounter);
        cred.rpId = rpId;
        cred.rpOrigin ??= origin;
        writing = { counter: cred.counter, rpId };
        return Write;
      }, { absent: 'pass' });
    } catch (err) {
      if (err instanceof PodReadError) return { kind: 'unreadable', reason: err.message };
      // A write the pod took without confirming it (a 5xx after applying it, a timeout) is a
      // sign-in: the record the writer settled under the lock holds exactly this counter and pin.
      // One that nothing could settle may or may not have been saved, and is answered so.
      if (err instanceof AuthMethodsWriteError && writing) {
        const onPod = changeOnPod(err, m =>
          m.webAuthnCredentials.some(c => c.id === response.id && c.counter === writing!.counter && c.rpId === writing!.rpId));
        if (onPod === 'landed') {
          log(`WARN: passkey sign-in to ${userId}: the pod took the counter write without confirming it (${err.message})`);
          return { kind: 'signed-in', userId };
        }
        if (onPod === 'undetermined') return { kind: 'undetermined', reason: err.message };
      }
      if (err instanceof AuthMethodsWriteError || err instanceof AuthMethodsConflictError) return { kind: 'unpersisted', reason: err.message };
      if (err instanceof AccountRecordMissingError || err instanceof PlayOwnerUnavailableError) continue;
      if (err instanceof AccountDeletedError) {
        const before = snapshot.get(userId);
        const cred = before?.webAuthnCredentials.find(c => c.id === response.id);
        if (cred && (await verifyPasskeyAssertion({ credential: cred, response, challenge, rpId, origin })).ok) return { kind: 'deleted' };
        continue;
      }
      throw err;
    }
    if (attemptedKey !== undefined) triedKeys.add(attemptedKey);
    if (result.written === true) return { kind: 'signed-in', userId };
    const { reason, detail } = result as { reason: string; detail?: unknown };
    if (reason === 'verified-unchanged') return { kind: 'signed-in', userId };
    if (reason !== 'not-on-file') onFile = true;
    if (reason === 'not-verified') lastError = detail;
  }
  return onFile ? { kind: 'not-verified', lastError } : { kind: 'not-on-file' };
}

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
  // The account a fresh registration of this id opened is derived from it, and may list it
  // without being loaded (the startup scan has not reached it, its pod is unreadable, or the
  // other instance opened it while a deploy overlapped the two). It is loaded whenever it is not
  // a holder already, as for wallets and did:keys: a copy of its key under its id on another
  // account would otherwise be the only holder tried, and take the owner's sign-in.
  if (typeof response.id === 'string'
    && !credentialIndex.candidates(response.id).includes(deriveUserIdFromCredentialId(response.id))
    && await ensureAccountLoaded(deriveUserIdFromCredentialId(response.id)) === 'unreadable') {
    res.status(503).json({ error: 'Could not read this account just now', detail: 'Nothing was changed; try signing in again in a minute.' });
    return;
  }
  // Canonical lookup: credential id → the accounts listing it. We never trust a body-supplied
  // userId claim; the identity is whichever account's stored key verifies the ceremony.
  if (!credentialIndex.has(response.id)) {
    // Some pods have not been read yet, so this passkey may belong to one of them.
    // Saying "no match" here is what sent people to register a new account.
    if (!accountIndexState.complete) refuseWhileLoading(res, 'passkey');
    else res.status(401).json({ error: 'No WebAuthn credential matches this response' });
    return;
  }

  const expectedChallenge = response?.response?.clientDataJSON
    ? JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString()).challenge
    : null;
  if (!expectedChallenge) {
    res.status(400).json({ error: 'Could not extract challenge from clientDataJSON' });
    return;
  }
  // Single-use and independent of the account, so it is spent before any holder is tried.
  const ch = consumeChallenge(expectedChallenge, 'webauthn-authenticate');
  // A challenge scoped to a userId at issuance time tries that account only: no cross-account
  // reuse.
  const scoped = ch
    ? credentialIndex.candidates(response.id, deriveUserIdFromCredentialId(response.id)).filter(id => !ch.userId || id === ch.userId)
    : [];
  if (!ch || scoped.length === 0) {
    res.status(401).json({ error: 'Invalid or expired authentication challenge' });
    return;
  }
  // No holder verified. A usernameless sign-in tries the loaded accounts only, so while some
  // are not loaded the passkey's own account may be one of them (a loaded holder may list its id
  // with a key of its own): say so, as for an id no account lists. A challenge scoped to an
  // account loaded that account.
  const noHolderVerified = (status: number, error: string): void => {
    if (!ch.userId && !accountIndexState.complete) refuseWhileLoading(res, 'passkey');
    else res.status(status).json({ error });
  };
  if (!(await loadIndexedHolders(scoped))) {
    res.status(503).json({ error: 'Could not read this account just now', detail: 'Nothing was changed; try signing in again in a minute.' });
    return;
  }
  const holders = scoped.filter(id => identities.get(id)?.type === 'user' && !deletedUserIds.has(id));
  if (holders.length === 0) {
    noHolderVerified(404, 'User for credential not found');
    return;
  }
  // Bounded work, never a refusal: refusing a crowded id would let anyone who adds it to enough
  // accounts lock its owner out. Of the loaded accounts, the owner's enrolled the id first, so it
  // is tried.
  if (holders.length > MAX_HOLDERS) log(`WARN identity_credential_multi_holder kind=webauthn holders=${holders.length} tried=${MAX_HOLDERS}`);
  const outcome = await signInWithPasskey(holders.slice(0, MAX_HOLDERS), response, expectedChallenge,
    ch.rpId ?? RP_ID, ch.rpOrigin ?? RP_ORIGIN);
  switch (outcome.kind) {
    case 'signed-in': {
      const user = identities.get(outcome.userId);
      if (!user) {
        res.status(404).json({ error: `User for credential not found` });
        return;
      }
      res.json(await issueTokenResponse(user, surfaceAgent));
      return;
    }
    case 'deleted':
      // The passkey's account was deleted while this sign-in was verified; nothing was written.
      res.status(409).json({ error: ACCOUNT_DELETED_MESSAGE });
      return;
    case 'unreadable':
      // A holder's record could not be read, so whether it verifies is unknown: stop rather
      // than let a later holder take the sign-in.
      log(`WARN: refused passkey auth — ${outcome.reason}`);
      res.status(503).json({ error: 'Could not read this account just now', detail: 'Nothing was changed; try signing in again in a minute.' });
      return;
    case 'unpersisted':
      // It verified, so this was the passkey's account: stop rather than try another.
      log(`WARN: refused passkey auth — ${outcome.reason}`);
      res.status(503).json({ error: 'transient: failed to persist passkey counter and RP binding; retry' });
      return;
    case 'undetermined':
      // It verified, and its counter write may have landed: "failed to persist" would be untrue.
      log(`WARN: refused passkey auth — ${outcome.reason}`);
      refuseUndeterminedChange(res, 'transient: passkey sign-in not confirmed',
        'Signing in again with this passkey is safe.');
      return;
    case 'not-on-file':
      noHolderVerified(401, 'Credential indexed but not on file');
      return;
    case 'not-verified':
      noHolderVerified(401, `WebAuthn verification failed: ${(outcome.lastError as Error | undefined)?.message ?? 'no holder verified'}`);
      return;
  }
});

// ── Generic DID-signature auth (did:key / did:web) ──────────

/**
 * One line for a signature over the bare nonce: enough to find the client; never the DID, the
 * nonce, the signature, an invite or a token. With `signedIn`: a sign-in made with one, written
 * once the token for that account is issued (`accepted`). A signature refused later on (a key no
 * account lists for this DID, a pod that cannot be read) signed nobody in and writes no line, as
 * that refusal does not depend on the setting. Without: the signature, refused at its check
 * because DID_ACCEPT_BARE_NONCE is 0 (`refused`). No account has been looked up then, so for a
 * DID that is not a did:key, `derivedUserId` names whatever DID was sent with the caller's key.
 */
function logBareNonceSignature(req: express.Request, did: string, ch: Challenge, surfaceAgent: unknown, signedIn?: string): void {
  const method = /^did:([a-z0-9]{1,16}):/.exec(did)?.[1] ?? 'other';
  const surface = surfaceAgent === undefined ? '-'
    : typeof surfaceAgent === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(surfaceAgent) ? surfaceAgent : 'invalid';
  log(`WARN identity_did_bare_nonce outcome=${signedIn ? 'accepted' : 'refused'} purpose=${ch.purpose === 'did-sig' ? 'did-sig' : 'none'} method=${method} derivedUserId=${deriveUserIdFromDid(did)} userId=${signedIn ?? '-'} surface=${surface} ua=${logValue(req.get('user-agent'))} origin=${logValue(req.get('origin'))}`);
}

/**
 * POST /auth/did — verify an Ed25519 signature against a pre-registered
 * DID key. Supports did:key (self-sovereign, public-key-encoded-as-DID)
 * and other DIDs such as did:web, whose key the caller sends in
 * publicKeyMultibase (no DID document is fetched). Such a DID signs in
 * only to an account that lists it with that key, and cannot open an
 * account by itself: add it with a bearer token (or bootstrap invite).
 *
 * The signature is checked against the message stored with the challenge,
 * which names this server and carries the nonce. A signature over the bare
 * nonce names no server. It is accepted only while DID_ACCEPT_BARE_NONCE is
 * unset or 1, with Deprecation and Warning headers, and a sign-in made with
 * one logs an identity_did_bare_nonce line naming the account signed in to.
 * With 0 it is refused with 401, and logged.
 *
 * Body: {
 *   did: string,              // did:key:z... or did:web:...
 *   nonce: string,            // from /challenges with purpose 'did-sig'
 *   signature: string,        // base64url Ed25519 signature over the UTF-8 bytes of that challenge's message
 *   userId?: string,          // first-time: register this DID to this user
 *   name?: string,            // first-time display name
 *   publicKeyMultibase?: string,  // required for a DID that is not a did:key
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
  // Strings only: a JSON array or object here threw in did.startsWith below, and an async
  // handler's rejection is not caught, so one such body ended the process.
  if (!did || !nonce || !signature
    || typeof did !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') {
    res.status(400).json({ error: 'did, nonce, and signature are required strings' });
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
  // A did:key names its own key; any other DID is verified against the key the caller sends.
  const keyFromDid = did.startsWith('did:key:z') && did.length > 10;
  const cached = keyFromDid ? getCachedParsedDid(did) : undefined;
  if (cached) {
    publicKeyRaw = cached.publicKeyRaw;
    didKeyFormat = cached.format;
    if (timingEnabled()) logTiming('did-parse', parseStart, { did: did.slice(0, 24), cache: 'hit' });
  } else if (keyFromDid) {
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
    // Checked before the key is cached, so a cache hit is a usable key.
    if (isSmallOrderEd25519Key(parsed.publicKey)) {
      res.status(400).json({ error: DID_KEY_NOT_USABLE });
      return;
    }
    if (parsed.format === 'base64url-legacy') {
      log(`[did-key-legacy] accepted base64url-encoded did:key for ${logValue(did, 24)}…; client should migrate to W3C base58btc encoding`);
    }
    publicKeyRaw = parsed.publicKey;
    didKeyFormat = parsed.format;
    setCachedParsedDid(did, publicKeyRaw, didKeyFormat);
    if (timingEnabled()) logTiming('did-parse', parseStart, { did: did.slice(0, 24), cache: 'miss', format: didKeyFormat });
  } else if (typeof publicKeyMultibase === 'string' && publicKeyMultibase.startsWith('z')) {
    // Caller-supplied publicKeyMultibase for non-did:key DIDs (did:web, etc.). It proves only
    // that the caller holds this key, so it is checked against the account below, and it is
    // never cached: a key one caller sent must not stand in for another caller's request.
    const decoded = decodeEd25519PublicKeyMultibase(publicKeyMultibase);
    if (!decoded) {
      res.status(400).json({ error: 'Could not decode publicKeyMultibase — tried W3C base58btc(0xed 0x01 || key) and legacy base64url(rawKey); neither yielded a 32-byte Ed25519 public key' });
      return;
    }
    if (isSmallOrderEd25519Key(decoded.publicKey)) {
      res.status(400).json({ error: DID_KEY_NOT_USABLE });
      return;
    }
    if (decoded.format === 'base64url-legacy') {
      log(`[did-key-legacy] accepted base64url-encoded publicKeyMultibase for ${logValue(did, 200)}; client should migrate to W3C base58btc encoding`);
    }
    publicKeyRaw = decoded.publicKey;
    if (timingEnabled()) logTiming('did-parse', parseStart, { did: did.slice(0, 24), cache: 'none', format: decoded.format, source: 'multibase' });
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

  // Verify the Ed25519 signature over the challenge's message, the bytes /challenges handed out.
  // A signature over the bare nonce (all a challenge with no purpose has) names no server: it is
  // accepted only while DID_ACCEPT_BARE_NONCE allows it. Refused, it is logged here; accepted, it
  // is logged once the sign-in is done (logBareNonceSignature).
  //
  // crypto.createPublicKey(...) does ~30ms of native work on the first
  // call in the process (lazy-loads OpenSSL EVP_PKEY + ed25519 curve
  // params) and ~0.3ms thereafter. The KeyObject is immutable, so we
  // cache it keyed on hex(publicKeyRaw) — every subsequent /auth/did
  // for the same DID skips the SPKI assembly + KeyObject build entirely.
  const verifyStart = timingEnabled() ? startTiming() : 0;
  let proof: 'message' | 'bare-nonce' | null = null;
  try {
    const sig = Buffer.from(signature, 'base64url');
    const verifyKey = getOrCreateEd25519VerifyKey(publicKeyRaw);
    if (ch.message !== undefined && crypto.verify(null, Buffer.from(ch.message, 'utf8'), verifyKey, sig)) proof = 'message';
    else if (crypto.verify(null, Buffer.from(nonce, 'utf8'), verifyKey, sig)) proof = 'bare-nonce';
    if (timingEnabled()) logTiming('did-verify', verifyStart, { ok: proof !== null, proof: proof ?? 'none' });
  } catch (err) {
    res.status(401).json({ error: `DID signature verification error: ${(err as Error).message}` });
    return;
  }
  if (proof === null) {
    res.status(401).json({ error: DID_SIGNATURE_FAILED });
    return;
  }
  if (proof === 'bare-nonce') {
    if (!DID_ACCEPT_BARE_NONCE) {
      logBareNonceSignature(req, did, ch, surfaceAgent);
      res.status(401).json({ error: DID_BARE_NONCE_REFUSED });
      return;
    }
    res.setHeader('Deprecation', 'true');
    // Appended: a legacy-form did:key has set a Warning of its own above.
    res.append('Warning', '299 - "a DID signature over the bare nonce is deprecated; sign the message POST /challenges returns"');
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

  // As for SIWE: which account holds the DID is decided, and the DID written onto one, in the
  // DID's turn (credentialDecisions). Only a request that can change who holds it takes the turn.
  // A did:key's signature proves its key, so every such request is its holder's. A DID that is
  // not a did:key proves only the key the caller sent, so anyone can present the owner's did:web
  // with a key of their own; such a request takes the turn only when it can write: with a bearer
  // that verifies (adding it), or with a bootstrap claim whose invite matches its seeded id (the
  // fields' mere presence used to count, so any request could take the turn). A plain sign-in
  // with it writes nothing and opens no account (it signs in only where a record lists the DID
  // with this key), so it is decided outside the turn: requests with keys of their own cannot
  // queue ahead of the owner's sign-in. The exception is a DID with a write recorded as
  // unconfirmed (credentialDecisions.unconfirmed): its next request of any kind takes the turn,
  // which settles the account that write was for before anything is decided, as for a did:key.
  //
  // The bearer is verified once, here, and decideDid adds the DID on this same answer, so whether
  // the request takes the turn and whether it adds the DID cannot disagree. A second check inside
  // decideDid could pass where this one failed (an account read that failed, then answered), and
  // the add then ran outside the turn, beside another bearer's add of the same DID. A bearer that
  // fails this check adds nothing, and the request does not go on to open the account derived from
  // the DID either (refuseUnverifiedBearer). What can change while the request waits for the turn
  // is the account signing out everywhere, or being deleted: the add checks the first on the record
  // it writes (signedOutSince), and the second once it has the turn, and both only ever to refuse.
  const didKey = didCredential(did);
  const bearerHeader = req.headers.authorization;
  const bearer = bearerHeader?.startsWith('Bearer ') ? await verifyToken(bearerHeader.slice(7)) : undefined;
  const bearerUserId = bearer?.valid ? bearer.record!.userId : undefined;
  const bearerEpoch = bearer?.valid ? tokenEpoch(bearerHeader!.slice(7)) : 0;
  const takesTurn = keyFromDid || bearerUserId !== undefined || bootstrapInviteMatches(bootstrapUserId, bootstrapInvite)
    || credentialDecisions.unconfirmedFor(didKey) !== undefined;
  const decideDid = async (): Promise<Identity | undefined> => {
    // Returning user via DID index — no user-claim needed. Every account listing this DID is a
    // candidate, in a stable order (for a DID that is not a did:key, the earliest-enrolled first;
    // then the account derived from the DID, then by id), at most MAX_HOLDERS of them.
    const indexLookupStart = timingEnabled() ? startTiming() : 0;
    const derivedDidUserId = deriveUserIdFromDid(did);
    const indexedDidHolders = () => didIndex.candidates(did, derivedDidUserId).filter(id => identities.get(id)?.type === 'user');
    if (!(await loadIndexedHolders(didIndex.candidates(did, derivedDidUserId)))) {
      res.status(503).json({ error: 'Could not read this account just now', detail: 'Nothing was changed; try signing in again in a minute.' });
      return;
    }
    let allDidHolders = indexedDidHolders();
    if (timingEnabled()) logTiming('did-index-lookup', indexLookupStart, { hit: allDidHolders.length > 0 });
    // A did:key goes to the account derived from it when that is a holder, and the index holds
    // loaded accounts only: load the derived account before signing in to another, or the DID
    // would move to it once it loads. A pod that cannot be read signs nobody in.
    if (keyFromDid && allDidHolders.length > 0 && allDidHolders[0] !== derivedDidUserId) {
      if (await ensureAccountLoaded(derivedDidUserId) === 'unreadable') {
        res.status(503).json({ error: 'Could not read this account just now', detail: 'Nothing was changed; try signing in again in a minute.' });
        return;
      }
      allDidHolders = indexedDidHolders();
    }
    if (allDidHolders.length > MAX_HOLDERS) log(`WARN identity_credential_multi_holder kind=did holders=${allDidHolders.length} tried=${MAX_HOLDERS}`);
    const didHolders = allDidHolders.slice(0, MAX_HOLDERS);
    let userId: string | undefined;
    let user: Identity | undefined;
    // Set only where a bearer adds the DID to its own account; every other account here lists it
    // already, and a sign-in writes nothing to it.
    let adding = false;
    if (didHolders.length) {
      // Sign in to the first account whose record lists the DID with the key that signed. A did:key
      // is its own key: every account listing it was bound by that key's holder. For a DID that is
      // not, the signature proved only that the caller holds the key it sent, so another account
      // listing the DID with a key of its own choosing can neither take this sign-in nor block it.
      // Each record is read again (readForDecision: from its pod once this server's copy is 10 s
      // old), as a record can drop the DID unseen here (the other instance removes it while a
      // deploy overlaps the two, or an operator by hand): such a holder drops out of the index and
      // is passed over, and nothing writes the DID back. A holder that cannot be read signs nobody in.
      for (const id of didHolders) {
        const m = await readForDecision(id);
        if (m === 'unreadable') {
          res.status(503).json({ error: 'Could not read this account just now', detail: 'Nothing was changed; try signing in again in a minute.' });
          return;
        }
        if (accountHoldsDidKey(m, did, keyFromDid, publicKeyRaw)) {
          userId = id;
          user = identities.get(id);
          break;
        }
      }
      // Only while some account still lists the DID: one whose every holder dropped it on reading
      // is a DID no account holds, added with a bearer or opened below like any other.
      if (!user && !keyFromDid && indexedDidHolders().length > 0) {
        // None of them; the owner's account may be the one derived from the DID, not loaded yet.
        // A pod that cannot be read signs nobody in.
        const derived = didHolders.includes(derivedDidUserId) ? 'absent' : await ensureAccountLoaded(derivedDidUserId);
        if (derived === 'unreadable') {
          res.status(503).json({ error: 'Could not read this account just now', detail: 'Nothing was changed; try signing in again in a minute.' });
          return;
        }
        const derivedRecord = derived === 'loaded' ? await readForDecision(derivedDidUserId) : null;
        if (derivedRecord === 'unreadable') {
          res.status(503).json({ error: 'Could not read this account just now', detail: 'Nothing was changed; try signing in again in a minute.' });
          return;
        }
        if (!derivedRecord || !accountHoldsDidKey(derivedRecord, did, keyFromDid, publicKeyRaw)) {
          // While some account is not loaded, the one listing the DID with this key may be it.
          if (!accountIndexState.complete) refuseWhileLoading(res, 'DID');
          else res.status(401).json({ error: DID_KEY_NOT_REGISTERED });
          return;
        }
        userId = derivedDidUserId;
        user = identities.get(derivedDidUserId)!;
      }
    }

    // Authenticated add-did: bearer token binds this DID to the caller (verified once, above).
    if (!user) {
      if (bearer && !bearer.valid) {
        refuseUnverifiedBearer(res, bearer);
        return;
      }
      if (bearerUserId !== undefined) {
        userId = bearerUserId;
        user = identities.get(userId);
        // Deleted while the request waited for the DID's turn: the bearer no longer verifies, and
        // the request does not go on to open the account derived from the DID (it used to).
        if (!user || deletedUserIds.has(userId)) {
          refuseUnverifiedBearer(res, { reason: 'Account deleted' });
          return;
        }
        adding = true;
      }
      // A DID that is not a did:key is bound with a key the caller holds, which need not be the
      // one its owner's account lists: one another account lists stays with that account, and is
      // not bound here too. The index may not have seen the owner's account yet: load the one
      // derived from the DID. Nor is one bound while some account is not loaded, as the owner's
      // may be one of them (refuseWhileLoading). Bound then, it would not take the owner's
      // sign-ins (its key never verifies the owner's signature), but once the owner removed the
      // DID, to change its key say, the owner could never bind it again: a DID a loaded account
      // lists with another key is refused above.
      if (user && !keyFromDid) {
        const derivedId = deriveUserIdFromDid(did);
        if (derivedId !== user.id && (await ensureAccountLoaded(derivedId)) === 'unreadable') {
          res.status(503).json({ error: 'Could not check this DID just now', detail: 'Nothing was changed; try again in a minute.' });
          return;
        }
        const callerId = user.id;
        if (didIndex.candidates(did).some(holder => holder !== callerId)) {
          res.status(409).json({ error: 'This DID is registered to another account. Sign in to that account to manage it.' });
          return;
        }
        if (!accountIndexState.complete) {
          refuseWhileLoading(res, 'DID', true);
          return;
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
      // As for SIWE: while some account is not loaded, the one holding this DID may be one of
      // them, so no account is opened for it (refuseWhileLoading); the account derived from it
      // can still be signed in to. A bootstrap claim is refused before anything spends its invite
      // or reads the seeded pod.
      const loading = !accountIndexState.complete;
      if (loading && (bootstrapUserId || bootstrapInvite)) {
        refuseWhileLoading(res, 'DID');
        return;
      }
      // Mode (C) add-device handled upstream (bearer populated `user`);
      // resolveTargetUserId covers (A) derive and (B) bootstrap-claim with
      // the enumeration-safe ordering pinned by tests/resolve-target-userid.test.ts.
      // The seeded pod is read only with its invite (readBootstrapTarget).
      const existingForBootstrap = await readBootstrapTarget(bootstrapUserId, bootstrapInvite);
      if (existingForBootstrap === 'unreadable') {
        res.status(503).json({
          error: 'Could not read this account just now',
          detail: 'The pod holding this account did not answer. Nothing was changed; try signing in again in a minute.',
        });
        return;
      }
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
      const displayName = identities.get(targetUserId)?.name ?? String(name ?? targetUserId);
      const def = defaultAgentForRegistration(targetUserId, displayName, surfaceAgent);
      const agentId = [...identities.values()].find(i => i.type === 'agent' && i.owner === targetUserId)?.id ?? def.agentId;

      // As for SIWE: a DID missing from didIndex may still be on its account's pod, or have
      // been removed from it. Read the pod first and create the account only if it holds no
      // credentials (first-sign-in.ts). FIX A deferred this write off the response path; it is
      // synchronous now, because the deferred write was blind and could replace a whole account.
      // Only a did:key can open an account by itself: nothing here proves that a key the caller
      // supplied belongs to any other DID (no DID document is fetched), so such a DID signs in
      // to an account whose pod lists it with this key, or is added from a signed-in account.
      const mayCreate = !loading && (keyFromDid || resolved.mode !== 'derive');
      const outcome = await claimFirstSignInOnPod(targetUserId, agentId, displayName,
        m => accountHoldsDidKey(m, did, keyFromDid, publicKeyRaw),
        m => {
          m.didKeys.push({
            did,
            publicKeyMultibase: canonicalPublicKeyMultibase,
            keyType: 'Ed25519VerificationKey2020',
            createdAt: new Date().toISOString(),
          });
        }, mayCreate, /* derived */ resolved.mode === 'derive');
      if (outcome.kind === 'unreadable' || outcome.kind === 'unconfirmed') {
        log(`WARN: first-time DID sign-in to ${targetUserId} not completed (${outcome.kind}): ${outcome.reason}`);
        if (outcome.kind === 'unconfirmed' && outcome.undetermined) recordUnconfirmed(didKey, targetUserId, outcome.pending, resolved.mode === 'derive');
        refuseUnfinishedFirstSignIn(res, outcome, resolved.mode === 'bootstrap' ? targetUserId : undefined);
        return;
      }
      if (outcome.kind === 'deleted') {
        if (resolved.mode === 'bootstrap') CONSUMED_INVITES.delete(targetUserId);
        res.status(409).json({ error: ACCOUNT_DELETED_MESSAGE });
        return;
      }
      if (outcome.kind === 'refused') {
        if (loading) refuseWhileLoading(res, 'DID');
        else res.status(401).json({ error: keyFromDid ? DID_NOT_REGISTERED : DID_KEY_NOT_REGISTERED });
        return;
      }
      if (outcome.kind === 'returning') {
        // claimFirstSignInOnPod loaded it: a sign-in to an account that lists the credential (one
        // whose write this request made unconfirmed, found when the account was loaded, included).
        log(`DID ${logValue(did, 200)} signed in to ${targetUserId}, loaded from its pod (not in the DID index)`);
      } else if (!identities.has(targetUserId)) {
        seedIdentity(targetUserId, 'user', displayName);
        seedIdentity(def.agentId, 'agent', def.label, targetUserId, 'ReadWrite');
      }
      user = identities.get(targetUserId)!;
      if (timingEnabled()) logTiming('did-pod-write-completed', requestStart, { branch: 'first-time' });
      // FIX A: identity-server no longer mirrors /profile/card or /<id>/agents.
      // Single authoritative pod-side writer is the relay's /oauth/verify
      // handler. See SIWE first-touch comment above for background.
      if (outcome.kind === 'created') log(`First-time DID registration: ${targetUserId} did=${logValue(did, 200)} defaultAgent=${logValue(agentId, 200)} (surfaceHint=${logValue(surfaceAgent, 200)})`);
    } else if (adding) {
      // Add-did (authenticated) path: added to the record as the pod holds it, and answered only
      // once the pod has it, unless that record signed out everywhere since the bearer's token was
      // issued (signedOutSince: the request may have waited for the DID's turn meanwhile).
      let signedOut = false;
      try {
        await commitCredentialEnrollment(user.id, 'did-add-did', methods => {
          signedOut = signedOutSince(methods, bearerEpoch);
          if (signedOut) return false;
          if (methods.didKeys.some(k => k.did === did)) return false;
          methods.didKeys.push({
            did,
            publicKeyMultibase: canonicalPublicKeyMultibase,
            keyType: 'Ed25519VerificationKey2020',
            createdAt: new Date().toISOString(),
          });
        });
      } catch (err) {
        log(`DID credential enrollment not confirmed for ${user.id}: ${(err as Error).message}`);
        const onPod = await credentialAfterFailedAdd(didKey, user.id, err, m => accountHoldsDidKey(m, did, keyFromDid, publicKeyRaw));
        if (onPod !== 'not-listed') {
          refuseUnconfirmedAdd(res, 'DID', onPod);
          return;
        }
        if (sendAccountWriteRefusal(res, err)) return;
        res.status(503).json({ error: 'Credential enrollment could not be confirmed. No permanent session was issued.' });
        return;
      }
      if (signedOut) {
        res.status(401).json({ error: SIGNED_OUT_DURING_ADD });
        return;
      }
      if (timingEnabled()) logTiming('did-pod-write-completed', requestStart, { branch: 'add-did' });
      log(`DID ${logValue(did, 200)} linked to existing user ${user.id}`);
    }
    return user;
  };
  const turn: Turn<Identity | undefined> = takesTurn
    ? await credentialDecisions.decide(didKey, decideDid)
    : { kind: 'decided', value: await decideDid() };
  if (turn.kind !== 'decided') {
    refuseCredentialTurn(res, turn, 'DID');
    return;
  }
  if (!turn.value) return;
  const user = turn.value;

  const tokenStart = timingEnabled() ? startTiming() : 0;
  const tokenResponse = await issueTokenResponse(user, surfaceAgent);
  if (timingEnabled()) logTiming('did-issue-token', tokenStart);
  // Only now: a bare-nonce signature refused on the way here signed nobody in, and the line says
  // which account this one did.
  if (proof === 'bare-nonce') logBareNonceSignature(req, did, ch, surfaceAgent, user.id);
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
  // Created only if absent (the id is random, so another document there is a collision).
  try {
    await withIdentityPodMutex(userId, async () => {
      const doc = emptyAuthMethods(userId, name, agentId);
      let result: WriteResult;
      try {
        result = await writeLive(userId, doc, { kind: 'absent' }, 'try');
      } catch (err) {
        // Read, not settled: a fence would leave an empty record behind for an id that is
        // abandoned below. The id is random, so a record there now with this request's agent is
        // the one it wrote (a slow pod that stored it after the timeout): it was provisioned.
        const now = await reconcileAfterWriteFailure(userId, undefined, { kind: 'absent' }, 'try');
        if (now && !isTombstone(now) && now.agentId === agentId && !hasAnyCredential(now)) {
          log(`WARN: try-it identity ${userId}: the pod took the write without confirming it (${(err as Error).message})`);
          return;
        }
        throw err;
      }
      if (result === 'precondition-failed') throw new AuthMethodsConflictError(`${userId}: a document is already there`);
      installAuthMethods(userId, doc);
    });
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
  // ★ `/mcp`, NOT `/sse`. This snippet is pasted verbatim into ~/.claude.json and the Cursor
  // / Codex equivalents, so a wrong path here is not a documentation error — it is a config
  // file on somebody's disk that silently never works. `/sse` is a write-activity feed, not
  // an MCP transport: it emits no `event: endpoint` frame, so the client waits for a message
  // endpoint that never arrives and times out. Measured by
  // `tools/probe-sse-mcp-handshake-live.ts`; three surfaces of this server handed out that
  // path and every one of them is now `/mcp`.
  const mcpConfigSnippet = JSON.stringify({
    mcpServers: {
      interego: {
        url: `${RELAY_URL}/mcp`,
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

// Provisional Play composes the existing native owner/pod and service-agent
// delegation flow. It remains disabled without an explicit audience/principal
// allowlist; browser private keys and native tokens never enter a game backend.
const provisionalPlay = createProvisionalPlayProvider({
  issuer: BASE_URL.replace(/\/$/, ''), cssUrl: CSS_URL,
  publicPodBase: process.env['CSS_PUBLIC_URL'] ?? CSS_URL, relayUrl: RELAY_URL,
  signingKey: TOKEN_SIGNING_KEY,
  stableSigningKey: Buffer.from(process.env['TOKEN_SIGNING_KEY'] ?? '', 'base64').length >= 32,
  clientsJson: process.env['PROVISIONAL_PLAY_CLIENTS'],
  ttlSeconds: Number(process.env['PROVISIONAL_PLAY_TTL_SECONDS'] ?? 86400),
  maxPods: Number(process.env['PROVISIONAL_PLAY_MAX_PODS'] ?? 100),
  withOwnerLock: withIdentityPodMutex,
  empty: claims => emptyAuthMethods(claims.userId, 'Play guest', claims.authenticatedAgentId) as unknown as import('./provisional-play-store.js').PlayAnchorDocument,
  // Runs inside the owner's lock, once the anchor's conditional write has landed.
  committed: document => {
    const methods = normaliseAuthMethods(document, document.userId);
    hydrateFromAuthMethods(document.userId, methods);
    installAuthMethods(document.userId, methods);
  },
  issueCredential: async claims => {
    const user = identities.get(claims.userId);
    if (!user || user.type !== 'user') throw new Error('Provisional owner unavailable');
    return { ...await issueTokenResponse(user, undefined, {
      audience: claims.audience, proofKeyThumbprint: claims.proofKeyThumbprint, expiresAt: claims.expiresAt,
    }), podUrl: claims.podUrl };
  },
  recoverSigner: async (message, signature) => (await loadEthers()).verifyMessage(message, signature),
});
mountProvisionalPlay(app, provisionalPlay,
  rateLimit('provisional-play', { windowMs: 60 * 60 * 1000, max: 5 }),
  rateLimit('provisional-play-verify', { windowMs: 60 * 1000, max: 120 }), log);

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
      seedIdentity(surfaceAgentId, 'agent', surfaceAgentLabel(surfaceAgent, user.name), user.id, 'ReadWrite');
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

async function issueTokenResponse(user: Identity, surfaceAgent?: string, provisional?: ProvisionalTokenGrant): Promise<Record<string, unknown>> {
  const agent = ensureSurfaceAgent(user, surfaceAgent);
  const tokenRecord = await issueToken(user.id, agent.id, agent.scope ?? 'ReadWrite', provisional);
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

  if (tokenResult.record!.provisionalPlay) {
    res.status(403).json({ error: 'provisional_owner_cannot_register_agents' });
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

  // A plain slug, before anything else looks at it: an array or an object is not an id, and
  // `cursor-<bob>\n` is one that a URL parser turns into Bob's. Then `<surface>-<userId>` is
  // how a user's surface agents are named, and a forgotten one is restored from that name
  // (restoreSurfaceAgent). So an id ending in ANOTHER user's canonical id is theirs, whether
  // or not this server knows them yet: registering it would make the caller the controller
  // of what reads as that user's agent.
  const idCheck = checkAgentIdForRegistration(agentId, userId);
  if (idCheck.ok === false) {
    res.status(idCheck.status).json({ error: idCheck.error });
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
  // PROOF-OF-POSSESSION (first-principles guardrail: no credential without proving
  // key-ownership). Minting a token requires already holding a valid token for THIS
  // user — the same gate as /register-agent. Both userId and agentId are PUBLIC
  // (userIds are derived + enumerable; the unauthenticated WebID profile lists every
  // authorizedAgent), so without this gate anyone could POST a victim's (userId,
  // agentId) and receive a fully valid bearer. The FIRST token must come from a
  // credential-proving flow (/auth/siwe, /auth/did, /auth/webauthn/*).
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required: present a valid token for this user to mint another (obtain the first via /auth/siwe, /auth/did, or /auth/webauthn)' });
    return;
  }
  const authResult = await verifyToken(authHeader.slice(7));
  if (!authResult.valid) {
    res.status(401).json({ error: authResult.reason ?? 'invalid token' });
    return;
  }

  const { userId, agentId } = req.body;
  if (!userId || !agentId) {
    res.status(400).json({ error: 'userId and agentId are required' });
    return;
  }
  if (authResult.record!.userId !== userId) {
    res.status(403).json({ error: 'token does not belong to this user' });
    return;
  }
  if (authResult.record!.provisionalPlay && authResult.record!.agentId !== agentId) {
    res.status(403).json({ error: 'provisional_owner_cannot_change_agent' });
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

  const record = await issueToken(userId, agentId, agent.scope ?? 'ReadWrite', authResult.record!.provisionalPlay);
  res.json({ token: record.token, expiresAt: record.expiresAt, scope: record.scope });
});

/**
 * POST /tokens/verify — Verify a bearer token
 * Body: { token }
 * Returns: { valid, userId?, agentId?, scope?, reason? }
 */
app.post('/tokens/verify', async (req, res) => {
  // Introspection-secret gate (the modes are described where IDENTITY_INTROSPECTION_SECRET is
  // read). Which budget a request counts against:
  //   - enforced, with the right bearer (`Authorization: Bearer <secret>`, compared as SHA-256
  //     digests with timingSafeEqual, so the comparison has no early exit on a length mismatch):
  //     the 'introspection' bucket, 600 a minute per address. The shared 'tokens' bucket is only
  //     PEEKED, and refuses at `count >= max`, i.e. when one more counted request would be over:
  //     an address that has used its 60 gets the same 429 whatever bearer it sends, so a guess
  //     at the secret past the 60th learns nothing, exactly as when every request was counted.
  //     (With `>`, an address at exactly 60 would get one answer that tells the right value
  //     from a wrong one.)
  //   - enforced without it (no bearer, another scheme, a wrong value), open, and disabled: the
  //     'tokens' bucket, counted before any answer, as before.
  // Every count is synchronous, before anything here awaits, as in GET /auth-methods/me, so a
  // concurrent burst cannot slip past it.
  const ip = clientIp(req);
  if (INTROSPECTION_MODE === 'enforced') {
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const digest = (v: string): Buffer => crypto.createHash('sha256').update(v, 'utf8').digest();
    const authorized = presented !== undefined && crypto.timingSafeEqual(digest(presented), digest(IDENTITY_INTROSPECTION_SECRET));
    if (!authorized) {
      const wait = tokenBucket.hit(ip);
      if (wait !== null) { sendRateLimited(res, tokenBucket, wait); return; }
      res.status(401).json({ error: presented === undefined ? 'introspection bearer required' : 'introspection bearer rejected' });
      return;
    }
    const sharedWait = tokenBucket.blocked(ip);
    if (sharedWait !== null) { sendRateLimited(res, tokenBucket, sharedWait); return; }
    const wait = introspectionBucket.hit(ip);
    if (wait !== null) { sendRateLimited(res, introspectionBucket, wait); return; }
  } else {
    const wait = tokenBucket.hit(ip);
    if (wait !== null) { sendRateLimited(res, tokenBucket, wait); return; }
    if (INTROSPECTION_MODE === 'disabled') {
      res.status(401).json({ error: 'token introspection is disabled — set IDENTITY_INTROSPECTION_SECRET (and have callers present it), or set ALLOW_OPEN_INTROSPECTION=1 for the legacy open oracle during migration' });
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
      ownerDid: `did:web:${BASE_URL_HOST}:users:${result.record!.userId}`,
      webId: `${BASE_URL.replace(/\/$/, '')}/users/${result.record!.userId}/profile#me`,
      podUrl: `${process.env['CSS_PUBLIC_URL'] ?? CSS_URL}${result.record!.userId}/`,
      ...(result.record!.provisionalPlay ? { provisionalPlay: result.record!.provisionalPlay } : {}),
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

app.get('/agents/:id/did.json', async (req, res) => {
  const identity = await agentIdentity(req.params.id);
  if (!identity) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(buildDidDocument(identity));
});

// ── WebID Profiles ──────────────────────────────────────────

app.get('/users/:id/profile', (req, res) => {
  const identity = identities.get(req.params.id);
  if (!identity || identity.type !== 'user') { res.status(404).json({ error: 'Not found' }); return; }
  res.setHeader('Content-Type', 'text/turtle');
  res.send(buildWebIdProfile(identity));
});

app.get('/agents/:id/profile', async (req, res) => {
  const identity = await agentIdentity(req.params.id);
  if (!identity) { res.status(404).json({ error: 'Not found' }); return; }
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
 * POST /siwe/verify and POST /siwe/nonce — retired (410 Gone).
 *
 * /siwe/verify issued a ReadWrite bearer for a wallet's account after checking only that a
 * signature over ANY message containing the address recovered to that address: no server
 * nonce, nothing consumed, no domain. One message the wallet had ever signed elsewhere (a
 * sign-in to another site, a message posted publicly) could be replayed for a token to the
 * wallet's account. /siwe/nonce returned random bytes that nothing stored or checked. Nothing
 * in this repository called either. Wallet sign-in is POST /challenges (purpose 'siwe') then
 * POST /auth/siwe, which consumes the nonce and requires the signed message to contain it.
 * Both routes now verify nothing and issue nothing; they stay rate-limited.
 */
const SIWE_RETIRED = {
  error: 'This endpoint has been retired',
  title: 'Use POST /challenges and POST /auth/siwe to sign in with a wallet',
  detail: 'A wallet sign-in must sign a single-use nonce this server issued. This endpoint did not check one, so it no longer verifies signatures or issues tokens.',
  hint: 'POST /challenges with {"purpose":"siwe"} for a nonce, sign a SIWE message whose Nonce: line is that nonce, then POST {message, signature, nonce} to /auth/siwe.',
  challenge: { method: 'POST', href: '/challenges', body: { purpose: 'siwe' } },
  signIn: { method: 'POST', href: '/auth/siwe' },
};
app.post('/siwe/verify', siweVerifyLimiter, (_req, res) => {
  res.status(410).json(SIWE_RETIRED);
});
app.post('/siwe/nonce', authEnrollLimiter, (_req, res) => {
  res.status(410).json(SIWE_RETIRED);
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
 * POST /wallet/link — Link an Ethereum wallet to the bearer's account.
 *
 * Header: Authorization: Bearer <token>   (the account the wallet is linked to)
 * Body:   { walletAddress, siweMessage, signature, nonce }
 *
 * `nonce` comes from POST /challenges with purpose 'siwe' and is consumed here exactly as
 * /auth/siwe consumes it: single-use, five minutes. The signed message is an ERC-4361 message
 * whose first line names this server's host, whose second line is `walletAddress`, and which
 * carries a `Nonce: <nonce>` line. A wallet another account already holds is refused (409).
 *
 * Before 2026-10-26 any signature by the wallet over any message was accepted, and a wallet
 * another account held was linked anyway. With one message a victim's wallet had signed for
 * some other purpose, an attacker could attach that wallet to the attacker's own account, and
 * the victim's later wallet sign-ins could then resolve to the attacker's account.
 */
app.post('/wallet/link', authEnrollLimiter, async (req, res) => {
  const { walletAddress, siweMessage, signature, nonce } = req.body ?? {};
  // Spend the challenge before any refusal, so a nonce is never good twice. A wallet-link
  // message names this server and carries a 'siwe' nonce, so if its nonce outlived a refused
  // request (a stale bearer, say), the same message and signature would still sign the wallet
  // in at /auth/siwe for anyone who saw them.
  const challenge = typeof nonce === 'string' && nonce !== '' ? consumeChallenge(nonce, 'siwe') : null;

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
  if (!tr.valid) { refuseBearer(res, tr, 'Nothing was changed; sign a new message and try again in a minute.'); return; }
  const linkEpoch = tokenEpoch(authHeader.slice(7));

  if (typeof walletAddress !== 'string' || typeof siweMessage !== 'string' || typeof signature !== 'string'
    || typeof nonce !== 'string' || !walletAddress || !siweMessage || !signature || !nonce) {
    res.status(400).json({
      error: 'walletAddress, siweMessage, signature, and nonce are required',
      hint: 'POST /challenges with {"purpose":"siwe"} for a nonce, have the wallet sign a SIWE message for this server that carries it (Nonce: <nonce>), then send all four here.',
    });
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    res.status(400).json({ error: 'walletAddress must be a 0x-prefixed 20-byte hex address' });
    return;
  }

  const userId = tr.record!.userId;
  const user = identities.get(userId);
  if (!user || user.type !== 'user') {
    res.status(404).json({ error: `User '${userId}' (from token) not found` });
    return;
  }

  if (!challenge) {
    res.status(401).json({
      error: 'Invalid or expired challenge',
      detail: 'Challenges are single-use and valid for 5 minutes.',
      hint: 'Request a fresh one via POST /challenges with {"purpose":"siwe"} and sign a new message with it.',
    });
    return;
  }
  const addr = walletAddress.toLowerCase();
  const checked = await checkSiweMessage(siweMessage, challenge);
  if (checked.ok === false) {
    res.status(checked.status).json(checked.body);
    return;
  }
  if (checked.address !== addr) {
    res.status(400).json({ error: 'SIWE message does not name walletAddress', hint: 'Its second line must be the wallet address being linked.' });
    return;
  }

  // Verify the SIWE signature with real ECDSA recovery
  try {
    const { ethers } = await loadEthers();
    const recovered = ethers.verifyMessage(siweMessage, signature);
    if (recovered.toLowerCase() !== addr) {
      res.status(401).json({ error: `Signature mismatch: expected ${walletAddress}, recovered ${recovered}` });
      return;
    }
  } catch (err) {
    res.status(401).json({ error: `Signature verification failed: ${(err as Error).message}` });
    return;
  }

  // In the wallet's turn, as /auth/siwe decides and adds (credentialDecisions).
  const walletKey = walletCredential(addr);
  const turn = await credentialDecisions.decide(walletKey, async (): Promise<true | undefined> => {
    // A wallet another account holds stays with it (as passkeys and DIDs do). Every pod must have
    // been read to know that, and the account the wallet would have opened by itself is loaded
    // from its pod in case the index missed it (walletHolder).
    const holder = await walletHolder(addr, userId);
    if (holder.kind === 'held') {
      res.status(409).json({ error: 'This wallet is registered to another account. Sign in to that account to manage it.' });
      return;
    }
    if (holder.kind === 'unknown') {
      res.status(503).json({ error: 'Could not check this wallet just now', detail: 'Not every account could be read, so this server cannot tell whether another account holds this wallet. Nothing was changed; try again in a minute.' });
      return;
    }

    // Written only while the record has not signed out everywhere since the bearer's token was
    // issued (signedOutSince): the request may have waited for the wallet's turn meanwhile.
    let signedOut = false;
    try {
      await commitCredentialEnrollment(userId, 'wallet-link', methods => {
        signedOut = signedOutSince(methods, linkEpoch);
        if (signedOut) return false;
        if (methods.walletAddresses.some(a => a.toLowerCase() === addr)) return false;
        methods.walletAddresses.push(addr);
      });
    } catch (err) {
      const onPod = await credentialAfterFailedAdd(walletKey, userId, err, m => m.walletAddresses.some(a => a.toLowerCase() === addr));
      if (onPod === 'listed') {
        // The pod did not confirm the write, but lists the wallet on this account now: linked.
        log(`Linked wallet ${addr} to user ${userId} (the pod took the write without confirming it)`);
        return true;
      }
      if (onPod === 'undetermined' || onPod === 'unrecorded') {
        res.status(503).json({
          error: 'The wallet could not be confirmed as linked',
          detail: 'The pod did not confirm the write, and could not be read after it, so it may or may not have been saved. Linking it again is safe (sign a new message, with a new nonce from POST /challenges: this one is spent): if this write was saved, the repeat answers linked and writes nothing.',
        });
        return;
      }
      if (sendAccountWriteRefusal(res, err)) return;
      res.status(500).json({ error: `Failed to persist wallet to pod: ${(err as Error).message}` });
      return;
    }
    if (signedOut) {
      res.status(401).json({ error: SIGNED_OUT_DURING_ADD });
      return;
    }
    log(`Linked wallet ${addr} to user ${userId}`);
    return true;
  });
  if (turn.kind !== 'decided') {
    refuseCredentialTurn(res, turn, 'wallet');
    return;
  }
  if (!turn.value) return;

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
app.get('/auth-methods/me', async (req, res) => {
  // Every request is counted, synchronously, before anything here awaits, so a concurrent
  // burst cannot slip past a count that lands only after verification. A bearer this server
  // did not sign (or none) counts against the address; the HMAC check that decides that is
  // the only work it gets. A signed token counts against the account it names, revoked or
  // expired ones included, so one account's stale tokens cannot use up the address's budget
  // that every other relay user's reads arrive under.
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  const signed = bearer === undefined ? undefined : parseAndVerifySignature(bearer);
  if (bearer === undefined || signed?.valid !== true) {
    const ipWait = authMethodsFailureLimiter.hit(clientIp(req));
    if (ipWait !== null) { sendRateLimited(res, authMethodsFailureLimiter, ipWait); return; }
    res.status(401).json({ error: signed ? `Invalid bearer token: ${(signed as { reason: string }).reason}` : 'Bearer token required' });
    return;
  }
  const userWait = authMethodsUserLimiter.hit(signed.payload.userId);
  if (userWait !== null) { sendRateLimited(res, authMethodsUserLimiter, userWait, 'for this account'); return; }
  const tr = await verifyToken(bearer);
  if (!tr.valid) {
    res.status(401).json({ error: `Invalid bearer token: ${tr.reason}` });
    return;
  }
  const userId = tr.record!.userId;
  const methods = await readAuthMethods(userId);
  const forSigning = req.query.purpose === 'client-signature';
  res.json({
    userId,
    name: methods.name,
    agentId: methods.agentId,
    walletAddresses: methods.walletAddresses,
    webAuthnCredentials: methods.webAuthnCredentials.map(c => ({
      id: c.id,
      createdAt: c.createdAt,
      transports: c.transports,
      ...(forSigning ? {
        publicKey: c.publicKey,
        rpIds: c.rpId ? [c.rpId] : [...new Set([RP_ID, ...[...RP_ALLOWLIST.values()].map(rp => rp.rpId)])],
        origins: c.rpOrigin ? [c.rpOrigin] : [...new Set([RP_ORIGIN, ...RP_ALLOWLIST.keys()])],
      } : {}),
    })),
    didKeys: methods.didKeys.map(k => ({
      did: k.did,
      keyType: k.keyType,
      createdAt: k.createdAt,
      ...(forSigning ? { publicKeyMultibase: k.publicKeyMultibase } : {}),
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
    ownerDid: `did:web:${BASE_URL_HOST}:users:${userId}`,
    authenticatedAgentId: tr.record!.agentId,
    authenticatedAgentDid: `did:web:${BASE_URL_HOST}:agents:${tr.record!.agentId}`,
    tokenExpiresAt: tr.record!.expiresAt,
    podUrl: `${process.env['CSS_PUBLIC_URL'] ?? CSS_URL}${userId}/`,
    ...(tr.record!.provisionalPlay ? { provisionalPlay: tr.record!.provisionalPlay } : {}),
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
async function requireUserFromBearer(
  req: express.Request,
  res: express.Response,
  opts: { closedOnPod?: 'accept' } = {},
): Promise<Identity | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required' });
    return null;
  }
  const tr = await verifyToken(authHeader.slice(7));
  if (!tr.valid) {
    const closing = opts.closedOnPod === 'accept' && tr.reason === 'Account deleted' ? unfinishedDeletion(authHeader.slice(7)) : null;
    if (closing) return closing;
    refuseBearer(res, tr);
    return null;
  }
  const user = identities.get(tr.record!.userId);
  if (!user || user.type !== 'user') {
    res.status(404).json({ error: `User for token not found` });
    return null;
  }
  return user;
}

/**
 * The account a genuine, unexpired token names when this server's copy of its record is a
 * tombstone the process has not acted on: the identity shell is still here and the id is not in
 * deletedUserIds. That is a deletion the pod took without confirming it (a 5xx after applying
 * the tombstone, a timeout) whose read afterwards failed too, so the route answered 503; or a
 * deletion by the other instance or an operator. Only POST /users/me/delete accepts it, to
 * finish the deletion (memory and the agent registry); it writes nothing over the tombstone. A Play
 * guest's token is one too (verifyToken answers it "Account deleted" on its owner's tombstone), and
 * the janitor leaves a Play owner whose deletion was answered 503 here to this retry until its guest
 * deadline (unconfirmedPlayDeletions).
 */
function unfinishedDeletion(token: string): Identity | null {
  const parsed = parseAndVerifySignature(token);
  if (parsed.valid !== true) return null;
  const { userId, expiresAt } = parsed.payload;
  if (new Date(expiresAt) < new Date() || deletedUserIds.has(userId)) return null;
  const user = identities.get(userId);
  const copy = authMethodsCache.get(userId)?.value;
  return user?.type === 'user' && copy !== undefined && isTombstone(copy) ? user : null;
}

/**
 * Run a removal of a wallet or DID (`credential`) from `userId` in the credential's turn when it
 * can change who holds the credential: this server's copy of the account lists it (`listedHere`),
 * or a write of it to this account is recorded as unconfirmed. The turn first settles any such
 * record (a fence where the record has not moved), so an add the pod never answered cannot land
 * after the removal has read the record and answered 404; and a removal nothing could settle is
 * recorded in turn (`inTurn`), so the credential's next request (a sign-in, an add, a link)
 * settles it before deciding, rather than deciding on a read the removal can still overtake. Any
 * account can ask to remove any wallet or DID from itself, so a removal of one its copy does not
 * list, with nothing recorded, is not queued in the credential's turn: requests like that could
 * otherwise keep its owner's sign-ins waiting. Such a removal writes nothing outside the turn:
 * when the record it reads lists the credential after all (the copy was behind: the other
 * instance or an operator added it), `remove(false)` answers nothing and returns 'in-turn', and
 * the removal runs again in the turn. So every removal that writes runs in the turn, and every
 * one nothing could settle is recorded; one that ran outside the turn and was not recorded used to
 * be able to land after the owner had added the credential back.
 */
async function inRemovalTurn(credential: string, userId: string, listedHere: boolean,
  remove: (inTurn: boolean) => Promise<'in-turn' | void>): Promise<Turn<void>> {
  const inTurn = () => credentialDecisions.decide(credential, async () => { await remove(true); });
  if (listedHere || credentialDecisions.unconfirmedFor(credential) === userId) return inTurn();
  if (await remove(false) === 'in-turn') return inTurn();
  return { kind: 'decided', value: undefined };
}

// Why a removal changed nothing: the record (as the pod holds it) does not list the credential,
// or it is the account's last way to sign in.
type RemovalRefusal = 'not-found' | 'last-method';
function refuseRemoval(res: express.Response, refusal: RemovalRefusal, notFound: string): void {
  if (refusal === 'not-found') res.status(404).json({ error: notFound });
  else res.status(409).json({ error: 'Refusing to delete your last authentication method. Add another method first, then retry.' });
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
  let remaining = 0;
  let refusal: RemovalRefusal | undefined;
  try {
    await commitCredentialEnrollment(user.id, 'webauthn-remove', methods => {
      refusal = undefined;
      const before = methods.webAuthnCredentials.length;
      const next = methods.webAuthnCredentials.filter(c => c.id !== credentialId);
      if (next.length === before) { refusal = 'not-found'; return false; }
      // Evaluate lockout against the record as the pod holds it, under the owner lock.
      const remainingTotal = next.length + methods.walletAddresses.length + methods.didKeys.length;
      if (remainingTotal === 0) { refusal = 'last-method'; return false; }
      methods.webAuthnCredentials = next;
      remaining = next.length;
    });
  } catch (err) {
    // The pod may have taken the removal without confirming it: what it holds now decides.
    const onPod = changeOnPod(err, m => !m.webAuthnCredentials.some(c => c.id === credentialId));
    if (onPod === 'landed') {
      log(`Removed WebAuthn credential ${credentialId} for ${user.id} (the pod took the write without confirming it)`);
      res.json({ removed: true, credentialId, remaining: ((err as AuthMethodsWriteError).podRecord as AuthMethods).webAuthnCredentials.length });
      return;
    }
    if (onPod === 'undetermined') { refuseUndeterminedChange(res, 'Removal not confirmed', REMOVE_AGAIN); return; }
    if (sendAccountWriteRefusal(res, err)) return;
    res.status(500).json({ error: `Failed to persist: ${(err as Error).message}` });
    return;
  }
  if (refusal) { refuseRemoval(res, refusal, 'Credential not found'); return; }
  log(`Removed WebAuthn credential ${credentialId} for ${user.id}`);
  res.json({ removed: true, credentialId, remaining });
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
  const walletKey = walletCredential(address);
  const turn = await inRemovalTurn(walletKey, user.id, walletIndex.candidates(address).includes(user.id), async inTurn => {
    let remaining = 0;
    let refusal: RemovalRefusal | undefined;
    // Listed on the record, read outside the turn: nothing is written, and it runs in the turn.
    let listedOutsideTurn = false;
    try {
      await commitCredentialEnrollment(user.id, 'wallet-remove', methods => {
        refusal = undefined;
        listedOutsideTurn = false;
        const before = methods.walletAddresses.length;
        const next = methods.walletAddresses.filter(a => a.toLowerCase() !== address);
        if (next.length === before) { refusal = 'not-found'; return false; }
        if (!inTurn) { listedOutsideTurn = true; return false; }
        const remainingTotal = next.length + methods.webAuthnCredentials.length + methods.didKeys.length;
        if (remainingTotal === 0) { refusal = 'last-method'; return false; }
        methods.walletAddresses = next;
        remaining = next.length;
      });
    } catch (err) {
      const onPod = changeOnPod(err, m => !m.walletAddresses.some(a => a.toLowerCase() === address));
      if (onPod === 'landed') {
        log(`Removed wallet ${address} for ${user.id} (the pod took the write without confirming it)`);
        res.json({ removed: true, walletAddress: address, remaining: ((err as AuthMethodsWriteError).podRecord as AuthMethods).walletAddresses.length });
        return;
      }
      if (onPod === 'undetermined') {
        // Only a removal in the turn writes, so this is in the turn.
        recordUnconfirmed(walletKey, user.id, (err as AuthMethodsWriteError).pending);
        refuseUndeterminedChange(res, 'Removal not confirmed', REMOVE_AGAIN);
        return;
      }
      if (sendAccountWriteRefusal(res, err)) return;
      res.status(500).json({ error: `Failed to persist: ${(err as Error).message}` });
      return;
    }
    if (listedOutsideTurn) return 'in-turn';
    if (refusal) { refuseRemoval(res, refusal, 'Wallet not found'); return; }
    log(`Removed wallet ${address} for ${user.id}`);
    res.json({ removed: true, walletAddress: address, remaining });
  });
  if (turn.kind !== 'decided') refuseCredentialTurn(res, turn, 'wallet');
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
  const did: unknown = req.body?.did;
  if (!did || typeof did !== 'string') { res.status(400).json({ error: 'did required in body' }); return; }
  const didKey = didCredential(did);
  const turn = await inRemovalTurn(didKey, user.id, didIndex.candidates(did).includes(user.id), async inTurn => {
    let remaining = 0;
    let refusal: RemovalRefusal | undefined;
    // Listed on the record, read outside the turn: nothing is written, and it runs in the turn.
    let listedOutsideTurn = false;
    try {
      await commitCredentialEnrollment(user.id, 'did-remove', methods => {
        refusal = undefined;
        listedOutsideTurn = false;
        const before = methods.didKeys.length;
        const next = methods.didKeys.filter(k => k.did !== did);
        if (next.length === before) { refusal = 'not-found'; return false; }
        if (!inTurn) { listedOutsideTurn = true; return false; }
        const remainingTotal = next.length + methods.webAuthnCredentials.length + methods.walletAddresses.length;
        if (remainingTotal === 0) { refusal = 'last-method'; return false; }
        methods.didKeys = next;
        remaining = next.length;
      });
    } catch (err) {
      const onPod = changeOnPod(err, m => !m.didKeys.some(k => k.did === did));
      if (onPod === 'landed') {
        log(`Removed DID ${logValue(did, 200)} for ${user.id} (the pod took the write without confirming it)`);
        res.json({ removed: true, did, remaining: ((err as AuthMethodsWriteError).podRecord as AuthMethods).didKeys.length });
        return;
      }
      if (onPod === 'undetermined') {
        // Only a removal in the turn writes, so this is in the turn.
        recordUnconfirmed(didKey, user.id, (err as AuthMethodsWriteError).pending);
        refuseUndeterminedChange(res, 'Removal not confirmed', REMOVE_AGAIN);
        return;
      }
      if (sendAccountWriteRefusal(res, err)) return;
      res.status(500).json({ error: `Failed to persist: ${(err as Error).message}` });
      return;
    }
    if (listedOutsideTurn) return 'in-turn';
    if (refusal) { refuseRemoval(res, refusal, 'DID not found'); return; }
    log(`Removed DID ${logValue(did, 200)} for ${user.id}`);
    res.json({ removed: true, did, remaining });
  });
  if (turn.kind !== 'decided') refuseCredentialTurn(res, turn, 'DID');
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
  // refuses anything below the pod's current value. The bump is made on
  // the record as the pod holds it (so it keeps what others wrote there),
  // above both the pod's epoch and this server's copy's (tokens may have
  // been checked against either), and this server's copy holds it as soon
  // as the pod does, so the next verify sees it.
  const cachedEpoch = authMethodsCache.get(user.id)?.value.sessionEpoch ?? 0;
  let previousEpoch = 0;
  let newEpoch = 0;
  try {
    await commitCredentialEnrollment(user.id, 'sign-out-everywhere', methods => {
      previousEpoch = methods.sessionEpoch ?? 0;
      newEpoch = Math.max(previousEpoch, cachedEpoch) + 1;
      methods.sessionEpoch = newEpoch;
    // An account shell this server holds with no document on its pod keeps its tokens
    // verifying until a restart, so the epoch is made durable by creating the document. A Play
    // owner's is never re-created (a purged owner has nothing to sign out).
    }, { absent: user.id.startsWith('u-try-play-') ? 'refuse' : 'create' });
  } catch (err) {
    // The pod may have taken the bump without confirming it: an epoch there at or above the one
    // written ends every token issued before, so the sign-out is done.
    const onPod = changeOnPod(err, m => (m.sessionEpoch ?? 0) >= newEpoch);
    if (onPod === 'landed') {
      const epoch = ((err as AuthMethodsWriteError).podRecord as AuthMethods).sessionEpoch ?? newEpoch;
      log(`Signed out everywhere for ${user.id} — sessionEpoch ${previousEpoch} → ${epoch} (the pod took the write without confirming it)`);
      res.json({ revoked: true, userId: user.id, sessionEpoch: epoch });
      return;
    }
    if (onPod === 'undetermined') {
      refuseUndeterminedChange(res, 'Sign-out not confirmed', 'Signing out everywhere again is safe: a repeat ends every session '
        + 'issued before it, or is refused (401) because this token was among those the first one ended.');
      return;
    }
    if (sendAccountWriteRefusal(res, err)) return;
    res.status(500).json({ error: `Failed to persist sessionEpoch bump: ${(err as Error).message}` });
    return;
  }
  log(`Signed out everywhere for ${user.id} — sessionEpoch ${previousEpoch} → ${newEpoch}`);
  res.json({ revoked: true, userId: user.id, sessionEpoch: newEpoch });
});

/**
 * POST /users/me/delete
 *
 * Tear down the calling user entirely:
 *   - all in-memory identities (user + every owned agent)
 *   - all bearer tokens issued for that user
 *   - the user's pod-side auth-methods.jsonld (overwritten with its tombstone)
 *   - the user's pod-side agents file
 *
 * Bearer-gated by the user's own token, so the operation is self-
 * service. Used by the Playwright E2E test for happy-path cleanup and
 * by the periodic janitor (see `janitor` loop below) for stale test
 * users left behind after a crashed run.
 *
 * The pod's other files and its container remain (CSS does not prune containers, and
 * removing them requires storage-account credentials the identity server doesn't carry). So
 * auth-methods.jsonld is overwritten with a tombstone (deletionTombstone) rather than removed,
 * for every id, and nothing in memory is dropped until the pod has it: a deletion the pod did not
 * take throws, and the route says so. A write that failed but may have landed (a 5xx, a timeout)
 * is decided on the record the writer settled after it (a write the pod never answered is fenced
 * first, so it cannot land later): a tombstone there closes the account here too. When it could
 * not be settled, the route's 503 says the deletion may have taken, and the retry finishes it
 * (unfinishedDeletion; a tombstone already there is not written again).
 *
 * The record is never removed, `u-try-*` ids' included (random ids, which used to be removed
 * with a DELETE conditional on the record read): a write still pending from before the deletion
 * (an add nothing could settle, recorded for its credential's next turn) is conditional on the
 * record's ETag or on there being no document, and Community Solid Server 7.2 applies a PUT sent
 * with If-Match on an ETag to a missing document (BasicConditions.matchesMetadata fails only
 * If-Match: * there), as it applies one sent with If-None-Match: *. So a removed record let such
 * a write re-create the account after the 200, listing its credential: at the next restart (a
 * Play owner's guest token at once) its tokens verified again. The tombstone is a document with
 * an ETag of its own, so neither condition can hold again, before a restart or after one. A Play
 * owner's tombstone is not permanent: it is not marked deleted here (its id is derived from a
 * game's proof key), and its provisioning may replace it (provisional-play-store.ts).
 *
 * Under the account's lock, which it takes unless the caller holds it already (`lockHeld`: the
 * janitor's Play purge), so no writer runs between reading the record and closing it, and every
 * one after is refused. The tombstone is written with the lock-free applyUpdate: the lock is not
 * re-entrant. `stillDeletable`: checked on the record as the pod holds it, under the lock (each
 * time it is read: a 412 reads it again); when it fails nothing is changed and `kept` is set (the
 * janitor's decision was made on this server's copy, or before an enrolment the other instance
 * made). A tombstone already there is a closed account, whatever `stillDeletable` says.
 *
 * `playPurge`: the janitor's purge of a Play owner (purgePlayOwner). The tombstone it writes is
 * marked (provisionalPlayPurgePending) until the purge has deleted the pod's other resources, and
 * `purgePending` in the result says the record is such a tombstone (written now, or left by an
 * earlier pass whose deletions did not all succeed), so the purge goes on. A tombstone it finds
 * unmarked is a deletion's (the other instance's) or a finished purge's: the account is only
 * forgotten here, and nothing of the pod is written or deleted, its registry included. Except a
 * deletion this process answered 503 (unconfirmedPlayDeletions): before its guest deadline it is
 * left as it is (`kept`: memory too), for the guest's retry; after it, the deletion is finished
 * here as the retry would have finished it (the registry DELETE), and `unconfirmed` says so.
 *
 * A Play owner's deletion whose tombstone the pod may have taken, which nothing could settle (the
 * route's 503), is recorded in unconfirmedPlayDeletions here, under the lock, before the janitor's
 * purge (which may be waiting for it) can find that tombstone.
 */
type DeletionResult = { agents: string[]; tombstoned: true; kept?: true; purgePending?: true; unconfirmed?: true; podCleanup: { agents: number } };
async function deleteUserCompletely(
  userId: string,
  opts: { lockHeld?: boolean; stillDeletable?: (methods: AuthMethods) => boolean; playPurge?: true } = {},
): Promise<DeletionResult> {
  const podCleanup = { agents: 0 };
  // The tombstone the pod holds once the account is closed: the one written here, or one found.
  let closedOn: AuthMethods | null = null;
  // The record the tombstone was last written over (or meant to be): its anchor gives a Play
  // owner's guest deadline.
  let writtenOver: Readonly<AuthMethods> | null = null;
  const close = async (): Promise<boolean> => {
    // Above every epoch a token was issued or checked under: the pod's and this server's copy's.
    const cachedEpoch = authMethodsCache.get(userId)?.value.sessionEpoch ?? 0;
    try {
      const outcome = await applyUpdate(userId, 'delete-account', (draft, live) => {
        closedOn = null;
        // Closed already (a deletion the pod took without confirming it, retried; or the
        // other instance's): nothing to write, and what follows clears this server's memory. The
        // janitor's purge leaves one this process answered 503 to its guest's retry, until its guest
        // deadline: nothing is cleared (unconfirmedPlayDeletions).
        if (live && isTombstone(live)) {
          if (opts.playPurge && live.provisionalPlayPurgePending !== true && awaitsGuestRetry(userId)) return NoWrite('kept');
          closedOn = live;
          return NoWrite('closed');
        }
        writtenOver = live;
        // Kept: the writer makes this server's copy what the pod holds, so the next decision sees it.
        if (opts.stillDeletable && !opts.stillDeletable(live ?? emptyAuthMethods(userId))) return NoWrite('kept');
        const tombstone = deletionTombstone(userId, Math.max(live?.sessionEpoch ?? 0, cachedEpoch), opts.playPurge === true);
        for (const k of Object.keys(draft)) delete (draft as unknown as Record<string, unknown>)[k];
        Object.assign(draft, tombstone);
        closedOn = tombstone;
        return Write;
      }, { tombstone: 'replace', absent: 'create' });
      if (outcome.written === false && outcome.reason === 'kept') return false;
    } catch (err) {
      // A write whose outcome is unknown (a 5xx, a timeout) may have landed: the writer settled
      // what the pod holds under this lock. A tombstone there is a closed account, so the
      // deletion goes on to clear memory and the agent registry; anything else is answered 503,
      // and the account stays whole, here and on the pod.
      const after = err instanceof AuthMethodsWriteError ? err.podRecord as AuthMethods | null | undefined : undefined;
      if (!after || !isTombstone(after)) {
        // A Play owner's deletion nothing could settle: the pod may hold its tombstone, and the
        // route answers 503 and asks for the retry, which the janitor leaves it to until its guest
        // deadline.
        if (!opts.playPurge && userId.startsWith('u-try-play-') && err instanceof AuthMethodsWriteError && err.unknownOutcome && after === undefined) {
          unconfirmedPlayDeletions.set(userId, playGuestDeadline(writtenOver as Readonly<AuthMethods> | null));
        }
        throw err;
      }
      closedOn = after;
      log(`WARN: deletion of ${userId}: the pod took the tombstone without confirming it (${(err as Error).message})`);
    }
    if (!userId.startsWith('u-try-play-')) deletedUserIds.add(userId);
    // Token revocation: the tombstone has no credentials, so the account does not load and
    // verifyToken refuses its tokens; its session epoch is above every token issued, too.
    authMethodsCache.delete(userId);
    removeFromIndexes(userId);
    recordWatchers.changed(userId);
    return true;
  };
  let closed: boolean;
  if (opts.lockHeld) {
    assertLockHeld(userId);
    closed = await close();
  } else {
    closed = await withIdentityPodMutex(userId, close);
  }
  if (!closed) return { agents: [], tombstoned: true, kept: true, podCleanup };
  const purgePending = (closedOn as AuthMethods | null)?.provisionalPlayPurgePending === true;

  const ownedAgentIds = [...identities.values()]
    .filter(i => i.type === 'agent' && i.owner === userId)
    .map(a => a.id);
  for (const agentId of ownedAgentIds) {
    identities.delete(agentId);
    keys.delete(agentId);
  }
  identities.delete(userId);
  keys.delete(userId);
  // Gone from identities, so none of its surface agents can be restored; release its count
  // and what was read of its registry.
  surfaceAgentRestores.forgetUser(userId);
  podRegistryCache.delete(userId);

  // The janitor's purge that found a deletion's tombstone (one no purge marked: the other
  // instance's deletion, whose memory was not cleared here) only forgets the account: that
  // deletion removed the registry, and its owner may be provisioned again until its guest deadline
  // (provisional-play-store.ts), so a registry here now may be the relay's for the reopened owner.
  // A deletion this process answered 503 is finished instead (its guest deadline has passed, or
  // close() would have kept it): no provisioning restores the owner any more, and nothing else would
  // send the deletion's registry DELETE.
  const unconfirmed = unconfirmedPlayDeletions.has(userId);
  if (opts.playPurge && !purgePending && !unconfirmed) return { agents: ownedAgentIds, tombstoned: true, podCleanup };
  unconfirmedPlayDeletions.delete(userId);
  // Bounded like every request of this function: the janitor's purge of a Play owner makes it
  // holding the owner's lock (lockHeld), and the route's answer waits for it.
  try {
    const r = await fetch(`${CSS_URL}${userId}/agents`, { method: 'DELETE', signal: AbortSignal.timeout(POD_RECORD_TIMEOUT_MS) });
    podCleanup.agents = r.status;
  } catch { /* best-effort */ }

  return { agents: ownedAgentIds, tombstoned: true, ...(purgePending ? { purgePending: true as const } : {}),
    ...(opts.playPurge && unconfirmed ? { unconfirmed: true as const } : {}), podCleanup };
}

/**
 * The janitor's purge of a Play owner (provisional-play-cleanup.ts), under the owner's lock. Nothing
 * is deleted until the account is closed: its tombstone written on the ETag of the record checked
 * under this lock (deleteUserCompletely, playPurge), so an enrolment that lands after the read (the
 * other instance's) makes that write fail, and the record read again keeps the account. The
 * tombstone is marked (provisionalPlayPurgePending) and the owner is put in unfinishedPlayPurges
 * before the pod's other resources are deleted; once they all are, the mark is cleared
 * (finishPlayPurge) and the owner taken out. A deletion that fails leaves both, and the next pass
 * (or, after a restart, the startup scan) comes back to it: the account is already closed, so
 * close() finds the marked tombstone, writes nothing, and the remaining deletions are sent again.
 * It used to close the account and forget it before deleting anything, and a DELETE that failed
 * once (a 5xx, a timeout) left the pod's data for good: the janitor walks only `identities`, and a
 * tombstone loads no account. The record and its container stay, as the tombstone.
 *
 * A tombstone the purge did not mark (a deletion's, the other instance's, or a purge finished
 * elsewhere) is not purged: its owner is only forgotten here. A deleted Play owner may be
 * provisioned again over its tombstone until its guest deadline (provisional-play-store.ts), and
 * the other instance's provisioning does not wait for this server's lock, so deleting the pod's
 * resources then could delete those of an owner provisioned again meanwhile. A purge marks only a
 * tombstone it writes over an anchor whose deadline has passed, which provisioning refuses to restore.
 * One exception: a deletion this process answered 503 (unconfirmedPlayDeletions), which the sweep
 * passes over before its guest deadline (the guest's retry finishes it), and which close() keeps if
 * a purge decided before the 503 reaches it all the same. After that deadline, close() finishes
 * the deletion (the registry DELETE, as the retry would have): no provisioning restores the owner
 * then.
 */
async function purgePlayOwner(userId: string): Promise<void> {
  let closed = false;
  let finished = false;
  try {
    await withIdentityPodMutex(userId, async () => {
      const purge = await purgeProvisionalPlayPod({ userId, cssUrl: CSS_URL,
        close: async () => {
          const r = await deleteUserCompletely(userId, { lockHeld: true, stillDeletable: playOwnerPurgeable, playPurge: true });
          if (r.kept) return 'kept';
          closed = true;
          if (!r.purgePending) { finished = r.unconfirmed === true; return 'closed'; }
          unfinishedPlayPurges.add(userId);
          return 'purge';
        },
      });
      if (purge === 'purged') await finishPlayPurge(userId);
      unfinishedPlayPurges.delete(userId);
      if (purge === 'kept') log(awaitsGuestRetry(userId)
        ? `Janitor: left ${userId} to its guest's retry: its deletion was answered 503 (not confirmed), and its guest deadline has not passed`
        : `Janitor: kept ${userId}: it holds a credential now, or its anchor has not expired`);
      if (purge === 'closed') log(finished
        ? `Janitor: finished the deletion of ${userId} answered 503 (not confirmed) and not retried before its guest deadline: its agent registry deleted`
        : `Janitor: forgot ${userId}: its record is a tombstone no purge left unfinished (a deletion's); its pod is left as it is`);
    });
  } catch (err) {
    log(closed || unfinishedPlayPurges.has(userId)
      ? `Janitor: purge of ${userId} unfinished, its account closed; tried again at the next pass: ${(err as Error).message}`
      : `Janitor: provisional cleanup kept ${userId}: ${(err as Error).message}`);
  }
}

/**
 * The end of a Play owner's purge, under its lock, once every other resource of the pod is
 * deleted: its tombstone is written again without the mark (on its ETag), so neither the janitor
 * nor a restart comes back to it. The account was forgotten when it closed, so the record the
 * writer installs is dropped again.
 */
async function finishPlayPurge(userId: string): Promise<void> {
  await applyUpdate(userId, 'play-purge-finished', (draft, live) => {
    if (!live || !isTombstone(live) || live.provisionalPlayPurgePending !== true) return NoWrite('finished');
    delete draft.provisionalPlayPurgePending;
    return Write;
  }, { tombstone: 'replace', absent: 'pass' });
  authMethodsCache.delete(userId);
  removeFromIndexes(userId);
}

app.post('/users/me/delete', tokenLimiter, async (req, res) => {
  // A token refused only because the pod holds this account's tombstone, while this process
  // still holds the account, finishes the deletion (unfinishedDeletion): the retry a 503 below
  // asks for, of a deletion the pod took without confirming it.
  const user = await requireUserFromBearer(req, res, { closedOnPod: 'accept' });
  if (!user) return;
  let result: DeletionResult;
  try {
    // It takes the account's lock itself, for every id.
    result = await deleteUserCompletely(user.id);
  } catch (err) {
    log(`WARN: deletion of ${user.id} not completed: ${(err as Error).message}`);
    if (err instanceof AuthMethodsWriteError && err.unknownOutcome && err.podRecord === undefined) {
      // The write was not confirmed and nothing could settle it: the pod may hold the tombstone.
      res.status(503).json({ error: 'Deletion not confirmed', detail: 'The pod did not confirm the deletion, so it may or may not have taken it. Try again in a minute with the same token: the retry finishes it either way.' });
      return;
    }
    if (err instanceof PodReadError) {
      // Nothing was sent: the record could not be read. That says nothing about an earlier
      // deletion (the retry the answer above asks for, while the pod is still unreadable), which
      // may have taken; it used to be told the pod did not take the deletion.
      res.status(503).json({ error: 'Could not read this account just now', detail: 'This request changed nothing, and an earlier deletion of this account may already have taken. Try again in a minute with the same token: the retry finishes it either way.' });
      return;
    }
    res.status(503).json({ error: 'Deletion not completed', detail: 'The pod did not take the deletion. Nothing was changed; try again in a minute.' });
    return;
  }
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
/**
 * Where the RELAY lives, as told to a signed-in user.
 *
 * ★ THIS WAS DERIVED BY STRING SURGERY TUNED TO A HOSTNAME SCHEME WE NO LONGER USE.
 * It read `BASE_URL.replace('-identity.', '-relay.')`, which was correct for the old
 * Azure names (`interego-identity.<region>...` -> `interego-relay.<region>...`). On
 * the current hosts (`identity.interego.xwisee.com`) that substring never occurs, so
 * the replace was a NO-OP and relayBase silently became the IDENTITY host.
 *
 * Nothing errored. The dashboard simply told every signed-in user to point their MCP
 * client at `https://identity.interego.xwisee.com/sse` — which 404s — and fetched the
 * inbox from a host that does not serve one, rendering the 404's HTML into the card.
 * The primary post-enrollment instruction has been wrong since the migration.
 *
 * ★ THE PATH WAS WRONG TOO, AND OUTLIVED THE HOST FIX. Repairing the host left the
 * instruction pointing at `<relay>/sse`, which is not an MCP transport on the relay
 * either — see the `/sse` handler in `deploy/mcp-relay/server.ts`. Every surface of this
 * server now hands out `/mcp`.
 *
 * So it is now explicit and configurable, it handles BOTH schemes, and the degenerate
 * case is LOUD: resolving to our own origin means the derivation failed again, and a
 * warning at least appears in the logs rather than in a user's MCP client.
 */
function relayPublicBase(): string {
  const explicit = process.env['RELAY_PUBLIC_URL'];
  const derived = (explicit && explicit.trim())
    ? explicit.trim()
    : BASE_URL
        // current scheme: identity.<zone> -> relay.<zone>
        .replace(/^(https?:\/\/)identity\./i, '$1relay.')
        // legacy scheme, kept so an older deployment still resolves
        .replace('-identity.', '-relay.');
  return derived.replace(/\/$/, '');
}

function resolveRelayBase(): string {
  const out = relayPublicBase();
  if (out === BASE_URL.replace(/\/$/, '')) {
    console.error(
      '[identity] relay base resolved to our OWN origin (%s). The dashboard will hand ' +
      'users a dead MCP endpoint. Set RELAY_PUBLIC_URL.', out);
  }
  return out;
}

app.get('/dashboard', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'public, max-age=300');
  const relayBase = resolveRelayBase();
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
    foot.innerHTML = 'Add the relay to your MCP client: <code style="color:#a78bfa">' + RELAY_BASE + '/mcp</code>';
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

// A first sign-in (a credential no account holds yet), an add or an invite claim sent with the
// token from "Add this credential to an account you already have" whose token no longer verifies
// (expired, signed out, deleted, or the dashboard's own copy gone stale) is refused with 401 and
// changes nothing: it does not go on without the token. (A wallet an account already lists signs
// in whatever bearer comes with it: /auth/siwe checks the bearer only when no account holds the
// wallet.) Say so, and how to go on.
function staleTokenHint(status, error, adv) {
  if (status !== 401 || !adv.addDeviceToken || !/^Invalid bearer token/.test(String(error || ''))) return '';
  return ' The token under Advanced options ("Add this credential to an account you already have") no longer works: '
    + 'clear it to ' + (adv.bootstrapUserId ? 'claim the invite' : 'sign in') + ' with this credential alone, '
    + 'or paste a token from a new sign-in to add it to that account.';
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
    if (!optRes.ok) {
      const text = await optRes.text();
      let failed = {};
      try { failed = JSON.parse(text); } catch (e) { /* not JSON: shown as it is */ }
      throw new Error('register-options: ' + text + staleTokenHint(optRes.status, failed.error, adv));
    }
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

    // The server returns the address in EIP-55 form: a wallet reads the message as a sign-in
    // (and checks its domain line) only with a checksummed address.
    const chResp = await fetch(BASE + '/challenges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'siwe', address: accounts[0] }),
    });
    const ch = await chResp.json();
    if (!chResp.ok || !ch.nonce) throw new Error(ch.error || ('Could not get a challenge (HTTP ' + chResp.status + ')'));
    const nonce = ch.nonce;
    const address = ch.address || accounts[0];

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
    else setStatus('Sign-in failed: ' + (result.error || 'Unknown error') + staleTokenHint(authResp.status, result.error, adv), 'error');
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

// The last middleware, after every route: a request that fails answers JSON, with no stack.
app.use(routeErrorHandler(log));

// ── Start ───────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`Interego Identity Server v2 started on port ${PORT}`);
  log(`Base URL: ${BASE_URL}`);
  log(`CSS URL: ${CSS_URL}`);
  if (INTROSPECTION_MODE === 'enforced') {
    log(`Introspection: ENFORCED — /tokens/verify answers only a caller presenting IDENTITY_INTROSPECTION_SECRET as a bearer; relay and css-gate must hold the same value${ALLOW_OPEN_INTROSPECTION ? '. ALLOW_OPEN_INTROSPECTION=1 is ignored while the secret is set; remove it once both callers are confirmed' : ''}.`);
    // The values no caller can present intact in `Authorization: Bearer <value>`, as measured on
    // Node 20 and 22: a trailing space or tab is dropped (by fetch, and by Node's parser here), an
    // ASCII control character other than TAB (U+0000-U+001F or U+007F) makes fetch throw and this
    // server answer 400, and a character above U+00FF makes fetch throw and can never arrive (a
    // header reads as Latin-1). Leading or interior spaces and tabs, and other Latin-1 characters
    // (the C1 controls U+0080-U+009F among them), arrive intact.
    // css-gate's startup line uses the same rule and wording.
    if (/[\t ]$|[\x00-\x08\x0a-\x1f\x7f]|[^\x00-\xff]/.test(IDENTITY_INTROSPECTION_SECRET)) {
      log('WARN: IDENTITY_INTROSPECTION_SECRET ends in a space or tab, or holds an ASCII control character other than TAB (U+0000-U+001F or U+007F) or a character above U+00FF; such a value cannot be sent intact in a header, so no caller can present it and /tokens/verify refuses every caller. Use 32 random bytes as hex.');
    }
  } else if (INTROSPECTION_MODE === 'open') {
    log('WARN: token introspection is running in OPEN mode (ALLOW_OPEN_INTROSPECTION=1) — /tokens/verify is an unauthenticated oracle. Set IDENTITY_INTROSPECTION_SECRET on relay and css-gate first, then the same value here, then remove ALLOW_OPEN_INTROSPECTION (deploy/identity/AUTH-ARCHITECTURE.md).');
  } else {
    log(`Introspection: FAIL-CLOSED (no IDENTITY_INTROSPECTION_SECRET, no ALLOW_OPEN_INTROSPECTION) — /tokens/verify returns 401 until one is set.`);
  }
  log(`WebAuthn RP: static id=${RP_ID} origin=${RP_ORIGIN}; per-request allowlist=[${[...RP_ALLOWLIST.keys()].join(', ') || '(none)'}]`);
  log(`SIWE domains (first line of a wallet sign-in message): [${[...siweDomainSources()].map(([h, src]) => `${h} (${src})`).join(', ')}]; add a front-end with SIWE_DOMAINS`);
  log(`DID sign-in: did-sig challenges carry a message naming ${BASE_URL_HOST}`);
  if (DID_ACCEPT_BARE_NONCE) {
    log(`WARN: DID sign-in still accepts a signature over the bare nonce (DID_ACCEPT_BARE_NONCE unset or 1); each sign-in made with one is logged as identity_did_bare_nonce. Set DID_ACCEPT_BARE_NONCE=0 to refuse them once no known client is logged.`);
  } else {
    log(`DID sign-in: a signature over the bare nonce is refused (DID_ACCEPT_BARE_NONCE=0)`);
  }
  log(`Auth: decentralized — user credentials stored per-pod at <pod>/auth-methods.jsonld`);
  log(`Bootstrap invites: ${BOOTSTRAP_INVITES.size} configured${BOOTSTRAP_INVITES.size > 0 ? ' (' + [...BOOTSTRAP_INVITES.keys()].join(', ') + ')' : ''}`);
  log(`Endpoints:`);
  log(`  POST /register                        DEPRECATED (410 Gone) — userId is derived, not claimed`);
  log(`  POST /challenges                      Issue proof-of-possession nonce (did-sig: and the message to sign)`);
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
  // against a small timeout before its didIndex lookup — see
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
  // test run so we never race with an in-flight test. TEST_AGENT_PATTERN
  // is at module scope (beside seedIdentity) so restores can refuse it.
  const JANITOR_INTERVAL_MS = parseInt(process.env['JANITOR_INTERVAL_MS'] ?? '300000');     // 5 min
  const TEST_USER_GRACE_MS = parseInt(process.env['TEST_USER_GRACE_MS'] ?? '900000');       // 15 min
  if (JANITOR_INTERVAL_MS > 0) {
    setInterval(async () => {
      const now = Date.now();
      const testCutoff = now - TEST_USER_GRACE_MS;
      const tryCutoff = now - TRY_USER_TTL_MS;
      const allAgents = [...identities.values()].filter(i => i.type === 'agent');
      const toPurge = new Set<string>();
      // The `u-try-*` ids below are reaped only if, read again from the pod under the lock,
      // they still hold no credential: the decision here is made on this server's copy.
      const unclaimedTry = new Set<string>();
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
        if (u.id.startsWith('u-try-play-')) {
          // A deletion answered 503 here is left to its guest's retry until its guest deadline, and
          // not read meanwhile (unconfirmedPlayDeletions).
          if (awaitsGuestRetry(u.id)) continue;
          try {
            // Read through to the pod before deletion; never infer "unclaimed"
            // from a transient dependency failure or a process-local timestamp.
            const methods = (await readLive(u.id)).methods ?? emptyAuthMethods(u.id);
            // A tombstone: a purge left unfinished, finished below, or a deletion whose memory was
            // not cleared here (the other instance's), only forgotten (playOwnerPurgeable), or one
            // answered 503 here whose guest deadline has passed, finished below.
            if (!isTombstone(methods)) provisionalPlay.open(methods.provisionalPlayAnchor, true);
            if (playOwnerPurgeable(methods)) toPurge.add(u.id);
          } catch (error) { log(`Janitor: kept unreadable provisional owner ${u.id}: ${(error as Error).name}`); }
          continue;
        }
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
        unclaimedTry.add(u.id);
      }
      // Play purges a pass closed but could not finish, and those the startup scan found unfinished.
      for (const id of unfinishedPlayPurges) toPurge.add(id);
      if (toPurge.size === 0) return;
      log(`Janitor: purging ${toPurge.size} stale user(s) (test + try-it)`);
      for (const uid of toPurge) {
        if (uid.startsWith('u-try-play-')) {
          void purgePlayOwner(uid);
          continue;
        }
        deleteUserCompletely(uid, unclaimedTry.has(uid) ? { stillDeletable: m => !hasAnyCredential(m) } : {})
          .then(r => { if (r.kept) log(`Janitor: kept ${uid}: it holds a credential now`); })
          .catch(err => log(`Janitor: failed to delete ${uid}: ${(err as Error).message}`));
      }
    }, JANITOR_INTERVAL_MS).unref();
    log(`Janitor: scanning every ${JANITOR_INTERVAL_MS}ms; test grace ${TEST_USER_GRACE_MS}ms (pattern ${TEST_AGENT_PATTERN}); try-it TTL ${TRY_USER_TTL_MS}ms`);
  }
});

