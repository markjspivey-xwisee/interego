/**
 * @module rdf/serializer
 * @description Turtle and TriG serialization for Context Graphs 1.0
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
  ComposedDescriptorData,
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
    props.push(`cg:epistemicConfidence ${literal(f.epistemicConfidence)}`);
  }
  if (f.languageTag) props.push(`cg:languageTag "${f.languageTag}"^^xsd:language`);

  return bnode(props);
}

function serializeTrustFacet(f: TrustFacetData): string {
  const props: string[] = ['a cg:TrustFacet'];
  if (f.verifiableCredential) props.push(`cg:verifiableCredential ${iri(f.verifiableCredential)}`);
  if (f.issuer) props.push(`cg:issuer ${iri(f.issuer)}`);
  if (f.proofMechanism) props.push(`cg:proofMechanism ${iri(f.proofMechanism)}`);
  if (f.trustLevel) props.push(`cg:trustLevel cg:${f.trustLevel}`);
  if (f.revocationStatus) props.push(`cg:revocationStatus ${iri(f.revocationStatus)}`);

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

function serializeFacet(f: ContextFacetData): string {
  switch (f.type) {
    case 'Temporal':      return serializeTemporalFacet(f);
    case 'Provenance':    return serializeProvenanceFacet(f);
    case 'Agent':         return serializeAgentFacet(f);
    case 'AccessControl': return serializeAccessControlFacet(f);
    case 'Semiotic':      return serializeSemioticFacet(f);
    case 'Trust':         return serializeTrustFacet(f);
    case 'Federation':    return serializeFederationFacet(f);
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
