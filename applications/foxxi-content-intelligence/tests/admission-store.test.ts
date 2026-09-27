/**
 * A learner's kept admissions on their pod: nothing counts until the pod holds it, a list that
 * cannot be read is not an empty one, only what the bridge sealed is taken back, and writes are
 * conditional on what was read.
 */
import { describe, expect, it } from 'vitest';
import { createEncryptedEnvelope, envelopeFromJson, envelopeToJson, generateKeyPair, openEncryptedEnvelope } from '@interego/core';
import { admissionRecordFrom, standingAdmissions, type AdmissionRecord } from '../src/admission-records.js';
import { ADMISSIONS_RESOURCE, keepAdmission, readAdmissions, withRecord } from '../src/admission-store.js';
import { competencyIri } from '../src/competency-identity.js';

const pod = 'https://pod.example/learner/';
const url = `${pod}${ADMISSIONS_RESOURCE}`;
const bridge = generateKeyPair();
const record = (competency: string, kinds: string[] | null, day: number): AdmissionRecord => admissionRecordFrom({
  competency, admission: kinds ? { kinds, because: 'the plan selected it' } : null, at: `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`,
});

/** A pod that keeps one resource with an etag, honours If-Match and If-None-Match, and can be told to fail. */
function podDouble() {
  const held = new Map<string, { body: string; etag: string }>();
  let version = 0;
  const failures: Array<{ method: string; status: number }> = [];
  const puts: Array<Record<string, string>> = [];
  const fetchFn = async (target: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    const failing = failures.findIndex(f => f.method === method && target === url);
    const answer = (status: number, body = '', etag?: string) => ({ ok: status >= 200 && status < 300, status, headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? etag ?? null : null) }, text: async () => body });
    if (failing >= 0) { const [f] = failures.splice(failing, 1); return answer(f!.status); }
    if (target !== url) return answer(201);   // the container
    const cur = held.get(url);
    if (method === 'GET') return cur ? answer(200, cur.body, cur.etag) : answer(404);
    puts.push(init.headers ?? {});
    const h = init.headers ?? {};
    if (h['If-None-Match'] === '*' && cur) return answer(412);
    if (h['If-Match'] && h['If-Match'] !== cur?.etag) return answer(412);
    held.set(url, { body: init.body ?? '', etag: `"v${++version}"` });
    return answer(cur ? 204 : 201);
  };
  return { fetchFn, held, failures, puts, bump: () => { const cur = held.get(url)!; held.set(url, { ...cur, etag: `"v${++version}"` }); } };
}

describe('a learner\'s kept admissions on their pod', () => {
  it('reads an absent list as nothing kept, and a kept record back', async () => {
    const p = podDouble();
    expect(await readAdmissions(pod, bridge, p.fetchFn)).toEqual({ ok: true, records: [], exists: false });
    expect(await keepAdmission(pod, record('refund-authority', ['probe'], 1), bridge, p.fetchFn)).toMatchObject({ ok: true });
    const read = await readAdmissions(pod, bridge, p.fetchFn);
    if (!read.ok) throw new Error(read.error);
    expect(read.records.map(r => r.admission?.kinds)).toEqual([['probe']]);
    expect(p.puts[0]).toMatchObject({ 'If-None-Match': '*' });   // created only if still absent
  });

  it('keeps nothing of a write the pod refused, now or at a later write', async () => {
    const p = podDouble();
    await keepAdmission(pod, record('refund-authority', ['probe'], 1), bridge, p.fetchFn);
    p.failures.push({ method: 'PUT', status: 500 });
    expect(await keepAdmission(pod, record('refund-authority', [], 2), bridge, p.fetchFn)).toMatchObject({ ok: false });
    const after = await readAdmissions(pod, bridge, p.fetchFn);
    if (!after.ok) throw new Error(after.error);
    expect(after.records.map(r => r.admission?.kinds)).toEqual([['probe']]);
    await keepAdmission(pod, record('escalation', ['reference'], 3), bridge, p.fetchFn);
    const later = await readAdmissions(pod, bridge, p.fetchFn);
    if (!later.ok) throw new Error(later.error);
    expect(later.records.some(r => r.admission?.kinds.length === 0)).toBe(false);   // the refused one never arrives
  });

  it('says a list it cannot read is unreadable, never that nothing was kept', async () => {
    const p = podDouble();
    await keepAdmission(pod, record('refund-authority', ['probe'], 1), bridge, p.fetchFn);
    p.failures.push({ method: 'GET', status: 503 });
    expect(await readAdmissions(pod, bridge, p.fetchFn)).toMatchObject({ ok: false });
    expect(await readAdmissions(pod, null, p.fetchFn)).toMatchObject({ ok: false });   // held, and no key to open it
    expect(await readAdmissions(pod, generateKeyPair(), p.fetchFn)).toMatchObject({ ok: false });
    const garbage = podDouble();
    garbage.held.set(url, { body: 'not an envelope', etag: '"x"' });
    expect(await readAdmissions(pod, bridge, garbage.fetchFn)).toMatchObject({ ok: false });
    const unreachable = async () => { throw new Error('connection refused'); };
    expect(await readAdmissions(pod, bridge, unreachable as never)).toMatchObject({ ok: false, error: expect.stringMatching(/connection refused/) });
  });

  it('takes back only a list the bridge sealed, and seals it so the owner can read it too', async () => {
    const owner = generateKeyPair();
    const forged = podDouble();
    // Anyone can wrap a key to the bridge's public key; only the bridge can wrap one from it.
    forged.held.set(url, { body: envelopeToJson(createEncryptedEnvelope(JSON.stringify({ records: [record('refund-authority', [], 1)] }), [bridge.publicKey], generateKeyPair())), etag: '"f"' });
    expect(await readAdmissions(pod, bridge, forged.fetchFn)).toMatchObject({ ok: false });
    const p = podDouble();
    await keepAdmission(pod, record('refund-authority', ['probe'], 1), bridge, p.fetchFn, owner.publicKey);
    const opened = openEncryptedEnvelope(envelopeFromJson(p.held.get(url)!.body), owner);
    expect(JSON.parse(opened!).records[0].competency).toBe(competencyIri('refund-authority'));
  });

  it('writes on the condition of what it read, and reads again when another write came between', async () => {
    const p = podDouble();
    await keepAdmission(pod, record('refund-authority', ['probe'], 1), bridge, p.fetchFn);
    // Another writer changes the list after our read: our first write is refused, and we read and write again.
    let bumped = false;
    const racing = async (target: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      if (init?.method === 'PUT' && target === url && !bumped) { bumped = true; p.bump(); }
      return p.fetchFn(target, init);
    };
    expect(await keepAdmission(pod, record('escalation', ['reference'], 2), bridge, racing)).toMatchObject({ ok: true });
    expect(p.puts.filter(h => h['If-Match']).length).toBeGreaterThanOrEqual(2);
    const read = await readAdmissions(pod, bridge, p.fetchFn);
    if (!read.ok) throw new Error(read.error);
    expect(read.records).toHaveLength(2);
    const always = async (target: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      if (init?.method === 'PUT' && target === url) p.bump();
      return p.fetchFn(target, init);
    };
    expect(await keepAdmission(pod, record('refund-authority', null, 3), bridge, always)).toMatchObject({ ok: false, error: expect.stringMatching(/other writes kept coming between/) });
  });

  it('keeps every standing record and the most recent of the rest', () => {
    let list: AdmissionRecord[] = [];
    for (let day = 1; day <= 9; day++) list = withRecord(list, record('refund-authority', ['probe'], day), 3);
    list = withRecord(list, record('escalation', ['reference'], 1), 3);
    expect(list.filter(r => r.competency === competencyIri('escalation'))).toHaveLength(1);   // standing, though oldest
    expect(list).toHaveLength(5);   // two standing, three of the rest
    expect(standingAdmissions(list).get('refund-authority')?.at).toBe('2026-09-09T12:00:00.000Z');
  });
});
