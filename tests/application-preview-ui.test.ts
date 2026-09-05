import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { APPLICATION_LAB_APP_HTML } from '../deploy/mcp-relay/application-lab-app.js';
import { previewApplicationAction } from '../deploy/mcp-relay/application-preview.js';
import { fixtureStore } from '../examples/application-simulation/fixture-store.js';
import { releaseControl } from '../examples/application-simulation/rule-packs.js';

const windows: JSDOM[] = [];
const session = { actor: 'did:example:alice', now: '2026-09-05T12:00:00Z' };
afterEach(() => { windows.splice(0).forEach(dom => dom.window.close()); });
async function mount(deferPreview = false) {
  const store = fixtureStore(releaseControl());
  const initial = await store.resolve();
  let release: (() => void) | undefined;
  const gate = deferPreview ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'open_application_lab') return { structuredContent: (await store.resolve()).snapshot };
    if (name !== 'preview_application_action') throw new Error(`unexpected write/tool: ${name}`);
    const result = await previewApplicationAction(args, session, store.reads);
    await gate;
    return { structuredContent: result };
  });
  const dom = new JSDOM(APPLICATION_LAB_APP_HTML, { runScripts: 'dangerously', beforeParse(window) {
    Object.defineProperty(window, 'openai', { value: { toolOutput: initial.snapshot, callTool } });
    Object.defineProperty(window, 'CSS', { value: { escape: (s: string) => s } });
  } });
  windows.push(dom);
  const buttons = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.action button')];
  return { dom, store, initial, callTool, release,
    preview: buttons.filter(b => b.textContent === 'Preview changes'),
  };
}

describe('Application Lab host-connected preview', () => {
  it('calls the live boundary on each click and leaves displayed authoritative state intact', async () => {
    const { dom, store, initial, preview, callTool } = await mount();
    const document = dom.window.document;
    const initialReads = store.counts().reads;
    preview[0]!.click();
    await vi.waitFor(() => expect(document.querySelector('.preview')?.textContent).toContain('Preview only'));
    expect(callTool).toHaveBeenCalledWith('preview_application_action', expect.objectContaining({
      expected_head: initial.stateHead.cid, expected_contract_digest: initial.activeContractEnvelope.declaredDigest, payload: {},
    }));
    expect(document.getElementById('head-cid')?.textContent).toBe(initial.stateHead.cid);
    expect(document.getElementById('head-version')?.textContent).toBe('state v0');
    expect(document.querySelector('.preview')?.textContent).toContain('/approvals');
    const firstReads = store.counts().reads;
    expect(firstReads).toBeGreaterThan(initialReads);
    preview[0]!.click();
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(preview[0]!.disabled).toBe(false));
    expect(store.counts().reads).toBeGreaterThan(firstReads);
    expect(store.counts().writes).toBe(0);
  });

  it('permits previewing a blocked action and shows its signed guard refusal', async () => {
    const { dom, preview, store } = await mount();
    expect(preview[1]!.disabled).toBe(false);
    preview[1]!.click();
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll('.preview')[1]?.textContent).toContain('Refused: signed action guard refused'));
    expect(store.counts().writes).toBe(0);
  });

  it('discards a delayed preview after rediscovery', async () => {
    const { dom, store, initial, preview, callTool, release } = await mount(true);
    preview[0]!.click();
    await vi.waitFor(() => expect(store.counts().reads).toBeGreaterThan(20));
    store.record(initial, { ...session, actionIri: `${initial.state.applicationId}:approve`, expectedHead: initial.stateHead.cid, payload: {} });
    dom.window.document.getElementById('refresh')!.click();
    await vi.waitFor(() => expect(dom.window.document.getElementById('head-version')?.textContent).toBe('state v1'));
    release!();
    await Promise.all(callTool.mock.results.map(r => r.value));
    expect(dom.window.document.querySelector('.preview')?.textContent).toBe('');
    expect(dom.window.document.getElementById('head-version')?.textContent).toBe('state v1');
    expect(store.counts().writes).toBe(1); // Only the explicitly injected concurrent writer.
  });
});
