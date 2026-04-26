import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createConnector,
  createNotionConnector,
  createSlackConnector,
  createWebConnector,
} from '../src/connectors/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createConnector — type dispatch', () => {
  it('dispatches notion → createNotionConnector', () => {
    const c = createConnector({ type: 'notion', name: 'n', apiKey: 'tok' });
    expect(c.type).toBe('notion');
    expect(c.name).toBe('n');
  });

  it('dispatches slack → createSlackConnector', () => {
    const c = createConnector({ type: 'slack', name: 's', apiKey: 'tok', channelId: 'C123' });
    expect(c.type).toBe('slack');
  });

  it('dispatches web → createWebConnector', () => {
    const c = createConnector({ type: 'web', name: 'w', urls: ['https://example.com'] });
    expect(c.type).toBe('web');
  });

  it.each(['google-drive', 's3', 'filesystem'] as const)(
    'throws clear error for unimplemented type %s',
    (type) => {
      expect(() =>
        createConnector({ type, name: 'x' } as Parameters<typeof createConnector>[0]),
      ).toThrow(/Unknown connector type/);
    },
  );
});

describe('createWebConnector', () => {
  it('fetches each URL and emits an event with extracted content', async () => {
    const mockFetch = vi.fn(async (url: string) => ({
      ok: true,
      text: async () => `<html><body>hello from ${url}</body></html>`,
      headers: new Map([['content-type', 'text/html']]),
    }));
    // Type-cast: vitest's vi.fn satisfies the global fetch shape for our purposes
    vi.stubGlobal('fetch', mockFetch as unknown as typeof fetch);
    // Make Map.get behave like Headers.get
    (mockFetch as unknown as { mock: { results: { value: { headers: Map<string, string> } }[] } });

    // The connector calls resp.headers.get(...) — mock with a Headers-like
    const realFetch = vi.fn(async (url: string) => ({
      ok: true,
      text: async () => `<html><body>hello from ${url}</body></html>`,
      headers: { get: () => 'text/html' },
    }));
    vi.stubGlobal('fetch', realFetch as unknown as typeof fetch);

    const c = createWebConnector({
      type: 'web',
      name: 'w',
      urls: ['https://example.com/a', 'https://example.com/b'],
    });
    const events = await c.poll();
    expect(events).toHaveLength(2);
    expect(events[0]!.connector).toBe('web');
    expect(events[0]!.source).toBe('web:https://example.com/a');
    expect(events[1]!.source).toBe('web:https://example.com/b');
    expect(events[0]!.action).toBe('update');
    expect(c.getSyncState().itemsSynced).toBe(2);
  });

  it('skips failed URLs without throwing', async () => {
    const realFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', realFetch as unknown as typeof fetch);
    const c = createWebConnector({
      type: 'web',
      name: 'w',
      urls: ['https://gone.example/'],
    });
    const events = await c.poll();
    expect(events).toHaveLength(0);
  });
});

describe('createNotionConnector — apiKey gating', () => {
  it('throws when apiKey is missing', async () => {
    const c = createNotionConnector({ type: 'notion', name: 'n', databaseId: 'db' });
    await expect(c.poll()).rejects.toThrow(/apiKey/);
  });
});

describe('createSlackConnector — apiKey gating', () => {
  it('throws when apiKey is missing', async () => {
    const c = createSlackConnector({ type: 'slack', name: 's', channelId: 'C123' });
    await expect(c.poll()).rejects.toThrow(/apiKey/);
  });
});
