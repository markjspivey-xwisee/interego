/** Isolated process fixture: real configured primary and HTTP routes, with explicit test-only failure gates. */
import express from 'express';
import { attachXapiLrsRoutes } from '../../src/xapi-lrs.js';
import { attachXapiAdminRoutes } from '../../src/xapi-admin.js';
import { deriveUserWallet } from '../../src/auth.js';
import { readyStatementStore } from '../../src/statement-store.js';
import { PostgresLrsStore } from '../../src/postgres-lrs-store.js';
import type { TenantId } from '../../src/tenant-context.js';
import type { IRI } from '@interego/core';

let gate: 'statement' | 'resource' | 'fail-statement' | 'fail-resource' | undefined;
let release: (() => void) | undefined;
async function beforeWrite(kind: 'statement' | 'resource'): Promise<void> {
  const current = gate;
  if (current !== kind && current !== `fail-${kind}`) return;
  gate = undefined;
  process.send?.({ event: 'entered', kind });
  if (current.startsWith('fail-')) throw new Error('private database failure: do not disclose');
  await new Promise<void>(resolve => { release = resolve; });
}
const put = PostgresLrsStore.prototype.putWithAttachments;
PostgresLrsStore.prototype.putWithAttachments = async function (...args) {
  await beforeWrite('statement');
  await put.apply(this, args);
};
const update = PostgresLrsStore.prototype.updateResource;
PostgresLrsStore.prototype.updateResource = async function <T, R>(kind: string, id: string, mutate: (current: T | null) => { value: T | null; result: R }): Promise<R> {
  await beforeWrite('resource');
  const bound = update.bind(this) as typeof update;
  return bound<T, R>(kind, id, mutate);
};
process.on('message', (message: { command?: string; id?: number }) => {
  if (message.command === 'release') { release?.(); release = undefined; }
  else if (['statement', 'resource', 'fail-statement', 'fail-resource'].includes(message.command ?? '')) gate = message.command as typeof gate;
  process.send?.({ event: 'configured', id: message.id });
});
await readyStatementStore();
const app = express();
app.use(express.json());
attachXapiLrsRoutes(app, {
  podUrl: '', tenantDid: 'did:web:durable.test' as IRI, basicAuthPairs: '', forwardingTargets: '', selfBaseUrl: 'https://durable.test',
  bearerTenantResolver: token => token === 'alice' ? process.env.LRS_TEST_ALICE as TenantId : token === 'bob' ? process.env.LRS_TEST_BOB as TenantId : null,
});
attachXapiAdminRoutes(app, {
  adminWebId: 'https://pod.test/durable-admin/profile/card#me', learningEngineerWebIds: new Set(),
  selfBaseUrl: 'https://durable.test', basicAuthPairs: '', forwardingTargets: '',
  loadUsers: () => [{ user_id: 'durable-admin', web_id: 'https://pod.test/durable-admin/profile/card#me',
    wallet_address: deriveUserWallet('durable-admin', 'durable-http-admin-synthetic-seed').address }],
});
const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ event: 'ready', port: address.port });
});
