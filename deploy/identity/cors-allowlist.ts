/**
 * Explicit CORS allowlist for the Interego identity server.
 *
 * Mirror of `deploy/mcp-relay/cors-allowlist.ts` — duplicated here because
 * the identity service is a sibling npm workspace package and we keep its
 * dependencies minimal (no @interego/core, no shared util package yet).
 * If the substrate grows a `@interego/deploy-utils` package, both copies
 * collapse into that import.
 *
 * Same posture:
 *   - Reflect Origin only if it appears on a static allowlist.
 *   - Otherwise serve THIS service's own FQDN as ACAO (a browser caller
 *     never matches its own origin against ours, so the response is
 *     unreadable cross-origin).
 *   - Never emit `Access-Control-Allow-Credentials: true`.
 *   - Reject `Origin: null` (sandboxed iframes / file://).
 *   - Vary: Origin on every response.
 *
 * See deploy/mcp-relay/cors-allowlist.ts for the full rationale comment.
 */

export interface CorsAllowlistOptions {
  ownOrigin?: string;
  extra?: string[];
  envOverride?: string;
}

const SIBLING_DEPLOYMENT_ORIGINS: readonly string[] = [
  // ★ The six *.eastus.azurecontainerapps.io siblings that stood here were REMOVED.
  // They were described as "inert legacy", but an entry in this list is not inert —
  // it is an origin this service grants cross-origin trust to, and that Azure
  // environment is deleted. An allowlist must only ever name origins we still
  // control; a hostname we have released is one we cannot make promises about.
  // The live stack is Railway, below.
  // Live Railway deployment (*.interego.xwisee.com) — the current home.
  // relay.interego.xwisee.com serves the OAuth passwordless sign-in page, whose
  // WebAuthn/SIWE calls hit this identity server cross-origin — without this
  // entry the preflight ACAO falls back to identity's own host and the browser
  // blocks the sign-in.
  'https://interego.xwisee.com',
  'https://relay.interego.xwisee.com',
  'https://identity.interego.xwisee.com',
  'https://dashboard.interego.xwisee.com',
  'https://gate.interego.xwisee.com',
  'https://pgsl-browser.interego.xwisee.com',
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

export function isAllowedOrigin(origin: string | undefined | null, allowlist: Set<string>): boolean {
  if (!origin) return false;
  if (origin === 'null') return false;
  const norm = normalizeOrigin(origin);
  if (!norm) return false;
  return allowlist.has(norm);
}

const DEFAULT_ALLOW_METHODS = 'GET, POST, OPTIONS, DELETE, PUT, PATCH';
// Kept in sync with deploy/mcp-relay/cors-allowlist.ts so a future maintainer
// adding a header on the relay side does not silently leave this twin's
// preflight 403'ing the same header. Per-call sites (e.g. identity's
// server.ts) still narrow the effective set via the `allowHeaders` option.
// Mcp-Method / Mcp-Name are required on protocol revision 2026-07-28; a browser cannot
// send a header the preflight did not allow. Kept identical to the relay's list — this
// file is the second copy of that allow-list, and the two drifting is how one surface
// silently stops accepting a revision the other serves.
const DEFAULT_ALLOW_HEADERS = 'Accept, Content-Type, Authorization, mcp-session-id, mcp-protocol-version, Mcp-Method, Mcp-Name, DPoP';

export interface CorsHeaderOptions extends CorsAllowlistOptions {
  allowMethods?: string;
  allowHeaders?: string;
  exposeHeaders?: string;
}

export function computeCorsHeaders(
  origin: string | undefined | null,
  allowlist: Set<string>,
  ownOrigin: string,
  opts: { allowMethods?: string; allowHeaders?: string; exposeHeaders?: string } = {},
): Record<string, string> {
  const allowed = isAllowedOrigin(origin, allowlist);
  const acao = allowed ? normalizeOrigin(origin!)! : ownOrigin;
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': acao,
    'Access-Control-Allow-Methods': opts.allowMethods ?? DEFAULT_ALLOW_METHODS,
    'Access-Control-Allow-Headers': opts.allowHeaders ?? DEFAULT_ALLOW_HEADERS,
    Vary: 'Origin',
  };
  if (opts.exposeHeaders) headers['Access-Control-Expose-Headers'] = opts.exposeHeaders;
  return headers;
}

export type MinimalReq = { headers: Record<string, string | string[] | undefined> };
export type MinimalRes = { setHeader: (name: string, value: string) => void };
export type NextFn = () => void;

export function corsMiddleware(opts: CorsHeaderOptions = {}): (req: MinimalReq, res: MinimalRes, next: NextFn) => void {
  const ownOrigin = normalizeOrigin(opts.ownOrigin ?? '') ?? 'https://identity.interego.xwisee.com';
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
