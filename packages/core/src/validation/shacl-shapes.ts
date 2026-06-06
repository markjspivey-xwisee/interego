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
@prefix cg:    <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix sh:    <http://www.w3.org/ns/shacl#> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .
@prefix prov:  <http://www.w3.org/ns/prov#> .
@prefix rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .

# ── Context Descriptor Shape ──────────────────────────────────

cg:ContextDescriptorShape a sh:NodeShape ;
    sh:targetClass cg:ContextDescriptor ;
    sh:property [
        sh:path cg:hasFacet ;
        sh:minCount 1 ;
        sh:class cg:ContextFacet ;
        sh:message "A ContextDescriptor MUST have at least one facet." ;
    ] ;
    sh:property [
        sh:path cg:describes ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
        sh:message "A ContextDescriptor MUST describe at least one Named Graph." ;
    ] ;
    sh:property [
        sh:path cg:version ;
        sh:maxCount 1 ;
        sh:datatype xsd:nonNegativeInteger ;
    ] ;
    sh:property [
        sh:path cg:validFrom ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
    ] ;
    sh:property [
        sh:path cg:validUntil ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
    ] ;
    sh:sparql [
        sh:message "validUntil MUST be after validFrom when both are present." ;
        sh:select """
            SELECT $this WHERE {
                $this cg:validFrom ?from .
                $this cg:validUntil ?until .
                FILTER (?until <= ?from)
            }
        """ ;
    ] .

# ── Composed Descriptor Shape ─────────────────────────────────

cg:ComposedDescriptorShape a sh:NodeShape ;
    sh:targetClass cg:ComposedDescriptor ;
    sh:property [
        sh:path cg:compositionOp ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:class cg:CompositionOperator ;
    ] ;
    sh:property [
        sh:path cg:operand ;
        sh:minCount 1 ;
        sh:class cg:ContextDescriptor ;
    ] .

# ── Temporal Facet Shape ──────────────────────────────────────

cg:TemporalFacetShape a sh:NodeShape ;
    sh:targetClass cg:TemporalFacet ;
    sh:property [
        sh:path cg:validFrom ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
    ] ;
    sh:property [
        sh:path cg:validUntil ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
    ] ;
    sh:property [
        sh:path cg:temporalResolution ;
        sh:maxCount 1 ;
        sh:datatype xsd:duration ;
    ] ;
    sh:sparql [
        sh:message "Temporal facet validUntil MUST be after validFrom." ;
        sh:select """
            SELECT $this WHERE {
                $this cg:validFrom ?from .
                $this cg:validUntil ?until .
                FILTER (?until <= ?from)
            }
        """ ;
    ] .

# ── Provenance Facet Shape ────────────────────────────────────

cg:ProvenanceFacetShape a sh:NodeShape ;
    sh:targetClass cg:ProvenanceFacet ;
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

cg:AgentFacetShape a sh:NodeShape ;
    sh:targetClass cg:AgentFacet ;
    sh:property [
        sh:path cg:agentRole ;
        sh:maxCount 1 ;
    ] .

# ── Semiotic Facet Shape ──────────────────────────────────────

cg:SemioticFacetShape a sh:NodeShape ;
    sh:targetClass cg:SemioticFacet ;
    sh:property [
        sh:path cg:modalStatus ;
        sh:maxCount 1 ;
        sh:in ( cg:Asserted cg:Hypothetical cg:Counterfactual cg:Quoted cg:Retracted ) ;
    ] ;
    sh:property [
        sh:path cg:epistemicConfidence ;
        sh:maxCount 1 ;
        sh:datatype xsd:double ;
        sh:minInclusive 0.0 ;
        sh:maxInclusive 1.0 ;
    ] .

# ── Trust Facet Shape ─────────────────────────────────────────

cg:TrustFacetShape a sh:NodeShape ;
    sh:targetClass cg:TrustFacet ;
    sh:property [
        sh:path cg:trustLevel ;
        sh:maxCount 1 ;
        sh:in ( cg:SelfAsserted cg:ThirdPartyAttested cg:CryptographicallyVerified ) ;
    ] .

# ── Access Control Facet Shape ────────────────────────────────

cg:AccessControlFacetShape a sh:NodeShape ;
    sh:targetClass cg:AccessControlFacet ;
    sh:or (
        [ sh:property [ sh:path cg:authorization ; sh:minCount 1 ] ]
        [ sh:property [ sh:path cg:policyRef ; sh:minCount 1 ] ]
    ) ;
    sh:message "AccessControlFacet must declare at least one access-control mode: cg:authorization (WAC) or cg:policyRef (ABAC)." .

# ── Federation Facet Shape ────────────────────────────────────

cg:FederationFacetShape a sh:NodeShape ;
    sh:targetClass cg:FederationFacet ;
    sh:property [
        sh:path cg:lastSynced ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
    ] .

# ── Kernel Result Shapes ──────────────────────────────────────
#
# Hypermedia + JSON-LD discipline: every kernel-verb response carries
# a SHACL shape IRI on cg:conformsToShape so validators see what to
# check without out-of-band schema. These shapes describe the
# *wire-level* result envelope each verb emits — they sit alongside
# the existing facet shapes above (which describe the underlying
# domain model).

@prefix hydra: <http://www.w3.org/ns/hydra/core#> .

# Base: every kernel result must carry a JSON-LD context + an @type
# + at least one cg:Affordance hint for next-step navigation.
cg:KernelResultShape a sh:NodeShape ;
    rdfs:comment "Generic shape every kernel-verb / shim response satisfies. Requires JSON-LD typing + a Hydra affordance set." ;
    sh:property [
        sh:path rdf:type ;
        sh:minCount 1 ;
        sh:message "Kernel result must declare at least one rdf:type." ;
    ] ;
    sh:property [
        sh:path cg:affordance ;
        sh:nodeKind sh:IRIOrBlankNode ;
        sh:message "Kernel result SHOULD carry at least one cg:Affordance for next-step navigation (hydra:Operation)." ;
    ] .

cg:HolonShape a sh:NodeShape ;
    rdfs:comment "A holon: dereferenceable IRI + level + kind (atom | fragment | descriptor | manifest | opaque)." ;
    sh:targetClass cg:Holon ;
    sh:property [
        sh:path cg:iri ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path cg:level ;
        sh:maxCount 1 ;
        sh:datatype xsd:nonNegativeInteger ;
    ] ;
    sh:property [
        sh:path cg:kind ;
        sh:maxCount 1 ;
        sh:in ( "atom" "fragment" "descriptor" "manifest" "opaque" ) ;
    ] .

cg:AffordanceShape a sh:NodeShape ;
    rdfs:comment "A cg:Affordance MUST be a hydra:Operation with at least cg:action + hydra:target + hydra:method." ;
    sh:targetClass cg:Affordance ;
    sh:property [
        sh:path rdf:type ;
        sh:hasValue hydra:Operation ;
        sh:message "Every cg:Affordance MUST also be typed hydra:Operation so Hydra clients can ingest it natively." ;
    ] ;
    sh:property [
        sh:path cg:action ;
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

cg:DereferenceResultShape a sh:NodeShape ;
    rdfs:comment "Result of kernel.dereference — carries the fetched representation + extracted affordances." ;
    sh:property [
        sh:path cg:iri ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path cg:status ;
        sh:maxCount 1 ;
        sh:in ( "ok" "encrypted-no-key" "not-found" "error" ) ;
    ] .

cg:ComposeResultShape a sh:NodeShape ;
    rdfs:comment "Result of kernel.compose — emits a ComposedDescriptor witness." ;
    sh:property [
        sh:path cg:operand ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path cg:compositionOp ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
    ] .

cg:ActResultShape a sh:NodeShape ;
    rdfs:comment "Result of kernel.act — wraps an HTTP response and echoes the followed affordance." ;
    sh:property [
        sh:path cg:httpStatus ;
        sh:minCount 1 ;
        sh:datatype xsd:integer ;
    ] .

cg:PromoteResultShape a sh:NodeShape ;
    rdfs:comment "Result of kernel.promote — apex IRI + lattice level + optional pullback square." ;
    sh:property [
        sh:path cg:apex ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path cg:level ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:nonNegativeInteger ;
    ] .

cg:DecomposeResultShape a sh:NodeShape ;
    rdfs:comment "Result of kernel.decompose — pullback square (apex + left + right + overlap)." ;
    sh:property [
        sh:path cg:apex ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path cg:left ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path cg:right ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path cg:overlap ;
        sh:minCount 1 ;
        sh:nodeKind sh:IRI ;
    ] .

cg:ManifestShape a sh:NodeShape ;
    rdfs:comment "A pod's .well-known/context-graphs manifest is a hydra:Collection of cg:ContextDescriptor entries." ;
    sh:property [
        sh:path rdf:type ;
        sh:hasValue hydra:Collection ;
        sh:message "Manifest MUST be a hydra:Collection." ;
    ] .

cg:ToolResultShape a sh:NodeShape ;
    rdfs:comment "Base shape every named-tool shim response satisfies — same envelope discipline as kernel verbs." ;
    sh:property [
        sh:path rdf:type ;
        sh:minCount 1 ;
    ] ;
    sh:property [
        sh:path cg:affordance ;
        sh:nodeKind sh:IRIOrBlankNode ;
        sh:message "Shim result SHOULD advertise next-step affordances so callers can navigate without out-of-band knowledge." ;
    ] .

cg:RelayEntryPointShape a sh:NodeShape ;
    rdfs:comment "Hypermedia entry point document for the relay's HTTP surface — every operation listed MUST be a hydra:Operation." ;
    sh:property [
        sh:path rdf:type ;
        sh:hasValue hydra:EntryPoint ;
    ] ;
    sh:property [
        sh:path cg:affordance ;
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
