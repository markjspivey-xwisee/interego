#!/usr/bin/env tsx
/**
 * A public identity is published for a pod that EXISTS — and the relay's own credential does not
 * create the pod it is asked to write into.
 *
 * ── ★★ §1 THE DEFECT: AN ACTOR SYNTHESISED OUT OF A STRING THE CALLER CHOSE ──────────────────
 *
 * `add_pod` accepts an arbitrary URL from any authenticated caller — deliberately, because
 * `discover_directory` exists to learn about other people's pods (see its note). 96d89dc4 answered
 * "what may a planted row DO" at four readers and closed delivery: `notify_agent` HEADs the pod
 * root and refuses a 404. It did NOT close the documents that PUBLISH a row's identity. DRIVEN
 * against this server booted from the tree this test was written on, before the fix:
 * `add_pod { pod_url: "<store>/nosuchpod/" }` then `GET /agents/nosuchpod` -> 200 with a full
 * ActivityPub actor, and `/.well-known/webfinger?resource=acct:nosuchpod@...` -> 200 JRD. Every
 * field of that actor — `preferredUsername`, `name`, `inbox`, `outbox`, `interego:pod` — was built
 * out of the local part of a URL the caller typed, for a row with no did, no handle, no channels
 * and no container behind it, served from the relay's own domain.
 *
 * ── ★★ WHY EXISTENCE AND NOT `identityIsObserved`, WHICH WAS THE OTHER CANDIDATE ─────────────
 *
 * Censused against the LIVE directory rather than argued: all 578 persisted federation files were
 * fetched from the relay's own federation container and parsed on 2026-08-29 (574 canonical pods,
 * four origins, 572 addresses owned on this store), and then every one of those 572 pod roots was
 * HEADed unauthenticated against the live store.
 *
 *   · 487 rows carry an identity this relay observed, 85 do not — and 83 of those 85 are pods that
 *     REALLY EXIST. They came in through one `discover_directory` import on 2026-07-29 and name
 *     themselves only by a `did:ethr` in the caller-writable `owner` field. An identity gate would
 *     have 404'd 83 live pods.
 *   · 39 addresses have no container at all, and 37 of them are rows the relay DID identify —
 *     `interego-delegate`, `interego-workspace-live-driver`, `blast-radius-probe`, `g0805-*`,
 *     `gate-coldstart`: ephemeral demo agents whose pods were later deleted. An identity gate
 *     would have kept publishing every one.
 *
 * The two rules 404 almost disjoint sets, and only the container test 404s the thing the defect is
 * about. §4 below pins the losing half of that census as a REGRESSION CHECK: an unidentified row
 * whose pod exists must keep its actor, so a later "tighten it to identified rows" cannot land
 * quietly.
 *
 * ★ AND IT IS NOT AN OUTAGE, MEASURED THE SAME WAY: of the 572, exactly 81 were touched in the 14
 * days to 2026-08-29 and every one has a container. The 39 were last touched between 2026-07-29
 * and 2026-08-09. Those 39 are already undeliverable — composed from two measurements rather than
 * driven end to end on the live relay: each answers 404 for its pod root, and `notify_agent` has
 * refused a 404 pod root since 96d89dc4 — so this makes the identity documents agree with the
 * delivery path rather than adding a new refusal.
 *
 * ★ AND THE DEFECT WAS CONFIRMED IN PRODUCTION, not only here. Against the live relay at the
 * deployed sha on 2026-08-29: four of the 39 answered `GET /agents/<localPart>` with a 200 actor
 * AND a 200 WebFinger JRD while the store answered 404 for their pod root; a control row whose pod
 * is there answered 200 on both. Four of the 83 answered 200 with no `interego:did` — the live
 * form of exactly what rule (a) would have withdrawn.
 *
 * ── §2 THE COST, WHICH IS WHY THIS SURFACE NEEDED ITS OWN REVIEW ─────────────────────────────
 *
 * These four routes are UNAUTHENTICATED and cacheable, so the per-request HEAD `notify_agent` can
 * afford is an amplifier here. The probe is memoised. §2 counts recorded store requests to show
 * that N actor fetches cost ONE HEAD, and §2b shows the probe is reached only AFTER a row matches,
 * so an anonymous caller cannot drive it with localParts that are not in the directory.
 *
 * ── §5 THE SECOND MOUTH, CLOSED AT THE SHARED PATH ───────────────────────────────────────────
 *
 * `POST /agents/:localPart/inbox` called `deliverNotification` with no existence probe, so under
 * `RELAY_FEDERATION_ACCEPT_UNSIGNED=1` it was the same gap one route over. Two things close it,
 * and both are shared rather than copied: the card lookup all four routes go through is §1's
 * probe, and `deliverNotification` — the function that owns the PUT and has exactly two callers —
 * now refuses an absent pod itself, so a third caller cannot reintroduce it by not knowing.
 * §6 drives that function directly, because §5 can no longer reach it.
 *
 * ── WITH WHICH INSTRUMENT ────────────────────────────────────────────────────────────────────
 *
 * §1-§5 BOOT THE REAL RELAY as a child process against a fixture store that records every request
 * by method and by BOTH the raw and the decoded path and that MODELS CONTAINER EXISTENCE, and
 * assert on those recordings and on which files exist — never on a receipt alone, because a
 * receipt is exactly what could not see this defect. §6 imports `deliverNotification` and drives
 * it against a recording fetch. §0 is a source census for the things a driven run cannot see.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/an-identity-needs-a-pod.test.ts
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { deliverNotification, buildNotification } from '../agent-mesh.js';
import { sha256Hex } from '../federation-store.js';
import { listenLoopback } from './listen-loopback.js';
import { stripComments } from './strip-comments.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(here, '..', 'server.ts'), 'utf8');
const AGENT_MESH = readFileSync(join(here, '..', 'agent-mesh.ts'), 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const PUB = 'https://gate.fixture.example';
/** A pod with a full observed identity AND a container — the ordinary case. */
const REAL = 'u-eth-aaaa11112222';
/** The caller who plants rows. */
const SENDER = 'u-eth-ffff99990000';
/** A row with NO identity at all whose pod EXISTS — 83 live rows are this. Must keep its actor. */
const NAMELESS = 'eth-bbbb22223333';
/** A row this relay identified whose pod is GONE — 37 live rows are this. Must lose its actor. */
const DEPARTED = 'u-eth-cccc33334444';
/** A pod the store answers 500 for: "this relay cannot tell", which must not refuse. */
const FLAKY = 'u-eth-dddd44445555';
/** Never in the directory at all — the shape an anonymous caller can invent without limit. */
const STRANGER = 'u-eth-eeee55556666';
/** Planted through add_pod, on this store, never a container. THE DEFECT. */
const GHOST = 'nosuchpod';

const REAL_DID = `did:web:identity.test:agents:real-${REAL}`;
const SENDER_DID = `did:web:identity.test:agents:sender-${SENDER}`;
const DEPARTED_DID = `did:web:identity.test:agents:departed-${DEPARTED}`;

// ── §0 SOURCE CENSUS: what a driven run cannot see ───────────────────────────
console.log('\n0. source census');
{
  const code = stripComments(SERVER, 'server.ts');

  /**
   * ★★ EVERY §0 CHECK BELOW SLICES A FUNCTION BODY AND LOOKS INSIDE IT — never
   * `/name[\s\S]{0,2000}thing/`. A fixed window measures a DISTANCE and calls it a STRUCTURE: it
   * holds until somebody adds a paragraph between the two anchors, and then it reddens over a
   * property that is perfectly intact. tests/a-proxy-that-is-right-until-something-grows.test.ts
   * records the two production deploys that shape cost, and ratchets the population downward; a
   * new suite adding to it would be this repo paying the same bill twice. The first draft of this
   * file had four such windows and that gate caught them.
   */
  const bodyOf = (src: string, signature: string): string => {
    const at = src.indexOf(signature);
    if (at < 0) return '';
    const end = src.indexOf('\n}\n', at);
    return end < 0 ? src.slice(at) : src.slice(at, end);
  };

  // ★★ ONE READER. If a fifth /agents route lands and spells its own lookup, the probe is in
  // front of four of five readers — this file's recurring defect. Every `cardForLocalPart` call
  // outside the declaration must be AWAITED, which is also what makes the async refusal reachable:
  // dropping the `await` would leave a truthy Promise and publish the actor again.
  const declAt = code.indexOf('async function cardForLocalPart(');
  check('§0 the declaration is found, so the census is not vacuous', declAt > -1, String(declAt));
  const declEnd = code.indexOf('\n}\n', declAt);
  const sites: string[] = [];
  for (let at = code.indexOf('cardForLocalPart('); at !== -1; at = code.indexOf('cardForLocalPart(', at + 1)) {
    if (at >= declAt && at <= declEnd) continue;
    sites.push(code.slice(code.lastIndexOf('\n', at) + 1, code.indexOf('\n', at)).trim());
  }
  check('§0 there are four call sites — the four /agents-family routes', sites.length === 4,
    `${sites.length}: ${JSON.stringify(sites)}`);
  check('§0 ★★ every one of them AWAITS it, so none can read a Promise as a card',
    sites.length > 0 && sites.every(s => /await cardForLocalPart\(/.test(s)),
    JSON.stringify(sites));

  // The probe must live inside the shared reader, not beside its callers — asked of that
  // function's BODY, so a paragraph added anywhere in the file cannot move the answer.
  const cardBody = bodyOf(code, 'async function cardForLocalPart(');
  check('§0 the cardForLocalPart body is sliced, so what follows is not vacuous',
    cardBody.length > 0 && cardBody.includes('agentAddressOwners('), String(cardBody.length));
  const probeAt = cardBody.indexOf('cachedStorePodRootPresence(');
  const refuseAt = cardBody.indexOf('exists === false) return undefined;');
  const returnsAt = cardBody.indexOf('return { url: e.url');
  check('§0 ★★ the presence probe is INSIDE cardForLocalPart, and it refuses before it returns',
    probeAt > -1 && refuseAt > probeAt && returnsAt > refuseAt,
    `probe@${probeAt} refuse@${refuseAt} return@${returnsAt}`);

  // And the WRITE path carries its own refusal, at the function both delivery callers share.
  const mesh = stripComments(AGENT_MESH, 'agent-mesh.ts');
  const deliverBody = bodyOf(mesh, 'export async function deliverNotification(');
  check('§0 the deliverNotification body is sliced, so what follows is not vacuous',
    deliverBody.length > 0 && deliverBody.includes('inboxUrlFor('), String(deliverBody.length));
  const knownAt = deliverBody.indexOf('known.exists === false');
  const nullAt = deliverBody.indexOf('return null;', knownAt);
  const putAt = deliverBody.indexOf('method: \'PUT\'');
  check('§0 ★★ deliverNotification refuses an absent pod itself, above its PUT',
    knownAt > -1 && nullAt > knownAt && putAt > nullAt,
    `known@${knownAt} return-null@${nullAt} PUT@${putAt}`);
  // ★ THE PREMISE OF PUTTING THE REFUSAL IN THE WRITER: there are exactly two callers, and this
  // is where a third announces itself. The named import carries no `(`, so this counts calls.
  const callers = (code.match(/deliverNotification\(/g) ?? []).length;
  check('§0 deliverNotification has exactly two call sites in server.ts',
    callers === 2, `${callers} call site(s)`);

  /**
   * ── ★ THE ONE CONJUNCT §1-§6 CANNOT DRIVE, AND WHY IT IS ASKED HERE INSTEAD ────────────────
   *
   * A cached REFUSAL is a 404 on somebody's public identity, and the row that is legitimately
   * absent-then-present is a real one: the relay auto-registers an agent's row in the same
   * request that bootstraps its pod, so a brand new agent is a row without a container for the
   * width of one call. The absent TTL is what bounds how long that agent's actor keeps 404ing
   * after its pod appears — and driving it would mean a suite that sleeps for the TTL, which is
   * a wall-clock assertion of exactly the kind this repo has four documented flakes from.
   *
   * ★ SO WHAT IS CHECKED IS THE ORDERING AND THE SELECTION, NOT THE DURATIONS. A mutant that
   * made every verdict keep the PRESENT lifetime survived §1-§6 completely: nothing behavioural
   * distinguishes 30 s from 300 s inside one run. Stated plainly rather than implied: the
   * numbers themselves are a judgement, and only their relationship is enforced.
   */
  const num = (name: string): number => {
    const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(code);
    return m ? Number(m[1]!.replace(/_/g, '')) : NaN;
  };
  const present = num('POD_PRESENCE_TTL_PRESENT_MS');
  const absent = num('POD_PRESENCE_TTL_ABSENT_MS');
  const unknown = num('POD_PRESENCE_TTL_UNKNOWN_MS');
  check('§0 the three TTLs are declared, so what follows is not vacuous',
    Number.isFinite(present) && Number.isFinite(absent) && Number.isFinite(unknown),
    `${present}/${absent}/${unknown}`);
  check('§0 ★★ a cached REFUSAL expires sooner than a cached confirmation, and "unknown" soonest',
    absent < present && unknown < absent,
    `present ${present}ms, absent ${absent}ms, unknown ${unknown}ms`);
  const cacheBody = bodyOf(code, 'async function cachedStorePodRootPresence(');
  check('§0 ★ …and all three are actually SELECTED BETWEEN, not declared and then ignored',
    cacheBody.includes('POD_PRESENCE_TTL_PRESENT_MS')
    && cacheBody.includes('POD_PRESENCE_TTL_ABSENT_MS')
    && cacheBody.includes('POD_PRESENCE_TTL_UNKNOWN_MS'),
    cacheBody.slice(0, 200));
}

// ── The driven harness ───────────────────────────────────────────────────────
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
  post(path: string, body: unknown): Promise<{ status: number; body: string }>;
  stop(): Promise<void>;
}

async function bootRelay(
  makeSeed: (cssBase: string) => SeedRow[],
  extraEnv: Record<string, string> = {},
): Promise<Booted> {
  const IDENTITIES: Record<string, { userId: string; agentId: string }> = {
    'token-sender': { userId: SENDER, agentId: SENDER_DID },
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
    // ★★ CONTAINER EXISTENCE, MODELLED — the property this whole file is about. The live store
    // answers 200 for a pod root it holds and 404 for one it does not; that was measured against
    // the deployment on 2026-08-29 over all 572 addresses (533 -> 200, 39 -> 404), so this
    // fixture stands in for a behaviour that was observed rather than one that was assumed.
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
  const keyFile = join(tmpdir(), `identity-needs-pod-key-${process.pid}-${relayPort}.json`);

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
      ...extraEnv,
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
    base, cssUrl, pod,
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
      } catch (err) { return { requestFailed: (err as Error).name }; }
    },
    async get(path) {
      try {
        const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
        return { status: r.status, body: (await r.text()).slice(0, 900) };
      } catch (err) { return { status: 0, body: (err as Error).message }; }
    },
    async post(path, body) {
      try {
        const r = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/activity+json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
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

const seedDirectory = (css: string): SeedRow[] => [
  {
    url: `${css}${REAL}/`, via: 'auto', owner: REAL_DID, did: REAL_DID, webId: REAL_DID,
    surface: 'real', handle: `acct:${REAL}@relay.fixture`, inbox: `${css}${REAL}/inbox/`,
    label: 'a registered agent whose pod is there',
  },
  {
    url: `${css}${SENDER}/`, via: 'auto', owner: SENDER_DID, did: SENDER_DID, webId: SENDER_DID,
    surface: 'sender', handle: `acct:${SENDER}@relay.fixture`, inbox: `${css}${SENDER}/inbox/`,
  },
  // The 83: imported by discover_directory, named only by a caller-writable did:ethr `owner`,
  // and a pod that really is on this store.
  {
    url: `${css}${NAMELESS}/`, via: 'directory',
    owner: 'did:ethr:0xBBbb22223333444455556666777788889999aAaA',
  },
  // The 37: identified by the relay itself, pod later deleted.
  {
    url: `${css}${DEPARTED}/`, via: 'auto', owner: DEPARTED_DID, did: DEPARTED_DID,
    webId: DEPARTED_DID, surface: 'interego-delegate', inbox: `${css}${DEPARTED}/inbox/`,
  },
  {
    url: `${css}${FLAKY}/`, via: 'auto', owner: `did:web:identity.test:agents:flaky-${FLAKY}`,
    did: `did:web:identity.test:agents:flaky-${FLAKY}`, surface: 'flaky',
  },
];

// ── §1-§4 DRIVEN, DEFAULT ENV ────────────────────────────────────────────────
console.log('\n1-4. driven: the published identity, on default env');
{
  let booted: Booted | undefined;
  try {
    booted = await bootRelay(seedDirectory);
    const { callTool, pod, get } = booted;
    pod.absent.add(GHOST);
    pod.absent.add(DEPARTED);
    pod.erroring.add(FLAKY);

    const host = new URL(booted.base).host;
    const mark = (): number => pod.requests.length;
    const since = (n: number): string[] => pod.requests.slice(n).map(r => `${r.method} ${r.decoded}`);

    // ── §1 THE HEADLINE ──
    const planted = await callTool('add_pod', 'token-sender', { pod_url: `${booted.cssUrl}${GHOST}/` });
    check('§1 the ghost plant is accepted by add_pod — the premise of every check below',
      planted['added'] === true, JSON.stringify(planted['added'] ?? planted).slice(0, 200));

    let m = mark();
    const ghostActor = await get(`/agents/${GHOST}`);
    check('§1 ★★ a pod that has never existed gets NO ActivityPub actor',
      ghostActor.status === 404, `${ghostActor.status} ${ghostActor.body.slice(0, 220)}`);
    check('§1 ★★ …and the 404 body carries no synthesised identity for it',
      !ghostActor.body.includes('preferredUsername') && !ghostActor.body.includes(GHOST),
      ghostActor.body.slice(0, 220));
    check('§1 ★ …and the ONLY thing the store was asked is the existence probe on the pod root',
      since(m).filter(r => r.includes(`/${GHOST}`)).join('|') === `HEAD /${GHOST}/`,
      JSON.stringify(since(m)));

    // ★ THE REFUSAL IS MEMOISED TOO, which is the half of the cache that keeps an anonymous
    // caller from driving one outbound HEAD per request at a row that is IN the directory. Asked
    // behaviourally here; how long it lasts is §0's, and §0 says why it cannot be driven.
    m = mark();
    for (let i = 0; i < 5; i++) await get(`/agents/${GHOST}`);
    check('§1 ★★ five more fetches of the ghost cost ZERO further store requests',
      since(m).length === 0, JSON.stringify(since(m)));

    const ghostFinger = await get(`/.well-known/webfinger?resource=acct:${GHOST}@${host}`);
    check('§1 ★★ …and no WebFinger JRD either', ghostFinger.status === 404,
      `${ghostFinger.status} ${ghostFinger.body.slice(0, 200)}`);
    const ghostOutbox = await get(`/agents/${GHOST}/outbox`);
    check('§1 ★★ …and no outbox', ghostOutbox.status === 404,
      `${ghostOutbox.status} ${ghostOutbox.body.slice(0, 200)}`);

    // The 37 live rows this rule newly refuses: identified, but the pod is gone.
    const departed = await get(`/agents/${DEPARTED}`);
    check('§1 ★★ an IDENTIFIED row whose pod was deleted also loses its actor',
      departed.status === 404, `${departed.status} ${departed.body.slice(0, 200)}`);

    // ── §2 THE ORDINARY CASE, AND THE COST ──
    m = mark();
    const realActor = await get(`/agents/${REAL}`);
    check('§2 ★ a registered agent whose pod is there still serves a 200 actor',
      realActor.status === 200 && realActor.body.includes(REAL),
      `${realActor.status} ${realActor.body.slice(0, 240)}`);
    const fingerReal = await get(`/.well-known/webfinger?resource=acct:${REAL}@${host}`);
    check('§2 ★ …and its WebFinger JRD still resolves', fingerReal.status === 200,
      `${fingerReal.status} ${fingerReal.body.slice(0, 200)}`);
    const firstBatch = since(m);
    check('§2 the first actor fetch costs exactly one HEAD on that pod root',
      firstBatch.filter(r => r.startsWith('HEAD')).length === 1
      && firstBatch.includes(`HEAD /${REAL}/`),
      JSON.stringify(firstBatch));

    // ★★ THE AMPLIFIER, COUNTED. Ten anonymous GETs must not be ten outbound requests.
    m = mark();
    for (let i = 0; i < 10; i++) await get(`/agents/${REAL}`);
    check('§2 ★★ ten more anonymous actor fetches cost ZERO further store requests',
      since(m).length === 0, JSON.stringify(since(m)));

    // ★★ THE CONCURRENT MISS, WHICH THE CACHE ALONE DOES NOT COVER. A cache is read before the
    // probe and written after it, so requests arriving while one probe is in flight all miss.
    // Twenty simultaneous anonymous GETs of a COLD localPart must still be ONE outbound HEAD —
    // measured against a pod nothing has asked about yet, because a warm one would pass for the
    // wrong reason. `NAMELESS` is the cold one: §4 is the first check that touches it, below.
    m = mark();
    await Promise.all(Array.from({ length: 20 }, () => get(`/agents/${NAMELESS}`)));
    check('§2 ★★ twenty CONCURRENT fetches of a cold localPart cost exactly ONE HEAD',
      since(m).filter(r => r.startsWith('HEAD')).length === 1
      && since(m).length === 1
      && since(m)[0] === `HEAD /${NAMELESS}/`,
      JSON.stringify(since(m)));

    // §2b — the probe is downstream of the row match, so an unknown localPart never reaches it.
    m = mark();
    let strangers404 = 0;
    for (let i = 0; i < 5; i++) {
      const r = await get(`/agents/${STRANGER}-${i}`);
      if (r.status === 404) strangers404++;
    }
    check('§2b five localParts with no directory row are all 404', strangers404 === 5,
      `${strangers404}/5`);
    check('§2b ★★ …and none of them touched the store at all — the probe is not an amplifier',
      since(m).length === 0, JSON.stringify(since(m)));

    // ── §3 FAIL-OPEN ON ANYTHING THAT IS NOT A DEFINITE NO ──
    const flaky = await get(`/agents/${FLAKY}`);
    check('§3 ★★ a store that answers 500 does NOT withdraw the identity — it publishes as before',
      flaky.status === 200, `${flaky.status} ${flaky.body.slice(0, 200)}`);

    // ── §4 THE LOSING HALF OF THE CENSUS, PINNED ──
    const nameless = await get(`/agents/${NAMELESS}`);
    check('§4 ★★ an UNIDENTIFIED row whose pod exists keeps its actor (83 live rows are this)',
      nameless.status === 200, `${nameless.status} ${nameless.body.slice(0, 200)}`);
    check('§4 …and it publishes no agent DID it cannot back',
      nameless.status === 200 && !/"interego:did":\s*"/.test(nameless.body),
      nameless.body.slice(0, 300));
  } finally {
    await booted?.stop();
  }
}

// ── §5 THE SECOND MOUTH, WITH THE FLAG THAT REACHES IT ───────────────────────
console.log('\n5. driven: the AP inbox route with RELAY_FEDERATION_ACCEPT_UNSIGNED=1');
{
  let booted: Booted | undefined;
  try {
    booted = await bootRelay(seedDirectory, { RELAY_FEDERATION_ACCEPT_UNSIGNED: '1' });
    const { callTool, pod, post } = booted;
    pod.absent.add(GHOST);
    pod.absent.add(DEPARTED);
    pod.erroring.add(FLAKY);

    const mark = (): number => pod.requests.length;
    const since = (n: number): string[] => pod.requests.slice(n).map(r => `${r.method} ${r.decoded}`);
    const rawSince = (n: number): string[] => pod.requests.slice(n).map(r => `${r.method} ${r.raw}`);
    const activity = {
      type: 'Create', actor: 'https://elsewhere.example/actor',
      summary: 'a delivery from a foreign server',
      object: { type: 'Note', content: 'x' },
    };

    const planted = await callTool('add_pod', 'token-sender', { pod_url: `${booted.cssUrl}${GHOST}/` });
    check('§5 the ghost plant is accepted (the premise)', planted['added'] === true,
      JSON.stringify(planted['added'] ?? planted).slice(0, 160));

    // ★ The flag really is reaching this route — otherwise a 401 would make every check below
    // pass for the wrong reason, which is exactly the "check that passes two ways" trap.
    let m = mark();
    const real = await post(`/agents/${REAL}/inbox`, activity);
    check('§5 ★ the flag is ON: a delivery to a REAL pod is accepted and written',
      real.status === 202 && since(m).some(r => r.startsWith(`PUT /${REAL}/inbox/`)),
      `${real.status} ${real.body.slice(0, 200)} — ${JSON.stringify(since(m))}`);

    m = mark();
    const ghost = await post(`/agents/${GHOST}/inbox`, activity);
    check('§5 ★★ …and a delivery to a GHOST row is refused',
      ghost.status === 404, `${ghost.status} ${ghost.body.slice(0, 200)}`);
    const isMutation = (r: string): boolean => /^(PUT|POST|PATCH|DELETE) /.test(r);
    check('§5 ★★ …with NOTHING written anywhere under it, raw or decoded',
      ![...since(m), ...rawSince(m)].some(r => isMutation(r) && r.includes(`/${GHOST}`))
      && [...pod.stored.keys()].every(k => !k.startsWith(`/${GHOST}/`)),
      `${JSON.stringify(since(m))} raw ${JSON.stringify(rawSince(m))}`);

    m = mark();
    const departed = await post(`/agents/${DEPARTED}/inbox`, activity);
    check('§5 ★★ …and an IDENTIFIED row whose pod is gone is refused and written nothing',
      departed.status === 404
      && ![...since(m), ...rawSince(m)].some(r => isMutation(r) && r.includes(`/${DEPARTED}`)),
      `${departed.status} — ${JSON.stringify(since(m))}`);
  } finally {
    await booted?.stop();
  }
}

// ── §6 THE SHARED WRITER, DRIVEN DIRECTLY ────────────────────────────────────
//
// §5 can no longer reach `deliverNotification` for an absent pod, because the card lookup refuses
// first. That is the right layering and it is also why the writer's own refusal needs its own
// drive: a guard nothing exercises is a guard nobody knows is broken.
console.log('\n6. driven: deliverNotification will not create the pod it writes into');
{
  const seen: Array<{ method: string; url: string }> = [];
  const store = new Set(['http://s.test/there/']);
  const fetchFn = (async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    seen.push({ method, url });
    if (method === 'HEAD') {
      const root = url.endsWith('/') ? url : `${url}/`;
      return new Response(null, { status: store.has(root) ? 200 : 404, statusText: 'Not Found' });
    }
    return new Response('', { status: 201, statusText: 'Created' });
  }) as unknown as Parameters<typeof deliverNotification>[3];
  const notif = (): Record<string, unknown> => buildNotification(
    { from: 'did:example:a', to: 'did:example:b', summary: 's', published: '2026-08-29T00:00:00.000Z' },
    'slug');

  seen.length = 0;
  const absent = await deliverNotification('http://s.test/ghost/', notif(), 'slug', fetchFn);
  check('§6 ★★ an absent pod returns null and is never written to',
    absent === null && !seen.some(r => r.method === 'PUT'),
    `${String(absent)} — ${JSON.stringify(seen)}`);
  check('§6 …and the single request it made was the HEAD on the pod ROOT',
    seen.length === 1 && seen[0]!.method === 'HEAD' && seen[0]!.url === 'http://s.test/ghost/',
    JSON.stringify(seen));

  seen.length = 0;
  const there = await deliverNotification('http://s.test/there/', notif(), 'slug', fetchFn);
  check('§6 ★ a pod that exists is still delivered to',
    there === 'http://s.test/there/inbox/slug.jsonld'
    && seen.some(r => r.method === 'PUT' && r.url === 'http://s.test/there/inbox/slug.jsonld'),
    `${String(there)} — ${JSON.stringify(seen)}`);

  // ★ A presence the caller already established is USED, not re-asked — this is what keeps
  // notify_agent at exactly one HEAD per send rather than two.
  seen.length = 0;
  const passed = await deliverNotification(
    'http://s.test/there/', notif(), 'slug', fetchFn, () => { /* silent */ }, { exists: true });
  check('§6 ★★ a presence handed in costs ZERO extra requests',
    passed !== null && !seen.some(r => r.method === 'HEAD'), JSON.stringify(seen));

  // ★ And an absent verdict handed in still refuses — the parameter is an ANSWER, not a bypass.
  seen.length = 0;
  const refusedByPassed = await deliverNotification(
    'http://s.test/there/', notif(), 'slug', fetchFn, () => { /* silent */ }, { exists: false, status: 404 });
  check('§6 ★★ …and a handed-in "absent" refuses even for a pod that is really there',
    refusedByPassed === null && seen.length === 0,
    `${String(refusedByPassed)} — ${JSON.stringify(seen)}`);

  // ★ ONLY A DEFINITE NO. 'unknown' delivers exactly as before the probe existed.
  seen.length = 0;
  const unknown = await deliverNotification(
    'http://s.test/there/', notif(), 'slug', fetchFn, () => { /* silent */ },
    { exists: 'unknown', because: 'the store answered 500' });
  check('§6 ★★ an "unknown" verdict delivers — a store hiccup is not a refusal',
    unknown !== null && seen.some(r => r.method === 'PUT'),
    `${String(unknown)} — ${JSON.stringify(seen)}`);
}

console.log(failures === 0
  ? '\nAll checks passed — an identity needs a pod, and the writer will not invent one.'
  : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
