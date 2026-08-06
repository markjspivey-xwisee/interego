/**
 * The transport shim: one interface, two implementations, and a coupling to auth that the
 * TYPE enforces rather than a comment asserting it.
 *
 * ★ WHY THE COUPLING HAS TO BE IN THE TYPE. Measured against the live relay on 2026-08-06,
 * with one fresh SIWE-minted relay OAuth bearer and no bearer at all:
 *
 *   Bearer <relay oauth>  POST /mcp                  -> 200  pod=…/u-eth-8f3b8e939600/
 *   Bearer <relay oauth>  POST /tool/get_pod_status  -> 200  {"error":"pod_subject_unresolved"}
 *   (no header)           POST /tool/get_pod_status  -> 200  {"error":"pod_subject_unresolved"}
 *   Bearer <relay oauth>  POST /messages             -> 200  {"error":"pod_subject_unresolved"}
 *   (no header)           POST /messages             -> 200  {"error":"pod_subject_unresolved"}
 *
 * So `/tool/:name` and `/messages` DO NOT READ A RELAY OAUTH BEARER AT ALL — they answer
 * identically with one and without one, and neither answer carries a pod. They authenticate
 * by a different issuer (identity-server session token, or an ECDSA signed request). A single
 * `Authorization: Bearer …` string therefore does not span the relay's surfaces, and a
 * transport that took "a token" as an opaque string would let a caller hand an
 * identity-server token to `/mcp` and get a 401 at runtime that the compiler could have
 * caught.
 *
 * Hence: a credential declares its `kind`, a transport declares the ONE kind it accepts, and
 * {@link Transport} is generic in that kind. `new RelayMcpTransport(identityServerToken)` does
 * not compile.
 */

/**
 * An OAuth bearer minted by the RELAY'S OWN authorization server, at `POST /token`.
 *
 * Both auth methods in this client produce one of these — SIWE and WebAuthn are two ways of
 * satisfying `POST /oauth/verify` for the same pending authorization, not two token types.
 * `method` records which, because it is what decides the pod prefix the relay provisions
 * (`u-eth-…` for a wallet, `u-pk-…` for a passkey) and a caller that shows the user which
 * identity they are on needs it.
 */
export interface RelayOAuthBearer {
  readonly kind: 'relay-oauth-bearer';
  readonly accessToken: string;
  readonly method: 'siwe' | 'webauthn';
  /** Unix ms after which the token is known to be expired, when the grant reported one. */
  readonly expiresAt: number | null;
}

/**
 * The artifact's credential, and it is NOT a token this client ever holds.
 *
 * In a published Artifact the viewer grants a named connector a manifest of tool names at
 * publish time; the page calls `window.claude.mcp.callTool` and the runtime attaches whatever
 * the viewer's own connector session is. There is no bearer to store, rotate or leak, and
 * there is nothing for a keychain to hold.
 */
export interface ConnectorGrant {
  readonly kind: 'connector-grant';
}

/**
 * A token issued by the IDENTITY SERVER, which drives `/messages` and `/tool/:name`.
 *
 * ★ DECLARED HERE AND ACCEPTED BY NO TRANSPORT IN THIS PACKAGE, ON PURPOSE. The walking
 * skeleton reads and writes exclusively through relay tools on `/mcp` — see the measurement
 * above. Naming the credential without providing a transport for it is what makes "no single
 * bearer spans them" checkable: a future transport for those surfaces has to declare
 * `accepts: 'identity-server-token'`, and until one exists the compiler refuses to route one
 * of these anywhere.
 */
export interface IdentityServerToken {
  readonly kind: 'identity-server-token';
  readonly token: string;
}

export type Credential = RelayOAuthBearer | ConnectorGrant | IdentityServerToken;

/** Options a tool call may carry. Both transports honour `cache`; only one honours watches. */
export interface CallOptions {
  readonly cache?: { readonly staleTime: number };
  readonly signal?: AbortSignal;
}

/**
 * A relay refusal or an outage, with the code the callers switch on.
 *
 * The relay has TWO refusal shapes and reconciling them is the transport's job, so that every
 * call site downstream sees exactly one of them — see {@link asRefusal}.
 */
export class ToolCallError extends Error {
  readonly code: string;
  /** The full result envelope, when the failure arrived as a rejection carrying one. */
  readonly result: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(code: string, message?: string, opts?: { result?: unknown; retryable?: boolean; retryAfterMs?: number | null }) {
    super(message ?? code);
    this.name = 'ToolCallError';
    this.code = code;
    this.result = opts?.result;
    this.retryable = opts?.retryable ?? false;
    this.retryAfterMs = opts?.retryAfterMs ?? null;
  }
}

export const fail = (code: string, message?: string): ToolCallError => new ToolCallError(code, message);

/** A tool payload that is a relay refusal, or null when it is an ordinary answer. */
export function refusal(p: unknown): (Record<string, unknown> & { error: unknown }) | null {
  if (p && typeof p === 'object' && 'error' in p && (p as Record<string, unknown>)['error']) {
    return p as Record<string, unknown> & { error: unknown };
  }
  return null;
}

/**
 * Pull a refusal body out of a REJECTION, if that is what it is.
 *
 * MEASURED: a relay refusal normally arrives as a RESOLVED JSON body carrying `error` plus a
 * numeric `code` — 412 precondition_failed, 422 shape_violation, 403 scope_violation, 503
 * precondition_unavailable. But the connector contract rejects a tool-level failure with
 * `tool_error` and hangs the full result envelope on the rejection's `result`, and the relay
 * takes THAT path when a write throws rather than returning a refusal. So a rejection is
 * unwrapped here before it is ever treated as an outage.
 */
export function asRefusal(e: unknown): (Record<string, unknown> & { error: unknown }) | null {
  if (!e || typeof e !== 'object') return null;
  const err = e as { code?: unknown; result?: unknown };
  if (err.code !== 'tool_error') return null;
  const env = err.result;
  if (!env || typeof env !== 'object') return null;
  return refusal((env as { payload?: unknown }).payload);
}

/**
 * Separator between a tool name and its serialised input in a cache key.
 *
 * ★ U+0000, WRITTEN AS AN ESCAPE AND NEVER AS A RAW BYTE. Two literal NULs lived in this
 * file and failed `tests/line-endings-are-normalised.test.ts` while being invisible in
 * every editor and diff view — a branch that looked clean and would not merge.
 *
 * Deleting them is the obvious repair and the wrong one. With no separator the key is
 * `name + json`, so tool `ab` with input `c…` and tool `a` with input `bc…` collide and one
 * tool serves the other`s cached answer. NUL is used because it cannot appear in a tool
 * name or in `JSON.stringify` output, so no caller-supplied input can forge a boundary.
 *
 * It is a named constant so the two sites that must agree — the key and the prefix match
 * that invalidates it — cannot drift apart.
 *
 * ★ AND A RAW NUL COSTS MORE THAN A FAILING TEST: git classifies the whole file as binary.
 * The diff then reads `Bin 0 -> N bytes` with nothing reviewable in it, and grep answers
 * "Binary file … matches" instead of the line — so a change to ANY line of this transport
 * becomes unreviewable. Observed on this file before the fix landed. The runtime string is
 * identical either way; only the source is legible.
 */
const CACHE_KEY_SEP = '\u0000';

/** Stop a live subscription. */
export type Unsubscribe = () => void;

/** What a live watch reports. Shaped after the connector contract, which is the stricter one. */
export type WatchEvent =
  | { readonly type: 'error'; readonly error: { readonly code?: string; readonly message?: string } }
  | { readonly type: 'result'; readonly result: { readonly payload?: unknown } };

/**
 * ONE tool-calling surface, parameterised by the credential kind that can drive it.
 *
 * Implementations MUST reconcile the two refusal shapes: a `tool_error` rejection whose
 * envelope carries a refusal body is handed back as if it had RESOLVED, in the relay's own
 * words. Anything else throws.
 */
export interface Transport<K extends Credential['kind']> {
  /** The credential kind this transport can be constructed with. Not decoration — see above. */
  readonly accepts: K;
  /** A label for the connection, shown to the user. Never a literal in calling code. */
  readonly label: string;
  /** Resolve the surface and confirm the tools this client needs are reachable. */
  connect(requiredTools: readonly string[], probeTool: string): Promise<{ readonly granted: readonly string[] }>;
  /** Call one tool. Returns the parsed payload; throws {@link ToolCallError} on an outage. */
  callTool(name: string, input: Record<string, unknown>, opts?: CallOptions): Promise<unknown>;
  /**
   * Subscribe to a tool's answer changing, or null when this transport cannot.
   *
   * ★ NULL IS A REAL ANSWER AND CALLERS MUST HANDLE IT. Direct HTTP has no push channel; a
   * client that assumed a watch always registers left every stream at "reading…" forever.
   */
  watchTool?(name: string, input: Record<string, unknown>, onEvent: (ev: WatchEvent) => void, opts?: { refetchInterval?: number }): Unsubscribe | null;
  /** Drop any cached answer for a tool, so the next read is fresh. */
  invalidate?(name: string): Promise<void>;
}

// ── Transport 1: direct HTTP to the relay's MCP endpoint ─────────────────────

/** The shape `window.claude.mcp` presents. Declared rather than imported: it is a host API. */
export interface ConnectorMcp {
  listTools(): Promise<{ servers?: readonly { server: string; tools?: readonly { name?: string }[] }[] }>;
  callTool(server: string, name: string, input: Record<string, unknown>, opts?: CallOptions): Promise<{ payload?: unknown }>;
  watchTool?(server: string, name: string, input: Record<string, unknown>, onEvent: (ev: WatchEvent) => void, opts?: { refetchInterval?: number }): Unsubscribe;
  invalidate?(server: string, name: string): Promise<void>;
}

const RPC_ACCEPT = 'application/json, text/event-stream';

/**
 * Parse an MCP HTTP response body, which is EITHER JSON or an SSE frame stream.
 *
 * The relay content-negotiates on Accept and will answer either way for the same request, so
 * a client that only parsed JSON worked until the day the relay chose SSE.
 */
function parseRpcBody(raw: string): Record<string, unknown> | null {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { /* try SSE */ }
  const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
  if (!data) return null;
  try { return JSON.parse(data) as Record<string, unknown>; } catch { return null; }
}

/**
 * Direct HTTP to `POST <relay>/mcp`, driven by a relay OAuth bearer.
 *
 * This is the desktop transport. It is deliberately the SAME tool vocabulary the artifact
 * calls — every read goes through a relay tool and no descriptor URL is ever dereferenced
 * directly, because descriptor URLs come back as `http://css.railway.internal:3456/…` and are
 * not reachable from outside the fleet. A client that "helpfully" fetched one would work in
 * CI, inside the fleet, and fail on every user's machine.
 */
export class RelayMcpTransport implements Transport<'relay-oauth-bearer'> {
  readonly accepts = 'relay-oauth-bearer' as const;
  readonly label: string;
  private readonly relay: string;
  private credential: RelayOAuthBearer;
  private id = 0;
  private readonly fetchImpl: typeof fetch;
  /** name+input -> {at, payload}. Honours `opts.cache.staleTime` the way the connector does. */
  private readonly cache = new Map<string, { at: number; payload: unknown }>();

  constructor(relay: string, credential: RelayOAuthBearer, fetchImpl?: typeof fetch) {
    this.relay = relay.replace(/\/$/, '');
    this.credential = credential;
    this.label = 'Interego relay at ' + new URL(this.relay).host;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /** Swap in a re-minted bearer without rebuilding every consumer that holds this transport. */
  setCredential(c: RelayOAuthBearer): void {
    this.credential = c;
    this.cache.clear();
  }

  private async rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.relay + '/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + this.credential.accessToken,
          'Content-Type': 'application/json',
          Accept: RPC_ACCEPT,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      // The relay was not reached at all. This is NOT "the relay reported a failure", and
      // conflating the two told a user their write had been refused when nothing had answered.
      throw new ToolCallError('server_unavailable', 'The relay could not be reached: ' + ((e as Error)?.message ?? String(e)), { retryable: true });
    }
    const raw = await res.text();
    if (res.status === 401) {
      throw new ToolCallError('needs_reauth', 'The relay rejected this session token (HTTP 401). ' + raw.slice(0, 200));
    }
    const j = parseRpcBody(raw);
    if (!j) {
      throw new ToolCallError('upstream_error', 'The relay answered HTTP ' + res.status + ' with a body this client could not parse as JSON or as an SSE frame.');
    }
    return j;
  }

  async connect(requiredTools: readonly string[], probeTool: string): Promise<{ granted: readonly string[] }> {
    const j = await this.rpc('tools/list', {});
    const result = j['result'] as { tools?: readonly { name?: string }[] } | undefined;
    const granted = (result?.tools ?? []).map((t) => t.name).filter((n): n is string => typeof n === 'string');
    if (granted.indexOf(probeTool) < 0) {
      const missing = requiredTools.filter((t) => granted.indexOf(t) < 0);
      throw new ToolCallError('manifest_incomplete',
        'The relay answered tools/list and does not expose ' + probeTool + '. Reachable: '
        + (granted.length ? granted.join(', ') : 'no tools at all') + '. Missing: ' + missing.join(', ') + '.');
    }
    return { granted };
  }

  async callTool(name: string, input: Record<string, unknown>, opts?: CallOptions): Promise<unknown> {
    // ★ SPELLED, NOT TYPED. This separator is U+0000, and it was originally two RAW NUL
    // bytes in this file — invisible in every editor and diff, and enough to fail
    // `tests/line-endings-are-normalised.test.ts` on a branch that looked clean.
    //
    // It cannot simply be deleted, which is the obvious repair and the wrong one: without a
    // separator the key is `name + json`, so tool `ab` with input `c…` and tool `a` with
    // input `bc…` produce the SAME key and one tool serves the other's cached answer. NUL is
    // chosen because it cannot occur in a tool name or in `JSON.stringify` output, so no
    // input can forge a key boundary.
    const key = name + CACHE_KEY_SEP + JSON.stringify(input);
    const stale = opts?.cache?.staleTime;
    if (stale) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < stale) return hit.payload;
    }
    const j = await this.rpc('tools/call', { name, arguments: input }, opts?.signal);
    const rpcErr = j['error'] as { message?: string; code?: number } | undefined;
    if (rpcErr) {
      throw new ToolCallError('tool_error', rpcErr.message ?? 'the relay returned a JSON-RPC error', { result: j });
    }
    const result = (j['result'] ?? {}) as { content?: readonly { text?: string }[]; structuredContent?: unknown; isError?: boolean };
    let payload: unknown = result.structuredContent;
    if (payload === undefined) {
      const txt = result.content?.[0]?.text ?? '';
      try { payload = JSON.parse(txt); } catch { payload = txt; }
    }
    // ★ THE TWO REFUSAL SHAPES, RECONCILED HERE AND NOWHERE ELSE. `isError` with a refusal
    // body in it is the relay's own words about a refusal, so it RESOLVES; `isError` with
    // anything else is a genuine failure and throws. Doing this per call site is how one
    // branch came to treat a 412 as an outage and retry a write.
    if (result.isError) {
      const bad = refusal(payload);
      if (bad) return payload;
      throw new ToolCallError('tool_error', typeof payload === 'string' ? payload : JSON.stringify(payload).slice(0, 400), { result: { payload } });
    }
    if (stale) this.cache.set(key, { at: Date.now(), payload });
    return payload;
  }

  /**
   * ★ NULL, AND THAT IS THE HONEST ANSWER. There is no push channel on `POST /mcp`, so this
   * transport cannot watch. Returning a no-op unsubscribe would have looked like a successful
   * registration and left every stream waiting for updates that could never arrive; the
   * caller polls instead, and knows it is polling.
   */
  watchTool(): Unsubscribe | null {
    return null;
  }

  async invalidate(name: string): Promise<void> {
    // Same separator as the key it is matching — see `const key` above. With an empty string
    // here, invalidating tool `a` would also drop every cached answer for `ab`, `abc`, …
    for (const k of [...this.cache.keys()]) if (k.startsWith(name + CACHE_KEY_SEP)) this.cache.delete(k);
  }
}

// ── Transport 2: the artifact's connector runtime ────────────────────────────

/**
 * `window.claude.mcp`, driven by the viewer's own connector grant.
 *
 * The server DISPLAY NAME is resolved at connect time and never written as a literal: it is
 * whatever the viewer named their connector.
 */
export class ConnectorTransport implements Transport<'connector-grant'> {
  readonly accepts = 'connector-grant' as const;
  label = 'connector';
  private readonly mcp: ConnectorMcp;
  private server: string | null = null;

  constructor(mcp: ConnectorMcp) {
    this.mcp = mcp;
  }

  async connect(requiredTools: readonly string[], probeTool: string): Promise<{ granted: readonly string[] }> {
    const res = await this.mcp.listTools();
    const servers = res?.servers ?? [];
    const hit = servers.find((s) => (s.tools ?? []).some((t) => t?.name === probeTool));
    if (!hit) {
      // ★ WHICH OF THE TWO FAILURES THIS IS. No server at all is a connector that was never
      // added. A server that answered but exposes none of these tools is a page published
      // without the full manifest — and the two used to render the same dead end ("add the
      // connector, then reload") to somebody who had already added it.
      if (!servers.length) {
        throw new ToolCallError('server_not_connected', 'No connector answered this page at all.');
      }
      const seen: string[] = [];
      for (const s of servers) for (const t of s.tools ?? []) if (t?.name) seen.push(t.name);
      const missing = requiredTools.filter((t) => seen.indexOf(t) < 0);
      throw new ToolCallError('manifest_incomplete',
        'A connector answered — ' + servers.map((s) => s.server).join(', ') + ' — and this page\'s grant does not include ' + probeTool + '. '
        + 'Granted to this page: ' + (seen.length ? seen.join(', ') : 'no tools at all') + '. '
        + 'Missing: ' + missing.join(', ') + '. '
        + 'That list is the `capabilities` argument passed when this page was published, not something the page '
        + 'can ask for at runtime — so re-publishing this file with all ' + requiredTools.length + ' names is the fix, and reloading is not.');
    }
    this.server = hit.server;
    this.label = hit.server;
    const granted = (hit.tools ?? []).map((t) => t?.name).filter((n): n is string => typeof n === 'string');
    return { granted };
  }

  async callTool(name: string, input: Record<string, unknown>, opts?: CallOptions): Promise<unknown> {
    if (this.server === null) throw new ToolCallError('server_not_connected', 'connect() has not resolved a connector yet.');
    try {
      const r = await this.mcp.callTool(this.server, name, input, opts);
      return r?.payload;
    } catch (e) {
      const body = asRefusal(e);
      if (body) return body;
      throw e;
    }
  }

  watchTool(name: string, input: Record<string, unknown>, onEvent: (ev: WatchEvent) => void, opts?: { refetchInterval?: number }): Unsubscribe | null {
    if (this.server === null || !this.mcp.watchTool) return null;
    // ★ THE THROW HERE IS NOT ONLY A NON-FUNCTION HANDLER. A shell without watchTool at all
    // makes this a TypeError, and a comment asserting otherwise left every stream `loaded:
    // false` forever. Registration failure returns null, which callers already handle by
    // falling back to a one-shot read.
    try {
      return this.mcp.watchTool(this.server, name, input, onEvent, opts);
    } catch {
      return null;
    }
  }

  async invalidate(name: string): Promise<void> {
    if (this.server === null || !this.mcp.invalidate) return;
    try { await this.mcp.invalidate(this.server, name); } catch { /* nothing cached */ }
  }
}

/** Any transport this package can drive. Erases the credential parameter for storage. */
export type AnyTransport = Transport<Credential['kind']>;
