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
@prefix cg:    <https://interego.dev/ns/cg#> .
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
    sh:property [
        sh:path cg:authorization ;
        sh:minCount 1 ;
    ] .

# ── Federation Facet Shape ────────────────────────────────────

cg:FederationFacetShape a sh:NodeShape ;
    sh:targetClass cg:FederationFacet ;
    sh:property [
        sh:path cg:lastSynced ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
    ] .
` as const;

/**
 * Returns the SHACL shapes as a Turtle string.
 */
export function getShaclShapesTurtle(): string {
  return SHACL_SHAPES_TURTLE;
}
