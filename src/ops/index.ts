/**
 * @module ops
 * @description Operational event builders for SOC 2 evidence.
 *
 *   Each operational action that affects production (deploy, access change,
 *   wallet rotation, incident, quarterly review) becomes a compliance-grade
 *   descriptor on the operator's pod. This module produces the
 *   {graph_iri, graph_content, modal_status, compliance_framework} payload
 *   to feed into publish_context.
 *
 *   "Eat own dog food": the protocol that helps customers produce regulatory
 *   audit trails is the same protocol the operator uses to produce their
 *   own. See spec/SOC2-PREPARATION.md and spec/OPS-RUNBOOK.md.
 */

import type { ComplianceFramework } from '../compliance/index.js';
import { escapeTurtleLiteral as escapeLiteral } from '../rdf/escape.js';

/**
 * Common shape returned by every builder. The caller takes this object and
 * spreads it into publish_context (with compliance: true added).
 */
export interface OpsEventPayload {
  readonly graph_iri: string;
  readonly graph_content: string;
  readonly modal_status: 'Asserted' | 'Counterfactual';
  readonly compliance_framework: ComplianceFramework;
  /** SOC 2 (or other framework) control IRIs the descriptor cites. */
  readonly controls: readonly string[];
}

/** Common Turtle prefixes used across all ops events. */
const PREFIXES = [
  '@prefix soc2: <https://markjspivey-xwisee.github.io/interego/ns/soc2#> .',
  '@prefix dct: <http://purl.org/dc/terms/> .',
  '@prefix prov: <http://www.w3.org/ns/prov#> .',
  '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
  '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
].join('\n');

function nowIso(): string {
  return new Date().toISOString();
}

// Make a string safe to embed inside an IRI (URN segment). Anything outside
// the unreserved set defined by RFC 3986 §2.3 is percent-encoded so a hostile
// or merely awkward `component` like `relay"with"quotes` cannot break Turtle
// parsing. Note: `encodeURIComponent` over-encodes (it escapes ~, etc., which
// are RFC 3986 unreserved), but over-encoding is safe — under-encoding is not.
function encodeIriSegment(s: string): string {
  return encodeURIComponent(s);
}

// ── Deploy event ─────────────────────────────────────────────

export interface DeployEventInput {
  readonly component: string;        // e.g., "relay", "identity", "all"
  readonly commitSha: string;        // git SHA at deploy time
  readonly deployerDid: string;      // operator's DID
  readonly environment?: string;     // default "production"
  readonly rollbackPlan?: string;    // free-text or URL
  readonly timestamp?: string;       // ISO; default now
}

export function buildDeployEvent(input: DeployEventInput): OpsEventPayload {
  const ts = input.timestamp ?? nowIso();
  const env = input.environment ?? 'production';
  const componentSlug = encodeIriSegment(input.component);
  const eventIri = `urn:event:ops:deploy:${ts}:${componentSlug}`;
  const graphIri = `urn:graph:ops:deploy:${ts}:${componentSlug}`;
  const lines = [
    PREFIXES,
    '',
    `<${eventIri}> a soc2:DeployEvent ;`,
    `    rdfs:label "Production deploy of ${escapeLiteral(input.component)}" ;`,
    `    dct:conformsTo soc2:CC8.1 ;`,
    `    soc2:component "${escapeLiteral(input.component)}" ;`,
    `    soc2:commitSha "${escapeLiteral(input.commitSha)}" ;`,
    `    soc2:environment "${escapeLiteral(env)}" ;`,
    `    prov:wasAttributedTo <${input.deployerDid}> ;`,
    `    prov:generatedAtTime "${ts}"^^xsd:dateTime`,
    input.rollbackPlan
      ? `    ;\n    soc2:rollbackPlan "${escapeLiteral(input.rollbackPlan)}" .`
      : '    .',
  ];
  return {
    graph_iri: graphIri,
    graph_content: lines.join('\n'),
    modal_status: 'Asserted',
    compliance_framework: 'soc2',
    controls: ['soc2:CC8.1'],
  };
}

// ── Access change event ──────────────────────────────────────

export type AccessAction = 'granted' | 'revoked' | 'modified';

export interface AccessChangeInput {
  readonly action: AccessAction;
  readonly principal: string;        // DID or email
  readonly system: string;           // e.g., "azure", "github", "npm"
  readonly scope: string;            // role / permission scope
  readonly grantorDid: string;       // operator
  readonly justification: string;
  readonly timestamp?: string;
}

export function buildAccessChangeEvent(input: AccessChangeInput): OpsEventPayload {
  const ts = input.timestamp ?? nowIso();
  const eventIri = `urn:event:ops:access:${ts}`;
  const graphIri = `urn:graph:ops:access-change:${ts}`;
  const lines = [
    PREFIXES,
    '',
    `<${eventIri}> a soc2:AccessChangeEvent ;`,
    `    rdfs:label "Access ${input.action} for ${escapeLiteral(input.principal)} on ${escapeLiteral(input.system)}" ;`,
    `    dct:conformsTo soc2:CC6.2 ;`,
    `    soc2:accessAction "${input.action}" ;`,
    `    soc2:principal "${escapeLiteral(input.principal)}" ;`,
    `    soc2:system "${escapeLiteral(input.system)}" ;`,
    `    soc2:scope "${escapeLiteral(input.scope)}" ;`,
    `    soc2:justification "${escapeLiteral(input.justification)}" ;`,
    `    prov:wasAttributedTo <${input.grantorDid}> ;`,
    `    prov:generatedAtTime "${ts}"^^xsd:dateTime .`,
  ];
  return {
    graph_iri: graphIri,
    graph_content: lines.join('\n'),
    modal_status: 'Asserted',
    compliance_framework: 'soc2',
    controls: ['soc2:CC6.1', 'soc2:CC6.3'],
  };
}

// ── Wallet rotation event ────────────────────────────────────

export interface WalletRotationInput {
  readonly retiredAddress: string;
  readonly newActiveAddress: string;
  readonly reason: 'scheduled' | 'compromise-response' | 'other';
  readonly operatorDid: string;
  readonly note?: string;
  readonly timestamp?: string;
}

export function buildWalletRotationEvent(input: WalletRotationInput): OpsEventPayload {
  const ts = input.timestamp ?? nowIso();
  const eventIri = `urn:event:ops:wallet-rotation:${ts}`;
  const graphIri = `urn:graph:ops:wallet-rotation:${ts}`;
  const lines = [
    PREFIXES,
    '',
    `<${eventIri}> a soc2:KeyRotationEvent ;`,
    `    rdfs:label "Compliance wallet rotation (${input.reason})" ;`,
    `    dct:conformsTo soc2:CC6.7 ;`,
    `    soc2:rotationReason "${input.reason}" ;`,
    `    soc2:retiredKeyAddress "${escapeLiteral(input.retiredAddress)}" ;`,
    `    soc2:newKeyAddress "${escapeLiteral(input.newActiveAddress)}" ;`,
    `    prov:wasAttributedTo <${input.operatorDid}> ;`,
    `    prov:generatedAtTime "${ts}"^^xsd:dateTime`,
    input.note ? `    ;\n    rdfs:comment "${escapeLiteral(input.note)}" .` : '    .',
  ];
  return {
    graph_iri: graphIri,
    graph_content: lines.join('\n'),
    modal_status: 'Asserted',
    compliance_framework: 'soc2',
    controls: ['soc2:CC6.7'],
  };
}

// ── Incident event ───────────────────────────────────────────

export type IncidentSeverity = 'sev-1' | 'sev-2' | 'sev-3' | 'sev-4';

export interface IncidentInput {
  readonly severity: IncidentSeverity;
  readonly title: string;
  readonly summary: string;
  readonly detectedAt: string;        // ISO
  readonly detectionSource: string;   // alert name, customer report, manual
  readonly responderDid: string;
  readonly status: 'open' | 'contained' | 'resolved';
  readonly affectedComponents?: readonly string[];
  /** Predecessor incident descriptor URLs (when superseding for status update). */
  readonly supersedes?: readonly string[];
}

export function buildIncidentEvent(input: IncidentInput): OpsEventPayload {
  const ts = nowIso();
  const detectedSlug = encodeIriSegment(input.detectedAt);
  const eventIri = `urn:event:ops:incident:${detectedSlug}`;
  const graphIri = `urn:graph:ops:incident:${detectedSlug}`;
  const components = input.affectedComponents ?? [];
  const supersedes = input.supersedes ?? [];
  const lines = [
    PREFIXES,
    '',
    `<${eventIri}> a soc2:IncidentEvent ;`,
    `    rdfs:label "${escapeLiteral(input.title)}" ;`,
    `    dct:conformsTo soc2:CC7.3 ;`,
    `    soc2:incidentSeverity "${input.severity}" ;`,
    `    soc2:incidentStatus "${input.status}" ;`,
    `    soc2:summary "${escapeLiteral(input.summary)}" ;`,
    `    soc2:detectionSource "${escapeLiteral(input.detectionSource)}" ;`,
    `    soc2:detectedAt "${input.detectedAt}"^^xsd:dateTime ;`,
    `    prov:wasAttributedTo <${input.responderDid}> ;`,
    `    prov:generatedAtTime "${ts}"^^xsd:dateTime`,
    ...components.map(c => `    ;\n    soc2:affectedComponent "${escapeLiteral(c)}"`),
    ...supersedes.map(s => `    ;\n    prov:wasDerivedFrom <${s}>`),
    '    .',
  ];
  return {
    graph_iri: graphIri,
    graph_content: lines.join('\n'),
    modal_status: 'Asserted',
    compliance_framework: 'soc2',
    controls: input.status === 'resolved'
      ? ['soc2:CC7.3', 'soc2:CC7.4', 'soc2:CC7.5']
      : ['soc2:CC7.3'],
  };
}

// ── Quarterly review event ───────────────────────────────────

export type ReviewKind = 'access' | 'change' | 'risk' | 'vendor' | 'monitoring';

export interface QuarterlyReviewInput {
  readonly quarter: string;          // e.g., "2026-Q2"
  readonly kind: ReviewKind;
  readonly reviewerDid: string;
  readonly summary: string;          // what was reviewed
  readonly findingCount: number;
  readonly findings?: readonly string[];   // free-text findings
  readonly timestamp?: string;
}

const REVIEW_CONTROL_MAP: Record<ReviewKind, readonly string[]> = {
  access: ['soc2:CC6.1', 'soc2:CC6.2', 'soc2:CC6.3'],
  change: ['soc2:CC8.1'],
  risk: ['soc2:CC3.1', 'soc2:CC3.2'],
  vendor: ['soc2:CC9.2'],
  monitoring: ['soc2:CC4.1', 'soc2:CC4.2', 'soc2:CC7.2'],
};

export function buildQuarterlyReviewEvent(input: QuarterlyReviewInput): OpsEventPayload {
  const ts = input.timestamp ?? nowIso();
  const qSlug = encodeIriSegment(input.quarter);
  const kSlug = encodeIriSegment(input.kind);
  const eventIri = `urn:event:ops:review:${qSlug}:${kSlug}`;
  const graphIri = `urn:graph:ops:quarterly-review:${qSlug}:${kSlug}`;
  const findings = input.findings ?? [];
  const controls = REVIEW_CONTROL_MAP[input.kind];
  const lines = [
    PREFIXES,
    '',
    `<${eventIri}> a soc2:QuarterlyReviewEvent ;`,
    `    rdfs:label "${input.quarter} ${input.kind} review" ;`,
    ...controls.map(c => `    dct:conformsTo ${c} ;`),
    `    soc2:reviewQuarter "${input.quarter}" ;`,
    `    soc2:reviewKind "${input.kind}" ;`,
    `    soc2:summary "${escapeLiteral(input.summary)}" ;`,
    `    soc2:findingCount ${input.findingCount} ;`,
    `    prov:wasAttributedTo <${input.reviewerDid}> ;`,
    `    prov:generatedAtTime "${ts}"^^xsd:dateTime`,
    ...findings.map(f => `    ;\n    soc2:finding "${escapeLiteral(f)}"`),
    '    .',
  ];
  return {
    graph_iri: graphIri,
    graph_content: lines.join('\n'),
    modal_status: 'Asserted',
    compliance_framework: 'soc2',
    controls,
  };
}
