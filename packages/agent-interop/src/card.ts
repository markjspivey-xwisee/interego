/**
 * @module card
 * @description Project an agent's identity + published capabilities into whatever
 *              document shape a profile declares. Spec-blind.
 *
 * Nothing is stored: the card is a PROJECTION peer to the existing Turtle / MCP-tool
 * / ActivityPub-actor renderers, computed from the same source model. That is what
 * keeps a second interop format a data change rather than a schema migration.
 */

import { createHash } from 'node:crypto';
import type { AgentIdentity, Capability } from './types.js';
import type { InteropProfile } from './profile.js';

/** Deterministic content hash of a rendered card, used as both the agent `version`
 *  and the HTTP ETag: it changes exactly when the projected capability set changes.
 *  Key order is normalised so equivalent cards hash equally. */
export function cardVersion(doc: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortDeep(doc));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, val]) => val !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, sortDeep(val)]),
    );
  }
  return v;
}

/**
 * Render the card for `profile`, stamping a content-derived version.
 *
 * Two passes on purpose: render once WITHOUT a version to obtain a hash over the
 * substantive content, then re-render with it. Hashing the versioned document would
 * be self-referential, and hashing only part of it would let capability changes slip
 * past the ETag.
 */
export function renderCard(profile: InteropProfile, identity: AgentIdentity): {
  document: Record<string, unknown>;
  version: string;
  mediaType: string;
} {
  const provisional = profile.card.render({ ...identity, version: undefined as unknown as string });
  const version = cardVersion(provisional);
  const document = profile.card.render({ ...identity, version });
  return { document, version, mediaType: profile.card.mediaType };
}

/**
 * Project published affordances into engine Capabilities.
 *
 * The affordance's `action` URL becomes the capability id verbatim — it already
 * dereferences through the live action resolver, so the wire format's skill id is a
 * real URL that resolves to its own description rather than a minted opaque token.
 * Affordances without an action URL are DROPPED: an unfollowable capability
 * advertised on a card is a promise the substrate cannot keep.
 */
export function capabilitiesFromAffordances(
  affordances: ReadonlyArray<{
    action?: string;
    title?: string;
    label?: string;
    comment?: string;
    description?: string;
    vertical?: string;
    mediaType?: string;
    requiresAuth?: boolean;
  }>,
): Capability[] {
  const out: Capability[] = [];
  for (const a of affordances) {
    const id = a.action;
    if (!id || !/^https?:\/\//.test(id)) continue;
    out.push({
      id,
      name: a.title ?? a.label ?? id.split('/').pop() ?? 'capability',
      description: a.comment ?? a.description ?? '',
      ...(a.vertical ? { tags: [a.vertical] } : {}),
      ...(a.mediaType ? { outputMediaTypes: [a.mediaType] } : {}),
      ...(a.requiresAuth !== undefined ? { requiresAuth: a.requiresAuth } : {}),
    });
  }
  return out;
}
