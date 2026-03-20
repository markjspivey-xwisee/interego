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
  | 'Federation';

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

// ── Discriminated Union of all Facets ────────────────────────

export type ContextFacetData =
  | TemporalFacetData
  | ProvenanceFacetData
  | AgentFacetData
  | AccessControlFacetData
  | SemioticFacetData
  | TrustFacetData
  | FederationFacetData;

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
