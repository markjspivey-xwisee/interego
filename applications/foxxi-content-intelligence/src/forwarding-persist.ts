/**
 * Durable persistence for per-user (own-pod) forwarding config.
 *
 * The per-owner forwarding registry (lrs-forwarding.ts) is in-memory, so it
 * is lost on a bridge restart. This module writes each owner's config — their
 * outbound targets + inbound credentials, which CONTAIN SECRETS — as an
 * ENCRYPTED envelope to the owner's OWN pod, and reads + decrypts it back on
 * hydration. The envelope is wrapped to BOTH the bridge (so the bridge can
 * hydrate it on boot) AND the owner (so it is genuinely theirs — they can
 * read their own config off their pod). Secrets are never written in clear,
 * so the relay's sensitive-content screen sees only ciphertext.
 *
 * Reuses the substrate's multi-recipient envelope crypto (X25519-XSalsa20-
 * Poly1305) — no hand-rolled crypto (see [[feedback_compose_dont_reinvent]]).
 */

import {
  createEncryptedEnvelope, openEncryptedEnvelope, envelopeToJson, envelopeFromJson,
  type EncryptionKeyPair, type FetchFn,
} from '@interego/core';
import { resolveAgentEncryptionKey } from '@interego/solid';

/** Resource holding an owner's encrypted forwarding config, on their own pod. */
const CONFIG_RESOURCE = 'foxxi-forwarding-config.json';

export interface RawForwardingTarget {
  id: string; label: string; endpoint: string; credentials: string; version: string; enabled: boolean; createdAt: string;
}
export interface RawInboundCredential {
  id: string; principal: string; secret: string; tenant: string; label: string; createdAt: string;
}
export interface ForwardingConfigBlob {
  targets: RawForwardingTarget[];
  credentials: RawInboundCredential[];
  updatedAt: string;
}

function configUrl(ownerPod: string): string {
  return (ownerPod.endsWith('/') ? ownerPod : `${ownerPod}/`) + CONFIG_RESOURCE;
}

/**
 * Encrypt the owner's forwarding config to {bridge, owner} and PUT it to their
 * pod. The bridge keypair is always a recipient so a later boot can decrypt +
 * hydrate. Throws on a hard write failure (412 tolerated).
 */
export async function persistForwardingConfig(args: {
  ownerPod: string;
  blob: ForwardingConfigBlob;
  bridgeKp: EncryptionKeyPair;
  fetch?: FetchFn;
}): Promise<void> {
  const fetchFn = args.fetch ?? (globalThis.fetch as unknown as FetchFn);
  const recipients = [args.bridgeKp.publicKey];
  try {
    const ownerKey = await resolveAgentEncryptionKey(args.ownerPod, { fetch: fetchFn });
    if (ownerKey && ownerKey !== args.bridgeKp.publicKey) recipients.push(ownerKey);
  } catch { /* owner hasn't published a key — bridge-only recipient is fine */ }
  const envelope = createEncryptedEnvelope(JSON.stringify(args.blob), recipients, args.bridgeKp);
  const url = configUrl(args.ownerPod);
  const r = await fetchFn(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: envelopeToJson(envelope),
  });
  if (!r.ok && r.status !== 412) throw new Error(`forwarding-config PUT <${url}> -> ${r.status} ${r.statusText}`);
}

/** Fetch + decrypt an owner's forwarding config from their pod. null if absent / unreadable. */
export async function loadForwardingConfig(args: {
  ownerPod: string;
  bridgeKp: EncryptionKeyPair;
  fetch?: FetchFn;
}): Promise<ForwardingConfigBlob | null> {
  const fetchFn = args.fetch ?? (globalThis.fetch as unknown as FetchFn);
  try {
    const r = await fetchFn(configUrl(args.ownerPod), { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const env = envelopeFromJson(await r.text());
    const plain = openEncryptedEnvelope(env, args.bridgeKp);
    if (!plain) return null;
    const blob = JSON.parse(plain) as ForwardingConfigBlob;
    if (!blob || !Array.isArray(blob.targets) || !Array.isArray(blob.credentials)) return null;
    return blob;
  } catch { return null; }
}
