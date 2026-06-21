/**
 * @module rdf/jsonld
 * @description JSON-LD 1.1 serialization for Interego 1.0
 *
 * Produces compact JSON-LD using the Interego @context document
 * defined in §7 of the specification.
 *
 * Reuses: JSON-LD 1.1 [Rec]
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
  ModalStatus,
} from '../model/types.js';

// ── JSON-LD Context Document (§7) ────────────────────────────

export const CONTEXT_GRAPHS_JSONLD_CONTEXT_URL =
  'https://markjspivey-xwisee.github.io/interego/ns/iep/v1' as const;

export const CONTEXT_GRAPHS_JSONLD_CONTEXT = {
  '@context': {
    '@version': 1.1,
    iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#',
    cg: 'https://markjspivey-xwisee.github.io/interego/ns/cg#', // @deprecated legacy read-alias so pre-rename JSON-LD still expands
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    prov: 'http://www.w3.org/ns/prov#',
    time: 'http://www.w3.org/2006/time#',
    dct: 'http://purl.org/dc/terms/',
    as: 'https://www.w3.org/ns/activitystreams#',
    acl: 'http://www.w3.org/ns/auth/acl#',
    vc: 'https://www.w3.org/2018/credentials#',
    dcat: 'http://www.w3.org/ns/dcat#',
    oa: 'http://www.w3.org/ns/oa#',

    ContextDescriptor: 'iep:ContextDescriptor',
    ComposedDescriptor: 'iep:ComposedDescriptor',
    TemporalFacet: 'iep:TemporalFacet',
    ProvenanceFacet: 'iep:ProvenanceFacet',
    AgentFacet: 'iep:AgentFacet',
    AccessControlFacet: 'iep:AccessControlFacet',
    SemioticFacet: 'iep:SemioticFacet',
    TrustFacet: 'iep:TrustFacet',
    FederationFacet: 'iep:FederationFacet',

    describes: { '@id': 'iep:describes', '@type': '@id' },
    hasFacet: { '@id': 'iep:hasFacet' },
    compositionOp: { '@id': 'iep:compositionOp', '@type': '@id' },
    operand: { '@id': 'iep:operand', '@type': '@id', '@container': '@set' },
    restrictToType: { '@id': 'iep:restrictToType', '@type': '@id', '@container': '@set' },
    supersedes: { '@id': 'iep:supersedes', '@type': '@id' },
    version: { '@id': 'iep:version', '@type': 'xsd:nonNegativeInteger' },

    validFrom: { '@id': 'iep:validFrom', '@type': 'xsd:dateTime' },
    validUntil: { '@id': 'iep:validUntil', '@type': 'xsd:dateTime' },
    temporalResolution: { '@id': 'iep:temporalResolution', '@type': 'xsd:duration' },

    wasGeneratedBy: { '@id': 'prov:wasGeneratedBy' },
    wasDerivedFrom: { '@id': 'prov:wasDerivedFrom', '@type': '@id' },
    wasAttributedTo: { '@id': 'prov:wasAttributedTo', '@type': '@id' },
    generatedAtTime: { '@id': 'prov:generatedAtTime', '@type': 'xsd:dateTime' },

    assertingAgent: { '@id': 'iep:assertingAgent' },
    onBehalfOf: { '@id': 'iep:onBehalfOf', '@type': '@id' },
    agentRole: { '@id': 'iep:agentRole', '@type': '@id' },
    agentIdentity: { '@id': 'iep:agentIdentity', '@type': '@id' },

    interpretationFrame: { '@id': 'iep:interpretationFrame', '@type': '@id' },
    signSystem: { '@id': 'iep:signSystem', '@type': '@id' },
    modalStatus: { '@id': 'iep:modalStatus', '@type': '@id' },
    epistemicConfidence: { '@id': 'iep:epistemicConfidence', '@type': 'xsd:double' },
    groundTruth: { '@id': 'iep:groundTruth', '@type': 'xsd:boolean' },

    trustLevel: { '@id': 'iep:trustLevel', '@type': '@id' },
    issuer: { '@id': 'iep:issuer', '@type': '@id' },
    proofMechanism: { '@id': 'iep:proofMechanism', '@type': '@id' },

    origin: { '@id': 'iep:origin', '@type': '@id' },
    storageEndpoint: { '@id': 'iep:storageEndpoint', '@type': '@id' },
    syncProtocol: { '@id': 'iep:syncProtocol', '@type': '@id' },
    replicaOf: { '@id': 'iep:replicaOf', '@type': '@id' },
    lastSynced: { '@id': 'iep:lastSynced', '@type': 'xsd:dateTime' },
  },
} as const;

// ── Facet → JSON-LD object ───────────────────────────────────

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const result = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v;
  }
  return result as T;
}

function serializeTemporalFacet(f: TemporalFacetData): Record<string, unknown> {
  return stripUndefined({
    '@type': 'TemporalFacet',
    validFrom: f.validFrom,
    validUntil: f.validUntil,
    temporalResolution: f.temporalResolution,
    temporalRelation: f.temporalRelation,
  });
}

function serializeProvenanceFacet(f: ProvenanceFacetData): Record<string, unknown> {
  const result: Record<string, unknown> = { '@type': 'ProvenanceFacet' };

  if (f.wasGeneratedBy) {
    const activity: Record<string, unknown> = { '@type': 'prov:Activity' };
    if (f.wasGeneratedBy.agent) activity['prov:wasAssociatedWith'] = f.wasGeneratedBy.agent;
    if (f.wasGeneratedBy.startedAt) activity['prov:startedAtTime'] = f.wasGeneratedBy.startedAt;
    if (f.wasGeneratedBy.endedAt) activity['prov:endedAtTime'] = f.wasGeneratedBy.endedAt;
    if (f.wasGeneratedBy.used?.length) activity['prov:used'] = f.wasGeneratedBy.used;
    result.wasGeneratedBy = activity;
  }

  if (f.wasDerivedFrom?.length) result.wasDerivedFrom = f.wasDerivedFrom;
  if (f.wasAttributedTo) result.wasAttributedTo = f.wasAttributedTo;
  if (f.generatedAtTime) result.generatedAtTime = f.generatedAtTime;

  return result;
}

function serializeAgentFacet(f: AgentFacetData): Record<string, unknown> {
  const result: Record<string, unknown> = { '@type': 'AgentFacet' };

  if (f.assertingAgent) {
    const agent: Record<string, unknown> = {};
    if (f.assertingAgent.isSoftwareAgent) {
      agent['@type'] = ['prov:SoftwareAgent', 'as:Application'];
    }
    if (f.assertingAgent.label) agent['rdfs:label'] = f.assertingAgent.label;
    if (f.assertingAgent.identity) agent.agentIdentity = f.assertingAgent.identity;
    result.assertingAgent = agent;
  }

  if (f.agentRole) result.agentRole = `iep:${f.agentRole}`;
  if (f.onBehalfOf) result.onBehalfOf = f.onBehalfOf;

  return result;
}

function serializeAccessControlFacet(f: AccessControlFacetData): Record<string, unknown> {
  const result: Record<string, unknown> = { '@type': 'AccessControlFacet' };

  result['iep:authorization'] = f.authorizations.map(auth => {
    const a: Record<string, unknown> = { '@type': 'acl:Authorization' };
    if (auth.agent) a['acl:agent'] = auth.agent;
    if (auth.agentClass) a['acl:agentClass'] = auth.agentClass;
    a['acl:mode'] = auth.mode.map(m => `acl:${m}`);
    return a;
  });

  if (f.consentBasis) result['iep:consentBasis'] = f.consentBasis;

  return result;
}

function serializeSemioticFacet(f: SemioticFacetData): Record<string, unknown> {
  return stripUndefined({
    '@type': 'SemioticFacet',
    interpretationFrame: f.interpretationFrame,
    signSystem: f.signSystem,
    groundTruth: f.groundTruth,
    modalStatus: f.modalStatus ? `iep:${f.modalStatus}` : undefined,
    epistemicConfidence: f.epistemicConfidence,
    'iep:languageTag': f.languageTag,
  });
}

function serializeTrustFacet(f: TrustFacetData): Record<string, unknown> {
  return stripUndefined({
    '@type': 'TrustFacet',
    'iep:verifiableCredential': f.verifiableCredential,
    issuer: f.issuer,
    proofMechanism: f.proofMechanism,
    trustLevel: f.trustLevel ? `iep:${f.trustLevel}` : undefined,
    'iep:revocationStatus': f.revocationStatus,
  });
}

function serializeFederationFacet(f: FederationFacetData): Record<string, unknown> {
  const result: Record<string, unknown> = { '@type': 'FederationFacet' };
  if (f.origin) result.origin = f.origin;
  if (f.storageEndpoint) result.storageEndpoint = f.storageEndpoint;
  if (f.endpointURL) result['dcat:endpointURL'] = f.endpointURL;
  if (f.syncProtocol) result.syncProtocol = `iep:${f.syncProtocol}`;
  if (f.replicaOf) result.replicaOf = f.replicaOf;
  if (f.lastSynced) result.lastSynced = f.lastSynced;

  if (f.distribution) {
    result['dcat:distribution'] = {
      '@type': 'dcat:Distribution',
      'dcat:mediaType': f.distribution.mediaType,
      'dcat:accessURL': f.distribution.accessURL,
    };
  }

  return result;
}

function serializeCausalFacet(f: CausalFacetData): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '@type': 'iep:CausalFacet',
    'iep:causalRole': f.causalRole,
  };
  if (f.causalModel) result['iep:causalModel'] = { '@id': f.causalModel };
  if (f.parentObservation) result['iep:parentObservation'] = { '@id': f.parentObservation };
  if (f.parentIntervention) result['iep:parentIntervention'] = { '@id': f.parentIntervention };
  if (f.effectSize !== undefined) result['iep:effectSize'] = f.effectSize;
  if (f.causalConfidence !== undefined) result['iep:causalConfidence'] = f.causalConfidence;
  if (f.interventions) {
    result['iep:intervenes'] = f.interventions.map(iv => ({
      '@type': 'iep:Intervention',
      'iep:intervenes': iv.variable,
      'iep:interventionValue': iv.value,
    }));
  }
  if (f.counterfactualQuery) {
    result['iep:counterfactualQuery'] = {
      'iep:counterfactualTarget': f.counterfactualQuery.target,
      'iep:intervenes': {
        '@type': 'iep:Intervention',
        'iep:intervenes': f.counterfactualQuery.intervention.variable,
        'iep:interventionValue': f.counterfactualQuery.intervention.value,
      },
      'iep:counterfactualEvidence': Object.entries(f.counterfactualQuery.evidence).map(
        ([k, v]) => ({ 'iep:causalVariable': k, 'iep:interventionValue': v })
      ),
    };
  }
  return result;
}

function serializeFacet(f: ContextFacetData): Record<string, unknown> {
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

function serializeProjectionFacet(f: ProjectionFacetData): Record<string, unknown> {
  const result: Record<string, unknown> = { '@type': 'iep:ProjectionFacet' };
  if (f.targetVocabulary) result['iep:targetVocabulary'] = { '@id': f.targetVocabulary };
  if (f.boundaryShapes) result['iep:boundaryShapes'] = { '@id': f.boundaryShapes };
  if (f.selective !== undefined) result['iep:selective'] = f.selective;
  if (f.bindings) {
    result['iep:binding'] = f.bindings.map(b => ({
      '@type': 'iep:ExternalBinding',
      'iep:describes': { '@id': b.source },
      'iep:binding': { '@id': b.target },
      'iep:bindingStrength': `iep:${b.strength}`,
      ...(b.confidence !== undefined ? { 'iep:epistemicConfidence': b.confidence } : {}),
    }));
  }
  if (f.vocabularyMappings) {
    result['iep:vocabularyMapping'] = f.vocabularyMappings.map(m => ({
      '@type': 'iep:VocabularyMapping',
      'iep:describes': { '@id': m.source },
      'iep:binding': { '@id': m.target },
      'iep:mappingType': m.mappingType,
      'iep:mappingRelationship': m.relationship,
    }));
  }
  return result;
}

// ── Main Serializer ──────────────────────────────────────────

export interface JsonLdOptions {
  /** Use the remote context URL instead of inlining (default: true) */
  remoteContext?: boolean;
  /** Pretty-print JSON (default: true) */
  pretty?: boolean;
}

/**
 * Serialize a ContextDescriptorData to compact JSON-LD.
 */
export function toJsonLd(
  descriptor: ContextDescriptorData,
  options: JsonLdOptions = {}
): Record<string, unknown> {
  const { remoteContext = true } = options;
  const isComposed = 'compositionOp' in descriptor;

  const doc: Record<string, unknown> = {
    '@context': remoteContext
      ? CONTEXT_GRAPHS_JSONLD_CONTEXT_URL
      : CONTEXT_GRAPHS_JSONLD_CONTEXT['@context'],
    '@id': descriptor.id,
    '@type': isComposed ? 'ComposedDescriptor' : 'ContextDescriptor',
  };

  if (descriptor.version !== undefined) doc.version = descriptor.version;
  if (descriptor.validFrom) doc.validFrom = descriptor.validFrom;
  if (descriptor.validUntil) doc.validUntil = descriptor.validUntil;

  if (descriptor.describes.length === 1) {
    doc.describes = descriptor.describes[0];
  } else {
    doc.describes = descriptor.describes;
  }

  if (descriptor.supersedes?.length) {
    doc.supersedes = descriptor.supersedes;
  }

  // Composition metadata
  if (isComposed) {
    const comp = descriptor as ComposedDescriptorData;
    doc.compositionOp = `iep:${comp.compositionOp}`;
    doc.operand = comp.operands;
    if (comp.restrictToTypes?.length) {
      doc.restrictToType = comp.restrictToTypes.map(t => `iep:${t}`);
    }
  }

  // Facets
  doc.hasFacet = descriptor.facets.map(serializeFacet);

  return doc;
}

/**
 * Serialize to a JSON-LD string.
 */
export function toJsonLdString(
  descriptor: ContextDescriptorData,
  options: JsonLdOptions = {}
): string {
  const { pretty = true } = options;
  const doc = toJsonLd(descriptor, options);
  return JSON.stringify(doc, null, pretty ? 2 : undefined);
}

/**
 * Parse a JSON-LD object back to ContextDescriptorData.
 * (Expects compact form using the CG context.)
 */
export function fromJsonLd(doc: Record<string, unknown>): ContextDescriptorData {
  const id = doc['@id'] as string;
  const describes = Array.isArray(doc.describes)
    ? doc.describes as string[]
    : [doc.describes as string];

  const facetDocs = (doc.hasFacet ?? []) as Record<string, unknown>[];

  // Strip the protocol prefix from a compact term, accepting BOTH the new `iep:`
  // and the legacy `cg:` so descriptors authored before the Interego-Protocol
  // rename still deserialize.
  const stripNs = (v: string | undefined): string | undefined => v?.replace(/^(iep|cg):/, '');
  const facets: ContextFacetData[] = facetDocs.map(fd => {
    const type = stripNs(fd['@type'] as string) as string;
    switch (type) {
      case 'TemporalFacet':
        return {
          type: 'Temporal' as const,
          validFrom: fd.validFrom as string | undefined,
          validUntil: fd.validUntil as string | undefined,
          temporalResolution: fd.temporalResolution as string | undefined,
        };
      case 'SemioticFacet':
        return {
          type: 'Semiotic' as const,
          modalStatus: stripNs(fd.modalStatus as string) as
            ModalStatus | undefined,
          epistemicConfidence: fd.epistemicConfidence as number | undefined,
          interpretationFrame: fd.interpretationFrame as string | undefined,
          signSystem: fd.signSystem as string | undefined,
          groundTruth: fd.groundTruth as boolean | undefined,
        };
      case 'TrustFacet':
        return {
          type: 'Trust' as const,
          trustLevel: stripNs(fd.trustLevel as string) as
            | 'SelfAsserted' | 'ThirdPartyAttested' | 'CryptographicallyVerified'
            | undefined,
          issuer: fd.issuer as string | undefined,
        };
      // Extend as needed; for now return a minimal typed object
      default:
        return { type: type.replace('Facet', '') as ContextFacetData['type'] } as ContextFacetData;
    }
  });

  return {
    id: id as string,
    describes,
    facets,
    version: doc.version as number | undefined,
    validFrom: doc.validFrom as string | undefined,
    validUntil: doc.validUntil as string | undefined,
  };
}
