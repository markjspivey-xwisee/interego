#!/usr/bin/env tsx
/**
 * A notify target is the pod the sender NAMED — not the pod-id token in its path.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 *
 * `resolveTargetPodUrl`'s http(s) branch ran an UNANCHORED
 * `(u-pk-|u-did-|u-eth-|eth-)[0-9a-z]+` over the whole `to` string and rebuilt the target as
 * `${CSS_URL}${match}/`. The ORIGIN and every other path segment were discarded, not checked:
 *
 *   notify_agent { to: "<CSS>/team/u-eth-VICTIM/" }   → wrote <CSS>/u-eth-VICTIM/inbox/
 *   notify_agent { to: "https://elsewhere/u-eth-V/" } → wrote <CSS>/u-eth-V/inbox/
 *
 * and answered `delivered: true` in both cases. A pod segment ANYWHERE in a URL chose the
 * recipient, and a foreign origin silently retargeted onto this deployment's own store.
 *
 * That is the address squat of cf4f03ad one function over — there `cardForLocalPart` matched a
 * federation row by its LAST PATH SEGMENT; here the delivery target was chosen by a token in
 * ANY segment. The bare-id route carried the same collapse: its test was a PREFIX
 * (`/^(u-pk-|u-did-|u-eth-|eth-)/`), so `to: "eth-x/../u-eth-VICTIM"` became
 * `${CSS_URL}eth-x/../u-eth-VICTIM/`, which `new URL` normalises at fetch time into the
 * victim's inbox.
 *
 * ── WHAT THIS FILE ASSERTS, AND WITH WHICH INSTRUMENT ────────────────────────
 *
 * §1 executes the SHIPPED characters. `server.ts` calls `app.listen()` at module scope and
 * cannot be imported, and extracting these helpers into a module of their own would need a
 * `COPY` line in `deploy/Dockerfile.relay` (see image-copies-every-source.test.ts). So the
 * declarations are sliced out of server.ts by source anchors, written to one temp module and
 * imported — the same instrument addr-directory-identity.test.ts uses, for the same reason. A
 * reimplementation of the resolver could not catch this, because the resolution IS the defect.
 *
 * §2 BOOTS THE REAL RELAY and calls `notify_agent` over the wire against a fixture pod that
 * records every PUT. Source text cannot say where the bytes went, and "where the bytes went"
 * is the entire claim: the receipt said `delivered: true` and the victim's inbox is what has
 * to be checked, not the receipt.
 *
 * ── AND THE ADDITIVE HALF, WHICH IS MOST OF IT ───────────────────────────────
 *
 * Every form a live caller sends is driven here, because a narrowing that refuses one of them
 * is an outage, not a fix:
 *
 *   - `<CSS>/<pod>/inbox/`         — what `read_inbox` reports and what
 *                                    packages/core/src/model/agent.ts publishes as an agent's
 *                                    ask route; discord/tools/drive-agents-live.ts delivers to
 *                                    it and asserts `canonicalInbox: true`.
 *   - `<CSS>/<pod>/profile/card#me` — a WebID, which must reach the pod inbox and not the
 *                                    profile-local one (f-foxxi-webid-inbox-routing).
 *   - `<PUBLIC>/<pod>/`            — the store's other legitimate spelling.
 *   - `<CSS>/maintainer/`          — a single-segment pod whose name is not a derived id.
 *                                    Three such rows are live: `maintainer`, `foxxi`,
 *                                    `u-try-d064879aba54`.
 *   - a bare pod id, a did:ethr, an acct: handle, a registered DID.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/notify-target-collapse.test.ts
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

// ── §1. Load the SHIPPED declarations ────────────────────────────────────────
//
// Two slices. The resolver and its canonical-target predicate are contiguous; the
// trailing-slash helper they compose lives ~230 lines above, beside the directory de-dup.
const SLICE_FROM = 'const POD_ID_SLUG';
const SLICE_TO = 'let NOTIFICATION_GATE';
const SLASH_FROM = 'function ensureTrailingSlashLocal(';
const SLASH_TO = '// Evict any OTHER knownPods entries';
// ★★ AND THE AGENT-ADDRESS HELPERS, SLICED THIRD, BECAUSE THE RESOLVER NOW CALLS ONE OF THEM.
// `resolveTargetPodUrl`'s first branch asks `followedAgentAddressRow` whether `to` is an address
// this relay published on a directory row. Stubbing that out here would make §1 a test of a
// resolver that is not the shipped one - and a stub returning "no" for everything is exactly the
// double that cannot refute the branch it stands in for. So the real declarations are sliced in,
// and the two predicates they compose (`identityIsObserved` / `describeDirectoryEntry`, 2,000
// lines up) are supplied below as the reduction §1 needs: this section's fixture rows are never
// identified, so both answers are constant here and the followed branch correctly declines every
// input in this file. tests/follow-the-directory.test.ts is where that branch is driven for real.
const ADDR_FROM = 'function podOwnsLocalPart(';
const ADDR_TO = '/**\n * What a caller can DO with one directory row';
const from = SERVER.indexOf(SLICE_FROM);
const to = SERVER.indexOf(SLICE_TO, from + 1);
const slashFrom = SERVER.indexOf(SLASH_FROM);
const slashTo = SERVER.indexOf(SLASH_TO, slashFrom + 1);
const addrFrom = SERVER.indexOf(ADDR_FROM);
const addrTo = SERVER.indexOf(ADDR_TO, addrFrom + 1);
if (from < 0 || to < 0 || slashFrom < 0 || slashTo < 0 || addrFrom < 0 || addrTo < 0) {
  console.error(`\nFAIL — cannot locate the notify resolver in server.ts (from=${from}, to=${to}, slash=${slashFrom}/${slashTo}, addr=${addrFrom}/${addrTo}).`);
  console.error('  If it was renamed or moved, this suite is testing nothing. Re-anchor it.');
  process.exit(1);
}

/** The fixture store, in both of its legitimate spellings. */
const CSS = 'http://css.fixture.internal:3456/';
const PUB = 'https://gate.fixture.example/';
const VICTIM = 'u-eth-aaaa11112222';

type Resolution = { pod: string; via: string } | undefined;
let resolveTargetPodUrl: (to: string) => Resolution;
let isCanonicalPodTarget: (targetPod: string) => boolean;
let knownPods: Map<string, Record<string, string>>;

const tmpDir = mkdtempSync(join(tmpdir(), 'notify-target-'));
const tmpModule = join(tmpDir, 'notify-target-extracted.ts');
try {
  writeFileSync(
    tmpModule,
    // The slices carry annotations naming declarations that live elsewhere in server.ts
    // (`RecipientRoute`, `KnownPodEntry`). tsx transpiles rather than typechecks, so those
    // positions are erased — the BODIES that run are the shipped characters, which is the
    // only property this section needs from them.
    `type RecipientRoute = string;\n`
    + `type KnownPodEntry = Record<string, string>;\n`
    + `const CSS_URL = ${JSON.stringify(CSS)};\n`
    + `const STORE_ORIGINS: ReadonlySet<string> = new Set(`
    + `${JSON.stringify([new URL(CSS).origin, new URL(PUB).origin])});\n`
    + `const knownPods = new Map<string, Record<string, string>>();\n`
    // The relay's own origin, deliberately NOT one of the store spellings above and not any
    // host this file sends to, so the followed branch is exercised and declines rather than
    // being skipped.
    + `const RELAY_AP_BASE = 'https://relay.fixture.example';\n`
    + `const apActorUrl = (b: string, lp: string) => \`\${b}/agents/\${encodeURIComponent(lp)}\`;\n`
    // Every row this file puts in `knownPods` carries a url and (at most) a did/handle/webId
    // it never sets, so no row here is one the relay identified: both of these are constant
    // over this file's fixtures, which is what makes the reduction sound HERE and nowhere else.
    + `const describeDirectoryEntry = (_e: unknown) => ({ identifiedBy: 'nothing' });\n`
    + `const identityIsObserved = (i: { identifiedBy: string }) => i.identifiedBy !== 'nothing';\n`
    + `${SERVER.slice(slashFrom, slashTo)}\n`
    + `${SERVER.slice(addrFrom, addrTo)}\n`
    + `${SERVER.slice(from, to)}\n`
    + `export { resolveTargetPodUrl, isCanonicalPodTarget, knownPods };\n`,
    'utf8',
  );
  const mod = await import(pathToFileURL(tmpModule).href) as {
    resolveTargetPodUrl: typeof resolveTargetPodUrl;
    isCanonicalPodTarget: typeof isCanonicalPodTarget;
    knownPods: typeof knownPods;
  };
  resolveTargetPodUrl = mod.resolveTargetPodUrl;
  isCanonicalPodTarget = mod.isCanonicalPodTarget;
  knownPods = mod.knownPods;
} finally {
  // A probe file that outlives its run is litter in someone else's typecheck.
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log('\nNOTIFY-TARGET — the pod a sender named, not the token in the path');

console.log('\n1. the collapse');
{
  const cases: Array<[string, string]> = [
    [`${CSS}team/${VICTIM}/`, 'a pod segment under another path segment on our own store'],
    [`${CSS}projects/${VICTIM}/notes.ttl`, 'a document deep under another pod-shaped path'],
    [`https://elsewhere.example/${VICTIM}/`, 'a foreign origin spelling the victim id'],
    [`https://elsewhere.example/team/${VICTIM}/`, 'a foreign origin with it buried'],
  ];
  for (const [url, why] of cases) {
    const r = resolveTargetPodUrl(url);
    check(`${why} does NOT resolve to ${CSS}${VICTIM}/`,
      r?.pod !== `${CSS}${VICTIM}/`, `${url} -> ${JSON.stringify(r)}`);
  }
  // ★ NON-VACUITY. Without this, every check above passes for a resolver that returns
  // undefined for everything — including the forms §2 proves live callers depend on.
  check('and the victim\'s own pod root still resolves to the victim',
    resolveTargetPodUrl(`${CSS}${VICTIM}/`)?.pod === `${CSS}${VICTIM}/`,
    JSON.stringify(resolveTargetPodUrl(`${CSS}${VICTIM}/`)));

  // The bare-id route carried the same collapse through path traversal.
  const trav = resolveTargetPodUrl(`eth-x/../${VICTIM}`);
  check('a bare id containing a dot-segment path is not a pod id',
    trav === undefined, JSON.stringify(trav));
  check('…and the id it tried to traverse to is reachable when it is simply typed',
    resolveTargetPodUrl(VICTIM)?.pod === `${CSS}${VICTIM}/`,
    JSON.stringify(resolveTargetPodUrl(VICTIM)));
}

// ── §1b. A REFUSAL IS THE ANSWER; A SHORTER ADDRESS IS NOT ───────────────────
//
// The first fix for the collapse read the FIRST path segment as the pod. That is still a
// truncation: `<CSS>/team/<victim>/` became `<CSS>/team/` — a container the sender never
// named, on the sender's own store, which §5(e) shows is a real pod whose inbox accepts the
// write. On this store the resolver now returns a pod only for that pod's ROOT or for one of
// the two published addresses inside it (`inbox/`, `profile/card`); anything else takes
// `store-path-not-a-pod` and carries the caller's OWN string, unshortened, so the receipt can
// echo what was sent instead of a fragment of it.
console.log('\n1b. a path on our store that addresses no pod is refused, not truncated');
{
  const refused: Array<[string, string]> = [
    [`${CSS}team/${VICTIM}/`, 'a pod segment under another path segment'],
    [`${CSS}projects/${VICTIM}/notes.ttl`, 'a document deep under another path'],
    [`${PUB}team/${VICTIM}/`, 'the same shape on the public spelling of this store'],
    [`${CSS}${VICTIM}/profile/`, 'a container inside a pod that is not one of its addresses'],
    [`${CSS}${VICTIM}/inbox/x.jsonld`, 'a document inside the pod inbox'],
    [CSS, 'the store root itself'],
  ];
  for (const [url, why] of refused) {
    const r = resolveTargetPodUrl(url);
    check(`${why} is refused, un-truncated`,
      r?.via === 'store-path-not-a-pod' && r.pod === url, `${url} -> ${JSON.stringify(r)}`);
    check(`…and ${why} is not a canonical pod target either`,
      !isCanonicalPodTarget(url), url);
  }
  // ★ NON-VACUITY, TWICE OVER: the two deep forms live callers DO send still resolve, and the
  // container the truncation used to name is still addressable when it is addressed on purpose.
  check('the canonical inbox address is still a pod address',
    resolveTargetPodUrl(`${CSS}${VICTIM}/inbox/`)?.pod === `${CSS}${VICTIM}/`,
    JSON.stringify(resolveTargetPodUrl(`${CSS}${VICTIM}/inbox/`)));
  check('a WebID is still a pod address',
    resolveTargetPodUrl(`${CSS}${VICTIM}/profile/card#me`)?.pod === `${CSS}${VICTIM}/`,
    JSON.stringify(resolveTargetPodUrl(`${CSS}${VICTIM}/profile/card#me`)));
  check('and `team` addressed on its own is a pod like any other',
    resolveTargetPodUrl(`${CSS}team/`)?.pod === `${CSS}team/`,
    JSON.stringify(resolveTargetPodUrl(`${CSS}team/`)));
}

// ── §1c. A POD ID IS ONE SEGMENT OF THE DERIVED SLUG ALPHABET ────────────────
//
// `new URL` does NOT decode a pathname, so `%2f` survives the split and counts as ONE segment
// to a checker that splits on `/` while counting as TWO to a store that decodes it. DRIVEN on
// the shipped file before this rule: `to: "<CSS>/u-eth-aaaa11112222%2finbox/"` answered
// `delivered: true, canonicalInbox: true` and the relay issued
// `PUT /u-eth-aaaa11112222%2finbox/inbox/<id>.jsonld` with the escape still on the wire.
//
// THE RULE: a pod id is a single path segment that MEANS ITSELF — unreserved characters only,
// so it needs no decoding and cannot mean one thing here and another at the store. A
// percent-escape anywhere in it is not a pod id, at any encoding depth.
console.log('\n1c. a percent-escape in the pod segment is not a pod id');
{
  for (const [esc, why] of [
    ['%2f', 'lower-case %2f'],
    ['%2F', 'upper-case %2F'],
    ['%252f', 'a double-encoded %252f'],
    ['%2e%2e', 'an encoded dot-segment'],
  ] as Array<[string, string]>) {
    const url = `${CSS}${VICTIM}${esc}inbox/`;
    const r = resolveTargetPodUrl(url);
    check(`${why} in the pod segment is not a pod`,
      r?.via === 'store-path-not-a-pod' && r.pod === url, `${url} -> ${JSON.stringify(r)}`);
    check(`…and ${why} is not a canonical pod target`, !isCanonicalPodTarget(url), url);
    // The bare-id route never accepted one — `%` is not in the derived-slug alphabet — and
    // this holds it there rather than leaving it to POD_ID_SLUG's shape by accident.
    const bare = `${VICTIM}${esc}inbox`;
    check(`…and a BARE id carrying ${why} resolves to nothing`,
      resolveTargetPodUrl(bare) === undefined, `${bare} -> ${JSON.stringify(resolveTargetPodUrl(bare))}`);
  }
  // ★ NON-VACUITY. Without this every check above passes for a resolver that refuses the pod.
  check('and the same address without the escape still resolves to the victim',
    resolveTargetPodUrl(`${CSS}${VICTIM}/inbox/`)?.pod === `${CSS}${VICTIM}/`,
    JSON.stringify(resolveTargetPodUrl(`${CSS}${VICTIM}/inbox/`)));
}

console.log('\n2. every form a live caller sends still resolves, to the same pod');
{
  const expect: Array<[string, string, string]> = [
    [`${CSS}${VICTIM}/`, 'pod-id-in-url', 'the pod root'],
    [`${CSS}${VICTIM}/inbox/`, 'pod-id-in-url', 'the canonical inbox read_inbox reports'],
    [`${CSS}${VICTIM}/profile/card#me`, 'pod-id-in-url', 'a WebID'],
    [`${PUB}${VICTIM}/`, 'pod-id-in-url', 'the public spelling of the same store'],
    [`${PUB}${VICTIM}/inbox/`, 'pod-id-in-url', 'the public spelling of the inbox'],
    [VICTIM, 'pod-id', 'a bare pod id'],
    [`${VICTIM}/`, 'pod-id', 'a bare pod id with a trailing slash'],
    [VICTIM.toUpperCase(), 'pod-id', 'a bare pod id typed in upper case'],
    [`${CSS}${VICTIM.toUpperCase()}/`, 'pod-id-in-url', 'a URL with the id in upper case'],
  ];
  for (const [input, via, why] of expect) {
    const r = resolveTargetPodUrl(input);
    check(`${why} resolves to the pod root by ${via}`,
      r?.pod === `${CSS}${VICTIM}/` && r.via === via, `${input} -> ${JSON.stringify(r)}`);
  }
  const eth = resolveTargetPodUrl('did:ethr:0xDA3fF679995eCE471ceB5E3BD5DDbD3AFeb58E3a');
  check('a did:ethr still derives its eth- pod',
    eth?.pod === `${CSS}eth-da3ff679995e/` && eth.via === 'did:ethr-derived',
    JSON.stringify(eth));

  // The three live rows whose single-segment pod name is not a derived id.
  for (const name of ['maintainer', 'foxxi', 'u-try-d064879aba54']) {
    const r = resolveTargetPodUrl(`${CSS}${name}/`);
    check(`the live pod "${name}" resolves to itself by pod-url`,
      r?.pod === `${CSS}${name}/` && r.via === 'pod-url', JSON.stringify(r));
  }
  // …and case is preserved for those, because they are names somebody chose rather than
  // slugs this relay derived, and CSS paths are case-sensitive.
  check('a chosen pod name keeps its case',
    resolveTargetPodUrl(`${CSS}Foxxi/`)?.pod === `${CSS}Foxxi/`,
    JSON.stringify(resolveTargetPodUrl(`${CSS}Foxxi/`)));

  // A directory match still wins over every derivation.
  knownPods.set(`${CSS}${VICTIM}/`, {
    url: `${CSS}${VICTIM}/`,
    did: 'did:web:identity.test:agents:someone-' + VICTIM,
    handle: 'acct:' + VICTIM + '@relay.test',
    webId: `${CSS}${VICTIM}/profile/card#me`,
  });
  for (const [input, via] of [
    ['did:web:identity.test:agents:someone-' + VICTIM, 'directory-did'],
    ['acct:' + VICTIM + '@relay.test', 'directory-handle'],
    [`${CSS}${VICTIM}/profile/card#me`, 'directory-webid'],
  ] as Array<[string, string]>) {
    const r = resolveTargetPodUrl(input);
    check(`a registered ${via} still resolves first`,
      r?.pod === `${CSS}${VICTIM}/` && r.via === via, `${input} -> ${JSON.stringify(r)}`);
  }
  knownPods.clear();
}

console.log('\n3. a foreign URL is left where it was pointed');
{
  for (const url of [
    'https://foxxi-bridge.interego.xwisee.com/',   // a live row: foreign origin, no path
    'https://10-0-0-5.nip.io/x/',                  // a live row: foreign origin, one segment
    `https://elsewhere.example/${VICTIM}/`,
  ]) {
    const r = resolveTargetPodUrl(url);
    check(`${url} stays external-url, as given`,
      r?.pod === url && r.via === 'external-url', JSON.stringify(r));
  }
}

console.log('\n4. canonicalInbox answers the question its name asks');
{
  check('a pod root on the internal spelling is canonical',
    isCanonicalPodTarget(`${CSS}${VICTIM}/`));
  check('a pod root on the public spelling is canonical',
    isCanonicalPodTarget(`${PUB}${VICTIM}/`));
  // ★★ THE THREE THAT USED TO ANSWER TRUE. The old second disjunct reduced to "starts with
  // the store ROOT", which every path does.
  check('a foreign origin is NOT canonical',
    !isCanonicalPodTarget('https://foxxi-bridge.interego.xwisee.com/'));
  check('a foreign origin with a pod token in it is NOT canonical',
    !isCanonicalPodTarget(`https://elsewhere.example/${VICTIM}/`));
  check('the store root itself is NOT canonical — nobody polls it for anyone',
    !isCanonicalPodTarget(CSS));
  check('a multi-segment path on our own store is NOT a pod root',
    !isCanonicalPodTarget(`${CSS}team/${VICTIM}/`));
}

// ── §5. DRIVEN, because source text cannot say where the bytes went ──────────
console.log('\n5. driven: the real relay, a real notify_agent, and the victim\'s real inbox');
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

  // An in-memory pod that records every PUT by path. The recorded paths ARE the evidence:
  // the whole defect is a write landing in a container the sender never named.
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
  const keyFile = join(tmpdir(), `notify-target-key-${process.pid}.json`);

  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: join(here, '..'),
    env: {
      ...process.env,
      PORT: String(relayPort),
      CSS_URL: cssUrl,
      // The store's OTHER legitimate spelling. Never fetched on this path — toInternalPodUrl
      // folds every target onto CSS_URL before the write — but it is what puts a second
      // origin into STORE_ORIGINS, which is the thing under test.
      CSS_PUBLIC_URL: PUB,
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
  /** Everything written under one container since the marker — the only honest answer to
   *  "did this reach the recipient". */
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
    check('§5 the relay boots against the fixtures and answers /health', up,
      `${base} — child stderr tail: ${childErr || '(none)'}`);

    if (up) {
      // The victim authenticates once, so it has a real directory row and a real pod.
      await callTool('read_inbox', 'token-victim', {});

      // ── (a) ★★ THE DEFECT, DRIVEN ────────────────────────────────────────────
      // At HEAD this call answered `delivered: true` and put the notification in
      // `<CSS>/u-eth-aaaa11112222/inbox/` — a pod the sender never named.
      const squatUrl = `${cssUrl}team/${VICTIM}/`;
      const before = writesUnder(victimInbox).length;
      const squatKeysBefore = new Set(stored.keys());
      const squat = await callTool('notify_agent', 'token-sender',
        { to: squatUrl, summary: 'a probe addressed to a path that is not a pod' });
      check('§5 ★★ a pod segment under another path segment does NOT reach that pod\'s inbox',
        writesUnder(victimInbox).length === before,
        `${JSON.stringify(writesUnder(victimInbox))} — receipt ${JSON.stringify(squat).slice(0, 300)}`);
      check('§5 …and the receipt does not name the victim\'s pod',
        squat['targetPod'] !== `${cssUrl}${VICTIM}/`, JSON.stringify(squat['targetPod']));

      // ── (a2) ★★ AND WHERE THE BYTES ACTUALLY WENT, WHICH IS WHAT (a) DID NOT ASK ──
      //
      // The two checks above are satisfied by a relay that delivers this message ANYWHERE
      // except the victim's inbox — and the first fix for the collapse did exactly that. It
      // read the FIRST path segment as the pod, so `<CSS>/team/<victim>/` was truncated to
      // `<CSS>/team/` and the notification was written into `<CSS>/team/inbox/` with
      // `delivered: true`. The victim's count was unchanged and `targetPod` differed, so both
      // checks passed over a misdelivery. The question is not "did it miss the victim" but
      // "where did it land", and the only acceptable answer for a refused target is nowhere.
      const squatAdded = [...stored.keys()].filter(k => !squatKeysBefore.has(k));
      check('§5 ★★ …and NO notification was written into ANY inbox on this store for it',
        squatAdded.filter(k => k.includes('/inbox/')).length === 0,
        `newly written: ${JSON.stringify(squatAdded)}`);
      check('§5 …and it is refused, on the route that says why',
        squat['delivered'] === false && squat['canonicalInbox'] === false
        && squat['resolvedVia'] === 'store-path-not-a-pod',
        JSON.stringify(squat).slice(0, 400));
      check('§5 …and the refusal names the three accepted forms, and says nothing was written',
        typeof squat['error'] === 'string'
        && String(squat['error']).includes('Nothing was written')
        && String(squat['error']).includes('/inbox/')
        && String(squat['error']).includes('/profile/card#me')
        && String(squat['error']).includes('list_known_pods'),
        JSON.stringify(squat['error']));
      check('§5 …and `targetPod` echoes what was sent rather than a pod cut out of it',
        squat['targetPod'] === squatUrl, JSON.stringify(squat['targetPod']));

      // ── (a3) ★ AN ENCODED SLASH IS NOT A POD ID, OVER THE WIRE ───────────────
      //
      // Driven on the shipped file before the segment rule: this answered
      // `delivered: true, canonicalInbox: true` and the relay issued
      // `PUT /u-eth-aaaa11112222%2finbox/inbox/<id>.jsonld` with the escape still on the wire —
      // one segment to `new URL`, two to a store that decodes it.
      for (const [esc, why] of [
        ['%2f', 'lower-case %2f'],
        ['%2F', 'upper-case %2F'],
        ['%252f', 'a double-encoded %252f'],
      ] as Array<[string, string]>) {
        const encKeysBefore = new Set(stored.keys());
        const enc = await callTool('notify_agent', 'token-sender', {
          to: `${cssUrl}${VICTIM}${esc}inbox/`,
          summary: `a probe whose pod id carries ${why}`,
        });
        const encAdded = [...stored.keys()].filter(k => !encKeysBefore.has(k));
        check(`§5 ★ a pod id carrying ${why} is refused and writes nothing`,
          enc['delivered'] === false && enc['canonicalInbox'] === false
          && enc['resolvedVia'] === 'store-path-not-a-pod'
          && encAdded.filter(k => k.includes('/inbox/')).length === 0,
          `${JSON.stringify(enc).slice(0, 300)} — newly written: ${JSON.stringify(encAdded)}`);
      }

      // ── (b) ★★ A FOREIGN ORIGIN DOES NOT RETARGET ONTO US ────────────────────
      //
      // ★★ THIS IS THE CHECK THAT REFUTED THE FIRST FIX. With `resolveTargetPodUrl` already
      // narrowed — it correctly refuses to resolve this URL to the victim, and §1 proves it —
      // this call STILL put the notification in `/u-eth-aaaa11112222/inbox/`, because
      // `toInternalPodUrl` discards the host and pastes the PATH onto this store, and the
      // card lookup keys on `canonicalPodKey`, which is path-only too. Two downstream readers
      // re-derived what the resolver had just declined to. Nothing in §1–§4 could see it.
      const foreign = await callTool('notify_agent', 'token-sender',
        { to: `https://elsewhere.example/${VICTIM}/`, summary: 'a probe from a foreign origin' });
      check('§5 ★★ a foreign origin spelling the victim id does NOT reach the victim',
        writesUnder(victimInbox).length === before,
        `${JSON.stringify(writesUnder(victimInbox))} — receipt ${JSON.stringify(foreign).slice(0, 300)}`);
      check('§5 …and it is refused rather than reported delivered somewhere else',
        foreign['delivered'] === false && foreign['canonicalInbox'] === false,
        JSON.stringify(foreign).slice(0, 300));
      check('§5 …and the refusal says nothing was written, and what to send instead',
        typeof foreign['error'] === 'string'
        && String(foreign['error']).includes('Nothing was written')
        && String(foreign['error']).includes('list_known_pods'),
        JSON.stringify(foreign['error']));
      check('§5 …and NOTHING was written anywhere on the store for it',
        !stored.has(`/${VICTIM}/inbox/`) && writesUnder('/inbox/').length === 0,
        JSON.stringify([...stored.keys()]));

      // ── (c) AND EVERY LIVE FORM STILL DELIVERS, TO THE VICTIM ────────────────
      const forms: Array<[string, string, string]> = [
        [`${cssUrl}${VICTIM}/inbox/`, 'pod-id-in-url', 'the canonical inbox address'],
        [`${cssUrl}${VICTIM}/profile/card#me`, 'pod-id-in-url', 'a WebID'],
        [`${cssUrl}${VICTIM}/`, 'pod-id-in-url', 'the pod root'],
        [`${PUB}${VICTIM}/`, 'pod-id-in-url', 'the public spelling'],
        [VICTIM, 'pod-id', 'a bare pod id'],
      ];
      for (const [to, via, why] of forms) {
        const n = writesUnder(victimInbox).length;
        const r = await callTool('notify_agent', 'token-sender',
          { to, summary: `a probe addressed by ${why}` });
        check(`§5 ${why} delivers into the victim's own inbox`,
          r['delivered'] === true && writesUnder(victimInbox).length === n + 1,
          `${to} -> ${JSON.stringify(r).slice(0, 300)}`);
        check(`§5 …reported as ${via}, canonical`,
          r['resolvedVia'] === via && r['canonicalInbox'] === true,
          `${JSON.stringify(r['resolvedVia'])} / ${JSON.stringify(r['canonicalInbox'])}`);
      }

      // The victim's own DID, which is the route a sender SHOULD be using.
      const n = writesUnder(victimInbox).length;
      const byDid = await callTool('notify_agent', 'token-sender', {
        to: IDENTITIES['token-victim']!.agentId,
        summary: 'a probe addressed to a published identity',
      });
      check('§5 the victim\'s registered DID delivers, by directory-did',
        byDid['delivered'] === true && byDid['resolvedVia'] === 'directory-did'
        && writesUnder(victimInbox).length === n + 1,
        JSON.stringify(byDid).slice(0, 300));

      // ── (d) A SINGLE-SEGMENT POD WHOSE NAME IS NOT A DERIVED ID ──────────────
      // Three of these are live (`maintainer`, `foxxi`, `u-try-…`). Before this change they
      // took the external-url route and were written to the same place; the route now says
      // what they are.
      const named = await callTool('notify_agent', 'token-sender',
        { to: `${cssUrl}maintainer/`, summary: 'a probe addressed to a named pod' });
      check('§5 a named single-segment pod delivers to its own inbox, by pod-url',
        named['delivered'] === true && named['resolvedVia'] === 'pod-url'
        && named['canonicalInbox'] === true
        && writesUnder('/maintainer/inbox/').length === 1,
        `${JSON.stringify(named).slice(0, 300)} — ${JSON.stringify(writesUnder('/maintainer/inbox/'))}`);

      // ── (e) ★★ AND THE CONTAINER THE TRUNCATION USED TO NAME IS A REAL, WRITABLE ONE ──
      //
      // This is why (a2) is not a check about a hypothetical. Addressed on its own, `team` is
      // a pod like `maintainer` and its inbox accepts the write — so `<CSS>/team/<victim>/`,
      // truncated, delivered a message addressed to the victim into a container belonging to
      // whoever holds `team`, and reported `delivered: true`. Run LAST, so the "nothing was
      // written" checks above cannot be satisfied by `/team/inbox/` being unreachable.
      check('§5 …and `/team/inbox/` had received nothing up to this point',
        writesUnder('/team/inbox/').length === 0,
        JSON.stringify(writesUnder('/team/inbox/')));
      const team = await callTool('notify_agent', 'token-sender',
        { to: `${cssUrl}team/`, summary: 'a probe addressed to the container the truncation named' });
      check('§5 ★★ addressed on its own, `team` IS a pod and its inbox receives',
        team['delivered'] === true && team['resolvedVia'] === 'pod-url'
        && writesUnder('/team/inbox/').length === 1,
        `${JSON.stringify(team).slice(0, 300)} — ${JSON.stringify(writesUnder('/team/inbox/'))}`);
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
