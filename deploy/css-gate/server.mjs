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
 *                            descriptor dereferencing all still work)
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
 *                      (required for per-user bearer path; if unset,
 *                      ONLY the operator bearer works and per-user
 *                      writes 401).
 *   CSS_INTERNAL_URL — upstream CSS.
 *   CSS_HOST_HEADER  — Host header to forward to CSS.
 *   USER_BEARER_CACHE_TTL_MS — verified-token cache TTL (default 60000).
 *
 * No deps — uses Node 20+ built-in fetch.
 */

import { createServer } from 'http';
import { Readable } from 'stream';

const PORT = Number(process.env.PORT ?? 8080);
const CSS_INTERNAL_URL = process.env.CSS_INTERNAL_URL
  ?? 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
// Public origin of THIS gate. Returned as ACAO when the request Origin
// is off-list — browsers refuse to read it because no off-list caller
// has that origin.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL
  ?? 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io').replace(/\/+$/, '');
// CSS validates that incoming requests' Host header matches its
// configured CSS_BASE_URL ("outside the configured identifier space"
// errors otherwise). When the gate connects to CSS at an internal
// hostname (after CSS is moved behind the gate), the Host header must
// stay the public hostname so CSS accepts. Defaults to the host of
// CSS_INTERNAL_URL when not set.
const CSS_HOST_HEADER = process.env.CSS_HOST_HEADER ?? null;
const WRITE_SECRET = process.env.WRITE_SECRET;
const IDENTITY_URL = (process.env.IDENTITY_URL ?? '').replace(/\/+$/, '');
const USER_BEARER_CACHE_TTL_MS = Number(process.env.USER_BEARER_CACHE_TTL_MS ?? 60_000);

if (!WRITE_SECRET) {
  console.error('[css-gate] WRITE_SECRET env var is required');
  process.exit(1);
}

if (!IDENTITY_URL) {
  console.warn(
    '[css-gate] IDENTITY_URL is not set — per-user bearer writes will be rejected. ' +
    'Only the operator WRITE_SECRET bearer will be accepted.',
  );
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
  'https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io',
  'https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io',
  'https://interego-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io',
  'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io',
  'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io',
  'https://interego-pgsl-browser.livelysky-8b81abb0.eastus.azurecontainerapps.io',
  'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io',
  'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io',
  'https://interego-foxxi-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io',
  'https://interego-foxxi-microsite.livelysky-8b81abb0.eastus.azurecontainerapps.io',
  'https://interego-foxxi-scorm-player.livelysky-8b81abb0.eastus.azurecontainerapps.io',
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
  ?? 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io';

export function corsHeadersFor(originHeader) {
  const norm = normalizeOrigin(originHeader);
  // Origin: null (sandboxed iframes / file://) is NEVER allowed even if
  // someone foolishly adds 'null' to the env allowlist — that combination
  // is the classic credentialed cross-origin attack vector.
  const allowed = Boolean(originHeader)
    && originHeader !== 'null'
    && norm
    && CORS_ALLOWLIST.has(norm);
  return {
    'Access-Control-Allow-Origin': allowed ? norm : GATE_OWN_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization',
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
 * Verify a per-user bearer against identity-server /tokens/verify.
 *
 * Returns { ok: true, userId, agentId?, scope? } on a valid token,
 * or { ok: false, status, reason } on invalid / unreachable.
 *
 * - status: HTTP status the gate should return upstream (401 for
 *   invalid token / unreachable identity, 503 for identity hard-down
 *   when we can distinguish — currently treated as 401 to keep the
 *   surface minimal; callers retry).
 */
async function verifyUserBearer(token) {
  if (!IDENTITY_URL) {
    return { ok: false, status: 401, reason: 'per-user bearers not supported (IDENTITY_URL unset)' };
  }
  const cached = cacheGet(token);
  if (cached) {
    if (cached.valid) return { ok: true, userId: cached.userId, agentId: cached.agentId, scope: cached.scope };
    return { ok: false, status: 401, reason: cached.reason ?? 'invalid token' };
  }
  let resp;
  try {
    resp = await fetch(`${IDENTITY_URL}/tokens/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    // Identity unreachable — do NOT cache (transient). 401 to caller.
    return { ok: false, status: 401, reason: `identity unreachable: ${err.message}` };
  }
  if (!resp.ok) {
    // Identity returned non-2xx. Treat as invalid; cache briefly to
    // throttle. Distinguish from network failure so the cache is
    // populated.
    cacheSet(token, { valid: false, reason: `identity ${resp.status}` });
    return { ok: false, status: 401, reason: `identity returned ${resp.status}` };
  }
  let data;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, status: 401, reason: 'identity returned non-JSON' };
  }
  if (!data.valid) {
    cacheSet(token, { valid: false, reason: data.reason ?? 'invalid token' });
    return { ok: false, status: 401, reason: data.reason ?? 'invalid token' };
  }
  if (typeof data.userId !== 'string' || !data.userId) {
    // Defensive: identity reported valid but no userId claim — we
    // can't path-check, so refuse rather than allow an unscoped write.
    cacheSet(token, { valid: false, reason: 'verified token has no userId claim' });
    return { ok: false, status: 401, reason: 'verified token has no userId claim' };
  }
  cacheSet(token, { valid: true, userId: data.userId, agentId: data.agentId, scope: data.scope });
  return { ok: true, userId: data.userId, agentId: data.agentId, scope: data.scope };
}

/**
 * Extract the first path segment of a URL path. Returns null if the
 * path has no first segment (e.g. "/" or "").
 *
 * We compare against the verified userId to enforce that a user
 * bearer can only write to `<pod>/<userId>/...`. Trailing-slash and
 * percent-encoding edge cases handled here once.
 */
function firstPathSegment(reqUrl) {
  // reqUrl is the request-target (path?query). Strip query / fragment.
  const q = reqUrl.indexOf('?');
  const path = q >= 0 ? reqUrl.slice(0, q) : reqUrl;
  if (!path.startsWith('/')) return null;
  const rest = path.slice(1);
  const slash = rest.indexOf('/');
  const seg = slash < 0 ? rest : rest.slice(0, slash);
  if (!seg) return null;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

const server = createServer(async (req, res) => {
  const method = (req.method ?? 'GET').toUpperCase();

  // CORS headers attached to every response (including errors + preflight).
  // Computed once per request from the Origin header so an off-list
  // browser caller cannot read the response body.
  const corsHeaders = corsHeadersFor(req.headers['origin']);

  // CORS preflight: short-circuit. We don't proxy OPTIONS upstream — CSS
  // doesn't need to see it, and answering here lets a browser do its
  // pre-write probe even when WRITE_SECRET is unknown to the client.
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // Health: anyone can hit /healthz on the gate itself (does NOT proxy).
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({
      ok: true,
      gating: 'writes-only',
      upstream: CSS_INTERNAL_URL,
      perUserBearers: Boolean(IDENTITY_URL),
    }));
    return;
  }

  // Write-method gate.
  if (WRITE_METHODS.has(method)) {
    const auth = req.headers['authorization'] ?? '';
    if (!auth.startsWith('Bearer ')) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="interego-css-gate"',
        ...corsHeaders,
      });
      res.end(JSON.stringify({
        error: 'anonymous writes denied',
        detail: `${method} requires Authorization: Bearer <token>; reads (GET/HEAD/OPTIONS) remain anonymous.`,
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
      // that the request path is rooted at the verified userId.
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
      const seg = firstPathSegment(req.url ?? '/');
      if (seg !== userId) {
        // Cross-pod write attempt. The verified user owns
        // `/<userId>/...` only.
        res.writeHead(403, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          error: 'cross-pod write denied',
          detail: `bearer is scoped to userId="${userId}" but request targets path segment "${seg ?? '(root)'}"; user bearers can only write to /<userId>/...`,
        }));
        return;
      }
      // Authorized per-user write. Fall through to strip + proxy.
    }

    // Strip the bearer before forwarding so CSS doesn't try to parse it
    // as a DPoP/OIDC token. CSS is allow-all behind the gate; auth is
    // the gate's job, not CSS's.
    delete req.headers['authorization'];
  }

  // Proxy through.
  const upstreamUrl = `${CSS_INTERNAL_URL.replace(/\/+$/, '')}${req.url}`;
  // Forward headers. Host header gets explicitly rewritten — to
  // CSS_HOST_HEADER if set (the public hostname CSS thinks it lives at,
  // per CSS_BASE_URL), else the host of the internal URL. The former
  // is required when CSS is behind the gate at an internal hostname
  // but still has CSS_BASE_URL set to its original public URL — CSS
  // rejects requests whose Host doesn't match its baseUrl space.
  const headers = { ...req.headers };
  try {
    const u = new URL(CSS_INTERNAL_URL);
    headers['host'] = CSS_HOST_HEADER ?? u.host;
  } catch { /* ignore */ }

  // Build the upstream request body: only methods that can have one.
  //
  // We BUFFER the body instead of streaming via `Readable.toWeb(req)`.
  // Streaming the duplex='half' request through Node fetch to Azure
  // Container Apps' ingress hangs for bodies > a few KB and eventually
  // returns 504 "stream timeout" — the failure mode is consistent for
  // string-body fetches from the client through here. Buffering keeps
  // the request a normal HTTP/1.1 PUT with Content-Length, which Azure
  // proxies cleanly. Trade-off: each request holds its body in memory.
  // The gate fronts CSS for Interego descriptor / manifest writes —
  // bounded to descriptor + manifest sizes, well under any sane limit.
  let upstreamBody;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBody = Buffer.concat(chunks);
    // Set Content-Length explicitly so fetch doesn't fall back to chunked.
    headers['content-length'] = String(upstreamBody.length);
    delete headers['transfer-encoding'];
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method,
      headers,
      body: upstreamBody,
      redirect: 'manual',
    });
  } catch (err) {
    console.error('[css-gate] upstream fetch failed:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ error: 'upstream CSS unreachable', detail: err.message }));
    return;
  }

  // Mirror response back to the client. Layer CORS over whatever
  // upstream CSS returned — CSS does not know about our allowlist, and
  // our headers take precedence (the spread comes after).
  const responseHeaders = {};
  upstreamRes.headers.forEach((v, k) => { responseHeaders[k] = v; });
  Object.assign(responseHeaders, corsHeaders);
  res.writeHead(upstreamRes.status, responseHeaders);
  if (upstreamRes.body) {
    Readable.fromWeb(upstreamRes.body).pipe(res);
  } else {
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[css-gate] listening on :${PORT}`);
  console.log(`[css-gate] upstream: ${CSS_INTERNAL_URL}`);
  console.log(`[css-gate] write methods (POST/PUT/PATCH/DELETE) require Authorization: Bearer <token>`);
  console.log(`[css-gate]   • Bearer <WRITE_SECRET>             → operator path, any pod path`);
  if (IDENTITY_URL) {
    console.log(`[css-gate]   • Bearer <identity-server token>   → per-user path, must target /<userId>/...`);
    console.log(`[css-gate]   identity verify: ${IDENTITY_URL}/tokens/verify  (cache TTL ${USER_BEARER_CACHE_TTL_MS} ms)`);
  } else {
    console.log(`[css-gate]   • per-user bearers DISABLED (IDENTITY_URL not set)`);
  }
  console.log(`[css-gate] read methods (GET/HEAD/OPTIONS) pass through anonymously`);
});
