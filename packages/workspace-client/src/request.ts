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

import { type AdmissionPredicate } from '@interego/core/agent';
import { readIri } from './turtle.js';
import type { Seat } from './seats.js';

export {
  REQUEST_INBOX_LIMIT, readRequests, verifyRequest, admitAnyVerifiedSigner,
  type RequestNotice, type RequestVerdict, type AdmissionPredicate,
} from '@interego/core/agent';

/**
 * Admit a party seated in this workspace, and nobody else.
 *
 * ★ THE ROOM IS READ OUT OF THE RECORD AND HELD AGAINST THE ONE THIS HOST IS WATCHING. An ask into
 * another channel is not an ask here, and a record that declares no room at all does not become one
 * by being delivered to somebody who is in one.
 *
 * ★ AND SEATING COMES FROM THE ROSTER, NOT FROM THE NOTICE. `seats` is the fold this client already
 * computed — one roster per run, not re-derived per item, so a burst of notices cannot turn into a
 * burst of grant scans against the convener's pod.
 */
export function admitSeatedIn(args: {
  /** The workspace this host is currently watching. */
  readonly workspace: string;
  readonly seats: readonly Seat[];
}): AdmissionPredicate {
  return ({ pod, region }) => {
    const declared = readIri(region, 'wsp:workspace');
    if (!declared) {
      return 'that record declares no wsp:workspace, so which channel it belongs to is not established — and a record that '
        + 'names no room does not join one by arriving in the inbox of somebody who is in it';
    }
    if (declared !== args.workspace) {
      return 'that record belongs to ' + declared + ' and this host is watching ' + args.workspace
        + '. An ask into another channel is not an ask here.';
    }
    const seat = args.seats.find((s) => (s.podServed ?? s.pod) === pod && s.seated) ?? null;
    if (!seat) {
      return 'pod ' + pod + ' is not seated in this workspace, so it has no standing to put work into it. Seating is a grant on '
        + 'the convener\'s pod and an acceptance on theirs — two documents, neither of them this notice.';
    }
    return null;
  };
}
