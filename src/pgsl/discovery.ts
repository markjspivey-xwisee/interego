/**
 * @module pgsl/discovery
 * @description Discovery infrastructure for PGSL: introspection, virtual references,
 * homoiconic metagraph, and marketplace.
 *
 * Four capabilities:
 *
 *   9.  Introspection Agents — auto-scan external data sources, generate PGSL
 *       structure, SHACL shapes, and ingestion profiles.
 *
 *   10. Zero-Copy Virtual Layer — lazy-load external data only when queried.
 *       Store references, not content. LRU/FIFO cache with eviction.
 *
 *   11. Homoiconic Metagraph — self-describing primitives where the PGSL lattice
 *       describes its own structure as atoms/chains within itself.
 *
 *   12. Marketplace Discovery — Hydra-driven registration where agents and data
 *       sources advertise capabilities and are discoverable by other agents.
 *
 * All functions are pure or return new state — no hidden side effects.
 */

import type { PGSLInstance } from './types.js';
import { ingest, latticeStats } from './lattice.js';
import { createHash } from 'node:crypto';

// ═════════════════════════════════════════════════════════════
//  §9 — Introspection Agents
// ═════════════════════════════════════════════════════════════

// ── Types ──────────────────────────────────────────────────

/** A data source that can be introspected. */
export interface DataSource {
  readonly id: string;
  readonly type: 'json' | 'csv' | 'rdf' | 'sql' | 'api' | 'filesystem';
  readonly endpoint: string;
  readonly name: string;
  readonly description?: string;
  readonly credentials?: string;
}

/** Result of introspecting a data source. */
export interface IntrospectionResult {
  readonly sourceId: string;
  readonly scannedAt: string;
  readonly schema: DiscoveredSchema;
  readonly chains: readonly string[];
  readonly shapes: readonly string[];
  readonly suggestedProfile?: string;
  readonly suggestedConstraints: readonly string[];
}

/** Discovered schema: entities, fields, relationships. */
export interface DiscoveredSchema {
  readonly entities: readonly DiscoveredEntity[];
  readonly relationships: readonly DiscoveredRelationship[];
}

/** A discovered entity (table, object type, class). */
export interface DiscoveredEntity {
  readonly name: string;
  readonly fields: readonly { name: string; type: string; required: boolean; sample?: string }[];
}

/** A discovered relationship between entities. */
export interface DiscoveredRelationship {
  readonly from: string;
  readonly to: string;
  readonly type: string;
}

/** An introspection agent that can scan sources. */
export interface IntrospectionAgent {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly pgsl: PGSLInstance;
  introspectJson(source: DataSource, sampleData: unknown): IntrospectionResult;
  introspectCsv(source: DataSource, headers: string[], sampleRows: string[][]): IntrospectionResult;
  introspectRdf(source: DataSource, turtle: string): IntrospectionResult;
  introspectApi(source: DataSource, openApiSpec: unknown): IntrospectionResult;
}

// ── Introspection Helpers ──────────────────────────────────

/** @internal Infer a type string from a JavaScript value. */
function inferType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** @internal Infer a type string from a CSV cell value. */
function inferCsvType(value: string): string {
  if (value === '') return 'string';
  if (!isNaN(Number(value)) && value.trim() !== '') return 'number';
  if (value === 'true' || value === 'false') return 'boolean';
  return 'string';
}

/** @internal Generate a deterministic agent ID from a hash. */
function agentId(pgsl: PGSLInstance): string {
  const hash = createHash('sha256')
    .update(`introspection-agent:${pgsl.defaultProvenance.wasAttributedTo}`)
    .digest('hex')
    .slice(0, 16);
  return `urn:cg:agent:introspect:${hash}`;
}

/** @internal Build PGSL chains from a discovered schema. */
function schemaToChains(schema: DiscoveredSchema): string[] {
  const chains: string[] = [];
  for (const entity of schema.entities) {
    for (const field of entity.fields) {
      chains.push(`(${entity.name}, has-field, ${field.name})`);
      chains.push(`(${field.name}, type, ${field.type})`);
      if (field.required) {
        chains.push(`(${field.name}, required, true)`);
      }
    }
  }
  for (const rel of schema.relationships) {
    chains.push(`(${rel.from}, ${rel.type}, ${rel.to})`);
  }
  return chains;
}

/** @internal Build SHACL shapes from a discovered schema. */
function schemaToShapes(schema: DiscoveredSchema): string[] {
  const shapes: string[] = [];
  for (const entity of schema.entities) {
    const lines: string[] = [
      `cg:${entity.name}Shape a sh:NodeShape ;`,
      `  sh:targetClass cg:${entity.name} ;`,
    ];
    for (const field of entity.fields) {
      const dt = field.type === 'number' ? 'xsd:decimal'
        : field.type === 'boolean' ? 'xsd:boolean'
        : 'xsd:string';
      lines.push(`  sh:property [`);
      lines.push(`    sh:path cg:${field.name} ;`);
      lines.push(`    sh:datatype ${dt} ;`);
      if (field.required) {
        lines.push(`    sh:minCount 1 ;`);
      }
      lines.push(`  ] ;`);
    }
    // Close the shape
    const last = lines[lines.length - 1]!;
    lines[lines.length - 1] = last.replace(/ ;$/, ' .');
    shapes.push(lines.join('\n'));
  }
  return shapes;
}

/** @internal Build suggested paradigm constraints from a schema. */
function schemaToConstraints(schema: DiscoveredSchema): string[] {
  const constraints: string[] = [];
  for (const entity of schema.entities) {
    const requiredFields = entity.fields.filter(f => f.required);
    if (requiredFields.length > 0) {
      constraints.push(
        `${entity.name} requires fields: ${requiredFields.map(f => f.name).join(', ')}`,
      );
    }
  }
  for (const rel of schema.relationships) {
    constraints.push(`${rel.from} must ${rel.type} ${rel.to}`);
  }
  return constraints;
}

// ── Introspection Functions ────────────────────────────────

/**
 * Introspect a JSON data source.
 *
 * Discovers entities (object keys), types (string/number/boolean/array/object),
 * and relationships (nested objects). Generates PGSL chains and SHACL shapes.
 */
export function introspectJson(source: DataSource, sampleData: unknown): IntrospectionResult {
  const entities: DiscoveredEntity[] = [];
  const relationships: DiscoveredRelationship[] = [];

  function walk(obj: unknown, parentName: string): void {
    if (obj === null || obj === undefined || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      // Array: introspect the first element as representative
      if (obj.length > 0 && typeof obj[0] === 'object' && obj[0] !== null) {
        walk(obj[0], parentName);
      }
      return;
    }

    const record = obj as Record<string, unknown>;
    const fields: { name: string; type: string; required: boolean; sample?: string }[] = [];

    for (const [key, value] of Object.entries(record)) {
      const type = inferType(value);
      if (type === 'object' && value !== null && !Array.isArray(value)) {
        // Nested object: this is a relationship
        relationships.push({ from: parentName, to: key, type: 'has-one' });
        walk(value, key);
      } else if (type === 'array' && Array.isArray(value)) {
        relationships.push({ from: parentName, to: key, type: 'has-many' });
        if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
          walk(value[0], key);
        } else {
          fields.push({ name: key, type: 'array', required: true, sample: JSON.stringify(value[0]) });
        }
      } else {
        fields.push({
          name: key,
          type,
          required: value !== null && value !== undefined,
          sample: value !== null && value !== undefined ? String(value) : undefined,
        });
      }
    }

    if (fields.length > 0) {
      entities.push({ name: parentName, fields });
    }
  }

  walk(sampleData, source.name);

  const schema: DiscoveredSchema = { entities, relationships };
  const chains = schemaToChains(schema);
  const shapes = schemaToShapes(schema);
  const suggestedConstraints = schemaToConstraints(schema);

  return {
    sourceId: source.id,
    scannedAt: new Date().toISOString(),
    schema,
    chains,
    shapes,
    suggestedProfile: `profile:${source.name}-ingestion`,
    suggestedConstraints,
  };
}

/**
 * Introspect a CSV data source.
 *
 * Each column becomes an entity field. Types are inferred from sample values.
 */
export function introspectCsv(
  source: DataSource,
  headers: string[],
  sampleRows: string[][],
): IntrospectionResult {
  const fields: { name: string; type: string; required: boolean; sample?: string }[] = [];

  for (let col = 0; col < headers.length; col++) {
    const header = headers[col]!;
    // Infer type from all sample values for this column
    const values = sampleRows.map(row => row[col] ?? '');
    const types = values.filter(v => v !== '').map(inferCsvType);
    const dominant = types.length > 0
      ? types.sort((a, b) =>
          types.filter(t => t === b).length - types.filter(t => t === a).length,
        )[0]!
      : 'string';
    const allPresent = values.every(v => v !== '');
    fields.push({
      name: header,
      type: dominant,
      required: allPresent,
      sample: values[0] || undefined,
    });
  }

  const entity: DiscoveredEntity = { name: source.name, fields };
  const schema: DiscoveredSchema = { entities: [entity], relationships: [] };
  const chains = schemaToChains(schema);
  const shapes = schemaToShapes(schema);
  const suggestedConstraints = schemaToConstraints(schema);

  return {
    sourceId: source.id,
    scannedAt: new Date().toISOString(),
    schema,
    chains,
    shapes,
    suggestedProfile: `profile:${source.name}-csv-ingestion`,
    suggestedConstraints,
  };
}

/**
 * Introspect an RDF/Turtle data source.
 *
 * Extracts classes, properties, domains, and ranges from Turtle syntax.
 * Maps to PGSL chains and SHACL shapes.
 */
export function introspectRdf(source: DataSource, turtle: string): IntrospectionResult {
  const entities: DiscoveredEntity[] = [];
  const relationships: DiscoveredRelationship[] = [];
  const classFields = new Map<string, { name: string; type: string; required: boolean }[]>();

  // Simple Turtle parser: extract triples by line matching
  const lines = turtle.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('@prefix'));

  // Extract classes: ?s a ?class
  const classPattern = /^<([^>]+)>\s+a\s+<([^>]+)>/;
  // Extract properties: ?s <prop> ?o
  const propPattern = /^<([^>]+)>\s+<([^>]+)>\s+(?:<([^>]+)>|"([^"]*)")/;
  // Domain/range declarations
  const domainPattern = /^<([^>]+)>\s+(?:rdfs:domain|<[^>]*#domain>)\s+<([^>]+)>/;
  const rangePattern = /^<([^>]+)>\s+(?:rdfs:range|<[^>]*#range>)\s+<([^>]+)>/;

  const classes = new Set<string>();
  const domains = new Map<string, string>();
  const ranges = new Map<string, string>();

  for (const line of lines) {
    const classMatch = line.match(classPattern);
    if (classMatch) {
      const className = classMatch[2]!.split(/[#/]/).pop()!;
      classes.add(className);
      if (!classFields.has(className)) {
        classFields.set(className, []);
      }
    }

    const domainMatch = line.match(domainPattern);
    if (domainMatch) {
      const prop = domainMatch[1]!.split(/[#/]/).pop()!;
      const domain = domainMatch[2]!.split(/[#/]/).pop()!;
      domains.set(prop, domain);
    }

    const rangeMatch = line.match(rangePattern);
    if (rangeMatch) {
      const prop = rangeMatch[1]!.split(/[#/]/).pop()!;
      const range = rangeMatch[2]!.split(/[#/]/).pop()!;
      ranges.set(prop, range);
    }

    const propMatch = line.match(propPattern);
    if (propMatch) {
      const prop = propMatch[2]!.split(/[#/]/).pop()!;
      const isLiteral = propMatch[4] !== undefined;
      if (isLiteral) {
        // Property with literal value: add as field to domain class
        const domain = domains.get(prop);
        if (domain && classFields.has(domain)) {
          classFields.get(domain)!.push({ name: prop, type: 'string', required: false });
        }
      } else {
        // Property with object value: this is a relationship
        const domain = domains.get(prop);
        const range = ranges.get(prop);
        if (domain && range) {
          relationships.push({ from: domain, to: range, type: 'references' });
        }
      }
    }
  }

  // Build entities from discovered classes
  for (const [className, fields] of classFields) {
    entities.push({ name: className, fields });
  }

  // If no classes found via rdfs:domain, create a generic entity from all properties
  if (entities.length === 0 && lines.length > 0) {
    const fields: { name: string; type: string; required: boolean }[] = [];
    for (const line of lines) {
      const propMatch = line.match(propPattern);
      if (propMatch) {
        const prop = propMatch[2]!.split(/[#/]/).pop()!;
        const isLiteral = propMatch[4] !== undefined;
        fields.push({ name: prop, type: isLiteral ? 'string' : 'object', required: false });
      }
    }
    if (fields.length > 0) {
      entities.push({ name: source.name, fields });
    }
  }

  const schema: DiscoveredSchema = { entities, relationships };
  const chains = schemaToChains(schema);
  const shapes = schemaToShapes(schema);
  const suggestedConstraints = schemaToConstraints(schema);

  return {
    sourceId: source.id,
    scannedAt: new Date().toISOString(),
    schema,
    chains,
    shapes,
    suggestedProfile: `profile:${source.name}-rdf-ingestion`,
    suggestedConstraints,
  };
}

/**
 * Introspect an OpenAPI/Swagger API specification.
 *
 * Discovers endpoints, methods, parameters, and response schemas.
 */
export function introspectApi(source: DataSource, openApiSpec: unknown): IntrospectionResult {
  const entities: DiscoveredEntity[] = [];
  const relationships: DiscoveredRelationship[] = [];

  const spec = openApiSpec as Record<string, unknown>;
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
  const schemas = ((spec.components as Record<string, unknown>)?.schemas ?? {}) as Record<string, unknown>;

  // Extract entities from component schemas
  for (const [schemaName, schemaDef] of Object.entries(schemas)) {
    const def = schemaDef as Record<string, unknown>;
    const properties = (def.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = (def.required ?? []) as string[];

    const fields: { name: string; type: string; required: boolean }[] = [];
    for (const [propName, propDef] of Object.entries(properties)) {
      const propType = (propDef.type as string) ?? 'string';
      const ref = propDef.$ref as string | undefined;
      if (ref) {
        const refName = ref.split('/').pop()!;
        relationships.push({ from: schemaName, to: refName, type: 'references' });
      } else if (propType === 'array' && propDef.items) {
        const itemRef = (propDef.items as Record<string, unknown>).$ref as string | undefined;
        if (itemRef) {
          const refName = itemRef.split('/').pop()!;
          relationships.push({ from: schemaName, to: refName, type: 'has-many' });
        } else {
          fields.push({ name: propName, type: 'array', required: required.includes(propName) });
        }
      } else {
        fields.push({ name: propName, type: propType, required: required.includes(propName) });
      }
    }

    entities.push({ name: schemaName, fields });
  }

  // Extract endpoint information as chains
  const endpointChains: string[] = [];
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, opDef] of Object.entries(methods)) {
      const op = opDef as Record<string, unknown>;
      const operationId = (op.operationId as string) ?? `${method}_${path.replace(/\//g, '_')}`;
      endpointChains.push(`(${source.name}, endpoint, ${path})`);
      endpointChains.push(`(${path}, method, ${method.toUpperCase()})`);
      endpointChains.push(`(${path}, operation, ${operationId})`);

      // Link response schemas
      const responses = (op.responses ?? {}) as Record<string, Record<string, unknown>>;
      for (const [, responseDef] of Object.entries(responses)) {
        const content = (responseDef.content ?? {}) as Record<string, Record<string, unknown>>;
        for (const [, mediaType] of Object.entries(content)) {
          const schemaRef = (mediaType.schema as Record<string, unknown>)?.$ref as string | undefined;
          if (schemaRef) {
            const refName = schemaRef.split('/').pop()!;
            endpointChains.push(`(${operationId}, returns, ${refName})`);
          }
        }
      }
    }
  }

  const schema: DiscoveredSchema = { entities, relationships };
  const chains = [...schemaToChains(schema), ...endpointChains];
  const shapes = schemaToShapes(schema);
  const suggestedConstraints = schemaToConstraints(schema);

  return {
    sourceId: source.id,
    scannedAt: new Date().toISOString(),
    schema,
    chains,
    shapes,
    suggestedProfile: `profile:${source.name}-api-ingestion`,
    suggestedConstraints,
  };
}

/**
 * Create an introspection agent bound to a PGSL instance.
 *
 * The agent can scan JSON, CSV, RDF, and API sources, generating
 * PGSL chains, SHACL shapes, and ingestion profiles.
 */
export function createIntrospectionAgent(pgsl: PGSLInstance): IntrospectionAgent {
  const id = agentId(pgsl);
  return {
    id,
    capabilities: ['introspect-json', 'introspect-csv', 'introspect-rdf', 'introspect-api'],
    pgsl,
    introspectJson: (source, sampleData) => introspectJson(source, sampleData),
    introspectCsv: (source, headers, sampleRows) => introspectCsv(source, headers, sampleRows),
    introspectRdf: (source, turtle) => introspectRdf(source, turtle),
    introspectApi: (source, spec) => introspectApi(source, spec),
  };
}

/**
 * Apply an introspection result: ingest all discovered chains into the PGSL lattice.
 *
 * Each chain triple `(subject, predicate, object)` is ingested as a 3-atom sequence.
 */
export function applyIntrospection(pgsl: PGSLInstance, result: IntrospectionResult): void {
  for (const chain of result.chains) {
    // Parse chain: "(a, b, c)" → ["a", "b", "c"]
    const match = chain.match(/^\((.+)\)$/);
    if (!match) continue;
    const parts = match[1]!.split(',').map(s => s.trim());
    if (parts.length < 2) continue;
    ingest(pgsl, parts);
  }
}

// ═════════════════════════════════════════════════════════════
//  §10 — Zero-Copy Virtual Layer
// ═════════════════════════════════════════════════════════════

// ── Types ──────────────────────────────────────────────────

/** A virtual reference to external data (not loaded until queried). */
export interface VirtualReference {
  readonly id: string;
  readonly sourceId: string;
  readonly path: string;
  readonly estimatedSize?: number;
  readonly lastAccessed?: string;
  readonly cached?: boolean;
}

/** Virtual layer configuration. */
export interface VirtualLayerConfig {
  readonly maxCacheSize: number;
  readonly cacheEvictionPolicy: 'lru' | 'fifo' | 'none';
  readonly lazyLoadThreshold: number;
}

/** Cached entry in the virtual layer. */
export interface CacheEntry {
  readonly data: unknown;
  readonly loadedAt: string;
  readonly size: number;
}

/** Virtual layer state. */
export interface VirtualLayer {
  readonly config: VirtualLayerConfig;
  readonly references: ReadonlyMap<string, VirtualReference>;
  readonly cache: ReadonlyMap<string, CacheEntry>;
  readonly stats: { hits: number; misses: number; totalLoaded: number };
}

// ── Virtual Layer Functions ────────────────────────────────

/** Default virtual layer configuration. */
const DEFAULT_VIRTUAL_CONFIG: VirtualLayerConfig = {
  maxCacheSize: 1024 * 1024, // 1 MB
  cacheEvictionPolicy: 'lru',
  lazyLoadThreshold: 1024, // 1 KB
};

/**
 * Create a new virtual layer with optional configuration.
 * Defaults to 1 MB cache with LRU eviction.
 */
export function createVirtualLayer(config?: Partial<VirtualLayerConfig>): VirtualLayer {
  return {
    config: { ...DEFAULT_VIRTUAL_CONFIG, ...config },
    references: new Map(),
    cache: new Map(),
    stats: { hits: 0, misses: 0, totalLoaded: 0 },
  };
}

/**
 * Register a virtual reference to external data.
 *
 * The data is NOT loaded — only a reference is stored.
 * Returns a new layer with the reference added.
 */
export function registerReference(
  layer: VirtualLayer,
  sourceId: string,
  path: string,
  estimatedSize?: number,
): VirtualLayer {
  const id = createHash('sha256')
    .update(`vref:${sourceId}:${path}`)
    .digest('hex')
    .slice(0, 24);

  const ref: VirtualReference = {
    id,
    sourceId,
    path,
    estimatedSize,
    cached: false,
  };

  const refs = new Map(layer.references);
  refs.set(id, ref);

  return { ...layer, references: refs };
}

/**
 * Resolve a virtual reference lazily.
 *
 * Check cache first. On miss, call the loader function.
 * If the result exceeds maxCacheSize, evict entries according to policy.
 *
 * Returns the resolved data and updated layer state.
 */
export async function resolveReference(
  layer: VirtualLayer,
  refId: string,
  loader: (path: string) => Promise<unknown>,
): Promise<{ data: unknown; layer: VirtualLayer }> {
  const ref = layer.references.get(refId);
  if (!ref) throw new Error(`Virtual reference not found: ${refId}`);

  // Cache hit
  const cached = layer.cache.get(refId);
  if (cached) {
    const stats = { ...layer.stats, hits: layer.stats.hits + 1 };

    // Update lastAccessed on the reference
    const refs = new Map(layer.references);
    refs.set(refId, { ...ref, lastAccessed: new Date().toISOString(), cached: true });

    // For LRU: move to end by re-inserting
    if (layer.config.cacheEvictionPolicy === 'lru') {
      const cache = new Map(layer.cache);
      cache.delete(refId);
      cache.set(refId, cached);
      return { data: cached.data, layer: { ...layer, references: refs, cache, stats } };
    }

    return { data: cached.data, layer: { ...layer, references: refs, stats } };
  }

  // Cache miss — load the data
  const data = await loader(ref.path);
  const serialized = JSON.stringify(data);
  const size = serialized.length;

  const stats = {
    ...layer.stats,
    misses: layer.stats.misses + 1,
    totalLoaded: layer.stats.totalLoaded + size,
  };

  // Update the reference
  const refs = new Map(layer.references);
  refs.set(refId, { ...ref, lastAccessed: new Date().toISOString(), cached: true });

  // Add to cache with eviction
  const cache = new Map(layer.cache);
  const entry: CacheEntry = { data, loadedAt: new Date().toISOString(), size };

  // Evict until we have room
  if (layer.config.cacheEvictionPolicy !== 'none') {
    let currentSize = 0;
    for (const [, e] of cache) currentSize += e.size;

    while (currentSize + size > layer.config.maxCacheSize && cache.size > 0) {
      // LRU and FIFO both evict the first entry (oldest in insertion order)
      const firstKey = cache.keys().next().value as string;
      const evicted = cache.get(firstKey)!;
      cache.delete(firstKey);
      currentSize -= evicted.size;

      // Mark the evicted reference as uncached
      const evictedRef = refs.get(firstKey);
      if (evictedRef) {
        refs.set(firstKey, { ...evictedRef, cached: false });
      }
    }
  }

  cache.set(refId, entry);

  return { data, layer: { ...layer, references: refs, cache, stats } };
}

/**
 * Invalidate cached data for one or all references.
 *
 * If refId is provided, invalidate that reference only.
 * If omitted, invalidate the entire cache.
 */
export function invalidateCache(layer: VirtualLayer, refId?: string): VirtualLayer {
  const cache = new Map(layer.cache);
  const refs = new Map(layer.references);

  if (refId) {
    cache.delete(refId);
    const ref = refs.get(refId);
    if (ref) {
      refs.set(refId, { ...ref, cached: false });
    }
  } else {
    cache.clear();
    for (const [id, ref] of refs) {
      refs.set(id, { ...ref, cached: false });
    }
  }

  return { ...layer, references: refs, cache };
}

/**
 * Get virtual layer statistics: hit rate, total loaded, memory usage.
 */
export function virtualLayerStats(layer: VirtualLayer): {
  referenceCount: number;
  cachedCount: number;
  cacheSize: number;
  hitRate: number;
  hits: number;
  misses: number;
  totalLoaded: number;
} {
  let cacheSize = 0;
  for (const [, entry] of layer.cache) cacheSize += entry.size;

  const totalRequests = layer.stats.hits + layer.stats.misses;
  const hitRate = totalRequests > 0 ? layer.stats.hits / totalRequests : 0;

  return {
    referenceCount: layer.references.size,
    cachedCount: layer.cache.size,
    cacheSize,
    hitRate,
    hits: layer.stats.hits,
    misses: layer.stats.misses,
    totalLoaded: layer.stats.totalLoaded,
  };
}

// ═════════════════════════════════════════════════════════════
//  §11 — Homoiconic Metagraph
// ═════════════════════════════════════════════════════════════

// ── Types ──────────────────────────────────────────────────

/** Meta-level: the lattice describes itself. */
export interface MetagraphDescriptor {
  readonly latticeUri: string;
  readonly atomCount: number;
  readonly fragmentCount: number;
  readonly maxLevel: number;
  readonly metaAtoms: readonly string[];
  readonly invariants: readonly string[];
}

// ── Metagraph Functions ────────────────────────────────────

/**
 * Generate a metagraph descriptor: a self-description of the PGSL lattice.
 *
 * Creates meta-atoms (`lattice-root`, `atom-count`, `fragment-count`, `max-level`)
 * and chains them as PGSL triples. Also generates structural invariants that
 * express what is always true about the lattice structure.
 *
 * The key idea: the lattice IS its own documentation.
 */
export function generateMetagraph(pgsl: PGSLInstance): MetagraphDescriptor {
  const stats = latticeStats(pgsl);

  const latticeUri = `urn:pgsl:metagraph:${createHash('sha256')
    .update(`metagraph:${pgsl.defaultProvenance.wasAttributedTo}:${stats.totalNodes}`)
    .digest('hex')
    .slice(0, 24)}`;

  // Meta-atoms: facts about the lattice
  const metaAtoms: string[] = [
    'lattice-root',
    'atom-count',
    'fragment-count',
    'max-level',
    'total-nodes',
    String(stats.atoms),
    String(stats.fragments),
    String(stats.maxLevel),
    String(stats.totalNodes),
  ];

  // Structural invariants: things that are always true
  const invariants: string[] = [
    '(atom, always, level-0)',
    '(fragment, always, level-gte-1)',
    '(overlapping-pair, requires, shared-subsequence)',
    '(content-address, guarantees, canonical-uri)',
    '(level-k, built-from, level-k-minus-1)',
  ];

  return {
    latticeUri,
    atomCount: stats.atoms,
    fragmentCount: stats.fragments,
    maxLevel: stats.maxLevel,
    metaAtoms,
    invariants,
  };
}

/**
 * Ingest the metagraph self-description INTO the lattice.
 *
 * After this, the lattice contains knowledge about itself:
 *   (lattice-root, atom-count, 42)
 *   (lattice-root, fragment-count, 100)
 *   (lattice-root, max-level, 5)
 *   (lattice-root, total-nodes, 142)
 *
 * Plus all structural invariants as chains.
 */
export function ingestMetagraph(pgsl: PGSLInstance, descriptor: MetagraphDescriptor): void {
  // Ingest meta-facts as chains
  ingest(pgsl, ['lattice-root', 'atom-count', String(descriptor.atomCount)]);
  ingest(pgsl, ['lattice-root', 'fragment-count', String(descriptor.fragmentCount)]);
  ingest(pgsl, ['lattice-root', 'max-level', String(descriptor.maxLevel)]);
  ingest(pgsl, ['lattice-root', 'total-nodes', String(descriptor.atomCount + descriptor.fragmentCount)]);
  ingest(pgsl, ['lattice-root', 'lattice-uri', descriptor.latticeUri]);

  // Ingest structural invariants
  for (const invariant of descriptor.invariants) {
    const match = invariant.match(/^\((.+)\)$/);
    if (!match) continue;
    const parts = match[1]!.split(',').map(s => s.trim());
    if (parts.length >= 2) {
      ingest(pgsl, parts);
    }
  }
}

/**
 * Validate that the metagraph still accurately describes the lattice.
 *
 * Returns an array of discrepancies between the descriptor and the current
 * lattice state. Empty array means the metagraph is accurate.
 */
export function validateMetagraph(
  pgsl: PGSLInstance,
  descriptor: MetagraphDescriptor,
): string[] {
  const stats = latticeStats(pgsl);
  const discrepancies: string[] = [];

  if (descriptor.atomCount !== stats.atoms) {
    discrepancies.push(
      `atom-count mismatch: descriptor says ${descriptor.atomCount}, lattice has ${stats.atoms}`,
    );
  }
  if (descriptor.fragmentCount !== stats.fragments) {
    discrepancies.push(
      `fragment-count mismatch: descriptor says ${descriptor.fragmentCount}, lattice has ${stats.fragments}`,
    );
  }
  if (descriptor.maxLevel !== stats.maxLevel) {
    discrepancies.push(
      `max-level mismatch: descriptor says ${descriptor.maxLevel}, lattice has ${stats.maxLevel}`,
    );
  }

  return discrepancies;
}

/**
 * Query the metagraph with a simple natural-language question.
 *
 * Pattern matches against known metagraph queries:
 *   "how many atoms?"      → look up (lattice-root, atom-count, ?)
 *   "how many fragments?"  → look up (lattice-root, fragment-count, ?)
 *   "what is max level?"   → look up (lattice-root, max-level, ?)
 *   "how many nodes?"      → look up (lattice-root, total-nodes, ?)
 *
 * Falls back to searching atom values for keyword matches.
 */
export function queryMetagraph(pgsl: PGSLInstance, question: string): string {
  const q = question.toLowerCase();

  // Pattern matching for known questions
  if (q.includes('atom') && (q.includes('how many') || q.includes('count'))) {
    return findMetaValue(pgsl, 'atom-count');
  }
  if (q.includes('fragment') && (q.includes('how many') || q.includes('count'))) {
    return findMetaValue(pgsl, 'fragment-count');
  }
  if (q.includes('level') && (q.includes('max') || q.includes('highest') || q.includes('deep'))) {
    return findMetaValue(pgsl, 'max-level');
  }
  if (q.includes('node') && (q.includes('how many') || q.includes('count') || q.includes('total'))) {
    return findMetaValue(pgsl, 'total-nodes');
  }
  if (q.includes('uri') || q.includes('id') || q.includes('identity')) {
    return findMetaValue(pgsl, 'lattice-uri');
  }

  // Fallback: search all atoms for keyword matches
  const keywords = q.split(/\s+/).filter(w => w.length > 2);
  const matches: string[] = [];
  for (const [, node] of pgsl.nodes) {
    if (node.kind !== 'Atom') continue;
    const val = String(node.value).toLowerCase();
    if (keywords.some(kw => val.includes(kw))) {
      matches.push(String(node.value));
    }
  }

  if (matches.length > 0) {
    return matches.join(', ');
  }

  return '<no metagraph data found>';
}

/**
 * @internal Look up a meta-value by finding the chain (lattice-root, key, ?).
 *
 * Searches the lattice for a fragment containing atoms [lattice-root, key, ?]
 * and returns the third atom's value.
 */
function findMetaValue(pgsl: PGSLInstance, key: string): string {
  // Find the atom URIs for 'lattice-root' and the key
  const rootUri = pgsl.atoms.get('lattice-root');
  const keyUri = pgsl.atoms.get(key);

  if (!rootUri || !keyUri) return '<not ingested>';

  // Search fragments for one containing both rootUri and keyUri
  for (const [, node] of pgsl.nodes) {
    if (node.kind !== 'Fragment') continue;
    const items = node.items;
    if (items.length < 3) continue;

    // Check if this fragment starts with [rootUri, keyUri, ...]
    const firstAtom = pgsl.nodes.get(items[0]!);
    const secondAtom = pgsl.nodes.get(items[1]!);

    // Items might be level-1 wrappers; resolve to atom URIs
    const firstInner = firstAtom?.kind === 'Fragment' && firstAtom.items.length === 1
      ? firstAtom.items[0]! : items[0]!;
    const secondInner = secondAtom?.kind === 'Fragment' && secondAtom.items.length === 1
      ? secondAtom.items[0]! : items[1]!;

    if (firstInner === rootUri && secondInner === keyUri) {
      // Found: the third item is the value
      const thirdAtom = pgsl.nodes.get(items[2]!);
      const thirdInner = thirdAtom?.kind === 'Fragment' && thirdAtom.items.length === 1
        ? pgsl.nodes.get(thirdAtom.items[0]!)
        : thirdAtom;
      if (thirdInner?.kind === 'Atom') {
        return String(thirdInner.value);
      }
    }
  }

  return '<not found>';
}

// ═════════════════════════════════════════════════════════════
//  §12 — Marketplace Discovery
// ═════════════════════════════════════════════════════════════

// ── Types ──────────────────────────────────────────────────

/** A marketplace listing. */
export interface MarketplaceListing {
  readonly id: string;
  readonly type: 'agent' | 'data-source' | 'decorator' | 'profile' | 'constraint-set';
  readonly name: string;
  readonly description: string;
  readonly provider: string;
  readonly capabilities: readonly string[];
  readonly endpoint?: string;
  readonly trustLevel: 'self-asserted' | 'community-verified' | 'certified';
  readonly registeredAt: string;
  readonly lastSeen?: string;
  readonly metadata?: Record<string, unknown>;
  readonly operations: readonly MarketplaceOperation[];
}

/** A Hydra operation on a marketplace listing. */
export interface MarketplaceOperation {
  readonly method: string;
  readonly href: string;
  readonly title: string;
  readonly expects?: string;
  readonly returns?: string;
}

/** The marketplace: a registry of listings. */
export interface Marketplace {
  readonly listings: ReadonlyMap<string, MarketplaceListing>;
}

// ── Marketplace Functions ──────────────────────────────────

/**
 * Create an empty marketplace.
 */
export function createMarketplace(): Marketplace {
  return { listings: new Map() };
}

/**
 * Register a new listing in the marketplace.
 *
 * If a listing with the same ID already exists, it is replaced.
 */
export function registerListing(
  marketplace: Marketplace,
  listing: MarketplaceListing,
): Marketplace {
  const listings = new Map(marketplace.listings);
  listings.set(listing.id, listing);
  return { listings };
}

/**
 * Remove a listing from the marketplace.
 */
export function removeListing(marketplace: Marketplace, id: string): Marketplace {
  const listings = new Map(marketplace.listings);
  listings.delete(id);
  return { listings };
}

/**
 * Discover listings matching ALL specified capabilities.
 *
 * A listing matches if its capabilities array contains every
 * capability in the query.
 */
export function discoverByCapability(
  marketplace: Marketplace,
  capabilities: string[],
): MarketplaceListing[] {
  const results: MarketplaceListing[] = [];
  for (const [, listing] of marketplace.listings) {
    const hasAll = capabilities.every(cap =>
      listing.capabilities.includes(cap),
    );
    if (hasAll) results.push(listing);
  }
  return results;
}

/**
 * Discover listings by type.
 */
export function discoverByType(
  marketplace: Marketplace,
  type: MarketplaceListing['type'],
): MarketplaceListing[] {
  const results: MarketplaceListing[] = [];
  for (const [, listing] of marketplace.listings) {
    if (listing.type === type) results.push(listing);
  }
  return results;
}

/**
 * Refresh a listing's lastSeen timestamp.
 */
export function refreshListing(marketplace: Marketplace, id: string): Marketplace {
  const listing = marketplace.listings.get(id);
  if (!listing) return marketplace;

  const updated: MarketplaceListing = {
    ...listing,
    lastSeen: new Date().toISOString(),
  };

  const listings = new Map(marketplace.listings);
  listings.set(id, updated);
  return { listings };
}

/**
 * Serialize the marketplace as a Hydra API description in Turtle.
 *
 * Each listing becomes a hydra:Resource with hydra:operation entries
 * for each of its operations.
 */
export function marketplaceToHydra(marketplace: Marketplace): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const lines: string[] = [
    '@prefix hydra: <http://www.w3.org/ns/hydra/core#> .',
    '@prefix cg: <https://contextgraphs.org/ns/> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '',
    '<urn:cg:marketplace> a hydra:ApiDocumentation ;',
    `  hydra:title "Interego Marketplace" ;`,
    `  hydra:description "Hydra-driven discovery of agents, data sources, and decorators" .`,
    '',
  ];

  for (const [, listing] of marketplace.listings) {
    lines.push(`<${listing.id}> a hydra:Resource, cg:${capitalize(listing.type)} ;`);
    lines.push(`  rdfs:label "${esc(listing.name)}" ;`);
    lines.push(`  cg:description "${esc(listing.description)}" ;`);
    lines.push(`  cg:provider "${esc(listing.provider)}" ;`);
    lines.push(`  cg:trustLevel "${listing.trustLevel}" ;`);
    lines.push(`  cg:registeredAt "${listing.registeredAt}"^^xsd:dateTime ;`);

    if (listing.lastSeen) {
      lines.push(`  cg:lastSeen "${listing.lastSeen}"^^xsd:dateTime ;`);
    }
    if (listing.endpoint) {
      lines.push(`  cg:endpoint <${listing.endpoint}> ;`);
    }

    // Capabilities
    for (const cap of listing.capabilities) {
      lines.push(`  cg:capability "${esc(cap)}" ;`);
    }

    // Operations
    for (const op of listing.operations) {
      lines.push(`  hydra:operation [`);
      lines.push(`    a hydra:Operation ;`);
      lines.push(`    hydra:method "${op.method}" ;`);
      lines.push(`    hydra:title "${esc(op.title)}" ;`);
      if (op.expects) {
        lines.push(`    hydra:expects "${esc(op.expects)}" ;`);
      }
      if (op.returns) {
        lines.push(`    hydra:returns "${esc(op.returns)}" ;`);
      }
      lines.push(`  ] ;`);
    }

    // Close the resource (replace trailing ';' with '.')
    const last = lines[lines.length - 1]!;
    lines[lines.length - 1] = last.replace(/ ;$/, ' .');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Get marketplace statistics: counts by type and by trust level.
 */
export function marketplaceStats(marketplace: Marketplace): {
  total: number;
  byType: Record<string, number>;
  byTrustLevel: Record<string, number>;
} {
  const byType: Record<string, number> = {};
  const byTrustLevel: Record<string, number> = {};

  for (const [, listing] of marketplace.listings) {
    byType[listing.type] = (byType[listing.type] ?? 0) + 1;
    byTrustLevel[listing.trustLevel] = (byTrustLevel[listing.trustLevel] ?? 0) + 1;
  }

  return { total: marketplace.listings.size, byType, byTrustLevel };
}

// ── Internal Helpers ───────────────────────────────────────

/** @internal Capitalize first letter. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
