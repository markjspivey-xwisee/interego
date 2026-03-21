/**
 * @module model/types
 * @description Core type definitions for Context Graphs 1.0
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
 * Profiles: WAC
 */
export interface AccessControlFacetData {
  readonly type: 'AccessControl';
  readonly authorizations: readonly Authorization[];
  readonly consentBasis?: IRI;
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
}

// ── Composed Descriptor (§3.4) ───────────────────────────────

export interface ComposedDescriptorData extends ContextDescriptorData {
  readonly compositionOp: CompositionOperator;
  readonly operands: readonly IRI[];
  readonly restrictToTypes?: readonly ContextTypeName[];  // for 'restriction' op
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
