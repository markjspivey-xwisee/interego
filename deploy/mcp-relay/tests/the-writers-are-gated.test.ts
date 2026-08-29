#!/usr/bin/env tsx
/**
 * The relay writes with a root-equivalent credential. Two questions decide where those bytes go,
 * and both used to be answered by the caller.
 *
 * ── §1 WHOSE STORE — `toInternalPodUrl` DISCARDED THE HOST ───────────────────────────────────
 *
 * The body was `${CSS_URL}${new URL(url).pathname}`: it did not answer "the same pod, spelled
 * internally", it answered "our store, at whatever path you named". It now returns `undefined`
 * for anything that is not on a `STORE_ORIGINS` member.
 *
 * ★★ AND `tsc` DOES NOT ENFORCE THAT SIGNATURE HERE, WHICH IS THE WHOLE REASON §0 EXISTS. This
 * package compiles with `strict: false`, so `strictNullChecks` is off and `string | undefined`
 * assigns into `string` silently. MEASURED WITH A CONTROL rather than assumed: inserting
 * `const x: string = toInternalPodUrl('https://x.example/y/');` into server.ts left
 * `tsc --noEmit -p tsconfig.json` at EXIT=0. An unguarded call site would therefore compile
 * clean and then interpolate the string "undefined" into a URL and fetch it. So the obligation
 * "every caller refuses undefined" is carried by §0, a source census, and not by the type.
 *
 * ★ AND THE FOUR CALLERS THE OLD COMMENT SAID "each still needs its own origin-aware gate" ALL
 * ALREADY HAD ONE — measured before this change, over the wire, and re-measured in §2 after it.
 * `read_inbox` and `rebuild_manifest` are gated by `canonicalPodKey`, which stopped being
 * path-only; the two `/agents/:localPart` routes reach the helper through
 * `cardForLocalPart` -> `agentAddressOwners`, whose first conjunct is `isStoreOriginUrl`. That is
 * why this change is a REFACTOR OF A LATENT HAZARD and not a live-vulnerability close, and saying
 * so is the point: an obligation written in a comment is the shape that produced this file's
 * recurring defect of a gate in front of one of three readers.
 *
 * ── §3 WHOSE POD — A DELIVERY MANUFACTURED ITS OWN DESTINATION ───────────────────────────────
 *
 * CSS auto-creates a container on first PUT, and the LDN write is a PUT to
 * `<pod>/inbox/<slug>.jsonld`. So `notify_agent { to: "<store>/nosuchpod/" }` created
 * `<store>/nosuchpod/inbox/` on the relay's credential and answered `delivered: true,
 * canonicalInbox: true`. DRIVEN before the fix on this same harness: the fixture store recorded
 * exactly one request, `PUT /nosuchpod/inbox/<slug>.jsonld`, and the receipt said delivered. Same
 * for the bare-id route with `to: "u-eth-000000000000"`.
 *
 * `notify_agent` now HEADs the pod ROOT first. 404/410 refuse; EVERY OTHER ANSWER — 2xx, 401,
 * 403, 405, 5xx, a network failure — is `'unknown'` and delivers exactly as before, which is what
 * makes this safe to ship without being able to drive every CSS configuration: the only way to
 * produce a false refusal is for the store to 404 a container it holds.
 *
 * ★ WHAT THE LIVE STORE ACTUALLY DOES WAS MEASURED, NOT INFERRED FROM THIS FIXTURE — a double
 * standing in for a dependency cannot tell you what the dependency does. Unauthenticated, against
 * the live deployment on 2026-08-29: `HEAD https://gate.interego.xwisee.com/eth-8f3b8e939600/`
 * -> 200 with `Accept-Post`, `.../u-eth-053ad15f9633/` -> 200, and
 * `.../definitely-not-a-pod-xyz9/` -> 404 with `Accept-Put` — the 404 advertising the
 * create-on-PUT affordance this defect rode. GET agrees with HEAD on all three. Nine timed runs
 * of the 200 case: 0.308-0.378 s wall, median 0.337 s, each a fresh public-internet TLS handshake
 * — an UPPER BOUND on a probe the relay makes in-cluster over a pooled connection, not the
 * production figure.
 *
 * ── §4 WHAT THIS PASS LEFT OPEN, AND WHERE IT WAS CLOSED ─────────────────────────────────────
 *
 * `add_pod` is UNCHANGED, deliberately — see its own note. This pass left two things open and
 * recorded them rather than pretending otherwise: a store-origin row for a pod that has never
 * existed still got a WebFinger JRD, an ActivityPub actor and an outbox from this relay's own
 * domain (`add_pod { pod_url: "<store>/no-such-pod-at-all/" }` then
 * `GET /agents/no-such-pod-at-all` -> 200), and `POST /agents/:localPart/inbox` reached
 * `deliverNotification` with no existence probe, so under `RELAY_FEDERATION_ACCEPT_UNSIGNED=1`
 * it would manufacture a container for a ghost row.
 *
 * BOTH ARE NOW CLOSED, in tests/an-identity-needs-a-pod.test.ts, exactly where this paragraph
 * said they belonged: one memoised probe inside `cardForLocalPart` — the reader all four
 * /agents-family routes share, so it is not a gate in front of one of them — plus a refusal
 * inside `deliverNotification` itself, the function that owns the PUT and has two callers.
 * Which rule to gate on was decided by censusing the live directory (identity would have 404'd
 * 83 real pods and kept publishing 37 dead ones; existence 404s the 39 with no container and
 * nothing touched in the last 14 days); that file carries the numbers.
 *
 * ── WITH WHICH INSTRUMENT ────────────────────────────────────────────────────────────────────
 *
 * §0 reads server.ts and censuses its call sites, after `stripComments`, so a call named in prose
 * is not mistaken for a call. §1 executes the SHIPPED characters: `server.ts` calls `app.listen()`
 * at module scope and cannot be imported, so the declaration is sliced out by source anchors into
 * a temp module with `STORE_ORIGINS` and `CSS_URL` injected — the instrument
 * same-pod-means-same-pod / follow-the-directory / notify-target-collapse already use — and its
 * answers are compared against a reference written from the STATED RULE. §2 and §3 BOOT THE REAL
 * RELAY against a fixture store that records every request by METHOD and by BOTH the raw and the
 * decoded path, and assert on those recordings and on which files exist — never on a receipt
 * alone, because a receipt is exactly what could not see either of these defects.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/the-writers-are-gated.test.ts
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
import { stripComments } from './strip-comments.js';

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
const PUB = 'https://gate.fixture.example';
const VICTIM = 'u-eth-aaaa11112222';
const SENDER = 'u-eth-ffff99990000';
const VICTIM_DID = `did:web:identity.test:agents:victim-${VICTIM}`;
const SENDER_DID = `did:web:identity.test:agents:sender-${SENDER}`;
const FOREIGN = 'https://elsewhere.example';
/** A pod that has never existed on this store. */
const GHOST = 'nosuchpod';
/** A pod whose root the store answers 500 for — the "this relay does not know" case. */
const FLAKY = 'flakypod';

// ── §0 THE CALL-SITE CENSUS ──────────────────────────────────────────────────
//
// ★★ THE OBLIGATION THE TYPE CANNOT CARRY. `strict: false` means an unguarded caller compiles.
// So: every call of `toInternalPodUrl` in server.ts, outside its own declaration, must BIND the
// result and REFUSE `undefined` before that binding is used. This is the check that fails when a
// sixth caller lands, which is precisely what the previous comment could only ask for in prose.
console.log('\n0. every caller of toInternalPodUrl binds its result and refuses undefined');
{
  const code = stripComments(SERVER, 'server.ts');
  const declAt = code.indexOf('function toInternalPodUrl(url: string)');
  check('§0 the declaration is found, so the census is not vacuous', declAt > -1, String(declAt));
  const declEnd = code.indexOf('\n}\n', declAt);

  const sites: Array<{ index: number; line: string }> = [];
  for (let at = code.indexOf('toInternalPodUrl('); at !== -1; at = code.indexOf('toInternalPodUrl(', at + 1)) {
    if (at >= declAt && at <= declEnd) continue;      // the declaration itself
    const lineStart = code.lastIndexOf('\n', at) + 1;
    const lineEnd = code.indexOf('\n', at);
    sites.push({ index: at, line: code.slice(lineStart, lineEnd < 0 ? code.length : lineEnd) });
  }
  // A zero result must FAIL this check rather than satisfy it: a census that found nothing is a
  // census that is testing nothing, and the whole point of §0 is to notice a NEW caller.
  // ★ SIX SINCE tests/an-identity-needs-a-pod.test.ts: `cardForLocalPart` now folds the card's
  // pod url itself, to probe the store for the pod ROOT before publishing an identity for it.
  // The number is raised only when a new caller is READ and found to refuse `undefined` — the
  // count is the trigger for that reading, never a thing to make green.
  check(`§0 ★★ the census found call sites at all (found ${sites.length}, expected 6)`,
    sites.length === 6, sites.map(s => s.line.trim()).join(' | ').slice(0, 400));

  for (const site of sites) {
    const m = /const\s+([A-Za-z_$][\w$]*)\s*=\s*toInternalPodUrl\(/.exec(site.line);
    check(`§0 the call site binds its result: ${site.line.trim().slice(0, 80)}`,
      m !== null, site.line.trim());
    if (!m) continue;
    // The guard must be within the same statement neighbourhood, not "somewhere in the file".
    const window = code.slice(site.index, site.index + 600);
    check(`§0 ★ …and refuses undefined for \`${m[1]}\` before using it`,
      new RegExp(`${m[1]}\\s*===\\s*undefined`).test(window),
      window.split('\n').slice(0, 4).join(' / ').slice(0, 240));
  }
}

// ── §1 THE HELPER ITSELF, AS SHIPPED ─────────────────────────────────────────
//
// Sliced from its own declaration to `const RELAY_HANDLE_HOST`, with `STORE_ORIGINS` and
// `CSS_URL` injected as mutable bindings the section refills — so the same shipped body can be
// asked about the fixture deployment and about the production one without a second copy of it.
console.log('\n1. the shipped toInternalPodUrl, executed');
const FROM = 'function toInternalPodUrl(url: string)';
const TO = 'const RELAY_HANDLE_HOST';
const from = SERVER.indexOf(FROM);
const to = SERVER.indexOf(TO, from + 1);
if (from < 0 || to < 0) {
  console.error(`\nFAIL — cannot locate toInternalPodUrl in server.ts (from=${from}, to=${to}).`);
  console.error('  If it was renamed or moved, §1 is testing nothing. Re-anchor it.');
  process.exit(1);
}

const tmpDir = mkdtempSync(join(tmpdir(), 'writers-gated-'));
const tmpModule = join(tmpDir, 'to-internal-pod-url-extracted.ts');
let toInternalPodUrl: (url: string) => string | undefined;
let configure: (cssUrl: string, origins: readonly string[]) => void;
try {
  writeFileSync(
    tmpModule,
    'const STORE_ORIGINS = new Set<string>();\n'
    + 'let CSS_URL = "";\n'
    + 'export function configure(cssUrl: string, origins: readonly string[]): void {\n'
    + '  CSS_URL = cssUrl;\n'
    + '  STORE_ORIGINS.clear();\n'
    + '  for (const o of origins) STORE_ORIGINS.add(o);\n'
    + '}\n'
    + SERVER.slice(from, to)
    + '\nexport { toInternalPodUrl };\n',
    'utf8',
  );
  const mod = await import(pathToFileURL(tmpModule).href) as {
    toInternalPodUrl: (url: string) => string | undefined;
    configure: (cssUrl: string, origins: readonly string[]) => void;
  };
  toInternalPodUrl = mod.toInternalPodUrl;
  configure = mod.configure;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

{
  // Production's two spellings, as `deploy/railway/services.json` configures them.
  const INTERNAL = 'http://css.railway.internal:3456';
  const GATE = 'https://gate.interego.xwisee.com';
  configure(`${INTERNAL}/`, [INTERNAL, GATE]);

  /**
   * The rule, restated from the SENTENCE the declaration states — "a pod URL on one of this
   * deployment's store origins, mapped to the internal host with its path preserved exactly;
   * anything else is undefined" — and deliberately NOT transcribed from the shipped body, so
   * agreement between the two is evidence about the rule rather than an echo of the code.
   */
  const byRule = (url: string, cssUrl: string, origins: readonly string[]): string | undefined => {
    let u: URL;
    try { u = new URL(url); } catch { return undefined; }
    if (u.origin === 'null' || u.origin === '') return undefined;
    if (!origins.includes(u.origin)) return undefined;
    return cssUrl.replace(/\/$/, '') + u.pathname;
  };

  const CORPUS = [
    // ours, both spellings, the shapes that must keep working
    `${INTERNAL}/${VICTIM}/`, `${GATE}/${VICTIM}/`, `${GATE}/${VICTIM}/inbox/`,
    `${GATE}/${VICTIM}/profile/card#me`, `${GATE}/${VICTIM}`, `${INTERNAL}/`,
    `${GATE}/${VICTIM}/x%2Fy/`, `${GATE}/a/b/c/d/`,
    // not ours
    `${FOREIGN}/${VICTIM}/`, 'https://attacker.example/eth-abc/x.jose.json',
    // ★ THE PREFIX SHAPES that a `startsWith` origin test would have let through — the round-26
    // leak, asked of this function directly.
    'https://gate.interego.xwisee.com.attacker.example/x/',
    'https://gate.interego.xwisee.com:8443/x/', 'http://gate.interego.xwisee.com/x/',
    'https://notgate.interego.xwisee.com/x/', 'http://css.railway.internal:3457/x/',
    // ★ CASE: URL normalises scheme and host, so these ARE ours and must still fold.
    'HTTP://CSS.Railway.Internal:3456/u-eth-AAAA/', 'HTTPS://Gate.Interego.Xwisee.COM/x/',
    // opaque / unparseable
    'foo://a/x/', 'bar://b/x/', 'not a url at all', '', '/relative/path/', 'data:text/plain,x',
  ];
  let mismatches = 0;
  for (const u of CORPUS) {
    if (toInternalPodUrl(u) !== byRule(u, `${INTERNAL}/`, [INTERNAL, GATE])) {
      mismatches++;
      console.error(`    shipped=${String(toInternalPodUrl(u))} rule=${String(byRule(u, `${INTERNAL}/`, [INTERNAL, GATE]))} for ${u}`);
    }
  }
  check(`§1 ★★ shipped and reference agree over ${CORPUS.length} adversarial urls`,
    mismatches === 0, `${mismatches} mismatch(es)`);

  check('§1 both live spellings fold to the internal host, path preserved exactly',
    toInternalPodUrl(`${GATE}/${VICTIM}/inbox/`) === `${INTERNAL}/${VICTIM}/inbox/`
    && toInternalPodUrl(`${INTERNAL}/${VICTIM}/inbox/`) === `${INTERNAL}/${VICTIM}/inbox/`,
    String(toInternalPodUrl(`${GATE}/${VICTIM}/inbox/`)));
  check('§1 ★★ a foreign origin is undefined — not folded, and NOT handed back',
    toInternalPodUrl(`${FOREIGN}/${VICTIM}/`) === undefined,
    String(toInternalPodUrl(`${FOREIGN}/${VICTIM}/`)));
  check('§1 ★ a host that merely BEGINS with ours is undefined (the round-26 prefix leak)',
    toInternalPodUrl('https://gate.interego.xwisee.com.attacker.example/x/') === undefined,
    String(toInternalPodUrl('https://gate.interego.xwisee.com.attacker.example/x/')));
  check('§1 ★ a different port on our own host is a different origin',
    toInternalPodUrl('http://css.railway.internal:3457/x/') === undefined,
    String(toInternalPodUrl('http://css.railway.internal:3457/x/')));
  check('§1 an unparseable input is undefined rather than echoed',
    toInternalPodUrl('not a url at all') === undefined,
    String(toInternalPodUrl('not a url at all')));

  // ★ AND THE OPAQUE-ORIGIN GUARD IS NOT DECORATION: with a pathological CSS_URL whose origin is
  // `null`, every non-special-scheme url would otherwise be "this store".
  configure('foo://store/', ['null']);
  check('§1 ★★ an opaque origin never counts as this store, even if `null` reaches STORE_ORIGINS',
    toInternalPodUrl('bar://attacker/anything/') === undefined,
    String(toInternalPodUrl('bar://attacker/anything/')));
}

// ── The driven harness ───────────────────────────────────────────────────────
//
// One fixture pod, one fixture identity server, one real relay child process. The pod records
// EVERY request by method and by BOTH spellings of its path, and it models CONTAINER EXISTENCE
// (which the live store has and the older fixtures in this directory did not), so §3 can ask what
// happens to a pod that is not there.

interface SeedRow {
  url: string; via: string; owner?: string; label?: string; did?: string; webId?: string;
  inbox?: string; handle?: string; surface?: string;
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

interface PodFixture {
  readonly stored: Map<string, string>;
  readonly requests: Array<{ method: string; raw: string; decoded: string }>;
  /** Pod roots this store does NOT hold — the live store answers 404 for these. */
  readonly absent: Set<string>;
  /** Pod roots this store answers 500 for — "this relay cannot tell". */
  readonly erroring: Set<string>;
}

const EMPTY_CONTAINER = '@prefix ldp: <http://www.w3.org/ns/ldp#>. <> a ldp:Container, ldp:BasicContainer, ldp:Resource.';

interface Booted {
  readonly base: string;
  readonly cssUrl: string;
  readonly pod: PodFixture;
  callTool(tool: string, token: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  get(path: string): Promise<{ status: number; body: string }>;
  stop(): Promise<void>;
}

async function bootRelay(makeSeed: (cssBase: string) => SeedRow[]): Promise<Booted> {
  const IDENTITIES: Record<string, { userId: string; agentId: string }> = {
    'token-sender': { userId: SENDER, agentId: SENDER_DID },
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

  const pod: PodFixture = { stored: new Map(), requests: [], absent: new Set(), erroring: new Set() };
  const podApp = express();
  podApp.use(express.text({ type: () => true, limit: '4mb' }));
  podApp.use((q, s) => {
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

    if (decoded === FED_DIR) {
      const kids = [...pod.stored.keys()]
        .filter(k => k.startsWith(FED_DIR) && k !== FED_DIR)
        .map(k => k.slice(FED_DIR.length));
      s.type('text/turtle').status(200).send(
        '@prefix ldp: <http://www.w3.org/ns/ldp#>. <> a ldp:Container, ldp:BasicContainer, ldp:Resource. '
        + kids.map(k => `<${k}> a ldp:Resource.`).join(' ')
        + (kids.length > 0 ? ` <> ldp:contains ${kids.map(k => `<${k}>`).join(', ')}.` : ''),
      );
      return;
    }

    // ★★ CONTAINER EXISTENCE, MODELLED — the property §3 is about, and the one the older fixtures
    // in this directory did not have. The live store answers 200 for a pod root it holds and 404
    // for one it does not (measured; see the header). Membership is deliberately not modelled: an
    // empty container carries the same information to every reader here as a 404 did.
    if (decoded.endsWith('/')) {
      const podRoot = decoded.split('/').filter(Boolean)[0] ?? '';
      if (pod.erroring.has(podRoot)) { s.status(500).end(); return; }
      if (pod.absent.has(podRoot)) { s.status(404).end(); return; }
      if (q.method === 'HEAD') { s.type('text/turtle').status(200).end(); return; }
      s.type('text/turtle').status(200).send(EMPTY_CONTAINER);
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

  const probe = createServer();
  await new Promise<void>(r => { probe.listen(0, '127.0.0.1', () => r()); });
  const relayPort = (probe.address() as AddressInfo).port;
  await new Promise<void>(r => { probe.close(() => r()); });
  const base = `http://127.0.0.1:${relayPort}`;
  // Never the production default `/app/relay-agent-key.json`: a suite must not write a long-lived
  // private key into a path it does not own.
  const keyFile = join(tmpdir(), `writers-gated-key-${process.pid}-${relayPort}.json`);

  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: join(here, '..'),
    env: {
      ...process.env,
      PORT: String(relayPort),
      CSS_URL: cssUrl,
      CSS_PUBLIC_URL: `${PUB}/`,
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
    async get(path) {
      try {
        const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
        return { status: r.status, body: (await r.text()).slice(0, 600) };
      } catch (err) { return { status: 0, body: (err as Error).message }; }
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
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${base}/relay/federation-status`, { signal: AbortSignal.timeout(5_000) });
      const st = await r.json() as Record<string, unknown>;
      if (st['hydrateSourceCount'] === rows.length) break;
    } catch { /* still hydrating */ }
    await new Promise(r => { setTimeout(r, 100).unref(); });
  }
  return booted;
}

const seedTwoPods = (css: string): SeedRow[] => [
  {
    url: `${css}${VICTIM}/`, via: 'auto', owner: VICTIM_DID, did: VICTIM_DID, webId: VICTIM_DID,
    surface: 'victim', handle: `acct:${VICTIM}@relay.fixture`, inbox: `${css}${VICTIM}/inbox/`,
    label: 'the victim',
  },
  {
    url: `${css}${SENDER}/`, via: 'auto', owner: SENDER_DID, did: SENDER_DID, webId: SENDER_DID,
    surface: 'sender', handle: `acct:${SENDER}@relay.fixture`, inbox: `${css}${SENDER}/inbox/`,
    label: 'the sender',
  },
];

// ── §2 DRIVEN: THE FOUR CALLERS THE OLD COMMENT LEFT AS AN OBLIGATION ────────
console.log('\n2. driven: no caller of the helper can be pointed at a foreign origin');
{
  let booted: Booted | undefined;
  try {
    booted = await bootRelay(seedTwoPods);
    const { callTool, pod, cssUrl } = booted;

    // The plant that makes the question reachable at all: `add_pod` takes an arbitrary URL.
    const planted = await callTool('add_pod', 'token-sender', { pod_url: `${FOREIGN}/${VICTIM}/` });
    check('§2 the foreign plant is accepted by add_pod — the premise of every check below',
      planted['added'] === true, JSON.stringify(planted['added'] ?? planted).slice(0, 200));

    const mark = (): number => pod.requests.length;
    const since = (n: number): string[] => pod.requests.slice(n).map(r => `${r.method} ${r.decoded}`);

    // ★★ NOT "the receipt says forbidden" — WHERE THE BYTES WENT. The whole defect class here is a
    // refusal that is reported while the write happens anyway, one path segment over.
    let m = mark();
    const rInbox = await callTool('read_inbox', 'token-sender', { pod_url: `${FOREIGN}/${SENDER}/` });
    check('§2 ★★ read_inbox at a foreign origin is refused AND touches the store zero times',
      typeof rInbox['error'] === 'string' && since(m).length === 0,
      `${JSON.stringify(rInbox['error'] ?? rInbox).slice(0, 160)} — requests ${JSON.stringify(since(m))}`);

    m = mark();
    const rInboxV = await callTool('read_inbox', 'token-sender', { pod_url: `${FOREIGN}/${VICTIM}/` });
    check('§2 …and the same for a foreign origin spelling the VICTIM path',
      typeof rInboxV['error'] === 'string' && since(m).length === 0,
      `${JSON.stringify(rInboxV['error'] ?? rInboxV).slice(0, 160)} — requests ${JSON.stringify(since(m))}`);

    m = mark();
    const rMan = await callTool('rebuild_manifest', 'token-sender', { pod_url: `${FOREIGN}/${SENDER}/` });
    check('§2 ★★ rebuild_manifest at a foreign origin is refused AND writes nothing',
      (typeof rMan['error'] === 'string') && since(m).length === 0,
      `${JSON.stringify(rMan['error'] ?? rMan).slice(0, 160)} — requests ${JSON.stringify(since(m))}`);

    // ★ THE LEGITIMATE CASE, which is what the clamp exists for and what must not regress: the
    // PUBLIC gate spelling of the caller's own pod still folds onto the internal host.
    m = mark();
    const rPublic = await callTool('read_inbox', 'token-sender', { pod_url: `${PUB}/${SENDER}/` });
    check('§2 ★ the PUBLIC gate spelling of your own pod still reads, folded to the internal host',
      rPublic['count'] === 0 && since(m).some(r => r === `GET /${SENDER}/inbox/`),
      `${JSON.stringify(rPublic).slice(-200)} — requests ${JSON.stringify(since(m))}`);

    m = mark();
    const nPublic = await callTool('notify_agent', 'token-sender',
      { to: `${PUB}/${VICTIM}/`, summary: 'a probe addressed by the public spelling of this store' });
    check('§2 ★ …and notify by the public spelling still delivers into the internal inbox',
      nPublic['delivered'] === true
      && since(m).some(r => r.startsWith(`PUT /${VICTIM}/inbox/`)),
      `${JSON.stringify(nPublic['delivered'])} — requests ${JSON.stringify(since(m))}`);

    // ★★ THE TWO /agents ROUTES reach the helper through a CARD, and the card comes from
    // `agentAddressOwners`, which requires a store origin. So the plant above is not this card —
    // asked by driving the route and looking at WHICH POD WAS READ.
    m = mark();
    const outbox = await booted.get(`/agents/${VICTIM}/outbox`);
    check('§2 ★★ the outbox route reads the VICTIM pod on THIS store, never the planted row',
      outbox.status === 200
      && since(m).length > 0
      && since(m).every(r => r.includes(`/${VICTIM}/`)),
      `${outbox.status} — requests ${JSON.stringify(since(m))}`);
    check('§2 …and the outbox it published names the store pod, not the plant',
      outbox.body.includes(`${cssUrl}${VICTIM}/`) && !outbox.body.includes(FOREIGN),
      outbox.body.slice(0, 240));

    // The AP inbox route is fail-closed by default (no RFC 9421 verification exists yet), so the
    // helper is not even reached there — asserted, because "it is gated" and "it is unreachable"
    // are different facts and only one of them is true today.
    const apInbox = await fetch(`${booted.base}/agents/${VICTIM}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/activity+json' },
      body: JSON.stringify({ type: 'Create', actor: 'https://elsewhere.example/actor' }),
    });
    check('§2 the unauthenticated AP inbox route is fail-closed before any of this matters',
      apInbox.status === 401, String(apInbox.status));
  } finally {
    await booted?.stop();
  }
}

// ── §3 DRIVEN: A DELIVERY DOES NOT MANUFACTURE ITS DESTINATION ───────────────
console.log('\n3. driven: notify_agent will not create the pod it is delivering to');
{
  let booted: Booted | undefined;
  try {
    booted = await bootRelay(seedTwoPods);
    const { callTool, pod, cssUrl } = booted;
    pod.absent.add(GHOST);
    pod.absent.add('u-eth-000000000000');
    pod.erroring.add(FLAKY);

    const mark = (): number => pod.requests.length;
    const since = (n: number): string[] => pod.requests.slice(n).map(r => `${r.method} ${r.decoded}`);
    const rawSince = (n: number): string[] => pod.requests.slice(n).map(r => `${r.method} ${r.raw}`);

    // (a) THE POD URL ROUTE — the reproduction.
    let m = mark();
    const ghost = await callTool('notify_agent', 'token-sender',
      { to: `${cssUrl}${GHOST}/`, summary: 'a probe addressed to a pod that has never existed' });
    check('§3 ★★ a pod that does not exist is REFUSED, not created',
      ghost['delivered'] === false && ghost['podExists'] === false,
      JSON.stringify({ delivered: ghost['delivered'], podExists: ghost['podExists'] }));
    // ★★ AND WHERE THE BYTES WENT, asked separately and by BOTH spellings of the path — the
    // question the earlier round of this family failed to ask, twice. The one write this call DOES
    // make is the caller's OWN federation row, which `autoRegisterAgentCard` persists on the first
    // authenticated tool call of the process; it is named rather than filtered out silently,
    // because "no write at all" would have been a check that passes for the wrong reason the day
    // the auto-register moves.
    const isMutation = (r: string): boolean => /^(PUT|POST|PATCH|DELETE) /.test(r);
    // ★ TWO WRITES BY THE RELAY'S OWN STARTUP ARE NAMED, NOT FILTERED BY SHAPE. The caller's own
    // federation row, which `autoRegisterAgentCard` persists on the first authenticated tool call
    // of the process; and `seedRelease42`, an AMEP seed fired after `app.listen` whose PUT lands
    // whenever it lands — MEASURED as an intermittent failure of this very check, appearing inside
    // the mark window on roughly one run in three and absent on the next two. Both are named
    // literally rather than excluded by a pattern, because "no write at all" would be a check that
    // passes for the wrong reason the day the auto-register moves.
    const OWN_STARTUP_WRITES = [FED_DIR, '/amep/state/'];
    const strayWrites = [...since(m), ...rawSince(m)]
      .filter(isMutation)
      .filter(r => !OWN_STARTUP_WRITES.some(p => r.includes(p)));
    check('§3 ★★ …and NOTHING was written anywhere under it, raw or decoded',
      strayWrites.length === 0
      && ![...since(m), ...rawSince(m)].some(r => isMutation(r) && r.includes(`/${GHOST}/`))
      && [...pod.stored.keys()].every(k => !k.startsWith(`/${GHOST}/`)),
      `stray ${JSON.stringify(strayWrites)} — all ${JSON.stringify(since(m))} raw ${JSON.stringify(rawSince(m))}`);
    check('§3 ★ …and the only request the target itself received is the existence probe',
      since(m).filter(r => r.includes(`/${GHOST}/`)).join('|') === `HEAD /${GHOST}/`,
      JSON.stringify(since(m)));
    check('§3 …and the refusal names what to send instead',
      typeof ghost['error'] === 'string' && (ghost['error'] as string).includes('list_known_pods'),
      String(ghost['error']).slice(0, 200));

    // (b) THE BARE-ID ROUTE — the same defect one route over, which is how it survived last time.
    m = mark();
    const byId = await callTool('notify_agent', 'token-sender',
      { to: 'u-eth-000000000000', summary: 'a probe addressed to a pod id nobody holds' });
    check('§3 ★★ the bare-id route refuses too, and writes nothing',
      byId['delivered'] === false && byId['podExists'] === false
      && !since(m).some(r => r.startsWith('PUT')),
      `${JSON.stringify(byId['delivered'])} — requests ${JSON.stringify(since(m))}`);

    // (c) THE POD THAT DOES EXIST — the delivery that must not regress, and the COST.
    m = mark();
    const real = await callTool('notify_agent', 'token-sender',
      { to: `${cssUrl}${VICTIM}/`, summary: 'a probe addressed to a pod that is really there' });
    const reqs = since(m);
    check('§3 ★ a pod that exists still delivers, and says the store confirmed it',
      real['delivered'] === true && real['podExists'] === true
      && reqs.some(r => r.startsWith(`PUT /${VICTIM}/inbox/`)),
      `${JSON.stringify({ delivered: real['delivered'], podExists: real['podExists'] })} — ${JSON.stringify(reqs)}`);
    // ★ THE COST, COUNTED RATHER THAN TIMED: exactly one extra request, a HEAD on the pod root.
    // A wall-clock number measured on this machine would be a number about this machine.
    check('§3 ★★ the probe costs exactly ONE extra request: HEAD on the pod root',
      reqs.filter(r => r.startsWith('HEAD')).length === 1
      && reqs.includes(`HEAD /${VICTIM}/`)
      && reqs.length === 2,
      JSON.stringify(reqs));

    // (d) FAIL-OPEN ON ANYTHING THAT IS NOT A DEFINITE NO. This is the conjunct that makes the
    // change safe to ship: a store hiccup must not become a delivery outage.
    m = mark();
    const flaky = await callTool('notify_agent', 'token-sender',
      { to: `${cssUrl}${FLAKY}/`, summary: 'a probe at a pod whose root the store cannot answer for' });
    check('§3 ★★ a store that answers 500 does NOT refuse — it delivers and says it does not know',
      flaky['delivered'] === true && flaky['podExists'] === 'unknown'
      && typeof flaky['podExistsNote'] === 'string',
      JSON.stringify({ delivered: flaky['delivered'], podExists: flaky['podExists'], note: flaky['podExistsNote'] }));
    check('§3 …and it really did write, so "unknown" is not a quiet refusal',
      since(m).some(r => r.startsWith(`PUT /${FLAKY}/inbox/`)),
      JSON.stringify(since(m)));

    // (e) THE DIRECTORY IS NOT THE AUTHORITY ON EXISTENCE. A row planted through `add_pod` for a
    // pod on this store that does not exist must not buy a delivery — the cheap test would have
    // been `inDirectory`, and `add_pod` writes that field.
    const plant = await callTool('add_pod', 'token-sender', { pod_url: `${cssUrl}${GHOST}/` });
    check('§3 the ghost pod now HAS a federation row (the premise of the next check)',
      plant['added'] === true, JSON.stringify(plant['added'] ?? plant).slice(0, 160));
    m = mark();
    const stillGhost = await callTool('notify_agent', 'token-sender',
      { to: `${cssUrl}${GHOST}/`, summary: 'a probe at a ghost that now has a directory row' });
    check('§3 ★★ a federation row does not make a pod exist — still refused, still writes nothing',
      stillGhost['delivered'] === false && stillGhost['podExists'] === false
      && !since(m).some(r => r.startsWith('PUT')),
      `${JSON.stringify({ delivered: stillGhost['delivered'], inDirectory: stillGhost['inDirectory'] })} — ${JSON.stringify(since(m))}`);
  } finally {
    await booted?.stop();
  }
}

console.log(failures === 0
  ? '\nAll checks passed — the writers are gated at the function, and a delivery does not invent a pod.'
  : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
