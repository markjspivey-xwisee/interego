/**
 * ACTING FOR SOMEBODY ELSE, and the evidence that says you may.
 *
 * The artifact and the desktop shell are the person: the identity that authenticates the tool
 * call is the identity whose pod the write lands on, and the only question is whether the relay
 * will let them write to their own pod ({@link checkWriteEligibility}).
 *
 * A NON-INTERACTIVE client is not the person. A chat bot sits in a thread, holds no credential
 * of anybody's, and is asked to put their words on THEIR pod. There are two ways to do that and
 * only one of them is defensible:
 *
 *   · hold the user's own bearer. A relay OAuth bearer is their WHOLE identity — it can
 *     `register_agent` with `tenant_admin`, revoke their other agents, read their inbox, publish
 *     anything anywhere they can. Revoking it means asking the holder to delete it.
 *   · be DELEGATED on their pod. `register_agent` is own-pod gated (`requireOwnPod`), so the row
 *     can only be written by the pod owner from their own authenticated session; the relay's
 *     publish-time scope gate reads that row and nothing else; and `revoke_agent` is the owner's
 *     unilateral act, which works whether or not the delegate cooperates and whether or not the
 *     delegate is even running.
 *
 * This file is the second one. It is in the shared package rather than in one client because
 * every check below is a statement about the substrate, not about a chat platform — and the one
 * thing this vertical cannot afford is a second copy of a membership decision.
 *
 * ★ MEASURED END TO END AGAINST THE LIVE RELAY, 2026-08-07, with three freshly minted disposable
 * identities (BOT, ALICE, BOB) and no prior state between them:
 *
 *   ALICE  register_agent {agent_id: BOT, scope:"PublishOnly", label:"discord-link <code>"}
 *                                        -> {registered:true, scope:"PublishOnly"} + a signed
 *                                           delegation credential on ALICE's pod
 *   BOT    get_pod_status {pod_name: ALICE}
 *                                        -> delegationRegistry.rows carries the BOT's row WITH
 *                                           the label, read cross-pod
 *   BOT    verify_agent {agent_id: BOT, pod_name: ALICE}
 *                                        -> verified:true, basis "signed-chain",
 *                                           enforcement.writeEligible:true
 *   BOT    publish_context {pod_name: ALICE, …}
 *                                        -> accepted, descriptorUrl on ALICE's pod
 *   BOT    publish_context {pod_name: BOB, …}   (BOB delegated nothing)
 *                                        -> 403 scope_violation "agent is not registered on
 *                                           this pod"
 *   ALICE  revoke_agent {agent_id: BOT}  -> {revoked:true}; verify_agent immediately reports
 *                                           writeEligible:false, basis "none"
 *
 * ★ AND ONE FINDING THAT IS NOT A DETAIL. Immediately after the revoke, the BOT's next
 * `publish_context` on ALICE's pod was STILL ACCEPTED. The relay's scope gate caches its verdict
 * per (agent, pod) for `AGENT_REGISTRATION_CACHE_TTL_MS` — 60 s on this deployment — so a
 * withdrawal is enforced by the relay only after that window. `verify_agent` is not cached and
 * answered correctly the instant the revoke landed. A delegate must therefore not treat "the
 * relay would have stopped me" as the boundary: it has to ask before it writes and stop itself.
 * {@link checkDelegation} is that ask, and it passes `cache: false` for the same reason.
 */

import { podOfDescriptorUrl } from './naming.js';
import { errorCopy, type WorkspaceClient } from './substrate.js';
import { fail, refusal } from './transport.js';
import type { Check, Viewer } from './membership.js';

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

/** One row of a pod's delegation registry, as `get_pod_status` reports it. */
export interface DelegationRow {
  readonly agentId: string;
  readonly scope: string | null;
  readonly label: string | null;
  readonly validFrom: string | null;
}

/** What asking "may this agent write to that pod, and did that pod's owner say so" established. */
export interface DelegationVerdict {
  readonly agentId: string;
  readonly podName: string;
  readonly checks: readonly Check[];
  /** True only when EVERY check that ran is a finding in favour. A `q` never makes this true. */
  readonly ok: boolean;
  readonly why: string | null;
  /** The row the pod's own registry carries for this agent, when it carries one. */
  readonly row: DelegationRow | null;
  readonly scope: string | null;
  /** `signed-chain`, `registry-only`, `none` — the relay's word for what it is relying on. */
  readonly basis: string | null;
  /** Which pod `verify_agent` says it examined. Null when it did not say. */
  readonly examinedPod: string | null;
}

/**
 * Does `agentId` have write authority on `podName`, and does that pod's owner say the
 * delegation is for a particular party?
 *
 * TWO QUESTIONS, AND THE SECOND ONE IS WHY THIS EXISTS. `verify_agent` answers the first
 * completely and answers the second not at all. A delegate that only asked the first would
 * accept ANY claimant's word for which pod is theirs: the moment one person delegates the
 * delegate, every other person can name that pod and have their words written onto it.
 *
 * `expectLabel` closes that. `register_agent` is own-pod gated, so a row's `label` is a string
 * only that pod's owner can have written — it is the owner naming, in their own document, who
 * this delegation is for. A delegate holds the claimant to it.
 *
 * ★ AND THE LABEL MUST NOT BE A SECRET, WHICH IS THE OPPOSITE OF THE OBVIOUS DESIGN. MEASURED:
 * `get_pod_status { pod_name: <anyone's> }` answers for any pod and returns the registry rows
 * WITH their labels. So a challenge-response scheme where the delegate mints a nonce and asks
 * the claimant to publish it is a scheme that publishes the nonce: the first party to read that
 * pod can present the same nonce and be believed. The label has to be a value that identifies
 * the intended party and is worthless to anybody else — the caller's own account identifier on
 * whatever platform it is bridging — and the caller must derive `expectLabel` from the identity
 * of the party actually asking, never from something they were told. Compared with `===` for
 * that reason: there is no secret here, so there is nothing for a constant-time compare to
 * protect, and a helper that implied otherwise would be documenting a property this does not have.
 *
 * Omit `expectLabel` to ask only the authority question — which is the right question at WRITE
 * time, when the binding was already established and what has changed since is whether the
 * delegation still stands.
 */
export async function checkDelegation(
  client: WorkspaceClient,
  args: {
    readonly agentId: string;
    readonly podName: string;
    /** The exact `label` the row must carry, when a binding is being established. */
    readonly expectLabel?: string;
  },
): Promise<DelegationVerdict> {
  const checks: Check[] = [];
  const no = (why: string, extra?: Partial<DelegationVerdict>): DelegationVerdict => {
    checks.push({ mark: 'n', text: why });
    return { agentId: args.agentId, podName: args.podName, checks, ok: false, why, row: null, scope: null, basis: null, examinedPod: null, ...extra };
  };

  // ── 1. the pod's OWN registry, which only its owner can write ──────────────
  let status: Record<string, unknown> | null;
  try { status = await client.tool('get_pod_status', { pod_name: args.podName }, { cache: false }) as Record<string, unknown> | null; }
  catch (e) { return no('the delegation registry on ' + args.podName + ' could not be read (' + errorCopy(e).t.toLowerCase() + '), so whether it names this agent is not established'); }
  const bad = refusal(status);
  if (bad) return no('the read of ' + args.podName + ' was refused: ' + String(bad['message'] ?? bad['error']));
  const served = podOfDescriptorUrl(String(status?.['pod'] ?? '')) ?? null;
  if (served && served !== args.podName) {
    return no('get_pod_status was asked about pod ' + args.podName + ' and answered for pod ' + served
      + '. These disagree, so no delegation is being read out of it.');
  }
  const reg = status?.['delegationRegistry'] as { rows?: readonly Record<string, unknown>[] } | null | undefined;
  if (!reg) {
    return no('pod ' + args.podName + ' reports no delegation registry at all, so whether it delegates anything to this agent '
      + 'is not established — that is different from it delegating nothing');
  }
  const raw = Array.isArray(reg.rows) ? reg.rows : [];
  const hit = raw.find((r) => r && r['agentId'] === args.agentId);
  if (!hit) {
    return no('pod ' + args.podName + '\'s own delegation registry lists ' + raw.length + ' live agent'
      + (raw.length === 1 ? '' : 's') + ' and this one is not among them. Nothing was written.');
  }
  const row: DelegationRow = {
    agentId: String(hit['agentId']),
    scope: typeof hit['scope'] === 'string' ? hit['scope'] : null,
    label: typeof hit['label'] === 'string' ? hit['label'] : null,
    validFrom: typeof hit['validFrom'] === 'string' ? hit['validFrom'] : null,
  };
  checks.push({ mark: 'y', text: 'Pod ' + args.podName + '\'s own delegation registry — a document only its owner can write — lists this agent with scope ' + (row.scope ?? 'none reported') });

  // ── 2. the secret, when one is being asked for ─────────────────────────────
  if (args.expectLabel !== undefined) {
    if (row.label === null) {
      return no('that row carries no label, so this pod\'s owner has not said who the delegation is for. '
        + 'A row with no label is not evidence against the claimant — it is no evidence either way, and a binding is not made on no evidence.', { row, scope: row.scope });
    }
    if (row.label !== args.expectLabel) {
      return no('that row\'s label is "' + row.label + '", and the delegation would have to be labelled "' + args.expectLabel
        + '" to be a delegation for the party asking. It must be that exactly, with nothing before or after it.', { row, scope: row.scope });
    }
    checks.push({ mark: 'y', text: 'Its label is "' + args.expectLabel + '" — this pod\'s owner naming, in a document only they can write, who the delegation is for' });
  }

  // ── 3. what the relay will actually DO, which is not the same question ─────
  let v: Record<string, unknown> | null;
  try { v = await client.tool('verify_agent', { agent_id: args.agentId, pod_name: args.podName }, { cache: false }) as Record<string, unknown> | null; }
  catch (e) { return no('verify_agent did not answer (' + errorCopy(e).t.toLowerCase() + '), so what the relay would enforce here is not established', { row, scope: row.scope }); }
  const vbad = refusal(v);
  if (vbad) return no('verify_agent was refused: ' + String(vbad['message'] ?? vbad['error']), { row, scope: row.scope });
  const examinedPod = typeof v?.['subject_pod_name'] === 'string' ? v['subject_pod_name'] as string : null;
  // ★ THE ECHO, AND THE DEFECT IT CLOSES IS IN THE RELAY'S OWN HISTORY. `verify_agent` once
  // answered about the CALLER's pod when asked by `pod_name`, and the wrong answer was shaped
  // exactly like the right one. The field exists so that is checkable; not checking it would
  // leave the fix unused.
  if (examinedPod !== null && examinedPod !== args.podName) {
    return no('verify_agent was asked about pod ' + args.podName + ' and its answer says it examined pod ' + examinedPod
      + '. These disagree, so it is not being read as a verdict about either.', { row, scope: row.scope, examinedPod });
  }
  const enf = v?.['enforcement'] as Record<string, unknown> | undefined;
  if (!enf) {
    return no('verify_agent answered without an enforcement block, so what the relay grants this agent on ' + args.podName
      + ' is not established here', { row, scope: row.scope, examinedPod });
  }
  const basis = typeof enf['basis'] === 'string' ? enf['basis'] : null;
  const scope = typeof enf['scope'] === 'string' ? enf['scope'] : row.scope;
  if (enf['writeEligible'] !== true) {
    return no('the relay reports this agent is not write-eligible on ' + args.podName + ' (basis ' + (basis ?? 'not reported')
      + ', scope ' + (scope ?? 'not reported') + '). ' + String(enf['note'] ?? '')
      + ' A write would be refused, so it is not attempted.', { row, scope, basis, examinedPod });
  }
  checks.push({ mark: 'y', text: 'The relay reports this agent write-eligible on ' + args.podName + ' with scope ' + (scope ?? 'not reported') + ', on basis "' + (basis ?? 'not reported') + '"' });
  // Reported rather than folded into the verdict: it is what the relay is relying on, and
  // "the pod owner wrote the row but the signed chain does not anchor" is a real state a reader
  // should see rather than have decided for them.
  if (basis === 'registry-only') {
    checks.push({ mark: 'q', text: 'The signed delegation credential did not anchor; the relay is enforcing this from the pod\'s own registry alone. That registry is still a document only the pod owner can write, so it is authorisation — it is just not a cryptographic chain.' });
  }
  return { agentId: args.agentId, podName: args.podName, checks, ok: true, why: null, row, scope, basis, examinedPod };
}

/**
 * WHAT THE SIGNATURE ON ONE OF THESE DESCRIPTORS PROVES, AND WHAT IT DOES NOT.
 *
 * ★ THIS IS NOT COMMENTARY. Every client in this vertical renders an authorship block, and the
 * temptation in all three is to print "signed by <name>" — which readers take to mean that
 * person's own key. MEASURED on the live relay, on a delegated write and on an own-pod write
 * alike: `verificationMethod` is `did:ethr:0xd144353a…3331`, ONE key, the relay's own delegation
 * signer, identical for every pod and every agent on this deployment. `issuer` is the agent the
 * relay authenticated. So the proof is the RELAY's attestation about who asked, not the author's
 * attestation about what they wrote — and the difference matters most in exactly the case that
 * makes it easiest to miss, where the agent that asked is not the person whose pod it landed on.
 */
export interface AuthorshipReading {
  /** Did a proof arrive at all? Absence is reported as absence, never as an unsigned verdict. */
  readonly present: boolean;
  /** The agent the relay authenticated when it signed. Null when none was reported. */
  readonly signerAgent: string | null;
  /** The key the signature verifies against. On this relay: the relay's own. */
  readonly verificationMethod: string | null;
  /** `bound-at-signing` | `unbound` | whatever the relay reported. */
  readonly contentBinding: string | null;
  readonly proves: readonly string[];
  readonly doesNotProve: readonly string[];
}

export function readAuthorship(a: unknown): AuthorshipReading {
  if (!a || typeof a !== 'object') {
    return {
      present: false, signerAgent: null, verificationMethod: null, contentBinding: null,
      proves: [],
      doesNotProve: ['No authorship block came back with this descriptor, so nothing is established about who wrote it. That is not the same as it being unsigned.'],
    };
  }
  const p = a as Record<string, unknown>;
  const signer = typeof p['signer'] === 'string' ? p['signer'] as string
    : typeof p['signedBy'] === 'string' ? p['signedBy'] as string : null;
  const vm = typeof p['verificationMethod'] === 'string' ? p['verificationMethod'] as string : null;
  const binding = typeof p['contentBinding'] === 'string' ? p['contentBinding'] as string : null;
  const signed = p['signed'] === true || p['authorshipVerified'] === true;
  const proves: string[] = [];
  const doesNot: string[] = [];
  if (signed) {
    proves.push(signer
      ? 'The relay signed a statement that the caller it had authenticated as ' + signer + ' published this descriptor.'
      : 'The relay signed a statement about this descriptor, and the response named no agent in it.');
    if (binding === 'bound-at-signing') {
      proves.push('The signed payload commits to a digest of the entry\'s canonical triples, so the text cannot be changed afterwards without the proof failing.');
    } else if (binding === 'unbound') {
      doesNot.push('The proof carries no content digest, so it covers WHICH descriptor was written and not WHAT it says. The text could be replaced and the proof would still verify.');
    } else if (binding !== null) {
      doesNot.push('The content binding is reported as "' + binding + '", which is neither a check that passed nor one that failed — nothing was verified about the text here.');
    }
  } else {
    doesNot.push('The block reports no successful signature, so who asked for this write is not established by it.');
  }
  doesNot.push(vm
    ? 'The signature verifies against ' + vm + ' — the relay\'s own delegation key, the same one for every pod and every agent on this deployment. It is NOT the author\'s wallet, and it is not evidence that any human key signed anything.'
    : 'The block names no verification method, so what key this would verify against is not established.');
  doesNot.push('It says nothing about whether the pod owner authorised the agent named above. That is a separate document — the pod\'s own delegation registry — and it is what checkDelegation reads.');
  return { present: true, signerAgent: signer, verificationMethod: vm, contentBinding: binding, proves, doesNotProve: doesNot };
}
