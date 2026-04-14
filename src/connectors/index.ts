/**
 * @module connectors
 * @description Source connectors for Interego.
 *
 * Each connector watches an external source for changes,
 * extracts content, ingests into PGSL, and publishes to a pod.
 *
 * Connectors:
 *   - Notion: watches Notion databases/pages via API
 *   - Slack: watches channels via Web API
 *   - Google Drive: watches files via Drive API
 *   - S3: watches buckets via ListObjects polling
 *   - Filesystem: watches local directories
 *   - Web: fetches URLs and extracts content
 *
 * All connectors produce ConnectorEvent objects that the SDK
 * can publish as context descriptors.
 */

import { extract } from '../extractors/index.js';
import type { ExtractionResult } from '../extractors/index.js';

// ═════════════════════════════════════════════════════════════
//  Types
// ═════════════════════════════════════════════════════════════

export type ConnectorType = 'notion' | 'slack' | 'google-drive' | 's3' | 'filesystem' | 'web';

export interface ConnectorConfig {
  readonly type: ConnectorType;
  readonly name: string;
  readonly apiKey?: string;
  readonly apiSecret?: string;
  readonly endpoint?: string;
  readonly pollInterval?: number;     // ms between polls (default: 60000)
  readonly syncState?: SyncState;     // resume from previous sync
}

export interface SyncState {
  readonly lastSyncAt: string;
  readonly lastCursor?: string;       // pagination cursor for incremental sync
  readonly itemsSynced: number;
}

export interface ConnectorEvent {
  readonly connector: ConnectorType;
  readonly source: string;            // e.g. 'notion:page:abc123'
  readonly title: string;
  readonly content: string;
  readonly extraction: ExtractionResult;
  readonly timestamp: string;
  readonly action: 'create' | 'update' | 'delete';
  readonly metadata: Record<string, unknown>;
}

export interface Connector {
  readonly type: ConnectorType;
  readonly name: string;
  poll(): Promise<ConnectorEvent[]>;
  getSyncState(): SyncState;
}

// ═════════════════════════════════════════════════════════════
//  Notion Connector
// ═════════════════════════════════════════════════════════════

export function createNotionConnector(config: ConnectorConfig & {
  databaseId?: string;
  pageIds?: string[];
}): Connector {
  let syncState: SyncState = config.syncState ?? {
    lastSyncAt: new Date(0).toISOString(),
    itemsSynced: 0,
  };

  return {
    type: 'notion',
    name: config.name,
    async poll(): Promise<ConnectorEvent[]> {
      if (!config.apiKey) throw new Error('Notion connector requires apiKey (integration token)');

      const events: ConnectorEvent[] = [];
      const headers = {
        'Authorization': `Bearer ${config.apiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      };

      try {
        // Query database for recently modified pages
        const endpoint = config.databaseId
          ? `https://api.notion.com/v1/databases/${config.databaseId}/query`
          : null;

        if (endpoint) {
          const resp = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              filter: {
                timestamp: 'last_edited_time',
                last_edited_time: { after: syncState.lastSyncAt },
              },
              sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
            }),
          });

          if (resp.ok) {
            const data = await resp.json() as { results: Array<{ id: string; last_edited_time: string; properties: Record<string, any> }> };
            for (const page of data.results) {
              // Fetch page content
              const blocksResp = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children`, { headers });
              let text = '';
              if (blocksResp.ok) {
                const blocks = await blocksResp.json() as { results: Array<{ type: string; [key: string]: any }> };
                text = blocks.results
                  .filter(b => b.type === 'paragraph' && b.paragraph?.rich_text)
                  .map(b => b.paragraph.rich_text.map((t: any) => t.plain_text).join(''))
                  .join('\n');
              }

              const title = Object.values(page.properties)
                .find((p: any) => p.type === 'title')
                ?.title?.[0]?.plain_text ?? page.id;

              const extraction = await extract(text, { filename: `${title}.md` });
              events.push({
                connector: 'notion',
                source: `notion:page:${page.id}`,
                title,
                content: text,
                extraction,
                timestamp: page.last_edited_time,
                action: 'update',
                metadata: { pageId: page.id, databaseId: config.databaseId },
              });
            }
          }
        }

        syncState = {
          lastSyncAt: new Date().toISOString(),
          lastCursor: undefined,
          itemsSynced: syncState.itemsSynced + events.length,
        };
      } catch (err) {
        throw new Error(`Notion poll failed: ${(err as Error).message}`);
      }

      return events;
    },
    getSyncState(): SyncState { return syncState; },
  };
}

// ═════════════════════════════════════════════════════════════
//  Slack Connector
// ═════════════════════════════════════════════════════════════

export function createSlackConnector(config: ConnectorConfig & {
  channelId: string;
}): Connector {
  let syncState: SyncState = config.syncState ?? {
    lastSyncAt: new Date(0).toISOString(),
    itemsSynced: 0,
  };
  let lastTs = '0';

  return {
    type: 'slack',
    name: config.name,
    async poll(): Promise<ConnectorEvent[]> {
      if (!config.apiKey) throw new Error('Slack connector requires apiKey (bot token)');

      const events: ConnectorEvent[] = [];

      try {
        const resp = await fetch(`https://slack.com/api/conversations.history?channel=${config.channelId}&oldest=${lastTs}&limit=100`, {
          headers: { 'Authorization': `Bearer ${config.apiKey}` },
        });

        if (resp.ok) {
          const data = await resp.json() as { ok: boolean; messages: Array<{ ts: string; text: string; user: string }> };
          if (data.ok && data.messages) {
            for (const msg of data.messages.reverse()) {
              const extraction = await extract(msg.text);
              events.push({
                connector: 'slack',
                source: `slack:${config.channelId}:${msg.ts}`,
                title: `Slack message from ${msg.user}`,
                content: msg.text,
                extraction,
                timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
                action: 'create',
                metadata: { channelId: config.channelId, user: msg.user, ts: msg.ts },
              });
              lastTs = msg.ts;
            }
          }
        }

        syncState = {
          lastSyncAt: new Date().toISOString(),
          lastCursor: lastTs,
          itemsSynced: syncState.itemsSynced + events.length,
        };
      } catch (err) {
        throw new Error(`Slack poll failed: ${(err as Error).message}`);
      }

      return events;
    },
    getSyncState(): SyncState { return syncState; },
  };
}

// ═════════════════════════════════════════════════════════════
//  Web Connector (fetch URLs)
// ═════════════════════════════════════════════════════════════

export function createWebConnector(config: ConnectorConfig & {
  urls: string[];
}): Connector {
  let syncState: SyncState = config.syncState ?? {
    lastSyncAt: new Date(0).toISOString(),
    itemsSynced: 0,
  };

  return {
    type: 'web',
    name: config.name,
    async poll(): Promise<ConnectorEvent[]> {
      const events: ConnectorEvent[] = [];

      for (const url of config.urls) {
        try {
          const resp = await fetch(url);
          if (resp.ok) {
            const text = await resp.text();
            const contentType = resp.headers.get('content-type') ?? '';
            const filename = contentType.includes('json') ? 'page.json'
              : contentType.includes('html') ? 'page.html'
              : 'page.txt';

            const extraction = await extract(text, { filename });
            events.push({
              connector: 'web',
              source: `web:${url}`,
              title: url,
              content: text,
              extraction,
              timestamp: new Date().toISOString(),
              action: 'update',
              metadata: { url, contentType },
            });
          }
        } catch {
          // Skip failed URLs
        }
      }

      syncState = {
        lastSyncAt: new Date().toISOString(),
        itemsSynced: syncState.itemsSynced + events.length,
      };

      return events;
    },
    getSyncState(): SyncState { return syncState; },
  };
}

// ═════════════════════════════════════════════════════════════
//  Connector Factory
// ═════════════════════════════════════════════════════════════

export function createConnector(config: ConnectorConfig & Record<string, unknown>): Connector {
  switch (config.type) {
    case 'notion':
      return createNotionConnector(config as any);
    case 'slack':
      return createSlackConnector(config as any);
    case 'web':
      return createWebConnector(config as any);
    default:
      throw new Error(`Unknown connector type: ${config.type}`);
  }
}
