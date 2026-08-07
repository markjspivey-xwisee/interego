/**
 * CREATE A WORKSPACE AND INVITE A HANDLE — the convener half of "getting a second person in".
 *
 * ★ WHY THIS IS SEPARATE FROM `drive-membership-live.ts`. That driver holds BOTH keys, which is
 * what lets it run accept as well as invite — and is also the one thing a real second person
 * never is. This one holds only the convener's key and takes the other party's handle as an
 * argument, which is exactly the position a convener is actually in: their identifier does not
 * exist until they connect, no directory can find them by name, and the handle arrives out of
 * band. It exists so the DESKTOP SHELL can be the second person, accepting with its own key out
 * of the OS secret store, through its own UI.
 *
 *   npx tsx applications/shared-workspace/tools/invite-handle-live.ts acct:u-…@relay.interego.xwisee.com
 *
 *   INTEREGO_WALLET_A=.interego/maintainer.json  the convener's key. Default shown.
 *   INTEREGO_DRIVE_SLUG=<slug>                   invite into an existing workspace instead.
 */

import { readFileSync } from 'node:fs';
import { Wallet } from 'ethers';
import {
  RelayMcpTransport, WorkspaceClient, createWorkspace, nsIri, parseRoleProfile, readViewer,
  sendInvite,
} from '@interego/workspace-client';
import { mintBearer } from './live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };

async function run(): Promise<number> {
  const handle = process.argv[2];
  if (!handle || !handle.startsWith('acct:')) {
    log('usage: invite-handle-live.ts acct:<pod>@<relay host>');
    return 2;
  }
  const seed = (JSON.parse(readFileSync(process.env['INTEREGO_WALLET_A'] ?? '.interego/maintainer.json', 'utf8')) as { privateKey: string }).privateKey;
  const wallet = new Wallet(seed);
  const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, await mintBearer(RELAY, IDENTITY, wallet)));
  await client.connect();
  const viewer = await readViewer(client);
  log('convener pod   :', viewer.podName);

  const slug = process.env['INTEREGO_DRIVE_SLUG'] ?? ('desk-' + Date.now().toString(36));
  let workspace = nsIri(RELAY, viewer.podName, slug);
  let rolesIri = workspace + '-roles';
  let entryShape: string | null = null;
  let title = 'Desktop demo ' + slug;

  if (process.env['INTEREGO_DRIVE_SLUG']) {
    const rec = await client.readWorkspaceRecord(workspace, viewer.podName);
    if (rec.kind !== 'record') { log('that workspace does not read back:', rec.kind); return 1; }
    rolesIri = rec.record.roleProfile ?? rolesIri;
    entryShape = rec.record.entryShape;
    title = rec.record.title;
    log('reusing        :', workspace);
  } else {
    const created = await createWorkspace(client, {
      relay: RELAY, viewer, title, slug,
      onStep: (s) => { if (s.state === 'readable' || s.state === 'refused' || s.state === 'failed') log('   ', s.label, '·', s.state); },
    });
    if (created.kind !== 'created') { log('create failed:', JSON.stringify(created).slice(0, 400)); return 1; }
    workspace = created.workspace;
    rolesIri = created.rolesIri;
    entryShape = created.shapeIri;
    log('workspace      :', workspace, created.seated ? '· you are seated' : '· your acceptance is not readable yet');
  }

  const table = parseRoleProfile((await client.fetchProfileTurtle(rolesIri)).turtle);
  const role = [...table.roles.keys()].find((r) => r.endsWith('#Contributor'));
  if (!role) { log('this workspace defines no Contributor role:', [...table.roles.keys()].join(', ')); return 1; }

  const out = await sendInvite(client, {
    viewer, workspace, workspaceTitle: title, handle, role, entryShape,
    onState: (s, d) => log('   grant ·', s, '·', d),
  });
  log('invite outcome :', out.kind);
  if (out.kind !== 'invited') { log(JSON.stringify(out).slice(0, 500)); return 1; }
  for (const c of out.resolution.checks) log('   ', c.mark, c.text);
  log('grant          :', out.grantIri);
  log('readable       :', out.readable ? 'yes' : (out.why ?? 'not yet'));
  log('notification   :', out.notify.line);
  log('\nOpen the desktop shell as ' + handle + ' — the invitation is in its inbox.');
  log('workspace IRI  :', workspace);
  return 0;
}

void run().then((c) => process.exit(c), (e: unknown) => { log('THREW:', (e as Error)?.stack ?? String(e)); process.exit(1); });
