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
import { resolveDidWeb, findStorageEndpoint, findKeyAgreementKey, type DidDocument } from './did.js';
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
 *
 * For `did:web:` handles the resolved DID document is included on the
 * result so callers (notably {@link resolveRecipient}) can fast-path
 * key-agreement extraction without re-fetching the document.
 */
export async function resolveHandleToPodUrl(
  handle: ShareHandle,
  options: ResolveRecipientsOptions = {},
): Promise<{ podUrl: string; webId?: string; didDocument?: DidDocument } | null> {
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
      const result: { podUrl: string; webId?: string; didDocument?: DidDocument } = {
        podUrl: pod,
        didDocument: res.didDocument,
      };
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

  // FIX 6 fast path — bare agent DIDs:
  //   `did:web:<host>:agents:<agentId>` resolves to a DID document
  //   carrying the agent's own X25519 key-agreement key. We can use it
  //   as the envelope recipient directly without round-tripping the
  //   owner pod's agent registry, which makes cross-pod sharing work
  //   even when the agent hasn't (yet) been mirrored into the owner's
  //   /agents resource.
  //
  // The registry walk is still preferred when present because it
  // surfaces rollover/retired keys (the rolling window below) and
  // honours revocation. We only short-circuit when the registry
  // returned nothing — that's the case the diagnosis is closing.
  const didKey = pod.didDocument ? findKeyAgreementKey(pod.didDocument) : null;
  const agentIdFromDid = pod.didDocument && handle.startsWith('did:web:')
    ? extractAgentIdFromDid(handle)
    : null;

  const profile = await readAgentRegistry(pod.podUrl, options);
  if (!profile) {
    if (didKey) {
      const fastPath: ResolvedRecipientPod = {
        handle,
        podUrl: pod.podUrl,
        agentEncryptionKeys: [didKey],
        agentIds: agentIdFromDid ? [agentIdFromDid] : [],
      };
      if (pod.webId) (fastPath as { webId?: string }).webId = pod.webId;
      return fastPath;
    }
    const empty: ResolvedRecipientPod = {
      handle,
      podUrl: pod.podUrl,
      agentEncryptionKeys: [],
      agentIds: [],
    };
    if (pod.webId) (empty as { webId?: string }).webId = pod.webId;
    return empty;
  }

  // If the handle was a bare agent DID (`did:web:…:agents:<agentId>`),
  // narrow the registry walk to that single agent — sharing with one
  // agent must not silently fan the envelope out to every other agent
  // on the owner's pod. When the registry has no entry for that agent
  // (the FIX-6 case), we fall back below to the DID-doc keyAgreement key.
  const filteredAgents = agentIdFromDid
    ? profile.authorizedAgents.filter(a => a.agentId === agentIdFromDid)
    : profile.authorizedAgents;
  const active = filteredAgents.filter(a => !a.revoked && a.encryptionPublicKey);

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

  // FIX 6 fallback — the registry has no usable entry for this agent
  // (either the agent DID isn't registered on its owner's pod yet, or
  // its entry has no encryption key). Use the DID doc's keyAgreement
  // key as the recipient. This keeps cross-pod sharing working while
  // owner-pod registry presence catches up. Registry walks for owner
  // DIDs (`did:web:…:users:<id>`) still produce the full multi-agent
  // recipient set as before.
  if (keys.length === 0 && didKey) {
    keys.push(didKey);
    if (agentIdFromDid) ids.push(agentIdFromDid);
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
 * Pull the `<agentId>` slug out of a `did:web:<host>:agents:<agentId>`
 * handle so the registry walk can narrow to that single agent. Returns
 * `null` when the handle isn't a bare agent DID.
 */
function extractAgentIdFromDid(handle: string): string | null {
  if (!handle.startsWith('did:web:')) return null;
  const parts = handle.slice('did:web:'.length).split(':');
  // `<host> : agents : <agentId>` — i.e. parts[1] === 'agents'.
  if (parts.length >= 3 && parts[1] === 'agents') {
    const id = parts[2];
    return id && id.length > 0 ? decodeURIComponent(id) : null;
  }
  return null;
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

export type PublishVisibility = 'public' | 'shared' | 'private';

export interface ComputePublishRecipientsInput {
  /** Raw visibility argument from the caller — invalid/undefined → 'shared'. */
  readonly rawVisibility: string | undefined;
  /** Cross-pod share handles. Ignored (with warn) when visibility !== 'shared'. */
  readonly shareWith: readonly string[];
  /** The author's session-agent encryption public key. Unconditional recipient. */
  readonly authorEncryptionKey: string;
  /** Author's agent IRI — seeds the recipient-agent list for descriptor metadata. */
  readonly authorAgentId: string;
  /** Registry-resolved keys of non-revoked author-pod agents (visibility === 'shared' only). */
  readonly registryAgentKeys: readonly string[];
  /** Already-resolved share_with recipients (visibility === 'shared' only). */
  readonly resolvedShareTargets: readonly ResolvedRecipientPod[];
}

export interface ComputePublishRecipientsResult {
  readonly visibility: PublishVisibility;
  readonly recipients: string[];
  readonly recipientAgents: string[];
  readonly selfIncluded: boolean;
  readonly warnings: string[];
}

/**
 * Pure helper that decides the JOSE envelope recipient set + recipient-agent
 * list for `publish_context`. Encapsulates two production invariants:
 *
 *   1. share-with-author: when visibility === 'shared', the author's session
 *      key is ALWAYS in `recipients` — share_with APPENDS, never REPLACES,
 *      and a defensive re-push guards against future reordering bugs.
 *   2. visibility-drops-share_with: visibility 'public' or 'private' silently
 *      dropping share_with would leak a private-scoped graph to extra keys,
 *      so we surface a warning and clear share_with from the recipient set.
 *
 * Callers (the relay + the local mcp-server) thread their own warn-logger
 * over `warnings` and pass `registryAgentKeys` + `resolvedShareTargets` from
 * pre-fetched data so this helper stays pure + unit-testable.
 */
export function computePublishRecipients(
  input: ComputePublishRecipientsInput,
): ComputePublishRecipientsResult {
  const {
    rawVisibility, shareWith, authorEncryptionKey, authorAgentId,
    registryAgentKeys, resolvedShareTargets,
  } = input;
  const visibility: PublishVisibility =
    rawVisibility === 'public' || rawVisibility === 'private' || rawVisibility === 'shared'
      ? rawVisibility
      : 'shared';
  const warnings: string[] = [];
  if (visibility !== 'shared' && shareWith.length > 0) {
    warnings.push(
      `WARN: publish_context visibility="${visibility}" ignores share_with (${shareWith.length} handle(s) dropped) — only 'shared' supports per-recipient routing`,
    );
  }
  let recipients: string[] = [];
  const recipientAgents: string[] = [authorAgentId];
  if (visibility === 'shared') {
    for (const k of registryAgentKeys) {
      if (!recipients.includes(k)) recipients.push(k);
    }
    if (!recipients.includes(authorEncryptionKey)) recipients.push(authorEncryptionKey);
    for (const r of resolvedShareTargets) {
      if (r.handle && !recipientAgents.includes(r.handle)) recipientAgents.push(r.handle);
      for (const key of r.agentEncryptionKeys) {
        if (!recipients.includes(key)) recipients.push(key);
      }
    }
    if (!recipients.includes(authorEncryptionKey)) recipients.push(authorEncryptionKey);
  } else if (visibility === 'private') {
    recipients = [authorEncryptionKey];
  }
  const selfIncluded = visibility === 'public' ? true : recipients.includes(authorEncryptionKey);
  return { visibility, recipients, recipientAgents, selfIncluded, warnings };
}
