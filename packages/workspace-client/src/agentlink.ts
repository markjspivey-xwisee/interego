/**
 * BINDING A CHAT ACCOUNT TO A POD — the one thing about a conduit link that is not substrate.
 *
 * ★ WHAT USED TO BE HERE AND IS NOW A LAYER DOWN. This file declared its own `DelegationScope`
 * union of the same four strings `@interego/core` has always exported, its own `AGENT_ID_RX`, and
 * its own publish/revoke pair. All three are Interego concepts and all three now come from
 * `@interego/core/delegate`. Keeping a second spelling of the scope enum in a vertical was the
 * defect: the substrate's is what `verifyDelegation` and the relay's scope gate actually test
 * against, so a vertical's copy could only ever agree with it by luck.
 *
 * What is genuinely local is the CLAIM a conduit's delegation row carries.
 *
 * ★ AND THE LABEL IS DELIBERATELY NOT A SECRET. This is load-bearing and easy to "improve" into a
 * hole. A delegation row is WORLD-READABLE — `get_pod_status { pod_name: <anyone's> }` answers for
 * any pod and returns `delegationRegistry.rows` with their labels, measured live. So a nonce
 * published as a label is a nonce published: whoever reads that pod first can present it and bind
 * THEIR chat account to YOUR pod, after which their messages land on your pod under your WebID.
 * The label is therefore the CLAIM ITSELF — "I authorise this agent on behalf of account U" —
 * written in a document only the pod owner can write, and the verifier computes the string it
 * looks for from the identity of the account actually asking. Nothing here may ever mint,
 * transport, or hide a secret in a label. See `delegation.ts` and the bot's `links.ts` headers.
 */

import type { DelegatePlan, DelegationScope } from '@interego/core/delegate';
import { AGENT_ID_RX } from '@interego/core/delegate';

/** A Discord snowflake: digits only, and bounded. Anything else never reaches a tool call. */
export const SNOWFLAKE_RX = /^[0-9]{1,20}$/;

/**
 * The label a pod owner must put on a delegation row to say which Discord account it is for.
 *
 * ★ ONE FUNCTION, TWO CALLERS, AND THAT IS THE ENTIRE REASON IT IS HERE. The bot computes it from
 * the id of the account running `link-confirm`; the desktop app writes it from the id the user
 * pasted. If those two ever formatted the string differently, every honest link would be refused
 * with a message about a label mismatch that named two strings a user could not tell apart.
 *
 * Not a secret. See the file header before changing anything about it.
 */
export const challengeLabel = (discordUserId: string): string => 'discord-link ' + discordUserId;

/**
 * Why a conduit link might be refused before any call is made.
 *
 * ★ A FOURTH FIELD THE SUBSTRATE DOES NOT HAVE, WHICH IS WHY `DelegatePlan` IS GENERIC. A
 * delegation has an agent, a name and a scope; a DISCORD link form also has a snowflake. When
 * this union was the only one, a bad delegate NAME had to be reported against `agentId` and the
 * wrong input lit up. The vertical's extra field now stays in the vertical.
 */
export interface LinkProblem { readonly field: 'agentId' | 'discordUserId' | 'scope'; readonly why: string }

/** The conduit-link flavour of the substrate's plan: same call and limits, this form's fields. */
export type LinkPlan = DelegatePlan<LinkProblem['field']>;

/**
 * Describe the delegation a Discord link needs, without making it.
 *
 * `discordUserId` and `botAgentId` are both PUBLIC values the bot hands the user in its
 * `/workspace link` reply. Neither is a credential and neither is checked against anything here —
 * the binding is established by the bot at confirm time, from the id of the account actually
 * running the command. This function's job is to get the row's shape and the user's understanding
 * of it right.
 *
 * Run it with the substrate's `publishDelegation`, which read-backs the pod and — because this
 * plan carries a label — refuses to report `published` unless the row is there UNDER THIS LABEL.
 */
export function discordLinkPlan(args: {
  readonly botAgentId: string;
  readonly discordUserId: string;
}): LinkPlan {
  const problems: LinkProblem[] = [];
  const agentId = args.botAgentId.trim();
  const discordUserId = args.discordUserId.trim();
  if (!agentId) problems.push({ field: 'agentId', why: 'The bot\'s agent id is empty. `/workspace link` prints it — it is the line beginning `did:`.' });
  else if (!AGENT_ID_RX.test(agentId)) {
    problems.push({ field: 'agentId', why: 'That is not the shape of an agent id. It should look like `did:ethr:0x…` — one scheme, a colon, then no spaces or quotes.' });
  }
  if (!discordUserId) problems.push({ field: 'discordUserId', why: 'Your Discord user id is empty. `/workspace link` prints it back to you; it is the run of digits.' });
  else if (!SNOWFLAKE_RX.test(discordUserId)) {
    problems.push({ field: 'discordUserId', why: 'A Discord user id is digits only, at most 20 of them. This has something else in it, so it is not sent anywhere.' });
  }
  const label = challengeLabel(discordUserId);
  return {
    problems,
    call: problems.length ? null : {
      tool: 'register_agent',
      args: { agent_id: agentId, scope: 'PublishOnly' satisfies DelegationScope, label },
    },
    limits: [
      'This publishes one row on YOUR pod naming that one agent. It is not a password and it grants nothing to anybody else.',
      // The bot's README calls this one of its two honest limits. Repeating it at the moment of
      // consent rather than in a document nobody opens is the whole point of showing a plan.
      'PublishOnly is POD-WIDE. The substrate has no per-graph delegation scope, so the bot could publish any graph to your pod — not only workspace entries. What bounds it is that it is one named agent, every write is content-bound and attributed to it, and you can withdraw it alone.',
      'The label "' + label + '" is public, and is meant to be. It is you naming which Discord account this is for, in a document only you can write. It is not a code and there is nothing in it to steal.',
      'You can revoke this at any time from your own client. Revocation is your unilateral act and does not need the bot to cooperate.',
      // Measured, in delegation.ts's header. A user told "revoked" who then sees a message land
      // would reasonably conclude the revoke did not work.
      'For up to 60 seconds after a revoke the relay may still accept a write it had already cached permission for. The bot re-asks before every write and stops itself, but the relay alone is not the boundary.',
    ],
  };
}

/**
 * The substrate's scope vocabulary and delegation writes, re-exported for this package's
 * consumers. Nothing below is defined here — see `@interego/core/delegate`.
 */
export {
  DELEGATION_SCOPES, WRITE_ELIGIBLE_SCOPES, isDelegationScope, scopeWriteEligible, AGENT_ID_RX,
  publishDelegation, revokeDelegation,
} from '@interego/core/delegate';
export type { DelegationScope, DelegatePlan, DelegateOutcome } from '@interego/core/delegate';
