/**
 * @module p2p/file-backed-relay
 * @description JSONL-persistent extension of `InMemoryRelay`.
 *
 *   Same in-memory data structures + dedup / replaceability rules,
 *   but every successful publish appends the canonical event to a
 *   JSONL file. On construction, the file is replayed back through
 *   `super.publish` so the in-memory state is identical to where it
 *   left off before the last shutdown.
 *
 *   File format: one JSON-encoded `P2pEvent` per line. Append-only.
 *   Compaction (rewriting the file to drop superseded events under
 *   NIP-33 rules) is a future concern; for v1.2 the file grows
 *   monotonically until the operator rotates it manually.
 *
 *   Crash safety: writes go through `fs.appendFileSync`, so a
 *   crashed process loses at most the in-flight event. Loading
 *   tolerates malformed lines (skips them with a stderr warning).
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { InMemoryRelay } from './relay.js';
import type { P2pEvent } from './types.js';

export interface FileBackedRelayOptions {
  /**
   * Optional logger for malformed-line / IO-error warnings. Defaults
   * to writing to stderr — must not log to stdout in stdio MCP mode.
   */
  readonly log?: (message: string) => void;
}

export class FileBackedRelay extends InMemoryRelay {
  private readonly path: string;
  private readonly log: (message: string) => void;
  private readonly skipPersistOnReplay = new WeakSet<P2pEvent>();

  constructor(path: string, opts: FileBackedRelayOptions = {}) {
    super();
    this.path = path;
    this.log = opts.log ?? ((m) => process.stderr.write(`[file-backed-relay] ${m}\n`));
    this.ensureDirectoryExists();
    this.replayFromDisk();
  }

  /** The on-disk path being used. Useful for status reporting. */
  filePath(): string {
    return this.path;
  }

  override async publish(event: P2pEvent): Promise<{ ok: boolean; reason?: string }> {
    const result = await super.publish(event);
    if (result.ok && !this.skipPersistOnReplay.has(event)) {
      try {
        appendFileSync(this.path, JSON.stringify(event) + '\n', { encoding: 'utf8' });
      } catch (err) {
        // Surface persistence errors to the caller so they don't
        // believe an event is durable when it isn't.
        return {
          ok: false,
          reason: `Persisted publish failed: ${(err as Error).message}`,
        };
      }
    }
    return result;
  }

  // ── Internals ────────────────────────────────────────────

  private ensureDirectoryExists(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); }
      catch (err) { this.log(`Could not create dir ${dir}: ${(err as Error).message}`); }
    }
  }

  private replayFromDisk(): void {
    if (!existsSync(this.path)) return;
    let content: string;
    try { content = readFileSync(this.path, 'utf8'); }
    catch (err) {
      this.log(`Could not read ${this.path}: ${(err as Error).message}`);
      return;
    }
    let replayed = 0;
    let skipped = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: P2pEvent;
      try { event = JSON.parse(trimmed) as P2pEvent; }
      catch { skipped++; continue; }
      // Mark the event so super.publish doesn't re-append it
      this.skipPersistOnReplay.add(event);
      // Use super.publish (NOT this.publish) so we go through the
      // dedup + replaceability logic of the in-memory relay. This
      // is sync from our perspective — the InMemoryRelay's publish
      // only awaits internally for the queueMicrotask broadcast.
      void super.publish(event);
      replayed++;
    }
    if (replayed > 0 || skipped > 0) {
      this.log(`Replayed ${replayed} event(s) from ${this.path}${skipped > 0 ? ` (skipped ${skipped} malformed)` : ''}`);
    }
  }
}
