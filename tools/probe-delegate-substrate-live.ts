/**
 * THE DELEGATE AFFORDANCE, DRIVEN LIVE WITH NO VERTICAL IN THE LOOP.
 *
 * ★ WHAT THIS PROBE IS FOR. `@interego/core/delegate` was moved down out of
 * `@interego/workspace-client`, and the shared-workspace live driver
 * (`applications/shared-workspace/tools/drive-local-agent-live.ts`) already exercises it end to
 * end — but through that vertical's client, its seats, its role table and its entry format. That
 * run cannot distinguish "the substrate owns this" from "the vertical still does and the imports
 * merely moved". This one can: every delegate call below comes from `@interego/core/delegate`,
 * and there is no `WorkspaceClient`, no workspace, no seat, no roster, no role and no `wsp:`
 * term anywhere in the file.
 *
 * ★ WHAT IT STILL BORROWS, STATED RATHER THAN HIDDEN. Two pieces of plumbing come from the
 * workspace tools because that is where they happen to live today, and neither is delegate logic:
 *
 *   · `mintBearer` — the headless SIWE sign-in. Duplicating it here is what
 *     `tests/workspace-live-identity-parity.test.ts` exists to prevent.
 * The point stands regardless: the affordance is reached through a PORT, so anything that can
 * call a relay tool can drive it. Here that port is three lines.
 *
 * ★ AND THE SECOND IMPORT IS NO LONGER A VERTICAL'S. `RelayMcpTransport` was the other thing this
 * header called out — "generic infrastructure sitting in a vertical; a candidate for the same
 * treatment as the delegate". It got it: `@interego/core/relay`. This file now reaches nothing in
 * `@interego/workspace-client` at all.
 *
 *   npx tsx tools/probe-delegate-substrate-live.ts
 *
 * Every identity is freshly minted and disposable; runtime pod data is throwaway.
 */

import { Wallet } from 'ethers';
import {
  DELEGATE_SURFACE, authorshipLine, delegateAgentId, delegateLabel, delegatePlan, judgeAuthorship,
  publishDelegation, readDelegates, revokeDelegation, scopeCeiling,
  type AuthorshipStatements, type DelegateRegistryPort,
} from '@interego/core/delegate';
import { RelayMcpTransport } from '@interego/core/relay';
import { mintBearer } from '../applications/shared-workspace/tools/live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
const IDENTITY_HOST = new URL(IDENTITY).host;

const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };
const head = (s: string): void => { log('\n== ' + s + ' ' + '='.repeat(Math.max(0, 64 - s.length))); };

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  log((ok ? '  [ok]   ' : '  [FAIL] ') + name + (detail ? ' - ' + detail : ''));
  if (!ok) failures++;
}

/** The whole of what the substrate needs from a caller. Three lines, and no vertical types. */
const portFor = (tx: RelayMcpTransport): DelegateRegistryPort => ({
  tool: (name, args, opts) => tx.callTool(name, args, opts),
  describeError: (e) => String((e as { message?: unknown }).message ?? e),
});

async function main(): Promise<void> {
  head('0 - two fresh identities: a person, and a key they will authorise');
  const person = Wallet.createRandom();
  const delegateKey = Wallet.createRandom();

  const personBearer = await mintBearer(RELAY, IDENTITY, person);
  const personTx = new RelayMcpTransport(RELAY, personBearer);
  const port = portFor(personTx);

  const podStatus = await personTx.callTool('get_pod_status', {}, { cache: false }) as Record<string, unknown>;
  const podName = String(podStatus['displayName'] ?? '');
  const webId = String((podStatus['delegationRegistry'] as { owner?: unknown } | undefined)?.owner ?? '');
  check('the person has a pod', podName.length > 0, podName);
  check('and a WebID the registry names as its owner', webId.length > 0, webId);

  // The delegate signs in under the SHARED surface constant, never this probe's own name.
  const delegateBearer = await mintBearer(RELAY, IDENTITY, delegateKey, DELEGATE_SURFACE);
  const delegateTx = new RelayMcpTransport(RELAY, delegateBearer);
  const dStatus = await delegateTx.callTool('get_pod_status', {}, { cache: false }) as Record<string, unknown>;
  const delegatePod = String(dStatus['displayName'] ?? '');
  const agentId = delegateAgentId(IDENTITY_HOST, delegatePod);
  const attested = String((dStatus['sessionAgent'] as { did?: unknown } | undefined)?.did ?? '');
  check('the agent id the substrate COMPUTES matches the one the relay issued', agentId === attested,
    agentId === attested ? agentId : 'computed ' + agentId + ' but relay attested ' + attested);

  head('1 - nothing is authorised yet, and absence reads as absence');
  const before = await readDelegates(port, podName);
  check('the registry reads, and lists no delegates', before.read && before.delegates.length === 0,
    'read=' + before.read + ' delegates=' + before.delegates.length);
  check('and it names the owner the rows would be delegations FROM', before.owner === webId, String(before.owner));

  head('2 - the plan is a value, shown before anything is written');
  const plan = delegatePlan({ agentId, name: 'Substrate probe' });
  check('it has no problems and one call', plan.problems.length === 0 && plan.call !== null);
  check('the call is register_agent with the narrowest WRITING scope',
    plan.call?.args['scope'] === 'PublishOnly', String(plan.call?.args['scope']));
  check('it does not name a pod - register_agent is own-pod gated at the relay',
    plan.call !== null && !('pod_name' in plan.call.args));
  check('the label is substrate-neutral', plan.call?.args['label'] === delegateLabel('Substrate probe'),
    String(plan.call?.args['label']));
  check('and it states that PublishOnly is POD-WIDE rather than reassuring',
    plan.limits.some((l) => l.includes('POD-WIDE')));

  head('3 - authorise, established by reading the pod back');
  const out = await publishDelegation(port, { plan, verifyOnPod: podName });
  check('published, and the pod agrees', out.kind === 'published', out.kind + ' - ' + out.why);
  check('the row carries the scope the relay actually stored', out.listed?.scope === 'PublishOnly',
    String(out.listed?.scope));
  check('and delegatedBy names the person - the field the vertical row type could not carry',
    out.listed?.delegatedBy === webId, String(out.listed?.delegatedBy));

  const roster = await readDelegates(port, podName);
  const seated = roster.delegates.find((r) => r.agentId === agentId) ?? null;
  check('a second, independent read finds it by name', seated?.name === 'Substrate probe', String(seated?.name));
  check('and the substrate ceiling permits a write', scopeCeiling({ scope: seated?.scope ?? null, delegateName: seated?.name ?? null }).ok);

  head('4 - a reader tells the delegate from the person, and the two footings apart, from PROV alone');
  /** One entry's statements. The act keys the per-act footing; see `footingTurtle`. */
  const ACT = 'https://relay.interego.xwisee.com/ns/probe/e/0#act';
  const st = (o: Partial<AuthorshipStatements>): AuthorshipStatements => ({
    attributedTo: [], generatedBy: [], qualifiedDelegation: [],
    delegationAgent: [], delegationActivity: [], actedOnOwnAccount: [], ...o,
  });
  const forHuman = st({
    attributedTo: [agentId], generatedBy: [ACT],
    qualifiedDelegation: ['https://relay.interego.xwisee.com/ns/probe/e/0#delegation'],
    delegationAgent: [webId], delegationActivity: [ACT],
  });
  const asDelegate = judgeAuthorship(forHuman, { logOwnerWebId: webId, delegates: roster, signedBy: agentId });
  check('a delegate speaking FOR the pod owner reads as on-behalf-of', asDelegate.kind === 'delegate'
    && asDelegate.footing.kind === 'on-behalf-of', asDelegate.kind);
  check('and the owner\'s own registry is what authorises it',
    asDelegate.kind === 'delegate' && asDelegate.authorised === true);

  // ★ THE SAME AGENT, THE SAME REGISTRY ROW, THE OTHER FOOTING. Standing is unchanged and the
  // reading of this record is entirely different — which is the whole point of the split.
  const ownAccount = judgeAuthorship(
    st({ attributedTo: [agentId], generatedBy: [ACT], actedOnOwnAccount: [ACT] }),
    { logOwnerWebId: webId, delegates: roster, signedBy: agentId });
  check('the SAME delegate speaking for ITSELF reads as own-account',
    ownAccount.kind === 'delegate' && ownAccount.footing.kind === 'own-account',
    ownAccount.kind === 'delegate' ? ownAccount.footing.kind : ownAccount.kind);
  check('and its standing is untouched by that - still an authorised delegate',
    ownAccount.kind === 'delegate' && ownAccount.authorised === true);
  check('the two lines a reader sees are not the same string',
    authorshipLine(asDelegate, { displayName: 'Mark' }) !== authorshipLine(ownAccount, { displayName: 'Mark' }),
    authorshipLine(asDelegate, { displayName: 'Mark' }) + ' | ' + authorshipLine(ownAccount, { displayName: 'Mark' }));

  const unfooted = judgeAuthorship(st({ attributedTo: [agentId], generatedBy: [ACT] }),
    { logOwnerWebId: webId, delegates: roster, signedBy: agentId });
  check('an entry that declares NEITHER reads as not-stated, not as either of them',
    unfooted.kind === 'delegate' && unfooted.footing.kind === 'not-stated');
  const both = judgeAuthorship(
    st({ attributedTo: [agentId], generatedBy: [ACT], actedOnOwnAccount: [ACT], delegationAgent: [webId], delegationActivity: [ACT], qualifiedDelegation: ['urn:x'] }),
    { logOwnerWebId: webId, delegates: roster, signedBy: agentId });
  check('an entry that declares BOTH is disputed rather than resolved', both.kind === 'disputed', both.kind);

  const asPerson = judgeAuthorship(st({ attributedTo: [webId] }), { logOwnerWebId: webId, delegates: roster, signedBy: agentId });
  check('the person\'s own record reads as the principal', asPerson.kind === 'principal', asPerson.kind);
  const stranger = judgeAuthorship(
    st({
      attributedTo: ['did:web:example.org:agents:nobody'], generatedBy: [ACT],
      qualifiedDelegation: ['urn:x'], delegationAgent: [webId], delegationActivity: [ACT],
    }),
    { logOwnerWebId: webId, delegates: roster, signedBy: 'did:web:example.org:agents:nobody' });
  check('an agent the registry does NOT list reads as unauthorised, not as absent',
    stranger.kind === 'delegate' && stranger.authorised === false);

  // ★ THE PUPPET, WHICH IS WHAT MAKES EVERY LINE ABOVE WORTH READING. Identical statements to the
  // `asDelegate` case, signed by a DIFFERENT key — the shape any pod owner (and any conduit holding
  // a delegation on their pod, e.g. the Discord bot) can write at will. Before the signer was an
  // input this read back as an authorised delegate speaking for its human.
  const puppet = judgeAuthorship(forHuman, {
    logOwnerWebId: webId, delegates: roster,
    signedBy: 'did:web:identity.interego.xwisee.com:agents:somebody-else-u-eth-000000000000',
  });
  check('an entry attributed to an agent it was NOT signed by is disputed, never that agent speaking',
    puppet.kind === 'disputed', puppet.kind);
  check('and the reason names both parties', puppet.kind === 'disputed'
    && puppet.why.includes(agentId) && puppet.why.includes('somebody-else'), puppet.kind === 'disputed' ? puppet.why.slice(0, 120) : '');
  const unsigned = judgeAuthorship(forHuman, { logOwnerWebId: webId, delegates: roster, signedBy: null });
  check('and one whose signer this reader was never told is disputed too, not a weaker yes',
    unsigned.kind === 'disputed', unsigned.kind);

  head('5 - revocation is unilateral, and the pod is what confirms it');
  const revoked = await revokeDelegation(port, { agentId, podName });
  check('revoked, and read back from the pod', revoked.kind === 'revoked', revoked.kind + ' - ' + revoked.why);
  check('it warns about the relay\'s 60s permission cache', revoked.why.includes('60 seconds'));

  const after = await readDelegates(port, podName);
  check('the pod no longer lists it', !after.rows.some((r) => r.agentId === agentId));
  const nowUnauthorised = judgeAuthorship(forHuman, { logOwnerWebId: webId, delegates: after, signedBy: agentId });
  check('and a record it already wrote still names it, now reading as NOT authorised',
    nowUnauthorised.kind === 'delegate' && nowUnauthorised.authorised === false);
  // ★ THE RECORD'S OWN FOOTING IS UNCHANGED BY THE REVOCATION, and must be. What that entry said
  // it was doing when it was written is a historical fact; whether the agent is still a delegate
  // today is a different question, and revoking cannot retroactively rewrite the first.
  check('while what that record SAID it was doing is unchanged - a revoke is not a rewrite',
    nowUnauthorised.kind === 'delegate' && nowUnauthorised.footing.kind === 'on-behalf-of');

  head('result');
  log('  relay:    ' + RELAY);
  log('  person:   ' + podName);
  log('  delegate: ' + agentId + ' (revoked)');
  log(failures === 0 ? '\n  ALL CHECKS PASSED' : '\n  ' + failures + ' CHECK(S) FAILED');
  if (failures > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  log('probe failed: ' + String((e as Error).stack ?? e));
  process.exitCode = 1;
});
