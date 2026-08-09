#!/usr/bin/env tsx
/**
 * OBSERVE `invoke_affordance` — the one call the published artifact makes that had never been
 * seen happen.
 *
 * ★ WHY THIS EXISTS. `artifact/channel.html` declares eleven connector tools and its "ask a
 * member" control calls `invoke_affordance`. Every other tool in that list has been exercised
 * by a live driver in this directory. That one had not, because it needs something no test
 * workspace ever had: a member who has published a capability document on their own pod. The
 * rule the artifact is published under is that no call ships whose request and response shape
 * has not been observed, so this program makes the call happen and prints both halves verbatim.
 *
 * ── WHAT IT SETS UP, AND WHY EACH PIECE IS REAL ─────────────────────────────
 *
 *   convener  a FRESH disposable wallet, so nothing depends on an existing workspace and a
 *             re-run cannot inherit a previous run's state.
 *   member    the wallet the DEPLOYED shared-workspace bridge holds
 *             (`WSP_AGENT_PRIVATE_KEY` on the wsp-bridge service). It has to be that one and
 *             not a fresh key: the capability document points at that bridge's HTTP endpoint,
 *             and the bridge answers as the identity it holds. A different wallet would
 *             publish a document advertising somebody else's endpoint, and the "member" who
 *             answered would not be the member who advertised.
 *
 * ★ AND THE HONEST DESCRIPTION OF WHO WRITES THE CAPABILITY DOCUMENT. It is written HERE,
 * with the agent's own key, over the agent's own bearer, onto the agent's own pod — so the
 * signature, the pod and the authority are the agent's. What is NOT true is that the bridge
 * process published it of its own accord; it has no code path that does. This driver is the
 * operator of that agent doing it on its behalf, which is exactly the authority the bridge's
 * own header says an operator holds. Anyone reading the resulting document sees a signed
 * statement by that agent, and that is what it is.
 *
 * ── THE THING BEING MEASURED ────────────────────────────────────────────────
 *
 * The `invoke_affordance` request is sent with the ARTIFACT'S OWN ARGUMENT NAMES, copied from
 * `askMember` in `artifact/channel.html`, and nothing else:
 *
 *     invoke_affordance { descriptor_url, action_iri, payload: { workspace } }
 *
 * and the response is printed as it arrives. If the artifact reads fields the response does
 * not carry, that is the finding; if it matches, that is the evidence.
 *
 * ── EXIT CODE ───────────────────────────────────────────────────────────────
 *
 *   0 — the pair was observed. Read the printout; a REFUSAL by the member is still an
 *       observation of the call, and is reported as one rather than as a failure.
 *   2 — the setup could not be established (mint, workspace, seat or capability document
 *       failed), so no call was made and nothing was observed.
 *
 *   WSP_AGENT_PRIVATE_KEY=0x… npx tsx applications/shared-workspace/tools/observe-invoke-affordance-live.ts
 */

import { Wallet } from 'ethers';
import {
  RelayMcpTransport, WorkspaceClient, acceptGrant, acceptanceTurtle, createWorkspace, foldRoster,
  grantTurtle, memberDocIris, nsIri, parseRoleProfile, readInbox, readViewer, sendInvite,
  shapesTurtle, verifyInvitation, workspaceTurtle, composedHandle,
  type Viewer,
} from '@interego/workspace-client';
import { legacyWorkspaceCapabilityTurtle } from '../src/advertise.js';
import { mintBearer, type Signer } from './live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
/** Where the bridge that answers this capability is deployed. Read, never guessed. */
const BRIDGE = (process.env['WSP_BRIDGE_URL'] ?? 'https://wsp-bridge-production.up.railway.app').replace(/\/$/, '');

const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };
const head = (s: string): void => { log('\n== ' + s + ' ' + '='.repeat(Math.max(0, 68 - s.length))); };
const dump = (label: string, v: unknown): void => { log(label + ':\n' + JSON.stringify(v, null, 2)); };

interface Party {
  readonly client: WorkspaceClient;
  readonly viewer: Viewer;
  readonly publish: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

async function party(label: string, wallet: Signer): Promise<Party> {
  const bearer = await mintBearer(RELAY, IDENTITY, wallet);
  const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearer));
  await client.connect();
  const viewer = await readViewer(client);
  log(label.padEnd(9), viewer.podName, '·', wallet.address);
  // `tool` is typed `Promise<unknown>` because a relay tool may answer anything; `StreamDeps`
  // wants `Promise<Record<string, unknown>>`. The narrowing is asserted HERE, once, rather than
  // by widening StreamDeps — a publish that answered a bare string would be a relay defect, and
  // `publishCapability` reads `res['error']` off it, which is safe for any object.
  return { client, viewer, publish: async (args) => await client.tool('publish_context', args) as Record<string, unknown> };
}

/**
 * What the bridge advertises at its own manifest, read rather than restated.
 *
 * The capability document must name the SAME action IRI the bridge's affordance manifest
 * declares, or `invoke_affordance` resolves a descriptor whose action no handler answers. A
 * constant here would be a second spelling of a value that already exists at a URL, and the
 * first time the bridge's action IRI changed this driver would go on advertising the old one.
 */
async function readBridgeAction(): Promise<{ action: string; target: string }> {
  const res = await fetch(BRIDGE + '/affordances', { headers: { Accept: 'text/turtle' } });
  if (!res.ok) throw new Error(`the bridge manifest answered ${res.status}; there is no capability to advertise`);
  const ttl = await res.text();
  const action = /iep:action\s+<([^>]+)>/.exec(ttl)?.[1];
  const target = /hydra:target\s+<([^>]+)>/.exec(ttl)?.[1];
  if (!action || !target) throw new Error('the bridge manifest declared no iep:action + hydra:target pair');
  return { action, target };
}

/**
 * Advertise the capability on the member's own pod, then make the artifact's call and print
 * both halves. Shared by both phases so the two runs cannot differ in the part being measured.
 */
async function advertiseAndInvoke(args: {
  readonly convener: Party; readonly member: Party; readonly workspace: string; readonly slug: string;
  readonly action: string; readonly target: string;
}): Promise<'observed' | 'setup-failed'> {
  const { convener, member, workspace, slug, action, target } = args;

  head('the member publishes a capability document on its own pod');
  // The qualified form, which is what the artifact looks at first. `memberDocIris` is the same
  // function the artifact's reader uses, so writer and reader cannot disagree about the address.
  //
  // ★ THE ROOM-SCOPED NAME, DELIBERATELY, AND ONLY BECAUSE THIS DRIVER MEASURES THE ARTIFACT. An
  // agent's capabilities live at `agent-<pod>-capabilities` on its own pod now — composed from its
  // DID, so a peer that has never heard of this workspace can find them. `channel.html` has not
  // been moved to that reader yet, and publishing only at the new address would have taken the "ask
  // this member" control off a page already in people's hands with no error anywhere. The BYTES
  // come from the one writer either way; only the address differs.
  const docIri = memberDocIris(RELAY, member.viewer.podName, convener.viewer.podName, slug, 'affordances')[0]!.iri;
  log('document :', docIri);
  const doc = legacyWorkspaceCapabilityTurtle({
    relay: RELAY, memberPod: member.viewer.podName, convenerPod: convener.viewer.podName, slug,
    agentId: member.viewer.webId, action, route: { kind: 'hosted', target },
    title: 'Read this channel and answer in my own log',
    description: 'Causes this agent to read the workspace and, if its role permits appending, write one '
      + 'entry to its own log on its own pod. The caller supplies no text.',
  });
  const advertised = await member.publish({
    graph_iri: doc.iri, graph_content: doc.turtle, visibility: 'public',
    auto_supersede_prior: true, sign_authorship: true,
  });
  dump('publish_context', advertised);
  if (advertised['error'] !== undefined) return 'setup-failed';

  // publish_context is DEFERRED — the descriptor is readable a few seconds later. Waiting for
  // the head to resolve is not politeness: invoking before it lands measures a 404 on a
  // document that is about to exist, which looks exactly like a document that never did.
  head('wait for the document to be dereferenceable — through the ARTIFACT\'S OWN reader');
  // `resolveMemberDoc` is the exact call `checkAffordance` makes in the artifact. Using it
  // here rather than a direct head read means the descriptor URL invoked below is the one the
  // page would have found, not one this driver composed.
  let descriptorUrl: string | null = null;
  for (let i = 0; i < 30 && descriptorUrl === null; i++) {
    await new Promise((r) => { setTimeout(r, 1000); });
    const got = await convener.client.resolveMemberDoc(member.viewer.podName, convener.viewer.podName, slug, 'affordances');
    if (got.found && got.head?.url) { descriptorUrl = got.head.url; log('found under the', got.naming, 'name'); }
  }
  if (descriptorUrl === null) { log('FAIL: the capability document never became readable.'); return 'setup-failed'; }
  log('head     :', descriptorUrl);

  head('THE OBSERVED CALL — request');
  // ★ Copied field-for-field from `askMember` in artifact/channel.html. If these names drift
  // from the artifact's, this run stops being evidence about the artifact.
  const request = { descriptor_url: descriptorUrl, action_iri: action, payload: { workspace } };
  dump('invoke_affordance request', request);

  const started = Date.now();
  let response: unknown;
  try {
    response = await convener.client.tool('invoke_affordance', request);
  } catch (e) {
    log('the call THREW after ' + (Date.now() - started) + 'ms: ' + ((e as Error)?.message ?? String(e)));
    log('A throw is an observation too — the artifact catches it and says the member was never asked.');
    return 'observed';
  }
  head('THE OBSERVED CALL — response (' + (Date.now() - started) + 'ms)');
  dump('invoke_affordance response', response);

  head('what the artifact would do with it');
  const r = response as Record<string, unknown>;
  const status = r['status'];
  let body: unknown = null;
  try { body = typeof r['body'] === 'string' ? JSON.parse(r['body']) : r['body']; } catch { body = null; }
  log('res.status present      :', status === undefined ? 'NO — the artifact prints "not reported"' : String(status));
  log('res.body parses as JSON :', body !== null && typeof body === 'object' ? 'YES' : 'NO');
  if (body !== null && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    log('body.outcome            :', String(b['outcome'] ?? '(absent)'));
    log('body.entry.descriptorUrl:', String((b['entry'] as Record<string, unknown> | undefined)?.['descriptorUrl'] ?? '(absent)'));
    log('body.read present       :', b['read'] === undefined || b['read'] === null ? 'no' : 'yes');
    log('body.message            :', String(b['message'] ?? '(absent)').slice(0, 300));
  }
  log('\nworkspace  ' + workspace);
  log('capability ' + docIri);
  return 'observed';
}

/**
 * PHASE 2 — a workspace built to the governance the BRIDGE actually reads.
 *
 * ★ WHY THIS IS HAND-BUILT INSTEAD OF `createWorkspace`. Phase 1 uses the same function the
 * artifact and the desktop shell use, and the member refuses it. Three things about a
 * `createWorkspace` workspace the bridge's reader will not accept, each independent:
 *
 *   1. `rolesTurtle` emits capabilities and roles but never types the document
 *      `wsp:RoleProfile`, and `dereferenceRoleProfile` requires that type — so the ceiling
 *      cannot be computed and the agent refuses before reading anything else.
 *   2. Its capability IRIs are LOCAL (`<rolesIri>#Post`). The bridge asks whether the role
 *      permits `wsp-roles-default#append`. That one is BY DESIGN and documented in
 *      `respond.ts`: a workspace that publishes its own governance names its own
 *      capabilities, and an agent written against one profile cannot read another's.
 *   3. `acceptGrant` writes member documents under the QUALIFIED name
 *      (`<convener pod>--<slug>-acceptance`); `respondAsMember` composes the LEGACY name
 *      (`<slug>-acceptance`). The artifact's reader tries both; the bridge tries one.
 *
 * So this phase declares the PUBLISHED default profile, grants a role out of it, and writes
 * the member documents at the names the bridge composes.
 *
 * ★ WHAT IT ACHIEVED WHEN IT WAS RUN, STATED EXACTLY. It got PAST (1): the response's `read`
 * block names `wsp-roles-default` as the profile and lists it in `consulted`, so the ceiling
 * machinery ran. It then refused `not-seated` with both membership documents in `consulted`.
 * That is NOT reported as a bridge defect, because these grant and acceptance records are
 * hand-assembled HERE rather than produced by `sendInvite`/`acceptGrant`, and a fold that
 * declines to seat them is at least as likely to be right about my records as wrong about
 * itself. What this phase establishes is narrower and still worth having: the role-profile
 * typing is the FIRST blocker on the product path, and the artifact's `body.read` rendering
 * branch — which phase 1 never reaches, because its `read` is null — is exercised.
 *
 * The success branch (`outcome: appended`, carrying `entry.descriptorUrl`, which the artifact
 * polls the member's log for) therefore remains UNOBSERVED. Nothing in this file pretends
 * otherwise.
 */
const DEFAULT_PROFILE = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default';

async function buildBridgeReadableWorkspace(convener: Party, member: Party): Promise<{ workspace: string; slug: string } | null> {
  const slug = 'obs2-' + Date.now().toString(36);
  const workspace = nsIri(RELAY, convener.viewer.podName, slug);
  const shapeIri = nsIri(RELAY, convener.viewer.podName, slug + '-shapes');
  const grantIri = workspace + '-grant-' + member.viewer.podName;

  const step = async (
    who: Party, label: string, iri: string, content: string, shapes?: readonly string[],
  ): Promise<string | null> => {
    const args: Record<string, unknown> = {
      graph_iri: iri, graph_content: content, visibility: 'public',
      auto_supersede_prior: true, sign_authorship: true,
    };
    if (shapes) args['conforms_to_shapes'] = shapes.slice();
    const out = await who.client.publishAndConfirm(args, who.viewer.podName, iri);
    if (out.error || out.refusal) { dump(label + ' failed', out.error ?? out.refusal); return null; }
    if (!out.readable) { log(label + ': accepted but not reported readable — ' + String(out.why)); return null; }
    const cid = out.head && 'cid' in out.head ? (out.head as { cid?: string }).cid ?? null : null;
    log('  ' + label.padEnd(11), iri, cid ? '· ' + cid.slice(0, 14) + '…' : '');
    return cid ?? '';
  };

  head('PHASE 2 — a workspace the bridge\'s own reader accepts');
  if (await step(convener, 'shapes', shapeIri, shapesTurtle(shapeIri)) === null) return null;
  if (await step(convener, 'workspace', workspace, workspaceTurtle({
    workspace, title: 'invoke_affordance observation (default profile)',
    convenerWebId: convener.viewer.webId, rolesIri: DEFAULT_PROFILE, shapeIri,
  })) === null) return null;
  const grantCid = await step(convener, 'grant', grantIri, grantTurtle({
    grant: grantIri, workspace, granteeWebId: member.viewer.webId, role: DEFAULT_PROFILE + '#Contributor',
  }), [shapeIri + '#GrantShape']);
  if (grantCid === null) return null;

  // ★ THE LEGACY NAMES, ON PURPOSE — see (3) above. This is the address `respondAsMember`
  // composes, so publishing anywhere else produces a member the bridge reports as unseated.
  const acceptanceIri = nsIri(RELAY, member.viewer.podName, slug + '-acceptance');
  const streamIri = nsIri(RELAY, member.viewer.podName, slug + '-stream');
  if (await step(member, 'acceptance', acceptanceIri, acceptanceTurtle({
    acceptance: acceptanceIri, workspace, memberWebId: member.viewer.webId,
    grant: grantIri, grantCid: grantCid === '' ? null : grantCid, stream: streamIri,
  }), [shapeIri + '#AcceptanceShape']) === null) return null;

  return { workspace, slug };
}

async function run(): Promise<number> {
  const agentKey = process.env['WSP_AGENT_PRIVATE_KEY'] ?? '';
  if (agentKey === '') {
    log('WSP_AGENT_PRIVATE_KEY is unset. This driver will NOT substitute a fresh wallet: a member');
    log('that advertises an endpoint it does not hold the key for is not the member being observed.');
    return 2;
  }

  head('the two identities');
  const convener = await party('convener', Wallet.createRandom());
  const member = await party('member', new Wallet(agentKey));
  if (convener.viewer.podName === member.viewer.podName) {
    log('FAIL: both identities resolved to the same pod; there is no second party.');
    return 2;
  }

  head('what the bridge says it can do');
  const { action, target } = await readBridgeAction();
  log('action  :', action);
  log('target  :', target);
  const identity = await (await fetch(BRIDGE + '/wsp/identity')).json() as { pod?: string };
  log('bridge seated as pod:', identity.pod ?? '(none reported)');
  if (identity.pod !== member.viewer.podName) {
    log('FAIL: the bridge holds pod ' + String(identity.pod) + ' but WSP_AGENT_PRIVATE_KEY resolves to '
      + member.viewer.podName + '. The document would advertise an endpoint answering as somebody else.');
    return 2;
  }

  head('PHASE 1 — the workspace the ARTIFACT itself creates');
  const slug = 'observe-' + Date.now().toString(36);
  const created = await createWorkspace(convener.client, {
    relay: RELAY, viewer: convener.viewer, title: 'invoke_affordance observation ' + slug, slug,
  });
  if (created.kind !== 'created') { dump('workspace creation failed', created); return 2; }
  const workspace = created.workspace;
  log('workspace:', workspace);

  const profile = await convener.client.fetchProfileTurtle(created.rolesIri);
  const contributor = [...parseRoleProfile(profile.turtle).roles.keys()].find((r) => r.endsWith('#Contributor'));
  if (!contributor) { log('FAIL: the role table declares no Contributor to grant.'); return 2; }

  const invited = await sendInvite(convener.client, {
    viewer: convener.viewer, workspace, workspaceTitle: 'invoke_affordance observation',
    handle: composedHandle(RELAY, member.viewer.podName), role: contributor, entryShape: created.shapeIri,
  });
  if (invited.kind !== 'invited') { dump('invite failed', invited); return 2; }
  log('grant    :', invited.grantIri);

  head('the member accepts, on the member\'s own pod');
  const inbox = await readInbox(member.client);
  let accepted = false;
  for (const item of inbox.invitations) {
    await verifyInvitation(member.client, RELAY, member.viewer, item);
    const v = item.verdict;
    if (!v?.ok || v.grantIri !== invited.grantIri) continue;
    const out = await acceptGrant(member.client, { relay: RELAY, viewer: member.viewer, verdict: v });
    log('accept   :', out.kind, out.kind === 'accepted' ? out.acceptanceIri : JSON.stringify(out).slice(0, 240));
    accepted = out.kind === 'accepted' && out.readable;
  }
  if (!accepted) { log('FAIL: the member is not seated, so there is nothing to ask them about.'); return 2; }

  const fold = await foldRoster(convener.client, {
    workspace, iriOwner: convener.viewer.podName, slug,
    convener: convener.viewer.webId, convenerPod: convener.viewer.podName,
  });
  for (const s of fold.seats) log('   ', s.seated ? 'SEATED' : 'not   ', s.pod, '·', s.seated ? s.acceptTest : s.why);

  if (await advertiseAndInvoke({ convener, member, workspace, slug, action, target }) === 'setup-failed') return 2;

  const second = await buildBridgeReadableWorkspace(convener, member);
  if (second === null) { log('\nPhase 2 setup failed; phase 1\'s pair above still stands.'); return 0; }
  if (await advertiseAndInvoke({ convener, member, workspace: second.workspace, slug: second.slug, action, target }) === 'setup-failed') {
    log('\nPhase 2 setup failed; phase 1\'s pair above still stands.');
  }
  return 0;
}

void run().then((c) => process.exit(c), (e: unknown) => {
  log('THREW:', (e as Error)?.stack ?? String(e));
  process.exit(2);
});
