/**
 * @module connectors
 * @description Source connectors for Interego.
 *
 * Each connector watches an external source for changes,
 * extracts content, ingests into PGSL, and publishes to a pod.
 *
 * Implemented today:
 *   - Notion (`createNotionConnector`) — Notion API v1; query a database
 *     for pages modified since lastSyncAt, fetch block contents.
 *   - Slack (`createSlackConnector`) — `conversations.history` polling
 *     against a single channel; new messages since lastTs.
 *   - Web (`createWebConnector`) — HTTP GET against a URL list, content
 *     type sniffed for the extractor.
 *
 * Declared in `ConnectorType` but NOT implemented: `google-drive`,
 * `s3`, `filesystem`. `createConnector` throws on those types. Open
 * an issue if you need one before contributing — the existing three
 * are the minimum shape; new connectors should follow the same
 * `Connector` interface.
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

export interface ConnectorFailure {
  /** Source-specific identifier of the item that failed (URL, page ID, message ID, …). */
  readonly source: string;
  /** Human-readable reason — surfaces directly to operators / consumers. */
  readonly reason: string;
  /** ISO 8601 timestamp of the failure. */
  readonly at: string;
}

export interface Connector {
  readonly type: ConnectorType;
  readonly name: string;
  /**
   * Run one poll cycle. Returns successfully-extracted events; failures
   * are surfaced separately via {@link getLastFailures} rather than
   * thrown, so a partial-success run still progresses sync state. Pre-
   * production behaviour silently dropped failures; the reliability
   * audit flagged this as a "sync appears successful, data quietly
   * incomplete" support-ticket shape.
   */
  poll(): Promise<ConnectorEvent[]>;
  getSyncState(): SyncState;
  /**
   * Failures recorded during the most recent poll. Empty array means
   * every source item succeeded. Operators MUST surface non-empty
   * arrays to the user — silent partial sync is the failure mode this
   * field exists to prevent. Cleared at the start of each poll.
   */
  getLastFailures(): readonly ConnectorFailure[];
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
  let lastFailures: ConnectorFailure[] = [];

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
        lastFailures = [];
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Whole-poll failures (auth invalid, API shape changed) surface
        // through both the throw (so caller knows the poll failed) AND
        // lastFailures (so observability dashboards see the cause without
        // catching the throw).
        lastFailures = [{
          source: `notion:database:${config.databaseId ?? 'unknown'}`,
          reason: `Notion poll failed: ${reason}`,
          at: new Date().toISOString(),
        }];
        throw new Error(`Notion poll failed: ${reason}`);
      }

      return events;
    },
    getSyncState(): SyncState { return syncState; },
    getLastFailures(): readonly ConnectorFailure[] { return lastFailures; },
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
  let lastFailures: ConnectorFailure[] = [];

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
          const data = await resp.json() as { ok: boolean; messages: Array<{ ts: string; text: string; user: string }>; error?: string };
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
          } else if (!data.ok) {
            // Slack returned a 200 with ok:false — common shape for
            // invalid_auth / channel_not_found / not_in_channel. Used
            // to be invisible; surface it.
            lastFailures = [{
              source: `slack:${config.channelId}`,
              reason: `Slack API returned ok:false: ${data.error ?? 'unknown'}`,
              at: new Date().toISOString(),
            }];
          }
        } else {
          lastFailures = [{
            source: `slack:${config.channelId}`,
            reason: `Slack HTTP ${resp.status} ${resp.statusText}`,
            at: new Date().toISOString(),
          }];
        }

        syncState = {
          lastSyncAt: new Date().toISOString(),
          lastCursor: lastTs,
          itemsSynced: syncState.itemsSynced + events.length,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        lastFailures = [{
          source: `slack:${config.channelId}`,
          reason: `Slack poll failed: ${reason}`,
          at: new Date().toISOString(),
        }];
        throw new Error(`Slack poll failed: ${reason}`);
      }

      return events;
    },
    getSyncState(): SyncState { return syncState; },
    getLastFailures(): readonly ConnectorFailure[] { return lastFailures; },
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
  let lastFailures: ConnectorFailure[] = [];

  return {
    type: 'web',
    name: config.name,
    async poll(): Promise<ConnectorEvent[]> {
      const events: ConnectorEvent[] = [];
      const failures: ConnectorFailure[] = [];

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
          } else {
            // Non-OK status — record it so the operator sees which
            // URL produced a 4xx/5xx instead of an invisible drop.
            failures.push({
              source: `web:${url}`,
              reason: `HTTP ${resp.status} ${resp.statusText}`,
              at: new Date().toISOString(),
            });
          }
        } catch (err) {
          // Network/TLS/DNS error — surface the message rather than
          // silently skipping. Was the dominant invisible-failure mode
          // identified in the reliability audit.
          const reason = err instanceof Error ? err.message : String(err);
          failures.push({
            source: `web:${url}`,
            reason: `fetch error: ${reason}`,
            at: new Date().toISOString(),
          });
        }
      }

      syncState = {
        lastSyncAt: new Date().toISOString(),
        itemsSynced: syncState.itemsSynced + events.length,
      };
      lastFailures = failures;

      return events;
    },
    getSyncState(): SyncState { return syncState; },
    getLastFailures(): readonly ConnectorFailure[] { return lastFailures; },
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
