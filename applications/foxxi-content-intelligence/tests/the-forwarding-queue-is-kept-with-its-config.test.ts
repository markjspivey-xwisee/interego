/**
 * What a forwarding target did not take is kept with the owner's config.
 *
 * ★ WHY. The last two memory-only stores in docs/operations/primary-state-rollout-hold.md.
 * - `forwarding-queue`: a statement a downstream LRS refused waited in a list in the process to be
 *   sent again. A restart emptied the list, and nothing would ever send it.
 * - `forwarding-config`: a config that was on the pod and could not be read (the pod answering 500,
 *   another key) was read as "none", and the next change wrote this process's copy over it; and a
 *   write that failed was logged and the caller told `ok`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveEncryptionKeyPair, type FetchFn } from '@interego/core';
import { persistForwardingConfig, readForwardingConfig, type ForwardingConfigBlob } from '../src/forwarding-persist.js';
import { addForwardingTarget, exportForwardingConfig, forwardStatement, importForwardingConfig, listForwardingTargets, markForwardingHydrated, onForwardingQueueChange, retryDeadLetter } from '../src/lrs-forwarding.js';
import type { TenantId } from '../src/tenant-context.js';

const KEY = deriveEncryptionKeyPair('33'.repeat(32));
const OTHER = deriveEncryptionKeyPair('44'.repeat(32));
const POD = 'https://pod.example/eth-abc/';
const URL_ = `${POD}foxxi-forwarding-config.json`;

function pod() {
  const bodies = new Map<string, string>();
  let failGet = 0;
  const fetch = (async (url: string | URL, init?: { method?: string; body?: string }) => {
    const u = String(url), method = init?.method ?? 'GET';
    const res = (status: number, body = '') => new Response(status === 204 ? null : body, { status });
    if (u.endsWith('/keys/encryption.json') || !u.startsWith(POD)) return res(404);
    if (method === 'GET') { if (failGet) return res(failGet); return bodies.has(u) ? res(200, bodies.get(u)!) : res(404); }
    if (method === 'PUT') { bodies.set(u, String(init?.body ?? '')); return res(201); }
    return res(405);
  }) as unknown as FetchFn;
  return { bodies, fetch, failGets: (status: number) => { failGet = status; } };
}

const BLOB: ForwardingConfigBlob = {
  targets: [{ id: 't1', label: 'Downstream', endpoint: 'https://lrs.example/xapi', credentials: 'key:secret', version: '2.0.0', enabled: true, createdAt: '2026-11-26T00:00:00.000Z' }],
  credentials: [], updatedAt: '2026-11-26T00:00:00.000Z',
};

describe('a kept forwarding config that cannot be read', () => {
  it('is told apart from none', async () => {
    const p = pod();
    expect(await readForwardingConfig({ ownerPod: POD, bridgeKp: KEY, fetch: p.fetch })).toEqual({ state: 'absent' });
    await persistForwardingConfig({ ownerPod: POD, blob: BLOB, bridgeKp: KEY, fetch: p.fetch });
    expect(p.bodies.get(URL_)).not.toContain('key:secret');
    expect(await readForwardingConfig({ ownerPod: POD, bridgeKp: KEY, fetch: p.fetch })).toMatchObject({ state: 'held', blob: { targets: [{ id: 't1', credentials: 'key:secret' }] } });
    // Another key, a pod that fails, and a body that is no config.
    expect(await readForwardingConfig({ ownerPod: POD, bridgeKp: OTHER, fetch: p.fetch })).toMatchObject({ state: 'unreadable' });
    p.failGets(500);
    expect(await readForwardingConfig({ ownerPod: POD, bridgeKp: KEY, fetch: p.fetch })).toMatchObject({ state: 'unreadable' });
    p.failGets(0);
    p.bodies.set(URL_, 'not an envelope');
    expect(await readForwardingConfig({ ownerPod: POD, bridgeKp: KEY, fetch: p.fetch })).toMatchObject({ state: 'unreadable' });
  });
});

describe('the queue of statements a target did not take', () => {
  const STMT = { id: '11111111-1111-4111-8111-111111111111', verb: { id: 'http://adlnet.gov/expapi/verbs/completed' } };

  it('goes out with the config, and comes back to a process that did not hold it', async () => {
    const a = 'lens:queue-a' as TenantId;
    markForwardingHydrated(a);
    // A target nothing answers at: every delivery fails and is queued.
    const t = addForwardingTarget(a, { endpoint: 'http://127.0.0.1:9/xapi', credentials: 'k:s' })!;
    const changed: string[] = [];
    onForwardingQueueChange((tenant) => { changed.push(String(tenant)); });
    await forwardStatement(a, STMT);
    expect(changed).toEqual([String(a)]);
    const blob = exportForwardingConfig(a);
    expect(blob.deadLetters).toMatchObject([{ targetId: t.id, statementId: STMT.id, statement: STMT }]);

    // Another process: the same config, read from the pod.
    const b = 'lens:queue-b' as TenantId;
    markForwardingHydrated(b);
    importForwardingConfig(b, JSON.parse(JSON.stringify(blob)));
    expect(listForwardingTargets(b)[0]!.metrics.deadLetterDepth).toBe(1);
    expect(exportForwardingConfig(b).deadLetters).toMatchObject([{ targetId: t.id, statementId: STMT.id }]);
    // And it is what a retry sends.
    const retried = await retryDeadLetter(b);
    expect(retried).toMatchObject([{ id: t.id, retried: 1 }]);
    onForwardingQueueChange(() => undefined);
  });

  it('is not replaced by an older kept copy in a process that already holds it', async () => {
    const a = 'lens:queue-c' as TenantId;
    markForwardingHydrated(a);
    addForwardingTarget(a, { endpoint: 'http://127.0.0.1:9/xapi', credentials: 'k:s' });
    const before = exportForwardingConfig(a);            // kept with an empty queue
    await forwardStatement(a, STMT);                     // then one is queued here
    importForwardingConfig(a, JSON.parse(JSON.stringify(before)));
    expect(exportForwardingConfig(a).deadLetters).toHaveLength(1);
  });

  it('takes nothing from a kept entry that is not one, or names another target', () => {
    const a = 'lens:queue-d' as TenantId;
    markForwardingHydrated(a);
    importForwardingConfig(a, { ...BLOB, deadLetters: [
      { targetId: 'someone-else', statementId: 'x', statement: {}, error: '', at: '' },
      { targetId: 't1', statementId: 5, statement: {} } as never,
      { targetId: 't1', statementId: 'ok', statement: { id: 'ok' }, error: 'HTTP 500', at: '2026-11-26T00:00:00.000Z' },
    ] });
    expect(exportForwardingConfig(a).deadLetters).toMatchObject([{ targetId: 't1', statementId: 'ok' }]);
  });

  it('says so when it changes on a retry too', async () => {
    const a = 'lens:queue-e' as TenantId;
    markForwardingHydrated(a);
    importForwardingConfig(a, { ...BLOB, deadLetters: [{ targetId: 't1', statementId: 'ok', statement: { id: 'ok' }, error: 'HTTP 500', at: '2026-11-26T00:00:00.000Z' }] });
    let n = 0; onForwardingQueueChange(() => { n++; });
    await retryDeadLetter(a);
    expect(n).toBe(1);
    onForwardingQueueChange(() => undefined);
  });
});

describe('the bridge', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  it('does not change a config it could not read, on either route', () => {
    expect(src.match(/if \(\(await hydrateOwnerForwarding\(ownerTenant, ownerPod\)\) === 'unreadable'\) \{ res\.status\(503\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/\n\s+await hydrateOwnerForwarding\(ownerTenant, ownerPod\);/);
  });
  it('says whether the pod took a change, and no longer answers ok over a failed write', () => {
    expect(src.match(/const durable = mutated \? await persistOwnerForwarding\(ownerTenant, ownerPod\) : true;/g)).toHaveLength(2);
    const persist = src.slice(src.indexOf('function persistOwnerForwarding'), src.indexOf('const forwardingQueuesToKeep'));
    expect(persist).toContain('if (!kp) return false;');
    expect(persist).toContain('return true; }');
  });
  // ★ Review of #1008. Two writes of one config could overlap (the debounced writer starts the
  // next while one is in flight), and the older one landing last put back a queue already sent.
  it('writes one owner\'s config one write at a time, each taking the config at its turn', () => {
    const persist = src.slice(src.indexOf('function persistOwnerForwarding'), src.indexOf('const forwardingQueuesToKeep'));
    expect(persist).toContain("const turn = (forwardingWrites.get(key) ?? Promise.resolve(true)).then(async () => {");
    expect(persist.indexOf('exportForwardingConfig(tenant)')).toBeGreaterThan(persist.indexOf('.then(async () => {'));
  });
  // ★ Review of #1008. A lens name does not always say the pod (an actor label, another origin):
  // the queue was written to the pod the name said, not the one the owner's config is on.
  it('writes the queue to the pod the owner was resolved to, and the name only says it otherwise', () => {
    const hydrate = src.slice(src.indexOf('async function hydrateOwnerForwarding'), src.indexOf('const forwardingOwnerPods'));
    expect(hydrate).toContain('rememberForwardingOwnerPod(tenant, ownerPod);');
    const of = src.slice(src.indexOf('function ownerPodOfLens'), src.indexOf('const forwardingWrites'));
    expect(of.indexOf('forwardingOwnerPods.get(String(tenant))')).toBeLessThan(of.indexOf("startsWith('lens:')"));
    expect(of.indexOf('forwardingOwnerPods.get(String(tenant))')).toBeGreaterThan(-1);
  });
  it('writes the config again when the queue changes, with retries', () => {
    const wire = src.slice(src.indexOf('const forwardingQueuesToKeep'), src.indexOf("app.get('/agent/forwarding/targets/affordance'"));
    expect(wire).toContain('const keepForwardingQueues = registryWriter(async () => {');
    expect(wire).toContain('if (ownerPod && !(await persistOwnerForwarding(tenant, ownerPod))) forwardingQueuesToKeep.add(tenant);');
    expect(wire).toContain('keepForwardingQueues();');
  });
});
