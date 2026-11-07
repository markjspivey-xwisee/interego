import { describe, expect, it, vi } from 'vitest';
import { CourseSourceService, LtiCourseSourceTokens, type SourcePrincipal, type SourceOwnerPermission, type SourceDeletionReceipt } from '../src/i2idlx-course-source-service.js';
import type { VerifiedResourceLaunch } from '../src/lti13.js';

const protocol = 'i2idlx-course-source/1';
const course = { id: 'source-course', title: 'Source-owned procedure', version: 'v2', source_uri: 'https://source.example/courses/source-course' };
const actor = 'did:web:identity.example:agents:learner';
const launch: VerifiedResourceLaunch = { issuer: 'https://lms.example', clientId: 'tool-client', deploymentId: 'deployment-one',
  sub: 'lms-user', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
  context: { id: 'lms-course' }, resourceLink: { id: 'link-one' }, custom: {} };
function fixture() {
  let now = Date.parse('2026-11-07T12:00:00Z');
  let authorized = true;
  const principal: SourcePrincipal = { actor, course, expires_at: new Date(now + 60_000).toISOString() };
  let permission: SourceOwnerPermission | null = { id: 'owner-grant-one', owner: 'did:web:source.example:owner',
    expires_at: new Date(now + 60_000).toISOString(), permissions: ['read-passages', 'share-with-paired-agent', 'request-deletion'] };
  let deletion: SourceDeletionReceipt = { request_id: 'delete-one', course_id: course.id, version: course.version,
    status: 'pending', scope: 'derived-content', requested_at: new Date(now).toISOString() };
  const context = vi.fn(async () => ({ source: { course_id: course.id, title: course.title, version: course.version,
    source_uri: course.source_uri, content_sha256: 'a'.repeat(64), kind: 'source-owned course' },
    sections: [{ id: 'procedure', title: 'Procedure', body: 'Record BLUE-27. Resume only at READY-9.',
      source_uri: course.source_uri + '#procedure', locator: 'procedure', assessment: false }],
    graph: { nodes: [{ id: 'procedure', label: 'Procedure', section_id: 'procedure' }], edges: [] },
  }));
  const service = new CourseSourceService({ providerName: 'Owner source', now: () => now,
    authenticate: token => authorized && token === 'source-scoped-token' ? principal : null,
    permission: async () => permission, context,
    requestDeletion: async (...args) => deleteCalls(...args), deletionStatus: async () => deletion });
  const deleteCalls = vi.fn(async (_principal: SourcePrincipal, _signal: AbortSignal | undefined, _key: string) => deletion);
  const request = (operation: string, extra: Record<string, unknown> = {}, who = actor, token = 'source-scoped-token') => service.request({ protocol, actor: who, operation,
    ...(!['capabilities', 'courses'].includes(operation) ? { course_id: course.id, version: course.version } : {}), ...extra }, token);
  return { request, context, principal, deleteCalls, revokeToken: () => { authorized = false; }, revoke: () => { permission = null; }, permission: (v: SourceOwnerPermission | null) => { permission = v; },
    expire: () => { now += 60_001; }, complete: () => { deletion = { ...deletion, status: 'completed', completed_at: new Date(now).toISOString() }; } };
}

describe('source-resident course service', () => {
  it('retrieves only question passages from the owner source, without package or storage operations', async () => {
    const f = fixture();
    expect(await f.request('courses')).toMatchObject({ courses: [{ ...course, access_modes: ['virtual'] }] });
    expect(await f.request('permission')).toMatchObject({ grant: { id: 'owner-grant-one', actor, access_modes: ['virtual'] } });
    const out = await f.request('context', { grant_id: 'owner-grant-one', question: 'When can I resume?' });
    expect(out).toMatchObject({ protocol, retrieval: { scope: 'question-passages' }, sections: [{ assessment: false, body: expect.stringContaining('READY-9') }] });
    expect(f.context).toHaveBeenCalledWith(f.principal, 'When can I resume?', undefined);
    expect(JSON.stringify(out)).not.toContain('source-scoped-token');
    expect(await f.request('capabilities')).toMatchObject({ access_modes: ['virtual'] });
  });

  it('rejects foreign actors, course versions, forged LTI data and revoked or expired owner grants', async () => {
    const f = fixture();
    await expect(f.request('permission', {}, 'did:web:other.example:agent')).rejects.toMatchObject({ status: 403 });
    await expect(f.request('permission', { version: 'v3' })).rejects.toMatchObject({ status: 403 });
    await expect(f.request('permission', { lti: launch })).rejects.toMatchObject({ status: 400 });
    await expect(f.request('context', { grant_id: 'forged', question: 'Resume?' })).rejects.toMatchObject({ status: 409 });
    f.revoke();
    await expect(f.request('context', { grant_id: 'owner-grant-one', question: 'Resume?' })).rejects.toMatchObject({ status: 403 });
    expect(f.context).not.toHaveBeenCalled();
    const expired = fixture(); expired.expire();
    await expect(expired.request('permission')).rejects.toMatchObject({ status: 403 });
  });

  it('rechecks owner permission after an in-flight source read before releasing content', async () => {
    const f = fixture();
    f.context.mockImplementationOnce(async () => { f.revoke(); return { source: { course_id: course.id, title: course.title, version: course.version,
      source_uri: course.source_uri, content_sha256: 'a'.repeat(64), kind: 'course' }, sections: [], graph: { nodes: [], edges: [] } }; });
    await expect(f.request('context', { grant_id: 'owner-grant-one', question: 'Resume?' })).rejects.toMatchObject({ status: 403 });
  });

  it('rejects assessment-marked content and oversized source extracts', async () => {
    const f = fixture();
    const original = await f.context();
    f.context.mockResolvedValueOnce({ ...original, sections: [{ ...original.sections[0]!, assessment: true }] });
    await expect(f.request('context', { grant_id: 'owner-grant-one', question: 'Resume?' })).rejects.toMatchObject({ status: 502 });
    f.context.mockResolvedValueOnce({ ...original, sections: [{ ...original.sections[0]!, body: 'x'.repeat(6001) }] });
    await expect(f.request('context', { grant_id: 'owner-grant-one', question: 'Resume?' })).rejects.toMatchObject({ status: 502 });
  });

  it('coalesces the same deletion key and allows deletion-only permission after reading is revoked', async () => {
    const f = fixture();
    f.permission({ id: 'owner-grant-one', owner: 'did:web:source.example:owner', expires_at: f.principal.expires_at, permissions: ['request-deletion'] });
    await expect(f.request('context', { grant_id: 'owner-grant-one', question: 'Resume?' })).rejects.toMatchObject({ status: 403 });
    const results = await Promise.all([1, 2].map(() => f.request('request-deletion', { grant_id: 'owner-grant-one', idempotency_key: 'same-key' })));
    expect(results[0]).toEqual(results[1]);
    expect(f.deleteCalls).toHaveBeenCalledTimes(1);
    expect(f.deleteCalls.mock.calls[0]?.[2]).toBe('same-key');
  });

  it('does not release an in-flight passage after its source credential is revoked', async () => {
    const f = fixture();
    const content = await f.context();
    f.context.mockImplementationOnce(async () => { f.revokeToken(); return content; });
    await expect(f.request('context', { grant_id: 'owner-grant-one', question: 'Resume?' })).rejects.toMatchObject({ status: 403 });
  });

  it('distinguishes requested deletion from provider-confirmed completion, scoped to derived content', async () => {
    const f = fixture();
    expect(await f.request('request-deletion', { grant_id: 'owner-grant-one', idempotency_key: 'stable-request-one' })).toMatchObject({ receipt: { status: 'pending', scope: 'derived-content' } });
    expect(await f.request('deletion-status', { request_id: 'delete-one' })).toMatchObject({ receipt: { status: 'pending' } });
    await expect(f.request('deletion-status', { request_id: 'another-user-receipt' })).rejects.toMatchObject({ status: 502 });
    f.complete();
    expect(await f.request('deletion-status', { request_id: 'delete-one' })).toMatchObject({ receipt: { status: 'completed', completed_at: expect.any(String) } });
    await expect(f.request('delete-course')).rejects.toMatchObject({ status: 400 });
  });
});

describe('LTI-to-source grant handoff', () => {
  it('uses the verified launch callback identity and a separate owner decision, never a role as permission', async () => {
    let permitted = false;
    const tokens = new LtiCourseSourceTokens({ actorForLaunch: async l => l.issuer === launch.issuer && l.sub === launch.sub ? actor : null,
      courseForLaunch: async l => l.resourceLink?.id === 'link-one' ? course : null,
      ownerPermitsLaunch: async () => permitted, now: () => Date.parse('2026-11-07T12:00:00Z') });
    expect(await tokens.issueForVerifiedLaunch({ ...launch, roles: ['Instructor'] })).toBeNull();
    permitted = true;
    const issued = await tokens.issueForVerifiedLaunch(launch);
    expect(issued?.principal).toMatchObject({ actor, course, lti: { issuer: launch.issuer, deployment_id: launch.deploymentId,
      context_id: 'lms-course', resource_link_id: 'link-one' } });
    expect(tokens.authenticate(issued!.token)).toEqual(issued!.principal);
    issued!.principal.actor = 'caller-mutated';
    expect(tokens.authenticate(issued!.token)?.actor).toBe(actor);
    tokens.revoke(issued!.token);
    expect(tokens.authenticate(issued!.token)).toBeNull();
    tokens.dispose();
  });
});
