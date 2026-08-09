/**
 * Affordance declarations for the shared-workspace (wsp:) vertical.
 *
 * ★ ONE AFFORDANCE, AND THE INPUT IS DELIBERATELY THIN. `wsp.respond_as_member` takes the
 * workspace and nothing else — no message, no prompt, no recipient, no body. That is the
 * contract that makes the reply the AGENT'S: a caller who could pass text would be the
 * author, and the agent would be a signature on somebody else's sentence.
 *
 * The capability is reached the same way every other vertical's is: a client dereferences
 * this manifest, finds the `iep:action` IRI, and follows the `hydra:target`. Through the
 * relay that is `invoke_affordance` / `act`, which is why a browser page with no ability to
 * make a cross-origin request can still cause an agent to act.
 */

import type { Affordance } from '../_shared/affordance-mcp/index.js';
import { actionUrl, type IRI } from '@interego/core';

/**
 * The one action this vertical defines, as a URL.
 *
 * ★ IT WAS `urn:iep:action:wsp:respond-as-member`, AND THAT FAILED SILENTLY IN THE WORST PLACE.
 * `capabilitiesFromAffordances` drops any affordance whose action is not `^https?://` — deliberately
 * and correctly, because an unfollowable capability advertised on a card is a promise the substrate
 * cannot keep. But the drop is a `continue` with no error, so the ONE thing a workspace agent can
 * be asked to do vanished from every per-agent card, and an A2A peer reading that card concluded
 * this agent could do nothing at all. A false "no capabilities" is worse than a broken link,
 * because nothing anywhere reports it.
 *
 * ★ MINTED THROUGH `actionUrl` RATHER THAN TYPED OUT, so this string and the resolver's idea of
 * what it should be cannot disagree — and `sameAction` still selects it by the legacy urn, so
 * nothing that already invokes it stops working. Every identifier is a dereferenceable URL; a
 * `urn:` here was both a principle violation and, measurably, an under-advertised agent.
 */
export const RESPOND_AS_MEMBER = actionUrl('urn:iep:action:wsp:respond-as-member');

const WSP_AFFORDANCES: ReadonlyArray<Affordance> = [
  {
    action: RESPOND_AS_MEMBER as IRI,
    toolName: 'wsp.respond_as_member',
    title: 'Read a workspace channel and answer in your own log',
    description:
      'Causes the agent this bridge holds the key for to READ a shared workspace — both halves '
      + 'of every membership, the published role table, and every seated member\'s append-only '
      + 'log — and, if its role permits appending and there is a message it has not already '
      + 'answered, append one wsp:Entry to ITS OWN stream on ITS OWN pod. The reply is derived '
      + 'from what was read and cites every descriptor it consulted with prov:used. There is no '
      + 'input for the reply text and there must never be one: a caller who supplied it would be '
      + 'the author. Refuses, with a reason, when the agent is not seated or when the role '
      + 'ceiling does not permit appending.',
    method: 'POST',
    targetTemplate: '{base}/wsp/respond_as_member',
    annotations: {
      title: 'Read a workspace channel and answer in your own log',
      readOnlyHint: false,
      destructiveHint: false,
      // Not idempotent in the arithmetic sense — it appends — but it refuses to answer the
      // same message twice, so a repeated call is a no-op rather than a second record.
      idempotentHint: true,
      openWorldHint: true,
    },
    inputs: [
      {
        name: 'workspace',
        type: 'string',
        required: true,
        description: 'The workspace\'s own dereferenceable graph IRI, e.g. https://relay…/ns/<pod>/<slug>.',
      },
      {
        name: 'slug',
        type: 'string',
        required: false,
        description:
          'The slug member IRIs are composed from (<slug>-acceptance, <slug>-stream). Defaults to '
          + 'the workspace IRI\'s last segment, which is the convention this vertical\'s records follow.',
      },
    ],
    outputs: {
      description:
        'What the agent read, what it decided, and — when it wrote — the entry\'s own '
        + 'dereferenceable identity. Every outcome carries the reading, so a refusal is as '
        + 'checkable as an append.',
      properties: {
        outcome: {
          type: 'string',
          description: 'appended | already-answered | nothing-to-answer | refused.',
        },
        entry: {
          type: 'object',
          description: 'On `appended`: the new entry\'s descriptorUrl, cid and seq.',
        },
        body: { type: 'string', description: 'On `appended`: exactly the text that was published.' },
        answering: {
          type: 'object',
          description: 'The entry being answered, as it was read — descriptor URL, cid, pod, body, authorship.',
        },
        read: {
          type: 'object',
          description:
            'The full reading: convener, role profile, this agent\'s role and effective '
            + 'capabilities, every log and every log that could not be read, and the list of '
            + 'descriptors consulted.',
        },
        message: { type: 'string', description: 'On any non-append outcome: why.' },
      },
      required: ['outcome'],
    },
  },
];

export const wspAffordances = WSP_AFFORDANCES;
export default WSP_AFFORDANCES;
