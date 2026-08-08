/**
 * READING THE MEMBER A DELEGATE IS ACTING FOR — and nothing else.
 *
 * ★ WHAT WAS HERE AND IS NOW A LAYER DOWN, AND WHY IT HAD TO MOVE. This file held two things that
 * had no business being in one file. One of them read a workspace {@link Viewer}. The other —
 * `checkDelegation`, and `readAuthorship` beside it — asked the RELAY whether an agent may write to
 * somebody's pod: a pod's own delegation registry, `verify_agent`'s enforcement block, the two
 * echo checks, and what the relay's signature on a descriptor does and does not prove. Not one
 * sentence of that is about workspaces. It is the same question the Discord conduit asks before it
 * relays a message, the desktop shell asks before a delegate speaks, and any later vertical will
 * ask before writing to a pod it does not own — and an authorization decision that exists twice is
 * the defect this package was built to prevent.
 *
 * They now live in `@interego/core/delegate`, beside `readDelegates`, `scopeCeiling` and
 * `judgeAuthorship`, and are re-exported at the bottom of this file so no call site had to change.
 * Two things got strictly better in the move rather than merely relocating:
 *
 *   · `DelegationRow` is GONE. It was `{agentId, scope, label, validFrom}` — a four-field
 *     re-spelling of `AuthorizedAgentData` that could not represent a revocation, sitting beside
 *     `DelegateRow`, which is one. `checkDelegation` now returns a `DelegateRow`, so the row you
 *     get from a verdict and the row you get from a roster are the same row.
 *   · `Check` is the substrate's. The findings inside a substrate verdict were typed by a
 *     workspace module, which meant the layer below depended on the layer above to describe its
 *     own answers.
 *
 * ★ AND THE MEASUREMENT THAT MAKES ANY OF IT WORTH DOING STAYS TRUE. Measured end to end against
 * the live relay, 2026-08-07, with three freshly minted disposable identities (BOT, ALICE, BOB):
 * ALICE `register_agent` for BOT at `PublishOnly` → BOT reads ALICE's registry cross-pod → BOT
 * `verify_agent` reports `writeEligible:true` on basis "signed-chain" → BOT `publish_context` onto
 * ALICE's pod is accepted, and onto BOB's pod is refused `403 scope_violation`. Then ALICE
 * `revoke_agent` → `verify_agent` immediately reports `writeEligible:false`, AND THE BOT'S NEXT
 * WRITE ON ALICE'S POD WAS STILL ACCEPTED: the relay's scope gate caches its verdict per
 * (agent, pod) for 60 s on this deployment. A delegate must therefore not treat "the relay would
 * have stopped me" as the boundary — it has to ask before it writes and stop itself, which is why
 * `checkDelegation` passes `cache: false` on both reads.
 */

import {
  checkDelegation as checkDelegationOnPod, type DelegationVerdict,
} from '@interego/core/delegate';
import { podOfDescriptorUrl } from './naming.js';
import type { WorkspaceClient } from './substrate.js';
import { fail, refusal } from './transport.js';
import { delegatePort } from './delegates.js';
import type { Viewer } from './membership.js';

/**
 * The member a delegate is acting FOR, read from THEIR pod rather than from the session.
 *
 * ★ `agentDid` AND `agentScope` ARE ALWAYS NULL HERE, AND THAT IS THE POINT. `get_pod_status`
 * called with somebody else's `pod_name` still reports `sessionAgent` — and it is the CALLER'S
 * agent, not theirs. `resolveInvitee` records the same measured trap. A `Viewer` built by
 * copying that field would carry the delegate's own agent under the member's name, and
 * `checkWriteEligibility` would then answer "yes, you may write" about the wrong party
 * entirely. So the fields are not populated, and the question they exist for is asked by
 * {@link checkDelegation} instead, which names both parties explicitly.
 */
export async function readMember(client: WorkspaceClient, podName: string): Promise<Viewer> {
  // No cache: a member is read at the moment of acting for them, and a two-minute-old answer
  // about somebody else's pod is exactly how a client keeps acting on a stale picture of it.
  const status = await client.tool('get_pod_status', { pod_name: podName }, { cache: false }) as Record<string, unknown> | null;
  const bad = refusal(status);
  if (bad) throw fail('tool_error', String(bad['message'] ?? bad['error']));
  const podUrl = String(status?.['pod'] ?? status?.['podUrl'] ?? '');
  const served = podOfDescriptorUrl(podUrl) ?? podUrl.replace(/\/$/, '').split('/').pop() ?? '';
  // THE ECHO IS CHECKED, like every other cross-pod read in this package. A status that
  // answered for a different pod would hand back a WebID belonging to somebody else, and that
  // WebID is what a grant and an acceptance are written about.
  if (served !== podName) {
    throw fail('tool_error', 'get_pod_status was asked for pod ' + podName + ' and answered for '
      + (served || 'a pod this reader could not name') + '. These disagree, so nothing is being read out of it.');
  }
  const registry = status?.['registry'] as { owner?: string } | undefined;
  const delegation = status?.['delegationRegistry'] as { owner?: string } | undefined;
  const webId = registry?.owner ?? delegation?.owner ?? '';
  if (!webId) {
    throw fail('tool_error', 'pod ' + podName + ' reports no registry owner, so there is no WebID to name as the author of anything written there.');
  }
  return {
    podName, podUrl,
    displayName: (status?.['displayName'] as string) ?? null,
    css: String(status?.['css'] ?? ''),
    webId,
    // See the header on this function. Not "unknown" — deliberately not read.
    agentDid: null,
    agentScope: null,
  };
}

/**
 * Ask whether a delegation stands on a pod, with THIS package's pod-URL naming supplied.
 *
 * ★ THE ONE THING THE SUBSTRATE CANNOT SUPPLY IS `podOfUrl`, AND IT IS REQUIRED THERE RATHER THAN
 * DEFAULTED. `checkDelegation` compares the pod `get_pod_status` says it answered for against the
 * pod it was asked about — a real defect the relay has had — and naming a pod from a URL is a fact
 * about a deployment's layout, not about delegation. The substrate declines to guess; this binds
 * the same `podOfDescriptorUrl` every other cross-pod read in this package uses, so the two cannot
 * disagree about which pod a URL belongs to.
 */
export function checkDelegation(
  client: WorkspaceClient,
  args: { readonly agentId: string; readonly podName: string; readonly expectLabel?: string },
): Promise<DelegationVerdict> {
  return checkDelegationOnPod(delegatePort(client), { ...args, podOfUrl: podOfDescriptorUrl });
}

/**
 * The substrate's delegation-authority surface, re-exported so this package's consumers — and the
 * generated artifact bundle — reach ONE implementation. Nothing below is defined here.
 */
export { readAuthorship } from '@interego/core/delegate';
export type { DelegationVerdict, AuthorshipReading, Check } from '@interego/core/delegate';
