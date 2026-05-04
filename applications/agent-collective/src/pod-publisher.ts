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

import { ContextDescriptor, publish, discover } from '../../../src/index.js';
import { createHash } from 'node:crypto';
import type { IRI } from '../../../src/index.js';
import {
  parseTrig,
  findSubjectsOfType,
  readStringValues,
  readIntegerValue,
  readIriValue,
} from '../../../src/rdf/turtle-parser.js';

const AC_NS = 'https://markjspivey-xwisee.github.io/interego/applications/agent-collective/ac#';
const CGH_NS = 'https://markjspivey-xwisee.github.io/interego/ns/harness#';
const CGH = (local: string): IRI => `${CGH_NS}${local}` as IRI;

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
  /** When true, the publisher consults the org pod for active
   *  cgh:PromotionConstraint descriptors and enforces them in
   *  addition to the threshold policy. Closes the gap noted in
   *  Demo 17's honest-scoping section: substrate-enforced
   *  downward causation rather than agent-mediated. */
  readonly enforceConstitutionalConstraints?: boolean;
}

export interface PromoteToolResult {
  readonly promotedToolIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
  /** Constraint IRIs that were consulted (empty when
   *  enforceConstitutionalConstraints was false). For audit. */
  readonly constraintsApplied: readonly IRI[];
}

interface PromotionConstraint {
  readonly iri: IRI;
  readonly requiredAxes: readonly string[];
  readonly minimumPeerAttestations?: number;
  readonly minimumSelfAttestations?: number;
  readonly ratifiedBy?: IRI;
}

/**
 * Discover active promotion constraints on the configured pod.
 * "Active" = the constraint descriptor is Asserted and not superseded
 * by a later descriptor.
 *
 * Constraints are typed cgh:PromotionConstraint descriptors. Each
 * declares a set of required attestation axes and (optionally)
 * minimum self/peer attestation counts that promote_tool must
 * satisfy in addition to its default threshold policy.
 *
 * Parser note: uses the project's TriG parser, which handles long-form
 * IRIs, datatyped/lang-tagged literals, comments, and string escapes.
 * Predicates are matched by full IRI (CGH_NS + local) — the input file's
 * choice of prefix label does not matter.
 *
 * Supersession is computed from the supersedes-edges across the
 * discovered set: if any descriptor's supersedes list names a target,
 * that target is excluded. The discover() result is the closed set we
 * compute against — multi-step chains (A ← B ← C) are handled because
 * both A and B will be named as supersedes-targets within the set.
 */
async function discoverPromotionConstraints(podUrl: string): Promise<PromotionConstraint[]> {
  const debug = process.env['DEBUG_PROMOTION_CONSTRAINTS'] === '1';
  let entries;
  try {
    entries = await discover(podUrl);
  } catch (err) {
    if (debug) console.error(`[constraint-discover] discover failed: ${(err as Error).message}`);
    return [];
  }
  if (debug) console.error(`[constraint-discover] discover returned ${entries.length} entries from ${podUrl}`);
  const supersededIris = new Set<string>();
  for (const e of entries) for (const s of (e.supersedes ?? [])) supersededIris.add(s);

  const PROMOTION_CONSTRAINT = CGH('PromotionConstraint');
  const REQUIRES_AXIS = CGH('requiresAttestationAxis');
  const REQUIRES_MIN_PEER = CGH('requiresMinimumPeerAttestations');
  const REQUIRES_MIN_SELF = CGH('requiresMinimumSelfAttestations');
  const RATIFIED_BY = CGH('ratifiedBy');

  const out: PromotionConstraint[] = [];
  for (const entry of entries) {
    if (debug) console.error(`[constraint-discover] entry ${entry.descriptorUrl.slice(-40)} modal=${entry.modalStatus} describes=${entry.describes.join(',').slice(0, 50)}`);
    if (entry.modalStatus !== 'Asserted') continue;
    if (supersededIris.has(entry.descriptorUrl)) continue;
    const graphUrl = entry.descriptorUrl.replace(/\.ttl$/, '-graph.trig');
    let trig: string;
    try {
      const r = await fetch(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
      if (!r.ok) { if (debug) console.error(`[constraint-discover]   graph fetch ${r.status}`); continue; }
      trig = await r.text();
    } catch (err) {
      if (debug) console.error(`[constraint-discover]   graph fetch error: ${(err as Error).message}`);
      continue;
    }

    let doc;
    try {
      doc = parseTrig(trig);
    } catch (err) {
      if (debug) console.error(`[constraint-discover]   parse error: ${(err as Error).message}`);
      continue;
    }
    const constraints = findSubjectsOfType(doc, PROMOTION_CONSTRAINT);
    if (debug) console.error(`[constraint-discover]   parsed; PromotionConstraint subjects=${constraints.length}`);
    if (constraints.length === 0) continue;

    for (const subj of constraints) {
      const subjectIri = typeof subj.subject === 'string'
        ? subj.subject
        : (entry.describes[0] ?? entry.descriptorUrl) as IRI;
      out.push({
        iri: subjectIri as IRI,
        requiredAxes: readStringValues(subj, REQUIRES_AXIS),
        minimumPeerAttestations: readIntegerValue(subj, REQUIRES_MIN_PEER),
        minimumSelfAttestations: readIntegerValue(subj, REQUIRES_MIN_SELF),
        ratifiedBy: readIriValue(subj, RATIFIED_BY),
      });
    }
  }
  return out;
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

  // Substrate-enforced constitutional constraints. Read active
  // PromotionConstraint descriptors from the pod and apply each as
  // an additional check. The default-threshold policy above is
  // operation-level; constraints are governance-level.
  const constraintsApplied: IRI[] = [];
  if (args.enforceConstitutionalConstraints) {
    const constraints = await discoverPromotionConstraints(config.podUrl);
    for (const c of constraints) {
      for (const axis of c.requiredAxes) {
        if (!args.axesCovered.includes(axis)) {
          throw new Error(`tool promotion REFUSED by constitutional constraint ${c.iri}: requires "${axis}" axis attestation, not present in [${args.axesCovered.join(', ')}]${c.ratifiedBy ? ` (ratified by ${c.ratifiedBy})` : ''}`);
        }
      }
      if (c.minimumPeerAttestations !== undefined && args.peerAttestations < c.minimumPeerAttestations) {
        throw new Error(`tool promotion REFUSED by constitutional constraint ${c.iri}: requires ≥${c.minimumPeerAttestations} peer attestations (got ${args.peerAttestations})${c.ratifiedBy ? ` (ratified by ${c.ratifiedBy})` : ''}`);
      }
      if (c.minimumSelfAttestations !== undefined && args.selfAttestations < c.minimumSelfAttestations) {
        throw new Error(`tool promotion REFUSED by constitutional constraint ${c.iri}: requires ≥${c.minimumSelfAttestations} self attestations (got ${args.selfAttestations})${c.ratifiedBy ? ` (ratified by ${c.ratifiedBy})` : ''}`);
      }
      constraintsApplied.push(c.iri);
    }
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
  return { promotedToolIri: promotedIri, descriptorUrl: result.descriptorUrl, graphUrl: result.graphUrl, constraintsApplied };
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
