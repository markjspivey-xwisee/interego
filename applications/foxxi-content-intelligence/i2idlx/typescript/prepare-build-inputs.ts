/**
 * Shared native build prerequisites for the golden gate and Docker.
 * Retain every committed evidence snapshot. Restore only missing xAPI Turtle
 * snapshots and byte-pinned upper ontologies/ROBOT; never perform --all refresh.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ROOT, loadConfig } from './config.js';
import { parseTurtle } from './rdf.js';
import { refreshEvidence } from './refresh-evidence.js';
import { refreshUpper } from './refresh-upper.js';
import { progressStage } from './progress.js';

const XAPI_SNAPSHOTS = [
  ['xapi-ontology.ttl', 'https://w3id.org/xapi/ontology'],
  ['xapi-profile-ontology.ttl', 'https://w3id.org/xapi/profiles/ontology'],
] as const;
interface XapiReceipt {
  file: string; source: string; resolvedUrl: string; sha256: string; bytes: number;
}
interface SnapshotDocument { capturedAt?: string; snapshots: XapiReceipt[] }
function receiptRows(document: XapiReceipt[] | SnapshotDocument): XapiReceipt[] {
  return Array.isArray(document) ? document : document.snapshots;
}
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Fetch only a missing unversioned xAPI source; existing snapshots are immutable inputs. */
async function missingXapi(root: string): Promise<void> {
  const evidence = join(root, 'evidence'), temporary = join(root, '.cache', 'golden-inputs');
  const committedPath = join(evidence, 'xapi-snapshots.json');
  const committed = existsSync(committedPath) ? receiptRows(JSON.parse(await readFile(committedPath, 'utf8')) as XapiReceipt[] | SnapshotDocument) : [];
  const pins = new Map(committed.map(row => [row.file, row]));
  if (existsSync(committedPath)) {
    assert.equal(committed.length, XAPI_SNAPSHOTS.length, 'committed xAPI receipt must contain exactly both snapshots');
    assert.equal(pins.size, XAPI_SNAPSHOTS.length, 'committed xAPI receipt must pin exactly both official snapshots');
    for (const [file, source] of XAPI_SNAPSHOTS) {
      const pin = pins.get(file);
      assert.ok(pin, 'committed xAPI receipt is missing ' + file);
      assert.equal(pin.source, source, 'committed xAPI receipt names another source: ' + file);
      assert.match(pin.sha256, /^[a-f0-9]{64}$/, 'invalid committed xAPI SHA-256: ' + file);
      assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes > 0, 'invalid committed xAPI byte count: ' + file);
      assert.equal(new URL(pin.resolvedUrl).protocol, 'https:', 'committed xAPI resolved URL must remain HTTPS: ' + file);
      if (existsSync(join(evidence, file))) {
        const bytes = await readFile(join(evidence, file));
        assert.equal(sha256(bytes), pin.sha256, 'existing xAPI snapshot differs from its committed pin: ' + file);
        assert.equal(bytes.length, pin.bytes, 'existing xAPI snapshot size differs from its committed pin: ' + file);
        parseTurtle(bytes.toString('utf8'), pin.resolvedUrl);
      }
    }
  }
  const missing = XAPI_SNAPSHOTS.filter(([file]) => !existsSync(join(evidence, file)));
  if (!missing.length) return;
  await mkdir(temporary, { recursive: true });
  const receiptPath = join(temporary, 'xapi-snapshots.json');
  const old: XapiReceipt[] = existsSync(receiptPath) ? receiptRows(JSON.parse(await readFile(receiptPath, 'utf8')) as XapiReceipt[] | SnapshotDocument) : [];
  const receipts = new Map(old.map(row => [row.file, row]));
  const prepared: { file: string; bytes: Buffer }[] = [];
  for (const [file, source] of missing) {
    const cached = join(temporary, file), prior = pins.get(file) || receipts.get(file);
    let bytes: Buffer, receipt: XapiReceipt;
    if (existsSync(cached) && prior) {
      bytes = await readFile(cached);
      assert.equal(prior.source, source, 'cached xAPI snapshot names another source: ' + file);
      assert.equal(sha256(bytes), prior.sha256, 'cached xAPI snapshot bytes changed: ' + file);
      receipt = prior;
    } else {
      const response = await fetch(source, {
        headers: { Accept: 'text/turtle', 'User-Agent': 'i2idlx-prepare-build-inputs/1.0' },
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(source + ' returned HTTP ' + response.status);
      if (new URL(response.url).protocol !== 'https:') throw new Error('xAPI source redirect left HTTPS: ' + response.url);
      bytes = Buffer.from(await response.arrayBuffer());
      receipt = { file, source, resolvedUrl: response.url, sha256: sha256(bytes), bytes: bytes.length };
    }
    const committedPin = pins.get(file);
    if (committedPin) {
      assert.equal(sha256(bytes), committedPin.sha256, 'missing xAPI publisher/cache bytes differ from committed pin: ' + file);
      assert.equal(bytes.length, committedPin.bytes, 'missing xAPI publisher/cache size differs from committed pin: ' + file);
      receipt = committedPin;
    }
    // Validate all missing files before installing any. No Foxxi manifest,
    // relay operation/schema, UNESCO or schema.org endpoint is requested.
    parseTurtle(bytes.toString('utf8'), receipt.resolvedUrl);
    prepared.push({ file, bytes });
    receipts.set(file, receipt);
  }
  for (const { file, bytes } of prepared) await writeFile(join(temporary, file), bytes);
  await writeFile(receiptPath, JSON.stringify([...receipts.values()].sort((a, b) => a.file.localeCompare(b.file)), null, 2) + '\n');
  await mkdir(evidence, { recursive: true });
  for (const { file, bytes } of prepared) {
    // Exclusive creation ensures a concurrent preparer cannot replace an input.
    try { await writeFile(join(evidence, file), bytes, { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      assert.equal(sha256(await readFile(join(evidence, file))), sha256(bytes), 'another preparer installed different xAPI bytes: ' + file);
    }
  }
}
export async function prepareBuildInputs(root = DEFAULT_ROOT): Promise<void> {
  root = resolve(root);
  await progressStage('inputs:upper', () => refreshUpper(root));
  await progressStage('inputs:xapi-missing', () => missingXapi(root));
  const cfg = loadConfig(root), reasoner = cfg.reasoner.jar;
  if (!existsSync(reasoner)) await progressStage('inputs:reasoner', () =>
    refreshEvidence(root, { mode: 'reasoner', reasonerFile: reasoner }));
  assert.equal(sha256(await readFile(reasoner)), cfg.reasoner.sha256, 'ROBOT jar differs from its recorded pin');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] || DEFAULT_ROOT;
  await prepareBuildInputs(root);
}
