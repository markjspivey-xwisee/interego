/**
 * CSS write-gate.
 *
 * The deployment's Community Solid Server is configured allow-all
 * (`css:config/ldp/authorization/allow-all.json`) — privacy of payload
 * is handled at the Interego client-side encryption layer, not at the
 * ACL layer. That's fine for confidentiality, but it lets anyone who
 * knows the pod URL inject junk descriptors.
 *
 * This gate sits in front of CSS and:
 *   GET / HEAD / OPTIONS  →  passthrough (anonymous reads stay open —
 *                            the pod-browser, federation discover(),
 *                            descriptor dereferencing all still work),
 *                            EXCEPT the identity server's own record in
 *                            each pod (PRIVATE_POD_DOCUMENTS below), which
 *                            is read like a write: by its owner or the
 *                            operator only, and written by the operator
 *                            only
 *   POST / PUT / PATCH / DELETE  →  require Authorization: Bearer; one
 *                                   of two acceptable bearer types:
 *
 *     (a) Operator bearer — equals WRITE_SECRET. Trusted infra path
 *         (seeders, the relay's own service identity, deploy-time
 *         tooling). Allowed to write to ANY path on the pod.
 *
 *     (b) Per-user bearer — verified against the identity server's
 *         POST /tokens/verify endpoint. The gate extracts `userId`
 *         from the verified token claims and ENFORCES that the
 *         request URL path begins with `/<userId>/` (i.e. the
 *         user can only write into their own pod). Cross-pod writes
 *         from a user bearer are 403'd here.
 *
 *     Verified user bearers are cached for USER_BEARER_CACHE_TTL_MS
 *     (default 60s) to avoid round-tripping identity on every write.
 *
 *   The bearer is stripped before forwarding so CSS doesn't try to
 *   parse it as a DPoP/OIDC token. CSS is allow-all behind the gate;
 *   auth is the gate's job, not CSS's.
 *
 * Env vars:
 *   WRITE_SECRET     — operator bearer (required).
 *   IDENTITY_URL     — identity server base URL for /tokens/verify
 *                      (primary per-user-bearer verifier; if unset,
 *                      identity-signed tokens won't be accepted but
 *                      the relay-introspection fallback below still
 *                      works on its own).
 *   RELAY_VERIFY_URL — MCP relay base URL for /verify-token (fallback
 *                      verifier for the relay's opaque OAuth access
 *                      tokens, which identity-server can't verify).
 *                      Unset => fallback DISABLED.
 *   RELAY_INTROSPECTION_SECRET — shared secret the gate carries on
 *                      its outbound /verify-token call; MUST match
 *                      the same env var on the relay. Required when
 *                      RELAY_VERIFY_URL is set.
 *   IDENTITY_INTROSPECTION_SECRET — bearer the gate presents on its
 *                      /tokens/verify call to IDENTITY_URL. MUST equal
 *                      the identity server's and the relay's value.
 *                      Unset works only while identity runs open
 *                      (ALLOW_OPEN_INTROSPECTION=1). See
 *                      deploy/identity/AUTH-ARCHITECTURE.md.
 *   CSS_INTERNAL_URL — upstream CSS.
 *   CSS_HOST_HEADER  — Host header to forward to CSS.
 *   USER_BEARER_CACHE_TTL_MS — verified-token cache TTL (default 60000).
 *   UPSTREAM_POOL_CONNECTIONS — undici Pool size per upstream origin
 *                               (default 16). On h1 (the default) each
 *                               connection is one in-flight request at a
 *                               time; on h2 (UPSTREAM_ALLOW_H2=1) each
 *                               connection multiplexes many streams.
 *   UPSTREAM_REQUEST_BUFFER   — when "1" / "true", buffer request bodies
 *                               before forwarding (legacy behavior; kept
 *                               as an escape hatch). Default is streaming
 *                               via undici over the pooled connection.
 *   UPSTREAM_ALLOW_H2          — when "1" / "true", enable ALPN-negotiated
 *                               HTTP/2 on the upstream Pool. Default false.
 *                               Container Apps' internal envoy ALPN-advertises
 *                               h2 but RST_STREAMs requests under sustained
 *                               load (observed as ECONNRESET storms against
 *                               the gate's pool while the relay — which uses
 *                               h1 via fetch — stays healthy against the same
 *                               upstream). Forcing h1 matches the relay's
 *                               working path; flip this knob on once envoy
 *                               h2 is wire-confirmed healthy.
 *
 * Upstream transport: undici Pool over HTTP/1.1 by default (allowH2=false).
 * The pool keeps connections warm across requests so a chatty client
 * (Foxxi bridge writing one descriptor per affordance call) does not pay
 * TLS cost per request. undici's low-level Pool API does NOT enforce
 * fetch's forbidden-headers list, so we can set the Host header explicitly
 * — which is the entire reason the previous version had to drop to raw
 * https.request in the first place.
 */

import { createServer } from 'http';
import { createHash } from 'node:crypto';
import { Pool } from 'undici';
import { PROVISIONAL_BUDGET_DOCUMENT, provisionalLimits, verifiedProvisional,
  checkProvisionalTarget, readProvisionalCommit, reserveProvisionalWrite, createProvisionalWriteLimiter } from './provisional-play.mjs';

const PROVISIONAL_LIMITS = provisionalLimits();
const acquireProvisionalWrite = createProvisionalWriteLimiter();

const PORT = Number(process.env.PORT ?? 8080);
// Fail-fast: CSS is internal-only (--ingress internal). The canonical
// upstream is the `.internal.` FQDN set by deploy/azure-deploy.sh. No
// default — a missing env var here would silently dial the legacy
// public host that no longer resolves.
if (!process.env.CSS_INTERNAL_URL) {
  console.error('[css-gate] FATAL: CSS_INTERNAL_URL is required (the upstream CSS on the private network, e.g. http://css.railway.internal:3456/)');
  process.exit(1);
}
const CSS_INTERNAL_URL = process.env.CSS_INTERNAL_URL;
// Public origin of THIS gate. Returned as ACAO when the request Origin
// is off-list — browsers refuse to read it because no off-list caller
// has that origin.
if (!process.env.PUBLIC_BASE_URL) {
  console.error('[css-gate] FATAL: PUBLIC_BASE_URL is required (the gate\'s own public FQDN)');
  process.exit(1);
}
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
// CSS validates that incoming requests' Host header matches its
// configured CSS_BASE_URL ("outside the configured identifier space"
// errors otherwise). When the gate connects to CSS at an internal
// hostname (after CSS is moved behind the gate), the Host header must
// stay the public hostname so CSS accepts. Defaults to the host of
// CSS_INTERNAL_URL when not set.
const CSS_HOST_HEADER = process.env.CSS_HOST_HEADER ?? null;
const WRITE_SECRET = process.env.WRITE_SECRET;
const IDENTITY_URL = (process.env.IDENTITY_URL ?? '').replace(/\/+$/, '');
// MCP relay base URL — used as a SECOND verification source for
// per-user bearers. The relay's OAuth flow mints opaque random-hex
// access tokens that identity-server has never seen and cannot
// verify (parseAndVerifySignature() rejects them outright). For those
// tokens, the gate falls back to POST {RELAY_VERIFY_URL}/verify-token,
// which returns the same { valid, userId, ... } shape this gate
// already consumes from identity-server. Try identity FIRST (cheaper,
// also works for purely-identity flows like the dashboard), then the
// relay; this avoids a round-trip for the common identity-server
// case. Both endpoints share the SAME cache, keyed by the raw token,
// so a token verified by either path is hot on the second hit.
//
// Unset => relay fallback DISABLED; only identity-server tokens work.
// Operator WRITE_SECRET path is unaffected by either env var.
const RELAY_VERIFY_URL = (process.env.RELAY_VERIFY_URL ?? '').replace(/\/+$/, '');
// Shared secret the gate carries on its outbound /verify-token call
// to the relay. The relay rejects any introspection request that
// doesn't carry this exact bearer. MUST match the relay's
// RELAY_INTROSPECTION_SECRET; mismatch => every relay-OAuth-bearer
// write returns 401 here.
const RELAY_INTROSPECTION_SECRET = process.env.RELAY_INTROSPECTION_SECRET ?? '';
// Shared secret the gate carries on its outbound /tokens/verify call
// to identity-server, as `Authorization: Bearer <value>`. An identity
// server holding its own copy answers a verify without it (or with
// another value) with 401. The gate treats that 401 as a transport
// failure and asks the relay (when RELAY_VERIFY_URL is set), which does
// not know identity tokens, so every identity-token write and
// private-document read then gets 401 'token not found or expired'.
// Unset here is accepted only while identity runs open
// (ALLOW_OPEN_INTROSPECTION=1 and no secret of its own).
// See deploy/identity/AUTH-ARCHITECTURE.md.
const IDENTITY_INTROSPECTION_SECRET = process.env.IDENTITY_INTROSPECTION_SECRET ?? '';
// How identity has answered the gate's /tokens/verify calls since this process started, for
// /healthz: `accepted` = identity answered 2xx (whatever it said about the token), `refused` =
// it answered 401 or 403 (it refused the gate's introspection bearer), `other` = anything else
// (unreachable, a redirect, 5xx, another 4xx, a body that is not JSON). Cache hits are not
// counted. tools/identity-introspection-provision.mjs reads a rise in `accepted` as identity
// accepting the gate, so nothing else may land there.
const identityVerifyResults = { accepted: 0, refused: 0, other: 0 };
const USER_BEARER_CACHE_TTL_MS = Number(process.env.USER_BEARER_CACHE_TTL_MS ?? 60_000);
const UPSTREAM_POOL_CONNECTIONS = Number(process.env.UPSTREAM_POOL_CONNECTIONS ?? 16);
const UPSTREAM_REQUEST_BUFFER = (process.env.UPSTREAM_REQUEST_BUFFER ?? '').toLowerCase() === 'true'
  || process.env.UPSTREAM_REQUEST_BUFFER === '1';
// Default: HTTP/1.1 only. See header comment + the ECONNRESET-vs-h2
// isolation notes. Container Apps' envoy ALPN-advertises h2 but RST_STREAMs
// pooled h2 streams under sustained load, while the same envoy serves h1
// happily — the relay (fetch, h1) is the working proof. Flip via env var
// once the upstream is wire-confirmed healthy on h2.
const UPSTREAM_ALLOW_H2 = (process.env.UPSTREAM_ALLOW_H2 ?? '').toLowerCase() === 'true'
  || process.env.UPSTREAM_ALLOW_H2 === '1';

if (!WRITE_SECRET) {
  console.error('[css-gate] WRITE_SECRET env var is required');
  process.exit(1);
}

if (!IDENTITY_URL && !(RELAY_VERIFY_URL && RELAY_INTROSPECTION_SECRET)) {
  console.warn(
    '[css-gate] neither IDENTITY_URL nor (RELAY_VERIFY_URL + RELAY_INTROSPECTION_SECRET) is set — ' +
    'per-user bearer writes will be rejected. Only the operator WRITE_SECRET bearer will be accepted.',
  );
}
if (RELAY_VERIFY_URL && !RELAY_INTROSPECTION_SECRET) {
  console.warn(
    '[css-gate] RELAY_VERIFY_URL is set but RELAY_INTROSPECTION_SECRET is empty — ' +
    'relay introspection fallback is DISABLED (the relay would reject our unauthenticated probes).',
  );
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * ★ POD DOCUMENTS ONLY THEIR OWNER READS.
 *
 * `auth-methods.jsonld` is the identity server's record of a user's sign-in credentials: their
 * display name, wallet addresses, passkey ids, labels, public keys and counters, and DID keys. It
 * is plaintext, because the identity server must read it to sign anyone in, and CSS behind this
 * gate is allow-all. Read anonymously, as every other pod document is, the gate served all of
 * them to anyone who listed the root container — every account's name tied to its wallets, its
 * passkeys' device labels and its DIDs. Nothing outside the identity server reads it, and that
 * server reads it from CSS directly over the private network, not through this gate; a user
 * audits their own through the identity server's `GET /auth-methods/me`. So it is read here as a
 * write is: by the pod's owner or by the operator.
 *
 * ★ AND ONLY THE OPERATOR WRITES IT. The identity server is its only writer, and it writes over
 * the private network too (enrolment, passkey removal, account deletion), never through this
 * gate. A user bearer writing its own record here was the one way to change it that no sign-in
 * stands behind: a stolen bearer, or an OAuth token a client holds, could add the thief's own
 * passkey, wallet or DID, and the identity server would sign that credential in for as long as
 * the record keeps it, long after the bearer expired. Writes to it, to its `.acl` / `.meta`
 * auxiliary resources, and a POST that names it as the Slug of the new resource are the
 * operator's alone. A user changes their credentials through the identity server's endpoints.
 */
const PRIVATE_POD_DOCUMENTS = new Set(['auth-methods.jsonld', PROVISIONAL_BUDGET_DOCUMENT]);

/** A pod document name that is one of PRIVATE_POD_DOCUMENTS or one of its auxiliary resources. */
function isPrivateDocumentName(name) {
  const lower = String(name).toLowerCase();
  return PRIVATE_POD_DOCUMENTS.has(lower) || PRIVATE_POD_DOCUMENTS.has(lower.replace(/\.(acl|meta)$/, ''));
}

// ── CORS allowlist ─────────────────────────────────────────────────
//
// Same posture as deploy/mcp-relay/cors-allowlist.ts and
// deploy/identity/cors-allowlist.ts (kept inline here because css-gate
// is stdlib-only — no TS build, no shared package dependency). See the
// mcp-relay copy for the full rationale. Summary:
//   - Reflect Origin only if it appears on a static allowlist.
//   - Otherwise serve THIS gate's own FQDN as ACAO (a browser caller
//     never matches its own origin against ours, so the response is
//     unreadable cross-origin).
//   - Never set `Access-Control-Allow-Credentials: true`.
//   - Reject `Origin: null` (sandboxed iframes / file://).
//   - Vary: Origin on every response so caches do not leak cross-origin
//     responses to off-list peers.

const SIBLING_DEPLOYMENT_ORIGINS = [
  // NOTE: the Azure origins that used to live here were REMOVED. That environment is
  // paused and its registry deleted, so they were dead config being reflected verbatim
  // as Access-Control-Allow-Origin — and a DNS name nobody owns any more is a name
  // somebody else can claim. An allowlist should only contain origins we still run.
  // CSS pod — internal FQDN only. The bare public-host origin was
  // removed when CSS became internal-only; browser writes now go
  // through interego-css-gate's public FQDN (listed below).
  // Foxxi vertical front-ends that read pods directly (linked-data / pod
  // browser, dashboard, SCORM player). Without these the gate denies their
  // browser origin (serves its own FQDN as ACAO) and the cross-origin pod
  // read fails with "failed to fetch".
  // Live Railway deployment (*.interego.xwisee.com) — the current home; the
  // Azure hosts above are inert legacy (that environment is paused). Without
  // these, a browser front-end on an xwisee host reading a pod through the gate
  // gets the gate's own FQDN as ACAO and the cross-origin read fails.
  'https://interego.xwisee.com',
  'https://relay.interego.xwisee.com',
  'https://identity.interego.xwisee.com',
  'https://dashboard.interego.xwisee.com',
  'https://gate.interego.xwisee.com',
  'https://pgsl-browser.interego.xwisee.com',
  'https://foxxi-microsite.interego.xwisee.com',
  'https://foxxi-dashboard.interego.xwisee.com',
  'https://foxxi-scorm-player.interego.xwisee.com',
  'https://foxxi-bridge.interego.xwisee.com',
];
const BROWSER_MCP_CLIENT_ORIGINS = [
  'https://claude.ai',
  'https://chatgpt.com',
  'https://chat.openai.com',
];
const LOCALHOST_DEV_PORTS = [3000, 4000, 5000, 8080, 8090, 8094, 9999];

function normalizeOrigin(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw.trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function buildCorsAllowlist() {
  const out = new Set();
  const add = (o) => { const n = normalizeOrigin(o); if (n) out.add(n); };
  add(PUBLIC_BASE_URL);
  SIBLING_DEPLOYMENT_ORIGINS.forEach(add);
  BROWSER_MCP_CLIENT_ORIGINS.forEach(add);
  for (const port of LOCALHOST_DEV_PORTS) {
    add(`http://localhost:${port}`);
    add(`http://127.0.0.1:${port}`);
  }
  const envRaw = process.env.RELAY_CORS_ALLOWLIST;
  if (envRaw) for (const piece of envRaw.split(',')) add(piece);
  return out;
}

const CORS_ALLOWLIST = buildCorsAllowlist();
const GATE_OWN_ORIGIN = normalizeOrigin(PUBLIC_BASE_URL)
  ?? 'https://gate.interego.xwisee.com';

export function corsHeadersFor(originHeader) {
  const norm = normalizeOrigin(originHeader);
  const allowed = Boolean(originHeader)
    && originHeader !== 'null'
    && norm
    && CORS_ALLOWLIST.has(norm);
  return {
    // Allowlisted origin → echo it. EVERYTHING else → ACAO * so any browser app
    // can read published (public / content-addressed) pod graphs directly —
    // INCLUDING `Origin: null` (sandboxed-iframe previews / file://), which is
    // exactly how Claude/Anthropic-style app previews present. This is SAFE
    // because the gate sets NO Access-Control-Allow-Credentials (no cookies), so
    // there is no ambient authority to steal — the "credentialed null-origin
    // attack" this used to guard against requires Allow-Credentials, which we
    // never send — and private pod content is E2EE (a wildcard reveals only
    // ciphertext). `*` is accepted by null-origin no-credential requests too.
    'Access-Control-Allow-Origin': allowed ? norm : '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE',
    // Solid/LDP clients send these. Without Slug and Link a browser cannot NAME or
    // TYPE a resource it POSTs; without If-None-Match it cannot do a safe create;
    // without DPoP it cannot use Solid-OIDC at all. A header absent from this list
    // fails preflight, so the request is never sent and the failure surfaces to the
    // developer as an opaque "failed to fetch".
    'Access-Control-Allow-Headers':
      'Accept, Content-Type, Authorization, Slug, Link, If-None-Match, If-Match, DPoP',
    // ★ WITHOUT THIS, A CROSS-ORIGIN SOLID CLIENT IS BLIND TO EVERY LDP CONTROL.
    //
    // CORS exposes only a short safelist to cross-origin JavaScript, and none of the
    // headers this gate exists to serve are on it. `Link` carries rel=type, rel=acl,
    // rel=describedby and rel=storageDescription; `WAC-Allow` is how a client learns
    // its permissions; `Location` is how it learns the URL of a resource it just
    // created; `Accept-Post`/`Accept-Patch`/`Accept-Put` say what it may send. All of
    // it was being sent and none of it could be read from another origin.
    //
    // This is the SAME defect that was fixed on the relay one increment earlier, and
    // finding it here is the lesson repeating: fixing a class means grepping for
    // every instance of the sink, not just the one that was reported. The relay got
    // fixed; the gate — which serves far more hypermedia than the relay does — was
    // never checked.
    'Access-Control-Expose-Headers':
      'Link, ETag, Accept-Post, Accept-Patch, Accept-Put, Location, WAC-Allow, '
      + 'Last-Modified, Content-Type, Allow, Updates-Via, '
      + 'Interego-Native-Commit, Interego-Revision, Interego-Body-Digest, '
      + 'Interego-Provisional-Bytes-Remaining, Interego-Provisional-Writes-Remaining, Interego-Provisional-Expires-At, '
      + 'Interego-Play-Budget-Exhausted',
    'Vary': 'Origin',
    // Deliberately no Access-Control-Allow-Credentials.
  };
}

// Timing-safe string compare so wrong-key attempts don't leak length.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── User bearer verification cache ─────────────────────────────────
//
// Verified-token state for a single bearer:
//   { userId, scope, agentId, expiresAt: epoch-ms-cache-expiry }
// Negative results (valid:false) are cached too, with the same TTL, so
// a wave of bad-token traffic doesn't hammer the identity server.
//
// Cache is in-process only — the gate is small + horizontally scaled,
// and a verified-token round-trip to identity is cheap enough that
// per-replica caches are fine. No invalidation on revoke; the TTL
// bounds the window.
const userBearerCache = new Map();

function cacheGet(token) {
  const entry = userBearerCache.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    userBearerCache.delete(token);
    return null;
  }
  return entry;
}

function cacheSet(token, value) {
  // Lightweight LRU: cap the map at 10k entries; on overflow, drop
  // the oldest insertion. Map iteration order = insertion order.
  if (userBearerCache.size >= 10_000) {
    const oldestKey = userBearerCache.keys().next().value;
    if (oldestKey !== undefined) userBearerCache.delete(oldestKey);
  }
  userBearerCache.set(token, {
    ...value,
    expiresAt: Date.now() + USER_BEARER_CACHE_TTL_MS,
  });
}

/**
 * A name for a failed fetch that cannot carry a header value: the error's `cause.code` when it
 * is a short code (ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT, ...), else the error's own name
 * (TypeError, TimeoutError). Never the message.
 */
function failureLabel(err) {
  const code = err?.cause?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
  const name = err?.name;
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error';
}

/**
 * Inner helper: probe ONE verification source. Returns:
 *   { kind: 'valid',    userId, agentId?, scope? }
 *   { kind: 'invalid',  reason }    — source authoritatively rejected
 *   { kind: 'unknown',  reason }    — source returned valid:false WITHOUT
 *                                     claiming jurisdiction (the gate
 *                                     should try the next source)
 *   { kind: 'transport',reason }    — source unreachable / 5xx; don't
 *                                     cache, optionally try next source
 *
 * The kind=unknown vs kind=invalid distinction matters because
 * identity-server returns 200 + { valid:false } for tokens it doesn't
 * recognize OR tokens it recognizes-but-rejects, and we can't tell
 * those apart at this layer. We treat ALL identity 200+invalid replies
 * as kind=unknown so the relay fallback gets a chance; if the relay
 * also rejects, we cache invalid and return 401.
 */
async function probeVerifySource(url, token, opts = {}) {
  const { bearer } = opts;
  let resp;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token }),
      // Neither verifier redirects. Following one would carry the bearer above (on a same-origin
      // redirect) and the user's token in the body (to any origin, on a 307 or 308) to wherever
      // the Location points. fetch throws instead, which lands in the catch below as 'transport'.
      // This covers the relay /verify-token call too.
      redirect: 'error',
      // ★★ BOUNDED, BECAUSE AN UNBOUNDED ONE PINS A REQUEST HANDLER FOREVER.
      //
      // This awaits the identity server or the relay. Neither is guaranteed to answer: MEASURED,
      // a relay redeploy leaves it unreachable for ~45 s, and a hung host completes TLS and then
      // says nothing at all — which is exactly what this gate itself did twice tonight. Without a
      // deadline every write arriving during that window parks here, and each one holds its slot
      // until the process is restarted.
      //
      // A verify that cannot answer in ten seconds is not going to; `probeVerifySource` already
      // treats a transport failure as "unknown" and lets the next source weigh in, so the timeout
      // lands on a path that is designed for it.
      signal: AbortSignal.timeout(Number(process.env.VERIFY_TIMEOUT_MS ?? 10_000)),
    });
  } catch (err) {
    // Not err.message: undici's header-validation error quotes the whole Authorization header
    // (the introspection secret), and this reason is returned in the 401 `detail`.
    return { kind: 'transport', reason: `${url} unreachable (${failureLabel(err)})` };
  }
  if (resp.status >= 500) {
    return { kind: 'transport', reason: `${url} returned ${resp.status}` };
  }
  if (resp.status === 401 || resp.status === 403) {
    // The verifier rejected US (the gate), not the token. This is a
    // config error — the secret/headers we sent are wrong. Treat as
    // unknown so the next source still gets to weigh in; don't cache.
    return { kind: 'transport', refused: true, reason: `${url} rejected gate auth (${resp.status})` };
  }
  if (!resp.ok) {
    // 4xx other than auth: the verifier doesn't recognize this
    // request shape. Treat as transport so the caller can try the
    // next source; don't cache.
    return { kind: 'transport', reason: `${url} returned ${resp.status}` };
  }
  let data;
  try {
    data = await resp.json();
  } catch {
    return { kind: 'transport', reason: `${url} returned non-JSON` };
  }
  if (!data || typeof data !== 'object') {
    return { kind: 'transport', reason: `${url} returned non-object` };
  }
  if (data.valid === true) {
    if (typeof data.userId !== 'string' || !data.userId) {
      return { kind: 'invalid', reason: 'verified token has no userId claim' };
    }
    let provisionalPlay;
    try { provisionalPlay = verifiedProvisional(data); }
    catch (error) { return { kind: 'invalid', reason: error.message }; }
    return {
      kind: 'valid',
      userId: data.userId,
      agentId: typeof data.agentId === 'string' ? data.agentId : undefined,
      scope: typeof data.scope === 'string' ? data.scope : undefined,
      ownerDid: typeof data.ownerDid === 'string' ? data.ownerDid : undefined,
      provisionalPlay,
    };
  }
  return { kind: 'unknown', reason: data.reason ?? 'token not recognized' };
}

/**
 * Verify a per-user bearer.
 *
 * Tries identity-server's /tokens/verify FIRST (cheap, also covers
 * the dashboard flow + any direct-to-identity callers). On a miss
 * (200 + valid:false), falls back to the relay's /verify-token if
 * RELAY_VERIFY_URL is configured — the relay's opaque OAuth access
 * tokens live ONLY in the relay's in-process map, so this is the only
 * way to verify them.
 *
 * Returns { ok: true, userId, agentId?, scope? } on a valid token,
 * or { ok: false, status, reason } on invalid / unreachable.
 */
async function verifyUserBearer(token) {
  if (!IDENTITY_URL && !RELAY_VERIFY_URL) {
    return { ok: false, status: 401, reason: 'per-user bearers not supported (no verify URL configured)' };
  }
  const cached = cacheGet(token);
  if (cached) {
    if (cached.valid) {
      if (cached.provisionalPlay && cached.provisionalPlay.expiresAt * 1000 <= Date.now()) {
        return { ok: false, status: 401, reason: 'temporary play credential expired' };
      }
      return { ok: true, userId: cached.userId, agentId: cached.agentId, scope: cached.scope,
        ownerDid: cached.ownerDid, provisionalPlay: cached.provisionalPlay };
    }
    return { ok: false, status: 401, reason: cached.reason ?? 'invalid token' };
  }

  // Track the most informative reason as we walk sources so the
  // final 401 carries useful detail.
  let lastReason = 'no verifier accepted this token';
  let sawTransportFailure = false;

  if (IDENTITY_URL) {
    const r = await probeVerifySource(
      `${IDENTITY_URL}/tokens/verify`,
      token,
      IDENTITY_INTROSPECTION_SECRET ? { bearer: IDENTITY_INTROSPECTION_SECRET } : {},
    );
    if (r.kind !== 'transport') identityVerifyResults.accepted++;
    else if (r.refused) identityVerifyResults.refused++;
    else identityVerifyResults.other++;
    if (r.kind === 'valid') {
      cacheSet(token, { valid: true, userId: r.userId, agentId: r.agentId, scope: r.scope, ownerDid: r.ownerDid, provisionalPlay: r.provisionalPlay });
      return { ok: true, userId: r.userId, agentId: r.agentId, scope: r.scope, ownerDid: r.ownerDid, provisionalPlay: r.provisionalPlay };
    }
    if (r.kind === 'invalid') {
      cacheSet(token, { valid: false, reason: r.reason });
      return { ok: false, status: 401, reason: r.reason };
    }
    if (r.kind === 'transport') sawTransportFailure = true;
    lastReason = r.reason;
  }

  if (RELAY_VERIFY_URL && RELAY_INTROSPECTION_SECRET) {
    const r = await probeVerifySource(
      `${RELAY_VERIFY_URL}/verify-token`,
      token,
      { bearer: RELAY_INTROSPECTION_SECRET },
    );
    if (r.kind === 'valid') {
      cacheSet(token, { valid: true, userId: r.userId, agentId: r.agentId, scope: r.scope, ownerDid: r.ownerDid, provisionalPlay: r.provisionalPlay });
      return { ok: true, userId: r.userId, agentId: r.agentId, scope: r.scope, ownerDid: r.ownerDid, provisionalPlay: r.provisionalPlay };
    }
    if (r.kind === 'invalid' || r.kind === 'unknown') {
      // Both identity and relay say no — cache invalid.
      cacheSet(token, { valid: false, reason: r.reason });
      return { ok: false, status: 401, reason: r.reason };
    }
    if (r.kind === 'transport') sawTransportFailure = true;
    lastReason = r.reason;
  } else if (lastReason === 'no verifier accepted this token') {
    // Identity wasn't tried (unset) and relay fallback isn't
    // configured — surface that to the caller.
    lastReason = RELAY_VERIFY_URL
      ? 'relay introspection secret not configured on gate'
      : 'identity rejected token and relay fallback disabled';
  }

  // No source said valid. If we ONLY hit transport failures (no
  // authoritative invalid), don't cache — the next request might
  // succeed once the verifier is back.
  if (!sawTransportFailure) {
    cacheSet(token, { valid: false, reason: lastReason });
  }
  return { ok: false, status: 401, reason: lastReason };
}

/**
 * Extract the first path segment of a URL path. Returns null if the
 * path has no first segment (e.g. "/" or "").
 *
 * We compare against the verified userId to enforce that a user
 * bearer can only write to `<pod>/<userId>/...`. Trailing-slash and
 * percent-encoding edge cases handled here once.
 */
// ── Upstream undici Pool (keyed by origin) ─────────────────────────
//
// One Pool per upstream origin. The gate only ever talks to ONE upstream
// (CSS_INTERNAL_URL), but keying by origin keeps the structure tidy in
// case a future split routes some paths to a different backend.
//
// allowH2 defaults to FALSE so the pool speaks HTTP/1.1 only and the
// underlying TLS socket ALPN-advertises http/1.1 only. Rationale: against
// Container Apps' internal envoy, ALPN-negotiated h2 produced sustained
// ECONNRESET storms on this pool, while the relay (Node fetch, h1 only)
// kept working against the same envoy. Forcing h1 matches the relay's
// working path. Flip UPSTREAM_ALLOW_H2=1 once envoy h2 is verified.
//
// keepAliveTimeout * keepAliveMaxTimeout — keep idle connections warm
// long enough that a chatty client (Foxxi bridge writing one descriptor
// per affordance call) doesn't pay TLS cost per request.
const upstreamPools = new Map();

export function _getUpstreamPool(originUrl) {
  // Normalize to "<protocol>//<host>" (no trailing slash). undici Pool
  // wants the origin only; the path is supplied per-request.
  const u = new URL(originUrl);
  const origin = `${u.protocol}//${u.host}`;
  let pool = upstreamPools.get(origin);
  if (!pool) {
    pool = new Pool(origin, {
      connections: UPSTREAM_POOL_CONNECTIONS,
      allowH2: UPSTREAM_ALLOW_H2,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
      // Generous header timeout — CSS occasionally takes a beat under
      // load (LDP container updates, ACL re-eval), and we'd rather wait
      // than blip a 502.
      headersTimeout: 60_000,
      bodyTimeout: 120_000,
    });
    upstreamPools.set(origin, pool);
  }
  return pool;
}

// Test hook: let unit tests inject a Pool/MockPool keyed by origin so
// they can drive responses without opening real sockets.
export function _setUpstreamPool(originUrl, pool) {
  const u = new URL(originUrl);
  const origin = `${u.protocol}//${u.host}`;
  upstreamPools.set(origin, pool);
}

// Headers that must never be forwarded upstream (hop-by-hop per RFC 7230
// §6.1, plus length/encoding markers undici sets itself).
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'expect',
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Forwarded-identity headers: a fronting proxy (Railway's edge, Caddy, ACA
// ingress) sets these to the PUBLIC hostname. CSS's default middleware
// (css:config/http/middleware/default.json) reconstructs the request URL from
// X-Forwarded-Host / X-Forwarded-Proto, which OVERRIDES the Host header we set
// below — so CSS would compute a public identifier and reject the request as
// "outside the configured identifier space" (its canonical baseUrl is the
// internal host). Strip them so CSS honours the Host header we forward.
// X-Forwarded-For is preserved (client-IP provenance, harmless to CSS).
const STRIP_FORWARDED_TO_CSS = new Set([
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'forwarded',
]);

function buildUpstreamHeaders(inboundHeaders, hostHeader) {
  const out = {};
  for (const [name, value] of Object.entries(inboundHeaders)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(lower)) continue;
    if (STRIP_FORWARDED_TO_CSS.has(lower)) continue;
    out[lower] = value;
  }
  // undici Pool/Client honors a caller-supplied host header verbatim
  // (unlike fetch, which silently strips it under fetch's forbidden-
  // headers rule). This is the entire reason we are using undici
  // directly rather than fetch().
  out['host'] = hostHeader;
  return out;
}

function buildResponseHeaders(upstreamHeaders, corsHeaders) {
  const out = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower)) continue;
    // Drop any upstream CORS / Vary echo. The gate sets its own canonical,
    // single-value CORS headers below. Without this skip, the upstream's
    // lowercase 'access-control-allow-origin' and the gate's canonical-cased
    // 'Access-Control-Allow-Origin' are DIFFERENT JS keys, so Object.assign
    // does NOT override the upstream one — both survive and the client joins
    // them with a comma (e.g. "<origin-a>,<origin-b>"). A comma-joined ACAO is
    // invalid per the CORS spec, so the browser rejects it ("failed to fetch").
    if (lower.startsWith('access-control-') || lower === 'vary') continue;
    out[lower] = value;
  }
  // ── The internal upstream host must not escape onto the public surface ──
  //
  // CSS builds its LDP control headers from the host IT is reached at, which is the
  // private-network address (e.g. http://css.railway.internal:3456). Those values were
  // being forwarded verbatim, so a public client received
  //   link: <http://css.railway.internal:3456/...>; rel="acl"
  // — a name that resolves nowhere off the private network, over plain http on an
  // https page. Every identifier here is supposed to be dereferenceable; this was the
  // one place the substrate published an address only it could reach.
  //
  // ONLY RESPONSE METADATA IS REWRITTEN, never a body. Descriptor bytes are signed and
  // the internal host inside them is canonical — rewriting those would break the
  // signature and is explicitly not what this does.
  const publicOrigin = PUBLIC_BASE_URL;
  const internalOrigin = CSS_INTERNAL_URL.replace(/\/+$/, '');
  for (const h of ['link', 'location', 'content-location', 'updates-via']) {
    const v = out[h];
    if (typeof v === 'string' && v.includes(internalOrigin)) {
      out[h] = v.split(internalOrigin).join(publicOrigin);
    } else if (Array.isArray(v)) {
      out[h] = v.map(x => (typeof x === 'string' ? x.split(internalOrigin).join(publicOrigin) : x));
    }
  }
  // Layer the gate's canonical CORS over whatever upstream CSS returned —
  // now collision-free because the upstream CORS/Vary echo was skipped above.
  Object.assign(out, corsHeaders);
  return out;
}

const NATIVE_COMMIT_TYPE = 'application/vnd.interego.native-commit+json';
const NATIVE_REVISION = /^sha256:[a-f0-9]{64}$/;
const NATIVE_NODE = /^urn:pgsl:(?:atom|fragment):[a-f0-9]{40}$/;

/** Native validators and digests describe exact bytes, even through an edge proxy. */
function preventNativeTransformation(headers) {
  const current = headers['cache-control'];
  const policy = Array.isArray(current) ? current.join(', ') : current ?? '';
  // Split directives without treating a quoted extension value as a directive.
  const directives = policy.match(/(?:[^,"]|"(?:\\.|[^"\\])*")+/g) ?? [];
  if (!directives.some(value => value.trim().toLowerCase() === 'no-transform')) {
    headers['cache-control'] = policy ? `${policy}, no-transform` : 'no-transform';
  }
}

function isNativeCommitType(value) {
  return typeof value === 'string' && value.split(';', 1)[0].trim().toLowerCase() === NATIVE_COMMIT_TYPE;
}

/** Only the private engine's own bounded protocol receipt may cross the URL boundary. */
async function mappedNativeReceipt(upstream, target, hostHeader, requestHeaders) {
  if (String(upstream.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json'
    || (upstream.headers['content-encoding'] && upstream.headers['content-encoding'] !== 'identity')) {
    throw new Error('invalid native receipt representation');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of upstream.body) {
    size += chunk.length;
    if (size > 32_768) throw new Error('native receipt exceeds its bound');
    chunks.push(Buffer.from(chunk));
  }
  const receipt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const storage = new URL(target.href);
  storage.host = hostHeader;
  // CSS's OriginalUrlExtractor deliberately excludes the query string.
  storage.search = '';
  const publicResource = new URL(storage.pathname, PUBLIC_BASE_URL).href;
  const etagRevision = /^"(sha256:[a-f0-9]{64})(?:-[a-f0-9]{16})?"$/.exec(String(upstream.headers.etag ?? ''))?.[1];
  const expected = /^"(sha256:[a-f0-9]{64})(?:-[a-f0-9]{16})?"$/.exec(String(requestHeaders['if-match'] ?? ''))?.[1];
  const conditional = requestHeaders['if-none-match'] === '*'
    ? !requestHeaders['if-match'] && receipt?.expectedRevision === null
    : !requestHeaders['if-none-match'] && expected && receipt?.expectedRevision === expected;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.version !== 1 || receipt.status !== 'committed'
    || receipt.resource !== storage.href || receipt.path !== storage.href || receipt.storageResource !== undefined || receipt.storagePath !== undefined
    || typeof receipt.pod !== 'string' || !receipt.pod || receipt.pod.length > 4096
    || !NATIVE_REVISION.test(receipt.revision) || etagRevision !== receipt.revision
    || !(receipt.expectedRevision === null || NATIVE_REVISION.test(receipt.expectedRevision))
    || !conditional || receipt.revision === receipt.expectedRevision || !NATIVE_REVISION.test(receipt.bodyDigest)
    || typeof receipt.contentType !== 'string' || !receipt.contentType || receipt.contentType.length > 255 || /[\r\n]/.test(receipt.contentType)
    || !Number.isSafeInteger(receipt.size) || receipt.size < 0 || receipt.size > 8 * 1024 * 1024
    || !Number.isSafeInteger(receipt.updatedAt) || receipt.updatedAt < 0
    || !NATIVE_NODE.test(receipt.topUri) || !NATIVE_NODE.test(receipt.opaqueUri)) {
    throw new Error('native receipt target or commit metadata mismatch');
  }
  return Buffer.from(JSON.stringify({ ...receipt, resource: publicResource, path: publicResource,
    storageResource: receipt.resource, storagePath: receipt.path }));
}

/** A private native-CAS ledger bounds all immutable checkpoint history, including retries and restarts. */
function provisionalBudgetStorage() {
  const pool = _getUpstreamPool(CSS_INTERNAL_URL);
  const host = CSS_HOST_HEADER ?? new URL(CSS_INTERNAL_URL).host;
  const readBounded = async (response, maximum) => {
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maximum) throw new Error('budget representation exceeds its bound');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };
  return {
    async read(path) {
      const response = await pool.request({ method: 'GET', path,
        headers: { host, accept: 'application/json' }, signal: AbortSignal.timeout(10_000), maxRedirections: 0 });
      if (response.statusCode === 404) { await response.body.dump(); return null; }
      if (response.statusCode !== 200) { await response.body.dump(); throw new Error('budget read unavailable'); }
      const body = await readBounded(response, 16_384);
      const revision = response.headers['interego-revision'];
      const digest = 'sha256:' + createHash('sha256').update(body).digest('hex');
      if (!NATIVE_REVISION.test(revision) || response.headers['interego-body-digest'] !== digest) throw new Error('budget read has no exact native revision');
      return { revision, value: JSON.parse(body.toString('utf8')) };
    },
    async compareAndSet(path, expectedRevision, value) {
      const body = Buffer.from(JSON.stringify(value));
      const command = Buffer.from(JSON.stringify({ version: 1, expectedRevision, contentType: 'application/json', bodyBase64: body.toString('base64') }));
      const headers = { host, 'content-type': NATIVE_COMMIT_TYPE, accept: 'application/json', 'content-length': String(command.length),
        ...(expectedRevision === null ? { 'if-none-match': '*' } : { 'if-match': `"${expectedRevision}"` }) };
      const response = await pool.request({ method: 'PUT', path, headers, body: command,
        signal: AbortSignal.timeout(10_000), maxRedirections: 0 });
      if (response.statusCode === 409 || response.statusCode === 412) { await response.body.dump(); return false; }
      if (response.statusCode < 200 || response.statusCode >= 300) { await response.body.dump(); throw new Error('budget reservation unavailable'); }
      const receipt = JSON.parse((await mappedNativeReceipt(response, new URL(path, CSS_INTERNAL_URL), host, headers)).toString('utf8'));
      if (receipt.bodyDigest !== 'sha256:' + createHash('sha256').update(body).digest('hex') || receipt.size !== body.length) throw new Error('budget reservation receipt mismatch');
      return true;
    },
  };
}

function provisionalRemainingHeaders(res, remaining) {
  if (!remaining) return;
  res.setHeader('Interego-Provisional-Bytes-Remaining', String(remaining.bytesRemaining));
  res.setHeader('Interego-Provisional-Writes-Remaining', String(remaining.writesRemaining));
  res.setHeader('Interego-Provisional-Expires-At', String(remaining.expiresAt));
}

/**
 * The URL this gate forwards a request to. Built once per request, and every decision about the
 * request's path is made on IT, never on the raw request-target.
 *
 * ── ★★ THE RAW PATH IS NOT THE PATH CSS RECEIVES ────────────────────────────
 *
 * WHATWG URL parsing removes `.` and `..` segments, percent-encoded ones (`%2e%2e`) included,
 * and reads `\` as `/`. The write gate used to take the pod from the raw request-target and
 * forward this parsed URL, so `PUT /alice/../bob/x` with alice's bearer passed as a write to
 * `alice` and reached CSS as `PUT /bob/x`: any signed-in user could write into any other pod —
 * including the identity server's `auth-methods.jsonld` there. Deciding on the forwarded URL
 * closes that whatever spelling a client uses.
 */
function forwardedUrl(reqUrl) {
  return new URL(`${CSS_INTERNAL_URL.replace(/\/+$/, '')}${reqUrl}`);
}

/**
 * The forwarded path relative to CSS's root, percent-decoded: the segments CSS resolves.
 * `encodedSeparator` is true when a segment decodes to something holding `/` or `\` (sent as
 * `%2F` / `%5C`): a server that decodes those before resolving a path would read segments the
 * parsed URL does not show, so the gate refuses to authorize such a path rather than guess.
 */
function podPath(upstreamUrl) {
  const base = new URL(CSS_INTERNAL_URL).pathname.replace(/\/+$/, '');
  const path = base && upstreamUrl.pathname.startsWith(`${base}/`)
    ? upstreamUrl.pathname.slice(base.length) : upstreamUrl.pathname;
  const segments = path.split('/').slice(1).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  return {
    pod: segments[0] || null,
    segments,
    // The path as the most lenient server could read it: decoded separators split, empty
    // segments dropped. Used only to recognise a private document, so leniency denies more.
    parts: segments.join('/').split(/[\\/]+/).filter(Boolean),
    encodedSeparator: segments.some((s) => s.includes('/') || s.includes('\\')),
  };
}

/**
 * The pod whose private document (PRIVATE_POD_DOCUMENTS) this path names, however the name is
 * cased or its separators spelled; null when it names none.
 */
function privateDocumentPod({ parts }) {
  return parts.length === 2 && isPrivateDocumentName(parts[1]) ? parts[0] : null;
}

/**
 * The pod whose private document a POST would create by naming it in its `Slug` header: CSS takes
 * the Slug as the new resource's name when it is free. Read as leniently as the path is, so any
 * segment of the Slug that names one counts.
 */
function slugPrivateDocumentPod({ parts }, method, slug) {
  if (method !== 'POST' || parts.length !== 1 || typeof slug !== 'string' || !slug) return null;
  let decoded = slug;
  try { decoded = decodeURIComponent(slug); } catch { /* keep it as sent */ }
  return decoded.split(/[\\/]+/).some((s) => s && isPrivateDocumentName(s.trim())) ? parts[0] : null;
}

/**
 * WHO IS CALLING, counted per minute per caller.
 *
 * ── ★★ THIS GATE LOGGED NOTHING FOR A READ, AND IT COST A NIGHT ─────────────
 *
 * The gate went unresponsive twice with 700+ requests queued behind its upstream pool, and there
 * was NO WAY TO SEE WHO WAS SENDING THEM. Reads pass through anonymously by design, so a caller
 * could saturate the pool without leaving a single line. Two hypotheses died for lack of this data
 * — a connection leak (real, fixed, and not the cause) and pool sizing (raising 16→96 changed
 * nothing) — while the actual source stayed invisible.
 *
 * ★ AGGREGATED, NOT PER-REQUEST. A line per read would be its own denial of service at 45 req/s
 * and would bury the signal. One summary a minute names the top callers and paths, which is what
 * "who is sweeping the pod directory" actually needs.
 *
 * ★ AND IT RECORDS THE FORWARDED CLIENT ADDRESS. Behind Railway's proxy `socket.remoteAddress` is
 * the proxy, so `x-forwarded-for` is the only thing that distinguishes one caller from another.
 */
const callers = new Map();
const paths = new Map();
let windowStart = Date.now();

function noteCaller(req) {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  const who = (fwd || req.socket?.remoteAddress || 'unknown')
    + ' · ' + String(req.headers['user-agent'] ?? 'no-ua').slice(0, 60);
  callers.set(who, (callers.get(who) ?? 0) + 1);
  // The pod segment only — the rest of a path is noise for "which pods is it walking".
  const seg = String(req.url ?? '/').split('/').filter(Boolean)[0] ?? '/';
  const kind = String(req.url ?? '').includes('/agents') ? 'agents'
    : String(req.url ?? '').includes('.well-known') ? 'well-known' : 'other';
  paths.set(kind, (paths.get(kind) ?? 0) + 1);
  void seg;

  const elapsed = Date.now() - windowStart;
  if (elapsed < 60_000) return;
  const total = [...callers.values()].reduce((a, b) => a + b, 0);
  const top = [...callers].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`[css-gate][callers] ${total} request(s) in ${Math.round(elapsed / 1000)}s `
    + `(${Math.round(total / (elapsed / 1000))}/s) · by kind ${JSON.stringify(Object.fromEntries(paths))}`);
  for (const [who, n] of top) console.log(`[css-gate][callers]   ${String(n).padStart(6)}  ${who}`);
  callers.clear();
  paths.clear();
  windowStart = Date.now();
}

const server = createServer(async (req, res) => {
  let releaseProvisionalWrite;
  try {
  const method = (req.method ?? 'GET').toUpperCase();
  try { noteCaller(req); } catch { /* accounting must never fail a request */ }

  // ★ HSTS on every response, set once here rather than added to each writeHead.
  //
  // res.writeHead(status, obj) MERGES with anything already set via setHeader, so a single
  // call up here covers every exit path — preflight, health, 401, and the proxied body —
  // without having to remember it at each of them. That "remember it everywhere" pattern is
  // exactly how this header came to be missing while identity had it.
  //
  // max-age only, deliberately: includeSubDomains would bind every *.interego.xwisee.com
  // including any not fully on HTTPS, and preload is near-irreversible. Separate decision.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  // CORS headers attached to every response (including errors + preflight).
  // Computed once per request from the Origin header so an off-list
  // browser caller cannot read the response body.
  const corsHeaders = corsHeadersFor(req.headers['origin']);

  // CORS preflight: short-circuit. We don't proxy OPTIONS upstream — CSS
  // doesn't need to see it, and answering here lets a browser do its
  // pre-write probe even when WRITE_SECRET is unknown to the client.
  if (method === 'OPTIONS' && req.headers['access-control-request-method']) {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // Health: anyone can hit /healthz on the gate itself (does NOT proxy).
  if (req.url === '/healthz') {
    /**
     * ── ★★ AND IT REPORTS THE POOL, BECAUSE 200 HERE MEANT NOTHING ──────────────
     *
     * This endpoint answered 200 throughout two separate incidents in which the gate accepted TLS
     * and never replied to a single proxied request. It does not touch the upstream, so it cannot
     * be wrong — and it cannot be useful either. "SUCCESS in Railway, healthy on /healthz, dead
     * for everything that matters" is how this went unnoticed until an agent was blamed for it.
     *
     * The pool's own counters are the fact that distinguishes the two states. `queued` climbing
     * with `running` pinned at the pool size IS the wedge, and it is visible from outside without
     * proxying anything.
     */
    const stats = (() => {
      try {
        const p = upstreamPools.get(new URL(CSS_INTERNAL_URL).origin);
        const s = p?.stats;
        return s ? { size: s.size, connected: s.connected, pending: s.pending, running: s.running, queued: s.queued } : null;
      } catch { return null; }
    })();
    // Saturated AND backing up. Either alone is ordinary under load; together, for any length of
    // time, is the shape of a leak.
    const saturated = Boolean(stats && stats.running >= UPSTREAM_POOL_CONNECTIONS && stats.queued > 0);
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({
      ok: true,
      upstreamPool: stats,
      saturated,
      ...(saturated
        ? { warning: 'every upstream connection is busy and requests are queuing — proxied requests may be hanging even though this endpoint answers' }
        : {}),
      gating: 'writes, and reads of each pod\'s private documents',
      privateDocuments: [...PRIVATE_POD_DOCUMENTS],
      privateDocumentWriters: 'operator',
      upstream: CSS_INTERNAL_URL,
      perUserBearers: Boolean(IDENTITY_URL) || Boolean(RELAY_VERIFY_URL && RELAY_INTROSPECTION_SECRET),
      identityVerify: Boolean(IDENTITY_URL),
      relayIntrospect: Boolean(RELAY_VERIFY_URL && RELAY_INTROSPECTION_SECRET),
      // Whether the identity call carries a bearer, and how identity has answered it since start.
      // Never the value or its length.
      identityVerifyAuth: Boolean(IDENTITY_INTROSPECTION_SECRET),
      identityVerifyResults: { ...identityVerifyResults },
      provisionalPlay: { ...PROVISIONAL_LIMITS, accounting: 'durable-lifetime-before-write',
        budgetDocument: PROVISIONAL_BUDGET_DOCUMENT, conditionalNativeCommit: true },
      // The git sha baked into the image, and the only field here that can distinguish one
      // deployment from another — everything above is derived from env vars that survive a
      // redeploy unchanged. ★ That is not hypothetical for this service: its HSTS fix sat
      // merged and undeployed while this body reported `ok`, and the only way anyone
      // established the image was stale was by noticing that `relayIntrospect` (added
      // 2026-06-05) was present and a 2026-07-31 change was not. tools/railway-redeploy.mjs
      // polls exactly this field; without it --verify-url can never match.
      build: process.env.INTEREGO_BUILD_SHA ?? 'unset',
    }));
    return;
  }

  // The URL this request is forwarded to. Every decision below is made on it (see forwardedUrl).
  let upstreamUrl;
  try {
    upstreamUrl = forwardedUrl(req.url ?? '/');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ error: 'bad request-target', detail: 'the request-target is not a path this gate can forward' }));
    return;
  }
  const target = podPath(upstreamUrl);
  let provisionalBody;
  const isWrite = WRITE_METHODS.has(method);
  // A read of a pod's private document is authorized as a write to that pod is.
  const privatePod = isWrite ? null : privateDocumentPod(target);
  // A write that would change or create a pod's private document: the operator's alone.
  const privateWrite = isWrite
    ? (privateDocumentPod(target) ?? slugPrivateDocumentPod(target, method, req.headers['slug']))
    : null;

  // Write-method gate, and the owner-only read of a private pod document.
  if (isWrite || privatePod) {
    const act = isWrite ? 'write' : 'read';
    const pod = isWrite ? target.pod : privatePod;
    const auth = req.headers['authorization'] ?? '';
    if (!auth.startsWith('Bearer ')) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="interego-css-gate"',
        ...corsHeaders,
      });
      res.end(JSON.stringify(isWrite
        ? {
          error: 'anonymous writes denied',
          detail: `${method} requires Authorization: Bearer <token>; reads (GET/HEAD/OPTIONS) remain anonymous, except each pod's sign-in record.`,
        }
        : {
          error: 'anonymous read denied',
          detail: `${upstreamUrl.pathname} is the identity server's sign-in record for this pod; it is readable with its owner's bearer, and a user sees their own through the identity server's GET /auth-methods/me.`,
        }));
      return;
    }
    const token = auth.slice(7);

    // Path 1: operator bearer (legacy / trusted infra). Allows writes
    // to any path. We accept the WHOLE "Bearer <secret>" header here
    // via safeEqual so wrong-length attempts cost the same time.
    const isOperator = safeEqual(auth, `Bearer ${WRITE_SECRET}`);
    if (!isOperator) {
      // Path 2: per-user bearer. Verify via identity, then enforce
      // that the forwarded path is rooted at the verified userId.
      const verified = await verifyUserBearer(token);
      if (!verified.ok) {
        res.writeHead(verified.status ?? 401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="interego-css-gate"',
          ...corsHeaders,
        });
        res.end(JSON.stringify({
          error: 'invalid bearer',
          detail: verified.reason ?? 'token failed identity-server verification',
        }));
        return;
      }
      const userId = verified.userId;
      if (privateWrite) {
        // The identity server writes this record over the private network; no user bearer does.
        res.writeHead(403, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          error: 'sign-in record is not writable with a user bearer',
          detail: `this ${method} would change pod "${privateWrite}"'s sign-in record (${[...PRIVATE_POD_DOCUMENTS].join(', ')}), which only the identity server writes; credentials are changed through the identity server's endpoints`,
        }));
        return;
      }
      if (isWrite && target.encodedSeparator) {
        // A `%2F` or `%5C` inside a segment: which pod CSS writes to would depend on whether it
        // decodes them first. No Interego client names a resource that way.
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          error: 'encoded path separator',
          detail: 'a user bearer cannot write to a path with an encoded "/" or "\\" (%2F, %5C) in a segment',
        }));
        return;
      }
      if (pod !== userId) {
        // Cross-pod attempt. The verified user owns `/<userId>/...` only.
        res.writeHead(403, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          error: `cross-pod ${act} denied`,
          detail: isWrite
            ? `bearer is scoped to userId="${userId}" but the request is forwarded to pod "${pod ?? '(root)'}"; user bearers can only write to /<userId>/...`
            : `bearer is scoped to userId="${userId}" but ${upstreamUrl.pathname} is pod "${pod}"'s sign-in record; only its owner reads it`,
        }));
        return;
      }
      if (isWrite && verified.provisionalPlay) {
        try {
          const expectedRevision = checkProvisionalTarget(verified.provisionalPlay, method, upstreamUrl, req.headers);
          releaseProvisionalWrite = acquireProvisionalWrite(verified.userId);
          const uploadDeadline = setTimeout(() => req.destroy(new Error('temporary checkpoint upload timed out')), 15_000);
          uploadDeadline.unref();
          let commit;
          try { commit = await readProvisionalCommit(req, expectedRevision, PROVISIONAL_LIMITS); }
          finally { clearTimeout(uploadDeadline); }
          const remaining = await reserveProvisionalWrite(verified.provisionalPlay, commit.bytes, PROVISIONAL_LIMITS, provisionalBudgetStorage());
          provisionalRemainingHeaders(res, remaining);
          provisionalBody = commit.body;
        } catch (error) {
          provisionalRemainingHeaders(res, error.remaining);
          if (error.status === 429) res.setHeader('Retry-After', '2');
          if (error.code === 'provisional_play_storage_limit') res.setHeader('Interego-Play-Budget-Exhausted', '1');
          res.writeHead(error.status ?? 503, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ error: error.code ?? 'provisional_play_budget_unavailable',
            detail: error.status ? error.message : 'Temporary character storage could not be verified. Your previous checkpoint is preserved; retry saving.',
            ...(error.remaining ? { remaining: error.remaining } : {}) }));
          return;
        }
      }
      // Authorized per-user request. Fall through to strip + proxy.
    }

    // Strip the bearer before forwarding so CSS doesn't try to parse it
    // as a DPoP/OIDC token. CSS is allow-all behind the gate; auth is
    // the gate's job, not CSS's.
    delete req.headers['authorization'];
  }

  // Public ciphertext reads may carry the gate's opaque write capability.
  // Strip only one we verified; unrelated Solid-OIDC/DPoP credentials retain
  // their original CSS authentication path. Private documents were gated above.
  if (!isWrite && !privatePod && (method === 'GET' || method === 'HEAD')) {
    const auth = req.headers['authorization'] ?? '';
    if (auth.startsWith('Bearer ')) {
      if (safeEqual(auth, `Bearer ${WRITE_SECRET}`)) delete req.headers['authorization'];
      else {
        const verified = await verifyUserBearer(auth.slice(7));
        if (verified.ok) {
          if (target.encodedSeparator || target.pod !== verified.userId) {
            res.writeHead(target.encodedSeparator ? 400 : 403, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: target.encodedSeparator ? 'encoded path separator' : 'cross-pod read denied' }));
            return;
          }
          delete req.headers['authorization'];
        }
      }
    }
  }

  // Proxy through via undici Pool. The gate has historically used
  // raw http(s).request because the Host header MUST be overridden
  // when forwarding to CSS (CSS computes request identifiers from
  // the request host + path and rejects with "outside the configured
  // identifier space" when the host doesn't match its baseUrl); Node's
  // fetch() silently strips any caller-supplied `host` header under
  // fetch's forbidden-headers rule. undici's low-level Pool.request
  // honors `headers.host` verbatim, so we get the Host-override
  // freedom of raw http.request AND ALPN-negotiated h2 multiplexing
  // (which eliminates the ECONNRESET storms the raw path produced
  // against Container Apps' envoy under sustained load) AND pooled
  // keep-alive. `upstreamUrl` is the forwarded URL the checks above decided on.
  const hostHeader = CSS_HOST_HEADER ?? upstreamUrl.host;
  const headers = buildUpstreamHeaders(req.headers, hostHeader);

  // Body forwarding strategy:
  //   - GET / HEAD: no body.
  //   - Everything else: stream the inbound IncomingMessage straight
  //     to undici. h2 streams handle backpressure natively, so a large
  //     PUT does not need to buffer into memory.
  //   - UPSTREAM_REQUEST_BUFFER=1 escape hatch: buffer first (legacy
  //     path; kept for if a future ingress layer regresses).
  let upstreamBody;
  if (method !== 'GET' && method !== 'HEAD') {
    if (provisionalBody) {
      upstreamBody = provisionalBody;
      headers['content-length'] = String(provisionalBody.length);
      delete headers['transfer-encoding'];
    } else if (UPSTREAM_REQUEST_BUFFER) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      upstreamBody = buf;
      headers['content-length'] = String(buf.length);
    } else {
      // Stream — pass the inbound request through. Preserve the inbound
      // Content-Length if the caller supplied it (avoids forcing chunked
      // transfer-encoding for a known-size body); if the caller used
      // chunked, undici will keep it chunked.
      upstreamBody = req;
      const inboundLen = req.headers['content-length'];
      if (inboundLen !== undefined) headers['content-length'] = String(inboundLen);
    }
  }

  const pool = _getUpstreamPool(CSS_INTERNAL_URL);
  let upstreamRes;
  try {
    upstreamRes = await pool.request({
      method,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      headers,
      body: upstreamBody,
      // We bubble status + body through 1:1; do not let undici redirect
      // for us (CSS uses redirects for LDP container semantics, and the
      // caller needs to see those). undici Pool.request never throws on
      // upstream 4xx/5xx — the response object simply carries that
      // statusCode — so we forward those bodies through naturally.
      maxRedirections: 0,
      /**
       * ★★ A BOUND ON WAITING FOR A POOL SLOT, NOT ONLY ON THE UPSTREAM.
       *
       * `headersTimeout` and `bodyTimeout` govern a request that HAS a connection. Neither
       * applies while one is queued waiting for a free slot, and the queue is unbounded — so a
       * saturated pool does not degrade, it silently stops answering. That is how a leak of
       * sixteen connections turned into a gate that accepted TLS and never replied.
       *
       * With a deadline the same failure becomes a fast, loud 502 that names the cause, and the
       * watchdog and the logs both see it. Defence in depth: the leak above is the fix, this is
       * what keeps the NEXT one from being invisible.
       */
      signal: AbortSignal.timeout(Number(process.env.UPSTREAM_QUEUE_TIMEOUT_MS ?? 90_000)),
    });
  } catch (err) {
    // ★ AN ABORT HERE IS OUR OWN DEADLINE, NOT CSS REFUSING — and saying "upstream CSS
    // unreachable" for it sends the next person to the wrong service, which is precisely the
    // mistake this gate's own failure caused three times over tonight.
    const ourDeadline = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    console.error('[css-gate] upstream request failed:', err.message, ourDeadline ? '(our deadline)' : '');
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(ourDeadline
        ? {
          error: 'gate gave up waiting for a connection to CSS',
          detail: 'This gate\'s own deadline, not a refusal by CSS — its pool may be saturated. '
            + 'Check for leaked upstream connections before blaming CSS.',
        }
        : { error: 'upstream CSS unreachable', detail: err.message }));
    } else {
      res.end();
    }
    return;
  }

  // Native commit receipts are protocol acknowledgements, not stored application
  // bytes. Translate only a validated receipt for this exact forwarded PUT;
  // retain the engine identifier so its native revision remains attributable.
  if (method === 'PUT' && isNativeCommitType(req.headers['content-type'])
    && upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300) {
    try {
      const body = await mappedNativeReceipt(upstreamRes, upstreamUrl, hostHeader, req.headers);
      const receiptHeaders = buildResponseHeaders(upstreamRes.headers, corsHeaders);
      preventNativeTransformation(receiptHeaders);
      delete receiptHeaders['content-encoding'];
      receiptHeaders['content-length'] = String(body.length);
      res.writeHead(upstreamRes.statusCode, receiptHeaders);
      res.end(body);
    } catch {
      upstreamRes.body?.destroy?.();
      res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: 'native commit receipt did not bind the forwarded resource' }));
    }
    return;
  }

  const responseHeaders = buildResponseHeaders(upstreamRes.headers, corsHeaders);
  if (method === 'GET' && upstreamRes.statusCode === 200
    && typeof responseHeaders['interego-revision'] === 'string' && NATIVE_REVISION.test(responseHeaders['interego-revision'])
    && typeof responseHeaders['interego-body-digest'] === 'string' && NATIVE_REVISION.test(responseHeaders['interego-body-digest'])) {
    preventNativeTransformation(responseHeaders);
  }
  res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);

  // Stream the response body back. upstreamRes.body is a Node Readable.
  if (upstreamRes.body && typeof upstreamRes.body.pipe === 'function') {
    upstreamRes.body.on('error', (err) => {
      console.error('[css-gate] upstream response stream error:', err.message);
      if (!res.writableEnded) res.end();
    });
    /**
     * ── ★★ THE LEAK THAT WEDGED THIS GATE TWICE IN ONE NIGHT ────────────────────
     *
     * An undici Pool connection is returned only when its response body is CONSUMED. If the
     * client goes away mid-stream, `pipe` stops and nothing drains the rest — so that connection
     * is never released. The pool is `connections: 16` with no queue deadline, so the seventeenth
     * request after sixteen such leaks does not fail: it QUEUES, forever. The gate then accepts
     * TCP, completes TLS, and never answers.
     *
     * MEASURED: exactly that, twice in three hours, while CSS behind it was healthy and serving
     * requests throughout — which is what made it look like a Foxxi fault, then a relay fault,
     * then an agent's fault. A restart cleared it every time and it came back.
     *
     * Destroying the body on client close hands the connection back immediately. A client
     * disconnecting is ordinary — a page closed, a poll cancelled, an agent timing out — and it
     * must cost this process nothing.
     */
    const release = () => {
      if (!upstreamRes.body.destroyed) upstreamRes.body.destroy();
    };
    res.on('close', () => {
      // `writableEnded` false at close means the client left before we finished writing.
      if (!res.writableEnded) release();
    });
    upstreamRes.body.pipe(res);
  } else {
    res.end();
  }
  } finally {
    if (releaseProvisionalWrite) {
      if (res.writableFinished || res.destroyed) releaseProvisionalWrite();
      else { res.once('finish', releaseProvisionalWrite); res.once('close', releaseProvisionalWrite); }
    }
  }
});

// Export the bare http.Server so unit tests can drive it via
// server.listen(0, ...) on an ephemeral port (and stay quiet when
// imported — listen() is gated on CSS_GATE_AUTOSTART below).
export { server };

if (process.env.CSS_GATE_AUTOSTART !== '0') server.listen(PORT, () => {
  console.log(`[css-gate] listening on :${PORT}`);
  console.log(`[css-gate] upstream: ${CSS_INTERNAL_URL}`);
  console.log(`[css-gate] write methods (POST/PUT/PATCH/DELETE) require Authorization: Bearer <token>`);
  console.log(`[css-gate]   • Bearer <WRITE_SECRET>             → operator path, any pod path`);
  if (IDENTITY_URL || (RELAY_VERIFY_URL && RELAY_INTROSPECTION_SECRET)) {
    console.log(`[css-gate]   • Bearer <per-user token>          → per-user path, must target /<userId>/...`);
    if (IDENTITY_URL) {
      // Says whether a bearer is presented, and warns (value-free) when it cannot be sent intact:
      // fetch drops a trailing space or tab, and throws on a control character other than TAB or
      // a character above U+00FF. Leading or interior spaces and tabs, and other Latin-1
      // characters, arrive intact. Identity's startup log uses the same rule and wording.
      const bearerNote = !IDENTITY_INTROSPECTION_SECRET ? 'no bearer: accepted only while identity runs open'
        : !/[\t ]$|[\x00-\x08\x0a-\x1f\x7f]|[^\x00-\xff]/.test(IDENTITY_INTROSPECTION_SECRET) ? 'with introspection bearer'
          : 'WARN: IDENTITY_INTROSPECTION_SECRET ends in a space or tab, or holds a control character other than TAB or a character above U+00FF; such a value cannot be sent intact in a header, so every identity verify fails while identity holds the same value. Use 32 random bytes as hex';
      console.log(`[css-gate]   identity verify : ${IDENTITY_URL}/tokens/verify  (primary, ${bearerNote})`);
    }
    if (RELAY_VERIFY_URL && RELAY_INTROSPECTION_SECRET) {
      console.log(`[css-gate]   relay introspect: ${RELAY_VERIFY_URL}/verify-token  (fallback for OAuth tokens)`);
    }
    console.log(`[css-gate]   per-user-bearer cache TTL ${USER_BEARER_CACHE_TTL_MS} ms`);
  } else {
    console.log(`[css-gate]   • per-user bearers DISABLED (neither IDENTITY_URL nor RELAY_VERIFY_URL+SECRET set)`);
  }
  console.log(`[css-gate] read methods (GET/HEAD/OPTIONS) pass through anonymously, except /<pod>/{${[...PRIVATE_POD_DOCUMENTS].join(',')}} (owner or operator bearer); writes to those are the operator's alone`);
});

