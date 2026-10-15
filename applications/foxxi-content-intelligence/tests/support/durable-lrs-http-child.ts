/** Isolated process fixture: real configured primary and HTTP routes, with explicit test-only failure gates. */
import express from 'express';
import { attachXapiLrsRoutes } from '../../src/xapi-lrs.js';
import { attachCmi5LmsRoutes } from '../../src/cmi5-lms.js';
import { attachXapiAdminRoutes } from '../../src/xapi-admin.js';
import { deriveUserWallet } from '../../src/auth.js';
import { InMemoryStatementStore, readyStatementStore } from '../../src/statement-store.js';
import { NativeInteregoLrsStore } from '../../src/native-lrs-store.js';
import type { TenantId } from '../../src/tenant-context.js';
import type { IRI } from '@interego/core';

const callbacks: Array<{ id: string; statement: Record<string, unknown> }> = [];
const voidCallbacks: Array<{ target: string; voidingId: string }> = [];
let forwardChecks = 0;
let gate: 'statement' | 'resource' | 'fail-statement' | 'fail-resource' | undefined;
let release: (() => void) | undefined;
async function beforeWrite(kind: 'statement' | 'resource'): Promise<void> {
  const current = gate;
  if (current !== kind && current !== `fail-${kind}`) return;
  gate = undefined;
  process.send?.({ event: 'entered', kind });
  if (current.startsWith('fail-')) throw new Error('private native storage failure: do not disclose');
  await new Promise<void>(resolve => { release = resolve; });
}
const memoryPut = InMemoryStatementStore.prototype.put;
InMemoryStatementStore.prototype.put = async function (record) {
  await beforeWrite('statement');
  await memoryPut.call(this, record);
};
const put = NativeInteregoLrsStore.prototype.putBatchWithAttachments;
NativeInteregoLrsStore.prototype.putBatchWithAttachments = async function (...args) {
  await beforeWrite('statement');
  return put.apply(this, args);
};
const update = NativeInteregoLrsStore.prototype.updateResource;
NativeInteregoLrsStore.prototype.updateResource = async function <T, R>(kind: string, id: string, mutate: (current: T | null) => { value: T | null; result: R }): Promise<R> {
  await beforeWrite('resource');
  const bound = update.bind(this) as typeof update;
  return bound<T, R>(kind, id, mutate);
};
process.on('message', (message: { command?: string; id?: number }) => {
  if (message.command === 'callbacks') { process.send?.({ event: 'callbacks', id: message.id, callbacks, voidCallbacks, forwardChecks }); return; }
  if (message.command === 'release') { release?.(); release = undefined; }
  else if (['statement', 'resource', 'fail-statement', 'fail-resource'].includes(message.command ?? '')) gate = message.command as typeof gate;
  process.send?.({ event: 'configured', id: message.id });
});
await readyStatementStore();
const app = express();
app.use(express.json());
attachXapiLrsRoutes(app, {
  onStatementStored: statement => { callbacks.push({ id: String(statement.id), statement: structuredClone(statement) }); },
  onVoidApplied: (target, voidingId) => { voidCallbacks.push({ target: target.id, voidingId }); },
  ownerTenantOfStatement: () => { forwardChecks++; return null; },
  podUrl: '', tenantDid: 'did:web:durable.test' as IRI, basicAuthPairs: '', forwardingTargets: '', selfBaseUrl: 'https://durable.test',
  bearerRegistrationResolver: token => token.startsWith('alice-reg:') ? token.slice('alice-reg:'.length) : null,
  bearerTenantResolver: token => token === 'alice' || token.startsWith('alice-reg:') ? process.env.LRS_TEST_ALICE as TenantId : token === 'bob' ? process.env.LRS_TEST_BOB as TenantId : null,
});
attachXapiAdminRoutes(app, {
  adminWebId: 'https://pod.test/durable-admin/profile/card#me', learningEngineerWebIds: new Set(),
  selfBaseUrl: 'https://durable.test', basicAuthPairs: '', forwardingTargets: '',
  loadUsers: () => [{ user_id: 'durable-admin', web_id: 'https://pod.test/durable-admin/profile/card#me',
    wallet_address: deriveUserWallet('durable-admin', 'durable-http-admin-synthetic-seed').address }],
});
attachCmi5LmsRoutes(app, {
  authoritativeSource: 'https://durable.test', selfBaseUrl: 'https://durable.test',
  adminWebId: 'https://pod.test/durable-admin/profile/card#me', learningEngineerWebIds: new Set(),
  loadUsers: () => [{ user_id: 'durable-admin', web_id: 'https://pod.test/durable-admin/profile/card#me',
    wallet_address: deriveUserWallet('durable-admin', 'durable-http-admin-synthetic-seed').address }],
});
const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ event: 'ready', port: address.port });
});
