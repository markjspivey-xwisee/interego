import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecoveryAttestation, ownLtiReconciliationHandler, type RecoveryHttpPorts, type RecoveryOperation } from '../src/lti-own-reconciliation-http.js';
import { canonicalRecoveryJson, OwnLtiReconciliationError, type RecoveryApplyResult, type RecoveryPreview, type RecoveryReadResult } from '../src/lti-own-reconciliation.js';
import { OwnSubjectXapiRequestBudget } from '../src/own-subject-xapi.js';
import type { OwnSubjectXapiAuthority } from '../src/own-subject-xapi-auth.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

/** Real HTTP + Express + the production handler and request budget.
 * Authority/workflow ports are explicit stubs: these are transport-boundary tests,
 * not signature/delegation, original-LRS, or durable-ledger verification claims. */
async function fixture() {
  const authority: OwnSubjectXapiAuthority = { ok: true, callerDid: 'did:web:identity.test:agents:synthetic-session',
    subjectDid: 'did:web:identity.test:users:synthetic-person', podUrl: 'https://pod.test/synthetic-person/',
    ownerPublicKey: 'synthetic-test-key-not-used-by-transport', payload: {} };
  const workflow = {
    preview: vi.fn(async (_input: unknown) => ({ kind: 'own-lti-reconciliation-preview',
      previewDigest: 'a'.repeat(64), planToken: 'synthetic-private-plan' } as unknown as RecoveryPreview)),
    apply: vi.fn(async (_input: unknown) => ({ kind: 'own-lti-reconciliation', state: 'unconfirmed',
      applied: null, found: false } as unknown as RecoveryApplyResult)),
    read: vi.fn(async (_entryId: string) => ({ kind: 'own-lti-reconciliation', found: false,
      revision: null } as unknown as RecoveryReadResult)),
  };
  const verify = vi.fn<RecoveryHttpPorts['verify']>(async () => authority);
  const compose = vi.fn<RecoveryHttpPorts['compose']>(() => workflow);
  const budget = new OwnSubjectXapiRequestBudget();
  const allow = vi.fn((key: string, limit: number) => budget.allow(key, limit));
  const app = express();
  app.use(express.json({ limit: '300kb' }));
  const ports: RecoveryHttpPorts = { verify, compose, allow };
  for (const operation of ['preview', 'apply', 'read'] as const)
    app.post('/' + operation, ownLtiReconciliationHandler(operation, ports));
  const server = createServer(app); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (operation: RecoveryOperation, body: unknown = { _signed_payload: 'synthetic-envelope' }, headers: Record<string, string> = {}) =>
    fetch(origin + '/' + operation, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, authority, workflow, verify, compose, allow, request };
}

describe('signed own-LTI reconciliation HTTP boundary', () => {
  it('refuses unauthenticated callers before composing workflow and reflects no verifier secret', async () => {
    const f = await fixture();
    f.verify.mockResolvedValue({ ok: false, status: 403, error: 'synthetic-secret-do-not-reflect' });
    const response = await f.request('apply');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'reconciliation_authority_unverified' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(f.compose).not.toHaveBeenCalled(); expect(f.workflow.apply).not.toHaveBeenCalled();
    expect(f.verify.mock.calls[0]![1]).toBe(true);
  });

  it('requests write authority only for apply and strips only authenticated transport fields', async () => {
    const f = await fixture();
    const transport = { subject_did: f.authority.subjectDid, subject_pod_url: f.authority.podUrl,
      purpose: 'personal-performance', timestamp: '2026-11-01T02:00:00.000Z', agent_id: f.authority.callerDid };
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    f.authority.payload = { ...transport, originalStatementIds: ids };
    const preview = await f.request('preview', { _signed_payload: 'signed', untrusted_outer_field: 'ignored by signature port' });
    expect(preview.status).toBe(200); await preview.arrayBuffer();
    expect(f.workflow.preview).toHaveBeenCalledWith({ originalStatementIds: ids });
    expect(f.compose.mock.calls.at(-1)).toEqual([f.authority, true]);
    f.authority.payload = { ...transport, planToken: 'synthetic-plan', intent: 'create-reconciled-lms-entry' };
    const apply = await f.request('apply'); expect(apply.status).toBe(200); await apply.arrayBuffer();
    expect(f.workflow.apply).toHaveBeenCalledWith({ planToken: 'synthetic-plan', intent: 'create-reconciled-lms-entry' });
    expect(f.compose.mock.calls.at(-1)).toEqual([f.authority, false]);
    f.authority.payload = { ...transport, entryId: 'b'.repeat(64) };
    const read = await f.request('read'); expect(read.status).toBe(200); await read.arrayBuffer();
    expect(f.workflow.read).toHaveBeenCalledWith('b'.repeat(64));
    expect(f.compose.mock.calls.at(-1)).toEqual([f.authority, true]);
    expect(f.verify.mock.calls.map(call => call[1])).toEqual([false, true, false]);
  });

  it('refuses read selectors with unknown fields, malformed IDs or caller-selected resource URLs', async () => {
    const f = await fixture();
    for (const payload of [{}, { entryId: 'not-hex' }, { entryId: 'a'.repeat(64), extra: true },
      { entryId: 'a'.repeat(64), headUrl: 'https://untrusted.test/private' }]) {
      f.authority.payload = payload;
      const response = await f.request('read'); expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'reconciliation_invalid-input', confirmed: false });
    }
    expect(f.workflow.read).not.toHaveBeenCalled();
  });

  it('bounds the signed envelope before authority work and rejects early IP/subsequent subject limits', async () => {
    const f = await fixture();
    for (const body of [{}, { _signed_payload: 7 }, { _signed_payload: 'x'.repeat(262145) }]) {
      const response = await f.request('preview', body); expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_signed_reconciliation' });
    }
    expect(f.verify).not.toHaveBeenCalled(); expect(f.compose).not.toHaveBeenCalled();
    f.allow.mockReturnValueOnce(false);
    const blockedIp = await f.request('preview'); expect(blockedIp.status).toBe(429);
    expect(blockedIp.headers.get('Retry-After')).toBe('60'); await blockedIp.arrayBuffer();
    expect(f.verify).not.toHaveBeenCalled();
    f.allow.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const blockedSubject = await f.request('preview'); expect(blockedSubject.status).toBe(429); await blockedSubject.arrayBuffer();
    expect(f.verify).toHaveBeenCalledTimes(1); expect(f.compose).not.toHaveBeenCalled();
    expect(f.allow.mock.calls.some(([key, limit]) => key.startsWith('recovery:ip:') && limit === 120)).toBe(true);
    expect(f.allow.mock.calls.some(([key, limit]) => key === 'recovery:subject:' + f.authority.subjectDid && limit === 30)).toBe(true);
  });

  it('enforces actual 30-per-subject and 120-per-framework-IP minute budgets without trusting raw XFF', async () => {
    const f = await fixture(); expect(f.app.get('trust proxy')).toBe(false);
    for (let i = 0; i < 30; i++) {
      const response = await f.request('preview', undefined, { 'X-Forwarded-For': `198.51.100.${i}` });
      expect(response.status).toBe(200); await response.arrayBuffer();
    }
    const subject = await f.request('preview'); expect(subject.status).toBe(429); await subject.arrayBuffer();
    expect(f.compose).toHaveBeenCalledTimes(30);
    const ipKeys = f.allow.mock.calls.filter(([_key, limit]) => limit === 120).map(([key]) => key);
    expect(new Set(ipKeys).size).toBe(1); expect(ipKeys[0]).not.toContain('198.51.100.');
    const g = await fixture(); g.verify.mockResolvedValue({ ok: false, status: 401, error: 'not signed' });
    for (let i = 0; i < 120; i++) {
      const response = await g.request('read', undefined, { 'X-Forwarded-For': `198.18.0.${i}` });
      expect(response.status).toBe(401); await response.arrayBuffer();
    }
    const blocked = await g.request('read'); expect(blocked.status).toBe(429); expect(blocked.headers.get('Retry-After')).toBe('60');
    await blocked.arrayBuffer(); expect(g.verify).toHaveBeenCalledTimes(120); expect(g.compose).not.toHaveBeenCalled();
  });

  it('admits at most eight concurrent authority checks and releases reservations after success or thrown failures', async () => {
    const f = await fixture();
    let resolveEntered!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { resolveEntered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let running = 0;
    f.verify.mockImplementation(async () => { if (++running === 8) resolveEntered(); await gate; return f.authority; });
    const pending = Array.from({ length: 8 }, () => f.request('preview'));
    await entered;
    const blocked = await f.request('preview'); expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('2'); expect(await blocked.json()).toEqual({ error: 'reconciliation_busy' });
    expect(f.verify).toHaveBeenCalledTimes(8); release();
    for (const response of await Promise.all(pending)) { expect(response.status).toBe(200); await response.arrayBuffer(); }
    f.verify.mockRejectedValue(new Error('synthetic-secret-should-never-be-reflected'));
    for (let i = 0; i < 9; i++) {
      const failed = await f.request('preview'); expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ error: 'reconciliation_unconfirmed', confirmed: false });
    }
    f.verify.mockResolvedValue(f.authority);
    const recovered = await f.request('preview'); expect(recovered.status).toBe(200); await recovered.arrayBuffer();
  });

  it('returns fixed known errors and safe whitelisted storage statuses without reflecting remote data', async () => {
    const f = await fixture();
    f.workflow.preview.mockRejectedValueOnce(new OwnLtiReconciliationError('source-mismatch', 409));
    const known = await f.request('preview'); expect(known.status).toBe(409);
    expect(await known.json()).toEqual({ error: 'reconciliation_source-mismatch', confirmed: false });
    for (const status of [400, 403, 409, 413, 429, 503, 418]) {
      f.workflow.preview.mockRejectedValueOnce(Object.assign(new Error('token=synthetic-secret; url=https://untrusted.test/private-capability'), { status }));
      const response = await f.request('preview'); expect(response.status).toBe(status === 418 ? 503 : status);
      expect(await response.json()).toEqual({ error: 'reconciliation_unconfirmed', confirmed: false });
    }
  });
});

describe('private domain-separated reconciliation MAC', () => {
  const secret = 'a'.repeat(64), domain = 'foxxi/own-lti-reconciliation/private-attestation/v1';
  const manual = (body: string, usedDomain = domain) => {
    const key = createHmac('sha256', Buffer.from(secret, 'hex')).update(usedDomain).digest();
    return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
  };
  it('signs exact recursively canonical claims and round-trips across a fresh service instance', () => {
    const claims = { z: [2, 1], a: { z: false, a: 'synthetic-private-claim' } };
    const mac = createRecoveryAttestation(secret), token = mac.attest(claims);
    const body = Buffer.from(canonicalRecoveryJson(claims), 'utf8').toString('base64url');
    expect(token).toBe(manual(body));
    expect(createRecoveryAttestation('0x' + secret.toUpperCase()).attest({ a: { a: 'synthetic-private-claim', z: false }, z: [2, 1] })).toBe(token);
    expect(createRecoveryAttestation(secret).verify(token)).toEqual(claims);
    const decoded = mac.verify(token) as typeof claims; decoded.a.a = 'changed local view';
    expect(mac.verify(token)).toEqual(claims);
  });
  it('rejects changed data, changed key, wrong domain and noncanonical body or signature encodings', () => {
    const mac = createRecoveryAttestation(secret), claims = { a: 1, z: 2 }, token = mac.attest(claims);
    const [body, signature] = token.split('.');
    expect(() => mac.verify(Buffer.from('{"a":9,"z":2}').toString('base64url') + '.' + signature)).toThrow();
    expect(() => createRecoveryAttestation('b'.repeat(64)).verify(token)).toThrow();
    expect(() => mac.verify(manual(body!, domain + '/different'))).toThrow();
    expect(() => mac.verify(manual(Buffer.from('{"z":2,"a":1}').toString('base64url')))).toThrow();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(signature!.at(-1)!);
    const noncanonical = signature!.slice(0, -1) + alphabet[last ^ 1];
    expect(Buffer.from(noncanonical, 'base64url')).toEqual(Buffer.from(signature!, 'base64url'));
    expect(() => mac.verify(body + '.' + noncanonical)).toThrow();
  });
  it('rejects invalid keys, malformed/bounded tokens and nonfinite claims without exposing credentials', () => {
    for (const key of ['', '0'.repeat(64), '0x' + '0'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)])
      expect(() => createRecoveryAttestation(key)).toThrow();
    const mac = createRecoveryAttestation(secret);
    for (const token of ['', 'not.a-token', 'a'.repeat(400001), 'AAAA.' + 'a'.repeat(42)])
      expect(() => mac.verify(token)).toThrow();
    expect(() => mac.attest({ invalid: NaN })).toThrow();
    expect(() => mac.attest({ invalid: undefined })).toThrow();
  });
});
