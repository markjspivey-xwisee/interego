import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { SourceCourseProvider, SourceProviderError, SOURCE_COURSE_PROTOCOL as protocol,
  isPublicSourceAddress, sourceServiceUrl, sourceConnectionAddresses, pinnedSourceTransport,
  type SourceCourse, type SourceGrant, type SourceTransport } from '../src/i2idlx-course-provider.js';

const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
const now = Date.parse('2026-11-07T12:00:00Z');
const actor = 'did:web:identity.example:agents:alice';
const course: SourceCourse = { id: 'course-1', title: 'Source fixture', version: 'v2', standard: 'External',
  source_uri: 'https://source.example/courses/1', access_modes: ['virtual'] };
const grant: SourceGrant = { id: 'permission-1', owner: 'did:web:source.example:owner', actor,
  course_id: course.id, version: course.version, expires_at: new Date(now + 60_000).toISOString(),
  access_modes: ['virtual'], permissions: ['read-passages', 'share-with-paired-agent', 'request-deletion'] };
const capabilities = { protocol, access_modes: ['virtual'], operations: ['courses', 'permission', 'context', 'request-deletion', 'deletion-status'] };
const context = () => ({ protocol, grant: structuredClone(grant), source: { course_id: course.id, title: course.title,
  version: course.version, source_uri: course.source_uri, content_sha256: 'a'.repeat(64), kind: 'External course' },
sections: [{ id: 'intro', title: 'Procedure', body: 'Record BLUE-27.', source_uri: 'https://source.example/courses/1/intro', locator: 'intro', assessment: false }],
retrieval: { scope: 'question-passages' }, missing_context: ['One selected instructional passage.'],
graph: { nodes: [{ id: 'beacon', label: 'Training beacon', section_id: 'intro' }], edges: [] } });
function fixture(override?: (operation: string, request: Record<string, unknown>) => unknown) {
  const calls: Array<{ operation: string; request: Record<string, unknown>; endpoint: string; headers: Readonly<Record<string, string>> }> = [];
  const transport: SourceTransport = async (url, body, headers) => {
    const request = JSON.parse(body.toString('utf8')) as Record<string, unknown>, operation = String(request.operation);
    calls.push({ operation, request, endpoint: url.href, headers });
    const raw = override?.(operation, request) ?? (operation === 'capabilities' ? capabilities : operation === 'courses'
      ? { protocol, courses: [course] } : operation === 'permission' ? { protocol, grant } : context());
    return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(raw)) };
  };
  const provider = new SourceCourseProvider({ service_url: 'https://source.example/course-service', token: 'SCOPED-SOURCE-TOKEN' }, { actor, now: () => now, transport });
  return { provider, calls };
}
beforeEach(() => { mocks.request.mockReset(); mocks.lookup.mockReset(); });

describe('source-resident course protocol', () => {
  it('discovers a runtime catalog and retrieves bounded cited passages after a fresh owner permission check every time', async () => {
    const f = fixture();
    expect(await f.provider.courses()).toEqual({ courses: [course] });
    const first = await f.provider.source(course, 'What code do I record?');
    expect(first).toMatchObject({ source: { provider: 'source-service', content_sha256: 'a'.repeat(64) },
      material: { kind: 'External course', sections: [{ body: 'Record BLUE-27.', locator: 'intro' }] }, grant,
      graph: { nodes: [{ id: 'beacon', section_id: 'intro' }] } });
    expect(JSON.stringify(first)).not.toContain('SCOPED-SOURCE-TOKEN');
    const second = await f.provider.source(course, 'Who does this notify?');
    expect(second.material.id).toBe(first.material.id);
    expect(f.calls.map(c => c.operation)).toEqual(['capabilities', 'courses', 'permission', 'context', 'permission', 'context']);
    expect(f.calls.every(c => c.endpoint === 'https://source.example/course-service')).toBe(true);
    expect(f.calls.every(c => c.headers.Authorization === 'Bearer SCOPED-SOURCE-TOKEN')).toBe(true);
    expect(f.calls.every(c => c.request.actor === actor)).toBe(true);
    expect(f.calls.some(c => /package|export|zip/.test(c.operation))).toBe(false);
  });
  it.each([
    { ...grant, actor: 'did:web:identity.example:agents:bob' },
    { ...grant, version: 'v3' },
    { ...grant, course_id: 'other' },
    { ...grant, expires_at: new Date(now).toISOString() },
    { ...grant, permissions: ['read-passages'] },
    { ...grant, access_modes: ['cached'] },
  ])('refuses an unauthorized, expired or differently scoped provider grant before retrieval', async bad => {
    const f = fixture(op => op === 'permission' ? { protocol, grant: bad } : undefined);
    await expect(f.provider.source(course, 'Question')).rejects.toBeInstanceOf(SourceProviderError);
    expect(f.calls.map(c => c.operation)).toEqual(['permission']);
  });
  it('refuses permission changes between authorization and context and does not fall back', async () => {
    const f = fixture(op => op === 'context' ? { ...context(), grant: { ...grant, id: 'new-grant' } } : undefined);
    await expect(f.provider.source(course, 'Question')).rejects.toMatchObject({ code: 'course_permission_required' });
    expect(f.calls.map(c => c.operation)).toEqual(['permission', 'context']);
  });
  it.each(['assessment', 'different-course', 'unbounded', 'whole-export', 'unbound-graph'])('rejects %s context', async kind => {
    const f = fixture(op => {
      if (op !== 'context') return undefined;
      const value = context();
      if (kind === 'assessment') value.sections[0]!.assessment = true;
      if (kind === 'different-course') value.source.course_id = 'other';
      if (kind === 'unbounded') value.sections[0]!.body = 'x'.repeat(6001);
      if (kind === 'whole-export') value.retrieval.scope = 'whole-course';
      if (kind === 'unbound-graph') value.graph.nodes[0]!.section_id = 'absent';
      return value;
    });
    await expect(f.provider.source(course, 'Question')).rejects.toBeInstanceOf(SourceProviderError);
  });
  it('treats LTI context only as the source service grant attestation and requires passage-sharing permission too', async () => {
    const lti = { issuer: 'https://lms.example', client_id: 'client', deployment_id: 'deployment', context_id: 'course', resource_link_id: 'resource', verified_at: new Date(now).toISOString() };
    const f = fixture(op => op === 'permission' ? { protocol, grant: { ...grant, lti } }
      : op === 'context' ? { ...context(), grant: { ...grant, lti } } : undefined);
    const value = await f.provider.source(course, 'Question');
    expect(value.source.lti).toEqual(lti);
    const { context_id: _context, ...resourceOnly } = lti;
    const resourceLaunch = fixture(op => op === 'permission' ? { protocol, grant: { ...grant, lti: resourceOnly } }
      : op === 'context' ? { ...context(), grant: { ...grant, lti: resourceOnly } } : undefined);
    expect((await resourceLaunch.provider.source(course, 'Question')).source.lti).toEqual(resourceOnly);
    const bad = fixture(op => op === 'permission' ? { protocol, grant: { ...grant, permissions: ['lti-launch'], lti } } : undefined);
    await expect(bad.provider.source(course, 'Question')).rejects.toMatchObject({ code: 'course_permission_required' });
  });
  it('keeps pending deletion distinct from completed readback and never deletes original courses', async () => {
    let completed = false;
    const f = fixture((op, request) => op === 'request-deletion' || op === 'deletion-status' ? { protocol, receipt: {
      request_id: 'request-1', course_id: course.id, version: course.version, scope: 'derived-content',
      status: completed ? 'completed' : 'pending', requested_at: new Date(now).toISOString(),
      ...(completed ? { completed_at: new Date(now + 1000).toISOString() } : {}),
    } } : undefined);
    expect((await f.provider.requestDeletion(course, grant)).status).toBe('pending');
    completed = true;
    expect((await f.provider.deletionStatus(course, 'request-1')).status).toBe('completed');
    expect(f.calls.map(c => c.operation)).toEqual(['request-deletion', 'deletion-status']);
    expect(JSON.stringify(f.calls)).not.toContain('delete-course');
  });
  it('rejects unsupported redirects, MIME types and overlarge bodies without exposing credentials', async () => {
    for (const [status, contentType, body] of [[302, 'application/json', '{}'], [200, 'application/zip', '{}'], [200, 'application/json', 'x'.repeat(192_001)]] as const) {
      const provider = new SourceCourseProvider({ service_url: 'https://source.example/endpoint', token: 'SECRET' }, {
        actor, transport: async () => ({ status, headers: { 'content-type': contentType }, body: Buffer.from(body) }),
      });
      await expect(provider.permission(course)).rejects.toBeInstanceOf(SourceProviderError);
    }
  });
  it('aborts in-flight retrieval on dispose and never invokes the transport afterward', async () => {
    const transport = vi.fn<SourceTransport>(async (_url, _body, _headers, signal) => {
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      throw new Error('unreachable');
    });
    const provider = new SourceCourseProvider({ service_url: 'https://source.example/endpoint', token: 'SECRET' }, { actor, transport });
    const result = provider.permission(course);
    provider.dispose();
    await expect(result).rejects.toBeInstanceOf(SourceProviderError);
    await expect(provider.permission(course)).rejects.toMatchObject({ code: 'course_connection_expired' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('source service HTTPS address safety', () => {
  it.each(['http://example.com/path', 'https://user:pass@example.com/path', 'https://example.com/path?token=secret', 'https://example.com/#x',
    'https://localhost', 'https://127.0.0.1', 'https://2130706433', 'https://0x7f000001', 'https://169.254.169.254', 'https://[::ffff:127.0.0.1]',
    'https://foo.internal/path', 'https://foo.local/path', 'https://example.com:8443/path'])('refuses %s before connection', value => {
    expect(() => sourceServiceUrl(value)).toThrow(SourceProviderError);
  });
  it.each(['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '100.64.0.1', '169.254.169.254', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '::', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:db8::1',
    '2001::1', '2001:0000:0000:0000:0000:0000:0000:0001'])('rejects non-global address %s', ip => {
    expect(isPublicSourceAddress(ip)).toBe(false);
  });
  it('rejects mixed public/private DNS answers and accepts only a wholly public set', async () => {
    await expect(sourceConnectionAddresses('source.example', async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }])).rejects.toMatchObject({ code: 'course_provider_address_refused' });
    const addresses = [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
    expect(await sourceConnectionAddresses('source.example', async () => addresses)).toEqual(addresses);
  });
  it('wires screening into native HTTPS connect-time lookup so no second resolver can rebind the host', async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    let connected: unknown;
    mocks.request.mockImplementation((_url, options, respond) => {
      const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: () => void; destroy: () => void };
      req.setTimeout = () => {}; req.destroy = () => {};
      req.end = () => {
        options.lookup('source.example', { all: true }, (error: Error | null, addresses: unknown) => {
          if (error) { req.emit('error', error); return; }
          connected = addresses;
          const res = Readable.from([Buffer.from('{"ok":true}')]) as Readable & { statusCode: number; headers: Record<string, string> };
          res.statusCode = 200; res.headers = { 'content-type': 'application/json' }; respond(res);
        });
      };
      return req;
    });
    const result = await pinnedSourceTransport(new URL('https://source.example/endpoint'), Buffer.from('{}'), {}, new AbortController().signal);
    expect(result.status).toBe(200);
    expect(connected).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0]![1]).toMatchObject({ method: 'POST', agent: false });
    connected = undefined;
    await expect(pinnedSourceTransport(new URL('https://source.example/endpoint'), Buffer.from('{}'), {}, new AbortController().signal))
      .rejects.toMatchObject({ code: 'course_provider_address_refused' });
    expect(connected).toBeUndefined();
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });
});
