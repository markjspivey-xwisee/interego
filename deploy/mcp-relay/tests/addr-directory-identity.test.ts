#!/usr/bin/env tsx
/**
 * A directory row must say WHAT an identity is, and a delivery receipt must say WHO it reached.
 *
 * ── THE DEFECT, MEASURED 2026-08-24 ──────────────────────────────────────────
 *
 * An external agent sent findings addressed to "the maintainer". It read `list_known_pods`,
 * saw four rows distinguished only by opaque pod slugs plus a `surface` string, and picked
 * the one whose surface said `interego` — the project's own name, and so the most
 * maintainer-looking string on offer. `notify_agent` answered `delivered: true`. The
 * message had gone to the DISCORD BOT, whose DID says
 * `did:web:identity.interego.xwisee.com:agents:interego-discord-u-eth-053ad15f9633`. The
 * maintainer never saw it and only found out by checking empty inboxes.
 *
 * They did not misread published data. Two things were wrong on our side:
 *
 *   1. THE DIRECTORY THREW AWAY THE HALF THAT DISTINGUISHES. The auto-registration hook
 *      derived the surface with `sessId.split('-')[0]` — a SECOND spelling of a derivation
 *      this file already had (`surfaceSlugFromAgentId`, which cuts at the pod-id tail and
 *      keeps the whole head). `interego-discord` became `interego`; `claude-code-vscode`
 *      became `claude`. The truncated value was then persisted and served in the WebFinger
 *      and ActivityPub cards.
 *
 *   2. THE CONFIRMATION CONFIRMED THE WRITE, NOT THE RECIPIENT. `notify_agent` answered
 *      `delivered: true`, `to` (the string the sender typed) and `targetPod` (a URL ending
 *      in the same opaque slug). Every one of those is true, and none of them answers "did
 *      this reach the agent I meant" — so nothing sent the sender back to look.
 *
 * ── AND THE FIRST FIX HAD THE SAME SHAPE, DRIVEN ────────────────────────────
 *
 * A reviewer booted the real `server.ts` against a federation store holding both agent
 * cards and called `/tool/list_known_pods` over the wire. Every row came back
 * `identifiedBy: "nothing"` — "addressing it is a guess" — with `hydrateSourceCount: 2`,
 * because `startFederationHydrate` copied url/via/addedAt/label/owner out of the store and
 * dropped `did`, `webId`, `surface`, `handle`, `inbox` and `channels`. The row was holding
 * the DID that names the agent, as `owner`, one field over. The derivation was right and
 * the field never reached it. So:
 *
 *   3. §6 executes `knownPodFromStoredEntry`, the projection the load now goes through.
 *   4. §7 is a negative over the RAW file: each false claim this suite has already shipped
 *      is asserted absent by its own words. A false comment is a defect in this package.
 *
 * ── AND THE SECOND FIX HAD IT AGAIN, IN TWO PLACES, ALSO DRIVEN ─────────────
 *
 * The fix for the above widened the read to `owner`, on the argument that it was the one
 * identifying field the generic persist path never dropped. Booted for real:
 *
 *   5. AN ORDINARY AUTHENTICATED STRANGER COULD MINT AN IDENTITY. `add_pod {pod_url: <a pod
 *      it does not control>, owner: "did:web:…:agents:maintainer-u-eth-8f3b8e939600"}`
 *      returned HTTP 200, and the row then published `identifiedBy: "did:web agent name",
 *      surface: "maintainer"`; `notify_agent` answered `recipientKnown: true, resolvedTo:
 *      "maintainer-…"`; the ActivityPub actor served `summary: "Interego agent
 *      (maintainer)"`. That is the original incident, minted on demand. `owner` is now
 *      reported as `claimedAgent` with its own `identifiedBy` — §4.
 *   6. AND THE FIELDS THAT *ARE* AUTH-DERIVED WERE WRITABLE TOO. The REST auto-registration
 *      site read `req.body.agent_id` / `req.body.pod_name`, which
 *      `injectRestVerifiedIdentity` only DEFAULTS on the bearer branch — so a bearer
 *      sending both persisted a `did:web` onto a pod row it did not control, and
 *      `notify_agent` delivered there via `directory-did`. Without §5.2b the provenance
 *      split in §4 would have been a false claim. — §5.2b.
 *   7. AND EVERY CARD-LESS WRITER ERASED THE CARD. `add_pod` on a pod that HAD registered
 *      left the store with no did/webId/owner/surface/handle/channels; the actor lost its
 *      `publicKey`; `notify_agent` to that agent's own DID answered "could not resolve
 *      recipient". `mergeDirectoryRow` — §8 — and the widened write projection — §9.
 *
 * ── WHAT THIS FILE ASSERTS, AND WHY IN TWO HALVES ────────────────────────────
 *
 * §1–§4, §6 and §8 EXECUTE THE REAL FUNCTIONS. `server.ts` calls `app.listen()` at module scope and
 * cannot be imported, and extracting these helpers into a module of their own would need a
 * `COPY` line in `deploy/Dockerfile.relay` (see image-copies-every-source.test.ts). So the
 * declarations are sliced OUT OF server.ts by source anchors, written to one temp module and
 * imported — the assertions run the exact characters that ship, not a reimplementation of
 * them. A harness standing in for the derivation could not have caught the truncation,
 * because the truncation IS the derivation.
 *
 * §5, §8's wiring half and §9 are source-text over the COMMENT-STRIPPED file, which this
 * package knows is the weaker instrument: a regex has already been satisfied here by a
 * token sitting in code no request reached. They are written to survive that where they
 * can — §5.1, §5.2b and §5.4's `identifiedBy !== 'nothing'` check are NEGATIVE assertions
 * over the whole file, which dead code cannot satisfy; §8's and §9's counts fail on a NEW
 * call site rather than only on a removed one; and every other check is bound to a region
 * delimited by CODE anchors so a rationale comment can neither satisfy nor defeat one.
 * The one property none of them can reach is whether a request gets there, which is what
 * the driven runs quoted above are for.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/addr-directory-identity.test.ts
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import express from 'express';

import { listenLoopback } from './listen-loopback.js';
import { stripComments } from './strip-comments.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(here, '..', 'server.ts');
const SERVER = readFileSync(SERVER_PATH, 'utf8');
const CODE = stripComments(SERVER, 'server.ts');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/** The text between two anchors, so an assertion is about ONE call site and not the file. */
function region(src: string, from: string, to: string, label: string): string {
  const a = src.indexOf(from);
  if (a < 0) { failures++; console.error(`  FAIL region ${label} — anchor not found: ${from}`); return ''; }
  const b = src.indexOf(to, a + from.length);
  if (b < 0) { failures++; console.error(`  FAIL region ${label} — end anchor not found: ${to}`); return ''; }
  return src.slice(a, b);
}

// ── Load the SHIPPED declarations ────────────────────────────────────────────
//
// The four things under test are contiguous in server.ts: the pod-id suffix pattern, the
// two readers of an agent name, and the row describer. Slicing from the first to the
// declaration that follows them takes the real bodies, comments and all.
const SLICE_FROM = 'const AGENT_POD_ID_SUFFIX';
const SLICE_TO = 'function bareAgentId(';
const from = SERVER.indexOf(SLICE_FROM);
const to = SERVER.indexOf(SLICE_TO, from + 1);
// ★★ AND THE STORE→MEMORY PROJECTION, sliced separately because it lives beside the
// federation store 900 lines further down. It is here for the reason §6 exists: the
// derivation above was correct and still answered "nothing", because this projection
// dropped the field it derives from. The two are only meaningful tested together.
const LOAD_FROM = 'function knownPodFromStoredEntry(';
const LOAD_TO = 'let federationHydrateReady';
const loadFrom = SERVER.indexOf(LOAD_FROM);
const loadTo = SERVER.indexOf(LOAD_TO, loadFrom + 1);
// ★★ AND THE WRITE-SIDE MERGE, sliced third. §8 exists because the read side was made
// honest twice over while the WRITERS went on replacing whole rows: a stranger's `add_pod`
// deleted the agent card of the pod it named. A projection that reports what a row holds
// is worth nothing next to a writer that empties the row.
// ★★ AND THE ADDRESS-OWNERSHIP TEST, sliced fourth. §12 exists because `cardForLocalPart`
// matched a federation row by its LAST PATH SEGMENT with no test that the row could OWN that
// address, while `add_pod` accepts an ARBITRARY url from any authenticated caller — so a
// stranger could squat a PUBLISHED identity and have the relay serve that address's WebFinger
// and ActivityPub actor from its own domain. Four clients recompose that handle to find a
// member's pod before sealing a private workspace record to them.
const OWNS_FROM = 'function podOwnsLocalPart(';
const OWNS_TO = 'function podLocalPart(';
const ownsFrom = SERVER.indexOf(OWNS_FROM);
const ownsTo = SERVER.indexOf(OWNS_TO, ownsFrom + 1);
const MERGE_FROM = 'function mergeDirectoryRow(';
const MERGE_TO = '// Federation store config';
const mergeFrom = SERVER.indexOf(MERGE_FROM);
const mergeTo = SERVER.indexOf(MERGE_TO, mergeFrom + 1);
if (from < 0 || to < 0 || loadFrom < 0 || loadTo < 0 || mergeFrom < 0 || mergeTo < 0
  || ownsFrom < 0 || ownsTo < 0) {
  console.error(`\nFAIL — cannot locate the identity helpers in server.ts (from=${from}, to=${to}, load=${loadFrom}/${loadTo}, merge=${mergeFrom}/${mergeTo}).`);
  console.error('  If they were renamed or moved, this suite is testing nothing. Re-anchor it.');
  process.exit(1);
}
const tmpDir = mkdtempSync(join(tmpdir(), 'addr-identity-'));
const tmpModule = join(tmpDir, 'addr-extracted-helpers.ts');
type DirectoryIdentity = {
  agent?: string; surface?: string;
  identifiedBy: 'did:web agent name' | 'registered surface' | 'unverified owner claim' | 'nothing';
  claimedAgent?: string; claimedSurface?: string; claimNote?: string;
  identityNote?: string;
};
type StoredRow = Record<string, unknown> & { url: string; via: string; addedAt: string };
let podOwnsLocalPart: (podUrl: string, localPart: string) => boolean;
let surfaceSlugFromAgentId: (id: string | undefined) => string | undefined;
let agentSlugFromDid: (did: string | undefined) => string | undefined;
let describeDirectoryEntry: (e: {
  did?: string | undefined; webId?: string | undefined; owner?: string | undefined;
  surface?: string | undefined; via?: string | undefined;
}) => DirectoryIdentity;
let knownPodFromStoredEntry: (e: StoredRow) => Record<string, unknown>;
let identityIsObserved: (id: DirectoryIdentity) => boolean;
let mergeDirectoryRow: (
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
  writer: 'own-agent' | 'third-party',
) => Record<string, unknown>;
try {
  writeFileSync(
    tmpModule,
    // The three slices carry type annotations naming declarations that live elsewhere in
    // server.ts (`FederationEntry`, `KnownPodEntry`, `RowWriter`). tsx transpiles rather
    // than typechecks, so those positions are erased — the BODIES that run are the shipped
    // characters, which is the only property this file needs from them.
    `type FederationEntry = StoredRow;\ntype KnownPodEntry = Record<string, unknown>;\n`
      + `type RowWriter = 'own-agent' | 'third-party';\n`
      + `type StoredRow = Record<string, unknown> & { url: string; via: string; addedAt: string };\n`
      + `${SERVER.slice(from, to)}\n${SERVER.slice(loadFrom, loadTo)}\n${SERVER.slice(mergeFrom, mergeTo)}\n`
      + `${SERVER.slice(ownsFrom, ownsTo)}
`
      + `export { surfaceSlugFromAgentId, agentSlugFromDid, describeDirectoryEntry, `
      + `knownPodFromStoredEntry, identityIsObserved, mergeDirectoryRow, podOwnsLocalPart };\n`,
    'utf8',
  );
  const mod = await import(pathToFileURL(tmpModule).href) as {
    surfaceSlugFromAgentId: typeof surfaceSlugFromAgentId;
    agentSlugFromDid: typeof agentSlugFromDid;
    describeDirectoryEntry: typeof describeDirectoryEntry;
    knownPodFromStoredEntry: typeof knownPodFromStoredEntry;
    identityIsObserved: typeof identityIsObserved;
    mergeDirectoryRow: typeof mergeDirectoryRow;
    podOwnsLocalPart: typeof podOwnsLocalPart;
  };
  surfaceSlugFromAgentId = mod.surfaceSlugFromAgentId;
  agentSlugFromDid = mod.agentSlugFromDid;
  podOwnsLocalPart = mod.podOwnsLocalPart;
  describeDirectoryEntry = mod.describeDirectoryEntry;
  knownPodFromStoredEntry = mod.knownPodFromStoredEntry;
  identityIsObserved = mod.identityIsObserved;
  mergeDirectoryRow = mod.mergeDirectoryRow;
} finally {
  // A probe file that outlives its run is litter in someone else's typecheck.
  rmSync(tmpDir, { recursive: true, force: true });
}

// The four identities from the live directory the incident was measured against.
const DISCORD_DID = 'did:web:identity.interego.xwisee.com:agents:interego-discord-u-eth-053ad15f9633';
const DISCORD_POD = 'u-eth-053ad15f9633';
const MAINTAINER_POD = 'u-eth-8f3b8e939600';

console.log('\nADDR — the directory says what an identity is, and notify_agent says who it reached');

// ── 1. THE INCIDENT, AS A UNIT ───────────────────────────────────────────────
console.log('\n1. the Discord bot does not read as the project');
{
  const surface = surfaceSlugFromAgentId(`interego-discord-${DISCORD_POD}`);
  check('the bot\'s surface is interego-discord', surface === 'interego-discord', `got ${String(surface)}`);
  check('and is NOT the project name alone', surface !== 'interego', `got ${String(surface)}`);

  // The mirror image: a surface that legitimately IS one token stays one token, so the
  // fix cannot be "always keep everything".
  check('a single-token surface is unchanged', surfaceSlugFromAgentId('chatgpt-u-pk-b03a054d6915') === 'chatgpt');
  check('claude-code-vscode survives intact',
    surfaceSlugFromAgentId('claude-code-vscode-u-pk-b03a054d6915') === 'claude-code-vscode');
  check('claude-mobile survives intact',
    surfaceSlugFromAgentId('claude-mobile-u-pk-b03a054d6915') === 'claude-mobile');
}

// ── 2. THE POD ID IS A TAIL, AND AN UNREADABLE NAME IS REPORTED UNREAD ───────
console.log('\n2. the cut is at the pod id, and only there');
{
  check('u-eth- pods cut correctly', surfaceSlugFromAgentId(`interego-discord-${DISCORD_POD}`) === 'interego-discord');
  check('bare eth- pods cut correctly', surfaceSlugFromAgentId('claude-code-eth-8f3b8e939600') === 'claude-code');
  check('u-did- pods cut correctly', surfaceSlugFromAgentId('cursor-u-did-0a1b2c3d4e5f') === 'cursor');

  // ★ A name with no pod-id tail yields NOTHING rather than its first token. That is the
  // whole difference between this and `split('-')[0]`, stated as a property.
  check('a name with no pod-id tail is unread, not truncated',
    surfaceSlugFromAgentId('interego-discord') === undefined,
    `got ${String(surfaceSlugFromAgentId('interego-discord'))}`);
  check('a bare pod id has no surface at all', surfaceSlugFromAgentId(DISCORD_POD) === undefined);
  check('empty input is undefined', surfaceSlugFromAgentId('') === undefined);
  check('undefined input is undefined', surfaceSlugFromAgentId(undefined) === undefined);
}

// ── 3. A DID ONLY NAMES AN AGENT WHEN IT NAMES AN AGENT ──────────────────────
console.log('\n3. agentSlugFromDid refuses to guess');
{
  check('did:web …:agents:<name> yields the name',
    agentSlugFromDid(DISCORD_DID) === `interego-discord-${DISCORD_POD}`);
  check('a did:web with no agents segment yields nothing',
    agentSlugFromDid('did:web:example.com') === undefined,
    `got ${String(agentSlugFromDid('did:web:example.com'))}`);
  check('a did:web with a different path yields nothing',
    agentSlugFromDid('did:web:example.com:users:alice') === undefined);
  check('did:ethr yields nothing', agentSlugFromDid('did:ethr:0x8f3b8e939600aaaabbbbccccddddeeeeffff0000') === undefined);
  check('a WebID URL yields nothing', agentSlugFromDid('https://identity.example/u/alice#me') === undefined);
  check('undefined yields nothing', agentSlugFromDid(undefined) === undefined);
}

// ── 4. WHAT A ROW SAYS IT IS, AND ON WHAT EVIDENCE ───────────────────────────
console.log('\n4. describeDirectoryEntry reads the DID, and says so');
{
  // ★ THE STALE-STORE CASE, which is the one that decides whether this fix works on the
  // fleet the day it deploys. The federation store still holds `surface: 'interego'` for
  // every agent registered before the truncation was fixed, and it is only rewritten when
  // that agent next authenticates. Deriving at READ time is what makes the row correct now.
  const stale = describeDirectoryEntry({ did: DISCORD_DID, surface: 'interego' });
  check('the DID beats the stale stored surface', stale.surface === 'interego-discord', `got ${String(stale.surface)}`);
  check('the full mesh name is reported', stale.agent === `interego-discord-${DISCORD_POD}`);
  check('the evidence is named', stale.identifiedBy === 'did:web agent name');
  check('an identified row carries no identityNote', stale.identityNote === undefined);

  // A row whose DID is unreadable falls back to what it registered, and says which.
  const registered = describeDirectoryEntry({ surface: 'chatgpt' });
  check('a surface-only row still reports its surface', registered.surface === 'chatgpt');
  check('and names the weaker evidence', registered.identifiedBy === 'registered surface');
  check('and claims no mesh name', registered.agent === undefined);

  // ★ AND THE ROW THAT SAYS NOTHING SAYS THAT. An unidentified pod must not be shaped like
  // an identified one — that is what left four indistinguishable rows to choose between.
  const anon = describeDirectoryEntry({ via: 'manual' });
  check('an unidentified row is labelled "nothing"', anon.identifiedBy === 'nothing');
  check('and explains itself rather than leaving a blank',
    typeof anon.identityNote === 'string' && anon.identityNote.includes('no did:web naming an agent'),
    `got ${String(anon.identityNote)}`);
  check('and asserts no agent or surface', anon.agent === undefined && anon.surface === undefined);
  // ★★ AND IT CLAIMS ONLY WHAT WAS CHECKED. The note used to read "no agent card — nothing
  // published to this directory says who or what this pod is". The relay never dereferences
  // a DID and cannot see another directory, so "nothing published" was a verdict on a wider
  // question than the one it looked at — and a driven run falsified even the narrow reading,
  // because two pods that HAD published cards read "nothing" after a restart.
  check('and scopes the claim to this directory\'s own record',
    anon.identityNote?.includes('this directory\'s record') === true,
    `got ${String(anon.identityNote)}`);
  check('and does not claim the pod published nothing anywhere',
    anon.identityNote?.includes('published') !== true,
    `got ${String(anon.identityNote)}`);

  // The caller's own row is unidentified for a different reason, and is told the reason.
  const self = describeDirectoryEntry({ via: 'self' });
  check('the self row is not accused of being anonymous',
    self.identityNote !== undefined && !self.identityNote.includes('addressing it is a guess'),
    `got ${String(self.identityNote)}`);

  // ★★ AND `owner` IS A CLAIM. A previous round read it as a third source for `agent` and
  // `surface`, arguing it was the one identifying field the generic persist path never
  // dropped. Driven against the booted relay, a stranger's
  // `add_pod {pod_url: <a pod it does not control>, owner: "did:web:…:agents:maintainer-…"}`
  // then published `identifiedBy: "did:web agent name", surface: "maintainer"` on that row,
  // `notify_agent` answered `recipientKnown: true`, and the ActivityPub actor served
  // `summary: "Interego agent (maintainer)"`. `agentSlugFromDid`'s narrowness was no
  // defence: a caller who wants that shape types that shape.
  const claimed = describeDirectoryEntry({ via: 'manual', owner: `did:web:identity.example:agents:maintainer-${MAINTAINER_POD}` });
  check('a did:web in owner does NOT become the row\'s agent',
    claimed.agent === undefined, `got ${String(claimed.agent)}`);
  check('and does NOT become the row\'s surface',
    claimed.surface === undefined, `got ${String(claimed.surface)}`);
  check('the evidence is named as the claim it is',
    claimed.identifiedBy === 'unverified owner claim', `got ${claimed.identifiedBy}`);
  check('the name is still reported, under a field that says it is claimed',
    claimed.claimedAgent === `maintainer-${MAINTAINER_POD}`, `got ${String(claimed.claimedAgent)}`);
  check('with its head, likewise marked', claimed.claimedSurface === 'maintainer');
  check('and a note saying who can write that field',
    claimed.claimNote?.includes('any authenticated caller can write') === true, `got ${String(claimed.claimNote)}`);
  check('and the row still says addressing it is a guess',
    claimed.identityNote?.includes('addressing it is a guess') === true, `got ${String(claimed.identityNote)}`);
  // ★ AND `recipientKnown` MUST NOT COUNT IT. The predicate is a closed positive list
  // precisely so that adding an evidence value cannot widen a reader by accident — which
  // is what `identifiedBy !== 'nothing'` would have done to this exact value.
  check('a claim is not observed evidence', identityIsObserved(claimed) === false);
  check('a did:web card IS observed evidence',
    identityIsObserved(describeDirectoryEntry({ did: DISCORD_DID })) === true);
  check('a registered surface IS observed evidence',
    identityIsObserved(describeDirectoryEntry({ surface: 'chatgpt' })) === true);
  check('an unidentified row is not observed evidence',
    identityIsObserved(describeDirectoryEntry({ via: 'manual' })) === false);

  // `owner` is frequently a person or a did:ethr, neither of which names an agent — those
  // stay plain `nothing` with no claim attached, so a claim means a claim.
  check('a person WebID in owner identifies nobody',
    describeDirectoryEntry({ via: 'manual', owner: 'https://identity.example/u/alice#me' }).identifiedBy === 'nothing');
  check('a did:ethr owner identifies nobody',
    describeDirectoryEntry({ via: 'manual', owner: 'did:ethr:0x8f3b8e939600aaaabbbbccccddddeeeeffff0000' }).identifiedBy === 'nothing');
  check('a did:web owner with no agents segment identifies nobody',
    describeDirectoryEntry({ via: 'manual', owner: 'did:web:identity.interego.xwisee.com' }).identifiedBy === 'nothing');
  check('and none of those invents a claimedAgent',
    [
      describeDirectoryEntry({ via: 'manual', owner: 'https://identity.example/u/alice#me' }),
      describeDirectoryEntry({ via: 'manual', owner: 'did:ethr:0x8f3b8e939600aaaabbbbccccddddeeeeffff0000' }),
      describeDirectoryEntry({ via: 'manual', owner: 'did:web:identity.interego.xwisee.com' }),
    ].every(x => x.claimedAgent === undefined && x.claimNote === undefined));

  // A real card wins, and the disagreeing owner is REPORTED rather than shadowed — an
  // `owner` that says something other than the recorded DID is somebody's edit of a row
  // this relay had already identified, which is worth seeing.
  const contested = describeDirectoryEntry({ did: DISCORD_DID, owner: 'did:web:identity.example:agents:someone-else-u-pk-0000000000' });
  check('did still beats owner', contested.agent === `interego-discord-${DISCORD_POD}`);
  check('and the disagreeing owner is surfaced as a claim, not dropped',
    contested.claimedAgent === 'someone-else-u-pk-0000000000', `got ${String(contested.claimedAgent)}`);
  check('an identified row is still observed evidence despite the claim',
    identityIsObserved(contested) === true && contested.identifiedBy === 'did:web agent name');
  // The relay's OWN registration sets `owner` to the same DID it recorded, so that must
  // NOT be re-reported as somebody's claim — a warning on every healthy row is noise, and
  // noise is how a real one gets skipped.
  check('an owner equal to the recorded did is not reported as a claim',
    describeDirectoryEntry({ did: DISCORD_DID, webId: DISCORD_DID, owner: DISCORD_DID }).claimedAgent === undefined);

  // A webId-only card (no did) is read the same way — the mesh publishes both fields.
  const viaWebId = describeDirectoryEntry({ webId: DISCORD_DID });
  check('webId is read when did is absent', viaWebId.surface === 'interego-discord');

  // ★ AND EVERY ROW CARRIES THE POD IT IS ABOUT, which is what makes two rows comparable at
  // a glance. The sender in the incident had a pod id in hand and four rows that could not
  // be checked against it; `agent` ends in the pod id, so now it can.
  const bot = describeDirectoryEntry({ did: DISCORD_DID });
  const other = describeDirectoryEntry({
    did: `did:web:identity.interego.xwisee.com:agents:claude-code-vscode-${MAINTAINER_POD}`,
  });
  check('each row names the pod it is about',
    bot.agent?.endsWith(DISCORD_POD) === true && other.agent?.endsWith(MAINTAINER_POD) === true,
    `${String(bot.agent)} / ${String(other.agent)}`);
  check('and two different pods do not read alike',
    bot.agent !== other.agent && bot.surface !== other.surface);

  // Nothing anywhere in the projection asserts a role over the deployment.
  const words = JSON.stringify([stale, registered, anon, self]).toLowerCase();
  check('no row is described as maintainer/owner/operator',
    !/maintainer|operator|"owner"|in charge/.test(words), words.slice(0, 200));
  // ★★ AND THE ROW THAT DOES CONTAIN THE WORD CARRIES IT ONLY UNDER A CLAIM FIELD. The
  // check above holds for the rows it lists, and it held before this round too — because
  // no fixture put the word in an `owner`. The one that does is asserted directly: the
  // string a stranger typed may appear, but never in the two fields every downstream
  // one-liner reads.
  check('a claimed role-word never reaches agent/surface',
    claimed.agent === undefined && claimed.surface === undefined
      && JSON.stringify({ agent: claimed.agent, surface: claimed.surface }).includes('maintainer') === false,
    JSON.stringify(claimed).slice(0, 200));
}

// ── 5. THE WIRING ────────────────────────────────────────────────────────────
console.log('\n5. the three call sites use it');
{
  // 5.1 ★ THE NEGATIVE, over the WHOLE comment-stripped file. Dead code cannot satisfy an
  // assertion that a spelling is absent, so this is the one check here immune to the
  // failure mode this package has already been bitten by. It is the exact defect: the
  // second spelling of the derivation, anywhere in the relay.
  check('the truncating spelling is gone from server.ts', !CODE.includes(".split('-')[0]"),
    'a `.split(\'-\')[0]` is back — that is the derivation that made the Discord bot read as `interego`');

  // 5.2 the auto-registration hook derives through the one reader.
  const autoReg = region(
    CODE,
    "const sessId = (args._session_agent_id as string | undefined)",
    'autoRegisterAgentCard(',
    'auto-register surface derivation',
  );
  check('auto-registration calls surfaceSlugFromAgentId', autoReg.includes('surfaceSlugFromAgentId(sessId)'),
    autoReg.replace(/\s+/g, ' ').slice(0, 160));

  // 5.2b the REST/signed path registers an IDENTITY, not how the caller authenticated —
  // and reads that identity from the SESSION, not from the wire.
  const restReg = region(
    CODE,
    'const sessionDid = req.body._session_agent_did',
    ');',
    'REST-path auto-register',
  );
  check('the REST path derives a surface from the agent id',
    restReg.includes('surfaceSlugFromAgentId(bareAgentId('),
    restReg.replace(/\s+/g, ' ').slice(0, 160));
  check('and does not file the transport as the identity', !restReg.includes("'signed'"),
    'a row reading `surface: "signed"` is back in the directory');
  // ★★ THE FORGERY THIS SITE SHIPPED. `injectRestVerifiedIdentity` only DEFAULTS
  // `agent_id`/`pod_name` on the bearer branch (`if (!target.agent_id) …`), so a value the
  // caller sent survives it — and this site read exactly those two. Driven: an ordinary
  // bearer POSTing `/tool/add_pod {pod_name: "u-pk-victim0001", agent_id:
  // "did:web:…:agents:maintainer-u-eth-8f3b8e939600"}` persisted `did`/`webId`/`surface`
  // onto a pod row it did not control, and `notify_agent {to: <that DID>}` then delivered
  // there with `resolvedVia: "directory-did"`. `did` is what `describeDirectoryEntry` calls
  // relay-OBSERVED evidence; this site was writing it from the wire, so the whole
  // provenance split above would have been a false claim while this stood.
  check('and takes the pod from the session too',
    restReg.includes('_session_user_id'),
    restReg.replace(/\s+/g, ' ').slice(0, 200));
  // ★★ THE BINDING ITSELF, NAMED. This site passes locals, so the call-site scan below
  // cannot see where they came from — and the mutant that restored the wire read changed
  // only these two lines. Stated as its own check so the failure says what broke rather
  // than "anchor not found", which is what a region anchor doubling as an assertion says.
  check('★★ the REST hook binds its identity from the RESERVED session fields, not the wire',
    CODE.includes('const sessionDid = req.body._session_agent_did')
      && CODE.includes('const sessionPod = req.body._session_user_id'),
    'a caller-supplied agent_id / pod_name is being registered again — driven, that persisted '
      + 'a forged did:web onto a pod row the caller did not control, reachable by any bearer');

  // ★★ AND THE IDENTITY-SOURCE CHECK IS ANCHOR-FREE, over EVERY call site at once.
  // Written first as a negative inside `restReg`, and the mutant that restored
  // `req.body.agent_id` killed it — but by making the region ANCHOR vanish, which turns a
  // negative over that region into `!''.includes(…)`, i.e. true. The suite still went red
  // (the region helper counts its own failure) but for the wrong reason, and a negative
  // that reports "anchor not found" is one refactor away from reporting nothing. Keyed on
  // the function NAME instead, which no rename can hide: rename it and every other check
  // in §5.2/§5.2b fails loudly.
  const callSites: string[] = [];
  for (let i = CODE.indexOf('autoRegisterAgentCard('); i >= 0; i = CODE.indexOf('autoRegisterAgentCard(', i + 1)) {
    if (CODE.slice(i - 9, i) === 'function ') continue;   // the declaration, not a call
    const end = CODE.indexOf(');', i);
    if (end > i) callSites.push(CODE.slice(i, end));
  }
  // Two hooks: the MCP tool-dispatch one and the REST/signed one. A count, so a NEW hook
  // cannot slip past unexamined by these assertions.
  check('there are exactly two auto-registration hooks',
    callSites.length === 2, `found ${callSites.length}: ${callSites.map(s => s.replace(/\s+/g, ' ').slice(0, 70)).join(' || ')}`);
  check('★★ no auto-registration site reads an identity or a pod off the wire',
    callSites.every(s => !s.includes('req.body.') && !s.includes('args.agent_id') && !s.includes('args.pod_')),
    callSites.filter(s => s.includes('req.body.') || s.includes('args.agent_id') || s.includes('args.pod_'))
      .join(' || ').replace(/\s+/g, ' ').slice(0, 240));
  // ★ POSITIVES, one per hook, and each is a POSITIVE over its region — so a moved anchor
  // fails it rather than satisfying it, which is the property the negative above could not
  // have. The MCP hook passes the session field inline; the REST hook binds it to a local
  // first, so its check is the binding (which is also this region's anchor).
  check('the MCP hook passes the session DID inline',
    callSites.some(s => s.includes('_session_agent_did')),
    callSites.map(s => s.replace(/\s+/g, ' ').slice(0, 90)).join(' || '));
  check('the REST hook binds its DID from the session field',
    restReg.includes('_session_agent_did'),
    restReg.replace(/\s+/g, ' ').slice(0, 160));

  // 5.3 list_known_pods projects an identity onto every row.
  const listPods = region(
    CODE,
    'async function handleListKnownPods(args: ToolArgs)',
    'function canonicalPodKey(url: string)',
    'handleListKnownPods',
  );
  check('list_known_pods describes every row', listPods.includes('describeDirectoryEntry(p)'),
    'rows are back to a URL and an opaque slug');

  // 5.4 notify_agent reports WHO, not only THAT.
  const notify = region(
    CODE,
    'async function handleNotifyAgent(args: ToolArgs)',
    'async function handleSignRequest(args: ToolArgs)',
    'handleNotifyAgent',
  );
  // ★★ BOUND TO THE RESPONSE LITERAL, NOT TO THE HANDLER. Written first as
  // `notify.includes('resolvedTo')`, and a mutant that DELETED `resolvedTo` from the returned
  // object survived it — the handler still declares `const resolvedTo = …` and still
  // interpolates it into a warning string, so the token was present in code that no longer
  // reached the caller. That is this package's recorded failure mode (see the header), caught
  // here only because the mutant was actually run. Every field check below reads the
  // `return JSON.stringify({…})` literal, which is the thing the sender receives.
  //
  // ★ AND IT IS THE **LAST** `return JSON.stringify({` IN THE HANDLER. The first two are the
  // one-line refusals at the top (`delivered: false, error: …`), so anchoring on the first
  // occurrence spanned the whole handler and the mutant survived a SECOND time — the region
  // that was supposed to be the response literal still contained every local declaration.
  const receiptStart = notify.lastIndexOf('return JSON.stringify({');
  if (receiptStart < 0) { failures++; console.error('  FAIL notify_agent has no JSON response literal'); }
  const receipt = receiptStart >= 0 ? notify.slice(receiptStart) : '';
  check('the receipt names the recipient', /\bresolvedTo\b/.test(receipt),
    'the answer is back to `delivered: true` plus the string the sender typed');
  check('the receipt says how it resolved', /\bresolvedVia\b/.test(receipt));
  check('the receipt says whether the recipient is identified', /\brecipientKnown\b/.test(receipt));
  // ★★ AND THE TWO FACTS ARE SEPARATE FIELDS. `recipientKnown` was `!!identityCard` — "a
  // row for this URL exists in knownPods" — and a driven run returned `recipientKnown: true`
  // directly above `identifiedBy: "nothing"` and "addressing it is a guess", in one object.
  // The row's existence is now `inDirectory`, which claims only that.
  check('the receipt reports directory presence separately', /\binDirectory\b/.test(receipt),
    '`recipientKnown` is carrying two questions again');
  // ★★ AND IT ASKS THE CLOSED LIST. `recipient.identifiedBy !== 'nothing'` was the previous
  // spelling, and it was true of the evidence value added right after it — `unverified
  // owner claim`. Driven, that combination answered `recipientKnown: true, resolvedTo:
  // "maintainer-u-eth-8f3b8e939600"` for a pod nobody had ever authenticated from.
  check('recipientKnown is read off the evidence, not off the row existing',
    notify.includes('recipientKnown = identityIsObserved(recipient)'),
    'recipientKnown means "a row exists", or "not the string nothing" — both are true of a row a stranger named');
  check('and no reader asks `identifiedBy !== \'nothing\'` anywhere in server.ts',
    !CODE.includes("identifiedBy !== 'nothing'"),
    'that spelling silently accepts whatever evidence value is added next');
  check('a row named only by its owner field is warned about as a claim',
    notify.includes('recipient.claimedAgent') && notify.includes('writable by any authenticated caller'),
    'a sender who acted on the name list_known_pods showed them gets no warning about it');
  check('an unidentified row is not answered with a name-shaped string',
    !notify.includes('— unidentified'),
    'the warning renders as: the agent "eth-8f3b8e939600 — unidentified"');
  check('an unidentified pod is reported as having no identified agent',
    notify.includes('no identified agent'));
  check('the receipt carries the recipient card itself', /\brecipient\b/.test(receipt));
  check('the receipt still carries the warning field', /\bwarning\b/.test(receipt),
    'warnings are computed and then dropped before the caller sees them');
  check('an unclaimed pod is warned about', notify.includes('no row in this federation directory covers'),
    'delivery to a pod no identity claims is reported as plain success again');
  // ★ The row-that-names-nobody case needs its own sentence: it is the one the old
  // `recipientKnown: true` hid, and the reader's next step differs from "no row at all".
  check('a row that names nobody is warned about too',
    notify.includes('holds no did:web naming an agent'),
    'a delivery to a hydrated-but-unidentified row is plain success again');
  check('addressing a pod rather than an identity is warned about',
    notify.includes('you addressed a pod, not an identity'),
    'the sender who typed a pod id is no longer told what it resolved to');
  check('the recipient identity is read off the card, not invented',
    notify.includes('describeDirectoryEntry(identityCard ?? {})'));

  // 5.5 the published WebFinger / ActivityPub card derives its surface too — those are
  // artifacts other deployments read, so a stale short name there outlives our store.
  const cards = region(
    CODE,
    'function cardForLocalPart(localPart: string)',
    "app.get('/.well-known/webfinger'",
    'cardForLocalPart',
  );
  check('the agent card derives its surface', cards.includes('describeDirectoryEntry(e).surface'),
    'the AP actor is serving the stored (possibly truncated) surface again');
}

// ── 6. THE FIELD HAS TO REACH THE DERIVATION ─────────────────────────────────
console.log('\n6. the store round-trip keeps what identifies a row');
{
  // The exact record `autoRegisterAgentCard` persists for the Discord bot.
  const stored = {
    url: `https://css.example/${DISCORD_POD}/`,
    via: 'auto',
    addedAt: '2026-01-01T00:00:00.000Z',
    label: 'Interego Discord',
    owner: DISCORD_DID,
    did: DISCORD_DID,
    webId: DISCORD_DID,
    inbox: `https://css.example/${DISCORD_POD}/inbox/`,
    surface: 'interego',
    handle: `acct:${DISCORD_POD}@relay.example`,
    channels: [{ type: 'ldn', value: `https://css.example/${DISCORD_POD}/inbox/` }],
    updatedAt: '2026-02-02T00:00:00.000Z',
  };
  const row = knownPodFromStoredEntry(stored);

  // ★★ THE ASSERTION THE 46/46 SUITE DID NOT HAVE, AND THE SET IS ENUMERATED RATHER THAN
  // COUNTED. `git show HEAD:deploy/mcp-relay/server.ts` shows the hydrate loop copying
  // url/via/addedAt/label/owner, so these SEVEN are exactly what it dropped — a row that
  // had published a card came back as a row that had not, and §4's derivation was correct
  // throughout and answered "nothing" anyway. Two comments in this package said "six" and
  // omitted `updatedAt`; a number nothing re-derives drifts, so the list lives here, where
  // the shipped function runs against it.
  const DROPPED_AT_HEAD = ['did', 'webId', 'inbox', 'surface', 'handle', 'channels', 'updatedAt'];
  for (const f of [...DROPPED_AT_HEAD, 'owner', 'label']) {
    check(`the load keeps ${f}`, row[f] !== undefined,
      `${f} was dropped between the store and knownPods — the row cannot identify itself`);
  }
  check('the load keeps the identity itself', row.did === DISCORD_DID);
  // ★ AND THE WRITE SIDE CARRIES THE SAME SEVEN, so the round trip closes. A load that
  // keeps a field the persist drops is a field that survives exactly until the next write.
  const persistProjection = region(
    CODE,
    'function runFederationPersist(entry: KnownPodEntry)',
    'function persistFederationEntry(',
    'runFederationPersist (round trip)',
  );
  for (const f of DROPPED_AT_HEAD) {
    check(`and the persist writes ${f} back`, persistProjection.includes(`entry.${f} !== undefined`),
      `${f} loads from the pod and is dropped on the way back to it`);
  }

  // ★ THE TWO HALVES COMPOSED, which is the only form in which either is worth anything.
  const identity = describeDirectoryEntry(row as { did?: string; webId?: string; owner?: string; surface?: string; via?: string });
  check('a hydrated row identifies the Discord bot', identity.agent === `interego-discord-${DISCORD_POD}`,
    `got ${String(identity.agent)}`);
  check('and the stale stored surface still loses to the DID', identity.surface === 'interego-discord',
    `got ${String(identity.surface)}`);
  check('and the row is not reported as unidentified', identity.identifiedBy === 'did:web agent name');

  // A legacy row really carrying nothing must still round-trip as nothing — the projection
  // must not invent a field to fill a gap.
  const bare = knownPodFromStoredEntry({ url: 'https://css.example/eth-0000000000/', via: 'manual', addedAt: '2026-01-01T00:00:00.000Z' });
  check('an absent field stays absent', !('did' in bare) && !('surface' in bare) && !('channels' in bare),
    JSON.stringify(bare));
  check('and such a row is honestly unidentified',
    describeDirectoryEntry(bare as { via?: string }).identifiedBy === 'nothing');

  // And the loop actually goes through it — a projection nothing calls is decoration.
  const hydrate = region(
    CODE,
    'function startFederationHydrate(): Promise<void>',
    'federationLastHydratedAt = new Date().toISOString();',
    'startFederationHydrate',
  );
  check('the hydrate loop projects through it', hydrate.includes('knownPodFromStoredEntry(entry)'),
    'the load is re-inlined — the drop can come back one field at a time');
  check('and does not re-spell the projection inline', !hydrate.includes('addedAt: entry.addedAt'),
    'a second spelling of the projection is exactly how the first one lost the seven fields above');
}

// ── 7. A FALSE COMMENT IS A DEFECT, SO THE FALSE ONES ARE NAMED ──────────────
console.log('\n7. the claims this suite has already shipped false do not come back');
{
  // ★★ OVER THE RAW FILE, COMMENTS INCLUDED — the one place in this suite where comment
  // text is the subject rather than the noise. Each string below was written here, shipped,
  // and then measured false. Naming them is cheaper than re-measuring them.
  check('no claim that read-time derivation works from the first request after deploy',
    !SERVER.includes('reads correctly from the first request after deploy'),
    'it did not: the load dropped the field the derivation reads');
  check('no claim that `identifiedBy: "nothing"` means the pod published no card',
    !SERVER.includes('means the pod has published no agent card here'),
    'two pods that HAD published cards read "nothing"; and this relay cannot see elsewhere');
  check('no claim that the schema previously showed only url and label',
    !SERVER.includes('could previously see only `url` and `label`'),
    'HEAD declared url/label/owner/via/isHome/lastSeen/subscribed');
  check('no claim that four properties were added to the row schema',
    !SERVER.includes('These four are what the row can say about itself'),
    'nine are declared: did, handle, agent, surface, identifiedBy, claimedAgent, claimedSurface, claimNote, identityNote');
  check('no claim that `owner` survives writers the card fields do not',
    !SERVER.includes('it survives writers the card fields do not'),
    'driven false: add_pod left the row with no owner at all');
  check('no claim that reading `owner` widens the evidence and not the claim',
    !SERVER.includes('Reading `owner` widens the evidence, not the claim'),
    'it widened the claim to a pod nobody ever authenticated from, on a string a stranger typed');
  check('no claim that the REST auto-register pod comes from the bound identity',
    !SERVER.includes('OWN pod derived from the\n    // bound identity (pod_name)'),
    '`pod_name` is caller wire input; injectRestVerifiedIdentity only defaults it');
  check('no claim that `identifiedBy: "nothing"` means the pod published no card, in the tool description either',
    !SERVER.includes('means that pod published no agent card here'),
    'the tool description still asserted a fact about the pod rather than about this record');
  // ★★ AND THE ONE THAT KEPT A LIVE HANG IN PRODUCTION FOR A RELEASE. Two shipped comments
  // called the stranded-resolver hazard rare and said it needed a concurrent import. Driven:
  // one call, one directory document listing a pod URL twice, no race and no second caller
  // — still open at 25s. A hedge in a comment is how a defect gets deferred, so the words
  // are named here and §10/§11 measure the property instead.
  check('no claim that the stranded-resolver hazard is rare or needs a concurrent import',
    !SERVER.includes('rare: it needs a concurrent import')
      && !SERVER.includes('it needs a concurrent import'),
    'a duplicate entry in ONE directory document is enough — see §10 and §11');
  check('no claim that `_session_agent_did` / `_session_user_id` are set unconditionally',
    !SERVER.includes('unconditionally from the verified auth on BOTH branches'),
    'the bearer branch is `if (auth.agentId)` / `if (auth.userId)`; what is true is that '
      + 'nothing but verified auth writes them');

  // ★ And the count in the replacement is checked against the schema itself, so the
  // corrected comment cannot drift out of true the way the one before it did.
  const schema = region(
    SERVER,
    'const LIST_KNOWN_PODS_OUTPUT = mcpOutputSchema({',
    'const GET_POD_STATUS_OUTPUT',
    'LIST_KNOWN_PODS_OUTPUT',
  );
  const added = ['did:', 'handle:', 'agent:', 'surface:', 'identifiedBy:',
    'claimedAgent:', 'claimedSurface:', 'claimNote:', 'identityNote:']
    .filter(k => schema.includes(`          ${k}`));
  check('the schema declares exactly the nine the comment claims', added.length === 9, added.join(','));
  check('and the comment says nine', /The NINE below/.test(schema));
  // ★ The two free-text fields must be documented AS free text where a caller reads the
  // row's shape. A schema that still calls `owner` "Owner WebID when known" is telling a
  // reader that a string a stranger typed is knowledge.
  check('the schema says `owner` is not identity evidence',
    /owner: \{ type: 'string', description: 'Free text/.test(schema),
    'owner is documented as knowledge again');
  check('the schema says `label` is not identity evidence',
    /label: \{ type: 'string', description: 'Free text/.test(schema));
}

// ── 8. A WRITER MUST NOT DELETE WHAT IT DOES NOT KNOW ────────────────────────
console.log('\n8. mergeDirectoryRow: a third party can fill a field, never empty one');
{
  // The row `autoRegisterAgentCard` leaves behind for the Discord bot.
  const card = {
    url: `https://css.example/${DISCORD_POD}/`,
    via: 'auto',
    addedAt: '2026-01-01T00:00:00.000Z',
    label: 'Interego Discord',
    owner: DISCORD_DID,
    did: DISCORD_DID,
    webId: DISCORD_DID,
    inbox: `https://css.example/${DISCORD_POD}/inbox/`,
    surface: 'interego',
    handle: `acct:${DISCORD_POD}@relay.example`,
    channels: [{ type: 'ldn', value: `https://css.example/${DISCORD_POD}/inbox/` }],
    updatedAt: '2026-02-02T00:00:00.000Z',
  };
  // Exactly what handleAddPod builds — the literal that used to be `knownPods.set` wholesale.
  const strangerAdd = {
    url: card.url, label: 'a stranger relabels it', owner: undefined,
    via: 'manual', addedAt: card.addedAt,
  };

  // ★★ THE DRIVEN DEFECT. Booted for real with this card in the store, an authenticated
  // stranger's `add_pod {pod_url: <the bot's pod>}` returned HTTP 200 and left the store
  // holding did=<none> webId=<none> owner=<none> surface=<none> handle=<none>
  // channels=<none>; the row read `identifiedBy: "nothing"`, the ActivityPub actor lost its
  // `interego:did` and `publicKey`, and `notify_agent` addressed to the bot's OWN DID
  // answered `could not resolve recipient … to a pod`. It never self-heals in-process:
  // `_autoRegistered` is a process-local Set.
  const merged = mergeDirectoryRow(card, strangerAdd, 'third-party');
  for (const f of ['did', 'webId', 'inbox', 'surface', 'handle', 'channels', 'updatedAt']) {
    check(`a third-party write keeps ${f}`, merged[f] !== undefined,
      `${f} was deleted by a writer that never had it`);
  }
  check('and keeps the owner the relay recorded', merged.owner === DISCORD_DID,
    `got ${String(merged.owner)} — a stranger emptied a field it did not supply`);
  check('and the merged row still identifies the bot',
    describeDirectoryEntry(merged as { did?: string }).agent === `interego-discord-${DISCORD_POD}`);
  check('and keeps `via: auto`, which is the relay\'s own record of having seen it register',
    merged.via === 'auto', `got ${String(merged.via)}`);
  check('and keeps the first-seen time', merged.addedAt === card.addedAt);
  // ★ `label` GOES THROUGH THE SAME RULE, and this check was first written the other way —
  // "a third party may still relabel a pod" — off a comment claiming a re-label was allowed
  // to win. It was not; the code was already fill-only and the comment was false. Keeping
  // the stricter behaviour: the label is displayed next to the identity in list_known_pods
  // and inside notify_agent's `recipient`, so a stranger rewriting the label an agent chose
  // puts their words exactly where a reader looks for that agent's.
  check('a third party cannot relabel a pod its own agent described',
    merged.label === 'Interego Discord', `got ${String(merged.label)}`);
  check('but it can label one that has no label',
    mergeDirectoryRow({ url: 'https://css.example/eth-1/', via: 'manual', addedAt: 'x' },
      { url: 'https://css.example/eth-1/', label: 'a peer I found', via: 'manual', addedAt: 'x' },
      'third-party').label === 'a peer I found');

  // ★ THE FORGERY HALF: a third party may not REPLACE a recorded owner with its own.
  const squat = mergeDirectoryRow(card, {
    url: card.url, owner: `did:web:identity.example:agents:maintainer-${MAINTAINER_POD}`,
    via: 'manual', addedAt: card.addedAt,
  }, 'third-party');
  check('a third party cannot overwrite a recorded owner', squat.owner === DISCORD_DID,
    `got ${String(squat.owner)}`);
  check('and the row is not reported as claimed when the squat did not land',
    describeDirectoryEntry(squat as { did?: string; owner?: string }).claimedAgent === undefined);

  // …but it may FILL one, and that is exactly the case the read side reports as a claim.
  const bare = { url: 'https://css.example/eth-0000000000/', via: 'manual', addedAt: '2026-01-01T00:00:00.000Z' };
  const filled = mergeDirectoryRow(bare, {
    url: bare.url, owner: `did:web:identity.example:agents:maintainer-${MAINTAINER_POD}`,
    via: 'manual', addedAt: bare.addedAt,
  }, 'third-party');
  check('a third party may fill an empty owner', filled.owner !== undefined);
  check('and the read side reports that as a claim, not as an identity',
    describeDirectoryEntry(filled as { owner?: string }).identifiedBy === 'unverified owner claim');

  // ★ THE OWN-AGENT DIRECTION, which is how a squatted row gets corrected. Without it the
  // rule would be "the first writer wins", and a pod whose row a stranger touched first
  // could never be identified by its own agent.
  const reregistered = mergeDirectoryRow(filled, {
    url: bare.url, via: 'auto', addedAt: bare.addedAt,
    owner: DISCORD_DID, did: DISCORD_DID, webId: DISCORD_DID, updatedAt: '2026-03-03T00:00:00.000Z',
  }, 'own-agent');
  check('the pod\'s own agent DOES replace a squatted owner', reregistered.owner === DISCORD_DID,
    `got ${String(reregistered.owner)}`);
  check('and the row then identifies from its own card',
    describeDirectoryEntry(reregistered as { did?: string }).identifiedBy === 'did:web agent name');

  // A first write has nothing to preserve and must not be mangled.
  const firstEver = mergeDirectoryRow(undefined, strangerAdd, 'third-party');
  check('a first write passes through unchanged', firstEver === strangerAdd);

  // ── the wiring: every writer of a directory row goes through it ────────────
  //
  // ★ A COUNT OVER THE WHOLE COMMENT-STRIPPED FILE, so a NEW writer cannot appear without
  // this section being re-read. `knownPods.set` is the only way a row enters memory, and
  // every call must be handed a value one of the two projections produced: the five below
  // go through `mergeDirectoryRow`, and the sixth is the hydrate loop, which goes through
  // `knownPodFromStoredEntry` (asserted in §6). `selfPodEntry` is not among them — it is
  // projected per-call and never stored.
  //
  // ★★ WRITTEN FIRST AS `=== 5`, AND IT FAILED: the hydrate loop is a `knownPods.set` too.
  // A count is only worth having if the number is one somebody re-derived; this one was
  // derived from a grep that had been filtered.
  const setters = CODE.split('knownPods.set(').length - 1;
  check('there are still six writers of a directory row', setters === 6,
    `found ${setters} — a new one has appeared, or one was removed; re-read this section`);
  for (const [site, anchorFrom, anchorTo] of [
    ['autoRegisterAgentCard', 'function autoRegisterAgentCard(', 'type RecipientRoute'],
    ['handleSetReachability', 'async function handleSetReachability(args: ToolArgs)', 'async function handleReadInbox'],
    ['handleAddPod', 'async function handleAddPod(args: ToolArgs)', 'async function handleRemovePod'],
    ['handleDiscoverDirectory', 'async function handleDiscoverDirectory(args: ToolArgs)', 'async function handlePublishDirectory'],
    ['handleResolveWebfinger', 'async function handleResolveWebfinger(args: ToolArgs)', 'async function handleRevokeAgent'],
  ] as const) {
    const r = region(CODE, anchorFrom, anchorTo, site);
    check(`${site} builds its row through mergeDirectoryRow`, r.includes('mergeDirectoryRow('),
      'this writer replaces the whole row again — the erasure comes back one call site at a time');
  }
  // ★ AND THE THREE THIRD-PARTY WRITERS SAY SO. The parameter is the security rule; a site
  // that mislabels itself `own-agent` would pass the check above and reopen the defect.
  for (const [site, anchorFrom, anchorTo] of [
    ['handleAddPod', 'async function handleAddPod(args: ToolArgs)', 'async function handleRemovePod'],
    ['handleDiscoverDirectory', 'async function handleDiscoverDirectory(args: ToolArgs)', 'async function handlePublishDirectory'],
    ['handleResolveWebfinger', 'async function handleResolveWebfinger(args: ToolArgs)', 'async function handleRevokeAgent'],
  ] as const) {
    const r = region(CODE, anchorFrom, anchorTo, site);
    check(`${site} declares itself a third-party writer`, r.includes("'third-party'"),
      'a writer that proved nothing about the pod is claiming to be its agent');
  }
  for (const [site, anchorFrom, anchorTo] of [
    ['autoRegisterAgentCard', 'function autoRegisterAgentCard(', 'type RecipientRoute'],
    ['handleSetReachability', 'async function handleSetReachability(args: ToolArgs)', 'async function handleReadInbox'],
  ] as const) {
    const r = region(CODE, anchorFrom, anchorTo, site);
    check(`${site} declares itself the pod's own agent`, r.includes("'own-agent'"));
  }
}

// ── 9. AND THE STORE MUST KEEP WHAT MEMORY KEPT ──────────────────────────────
console.log('\n9. one write projection, wide enough to carry the card');
{
  // ★★ `saveEntry` is a whole-file PUT. `runFederationPersist` used to build its
  // FederationEntry from url/via/addedAt/label/owner only — so even with the merge holding
  // the card in memory, the very next persist would have erased it in the STORE and the
  // next deploy would have loaded the hole back. Driven both ways: with the widening in
  // place the seeded card survived a stranger's add_pod in the store file too.
  const persist = region(
    CODE,
    'function runFederationPersist(entry: KnownPodEntry)',
    'function persistFederationEntry(',
    'runFederationPersist',
  );
  for (const f of ['did', 'webId', 'inbox', 'surface', 'handle', 'channels', 'updatedAt']) {
    check(`the persist projection carries ${f}`, persist.includes(`entry.${f} !== undefined`),
      `${f} is written to memory and dropped on the way to the pod`);
  }
  // ★ AND THERE IS ONE OF IT. The two registration sites used to call `saveFederationEntry`
  // directly with a hand-written FederationEntry — a third spelling of this projection,
  // which is how a field added to one and not the others becomes a half-identified row.
  const directSaves = CODE.split('saveFederationEntry(').length - 1;
  check('only one site writes a federation entry to the pod', directSaves === 1,
    `found ${directSaves} call sites of saveFederationEntry — the projection has been re-spelled`);

  // ★★ AND THE DEBOUNCED WRITE PERSISTS THE LIVE ROW, NOT THE ONE IT CAPTURED. `saveEntry`
  // is a whole-file PUT, so a snapshot taken 250ms ago writes away whatever another writer
  // added to that row in between — the same erasure §8 closes, delayed. An agent
  // authenticating during a `discover_directory` import lands in exactly that window.
  const debounced = region(
    CODE,
    'function persistFederationEntryDebounced(entry: KnownPodEntry)',
    'function unpersistFederationEntry(',
    'persistFederationEntryDebounced',
  );
  check('the debounced write reads the live row at write time',
    debounced.includes('knownPods.get(entry.url)'),
    'it persists the entry it captured, which is a stale row by the time the timer fires');

  // ★★ AND THE TWO REGISTRATION HOOKS DO NOT GO THROUGH THE CANCELLING ENTRY POINT.
  // `persistFederationEntry` cancels any pending debounced write for the same URL. That is
  // no longer a HANG — §10 executes the three cancel paths and each one settles the caller
  // it cancelled, which is what an earlier version of this comment got wrong when it called
  // the hazard rare and blamed a concurrent import. What remains is a write-semantics
  // argument: these two hooks run on EVERY authenticated request and have nothing to
  // supersede, so routing them through the cancelling path would tear down a concurrent
  // `discover_directory`'s coalescing timer once per request, for nothing.
  for (const [site, anchorFrom, anchorTo] of [
    ['autoRegisterAgentCard', 'function autoRegisterAgentCard(', 'type RecipientRoute'],
    ['handleSetReachability', 'async function handleSetReachability(args: ToolArgs)', 'async function handleReadInbox'],
  ] as const) {
    const r = region(CODE, anchorFrom, anchorTo, site);
    check(`${site} persists without cancelling a pending debounced write`,
      r.includes('runFederationPersist(') && !r.includes('persistFederationEntry('),
      'this hook now cancels a debounced write on every authenticated call, which defeats '
        + 'the coalescing a concurrent import depends on');
  }
}

// ── 10. AND A CANCELLED WRITE MUST STILL SETTLE ──────────────────────────────
console.log('\n10. every cancel path settles the caller it cancelled');
{
  // ★★ THE DEFECT, DRIVEN AGAINST THE REAL RELAY BEFORE THIS BLOCK EXISTED.
  // `_federationPendingWrites` held a bare timer, and all three cancel paths did
  // `clearTimeout` and nothing else — stranding the `resolve` captured inside that timer.
  // A directory document listing the SAME pod URL TWICE therefore hung `discover_directory`
  // forever: the second entry cancelled the first, and `await Promise.allSettled(...)`
  // waited on a promise nothing could settle. The request was still open at 25s; the
  // control with three distinct URLs answered 200 in 318ms. §11 drives that end to end.
  //
  // THIS block executes the three functions directly, because the wire reaches only the
  // cancel path inside `persistFederationEntryDebounced`; the other two need a write to
  // arrive inside the 250ms window, which over HTTP is a race and here is an ordering.
  // The trio is sliced out of server.ts the way §1-§4 slice the identity helpers, so these
  // are the shipped characters. Only its store calls are stubbed — what is under test is
  // which promises settle and in what order, and a real PUT would add only a network.
  const PERSIST_FROM = 'const FEDERATION_PERSIST_DEBOUNCE_MS';
  const PERSIST_TO = '// Hydrate from the federation store';
  const pFrom = SERVER.indexOf(PERSIST_FROM);
  const pTo = SERVER.indexOf(PERSIST_TO, pFrom + 1);
  check('the persist trio can still be located in server.ts', pFrom >= 0 && pTo > pFrom,
    'renamed or moved — this section is testing nothing until it is re-anchored');
  if (pFrom >= 0 && pTo > pFrom) {
    type Row = { url: string; via: string; addedAt: string };
    type Trio = {
      persistFederationEntry: (e: Row) => Promise<void>;
      persistFederationEntryDebounced: (e: Row) => Promise<void>;
      unpersistFederationEntry: (u: string) => Promise<void>;
      writes: string[];
      pendingCount: () => number;
    };
    const persistDir = mkdtempSync(join(tmpdir(), 'addr-persist-'));
    const persistModule = join(persistDir, 'addr-extracted-persist.ts');
    const trio = await (async (): Promise<Trio> => {
      try {
        writeFileSync(
          persistModule,
          // Everything the slice reads from the rest of server.ts, stubbed to the smallest
          // thing that still exercises the real control flow: an async store call that
          // RECORDS, so "did the caller settle before or after the write landed" becomes a
          // question this file can ask.
          'type KnownPodEntry = Record<string, unknown> & { url: string; via: string; addedAt: string };\n'
            + 'type FederationEntry = Record<string, unknown> & { url: string };\n'
            + 'const knownPods = new Map<string, KnownPodEntry>();\n'
            + 'let federationLastPersistedAt: string | null = null;\n'
            + 'const federationStoreCfg = {} as never;\n'
            + 'const writes: string[] = [];\n'
            // NOT unref'd, deliberately: an unref'd timer does not hold the event loop, so a
            // stubbed store that used one let the process exit while the write it is
            // standing in for was still in flight — "unsettled top-level await", which reads
            // as the hang under test and is not it.
            + 'const storeTick = (): Promise<void> => new Promise<void>(r => { setTimeout(r, 5); });\n'
            + 'async function saveFederationEntry(e: FederationEntry, _c: never): Promise<void> {\n'
            + '  await storeTick(); writes.push(`PUT ${e.url}`);\n'
            + '}\n'
            + 'async function removeFederationEntry(u: string, _c: never): Promise<void> {\n'
            + '  await storeTick(); writes.push(`DELETE ${u}`);\n'
            + '}\n'
            + 'function log(_m: string): void { void federationLastPersistedAt; }\n'
            + `${SERVER.slice(pFrom, pTo)}\n`
            + 'const pendingCount = (): number => _federationPendingWrites.size;\n'
            + 'export { persistFederationEntry, persistFederationEntryDebounced, '
            + 'unpersistFederationEntry, writes, pendingCount };\n',
          'utf8',
        );
        return await import(pathToFileURL(persistModule).href) as Trio;
      } finally {
        // A probe file that outlives its run is litter in someone else's typecheck.
        rmSync(persistDir, { recursive: true, force: true });
      }
    })();
    const { persistFederationEntry, persistFederationEntryDebounced, unpersistFederationEntry,
      writes, pendingCount } = trio;
    const row = (url: string): Row => ({ url, via: 'directory', addedAt: '2026-01-01T00:00:00.000Z' });
    // ★ A HANG IS NOT AN ASSERTION FAILURE UNLESS SOMETHING WATCHES THE CLOCK. Without this
    // race the shipped defect does not fail this suite — it makes it never finish, and a
    // suite that never finishes reads as a CI timeout rather than as a directory bug. The
    // budget is generous against a 250ms debounce because all it must separate is "slow"
    // from "never"; a passing run never waits for it.
    const HANG_BUDGET_MS = 5_000;
    const settlesWithin = async (p: Promise<unknown>): Promise<boolean> => {
      let timer: NodeJS.Timeout | undefined;
      // ★ AND THIS TIMER IS NOT UNREF'D, which is the difference between a report and a
      // shrug. Measured with the mutant that makes a cancel forget its settler: with
      // `.unref()` the only remaining work is a promise that never settles and a timer that
      // does not hold the loop, so node exits mid-race with "unsettled top-level await" and
      // no failing check — the run goes red for a reason nobody can read. Holding the loop
      // for the budget is what turns the hang back into a named assertion. A passing run
      // clears it on the same tick and never waits.
      const hung = new Promise<'HUNG'>(r => { timer = setTimeout(() => r('HUNG'), HANG_BUDGET_MS); });
      const outcome = await Promise.race([p.then(() => 'settled' as const), hung]);
      if (timer) clearTimeout(timer);
      return outcome === 'settled';
    };
    const DUP = 'https://pod.example/u-eth-aaaa11112222/';

    // (a) THE DRIVEN SYMPTOM, IN ONE BATCH: two entries, one URL — the shape a foreign
    // directory document produces and the shape that hung the live relay.
    {
      // ★ THE CANCELLED CALLER IS WATCHED SEPARATELY, because `allSettled` waits for the
      // LAST promise and would hide an early settle on the first. `writes.length` at the
      // moment the cancelled one resolves is the durability claim itself: settling at
      // cancel time records 0, settling behind the superseding write records 1.
      let writesWhenCancelledSettled = -1;
      const cancelled = persistFederationEntryDebounced(row(DUP))
        .then(() => { writesWhenCancelledSettled = writes.length; });
      const superseding = persistFederationEntryDebounced(row(DUP));
      const settled = await settlesWithin(Promise.allSettled([cancelled, superseding]));
      check('two debounced writes for the SAME url both settle', settled,
        'the cancelled one never resolves — this is the discover_directory hang, in process');
      check('…coalesced into ONE put, which is what the debounce is for',
        writes.length === 1 && writes[0] === `PUT ${DUP}`, JSON.stringify(writes));
      check('…and the CANCELLED caller settled only after that put landed, so the promise it '
        + 'was handed still means what its doc comment says',
        writesWhenCancelledSettled === 1,
        `${writesWhenCancelledSettled} write(s) had landed when it resolved (0 = settled at `
        + 'cancel time, before anything was written)');
      check('…and no timer is left behind in the pending map', pendingCount() === 0,
        `${pendingCount()} still pending`);
      writes.splice(0);
    }

    // (b) THE IMMEDIATE ENTRY POINT'S CANCEL PATH — an `add_pod` landing inside an import's
    // 250ms window, which is the race unit A steered its two registration hooks around.
    {
      const pending = persistFederationEntryDebounced(row(DUP));
      const immediate = persistFederationEntry(row(DUP));
      const settled = await settlesWithin(Promise.allSettled([pending, immediate]));
      check('an immediate write supersedes a pending debounced one and settles it too',
        settled, 'persistFederationEntry cancelled a write and abandoned its caller');
      check('…with exactly one put, the superseding one', writes.length === 1,
        JSON.stringify(writes));
      writes.splice(0);
    }

    // (c) AND THE REMOVAL PATH, which cancels an add it is about to make pointless. The
    // cancelled caller still settles — its entry ends up removed rather than written, and a
    // promise that never settles is the one outcome that is never right.
    {
      const pending = persistFederationEntryDebounced(row(DUP));
      const removal = unpersistFederationEntry(DUP);
      const settled = await settlesWithin(Promise.allSettled([pending, removal]));
      check('a removal supersedes a pending add and settles its caller', settled,
        'unpersistFederationEntry cancelled a write and abandoned its caller');
      check('…and the store saw the DELETE and no put',
        writes.length === 1 && writes[0] === `DELETE ${DUP}`, JSON.stringify(writes));
      writes.splice(0);
    }

    // (d) N-DEEP AT A SHALLOW DEPTH: five entries for one URL is one put and FIVE settled
    // callers, not four — the off-by-one case. ★ THIS DEPTH IS NOT ENOUGH ON ITS OWN and (d2)
    // exists because of it: the first fix for the hang settled callers by RECURSION, and five
    // frames of recursion is indistinguishable from five iterations.
    {
      const many = Promise.allSettled(
        [0, 1, 2, 3, 4].map(() => persistFederationEntryDebounced(row(DUP))));
      const settled = await settlesWithin(many);
      check('five entries for one url settle five callers behind one put',
        settled && writes.length === 1,
        `settled=${settled} writes=${JSON.stringify(writes)}`);
      writes.splice(0);
    }

    // (d2) ★★ AND AT A DEPTH A REAL DIRECTORY DOCUMENT REACHES, WHICH IS THE ONLY DEPTH THAT
    // SEPARATES THE TWO IMPLEMENTATIONS. The first fix for the hang gave each settler a closure
    // over the one it superseded, so N duplicates built an N-deep call chain and draining it
    // walked the stack. Driven against the real relay, a 318 KiB directory document produced
    // `RangeError: Maximum call stack size exceeded` and the child exited code 1 — the whole
    // process, where the ORIGINAL defect had only leaked a promise and kept serving. Five entries
    // could never have shown that. The list form drains iteratively and this is what pins it.
    {
      const DEPTH = 20_000;
      let threw = '';
      let settled = false;
      try {
        const all = Promise.allSettled(
          Array.from({ length: DEPTH }, () => persistFederationEntryDebounced(row(DUP))));
        settled = await settlesWithin(all);
      } catch (err) {
        // A RangeError from the drain surfaces here, not as a failed assertion, so name it.
        threw = (err as Error).constructor.name + ': ' + (err as Error).message.slice(0, 60);
      }
      check(`${DEPTH} entries for one url settle every caller behind one put, without walking `
        + 'the stack',
        threw === '' && settled && writes.length === 1,
        threw !== '' ? `drain threw ${threw} — the settlers are nesting again`
          : `settled=${settled} writes=${JSON.stringify(writes)}`);
      writes.splice(0);
    }

    // (e) NON-VACUITY — the control the lens ran beside the hang. Distinct URLs never cancel
    // each other, so they must produce one write EACH; without this, (a)-(d) would pass for
    // the uninteresting reason that nothing was ever pending.
    {
      const urls = ['https://pod.example/u-a/', 'https://pod.example/u-b/', 'https://pod.example/u-c/'];
      const settled = await settlesWithin(
        Promise.allSettled(urls.map(u => persistFederationEntryDebounced(row(u)))));
      check('three DISTINCT urls settle as three separate writes',
        settled && writes.length === 3,
        `settled=${settled} writes=${JSON.stringify(writes)}`);
      writes.splice(0);
    }
  }
}

// ── 11. AND THE WIRE, BECAUSE SOURCE TEXT CANNOT SAY WHETHER A REQUEST GETS THERE ────────
console.log('\n11. driven: two real identities against one shared directory');
{
  // ★★ WHAT THIS SECTION IS FOR. §5, §8's wiring half and §9 are regexes over the
  // comment-stripped file, and this package already knows a regex can be satisfied by a
  // token sitting in code no request reaches. Nothing in CI booted the relay and called a
  // federation tool on a PEER's pod — so the whole class kept coming back one tool over
  // from wherever it had last been closed. Two of those are driven here.
  //
  // ★★ AND THE HANG THAT SHIPPED BECAUSE IT WAS BELIEVED UNDRIVABLE. Unit A's report said
  // `discover_directory` could not be reached from a fixture because it fetches through the
  // SSRF-guarded `guardedInvokeFetch`. That is false: `assertInvokeTargetAllowed` returns
  // 'pinned' when `u.origin === cssOrigin`, BEFORE the loopback screen — so a directory
  // document served from the CSS-origin fixture drives it in one call, which is what the
  // directory route on this pod app is. The hang lived for a release behind a claim about
  // a test that was never attempted.
  const VICTIM_POD_ID = 'u-eth-aaaa11112222';
  const STRANGER_POD_ID = 'u-eth-ffff99990000';
  const VICTIM_AGENT = `interego-discord-${VICTIM_POD_ID}`;
  const IDENTITIES: Record<string, { userId: string; agentId: string }> = {
    'token-victim': { userId: VICTIM_POD_ID, agentId: `did:web:identity.test:agents:${VICTIM_AGENT}` },
    'token-stranger': { userId: STRANGER_POD_ID, agentId: `did:web:identity.test:agents:randobot-${STRANGER_POD_ID}` },
  };

  const identityApp = express();
  identityApp.use(express.json());
  identityApp.post('/tokens/verify', (q, s) => {
    const token = (q.body as { token?: string } | undefined)?.token ?? '';
    const who = IDENTITIES[token];
    if (!who) { s.json({ valid: false, reason: 'not part of this fixture' }); return; }
    s.json({ valid: true, userId: who.userId, agentId: who.agentId, scope: 'ReadWrite' });
  });
  identityApp.use((_q, s) => { s.status(404).json({ error: 'not part of this fixture' }); });

  // An in-memory pod: it stores what is PUT and serves it back, which is everything the
  // federation store needs. The directory document is served from THIS origin because that
  // is the origin CSS_URL names — see the note above on why that is what makes
  // discover_directory reachable at all.
  const stored = new Map<string, string>();
  let directoryDoc = '';
  const podApp = express();
  podApp.get('/fixture/directory', (_q, s) => { s.type('text/turtle').send(directoryDoc); });
  podApp.use(express.text({ type: () => true, limit: '4mb' }));
  podApp.use((q, s) => {
    const key = decodeURIComponent(q.path);
    if (q.method === 'PUT' || q.method === 'POST' || q.method === 'PATCH') {
      if (!key.endsWith('/')) stored.set(key, typeof q.body === 'string' ? q.body : '');
      s.status(201).end();
      return;
    }
    if (q.method === 'DELETE') { stored.delete(key); s.status(205).end(); return; }
    // -- CONTAINER EXISTENCE, WHICH THIS FIXTURE USED TO GET WRONG --------------------------
    //
    // `notify_agent` now HEADs the pod ROOT before it writes, because CSS auto-creates a
    // container on first PUT and `delivered: true` was therefore reachable for a pod that had
    // never existed. This fixture answered 404 for EVERY container, which is not what the store
    // does: measured unauthenticated against the live deployment on 2026-08-29,
    // `HEAD https://gate.interego.xwisee.com/eth-8f3b8e939600/` is 200 and
    // `HEAD .../definitely-not-a-pod-xyz9/` is 404. Left as it was, every legitimate delivery in
    // this suite would have read as refused for the wrong reason.
    //
    // MEMBERSHIP IS DELIBERATELY NOT MODELLED. An empty container carries the same information to
    // every reader in this suite as the old 404 did -- `readAgentInbox`, `discover` and the
    // manifest walk all end up with nothing either way -- so no assertion here changes meaning.
    // A suite that wants a pod to be ABSENT says so; see tests/the-writers-are-gated.test.ts,
    // which drives that case.
    if (key.endsWith('/') && stored.get(key) === undefined) {
      if (q.method === 'HEAD') { s.type('text/turtle').status(200).end(); return; }
      s.type('text/turtle').status(200).send('@prefix ldp: <http://www.w3.org/ns/ldp#>. <> a ldp:Container, ldp:BasicContainer, ldp:Resource.');
      return;
    }
    const hit = stored.get(key);
    if (hit === undefined) { s.status(404).end(); return; }
    if (q.method === 'HEAD') { s.type('text/turtle').status(200).end(); return; }
    s.type('text/turtle').status(200).send(hit);
  });

  const identity = await listenLoopback(identityApp);
  const pod = await listenLoopback(podApp);
  const victimPod = `${pod.base}/${VICTIM_POD_ID}/`;
  // TWO bnodes, ONE pod URL — `parsePodDirectory` resolves each bnode's podUrl on its own,
  // so this is two entries for the same URL, which is the document that hung the relay.
  const dupPod = `${pod.base}/u-eth-dddd44445555/`;
  directoryDoc = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
<urn:directory:duplicate> a iep:PodDirectory .
<urn:directory:duplicate> iep:hasPod _:pod0 .
_:pod0 iep:podUrl <${dupPod}> .
<urn:directory:duplicate> iep:hasPod _:pod1 .
_:pod1 iep:podUrl <${dupPod}> .
`;

  const probe = createServer();
  await new Promise<void>(r => { probe.listen(0, '127.0.0.1', () => r()); });
  const relayPort = (probe.address() as AddressInfo).port;
  await new Promise<void>(r => { probe.close(() => r()); });
  const base = `http://127.0.0.1:${relayPort}`;
  // Never the production default `/app/relay-agent-key.json`: a suite must not write a
  // long-lived private key into a path it does not own.
  const keyFile = join(tmpdir(), `addr-directory-key-${process.pid}.json`);

  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: join(here, '..'),
    env: {
      ...process.env,
      PORT: String(relayPort),
      CSS_URL: `${pod.base}/`,
      IDENTITY_URL: identity.base,
      RELAY_AGENT_KEY_FILE: keyFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childErr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', () => { /* drained so the child never blocks on a full pipe */ });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => { childErr = (childErr + c).slice(-1_500); });
  const killChild = (): void => { child.kill(); };
  process.once('exit', killChild);

  interface ToolReply { readonly status: number; readonly body: Record<string, unknown> }
  const callTool = async (
    tool: string, token: string, args: Record<string, unknown>, timeoutMs = 30_000,
  ): Promise<ToolReply> => {
    try {
      const res = await fetch(`${base}/tool/${tool}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { unparseable: text.slice(0, 300) }; }
      return { status: res.status, body };
    } catch (err) {
      // ★ A TIMEOUT IS A RESULT HERE, NOT AN ERROR. The defect this section drives is a
      // request that never answers, so the abort has to become an assertable value rather
      // than an exception that takes the suite down with it.
      return { status: 0, body: { aborted: (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError' } };
    }
  };
  /** Every row in the shared directory, by URL — the projection a sender actually reads. */
  const directoryRows = async (token: string): Promise<Map<string, Record<string, unknown>>> => {
    const r = await callTool('list_known_pods', token, {});
    const pods = Array.isArray(r.body['pods']) ? r.body['pods'] as Record<string, unknown>[] : [];
    return new Map(pods.map(p => [String(p['url']), p]));
  };

  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await new Promise(r => { setTimeout(r, 250).unref(); });
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
        up = r.ok || r.status === 404;
      } catch { /* still booting */ }
    }
    check('§11 the relay boots against the fixtures and answers /health', up,
      `${base} — child stderr tail: ${childErr || '(none)'}`);
    if (up) {
      // ── (a) the victim registers itself, through the real auth path ──────────────
      await callTool('read_inbox', 'token-victim', {});
      const afterRegister = (await directoryRows('token-stranger')).get(victimPod);
      check('§11 an authenticated agent registers an IDENTIFIED row for its own pod',
        afterRegister?.['identifiedBy'] === 'did:web agent name'
          && afterRegister?.['agent'] === VICTIM_AGENT,
        JSON.stringify(afterRegister ?? '<NO ROW>'));

      // ── (b) ★★ THE ERASURE, ONE TOOL OVER ───────────────────────────────────────
      // Driven at HEAD: this exact call returned `{removed: true}`, the store file was
      // DELETED, `notify_agent` to the victim's own DID answered `delivered: false`, and
      // `GET /agents/<localpart>` 404'd. One authenticated stranger, anybody's identity.
      const hostile = await callTool('remove_pod', 'token-stranger', { pod_url: victimPod });
      check('§11 ★★ a stranger CANNOT remove a row whose agent registered it here',
        hostile.body['removed'] !== true, JSON.stringify(hostile.body));
      check('§11 …and the refusal says so, rather than reporting a removal it did not do',
        typeof hostile.body['error'] === 'string'
          && String(hostile.body['error']).includes('forbidden'),
        JSON.stringify(hostile.body));
      const afterHostile = (await directoryRows('token-stranger')).get(victimPod);
      check('§11 …and the row is still there, still identified — the refusal is the whole '
        + 'outcome and nothing was half-applied',
        afterHostile?.['identifiedBy'] === 'did:web agent name'
          && afterHostile?.['agent'] === VICTIM_AGENT,
        JSON.stringify(afterHostile ?? '<NO ROW>'));

      // ── (c) AND WHAT A THIRD PARTY MAY STILL DO ─────────────────────────────────
      // A row this relay never identified — a dead peer somebody added by hand, or a squat.
      // Dropping those is the real use the gate must not take away, so it is asserted here
      // rather than assumed: without this, (b) would also pass for a tool that refuses
      // everything.
      const deadPeer = `${pod.base}/u-eth-dead00000000/`;
      await callTool('add_pod', 'token-stranger', { pod_url: deadPeer, label: 'a peer that went away' });
      const deadRow = (await directoryRows('token-stranger')).get(deadPeer);
      check('§11 a hand-added peer row identifies nothing, which is the honest reading',
        deadRow !== undefined && deadRow['identifiedBy'] === 'nothing',
        JSON.stringify(deadRow ?? '<NO ROW>'));
      const dropDead = await callTool('remove_pod', 'token-stranger', { pod_url: deadPeer });
      check('§11 …and a third party may drop it', dropDead.body['removed'] === true,
        JSON.stringify(dropDead.body));

      // ── (d) AND THE POD'S OWN AGENT MAY DE-REGISTER ─────────────────────────────
      const selfRemove = await callTool('remove_pod', 'token-victim', { pod_url: victimPod });
      check('§11 the pod\'s own agent removes its own row', selfRemove.body['removed'] === true,
        JSON.stringify(selfRemove.body));
      check('§11 …and it is gone from the directory every caller reads',
        (await directoryRows('token-stranger')).get(victimPod) === undefined,
        JSON.stringify([...(await directoryRows('token-stranger')).keys()]));

      // ── (e) ★★ THE HANG, END TO END ─────────────────────────────────────────────
      // One call, one foreign document, no race and no second caller. At HEAD this request
      // was still open at 25s; the control below answered in under a second.
      const dup = await callTool('discover_directory', 'token-stranger',
        { directory_url: `${pod.base}/fixture/directory` }, 20_000);
      check('§11 ★★ a directory listing the SAME pod url twice RETURNS', dup.status === 200,
        dup.body['aborted'] === true
          ? 'the request never answered — the cancelled debounced write never settles and '
            + 'handleDiscoverDirectory awaits it'
          : JSON.stringify(dup.body).slice(0, 240));
      check('§11 …having imported both entries and stored the one pod once',
        dup.body['imported'] === 2 && (await directoryRows('token-stranger')).has(dupPod),
        JSON.stringify(dup.body).slice(0, 240));
      // Non-vacuity: the control the lens ran beside it. If distinct URLs also failed, the
      // check above would be about `discover_directory` being broken rather than about
      // duplicate entries.
      directoryDoc = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
<urn:directory:distinct> a iep:PodDirectory .
<urn:directory:distinct> iep:hasPod _:pod0 .
_:pod0 iep:podUrl <${pod.base}/u-eth-eeee66667777/> .
<urn:directory:distinct> iep:hasPod _:pod1 .
_:pod1 iep:podUrl <${pod.base}/u-eth-eeee88889999/> .
`;
      const control = await callTool('discover_directory', 'token-stranger',
        { directory_url: `${pod.base}/fixture/directory` }, 20_000);
      check('§11 non-vacuity: the same route with DISTINCT urls answers too, so the check '
        + 'above is about the duplicate and not about the route',
        control.status === 200 && control.body['imported'] === 2,
        JSON.stringify(control.body).slice(0, 240));
    }
  } finally {
    child.kill();
    process.removeListener('exit', killChild);
    await identity.close();
    await pod.close();
    // The child mints an X25519 keypair when the file is absent and persists it; the ECDSA
    // compliance wallet lands next to it with `-ecdsa` spliced in. Both, or neither.
    for (const f of [keyFile, keyFile.replace(/\.json$/, '-ecdsa.json')]) {
      try { rmSync(f, { force: true }); } catch { /* the child may never have written it */ }
    }
  }
}

// ── §12  AN ADDRESS IS OWNED BY A POD, NOT BY ANY ROW THAT ENDS WITH IT ───────────────
//
// ★★ THE INCIDENT. `cardForLocalPart` matched on `podLocalPart(e.url) === localPart` — the LAST
// PATH SEGMENT of whatever url a row happens to carry. `add_pod` and `discover_directory` accept
// an ARBITRARY url from any authenticated caller (`resolvePodSubject` validates neither origin
// nor path shape, and no container has to exist), so `add_pod { pod_url:
// "https://anything/x/u-eth-VICTIM/" }` created a durable row that answered to the victim's
// address. GET /.well-known/webfinger and GET /agents/:localPart are PUBLIC and unauthenticated,
// so the relay served a stranger's row as that identity from its own domain.
//
// ★ WHY IT IS WORTH A SECTION RATHER THAN A LINE. channel.html's `resolveInvitee` resolves that
// handle, treats the profile-page href as the member's pod, and reads that pod's registry owner
// as the WebID it seals a private workspace record to — including on the E2EE re-seal path. The
// same derivation is reimplemented in the desktop renderer, desktop/index.html and the Discord
// workspace module, so the relay's answer is load-bearing in four places it does not control.
//
// ★ WHAT USED TO LIMIT IT, AND WHY THAT IS NOT A GATE. `mergeDirectoryRow` gives a third-party
// writer fill-only semantics, so a squatted row carries no did and no handle, and the caller
// prefers a did-bearing match — the squat only won while the victim had no did-bearing row: before
// their first authentication here, and inside the 50 ms cold-start hydrate budget.
console.log('');
console.log('§12  address ownership');
{
  const POD = 'http://css.railway.internal:3456/u-eth-8f3b8e939600/';
  check('the pod at /<localPart>/ owns that address — the case every live pod is',
    podOwnsLocalPart(POD, 'u-eth-8f3b8e939600') === true);

  // ★ THE SQUAT. Any authenticated caller can create this row; nothing else refuses it.
  check('a row NESTED under another path does not own the address it ends with',
    podOwnsLocalPart('https://anything.example/x/u-eth-8f3b8e939600/', 'u-eth-8f3b8e939600') === false,
    'a stranger row would answer the WebFinger and ActivityPub actor of another agent');
  check('depth does not help — one extra segment is enough to refuse',
    podOwnsLocalPart('http://css.railway.internal:3456/team/u-eth-8f3b8e939600/', 'u-eth-8f3b8e939600') === false);

  // ★★ AND IT DOES NOT LOWER-CASE, WHICH IS THE HALF THAT IS EASY TO GET WRONG. The obvious
  // spelling of this fix compares `canonicalPodKey(e.url)` — which lower-cased its pathname when
  // this was written, and no longer does, for this same reason — to
  // `/${localPart.toLowerCase()}/`. That closes the nesting squat and OPENS a case squat: a row at
  // /U-ETH-VICTIM/ would answer for `u-eth-victim`, which the ORIGINAL code correctly refused.
  // Every userId is lower-case by construction (derive-userid.ts builds u-eth- from `addressLower`
  // and u-pk-/u-did- from sha256 hex), so nothing legitimate needs the widening.
  check('a case-variant row does not own the address — closing a squat must not open one',
    podOwnsLocalPart('http://css.railway.internal:3456/U-ETH-8F3B8E939600/', 'u-eth-8f3b8e939600') === false);
  check('and the exact-case match is unchanged from the original last-segment test',
    podOwnsLocalPart('http://css.railway.internal:3456/U-ETH-8F3B8E939600/', 'U-ETH-8F3B8E939600') === true);

  check('an origin with no path owns nothing', podOwnsLocalPart('https://example.test/', 'u-eth-x') === false);
  check('a url that will not parse owns nothing', podOwnsLocalPart('not a url', 'u-eth-x') === false);

  // ★ NON-VACUITY. If the slice stopped resolving, every case above would answer `false` and four
  // of the six would still pass. This is the one that reds when the harness is testing nothing.
  check('★ the sliced helper is the real one and it can say yes',
    typeof podOwnsLocalPart === 'function' && podOwnsLocalPart(POD, 'u-eth-8f3b8e939600'),
    'the slice anchors moved — re-anchor §12 rather than deleting it');
}


console.log(failures === 0
  ? '\nAll checks passed.\n'
  : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
