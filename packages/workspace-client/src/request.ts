/**
 * THE ONE HALF OF REQUEST VERIFICATION THAT IS GENUINELY ABOUT A WORKSPACE.
 *
 * ★ FIVE OF THE SIX CHECKS ARE NOT, AND THEY MOVED. "Does this inbox pointer resolve", "is the
 * record it points at signed and content-bound", "is the party that delivered the pointer the party
 * that signed the record", "is it addressed to an agent whose key is on THIS machine", and "has it
 * already been answered" are questions an agent has to answer whether or not it has ever been in a
 * room. They are `verifyRequest` in `@interego/core/agent` now.
 *
 * ★ WHAT STAYS IS CHECK 5, AS A PLUGGABLE ADMISSION PREDICATE, AND THAT SPLIT IS THE HINGE. A
 * workspace's answer to "may this party put work to me" is "are they seated in this room" — read
 * from the roster, which is a grant on the convener's pod and an acceptance on theirs, two documents
 * and neither of them the notice. A Codex agent's answer is an allowlist. A bare delegate's is "any
 * verified signer". Before this was a parameter the verifier took `seats: readonly Seat[]` and was
 * therefore UNUSABLE by an agent that belongs to no workspace — which is precisely the case the
 * model says must work, and the reason the split exists rather than the convenience of it.
 */

import { agentPodOf, readDelegates, type DelegateRegistryPort, type DelegateRoster } from '@interego/core/delegate';
import { type AdmissionPredicate } from '@interego/core/agent';
import { readIri } from './turtle.js';
import type { Seat } from './seats.js';

export {
  REQUEST_INBOX_LIMIT, readRequests, verifyRequest, admitAnyVerifiedSigner, agentInbox,
  type RequestNotice, type RequestVerdict, type AdmissionPredicate,
} from '@interego/core/agent';

/**
 * Admit a party seated in this workspace, and nobody else.
 *
 * ★ THE ROOM IS READ OUT OF THE RECORD AND HELD AGAINST THE ONE THIS HOST IS WATCHING. An ask into
 * another channel is not an ask here, and a record that declares no room at all does not become one
 * by being delivered to somebody who is in one.
 *
 * ★ AND SEATING IS RESOLVED FROM THE SIGNATURE, NOT FROM THE ADDRESS THE NOTICE POINTED AT. This
 * used to take the `pod` the verifier derived from the notice's own `about` URL — measured, that is
 * the first path segment of an attacker-chosen string, and `get_descriptor` will fetch a
 * caller-supplied URL on any public host. A descriptor served from
 * `https://attacker.example/u-eth-<a seated pod>/req.ttl` therefore named a pod the bytes had never
 * touched and this predicate admitted it. What the relay verified over the bytes is `signedBy`, so
 * the question asked here is "whose seat does that KEY belong to", answered from three documents
 * none of which the asker can write:
 *
 *   · the seat's own grantee WebID, when the person signed for themselves;
 *   · the pod inside the signer's own DID, when it is a member's own session agent;
 *   · a seated pod's DELEGATION REGISTRY, when it is a delegate of somebody seated.
 *
 * ★ AND A REGISTRY THAT WOULD NOT ANSWER IS SAID, NOT SILENTLY READ AS "NOT SEATED". Refusing
 * somebody's agent because an HTTP call failed is an accusation manufactured from a network error,
 * and it is the shape of failure that gets read as "your agent is not authorised".
 *
 * The rosters are read at most once per pod per predicate, so a burst of notices cannot turn into a
 * burst of registry scans.
 */
export function admitSeatedIn(args: {
  /** The workspace this host is currently watching. */
  readonly workspace: string;
  readonly seats: readonly Seat[];
  /**
   * How to read a seated pod's delegation registry.
   *
   * Optional, and its absence is answered honestly rather than by falling back to the old
   * URL-segment test: with no way to read a registry, a delegate's key can still be matched to a
   * seat when the delegate belongs to a seated pod's own surface, and anything else is reported as
   * not established.
   */
  readonly port?: DelegateRegistryPort;
}): AdmissionPredicate {
  const rosters = new Map<string, DelegateRoster | { readonly failed: string }>();
  const seatedPods = (): readonly string[] => {
    const out: string[] = [];
    for (const s of args.seats) {
      if (!s.seated) continue;
      const p = s.podServed ?? s.pod;
      if (p && out.indexOf(p) < 0) out.push(p);
    }
    return out;
  };
  return async ({ signedBy, region }) => {
    const declared = readIri(region, 'wsp:workspace');
    if (!declared) {
      return 'that record declares no wsp:workspace, so which channel it belongs to is not established — and a record that '
        + 'names no room does not join one by arriving in the inbox of somebody who is in it';
    }
    if (declared !== args.workspace) {
      return 'that record belongs to ' + declared + ' and this host is watching ' + args.workspace
        + '. An ask into another channel is not an ask here.';
    }
    const pods = seatedPods();
    if (!pods.length) {
      return 'nobody is seated in ' + args.workspace + ' as this host reads it, so there is no seat for ' + signedBy
        + ' to be resolved to. Seating is a grant on the convener\'s pod and an acceptance on theirs.';
    }
    // The person signed for themselves, or a key on their own pod's surface did.
    const signerPod = agentPodOf(signedBy);
    for (const s of args.seats) {
      if (!s.seated) continue;
      const pod = s.podServed ?? s.pod;
      if (!pod) continue;
      if (s.grantedTo && s.grantedTo === signedBy) return null;
      if (signerPod && signerPod === pod) return null;
    }
    // A delegate of somebody seated. Their registry is a document only they can write.
    const unread: string[] = [];
    for (const pod of pods) {
      if (!args.port) { unread.push(pod); continue; }
      let roster = rosters.get(pod);
      if (roster === undefined) {
        try { roster = await readDelegates(args.port, pod); }
        catch (e) { roster = { failed: (e as Error)?.message ?? String(e) }; }
        rosters.set(pod, roster);
      }
      if ('failed' in roster) { unread.push(pod); continue; }
      if (!roster.read) { unread.push(pod); continue; }
      if (roster.rows.some((r) => r.agentId === signedBy)) return null;
    }
    return 'the key that signed that record, ' + signedBy + ', resolves to no seat in this workspace: it is not a seated '
      + 'member\'s own WebID, its own pod is not a seated pod, and no seated pod\'s delegation registry lists it'
      + (unread.length
        ? '. ' + unread.length + ' of ' + pods.length + ' seated pods\' registries could not be read here (' + unread.join(', ')
          + '), so this is a refusal for lack of an answer rather than a finding that they do not list it.'
        : '. Seating is a grant on the convener\'s pod and an acceptance on theirs — two documents, neither of them this notice.');
  };
}
