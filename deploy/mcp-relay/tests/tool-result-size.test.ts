#!/usr/bin/env tsx
/**
 * A relay tool result carries the result ONCE for the model, and read_inbox answers in pages.
 *
 * ── WHAT WAS REPORTED, AND WHAT WAS MEASURED ─────────────────────────────────
 *
 * An agent using the relay as a ChatGPT connector reported `act` results of roughly 25–30 KB
 * that looked like the same body several times over, and `read_inbox` answers its client cut
 * short. This file boots the real `server.ts` against a loopback identity fixture and a
 * loopback pod, calls the tools over `/mcp`, and measures what comes back.
 *
 * Before the change, measured here: every result carried its payload exactly twice —
 * `content[0].text` and `structuredContent`, byte-identical — with no markdown copy and no
 * `_meta` copy; `read_inbox` with no arguments returned all 50 fixture notifications with
 * bodies, 88,045 bytes per copy, 177,792 bytes on the wire, with no total and no way to ask
 * for less.
 *
 * ── WHAT IS ASSERTED ─────────────────────────────────────────────────────────
 *
 *   1. Shape, per tool and per transport (/mcp and /messages): exactly ONE content block is the
 *      full JSON result and it comes FIRST (readers in this repo JSON.parse the first text
 *      block); the other block is one short line that does not contain the body;
 *      structuredContent equals that JSON and validates against the outputSchema the relay
 *      itself declares in tools/list; `_meta`, if present, carries no copy of the result.
 *   2. read_inbox pages: a bounded default, a ceiling that equals the largest limit any caller
 *      in this repository passes, total / hasMore / nextCursor that walk the whole inbox once
 *      with no repeats, bodies that can be left out, `since`, and refusals for a malformed
 *      cursor, flag, fraction or non-string argument — on /mcp and on the REST /tool route that
 *      shares the handler.
 *   3. Notifications the relay did not write — an `actor` object, a `type` array, an object body,
 *      a number for `published` — are read as strings or left out, so a STRICT client (the MCP
 *      SDK Client, which checks structuredContent against the declared outputSchema and throws
 *      on a mismatch) can read every page of an inbox that holds them.
 *   4. A session whose OAuth client registered as ChatGPT, whose model reads structuredContent as
 *      well as content, gets the summary line alone in content: one copy of the result for its
 *      model. "Registered as ChatGPT" means the name AND every redirect URI on ChatGPT's own
 *      hosts: a client that only calls itself ChatGPT, a "chatgpt" bridge, and a name the relay
 *      maps to nothing (so to RELAY_DEFAULT_SURFACE_AGENT, set to chatgpt here) all keep the
 *      JSON first, as every other client does. An error keeps its JSON for ChatGPT too.
 *
 * Set RELAY_RESULT_SIZES_OUT=<file> to write the measured sizes as JSON.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/tool-result-size.test.ts
 */
import express from 'express';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { listenLoopback } from './listen-loopback.js';
import { INBOX_DEFAULT_LIMIT, INBOX_MAX_LIMIT } from '../agent-mesh.js';
import { SUMMARY_MAX_CHARS } from '../tool-result.js';

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) { pass++; console.log(`  PASS  ${name}`); return; }
  fail++; console.log(`  FAIL  ${name}${detail ? `  :: ${detail}` : ''}`);
}

const USER_ID = 'u-pk-compact';
const API_KEY = 'compact-results-fixture-key';
const IDENTITY_BEARER = 'identity-fixture-bearer';
const INBOX_ITEMS = 50;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => { probe.listen(0, '127.0.0.1', () => r()); });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(r => { probe.close(() => r()); });
  return port;
}

/** A vertical-shaped JSON answer of a few KB, quotes and nesting included. */
function actAnswer(): Record<string, unknown> {
  return {
    outcome: 'judged',
    attempt: 'urn:example:attempt:1',
    criteria: Array.from({ length: 8 }, (_, i) => ({
      id: `criterion-${i}`,
      label: `Criterion ${i}: states the "why" before the "how"`,
      met: i % 3 !== 0,
      evidence: `The response quoted "step ${i}" and explained its rationale in two sentences. `.repeat(3),
    })),
    summary: 'Six of eight criteria were met. The two misses are about sequencing, not content.',
    next: [{ action: 'urn:example:action:retry', target: 'urn:example:attempt:1#retry' }],
  };
}
const ACT_MARKER = 'explained its rationale in two sentences';

/** Notification i is published i seconds after a fixed instant, so newest-first is n-049 … n-000. */
const publishedAt = (i: number): string => new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
const BODY_MARKER = (i: number): string => `Finding ${i} detail. `;
function notification(i: number, inbox: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/ns/activitystreams'],
    id: `${inbox}n-${String(i).padStart(3, '0')}.jsonld`,
    type: i % 5 === 0 ? 'Offer' : 'Create',
    actor: `did:web:sender-${i % 4}.example`,
    to: [`did:web:${USER_ID}.example`],
    published: publishedAt(i),
    summary: `Notice ${i}: review the shared findings`,
    object: {
      type: 'Note',
      summary: `Notice ${i}: review the shared findings`,
      content: BODY_MARKER(i).repeat(75),
      'iep:about': `https://pod.example/${USER_ID}/context-graphs/item-${i}.ttl`,
    },
  };
}

/** The fields of a read_inbox page (and of the other results) this suite reads. */
interface InboxItemOut { url: string; published?: string; content?: string; contentLength?: number; summary?: string }
type Payload = Record<string, unknown> & {
  count?: number; total?: number; limit?: number; limitRequested?: number; hasMore?: boolean; nextCursor?: string;
  since?: string; includeContent?: boolean; items?: InboxItemOut[]; error?: string; descriptorUrl?: string;
  status?: number; body?: string;
};
interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Payload;
  _meta?: Record<string, unknown>;
  isError?: boolean;
  tools?: Array<{ name: string; outputSchema?: Record<string, unknown> }>;
}
type Rpc = { status: number; bytes: number; body: { result?: ToolResult; error?: unknown } | undefined; raw: string };
const sizeOf = (v: unknown): number => (v === undefined ? 0 : Buffer.byteLength(JSON.stringify(v)));

interface Measured {
  readonly wireBytes: number;
  readonly contentBlocks: number;
  readonly contentTextBytes: number;
  readonly structuredContentBytes: number;
  readonly metaBytes: number;
}
function measure(r: Rpc): Measured {
  const result: ToolResult = r.body?.result ?? {};
  const content = Array.isArray(result.content) ? result.content : [];
  return {
    wireBytes: r.bytes,
    contentBlocks: content.length,
    contentTextBytes: content.reduce((n, c) => n + Buffer.byteLength(c.text ?? ''), 0),
    structuredContentBytes: sizeOf(result.structuredContent),
    metaBytes: sizeOf(result._meta),
  };
}

/** JSON.parse that answers undefined instead of throwing. */
function parsed(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
/** The same null-free projection the relay applies to structuredContent. */
function withoutNullish(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutNullish);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, withoutNullish(x)]));
  }
  return v;
}
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(withoutNullish(a)) === JSON.stringify(withoutNullish(b));

/**
 * The shape every relay tool result has now. `marker` is a string that occurs in the body and
 * must therefore occur in exactly one content block and never in `_meta`.
 */
function assertShape(label: string, r: Rpc, schemas: Map<string, Record<string, unknown>>, tool: string, marker?: string): void {
  const result = r.body?.result;
  ok(r.status === 200 && !!result && result.isError !== true, `${label}: the call succeeds`, r.raw.slice(0, 300));
  if (!result) return;
  const content = (Array.isArray(result.content) ? result.content : []) as Array<{ type: string; text?: string }>;
  const sc = result.structuredContent as Record<string, unknown> | undefined;
  ok(content.length === 2 && content.every(c => c.type === 'text'), `${label}: content is two text blocks`, JSON.stringify(content.map(c => c.type)));
  const jsonBlocks = content.filter(c => sameJson(parsed(c.text), sc));
  ok(jsonBlocks.length === 1, `${label}: exactly ONE content block is the full result`, `${jsonBlocks.length} full copies`);
  ok(content[0] !== undefined && sameJson(parsed(content[0].text), sc),
    `${label}: and it is the FIRST block, where existing readers parse it`);
  const summary = content[1]?.text ?? '';
  ok(summary.length > 0 && summary.length <= SUMMARY_MAX_CHARS && !summary.includes('\n') && parsed(summary) === undefined,
    `${label}: the second block is one short line, not JSON`, JSON.stringify(summary));
  if (marker) {
    ok(content.filter(c => (c.text ?? '').includes(marker)).length === 1,
      `${label}: the body occurs in one content block only`);
  }
  const validate = new AjvJsonSchemaValidator().getValidator(schemas.get(tool) ?? {});
  const verdict = validate(sc);
  ok(verdict.valid, `${label}: structuredContent conforms to the declared outputSchema`, JSON.stringify(verdict));
  const meta = result._meta as Record<string, unknown> | undefined;
  const metaText = meta === undefined ? '' : JSON.stringify(meta);
  ok(!marker || !metaText.includes(marker), `${label}: _meta carries no copy of the body`, metaText.slice(0, 200));
}

async function main(): Promise<void> {
  const identityApp = express();
  identityApp.use(express.json());
  // The REST transports (/tool, /messages) verify an identity bearer here.
  identityApp.post('/tokens/verify', (q, s) => {
    const token = String(q.body?.token ?? '');
    if (token !== IDENTITY_BEARER) { s.json({ valid: false }); return; }
    s.json({ valid: true, userId: USER_ID, agentId: `mcp-client-${USER_ID}`, scope: 'ReadWrite' });
  });
  // The OAuth sign-in (/oauth/verify) hands the proof to identity, which answers who signed in.
  // This fixture answers for USER_ID whatever the proof: the flow under test is what the relay
  // does with the session afterwards, not proof checking (authorize-page-did-challenge covers it).
  let identityBase = '';
  let podForIdentity = '';
  identityApp.post('/auth/did', (_q, s) => {
    s.json({ userId: USER_ID, token: IDENTITY_BEARER, webId: `${identityBase}/users/${USER_ID}/profile#me`,
      podUrl: podForIdentity, agentId: `oauth-${USER_ID}` });
  });
  identityApp.use((_q, s) => { s.status(404).json({ error: 'not part of this fixture' }); });

  // A pod that stores what it is given, lists containers, and answers one action endpoint.
  const stored = new Map<string, { type: string; body: string }>();
  const podApp = express();
  podApp.use(express.text({ type: () => true, limit: '20mb' }));
  let podBase = '';
  podApp.use((q, s) => {
    const key = decodeURIComponent(q.path);
    if (q.method === 'POST' && key === `/${USER_ID}/actions/judge`) {
      s.type('application/json').send(JSON.stringify(actAnswer()));
      return;
    }
    if (q.method === 'PUT' || q.method === 'POST' || q.method === 'PATCH') {
      if (!key.endsWith('/')) stored.set(key, { type: String(q.headers['content-type'] ?? 'text/turtle'), body: typeof q.body === 'string' ? q.body : '' });
      s.status(201).end();
      return;
    }
    if (q.method === 'DELETE') { stored.delete(key); s.status(205).end(); return; }
    if (key.endsWith('/')) {
      const children = new Set<string>();
      for (const k of stored.keys()) {
        if (!k.startsWith(key) || k === key) continue;
        const rest = k.slice(key.length);
        const slash = rest.indexOf('/');
        children.add(slash < 0 ? rest : rest.slice(0, slash + 1));
      }
      if (children.size === 0) { s.status(404).end(); return; }
      const list = [...children].map(c => `<${podBase}${key}${c}>`).join(', ');
      if (q.method === 'HEAD') { s.type('text/turtle').status(200).end(); return; }
      s.type('text/turtle').status(200)
        .send(`@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> a ldp:Container, ldp:BasicContainer ; ldp:contains ${list} .\n`);
      return;
    }
    const hit = stored.get(key);
    if (!hit) { s.status(404).end(); return; }
    if (q.method === 'HEAD') { s.type(hit.type).status(200).end(); return; }
    s.type(hit.type).status(200).send(hit.body);
  });

  const identity = await listenLoopback(identityApp);
  const pod = await listenLoopback(podApp);
  podBase = pod.base;
  identityBase = identity.base;
  podForIdentity = `${pod.base}/${USER_ID}/`;
  const inbox = `${pod.base}/${USER_ID}/inbox/`;
  for (let i = 0; i < INBOX_ITEMS; i++) {
    stored.set(`/${USER_ID}/inbox/n-${String(i).padStart(3, '0')}.jsonld`,
      { type: 'application/ld+json', body: JSON.stringify(notification(i, inbox), null, 2) });
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // Never the production default key path: a suite must not write a private key it does not own.
  const keyFile = join(tmpdir(), `tool-result-size-key-${process.pid}.json`);

  // ★ The production entry point binds every interface; the child is killed in the `finally`
  // and again on process exit, as in the other suites that spawn it. Both fixtures are loopback.
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: join(here, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      CSS_URL: `${pod.base}/`,
      IDENTITY_URL: identity.base,
      RELAY_AGENT_KEY_FILE: keyFile,
      RELAY_MCP_API_KEY: API_KEY,
      RELAY_MAINTAINER_POD_NAME: USER_ID,
      BASE_URL: base,
      PUBLIC_BASE_URL: base,
      // A dedicated relay may label unknown clients as one surface. That label names agents; it
      // must not decide how a result is laid out (section 5).
      RELAY_DEFAULT_SURFACE_AGENT: 'chatgpt',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let childErr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => { childErr = (childErr + c).slice(-3_000); });
  const killChild = (): void => { child.kill(); };
  process.once('exit', killChild);

  const unwrap = async (res: Response): Promise<Rpc> => {
    const raw = await res.text();
    let body: Rpc['body'];
    try { body = JSON.parse(raw); } catch {
      const m = /^data: (.*)$/m.exec(raw);
      if (m?.[1]) { try { body = JSON.parse(m[1]); } catch { /* not JSON */ } }
    }
    return { status: res.status, bytes: Buffer.byteLength(body ? JSON.stringify(body) : raw), body, raw };
  };
  let rpcId = 0;
  const rpc = async (method: string, params: Record<string, unknown>, bearer = API_KEY): Promise<Rpc> => unwrap(await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${bearer}`, 'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(60_000),
  }));
  const call = (name: string, args: Record<string, unknown>, bearer = API_KEY) => rpc('tools/call', { name, arguments: args }, bearer);
  /**
   * The MCP SDK Client: it checks every structuredContent against the tool's outputSchema and
   * throws on a mismatch. It checks against the schemas it has LISTED, so it lists them first,
   * as a client that offers the tools to a model does; without that it checks nothing.
   */
  const strictClient = async (bearer = API_KEY): Promise<Client> => {
    const client = new Client({ name: 'strict-output-schema-check', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }));
    const listed = await client.listTools();
    if (!listed.tools.some(t => t.name === 'read_inbox' && t.outputSchema)) throw new Error('the strict client listed no read_inbox outputSchema');
    return client;
  };
  /**
   * A relay access token issued through the real authorization-code flow to a client that
   * registered under `clientName` with one redirect URI: /register, /authorize (PKCE),
   * /oauth/verify, /token. The code is read from the redirect the relay answers with, which is
   * never followed, so any redirect host works here.
   */
  const oauthBearer = async (clientName: string, redirect = 'http://127.0.0.1:9/callback'): Promise<string> => {
    const registered = await (await fetch(`${base}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: clientName, redirect_uris: [redirect], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    })).json() as { client_id?: string };
    if (!registered.client_id) throw new Error(`register refused: ${JSON.stringify(registered)}`);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const page = await (await fetch(`${base}/authorize?${new URLSearchParams({
      response_type: 'code', client_id: registered.client_id, redirect_uri: redirect, scope: 'mcp',
      code_challenge: challenge, code_challenge_method: 'S256', state: 'size-suite',
    })}`, { redirect: 'manual' })).text();
    const pendingId = /const PENDING_ID = "([0-9a-f]+)"/.exec(page)?.[1];
    if (!pendingId) throw new Error(`no pending authorization in the sign-in page: ${page.slice(0, 200)}`);
    const verified = await (await fetch(`${base}/oauth/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_id: pendingId, method: 'did', did: `did:web:${USER_ID}.example`, signature: 'fixture' }),
    })).json() as { redirect?: string; error?: string };
    const code = verified.redirect ? new URL(verified.redirect).searchParams.get('code') : null;
    if (!code) throw new Error(`verify gave no code: ${JSON.stringify(verified)}`);
    const token = await (await fetch(`${base}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier,
        client_id: registered.client_id, redirect_uri: redirect }),
    })).json() as { access_token?: string };
    if (!token.access_token) throw new Error(`token refused: ${JSON.stringify(token)}`);
    return token.access_token;
  };
  const callMessages = async (name: string, args: Record<string, unknown>): Promise<Rpc> => unwrap(await fetch(`${base}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${IDENTITY_BEARER}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(60_000),
  }));
  const callRest = async (name: string, args: Record<string, unknown>): Promise<Payload> => {
    const res = await fetch(`${base}/tool/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${IDENTITY_BEARER}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(60_000),
    });
    return (parsed(await res.text()) ?? {}) as Payload;
  };
  const sc = (r: Rpc): Payload => r.body?.result?.structuredContent ?? {};

  const sizes: Record<string, Measured> = {};
  try {
    let up = false;
    for (let i = 0; i < 160 && !up; i++) {
      await new Promise(r => { setTimeout(r, 250).unref(); });
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
        up = r.ok || r.status === 404;
      } catch { /* still booting */ }
    }
    ok(up, 'the relay boots against the fixtures and answers /health', `child stderr tail: ${childErr || '(none)'}`);
    if (!up) return;

    const list = await rpc('tools/list', {});
    const schemas = new Map<string, Record<string, unknown>>(
      (list.body?.result?.tools ?? [])
        .map(t => [t.name, t.outputSchema ?? {}]));
    ok(schemas.has('act') && schemas.has('read_inbox'), 'tools/list declares the tools under test');
    const inboxSchema = schemas.get('read_inbox') as { properties?: Record<string, unknown> } | undefined;
    ok(!!inboxSchema?.properties?.['nextCursor'] && !!inboxSchema?.properties?.['hasMore'] && !!inboxSchema?.properties?.['total'],
      'read_inbox declares its paging fields in outputSchema', JSON.stringify(inboxSchema).slice(0, 200));

    // ── 1. THE RESULT SHAPE ─────────────────────────────────────────────────
    console.log('\n1. one full copy of each result for the model');
    const published: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await call('publish_context', {
        descriptor_id: `urn:iep:test:compact-${i}`, graph_iri: `https://example.test/compact/${i}`,
        graph_content: `<https://example.test/compact/${i}> <http://purl.org/dc/terms/title> "Compact note ${i}" .\n`,
        visibility: 'public', sync: true,
      });
      const url = sc(r).descriptorUrl;
      if (typeof url === 'string') published.push(url);
      if (i === 0) { sizes['publish_context'] = measure(r); assertShape('publish_context', r, schemas, 'publish_context'); }
    }
    ok(published.length === 3, 'three descriptors publish', JSON.stringify(published));

    const discover = await call('discover_context', {});
    sizes['discover_context'] = measure(discover);
    assertShape('discover_context', discover, schemas, 'discover_context', published[0]);

    const descriptor = await call('get_descriptor', { url: published[0] });
    sizes['get_descriptor'] = measure(descriptor);
    assertShape('get_descriptor', descriptor, schemas, 'get_descriptor', 'Compact note 0');

    const act = await call('act', { target: `${pod.base}/${USER_ID}/actions/judge`, action: 'urn:example:action:judge', method: 'POST', payload: { attempt: 'urn:example:attempt:1' } });
    sizes['act'] = measure(act);
    assertShape('act', act, schemas, 'act', ACT_MARKER);
    {
      const actResult = sc(act);
      ok(actResult.status === 200 && String(actResult.body ?? '').includes(ACT_MARKER),
        'act: the target\'s response is still whole in structuredContent.body', JSON.stringify(actResult).slice(0, 200));
      const summary = String(act.body?.result?.content?.[1]?.text ?? '');
      ok(/answered 200/.test(summary) && summary.includes('/actions/judge'),
        'act: the summary names the exchange (target and status), not its body', summary);
    }

    const status = await call('get_pod_status', {});
    sizes['get_pod_status'] = measure(status);
    assertShape('get_pod_status', status, schemas, 'get_pod_status');

    // ── 2. READ_INBOX PAGES ─────────────────────────────────────────────────
    console.log('\n2. read_inbox answers one bounded page at a time');
    const first = await call('read_inbox', {});
    sizes['read_inbox'] = measure(first);
    assertShape('read_inbox (no arguments)', first, schemas, 'read_inbox', BODY_MARKER(49));
    {
      const p = sc(first);
      ok(p['count'] === INBOX_DEFAULT_LIMIT && p['items']?.length === INBOX_DEFAULT_LIMIT && p['limit'] === INBOX_DEFAULT_LIMIT,
        `an old caller with no arguments gets the first ${INBOX_DEFAULT_LIMIT}, not the whole inbox`, `count ${p['count']}`);
      ok(p['total'] === INBOX_ITEMS && p['hasMore'] === true && typeof p['nextCursor'] === 'string',
        '…and is told how many there are and where the next page starts', JSON.stringify({ total: p['total'], hasMore: p['hasMore'] }));
      ok(p['items']?.[0]?.published === publishedAt(49) && p['items']?.[INBOX_DEFAULT_LIMIT - 1]?.published === publishedAt(50 - INBOX_DEFAULT_LIMIT),
        'the page is the newest notifications, newest first');
      ok(String(p.items?.[0]?.content ?? '').includes(BODY_MARKER(49)),
        'bodies are still included by default (existing readers keep content)');
    }

    // Walk every page; each notification appears once, in order.
    {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const r = await call('read_inbox', { limit: 15, ...(cursor ? { before: cursor } : {}) });
        const p = sc(r);
        seen.push(...(p.items ?? []).map(i => i.url));
        cursor = p['hasMore'] === true ? p['nextCursor'] : undefined;
        pages++;
      } while (cursor && pages < 10);
      const expected = Array.from({ length: INBOX_ITEMS }, (_, i) => `n-${String(INBOX_ITEMS - 1 - i).padStart(3, '0')}.jsonld`);
      ok(pages === 4 && seen.length === INBOX_ITEMS && new Set(seen).size === INBOX_ITEMS
        && seen.every((url, i) => url.endsWith(expected[i]!)),
        'following nextCursor walks the whole inbox once, in order, with no repeats', `${pages} pages, ${seen.length} items`);
    }

    {
      const r = await call('read_inbox', { limit: 500 });
      const p = sc(r);
      ok(p['limit'] === INBOX_MAX_LIMIT && p['count'] === INBOX_MAX_LIMIT && p['limitRequested'] === 500,
        `a limit above ${INBOX_MAX_LIMIT} is brought down to it and says so`, JSON.stringify({ limit: p['limit'], count: p['count'], limitRequested: p['limitRequested'] }));
      const fifty = sc(await call('read_inbox', { limit: 50 }));
      ok(fifty['count'] === 50 && fifty['limitRequested'] === undefined && fifty['hasMore'] === false,
        'the largest limit existing callers pass (50) is honoured exactly, so their "came back full" test still means what it did');
    }

    {
      const r = await call('read_inbox', { include_content: false, limit: 50 });
      sizes['read_inbox_summaries_50'] = measure(r);
      assertShape('read_inbox (include_content: false)', r, schemas, 'read_inbox');
      const p = sc(r);
      const items = p.items ?? [];
      ok(items.length === 50 && items.every(i => i.content === undefined && typeof i.contentLength === 'number' && typeof i.summary === 'string')
        && p['includeContent'] === false,
        'include_content: false returns summaries with contentLength and no bodies');
      ok(!JSON.stringify(r.body).includes(BODY_MARKER(10)), '…and no body text anywhere in the result');
      ok(sizes['read_inbox_summaries_50']!.structuredContentBytes < sizes['read_inbox']!.structuredContentBytes,
        'all 50 summaries cost less than the default page with bodies',
        `${sizes['read_inbox_summaries_50']!.structuredContentBytes} vs ${sizes['read_inbox']!.structuredContentBytes}`);
    }

    {
      const since = publishedAt(45);
      const p = sc(await call('read_inbox', { since }));
      ok(p['total'] === 5 && p['count'] === 5 && p['hasMore'] === false && p['since'] === since,
        'since counts and returns only notifications published at or after it', JSON.stringify({ total: p['total'], count: p['count'] }));
    }

    {
      const bad = await call('read_inbox', { before: 'not-a-cursor' });
      ok(/read_inbox: before must be a nextCursor/.test(String(sc(bad)['error'] ?? '')),
        'a malformed cursor is refused, not read as "the first page"', JSON.stringify(sc(bad)));
      const flag = await call('read_inbox', { include_content: 'sometimes' });
      ok(/include_content must be true or false/.test(String(sc(flag)['error'] ?? '')), 'an unreadable include_content is refused');
      const when = await call('read_inbox', { since: 'yesterday' });
      ok(/since must be an ISO-8601/.test(String(sc(when)['error'] ?? '')), 'an unparseable since is refused');
      // The summary line names the tool once: relay errors already begin with it.
      const line = String(bad.body?.result?.content?.[1]?.text ?? '');
      ok(line === 'read_inbox did not complete — before must be a nextCursor value from an earlier read_inbox page',
        'the error summary does not repeat the tool name', line);
    }

    {
      // A present argument the relay cannot read is refused by name, never dropped: a dropped
      // cursor or date answers with the first, unfiltered page, which reads as a right answer.
      const refusals: Array<[Record<string, unknown>, RegExp, string]> = [
        [{ limit: 7.5 }, /read_inbox: limit must be a whole number/, 'a fractional limit'],
        [{ limit: 'ten' }, /read_inbox: limit must be a whole number/, 'a limit that is not a number'],
        [{ before: 42 }, /read_inbox: before must be a nextCursor/, 'a numeric before'],
        [{ before: {} }, /read_inbox: before must be a nextCursor/, 'an object before'],
        [{ since: 1_762_000_000 }, /read_inbox: since must be an ISO-8601/, 'an epoch-number since'],
      ];
      for (const [args, expected, what] of refusals) {
        const r = await call('read_inbox', args);
        const p = sc(r);
        ok(expected.test(String(p['error'] ?? '')) && p['items'] === undefined, `${what} is refused, not answered with a page`, JSON.stringify(p).slice(0, 200));
        const verdict = new AjvJsonSchemaValidator().getValidator(schemas.get('read_inbox') ?? {})(p);
        ok(verdict.valid, `…and the refusal still conforms to the declared outputSchema`, JSON.stringify(verdict));
      }
      const whole = sc(await call('read_inbox', { limit: '7' }));
      ok(whole['count'] === 7 && whole['limitRequested'] === undefined, 'a limit sent as a digit string is still read');
    }

    // ── 3. THE OTHER TRANSPORTS ─────────────────────────────────────────────
    console.log('\n3. /messages builds the same envelope, and the REST route shares the paging');
    {
      const r = await callMessages('read_inbox', { limit: 5 });
      sizes['read_inbox_messages_5'] = measure(r);
      assertShape('/messages read_inbox', r, schemas, 'read_inbox', BODY_MARKER(49));
      ok(sc(r)['count'] === 5 && sc(r)['total'] === INBOX_ITEMS, '/messages pages read_inbox too');
    }
    {
      const page1 = await callRest('read_inbox', { limit: '2', include_content: 'false' });
      ok(page1['count'] === 2 && page1['total'] === INBOX_ITEMS && page1['hasMore'] === true && typeof page1['nextCursor'] === 'string'
        && (page1.items ?? []).every(i => i.content === undefined),
        'POST /tool/read_inbox accepts the paging arguments, string-typed as REST callers send them', JSON.stringify(page1).slice(0, 300));
      const page2 = await callRest('read_inbox', { limit: 2, before: page1['nextCursor'] });
      ok(page2['items']?.[0]?.published === publishedAt(47), '…and its nextCursor continues on the same route');
    }

    // ── 4. NOTIFICATIONS THE RELAY DID NOT WRITE, THROUGH A STRICT CLIENT ───
    console.log('\n4. a strict client reads an inbox holding notifications other senders wrote');
    {
      // Delivered straight to the store, as a sender posting to the inbox does (stored
      // application/json under a UUID name). The two newest sort onto the first page.
      const foreign = (n: number, doc: Record<string, unknown>): void => {
        stored.set(`/${USER_ID}/inbox/0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`, { type: 'application/json', body: JSON.stringify(doc) });
      };
      foreign(1, { '@context': 'https://www.w3.org/ns/activitystreams', type: 'Create', published: publishedAt(120),
        actor: { id: 'https://sender.example/people/ada', type: 'Person', name: 'Ada' }, summary: 'An object actor',
        object: { type: 'Note', content: 'Hello from a sender that embeds the actor.' } });
      foreign(2, { '@context': 'https://www.w3.org/ns/activitystreams', type: ['Offer', 'https://vocab.example/ns#Invitation'],
        published: publishedAt(121), actor: 'https://sender.example/people/bo', summary: 'An array type',
        object: { type: 'Note', content: { '@value': 'A body given as a value object.', '@language': 'en' } } });
      foreign(3, { '@context': 'https://www.w3.org/ns/activitystreams', type: 'Note', published: 1_762_000_000_000,
        actor: 'https://sender.example/people/cy', summary: ['not', 'one', 'string'], content: { html: '<p>an object body</p>' } });
      const totalNow = INBOX_ITEMS + 3;

      const client = await strictClient();
      try {
        for (const args of [{}, { limit: 50 }, { include_content: false }] as Array<Record<string, unknown>>) {
          let result: Awaited<ReturnType<Client['callTool']>> | undefined;
          let thrown = '';
          try { result = await client.callTool({ name: 'read_inbox', arguments: args }); } catch (err) { thrown = (err as Error).message; }
          const p = (result?.structuredContent ?? {}) as Payload;
          ok(!thrown && p['total'] === totalNow, `the SDK Client accepts read_inbox ${JSON.stringify(args)}`, thrown || JSON.stringify(p).slice(0, 200));
        }
        const first = (await client.callTool({ name: 'read_inbox', arguments: { limit: 2 } })).structuredContent as Payload;
        const [b, a] = (first.items ?? []) as unknown as Array<Record<string, unknown>>;
        ok(a?.['actor'] === 'https://sender.example/people/ada' && a?.['type'] === 'Create',
          'an embedded actor is reported by its id', JSON.stringify(a));
        ok(b?.['type'] === 'Offer' && b?.['content'] === 'A body given as a value object.',
          'a type array is reported by its ActivityStreams type, and a value object by its value', JSON.stringify(b));
        // Every page, through the strict client, including the undated one at the end.
        const walked: Array<Record<string, unknown>> = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const p = (await client.callTool({ name: 'read_inbox', arguments: { limit: 50, include_content: false, ...(cursor ? { before: cursor } : {}) } }))
            .structuredContent as Payload;
          walked.push(...((p.items ?? []) as unknown as Array<Record<string, unknown>>));
          cursor = p['hasMore'] === true ? p['nextCursor'] : undefined;
          pages++;
        } while (cursor && pages < 5);
        const odd = walked.find(i => String(i['url']).includes('00000003-'));
        ok(walked.length === totalNow && !!odd && odd['published'] === undefined && odd['summary'] === undefined && odd['contentLength'] === undefined,
          'values that are not strings are left out, and the item is still listed', JSON.stringify(odd));
        ok(walked.every(i => Object.entries(i).every(([k, v]) => (k === 'contentLength' ? typeof v === 'number' : typeof v === 'string'))),
          'every item field the relay returns is a string (contentLength a number)');
      } finally {
        await client.close();
      }
      for (const n of [1, 2, 3]) stored.delete(`/${USER_ID}/inbox/0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`);
    }

    // ── 5. A CHATGPT SESSION GETS THE RESULT ONCE ───────────────────────────
    console.log('\n5. a session the relay identifies as ChatGPT gets one copy of each result');
    {
      const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
      const chatgpt = await oauthBearer('ChatGPT', CHATGPT_REDIRECT);
      const other = await oauthBearer('Claude');
      const actArgs = { target: `${pod.base}/${USER_ID}/actions/judge`, action: 'urn:example:action:judge', method: 'POST', payload: { attempt: 'urn:example:attempt:1' } };
      for (const [tool, args, marker] of [
        ['act', actArgs, ACT_MARKER],
        ['read_inbox', {}, BODY_MARKER(49)],
        ['discover_context', {}, published[0]],
      ] as Array<[string, Record<string, unknown>, string | undefined]>) {
        const r = await call(tool, args, chatgpt);
        const result = r.body?.result;
        const content = result?.content ?? [];
        const structured = result?.structuredContent;
        ok(r.status === 200 && !!structured && result?.isError !== true, `ChatGPT ${tool}: the call succeeds`, r.raw.slice(0, 300));
        ok(content.length === 1 && parsed(content[0]?.text) === undefined && (content[0]?.text ?? '').length <= SUMMARY_MAX_CHARS,
          `ChatGPT ${tool}: content is the summary line alone`, JSON.stringify(content).slice(0, 300));
        ok(!marker || (!JSON.stringify(content).includes(marker) && JSON.stringify(structured).includes(marker)),
          `ChatGPT ${tool}: the result is in structuredContent and nowhere else the model reads`);
        const verdict = new AjvJsonSchemaValidator().getValidator(schemas.get(tool) ?? {})(structured);
        ok(verdict.valid, `ChatGPT ${tool}: structuredContent conforms to the declared outputSchema`, JSON.stringify(verdict));
        if (tool === 'act') {
          sizes['act_chatgpt'] = measure(r);
          ok(sizes['act_chatgpt']!.wireBytes < sizes['act']!.wireBytes - sizes['act']!.structuredContentBytes / 2,
            'ChatGPT act: the wire carries one copy of the result, not two',
            `${sizes['act_chatgpt']!.wireBytes} vs ${sizes['act']!.wireBytes}`);
        }
      }
      const jsonFirst = async (label: string, bearer: string): Promise<void> => {
        const r = await call('act', actArgs, bearer);
        const content = r.body?.result?.content ?? [];
        ok(content.length === 2 && sameJson(parsed(content[0]?.text), r.body?.result?.structuredContent),
          label, JSON.stringify(content.map(c => (c.text ?? '').slice(0, 60))));
      };
      await jsonFirst('any other client keeps the JSON result first in content', other);
      // A name is a claim the client makes about itself. Each of these would lose the whole
      // result if its model reads content alone and it were given the summary line instead.
      await jsonFirst('a client whose name merely contains "chatgpt", with its own redirect, keeps the JSON first',
        await oauthBearer('my chatgpt bridge', 'https://bridge.example/oauth/callback'));
      await jsonFirst('a client named ChatGPT whose redirect is not on ChatGPT\'s hosts keeps the JSON first',
        await oauthBearer('ChatGPT'));
      await jsonFirst('a name no surface pattern matches keeps the JSON first, whatever RELAY_DEFAULT_SURFACE_AGENT says',
        await oauthBearer('\u2713\u2713\u2713', CHATGPT_REDIRECT));
      // An error keeps its JSON for ChatGPT too: error bodies are small and the reason must reach
      // a client that reports isError from content alone.
      const refused = await call('read_inbox', { limit: 2.5 }, chatgpt);
      const refusedContent = refused.body?.result?.content ?? [];
      ok(refusedContent.length === 2 && /limit must be a whole number/.test(String((parsed(refusedContent[0]?.text) as Payload | undefined)?.['error'] ?? '')),
        'ChatGPT: an error result keeps its JSON first in content', JSON.stringify(refusedContent).slice(0, 300));
      const client = await strictClient(chatgpt);
      try {
        let thrown = '';
        try { await client.callTool({ name: 'act', arguments: actArgs }); } catch (err) { thrown = (err as Error).message; }
        ok(!thrown, 'the SDK Client accepts the ChatGPT-shaped act result', thrown);
      } finally {
        await client.close();
      }
    }

    for (const [k, v] of Object.entries(sizes)) console.log(`  ${k.padEnd(26)} ${JSON.stringify(v)}`);
    const out = process.env['RELAY_RESULT_SIZES_OUT'];
    if (out) writeFileSync(out, JSON.stringify(sizes, null, 2));
  } finally {
    child.kill();
    process.removeListener('exit', killChild);
    await identity.close();
    await pod.close();
    // The child persists its X25519 key at RELAY_AGENT_KEY_FILE and its compliance wallet beside it.
    for (const f of [keyFile, keyFile.replace(/\.json$/, '-ecdsa.json')]) {
      try { rmSync(f, { force: true }); } catch { /* never written */ }
    }
  }
}

main()
  .catch((err: unknown) => { ok(false, 'the suite ran to completion', err instanceof Error ? err.stack ?? err.message : String(err)); })
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
