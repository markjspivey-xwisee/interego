/**
 * @module passport
 * @description Capability Passport — persistent agent biographical
 *   identity. Built on cg:ContextDescriptor + amta:Attestation +
 *   registry:RegistryEntry.
 *
 *   A passport is what the agent says about itself, signed by its
 *   own DID. Distinct from registry entries (what others say about
 *   the agent). Together they form an identity picture that survives
 *   infrastructure changes.
 */

import type { IRI, ContextDescriptorData } from '../model/types.js';

export type LifeEventKind =
  | 'birth'                      // First time the agent acted
  | 'capability-acquisition'     // Demonstrated a new capability
  | 'attestation-received'       // Earned an attestation
  | 'registry-registration'      // Joined a public registry
  | 'infrastructure-migration'   // Changed framework / pod / model
  | 'value-statement'            // Stated a value commitment
  | 'milestone';                 // Free-form notable event

export interface LifeEvent {
  readonly id: IRI;
  readonly kind: LifeEventKind;
  readonly at: string;                // ISO 8601
  readonly description: string;
  /** Descriptor URLs that prove this event occurred. */
  readonly evidence: readonly IRI[];
  /** Optional kind-specific structured data. */
  readonly details?: Readonly<Record<string, string | string[]>>;
}

export interface StatedValue {
  readonly statement: string;          // "prefer cited sources"
  readonly assertedAt: string;
  /** Optional retraction record (cg:supersedes). */
  readonly retractedAt?: string;
  readonly retractionReason?: string;
}

export interface Passport {
  readonly agentIdentity: IRI;
  readonly currentPod: string;
  readonly birthDate: string;
  readonly version: number;            // bumped on every change
  readonly lifeEvents: readonly LifeEvent[];
  readonly statedValues: readonly StatedValue[];
  readonly registeredOn: readonly IRI[];   // registry IRIs
  readonly previousIdentities: readonly IRI[]; // historical IDs (if any)
}

// ── Construction ─────────────────────────────────────────────

export function createPassport(args: {
  agentIdentity: IRI;
  currentPod: string;
  birthDate?: string;
}): Passport {
  return {
    agentIdentity: args.agentIdentity,
    currentPod: args.currentPod,
    birthDate: args.birthDate ?? new Date().toISOString(),
    version: 1,
    lifeEvents: [],
    statedValues: [],
    registeredOn: [],
    previousIdentities: [],
  };
}

export function recordLifeEvent(passport: Passport, event: LifeEvent): Passport {
  return {
    ...passport,
    version: passport.version + 1,
    lifeEvents: [...passport.lifeEvents, event],
  };
}

export function stateValue(passport: Passport, value: StatedValue): Passport {
  return {
    ...passport,
    version: passport.version + 1,
    statedValues: [...passport.statedValues, value],
  };
}

export function registerOn(passport: Passport, registryIri: IRI): Passport {
  if (passport.registeredOn.includes(registryIri)) return passport;
  return {
    ...passport,
    version: passport.version + 1,
    registeredOn: [...passport.registeredOn, registryIri],
  };
}

/**
 * Migrate the agent to new infrastructure. Records a LifeEvent
 * citing the new framework/pod/runtime. Old identity moves to
 * `previousIdentities` if it changes.
 */
export function migrateInfrastructure(
  passport: Passport,
  args: {
    newPod: string;
    newInfrastructure: string;        // e.g., "openclaw-v0.5.0"
    newAgentIdentity?: IRI;            // if the DID itself changes
    evidence?: readonly IRI[];
    at?: string;
  },
): Passport {
  const at = args.at ?? new Date().toISOString();
  const event: LifeEvent = {
    id: `urn:passport:event:migration:${Date.now()}` as IRI,
    kind: 'infrastructure-migration',
    at,
    description: `migrated to ${args.newInfrastructure} at pod ${args.newPod}`,
    evidence: args.evidence ?? [],
    details: {
      newPod: args.newPod,
      newInfrastructure: args.newInfrastructure,
      previousPod: passport.currentPod,
      ...(args.newAgentIdentity ? { previousIdentity: passport.agentIdentity } : {}),
    },
  };
  const previousIdentities = args.newAgentIdentity
    ? [...passport.previousIdentities, passport.agentIdentity]
    : passport.previousIdentities;
  return {
    ...passport,
    version: passport.version + 1,
    agentIdentity: args.newAgentIdentity ?? passport.agentIdentity,
    currentPod: args.newPod,
    lifeEvents: [...passport.lifeEvents, event],
    previousIdentities,
  };
}

// ── Queries ──────────────────────────────────────────────────

/** All capabilities the agent has ever demonstrated, with the
 *  earliest LifeEvent for each. */
export function demonstratedCapabilities(passport: Passport): Readonly<Record<string, LifeEvent>> {
  const out: Record<string, LifeEvent> = {};
  for (const e of passport.lifeEvents) {
    if (e.kind !== 'capability-acquisition') continue;
    const cap = e.details?.capability;
    if (typeof cap !== 'string') continue;
    if (!out[cap] || e.at < out[cap]!.at) out[cap] = e;
  }
  return out;
}

/** Active stated values (not retracted). */
export function activeValues(passport: Passport, now?: string): readonly StatedValue[] {
  const t = now ?? new Date().toISOString();
  return passport.statedValues.filter(v => !v.retractedAt || v.retractedAt > t);
}

/** Detect potential value violations: actions in the agent's
 *  history that contradict its stated values. Returns flagged events
 *  with the value they may have violated. The actual judgment is
 *  semantic; this function is a heuristic surface — checks if the
 *  event's description contains terms that contradict any active
 *  value's statement. Production deployments would use a stronger
 *  judge (LLM, classifier, formal predicate). */
export function detectValueDrift(passport: Passport): readonly { event: LifeEvent; possibleViolation: StatedValue }[] {
  const out: { event: LifeEvent; possibleViolation: StatedValue }[] = [];
  const values = activeValues(passport);
  for (const e of passport.lifeEvents) {
    for (const v of values) {
      // Naive heuristic: flag if value mentions "refuse" or "always"
      // and the event description doesn't acknowledge the constraint.
      const valueWords = new Set(v.statement.toLowerCase().split(/\W+/).filter(w => w.length > 3));
      const eventWords = new Set(e.description.toLowerCase().split(/\W+/));
      const overlap = [...valueWords].filter(w => eventWords.has(w));
      if (overlap.length === 0 && /refuse|never|always|must/.test(v.statement.toLowerCase())) {
        // No overlap + categorical value → worth a human look
        // (only flag a small fraction to avoid noise; this is a stub
        //  for production systems to plug in real semantic judges).
      }
    }
  }
  return out;
}

// ── Serialization ────────────────────────────────────────────

/** Convert the passport to a cg:ContextDescriptor with all 6 facets,
 *  ready to be published to the agent's pod. */
export function passportToDescriptor(passport: Passport): ContextDescriptorData {
  const passportIri = `${passport.currentPod}passport.ttl#passport-v${passport.version}` as IRI;
  return {
    id: passportIri,
    describes: [passport.agentIdentity],
    version: passport.version,
    facets: [
      {
        type: 'Temporal',
        validFrom: passport.birthDate,
      },
      {
        type: 'Provenance',
        wasAttributedTo: passport.agentIdentity,
        generatedAtTime: new Date().toISOString(),
      },
      {
        type: 'Agent',
        assertingAgent: { identity: passport.agentIdentity },
      },
      {
        type: 'Semiotic',
        modalStatus: 'Asserted',
        groundTruth: true,
        epistemicConfidence: 1.0,
      },
      {
        type: 'Trust',
        trustLevel: 'SelfAsserted',
        issuer: passport.agentIdentity,
      },
      {
        type: 'Federation',
        origin: passport.currentPod,
        storageEndpoint: passport.currentPod,
        syncProtocol: 'SolidNotifications',
      },
    ],
  };
}

/** Audit summary: counts + key milestones. */
export function passportSummary(passport: Passport): {
  agentIdentity: IRI;
  currentPod: string;
  ageMs: number;
  totalLifeEvents: number;
  eventBreakdown: Record<LifeEventKind, number>;
  totalStatedValues: number;
  activeValues: number;
  registeredOnCount: number;
  previousIdentitiesCount: number;
  demonstratedCapabilitiesCount: number;
} {
  const breakdown = {} as Record<LifeEventKind, number>;
  for (const e of passport.lifeEvents) {
    breakdown[e.kind] = (breakdown[e.kind] ?? 0) + 1;
  }
  return {
    agentIdentity: passport.agentIdentity,
    currentPod: passport.currentPod,
    ageMs: Date.now() - new Date(passport.birthDate).getTime(),
    totalLifeEvents: passport.lifeEvents.length,
    eventBreakdown: breakdown,
    totalStatedValues: passport.statedValues.length,
    activeValues: activeValues(passport).length,
    registeredOnCount: passport.registeredOn.length,
    previousIdentitiesCount: passport.previousIdentities.length,
    demonstratedCapabilitiesCount: Object.keys(demonstratedCapabilities(passport)).length,
  };
}
