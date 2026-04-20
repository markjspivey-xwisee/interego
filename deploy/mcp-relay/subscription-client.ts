/**
 * Solid Notifications subscription client (skeleton).
 *
 * LAYER: Layer 2 — architecture pattern. See spec/LAYERS.md.
 *
 * The Interego protocol does NOT mandate Solid Notifications; any
 * subscription mechanism that delivers descriptor-creation events
 * satisfies the protocol's federation-query requirement (see
 * spec/architecture.md §5.2.1 cleartext/ciphertext boundary). This
 * module implements one such mechanism — the Solid Notifications
 * Protocol — so validator-agents, dashboards, and federation clients
 * can react to pod-level descriptor writes without polling LDP
 * containers.
 *
 * Wire protocol: Solid Notifications Protocol 0.2
 *   https://solid.github.io/notifications/protocol/
 *
 * Subscription types supported (by target: pod container):
 *   - WebSocketChannel2023 — long-lived WS subscription, primary path
 *   - WebhookChannel2023   — HTTP callback for services that can't hold sockets
 *
 * This is a skeleton: it wires up the subscription discovery handshake
 * and exposes a typed `onDescriptorAdded` / `onDescriptorRemoved` hook
 * callers register. The first-class consumer is the validator-agent
 * service under deploy/validator/, which subscribes to its owner's
 * context-graphs container and publishes findings on each new write.
 */

import { WebSocket } from 'ws';

export interface NotificationEvent {
  type: 'Add' | 'Remove' | 'Update';
  target: string;        // container URL where the event occurred
  object: string;        // resource URL of the added/removed/updated item
  published: string;     // RFC 3339 timestamp
  raw: unknown;          // underlying Activity Streams 2.0 payload
}

export type NotificationHandler = (ev: NotificationEvent) => void | Promise<void>;

export interface SubscriptionOptions {
  /** The pod container URL to subscribe to (e.g. `https://pod.example.com/markj/context-graphs/`). */
  target: string;
  /** Bearer token authenticating the subscriber against the pod. */
  bearerToken?: string;
  /** Optional pod-specific fetch (for proxied-internal hosts etc.). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Channel type to negotiate. Defaults to WebSocketChannel2023. */
  channelType?: 'WebSocketChannel2023' | 'WebhookChannel2023';
  /** For webhook channels: the public URL the pod should POST events to. */
  webhookSendTo?: string;
  /** Reconnect backoff ceiling in ms. Default 60_000. */
  maxBackoffMs?: number;
}

interface StorageDescription {
  notificationChannel?: Array<{
    type: string;
    endpoint?: string;
    features?: string[];
  }>;
}

interface NegotiatedChannel {
  id: string;
  type: string;
  receiveFrom?: string;
  sendTo?: string;
}

/**
 * Discover the pod's Notifications Storage Description and return the
 * endpoint for the requested channel type.
 *
 * Per spec §4.1, the storage description is advertised via the
 * `Link: <storage-description-url>; rel="http://www.w3.org/ns/solid/terms#storageDescription"`
 * header on any resource in the storage.
 */
export async function discoverNotificationEndpoint(
  target: string,
  channelType: string,
  fetchFn: typeof fetch,
  bearerToken?: string,
): Promise<string | null> {
  const headers: Record<string, string> = { Accept: 'text/turtle, application/ld+json' };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

  const headResp = await fetchFn(target, { method: 'HEAD', headers }).catch(() => null);
  if (!headResp) return null;

  const linkHeader = headResp.headers.get('link') ?? '';
  const match = linkHeader.match(/<([^>]+)>;\s*rel="http:\/\/www\.w3\.org\/ns\/solid\/terms#storageDescription"/);
  if (!match) return null;

  const storageDescUrl = new URL(match[1]!, target).toString();
  const descResp = await fetchFn(storageDescUrl, { headers }).catch(() => null);
  if (!descResp || !descResp.ok) return null;

  const desc = (await descResp.json().catch(() => null)) as StorageDescription | null;
  if (!desc?.notificationChannel) return null;

  const channel = desc.notificationChannel.find(c => c.type === channelType || c.type.endsWith(`#${channelType}`));
  return channel?.endpoint ?? null;
}

/**
 * POST to the pod's subscription endpoint to negotiate a concrete
 * notification channel. Spec §5.
 */
async function subscribe(
  subscriptionEndpoint: string,
  target: string,
  channelType: string,
  fetchFn: typeof fetch,
  bearerToken?: string,
  webhookSendTo?: string,
): Promise<NegotiatedChannel | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/ld+json' };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

  const body: Record<string, unknown> = {
    '@context': 'https://www.w3.org/ns/solid/notification/v1',
    type: channelType,
    topic: target,
  };
  if (webhookSendTo) body.sendTo = webhookSendTo;

  const resp = await fetchFn(subscriptionEndpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!resp || !resp.ok) return null;

  const json = (await resp.json().catch(() => null)) as NegotiatedChannel | null;
  return json;
}

/**
 * Subscribe to a pod container and invoke the handler on each event.
 * Returns an unsubscribe function.
 *
 * For WebSocketChannel2023, the client opens a WS connection to the
 * negotiated `receiveFrom` URL and parses each inbound AS2.0 message
 * into a NotificationEvent.
 *
 * For WebhookChannel2023, this function only performs the handshake
 * — the caller's own HTTP server is expected to receive POSTs at
 * `webhookSendTo` and forward them into the handler (e.g. via an
 * in-process event bus). A webhook dispatcher is out of scope for
 * this skeleton.
 */
export async function subscribeToContainer(
  opts: SubscriptionOptions,
  handler: NotificationHandler,
): Promise<{ unsubscribe: () => void; channel: NegotiatedChannel | null }> {
  const fetchFn = opts.fetch ?? fetch;
  const channelType = opts.channelType ?? 'WebSocketChannel2023';
  const backoffCeiling = opts.maxBackoffMs ?? 60_000;

  const subscriptionEndpoint = await discoverNotificationEndpoint(
    opts.target,
    channelType,
    fetchFn,
    opts.bearerToken,
  );
  if (!subscriptionEndpoint) {
    return { unsubscribe: () => {}, channel: null };
  }

  let channel = await subscribe(
    subscriptionEndpoint,
    opts.target,
    channelType,
    fetchFn,
    opts.bearerToken,
    opts.webhookSendTo,
  );
  if (!channel) return { unsubscribe: () => {}, channel: null };

  let stopped = false;
  let ws: WebSocket | null = null;
  let backoff = 1_000;

  const connect = () => {
    if (stopped || channelType !== 'WebSocketChannel2023') return;
    if (!channel?.receiveFrom) return;

    ws = new WebSocket(channel.receiveFrom);
    ws.on('open', () => { backoff = 1_000; });
    ws.on('message', async (raw) => {
      try {
        const activity = JSON.parse(raw.toString()) as Record<string, unknown>;
        const typeField = activity['type'];
        const activityType = Array.isArray(typeField) ? typeField[0] : typeField;
        if (activityType !== 'Add' && activityType !== 'Remove' && activityType !== 'Update') return;

        const target = activity['target'] as { id?: string } | string | undefined;
        const object = activity['object'] as { id?: string } | string | undefined;
        const targetUrl = typeof target === 'string' ? target : target?.id ?? '';
        const objectUrl = typeof object === 'string' ? object : object?.id ?? '';

        await handler({
          type: activityType as NotificationEvent['type'],
          target: targetUrl,
          object: objectUrl,
          published: (activity['published'] as string | undefined) ?? new Date().toISOString(),
          raw: activity,
        });
      } catch { /* malformed; skip */ }
    });
    ws.on('close', () => {
      if (stopped) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, backoffCeiling);
    });
    ws.on('error', () => { /* handled by close */ });
  };

  connect();

  return {
    unsubscribe: () => { stopped = true; ws?.close(); },
    channel,
  };
}
