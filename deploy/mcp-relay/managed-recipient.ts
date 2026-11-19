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

// ── A pod's inbox key ──────────────────────────────────────────────────────────────────────
//
// ★ A NOTIFICATION IS SEALED TO THE POD IT IS DELIVERED TO, NOT TO THE RELAY'S ONE KEY. The first
// version of sealed notifications wrapped every envelope to the fleet key and let the URL an
// envelope was fetched from decide who it was opened for. An envelope does not know where it is
// stored, so an authenticated user could copy somebody else's sealed notification into their own
// inbox and ask the relay to read it back: the fetched URL was then in their own pod, the fleet
// key opened it, and they were shown the summary and body. Found in review of #976.
//
// So each pod has its own key, derived from the relay's root and the pod's name. An envelope
// sealed for one pod does not open with another pod's key wherever it is copied to, because the
// content key was never wrapped to that key. The fleet key is never a recipient of a notification.

/** The pod a store URL is in — its first path segment — or null when it names none. */
export function storePodName(url: string | undefined, origins: ReadonlySet<string>): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!origins.has(parsed.origin) || parsed.username || parsed.password || /%2f|%5c/i.test(parsed.pathname)) return null;
    const first = parsed.pathname.split('/').filter(Boolean)[0];
    return first && !/\s/.test(first) ? decodeURIComponent(first) : null;
  } catch { return null; }
}

/** The key notifications delivered to pod `podName` are sealed to. Stable across restarts. */
export function inboxRecipientKey(root: EncryptionKeyPair, podName: string): EncryptionKeyPair {
  if (!podName) throw new Error('an inbox key needs a pod');
  return deriveEncryptionKeyPair(
    Buffer.from(root.secretKey, 'base64').toString('hex'),
    `urn:interego:relay-inbox:v1:${podName}`,
  );
}

export interface InboxKeyContext {
  readonly root: EncryptionKeyPair;
  /** The pod the authenticated caller owns, from verified session identity only. */
  readonly ownPodUrl?: string;
  readonly storeOrigins: ReadonlySet<string>;
}

/**
 * Open a sealed notification for the caller, or answer null.
 *
 * Opened only with the key of the caller's OWN pod, and only when the envelope was fetched from
 * that pod's inbox. The first condition is the cryptographic one: a copy of another pod's
 * envelope does not open, wherever it sits. The second keeps this from being a general oracle
 * for anything in the caller's pod that happens to be wrapped to its inbox key.
 */
export function openInboxEnvelope(context: InboxKeyContext, envelope: EncryptedEnvelope, fetchedUrl: string): string | null {
  const own = storePodName(context.ownPodUrl, context.storeOrigins);
  if (!own || storePodName(fetchedUrl, context.storeOrigins) !== own) return null;
  let segments: string[];
  try { segments = new URL(fetchedUrl).pathname.split('/').filter(Boolean); } catch { return null; }
  if (segments.length !== 3 || segments[1] !== 'inbox') return null;
  return openEncryptedEnvelope(envelope, inboxRecipientKey(context.root, own));
}
