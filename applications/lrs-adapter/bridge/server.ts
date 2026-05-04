/**
 * lrs-adapter bridge — opinionated MCP-named-tool surface over the
 * LRS adapter vertical.
 *
 * Generic agents discover via cg:Affordance manifest at /affordances;
 * this bridge is just the named-MCP-tool ergonomic.
 *
 * Run:
 *   PORT=6030 BRIDGE_DEPLOYMENT_URL=https://lrs.example/ \
 *     LRS_DEFAULT_POD_URL=https://your-pod.example/me/ \
 *     LRS_DEFAULT_USER_DID=did:web:you.example \
 *     node dist/server.js
 */

import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { lrsAffordances } from '../affordances.js';
import {
  ingestStatementFromLrs,
  ingestStatementBatchFromLrs,
  projectDescriptorToLrs,
} from '../src/pod-publisher.js';
import { LrsClient } from '../src/lrs-client.js';
import type { IRI } from '../../../src/index.js';

interface PodCtx { podUrl: string; userDid: IRI }
function podCtx(args: Record<string, unknown>): PodCtx {
  const podUrl = (args.pod_url as string | undefined) ?? process.env.LRS_DEFAULT_POD_URL;
  const userDid = ((args.user_did as string | undefined) ?? process.env.LRS_DEFAULT_USER_DID) as IRI | undefined;
  if (!podUrl) throw new Error('pod_url is required (or set LRS_DEFAULT_POD_URL)');
  if (!userDid) throw new Error('user_did is required (or set LRS_DEFAULT_USER_DID)');
  return { podUrl, userDid };
}
function lrsCfg(args: Record<string, unknown>) {
  return {
    endpoint: String(args.lrs_endpoint),
    auth: { username: String(args.lrs_username), password: String(args.lrs_password) },
    preferredVersion: (args.lrs_preferred_version as '2.0.0' | '1.0.3' | undefined) ?? '2.0.0',
  };
}

const handlers = {
  'lrs.ingest_statement': async (args: Record<string, unknown>) =>
    ingestStatementFromLrs(lrsCfg(args), String(args.statement_id), podCtx(args)),

  'lrs.ingest_statement_batch': async (args: Record<string, unknown>) =>
    ingestStatementBatchFromLrs(lrsCfg(args), {
      verb: args.verb as string | undefined,
      activity: args.activity as string | undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: args.agent as any,
      since: args.since as string | undefined,
      until: args.until as string | undefined,
      limit: args.limit as number | undefined,
    }, podCtx(args)),

  'lrs.project_descriptor': async (args: Record<string, unknown>) =>
    projectDescriptorToLrs(lrsCfg(args), {
      descriptorIri: String(args.descriptor_iri) as IRI,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actor: args.actor as any,
      verbId: String(args.verb_id),
      objectId: String(args.object_id),
      verbDisplay: args.verb_display as string | undefined,
      objectName: args.object_name as string | undefined,
      modalStatus: args.modal_status as 'Asserted' | 'Hypothetical' | 'Counterfactual' | undefined,
      allowHypothetical: args.allow_hypothetical as boolean | undefined,
      coherentNarratives: args.coherent_narratives as string[] | undefined,
    }, podCtx(args)),

  'lrs.lrs_about': async (args: Record<string, unknown>) => {
    const client = new LrsClient(lrsCfg(args));
    const v = await client.negotiateVersion();
    return { negotiatedVersion: v, endpoint: String(args.lrs_endpoint) };
  },
};

const PORT = parseInt(process.env.PORT ?? '6030', 10);
const app = createVerticalBridge({ verticalName: 'lrs-adapter', affordances: lrsAffordances, handlers, defaultPodUrl: process.env.LRS_DEFAULT_POD_URL });
app.listen(PORT, () => {
  console.log(`lrs-adapter bridge on http://localhost:${PORT}`);
  console.log(`  MCP: http://localhost:${PORT}/mcp  |  Manifest: http://localhost:${PORT}/affordances`);
});
