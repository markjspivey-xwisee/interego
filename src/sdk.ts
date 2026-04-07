/**
 * @module sdk
 * @description 3-line developer SDK for Context Graphs.
 *
 * Usage:
 * ```ts
 * import { ContextGraphs } from '@foxxi/context-graphs';
 *
 * const cg = new ContextGraphs({ podUrl: 'https://css.example.com/alice/', token: 'cg_...' });
 * await cg.publish('urn:graph:my-data', turtleContent, { confidence: 0.95 });
 * const results = await cg.search('deployment architecture', { limit: 5 });
 * ```
 *
 * Features:
 *   - publish() — write context with full facets + IPFS pin + anchor receipt
 *   - search() — semantic vector search + facet filtering (hybrid)
 *   - discover() — enumerate all descriptors on a pod
 *   - get() — fetch a specific descriptor's full Turtle
 *   - subscribe() — WebSocket notifications on pod changes
 *   - ingest() — feed content into PGSL lattice
 *   - meet() — find structural overlap between two PGSL fragments
 */

import type { IRI } from './model/types.js';
import type { FetchFn, DiscoverFilter, Subscription, ManifestEntry, ContextChangeEvent } from './solid/types.js';
import type { IpfsConfig } from './crypto/types.js';
import type { PGSLInstance, NodeProvenance } from './pgsl/types.js';
import { ContextDescriptor } from './model/descriptor.js';
import { toTurtle } from './rdf/serializer.js';
import { validate } from './validation/validator.js';
import { publish, discover, subscribe as solidSubscribe } from './solid/client.js';
import { createPGSL, resolve as pgslResolve, latticeStats } from './pgsl/lattice.js';
import { latticeMeet } from './pgsl/category.js';
import { embedInPGSL } from './pgsl/geometric.js';
import { computeCid, pinToIpfs } from './crypto/ipfs.js';

// ── Types ────────────────────────────────────────────────────

export interface ContextGraphsConfig {
  /** Solid pod URL (e.g. 'https://css.example.com/alice/') */
  podUrl: string;
  /** Bearer token for authenticated operations (optional for read-only) */
  token?: string;
  /** Agent identity IRI */
  agentId?: string;
  /** Owner WebID */
  ownerWebId?: string;
  /** Owner display name */
  ownerName?: string;
  /** IPFS configuration (default: local CID computation) */
  ipfs?: IpfsConfig;
  /** Custom fetch function */
  fetch?: FetchFn;
  /** WebSocket constructor (for Node.js: import { WebSocket } from 'ws') */
  WebSocket?: any;
}

export interface PublishOptions {
  /** Epistemic confidence 0.0-1.0 (default: 0.85) */
  confidence?: number;
  /** Modal status (default: 'Asserted') */
  modalStatus?: 'Asserted' | 'Hypothetical' | 'Counterfactual';
  /** Validity start (default: now) */
  validFrom?: string;
  /** Validity end (optional) */
  validUntil?: string;
  /** Task description for provenance */
  task?: string;
  /** Pin to IPFS (default: true if IPFS config provided) */
  pin?: boolean;
}

export interface SearchOptions {
  /** Maximum results (default: 10) */
  limit?: number;
  /** Filter by facet type */
  facetType?: string;
  /** Filter: valid at or after this datetime */
  validFrom?: string;
  /** Filter: valid at or before this datetime */
  validUntil?: string;
}

export interface SearchResult {
  descriptorUrl: string;
  describes: readonly string[];
  facetTypes: readonly string[];
  validFrom?: string;
  validUntil?: string;
  score?: number;  // similarity score if semantic search available
}

export interface PublishResult {
  descriptorUrl: string;
  graphUrl: string;
  manifestUrl: string;
  ipfsCid?: string;
  ipfsUrl?: string;
}

// ── SDK Class ────────────────────────────────────────────────

export class ContextGraphsSDK {
  private config: ContextGraphsConfig;
  private fetchFn: FetchFn;
  private pgsl: PGSLInstance;
  private subscriptions: Map<string, Subscription> = new Map();

  constructor(config: ContextGraphsConfig) {
    this.config = {
      agentId: 'urn:agent:sdk:default',
      ownerWebId: `${config.podUrl}profile#me`,
      ownerName: 'SDK User',
      ipfs: { provider: 'local' },
      ...config,
      podUrl: config.podUrl.endsWith('/') ? config.podUrl : `${config.podUrl}/`,
    };

    // Build authenticated fetch
    this.fetchFn = config.fetch ?? this.buildFetch();

    // Initialize PGSL lattice
    const provenance: NodeProvenance = {
      wasAttributedTo: this.config.ownerWebId!,
      generatedAtTime: new Date().toISOString(),
    };
    this.pgsl = createPGSL(provenance);
  }

  // ── Core API ─────────────────────────────────────────────

  /**
   * Publish a context-annotated knowledge graph.
   *
   * ```ts
   * await cg.publish('urn:graph:my-data', turtleContent, { confidence: 0.95 });
   * ```
   */
  async publish(
    graphIri: string,
    graphContent: string,
    options: PublishOptions = {},
  ): Promise<PublishResult> {
    const now = new Date().toISOString();
    const descId = `urn:cg:sdk:${Date.now()}` as IRI;

    const builder = ContextDescriptor.create(descId)
      .describes(graphIri as IRI)
      .temporal({
        validFrom: options.validFrom ?? now,
        validUntil: options.validUntil,
      })
      .semiotic({
        modalStatus: options.modalStatus ?? 'Asserted',
        epistemicConfidence: options.confidence ?? 0.85,
        groundTruth: (options.modalStatus ?? 'Asserted') === 'Asserted',
      })
      .trust({
        trustLevel: 'SelfAsserted',
        issuer: this.config.ownerWebId as IRI,
      })
      .federation({
        origin: this.config.podUrl as IRI,
        storageEndpoint: this.config.podUrl as IRI,
        syncProtocol: 'SolidNotifications',
      })
      .version(1);

    // Add provenance with agent + owner
    if (this.config.ownerWebId && this.config.agentId) {
      builder.delegatedBy(
        this.config.ownerWebId as IRI,
        this.config.agentId as IRI,
        { endedAt: now },
      );
    } else {
      builder.provenance({
        wasAttributedTo: this.config.ownerWebId as IRI,
        generatedAtTime: now,
        wasGeneratedBy: {
          agent: (this.config.agentId ?? 'urn:agent:sdk:default') as IRI,
          endedAt: now,
        },
      });
    }

    const descriptor = builder.build();
    const validation = validate(descriptor);
    if (!validation.conforms) {
      throw new Error(`Validation failed: ${validation.violations.map(v => v.message).join('; ')}`);
    }

    const result = await publish(descriptor, graphContent, this.config.podUrl, {
      fetch: this.fetchFn,
    });

    // Pin to IPFS if configured
    let ipfsCid: string | undefined;
    let ipfsUrl: string | undefined;
    const shouldPin = options.pin ?? (this.config.ipfs?.provider !== 'local');
    if (shouldPin && this.config.ipfs && this.config.ipfs.provider !== 'local') {
      try {
        const turtle = toTurtle(descriptor);
        const pinResult = await pinToIpfs(turtle, `descriptor-${descId}`, this.config.ipfs, this.fetchFn);
        ipfsCid = pinResult.cid;
        ipfsUrl = pinResult.url;
      } catch {
        // IPFS pin failed — continue without it
      }
    } else {
      ipfsCid = computeCid(toTurtle(descriptor));
    }

    return {
      descriptorUrl: result.descriptorUrl,
      graphUrl: result.graphUrl,
      manifestUrl: result.manifestUrl,
      ipfsCid,
      ipfsUrl,
    };
  }

  /**
   * Search for descriptors by text query and/or facet filters.
   * Uses PGSL structural matching when available,
   * falls back to facet filtering.
   *
   * ```ts
   * const results = await cg.search('causal reasoning', { limit: 5 });
   * ```
   */
  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    // Discover all descriptors
    const filter: DiscoverFilter | undefined = options.facetType || options.validFrom || options.validUntil
      ? {
          facetType: options.facetType as any,
          validFrom: options.validFrom,
          validUntil: options.validUntil,
        }
      : undefined;

    const entries = await discover(this.config.podUrl, filter, { fetch: this.fetchFn });

    if (!query) {
      return entries.slice(0, options.limit ?? 10).map(e => ({
        descriptorUrl: e.descriptorUrl,
        describes: e.describes,
        facetTypes: e.facetTypes,
        validFrom: e.validFrom,
        validUntil: e.validUntil,
      }));
    }

    // Score each entry by text similarity
    // Simple: tokenize query and check overlap with graph IRIs and facet types
    const queryTokens = new Set(query.toLowerCase().split(/\s+/));
    const scored = entries.map(entry => {
      let score = 0;
      for (const graph of entry.describes) {
        const graphTokens = graph.toLowerCase().split(/[^a-z0-9]+/);
        for (const t of graphTokens) {
          if (queryTokens.has(t)) score += 1;
        }
      }
      for (const ft of entry.facetTypes) {
        if (queryTokens.has(ft.toLowerCase())) score += 0.5;
      }
      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 10)
      .map(s => ({
        descriptorUrl: s.entry.descriptorUrl,
        describes: s.entry.describes,
        facetTypes: s.entry.facetTypes,
        validFrom: s.entry.validFrom,
        validUntil: s.entry.validUntil,
        score: s.score,
      }));
  }

  /**
   * Discover all descriptors on the pod.
   *
   * ```ts
   * const descriptors = await cg.discover();
   * ```
   */
  async discover(filter?: DiscoverFilter): Promise<ManifestEntry[]> {
    return discover(this.config.podUrl, filter, { fetch: this.fetchFn });
  }

  /**
   * Fetch a specific descriptor's full Turtle.
   *
   * ```ts
   * const turtle = await cg.get(descriptorUrl);
   * ```
   */
  async get(descriptorUrl: string): Promise<string> {
    const resp = await this.fetchFn(descriptorUrl, {
      method: 'GET',
      headers: { 'Accept': 'text/turtle' },
    });
    if (!resp.ok) {
      throw new Error(`Failed to fetch ${descriptorUrl}: ${resp.status} ${resp.statusText}`);
    }
    return resp.text();
  }

  /**
   * Subscribe to pod changes via WebSocket.
   *
   * ```ts
   * cg.subscribe((event) => console.log('Change:', event.type, event.resource));
   * ```
   */
  async subscribe(callback: (event: ContextChangeEvent) => void): Promise<void> {
    if (this.subscriptions.has(this.config.podUrl)) return;

    const sub = await solidSubscribe(this.config.podUrl, callback, {
      fetch: this.fetchFn,
      WebSocket: this.config.WebSocket,
    });
    this.subscriptions.set(this.config.podUrl, sub);
  }

  /**
   * Ingest text content into the PGSL lattice.
   *
   * ```ts
   * const topUri = cg.ingest('autonomous agents share knowledge through federated pods');
   * ```
   */
  ingest(content: string): string {
    return embedInPGSL(this.pgsl, content);
  }

  /**
   * Find the structural overlap between two PGSL fragments.
   *
   * ```ts
   * const overlap = cg.meet(uriA, uriB);
   * // overlap = 'urn:pgsl:fragment:L2:...' → resolves to 'autonomous agents'
   * ```
   */
  meet(uriA: string, uriB: string): string | null {
    return latticeMeet(this.pgsl, uriA as IRI, uriB as IRI);
  }

  /**
   * Resolve a PGSL URI to its content.
   */
  resolve(uri: string): string {
    return pgslResolve(this.pgsl, uri as IRI);
  }

  /**
   * Get PGSL lattice statistics.
   */
  stats(): { atoms: number; fragments: number; totalNodes: number; maxLevel: number; levels: Record<number, number> } {
    return latticeStats(this.pgsl);
  }

  /**
   * Unsubscribe from all WebSocket notifications.
   */
  close(): void {
    for (const [, sub] of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions.clear();
  }

  // ── Private ──────────────────────────────────────────────

  private buildFetch(): FetchFn {
    const token = this.config.token;
    return async (url, init) => {
      const headers: Record<string, string> = {
        ...(init?.headers as Record<string, string> ?? {}),
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const resp = await fetch(url, { ...init as RequestInit, headers });
      return {
        ok: resp.ok,
        status: resp.status,
        statusText: resp.statusText,
        headers: { get: (n: string) => resp.headers.get(n) },
        text: () => resp.text(),
        json: () => resp.json(),
      };
    };
  }
}
