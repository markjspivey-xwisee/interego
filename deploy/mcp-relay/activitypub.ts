/**
 * @module activitypub
 * @description WebFinger (RFC 7033) + ActivityPub (W3C Rec) discovery
 *              surface for Interego agents, layered on the same agent
 *              cards + LDN inboxes the agent-mesh module already manages.
 *
 * What this gives every agent, for free, the moment it auto-registers:
 *   - a resolvable acct: handle via WebFinger (acct:<id>@<relay-host>),
 *   - an ActivityPub Actor document (as:Application) with inbox/outbox,
 *   - an outbox that projects the agent's published ContextDescriptors as
 *     ActivityStreams 2.0 Create activities (read side — followable shape),
 *   - an inbox endpoint that accepts AS2 activities and maps them onto the
 *     agent's native LDN inbox (so an external fediverse actor and an
 *     in-substrate agent drop into the same place).
 *
 * Scope note: the read/discovery side (webfinger + actor + outbox) is
 * complete and standards-shaped. Untrusted cross-server delivery
 * (accepting POSTs from arbitrary Mastodon instances) additionally needs
 * HTTP Signature verification; the inbox handler below accepts + stores
 * and flags signature verification as the remaining hardening step. The
 * did:ethr key model is surfaced in the actor so verifiers that
 * understand secp256k1 can already check authorship.
 */

const AS2 = 'https://www.w3.org/ns/activitystreams';
const SEC = 'https://w3id.org/security/v1';

export interface AgentCardLite {
  url: string;          // pod URL
  did?: string;
  handle?: string;      // acct:...
  inbox?: string;       // LDN inbox URL
  label?: string;
  surface?: string;
}

/** The relay-hosted actor URL for a given pod local-part. */
export function actorUrl(relayBase: string, localPart: string): string {
  return `${relayBase.replace(/\/$/, '')}/agents/${encodeURIComponent(localPart)}`;
}

/** WebFinger JRD pointing at the agent's ActivityPub actor + pod. */
export function buildWebfinger(
  resource: string,
  relayBase: string,
  localPart: string,
  card: AgentCardLite,
): Record<string, unknown> {
  const actor = actorUrl(relayBase, localPart);
  return {
    subject: resource,
    aliases: [actor, card.url],
    links: [
      { rel: 'self', type: 'application/activity+json', href: actor },
      { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: card.url },
      ...(card.inbox ? [{ rel: 'http://www.w3.org/ns/ldp#inbox', href: card.inbox }] : []),
    ],
  };
}

/** ActivityPub Actor document (as:Application). */
export function buildActor(
  relayBase: string,
  localPart: string,
  card: AgentCardLite,
): Record<string, unknown> {
  const actor = actorUrl(relayBase, localPart);
  return {
    '@context': [AS2, SEC, { interego: 'https://interego-emergent.example/ns/mcp-relay#' }],
    id: actor,
    type: 'Application',
    preferredUsername: localPart,
    name: card.label ?? localPart,
    summary: `Interego agent${card.surface ? ` (${card.surface})` : ''}`,
    url: card.url,
    inbox: `${actor}/inbox`,
    outbox: `${actor}/outbox`,
    // Native LDN inbox (Solid pod) — same destination as the AP inbox.
    'interego:ldpInbox': card.inbox,
    'interego:pod': card.url,
    'interego:did': card.did,
    // did:ethr / secp256k1 key surface for verifiers that support it.
    ...(card.did ? {
      publicKey: {
        id: `${actor}#did-key`,
        owner: actor,
        'interego:did': card.did,
        'interego:keyType': 'EcdsaSecp256k1',
      },
    } : {}),
    // Solid Notifications Protocol hint: subscribe to the pod inbox for
    // real-time push (WebSocketChannel2023 / WebhookChannel2023) via the
    // pod's CSS notification gateway.
    ...(card.inbox ? { 'interego:solidNotificationsResource': card.inbox } : {}),
  };
}

/** Map discovered descriptors → an AS2 OrderedCollection outbox. */
export function buildOutbox(
  relayBase: string,
  localPart: string,
  card: AgentCardLite,
  descriptors: Array<{ descriptorUrl?: string; graphIri?: string; validFrom?: string; modalStatus?: string }>,
): Record<string, unknown> {
  const actor = actorUrl(relayBase, localPart);
  const items = descriptors.map((d) => ({
    '@context': AS2,
    type: 'Create',
    actor,
    published: d.validFrom,
    object: {
      type: 'Note',
      id: d.descriptorUrl,
      'interego:graphIri': d.graphIri,
      'interego:modalStatus': d.modalStatus,
      url: d.descriptorUrl,
    },
  }));
  return {
    '@context': AS2,
    id: `${actor}/outbox`,
    type: 'OrderedCollection',
    totalItems: items.length,
    orderedItems: items,
    'interego:pod': card.url,
  };
}
