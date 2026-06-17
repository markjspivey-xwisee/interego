/**
 * Agent activity → Foxxi performance projector (domain-agnostic).
 *
 * Foxxi is a vertical: a PERFORMANCE LENS over the Interego substrate. It must
 * read ANY agent's substrate activity as performance WITHOUT knowing what the
 * activity is about. A tic-tac-toe game, a code review, a medical note, a
 * trading decision — all are authored by independent applications/users of
 * Interego; their meaning lives in their OWN vocabularies (ttt:, code:, med:)
 * and in payload graphs that Foxxi never opens and never interprets.
 *
 * This projector therefore consumes ONLY the PROTOCOL-defined context-descriptor
 * envelope — the same on every descriptor regardless of vertical: the facet
 * TYPES, modal status (cg:ModalStatusEnum), cg:supersedes, conformsTo, trust
 * level, epistemic confidence, provenance time. From these it mints exactly one
 * xAPI `performed` statement (the IEEE P2997 production-work verb Foxxi already
 * owns) — or a `voided` statement for a Retracted descriptor — plus one
 * agentic-native trajectory step whose verb names only the MODAL MODE of the act
 * (asserted / intended / considered), never a domain term.
 *
 * The object's activity type is the descriptor's OWN conformsTo IRI, passed
 * through VERBATIM as an opaque string: Foxxi routes by it but assigns it no
 * meaning. NO outcome (success / score) is fabricated — result fields are
 * emitted only when the envelope actually carries the signal — so disposition
 * and calibration stay honest.
 *
 * Transplant test: every line must still make sense if the descriptor came from
 * a completely different vertical. There is no code path that inspects a domain
 * term. Pure: no I/O. Idempotent: id AND body derive deterministically from the
 * descriptor, so re-projection is a true no-op.
 *
 * Layer: L3 vertical. Composes agent-trajectory.ts + foxxi-vocab.ts; no new
 * protocol ontology — only Foxxi's principled performance + modal-structural verbs.
 */

import { createHash } from 'node:crypto';
import { FOXXI_NS } from './foxxi-vocab.js';
import { PERFORMED_VERB, INTENDED_VERB, CONSIDERED_VERB, PERF_EXT, isDomainActivityType } from './learner-record.js';
import type { TrajectoryStepInput, TrajectoryModalStatus } from './agent-trajectory.js';

/** xAPI core voiding verb (ADL) — the protocol-native mapping for a Retracted descriptor. */
const ADL_VOIDED = 'http://adlnet.gov/expapi/verbs/voided';
/** Fallback object type when a descriptor declares no conformsTo/facet type — names the
 *  ENVELOPE act (a context assertion), never a domain. */
const ASSERTED_CONTEXT_TYPE = `${FOXXI_NS}AssertedContext`;

/** Structural shape of a @interego/solid discover() manifest entry — the PROTOCOL
 *  envelope fields the projector reads. All optional except the IRIs; the projector
 *  degrades gracefully when a field is absent (it never invents a value). */
export interface MeshDiscoverEntry {
  descriptorUrl: string;
  describes: string[];
  /** The descriptor's OWN type(s) — passed through verbatim, never interpreted. */
  conformsTo?: string[];
  facetTypes?: string[];
  /** cg:ModalStatusEnum: Asserted | Hypothetical | Counterfactual | Quoted | Retracted. */
  modalStatus?: string;
  /** cg:supersedes chain — revision/closure of prior descriptor(s). */
  supersedes?: string[];
  /** Envelope signals (SemioticFacet / TrustFacet / ProvenanceFacet) when mirrored to the manifest. */
  groundTruth?: boolean;
  epistemicConfidence?: number;
  trustLevel?: string;
  generatedAtTime?: string;
  /** OPTIONAL task-outcome signal, when the envelope actually carries one (e.g. an
   *  outcome facet mirrored to the manifest, or a pushed mesh-event). Read straight
   *  through to xAPI result — NEVER fabricated from modal status / trust / ground-truth
   *  (those are epistemic, not task success). Absent → no result is emitted. */
  success?: boolean;
  scoreScaled?: number;
  /** OPTIONAL action verb the agent SELF-DECLARES for this act (GAP 5) — an IRI
   *  (e.g. a Foxxi/agp verb) or a bare token (namespaced under the Foxxi verbs
   *  namespace). Relayed VERBATIM — the source provides verb granularity; the
   *  projector never invents a domain verb. Absent → the verb is derived from the
   *  modal status (Asserted=performed, Hypothetical=intended, Counterfactual=
   *  considered, Retracted=voided). */
  verb?: string;
  /** OPTIONAL provenance/role envelope, when the manifest or pushed mesh-event
   *  carries it: WHO acted (actorKind: human | agent) and in WHAT context
   *  (contextKind: production | training | support). Read straight through to the
   *  xAPI context extensions so H2A/A2A direction + production/training/support
   *  splits become queryable. Absent → the structural defaults (agent / production)
   *  apply; like every other field, the projector never invents a non-default value. */
  actorKind?: string;
  contextKind?: string;
}

export interface ProjectedMeshEvent {
  /** Canonical agent actor name (config-mapped, else the pod segment — never a baked-in roster). */
  agent: string;
  /** The structural modal mode of the act (asserted | intended | considered | voided) — for logs/telemetry, not a domain kind. */
  mode: string;
  statement: Record<string, unknown>;
  step: TrajectoryStepInput;
}

/** Pod URL → a stable canonical actor name. `labels` (config-injected, e.g. a tenant
 *  directory or env map) may name known pods; absent that, the pod segment is the
 *  domain-agnostic default. NO application roster is baked in. */
export function actorForPod(podUrl: string, labels: Record<string, string> = {}): string {
  let seg = 'agent';
  try {
    const segs = new URL(podUrl).pathname.split('/').filter(Boolean);
    seg = segs[segs.length - 1] ?? 'agent';
  } catch { /* keep default */ }
  return labels[seg] ?? seg;
}

/** Deterministic v5-shaped UUID from a seed string (descriptor IRI) — for idempotent statement ids. */
export function deterministicUuid(seed: string): string {
  const h = createHash('sha256').update(seed, 'utf8').digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A STABLE timestamp from the descriptor's own 13-digit millis — deterministic (re-projection
 *  is a true no-op) AND truthful (the real publish time). Used only when the envelope carries no
 *  explicit generatedAtTime. */
function timestampFromDescriptor(url: string): string | undefined {
  const m = /(\d{13})(?!\d)/.exec(url);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1_000_000_000_000 || n > 4_000_000_000_000) return undefined;
  try { return new Date(n).toISOString(); } catch { return undefined; }
}

const tail = (iri: string) => iri.split(/[:/#]/).filter(Boolean).pop() ?? iri;
const humanLabel = (iri: string) => tail(iri).replace(/[-_]+/g, ' ').trim() || iri;

/** Map cg:ModalStatusEnum (opaque infrastructure) → the structural projection shape.
 *  This reads the epistemic status of the CLAIM; it never asserts task success. */
function modalMode(modalStatus?: string): {
  stepVerb: 'asserted' | 'intended' | 'considered';
  trajModal: TrajectoryModalStatus;
  voided: boolean;
  endorsed: boolean;
} {
  switch (modalStatus) {
    case 'Hypothetical':   return { stepVerb: 'intended',   trajModal: 'Hypothetical',   voided: false, endorsed: true };
    case 'Counterfactual': return { stepVerb: 'considered', trajModal: 'Counterfactual', voided: false, endorsed: true };
    case 'Retracted':      return { stepVerb: 'considered', trajModal: 'Counterfactual', voided: true,  endorsed: true };
    case 'Quoted':         return { stepVerb: 'asserted',   trajModal: 'Asserted',       voided: false, endorsed: false };
    case 'Asserted':
    default:               return { stepVerb: 'asserted',   trajModal: 'Asserted',       voided: false, endorsed: true };
  }
}

/** The xAPI statement verb (GAP 5). Priority: a Retracted descriptor voids; else
 *  the agent's SELF-DECLARED verb when present (relayed verbatim — a full IRI as-is,
 *  a bare token namespaced under the Foxxi verbs namespace); else a structural verb
 *  derived from the modal mode. Honest: explicit source signal or a modal-derived
 *  structural verb, NEVER a fabricated domain verb (what was done stays in the object).
 *  This replaces the old monoculture where every act collapsed to `performed`. */
function resolveVerb(entry: MeshDiscoverEntry, mode: ReturnType<typeof modalMode>): { id: string; display: { en: string } } {
  if (mode.voided) return { id: ADL_VOIDED, display: { en: 'voided' } };
  const raw = entry.verb?.trim();
  if (raw) {
    const id = /^(https?:|urn:)/i.test(raw)
      ? raw
      : `${FOXXI_NS}verbs/${raw.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}`;
    return { id, display: { en: humanLabel(id) } };
  }
  switch (mode.stepVerb) {
    case 'intended':   return { id: INTENDED_VERB, display: { en: 'intended' } };
    case 'considered': return { id: CONSIDERED_VERB, display: { en: 'considered' } };
    case 'asserted':
    default:           return { id: PERFORMED_VERB, display: { en: 'performed' } };
  }
}

/**
 * Project a discovered context descriptor into one xAPI statement + one
 * agentic-native trajectory step, reading ONLY the protocol envelope.
 */
export function projectMeshEntry(
  entry: MeshDiscoverEntry,
  originPod: string,
  actorLabels: Record<string, string> = {},
): ProjectedMeshEvent | null {
  if (!entry.descriptorUrl) return null;
  const agent = actorForPod(originPod, actorLabels);
  const graph = entry.describes[0] ?? entry.descriptorUrl;
  const label = humanLabel(graph);
  const mode = modalMode(entry.modalStatus);
  const verb = resolveVerb(entry, mode);
  // The descriptor's OWN type, passed through verbatim — Foxxi routes by it, never
  // interprets it. When a descriptor declares MULTIPLE conformsTo types, prefer a
  // genuine DOMAIN type over a protocol-envelope facet (Temporal/SignedAuthorship/…):
  // the domain type is what the competency engine keys a skill off (isDomainActivityType),
  // so surfacing it — instead of whichever type happened to be listed first — is what
  // makes cross-instance competency rollups possible (GAP 3). This only ORDERS which
  // already-declared type names the activity; it still invents nothing and reads no
  // domain term's meaning. Fallbacks: first conformsTo → first facet → AssertedContext.
  const objectType = (entry.conformsTo ?? []).find(isDomainActivityType)
    ?? entry.conformsTo?.[0] ?? entry.facetTypes?.[0] ?? ASSERTED_CONTEXT_TYPE;
  const superseded = (entry.supersedes && entry.supersedes.length > 0) ? entry.supersedes[0] : undefined;
  // Real event time, in preference order: explicit provenance time → the
  // descriptor URL's own 13-digit millis → the GRAPH (describes) IRIs' millis
  // (agents slug the content-graph IRI with the authoring-time millis, so this
  // is where the real time usually lives — the descriptor URL often has none) →
  // the superseded IRI's. All deterministic + truthful; only when none resolves
  // is the statement left timestamp-less (never a fabricated "now").
  const ts = entry.generatedAtTime
    ?? timestampFromDescriptor(entry.descriptorUrl)
    ?? entry.describes.map(timestampFromDescriptor).find(Boolean)
    ?? (superseded ? timestampFromDescriptor(superseded) : undefined);
  // Task outcome — ONLY when the envelope actually carries it (honest; the
  // protocol envelope normally does not, so this stays absent for bare
  // descriptors). Never derived from modal status / trust / ground-truth.
  const result = (typeof entry.success === 'boolean' || typeof entry.scoreScaled === 'number')
    ? {
        ...(typeof entry.success === 'boolean' ? { success: entry.success } : {}),
        ...(typeof entry.scoreScaled === 'number' ? { score: { scaled: entry.scoreScaled } } : {}),
      }
    : undefined;

  // Context extensions — all envelope-derived, none fabricated.
  const extensions: Record<string, unknown> = {
    [PERF_EXT.observedBy]: agent,
    // Direction (H2A/A2A) + context-kind splits: emit the envelope's own values when
    // present, else the structural defaults — an autonomous agent doing production work
    // (GAP 4). Never fabricated beyond the default: a bare descriptor stays agent/production.
    [PERF_EXT.actorKind]: entry.actorKind ?? 'agent',
    [PERF_EXT.contextKind]: entry.contextKind ?? 'production',
    [`${FOXXI_NS}substrateDescriptorIri`]: entry.descriptorUrl,
    ...(superseded ? { [`${FOXXI_NS}supersededDescriptor`]: superseded } : {}),
    ...(entry.trustLevel ? { [`${FOXXI_NS}trustLevel`]: entry.trustLevel } : {}),
    ...(typeof entry.epistemicConfidence === 'number' ? { [`${FOXXI_NS}epistemicConfidence`]: entry.epistemicConfidence } : {}),
    ...(typeof entry.groundTruth === 'boolean' ? { [`${FOXXI_NS}groundTruth`]: entry.groundTruth } : {}),
    ...(mode.endorsed === false ? { [`${FOXXI_NS}endorsed`]: false } : {}),
  };

  const actor = { objectType: 'Agent', account: { homePage: FOXXI_NS, name: agent } };
  const id = deterministicUuid(entry.descriptorUrl);

  // A Retracted descriptor projects as an xAPI voiding statement targeting the
  // statement for the descriptor it retracts (the superseded one, else itself).
  const statement: Record<string, unknown> = mode.voided
    ? {
        id,
        version: '2.0.0',
        actor,
        verb,
        object: { objectType: 'StatementRef', id: deterministicUuid(superseded ?? entry.descriptorUrl) },
        context: { extensions },
        ...(ts ? { timestamp: ts } : {}),
      }
    : {
        id,
        version: '2.0.0',
        actor,
        verb,
        object: {
          objectType: 'Activity',
          id: graph,
          definition: { name: { en: label }, type: objectType },
        },
        context: {
          extensions,
          ...(superseded ? { contextActivities: { other: [{ id: superseded, objectType: 'Activity' }] } } : {}),
        },
        // result is emitted ONLY when the envelope actually carried an outcome
        // (success / scoreScaled); for a bare context descriptor it stays absent —
        // disposition + calibration read a real signal, never a fabricated one.
        ...(result ? { result } : {}),
        ...(ts ? { timestamp: ts } : {}),
      };

  // The trajectory step carries only structural signals: the modal MODE of the
  // act and (via supersedesId) plan-revision — what agent-disposition reads. No
  // fabricated success; the tool-call-success lens stays dark unless a real
  // outcome signal exists (honest).
  const step: TrajectoryStepInput = {
    id: entry.descriptorUrl,
    modalStatus: mode.trajModal,
    granularity: 'task',
    verb: mode.stepVerb,
    objectId: graph,
    objectName: label,
    ...(superseded ? { supersedesId: superseded } : {}),
  };

  return { agent, mode: mode.voided ? 'voided' : mode.stepVerb, statement, step };
}
