/**
 * Recipient-specific keys for relay-managed sharing. These remain server-held
 * keys, not client-held E2EE. A foreign reader NEVER receives the legacy fleet
 * key: its own key must have a real wrapped content key in the envelope.
 *
 * Derivation is stable across restarts from the existing persisted root. It
 * does not rotate identities or overwrite externally supplied registry keys.
 * Old envelopes keep the existing own-pod-only decryption rule.
 */
import { deriveEncryptionKeyPair, openEncryptedEnvelope, type EncryptedEnvelope, type EncryptionKeyPair } from '@interego/core';
import { canonicalSessionActorId } from './session-actor.js';
import { mayUseRelayKey } from './relay-key-gate.js';

export function managedRecipientKey(
  root: EncryptionKeyPair, actor: string, identityUrl: string,
): EncryptionKeyPair {
  const principal = canonicalSessionActorId(actor, identityUrl);
  if (!principal) throw new Error('managed recipient requires an authenticated actor');
  return deriveEncryptionKeyPair(
    Buffer.from(root.secretKey, 'base64').toString('hex'),
    `urn:interego:relay-managed-recipient:v1:${principal}`,
  );
}

export interface ManagedKeyContext {
  readonly root: EncryptionKeyPair;
  /** Reserved, verified session identity only; never the agent_id argument. */
  readonly sessionActor?: string;
  readonly ownPodUrl?: string;
  readonly identityUrl: string;
  readonly storeOrigins: ReadonlySet<string>;
}

function storeResource(url: string, origins: ReadonlySet<string>): boolean {
  try {
    const parsed = new URL(url);
    return origins.has(parsed.origin) && !parsed.username && !parsed.password
      && !/%2f|%5c/i.test(parsed.pathname) && /^\/[^/]+\/.+/.test(parsed.pathname);
  } catch { return false; }
}

export function recipientKeyForResource(
  context: ManagedKeyContext, targetUrl: string,
): EncryptionKeyPair | undefined {
  const { root, ownPodUrl, storeOrigins, sessionActor, identityUrl } = context;
  if (!ownPodUrl) return undefined;
  if (mayUseRelayKey({ targetUrl, ownPodUrl, storeOrigins })) return root;
  // Validate the session-derived pod too; a bare store origin is not an owner.
  if (!mayUseRelayKey({ targetUrl: `${ownPodUrl.replace(/\/$/, '')}/agents`, ownPodUrl, storeOrigins })) return undefined;
  if (!sessionActor || !storeResource(targetUrl, storeOrigins)) return undefined;
  try { return managedRecipientKey(root, sessionActor, identityUrl); } catch { return undefined; }
}

export interface AgentKeyBinding { readonly agentId: string; readonly publicKey: string }

/** Add distinct wraps only for agents using this relay's legacy managed key. */
export function managedRecipientPublicKeys(
  root: EncryptionKeyPair, bindings: readonly AgentKeyBinding[], identityUrl: string,
): string[] {
  const result = new Set<string>();
  for (const binding of bindings) {
    if (binding.publicKey !== root.publicKey) continue;
    result.add(managedRecipientKey(root, binding.agentId, identityUrl).publicKey);
  }
  return [...result];
}

/** The envelope itself authenticates recipient membership; metadata cannot grant it. */
export function openManagedEnvelope(
  context: ManagedKeyContext, envelope: EncryptedEnvelope, fetchedUrl: string,
): string | null {
  const permitted = recipientKeyForResource(context, fetchedUrl);
  if (!permitted) return null;
  if (context.sessionActor) {
    const current = managedRecipientKey(context.root, context.sessionActor, context.identityUrl);
    const plaintext = openEncryptedEnvelope(envelope, current);
    if (plaintext !== null) return plaintext;
  }
  // This can be the fleet key ONLY on the authenticated caller's own pod.
  return openEncryptedEnvelope(envelope, permitted);
}
