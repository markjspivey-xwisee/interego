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
 * Profiles:
 *   xapi   — actor/verb/object/result/context nesting
 *   lers   — issuer/subject/achievement/evidence nesting
 *   rdf    — subject/predicate/object triple structure
 *   raw    — flat word tokenization (default, no structure)
 *
 * Users can register custom profiles for their domains.
 */

import type { IRI } from '../model/types.js';
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

// ── xAPI Profile ───────────────────────────────────────────

export interface XapiStatement {
  actor: { name?: string; mbox?: string; openid?: string; account?: { name: string; homePage: string } };
  verb: { id: string; display?: Record<string, string> };
  object: { id: string; objectType?: string; definition?: { name?: Record<string, string>; type?: string } };
  result?: { score?: { scaled?: number; raw?: number; min?: number; max?: number }; success?: boolean; duration?: string; completion?: boolean; response?: string };
  timestamp?: string;
  context?: { platform?: string; instructor?: { name?: string; mbox?: string }; registration?: string; extensions?: Record<string, unknown> };
}

/**
 * xAPI ingestion profile — PGSL native architecture.
 *
 * Atoms are SHORT, MEANINGFUL, LOCALLY UNIQUE identifiers:
 *   - Actor = short name derived from IFI (e.g., `chen`)
 *   - Verb = last segment of IRI (e.g., `completed`)
 *   - Object = last segment of activity ID (e.g., `ils-approach-rwy-28L`)
 *
 * Global URIs are connected via `identity` chains — not used as atom values.
 * Display names are connected via `name` chains — not used as atom values.
 * Results are property chains off the actor-object pair.
 *
 * Produces multiple chains per statement:
 *   (chen, completed, ils-approach-rwy-28L)          ← core statement
 *   (chen, identity, did:web:learner.airforce.mil:chen.sarah)  ← IFI binding
 *   (chen, name, Sarah)                               ← display name
 *   (completed, identity, http://adlnet.gov/expapi/verbs/completed)  ← verb IRI
 *   (ils-approach-rwy-28L, name, ILS Approach Rwy 28L)  ← activity display
 *   (chen, ils-approach-rwy-28L, score, 92)           ← result property
 *
 * Content-addressing: same actor across statements = same atom.
 * Same verb across actors = same atom. The atom `completed` is shared
 * across all learners who completed anything.
 */
const xapiProfile: IngestionProfile = {
  name: 'xapi',
  description: 'xAPI statement: short atom IDs with identity/name/result chains',

  // Legacy transform — kept for backward compatibility
  transform(input: unknown): string {
    const stmt = input as XapiStatement;

    // Derive short IDs using the same logic as transformMulti
    const actorId = deriveActorId(stmt);
    const verbId = stmt.verb.id.split('/').pop() ?? 'unknown';
    const objectId = stmt.object.id.split(/[/:]/).pop() ?? 'unknown';

    const parts = [actorId, verbId, objectId];

    if (stmt.result) {
      const resultParts: string[] = [];
      if (stmt.result.score?.raw !== undefined) resultParts.push(`score:${stmt.result.score.raw}`);
      if (stmt.result.score?.max !== undefined) resultParts.push(`max:${stmt.result.score.max}`);
      if (stmt.result.success !== undefined) resultParts.push(`success:${stmt.result.success}`);
      if (stmt.result.duration) resultParts.push(`duration:${stmt.result.duration}`);
      if (resultParts.length > 0) parts.push(`(${resultParts.join(',')})`);
    }

    return `(${parts.join(',')})`;
  },

  transformMulti(input: unknown): string[] {
    const stmt = input as XapiStatement;
    const chains: string[] = [];

    // Derive short actor ID from IFI
    const actorId = deriveActorId(stmt);

    // Derive short verb from IRI
    const verbId = stmt.verb.id.split('/').pop() ?? 'unknown';

    // Derive short object ID from IRI
    const objectId = stmt.object.id.split(/[/:]/).pop() ?? 'unknown';

    // Core statement
    chains.push(`${actorId} ${verbId} ${objectId}`);

    // Identity bindings (only if IFI available)
    if (stmt.actor.account) {
      chains.push(`${actorId} identity ${stmt.actor.account.homePage}:${stmt.actor.account.name}`);
    } else if (stmt.actor.mbox) {
      chains.push(`${actorId} identity ${stmt.actor.mbox}`);
    } else if (stmt.actor.openid) {
      chains.push(`${actorId} identity ${stmt.actor.openid}`);
    }

    // Display names
    if (stmt.actor.name) {
      for (const part of stmt.actor.name.split(/\s+/)) {
        chains.push(`${actorId} name ${part}`);
      }
    }

    // Verb identity
    chains.push(`${verbId} identity ${stmt.verb.id}`);

    // Verb display
    const verbDisplay = stmt.verb.display?.['en-US'];
    if (verbDisplay && verbDisplay !== verbId) {
      chains.push(`${verbId} display ${verbDisplay}`);
    }

    // Object identity
    chains.push(`${objectId} identity ${stmt.object.id}`);

    // Object display name
    const objName = stmt.object.definition?.name?.['en-US'];
    if (objName) {
      chains.push(`${objectId} name ${objName}`);
    }

    // Result properties (as chains off actor-object pair)
    if (stmt.result) {
      if (stmt.result.score?.raw !== undefined) {
        chains.push(`${actorId} ${objectId} score ${stmt.result.score.raw}`);
      }
      if (stmt.result.score?.max !== undefined) {
        chains.push(`${actorId} ${objectId} max ${stmt.result.score.max}`);
      }
      if (stmt.result.score?.scaled !== undefined) {
        chains.push(`${actorId} ${objectId} scaled ${stmt.result.score.scaled}`);
      }
      if (stmt.result.success !== undefined) {
        chains.push(`${actorId} ${objectId} success ${stmt.result.success}`);
      }
      if (stmt.result.completion !== undefined) {
        chains.push(`${actorId} ${objectId} completion ${stmt.result.completion}`);
      }
      if (stmt.result.duration) {
        chains.push(`${actorId} ${objectId} duration ${stmt.result.duration}`);
      }
      if (stmt.result.response) {
        chains.push(`${actorId} ${objectId} response ${stmt.result.response}`);
      }
    }

    // Context
    if (stmt.context?.platform) {
      chains.push(`${actorId} ${objectId} platform ${stmt.context.platform}`);
    }
    if (stmt.context?.instructor) {
      const instrId = stmt.context.instructor.mbox
        ? stmt.context.instructor.mbox
        : stmt.context.instructor.name ?? 'unknown';
      chains.push(`${actorId} ${objectId} instructor ${instrId}`);
    }
    if (stmt.context?.registration) {
      chains.push(`${actorId} ${objectId} registration ${stmt.context.registration}`);
    }

    return chains;
  },
};

/** Derive a short, meaningful actor ID from an xAPI statement's IFI */
function deriveActorId(stmt: XapiStatement): string {
  if (stmt.actor.account) {
    return stmt.actor.account.name;
  } else if (stmt.actor.mbox) {
    return stmt.actor.mbox.replace('mailto:', '').split('@')[0]!;
  } else {
    return (stmt.actor.name ?? 'unknown').toLowerCase().split(/\s+/).pop()!;
  }
}

// ── LERS Profile ───────────────────────────────────────────

export interface LersCredential {
  issuer: string;
  subject: { name: string; id?: string };
  achievement: { name: string; level?: string; framework?: string; criteria?: string };
  evidence?: { sources?: string[]; statementCount?: number; averageScore?: number };
  issuanceDate?: string;
  expirationDate?: string;
}

/**
 * IEEE LERS ingestion profile.
 *
 * Transforms a LERS credential into structured PGSL notation:
 *   ((issuer), (subject name), (achievement name, level, framework), (evidence sources))
 *
 * The achievement fragment is content-addressed — two credentials for the
 * same achievement (e.g., "USAF Instrument Rating, Proficient") share
 * the same fragment URI regardless of who earned it.
 */
const lersProfile: IngestionProfile = {
  name: 'lers',
  description: 'IEEE LERS (Learning & Employment Record): issuer/subject/achievement/evidence structure',

  transform(input: unknown): string {
    const cred = input as LersCredential;

    const issuerPart = `(${cred.issuer.split(/[\s/:]+/).filter(s => s.length > 1).join(',')})`;
    const subjectPart = `(${cred.subject.name.split(/\s+/).join(',')})`;

    const achieveParts = [cred.achievement.name];
    if (cred.achievement.level) achieveParts.push(cred.achievement.level);
    if (cred.achievement.framework) achieveParts.push(cred.achievement.framework);
    const achievePart = `(${achieveParts.join(',')})`;

    const parts = [issuerPart, subjectPart, achievePart];

    if (cred.evidence) {
      const evidenceParts: string[] = [];
      if (cred.evidence.statementCount !== undefined) evidenceParts.push(`${cred.evidence.statementCount} statements`);
      if (cred.evidence.averageScore !== undefined) evidenceParts.push(`avg ${cred.evidence.averageScore}`);
      if (evidenceParts.length > 0) {
        parts.push(`(${evidenceParts.join(',')})`);
      }
    }

    return `(${parts.join(',')})`;
  },
};

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

registerProfile(xapiProfile);
registerProfile(lersProfile);
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
