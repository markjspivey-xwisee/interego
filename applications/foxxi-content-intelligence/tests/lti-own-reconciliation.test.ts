import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isGradedBy, withGradedTag } from '../src/graded-evidence.js';
import { matchesFilter } from '../src/statement-store.js';
import {
  canonicalRecoveryJson, createOwnLtiReconciliation, recoveryDigest, validateRecoveryEntry,
  type LegacyFailureWitness, type OriginalStatement, type OwnLtiReconciliationPorts,
  type RecoveryLedgerSnapshot, type RecoveryPrincipal, type RecoveryRangeQuery,
} from '../src/lti-own-reconciliation.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const originalIds: [string, string] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const originalAt = '2026-10-31T18:24:10.349Z';
const principal: RecoveryPrincipal = { subjectDid: 'did:web:identity.example:users:human',
  learnerWebId: 'https://identity.example/users/human/profile#me', callerDid: 'did:web:app.example:agents:keeper',
  podUrl: 'https://pod.example/human/' };
const source = { actorHomePage: 'did:web:lms.example', courseBaseUri: 'https://lms.example/agent/scorm/course/',
  contextUri: 'https://lms.example/lti/platform/contexts/foxxi-open', platform: 'Foxxi LMS over LTI 1.3' };
const engineKey = 'synthetic-stable-engine-key';
const serviceKey = 'synthetic-stable-private-ledger-key';
const witness: LegacyFailureWitness = { schemaVersion: '1.0.0', reason: 'legacy-head-mismatch',
  descriptorSha256: 'a'.repeat(64), graphSha256: 'b'.repeat(64), payloadSha256: 'c'.repeat(64),
  expectedGraphIri: 'urn:foxxi:lti-platform-snapshot:v2', actualGraphIri: 'urn:foxxi:lti-platform-snapshot:v1',
  headRevision: '"head-v2"', graphRevision: '"graph-v1"', witnessDigest: 'd'.repeat(64),
  observedAt: '2026-10-31T19:00:00.000Z' };

function macPorts(key = serviceKey) {
  return {
    attest(claims: Record<string, unknown>): string {
      const body = Buffer.from(canonicalRecoveryJson(claims)).toString('base64url');
      return body + '.' + createHmac('sha256', key).update(body).digest('hex');
    },
    verify(token: string): unknown {
      const [body, signature, extra] = token.split('.');
      const expected = createHmac('sha256', key).update(body ?? '').digest('hex');
      if (!body || !signature || extra || signature.length !== expected.length
        || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('invalid private MAC');
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    },
  };
}
function originals(passed = true): [OriginalStatement, OriginalStatement] {
  return ['completed', passed ? 'passed' : 'failed'].map((verb, index) => withGradedTag({
    id: originalIds[index], timestamp: new Date(Date.parse(originalAt) + index * 10).toISOString(),
    stored: new Date(Date.parse(originalAt) + 1000).toISOString(), version: '2.0.0',
    actor: { objectType: 'Agent', account: { homePage: source.actorHomePage, name: principal.learnerWebId } },
    authority: { objectType: 'Agent', account: { homePage: 'https://lms.example', name: 'foxxi-lrs' } },
    verb: { id: 'http://adlnet.gov/expapi/verbs/' + verb },
    object: { objectType: 'Activity', id: source.courseBaseUri + 'signalkeeper-mirrors' },
    result: index ? { completion: true, success: passed, score: { scaled: passed ? 1 : 0.25 } } : { completion: true },
    context: { platform: source.platform, contextActivities: { grouping: [{ objectType: 'Activity', id: source.contextUri }] } },
  }, engineKey)) as [OriginalStatement, OriginalStatement];
}
function fixture(passed = true) {
  let now = Date.parse('2026-10-31T19:05:00.000Z');
  let currentWitness = clone(witness);
  let state: RecoveryLedgerSnapshot = { revision: null, entries: [] };
  let sourcePair = originals(passed);
  let rangeMore: string | null = '';
  let rangeOverride: unknown[] | undefined;
  const queries: RecoveryRangeQuery[] = [];
  const graded: string[] = [];
  let appendCalls = 0, ledgerReads = 0, witnessReads = 0;
  const ports: OwnLtiReconciliationPorts = {
    principal: clone(principal), source: clone(source), ...macPorts(), now: () => now,
    readStatement: async id => clone(sourcePair.find(s => s.id === id)),
    readRange: async query => { queries.push(clone(query)); return { statements: clone(rangeOverride ?? sourcePair), more: rangeMore }; },
    gradedHere: s => { graded.push(String(s.id)); return isGradedBy(s, engineKey); },
    readLegacyWitness: async () => { witnessReads++; return clone(currentWitness); },
    ledger: {
      read: async () => { ledgerReads++; return clone(state); },
      append: async (expectedRevision, entry) => {
        appendCalls++;
        if (expectedRevision !== state.revision) throw Object.assign(new Error('private CAS details'), { status: 409 });
        state = { revision: 'sha256:' + recoveryDigest({ previous: state.revision, entry }), entries: [...state.entries, clone(entry)] };
        return clone(state);
      },
    },
  };
  return { ports, api: () => createOwnLtiReconciliation(ports),
    get pair() { return sourcePair; }, set pair(value: [OriginalStatement, OriginalStatement]) { sourcePair = value; },
    get state() { return state; }, set state(value: RecoveryLedgerSnapshot) { state = clone(value); },
    get witness() { return currentWitness; }, set witness(value: LegacyFailureWitness) { currentWitness = clone(value); },
    get now() { return now; }, set now(value: number) { now = value; },
    set more(value: string | null) { rangeMore = value; }, set range(value: unknown[]) { rangeOverride = value; },
    queries, graded, get appends() { return appendCalls; }, get reads() { return ledgerReads; }, get witnessReads() { return witnessReads; },
  };
}
const preview = (f: ReturnType<typeof fixture>) => f.api().preview({ originalStatementIds: originalIds });
const apply = (f: ReturnType<typeof fixture>, token: string) => f.api().apply({ planToken: token, intent: 'create-reconciled-lms-entry' });

describe('own original-LRS outcome reconciliation', () => {
  it('previews read-only using both engine tags, exact point bodies and a server-derived bounded range', async () => {
    const f = fixture();
    const p = await f.api().preview({ originalStatementIds: [...originalIds].reverse() });
    expect(f.appends).toBe(0);
    expect(f.graded.sort()).toEqual([...originalIds]);
    expect(p.facts.sourceStatementIds).toEqual(originalIds);
    expect(f.queries).toEqual([{ since: '2026-10-31T18:24:09.349Z', until: '2026-10-31T18:24:13.349Z',
      activity: source.courseBaseUri + 'signalkeeper-mirrors', ascending: true, limit: 20 }]);
    expect(p.originalGradebookMatched).toBe(false);
    expect(p.originalLmsPersistence).toBe('unverified');
    expect(p.previewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(p.facts).not.toHaveProperty('sourceAssociation');
  });

  it('creates a separately attested normalized record and independently rereads it without restoring the gradebook', async () => {
    const f = fixture(); const p = await preview(f); const result = await apply(f, p.planToken);
    expect(result.state).toBe('recorded'); expect(result.applied).toBe(true); expect(f.appends).toBe(1);
    expect(result.verification).toMatchObject({ confirmed: true, nativeReadback: true, entryReadback: true,
      originalGradebookMatched: false, originalLmsPersistence: 'unverified' });
    const entry = result.entry!;
    expect(entry.previewDigest).toBe(p.previewDigest);
    expect(entry.originalCompletedAt).toBe(originalAt);
    expect(entry.originalAssessmentAt).toBe('2026-10-31T18:24:10.359Z');
    expect(entry.reconciledAt).toBe('2026-10-31T19:05:00.000Z');
    expect(entry.outcome).toEqual({ completed: true, passed: true, scoreScaled: 1 });
    for (const key of ['keeperId', 'sessionId', 'lineItemId', 'scoreMaximum', 'rawScore', 'originalGradebookTimestamp']) expect(entry).not.toHaveProperty(key);
    expect(entry.sourceAssociation).toContain('no attempt registration');
    expect(entry.engineTagCoverage).toContain('does not cover completion, platform, context');
    expect(await validateRecoveryEntry(entry, f.ports)).toBe(true);
    expect(f.reads).toBeGreaterThanOrEqual(3);
  });

  it('retains original creation preview, time and creator across idempotent previews and later same-owner agents', async () => {
    const f = fixture(); const first = await preview(f); const created = await apply(f, first.planToken);
    f.now += 60_000;
    f.ports.principal.callerDid = 'did:web:app.example:agents:later-keeper';
    const second = await preview(f);
    expect(second.previewDigest).not.toBe(first.previewDigest);
    const repeated = await apply(f, second.planToken);
    expect(repeated.state).toBe('already-recorded'); expect(repeated.applied).toBe(false);
    expect(repeated.entry).toEqual(created.entry); expect(f.appends).toBe(1);
    expect((await f.api().read(created.entry!.id)).entry).toEqual(created.entry);
  });

  it('normalizes a genuine failed assessment separately from completion', async () => {
    const f = fixture(false); const p = await preview(f); const r = await apply(f, p.planToken);
    expect(r.entry!.outcome).toEqual({ completed: true, passed: false, scoreScaled: 0.25 });
  });

  it('finds delayed originals using the real LRS stored-time filter without changing original event times', async () => {
    const f = fixture();
    f.pair[0].stored = new Date(Date.parse(originalAt) + 20_000).toISOString();
    f.pair[1].stored = new Date(Date.parse(originalAt) + 80_000).toISOString();
    // Engine tags remain valid: stored time is assigned by the LRS, outside the
    // selected engine-tag fields. The retained complete bodies still bind it.
    expect(f.pair.every(s => isGradedBy(s, engineKey))).toBe(true);
    const records = f.pair.map(s => ({ id: String(s.id), statement: s, stored: String(s.stored), voided: false }));
    const formerEventRange = { since: '2026-10-31T18:24:08.349Z', until: '2026-10-31T18:24:12.359Z' };
    expect(records.filter(record => matchesFilter(record, formerEventRange))).toHaveLength(0);
    f.ports.readRange = async query => { f.queries.push(clone(query));
      return { statements: records.filter(record => matchesFilter(record, query)).map(record => clone(record.statement)), more: null }; };
    const p = await preview(f); const r = await apply(f, p.planToken);
    expect(p.facts.sourceStoredAt).toEqual(['2026-10-31T18:24:30.349Z', '2026-10-31T18:25:30.349Z']);
    expect(p.facts.checkedRange).toEqual({ since: '2026-10-31T18:24:28.349Z', until: '2026-10-31T18:25:32.349Z' });
    expect(r.verification.confirmed).toBe(true);
    expect(r.entry!.originalCompletedAt).toBe(originalAt);
    expect(r.entry!.originalAssessmentAt).toBe('2026-10-31T18:24:10.359Z');
  });

  it.each(['outcome', 'learnerWebId', 'podUrl', 'sourceWindow', 'url', 'keeperId'])('rejects caller-selected %s and never appends', async key => {
    const f = fixture();
    await expect(f.api().preview({ originalStatementIds: originalIds, [key]: 'untrusted' })).rejects.toMatchObject({ code: 'invalid-input' });
    expect(f.appends).toBe(0);
  });

  it('requires explicit creation intent and authenticated same-principal binding', async () => {
    const f = fixture(); const p = await preview(f);
    await expect(f.api().apply({ planToken: p.planToken, intent: 'retry' })).rejects.toMatchObject({ code: 'invalid-input' });
    f.ports.principal.subjectDid = 'did:web:identity.example:users:other';
    await expect(apply(f, p.planToken)).rejects.toMatchObject({ code: 'plan-owner-mismatch', status: 403 });
    expect(f.appends).toBe(0);
  });

  it('checks both current engine tags, not a caller tag-shaped claim', async () => {
    const f = fixture(); (f.pair[1].result as { success: boolean }).success = false;
    await expect(preview(f)).rejects.toMatchObject({ code: 'engine-evidence-unverified' });
    expect(f.graded).toEqual(originalIds); expect(f.appends).toBe(0);
  });

  it.each(['actor', 'authority', 'context', 'registration', 'completion', 'course', 'stored'])('refuses invalid source %s independently of selected-field MAC coverage', async field => {
    const f = fixture(); const s = f.pair[0];
    if (field === 'actor') (s.actor as Record<string, unknown>).mbox = 'mailto:someone@example.test';
    if (field === 'authority') ((s.authority as Record<string, unknown>).account as Record<string, unknown>).name = 'not-foxxi';
    if (field === 'context') (s.context as Record<string, unknown>).platform = 'Another LMS';
    if (field === 'registration') (s.context as Record<string, unknown>).registration = originalIds[0];
    if (field === 'completion') (s.result as Record<string, unknown>).completion = false;
    if (field === 'course') (s.object as Record<string, unknown>).id = source.courseBaseUri + '%2Foutside';
    if (field === 'stored') delete s.stored;
    await expect(preview(f)).rejects.toMatchObject({ code: 'source-mismatch' }); expect(f.appends).toBe(0);
  });

  it.each(['extra', 'duplicate', 'missing', 'changed', 'more'])('refuses an ambiguous or incomplete range: %s', async condition => {
    const f = fixture();
    if (condition === 'extra') f.range = [...f.pair, clone(f.pair[0])];
    if (condition === 'duplicate') f.range = [f.pair[0], f.pair[0]];
    if (condition === 'missing') f.range = [f.pair[0]];
    if (condition === 'changed') { const changed = clone(f.pair); changed[0].extra = 'different body'; f.range = changed; }
    if (condition === 'more') f.more = '/xapi/statements?continuationToken=opaque';
    await expect(preview(f)).rejects.toMatchObject({ code: 'ambiguous-source' }); expect(f.appends).toBe(0);
  });

  it('accepts an explicit null complete-page marker and binds whole original bodies beyond engine-tag coverage', async () => {
    const f = fixture(); f.more = null; const p = await preview(f);
    f.pair[0].extra = 'a body field outside gradedFields';
    expect(isGradedBy(f.pair[0], engineKey)).toBe(true);
    await expect(apply(f, p.planToken)).rejects.toMatchObject({ code: 'plan-changed' }); expect(f.appends).toBe(0);
  });

  it('refuses reusing original UUIDs for a second entry even if a new full-body digest derives a new ID', async () => {
    const f = fixture(); const p = await preview(f); const first = await apply(f, p.planToken);
    f.pair[0].extra = 'changed field outside engine-tag coverage';
    expect(isGradedBy(f.pair[0], engineKey)).toBe(true);
    await expect(preview(f)).rejects.toMatchObject({ code: 'entry-conflict', status: 409 });
    expect(f.appends).toBe(1); expect(f.state.entries).toEqual([first.entry]);

    // An independently created valid entry can appear after preview; apply must
    // reject that same reused source before considering a new revision/write.
    const other = fixture();
    other.pair[0].extra = 'another source body';
    const competingPlan = await preview(other); other.state = f.state;
    await expect(apply(other, competingPlan.planToken)).rejects.toMatchObject({ code: 'entry-conflict', status: 409 });
    expect(other.appends).toBe(0);
  });

  it('refuses a loaded ledger containing individually valid MACed entries that overlap original source UUIDs', async () => {
    const first = fixture(); const firstPlan = await preview(first); const firstResult = await apply(first, firstPlan.planToken);
    const second = fixture(); second.pair[0].extra = 'different canonical source digest';
    const secondPlan = await preview(second); const secondResult = await apply(second, secondPlan.planToken);
    expect(secondResult.entry!.id).not.toBe(firstResult.entry!.id);
    expect(await validateRecoveryEntry(secondResult.entry, first.ports)).toBe(true);
    first.state = { revision: 'sha256:synthetic-overlap', entries: [firstResult.entry!, secondResult.entry!] };
    await expect(first.api().read(firstResult.entry!.id)).rejects.toMatchObject({ code: 'entry-invalid', status: 503 });
  });

  it('rejects altered MACs and expired plans before any append', async () => {
    const f = fixture(); const p = await preview(f);
    await expect(apply(f, p.planToken.slice(0, -1) + (p.planToken.endsWith('a') ? 'b' : 'a'))).rejects.toMatchObject({ code: 'plan-invalid' });
    f.now += 600_000;
    await expect(apply(f, p.planToken)).rejects.toMatchObject({ code: 'plan-expired' }); expect(f.appends).toBe(0);
  });

  it('rechecks expiry immediately before append after slow fresh source and attestation work', async () => {
    const f = fixture(); const p = await preview(f); const originalAttest = f.ports.attest;
    f.ports.attest = async claims => { const result = await originalAttest(claims); f.now += 600_000; return result; };
    await expect(apply(f, p.planToken)).rejects.toMatchObject({ code: 'plan-expired' }); expect(f.appends).toBe(0);
  });

  it('refuses changed legacy witnesses and stale private ledger revisions', async () => {
    const f = fixture(); const p = await preview(f);
    f.witness = { ...f.witness, witnessDigest: 'e'.repeat(64) };
    await expect(apply(f, p.planToken)).rejects.toMatchObject({ code: 'plan-changed' });
    f.witness = witness; f.state = { revision: 'sha256:changed', entries: [] };
    await expect(apply(f, p.planToken)).rejects.toMatchObject({ code: 'ledger-conflict', status: 409 }); expect(f.appends).toBe(0);
  });

  it('retains an appended entry but makes no atomic claim when the old witness changes afterward', async () => {
    const f = fixture(); const p = await preview(f); const append = f.ports.ledger.append;
    f.ports.ledger.append = async (revision, entry) => { const result = await append(revision, entry);
      f.witness = { ...f.witness, witnessDigest: 'e'.repeat(64) }; return result; };
    const r = await apply(f, p.planToken);
    expect(r).toMatchObject({ state: 'unconfirmed', applied: true, reason: 'legacy-witness-changed',
      verification: { confirmed: false, nativeReadback: true, entryReadback: true, reviewNeeded: true, originalGradebookMatched: false } });
    expect((await f.api().read(p.entryId)).verification.confirmed).toBe(false); expect(f.state.entries).toHaveLength(1);
  });

  it('reports a lost append acknowledgment without claiming failure or blindly retrying a possible write', async () => {
    const f = fixture(); const p = await preview(f); const append = f.ports.ledger.append;
    f.ports.ledger.append = async (revision, entry) => { await append(revision, entry); throw new Error('private network details'); };
    const r = await apply(f, p.planToken);
    expect(r).toMatchObject({ state: 'unconfirmed', applied: null, reason: 'append-unconfirmed', verification: { confirmed: false } });
    expect(JSON.stringify(r)).not.toContain('private network'); expect(f.appends).toBe(1);
    expect((await f.api().read(p.entryId)).verification.confirmed).toBe(true);
  });

  it('fails closed on missing fresh readback or an altered persisted entry', async () => {
    const f = fixture(); const p = await preview(f); const append = f.ports.ledger.append;
    f.ports.ledger.append = async (revision, entry) => { const r = await append(revision, entry);
      f.state = { ...f.state, entries: [{ ...entry, previewDigest: 'f'.repeat(64) }] }; return r; };
    const r = await apply(f, p.planToken);
    expect(r).toMatchObject({ state: 'unconfirmed', applied: true, reason: 'readback-unavailable', verification: { confirmed: false } });
  });

  it('rejects foreign-owner, foreign-key and modified unsigned entries on independent read', async () => {
    const f = fixture(); const p = await preview(f); const r = await apply(f, p.planToken); const entry = r.entry!;
    expect(await validateRecoveryEntry(entry, { principal: { ...principal, subjectDid: 'did:web:identity.example:users:other' }, verify: f.ports.verify })).toBe(false);
    expect(await validateRecoveryEntry(entry, { principal, verify: macPorts('different-stable-key').verify })).toBe(false);
    expect(await validateRecoveryEntry({ ...entry, previewDigest: 'f'.repeat(64) }, f.ports)).toBe(false);
  });

  it('rejects nonfinite or accessor JSON without invoking getters', () => {
    let invoked = false;
    const value = Object.defineProperty({}, 'unsafe', { enumerable: true, get() { invoked = true; return 'secret'; } });
    expect(() => canonicalRecoveryJson(value)).toThrow('invalid-input'); expect(invoked).toBe(false);
    expect(() => canonicalRecoveryJson({ score: Number.NaN })).toThrow('invalid-input');
    expect(() => canonicalRecoveryJson(new Array(1))).toThrow('invalid-input');
    expect(() => canonicalRecoveryJson({ oversized: 'x'.repeat(256 * 1024) })).toThrow('invalid-input');
  });
});
