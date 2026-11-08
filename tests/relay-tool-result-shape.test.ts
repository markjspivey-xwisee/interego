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
import {
  relayToolResult, summarizeToolResult, SUMMARY_MAX_CHARS, SURFACES_WHOSE_MODEL_READS_STRUCTURED_CONTENT,
} from '../deploy/mcp-relay/tool-result.js';
import { clientInteractionToolResult } from '../deploy/mcp-relay/client-interaction-mcp.js';
import {
  pageInboxItems, compareInboxItems, decodeInboxCursor, encodeInboxCursor, InboxPageError, inboxItemFrom, parseInboxPageArgs,
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
    // Relay errors already begin with the tool name; the line names the tool once.
    expect(summarizeToolResult('read_inbox', { error: 'read_inbox: forbidden', detail: 'x' }))
      .toBe('read_inbox did not complete — forbidden');
    expect(summarizeToolResult('read_inbox', { error: 'read_inbox: before must be a nextCursor value from an earlier read_inbox page' }))
      .toBe('read_inbox did not complete — before must be a nextCursor value from an earlier read_inbox page');
    expect(summarizeToolResult('act', { error: 'target refused' })).toBe('act did not complete — target refused');
    expect(summarizeToolResult('read_inbox', { items: [{}, {}], total: 9, hasMore: true, nextCursor: 'c' }))
      .toBe('read_inbox: 2 of 9 notifications, newest first. More are available: pass before = nextCursor.');
    expect(summarizeToolResult('discover_context', { '@context': {}, entries: [1, 2, 3], affordances: [1], pod: 'p' }))
      .toBe('discover_context: JSON result above with 3 fields (list sizes entries: 3).');
    const long = summarizeToolResult('x', { error: 'e'.repeat(1000) });
    expect(long.length).toBe(SUMMARY_MAX_CHARS);
    expect(summarizeToolResult('x', { error: 'one\ntwo\n\nthree' })).toBe('x did not complete — one two three');
  });
});

describe('a session whose model reads structuredContent (ChatGPT) gets the result once', () => {
  const answer = { status: 200, statusText: 'OK', contentType: 'application/json', body: JSON.stringify({ judged: 'the body text' }),
    affordance: { action: 'urn:a', target: 'https://pod.example/x', method: 'POST' } };

  it('sends the summary line alone in content and the whole result in structuredContent', () => {
    const text = JSON.stringify(answer);
    const result = relayToolResult('act', text, undefined, { modelReadsStructuredContent: true });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.text).not.toContain('the body text');
    expect(() => JSON.parse(result.content[0]!.text)).toThrow();
    expect(result.content[0]!.text).toMatch(/^act: POST https:\/\/pod\.example\/x answered 200 OK; .* is the body field of structuredContent\.$/);
    expect(result.structuredContent).toEqual(answer);
    // The default layout is untouched: JSON first, then the line.
    const plain = relayToolResult('act', text);
    expect(plain.content.map(c => c.text)).toEqual([text, expect.stringMatching(/body field of the JSON result\.$/)]);
  });

  it('points at structuredContent, never at a block "above" that is not there', () => {
    const where = { modelReadsStructuredContent: true };
    expect(relayToolResult('get_pod_status', 'line one\nline two', undefined, where).content.map(c => c.text))
      .toEqual(['get_pod_status: text result of 17 characters, in the result field of structuredContent.']);
    expect(summarizeToolResult('discover_context', { entries: [1, 2], pod: 'p' }, where))
      .toBe('discover_context: JSON result in structuredContent with 2 fields (list sizes entries: 2).');
    expect(summarizeToolResult('read_inbox', { items: [{}], total: 3, hasMore: true }, where))
      .toBe('read_inbox: 1 of 3 notifications, newest first. More are available: pass before = nextCursor.');
  });

  it('keeps the launch handle in _meta and the fragment out of what the model reads', () => {
    const fragment = 'a'.repeat(43);
    const launch = { schema: 'interego.client-interaction/v1', id: 'i-1', status: 'pending', descriptorUrl: 'https://pod.example/d',
      expiresAt: '2026-11-08T22:00:00.000Z', signingUrl: `https://relay.example/sign#launch=${fragment}` };
    const result = clientInteractionToolResult(launch, undefined, 'act', { modelReadsStructuredContent: true });
    expect(result.content).toHaveLength(1);
    expect(JSON.stringify(result.content)).not.toContain(fragment);
    expect(JSON.stringify(result.structuredContent)).not.toContain(fragment);
    expect((result._meta?.['interego/browser-signing'] as Record<string, unknown>)['signingUrl']).toBe(launch.signingUrl);
  });

  it('is decided for ChatGPT only', () => {
    expect([...SURFACES_WHOSE_MODEL_READS_STRUCTURED_CONTENT]).toEqual(['chatgpt']);
  });
});

describe('inboxItemFrom: every field a string, whatever the sender stored', () => {
  it('reads an object actor by its id, an array type by its first entry, and value objects by @value', () => {
    const item = inboxItemFrom('https://pod.example/u/inbox/x.json', {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'https://sender.example/activities/1',
      type: ['Create', 'https://vocab.example/ns#Extension'],
      actor: { id: 'https://sender.example/people/ada', type: 'Person', name: 'Ada' },
      published: { '@value': '2026-11-01T00:00:00Z', '@type': 'xsd:dateTime' },
      object: { type: 'Note', summary: { '@value': 'Hello', '@language': 'en' }, content: 'Body', 'iep:about': { '@id': 'https://pod.example/u/d.ttl' } },
    });
    expect(item).toEqual({
      url: 'https://pod.example/u/inbox/x.json', id: 'https://sender.example/activities/1', type: 'Create',
      actor: 'https://sender.example/people/ada', summary: 'Hello', content: 'Body', about: 'https://pod.example/u/d.ttl',
      published: '2026-11-01T00:00:00Z',
    });
  });

  it('leaves out what it cannot read as a string, instead of passing it through', () => {
    const item = inboxItemFrom('u/1', {
      id: 7, type: [{ nested: true }], actor: { name: 'no id' }, summary: ['a', 'b'], published: 1_762_000_000_000,
      content: { html: '<p>x</p>' }, object: 'https://sender.example/objects/1',
    })!;
    expect(item).toEqual({ url: 'u/1' });
    // A later candidate that IS a string still counts: summary falls through to object.summary.
    expect(inboxItemFrom('u/2', { summary: { no: 'value' }, object: { summary: 'from the object' } })).toEqual({ url: 'u/2', summary: 'from the object' });
    expect(inboxItemFrom('u/3', ['not', 'an', 'object'])).toBeNull();
    expect(inboxItemFrom('u/4', 'a string')).toBeNull();
  });

  it('so contentLength is a character count and ordering never throws', () => {
    const items = [
      inboxItemFrom('u/a', { content: { html: 'x' }, published: 5 })!,
      inboxItemFrom('u/b', { object: { content: 'four' }, published: '2026-01-01T00:00:00Z' })!,
    ];
    expect(() => [...items].sort(compareInboxItems)).not.toThrow();
    const page = pageInboxItems(items, { includeContent: false });
    expect(page.items.map(i => [i.url, i.contentLength])).toEqual([['u/b', 4], ['u/a', undefined]]);
    for (const it of page.items) {
      for (const [key, value] of Object.entries(it)) expect(typeof value, key).toBe(key === 'contentLength' ? 'number' : 'string');
    }
  });
});

describe('parseInboxPageArgs: a present argument it cannot read is refused, by name', () => {
  const refused = (args: Record<string, unknown>): string => {
    const parsed = parseInboxPageArgs(args);
    return 'error' in parsed ? parsed.error : '(accepted)';
  };

  it('refuses a fractional or non-numeric limit instead of rounding it or using the default', () => {
    expect(refused({ limit: 7.5 })).toBe(`limit must be a whole number from 1 to ${INBOX_MAX_LIMIT}`);
    expect(refused({ limit: 'ten' })).toMatch(/^limit must be a whole number/);
    expect(refused({ limit: '7.5' })).toMatch(/^limit must be a whole number/);
    expect(refused({ limit: Number.POSITIVE_INFINITY })).toMatch(/^limit must be a whole number/);
    expect(refused({ limit: true })).toMatch(/^limit must be a whole number/);
  });

  it('refuses a before or since that is not a string, instead of answering the first unfiltered page', () => {
    expect(refused({ before: 42 })).toBe('before must be a nextCursor value from an earlier read_inbox page');
    expect(refused({ before: {} })).toMatch(/^before must be a nextCursor/);
    expect(refused({ since: 1_762_000_000 })).toBe('since must be an ISO-8601 date-time');
    expect(refused({ include_content: 'sometimes' })).toBe('include_content must be true or false');
  });

  it('reads both spellings, and treats undefined, null and the empty string as absent', () => {
    expect(parseInboxPageArgs({ limit: '7', include_content: 'false', before: 'c', since: '2026-01-01' }))
      .toEqual({ ok: true, options: { limit: 7, before: 'c', since: '2026-01-01', includeContent: false }, requestedLimit: 7 });
    expect(parseInboxPageArgs({ limit: null, before: '', since: null, include_content: null }))
      .toEqual({ ok: true, options: { includeContent: true } });
    expect(parseInboxPageArgs({ limit: -3 })).toEqual({ ok: true, options: { limit: -3, includeContent: true }, requestedLimit: -3 });
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

  it('orders by the instant published names, not by how it is spelled', () => {
    // 22:00 UTC on 1 January, spelled with +02:00, sorts AFTER the 00:00 UTC on 2 January one as
    // text. As instants it is the older of the two, and that is what since already compares.
    const older = item('u/older', '2026-01-02T00:00:00+02:00');
    const newer = item('u/newer', '2026-01-01T23:00:00-01:00');
    const odd = item('u/odd', 'not a date');
    const undated = item('u/undated');
    expect([older, undated, odd, newer].sort(compareInboxItems).map(i => i.url)).toEqual(['u/newer', 'u/older', 'u/odd', 'u/undated']);
    // The default page and the cursor walk agree with that order.
    const mixed = [older, newer, odd, undated];
    expect(pageInboxItems(mixed, { limit: 1 }).items.map(i => i.url)).toEqual(['u/newer']);
    const seen: string[] = [];
    let before: string | undefined;
    do {
      const page = pageInboxItems(mixed, { limit: 1, ...(before ? { before } : {}) });
      seen.push(...page.items.map(i => i.url));
      before = page.nextCursor;
    } while (before && seen.length < 10);
    expect(seen).toEqual(['u/newer', 'u/older', 'u/odd', 'u/undated']);
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
