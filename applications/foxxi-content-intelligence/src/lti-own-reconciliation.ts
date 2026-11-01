/** New, source-scoped recovery entries. This module never restores an LTI row,
 * writes xAPI/AGS, or changes the legacy/global gradebook head. */
import { createHash } from 'node:crypto';
import type { LegacySnapshotFailureWitness } from './pod-snapshot-publisher.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type OriginalStatement = Record<string, unknown>;
export type LegacyFailureWitness = LegacySnapshotFailureWitness;
export interface RecoveryPrincipal { subjectDid: string; learnerWebId: string; callerDid: string; podUrl: string; }
export interface SourceWindow { since: string; until: string; }
export interface RecoveryOutcome { completed: true; passed: boolean; scoreScaled: number; }
export interface RecoverySourceFacts {
  subjectDid: string; learnerWebId: string; courseUri: string; courseId: string; contextUri: string;
  outcome: RecoveryOutcome;
  sourceStatementIds: [string, string]; sourceStatementDigests: [string, string];
  originalCompletedAt: string; originalAssessmentAt: string; sourceStoredAt: [string, string]; checkedRange: SourceWindow;
  sourceKey: string; id: string;
}
export const SOURCE_ASSOCIATION = 'Bounded association of the same human, course, LMS context, source times and outcomes; original statements contain no attempt registration.';
export const ENGINE_TAG_COVERAGE = 'Both original statements pass the current engine HMAC check. gradedFields covers id, actor IFI, verb, activity, scaled score, success and timestamp; it does not cover completion, platform, context or the entire statement. Canonical body digests preserve those other fields without claiming engine-MAC coverage.';
export interface RecoveryEntry extends RecoverySourceFacts {
  schemaVersion: '1.0.0'; kind: 'reconciled-lms-entry'; entryDigest: string; previewDigest: string;
  reconciledAt: string; reconciledBy: string; legacyWitness: LegacyFailureWitness;
  sourceAssociation: typeof SOURCE_ASSOCIATION; engineTagCoverage: typeof ENGINE_TAG_COVERAGE;
  originalGradebookMatched: false; originalLmsPersistence: 'unverified';
  attestationKind: 'private-bridge-hmac'; attestation: string;
}
export interface RecoveryLedgerSnapshot { revision: string | null; entries: RecoveryEntry[]; }
export interface RecoveryLedger {
  /** Must freshly verify the private native head and its referenced entry bytes. */
  read(): Promise<RecoveryLedgerSnapshot>;
  append(expectedRevision: string | null, entry: RecoveryEntry): Promise<RecoveryLedgerSnapshot>;
}
export interface RecoveryRangeQuery extends SourceWindow { activity: string; ascending: true; limit: 20; }
export interface OwnLtiReconciliationPorts {
  principal: RecoveryPrincipal;
  /** Fixed backend configuration, never request-selected URLs or identity. */
  source: { actorHomePage: string; courseBaseUri: string; contextUri: string; platform: string; authorityHomePage?: string };
  readStatement(id: string): Promise<unknown>;
  readRange(query: RecoveryRangeQuery): Promise<{ statements: unknown[]; more: string | null }>;
  gradedHere(statement: OriginalStatement): boolean | Promise<boolean>;
  readLegacyWitness(): Promise<LegacyFailureWitness>;
  ledger: RecoveryLedger;
  /** Required stable service-secret MAC ports; no ephemeral/default-key fallback. */
  attest(claims: Record<string, unknown>): string | Promise<string>;
  verify(token: string): unknown | Promise<unknown>;
  now(): number;
}
export interface PreviewInput { originalStatementIds: [string, string]; }
export interface ApplyInput { planToken: string; intent: 'create-reconciled-lms-entry'; }
export interface RecoveryVerification {
  confirmed: boolean; nativeReadback: boolean; entryReadback: boolean; legacyWitnessUnchanged: boolean;
  originalGradebookMatched: false; originalLmsPersistence: 'unverified'; reviewNeeded: boolean;
}
export interface RecoveryReadResult {
  kind: 'own-lti-reconciliation'; found: boolean; entry?: RecoveryEntry;
  revision: string | null; verification: RecoveryVerification;
}
export interface RecoveryPreview {
  kind: 'own-lti-reconciliation-preview'; previewDigest: string; planToken: string; expiresAt: string;
  entryId: string; sourceKey: string; facts: RecoverySourceFacts;
  legacyWitness: LegacyFailureWitness; expectedRevision: string | null; existingEntry: boolean;
  originalGradebookMatched: false; originalLmsPersistence: 'unverified';
}
export interface RecoveryApplyResult extends RecoveryReadResult {
  state: 'recorded' | 'already-recorded' | 'unconfirmed'; applied: boolean | null;
  reason?: 'legacy-witness-changed' | 'readback-unavailable' | 'append-unconfirmed';
}
export type RecoveryErrorCode = 'invalid-input' | 'source-unavailable' | 'source-mismatch' | 'ambiguous-source'
  | 'engine-evidence-unverified' | 'legacy-witness-unavailable' | 'plan-invalid' | 'plan-expired'
  | 'plan-owner-mismatch' | 'plan-changed' | 'ledger-unavailable' | 'ledger-conflict'
  | 'ledger-capacity' | 'entry-invalid' | 'entry-conflict' | 'attestation-unavailable';
export class OwnLtiReconciliationError extends Error {
  constructor(readonly code: RecoveryErrorCode, readonly status: number) {
    super(code); this.name = 'OwnLtiReconciliationError';
  }
}

const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ADL = 'http://adlnet.gov/expapi/verbs/';
const PLAN_TTL_MS = 10 * 60_000;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_ENTRIES = 64;
const TRANSPORT_FIELDS = ['subject_did', 'purpose', 'subject_pod_url', 'timestamp', 'agent_id'];
function fail(code: RecoveryErrorCode, status = 400): never { throw new OwnLtiReconciliationError(code, status); }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const text = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const iso = (v: unknown): v is string => text(v, 40) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Bounded, finite JSON only. No getters, exotic prototypes or silent undefined. */
export function canonicalRecoveryJson(value: unknown): string {
  let nodes = 0;
  const walk = (v: unknown, depth: number): string => {
    if (++nodes > 20_000 || depth > 24) return fail('invalid-input');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (Array.isArray(v)) {
      if (v.length > 4096 || Object.keys(v).length !== v.length) return fail('invalid-input');
      const items: string[] = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !('value' in d)) return fail('invalid-input');
        items.push(walk(d.value, depth + 1));
      }
      return '[' + items.join(',') + ']';
    }
    if (object(v)) {
      const keys = Object.keys(v).sort(); if (keys.length > 1024) return fail('invalid-input');
      return '{' + keys.map(key => {
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d || !('value' in d) || ['__proto__', 'constructor', 'prototype'].includes(key)) return fail('invalid-input');
        return JSON.stringify(key) + ':' + walk(d.value, depth + 1);
      }).join(',') + '}';
    }
    return fail('invalid-input');
  };
  const encoded = walk(value, 0);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) return fail('invalid-input');
  return encoded;
}
export const recoveryDigest = (value: unknown): string => createHash('sha256').update(canonicalRecoveryJson(value)).digest('hex');

interface PlanClaims {
  type: 'own-lti-reconciliation-plan/1'; principal: RecoveryPrincipal; issuedAt: string; expiresAt: string;
  facts: RecoverySourceFacts; legacyWitness: LegacyFailureWitness; expectedRevision: string | null; previewDigest: string;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('invalid-input');
}
function transport(value: Record<string, unknown>, principal: RecoveryPrincipal): void {
  if (value.subject_did !== undefined && value.subject_did !== principal.subjectDid) fail('plan-owner-mismatch', 403);
  if (value.subject_pod_url !== undefined && value.subject_pod_url !== principal.podUrl) fail('plan-owner-mismatch', 403);
  if (value.agent_id !== undefined && value.agent_id !== principal.callerDid) fail('plan-owner-mismatch', 403);
  for (const key of TRANSPORT_FIELDS) if (value[key] !== undefined && !text(value[key], 2048)) fail('invalid-input');
}
function validPrincipal(p: RecoveryPrincipal): boolean {
  return text(p.subjectDid) && /^did:web:[^\s/?#]+:users:[A-Za-z0-9._-]+$/.test(p.subjectDid)
    && text(p.learnerWebId) && /^https:\/\//.test(p.learnerWebId) && text(p.podUrl) && /^https:\/\//.test(p.podUrl)
    && text(p.callerDid) && p.callerDid.startsWith('did:');
}
function witness(value: unknown): LegacyFailureWitness {
  try {
    canonicalRecoveryJson(value);
    if (!object(value) || value.schemaVersion !== '1.0.0' || value.reason !== 'legacy-head-mismatch'
      || !['descriptorSha256', 'graphSha256', 'payloadSha256', 'witnessDigest'].every(key => typeof value[key] === 'string' && HEX.test(value[key] as string))
      || !['headRevision', 'graphRevision'].every(key => text(value[key], 512) && /^"[^"\r\n]+"$/.test(value[key] as string))
      || !iso(value.observedAt) || !text(value.expectedGraphIri) || !text(value.actualGraphIri)
      || value.expectedGraphIri === value.actualGraphIri) fail('legacy-witness-unavailable', 503);
    return copy(value as unknown as LegacyFailureWitness);
  } catch { return fail('legacy-witness-unavailable', 503); }
}
function sourceIdentity(facts: Pick<RecoverySourceFacts, 'subjectDid' | 'learnerWebId' | 'courseUri' | 'contextUri' | 'sourceStatementIds' | 'sourceStatementDigests'>): string {
  return recoveryDigest({ domain: 'own-lti-original-source/1', subjectDid: facts.subjectDid, learnerWebId: facts.learnerWebId,
    courseUri: facts.courseUri, contextUri: facts.contextUri, sourceStatementIds: facts.sourceStatementIds, sourceStatementDigests: facts.sourceStatementDigests });
}
function entryId(sourceKey: string): string { return recoveryDigest({ domain: 'own-lti-reconciliation-entry/1', sourceKey }); }
const FACT_KEYS = ['subjectDid', 'learnerWebId', 'courseUri', 'courseId', 'contextUri', 'outcome', 'sourceStatementIds',
  'sourceStatementDigests', 'originalCompletedAt', 'originalAssessmentAt', 'sourceStoredAt', 'checkedRange', 'sourceKey', 'id'];
const ENTRY_KEYS = [...FACT_KEYS, 'schemaVersion', 'kind', 'entryDigest', 'previewDigest', 'reconciledAt', 'reconciledBy', 'legacyWitness',
  'sourceAssociation', 'engineTagCoverage', 'originalGradebookMatched', 'originalLmsPersistence', 'attestationKind', 'attestation'];
function factsFrom(entry: RecoverySourceFacts): RecoverySourceFacts {
  return Object.fromEntries(FACT_KEYS.map(key => [key, (entry as unknown as Record<string, unknown>)[key]])) as unknown as RecoverySourceFacts;
}
function hasSourceCollision(entries: RecoveryEntry[], facts: RecoverySourceFacts): boolean {
  return entries.some(entry => entry.id !== facts.id
    && entry.sourceStatementIds.some(id => facts.sourceStatementIds.includes(id)));
}
function validFacts(value: unknown): value is RecoverySourceFacts {
  if (!object(value)) return false;
  try {
    keys(value, FACT_KEYS); canonicalRecoveryJson(value);
    const f = value as unknown as RecoverySourceFacts;
    return text(f.subjectDid) && text(f.learnerWebId) && text(f.courseUri) && text(f.courseId, 200) && text(f.contextUri)
      && object(f.outcome) && Object.keys(f.outcome).length === 3 && f.outcome.completed === true && typeof f.outcome.passed === 'boolean'
      && typeof f.outcome.scoreScaled === 'number' && Number.isFinite(f.outcome.scoreScaled) && f.outcome.scoreScaled >= 0 && f.outcome.scoreScaled <= 1
      && Array.isArray(f.sourceStatementIds) && f.sourceStatementIds.length === 2 && f.sourceStatementIds.every(id => typeof id === 'string' && UUID.test(id) && id === id.toLowerCase())
      && f.sourceStatementIds[0] !== f.sourceStatementIds[1]
      && Array.isArray(f.sourceStatementDigests) && f.sourceStatementDigests.length === 2 && f.sourceStatementDigests.every(d => typeof d === 'string' && HEX.test(d))
      && iso(f.originalCompletedAt) && iso(f.originalAssessmentAt) && object(f.checkedRange) && Object.keys(f.checkedRange).length === 2
      && Array.isArray(f.sourceStoredAt) && f.sourceStoredAt.length === 2 && f.sourceStoredAt.every(iso)
      && iso(f.checkedRange.since) && iso(f.checkedRange.until)
      && f.checkedRange.since === new Date(Math.min(Date.parse(f.sourceStoredAt[0]), Date.parse(f.sourceStoredAt[1])) - 2000).toISOString()
      && f.checkedRange.until === new Date(Math.max(Date.parse(f.sourceStoredAt[0]), Date.parse(f.sourceStoredAt[1])) + 2000).toISOString()
      && Math.abs(Date.parse(f.originalCompletedAt) - Date.parse(f.originalAssessmentAt)) <= 5000
      && HEX.test(f.sourceKey) && f.sourceKey === sourceIdentity(f) && HEX.test(f.id) && f.id === entryId(f.sourceKey);
  } catch { return false; }
}
function unsignedEntry(entry: RecoveryEntry): Record<string, unknown> {
  const { entryDigest: _digest, attestation: _attestation, ...unsigned } = entry;
  return unsigned;
}
function entryClaims(entry: RecoveryEntry): Record<string, unknown> {
  return { type: 'own-lti-reconciliation-entry/1', id: entry.id, entryDigest: entry.entryDigest,
    subjectDid: entry.subjectDid, learnerWebId: entry.learnerWebId };
}

/** Private integrity only: a bridge MAC is not public signature verification.
 * Safe for the store callback: it performs no ledger reads or source fetches. */
export async function validateRecoveryEntry(value: unknown, ports: Pick<OwnLtiReconciliationPorts, 'principal' | 'verify'>): Promise<boolean> {
  try {
    if (!object(value)) return false;
    keys(value, ENTRY_KEYS); canonicalRecoveryJson(value);
    const e = value as unknown as RecoveryEntry;
    if (!validFacts(factsFrom(e)) || e.subjectDid !== ports.principal.subjectDid || e.learnerWebId !== ports.principal.learnerWebId
      || e.schemaVersion !== '1.0.0' || e.kind !== 'reconciled-lms-entry' || !iso(e.reconciledAt) || !text(e.reconciledBy)
      || e.sourceAssociation !== SOURCE_ASSOCIATION || e.engineTagCoverage !== ENGINE_TAG_COVERAGE
      || e.originalGradebookMatched !== false || e.originalLmsPersistence !== 'unverified' || e.attestationKind !== 'private-bridge-hmac'
      || !HEX.test(e.previewDigest) || !HEX.test(e.entryDigest) || e.entryDigest !== recoveryDigest(unsignedEntry(e)) || !text(e.attestation, 65536)) return false;
    witness(e.legacyWitness);
    const verified = await ports.verify(e.attestation);
    return canonicalRecoveryJson(verified) === canonicalRecoveryJson(entryClaims(e));
  } catch { return false; }
}

function verification(confirmed: boolean, unchanged = confirmed, readback = confirmed): RecoveryVerification {
  return { confirmed, nativeReadback: readback, entryReadback: readback, legacyWitnessUnchanged: unchanged,
    originalGradebookMatched: false, originalLmsPersistence: 'unverified', reviewNeeded: !confirmed };
}

export function createOwnLtiReconciliation(ports: OwnLtiReconciliationPorts) {
  const principal = copy(ports.principal), source = copy(ports.source);
  if (!validPrincipal(principal) || !text(source.actorHomePage) || !text(source.courseBaseUri) || !source.courseBaseUri.endsWith('/')
    || !text(source.contextUri) || !text(source.platform) || typeof ports.attest !== 'function' || typeof ports.verify !== 'function') fail('invalid-input');
  let authorityHomePage: string;
  try { authorityHomePage = source.authorityHomePage ?? new URL(source.courseBaseUri).origin; } catch { return fail('invalid-input'); }
  const clock = (): number => { const n = ports.now(); if (!Number.isSafeInteger(n) || n < 0) return fail('source-unavailable', 503); return n; };
  const loadWitness = async (): Promise<LegacyFailureWitness> => { try { return witness(await ports.readLegacyWitness()); } catch { return fail('legacy-witness-unavailable', 503); } };
  const ledger = async (): Promise<RecoveryLedgerSnapshot> => {
    try {
      const s = await ports.ledger.read();
      if (!object(s) || (s.revision !== null && !text(s.revision, 512)) || !Array.isArray(s.entries) || s.entries.length > MAX_ENTRIES) fail('ledger-unavailable', 503);
      const ids = new Set<string>(), sourceIds = new Set<string>();
      for (const e of s.entries) {
        if (!await validateRecoveryEntry(e, { principal, verify: ports.verify }) || ids.has(e.id)
          || e.sourceStatementIds.some(id => sourceIds.has(id))) fail('entry-invalid', 503);
        ids.add(e.id);
        for (const id of e.sourceStatementIds) sourceIds.add(id);
      }
      if (s.entries.length && s.revision === null) fail('ledger-unavailable', 503);
      return copy(s);
    } catch (error) { if (error instanceof OwnLtiReconciliationError) throw error; return fail('ledger-unavailable', 503); }
  };
  const statement = (raw: unknown, now: number): OriginalStatement => {
    try { canonicalRecoveryJson(raw); } catch { return fail('source-mismatch', 409); }
    if (!object(raw) || typeof raw.id !== 'string' || !UUID.test(raw.id) || raw.id !== raw.id.toLowerCase()
      || !iso(raw.timestamp) || Date.parse(raw.timestamp) > now + 5000 || !iso(raw.stored) || Date.parse(raw.stored) > now + 5000
      || raw.version !== '2.0.0') fail('source-mismatch', 409);
    const actor = raw.actor, authority = raw.authority, obj = raw.object, context = raw.context;
    if (!object(actor) || actor.objectType !== 'Agent' || Object.keys(actor).some(k => !['objectType', 'name', 'account'].includes(k))
      || !object(actor.account) || Object.keys(actor.account).some(k => !['homePage', 'name'].includes(k))
      || actor.account.name !== principal.learnerWebId || actor.account.homePage !== source.actorHomePage
      || !object(authority) || authority.objectType !== 'Agent' || Object.keys(authority).some(k => !['objectType', 'name', 'account'].includes(k))
      || !object(authority.account) || Object.keys(authority.account).some(k => !['homePage', 'name'].includes(k))
      || authority.account.name !== 'foxxi-lrs' || authority.account.homePage !== authorityHomePage
      || !object(obj) || obj.objectType !== 'Activity' || !text(obj.id) || !obj.id.startsWith(source.courseBaseUri)
      || !object(context) || context.platform !== source.platform || context.registration !== undefined
      || !object(context.contextActivities) || !Array.isArray(context.contextActivities.grouping)
      || context.contextActivities.grouping.length !== 1 || !object(context.contextActivities.grouping[0])
      || context.contextActivities.grouping[0].id !== source.contextUri) fail('source-mismatch', 409);
    const encoded = obj.id.slice(source.courseBaseUri.length);
    try { const id = decodeURIComponent(encoded); if (!/^[A-Za-z0-9._-]{1,200}$/.test(id) || encodeURIComponent(id) !== encoded) fail('source-mismatch', 409); }
    catch { return fail('source-mismatch', 409); }
    return copy(raw);
  };
  const resolve = async (ids: [string, string]): Promise<RecoverySourceFacts> => {
    const now = clock();
    const settled = await Promise.allSettled(ids.map(id => ports.readStatement(id)));
    if (settled.some(result => result.status !== 'fulfilled')) fail('source-unavailable', 503);
    const pair = settled.map(result => statement((result as PromiseFulfilledResult<unknown>).value, now));
    if (pair.some((s, i) => s.id !== ids[i])) fail('source-mismatch', 409);
    const tags = await Promise.allSettled(pair.map(s => ports.gradedHere(s)));
    if (tags.some(tag => tag.status !== 'fulfilled' || tag.value !== true)) fail('engine-evidence-unverified', 409);
    const completed = pair.find(s => object(s.verb) && s.verb.id === ADL + 'completed');
    const assessed = pair.find(s => object(s.verb) && [ADL + 'passed', ADL + 'failed'].includes(String(s.verb.id)));
    if (!completed || !assessed || completed.id === assessed.id || !object(completed.result) || completed.result.completion !== true
      || !object(assessed.result) || assessed.result.completion !== true || typeof assessed.result.success !== 'boolean'
      || !object(assessed.result.score) || typeof assessed.result.score.scaled !== 'number' || !Number.isFinite(assessed.result.score.scaled)
      || assessed.result.score.scaled < 0 || assessed.result.score.scaled > 1 || !object(assessed.verb)
      || (assessed.verb.id === ADL + 'passed') !== assessed.result.success
      || (completed.object as Record<string, unknown>).id !== (assessed.object as Record<string, unknown>).id
      || Math.abs(Date.parse(String(completed.timestamp)) - Date.parse(String(assessed.timestamp))) > 5000) fail('source-mismatch', 409);
    const courseUri = (completed.object as Record<string, unknown>).id as string;
    const sourceStoredAt: [string, string] = [completed.stored as string, assessed.stored as string];
    // xAPI since/until select LRS storage time, not the original event time.
    // Retain both independently: delayed persistence must not hide originals.
    const checkedRange = { since: new Date(Math.min(...sourceStoredAt.map(Date.parse)) - 2000).toISOString(),
      until: new Date(Math.max(...sourceStoredAt.map(Date.parse)) + 2000).toISOString() };
    let range: { statements: unknown[]; more: string | null };
    try { range = await ports.readRange({ ...checkedRange, activity: courseUri, ascending: true, limit: 20 }); }
    catch { return fail('source-unavailable', 503); }
    if (!object(range) || !Array.isArray(range.statements) || range.statements.length !== 2 || (range.more !== '' && range.more !== null)) fail('ambiguous-source', 409);
    const rangeIds = new Set<string>();
    for (const raw of range.statements) {
      const s = statement(raw, now);
      if (rangeIds.has(String(s.id))) fail('ambiguous-source', 409);
      rangeIds.add(String(s.id));
      const original = pair.find(p => p.id === s.id);
      if (!original || canonicalRecoveryJson(original) !== canonicalRecoveryJson(s)) fail('ambiguous-source', 409);
    }
    const base = { subjectDid: principal.subjectDid, learnerWebId: principal.learnerWebId, courseUri,
      courseId: decodeURIComponent(courseUri.slice(source.courseBaseUri.length)), contextUri: source.contextUri,
      outcome: { completed: true as const, passed: assessed.result.success, scoreScaled: assessed.result.score.scaled },
      sourceStatementIds: [completed.id as string, assessed.id as string] as [string, string],
      sourceStatementDigests: [recoveryDigest(completed), recoveryDigest(assessed)] as [string, string],
      originalCompletedAt: completed.timestamp as string, originalAssessmentAt: assessed.timestamp as string, sourceStoredAt, checkedRange };
    const sourceKey = sourceIdentity(base);
    return { ...base, sourceKey, id: entryId(sourceKey) };
  };
  const sourceIds = (raw: unknown): [string, string] => {
    if (!Array.isArray(raw) || raw.length !== 2 || !raw.every(id => typeof id === 'string' && UUID.test(id))) fail('invalid-input');
    const ids = raw.map(id => (id as string).toLowerCase()) as [string, string];
    if (ids[0] === ids[1]) fail('invalid-input'); return ids;
  };
  const sameFacts = (a: RecoverySourceFacts, b: RecoverySourceFacts): boolean => canonicalRecoveryJson(factsFrom(a)) === canonicalRecoveryJson(factsFrom(b));
  const attest = async (claims: Record<string, unknown>): Promise<string> => {
    try {
      const token = await ports.attest(claims);
      if (!text(token, 65536) || canonicalRecoveryJson(await ports.verify(token)) !== canonicalRecoveryJson(claims)) fail('attestation-unavailable', 503);
      return token;
    } catch { return fail('attestation-unavailable', 503); }
  };
  const read = async (id: string): Promise<RecoveryReadResult> => {
    if (!HEX.test(id)) fail('invalid-input');
    const state = await ledger(), entry = state.entries.find(e => e.id === id);
    if (!entry) return { kind: 'own-lti-reconciliation', found: false, revision: state.revision, verification: verification(false, false) };
    let unchanged = false;
    try { unchanged = (await loadWitness()).witnessDigest === entry.legacyWitness.witnessDigest; } catch { /* Remains unconfirmed. */ }
    return { kind: 'own-lti-reconciliation', found: true, entry, revision: state.revision, verification: verification(unchanged, unchanged, true) };
  };
  return {
    validateEntry: (value: unknown): Promise<boolean> => validateRecoveryEntry(value, { principal, verify: ports.verify }),
    read,
    async preview(input: unknown): Promise<RecoveryPreview> {
      if (!object(input)) fail('invalid-input');
      keys(input, ['originalStatementIds', ...TRANSPORT_FIELDS]); canonicalRecoveryJson(input); transport(input, principal);
      const facts = await resolve(sourceIds(input.originalStatementIds));
      const legacyWitness = await loadWitness(), state = await ledger();
      if (hasSourceCollision(state.entries, facts)) fail('entry-conflict', 409);
      const existing = state.entries.find(e => e.id === facts.id);
      if (existing && !sameFacts(existing, facts)) fail('entry-conflict', 409);
      const issued = clock();
      const base = { type: 'own-lti-reconciliation-plan/1' as const, principal, issuedAt: new Date(issued).toISOString(),
        expiresAt: new Date(issued + PLAN_TTL_MS).toISOString(), facts, legacyWitness, expectedRevision: state.revision };
      const previewDigest = recoveryDigest(base), claims: PlanClaims = { ...base, previewDigest };
      const planToken = await attest(claims as unknown as Record<string, unknown>);
      return { kind: 'own-lti-reconciliation-preview', previewDigest, planToken, expiresAt: base.expiresAt,
        entryId: facts.id, sourceKey: facts.sourceKey, facts: copy(facts), legacyWitness, expectedRevision: state.revision,
        existingEntry: !!existing, originalGradebookMatched: false, originalLmsPersistence: 'unverified' };
    },
    async apply(input: unknown): Promise<RecoveryApplyResult> {
      if (!object(input)) fail('invalid-input');
      keys(input, ['planToken', 'intent', ...TRANSPORT_FIELDS]); canonicalRecoveryJson(input); transport(input, principal);
      if (input.intent !== 'create-reconciled-lms-entry' || !text(input.planToken, 65536)) fail('invalid-input');
      let raw: unknown;
      try { raw = await ports.verify(input.planToken); } catch { return fail('plan-invalid', 400); }
      if (!object(raw)) fail('plan-invalid');
      try { keys(raw, ['type', 'principal', 'issuedAt', 'expiresAt', 'facts', 'legacyWitness', 'expectedRevision', 'previewDigest']); canonicalRecoveryJson(raw); }
      catch { return fail('plan-invalid'); }
      const plan = copy(raw) as unknown as PlanClaims;
      const { previewDigest, ...base } = plan;
      if (plan.type !== 'own-lti-reconciliation-plan/1' || !validFacts(plan.facts) || !iso(plan.issuedAt) || !iso(plan.expiresAt)
        || Date.parse(plan.expiresAt) - Date.parse(plan.issuedAt) !== PLAN_TTL_MS || !HEX.test(previewDigest)
        || previewDigest !== recoveryDigest(base) || (plan.expectedRevision !== null && !text(plan.expectedRevision, 512))) fail('plan-invalid');
      if (canonicalRecoveryJson(plan.principal) !== canonicalRecoveryJson(principal)) fail('plan-owner-mismatch', 403);
      const now = clock();
      if (Date.parse(plan.issuedAt) > now + 5000 || Date.parse(plan.expiresAt) <= now) fail('plan-expired', 409);
      const plannedWitness = witness(plan.legacyWitness), facts = await resolve(plan.facts.sourceStatementIds);
      if (!sameFacts(facts, plan.facts)) fail('plan-changed', 409);
      const beforeWitness = await loadWitness();
      if (beforeWitness.witnessDigest !== plannedWitness.witnessDigest) fail('plan-changed', 409);
      const state = await ledger();
      if (hasSourceCollision(state.entries, facts)) fail('entry-conflict', 409);
      const existing = state.entries.find(e => e.id === facts.id);
      if (existing) {
        if (!sameFacts(existing, facts)) fail('entry-conflict', 409);
        const result = await read(existing.id);
        return { ...result, state: result.verification.confirmed ? 'already-recorded' : 'unconfirmed', applied: false,
          ...(!result.verification.confirmed ? { reason: 'legacy-witness-changed' as const } : {}) };
      }
      if (state.revision !== plan.expectedRevision) fail('ledger-conflict', 409);
      if (state.entries.length >= MAX_ENTRIES) fail('ledger-capacity', 409);
      const unsigned: Omit<RecoveryEntry, 'entryDigest' | 'attestation'> = { ...facts, schemaVersion: '1.0.0', kind: 'reconciled-lms-entry',
        previewDigest: plan.previewDigest,
        reconciledAt: new Date(clock()).toISOString(), reconciledBy: principal.callerDid, legacyWitness: beforeWitness,
        sourceAssociation: SOURCE_ASSOCIATION, engineTagCoverage: ENGINE_TAG_COVERAGE,
        originalGradebookMatched: false as const, originalLmsPersistence: 'unverified' as const, attestationKind: 'private-bridge-hmac' as const };
      const entryDigest = recoveryDigest(unsigned);
      const entry = { ...unsigned, entryDigest, attestation: '' };
      entry.attestation = await attest(entryClaims(entry));
      // Source/range and native reads may take minutes. Never spend a plan that
      // expired while those checks or the service attestation were in flight.
      if (Date.parse(plan.expiresAt) <= clock()) fail('plan-expired', 409);
      let appended: RecoveryLedgerSnapshot;
      try { appended = await ports.ledger.append(plan.expectedRevision, entry); }
      catch (error) {
        if ((error as { status?: unknown } | null)?.status === 409 || (error as { status?: unknown } | null)?.status === 412) fail('ledger-conflict', 409);
        return { kind: 'own-lti-reconciliation', found: false, revision: null, verification: verification(false, false),
          state: 'unconfirmed', applied: null, reason: 'append-unconfirmed' };
      }
      try {
        const checked = await ledger(), persisted = checked.entries.find(e => e.id === entry.id);
        if (!appended.entries.some(e => canonicalRecoveryJson(e) === canonicalRecoveryJson(entry))
          || !persisted || canonicalRecoveryJson(persisted) !== canonicalRecoveryJson(entry) || checked.revision === null) fail('entry-invalid', 503);
        let unchanged = false;
        try { unchanged = (await loadWitness()).witnessDigest === beforeWitness.witnessDigest; } catch { /* No atomic cross-resource claim. */ }
        return { kind: 'own-lti-reconciliation', found: true, entry: persisted, revision: checked.revision,
          verification: verification(unchanged, unchanged, true), state: unchanged ? 'recorded' : 'unconfirmed', applied: true,
          ...(!unchanged ? { reason: 'legacy-witness-changed' as const } : {}) };
      } catch {
        return { kind: 'own-lti-reconciliation', found: false, revision: null, verification: verification(false, false),
          state: 'unconfirmed', applied: true, reason: 'readback-unavailable' };
      }
    },
  };
}
