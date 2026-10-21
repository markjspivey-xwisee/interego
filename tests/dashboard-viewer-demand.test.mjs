import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../examples/dashboard/polling-demand.ts', import.meta.url), 'utf8');
const { clientDemandPoller } = await import('data:text/javascript;base64,' +
  Buffer.from(stripTypeScriptTypes(source)).toString('base64'));

test('startup and timer refreshes make zero reads without dashboard viewers', async () => {
  let reads = 0;
  const poll = clientDemandPoller(async () => { reads++; }, () => 0);
  await poll();
  await Promise.all(Array.from({ length: 20 }, () => poll()));
  assert.equal(reads, 0);
});

test('first view and concurrent refreshes share one collection; disconnect makes it idle', async () => {
  let viewers = 0, reads = 0, finish;
  const poll = clientDemandPoller(async () => {
    reads++;
    await new Promise(resolve => { finish = resolve; });
  }, () => viewers);
  viewers = 1;
  const first = poll();
  const timer = poll();
  assert.equal(first, timer);
  await Promise.resolve();
  assert.equal(reads, 1);
  viewers = 0;
  await poll();
  assert.equal(reads, 1);
  viewers = 1;
  assert.equal(poll(), first, 'reconnect during the existing refresh reuses its work');
  finish();
  await first;
  viewers = 0;
  await poll();
  assert.equal(reads, 1);
  viewers = 1;
  const next = poll();
  await Promise.resolve();
  assert.equal(reads, 2, 'reconnect after completion gets one fresh collection');
  finish();
  await next;
});

test('a view closed before its refresh microtask starts causes no reads', async () => {
  let viewers = 1, reads = 0;
  const poll = clientDemandPoller(async () => { reads++; }, () => viewers);
  const pending = poll();
  viewers = 0;
  await pending;
  assert.equal(reads, 0);
});

test('failed collection does not latch a permanent in-flight refresh', async () => {
  let attempts = 0;
  const poll = clientDemandPoller(async () => {
    if (++attempts === 1) throw new Error('unreachable pod');
  }, () => 1);
  await assert.rejects(poll(), /unreachable pod/);
  await poll();
  assert.equal(attempts, 2);
});
