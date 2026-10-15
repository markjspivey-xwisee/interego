import test from 'node:test';
import assert from 'node:assert/strict';
import { readOriginalThroughExistingHttp } from './http-read-original.mjs';

const original = { id: '00000000-0000-4000-8000-000000000001', stored: '2026-10-15T20:00:00.000Z', authority: { account: { name: 'original' } } };
const source = { records: [{ tenant: 'default', id: original.id, original: { statement: original, voided: false } }] };
test('absent or mismatched configured credentials skip without any request or creation', async () => {
  const noFetch = () => { throw new Error('unexpected network'); };
  assert.equal((await readOriginalThroughExistingHttp(source, {}, noFetch)).skipped, true);
  assert.equal((await readOriginalThroughExistingHttp(source, { FOXXI_LRS_BASIC_AUTH_PAIRS: 'existing:secret:another-tenant' }, noFetch)).skipped, true);
});
test('existing configured credential reads an original through loopback GET with exact response verification and boolean-only output', async () => {
  const report = await readOriginalThroughExistingHttp(source, { FOXXI_LRS_BASIC_AUTH_PAIRS: 'existing:secret', PORT: '6080' }, async (url, init) => {
    assert.equal(url.origin, 'http://127.0.0.1:6080'); assert.equal(url.searchParams.get('statementId'), original.id);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.headers.Authorization, 'Basic ' + Buffer.from('existing:secret').toString('base64'));
    return new Response(JSON.stringify(original), { headers: { 'Last-Modified': new Date(original.stored).toUTCString(), 'X-Experience-API-Version': '2.0.0' } });
  });
  assert.equal(report.httpOriginalReadVerified, true); assert.ok(Object.values(report).every(value => typeof value === 'boolean'));
});
test('HTTP auth refusal or changed original fails instead of becoming a skip', async () => {
  const env = { FOXXI_LRS_BASIC_AUTH_PAIRS: 'existing:secret' };
  await assert.rejects(readOriginalThroughExistingHttp(source, env, async () => new Response('{}', { status: 401 })), /refused/);
  await assert.rejects(readOriginalThroughExistingHttp(source, env, async () => new Response(JSON.stringify({ ...original, stored: 'changed' }))), /fidelity/);
});
