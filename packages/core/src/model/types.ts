/**
 * @module model/types
 * @description Core type definitions for Interego 1.0
 *
 * These types encode the abstract data model from §3 of the specification:
 *   - Context Descriptors (§3.1)
 *   - Context Facets (§3.2)
 *   - Context–Graph Bindings (§3.3)
 *   - Context Composition (§3.4)
 *   - Triple Term Annotations (§3.5)
 */

// ── Branded IRI type ─────────────────────────────────────────

declare const __iri: unique symbol;
export type IRI = string & { readonly [__iri]?: never };

// ── RDF Term representations ─────────────────────────────────

export interface Literal {
  readonly value: string;
  readonly datatype: IRI;
  readonly language?: string;
}

export interface TripleTerm {
  readonly subject: IRI;
  readonly predicate: IRI;
  readonly object: IRI | Literal;
}

export type RDFTerm = IRI | Literal | TripleTerm;

// ── Context Types (§3.2 Table) ───────────────────────────────

export type ContextTypeName =
  | 'Temporal'
  | 'Provenance'
  | 'Agent'
  | 'AccessControl'
  | 'Semiotic'
  | 'Trust'
  | 'Federation'
  | 'Causal'
  | 'Projection';


// ── Modal Status (Semiotic Facet §5.5) ───────────────────────

export type ModalStatus =
  | 'Asserted'
  | 'Hypothetical'
  | 'Counterfactual'
  | 'Quoted'
  | 'Retracted';

// ── Trust Level (§5.6) ──────────────────────────────────────

export type TrustLevel =
  | 'SelfAsserted'
  | 'ThirdPartyAttested'
  | 'CryptographicallyVerified';

// ── Agent Role (§5.3) ───────────────────────────────────────

export type AgentRole = 'Author' | 'Curator' | 'Validator' | string;

// ── Sync Protocol (§5.7) ────────────────────────────────────

export type SyncProtocol =
  | 'SolidNotifications'
  | 'WebSub'
  | 'LinkedDataNotifications'
  | 'Polling';

// ── Composition Operators (§3.4) ─────────────────────────────

export type CompositionOperator =
  | 'union'
  | 'intersection'
  | 'restriction'
  | 'override';

// ── ACL Mode (§5.4, from WAC) ───────────────────────────────

export type ACLMode = 'Read' | 'Write' | 'Append' | 'Control';

// ── Facet Definitions ────────────────────────────────────────

/**
 * Temporal Facet (§5.1)
 * Profiles: OWL-Time, Dublin Core Terms
 */
export interface TemporalFacetData {
  readonly type: 'Temporal';
  readonly validFrom?: string;           // xsd:dateTime
  readonly validUntil?: string;           // xsd:dateTime
  readonly temporalResolution?: string;   // xsd:duration (e.g. "P1D", "PT1H")
  readonly temporalRelation?: IRI;        // Allen interval relation
}

/**
 * PROV-O Activity reference
 */
export interface ProvenanceActivity {
  readonly id?: IRI;
  readonly agent?: IRI;
  readonly startedAt?: string;   // xsd:dateTime
  readonly endedAt?: string;     // xsd:dateTime
  readonly used?: readonly IRI[];
}

/**
 * Provenance Facet (§5.2)
 * Profiles: PROV-O
 */
export interface ProvenanceFacetData {
  readonly type: 'Provenance';
  readonly wasGeneratedBy?: ProvenanceActivity;
  readonly wasDerivedFrom?: readonly IRI[];
  readonly wasAttributedTo?: IRI;
  readonly generatedAtTime?: string;    // xsd:dateTime
  readonly provenanceChain?: readonly ProvenanceFacetData[];
}

/**
 * Agent description
 */
export interface AgentDescription {
  readonly id?: IRI;
  readonly label?: string;
  readonly identity?: IRI;      // DID, WebID, ORCID, etc.
  readonly isSoftwareAgent?: boolean;
}

/**
 * Agent Facet (§5.3)
 * Profiles: PROV-O Agent, Activity Streams 2.0 Actor
 */
export interface AgentFacetData {
  readonly type: 'Agent';
  readonly assertingAgent?: AgentDescription;
  readonly onBehalfOf?: IRI;
  readonly agentRole?: AgentRole;
}

/**
 * WAC Authorization
 */
export interface Authorization {
  readonly agent?: IRI;
  readonly agentClass?: IRI;
  readonly mode: readonly ACLMode[];
}

/**
 * Access Control Facet (§5.4)
 * Profiles: WAC + ABAC (attribute-based policy refs).
 *
 * Two modes coexist: (a) classic identity-based authorizations per
 * WAC (`authorizations`); (b) attribute-based policy references
 * (`policyRefs`) pointing at `cg:AccessControlPolicy` descriptors.
 * The effective decision is the meet (deny-overrides-permit) across
 * whichever applies. Evaluation pattern for ABAC is specified by the
 * `abac:` L2 ontology and implemented in `src/abac/`.
 */
export interface AccessControlFacetData {
  readonly type: 'AccessControl';
  readonly authorizations: readonly Authorization[];
  readonly consentBasis?: IRI;
  /** IRIs of `cg:AccessControlPolicy` descriptors that govern access. */
  readonly policyRefs?: readonly IRI[];
}

/**
 * Access Control Policy (ABAC, L1) — attribute-based access-control
 * policy expressed as a first-class context descriptor. A policy has:
 *
 *   - `policyPredicateShape` — IRI of a SHACL NodeShape the subject's
 *     attribute graph must satisfy for the policy to apply.
 *   - `governedAction` — IRI of the action this policy governs.
 *   - `deonticMode` — Permit | Deny | Duty.
 *   - `duties` — obligations if mode is Duty (string form; ODRL-alignable).
 *
 * Attribute sources may span the federation; resolution pattern is
 * `abac:AttributeResolver`.
 */
export type DeonticMode = 'Permit' | 'Deny' | 'Duty';

export interface AccessControlPolicyData {
  readonly id: IRI;
  readonly policyPredicateShape: IRI;
  readonly governedAction: IRI;
  readonly deonticMode: DeonticMode;
  readonly duties?: readonly string[];
}

/**
 * Revocation Condition (extension — see spec/revocation.md).
 *
 * Declarative condition under which a claim's effective groundTruth
 * transitions per the RevocationAction. Shared between Proposal A
 * (cg:RevocationFacet — 7th facet) and Proposal B (cg:revokedIf
 * predicate on SemioticFacet). Neither proposal is adopted yet; the
 * terms carry vs:term_status "testing" in the ontology.
 */
export interface RevocationConditionData {
  /** SPARQL 1.1 ASK / SELECT / CONSTRUCT query (cg:successorQuery). */
  readonly successorQuery: string;
  /** Federation scope — cg:LocalPod / cg:KnownFederation / cg:WebFingerResolvable. */
  readonly evaluationScope?: 'LocalPod' | 'KnownFederation' | 'WebFingerResolvable';
  /** Action when the query matches — cg:MarkInvalid / cg:DowngradeToHypothetical / cg:RequireReconfirmation. */
  readonly onRevocation?: 'MarkInvalid' | 'DowngradeToHypothetical' | 'RequireReconfirmation';
  /** Optional issuer — may differ from the descriptor author (regulator, auditor). */
  readonly revocationIssuer?: IRI;
}

/**
 * Semiotic Facet (§5.5)
 * Novel vocabulary — Peircean triadic semiotics
 */
export interface SemioticFacetData {
  readonly type: 'Semiotic';
  readonly interpretationFrame?: IRI;
  readonly signSystem?: IRI;
  readonly groundTruth?: boolean;
  readonly modalStatus?: ModalStatus;
  readonly epistemicConfidence?: number;  // [0.0, 1.0]
  readonly languageTag?: string;          // BCP 47
  /**
   * Proposal B of the Revocation Extension (spec/revocation.md): zero
   * or more conditions attached directly to the SemioticFacet. When any
   * condition's successorQuery matches in the declared scope, the
   * enclosing descriptor's effective groundTruth transitions per the
   * RevocationAction. Lives in the cleartext descriptor so federation
   * readers can evaluate without decrypting the payload.
   */
  readonly revokedIf?: readonly RevocationConditionData[];
}

/**
 * Trust & Verifiability Facet (§5.6)
 * Profiles: Verifiable Credentials 2.0, DID Core
 */
export interface TrustFacetData {
  readonly type: 'Trust';
  readonly verifiableCredential?: IRI;
  readonly issuer?: IRI;
  readonly proofMechanism?: IRI;
  readonly trustLevel?: TrustLevel;
  readonly revocationStatus?: IRI;
  // Multi-standard identity anchoring
  readonly identityAnchors?: IdentityAnchors;
  // Activity trace (session/prompt metadata)
  readonly activityTrace?: ActivityTrace;
  // Payment metadata (X402)
  readonly paymentRequirement?: PaymentRequirement;
  readonly paymentReceipt?: PaymentReceipt;
  /**
   * Inline proof reference (cg:proof). For compliance descriptors:
   * carries the URL of the sibling .sig.json + the signature scheme
   * + the public signer address. Lets verifiers find the signature
   * via the descriptor itself rather than guessing a URL convention.
   *
   * The proof URL is included in the Turtle that gets SIGNED, so
   * tampering with the proof reference breaks the signature.
   */
  readonly proof?: ProofReference;
}

export interface ProofReference {
  /** Type of proof (e.g. "ECDSA-secp256k1", "Ed25519", "BBS+"). */
  readonly scheme: string;
  /** Where the proof artifact lives (typically a sibling .sig.json). */
  readonly proofUrl: IRI;
  /** Public signer identifier (Ethereum address, did:key, etc.). */
  readonly signer?: string;
}

/**
 * DCAT Distribution
 */
export interface Distribution {
  readonly mediaType: string;
  readonly accessURL: IRI;
}

/**
 * Federation Facet (§5.7)
 * Profiles: DCAT 3, LDP, Solid Protocol
 */
export interface FederationFacetData {
  readonly type: 'Federation';
  readonly origin?: IRI;
  readonly storageEndpoint?: IRI;
  readonly endpointURL?: IRI;
  readonly syncProtocol?: SyncProtocol;
  readonly replicaOf?: IRI;
  readonly lastSynced?: string;          // xsd:dateTime
  readonly distribution?: Distribution;
}

// ── Causal Role (Pearl's Ladder of Causation) ───────────────

export type CausalRole =
  | 'Observation'       // Rung 1: P(Y|X) — seeing
  | 'Intervention'      // Rung 2: P(Y|do(X)) — doing
  | 'Counterfactual';   // Rung 3: P(Y_x|X',Y') — imagining

// ── Structural Causal Model Types ───────────────────────────

/**
 * A variable in a Structural Causal Model (SCM).
 * Represents an endogenous or exogenous variable in Pearl's framework.
 */
export interface CausalVariable {
  /** Variable name (unique within the SCM). */
  readonly name: string;
  /** Optional IRI identifying this variable in an ontology. */
  readonly iri?: IRI;
  /** Whether this is an exogenous (external) variable. */
  readonly exogenous?: boolean;
  /** Variables that this variable directly causes. */
  readonly causes?: readonly string[];
  /** Structural equation description (human-readable or formal). */
  readonly mechanism?: string;
}

/**
 * An edge in a causal DAG.
 */
export interface CausalEdge {
  /** The cause variable name. */
  readonly from: string;
  /** The effect variable name. */
  readonly to: string;
  /** Optional label for the causal mechanism. */
  readonly mechanism?: string;
  /** Estimated causal strength (0.0–1.0). */
  readonly strength?: number;
}

/**
 * A Structural Causal Model (SCM) — Pearl's formal causal framework.
 * Contains the DAG structure (V, U, F) where:
 *   V = endogenous variables
 *   U = exogenous variables
 *   F = structural equations (mechanisms)
 */
export interface StructuralCausalModel {
  /** IRI identifying this SCM. */
  readonly id: IRI;
  /** Human-readable label. */
  readonly label?: string;
  /** All variables (endogenous + exogenous) in the model. */
  readonly variables: readonly CausalVariable[];
  /** Directed edges representing causal mechanisms. */
  readonly edges: readonly CausalEdge[];
}

/**
 * An intervention — Pearl's do-operator.
 * Represents do(X = x): setting variable X to value x,
 * which surgically removes all incoming edges to X in the SCM.
 */
export interface CausalIntervention {
  /** The variable being intervened on. */
  readonly variable: string;
  /** The value the variable is set to (or a description). */
  readonly value: string;
}

/**
 * A counterfactual query — Pearl's rung 3.
 * "Given that we observed X' and Y', what would Y have been
 *  had X been x?" — P(Y_x | X', Y')
 */
export interface CounterfactualQuery {
  /** The target variable we want the counterfactual value of. */
  readonly target: string;
  /** The hypothetical intervention. */
  readonly intervention: CausalIntervention;
  /** Observed evidence (variable name → observed value). */
  readonly evidence: Record<string, string>;
}

/**
 * Causal Facet (§5.8 — Pearl's Causality Integration)
 *
 * Attaches causal semantics to a context descriptor:
 *   - Links to a Structural Causal Model (SCM)
 *   - Declares the causal role (observation, intervention, counterfactual)
 *   - Records interventions (do-operator applications)
 *   - Records counterfactual queries
 *   - Links to the parent observational descriptor
 *
 * Profiles: Pearl's SCM framework, do-calculus
 */
export interface CausalFacetData {
  readonly type: 'Causal';
  /** The Structural Causal Model this descriptor references. */
  readonly causalModel?: IRI;
  /** Inline SCM definition (alternative to referencing by IRI). */
  readonly causalModelData?: StructuralCausalModel;
  /** Pearl's Ladder rung: what type of causal claim is this? */
  readonly causalRole: CausalRole;
  /** Interventions applied (for Intervention and Counterfactual roles). */
  readonly interventions?: readonly CausalIntervention[];
  /** Counterfactual query (for Counterfactual role). */
  readonly counterfactualQuery?: CounterfactualQuery;
  /** The observational descriptor this derives from (for rung 2 & 3). */
  readonly parentObservation?: IRI;
  /** The interventional descriptor this counterfactual derives from (rung 3 only). */
  readonly parentIntervention?: IRI;
  /** Estimated causal effect size (for interventions). */
  readonly effectSize?: number;
  /** Confidence in the causal claim (distinct from epistemic confidence). */
  readonly causalConfidence?: number;
}

// ── Binding Strength (Projection Facet) ─────────────────────

/**
 * How strongly an external binding couples two representations.
 *
 *   Exact      — owl:sameAs-level identity (use with caution)
 *   Strong     — skos:exactMatch; same referent, independent representations
 *   Approximate — skos:closeMatch; similar but not identical
 *   Weak       — skos:relatedMatch; related but distinct concepts
 */
export type BindingStrength = 'Exact' | 'Strong' | 'Approximate' | 'Weak';

/**
 * An external binding — a link from an internal entity to an external IRI
 * in another vocabulary/ontology/knowledge graph.
 */
export interface ExternalBinding {
  /** The internal entity IRI being bound. */
  readonly source: IRI;
  /** The external entity IRI being bound to. */
  readonly target: IRI;
  /** How strong the binding is. */
  readonly strength: BindingStrength;
  /** The external vocabulary/namespace this binding targets. */
  readonly targetVocabulary?: IRI;
  /** Confidence in this binding (0.0–1.0). */
  readonly confidence?: number;
  /** Who asserted this binding. */
  readonly assertedBy?: IRI;
}

/**
 * A vocabulary mapping — translates predicates/classes from one namespace to another.
 */
export interface VocabularyMapping {
  /** Source predicate or class IRI. */
  readonly source: IRI;
  /** Target predicate or class IRI in the external vocabulary. */
  readonly target: IRI;
  /** Whether this is a class mapping or property mapping. */
  readonly mappingType: 'class' | 'property';
  /** Semantic relationship: exact, broader, narrower, related. */
  readonly relationship: 'exact' | 'broader' | 'narrower' | 'related';
}

/**
 * Projection Facet (§5.9)
 *
 * Declares how a context translates across vocabulary and
 * organizational boundaries. When a consuming agent operates in a
 * different ontological frame than the producing agent, the
 * Projection facet carries the mappings needed to bridge them.
 *
 * Three capabilities:
 *   1. External bindings — link internal entities to external IRIs
 *      with typed binding strength (Exact/Strong/Approximate/Weak)
 *   2. Vocabulary mappings — translate predicates and classes between
 *      namespaces (exact/broader/narrower/related per SKOS)
 *   3. Selective exposure — declare which parts of the graph are
 *      visible across the boundary (SHACL shapes as filter)
 *
 * Profiles: SKOS mapping relations, OWL alignment, SSSOM
 */
export interface ProjectionFacetData {
  readonly type: 'Projection';
  /** External bindings from internal entities to external IRIs. */
  readonly bindings?: readonly ExternalBinding[];
  /** Vocabulary mappings for cross-ontology translation. */
  readonly vocabularyMappings?: readonly VocabularyMapping[];
  /** The target vocabulary/ontology this projection translates to. */
  readonly targetVocabulary?: IRI;
  /** SHACL shapes IRI defining the projection boundary (what's exposed). */
  readonly boundaryShapes?: IRI;
  /** Whether this projection exposes the full graph or a filtered subset. */
  readonly selective?: boolean;
  /** IRIs of entities explicitly exposed (if selective). */
  readonly exposedEntities?: readonly IRI[];
  /** IRIs of entities explicitly hidden (if selective). */
  readonly hiddenEntities?: readonly IRI[];
}

// ── Discriminated Union of all Facets ────────────────────────

export type ContextFacetData =
  | TemporalFacetData
  | ProvenanceFacetData
  | AgentFacetData
  | AccessControlFacetData
  | SemioticFacetData
  | TrustFacetData
  | FederationFacetData
  | CausalFacetData
  | ProjectionFacetData;

// ── Context Descriptor (§3.1) ────────────────────────────────

export interface ContextDescriptorData {
  readonly id: IRI;
  readonly describes: readonly IRI[];     // Named Graph IRIs
  readonly facets: readonly ContextFacetData[];
  readonly version?: number;              // xsd:nonNegativeInteger
  readonly supersedes?: readonly IRI[];
  readonly validFrom?: string;            // xsd:dateTime (administrative validity)
  readonly validUntil?: string;           // xsd:dateTime
  /**
   * Schemas / vocabularies / shapes this descriptor's claim conforms to.
   * Cleartext-mirrored from dct:conformsTo in the graph content so
   * federation readers can filter/route by schema without decrypting.
   */
  readonly conformsTo?: readonly IRI[];
}

// ── Peircean Sign Primitive (§2 Semiotic Foundation) ────────

/**
 * The Peircean triadic sign — the foundational primitive.
 *
 * Every Context Descriptor IS a sign:
 *   - representamen: the named graph(s) — the form of the sign
 *   - object: what the graph refers to — the real-world referent
 *   - interpretant: the facets — the conditions under which the sign means something
 *
 * Composition of descriptors is composition of signs.
 * The semiotic facet is not one facet among many — it's the meta-facet
 * that declares the modality of the entire sign relation.
 */
export interface Sign<T extends ContextFacetData = ContextFacetData> {
  /** The representamen — the form/vehicle of the sign (Named Graph IRIs). */
  readonly representamen: readonly IRI[];
  /** The object — what the sign refers to (optional explicit referent). */
  readonly object?: IRI;
  /** The interpretant — how to interpret the sign (facets as interpretive conditions). */
  readonly interpretant: readonly T[];
  /** The sign's identity. */
  readonly id: IRI;
}

/** View a ContextDescriptor as a Peircean Sign. */
export function asSign(descriptor: ContextDescriptorData): Sign {
  return {
    id: descriptor.id,
    representamen: descriptor.describes,
    interpretant: descriptor.facets,
  };
}

/** View a Sign as a ContextDescriptor. */
export function fromSign(sign: Sign, opts?: { version?: number; supersedes?: IRI[] }): ContextDescriptorData {
  return {
    id: sign.id,
    describes: sign.representamen,
    facets: sign.interpretant,
    version: opts?.version,
    supersedes: opts?.supersedes,
  };
}

// ── Composed Descriptor (§3.4) ───────────────────────────────

export interface ComposedDescriptorData extends ContextDescriptorData {
  readonly compositionOp: CompositionOperator;
  readonly operands: readonly IRI[];
  readonly restrictToTypes?: readonly ContextTypeName[];  // for 'restriction' op

  /**
   * PGSL structural metadata for the composition.
   *
   * Composition maps to PGSL operations:
   *   union       = extend the pyramid (overlapping pair, shared boundary deduped)
   *   intersection = the shared boundary itself (lattice meet)
   *   restriction = collapse to subset (wrap/project)
   *   override    = replace inner element, preserve outer structure
   *
   * The pgslUri is the canonical content-addressed URI of this composed
   * structure in the lattice. Two identical compositions produce the same URI.
   */
  readonly pgslUri?: IRI;

  /**
   * The structural operation type in PGSL terms:
   *   'extend'  = inner + (grow the pyramid)
   *   'beside'  = outer + (place beside, independent)
   *   'wrap'    = create boundary (turn pyramid into single element)
   *   'meet'    = find shared sub-structure
   */
  readonly structuralOp?: 'extend' | 'beside' | 'wrap' | 'meet';

  /**
   * The shared boundary between operands (for union/intersection).
   * This is the overlap region in the overlapping pair construction —
   * the facets/structure that both operands share.
   */
  readonly sharedBoundary?: readonly ContextFacetData[];
}

// ── Triple Context Annotation (§3.5) ─────────────────────────

export interface TripleContextAnnotation {
  readonly triple: TripleTerm;
  readonly facets: readonly ContextFacetData[];
}

// ── Delegation Scope (§8 Owner / Agent Delegation) ──────────

export type DelegationScope = 'ReadWrite' | 'ReadOnly' | 'PublishOnly' | 'DiscoverOnly';

// ── Agent Delegation ────────────────────────────────────────

/** A registered agent authorized to act on behalf of a pod owner. */
export interface AuthorizedAgentData {
  /** The agent's identity (URN, DID, or IRI). */
  readonly agentId: IRI;
  /** The owner who delegated authority to this agent. */
  readonly delegatedBy: IRI;
  /** Human-readable label for this agent. */
  readonly label?: string;
  /** Whether this is a software agent (AI coding agent, CLI tool, etc.). */
  readonly isSoftwareAgent?: boolean;
  /** What this agent is allowed to do. */
  readonly scope: DelegationScope;
  /** ISO 8601 start of delegation validity. */
  readonly validFrom: string;
  /** ISO 8601 end of delegation validity (undefined = no expiry). */
  readonly validUntil?: string;
  /** Whether this delegation has been revoked. */
  readonly revoked?: boolean;
  /**
   * X25519 public key (base64) used when publishing encrypted content to
   * this pod. Anyone writing an encrypted envelope to the pod wraps the
   * content key for every authorized agent's encryptionPublicKey so each
   * can decrypt with their own private key. Agents without this field
   * simply aren't recipients — they can see manifest metadata but not
   * encrypted payloads. See crypto/encryption.ts.
   */
  readonly encryptionPublicKey?: string;
  /**
   * Recently-retired X25519 public keys for this agent, with timestamps.
   * Publishers wrapping new envelopes wrap to the current
   * `encryptionPublicKey` AND every retired key whose `retiredAt` falls
   * inside the rollover window (default 30 days). This gives the agent
   * a grace period where it can rotate the active key without losing
   * access to envelopes still in flight from publishers who haven't yet
   * refetched the registry.
   *
   * Without this list, key rotation immediately orphans every pending
   * shared descriptor — publishers see the new key but envelopes
   * already wrapped for the old key are unrecoverable. With it,
   * rotation has a soft cutover: the agent decrypts via whichever
   * private key still matches a wrapped envelope, and over the
   * rollover window publishers transition to the new key as they
   * refresh.
   *
   * Closes Sec #12 from the production-readiness audit. Empty / absent
   * means no recent rotations; an envelope wrapped only for the
   * current key.
   */
  readonly encryptionKeyHistory?: readonly EncryptionKeyHistoryEntry[];
}

/**
 * One entry in an agent's encryption-key rotation history. The
 * private side is NEVER persisted to the pod — agents hold their own
 * historical secret keys locally and try each on decryption. This
 * struct only conveys the PUBLIC key + lifecycle timestamps so
 * publishers can find keys to wrap to during the rollover window.
 */
export interface EncryptionKeyHistoryEntry {
  /** Base64 X25519 public key — same shape as `encryptionPublicKey`. */
  readonly publicKey: string;
  /** ISO 8601 timestamp when this key was first the active key. */
  readonly createdAt: string;
  /** ISO 8601 timestamp when this key was rotated out (became history). */
  readonly retiredAt: string;
  /**
   * Optional human / agent label for this key generation — useful when
   * an agent has rotated multiple times and needs to distinguish "the
   * one from before the laptop replacement" vs. "the one from the
   * security incident."
   */
  readonly label?: string;
}

/** The owner profile stored on a pod. */
export interface OwnerProfileData {
  /** The owner's WebID (canonical identity IRI). */
  readonly webId: IRI;
  /** Human-readable name. */
  readonly name?: string;
  /** All agents authorized to act on this owner's behalf. */
  readonly authorizedAgents: readonly AuthorizedAgentData[];
}

/** A Verifiable Credential for agent delegation. */
export interface AgentDelegationCredential {
  /** The credential IRI (stored on the pod). */
  readonly id: IRI;
  /** VC type array — always includes 'VerifiableCredential' and 'AgentDelegation'. */
  readonly type: readonly string[];
  /** The issuer (owner) DID/WebID. */
  readonly issuer: IRI;
  /** ISO 8601 issuance date. */
  readonly issuanceDate: string;
  /** ISO 8601 expiration (optional). */
  readonly expirationDate?: string;
  /** The credential subject — the delegated agent. */
  readonly credentialSubject: {
    /** The agent being delegated to. */
    readonly id: IRI;
    /** Who delegated authority. */
    readonly delegatedBy: IRI;
    /** What the agent is allowed to do. */
    readonly scope: readonly string[];
    /** Which pod this delegation covers. */
    readonly pod: IRI;
  };
}

/** Result of verifying a delegation chain. */
export interface DelegationVerification {
  /** Whether the delegation is valid. */
  readonly valid: boolean;
  /** The owner WebID if verification succeeded. */
  readonly owner?: IRI;
  /** The agent ID that was verified. */
  readonly agent?: IRI;
  /** The delegation scope granted. */
  readonly scope?: DelegationScope;
  /** Human-readable reason if verification failed. */
  readonly reason?: string;
}

// ── Pod Directory (§8 Federation Discovery) ──────────────────

/** A single entry in a pod directory graph. */
export interface PodDirectoryEntry {
  /** The pod's URL (Solid storage root). */
  readonly podUrl: IRI;
  /** The pod owner's WebID. */
  readonly owner?: IRI;
  /** Human-readable label for this pod. */
  readonly label?: string;
  /**
   * Optional hint advertising name attestations the pod hosts about its
   * owner — serialized as plain `<owner> foaf:nick "name"` triples in the
   * directory graph. Lets a federated `resolveName` narrow the pods it
   * walks. This is a CACHE/HINT, re-derivable from the pod's attestation
   * descriptors — NOT authoritative; the resolver still verifies the
   * underlying attestation. Uses W3C FOAF; no new ontology terms.
   */
  readonly ownerNicks?: readonly string[];
}

/** A directory of known pods, itself publishable as a context graph. */
export interface PodDirectoryData {
  /** The directory's IRI. */
  readonly id: IRI;
  /** All pods listed in this directory. */
  readonly entries: readonly PodDirectoryEntry[];
}

// ── Validation Result ────────────────────────────────────────

export interface ValidationViolation {
  readonly path: string;
  readonly message: string;
  readonly severity: 'violation' | 'warning' | 'info';
}

export interface ValidationResult {
  readonly conforms: boolean;
  readonly violations: readonly ValidationViolation[];
}

// ═════════════════════════════════════════════════════════════
//  Activity Trace & Session Metadata (§9)
// ═════════════════════════════════════════════════════════════

/** Platform where the agent is running. */
export type AgentPlatform =
  | 'claude-code-vscode'
  | 'claude-code-cli'
  | 'claude-desktop'
  | 'openai-codex'
  | 'openclaw'
  | 'custom-agent'
  | 'autonomous';

/** Execution mode of the agent. */
export type ExecutionMode = 'interactive' | 'autonomous' | 'scheduled' | 'event-triggered';

/** A record of a tool call within an activity trace. */
export interface ToolCallRecord {
  readonly toolName: string;
  readonly timestamp: string;
  readonly durationMs?: number;
  readonly inputHash?: string;    // hash of input (not content — privacy)
  readonly outputHash?: string;
  readonly success: boolean;
}

/** Git context at the time of activity. */
export interface GitContext {
  readonly repo?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly dirty?: boolean;
}

/**
 * Activity trace — captures the full context of how a descriptor was produced.
 * Covers human-prompted, autonomous, and scheduled agents.
 */
export interface ActivityTrace {
  // Session
  readonly sessionId?: string;
  readonly platform: AgentPlatform;
  readonly modelId?: string;

  // Human-in-the-loop
  readonly humanPrompted: boolean;
  readonly humanApproved: boolean;
  readonly promptHash?: string;         // hash of prompt (privacy-preserving)

  // Tool chain
  readonly toolCalls?: readonly ToolCallRecord[];

  // Environment
  readonly gitContext?: GitContext;
  readonly workspacePath?: string;

  // Autonomous agent specifics
  readonly taskId?: string;
  readonly triggerEvent?: string;
  readonly executionMode: ExecutionMode;

  // Continuous attestation (for autonomous agents)
  readonly attestationSignature?: string;
  readonly attestationTimestamp?: string;
}

// ═════════════════════════════════════════════════════════════
//  Identity Anchoring (§10 — Multi-Standard)
// ═════════════════════════════════════════════════════════════

/** ERC-8004 on-chain agent identity. */
export interface ERC8004Identity {
  readonly tokenId: string;              // NFT token ID
  readonly contractAddress: string;      // ERC-8004 contract
  readonly chain: string;                // e.g. 'ethereum:mainnet', 'polygon:mainnet'
  readonly owner: string;                // wallet address of the human owner
}

/** ERC-4361 Sign-In With Ethereum proof. */
export interface SIWEProof {
  readonly walletAddress: string;
  readonly signature: string;
  readonly message: string;              // the SIWE message that was signed
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expirationTime?: string;
}

/** IPFS content anchor. */
export interface IPFSAnchor {
  readonly cid: string;                  // content identifier (CIDv1)
  readonly gateway?: string;             // preferred gateway URL
  readonly pinned: boolean;              // is it pinned to a pinning service?
  readonly pinnedAt?: string;
  readonly pinService?: string;          // e.g. 'pinata', 'web3.storage', 'infura'
}

/** Blockchain timestamp anchor. */
export interface BlockchainAnchor {
  readonly chain: string;                // e.g. 'ethereum:mainnet'
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly blockTimestamp: string;
  readonly contentHash: string;          // hash of the descriptor that was anchored
}

/** Open Badge 3.0 capability credential. */
export interface OpenBadgeCredential {
  readonly badgeUrl: IRI;
  readonly issuer: IRI;
  readonly issuanceDate: string;
  readonly credentialSubject: IRI;       // the agent or human this badge is about
  readonly achievementType: string;      // e.g. 'CausalReasoningCertified'
  readonly evidence?: readonly IRI[];
}

/** IEEE LERS (Learning & Employment Record). */
export interface LERSRecord {
  readonly recordId: IRI;
  readonly issuer: IRI;
  readonly competency: string;
  readonly assessmentDate: string;
  readonly level: string;                // e.g. 'proficient', 'expert'
}

/**
 * Identity anchors — multi-standard identity/verification proofs
 * attached to the Trust facet.
 */
export interface IdentityAnchors {
  // Blockchain identity
  readonly erc8004?: ERC8004Identity;
  readonly siwe?: SIWEProof;

  // Content persistence
  readonly ipfs?: IPFSAnchor;
  readonly blockchain?: BlockchainAnchor;

  // Capability credentials
  readonly openBadges?: readonly OpenBadgeCredential[];
  readonly lers?: readonly LERSRecord[];

  // W3C standards (complement existing WebID + DID + VC)
  readonly additionalVCs?: readonly IRI[];
}

// ═════════════════════════════════════════════════════════════
//  X402 Payment Metadata (§11 — Agentic Commerce)
// ═════════════════════════════════════════════════════════════

/** Payment requirement for accessing a context descriptor. */
export interface PaymentRequirement {
  readonly required: boolean;
  readonly amount?: string;              // e.g. '0.001'
  readonly currency?: string;            // e.g. 'ETH', 'USD', 'USDC'
  readonly paymentNetwork?: string;      // e.g. 'ethereum:mainnet', 'lightning', 'stripe'
  readonly paymentAddress?: string;      // wallet address or payment endpoint
  readonly x402Endpoint?: string;        // X402 payment negotiation URL
}

/** Receipt proving payment was made. */
export interface PaymentReceipt {
  readonly transactionHash?: string;
  readonly paidAt: string;
  readonly amount: string;
  readonly currency: string;
  readonly payer: string;                // agent/wallet that paid
  readonly payee: string;               // pod owner who received
}
