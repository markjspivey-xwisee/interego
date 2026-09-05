import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { HMD_APP_HTML } from '../deploy/mcp-relay/hmd-app.js';
import { resourceActionResponse, ResourceCompositions, type ResourceWriteContext } from '../deploy/mcp-relay/resource-compositions.js';
import composition from '../integrations/application-runtime/resource-composition.js';
import { fixtureStore } from '../examples/application-simulation/fixture-store.js';
import { releaseControl } from '../examples/application-simulation/rule-packs.js';

const windows: JSDOM[] = [];
const session = { actor: 'did:example:alice', now: '2026-09-05T12:00:00Z' };
afterEach(() => { windows.splice(0).forEach(dom => dom.window.close()); });
async function mount(deferPreview = false) {
  const store = fixtureStore(releaseControl());
  const resolved = await store.resolve();
  const registry = new ResourceCompositions([composition]);
  const publish = vi.fn(async () => { throw new Error('writes disabled in this test'); });
  const context: ResourceWriteContext = {
    reads: { ...store.reads, discover: store.reads.discoverCatalogs }, principal: session.actor,
    identityUrl: 'https://identity.example', now: session.now, publish,
  };
  const initial = await registry.render(resolved.catalogDescriptor.url, context, resolved.catalogDescriptor);
  if (!initial) throw new Error('missing composed view');
  let release: (() => void) | undefined;
  const gate = deferPreview ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name !== 'invoke_affordance') throw new Error('unexpected tool: ' + name);
    try {
      const result = await registry.invoke(String(args['descriptor_url']), String(args['action_iri']), args['payload'], context);
      if (result && 'alternatives' in result) await gate;
      return { structuredContent: resourceActionResponse(String(args['descriptor_url']), String(args['action_iri']), result!, registry.access(String(args['descriptor_url']), String(args['action_iri']))!) };
    } catch (error) { return { isError: true, structuredContent: { error: 'refused', message: (error as Error).message } }; }
  });
  const dom = new JSDOM(HMD_APP_HTML, { runScripts: 'dangerously', beforeParse(window) {
    Object.defineProperty(window, 'openai', { value: { toolOutput: initial, callTool } });
  } });
  windows.push(dom);
  const button = (prefix: string) => [...dom.window.document.querySelectorAll<HTMLButtonElement>('.control .actions > button')].find(b => b.textContent?.startsWith(prefix))!;
  return { dom, store, initial, resolved, callTool, publish, release, button };
}

describe('application composition through the generic host viewer', () => {
  it('uses the discovered affordance, re-verifies each preview and leaves authority intact', async () => {
    const { dom, store, initial, resolved, button, callTool, publish } = await mount();
    const preview = button('Preview: Approve');
    const descriptor = initial.controls.find(c => String(c['label']).startsWith('Preview: Approve'))!;
    const initialReads = store.counts().reads;
    preview.click();
    await vi.waitFor(() => expect(dom.window.document.querySelector('.result')?.textContent).toContain('/approvals'));
    expect(callTool).toHaveBeenCalledWith('invoke_affordance', {
      descriptor_url: descriptor['descriptorUrl'], action_iri: descriptor['action'], payload: {},
    });
    expect(dom.window.document.querySelector('.result')?.textContent).toContain('"committed": false');
    expect(dom.window.document.body.textContent).toContain(resolved.stateHead.cid);
    const firstReads = store.counts().reads;
    expect(firstReads).toBeGreaterThan(initialReads);
    await vi.waitFor(() => expect(preview.disabled).toBe(false));
    preview.click();
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(preview.disabled).toBe(false));
    expect(store.counts().reads).toBeGreaterThan(firstReads);
    expect(store.counts().writes).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('shows the signed guard refusal of a blocked action', async () => {
    const { dom, button, store, publish } = await mount();
    const preview = button('Preview: Record deployment');
    expect(preview.disabled).toBe(false);
    preview.click();
    await vi.waitFor(() => expect(dom.window.document.querySelector('.result')?.textContent).toContain('signed action guard refused'));
    expect(store.counts().writes).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('discards a delayed preview after refreshing authority', async () => {
    const { dom, store, resolved, button, callTool, release } = await mount(true);
    button('Preview: Approve').click();
    await vi.waitFor(() => expect(store.counts().reads).toBeGreaterThan(25));
    store.record(resolved, { ...session, actionIri: resolved.state.applicationId + ':approve', expectedHead: resolved.stateHead.cid, payload: {} });
    const after = await store.resolve();
    button('Refresh and verify').click();
    await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain(after.stateHead.cid));
    release!();
    await Promise.all(callTool.mock.results.map(r => r.value));
    expect(dom.window.document.querySelector('.result')).toBeNull();
    expect(dom.window.document.body.textContent).toContain(after.stateHead.cid);
    expect(store.counts().writes).toBe(1);
  });

  it('reports a stale-head tool error without showing success', async () => {
    const { dom, store, resolved, button, publish } = await mount();
    store.record(resolved, { ...session, actionIri: resolved.state.applicationId + ':approve', expectedHead: resolved.stateHead.cid, payload: {} });
    button('Preview: Approve').click();
    await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('stale application head'));
    expect(dom.window.document.querySelector('.status.ok')).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before a write and does not double-submit', async () => {
    const { dom, button, callTool, publish } = await mount();
    button('Review & Submit: Approve').click();
    expect(callTool).not.toHaveBeenCalled();
    const yes = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.confirm button')].find(b => b.textContent === 'Confirm & submit')!;
    yes.click(); yes.click();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(callTool).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('writes disabled in this test'));
  });

  it('validates and submits declared form inputs through the same generic preview', async () => {
    const { button, callTool, publish } = await mount();
    const preview = button('Preview: Cancel release');
    preview.click();
    expect(callTool).not.toHaveBeenCalled();
    const card = preview.closest('.control')!;
    (card.querySelector('[data-key="reason"]') as HTMLTextAreaElement).value = 'Needs another review';
    preview.click();
    await vi.waitFor(() => expect(card.querySelector('.result')?.textContent).toContain('Needs another review'));
    expect(callTool).toHaveBeenCalledWith('invoke_affordance', expect.objectContaining({ payload: { reason: 'Needs another review' } }));
    expect(publish).not.toHaveBeenCalled();
  });
});
