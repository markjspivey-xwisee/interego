import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { attachXapiLrsRoutes } from '../src/xapi-lrs.js';
import type { IRI } from '@interego/core';
let server: Server;
let base: string;
const headers = { Authorization: 'Bearer test-client', 'Content-Type': 'application/json', 'X-Experience-API-Version': '2.0.0' };
beforeAll(async () => {
  const app = express(); app.use(express.json());
  attachXapiLrsRoutes(app, { podUrl: '', tenantDid: 'did:web:conditions.test' as IRI, basicAuthPairs: '', forwardingTargets: '', selfBaseUrl: 'https://conditions.test', bearerTenantResolver: token => token === 'test-client' ? 'document-conditions-test' : null });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
async function document(): Promise<{ url: string; etag: string }> {
  const url = `${base}/xapi/activities/profile?${new URLSearchParams({ activityId: 'https://conditions.test/course', profileId: randomUUID() })}`;
  const result = await fetch(url, { method: 'PUT', headers, body: '{"original":true}' });
  expect(result.status).toBe(204); return { url, etag: result.headers.get('etag')! };
}
describe('document preconditions use entity-tag semantics at the mutation boundary', () => {
  it.each(['PUT', 'POST', 'DELETE'])('%s refuses matching If-None-Match lists with weak tags, retaining the old document', async method => {
    const { url, etag } = await document();
    const result = await fetch(url, { method, headers: { ...headers, 'If-None-Match': `"other", W/${etag}` }, ...(method === 'DELETE' ? {} : { body: '{"changed":true}' }) });
    expect(result.status).toBe(412); expect(await (await fetch(url, { headers })).json()).toEqual({ original: true });
  });
  it.each(['PUT', 'POST', 'DELETE'])('%s accepts If-Match:* for an existing resource and rejects a weak-only match', async method => {
    const { url, etag } = await document();
    const update = (condition: string) => fetch(url, { method, headers: { ...headers, 'If-Match': condition }, ...(method === 'DELETE' ? {} : { body: '{"changed":true}' }) });
    expect((await update(`W/${etag}`)).status).toBe(412);
    expect((await update('*')).status).toBe(204);
  });
  it('accepts a matching strong tag in an If-Match list and returns GET/HEAD 304 for weak If-None-Match lists', async () => {
    const { url, etag } = await document();
    for (const method of ['GET', 'HEAD']) expect((await fetch(url, { method, headers: { ...headers, 'If-None-Match': `"other", W/${etag}` } })).status).toBe(304);
    expect((await fetch(url, { method: 'PUT', headers: { ...headers, 'If-Match': `"other", ${etag}` }, body: '{}' })).status).toBe(204);
  });
  it('rejects If-Match:* on absent resources and allows If-None-Match:* only on creation', async () => {
    const { url, etag } = await document();
    expect((await fetch(url, { method: 'DELETE', headers: { ...headers, 'If-Match': etag } })).status).toBe(204);
    expect((await fetch(url, { method: 'PUT', headers: { ...headers, 'If-Match': '*' }, body: '{}' })).status).toBe(412);
    expect((await fetch(url, { method: 'PUT', headers: { ...headers, 'If-None-Match': '*' }, body: '{}' })).status).toBe(204);
    expect((await fetch(url, { method: 'PUT', headers: { ...headers, 'If-None-Match': '*' }, body: '{}' })).status).toBe(412);
  });
});
describe('HTTP statement limits are bounded before querying storage', () => {
  it.each(['0.5', '-1', 'NaN', 'Infinity', '9007199254740992'])('rejects unsafe limit %s', async limit => {
    expect((await fetch(`${base}/xapi/statements?${new URLSearchParams({ limit })}`, { headers })).status).toBe(400);
  });
  it.each([0.5, -1, '2', null, 9007199254740992])('rejects malformed resumed query limit %j', async limit => {
    const token = Buffer.from(JSON.stringify({ offset: 0, q: { limit } })).toString('base64url');
    expect((await fetch(`${base}/xapi/statements?continuationToken=${token}`, { headers })).status).toBe(400);
  });
});
