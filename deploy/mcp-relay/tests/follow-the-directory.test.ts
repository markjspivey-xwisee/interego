#!/usr/bin/env tsx
/**
 * A recipient address is a LINK YOU FOLLOW off a directory row, and following it can only ever
 * reach the row you followed it from.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
 *
 * `list_known_pods` hands back rows and `notify_agent` takes a free-text `to`, so addressing an
 * agent has been a COMPOSE operation: read a row, decide which of `url` / `did` / `handle` /
 * `owner` is the address, retype it into another call. Measured 2026-08-24: an external agent
 * addressed findings to this maintainer, they were resolved to the DISCORD BOT's pod, and the
 * receipt said `delivered: true` three times. Rows now carry an `affordances` entry whose
 * `arguments` are the request body already addressed to that row's agent.
 *
 * ── AND THE FIRST ATTEMPT AT THIS REGRESSED, WHICH IS WHY §2 EXISTS ──────────
 *
 * `wip/dogfood-messaging-refuted` (0d6d90bc) bound `<base>/agents/` + `podLocalPart(url)` — the
 * LAST PATH SEGMENT — while `canonicalPodKey` was then the whole pathname, so two distinct pods shared
 * one address; its three gates ran when a row was LISTED and delivery re-resolved through
 * another path. Driven then: the victim's own published address delivered to an attacker with
 * `resolvedVia: followed-affordance`, `recipientKnown: true` and no warning, where before the
 * change the same input delivered correctly WITH a warning.
 *
 * Two things changed under it. cf4f03ad added `podOwnsLocalPart` (one path segment, exact case),
 * and this round added the conjunct that was still missing — the row must be on one of THIS
 * deployment's store origins — plus the rule that the mint asks the RESOLVER what an address
 * resolves to rather than re-stating its rules. §2 drives the two-rows-one-local-part case that
 * refuted the first attempt, on both halves: which row the address DEREFERENCES to and which pod
 * a notification actually REACHES.
 *
 * ── WITH WHICH INSTRUMENT, AND WHY ───────────────────────────────────────────
 *
 * §1–§3 execute the SHIPPED characters. `server.ts` calls `app.listen()` at module scope and
 * cannot be imported, so the declarations are sliced out by source anchors, written to one temp
 * module and imported — the instrument addr-directory-identity.test.ts and
 * notify-target-collapse.test.ts already use, for the same reason. A reimplementation of the
 * ownership rule could not catch this, because the rule IS the defect.
 *
 * §4 BOOTS THE REAL RELAY and drives `list_known_pods` → follow the link → `notify_agent`
 * against a fixture pod that records every PUT. Source text cannot say where the bytes went, and
 * the first attempt passed every source-level check it had.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/follow-the-directory.test.ts
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

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(here, '..', 'server.ts');
const SERVER = readFileSync(SERVER_PATH, 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Load the SHIPPED declarations ────────────────────────────────────────────
//
// Three slices. The address helpers are contiguous (`relayAgentAddress` through
// `directoryRowAffordances`); `podOwnsLocalPart` sits immediately above them with
// `podLocalPart` between, and the two small helpers they compose — `canonicalPodKey` and
// `ensureTrailingSlashLocal` — live ~140 lines further up beside the directory de-dup. The
// key slice ends at `evictCanonicalDuplicates`'s own declaration rather than at the prose
// above it: an anchor inside a comment is an anchor that a comment edit can silently move.
const OWNS_FROM = 'function podOwnsLocalPart(';
const ADDR_FROM = '/**\n * The relay-hosted address of the agent at a pod';
const ADDR_TO = '// Process-local guard so we persist each agent card';
const KEY_FROM = 'function canonicalPodKey(';
const KEY_TO = 'function evictCanonicalDuplicates(';
const ownsFrom = SERVER.indexOf(OWNS_FROM);
const addrFrom = SERVER.indexOf(ADDR_FROM);
const addrTo = SERVER.indexOf(ADDR_TO, addrFrom + 1);
const keyFrom = SERVER.indexOf(KEY_FROM);
const keyTo = SERVER.indexOf(KEY_TO, keyFrom + 1);
if (ownsFrom < 0 || addrFrom < 0 || addrTo < 0 || keyFrom < 0 || keyTo < 0) {
  console.error(`\nFAIL — cannot locate the agent-address helpers in server.ts `
    + `(owns=${ownsFrom}, addr=${addrFrom}/${addrTo}, key=${keyFrom}/${keyTo}).`);
  console.error('  If they were renamed or moved, this suite is testing nothing. Re-anchor it.');
  process.exit(1);
}

/** The fixture store, in both of its legitimate spellings, and the relay's own origin. */
const CSS = 'http://css.fixture.internal:3456/';
const PUB = 'https://gate.fixture.example/';
const RELAY = 'https://relay.fixture.example';
const VICTIM = 'u-eth-aaaa11112222';

interface Row {
  url: string; via?: string; did?: string; webId?: string;
  owner?: string; surface?: string; handle?: string;
}
let relayAgentAddress: (podUrl: string) => string;
let relayAgentAddressLocalPart: (to: string) => string | undefined;
type OwnerIndex = ReadonlyMap<string, ReadonlyArray<Row>>;
let agentAddressOwners: (localPart: string, index?: OwnerIndex) => Row[];
let followedAgentAddressRow: (to: string) => Row | undefined;
let directoryRowAffordances: (entry: Row, index?: OwnerIndex) => ReadonlyArray<Record<string, unknown>>;
// ★★ THE INDEX IS A SECOND READER OF THE OWNERSHIP PREDICATE, SO IT IS DRIVEN AS ONE.
// `list_known_pods` mints every row's link through it and never through the scan, so a §3 that
// only exercised the scan would be testing the path the directory does not take — and it was:
// mutating the index to key rows by `podLocalPart` alone, dropping the origin and whole-path
// conjuncts, left this suite entirely green. §3b closes that.
let buildAgentAddressOwnerIndex: () => OwnerIndex;
let knownPods: Map<string, Row>;

const tmpDir = mkdtempSync(join(tmpdir(), 'follow-directory-'));
const tmpModule = join(tmpDir, 'follow-directory-extracted.ts');
try {
  writeFileSync(
    tmpModule,
    // The slices reference declarations that live elsewhere in server.ts (`KnownPodEntry`,
    // `DirectoryIdentity`, `TOOL_SURFACE`). tsx transpiles rather than typechecks, so type
    // positions are erased; the value-level ones are supplied here as the smallest stand-ins
    // that let the BODIES under test run as the shipped characters.
    //
    // ★ `describeDirectoryEntry` / `identityIsObserved` ARE NOT STUBBED AWAY — they are the
    // gate. They are reproduced here at the two properties this section depends on (a did:web
    // agent name, or a registered surface, counts; an `owner` claim does not), and §4 then
    // drives the real ones through the booted relay so a divergence between this reduction and
    // the shipped predicate cannot hide.
    `type KnownPodEntry = { url: string; via?: string; did?: string; webId?: string; owner?: string; surface?: string; handle?: string };\n`
    + `const RELAY_AP_BASE = ${JSON.stringify(RELAY)};\n`
    + `const STORE_ORIGINS: ReadonlySet<string> = new Set(`
    + `${JSON.stringify([new URL(CSS).origin, new URL(PUB).origin])});\n`
    + `const knownPods = new Map<string, KnownPodEntry>();\n`
    + `const TOOL_SURFACE = { tools: [{ name: 'notify_agent', inputSchema: {}, outputSchema: {} }] };\n`
    + `const apActorUrl = (base: string, lp: string) => \`\${base.replace(/\\/$/, '')}/agents/\${encodeURIComponent(lp)}\`;\n`
    + `const operationActionUrl = (base: string, name: string) => \`\${base}/ns/iep/action/relay/\${name}\`;\n`
    + `const operationContract = (base: string, name: string, sc: any) => ({\n`
    + `  ...(sc?.inputSchema !== undefined ? { expects: \`\${base}/.well-known/operations/\${name}/input\` } : {}),\n`
    + `  ...(sc?.outputSchema !== undefined ? { returns: \`\${base}/.well-known/operations/\${name}/output\` } : {}),\n`
    + `});\n`
    + `function describeDirectoryEntry(e: any) {\n`
    + `  const d: string | undefined = e.did ?? e.webId;\n`
    + `  if (d && d.startsWith('did:web:')) return { agent: d.split(':').pop(), surface: 'fixture', identifiedBy: 'did:web agent name' };\n`
    + `  if (e.surface) return { surface: e.surface, identifiedBy: 'registered surface' };\n`
    + `  if (e.owner) return { identifiedBy: 'unverified owner claim' };\n`
    + `  return { identifiedBy: 'nothing' };\n`
    + `}\n`
    + `function identityIsObserved(i: any) { return i.identifiedBy === 'did:web agent name' || i.identifiedBy === 'registered surface'; }\n`
    + `function isStoreOriginUrl(url: string): boolean {\n`
    + `  try { return STORE_ORIGINS.has(new URL(url).origin); } catch { return false; }\n`
    + `}\n`
    + `${SERVER.slice(keyFrom, keyTo)}\n`
    + `${SERVER.slice(ownsFrom, addrTo)}\n`
    + `export { relayAgentAddress, relayAgentAddressLocalPart, agentAddressOwners,\n`
    + `  followedAgentAddressRow, directoryRowAffordances, buildAgentAddressOwnerIndex,\n`
    + `  knownPods };\n`,
    'utf8',
  );
  const mod = await import(pathToFileURL(tmpModule).href) as {
    relayAgentAddress: typeof relayAgentAddress;
    relayAgentAddressLocalPart: typeof relayAgentAddressLocalPart;
    agentAddressOwners: typeof agentAddressOwners;
    followedAgentAddressRow: typeof followedAgentAddressRow;
    directoryRowAffordances: typeof directoryRowAffordances;
    buildAgentAddressOwnerIndex: typeof buildAgentAddressOwnerIndex;
    knownPods: typeof knownPods;
  };
  relayAgentAddress = mod.relayAgentAddress;
  relayAgentAddressLocalPart = mod.relayAgentAddressLocalPart;
  agentAddressOwners = mod.agentAddressOwners;
  followedAgentAddressRow = mod.followedAgentAddressRow;
  directoryRowAffordances = mod.directoryRowAffordances;
  buildAgentAddressOwnerIndex = mod.buildAgentAddressOwnerIndex;
  knownPods = mod.knownPods;
} finally {
  // A probe file that outlives its run is litter in someone else's typecheck.
  rmSync(tmpDir, { recursive: true, force: true });
}

const put = (r: Row): void => { knownPods.set(r.url, r); };
const victimRow: Row = {
  url: `${CSS}${VICTIM}/`,
  via: 'auto',
  did: `did:web:identity.test:agents:victim-${VICTIM}`,
  webId: `did:web:identity.test:agents:victim-${VICTIM}`,
  handle: `acct:${VICTIM}@relay.fixture.example`,
};

console.log('\nFOLLOW-THE-DIRECTORY — an address you follow, not one you compose');

// ── §1 THE ADDRESS ROUND-TRIPS, AND ONLY OURS DOES ───────────────────────────
console.log('\n1. the address and its inverse are one construction');
{
  const addr = relayAgentAddress(`${CSS}${VICTIM}/`);
  check('the minted address is this relay\'s actor URL for the pod',
    addr === `${RELAY}/agents/${VICTIM}`, addr);
  check('and it inverts back to the same local part',
    relayAgentAddressLocalPart(addr) === VICTIM, String(relayAgentAddressLocalPart(addr)));
  check('a trailing slash is the same address',
    relayAgentAddressLocalPart(`${addr}/`) === VICTIM);

  // ★ ANOTHER RELAY'S ADDRESS IS NOT OURS TO INTERPRET — identical in shape, different host.
  check('an address on somebody else\'s relay is not one of ours',
    relayAgentAddressLocalPart(`https://other-relay.example/agents/${VICTIM}`) === undefined);
  check('and neither is our host with a different path',
    relayAgentAddressLocalPart(`${RELAY}/tool/notify_agent`) === undefined);
  check('a deeper path under /agents/ is not an agent address',
    relayAgentAddressLocalPart(`${RELAY}/agents/${VICTIM}/inbox`) === undefined);
  check('and neither is the container itself',
    relayAgentAddressLocalPart(`${RELAY}/agents/`) === undefined);
  // A malformed escape yields undefined rather than the raw tail — one localPart, one spelling.
  check('a malformed percent-escape is not an address',
    relayAgentAddressLocalPart(`${RELAY}/agents/%zz`) === undefined);
  // ★ AND THE ENCODING ROUND-TRIPS rather than being decoded one way only.
  check('a local part needing encoding survives the round trip',
    relayAgentAddressLocalPart(relayAgentAddress(`${CSS}a%2Fb/`)) === 'a%2Fb',
    relayAgentAddress(`${CSS}a%2Fb/`));
}

// ── §2 ★★ TWO ROWS, ONE LOCAL PART — THE CASE THAT REFUTED THE FIRST ATTEMPT ─
console.log('\n2. ★★ two rows sharing one local part');
{
  knownPods.clear();
  put(victimRow);
  // The squat any authenticated caller can plant: `add_pod` validates neither origin nor path
  // shape, so this row exists and has exactly ONE path segment — `podOwnsLocalPart` alone
  // cannot tell it from the victim's.
  const squat: Row = {
    url: `https://elsewhere.example/${VICTIM}/`,
    via: 'manual',
    owner: 'did:web:identity.test:agents:attacker-u-eth-bbbb33334444',
  };
  put(squat);
  // …and the nested form cf4f03ad closed, kept here so this suite fails if that regresses.
  put({ url: `${CSS}team/${VICTIM}/`, via: 'manual' });

  const owners = agentAddressOwners(VICTIM);
  check('the foreign-origin row does NOT own the victim\'s address',
    !owners.some(o => o.url === squat.url), JSON.stringify(owners.map(o => o.url)));
  check('nor does the nested row',
    !owners.some(o => o.url === `${CSS}team/${VICTIM}/`));
  check('the victim\'s own row does',
    owners.some(o => o.url === victimRow.url), JSON.stringify(owners.map(o => o.url)));

  // ★★ THE INJECTIVITY, ASSERTED AS THE PROPERTY IT IS. The claim is not "the right row wins a
  // preference order" — that is what "usually loses" looked like — but that every row the
  // address can select is the SAME POD by the relay's own canonical key. The public spelling of
  // the same pod is added here precisely so this is not vacuous on a one-element set.
  put({ ...victimRow, url: `${PUB}${VICTIM}/` });
  const keys = new Set(agentAddressOwners(VICTIM).map(o => canonicalKey(o.url)));
  check('every row the address can select is ONE pod by canonical key',
    keys.size === 1, `${agentAddressOwners(VICTIM).length} rows -> ${JSON.stringify([...keys])}`);
  check('…and both host spellings of that pod are in the set — so the check is not vacuous',
    agentAddressOwners(VICTIM).length === 2);

  // And the resolve gate on top: only a row this relay identified itself.
  const resolved = followedAgentAddressRow(`${RELAY}/agents/${VICTIM}`);
  check('the followed address resolves to the victim, never the squat',
    resolved !== undefined && canonicalKey(resolved.url) === canonicalKey(victimRow.url),
    JSON.stringify(resolved));

  // ★ THE CASE SQUAT. Closing the nesting squat by lower-casing would open this one.
  knownPods.clear();
  put({ ...victimRow, url: `${CSS}${VICTIM.toUpperCase()}/` });
  check('a case-variant row does not own the lower-case address',
    agentAddressOwners(VICTIM).length === 0,
    JSON.stringify(agentAddressOwners(VICTIM).map(o => o.url)));

  // ★ AND THE SYNTHETIC SELF ROW IS NOT A DIRECTORY ROW.
  knownPods.clear();
  put({ ...victimRow, via: 'self' });
  check('the per-call `self` projection owns no address',
    agentAddressOwners(VICTIM).length === 0);
}

/** `canonicalPodKey`'s question, restated for the assertions above. Deliberately a SECOND
 *  reading: if the sliced one ever stops agreeing with the rule written out here, the checks
 *  above are what notices.
 *
 *  ★ THE RULE IS "THIS STORE IS ONE BUCKET, EVERY OTHER ORIGIN IS ITS OWN": the path for a url
 *  on `CSS`/`PUB`, origin-qualified otherwise, and an opaque origin kept whole so a pathological
 *  store url cannot put `null` in the store set and swallow every non-special scheme. It used to
 *  be the pathname for everything, which is what let a foreign row be "the same pod" as a local
 *  one; tests/same-pod-means-same-pod.test.ts drives that.
 *
 *  ★★ AND IT DOES NOT FOLD CASE, WHICH THIS FUNCTION USED TO GET WRONG. It carried
 *  `pathname.toLowerCase()` after the shipped key had already dropped the fold — so as a second
 *  reading it would have AGREED WITH a case-folding regression rather than caught it, which is
 *  the one thing a second reading exists not to do. Solid container paths are case-sensitive:
 *  `<store>/U-ETH-V/` is a different pod from `<store>/u-eth-v/`, and `podOwnsLocalPart` refuses
 *  to fold for the same reason. Scheme and host still compare case-insensitively without help,
 *  because `new URL` normalises those. */
function canonicalKey(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return `raw|${url}`; }
  if (u.origin === 'null' || u.origin === '') return `raw|${url}`;
  const p = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
  const store = [new URL(CSS).origin, new URL(PUB).origin];
  return store.includes(u.origin) ? `store|${p}` : `origin|${u.origin}|${p}`;
}

// ── §3 WHAT IS MINTED, AND FOR WHOM ──────────────────────────────────────────
console.log('\n3. the affordance is minted only where following it cannot go wrong');
{
  knownPods.clear();
  put(victimRow);
  const [aff] = directoryRowAffordances(victimRow);
  check('an identified pod on this store carries one affordance', aff !== undefined);
  if (aff) {
    check('it is an iep:Affordance and a hydra:Operation',
      JSON.stringify(aff['@type']) === JSON.stringify(['iep:Affordance', 'hydra:Operation']),
      JSON.stringify(aff['@type']));
    check('its target is the invokable per-tool endpoint',
      aff['target'] === `${RELAY}/tool/notify_agent` && aff['method'] === 'POST',
      `${String(aff['target'])} ${String(aff['method'])}`);
    check('its action id is a URL under this relay\'s authority, never a urn',
      typeof aff['action'] === 'string' && (aff['action'] as string).startsWith(`${RELAY}/ns/iep/action/`),
      String(aff['action']));
    // ★★ THE BOUND ADDRESS, AS AN IRI AND NOT A LITERAL. `iep:agentIdentity` is an
    // owl:ObjectProperty; the first attempt emitted a plain string, which expands to a literal.
    const ident = aff['iep:agentIdentity'] as { '@id'?: string } | undefined;
    check('the bound identity is a JSON-LD node object, so it cannot expand to a literal',
      !!ident && typeof ident === 'object' && ident['@id'] === `${RELAY}/agents/${VICTIM}`,
      JSON.stringify(ident));
    // ★ AND THE PRE-FILLED BODY IS THE SAME ADDRESS — one string, not two spellings.
    const args = aff['arguments'] as { to?: string } | undefined;
    check('`arguments.to` is that same address, pre-filled',
      !!args && args.to === ident?.['@id'], JSON.stringify(args));
    check('no hydra:mapping — its domain is hydra:IriTemplate and this is a fixed-target Operation',
      !('hydra:mapping' in aff), JSON.stringify(Object.keys(aff)));
    check('the contract URLs are published, not fabricated',
      typeof aff['expects'] === 'string' && typeof aff['returns'] === 'string');
  }

  // ★★ THE MINT GATE IS THE RESOLVER'S ANSWER. A row whose LAST segment is somebody else's whole
  // pod must get no link — this is the exact address the first attempt published.
  const nested: Row = { ...victimRow, url: `${CSS}team/${VICTIM}/` };
  put(nested);
  check('a row nested under another path gets NO affordance',
    directoryRowAffordances(nested).length === 0,
    JSON.stringify(directoryRowAffordances(nested)));
  check('…and the victim\'s own row still has one, so the refusal is not blanket',
    directoryRowAffordances(victimRow).length === 1);

  const foreign: Row = { ...victimRow, url: `https://elsewhere.example/${VICTIM}/` };
  put(foreign);
  check('a row on a foreign origin gets NO affordance',
    directoryRowAffordances(foreign).length === 0);

  knownPods.clear();
  const unnamed: Row = { url: `${CSS}u-eth-dddd77778888/`, via: 'manual', owner: 'did:web:x:agents:someone' };
  put(unnamed);
  check('a row named only by the caller-writable `owner` gets NO affordance',
    directoryRowAffordances(unnamed).length === 0,
    'an `owner` claim is not evidence this relay recorded');
  check('and it resolves through no followed route either',
    followedAgentAddressRow(`${RELAY}/agents/u-eth-dddd77778888`) === undefined);

  // A pod named by a registered surface but no did:web is still identified.
  knownPods.clear();
  const bySurface: Row = { url: `${CSS}u-eth-eeee99990000/`, via: 'auto', surface: 'foxxi' };
  put(bySurface);
  check('a row identified by its registered surface DOES carry one',
    directoryRowAffordances(bySurface).length === 1);
}

// ── §3b. THE INDEXED PATH IS THE PATH THE DIRECTORY TAKES ────────────────────
//
// `list_known_pods` asks "which rows own this row's agent address" once PER ROW, and asking
// `knownPods` directly made one listing quadratic — 660,100 `new URL` constructions and 853 ms
// at the live directory size of 574 rows. It now passes a `buildAgentAddressOwnerIndex()`
// snapshot down, so EVERY link the live directory publishes is minted through the index and
// none through the scan §3 exercises.
//
// ★★ AN INDEX IS A SECOND READER OF A SECURITY PREDICATE, AND A GATE IN FRONT OF ONE OF TWO
// READERS IS NOT A GATE. Measured: mutating `buildAgentAddressOwnerIndex` to key rows by
// `podLocalPart` alone — dropping the store-origin and whole-path conjuncts that stop a planted
// foreign row and a nested squat from owning the victim's address — left §1–§4 of this suite
// entirely green, because nothing here had ever called the indexed path. So this section drives
// the SAME rows §3 drives, through the index, and asserts the two paths agree row by row rather
// than asserting they must.
console.log('\n3b. the same predicate, through the index the directory actually uses');
{
  knownPods.clear();
  const rows: Array<[Row, number, string]> = [
    [victimRow, 1, 'the victim\'s own identified row on this store'],
    [{ ...victimRow, url: `${CSS}team/${VICTIM}/` }, 0, 'a row nested under another path segment'],
    [{ ...victimRow, url: `https://elsewhere.example/${VICTIM}/` }, 0, 'a row on a foreign origin'],
    [{ url: `${CSS}u-eth-dddd77778888/`, via: 'manual', owner: 'did:web:x:agents:someone' }, 0,
      'a row named only by the caller-writable `owner`'],
    [{ url: `${CSS}u-eth-eeee99990000/`, via: 'auto', surface: 'foxxi' }, 1,
      'a row identified by its registered surface'],
  ];
  for (const [row] of rows) put(row);

  const index = buildAgentAddressOwnerIndex();
  for (const [row, expected, why] of rows) {
    const viaIndex = directoryRowAffordances(row, index);
    const viaScan = directoryRowAffordances(row);
    check(`${why} gets ${expected} affordance(s) through the INDEX`,
      viaIndex.length === expected, `${row.url} -> ${JSON.stringify(viaIndex).slice(0, 200)}`);
    check(`…and the index and the scan agree on ${row.url}`,
      JSON.stringify(viaIndex) === JSON.stringify(viaScan),
      `${JSON.stringify(viaIndex).slice(0, 160)} vs ${JSON.stringify(viaScan).slice(0, 160)}`);
  }

  // ★ AND THE OWNER SET ITSELF, THROUGH BOTH DOORS. `agentAddressOwners` is the security gate;
  // the index argument may change how its answer is FOUND and never what is in it.
  const scanned = agentAddressOwners(VICTIM).map(o => o.url).sort();
  const indexed = agentAddressOwners(VICTIM, index).map(o => o.url).sort();
  check('the owner set is identical with and without the index',
    JSON.stringify(scanned) === JSON.stringify(indexed),
    `${JSON.stringify(scanned)} vs ${JSON.stringify(indexed)}`);
  check('…and it is exactly the victim\'s own row — non-vacuous, and neither squat is in it',
    JSON.stringify(indexed) === JSON.stringify([victimRow.url]), JSON.stringify(indexed));
}

// ── §4 DRIVEN: the real relay, a real follow, the real inbox ─────────────────
console.log('\n4. driven: list_known_pods -> follow the link -> notify_agent');
{
  const SENDER = 'u-eth-ffff99990000';
  const IDENTITIES: Record<string, { userId: string; agentId: string }> = {
    'token-sender': { userId: SENDER, agentId: `did:web:identity.test:agents:sender-${SENDER}` },
    'token-victim': { userId: VICTIM, agentId: `did:web:identity.test:agents:victim-${VICTIM}` },
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

  // An in-memory pod that records every PUT by path. The recorded paths ARE the evidence: the
  // whole question is which container the bytes landed in.
  const stored = new Map<string, string>();
  const podApp = express();
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
  const cssUrl = `${pod.base}/`;

  const probe = createServer();
  await new Promise<void>(r => { probe.listen(0, '127.0.0.1', () => r()); });
  const relayPort = (probe.address() as AddressInfo).port;
  await new Promise<void>(r => { probe.close(() => r()); });
  const base = `http://127.0.0.1:${relayPort}`;
  // Never the production default `/app/relay-agent-key.json`: a suite must not write a
  // long-lived private key into a path it does not own.
  const keyFile = join(tmpdir(), `follow-directory-key-${process.pid}.json`);

  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: join(here, '..'),
    env: {
      ...process.env,
      PORT: String(relayPort),
      CSS_URL: cssUrl,
      CSS_PUBLIC_URL: PUB,
      IDENTITY_URL: identity.base,
      // The relay's own public base — what every minted agent address is built on. Set to the
      // loopback the suite can actually reach, so the address published on a row is the address
      // this section then follows.
      PUBLIC_BASE_URL: base,
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

  const callTool = async (
    tool: string, token: string, args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    try {
      const res = await fetch(`${base}/tool/${tool}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      try { return JSON.parse(text) as Record<string, unknown>; }
      catch { return { unparseable: text.slice(0, 300) }; }
    } catch (err) {
      return { requestFailed: (err as Error).name };
    }
  };
  const writesUnder = (prefix: string): string[] =>
    [...stored.keys()].filter(k => k.startsWith(prefix));
  const victimInbox = `/${VICTIM}/inbox/`;

  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await new Promise(r => { setTimeout(r, 250).unref(); });
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
        up = r.ok || r.status === 404;
      } catch { /* still booting */ }
    }
    check('§4 the relay boots against the fixtures and answers /health', up,
      `${base} — child stderr tail: ${childErr || '(none)'}`);

    if (up) {
      // The victim authenticates once, so it has a real directory row and a real pod.
      await callTool('read_inbox', 'token-victim', {});

      // ── (a) THE ROW PUBLISHES A LINK, AND THE SENDER FOLLOWS IT ──────────────
      const dir = await callTool('list_known_pods', 'token-sender', {});
      const rows = (dir['pods'] ?? []) as Array<Record<string, unknown>>;
      const row = rows.find(r => String(r['url']).includes(VICTIM));
      check('§4 the victim\'s row is listed', row !== undefined,
        JSON.stringify(rows.map(r => r['url'])));
      const affs = (row?.['affordances'] ?? []) as Array<Record<string, unknown>>;
      check('§4 it carries a notify affordance', affs.length === 1,
        JSON.stringify(row).slice(0, 400));
      check('§4 …and the response says once how to use it, pointing at the row\'s own data',
        typeof dir['addressing'] === 'string'
        && String(dir['addressing']).includes('`affordances`'),
        JSON.stringify(dir['addressing']).slice(0, 200));

      const aff = affs[0] ?? {};
      const args = (aff['arguments'] ?? {}) as { to?: string };
      const bound = args.to ?? '';
      check('§4 the bound address is one this relay minted', bound.startsWith(`${base}/agents/`),
        bound);

      // ★ GET IT FIRST — the check the misaddressing agent never had. The affordance's whole
      // claim is that you can see whose address it is before you send to it.
      const actorRes = await fetch(bound, { headers: { Accept: 'application/activity+json' } });
      const actor = actorRes.ok ? await actorRes.json() as Record<string, unknown> : {};
      check('§4 ★ the address dereferences, and names the victim\'s pod and DID',
        actorRes.ok
        && actor['interego:pod'] === `${cssUrl}${VICTIM}/`
        && actor['interego:did'] === IDENTITIES['token-victim']!.agentId,
        `${actorRes.status} ${JSON.stringify(actor).slice(0, 260)}`);

      // ── (b) FOLLOWING IT DELIVERS, TO THAT POD, ON THE STRONG ROUTE ──────────
      const before = writesUnder(victimInbox).length;
      const sent = await callTool('notify_agent', 'token-sender',
        { ...args, summary: 'a probe sent by following the row\'s own link' });
      check('§4 ★★ following the link delivers into the victim\'s own inbox',
        sent['delivered'] === true && writesUnder(victimInbox).length === before + 1,
        `${JSON.stringify(writesUnder(victimInbox))} — ${JSON.stringify(sent).slice(0, 320)}`);
      check('§4 …reported as followed-affordance, canonical, recipient known',
        sent['resolvedVia'] === 'followed-affordance'
        && sent['canonicalInbox'] === true
        && sent['recipientKnown'] === true,
        `${JSON.stringify(sent['resolvedVia'])} / ${JSON.stringify(sent['canonicalInbox'])} / ${JSON.stringify(sent['recipientKnown'])}`);
      // ★★ AND NO "you addressed a pod, not an identity" WARNING, because an identity WAS
      // matched. The first attempt's regression was the mirror image of this: the strongest
      // receipt the relay can issue, on a misdelivery.
      check('§4 …and it carries no you-addressed-a-pod warning',
        !String(sent['warning'] ?? '').includes('you addressed a pod, not an identity'),
        JSON.stringify(sent['warning']));
      check('§4 …and it names the victim, not some other row',
        String(sent['resolvedTo']).includes('victim'), JSON.stringify(sent['resolvedTo']));

      // ── (c) ★★ THE SQUAT, OVER THE WIRE ─────────────────────────────────────
      //
      // A stranger plants a row with the SAME single path segment on a FOREIGN origin, then a
      // third party follows the address the directory publishes for that local part. At
      // 0d6d90bc this is where the victim's own published address delivered to the attacker.
      const squatUrl = `https://elsewhere.example/${VICTIM}/`;
      const added = await callTool('add_pod', 'token-sender',
        { pod_url: squatUrl, owner: `did:web:identity.test:agents:sender-${SENDER}`, label: 'not the victim' });
      check('§4 the squat row is accepted by add_pod — nothing else refuses it',
        added['added'] === true, JSON.stringify(added).slice(0, 200));

      const afterSquat = await callTool('notify_agent', 'token-sender',
        { ...args, summary: 'a probe sent after a squat row was planted' });
      const n = writesUnder(victimInbox).length;
      check('§4 ★★ the address still resolves to the victim, and the victim alone',
        afterSquat['delivered'] === true
        && afterSquat['resolvedVia'] === 'followed-affordance'
        && String(afterSquat['targetPod']) === `${cssUrl}${VICTIM}/`
        && n === before + 2,
        `${JSON.stringify(afterSquat).slice(0, 320)} — writes ${JSON.stringify(writesUnder(victimInbox))}`);
      check('§4 …and nothing was written under the squat\'s own path',
        writesUnder('/elsewhere').length === 0, JSON.stringify([...stored.keys()]));

      // ★★ AND BOTH ROWS ARE LISTED, WHICH IS A CHANGE FROM WHAT THIS LINE USED TO ASSERT.
      // It used to record — as an observed, separate, then-unfixed defect — that the squat was
      // SWALLOWED by the `list_known_pods` de-dup, because `canonicalPodKey` was PATH-ONLY and
      // the filter keeps the FIRST insertion: the victim's row happened to be inserted first
      // here, and inserting the squat first made the VICTIM'S row disappear instead. That key
      // now separates a foreign origin from this store, so the de-dup can no longer put the two
      // in one bucket. The victim's row must be present and identified; the squat may be listed
      // and must be plainly itself — its own foreign url, and no minted affordance.
      // tests/same-pod-means-same-pod.test.ts §2 drives both hydration orderings.
      const listedAfterSquat = await callTool('list_known_pods', 'token-sender', {});
      const rowsAfterSquat = (listedAfterSquat['pods'] ?? []) as Array<Record<string, unknown>>;
      const victimAfterSquat = rowsAfterSquat.find(r => String(r['url']) === `${cssUrl}${VICTIM}/`);
      check('§4 ★★ the victim\'s own row is still listed with the squat present — not swallowed',
        victimAfterSquat !== undefined
        && Array.isArray(victimAfterSquat['affordances'])
        && (victimAfterSquat['affordances'] as unknown[]).length === 1,
        JSON.stringify(rowsAfterSquat.map(r => r['url'])).slice(0, 300));
      const squatAfterSquat = rowsAfterSquat.find(r => String(r['url']) === squatUrl);
      check('§4 …and the squat, if listed, is plainly itself: foreign url, no affordance',
        squatAfterSquat === undefined
        || (!('affordances' in squatAfterSquat) && String(squatAfterSquat['url']) === squatUrl),
        JSON.stringify(squatAfterSquat ?? '(not listed)').slice(0, 300));

      // ── (d) A LOCAL PART ONLY A FOREIGN ROW HOLDS IS NOT AN IDENTITY HERE ────
      //
      // DRIVEN on the tree this change was written on, before it: `GET /agents/u-eth-cccc55556666`
      // returned a 200 ActivityPub actor document for a stranger's row, from this relay's own
      // domain, for a local part no pod on this store has ever held.
      const GHOST = 'u-eth-cccc55556666';
      await callTool('add_pod', 'token-sender',
        { pod_url: `https://elsewhere.example/${GHOST}/`, owner: 'did:web:identity.test:agents:sender-x' });
      const ghost = await fetch(`${base}/agents/${GHOST}`);
      check('§4 ★★ this relay serves no actor for a local part only a foreign row holds',
        ghost.status === 404, String(ghost.status));
      const ghostFinger = await fetch(`${base}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${GHOST}@127.0.0.1:${relayPort}`)}`);
      check('§4 …nor a WebFinger for it', ghostFinger.status === 404, String(ghostFinger.status));

      // ★★ AND THE DIRECTORY PUBLISHES NO LINK ON IT EITHER — asked over the wire, which is the
      // only way to exercise the OWNER INDEX the shipped `list_known_pods` mints every row's
      // link through. §3b holds that path against these rows in isolation; this holds it in the
      // handler, where the index is actually built. The GHOST row is used rather than the squat
      // above because its path is unique, so no reading of the listing de-dup can drop it.
      const listedWithGhost = await callTool('list_known_pods', 'token-sender', {});
      const rowsWithGhost = (listedWithGhost['pods'] ?? []) as Array<Record<string, unknown>>;
      const ghostRow = rowsWithGhost.find(r => String(r['url']) === `https://elsewhere.example/${GHOST}/`);
      const victimListed = rowsWithGhost.find(r => String(r['url']) === `${cssUrl}${VICTIM}/`);
      check('§4 ★★ a foreign-origin row is LISTED and carries no affordance',
        !!ghostRow && !('affordances' in ghostRow),
        JSON.stringify(ghostRow ?? '(row not listed at all)').slice(0, 300));
      check('§4 …while the victim\'s own row carries exactly one, so the absence is not blanket',
        Array.isArray(victimListed?.['affordances'])
        && (victimListed!['affordances'] as unknown[]).length === 1,
        JSON.stringify(victimListed?.['affordances'] ?? '(none)').slice(0, 300));

      // ── (e) ADDITIVE: EVERY COMPOSED FORM STILL DELIVERS, UNCHANGED ─────────
      const forms: Array<[string, string, string]> = [
        [`${cssUrl}${VICTIM}/inbox/`, 'pod-id-in-url', 'the canonical inbox address'],
        [`${cssUrl}${VICTIM}/profile/card#me`, 'pod-id-in-url', 'a WebID'],
        [VICTIM, 'pod-id', 'a bare pod id'],
        [IDENTITIES['token-victim']!.agentId, 'directory-did', 'the victim\'s registered DID'],
      ];
      for (const [to, via, why] of forms) {
        const k = writesUnder(victimInbox).length;
        const r = await callTool('notify_agent', 'token-sender', { to, summary: `a probe by ${why}` });
        check(`§4 ${why} still delivers, by ${via}`,
          r['delivered'] === true && r['resolvedVia'] === via
          && writesUnder(victimInbox).length === k + 1,
          `${to} -> ${JSON.stringify(r).slice(0, 260)}`);
      }
      // ★ AND A WEBFINGER FOR A NORMAL AGENT STILL RESOLVES. `cardForLocalPart` dropped its
      // `handle` disjunct in this change; this is the check that the drop took nothing with it.
      const finger = await fetch(`${base}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${VICTIM}@127.0.0.1:${relayPort}`)}`);
      const jrd = finger.ok ? await finger.json() as { links?: Array<{ href?: string }> } : {};
      check('§4 a registered agent\'s WebFinger still resolves to its actor',
        finger.ok && (jrd.links ?? []).some(l => l.href === `${base}/agents/${VICTIM}`),
        `${finger.status} ${JSON.stringify(jrd).slice(0, 220)}`);

      // ── (f) THE ADDRESS THE DIRECTORY ALREADY PUBLISHED IS THE SAME STRING ──
      //
      // `autoRegisterAgentCard` writes it as the row's `activitypub` channel, and that channel
      // is native, so every caller already sees it. If the affordance bound a different
      // spelling there would be two published addresses for one agent.
      const dir2 = await callTool('list_known_pods', 'token-sender', {});
      const row2 = ((dir2['pods'] ?? []) as Array<Record<string, unknown>>)
        .find(r => String(r['url']).includes(VICTIM));
      const chans = (row2?.['channels'] ?? []) as Array<{ type: string; value: string }>;
      check('§4 the row\'s activitypub channel is the identical string the affordance binds',
        chans.some(c => c.type === 'activitypub' && c.value === bound),
        JSON.stringify(chans));
    }
  } finally {
    child.kill();
    process.removeListener('exit', killChild);
    await identity.close();
    await pod.close();
    rmSync(keyFile, { force: true });
  }
}

console.log(failures === 0 ? '\nPASS\n' : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
