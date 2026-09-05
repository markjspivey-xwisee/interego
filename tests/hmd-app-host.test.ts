import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, type DOMWindow } from 'jsdom';
import { HMD_APP_HTML } from '../deploy/mcp-relay/hmd-app.js';

const windows: JSDOM[] = [];
afterEach(() => { windows.splice(0).forEach(dom => dom.window.close()); });
const initial = {
  descriptorUrl: 'https://pod.example/descriptor.ttl', title: 'Host-delivered document',
  body: 'The host delivered this only after initialization.', hmd: '# Host-delivered document',
  controls: [{ label: 'Refresh', action: 'urn:example:refresh', method: 'GET', executable: true, fields: [] }],
};

// A protocol-only host: no window.openai and no data injection before readiness.
// Mounting with pre-populated globals skips the handshake that gates real hosts.
function mount(options: { reject?: boolean; defer?: boolean; height?: number } = {}) {
  let window: DOMWindow;
  let initializeId: unknown;
  let height = options.height ?? 0;
  let resized: (() => void) | undefined;
  const messages: Record<string, unknown>[] = [];
  const deliver = (message: Record<string, unknown>, source: unknown = host) => window.dispatchEvent(
    new window.MessageEvent('message', { data: message, source: source as Window }),
  );
  const respond = () => deliver({ jsonrpc: '2.0', id: initializeId, ...(options.reject
    ? { error: { code: -32602, message: 'Unsupported UI protocol' } }
    : { result: { protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '1' }, hostCapabilities: {}, hostContext: {} } }) });
  let initialized = false;
  const host = { postMessage(message: Record<string, unknown>) {
    messages.push(message);
    if (message.method === 'ui/initialize') {
      initializeId = message.id;
      if (!options.defer) queueMicrotask(respond);
    } else if (message.method === 'ui/notifications/initialized') {
      initialized = true;
      queueMicrotask(() => deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: initial } }));
    } else if (message.method === 'tools/call') {
      if (!initialized) throw new Error('tool called before initialization');
      queueMicrotask(() => deliver({ jsonrpc: '2.0', id: message.id, result: { structuredContent: {
        status: 200, body: JSON.stringify({ ...initial, title: 'Refreshed through host', body: 'Fresh authority.', hmd: '# Refreshed through host' }),
      } } }));
    }
  } };
  const dom = new JSDOM(HMD_APP_HTML, { runScripts: 'dangerously', beforeParse(w) {
    window = w;
    Object.defineProperty(w, 'parent', { value: host });
    w.HTMLElement.prototype.getBoundingClientRect = () => new w.DOMRect(0, 0, 390, height);
    Object.defineProperty(w, 'ResizeObserver', { value: class {
      constructor(callback: () => void) { resized = callback; }
      observe() { /* layout changes are driven explicitly below */ }
    } });
  } });
  windows.push(dom);
  return { dom, messages, deliver, respond, resize: (next: number) => { height = next; resized?.(); } };
}

describe('generic HMD viewer host lifecycle', () => {
  it('negotiates readiness before receiving a document and invoking a read control', async () => {
    const { dom, messages } = mount();
    await vi.waitFor(() => expect(dom.window.document.getElementById('title')?.textContent).toBe(initial.title));
    expect(messages.slice(0, 2).map(m => m['method'])).toEqual(['ui/initialize', 'ui/notifications/initialized']);
    expect(messages[0]?.['params']).toMatchObject({ protocolVersion: '2026-01-26', appCapabilities: {}, appInfo: { name: 'interego-hmd' } });
    (dom.window.document.querySelector('.control button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(dom.window.document.getElementById('title')?.textContent).toBe('Refreshed through host'));
    expect(messages.filter(m => m['method'] === 'tools/call').map(m => m['params'])).toEqual([{
      name: 'invoke_affordance', arguments: { descriptor_url: initial.descriptorUrl, action_iri: 'urn:example:refresh', payload: {} },
    }]);
  });

  it('does not accept a forged handshake response or announce readiness early', async () => {
    const { dom, messages, deliver, respond } = mount({ defer: true });
    expect(messages[0]?.['method']).toBe('ui/initialize');
    deliver({ jsonrpc: '2.0', id: messages[0]?.['id'], result: {} }, {});
    await Promise.resolve();
    expect(messages).toHaveLength(1);
    expect(dom.window.document.getElementById('title')?.textContent).not.toBe(initial.title);
    respond();
    await vi.waitFor(() => expect(dom.window.document.getElementById('title')?.textContent).toBe(initial.title));
  });

  it('surfaces a rejected startup instead of silently waiting for tool data', async () => {
    const { dom, messages } = mount({ reject: true });
    await vi.waitFor(() => expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('Unsupported UI protocol'));
    expect(messages.some(m => m['method'] === 'ui/notifications/initialized')).toBe(false);
    expect(messages.some(m => m['method'] === 'tools/call')).toBe(false);
  });

  it('reports content height after readiness and on growth or shrinkage without a resize loop', async () => {
    const { dom, messages, resize } = mount({ height: 200 });
    await vi.waitFor(() => expect(dom.window.document.getElementById('title')?.textContent).toBe(initial.title));
    resize(640); resize(640); resize(180);
    expect(messages.filter(m => m['method'] === 'ui/notifications/size-changed').map(m => m['params'])).toEqual([
      { height: 200 }, { height: 640 }, { height: 180 },
    ]);
    expect(messages.slice(0, 2).map(m => m['method'])).toEqual(['ui/initialize', 'ui/notifications/initialized']);
  });
});
