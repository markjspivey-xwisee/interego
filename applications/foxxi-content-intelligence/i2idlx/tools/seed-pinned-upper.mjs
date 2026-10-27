#!/usr/bin/env node
// Seeds .cache/upper/<key>.source with a pinned upper-ontology source fetched from an immutable,
// commit-addressed copy, for the sources whose manifest URL is a persistent URL its publisher can
// re-point. refresh-upper.ts trusts a cached source only after the same SHA-256 check as a fresh
// fetch, so the manifest's pin, not this script, still decides: a mirror whose bytes are not the
// pinned bytes is refused here, and a wrong cached file would be refused there.
//
// Why: https://purl.org/nemo/gufo serves whatever nemo-ufes/gufo last committed. Its commit fa89632
// (2026-10-26) changed the bytes again, so every fresh fetch refused the pin; the Foxxi image build
// has no cache, so it failed and held back every deploy. The pinned bytes are docs/gufo.ttl at the
// publisher's commit fc7b2a6. When the manifest re-pins gUFO, update the commit below with it.
//
// Usage: node tools/seed-pinned-upper.mjs <i2idlx root>
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIRRORS = {
  gufo: {
    url: 'https://purl.org/nemo/gufo',
    mirror: 'https://raw.githubusercontent.com/nemo-ufes/gufo/fc7b2a6531cd7339ced42dde48b6354b72bb1fd4/docs/gufo.ttl',
  },
};

const root = resolve(process.argv[2] ?? '.');
const manifest = JSON.parse(readFileSync(join(root, 'evidence', 'upper', 'manifest.json'), 'utf8'));
const cache = join(root, '.cache', 'upper');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function download(url) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(url + ' returned HTTP ' + response.status);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      last = error;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw last;
}

for (const [key, { url, mirror }] of Object.entries(MIRRORS)) {
  const pin = manifest.sources.find((source) => source.key === key);
  if (!pin) throw new Error(key + ': the manifest no longer pins this source; remove its mirror');
  if (pin.url !== url) throw new Error(key + ': the manifest pins ' + pin.url + ', not ' + url + '; update the mirror with it');
  const target = join(cache, key + '.source');
  if (existsSync(target) && sha256(readFileSync(target)) === pin.sha256) {
    console.log(key + ': cached source already matches the pin');
    continue;
  }
  const bytes = await download(mirror);
  const actual = sha256(bytes);
  if (actual !== pin.sha256) throw new Error(key + ': ' + mirror + ' has SHA-256 ' + actual + ', the manifest pins ' + pin.sha256 + '; update the mirror commit with the pin');
  mkdirSync(cache, { recursive: true });
  writeFileSync(target + '.download', bytes);
  renameSync(target + '.download', target);
  console.log(key + ': seeded ' + bytes.length + ' bytes from ' + mirror);
}
