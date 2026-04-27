/**
 * @module p2p/websocket-relay-mirror
 * @description Bidirectional WebSocket bridge between a local
 * `P2pRelay` and N external Nostr relays.
 *
 *   Wraps an inner P2pRelay (typically `InMemoryRelay`) and:
 *
 *   OUTBOUND
 *     Every event published locally → fan out to all external
 *     relays as `["EVENT", event]` per NIP-01.
 *
 *   INBOUND
 *     One subscription per external relay (`["REQ", subId, filter]`)
 *     for the Interego-known kinds. Incoming events get injected
 *     into the inner relay so existing local subscribers see them
 *     transparently.
 *
 *   DEDUP + LOOP PREVENTION
 *     Every event id we've ever seen (from any direction) goes into
 *     a bounded LRU. If publish() is called with an id we've already
 *     forwarded, we suppress the outbound mirror to avoid loops.
 *     This also dedups events arriving from multiple external relays.
 *
 *   RECONNECT
 *     Per-connection exponential backoff (1s → 30s ceiling).
 *     Status reportable via `status()`.
 *
 *   The mirror IMPLEMENTS `P2pRelay`, so callers (including
 *   `P2pClient`) treat it identically to any other relay. Wire it
 *   into personal-bridge whenever `EXTERNAL_RELAYS` is set.
 */

import { WebSocket } from 'ws';
import {
  KIND_DESCRIPTOR,
  KIND_DIRECTORY,
  KIND_ATTESTATION,
  KIND_ENCRYPTED_SHARE,
  type P2pEvent,
  type P2pFilter,
  type P2pRelay,
  type P2pSubscription,
} from './types.js';
import { verifyEvent } from './client.js';

// ── Public types ─────────────────────────────────────────────

export interface RelayConnectionStatus {
  readonly url: string;
  readonly state: 'connecting' | 'connected' | 'closed' | 'errored';
  readonly lastError?: string;
  readonly eventsOut: number;
  readonly eventsIn: number;
  readonly reconnectAttempts: number;
  readonly connectedSince?: number; // unix seconds
}

export interface MirrorOptions {
  /**
   * Kinds to subscribe to from external relays. Defaults to the
   * four Interego kinds (30040-30043). Override to broaden (e.g.,
   * include kind 1 for plain Nostr text notes) or narrow.
   */
  readonly subscribeKinds?: readonly number[];

  /**
   * Pubkeys (hex, no `0x`/no-prefix Schnorr form OR ECDSA address)
   * to subscribe to inbound. **If empty or omitted, the mirror
   * sends NO subscription request** — outbound-only mode. This is
   * the recommended default: the kind-30000 range is shared with
   * other Nostr apps using these numbers for unrelated purposes,
   * so unfiltered subscriptions pull in lots of garbage.
   *
   * Set this only when you want to follow specific identities
   * across the federation.
   */
  readonly subscribeAuthors?: readonly string[];

  /**
   * Optional structural validator applied AFTER signature
   * verification, BEFORE injection into the inner relay. Return
   * `true` to accept, `false` to drop. Use `isInteregoEvent` from
   * this module to require the Interego tag shape — defense in
   * depth against random kind-30040 events from other Nostr apps
   * sneaking into your local store.
   */
  readonly inboundFilter?: (event: P2pEvent) => boolean;

  /**
   * Cap on the number of unique event ids we remember for dedup.
   * Older ids are evicted FIFO. Default: 10000 — enough for ~hours
   * of normal traffic without unbounded growth.
   */
  readonly dedupCacheSize?: number;

  /**
   * Reconnect backoff bounds (ms). On each failed attempt the delay
   * doubles up to `maxMs`. Default: { initialMs: 1000, maxMs: 30000 }.
   */
  readonly backoff?: { initialMs: number; maxMs: number };

  /**
   * Optional callback fired whenever a per-relay status changes.
   * Useful for surfacing in admin UIs.
   */
  readonly onStatusChange?: (status: RelayConnectionStatus) => void;
}

/**
 * Default structural validator for inbound events. Requires the
 * shape an Interego event must have to be useful. Use as
 * `inboundFilter: isInteregoEvent` to drop random kind-30040 events
 * from unrelated Nostr apps.
 */
export function isInteregoEvent(event: P2pEvent): boolean {
  const has = (name: string): boolean => event.tags.some(t => t[0] === name);
  switch (event.kind) {
    case KIND_DESCRIPTOR:        return has('d') && has('cid') && has('graph');
    case KIND_DIRECTORY:         return event.tags.some(t => t[0] === 'd' && t[1] === 'directory');
    case KIND_ATTESTATION:       return has('e');
    case KIND_ENCRYPTED_SHARE:   return has('p');
    default:                     return false;
  }
}

// ── Implementation ───────────────────────────────────────────

interface ConnectionState {
  url: string;
  ws: WebSocket | null;
  state: RelayConnectionStatus['state'];
  lastError?: string;
  eventsOut: number;
  eventsIn: number;
  reconnectAttempts: number;
  connectedSince?: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  subId: string;
}

const DEFAULT_KINDS = [
  KIND_DESCRIPTOR,
  KIND_DIRECTORY,
  KIND_ATTESTATION,
  KIND_ENCRYPTED_SHARE,
];

export class WebSocketRelayMirror implements P2pRelay {
  private readonly inner: P2pRelay;
  private readonly urls: readonly string[];
  private readonly subscribeKinds: readonly number[];
  private readonly subscribeAuthors: readonly string[];
  private readonly inboundFilter: ((event: P2pEvent) => boolean) | null;
  private readonly backoff: { initialMs: number; maxMs: number };
  private readonly onStatusChange?: (status: RelayConnectionStatus) => void;

  // FIFO-bounded dedup cache: ids we've already forwarded in either
  // direction. Bounds the memory footprint of a long-running bridge.
  private readonly seenIds = new Set<string>();
  private readonly seenIdsOrder: string[] = [];
  private readonly dedupCacheSize: number;

  private readonly conns = new Map<string, ConnectionState>();
  private stopped = false;

  constructor(inner: P2pRelay, urls: readonly string[], opts: MirrorOptions = {}) {
    this.inner = inner;
    this.urls = urls.slice();
    this.subscribeKinds = opts.subscribeKinds ?? DEFAULT_KINDS;
    this.subscribeAuthors = (opts.subscribeAuthors ?? []).map(a => a.toLowerCase());
    this.inboundFilter = opts.inboundFilter ?? null;
    this.dedupCacheSize = opts.dedupCacheSize ?? 10000;
    this.backoff = opts.backoff ?? { initialMs: 1000, maxMs: 30000 };
    if (opts.onStatusChange) this.onStatusChange = opts.onStatusChange;
  }

  /** Whether inbound events from external relays are accepted. */
  isInboundEnabled(): boolean {
    return this.subscribeAuthors.length > 0;
  }

  /** Open WebSocket connections to all configured external relays. */
  start(): void {
    if (this.stopped) return;
    for (const url of this.urls) {
      this.openConnection(url);
    }
  }

  /** Close all WebSocket connections. The inner relay is unaffected. */
  stop(): void {
    this.stopped = true;
    for (const conn of this.conns.values()) {
      if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
      try { conn.ws?.close(); } catch { /* ignore */ }
      conn.state = 'closed';
    }
  }

  /** Per-relay connection status snapshots. */
  status(): RelayConnectionStatus[] {
    return [...this.conns.values()].map(c => ({
      url: c.url,
      state: c.state,
      ...(c.lastError !== undefined ? { lastError: c.lastError } : {}),
      eventsOut: c.eventsOut,
      eventsIn: c.eventsIn,
      reconnectAttempts: c.reconnectAttempts,
      ...(c.connectedSince !== undefined ? { connectedSince: c.connectedSince } : {}),
    }));
  }

  // ── P2pRelay surface (delegates + mirrors) ────────────────

  async publish(event: P2pEvent): Promise<{ ok: boolean; reason?: string }> {
    const result = await this.inner.publish(event);
    if (result.ok && !this.seenIds.has(event.id)) {
      this.rememberId(event.id);
      this.broadcastOutbound(event);
    }
    return result;
  }

  query(filter: P2pFilter): Promise<readonly P2pEvent[]> {
    return this.inner.query(filter);
  }

  subscribe(filter: P2pFilter, onEvent: (e: P2pEvent) => void): P2pSubscription {
    return this.inner.subscribe(filter, onEvent);
  }

  // ── Connection lifecycle ──────────────────────────────────

  private openConnection(url: string): void {
    if (this.stopped) return;

    const existing = this.conns.get(url);
    const subId = existing?.subId ?? `interego-mirror-${Math.random().toString(36).slice(2)}`;

    const conn: ConnectionState = existing ?? {
      url,
      ws: null,
      state: 'connecting',
      eventsOut: 0,
      eventsIn: 0,
      reconnectAttempts: 0,
      subId,
    };
    conn.state = 'connecting';
    delete conn.lastError;
    this.conns.set(url, conn);
    this.fireStatus(conn);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      conn.state = 'errored';
      conn.lastError = (err as Error).message;
      this.fireStatus(conn);
      this.scheduleReconnect(conn);
      return;
    }
    conn.ws = ws;

    ws.on('open', () => {
      conn.state = 'connected';
      conn.connectedSince = Math.floor(Date.now() / 1000);
      conn.reconnectAttempts = 0;
      this.fireStatus(conn);
      // Inbound subscription: only when subscribeAuthors is non-empty.
      // The kind range 30000-39999 is shared on public Nostr; an
      // unfiltered subscription pulls in lots of unrelated events.
      // Outbound publishing is unaffected by this gate.
      if (this.subscribeAuthors.length === 0) return;
      const filter = {
        kinds: [...this.subscribeKinds],
        authors: [...this.subscribeAuthors],
      };
      try {
        ws.send(JSON.stringify(['REQ', conn.subId, filter]));
      } catch { /* will reconnect */ }
    });

    ws.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // malformed
      }
      this.handleRelayMessage(conn, msg);
    });

    ws.on('close', () => {
      conn.state = 'closed';
      delete conn.connectedSince;
      this.fireStatus(conn);
      if (!this.stopped) this.scheduleReconnect(conn);
    });

    ws.on('error', (err) => {
      conn.state = 'errored';
      conn.lastError = (err as Error).message;
      this.fireStatus(conn);
    });
  }

  private scheduleReconnect(conn: ConnectionState): void {
    if (this.stopped) return;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    const attempt = conn.reconnectAttempts++;
    const delay = Math.min(
      this.backoff.initialMs * Math.pow(2, Math.max(0, attempt - 1)),
      this.backoff.maxMs,
    );
    conn.reconnectTimer = setTimeout(() => {
      this.openConnection(conn.url);
    }, delay);
  }

  private async handleRelayMessage(conn: ConnectionState, msg: unknown): Promise<void> {
    if (!Array.isArray(msg) || msg.length < 1 || typeof msg[0] !== 'string') return;
    const verb = msg[0] as string;

    if (verb === 'EVENT' && msg.length >= 3) {
      // ["EVENT", subId, event]
      const event = msg[2] as P2pEvent;
      if (!event || typeof event !== 'object' || !event.id) return;
      // Verify integrity + signature
      if (verifyEvent(event) === null) return;
      // Dedup
      if (this.seenIds.has(event.id)) return;
      // Structural filter (defense in depth — kind 30000-39999
      // is shared with other Nostr apps; we only want the shape
      // Interego defines). Marked seen even if filtered so we
      // don't re-evaluate the same event arriving from N relays.
      if (this.inboundFilter && !this.inboundFilter(event)) {
        this.rememberId(event.id);
        return;
      }
      this.rememberId(event.id);
      conn.eventsIn++;
      // Inject into local relay; existing local subscribers will see
      // it transparently. publish() respects the seenIds cache so
      // this won't re-mirror back to other external relays.
      await this.inner.publish(event);
      return;
    }

    if (verb === 'EOSE') {
      // End of stored events — relay is now in live mode for this sub
      return;
    }

    if (verb === 'NOTICE') {
      // Relay-level message; useful for diagnostics
      conn.lastError = `NOTICE from relay: ${String(msg[1] ?? '')}`;
      this.fireStatus(conn);
      return;
    }

    if (verb === 'OK' && msg.length >= 3) {
      // ["OK", eventId, accepted, message] — relay's response to our publish
      // We don't currently retry on rejection; just count the event.
      return;
    }

    // CLOSED, AUTH, COUNT, etc. — ignore for v1.1
  }

  private broadcastOutbound(event: P2pEvent): void {
    const wire = JSON.stringify(['EVENT', event]);
    for (const conn of this.conns.values()) {
      if (conn.state !== 'connected' || !conn.ws) continue;
      try {
        conn.ws.send(wire);
        conn.eventsOut++;
      } catch (err) {
        conn.lastError = `Send failed: ${(err as Error).message}`;
        this.fireStatus(conn);
      }
    }
  }

  private rememberId(id: string): void {
    if (this.seenIds.has(id)) return;
    this.seenIds.add(id);
    this.seenIdsOrder.push(id);
    if (this.seenIdsOrder.length > this.dedupCacheSize) {
      const evicted = this.seenIdsOrder.shift();
      if (evicted) this.seenIds.delete(evicted);
    }
  }

  private fireStatus(conn: ConnectionState): void {
    if (!this.onStatusChange) return;
    this.onStatusChange({
      url: conn.url,
      state: conn.state,
      ...(conn.lastError !== undefined ? { lastError: conn.lastError } : {}),
      eventsOut: conn.eventsOut,
      eventsIn: conn.eventsIn,
      reconnectAttempts: conn.reconnectAttempts,
      ...(conn.connectedSince !== undefined ? { connectedSince: conn.connectedSince } : {}),
    });
  }
}
