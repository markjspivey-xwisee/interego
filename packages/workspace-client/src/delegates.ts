/**
 * WHAT A WORKSPACE ADDS TO A DELEGATE — and nothing else.
 *
 * ★ THE DELEGATE ITSELF IS NOT HERE ANY MORE, AND THAT IS THE POINT. "An identity a person
 * authorises to act for them" is an Interego concept, not a workspace one: it now lives in
 * `@interego/core/delegate`, beside the `AuthorizedAgentData` / signed-VC / `verifyDelegation`
 * model it belongs to, where the Discord conduit, the desktop shell, Foxxi and any later vertical
 * reach it from the layer BELOW rather than sideways out of a peer vertical's client package.
 * This file kept exactly two things, because only two of them are about workspaces:
 *
 *   1. {@link delegateCeiling} — the substrate's scope ceiling AND the workspace's role ceiling,
 *      applied in that order. The scope half is `scopeCeiling` from the substrate; the role half
 *      needs a `RoleTable`, which is a workspace document, so the composition is the vertical's.
 *   2. {@link readEntryAuthorship} — a Turtle adapter. The JUDGMENT (all eight answers, the
 *      two-document cross-check, `disputed` rather than a guess) is `judgeAuthorship` at the
 *      substrate; what is local is only knowing how to get two IRI lists out of THIS vertical's
 *      signed region format.
 *
 * The substrate names are re-exported below so the artifact bundle, which is generated from this
 * package's entry point, pulls the SUBSTRATE implementation into itself rather than a copy.
 */

import {
  scopeCeiling, judgeAuthorship,
  type CeilingVerdict, type DelegateRegistryPort, type DelegateRoster, type EntryAuthorship,
} from '@interego/core/delegate';
import { checkRoleForWorkspace, type RoleTable } from './membership.js';
import { readIriAll } from './turtle.js';
import { errorCopy, type WorkspaceClient } from './substrate.js';

/**
 * Bind this package's transport and error copy to the substrate's delegate affordance.
 *
 * ★ THE ADAPTER IS THE WHOLE OF WHAT A VERTICAL OWES THE SUBSTRATE HERE. `WorkspaceClient` already
 * satisfies `DelegateRegistryPort.tool` structurally; what it cannot supply is `describeError`,
 * which turns a `ToolCallError` code into the sentence this vertical's surfaces show. Without it
 * a refused delegation would read as a raw error code in a consent dialog, which is where copy
 * matters most.
 */
export const delegatePort = (client: WorkspaceClient): DelegateRegistryPort => ({
  tool: (name, args, opts) => client.tool(name, args, opts),
  describeError: (e) => errorCopy(e).d,
});

/**
 * May this delegate append to its delegator's log in this workspace?
 *
 * ★ TWO CEILINGS, BOTH NARROWING, NEITHER GRANTING.
 *
 *   1. THE WORKSPACE'S, on the person. A role is a ceiling the workspace publishes and the
 *      delegate inherits it UNCHANGED — a delegate of a member cannot be more of a member than
 *      the member. This is the same test the person's own post passes, on the same seat.
 *   2. THE DELEGATOR'S, on this delegate. `scopeCeiling` at the substrate: the scope on this
 *      delegate's own registry row is the only thing a person controls PER DELEGATE, and a
 *      delegate given `ReadOnly` cannot post even though its delegator can.
 *
 * ★ AND WHAT IS DELIBERATELY NOT CLAIMED. The role table permits capability IRIs, and nothing
 * published maps a delegation scope onto them — `applications/shared-workspace/src/can.ts` maps
 * scopes onto the DEFAULT profile's capability IRIs, which a workspace publishing its own profile
 * does not use. So the two ceilings are applied SEQUENTIALLY, exactly as `canAct` does, and this
 * does not pretend to intersect two capability sets that are not in the same vocabulary. That
 * refusal is also why the substrate half is a separate function rather than one that takes a role:
 * the substrate has no opinion about a workspace's role vocabulary and must not acquire one.
 */
export function delegateCeiling(args: {
  readonly roles: RoleTable;
  /** The role on the DELEGATOR's seat. */
  readonly role: string | null;
  /** The scope on this delegate's row, or null when the registry did not report one. */
  readonly scope: string | null;
  readonly delegateName: string | null;
}): CeilingVerdict {
  const who = args.delegateName ? '"' + args.delegateName + '"' : 'this delegate';
  const role = checkRoleForWorkspace(args.roles, args.role ?? '');
  if (!role.ok) {
    return {
      ok: false,
      why: 'The role ceiling on the seat ' + who + ' would write under refuses this. ' + role.why
        + ' A delegate inherits its delegator\'s role and cannot exceed it, so nothing is written.',
    };
  }
  const scope = scopeCeiling({ scope: args.scope, delegateName: args.delegateName });
  if (!scope.ok) return scope;
  return {
    ok: true,
    why: 'The seat\'s role permits this, and ' + scope.why.charAt(0).toLowerCase() + scope.why.slice(1)
      + ' Both ceilings hold; neither of them granted anything on its own.',
  };
}

/**
 * Read the authorship of one entry out of its signed Turtle region.
 *
 * ★ A PARSER ADAPTER, AND ONLY THAT. Everything that DECIDES anything — that `unstated` is not
 * "the owner wrote it", that two authors is `disputed` rather than a pick, that a footing the
 * record does not state is `not-stated` and never a default in somebody's favour, that a
 * Delegation must name the pod's own owner, and that the owner's registry must list the agent —
 * is `judgeAuthorship` at the substrate, where a vertical reading JSON-LD or a parsed store gets
 * the same answers from the same code. What is local here is that this vertical's entries are
 * Turtle and `readIriAll` is how its signed regions are read.
 *
 * ★ SIX LISTS, NOT TWO, AND EVERY ONE OF THEM IS `readIriAll` FOR THE SAME REASON. These readers
 * are REGION-scoped: they find a predicate anywhere in the block and return its objects, and the
 * author of the block controls its bytes. So the only safe way to read a field that decides who is
 * answerable for a sentence is to take EVERY object and let the judge refuse anything but one. A
 * `readIri` here would silently return whichever the author put first.
 *
 * ★ AND THIS IS WHY THE FOOTING NODES ARE NAMED RATHER THAN BLANK. A region-scoped regex cannot
 * follow `[ a prov:Delegation ; … ]` back to the subject it hangs off, so a blank node would leave
 * `prov:agent` and `prov:hadActivity` floating with nothing to tie them to this record's own act.
 * With fragment IRIs the judge can demand that the Delegation's `prov:hadActivity` BE the
 * `prov:wasGeneratedBy` of this entry — which is the check that makes the footing per-act rather
 * than merely present.
 *
 * ★ AND `signedBy` DOES NOT COME OUT OF THE REGION, WHICH IS THE ONLY REASON ANY OF THE ABOVE IS
 * WORTH READING. Every list below is bytes the pod's writer controls. The signer is the relay's
 * answer about the key it authenticated — `readAuthorship(descriptor.authorship).signerAgent` — and
 * a caller that has a region but no descriptor passes null and gets `disputed` for any record
 * claiming an agent wrote it. See {@link judgeAuthorship}.
 */
export function readEntryAuthorship(
  region: string | null,
  args: {
    readonly logOwnerWebId: string | null;
    readonly delegates: DelegateRoster | null;
    readonly signedBy: string | null;
  },
): EntryAuthorship {
  return judgeAuthorship(
    region === null ? null : {
      attributedTo: readIriAll(region, 'prov:wasAttributedTo'),
      generatedBy: readIriAll(region, 'prov:wasGeneratedBy'),
      qualifiedDelegation: readIriAll(region, 'prov:qualifiedDelegation'),
      delegationAgent: readIriAll(region, 'prov:agent'),
      delegationActivity: readIriAll(region, 'prov:hadActivity'),
      actedOnOwnAccount: readIriAll(region, 'iep:actedOnOwnAccount'),
    },
    args,
  );
}

/**
 * The substrate's delegate surface, re-exported so this package's consumers — and the generated
 * artifact bundle — reach ONE implementation. Nothing below is defined here.
 */
export {
  DELEGATE_SURFACE, DELEGATE_LABEL_PREFIX, DELEGATE_NAME_MAX,
  DELEGATION_SCOPES, WRITE_ELIGIBLE_SCOPES, isDelegationScope, scopeWriteEligible, AGENT_ID_RX,
  delegateLabel, parseDelegateLabel, delegateNameProblem, delegateAgentId,
  isDelegateRow, readDelegates, delegatePlan, publishDelegation, revokeDelegation,
  scopeCeiling, judgeAuthorship, authorshipLine, footingLine, signerLine, agentPodOf,
  footingTurtle, footingActivityIri, footingDelegationIri,
} from '@interego/core/delegate';
export type {
  DelegateRow, DelegateRoster, DelegateRegistryPort, DelegateField, DelegateProblem,
  DelegatePlan, DelegateOutcome, CeilingVerdict, EntryAuthorship, DelegationScope,
  EntryFooting, StatedFooting, AuthorshipStatements, EntrySigner,
} from '@interego/core/delegate';
