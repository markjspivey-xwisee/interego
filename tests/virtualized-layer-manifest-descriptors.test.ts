/**
 * `descriptorsFromManifestEntries` — the projection that was missing between
 * `discover()`'s `ManifestEntry[]` and `SystemState.descriptors`.
 *
 * With no bridge the pgsl-browser hardcoded `descriptors: []` and its virtualized graph
 * contradicted itself: /api/pods reported totalDescriptors 1 for a pod while
 * `?d a iep:ContextDescriptor` returned 0 bindings over /sparql, and /dump.ttl emitted
 * `iep:descriptorCount 1` while naming no descriptor subject at all — 200 OK on every one
 * of them, so nothing anywhere signalled a failure.
 */
import { describe, expect, it } from 'vitest';
import type { IRI, ManifestEntry } from '@interego/core';
import {
  createPGSL,
  descriptorsFromManifestEntries,
  materializeSystem,
  systemToTurtle,
} from '@interego/pgsl';
import type { SystemState } from '@interego/pgsl';

const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const POD = 'https://pod.example/alice/' as IRI;

const RICH: ManifestEntry = {
  descriptorUrl: 'https://pod.example/alice/context-graphs/obs-2026.ttl',
  describes: ['https://pod.example/alice/graphs/obs-2026'],
  facetTypes: ['Temporal', 'Semiotic', 'Trust'],
  validFrom: '2026-01-01T00:00:00Z',
  validUntil: '2027-01-01T00:00:00Z',
  modalStatus: 'Asserted',
  trustLevel: 'SelfAsserted',
  issuer: 'https://pod.example/alice/profile/card#me',
};

// A row naming no graph. ContextDescriptor.build() throws on one of these, so this fixture
// is the difference between "skip the row" and "the whole RDF layer 500s" — four endpoints
// at once, since /dump.ttl, /dump.jsonld and both /sparql methods all route through
// materializeSystem over the same array.
const SPARSE: ManifestEntry = {
  descriptorUrl: 'https://pod.example/alice/context-graphs/sparse.ttl',
  describes: [],
  facetTypes: [],
};

function stateFor(entries: readonly ManifestEntry[]): SystemState {
  return {
    pgsl: createPGSL({ wasAttributedTo: 'urn:test' as IRI, generatedAtTime: '2026-01-01T00:00:00Z' }),
    descriptors: descriptorsFromManifestEntries(POD, entries),
    certificates: [],
    constraints: [],
    pods: [{ url: POD, name: 'alice', status: 'active', descriptorCount: entries.length }],
  };
}

function descriptorSubjects(state: SystemState): string[] {
  const store = materializeSystem(state);
  return [...new Set(store.triples
    .filter(t => t.predicate === RDF_TYPE && t.object === `${IEP}ContextDescriptor`)
    .map(t => t.subject))];
}

describe('descriptorsFromManifestEntries', () => {
  it('names every describable manifest row in the virtualized graph', () => {
    // THE DEFECT AS AN INVARIANT: with `descriptors: []` the browser published
    // `iep:descriptorCount 1` for a pod and named no descriptor at all.
    expect(descriptorSubjects(stateFor([RICH]))).toEqual([RICH.descriptorUrl]);
  });

  it('carries the row through as facets and invents nothing', () => {
    const [d] = descriptorsFromManifestEntries(POD, [RICH]);
    expect(d?.id).toBe(RICH.descriptorUrl); // must dereference to the resource it names
    expect(d?.describes).toEqual(RICH.describes);
    const byType = Object.fromEntries((d?.facets ?? []).map(f => [f.type, f] as const));
    expect(byType['Temporal']).toMatchObject({ validFrom: RICH.validFrom, validUntil: RICH.validUntil });
    expect(byType['Semiotic']).toMatchObject({ modalStatus: 'Asserted' });
    expect(byType['Trust']).toMatchObject({ trustLevel: 'SelfAsserted', issuer: RICH.issuer });
    expect(byType['Federation']).toMatchObject({ origin: POD });
    // A fabricated value is indistinguishable from an asserted one once it is a triple.
    expect(byType['Semiotic']).not.toHaveProperty('epistemicConfidence');
    expect(byType['Provenance']).toBeUndefined();
  });

  it('skips a row naming no graph instead of failing the whole layer', () => {
    expect(() => descriptorsFromManifestEntries(POD, [RICH, SPARSE])).not.toThrow();
    expect(descriptorSubjects(stateFor([RICH, SPARSE]))).toEqual([RICH.descriptorUrl]);
    expect(systemToTurtle(stateFor([RICH, SPARSE]))).not.toContain('sparse.ttl');
  });
});
