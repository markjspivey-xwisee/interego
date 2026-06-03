/**
 * Affordance declarations for the lrs-adapter vertical.
 *
 * Boundary translator between Interego pods and external xAPI LRSes.
 * Capabilities declared here once; bridge derives MCP tool schemas
 * from this; protocol publishes as cg:Affordance for generic
 * discovery.
 */

import type { Affordance } from '../_shared/affordance-mcp/index.js';
import type { IRI } from '../../src/index.js';

const LRS_AFFORDANCES: ReadonlyArray<Affordance> = [
  {
    action: 'urn:cg:action:lrs:ingest-statement' as IRI,
    toolName: 'lrs.ingest_statement',
    title: 'Ingest one xAPI Statement from an LRS',
    description: 'Fetch a single xAPI Statement from an LRS by ID, project as cg:ContextDescriptor in the user\'s pod with lrs:StatementIngestion audit. Auto-negotiates xAPI version (2.0.0 preferred; falls back to 1.0.3 for legacy LRSes like SCORM Cloud).',
    method: 'POST',
    targetTemplate: '{base}/lrs/ingest_statement',
    inputs: [
      { name: 'statement_id', type: 'string', required: true, description: 'xAPI Statement UUID.' },
      { name: 'lrs_endpoint', type: 'string', required: true, description: 'LRS xAPI endpoint URL.' },
      { name: 'lrs_username', type: 'string', required: true, description: 'LRS Basic auth username (Activity Provider key).' },
      { name: 'lrs_password', type: 'string', required: true, description: 'LRS Basic auth password (Activity Provider secret).' },
      { name: 'lrs_preferred_version', type: 'string', required: false, description: 'Preferred xAPI version.', enum: ['2.0.0', '1.0.3'] },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'user_did', type: 'string', required: false, description: 'User DID.' },
    ],
    outputs: {
      description: 'IngestStatementResult — IRIs + URLs of the published cg:ContextDescriptor (Asserted lrs:StatementIngestion projection of the xAPI Statement) and the separate ingestion audit-row descriptor, plus the xAPI version that was negotiated with the LRS.',
      properties: {
        statementDescriptorIri: { type: 'string', description: 'IRI of the descriptor projecting the xAPI Statement (urn:cg:lrs-statement:<id>).' },
        ingestionAuditIri: { type: 'string', description: 'IRI of the separate lrs:StatementIngestion audit descriptor recording the ingestion event itself.' },
        descriptorUrl: { type: 'string', description: 'URL of the published statement-descriptor .ttl.' },
        auditUrl: { type: 'string', description: 'URL of the published audit-row .ttl.' },
        xapiVersion: { type: 'string', description: 'xAPI version negotiated with the LRS (2.0.0 or 1.0.3).' },
      },
      required: ['statementDescriptorIri', 'ingestionAuditIri', 'descriptorUrl', 'auditUrl', 'xapiVersion'],
    },
  },
  {
    action: 'urn:cg:action:lrs:ingest-statement-batch' as IRI,
    toolName: 'lrs.ingest_statement_batch',
    title: 'Ingest a batch of xAPI Statements from an LRS',
    description: 'Fetch a batch of xAPI Statements from an LRS by filter (verb / activity / agent / since / until / limit) and publish each as cg:ContextDescriptor in the user\'s pod.',
    method: 'POST',
    targetTemplate: '{base}/lrs/ingest_statement_batch',
    inputs: [
      { name: 'lrs_endpoint', type: 'string', required: true, description: 'LRS xAPI endpoint URL.' },
      { name: 'lrs_username', type: 'string', required: true, description: 'LRS Basic auth username.' },
      { name: 'lrs_password', type: 'string', required: true, description: 'LRS Basic auth password.' },
      { name: 'lrs_preferred_version', type: 'string', required: false, description: 'Preferred xAPI version.', enum: ['2.0.0', '1.0.3'] },
      { name: 'verb', type: 'string', required: false, description: 'Filter by verb IRI.' },
      { name: 'activity', type: 'string', required: false, description: 'Filter by activity IRI.' },
      { name: 'agent', type: 'object', required: false, description: 'Filter by xAPI Agent.' },
      { name: 'since', type: 'string', required: false, description: 'ISO timestamp lower bound.' },
      { name: 'until', type: 'string', required: false, description: 'ISO timestamp upper bound.' },
      { name: 'limit', type: 'integer', required: false, description: 'Max statements to fetch.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'user_did', type: 'string', required: false, description: 'User DID.' },
    ],
    outputs: {
      description: 'Array of IngestStatementResult — one entry per Statement ingested from the LRS filter window (sequential ingestion to avoid pod-manifest races).',
      properties: {
        results: {
          type: 'array',
          description: 'IngestStatementResult entries (statementDescriptorIri, ingestionAuditIri, descriptorUrl, auditUrl, xapiVersion). The handler returns the array itself as the top-level value; this property documents the entry shape.',
          items: {
            type: 'object',
            properties: {
              statementDescriptorIri: { type: 'string' },
              ingestionAuditIri: { type: 'string' },
              descriptorUrl: { type: 'string' },
              auditUrl: { type: 'string' },
              xapiVersion: { type: 'string' },
            },
            required: ['statementDescriptorIri', 'ingestionAuditIri', 'descriptorUrl', 'auditUrl', 'xapiVersion'],
          },
        },
      },
    },
  },
  {
    action: 'urn:cg:action:lrs:project-descriptor' as IRI,
    toolName: 'lrs.project_descriptor',
    title: 'Project a descriptor to an LRS as an xAPI Statement',
    description: 'Read an Asserted descriptor from the pod and project to xAPI Statement, POST to the LRS. Counterfactual ALWAYS skipped; Hypothetical skipped without opt-in; multi-narrative descriptors lossy with audit-loud lossNote rows.',
    method: 'POST',
    targetTemplate: '{base}/lrs/project_descriptor',
    inputs: [
      { name: 'descriptor_iri', type: 'string', required: true, description: 'IRI of the descriptor to project.' },
      { name: 'actor', type: 'object', required: true, description: 'xAPI Agent shape for the Statement actor.' },
      { name: 'verb_id', type: 'string', required: true, description: 'xAPI verb IRI.' },
      { name: 'object_id', type: 'string', required: true, description: 'xAPI Activity IRI.' },
      { name: 'verb_display', type: 'string', required: false, description: 'Verb display name.' },
      { name: 'object_name', type: 'string', required: false, description: 'Activity display name.' },
      { name: 'modal_status', type: 'string', required: false, description: 'Source descriptor\'s modal status.', enum: ['Asserted', 'Hypothetical', 'Counterfactual'] },
      { name: 'allow_hypothetical', type: 'boolean', required: false, description: 'When true and modal_status=Hypothetical, project anyway with audit-loud lossy markers.' },
      { name: 'coherent_narratives', type: 'array', required: false, description: 'Multiple coherent narratives — preserved in result.extensions; lossy=true flag set.', itemType: 'string' },
      { name: 'lrs_endpoint', type: 'string', required: true, description: 'LRS xAPI endpoint URL.' },
      { name: 'lrs_username', type: 'string', required: true, description: 'LRS Basic auth username.' },
      { name: 'lrs_password', type: 'string', required: true, description: 'LRS Basic auth password.' },
      { name: 'lrs_preferred_version', type: 'string', required: false, description: 'Preferred xAPI version.', enum: ['2.0.0', '1.0.3'] },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'user_did', type: 'string', required: false, description: 'User DID.' },
    ],
    outputs: {
      description: 'ProjectDescriptorResult — outcome of projecting an Asserted descriptor to an xAPI Statement against the LRS. Counterfactual descriptors are ALWAYS skipped; Hypothetical descriptors are skipped unless allow_hypothetical=true. Multi-narrative descriptors produce a lossy projection with audit-loud lossNote rows.',
      properties: {
        skipped: { type: 'boolean', description: 'True when the descriptor was not projected (e.g. Counterfactual, or Hypothetical without opt-in).' },
        skipReason: { type: 'string', description: 'Human-readable reason the projection was skipped (only set when skipped=true).' },
        statementId: { type: 'string', description: 'UUID of the Statement that was POSTed to the LRS (only set when skipped=false).' },
        lossy: { type: 'boolean', description: 'True when information was dropped or marked lossy (multi-narrative, allowed-Hypothetical, etc.).' },
        lossNotes: { type: 'array', description: 'Audit-loud per-row notes describing exactly what was lost or downgraded.', items: { type: 'string' } },
        xapiVersion: { type: 'string', description: 'xAPI version negotiated with the LRS (2.0.0 or 1.0.3).' },
        projectionAuditIri: { type: 'string', description: 'IRI of the lrs:Projection audit descriptor (when projection succeeded).' },
        auditUrl: { type: 'string', description: 'URL of the projection-audit .ttl on the pod (when projection succeeded).' },
      },
      required: ['skipped', 'lossy', 'lossNotes', 'xapiVersion'],
    },
  },
  {
    action: 'urn:cg:action:lrs:lrs-about' as IRI,
    toolName: 'lrs.lrs_about',
    title: 'Probe an LRS\'s supported xAPI versions',
    description: 'Probe the LRS\'s /xapi/about endpoint to discover supported xAPI versions. Useful diagnostic for understanding which Statement projection target is appropriate.',
    method: 'POST',
    targetTemplate: '{base}/lrs/lrs_about',
    inputs: [
      { name: 'lrs_endpoint', type: 'string', required: true, description: 'LRS xAPI endpoint URL.' },
      { name: 'lrs_username', type: 'string', required: true, description: 'LRS Basic auth username.' },
      { name: 'lrs_password', type: 'string', required: true, description: 'LRS Basic auth password.' },
      { name: 'lrs_preferred_version', type: 'string', required: false, description: 'Preferred xAPI version.', enum: ['2.0.0', '1.0.3'] },
    ],
    outputs: {
      description: 'AboutResponse — the /xapi/about probe result: which xAPI versions the LRS reports it supports, plus any vendor-specific extensions.',
      properties: {
        version: { type: 'array', description: 'xAPI versions the LRS advertises (e.g. ["2.0.0"], ["1.0.3"], or ["2.0.0", "1.0.3"]).', items: { type: 'string' } },
        extensions: { type: 'object', description: 'Vendor-specific /about extensions block. Shape varies by LRS implementation.', additionalProperties: true },
      },
      required: ['version'],
    },
  },
];

export const lrsAffordances = LRS_AFFORDANCES;
