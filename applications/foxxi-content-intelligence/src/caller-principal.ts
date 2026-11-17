/**
 * Who is calling a signed `/agent/*` route — decided in one place.
 *
 * The bridge used to make this decision three times (`verifyDelegatedCaller`,
 * `bindSignedCaller`, and an inline copy in `/agent/issue-credential`). The three agreed on
 * the rule and differed in small ways at the edges; this module holds the rule once and
 * takes each edge as an explicit option, so every call site keeps the behaviour it had.
 *
 * The rule:
 *
 *   DIRECT    — the signed `agent_id` embeds the recovered signer address. The signer IS the
 *               caller, and the records are about `did:ethr:<signer>`.
 *   DELEGATED — anything else. The agent holds no key; some other key signed for it. That is
 *               accepted only when the agent's delegation, read from the agent's OWN derived
 *               pod, is CryptographicallyVerified AND the request signer is the key that
 *               anchors it. The records are about the `agent_id`.
 *
 * Pure: no I/O of its own. The three reads a delegated caller needs (which pod, is the
 * delegation verified, which key anchors it) come in as callbacks, so the whole decision is
 * unit-testable without a pod.
 */
import type { RecoveredSignedRequest } from './auth.js';
import { hasControlChars, isGeneralGuestDid } from './subject-pod-url.js';

/**
 * How a signed `/agent/*` caller was authenticated.
 *
 * A general guest is NOT one of these. It has its own principal (`GuestCallerPrincipal`, below),
 * made only by `generalGuestPrincipal`, and `decideCallerPrincipal` never answers one: a guest
 * calls the guest operations (src/guest-operations.ts) and no `/agent/*` route.
 */
export type CallerAuthMode = 'direct' | 'delegated';

export interface CallerPrincipal {
  /** The DID the caller's records are about: `did:ethr:<signer>` when direct, the signed `agent_id` when delegated. */
  subject: string;
  /** The recovered signer address: the caller's own key when direct, the delegation anchor key when delegated. */
  key: string;
  authMode: CallerAuthMode;
  /** A wallet signing for itself is a person; a delegated agent is an agent. */
  kind: 'human' | 'agent';
  /** The signed payload, exactly as recovered. */
  payload: Record<string, unknown>;
}

/** What a general guest was admitted with: identity's statement at the door, as the bridge checked it. */
export interface GeneralGuestAdmission {
  /** Identity's user id for the guest: `u-try-guest-<32 hex>`. */
  readonly userId: string;
  /** `did:web:<identity host>:users:<userId>`. */
  readonly guestDid: string;
  /** The guest's own pod. Never the tenant pod. */
  readonly podUrl: string;
  /** Unix milliseconds: after this the admission is gone. */
  readonly expiresAt: number;
}

/**
 * A general guest as a caller. The subject is the GUEST, not the tab key that signed: the key
 * only shows that this is the browser tab that finished the door visit.
 */
export interface GuestCallerPrincipal {
  /** The guest's DID. */
  readonly subject: string;
  /** The tab key that signed the request (its address). It owns nothing. */
  readonly key: string;
  readonly authMode: 'general-guest';
  readonly kind: 'human';
  readonly payload: Record<string, unknown>;
  readonly guest: GeneralGuestAdmission;
}

/** The one place a general guest's principal is made. The caller has verified the key and the admission. */
export function generalGuestPrincipal(key: string, payload: Record<string, unknown>, guest: GeneralGuestAdmission): GuestCallerPrincipal {
  return { subject: guest.guestDid, key, authMode: 'general-guest', kind: 'human', payload, guest };
}

/** Why a caller was refused. One value per refusal the three former copies could produce. */
export type CallerRefusalReason =
  | 'unsigned'
  | 'agent-id-control-character'
  | 'agent-id-too-long'
  | 'general-guest-not-accepted'
  | 'general-guest-key'
  | 'delegation-check-failed'
  | 'delegation-unverified'
  | 'signer-not-anchor';

export interface CallerRefusal {
  ok: false;
  reason: CallerRefusalReason;
  status: number;
  error: string;
  /** Present only on an `unsigned` refusal, and only when the call site supplied one. */
  hint?: string;
}

export type CallerDecision = { ok: true; principal: CallerPrincipal } | CallerRefusal;

/** The three reads a DELEGATED caller needs. All I/O lives behind these. */
export interface DelegationChecks {
  /** The pod the agent's delegation is read from: derived from the agent id, never caller-supplied. A throw propagates. */
  podFor(agentId: string): string;
  /** Is the agent's delegation on that pod verified? A throw is a refusal (`delegation-check-failed`). */
  verify(agentId: string, pod: string): Promise<{ valid: boolean; trustLevel?: string | null; reason?: string | null }>;
  /** The address of the key that anchors the delegation credential, or nothing when it cannot be read. Must not throw. */
  anchorOf(agentId: string, pod: string): Promise<string | null | undefined>;
}

/**
 * Where the three former copies differed. Each call site states its own; nothing is unified.
 */
export interface CallerPrincipalOptions {
  /**
   * Refuse (400) an `agent_id` containing a control character or longer than
   * `AGENT_ID_MAX_LENGTH`, before deciding direct or delegated. `bindSignedCaller` did this;
   * `verifyDelegatedCaller` and `/agent/issue-credential` did not.
   */
  agentIdBounds: boolean;
  /**
   * End the signer-is-not-the-anchor refusal with the sentence explaining the rule.
   * `bindSignedCaller` did; the other two stopped after the anchor address.
   */
  anchorRefusalExplains: boolean;
  /**
   * A hint attached to the `unsigned` refusal. `bindSignedCaller` took one per call site,
   * `/agent/issue-credential` always sent its own, `verifyDelegatedCaller` sent none.
   */
  unsignedHint?: string;
  /**
   * Is this signer a tab key admitted as a general guest? When it is, the request is refused
   * (403): such a key calls the guest operations and nothing else. Absent, no key is one.
   */
  guestKey?: (signer: string) => boolean;
}

export const AGENT_ID_MAX_LENGTH = 512;

/** The subject of a DIRECT caller. The one place a signer address becomes a caller DID. */
export function directSubject(signer: string): string {
  return `did:ethr:${signer}`;
}

/** Does this `agent_id` embed the recovered signer address? First address in the string, case-insensitive. */
export function isDirectClaim(agentId: string, signer: string): boolean {
  const claimedAddr = agentId.toLowerCase().match(/0x[0-9a-f]{40}/)?.[0];
  return Boolean(claimedAddr) && claimedAddr === signer.toLowerCase();
}

export async function decideCallerPrincipal(
  rec: RecoveredSignedRequest,
  checks: DelegationChecks,
  opts: CallerPrincipalOptions,
): Promise<CallerDecision> {
  if (!rec.ok) {
    return {
      ok: false, reason: 'unsigned', status: 401, error: `agent signature required: ${rec.reason}`,
      ...(opts.unsignedHint ? { hint: opts.unsignedHint } : {}),
    };
  }
  if (opts.agentIdBounds) {
    if (hasControlChars(rec.agentId)) {
      return { ok: false, reason: 'agent-id-control-character', status: 400, error: 'agent_id contains a control character — an identity must be a single line of printable text' };
    }
    if (rec.agentId.length > AGENT_ID_MAX_LENGTH) {
      return { ok: false, reason: 'agent-id-too-long', status: 400, error: `agent_id is ${rec.agentId.length} characters — the limit is ${AGENT_ID_MAX_LENGTH}` };
    }
  }
  // A general guest is never a signed /agent caller, direct or delegated: no delegation is read
  // for one, and no pod is derived for one here. Refused before any I/O.
  if (isGeneralGuestDid(rec.agentId.trim())) {
    return { ok: false, reason: 'general-guest-not-accepted', status: 403, error: 'a general guest is not a signed /agent caller: nothing is accepted in a guest\'s name here, by signature or by delegation' };
  }
  if (opts.guestKey?.(rec.signer)) {
    return { ok: false, reason: 'general-guest-key', status: 403, error: 'this key was admitted as a general guest: it calls the guest operations and nothing else' };
  }
  if (isDirectClaim(rec.agentId, rec.signer)) {
    // DIRECT: the signer IS the actor.
    return { ok: true, principal: { subject: directSubject(rec.signer), key: rec.signer, authMode: 'direct', kind: 'human', payload: rec.payload } };
  }
  const delegationPod = checks.podFor(rec.agentId);
  let del;
  try {
    del = await checks.verify(rec.agentId, delegationPod);
  } catch (err) {
    return { ok: false, reason: 'delegation-check-failed', status: 401, error: `delegation verification failed for ${rec.agentId} on ${delegationPod}: ${(err as Error).message}` };
  }
  if (!del.valid || del.trustLevel !== 'CryptographicallyVerified') {
    return { ok: false, reason: 'delegation-unverified', status: 401, error: `agent ${rec.agentId} has no cryptographically-verified delegation on ${delegationPod}: ${del.reason ?? del.trustLevel ?? 'unverified'}` };
  }
  const anchor = await checks.anchorOf(rec.agentId, delegationPod);
  if (!anchor || anchor.toLowerCase() !== rec.signer.toLowerCase()) {
    return {
      ok: false, reason: 'signer-not-anchor', status: 401,
      error: `request signer ${rec.signer} is not the delegation anchor key${anchor ? ` (${anchor})` : ''}`
        + (opts.anchorRefusalExplains ? ` — only the key that anchors the agent's delegation may sign for them` : ''),
    };
  }
  // DELEGATED: the signer is the delegation ANCHOR — the delegator's key.
  return { ok: true, principal: { subject: rec.agentId, key: rec.signer, authMode: 'delegated', kind: 'agent', payload: rec.payload } };
}
