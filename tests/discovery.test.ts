/**
 * Tests for PGSL Discovery module
 *
 * Covers:
 *   - Introspection Agents (JSON, CSV, RDF, API, apply)
 *   - Zero-Copy Virtual Layer (references, cache, eviction)
 *   - Homoiconic Metagraph (generate, ingest, validate, query)
 *   - Marketplace Discovery (registry, capability search, Hydra, stats)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPGSL,
  ingest,
  latticeStats,
} from '@interego/pgsl';
import type {
  PGSLInstance,
} from '@interego/pgsl';
import type {
  DataSource,
  MarketplaceListing,
} from '@interego/pgsl';
import {
  applyIntrospection,
  createMarketplace,
  createVirtualLayer,
  discoverByCapability,
  discoverByType,
  generateMetagraph,
  ingestMetagraph,
  introspectApi,
  introspectCsv,
  introspectJson,
  introspectRdf,
  invalidateCache,
  marketplaceStats,
  marketplaceToHydra,
  queryMetagraph,
  refreshListing,
  registerListing,
  registerReference,
  removeListing,
  resolveReference,
  validateMetagraph,
  virtualLayerStats,
} from '@interego/pgsl';

// ── Shared fixtures ──────────────────────────────────────────

const provenance = {
  wasAttributedTo: 'test-agent',
  generatedAtTime: new Date().toISOString(),
};

function jsonSource(): DataSource {
  return {
    id: 'src-json-1',
    type: 'json',
    endpoint: 'https://example.com/api/users',
    name: 'Users',
  };
}

function csvSource(): DataSource {
  return {
    id: 'src-csv-1',
    type: 'csv',
    endpoint: 'https://example.com/data/scores.csv',
    name: 'Scores',
  };
}

function rdfSource(): DataSource {
  return {
    id: 'src-rdf-1',
    type: 'rdf',
    endpoint: 'https://example.com/graph',
    name: 'OrgGraph',
  };
}

function apiSource(): DataSource {
  return {
    id: 'src-api-1',
    type: 'api',
    endpoint: 'https://example.com/openapi.json',
    name: 'PetStore',
  };
}

const sampleJson = {
  name: 'Sarah Chen',
  age: 28,
  active: true,
  scores: [92, 88, 95],
  department: {
    name: 'Engineering',
    building: 'B2',
  },
};

const csvHeaders = ['name', 'age', 'score'];
const csvRows = [
  ['Sarah', '28', '92'],
  ['James', '30', '85'],
];

function makeListing(
  overrides: Partial<MarketplaceListing> & { id: string; name: string },
): MarketplaceListing {
  return {
    type: 'agent',
    description: 'A test listing',
    provider: 'test-provider',
    capabilities: ['search'],
    trustLevel: 'self-asserted',
    registeredAt: new Date().toISOString(),
    operations: [],
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════
//  §1 — Introspection Agents
// ═════════════════════════════════════════════════════════════

describe('Introspection Agents', () => {
  describe('introspectJson', () => {
    it('discovers entities from top-level object keys', () => {
      const result = introspectJson(jsonSource(), sampleJson);
      const entityNames = result.schema.entities.map(e => e.name);
      expect(entityNames).toContain('Users');
    });

    it('discovers field types: string, number, boolean', () => {
      const result = introspectJson(jsonSource(), sampleJson);
      const usersEntity = result.schema.entities.find(e => e.name === 'Users');
      expect(usersEntity).toBeDefined();

      const nameField = usersEntity!.fields.find(f => f.name === 'name');
      const ageField = usersEntity!.fields.find(f => f.name === 'age');
      const activeField = usersEntity!.fields.find(f => f.name === 'active');

      expect(nameField?.type).toBe('string');
      expect(ageField?.type).toBe('number');
      expect(activeField?.type).toBe('boolean');
    });

    it('discovers array fields via has-many relationship', () => {
      const result = introspectJson(jsonSource(), sampleJson);
      const hasMany = result.schema.relationships.find(
        r => r.from === 'Users' && r.to === 'scores' && r.type === 'has-many',
      );
      expect(hasMany).toBeDefined();
    });

    it('discovers nested object relationships (has-one)', () => {
      const result = introspectJson(jsonSource(), sampleJson);
      const hasOne = result.schema.relationships.find(
        r => r.from === 'Users' && r.to === 'department' && r.type === 'has-one',
      );
      expect(hasOne).toBeDefined();
    });

    it('generates PGSL chains for entity fields', () => {
      const result = introspectJson(jsonSource(), sampleJson);
      expect(result.chains).toContain('(Users, has-field, name)');
      expect(result.chains).toContain('(name, type, string)');
      expect(result.chains).toContain('(age, type, number)');
    });

    it('generates SHACL shapes with correct datatypes', () => {
      const result = introspectJson(jsonSource(), sampleJson);
      expect(result.shapes.length).toBeGreaterThan(0);
      const usersShape = result.shapes.find(s => s.includes('iep:UsersShape'));
      expect(usersShape).toBeDefined();
      expect(usersShape).toContain('sh:NodeShape');
      expect(usersShape).toContain('sh:datatype');
    });

    it('generates suggested constraints for required fields', () => {
      const result = introspectJson(jsonSource(), sampleJson);
      // All non-null fields in the sample are required
      expect(result.suggestedConstraints.length).toBeGreaterThanOrEqual(0);
    });

    it('sets sourceId and scannedAt on the result', () => {
      const result = introspectJson(jsonSource(), sampleJson);
      expect(result.sourceId).toBe('src-json-1');
      expect(result.scannedAt).toBeTruthy();
    });

    it('generates a suggested ingestion profile', () => {
      const result = introspectJson(jsonSource(), sampleJson);
      expect(result.suggestedProfile).toBe('profile:Users-ingestion');
    });
  });

  describe('introspectCsv', () => {
    it('discovers columns as entity fields', () => {
      const result = introspectCsv(csvSource(), csvHeaders, csvRows);
      const entity = result.schema.entities[0]!;
      const fieldNames = entity.fields.map(f => f.name);
      expect(fieldNames).toEqual(['name', 'age', 'score']);
    });

    it('infers numeric types from sample data', () => {
      const result = introspectCsv(csvSource(), csvHeaders, csvRows);
      const entity = result.schema.entities[0]!;
      const ageField = entity.fields.find(f => f.name === 'age');
      const scoreField = entity.fields.find(f => f.name === 'score');
      expect(ageField?.type).toBe('number');
      expect(scoreField?.type).toBe('number');
    });

    it('infers string type for non-numeric columns', () => {
      const result = introspectCsv(csvSource(), csvHeaders, csvRows);
      const entity = result.schema.entities[0]!;
      const nameField = entity.fields.find(f => f.name === 'name');
      expect(nameField?.type).toBe('string');
    });

    it('generates PGSL chains for column types', () => {
      const result = introspectCsv(csvSource(), csvHeaders, csvRows);
      expect(result.chains).toContain('(Scores, has-field, name)');
      expect(result.chains).toContain('(age, type, number)');
    });
  });

  describe('introspectRdf', () => {
    const turtle = [
      '<http://ex.org/Person> a <http://www.w3.org/2002/07/owl#Class> .',
      '<http://ex.org/name> rdfs:domain <http://ex.org/Person> .',
      '<http://ex.org/name> rdfs:range <http://www.w3.org/2001/XMLSchema#string> .',
      '<http://ex.org/alice> a <http://ex.org/Person> .',
      '<http://ex.org/alice> <http://ex.org/name> "Alice" .',
    ].join('\n');

    it('extracts classes from rdf:type declarations', () => {
      const result = introspectRdf(rdfSource(), turtle);
      const entityNames = result.schema.entities.map(e => e.name);
      expect(entityNames).toContain('Person');
    });

    it('extracts properties with domain info', () => {
      const result = introspectRdf(rdfSource(), turtle);
      const person = result.schema.entities.find(e => e.name === 'Person');
      expect(person).toBeDefined();
      const nameField = person!.fields.find(f => f.name === 'name');
      expect(nameField).toBeDefined();
    });

    it('generates PGSL chains from discovered RDF schema', () => {
      const result = introspectRdf(rdfSource(), turtle);
      expect(result.chains.length).toBeGreaterThan(0);
      expect(result.chains.some(c => c.includes('has-field'))).toBe(true);
    });
  });

  describe('introspectApi', () => {
    const openApiSpec = {
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Pet' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Pet: {
            properties: {
              id: { type: 'integer' },
              name: { type: 'string' },
              tag: { type: 'string' },
            },
            required: ['id', 'name'],
          },
        },
      },
    };

    it('extracts endpoints from OpenAPI paths', () => {
      const result = introspectApi(apiSource(), openApiSpec);
      expect(result.chains.some(c => c.includes('/pets'))).toBe(true);
      expect(result.chains.some(c => c.includes('endpoint'))).toBe(true);
    });

    it('discovers component schema fields and types', () => {
      const result = introspectApi(apiSource(), openApiSpec);
      const petEntity = result.schema.entities.find(e => e.name === 'Pet');
      expect(petEntity).toBeDefined();
      expect(petEntity!.fields.find(f => f.name === 'id')?.type).toBe('integer');
      expect(petEntity!.fields.find(f => f.name === 'name')?.required).toBe(true);
    });

    it('discovers response schema references as chains', () => {
      const result = introspectApi(apiSource(), openApiSpec);
      expect(result.chains.some(c => c.includes('listPets') && c.includes('returns'))).toBe(true);
    });
  });

  describe('applyIntrospection', () => {
    let pgsl: PGSLInstance;

    beforeEach(() => {
      pgsl = createPGSL(provenance);
    });

    it('ingests discovered chains into the PGSL lattice', () => {
      const result = introspectJson(jsonSource(), sampleJson);
      const beforeStats = latticeStats(pgsl);
      applyIntrospection(pgsl, result);
      const afterStats = latticeStats(pgsl);
      expect(afterStats.totalNodes).toBeGreaterThan(beforeStats.totalNodes);
    });

    it('creates atoms for entity and field names', () => {
      const result = introspectCsv(csvSource(), csvHeaders, csvRows);
      applyIntrospection(pgsl, result);
      // The atom map should now contain keys for field names
      expect(pgsl.atoms.has('name')).toBe(true);
      expect(pgsl.atoms.has('age')).toBe(true);
    });

    it('creates fragments for chain relationships', () => {
      const result = introspectCsv(csvSource(), csvHeaders, csvRows);
      applyIntrospection(pgsl, result);
      const stats = latticeStats(pgsl);
      expect(stats.fragments).toBeGreaterThan(0);
    });
  });
});

// ═════════════════════════════════════════════════════════════
//  §2 — Zero-Copy Virtual Layer
// ═════════════════════════════════════════════════════════════

describe('Zero-Copy Virtual Layer', () => {
  it('createVirtualLayer has default config', () => {
    const layer = createVirtualLayer();
    expect(layer.config.maxCacheSize).toBe(1024 * 1024);
    expect(layer.config.cacheEvictionPolicy).toBe('lru');
    expect(layer.config.lazyLoadThreshold).toBe(1024);
    expect(layer.references.size).toBe(0);
    expect(layer.cache.size).toBe(0);
  });

  it('registerReference adds a lazy reference without loading data', () => {
    let layer = createVirtualLayer();
    layer = registerReference(layer, 'src-1', '/data/file.json', 500);
    expect(layer.references.size).toBe(1);
    expect(layer.cache.size).toBe(0);

    const ref = [...layer.references.values()][0]!;
    expect(ref.sourceId).toBe('src-1');
    expect(ref.path).toBe('/data/file.json');
    expect(ref.cached).toBe(false);
  });

  it('resolveReference loads data on first access (cache miss)', async () => {
    let layer = createVirtualLayer();
    layer = registerReference(layer, 'src-1', '/data/file.json');
    const refId = [...layer.references.keys()][0]!;

    const loader = async (_path: string) => ({ hello: 'world' });
    const result = await resolveReference(layer, refId, loader);

    expect(result.data).toEqual({ hello: 'world' });
    expect(result.layer.stats.misses).toBe(1);
    expect(result.layer.stats.hits).toBe(0);
    expect(result.layer.cache.size).toBe(1);
  });

  it('resolveReference uses cache on second access (cache hit)', async () => {
    let layer = createVirtualLayer();
    layer = registerReference(layer, 'src-1', '/data/file.json');
    const refId = [...layer.references.keys()][0]!;

    let loadCount = 0;
    const loader = async (_path: string) => {
      loadCount++;
      return { hello: 'world' };
    };

    const first = await resolveReference(layer, refId, loader);
    const second = await resolveReference(first.layer, refId, loader);

    expect(loadCount).toBe(1); // loader only called once
    expect(second.layer.stats.hits).toBe(1);
    expect(second.layer.stats.misses).toBe(1);
    expect(second.data).toEqual({ hello: 'world' });
  });

  it('invalidateCache forces reload on next access', async () => {
    let layer = createVirtualLayer();
    layer = registerReference(layer, 'src-1', '/data/file.json');
    const refId = [...layer.references.keys()][0]!;

    let loadCount = 0;
    const loader = async (_path: string) => {
      loadCount++;
      return { version: loadCount };
    };

    const first = await resolveReference(layer, refId, loader);
    const invalidated = invalidateCache(first.layer, refId);
    expect(invalidated.cache.size).toBe(0);

    const second = await resolveReference(invalidated, refId, loader);
    expect(loadCount).toBe(2);
    expect(second.data).toEqual({ version: 2 });
  });

  it('stats track hits and misses correctly', async () => {
    let layer = createVirtualLayer();
    layer = registerReference(layer, 'src-1', '/a.json');
    layer = registerReference(layer, 'src-2', '/b.json');
    const [refA, refB] = [...layer.references.keys()];

    const loader = async (_path: string) => ({ data: true });

    const r1 = await resolveReference(layer, refA!, loader);
    const r2 = await resolveReference(r1.layer, refB!, loader);
    const r3 = await resolveReference(r2.layer, refA!, loader); // hit

    const stats = virtualLayerStats(r3.layer);
    expect(stats.misses).toBe(2);
    expect(stats.hits).toBe(1);
    expect(stats.hitRate).toBeCloseTo(1 / 3);
    expect(stats.referenceCount).toBe(2);
    expect(stats.cachedCount).toBe(2);
  });

  it('cache eviction when over maxCacheSize', async () => {
    // Tiny cache: 50 bytes max
    let layer = createVirtualLayer({ maxCacheSize: 50 });
    layer = registerReference(layer, 's1', '/a.json');
    layer = registerReference(layer, 's2', '/b.json');
    const [refA, refB] = [...layer.references.keys()];

    // Each object serializes to more than 25 bytes
    const loader = async (path: string) => ({ path, payload: 'x'.repeat(20) });

    const r1 = await resolveReference(layer, refA!, loader);
    // First entry is cached
    expect(r1.layer.cache.size).toBe(1);

    const r2 = await resolveReference(r1.layer, refB!, loader);
    // The first entry should have been evicted to make room
    expect(r2.layer.cache.has(refA!)).toBe(false);
    expect(r2.layer.cache.has(refB!)).toBe(true);
  });

  it('throws on unknown reference id', async () => {
    const layer = createVirtualLayer();
    const loader = async () => null;
    await expect(resolveReference(layer, 'nonexistent', loader)).rejects.toThrow(
      'Virtual reference not found',
    );
  });
});

// ═════════════════════════════════════════════════════════════
//  §3 — Homoiconic Metagraph
// ═════════════════════════════════════════════════════════════

describe('Homoiconic Metagraph', () => {
  let pgsl: PGSLInstance;

  beforeEach(() => {
    pgsl = createPGSL(provenance);
    ingest(pgsl, ['the', 'cat', 'sat']);
    ingest(pgsl, ['cat', 'sat', 'down']);
  });

  it('generateMetagraph produces correct atom and fragment counts', () => {
    const stats = latticeStats(pgsl);
    const meta = generateMetagraph(pgsl);
    expect(meta.atomCount).toBe(stats.atoms);
    expect(meta.fragmentCount).toBe(stats.fragments);
  });

  it('generateMetagraph captures the max level', () => {
    const stats = latticeStats(pgsl);
    const meta = generateMetagraph(pgsl);
    expect(meta.maxLevel).toBe(stats.maxLevel);
  });

  it('generateMetagraph produces a lattice URI', () => {
    const meta = generateMetagraph(pgsl);
    expect(meta.latticeUri).toContain('/ns/pgsl/metagraph/');
  });

  it('ingestMetagraph adds meta-atoms to the lattice', () => {
    const beforeStats = latticeStats(pgsl);
    const meta = generateMetagraph(pgsl);
    ingestMetagraph(pgsl, meta);
    const afterStats = latticeStats(pgsl);
    expect(afterStats.totalNodes).toBeGreaterThan(beforeStats.totalNodes);
  });

  it('lattice grows after metagraph ingestion', () => {
    const meta = generateMetagraph(pgsl);
    ingestMetagraph(pgsl, meta);
    // 'lattice-root' and 'atom-count' should now be atoms
    expect(pgsl.atoms.has('lattice-root')).toBe(true);
    expect(pgsl.atoms.has('atom-count')).toBe(true);
    expect(pgsl.atoms.has('fragment-count')).toBe(true);
  });

  it('validateMetagraph detects no discrepancies on fresh metagraph', () => {
    const meta = generateMetagraph(pgsl);
    const discrepancies = validateMetagraph(pgsl, meta);
    expect(discrepancies).toEqual([]);
  });

  it('validateMetagraph detects discrepancies after lattice modification', () => {
    const meta = generateMetagraph(pgsl);
    // Modify the lattice after taking the snapshot
    ingest(pgsl, ['new', 'data', 'here']);
    const discrepancies = validateMetagraph(pgsl, meta);
    expect(discrepancies.length).toBeGreaterThan(0);
    expect(discrepancies.some(d => d.includes('mismatch'))).toBe(true);
  });

  it('queryMetagraph answers "how many atoms?"', () => {
    const meta = generateMetagraph(pgsl);
    ingestMetagraph(pgsl, meta);
    const answer = queryMetagraph(pgsl, 'how many atoms?');
    expect(answer).toBe(String(meta.atomCount));
  });

  it('queryMetagraph answers "what is the max level?"', () => {
    const meta = generateMetagraph(pgsl);
    ingestMetagraph(pgsl, meta);
    const answer = queryMetagraph(pgsl, 'what is the max level?');
    expect(answer).toBe(String(meta.maxLevel));
  });
});

// ═════════════════════════════════════════════════════════════
//  §4 — Marketplace Discovery
// ═════════════════════════════════════════════════════════════

describe('Marketplace Discovery', () => {
  const agentListing = makeListing({
    id: 'urn:iep:agent:search-1',
    name: 'SearchAgent',
    type: 'agent',
    capabilities: ['search', 'summarize'],
    trustLevel: 'community-verified',
  });

  const dataSourceListing = makeListing({
    id: 'urn:iep:ds:wiki',
    name: 'WikiSource',
    type: 'data-source',
    capabilities: ['read', 'search'],
    trustLevel: 'self-asserted',
  });

  const decoratorListing = makeListing({
    id: 'urn:iep:dec:highlight',
    name: 'Highlighter',
    type: 'decorator',
    capabilities: ['highlight', 'annotate'],
    trustLevel: 'certified',
    operations: [
      {
        method: 'POST',
        href: '/highlight',
        title: 'Highlight text',
        expects: 'iep:TextInput',
        returns: 'iep:HighlightedOutput',
      },
    ],
  });

  describe('registry', () => {
    it('createMarketplace starts empty', () => {
      const mp = createMarketplace();
      expect(mp.listings.size).toBe(0);
    });

    it('registerListing adds a listing', () => {
      let mp = createMarketplace();
      mp = registerListing(mp, agentListing);
      expect(mp.listings.size).toBe(1);
      expect(mp.listings.get(agentListing.id)).toEqual(agentListing);
    });

    it('removeListing removes a listing', () => {
      let mp = createMarketplace();
      mp = registerListing(mp, agentListing);
      mp = removeListing(mp, agentListing.id);
      expect(mp.listings.size).toBe(0);
    });

    it('refreshListing updates lastSeen timestamp', () => {
      let mp = createMarketplace();
      mp = registerListing(mp, agentListing);
      expect(mp.listings.get(agentListing.id)!.lastSeen).toBeUndefined();

      mp = refreshListing(mp, agentListing.id);
      const refreshed = mp.listings.get(agentListing.id)!;
      expect(refreshed.lastSeen).toBeTruthy();
    });
  });

  describe('discovery', () => {
    let mp: ReturnType<typeof createMarketplace>;

    beforeEach(() => {
      mp = createMarketplace();
      mp = registerListing(mp, agentListing);
      mp = registerListing(mp, dataSourceListing);
      mp = registerListing(mp, decoratorListing);
    });

    it('discoverByCapability finds matching listings', () => {
      const results = discoverByCapability(mp, ['search']);
      expect(results.length).toBe(2); // agent + data-source both have 'search'
    });

    it('discoverByCapability requires ALL capabilities (AND logic)', () => {
      const results = discoverByCapability(mp, ['search', 'summarize']);
      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe(agentListing.id);
    });

    it('discoverByCapability returns empty for no match', () => {
      const results = discoverByCapability(mp, ['teleport']);
      expect(results).toEqual([]);
    });

    it('discoverByType filters by type', () => {
      const agents = discoverByType(mp, 'agent');
      expect(agents.length).toBe(1);
      expect(agents[0]!.name).toBe('SearchAgent');

      const decorators = discoverByType(mp, 'decorator');
      expect(decorators.length).toBe(1);
      expect(decorators[0]!.name).toBe('Highlighter');
    });
  });

  describe('Hydra', () => {
    it('marketplaceToHydra returns valid Turtle with ApiDocumentation', () => {
      let mp = createMarketplace();
      mp = registerListing(mp, agentListing);
      mp = registerListing(mp, decoratorListing);

      const turtle = marketplaceToHydra(mp);
      expect(turtle).toContain('hydra:ApiDocumentation');
      expect(turtle).toContain('@prefix hydra:');
      expect(turtle).toContain('hydra:title');
    });

    it('contains listing details and operations in Turtle output', () => {
      let mp = createMarketplace();
      mp = registerListing(mp, decoratorListing);

      const turtle = marketplaceToHydra(mp);
      expect(turtle).toContain('Highlighter');
      expect(turtle).toContain('hydra:operation');
      expect(turtle).toContain('hydra:method "POST"');
    });
  });

  describe('stats', () => {
    it('counts by type and trust level', () => {
      let mp = createMarketplace();
      mp = registerListing(mp, agentListing);
      mp = registerListing(mp, dataSourceListing);
      mp = registerListing(mp, decoratorListing);

      const stats = marketplaceStats(mp);
      expect(stats.total).toBe(3);
      expect(stats.byType['agent']).toBe(1);
      expect(stats.byType['data-source']).toBe(1);
      expect(stats.byType['decorator']).toBe(1);
      expect(stats.byTrustLevel['self-asserted']).toBe(1);
      expect(stats.byTrustLevel['community-verified']).toBe(1);
      expect(stats.byTrustLevel['certified']).toBe(1);
    });
  });
});
