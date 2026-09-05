import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { loadResourceCompositions, resourceInvocation, ResourceCompositions, type ResourceComposition, type ResourceWriteContext } from '../deploy/mcp-relay/resource-compositions.js';
import application from '../integrations/application-runtime/resource-composition.js';
import { parseSignedJsonDocument } from '../integrations/application-runtime/application-lab-runtime.js';
import { fixtureStore } from '../examples/application-simulation/fixture-store.js';
import { releaseControl, ticTacToe, type RulePack } from '../examples/application-simulation/rule-packs.js';

async function setup(pack: RulePack = releaseControl()) {
  const store = fixtureStore(pack);
  const resolved = await store.resolve();
  const publish = vi.fn(async () => { throw new Error('no write permitted'); });
  const context: ResourceWriteContext = {
    reads: { ...store.reads, discover: store.reads.discoverCatalogs },
    principal: 'did:example:alice', identityUrl: 'https://identity.example', now: '2026-09-05T12:00:00.000Z', publish,
  };
  const registry = new ResourceCompositions([application]);
  const view = await registry.render(resolved.catalogDescriptor.url, context, resolved.catalogDescriptor);
  if (!view) throw new Error('missing view');
  const control = (label: string) => view.controls.find(c => String(c['label']).startsWith(label))!;
  return { store, resolved, registry, view, control, context, publish };
}

describe('optional resource compositions', () => {
  it('resolves both act forms consistently without widening the compatibility shim', () => {
    expect(resourceInvocation({ target: 'urn:view', action: 'urn:read' }, true)).toEqual({ reference: 'urn:view', action: 'urn:read' });
    expect(resourceInvocation({ target: 'urn:view', action: 'urn:read' })).toBeUndefined();
    expect(resourceInvocation({ descriptor_url: 'urn:exact', action_iri: 'urn:exact-action', target: 'urn:other', action: 'urn:other-action' }, true))
      .toEqual({ reference: 'urn:exact', action: 'urn:exact-action' });
    expect(resourceInvocation({ descriptor_url: 'urn:exact', action_iri: ['urn:read'] })).toBeUndefined();
  });
  it('has no domain installed by default, and never imports modules from remote documents', async () => {
    const { context, resolved } = await setup();
    const neutral = await loadResourceCompositions();
    expect(await neutral.render(resolved.catalogDescriptor.url, context, resolved.catalogDescriptor)).toBeUndefined();
    await expect(loadResourceCompositions('["https://untrusted.example/runtime.js"]')).rejects.toThrow('local files');
    await expect(loadResourceCompositions('{}')).rejects.toThrow('JSON array');
    const relay = readFileSync(new URL('../deploy/mcp-relay/server.ts', import.meta.url), 'utf8');
    expect(relay).not.toMatch(/open_application_lab|preview_application_action|execute_application_action|application-lab|urn:interego:application|interego\.application\./);
    const docker = readFileSync(new URL('../deploy/Dockerfile.relay', import.meta.url), 'utf8');
    expect(docker.trim().endsWith('FROM base-runtime AS runtime')).toBe(true);
    expect(docker).toContain('FROM base-runtime AS reference');
  });

  it('removes publishing capability at runtime for rendering and read invocations', async () => {
    const { context, publish } = await setup();
    const seen: unknown[] = [];
    const probe: ResourceComposition = {
      claims: ref => ref === 'urn:test:probe', access: (_ref, action) => action === 'urn:test:read' ? 'read' : undefined,
      render: async (_ref, ctx) => { seen.push(ctx); return undefined; },
      invoke: async (_ref, _action, _payload, ctx) => { seen.push(ctx); return {}; },
    };
    const registry = new ResourceCompositions([probe]);
    await registry.render('urn:test:probe', context);
    await registry.invoke('urn:test:probe', 'urn:test:read', {}, context);
    expect(seen).toHaveLength(2);
    for (const ctx of seen) expect(ctx).not.toHaveProperty('publish');
    await expect(registry.invoke('urn:test:probe', 'urn:test:undeclared', {}, context)).rejects.toThrow('not declared');
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([['release', releaseControl], ['game', ticTacToe]] as const)('projects %s from its catalog without registering tools', async (_label, pack) => {
    const { view, resolved, registry, context, publish } = await setup(pack());
    expect(view.snapshot).toMatchObject({ application: { applicationId: resolved.definition.id }, trust: { verified: true } });
    expect(view.controls.filter(c => c['method'] === 'POST').map(c => c['action'])).toEqual(resolved.activeContract.actions.map(a => a.actionIri));
    expect(view.authorship).toBeNull();
    expect(view.derivedFrom).toBeTruthy();
    expect(await registry.render(view.descriptorUrl, context)).toMatchObject({ descriptorUrl: view.descriptorUrl });
    expect(publish).not.toHaveBeenCalled();
  });

  it('previews through generic invocation with bound head, contract and actor, without writes', async () => {
    const { registry, control, context, publish, store } = await setup();
    const selected = control('Preview: Approve');
    expect(registry.access(String(selected['descriptorUrl']), String(selected['action']))).toBe('read');
    const before = JSON.stringify({ heads: [...store.heads], history: store.history, descriptors: [...store.descriptors] });
    const result = await registry.invoke(String(selected['descriptorUrl']), String(selected['action']), {}, context);
    expect(result).toMatchObject({ committed: false, basis: { actor: context.principal, at: context.now }, replay: { complete: true } });
    expect(JSON.stringify({ heads: [...store.heads], history: store.history, descriptors: [...store.descriptors] })).toBe(before);
    expect(publish).not.toHaveBeenCalled();
    await expect(registry.invoke(String(selected['descriptorUrl']), String(selected['action']), { actor: 'did:example:mallory' }, context)).rejects.toThrow('signed action inputs');
    await expect(registry.invoke(String(selected['descriptorUrl']), String(selected['action']), {}, { ...context, principal: '' })).rejects.toThrow('authenticated');
  });

  it('refuses mismatched, malformed, stale and fabricated action references', async () => {
    const { registry, control, context, resolved, publish } = await setup();
    const selected = control('Preview: Approve');
    const url = String(selected['descriptorUrl']);
    const prefix = url.slice(0, url.lastIndexOf(':') + 1);
    const ref = JSON.parse(Buffer.from(url.slice(prefix.length), 'base64url').toString());
    const alter = (changes: Record<string, unknown>) => prefix + Buffer.from(JSON.stringify({ ...ref, ...changes })).toString('base64url');
    expect(registry.access(url, 'urn:forged')).toBeUndefined();
    expect(registry.access(prefix + '%', String(selected['action']))).toBeUndefined();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ head: 'stale' }, /stale application head/],
      [{ contract: 'stale' }, /stale application contract/],
      [{ action: 'urn:forged' }, /absent/],
      [{ application: 'urn:unknown' }, /not present/],
      [{ catalog: 'file:///etc/passwd' }, /not declared/],
    ];
    for (const [changes, pattern] of cases) {
      await expect(registry.invoke(alter(changes), String(changes['action'] ?? selected['action']), {}, context)).rejects.toThrow(pattern);
    }
    const tampered = { ...resolved.catalogDescriptor, authorship: { authorshipVerified: false } };
    const bad = { ...context, reads: { ...context.reads, descriptor: async (url: string) => url === tampered.url ? tampered : context.reads.descriptor(url) } };
    await expect(registry.render(tampered.url, bad, tampered)).rejects.toThrow('cryptographically');
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes exactly the verified successor with CAS and refuses a repeated submission', async () => {
    const { registry, control, context, resolved, store } = await setup();
    const selected = control('Submit: Approve');
    const publish = vi.fn(async (request: Parameters<ResourceWriteContext['publish']>[0]) => {
      expect(request).toMatchObject({ actor: context.principal, expectedHead: resolved.stateHead.cid, graphIri: store.graphs.state });
      const next = store.record(resolved, { actor: context.principal, now: context.now, expectedHead: request.expectedHead, actionIri: String(selected['action']), payload: {} });
      expect(parseSignedJsonDocument(request.graphContent).document).toEqual(next);
      return { published: true };
    });
    expect(registry.access(String(selected['descriptorUrl']), String(selected['action']))).toBe('write');
    const result = await registry.invoke(String(selected['descriptorUrl']), String(selected['action']), {}, { ...context, publish });
    expect(result).toMatchObject({ committed: true, status: 'committed', view: { snapshot: { head: { version: 1 }, replay: { complete: true } } } });
    await expect(registry.invoke(String(selected['descriptorUrl']), String(selected['action']), {}, { ...context, publish })).rejects.toThrow('stale application head');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('does not describe a completed publish as uncommitted when later verification fails', async () => {
    const { registry, control, context } = await setup();
    const selected = control('Submit: Approve');
    const result = await registry.invoke(String(selected['descriptorUrl']), String(selected['action']), {}, { ...context, publish: async () => ({ published: true }) });
    expect(result).toMatchObject({ committed: true, error: 'successor_verification_failed' });
  });

  it('rechecks catalog authority after evidence resolution and before publishing', async () => {
    const { registry, control, context, publish, store } = await setup();
    const selected = control('Submit: Approve');
    let catalogReads = 0;
    const racing = { ...context, reads: { ...context.reads, currentHead: async (pod: string, graph: string) => {
      if (graph === store.graphs.catalog && ++catalogReads === 2) return { head: { descriptorUrl: 'https://pod.example/new-catalog.ttl' } };
      return context.reads.currentHead(pod, graph);
    } } };
    await expect(registry.invoke(String(selected['descriptorUrl']), String(selected['action']), {}, racing)).rejects.toThrow('authority changed');
    expect(publish).not.toHaveBeenCalled();
  });
});
