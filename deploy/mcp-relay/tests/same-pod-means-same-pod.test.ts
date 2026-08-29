#!/usr/bin/env tsx
/**
 * "The same pod" must mean the same pod — not "some pod whose path is spelled like this one".
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
 *
 * `canonicalPodKey` is the relay's whole notion of pod identity: every ownership gate, the
 * `list_known_pods` de-dup, `evictCanonicalDuplicates` and the notify fan-out's card lookup all
 * compare it. It used to be the LOWER-CASED PATHNAME with the origin discarded, so a directory
 * row on any origin at all — and a row at a case variant of a local path — was "the same pod" as
 * a real local pod, to all of those readers at once. Two of them act on that answer by REMOVING
 * a row:
 *
 *   §2 ★★ `handleListKnownPods` de-dups on the key and keeps the FIRST insertion. Plant
 *      `https://elsewhere.example/<victim>/` through `add_pod`, restart so that file hydrates
 *      first, and a third party listing the directory saw the PLANTED row and no sign the
 *      victim's real row existed. The victim was not impersonated — they were HIDDEN.
 *
 *   §3 ★ `evictCanonicalDuplicates` keys the same way and DELETES THE LOSER'S PERSISTED
 *      FEDERATION FILE, so a collision destroyed a stored row instead of shadowing it. That is
 *      the half of this that a restart does not undo.
 *
 * ── WHAT THE FIX IS, AND WHY IT IS NOT "COMPARE THE ORIGIN" ──────────────────
 *
 * One pod legitimately has TWO spellings here — the internal host `solidFetch` writes against
 * and the public gate host identifiers are handed out under — and collapsing those is the entire
 * reason the de-dup exists. So the rule is: this deployment's store is ONE bucket however it is
 * spelled, every other origin is its own, and the path is compared as written.
 *
 * MEASURED FROM THE LIVE STORE, not read off the config (2026-08-29; all 578 persisted
 * federation files fetched from `https://gate.interego.xwisee.com/svc-relay-dcr/federation/` and
 * parsed): four origins are present — `http://css.railway.internal:3456` (571 rows),
 * `https://gate.interego.xwisee.com` (5), `https://foxxi-bridge.interego.xwisee.com` (1) and
 * `https://10-0-0-5.nip.io` (1) — there are exactly FOUR path-only collisions, and every one of
 * them is the gate spelling paired with the internal spelling of the same `eth-` pod. No live
 * collision involves a foreign origin, and ZERO rows have a pathname that is not already
 * lower-case. §1c replays those measured rows: old key and new key give the same 574 buckets.
 *
 * ── WITH WHICH INSTRUMENT, AND WHY ───────────────────────────────────────────
 *
 * §1 executes the SHIPPED characters. `server.ts` calls `app.listen()` at module scope and
 * cannot be imported, so the declaration is sliced out by source anchors into a temp module —
 * the instrument addr-directory-identity / notify-target-collapse / follow-the-directory already
 * use. Its answers are compared against a reference implementation written from the STATED RULE
 * rather than from the code, over an adversarial corpus, so agreement is evidence and not an
 * echo.
 *
 * §2 and §3 BOOT THE REAL RELAY against a fixture store and assert on WHAT THE THIRD PARTY GETS
 * and on WHICH FILES SURVIVE — never on a receipt. The suppression is an ORDERING defect, so §2
 * drives BOTH hydration orderings by delaying the fixture's own GETs; the eviction is
 * DESTRUCTIVE, so §3 asserts on the persisted federation files and on the recorded DELETE
 * requests, by raw and decoded path.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/same-pod-means-same-pod.test.ts
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import express from 'express';

import { sha256Hex } from '../federation-store.js';
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

// ── The fixture deployment ───────────────────────────────────────────────────
const PUB = 'https://gate.fixture.example/';
const VICTIM = 'u-eth-aaaa11112222';
const SENDER = 'u-eth-ffff99990000';
const VICTIM_DID = `did:web:identity.test:agents:victim-${VICTIM}`;
const ATTACKER_DID = `did:web:identity.test:agents:attacker-${SENDER}`;
const PLANT_ORIGIN = 'https://elsewhere.example';

// ── §1 THE COMPARATOR ITSELF, AS SHIPPED ─────────────────────────────────────
//
// The slice runs from `canonicalPodKey`'s own declaration to `evictCanonicalDuplicates`'s, so it
// carries `ensureTrailingSlashLocal` (which it composes) with it. `STORE_ORIGINS` is relay config
// and is injected — as a MUTABLE Set the section refills, so the same shipped body can be asked
// about the fixture deployment and about the production one without a second copy of it.
const KEY_FROM = 'function canonicalPodKey(';
const KEY_TO = 'function evictCanonicalDuplicates(';
const keyFrom = SERVER.indexOf(KEY_FROM);
const keyTo = SERVER.indexOf(KEY_TO, keyFrom + 1);
if (keyFrom < 0 || keyTo < 0) {
  console.error(`\nFAIL — cannot locate canonicalPodKey in server.ts (from=${keyFrom}, to=${keyTo}).`);
  console.error('  If it was renamed or moved, §1 is testing nothing. Re-anchor it.');
  process.exit(1);
}

const tmpDir = mkdtempSync(join(tmpdir(), 'same-pod-'));
const tmpModule = join(tmpDir, 'canonical-pod-key-extracted.ts');
let canonicalPodKey: (url: string) => string;
let setStoreOrigins: (origins: readonly string[]) => void;
try {
  writeFileSync(
    tmpModule,
    'const STORE_ORIGINS = new Set<string>();\n'
    + 'export function setStoreOrigins(origins: readonly string[]): void {\n'
    + '  STORE_ORIGINS.clear();\n'
    + '  for (const o of origins) STORE_ORIGINS.add(o);\n'
    + '}\n'
    + SERVER.slice(keyFrom, keyTo)
    + '\nexport { canonicalPodKey };\n',
    'utf8',
  );
  const mod = await import(pathToFileURL(tmpModule).href) as {
    canonicalPodKey: (url: string) => string;
    setStoreOrigins: (origins: readonly string[]) => void;
  };
  canonicalPodKey = mod.canonicalPodKey;
  setStoreOrigins = mod.setStoreOrigins;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * The rule, restated. Written from the SENTENCE the declaration states — "this deployment's
 * store is one bucket however it is spelled, every other origin is its own, and the path is
 * compared as written" — and deliberately NOT from the shipped body, so that agreement between
 * the two is evidence about the rule rather than a transcription of the code.
 */
function sameByRule(a: string, b: string, storeOrigins: readonly string[]): boolean {
  const parse = (u: string): { origin: string; path: string } | undefined => {
    try {
      const x = new URL(u);
      if (x.origin === 'null' || x.origin === '') return undefined;
      return { origin: x.origin, path: x.pathname.endsWith('/') ? x.pathname : `${x.pathname}/` };
    } catch { return undefined; }
  };
  const pa = parse(a); const pb = parse(b);
  if (!pa || !pb) return a === b;
  if (pa.path !== pb.path) return false;
  const aStore = storeOrigins.includes(pa.origin);
  const bStore = storeOrigins.includes(pb.origin);
  return aStore && bStore ? true : pa.origin === pb.origin;
}

console.log('\n1. the comparator: what it calls one pod, and what it refuses to');
{
  const CSSF = 'http://css.fixture.internal:3456/';
  const FIXTURE_ORIGINS = [new URL(CSSF).origin, new URL(PUB).origin];
  setStoreOrigins(FIXTURE_ORIGINS);
  const same = (a: string, b: string): boolean => canonicalPodKey(a) === canonicalPodKey(b);

  // 1a. WHAT MUST STILL COLLAPSE. This is the whole reason the key exists; a fix that broke it
  // would refuse an honest owner their own row, their own inbox and their own activity field.
  check('§1a the internal and the gate spelling of one pod are ONE pod',
    same(`${CSSF}${VICTIM}/`, `${PUB}${VICTIM}/`),
    `${canonicalPodKey(`${CSSF}${VICTIM}/`)} vs ${canonicalPodKey(`${PUB}${VICTIM}/`)}`);
  check('§1a …and a missing trailing slash is still the same pod',
    same(`${CSSF}${VICTIM}`, `${CSSF}${VICTIM}/`));
  check('§1a …and so is a case-variant HOST, which URL normalises for us',
    same('http://CSS.Fixture.Internal:3456/u-eth-aaaa11112222/', `${CSSF}${VICTIM}/`));

  // 1b. ★★ WHAT MUST NOT. Each of these WAS equal to the victim's key before this change.
  check('§1b ★★ a foreign origin spelling the victim\'s path is NOT the victim',
    !same(`${PLANT_ORIGIN}/${VICTIM}/`, `${CSSF}${VICTIM}/`),
    canonicalPodKey(`${PLANT_ORIGIN}/${VICTIM}/`));
  check('§1b ★★ a CASE VARIANT of the victim\'s path on this very store is NOT the victim',
    !same(`${CSSF}U-ETH-AAAA11112222/`, `${CSSF}${VICTIM}/`),
    canonicalPodKey(`${CSSF}U-ETH-AAAA11112222/`));
  check('§1b two DIFFERENT foreign origins sharing a path are not each other',
    !same(`https://a.example/${VICTIM}/`, `https://b.example/${VICTIM}/`));
  check('§1b …while one foreign row is still equal to itself, slash and host-case aside',
    same(`${PLANT_ORIGIN}/${VICTIM}`, `${PLANT_ORIGIN.toUpperCase().replace('HTTPS', 'https')}/${VICTIM}/`),
    `${canonicalPodKey(`${PLANT_ORIGIN}/${VICTIM}`)} vs ${canonicalPodKey(`${PLANT_ORIGIN}/${VICTIM}/`)}`);
  // An OPAQUE origin: every non-special scheme reports `origin === 'null'`, so pasting the
  // origin in unguarded would put every one of them in a single bucket.
  check('§1b a non-special scheme does not collapse into one "null-origin" bucket',
    !same(`foo://a/${VICTIM}/`, `bar://b/${VICTIM}/`),
    `${canonicalPodKey(`foo://a/${VICTIM}/`)} vs ${canonicalPodKey(`bar://b/${VICTIM}/`)}`);
  check('§1b an unparseable target is only ever equal to itself',
    same('not a url', 'not a url') && !same('not a url', `${CSSF}not a url/`));

  // ★ AND THE BRANCHES CANNOT FORGE EACH OTHER'S KEYS. A comparator whose branches collide is
  // the same defect one level down, so this is asked as a property over the whole corpus rather
  // than as three spot checks: key equality must imply the RULE, in both directions.
  const corpus: string[] = [
    `${CSSF}${VICTIM}/`, `${CSSF}${VICTIM}`, `${PUB}${VICTIM}/`, `${CSSF}U-ETH-AAAA11112222/`,
    `${PLANT_ORIGIN}/${VICTIM}/`, `${PLANT_ORIGIN}/${VICTIM}`, `https://a.example/${VICTIM}/`,
    `${CSSF}${SENDER}/`, `${PUB}${SENDER}/`, `${PLANT_ORIGIN}/${SENDER}/`,
    `${CSSF}team/${VICTIM}/`, `${CSSF}${VICTIM}/inbox/`, `${CSSF}`, `${PUB}`,
    // Deliberately shaped to spell another branch's key: `store|/x/`, `origin|…`, `raw|…` are
    // the three prefixes, so here they are as paths and as whole inputs.
    `${CSSF}store%7C/`, `${PLANT_ORIGIN}/origin%7C/`, 'store|/u-eth-aaaa11112222/',
    `origin|${PLANT_ORIGIN}|/${VICTIM}/`, `raw|${CSSF}${VICTIM}/`, 'not a url',
    'not a url either', `foo://a/${VICTIM}/`, `bar://b/${VICTIM}/`, `foo://a/${VICTIM}/`,
  ];
  let mismatches = 0;
  let firstMismatch = '';
  for (const a of corpus) {
    for (const b of corpus) {
      const byKey = canonicalPodKey(a) === canonicalPodKey(b);
      const byRule = sameByRule(a, b, FIXTURE_ORIGINS);
      if (byKey !== byRule) {
        mismatches++;
        if (!firstMismatch) firstMismatch = `${a} vs ${b}: key=${byKey} rule=${byRule}`;
      }
    }
  }
  check(`§1b ★ the shipped key agrees with the stated rule on all ${corpus.length ** 2} pairs`,
    mismatches === 0, `${mismatches} mismatch(es); first: ${firstMismatch}`);

  // 1c. ★★ THE LIVE STORE, REPLAYED. Real urls, read off the production federation container on
  // 2026-08-29 — the four collision pairs it actually contains, its two genuinely foreign rows,
  // and two ordinary rows. Old key (lower-cased pathname, no origin) and new key must produce
  // the SAME partition, or this change would have altered the live directory.
  setStoreOrigins(['http://css.railway.internal:3456', 'https://gate.interego.xwisee.com']);
  const LIVE = [
    'https://gate.interego.xwisee.com/eth-da3ff679995e/', 'http://css.railway.internal:3456/eth-da3ff679995e/',
    'https://gate.interego.xwisee.com/eth-d810ca75aad4/', 'http://css.railway.internal:3456/eth-d810ca75aad4/',
    'https://gate.interego.xwisee.com/eth-f7721d529996/', 'http://css.railway.internal:3456/eth-f7721d529996/',
    'https://gate.interego.xwisee.com/eth-28b39aa5be86/', 'http://css.railway.internal:3456/eth-28b39aa5be86/',
    'https://foxxi-bridge.interego.xwisee.com/', 'https://10-0-0-5.nip.io/x/',
    'http://css.railway.internal:3456/u-eth-053ad15f9633/', 'http://css.railway.internal:3456/eth-8f3b8e939600/',
  ];
  const oldKey = (u: string): string => {
    try { const x = new URL(u); const p = x.pathname; return (p.endsWith('/') ? p : `${p}/`).toLowerCase(); }
    catch { return u.toLowerCase(); }
  };
  const buckets = (f: (u: string) => string): string[][] => {
    const m = new Map<string, string[]>();
    for (const u of LIVE) m.set(f(u), [...(m.get(f(u)) ?? []), u]);
    return [...m.values()].map(v => [...v].sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));
  };
  check('§1c ★★ the live rows partition identically under the old key and the new one',
    JSON.stringify(buckets(oldKey)) === JSON.stringify(buckets(canonicalPodKey)),
    `${JSON.stringify(buckets(canonicalPodKey))}`);
  check('§1c …and non-vacuously: the four real gate/internal pairs DO still collapse',
    buckets(canonicalPodKey).filter(b => b.length === 2).length === 4,
    JSON.stringify(buckets(canonicalPodKey).map(b => b.length)));
  check('§1c …while the two genuinely foreign live rows stay alone',
    canonicalPodKey('https://10-0-0-5.nip.io/x/') !== canonicalPodKey('http://css.railway.internal:3456/x/'),
    canonicalPodKey('https://10-0-0-5.nip.io/x/'));
}

// ── The driven harness ───────────────────────────────────────────────────────
//
// One fixture pod, one fixture identity server, one real relay child process. The pod records
// EVERY request by method and by BOTH spellings of its path, and it holds the persisted
// federation files — so §2 and §3 can ask where the bytes went and which files survived, rather
// than asking a receipt whether it was happy.

interface SeedRow {
  url: string; via: string; owner?: string; label?: string; did?: string; webId?: string;
  inbox?: string; handle?: string; surface?: string;
  channels?: Array<{ type: string; value: string }>;
}

interface PodFixture {
  /** decoded path -> body. The federation entry files live under `/svc-relay-dcr/federation/`. */
  readonly stored: Map<string, string>;
  /** every request, by METHOD and by BOTH spellings of its path. The evidence for §3. */
  readonly requests: Array<{ method: string; raw: string; decoded: string }>;
  /** decoded path -> ms to stall a GET, which is how §2 chooses the hydration ORDER. */
  readonly delays: Map<string, number>;
}

const FED_DIR = '/svc-relay-dcr/federation/';
const fedPath = (url: string): string => `${FED_DIR}${sha256Hex(url)}.jsonld`;

function seedBody(row: SeedRow): string {
  return JSON.stringify({
    '@context': { relay: 'https://relay.interego.xwisee.com/ns/relay#' },
    '@id': `urn:federation:${sha256Hex(row.url)}`,
    '@type': 'relay:FederationEntry',
    addedAt: '2026-08-01T00:00:00.000Z',
    ...row,
  });
}

interface Booted {
  readonly base: string;
  readonly cssUrl: string;
  readonly pod: PodFixture;
  readonly rows: ReadonlyArray<SeedRow>;
  callTool(tool: string, token: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  status(): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

/**
 * Boot the real relay against a fixture pod pre-seeded with federation files.
 *
 * ★ `makeSeed` TAKES THE STORE BASE URL, because the fixture store's own origin is only known
 * once it is listening — and a row that names this store must name THIS one. The pod is started
 * first, the files are written into it, and only then is the relay spawned, so hydration sees a
 * store already in the state the section is about.
 *
 * ★ `makeDelays` STALLS THE FIXTURE'S OWN GET of a named file, which is what makes the hydration
 * ORDER a controlled variable rather than a race. `loadEntries` reads the container listing and
 * then fetches the files with bounded concurrency, inserting each into `knownPods` AS IT ARRIVES
 * — so a suite that seeded and hoped would be testing whichever order the machine produced, and
 * §2's defect is an ordering defect.
 */
async function bootRelay(
  makeSeed: (cssBase: string) => SeedRow[],
  makeDelays: (rows: ReadonlyArray<SeedRow>) => Map<string, number> = () => new Map(),
): Promise<Booted> {
  const IDENTITIES: Record<string, { userId: string; agentId: string }> = {
    'token-sender': { userId: SENDER, agentId: ATTACKER_DID },
    'token-victim': { userId: VICTIM, agentId: VICTIM_DID },
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

  const pod: PodFixture = { stored: new Map(), requests: [], delays: new Map() };
  const podApp = express();
  podApp.use(express.text({ type: () => true, limit: '4mb' }));
  podApp.use(async (q, s) => {
    const raw = q.path;
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* keep the raw spelling */ }
    pod.requests.push({ method: q.method, raw, decoded });

    if (q.method === 'PUT' || q.method === 'POST' || q.method === 'PATCH') {
      if (!decoded.endsWith('/')) pod.stored.set(decoded, typeof q.body === 'string' ? q.body : '');
      s.status(201).end();
      return;
    }
    if (q.method === 'DELETE') { pod.stored.delete(decoded); s.status(205).end(); return; }

    // The federation container, as LDP turtle, in the order the files were seeded. This is what
    // `loadEntries` walks; its regex picks the relative `<hash.jsonld>` names out of it.
    if (decoded === FED_DIR) {
      const kids = [...pod.stored.keys()]
        .filter(k => k.startsWith(FED_DIR) && k !== FED_DIR)
        .map(k => k.slice(FED_DIR.length));
      const body = '@prefix ldp: <http://www.w3.org/ns/ldp#>.\n'
        + '<> a ldp:Container, ldp:BasicContainer, ldp:Resource.\n'
        + kids.map(k => `<${k}> a ldp:Resource.`).join('\n')
        + (kids.length > 0 ? `\n<> ldp:contains ${kids.map(k => `<${k}>`).join(', ')}.\n` : '\n');
      s.type('text/turtle').status(200).send(body);
      return;
    }

    const wait = pod.delays.get(decoded);
    if (wait !== undefined && wait > 0) await new Promise(r => { setTimeout(r, wait).unref(); });

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
    if (decoded.endsWith('/') && pod.stored.get(decoded) === undefined) {
      if (q.method === 'HEAD') { s.type('text/turtle').status(200).end(); return; }
      s.type('text/turtle').status(200).send('@prefix ldp: <http://www.w3.org/ns/ldp#>. <> a ldp:Container, ldp:BasicContainer, ldp:Resource.');
      return;
    }
    const hit = pod.stored.get(decoded);
    if (hit === undefined) { s.status(404).end(); return; }
    if (q.method === 'HEAD') { s.type('text/turtle').status(200).end(); return; }
    s.type(decoded.endsWith('.jsonld') ? 'application/ld+json' : 'text/turtle').status(200).send(hit);
  });

  const identity = await listenLoopback(identityApp);
  const podSrv = await listenLoopback(podApp);
  const cssUrl = `${podSrv.base}/`;

  const rows = makeSeed(cssUrl);
  for (const row of rows) pod.stored.set(fedPath(row.url), seedBody(row));
  for (const [k, v] of makeDelays(rows)) pod.delays.set(k, v);

  const probe = createServer();
  await new Promise<void>(r => { probe.listen(0, '127.0.0.1', () => r()); });
  const relayPort = (probe.address() as AddressInfo).port;
  await new Promise<void>(r => { probe.close(() => r()); });
  const base = `http://127.0.0.1:${relayPort}`;
  // Never the production default `/app/relay-agent-key.json`: a suite must not write a
  // long-lived private key into a path it does not own.
  const keyFile = join(tmpdir(), `same-pod-key-${process.pid}-${relayPort}.json`);

  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: join(here, '..'),
    env: {
      ...process.env,
      PORT: String(relayPort),
      CSS_URL: cssUrl,
      CSS_PUBLIC_URL: PUB,
      IDENTITY_URL: identity.base,
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

  const booted: Booted = {
    base,
    cssUrl,
    pod,
    rows,
    async callTool(tool, token, args) {
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
    },
    async status() {
      try {
        const r = await fetch(`${base}/relay/federation-status`, { signal: AbortSignal.timeout(5_000) });
        return await r.json() as Record<string, unknown>;
      } catch { return {}; }
    },
    async stop() {
      child.kill();
      process.removeListener('exit', killChild);
      await identity.close();
      await podSrv.close();
      rmSync(keyFile, { force: true });
    },
  };

  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    await new Promise(r => { setTimeout(r, 250).unref(); });
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
      up = r.ok || r.status === 404;
    } catch { /* still booting */ }
  }
  check('the relay boots against the fixtures and answers /health', up,
    `${base} — child stderr tail: ${childErr || '(none)'}`);
  // ★ WAIT FOR THE HYDRATE TO FINISH rather than for a fixed sleep. `list_known_pods` gives
  // hydration a 50 ms budget and then answers with whatever has landed, so a listing taken too
  // early would describe a partly-loaded directory — a different fact from the one this suite is
  // about, and one that could make either ordering "pass".
  for (let i = 0; i < 200; i++) {
    const st = await booted.status();
    if (st['hydrateSourceCount'] === rows.length) break;
    await new Promise(r => { setTimeout(r, 100).unref(); });
  }
  const st = await booted.status();
  check(`the fixture's ${rows.length} seeded federation files all hydrated`,
    st['hydrateSourceCount'] === rows.length, JSON.stringify(st));
  return booted;
}

/** Poll until `want` holds, so no assertion below races a fire-and-forget persist. */
async function until(want: () => boolean, ms = 8_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (want()) return true;
    await new Promise(r => { setTimeout(r, 50).unref(); });
  }
  return want();
}

// ── §2 DRIVEN: THE LISTING, IN BOTH HYDRATION ORDERINGS ──────────────────────
//
// ★★ BOTH ORDERINGS, because the de-dup keeps the FIRST insertion and the report was specifically
// that hydrating the PLANT first is what hides the victim. A suite that drove only the ordering
// this machine happens to produce would have been green on the broken code half the time — the
// "a check that passes two ways" shape this project keeps finding.
console.log('\n2. driven: a planted foreign row cannot hide the victim, in EITHER hydration order');
for (const plantFirst of [true, false] as const) {
  const label = plantFirst ? 'plant-first' : 'victim-first';
  console.log(`\n  — ${label}`);
  const plantUrl = `${PLANT_ORIGIN}/${VICTIM}/`;
  let booted: Booted | undefined;
  try {
    booted = await bootRelay(
      (css) => {
        const victimRow: SeedRow = {
          url: `${css}${VICTIM}/`, via: 'auto', owner: VICTIM_DID, did: VICTIM_DID,
          webId: VICTIM_DID, surface: 'victim', handle: `acct:${VICTIM}@relay.fixture`,
          inbox: `${css}${VICTIM}/inbox/`, label: 'the victim',
        };
        const plantRow: SeedRow = {
          url: plantUrl, via: 'manual', owner: ATTACKER_DID, label: 'not the victim',
        };
        return plantFirst ? [plantRow, victimRow] : [victimRow, plantRow];
      },
      // The SECOND seeded row's GET is stalled, so the first one always wins the insertion race.
      (seeded) => new Map([[fedPath(seeded[1]!.url), 700]]),
    );
    const { cssUrl, callTool, pod } = booted;
    const victimUrl = `${cssUrl}${VICTIM}/`;

    // A THIRD PARTY reads the directory — not the victim, not the planter. "Who is here" is the
    // question this directory exists to answer, and the answer is what was corrupted.
    const dir = await callTool('list_known_pods', 'token-sender', {});
    const listed = (dir['pods'] ?? []) as Array<Record<string, unknown>>;
    const urls = listed.map(r => String(r['url']));
    const victimListed = listed.find(r => String(r['url']) === victimUrl);
    const plantListed = listed.find(r => String(r['url']) === plantUrl);

    check(`§2 ${label} ★★ the victim's own row is listed at all`,
      victimListed !== undefined, JSON.stringify(urls).slice(0, 400));
    // ★ NOT "a row with that path is present" — WHICH row, and WHAT IT SAYS. The defect
    // presented as a row being there; it was the planter's row wearing the victim's path.
    check(`§2 ${label} ★★ …and it is the VICTIM's row: their DID, not the planter's claim`,
      victimListed?.['did'] === VICTIM_DID
      && victimListed?.['owner'] === VICTIM_DID
      && victimListed?.['identifiedBy'] !== 'nothing',
      JSON.stringify(victimListed ?? '(absent)').slice(0, 400));
    check(`§2 ${label} …and it carries exactly one followable notify affordance`,
      Array.isArray(victimListed?.['affordances'])
      && (victimListed!['affordances'] as unknown[]).length === 1,
      JSON.stringify(victimListed?.['affordances'] ?? '(none)').slice(0, 300));
    // The plant may be listed — it is a real, if useless, federation row — but it must be PLAINLY
    // ITSELF: its own foreign url, no DERIVED identity, and no minted address.
    //
    // ★ `identifiedBy` IS ALLOWED TO BE "unverified owner claim" AND THAT IS THE POINT, not a
    // hole. The planter wrote a DID into the free-text `owner` field, so the row does carry a
    // name — and the shipped projection reports it as `claimedAgent`/`claimedSurface` under
    // `identifiedBy: "unverified owner claim"`, never as `did`. What must never happen is the
    // row being reported the way an IDENTIFIED row is; asserted here as the disjunction of the
    // two non-evidence verdicts rather than as one of them, because narrowing it to "nothing"
    // was this check's first spelling and it failed on the shipped, correct behaviour.
    const NOT_EVIDENCE = ['nothing', 'unverified owner claim'];
    check(`§2 ${label} the planted row, if listed, is plainly itself and carries no affordance`,
      plantListed === undefined
      || (!('affordances' in plantListed)
        && plantListed['did'] === undefined
        && plantListed['webId'] === undefined
        && NOT_EVIDENCE.includes(String(plantListed['identifiedBy']))),
      JSON.stringify(plantListed ?? '(not listed)').slice(0, 400));
    check(`§2 ${label} ★ …and a claimed name is reported as a CLAIM, never as the row's identity`,
      plantListed === undefined
      || plantListed['identifiedBy'] !== 'unverified owner claim'
      || (plantListed['claimedAgent'] === 'attacker-u-eth-ffff99990000'
        && typeof plantListed['claimNote'] === 'string'),
      JSON.stringify(plantListed ?? '(not listed)').slice(0, 400));
    check(`§2 ${label} ★ neither row was swallowed: both are present and distinguishable`,
      urls.filter(u => u.endsWith(`/${VICTIM}/`)).length === 2,
      JSON.stringify(urls.filter(u => u.endsWith(`/${VICTIM}/`))));

    // ★★ AND WHERE THE BYTES GO, asked separately from what the listing says.
    // `resolveTargetPodUrl` scans `knownPods` itself, so plant-first is exactly the ordering in
    // which it could find the plant first too. The answer is the recorded WRITE PATH.
    const inboxKeys = (): string[] =>
      [...pod.stored.keys()].filter(k => k.startsWith(`/${VICTIM}/inbox/`));
    const before = inboxKeys().length;
    const sent = await callTool('notify_agent', 'token-sender',
      { to: VICTIM, summary: `a probe in the ${label} ordering` });
    const wrote = await until(() => inboxKeys().length === before + 1);
    check(`§2 ${label} ★★ a notification addressed to the victim lands in THEIR inbox`,
      wrote, `${JSON.stringify(inboxKeys())} — receipt ${JSON.stringify(sent).slice(0, 240)}`);
    check(`§2 ${label} …and nothing was written under the plant's own path`,
      [...pod.stored.keys()].filter(k => k.startsWith('/elsewhere')).length === 0,
      JSON.stringify([...pod.stored.keys()].slice(0, 40)));
    check(`§2 ${label} …and the receipt names the victim, not the planter`,
      String(sent['resolvedTo'] ?? '').includes('victim')
      && !String(sent['resolvedTo'] ?? '').includes('attacker'),
      JSON.stringify(sent['resolvedTo']));
  } finally {
    await booted?.stop();
  }
}

// ── §3 DRIVEN: EVICTION, ASSERTED ON THE PERSISTED FILES ─────────────────────
//
// ★★ ON THE FILES, NOT ON THE MAP. `evictCanonicalDuplicates` deletes the loser's persisted
// federation file as well as its map entry, and that is the half a restart does not undo — so an
// in-memory assertion would be checking the recoverable half of a destructive operation.
console.log('\n3. driven: eviction deletes only real duplicates — asserted on the PERSISTED FILES');
{
  const gateDup = `${PUB}${VICTIM}/`;                   // the SAME pod, this store's other spelling
  const foreign = `${PLANT_ORIGIN}/${VICTIM}/`;         // a different thing that shares the path
  let booted: Booted | undefined;
  let caseVariant = '';
  try {
    booted = await bootRelay((css) => {
      caseVariant = `${css}U-ETH-AAAA11112222/`;        // a different container, same letters
      return [
        { url: gateDup, via: 'manual', owner: VICTIM_DID, label: 'the gate spelling' },
        { url: foreign, via: 'manual', owner: ATTACKER_DID, label: 'not the victim' },
        { url: caseVariant, via: 'manual', owner: ATTACKER_DID, label: 'also not the victim' },
      ];
    });
    const { pod, callTool, cssUrl } = booted;
    const victimUrl = `${cssUrl}${VICTIM}/`;
    const has = (u: string): boolean => pod.stored.has(fedPath(u));
    const fedFiles = (): string[] => [...pod.stored.keys()].filter(k => k.startsWith(FED_DIR));
    check('§3 all three seeded federation files are present before the trigger',
      has(gateDup) && has(foreign) && has(caseVariant), JSON.stringify(fedFiles()));

    // THE TRIGGER is simply that the victim authenticates: the tool-dispatch identity hook calls
    // `autoRegisterAgentCard`, which writes their row and then evicts everything it considers
    // the same pod — from memory AND from the pod.
    await callTool('read_inbox', 'token-victim', {});
    await until(() => has(victimUrl) && !has(gateDup));

    // ★ NON-VACUOUS FIRST: the de-dup must still do its job, destructively, as designed. Without
    // this line every assertion below would also pass on an eviction that had stopped working.
    check('§3 the genuine gate-spelling duplicate IS evicted, file and all',
      has(victimUrl) && !has(gateDup),
      `victimFile=${has(victimUrl)} gateDupFile=${has(gateDup)}`);
    const deletes = pod.requests.filter(r => r.method === 'DELETE');
    check('§3 …and the DELETE went to that file, on both spellings of its path',
      deletes.some(r => r.raw === fedPath(gateDup) && r.decoded === fedPath(gateDup)),
      JSON.stringify(deletes.map(r => r.raw)));

    // ★★ AND THE TWO THAT ARE NOT THE VICTIM'S POD SURVIVE — the point of the whole unit. Before
    // this change both keyed identically to the victim's row and both files were deleted here.
    check('§3 ★★ the foreign-origin row\'s persisted file is NOT deleted',
      has(foreign), JSON.stringify(fedFiles()));
    check('§3 ★★ the case-variant row\'s persisted file is NOT deleted',
      has(caseVariant), JSON.stringify(fedFiles()));
    check('§3 …and no DELETE was ever issued for either, on any spelling of the path',
      !deletes.some(r => [r.raw, r.decoded].some(
        p => p === fedPath(foreign) || p === fedPath(caseVariant))),
      JSON.stringify(deletes.map(r => r.raw)));
    check('§3 exactly one federation file was deleted in the whole run',
      deletes.filter(r => r.decoded.startsWith(FED_DIR)).length === 1,
      JSON.stringify(deletes.map(r => r.decoded)));

    // And the directory agrees with the files: both survivors are still listed, the duplicate is
    // gone, and the victim's own row is the one carrying their identity.
    const dir = await callTool('list_known_pods', 'token-sender', {});
    const urls = ((dir['pods'] ?? []) as Array<Record<string, unknown>>).map(r => String(r['url']));
    check('§3 the listing agrees with the files: survivors listed, duplicate gone',
      urls.includes(foreign) && urls.includes(caseVariant)
      && urls.includes(victimUrl) && !urls.includes(gateDup),
      JSON.stringify(urls).slice(0, 400));
  } finally {
    await booted?.stop();
  }
}

console.log(failures === 0 ? '\nPASS\n' : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
