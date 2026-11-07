import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { attachCourseSourceService, LtiCourseSourceTokens, type SourceDeletionReceipt } from '../src/i2idlx-course-source-service.js';
import { UserCourseStore } from '../src/i2idlx-user-courses.js';
import { AgentSessionStore } from '../src/i2idlx-agent-sessions.js';
import type { SourceTransport } from '../src/i2idlx-course-provider.js';

describe('source-local adapter to Ask round trip', () => {
  it('checks owner permission, delivers cited source passages without an export, and reads deletion completion', async () => {
    const now = Date.now(), actor = 'did:web:identity.example:agents:roundtrip';
    const course = { id: 'owner-course', title: 'Owner procedure', version: 'release-2', source_uri: 'https://owner.example/course' };
    let ownerAllows = true;
    const tokens = new LtiCourseSourceTokens({ now: () => now, actorForLaunch: async () => actor,
      courseForLaunch: async () => course, ownerPermitsLaunch: async () => ownerAllows });
    // The unit preceding this integration verifies the helper boundary. A publisher calls
    // this only from its already-verified LTI callback, never an HTTP JSON assertion.
    const issued = await tokens.issueForVerifiedLaunch({ issuer: 'https://lms.example', clientId: 'client', deploymentId: 'deployment',
      sub: 'learner', roles: ['Learner'], resourceLink: { id: 'resource' }, context: { id: 'context' }, custom: {} });
    expect(issued).not.toBeNull();
    let deletion: SourceDeletionReceipt = { request_id: 'receipt-one', course_id: course.id, version: course.version,
      status: 'pending', scope: 'derived-content', requested_at: new Date(now).toISOString() };
    const sourceCalls: string[] = [], sourceQuestions: string[] = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { sourceCalls.push(String(req.body?.operation)); next(); });
    attachCourseSourceService(app, '/source', { providerName: 'Owner source', now: () => now,
      authenticate: token => tokens.authenticate(token),
      permission: async () => ownerAllows ? { id: 'grant-one', owner: 'did:web:owner.example:owner', expires_at: new Date(now + 60_000).toISOString(),
        permissions: ['read-passages', 'share-with-paired-agent', 'request-deletion'] } : null,
      context: async (_principal, question) => { sourceQuestions.push(question); return {
        source: { course_id: course.id, title: course.title, version: course.version, source_uri: course.source_uri,
          content_sha256: 'b'.repeat(64), kind: 'source-owned course' },
        sections: [{ id: 'procedure', title: 'Beacon procedure', body: 'Record BLUE-27. Resume only when READY-9 is shown.',
          source_uri: course.source_uri + '#procedure', locator: 'procedure', assessment: false }],
        graph: { nodes: [{ id: 'beacon', label: 'Beacon procedure', section_id: 'procedure' }], edges: [] },
      }; },
      requestDeletion: async () => deletion, deletionStatus: async () => deletion });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    // Trusted test-only transport maps the validated public endpoint to the local
    // source server. Production uses the DNS-pinned HTTPS transport instead.
    const transport: SourceTransport = async (url, body, headers, signal) => {
      expect(url.href).toBe('https://owner.example/source');
      const r = await fetch(origin + '/source', { method: 'POST', body: Uint8Array.from(body), headers, signal });
      return { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? '' }, body: Buffer.from(await r.arrayBuffer()) };
    };
    const directory = await mkdtemp(join(tmpdir(), 'i2idlx-source-roundtrip-'));
    const dataFile = join(directory, 'glossary.json');
    await writeFile(dataFile, JSON.stringify({ meta: { release: 'v0.0.93', commit: 'b'.repeat(40), scheme: { title: 'Fixture', rights: 'CC BY 4.0' } },
      concepts: [{ id: 'learning-record', l: 'Learning record', d: 'An informational record.', a: [], b: [], n: [], r: [], ev: [] }],
      sources: [], roles: [], mappings: [], enactments: [], semantic: {}, ports: [], queries: [] }));
    const base = 'https://workbench.example';
    const sessions = new AgentSessionStore({ baseUrl: base, now: () => now });
    const made = sessions.create('roundtrip');
    sessions.driver({ i2idlx_operation: 'agent-session', bridge_audience: base, session_id: made.session_id,
      operation: 'claim', invite_token: made.invite_token }, actor);
    const store = new UserCourseStore({ baseUrl: base, sessions, taskConfig: { baseUrl: base, appDataFile: dataFile }, now: () => now,
      sourceTransport: transport, fetch: async () => { throw new Error('Package export must never execute in virtual mode'); } });
    const request = (operation: string, extra: Record<string, unknown> = {}) => store.request({ session_id: made.session_id, operation, ...extra }, made.browser_token);
    try {
      const connected = await request('connect', { provider: 'source-service', credentials: { service_url: 'https://owner.example/source', token: issued!.token } });
      const common = { connection_id: connected.connection_id, course_id: course.id, version: course.version };
      const grant = await request('grant', { ...common, mode: 'virtual', permission: { authorized: true, authority: 'authorized-by-owner', retention_minutes: 1 } });
      const active = grant.grant as Record<string, unknown>;
      const out = await request('source', { ...common, grant_id: active.grant_id ?? active.id, question: 'When can I resume?' });
      expect(out).toMatchObject({ access: { mode: 'virtual' }, source: { provider: 'source-service', course_id: course.id, content_sha256: 'b'.repeat(64) },
        citations: [{ body: expect.stringContaining('READY-9'), source_uri: course.source_uri + '#procedure' }] });
      expect(JSON.stringify(out)).not.toContain(issued!.token);
      expect(sourceQuestions).toEqual(['When can I resume?']);
      expect(sourceCalls).not.toContain('export');
      const deleted = await request('request-deletion', { ...common, grant_id: active.grant_id ?? active.id });
      expect(deleted).toMatchObject({ deleted: true, permission_revoked: true, remote_deletion: { status: 'pending' } });
      deletion = { ...deletion, status: 'completed', completed_at: new Date(now).toISOString() };
      expect(await request('deletion-status', { ...common, grant_id: active.grant_id ?? active.id, request_id: deletion.request_id })).toMatchObject({ remote_deletion: { status: 'completed' } });
      await expect(request('source', { ...common, grant_id: active.grant_id ?? active.id, question: 'Resume?' })).rejects.toMatchObject({ status: 403 });
      ownerAllows = false;
      await expect(request('grant', { ...common, mode: 'virtual', permission: { authorized: true, authority: 'authorized-by-owner', retention_minutes: 1 } })).rejects.toMatchObject({ status: 403 });
    } finally {
      store.dispose(); sessions.dispose(); tokens.dispose();
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
      const target = await realpath(directory);
      if (dirname(target) !== await realpath(tmpdir())) throw new Error('Refuse cleanup outside expected temp directory');
      await rm(target, { recursive: true, force: true });
    }
  });
});
