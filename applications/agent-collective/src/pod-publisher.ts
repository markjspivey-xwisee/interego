/**
 * Pod-backed publishers for the agent-collective vertical.
 *
 * Multi-agent federation: tool authoring + attestation + teaching
 * packages + cross-bridge inter-agent coordination.
 *
 * Honesty discipline:
 *   - Fresh tools published Hypothetical
 *   - Asserted version requires accumulated attestations across multiple
 *     amta: axes (publisher REFUSES if threshold not met)
 *   - Teaching packages bundle artifact + practice context (cannot omit
 *     synthesis or constraints — partial teaching = silent collapse)
 *   - Every cross-agent action references a passport:DelegationCredential
 *   - Audit entries (ac:CrossAgentAuditEntry) live in human owner's pod
 */

import { ContextDescriptor, publish } from '../../../src/index.js';
import { createHash } from 'node:crypto';
import type { IRI } from '../../../src/index.js';

const AC_NS = 'https://markjspivey-xwisee.github.io/interego/applications/agent-collective/ac#';

function nowIso(): string { return new Date().toISOString(); }
function sha16(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16); }
function escapeLit(s: string): string { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function escapeMulti(s: string): string { return s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"'); }

export interface PublishConfig {
  readonly podUrl: string;
  readonly authoringAgentDid: IRI;
}

// ── 1. Author a tool (Hypothetical) ───────────────────────────────────

export interface AuthorToolArgs {
  readonly toolName: string;
  readonly sourceCode: string;
  readonly affordanceAction: string;  // IRI of the cg:Action
  readonly affordanceDescription?: string;
}

export interface AuthorToolResult {
  readonly toolIri: IRI;
  readonly atomIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

export async function authorTool(args: AuthorToolArgs, config: PublishConfig): Promise<AuthorToolResult> {
  if (!args.toolName.trim() || !args.sourceCode.trim()) throw new Error('tool requires name + sourceCode');
  if (!args.affordanceAction.trim()) throw new Error('tool requires an affordance action');

  const toolId = sha16(args.toolName + args.sourceCode);
  const toolIri = `urn:cg:tool:${args.toolName.replace(/[^a-zA-Z0-9-]/g, '-')}:${toolId}` as IRI;
  const graphIri = `urn:graph:ac:tool:${toolId}` as IRI;
  const atomIri = `urn:pgsl:atom:tool-source:${toolId}` as IRI;

  const desc = ContextDescriptor.create(toolIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso() })
    .hypothetical(0.4)
    .agent(config.authoringAgentDid)
    .selfAsserted(config.authoringAgentDid)
    .build();

  const graphContent = `@prefix ac:   <${AC_NS}> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix code: <https://markjspivey-xwisee.github.io/interego/ns/code#> .
@prefix pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<${toolIri}> a ac:AgentTool , code:Commit ;
    rdfs:label "${escapeLit(args.toolName)}" ;
    ac:authoredBy <${config.authoringAgentDid}> ;
    ac:toolSource <${atomIri}> ;
    cg:affordance [
        a cg:Affordance ;
        cg:action <${args.affordanceAction}> ;
        ${args.affordanceDescription ? `rdfs:comment "${escapeLit(args.affordanceDescription)}" ;` : ''}
    ] ;
    cg:modalStatus cg:Hypothetical ;
    prov:wasAttributedTo <${config.authoringAgentDid}> .

<${atomIri}> a pgsl:Atom ;
    pgsl:value """${escapeMulti(args.sourceCode)}""" ;
    cg:contentHash "${createHash('sha256').update(args.sourceCode, 'utf8').digest('hex')}" .
`;

  const result = await publish(desc, graphContent, config.podUrl);
  return { toolIri, atomIri, descriptorUrl: result.descriptorUrl, graphUrl: result.graphUrl };
}

// ── 2. Attest to a tool ──────────────────────────────────────────────

export interface AttestToolArgs {
  readonly toolIri: IRI;
  readonly axis: 'correctness' | 'efficiency' | 'safety' | 'generality';
  readonly rating: number;  // 0-1
  readonly direction: 'Self' | 'Peer';
  readonly executionEvidence?: IRI;
}

export interface AttestToolResult {
  readonly attestationIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

export async function attestTool(args: AttestToolArgs, config: PublishConfig): Promise<AttestToolResult> {
  if (args.rating < 0 || args.rating > 1) throw new Error('attestation rating must be in [0, 1]');

  const attId = sha16(args.toolIri + config.authoringAgentDid + args.axis + nowIso());
  const attIri = `urn:cg:attestation:${attId}` as IRI;
  const graphIri = `urn:graph:ac:attestation:${attId}` as IRI;

  const desc = ContextDescriptor.create(attIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso() })
    .asserted(0.95)
    .agent(config.authoringAgentDid)
    .selfAsserted(config.authoringAgentDid)
    .build();

  const evidenceTriple = args.executionEvidence ? `amta:fromExecution <${args.executionEvidence}> ;` : '';

  const graphContent = `@prefix ac:   <${AC_NS}> .
@prefix amta: <https://markjspivey-xwisee.github.io/interego/ns/amta#> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix prov: <http://www.w3.org/ns/prov#> .

<${attIri}> a amta:Attestation ;
    amta:attestsTo <${args.toolIri}> ;
    amta:axis amta:${args.axis} ;
    amta:rating "${args.rating}"^^<http://www.w3.org/2001/XMLSchema#double> ;
    ac:attestationDirection ac:${args.direction} ;
    ${evidenceTriple}
    prov:wasAttributedTo <${config.authoringAgentDid}> ;
    cg:modalStatus cg:Asserted .
`;

  const result = await publish(desc, graphContent, config.podUrl);
  return { attestationIri: attIri, descriptorUrl: result.descriptorUrl, graphUrl: result.graphUrl };
}

// ── 3. Promote tool when attestation threshold met ──────────────────

export interface PromoteToolArgs {
  readonly toolIri: IRI;
  /** Counts already verified by caller. Publisher enforces minimums. */
  readonly selfAttestations: number;
  readonly peerAttestations: number;
  readonly axesCovered: readonly string[];
  /** Threshold policy. Default: 5 self + 2 peer + ≥2 axes. */
  readonly thresholdSelf?: number;
  readonly thresholdPeer?: number;
  readonly thresholdAxes?: number;
}

export interface PromoteToolResult {
  readonly promotedToolIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

export async function promoteTool(args: PromoteToolArgs, config: PublishConfig): Promise<PromoteToolResult> {
  const tSelf = args.thresholdSelf ?? 5;
  const tPeer = args.thresholdPeer ?? 2;
  const tAxes = args.thresholdAxes ?? 2;

  if (args.selfAttestations < tSelf) {
    throw new Error(`tool promotion REFUSED: needs ≥${tSelf} self-attestations (got ${args.selfAttestations})`);
  }
  if (args.peerAttestations < tPeer) {
    throw new Error(`tool promotion REFUSED: needs ≥${tPeer} peer-attestations (got ${args.peerAttestations})`);
  }
  if (args.axesCovered.length < tAxes) {
    throw new Error(`tool promotion REFUSED: needs ≥${tAxes} amta axes covered (got ${args.axesCovered.length})`);
  }

  const promotedId = sha16(args.toolIri + 'attested');
  const promotedIri = `${args.toolIri}.attested` as IRI;
  const graphIri = `urn:graph:ac:tool-attested:${promotedId}` as IRI;

  const desc = ContextDescriptor.create(promotedIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso() })
    .asserted(0.85)
    .agent(config.authoringAgentDid)
    .selfAsserted(config.authoringAgentDid)
    .build();

  const axesTriples = args.axesCovered.map(a => `ac:axesCovered amta:${a}`).join(' , ');

  const graphContent = `@prefix ac:   <${AC_NS}> .
@prefix amta: <https://markjspivey-xwisee.github.io/interego/ns/amta#> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix code: <https://markjspivey-xwisee.github.io/interego/ns/code#> .

<${promotedIri}> a ac:AgentTool , code:Commit ;
    ac:attestedFrom <${args.toolIri}> ;
    cg:supersedes <${args.toolIri}> ;
    cg:modalStatus cg:Asserted ;
    ac:attestationThresholdMet [
        ac:selfAttestations ${args.selfAttestations} ;
        ac:peerAttestations ${args.peerAttestations} ;
        ${axesTriples}
    ] .
`;

  const result = await publish(desc, graphContent, config.podUrl);
  return { promotedToolIri: promotedIri, descriptorUrl: result.descriptorUrl, graphUrl: result.graphUrl };
}

// ── 4. Bundle teaching package (artifact + practice) ────────────────

export interface BundleTeachingPackageArgs {
  readonly toolIri: IRI;
  readonly narrativeFragmentIris: readonly IRI[];
  readonly synthesisIri: IRI;
  readonly constraintIri?: IRI;
  readonly capabilityEvolutionIri?: IRI;
  readonly olkeStage: 'Tacit' | 'Articulate' | 'Collective' | 'Institutional';
}

export interface BundleTeachingPackageResult {
  readonly teachingIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

export async function bundleTeachingPackage(args: BundleTeachingPackageArgs, config: PublishConfig): Promise<BundleTeachingPackageResult> {
  if (args.narrativeFragmentIris.length === 0) {
    throw new Error('teaching package REFUSED: no narrative fragments — partial teaching transfers artifact without practice context');
  }

  const tId = sha16(args.toolIri + args.synthesisIri);
  const tIri = `urn:cg:teaching:${tId}` as IRI;
  const graphIri = `urn:graph:ac:teaching:${tId}` as IRI;

  const desc = ContextDescriptor.create(tIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso() })
    .hypothetical(0.5)
    .agent(config.authoringAgentDid)
    .selfAsserted(config.authoringAgentDid)
    .build();

  const fragTriples = args.narrativeFragmentIris.map(f => `ac:teachesNarrative <${f}>`).join(' ;\n    ');
  const constraintTriple = args.constraintIri ? `ac:teachesConstraint <${args.constraintIri}> ;` : '';
  const ceTriple = args.capabilityEvolutionIri ? `ac:teachesCapabilityEvolution <${args.capabilityEvolutionIri}> ;` : '';

  const graphContent = `@prefix ac:   <${AC_NS}> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix olke: <https://markjspivey-xwisee.github.io/interego/ns/olke#> .

<${tIri}> a ac:TeachingPackage ;
    ac:teachesArtifact <${args.toolIri}> ;
    ${fragTriples} ;
    ac:teachesSynthesis <${args.synthesisIri}> ;
    ${constraintTriple}
    ${ceTriple}
    ac:olkeStage olke:${args.olkeStage} ;
    cg:modalStatus cg:Hypothetical .
`;

  const result = await publish(desc, graphContent, config.podUrl);
  return { teachingIri: tIri, descriptorUrl: result.descriptorUrl, graphUrl: result.graphUrl };
}

// ── 5. Cross-agent audit entry (lives in human owner's pod) ─────────

export interface RecordCrossAgentAuditArgs {
  readonly exchangeIri: IRI;
  readonly auditedAgentDid: IRI;
  readonly direction: 'Inbound' | 'Outbound';
  readonly humanOwnerDid: IRI;
}

export interface RecordCrossAgentAuditResult {
  readonly auditIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

export async function recordCrossAgentAudit(args: RecordCrossAgentAuditArgs, config: PublishConfig): Promise<RecordCrossAgentAuditResult> {
  const auditId = sha16(args.exchangeIri + args.direction + nowIso());
  const auditIri = `urn:cg:ac-audit:${auditId}` as IRI;
  const graphIri = `urn:graph:ac:audit:${auditId}` as IRI;

  const desc = ContextDescriptor.create(auditIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso() })
    .asserted(0.99)
    .agent(args.auditedAgentDid, 'AssertingAgent', args.humanOwnerDid)
    .selfAsserted(args.humanOwnerDid)
    .build();

  const graphContent = `@prefix ac:   <${AC_NS}> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix prov: <http://www.w3.org/ns/prov#> .

<${auditIri}> a ac:CrossAgentAuditEntry ;
    ac:exchange <${args.exchangeIri}> ;
    ac:auditedAgent <${args.auditedAgentDid}> ;
    ac:auditDirection ac:${args.direction} ;
    prov:wasAttributedTo <${args.humanOwnerDid}> ;
    cg:modalStatus cg:Asserted .
`;

  const result = await publish(desc, graphContent, config.podUrl);
  return { auditIri, descriptorUrl: result.descriptorUrl, graphUrl: result.graphUrl };
}
