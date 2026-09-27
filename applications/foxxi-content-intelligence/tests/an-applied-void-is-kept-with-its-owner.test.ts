/**
 * A void the LRS applied is kept with the voided statement's owner, so it holds after the lens that
 * applied it forgets it.
 *
 * A lens tenant's store is a view: the process-wide budget evicts its oldest records, a dropped
 * partition takes all of them, and a restart takes everything, while the voided statement's copies
 * in the owner's lattice and on their pod outlive it. The void is decided once, by the store, as the
 * voiding statement arrives: so the LRS tells the bridge only of a void that took effect, and the
 * bridge keeps that fact beside the owner's statements (foxxi:AppliedVoid), which every merge of
 * their record reads. A voiding statement that took no effect is never kept, and never replayed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IRI } from '@interego/core';
import { attachXapiLrsRoutes } from '../src/xapi-lrs.js';
import type { StoredStatement } from '../src/statement-store.js';
import type { TenantId } from '../src/tenant-context.js';
import { mergeStatementsById, type StoredStatementLike } from '../src/durable-records.js';
import { lookupTerm } from '../src/foxxi-vocab.js';
import { APPLIED_VOID_TYPE, appliedVoidRecord, appliedVoidsIn, ownerDidOf } from '../src/applied-voids.js';

const tenant = 'lens:an-applied-void-is-kept' as TenantId;
const owner = 'did:ethr:0x3333333333cc00000000000000000000000beef3';
const applied: Array<{ target: StoredStatement; voidingStatementId: string; tenant: TenantId }> = [];

let server: Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  attachXapiLrsRoutes(app, {
    podUrl: '', tenantDid: 'did:web:bridge.example' as IRI, basicAuthPairs: '', forwardingTargets: '', selfBaseUrl: 'http://127.0.0.1',
    // A writer bound to no registration, as a Basic-auth one is: the store voids whatever it names.
    bearerTenantResolver: token => (token === 'unbound-writer' ? tenant : null),
    onVoidApplied: (target, voidingStatementId, t) => { applied.push({ target, voidingStatementId, tenant: t }); },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

const headers = { Authorization: 'Bearer unbound-writer', 'X-Experience-API-Version': '2.0.0', 'Content-Type': 'application/json' };
const post = (body: unknown) => fetch(`${base}/xapi/statements`, { method: 'POST', headers, body: JSON.stringify(body) });
const put = (id: string, body: unknown) => fetch(`${base}/xapi/statements?statementId=${id}`, { method: 'PUT', headers, body: JSON.stringify(body) });
const get = (id: string) => fetch(`${base}/xapi/statements?statementId=${id}`, { headers });
const statement = (extra: Record<string, unknown> = {}) => ({
  id: randomUUID(), actor: { objectType: 'Agent', account: { homePage: 'https://bridge.example', name: owner } },
  verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' }, object: { objectType: 'Activity', id: 'https://bridge.example/ns/foxxi/fragment/x' }, ...extra,
});
const voiding = (target: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(), actor: { objectType: 'Agent', account: { homePage: 'https://bridge.example', name: owner } },
  verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: target }, ...extra,
});

describe('a voiding statement refused as a conflict voids nothing', () => {
  it('neither in the store nor with the owner, posted or put', async () => {
    applied.length = 0;
    const target = statement();
    const taken = statement();
    expect((await post(target)).status).toBe(200);
    expect((await post(taken)).status).toBe(200);
    // Another body under an id already taken: refused, so it voids nothing.
    expect((await post({ ...voiding(target.id), id: taken.id })).status).toBe(409);
    expect((await put(taken.id, { ...voiding(target.id), id: taken.id })).status).toBe(409);
    expect(applied).toEqual([]);
    expect((await get(target.id)).status).toBe(200);
  });
});

describe('the LRS tells of a void only once it took effect', () => {
  it('tells of a void applied, with the statement it voided, marked, and the voiding statement', async () => {
    const s = statement({ context: { registration: randomUUID() } });
    expect((await post(s)).status).toBe(200);
    const v = voiding(s.id, { context: { registration: randomUUID() } });   // another registration, and no writer bound to one
    expect((await post(v)).status).toBe(200);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ voidingStatementId: v.id, tenant, target: { id: s.id, voided: true } });
  });

  it('tells of nothing for a voider stored before its target, nor when the target comes', async () => {
    applied.length = 0;
    const later = statement();
    expect((await post(voiding(later.id))).status).toBe(200);
    expect((await post(later)).status).toBe(200);
    expect(applied).toEqual([]);
  });

  it('tells of nothing for a voiding statement named by another', async () => {
    applied.length = 0;
    const s = statement();
    expect((await post(s)).status).toBe(200);
    const v = voiding(s.id);
    expect((await post(v)).status).toBe(200);
    applied.length = 0;
    expect((await post(voiding(v.id))).status).toBe(200);
    expect(applied).toEqual([]);
  });
});

describe('a merge of the record reads the voids kept with it', () => {
  const s = statement();
  const copy = (x: Record<string, unknown>, voided = false): StoredStatementLike => ({ id: String(x.id), statement: x, stored: '', voided });

  it('keeps a statement voided once the store that voided it has let it go, the voider still held', () => {
    const lattice = copy(s);
    const voider = copy(voiding(s.id));
    expect(mergeStatementsById([lattice, voider], []).filter(r => r.voided)).toEqual([]);   // what the store alone no longer says
    const merged = mergeStatementsById([lattice, voider], [], new Set([s.id]));
    expect(merged.filter(r => r.voided).map(r => r.id)).toEqual([s.id]);
    expect(lattice.voided).toBe(false);
  });

  it('keeps it voided from its pod copy too, and voids nothing it does not name', () => {
    const other = statement();
    const merged = mergeStatementsById([], [s, other], new Set([s.id]));
    expect(merged.filter(r => r.voided).map(r => r.id)).toEqual([s.id]);
  });
});

describe("an applied void, as the owner's lattice keeps it", () => {
  it("names its owner by the DID the voided statement's actor carries, and no one else", () => {
    expect(ownerDidOf(statement())).toBe(owner);
    expect(ownerDidOf({ actor: { account: { name: 'jliu' } } })).toBeUndefined();
    expect(ownerDidOf({ actor: { mbox: 'mailto:someone@example.com' } })).toBeUndefined();
    expect(ownerDidOf({})).toBeUndefined();
  });

  it('is read back as the statements voided, passing over anything else kept under its type', () => {
    const kept = [
      { content: appliedVoidRecord('a', 'v1') }, { content: appliedVoidRecord('b', 'v2') }, { content: appliedVoidRecord('a', 'v3') },
      { content: { statementId: 7 } }, { content: null }, { content: { statementId: '' } },
    ];
    expect([...appliedVoidsIn(kept)]).toEqual(['a', 'b']);
    expect(appliedVoidRecord('a', 'v1')).toEqual({ statementId: 'a', voidedBy: 'v1' });
    expect(APPLIED_VOID_TYPE).toBe('foxxi:AppliedVoid');
  });
});

describe('the bridge keeps each applied void with its owner, and reads it in every merge', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');

  it('keeps it in the owner\'s lattice, as an applied void, beside their statements', () => {
    expect(src).toMatch(/onVoidApplied: \(target, voidingStatementId\) => \{ void keepAppliedVoid\(target\.statement, voidingStatementId\); \},/);
    const keep = src.slice(src.indexOf('async function keepAppliedVoid'), src.indexOf('\n}\n', src.indexOf('async function keepAppliedVoid')));
    expect(keep).toMatch(/if \(!tenantPodUrl \|\| !sameStore\(pod, tenantPodUrl\)\) return;/);
    expect(keep).toMatch(/content: appliedVoidRecord\(statementId, voidingStatementId\), contentType: APPLIED_VOID_TYPE/);
    expect(src).toMatch(/return appliedVoidsIn\(latticeArtifacts\(label, APPLIED_VOID_TYPE\)\);/);
    expect(lookupTerm('AppliedVoid')).toBeDefined();
  });

  it('passes what the owner\'s lattice keeps to every merge of a record', () => {
    // Each call's arguments, read to its own closing parenthesis.
    const calls: string[] = [];
    for (let at = src.indexOf('mergeStatementsById('); at >= 0; at = src.indexOf('mergeStatementsById(', at + 1)) {
      let depth = 0;
      let end = at + 'mergeStatementsById'.length;
      for (; end < src.length; end++) {
        if (src[end] === '(') depth++;
        else if (src[end] === ')' && --depth === 0) break;
      }
      calls.push(src.slice(at + 'mergeStatementsById('.length, end));
    }
    expect(calls.length).toBeGreaterThanOrEqual(8);   // seven merges, and the lattice read alone
    for (const call of calls) expect(call).toMatch(/appliedVoidsOf\(\w+\)\s*,?\s*$/);
  });
});
