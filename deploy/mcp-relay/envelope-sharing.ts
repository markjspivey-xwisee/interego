/**
 * Detached recipient wraps extend access to immutable encrypted artifacts.
 * The content key is rewrapped, never returned. The original ciphertext,
 * descriptor, content commitments and version history remain byte-identical.
 */
import { createHash } from 'node:crypto';
import {
  canonicalJson, decryptContent, unwrapKey, wrapKeyForRecipient,
  type EncryptedEnvelope, type WrappedKey,
} from '@interego/core';
import { managedRecipientKey, recipientKeyForResource, type ManagedKeyContext } from './managed-recipient.js';
import { mayUseRelayKey } from './relay-key-gate.js';
import { canonicalSessionActorId } from './session-actor.js';

export const ENVELOPE_SHARING_IRI = 'urn:interego:envelope-sharing:v1';
export const SHARE_ENVELOPE_ACTION = 'urn:interego:action:share-encrypted-envelope';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sourceIdentity = (url: string) => { const u = new URL(url); return u.pathname + u.search; };

export interface RecipientGrant {
  readonly schema: 'interego.envelope-recipient/v1';
  readonly source: string;
  readonly envelopeDigest: string;
  readonly recipient: string;
  readonly recipientPublicKey: string;
  readonly wrappedKey: WrappedKey;
  readonly grantedBy: string;
  readonly createdAt: string;
}

/** Same store spelling and container as the envelope; no caller-chosen write URL. */
export function recipientGrantUrl(context: ManagedKeyContext, sourceUrl: string, publicKey: string): string | null {
  if (!recipientKeyForResource(context, sourceUrl)) return null;
  const source = new URL(sourceUrl);
  const directory = source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1);
  return `${source.origin}${directory}${digest(sourceIdentity(sourceUrl))}-recipient-${digest(publicKey)}.json`;
}

/** Requires the authenticated owner to be able to open the exact source envelope. */
export function createRecipientGrant(
  context: ManagedKeyContext, sourceUrl: string, envelope: EncryptedEnvelope,
  recipient: string, recipientPublicKey: string, createdAt: string,
): RecipientGrant {
  if (!context.sessionActor || !context.ownPodUrl || !mayUseRelayKey({
    targetUrl: sourceUrl, ownPodUrl: context.ownPodUrl, storeOrigins: context.storeOrigins,
  })) throw new Error('only the authenticated source-pod owner can grant a recipient wrap');
  const ownerKeys = [managedRecipientKey(context.root, context.sessionActor, context.identityUrl), context.root];
  for (const ownerKey of ownerKeys) {
    const wrapped = envelope.wrappedKeys.find(key => key.recipientPublicKey === ownerKey.publicKey);
    if (!wrapped) continue;
    const contentKey = unwrapKey(wrapped, ownerKey.secretKey);
    if (!contentKey || decryptContent(envelope.content, contentKey) === null) continue;
    const principal = canonicalSessionActorId(recipient, context.identityUrl);
    if (!principal) throw new Error('recipient identity is required');
    return {
      schema: 'interego.envelope-recipient/v1', source: sourceIdentity(sourceUrl),
      envelopeDigest: digest(canonicalJson(envelope)), recipient: principal,
      recipientPublicKey, wrappedKey: wrapKeyForRecipient(contentKey, recipientPublicKey, context.root),
      grantedBy: canonicalSessionActorId(context.sessionActor, context.identityUrl)!, createdAt,
    };
  }
  throw new Error('the authenticated owner cannot open this source envelope');
}

/** Opens the ORIGINAL ciphertext with a key wrap addressed to the actual reader. */
export function openRecipientGrant(
  context: ManagedKeyContext, sourceUrl: string, envelope: EncryptedEnvelope, grant: RecipientGrant,
): string | null {
  try {
    if (!context.sessionActor || !recipientKeyForResource(context, sourceUrl)) return null;
    const principal = canonicalSessionActorId(context.sessionActor, context.identityUrl);
    const key = managedRecipientKey(context.root, context.sessionActor, context.identityUrl);
    if (grant.schema !== 'interego.envelope-recipient/v1' || grant.recipient !== principal
      || grant.source !== sourceIdentity(sourceUrl) || grant.envelopeDigest !== digest(canonicalJson(envelope))
      || grant.recipientPublicKey !== key.publicKey || grant.wrappedKey.recipientPublicKey !== key.publicKey) return null;
    const contentKey = unwrapKey(grant.wrappedKey, key.secretKey);
    return contentKey ? decryptContent(envelope.content, contentKey) : null;
  } catch { return null; }
}

/** A generic cryptographic affordance; no application-domain tool is installed. */
export function envelopeSharingResource() {
  return {
    iri: ENVELOPE_SHARING_IRI, status: 'ok',
    representation: 'Share an existing encrypted descriptor by adding a detached recipient key wrap. Requires source-pod ownership and an openable, content-bound signed descriptor. Original artifact bytes and manifest heads are unchanged.',
    affordances: [{
      action: SHARE_ENVELOPE_ACTION, target: ENVELOPE_SHARING_IRI, method: 'POST',
      inputs: {
        type: 'object', required: ['descriptor_url', 'share_with'], additionalProperties: false,
        properties: { descriptor_url: { type: 'string' }, share_with: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string' } } },
      },
    }],
  };
}
