/**
 * @module model/descriptor
 * @description Fluent builder for Context Descriptors (§3.1)
 *
 * Provides a type-safe, compositional API for constructing
 * ContextDescriptorData instances.
 */

import type {
  IRI,
  ContextDescriptorData,
  ContextFacetData,
  TemporalFacetData,
  ProvenanceFacetData,
  ProvenanceActivity,
  AgentDescription,
  Authorization,
  SemioticFacetData,
  TrustFacetData,
  FederationFacetData,
  CausalFacetData,
  CausalIntervention,
  CounterfactualQuery,
  StructuralCausalModel,
  ProjectionFacetData,
  ExternalBinding,
  VocabularyMapping,
  BindingStrength,
  AgentRole,
} from './types.js';

// ── Builder ──────────────────────────────────────────────────

export class ContextDescriptor {
  private _id: IRI;
  private _describes: IRI[] = [];
  private _facets: ContextFacetData[] = [];
  private _version?: number;
  private _supersedes: IRI[] = [];
  private _conformsTo: IRI[] = [];
  private _validFrom?: string;
  private _validUntil?: string;

  constructor(id: IRI) {
    this._id = id;
  }

  // ── Static factory ───────────────────────────────────────

  static create(id: IRI): ContextDescriptor {
    return new ContextDescriptor(id);
  }

  /**
   * Reconstruct a builder from serialized data.
   */
  static from(data: ContextDescriptorData): ContextDescriptor {
    const cd = new ContextDescriptor(data.id);
    cd._describes = [...data.describes];
    cd._facets = [...data.facets];
    cd._version = data.version;
    cd._supersedes = data.supersedes ? [...data.supersedes] : [];
    cd._conformsTo = data.conformsTo ? [...data.conformsTo] : [];
    cd._validFrom = data.validFrom;
    cd._validUntil = data.validUntil;
    return cd;
  }

  // ── Core properties ──────────────────────────────────────

  describes(...graphs: IRI[]): this {
    this._describes.push(...graphs);
    return this;
  }

  version(v: number): this {
    this._version = v;
    return this;
  }

  supersedes(...iris: IRI[]): this {
    this._supersedes.push(...iris);
    return this;
  }

  /**
   * Declare schemas/vocabularies/shapes this claim conforms to.
   * Mirrored from dct:conformsTo in graph content during publish so
   * federation readers can filter by schema without decrypting.
   */
  conformsTo(...iris: IRI[]): this {
    this._conformsTo.push(...iris);
    return this;
  }

  /**
   * Descriptor-level `validFrom` — the instant at which the claim this
   * descriptor carries STARTS being true. This is NOT the assertion time
   * (see `prov:generatedAtTime` on the Provenance facet) — they diverge
   * for backdated claims ("asserted today that X started on 2024-01-01"),
   * scheduled claims ("asserted today that P takes effect on 2026-06-01"),
   * and retroactive corrections.
   *
   * Per spec/architecture.md §5.2.2 (normative): writers MUST NOT conflate
   * the two, and the builder enforces this by keeping them on separate
   * methods with separate defaults.
   */
  validFrom(dt: string | Date): this {
    this._validFrom = dt instanceof Date ? dt.toISOString() : dt;
    return this;
  }

  validUntil(dt: string | Date): this {
    this._validUntil = dt instanceof Date ? dt.toISOString() : dt;
    return this;
  }

  // ── Generic facet ────────────────────────────────────────

  addFacet(facet: ContextFacetData): this {
    this._facets.push(facet);
    return this;
  }

  // ── Temporal Facet (§5.1) ────────────────────────────────

  temporal(opts: Omit<TemporalFacetData, 'type'>): this {
    this._facets.push({ type: 'Temporal', ...opts });
    return this;
  }

  // ── Provenance Facet (§5.2) ──────────────────────────────

  provenance(opts: Omit<ProvenanceFacetData, 'type'>): this {
    this._facets.push({ type: 'Provenance', ...opts });
    return this;
  }

  /**
   * Convenience: provenance with inline activity construction.
   */
  generatedBy(
    agent: IRI,
    opts?: {
      activityId?: IRI;
      startedAt?: string;
      endedAt?: string;
      used?: IRI[];
      derivedFrom?: IRI[];
      /** The human/org owner — if set, wasAttributedTo points to the owner, not the agent. */
      onBehalfOf?: IRI;
    }
  ): this {
    const activity: ProvenanceActivity = {
      id: opts?.activityId,
      agent,
      startedAt: opts?.startedAt,
      endedAt: opts?.endedAt,
      used: opts?.used,
    };
    this._facets.push({
      type: 'Provenance',
      wasGeneratedBy: activity,
      wasDerivedFrom: opts?.derivedFrom,
      wasAttributedTo: opts?.onBehalfOf ?? agent,
      generatedAtTime: opts?.endedAt,
    });
    return this;
  }

  /**
   * Convenience: set both owner attribution and agent identity in one call.
   *
   * Creates a Provenance facet with wasAttributedTo → owner,
   * wasAssociatedWith → agent, plus an Agent facet with
   * role=Author and onBehalfOf → owner.
   */
  delegatedBy(
    ownerWebId: IRI,
    agentId: IRI,
    opts?: {
      endedAt?: string;
      role?: AgentRole;
      derivedFrom?: readonly IRI[];
    },
  ): this {
    // NOTE on the timestamp: `generatedAtTime` is when the agent made
    // this assertion. It is deliberately independent of the descriptor's
    // `validFrom` (the moment the claim starts being true). Callers who
    // want a claim whose validity starts in the past or future MUST set
    // `validFrom()` explicitly — this builder will not copy
    // `generatedAtTime` into `validFrom`.
    const now = opts?.endedAt ?? new Date().toISOString();
    this._facets.push({
      type: 'Provenance',
      wasGeneratedBy: { agent: agentId, endedAt: now },
      wasAttributedTo: ownerWebId,
      generatedAtTime: now,
      wasDerivedFrom: opts?.derivedFrom && opts.derivedFrom.length > 0
        ? [...opts.derivedFrom]
        : undefined,
    });
    this._facets.push({
      type: 'Agent',
      assertingAgent: { identity: agentId, isSoftwareAgent: true },
      agentRole: opts?.role ?? 'Author',
      onBehalfOf: ownerWebId,
    });
    return this;
  }

  // ── Agent Facet (§5.3) ───────────────────────────────────

  agent(
    agentOrOpts: IRI | AgentDescription,
    role?: AgentRole,
    onBehalfOf?: IRI
  ): this {
    const desc: AgentDescription = typeof agentOrOpts === 'string'
      ? { identity: agentOrOpts }
      : agentOrOpts;
    this._facets.push({
      type: 'Agent',
      assertingAgent: desc,
      agentRole: role,
      onBehalfOf,
    });
    return this;
  }

  // ── Access Control Facet (§5.4) ──────────────────────────

  accessControl(
    authorizations: Authorization[],
    consentBasis?: IRI
  ): this {
    this._facets.push({
      type: 'AccessControl',
      authorizations,
      consentBasis,
    });
    return this;
  }

  // ── Semiotic Facet (§5.5) ────────────────────────────────

  semiotic(opts: Omit<SemioticFacetData, 'type'>): this {
    if (opts.epistemicConfidence !== undefined) {
      if (opts.epistemicConfidence < 0 || opts.epistemicConfidence > 1) {
        throw new RangeError(
          `epistemicConfidence must be in [0.0, 1.0], got ${opts.epistemicConfidence}`
        );
      }
    }
    // Modal-truth consistency (normative — see spec/architecture.md §5.2.2
    // and conformance category "Facet semantics → SemioticFacet"):
    //   Asserted       ↔ groundTruth MUST be true
    //   Counterfactual ↔ groundTruth MUST be false
    //   Hypothetical   ↔ groundTruth MUST NOT be set (three-valued)
    // Hypothetical claims have no settled truth value; forcing a boolean
    // placeholder would make SPARQL filters return false negatives for
    // "groundTruth is unknown". Reject misuse at the builder layer.
    if (opts.modalStatus === 'Asserted' && opts.groundTruth === false) {
      throw new Error(`SemioticFacet: Asserted claims require groundTruth=true (or omit)`);
    }
    if (opts.modalStatus === 'Counterfactual' && opts.groundTruth === true) {
      throw new Error(`SemioticFacet: Counterfactual claims require groundTruth=false (or omit)`);
    }
    if (opts.modalStatus === 'Hypothetical' && opts.groundTruth !== undefined) {
      throw new Error(`SemioticFacet: Hypothetical claims MUST NOT set groundTruth (leave undefined)`);
    }
    this._facets.push({ type: 'Semiotic', ...opts });
    return this;
  }

  /**
   * Convenience: mark this graph as asserted ground truth.
   */
  asserted(confidence?: number): this {
    return this.semiotic({
      modalStatus: 'Asserted',
      groundTruth: true,
      epistemicConfidence: confidence,
    });
  }

  /**
   * Convenience: mark this graph as hypothetical.
   *
   * Hypothetical claims carry no settled truth value — groundTruth is
   * intentionally left undefined so SPARQL filters "is the truth known?"
   * return the correct three-valued answer. If you need a definite
   * Counterfactual (rejected approach, known-false), use
   *
   *   .semiotic({ modalStatus: 'Counterfactual', groundTruth: false })
   *
   * directly (the `counterfactual()` method on this builder is reserved
   * for Pearl's causal-counterfactual rung, a different concept from the
   * semiotic modal Counterfactual).
   */
  hypothetical(confidence?: number): this {
    return this.semiotic({
      modalStatus: 'Hypothetical',
      epistemicConfidence: confidence,
    });
  }

  // ── Trust Facet (§5.6) ───────────────────────────────────

  trust(opts: Omit<TrustFacetData, 'type'>): this {
    this._facets.push({ type: 'Trust', ...opts });
    return this;
  }

  selfAsserted(issuer: IRI): this {
    return this.trust({ trustLevel: 'SelfAsserted', issuer });
  }

  verified(issuer: IRI, proof?: IRI): this {
    return this.trust({
      trustLevel: 'CryptographicallyVerified',
      issuer,
      proofMechanism: proof,
    });
  }

  // ── Federation Facet (§5.7) ──────────────────────────────

  federation(opts: Omit<FederationFacetData, 'type'>): this {
    this._facets.push({ type: 'Federation', ...opts });
    return this;
  }

  fromSolid(origin: IRI, endpoint: IRI, lastSynced?: string): this {
    return this.federation({
      origin,
      storageEndpoint: endpoint,
      syncProtocol: 'SolidNotifications',
      lastSynced,
    });
  }

  fromSparql(endpointURL: IRI, origin?: IRI): this {
    return this.federation({
      origin,
      endpointURL,
    });
  }

  // ── Projection Facet (§5.9) ────────────────────────────────

  projection(opts: Omit<ProjectionFacetData, 'type'>): this {
    this._facets.push({ type: 'Projection', ...opts });
    return this;
  }

  /**
   * Convenience: bind an internal entity to an external IRI.
   */
  bindsTo(source: IRI, target: IRI, strength: BindingStrength = 'Strong', confidence?: number): this {
    const existing = this._facets.find(f => f.type === 'Projection') as ProjectionFacetData | undefined;
    const binding: ExternalBinding = { source, target, strength, confidence };
    if (existing) {
      // Append to existing projection facet
      const idx = this._facets.indexOf(existing);
      this._facets[idx] = {
        ...existing,
        bindings: [...(existing.bindings ?? []), binding],
      };
    } else {
      this._facets.push({ type: 'Projection', bindings: [binding] });
    }
    return this;
  }

  /**
   * Convenience: add a vocabulary mapping.
   */
  mapsVocabulary(
    source: IRI,
    target: IRI,
    mappingType: 'class' | 'property',
    relationship: 'exact' | 'broader' | 'narrower' | 'related' = 'exact',
  ): this {
    const mapping: VocabularyMapping = { source, target, mappingType, relationship };
    const existing = this._facets.find(f => f.type === 'Projection') as ProjectionFacetData | undefined;
    if (existing) {
      const idx = this._facets.indexOf(existing);
      this._facets[idx] = {
        ...existing,
        vocabularyMappings: [...(existing.vocabularyMappings ?? []), mapping],
      };
    } else {
      this._facets.push({ type: 'Projection', vocabularyMappings: [mapping] });
    }
    return this;
  }

  // ── Causal Facet (§5.8 — Pearl's Causality) ──────────────

  causal(opts: Omit<CausalFacetData, 'type'>): this {
    if (opts.causalConfidence !== undefined) {
      if (opts.causalConfidence < 0 || opts.causalConfidence > 1) {
        throw new RangeError(
          `causalConfidence must be in [0.0, 1.0], got ${opts.causalConfidence}`
        );
      }
    }
    this._facets.push({ type: 'Causal', ...opts });
    return this;
  }

  /**
   * Convenience: mark as observational (Pearl's rung 1).
   * P(Y|X) — statistical association from observation.
   */
  observation(scmOrIri?: StructuralCausalModel | IRI): this {
    return this.causal({
      causalRole: 'Observation',
      causalModel: typeof scmOrIri === 'string' ? scmOrIri : undefined,
      causalModelData: typeof scmOrIri === 'object' ? scmOrIri : undefined,
    });
  }

  /**
   * Convenience: mark as interventional (Pearl's rung 2).
   * P(Y|do(X)) — causal effect via do-operator.
   */
  intervention(
    interventions: CausalIntervention[],
    parentObservation: IRI,
    scmOrIri?: StructuralCausalModel | IRI,
  ): this {
    return this.causal({
      causalRole: 'Intervention',
      interventions,
      parentObservation,
      causalModel: typeof scmOrIri === 'string' ? scmOrIri : undefined,
      causalModelData: typeof scmOrIri === 'object' ? scmOrIri : undefined,
    });
  }

  /**
   * Convenience: mark as counterfactual (Pearl's rung 3).
   * P(Y_x | X', Y') — what would have been.
   */
  counterfactual(
    query: CounterfactualQuery,
    parentObservation: IRI,
    parentIntervention?: IRI,
    scmOrIri?: StructuralCausalModel | IRI,
  ): this {
    return this.causal({
      causalRole: 'Counterfactual',
      counterfactualQuery: query,
      parentObservation,
      parentIntervention,
      causalModel: typeof scmOrIri === 'string' ? scmOrIri : undefined,
      causalModelData: typeof scmOrIri === 'object' ? scmOrIri : undefined,
    });
  }

  // ── Build ────────────────────────────────────────────────

  build(): ContextDescriptorData {
    if (this._describes.length === 0) {
      throw new Error('ContextDescriptor must describe at least one Named Graph');
    }
    if (this._facets.length === 0) {
      throw new Error('ContextDescriptor must have at least one facet');
    }
    return {
      id: this._id,
      describes: Object.freeze([...this._describes]),
      facets: Object.freeze([...this._facets]),
      version: this._version,
      supersedes: this._supersedes.length > 0
        ? Object.freeze([...this._supersedes])
        : undefined,
      conformsTo: this._conformsTo.length > 0
        ? Object.freeze([...this._conformsTo])
        : undefined,
      validFrom: this._validFrom,
      validUntil: this._validUntil,
    };
  }

  // ── Introspection ────────────────────────────────────────

  get id(): IRI { return this._id; }
  get facetCount(): number { return this._facets.length; }
  get graphCount(): number { return this._describes.length; }

  hasFacetType(type: ContextFacetData['type']): boolean {
    return this._facets.some(f => f.type === type);
  }

  getFacets<T extends ContextFacetData['type']>(
    type: T
  ): Extract<ContextFacetData, { type: T }>[] {
    return this._facets.filter(
      (f): f is Extract<ContextFacetData, { type: T }> => f.type === type
    );
  }
}
