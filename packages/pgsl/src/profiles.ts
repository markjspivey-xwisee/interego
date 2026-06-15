/**
 * @module pgsl/profiles
 * @description Ingestion profiles for domain-specific data formats.
 *
 * PGSL is the substrate — format-agnostic, content-addressed.
 * Ingestion profiles define how domain-specific data maps onto
 * the PGSL lattice, preserving domain semantics as structural
 * nesting in the lattice.
 *
 * Each profile:
 *   1. Parses raw domain data (JSON, RDF, etc.)
 *   2. Transforms it into a structured representation
 *   3. Ingests via embedInPGSL with 'structured' granularity
 *
 * The structured representation preserves domain groupings as
 * nested PGSL fragments. Inner structures become atoms at the
 * outer level — their content is content-addressed and reused
 * across statements that share the same sub-structure.
 *
 * Built-in (domain-neutral) profiles:
 *   rdf    — subject/predicate/object triple structure
 *   raw    — flat word tokenization (default, no structure)
 *
 * Vertical/domain profiles register themselves via registerProfile() — e.g.
 * Foxxi's xAPI + IEEE-LERS profiles live in the Foxxi vertical, not here, so the
 * substrate stays format-agnostic. Users can register custom profiles for any
 * domain the same way.
 */

import type { IRI } from '@interego/core';
import type { PGSLInstance, NodeProvenance } from './types.js';
import { embedInPGSL } from './geometric.js';

// ── Profile Interface ──────────────────────────────────────

export interface IngestionProfile {
  /** Profile name (e.g., 'xapi', 'lers', 'rdf') */
  readonly name: string;
  /** Human-readable description */
  readonly description: string;
  /**
   * Transform raw input into a structured string for PGSL ingestion.
   * Returns a string in nested paren notation: ((a,b),(c,d))
   * that embedInPGSL with 'structured' granularity will recursively ingest.
   */
  transform(input: unknown): string;
  /**
   * Optional: return multiple chains for richer structure.
   * Each chain is a space-separated sequence of atoms ingested at 'word' granularity.
   * Preferred over transform() when multiple independent chains are needed
   * (e.g., identity bindings, name chains, result properties).
   */
  transformMulti?(input: unknown): string[];
}

// ── Profile Registry ───────────────────────────────────────

const profileRegistry = new Map<string, IngestionProfile>();

export function registerProfile(profile: IngestionProfile): void {
  profileRegistry.set(profile.name, profile);
}

export function getProfile(name: string): IngestionProfile | undefined {
  return profileRegistry.get(name);
}

export function listProfiles(): string[] {
  return [...profileRegistry.keys()];
}

/**
 * Ingest data using a named profile.
 * Transforms via the profile, then ingests with structured tokenization.
 */
export function ingestWithProfile(
  pgsl: PGSLInstance,
  profileName: string,
  input: unknown,
  _provenance?: NodeProvenance,
): IRI {
  const profile = profileRegistry.get(profileName);
  if (!profile) throw new Error(`Unknown ingestion profile: ${profileName}`);

  // Prefer transformMulti when available — produces multiple independent chains
  if (profile.transformMulti) {
    const chains = profile.transformMulti(input);
    let topUri: IRI | undefined;
    for (const chain of chains) {
      topUri = embedInPGSL(pgsl, chain, undefined, 'word');
    }
    return topUri!;
  }

  const structured = profile.transform(input);
  return embedInPGSL(pgsl, structured, undefined, 'structured');
}

// ── xAPI + IEEE-LERS Profiles — MOVED OUT OF THE SUBSTRATE ──
//
// xAPI and IEEE-LERS are Foxxi-VERTICAL data shapes, not foundation primitives,
// so their ingestion profiles now live in the vertical and register themselves
// onto this registry via registerProfile(). See
// applications/foxxi-content-intelligence/src/pgsl-ingestion-profiles.ts
// (registerFoxxiIngestionProfiles). The substrate keeps only the format-agnostic
// `rdf` + `raw` profiles below, plus the profile framework above.

// ── RDF Triple Profile ─────────────────────────────────────

export interface RdfTriple {
  subject: string;
  predicate: string;
  object: string;
}

/**
 * RDF triple ingestion profile.
 *
 * Transforms an RDF triple into structured PGSL notation:
 *   ((subject words), (predicate words), (object words))
 *
 * Each component is a nested fragment. The predicate "is_a" shared
 * across triples becomes a single content-addressed atom.
 */
const rdfProfile: IngestionProfile = {
  name: 'rdf',
  description: 'RDF triple: subject/predicate/object structure',

  transform(input: unknown): string {
    const triple = input as RdfTriple;

    // Extract local names from URIs
    const localName = (uri: string) => {
      const parts = uri.split(/[#/]/).pop() ?? uri;
      return parts.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    };

    const s = localName(triple.subject).split(/\s+/).join(',');
    const p = localName(triple.predicate).split(/\s+/).join(',');
    const o = localName(triple.object).split(/\s+/).join(',');

    return `((${s}),(${p}),(${o}))`;
  },
};

// ── Raw Profile (default) ──────────────────────────────────

const rawProfile: IngestionProfile = {
  name: 'raw',
  description: 'Raw text: flat word tokenization, no structural nesting',

  transform(input: unknown): string {
    return String(input);
  },
};

// ── Register Built-in Profiles ─────────────────────────────
// Only the domain-neutral profiles are built in. Vertical profiles (xapi, lers)
// are registered by their vertical (Foxxi) — see registerFoxxiIngestionProfiles.

registerProfile(rdfProfile);
registerProfile(rawProfile);

// ── Convenience: batch ingest ──────────────────────────────

/**
 * Ingest multiple items using the same profile.
 * Returns URIs for all ingested items.
 */
export function batchIngestWithProfile(
  pgsl: PGSLInstance,
  profileName: string,
  inputs: unknown[],
): IRI[] {
  return inputs.map(input => ingestWithProfile(pgsl, profileName, input));
}
