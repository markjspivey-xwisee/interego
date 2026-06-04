/**
 * @module solid/sharing
 * @description Cross-pod recipient resolution for selective E2EE sharing.
 *
 * Given a handle that names another person (DID, WebID URL, or `acct:`
 * WebFinger identifier), resolve to their pod, read their agent registry,
 * and return the X25519 encryption public keys of their non-revoked
 * authorized agents. Callers union this with their own recipient set to
 * encrypt a specific graph for a specific other person's agents.
 *
 * No pod-level ACL change is required: the sharing is purely cryptographic
 * (their keys become recipients on the envelope). Their pod just needs to
 * be HTTP-fetchable for the agent-registry read.
 */
import type { FetchFn } from './types.js';
import { resolveDidWeb, findStorageEndpoint } from './did.js';
import { resolveWebFinger } from './webfinger.js';
import { readAgentRegistry } from './client.js';

/**
 * Handle shape:
 *   - did:web:host:users:name    → DID Core resolution
 *   - did:key:z...               → unsupported as sharing target (no pod linkage)
 *   - https://host/users/name/profile#me  → WebID URL (fetch profile, find pod)
 *   - acct:name@host             → WebFinger RFC 7033
 *   - https://host/name/         → direct pod URL (fast path)
 */
export type ShareHandle = string;

export interface ResolvedRecipientPod {
  readonly handle: ShareHandle;
  readonly podUrl: string;
  readonly webId?: string;
  /** Base64 X25519 public keys of non-revoked agents on that pod. */
  readonly agentEncryptionKeys: readonly string[];
  /** Their agent IDs (for descriptor metadata / provenance). */
  readonly agentIds: readonly string[];
}

export interface ResolveRecipientsOptions {
  readonly fetch?: FetchFn;
}

/**
 * Resolve a share handle to its pod URL.
 *
 * Accepts DIDs, WebIDs, `acct:` handles, and direct pod URLs. Returns
 * `null` when the handle can't be turned into a pod we can read.
 */
export async function resolveHandleToPodUrl(
  handle: ShareHandle,
  options: ResolveRecipientsOptions = {},
): Promise<{ podUrl: string; webId?: string } | null> {
  // Direct pod URL — ends in `/`, looks like https://host/name/
  if (handle.match(/^https?:\/\/[^/]+\/[^/]+\/$/)) {
    return { podUrl: handle };
  }

  // WebFinger form: acct:user@host
  if (handle.startsWith('acct:')) {
    const wf = await resolveWebFinger(handle, options);
    if (wf.podUrl) {
      const result: { podUrl: string; webId?: string } = { podUrl: wf.podUrl };
      if (wf.webId) result.webId = wf.webId;
      return result;
    }
    return null;
  }

  // WebID URL: https://host/users/<id>/profile[#me]
  if (handle.startsWith('http://') || handle.startsWith('https://')) {
    // Extract user slug + host; if path matches /users/<id>/profile... try
    // WebFinger against acct:<id>@<host> to find the storage endpoint.
    try {
      const url = new URL(handle.split('#')[0]!);
      const match = url.pathname.match(/^\/users\/([^/]+)\/profile/);
      if (match) {
        const acct = `acct:${match[1]}@${url.host}`;
        const wf = await resolveWebFinger(acct, options);
        if (wf.podUrl) {
          const result: { podUrl: string; webId?: string } = { podUrl: wf.podUrl, webId: handle };
          return result;
        }
      }
    } catch { /* fall through to DID attempt */ }
    return null;
  }

  // DID form: did:web:host:users:name — resolve document, pull storage endpoint
  if (handle.startsWith('did:web:')) {
    const res = await resolveDidWeb(handle, options);
    if (!res.didDocument) return null;
    const pod = findStorageEndpoint(res.didDocument);
    if (pod) {
      const result: { podUrl: string; webId?: string } = { podUrl: pod };
      const webId = res.didDocument.alsoKnownAs?.find((u: string) => u.includes('/profile'));
      if (webId) result.webId = webId;
      return result;
    }
    return null;
  }

  return null;
}

/**
 * Resolve a single share handle all the way to their agents' encryption
 * public keys. Returns `null` when the handle can't be resolved, the pod
 * has no agent registry, or no agents there have encryption keys.
 */
export async function resolveRecipient(
  handle: ShareHandle,
  options: ResolveRecipientsOptions = {},
): Promise<ResolvedRecipientPod | null> {
  const pod = await resolveHandleToPodUrl(handle, options);
  if (!pod) return null;

  const profile = await readAgentRegistry(pod.podUrl, options);
  if (!profile) {
    const empty: ResolvedRecipientPod = {
      handle,
      podUrl: pod.podUrl,
      agentEncryptionKeys: [],
      agentIds: [],
    };
    if (pod.webId) (empty as { webId?: string }).webId = pod.webId;
    return empty;
  }

  const active = profile.authorizedAgents.filter(a => !a.revoked && a.encryptionPublicKey);

  // Pubkey rollover (closes Sec #12): include both current pubkey AND
  // any recently-retired pubkeys from each agent's encryptionKeyHistory
  // that fall inside the rollover window. The recipient can still
  // decrypt with the corresponding old private key (which they kept
  // locally for the same window), so envelopes wrapped during the
  // window are recoverable even after the agent rotated keys.
  //
  // 30 days = a generous window for "publishers see my key, I rotate,
  // publishers eventually refetch and start using the new key" to
  // complete without orphaning in-flight envelopes. Bounded so a
  // rotated-after-compromise key doesn't stay wrappable forever.
  const ROLLOVER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - ROLLOVER_WINDOW_MS;
  const keys: string[] = [];
  const ids: string[] = [];
  for (const a of active) {
    keys.push(a.encryptionPublicKey!);
    ids.push(a.agentId);
    if (a.encryptionKeyHistory && a.encryptionKeyHistory.length > 0) {
      for (const h of a.encryptionKeyHistory) {
        // Defensive: skip malformed entries; skip ones outside the window
        const retiredMs = new Date(h.retiredAt).getTime();
        if (!Number.isFinite(retiredMs)) continue;
        if (retiredMs < cutoff) continue;
        if (typeof h.publicKey !== 'string' || h.publicKey.length === 0) continue;
        if (keys.includes(h.publicKey)) continue;
        keys.push(h.publicKey);
        ids.push(`${a.agentId}#retired-${h.retiredAt.slice(0, 10)}`);
      }
    }
  }
  const result: ResolvedRecipientPod = {
    handle,
    podUrl: pod.podUrl,
    agentEncryptionKeys: keys,
    agentIds: ids,
  };
  if (pod.webId) (result as { webId?: string }).webId = pod.webId;
  if (!pod.webId && profile.webId) (result as { webId?: string }).webId = profile.webId;
  return result;
}

/**
 * Resolve a batch of share handles in parallel. Failed resolutions are
 * returned as entries with empty `agentEncryptionKeys` so callers can
 * surface which handles didn't produce recipients (without aborting the
 * whole publish).
 */
export async function resolveRecipients(
  handles: readonly ShareHandle[],
  options: ResolveRecipientsOptions = {},
): Promise<readonly ResolvedRecipientPod[]> {
  const results = await Promise.all(
    handles.map(async (h): Promise<ResolvedRecipientPod> => {
      const r = await resolveRecipient(h, options);
      return r ?? { handle: h, podUrl: '', agentEncryptionKeys: [], agentIds: [] };
    }),
  );
  return results;
}
