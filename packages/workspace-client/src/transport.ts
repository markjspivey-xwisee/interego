import { relayRefusal } from '@interego/core/delegate';

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
  /**
   * The successor this grant can be exchanged for, when the relay issued one.
   *
   * ★ MEASURED, 2026-08-06: `/token` returns `expires_in: 3600` and a `refresh_token` to a
   * PUBLIC client, the `refresh_token` grant is accepted, and THE REFRESH TOKEN ROTATES — the
   * exchange returns a new one and the old one is refused `400 invalid_grant, "Invalid or
   * expired refresh token"` if presented again. So a holder that renews and keeps the token it
   * started with gets exactly one extra hour and then fails, unattended, with nobody watching.
   * Carrying the successor forward is not an optimisation; it is the difference between one
   * renewal and all of them.
   *
   * The old ACCESS token keeps working after a refresh, so renewal is additive and an in-flight
   * call cannot be killed by one.
   *
   * Null for a grant that reported none. Absence is not evidence: it is not a guessed value.
   */
  readonly refreshToken: string | null;
  /** The public client the grant belongs to. A refresh exchange has to name it. */
  readonly clientId: string | null;
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

/**
 * Options a tool call may carry. Both transports honour `cache`; only one honours watches.
 *
 * `cache: false` is a REAL VALUE and not the same as omitting the field. Omitting it leaves
 * caching to the host — the connector runtime caches on its own default — whereas `false` says
 * this particular read must not be served from anything. Authorization verdicts and the "which
 * workspaces am I in" scan both pass it: serving a stale one for two minutes is exactly how a
 * withdrawn delegation, or a workspace you just accepted, keeps looking the way it used to.
 */
export interface CallOptions {
  readonly cache?: { readonly staleTime: number } | false;
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

/**
 * A tool payload that is a relay refusal, or null when it is an ordinary answer.
 *
 * ★ THE SHAPE IS THE RELAY'S, SO THE DEFINITION IS THE SUBSTRATE'S. This vertical had its own
 * copy of the four-line check; `@interego/core/delegate` needs the same one to tell an accepted
 * `register_agent` from a refused one, and two readers of one wire envelope is exactly how a
 * refusal comes to be read as a success on one surface and not the other.
 */
export const refusal = relayRefusal;

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

/**
 * A WATCH BUILT OUT OF RE-READS, in ONE place, because two clients need it.
 *
 * ★ WHY IT IS A FUNCTION AND NOT A METHOD. The desktop shell does not drive
 * {@link RelayMcpTransport} from its renderer — the bearer lives in its main process, so the
 * renderer runs a {@link ConnectorTransport} over an IPC channel and the HTTP transport is on
 * the far side of it. Both ends need the same watch, and writing it twice is precisely the
 * "two copies of one intention" that every drift defect in this vertical came from. So the loop
 * lives here and both ends bind it.
 *
 * ★ AND IT IS A POLL, WHICH IS NOT A DISGUISE — see {@link RelayMcpTransport.watchTool} for the
 * measurement that establishes there is nothing to subscribe to on this relay. What makes it a
 * watch rather than a heartbeat is the comparison: an event fires only when THE ANSWER CHANGES,
 * so a consumer can treat one as "something happened" instead of "the timer went off".
 *
 * Errors are NOT deduplicated. A payload that repeats is not news; an error that persists is a
 * condition the consumer has to keep showing, and suppressing the repeat would let a consumer
 * that recovered its rendering forget it is still failing.
 */
export function pollingWatch(
  read: (name: string, input: Record<string, unknown>) => Promise<unknown>,
  name: string,
  input: Record<string, unknown>,
  onEvent: (ev: WatchEvent) => void,
  opts?: { refetchInterval?: number },
): Unsubscribe {
  const every = opts?.refetchInterval ?? 45000;
  let stopped = false;
  let last: string | null = null;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const payload = await read(name, input);
      if (stopped) return;
      const now = JSON.stringify(payload) ?? 'undefined';
      if (now === last) return;
      last = now;
      onEvent({ type: 'data', result: { payload } });
    } catch (e) {
      if (stopped) return;
      const err = e as { code?: string; message?: string };
      // Reset, so a recovery after an error is delivered even if the payload is byte-identical
      // to the last good one — otherwise a consumer showing "this failed" would never be told
      // it stopped failing.
      last = null;
      onEvent({ type: 'error', error: { code: err.code ?? 'upstream_error', message: err.message ?? String(e) } });
    }
  };
  // The first read is immediate and unawaited: registration is synchronous by contract, and a
  // consumer that had to wait `every` ms for its first rows would show an empty log until then.
  void tick();
  const timer = setInterval(() => { void tick(); }, every);
  return () => { stopped = true; clearInterval(timer); };
}

/** What a live watch reports. Shaped after the connector contract, which is the stricter one. */
export type WatchEvent =
  | { readonly type: 'error'; readonly error: { readonly code?: string; readonly message?: string } }
  // ★ THE SUCCESS TAG IS `data`, NOT `result`. Runtime contract 0.1.17 names the discriminant
  // `data` and the payload field `result` — so a union written as `type: 'result'` is the
  // FIELD's name in the TAG's position. Nothing catches that: the shape typechecks, and
  // `if (ev.type === 'result')` compiles, never matches, and silently discards every update a
  // live watch delivers. A page would show a stream that simply never moves.
  | { readonly type: 'data'; readonly result: { readonly payload?: unknown } };

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
  /**
   * HOW THIS TRANSPORT'S WATCH WORKS, in words a shell shows the user.
   *
   * ★ IT IS ON THE INTERFACE BECAUSE THE TWO IMPLEMENTATIONS DIFFER AND THE DIFFERENCE IS
   * VISIBLE. One re-reads on a timer; the other hands the job to a host whose mechanism it
   * cannot see. A shell that printed "live" over either would be asserting a property of a
   * channel it did not open. Read at render time, never written as a literal in a shell.
   */
  readonly watchDescription: string;
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
  /** See {@link watchTool} for the measurement this sentence reports. */
  readonly watchDescription = 're-read on a timer, not pushed — this relay exposes no per-graph '
    + 'notification channel a workspace can subscribe to, so an update appears at the next read '
    + 'and not when it happens';
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
    // `cache: false` and an absent `cache` both mean "no stale window here"; see CallOptions.
    const stale = opts?.cache ? opts.cache.staleTime : undefined;
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
   * A REAL WATCH, AND IT IS A POLL — the distinction is published on {@link watchDescription}
   * rather than smoothed over, because this relay has no push channel a workspace can use.
   *
   * ★ MEASURED AGAINST THE LIVE RELAY, 2026-08-06, with two freshly minted bearers on two real
   * pods. Both candidate channels were tried before this was written:
   *
   *   GET /notifications/<slug of my OWN pod>   -> 400 {"error":"pod_url_rejected",
   *                                                     "detail":"pod URL must use https"}
   *   GET /notifications/<slug of ANOTHER pod>  -> 404 {"error":"unknown_pod_slug"}
   *   GET /sse                                  -> 200 text/event-stream
   *
   * The per-pod SolidNotifications channel is the one shaped right — its events carry
   * `podUrl`, `descriptorUrl`, `graphUrl` and an eventType — and it is UNREACHABLE ON THIS
   * DEPLOYMENT in both directions. Outward: `requireAuthorizedPodUrl` runs every pod URL
   * through `assertPublicPodUrl`, and this fleet's pods ARE `http://css.railway.internal:3456/…`,
   * so the relay's own guard rejects the relay's own pods before authorization is even
   * considered. Inward: the same gate requires the slug's pod to be a prefix of the bearer's
   * own, so even repaired it could never open a channel on ANOTHER member's log — which is the
   * only thing a workspace watch is for.
   *
   * `GET /sse` connects, and it is not a subscription. It re-sends the last five entries of a
   * recent-activity ring every 2 seconds. The frames carry a `resource` and no pod and no graph
   * IRI, so a reader cannot tell WHICH graph an event is about; and because the same five are
   * re-sent on every tick, it cannot tell a new event from a repeat either. Measured
   * 2026-08-06: 5 frames in 8 s, four of them identical.
   *
   * ★ AND ONE THING RECORDED HERE TURNED OUT TO BE A DISCLOSURE, WHICH IS WHY THIS PARAGRAPH
   * NOW READS DIFFERENTLY FROM THE ONE ABOVE IT. This note used to add "one process-global
   * ring, not a per-pod queue", offered as evidence that the channel was too coarse to build a
   * watch on. It was also the finding: the ring was fed by every pod's publish and `/sse` sat
   * behind a gate that checks only that a bearer is VALID, so any authenticated client received
   * the descriptor URL and timestamp of every write on the fleet. Reproduced on 2026-08-07 with
   * two disposable identities and closed the same day — the ring is keyed by pod and `/sse`
   * serves the connection's own. See `deploy/mcp-relay/notification-log.ts`.
   *
   * The conclusion below is UNCHANGED and now holds more strongly: scoped to your own pod, this
   * channel cannot carry another member's log even in principle, and another member's log is
   * the only thing a workspace watch is for.
   *
   * So there is nothing to subscribe TO, and the honest implementation of a watch here is the
   * one the interface's own `refetchInterval` option already describes: re-issue the read on a
   * timer and deliver an event when THE ANSWER CHANGES. That is a genuine event — it means the
   * answer to this exact read differs from the last time it was asked — and it is not what a
   * push would be. Returning null instead was defensible and cost more than it saved: every
   * caller then wrote its own polling loop, which is the "two copies of one intention" that
   * every drift defect in this vertical came from.
   */
  watchTool(
    name: string, input: Record<string, unknown>, onEvent: (ev: WatchEvent) => void,
    opts?: { refetchInterval?: number },
  ): Unsubscribe | null {
    // No cache option is passed: a watch that could be served a cached answer is a watch that
    // reports the world stopped moving.
    return pollingWatch((n, i) => this.callTool(n, i), name, input, onEvent, opts);
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
  /**
   * The host runs the watch and does not say how. Claiming "live" here would be this package
   * asserting a property of a channel it neither opened nor can see.
   */
  readonly watchDescription = 'handled by the connector runtime, which was asked to refetch on '
    + 'an interval; whether it also pushes is not something this page can establish';
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
        // The remedy is named HERE rather than left to a shell's error copy. This transport
        // exists for exactly one host — a published Artifact page under a viewer's own
        // connector grant — so "add the connector" is always its right next move, and a shell
        // that supplied the sentence would be a second place the instruction had to be kept
        // true. The desktop shell mints its own bearer, so "reload" is wrong advice there;
        // that is precisely why this belongs to the transport that knows its host.
        throw new ToolCallError('server_not_connected',
          'No connector answered this page at all. Add the Interego connector in claude.ai under Settings → Connectors, then reload.');
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
