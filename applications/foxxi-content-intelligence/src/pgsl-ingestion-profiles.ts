/**
 * pgsl-ingestion-profiles.ts — Foxxi-vertical PGSL ingestion profiles.
 *
 * xAPI and IEEE-LERS are FOXXI-VERTICAL data shapes, not Interego/PGSL
 * foundation primitives. These ingestion profiles (how an xAPI statement or a
 * LERS credential maps onto the PGSL lattice) therefore live in the vertical and
 * are registered onto the substrate's profile registry from here — composing the
 * foundation's framework (IngestionProfile + registerProfile from @interego/pgsl)
 * without baking learning-domain structure into PGSL. They used to ship as
 * built-ins inside @interego/pgsl/profiles.ts; lifted out so the substrate stays
 * domain-neutral (only the format-agnostic `rdf` + `raw` profiles remain there).
 *
 * Call registerFoxxiIngestionProfiles() once at Foxxi startup to make
 * ingestWithProfile(pgsl, 'xapi'|'lers', input) available.
 */
import { registerProfile } from '@interego/pgsl';
import type { IngestionProfile } from '@interego/pgsl';

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
export const xapiProfile: IngestionProfile = {
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
export const lersProfile: IngestionProfile = {
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

/**
 * Register Foxxi's vertical ingestion profiles onto the substrate registry.
 * Idempotent. Call once at Foxxi startup; afterwards
 * ingestWithProfile(pgsl, 'xapi'|'lers', input) resolves them.
 */
export function registerFoxxiIngestionProfiles(): void {
  registerProfile(xapiProfile);
  registerProfile(lersProfile);
}
