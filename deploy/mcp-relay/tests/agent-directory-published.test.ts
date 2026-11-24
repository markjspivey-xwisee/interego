#!/usr/bin/env tsx
/**
 * A real publish, then a GET of the card IRI.
 *
 * The directory's own tests fake publish. This one uses @interego/solid's
 * publish against an in-memory pod and the relay's shipped /ns route, so the
 * bytes a reader gets are the bytes that were written.
 */
import express from 'express';
import { publish } from '@interego/solid';
import { ContextDescriptor, type IRI } from '@interego/core';
import { cardTurtle, type PublicAgentCard } from '../agent-directory.js';
import { createNsDereference } from '../ns-dereference.js';
import { corsMiddleware } from '../cors-allowlist.js';
import { listenLoopback } from './listen-loopback.js';

const AGENT = 'u-pk-33d42e6b33dc';
const CSS = 'https://pod.example/';
const POD = `${CSS}${AGENT}/`;
const BASE = 'https://relay.test';
const CARD = `${BASE}/ns/${AGENT}/agent-card`;

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const files = new Map<string, string>();
const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
  const method = init?.method ?? 'GET';
  if (method === 'PUT') {
    files.set(url, init?.body ?? '');
    return { ok: true, status: 201, statusText: 'Created', headers: { get: () => null }, text: async () => '', json: async () => ({}) };
  }
  if (method === 'HEAD') {
    const hit = files.has(url);
    return { ok: hit, status: hit ? 200 : 404, statusText: hit ? 'OK' : 'Not Found', headers: { get: () => null }, text: async () => '', json: async () => ({}) };
  }
  const body = files.get(url);
  if (body === undefined) {
    return { ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null }, text: async () => '', json: async () => ({}) };
  }
  return { ok: true, status: 200, statusText: 'OK', headers: { get: () => 'text/turtle' }, text: async () => body, json: async () => ({}) };
};

console.log('\na published directory card dereferences at its IRI');

const card: PublicAgentCard = {
  agentId: AGENT,
  name: 'Georgio',
  description: 'Reviews drafts.',
  cardIri: CARD,
  relayAddress: `${BASE}/agents/${AGENT}`,
  version: 'abc',
  updatedAt: '2026-11-24T00:00:00.000Z',
  capabilities: [],
};
const turtle = cardTurtle(card);
check('the card has Turtle to publish', turtle !== null);
if (turtle) {
  const descriptor = ContextDescriptor.create(`urn:iep:agent-card:${AGENT}` as IRI)
    .describes(CARD as IRI)
    .temporal({ validFrom: '2026-11-24T00:00:00.000Z' })
    .build();
  await publish(descriptor, turtle, POD, { fetch: fetchImpl });
  const app = express();
  app.use(corsMiddleware({}));
  createNsDereference({ cssUrl: CSS, publicBaseUrl: BASE, pgslNodeResolver: undefined, solidFetch: fetchImpl }).mount(app);
  const srv = await listenLoopback(app);
  try {
    const response = await fetch(`${srv.base}/ns/${AGENT}/agent-card`);
    const body = await response.text();
    check('GET of the card IRI returns the published graph', response.status === 200 && body.includes('Georgio') && body.includes('iep:Agent'), `${response.status} ${body.slice(0, 180)}`);
  } finally {
    await srv.close();
  }
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed\n`);
  process.exit(1);
}
console.log('\nPublished card dereferences.\n');
