/** Personal observation window + cumulative profile, not an historical LRS.
 * A single encrypted native CAS resource replaces per-event immutable files. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { deriveEncryptionKeyPair, type IRI } from '@interego/core';
import { NativeCommitStore, createNativeByteArtifact, readNativeByteArtifact } from '@interego/pgsl';
import { validateStatement } from './xapi-validate.js';
import type { OwnSubjectXapiAuthority } from './own-subject-xapi-auth.js';
import type { SelfXapiReply } from './self-xapi.js';

type Json = Record<string, unknown>;
interface ActivityStatement extends Json {
  id: string; timestamp: string;
  actor: { objectType?: string; name?: string; account?: { homePage?: string; name?: string } };
  verb: { id: string }; object: { objectType?: string; id: string };
  context?: { registration?: string; extensions?: Record<string, unknown> };
  authority?: { objectType: string; account: { homePage: string; name: string } };
  stored?: string; version?: string;
}
interface StoredActivityStatement extends ActivityStatement {
  authority: { objectType: string; account: { homePage: string; name: string } };
  stored: string; version: string;
}
type Receipt = { id: string; digest: string; observedAt: number; stored: string; sequence: number };
type Count = { id: string; count: number };
interface State {
  schema: string; owner: string; pod: string; head: string; writtenAt: number; sequence: number;
  records: Array<{ id: string; statement: StoredActivityStatement }>;
  receipts: Receipt[]; expired: string[];
  profile: { total: number; byVerb: Count[]; byBody: Count[]; byController: Count[]; otherVerb: number; otherBody: number; otherController: number; saturated: boolean; firstAt: string | null; lastAt: string | null; detailsPruned: number };
  budget: Array<{ minute: number; bytes: number }>;
}
export const OWN_SUBJECT_ACTIVITY_LIMITS = Object.freeze({ retentionMs: 3600000, records: 512, receipts: 4096,
  expiredIds: 1024, jsonBytes: 2 * 1024 * 1024, gzipBytes: 384 * 1024, encryptedBytes: 1024 * 1024,
  writeBytesPerHour: 16 * 1024 * 1024, statementBytes: 16 * 1024 });
const L = OWN_SUBJECT_ACTIVITY_LIMITS, TYPE = 'application/vnd.interego.rolling-checkpoint+gzip';
const SCHEMA = 'foxxi.personal-activity-window/v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const plain = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : plain(v) ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const iso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const refused = (status: number, error: string, extra: Json = {}): SelfXapiReply => ({ status, body: { ok: false, error, ...extra } });

export function createOwnSubjectActivityStore(authority: OwnSubjectXapiAuthority, options: {
  privateKey: string; fetch: typeof fetch; readOnly: boolean; now?: () => number; selfBaseUrl?: string;
}) {
  if (!/^(?:0x)?[a-f0-9]{64}$/i.test(options.privateKey)) throw Error('Stable native encryption key required');
  const pod = new URL(authority.podUrl);
  if (pod.protocol !== 'https:' || pod.username || pod.password || pod.search || pod.hash || !/^\/[A-Za-z0-9_-]+\/$/.test(pod.pathname)) throw Error('Canonical own pod required');
  const owner = authority.subjectDid, scope = { pod: pod.href, owner: owner as IRI,
    headUrl: new URL('foxxi/activity/own-subject/head', pod).href,
    artifactContainer: new URL('foxxi/activity/own-subject/artifacts/', pod).href };
  // The caller verifier has already bound this exact native users DID to its
  // configured identity authority. xAPI identifies an account by BOTH fields;
  // the DID name alone must not admit a different homePage or another IFI.
  const identityHost = /^did:web:([^:]+):users:[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.exec(owner)?.[1];
  if (!identityHost) throw Error('Canonical native subject DID required');
  const decodedHost = decodeURIComponent(identityHost), identityOrigin = new URL('https://' + decodedHost);
  if (identityOrigin.host !== decodedHost || identityOrigin.username || identityOrigin.password
    || identityOrigin.pathname !== '/' || identityOrigin.search || identityOrigin.hash) throw Error('Canonical native identity authority required');
  function ownsActor(actor: unknown): boolean {
    if (!plain(actor) || Object.keys(actor).some(k => !['objectType', 'name', 'account'].includes(k))
      || actor.objectType !== undefined && actor.objectType !== 'Agent'
      || actor.name !== undefined && typeof actor.name !== 'string' || !plain(actor.account)) return false;
    return Object.keys(actor.account).every(k => ['homePage', 'name'].includes(k))
      && actor.account.name === owner && actor.account.homePage === identityOrigin.origin;
  }
  const authorityOrigin = new URL(options.selfBaseUrl ?? 'https://foxxi-bridge.interego.xwisee.com');
  if (authorityOrigin.protocol !== 'https:' || authorityOrigin.username || authorityOrigin.password) throw Error('HTTPS activity authority required');
  const assignedAuthority = { objectType: 'Agent', account: { homePage: authorityOrigin.origin, name: 'foxxi-personal-activity-window' } };
  const enrich = (input: ActivityStatement, stored: string) => ({ ...copy(input), authority: copy(assignedAuthority), stored, version: '2.0.0' });
  const key = deriveEncryptionKeyPair(options.privateKey, 'urn:foxxi:personal-activity-window:' + owner);
  const clock = options.now ?? Date.now;
  const native = new NativeCommitStore({ scope, atomicCheckpoint: true, senderKeyPair: key,
    ownerPublicKey: authority.ownerPublicKey, recipientPublicKeys: [authority.ownerPublicKey, key.publicKey],
    maxArtifactBytes: L.encryptedBytes,
    fetch: async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.href !== scope.headUrl || !['GET', 'HEAD', 'OPTIONS', 'PUT'].includes(method)
        || options.readOnly && method === 'PUT') throw Error('Personal activity left its authorized fixed resource');
      return options.fetch(input, { ...init, method, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    } });
  const cursorKey = Buffer.from(key.secretKey, 'base64');
  function now() { const at = clock(); if (!integer(at)) throw Error('Invalid activity clock'); return at; }
  function empty(): State { return { schema: SCHEMA, owner, pod: scope.pod, head: scope.headUrl, writtenAt: 0, sequence: 0,
    records: [], receipts: [], expired: [], budget: [], profile: { total: 0, byVerb: [], byBody: [], byController: [],
      otherVerb: 0, otherBody: 0, otherController: 0, saturated: false, firstAt: null, lastAt: null, detailsPruned: 0 } }; }
  function artifact(state: State) {
    const bytes = Buffer.from(JSON.stringify(state));
    if (bytes.length > L.jsonBytes) throw Error('Activity JSON capacity exceeded');
    const gzip = gzipSync(bytes);
    if (gzip.length > L.gzipBytes) throw Error('Activity compressed capacity exceeded');
    return createNativeByteArtifact({ owner: scope.owner, contentType: TYPE, bytes: gzip });
  }
  function decode(value: Awaited<ReturnType<typeof native.readAtomicCheckpoint>>): State {
    if (!value.artifact) return empty();
    const envelope = readNativeByteArtifact(value.artifact);
    if (envelope.owner !== owner || envelope.contentType !== TYPE || envelope.bytes.length > L.gzipBytes) throw Error('Activity native envelope changed');
    const state = JSON.parse(gunzipSync(envelope.bytes, { maxOutputLength: L.jsonBytes }).toString('utf8')) as State;
    if (!plain(state) || state.schema !== SCHEMA || state.owner !== owner || state.pod !== scope.pod || state.head !== scope.headUrl
      || !integer(state.writtenAt) || !integer(state.sequence) || !Array.isArray(state.records) || state.records.length > L.records
      || !Array.isArray(state.receipts) || state.receipts.length > L.receipts || !Array.isArray(state.expired) || state.expired.length > L.expiredIds
      || new Set(state.receipts.map(r => r.id)).size !== state.receipts.length || new Set(state.records.map(r => r.id)).size !== state.records.length
      || state.expired.some(id => typeof id !== 'string' || !UUID.test(id)) || !Array.isArray(state.budget) || state.budget.length > 61) throw Error('Activity checkpoint corrupt');
    let sequence = -1, minute = -1, charged = 0;
    for (const r of state.receipts) {
      if (!plain(r) || !UUID.test(r.id) || !/^[a-f0-9]{64}$/.test(r.digest) || !integer(r.observedAt) || !iso(r.stored)
        || Date.parse(r.stored) > state.writtenAt || r.observedAt > Date.parse(r.stored) + 5000
        || !integer(r.sequence) || r.sequence <= sequence || r.sequence > state.sequence) throw Error('Activity receipt corrupt');
      sequence = r.sequence;
    }
    for (const record of state.records) {
      const receipt = state.receipts.find(r => r.id === record.id), s = record.statement;
      if (!receipt || !plain(s) || s.id !== record.id || !ownsActor(s.actor) || s.stored !== receipt.stored
        || s.authority?.objectType !== 'Agent' || s.authority?.account?.name !== assignedAuthority.account.name
        || typeof s.authority.account.homePage !== 'string' || !/^https:\/\/[^\s]+$/.test(s.authority.account.homePage)
        || s.version !== '2.0.0') throw Error('Activity statement binding corrupt');
      const { authority: _a, stored: _s, version: _v, ...body } = s;
      if (hash(body) !== receipt.digest || Date.parse(body.timestamp) !== receipt.observedAt) throw Error('Activity content digest corrupt');
    }
    for (const bucket of state.budget) {
      if (!integer(bucket.minute) || bucket.minute <= minute || bucket.minute > Math.floor(state.writtenAt / 60000)
        || !integer(bucket.bytes) || bucket.bytes < 1) throw Error('Activity write budget corrupt');
      minute = bucket.minute; charged += bucket.bytes;
    }
    const p = state.profile;
    if (charged > L.writeBytesPerHour || !plain(p) || !integer(p.total) || p.total !== state.sequence || !integer(p.detailsPruned)
      || p.detailsPruned + state.records.length !== p.total
      || typeof p.saturated !== 'boolean' || p.firstAt !== null && !iso(p.firstAt) || p.lastAt !== null && !iso(p.lastAt)) throw Error('Activity profile corrupt');
    for (const [rows, limit] of [[p.byVerb, 64], [p.byBody, 17], [p.byController, 16]] as const) {
      if (!Array.isArray(rows) || rows.length > limit || new Set(rows.map(row => row.id)).size !== rows.length
        || rows.some(row => !plain(row) || typeof row.id !== 'string' || row.id.length > 1024 || !integer(row.count))) throw Error('Activity aggregate corrupt');
    }
    if (![p.otherVerb, p.otherBody, p.otherController].every(integer)) throw Error('Activity overflow aggregate corrupt');
    for (const kind of ['Verb', 'Body', 'Controller'] as const) {
      const rows = p['by' + kind as 'byVerb' | 'byBody' | 'byController'];
      if (rows.reduce((sum, row) => sum + row.count, p['other' + kind as 'otherVerb' | 'otherBody' | 'otherController']) !== p.total) throw Error('Activity aggregate totals changed');
    }
    return state;
  }
  const increment = (p: State['profile'], value: number) => { if (value === Number.MAX_SAFE_INTEGER) p.saturated = true; return Math.min(Number.MAX_SAFE_INTEGER, value + 1); };
  function count(p: State['profile'], kind: 'Verb' | 'Body' | 'Controller', id: unknown, max: number) {
    const rows = p['by' + kind as 'byVerb' | 'byBody' | 'byController'];
    const found = typeof id === 'string' && id.length <= 1024 ? rows.find(row => row.id === id) : null;
    if (found) found.count = increment(p, found.count);
    else if (typeof id === 'string' && id.length <= 1024 && rows.length < max) rows.push({ id, count: 1 });
    else { const field = 'other' + kind as 'otherVerb' | 'otherBody' | 'otherController'; p[field] = increment(p, p[field]); }
  }
  function prune(state: State, at: number) {
    const removed = state.receipts.filter(r => r.observedAt <= at - L.retentionMs);
    state.receipts = state.receipts.filter(r => r.observedAt > at - L.retentionMs);
    const keep = new Set(state.receipts.map(r => r.id)), before = state.records.length;
    state.records = state.records.filter(r => keep.has(r.id));
    state.profile.detailsPruned += before - state.records.length;
    state.expired = [...new Set([...state.expired, ...removed.map(r => r.id)])].slice(-L.expiredIds);
    // A whole minute is retained until its end is outside the rolling hour.
    state.budget = state.budget.filter(b => (b.minute + 1) * 60000 > at - L.retentionMs);
  }
  function coverage(state: State, at: number) {
    const records = state.records.filter(r => Date.parse(r.statement.timestamp) > at - L.retentionMs);
    return { model: 'bounded-personal-observation-profile', completeHistory: false, retentionMs: L.retentionMs,
      maxDetailedStatements: L.records, maxReceiptIds: L.receipts, from: new Date(at - L.retentionMs).toISOString(),
      retainedFrom: records.length ? new Date(Math.min(...records.map(r => Date.parse(r.statement.timestamp)))).toISOString() : null, through: state.profile.lastAt,
      retainedCount: records.length, prunedCount: state.profile.detailsPruned + state.records.length - records.length,
      observationAuthority: 'owner-browser-observation', competencyStatus: 'not-assessed' };
  }
  function invalid(input: unknown, at: number): SelfXapiReply | null {
    if (!Array.isArray(input) || !input.length || input.length > 20 || Buffer.byteLength(JSON.stringify(input)) > 131072) return refused(400, 'One to twenty bounded statements required');
    const ids = new Set<string>();
    for (const value of input) {
      if (!plain(value) || validateStatement(value).length) return refused(400, 'A valid xAPI observation is required');
      const s = value as ActivityStatement;
      if (!plain(s) || validateStatement(s).length || typeof s.id !== 'string' || !UUID.test(s.id) || ids.has(s.id)
        || !ownsActor(s.actor) || !iso(s.timestamp)
        || s.authority !== undefined || s.stored !== undefined || s.version !== undefined || s.attachments !== undefined
        || s.object?.objectType && s.object.objectType !== 'Activity') return refused(400, 'Actual self-attributed Activity statements with stable UUIDs and timestamps are required');
      if (Date.parse(s.timestamp) <= at - L.retentionMs) return refused(410, 'Observation is outside the retained hour; an old delivery is not recounted');
      if (Date.parse(s.timestamp) > at + 5000) return refused(400, 'Observation timestamp is in the future');
      if (Buffer.byteLength(JSON.stringify(s)) > L.statementBytes) return refused(413, 'Observation exceeds 16 KiB');
      ids.add(s.id);
    }
    return null;
  }
  function reply(state: State, list: ActivityStatement[], at: number): SelfXapiReply {
    return { status: 200, body: { ok: true, subjectDid: owner, visibility: 'private', purpose: 'personal-performance',
      durable: true, lrsAccepted: true, statementIds: list.map(s => s.id), receipts: list.map(s => ({ statementId: s.id, persisted: true,
        detailRetained: state.records.some(row => row.id === s.id) })), coverage: coverage(state, at), profile: copy(state.profile) } };
  }
  function cursor(value: Json): string {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return body + '.' + createHmac('sha256', cursorKey).update(scope.headUrl + '\n' + body).digest('base64url');
  }
  return Object.freeze({
    async write(input: unknown): Promise<SelfXapiReply> {
      if (options.readOnly) return refused(403, 'Read-only personal activity scope');
      let at = now(); const error = invalid(input, at); if (error) return error;
      const list = copy(input as ActivityStatement[]);
      for (let attempt = 0; attempt < 5; attempt++) {
        const selected = await native.readAtomicCheckpoint(), state = decode(selected); at = now();
        const expired = invalid(list, at); if (expired) return expired;
        if (at < state.writtenAt) return refused(503, 'Native activity clock regressed');
        prune(state, at);
        const fresh: ActivityStatement[] = [];
        for (const s of list) {
          const prior = state.receipts.find(r => r.id === s.id);
          if (prior && prior.digest !== hash(s)) return refused(409, 'Statement UUID already has different immutable content');
          if (!prior && state.expired.includes(s.id)) return refused(410, 'Statement UUID was previously retained and has expired');
          if (!prior) fresh.push(s);
        }
        if (!fresh.length) return reply(state, list, at); // Exact retry is a read, including after process restart.
        if (state.receipts.length + fresh.length > L.receipts) return refused(429, 'Activity receipt rate reached; slots resume as this hour expires', { retryAfterSeconds: 60 });
        for (const s of fresh) {
          const stored = new Date(at).toISOString(); state.sequence++; state.profile.total++;
          state.receipts.push({ id: s.id, digest: hash(s), observedAt: Date.parse(s.timestamp), stored, sequence: state.sequence });
          state.records.push({ id: s.id, statement: enrich(s, stored) });
          const context = s.context?.extensions?.['urn:interego:gaming:activity:context'];
          const ext = plain(context) ? context : null;
          count(state.profile, 'Verb', s.verb.id, 64); count(state.profile, 'Body', ext?.bodyId, 17);
          count(state.profile, 'Controller', ext?.controllerId || ext?.controllerKind, 16);
          if (state.profile.firstAt === null || s.timestamp < state.profile.firstAt) state.profile.firstAt = s.timestamp;
          if (state.profile.lastAt === null || s.timestamp > state.profile.lastAt) state.profile.lastAt = s.timestamp;
        }
        if (!Number.isSafeInteger(state.sequence)) return refused(413, 'Cumulative activity count capacity reached');
        while (state.records.length > L.records) { state.records.shift(); state.profile.detailsPruned++; }
        state.writtenAt = at;
        // Drop recent detail, never unexpired UUID receipts or aggregate facts,
        // until the fixed resource fits every plaintext/compressed/encrypted cap.
        let encoded: ReturnType<typeof artifact>;
        for (;;) {
          try { encoded = artifact(state); if (native.atomicCheckpointSize(encoded) > L.encryptedBytes) throw Error('encrypted capacity'); break; }
          catch { if (!state.records.length) return refused(413, 'Bounded private activity profile capacity reached'); state.records.shift(); state.profile.detailsPruned++; }
        }
        const priorBudget = copy(state.budget), minute = Math.floor(at / 60000); let reservation = 4096;
        for (;;) {
          state.budget = copy(priorBudget); let bucket = state.budget.find(b => b.minute === minute);
          if (!bucket) state.budget.push(bucket = { minute, bytes: 0 }); bucket.bytes += reservation;
          if (state.budget.reduce((sum, b) => sum + b.bytes, 0) > L.writeBytesPerHour) return refused(429, 'Private activity hourly write budget reached; confirmed profile is preserved', { retryAfterSeconds: 60 });
          let actual: number;
          try { encoded = artifact(state); actual = native.atomicCheckpointSize(encoded); }
          catch { if (!state.records.length) return refused(413, 'Bounded private activity profile capacity reached'); state.records.shift(); state.profile.detailsPruned++; continue; }
          if (actual <= reservation) break;
          reservation = Math.ceil(actual / 4096) * 4096;
          if (reservation > L.encryptedBytes) return refused(413, 'Private activity encrypted capacity reached');
        }
        try {
          const committed = await native.commitAtomicCheckpoint(selected.revision, encoded!, { maxEncryptedBytes: reservation });
          const confirmed = decode(committed);
          if (list.some(s => confirmed.receipts.find(r => r.id === s.id)?.digest !== hash(s))) throw Error('Activity receipt readback failed');
          return reply(confirmed, list, at);
        } catch (cause: unknown) {
          if (plain(cause) && cause.status === 412 || cause instanceof Error && cause.name === 'NativeCommitConflictError') continue;
          // A lost acknowledgement may follow a real commit. Do not issue a
          // replacement write here; the caller reconciles these exact IDs.
          return refused(502, 'Private activity write outcome is unconfirmed; reconcile the same IDs before retrying', { subjectDid: owner, durable: false, statementIds: list.map(s => s.id) });
        }
      }
      return refused(409, 'Concurrent private activity update; retry the exact IDs');
    },
    async read(input: unknown = {}): Promise<SelfXapiReply> {
      if (!plain(input) || Object.keys(input).some(k => !['statementId', 'verb', 'activity', 'registration', 'since', 'until', 'ascending', 'limit', 'cursor'].includes(k))) return refused(400, 'Unsupported personal activity query');
      const selected = await native.readAtomicCheckpoint(), state = decode(selected), at = now(), metadata = { subjectDid: owner, coverage: coverage(state, at) };
      if (input.statementId !== undefined) {
        if (typeof input.statementId !== 'string' || !UUID.test(input.statementId) || Object.keys(input).length !== 1) return refused(400, 'A statement UUID cannot be combined with filters');
        const record = state.records.find(row => row.id === input.statementId);
        if (record && Date.parse(record.statement.timestamp) > at - L.retentionMs) return { status: 200, body: { ok: true, durable: true, ...metadata, statement: copy(record.statement) } };
        const known = record || state.expired.includes(input.statementId) || state.receipts.some(r => r.id === input.statementId);
        return refused(known ? 410 : 404, known ? 'Observation detail expired or was pruned from the bounded window; aggregates remain' : 'Statement is not in the retained personal observation window', metadata);
      }
      let query = { ...input }; delete query.cursor; let offset = 0;
      if (input.cursor !== undefined) {
        try {
          if (typeof input.cursor !== 'string' || input.cursor.length > 8192) throw Error();
          const [body, signature, extra] = input.cursor.split('.'); if (!body || !signature || extra) throw Error();
          const expected = cursor(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))).split('.')[1]!;
          if (Buffer.byteLength(signature) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw Error();
          const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
          if (decoded.revision !== selected.revision || decoded.expiresAt <= at) return refused(409, 'Personal activity view changed; restart this bounded query', metadata);
          if (Object.keys(query).length && canonical(query) !== canonical(decoded.query) || !integer(decoded.offset)) throw Error();
          query = decoded.query; offset = decoded.offset;
        } catch { return refused(400, 'Invalid personal activity cursor'); }
      }
      const limit = query.limit === undefined ? 100 : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200 || query.ascending !== undefined
        && query.ascending !== true && query.ascending !== false && query.ascending !== 'true' && query.ascending !== 'false'
        || ['verb', 'activity', 'registration'].some(k => query[k] !== undefined && typeof query[k] !== 'string')
        || ['since', 'until'].some(k => query[k] !== undefined && !iso(query[k]))) return refused(400, 'Invalid personal activity filters');
      const since = typeof query.since === 'string' ? query.since : undefined, until = typeof query.until === 'string' ? query.until : undefined;
      const rows = state.records.filter(({ statement: s }) => Date.parse(s.timestamp) > at - L.retentionMs
        && (query.verb === undefined || s.verb.id === query.verb) && (query.activity === undefined || s.object.id === query.activity)
        && (query.registration === undefined || s.context?.registration === query.registration)
        && (since === undefined || s.stored > since) && (until === undefined || s.stored <= until));
      if (query.ascending !== true && query.ascending !== 'true') rows.reverse();
      const result = rows.slice(offset, offset + limit), more = offset + limit < rows.length
        ? cursor({ revision: selected.revision, query, offset: offset + limit,
          // Retention membership must not shrink under an unchanged-head cursor.
          expiresAt: Math.min(at + L.retentionMs, ...rows.map(r => Date.parse(r.statement.timestamp) + L.retentionMs)) }) : '';
      return { status: 200, body: { ok: true, durable: true, ...metadata, profile: copy(state.profile), statements: result.map(r => copy(r.statement)), more } };
    },
  });
}

export type OwnSubjectActivityState = State;
