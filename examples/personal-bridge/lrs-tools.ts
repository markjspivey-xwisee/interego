/**
 * Personal-bridge MCP tools for the lrs-adapter vertical.
 *
 * Production-grade tools any MCP client can call to bridge between an
 * external xAPI LRS (open-source like Lrsql; proprietary like SCORM Cloud
 * or Watershed) and the user's pod:
 *
 *   lrs.ingest_statement       — fetch one Statement from LRS → pod
 *   lrs.ingest_statement_batch — fetch many Statements with filter → pod
 *   lrs.project_descriptor     — read descriptor from pod → POST to LRS
 *   lrs.lrs_about              — version-negotiation probe
 *
 * Honesty discipline:
 *   - Counterfactual descriptors are ALWAYS skipped (never projected)
 *   - Hypothetical descriptors are skipped UNLESS allowHypothetical=true
 *     (in which case lossy=true with audit-loud lossNote rows)
 *   - Multi-narrative syntheses are projected lossy (first narrative as
 *     result.response; remaining preserved in result.extensions)
 *   - Every ingest/project produces an audit row in the user's pod
 */

import {
  ingestStatementFromLrs,
  ingestStatementBatchFromLrs,
  projectDescriptorToLrs,
} from '../../applications/lrs-adapter/src/pod-publisher.js';
import { LrsClient } from '../../applications/lrs-adapter/src/lrs-client.js';
import type { IRI } from '@interego/core';

interface LrsConfig {
  endpoint: string;
  username: string;
  password: string;
  preferredVersion: '2.0.0' | '1.0.3';
  podUrl: string;
  userDid: IRI;
}

function lrsConfig(args: Record<string, unknown>): LrsConfig {
  const endpoint = (args['lrsEndpoint'] as string | undefined) ?? process.env['LRS_ENDPOINT'] ?? throwMissing('LRS_ENDPOINT or args.lrsEndpoint required');
  const username = (args['lrsUsername'] as string | undefined) ?? process.env['LRS_USERNAME'] ?? throwMissing('LRS_USERNAME or args.lrsUsername required');
  const password = (args['lrsPassword'] as string | undefined) ?? process.env['LRS_PASSWORD'] ?? throwMissing('LRS_PASSWORD or args.lrsPassword required');
  const preferredVersion = ((args['lrsPreferredVersion'] as string | undefined) ?? process.env['LRS_PREFERRED_VERSION'] ?? '2.0.0') as '2.0.0' | '1.0.3';
  const podUrl = (args['podUrl'] as string | undefined) ?? process.env['LRS_POD_URL'] ?? throwMissing('LRS_POD_URL or args.podUrl required');
  const userDid = ((args['userDid'] as string | undefined) ?? process.env['LRS_USER_DID'] ?? throwMissing('LRS_USER_DID or args.userDid required')) as IRI;
  return { endpoint, username, password, preferredVersion, podUrl, userDid };
}

function throwMissing(msg: string): never { throw new Error(msg); }

interface ToolHandler {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export function lrsTools(): Record<string, ToolHandler> {
  return {
    'lrs.ingest_statement': {
      description: 'Fetch a single xAPI Statement from an LRS by ID and publish as a cg:ContextDescriptor in the user\'s pod with lrs:StatementIngestion audit. Auto-negotiates xAPI version (2.0.0 preferred; falls back to 1.0.3 for legacy LRSes like SCORM Cloud).',
      inputSchema: {
        type: 'object',
        properties: {
          statementId: { type: 'string' },
          lrsEndpoint: { type: 'string' },
          lrsUsername: { type: 'string' },
          lrsPassword: { type: 'string' },
          lrsPreferredVersion: { type: 'string', enum: ['2.0.0', '1.0.3'] },
          podUrl: { type: 'string' },
          userDid: { type: 'string' },
        },
        required: ['statementId'],
      },
      handler: async (args) => {
        const cfg = lrsConfig(args);
        return await ingestStatementFromLrs(
          { endpoint: cfg.endpoint, auth: { username: cfg.username, password: cfg.password }, preferredVersion: cfg.preferredVersion },
          String(args['statementId']),
          { podUrl: cfg.podUrl, userDid: cfg.userDid },
        );
      },
    },

    'lrs.ingest_statement_batch': {
      description: 'Fetch a batch of xAPI Statements from an LRS by filter (verb / activity / agent / since / until / limit) and publish each as a cg:ContextDescriptor in the user\'s pod.',
      inputSchema: {
        type: 'object',
        properties: {
          verb: { type: 'string' },
          activity: { type: 'string' },
          agent: { type: 'object' },
          since: { type: 'string' },
          until: { type: 'string' },
          limit: { type: 'number' },
          lrsEndpoint: { type: 'string' },
          lrsUsername: { type: 'string' },
          lrsPassword: { type: 'string' },
          lrsPreferredVersion: { type: 'string' },
          podUrl: { type: 'string' },
          userDid: { type: 'string' },
        },
      },
      handler: async (args) => {
        const cfg = lrsConfig(args);
        return await ingestStatementBatchFromLrs(
          { endpoint: cfg.endpoint, auth: { username: cfg.username, password: cfg.password }, preferredVersion: cfg.preferredVersion },
          {
            verb: args['verb'] as string | undefined,
            activity: args['activity'] as string | undefined,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            agent: args['agent'] as any,
            since: args['since'] as string | undefined,
            until: args['until'] as string | undefined,
            limit: args['limit'] as number | undefined,
          },
          { podUrl: cfg.podUrl, userDid: cfg.userDid },
        );
      },
    },

    'lrs.project_descriptor': {
      description: 'Read an Asserted descriptor from the pod and project to xAPI Statement, POST to the LRS. Counterfactual descriptors are ALWAYS skipped; Hypothetical descriptors skipped unless allowHypothetical=true (lossy with audit). Multi-narrative descriptors projected lossy (first narrative as result.response; rest in extensions). Every projection writes an lrs:StatementProjection audit row.',
      inputSchema: {
        type: 'object',
        properties: {
          descriptorIri: { type: 'string' },
          actor: { type: 'object' },
          verbId: { type: 'string' },
          objectId: { type: 'string' },
          verbDisplay: { type: 'string' },
          objectName: { type: 'string' },
          modalStatus: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'] },
          allowHypothetical: { type: 'boolean' },
          coherentNarratives: { type: 'array', items: { type: 'string' } },
          lrsEndpoint: { type: 'string' },
          lrsUsername: { type: 'string' },
          lrsPassword: { type: 'string' },
          lrsPreferredVersion: { type: 'string' },
          podUrl: { type: 'string' },
          userDid: { type: 'string' },
        },
        required: ['descriptorIri', 'actor', 'verbId', 'objectId'],
      },
      handler: async (args) => {
        const cfg = lrsConfig(args);
        return await projectDescriptorToLrs(
          { endpoint: cfg.endpoint, auth: { username: cfg.username, password: cfg.password }, preferredVersion: cfg.preferredVersion },
          {
            descriptorIri: String(args['descriptorIri']) as IRI,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            actor: args['actor'] as any,
            verbId: String(args['verbId']),
            objectId: String(args['objectId']),
            verbDisplay: args['verbDisplay'] as string | undefined,
            objectName: args['objectName'] as string | undefined,
            modalStatus: args['modalStatus'] as 'Asserted' | 'Hypothetical' | 'Counterfactual' | undefined,
            allowHypothetical: args['allowHypothetical'] as boolean | undefined,
            coherentNarratives: args['coherentNarratives'] as string[] | undefined,
          },
          { podUrl: cfg.podUrl, userDid: cfg.userDid },
        );
      },
    },

    'lrs.lrs_about': {
      description: 'Probe the LRS\'s /xapi/about endpoint to discover supported xAPI versions. Useful diagnostic for understanding which Statement projection target is appropriate.',
      inputSchema: {
        type: 'object',
        properties: {
          lrsEndpoint: { type: 'string' },
          lrsUsername: { type: 'string' },
          lrsPassword: { type: 'string' },
          lrsPreferredVersion: { type: 'string' },
        },
      },
      handler: async (args) => {
        const cfg = lrsConfig({ ...args, podUrl: 'https://placeholder.example/', userDid: 'did:placeholder' });
        const client = new LrsClient({ endpoint: cfg.endpoint, auth: { username: cfg.username, password: cfg.password }, preferredVersion: cfg.preferredVersion });
        const version = await client.negotiateVersion();
        return { negotiatedVersion: version, endpoint: cfg.endpoint };
      },
    },
  };
}
