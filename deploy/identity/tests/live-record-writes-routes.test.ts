/**
 * Every write of an account's auth-methods.jsonld starts from the record as the pod holds it,
 * through the routes: server.ts is started as a child process (twice, where two instances share
 * the pods as during a deploy's overlap) against a stand-in pod server (servePods) that answers as
 * Community Solid Server 7.2 with the PGSL accessor production runs answered the same requests when
 * probed (S0 checks it against those answers): a document's ETag is the accessor's
 * `"sha256:<revision>-<16 hex>"`, new at every write, identical bytes included; a PUT that creates is
 * a 201 and one that replaces a 205; its conditions are CSS's BasicConditions.matchesMetadata
 * (If-None-Match: * fails with 412 where there is a document, If-Match fails where there is a
 * document with another ETag, and on a missing document only If-Match: * fails: a PUT sent with
 * If-Match on an ETag creates it, and a DELETE of it is a 404 whatever its condition); a pod's
 * container is created with its first document (or its own PUT, a 409 once it exists) and stays
 * when its documents are deleted. It lets a test hold, fail or delay its requests and edit a record
 * out of band (the other instance, an operator). It used to refuse If-Match on a missing document,
 * which CSS does not, and so passed a deletion that removed a record while a write conditional on
 * its ETag was still pending; and its header said it answered like CSS with the accessor while it
 * gave stock CSS's ETag (`"<modified ms>-application/ld+json"`), answered 201 to every PUT it
 * applied, had no containers, and answered 205 to anything but a GET of a pod's other documents.
 * The containers below a pod's own list their children and refuse a DELETE while they hold anything
 * (409), and a document committed natively (putNative: a Play guest's game saves and its write
 * budget, which the css-gate writes only that way) refuses every plain PUT and DELETE (409) and
 * stays. The stand-in used to have neither: a test's "checkpoint" was a plain document at the pod's
 * top level, which it deleted with 205, so a purge passed that the production store never lets
 * finish that way.
 * Passkeys come from the software authenticator in tests/soft-authenticator.ts.
 *
 * The identity server keeps a 10 s copy of each account's record. Its writers used to save a
 * record built from that copy, and some were acknowledged before the pod had them; a change that
 * reached the pod by another route within the 10 s came undone (a removed credential came back, a
 * raised session epoch dropped, a sign counter went backwards), and a write that failed left this
 * server believing in a record the pod never held. These tests make each writer meet such a
 * change, or such a failure, and check what the pod and this server hold afterwards; and they
 * check the costs (a passkey sign-in reads once and writes only what changed; readers of a stale
 * copy share one read).
 *
 * Run:
 *   node --test --import tsx tests/live-record-writes-routes.test.ts
 */

import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { assertion, attest, softPasskey, type SoftPasskey } from './soft-authenticator.js';
import { deriveUserIdFromDid, deriveUserIdFromWallet } from '../derive-userid.js';
import { playKeyThumbprint, provisionalUserId } from '../provisional-play.js';
import { closeServer, stopChild } from './teardown.js';
import { publicJwk } from './public-jwk.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);
async function waitFor<T>(find: () => T | undefined, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined || Date.now() > deadline) return found;
    await sleep(50);
  }
}
const TTL_WAIT_MS = 10_600;

// ── The stand-in pod server ─────────────────────────────────────────────────────────────────
type Doc = Record<string, unknown>;
/**
 * Which identity server sent a request: the primary reaches the stand-in on a port of its own
 * (primaryPodPort), every other instance on podPort.
 */
type Sender = 'primary' | 'other';
type Logged = { method: string; userId: string; target: 'doc' | 'container'; sender: Sender; ifMatch?: string; ifNoneMatch?: string; body?: Doc; status?: number; at: number };
const docs = new Map<string, { doc: Doc; modified: number }>();
let clock = Date.now();
/**
 * The ETag the PGSL accessor gives a document (integrations/pgsl-css-accessor NativeETagHandler):
 * its committed revision, new at every write (identical bytes included), and the first 16 hex of
 * the SHA-256 of its content type. `modified` stands for the revision here (each write takes a new one).
 */
const nativeEtag = (path: string, modified: number, contentType = 'application/ld+json') =>
  `"sha256:${crypto.createHash('sha256').update(`${path}\0${modified}`).digest('hex')}-${crypto.createHash('sha256').update(contentType).digest('hex').slice(0, 16)}"`;
const etagOf = (userId: string) => { const d = docs.get(userId); return d ? nativeEtag(`/${userId}/auth-methods.jsonld`, d.modified) : null; };
/**
 * Whether CSS 7.2 refuses (412) a write or a DELETE of a document whose ETag is `etag` (null: no
 * document) sent with these conditions (BasicConditions.matchesMetadata): with no document, only
 * If-Match: * fails.
 */
function conditionFails(entry: { ifMatch?: string; ifNoneMatch?: string }, etag: string | null): boolean {
  if (etag === null) return entry.ifMatch === '*';
  if (entry.ifNoneMatch === '*') return true;
  return entry.ifMatch !== undefined && entry.ifMatch !== '*' && entry.ifMatch !== etag;
}
const preconditionFails = (entry: { ifMatch?: string; ifNoneMatch?: string }, userId: string) => conditionFails(entry, etagOf(userId));
/**
 * The pods' other documents (an agent registry, a game's saves and write budget, the root's admission
 * ledger), by path. `native`: a native-committed head (putNative), as a game's saves and budget are.
 */
const others = new Map<string, { body: string; contentType: string; modified: number; native?: true }>();
/** Pods whose container was created and stays: CSS keeps a container once its documents are deleted. */
const containers = new Set<string>();
/** Containers below a pod's own ('/<id>/a/', '/<id>/a/b/') that stay once emptied, as CSS keeps them. */
const subContainers = new Set<string>();
/** The other documents and sub-containers below `prefix` (a pod's '/<id>/', or a sub-container's path). */
const below = (prefix: string) => [...others.keys(), ...subContainers].filter(p => p.startsWith(prefix) && p !== prefix);
/** A container's children, as its listing names them: the first segment of each path below it ('<name>/' for a container). */
function childrenOf(prefix: string): string[] {
  const names = new Set<string>();
  for (const p of below(prefix)) {
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    names.add(slash < 0 ? rest : rest.slice(0, slash + 1));
  }
  return [...names];
}
/** CSS keeps the containers of a resource it deletes: the pod's, and those between it and the resource. */
function keepContainersOf(path: string): void {
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return;   // a document of the root (the admission ledger)
  containers.add(segments[0]!);
  for (let i = 2; i < segments.length; i++) subContainers.add(`/${segments.slice(0, i).join('/')}/`);
}
/** A pod's container exists once it was PUT, or once a document was written in it (CSS creates it then). */
const containerExists = (userId: string) => containers.has(userId) || docs.has(userId) || below(`/${userId}/`).length > 0;
/** The body CSS sends with a 409 (its error handler's JSON), as the probe recorded it. */
const conflictBody = (message: string) => JSON.stringify({ name: 'ConflictHttpError', message, statusCode: 409, errorCode: 'H409' });
const NATIVE_REQUIRED = 'This resource requires a native conditional commit';
const unlisted = new Set<string>();
const failingGets = new Map<string, number>();
const nonJson = new Set<string>();
// 'hang-then-apply': never answered, and stored (if its precondition still holds then) right after
// the next read of that record is answered: the read a writer makes once its write timed out sees
// the old record, as a store that lets reads ahead of a queued write answers it. 'hang-then-apply-
// late': never answered, and stored (if its precondition holds) only when the test calls
// applyLate(), after the route has answered. A store keeps working on a request its client gave up on.
// '403': refused and not stored, as a pod refuses a write it will not take.
type PutFault = '500' | '403' | 'apply-then-500' | 'hang' | 'apply-then-hang' | 'hang-then-apply' | 'hang-then-apply-late';
const putFaults = new Map<string, PutFault[]>();
/** Held writes waiting for the next answered read of their record ('hang-then-apply'). */
const applyAfterRead: Array<{ userId: string; apply: () => void }> = [];
/** Held writes waiting for applyLate() ('hang-then-apply-late'). */
const lateWrites: Array<{ userId: string; apply: () => void }> = [];
/** What each held write did when the store got round to it. */
const heldOutcomes: Array<{ userId: string; applied: boolean }> = [];
/** The store gets round to the held writes of the ids in `ids` (cases running side by side each release their own). */
function applyLate(ids: readonly string[]): void {
  for (const w of lateWrites.filter(x => ids.includes(x.userId))) { lateWrites.splice(lateWrites.indexOf(w), 1); w.apply(); }
}
const hangingContainers = new Set<string>();
const requests: Logged[] = [];
/** Requests for the pods' other documents (an account's agent registry, say), and when the client gave up one never answered. */
const otherRequests: Array<{ method: string; path: string; at: number; status?: number; abandonedAt?: number }> = [];
/** `<METHOD> <path>` of requests for a pod's container or other documents that are never answered. */
const hangingOther = new Set<string>();
/** Paths of other documents whose next N DELETEs answer 500 (and delete nothing). */
const failingOtherDeletes = new Map<string, number>();
let latencyMs = 0;
/** A pod slow but still answering: each PUT (container or document) of an id this matches takes `ms`, and is then handled as usual. */
const slowPuts: Array<{ matches: (userId: string) => boolean; ms: number }> = [];
const slowPutFor = (userId: string) => slowPuts.find(x => x.matches(userId))?.ms ?? 0;
type Hold = { arrived: Promise<void>; release: () => void };
type HoldEntry = { method: string; matches: (userId: string, sender: Sender) => boolean; arrive: (userId: string) => void; released: Promise<void>; skip: number };
const holds: HoldEntry[] = [];

/**
 * Hold the `nth` next `method` request for the auth-methods.jsonld of `userId` (or of any id it
 * matches) until released. A GET answers with the record as it was when it arrived; a PUT or a
 * DELETE checks its precondition when released. `onArrive` runs as it arrives, with the id.
 * A hold takes a matching request whoever sends it: every identity server on these pods reads
 * every account's record at startup, so a test that holds a read for one server's route, while a
 * test beside it starts another server, matches on the sender too (fromPrimary).
 */
function hold(method: 'GET' | 'PUT' | 'DELETE', userId: string | ((id: string, sender: Sender) => boolean), nth = 1, onArrive?: (id: string) => void): Hold {
  let arrive!: () => void; let release!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const entry: HoldEntry = { method, matches: typeof userId === 'string' ? id => id === userId : userId,
    arrive: id => { onArrive?.(id); arrive(); }, released, skip: nth - 1 };
  holds.push(entry);
  return { arrived, release: () => { const i = holds.indexOf(entry); if (i >= 0) holds.splice(i, 1); release(); } };
}
function failPuts(userId: string, ...faults: PutFault[]): void { putFaults.set(userId, faults); }
/** An edit by another writer: the other instance, or an operator. The ETag moves on. */
function outOfBand(userId: string, edit: (doc: Doc) => void): void {
  const d = docs.get(userId)!;
  edit(d.doc);
  d.modified = clock = Math.max(clock + 1, Date.now());
}
/** Another document of a pod, put there as the relay or a game would. */
function putOther(path: string, body = '', contentType = 'text/turtle'): void {
  others.set(path, { body, contentType, modified: clock = Math.max(clock + 1, Date.now()) });
}
/**
 * A document committed natively (a PUT of `application/vnd.interego.native-commit+json`, which the
 * css-gate makes for a Play guest's game saves and its write budget, and which nothing here sends):
 * the PGSL store keeps it as a native-managed head, and its accessor refuses every plain PUT or DELETE
 * of it with 409 (NATIVE_REQUIRED), whatever its conditions.
 */
function putNative(path: string, body = '{}', contentType = 'application/json'): void {
  others.set(path, { body, contentType, modified: clock = Math.max(clock + 1, Date.now()), native: true });
}
/**
 * A Play guest's game, saved as the css-gate saves it: its write budget (`play-budget.json`) and a
 * checkpoint at `hallowmarch/checkpoints/<sha>.json`, both native commits. Returns the checkpoint's path.
 */
function saveGame(userId: string): string {
  const checkpoint = `/${userId}/hallowmarch/checkpoints/${crypto.createHash('sha256').update(userId).digest('hex')}.json`;
  putNative(`/${userId}/play-budget.json`);
  putNative(checkpoint);
  return checkpoint;
}
const record = (userId: string) => docs.get(userId)?.doc as unknown as PodRecord | undefined;
type PodRecord = { walletAddresses: string[]; didKeys: Array<{ did: string }>; sessionEpoch?: number; deletedAt?: string; name?: string;
  provisionalPlayAnchor?: string; provisionalPlayPurgePending?: true;
  webAuthnCredentials: Array<{ id: string; counter: number; rpId?: string; rpOrigin?: string }> };
const docPuts = (userId: string, since = 0) => requests.slice(since).filter(r => r.userId === userId && r.target === 'doc' && r.method === 'PUT');
const docGets = (userId: string, since = 0) => requests.slice(since).filter(r => r.userId === userId && r.target === 'doc' && r.method === 'GET');
/** A hold's match of the primary's requests for `userId`'s record (or of any id `matches` takes) alone. */
const fromPrimary = (matches: string | ((id: string) => boolean)) => (id: string, sender: Sender) =>
  sender === 'primary' && (typeof matches === 'string' ? id === matches : matches(id));
const containerPuts = (userId: string, since = 0) => requests.slice(since).filter(r => r.userId === userId && r.target === 'container');
const mark = () => requests.length;

/**
 * A container's listing as CSS writes it: `ldp:contains` with its children's relative IRIs (containers
 * end in '/'), sorted by name as the PGSL store lists them (packages/pgsl-store ldp.ts listChildren).
 * It used to list a pod's record first and its other documents in the order they were written.
 */
function listing(children: readonly string[]): string {
  const sorted = [...children].sort();
  return `@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> a ldp:BasicContainer${sorted.length ? ` ; ldp:contains ${sorted.map(c => `<${c}>`).join(', ')}` : ''} .\n`;
}

/**
 * Answers as Community Solid Server 7.2 with the PGSL accessor (the production stack) answered the
 * same requests when probed: a document's ETag is the accessor's ("sha256:<revision>-<16 hex>"), new
 * at every write; a PUT that creates is answered 201 and one that replaces 205; conditions as
 * conditionFails; a DELETE of a missing document is a 404 before any condition is checked; a PUT
 * of a container that exists is a 409 (the container is left as it is), and a container is created
 * by a PUT of a document in it and stays once its documents are deleted. A pod's container and the
 * containers below it list their children by name, and a DELETE of one that is not empty is a 409
 * ("Can only delete empty containers."). A native-committed head (putNative) answers every plain
 * PUT or DELETE that its conditions pass with a 409 (NATIVE_REQUIRED), and stays.
 */
async function servePods(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  const sender: Sender = req.socket.localPort === primaryPodPort ? 'primary' : 'other';
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  if (latencyMs) await sleep(latencyMs);
  const conditions = {
    ...(req.headers['if-match'] ? { ifMatch: String(req.headers['if-match']) } : {}),
    ...(req.headers['if-none-match'] ? { ifNoneMatch: String(req.headers['if-none-match']) } : {}) };
  if (hangingOther.has(`${req.method} ${path}`)) {
    const other: (typeof otherRequests)[number] = { method: req.method!, path, at: Date.now() };
    otherRequests.push(other);
    res.on('close', () => { other.abandonedAt = Date.now(); });
    return;
  }
  if (path === '/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(req.method === 'PUT' ? 409 : 405).end(); return; }
    const pods = new Set([...docs.keys(), ...containers, ...[...others.keys(), ...subContainers].filter(p => /^\/[^/]+\//.test(p)).map(p => p.split('/')[1]!)]);
    const children = [...[...pods].filter(p => !unlisted.has(p)).map(p => `${p}/`), ...[...others.keys()].filter(p => /^\/[^/]+$/.test(p)).map(p => p.slice(1))];
    res.writeHead(200, { 'Content-Type': 'text/turtle' }).end(req.method === 'GET' ? listing(children) : undefined);
    return;
  }
  const container = /^\/([^/]+)\/$/.exec(path);
  if (container) {
    const id = container[1]!;
    requests.push({ method: req.method!, userId: id, target: 'container', sender, at: Date.now() });
    if (req.method === 'PUT' && slowPutFor(id)) await sleep(slowPutFor(id));
    if (req.method === 'PUT' && hangingContainers.has(id)) return;   // never answered
    if (req.method === 'PUT') {
      if (containerExists(id)) { res.writeHead(409).end(); return; }
      containers.add(id);
      res.writeHead(201).end();
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!containerExists(id)) { res.writeHead(404).end(); return; }
      const children = [...(docs.has(id) ? ['auth-methods.jsonld'] : []), ...childrenOf(`/${id}/`)];
      res.writeHead(200, { 'Content-Type': 'text/turtle', ETag: `"${clock}-text/turtle"` }).end(req.method === 'GET' ? listing(children) : undefined);
      return;
    }
    if (req.method === 'DELETE') {
      if (!containerExists(id)) { res.writeHead(404).end(); return; }
      if (docs.has(id) || below(`/${id}/`).length > 0) { res.writeHead(409, { 'Content-Type': 'application/json' }).end(conflictBody('Can only delete empty containers.')); return; }
      containers.delete(id);
      res.writeHead(205).end();
      return;
    }
    res.writeHead(405).end();
    return;
  }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (!m) {
    const other: (typeof otherRequests)[number] = { method: req.method!, path, at: Date.now() };
    otherRequests.push(other);
    const answerOther = (status: number, headers: Record<string, string> = {}, body?: string) => { other.status = status; res.writeHead(status, headers).end(body); };
    const conflict = (message: string) => answerOther(409, { 'Content-Type': 'application/json' }, conflictBody(message));
    if (path.endsWith('/')) {
      // A container below a pod's own: it exists once something was written in it (or it was PUT),
      // and stays once emptied; a DELETE of it while it holds anything is a 409.
      const exists = subContainers.has(path) || below(path).length > 0;
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!exists) answerOther(404);
        else answerOther(200, { 'Content-Type': 'text/turtle', ETag: `"${clock}-text/turtle"` }, req.method === 'GET' ? listing(childrenOf(path)) : undefined);
        return;
      }
      if (req.method === 'PUT') {
        if (exists) { answerOther(409); return; }
        subContainers.add(path);
        answerOther(201);
        return;
      }
      if (req.method === 'DELETE') {
        if (!exists) { answerOther(404); return; }
        if (below(path).length > 0) { conflict('Can only delete empty containers.'); return; }
        subContainers.delete(path);
        keepContainersOf(path);
        answerOther(205);
        return;
      }
      answerOther(405);
      return;
    }
    const stored = others.get(path);
    const etag = stored ? nativeEtag(path, stored.modified, stored.contentType) : null;
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!stored) answerOther(404);
      else answerOther(200, { 'Content-Type': stored.contentType, ETag: etag! }, req.method === 'GET' ? stored.body : undefined);
      return;
    }
    if (req.method === 'PUT') {
      if (conditionFails(conditions, etag)) { answerOther(412); return; }
      if (stored?.native) { conflict(NATIVE_REQUIRED); return; }
      others.set(path, { body: raw, contentType: String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!, modified: clock = Math.max(clock + 1, Date.now()) });
      answerOther(stored ? 205 : 201);
      return;
    }
    if (req.method === 'DELETE') {
      const failing = failingOtherDeletes.get(path) ?? 0;
      if (failing > 0) { failingOtherDeletes.set(path, failing - 1); answerOther(500); return; }
      if (!stored) { answerOther(404); return; }
      if (conditionFails(conditions, etag)) { answerOther(412); return; }
      if (stored.native) { conflict(NATIVE_REQUIRED); return; }
      keepContainersOf(path);   // its containers stay
      others.delete(path);
      answerOther(205);
      return;
    }
    answerOther(405);
    return;
  }
  const userId = m[1]!;
  const entry: Logged = { method: req.method!, userId, target: 'doc', sender, at: Date.now(), ...conditions };
  requests.push(entry);
  const answer = (status: number, headers: Record<string, string> = {}, body = '') => { entry.status = status; res.writeHead(status, headers).end(body); };
  const snapshot = docs.get(userId) ? structuredClone(docs.get(userId)!) : undefined;
  const held = holds.find(h => h.method === req.method && h.matches(userId, sender) && h.skip-- <= 0);
  if (held) {
    holds.splice(holds.indexOf(held), 1);
    held.arrive(userId);
    await held.released;
  }
  if (req.method === 'HEAD') {
    const at = docs.get(userId);
    answer(at ? 200 : 404, at ? { 'Content-Type': 'application/ld+json', ETag: nativeEtag(`/${userId}/auth-methods.jsonld`, at.modified) } : {});
    return;
  }
  if (req.method === 'GET') {
    const left = failingGets.get(userId) ?? 0;
    if (left > 0) { failingGets.set(userId, left - 1); answer(502); return; }
    if (nonJson.has(userId)) { answer(200, { 'Content-Type': 'application/ld+json' }, '{ "userId": "not json'); return; }
    const at = held ? snapshot : docs.get(userId);
    if (!at) answer(404);
    else answer(200, { 'Content-Type': 'application/ld+json', ETag: nativeEtag(`/${userId}/auth-methods.jsonld`, at.modified) }, JSON.stringify(at.doc));
    for (const w of applyAfterRead.filter(x => x.userId === userId)) { applyAfterRead.splice(applyAfterRead.indexOf(w), 1); w.apply(); }
    return;
  }
  if (req.method === 'PUT') {
    entry.body = JSON.parse(raw) as Doc;
    if (slowPutFor(userId)) await sleep(slowPutFor(userId));
    const fault = putFaults.get(userId)?.shift();
    if (fault === 'hang') return;   // never answered: the writer's own timeout must end it
    if (fault === 'hang-then-apply' || fault === 'hang-then-apply-late') {
      const body = entry.body;
      const apply = () => {
        const applied = !preconditionFails(entry, userId);
        if (applied) docs.set(userId, { doc: body, modified: clock = Math.max(clock + 1, Date.now()) });
        heldOutcomes.push({ userId, applied });
      };
      (fault === 'hang-then-apply' ? applyAfterRead : lateWrites).push({ userId, apply });
      return;
    }
    if (fault === '500') { answer(500); return; }
    if (fault === '403') { answer(403); return; }
    if (preconditionFails(entry, userId)) { answer(412); return; }
    const created = !docs.has(userId);
    docs.set(userId, { doc: entry.body, modified: clock = Math.max(clock + 1, Date.now()) });
    if (fault === 'apply-then-hang') return;   // stored, and never answered: the write times out
    answer(fault === 'apply-then-500' ? 500 : created ? 201 : 205);
    return;
  }
  if (req.method === 'DELETE') {
    // The identity server sends none (a deletion writes a tombstone); answered as CSS would.
    // A missing document is a 404 before any condition is checked (DataAccessorBasedStore.deleteResource).
    if (!docs.has(userId)) { answer(404); return; }
    if (preconditionFails(entry, userId)) { answer(412); return; }
    containers.add(userId);   // the container stays
    docs.delete(userId);
    answer(205);
    return;
  }
  answer(405);
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────
const earlier = '2025-01-01T00:00:00.000Z';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}
function didKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicJwk(publicKey).x!, 'base64url');
  const multibase = `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`;
  return { did: `did:key:${multibase}`, multibase, privateKey };
}
type DidKey = ReturnType<typeof didKey>;
const didEntry = (k: DidKey, did = k.did) => ({ did, publicKeyMultibase: k.multibase, keyType: 'Ed25519VerificationKey2020', createdAt: earlier });
const stored = (key: SoftPasskey, counter = 0, pin?: string, createdAt = earlier) => ({
  id: key.id, publicKey: key.cose.toString('base64url'), counter, transports: ['internal'], createdAt,
  ...(pin ? { rpId: '127.0.0.1', rpOrigin: pin } : {}),
});
type Seed = { keys?: SoftPasskey[]; wallets?: AnyWallet[]; dids?: DidKey[]; epoch?: number; pin?: string; counter?: number; extra?: Doc };
function seed(userId: string, s: Seed): void {
  docs.set(userId, { modified: clock = Math.max(clock + 1, Date.now()), doc: {
    userId, name: userId, walletAddresses: (s.wallets ?? []).map(w => w.address.toLowerCase()),
    webAuthnCredentials: (s.keys ?? []).map(k => stored(k, s.counter ?? 0, s.pin)), didKeys: (s.dids ?? []).map(d => didEntry(d)),
    ...(s.epoch !== undefined ? { sessionEpoch: s.epoch } : {}), ...(s.extra ?? {}),
  } });
}
/** An account derived from its first passkey (as a fresh registration opens one), listed and loaded at startup. */
function account(s: Seed & { keys: SoftPasskey[] }) {
  const userId = s.keys[0]!.userId;
  seed(userId, s);
  return { userId, ...s };
}
const P = () => softPasskey();
type AnyWallet = { address: string; signMessage(message: string): Promise<string> };
const W = (): AnyWallet => Wallet.createRandom();

// ── Identity server instances ───────────────────────────────────────────────────────────────
const tokenSigningKey = crypto.randomBytes(32).toString('base64');
const invites = { pk: { userId: 'seeded-pk', token: crypto.randomBytes(12).toString('hex') },
  claimed: { userId: 'seeded-claimed', token: crypto.randomBytes(12).toString('hex') },
  never: { userId: 'seeded-never', token: crypto.randomBytes(12).toString('hex') },
  del: { userId: 'seeded-del', token: crypto.randomBytes(12).toString('hex') },
  unconfirmed: { userId: 'seeded-unconfirmed', token: crypto.randomBytes(12).toString('hex') },
  unconfirmedBlind: { userId: 'seeded-unconfirmed-blind', token: crypto.randomBytes(12).toString('hex') },
  landed: { userId: 'seeded-landed', token: crypto.randomBytes(12).toString('hex') },
  landedDid: { userId: 'seeded-landed-did', token: crypto.randomBytes(12).toString('hex') },
  landedBlind: { userId: 'seeded-landed-blind', token: crypto.randomBytes(12).toString('hex') },
  landedBlindDid: { userId: 'seeded-landed-blind-did', token: crypto.randomBytes(12).toString('hex') },
  slow: { userId: 'seeded-slow', token: crypto.randomBytes(12).toString('hex') },
  slowDid: { userId: 'seeded-slow-did', token: crypto.randomBytes(12).toString('hex') },
  unsure: { userId: 'seeded-unsure', token: crypto.randomBytes(12).toString('hex') },
  unsureDid: { userId: 'seeded-unsure-did', token: crypto.randomBytes(12).toString('hex') },
  hangEarly: { userId: 'seeded-hang-early', token: crypto.randomBytes(12).toString('hex') },
  hangLate: { userId: 'seeded-hang-late', token: crypto.randomBytes(12).toString('hex') },
  unsureWeb: { userId: 'seeded-unsure-web', token: crypto.randomBytes(12).toString('hex') },
  raceWeb: { userId: 'seeded-race-web', token: crypto.randomBytes(12).toString('hex') },
  fenceClaim: { userId: 'seeded-fence-claim', token: crypto.randomBytes(12).toString('hex') },
  fenceBlind: { userId: 'seeded-fence-blind', token: crypto.randomBytes(12).toString('hex') },
  fenceBlindDid: { userId: 'seeded-fence-blind-did', token: crypto.randomBytes(12).toString('hex') },
  fencePk: { userId: 'seeded-fence-pk', token: crypto.randomBytes(12).toString('hex') },
  bearerClaim: { userId: 'seeded-bearer-claim', token: crypto.randomBytes(12).toString('hex') },
  bearerClaimWeb: { userId: 'seeded-bearer-claim-web', token: crypto.randomBytes(12).toString('hex') } };
const bootstrap = (invite: { userId: string; token: string }) => ({ extra: { bootstrapUserId: invite.userId, bootstrapInvite: invite.token } });
/** A bearer token for `userId` signed with the shared key, as another instance issues one (in server.ts's cg2_ format). */
function tokenSignedElsewhere(userId: string): string {
  const now = Date.now();
  const b64 = Buffer.from(JSON.stringify({ userId, agentId: `mcp-client-${userId}`, scope: 'ReadWrite',
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), epoch: 0 })).toString('base64url');
  return `cg2_${b64}.${crypto.createHmac('sha256', Buffer.from(tokenSigningKey, 'base64')).update(b64).digest('base64url')}`;
}
let podServer: http.Server;
let podPort = 0;
// The same stand-in, on a port only the primary is given (its CSS_URL), so that a request can be
// told to be the primary's (Logged.sender, fromPrimary).
let primaryPodServer: http.Server;
let primaryPodPort = 0;
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => s.close(() => resolve()));
  return port;
}
type Instance = { base: string; port: number; output: () => string; stop(): Promise<void>; ready: Promise<void> };
const instances: Instance[] = [];
async function startIdentity(port: number, env: Record<string, string> = {}, waitComplete = true): Promise<Instance> {
  const base = `http://127.0.0.1:${port}`;
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['IDENTITY_INTROSPECTION_SECRET', 'TEST_AGENT_PATTERN', 'CSS_PUBLIC_URL', 'BOOTSTRAP_INVITES', 'PROVISIONAL_PLAY_CLIENTS',
    'WEBAUTHN_RP_ID', 'WEBAUTHN_RP_ORIGIN', 'WEBAUTHN_RP_ORIGINS', 'TRY_USER_TTL_MS']) delete childEnv[k];
  Object.assign(childEnv, {
    PORT: String(port), BASE_URL: base, CSS_URL: `http://127.0.0.1:${podPort}/`, RELAY_URL: 'http://relay.invalid',
    TOKEN_SIGNING_KEY: tokenSigningKey, JANITOR_INTERVAL_MS: '0', ALLOW_OPEN_INTROSPECTION: '1',
    BOOTSTRAP_INVITES: Object.values(invites).map(i => `${i.userId}:${i.token}`).join(','), ...env,
  });
  const proc: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout!.on('data', d => { output += String(d); });
  proc.stderr!.on('data', d => { output += String(d); });
  const ready = (async () => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`identity server exited ${proc.exitCode}:\n${output}`);
      try {
        const health = await (await fetch(`${base}/health`)).json() as { accountIndex: { complete: boolean } };
        if (health.accountIndex.complete) return;
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`identity server did not load its accounts:\n${output}`);
      await sleep(100);
    }
  })();
  const inst: Instance = {
    base, port, ready, output: () => output,
    stop: () => stopChild(proc),
  };
  instances.push(inst);
  if (waitComplete) await ready;
  else {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try { await fetch(`${base}/health`); break; } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`identity server did not start:\n${output}`);
      await sleep(100);
    }
  }
  return inst;
}

// ── Clients ─────────────────────────────────────────────────────────────────────────────────
let ipCounter = 0;
// Every request comes from its own address (the server trusts one proxy hop), so the per-IP
// sign-in limits never run out.
const nextIp = () => { ipCounter++; return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`; };
type Reply = { status: number; json: Record<string, unknown>; at: number };
let primary: Instance;
async function call(inst: Instance, method: string, path: string, body?: unknown, bearer?: string): Promise<Reply> {
  const r = await fetch(`${inst.base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp(), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { text }; }
  return { status: r.status, json, at: Date.now() };
}
const post = (path: string, body: unknown, bearer?: string, inst = primary) => call(inst, 'POST', path, body, bearer);
const out = (inst = primary) => `\n${inst.output().split('\n').slice(-40).join('\n')}`;
async function signIn(key: SoftPasskey, counter: number, inst = primary): Promise<Reply> {
  const ch = await post('/challenges', { purpose: 'webauthn-authenticate' }, undefined, inst);
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  const rpId = String(ch.json['rpId'] ?? '127.0.0.1');
  return post('/auth/webauthn/authenticate', { response: assertion(key, String(ch.json['nonce']), inst.base, rpId, counter) }, undefined, inst);
}
async function tokenFor(key: SoftPasskey, counter: number, userId = key.userId, inst = primary): Promise<string> {
  const r = await signIn(key, counter, inst);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out(inst)}`);
  assert.equal(r.json['userId'], userId);
  return String(r.json['token']);
}
async function addDevice(key: SoftPasskey, bearer: string, inst = primary): Promise<Reply> {
  const options = await post('/auth/webauthn/register-options', { name: 'Device' }, bearer, inst);
  if (options.status !== 200) return options;
  const rpId = (options.json['rp'] as { id: string }).id;
  return post('/auth/webauthn/register', { response: attest(key, String(options.json['challenge']), inst.base, rpId) }, undefined, inst);
}
/** A passkey registered with no bearer and no invite: it opens the account derived from it. */
async function freshPasskey(key: SoftPasskey, inst = primary): Promise<Reply> {
  const options = await post('/auth/webauthn/register-options', { name: 'Fresh' }, undefined, inst);
  if (options.status !== 200) return options;
  const rpId = (options.json['rp'] as { id: string }).id;
  return post('/auth/webauthn/register', { response: attest(key, String(options.json['challenge']), inst.base, rpId) }, undefined, inst);
}
async function bootstrapPasskey(key: SoftPasskey, invite: { userId: string; token: string }, inst = primary): Promise<Reply> {
  const options = await post('/auth/webauthn/register-options', { name: 'Seeded', bootstrapUserId: invite.userId, bootstrapInvite: invite.token }, undefined, inst);
  if (options.status !== 200) return options;
  const rpId = (options.json['rp'] as { id: string }).id;
  return post('/auth/webauthn/register', { response: attest(key, String(options.json['challenge']), inst.base, rpId) }, undefined, inst);
}
/** A SIWE message for this instance, signed by `w`, carrying a fresh nonce. */
async function siweProof(w: AnyWallet, inst: Instance) {
  const { nonce } = (await post('/challenges', { purpose: 'siwe' }, undefined, inst)).json as { nonce: string };
  const message = `${new URL(inst.base).host} wants you to sign in with your Ethereum account:\n${w.address}\n\nSign in.\n\n`
    + `URI: ${inst.base}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  return { message, signature: await w.signMessage(message), nonce };
}
async function siwe(w: AnyWallet, opts: { bearer?: string; existingOnly?: boolean; extra?: Doc } = {}, inst = primary): Promise<Reply> {
  return post('/auth/siwe', { ...(await siweProof(w, inst)), name: 'Wallet',
    ...(opts.existingOnly ? { existingOnly: true } : {}), ...(opts.extra ?? {}) }, opts.bearer, inst);
}
async function linkWallet(w: AnyWallet, bearer: string, inst = primary): Promise<Reply> {
  const { message, signature, nonce } = await siweProof(w, inst);
  return post('/wallet/link', { walletAddress: w.address, siweMessage: message, signature, nonce }, bearer, inst);
}
async function didSignIn(k: DidKey, opts: { bearer?: string; did?: string; extra?: Doc } = {}, inst = primary): Promise<Reply> {
  const { nonce, message } = (await post('/challenges', { purpose: 'did-sig' }, undefined, inst)).json as { nonce: string; message?: string };
  const signature = crypto.sign(null, Buffer.from(message ?? nonce, 'utf8'), k.privateKey).toString('base64url');
  return post('/auth/did', { did: opts.did ?? k.did, nonce, signature, name: 'DID',
    ...(opts.did ? { publicKeyMultibase: k.multibase } : {}), ...(opts.extra ?? {}) }, opts.bearer, inst);
}
const del = (path: string, bearer: string, body?: unknown, inst = primary) => call(inst, 'DELETE', path, body ?? {}, bearer);
const signOut = (bearer: string, inst = primary) => post('/tokens/me/sign-out-everywhere', {}, bearer, inst);
const me = (bearer: string, inst = primary) => call(inst, 'GET', '/auth-methods/me', undefined, bearer);
const verify = (token: string, inst = primary) => post('/tokens/verify', { token }, undefined, inst);
async function signsInTo(r: Promise<Reply>, userId: string, inst = primary): Promise<Reply> {
  const reply = await r;
  assert.equal(reply.status, 200, `${JSON.stringify(reply.json)}${out(inst)}`);
  assert.equal(reply.json['userId'], userId, JSON.stringify(reply.json));
  return reply;
}
const credentialOf = (userId: string, key: SoftPasskey) => record(userId)!.webAuthnCredentials.find(c => c.id === key.id);

// ── Accounts (seeded before the servers start, so every one is loaded) ─────────────────────
const a1 = account({ keys: [P(), P()], wallets: [W()] });
const a2 = account({ keys: [P()], wallets: [W()] });
const a3 = account({ keys: [P(), P()] });
const a4 = account({ keys: [P()] });
const a5 = account({ keys: [P()], wallets: [W()] });
const a6 = account({ keys: [P(), P()], wallets: [W()] });
const a11 = account({ keys: [P()], wallets: [W()], dids: [didKey()] });
const a9 = { signIn: account({ keys: [P()] }), add: account({ keys: [P()] }), remove: account({ keys: [P()], wallets: [W()] }), out: account({ keys: [P()] }) };
const b1 = account({ keys: [P()], wallets: [W()] });
const b2 = account({ keys: [P()] });
const c1 = account({ keys: [P()] });
const c2 = account({ keys: [P()] });   // its passkey predates relying-party pinning: no rpId on file
const d2 = account({ keys: [P()] });
const d3 = account({ keys: [P()] });
const e3 = account({ keys: [P()] });
const f1 = account({ keys: [P()] });
const f2 = account({ keys: [P()] });
const f3 = account({ keys: [P()] });
const f5 = account({ keys: [P()], wallets: [W()], dids: [didKey()] });
const f6 = account({ keys: [P()] });
const f7 = account({ keys: [P()] });
const f8 = account({ keys: [P()] });
const f9 = account({ keys: [P(), P()], wallets: [W(), W()], dids: [didKey(), didKey()] });
const f11 = account({ keys: [P()] });
const f12 = account({ keys: [P()], wallets: [W()] });
const g = account({ keys: [P()] });
const t7 = account({ keys: [P()], wallets: [W()] });
const t8 = { owner: account({ keys: [P()] }), key: didKey() };
const t9 = { key: didKey(), did: 'did:web:readd.example', y: account({ keys: [P()] }) };
const t9u = { key: didKey(), did: 'did:web:dropped.example', y: account({ keys: [P()] }) };
const tR = account({ keys: [P()] });
const tH = account({ keys: [P()] });
const bothRemovals = account({ keys: [P()], wallets: [W()] });
const twoAdds = account({ keys: [P()] });
const raceOut = account({ keys: [P()] });
const raceAdd = account({ keys: [P()] });
const raceSignOut = account({ keys: [P()] });
const raceRemove = account({ keys: [P()], wallets: [W()] });
// Accounts a wallet or DID is added to with a bearer while a sign-in with it is made, or whose add
// the pod takes without confirming it.
const k1 = { wallet: account({ keys: [P()] }), did: account({ keys: [P()] }), link: account({ keys: [P()] }), other: account({ keys: [P()] }) };
const k2 = { wallet: account({ keys: [P()] }), did: account({ keys: [P()] }), link: account({ keys: [P()] }),
  blind: account({ keys: [P()] }), blindDid: account({ keys: [P()] }), linkBlind: account({ keys: [P()] }), blindWeb: account({ keys: [P()] }) };
// The owner of a did:web (listed with its key), for sign-ins with that DID and keys of their own.
const k4 = { owner: account({ keys: [P()] }), key: didKey(), did: 'did:web:owner-turn.example' };
// An account adding a did:web, and one the other instance opened after this one listed the pods (so
// not loaded here), whose token that instance signed with the shared key.
const k5 = { holder: account({ keys: [P()] }), unloaded: account({ keys: [P()] }) };
unlisted.add(k5.unloaded.userId);
// Two accounts adding one did:web at once (and a bootstrap claim of another).
const r3 = { a: account({ keys: [P()] }), b: account({ keys: [P()] }) };
// Bearers that do not verify, with a wallet or did:key no account holds: accounts the other instance
// opened after this one listed the pods (so not loaded here), and one signed out everywhere.
const k6 = { wallet: account({ keys: [P()] }), did: account({ keys: [P()] }), revoked: account({ keys: [P()] }), link: account({ keys: [P()] }) };
unlisted.add(k6.wallet.userId);
unlisted.add(k6.did.userId);
unlisted.add(k6.link.userId);
// Bearer adds whose account is deleted while the request waits: for the DID's turn (held by an
// account removing that did:key), or for the read of the wallet's derived account.
const k8key = didKey();
const k8 = { y: account({ keys: [P()], dids: [k8key] }), didX: account({ keys: [P()] }), walletX: account({ keys: [P()] }) };
// Adds that wait (for a credential's turn, or between a passkey's options and its registration)
// while their account signs out everywhere.
const s9 = { y: account({ keys: [P()] }), x: account({ keys: [P()] }), linkY: account({ keys: [P()] }), linkX: account({ keys: [P()] }),
  siweY: account({ keys: [P()] }), siweX: account({ keys: [P()] }), device: account({ keys: [P()] }) };
// An add the pod never answers whose account then removes the credential; a removal the pod never
// answers whose credential is then added back.
const p1 = { wallet: account({ keys: [P()] }), did: account({ keys: [P()] }) };
const p6 = { wallet: account({ keys: [P()], wallets: [W()] }), did: account({ keys: [P()], dids: [didKey()] }) };
// Removals and a sign-out nothing could settle.
const c17 = account({ keys: [P(), P()], wallets: [W()], dids: [didKey(), didKey()] });
// Adds through /auth/siwe, /auth/did and /wallet/link whose account the other instance signed out
// everywhere within this server's 10 s; a sign-out the pod took that nothing could read after; a
// deletion retried while the pod cannot be read; removals of a wallet or DID this server's copy
// did not list yet.
const a12 = { siwe: account({ keys: [P()] }), did: account({ keys: [P()] }), link: account({ keys: [P()] }) };
const c21 = account({ keys: [P()] });
const j7 = account({ keys: [P()] });
const p7 = { wallet: account({ keys: [P()] }), did: account({ keys: [P()] }) };
const p8 = { wallet: account({ keys: [P()] }), did: account({ keys: [P()] }), stranger: account({ keys: [P()] }) };
// Accounts whose deletion was answered 503 and that an operator re-opens by hand before its retry:
// as documented (the tombstone's session epoch kept), and with the epoch put back to the token's.
const p13 = { kept: account({ keys: [P()] }), reset: account({ keys: [P()] }) };
// Owners whose bearer adds nothing could settle, while first sign-ins fill their share of the records (S10).
const s10 = [account({ keys: [P()] }), account({ keys: [P()] }), account({ keys: [P()] })];
// An owner whose bearer add of a did:key nothing could settle, after did:key first sign-ins filled their share (S11).
const s11 = account({ keys: [P()] });
// A claimed u-try- account for L2's deletion, made in before() so that no other /try runs beside the
// /try cases of the concurrent block below (they find their own id by its shape).
let l2Try: Reply;
// U1's u-try- account, made in before() for the same reason.
let u1Try: Reply;
// Accounts whose write the pod never answers and stores later: right after the read the writer
// makes once its write timed out ('early'), or only after the route has answered ('late').
const l1 = {
  early: { wallet: account({ keys: [P()] }), did: account({ keys: [P()] }), link: account({ keys: [P()] }), device: account({ keys: [P()] }) },
  late: { wallet: account({ keys: [P()] }), did: account({ keys: [P()] }), link: account({ keys: [P()] }), del: account({ keys: [P()] }) },
};
// Accounts whose write the pod never answers and stores only after the route has answered, while
// the write-back that would settle it (the fence) gets no answer either.
const l2 = { add: account({ keys: [P()] }), link: account({ keys: [P()] }), did: account({ keys: [P()] }),
  blind: account({ keys: [P()] }), device: account({ keys: [P()] }) };
// Removals the pod takes without confirming them; a scan overlapped by a write nothing could settle.
const c14 = account({ keys: [P(), P()], wallets: [W(), W()], dids: [didKey()] });
const b12 = account({ keys: [P()] });
const play = { key: P(), id: `u-try-play-${crypto.randomBytes(16).toString('hex')}` };
// Claimed Play owners (a passkey each) whose writes meet another writer's change.
const playId = () => `u-try-play-${crypto.randomBytes(16).toString('hex')}`;
const playCas = { add: { key: P(), id: playId() }, remove: { key: P(), id: playId(), wallet: W() }, out: { key: P(), id: playId() } };
// Deletions the pod took without confirming them; wallet and DID decisions while a pod is unreadable;
// accounts whose pod never answers.
const j1 = { applied: account({ keys: [P()] }), blind: account({ keys: [P()] }) };
const j3 = account({ keys: [P()], wallets: [W()], dids: [didKey()] });
const hung = { write: account({ keys: [P()] }), read: account({ keys: [P()] }), create: account({ keys: [P()] }) };
const del4 = { pk: account({ keys: [P()] }) };
const scanned = account({ keys: [P()] });
const unlistedEth = W();
const h4 = { key: P() };
// Passkeys whose relying party is pinned already: a synced one (counter 0) and a counting one.
const h1 = { id: 'zz-h1', key: P() };
const h2 = { id: 'zz-h2', key: P() };
// One credential id on three accounts, each with a key of its own: the earliest-enrolled verifies.
const h4ids = ['zz-h4-a', 'zz-h4-b', 'zz-h4-c'];
const sameId = (k: SoftPasskey) => softPasskey(k.rawId);
// Accounts the other instance opened after this one listed the pods (so never loaded here), each
// derived from a wallet it no longer lists and holding one credential of another kind.
const unloaded = (from: AnyWallet) => deriveUserIdFromWallet(from.address.toLowerCase());
const j5 = { wallet: { from: W(), holds: W() }, did: { from: W(), holds: didKey() }, passkey: { from: W(), holds: P() } };
// Unclaimed Play owners whose anchor has expired, for the janitor to purge.
function playOwner() {
  const jwk = publicJwk(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey) as { x: string; y: string };
  const key = { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y } as const;
  const thumb = playKeyThumbprint(key as Parameters<typeof playKeyThumbprint>[0]);
  return { key, thumb, id: provisionalUserId('game.example', thumb), invite: crypto.randomBytes(12).toString('hex') };
}
const expiredPlay = playOwner();
const fencedPlay = playOwner();
/** The anchor an identity server at `issuer` sealed for `owner` an hour ago, as provisional-play.ts seals one. */
function expiredAnchor(issuer: string, owner = expiredPlay): string {
  const now = Math.floor(Date.now() / 1000);
  const { id, key: playKey, thumb: playThumb } = owner;
  const claims = { version: 1, issuer, audience: 'game.example', userId: id, ownerDid: `did:web:x:users:${id}`, webId: `${issuer}/users/${id}/profile#me`,
    podUrl: `http://127.0.0.1:${podPort}/${id}/`, authenticatedAgentId: `play-${id}`, authenticatedAgentDid: `did:web:x:agents:play-${id}`,
    publicKeyJwk: playKey, proofKeyThumbprint: playThumb, issuedAt: now - 7200, expiresAt: now - 3600,
    capabilities: ['human-play', 'own-pod-checkpoint'], provisional: true };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', Buffer.from(tokenSigningKey, 'base64')).update(`interego-play-attestation-v1\0${encoded}`).digest('base64url');
  return `ipa1_${encoded}.${signature}`;
}
const PLAY_AUDIENCE = 'https://game.example';
const PLAY_CLIENTS = JSON.stringify({ [PLAY_AUDIENCE]: { agentDid: 'did:web:game.example:agents:game', podUrl: 'https://pod.example/game/' } });
/**
 * A Play owner whose anchor an identity server at `issuer` sealed a minute ago (valid for
 * `ttlSeconds` from now, an hour by default, for the audience PLAY_CLIENTS allows), seeded on its
 * pod, and a guest token for it as that server issues one; `expiresAt` is its guest deadline (s).
 * The anchor is sealed with `sealKey`: by default the key the servers share; any other makes an
 * anchor that does not open to the owner (the token itself is still a good one).
 */
function livePlayGuest(issuer: string, sealKey = Buffer.from(tokenSigningKey, 'base64'), ttlSeconds = 3600): { id: string; token: string; expiresAt: number } {
  const jwk = publicJwk(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey) as { x: string; y: string };
  const key = { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y } as const;
  const thumb = playKeyThumbprint(key as Parameters<typeof playKeyThumbprint>[0]);
  const id = provisionalUserId(PLAY_AUDIENCE, thumb);
  const now = Math.floor(Date.now() / 1000);
  const agentId = `play-${id}`;
  const claims = { version: 1, issuer, audience: PLAY_AUDIENCE, userId: id, ownerDid: `did:web:x:users:${id}`, webId: `${issuer}/users/${id}/profile#me`,
    podUrl: `http://127.0.0.1:${podPort}/${id}/`, authenticatedAgentId: agentId, authenticatedAgentDid: `did:web:x:agents:${agentId}`,
    publicKeyJwk: key, proofKeyThumbprint: thumb, issuedAt: now - 60, expiresAt: now + ttlSeconds,
    capabilities: ['human-play', 'own-pod-checkpoint'], provisional: true };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const seal = crypto.createHmac('sha256', sealKey).update(`interego-play-attestation-v1\0${encoded}`).digest('base64url');
  docs.set(id, { modified: clock = Math.max(clock + 1, Date.now()), doc: { userId: id, name: 'Play guest',
    walletAddresses: [], webAuthnCredentials: [], didKeys: [], provisionalPlayAnchor: `ipa1_${encoded}.${seal}` } });
  const b64 = Buffer.from(JSON.stringify({ userId: id, agentId, scope: 'ReadWrite', issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), epoch: 0,
    provisionalPlay: { audience: PLAY_AUDIENCE, proofKeyThumbprint: thumb, expiresAt: claims.expiresAt } })).toString('base64url');
  return { id, expiresAt: claims.expiresAt,
    token: `cg2_${b64}.${crypto.createHmac('sha256', Buffer.from(tokenSigningKey, 'base64')).update(b64).digest('base64url')}` };
}

/**
 * Two identity instances on the same pods (a deploy's overlap), A and B, whose provisioning routes
 * (`/play/provisional`) ask a stand-in relay that vouches for the game's service agent; and one
 * guest key, whose owner is `id`. `provision(inst)` is the guest's bootstrap through `inst`, with a
 * fresh grant for its key (signed as the relay signs one, with the key's proof over it): its guest
 * token and agent. `stop()` stops both instances and the relay.
 */
async function playGuestOnTwoInstances(): Promise<{ id: string; a: Instance; b: Instance;
  provision(inst: Instance): Promise<{ token: string; agentId: string }>; stop(): Promise<void> }> {
  const relayWallet = Wallet.createRandom();
  const GAME_POD = 'https://pod.example/game/';
  const relay = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url !== '/tool/verify_agent') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ verified: true, subject_pod_url: GAME_POD,
        signing: { relayAnchor: relayWallet.address, canSignDelegatedRequests: true } }));
    });
  });
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  const closeRelay = () => new Promise<void>(resolve => relay.close(() => resolve()));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicJwk(publicKey) as { x: string; y: string };
  const key = { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y } as const;
  const thumb = playKeyThumbprint(key as Parameters<typeof playKeyThumbprint>[0]);
  const id = provisionalUserId(PLAY_AUDIENCE, thumb);
  const grant = async () => {
    const _signed_payload = JSON.stringify({ audience: PLAY_AUDIENCE, purpose: 'interego-play-provisional-v1',
      agent_id: 'did:web:game.example:agents:game', subject_pod_url: GAME_POD, publicKeyThumbprint: thumb,
      challenge: crypto.randomBytes(24).toString('base64url'), timestamp: new Date().toISOString(), expiresAt: Math.floor(Date.now() / 1000) + 60 });
    const _signature = await relayWallet.signMessage(`sha256:${crypto.createHash('sha256').update(_signed_payload, 'utf8').digest('hex')}`);
    const proof = crypto.sign('sha256', Buffer.from(`interego-play-provisional-v1\n${_signed_payload}\n${_signature}`, 'utf8'),
      { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return { playGrant: { _signed_payload, _signature }, publicKeyJwk: key, proof };
  };
  const portA = await freePort();
  const env = { CSS_PUBLIC_URL: 'https://pods.example/', PROVISIONAL_PLAY_CLIENTS: PLAY_CLIENTS,
    RELAY_URL: `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}` };
  let a: Instance | undefined;
  let b: Instance;
  try {
    a = await startIdentity(portA, env);
    b = await startIdentity(await freePort(), { ...env, BASE_URL: `http://127.0.0.1:${portA}` });
  } catch (err) {
    await a?.stop();
    await closeRelay();
    throw err;
  }
  return {
    id, a, b,
    provision: async inst => {
      const r = await post('/play/provisional', await grant(), undefined, inst);
      assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out(inst)}`);
      assert.equal(r.json['userId'], id);
      return { token: String(r.json['token']), agentId: String(r.json['agentId']) };
    },
    stop: async () => {
      await b.stop();
      await a!.stop();
      await closeRelay();
    },
  };
}

before(async () => {
  podServer = http.createServer((req, res) => { void servePods(req, res); });
  await new Promise<void>(resolve => podServer.listen(0, '127.0.0.1', resolve));
  podPort = (podServer.address() as net.AddressInfo).port;
  primaryPodServer = http.createServer((req, res) => { void servePods(req, res); });
  await new Promise<void>(resolve => primaryPodServer.listen(0, '127.0.0.1', resolve));
  primaryPodPort = (primaryPodServer.address() as net.AddressInfo).port;
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  // Passkeys whose relying party is pinned already (a counter-0 synced passkey, and a counting one).
  seed(h1.id, { keys: [h1.key], pin: origin });
  seed(h2.id, { keys: [h2.key], pin: origin });
  seed(t8.owner.userId, { keys: t8.owner.keys, dids: [t8.key] });
  docs.get(t8.owner.userId)!.doc['didKeys'] = [{ ...didEntry(t8.key), createdAt: '2024-01-01T00:00:00.000Z' }];
  seed(deriveUserIdFromDid(t8.key.did), { dids: [t8.key], keys: [P()] });
  for (const t of [t9, t9u]) {
    seed(t.y.userId, { keys: t.y.keys, dids: [] });
    docs.get(t.y.userId)!.doc['didKeys'] = [didEntry(t.key, t.did)];
  }
  seed(k4.owner.userId, { keys: k4.owner.keys });
  docs.get(k4.owner.userId)!.doc['didKeys'] = [didEntry(k4.key, k4.did)];
  seed(play.id, { keys: [play.key] });
  seed(playCas.add.id, { keys: [playCas.add.key] });
  seed(playCas.remove.id, { keys: [playCas.remove.key], wallets: [playCas.remove.wallet] });
  seed(playCas.out.id, { keys: [playCas.out.key] });
  const h4a = h4.key; const h4b = sameId(h4a); const h4c = sameId(h4a);
  docs.set(h4ids[0]!, { modified: ++clock, doc: { userId: h4ids[0], name: 'a', walletAddresses: [], didKeys: [], webAuthnCredentials: [stored(h4a, 0, origin, '2024-01-01T00:00:00.000Z')] } });
  docs.set(h4ids[1]!, { modified: ++clock, doc: { userId: h4ids[1], name: 'b', walletAddresses: [], didKeys: [], webAuthnCredentials: [stored(h4b, 0, origin, '2025-06-01T00:00:00.000Z')] } });
  docs.set(h4ids[2]!, { modified: ++clock, doc: { userId: h4ids[2], name: 'c', walletAddresses: [], didKeys: [], webAuthnCredentials: [stored(h4c, 0, origin, '2025-07-01T00:00:00.000Z')] } });
  // An account derived from a wallet, on its pod but not in the listing (opened on the other instance).
  seed(deriveUserIdFromWallet(unlistedEth.address.toLowerCase()), { wallets: [unlistedEth] });
  unlisted.add(deriveUserIdFromWallet(unlistedEth.address.toLowerCase()));
  seed(unloaded(j5.wallet.from), { wallets: [j5.wallet.holds] });
  seed(unloaded(j5.did.from), { dids: [j5.did.holds] });
  seed(unloaded(j5.passkey.from), { keys: [j5.passkey.holds] });
  for (const x of Object.values(j5)) unlisted.add(unloaded(x.from));
  primary = await startIdentity(port, { CSS_URL: `http://127.0.0.1:${primaryPodPort}/` });
  l2Try = await post('/try', {});
  u1Try = await post('/try', {});
});

after(async () => {
  for (const inst of instances) await inst.stop();
  await closeServer(podServer);
  await closeServer(primaryPodServer);
});

// ── S0. The stand-in itself ─────────────────────────────────────────────────────────────────
test('S0: the stand-in pod answers as CSS 7.2 with the PGSL accessor answered the same requests when probed', async () => {
  // Measured against the production stack (CSS 7.2.0 and integrations/pgsl-css-accessor on
  // postgres:16). The stand-in used to give stock CSS's ETag ("<ms>-application/ld+json"), answer
  // 201 to a PUT that replaced a document, have no containers (a container PUT was always a 201,
  // its GET a 404) and answer 205 to anything but a GET of a pod's other documents.
  const pods = `http://127.0.0.1:${podPort}`;
  const send = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
    fetch(`${pods}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  const containerPut = (path: string) => send('PUT', path, { 'Content-Type': 'text/turtle', Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' }, '');
  const json = { 'Content-Type': 'application/ld+json' };
  const etagOfGet = async (path: string) => (await send('GET', path)).headers.get('etag');
  const a = `zz-s0-${crypto.randomBytes(4).toString('hex')}`;
  const b = `${a}-b`;
  const doc = (id: string) => `/${id}/auth-methods.jsonld`;
  const body = JSON.stringify({ userId: a, walletAddresses: [], webAuthnCredentials: [], didKeys: [] });
  // A container: created once (201); a PUT of it again is a 409 and leaves it as it is.
  assert.equal((await containerPut(`/${a}/`)).status, 201);
  assert.equal((await containerPut(`/${a}/`)).status, 409);
  assert.equal((await send('GET', `/${a}/`)).status, 200);
  // A document: created with If-None-Match: * (201), which then fails (412).
  assert.equal((await send('PUT', doc(a), { ...json, 'If-None-Match': '*' }, body)).status, 201);
  assert.equal((await send('PUT', doc(a), { ...json, 'If-None-Match': '*' }, body)).status, 412);
  const e1 = await etagOfGet(doc(a));
  assert.match(String(e1), /^"sha256:[0-9a-f]{64}-ce807c5b456dd448"$/, 'the accessor\'s ETag: the revision, and the content type\'s digest');
  // Replaced on its ETag (205), with a new ETag even for identical bytes; the old one is then stale.
  assert.equal((await send('PUT', doc(a), { ...json, 'If-Match': e1! }, body)).status, 205);
  const e2 = await etagOfGet(doc(a));
  assert.notEqual(e2, e1);
  assert.equal((await send('PUT', doc(a), { ...json, 'If-Match': e1! }, body)).status, 412);
  // A missing document: If-Match: * fails, If-Match on an ETag creates it (with its container).
  assert.equal((await send('PUT', doc(b), { ...json, 'If-Match': '*' }, body)).status, 412);
  assert.equal((await send('GET', doc(b))).status, 404);
  assert.equal((await send('PUT', doc(b), { ...json, 'If-Match': e2! }, body)).status, 201);
  assert.equal((await send('PUT', doc(b), { ...json, 'If-Match': e2! }, body)).status, 412);
  const listedB = await send('GET', `/${b}/`);
  assert.equal(listedB.status, 200);
  assert.match(await listedB.text(), /ldp:contains <auth-methods\.jsonld>/);
  // A DELETE of a missing document is a 404 whatever its condition; of one, it checks it first.
  const eb = await etagOfGet(doc(b));
  assert.equal((await send('DELETE', doc(b), { 'If-Match': e2! })).status, 412);
  assert.equal((await send('DELETE', doc(b), { 'If-None-Match': '*' })).status, 412);
  assert.equal((await send('DELETE', doc(b), { 'If-Match': eb! })).status, 205);
  assert.equal((await send('GET', doc(b))).status, 404);
  assert.equal((await send('DELETE', doc(b), { 'If-Match': eb! })).status, 404);
  assert.equal((await send('DELETE', doc(b), { 'If-Match': '*' })).status, 404);
  // Its container stays, listing nothing.
  const after = await send('GET', `/${b}/`);
  assert.equal(after.status, 200);
  assert.doesNotMatch(await after.text(), /auth-methods/);
  assert.equal((await containerPut(`/${b}/`)).status, 409);
  // A pod's other document: 404 until written (201), then replaced (205), deleted (205), 404 again.
  assert.equal((await send('DELETE', `/${a}/agents`)).status, 404);
  assert.equal((await send('HEAD', `/${a}/agents`)).status, 404);
  assert.equal((await send('PUT', `/${a}/agents`, { 'Content-Type': 'text/turtle' }, '')).status, 201);
  assert.match(String(await etagOfGet(`/${a}/agents`)), /^"sha256:[0-9a-f]{64}-d295df4e11ae61a5"$/);
  assert.equal((await send('PUT', `/${a}/agents`, { 'Content-Type': 'text/turtle' }, '')).status, 205);
  // Its listing names its children sorted by name, as the store lists them (listChildren in
  // packages/pgsl-store; the probe on Postgres recorded no listing body, the accessor's in-memory
  // backend answered this order). It used to assert the record first, which the store never gives.
  assert.match(await (await send('GET', `/${a}/`)).text(), /ldp:contains <agents>, <auth-methods\.jsonld>/, 'its children, by name');
  assert.equal((await send('DELETE', `/${a}/agents`)).status, 205);
  assert.equal((await send('DELETE', `/${a}/agents`)).status, 404);
  // A guest's game save and its write budget, committed natively as the css-gate commits them: the
  // store keeps each as a native-managed head and refuses every plain PUT or DELETE of it with 409,
  // whatever its If-Match (the probe sent none, its ETag, and *), and keeps it. A container that
  // holds one is not empty, and its DELETE is a 409 too. The stand-in used to have no native heads
  // and no containers below a pod's own, and deleted a "checkpoint" with 205.
  const save = saveGame(a);
  const nativeRefusal = async (r: Response) => {
    assert.equal(r.status, 409);
    assert.match(await r.text(), /"message":"This resource requires a native conditional commit"/);
  };
  const saveEtag = String(await etagOfGet(save));
  assert.match(saveEtag, /^"sha256:[0-9a-f]{64}-bacb769b46f6d169"$/);
  await nativeRefusal(await send('DELETE', save));
  await nativeRefusal(await send('DELETE', save, { 'If-Match': saveEtag }));
  await nativeRefusal(await send('DELETE', save, { 'If-Match': '*' }));
  await nativeRefusal(await send('PUT', save, { 'Content-Type': 'application/json' }, '{}'));
  await nativeRefusal(await send('DELETE', `/${a}/play-budget.json`));
  await nativeRefusal(await send('DELETE', `/${a}/play-budget.json`, { 'If-Match': String(await etagOfGet(`/${a}/play-budget.json`)) }));
  assert.equal((await send('GET', save)).status, 200);
  assert.equal(await etagOfGet(save), saveEtag, 'nothing of it changed');
  // Listed by name, as the store lists children (above); the probe recorded these listings only in part.
  assert.match(await (await send('GET', `/${a}/`)).text(), /ldp:contains <auth-methods\.jsonld>, <hallowmarch\/>, <play-budget\.json>/);
  assert.match(await (await send('GET', `/${a}/hallowmarch/`)).text(), /ldp:contains <checkpoints\/>/);
  for (const container of [`/${a}/hallowmarch/checkpoints/`, `/${a}/hallowmarch/`]) {
    const r = await send('DELETE', container);
    assert.equal(r.status, 409);
    assert.match(await r.text(), /"message":"Can only delete empty containers\."/);
  }
  // The root lists both pods, as containers.
  const root = await (await send('GET', '/')).text();
  assert.ok(root.includes(`<${a}/>`) && root.includes(`<${b}/>`), root);
  // Out of the way of every test after this one, its requests included (I4 checks that no record
  // was ever removed).
  for (const id of [a, b]) { docs.delete(id); containers.delete(id); unlisted.add(id); }
  for (const p of [...others.keys(), ...subContainers]) if (p.startsWith(`/${a}/`)) { others.delete(p); subContainers.delete(p); }
  for (let i = requests.length - 1; i >= 0; i--) if (requests[i]!.userId.startsWith(a)) requests.splice(i, 1);
  for (let i = otherRequests.length - 1; i >= 0; i--) if (otherRequests[i]!.path.startsWith(`/${a}`)) otherRequests.splice(i, 1);
});

// ── A. Edits made by another instance or an operator, within this server's 10 s ─────────────
test('A1: a passkey sign-in writes only its counter into the record as the pod holds it', async () => {
  const [p1, p2] = a1.keys;
  const token = await tokenFor(p1!, 1, a1.userId);
  outOfBand(a1.userId, d => {
    d['walletAddresses'] = [];
    d['webAuthnCredentials'] = (d['webAuthnCredentials'] as Array<{ id: string }>).filter(c => c.id !== p2!.id);
    d['sessionEpoch'] = 3;
  });
  const edited = structuredClone(record(a1.userId)!);
  await signsInTo(signIn(p1!, 2), a1.userId);
  const after = record(a1.userId)!;
  assert.deepEqual(after.walletAddresses, []);
  assert.deepEqual(after.webAuthnCredentials.map(c => c.id), [p1!.id]);
  assert.equal(after.sessionEpoch, 3);
  assert.equal(credentialOf(a1.userId, p1!)!.counter, 2);
  assert.deepEqual({ ...after, webAuthnCredentials: [] }, { ...edited, webAuthnCredentials: [] });
  // And this server holds that record: the removed wallet and passkey, and the old token, are refused.
  assert.equal((await siwe(a1.wallets![0]!, { existingOnly: true })).status, 401);
  assert.equal((await signIn(p2!, 1)).status, 401);
  assert.equal((await me(token)).status, 401);
});

test('A2: a passkey removed out of band signs in nowhere, writes nothing, and leaves the index', async () => {
  const [p1] = a2.keys;
  outOfBand(a2.userId, d => { d['webAuthnCredentials'] = []; });
  const since = mark();
  const first = await signIn(p1!, 1);
  assert.equal(first.status, 401, JSON.stringify(first.json));
  assert.match(String(first.json['error']), /not on file/);
  const second = await signIn(p1!, 2);
  assert.equal(second.status, 401, JSON.stringify(second.json));
  assert.match(String(second.json['error']), /No WebAuthn credential matches/);
  assert.equal(docPuts(a2.userId, since).length, 0);
  assert.deepEqual(record(a2.userId)!.webAuthnCredentials, []);
});

test('A3: a wallet added with a bearer is added to the record as the pod holds it', async () => {
  const [p1, p2] = a3.keys;
  const token = await tokenFor(p1!, 1, a3.userId);
  outOfBand(a3.userId, d => { d['webAuthnCredentials'] = (d['webAuthnCredentials'] as Array<{ id: string }>).filter(c => c.id !== p2!.id); });
  const w = W();
  await signsInTo(siwe(w, { bearer: token }), a3.userId);
  // Answered only once the pod had it.
  assert.deepEqual(record(a3.userId)!.walletAddresses, [w.address.toLowerCase()]);
  assert.deepEqual(record(a3.userId)!.webAuthnCredentials.map(c => c.id), [p1!.id]);
  assert.equal((await signIn(p2!, 1)).status, 401);
});

test('A4: a device added with a bearer keeps a session epoch raised out of band; a bearer that epoch ended adds nothing', async () => {
  const token = await tokenFor(a4.keys[0]!, 1, a4.userId);
  // The other instance signs out everywhere: this server's copy still says epoch 0, so the old
  // token passes the options' check, but the registration's write sees the record's epoch and adds
  // nothing (it used to add the device to the signed-out account).
  outOfBand(a4.userId, d => { d['sessionEpoch'] = 2; });
  const ended = await addDevice(P(), token);
  assert.equal(ended.status, 401, `${JSON.stringify(ended.json)}${out()}`);
  assert.match(String(ended.json['error']), /signed out everywhere/);
  assert.deepEqual(record(a4.userId)!.webAuthnCredentials.map(c => c.id), [a4.keys[0]!.id]);
  // A token issued at that epoch adds the device, and the epoch stays as the pod has it.
  const current = await tokenFor(a4.keys[0]!, 2, a4.userId);
  const k2 = P();
  const added = await addDevice(k2, current);
  assert.equal(added.status, 200, `${JSON.stringify(added.json)}${out()}`);
  assert.equal(record(a4.userId)!.sessionEpoch, 2);
  assert.deepEqual(record(a4.userId)!.webAuthnCredentials.map(c => c.id), [a4.keys[0]!.id, k2.id]);
});

test('A5: a wallet removal keeps a did:key added out of band', async () => {
  const token = await tokenFor(a5.keys[0]!, 1, a5.userId);
  const k = didKey();
  outOfBand(a5.userId, d => { (d['didKeys'] as unknown[]).push(didEntry(k)); });
  const r = await del(`/auth-methods/me/wallet/${a5.wallets![0]!.address.toLowerCase()}`, token);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out()}`);
  assert.deepEqual(record(a5.userId)!.walletAddresses, []);
  assert.deepEqual(record(a5.userId)!.didKeys.map(x => x.did), [k.did]);
  await signsInTo(didSignIn(k), a5.userId);
});

test('A6: sign-out keeps a removal made out of band and raises the epoch above the pod\'s', async () => {
  const [p1, p2] = a6.keys;
  const token = await tokenFor(p1!, 1, a6.userId);
  outOfBand(a6.userId, d => {
    d['webAuthnCredentials'] = (d['webAuthnCredentials'] as Array<{ id: string }>).filter(c => c.id !== p2!.id);
    d['sessionEpoch'] = 5;
  });
  const r = await signOut(token);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out()}`);
  assert.equal(r.json['sessionEpoch'], 6);
  assert.equal(record(a6.userId)!.sessionEpoch, 6);
  assert.deepEqual(record(a6.userId)!.webAuthnCredentials.map(c => c.id), [p1!.id]);
  assert.equal((await me(token)).status, 401);
});

test('A12: a wallet or DID added with a bearer whose account the other instance signed out everywhere adds nothing, through /auth/siwe, /auth/did and /wallet/link', async () => {
  // This server's copy still says epoch 0, so each bearer passes the check made as its request
  // arrives; the add's write sees the record's epoch and adds nothing. /auth/siwe's check was the one
  // no case reached: S9 signs out through this server, whose copy then refuses the bearer earlier.
  const derivedOf = (w: AnyWallet) => deriveUserIdFromWallet(w.address.toLowerCase());
  const token = Object.fromEntries(await Promise.all(Object.entries(a12).map(async ([n, a]) => [n, await tokenFor(a.keys[0]!, 1, a.userId)] as const)));
  for (const a of Object.values(a12)) outOfBand(a.userId, d => { d['sessionEpoch'] = 2; });
  const w = W();
  const k = didKey();
  const linked = W();
  const replies = { siwe: await siwe(w, { bearer: token['siwe'] }), did: await didSignIn(k, { bearer: token['did'] }), link: await linkWallet(linked, token['link']!) };
  for (const [n, r] of Object.entries(replies)) {
    assert.equal(r.status, 401, `${n}: ${JSON.stringify(r.json)}${out()}`);
    assert.match(String(r.json['error']), /signed out everywhere/, n);
  }
  assert.deepEqual(record(a12.siwe.userId)!.walletAddresses, []);
  assert.deepEqual(record(a12.did.userId)!.didKeys, []);
  assert.deepEqual(record(a12.link.userId)!.walletAddresses, []);
  assert.equal(docs.has(derivedOf(w)), false, 'no account is opened for the wallet');
  assert.equal(docs.has(deriveUserIdFromDid(k.did)), false, 'no account is opened for the did:key');
  for (const a of Object.values(a12)) assert.equal(record(a.userId)!.sessionEpoch, 2);
});

test('A11: a wallet or DID sign-in writes nothing, even to an account whose pod dropped it a moment ago', async () => {
  outOfBand(a11.userId, d => { d['walletAddresses'] = []; d['didKeys'] = []; });
  const since = mark();
  // Within this server's 10 s the copy still lists them, so they sign in (documented), but
  // nothing puts them back on the pod.
  await signsInTo(siwe(a11.wallets![0]!), a11.userId);
  await signsInTo(didSignIn(a11.dids![0]!), a11.userId);
  assert.equal(docPuts(a11.userId, since).length, 0);
  assert.deepEqual(record(a11.userId)!.walletAddresses, []);
  assert.deepEqual(record(a11.userId)!.didKeys, []);
});

test('A9: a write that meets another writer\'s change between its read and its write reads again and keeps both', async () => {
  const k = didKey();
  const edit = (userId: string) => outOfBand(userId, d => { (d['didKeys'] as unknown[]).push(didEntry(k)); });
  const cas = async (userId: string, run: () => Promise<Reply>) => {
    const since = mark();
    const held = hold('GET', userId);
    const reply = run();
    assert.ok(await within(held.arrived, 5_000), `the writer never read the pod${out()}`);
    edit(userId);
    held.release();
    const r = await reply;
    assert.equal(r.status, 200, `${userId}: ${JSON.stringify(r.json)}${out()}`);
    assert.deepEqual(record(userId)!.didKeys.map(x => x.did), [k.did], userId);
    const puts = docPuts(userId, since);
    assert.deepEqual(puts.map(p => p.status), [412, 205], `${userId}: a stale write refused, then one built on the new record`);
    return r;
  };
  // A passkey sign-in still signs in, its check run again on the new record.
  const tokenS = await tokenFor(a9.signIn.keys[0]!, 1, a9.signIn.userId);
  assert.ok(tokenS);
  await cas(a9.signIn.userId, () => signIn(a9.signIn.keys[0]!, 2));
  assert.equal(credentialOf(a9.signIn.userId, a9.signIn.keys[0]!)!.counter, 2);
  // An added wallet.
  const tokenA = await tokenFor(a9.add.keys[0]!, 1, a9.add.userId);
  const w = W();
  await cas(a9.add.userId, () => siwe(w, { bearer: tokenA }));
  assert.deepEqual(record(a9.add.userId)!.walletAddresses, [w.address.toLowerCase()]);
  // A removal.
  const tokenR = await tokenFor(a9.remove.keys[0]!, 1, a9.remove.userId);
  await cas(a9.remove.userId, () => del(`/auth-methods/me/wallet/${a9.remove.wallets![0]!.address.toLowerCase()}`, tokenR));
  assert.deepEqual(record(a9.remove.userId)!.walletAddresses, []);
  // A sign-out.
  const tokenO = await tokenFor(a9.out.keys[0]!, 1, a9.out.userId);
  await cas(a9.out.userId, () => signOut(tokenO));
  assert.equal(record(a9.out.userId)!.sessionEpoch, 1);
  // A Play owner's add, removal and sign-out take the same path (they gave up at the first 412).
  const tokenPA = await tokenFor(playCas.add.key, 1, playCas.add.id);
  const wp = W();
  await cas(playCas.add.id, () => siwe(wp, { bearer: tokenPA }));
  assert.deepEqual(record(playCas.add.id)!.walletAddresses, [wp.address.toLowerCase()]);
  const tokenPR = await tokenFor(playCas.remove.key, 1, playCas.remove.id);
  await cas(playCas.remove.id, () => del(`/auth-methods/me/wallet/${playCas.remove.wallet.address.toLowerCase()}`, tokenPR));
  assert.deepEqual(record(playCas.remove.id)!.walletAddresses, []);
  const tokenPO = await tokenFor(playCas.out.key, 1, playCas.out.id);
  await cas(playCas.out.id, () => signOut(tokenPO));
  assert.equal(record(playCas.out.id)!.sessionEpoch, 1);
  assert.equal((await verify(tokenPO)).json['valid'], false);
});

test('A10, D3, E1: two instances on the same pods (a deploy\'s overlap) do not undo each other', async () => {
  const second = await startIdentity(await freePort());
  // A wallet removed on one instance stays removed after a passkey sign-in on the other.
  const token1 = await tokenFor(b1.keys[0]!, 1, b1.userId);
  const removed = await del(`/auth-methods/me/wallet/${b1.wallets![0]!.address.toLowerCase()}`, token1);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  await signsInTo(signIn(b1.keys[0]!, 2, second), b1.userId, second);
  assert.deepEqual(record(b1.userId)!.walletAddresses, []);
  assert.equal((await siwe(b1.wallets![0]!, { existingOnly: true }, second)).status, 401);
  // A sign-out on one instance is kept by every writer on the other.
  const tokenB = await tokenFor(b2.keys[0]!, 1, b2.userId);
  assert.equal((await signOut(tokenB)).status, 200);
  assert.equal(record(b2.userId)!.sessionEpoch, 1);
  const token2 = await tokenFor(b2.keys[0]!, 2, b2.userId, second);
  const k2 = P();
  assert.equal((await addDevice(k2, token2, second)).status, 200, out(second));
  assert.equal(record(b2.userId)!.sessionEpoch, 1);
  const w = W();
  await signsInTo(siwe(w, { bearer: token2 }, second), b2.userId, second);
  assert.equal(record(b2.userId)!.sessionEpoch, 1);
  assert.equal((await del(`/auth-methods/me/wallet/${w.address.toLowerCase()}`, token2, undefined, second)).status, 200);
  assert.equal(record(b2.userId)!.sessionEpoch, 1);
  assert.deepEqual(record(b2.userId)!.webAuthnCredentials.map(c => c.id), [b2.keys[0]!.id, k2.id]);
  // Sign counters rise strictly across the two: a replay the other instance has seen is refused.
  const key = d3.keys[0]!;
  await signsInTo(signIn(key, 10), d3.userId);
  await signsInTo(signIn(key, 11, second), d3.userId, second);
  await signsInTo(signIn(key, 12, second), d3.userId, second);
  const replay = await signIn(key, 11);
  assert.equal(replay.status, 401, JSON.stringify(replay.json));
  assert.equal(credentialOf(d3.userId, key)!.counter, 12);
  await second.stop();
});

// ── B. Writers of one account on one instance, at the same time ─────────────────────────────
/** Hold a passkey sign-in on its read of the pod (under the account's lock), run `other`, then let go. */
async function duringSignIn(userId: string, key: SoftPasskey, counter: number, other: () => Promise<Reply>) {
  const held = hold('GET', userId);
  const signingIn = signIn(key, counter);
  assert.ok(await within(held.arrived, 5_000), `the sign-in never read the pod${out()}`);
  const otherReply = other();
  // The other writer waits for the account's lock: nothing it answers comes before the sign-in's write.
  assert.equal(await within(otherReply, 300), false, 'answered while the sign-in held the account');
  held.release();
  const [s, o] = await Promise.all([signingIn, otherReply]);
  assert.equal(s.status, 200, `${JSON.stringify(s.json)}${out()}`);
  assert.equal(o.status, 200, `${JSON.stringify(o.json)}${out()}`);
  return { s, o };
}

test('B1: a wallet added while a passkey sign-in holds the account is kept, and signs in to it', async () => {
  const key = raceAdd.keys[0]!;
  const token = await tokenFor(key, 1, raceAdd.userId);
  const w = W();
  await duringSignIn(raceAdd.userId, key, 2, () => siwe(w, { bearer: token }));
  assert.equal(credentialOf(raceAdd.userId, key)!.counter, 2);
  assert.deepEqual(record(raceAdd.userId)!.walletAddresses, [w.address.toLowerCase()]);
  await signsInTo(siwe(w, { existingOnly: true }), raceAdd.userId);
  assert.equal(docs.has(deriveUserIdFromWallet(w.address.toLowerCase())), false, 'no account opened for the wallet');
});

test('B2, B8: a device added while a legacy passkey signs in keeps both, and the relying-party pin', async () => {
  const key = c2.keys[0]!;
  assert.equal(credentialOf(c2.userId, key)!.rpId, undefined);
  const token = await tokenFor(key, 1, c2.userId);
  const k2 = P();
  await duringSignIn(c2.userId, key, 2, () => addDevice(k2, token));
  assert.equal(credentialOf(c2.userId, key)!.counter, 2);
  assert.equal(credentialOf(c2.userId, key)!.rpId, '127.0.0.1');
  await signsInTo(signIn(k2, 1), c2.userId);
});

test('B3: a sign-out while a passkey signs in keeps the counter, and a replayed assertion is refused', async () => {
  const key = raceSignOut.keys[0]!;
  const token = await tokenFor(key, 1, raceSignOut.userId);
  await duringSignIn(raceSignOut.userId, key, 2, () => signOut(token));
  assert.equal(credentialOf(raceSignOut.userId, key)!.counter, 2);
  assert.equal(record(raceSignOut.userId)!.sessionEpoch, 1);
  assert.equal((await signIn(key, 2)).status, 401);
});

test('B4: a wallet removal while a passkey signs in removes it and keeps the counter', async () => {
  const key = raceRemove.keys[0]!;
  const token = await tokenFor(key, 1, raceRemove.userId);
  await duringSignIn(raceRemove.userId, key, 2, () => del(`/auth-methods/me/wallet/${raceRemove.wallets![0]!.address.toLowerCase()}`, token));
  assert.equal(credentialOf(raceRemove.userId, key)!.counter, 2);
  assert.deepEqual(record(raceRemove.userId)!.walletAddresses, []);
});

test('B5: with pod latency, racing sign-ins, sign-outs and added devices undo nothing', async () => {
  latencyMs = 20;
  try {
    const key = raceOut.keys[0]!;
    let counter = 1;
    let token = await tokenFor(key, counter++, raceOut.userId);
    for (let i = 0; i < 6; i++) {
      const [s, o] = await Promise.all([signIn(key, counter++), signOut(token)]);
      assert.equal(s.status, 200, JSON.stringify(s.json));
      assert.equal(o.status, 200, JSON.stringify(o.json));
      token = await tokenFor(key, counter++, raceOut.userId);
    }
    assert.equal(record(raceOut.userId)!.sessionEpoch, 6);
    assert.equal(credentialOf(raceOut.userId, key)!.counter, counter - 1);
    const k = twoAdds.keys[0]!;
    let c = 1;
    const bearer = await tokenFor(k, c++, twoAdds.userId);
    const added: SoftPasskey[] = [];
    for (let i = 0; i < 6; i++) {
      const device = P();
      added.push(device);
      const [a, s] = await Promise.all([addDevice(device, bearer), signIn(k, c++)]);
      assert.equal(a.status, 200, JSON.stringify(a.json));
      assert.equal(s.status, 200, JSON.stringify(s.json));
    }
    assert.deepEqual(record(twoAdds.userId)!.webAuthnCredentials.map(x => x.id), [k.id, ...added.map(d => d.id)]);
    assert.equal(credentialOf(twoAdds.userId, k)!.counter, c - 1);
  } finally {
    latencyMs = 0;
  }
});

test('B7, C10: credentials added at once both land, and neither is acknowledged before the pod has it', async () => {
  const token = await tokenFor(c1.keys[0]!, 1, c1.userId);
  const w = W();
  const k = didKey();
  const held = hold('PUT', c1.userId);
  const addW = siwe(w, { bearer: token });
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  const addD = didSignIn(k, { bearer: token });
  assert.equal(await within(Promise.race([addW, addD]), 500), false, 'acknowledged while its write was held');
  // Nor does this server act on it before the pod has it: a sign-in with the wallet waits for the
  // add (K1), and then signs in to the account it was added to.
  const early = siwe(w, { existingOnly: true });
  assert.equal(await within(early, 500), false, 'a sign-in with the wallet being added was answered before the add');
  held.release();
  await signsInTo(addW, c1.userId);
  await signsInTo(addD, c1.userId);
  await signsInTo(early, c1.userId);
  assert.deepEqual(record(c1.userId)!.walletAddresses, [w.address.toLowerCase()]);
  assert.deepEqual(record(c1.userId)!.didKeys.map(x => x.did), [k.did]);
});

test('B10: a startup scan whose read a write overtook installs nothing', async () => {
  const token = await tokenFor(scanned.keys[0]!, 1, scanned.userId);
  // A third instance whose scan of this account is held; meanwhile it loads the account on demand
  // and signs it out.
  const held = hold('GET', scanned.userId);
  const third = await startIdentity(await freePort(), {}, false);
  assert.ok(await within(held.arrived, 20_000), `the scan never read the account${out(third)}`);
  const ch = await post('/challenges', { purpose: 'webauthn-authenticate', userId: scanned.userId }, undefined, third);
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  const r = await signOut(token, third);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out(third)}`);
  held.release();
  await third.ready;
  assert.equal((await me(token, third)).status, 401, 'the token signed out is refused');
  await third.stop();
});

test('B11: an on-demand load that a sign-in\'s load overtook still finds the account', async () => {
  const userId = deriveUserIdFromWallet(unlistedEth.address.toLowerCase());
  // A token for the unlisted account, from another instance.
  const other = await startIdentity(await freePort());
  const signedIn = await signsInTo(siwe(unlistedEth, {}, other), userId, other);
  await other.stop();
  const held = hold('GET', userId);
  const reading = me(String(signedIn.json['token']));
  assert.ok(await within(held.arrived, 5_000), `the token's account was never read${out()}`);
  await signsInTo(siwe(unlistedEth), userId);
  held.release();
  const r = await reading;
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out()}`);
});

test('B12: a startup scan whose read a failed write overlapped installs nothing, even when nothing could settle that write', async () => {
  const token = await tokenFor(b12.keys[0]!, 1, b12.userId);
  // A third instance's first pass cannot read the account, so its scan reads it again 2 s later.
  failingGets.set(b12.userId, 1);
  const since = mark();
  const third = await startIdentity(await freePort(), {}, false);
  assert.ok(await waitFor(() => docGets(b12.userId, since).find(g => g.status === 502), 20_000), `the scan never read the account${out(third)}`);
  // Meanwhile the account is loaded there on demand, and the scan's second read of it is held.
  const ch = await post('/challenges', { purpose: 'webauthn-authenticate', userId: b12.userId }, undefined, third);
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  const scan = hold('GET', b12.userId);
  assert.ok(await within(scan.arrived, 10_000), `the scan never read the account again${out(third)}`);
  // A sign-out the pod applies and answers 500, and the read after it fails too: nothing settles it.
  failPuts(b12.userId, 'apply-then-500');
  const put = hold('PUT', b12.userId, 1, () => { failingGets.set(b12.userId, 1); });
  void put.arrived.then(() => put.release());
  const r = await signOut(token, third);
  assert.equal(r.status, 503, `${JSON.stringify(r.json)}${out(third)}`);
  assert.equal(record(b12.userId)!.sessionEpoch, 1);
  scan.release();
  await third.ready;
  // The copy was marked stale, not replaced by the scan's older read: a token check answers from it
  // once (stale-while-revalidate) and its refresh reads the pod, so the token is refused within a
  // moment. Installed as fresh, the older read would have kept the token working for 10 s.
  let status = 0;
  for (let i = 0; i < 30 && (status = (await me(token, third)).status) !== 401; i++) await sleep(100);
  assert.equal(status, 401, 'the token signed out is refused');
  await third.stop();
});

// ── C. Writes the pod refuses, or never answers ─────────────────────────────────────────────
test('C1: a wallet the pod refused to add is not acknowledged, and does not sign in', async () => {
  const token = await tokenFor(f1.keys[0]!, 1, f1.userId);
  const w = W();
  failPuts(f1.userId, '500');
  const r = await siwe(w, { bearer: token });
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.equal(r.json['token'], undefined);
  assert.deepEqual(record(f1.userId)!.walletAddresses, []);
  assert.equal((await siwe(w, { existingOnly: true })).status, 401);
  await signsInTo(siwe(w, { bearer: token }), f1.userId);
  await signsInTo(siwe(w, { existingOnly: true }), f1.userId);
});

test('C2: a device the pod refused to add does not sign in, and a later sign-in neither carries nor loses it', async () => {
  const [p1] = f2.keys;
  const token = await tokenFor(p1!, 1, f2.userId);
  const k2 = P();
  failPuts(f2.userId, '500');
  const r = await addDevice(k2, token);
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.equal((await signIn(k2, 1)).status, 401);
  await signsInTo(signIn(p1!, 2), f2.userId);
  assert.deepEqual(record(f2.userId)!.webAuthnCredentials.map(c => c.id), [p1!.id]);
  assert.equal((await addDevice(k2, token)).status, 200);
  await signsInTo(signIn(p1!, 3), f2.userId);
  assert.deepEqual(record(f2.userId)!.webAuthnCredentials.map(c => c.id), [p1!.id, k2.id]);
  await signsInTo(signIn(k2, 1), f2.userId);
});

test('C3: a did:key the pod refused to add is not acknowledged and opens no account', async () => {
  const token = await tokenFor(f3.keys[0]!, 1, f3.userId);
  const k = didKey();
  failPuts(f3.userId, '500');
  const r = await didSignIn(k, { bearer: token });
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.deepEqual(record(f3.userId)!.didKeys, []);
  assert.equal(docs.has(deriveUserIdFromDid(k.did)), false);
  await signsInTo(didSignIn(k, { bearer: token }), f3.userId);
  await signsInTo(didSignIn(k), f3.userId);
});

test('C4: a bootstrap passkey the pod refused gives the invite back; each attempt reads once and writes no empty record', async () => {
  const key = P();
  failPuts(invites.pk.userId, '500');
  const first = await bootstrapPasskey(key, invites.pk);
  assert.equal(first.status, 503, JSON.stringify(first.json));
  assert.equal(docs.has(invites.pk.userId), false);
  const before = mark();
  const second = await bootstrapPasskey(key, invites.pk);
  assert.equal(second.status, 200, `${JSON.stringify(second.json)}${out()}`);
  assert.equal(second.json['userId'], invites.pk.userId);
  // The options read the seeded pod once, and the registration reads it once and writes it once.
  assert.equal(docGets(invites.pk.userId, before).length, 2);
  assert.equal(docPuts(invites.pk.userId, before).length, 1);
  for (const put of docPuts(invites.pk.userId)) {
    assert.equal((put.body!['webAuthnCredentials'] as unknown[]).length, 1, 'no empty record is written');
  }
  assert.deepEqual(record(invites.pk.userId)!.webAuthnCredentials.map(c => c.id), [key.id]);
});

test('C5: a removal the pod refused changes nothing here either', async () => {
  const token = await tokenFor(f5.keys[0]!, 1, f5.userId);
  const wallet = f5.wallets![0]!.address.toLowerCase();
  failPuts(f5.userId, '500');
  const r = await del(`/auth-methods/me/wallet/${wallet}`, token);
  assert.equal(r.status, 500, JSON.stringify(r.json));
  assert.deepEqual(record(f5.userId)!.walletAddresses, [wallet]);
  const listed = await me(token);
  assert.deepEqual(listed.json['walletAddresses'], [wallet], 'this server lists what the pod does');
  await signsInTo(siwe(f5.wallets![0]!), f5.userId);
  await signsInTo(didSignIn(f5.dids![0]!), f5.userId);
});

test('C6: a sign-out the pod refused leaves the session working; one it applied anyway is done, and answered so', async () => {
  const token = await tokenFor(f6.keys[0]!, 1, f6.userId);
  failPuts(f6.userId, '500');
  assert.equal((await signOut(token)).status, 500);
  assert.equal(record(f6.userId)!.sessionEpoch, undefined);
  assert.equal((await me(token)).status, 200);
  // The store applied it and answered 500: the pod's epoch is the one this server checks, and the
  // answer says the sign-out is done (it used to say it failed).
  failPuts(f6.userId, 'apply-then-500');
  const done = await signOut(token);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json['revoked'], true);
  assert.equal(done.json['sessionEpoch'], 1);
  assert.equal(record(f6.userId)!.sessionEpoch, 1);
  assert.equal((await me(token)).status, 401);
});

test('C7: a sign counter the pod refused is not advanced here; one it applied anyway is', async () => {
  const key = f7.keys[0]!;
  await tokenFor(key, 1, f7.userId);
  failPuts(f7.userId, '500');
  const r = await signIn(key, 5);
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.equal(credentialOf(f7.userId, key)!.counter, 1);
  await signsInTo(signIn(key, 2), f7.userId);
  assert.equal(credentialOf(f7.userId, key)!.counter, 2);
  // Applied, then 500: the pod holds the counter, so this is a sign-in (it used to answer 503), and
  // a replay of that counter is refused, as the pod's counter says.
  failPuts(f7.userId, 'apply-then-500');
  await signsInTo(signIn(key, 6), f7.userId);
  assert.equal(credentialOf(f7.userId, key)!.counter, 6);
  const replay = await signIn(key, 6);
  assert.equal(replay.status, 401, JSON.stringify(replay.json));
  assert.equal(credentialOf(f7.userId, key)!.counter, 6);
});

test('C8: a write the pod applied but answered 500 leaves this server holding what the pod holds', async () => {
  const token = await tokenFor(f8.keys[0]!, 1, f8.userId);
  const w = W();
  failPuts(f8.userId, 'apply-then-500');
  const r = await siwe(w, { bearer: token });
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.deepEqual(record(f8.userId)!.walletAddresses, [w.address.toLowerCase()]);
  await signsInTo(siwe(w, { existingOnly: true }), f8.userId);
  const since = mark();
  await signsInTo(siwe(w, { bearer: token }), f8.userId);
  assert.equal(docPuts(f8.userId, since).length, 0);
});

test('C14: a removal the pod took without confirming it is answered as done; one nothing could settle says it may or may not have been saved', async () => {
  const token = await tokenFor(c14.keys[0]!, 1, c14.userId);
  const [, p2] = c14.keys;
  const [w1, w2] = c14.wallets!;
  // Applied, then 500: the record the writer settled no longer lists it, so the answer is 200.
  failPuts(c14.userId, 'apply-then-500');
  const wallet = await del(`/auth-methods/me/wallet/${w1!.address.toLowerCase()}`, token);
  assert.equal(wallet.status, 200, `${JSON.stringify(wallet.json)}${out()}`);
  assert.equal(wallet.json['remaining'], 1);
  assert.equal((await del(`/auth-methods/me/wallet/${w1!.address.toLowerCase()}`, token)).status, 404);
  failPuts(c14.userId, 'apply-then-500');
  const did = await del('/auth-methods/me/did', token, { did: c14.dids![0]!.did });
  assert.equal(did.status, 200, JSON.stringify(did.json));
  assert.equal(did.json['remaining'], 0);
  failPuts(c14.userId, 'apply-then-500');
  const passkey = await del(`/auth-methods/me/webauthn/${encodeURIComponent(p2!.id)}`, token);
  assert.equal(passkey.status, 200, JSON.stringify(passkey.json));
  assert.equal(passkey.json['remaining'], 1);
  assert.equal((await signIn(p2!, 1)).status, 401);
  // Applied, then 500, and the read after it failed too: nothing settled it, and the answer says so.
  failPuts(c14.userId, 'apply-then-500');
  const put = hold('PUT', c14.userId, 1, () => { failingGets.set(c14.userId, 1); });
  void put.arrived.then(() => put.release());
  const unsure = await del(`/auth-methods/me/wallet/${w2!.address.toLowerCase()}`, token);
  assert.equal(unsure.status, 503, JSON.stringify(unsure.json));
  assert.match(String(unsure.json['detail']), /may or may not/);
  // It says the removal is safe to send again (it is), not to check GET /auth-methods/me, a plain
  // read that answers this server's copy from before the write while the pod cannot be read.
  assert.match(String(unsure.json['detail']), /Sending the same removal again is safe/);
  assert.doesNotMatch(JSON.stringify(unsure.json), /auth-methods\/me/);
  assert.deepEqual(record(c14.userId)!.walletAddresses, []);
  assert.equal((await del(`/auth-methods/me/wallet/${w2!.address.toLowerCase()}`, token)).status, 404, 'the repeat finds it removed');
  // A passkey sign-in whose counter write the pod applied and answered 500, with the read after it
  // failing: it may or may not have been saved, and is answered so (not "failed to persist"); the
  // next sign-in works.
  const [p1] = c14.keys;
  failPuts(c14.userId, 'apply-then-500');
  const counterPut = hold('PUT', c14.userId, 1, () => { failingGets.set(c14.userId, 1); });
  void counterPut.arrived.then(() => counterPut.release());
  const counted = await signIn(p1!, 5);
  assert.equal(counted.status, 503, JSON.stringify(counted.json));
  assert.match(String(counted.json['detail']), /may or may not have been saved/);
  assert.doesNotMatch(String(counted.json['error']), /failed to persist/);
  assert.equal(credentialOf(c14.userId, p1!)!.counter, 5, 'the pod holds the counter');
  await signsInTo(signIn(p1!, 6), c14.userId);
});

test('C15: a first sign-in that meets another writer\'s change at all three attempts logs identity_authmethods_write_conflict', async () => {
  const w = W();
  const id = deriveUserIdFromWallet(w.address.toLowerCase());
  // Each of its three writes meets a document written (then changed) under it.
  for (let i = 0; i < 3; i++) {
    const h = hold('PUT', id, 1, uid => { if (docs.has(uid)) outOfBand(uid, d => { d['name'] = `edit ${i}`; }); else seed(uid, {}); });
    void h.arrived.then(() => h.release());
  }
  const r = await siwe(w);
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.deepEqual(docPuts(id).map(p => p.status), [412, 412, 412]);
  assert.match(primary.output(), new RegExp(`identity_authmethods_write_conflict userId=${id} context=first-sign-in attempts=3`));
});

test('C9: every writer whose read of the pod fails answers 503 and writes nothing', async () => {
  const [p1, p2] = f9.keys;
  const token = await tokenFor(p1!, 1, f9.userId);
  const since = mark();
  failingGets.set(f9.userId, 1000);
  try {
    const attempts: Array<[string, () => Promise<Reply>]> = [
      ['add wallet', () => siwe(W(), { bearer: token })],
      ['add did', () => didSignIn(didKey(), { bearer: token })],
      ['add device', () => addDevice(P(), token)],
      ['remove passkey', () => del(`/auth-methods/me/webauthn/${encodeURIComponent(p2!.id)}`, token)],
      ['remove wallet', () => del(`/auth-methods/me/wallet/${f9.wallets![0]!.address.toLowerCase()}`, token)],
      ['remove did', () => del('/auth-methods/me/did', token, { did: f9.dids![0]!.did })],
      ['sign out', () => signOut(token)],
      ['passkey sign-in', () => signIn(p1!, 2)],
      ['delete', () => post('/users/me/delete', {}, token)],
    ];
    for (const [what, attempt] of attempts) {
      const r = await attempt();
      assert.equal(r.status, 503, `${what}: ${JSON.stringify(r.json)}${out()}`);
    }
  } finally {
    failingGets.delete(f9.userId);
  }
  assert.equal(docPuts(f9.userId, since).length, 0);
  assert.equal(record(f9.userId)!.deletedAt, undefined);
});

// ── C11 and L1 side by side: both wait out the writer's 15 s timeout, so they share it, which
// keeps the file's running time down (npm test runs this file on its own, with a 300 s limit).
// They touch different accounts, but U4 starts a server of its own, whose startup scan reads every
// account's record, C11's included: C11 holds the primary's reads alone (fromPrimary). Its hold of
// the first read once took that scan's read, so the sign-out's was answered (200, not 503).
// L: writes the pod never answers, and stores later. ──────────────────────────────────────────
describe('writes the pod never answers', { concurrency: true }, () => {
  test('C11: a pod that never answers holds an account\'s lock for at most 15 s for a read, and 30 s for a write and the read after it', { timeout: 50_000 }, async () => {
    const timed = async (reply: Promise<Reply>, from = Date.now()) => ({ ...(await reply), took: Date.now() - from });
    const tokenAnswered = await tokenFor(f11.keys[0]!, 1, f11.userId);
    const tokenWrite = await tokenFor(hung.write.keys[0]!, 1, hung.write.userId);
    const tokenCreate = await tokenFor(hung.create.keys[0]!, 1, hung.create.userId);
    // Last, so the bearer check of the sign-out below answers from the copy this sign-in installed
    // (under 10 s old) and reads nothing: the sign-out's read under its lock is the primary's only
    // read of this record, and the one firstRead holds.
    const tokenRead = await tokenFor(hung.read.keys[0]!, 1, hung.read.userId);
    const since = mark();
    /** A GET of `userId`'s record that arrives once a PUT of `target` was sent: the read after a failed write. */
    const afterPut = (userId: string, target: 'doc' | 'container') => (id: string) => id === userId
      && requests.slice(since).some(r => r.userId === userId && r.target === target && r.method === 'PUT');
    // Every hold here takes the primary's request alone: U4's server, starting beside this test,
    // reads each of these records in its startup scan.
    // A write the pod never answers; the read after it is answered.
    failPuts(f11.userId, 'hang');
    // A write the pod never answers, and the read after it neither.
    failPuts(hung.write.userId, 'hang');
    const rereadWrite = hold('GET', fromPrimary(afterPut(hung.write.userId, 'doc')));
    // A first read the pod never answers.
    const firstRead = hold('GET', fromPrimary(hung.read.userId));
    // A create (sign-out of an account whose document is gone): the container's PUT is never
    // answered, and the read after it neither. The document's PUT shares the write's timeout.
    docs.delete(hung.create.userId);
    hangingContainers.add(hung.create.userId);
    const rereadCreate = hold('GET', fromPrimary(afterPut(hung.create.userId, 'container')));
    try {
      const started = Date.now();
      const answered = timed(siwe(W(), { bearer: tokenAnswered }));
      const write = timed(siwe(W(), { bearer: tokenWrite }));
      const read = timed(signOut(tokenRead));
      const create = timed(signOut(tokenCreate));
      // Passkey sign-ins of the same accounts, a second later, wait for the lock.
      await sleep(1_000);
      const behindWrite = timed(signIn(hung.write.keys[0]!, 2), started);
      const behindRead = timed(signIn(hung.read.keys[0]!, 2), started);
      const [a, w, r, c, bw, br] = await Promise.all([answered, write, read, create, behindWrite, behindRead]);
      // Each also waits out every timeout it should (one request held 15 s, two 30 s): a request a
      // hold was meant for that was answered at once fails here, rather than passing sooner.
      assert.equal(a.status, 503, JSON.stringify(a.json));
      assert.ok(a.took >= 14_500 && a.took < 17_000, `a write and an answered read took ${a.took} ms`);
      assert.equal(w.status, 503, JSON.stringify(w.json));
      assert.ok(w.took >= 29_000 && w.took < 32_000, `a write and a read, neither answered, took ${w.took} ms`);
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert.ok(r.took >= 14_500 && r.took < 17_000, `a read never answered took ${r.took} ms`);
      assert.equal(c.status, 500, JSON.stringify(c.json));
      assert.ok(c.took >= 29_000 && c.took < 32_000, `a create and a read, neither answered, took ${c.took} ms`);
      assert.equal(docPuts(hung.create.userId, since).length, 0, 'no document is sent once the container used up the timeout');
      // Each writer read the record first, and read it again after its write failed (the primary's
      // reads: U4's server's startup scan reads these records too).
      for (const id of [hung.write.userId, hung.create.userId]) {
        const reads = docGets(id, since).filter(g => g.sender === 'primary').length;
        assert.ok(reads >= 2, `${id}: ${reads} read(s)`);
      }
      assert.equal(bw.status, 200, JSON.stringify(bw.json));
      assert.ok(bw.took >= 29_000 && bw.took < 32_000, `a sign-in behind the write was answered after ${bw.took} ms`);
      assert.equal(br.status, 200, JSON.stringify(br.json));
      assert.ok(br.took >= 14_500 && br.took < 17_000, `a sign-in behind the read was answered after ${br.took} ms`);
    } finally {
      for (const h of [rereadWrite, firstRead, rereadCreate]) h.release();
      hangingContainers.delete(hung.create.userId);
    }
    await signsInTo(signIn(f11.keys[0]!, 2), f11.userId);
  });

  test('L1: a write the pod never answered and stores later is settled before anything is decided: what was added, linked, claimed or deleted ends where the pod says', { timeout: 60_000 }, async () => {
    const derivedOf = (w: AnyWallet) => deriveUserIdFromWallet(w.address.toLowerCase());
    const token = {
      early: Object.fromEntries(await Promise.all(Object.entries(l1.early).map(async ([n, a]) => [n, await tokenFor(a.keys[0]!, 1, a.userId)] as const))),
      late: Object.fromEntries(await Promise.all(Object.entries(l1.late).map(async ([n, a]) => [n, await tokenFor(a.keys[0]!, 1, a.userId)] as const))),
    };
    const e = { wallet: W(), did: didKey(), link: W(), device: P(), claim: W(), first: W() };
    const l = { wallet: W(), did: didKey(), link: W(), claim: W(), first: W() };
    for (const a of Object.values(l1.early)) failPuts(a.userId, 'hang-then-apply');
    failPuts(invites.hangEarly.userId, 'hang-then-apply');
    failPuts(derivedOf(e.first), 'hang-then-apply');
    for (const a of Object.values(l1.late)) failPuts(a.userId, 'hang-then-apply-late');
    failPuts(invites.hangLate.userId, 'hang-then-apply-late');
    failPuts(derivedOf(l.first), 'hang-then-apply-late');
    const [eW, eD, eL, eV, eC, eF, lW, lD, lL, lC, lF, lX] = await Promise.all([
      siwe(e.wallet, { bearer: token.early['wallet'] }), didSignIn(e.did, { bearer: token.early['did'] }),
      linkWallet(e.link, token.early['link']!), addDevice(e.device, token.early['device']!),
      siwe(e.claim, bootstrap(invites.hangEarly)), siwe(e.first),
      siwe(l.wallet, { bearer: token.late['wallet'] }), didSignIn(l.did, { bearer: token.late['did'] }),
      linkWallet(l.link, token.late['link']!), siwe(l.claim, bootstrap(invites.hangLate)), siwe(l.first),
      post('/users/me/delete', {}, token.late['del']),
    ]);

    // Early: the pod stored each write right after the read that followed its timeout. That read saw
    // the old record; the record was written back on its ETag (the fence), which met the stored write,
    // and the read after it is what each answer is decided on.
    assert.equal(eW.status, 503, JSON.stringify(eW.json));
    assert.match(String(eW.json['detail']), /lists this wallet/);
    assert.equal(eD.status, 503, JSON.stringify(eD.json));
    assert.match(String(eD.json['detail']), /lists this DID/);
    assert.equal(eL.status, 200, JSON.stringify(eL.json));
    assert.equal(eV.status, 503, JSON.stringify(eV.json));
    assert.match(String(eV.json['detail']), /lists this passkey/);
    assert.equal(eC.status, 200, `${JSON.stringify(eC.json)}${out()}`);
    assert.equal(eC.json['userId'], invites.hangEarly.userId);
    assert.equal(eF.status, 200, JSON.stringify(eF.json));
    assert.equal(eF.json['userId'], derivedOf(e.first));
    await signsInTo(siwe(e.wallet), l1.early.wallet.userId);
    await signsInTo(didSignIn(e.did), l1.early.did.userId);
    await signsInTo(siwe(e.link), l1.early.link.userId);
    await signsInTo(signIn(e.device, 1), l1.early.device.userId);
    await signsInTo(siwe(e.claim), invites.hangEarly.userId);
    for (const w of [e.wallet, e.link, e.claim]) assert.equal(docs.has(derivedOf(w)), false, 'no account is opened for the wallet');
    assert.equal(docs.has(deriveUserIdFromDid(e.did.did)), false, 'no account is opened for the did:key');

    // Late: the pod gets round to each write only after the route answered. The fence made each one's
    // condition fail first, so none lands, and every answer was what the pod now holds.
    assert.equal(lW.status, 503, JSON.stringify(lW.json));
    assert.equal(lD.status, 503, JSON.stringify(lD.json));
    assert.equal(lL.status, 500, JSON.stringify(lL.json));
    // The fence wrote the seeded record back, and created an empty one for the derived id where there
    // was none: not "Nothing was changed", nor "Could not read this account", which they used to say.
    for (const r of [lC, lF]) {
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert.equal(r.json['error'], 'Your sign-in was not saved');
      assert.match(String(r.json['detail']), /did not take the write, so the credential was not added/);
      assert.doesNotMatch(String(r.json['detail']), /Nothing was changed/);
    }
    assert.equal(lX.status, 503, JSON.stringify(lX.json));
    assert.equal(lX.json['error'], 'Deletion not completed');
    const lateIds = [...Object.values(l1.late).map(a => a.userId), invites.hangLate.userId, derivedOf(l.first)];
    applyLate(lateIds);
    assert.deepEqual(heldOutcomes.filter(o => lateIds.includes(o.userId)).map(o => o.applied), lateIds.map(() => false),
      'no write held past its answer lands');
    assert.deepEqual(record(l1.late.wallet.userId)!.walletAddresses, []);
    assert.deepEqual(record(l1.late.did.userId)!.didKeys, []);
    assert.deepEqual(record(l1.late.link.userId)!.walletAddresses, []);
    assert.deepEqual(record(invites.hangLate.userId)!.walletAddresses, [], 'the claim did not land');
    assert.deepEqual(record(derivedOf(l.first))!.walletAddresses, [], 'the first sign-in did not land');
    assert.equal(record(l1.late.del.userId)!.deletedAt, undefined, 'the deletion did not land');
    assert.equal((await me(token.late['del']!)).status, 200);
    // And each retry does what was asked, on one account.
    await signsInTo(siwe(l.wallet, { bearer: token.late['wallet'] }), l1.late.wallet.userId);
    await signsInTo(siwe(l.wallet), l1.late.wallet.userId);
    await signsInTo(siwe(l.claim, bootstrap(invites.hangLate)), invites.hangLate.userId);
    await signsInTo(siwe(l.first), derivedOf(l.first));
    // Built on the empty record the fence left, the account takes the name it was asked for: it used
    // to keep the id as its name.
    assert.equal(record(derivedOf(l.first))!.name, 'Wallet');
  });

  test('L2: a write whose fence goes unanswered too is settled again with the condition it was sent on (by the route, or by the credential\'s next turn), so it cannot land after the answer; a hung probe ends a first sign-in at 15 s', { timeout: 90_000 }, async () => {
    const derivedOf = (w: AnyWallet) => deriveUserIdFromWallet(w.address.toLowerCase());
    const token = Object.fromEntries(await Promise.all(Object.entries(l2).map(async ([n, a]) => [n, await tokenFor(a.keys[0]!, 1, a.userId)] as const)));
    // A claimed u-try- account (a passkey added with its /try token), for its deletion.
    const tried = l2Try;
    assert.equal(tried.status, 200, JSON.stringify(tried.json));
    const tryId = String(tried.json['userId']);
    const tryKey = P();
    assert.equal((await addDevice(tryKey, String(tried.json['token']))).status, 200, out());
    // The write is never answered and is stored only at applyLate(); the fence the writer sends after
    // it gets no answer either. With `readFails`, the read the route then makes fails as well, so the
    // write is recorded, with its condition, for the credential's next turn.
    const unanswered = (userId: string, readFails = false) => {
      failPuts(userId, 'hang-then-apply-late', 'hang');
      if (!readFails) return;
      const fence = hold('PUT', userId, 2, () => { failingGets.set(userId, 1); });
      void fence.arrived.then(() => fence.release());
    };
    const w = { add: W(), link: W(), blind: W(), first: W(), claim: W(), blindClaim: W(), probeRoot: W(), probeAgents: W() };
    const k = { did: didKey(), blindClaim: didKey() };
    for (const a of [l2.add, l2.link, l2.did, l2.device]) unanswered(a.userId);
    unanswered(l2.blind.userId, true);
    unanswered(derivedOf(w.first));
    unanswered(invites.fenceClaim.userId);
    unanswered(invites.fenceBlind.userId, true);
    unanswered(invites.fenceBlindDid.userId, true);
    unanswered(invites.fencePk.userId);
    // The u-try- account's deletion: its tombstone is never answered and stored only at applyLate();
    // the fence after it is answered, so the route settles it.
    failPuts(tryId, 'hang-then-apply-late');
    // First sign-ins whose probe of the derived id's pod (deleted before tombstones?) is never
    // answered: the pod's root, where there is no record; its agent registry, where one without
    // credentials is.
    seed(derivedOf(w.probeAgents), {});
    const hungProbes = [`HEAD /${derivedOf(w.probeRoot)}/`, `HEAD /${derivedOf(w.probeAgents)}/agents`];
    for (const h of hungProbes) hangingOther.add(h);
    const timed = async (reply: Promise<Reply>, from = Date.now()) => ({ ...(await reply), took: Date.now() - from });
    let replies: Array<Reply & { took: number }>;
    try {
      replies = await Promise.all([
        siwe(w.add, { bearer: token['add'] }), linkWallet(w.link, token['link']!), didSignIn(k.did, { bearer: token['did'] }),
        siwe(w.blind, { bearer: token['blind'] }), siwe(w.first), siwe(w.claim, bootstrap(invites.fenceClaim)),
        siwe(w.blindClaim, bootstrap(invites.fenceBlind)), didSignIn(k.blindClaim, bootstrap(invites.fenceBlindDid)),
        addDevice(P(), token['device']!), bootstrapPasskey(P(), invites.fencePk), post('/users/me/delete', {}, String(tried.json['token'])),
        siwe(w.probeRoot), siwe(w.probeAgents),
      ].map(r => timed(r)));
    } finally {
      for (const h of hungProbes) hangingOther.delete(h);
    }
    const [add, link, did, blind, first, claim, blindClaim, blindClaimDid, device, pk, deletion, probeRoot, probeAgents] = replies;
    // Settled by the route: the read after the fence found the record as it was, and said so.
    for (const r of [add!, did!, device!, pk!]) {
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert.match(String(r.json['error']), /could not be confirmed/);
      assert.doesNotMatch(JSON.stringify(r.json), /may or may not|lists this/);
    }
    assert.equal(link!.status, 500, JSON.stringify(link!.json));
    // The fence that settled each wrote the record back (or an empty one): not saved, which is true,
    // rather than "Nothing was changed".
    for (const r of [first!, claim!]) {
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert.equal(r.json['error'], 'Your sign-in was not saved');
      assert.match(String(r.json['detail']), /did not take the write, so the credential was not added/);
    }
    assert.equal(deletion!.status, 503, JSON.stringify(deletion!.json));
    assert.equal(deletion!.json['error'], 'Deletion not completed');
    // Not settled by the route: recorded, and settled by the credential's next turn, which then decides.
    for (const r of [blind!, blindClaim!, blindClaimDid!]) {
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert.match(String(r.json['detail']), /may or may not/);
    }
    await signsInTo(siwe(w.blind), derivedOf(w.blind));
    await signsInTo(siwe(w.blindClaim), derivedOf(w.blindClaim));
    await signsInTo(didSignIn(k.blindClaim), deriveUserIdFromDid(k.blindClaim.did));
    // The hung probes ended their claims at the 15 s bound, and nothing was left holding the lock.
    for (const r of [probeRoot!, probeAgents!]) {
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert.ok(r.took < 20_000, `a first sign-in whose probe was never answered took ${r.took} ms`);
    }
    await signsInTo(siwe(w.probeRoot), derivedOf(w.probeRoot));

    // The pod gets round to each held write only now, after every answer and every decision above.
    // Each was fenced first, so none lands.
    const ids = [l2.add.userId, l2.link.userId, l2.did.userId, l2.device.userId, l2.blind.userId, derivedOf(w.first),
      invites.fenceClaim.userId, invites.fenceBlind.userId, invites.fenceBlindDid.userId, invites.fencePk.userId, tryId];
    applyLate(ids);
    assert.deepEqual(ids.map(id => heldOutcomes.filter(o => o.userId === id).map(o => o.applied)), ids.map(() => [false]),
      'no write held past its answer lands');
    for (const id of [l2.add.userId, l2.link.userId, l2.blind.userId, invites.fenceClaim.userId, invites.fenceBlind.userId, derivedOf(w.first)]) {
      assert.deepEqual(record(id)!.walletAddresses, [], `${id} lists no wallet`);
    }
    for (const id of [l2.did.userId, invites.fenceBlindDid.userId]) assert.deepEqual(record(id)!.didKeys, [], `${id} lists no DID`);
    assert.equal(record(l2.device.userId)!.webAuthnCredentials.length, 1);
    assert.deepEqual(record(invites.fencePk.userId)!.webAuthnCredentials, []);
    await signsInTo(signIn(tryKey, 1), tryId);
  });

  test('P1: a removal first settles an add of the same wallet or DID that nothing could settle, so the add cannot land after the removal\'s 404', { timeout: 60_000 }, async () => {
    const tokenW = await tokenFor(p1.wallet.keys[0]!, 1, p1.wallet.userId);
    const tokenD = await tokenFor(p1.did.keys[0]!, 1, p1.did.userId);
    // The add is never answered and is stored (if its condition still holds) only at applyLate();
    // the fence after it gets no answer, and the read the route then makes fails: the add is
    // recorded as unconfirmed, for the credential's next turn.
    for (const id of [p1.wallet.userId, p1.did.userId]) {
      failPuts(id, 'hang-then-apply-late', 'hang');
      const fence = hold('PUT', id, 2, () => { failingGets.set(id, 1); });
      void fence.arrived.then(() => fence.release());
    }
    const w = W();
    const k = didKey();
    const [addW, addD] = await Promise.all([siwe(w, { bearer: tokenW }), didSignIn(k, { bearer: tokenD })]);
    for (const r of [addW, addD]) {
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert.match(String(r.json['detail']), /may or may not/);
    }
    // The owner removes the credential. The removal takes its turn, which settles the account first
    // (the fence lands where the record has not moved), so the 404 is what the pod will go on holding.
    const [removeW, removeD] = await Promise.all([
      del(`/auth-methods/me/wallet/${w.address.toLowerCase()}`, tokenW),
      del('/auth-methods/me/did', tokenD, { did: k.did }),
    ]);
    assert.equal(removeW.status, 404, `${JSON.stringify(removeW.json)}${out()}`);
    assert.equal(removeD.status, 404, JSON.stringify(removeD.json));
    // The pod gets round to the adds only now. They used to land, so the account listed the wallet
    // or DID it had just been told was not there.
    const ids = [p1.wallet.userId, p1.did.userId];
    applyLate(ids);
    assert.deepEqual(ids.map(id => heldOutcomes.filter(o => o.userId === id).map(o => o.applied)), [[false], [false]]);
    assert.deepEqual(record(p1.wallet.userId)!.walletAddresses, []);
    assert.deepEqual(record(p1.did.userId)!.didKeys, []);
  });

  test('P6: a removal nothing could settle is recorded, and settled by the credential\'s next request, so it cannot land after a re-add decided on the record', { timeout: 60_000 }, async () => {
    const tokenW = await tokenFor(p6.wallet.keys[0]!, 1, p6.wallet.userId);
    const tokenD = await tokenFor(p6.did.keys[0]!, 1, p6.did.userId);
    const w = p6.wallet.wallets![0]!;
    const k = p6.did.dids![0]!;
    // The removal is never answered and is stored (if its condition still holds) only at applyLate();
    // the fence after it gets no answer either.
    for (const a of [p6.wallet, p6.did]) failPuts(a.userId, 'hang-then-apply-late', 'hang');
    const [removeW, removeD] = await Promise.all([
      del(`/auth-methods/me/wallet/${w.address.toLowerCase()}`, tokenW),
      del('/auth-methods/me/did', tokenD, { did: k.did }),
    ]);
    for (const r of [removeW, removeD]) {
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert.match(String(r.json['detail']), /may or may not/);
    }
    // The owner adds each back with a bearer. Its turn settles the account first (the fence lands),
    // so the record it decides on is final: it lists the credential, and the answer is a sign-in there.
    await signsInTo(siwe(w, { bearer: tokenW }), p6.wallet.userId);
    await signsInTo(didSignIn(k, { bearer: tokenD }), p6.did.userId);
    // The pod gets round to the removals only now. They used to land, so the credential the owner
    // had just added back was gone, and its next sign-in opened an account of its own.
    const ids = [p6.wallet.userId, p6.did.userId];
    applyLate(ids);
    assert.deepEqual(ids.map(id => heldOutcomes.filter(o => o.userId === id).map(o => o.applied)), [[false], [false]]);
    assert.deepEqual(record(p6.wallet.userId)!.walletAddresses, [w.address.toLowerCase()]);
    assert.deepEqual(record(p6.did.userId)!.didKeys.map(d => d.did), [k.did]);
    await signsInTo(siwe(w), p6.wallet.userId);
    await signsInTo(didSignIn(k), p6.did.userId);
    assert.equal(docs.has(deriveUserIdFromWallet(w.address.toLowerCase())), false, 'no account is opened for the wallet');
    assert.equal(docs.has(deriveUserIdFromDid(k.did)), false, 'no account is opened for the did:key');
  });

  test('P7: a removal of a wallet or DID this server\'s copy did not list yet runs in the turn too, so one nothing could settle is recorded and cannot land after a re-add', { timeout: 60_000 }, async () => {
    const tokenW = await tokenFor(p7.wallet.keys[0]!, 1, p7.wallet.userId);
    const tokenD = await tokenFor(p7.did.keys[0]!, 1, p7.did.userId);
    const w = W();
    const k = didKey();
    // Added by the other instance (or an operator) after this server read the accounts: its copy
    // lists neither, so the removal is not queued in the turn at first.
    outOfBand(p7.wallet.userId, d => { (d['walletAddresses'] as string[]).push(w.address.toLowerCase()); });
    outOfBand(p7.did.userId, d => { (d['didKeys'] as unknown[]).push(didEntry(k)); });
    // The removal is never answered and is stored (if its condition still holds) only at
    // applyLate(); the fence after it gets no answer either.
    const ids = [p7.wallet.userId, p7.did.userId];
    for (const id of ids) failPuts(id, 'hang-then-apply-late', 'hang');
    const [removeW, removeD] = await Promise.all([
      del(`/auth-methods/me/wallet/${w.address.toLowerCase()}`, tokenW),
      del('/auth-methods/me/did', tokenD, { did: k.did }),
    ]);
    for (const r of [removeW, removeD]) {
      assert.equal(r.status, 503, `${JSON.stringify(r.json)}${out()}`);
      assert.match(String(r.json['detail']), /may or may not/);
    }
    // The owner adds each back with a bearer. The removal ran in the turn (it found the credential
    // on the record, wrote nothing outside the turn, and ran again inside it), so it was recorded,
    // and the add's turn settles the account first (the fence lands): the record it decides on is final.
    await signsInTo(siwe(w, { bearer: tokenW }), p7.wallet.userId);
    await signsInTo(didSignIn(k, { bearer: tokenD }), p7.did.userId);
    // The pod gets round to the removals only now. Run outside the turn and not recorded, they used
    // to land here, so the credential the owner had just added back was gone.
    applyLate(ids);
    assert.deepEqual(ids.map(id => heldOutcomes.filter(o => o.userId === id).map(o => o.applied)), [[false], [false]]);
    assert.deepEqual(record(p7.wallet.userId)!.walletAddresses, [w.address.toLowerCase()]);
    assert.deepEqual(record(p7.did.userId)!.didKeys.map(d => d.did), [k.did]);
    await signsInTo(siwe(w), p7.wallet.userId);
    await signsInTo(didSignIn(k), p7.did.userId);
  });

  test('C20: a create\'s settlement stops at a fence whose container PUT gets no answer, rather than reading once more', { timeout: 60_000 }, async () => {
    // A first wallet sign-in whose write the pod never answers; then the pod answers no container
    // PUT for this account until the settlement's fence (a create, as the account has no document)
    // has sent one, so that fence gets no answer and its document is never sent.
    const w = W();
    const id = deriveUserIdFromWallet(w.address.toLowerCase());
    // Its container exists once the create's container PUT is answered, so the pod lists it: kept
    // out of the startup scan of an instance another case starts meanwhile, whose read of the record
    // would show up among the requests counted here.
    unlisted.add(id);
    failPuts(id, 'hang');
    const put = hold('PUT', id, 1, () => { hangingContainers.add(id); });
    void put.arrived.then(() => put.release());
    const since = mark();
    const containerPutsSince = () => requests.slice(since).filter(x => x.userId === id && x.target === 'container' && x.method === 'PUT').length;
    try {
      const reply = siwe(w);
      // The create's own container PUT, then the fence's.
      assert.ok(await waitFor(() => containerPutsSince() >= 2 || undefined, 40_000), `no fence was sent${out()}`);
      hangingContainers.delete(id);
      const r = await reply;
      assert.equal(r.status, 503, `${JSON.stringify(r.json)}${out()}`);
      const after = requests.slice(since).filter(x => x.userId === id);
      const hung = after.findIndex(x => x.target === 'doc' && x.method === 'PUT');
      // The settlement under the lock reads the record and stops at its fence's unanswered container
      // PUT; the one the sign-in makes after the lock then fences and reads. The first used to read
      // once more after its container PUT timed out: one more timeout under the lock (15 s) on a pod
      // that is not answering.
      assert.deepEqual(after.slice(hung + 1).map(x => `${x.method} ${x.target}`),
        ['GET doc', 'PUT container', 'GET doc', 'PUT container', 'PUT doc', 'GET doc']);
    } finally {
      hangingContainers.delete(id);
    }
  });

  test('U1: a u-try- account whose tombstone the pod refuses stays whole (503), so an add recorded against it lands on a live account; once the tombstone is written, nothing pending lands, and the wallet signs in on its own', { timeout: 60_000 }, async () => {
    const derivedOf = (w: AnyWallet) => deriveUserIdFromWallet(w.address.toLowerCase());
    assert.equal(u1Try.status, 200, JSON.stringify(u1Try.json));
    const tryId = String(u1Try.json['userId']);
    const tryToken = String(u1Try.json['token']);
    const w = W();
    const v = W();
    try {
      // A bearer add of the wallet that the pod never answers, and stores (if its If-Match still
      // holds) only at applyLate(); every fence after it is answered 500 and not applied, so nothing
      // settles it, and it is recorded for the wallet's next turn.
      failPuts(tryId, 'hang-then-apply-late', ...Array.from({ length: 100 }, () => '500' as const));
      const add = await siwe(w, { bearer: tryToken });
      assert.equal(add.status, 503, `${JSON.stringify(add.json)}${out()}`);
      assert.match(String(add.json['detail']), /may or may not/);
      // The account is deleted, and the pod refuses its tombstone (a 403; the add has not landed).
      // The account stays, here and on the pod: 503, and its token still works. It used to be
      // deleted here all the same (200), its record left on the pod in the state the held add was
      // conditional on, so the add landed afterwards, and a restart loaded the deleted account with
      // the wallet, its /try token verifying again.
      putFaults.set(tryId, ['403']);
      const refused = await post('/users/me/delete', {}, tryToken);
      assert.equal(refused.status, 503, `${JSON.stringify(refused.json)}${out()}`);
      assert.equal(refused.json['error'], 'Deletion not completed');
      assert.ok(docs.has(tryId) && !record(tryId)!.deletedAt, 'the pod still holds the record');
      assert.equal((await verify(tryToken)).json['valid'], true, 'the account was kept');
      putFaults.delete(tryId);
      // The pod stores the held add now: on an account that is still open, which is what the 503
      // said. The wallet's next request settles the recorded write first, and signs in there.
      applyLate([tryId]);
      assert.deepEqual(heldOutcomes.filter(o => o.userId === tryId).map(o => o.applied), [true]);
      await signsInTo(siwe(w), tryId);
      assert.equal(docs.has(derivedOf(w)), false, 'no account is opened for the wallet');
      // A second add the same way, recorded against the account; then the deletion goes through. Its
      // tombstone is written on the ETag the held add was conditional on too, and stays, so that add
      // can no longer land. The record used to be removed instead (a DELETE on that ETag), and CSS
      // 7.2 applies a PUT sent with If-Match on an ETag to a missing document: the held add re-created
      // the deleted account with its wallet (this stand-in refused it then, unlike the store).
      failPuts(tryId, 'hang-then-apply-late', ...Array.from({ length: 100 }, () => '500' as const));
      const again = await siwe(v, { bearer: tryToken });
      assert.equal(again.status, 503, `${JSON.stringify(again.json)}${out()}`);
      putFaults.delete(tryId);
      const deleted = await post('/users/me/delete', {}, tryToken);
      assert.equal(deleted.status, 200, `${JSON.stringify(deleted.json)}${out()}`);
      assert.ok(record(tryId)?.deletedAt, 'the record is the tombstone');
      applyLate([tryId]);
      assert.deepEqual(heldOutcomes.filter(o => o.userId === tryId).map(o => o.applied), [true, false], 'the held add does not land');
      assert.ok(record(tryId)!.deletedAt);
      assert.deepEqual(record(tryId)!.walletAddresses, [], 'the tombstone lists nothing a restart could load');
      assert.equal((await verify(tryToken)).json['valid'], false);
      // The second wallet's next request settles its record without a request to the deleted
      // account's pod (its tombstone is off every state a pending write could land on), and the
      // wallet opens its own account.
      const since = mark();
      await signsInTo(siwe(v), derivedOf(v));
      assert.equal(docGets(tryId, since).length, 0, 'the deleted account\'s pod is not read');
      assert.deepEqual(record(derivedOf(v))!.walletAddresses, [v.address.toLowerCase()]);
    } finally {
      putFaults.delete(tryId);
      applyLate([tryId]);
    }
  });

  test('U4: a Play owner its guest deletes while the guest\'s wallet add is pending stays closed: the add cannot land on its tombstone, the guest token stays refused, and the wallet opens its own account', { timeout: 60_000 }, async () => {
    const derivedOf = (w: AnyWallet) => deriveUserIdFromWallet(w.address.toLowerCase());
    const port = await freePort();
    const guest = livePlayGuest(`http://127.0.0.1:${port}`);
    const inst = await startIdentity(port, { CSS_PUBLIC_URL: 'https://pods.example/', PROVISIONAL_PLAY_CLIENTS: PLAY_CLIENTS });
    const w = W();
    try {
      // The guest adds a wallet with its bearer; the pod never answers that PUT (it stores it, if its
      // If-Match still holds, only at applyLate()), and every fence after it is answered 500: recorded.
      failPuts(guest.id, 'hang-then-apply-late', ...Array.from({ length: 100 }, () => '500' as const));
      const add = await siwe(w, { bearer: guest.token }, inst);
      assert.equal(add.status, 503, `${JSON.stringify(add.json)}${out(inst)}`);
      assert.match(String(add.json['detail']), /may or may not/);
      putFaults.delete(guest.id);
      // The guest deletes the owner: its tombstone is written on the record read (no anchor, no
      // credential), and stays.
      const deleted = await post('/users/me/delete', {}, guest.token, inst);
      assert.equal(deleted.status, 200, `${JSON.stringify(deleted.json)}${out(inst)}`);
      assert.ok(record(guest.id)?.deletedAt, 'the record is the tombstone');
      assert.equal((record(guest.id) as unknown as Doc)['provisionalPlayAnchor'], undefined);
      assert.equal((await verify(guest.token, inst)).json['valid'], false);
      // The pod gets round to the held add. It used to find no document (the anchor was removed with
      // a DELETE on its ETag), and CSS 7.2 applied it there: the owner came back with the wallet and
      // its anchor, and the guest token verified again at once (Play ids are not kept as deleted).
      applyLate([guest.id]);
      assert.deepEqual(heldOutcomes.filter(o => o.userId === guest.id).map(o => o.applied), [false], 'the held add does not land');
      assert.ok(record(guest.id)!.deletedAt);
      assert.deepEqual(record(guest.id)!.walletAddresses, []);
      assert.equal((await verify(guest.token, inst)).json['valid'], false, 'the guest token stays refused');
      // The wallet's next request settles the recorded add on the owner's tombstone, and the wallet
      // opens its own account.
      await signsInTo(siwe(w, {}, inst), derivedOf(w), inst);
    } finally {
      putFaults.delete(guest.id);
      applyLate([guest.id]);
      await inst.stop();
    }
  });

  test('T1: /try creates only where there is no record (If-None-Match: *), reads once after a write that failed and writes nothing back, and keeps a record the pod stored without answering', { timeout: 40_000 }, async () => {
    // L2's claimed u-try- account and U1's (made in before()) write too while this runs: not one of these.
    const isTry = (id: string) => id.startsWith('u-try-') && ![l2Try, u1Try].some(t => id === String(t.json['userId']));
    const trySince = mark();
    // A record is already there for the random id (412): 503, and it is not overwritten.
    const taken = hold('PUT', isTry, 1, id => seed(id, { extra: { note: 'someone else' } }));
    void taken.arrived.then(() => taken.release());
    const collision = await post('/try', {});
    assert.equal(collision.status, 503, JSON.stringify(collision.json));
    const [put] = requests.slice(trySince).filter(r => isTry(r.userId) && r.target === 'doc' && r.method === 'PUT');
    assert.ok(put, 'a write was sent');
    assert.equal(put.ifNoneMatch, '*');
    assert.equal(put.status, 412);
    assert.equal((docs.get(put.userId)!.doc as { note?: string }).note, 'someone else', 'the record there is kept');
    // Two more: the pod never answers the first write, and stores the second without answering it.
    const since = mark();
    const unanswered = hold('PUT', isTry, 1, id => failPuts(id, 'hang'));
    const stored = hold('PUT', isTry, 1, id => failPuts(id, 'apply-then-hang'));
    for (const h of [unanswered, stored]) void h.arrived.then(() => h.release());
    const [a, b] = await Promise.all([post('/try', {}), post('/try', {})]);
    const ok = [a, b].find(r => r.status === 200);
    const failed = [a, b].find(r => r.status !== 200);
    assert.ok(ok && failed, `one stored and one never written: ${JSON.stringify([a.json, b.json])}`);
    // The one the pod stored without answering is provisioned: its record is there, with its agent.
    const keptId = String(ok.json['userId']);
    assert.equal(record(keptId)!.name, 'Try Interego (anonymous)');
    assert.equal((await me(String(ok.json['token']))).status, 200);
    // The one never written: 503, one read after the write, and no write back (a fence would leave
    // an empty record behind for an id nobody uses).
    assert.equal(failed.status, 503, JSON.stringify(failed.json));
    const lostId = requests.slice(since).find(r => isTry(r.userId) && r.target === 'doc' && r.method === 'PUT' && r.userId !== keptId)!.userId;
    assert.equal(docPuts(lostId, since).length, 1, 'one write, and nothing written back');
    assert.ok(docGets(lostId, since).length >= 1, 'read after the write');
    assert.equal(docs.has(lostId), false);
  });

  test('T2: a create on a pod that takes 9 s per PUT succeeds: the container PUT has its own timeout before the document\'s', { timeout: 40_000 }, async () => {
    // A first passkey registration writes the account's container and then its record. The two used
    // to share one 15 s timeout, so a create failed on a pod this slow, where an update did not.
    const key = P();
    const slow = { matches: (id: string) => id === key.userId, ms: 9_000 };
    slowPuts.push(slow);
    try {
      const started = Date.now();
      const reg = await freshPasskey(key);
      assert.equal(reg.status, 200, `${JSON.stringify(reg.json)}${out()}`);
      assert.equal(reg.json['userId'], key.userId);
      assert.ok(Date.now() - started < 25_000, `took ${Date.now() - started} ms`);
    } finally {
      slowPuts.splice(slowPuts.indexOf(slow), 1);
    }
    assert.equal(record(key.userId)!.webAuthnCredentials.length, 1);
    await signsInTo(signIn(key, 1), key.userId);
  });
});

test('C12: a record that is not JSON stops a passkey sign-in, and is never overwritten', async () => {
  const [p1] = f12.keys;
  await tokenFor(p1!, 1, f12.userId);
  const since = mark();
  nonJson.add(f12.userId);
  try {
    const r = await signIn(p1!, 2);
    assert.equal(r.status, 503, JSON.stringify(r.json));
    // A wallet sign-in decides on this server's copy, still under 10 s old.
    await signsInTo(siwe(f12.wallets![0]!), f12.userId);
  } finally {
    nonJson.delete(f12.userId);
  }
  assert.equal(docPuts(f12.userId, since).length, 0);
});

test('J1: a deletion whose tombstone the pod took without confirming it is finished, at once or by its retry', async () => {
  const gone = async (userId: string) => {
    assert.ok(otherRequests.some(r => r.method === 'DELETE' && r.path === `/${userId}/agents`), `${userId}: its agent registry stays${out()}`);
    assert.equal((await call(primary, 'GET', `/users/${userId}/did.json`)).status, 404);
    assert.equal((await call(primary, 'GET', `/agents/mcp-client-${userId}/did.json`)).status, 404);
  };
  // Applied, then 500: the read after the write finds the tombstone, so the deletion goes on.
  const a = j1.applied;
  const tokenA = await tokenFor(a.keys[0]!, 1, a.userId);
  assert.equal((await call(primary, 'GET', `/agents/mcp-client-${a.userId}/did.json`)).status, 200);
  failPuts(a.userId, 'apply-then-500');
  const r = await post('/users/me/delete', {}, tokenA);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out()}`);
  assert.ok(record(a.userId)!.deletedAt);
  await gone(a.userId);
  assert.equal((await verify(tokenA)).json['valid'], false);

  // Applied, then 500, and the read after it failed too: 503, which says it may have taken, and the
  // retry finishes it, even once this server has read the tombstone, without writing it again.
  const b = j1.blind;
  const tokenB = await tokenFor(b.keys[0]!, 1, b.userId);
  failPuts(b.userId, 'apply-then-500');
  const put = hold('PUT', b.userId, 1, () => { failingGets.set(b.userId, 1); });
  void put.arrived.then(() => put.release());
  const first = await post('/users/me/delete', {}, tokenB);
  assert.equal(first.status, 503, JSON.stringify(first.json));
  assert.equal(first.json['error'], 'Deletion not confirmed');
  assert.ok(record(b.userId)!.deletedAt);
  // A verify refreshes this server's stale copy in the background: it then holds the tombstone.
  for (let i = 0; i < 30 && (await verify(tokenB)).json['reason'] !== 'Account deleted'; i++) await sleep(100);
  assert.equal((await verify(tokenB)).json['reason'], 'Account deleted');
  const since = mark();
  const retry = await post('/users/me/delete', {}, tokenB);
  assert.equal(retry.status, 200, `${JSON.stringify(retry.json)}${out()}`);
  assert.equal(docPuts(b.userId, since).length, 0, 'the tombstone is not written again');
  await gone(b.userId);
  // Finished: the token finishes nothing more.
  assert.equal((await post('/users/me/delete', {}, tokenB)).status, 401);
});

test('J7: a deletion whose record cannot be read says so, not that the pod refused it: at first, and when it is the retry of a deletion that may have taken', async () => {
  const token = await tokenFor(j7.keys[0]!, 1, j7.userId);
  // The first read fails: nothing is sent. It used to say "The pod did not take the deletion".
  failingGets.set(j7.userId, 1);
  let since = mark();
  const unread = await post('/users/me/delete', {}, token);
  assert.equal(unread.status, 503, JSON.stringify(unread.json));
  assert.equal(unread.json['error'], 'Could not read this account just now');
  assert.doesNotMatch(String(unread.json['detail']), /did not take/);
  assert.equal(docPuts(j7.userId, since).length, 0, 'nothing was sent');
  assert.equal(record(j7.userId)!.deletedAt, undefined);
  // The pod takes the tombstone and answers 500, and reads fail from then on: 503, which says it may
  // have taken and to try again with the same token.
  failPuts(j7.userId, 'apply-then-500');
  const put = hold('PUT', j7.userId, 1, () => { failingGets.set(j7.userId, 1_000); });
  void put.arrived.then(() => put.release());
  const first = await post('/users/me/delete', {}, token);
  assert.equal(first.status, 503, JSON.stringify(first.json));
  assert.equal(first.json['error'], 'Deletion not confirmed');
  assert.ok(record(j7.userId)!.deletedAt, 'the pod holds the tombstone');
  // Retried as told, while the pod still cannot be read: not "the pod did not take the deletion.
  // Nothing was changed", which it was told before though the pod held the tombstone.
  since = mark();
  const retry = await post('/users/me/delete', {}, token);
  assert.equal(retry.status, 503, `${JSON.stringify(retry.json)}${out()}`);
  assert.equal(retry.json['error'], 'Could not read this account just now');
  assert.doesNotMatch(String(retry.json['detail']), /did not take/);
  assert.match(String(retry.json['detail']), /may already have taken/);
  assert.equal(docPuts(j7.userId, since).length, 0);
  // Readable again: the retry finishes it, without writing the tombstone again.
  failingGets.delete(j7.userId);
  since = mark();
  const done = await post('/users/me/delete', {}, token);
  assert.equal(done.status, 200, `${JSON.stringify(done.json)}${out()}`);
  assert.equal(docPuts(j7.userId, since).length, 0);
  assert.equal((await verify(token)).json['valid'], false);
});

test('U3: a u-try- account whose record another writer changes under every attempt of its deletion stays whole (503)', async () => {
  const tried = await post('/try', {});
  assert.equal(tried.status, 200, JSON.stringify(tried.json));
  const id = String(tried.json['userId']);
  const token = String(tried.json['token']);
  // Each conditional write of the tombstone meets a change made just before it (the other instance,
  // say): 412, three times. The record still lists no credential, and it used to be closed here all
  // the same (200), left on the pod as the last writer made it.
  for (let i = 0; i < 3; i++) {
    const h = hold('PUT', id, 1, x => outOfBand(x, d => { d['name'] = `renamed-${i}`; }));
    void h.arrived.then(() => h.release());
  }
  const r = await post('/users/me/delete', {}, token);
  assert.equal(r.status, 503, `${JSON.stringify(r.json)}${out()}`);
  assert.equal(r.json['error'], 'Deletion not completed');
  assert.ok(docs.has(id), 'the record is still on the pod');
  assert.equal((await verify(token)).json['valid'], true, 'the account was kept');
  assert.match(primary.output(), new RegExp(`identity_authmethods_write_conflict userId=${id} context=delete-account attempts=3`));
  const done = await post('/users/me/delete', {}, token);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.ok(record(id)?.deletedAt, 'the record is the tombstone, which stays');
});

test('J2: a bootstrap passkey the pod took without confirming it signs in to the seeded account, and spends the invite', async () => {
  // Applied, then 500: the read after the write lists the passkey, so the account keeps it.
  const key = P();
  failPuts(invites.unconfirmed.userId, 'apply-then-500');
  const r = await bootstrapPasskey(key, invites.unconfirmed);
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.match(String(r.json['detail']), /lists this passkey now/);
  assert.equal(r.json['token'], undefined);
  assert.deepEqual(record(invites.unconfirmed.userId)!.webAuthnCredentials.map(c => c.id), [key.id]);
  // The seeded account's shell stays (its DID document resolves before any sign-in loads it), and
  // the invite stays spent: a second claim is refused as consumed, before any ceremony.
  assert.equal((await call(primary, 'GET', `/users/${invites.unconfirmed.userId}/did.json`)).status, 200);
  const again = await post('/auth/webauthn/register-options', { name: 'Seeded', bootstrapUserId: invites.unconfirmed.userId, bootstrapInvite: invites.unconfirmed.token });
  assert.equal(again.status, 409, JSON.stringify(again.json));
  assert.match(String(again.json['error']), /already been consumed/);
  await signsInTo(signIn(key, 1), invites.unconfirmed.userId);
  assert.notEqual((await bootstrapPasskey(P(), invites.unconfirmed)).status, 200);
  assert.deepEqual(record(invites.unconfirmed.userId)!.webAuthnCredentials.map(c => c.id), [key.id]);
  // Applied, then 500, and the read after it failed too: the account is loaded from its pod, so
  // the passkey signs in all the same.
  const blind = P();
  failPuts(invites.unconfirmedBlind.userId, 'apply-then-500');
  const put = hold('PUT', invites.unconfirmedBlind.userId, 1, () => { failingGets.set(invites.unconfirmedBlind.userId, 1); });
  void put.arrived.then(() => put.release());
  const r2 = await bootstrapPasskey(blind, invites.unconfirmedBlind);
  assert.equal(r2.status, 503, JSON.stringify(r2.json));
  await signsInTo(signIn(blind, 1), invites.unconfirmedBlind.userId);
});

test('J4: a wallet or DID bootstrap claim the pod took without confirming it signs in to the seeded account, and spends the invite', async () => {
  // A write the pod refused: nothing is on the seeded account, the answer says so, and the
  // invite is given back.
  const w = W();
  failPuts(invites.landed.userId, '500');
  const refused = await siwe(w, bootstrap(invites.landed));
  assert.equal(refused.status, 503, JSON.stringify(refused.json));
  assert.match(String(refused.json['detail']), /Nothing was changed/);
  assert.equal(docs.has(invites.landed.userId), false);
  // Applied, then 500: the read after the write lists the wallet, so the claim signs in, and
  // the invite stays spent. The wallet signs in there from then on, and opens no account of its own.
  failPuts(invites.landed.userId, 'apply-then-500');
  await signsInTo(siwe(w, bootstrap(invites.landed)), invites.landed.userId);
  assert.deepEqual(record(invites.landed.userId)!.walletAddresses, [w.address.toLowerCase()]);
  assert.equal((await siwe(W(), bootstrap(invites.landed))).status, 401);
  await signsInTo(siwe(w), invites.landed.userId);
  assert.equal(docs.has(deriveUserIdFromWallet(w.address.toLowerCase())), false, 'no account is opened for the wallet');
  const k = didKey();
  failPuts(invites.landedDid.userId, 'apply-then-500');
  await signsInTo(didSignIn(k, bootstrap(invites.landedDid)), invites.landedDid.userId);
  assert.notEqual((await didSignIn(didKey(), bootstrap(invites.landedDid))).status, 200);
  await signsInTo(didSignIn(k), invites.landedDid.userId);
  assert.equal(docs.has(deriveUserIdFromDid(k.did)), false, 'no account is opened for the did:key');

  // Applied, then 500, and the read after it failed too: the account is loaded from its pod, and
  // the claim signs in all the same.
  const blind = (invite: { userId: string }, attempt: () => Promise<Reply>) => {
    failPuts(invite.userId, 'apply-then-500');
    const put = hold('PUT', invite.userId, 1, () => { failingGets.set(invite.userId, 1); });
    void put.arrived.then(() => put.release());
    return attempt();
  };
  const wb = W();
  await signsInTo(blind(invites.landedBlind, () => siwe(wb, bootstrap(invites.landedBlind))), invites.landedBlind.userId);
  await signsInTo(siwe(wb), invites.landedBlind.userId);
  assert.equal(docs.has(deriveUserIdFromWallet(wb.address.toLowerCase())), false, 'no account is opened for the wallet');
  const kb = didKey();
  await signsInTo(blind(invites.landedBlindDid, () => didSignIn(kb, bootstrap(invites.landedBlindDid))), invites.landedBlindDid.userId);
  await signsInTo(didSignIn(kb), invites.landedBlindDid.userId);
  assert.equal(docs.has(deriveUserIdFromDid(kb.did)), false, 'no account is opened for the did:key');
});

test('J5: a credential indexed for an account this server has not loaded signs in to that account, and opens no other', async () => {
  // The wallet each account was derived from is refused (the account no longer lists it), and
  // that refusal installs the account's record here as the pod holds it: its other credential
  // is in the sign-in indexes, with no account shell behind it.
  for (const x of Object.values(j5)) {
    const r = await siwe(x.from);
    assert.equal(r.status, 401, JSON.stringify(r.json));
  }
  await signsInTo(siwe(j5.wallet.holds), unloaded(j5.wallet.from));
  assert.equal(docs.has(deriveUserIdFromWallet(j5.wallet.holds.address.toLowerCase())), false, 'no account is opened for the wallet');
  await signsInTo(didSignIn(j5.did.holds), unloaded(j5.did.from));
  assert.equal(docs.has(deriveUserIdFromDid(j5.did.holds.did)), false, 'no account is opened for the did:key');
  await signsInTo(signIn(j5.passkey.holds, 1), unloaded(j5.passkey.from));
});

test('C13, J6: one request the pod never answers holds an account\'s lock for no more than its own 15 s: the janitor\'s purge of a Play owner, and a bootstrap claim the pod stored', { timeout: 60_000 }, async () => {
  // J6: wallet and DID bootstrap claims whose write the pod stores and never answers. The write
  // times out; the read after it lists the credential, so each claim signs in.
  const w = W();
  const k = didKey();
  failPuts(invites.slow.userId, 'apply-then-hang');
  failPuts(invites.slowDid.userId, 'apply-then-hang');
  const walletClaim = siwe(w, bootstrap(invites.slow));
  const didClaim = didSignIn(k, bootstrap(invites.slowDid));
  // C13: the janitor purges an unclaimed Play owner whose anchor expired, and the pod never
  // answers the deletion of its agent registry, which the janitor makes holding the owner's lock.
  // A request for that lock waits for it: here a bootstrap claim's read of the owner's pod (the
  // same owner's provisioning waits the same way, holding every other provisioning behind it).
  // The pod holds the registry, as every Play pod does once the relay's exchange has bootstrapped
  // it. The purge used to send it two DELETEs one after the other (the deletion's own, then the
  // purge's of what it listed), so the lock was held for two timeouts; with no registry stored, as
  // this test had it, the listing named none and only the first was sent.
  const port = await freePort();
  docs.set(expiredPlay.id, { modified: clock = Math.max(clock + 1, Date.now()), doc: { userId: expiredPlay.id, name: 'Play guest',
    walletAddresses: [], webAuthnCredentials: [], didKeys: [], provisionalPlayAnchor: expiredAnchor(`http://127.0.0.1:${port}`) } });
  const registry = `/${expiredPlay.id}/agents`;
  putOther(registry);
  hangingOther.add(`DELETE ${registry}`);
  const janitor = await startIdentity(port, { JANITOR_INTERVAL_MS: '1000',
    BOOTSTRAP_INVITES: [...Object.values(invites).map(i => `${i.userId}:${i.token}`), `${expiredPlay.id}:${expiredPlay.invite}`].join(',') });
  try {
    const deletion = await waitFor(() => otherRequests.find(r => r.method === 'DELETE' && r.path === registry), 15_000);
    assert.ok(deletion, `the janitor never purged ${expiredPlay.id}${out(janitor)}`);
    assert.ok(record(expiredPlay.id)?.deletedAt, 'the anchor is replaced by the tombstone, which stays');
    const probe = post('/auth/webauthn/register-options', { name: 'Probe', bootstrapUserId: expiredPlay.id, bootstrapInvite: expiredPlay.invite }, undefined, janitor);
    assert.ok(await within(probe, 17_000), `a request for the owner's lock was still waiting 17 s after the registry DELETE was sent${out(janitor)}`);
    // It read the owner's record once the lock was free: the purge's tombstone, so the claim is refused as deleted.
    assert.equal((await probe).status, 409, JSON.stringify((await probe).json));
    assert.match(String((await probe).json['error']), /This account was deleted/);
    assert.ok(deletion.abandonedAt !== undefined && deletion.abandonedAt - deletion.at < 16_500,
      `the registry DELETE was given up ${deletion.abandonedAt === undefined ? 'never' : `after ${deletion.abandonedAt - deletion.at} ms`}`);
    // A DELETE of the registry that fails leaves the purge unfinished, its tombstone marked, for the next pass.
    assert.ok(await waitFor(() => (new RegExp(`purge of ${expiredPlay.id} unfinished`).test(janitor.output()) || undefined), 5_000),
      `the registry DELETE's timeout did not leave the purge unfinished${out(janitor)}`);
    assert.equal(record(expiredPlay.id)?.provisionalPlayPurgePending, true);
  } finally {
    await janitor.stop();
    hangingOther.clear();
    // What the next pass does once the pod answers, so the instances of the tests below find no
    // purge left open by this one.
    others.delete(registry);
    if (record(expiredPlay.id)?.provisionalPlayPurgePending) outOfBand(expiredPlay.id, d => { delete d['provisionalPlayPurgePending']; });
  }
  const [walletReply, didReply] = await Promise.all([walletClaim, didClaim]);
  assert.equal(walletReply.status, 200, `${JSON.stringify(walletReply.json)}${out()}`);
  assert.equal(walletReply.json['userId'], invites.slow.userId);
  assert.equal(didReply.status, 200, `${JSON.stringify(didReply.json)}${out()}`);
  assert.equal(didReply.json['userId'], invites.slowDid.userId);
  await signsInTo(siwe(w), invites.slow.userId);
  await signsInTo(didSignIn(k), invites.slowDid.userId);
  assert.equal(docs.has(deriveUserIdFromWallet(w.address.toLowerCase())), false, 'no account is opened for the wallet');
  assert.equal(docs.has(deriveUserIdFromDid(k.did)), false, 'no account is opened for the did:key');
});

test('C16: the janitor writes a Play owner\'s tombstone on the ETag it checked before it deletes anything: an enrolment landing in between keeps the whole account', async () => {
  const port = await freePort();
  docs.set(fencedPlay.id, { modified: clock = Math.max(clock + 1, Date.now()), doc: { userId: fencedPlay.id, name: 'Play guest',
    walletAddresses: [], webAuthnCredentials: [], didKeys: [], provisionalPlayAnchor: expiredAnchor(`http://127.0.0.1:${port}`, fencedPlay) } });
  // Once the purge has listed the pod, its next read of the record is the deletion's own read under
  // the lock (deleteUserCompletely, checked by stillDeletable). An enrolment lands right after that
  // read is answered (the other instance's, during a deploy's overlap): the record the check
  // approved is no longer the pod's.
  const key = P();
  const listed = (id: string) => id === fencedPlay.id && requests.some(r => r.userId === id && r.target === 'container' && r.method === 'GET');
  const check = hold('GET', listed, 1, id => outOfBand(id, d => { (d['webAuthnCredentials'] as unknown[]).push(stored(key)); }));
  void check.arrived.then(() => check.release());
  const since = mark();
  const otherSince = otherRequests.length;
  const janitor = await startIdentity(port, { JANITOR_INTERVAL_MS: '1000' });
  try {
    const fence = await waitFor(() => docPuts(fencedPlay.id, since).find(r => r.status !== undefined), 15_000);
    assert.ok(fence, `the janitor never wrote the tombstone${out(janitor)}`);
    assert.ok(fence.ifMatch, 'the tombstone is conditional on the ETag checked');
    assert.equal(fence.status, 412);
    await sleep(1_500);
    assert.equal(requests.slice(since).some(r => r.userId === fencedPlay.id && r.method === 'DELETE'), false, `the anchor or the pod was deleted${out(janitor)}`);
    assert.equal(otherRequests.slice(otherSince).some(r => r.method === 'DELETE' && r.path.startsWith(`/${fencedPlay.id}/`)), false,
      'a resource of the pod was deleted');
    assert.deepEqual(record(fencedPlay.id)!.webAuthnCredentials.map(c => c.id), [key.id]);
  } finally {
    check.release();
    await janitor.stop();
  }
});

test('P9: a Play purge that fails part-way is finished, at the janitor\'s next pass and after a restart; the game\'s saves and write budget, which no plain request deletes, are kept and do not hold it open', { timeout: 90_000 }, async () => {
  // The janitor closes an expired unclaimed owner (its tombstone, marked as a purge not yet
  // finished) and then deletes the pod's other resources: the relay's agent registry and profile
  // card, and the guest's game save and write budget, which the css-gate writes only as native
  // commits, and whose every plain DELETE the production store refuses with 409. One DELETE fails
  // once (`once`, the registry), and one fails until the instance restarts (`stuck`, the card). It
  // used to forget the owner as soon as it was closed: its sweep walks only the accounts it holds and
  // a tombstone loads none, so the resource a failed DELETE left stayed for good. Then it kept the
  // purge open on any refused DELETE, a native head's 409 included, so on the production store a
  // guest who had saved was purged again at every pass and after every restart, never finished.
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const once = playOwner();
  const stuck = playOwner();
  const saves = new Map<string, string>();
  for (const o of [once, stuck]) {
    docs.set(o.id, { modified: clock = Math.max(clock + 1, Date.now()), doc: { userId: o.id, name: 'Play guest',
      walletAddresses: [], webAuthnCredentials: [], didKeys: [], provisionalPlayAnchor: expiredAnchor(issuer, o) } });
    putOther(`/${o.id}/agents`);
    putOther(`/${o.id}/profile/card`);
    saves.set(o.id, saveGame(o.id));
  }
  failingOtherDeletes.set(`/${once.id}/agents`, 1);
  failingOtherDeletes.set(`/${stuck.id}/profile/card`, 1_000);
  const deletesOf = (path: string) => otherRequests.filter(r => r.method === 'DELETE' && r.path === path);
  const podRequests = (o: { id: string }) => otherRequests.filter(r => r.path.startsWith(`/${o.id}/`)).length;
  const gone = (path: string) => (others.has(path) ? undefined : true);
  const unmarked = (o: { id: string }) => (record(o.id)?.provisionalPlayPurgePending ? undefined : true);
  const logged = (inst: Instance, line: RegExp) => waitFor(() => (line.test(inst.output()) ? true : undefined), 5_000);
  // What stays of a finished purge: the record (the tombstone) and the native heads, with the
  // containers that hold them. The registry, the card, and the card's container, emptied, are deleted.
  const purgedButNative = (o: { id: string }) => {
    assert.ok(record(o.id)!.deletedAt, 'the record stays, as the tombstone');
    assert.ok(others.has(saves.get(o.id)!) && others.has(`/${o.id}/play-budget.json`), 'the native heads stay');
    assert.equal(others.has(`/${o.id}/agents`) || others.has(`/${o.id}/profile/card`), false);
    assert.equal(subContainers.has(`/${o.id}/profile/`), false, 'the emptied container is deleted too');
    assert.equal(otherRequests.some(r => r.method === 'DELETE' && r.path.startsWith(`/${o.id}/hallowmarch/`) && r.path.endsWith('/')), false,
      'a container that holds a native head is not asked to be deleted');
  };
  let janitor = await startIdentity(port, { JANITOR_INTERVAL_MS: '1000' });
  try {
    assert.ok(await waitFor(() => gone(`/${once.id}/agents`), 20_000),
      `the registry a failed DELETE left was never deleted (${deletesOf(`/${once.id}/agents`).length} DELETE(s))${out(janitor)}`);
    assert.deepEqual(deletesOf(`/${once.id}/agents`).map(r => r.status), [500, 205], 'refused once, then sent again at the next pass');
    assert.ok(await waitFor(() => unmarked(once), 5_000), `the mark is cleared once the purge is done, the native heads kept${out(janitor)}`);
    purgedButNative(once);
    assert.deepEqual(deletesOf(saves.get(once.id)!).map(r => r.status), [409], 'the save\'s DELETE is sent once, at the pass that finished');
    assert.ok(await logged(janitor, new RegExp(`finished the purge of ${once.id}, keeping 2 resource\\(s\\)[^\\n]*hallowmarch/checkpoints/[0-9a-f]{64}\\.json`)),
      `the kept heads are not logged${out(janitor)}`);
    // The registry's 500 stopped the first pass, which left the purge unfinished and its tombstone
    // marked; a later pass of the same instance found that tombstone, wrote nothing over it, sent
    // the DELETEs again and cleared the mark. The 500 used to fall on a DELETE of the registry the
    // deletion sent first, best-effort, which nothing saw: the purge finished at its first pass.
    const onceLog = janitor.output();
    const leftUnfinished = onceLog.search(new RegExp(`purge of ${once.id} unfinished`));
    assert.ok(leftUnfinished >= 0 && leftUnfinished < onceLog.search(new RegExp(`finished the purge of ${once.id}`)),
      `the registry's 500 did not leave the purge unfinished${out(janitor)}`);
    const [refused, sentAgain] = deletesOf(`/${once.id}/agents`);
    assert.ok(sentAgain!.at - refused!.at >= 500, `the registry's DELETE was sent again ${sentAgain!.at - refused!.at} ms later, in the same pass`);
    assert.deepEqual(docPuts(once.id).map(r => r.body?.['provisionalPlayPurgePending'] === true), [true, false],
      'the marked tombstone, written once, then the same without the mark');
    assert.ok(docPuts(once.id)[1]!.at >= sentAgain!.at, 'the mark is cleared by the pass that deleted the registry');
    const finished = podRequests(once);
    assert.ok(await waitFor(() => deletesOf(`/${stuck.id}/profile/card`).length >= 2 || undefined, 10_000), `a purge whose DELETE failed was not tried again${out(janitor)}`);
    assert.ok(record(stuck.id)!.deletedAt, 'the account is closed');
    assert.equal(record(stuck.id)!.provisionalPlayPurgePending, true, 'and its tombstone says its purge is unfinished');
    assert.match(janitor.output(), new RegExp(`purge of ${stuck.id} unfinished`));
    assert.doesNotMatch(janitor.output(), new RegExp(`kept ${stuck.id}`), 'an owner whose account is closed is not logged as kept');
    assert.equal(podRequests(once), finished, 'a finished purge is not visited again');
  } finally {
    await janitor.stop();
  }
  // Nothing loads a closed account at the restart, but the startup scan finds the mark.
  failingOtherDeletes.delete(`/${stuck.id}/profile/card`);
  const before = deletesOf(`/${stuck.id}/profile/card`).length;
  const onceRequests = podRequests(once);
  janitor = await startIdentity(port, { JANITOR_INTERVAL_MS: '1000' });
  try {
    assert.ok(await waitFor(() => gone(`/${stuck.id}/profile/card`), 15_000), `the restarted janitor never finished the purge${out(janitor)}`);
    assert.equal(deletesOf(`/${stuck.id}/profile/card`).length, before + 1);
    assert.ok(await waitFor(() => unmarked(stuck), 5_000), `the restarted janitor never cleared the mark${out(janitor)}`);
    purgedButNative(stuck);
    assert.ok(await logged(janitor, new RegExp(`finished the purge of ${stuck.id}, keeping 2 resource`)), `the kept heads are not logged${out(janitor)}`);
    await sleep(1_200);
    assert.equal(podRequests(once), onceRequests, 'nor after a restart: its tombstone has no mark left');
  } finally {
    await janitor.stop();
  }
});

test('P10: a Play owner its guest deleted through the other instance is only forgotten by this instance\'s janitor, never purged: that owner may be provisioned again over its tombstone, and its pod stays whole', { timeout: 60_000 }, async () => {
  // The other instance's provisioning replaces a deletion's tombstone on its ETag, with the owner's
  // original anchor, until its guest deadline, and does not wait for this server's lock. The janitor
  // here used to purge any tombstone it found (writing nothing first), so a guest who bootstrapped
  // again meanwhile lost its agent registry; it was sent a DELETE for its game save too, which the
  // store refuses with 409 (a native head), so the save stayed.
  const port = await freePort();
  const guest = livePlayGuest(`http://127.0.0.1:${port}`);   // its anchor has an hour left
  const anchor = record(guest.id)!.provisionalPlayAnchor;
  const save = saveGame(guest.id);
  putOther(`/${guest.id}/agents`);
  const janitor = await startIdentity(port, { JANITOR_INTERVAL_MS: '1000', CSS_PUBLIC_URL: 'https://pods.example/', PROVISIONAL_PLAY_CLIENTS: PLAY_CLIENTS });
  const since = mark();
  const otherSince = otherRequests.length;
  try {
    // The guest deletes the owner through the other instance: a deletion's tombstone (deletionTombstone).
    outOfBand(guest.id, d => {
      for (const k of Object.keys(d)) delete d[k];
      Object.assign(d, { userId: guest.id, name: guest.id, walletAddresses: [], webAuthnCredentials: [], didKeys: [], sessionEpoch: 1, deletedAt: '2026-10-28' });
    });
    const tombstoned = mark();
    // Its sweep reads the tombstone, and so does the purge's close under the owner's lock.
    assert.ok(await waitFor(() => docGets(guest.id, tombstoned).length >= 2 || undefined, 10_000), `the janitor never read the tombstone${out(janitor)}`);
    await sleep(1_200);
    const deleted = () => otherRequests.slice(otherSince).filter(r => r.method === 'DELETE' && r.path.startsWith(`/${guest.id}/`)).map(r => r.path);
    assert.deepEqual(deleted(), [], 'nothing of the pod is deleted, its agent registry included');
    assert.match(janitor.output(), new RegExp(`forgot ${guest.id}`));
    // The guest bootstraps again through the other instance: its provisioning puts the original anchor back.
    outOfBand(guest.id, d => { delete d['deletedAt']; Object.assign(d, { name: 'Play guest', provisionalPlayAnchor: anchor, provisionalPlayReceipts: [] }); });
    await sleep(1_200);
    assert.deepEqual(deleted(), [], 'nor after it is provisioned again');
    assert.ok(others.has(save) && others.has(`/${guest.id}/agents`));
    assert.deepEqual(docPuts(guest.id, since), [], 'and nothing is written');
    assert.equal(record(guest.id)!.provisionalPlayAnchor, anchor, 'the owner provisioned again is whole');
  } finally {
    await janitor.stop();
  }
});

test('P11: a Play guest\'s deletion the pod took without confirming it is finished by the guest\'s retry, which the janitor leaves it to until the guest deadline, and by the janitor after that deadline', { timeout: 60_000 }, async () => {
  // The pod applies each guest's tombstone and answers 500, and the read after it fails: 503, "the
  // retry finishes it either way". The retry was refused (401 "Provisional owner unavailable": a
  // guest token's check opened the anchor, which a tombstone does not have), and the janitor's
  // purge found the tombstone unmarked and only forgot the owner, so its agent registry stayed.
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const inst = await startIdentity(port, { JANITOR_INTERVAL_MS: '1000', CSS_PUBLIC_URL: 'https://pods.example/', PROVISIONAL_PLAY_CLIENTS: PLAY_CLIENTS });
  const retrying = livePlayGuest(issuer);                         // an hour to its guest deadline
  const lapsing = livePlayGuest(issuer, undefined, 6);            // its guest never retries
  const saves = new Map<string, string>();
  for (const g of [retrying, lapsing]) {
    putOther(`/${g.id}/agents`);
    saves.set(g.id, saveGame(g.id));
  }
  const registryDeletes = (g: { id: string }) => otherRequests.filter(r => r.method === 'DELETE' && r.path === `/${g.id}/agents`);
  const deletedAt: Record<string, number> = {};
  try {
    for (const g of [retrying, lapsing]) {
      failPuts(g.id, 'apply-then-500');
      const put = hold('PUT', g.id, 1, () => { failingGets.set(g.id, 1_000); });
      void put.arrived.then(() => put.release());
      const r = await post('/users/me/delete', {}, g.token, inst);
      failingGets.delete(g.id);
      assert.equal(r.status, 503, `${JSON.stringify(r.json)}${out(inst)}`);
      assert.equal(r.json['error'], 'Deletion not confirmed');
      assert.ok(record(g.id)!.deletedAt, 'the pod holds the tombstone');
      deletedAt[g.id] = mark();
    }
    // The guest who never retries: once its guest deadline has passed (no guest token verifies, and
    // no grant provisions the owner again), the janitor finishes the deletion as the retry would have.
    const finished = await waitFor(() => registryDeletes(lapsing)[0], 15_000);
    assert.ok(finished, `the janitor never finished the deletion of ${lapsing.id}${out(inst)}`);
    assert.ok(finished.at >= lapsing.expiresAt * 1000, `its registry was deleted ${lapsing.expiresAt * 1000 - finished.at} ms before its guest deadline`);
    // Logged once the registry DELETE is answered and the purge returns, and then read through the
    // child's stdout: waited for, as the DELETE's arrival at the pod comes first. It was matched at
    // once, and failed when a poll fell in between.
    assert.ok(await waitFor(() => (inst.output().includes(`finished the deletion of ${lapsing.id}`) ? true : undefined), 5_000),
      `no 'finished the deletion' log${out(inst)}`);
    assert.equal(others.has(`/${lapsing.id}/agents`), false);
    assert.ok(others.has(saves.get(lapsing.id)!) && others.has(`/${lapsing.id}/play-budget.json`), 'a deletion deletes the agent registry only');
    assert.deepEqual(docPuts(lapsing.id, deletedAt[lapsing.id]), [], 'nothing is written over the tombstone');
    assert.equal((await call(inst, 'GET', `/users/${lapsing.id}/did.json`)).status, 404);
    // The guest who retries: across those passes the janitor sent nothing for its owner, and forgot nothing.
    assert.deepEqual(requests.slice(deletedAt[retrying.id]).filter(r => r.userId === retrying.id), [], 'its pod is not even read');
    assert.deepEqual(registryDeletes(retrying), []);
    assert.doesNotMatch(inst.output(), new RegExp(`forgot ${retrying.id}`));
    assert.equal((await verify(retrying.token, inst)).json['reason'], 'Account deleted');
    const since = mark();
    const retry = await post('/users/me/delete', {}, retrying.token, inst);
    assert.equal(retry.status, 200, `${JSON.stringify(retry.json)}${out(inst)}`);
    assert.equal(registryDeletes(retrying).length, 1, 'its agent registry is deleted');
    assert.equal(others.has(`/${retrying.id}/agents`), false);
    assert.deepEqual(docPuts(retrying.id, since), [], 'and the tombstone is not written again');
    assert.equal((await post('/users/me/delete', {}, retrying.token, inst)).status, 401, 'finished: the token finishes nothing more');
  } finally {
    for (const g of [retrying, lapsing]) { putFaults.delete(g.id); failingGets.delete(g.id); }
    await inst.stop();
  }
});

test('P12: a Play guest token whose deletion was answered 503 cannot close the owner its guest is provisioned as again through the other instance: that token is refused and the new one verifies on both, and a retry the provisioning overtakes writes nothing', { timeout: 90_000 }, async () => {
  // Two instances on the same pods (a deploy's overlap); the guest bootstraps through the
  // provisioning route of either, against a stand-in relay that vouches for the game's service
  // agent. Its deletion through A is answered 503 (the pod applied the tombstone, answered 500, and
  // the read after it failed), and its token's next use at A made A's copy that tombstone, for the
  // deletion's retry. B's provisioning then puts the owner back over the tombstone, keeping its
  // session epoch. A decided both tokens on that copy: the new one was "Account deleted" there, and
  // the old one's retry of the deletion was accepted, closed the owner provisioned again (a new
  // tombstone) and deleted its agent registry.
  const guest = await playGuestOnTwoInstances();
  const { id, a, b } = guest;
  /** The guest's bootstrap through `inst`: its guest token. */
  const provision = async (inst: Instance) => (await guest.provision(inst)).token;
  /** The guest's deletion through A, which the pod applies and answers 500, the read after it failing: 503. */
  const unconfirmedDeletion = async (token: string) => {
    failPuts(id, 'apply-then-500');
    const put = hold('PUT', id, 1, () => { failingGets.set(id, 1_000); });
    void put.arrived.then(() => put.release());
    const r = await post('/users/me/delete', {}, token, a);
    failingGets.delete(id);
    putFaults.delete(id);
    assert.equal(r.status, 503, `${JSON.stringify(r.json)}${out(a)}`);
    assert.equal(r.json['error'], 'Deletion not confirmed');
    assert.ok(record(id)!.deletedAt, 'the pod holds the tombstone');
  };
  const revoked = 'Invalid bearer token: Token revoked (signed out everywhere)';
  try {
    const t1 = await provision(a);
    putOther(`/${id}/agents`);   // the relay's registry, for the guest's session
    const save = saveGame(id);
    await unconfirmedDeletion(t1);
    assert.equal(record(id)!.sessionEpoch, 1);
    // The game's next request with T1 (the relay introspects it at A): "Account deleted", and A's
    // copy is the tombstone, which the deletion's retry needs.
    assert.equal((await verify(t1, a)).json['reason'], 'Account deleted');
    // The guest bootstraps again through B, over the tombstone, at its session epoch.
    const t2 = await provision(b);
    assert.equal(record(id)!.deletedAt, undefined);
    assert.equal(record(id)!.sessionEpoch, 1);
    const since = mark();
    const otherSince = otherRequests.length;
    assert.equal((await verify(t2, a)).json['valid'], true, `the new session's token verifies at A${out(a)}`);
    assert.equal((await verify(t1, a)).json['reason'], 'Token revoked (signed out everywhere)');
    const retry = await post('/users/me/delete', {}, t1, a);
    assert.equal(retry.status, 401, `${JSON.stringify(retry.json)}${out(a)}`);
    assert.equal(retry.json['error'], revoked);
    assert.deepEqual(docPuts(id, since), [], 'nothing is written');
    assert.deepEqual(otherRequests.slice(otherSince).filter(r => r.method === 'DELETE'), [], 'nothing is deleted');
    assert.equal(record(id)!.deletedAt, undefined);
    assert.ok(others.has(`/${id}/agents`) && others.has(save));
    for (const inst of [a, b]) assert.equal((await verify(t2, inst)).json['valid'], true);

    // The same retry, sent while the pod still holds the tombstone and overtaken by a provisioning
    // through B before its deletion reads the record under the owner's lock: T2's deletion through A
    // is answered 503 as T1's was, its retry's token check reads the tombstone, and B provisions the
    // owner again before that request goes on. The record its lock reads is no tombstone.
    await unconfirmedDeletion(t2);
    assert.equal(record(id)!.sessionEpoch, 2);
    let t3: string | Error = '';
    const check = hold('GET', id);
    void check.arrived.then(() => provision(b)).then(t => { t3 = t; }, (err: Error) => { t3 = err; }).finally(() => check.release());
    const since2 = mark();
    const otherSince2 = otherRequests.length;
    const raced = await post('/users/me/delete', {}, t2, a);
    assert.equal(typeof t3, 'string', `B did not provision the owner again: ${String(t3)}`);
    assert.equal(raced.status, 401, `${JSON.stringify(raced.json)}${out(a)}`);
    assert.equal(raced.json['error'], revoked);
    assert.deepEqual(docPuts(id, since2).filter(r => r.body?.['deletedAt'] !== undefined), [], 'no tombstone is written');
    assert.deepEqual(otherRequests.slice(otherSince2).filter(r => r.method === 'DELETE'), [], 'nothing is deleted');
    assert.equal(record(id)!.deletedAt, undefined);
    assert.equal(record(id)!.sessionEpoch, 2);
    for (const inst of [a, b]) assert.equal((await verify(t3 as string, inst)).json['valid'], true, 'the owner provisioned again stays');
  } finally {
    putFaults.delete(id);
    failingGets.delete(id);
    await guest.stop();
  }
});

test('P13: the retry of a deletion answered 503 writes nothing over a record re-opened by hand: the old token is refused, or, where the record\'s epoch passes it, told to send the deletion again', async () => {
  // An operator re-opens the id (AUTH-ARCHITECTURE.md, Re-opening a deleted id by hand) before the
  // deletion's retry, while this server's copy is still the tombstone, so the retry is taken as the
  // finishing of that deletion (unfinishedDeletion). It used to close the re-opened account again.
  for (const [x, epoch] of [[p13.kept, undefined], [p13.reset, 0]] as const) {
    putOther(`/${x.userId}/agents`);
    const token = await tokenFor(x.keys[0]!, 1, x.userId);
    failPuts(x.userId, 'apply-then-500');
    const put = hold('PUT', x.userId, 1, () => { failingGets.set(x.userId, 1); });
    void put.arrived.then(() => put.release());
    const first = await post('/users/me/delete', {}, token);
    assert.equal(first.status, 503, JSON.stringify(first.json));
    assert.equal(first.json['error'], 'Deletion not confirmed');
    // A verify refreshes this server's stale copy: it then holds the tombstone.
    for (let i = 0; i < 30 && (await verify(token)).json['reason'] !== 'Account deleted'; i++) await sleep(100);
    assert.equal((await verify(token)).json['reason'], 'Account deleted');
    // Re-opened: deletedAt removed and the passkey listed again, the session epoch kept (as
    // documented) or put back to the token's.
    outOfBand(x.userId, d => {
      delete d['deletedAt'];
      Object.assign(d, { name: x.userId, webAuthnCredentials: [stored(x.keys[0]!, 1)], ...(epoch === undefined ? {} : { sessionEpoch: epoch }) });
    });
    const since = mark();
    const otherSince = otherRequests.length;
    const retry = await post('/users/me/delete', {}, token);
    if (epoch === undefined) {
      assert.equal(retry.status, 401, `${JSON.stringify(retry.json)}${out()}`);
      assert.equal(retry.json['error'], 'Invalid bearer token: Token revoked (signed out everywhere)');
    } else {
      assert.equal(retry.status, 409, `${JSON.stringify(retry.json)}${out()}`);
      assert.equal(retry.json['error'], 'Account not deleted');
    }
    assert.deepEqual(docPuts(x.userId, since), [], 'nothing is written');
    assert.deepEqual(otherRequests.slice(otherSince).filter(r => r.method === 'DELETE'), [], 'nothing is deleted');
    assert.equal(record(x.userId)!.deletedAt, undefined);
    assert.ok(others.has(`/${x.userId}/agents`));
    if (epoch === undefined) {
      // The account is open again: its passkey signs in, and the old token stays refused.
      await tokenFor(x.keys[0]!, 2, x.userId);
      assert.equal((await verify(token)).json['reason'], 'Token revoked (signed out everywhere)');
    } else {
      // As the answer says: sent again, the deletion is decided on the record the pod holds now.
      const again = await post('/users/me/delete', {}, token);
      assert.equal(again.status, 200, `${JSON.stringify(again.json)}${out()}`);
      assert.ok(record(x.userId)!.deletedAt);
    }
  }
});

test('P14: a Play guest token renewed (POST /tokens) at an instance whose copy of the owner is behind the pod is issued at the pod\'s session epoch, and verifies on both instances', { timeout: 90_000 }, async () => {
  // Two instances on the same pods (a deploy's overlap). A guest token's session epoch is checked
  // on its owner's record as read from the pod, and nothing on its path reads this server's copy,
  // so A's copy of an owner it loaded at epoch 0 stays there while B deletes the owner and
  // provisions it again (epoch 1), or signs it out everywhere (epoch 2), however long the relay
  // goes on introspecting the guest's tokens at A. A renewal at A was issued at its copy's epoch:
  // that token was refused on both instances ("Token revoked") at its first use, and the guest of
  // a live owner had to start again.
  const guest = await playGuestOnTwoInstances();
  const { id, a, b } = guest;
  const epochOf = (token: string): unknown =>
    JSON.parse(Buffer.from(token.slice(4, token.lastIndexOf('.')), 'base64url').toString('utf8'))['epoch'];
  /** The guest's renewal of its session's token at A; it verifies on both instances. */
  const renewAtA = async (session: { token: string; agentId: string }, when: string) => {
    const r = await post('/tokens', { userId: id, agentId: session.agentId }, session.token, a);
    assert.equal(r.status, 200, `${when}: ${JSON.stringify(r.json)}${out(a)}`);
    const token = String(r.json['token']);
    assert.equal(epochOf(token), record(id)!.sessionEpoch, `${when}: the renewal is issued at the pod's session epoch`);
    for (const inst of [a, b]) {
      assert.equal((await verify(token, inst)).json['valid'], true, `${when}: the renewal verifies at ${inst === a ? 'A' : 'B'}${out(inst)}`);
    }
    return { token, agentId: session.agentId };
  };
  try {
    // The guest bootstraps through B; the game's requests reach A too, which loads the owner (epoch 0).
    const first = await guest.provision(b);
    assert.equal((await verify(first.token, a)).json['valid'], true, out(a));
    // The guest deletes its owner through B (200), and bootstraps again through B, over the tombstone
    // at its session epoch (1).
    const deleted = await post('/users/me/delete', {}, first.token, b);
    assert.equal(deleted.status, 200, `${JSON.stringify(deleted.json)}${out(b)}`);
    const second = await guest.provision(b);
    assert.equal(record(id)!.sessionEpoch, 1);
    assert.equal((await verify(second.token, a)).json['valid'], true, `the new session's token verifies at A${out(a)}`);
    await renewAtA(second, 'at once');
    // The relay goes on introspecting the session's token at A, past this server's 10 s copy.
    await sleep(TTL_WAIT_MS);
    for (let i = 0; i < 3; i++) assert.equal((await verify(second.token, a)).json['valid'], true);
    const renewed = await renewAtA(second, 'past the copy\'s 10 s');
    // The guest signs out everywhere through B (epoch 2): a token that ended is not renewed at A, and
    // the session the guest bootstraps through B next renews there.
    const signedOut = await post('/tokens/me/sign-out-everywhere', {}, renewed.token, b);
    assert.equal(signedOut.status, 200, `${JSON.stringify(signedOut.json)}${out(b)}`);
    assert.equal(record(id)!.sessionEpoch, 2);
    const ended = await post('/tokens', { userId: id, agentId: renewed.agentId }, renewed.token, a);
    assert.equal(ended.status, 401, `${JSON.stringify(ended.json)}${out(a)}`);
    assert.equal(ended.json['error'], 'Token revoked (signed out everywhere)');
    await renewAtA(await guest.provision(b), 'after a sign-out everywhere through B');
  } finally {
    await guest.stop();
  }
});

test('P15: an owner its old guest token found deleted at A, provisioned again and claimed with a DID through B, is that DID\'s account at A at once: its token verifies, renews and reads there, and its deletion there deletes', { timeout: 90_000 }, async () => {
  // The guest token's check at A found the owner's tombstone and made A's copy that tombstone (for the
  // retry of a deletion A answered 503), fresh, so A decided on it for the next 10 s; nothing on a
  // guest token's path refreshed it. The guest then bootstrapped again through B and claimed the owner
  // with a DID there. At A that DID's token was "Account deleted" (/tokens/verify, GET /auth-methods/me,
  // POST /tokens), and its deletion at A was taken for that retry and answered 409 ("Account not
  // deleted"). Two ways the owner is deleted: through B (200), and at A, answered 503.
  for (const deletion of ['through B', 'at A, answered 503'] as const) {
    const guest = await playGuestOnTwoInstances();
    const { id, a, b } = guest;
    const what = (x: string) => `${deletion}: ${x}`;
    try {
      let t1: string;
      if (deletion === 'through B') {
        t1 = (await guest.provision(b)).token;
        // The game's requests reach A too, which loads the owner.
        assert.equal((await verify(t1, a)).json['valid'], true, out(a));
        const r = await post('/users/me/delete', {}, t1, b);
        assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out(b)}`);
      } else {
        t1 = (await guest.provision(a)).token;
        // The pod applies the tombstone and answers 500, and the read after it fails.
        failPuts(id, 'apply-then-500');
        const put = hold('PUT', id, 1, () => { failingGets.set(id, 1_000); });
        void put.arrived.then(() => put.release());
        const r = await post('/users/me/delete', {}, t1, a);
        failingGets.delete(id);
        putFaults.delete(id);
        assert.equal(r.status, 503, `${JSON.stringify(r.json)}${out(a)}`);
      }
      assert.ok(record(id)!.deletedAt, what('the pod holds the tombstone'));
      // The relay introspects the old guest token at A.
      assert.equal((await verify(t1, a)).json['reason'], 'Account deleted');
      // The guest bootstraps again through B, and claims its owner there with a DID.
      const t2 = (await guest.provision(b)).token;
      const k = didKey();
      const claimed = await didSignIn(k, { bearer: t2 }, b);
      assert.equal(claimed.status, 200, `${JSON.stringify(claimed.json)}${out(b)}`);
      assert.equal(claimed.json['userId'], id);
      assert.deepEqual(record(id)!.didKeys.map(x => x.did), [k.did]);
      const dt = String(claimed.json['token']);
      // At A, at once (well inside the 10 s a fresh copy is decided on).
      assert.equal((await verify(dt, a)).json['valid'], true, what(`the DID's token verifies at A${out(a)}`));
      const mine = await me(dt, a);
      assert.equal(mine.status, 200, what(`${JSON.stringify(mine.json)}${out(a)}`));
      assert.match(JSON.stringify(mine.json), new RegExp(k.did));
      const renewed = await post('/tokens', { userId: id, agentId: String(claimed.json['agentId']) }, dt, a);
      assert.equal(renewed.status, 200, what(`${JSON.stringify(renewed.json)}${out(a)}`));
      const deleted = await post('/users/me/delete', {}, dt, a);
      assert.equal(deleted.status, 200, what(`${JSON.stringify(deleted.json)}${out(a)}`));
      assert.ok(record(id)!.deletedAt, what('the owner is deleted'));
      assert.equal((await verify(dt, a)).json['valid'], false);
    } finally {
      putFaults.delete(id);
      failingGets.delete(id);
      await guest.stop();
    }
  }
});

test('C17: a passkey or DID removal, and a sign-out-everywhere, that nothing could settle each say so, and that sending the same request again is safe', async () => {
  const token = await tokenFor(c17.keys[0]!, 1, c17.userId);
  // The pod applies the write and answers 500, and the read after it fails.
  const unsettled = () => {
    failPuts(c17.userId, 'apply-then-500');
    const put = hold('PUT', c17.userId, 1, () => { failingGets.set(c17.userId, 1); });
    void put.arrived.then(() => put.release());
  };
  const p2 = c17.keys[1]!;
  const d1 = c17.dids![0]!;
  unsettled();
  const passkey = await del(`/auth-methods/me/webauthn/${encodeURIComponent(p2.id)}`, token);
  unsettled();
  const did = await del('/auth-methods/me/did', token, { did: d1.did });
  for (const r of [passkey, did]) {
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json['error'], 'Removal not confirmed');
    assert.match(String(r.json['detail']), /may or may not have been saved/);
    assert.match(String(r.json['detail']), /Sending the same removal again is safe/);
    assert.doesNotMatch(JSON.stringify(r.json), /auth-methods\/me/);
  }
  // Both landed (the pod applied them): sent again, each finds nothing to remove.
  assert.equal((await del(`/auth-methods/me/webauthn/${encodeURIComponent(p2.id)}`, token)).status, 404);
  assert.equal((await del('/auth-methods/me/did', token, { did: d1.did })).status, 404);
  assert.equal((await signIn(p2, 1)).status, 401);
  unsettled();
  const signedOut = await signOut(token);
  assert.equal(signedOut.status, 503, JSON.stringify(signedOut.json));
  assert.equal(signedOut.json['error'], 'Sign-out not confirmed');
  assert.match(String(signedOut.json['detail']), /may or may not have been saved/);
  assert.match(String(signedOut.json['detail']), /Signing out everywhere again is safe/);
  assert.doesNotMatch(JSON.stringify(signedOut.json), /auth-methods\/me/);
  assert.equal(record(c17.userId)!.sessionEpoch, 1, 'the pod took it');
});

test('C21: a sign-out-everywhere the pod took, but that nothing could read after, ends the old token at its next use', async () => {
  const token = await tokenFor(c21.keys[0]!, 1, c21.userId);
  // The pod applies the bump and answers 500, and the read after it fails: 503, "may or may not".
  failPuts(c21.userId, 'apply-then-500');
  const put = hold('PUT', c21.userId, 1, () => { failingGets.set(c21.userId, 1); });
  void put.arrived.then(() => put.release());
  const r = await signOut(token);
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.equal(r.json['error'], 'Sign-out not confirmed');
  assert.equal(record(c21.userId)!.sessionEpoch, 1, 'the pod took it');
  // This server's copy, marked stale by that failure, is behind the pod: the token's next check
  // waits for the pod's record instead of answering from the copy, and refuses the token. It used to
  // verify on the copy (refreshed only in the background), once at least.
  const v = await verify(token);
  assert.equal(v.json['valid'], false, `${JSON.stringify(v.json)}${out()}`);
  assert.match(String(v.json['reason']), /signed out everywhere/);
  assert.equal((await me(token)).status, 401);
});

test('P8: a removal of a wallet or DID this server\'s copy did not list yet, but the pod does, waits for the credential\'s turn before it writes; another account\'s removal of it does not wait', async () => {
  const token = await tokenFor(p8.wallet.keys[0]!, 1, p8.wallet.userId);
  const tokenD = await tokenFor(p8.did.keys[0]!, 1, p8.did.userId);
  const stranger = await tokenFor(p8.stranger.keys[0]!, 1, p8.stranger.userId);
  const w = W();
  const k = didKey();
  // Added by the other instance after this server read the accounts: its copies list neither.
  outOfBand(p8.wallet.userId, d => { (d['walletAddresses'] as string[]).push(w.address.toLowerCase()); });
  outOfBand(p8.did.userId, d => { (d['didKeys'] as unknown[]).push(didEntry(k)); });
  // A plain sign-in with each holds its turn: the indexes list it nowhere, so it opens the account
  // derived from it, and that write is held.
  const derived = deriveUserIdFromWallet(w.address.toLowerCase());
  const derivedD = deriveUserIdFromDid(k.did);
  const held = hold('PUT', derived);
  const heldD = hold('PUT', derivedD);
  const first = siwe(w);
  const firstD = didSignIn(k);
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  assert.ok(await within(heldD.arrived, 5_000), `no write arrived${out()}`);
  // Another account, whose record lists neither, removes each from itself: 404 at once, and nothing
  // is written. Any account can ask that, so it is not queued in the credential's turn, where it
  // could hold up the owner's sign-ins.
  let since = mark();
  const strangerW = del(`/auth-methods/me/wallet/${w.address.toLowerCase()}`, stranger);
  const strangerD = del('/auth-methods/me/did', stranger, { did: k.did });
  assert.deepEqual(await Promise.all([within(strangerW, 2_000), within(strangerD, 2_000)]), [true, true],
    'a stranger\'s removal waited for the credential\'s turn');
  for (const r of [await strangerW, await strangerD]) assert.equal(r.status, 404, JSON.stringify(r.json));
  assert.equal(docPuts(p8.stranger.userId, since).length, 0);
  // The owners' removals find each on the record as the pod holds it, write nothing there, and run
  // again in the turn, behind the sign-in. They used to remove it there and then, outside the turn.
  since = mark();
  const removal = del(`/auth-methods/me/wallet/${w.address.toLowerCase()}`, token);
  const removalD = del('/auth-methods/me/did', tokenD, { did: k.did });
  assert.equal(await within(removal, 1_000), false, 'the removal was answered while the wallet\'s turn was held');
  assert.equal(await within(removalD, 1_000), false, 'the removal was answered while the DID\'s turn was held');
  assert.equal(docPuts(p8.wallet.userId, since).length, 0, 'nothing was written outside the turn');
  assert.equal(docPuts(p8.did.userId, since).length, 0, 'nothing was written outside the turn');
  held.release();
  heldD.release();
  await signsInTo(first, derived);
  await signsInTo(firstD, derivedD);
  for (const r of [await removal, await removalD]) assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out()}`);
  assert.deepEqual(record(p8.wallet.userId)!.walletAddresses, []);
  assert.deepEqual(record(p8.did.userId)!.didKeys, []);
});

test('C18: an id deleted here whose record was put back without its tombstone is refused at its next first sign-in, and nothing is written', async () => {
  const w = W();
  const id = deriveUserIdFromWallet(w.address.toLowerCase());
  const token = String((await signsInTo(siwe(w), id)).json['token']);
  assert.equal((await post('/users/me/delete', {}, token)).status, 200);
  assert.ok(record(id)!.deletedAt, 'the tombstone is on the pod');
  // An operator puts a record without credentials back over the tombstone, by hand, and does not
  // restart the process (AUTH-ARCHITECTURE.md says to restart it).
  outOfBand(id, d => { delete d['deletedAt']; d['walletAddresses'] = []; });
  const since = mark();
  const again = await siwe(w);
  assert.equal(again.status, 409, `${JSON.stringify(again.json)}${out()}`);
  assert.equal(docPuts(id, since).length, 0, 'nothing is written over it: only the tombstone may be');
  assert.deepEqual(record(id)!.walletAddresses, []);
  assert.equal(docs.has(id), true);
});

test('C19: a first sign-in or passkey registration the pod refused (403) says nothing was changed, and records nothing', async () => {
  // The pod refuses the write, and the next two reads fail (the one that settles the write, and the
  // one a first sign-in made once more after the lock, which no longer follows a refusal).
  const refused = (userId: string) => {
    failPuts(userId, '403');
    const put = hold('PUT', userId, 1, () => { failingGets.set(userId, 2); });
    void put.arrived.then(() => put.release());
  };
  // The write did not land, so the answer is that nothing was changed. It used to say "may or may
  // not have been saved", and record the write for the wallet's next sign-in.
  const w = W();
  const id = deriveUserIdFromWallet(w.address.toLowerCase());
  refused(id);
  const r = await siwe(w);
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.match(String(r.json['detail']), /did not take the write\. Nothing was changed/);
  assert.doesNotMatch(JSON.stringify(r.json), /may or may not/);
  assert.equal(docs.has(id), false);
  // Nothing was recorded: the wallet's next sign-in, while the pod cannot be read, gets the plain
  // answer for an unreadable pod, not "an earlier write of this wallet ... was not confirmed".
  failingGets.set(id, 1);
  const unread = await siwe(w);
  assert.equal(unread.status, 503, JSON.stringify(unread.json));
  assert.doesNotMatch(JSON.stringify(unread.json), /earlier write/);
  await signsInTo(siwe(w), id);
  // A first passkey registration the same way.
  const key = P();
  refused(key.userId);
  const reg = await freshPasskey(key);
  assert.equal(reg.status, 503, JSON.stringify(reg.json));
  assert.match(String(reg.json['detail']), /did not take the write, so this passkey was not saved/);
  assert.equal(docs.has(key.userId), false);
});

// ── K. A wallet or DID being added, or whose add the pod did not confirm ────────────────────
test('K1: a wallet or did:key sign-in made while a bearer adds that credential waits for the add, and opens no other account', async () => {
  const derivedOf = (w: AnyWallet) => deriveUserIdFromWallet(w.address.toLowerCase());
  // A wallet added through /auth/siwe: a plain and an existingOnly sign-in made while its write is
  // in flight sign in to the account it is added to, once the pod has it.
  const walletToken = await tokenFor(k1.wallet.keys[0]!, 1, k1.wallet.userId);
  const w = W();
  let held = hold('PUT', k1.wallet.userId);
  const addW = siwe(w, { bearer: walletToken });
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  const plainW = siwe(w);
  const existingW = siwe(w, { existingOnly: true });
  assert.equal(await within(Promise.race([plainW, existingW]), 500), false, 'a sign-in with the wallet being added was answered before the add');
  held.release();
  await signsInTo(addW, k1.wallet.userId);
  await signsInTo(plainW, k1.wallet.userId);
  await signsInTo(existingW, k1.wallet.userId);
  await signsInTo(siwe(w), k1.wallet.userId);
  assert.equal(docs.has(derivedOf(w)), false, 'no account is opened for the wallet');

  // The same for a did:key added through /auth/did.
  const didToken = await tokenFor(k1.did.keys[0]!, 1, k1.did.userId);
  const k = didKey();
  held = hold('PUT', k1.did.userId);
  const addD = didSignIn(k, { bearer: didToken });
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  const plainD = didSignIn(k);
  assert.equal(await within(plainD, 500), false, 'a sign-in with the did:key being added was answered before the add');
  held.release();
  await signsInTo(addD, k1.did.userId);
  await signsInTo(plainD, k1.did.userId);
  await signsInTo(didSignIn(k), k1.did.userId);
  assert.equal(docs.has(deriveUserIdFromDid(k.did)), false, 'no account is opened for the did:key');

  // And for a wallet linked through /wallet/link.
  const linkToken = await tokenFor(k1.link.keys[0]!, 1, k1.link.userId);
  const wl = W();
  held = hold('PUT', k1.link.userId);
  const link = linkWallet(wl, linkToken);
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  const plainL = siwe(wl);
  assert.equal(await within(plainL, 500), false, 'a sign-in with the wallet being linked was answered before the link');
  held.release();
  const linked = await link;
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  await signsInTo(plainL, k1.link.userId);
  assert.equal(docs.has(derivedOf(wl)), false, 'no account is opened for the wallet');

  // The other way round: a first sign-in is opening the account derived from a wallet when another
  // account adds the same wallet with a bearer, or links it. They wait for it, and then find the
  // wallet held: the add signs in to that account, the link is refused, and neither puts the
  // wallet on a second account.
  const otherToken = await tokenFor(k1.other.keys[0]!, 1, k1.other.userId);
  const wf = W();
  held = hold('PUT', derivedOf(wf));
  const first = siwe(wf);
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  const addF = siwe(wf, { bearer: otherToken });
  const linkF = linkWallet(wf, otherToken);
  assert.equal(await within(Promise.race([addF, linkF]), 500), false, 'an add of the wallet being opened was answered before the first sign-in');
  held.release();
  await signsInTo(first, derivedOf(wf));
  await signsInTo(addF, derivedOf(wf));
  assert.equal((await linkF).status, 409, JSON.stringify((await linkF).json));
  assert.deepEqual(record(k1.other.userId)!.walletAddresses, [], 'the wallet is on one account only');
});

test('K2: a wallet or did:key whose bearer add the pod took without confirming it signs in to that account, and opens no other', async () => {
  const derivedOf = (w: AnyWallet) => deriveUserIdFromWallet(w.address.toLowerCase());
  // Tokens first: a passkey sign-in writes its counter.
  const token = Object.fromEntries(await Promise.all(Object.entries(k2).map(async ([name, a]) => [name, await tokenFor(a.keys[0]!, 1, a.userId)] as const)));
  // The pod applies the add's write and answers 500, and the next `gets` reads of the account fail.
  const unconfirmed = (userId: string, gets: number, attempt: () => Promise<Reply>) => {
    failPuts(userId, 'apply-then-500');
    const put = hold('PUT', userId, 1, () => { failingGets.set(userId, gets); });
    void put.arrived.then(() => put.release());
    return attempt();
  };
  // The read right after the write fails: the account is read again before the answer, which says
  // the pod lists the credential; its next sign-in goes there.
  const w = W();
  const addW = await unconfirmed(k2.wallet.userId, 1, () => siwe(w, { bearer: token['wallet'] }));
  assert.equal(addW.status, 503, JSON.stringify(addW.json));
  assert.deepEqual(record(k2.wallet.userId)!.walletAddresses, [w.address.toLowerCase()]);
  await signsInTo(siwe(w), k2.wallet.userId);
  await signsInTo(siwe(w, { existingOnly: true }), k2.wallet.userId);
  assert.equal(docs.has(derivedOf(w)), false, 'no account is opened for the wallet');
  assert.match(String(addW.json['detail']), /lists this wallet/);
  const k = didKey();
  const addD = await unconfirmed(k2.did.userId, 1, () => didSignIn(k, { bearer: token['did'] }));
  assert.equal(addD.status, 503, JSON.stringify(addD.json));
  await signsInTo(didSignIn(k), k2.did.userId);
  assert.equal(docs.has(deriveUserIdFromDid(k.did)), false, 'no account is opened for the did:key');
  assert.match(String(addD.json['detail']), /lists this DID/);
  // /wallet/link reports such a wallet linked: the pod has it.
  const wl = W();
  const link = await unconfirmed(k2.link.userId, 1, () => linkWallet(wl, token['link']!));
  assert.equal(link.status, 200, JSON.stringify(link.json));
  await signsInTo(siwe(wl), k2.link.userId);
  assert.equal(docs.has(derivedOf(wl)), false, 'no account is opened for the wallet');

  // That read fails too: the answer says the add may or may not have been saved, and the next
  // sign-in with the credential reads the account first. While it cannot, nothing is decided (503,
  // no account opened); once it can, the sign-in goes to the account the pod lists it on.
  const wb = W();
  const blind = await unconfirmed(k2.blind.userId, 2, () => siwe(wb, { bearer: token['blind'] }));
  assert.equal(blind.status, 503, JSON.stringify(blind.json));
  failingGets.set(k2.blind.userId, 1);
  const unread = await siwe(wb);
  assert.equal(docs.has(derivedOf(wb)), false, 'no account is opened for the wallet while its add is unconfirmed');
  assert.equal(unread.status, 503, JSON.stringify(unread.json));
  assert.match(String(blind.json['detail']), /may or may not/);
  await signsInTo(siwe(wb), k2.blind.userId);
  await signsInTo(siwe(wb), k2.blind.userId);
  assert.equal(docs.has(derivedOf(wb)), false, 'no account is opened for the wallet');
  const kb = didKey();
  const blindD = await unconfirmed(k2.blindDid.userId, 2, () => didSignIn(kb, { bearer: token['blindDid'] }));
  assert.equal(blindD.status, 503, JSON.stringify(blindD.json));
  await signsInTo(didSignIn(kb), k2.blindDid.userId);
  assert.equal(docs.has(deriveUserIdFromDid(kb.did)), false, 'no account is opened for the did:key');
  assert.match(String(blindD.json['detail']), /may or may not/);
  // /wallet/link the same way: neither 200 (nobody confirmed it) nor "failed" (it may have landed),
  // and the wallet's next sign-in reads the account first and signs in there.
  const wlb = W();
  const linkBlind = await unconfirmed(k2.linkBlind.userId, 2, () => linkWallet(wlb, token['linkBlind']!));
  assert.equal(linkBlind.status, 503, JSON.stringify(linkBlind.json));
  assert.match(String(linkBlind.json['detail']), /may or may not/);
  assert.match(String(linkBlind.json['detail']), /Linking it again is safe/);
  await signsInTo(siwe(wlb), k2.linkBlind.userId);
  assert.equal(docs.has(derivedOf(wlb)), false, 'no account is opened for the wallet');
  // A did:web the same way. Its plain sign-in takes no turn of its own (it cannot open an account),
  // but one whose add is recorded as unconfirmed does: it settles the account first, and signs in
  // there. It used to answer 401 "not registered" while the pod listed the DID.
  const kw = didKey();
  const web = 'did:web:unconfirmed-add.example';
  const blindW = await unconfirmed(k2.blindWeb.userId, 2, () => didSignIn(kw, { did: web, bearer: token['blindWeb'] }));
  assert.equal(blindW.status, 503, JSON.stringify(blindW.json));
  assert.match(String(blindW.json['detail']), /may or may not/);
  assert.deepEqual(record(k2.blindWeb.userId)!.didKeys.map(d => d.did), [web]);
  await signsInTo(didSignIn(kw, { did: web }), k2.blindWeb.userId);
  await signsInTo(didSignIn(kw, { did: web }), k2.blindWeb.userId);
});

test('K3: a first wallet or DID sign-in that no read could confirm sends the credential\'s next sign-in to that account, not a new one', async () => {
  // A bootstrap claim whose write the pod applied and answered 500, with the read after it and the
  // load of the account failing too: 503 "may or may not", and the invite is given back. The
  // credential's next sign-in, without the invite, reads the seeded account first and signs in
  // there; it used to open the account derived from the credential beside it.
  const blind = (invite: { userId: string }, attempt: () => Promise<Reply>) => {
    failPuts(invite.userId, 'apply-then-500');
    const put = hold('PUT', invite.userId, 1, () => { failingGets.set(invite.userId, 2); });
    void put.arrived.then(() => put.release());
    return attempt();
  };
  const w = W();
  const claim = await blind(invites.unsure, () => siwe(w, bootstrap(invites.unsure)));
  assert.equal(claim.status, 503, JSON.stringify(claim.json));
  assert.match(String(claim.json['detail']), /may or may not/);
  assert.deepEqual(record(invites.unsure.userId)!.walletAddresses, [w.address.toLowerCase()]);
  await signsInTo(siwe(w), invites.unsure.userId);
  assert.equal(docs.has(deriveUserIdFromWallet(w.address.toLowerCase())), false, 'no account is opened for the wallet');
  const k = didKey();
  const didClaim = await blind(invites.unsureDid, () => didSignIn(k, bootstrap(invites.unsureDid)));
  assert.equal(didClaim.status, 503, JSON.stringify(didClaim.json));
  assert.match(String(didClaim.json['detail']), /may or may not/);
  await signsInTo(didSignIn(k), invites.unsureDid.userId);
  assert.equal(docs.has(deriveUserIdFromDid(k.did)), false, 'no account is opened for the did:key');
  // A did:web bootstrap claim: its plain sign-in after the 503 settles the seeded account first
  // (the recorded write gives it the DID's turn), and signs in there.
  const kw = didKey();
  const web = 'did:web:unconfirmed-claim.example';
  const webClaim = await blind(invites.unsureWeb, () => didSignIn(kw, { did: web, ...bootstrap(invites.unsureWeb) }));
  assert.equal(webClaim.status, 503, JSON.stringify(webClaim.json));
  assert.match(String(webClaim.json['detail']), /may or may not/);
  assert.deepEqual(record(invites.unsureWeb.userId)!.didKeys.map(d => d.did), [web]);
  await signsInTo(didSignIn(kw, { did: web }), invites.unsureWeb.userId);
});

test('K4: a sign-in with someone else\'s did:web and a key of its own does not hold up the owner\'s sign-in', async () => {
  // The stranger's signature verifies against the key it sent, and then the DID's holders are
  // checked: none lists that key, so the account derived from the DID is read (held here).
  const derived = deriveUserIdFromDid(k4.did);
  const held = hold('GET', derived);
  const stranger = didSignIn(didKey(), { did: k4.did });
  assert.ok(await within(held.arrived, 5_000), `the stranger's request never read the derived account${out()}`);
  const started = Date.now();
  const owner = await didSignIn(k4.key, { did: k4.did });
  const took = Date.now() - started;
  held.release();
  assert.equal(owner.status, 200, `${JSON.stringify(owner.json)}${out()}`);
  assert.equal(owner.json['userId'], k4.owner.userId);
  assert.ok(took < 3_000, `the owner's sign-in waited ${took} ms behind a request that could not change who holds the DID`);
  assert.equal((await stranger).status, 401);
  // A stranger's request that names a bootstrap id, with an invite that is not that id's, cannot
  // write either, and takes no turn: the owner's request with a bearer (which does take the turn)
  // is not held behind it. Only the fields being there used to count.
  const ownerToken = await tokenFor(k4.owner.keys[0]!, 1, k4.owner.userId);
  const heldAgain = hold('GET', derived);
  const claimant = didSignIn(didKey(), { did: k4.did, extra: { bootstrapUserId: invites.never.userId, bootstrapInvite: 'not-its-invite' } });
  assert.ok(await within(heldAgain.arrived, 5_000), `the stranger's request never read the derived account${out()}`);
  const startedAgain = Date.now();
  const withBearer = await didSignIn(k4.key, { did: k4.did, bearer: ownerToken });
  const tookAgain = Date.now() - startedAgain;
  heldAgain.release();
  assert.equal(withBearer.status, 200, `${JSON.stringify(withBearer.json)}${out()}`);
  assert.equal(withBearer.json['userId'], k4.owner.userId);
  assert.ok(tookAgain < 3_000, `the owner's request with a bearer waited ${tookAgain} ms behind a bootstrap field without its invite`);
  assert.equal((await claimant).status, 401);
});

test('K5: a bearer whose check fails adds nothing, so a did:web another account is adding stays on that account alone', async () => {
  // The bearer of an account this server has not loaded is checked by loading it, and that read
  // fails once. The request is decided outside the DID's turn, adds nothing and is refused (503,
  // try again); it used to check the bearer again inside, pass, and add the DID outside the turn,
  // beside the add in flight.
  const did = 'did:web:first-check.example';
  const holderToken = await tokenFor(k5.holder.keys[0]!, 1, k5.holder.userId);
  const held = hold('PUT', k5.holder.userId);
  const first = didSignIn(didKey(), { did, bearer: holderToken });
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  failingGets.set(k5.unloaded.userId, 1);
  const second = await didSignIn(didKey(), { did, bearer: tokenSignedElsewhere(k5.unloaded.userId) });
  held.release();
  await signsInTo(first, k5.holder.userId);
  assert.equal(second.status, 503, `${JSON.stringify(second.json)}${out()}`);
  assert.match(String(second.json['error']), /Could not read the account for this token/);
  assert.deepEqual(record(k5.unloaded.userId)!.didKeys, [], 'the DID is on one account only');
  assert.deepEqual(record(k5.holder.userId)!.didKeys.map(d => d.did), [did]);
});

test('R3: two adds of one did:web, by bearers or a bootstrap claim, take its turn one after the other: the second is refused, and one account lists it', async () => {
  const tokenA = await tokenFor(r3.a.keys[0]!, 1, r3.a.userId);
  const tokenB = await tokenFor(r3.b.keys[0]!, 1, r3.b.userId);
  // Two bearers, each with a key of its own.
  const did = 'did:web:race-adds.example';
  let held = hold('PUT', r3.a.userId);
  const addA = didSignIn(didKey(), { did, bearer: tokenA });
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  const addB = didSignIn(didKey(), { did, bearer: tokenB });
  assert.equal(await within(addB, 500), false, 'the second add was answered while the first was being written');
  held.release();
  await signsInTo(addA, r3.a.userId);
  assert.equal((await addB).status, 401, JSON.stringify((await addB).json));
  assert.deepEqual(record(r3.b.userId)!.didKeys, [], 'the DID is on one account only');
  // A bootstrap claim of a did:web, and a bearer's add of the same DID.
  const claimed = 'did:web:race-claim.example';
  held = hold('PUT', invites.raceWeb.userId);
  const claim = didSignIn(didKey(), { did: claimed, ...bootstrap(invites.raceWeb) });
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  const addC = didSignIn(didKey(), { did: claimed, bearer: tokenB });
  assert.equal(await within(addC, 500), false, 'the add was answered while the claim was being written');
  held.release();
  await signsInTo(claim, invites.raceWeb.userId);
  assert.equal((await addC).status, 401, JSON.stringify((await addC).json));
  assert.deepEqual(record(r3.b.userId)!.didKeys, [], 'the DID is on one account only');
});

test('K6: a wallet or did:key sent with a bearer that does not verify is refused, and opens no account of its own', async () => {
  const derivedOf = (w: AnyWallet) => deriveUserIdFromWallet(w.address.toLowerCase());
  // The bearer's account was opened by the other instance after this one listed the pods (so it is
  // not loaded here), and the read that would load it fails once: 503, nothing added and no account
  // opened. The request used to go on as a plain first sign-in and open the account derived from
  // the credential, which is then preferred: the owner's retry with the same bearer signed in there
  // and never added the credential to the owner's account.
  const w = W();
  failingGets.set(k6.wallet.userId, 1);
  const addW = await siwe(w, { bearer: tokenSignedElsewhere(k6.wallet.userId) });
  assert.equal(addW.status, 503, `${JSON.stringify(addW.json)}${out()}`);
  assert.match(String(addW.json['error']), /Could not read the account for this token/);
  assert.equal(docs.has(derivedOf(w)), false, 'no account is opened for the wallet');
  assert.deepEqual(record(k6.wallet.userId)!.walletAddresses, []);
  // Once the account reads, the retry adds the wallet to it, and the wallet signs in there.
  await signsInTo(siwe(w, { bearer: tokenSignedElsewhere(k6.wallet.userId) }), k6.wallet.userId);
  assert.deepEqual(record(k6.wallet.userId)!.walletAddresses, [w.address.toLowerCase()]);
  await signsInTo(siwe(w), k6.wallet.userId);
  assert.equal(docs.has(derivedOf(w)), false, 'no account is opened for the wallet');
  const k = didKey();
  failingGets.set(k6.did.userId, 1);
  const addD = await didSignIn(k, { bearer: tokenSignedElsewhere(k6.did.userId) });
  assert.equal(addD.status, 503, `${JSON.stringify(addD.json)}${out()}`);
  assert.equal(docs.has(deriveUserIdFromDid(k.did)), false, 'no account is opened for the did:key');
  await signsInTo(didSignIn(k, { bearer: tokenSignedElsewhere(k6.did.userId) }), k6.did.userId);
  await signsInTo(didSignIn(k), k6.did.userId);
  assert.equal(docs.has(deriveUserIdFromDid(k.did)), false, 'no account is opened for the did:key');
  // A bearer signed out everywhere: 401, and no account is opened for the wallet or the did:key.
  const token = await tokenFor(k6.revoked.keys[0]!, 1, k6.revoked.userId);
  assert.equal((await signOut(token)).status, 200);
  const w2 = W();
  const k2 = didKey();
  for (const r of [await siwe(w2, { bearer: token }), await didSignIn(k2, { bearer: token })]) {
    assert.equal(r.status, 401, JSON.stringify(r.json));
    assert.match(String(r.json['error']), /signed out everywhere/);
  }
  assert.equal(docs.has(derivedOf(w2)), false, 'no account is opened for the wallet');
  assert.equal(docs.has(deriveUserIdFromDid(k2.did)), false, 'no account is opened for the did:key');
  assert.deepEqual(record(k6.revoked.userId)!.walletAddresses, []);
  // Without a bearer, the same credentials open accounts of their own, as any first sign-in does.
  await signsInTo(siwe(w2), derivedOf(w2));
  // A bootstrap claim, of a wallet and of a did:web, sent with a bearer that does not verify (a
  // stale add-device token, say) is refused the same way, and its invite is not spent: the same
  // claim without the bearer then signs in to the seeded account.
  const wc = W();
  const claimW = await siwe(wc, { bearer: 'not-a-token', ...bootstrap(invites.bearerClaim) });
  assert.equal(claimW.status, 401, JSON.stringify(claimW.json));
  assert.match(String(claimW.json['error']), /Invalid bearer token/);
  const web = 'did:web:bearer-claim.example';
  const kw = didKey();
  const claimD = await didSignIn(kw, { did: web, bearer: 'not-a-token', ...bootstrap(invites.bearerClaimWeb) });
  assert.equal(claimD.status, 401, JSON.stringify(claimD.json));
  assert.match(String(claimD.json['error']), /Invalid bearer token/);
  for (const id of [invites.bearerClaim.userId, invites.bearerClaimWeb.userId]) assert.equal(docs.has(id), false, `${id}: nothing written`);
  await signsInTo(siwe(wc, bootstrap(invites.bearerClaim)), invites.bearerClaim.userId);
  await signsInTo(didSignIn(kw, { did: web, ...bootstrap(invites.bearerClaimWeb) }), invites.bearerClaimWeb.userId);
  // The /connect page sends the add-device token with every request while its field is filled, so
  // a stale one there makes a first sign-in (a wallet no account holds yet), an add or an invite
  // claim 401: the page says to clear it. A wallet an account already lists signs in whatever bearer
  // comes with it.
  const page = await (await fetch(`${primary.base}/connect`)).text();
  const script = page.slice(page.indexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function(script), 'the page\'s script parses');
  const from = script.indexOf('function staleTokenHint(');
  assert.ok(from >= 0, 'the /connect page explains a stale add-device token');
  const hint = new Function(`${script.slice(from, script.indexOf('\n}', from) + 2)}; return staleTokenHint;`)() as
    (status: number, error: unknown, adv: { addDeviceToken: string; bootstrapUserId: string }) => string;
  assert.match(hint(401, claimW.json['error'], { addDeviceToken: 'not-a-token', bootstrapUserId: invites.bearerClaim.userId }), /clear it to claim the invite/);
  assert.match(hint(401, 'Invalid bearer token: Token expired', { addDeviceToken: 'x', bootstrapUserId: '' }), /clear it to sign in/);
  assert.equal(hint(401, 'This wallet is not registered.', { addDeviceToken: 'x', bootstrapUserId: '' }), '');
  assert.equal(hint(401, 'Invalid bearer token: Token expired', { addDeviceToken: '', bootstrapUserId: '' }), '');
  // And the page shows it: both requests that send the token append the hint to the error they
  // show (a passkey's registration options, a wallet's sign-in). Without these calls the function
  // above was still there and still passed, and no user saw a hint.
  for (const [fn, call] of [['passkeyCreate', /\+ staleTokenHint\(optRes\.status, failed\.error, adv\)/],
    ['connectMetaMask', /\+ staleTokenHint\(authResp\.status, result\.error, adv\)/]] as const) {
    const at = script.indexOf(`async function ${fn}(`);
    assert.ok(at >= 0, `the page has ${fn}`);
    assert.match(script.slice(at, script.indexOf('\n}', at)), call, `${fn} appends the hint to the error it shows`);
  }
  // A bearer whose account could not be read is a 503 on the other routes that act on the bearer's
  // own account too: a link, a device's registration options, a removal. They answered 401, which
  // tells a client its token is no good.
  const tokenL = tokenSignedElsewhere(k6.link.userId);
  const wl = W();
  const unreadable = [
    () => linkWallet(wl, tokenL),
    () => post('/auth/webauthn/register-options', { name: 'Device' }, tokenL),
    () => del(`/auth-methods/me/wallet/${wl.address.toLowerCase()}`, tokenL),
  ];
  for (const send of unreadable) {
    failingGets.set(k6.link.userId, 1);
    const r = await send();
    assert.equal(r.status, 503, `${JSON.stringify(r.json)}${out()}`);
    assert.equal(r.json['error'], 'Could not read the account for this token just now');
  }
  assert.deepEqual(record(k6.link.userId)!.walletAddresses, []);
  const linked = await linkWallet(wl, tokenL);
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  assert.deepEqual(record(k6.link.userId)!.walletAddresses, [wl.address.toLowerCase()]);
});

test('K7: a Play guest\'s bearer whose owner\'s record cannot be read for a moment is answered 503 (try again) wherever it adds to or acts on the account; one whose anchor does not open to the owner is 401; and a deletion the pod refuses keeps the account', async () => {
  // A guest claims its Play owner by adding a wallet or DID with its bearer. Its check reads the
  // owner's anchor from the pod; a read that failed was answered 401 "Provisional owner unavailable"
  // and told to sign in again. /auth/siwe and /auth/did answer 503 for it; so do /wallet/link, a
  // device's registration options and every route that acts on the bearer's own account.
  const derivedOf = (w: AnyWallet) => deriveUserIdFromWallet(w.address.toLowerCase());
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const owner = livePlayGuest(issuer);
  const sealedElsewhere = livePlayGuest(issuer, crypto.randomBytes(32));
  const leaving = livePlayGuest(issuer);
  const play = await startIdentity(port, { CSS_PUBLIC_URL: 'https://pods.example/', PROVISIONAL_PLAY_CLIENTS: PLAY_CLIENTS });
  try {
    const w = W();
    const k = didKey();
    failingGets.set(owner.id, 1);
    const addW = await siwe(w, { bearer: owner.token }, play);
    assert.equal(addW.status, 503, `${JSON.stringify(addW.json)}${out(play)}`);
    assert.match(String(addW.json['error']), /Could not read the account for this token/);
    failingGets.set(owner.id, 1);
    const addD = await didSignIn(k, { bearer: owner.token }, play);
    assert.equal(addD.status, 503, `${JSON.stringify(addD.json)}${out(play)}`);
    const others = [
      () => linkWallet(W(), owner.token, play),
      () => post('/auth/webauthn/register-options', { name: 'Device' }, owner.token, play),
      () => call(play, 'GET', '/agents/me', undefined, owner.token),
      () => del(`/auth-methods/me/wallet/${w.address.toLowerCase()}`, owner.token, undefined, play),
    ];
    for (const send of others) {
      failingGets.set(owner.id, 1);
      const r = await send();
      assert.equal(r.status, 503, `${JSON.stringify(r.json)}${out(play)}`);
      assert.equal(r.json['error'], 'Could not read the account for this token just now');
    }
    assert.deepEqual(record(owner.id)!.walletAddresses, []);
    assert.equal(docs.has(derivedOf(w)), false, 'no account is opened for the wallet');
    assert.equal(docs.has(deriveUserIdFromDid(k.did)), false, 'no account is opened for the did:key');
    // Readable again: the same request adds the wallet to the owner.
    await signsInTo(siwe(w, { bearer: owner.token }, play), owner.id, play);
    assert.deepEqual(record(owner.id)!.walletAddresses, [w.address.toLowerCase()]);
    // An owner whose anchor does not open to it (sealed with another key): 401, as before, with
    // nothing added and no account opened. A read that fails is a 503; this is a refusal.
    const w2 = W();
    const k2 = didKey();
    const w3 = W();
    for (const r of [await siwe(w2, { bearer: sealedElsewhere.token }, play), await didSignIn(k2, { bearer: sealedElsewhere.token }, play),
      await linkWallet(w3, sealedElsewhere.token, play)]) {
      assert.equal(r.status, 401, `${JSON.stringify(r.json)}${out(play)}`);
      assert.match(String(r.json['error']), /Provisional owner unavailable/);
    }
    assert.deepEqual(record(sealedElsewhere.id)!.walletAddresses, []);
    assert.deepEqual(record(sealedElsewhere.id)!.didKeys, []);
    for (const id of [derivedOf(w2), deriveUserIdFromDid(k2.did), derivedOf(w3)]) assert.equal(docs.has(id), false, `${id}: no account is opened`);
    // A guest's deletion whose tombstone the pod refuses: 503, and the owner stays, its token working.
    // It answered 200 deleted, while the anchor stayed on the pod, so the guest token verified again
    // at once.
    failPuts(leaving.id, '403');
    const refused = await post('/users/me/delete', {}, leaving.token, play);
    assert.equal(refused.status, 503, `${JSON.stringify(refused.json)}${out(play)}`);
    assert.equal(refused.json['error'], 'Deletion not completed');
    assert.ok(docs.has(leaving.id) && !record(leaving.id)!.deletedAt);
    assert.equal((await verify(leaving.token, play)).json['valid'], true);
    putFaults.delete(leaving.id);
    const deleted = await post('/users/me/delete', {}, leaving.token, play);
    assert.equal(deleted.status, 200, `${JSON.stringify(deleted.json)}${out(play)}`);
    assert.ok(record(leaving.id)?.deletedAt, 'the record is the tombstone, which stays');
    assert.equal((await verify(leaving.token, play)).json['valid'], false);
  } finally {
    failingGets.delete(owner.id);
    putFaults.delete(leaving.id);
    await play.stop();
  }
});

test('K8: a bearer add whose account is deleted while the request waits, for the DID\'s turn or for the read of the wallet\'s derived account, is refused, and opens no account', async () => {
  const derivedOf = (w: AnyWallet) => deriveUserIdFromWallet(w.address.toLowerCase());
  const tokenY = await tokenFor(k8.y.keys[0]!, 1, k8.y.userId);
  const tokenDidX = await tokenFor(k8.didX.keys[0]!, 1, k8.didX.userId);
  const tokenWalletX = await tokenFor(k8.walletX.keys[0]!, 1, k8.walletX.userId);
  // /auth/did: account Y removes the did:key, in its turn, and that write is held. X's add of the
  // same did:key verifies its bearer on arrival and waits for the turn, while X is deleted.
  const held = hold('PUT', k8.y.userId);
  const removal = del('/auth-methods/me/did', tokenY, { did: k8key.did });
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  const addD = didSignIn(k8key, { bearer: tokenDidX });
  assert.equal(await within(addD, 500), false, 'the add waits for the DID\'s turn');
  const gone = await post('/users/me/delete', {}, tokenDidX);
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  held.release();
  assert.equal((await removal).status, 200);
  // No account holds the did:key now, and the bearer's account is gone: refused, as a bearer deleted
  // before the request is. It used to go on as a first sign-in and open the account derived from it.
  const d = await addD;
  assert.equal(d.status, 401, `${JSON.stringify(d.json)}${out()}`);
  assert.match(String(d.json['error']), /Account deleted/);
  assert.equal(docs.has(deriveUserIdFromDid(k8key.did)), false, 'no account is opened for the did:key');
  // /auth/siwe checks the bearer in the wallet's turn, then reads the account derived from the wallet
  // (walletHolder); X is deleted while that read is held.
  const w = W();
  const read = hold('GET', derivedOf(w));
  const addW = siwe(w, { bearer: tokenWalletX });
  assert.ok(await within(read.arrived, 5_000), `no read arrived${out()}`);
  const goneW = await post('/users/me/delete', {}, tokenWalletX);
  assert.equal(goneW.status, 200, JSON.stringify(goneW.json));
  read.release();
  const r = await addW;
  assert.equal(r.status, 401, `${JSON.stringify(r.json)}${out()}`);
  assert.match(String(r.json['error']), /Account deleted/);
  assert.equal(docs.has(derivedOf(w)), false, 'no account is opened for the wallet');
  // Without a bearer, each opens its own account, as any first sign-in does.
  await signsInTo(didSignIn(k8key), deriveUserIdFromDid(k8key.did));
  await signsInTo(siwe(w), derivedOf(w));
});

test('S9: an add that waits while its account signs out everywhere adds nothing: a DID or wallet waiting for its turn, a device between its options and its registration', async () => {
  const token = Object.fromEntries(await Promise.all(Object.entries(s9).map(async ([n, a]) => [n, await tokenFor(a.keys[0]!, 1, a.userId)] as const)));
  /** Another account's add of the same credential holds the turn until `release`; the pod answers it 500. */
  const holdTurn = (userId: string) => { failPuts(userId, '500'); return hold('PUT', userId); };
  // A did:web through /auth/did. The bearer was checked when the request arrived; the add checks the
  // record it writes, and finds the account signed out since that token was issued.
  const did = 'did:web:signed-out-add.example';
  let held = holdTurn(s9.y.userId);
  const addY = didSignIn(didKey(), { did, bearer: token['y'] });
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  const addX = didSignIn(didKey(), { did, bearer: token['x'] });
  assert.equal(await within(addX, 500), false, 'the add waits for the DID\'s turn');
  assert.equal((await signOut(token['x']!)).status, 200);
  assert.equal((await me(token['x']!)).status, 401);
  held.release();
  assert.equal((await addY).status, 503);
  const x = await addX;
  assert.equal(x.status, 401, `${JSON.stringify(x.json)}${out()}`);
  assert.match(String(x.json['error']), /signed out everywhere/);
  assert.deepEqual(record(s9.x.userId)!.didKeys, [], 'nothing is added to the signed-out account');
  // A wallet through /wallet/link, the same way.
  const w = W();
  held = holdTurn(s9.linkY.userId);
  const addLY = siwe(w, { bearer: token['linkY'] });
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  const linkX = linkWallet(w, token['linkX']!);
  assert.equal(await within(linkX, 500), false, 'the link waits for the wallet\'s turn');
  assert.equal((await signOut(token['linkX']!)).status, 200);
  held.release();
  assert.equal((await addLY).status, 503);
  const l = await linkX;
  assert.equal(l.status, 401, JSON.stringify(l.json));
  assert.match(String(l.json['error']), /signed out everywhere/);
  assert.deepEqual(record(s9.linkX.userId)!.walletAddresses, []);
  // /auth/siwe checks its bearer inside the wallet's turn, so a signed-out one is refused there.
  const w2 = W();
  held = holdTurn(s9.siweY.userId);
  const addSY = siwe(w2, { bearer: token['siweY'] });
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  const addSX = siwe(w2, { bearer: token['siweX'] });
  assert.equal(await within(addSX, 500), false);
  assert.equal((await signOut(token['siweX']!)).status, 200);
  held.release();
  assert.equal((await addSY).status, 503);
  const sx = await addSX;
  assert.equal(sx.status, 401, JSON.stringify(sx.json));
  assert.deepEqual(record(s9.siweX.userId)!.walletAddresses, []);
  assert.equal(docs.has(deriveUserIdFromWallet(w2.address.toLowerCase())), false, 'no account is opened for the wallet');
  // A device: the options were issued to the bearer, which then signs out everywhere; the
  // registration adds nothing (it used to, and its session was issued at the new epoch).
  const key = P();
  const options = await post('/auth/webauthn/register-options', { name: 'Device' }, token['device']);
  assert.equal(options.status, 200, JSON.stringify(options.json));
  assert.equal((await signOut(token['device']!)).status, 200);
  const reg = await post('/auth/webauthn/register', { response: attest(key, String(options.json['challenge']), primary.base, (options.json['rp'] as { id: string }).id) });
  assert.equal(reg.status, 401, JSON.stringify(reg.json));
  assert.match(String(reg.json['error']), /signed out everywhere/);
  assert.deepEqual(record(s9.device.userId)!.webAuthnCredentials.map(c => c.id), [s9.device.keys[0]!.id]);
  assert.equal((await signIn(key, 1)).status, 401);
});

test('S10: unconfirmed writes are settled in the background when their credential never comes back; at most UNCONFIRMED_WRITES_MAX are held, at most half of them for first sign-ins, and a bearer\'s add that finds them full is told to add it again', async () => {
  const derivedOf = (w: AnyWallet) => deriveUserIdFromWallet(w.address.toLowerCase());
  const bg = await startIdentity(await freePort(), { UNCONFIRMED_SETTLE_MS: '300', UNCONFIRMED_WRITES_MAX: '4' });
  const unconfirmedWrites = async () => ((await (await fetch(`${bg.base}/health`)).json()) as { unconfirmedWrites: number }).unconfirmedWrites;
  const ws = [W(), W(), W()];
  const adds = s10.map(() => W());
  const ids = [...ws.map(derivedOf), ...s10.map(a => a.userId)];
  /** The pod applies the next write of `id`, answers 500, and then cannot be read: nothing settles it. */
  const unsettled = (id: string) => {
    failPuts(id, 'apply-then-500');
    const put = hold('PUT', id, 1, () => { failingGets.set(id, 1_000); });
    void put.arrived.then(() => put.release());
  };
  try {
    const tokens = await Promise.all(s10.map(a => tokenFor(a.keys[0]!, 1, a.userId, bg)));
    // First sign-ins of throwaway wallets, which any request can make: each is recorded until they
    // hold half of the records (two of four), and the third finds that half full.
    for (const w of ws) {
      unsettled(derivedOf(w));
      const r = await siwe(w, {}, bg);
      assert.equal(r.status, 503, `${JSON.stringify(r.json)}${out(bg)}`);
      assert.match(String(r.json['detail']), /may or may not/);
    }
    assert.equal(await unconfirmedWrites(), 2, 'the third was not recorded');
    assert.match(bg.output(), new RegExp(`identity_unconfirmed_writes_full max=2 scope=first-sign-ins userId=${derivedOf(ws[2]!)}`));
    // Bearer adds that nothing could settle still have the other half: two are recorded, and the
    // third finds the records full. Its 503 says to add it again with the same bearer, not to sign in
    // with the wallet: such a sign-in reads none of the accounts the indexes do not name for it.
    const answers = [];
    for (const [i, a] of s10.entries()) {
      unsettled(a.userId);
      answers.push(await siwe(adds[i]!, { bearer: tokens[i] }, bg));
    }
    for (const r of answers) assert.equal(r.status, 503, `${JSON.stringify(r.json)}${out(bg)}`);
    for (const r of answers.slice(0, 2)) assert.match(String(r.json['detail']), /Try signing in with this wallet/);
    assert.match(String(answers[2]!.json['detail']), /Add it again with the same bearer token/);
    assert.doesNotMatch(String(answers[2]!.json['detail']), /Try signing in/);
    assert.equal(await unconfirmedWrites(), 4);
    assert.match(bg.output(), new RegExp(`identity_unconfirmed_writes_full max=4 scope=all userId=${s10[2]!.userId}`));
    // While the pods cannot be read, the sweep keeps all four, and says so.
    await sleep(800);
    assert.equal(await unconfirmedWrites(), 4);
    assert.match(bg.output(), /WARN identity_unconfirmed_writes_unsettled left=4/);
    // Readable again. The third owner does as its 503 said: the same add, with the same bearer, finds
    // the wallet on its record (the pod took the first one) and signs in there, opening nothing else.
    for (const id of ids) failingGets.delete(id);
    await signsInTo(siwe(adds[2]!, { bearer: tokens[2] }, bg), s10[2]!.userId, bg);
    assert.deepEqual(record(s10[2]!.userId)!.walletAddresses, [adds[2]!.address.toLowerCase()]);
    // Nobody signs in with the other wallets: the sweep settles their records anyway. They used to
    // stay recorded for the life of the process.
    const deadline = Date.now() + 5_000;
    while (await unconfirmedWrites() > 0 && Date.now() < deadline) await sleep(100);
    assert.equal(await unconfirmedWrites(), 0, `the records were never settled${out(bg)}`);
    for (const w of ws) await signsInTo(siwe(w, {}, bg), derivedOf(w), bg);
    for (const [i, w] of adds.entries()) await signsInTo(siwe(w, {}, bg), s10[i]!.userId, bg);
    for (const w of adds) assert.equal(docs.has(derivedOf(w)), false, 'no account is opened for the wallet');
  } finally {
    for (const id of ids) failingGets.delete(id);
    await bg.stop();
  }
});

test('S11: did:key first sign-ins (/auth/did) take only the first-sign-in half of the unconfirmed records too, so a bearer\'s add is still recorded after them', async () => {
  // /auth/did marks a first sign-in of the account derived from the did:key as one (its
  // recordUnconfirmed(..., firstSignIn)), as /auth/siwe does for a wallet (S10). Without the mark the
  // three below are all recorded, under the overall bound alone, and a flood of them fills every record.
  const bg = await startIdentity(await freePort(), { UNCONFIRMED_WRITES_MAX: '4' });
  const unconfirmedWrites = async () => ((await (await fetch(`${bg.base}/health`)).json()) as { unconfirmedWrites: number }).unconfirmedWrites;
  const ks = [didKey(), didKey(), didKey()];
  const added = didKey();
  const ids = [...ks.map(k => deriveUserIdFromDid(k.did)), s11.userId];
  /** The pod applies the next write of `id`, answers 500, and then cannot be read: nothing settles it. */
  const unsettled = (id: string) => {
    failPuts(id, 'apply-then-500');
    const put = hold('PUT', id, 1, () => { failingGets.set(id, 1_000); });
    void put.arrived.then(() => put.release());
  };
  try {
    const token = await tokenFor(s11.keys[0]!, 1, s11.userId, bg);
    for (const [i, k] of ks.entries()) {
      unsettled(ids[i]!);
      const r = await didSignIn(k, {}, bg);
      assert.equal(r.status, 503, `${JSON.stringify(r.json)}${out(bg)}`);
      assert.match(String(r.json['detail']), /may or may not/);
    }
    assert.equal(await unconfirmedWrites(), 2, 'the third first sign-in was not recorded');
    assert.match(bg.output(), new RegExp(`identity_unconfirmed_writes_full max=2 scope=first-sign-ins userId=${ids[2]}`));
    // The records are not full: a did:key added with a bearer, that nothing could settle, is recorded.
    unsettled(s11.userId);
    const add = await didSignIn(added, { bearer: token }, bg);
    assert.equal(add.status, 503, `${JSON.stringify(add.json)}${out(bg)}`);
    assert.match(String(add.json['detail']), /Try signing in with this DID/);
    assert.equal(await unconfirmedWrites(), 3);
    assert.doesNotMatch(bg.output(), /identity_unconfirmed_writes_full max=4/);
  } finally {
    for (const id of ids) failingGets.delete(id);
    await bg.stop();
  }
});

// ── D, E. Counters and epochs ───────────────────────────────────────────────────────────────
test('D2: a sign counter raised out of band is the one an assertion must beat', async () => {
  const key = d2.keys[0]!;
  await tokenFor(key, 1, d2.userId);
  outOfBand(d2.userId, d => { (d['webAuthnCredentials'] as Array<{ counter: number }>)[0]!.counter = 7; });
  assert.equal((await signIn(key, 6)).status, 401);
  assert.equal(credentialOf(d2.userId, key)!.counter, 7);
  await signsInTo(signIn(key, 8), d2.userId);
  assert.equal(credentialOf(d2.userId, key)!.counter, 8);
});

test('E3: a deletion\'s tombstone takes an epoch above the pod\'s and this server\'s', async () => {
  const key = e3.keys[0]!;
  let token = await tokenFor(key, 1, e3.userId);
  assert.equal((await signOut(token)).status, 200);
  token = await tokenFor(key, 2, e3.userId);
  assert.equal((await signOut(token)).status, 200);
  token = await tokenFor(key, 3, e3.userId);
  outOfBand(e3.userId, d => { d['sessionEpoch'] = 1; });
  const r = await post('/users/me/delete', {}, token);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out()}`);
  assert.equal(record(e3.userId)!.deletedAt !== undefined, true);
  assert.equal(record(e3.userId)!.sessionEpoch, 3);
});

// ── F. Play owners, the janitor ─────────────────────────────────────────────────────────────
test('F2: a Play owner\'s passkey sign-in and a wallet added meanwhile both land', async () => {
  const since = mark();
  const token = await tokenFor(play.key, 1, play.id);
  const w = W();
  await duringSignIn(play.id, play.key, 2, () => siwe(w, { bearer: token }));
  assert.equal(credentialOf(play.id, play.key)!.counter, 2);
  assert.deepEqual(record(play.id)!.walletAddresses, [w.address.toLowerCase()]);
  // Writes of a record the pod has cost one request each: no container write before them.
  assert.equal(containerPuts(play.id, since).length, 0);
});

test('F4, I5: a claimed u-try- account is kept: by the janitor if it was claimed after its decision, and when its tombstone fails', async () => {
  const janitor = await startIdentity(await freePort(), { JANITOR_INTERVAL_MS: '400', TRY_USER_TTL_MS: '1' });
  // The janitor decides on its copy (no credential) and writes the tombstone only on the record it
  // read: here a credential lands on the pod just as that write arrives. The first write of the new
  // id's record is /try's own; the second, the janitor's.
  const k = didKey();
  const existing = new Set(docs.keys());
  const fresh = (id: string) => id.startsWith('u-try-') && !id.startsWith('u-try-play-') && !existing.has(id);
  const held = hold('PUT', fresh, 2, id => outOfBand(id, d => { (d['didKeys'] as unknown[]).push(didEntry(k)); }));
  const tried = await post('/try', {}, undefined, janitor);
  assert.equal(tried.status, 200, JSON.stringify(tried.json));
  const tryId = String(tried.json['userId']);
  assert.ok(await within(held.arrived, 10_000), `the janitor never tried to delete ${tryId}${out(janitor)}`);
  held.release();
  await sleep(500);
  assert.deepEqual(record(tryId)?.didKeys.map(x => x.did), [k.did], `the claimed account was deleted${out(janitor)}`);
  assert.equal((await me(String(tried.json['token']), janitor)).status, 200);
  await janitor.stop();
  // A claimed u-try- account whose tombstone the pod refuses stays whole: 503, and it still signs in.
  const own = await post('/try', {});
  assert.equal(own.status, 200, JSON.stringify(own.json));
  const ownId = String(own.json['userId']);
  const key = P();
  assert.equal((await addDevice(key, String(own.json['token']))).status, 200, out());
  failPuts(ownId, '403');
  try {
    const r = await post('/users/me/delete', {}, String(own.json['token']));
    assert.equal(r.status, 503, JSON.stringify(r.json));
  } finally {
    putFaults.delete(ownId);
  }
  await signsInTo(signIn(key, 1), ownId);
});

// ── After this server's copy has aged (one wait for all of them) ───────────────────────────
test('A7, A8, B6, B9, G1, G2, H3, I2, J3: once the copy is 10 s old, every decision and write goes to the pod', async () => {
  const tokenT7 = await tokenFor(t7.keys[0]!, 1, t7.userId);
  assert.ok(tokenT7);
  const tokenY = await tokenFor(t9.y.keys[0]!, 1, t9.y.userId);
  const tokenG = await tokenFor(g.keys[0]!, 1, g.userId);
  const tokenR = await tokenFor(tR.keys[0]!, 1, tR.userId);
  const tokenH = await tokenFor(tH.keys[0]!, 1, tH.userId);
  const tokenB6 = await tokenFor(bothRemovals.keys[0]!, 1, bothRemovals.userId);
  await tokenFor(j3.keys[0]!, 1, j3.userId);
  outOfBand(j3.userId, d => { d['walletAddresses'] = []; d['didKeys'] = []; });
  const derivedDid = deriveUserIdFromDid(t8.key.did);
  outOfBand(t7.userId, d => { d['walletAddresses'] = []; });
  outOfBand(derivedDid, d => { d['didKeys'] = []; });
  outOfBand(t9.y.userId, d => { d['didKeys'] = []; });
  outOfBand(t9u.y.userId, d => { d['didKeys'] = []; });
  docs.delete(g.userId);
  await sleep(TTL_WAIT_MS);

  // A7: a wallet the pod dropped signs in to that account no more, and nothing writes it back.
  let since = mark();
  assert.equal((await siwe(t7.wallets![0]!, { existingOnly: true })).status, 401);
  const relay = await siwe(t7.wallets![0]!);
  assert.notEqual(relay.json['userId'], t7.userId);
  assert.equal(docPuts(t7.userId, since).length, 0);
  assert.deepEqual(record(t7.userId)!.walletAddresses, []);

  // J3: nor does a wallet or DID sign-in decide on a copy older than 10 s when the pod cannot be
  // read: it is 503, where the old copy would sign in a wallet and a DID the pod dropped.
  failingGets.set(j3.userId, 1000);
  try {
    assert.equal((await siwe(j3.wallets![0]!, { existingOnly: true })).status, 503);
    assert.equal((await siwe(j3.wallets![0]!)).status, 503);
    assert.equal((await didSignIn(j3.dids![0]!)).status, 503);
  } finally {
    failingGets.delete(j3.userId);
  }
  assert.equal((await siwe(j3.wallets![0]!, { existingOnly: true })).status, 401);

  // A8: a did:key the derived account dropped signs in to the owner's, writing nothing.
  since = mark();
  await signsInTo(didSignIn(t8.key), t8.owner.userId);
  assert.equal(docPuts(derivedDid, since).length + docPuts(t8.owner.userId, since).length, 0);
  assert.deepEqual(record(derivedDid)!.didKeys, []);

  // I2: a did:web the pod dropped, added again with the account's bearer, is added on the first
  // try (its stale holder drops out on reading, and the add goes on); without a bearer it signs
  // in nowhere and nothing writes it back.
  await signsInTo(didSignIn(t9.key, { did: t9.did, bearer: tokenY }), t9.y.userId);
  assert.deepEqual(record(t9.y.userId)!.didKeys.map(x => x.did), [t9.did]);
  since = mark();
  const unbound = await didSignIn(t9u.key, { did: t9u.did });
  assert.equal(unbound.status, 401, JSON.stringify(unbound.json));
  assert.equal(docPuts(t9u.y.userId, since).length, 0);
  assert.deepEqual(record(t9u.y.userId)!.didKeys, []);

  // G1: an account whose document is gone: reads create nothing.
  since = mark();
  assert.equal((await verify(tokenG)).json['valid'], true);
  await sleep(200);
  await post('/challenges', { purpose: 'webauthn-authenticate', userId: g.userId });
  await me(tokenG);
  await post('/auth/webauthn/register-options', { name: 'x' }, tokenG);
  assert.equal(docPuts(g.userId, since).length + containerPuts(g.userId, since).length, 0);
  // G2: nor do writes: an add or a removal needs the document, and the 404 says it is missing (not
  // "User for token not found", which is an unknown token's answer).
  const missing = await siwe(W(), { bearer: tokenG });
  assert.equal(missing.status, 404, JSON.stringify(missing.json));
  assert.match(String(missing.json['error']), /sign-in record is missing from its pod/);
  assert.equal((await addDevice(P(), tokenG)).status, 404);
  assert.equal((await del(`/auth-methods/me/webauthn/${encodeURIComponent(g.keys[0]!.id)}`, tokenG)).status, 404);
  assert.equal(docPuts(g.userId, since).length + containerPuts(g.userId, since).length, 0);
  assert.equal(docs.has(g.userId), false);

  // H3: readers of a stale copy share one read of the pod; a passkey sign-in alongside adds its own.
  since = mark();
  const verifies = Array.from({ length: 20 }, () => verify(tokenH));
  const signingIn = signIn(tH.keys[0]!, 2);
  await Promise.all(verifies);
  await signsInTo(signingIn, tH.userId);
  assert.ok(docGets(tH.userId, since).length <= 2, `${docGets(tH.userId, since).length} reads`);

  // B6: removing an account's last two methods at once leaves one: each removal checks, under the
  // account's lock, the record the other one wrote.
  const [a, b] = await Promise.all([
    del(`/auth-methods/me/webauthn/${encodeURIComponent(bothRemovals.keys[0]!.id)}`, tokenB6),
    del(`/auth-methods/me/wallet/${bothRemovals.wallets![0]!.address.toLowerCase()}`, tokenB6),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const left = record(bothRemovals.userId)!;
  assert.equal(left.walletAddresses.length + left.webAuthnCredentials.length, 1);

  // B9: a wallet added while a refresh of the copy reads the pod is in the index once acknowledged.
  const held = hold('GET', tR.userId);
  void verify(tokenR);
  assert.ok(await within(held.arrived, 5_000), `no refresh read the pod${out()}`);
  const w = W();
  const adding = siwe(w, { bearer: tokenR });
  assert.equal(await within(adding, 300), false, 'acknowledged while a refresh held the account');
  held.release();
  await signsInTo(adding, tR.userId);
  // Whatever the refresh read before the add is never installed over it.
  await sleep(300);
  await signsInTo(siwe(w, { existingOnly: true }), tR.userId);
});

// ── H. What a sign-in costs ─────────────────────────────────────────────────────────────────
test('H1, H2, H4: a passkey sign-in reads its record once and writes only a changed counter, with no container write', async () => {
  let since = mark();
  await signsInTo(signIn(h1.key, 0), h1.id);
  await signsInTo(signIn(h1.key, 0), h1.id);
  assert.equal(docGets(h1.id, since).length, 2);
  assert.equal(docPuts(h1.id, since).length, 0);

  since = mark();
  await signsInTo(signIn(h2.key, 5), h2.id);
  assert.equal(docGets(h2.id, since).length, 1);
  assert.equal(docPuts(h2.id, since).length, 1);
  assert.equal(containerPuts(h2.id, since).length, 0);
  assert.equal(credentialOf(h2.id, h2.key)!.counter, 5);

  since = mark();
  await signsInTo(signIn(h4.key, 0), h4ids[0]!);
  assert.equal(h4ids.reduce((n, id) => n + docGets(id, since).length, 0), 1);
  assert.equal(h4ids.reduce((n, id) => n + docPuts(id, since).length, 0), 0);
});

// ── I. Deletion, bootstrap claims ───────────────────────────────────────────────────────────
test('I1: a wrong invite for a seeded id that was never claimed reads and writes nothing', async () => {
  const since = mark();
  const r = await siwe(W(), { extra: { bootstrapUserId: invites.never.userId, bootstrapInvite: 'wrong' } });
  assert.equal(r.status, 401, JSON.stringify(r.json));
  assert.equal(requests.slice(since).filter(q => q.userId === invites.never.userId).length, 0);
});

test('I4: deleting an account takes its lock once, for every kind of id, and answers promptly', async () => {
  const kinds: Array<[string, () => Promise<{ token: string; userId: string }>]> = [
    ['u-pk-', async () => ({ token: await tokenFor(del4.pk.keys[0]!, 1, del4.pk.userId), userId: del4.pk.userId })],
    ['u-eth-', async () => { const w = W(); const r = await siwe(w); return { token: String(r.json['token']), userId: String(r.json['userId']) }; }],
    ['u-did-', async () => { const r = await didSignIn(didKey()); return { token: String(r.json['token']), userId: String(r.json['userId']) }; }],
    ['seeded', async () => {
      const r = await didSignIn(didKey(), { extra: { bootstrapUserId: invites.del.userId, bootstrapInvite: invites.del.token } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      return { token: String(r.json['token']), userId: String(r.json['userId']) };
    }],
    // A random id too: its record used to be removed, which let a write still pending on its ETag re-create it.
    ['u-try-', async () => { const r = await post('/try', {}); return { token: String(r.json['token']), userId: String(r.json['userId']) }; }],
  ];
  for (const [kind, open] of kinds) {
    const { token, userId } = await open();
    const started = Date.now();
    const r = await post('/users/me/delete', {}, token);
    assert.equal(r.status, 200, `${kind}: ${JSON.stringify(r.json)}${out()}`);
    assert.ok(Date.now() - started < 2_000, `${kind}: took ${Date.now() - started} ms`);
    assert.ok(record(userId)!.deletedAt, `${kind}: tombstone`);
  }
  assert.equal(requests.some(r => r.target === 'doc' && r.method === 'DELETE'), false, 'no record was ever removed');
});

test('I6: a bootstrap passkey for a seeded account claimed meanwhile is refused, and leaves no account shell', async () => {
  const options = await post('/auth/webauthn/register-options', { name: 'Seeded', bootstrapUserId: invites.claimed.userId, bootstrapInvite: invites.claimed.token });
  assert.equal(options.status, 200, JSON.stringify(options.json));
  // Claimed by another route before this ceremony completes (the other instance, say).
  seed(invites.claimed.userId, { dids: [didKey()] });
  const rpId = (options.json['rp'] as { id: string }).id;
  const r = await post('/auth/webauthn/register', { response: attest(P(), String(options.json['challenge']), primary.base, rpId) });
  assert.equal(r.status, 401, JSON.stringify(r.json));
  assert.equal((await call(primary, 'GET', `/users/${invites.claimed.userId}/did.json`)).status, 404);
  assert.equal(record(invites.claimed.userId)!.webAuthnCredentials.length, 0);
});

test('I7: the tombstone a first sign-in leaves on a pod deleted before tombstones is a conditional write, never over a credential written meanwhile', async () => {
  // A passkey id whose pod holds a record without credentials: what a deletion before tombstones
  // left (pre-tombstone-deletion-routes.test.ts covers the other shapes). Registering it again is
  // refused as deleted, and the tombstone is written on the record as the pod holds it, If-Match.
  const k = P();
  seed(k.userId, { epoch: 4 });
  const etag = etagOf(k.userId);
  let since = mark();
  const r = await post('/auth/webauthn/register', await (async () => {
    const options = await post('/auth/webauthn/register-options', { name: 'Again' });
    return { response: attest(k, String(options.json['challenge']), primary.base, (options.json['rp'] as { id: string }).id) };
  })());
  assert.equal(r.status, 409, `${JSON.stringify(r.json)}${out()}`);
  assert.ok(record(k.userId)!.deletedAt, 'tombstone');
  assert.equal(record(k.userId)!.sessionEpoch, 5);
  assert.deepEqual(docPuts(k.userId, since).map(p => [p.ifMatch, p.status]), [[etag, 205]]);
  assert.match(primary.output(), new RegExp(`identity_deleted_before_tombstone userId=${k.userId} evidence=auth-methods.jsonld without credentials`));

  // Another writer (the other instance) puts a wallet on such a record while the tombstone is on
  // its way: the tombstone's If-Match (on the claim's own read) fails, the record is read again and
  // installed, and nothing is written over the wallet. The sign-in is still refused, and this server holds the record as the pod does,
  // so the wallet signs in to that account rather than opening the one derived from it.
  const k2 = P();
  const w = W();
  seed(k2.userId, { epoch: 2 });
  const read = etagOf(k2.userId);
  const put = hold('PUT', k2.userId, 1, id => outOfBand(id, d => { d['walletAddresses'] = [w.address.toLowerCase()]; }));
  since = mark();
  const pending = (async () => {
    const options = await post('/auth/webauthn/register-options', { name: 'Again' });
    return post('/auth/webauthn/register', { response: attest(k2, String(options.json['challenge']), primary.base, (options.json['rp'] as { id: string }).id) });
  })();
  await put.arrived;
  put.release();
  const refused = await pending;
  assert.equal(refused.status, 409, `${JSON.stringify(refused.json)}${out()}`);
  assert.equal(record(k2.userId)!.deletedAt, undefined, JSON.stringify(record(k2.userId)));
  assert.deepEqual(record(k2.userId)!.walletAddresses, [w.address.toLowerCase()]);
  assert.deepEqual(docPuts(k2.userId, since).map(p => p.status), [412], 'one tombstone write, refused; none after the re-read');
  assert.deepEqual(docPuts(k2.userId, since).map(p => p.ifMatch), [read], 'conditional on the claim\'s own read');
  assert.equal(docGets(k2.userId, since).length, 2, 'the claim\'s read (the tombstone is conditional on it), and the re-read after the 412');
  const signedIn = await siwe(w);
  assert.equal(signedIn.status, 200, `${JSON.stringify(signedIn.json)}${out()}`);
  assert.equal(signedIn.json['userId'], k2.userId);
  assert.equal(docs.has(deriveUserIdFromWallet(w.address.toLowerCase())), false);
});
