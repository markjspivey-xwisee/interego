/**
 * learner-performer-companion bridge — opinionated MCP-named-tool
 * surface over the LPC vertical.
 *
 * Generic agents don't need this — they can discover + invoke this
 * vertical's affordances via the protocol's cg:Affordance manifest at
 * GET /affordances. The bridge is just an ergonomic accelerant for
 * clients that prefer named MCP tools.
 *
 * Run:
 *   PORT=6010 BRIDGE_DEPLOYMENT_URL=https://lpc.example/ \
 *     LPC_DEFAULT_POD_URL=https://your-pod.example/me/ \
 *     LPC_DEFAULT_USER_DID=did:web:you.example \
 *     node dist/server.js
 *
 * Connect from any MCP client at: ${BRIDGE_DEPLOYMENT_URL}/mcp
 */

import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { lpcAffordances } from '../affordances.js';
import {
  ingestTrainingContent,
  importCredential,
  recordPerformanceReview,
  recordLearningExperience,
  publishCitedResponse,
} from '../src/pod-publisher.js';
import { loadWalletFromPod } from '../src/pod-wallet.js';
import { groundedAnswer } from '../src/grounded-answer.js';
import type { IRI } from '../../../src/index.js';

interface PodCtx { podUrl: string; userDid: IRI }

function ctx(args: Record<string, unknown>): PodCtx {
  const podUrl = (args.pod_url as string | undefined) ?? process.env.LPC_DEFAULT_POD_URL;
  const userDid = ((args.user_did as string | undefined) ?? process.env.LPC_DEFAULT_USER_DID) as IRI | undefined;
  if (!podUrl) throw new Error('pod_url is required (or set LPC_DEFAULT_POD_URL)');
  if (!userDid) throw new Error('user_did is required (or set LPC_DEFAULT_USER_DID)');
  return { podUrl, userDid };
}

const handlers = {
  'lpc.ingest_training_content': async (args: Record<string, unknown>) => {
    const { podUrl, userDid } = ctx(args);
    return await ingestTrainingContent(
      Buffer.from(String(args.zip_base64), 'base64'),
      String(args.authoritative_source) as IRI,
      { podUrl, userDid },
    );
  },
  'lpc.import_credential': async (args: Record<string, unknown>) => {
    const { podUrl, userDid } = ctx(args);
    const forContent = args.for_content as IRI | undefined;
    if (typeof args.vc_jwt === 'string') {
      return await importCredential(args.vc_jwt, { podUrl, userDid }, forContent);
    }
    if (args.vc_jsonld && typeof args.vc_jsonld === 'object') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await importCredential(args.vc_jsonld as any, { podUrl, userDid }, forContent);
    }
    throw new Error('Provide either vc_jwt (string) or vc_jsonld (object)');
  },
  'lpc.record_performance_review': async (args: Record<string, unknown>) => {
    const { podUrl, userDid } = ctx(args);
    return await recordPerformanceReview({
      content: String(args.content),
      managerDid: String(args.manager_did) as IRI,
      signature: String(args.signature),
      recordedAt: String(args.recorded_at),
      flagsCapability: args.flags_capability as IRI | undefined,
    }, { podUrl, userDid });
  },
  'lpc.record_learning_experience': async (args: Record<string, unknown>) => {
    const { podUrl, userDid } = ctx(args);
    return await recordLearningExperience({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      statement: args.statement as any,
      forContent: String(args.for_content) as IRI,
      earnedCredential: args.earned_credential as IRI | undefined,
      lrsEndpoint: args.lrs_endpoint as IRI | undefined,
    }, { podUrl, userDid });
  },
  'lpc.grounded_answer': async (args: Record<string, unknown>) => {
    const { podUrl, userDid } = ctx(args);
    const question = String(args.question);
    const persistResponse = args.persist_response !== false;
    const assistantDid = ((args.assistant_did as string | undefined) ?? 'did:web:lpc-bridge.local') as IRI;

    const wallet = await loadWalletFromPod({ podUrl, userDid });
    const answer = groundedAnswer(question, wallet);
    if (!answer) {
      return {
        ok: true, answer: null, reason: 'no-data',
        walletSummary: {
          trainingContent: wallet.trainingContent.length,
          credentials: wallet.credentials.length,
          performanceRecords: wallet.performanceRecords.length,
          learningExperiences: wallet.learningExperiences.length,
        },
      };
    }
    let auditRecord;
    if (persistResponse) {
      auditRecord = await publishCitedResponse({ answer, assistantDid }, { podUrl, userDid });
    }
    return { ok: true, answer, auditRecord };
  },
  'lpc.list_wallet': async (args: Record<string, unknown>) => {
    const { podUrl, userDid } = ctx(args);
    const wallet = await loadWalletFromPod({ podUrl, userDid });
    return {
      userDid: wallet.userDid,
      trainingContent: wallet.trainingContent.map(tc => ({ iri: tc.iri, name: tc.name, atomCount: tc.atoms.length })),
      credentials: wallet.credentials.map(c => ({ iri: c.iri, achievementName: c.achievementName, issuer: c.issuer, issuedAt: c.issuedAt })),
      performanceRecords: wallet.performanceRecords.map(r => ({ iri: r.iri, attributedTo: r.attributedTo, recordedAt: r.recordedAt })),
      learningExperiences: wallet.learningExperiences.map(le => ({ iri: le.iri, forContent: le.forContent, earnedCredential: le.earnedCredential, completedAt: le.completedAt })),
    };
  },
};

const PORT = parseInt(process.env.PORT ?? '6010', 10);
const app = createVerticalBridge({
  verticalName: 'learner-performer-companion',
  affordances: lpcAffordances,
  handlers,
  defaultPodUrl: process.env.LPC_DEFAULT_POD_URL,
});

app.listen(PORT, () => {
  console.log(`learner-performer-companion bridge on http://localhost:${PORT}`);
  console.log(`  MCP endpoint:        http://localhost:${PORT}/mcp`);
  console.log(`  Affordance manifest: http://localhost:${PORT}/affordances`);
  console.log(`  ${lpcAffordances.length} affordances available; tools/list mirrors them`);
});
