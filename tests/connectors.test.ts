import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createConnector,
  createNotionConnector,
  createSlackConnector,
  createWebConnector,
} from '@interego/connectors';

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

  // ★ THE REQUIRED FIELD EACH FACTORY CANNOT DO WITHOUT, WHICH `createConnector` USED TO
  // DROP. Its signature is `ConnectorConfig & Record<string, unknown>` and it dispatched
  // through `as any`, so `{ type: 'slack', name: 'x' }` compiled, ran, and produced a
  // connector that polled `channels.history?channel=undefined` on every tick. Both
  // directions pinned: the refusal, and that a config carrying the field still builds —
  // a guard that refuses everything would pass the first assertion on its own.
  it('refuses a slack connector with no channelId, and builds one with it', () => {
    expect(() =>
      createConnector({ type: 'slack', name: 'no-channel', apiKey: 'tok' }),
    ).toThrow(/requires 'channelId'/);
    expect(
      createConnector({ type: 'slack', name: 'ok', apiKey: 'tok', channelId: 'C1' }),
    ).toBeTruthy();
  });

  it('refuses a web connector with no urls (and with an empty list), and builds one with them', () => {
    expect(() => createConnector({ type: 'web', name: 'no-urls' })).toThrow(/requires 'urls'/);
    // An empty array is the same defect wearing a value: a poller with nothing to poll.
    expect(() => createConnector({ type: 'web', name: 'empty', urls: [] })).toThrow(/requires 'urls'/);
    expect(createConnector({ type: 'web', name: 'ok', urls: ['https://example.com'] })).toBeTruthy();
  });
});

describe('createWebConnector', () => {
  it('fetches each URL and emits an event with extracted content', async () => {
    // ★ A dead first mock used to sit here: a `mockFetch` whose `headers` was a `Map`,
    // stubbed onto the global and then overwritten by `realFetch` five lines later without
    // ever being fetched through. Between the two stubs was
    //
    //   (mockFetch as unknown as { mock: { results: ... } });
    //
    // — an expression statement that evaluates a cast and discards it. The comment above it
    // said "Make Map.get behave like Headers.get"; the line did nothing at all, and the
    // Map-based mock it was meant to repair was already unreachable. Deleting both leaves
    // the Headers-like mock that the connector has always actually run against.
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
