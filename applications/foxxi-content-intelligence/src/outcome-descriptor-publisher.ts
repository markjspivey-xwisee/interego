/**
 * Outcome / Situation / Teaching-Package → real Interego work-products.
 *
 * Each act on the Performance Architecture becomes a real iep:ContextDescriptor
 * published to the tenant's Solid pod, with its payload minted as a
 * content-addressed PGSL atom. The descriptor carries the canonical seven
 * facets, modal status, and (when the caller signs) a Provenance signature
 * over the outcome's content hash.
 *
 * This is the upward arm of the reflexive loop expressed in the protocol's
 * own primitives, instead of an in-memory accumulator:
 *
 *   agent action          → POST /performance/outcome  (signed by agent's DID)
 *   bridge publisher      → mint PGSL atom (content-address SHA-256)
 *                         → build iep:ContextDescriptor (7 facets)
 *                         → publish(descriptor, graph, pod)  // @interego/core
 *                         → pod now holds a discoverable, federated,
 *                           dereferenceable record at a stable URL
 *   bridge calibration    → discover(pod, { conformsTo: foxxi:Outcome })
 *                         → re-compose the calibration profile from the pod
 *
 * The bridge never relies on its own in-memory state as the source of truth;
 * the pod is. The in-memory mirror is a derived cache loaded at startup and
 * invalidated on every write.
 */

import {
  assertValid,
} from '@interego/core';
import {
  createPGSL,
  mintAtom,
} from '@interego/pgsl';
import {
  publish,
} from '@interego/solid';
import { verifyMessage } from 'ethers';
import type {
  AccessControlFacetData,
  AgentFacetData,
  ContextDescriptorData,
  ContextFacetData,
  FederationFacetData,
  FetchFn,
  IRI,
  ProvenanceFacetData,
  SemioticFacetData,
  TemporalFacetData,
  TrustFacetData,
} from '@interego/core';
import type {
  PGSLInstance,
} from '@interego/pgsl';
import type {
  PublishResult,
} from '@interego/solid';
import { createHash, randomUUID } from 'node:crypto';

// ── Foxxi vocabulary (composes the L1 iep:/pgsl: + ac:/amta: verticals) ──
//
// The Foxxi vertical's namespace IRIs. The vocabulary is published at
// /ns/foxxi on the bridge and is dereferenceable.

const FOXXI = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';
const AC = 'https://markjspivey-xwisee.github.io/interego/ns/ac/v1#';
const AMTA = 'https://markjspivey-xwisee.github.io/interego/ns/amta/v1#';

export const FOXXI_TYPES = {
  Outcome:            `${FOXXI}Outcome` as IRI,
  Situation:          `${FOXXI}Situation` as IRI,
  PerformancePlan:    `${FOXXI}PerformancePlan` as IRI,
  CalibrationCell:    `${FOXXI}CalibrationCell` as IRI,
  CalibrationProfile: `${FOXXI}CalibrationProfile` as IRI,
  TeachingTransfer:   `${FOXXI}TeachingTransfer` as IRI,
} as const;

export const AC_TYPES = {
  TeachingPackage: `${AC}TeachingPackage` as IRI,
} as const;

export const AMTA_TYPES = {
  Attestation: `${AMTA}Attestation` as IRI,
} as const;

// ── Shared publisher config ─────────────────────────────────

export interface DescriptorPublishConfig {
  /** Tenant pod root (e.g. https://interego-css..../foxxi/). Must end with /. */
  podUrl: string;
  /** did:web of the authoritative source for this tenant (prov:wasAttributedTo). */
  authoritativeSource: IRI;
  /** Authenticated fetch for pod PUTs. Defaults to globalThis.fetch. */
  fetch?: FetchFn;
  /** Container subpath inside the pod (e.g. 'foxxi/outcomes/'). */
  containerPath?: string;
  /** A persistent PGSL instance shared across the bridge process. */
  pgsl?: PGSLInstance;
}

/** A descriptor-publish result + the new IRIs it introduced. */
export interface PublishedDescriptor extends PublishResult {
  descriptorIri: IRI;
  graphIri: IRI;
  /** Content-addressed PGSL atom that holds the payload (urn:pgsl:atom:…). */
  payloadAtom: IRI;
  /** Canonical Foxxi type IRI (e.g. foxxi:Outcome). */
  foxxiType: IRI;
}

// ── Per-process PGSL instance — content-addressed and shared across publishes ──

let _processPgsl: PGSLInstance | null = null;
export function processPgsl(): PGSLInstance {
  if (_processPgsl) return _processPgsl;
  _processPgsl = createPGSL({
    wasAttributedTo: 'urn:foxxi:bridge:descriptor-publisher' as IRI,
    generatedAtTime: new Date().toISOString(),
  });
  return _processPgsl;
}

// ── Helpers ─────────────────────────────────────────────────

function contentHash(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Verify an ECDSA signature over the canonical content hash of the
 * payload. Returns true ONLY if the signer's recovered address matches
 * the agent's `did:key:<addr>` DID. Used by the publisher to decide
 * whether the descriptor's TrustFacet can carry `CryptographicallyVerified`
 * (verified signature) or downgrades to `SelfAsserted` (claimed DID,
 * no proof). The agent in the live demo signs `sha256:<hex>` of the
 * canonical JSON payload using its wallet — exactly what
 * verifyMessage() expects.
 */
export function verifySignature(args: {
  signature: string;
  agentDid: string;
  payloadJson: string;
}): { verified: boolean; recoveredAddress: string | null; signedMessage: string } {
  const message = `sha256:${contentHash(args.payloadJson)}`;
  try {
    const recovered = verifyMessage(message, args.signature);
    const did = args.agentDid.toLowerCase();
    const addrMatch = did.match(/0x[0-9a-f]{40}/);
    if (!addrMatch) return { verified: false, recoveredAddress: recovered, signedMessage: message };
    return {
      verified: recovered.toLowerCase() === addrMatch[0],
      recoveredAddress: recovered,
      signedMessage: message,
    };
  } catch {
    return { verified: false, recoveredAddress: null, signedMessage: message };
  }
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'descriptor';
}

/**
 * Build a graph fragment that ties together: the typed Foxxi entity,
 * a `pgsl:hasAtom` link to the content-addressed atom holding the
 * payload, and a base64-encoded `foxxi:bundleJson` literal carrying the
 * full payload inline (for callers that don't want to dereference the
 * atom). Provenance is `prov:wasAttributedTo`.
 */
function buildEntityGraph(args: {
  entityIri: IRI;
  typeIri: IRI;
  payloadAtom: IRI;
  authoritativeSource: IRI;
  authoredBy?: string;
  payload: unknown;
  signedPayloadJson?: string;
  agentSignature?: string;
}): string {
  // Use the agent's canonical signed bytes when present so the graph's
  // foxxi:bundleJson hashes identically to what the signature covers.
  const json = args.signedPayloadJson ?? JSON.stringify(args.payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const hash = contentHash(json);
  const lines: string[] = [];
  lines.push(`@prefix dct:   <http://purl.org/dc/terms/> .`);
  lines.push(`@prefix prov:  <http://www.w3.org/ns/prov#> .`);
  lines.push(`@prefix pgsl:  <https://markjspivey-xwisee.github.io/interego/ns/pgsl/v1#> .`);
  lines.push(`@prefix foxxi: <${FOXXI}> .`);
  lines.push(`@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .`);
  lines.push(``);
  lines.push(`<${args.entityIri}>`);
  lines.push(`  a <${args.typeIri}> ;`);
  lines.push(`  prov:wasAttributedTo <${args.authoritativeSource}> ;`);
  if (args.authoredBy) lines.push(`  prov:wasGeneratedBy <${args.authoredBy}> ;`);
  lines.push(`  pgsl:hasAtom <${args.payloadAtom}> ;`);
  lines.push(`  dct:identifier "sha256:${hash}" ;`);
  lines.push(`  foxxi:bundleJson "${b64}"^^xsd:base64Binary ;`);
  lines.push(`  foxxi:payloadByteLength "${json.length}"^^xsd:integer${args.agentSignature ? ' ;' : ' .'}`);
  if (args.agentSignature) {
    lines.push(`  foxxi:agentSignature "${args.agentSignature}" .`);
  }
  return lines.join('\n');
}

/** Build the seven-facet descriptor for a typed Foxxi entity. */
function buildDescriptor(args: {
  descriptorIri: IRI;
  entityIri: IRI;
  typeIri: IRI;
  authoritativeSource: IRI;
  authoredBy?: { id: string; kind: 'human' | 'agent'; role?: string };
  modalStatus?: 'Asserted' | 'Hypothetical' | 'Counterfactual';
  source?: string;
  trust?: ResolvedTrust;
}): ContextDescriptorData {
  const now = new Date().toISOString();
  const temporal: TemporalFacetData = { type: 'Temporal', validFrom: now };
  const provenance: ProvenanceFacetData = {
    type: 'Provenance',
    wasAttributedTo: args.authoritativeSource,
    ...(args.authoredBy ? { wasGeneratedBy: { agent: args.authoredBy.id as IRI, endedAt: now } } : {}),
    generatedAtTime: now,
  };
  const facets: ContextFacetData[] = [temporal, provenance];

  if (args.authoredBy) {
    const agentFacet: AgentFacetData = {
      type: 'Agent',
      assertingAgent: {
        id: args.authoredBy.id as IRI,
        identity: args.authoredBy.id as IRI,
        isSoftwareAgent: args.authoredBy.kind === 'agent',
        ...(args.authoredBy.role ? { label: args.authoredBy.role } : {}),
      },
    };
    facets.push(agentFacet);
  }

  // AccessControl: open within the tenant (WAC: Read for any authenticated
  // agent attributed to the tenant's authoritative source). Tighter policies
  // can be layered via policyRefs (ABAC) at a higher composition step.
  const accessControl: AccessControlFacetData = {
    type: 'AccessControl',
    authorizations: [
      { agentClass: 'http://xmlns.com/foaf/0.1/Agent' as IRI, mode: ['Read'] },
    ],
  };
  facets.push(accessControl);

  const semiotic: SemioticFacetData = {
    type: 'Semiotic',
    modalStatus: args.modalStatus ?? 'Asserted',
    ...((args.modalStatus ?? 'Asserted') === 'Asserted' ? { groundTruth: true as const } : {}),
  };
  facets.push(semiotic);

  const trust: TrustFacetData = {
    type: 'Trust',
    // Honest trust level: CryptographicallyVerified only if the caller
    // supplied a signature AND it actually verifies against the agent's
    // DID. SelfAsserted otherwise. Never just "claim verified by saying
    // so" — the publisher does the verification before stamping.
    trustLevel: args.trust?.trustLevel ?? (args.authoredBy ? 'SelfAsserted' : 'SelfAsserted'),
    ...(args.authoredBy ? { issuer: args.authoredBy.id as IRI } : { issuer: args.authoritativeSource }),
  };
  facets.push(trust);

  const federation: FederationFacetData = {
    type: 'Federation',
    origin: args.authoritativeSource,
    ...(args.source ? { source: args.source } : {}),
  };
  facets.push(federation);

  return {
    id: args.descriptorIri,
    describes: [args.entityIri],
    conformsTo: [args.typeIri],
    facets,
  };
}

// ── Core publish primitive ──────────────────────────────────

interface PublishEntityArgs {
  config: DescriptorPublishConfig;
  /** Slug prefix used in the pod path (e.g. 'outcome', 'situation'). */
  slugPrefix: string;
  /** The Foxxi type IRI this entity conforms to. */
  foxxiType: IRI;
  /** The opaque payload that will be atomized + base64'd into the graph. */
  payload: Record<string, unknown>;
  /** Who authored this (the agent acting). */
  authoredBy?: { id: string; kind: 'human' | 'agent'; role?: string };
  /** Detached ECDSA signature over the payload, if the caller supplied one. */
  agentSignature?: string;
  /**
   * The EXACT JSON bytes the agentSignature was computed over (the
   * agent's canonical payload string). When set, the publisher verifies
   * the signature against THESE bytes (not against a re-stringified
   * args.payload — JSON key order would diverge). Atomized + base64'd
   * into the graph instead of `JSON.stringify(payload)` so the on-pod
   * descriptor is byte-identical with what the agent signed and any
   * federation peer can re-verify with the same bytes.
   */
  signedPayloadJson?: string;
  /** Modal status to embed in the descriptor's Semiotic facet. */
  modalStatus?: 'Asserted' | 'Hypothetical' | 'Counterfactual';
  /** Optional tenant/source label for the Federation facet. */
  source?: string;
}

/**
 * Trust-level decision: the publisher only stamps
 * `CryptographicallyVerified` when the caller supplies a signature AND
 * the signature really verifies against the agent's DID. Otherwise the
 * descriptor's TrustFacet carries `SelfAsserted` (claimed DID, no
 * proof). Honest by construction.
 */
export type ResolvedTrust = {
  trustLevel: 'CryptographicallyVerified' | 'SelfAsserted' | 'ThirdPartyAttested';
  signatureVerified: boolean;
  recoveredAddress: string | null;
};

function resolveTrust(args: {
  authoredBy?: { id: string };
  payload: Record<string, unknown>;
  signature?: string;
  /** Exact bytes the signature was over, if the caller has them. */
  signedPayloadJson?: string;
}): ResolvedTrust {
  if (!args.authoredBy) return { trustLevel: 'SelfAsserted', signatureVerified: false, recoveredAddress: null };
  if (!args.signature) return { trustLevel: 'SelfAsserted', signatureVerified: false, recoveredAddress: null };
  const payloadJson = args.signedPayloadJson ?? JSON.stringify(args.payload);
  const result = verifySignature({
    signature: args.signature,
    agentDid: args.authoredBy.id,
    payloadJson,
  });
  if (result.verified) {
    return { trustLevel: 'CryptographicallyVerified', signatureVerified: true, recoveredAddress: result.recoveredAddress };
  }
  return { trustLevel: 'SelfAsserted', signatureVerified: false, recoveredAddress: result.recoveredAddress };
}

/**
 * Publish a typed Foxxi entity to the tenant pod:
 *   1. mint a content-addressed PGSL atom holding the payload
 *   2. build the entity graph that links the atom to the typed entity
 *   3. build a seven-facet iep:ContextDescriptor describing the entity
 *   4. write both to the pod via @interego/core publish()
 *   5. update the manifest (publish() handles this, with HTTP CAS)
 *
 * Returns the new descriptor + graph URLs + the atom URI so the caller
 * (or downstream agents via discover()) can follow the affordances.
 */
export async function publishFoxxiEntity(args: PublishEntityArgs): Promise<PublishedDescriptor & { trust: ResolvedTrust }> {
  const pgsl = args.config.pgsl ?? processPgsl();
  // Atomize the EXACT signed bytes when present — guarantees that the
  // pod's content-addressed atom hashes the same value the agent signed,
  // and that federation peers re-verifying the descriptor key off the
  // same canonical bytes.
  const payloadJson = args.signedPayloadJson ?? JSON.stringify(args.payload);
  const payloadAtom = mintAtom(pgsl, payloadJson);

  // Honest trust evaluation: if caller supplied a signature, verify it
  // really; downgrade the trust level if it fails. The descriptor only
  // ever stamps CryptographicallyVerified when there's a real signature
  // that really verifies against the agent's DID.
  const trust = resolveTrust({
    authoredBy: args.authoredBy,
    payload: args.payload,
    signature: args.agentSignature,
    signedPayloadJson: args.signedPayloadJson,
  });

  const uid = randomUUID().slice(0, 8);
  const slug = `${args.slugPrefix}-${uid}`;
  const entityIri = `urn:foxxi:${args.slugPrefix}:${uid}` as IRI;
  const descriptorIri = `${entityIri}#descriptor` as IRI;

  const graphContent = buildEntityGraph({
    entityIri,
    typeIri: args.foxxiType,
    payloadAtom,
    authoritativeSource: args.config.authoritativeSource,
    authoredBy: args.authoredBy?.id,
    payload: args.payload,
    signedPayloadJson: args.signedPayloadJson,
    agentSignature: args.agentSignature,
  });

  const descriptor = buildDescriptor({
    descriptorIri,
    entityIri,
    typeIri: args.foxxiType,
    authoritativeSource: args.config.authoritativeSource,
    authoredBy: args.authoredBy,
    modalStatus: args.modalStatus,
    source: args.source,
    trust,
  });

  // SHACL-equivalent validation: assertValid() walks the seven-facet
  // shape and throws if any required field is missing or any value
  // violates the L1 spec. Catches drift before it lands in the pod.
  try {
    assertValid(descriptor);
  } catch (err) {
    throw new Error(`outcome-descriptor-publisher: descriptor failed L1 validation — ${(err as Error).message}`);
  }

  const publishResult = await publish(descriptor, graphContent, args.config.podUrl, {
    fetch: args.config.fetch ?? globalThis.fetch.bind(globalThis),
    containerPath: args.config.containerPath ?? 'foxxi/work-products/',
    descriptorSlug: slug,
    graphSlug: `${slug}-graph`,
  });

  return {
    ...publishResult,
    descriptorIri,
    graphIri: entityIri,
    payloadAtom,
    foxxiType: args.foxxiType,
    trust,
  };
}

// ── Typed helpers per entity ────────────────────────────────

export async function publishOutcomeDescriptor(
  outcome: Record<string, unknown>,
  author: { id: string; kind: 'human' | 'agent'; role?: string } | undefined,
  signature: string | undefined,
  config: DescriptorPublishConfig,
  signedPayloadJson?: string,
): Promise<PublishedDescriptor> {
  return publishFoxxiEntity({
    config,
    slugPrefix: 'outcome',
    foxxiType: FOXXI_TYPES.Outcome,
    payload: outcome,
    authoredBy: author,
    agentSignature: signature,
    signedPayloadJson,
    modalStatus: 'Asserted',
    source: typeof outcome.source === 'string' ? outcome.source : 'live',
  });
}

export async function publishSituationDescriptor(
  payload: Record<string, unknown>,
  author: { id: string; kind: 'human' | 'agent'; role?: string } | undefined,
  config: DescriptorPublishConfig,
): Promise<PublishedDescriptor> {
  return publishFoxxiEntity({
    config,
    slugPrefix: 'situation',
    foxxiType: FOXXI_TYPES.Situation,
    payload,
    authoredBy: author,
    modalStatus: 'Asserted',
  });
}

export async function publishPerformancePlanDescriptor(
  payload: Record<string, unknown>,
  author: { id: string; kind: 'human' | 'agent'; role?: string } | undefined,
  config: DescriptorPublishConfig,
): Promise<PublishedDescriptor> {
  return publishFoxxiEntity({
    config,
    slugPrefix: 'plan',
    foxxiType: FOXXI_TYPES.PerformancePlan,
    payload,
    authoredBy: author,
    modalStatus: 'Asserted',
  });
}

export async function publishTeachingPackageDescriptor(
  payload: Record<string, unknown>,
  teacher: { id: string; kind: 'agent' },
  config: DescriptorPublishConfig,
): Promise<PublishedDescriptor> {
  return publishFoxxiEntity({
    config,
    slugPrefix: 'teaching-package',
    foxxiType: AC_TYPES.TeachingPackage,
    payload,
    authoredBy: { ...teacher, role: 'teacher' },
    modalStatus: 'Hypothetical', // a teaching package starts hypothetical until verified
  });
}

export async function publishTeachingAttestationDescriptor(
  payload: Record<string, unknown>,
  attestor: { id: string; kind: 'agent' },
  config: DescriptorPublishConfig,
): Promise<PublishedDescriptor> {
  return publishFoxxiEntity({
    config,
    slugPrefix: 'teaching-attestation',
    foxxiType: AMTA_TYPES.Attestation,
    payload,
    authoredBy: { ...attestor, role: 'attestor' },
    modalStatus: 'Asserted',
  });
}

export async function publishParticipationClaimDescriptor(
  payload: { name: string; did: string; address: string; claim: string; signature: string; agentRoleHint?: string },
  config: DescriptorPublishConfig,
): Promise<PublishedDescriptor & { trust: ResolvedTrust }> {
  return publishFoxxiEntity({
    config,
    slugPrefix: `participation-${payload.name.toLowerCase()}-${payload.address.slice(2, 12).toLowerCase()}`,
    foxxiType: `${FOXXI}ParticipationClaim` as IRI,
    payload: {
      name: payload.name,
      did: payload.did,
      address: payload.address,
      claim: payload.claim,
      signature: payload.signature,
      ...(payload.agentRoleHint ? { agentRoleHint: payload.agentRoleHint } : {}),
    },
    authoredBy: { id: payload.did, kind: 'agent', role: payload.agentRoleHint ?? 'collective-participant' },
    agentSignature: payload.signature,
    modalStatus: 'Asserted',
  });
}

export async function publishCalibrationSnapshotDescriptor(
  payload: Record<string, unknown>,
  author: { id: string; kind: 'human' | 'agent'; role?: string } | undefined,
  signature: string | undefined,
  config: DescriptorPublishConfig,
  signedPayloadJson?: string,
): Promise<PublishedDescriptor> {
  return publishFoxxiEntity({
    config,
    slugPrefix: 'calibration-snapshot',
    foxxiType: FOXXI_TYPES.CalibrationProfile,
    payload,
    authoredBy: author,
    agentSignature: signature,
    signedPayloadJson,
    modalStatus: 'Asserted',
    source: 'tenant-recompose',
  });
}
