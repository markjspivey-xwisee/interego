import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import jsonld from 'jsonld';
import { parseTrig } from '@interego/core';
import { WorkspaceService, WORKSPACE_ACTIONS as A, MAX_WORKSPACE_REPRESENTATION_BYTES } from '../src/workspace-service.js';
import type { WorkspacePrincipal, WorkspaceRepresentation, WorkspaceStore } from '../src/workspace-types.js';

function fixture() {
  let state: unknown | null = null;
  let fail = false;
  const store: WorkspaceStore = {
    async load() { return structuredClone(state); },
    async save(value, _binding, authorize) { await authorize(); if (fail) throw new Error('disk unavailable'); state = structuredClone(value); },
  };
  const options = { store, binding: async () => 'a'.repeat(64), now: () => Date.parse('2026-10-30T22:00:00Z') };
  return { service: new WorkspaceService(options), options, state: () => state,
    setState: (value: unknown) => { state = value; }, fail: () => { fail = true; } };
}
async function follow(service: WorkspaceService, representation: WorkspaceRepresentation, action: string,
  input?: Record<string, unknown>, principal?: WorkspacePrincipal, target?: string): Promise<WorkspaceRepresentation> {
  const affordance = representation.affordances.find(a => a.action === action && (!target || a.target === target));
  expect(affordance, `Expected advertised action ${action}`).toBeDefined();
  return service.act({ action: affordance!.action, target: affordance!.target, ...(input ? { input } : {}) }, principal);
}
async function room(service: WorkspaceService) {
  const enabled = await follow(service, await service.status(), A.ENABLE);
  return follow(service, enabled, A.CREATE, { title: 'People and agents' });
}
function principal(id: string, workspaceId: string, permission: 'workspaces:read' | 'workspaces:chat' | 'both' = 'both'): WorkspacePrincipal {
  return { id, kind: 'agent', name: 'My selected agent', workspaceIds: [workspaceId],
    permissions: permission === 'both' ? ['workspaces:read', 'workspaces:chat'] : [permission], authorize: async () => undefined };
}
async function join(service: WorkspaceService, view: WorkspaceRepresentation, agent: WorkspacePrincipal, role = 'contributor') {
  await follow(service, view, A.INVITE, { memberId: agent.id, name: agent.name, kind: agent.kind, role });
  const discovered = await service.status(agent);
  return follow(service, discovered, A.ACCEPT, undefined, agent);
}

describe('the optional local Workspace application', () => {
  it('starts off without stored conversations or hidden writes, and requires explicit enabling', async () => {
    const f = fixture(); const initial = await f.service.status();
    expect(initial.enabled).toBe(false); expect(initial.affordances.map(a => a.action)).toEqual([A.ENABLE]);
    expect(initial.workspaces).toBeUndefined(); expect(f.state()).toBeNull();
    await expect(f.service.act({ action: A.CREATE, input: { title: 'hidden' } })).rejects.toThrow(/off/i);
    expect(f.state()).toBeNull();
    expect(initial.federationEnabled).toBe(false); expect(initial.localOnly).toBe(true);
  });

  it('follows real advertised operations, reuses wsp writers and preserves an ordered conversation across service restarts', async () => {
    const f = fixture(); const created = await room(f.service);
    expect(created.workspace?.title).toBe('People and agents');
    expect(parseTrig(created.workspace!.records.workspace).subjects.some(s => s.subject === created.id)).toBe(true);
    await Promise.all([
      follow(f.service, created, A.POST, { body: 'First human words' }),
      follow(f.service, created, A.POST, { body: 'Second human words' }),
    ]);
    const second = new WorkspaceService(f.options);
    const list = await second.status();
    const opened = await follow(second, list, A.READ);
    const entries = opened.workspace!.entries;
    expect(entries.map(e => e.seq)).toEqual([0, 1]); expect(entries[1]!.prior).toBe(entries[0]!.id);
    expect(entries[0]!.author.kind).toBe('human'); expect(entries[0]!.author.name).toBe('You');
    expect(parseTrig(entries[0]!.turtle).subjects.some(s => s.subject === entries[0]!.id)).toBe(true);
    expect(opened.attribution).toBe('authenticated-local-connection');
    expect(opened.transport.kind).toBe('local-capability');
  });

  it('requires both explicit scope and accepted membership, derives authorship, and refuses forged sender fields', async () => {
    const f = fixture(); const owner = await room(f.service); const agent = principal(randomUUID(), owner.id);
    await expect(f.service.act({ action: A.READ, target: owner.id }, agent)).rejects.toThrow(/cannot access/i);
    await follow(f.service, owner, A.INVITE, { memberId: agent.id, name: agent.name, kind: 'agent' });
    const invitation = await f.service.status(agent);
    expect(invitation.workspaces?.[0]?.title).toBe('People and agents');
    expect(invitation.workspace).toBeUndefined(); expect(invitation.affordances.some(a => a.action === A.READ)).toBe(false);
    const joined = await follow(f.service, invitation, A.ACCEPT, undefined, agent);
    const posted = await follow(f.service, joined, A.POST, { body: 'Agent composed these words.' }, agent);
    expect(posted.entry?.author).toMatchObject({ id: agent.id, name: agent.name, kind: 'agent' });
    expect(posted.entry?.turtle).toContain('actedOnOwnAccount');
    await expect(f.service.act({ action: A.POST, target: owner.id, input: { body: 'fake', author: { kind: 'human' } } }, agent)).rejects.toThrow(/unsupported/i);
    await expect(f.service.act({ action: A.READ, target: owner.id }, { ...agent, workspaceIds: [] })).rejects.toThrow(/cannot access/i);
    expect((await follow(f.service, await f.service.status(), A.READ)).workspace?.entries).toHaveLength(1);
  });

  it('a reader cannot post, and revoked or departed members lose both data and affordances', async () => {
    const f = fixture(); const owner = await room(f.service); const agent = principal(randomUUID(), owner.id);
    const joined = await join(f.service, owner, agent, 'reader');
    const audit = await follow(f.service, await f.service.status(), A.READ);
    const roleTerms = parseTrig(audit.workspace!.records.roles).subjects.map(s => s.subject);
    const grantedRoles = audit.workspace!.records.membership.flatMap(t => parseTrig(t).subjects.flatMap(s =>
      (s.properties.get('https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#role') ?? []).map(term => {
        expect(term.kind).toBe('iri');
        if (term.kind !== 'iri') throw new Error('A membership role must name its published role IRI.');
        return term.iri;
      })));
    expect(grantedRoles.length).toBeGreaterThan(1);
    expect(grantedRoles.every(role => roleTerms.includes(role))).toBe(true);
    expect(joined.workspace!.auditRecordsOmitted).toBe(true);
    expect(joined.workspace!.records.membership).toEqual([]);
    expect(joined.affordances.some(a => a.action === A.POST)).toBe(false);
    await expect(f.service.act({ action: A.POST, target: owner.id, input: { body: 'forbidden' } }, agent)).rejects.toThrow(/cannot access/i);
    const ownerRead = await follow(f.service, await f.service.status(), A.READ);
    await follow(f.service, ownerRead, A.REVOKE);
    expect((await f.service.status(agent)).workspaces).toEqual([]);
    await expect(f.service.act({ action: A.READ, target: owner.id }, agent)).rejects.toThrow(/cannot access/i);
    const freshOwner = await follow(f.service, await f.service.status(), A.READ);
    const rejoined = await join(f.service, freshOwner, agent);
    await follow(f.service, rejoined, A.LEAVE, undefined, agent);
    expect((await f.service.status(agent)).workspaces).toEqual([]);
  });

  it('a chat-only member discovers posting without receiving conversation data', async () => {
    const f = fixture(); const owner = await room(f.service); const agent = principal(randomUUID(), owner.id, 'workspaces:chat');
    const joined = await join(f.service, owner, agent);
    expect(joined.workspace).toBeUndefined();
    const discovered = await f.service.status(agent);
    expect(discovered.affordances.some(a => a.action === A.POST && a.target === owner.id)).toBe(true);
    expect(discovered.affordances.some(a => a.action === A.READ)).toBe(false);
    const sent = await follow(f.service, discovered, A.POST, { body: 'Can append, cannot read history' }, agent);
    expect(sent.entry!.author.id).toBe(agent.id); expect(sent.workspace).toBeUndefined();
    await expect(f.service.act({ action: A.READ, target: owner.id }, agent)).rejects.toThrow(/cannot access/);
  });

  it('scope revocation is checked at execution and before returning private content', async () => {
    const f = fixture(); const owner = await room(f.service); const agent = principal(randomUUID(), owner.id);
    await join(f.service, owner, agent);
    let calls = 0;
    const expiring: WorkspacePrincipal = { ...agent, authorize: async () => { if (++calls === 2) throw new Error('connection expired'); } };
    await expect(f.service.act({ action: A.POST, target: owner.id, input: { body: 'Must not append' } }, expiring)).rejects.toThrow(/expired/);
    expect((await follow(f.service, await f.service.status(), A.READ)).workspace!.entries).toHaveLength(0);
    calls = 0;
    await expect(f.service.act({ action: A.READ, target: owner.id }, expiring)).rejects.toThrow(/expired/);
  });

  it('revalidates both agent grants and guarded owner consent inside the storage commit', async () => {
    const f = fixture(); const owner = await room(f.service); const agent = principal(randomUUID(), owner.id);
    await join(f.service, owner, agent);
    let checks = 0;
    const revoked = { ...agent, authorize: async () => { if (++checks === 3) throw new Error('revoked at storage commit'); } };
    await expect(f.service.act({ action: A.POST, target: owner.id, input: { body: 'Cannot commit' } }, revoked)).rejects.toThrow(/storage commit/);
    expect((await follow(f.service, await f.service.status(), A.READ)).workspace!.entries).toHaveLength(0);
    checks = 0;
    await expect(f.service.act({ action: A.INVITE, target: owner.id,
      input: { memberId: 'discord:456789', kind: 'discord', name: 'Paused link' } }, undefined,
    async () => { if (++checks === 3) throw new Error('Discord consent paused at storage commit'); })).rejects.toThrow(/storage commit/);
    expect((await follow(f.service, await f.service.status(), A.READ)).workspace!.members).toHaveLength(2);
  });

  it('an owner pause invalidates already queued agent work and keeps durable data available after re-enabling', async () => {
    const f = fixture(); const owner = await room(f.service); const agent = principal(randomUUID(), owner.id);
    await join(f.service, owner, agent);
    const rootId = (await f.service.status()).id;
    const paused = new Promise<void>(resolve => { setTimeout(resolve, 15); });
    const slow = { ...agent, authorize: async () => paused };
    const pending = f.service.act({ action: A.POST, target: owner.id, input: { body: 'Should be cancelled' } }, slow);
    const disable = f.service.act({ action: A.DISABLE, target: rootId });
    await expect(pending).rejects.toThrow(/permissions changed|off/i); await disable;
    expect((await f.service.status(agent)).workspaces).toBeUndefined();
    const enabled = await follow(f.service, await f.service.status(), A.ENABLE);
    expect((await follow(f.service, enabled, A.READ)).workspace!.entries).toHaveLength(0);
  });

  it('Discord deduplication survives restarts and cannot be borrowed by an agent', async () => {
    const f = fixture(); const owner = await room(f.service);
    const external: WorkspacePrincipal = { ...principal(randomUUID(), owner.id), id: 'discord:123456789', kind: 'discord', name: 'Linked participant' };
    const joined = await join(f.service, owner, external);
    const posted = await follow(f.service, joined, A.POST, { body: 'I typed this in Discord.', sourceId: 'discord-message-1' }, external);
    const second = new WorkspaceService(f.options);
    const retried = await second.act({ action: A.POST, target: owner.id, input: { body: 'I typed this in Discord.', sourceId: 'discord-message-1' } }, external);
    expect(retried.entry?.id).toBe(posted.entry?.id); expect(retried.workspace?.entries).toHaveLength(1);
    await expect(second.act({ action: A.POST, target: owner.id, input: { body: 'Changed text', sourceId: 'discord-message-1' } }, external)).rejects.toThrow(/different text/);
    const agent = principal(randomUUID(), owner.id); await join(second, await follow(second, await second.status(), A.READ), agent);
    await expect(second.act({ action: A.POST, target: owner.id, input: { body: 'borrowed', sourceId: 'discord-message-1' } }, agent)).rejects.toThrow(/unsupported/);
  });

  it('failed persistence never becomes an in-memory success and damaged chains fail closed', async () => {
    const f = fixture(); const owner = await room(f.service); f.fail();
    await expect(follow(f.service, owner, A.POST, { body: 'Not saved' })).rejects.toThrow(/disk unavailable/);
    expect((await follow(f.service, await f.service.status(), A.READ)).workspace!.entries).toHaveLength(0);
    const other = fixture(); const created = await room(other.service); await follow(other.service, created, A.POST, { body: 'Recorded' });
    const raw = structuredClone(other.state()) as { rooms: { entries: { body: string }[] }[] };
    raw.rooms[0]!.entries[0]!.body = 'Replaced'; other.setState(raw);
    await expect(other.service.status()).rejects.toThrow(/chain was changed/);
  });

  it('expands advertised action IRIs, targets, inline schemas and connection attribution as genuine JSON-LD without remote contexts', async () => {
    const f = fixture(); const owner = await room(f.service); const agent = principal(randomUUID(), owner.id);
    const joined = await join(f.service, owner, agent);
    const posted = await follow(f.service, joined, A.POST, { body: 'Linked data with an actual connection author' }, agent);
    const expanded = await jsonld.expand(posted as never, { documentLoader: (async () => { throw new Error('No remote context is allowed.'); }) as never }) as unknown as Record<string, unknown>[];
    const node = expanded[0]!;
    const operations = node['https://markjspivey-xwisee.github.io/interego/ns/iep#affordance'] as Record<string, unknown>[];
    const post = operations.find(o => JSON.stringify(o['https://markjspivey-xwisee.github.io/interego/ns/iep#action']).includes(A.POST));
    expect(post).toBeDefined();
    expect(post!['http://www.w3.org/ns/hydra/core#target']).toEqual([{ '@id': owner.id }]);
    expect(post!['http://www.w3.org/ns/hydra/core#method']).toEqual([{ '@value': 'POST' }]);
    expect(post!['http://www.w3.org/ns/hydra/core#expects']).toEqual([{ '@type': '@json', '@value': expect.objectContaining({ type: 'object', additionalProperties: false }) }]);
    const serialized = JSON.stringify(expanded);
    expect(serialized).toContain('https://schema.org/identifier');
    expect(serialized).toContain(agent.id);
    expect(serialized).not.toContain(`"@id":"${agent.id}"`);
    expect(serialized).toContain('http://www.w3.org/ns/prov#wasAttributedTo');
  });

  it('pages large UTF-8 conversations within the complete transport budget, without losing entries between cursors', async () => {
    const f = fixture(); const owner = await room(f.service);
    const body = '\u0800'.repeat(15_000);
    for (let index = 0; index < 32; index++) {
      const sent = await f.service.act({ action: A.POST, target: owner.id, input: { body: `${index}: ${body}` } });
      expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(MAX_WORKSPACE_REPRESENTATION_BYTES);
    }
    const agent = principal(randomUUID(), owner.id);
    const accepted = await join(f.service, await follow(f.service, await f.service.status(), A.READ), agent);
    expect(Buffer.byteLength(JSON.stringify(accepted))).toBeLessThanOrEqual(MAX_WORKSPACE_REPRESENTATION_BYTES);
    expect(accepted.page).toMatchObject({ endSeq: 31, total: 32, hasEarlier: true, hasLater: false });
    expect(accepted.workspace!.entries.length).toBeLessThan(20);
    const discovered = await f.service.status(agent);
    const read = discovered.affordances.find(a => a.action === A.READ)!;
    expect(read.inputSchema).toMatchObject({ properties: { afterSeq: { minimum: -1 }, beforeSeq: { minimum: 0 }, limit: { maximum: 50 } } });
    const observed: number[] = []; let cursor = -1;
    while (true) {
      const next = await follow(f.service, discovered, A.READ, { afterSeq: cursor, limit: 50 }, agent);
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(MAX_WORKSPACE_REPRESENTATION_BYTES);
      expect(next.page!.startSeq).toBe(cursor + 1);
      observed.push(...next.workspace!.entries.map(e => e.seq));
      cursor = next.page!.endSeq!;
      if (!next.page!.hasLater) break;
    }
    expect(observed).toEqual(Array.from({ length: 32 }, (_, index) => index));
    const older = await follow(f.service, discovered, A.READ, { beforeSeq: accepted.page!.startSeq!, limit: 50 }, agent);
    expect(older.page!.endSeq).toBe(accepted.page!.startSeq! - 1);
    const newer = await follow(f.service, discovered, A.READ, { afterSeq: older.page!.endSeq!, limit: 50 }, agent);
    expect(newer.page!.startSeq).toBe(accepted.page!.startSeq);
    for (const input of [{ limit: 0 }, { limit: 51 }, { afterSeq: -2 }, { beforeSeq: -1 }, { afterSeq: 2.5 }, { afterSeq: 4, beforeSeq: 3 }]) {
      await expect(follow(f.service, discovered, A.READ, input, agent)).rejects.toThrow(/cursor|window|page size/i);
    }
    const sent = await follow(f.service, accepted, A.POST, { body }, agent);
    expect(sent.entry!.seq).toBe(32);
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(MAX_WORKSPACE_REPRESENTATION_BYTES);
    const restarted = new WorkspaceService(f.options);
    const tail = await restarted.act({ action: A.READ, target: owner.id, input: { afterSeq: 31, limit: 1 } }, agent);
    expect(tail.page).toMatchObject({ startSeq: 32, endSeq: 32, total: 33, hasEarlier: true, hasLater: false });
  });
});
