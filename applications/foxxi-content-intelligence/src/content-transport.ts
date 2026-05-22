/**
 * Foxxi channel transport — actually delivering rendered content.
 *
 * `content-channels.ts` renders a unit of content for a channel;
 * `content-delivery.ts` records the delivery in the LRS. This module is
 * the last step: it makes the content genuinely *leave the bridge*.
 *
 * Two transports, both real:
 *
 *   · **pod-descriptor** — the Interego-native delivery. The rendered
 *     content is published to the pod as a `foxxi:DeliveredContent`
 *     Context Descriptor: discoverable, federatable, provenance-bearing,
 *     and itself answerable by the Context Companion's pass-through. A
 *     delivery is not a fire-and-forget send — it becomes substrate.
 *
 *   · **webhook** — a real HTTP POST to a configured per-channel
 *     endpoint: a Slack incoming webhook for `chat`, an email- or SMS-
 *     provider HTTP API for `email` / `sms`. Activates when
 *     `FOXXI_TRANSPORT_<CHANNEL>` is set, exactly like the bridge's
 *     other configure-to-activate integrations.
 *
 * When neither is configured for a channel the rendering is still
 * produced and the delivery still recorded — it just hasn't left the
 * bridge, and the result says so honestly.
 *
 * Layer: L3 vertical. Composes the substrate's `publish()` + `fetch`;
 * no L1/L2/L3 ontology change.
 */

import type { ContextDescriptorData, IRI } from '@interego/core';
import type { ChannelRendering, DeliveryChannel } from './content-channels.js';

export interface ChannelWebhook {
  /** The endpoint to POST the rendered payload to. */
  url: string;
  /** Optional Authorization header value (e.g. "Bearer …" / "Basic …"). */
  authHeader?: string;
}

export interface TransportConfig {
  selfBaseUrl: string;
  /** The authoritative source — recorded as the delivery's provenance. */
  authoritativeSource: string;
  /** Per-channel outbound webhooks. When set for a channel, a real POST. */
  webhooks?: Partial<Record<DeliveryChannel, ChannelWebhook>>;
  /** Pod to publish the Interego-native delivery to. When set, a delivery
   *  with no channel webhook is published as a Context Descriptor. */
  podUrl?: string;
  /** Fetch override (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
}

export interface TransportResult {
  /** How the content left the bridge. 'none' = produced + recorded only. */
  mode: 'pod-descriptor' | 'webhook' | 'none';
  /** True iff the content genuinely left the bridge. */
  sent: boolean;
  detail: string;
  /** A dereferenceable artifact the delivery produced (the published
   *  descriptor, or the webhook endpoint). */
  artifactUrl?: string;
}

/**
 * Deliver a rendered unit through its channel. Tries a configured
 * webhook first; failing that, the Interego-native pod-descriptor
 * publish; failing that, an honest no-op (recorded, not sent).
 */
export async function deliverThroughChannel(args: {
  channel: DeliveryChannel;
  rendering: ChannelRendering;
  title: string;
  recipient?: string;
  config: TransportConfig;
}): Promise<TransportResult> {
  const { channel, rendering, config } = args;
  const fetchFn = config.fetch ?? globalThis.fetch;

  // 1. A configured webhook — a real HTTP send (Slack / email / SMS API).
  const hook = config.webhooks?.[channel];
  if (hook?.url) {
    const payload = channel === 'chat'
      ? { text: rendering.body } // Slack incoming-webhook shape
      : {
          channel,
          ...(rendering.subject ? { subject: rendering.subject } : {}),
          body: rendering.body,
          ...(args.recipient ? { recipient: args.recipient } : {}),
        };
    try {
      const res = await fetchFn(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(hook.authHeader ? { Authorization: hook.authHeader } : {}),
        },
        body: JSON.stringify(payload),
      });
      return {
        mode: 'webhook',
        sent: res.ok,
        artifactUrl: hook.url,
        detail: res.ok
          ? `delivered to the ${channel} webhook (HTTP ${res.status})`
          : `the ${channel} webhook returned HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        mode: 'webhook', sent: false, artifactUrl: hook.url,
        detail: `the ${channel} webhook send failed: ${(err as Error).message}`,
      };
    }
  }

  // 2. The `document` channel with a pod configured — the Interego-
  //    native delivery: publish the content as a discoverable Context
  //    Descriptor. (A document's natural form is a published artifact;
  //    chat / email / sms want their own webhook to genuinely send.)
  if (channel === 'document' && config.podUrl) {
    try {
      const url = await publishDeliveredContent(args.title, channel, rendering, args.recipient, config, fetchFn);
      return {
        mode: 'pod-descriptor', sent: true, artifactUrl: url,
        detail: 'published as a Context Descriptor on the pod — discoverable, '
          + 'federatable, and itself answerable by the Context Companion',
      };
    } catch (err) {
      return { mode: 'none', sent: false, detail: `pod publish failed: ${(err as Error).message}` };
    }
  }

  // 3. Nothing configured — the rendering is produced and the delivery
  //    recorded in the LRS; it just hasn't left the bridge.
  return {
    mode: 'none', sent: false,
    detail: `no transport configured for the ${channel} channel — the rendering is produced `
      + `and the delivery recorded; set FOXXI_TRANSPORT_${channel.toUpperCase()} (a webhook URL) `
      + `or a pod to actually send it`,
  };
}

function xmlStr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Publish a rendered delivery as a `foxxi:DeliveredContent` Context
 * Descriptor on the pod — the Interego-native transport. The graph
 * carries the body (base64, the same escape-proof trick the tenant
 * publisher uses), the channel, the recipient, and provenance.
 */
async function publishDeliveredContent(
  title: string,
  channel: DeliveryChannel,
  rendering: ChannelRendering,
  recipient: string | undefined,
  config: TransportConfig,
  fetchFn: typeof globalThis.fetch,
): Promise<string> {
  const ns = `${config.selfBaseUrl.replace(/\/+$/, '')}/ns/foxxi#`;
  const id = `delivered-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const graphIri = `urn:foxxi:delivered:${id}` as IRI;
  const typeIri = `${ns}DeliveredContent` as IRI;
  const now = new Date().toISOString();
  const b64 = Buffer.from(rendering.body, 'utf8').toString('base64');
  const graph = `<${graphIri}> a <${typeIri}> ;
    <http://purl.org/dc/terms/title> "${xmlStr(title)}" ;
    <http://purl.org/dc/terms/created> "${now}"^^<http://www.w3.org/2001/XMLSchema#dateTime> ;
    <http://purl.org/dc/terms/format> "${rendering.mediaType}" ;
    <http://www.w3.org/ns/prov#wasAttributedTo> <${config.authoritativeSource}> ;
    <${ns}deliveryChannel> "${channel}" ;
    <${ns}contentForm> "${rendering.form}" ;
${recipient ? `    <${ns}recipient> "${xmlStr(recipient)}" ;\n` : ''}    <${ns}deliveredBody> "${b64}"^^<http://www.w3.org/2001/XMLSchema#base64Binary> .
`;
  const descriptor: ContextDescriptorData = {
    id: `${graphIri}#descriptor` as IRI,
    describes: [graphIri],
    conformsTo: [typeIri],
    facets: [
      { type: 'Temporal', validFrom: now },
      { type: 'Provenance', wasAttributedTo: config.authoritativeSource as IRI },
      { type: 'Semiotic', modalStatus: 'Asserted' },
    ],
  };
  // Lazy import — the substrate's publish() is only pulled in when a
  // delivery is actually published to a pod, so the transport module
  // (webhook + none paths) loads without resolving @interego/core.
  const { publish } = await import('@interego/core');
  const result = await publish(descriptor, graph, config.podUrl!, {
    fetch: fetchFn as never,
    containerPath: 'foxxi/delivered/',
    descriptorSlug: id,
    graphSlug: `${id}-graph`,
  });
  return result.descriptorUrl;
}
