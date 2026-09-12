import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { HMD_APP_HTML } from '../deploy/mcp-relay/hmd-app.js';

const windows: JSDOM[] = [];
afterEach(() => windows.splice(0).forEach(dom => dom.window.close()));

const binding = {
  id: 'opaque-choice', descriptorUrl: 'urn:example:binding:928', action: 'urn:example:omega-928',
  method: 'POST', executable: true, label: 'Apply advertised choice',
  payload: { 'urn:axis': { choice: 'apricot' }, expected: { opaque: ['head', 7] } },
};
const documentView = () => ({
  descriptorUrl: 'urn:example:surface:19', title: 'Advertised surface',
  body: 'Readable source with [the control](urn:example:binding:928).', hmd: '# Advertised surface\n\nDeclared controls remain in source.',
  controls: [structuredClone(binding)],
  views: [{ kind: 'grid', id: 'surface', label: 'Published arrangement', columns: 2,
    cells: [{ label: 'Apricot', control: binding.id }, { label: 'Pear', emphasis: true }, { label: '' }] }],
  snapshot: { trust: { verified: true, artifactsVerified: 5, artifactsTotal: 5 } },
});

function mount(input: unknown = documentView(), respond: (name: string, args: Record<string, unknown>) => Promise<unknown> = async () => ({ structuredContent: { accepted: true } })) {
  const callTool = vi.fn(respond), sendFollowUpMessage = vi.fn(), setWidgetState = vi.fn();
  const dom = new JSDOM(HMD_APP_HTML, { runScripts: 'dangerously', beforeParse(window) {
    Object.defineProperty(window, 'openai', { value: { toolOutput: input, callTool, sendFollowUpMessage, setWidgetState } });
  } });
  windows.push(dom);
  const document = dom.window.document;
  const deliver = (next: unknown) => dom.window.dispatchEvent(new dom.window.CustomEvent('openai:set_globals', {
    detail: { globals: { toolOutput: next } },
  }));
  const cell = () => document.querySelector('button.grid-cell') as HTMLButtonElement;
  const confirm = () => document.querySelector('.grid-detail .confirm button') as HTMLButtonElement;
  return { dom, document, callTool, deliver, cell, confirm, sendFollowUpMessage, setWidgetState };
}

describe('generic descriptor-bound grid representation', () => {
  it('renders a native table with accessible labels and keeps both source tabs readable', () => {
    const { document } = mount();
    expect(document.querySelector('caption')?.textContent).toBe('Published arrangement');
    expect(document.querySelectorAll('.representation-grid tr')).toHaveLength(2);
    expect(document.querySelectorAll('button.grid-cell')).toHaveLength(1);
    expect(document.querySelector('.grid-cell[aria-label="Cell 3"]')).not.toBeNull();
    expect(document.querySelector('.grid-cell.emphasis')?.textContent).toBe('Pear');
    expect(document.querySelectorAll('#pane-enhanced .control')).toHaveLength(0);
    expect(document.querySelector('#pane-markdown')?.textContent).toContain('[the control](urn:example:binding:928)');
    expect(document.querySelector('#pane-source')?.textContent).toContain('Declared controls remain in source.');
  });

  it('shows the complete Markdown projection while keeping its table out of the enhanced prose', () => {
    const input = { ...documentView(), markdownBody: '| Label |\n| --- |\n| Apricot |' };
    const { document, deliver } = mount(input);
    expect(document.querySelector('#pane-markdown')?.textContent).toBe(input.markdownBody);
    expect(document.querySelector('#pane-enhanced .prose table')).toBeNull();
    const next = { ...input, markdownBody: '| Label |\n| --- |\n| New source |' }; deliver(next);
    expect(document.querySelector('#pane-markdown')?.textContent).toBe(next.markdownBody);
  });

  it('invokes only the exact opaque advertised binding after confirmation, and renders the returned projection', async () => {
    const next = documentView();
    next.views[0]!.cells[0]!.label = 'Server changed this label';
    const { document, callTool, cell, confirm, sendFollowUpMessage } = mount(documentView(), async () => ({
      structuredContent: { status: 200, body: JSON.stringify({ view: next }) },
    }));
    cell().click();
    expect(callTool).not.toHaveBeenCalled();
    expect(document.querySelector('.confirm pre')?.textContent).toBe(JSON.stringify(binding.payload, null, 2));
    const button = confirm();
    button.click(); button.click();
    await vi.waitFor(() => expect(document.querySelector('button.grid-cell')?.textContent).toBe('Server changed this label'));
    expect(callTool.mock.calls).toEqual([['invoke_affordance', {
      descriptor_url: binding.descriptorUrl, action_iri: binding.action, payload: binding.payload,
    }]]);
    expect(sendFollowUpMessage).not.toHaveBeenCalled();
  });

  it('honors a different opaque read action without synthesizing a payload or confirmation', async () => {
    const input = documentView();
    input.controls[0] = { ...binding, descriptorUrl: 'https://example.test/descriptor/alternate',
      action: 'https://example.test/vocab#inspect-583', method: 'GET', payload: { 'urn:axis': { choice: 'plum' }, expected: { opaque: ['authority', 92] } } };
    const { cell, callTool } = mount(input);
    cell().click();
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    expect(callTool.mock.calls[0]).toEqual(['invoke_affordance', {
      descriptor_url: input.controls[0].descriptorUrl, action_iri: input.controls[0].action, payload: input.controls[0].payload,
    }]);
  });

  it('leaves terminal cells inert and does not interpret labels as actions', () => {
    const input = documentView();
    input.controls = [];
    const { document, callTool } = mount(input);
    expect(document.querySelectorAll('.grid-cell')).toHaveLength(3);
    expect(document.querySelectorAll('button.grid-cell')).toHaveLength(0);
    document.querySelectorAll('.grid-cell').forEach(cell => (cell as HTMLElement).click());
    expect(callTool).not.toHaveBeenCalled();
  });

  it('does not confuse an absent reference with a control literally named undefined', () => {
    const input = documentView();
    input.controls[0]!.id = 'undefined'; input.views[0]!.cells[0]!.control = 'undefined';
    const { document } = mount(input);
    expect(document.querySelectorAll('button.grid-cell')).toHaveLength(1);
    expect(document.querySelectorAll('span.grid-cell')).toHaveLength(2);
  });

  it.each(['unknown', 'disabled', 'duplicate', 'missing-payload', 'invalid-payload'])(
    'keeps a %s control reference inert', type => {
      const input = documentView();
      if (type === 'unknown') input.views[0]!.cells[0]!.control = 'unadvertised';
      if (type === 'disabled') input.controls[0]!.executable = false;
      if (type === 'duplicate') input.controls.push(structuredClone(binding));
      if (type === 'missing-payload') delete (input.controls[0] as Partial<typeof binding>).payload;
      if (type === 'invalid-payload') (input.controls[0] as Record<string, unknown>)['payload'] = [];
      const { document } = mount(input);
      expect(document.querySelectorAll('button.grid-cell')).toHaveLength(0);
    },
  );

  it('retains the displayed cells on a stale server refusal, with one call and no local transition', async () => {
    const input = documentView();
    const { document, callTool, cell, confirm, sendFollowUpMessage, setWidgetState } = mount(input, async () => ({
      structuredContent: { status: 412, body: JSON.stringify({ error: 'stale_head', message: 'The advertised source is no longer current.' }) },
    }));
    const before = document.querySelector('.representation-grid')!.innerHTML;
    cell().click(); confirm().click();
    await vi.waitFor(() => expect(document.querySelector('.status.err')?.textContent).toContain('no longer current'));
    expect(document.querySelector('.representation-grid')!.innerHTML).toBe(before);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(sendFollowUpMessage).not.toHaveBeenCalled();
    expect(setWidgetState).not.toHaveBeenCalled();
  });

  it('rejects stale detached cell and confirmation callbacks after rehydration', () => {
    const { document, cell, confirm, deliver, callTool } = mount();
    const oldCell = cell();
    oldCell.click();
    const oldConfirm = confirm();
    const next = documentView();
    next.views[0]!.cells[0]!.label = 'Different server projection';
    deliver(next);
    oldCell.click(); oldConfirm.click();
    expect(document.querySelector('button.grid-cell')?.textContent).toBe('Different server projection');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('does not let a late successful response overwrite a newer host projection', async () => {
    let resolve!: (value: unknown) => void;
    const { document, cell, confirm, deliver } = mount(documentView(), () => new Promise(done => { resolve = done; }));
    cell().click(); confirm().click();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const next = documentView(); next.views[0]!.cells[0]!.label = 'Newest projection'; deliver(next);
    resolve({ structuredContent: documentView() });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('button.grid-cell')?.textContent).toBe('Newest projection');
  });

  it('keeps an in-flight successor when another cell replaces its detail card', async () => {
    const input = documentView();
    input.controls.push({ ...structuredClone(binding), id: 'second-choice', action: 'urn:example:another-choice' });
    input.views[0]!.cells[1]!.control = 'second-choice';
    let resolve!: (value: unknown) => void;
    const { document, cell, confirm, callTool } = mount(input, () => new Promise(done => { resolve = done; }));
    cell().click(); confirm().click();
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    const firstCard = document.querySelector('.grid-detail .control')!;
    (document.querySelectorAll('button.grid-cell')[1] as HTMLButtonElement).click();
    expect(firstCard.isConnected).toBe(false);
    const secondConfirm = confirm();
    const next = structuredClone(input); next.views[0]!.cells[0]!.label = 'Authoritative successor';
    resolve({ structuredContent: { view: next } });
    await vi.waitFor(() => expect(document.querySelector('button.grid-cell')?.textContent).toBe('Authoritative successor'));
    secondConfirm.click();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('bounds grids and renders hostile labels only as text', () => {
    const input = documentView();
    input.views[0]!.label = '<img src=x onerror=alert(1)>';
    input.views[0]!.cells[0]!.label = '<script>throw Error("injected")</script>';
    const { document, deliver } = mount(input);
    expect(document.querySelector('caption')?.textContent).toBe(input.views[0]!.label);
    expect(document.querySelector('.representation-grid img, .representation-grid script')).toBeNull();
    const tooLarge = documentView(); tooLarge.views[0]!.columns = 13; deliver(tooLarge);
    expect(document.querySelector('.representation-grid')).toBeNull();
    expect(document.querySelectorAll('#pane-enhanced .control')).toHaveLength(1);
    tooLarge.views[0]!.columns = 2;
    tooLarge.views[0]!.cells = Array.from({ length: 257 }, () => ({ label: 'Cell' }));
    deliver(structuredClone(tooLarge));
    expect(document.querySelector('.representation-grid')).toBeNull();
  });
});

describe('derived projection evidence badge', () => {
  it('distinguishes verified sources from a signed projection or replay claim', () => {
    const { document } = mount();
    const badge = document.querySelector('#prov')!;
    expect(badge.textContent).toBe('Sources verified');
    expect(badge.getAttribute('title')).toContain('projection is derived');
    expect(badge.getAttribute('title')).toContain('no history replay is asserted');
    expect(badge.textContent).not.toContain('Signed');
  });

  it.each([
    { trust: { verified: false, artifactsVerified: 5, artifactsTotal: 5 } },
    { trust: { verified: true, artifactsVerified: 0, artifactsTotal: 0 } },
    { trust: { verified: true, artifactsVerified: 4, artifactsTotal: 5 } },
    { trust: { verified: true, artifactsVerified: 5, artifactsTotal: 5 }, replay: null },
    { trust: { verified: true, artifactsVerified: 5, artifactsTotal: 5 }, replay: { complete: false, errors: [] } },
    { trust: { verified: true, artifactsVerified: 5, artifactsTotal: 5 }, replay: { complete: true, errors: [] } },
    { trust: { verified: true, artifactsVerified: 5, artifactsTotal: 5 }, replay: { complete: true, errors: ['failed link'] } },
  ])('withholds the badge on incomplete evidence %#', snapshot => {
    const { document } = mount({ ...documentView(), snapshot });
    expect(document.querySelector('#prov')?.textContent).toBe('Sources not verified');
  });

  it('updates the badge when evidence changes without changing source text', () => {
    const { document, deliver } = mount();
    const next = documentView(); next.snapshot.trust.verified = false; deliver(next);
    expect(document.querySelector('#prov')?.textContent).toBe('Sources not verified');
  });

  it('reports a supplied complete replay only when it has no verification errors', () => {
    const input = documentView();
    const { document } = mount({ ...input, snapshot: { ...input.snapshot,
      replay: { complete: true, chainLength: 2, verifiedLinks: 2, links: [{ verified: true, errors: [] }, { verified: true, errors: [] }], errors: [] },
    } });
    expect(document.querySelector('#prov')?.textContent).toBe('Sources verified');
    expect(document.querySelector('#prov')?.getAttribute('title')).toContain('supplied history replay is complete');
  });

  it.each([
    { chainLength: 0, verifiedLinks: 0, links: [] },
    { chainLength: 2, verifiedLinks: 1, links: [{ verified: true, errors: [] }, { verified: true, errors: [] }] },
    { chainLength: 2, verifiedLinks: 2, links: [{ verified: true, errors: [] }] },
    { chainLength: 1, verifiedLinks: 1, links: [{ verified: false, errors: [] }] },
    { chainLength: 1, verifiedLinks: 1, links: [{ verified: true, errors: ['link verification failed'] }] },
  ])('rejects incomplete replay counts and link evidence %#', replay => {
    const input = documentView();
    const { document } = mount({ ...input, snapshot: { ...input.snapshot, replay: { complete: true, errors: [], ...replay } } });
    expect(document.querySelector('#prov')?.textContent).toBe('Sources not verified');
  });

  it('preserves the regular note signature/content-binding badge', () => {
    const { snapshot: _, ...note } = documentView();
    const { document } = mount({ ...note, authorship: { authorshipVerified: true, contentBinding: 'bound' } });
    expect(document.querySelector('#prov')?.textContent).toBe('Signed · content verified');
  });
});
