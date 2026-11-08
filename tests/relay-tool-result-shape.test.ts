/**
 * The relay's tool-result envelope, its read_inbox page arithmetic, and the HyperMarkdown widget
 * reading results in that envelope.
 *
 * The relay suite `deploy/mcp-relay/tests/tool-result-size.test.ts` drives the real server over
 * /mcp, /messages and /tool and measures the bytes. This module covers what that one cannot
 * reach cheaply: every branch of the one-line summary, the paging edge cases (ties, undated
 * notifications, a cursor past the end), and the widget hydrating from each delivery path a host
 * uses — the ChatGPT `toolOutput` global, the MCP Apps `ui/notifications/tool-result` message,
 * and a control's own tools/call answer whose structuredContent a host did not pass through.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { HMD_APP_HTML } from '../deploy/mcp-relay/hmd-app.js';
import { relayToolResult, summarizeToolResult, SUMMARY_MAX_CHARS } from '../deploy/mcp-relay/tool-result.js';
import {
  pageInboxItems, compareInboxItems, decodeInboxCursor, encodeInboxCursor, InboxPageError,
  INBOX_DEFAULT_LIMIT, INBOX_MAX_LIMIT, type InboxItem,
} from '../deploy/mcp-relay/agent-mesh.js';

describe('relayToolResult: one full copy in content, first; one summary line after it', () => {
  it('keeps the handler text verbatim as content[0] and parses it, null-free, into structuredContent', () => {
    const text = JSON.stringify({ ok: true, absent: null, nested: { kept: 1, dropped: null } });
    const result = relayToolResult('anything', text);
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: 'text', text });
    expect(result.structuredContent).toEqual({ ok: true, nested: { kept: 1 } });
    expect(result).not.toHaveProperty('_meta');
    expect(() => JSON.parse(result.content[1]!.text)).toThrow();
    expect(result.content[1]!.text).toBe('anything: JSON result above with 2 fields.');
  });

  it('wraps a human-readable handler answer as { result } and says how long it is', () => {
    const result = relayToolResult('get_pod_status', 'line one\nline two');
    expect(result.content[0]!.text).toBe('line one\nline two');
    expect(result.structuredContent).toEqual({ result: 'line one\nline two' });
    expect(result.content[1]!.text).toBe('get_pod_status: text result of 17 characters (above).');
  });

  it('summarises a followed affordance by its exchange and never by its body', () => {
    const body = JSON.stringify({ secretish: 'the body text', more: 'x'.repeat(400) });
    const line = summarizeToolResult('act', {
      status: 201, statusText: 'Created', contentType: 'application/json', body,
      affordance: { action: 'urn:a', target: 'https://pod.example/x', method: 'POST' },
    });
    expect(line).toBe(`act: POST https://pod.example/x answered 201 Created; the ${Buffer.byteLength(body)}-byte application/json response is the body field of the JSON result.`);
    expect(line).not.toContain('the body text');
  });

  it('summarises an error, a page, and a plain object, each on one bounded line', () => {
    expect(summarizeToolResult('read_inbox', { error: 'read_inbox: forbidden', detail: 'x' }))
      .toBe('read_inbox did not complete — read_inbox: forbidden');
    expect(summarizeToolResult('read_inbox', { items: [{}, {}], total: 9, hasMore: true, nextCursor: 'c' }))
      .toBe('read_inbox: 2 of 9 notifications, newest first. More are available: pass before = nextCursor.');
    expect(summarizeToolResult('discover_context', { '@context': {}, entries: [1, 2, 3], affordances: [1], pod: 'p' }))
      .toBe('discover_context: JSON result above with 3 fields (list sizes entries: 3).');
    const long = summarizeToolResult('x', { error: 'e'.repeat(1000) });
    expect(long.length).toBe(SUMMARY_MAX_CHARS);
    expect(summarizeToolResult('x', { error: 'one\ntwo\n\nthree' })).toBe('x did not complete — one two three');
  });
});

describe('pageInboxItems: bounded, total, and a cursor that names one position', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const item = (url: string, published?: string, content?: string): InboxItem =>
    ({ url, ...(published ? { published } : {}), summary: `s ${url}`, ...(content ? { content } : {}) });
  const inbox = [
    item('u/a', at(1), 'A'), item('u/b', at(3), 'BB'), item('u/c', at(3), 'CCC'), item('u/d', undefined, 'D'),
    item('u/e', at(2)), item('u/f', undefined),
  ];

  it('orders newest first, ties by url, undated last', () => {
    expect([...inbox].sort(compareInboxItems).map(i => i.url)).toEqual(['u/c', 'u/b', 'u/e', 'u/a', 'u/f', 'u/d']);
  });

  it('walks every item once through nextCursor, including the undated tail', () => {
    const seen: string[] = [];
    let before: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const page = pageInboxItems(inbox, { limit: 2, ...(before ? { before } : {}) });
      expect(page.total).toBe(6);
      seen.push(...page.items.map(i => i.url));
      if (!page.hasMore) { expect(page.nextCursor).toBeUndefined(); break; }
      before = page.nextCursor;
    }
    expect(seen).toEqual(['u/c', 'u/b', 'u/e', 'u/a', 'u/f', 'u/d']);
  });

  it('defaults and clamps the page size', () => {
    const many = Array.from({ length: 80 }, (_, i) => item(`u/${String(i).padStart(2, '0')}`, at(i)));
    expect(pageInboxItems(many).items).toHaveLength(INBOX_DEFAULT_LIMIT);
    expect(pageInboxItems(many, { limit: 1000 }).items).toHaveLength(INBOX_MAX_LIMIT);
    expect(pageInboxItems(many, { limit: 0 }).items).toHaveLength(1);
    expect(pageInboxItems(many, { limit: 7.9 }).limit).toBe(7);
    expect(INBOX_MAX_LIMIT).toBe(50); // the largest limit the workspace client passes
  });

  it('omits bodies on request and reports their length instead', () => {
    const page = pageInboxItems(inbox, { limit: 6, includeContent: false });
    expect(page.items.find(i => i.url === 'u/c')).toEqual({ url: 'u/c', published: at(3), summary: 's u/c', contentLength: 3 });
    expect(page.items.find(i => i.url === 'u/e')).toEqual({ url: 'u/e', published: at(2), summary: 's u/e' });
    expect(page.items.every(i => i.content === undefined)).toBe(true);
  });

  it('counts and returns only what since admits, and refuses what it cannot read', () => {
    const page = pageInboxItems(inbox, { since: at(2) });
    expect(page.items.map(i => i.url)).toEqual(['u/c', 'u/b', 'u/e']);
    expect(page.total).toBe(3);
    expect(() => pageInboxItems(inbox, { since: 'last week' })).toThrow(InboxPageError);
    expect(() => pageInboxItems(inbox, { before: 'garbage' })).toThrow(InboxPageError);
    expect(decodeInboxCursor(Buffer.from('{"p":1}').toString('base64url'))).toBeNull();
  });

  it('answers an empty page, not the first page, for a cursor past the end', () => {
    const last = [...inbox].sort(compareInboxItems).at(-1)!;
    const page = pageInboxItems(inbox, { before: encodeInboxCursor(last) });
    expect(page).toMatchObject({ items: [], total: 6, hasMore: false });
  });
});

describe('the HyperMarkdown widget hydrates from the relay envelope', () => {
  const windows: JSDOM[] = [];
  afterEach(() => windows.splice(0).forEach(dom => dom.window.close()));

  const doc = (title: string, body: string) => ({
    descriptorUrl: 'https://pod.example/u/context-graphs/note.ttl', title, body, hmd: `# ${title}\n\n${body}`,
    controls: [{ action: 'https://example.test/vocab#refresh', method: 'GET', executable: true, label: 'Refresh', fields: [],
      descriptorUrl: 'https://pod.example/u/context-graphs/note.ttl' }],
    links: [],
  });
  const mount = (openai: Record<string, unknown>) => {
    const dom = new JSDOM(HMD_APP_HTML, { runScripts: 'dangerously', beforeParse(window) {
      Object.defineProperty(window, 'openai', { value: { sendFollowUpMessage: vi.fn(), ...openai } });
    } });
    windows.push(dom);
    return dom;
  };

  it('ChatGPT path: toolOutput is structuredContent of the envelope', () => {
    const result = relayToolResult('render_hmd', JSON.stringify(doc('Envelope note', 'Prose from structuredContent.')));
    const dom = mount({ toolOutput: result.structuredContent, callTool: vi.fn() });
    const document = dom.window.document;
    expect(document.getElementById('title')?.textContent).toBe('Envelope note');
    expect(document.querySelector('#pane-enhanced .prose')?.textContent).toContain('Prose from structuredContent.');
    expect(document.querySelector('#pane-source')?.textContent).toContain('# Envelope note');
  });

  it('MCP Apps path: a ui/notifications/tool-result carrying the whole envelope hydrates it', async () => {
    const dom = mount({ callTool: vi.fn() });
    const result = relayToolResult('render_hmd', JSON.stringify(doc('Delivered later', 'Arrived by notification.')));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      source: dom.window as unknown as MessageEventSource, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result },
    }));
    await vi.waitFor(() => expect(dom.window.document.getElementById('title')?.textContent).toBe('Delivered later'));
  });

  it('a control answer without structuredContent falls back to the FIRST text block, which is the JSON', async () => {
    const next = { view: doc('Refreshed view', 'Replaced by the action result.') };
    const answer = relayToolResult('invoke_affordance', JSON.stringify({
      status: 200, statusText: 'OK', contentType: 'application/json', body: JSON.stringify(next),
      affordance: { action: 'https://example.test/vocab#refresh', target: 'https://pod.example/refresh', method: 'GET' },
    }));
    expect(answer.content[1]!.text).toMatch(/^invoke_affordance: GET https:\/\/pod\.example\/refresh answered 200 OK/);
    // A host that drops structuredContent from a widget-initiated call leaves only content.
    const callTool = vi.fn(async () => ({ content: answer.content }));
    const dom = mount({ toolOutput: doc('Original', 'Before the action.'), callTool });
    const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === 'Refresh')!;
    button.click();
    await vi.waitFor(() => expect(dom.window.document.getElementById('title')?.textContent).toBe('Refreshed view'));
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
