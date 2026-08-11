/**
 * POINTING AN ABSENT AGENT'S INBOX AT A REQUEST THAT IS ALREADY ON THE RECORD.
 *
 * ★ THIS IS NOT WHERE AN ASK IS MADE. An ask is a `wsp:Entry` on the asker's own pod carrying
 * `iep:addressedTo` inside its signed region — `entryTurtle` writes it and `verifyRequest` reads
 * it. This file is the ACCELERANT: the one notification decision that sits after that write, and
 * it lives here because two surfaces make it and a third will.
 *
 * ★ WHY IT IS SHARED RATHER THAN COPIED. The rule has three branches and every one of them is a
 * thing somebody gets wrong the second time it is written:
 *
 *   1. A RUNNING HOST IS SENT NOTHING. It is already polling the channel the ask is in, so a notice
 *      would be a second pointer to a record it is about to read anyway. Sending one regardless
 *      trains every reader to treat the inbox as where requests live, which is the one place they
 *      must never live — an inbox on this relay is world-writable, so anything that travelled by
 *      inbox is something a forger could have written.
 *   2. THE ADDRESSEE'S OWN POD, NEVER ITS DELEGATOR'S. Measured live and fixed once already: a
 *      hosted delegate reads its inbox through ITS OWN session, and the relay answers
 *      `read_inbox: forbidden — you may only read your own inbox` for any other pod. A notice sent
 *      to the seated member's pod lands in a mailbox the addressee cannot open, and the request
 *      sits unread forever while every panel reports that nothing was waiting.
 *   3. AN ID THIS CLIENT CANNOT TURN INTO A POD SENDS NOTHING AND SAYS SO. A cross-issuer or
 *      `did:key` delegate has no derivable inbox. A notice into a guessed mailbox is a notice
 *      nobody reads, reported as delivered.
 *
 * Every branch returns the same shape, so a surface renders an outcome rather than reconstructing
 * the reasoning. Nothing here decides WHETHER to ask, who may be asked, or what the task says.
 */

import { agentPodOf, isPresent, type Presence } from '@interego/core/agent';
import { errorCopy, type WorkspaceClient } from './substrate.js';

/**
 * What happened to the pointer, in enough detail that a surface never has to guess.
 *
 * `attempted: false` with a `why` is a DECISION not to send — which is a different fact from a
 * send that failed, and the two must not render the same. `delivered` is the relay's own word and
 * is reported as its claim: this client did not open the mailbox afterwards to check.
 */
export interface AskNotice {
  readonly attempted: boolean;
  readonly delivered: boolean;
  /** The relay's answer to "is that the canonical inbox for that pod". Null when it did not say. */
  readonly canonicalInbox: boolean | null;
  readonly inbox: string | null;
  readonly warning: string | null;
  /** Why nothing was sent, or why a send did not land. Null only on a clean delivery. */
  readonly why: string | null;
}

const NOT_SENT = (why: string): AskNotice =>
  ({ attempted: false, delivered: false, canonicalInbox: null, inbox: null, warning: null, why });

/**
 * Send the pointer, or decide not to and say which.
 *
 * `about` is the descriptor URL of the entry that IS the request, and `summary` never carries the
 * task text: the relay takes the sender from the caller's session and can be trusted for that, but
 * the notice itself arrives in a world-writable inbox, so the recipient dereferences `about` and
 * checks it rather than believing anything in here.
 */
export async function notifyAsk(
  client: WorkspaceClient,
  args: {
    readonly agentId: string;
    /**
     * The addressee's OWN pod, out of its DID. Passed rather than derived so a caller that already
     * has it cannot end up disagreeing with this function about which mailbox is meant; pass null
     * and this derives it, and reports honestly when it cannot.
     */
    readonly agentPod?: string | null;
    readonly presence: Presence;
    readonly about: string;
    readonly summary: string;
  },
): Promise<AskNotice> {
  if (isPresent(args.presence)) {
    return NOT_SENT('this agent said its host was running, and a running host reads the channel directly — no notice '
      + 'was sent, because the entry on the record IS the request');
  }
  const pod = args.agentPod ?? agentPodOf(args.agentId);
  if (!pod) {
    return NOT_SENT('this client cannot take a pod out of ' + args.agentId + ', so it cannot name the inbox that '
      + 'agent polls. Nothing was sent — a notice into a guessed mailbox is a notice nobody reads. The ask is on '
      + 'the record, and a host that reads this channel will find it there.');
  }
  let res: Record<string, unknown>;
  try {
    res = await client.tool('notify_agent', {
      to: pod, type: 'Question', about: args.about, summary: args.summary,
    }) as Record<string, unknown>;
  } catch (e) {
    return { attempted: true, delivered: false, canonicalInbox: null, inbox: null, warning: null, why: errorCopy(e).t };
  }
  const delivered = res['delivered'] === true;
  return {
    attempted: true,
    delivered,
    canonicalInbox: typeof res['canonicalInbox'] === 'boolean' ? res['canonicalInbox'] : null,
    inbox: typeof res['inbox'] === 'string' ? res['inbox'] : null,
    warning: typeof res['warning'] === 'string' ? res['warning'] : null,
    why: delivered ? null : String(res['error'] ?? res['message'] ?? 'the relay reported the delivery as not made and gave no reason'),
  };
}
