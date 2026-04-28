/**
 * Personal-bridge MCP tools for the learner-performer-companion vertical.
 *
 * Exposes production-grade tools that any MCP client (Claude Desktop,
 * Claude Code, Cursor, ChatGPT app) can call to:
 *   - lpc.ingest_training_content — SCORM/cmi5 zip → user's pod
 *   - lpc.import_credential — W3C VC (vc-jwt or DI Proof) → user's pod
 *   - lpc.record_performance_review — manager-attributed review → user's pod
 *   - lpc.record_learning_experience — xAPI Statement → user's pod
 *   - lpc.grounded_answer — natural-language Q against the user's pod;
 *     returns verbatim cited response + audit trail descriptor
 *   - lpc.list_wallet — summary of what's in the user's pod
 *
 * All tools target the pod URL configured via env (LPC_POD_URL) or a
 * per-call override. Operations are real HTTP against a real Solid
 * Community Server (or any LDP-compliant pod). No mocks, no fixtures.
 */

import {
  loadWalletFromPod,
} from '../../applications/learner-performer-companion/src/pod-wallet.js';
import {
  ingestTrainingContent,
  importCredential,
  recordPerformanceReview,
  recordLearningExperience,
  publishCitedResponse,
} from '../../applications/learner-performer-companion/src/pod-publisher.js';
import {
  groundedAnswer,
} from '../../applications/learner-performer-companion/src/grounded-answer.js';
import type { IRI } from '@interego/core';

// ── Config ────────────────────────────────────────────────────────────

interface LpcConfig {
  podUrl: string;
  userDid: IRI;
  assistantDid: IRI;
}

function lpcConfig(args: Record<string, unknown>): LpcConfig {
  const podUrl = (args['podUrl'] as string | undefined)
              ?? process.env['LPC_POD_URL']
              ?? throwMissing('LPC_POD_URL or args.podUrl required');
  const userDid = ((args['userDid'] as string | undefined)
              ?? process.env['LPC_USER_DID']
              ?? throwMissing('LPC_USER_DID or args.userDid required')) as IRI;
  const assistantDid = ((args['assistantDid'] as string | undefined)
              ?? process.env['LPC_ASSISTANT_DID']
              ?? 'did:web:bridge-assistant.local') as IRI;
  return { podUrl, userDid, assistantDid };
}

function throwMissing(msg: string): never { throw new Error(msg); }

// ── Tools ─────────────────────────────────────────────────────────────

interface ToolHandler {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export function lpcTools(): Record<string, ToolHandler> {
  return {
    'lpc.ingest_training_content': {
      description: 'Ingest a SCORM 1.2 / SCORM 2004 / cmi5 zip package into the user\'s pod. Unwraps the manifest, extracts launchable lesson content, mints content-addressed PGSL atoms, and publishes lpc:TrainingContent + lpc:LearningObjective descriptors. Returns IRIs of published descriptors.',
      inputSchema: {
        type: 'object',
        properties: {
          zipBase64: { type: 'string', description: 'SCORM zip package, base64-encoded.' },
          authoritativeSource: { type: 'string', description: 'DID of the training content publisher (e.g., did:web:acme-training.example).' },
          podUrl: { type: 'string', description: 'Optional override for LPC_POD_URL.' },
          userDid: { type: 'string', description: 'Optional override for LPC_USER_DID.' },
        },
        required: ['zipBase64', 'authoritativeSource'],
      },
      handler: async (args) => {
        const cfg = lpcConfig(args);
        const zipB64 = String(args['zipBase64']);
        const authority = String(args['authoritativeSource']) as IRI;
        const zipBuffer = Buffer.from(zipB64, 'base64');
        return await ingestTrainingContent(zipBuffer, authority, cfg);
      },
    },

    'lpc.import_credential': {
      description: 'Verify a W3C Verifiable Credential (vc-jwt string OR DataIntegrityProof JSON-LD object) and publish as lpc:Credential to the user\'s pod. Verification failures throw — failed VCs never land in the pod under credential IRIs.',
      inputSchema: {
        type: 'object',
        properties: {
          vcJwt: { type: 'string', description: 'Compact JWS encoding of a W3C VC.' },
          vcJsonLd: { type: 'object', description: 'JSON-LD VC with embedded DataIntegrityProof.' },
          forContent: { type: 'string', description: 'Optional IRI of the lpc:TrainingContent this credential certifies.' },
          podUrl: { type: 'string' },
          userDid: { type: 'string' },
        },
      },
      handler: async (args) => {
        const cfg = lpcConfig(args);
        const forContent = args['forContent'] as string | undefined;
        if (typeof args['vcJwt'] === 'string') {
          return await importCredential(args['vcJwt'], cfg, forContent as IRI | undefined);
        }
        if (args['vcJsonLd'] && typeof args['vcJsonLd'] === 'object') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return await importCredential(args['vcJsonLd'] as any, cfg, forContent as IRI | undefined);
        }
        throw new Error('Provide either vcJwt (string) or vcJsonLd (object).');
      },
    },

    'lpc.record_performance_review': {
      description: 'Publish a performance review to the user\'s pod. Provenance attributes the record to the manager\'s DID (not the user). The signature is preserved on the descriptor for downstream verification.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Review text.' },
          managerDid: { type: 'string', description: 'DID of the reviewing manager.' },
          signature: { type: 'string', description: 'Manager\'s ECDSA signature over the content (verified upstream).' },
          recordedAt: { type: 'string', description: 'ISO timestamp.' },
          flagsCapability: { type: 'string', description: 'Optional capability IRI flagged by the review.' },
          podUrl: { type: 'string' },
          userDid: { type: 'string' },
        },
        required: ['content', 'managerDid', 'signature', 'recordedAt'],
      },
      handler: async (args) => {
        const cfg = lpcConfig(args);
        return await recordPerformanceReview({
          content: String(args['content']),
          managerDid: String(args['managerDid']) as IRI,
          signature: String(args['signature']),
          recordedAt: String(args['recordedAt']),
          flagsCapability: args['flagsCapability'] as IRI | undefined,
        }, cfg);
      },
    },

    'lpc.record_learning_experience': {
      description: 'Ingest an xAPI Statement (any version 1.0.x or 2.0.x) as an lpc:LearningExperience descriptor in the user\'s pod. Cross-links to training content and (optionally) to the credential earned.',
      inputSchema: {
        type: 'object',
        properties: {
          statement: { type: 'object', description: 'xAPI Statement object.' },
          forContent: { type: 'string', description: 'IRI of the related lpc:TrainingContent.' },
          earnedCredential: { type: 'string', description: 'Optional IRI of the lpc:Credential earned via this experience.' },
          lrsEndpoint: { type: 'string', description: 'Optional source LRS endpoint URL.' },
          podUrl: { type: 'string' },
          userDid: { type: 'string' },
        },
        required: ['statement', 'forContent'],
      },
      handler: async (args) => {
        const cfg = lpcConfig(args);
        return await recordLearningExperience({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          statement: args['statement'] as any,
          forContent: String(args['forContent']) as IRI,
          earnedCredential: args['earnedCredential'] as IRI | undefined,
          lrsEndpoint: args['lrsEndpoint'] as IRI | undefined,
        }, cfg);
      },
    },

    'lpc.grounded_answer': {
      description: 'Answer a natural-language question by retrieving from the user\'s pod with verbatim citation. Loads the wallet from the pod, runs grounded retrieval, and (when persistResponse=true, default) publishes an lpc:CitedResponse audit record back to the pod. Returns null when nothing in the wallet grounds the question — no confabulation.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The user\'s question.' },
          persistResponse: { type: 'boolean', description: 'Whether to persist the response as an lpc:CitedResponse audit record. Default true.' },
          podUrl: { type: 'string' },
          userDid: { type: 'string' },
          assistantDid: { type: 'string' },
        },
        required: ['question'],
      },
      handler: async (args) => {
        const cfg = lpcConfig(args);
        const question = String(args['question']);
        const persistResponse = args['persistResponse'] !== false;

        const wallet = await loadWalletFromPod({
          podUrl: cfg.podUrl,
          userDid: cfg.userDid,
        });

        const answer = groundedAnswer(question, wallet);
        if (answer === null) {
          return {
            ok: true,
            answer: null,
            reason: 'no-data',
            walletSummary: {
              trainingContent: wallet.trainingContent.length,
              credentials: wallet.credentials.length,
              performanceRecords: wallet.performanceRecords.length,
              learningExperiences: wallet.learningExperiences.length,
            },
          };
        }

        let auditRecord: { responseIri: IRI; descriptorUrl: string; graphUrl: string } | undefined;
        if (persistResponse) {
          auditRecord = await publishCitedResponse({
            answer,
            assistantDid: cfg.assistantDid,
          }, cfg);
        }

        return {
          ok: true,
          answer,
          auditRecord,
        };
      },
    },

    'lpc.list_wallet': {
      description: 'Summarize what\'s currently in the user\'s pod-backed wallet: training content, credentials, performance records, learning experiences. Useful for confirming ingest succeeded.',
      inputSchema: {
        type: 'object',
        properties: {
          podUrl: { type: 'string' },
          userDid: { type: 'string' },
        },
      },
      handler: async (args) => {
        const cfg = lpcConfig(args);
        const wallet = await loadWalletFromPod({
          podUrl: cfg.podUrl,
          userDid: cfg.userDid,
        });
        return {
          userDid: wallet.userDid,
          trainingContent: wallet.trainingContent.map(tc => ({
            iri: tc.iri,
            name: tc.name,
            atomCount: tc.atoms.length,
          })),
          credentials: wallet.credentials.map(c => ({
            iri: c.iri,
            achievementName: c.achievementName,
            issuer: c.issuer,
            issuedAt: c.issuedAt,
          })),
          performanceRecords: wallet.performanceRecords.map(r => ({
            iri: r.iri,
            attributedTo: r.attributedTo,
            recordedAt: r.recordedAt,
          })),
          learningExperiences: wallet.learningExperiences.map(le => ({
            iri: le.iri,
            forContent: le.forContent,
            earnedCredential: le.earnedCredential,
            completedAt: le.completedAt,
          })),
        };
      },
    },
  };
}
