#!/usr/bin/env tsx
/**
 * The Claude Code agent talking to another agent IN THE CHANNEL, as itself.
 *
 * ── WHY THIS AND NOT MORE HTTP PROBES ────────────────────────────────────────────────────────
 *
 * Everything tested so far was this agent calling the Foxxi bridge directly. That exercises the
 * bridge and proves nothing about the workspace: no entry is written, nobody can see it happen, and
 * the other agent is never actually addressed. It is testing the room from outside the room.
 *
 * This writes a real entry to the real stream, addressed to another agent's DID, signed by this
 * agent's own key and attributed to it — the same `postEntry` path the desktop shell and the
 * Discord bot use. The other agent's host sees an entry addressed to it and answers on the record,
 * where a person watching the channel sees both halves.
 *
 * ★ `own-account` FOOTING, DELIBERATELY. The two a writer may state are "on behalf of my principal"
 * and "on my own account". This agent is poking at the system on its own initiative, not relaying
 * anything the human said, so claiming to speak for them would be a false statement about
 * authorship in a signed region. An agent is a delegate, never the human.
 *
 * ★ IT WRITES TO ITS DELEGATOR'S POD, WHICH IS THE WHOLE POINT OF A DELEGATION. `postEntry` requires
 * `author` precisely so the writer has to say who is speaking; the pod is the delegator's, the key
 * is the delegate's, and the registry row on that pod is what makes the pair legitimate. A reader
 * checks all three separately.
 *
 * Usage:
 *   npx tsx applications/shared-workspace/tools/claude-code-converse.ts --to <agentId> --say "..."
 *   npx tsx applications/shared-workspace/tools/claude-code-converse.ts --read        # just listen
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import {
  WorkspaceClient, RelayMcpTransport, readViewer,
  listWorkspaces, foldRoster, postEntry, podOfNsIri,
} from '@interego/workspace-client';
import { mintBearer, type Signer } from './live-identity.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
const CLIENT_NAME = 'interego-claude-code';
/** The pod that authorised this agent — where its entries land. */
const DELEGATOR = process.env['CLAUDE_CODE_DELEGATOR'] ?? 'u-eth-8f3b8e939600';

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const readOnly = argv.includes('--read');
const to = arg('--to');
/**
 * ★ `--say-file` EXISTS BECAUSE `--say` SILENTLY POSTED ONE LINE OF A TWENTY-LINE MESSAGE.
 *
 * A multi-line argument does not survive the shell → npx → node hop intact: it arrives split, and
 * `argv[i + 1]` is then just the first line. The entry was accepted, signed, addressed and
 * attributed — a perfectly valid record of a message that had been cut down to its first sentence,
 * with nothing anywhere reporting a problem. Reading anything of substance out of a file removes
 * the quoting layer that did the damage.
 *
 * `--say` is kept for one-liners, and now refuses anything containing a newline rather than
 * quietly posting the head of it.
 */
const sayFile = arg('--say-file');
const sayArg = arg('--say');
if (sayArg !== undefined && /[\r\n]/.test(sayArg)) {
  process.stderr.write('--say received a multi-line value, which the shell may already have truncated. Use --say-file.\n');
  process.exit(2);
}
const say = sayFile !== undefined ? readFileSync(sayFile, 'utf8').trim() : sayArg;

const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };
const head = (s: string): void => { log('\n== ' + s + ' ' + '='.repeat(Math.max(0, 62 - s.length))); };

const saved = JSON.parse(readFileSync(join(REPO, '.interego', 'claude-code-agent.json'), 'utf8')) as { privateKey: string };
const wallet = new Wallet(saved.privateKey);

head('seating this agent');
const bearer = await mintBearer(RELAY, IDENTITY, wallet as unknown as Signer, CLIENT_NAME);
const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearer));
await client.connect();
const viewer = await readViewer(client);
// ★ READ, never composed: the relay normalises the client name (interego-claude-code ->
// claude-code-<pod>), and every address and every scope lookup keys on the DID it assigns.
const sessionAgent = (await client.podStatus())['sessionAgent'] as { did?: string } | undefined;
const agentId = sessionAgent?.did;
if (!agentId) { log('the relay reported no sessionAgent.did; nothing to do'); process.exit(1); }
log('me      :', agentId);
log('writing to delegator pod:', DELEGATOR);

head('finding the workspace');
const list = await listWorkspaces(client, RELAY, DELEGATOR);
const rooms = list.entries;
if (rooms.length === 0) {
  log('no workspace found on', DELEGATOR, '— nothing to join.');
  log(JSON.stringify(list).slice(0, 400));
  process.exit(1);
}
for (const w of rooms) log('  ', w.slug, '·', w.workspace);
const room = rooms[0]!;
// A row whose acceptance names no workspace IRI cannot be opened — there is nothing to read the
// record out of, and guessing the IRI would address a different room than the one accepted.
const workspaceIri = room.workspace;
if (!workspaceIri) { log('that acceptance names no workspace IRI; nothing to open.'); process.exit(1); }
log('using   :', workspaceIri);

const iriOwner = podOfNsIri(workspaceIri) ?? DELEGATOR;
const rec = await client.readWorkspaceRecord(workspaceIri, iriOwner);
if (rec.kind !== 'record') { log('the workspace record did not read:', rec.kind, JSON.stringify(rec).slice(0, 300)); process.exit(1); }

const fold = await foldRoster(client, {
  workspace: workspaceIri, iriOwner, slug: room.slug,
  convener: rec.record.convener, convenerPod: rec.record.convenerPod, readCap: 200,
});

head('who is in the room');
for (const s of fold.seats) {
  log(`  ${s.seated ? 'seated ' : 'unseated'} ${(s.podServed ?? s.pod)}  stream=${s.stream ? 'yes' : 'no'}`);
}
const mySeat = fold.seats.find((s) => (s.podServed ?? s.pod) === DELEGATOR && s.seated);
const streamIri = mySeat?.stream ?? null;
// A seat with no stream is a member who has never spoken; there is no log to append to, and
// inventing one here would write outside the composition every reader folds.
if (!streamIri) { log('my delegator has no seated stream in this workspace; nothing to write to.'); process.exit(1); }

if (readOnly) { log('\n--read given; nothing was written.'); process.exit(0); }
if (!to || !say) { log('\npass --to <agentId> --say-file <path> to speak, or --read to listen.'); process.exit(2); }

head('speaking, addressed to the other agent');
log('to    :', to);
// The FULL length and the LAST line, not just the first — the truncation that shipped a one-line
// message was invisible precisely because the log echoed a plausible-looking opening line.
const lines = say.split('\n');
log('length:', say.length, 'chars,', lines.length, 'line(s)');
log('first :', lines[0]);
log('last  :', lines[lines.length - 1]);
const out = await postEntry(client, {
  podName: DELEGATOR,
  streamIri,
  workspace: workspaceIri,
  body: say,
  author: { kind: 'delegate', agentId, footing: { kind: 'own-account' } },
  entryShape: rec.record.entryShape,
  addressedTo: [to],
});
log('result:', out.kind, out.kind === 'accepted' ? `seq=${out.seq} ${out.descriptorUrl}` : JSON.stringify(out).slice(0, 400));
if (out.kind !== 'accepted') process.exit(1);
log('\nWritten to the record. The addressed agent answers when its host next runs.');
