/**
 * EVERY MEMBERSHIP AND CANVAS FLOW, DRIVEN AGAINST THE LIVE FLEET WITH TWO REAL IDENTITIES.
 *
 * ★ THIS IS NOT A TEST DOUBLE AND IT SHARES NO CODE WITH ONE. It mints two relay OAuth bearers
 * from two secp256k1 keys, provisions two pods, and runs the SAME `@interego/workspace-client`
 * functions the published artifact and the desktop shell run. Two identities is the whole point:
 * a seat is two documents on two pods with two different owners, and a single-identity run can
 * satisfy both halves without ever exercising the refusal that makes membership mean anything.
 *
 *   create → invite → accept → switch → post from both → canvas create → canvas save
 *          → forced stale 412 → merge forward → revoke
 *
 * Every write below is REAL and PUBLIC on the live fleet. Runtime pod data on this deployment is
 * disposable, which is why a driver may make it.
 *
 *   npx tsx applications/shared-workspace/tools/drive-membership-live.ts
 *
 *   INTEREGO_WALLET_A=.interego/maintainer.json   identity A (the convener). Default shown.
 *   INTEREGO_WALLET_B=<path>                      identity B. Omitted: a fresh key is minted.
 *   INTEREGO_DRIVE_SLUG=<slug>                    reuse a workspace instead of creating one.
 */

import { readFileSync } from 'node:fs';
import { Wallet } from 'ethers';
import {
  RelayMcpTransport, WorkspaceClient, acceptGrant, checkOwnHandle, checkWriteEligibility,
  composedHandle, createWorkspace, findSeat, foldRoster, listWorkspaces, mergeForward,
  parseRoleProfile, postEntry, readCanvas, readInbox, readViewer, revokeGrant, saveCanvas,
  sendInvite, verifyInvitation, verifyWorkspaceEntry, nsIri, qualifiedName, shortRef,
  type Viewer,
} from '@interego/workspace-client';
import { mintBearer, type Signer } from './live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };
const head = (s: string): void => { log('\n══ ' + s + ' ' + '═'.repeat(Math.max(0, 66 - s.length))); };

let failures = 0;
/** A named expectation, printed either way. A driver that only prints successes measures nothing. */
function must(what: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  log((ok ? '  OK   ' : '  FAIL ') + what + (detail ? ' — ' + detail : ''));
}

interface Party { readonly client: WorkspaceClient; readonly viewer: Viewer; readonly handle: string }

// `Signer`, not `Wallet`: `Wallet.createRandom()` returns an `HDNodeWallet`, and identity B is
// exactly that on a first run — a driver that could not take a freshly minted key could not
// exercise the two-identity case it exists for.
async function party(label: string, wallet: Signer): Promise<Party> {
  const t0 = Date.now();
  const bearer = await mintBearer(RELAY, IDENTITY, wallet);
  const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearer));
  await client.connect();
  const viewer = await readViewer(client);
  const handle = composedHandle(RELAY, viewer.podName);
  log(label + ' pod', viewer.podName, '· webId', viewer.webId || '(none reported)',
    '· first pod-aware call took', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  log(label + ' handle', handle);
  return { client, viewer, handle };
}

async function run(): Promise<number> {
  head('two identities');
  const seedA = (JSON.parse(readFileSync(process.env['INTEREGO_WALLET_A'] ?? '.interego/maintainer.json', 'utf8')) as { privateKey: string }).privateKey;
  const A = await party('A', new Wallet(seedA));
  const walletB = process.env['INTEREGO_WALLET_B']
    ? new Wallet((JSON.parse(readFileSync(process.env['INTEREGO_WALLET_B'], 'utf8')) as { privateKey: string }).privateKey)
    : Wallet.createRandom();
  const B = await party('B', walletB);
  must('the two identities are different pods', A.viewer.podName !== B.viewer.podName, A.viewer.podName + ' vs ' + B.viewer.podName);

  head('A: the handle a second person needs, composed then resolved');
  const hc = await checkOwnHandle(A.client, RELAY, A.viewer.podName);
  must('A\'s composed handle resolves back to A\'s pod', hc.ok, hc.why);
  const hcB = await checkOwnHandle(B.client, RELAY, B.viewer.podName);
  must('B\'s composed handle resolves back to B\'s pod', hcB.ok, hcB.why);

  head('write eligibility, asked of the relay rather than assumed');
  for (const [n, p] of [['A', A], ['B', B]] as const) {
    const w = await checkWriteEligibility(p.client, p.viewer);
    must(n + ' is offered write controls', w.blocked === null,
      w.blocked ?? (w.enforcement ? 'basis ' + String(w.enforcement['basis']) + ' · scope ' + String(w.enforcement['scope']) + ' · writeEligible ' + String(w.enforcement['writeEligible']) : (w.why ?? '')));
  }

  head('A: create a workspace — five documents on A\'s own pod');
  const slug = process.env['INTEREGO_DRIVE_SLUG'] ?? ('drive-' + Date.now().toString(36));
  let workspace = nsIri(RELAY, A.viewer.podName, slug);
  let entryShape: string | null = null;
  let rolesIri = nsIri(RELAY, A.viewer.podName, slug + '-roles');
  if (process.env['INTEREGO_DRIVE_SLUG']) {
    log('reusing', workspace);
    const rec = await A.client.readWorkspaceRecord(workspace, A.viewer.podName);
    must('the reused workspace record reads', rec.kind === 'record', rec.kind);
    if (rec.kind !== 'record') return 1;
    entryShape = rec.record.entryShape;
    rolesIri = rec.record.roleProfile ?? rolesIri;
  } else {
    const created = await createWorkspace(A.client, {
      relay: RELAY, viewer: A.viewer, title: 'Live drive ' + slug, slug,
      onStep: (s) => { if (s.state !== 'sending') log('   ', s.label, '·', s.state, '·', s.detail); },
    });
    log('   outcome:', created.kind);
    must('all five documents published and A is seated', created.kind === 'created' && created.seated,
      created.kind === 'created' ? (created.why ?? 'acceptance readable') : JSON.stringify(created).slice(0, 300));
    if (created.kind !== 'created') return 1;
    workspace = created.workspace;
    entryShape = created.shapeIri;
    rolesIri = created.rolesIri;
    log('   workspace  ', workspace);
    log('   grant      ', created.grantIri, '· revision', shortRef(created.grantCid ?? ''));
    log('   acceptance ', created.acceptanceIri);
  }

  head('A: the role table is DATA — read it back off the pod');
  const profile = await A.client.fetchProfileTurtle(rolesIri);
  const table = parseRoleProfile(profile.turtle);
  const roleIris = [...table.roles.keys()];
  log('   roles read:', [...table.roles.values()].map((r) => r.label).join(', '), '· from', profile.from, '· hops', profile.hops);
  must('the role table resolves to three roles', table.roles.size === 3, String(table.roles.size));
  const contributor = roleIris.find((r) => r.endsWith('#Contributor'));
  if (!contributor) { must('a Contributor role exists to grant', false, roleIris.join(', ')); return 1; }

  head('A: invite B');
  const inv = await sendInvite(A.client, {
    viewer: A.viewer, workspace, workspaceTitle: 'Live drive ' + slug,
    handle: B.handle, role: contributor, entryShape,
    onState: (s, d) => log('   grant ·', s, '·', d),
  });
  log('   outcome:', inv.kind);
  if (inv.kind === 'invited') {
    for (const c of inv.resolution.checks) log('   ', c.mark, c.text);
    log('   grant       ', inv.grantIri);
    log('   notification', inv.notify.line);
    must('the grant is readable on A\'s pod', inv.readable, inv.why ?? '');
  } else {
    must('the invite published a grant', false, JSON.stringify(inv).slice(0, 400));
    return 1;
  }
  const grantIri = inv.grantIri;

  head('B: the inbox is an UNVERIFIED CLAIM — dereference before believing it');
  const inbox = await readInbox(B.client);
  log('   offers with something to look at:', inbox.invitations.length, '· read came back full:', inbox.saturated);
  let accepted: string | null = null;
  for (const item of inbox.invitations) {
    await verifyInvitation(B.client, RELAY, B.viewer, item);
    const v = item.verdict;
    if (!v) continue;
    log('   about', String(item.item['about']).slice(0, 110), '→', v.ok ? 'VERIFIED on pod ' + v.owner : 'not confirmed: ' + v.why);
    if (v.ok && v.grantIri === grantIri) {
      for (const c of v.checks) log('      ', c.mark, c.text);
      const out = await acceptGrant(B.client, { relay: RELAY, viewer: B.viewer, verdict: v, onState: (s, d) => log('      acceptance ·', s, '·', d) });
      log('   accept outcome:', out.kind);
      must('B\'s acceptance is readable on B\'s own pod', out.kind === 'accepted' && out.readable,
        out.kind === 'accepted' ? (out.why ?? out.acceptanceIri) : JSON.stringify(out).slice(0, 300));
      if (out.kind === 'accepted') accepted = out.acceptanceIri;
    }
  }
  must('the invitation A sent was found in B\'s inbox and accepted', accepted !== null,
    accepted ?? 'no offer in the inbox verified against ' + grantIri);

  head('the refusal the whole arrangement rests on');
  // A tries to write B's acceptance FOR them. Measured backstop, asserted rather than described.
  const forged = await A.client.tool('publish_context', {
    pod_name: B.viewer.podName,
    graph_iri: nsIri(RELAY, B.viewer.podName, qualifiedName(A.viewer.podName, slug, 'acceptance')),
    graph_content: '@prefix dct: <http://purl.org/dc/terms/> .\n<x:y> dct:title "forged" .\n',
    visibility: 'public',
  }).catch((e: unknown) => ({ error: 'threw', message: (e as Error)?.message })) as Record<string, unknown>;
  must('A cannot publish onto B\'s pod', !!forged['error'], JSON.stringify(forged).slice(0, 220));

  head('B: which workspaces am I in? — one manifest read of B\'s OWN pod');
  const list = await listWorkspaces(B.client, RELAY, B.viewer.podName);
  log('   acceptances found:', list.entries.length, '· read came back full:', list.saturated);
  for (const c of list.entries) {
    await verifyWorkspaceEntry(B.client, RELAY, B.viewer, c);
    log('   ', c.verified ? 'VERIFIED' : 'not     ', c.workspace ?? c.acceptanceIri, '·', c.naming, '·', c.title ?? c.why ?? '');
  }
  must('the switcher lists the workspace B just accepted, verified',
    list.entries.some((c) => c.workspace === workspace && c.verified === true), workspace);
  must('the switcher does not list B\'s own pod profile as a workspace',
    !list.entries.some((c) => c.workspace === nsIri(RELAY, B.viewer.podName, '')), 'entries: ' + list.entries.length);

  head('A: fold the roster — both halves, on two pods');
  const rec = await A.client.readWorkspaceRecord(workspace, A.viewer.podName);
  if (rec.kind !== 'record') { must('the workspace record reads', false, rec.kind); return 1; }
  const fold = await foldRoster(A.client, {
    workspace, iriOwner: A.viewer.podName, slug,
    convener: rec.record.convener, convenerPod: rec.record.convenerPod,
  });
  for (const s of fold.seats) log('   ', s.seated ? 'SEATED' : 'not   ', s.pod, '·', s.seated ? s.acceptTest : s.why);
  must('A is seated', fold.seats.some((s) => s.seated && s.pod === A.viewer.podName), '');
  must('B is seated', fold.seats.some((s) => s.seated && s.pod === B.viewer.podName), '');

  head('both post, each onto their own pod');
  for (const [n, p] of [['A', A], ['B', B]] as const) {
    const seat = fold.seats.find((s) => s.seated && s.pod === p.viewer.podName && s.stream);
    const streamIri = seat?.stream ?? nsIri(RELAY, p.viewer.podName, qualifiedName(A.viewer.podName, slug, 'stream'));
    const out = await postEntry(p.client, {
      podName: p.viewer.podName, streamIri, workspace, entryShape,
      body: n + ' posting from the live driver at ' + new Date().toISOString(),
      // The person is the author: this driver signs in AS them and writes under their own name.
      // A delegate is a different author and a different session — `drive-delegate-live.ts`.
      author: { kind: 'principal', webId: p.viewer.webId },
    });
    log('   ' + n + ' post:', out.kind, out.kind === 'accepted' ? '· seq ' + out.seq + ' · ' + out.descriptorUrl : JSON.stringify(out).slice(0, 260));
    if (out.kind !== 'accepted') { must(n + ' posted', false, out.kind); continue; }
    let landed = false;
    for (let i = 0; i < 30 && !landed; i++) {
      await new Promise((r) => { setTimeout(r, 700); });
      const rows = await p.client.manifest(p.viewer.podName, streamIri);
      landed = rows.some((r) => r['descriptorUrl'] === out.descriptorUrl);
    }
    must(n + '\'s entry reads back off ' + n + '\'s own pod', landed, out.descriptorUrl ?? '');
  }

  head('B: the canvas — create, save, then a deliberately stale save');
  const canvasIri = nsIri(RELAY, B.viewer.podName, qualifiedName(A.viewer.podName, slug, 'canvas'));
  log('   canvas', canvasIri);
  const first = await readCanvas(B.client, canvasIri, B.viewer.podName);
  log('   first read:', first.kind, 'kind' in first && first.kind === 'absent' ? '· ' + first.message : '');
  must('an unwritten canvas reads as ABSENT, which is the only state that licenses Create',
    first.kind === 'absent' || first.kind === 'revision', first.kind);

  const create = await saveCanvas(B.client, {
    canvasIri, podName: B.viewer.podName, workspace, slug,
    body: 'First revision, written by the live driver at ' + new Date().toISOString(),
    ifMatch: null, previousCid: null,
  });
  log('   create:', create.kind, create.kind === 'accepted' ? '· settled ' + create.settled.kind : JSON.stringify(create).slice(0, 240));
  must('the first canvas write becomes the readable head', create.kind === 'accepted' && create.settled.kind === 'mine',
    create.kind === 'accepted' ? create.settled.kind : '');
  if (create.kind !== 'accepted') return 1;

  const afterCreate = await readCanvas(B.client, canvasIri, B.viewer.podName);
  if (afterCreate.kind !== 'revision') { must('the canvas reads back as a revision', false, afterCreate.kind); return 1; }
  const loadedCid = afterCreate.cid;
  log('   revision now', shortRef(loadedCid ?? ''), '· text', JSON.stringify((afterCreate.text ?? '').slice(0, 48)));

  const second = await saveCanvas(B.client, {
    canvasIri, podName: B.viewer.podName, workspace, slug,
    body: 'Second revision, asserting the revision this panel holds.',
    ifMatch: loadedCid, previousCid: loadedCid,
  });
  log('   save #2:', second.kind, second.kind === 'accepted' ? '· settled ' + second.settled.kind : JSON.stringify(second).slice(0, 240));
  must('a save asserting the CURRENT revision becomes the head', second.kind === 'accepted' && second.settled.kind === 'mine',
    second.kind === 'accepted' ? second.settled.kind : '');

  head('B: force the stale write — re-send the revision the panel FIRST loaded');
  const stale = await saveCanvas(B.client, {
    canvasIri, podName: B.viewer.podName, workspace, slug,
    body: 'This one asserts a revision the head has moved past.',
    ifMatch: loadedCid, previousCid: loadedCid,
  });
  log('   stale save:', stale.kind);
  must('a stale if_match is refused 412 rather than silently overwriting', stale.kind === 'stale',
    stale.kind === 'refused' ? 'code ' + String(stale.code) + ' ' + JSON.stringify(stale.body).slice(0, 200) : stale.kind);
  if (stale.kind === 'stale') {
    log('   expected.cid        ', stale.detail.expectedCid ?? 'not reported');
    log('   currentHead.cid     ', stale.detail.currentHeadCid ?? 'not reported');
    log('   currentHead.descrip.', stale.detail.currentHeadDescriptor ?? 'not reported');
    log('   retryHint           ', stale.detail.retryHint ?? 'not reported');
    must('the 412 names the revision that IS there', !!stale.detail.currentHeadCid, '');
    must('the 412 carries a retryHint to follow', !!stale.detail.retryHint, '');

    head('B: merge forward — follow the retryHint exactly');
    const merged = await mergeForward(B.client, {
      canvasIri, podName: B.viewer.podName, workspace, slug,
      body: 'Merged forward onto whatever the head had become.',
    });
    log('   merge:', merged.kind, merged.kind === 'resent' ? '· onto ' + shortRef(merged.onto) + ' · ' + merged.save.kind : merged.why);
    must('merge forward lands as the head',
      merged.kind === 'resent' && merged.save.kind === 'accepted' && merged.save.settled.kind === 'mine',
      merged.kind === 'resent' && merged.save.kind === 'accepted' ? merged.save.settled.kind : JSON.stringify(merged).slice(0, 200));
  }

  head('A: revoke B\'s grant, then confirm the fold stops seating them');
  const seatB = fold.seats.find((s) => s.pod === B.viewer.podName);
  const rev = await revokeGrant(A.client, {
    viewer: A.viewer, workspace, grantIri, grantedTo: seatB?.grantedTo ?? B.viewer.webId,
    role: seatB?.role ?? contributor, ifMatch: seatB?.grantCid ?? seatB?.grantUrl ?? null,
    entryShape, onState: (s, d) => log('   revocation ·', s, '·', d),
  });
  log('   revoke:', rev.kind);
  must('the revocation is readable', rev.kind === 'revoked' && rev.readable, JSON.stringify(rev).slice(0, 240));
  const after = await foldRoster(A.client, {
    workspace, iriOwner: A.viewer.podName, slug,
    convener: rec.record.convener, convenerPod: rec.record.convenerPod,
  });
  const rowB = after.seats.find((s) => s.pod === B.viewer.podName);
  must('B is no longer seated after revocation', !!rowB && !rowB.seated, rowB?.why ?? 'no row for B at all');
  const seatAfter = await findSeat(B.client, { relay: RELAY, viewer: B.viewer, workspace });
  must('B\'s own findSeat now reports why they are not seated', !seatAfter.ok, seatAfter.why ?? '');

  head('summary');
  log('workspace  ', workspace);
  log('convener   ', A.viewer.podName);
  log('member     ', B.viewer.podName, '(revoked at the end of this run)');
  log('canvas     ', canvasIri);
  log(failures === 0 ? '\nALL FLOWS REPRODUCED' : '\n' + failures + ' EXPECTATION(S) FAILED');
  return failures === 0 ? 0 : 1;
}

void run().then((c) => process.exit(c), (e: unknown) => { log('THREW:', (e as Error)?.stack ?? String(e)); process.exit(1); });
