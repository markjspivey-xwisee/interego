/**
 * The format-agnostic codec seam.
 *
 * PGSL is the canonical store; a Codec is how one data model (RDF, YAML,
 * generalized hypergraphs, ...) ingests INTO the lattice and projects back OUT.
 * RDF is the first codec but NOT privileged — anything implementing this
 * interface plugs into the same store, which is the whole point of "RDF is one
 * projection powered by PGSL, not the floor."
 *
 * Every ingest produces TWO things (the design's load-bearing split):
 *   (a) an OPAQUE byte-atom of the EXACT original bytes — this is what a read
 *       returns verbatim, so IRIs, hosts, and SIGNATURES are preserved (a
 *       re-serialization of the structural projection would reorder/normalize
 *       and break signatures); and
 *   (b) an additive STRUCTURAL projection into atoms/fragments — for
 *       query / dedup / cross-holon overlap. Lossy by design; never the source
 *       of byte reconstruction.
 */

import type { StoredNode } from './node.js';

export interface IngestOptions {
  /** Addressing domain for the atoms this ingest mints (default public). */
  sensitivity?: 'public' | 'private';
  tenantKey?: string;
}

export interface IngestResult {
  /** Nodes to persist: the opaque byte-atom + the structural atoms + the top holon. */
  nodes: StoredNode[];
  /** The top holon URI (what an LDP resource's overlay points at). */
  topUri: string;
  /** The opaque byte-atom URI — projectBytes() returns its exact bytes. */
  opaqueUri: string;
  /** The structural atom URIs (the query/dedup/overlap projection). */
  structuralUris: string[];
}

export interface Codec {
  /** The content-type this codec handles (e.g. 'text/turtle'). */
  readonly format: string;
  /** Ingest a representation into lattice nodes (opaque + structural). */
  ingest(bytes: Uint8Array, opts?: IngestOptions): IngestResult;
  /** Reconstruct the EXACT original bytes from the resolved opaque byte-atom. */
  projectBytes(opaqueNode: StoredNode): Uint8Array;
}

export class CodecRegistry {
  private readonly byFormat = new Map<string, Codec>();
  register(codec: Codec): this {
    this.byFormat.set(codec.format, codec);
    return this;
  }
  get(format: string): Codec | undefined {
    return this.byFormat.get(format);
  }
  formats(): string[] {
    return [...this.byFormat.keys()];
  }
}
