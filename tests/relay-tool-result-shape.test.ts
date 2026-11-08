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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HMD_APP_HTML } from '../deploy/mcp-relay/hmd-app.js';
import {
  relayToolResult, summarizeToolResult, SUMMARY_MAX_CHARS, SURFACES_WHOSE_MODEL_READS_STRUCTURED_CONTENT,
  resultOptionsForRegisteredClient, resultOptionsResolver, type RegisteredClient, type RelayToolResult,
} from '../deploy/mcp-relay/tool-result.js';
import { clientInteractionMcpResult, clientInteractionToolResult } from '../deploy/mcp-relay/client-interaction-mcp.js';
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
    expect([...SURFACES_WHOSE_MODEL_READS_STRUCTURED_CONTENT.keys()]).toEqual(['chatgpt']);
  });

  // A settled interaction answers at once, without touching the server or the request context.
  const settled = async (value: Record<string, unknown>): Promise<RelayToolResult> =>
    await clientInteractionMcpResult(value, {} as never, {} as never,
      { status: async () => value, cancel: async () => value }, undefined, { modelReadsStructuredContent: true }) as RelayToolResult;

  it('keeps an error\'s JSON in content, so the reason reaches a client that reads content alone', async () => {
    const text = JSON.stringify({ error: 'read_inbox: limit must be a whole number from 1 to 50', hint: 'pass 1 to 50' });
    const refused = relayToolResult('read_inbox', text, undefined, { modelReadsStructuredContent: true });
    expect(refused.content.map(c => c.text)).toEqual([text, 'read_inbox did not complete — limit must be a whole number from 1 to 50']);
    // A failed signed interaction: isError, with the reason nested where no summary reaches it.
    const failed = { id: 'i-9', status: 'failed', descriptorUrl: 'https://pod.example/d', result: { error: 'signature_invalid', message: 'The proof did not verify.' } };
    const result = await settled(failed);
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(2);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: 'failed', result: { error: 'signature_invalid' } });
    expect(result.structuredContent).toEqual(failed);
  });

  it('a successful interaction still gets the summary line alone', async () => {
    const done = { id: 'i-10', status: 'completed', descriptorUrl: 'https://pod.example/d', result: { judged: 'the body text' } };
    const result = await settled(done);
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.text).not.toContain('the body text');
  });
});

describe('which session is ChatGPT: the registered name AND every redirect URI on its hosts', () => {
  // server.ts matches the name against SURFACE_PATTERNS alone; this stands in for that match.
  const surfaceOf = (name: string): string | undefined => (/chatgpt/i.test(name) ? 'chatgpt' : undefined);
  const layout = (client: RegisteredClient | undefined) => resultOptionsForRegisteredClient(client, surfaceOf);
  const CONNECTOR = 'https://chatgpt.com/connector_platform_oauth_redirect';

  it('identifies ChatGPT by its name and its own redirect hosts', () => {
    expect(layout({ client_name: 'ChatGPT', redirect_uris: [CONNECTOR] })).toEqual({ modelReadsStructuredContent: true });
    expect(layout({ client_name: ' ChatGPT ', redirect_uris: ['https://platform.openai.com/apps-manage/oauth', CONNECTOR] }))
      .toEqual({ modelReadsStructuredContent: true });
  });

  it('keeps the JSON for a client that only calls itself ChatGPT', () => {
    expect(layout({ client_name: 'my chatgpt bridge', redirect_uris: ['https://bridge.example/oauth/callback'] })).toEqual({});
    expect(layout({ client_name: 'ChatGPT', redirect_uris: ['http://127.0.0.1:9/callback'] })).toEqual({});
    // EVERY redirect must be ChatGPT's: one elsewhere is a place a code can be delivered to.
    expect(layout({ client_name: 'ChatGPT', redirect_uris: [CONNECTOR, 'https://bridge.example/cb'] })).toEqual({});
    expect(layout({ client_name: 'ChatGPT', redirect_uris: ['http://chatgpt.com/connector_platform_oauth_redirect'] })).toEqual({});
    expect(layout({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com.bridge.example/cb'] })).toEqual({});
    expect(layout({ client_name: 'ChatGPT', redirect_uris: ['https://notchatgpt.com/cb'] })).toEqual({});
    expect(layout({ client_name: 'ChatGPT', redirect_uris: [] })).toEqual({});
    expect(layout({ client_name: 'ChatGPT', redirect_uris: [42] })).toEqual({});
    expect(layout({ client_name: 'ChatGPT' })).toEqual({});
  });

  it('never takes the surface from anything but the name patterns', () => {
    // A name the patterns do not match is not ChatGPT, whatever the deployment labels it.
    expect(layout({ client_name: 'Some client', redirect_uris: [CONNECTOR] })).toEqual({});
    expect(layout({ client_name: '', redirect_uris: [CONNECTOR] })).toEqual({});
    expect(layout({ redirect_uris: [CONNECTOR] })).toEqual({});
    expect(layout(undefined)).toEqual({});
    expect(resultOptionsForRegisteredClient({ client_name: 'ChatGPT', redirect_uris: [CONNECTOR] }, () => 'claude')).toEqual({});
  });
});

describe('resultOptionsResolver: a tools/call does not cost a client lookup', () => {
  const surfaceOf = (name: string): string | undefined => (/chatgpt/i.test(name) ? 'chatgpt' : undefined);
  const chatgpt: RegisteredClient = { client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] };

  it('remembers an unknown client briefly and a known one longer', async () => {
    let clock = 0;
    const lookups: string[] = [];
    const resolve = resultOptionsResolver(async (id) => { lookups.push(id); return id === 'known' ? chatgpt : undefined; },
      surfaceOf, { ttlMs: 10_000, missTtlMs: 1_000, now: () => clock });
    expect(await resolve('gone')).toEqual({});
    expect(await resolve('gone')).toEqual({});
    expect(await resolve('known')).toEqual({ modelReadsStructuredContent: true });
    expect(await resolve('known')).toEqual({ modelReadsStructuredContent: true });
    expect(lookups).toEqual(['gone', 'known']);
    clock = 1_001;
    await resolve('gone'); await resolve('known');
    expect(lookups).toEqual(['gone', 'known', 'gone']);
    clock = 10_001;
    await resolve('known');
    expect(lookups).toEqual(['gone', 'known', 'gone', 'known']);
    expect(await resolve(undefined)).toEqual({});
    expect(lookups).toHaveLength(4);
  });

  it('does not remember a lookup that failed, and holds a bounded number of ids', async () => {
    let calls = 0;
    const failing = resultOptionsResolver(async () => { calls++; throw new Error('store unreachable'); }, surfaceOf);
    expect(await failing('a')).toEqual({});
    expect(await failing('a')).toEqual({});
    expect(calls).toBe(2);

    const lookups: string[] = [];
    const bounded = resultOptionsResolver((id) => { lookups.push(id); return undefined; }, surfaceOf, { maxEntries: 2, now: () => 0 });
    for (const id of ['a', 'b', 'c', 'c', 'b', 'a']) await bounded(id);
    // 'a' was dropped to make room for 'c'; 'b' and 'c' were still held.
    expect(lookups).toEqual(['a', 'b', 'c', 'a']);
  });

  it('holds one id when told to hold none, instead of evicting forever', async () => {
    // A zero that counts how often it is compared, so an eviction loop that never ends fails
    // here rather than hanging the worker (a synchronous loop cannot be timed out).
    let compared = 0;
    const none = { valueOf: () => { if (++compared > 100) throw new Error('evicting forever'); return 0; } } as unknown as number;
    const lookups: string[] = [];
    const resolve = resultOptionsResolver(async (id) => { lookups.push(id); return id === 'known' ? chatgpt : undefined; },
      surfaceOf, { maxEntries: none, now: () => 0 });
    expect(await resolve('known')).toEqual({ modelReadsStructuredContent: true });
    expect(await resolve('known')).toEqual({ modelReadsStructuredContent: true });
    expect(await resolve('other')).toEqual({});
    expect(await resolve('known')).toEqual({ modelReadsStructuredContent: true });
    // 'known' was held until 'other' took its place.
    expect(lookups).toEqual(['known', 'other', 'known']);
    expect(await resultOptionsResolver(() => chatgpt, surfaceOf, { maxEntries: -1 })('x')).toEqual({ modelReadsStructuredContent: true });
  });
});

describe('what the notes say about identifying ChatGPT is what the relay does', () => {
  const ROOT = join(import.meta.dirname, '..');
  const flat = (text: string): string => text.replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ');
  const header = flat(readFileSync(join(ROOT, 'deploy/mcp-relay/tool-result.ts'), 'utf8').split('*/')[0]!);
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const start = changelog.indexOf('\n## 2026-11-08 — Relay: ChatGPT is identified by its redirect hosts');
  const entry = flat(changelog.slice(start + 1, changelog.indexOf('\n## ', start + 1)));

  it('does not say another client cannot finish sign-in with ChatGPT redirect URIs, because the relay suite does', () => {
    // The relay suite signs in under ChatGPT's own redirect URI and reads the code from the redirect.
    const suite = readFileSync(join(ROOT, 'deploy/mcp-relay/tests/tool-result-size.test.ts'), 'utf8');
    expect(suite).toContain("CHATGPT_REDIRECT = 'https://chatgpt.com/");
    expect(suite).toContain("oauthBearer('ChatGPT', CHATGPT_REDIRECT)");
    expect(start).toBeGreaterThan(0);
    for (const text of [header, entry]) {
      expect(text).not.toMatch(/cannot finish sign-in/);
      expect(text).toMatch(/captures its own redirect/);
    }
  });

  it('says only a name that could not be made into a label fell back to the default surface', () => {
    // server.ts surfaceAgentFromClient: an unmatched name keeps its own slug when it makes one.
    expect(entry).not.toMatch(/whose name matched nothing on a relay/);
    expect(entry).toMatch(/matched nothing and could not be turned into a short label/);
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
    // An empty published names no time: it is left out, as the cursor would read it back.
    expect(inboxItemFrom('u/5', { published: '', summary: 'x' })).toEqual({ url: 'u/5', summary: 'x' });
    expect(inboxItemFrom('u/6', { published: { '@value': '' } })).toEqual({ url: 'u/6' });
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

  it('walks every item once when published is empty, a non-date, or missing', () => {
    // The smallest case found: a page ending on a non-date resumed among the undated items, and
    // b and z were never served.
    const smallest: InboxItem[] = [
      { url: 'https://pod.example/i/c', published: '' }, { url: 'https://pod.example/i/b', published: '' },
      { url: 'https://pod.example/i/a', published: 'not a date' }, { url: 'https://pod.example/i/z' },
    ];
    const walk = (items: readonly InboxItem[], limit: number): string[] => {
      const seen: string[] = [];
      let before: string | undefined;
      for (let pages = 0; pages < 200; pages++) {
        const page = pageInboxItems(items, { limit, ...(before ? { before } : {}) });
        seen.push(...page.items.map(i => i.url));
        if (!page.hasMore) break;
        before = page.nextCursor;
      }
      return seen;
    };
    expect(walk(smallest, 1)).toEqual([...smallest].sort(compareInboxItems).map(i => i.url));
    expect(walk(smallest, 1)).toHaveLength(4);
    // An empty published sorts with the missing ones, because that is how the cursor spells them.
    expect(compareInboxItems({ url: 'u/x', published: '' }, { url: 'u/x' })).toBe(0);

    // Every page size over a deterministic spread of inboxes holding all three kinds.
    let seed = 7;
    const next = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const kinds = ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00+02:00', '2026-01-01T23:00:00-01:00', 'not a date', 'yesterday', '', undefined];
    for (let round = 0; round < 60; round++) {
      const items: InboxItem[] = Array.from({ length: 3 + Math.floor(next() * 25) }, (_, i) => {
        const published = kinds[Math.floor(next() * kinds.length)];
        return { url: `https://pod.example/i/${String.fromCharCode(97 + Math.floor(next() * 26))}${i}`, ...(published !== undefined ? { published } : {}) };
      });
      const order = [...items].sort(compareInboxItems).map(i => i.url);
      for (let limit = 1; limit <= 6; limit++) expect(walk(items, limit), `round ${round}, limit ${limit}`).toEqual(order);
      // The item a cursor names may be deleted before the next page: nothing after it is skipped.
      const first = pageInboxItems(items, { limit: 2 });
      if (!first.hasMore) continue;
      const gone = first.items.at(-1)!.url;
      const rest: string[] = [];
      let before = first.nextCursor;
      while (before) {
        const page = pageInboxItems(items.filter(i => i.url !== gone), { limit: 2, before });
        rest.push(...page.items.map(i => i.url));
        before = page.hasMore ? page.nextCursor : undefined;
      }
      expect(rest, `round ${round}, after a deletion`).toEqual(order.slice(2));
    }
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
