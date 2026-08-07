/**
 * PUBLISHING A DELEGATION FROM THE OWNER'S OWN CLIENT.
 *
 * `delegation.ts` is the READING half — a delegate asking "may I write to that pod, and did its
 * owner say this delegation is for me". This is the WRITING half: the pod owner, in their own
 * authenticated client, publishing the row that makes it true.
 *
 * ★ WHY THIS IS IN THE SHARED PACKAGE AND NOT IN THE APP THAT HAPPENS TO NEED IT FIRST.
 * The Discord bot tells a participant a string to publish; the desktop app publishes it for them;
 * the artifact could too. `links.ts` in the bot already says what goes wrong when that string has
 * two format sites — "the string the bot tells the user to type and the string it later compares
 * must be one string; two format sites is how a link flow comes to reject every honest user".
 * {@link challengeLabel} was that one site inside the bot. The moment a second client publishes
 * the same row it stops being one site unless it moves here, so it moved here, and the bot
 * re-exports it rather than keeping a copy.
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

import { checkDelegation, type DelegationVerdict } from './delegation.js';
import { errorCopy, type WorkspaceClient } from './substrate.js';
import { refusal } from './transport.js';

/**
 * The four scopes the substrate actually has.
 *
 * Taken from the relay's own enum. `Read` is NOT one of them: the relay's schema used to offer it,
 * and sending it stored `DiscoverOnly` while reporting success — a delegation that read as granted
 * and refused every write.
 */
export const DELEGATION_SCOPES = ['ReadWrite', 'ReadOnly', 'PublishOnly', 'DiscoverOnly'] as const;
export type DelegationScope = (typeof DELEGATION_SCOPES)[number];

/** The two the relay will let publish. The other two are refused with a 403 naming the scope. */
export const WRITE_ELIGIBLE_SCOPES: readonly DelegationScope[] = ['ReadWrite', 'PublishOnly'];

export const isDelegationScope = (s: unknown): s is DelegationScope =>
  typeof s === 'string' && (DELEGATION_SCOPES as readonly string[]).includes(s);

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
 * An agent id, as far as this package will validate one.
 *
 * Deliberately shape-only and permissive about the method: the relay accepts `did:ethr:…`,
 * `did:key:…` and `urn:agent:…` and this package is not the place that decides which methods
 * exist. What it does refuse is whitespace, angle brackets and quotes — the characters that would
 * break out of a Turtle IRI or an argument — and the empty string, so a blank field becomes a
 * refusal here rather than a confusing relay error later.
 */
export const AGENT_ID_RX = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"'{}|\\^`]+$/;

/** Why a delegation might be refused before any call is made. */
export interface LinkProblem { readonly field: 'agentId' | 'discordUserId' | 'scope'; readonly why: string }

/**
 * The exact call that would be made, plus what the user is actually agreeing to.
 *
 * ★ THE PLAN IS A VALUE SO A UI CAN SHOW IT BEFORE IT HAPPENS. A screen that says "Link Discord"
 * and then silently writes a pod-wide publish delegation has not asked for consent to the thing it
 * did. Every field of the row and every limit of it is here to be rendered.
 */
export interface DelegationPlan {
  readonly problems: readonly LinkProblem[];
  /** Null when `problems` is non-empty — there is no valid call to describe. */
  readonly call: { readonly tool: 'register_agent'; readonly args: Readonly<Record<string, unknown>> } | null;
  /** What this grant does and does not bound, in the substrate's real terms. Never reassurance. */
  readonly limits: readonly string[];
}

/**
 * Describe the delegation a Discord link needs, without making it.
 *
 * `discordUserId` and `botAgentId` are both PUBLIC values the bot hands the user in its
 * `/workspace link` reply. Neither is a credential and neither is checked against anything here —
 * the binding is established by the bot at confirm time, from the id of the account actually
 * running the command. This function's job is to get the row's shape and the user's understanding
 * of it right.
 */
export function discordLinkPlan(args: {
  readonly botAgentId: string;
  readonly discordUserId: string;
}): DelegationPlan {
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

/** What actually happened, established by reading the pod back rather than by trusting the write. */
export interface DelegationOutcome {
  readonly kind: 'invalid' | 'refused' | 'unconfirmed' | 'published';
  /** The plan that was (or would have been) executed. Always present so a UI can show the call. */
  readonly plan: DelegationPlan;
  /** The relay's own answer to `register_agent`, when it gave one. */
  readonly response: Record<string, unknown> | null;
  /**
   * The read-back. Null only when the write itself was refused, so there was nothing to confirm.
   *
   * ★ `kind: 'published'` REQUIRES THIS TO PASS, NOT THE WRITE TO SUCCEED. `register_agent`
   * answering `{registered: true}` is the relay describing its own action; the row on the pod is
   * the fact. They have disagreed before — the schema that accepted `Read` and silently stored
   * `DiscoverOnly` reported success for a delegation that could not write.
   */
  readonly verdict: DelegationVerdict | null;
  /**
   * True when the relay reported it CHANGED an existing agent's scope rather than adding one.
   *
   * Surfaced because it is a silent widening or narrowing of authority the user did not ask about:
   * re-running a link on an agent already registered with `ReadWrite` narrows it to `PublishOnly`.
   */
  readonly rescopedFrom: string | null;
  readonly why: string;
}

/**
 * Publish a delegation on the caller's OWN pod, then read the pod back to see whether it is there.
 *
 * `pod_name` is deliberately NOT sent. `register_agent` is own-pod gated at the relay
 * (`requireOwnPod`) and defaults to the authenticated user's pod; naming a pod explicitly adds a
 * value that can be wrong — and the failure mode of getting it wrong is a delegation published
 * somewhere the user was not looking, or a refusal they cannot interpret. The pod that is written
 * is the pod that is authenticated, and `verifyOnPod` is where the caller says which one that is
 * so the read-back can check the two agree.
 */
export async function publishDelegation(
  client: WorkspaceClient,
  args: {
    readonly plan: DelegationPlan;
    /** The caller's own pod, for the read-back. */
    readonly verifyOnPod: string;
  },
): Promise<DelegationOutcome> {
  const { plan } = args;
  if (!plan.call) {
    return {
      kind: 'invalid', plan, response: null, verdict: null, rescopedFrom: null,
      why: plan.problems.map((p) => p.why).join(' ') || 'This delegation was not described completely enough to publish.',
    };
  }

  let response: Record<string, unknown> | null = null;
  try {
    response = await client.tool(plan.call.tool, { ...plan.call.args }, { cache: false }) as Record<string, unknown> | null;
  } catch (e) {
    return {
      kind: 'refused', plan, response: null, verdict: null, rescopedFrom: null,
      why: 'The relay refused to register the agent: ' + errorCopy(e).d + ' Nothing was written.',
    };
  }
  const bad = refusal(response);
  if (bad) {
    return {
      kind: 'refused', plan, response, verdict: null, rescopedFrom: null,
      why: 'The relay refused to register the agent: ' + String(bad['message'] ?? bad['error']) + ' Nothing was written.',
    };
  }
  const rescopedFrom = response?.['rescoped'] === true && typeof response['previousScope'] === 'string'
    ? response['previousScope'] as string : null;

  // ── the read-back, which is the part that establishes anything ─────────────
  const label = typeof plan.call.args['label'] === 'string' ? plan.call.args['label'] as string : undefined;
  const verdict = await checkDelegation(client, {
    agentId: String(plan.call.args['agent_id']),
    podName: args.verifyOnPod,
    ...(label === undefined ? {} : { expectLabel: label }),
  });
  if (!verdict.ok) {
    return {
      kind: 'unconfirmed', plan, response, verdict, rescopedFrom,
      // Not "it failed": the write may well have landed. What is established is that reading the
      // pod back did not show it, and saying more than that would be inventing a fact either way.
      why: 'The relay accepted the registration, but reading your pod back did not confirm it: '
        + (verdict.why ?? 'no reason was given') + ' The row may still be there — what is established is that this read did not find it.',
    };
  }
  return {
    kind: 'published', plan, response, verdict, rescopedFrom,
    why: 'Published on pod ' + args.verifyOnPod + ' and read back from it: the delegation registry now lists '
      + verdict.agentId + ' with scope ' + (verdict.scope ?? 'none reported')
      + (rescopedFrom ? ', re-scoped from ' + rescopedFrom : '') + '.',
  };
}

/**
 * Withdraw a delegation, and check from the pod that it is gone.
 *
 * The read-back inverts: success is `checkDelegation` REFUSING. A revoke that reported success and
 * left the row standing would otherwise read to the user as a withdrawal that happened.
 */
export async function revokeDelegation(
  client: WorkspaceClient,
  args: { readonly agentId: string; readonly podName: string },
): Promise<{ readonly kind: 'refused' | 'still-listed' | 'revoked'; readonly why: string; readonly verdict: DelegationVerdict | null }> {
  try {
    const res = await client.tool('revoke_agent', { agent_id: args.agentId }, { cache: false }) as Record<string, unknown> | null;
    const bad = refusal(res);
    if (bad) return { kind: 'refused', why: 'The relay refused to revoke this agent: ' + String(bad['message'] ?? bad['error']), verdict: null };
  } catch (e) {
    return { kind: 'refused', why: 'The relay refused to revoke this agent: ' + errorCopy(e).d, verdict: null };
  }
  const verdict = await checkDelegation(client, { agentId: args.agentId, podName: args.podName });
  if (verdict.ok) {
    return {
      kind: 'still-listed', verdict,
      why: 'The relay accepted the revoke, but your pod still reports this agent as write-eligible. Nothing here is guessing at why; that is what reading the pod back said.',
    };
  }
  return {
    kind: 'revoked', verdict,
    why: 'Revoked, and read back from pod ' + args.podName + ': ' + (verdict.why ?? 'the registry no longer lists it')
      // Measured in delegation.ts's header — a user who sees one more message land after revoking
      // needs to know that is the cache, not a failed revoke.
      + '. The relay may still accept a write it had already cached permission for, for up to 60 seconds.',
  };
}
