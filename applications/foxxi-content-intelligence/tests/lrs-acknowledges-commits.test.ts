import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { attachXapiAdminRoutes } from '../src/xapi-admin.js';
import { deriveUserWallet, mintSessionToken } from '../src/auth.js';
import { readFileSync } from 'node:fs';
import { assertLrsPrimaryConfiguration, createStatementStore, isProductionLrsEnvironment } from '../src/statement-store.js';
import { getStatementStore } from '../src/xapi-lrs.js';
import { emitAffordanceStatement } from '../src/xapi-instrumentation.js';
import { buildCmi5Launch, learnerSatisfiedAus, observeCmi5Statement, registerCmi5Course } from '../src/cmi5-lms.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
describe('the LRS primary cannot silently become volatile', () => {
  it.each([
    { NODE_ENV: 'production' }, { RAILWAY_ENVIRONMENT_NAME: 'production' },
    { RAILWAY_ENVIRONMENT_ID: 'environment-id' }, { RAILWAY_SERVICE_ID: 'service-id' },
  ])('refuses a volatile primary on deployed infrastructure %j', env => {
    expect(isProductionLrsEnvironment(env)).toBe(true);
    expect(() => assertLrsPrimaryConfiguration({ ...env, FOXXI_LRS_BACKEND: 'memory', FOXXI_LRS_MEMORY_TENANTS: 'default', FOXXI_LRS_MEMORY_TENANT_PREFIXES: 'lens:' })).toThrow(/requires.*postgres/);
    expect(() => assertLrsPrimaryConfiguration({ ...env, FOXXI_LRS_BACKEND: 'file:/tmp/lrs' })).toThrow(/requires.*postgres/);
  });
  it('requires a stable operator key and DB connection without disclosing their values', () => {
    expect(() => assertLrsPrimaryConfiguration({ NODE_ENV: 'production', FOXXI_LRS_BACKEND: 'postgres' })).toThrow(/requires FOXXI_LRS_POSTGRES_URL/);
    expect(() => assertLrsPrimaryConfiguration({ NODE_ENV: 'production', FOXXI_LRS_BACKEND: 'postgres', DATABASE_URL: 'postgres://private-credentials@db/test' })).toThrow(/stable encryption key/);
    expect(() => assertLrsPrimaryConfiguration({ NODE_ENV: 'production', FOXXI_LRS_BACKEND: 'postgres', DATABASE_URL: 'postgres://private-credentials@db/test', FOXXI_BRIDGE_PRIVATE_KEY: 'a'.repeat(64) })).not.toThrow();
  });
  it('refuses a per-call memory override even when the configured deployed primary is durable', () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('FOXXI_LRS_BACKEND', 'postgres');
    vi.stubEnv('FOXXI_LRS_POSTGRES_URL', 'postgres://unused.test/db'); vi.stubEnv('FOXXI_LRS_ENCRYPTION_KEY', 'a'.repeat(64));
    try { expect(() => createStatementStore('memory', 'lens:alice')).toThrow(/cannot override/); }
    finally { vi.unstubAllEnvs(); }
  });
  it('counts tenants without decrypting their full learning histories', async () => {
    const store = getStatementStore();
    const list = vi.spyOn(store, 'listAll').mockRejectedValue(new Error('count endpoint must not materialize learner records'));
    const count = vi.spyOn(store, 'count').mockResolvedValue(42);
    const seed = 'synthetic-admin-count-test-seed';
    const admin = { userId: 'count-admin', webId: 'https://pod.test/count-admin/profile/card#me' };
    const app = express();
    attachXapiAdminRoutes(app, { adminWebId: admin.webId, learningEngineerWebIds: new Set(), selfBaseUrl: 'https://bridge.test', basicAuthPairs: '', forwardingTargets: '',
      loadUsers: () => [{ user_id: admin.userId, web_id: admin.webId, wallet_address: deriveUserWallet(admin.userId, seed).address }] });
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const token = await mintSessionToken({ ...admin, seed });
      const result = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/xapi/admin/tenants`, { headers: { Authorization: `Bearer ${token}` } });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ tenants: [{ tenant: 'default', count: 42 }] });
      expect(count).toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); list.mockRestore(); count.mockRestore(); }
  });
  it('starts the listener only after primary readiness and never registers public snapshots for PG documents', () => {
    const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    const lrs = readFileSync(new URL('../src/xapi-lrs.ts', import.meta.url), 'utf8');
    const readyAt = server.indexOf('await readyStatementStore();');
    const listenAt = server.search(/app\.listen\s*\(\s*PORT/);
    expect(readyAt).toBeGreaterThanOrEqual(0);
    expect(listenAt).toBeGreaterThanOrEqual(0);
    expect(readyAt).toBeLessThan(listenAt);
    expect(lrs).not.toContain('FOXXI_LRS_MEMORY_TENANT_PREFIXES');
    expect(lrs).toContain("if (configuredLrsBackend() !== 'postgres') {\n  registerXapiDocsSnapshot");
  });
});
describe('generated evidence is acknowledged after its primary write', () => {
  it('does not return an instrumentation statement ID until the store put resolves', async () => {
    const store = getStatementStore();
    const gate = deferred(); const entered = deferred();
    const original = store.put.bind(store);
    const spy = vi.spyOn(store, 'put').mockImplementation(async record => { entered.resolve(); await gate.promise; await original(record); });
    try {
      let finished = false;
      const emission = emitAffordanceStatement({ toolName: 'lookup', caller: { role: 'learner' }, args: {}, result: undefined, duration: 1, isError: false, selfBaseUrl: 'https://bridge.example' }).then(id => { finished = true; return id; });
      await entered.promise; expect(finished).toBe(false);
      gate.resolve(); const id = await emission; expect(id).toBeTypeOf('string'); expect(await store.get(id!)).not.toBeNull();
    } finally { gate.resolve(); spy.mockRestore(); }
  });
  it('leaves cmi5 satisfaction retryable when its evidence write fails, then waits before marking it satisfied', async () => {
    const tenant = 'lens:commit-order';
    const learner = { id: 'did:web:learner.example' };
    const launch = buildCmi5Launch({ au: { id: 'https://bridge.example/au/commit', url: 'https://bridge.example/content/commit', moveOn: 'Completed' }, learner,
      lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch', authoritativeSource: 'https://bridge.example', tenant });
    const completed = { actor: launch.actor, verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: 'https://bridge.example/au/commit' }, context: { registration: launch.registration } };
    await expect(observeCmi5Statement(completed, tenant, { statementsForRegistration: async () => [completed], emit: async () => { throw new Error('primary unavailable'); } })).rejects.toThrow('primary unavailable');
    expect(learnerSatisfiedAus(tenant, learner.id)).not.toContain('https://bridge.example/au/commit');
    const gate = deferred(); const entered = deferred();
    const observation = observeCmi5Statement(completed, tenant, { statementsForRegistration: async () => [completed], emit: async () => { entered.resolve(); await gate.promise; } });
    await entered.promise; expect(learnerSatisfiedAus(tenant, learner.id)).not.toContain('https://bridge.example/au/commit');
    gate.resolve(); expect(await observation).toMatchObject({ satisfied: true, emittedSatisfied: true });
    expect(learnerSatisfiedAus(tenant, learner.id)).toContain('https://bridge.example/au/commit');
  });
  it('serializes concurrent course rollups while their evidence write is pending', async () => {
    const tenant = 'lens:rollup-commit-order';
    const learner = { id: 'did:web:rollup-learner.example' };
    const au = { kind: 'au' as const, id: 'https://bridge.example/au/rollup', url: 'https://bridge.example/content/rollup', moveOn: 'Completed' as const, title: 'AU' };
    const courseId = 'https://bridge.example/course/rollup';
    registerCmi5Course(tenant, { id: courseId, title: 'One AU', structure: [au] });
    const makeLaunch = () => buildCmi5Launch({ au, learner, courseId, tenant, lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch', authoritativeSource: 'https://bridge.example' });
    const launches = [makeLaunch(), makeLaunch()];
    const statements = launches.map(launch => ({ actor: launch.actor, verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: au.id }, context: { registration: launch.registration } }));
    const courseEntered = deferred(); const bothAus = deferred(); const gate = deferred();
    let courseEmits = 0; let auEmits = 0;
    const emit = async (statement: Record<string, unknown>): Promise<void> => {
      if ((statement.object as { id?: string }).id === courseId) { courseEmits++; courseEntered.resolve(); await gate.promise; }
      else if (++auEmits === 2) bothAus.resolve();
    };
    const observations = statements.map(statement => observeCmi5Statement(statement, tenant, { statementsForRegistration: async () => statements, emit }));
    try {
      await Promise.all([courseEntered.promise, bothAus.promise]);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(courseEmits).toBe(1);
    } finally { gate.resolve(); await Promise.all(observations); }
    expect(courseEmits).toBe(1); expect(auEmits).toBe(2);
  });

  it('emits one AU satisfaction for concurrent observations of the same registration', async () => {
    const tenant = 'lens:registration-commit-order';
    const launch = buildCmi5Launch({ au: { id: 'https://bridge.example/au/once', url: 'https://bridge.example/content/once', moveOn: 'Completed' }, learner: { id: 'did:web:once-learner.example' },
      lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch', authoritativeSource: 'https://bridge.example', tenant });
    const completed = { actor: launch.actor, verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: 'https://bridge.example/au/once' }, context: { registration: launch.registration } };
    const gate = deferred(); const entered = deferred(); let emissions = 0;
    const deps = { statementsForRegistration: async () => [completed], emit: async () => { emissions++; entered.resolve(); await gate.promise; } };
    const observations = [observeCmi5Statement(completed, tenant, deps), observeCmi5Statement(completed, tenant, deps)];
    try { await entered.promise; await new Promise<void>(resolve => setImmediate(resolve)); expect(emissions).toBe(1); }
    finally { gate.resolve(); await Promise.all(observations); }
    expect(emissions).toBe(1);
  });
  it('retries a failed course evidence commit without repeating its committed AU evidence', async () => {
    const tenant = 'lens:course-retry'; const learner = { id: 'did:web:course-retry-learner.example' };
    const au = { kind: 'au' as const, id: 'https://bridge.example/au/retry', url: 'https://bridge.example/content/retry', moveOn: 'Completed' as const, title: 'AU' };
    const courseId = 'https://bridge.example/course/retry';
    registerCmi5Course(tenant, { id: courseId, title: 'Retry', structure: [au] });
    const launch = buildCmi5Launch({ au, learner, courseId, tenant, lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch', authoritativeSource: 'https://bridge.example' });
    const completed = { actor: launch.actor, verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: au.id }, context: { registration: launch.registration } };
    let courseAttempts = 0; let auEmits = 0;
    const deps = { statementsForRegistration: async () => [completed], emit: async (statement: Record<string, unknown>) => {
      if ((statement.object as { id?: string }).id === courseId) { if (++courseAttempts === 1) throw new Error('course commit failed'); }
      else auEmits++;
    } };
    await expect(observeCmi5Statement(completed, tenant, deps)).rejects.toThrow('course commit failed');
    expect(await observeCmi5Statement(completed, tenant, deps)).toMatchObject({ satisfied: true, emittedSatisfied: false });
    expect(courseAttempts).toBe(2); expect(auEmits).toBe(1);
  });

});
