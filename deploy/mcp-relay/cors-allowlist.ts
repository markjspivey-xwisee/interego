/**
 * Explicit CORS allowlist for Interego deployment services.
 *
 * Replaces the legacy `Access-Control-Allow-Origin: *` posture in
 * `deploy/mcp-relay/server.ts` and `deploy/identity/server.ts` (and is
 * imported by `deploy/css-gate/server.mjs` via the compiled JS output).
 *
 * Why an allowlist instead of wildcard:
 *   The relay's prior comment argued that `*` is safe because OAuth
 *   bearer-token auth is required for every state-changing call. That is
 *   true TODAY — but the wildcard is a fragile posture: any new middleware
 *   that adds `Access-Control-Allow-Credentials: true` (an Express auth
 *   library default, or a cookie session module someone wires up later)
 *   silently turns the relay into a credentialed cross-origin read hole
 *   against arbitrary origins, including `null` (file:// + sandboxed
 *   iframes). The wildcard cannot legally coexist with credentials per the
 *   Fetch spec, but browsers are forgiving and operators rarely catch this
 *   in code review.
 *
 *   This module forces every public endpoint to:
 *     1. Reflect the request Origin only if it appears on a static
 *        allowlist (FQDNs of sibling deployments + localhost dev ports +
 *        well-known browser MCP client hosts).
 *     2. Otherwise serve THIS service's own FQDN as ACAO — which forbids
 *        an off-list browser caller from reading the response, since its
 *        own origin will never match.
 *     3. Never emit `Access-Control-Allow-Credentials: true`. If a future
 *        flow truly needs credentialed reads, the caller must add a
 *        deliberate per-route handler — at which point the allowlist
 *        check is already in place to gate it.
 *     4. Never accept `Origin: null` as a credentialed origin. (Sandboxed
 *        iframes, file:// URLs, and some redirects send `null`; treating
 *        it as a member of the allowlist would re-open the same hole.)
 *
 * Allowlist composition:
 *   - The service's own PUBLIC_BASE_URL (origin only).
 *   - The sibling deployment FQDNs (relay, identity, dashboard, css-gate,
 *     pgsl-browser, acme-id, foxxi-bridge, foxxi-dashboard,
 *     foxxi-microsite, foxxi-scorm-player).
 *   - Browser-based MCP client hosts: https://claude.ai, https://chatgpt.com,
 *     https://chat.openai.com.
 *   - Localhost dev ports: 3000, 4000, 5000, 9999, plus 8080/8090/8094
 *     (the relay/identity/css-gate local default ports).
 *   - The `RELAY_CORS_ALLOWLIST` env var (comma-separated origins) as a
 *     deployment-time extension hook for additional clients without code
 *     changes.
 *
 * Public surface:
 *   - `buildCorsAllowlist(opts)` — pure helper, used by tests + middleware.
 *   - `corsMiddleware(opts)` — Express-style middleware (callable from
 *     mcp-relay/server.ts and identity/server.ts).
 *   - `applyCorsHeaders(req, res, opts)` — low-level node:http variant for
 *     use from `deploy/css-gate/server.mjs` (no Express dependency).
 *   - `isAllowedOrigin(origin, allowlist)` — exposed so tests can probe.
 */

export interface CorsAllowlistOptions {
  /** This service's own public origin (e.g. `https://interego-relay.example.com`). */
  ownOrigin?: string;
  /** Extra explicit origins to add on top of the static defaults. */
  extra?: string[];
  /** Comma-separated env-var extension (defaults to `RELAY_CORS_ALLOWLIST`). */
  envOverride?: string;
}

// ── Static defaults ───────────────────────────────────────────
//
// These are the publicly-known deployment FQDNs. Kept literal so an
// off-list origin cannot inject itself by setting a misleading env var.

const SIBLING_DEPLOYMENT_ORIGINS: readonly string[] = [
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

const BROWSER_MCP_CLIENT_ORIGINS: readonly string[] = [
  'https://claude.ai',
  'https://chatgpt.com',
  'https://chat.openai.com',
];

const LOCALHOST_DEV_PORTS: readonly number[] = [
  3000, 4000, 5000, 8080, 8090, 8094, 9999,
];

function localhostOrigins(): string[] {
  const out: string[] = [];
  for (const port of LOCALHOST_DEV_PORTS) {
    out.push(`http://localhost:${port}`);
    out.push(`http://127.0.0.1:${port}`);
  }
  return out;
}

/** Normalize an origin string to scheme://host[:port], no path / no trailing slash. */
function normalizeOrigin(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function buildCorsAllowlist(opts: CorsAllowlistOptions = {}): Set<string> {
  const out = new Set<string>();

  const add = (origin: string | null | undefined): void => {
    if (!origin) return;
    const norm = normalizeOrigin(origin);
    if (norm) out.add(norm);
  };

  if (opts.ownOrigin) add(opts.ownOrigin);
  for (const o of SIBLING_DEPLOYMENT_ORIGINS) add(o);
  for (const o of BROWSER_MCP_CLIENT_ORIGINS) add(o);
  for (const o of localhostOrigins()) add(o);
  if (opts.extra) for (const o of opts.extra) add(o);

  const envVar = opts.envOverride ?? 'RELAY_CORS_ALLOWLIST';
  const envRaw = (typeof process !== 'undefined' && process.env) ? process.env[envVar] : undefined;
  if (envRaw) {
    for (const piece of envRaw.split(',')) add(piece);
  }

  return out;
}

/**
 * Decide whether the request `Origin` header is allowed.
 *
 * Notes:
 *   - The string `null` (sent by sandboxed iframes / file:// / opaque
 *     redirects) is NEVER treated as a member of the allowlist, even if
 *     someone foolishly adds `'null'` via RELAY_CORS_ALLOWLIST.
 *   - Comparison is case-sensitive on host (browsers always send lowercase)
 *     and scheme-strict (no http→https aliasing).
 */
export function isAllowedOrigin(origin: string | undefined | null, allowlist: Set<string>): boolean {
  if (!origin) return false;
  if (origin === 'null') return false;
  const norm = normalizeOrigin(origin);
  if (!norm) return false;
  return allowlist.has(norm);
}

const DEFAULT_ALLOW_METHODS = 'GET, POST, OPTIONS, DELETE, PUT, PATCH';
const DEFAULT_ALLOW_HEADERS = 'Accept, Content-Type, Authorization, mcp-session-id, mcp-protocol-version, DPoP';
const DEFAULT_EXPOSE_HEADERS = 'mcp-session-id, mcp-protocol-version';

export interface CorsHeaderOptions extends CorsAllowlistOptions {
  allowMethods?: string;
  allowHeaders?: string;
  exposeHeaders?: string;
}

/**
 * Compute the response headers for a given request Origin.
 *
 * If `origin` is on the allowlist: ACAO echoes the request origin and
 * Vary: Origin is set so caches do not serve a cached cross-origin
 * response to an off-list peer.
 *
 * If `origin` is missing or off-list: ACAO is set to the service's own
 * origin (which a browser caller will never match unless the request
 * is actually same-origin). No `Access-Control-Allow-Credentials`
 * header is emitted in either branch.
 */
export function computeCorsHeaders(
  origin: string | undefined | null,
  allowlist: Set<string>,
  ownOrigin: string,
  opts: { allowMethods?: string; allowHeaders?: string; exposeHeaders?: string } = {},
): Record<string, string> {
  const allowed = isAllowedOrigin(origin, allowlist);
  const acao = allowed ? normalizeOrigin(origin!)! : ownOrigin;
  return {
    'Access-Control-Allow-Origin': acao,
    'Access-Control-Allow-Methods': opts.allowMethods ?? DEFAULT_ALLOW_METHODS,
    'Access-Control-Allow-Headers': opts.allowHeaders ?? DEFAULT_ALLOW_HEADERS,
    'Access-Control-Expose-Headers': opts.exposeHeaders ?? DEFAULT_EXPOSE_HEADERS,
    Vary: 'Origin',
  };
}

// ── Express middleware ──────────────────────────────────────────
//
// The Express types are not imported here to keep this module reusable by
// the non-Express css-gate. The minimal shape we touch is:
//   req.headers (object), res.setHeader (function), next (function).

export type MinimalReq = { headers: Record<string, string | string[] | undefined> };
export type MinimalRes = { setHeader: (name: string, value: string) => void };
export type NextFn = () => void;

export function corsMiddleware(opts: CorsHeaderOptions = {}): (req: MinimalReq, res: MinimalRes, next: NextFn) => void {
  const ownOrigin = normalizeOrigin(opts.ownOrigin ?? '') ?? 'https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io';
  const allowlist = buildCorsAllowlist(opts);
  return (req, res, next) => {
    const originHeader = req.headers['origin'];
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    const headers = computeCorsHeaders(origin, allowlist, ownOrigin, {
      allowMethods: opts.allowMethods,
      allowHeaders: opts.allowHeaders,
      exposeHeaders: opts.exposeHeaders,
    });
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v);
    }
    next();
  };
}

/**
 * Lower-level helper for node:http (used by css-gate).
 *
 * Returns the headers to write; caller is responsible for merging into
 * the response. Does not invoke `next` since the css-gate uses raw
 * createServer.
 */
export function applyCorsHeaders(
  reqOrigin: string | undefined | null,
  opts: CorsHeaderOptions = {},
): Record<string, string> {
  const ownOrigin = normalizeOrigin(opts.ownOrigin ?? '') ?? 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io';
  const allowlist = buildCorsAllowlist(opts);
  return computeCorsHeaders(reqOrigin, allowlist, ownOrigin, {
    allowMethods: opts.allowMethods,
    allowHeaders: opts.allowHeaders,
    exposeHeaders: opts.exposeHeaders,
  });
}
