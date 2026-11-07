import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import express from 'express';
import AdmZip from 'adm-zip';
import { AgentSessionStore } from '../src/i2idlx-agent-sessions.js';
import { attachUserCourseRoutes, UserCourseStore, USER_COURSE_PATH } from '../src/i2idlx-user-courses.js';

type Row = Record<string, unknown>;
const BASE = 'https://workbench.example';
const CLOUD = 'https://cloud.scorm.com/api/v2';
const actor = 'did:web:identity.example:agents:alice';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function packageZip(body = 'Record the synthetic code BLUE-27 in the simulation log.'): Buffer {
  const zip = new AdmZip();
  zip.addFile('imsmanifest.xml', Buffer.from(`<?xml version="1.0"?><manifest identifier="fixture" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"><metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata><organizations default="org"><organization identifier="org"><title>Private fixture course</title><item identifier="intro" identifierref="page"><title>Incident procedure</title></item></organization></organizations><resources><resource identifier="page" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/><file href="question-bank.json"/></resource></resources></manifest>`));
  zip.addFile('index.html', Buffer.from('<!doctype html><html><head><title>Incident procedure</title></head><body><h1>Incident procedure</h1><p>' + body + '</p><script>const hiddenRuntime = "RUNTIME-PRIVATE";</script></body></html>'));
  zip.addFile('question-bank.json', Buffer.from(JSON.stringify({ questions: [{ question: 'HIDDEN-QUESTION', type: 'true-false', answer: true, explanation: 'HIDDEN-GRADING' }] })));
  return zip.toBuffer();
}
const course = { id: 'private/course ? one', title: 'Private fixture course', version: 2, learningStandard: 'SCORM_12' };
const basic = { type: 'basic', app_id: 'fixture-app', secret: 'PRIVATE-SCORM-SECRET' };
function fixture(fetcher?: typeof fetch, ttl = 30 * 60_000) {
  let now = 1_000_000;
  const sessions = new AgentSessionStore({ baseUrl: BASE, now: () => now });
  cleanups.push(() => sessions.dispose());
  const makeSession = (ip: string, did = actor) => {
    const made = sessions.create(ip);
    const claimed = sessions.driver({ i2idlx_operation: 'agent-session', bridge_audience: BASE,
      session_id: made.session_id, operation: 'claim', invite_token: made.invite_token }, did);
    return { ...made, session_id: made.session_id, browser_token: made.browser_token, driver_token: claimed.driver_token };
  };
  const alice = makeSession('alice'), bob = makeSession('bob');
  const bytes = packageZip();
  const cloudFetch = vi.fn(fetcher ?? (async (url: string | URL | Request) => {
    if (String(url) === CLOUD + '/courses') return Response.json({ courses: [course] });
    if (String(url) === CLOUD + '/courses/' + encodeURIComponent(course.id) + '/versions/2/zip') return new Response(Uint8Array.from(bytes));
    throw new Error('Unexpected provider path');
  }) as typeof fetch);
  return { sessions, alice, bob, makeSession, cloudFetch, bytes, now: () => now, advance: (ms: number) => { now += ms; }, ttl };
}
async function setup(fetcher?: typeof fetch, ttl?: number) {
  const f = fixture(fetcher, ttl);
  const dir = await mkdtemp(join(tmpdir(), 'i2idlx-private-course-'));
  cleanups.push(async () => {
    const target = await realpath(dir);
    expect(dirname(target)).toBe(await realpath(tmpdir()));
    await rm(target, { recursive: true, force: true });
  });
  const dataFile = join(dir, 'glossary.json');
  await writeFile(dataFile, JSON.stringify({ meta: { release: 'v0.0.93', commit: 'b'.repeat(40),
    scheme: { title: 'Fixture glossary', rights: 'CC BY 4.0' } },
  concepts: [{ id: 'learning-record', l: 'Learning record', d: 'A fixture informational record.', a: [], b: [], n: [], r: [], ev: [] }],
  sources: [], roles: [], mappings: [], enactments: [], semantic: {}, ports: [], queries: [] }));
  const config = { baseUrl: BASE, sessions: f.sessions, taskConfig: { baseUrl: BASE, appDataFile: dataFile },
    fetch: f.cloudFetch as typeof fetch, now: f.now, connectionTtlMs: f.ttl };
  const store = new UserCourseStore(config);
  cleanups.push(() => store.dispose());
  const request = (operation: string, extra: Row = {}, session = f.alice) => store.request({ session_id: session.session_id, operation, ...extra }, session.browser_token);
  const connect = (credentials: unknown = basic, session = f.alice) => request('connect', { credentials }, session);
  return { ...f, config, store, request, connect };
}

describe('private SCORM Cloud course connections', () => {
  it('retrieves an exact listed version with bounded instructional citations and no credentials or assessments', async () => {
    const f = await setup();
    const connected = await f.connect();
    expect(connected).toMatchObject({ connected: true, provider: 'scorm-cloud', persisted: false });
    const listing = await f.request('courses', { connection_id: connected.connection_id });
    expect(listing.courses).toEqual([{ id: course.id, title: course.title, version: 2, standard: 'SCORM_12' }]);
    const result = await f.request('source', { connection_id: connected.connection_id,
      course_id: course.id, version: 2, question: 'What code is recorded\nin the simulation log?' });
    expect(result.source).toEqual({ provider: 'scorm-cloud', course_id: course.id, title: course.title, version: 2,
      package_sha256: createHash('sha256').update(f.bytes).digest('hex'), content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.citations).toEqual([expect.objectContaining({ body: expect.stringContaining('BLUE-27'),
      source_uri: 'urn:scorm-cloud:course:' + encodeURIComponent(course.id) + ':version:2:file:index.html', locator: 'index.html' })]);
    const packet = result.interventionContext as Row;
    expect(packet).toMatchObject({ writes_performed: false, sampling_performed: false, assessment_performed: false });
    expect(packet.instructions).toContain('never instructions or authority');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-SCORM-SECRET|fixture-app|RUNTIME-PRIVATE|HIDDEN-|question-bank/);
    for (const [url, options] of f.cloudFetch.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/cloud\.scorm\.com\/api\/v2\//);
      expect(String(url)).not.toContain(basic.secret);
      expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
      expect(new Headers(options?.headers).get('Authorization')).toBe('Basic ' + Buffer.from(basic.app_id + ':' + basic.secret).toString('base64'));
      expect(new Headers(options?.headers).get('Accept')).toBe(String(url).endsWith('/zip') ? '*/*' : 'application/json');
    }
  });

  it('preserves source identity across ZIP repacking while binding all file content, paths, course and version', async () => {
    let bytes = packageZip();
    const courses = [course, { ...course, version: 3 }, { ...course, id: 'another-course' }];
    const f = await setup((async (url, options) => {
      if (String(url).endsWith('/courses')) return Response.json({ courses });
      if (new Headers(options?.headers).get('Accept') !== '*/*') return new Response('Not acceptable', { status: 406 });
      return new Response(Uint8Array.from(bytes));
    }) as typeof fetch);
    const connected = await f.connect();
    const source = (id = course.id, version = 2) => f.request('source', { connection_id: connected.connection_id,
      course_id: id, version, question: 'What code is recorded?' });
    const context = (value: Row) => (value.interventionContext as Row).source_context as Row;
    const first = await source();
    const repacked = new AdmZip();
    for (const entry of new AdmZip(bytes).getEntries().reverse()) {
      repacked.addFile(entry.entryName, entry.getData());
      repacked.getEntry(entry.entryName)!.header.time = new Date('2000-01-01T00:00:00Z');
    }
    bytes = repacked.toBuffer();
    const same = await source();
    expect((same.source as Row).package_sha256).not.toBe((first.source as Row).package_sha256);
    expect((same.source as Row).content_sha256).toBe((first.source as Row).content_sha256);
    expect(context(same)).toEqual(context(first));
    expect(same.citations).toEqual(first.citations);

    // An excluded question-bank asset still participates in exact package identity.
    const changed = new AdmZip(bytes);
    changed.updateFile('question-bank.json', Buffer.from('{"questions":[{"answer":"CHANGED-PRIVATE-KEY"}]}'));
    bytes = changed.toBuffer();
    const contentChanged = await source();
    expect((contentChanged.source as Row).content_sha256).not.toBe((first.source as Row).content_sha256);
    expect(context(contentChanged).id).not.toBe(context(first).id);
    expect(contentChanged.citations).not.toEqual(first.citations);
    expect(JSON.stringify(contentChanged)).not.toContain('CHANGED-PRIVATE-KEY');

    const versionChanged = await source(course.id, 3);
    const courseChanged = await source('another-course');
    for (const changedIdentity of [versionChanged, courseChanged]) {
      expect((changedIdentity.source as Row).content_sha256).toBe((contentChanged.source as Row).content_sha256);
      expect(context(changedIdentity).id).not.toBe(context(contentChanged).id);
      expect(changedIdentity.citations).not.toEqual(contentChanged.citations);
    }
    const renamed = new AdmZip();
    for (const entry of changed.getEntries()) renamed.addFile(entry.entryName === 'question-bank.json' ? 'renamed-bank.json' : entry.entryName, entry.getData());
    bytes = renamed.toBuffer();
    expect(((await source()).source as Row).content_sha256).not.toBe((contentChanged.source as Row).content_sha256);
  });

  it('bounds large multibyte instructional text without corrupting the UTF-8 excerpt', async () => {
    const bytes = packageZip('BLUE-27 ' + '測🙂'.repeat(100_000));
    const f = await setup((async url => String(url).endsWith('/courses') ? Response.json({ courses: [course] })
      : new Response(Uint8Array.from(bytes))) as typeof fetch);
    const connected = await f.connect();
    const result = await f.request('source', { connection_id: connected.connection_id,
      course_id: course.id, version: 2, question: 'What is BLUE-27?' });
    expect(result.truncated).toBe(true);
    const citations = result.citations as Row[];
    expect(citations).toHaveLength(1);
    const body = String(citations[0]!.body);
    expect(body).toContain('BLUE-27');
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(96_000);
    expect(body).not.toContain('\uFFFD');
    expect(body).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('isolates connections and listed selections between browser sessions even for the same actor', async () => {
    const f = await setup();
    const alice = await f.connect();
    const bob = await f.connect({ type: 'bearer', token: 'fixture-bearer' }, f.bob);
    expect(alice.connection_id).not.toBe(bob.connection_id);
    const calls = f.cloudFetch.mock.calls.length;
    await expect(f.request('source', { connection_id: alice.connection_id, course_id: course.id, version: 2, question: 'What code?' }, f.bob)).rejects.toMatchObject({ status: 404 });
    await expect(f.request('source', { connection_id: alice.connection_id, course_id: 'not-listed', version: 2, question: 'What code?' })).rejects.toMatchObject({ status: 404 });
    await expect(f.request('source', { connection_id: alice.connection_id, course_id: course.id, version: 3, question: 'What code?' })).rejects.toMatchObject({ status: 404 });
    expect(f.cloudFetch.mock.calls).toHaveLength(calls);
    await f.request('disconnect');
    expect(await f.request('status')).toEqual({ connected: false });
    expect(await f.request('status', {}, f.bob)).toMatchObject({ connected: true, connection_id: bob.connection_id });
  });

  it('refuses credentials from an unclaimed browser, a driver credential and a different browser token', async () => {
    const f = await setup();
    const unclaimed = f.sessions.create('unclaimed');
    const body = { operation: 'connect', session_id: unclaimed.session_id, credentials: basic };
    await expect(f.store.request(body, unclaimed.browser_token)).rejects.toMatchObject({ status: 409 });
    await expect(f.store.request({ ...body, session_id: f.alice.session_id }, f.alice.driver_token)).rejects.toMatchObject({ status: 404 });
    await expect(f.store.request({ ...body, session_id: f.alice.session_id }, f.bob.browser_token)).rejects.toMatchObject({ status: 404 });
    expect(f.cloudFetch).not.toHaveBeenCalled();
  });

  it('clears an expiring course connection and revokes a connection with its owning session', async () => {
    const f = await setup(undefined, 60_000);
    const connected = await f.connect();
    f.advance(60_001);
    await expect(f.request('courses', { connection_id: connected.connection_id })).rejects.toMatchObject({ status: 410, code: 'course_connection_expired' });
    expect(await f.request('status')).toEqual({ connected: false });
    const renewed = await f.connect();
    f.sessions.browser({ session_id: f.alice.session_id, operation: 'disconnect' }, f.alice.browser_token);
    await expect(f.request('courses', { connection_id: renewed.connection_id })).rejects.toMatchObject({ status: 410 });
    expect((f.store as unknown as { connections: Map<string, unknown> }).connections.size).toBe(0);
  });

  it('aborts an in-flight package read and never returns old private material after connection replacement', async () => {
    let resolveZip!: (response: Response) => void;
    let pendingSignal: AbortSignal | undefined;
    const f = await setup((async (url, options) => {
      if (String(url).endsWith('/courses')) return Response.json({ courses: [course] });
      pendingSignal = options?.signal as AbortSignal;
      return new Promise<Response>(resolve => { resolveZip = resolve; });
    }) as typeof fetch);
    const first = await f.connect();
    const pending = f.request('source', { connection_id: first.connection_id, course_id: course.id, version: 2, question: 'What code?' });
    await vi.waitFor(() => expect(pendingSignal).toBeDefined());
    const rejection = expect(pending).rejects.toMatchObject({ status: 404, code: 'course_connection_not_found' });
    const second = await f.connect();
    expect(pendingSignal?.aborted).toBe(true);
    resolveZip(new Response(Uint8Array.from(f.bytes)));
    await rejection;
    expect(await f.request('status')).toMatchObject({ connection_id: second.connection_id });
  });

  it('purges credentials and aborts old source work when pairing renews, including same-actor reclaim', async () => {
    let resolveZip!: (response: Response) => void;
    let pendingSignal: AbortSignal | undefined;
    const f = await setup((async (url, options) => {
      if (String(url).endsWith('/courses')) return Response.json({ courses: [course] });
      pendingSignal = options?.signal as AbortSignal;
      return new Promise<Response>(resolve => { resolveZip = resolve; });
    }) as typeof fetch);
    const connected = await f.connect();
    const pending = f.request('source', { connection_id: connected.connection_id,
      course_id: course.id, version: 2, question: 'What code?' });
    await vi.waitFor(() => expect(pendingSignal).toBeDefined());
    const rejection = expect(pending).rejects.toMatchObject({ status: 404, code: 'course_connection_not_found' });
    const invitation = f.sessions.browser({ session_id: f.alice.session_id, operation: 'invite' }, f.alice.browser_token);
    expect(pendingSignal?.aborted).toBe(true);
    expect((f.store as unknown as { connections: Map<string, unknown> }).connections.size).toBe(0);
    f.sessions.driver({ i2idlx_operation: 'agent-session', bridge_audience: BASE, session_id: f.alice.session_id,
      operation: 'claim', invite_token: invitation.invite_token }, actor);
    resolveZip(new Response(Uint8Array.from(f.bytes)));
    await rejection;
    expect(await f.request('status')).toEqual({ connected: false });
    await expect(f.request('source', { connection_id: connected.connection_id,
      course_id: course.id, version: 2, question: 'What code?' })).rejects.toMatchObject({ status: 404 });
  });

  it('bounds simultaneous source reads across browser sessions and releases capacity afterwards', async () => {
    const releases: Array<() => void> = [];
    const f = await setup((async url => {
      if (String(url).endsWith('/courses')) return Response.json({ courses: [course] });
      return new Promise<Response>(resolve => { releases.push(() => resolve(new Response(Uint8Array.from(packageZip())))); });
    }) as typeof fetch);
    const charlie = f.makeSession('charlie');
    const sessions = [f.alice, f.bob, charlie];
    const connected: Row[] = [];
    for (const session of sessions) connected.push(await f.connect(basic, session));
    const source = (i: number) => f.request('source', { connection_id: connected[i]!.connection_id,
      course_id: course.id, version: 2, question: 'What code?' }, sessions[i]);
    const first = source(0), second = source(1);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    await expect(source(2)).rejects.toMatchObject({ status: 429, code: 'course_rate_limited' });
    releases[0]!(); releases[1]!();
    await Promise.all([first, second]);
    const next = source(2);
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[2]!();
    expect(await next).toHaveProperty('interventionContext');
    expect((f.store as unknown as { active: number }).active).toBe(0);
  });

  it('keeps provider response bodies and thrown credential strings out of failures', async () => {
    const f = await setup((async () => new Response('PRIVATE-SCORM-SECRET raw provider body', { status: 401 })) as typeof fetch);
    await expect(f.connect()).rejects.toMatchObject({ status: 401, code: 'course_provider_authentication_failed' });
    expect(await f.request('status')).toEqual({ connected: false });
    const throwing = await setup((async () => { throw new Error('PRIVATE-SCORM-SECRET'); }) as typeof fetch);
    await expect(throwing.connect()).rejects.toMatchObject({ message: 'The course could not be read from SCORM Cloud. Try again.' });
    expect(await throwing.request('status')).toEqual({ connected: false });
  });

  it('uses only provider-issued paging references and keeps pagination on the official API', async () => {
    const remoteCursor = 'https://untrusted.example/looks-like-a-url';
    const f = await setup((async url => String(url) === CLOUD + '/courses'
      ? Response.json({ courses: [course], more: remoteCursor })
      : Response.json({ courses: [{ ...course, id: 'second-course' }] })) as typeof fetch);
    const connected = await f.connect();
    const first = await f.request('courses', { connection_id: connected.connection_id });
    expect(first.next_page).not.toBe(remoteCursor);
    const second = await f.request('courses', { connection_id: connected.connection_id, page: first.next_page });
    expect(second.courses).toMatchObject([{ id: 'second-course' }]);
    expect(f.cloudFetch.mock.calls.at(-1)?.[0]).toBe(CLOUD + '/courses?' + new URLSearchParams({ more: remoteCursor }));
    const calls = f.cloudFetch.mock.calls.length;
    await expect(f.request('courses', { connection_id: connected.connection_id, page: remoteCursor })).rejects.toMatchObject({ status: 404 });
    expect(f.cloudFetch.mock.calls).toHaveLength(calls);
  });

  it('keeps every course in a bounded provider page reachable even without another page', async () => {
    const courses = Array.from({ length: 41 }, (_, i) => ({ ...course, id: 'course-' + i }));
    const f = await setup((async url => String(url).endsWith('/courses') ? Response.json({ courses })
      : new Response(Uint8Array.from(packageZip()))) as typeof fetch);
    const connected = await f.connect();
    const listed = await f.request('courses', { connection_id: connected.connection_id });
    expect(listed.courses).toHaveLength(41);
    expect(listed).toMatchObject({ truncated: false });
    expect(listed.next_page).toBeUndefined();
    const source = await f.request('source', { connection_id: connected.connection_id,
      course_id: 'course-40', version: 2, question: 'What code is recorded?' });
    expect(source.source).toMatchObject({ course_id: 'course-40', version: 2 });
  });

  it('caps per-session retrieval requests and clears an idle connection at its expiry', async () => {
    const f = await setup();
    await f.connect();
    for (let request = 0; request < 29; request++) await f.request('status');
    await expect(f.request('status')).rejects.toMatchObject({ status: 429 });
    expect(f.cloudFetch).toHaveBeenCalledTimes(1);
    f.advance(60_001);
    expect(await f.request('status')).toMatchObject({ connected: true });
    for (let request = 0; request < 29; request++) await f.request('status');
    await expect(f.request('status')).rejects.toMatchObject({ status: 429 });
    expect(await f.request('disconnect')).toEqual({ connected: false });
    expect((f.store as unknown as { connections: Map<string, unknown> }).connections.size).toBe(0);

    vi.useFakeTimers();
    try {
      const idle = await setup(undefined, 100);
      await idle.connect();
      await vi.advanceTimersByTimeAsync(101);
      expect((idle.store as unknown as { connections: Map<string, unknown> }).connections.size).toBe(0);
      expect(await idle.request('status')).toEqual({ connected: false });
    } finally { vi.useRealTimers(); }
  });

  it('refuses provider redirects and response bytes beyond the actual stream budget', async () => {
    const redirect = await setup((async () => Response.redirect('http://127.0.0.1/private', 302)) as typeof fetch);
    await expect(redirect.connect()).rejects.toMatchObject({ status: 502 });
    expect(redirect.cloudFetch).toHaveBeenCalledTimes(1);
    const huge = await setup((async url => String(url).endsWith('/courses') ? Response.json({ courses: [course] })
      : new Response(new Uint8Array(16 * 1024 * 1024 + 1), { headers: { 'Content-Length': '1' } })) as typeof fetch);
    const connected = await huge.connect();
    await expect(huge.request('source', { connection_id: connected.connection_id, course_id: course.id, version: 2, question: 'What code?' })).rejects.toMatchObject({ status: 413 });
  });

  it('refuses traversal entries and compressed output hidden behind a false ZIP size', async () => {
    const traversal = new AdmZip();
    traversal.addFile('safe-name', Buffer.from('x'));
    const zipped = traversal.toBuffer();
    const unsafe = Buffer.from(zipped.toString('binary').replaceAll('safe-name', '../escape'), 'binary');
    const bomb = new AdmZip(); bomb.addFile('huge.html', Buffer.alloc(4 * 1024 * 1024 + 1, 65));
    const packed = bomb.toBuffer();
    const central = packed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    packed.writeUInt32LE(0, central + 24); packed.writeUInt32LE(0, 22);
    for (const bytes of [unsafe, packed]) {
      const f = await setup((async url => String(url).endsWith('/courses') ? Response.json({ courses: [course] }) : new Response(Uint8Array.from(bytes))) as typeof fetch);
      const connected = await f.connect();
      await expect(f.request('source', { connection_id: connected.connection_id, course_id: course.id, version: 2, question: 'What code?' })).rejects.toMatchObject({ status: expect.any(Number) });
    }
  });

  it('exposes the private route only through the owning browser bearer and rejects URL or origin inputs', async () => {
    const f = await setup();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.body = { ...req.body, __client_ip: 'bridge metadata', __caller_token: 'PRIVATE-TRANSPORT' }; next(); });
    const mounted = attachUserCourseRoutes(app, f.config); cleanups.push(() => mounted.dispose());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const body = JSON.stringify({ session_id: f.alice.session_id, operation: 'connect', credentials: basic });
    const send = (headers: Record<string, string>, suffix = '') => fetch(base + USER_COURSE_PATH + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    expect((await send({})).status).toBe(404);
    expect((await send({ Authorization: 'Bearer ' + f.alice.browser_token, Origin: 'https://other.example' })).status).toBe(403);
    expect((await send({ Authorization: 'Bearer ' + f.alice.browser_token }, '?url=http://localhost')).status).toBe(400);
    expect(f.cloudFetch).not.toHaveBeenCalled();
    const response = await send({ Authorization: 'Bearer ' + f.alice.browser_token, Origin: BASE });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).not.toMatch(/PRIVATE-|fixture-app/);
  });
});
