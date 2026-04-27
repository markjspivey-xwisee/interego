/**
 * @module p2p/file-backed-relay
 * @description JSONL-persistent extension of `InMemoryRelay`, with
 * optional at-rest encryption.
 *
 *   Same in-memory data structures + dedup / replaceability rules,
 *   but every successful publish appends the canonical event to a
 *   JSONL file. On construction, the file is replayed back through
 *   `super.publish` so the in-memory state is identical to where it
 *   left off before the last shutdown.
 *
 *   File format (plaintext mode):
 *     One JSON-encoded `P2pEvent` per line. Append-only.
 *
 *   File format (encrypted mode — when `encryptionKey` is set):
 *     `<nonce_base64>:<ciphertext_base64>\n` per line, where
 *     `secretbox(JSON.stringify(event), nonce, encryptionKey)`
 *     is the NaCl XSalsa20-Poly1305 envelope. Each line carries
 *     a fresh random nonce. A reader without the key sees only
 *     opaque base64 — no descriptor IDs, CIDs, summaries, or
 *     pubkeys are visible to anyone with read access to the file.
 *
 *   Compaction (rewriting the file to drop superseded events under
 *   NIP-33 rules) is a future concern; for v1.2 the file grows
 *   monotonically until the operator rotates it manually.
 *
 *   Crash safety: writes go through `fs.appendFileSync`, so a
 *   crashed process loses at most the in-flight event. Loading
 *   tolerates malformed/undecryptable lines (skips them with a
 *   stderr warning).
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { InMemoryRelay } from './relay.js';
import type { P2pEvent } from './types.js';

export interface FileBackedRelayOptions {
  /**
   * Optional logger for malformed-line / IO-error warnings. Defaults
   * to writing to stderr — must not log to stdout in stdio MCP mode.
   */
  readonly log?: (message: string) => void;
  /**
   * 32-byte symmetric key (base64-encoded) for at-rest encryption of
   * the JSONL file via NaCl XSalsa20-Poly1305. When set, every line
   * written is encrypted; lines that fail to decrypt on replay are
   * skipped with a stderr warning. Recommended: derive deterministically
   * from the wallet private key (sha256(privKey + 'storage-v1')) so the
   * same identity that signs events also opens the file.
   */
  readonly encryptionKey?: string;
}

export class FileBackedRelay extends InMemoryRelay {
  private readonly path: string;
  private readonly log: (message: string) => void;
  private readonly skipPersistOnReplay = new WeakSet<P2pEvent>();
  private readonly encryptionKey: Uint8Array | null;

  constructor(path: string, opts: FileBackedRelayOptions = {}) {
    super();
    this.path = path;
    this.log = opts.log ?? ((m) => process.stderr.write(`[file-backed-relay] ${m}\n`));
    if (opts.encryptionKey) {
      const keyBytes = naclUtil.decodeBase64(opts.encryptionKey);
      if (keyBytes.length !== nacl.secretbox.keyLength) {
        throw new Error(
          `FileBackedRelay encryptionKey must decode to ${nacl.secretbox.keyLength} bytes; got ${keyBytes.length}`,
        );
      }
      this.encryptionKey = keyBytes;
    } else {
      this.encryptionKey = null;
    }
    this.ensureDirectoryExists();
    this.replayFromDisk();
  }

  /** The on-disk path being used. Useful for status reporting. */
  filePath(): string {
    return this.path;
  }

  /** Whether at-rest encryption is enabled. */
  isEncrypted(): boolean {
    return this.encryptionKey !== null;
  }

  override async publish(event: P2pEvent): Promise<{ ok: boolean; reason?: string }> {
    const result = await super.publish(event);
    if (result.ok && !this.skipPersistOnReplay.has(event)) {
      try {
        const wireLine = this.serializeForDisk(event);
        appendFileSync(this.path, wireLine + '\n', { encoding: 'utf8' });
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

  // ── Encryption (NaCl XSalsa20-Poly1305) ──────────────────

  private serializeForDisk(event: P2pEvent): string {
    const json = JSON.stringify(event);
    if (!this.encryptionKey) return json;
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ct = nacl.secretbox(naclUtil.decodeUTF8(json), nonce, this.encryptionKey);
    return `${naclUtil.encodeBase64(nonce)}:${naclUtil.encodeBase64(ct)}`;
  }

  private deserializeFromDisk(line: string): P2pEvent | null {
    if (!this.encryptionKey) {
      try { return JSON.parse(line) as P2pEvent; }
      catch { return null; }
    }
    // Encrypted format: nonce_b64:ct_b64
    const colon = line.indexOf(':');
    if (colon < 0) return null;
    let nonce: Uint8Array, ct: Uint8Array;
    try {
      nonce = naclUtil.decodeBase64(line.slice(0, colon));
      ct = naclUtil.decodeBase64(line.slice(colon + 1));
    } catch { return null; }
    if (nonce.length !== nacl.secretbox.nonceLength) return null;
    const pt = nacl.secretbox.open(ct, nonce, this.encryptionKey);
    if (!pt) return null;
    try { return JSON.parse(naclUtil.encodeUTF8(pt)) as P2pEvent; }
    catch { return null; }
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
      const event = this.deserializeFromDisk(trimmed);
      if (!event) { skipped++; continue; }
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
