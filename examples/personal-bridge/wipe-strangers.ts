/**
 * wipe-strangers — drop events from your encrypted bridge store
 * that are NOT authored by you (or by any pubkey on a small
 * allow-list).
 *
 * Use case: at some point you ran the bridge with EXTERNAL_RELAYS
 * set but no INBOUND_AUTHORS allow-list, so your events.jsonl
 * accumulated random kind-30040 events from other Nostr apps. This
 * script reads the file, decrypts each line, drops events whose
 * `pubkey` isn't in your keep-list, and writes the cleaned file
 * back. Original is moved to events.jsonl.bak.
 *
 * Run:
 *   BRIDGE_KEY=0x... node dist/wipe-strangers.js
 *
 * To keep additional authors beyond yourself, add them comma-separated:
 *   BRIDGE_KEY=0x... KEEP_AUTHORS=8318abc...,0x123... node dist/wipe-strangers.js
 *
 * Outputs a summary: how many events were kept, dropped, and where
 * the backup went.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { getNostrPubkey } from '@interego/core';
import type { P2pEvent } from '@interego/core';

const BRIDGE_KEY = process.env['BRIDGE_KEY'];
if (!BRIDGE_KEY) {
  process.stderr.write('Set BRIDGE_KEY (the same value used by the bridge) and re-run.\n');
  process.exit(2);
}

const dataDir = process.env['BRIDGE_DATA_DIR'] ?? join(homedir(), '.interego-bridge');
const eventsPath = join(dataDir, 'events.jsonl');
const backupPath = join(dataDir, 'events.jsonl.bak');

if (!existsSync(eventsPath)) {
  process.stderr.write(`No events file at ${eventsPath} — nothing to do.\n`);
  process.exit(0);
}

// Derive the storage key the same way the bridge does.
function deriveStorageKey(privateKeyHex: string): Uint8Array {
  const seed = privateKeyHex.toLowerCase().replace(/^0x/, '') + ':interego-bridge-storage-v1';
  return createHash('sha256').update(seed, 'utf8').digest();
}

const key = deriveStorageKey(BRIDGE_KEY);

// Compute every pubkey form the bridge identity might use, so we
// keep events whether they were signed under ECDSA or Schnorr.
const KEEP_AUTHORS = new Set<string>();
KEEP_AUTHORS.add(getNostrPubkey(BRIDGE_KEY).toLowerCase()); // schnorr (x-only hex)
// ECDSA address form is harder to derive without ethers; if you
// signed under ECDSA in a prior run, add the 0x... address to
// KEEP_AUTHORS via env var.
const extra = (process.env['KEEP_AUTHORS'] ?? '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
for (const a of extra) KEEP_AUTHORS.add(a);

process.stderr.write(`Wiping strangers from ${eventsPath}\n`);
process.stderr.write(`Keeping events authored by:\n`);
for (const a of KEEP_AUTHORS) process.stderr.write(`  - ${a}\n`);

function decryptLine(line: string): P2pEvent | null {
  const colon = line.indexOf(':');
  if (colon < 0) {
    // Probably a plaintext line (pre-encryption format) — try parse
    try { return JSON.parse(line) as P2pEvent; }
    catch { return null; }
  }
  let nonce: Uint8Array, ct: Uint8Array;
  try {
    nonce = naclUtil.decodeBase64(line.slice(0, colon));
    ct = naclUtil.decodeBase64(line.slice(colon + 1));
  } catch { return null; }
  if (nonce.length !== nacl.secretbox.nonceLength) return null;
  const pt = nacl.secretbox.open(ct, nonce, key);
  if (!pt) return null;
  try { return JSON.parse(naclUtil.encodeUTF8(pt)) as P2pEvent; }
  catch { return null; }
}

function encryptLine(event: P2pEvent): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const json = JSON.stringify(event);
  const ct = nacl.secretbox(naclUtil.decodeUTF8(json), nonce, key);
  return `${naclUtil.encodeBase64(nonce)}:${naclUtil.encodeBase64(ct)}`;
}

const original = readFileSync(eventsPath, 'utf8');
const lines = original.split('\n');

let kept = 0;
let dropped = 0;
let unparseable = 0;
const keptLines: string[] = [];

for (const raw of lines) {
  const line = raw.trim();
  if (!line) continue;
  const event = decryptLine(line);
  if (!event) { unparseable++; continue; }
  const author = (event.pubkey ?? '').toLowerCase();
  if (KEEP_AUTHORS.has(author)) {
    keptLines.push(encryptLine(event));
    kept++;
  } else {
    dropped++;
  }
}

renameSync(eventsPath, backupPath);
writeFileSync(eventsPath, keptLines.join('\n') + (keptLines.length > 0 ? '\n' : ''), 'utf8');

process.stderr.write(`\nDone:\n`);
process.stderr.write(`  Kept:        ${kept}\n`);
process.stderr.write(`  Dropped:     ${dropped}\n`);
process.stderr.write(`  Unparseable: ${unparseable}\n`);
process.stderr.write(`  Backup:      ${backupPath}\n`);
process.stderr.write(`  Cleaned:     ${eventsPath}\n`);
