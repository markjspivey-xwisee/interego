/**
 * @module rdf/serializer
 * @description Turtle and TriG serialization for Interego 1.0
 *
 * Generates valid Turtle [RDF12-TURTLE] / TriG [RDF12-TRIG] output
 * for ContextDescriptorData instances, using prefixed names for all
 * reused W3C vocabularies.
 */

import type {
  ContextDescriptorData,
  ContextFacetData,
  TemporalFacetData,
  ProvenanceFacetData,
  AgentFacetData,
  AccessControlFacetData,
  SemioticFacetData,
  TrustFacetData,
  FederationFacetData,
  CausalFacetData,
  ProjectionFacetData,
  ComposedDescriptorData,
  TripleContextAnnotation,
  TripleTerm,
  Literal,
} from '../model/types.js';

import {
  turtlePrefixes,
} from './namespaces.js';

// ── Helpers ──────────────────────────────────────────────────

function iri(value: string): string {
  return `<${value}>`;
}

function literal(value: string | number | boolean, datatype?: string): string {
  if (typeof value === 'boolean') {
    return `"${value}"^^xsd:boolean`;
  }
  if (typeof value === 'number') {
    // Explicit datatype overrides auto-inference. Needed because
    // properties like cg:epistemicConfidence are normatively xsd:double
    // (range declared in cg.ttl) — without the override, values like
    // 0 or 1 would serialize as xsd:integer and fail a SHACL
    // sh:datatype xsd:double constraint.
    if (datatype) {
      // Ensure the serialized form has a decimal for xsd:double so a
      // strict parser (e.g. rdf-validate-shacl) won't reject "1"^^xsd:double.
      const text = datatype === 'xsd:double' && Number.isInteger(value)
        ? value.toFixed(1)
        : String(value);
      return `"${text}"^^${datatype}`;
    }
    return Number.isInteger(value)
      ? `"${value}"^^xsd:integer`
      : `"${value}"^^xsd:double`;
  }
  if (datatype) {
    return `"${value}"^^${datatype}`;
  }
  return `"${value}"`;
}

function dateTimeLit(dt: string): string {
  return `"${dt}"^^xsd:dateTime`;
}

// ── Blank node emitter ───────────────────────────────────────

function bnode(properties: string[]): string {
  return `[\n${properties.map(p => `        ${p}`).join(' ;\n')}\n    ]`;
}

// ── Facet serializers ────────────────────────────────────────

function serializeTemporalFacet(f: TemporalFacetData): string {
  const props: string[] = ['a cg:TemporalFacet'];
  if (f.validFrom) props.push(`cg:validFrom ${dateTimeLit(f.validFrom)}`);
  if (f.validUntil) props.push(`cg:validUntil ${dateTimeLit(f.validUntil)}`);
  if (f.temporalResolution) {
    props.push(`cg:temporalResolution "${f.temporalResolution}"^^xsd:duration`);
  }
  if (f.temporalRelation) props.push(`cg:temporalRelation ${iri(f.temporalRelation)}`);
  return bnode(props);
}

function serializeProvenanceFacet(f: ProvenanceFacetData): string {
  const props: string[] = ['a cg:ProvenanceFacet'];

  if (f.wasGeneratedBy) {
    const actProps: string[] = ['a prov:Activity'];
    if (f.wasGeneratedBy.agent) {
      actProps.push(`prov:wasAssociatedWith ${iri(f.wasGeneratedBy.agent)}`);
    }
    if (f.wasGeneratedBy.startedAt) {
      actProps.push(`prov:startedAtTime ${dateTimeLit(f.wasGeneratedBy.startedAt)}`);
    }
    if (f.wasGeneratedBy.endedAt) {
      actProps.push(`prov:endedAtTime ${dateTimeLit(f.wasGeneratedBy.endedAt)}`);
    }
    if (f.wasGeneratedBy.used) {
      for (const u of f.wasGeneratedBy.used) {
        actProps.push(`prov:used ${iri(u)}`);
      }
    }
    props.push(`prov:wasGeneratedBy ${bnode(actProps)}`);
  }

  if (f.wasDerivedFrom) {
    for (const d of f.wasDerivedFrom) {
      props.push(`prov:wasDerivedFrom ${iri(d)}`);
    }
  }
  if (f.wasAttributedTo) props.push(`prov:wasAttributedTo ${iri(f.wasAttributedTo)}`);
  if (f.generatedAtTime) props.push(`prov:generatedAtTime ${dateTimeLit(f.generatedAtTime)}`);

  return bnode(props);
}

function serializeAgentFacet(f: AgentFacetData): string {
  const props: string[] = ['a cg:AgentFacet'];

  if (f.assertingAgent) {
    const agentProps: string[] = [];
    if (f.assertingAgent.isSoftwareAgent) {
      agentProps.push('a prov:SoftwareAgent, as:Application');
    } else {
      agentProps.push('a prov:Agent');
    }
    if (f.assertingAgent.label) {
      agentProps.push(`rdfs:label "${f.assertingAgent.label}"`);
    }
    if (f.assertingAgent.identity) {
      agentProps.push(`cg:agentIdentity ${iri(f.assertingAgent.identity)}`);
    }
    props.push(`cg:assertingAgent ${bnode(agentProps)}`);
  }

  if (f.agentRole) props.push(`cg:agentRole cg:${f.agentRole}`);
  if (f.onBehalfOf) props.push(`cg:onBehalfOf ${iri(f.onBehalfOf)}`);

  return bnode(props);
}

function serializeAccessControlFacet(f: AccessControlFacetData): string {
  const props: string[] = ['a cg:AccessControlFacet'];

  for (const auth of f.authorizations) {
    const authProps: string[] = ['a acl:Authorization'];
    if (auth.agent) authProps.push(`acl:agent ${iri(auth.agent)}`);
    if (auth.agentClass) authProps.push(`acl:agentClass ${iri(auth.agentClass)}`);
    for (const mode of auth.mode) {
      authProps.push(`acl:mode acl:${mode}`);
    }
    props.push(`cg:authorization ${bnode(authProps)}`);
  }

  if (f.consentBasis) props.push(`cg:consentBasis ${iri(f.consentBasis)}`);

  return bnode(props);
}

function serializeSemioticFacet(f: SemioticFacetData): string {
  const props: string[] = ['a cg:SemioticFacet'];
  if (f.interpretationFrame) props.push(`cg:interpretationFrame ${iri(f.interpretationFrame)}`);
  if (f.signSystem) props.push(`cg:signSystem ${iri(f.signSystem)}`);
  if (f.groundTruth !== undefined) props.push(`cg:groundTruth ${literal(f.groundTruth)}`);
  if (f.modalStatus) props.push(`cg:modalStatus cg:${f.modalStatus}`);
  if (f.epistemicConfidence !== undefined) {
    // cg:epistemicConfidence is normatively xsd:double (range in cg.ttl) —
    // force the datatype so integer-valued confidences (0, 1) don't
    // serialize as xsd:integer and fail the core-1.0 SHACL datatype shape.
    props.push(`cg:epistemicConfidence ${literal(f.epistemicConfidence, 'xsd:double')}`);
  }
  if (f.languageTag) props.push(`cg:languageTag "${f.languageTag}"^^xsd:language`);
  // Revocation Extension — Proposal B (spec/revocation.md). Each
  // condition emits as a nested blank node so federation readers can
  // evaluate the successor query without decrypting the payload.
  if (f.revokedIf && f.revokedIf.length > 0) {
    for (const rc of f.revokedIf) {
      const rcProps: string[] = ['a cg:RevocationCondition'];
      // SPARQL query as a triple-quoted literal — keeps multiline + embedded quotes sane.
      const q = rc.successorQuery.replace(/\\/g, '\\\\');
      rcProps.push(`cg:successorQuery """${q}"""`);
      if (rc.evaluationScope) rcProps.push(`cg:evaluationScope cg:${rc.evaluationScope}`);
      if (rc.onRevocation) rcProps.push(`cg:onRevocation cg:${rc.onRevocation}`);
      if (rc.revocationIssuer) rcProps.push(`cg:revocationIssuer ${iri(rc.revocationIssuer)}`);
      props.push(`cg:revokedIf ${bnode(rcProps)}`);
    }
  }

  return bnode(props);
}

function serializeTrustFacet(f: TrustFacetData): string {
  const props: string[] = ['a cg:TrustFacet'];
  if (f.verifiableCredential) props.push(`cg:verifiableCredential ${iri(f.verifiableCredential)}`);
  if (f.issuer) props.push(`cg:issuer ${iri(f.issuer)}`);
  if (f.proofMechanism) props.push(`cg:proofMechanism ${iri(f.proofMechanism)}`);
  if (f.trustLevel) props.push(`cg:trustLevel cg:${f.trustLevel}`);
  if (f.revocationStatus) props.push(`cg:revocationStatus ${iri(f.revocationStatus)}`);

  if (f.proof) {
    const proofProps: string[] = [
      `cg:proofScheme "${f.proof.scheme}"`,
      `cg:proofUrl ${iri(f.proof.proofUrl)}`,
    ];
    if (f.proof.signer) proofProps.push(`cg:proofSigner "${f.proof.signer}"`);
    props.push(`cg:proof ${bnode(proofProps)}`);
  }

  return bnode(props);
}

function serializeFederationFacet(f: FederationFacetData): string {
  const props: string[] = ['a cg:FederationFacet'];
  if (f.origin) props.push(`cg:origin ${iri(f.origin)}`);
  if (f.storageEndpoint) props.push(`cg:storageEndpoint ${iri(f.storageEndpoint)}`);
  if (f.endpointURL) props.push(`dcat:endpointURL ${iri(f.endpointURL)}`);
  if (f.syncProtocol) props.push(`cg:syncProtocol cg:${f.syncProtocol}`);
  if (f.replicaOf) props.push(`cg:replicaOf ${iri(f.replicaOf)}`);
  if (f.lastSynced) props.push(`cg:lastSynced ${dateTimeLit(f.lastSynced)}`);

  if (f.distribution) {
    const distProps: string[] = [
      'a dcat:Distribution',
      `dcat:mediaType "${f.distribution.mediaType}"`,
      `dcat:accessURL ${iri(f.distribution.accessURL)}`,
    ];
    props.push(`dcat:distribution ${bnode(distProps)}`);
  }

  return bnode(props);
}

function serializeCausalFacet(f: CausalFacetData): string {
  const props: string[] = ['a cg:CausalFacet'];
  props.push(`cg:causalRole cg:${f.causalRole}`);

  if (f.causalModel) props.push(`cg:causalModel ${iri(f.causalModel)}`);
  if (f.parentObservation) props.push(`cg:parentObservation ${iri(f.parentObservation)}`);
  if (f.parentIntervention) props.push(`cg:parentIntervention ${iri(f.parentIntervention)}`);
  if (f.effectSize !== undefined) props.push(`cg:effectSize ${literal(f.effectSize)}`);
  if (f.causalConfidence !== undefined) props.push(`cg:causalConfidence ${literal(f.causalConfidence)}`);

  // Serialize interventions
  if (f.interventions && f.interventions.length > 0) {
    for (const iv of f.interventions) {
      const ivProps: string[] = [
        'a cg:Intervention',
        `cg:intervenes "${iv.variable}"`,
        `cg:interventionValue "${iv.value}"`,
      ];
      props.push(`cg:intervenes ${bnode(ivProps)}`);
    }
  }

  // Serialize counterfactual query
  if (f.counterfactualQuery) {
    const cfProps: string[] = [
      `cg:counterfactualTarget "${f.counterfactualQuery.target}"`,
    ];
    const iv = f.counterfactualQuery.intervention;
    cfProps.push(`cg:intervenes ${bnode([
      'a cg:Intervention',
      `cg:intervenes "${iv.variable}"`,
      `cg:interventionValue "${iv.value}"`,
    ])}`);
    for (const [varName, value] of Object.entries(f.counterfactualQuery.evidence)) {
      cfProps.push(`cg:counterfactualEvidence ${bnode([
        `cg:causalVariable "${varName}"`,
        `cg:interventionValue "${value}"`,
      ])}`);
    }
    props.push(`cg:counterfactualQuery ${bnode(cfProps)}`);
  }

  // Serialize inline SCM
  if (f.causalModelData) {
    const scm = f.causalModelData;
    const scmProps: string[] = [
      'a cg:StructuralCausalModel',
    ];
    if (scm.label) scmProps.push(`rdfs:label "${scm.label}"`);
    for (const v of scm.variables) {
      const vProps: string[] = [
        'a cg:CausalVariable',
        `rdfs:label "${v.name}"`,
      ];
      if (v.exogenous) vProps.push(`cg:exogenous ${literal(true)}`);
      if (v.mechanism) vProps.push(`cg:mechanism "${v.mechanism}"`);
      if (v.causes) {
        for (const c of v.causes) {
          vProps.push(`cg:causes "${c}"`);
        }
      }
      scmProps.push(`cg:causalVariable ${bnode(vProps)}`);
    }
    for (const e of scm.edges) {
      const eProps: string[] = [
        'a cg:CausalEdge',
        `cg:causes "${e.from}" ;`,
        `cg:effectOf "${e.to}"`,
      ];
      if (e.mechanism) eProps.push(`cg:mechanism "${e.mechanism}"`);
      if (e.strength !== undefined) eProps.push(`cg:causalConfidence ${literal(e.strength)}`);
      scmProps.push(`cg:causalEdge ${bnode(eProps)}`);
    }
    props.push(`cg:causalModel ${bnode(scmProps)}`);
  }

  return bnode(props);
}

function serializeProjectionFacet(f: ProjectionFacetData): string {
  const props: string[] = ['a cg:ProjectionFacet'];

  if (f.targetVocabulary) props.push(`cg:targetVocabulary ${iri(f.targetVocabulary)}`);
  if (f.boundaryShapes) props.push(`cg:boundaryShapes ${iri(f.boundaryShapes)}`);
  if (f.selective !== undefined) props.push(`cg:selective ${literal(f.selective)}`);

  if (f.bindings) {
    for (const b of f.bindings) {
      const bProps: string[] = [
        'a cg:ExternalBinding',
        `cg:describes ${iri(b.source)}`,
        `cg:binding ${iri(b.target)}`,
        `cg:bindingStrength cg:${b.strength}`,
      ];
      if (b.confidence !== undefined) bProps.push(`cg:epistemicConfidence ${literal(b.confidence)}`);
      if (b.targetVocabulary) bProps.push(`cg:targetVocabulary ${iri(b.targetVocabulary)}`);
      if (b.assertedBy) bProps.push(`prov:wasAttributedTo ${iri(b.assertedBy)}`);
      props.push(`cg:binding ${bnode(bProps)}`);
    }
  }

  if (f.vocabularyMappings) {
    for (const m of f.vocabularyMappings) {
      const mProps: string[] = [
        'a cg:VocabularyMapping',
        `cg:describes ${iri(m.source)}`,
        `cg:binding ${iri(m.target)}`,
        `cg:mappingType "${m.mappingType}"`,
        `cg:mappingRelationship "${m.relationship}"`,
      ];
      props.push(`cg:vocabularyMapping ${bnode(mProps)}`);
    }
  }

  if (f.exposedEntities) {
    for (const e of f.exposedEntities) props.push(`cg:exposedEntity ${iri(e)}`);
  }
  if (f.hiddenEntities) {
    for (const e of f.hiddenEntities) props.push(`cg:hiddenEntity ${iri(e)}`);
  }

  return bnode(props);
}

function serializeFacet(f: ContextFacetData): string {
  switch (f.type) {
    case 'Temporal':      return serializeTemporalFacet(f);
    case 'Provenance':    return serializeProvenanceFacet(f);
    case 'Agent':         return serializeAgentFacet(f);
    case 'AccessControl': return serializeAccessControlFacet(f);
    case 'Semiotic':      return serializeSemioticFacet(f);
    case 'Trust':         return serializeTrustFacet(f);
    case 'Federation':    return serializeFederationFacet(f);
    case 'Causal':        return serializeCausalFacet(f);
    case 'Projection':    return serializeProjectionFacet(f);
    default:
      throw new Error(`Unknown facet type: ${(f as ContextFacetData).type}`);
  }
}

// ── Main Serializer ──────────────────────────────────────────

export interface SerializerOptions {
  /** Include prefix declarations (default: true) */
  prefixes?: boolean;
  /** Additional prefix bindings */
  extraPrefixes?: Record<string, string>;
  /** Pretty-print with blank lines between sections (default: true) */
  pretty?: boolean;
}

/**
 * Serialize a ContextDescriptorData to Turtle.
 */
export function toTurtle(
  descriptor: ContextDescriptorData,
  options: SerializerOptions = {}
): string {
  const { prefixes = true, extraPrefixes } = options;
  const lines: string[] = [];

  // Prefixes
  if (prefixes) {
    lines.push(turtlePrefixes());
    if (extraPrefixes) {
      for (const [prefix, ns] of Object.entries(extraPrefixes)) {
        lines.push(`@prefix ${prefix}: <${ns}> .`);
      }
    }
    lines.push('');
  }

  // Descriptor header
  const isComposed = 'compositionOp' in descriptor;
  const rdfType = isComposed ? 'cg:ComposedDescriptor' : 'cg:ContextDescriptor';

  const props: string[] = [`a ${rdfType}`];

  // Version
  if (descriptor.version !== undefined) {
    props.push(`cg:version ${literal(descriptor.version)}`);
  }

  // Administrative validity
  if (descriptor.validFrom) {
    props.push(`cg:validFrom ${dateTimeLit(descriptor.validFrom)}`);
  }
  if (descriptor.validUntil) {
    props.push(`cg:validUntil ${dateTimeLit(descriptor.validUntil)}`);
  }

  // Supersedes
  if (descriptor.supersedes) {
    for (const s of descriptor.supersedes) {
      props.push(`cg:supersedes ${iri(s)}`);
    }
  }

  // conformsTo — cleartext-mirrored from dct:conformsTo in graph content
  if (descriptor.conformsTo) {
    for (const c of descriptor.conformsTo) {
      props.push(`dct:conformsTo ${iri(c)}`);
    }
  }

  // Described graphs
  for (const g of descriptor.describes) {
    props.push(`cg:describes ${iri(g)}`);
  }

  // Composition (for ComposedDescriptorData)
  if (isComposed) {
    const comp = descriptor as ComposedDescriptorData;
    props.push(`cg:compositionOp cg:${comp.compositionOp}`);
    for (const op of comp.operands) {
      props.push(`cg:operand ${iri(op)}`);
    }
    if (comp.restrictToTypes) {
      for (const t of comp.restrictToTypes) {
        props.push(`cg:restrictToType cg:${t}`);
      }
    }
  }

  // Facets
  for (const facet of descriptor.facets) {
    props.push(`cg:hasFacet ${serializeFacet(facet)}`);
  }

  // Assemble
  lines.push(`${iri(descriptor.id)}`);
  lines.push(props.map((p, i) => {
    const terminator = i === props.length - 1 ? ' .' : ' ;';
    return `    ${p}${terminator}`;
  }).join('\n'));

  return lines.join('\n') + '\n';
}

/**
 * Serialize multiple descriptors as a single Turtle document.
 */
export function toTurtleDocument(
  descriptors: readonly ContextDescriptorData[],
  options: SerializerOptions = {}
): string {
  if (descriptors.length === 0) return '';

  const first = toTurtle(descriptors[0]!, { ...options, prefixes: true });
  const rest = descriptors.slice(1).map(d =>
    toTurtle(d, { ...options, prefixes: false })
  );

  return [first, ...rest].join('\n');
}

// ── RDF 1.2 Triple Annotation Serialization ──────────────────

/**
 * Serialize a triple term (subject predicate object) to Turtle.
 */
function serializeTripleTerm(t: TripleTerm): string {
  const obj = typeof t.object === 'string'
    ? iri(t.object)
    : serializeLiteral(t.object as Literal);
  return `${iri(t.subject)} ${iri(t.predicate)} ${obj}`;
}

function serializeLiteral(lit: Literal): string {
  if (lit.language) return `"${lit.value}"@${lit.language}`;
  if (lit.datatype) return `"${lit.value}"^^<${lit.datatype}>`;
  return `"${lit.value}"`;
}

/**
 * Serialize a TripleContextAnnotation using RDF 1.2 annotation syntax.
 *
 * RDF 1.2 annotations attach metadata directly to triples using the
 * `{| ... |}` syntax, avoiding intermediate reification resources:
 *
 * ```turtle
 * <subject> <predicate> <object> {|
 *     prov:wasAttributedTo <agent> ;
 *     cg:epistemicConfidence "0.95"^^xsd:double
 * |} .
 * ```
 *
 * Each facet in the annotation is serialized as properties inside the
 * annotation block.
 */
export function toTripleAnnotationTurtle(
  annotation: TripleContextAnnotation,
  options: SerializerOptions = {},
): string {
  const { prefixes = true } = options;
  const lines: string[] = [];

  if (prefixes) {
    lines.push(turtlePrefixes());
    lines.push('');
  }

  const tripleStr = serializeTripleTerm(annotation.triple);

  if (annotation.facets.length === 0) {
    lines.push(`${tripleStr} .`);
    return lines.join('\n') + '\n';
  }

  // Collect annotation properties from all facets
  const annotationProps: string[] = [];
  for (const facet of annotation.facets) {
    // Flatten the facet serialization into annotation properties
    const facetStr = serializeFacet(facet);
    annotationProps.push(`cg:hasFacet ${facetStr}`);
  }

  lines.push(`${tripleStr} {|`);
  for (let i = 0; i < annotationProps.length; i++) {
    const terminator = i === annotationProps.length - 1 ? '' : ' ;';
    lines.push(`    ${annotationProps[i]}${terminator}`);
  }
  lines.push('|} .');

  return lines.join('\n') + '\n';
}

/**
 * Serialize multiple triple annotations as a Turtle document.
 */
export function toTripleAnnotationDocument(
  annotations: readonly TripleContextAnnotation[],
  options: SerializerOptions = {},
): string {
  if (annotations.length === 0) return '';

  const first = toTripleAnnotationTurtle(annotations[0]!, { ...options, prefixes: true });
  const rest = annotations.slice(1).map(a =>
    toTripleAnnotationTurtle(a, { ...options, prefixes: false })
  );

  return [first, ...rest].join('\n');
}
