/**
 * Foundation-first Stage 5 — opt-in PGSL-primary publish.
 *
 * Proves that publish({ pgslNode }) DERIVES the descriptor + manifest entry
 * from the PGSL projection engine (projectHolon) instead of toTurtle():
 *
 *   1. The PUT manifest body parseManifest()s back with the entry's pgslUri
 *      set and describes === [node.uri] (the projection's graphUri), with the
 *      contentCid mirror (CAVEAT B) present.
 *   2. projectHolon is deterministic — same (node, descriptorBase) → byte-
 *      identical descriptorTurtle (the property the foundation-first inversion
 *      relies on).
 *   3. The alignment invariant (CAVEAT C) throws when descriptor.describes[0]
 *      disagrees with node.uri.
 *
 * Tests MAY import @interego/pgsl directly (the boundary invariant only
 * forbids a STATIC import inside packages/solid/src — the publish path uses
 * the `Function('s','return import(s)')` dynamic-import escape hatch).
 *
 * NOTE on the subprocess: the prescribed escape hatch runs an INDIRECT
 * dynamic import (constructed via `Function`), which Vite/Vitest's module
 * transform cannot intercept ("A dynamic import callback was not specified").
 * The production runtime is Node, where the hatch works (it is the same
 * mechanism the existing post-write PGSL ingestion uses). So the
 * publish-with-pgslNode assertions run in a real Node child process against
 * the built `dist`, exactly as production loads it. The pure projectHolon
 * determinism + the alignment-invariant check (which throws BEFORE the
 * dynamic import) run in-process under Vitest.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ContextDescriptor } from '@interego/core';
import { createPGSL, mintAtom, projectHolon } from '@interego/pgsl';
import { publish } from '@interego/solid';

import type { IRI, NodeProvenance } from '@interego/core';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROVENANCE: NodeProvenance = {
  wasAttributedTo: 'did:web:alice.example' as IRI,
  generatedAtTime: '2026-01-01T00:00:00.000Z',
};
const DESCRIPTOR_BASE = 'https://alice.pod/context-graphs/';

function buildLatticeNode(value: string) {
  const pgsl = createPGSL(PROVENANCE);
  const uri = mintAtom(pgsl, value);
  const node = pgsl.nodes.get(uri)!;
  return { pgsl, node, uri };
}

// ── In-Node child-process driver for the dynamic-import publish path ──
//
// Runs the built dist (`@interego/solid` → dist/index.js) the way production
// does, with a mock fetch, and emits a JSON line of the assertions.
const DRIVER = String.raw`
import { ContextDescriptor } from '@interego/core';
import { createPGSL, mintAtom } from '@interego/pgsl';
import { publish, parseManifest } from '@interego/solid';

const PROV = { wasAttributedTo: 'did:web:alice.example', generatedAtTime: '2026-01-01T00:00:00.000Z' };
const BASE = 'https://alice.pod/context-graphs/';
const pgsl = createPGSL(PROV);
const uri = mintAtom(pgsl, 'foundation-first stage 5 holon payload');
const node = pgsl.nodes.get(uri);

let manifestBody = '';
const fetch = async (url, init) => {
  const u = String(url); const m = (init?.method ?? 'GET').toUpperCase();
  const ok = (s, b = '') => ({ ok: s >= 200 && s < 300, status: s, statusText: 'OK', text: async () => b, json: async () => (b ? JSON.parse(b) : {}), headers: new Headers() });
  const nf = () => ({ ok: false, status: 404, statusText: 'NF', text: async () => '', json: async () => ({}), headers: new Headers() });
  if (u.includes('.well-known/context-graphs')) {
    if (m === 'GET') return manifestBody ? ok(200, manifestBody) : nf();
    if (m === 'PUT') { manifestBody = init.body; return ok(201); }
  }
  if (m === 'GET') return nf();
  return ok(201);
};

const descriptorPuts = [];
const recordingFetch = async (url, init) => {
  const u = String(url);
  if ((init?.method ?? 'GET').toUpperCase() === 'PUT' && u.endsWith('.ttl') && !u.includes('.well-known')) {
    descriptorPuts.push(init.body);
  }
  return fetch(url, init);
};

const desc = ContextDescriptor.create('urn:iep:proj-publish-test')
  .describes(uri).temporal({ validFrom: '2026-01-01T00:00:00Z' })
  .selfAsserted('did:web:alice.example').build();

const result = await publish(desc, '<urn:s> <urn:p> <urn:o>.', 'https://alice.pod/', {
  fetch: recordingFetch,
  pgslNode: { node, pgsl, descriptorBase: BASE },
});

const entries = parseManifest(manifestBody);
const e = entries[0] || {};
const descPut = descriptorPuts.find(b => b.includes('iep:ContextDescriptor')) || '';
console.log('__RESULT__' + JSON.stringify({
  nodeUri: uri,
  resultDescriptorUrl: result.descriptorUrl,
  entriesLen: entries.length,
  pgslUri: e.pgslUri,
  describes: e.describes,
  cid: e.cid,
  entryDescriptorUrl: e.descriptorUrl,
  descPutHasPgslUri: descPut.includes('iep:pgslUri <' + uri + '>'),
  descPutHasDescribes: descPut.includes('iep:describes <' + uri + '>'),
}));
`;

function runDriver(): {
  nodeUri: string;
  resultDescriptorUrl: string;
  entriesLen: number;
  pgslUri: string;
  describes: string[];
  cid: string;
  entryDescriptorUrl: string;
  descPutHasPgslUri: boolean;
  descPutHasDescribes: boolean;
} {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', DRIVER],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const line = out.split('\n').find(l => l.startsWith('__RESULT__'))!;
  return JSON.parse(line.slice('__RESULT__'.length));
}

describe('publish — opt-in PGSL-primary (Foundation-first Stage 5)', () => {
  it('derives the descriptor + manifest entry from projectHolon (real-Node dynamic-import path)', () => {
    const r = runDriver();
    expect(r.entriesLen).toBe(1);
    // Manifest entry is a render of the holon: lattice pointer + content-
    // addressed graph URI (node.uri), with the contentCid mirror (CAVEAT B).
    expect(r.pgslUri).toBe(r.nodeUri);
    expect(r.describes).toEqual([r.nodeUri]);
    expect(r.cid).toMatch(/^bafkrei/);
    // The descriptor body actually written carries the projection markers
    // (iep:pgslUri + iep:describes <node.uri>) — i.e. it is the projectHolon
    // render, not the legacy toTurtle output.
    expect(r.descPutHasPgslUri).toBe(true);
    expect(r.descPutHasDescribes).toBe(true);
    // The on-pod descriptor resource, the manifest entry, and the returned
    // descriptorUrl all reference the SAME content-addressed IRI.
    expect(r.entryDescriptorUrl).toBe(r.resultDescriptorUrl);
  });

  it('projectHolon is deterministic — same (node, descriptorBase) → byte-identical descriptorTurtle', () => {
    const { pgsl, node } = buildLatticeNode('determinism payload');
    const a = projectHolon(node, pgsl, { descriptorBase: DESCRIPTOR_BASE, typedFacets: true });
    const b = projectHolon(node, pgsl, { descriptorBase: DESCRIPTOR_BASE, typedFacets: true });
    expect(a.descriptorTurtle).toBe(b.descriptorTurtle);
    expect(a.descriptorUrl).toBe(b.descriptorUrl);
    expect(a.manifestEntry).toEqual(b.manifestEntry);
  });

  it('throws the alignment invariant (CAVEAT C) when descriptor.describes[0] !== node.uri', async () => {
    const { pgsl, node } = buildLatticeNode('alignment payload');
    // The invariant is asserted at the top of the PGSL branch, BEFORE the
    // dynamic import — so it throws synchronously under Vitest without
    // hitting the Function-constructed import.
    const mismatched = ContextDescriptor.create('urn:iep:mismatch' as IRI)
      .describes('urn:graph:not-the-node' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .selfAsserted('did:web:alice.example' as IRI)
      .build();

    const noopFetch = (async () => ({
      ok: false, status: 404, statusText: 'NF',
      text: async () => '', json: async () => ({}), headers: new Headers(),
    })) as unknown as typeof globalThis.fetch;

    await expect(
      publish(mismatched, '', 'https://alice.pod/', {
        fetch: noopFetch,
        pgslNode: { node, pgsl, descriptorBase: DESCRIPTOR_BASE },
      }),
    ).rejects.toThrow(/alignment violation/);
  });
});
