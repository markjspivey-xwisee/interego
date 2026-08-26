/**
 * @module affordance/types
 * @description Type definitions for the Affordance Engine.
 *
 * Theoretical foundations:
 *   - Gibson: Affordances are relational (agent × environment)
 *   - Norman: Signifiers communicate affordances; anti-affordances block action
 *   - Pearl: Affordances are interventional queries P(Y|do(X))
 *   - Boyd (OODA): Observe → Orient → Decide → Act with IG&C shortcuts
 *   - Endsley (SA): Perception → Comprehension → Projection
 *   - Bratman (BDI): Beliefs → Desires → Intentions
 *   - Friston: Agents minimize surprise (free energy)
 *   - Stigmergy: Indirect coordination through environment modification
 */

import type { IRI, ContextDescriptorData, TrustLevel } from '../model/types.js';
import type { ContentBinding } from '../model/delegation.js';

// ═════════════════════════════════════════════════════════════
//  Core Affordance Types (Gibson + Norman)
// ═════════════════════════════════════════════════════════════

/**
 * An action an agent can take on a context resource.
 */
export type AffordanceAction =
  | 'read'        // perceive the content
  | 'apply'       // use this context directly in decision-making
  | 'compose'     // merge with local context via union/intersection
  | 'extend'      // grow the pyramid (inner +) — add to existing structure
  | 'beside'      // place beside (outer +) — independent element
  | 'wrap'        // create boundary — turn structure into single element
  | 'cite'        // reference with attribution
  | 'forward'     // share to other agents
  | 'challenge'   // publish a counter-descriptor
  | 'retract'     // mark as no longer valid (owner/delegate only)
  | 'annotate'    // add per-triple annotations
  | 'ingest'      // feed into PGSL lattice
  | 'derive'      // create a new descriptor that supersedes
  | 'intervene'   // perform causal intervention (do-operator)
  | 'project'     // translate via projection/vocabulary mapping
  | 'subscribe'   // watch for changes
  | 'ignore';     // explicitly choose not to act

/**
 * Why an affordance is or isn't available.
 */
export interface AffordanceReason {
  readonly facet: string;           // which facet contributed to this evaluation
  readonly constraint: string;      // what condition was checked
  readonly satisfied: boolean;      // whether the condition was met
  readonly detail?: string;         // human-readable explanation
}

/**
 * A single affordance: an action available (or blocked) for a specific
 * agent-descriptor pair. Gibson's relational property.
 */
export interface Affordance {
  readonly action: AffordanceAction;
  readonly available: boolean;          // true = afforded, false = anti-afforded
  readonly confidence: number;          // 0.0-1.0 — how certain
  readonly reasons: readonly AffordanceReason[];
  readonly causalEffect?: CausalAffordanceEffect;  // Pearl rung 2
}

/**
 * Norman's anti-affordance: an explicit block with explanation.
 */
export interface AntiAffordance {
  readonly action: AffordanceAction;
  readonly blockedBy: string;           // what blocks this action
  readonly reason: string;              // why it's blocked
  readonly overridable: boolean;        // can the agent override with justification?
}

/**
 * The full affordance set for an agent-descriptor pair.
 */
export interface AffordanceSet {
  readonly agent: IRI;
  readonly descriptor: IRI;
  readonly timestamp: string;
  readonly affordances: readonly Affordance[];
  readonly antiAffordances: readonly AntiAffordance[];
  readonly signifiers: readonly Signifier[];
  readonly saLevel: SituationalAwarenessLevel;
}

/**
 * Norman's signifier: a perceivable indicator of an affordance.
 * Facets are signifiers — they communicate what actions are possible.
 */
export interface Signifier {
  readonly facetType: string;
  readonly indicates: AffordanceAction[];
  readonly strength: 'strong' | 'weak' | 'ambiguous';
  readonly detail: string;
}

// ═════════════════════════════════════════════════════════════
//  Agent Profile (Gibson's "effectivities")
// ═════════════════════════════════════════════════════════════

/**
 * An agent's capabilities — Gibson's effectivities.
 * These are properties of the agent that complement environmental
 * affordances to produce actualities.
 */
export interface AgentProfile {
  readonly agentId: IRI;
  readonly ownerWebId?: IRI;
  readonly delegationScope: DelegationScope;
  readonly capabilities: readonly AgentCapability[];
  readonly vocabularies: readonly IRI[];        // ontologies the agent understands
  readonly trustPolicies: readonly TrustPolicy[];
  readonly causalModels: readonly IRI[];        // SCMs the agent has
}

export type DelegationScope = 'ReadWrite' | 'ReadOnly' | 'PublishOnly' | 'DiscoverOnly';

export type AgentCapability =
  | 'discover'      // can fetch manifests
  | 'publish'       // can write descriptors
  | 'compose'       // can run composition operators
  | 'causal'        // has causal reasoning engine
  | 'pgsl'          // has PGSL lattice
  | 'project'       // can do vocabulary translation
  | 'subscribe'     // can hold WebSocket connections
  | 'verify'        // can verify VCs and delegation chains
  | 'challenge'     // can publish counter-descriptors
  | 'retract';      // can retract own descriptors

export interface TrustPolicy {
  readonly minTrustLevel: 'SelfAsserted' | 'ThirdPartyAttested' | 'CryptographicallyVerified';
  readonly minConfidence: number;
  readonly requiredForAction: AffordanceAction[];
  /**
   * If true, a descriptor with no Trust facet at all satisfies this policy's
   * trust-level check. Default false: absence of a trust claim is NOT treated
   * as a positive 'SelfAsserted' assertion and therefore does not pass any
   * minTrustLevel.
   */
  readonly allowMissingTrustFacet?: boolean;
}

// ═════════════════════════════════════════════════════════════
//  Pearl Causal Affordances (Rung 2)
// ═════════════════════════════════════════════════════════════

/**
 * An affordance expressed as an interventional query: P(Y|do(X)).
 * "What would happen if the agent performed this action?"
 */
export interface CausalAffordanceEffect {
  readonly intervention: string;        // do(X = x) description
  readonly expectedOutcome: string;     // predicted Y
  readonly identifiable: boolean;       // can we estimate from observation alone?
  readonly adjustmentSet?: string[];    // backdoor variables if identifiable
  readonly causalConfidence: number;    // confidence in the causal estimate
}

// ═════════════════════════════════════════════════════════════
//  OODA Loop (Boyd)
// ═════════════════════════════════════════════════════════════

export type OODAPhase = 'observe' | 'orient' | 'decide' | 'act';

/**
 * Boyd's Orientation state — the "schwerpunkt."
 * Cached evaluations that enable IG&C (implicit guidance & control).
 */
export interface Orientation {
  readonly trustedSources: ReadonlyMap<IRI, TrustEvaluation>;
  readonly vocabularyCache: ReadonlyMap<IRI, string[]>;  // pod -> known vocabularies
  readonly affordanceCache: ReadonlyMap<string, AffordanceSet>;
  readonly causalModels: ReadonlyMap<IRI, IRI>;    // descriptor -> SCM
  readonly timestamp: string;
  readonly staleness: number;           // seconds since last update
}

/**
 * On what a {@link TrustEvaluation} rests — a fact about the READER, never about the
 * descriptor. Four values because there are four genuinely different situations and the
 * three that are not `'evidence-checked'` are not the same as each other.
 *
 *   no-claim           the descriptor carries no Trust facet. It has declined to make a
 *                      trust claim, which is not the same as positively asserting the
 *                      weakest rung. Checks may still have been run — a descriptor with no
 *                      claim can carry a proof — so this basis can still carry
 *                      {@link TrustEvaluation.evidence}; what it cannot do is warrant a rung,
 *                      because evidence caps a claim and never stands in for one.
 *   unwarranted        the descriptor makes a claim and NOTHING reached this reader to check
 *                      it against. The claim stands on the publisher's word about their own
 *                      bytes. A verifier that ran and crashed lands here too — an attempt is
 *                      not a finding, and reporting it as one is how "we could not check"
 *                      became "we checked and it failed".
 *   evidence-checked   this reader ran checks of its own and the verdict is capped by what
 *                      they support. The cap may still be the weakest rung — "I looked and
 *                      found only self-assertion" is a checked answer, not a failure.
 *   evidence-refuted   a check this reader ran COMPARED TWO THINGS AND THEY DISAGREED: a
 *                      signature that did not verify against the payload it signs, or a
 *                      content digest recomputed over the served bytes that differs from the
 *                      one the signer committed to. Affirmative evidence against, which is
 *                      strictly worse than none. Reserved for exactly that — it warrants no
 *                      rung and refuses even `read`, so anything that lands here by accident
 *                      is a denial of service on honest content.
 */
export type TrustBasis = 'no-claim' | 'unwarranted' | 'evidence-checked' | 'evidence-refuted';

/**
 * What a reader ESTABLISHED FOR ITSELF about a descriptor, by running checks over the bytes
 * it actually parsed.
 *
 * ★★ NOTHING IN THIS TYPE IS EVER READ OUT OF A DESCRIPTOR BODY, and that is the entire
 * point of its existing. The affordance plane's inputs arrive as `ContextDescriptorData`
 * parsed from whatever representation a fetch returned; every field on it, `iep:trustLevel`
 * included, is text the publisher wrote. This type is the other channel — the reader's own
 * findings — and NO RUNG ABOVE `SelfAsserted` IS REACHABLE EXCEPT THROUGH IT. That is the
 * invariant, and it is narrower than the sentence that used to stand here ("the only channel
 * a verdict is allowed to be a function of"), which was never true: a verdict is
 * `min(claim, ceiling)`, so the descriptor's own claim decides too — in the one direction
 * that is safe, downward.
 *
 * ★ THE SUBSTRATE ALREADY PRODUCES THIS, so callers should not hand-assemble it. The relay's
 * `get_descriptor` returns an `authorship` block — `{ authorshipVerified, signedBy,
 * effectiveTrustLevel, contentBinding, descriptorBinding }` — that it derives by re-running
 * `verifySignedAuthorship` over the served bytes and walking the delegation chain.
 * `trustEvidenceFromAuthorship` maps that block onto this type, so the honest path is one
 * call and nobody computes a ceiling by hand.
 */
export interface TrustEvidence {
  /**
   * ★ THE CEILING: the highest rung THIS READER'S OWN CHECKS support, or `'refuted'` when a
   * check compared two things and they disagreed — never merely because a check could not be
   * run, which produces no evidence at all. A verdict is `min(what the descriptor claims,
   * this)` — so
   * evidence can only ever hold a claim DOWN, never lift one up. A reader that establishes
   * more than the descriptor claims does not get to overrule the publisher's own modesty.
   */
  readonly ceiling: TrustLevel | 'refuted';
  /** The signature verdict this ceiling came from, when it came from one. */
  readonly authorshipVerified?: boolean;
  /** Who the verified proof names as signer — the reader's finding, not the body's claim. */
  readonly signedBy?: IRI;
  /**
   * How much the proof says about the CONTENT served beside it.
   *
   * ★ CARRIED, NOT FOLDED INTO THE CEILING, and deliberately so. The relay states the
   * reasoning at the point it emits both: the trust level answers "is the signer a delegate
   * the pod owner vouches for" and the binding answers "is this signature over the bytes in
   * front of you". A descriptor can be `CryptographicallyVerified` and `'unbound'` at once,
   * and that combination is the one a reader most needs told — folding either into the other
   * reproduces exactly the collapse this type exists to undo.
   */
  readonly contentBinding?: ContentBinding;
  /** What ran the checks, for the verdict's note. E.g. 'relay get_descriptor'. */
  readonly checkedBy?: string;
}

/**
 * What a READER is warranted in believing about a descriptor's trust claim.
 *
 * ── ★★ THE DEFECT THIS SHAPE EXISTS TO CLOSE ────────────────────────────────────────────
 *
 * `evaluateTrust` used to return `verified: trust.trustLevel === 'CryptographicallyVerified'`
 * with a 1.0 / 0.85 / 0.7 confidence ladder derived from that same string, and
 * `evaluateTrustPolicy` ranked that same string against `policy.minTrustLevel` by index.
 * Both read `iep:trustLevel` straight off a fetched body. So a publisher who wrote
 * `iep:trustLevel "CryptographicallyVerified"` into their OWN descriptor received
 * `verified: true, confidence: 1.0` and satisfied a policy demanding the strongest rung —
 * from one line of Turtle on a pod they control. A grep of this whole directory for
 * `authorshipProof|authorshipVerified|contentBinding|wasDerivedFrom` returned zero hits: the
 * plane that decided could not see a single piece of evidence.
 *
 * The relay computes that field honestly on its own publish path, gated on a delegation
 * chain that verified. That was never the problem. The problem is that the kernel consumes
 * `ContextDescriptorData` from EVERY ingestion path — `kernelDereference` runs the Turtle
 * extractor over whatever body came back, including another pod's — and an honestly computed
 * level and a typed one are the same six syllables by the time they reach here.
 *
 * ★★ IT IS ONE DEFECT CLASS, NOT ONE BUG: a check that keys on something the adversary
 * writes. The same shape has been found in this codebase as a membership decided by a boolean
 * four read-failures also produce, and as an ACL grant composed from a caller-supplied WebID.
 * Read `Seat.basis` in `@interego/workspace-client` for the enforcement this borrows.
 *
 * ── WHAT EACH FIELD IS FOR ──────────────────────────────────────────────────────────────
 *
 * `trustLevel` is the VERDICT and keeps the name every consumer already reads, so the
 * dangerous read now lands on the honest value. `claimedTrustLevel` is the publisher's text,
 * under a name that says so. Nothing may branch on `claimedTrustLevel`; it is there so a
 * demotion is VISIBLE rather than silent — a reader that shows a "CryptographicallyVerified"
 * badge and then quietly acts at SelfAsserted has replaced one lie with another.
 */
export interface TrustEvaluation {
  readonly source: IRI;
  /**
   * ★ THE WARRANTED LEVEL — never above what {@link basis} supports. `min(claim, ceiling)`.
   * `undefined` means no rung is warranted at all: the descriptor made no claim, made one
   * with no level in it, or carries a proof this reader REFUTED.
   */
  readonly trustLevel: TrustLevel | undefined;
  /**
   * The level the descriptor's Trust facet positively asserted, verbatim. Publisher-authored
   * text. `undefined` means no Trust facet, or a Trust facet carrying no level.
   *
   * ★ NEVER A VERDICT. It is reported so callers can SEE the gap between what was claimed
   * and what was warranted; every decision reads {@link trustLevel}.
   */
  readonly claimedTrustLevel: TrustLevel | undefined;
  /** What the verdict rests on. See {@link TrustBasis}. */
  readonly basis: TrustBasis;
  /**
   * The reader's own findings. Always present when {@link basis} is `'evidence-checked'` or
   * `'evidence-refuted'`; possible on `'no-claim'` (a descriptor can carry a proof and no
   * Trust facet); never present on `'unwarranted'`, where the word means nothing reached
   * this reader.
   */
  readonly evidence?: TrustEvidence;
  /**
   * ★ TRUE ONLY WHEN A READER'S OWN CHECK ESTABLISHED `CryptographicallyVerified`. It is
   * `false` for every unchecked claim no matter how strong the claim's wording, which is the
   * single line that closes the forgery above.
   */
  readonly verified: boolean;
  readonly lastVerified: string;
  readonly confidence: number;
  /**
   * One sentence saying why {@link trustLevel} is what it is — always populated, so a caller
   * rendering a trust badge has the reason to hand without re-deriving it.
   */
  readonly warrantNote: string;
}

/**
 * OODA cycle state for an agent.
 */
export interface OODACycle {
  readonly phase: OODAPhase;
  readonly orientation: Orientation;
  readonly observations: readonly ContextDescriptorData[];
  readonly decisions: readonly CommittedAffordance[];
  readonly actions: readonly CompletedAction[];
  readonly igcAvailable: boolean;       // can skip Decide via cached orientation?
}

export interface CompletedAction {
  readonly action: AffordanceAction;
  readonly target: IRI;
  readonly timestamp: string;
  readonly outcome: 'success' | 'failure' | 'partial';
  readonly environmentChange?: string;  // what changed in the affordance landscape
}

// ═════════════════════════════════════════════════════════════
//  Situational Awareness (Endsley)
// ═════════════════════════════════════════════════════════════

export interface SituationalAwarenessLevel {
  readonly level1_perception: PerceptionState;
  readonly level2_comprehension: ComprehensionState;
  readonly level3_projection: ProjectionState;
}

export interface PerceptionState {
  readonly descriptorsDiscovered: number;
  readonly podsScanned: number;
  readonly facetTypesObserved: string[];
  readonly coverageGaps: string[];      // what we haven't looked at yet
}

export interface ComprehensionState {
  readonly trustEvaluated: number;
  readonly vocabularyMapped: number;
  readonly causalModelsResolved: number;
  readonly conflictsDetected: number;
  readonly coherenceScore: number;      // 0.0-1.0 — how consistent is our understanding?
}

export interface ProjectionState {
  readonly anticipatedChanges: readonly AnticipatedChange[];
  readonly projectedAffordances: readonly Affordance[];
  readonly timeHorizon: string;         // how far ahead we're projecting
  readonly projectionConfidence: number;
}

export interface AnticipatedChange {
  readonly source: IRI;                 // which agent/pod
  readonly expectedAction: AffordanceAction;
  readonly probability: number;
  readonly impact: 'high' | 'medium' | 'low';
}

// ═════════════════════════════════════════════════════════════
//  BDI Agent State (Bratman)
// ═════════════════════════════════════════════════════════════

/**
 * Bratman's BDI: Beliefs, Desires, Intentions.
 */
export interface AgentState {
  readonly beliefs: ReadonlyMap<IRI, BeliefEntry>;
  readonly desires: readonly Desire[];
  readonly intentions: readonly CommittedAffordance[];
  readonly orientation: Orientation;    // Boyd's cached state
}

export interface BeliefEntry {
  readonly descriptor: ContextDescriptorData;
  readonly trustEvaluation: TrustEvaluation;
  readonly surprise: number;            // Friston: how unexpected was this?
  readonly assimilated: boolean;        // has this been integrated into the model?
}

export interface Desire {
  readonly id: string;
  readonly description: string;
  readonly priority: number;            // 0.0-1.0
  readonly satisfiedBy: AffordanceAction[];
  readonly requiredFacets?: string[];   // facets needed to satisfy
}

/**
 * An affordance the agent has committed to executing.
 * Bratman's intention: temporally persistent, resists reconsideration.
 */
export interface CommittedAffordance extends Affordance {
  readonly committedAt: string;
  readonly persistUntil?: string;
  readonly reconsiderIf: readonly ReconsiderationTrigger[];
  readonly desire: string;              // which desire this serves
}

export interface ReconsiderationTrigger {
  readonly condition: string;           // e.g. "descriptor retracted"
  readonly facetType?: string;
  readonly threshold?: number;
}

// ═════════════════════════════════════════════════════════════
//  Active Inference / Free Energy (Friston)
// ═════════════════════════════════════════════════════════════

/**
 * Free energy evaluation for a newly discovered descriptor.
 * Should the agent update beliefs (perception) or act on the world (action)?
 */
export interface FreeEnergyEvaluation {
  readonly descriptor: IRI;
  readonly surprise: number;                // -ln p(o) — how unexpected
  readonly beliefUpdateCost: number;        // KL divergence for perception path
  readonly actionCost: number;              // expected free energy for action path
  readonly pragmaticValue: number;          // does this serve our desires?
  readonly epistemicValue: number;          // does this reduce our uncertainty?
  readonly recommendedResponse: FreeEnergyResponse;
}

export type FreeEnergyResponse =
  | 'accept'        // low surprise, update beliefs
  | 'investigate'   // high epistemic value, seek more information
  | 'challenge'     // high surprise + low trust, push back
  | 'ignore';       // low pragmatic + low epistemic value

// ═════════════════════════════════════════════════════════════
//  Stigmergy
// ═════════════════════════════════════════════════════════════

/**
 * Stigmergic field: the affordance landscape across all known pods.
 * Modified indirectly as agents publish/retract context.
 */
export interface StigmergicField {
  readonly pods: ReadonlyMap<IRI, PodFieldState>;
  readonly totalDescriptors: number;
  readonly totalAgents: number;
  readonly coherenceMetric: number;     // are agents converging or diverging?
  readonly changeRate: number;          // descriptors per unit time
  readonly dominantVocabularies: string[];
  readonly timestamp: string;
}

export interface PodFieldState {
  readonly podUrl: IRI;
  readonly descriptorCount: number;
  readonly agentCount: number;
  readonly lastModified: string;
  readonly modifiedBy: readonly IRI[];
  readonly affordanceDensity: number;   // how many affordances per descriptor
  readonly trustDistribution: TrustDistribution;
  /**
   * Target vocabularies referenced by this pod's Projection facets,
   * counted by occurrence. Aggregated across pods into the field's
   * `dominantVocabularies`.
   */
  readonly vocabularyCounts: Readonly<Record<string, number>>;
}

export interface TrustDistribution {
  readonly selfAsserted: number;
  readonly delegatedTrust: number;
  readonly cryptographicallyVerified: number;
  readonly total: number;
}
