/**
 * @module validation/shacl-shapes
 * @description SHACL shapes for Interego 1.0 (§6)
 *
 * Exports the normative SHACL shapes as a Turtle string for use
 * with external SHACL validation engines (e.g., TopQuadrant SHACL,
 * pySHACL, shacl-js).
 *
 * Reuses: SHACL 1.0 [Rec], SHACL-SPARQL
 */

export const SHACL_SHAPES_TURTLE = `\
@prefix iep:    <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix sh:    <http://www.w3.org/ns/shacl#> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .
@prefix prov:  <http://www.w3.org/ns/prov#> .
@prefix rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .

# ── Context Descriptor Shape ──────────────────────────────────

iep:ContextDescriptorShape a sh:NodeShape ;
    sh:targetClass iep:ContextDescriptor ;
    sh:property [
        sh:path iep:hasFacet ;
        sh:minCount 1 ;
        sh:class iep:ContextFacet ;
        sh:message "A ContextDescriptor MUST have at least one facet." ;
    ] ;
    sh:property [
        sh:path iep:describes ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
        sh:message "A ContextDescriptor MUST describe at least one Named Graph." ;
    ] ;
    sh:property [
        sh:path iep:version ;
        sh:maxCount 1 ;
        sh:datatype xsd:nonNegativeInteger ;
    ] ;
    sh:property [
        sh:path iep:validFrom ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
    ] ;
    sh:property [
        sh:path iep:validUntil ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
    ] ;
    sh:sparql [
        sh:message "validUntil MUST be after validFrom when both are present." ;
        sh:select """
            SELECT $this WHERE {
                $this iep:validFrom ?from .
                $this iep:validUntil ?until .
                FILTER (?until <= ?from)
            }
        """ ;
    ] .

# ── Composed Descriptor Shape ─────────────────────────────────

iep:ComposedDescriptorShape a sh:NodeShape ;
    sh:targetClass iep:ComposedDescriptor ;
    sh:property [
        sh:path iep:compositionOp ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:class iep:CompositionOperator ;
    ] ;
    sh:property [
        sh:path iep:operand ;
        sh:minCount 1 ;
        sh:class iep:ContextDescriptor ;
    ] .

# ── Temporal Facet Shape ──────────────────────────────────────

iep:TemporalFacetShape a sh:NodeShape ;
    sh:targetClass iep:TemporalFacet ;
    sh:property [
        sh:path iep:validFrom ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
    ] ;
    sh:property [
        sh:path iep:validUntil ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
    ] ;
    sh:property [
        sh:path iep:temporalResolution ;
        sh:maxCount 1 ;
        sh:datatype xsd:duration ;
    ] ;
    sh:sparql [
        sh:message "Temporal facet validUntil MUST be after validFrom." ;
        sh:select """
            SELECT $this WHERE {
                $this iep:validFrom ?from .
                $this iep:validUntil ?until .
                FILTER (?until <= ?from)
            }
        """ ;
    ] .

# ── Provenance Facet Shape ────────────────────────────────────

iep:ProvenanceFacetShape a sh:NodeShape ;
    sh:targetClass iep:ProvenanceFacet ;
    sh:property [
        sh:path prov:wasGeneratedBy ;
        sh:class prov:Activity ;
    ] ;
    sh:property [
        sh:path prov:generatedAtTime ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
    ] .

# ── Agent Facet Shape ─────────────────────────────────────────

iep:AgentFacetShape a sh:NodeShape ;
    sh:targetClass iep:AgentFacet ;
    sh:property [
        sh:path iep:agentRole ;
        sh:maxCount 1 ;
    ] .

# ── Semiotic Facet Shape ──────────────────────────────────────

iep:SemioticFacetShape a sh:NodeShape ;
    sh:targetClass iep:SemioticFacet ;
    sh:property [
        sh:path iep:modalStatus ;
        sh:maxCount 1 ;
        sh:in ( iep:Asserted iep:Hypothetical iep:Counterfactual iep:Quoted iep:Retracted ) ;
    ] ;
    sh:property [
        sh:path iep:epistemicConfidence ;
        sh:maxCount 1 ;
        sh:datatype xsd:double ;
        sh:minInclusive 0.0 ;
        sh:maxInclusive 1.0 ;
    ] .

# ── Trust Facet Shape ─────────────────────────────────────────

iep:TrustFacetShape a sh:NodeShape ;
    sh:targetClass iep:TrustFacet ;
    sh:property [
        sh:path iep:trustLevel ;
        sh:maxCount 1 ;
        sh:in ( iep:SelfAsserted iep:ThirdPartyAttested iep:CryptographicallyVerified ) ;
    ] .

# ── Access Control Facet Shape ────────────────────────────────

iep:AccessControlFacetShape a sh:NodeShape ;
    sh:targetClass iep:AccessControlFacet ;
    sh:or (
        [ sh:property [ sh:path iep:authorization ; sh:minCount 1 ] ]
        [ sh:property [ sh:path iep:policyRef ; sh:minCount 1 ] ]
    ) ;
    sh:message "AccessControlFacet must declare at least one access-control mode: iep:authorization (WAC) or iep:policyRef (ABAC)." .

# ── Federation Facet Shape ────────────────────────────────────

iep:FederationFacetShape a sh:NodeShape ;
    sh:targetClass iep:FederationFacet ;
    sh:property [
        sh:path iep:lastSynced ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
    ] .

# ── Kernel Result Shapes ──────────────────────────────────────
#
# Hypermedia + JSON-LD discipline: every kernel-verb response carries
# a SHACL shape IRI on iep:conformsToShape so validators see what to
# check without out-of-band schema. These shapes describe the
# *wire-level* result envelope each verb emits — they sit alongside
# the existing facet shapes above (which describe the underlying
# domain model).

@prefix hydra: <http://www.w3.org/ns/hydra/core#> .

# Base: every kernel result must carry a JSON-LD context + an @type
# + at least one iep:Affordance hint for next-step navigation.
iep:KernelResultShape a sh:NodeShape ;
    rdfs:comment "Generic shape every kernel-verb / shim response satisfies. Requires JSON-LD typing + a Hydra affordance set." ;
    sh:property [
        sh:path rdf:type ;
        sh:minCount 1 ;
        sh:message "Kernel result must declare at least one rdf:type." ;
    ] ;
    sh:property [
        sh:path iep:affordance ;
        sh:nodeKind sh:IRIOrBlankNode ;
        sh:message "Kernel result SHOULD carry at least one iep:Affordance for next-step navigation (hydra:Operation)." ;
    ] .

iep:HolonShape a sh:NodeShape ;
    rdfs:comment "A holon: dereferenceable IRI + level + kind (atom | fragment | descriptor | manifest | opaque)." ;
    sh:targetClass iep:Holon ;
    sh:property [
        sh:path iep:iri ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path iep:level ;
        sh:maxCount 1 ;
        sh:datatype xsd:nonNegativeInteger ;
    ] ;
    sh:property [
        sh:path iep:kind ;
        sh:maxCount 1 ;
        sh:in ( "atom" "fragment" "descriptor" "manifest" "opaque" ) ;
    ] .

iep:AffordanceShape a sh:NodeShape ;
    rdfs:comment "A iep:Affordance MUST be a hydra:Operation with at least iep:action + hydra:target + hydra:method." ;
    sh:targetClass iep:Affordance ;
    sh:property [
        sh:path rdf:type ;
        sh:hasValue hydra:Operation ;
        sh:message "Every iep:Affordance MUST also be typed hydra:Operation so Hydra clients can ingest it natively." ;
    ] ;
    sh:property [
        sh:path iep:action ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path hydra:target ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path hydra:method ;
        sh:minCount 1 ;
        sh:in ( "GET" "POST" "PUT" "PATCH" "DELETE" ) ;
    ] .

iep:DereferenceResultShape a sh:NodeShape ;
    rdfs:comment "Result of kernel.dereference — carries the fetched representation + extracted affordances." ;
    sh:property [
        sh:path iep:iri ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path iep:status ;
        sh:maxCount 1 ;
        sh:in ( "ok" "encrypted-no-key" "not-found" "error" ) ;
    ] .

iep:ComposeResultShape a sh:NodeShape ;
    rdfs:comment "Result of kernel.compose — emits a ComposedDescriptor witness." ;
    sh:property [
        sh:path iep:operand ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path iep:compositionOp ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
    ] .

iep:ActResultShape a sh:NodeShape ;
    rdfs:comment "Result of kernel.act — wraps an HTTP response and echoes the followed affordance." ;
    sh:property [
        sh:path iep:httpStatus ;
        sh:minCount 1 ;
        sh:datatype xsd:integer ;
    ] .

iep:PromoteResultShape a sh:NodeShape ;
    rdfs:comment "Result of kernel.promote — apex IRI + lattice level + optional pullback square." ;
    sh:property [
        sh:path iep:apex ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path iep:level ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:nonNegativeInteger ;
    ] .

iep:DecomposeResultShape a sh:NodeShape ;
    rdfs:comment "Result of kernel.decompose — pullback square (apex + left + right + overlap)." ;
    sh:property [
        sh:path iep:apex ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path iep:left ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path iep:right ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path iep:overlap ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] .

iep:ManifestShape a sh:NodeShape ;
    rdfs:comment "A pod's .well-known/context-graphs manifest is a hydra:Collection of iep:ContextDescriptor entries." ;
    sh:property [
        sh:path rdf:type ;
        sh:hasValue hydra:Collection ;
        sh:message "Manifest MUST be a hydra:Collection." ;
    ] .

iep:ToolResultShape a sh:NodeShape ;
    rdfs:comment "Base shape every named-tool shim response satisfies — same envelope discipline as kernel verbs." ;
    sh:property [
        sh:path rdf:type ;
        sh:minCount 1 ;
    ] ;
    sh:property [
        sh:path iep:affordance ;
        sh:nodeKind sh:IRIOrBlankNode ;
        sh:message "Shim result SHOULD advertise next-step affordances so callers can navigate without out-of-band knowledge." ;
    ] .

iep:RelayEntryPointShape a sh:NodeShape ;
    rdfs:comment "Hypermedia entry point document for the relay's HTTP surface — every operation listed MUST be a hydra:Operation." ;
    sh:property [
        sh:path rdf:type ;
        sh:hasValue hydra:EntryPoint ;
    ] ;
    sh:property [
        sh:path iep:affordance ;
        sh:minCount 1 ;
        sh:message "Entry point MUST list at least one navigable operation." ;
    ] .
` as const;

/**
 * Returns the SHACL shapes as a Turtle string.
 */
export function getShaclShapesTurtle(): string {
  return SHACL_SHAPES_TURTLE;
}
