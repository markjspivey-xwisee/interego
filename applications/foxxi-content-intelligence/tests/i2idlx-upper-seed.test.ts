/**
 * The upper-ontology seed: what `i2idlx/tools/seed-pinned-upper.mjs --all` may and may not put in
 * the directory build-ghcr.yml hands the Foxxi image build as its `upper-seed` context.
 *
 * The image build fetched all 21 manifest-pinned sources from their publishers on every build, and
 * on 2026-10-27 one of them (data.europa.eu, ESCO) timing out held back every service's deploy. The
 * seed lets the build read verified bytes instead, so it must hold to three things:
 *
 *   1. It never writes bytes that are not the pin, and it removes any file that is not.
 *      refresh-upper.ts refuses a cached file that does not match and does NOT fall back to a live
 *      fetch, so one wrong file in the seed would fail the build it was meant to protect.
 *   2. It skips nothing silently. Every pinned key ends up cached, seeded or skipped with a reason,
 *      and every skip is a warning, because a skipped source is one the build still fetches live.
 *   3. It says whether the set is complete, because the workflow saves the cache only then.
 *
 * Every test here stands in for the network; nothing is fetched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIRRORS, USER_AGENT, readAccepts, readPins, seedAll, seedMirrors, writeVerified, type FetchLike,
} from '../i2idlx/tools/seed-pinned-upper.mjs';

const I2IDLX = fileURLToPath(new URL('../i2idlx/', import.meta.url));
const SCRIPT = join(I2IDLX, 'tools', 'seed-pinned-upper.mjs');
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const GUFO_URL = 'https://purl.org/nemo/gufo';
const BYTES = { alpha: 'alpha ontology bytes\n', gufo: 'gufo ontology bytes\n', esco: 'esco rdf/xml bytes\n' } as const;
const PINS = [
  { key: 'alpha', url: 'https://alpha.example/ontology.ttl', sha256: sha(BYTES.alpha) },
  { key: 'gufo', url: GUFO_URL, sha256: sha(BYTES.gufo) },
  { key: 'esco', url: 'https://data.europa.eu/esco/model', sha256: sha(BYTES.esco) },
];

/** url → what that URL does: answer with these bytes, or fail as a network failure does. */
type Behaviour = string | 'network-error' | ((call: number) => string | 'network-error');
interface Call { url: string; headers: Record<string, string> }

function fakeNetwork(routes: Record<string, Behaviour>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const seen = new Map<string, number>();
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const n = (seen.get(url) ?? 0) + 1;
    seen.set(url, n);
    const route = routes[url];
    const outcome = typeof route === 'function' ? route(n) : route;
    if (outcome === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    if (outcome === 'network-error') throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ETIMEDOUT' }) });
    const bytes = new TextEncoder().encode(outcome);
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
  };
  return { fetchImpl, calls };
}

const healthy = (): Record<string, Behaviour> => ({
  [PINS[0]!.url]: BYTES.alpha,
  [MIRRORS.gufo!.mirror]: BYTES.gufo,
  [PINS[2]!.url]: BYTES.esco,
});

let root: string;
let out: string;
let lines: string[];
const log = (line: string): void => { lines.push(line); };
const fast = { backoffMs: 0, timeoutMs: 1000, attempts: 3, log };

function writeRoot(pins: readonly object[]): void {
  mkdirSync(join(root, 'evidence', 'upper'), { recursive: true });
  mkdirSync(join(root, 'typescript'), { recursive: true });
  writeFileSync(join(root, 'evidence', 'upper', 'manifest.json'), JSON.stringify({ fetchedAt: 'test', sources: pins }));
  writeFileSync(join(root, 'typescript', 'refresh-upper-data.json'), JSON.stringify({
    SOURCES: [{ key: 'gufo', accept: 'text/turtle' }, { key: 'esco', accept: 'application/rdf+xml' }, { key: 'alpha' }],
  }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'i2idlx-upper-seed-'));
  out = join(root, '.cache', 'upper-seed');
  lines = [];
  writeRoot(PINS);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const files = (): string[] => (existsSync(out) ? readdirSync(out).sort() : []);

describe('seed-pinned-upper --all: only the pinned bytes, and every key accounted for', () => {
  it('seeds every pinned source, through the gUFO mirror, with the request refresh-upper.ts makes', async () => {
    const net = fakeNetwork(healthy());
    const report = await seedAll(root, out, { ...fast, fetchImpl: net.fetchImpl });

    expect(report.complete).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.seeded.map(s => s.key)).toEqual(['alpha', 'esco', 'gufo']);
    expect(files()).toEqual(['alpha.source', 'esco.source', 'gufo.source']);
    for (const [key, text] of Object.entries(BYTES)) expect(readFileSync(join(out, key + '.source'), 'utf8')).toBe(text);

    // gUFO came from the commit-addressed copy; its persistent URL was never asked.
    expect(net.calls.map(c => c.url)).toContain(MIRRORS.gufo!.mirror);
    expect(net.calls.map(c => c.url)).not.toContain(GUFO_URL);
    // Same User-Agent and Accept as refresh-upper.ts, so a negotiating publisher answers alike.
    const esco = net.calls.find(c => c.url === PINS[2]!.url)!;
    expect(esco.headers).toEqual({ 'User-Agent': USER_AGENT, Accept: 'application/rdf+xml' });
    expect(net.calls.find(c => c.url === PINS[0]!.url)!.headers).toEqual({ 'User-Agent': USER_AGENT });
    expect(lines.at(-1)).toMatch(/^upper seed complete: all 3 pinned sources verified/);
  });

  it('refuses bytes that are not the pin: nothing is written, and the skip is a warning that names it', async () => {
    const net = fakeNetwork({ ...healthy(), [PINS[2]!.url]: 'what the publisher serves today\n' });
    const report = await seedAll(root, out, { ...fast, fetchImpl: net.fetchImpl });

    expect(report.complete).toBe(false);
    expect(report.missing).toEqual(['esco']);
    expect(files()).toEqual(['alpha.source', 'gufo.source']);
    expect(report.skipped[0]!.reason).toContain(PINS[2]!.url + ' served SHA-256 ' + sha('what the publisher serves today\n'));
    // A mismatch is a different document, not a transient failure: asked once, not retried.
    expect(net.calls.filter(c => c.url === PINS[2]!.url)).toHaveLength(1);
    expect(lines.some(l => l.startsWith('::warning::upper seed: esco: not seeded, so the image build fetches it live.'))).toBe(true);
    expect(lines.at(-1)).toBe('upper seed INCOMPLETE: 2 of 3 pinned sources verified in ' + out + '; not seeded: esco');
  });

  it('retries a failed request, then reports the source as skipped rather than dropping it', async () => {
    const net = fakeNetwork({ ...healthy(), [PINS[0]!.url]: 'network-error' });
    const report = await seedAll(root, out, { ...fast, fetchImpl: net.fetchImpl });

    expect(net.calls.filter(c => c.url === PINS[0]!.url)).toHaveLength(fast.attempts);
    expect(report.skipped).toEqual([{ key: 'alpha', reason: expect.stringContaining('fetch failed (ETIMEDOUT)') }]);
    expect(report.complete).toBe(false);
    // Every pinned key in exactly one bucket: nothing vanished, nothing counted twice.
    const buckets = [...report.cached, ...report.seeded.map(s => s.key), ...report.skipped.map(s => s.key)];
    expect(buckets.sort()).toEqual(PINS.map(p => p.key).sort());
  });

  it('a failure that clears on a retry still seeds', async () => {
    const net = fakeNetwork({ ...healthy(), [PINS[0]!.url]: n => (n === 1 ? 'network-error' : BYTES.alpha) });
    const report = await seedAll(root, out, { ...fast, fetchImpl: net.fetchImpl });
    expect(report.complete).toBe(true);
    expect(net.calls.filter(c => c.url === PINS[0]!.url)).toHaveLength(2);
  });

  it('keeps a file that matches its pin without fetching it, and removes what is not a pinned source', async () => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'alpha.source'), BYTES.alpha);
    writeFileSync(join(out, 'esco.source'), 'stale esco bytes from an older pin\n');
    writeFileSync(join(out, 'retired.source'), 'a source the manifest no longer pins\n');
    writeFileSync(join(out, 'gufo.source.4242.download'), 'an interrupted write');
    const net = fakeNetwork(healthy());
    const report = await seedAll(root, out, { ...fast, fetchImpl: net.fetchImpl });

    expect(report.cached).toEqual(['alpha']);
    expect(net.calls.map(c => c.url)).not.toContain(PINS[0]!.url);
    expect(report.removed.sort()).toEqual(['esco.source', 'gufo.source.4242.download', 'retired.source']);
    expect(files()).toEqual(['alpha.source', 'esco.source', 'gufo.source']);
    expect(readFileSync(join(out, 'esco.source'), 'utf8')).toBe(BYTES.esco);
    expect(report.complete).toBe(true);
  });

  it('a file that is not the pin is removed even when no replacement can be fetched', async () => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'esco.source'), 'stale esco bytes\n');
    const net = fakeNetwork({ ...healthy(), [PINS[2]!.url]: 'network-error' });
    const report = await seedAll(root, out, { ...fast, fetchImpl: net.fetchImpl });
    expect(existsSync(join(out, 'esco.source'))).toBe(false);
    expect(report.missing).toEqual(['esco']);
    expect(lines).toContain('::warning::upper seed: esco: removed a cached file whose bytes are not the pin');
  });

  it('falls back from a failed mirror to the pinned URL, whose bytes must still be the pin', async () => {
    const net = fakeNetwork({ ...healthy(), [MIRRORS.gufo!.mirror]: 'network-error', [GUFO_URL]: 'gUFO as re-committed upstream\n' });
    const report = await seedAll(root, out, { ...fast, fetchImpl: net.fetchImpl });
    expect(report.missing).toEqual(['gufo']);
    expect(report.skipped[0]!.reason).toContain(MIRRORS.gufo!.mirror + ': fetch failed');
    expect(report.skipped[0]!.reason).toContain(GUFO_URL + ' served SHA-256 ' + sha('gUFO as re-committed upstream\n'));
    expect(files()).not.toContain('gufo.source');
  });

  it('a pin without a SHA-256 is skipped without a request', async () => {
    writeRoot([...PINS.slice(0, 2), { key: 'esco', url: PINS[2]!.url }]);
    const net = fakeNetwork(healthy());
    const report = await seedAll(root, out, { ...fast, fetchImpl: net.fetchImpl });
    expect(report.skipped).toEqual([{ key: 'esco', reason: 'the manifest has no SHA-256 pin to verify it against' }]);
    expect(net.calls.map(c => c.url)).not.toContain(PINS[2]!.url);
  });

  it('refuses a manifest key that could name a file outside the directory', () => {
    writeRoot([{ key: '../escape', url: 'https://x.example/', sha256: sha('x') }]);
    expect(() => readPins(root)).toThrow(/cannot name a cache file/);
  });
});

describe('writeVerified is the only writer, and it checks the bytes itself', () => {
  it('refuses bytes that are not the pin and leaves nothing behind', () => {
    mkdirSync(out, { recursive: true });
    const target = join(out, 'esco.source');
    expect(() => writeVerified(target, new TextEncoder().encode('not the pin'), PINS[2]!)).toThrow(/refusing to write/);
    expect(() => writeVerified(target, new TextEncoder().encode(BYTES.esco), { key: 'esco' })).toThrow(/refusing to write/);
    expect(files()).toEqual([]);
    writeVerified(target, new TextEncoder().encode(BYTES.esco), PINS[2]!);
    expect(files()).toEqual(['esco.source']);
  });
});

describe('the command line tells the workflow whether to save the cache', () => {
  const run = (outFile: string): string => execFileSync(process.execPath, [SCRIPT, root, '--all', out], {
    encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outFile },
  });

  it('complete=true when every pin is already verified (and nothing is fetched)', () => {
    mkdirSync(out, { recursive: true });
    for (const [key, text] of Object.entries(BYTES)) writeFileSync(join(out, key + '.source'), text);
    const outputs = join(root, 'github-output');
    expect(run(outputs)).toContain('upper seed complete: all 3 pinned sources verified');
    expect(readFileSync(outputs, 'utf8')).toBe('complete=true\nmissing=\n');
  });

  it('complete=false, naming what is missing, and still exit 0: the seed never fails the leg', () => {
    writeRoot([...PINS.slice(0, 2), { key: 'esco', url: PINS[2]!.url }]);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'alpha.source'), BYTES.alpha);
    writeFileSync(join(out, 'gufo.source'), BYTES.gufo);
    const outputs = join(root, 'github-output');
    expect(run(outputs)).toContain('::warning::upper seed: esco: not seeded');
    expect(readFileSync(outputs, 'utf8')).toBe('complete=false\nmissing=esco\n');
  });
});

describe('against the real manifest', () => {
  const realPins = readPins(I2IDLX);

  it('asks for every source the manifest pins, with refresh-upper.ts\'s Accept, and writes nothing it could not verify', async () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'i2idlx-upper-real-'));
    try {
      mkdirSync(join(realRoot, 'evidence', 'upper'), { recursive: true });
      mkdirSync(join(realRoot, 'typescript'), { recursive: true });
      writeFileSync(join(realRoot, 'evidence', 'upper', 'manifest.json'), readFileSync(join(I2IDLX, 'evidence', 'upper', 'manifest.json')));
      writeFileSync(join(realRoot, 'typescript', 'refresh-upper-data.json'), readFileSync(join(I2IDLX, 'typescript', 'refresh-upper-data.json')));
      const seedDir = join(realRoot, 'seed');
      // Every URL answers, with bytes that are no pin.
      const calls: Call[] = [];
      const fetchImpl: FetchLike = async (url, init) => {
        calls.push({ url, headers: init.headers });
        const bytes = new TextEncoder().encode('not the pinned bytes');
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer as ArrayBuffer };
      };
      const report = await seedAll(realRoot, seedDir, { fetchImpl, backoffMs: 0, attempts: 1, log: () => {} });

      expect(realPins.length).toBeGreaterThanOrEqual(21);
      expect(report.missing).toEqual(realPins.map(p => p.key).sort());
      expect(readdirSync(seedDir)).toEqual([]);
      const accepts = readAccepts(I2IDLX);
      for (const pin of realPins) {
        const asked = calls.find(c => c.url === pin.url || c.url === MIRRORS[pin.key]?.mirror);
        expect(asked, pin.key + ' was never requested').toBeTruthy();
        expect(asked!.headers.Accept).toBe(accepts.get(pin.key));
      }
    } finally {
      rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it('every mirror is for a source the manifest pins at that URL, and is commit-addressed', () => {
    for (const [key, { url, mirror }] of Object.entries(MIRRORS)) {
      const pin = realPins.find(p => p.key === key);
      expect(pin, key + ' has a mirror but no pin').toBeTruthy();
      expect(pin!.url).toBe(url);
      expect(mirror).toMatch(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//);
    }
  });
});

describe('default mode, which the Dockerfile and the I2IDL-X workflows run, is unchanged', () => {
  it('seeds the mirrored sources into <root>/.cache/upper and stops on bytes that are not the pin', async () => {
    const good = fakeNetwork(healthy());
    await seedMirrors(root, { fetchImpl: good.fetchImpl, backoffMs: 0, log });
    expect(readFileSync(join(root, '.cache', 'upper', 'gufo.source'), 'utf8')).toBe(BYTES.gufo);
    expect(good.calls.map(c => c.url)).toEqual([MIRRORS.gufo!.mirror]);

    rmSync(join(root, '.cache'), { recursive: true, force: true });
    const bad = fakeNetwork({ [MIRRORS.gufo!.mirror]: 'a different commit\n' });
    await expect(seedMirrors(root, { fetchImpl: bad.fetchImpl, backoffMs: 0, log })).rejects.toThrow(/update the mirror commit with the pin/);
    expect(existsSync(join(root, '.cache', 'upper', 'gufo.source'))).toBe(false);
  });
});
