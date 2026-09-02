/**
 * Resolve whose WebID a delegated publish on a target pod is on behalf of.
 *
 * A remote agent carries two identities into `publish_context`: its own authenticated
 * session owner and the owner of the pod it has been delegated permission to write.  The
 * descriptor is served from the latter pod, so `AgentFacet.onBehalfOf`, `TrustFacet.issuer`,
 * the authorship proof's `ownerWebId`, and leaf ACL ownership must all name the target pod's
 * owner.  Naming the session owner makes an otherwise valid cross-pod write look like a proof
 * copied onto somebody else's pod.
 *
 * The owner lookup is lazy on purpose.  An unauthorized caller must be refused before the
 * target registry is read; besides being cheaper, that avoids turning the registry into an
 * authorization oracle.  A missing owner fails closed: falling back to the session owner is
 * exactly the misattribution this resolver exists to prevent.
 */

export interface PublishOwnerAttributionInput {
  /** Result of the target pod's delegation/scope gate. */
  readonly authorized: boolean;
  /** Owner injected from the authenticated caller's session. Used only for diagnostics. */
  readonly sessionOwnerWebId: string;
  /** Reads the authoritative owner published by the target pod's agent registry. */
  readonly readTargetOwnerWebId: () => Promise<string | null | undefined>;
}

export interface PublishOwnerAttribution {
  readonly ok: boolean;
  readonly ownerWebId?: string;
  readonly differsFromSessionOwner?: boolean;
  readonly code?: 403 | 503;
  readonly error?: 'scope_violation' | 'target_owner_unavailable';
  readonly reason?: string;
}

export async function resolvePublishOwnerAttribution(
  input: PublishOwnerAttributionInput,
): Promise<PublishOwnerAttribution> {
  if (!input.authorized) {
    return {
      ok: false,
      code: 403,
      error: 'scope_violation',
      reason: 'The agent is not authorized to publish on the target pod.',
    };
  }

  let targetOwner: string | null | undefined;
  try {
    targetOwner = await input.readTargetOwnerWebId();
  } catch (err) {
    return {
      ok: false,
      code: 503,
      error: 'target_owner_unavailable',
      reason: `The target pod owner could not be read: ${(err as Error).message}`,
    };
  }

  const ownerWebId = typeof targetOwner === 'string' ? targetOwner.trim() : '';
  if (ownerWebId.length === 0) {
    return {
      ok: false,
      code: 503,
      error: 'target_owner_unavailable',
      reason: 'The target pod publishes no owner WebID.',
    };
  }

  return {
    ok: true,
    ownerWebId,
    differsFromSessionOwner: ownerWebId !== input.sessionOwnerWebId,
  };
}
